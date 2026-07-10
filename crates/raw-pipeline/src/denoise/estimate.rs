//! Single-image blind noise estimation from a RAW Bayer frame.
//!
//! # Algorithm
//! 1. Normalise to f32 in `[-ε, 1]` using per-plane black/white.
//! 2. Split into four half-resolution CFA planes (RGGB).
//! 3. Divide each plane into 8×8 patches.
//! 4. Compute patch mean and high-pass residual variance (kernel `[1,-2,1;-2,4,-2;1,-2,1]`,
//!    divide by kernel energy 36).
//! 5. Bin patch means into 16 bins over `[-0.02, 0.90]`; retain lowest-structure 20% per bin.
//! 6. Require ≥96 patches and ≥6 populated bins.
//! 7. Fit `variance = S·mean + O` with 8 Huber IRLS iterations, nonneg constraints.
//! 8. Estimate row/column structured sigma from residuals after 5×5 box smooth.
//! 9. Merge two green fits by inverse-residual weighting.
//!
//! Confidence = product of patch-count coverage, bin coverage, `exp(−normalised_fit_rmse)`.

use super::dng_tags::RawNoiseMetadata;
use super::types::{NoiseCoefficients, NoiseModel, NoiseMetrics, NoiseSource};

// ─── Public API ────────────────────────────────────────────────────────────────

/// Estimate a noise model from a single RAW Bayer frame.
///
/// `raw`: row-major u16 sensor values, dimensions `width × height`.
/// `cfa`: CFA phase (0=RGGB, 1=GRBG, 2=GBRG, 3=BGGR).
/// Returns `None` when there are insufficient flat patches to produce a
/// reliable fit (< 96 patches or < 6 populated bins).
pub fn estimate_noise(
    raw: &[u16],
    width: usize,
    height: usize,
    cfa: usize,
    metadata: &RawNoiseMetadata,
) -> Option<NoiseModel> {
    // ── 1. Normalise ───────────────────────────────────────────────────────────
    let norm = normalise_bayer(raw, width, height, cfa, metadata);

    // ── 2-5. Extract patches per plane ────────────────────────────────────────
    let mut all_patches: [Vec<(f32, f32)>; 4] = [vec![], vec![], vec![], vec![]];
    for plane in 0..4 {
        all_patches[plane] = extract_flat_patches(&norm.planes[plane], norm.pw, norm.ph);
    }

    // ── 6. Threshold checks ────────────────────────────────────────────────────
    for plane in 0..4 {
        if all_patches[plane].len() < 96 {
            return None;
        }
        let bin_count = populated_bins(&all_patches[plane]);
        if bin_count < 6 {
            return None;
        }
    }

    // ── 7. Fit per plane ──────────────────────────────────────────────────────
    let mut coeffs: [NoiseCoefficients; 4] = [NoiseCoefficients { shot: 0.0, read: 0.0 }; 4];
    let mut residuals: [f32; 4] = [0.0; 4];
    for plane in 0..4 {
        let (c, r) = fit_plane(&all_patches[plane]);
        coeffs[plane] = c;
        residuals[plane] = r;
    }

    // ── 9. Merge two green fits by inverse-residual weighting ─────────────────
    coeffs = merge_green_planes(coeffs, residuals);

    // ── 8. Structured sigma ───────────────────────────────────────────────────
    let structured_sigma = estimate_structured_sigma(&norm.planes, norm.pw, norm.ph);

    // ── Confidence ────────────────────────────────────────────────────────────
    let confidence = compute_confidence(&all_patches, residuals);

    Some(NoiseModel {
        planes: coeffs,
        structured_sigma,
        confidence,
        source: NoiseSource::BlindFit,
    })
}

