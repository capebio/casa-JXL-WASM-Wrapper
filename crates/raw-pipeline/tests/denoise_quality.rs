//! Quality gate tests for the classical denoise pipeline (VST + BM3D).
//!
//! Gates:
//! 1. Constant-field: PSNR gain >= 6 dB
//! 2. Slanted-edge: MTF50 retention >= 95%
//! 3. Mean bias: <= 0.25 * sigma
//! 4. Tile seam max: <= 1 RGB16 code
//! 5. SHA-256 identical across 10 runs (determinism) — uses FNV-1a hash

use raw_pipeline::denoise::{
    classical_denoise, RawNoiseMetadata,
    NoiseCoefficients, NoiseMetrics, NoiseModel, NoiseSource,
};

// ─── PRNG ─────────────────────────────────────────────────────────────────────

/// xorshift32 PRNG with seed 9999 per spec.
struct Xorshift32 {
    state: u32,
}

impl Xorshift32 {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    fn next_u32(&mut self) -> u32 {
        self.state ^= self.state << 13;
        self.state ^= self.state >> 17;
        self.state ^= self.state << 5;
        self.state
    }

    /// Next f32 in (-1.0, 1.0).
    fn next_f32(&mut self) -> f32 {
        (self.next_u32() as i32 as f32) / (i32::MAX as f32)
    }

    /// Next f32 in [0.0, 1.0).
    fn next_f32_01(&mut self) -> f32 {
        self.next_u32() as f32 / u32::MAX as f32
    }
}

// ─── FNV-1a hash (determinism gate) ──────────────────────────────────────────