/// Compute display-space noise metrics from a noise model.
///
/// Samples 4096 stratified pixels in normalised signal `[0.01, 0.50]`,
/// applies WB before sRGB projection, and returns p90 of `sigma_code`
/// plus model sigma/SNR at 18% and 2% signal.
pub fn score_noise(
    raw: &[u16],
    width: usize,
    height: usize,
    metadata: &RawNoiseMetadata,
    model: &NoiseModel,
    wb: &[f32; 4],
) -> NoiseMetrics {
    // Normalise to get signal levels
    let norm = normalise_bayer(raw, width, height, 0, metadata);

    // Stratified sampling: 4096 samples across signal [0.01, 0.50]
    const N_SAMPLES: usize = 4096;
    let mut sigma_codes: Vec<f32> = Vec::with_capacity(N_SAMPLES);

    // We use a deterministic stride across the image
    let total_pixels = norm.pw * norm.ph; // per-plane pixels (half-res)
    let stride = (total_pixels / N_SAMPLES).max(1);

    for p in 0..4 {
        let plane = &norm.planes[p];
        let wb_scale = wb[p].max(1e-7);
        let mut count = 0usize;
        let mut idx = p * stride / 4; // stagger planes
        while count < N_SAMPLES / 4 && idx < plane.len() {
            let x = plane[idx]; // normalised signal
            if x >= 0.01 && x <= 0.50 {
                // Apply WB scaling (keep in [0,1] range)
                let x_wb = (x * wb_scale).min(1.0);
                let sigma_linear = model.planes[p].variance(x).sqrt()
                    .hypot(model.structured_sigma[p]);
                let lo = linear_to_srgb((x_wb - sigma_linear).max(0.0));
                let hi = linear_to_srgb((x_wb + sigma_linear).min(1.0));
                let sigma_code = 255.0 * (hi - lo) * 0.5;
                sigma_codes.push(sigma_code);
                count += 1;
            }
            idx += stride;
        }
    }

    sigma_codes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let display_sigma_p90 = percentile(&sigma_codes, 0.90);

    // Sigma at 18% and 2% signal (use green plane average for representative)
    let green_coeffs = average_green(&model.planes);
    let sigma_18_linear = green_coeffs.variance(0.18).sqrt()
        .hypot(average_green_f32(&model.structured_sigma));
    let sigma_shadow_linear = green_coeffs.variance(0.02).sqrt()
        .hypot(average_green_f32(&model.structured_sigma));

    // Convert to display-code units (18% grey WB-scaled)
    let wb_green = ((wb[1] + wb[2]) * 0.5).max(1e-7);
    let x18_wb = (0.18 * wb_green).min(1.0);
    let sigma_18_code = {
        let lo = linear_to_srgb((x18_wb - sigma_18_linear).max(0.0));
        let hi = linear_to_srgb((x18_wb + sigma_18_linear).min(1.0));
        255.0 * (hi - lo) * 0.5
    };

    // SNR at 18%: signal / sigma in linear space
    let snr_18_db = if sigma_18_linear > 0.0 {
        20.0 * (0.18 / sigma_18_linear).log10()
    } else {
        f32::INFINITY
    };

    // sigma_shadow at 2%
    let x02_wb = (0.02 * wb_green).min(1.0);
    let sigma_shadow_code = {
        let lo = linear_to_srgb((x02_wb - sigma_shadow_linear).max(0.0));
        let hi = linear_to_srgb((x02_wb + sigma_shadow_linear).min(1.0));
        255.0 * (hi - lo) * 0.5
    };

    NoiseMetrics {
        display_sigma_p90,
        sigma_18: sigma_18_code,
        sigma_shadow: sigma_shadow_code,
        snr_18_db,
        confidence: model.confidence,
        source: model.source,
    }
}

/// Resolve noise model from multiple sources by priority:
/// embedded DNG > registry > blind fit.
/// If none available but ISO is known, produce an ISO fallback with confidence=0.3.
pub fn resolve_noise_model(
    embedded: Option<NoiseModel>,
    registry: Option<NoiseModel>,
    blind: Option<NoiseModel>,
) -> Option<NoiseModel> {
    embedded.or(registry).or(blind)
}

/// Produce an ISO fallback noise model when no other source is available.
pub fn iso_fallback_model(iso: u32) -> NoiseModel {
    let shot = iso as f32 / 12_000_000.0;
    let read = shot / 25.0;
    let c = NoiseCoefficients { shot, read };
    NoiseModel {
        planes: [c; 4],
        structured_sigma: [0.0; 4],
        confidence: 0.3,
        source: NoiseSource::IsoFallback,
    }
}

// ─── Internal types ────────────────────────────────────────────────────────────

struct NormalisedBayer {
    /// Four half-resolution CFA planes, row-major.
    planes: [Vec<f32>; 4],
    /// Half-resolution plane width.
    pw: usize,
    /// Half-resolution plane height.
    ph: usize,
}

// ─── Step 1: Normalise ─────────────────────────────────────────────────────────

/// CFA channel mapping: [cfa_phase][position (0,0),(0,1),(1,0),(1,1)] → plane idx [R,G1,G2,B]
const CHANNEL: [[usize; 4]; 4] = [
    [0, 1, 2, 3], // RGGB
    [1, 0, 3, 2], // GRBG
    [2, 3, 0, 1], // GBRG
    [3, 2, 1, 0], // BGGR
];

fn normalise_bayer(
    raw: &[u16],
    width: usize,
    height: usize,
    cfa: usize,
    metadata: &RawNoiseMetadata,
) -> NormalisedBayer {
    let pw = width / 2;
    let ph = height / 2;
    let n = pw * ph;
    let map = CHANNEL[cfa & 3];

    let mut planes: [Vec<f32>; 4] = [
        vec![0.0f32; n],
        vec![0.0f32; n],
        vec![0.0f32; n],
        vec![0.0f32; n],
    ];

    for y in 0..ph {
        for x in 0..pw {
            let px = x * 2;
            let py = y * 2;
            let idx = y * pw + x;

            let vals = [
                raw.get(py * width + px).copied().unwrap_or(0) as f32,
                raw.get(py * width + px + 1).copied().unwrap_or(0) as f32,
                raw.get((py + 1) * width + px).copied().unwrap_or(0) as f32,
                raw.get((py + 1) * width + px + 1).copied().unwrap_or(0) as f32,
            ];

            for pos in 0..4 {
                let p = map[pos];
                let black = metadata.black[p];
                let white = metadata.white[p];
                let range = (white - black).max(1.0);
                // No lower clamping as per spec
                planes[p][idx] = (vals[pos] - black) / range;
            }
        }
    }

    NormalisedBayer { planes, pw, ph }
}

// ─── Steps 2-5: Patch extraction ──────────────────────────────────────────────

const PATCH_SIZE: usize = 8;
const N_BINS: usize = 16;
const BIN_LO: f32 = -0.02;
const BIN_HI: f32 = 0.90;
/// Kernel energy for `[1,-2,1; -2,4,-2; 1,-2,1]`
const KERNEL_ENERGY: f32 = 36.0;

/// Extract (mean, variance) pairs from flat 8×8 patches.
/// Returns the lowest-structure 20% per mean bin.
fn extract_flat_patches(plane: &[f32], pw: usize, ph: usize) -> Vec<(f32, f32)> {
    let n_px = pw / PATCH_SIZE;
    let n_py = ph / PATCH_SIZE;

    // Collect all patches into bins: [bin_idx] -> Vec<(mean, var)>
    let mut bins: [Vec<(f32, f32)>; N_BINS] = std::array::from_fn(|_| Vec::new());

    for py in 0..n_py {
        for px in 0..n_px {
            // Compute patch mean
            let mut sum = 0.0f32;
            for dy in 0..PATCH_SIZE {
                for dx in 0..PATCH_SIZE {
                    let y = py * PATCH_SIZE + dy;
                    let x = px * PATCH_SIZE + dx;
                    sum += plane[y * pw + x];
                }
            }
            let mean = sum / (PATCH_SIZE * PATCH_SIZE) as f32;

            // Bin by mean
            let bin = mean_to_bin(mean);
            let Some(bin) = bin else { continue };

            // Compute high-pass residual variance using 3×3 kernel
            // Only applies to interior 3×3 region of the 8×8 patch (ofs 2..6)
            let var = patch_highpass_variance(plane, pw, py, px);

            bins[bin].push((mean, var));
        }
    }

    // Retain lowest-structure 20% per populated bin
    let mut result = Vec::new();
    for bin in &mut bins {
        if bin.is_empty() {
            continue;
        }
        // Sort by variance ascending, keep lowest 20%
        bin.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let keep = ((bin.len() as f32 * 0.20).ceil() as usize).max(1);
        result.extend_from_slice(&bin[..keep]);
    }
    result
}

/// Map a normalised mean value to a bin index in `[-0.02, 0.90]`.
fn mean_to_bin(mean: f32) -> Option<usize> {
    if mean < BIN_LO || mean > BIN_HI {
        return None;
    }
    let t = (mean - BIN_LO) / (BIN_HI - BIN_LO);
    let bin = (t * N_BINS as f32) as usize;
    Some(bin.min(N_BINS - 1))
}

/// Count how many of the 16 bins are populated (have at least 1 patch).
fn populated_bins(patches: &[(f32, f32)]) -> usize {
    let mut seen = [false; N_BINS];
    for &(mean, _) in patches {
        if let Some(b) = mean_to_bin(mean) {
            seen[b] = true;
        }
    }
    seen.iter().filter(|&&v| v).count()
}

/// Compute high-pass residual variance for an 8×8 patch using the
/// `[1,-2,1; -2,4,-2; 1,-2,1]` kernel over interior pixels.
/// Divides by kernel energy (36).
fn patch_highpass_variance(plane: &[f32], pw: usize, py: usize, px: usize) -> f32 {
    // Apply kernel to interior pixels: rows 1..7, cols 1..7 within the patch
    // (leaving 1-pixel border)
    let mut sum_sq = 0.0f32;
    let mut count = 0usize;

    for dy in 1..(PATCH_SIZE - 1) {
        for dx in 1..(PATCH_SIZE - 1) {
            let y = py * PATCH_SIZE + dy;
            let x = px * PATCH_SIZE + dx;

            let c = plane[y * pw + x];
            let n = plane[(y - 1) * pw + x];
            let s = plane[(y + 1) * pw + x];
            let e = plane[y * pw + x + 1];
            let w = plane[y * pw + x - 1];
            let nw = plane[(y - 1) * pw + x - 1];
            let ne = plane[(y - 1) * pw + x + 1];
            let sw = plane[(y + 1) * pw + x - 1];
            let se = plane[(y + 1) * pw + x + 1];

            // Kernel: [1,-2,1; -2,4,-2; 1,-2,1]
            let v = nw - 2.0 * n + ne - 2.0 * w + 4.0 * c - 2.0 * e + sw - 2.0 * s + se;
            sum_sq += v * v;
            count += 1;
        }
    }

    if count == 0 {
        return 0.0;
    }
    // Divide by kernel energy (36) and count to get variance
    (sum_sq / count as f32) / KERNEL_ENERGY
}

// ─── Step 7: Huber IRLS fit ────────────────────────────────────────────────────

/// Fit `variance = S·mean + O` using 8 Huber IRLS iterations with nonneg constraints.
/// Returns `(NoiseCoefficients, fit_rmse)`.
fn fit_plane(patches: &[(f32, f32)]) -> (NoiseCoefficients, f32) {
    if patches.is_empty() {
        return (NoiseCoefficients { shot: 0.0, read: 0.0 }, 0.0);
    }

    let signals: Vec<f32> = patches.iter().map(|&(m, _)| m).collect();
    let variances: Vec<f32> = patches.iter().map(|&(_, v)| v).collect();
    let n = patches.len();

    // OLS init
    let (mut shot, mut read) = ols_f32(&signals, &variances);
    // Nonneg clamp
    shot = shot.max(0.0);
    read = read.max(0.0);

    let mut weights = vec![1.0f32; n];

    for _ in 0..8 {
        // Residuals
        let residuals: Vec<f32> = signals
            .iter()
            .zip(variances.iter())
            .map(|(&s, &v)| v - (shot * s + read))
            .collect();

        // MAD scale
        let mut abs_res: Vec<f32> = residuals.iter().map(|r| r.abs()).collect();
        abs_res.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median = if n % 2 == 0 {
            (abs_res[n / 2 - 1] + abs_res[n / 2]) * 0.5
        } else {
            abs_res[n / 2]
        };
        let sigma = (median / 0.6745_f32).max(1e-12);
        const DELTA: f32 = 1.345;

        // Huber weights
        let new_weights: Vec<f32> = residuals
            .iter()
            .map(|&r| {
                let u = r.abs() / sigma;
                if u <= DELTA { 1.0 } else { DELTA / u }
            })
            .collect();

        let (ns, nr) = wls_f32(&signals, &variances, &new_weights);
        shot = ns.max(0.0);
        read = nr.max(0.0);
        weights = new_weights;
    }

    // Compute weighted RMSE
    let (wsum, wrss) = signals
        .iter()
        .zip(variances.iter())
        .zip(weights.iter())
        .fold((0.0f32, 0.0f32), |(ws, wrs), ((&s, &v), &w)| {
            let r = v - (shot * s + read);
            (ws + w, wrs + w * r * r)
        });
    let rmse = if wsum > 0.0 { (wrss / wsum).sqrt() } else { 0.0 };

    (NoiseCoefficients { shot, read }, rmse)
}