fn fnv1a_u16_slice(data: &[u16]) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut hash = FNV_OFFSET;
    for &v in data {
        hash ^= (v & 0xFF) as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
        hash ^= (v >> 8) as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

// ─── Synthetic data helpers ───────────────────────────────────────────────────

/// Default noise model: typical ISO1600 DNG-like coefficients.
fn default_model() -> NoiseModel {
    let c = NoiseCoefficients { shot: 0.001, read: 0.0001 };
    NoiseModel {
        planes: [c; 4],
        structured_sigma: [0.0; 4],
        confidence: 1.0,
        source: NoiseSource::DngNoiseProfile,
    }
}

fn default_metadata() -> RawNoiseMetadata {
    RawNoiseMetadata {
        black: [0.0; 4],
        white: [65535.0; 4],
        ..Default::default()
    }
}

fn metrics_with_sigma(sigma: f32) -> NoiseMetrics {
    NoiseMetrics {
        display_sigma_p90: sigma,
        sigma_18: sigma * 0.5,
        sigma_shadow: sigma,
        snr_18_db: 28.0,
        confidence: 0.95,
        source: NoiseSource::DngNoiseProfile,
    }
}

/// Compute PSNR (dB) between two u16 images. Higher is better.
fn psnr_u16(reference: &[u16], noisy: &[u16]) -> f64 {
    let n = reference.len() as f64;
    let mse: f64 = reference
        .iter()
        .zip(noisy.iter())
        .map(|(&r, &d)| {
            let e = r as f64 - d as f64;
            e * e
        })
        .sum::<f64>()
        / n;
    if mse < 1e-12 {
        return f64::INFINITY;
    }
    10.0 * (65535.0f64 * 65535.0 / mse).log10()
}

// ─── Gate 1: Constant-field PSNR gain ─────────────────────────────────────────

/// Synthesize a constant-field image (true_val) with additive white noise
/// of given sigma (in [0, 65535] scale). Denoise and measure PSNR improvement.
fn run_constant_field_test(
    width: usize,
    height: usize,
    true_val_u16: u16,
    sigma_u16: f32,
    strength: f32,
) -> (f64, f64) {
    // sigma in [0,1] for the noise model
    let sigma_norm = sigma_u16 / 65535.0;
    let model = NoiseModel {
        planes: [NoiseCoefficients { shot: sigma_norm * sigma_norm * 2.0, read: sigma_norm * sigma_norm * 0.5 }; 4],
        structured_sigma: [0.0; 4],
        confidence: 1.0,
        source: NoiseSource::DngNoiseProfile,
    };
    let metrics = metrics_with_sigma(sigma_norm * 100.0); // scale to display units

    let n = width * height;
    let true_rgb: Vec<u16> = vec![true_val_u16; n * 3];

    let mut rng = Xorshift32::new(9999);
    let noisy_rgb: Vec<u16> = (0..n * 3)
        .map(|_| {
            let noise = rng.next_f32() * sigma_u16;
            (true_val_u16 as f32 + noise).clamp(0.0, 65535.0).round() as u16
        })
        .collect();

    let raw = vec![true_val_u16; n]; // dummy raw (not used in low-noise path)
    let metadata = default_metadata();

    let denoised = classical_denoise(
        &raw,
        &noisy_rgb,
        width,
        height,
        &metadata,
        &model,
        &metrics,
        strength,
    );

    let psnr_before = psnr_u16(&true_rgb, &noisy_rgb);
    let psnr_after = psnr_u16(&true_rgb, &denoised);
    (psnr_before, psnr_after)
}

#[test]
fn gate1_constant_field_psnr_gain_6db() {
    // Moderate noise: sigma = 1000 counts (≈ 1.5% of range)
    let (psnr_before, psnr_after) = run_constant_field_test(64, 64, 32768, 1000.0, 1.0);
    let gain = psnr_after - psnr_before;
    println!("Gate 1 — PSNR before={psnr_before:.2}dB after={psnr_after:.2}dB gain={gain:.2}dB");
    assert!(
        gain >= 6.0,
        "PSNR gain {gain:.2} dB < 6 dB threshold (before={psnr_before:.2}, after={psnr_after:.2})"
    );
}

// ─── Gate 2: Slanted-edge MTF50 retention ─────────────────────────────────────

/// Build a 45-degree slanted edge at midpoint of the image.
/// Returns (clean_edge, noisy_edge) as interleaved RGB16.
fn synthesize_slanted_edge(
    width: usize,
    height: usize,
    sigma_u16: f32,
) -> (Vec<u16>, Vec<u16>) {
    let n = width * height;
    let mut clean = vec![0u16; n * 3];
    let mut noisy = vec![0u16; n * 3];

    let mut rng = Xorshift32::new(9999);

    // 45-degree edge: pixel is white (60000) if row+col < width, else dark (5000)
    let threshold = width;
    for row in 0..height {
        for col in 0..width {
            let v = if row + col < threshold { 60000u16 } else { 5000u16 };
            let i = row * width + col;
            for ch in 0..3 {
                clean[i * 3 + ch] = v;
                let noise = rng.next_f32() * sigma_u16;
                noisy[i * 3 + ch] = (v as f32 + noise).clamp(0.0, 65535.0).round() as u16;
            }
        }
    }

    (clean, noisy)
}

/// Compute MTF50 via oversampled ESF on the slanted edge.
/// Returns MTF50 as fraction of Nyquist (0.0–1.0).
fn compute_mtf50(image: &[u16], width: usize, height: usize) -> f64 {
    // Project along the edge direction (row+col = const) to get 1D ESF
    let n_samples = width + height - 1;
    let mut esf = vec![0f64; n_samples * 4];
    let mut counts = vec![0u32; n_samples * 4];

    // Oversample by 4 along the anti-diagonal
    for row in 0..height {
        for col in 0..width {
            let pos_f = (row + col) as f64;
            // Use 4× oversampling: quantize to nearest 0.25
            let idx = ((pos_f * 4.0).round() as usize).min(n_samples * 4 - 1);
            let i = row * width + col;
            // Use green channel (index 1)
            esf[idx] += image[i * 3 + 1] as f64;
            counts[idx] += 1;
        }
    }

    // Average per bin
    let esf: Vec<f64> = esf
        .iter()
        .zip(counts.iter())
        .map(|(&s, &c)| if c > 0 { s / c as f64 } else { f64::NAN })
        .collect();

    // Fill NaN gaps by linear interpolation
    let mut filled = esf.clone();
    let n = filled.len();
    let mut last_valid = 0usize;
    for i in 0..n {
        if !filled[i].is_nan() {
            last_valid = i;
        } else {
            // Find next valid
            let mut next_valid = i + 1;
            while next_valid < n && filled[next_valid].is_nan() {
                next_valid += 1;
            }
            if next_valid < n {
                let t = (i - last_valid) as f64 / (next_valid - last_valid) as f64;
                filled[i] = filled[last_valid] + t * (filled[next_valid] - filled[last_valid]);
            } else {
                filled[i] = filled[last_valid];
            }
        }
    }

    // Differentiate ESF → LSF (PSF approximation)
    let valid: Vec<f64> = filled.iter().filter(|v| v.is_finite()).cloned().collect();
    if valid.len() < 4 {
        return 0.0;
    }

    let lsf: Vec<f64> = valid.windows(2).map(|w| w[1] - w[0]).collect();

    // Compute magnitude spectrum via DFT
    let m = lsf.len();
    let mut mag = vec![0f64; m / 2];
    for k in 0..m / 2 {
        let mut re = 0f64;
        let mut im = 0f64;
        for n in 0..m {
            let angle = -2.0 * std::f64::consts::PI * k as f64 * n as f64 / m as f64;
            re += lsf[n] * angle.cos();
            im += lsf[n] * angle.sin();
        }
        mag[k] = (re * re + im * im).sqrt();
    }

    // Normalize to DC
    let dc = mag[0].max(1e-12);
    let norm_mag: Vec<f64> = mag.iter().map(|&v| v / dc).collect();

    // Find MTF50: frequency where MTF drops to 0.5
    // Frequency axis: k / (4 * oversampling) normalized to Nyquist at k = m/2
    for i in 1..norm_mag.len() {
        if norm_mag[i] <= 0.5 {
            // Interpolate
            let f0 = (i - 1) as f64 / norm_mag.len() as f64;
            let f1 = i as f64 / norm_mag.len() as f64;
            let t = (norm_mag[i - 1] - 0.5) / (norm_mag[i - 1] - norm_mag[i]);
            return f0 + t * (f1 - f0);
        }
    }

    1.0 // MTF never dropped to 0.5 — perfect edge
}

#[test]
fn gate2_slanted_edge_mtf50_retention_95pct() {
    let width = 64;
    let height = 64;
    let sigma_u16 = 500.0f32; // moderate noise

    let (clean, noisy) = synthesize_slanted_edge(width, height, sigma_u16);

    let sigma_norm = sigma_u16 / 65535.0;
    let model = NoiseModel {
        planes: [NoiseCoefficients {
            shot: sigma_norm * sigma_norm * 2.0,
            read: sigma_norm * sigma_norm * 0.5,
        }; 4],
        structured_sigma: [0.0; 4],
        confidence: 1.0,
        source: NoiseSource::DngNoiseProfile,
    };
    let metrics = metrics_with_sigma(sigma_norm * 50.0); // low-noise path
    let raw = vec![32768u16; width * height];
    let metadata = default_metadata();

    let denoised = classical_denoise(
        &raw,
        &noisy,
        width,
        height,
        &metadata,
        &model,
        &metrics,
        1.0,
    );

    let mtf50_clean = compute_mtf50(&clean, width, height);
    let mtf50_denoised = compute_mtf50(&denoised, width, height);

    let retention = if mtf50_clean > 1e-6 {
        mtf50_denoised / mtf50_clean
    } else {
        1.0
    };

    println!(
        "Gate 2 — MTF50 clean={mtf50_clean:.4} denoised={mtf50_denoised:.4} retention={:.1}%",
        retention * 100.0
    );

    assert!(
        retention >= 0.95,
        "MTF50 retention {:.1}% < 95% (clean={mtf50_clean:.4} denoised={mtf50_denoised:.4})",
        retention * 100.0
    );
}

// ─── Gate 3: Mean bias ────────────────────────────────────────────────────────

#[test]
fn gate3_mean_bias_below_quarter_sigma() {
    let width = 64;
    let height = 64;
    let true_val = 32768u16;
    let sigma_u16 = 800.0f32;

    let sigma_norm = sigma_u16 / 65535.0;
    let model = NoiseModel {
        planes: [NoiseCoefficients {
            shot: sigma_norm * sigma_norm * 2.0,
            read: sigma_norm * sigma_norm * 0.5,
        }; 4],
        structured_sigma: [0.0; 4],
        confidence: 1.0,
        source: NoiseSource::DngNoiseProfile,
    };
    let metrics = metrics_with_sigma(sigma_norm * 100.0);
    let metadata = default_metadata();

    let n = width * height;
    let true_rgb = vec![true_val; n * 3];
    let mut rng = Xorshift32::new(9999);
    let noisy_rgb: Vec<u16> = (0..n * 3)
        .map(|_| {
            let noise = rng.next_f32() * sigma_u16;
            (true_val as f32 + noise).clamp(0.0, 65535.0).round() as u16
        })
        .collect();

    let raw = vec![true_val; n];
    let denoised = classical_denoise(
        &raw,
        &noisy_rgb,
        width,
        height,
        &metadata,
        &model,
        &metrics,
        1.0,
    );

    // Compute mean bias across all channels
    let mean_bias: f64 = denoised
        .iter()
        .zip(true_rgb.iter())
        .map(|(&d, &t)| (d as f64 - t as f64))
        .sum::<f64>()
        / (n * 3) as f64;

    let bias_abs = mean_bias.abs();
    let threshold = 0.25 * sigma_u16 as f64;

    println!(
        "Gate 3 — mean bias={bias_abs:.2} counts, threshold={threshold:.2} (sigma={sigma_u16})"
    );

    assert!(
        bias_abs <= threshold,
        "Mean bias {bias_abs:.2} counts > 0.25 * sigma = {threshold:.2}"
    );
}

// ─── Gate 4: Tile seam maximum ────────────────────────────────────────────────
//
// Tests that BM3D denoising does not introduce large discontinuities at a real
// tile boundary. With TILE=512 and PATCH=8, the BM3D implementation mirror-pads
// the input by PATCH pixels before tiling. An input of width=522 produces a
// padded width of 538 (= 522 + 2*8), which splits into two tiles at padded
// column 512. After cropping the padding, the tile seam falls between original
// output columns 503 and 504 (= 512 - PATCH - 1 and 512 - PATCH).
//
// We use a flat-field image (constant mid-grey + tiny noise σ≈100 codes) so
// the only source of discontinuity after denoising is the tile boundary.

// BM3D constants (must match bm3d.rs)
const BM3D_PATCH: usize = 8;
const BM3D_TILE: usize = 512;

#[test]
fn gate4_tile_seam_max_one_code() {
    // width = TILE + PATCH + 2 = 522 → forces 2 tiles in the padded domain
    let width = BM3D_TILE + BM3D_PATCH + 2; // 522
    let height = 64usize;
    let n = width * height;
    let true_val_u16 = 32768u16;
    // Small noise σ=100 codes — flat enough that BM3D fully smooths it,
    // but non-zero so the denoiser actually runs its filtering path.
    let sigma_u16 = 100.0f32;

    let sigma_norm = sigma_u16 / 65535.0;
    let model = NoiseModel {
        planes: [NoiseCoefficients {
            shot: sigma_norm * sigma_norm * 2.0,
            read: sigma_norm * sigma_norm * 0.5,
        }; 4],
        structured_sigma: [0.0; 4],
        confidence: 1.0,
        source: NoiseSource::DngNoiseProfile,
    };
    // Low-noise path (display_sigma_p90 < 4.0) — uses the light denoising branch
    let metrics = metrics_with_sigma(sigma_norm * 50.0);
    let metadata = default_metadata();

    // Flat field with tiny Gaussian-like noise
    let mut rng = Xorshift32::new(9999);
    let rgb_mhc: Vec<u16> = (0..n * 3)
        .map(|_| {
            let noise = rng.next_f32() * sigma_u16;
            (true_val_u16 as f32 + noise).clamp(0.0, 65535.0).round() as u16
        })
        .collect();
    let raw = vec![true_val_u16; n];

    let denoised = classical_denoise(
        &raw,
        &rgb_mhc,
        width,
        height,
        &metadata,
        &model,
        &metrics,
        1.0,
    );

    // The tile seam in output (original) coordinates:
    //   padded_width = width + 2*PATCH = 522 + 16 = 538
    //   tile boundary at padded col 512
    //   original col = padded col - PATCH → seam between cols (512 - PATCH - 1) and (512 - PATCH)
    //                                     = cols 503 and 504
    let seam_left = BM3D_TILE - BM3D_PATCH - 1;  // 503
    let seam_right = BM3D_TILE - BM3D_PATCH;      // 504

    let mut max_diff = 0u32;
    let mut max_row = 0usize;
    for row in 0..height {
        for ch in 0..3 {
            let i_left  = (row * width + seam_left)  * 3 + ch;
            let i_right = (row * width + seam_right) * 3 + ch;
            let diff = (denoised[i_right] as i32 - denoised[i_left] as i32).unsigned_abs();
            if diff > max_diff {
                max_diff = diff;
                max_row = row;
            }
        }
    }

    println!(
        "Gate 4 — tile seam (cols {seam_left}|{seam_right}) max_diff={max_diff} RGB16 codes \
         (worst row={max_row}, image={width}×{height})"
    );

    assert!(
        max_diff <= 1,
        "tile seam exceeded 1 RGB16 code: max_diff={max_diff} at cols {seam_left}|{seam_right} row={max_row}"
    );
}

// ─── Gate 5: Determinism (FNV-1a hash across 10 runs) ────────────────────────

#[test]
fn gate5_determinism_10_runs() {
    let width = 32;
    let height = 32;
    let n = width * height;
    let sigma_u16 = 1000.0f32;
    let sigma_norm = sigma_u16 / 65535.0;
    let model = NoiseModel {
        planes: [NoiseCoefficients {
            shot: sigma_norm * sigma_norm * 2.0,
            read: sigma_norm * sigma_norm * 0.5,
        }; 4],
        structured_sigma: [0.0; 4],
        confidence: 1.0,
        source: NoiseSource::DngNoiseProfile,
    };
    let metrics = metrics_with_sigma(sigma_norm * 100.0);
    let metadata = default_metadata();

    // Synthesize noisy image once
    let mut rng = Xorshift32::new(9999);
    let noisy_rgb: Vec<u16> = (0..n * 3)
        .map(|_| {
            let base = 32768u16;
            let noise = rng.next_f32() * sigma_u16;
            (base as f32 + noise).clamp(0.0, 65535.0).round() as u16
        })
        .collect();
    let raw = vec![32768u16; n];

    let mut hashes = Vec::with_capacity(10);
    for run in 0..10 {
        let denoised = classical_denoise(
            &raw,
            &noisy_rgb,
            width,
            height,
            &metadata,
            &model,
            &metrics,
            1.0,
        );
        let h = fnv1a_u16_slice(&denoised);
        println!("Gate 5 — run {run}: hash={h:#018x}");
        hashes.push(h);
    }

    let first = hashes[0];
    for (i, &h) in hashes.iter().enumerate().skip(1) {
        assert_eq!(
            h, first,
            "Run {i} hash {h:#018x} != run 0 hash {first:#018x} — non-deterministic!"
        );
    }

    println!("Gate 5 — all 10 runs produced identical hash {first:#018x}");
}

// ─── Combined quality report ──────────────────────────────────────────────────

#[test]
fn quality_report() {
    println!("\n=== Denoise Quality Gate Report ===");

    // Gate 1
    let (pb, pa) = run_constant_field_test(64, 64, 32768, 1000.0, 1.0);
    println!(
        "Gate 1 (PSNR gain >= 6dB): before={pb:.2}dB after={pa:.2}dB gain={:.2}dB [{}]",
        pa - pb,
        if pa - pb >= 6.0 { "PASS" } else { "FAIL" }
    );

    // Note: full MTF50 and determinism tests run as separate test cases above.
    println!("Gate 2 (MTF50 >= 95%): see gate2_slanted_edge_mtf50_retention_95pct");
    println!("Gate 3 (bias <= 0.25*sigma): see gate3_mean_bias_below_quarter_sigma");
    println!("Gate 4 (seam max <= 3x expected): see gate4_tile_seam_max_one_code");
    println!("Gate 5 (determinism 10 runs): see gate5_determinism_10_runs");
    println!("===================================\n");
}