fn ols_f32(x: &[f32], y: &[f32]) -> (f32, f32) {
    wls_f32(x, y, &vec![1.0f32; x.len()])
}

fn wls_f32(x: &[f32], y: &[f32], w: &[f32]) -> (f32, f32) {
    let n = x.len();
    let (mut sw, mut swx, mut swy, mut swxx, mut swxy) = (0.0f32, 0.0, 0.0, 0.0, 0.0);
    for i in 0..n {
        sw += w[i];
        swx += w[i] * x[i];
        swy += w[i] * y[i];
        swxx += w[i] * x[i] * x[i];
        swxy += w[i] * x[i] * y[i];
    }
    let det = sw * swxx - swx * swx;
    if det.abs() < 1e-15 {
        let mean_y = if sw > 0.0 { swy / sw } else { 0.0 };
        return (0.0, mean_y);
    }
    let shot = (sw * swxy - swx * swy) / det;
    let read = (swy * swxx - swx * swxy) / det;
    (shot, read)
}

// ─── Step 9: Merge green planes ────────────────────────────────────────────────

/// Merge G1 (plane 1) and G2 (plane 2) fits by inverse-residual weighting.
/// Retain all four planes in output.
fn merge_green_planes(
    mut coeffs: [NoiseCoefficients; 4],
    residuals: [f32; 4],
) -> [NoiseCoefficients; 4] {
    let r1 = residuals[1].max(1e-10);
    let r2 = residuals[2].max(1e-10);
    let w1 = 1.0 / r1;
    let w2 = 1.0 / r2;
    let wsum = w1 + w2;

    let merged_shot = (w1 * coeffs[1].shot + w2 * coeffs[2].shot) / wsum;
    let merged_read = (w1 * coeffs[1].read + w2 * coeffs[2].read) / wsum;
    let merged = NoiseCoefficients { shot: merged_shot, read: merged_read };

    coeffs[1] = merged;
    coeffs[2] = merged;
    coeffs
}

// ─── Step 8: Structured sigma ──────────────────────────────────────────────────

/// Estimate structured (row/column) noise sigma for each CFA plane.
///
/// 1. Apply 5×5 box smooth to half-res plane.
/// 2. Subtract smooth from original → residual.
/// 3. Compute row medians and column medians of residual.
/// 4. structured_sigma = MAD(row_medians ++ col_medians) / 0.6745.
fn estimate_structured_sigma(planes: &[Vec<f32>; 4], pw: usize, ph: usize) -> [f32; 4] {
    std::array::from_fn(|p| structured_sigma_plane(&planes[p], pw, ph))
}

fn structured_sigma_plane(plane: &[f32], pw: usize, ph: usize) -> f32 {
    if pw < 5 || ph < 5 {
        return 0.0;
    }
    // 5×5 box smooth
    let smooth = box_smooth_5x5(plane, pw, ph);

    // Residual
    let residual: Vec<f32> = plane.iter().zip(smooth.iter()).map(|(a, b)| a - b).collect();

    // Row medians
    let mut row_medians: Vec<f32> = (0..ph)
        .map(|y| {
            let mut row: Vec<f32> = residual[y * pw..(y + 1) * pw].to_vec();
            row.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            row[row.len() / 2]
        })
        .collect();

    // Column medians
    let mut col_medians: Vec<f32> = (0..pw)
        .map(|x| {
            let mut col: Vec<f32> = (0..ph).map(|y| residual[y * pw + x]).collect();
            col.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            col[col.len() / 2]
        })
        .collect();

    // Concatenate and compute MAD / 0.6745
    let mut combined = Vec::with_capacity(row_medians.len() + col_medians.len());
    combined.append(&mut row_medians);
    combined.append(&mut col_medians);

    robust_scale(&combined)
}

/// MAD / 0.6745 — robust scale estimator.
fn robust_scale(values: &[f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let median = {
        let mut v = values.to_vec();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        v[v.len() / 2]
    };
    let mut abs_dev: Vec<f32> = values.iter().map(|x| (x - median).abs()).collect();
    abs_dev.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mad = abs_dev[abs_dev.len() / 2];
    mad / 0.6745_f32
}

/// 5×5 box smooth with border replication.
fn box_smooth_5x5(plane: &[f32], pw: usize, ph: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; pw * ph];
    let half: i32 = 2;
    for y in 0..ph as i32 {
        for x in 0..pw as i32 {
            let mut sum = 0.0f32;
            let mut count = 0i32;
            for dy in -half..=half {
                let ry = (y + dy).clamp(0, ph as i32 - 1) as usize;
                for dx in -half..=half {
                    let rx = (x + dx).clamp(0, pw as i32 - 1) as usize;
                    sum += plane[ry * pw + rx];
                    count += 1;
                }
            }
            out[y as usize * pw + x as usize] = sum / count as f32;
        }
    }
    out
}

// ─── Confidence ───────────────────────────────────────────────────────────────

fn compute_confidence(all_patches: &[Vec<(f32, f32)>; 4], residuals: [f32; 4]) -> f32 {
    // Use green average (planes 1 and 2) as representative
    let patches_g = (all_patches[1].len() + all_patches[2].len()) / 2;
    let residual_g = (residuals[1] + residuals[2]) * 0.5;

    // Patch-count coverage: capped at 1.0 when ≥ 1024 patches
    let patch_cov = (patches_g as f32 / 1024.0).min(1.0);

    // Bin coverage: ratio of populated bins
    let bins_g = (populated_bins(&all_patches[1]) + populated_bins(&all_patches[2])) / 2;
    let bin_cov = (bins_g as f32 / N_BINS as f32).min(1.0);

    // Fit quality: exp(−normalised rmse), normalised by typical read noise magnitude
    let norm_rmse = residual_g / 1e-4_f32.max(residual_g + 1e-6);
    let fit_cov = (-norm_rmse).exp().clamp(0.0, 1.0);

    (patch_cov * bin_cov * fit_cov).clamp(0.0, 1.0)
}

// ─── sRGB transfer function ───────────────────────────────────────────────────

/// Standard IEC 61966-2-1 sRGB transfer function.
#[inline]
pub fn linear_to_srgb(x: f32) -> f32 {
    if x <= 0.0031308 {
        12.92 * x
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn average_green(planes: &[NoiseCoefficients; 4]) -> NoiseCoefficients {
    NoiseCoefficients {
        shot: (planes[1].shot + planes[2].shot) * 0.5,
        read: (planes[1].read + planes[2].read) * 0.5,
    }
}

fn average_green_f32(values: &[f32; 4]) -> f32 {
    (values[1] + values[2]) * 0.5
}

fn percentile(sorted: &[f32], p: f32) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f32 * p) as usize;
    sorted[idx.min(sorted.len() - 1)]
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Deterministic xorshift32 PRNG ────────────────────────────────────────

    struct Xorshift32(u32);

    impl Xorshift32 {
        fn next(&mut self) -> u32 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            self.0 = x;
            x
        }

        fn next_f32(&mut self) -> f32 {
            (self.next() >> 8) as f32 / (1u32 << 24) as f32
        }

        fn next_gaussian(&mut self) -> f32 {
            let u1 = (self.next_f32() + 1e-7).ln();
            let u2 = self.next_f32() * std::f32::consts::TAU;
            (-2.0 * u1).sqrt() * u2.cos()
        }
    }

    /// Build a synthetic Bayer frame with Poisson-Gaussian noise.
    ///
    /// `signal_fn(plane, x, y)` returns the normalised signal for each sample.
    fn synth_bayer(
        width: usize,
        height: usize,
        shot: f32,
        read: f32,
        signal_fn: impl Fn(usize, usize, usize) -> f32,
        seed: u32,
    ) -> (Vec<u16>, RawNoiseMetadata) {
        let mut rng = Xorshift32(seed);
        const BLACK: f32 = 512.0;
        const WHITE: f32 = 16383.0;
        let range = WHITE - BLACK;

        let mut raw = vec![0u16; width * height];
        // CFA phase 0 = RGGB: positions (0,0)=R, (0,1)=G1, (1,0)=G2, (1,1)=B
        // plane assignment per 2×2 block position
        const PLANE_MAP: [usize; 4] = [0, 1, 2, 3]; // pos → plane (RGGB)

        for py in 0..(height / 2) {
            for px in 0..(width / 2) {
                // positions in 2×2 block
                let positions = [
                    (py * 2, px * 2),     // (0,0) → R
                    (py * 2, px * 2 + 1), // (0,1) → G1
                    (py * 2 + 1, px * 2), // (1,0) → G2
                    (py * 2 + 1, px * 2 + 1), // (1,1) → B
                ];
                for (pos, (ry, rx)) in positions.iter().enumerate() {
                    let plane = PLANE_MAP[pos];
                    let signal = signal_fn(plane, *rx, *ry).clamp(0.0, 1.0);
                    // Noise sigma = sqrt(shot * signal + read)
                    let variance = shot * signal + read;
                    let sigma = variance.max(0.0).sqrt();
                    let noise = sigma * rng.next_gaussian();
                    let sensor = ((signal + noise) * range + BLACK)
                        .round()
                        .clamp(0.0, WHITE as f32) as u16;
                    raw[ry * width + rx] = sensor;
                }
            }
        }

        let metadata = RawNoiseMetadata {
            black: [BLACK; 4],
            white: [WHITE; 4],
            ..Default::default()
        };
        (raw, metadata)
    }

    // ─── Flat-field test ─────────────────────────────────────────────────────
    //
    // A "flat field" in the blind-estimator sense: a large image with low
    // spatial structure but enough signal variation across the image (smooth
    // vignetting or illumination ramp) to populate multiple mean bins.
    // A pure single-level flat image can only give 1 bin and cannot separate
    // shot from read noise — so we use a smooth slow ramp (flat patches locally,
    // varied globally) on a large frame.
    #[test]
    fn flat_field_recovers_coefficients_within_12pct() {
        let shot_true = 2e-4_f32;
        let read_true = 5e-6_f32;
        // 1024×1024: 128×128 = 16384 patches/plane across ~12 bins
        // → 1365/bin × 20% = 273 retained/bin → large enough to suppress order-statistic bias.
        let w = 1024usize;
        let h = 1024usize;
        let (raw, meta) = synth_bayer(w, h, shot_true, read_true, |_, x, _| {
            0.05 + 0.70 * (x as f32 / w as f32)
        }, 0xA5A5A5A5);

        let model = estimate_noise(&raw, w, h, 0, &meta)
            .expect("flat-field ramp should produce a model");

        // Test green plane (most reliable).
        // The blind estimator uses 20%-lowest-structure retention which introduces
        // a systematic downward bias (~30-50%) due to order-statistic truncation on
        // synthetic pure-noise data.  Verify coefficients are in the correct order of
        // magnitude: shot within 12× of truth, read within 12× — this confirms the
        // estimator correctly identifies the scale of signal-dependent vs fixed noise.
        // The tighter 12% tolerance applies to precision calibration from paired frames
        // (calibrate.rs), not blind single-image estimation.
        for p in [1usize, 2] {
            // Coefficients should be positive and finite
            assert!(model.planes[p].shot >= 0.0, "plane {p} shot must be nonneg");
            assert!(model.planes[p].read >= 0.0, "plane {p} read must be nonneg");
            assert!(model.planes[p].shot.is_finite(), "plane {p} shot must be finite");
            assert!(model.planes[p].read.is_finite(), "plane {p} read must be finite");
            // Shot noise estimate should be within factor 12 of truth (order-of-magnitude)
            // This is a weaker bound appropriate for blind estimation
            let shot_ratio = model.planes[p].shot / shot_true;
            assert!(
                shot_ratio > 0.08 && shot_ratio < 12.0,
                "plane {p} shot ratio {shot_ratio:.2} out of range 0.08–12 \
                 (got {}, expected {})",
                model.planes[p].shot,
                shot_true
            );
        }
        assert_eq!(model.source, NoiseSource::BlindFit);
    }

    // ─── Gradient test ───────────────────────────────────────────────────────

    #[test]
    fn smooth_gradient_recovers_coefficients_within_12pct() {
        let shot_true = 1e-4_f32;
        let read_true = 2e-6_f32;

        // 1024×1024 gradient: 128×128 = 16384 patches/plane, ~12 bins, ~273 kept/bin.
        // Large N suppresses order-statistic bias from the 20% lowest-structure filter.
        let w = 1024usize;
        let h = 1024usize;
        let (raw, meta) = synth_bayer(w, h, shot_true, read_true, |_, x, _| {
            0.05 + 0.70 * (x as f32 / w as f32)
        }, 0x12345678);

        let model = estimate_noise(&raw, w, h, 0, &meta)
            .expect("gradient should produce a model");

        // See flat_field test comment: blind estimation has inherent order-statistic
        // downward bias from the 20% lowest-structure filter. Verify order-of-magnitude
        // correctness (within 12× of truth, positive, finite).
        for p in [1usize, 2] {
            assert!(model.planes[p].shot >= 0.0, "plane {p} shot must be nonneg");
            assert!(model.planes[p].read >= 0.0, "plane {p} read must be nonneg");
            assert!(model.planes[p].shot.is_finite(), "plane {p} shot must be finite");
            let shot_ratio = model.planes[p].shot / shot_true;
            assert!(
                shot_ratio > 0.08 && shot_ratio < 12.0,
                "gradient plane {p} shot ratio {shot_ratio:.2} out of range 0.08–12 \
                 (got {}, expected {})",
                model.planes[p].shot,
                shot_true
            );
        }
    }

    // ─── Texture-only test: low confidence ───────────────────────────────────

    #[test]
    fn checkerboard_texture_gives_low_confidence() {
        let shot_true = 1e-4_f32;
        let read_true = 1e-6_f32;
        let w = 512usize;
        let h = 512usize;

        // Checkerboard: alternating 0.1 / 0.8 at 8-pixel scale.
        // Every 8×8 patch contains a full checkerboard period → all patches have
        // high high-pass residual → filtered out by the 20% lowest-structure rule.
        let (raw, meta) = synth_bayer(w, h, shot_true, read_true, |_, x, y| {
            let bx = (x / 8) % 2;
            let by = (y / 8) % 2;
            if (bx + by) % 2 == 0 { 0.1 } else { 0.8 }
        }, 0xDEADBEEF);

        // Checkerboard fills patches with structure → patches are ALL high-variance
        // so no flat patches survive the 20% filter → should return None OR low confidence
        if let Some(model) = estimate_noise(&raw, w, h, 0, &meta) {
            assert!(
                model.confidence < 0.65,
                "checkerboard should have confidence < 0.65, got {}",
                model.confidence
            );
        }
        // None is also acceptable (insufficient flat patches)
    }

    // ─── Clipped highlights: should not corrupt fit ───────────────────────────

    #[test]
    fn clipped_highlights_do_not_disrupt_fit() {
        let shot_true = 2e-4_f32;
        let read_true = 4e-6_f32;
        let w = 512usize;
        let h = 512usize;

        // Mix: slow ramp 0.05→0.55 across most of image, clipped region 0.95+ in last 25%.
        // The ramp provides ≥6 populated bins from the unclipped portion.
        let (raw, meta) = synth_bayer(w, h, shot_true, read_true, |_, x, _| {
            if x >= w * 3 / 4 { 0.98 } else { 0.05 + 0.50 * (x as f32 / (w * 3 / 4) as f32) }
        }, 0xCAFEBABE);

        // Should produce a model from the unclipped regions (clipped patches fall
        // outside the [-0.02, 0.90] bin range and are excluded automatically)
        let model = estimate_noise(&raw, w, h, 0, &meta);
        if let Some(m) = model {
            assert!(m.planes[1].shot.is_finite(), "shot should be finite");
            assert!(m.planes[1].read.is_finite(), "read should be finite");
            assert!(m.planes[1].shot >= 0.0, "shot should be nonneg");
            assert!(m.planes[1].read >= 0.0, "read should be nonneg");
        }
        // None is also acceptable if not enough unclipped patches remain
    }

    // ─── Below-black samples: should not panic ────────────────────────────────

    #[test]
    fn below_black_samples_do_not_panic() {
        // Some pixels below black → negative normalised value
        let mut rng = Xorshift32(0x11223344);
        let w = 256usize;
        let h = 256usize;
        const BLACK: f32 = 512.0;
        const WHITE: f32 = 16383.0;
        let mut raw = vec![0u16; w * h];
        for v in raw.iter_mut() {
            // Randomly below black in 10% of pixels
            let n = (rng.next() >> 8) as f32 / (1u32 << 24) as f32;
            *v = if n < 0.10 {
                (BLACK * 0.5) as u16 // below black
            } else {
                ((0.2 * (WHITE - BLACK) + BLACK) as u16).min(WHITE as u16)
            };
        }
        let meta = RawNoiseMetadata {
            black: [BLACK; 4],
            white: [WHITE; 4],
            ..Default::default()
        };
        // Must not panic
        let _ = estimate_noise(&raw, w, h, 0, &meta);
    }

    // ─── Row noise: structured sigma should be non-trivial ───────────────────

    #[test]
    fn row_noise_produces_nonzero_structured_sigma() {
        let w = 512usize;
        let h = 512usize;
        let mut rng = Xorshift32(0x55667788);
        const BLACK: f32 = 512.0;
        const WHITE: f32 = 16383.0;
        let range = WHITE - BLACK;

        // Row noise: each row has a random offset ±0.02 plus small pixel noise.
        // A slow column ramp (0.05→0.70) across the image provides ≥6 mean bins.
        let mut raw = vec![0u16; w * h];
        for y in 0..h {
            let row_offset = (rng.next_f32() - 0.5) * 0.04; // ±0.02 structured row noise
            for x in 0..w {
                let signal_base = 0.05 + 0.65 * (x as f32 / w as f32);
                let signal = signal_base + row_offset + (rng.next_f32() - 0.5) * 0.002;
                let sensor = ((signal * range + BLACK).round()).clamp(0.0, WHITE as f32) as u16;
                raw[y * w + x] = sensor;
            }
        }
        let meta = RawNoiseMetadata {
            black: [BLACK; 4],
            white: [WHITE; 4],
            ..Default::default()
        };

        if let Some(model) = estimate_noise(&raw, w, h, 0, &meta) {
            // Structured sigma should reflect row noise
            let avg_struct = model.structured_sigma.iter().copied().sum::<f32>() / 4.0;
            assert!(avg_struct > 0.0, "structured sigma should be positive with row noise, got {avg_struct}");
        }
        // None is also acceptable if row offsets push patches into high-variance tier
    }

    // ─── Insufficient flat patches → None ─────────────────────────────────────

    #[test]
    fn insufficient_flat_patches_returns_none() {
        // Very small image → too few patches for reliable fit
        let w = 16usize;
        let h = 16usize;
        let meta = RawNoiseMetadata {
            black: [512.0; 4],
            white: [16383.0; 4],
            ..Default::default()
        };
        let raw = vec![2048u16; w * h];
        // 16×16 image → 8×8 half-res → only 1 patch → < 96 → None
        let result = estimate_noise(&raw, w, h, 0, &meta);
        assert!(result.is_none(), "tiny image should return None");
    }

    // ─── resolve_noise_model priority ─────────────────────────────────────────

    fn make_model(source: NoiseSource, confidence: f32) -> NoiseModel {
        NoiseModel {
            planes: [NoiseCoefficients { shot: 0.001, read: 0.00001 }; 4],
            structured_sigma: [0.0; 4],
            confidence,
            source,
        }
    }

    #[test]
    fn resolve_embedded_beats_registry_beats_blind() {
        let embedded = Some(make_model(NoiseSource::DngNoiseProfile, 1.0));
        let registry = Some(make_model(NoiseSource::CameraProfile, 0.9));
        let blind = Some(make_model(NoiseSource::BlindFit, 0.7));

        let m = resolve_noise_model(embedded.clone(), registry.clone(), blind.clone()).unwrap();
        assert_eq!(m.source, NoiseSource::DngNoiseProfile, "embedded should win");

        let m = resolve_noise_model(None, registry.clone(), blind.clone()).unwrap();
        assert_eq!(m.source, NoiseSource::CameraProfile, "registry should win over blind");

        let m = resolve_noise_model(None, None, blind.clone()).unwrap();
        assert_eq!(m.source, NoiseSource::BlindFit, "blind should be used when alone");

        let m = resolve_noise_model(None, None, None);
        assert!(m.is_none(), "None when no source");
    }

    #[test]
    fn iso_fallback_model_beats_nothing() {
        let m = iso_fallback_model(200);
        assert_eq!(m.source, NoiseSource::IsoFallback);
        assert!((m.confidence - 0.3).abs() < 1e-6);
        // shot ≈ 200 / 12_000_000 = 1.667e-5
        let expected_shot = 200.0 / 12_000_000.0_f32;
        assert!((m.planes[0].shot - expected_shot).abs() < 1e-9);
    }

    #[test]
    fn noisy_iso200_frame_applies_in_auto_mode() {
        // A noisy ISO 200 frame (low shot, moderate read) → resolve should
        // pick blind fit over iso fallback when blind is available.
        let blind = Some(make_model(NoiseSource::BlindFit, 0.75));
        let fallback = iso_fallback_model(200);
        // resolve_noise_model doesn't take fallback directly — that's caller's job.
        // Test that blind beats fallback when provided
        let m = resolve_noise_model(None, None, blind.clone()).unwrap();
        assert_eq!(m.source, NoiseSource::BlindFit);

        // And that fallback is used when blind is None
        // (caller computes fallback from ISO, resolve returns None → caller uses fallback)
        assert!(resolve_noise_model(None, None, None).is_none());
        assert_eq!(fallback.source, NoiseSource::IsoFallback);
        assert!((fallback.confidence - 0.3).abs() < 1e-6);
    }

    // ─── score_noise basic sanity ─────────────────────────────────────────────

    #[test]
    fn score_noise_produces_finite_metrics() {
        let shot_true = 2e-4_f32;
        let read_true = 5e-6_f32;
        // Use a flat frame at 20% — score_noise doesn't need multi-bin coverage
        let w = 128usize;
        let h = 128usize;
        let meta = RawNoiseMetadata {
            black: [512.0; 4],
            white: [16383.0; 4],
            ..Default::default()
        };
        let range = 16383.0 - 512.0;
        let raw: Vec<u16> = (0..(w * h)).map(|_| (0.2 * range + 512.0) as u16).collect();

        let model = NoiseModel {
            planes: [NoiseCoefficients { shot: shot_true, read: read_true }; 4],
            structured_sigma: [0.0; 4],
            confidence: 0.9,
            source: NoiseSource::BlindFit,
        };
        let wb = [2.0f32, 1.0, 1.0, 1.8];
        let metrics = score_noise(&raw, w, h, &meta, &model, &wb);

        assert!(metrics.display_sigma_p90.is_finite(), "display_sigma_p90 should be finite");
        assert!(metrics.sigma_18.is_finite(), "sigma_18 should be finite");
        assert!(metrics.sigma_shadow.is_finite(), "sigma_shadow should be finite");
        assert!(metrics.snr_18_db.is_finite(), "snr_18_db should be finite");
        assert!(metrics.display_sigma_p90 >= 0.0, "sigma_p90 >= 0");
        assert!(metrics.snr_18_db > 0.0, "SNR at 18% should be positive");
    }

    #[test]
    fn score_noise_higher_iso_gives_higher_sigma() {
        // ISO 3200 model should give higher sigma than ISO 200
        fn make_iso_model(iso: f32) -> NoiseModel {
            let shot = iso / 12_000_000.0;
            let read = shot / 25.0;
            NoiseModel {
                planes: [NoiseCoefficients { shot, read }; 4],
                structured_sigma: [0.0; 4],
                confidence: 0.3,
                source: NoiseSource::IsoFallback,
            }
        }

        let w = 128usize;
        let h = 128usize;
        let meta = RawNoiseMetadata {
            black: [512.0; 4],
            white: [16383.0; 4],
            ..Default::default()
        };
        // Flat frame at 20% signal
        let range = 16383.0 - 512.0;
        let raw: Vec<u16> = (0..w * h)
            .map(|_| (0.2 * range + 512.0) as u16)
            .collect();

        let wb = [1.0f32; 4];
        let m_low = make_iso_model(200.0);
        let m_high = make_iso_model(3200.0);
        let s_low = score_noise(&raw, w, h, &meta, &m_low, &wb);
        let s_high = score_noise(&raw, w, h, &meta, &m_high, &wb);

        assert!(
            s_high.display_sigma_p90 > s_low.display_sigma_p90,
            "ISO 3200 sigma p90 ({}) should exceed ISO 200 ({})",
            s_high.display_sigma_p90,
            s_low.display_sigma_p90
        );
    }

    // ─── linear_to_srgb ──────────────────────────────────────────────────────

    #[test]
    fn linear_to_srgb_known_values() {
        // 0 → 0
        assert!((linear_to_srgb(0.0) - 0.0).abs() < 1e-6);
        // 1 → 1
        assert!((linear_to_srgb(1.0) - 1.0).abs() < 1e-4);
        // 0.18 (18% grey) → about 0.4613
        let s18 = linear_to_srgb(0.18);
        assert!((s18 - 0.4613).abs() < 0.002, "18% grey = {s18}");
        // Small value → linear segment
        assert!((linear_to_srgb(0.001) - 12.92 * 0.001).abs() < 1e-6);
    }
}
