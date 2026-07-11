//! Deterministic two-stage BM3D denoiser.
//!
//! Operates on a single-channel normalized float image that has been
//! variance-stabilized (VST applied). After BM3D, apply the inverse VST.
//!
//! # Determinism
//! - Tiles are processed in parallel via Rayon, but output tiles are written
//!   sequentially (no shared mutable state during parallel phase).
//! - Within each tile, reference patches are visited in row-major order.
//! - Block-matching sorts similar patches by `(distance.to_bits(), row, col)`
//!   to break float-equality ties deterministically.
//! - All kernels (DCT, Haar, Kaiser) are purely functional with no shared state.
//!
//! # Reference
//! Dabov et al., "Image Denoising by Sparse 3D Transform-Domain
//! Collaborative Filtering", IEEE TIP 2007.

// ─── Parameters ──────────────────────────────────────────────────────────────

/// Patch size (PATCH×PATCH pixels).
const PATCH: usize = 8;
/// Search window half-size (radius in pixels).
const SEARCH: usize = 32;
/// Step between reference patches.
const REF_STEP: usize = 3;
/// Maximum group size in stage 1 (hard thresholding).
const GROUP1: usize = 16;
/// Maximum group size in stage 2 (Wiener shrinkage).
const GROUP2: usize = 32;
/// Hard threshold multiplier.
const LAMBDA: f32 = 2.7;
/// Outer tile size for parallelism.
const TILE: usize = 512;
/// Halo/overlap around each tile (must be >= SEARCH + PATCH).
const HALO: usize = 32;
/// Kaiser window beta parameter.
const KAISER_BETA: f32 = 2.0;

// ─── Bessel function ─────────────────────────────────────────────────────────

/// Modified Bessel function I₀(x), Abramowitz & Stegun 9.8.1 polynomial.
fn modified_bessel_i0(x: f32) -> f32 {
    if x.abs() <= 3.75 {
        let t = x / 3.75;
        let t2 = t * t;
        let t4 = t2 * t2;
        let t6 = t4 * t2;
        let t8 = t4 * t4;
        let t10 = t8 * t2;
        let t12 = t8 * t4;
        1.0 + 3.5156229 * t2
            + 3.0899424 * t4
            + 1.2067492 * t6
            + 0.2659732 * t8
            + 0.0360768 * t10
            + 0.0045813 * t12
    } else {
        let ax = x.abs();
        let t = 3.75 / ax;
        let t2 = t * t;
        let t3 = t2 * t;
        let t4 = t2 * t2;
        let t5 = t4 * t;
        let t6 = t4 * t2;
        let t7 = t4 * t3;
        let t8 = t4 * t4;
        (ax.sqrt().recip())
            * (0.39894228
                + 0.01328592 * t
                + 0.00225319 * t2
                - 0.00157565 * t3
                + 0.00916281 * t4
                - 0.02057706 * t5
                + 0.02635537 * t6
                - 0.01647633 * t7
                + 0.00392377 * t8)
            * ax.exp()
    }
}

// ─── Kaiser window ───────────────────────────────────────────────────────────

/// Precompute a 1D Kaiser window of length `n` with parameter `beta`.
fn kaiser_window(n: usize, beta: f32) -> Vec<f32> {
    let i0_beta = modified_bessel_i0(beta);
    let nm1 = (n - 1) as f32;
    (0..n)
        .map(|i| {
            let t = 2.0 * i as f32 / nm1 - 1.0;
            let arg = beta * (1.0 - t * t).max(0.0).sqrt();
            modified_bessel_i0(arg) / i0_beta
        })
        .collect()
}

/// Precompute a 2D Kaiser window (PATCH×PATCH) as row-major flat array.
fn kaiser2d() -> [f32; PATCH * PATCH] {
    let win1d = kaiser_window(PATCH, KAISER_BETA);
    let mut out = [0f32; PATCH * PATCH];
    for r in 0..PATCH {
        for c in 0..PATCH {
            out[r * PATCH + c] = win1d[r] * win1d[c];
        }
    }
    out
}

// ─── DCT-II (8×8 only) ───────────────────────────────────────────────────────

/// Compute 1D orthonormal DCT-II in-place.
///
/// Orthonormal DCT-II ensures that each output coefficient has the same noise
/// variance as the input, which is required for BM3D hard-threshold to work
/// with a uniform threshold LAMBDA * sigma.
///
/// `DCT[0] = sqrt(1/N) * sum_j x[j]`
/// `DCT[k] = sqrt(2/N) * sum_j x[j] * cos(pi*(2j+1)*k/(2N))`, k > 0
fn dct1d(x: &mut [f32]) {
    let n = x.len();
    let input: Vec<f32> = x.to_vec();
    let scale = std::f32::consts::PI / (2.0 * n as f32);
    let inv_sqrt_n = 1.0 / (n as f32).sqrt();
    let sqrt_2_over_n = (2.0 / n as f32).sqrt();
    for k in 0..n {
        let mut sum = 0.0f32;
        for j in 0..n {
            sum += input[j] * ((2 * j + 1) as f32 * k as f32 * scale).cos();
        }
        x[k] = if k == 0 { sum * inv_sqrt_n } else { sum * sqrt_2_over_n };
    }
}

/// Compute 1D orthonormal inverse DCT-II (= DCT-III) in-place.
/// Inverse of the orthonormal DCT-II above.
fn idct1d(x: &mut [f32]) {
    let n = x.len();
    let input: Vec<f32> = x.to_vec();
    let scale = std::f32::consts::PI / (2.0 * n as f32);
    let inv_sqrt_n = 1.0 / (n as f32).sqrt();
    let sqrt_2_over_n = (2.0 / n as f32).sqrt();
    for j in 0..n {
        // x[0] contributes: input[0] * sqrt(1/N) * sqrt(1/N) = input[0] / N
        // x[k] contributes: input[k] * sqrt(2/N) * cos(...) * sqrt(2/N) = 2*input[k]*cos(...)/N  (handled by orthonormality)
        // Actually: IDCT[j] = sum_k w[k] * input[k] * cos(pi*(2j+1)*k/(2N))
        // where w[0] = sqrt(1/N), w[k>0] = sqrt(2/N)
        let mut sum = input[0] * inv_sqrt_n;
        for k in 1..n {
            sum += input[k] * sqrt_2_over_n * ((2 * j + 1) as f32 * k as f32 * scale).cos();
        }
        x[j] = sum;
    }
}

/// Apply 2D DCT-II to a row-major PATCH×PATCH block.
fn dct2d(block: &mut [f32; PATCH * PATCH]) {
    // Row-wise DCT
    for r in 0..PATCH {
        dct1d(&mut block[r * PATCH..(r + 1) * PATCH]);
    }
    // Column-wise DCT
    let mut col = [0f32; PATCH];
    for c in 0..PATCH {
        for r in 0..PATCH {
            col[r] = block[r * PATCH + c];
        }
        dct1d(&mut col);
        for r in 0..PATCH {
            block[r * PATCH + c] = col[r];
        }
    }
}

/// Apply 2D inverse DCT-II to a row-major PATCH×PATCH block.
fn idct2d(block: &mut [f32; PATCH * PATCH]) {
    // Column-wise IDCT
    let mut col = [0f32; PATCH];
    for c in 0..PATCH {
        for r in 0..PATCH {
            col[r] = block[r * PATCH + c];
        }
        idct1d(&mut col);
        for r in 0..PATCH {
            block[r * PATCH + c] = col[r];
        }
    }
    // Row-wise IDCT
    for r in 0..PATCH {
        idct1d(&mut block[r * PATCH..(r + 1) * PATCH]);
    }
}

// ─── Haar wavelet (1D, on group stack) ───────────────────────────────────────

/// 1D Haar wavelet forward transform (lifting scheme) on a power-of-2 slice.
fn haar1d(x: &mut [f32]) {
    let n = x.len();
    debug_assert!(n >= 2 && n.is_power_of_two());
    let inv_sqrt2 = std::f32::consts::FRAC_1_SQRT_2;
    let mut len = n;
    while len > 1 {
        let half = len / 2;
        let tmp: Vec<f32> = x[..len].to_vec();
        for i in 0..half {
            let a = tmp[2 * i];
            let b = tmp[2 * i + 1];
            x[i] = (a + b) * inv_sqrt2;
            x[half + i] = (a - b) * inv_sqrt2;
        }
        len = half;
    }
}

/// 1D inverse Haar wavelet transform (lifting scheme) on a power-of-2 slice.
fn ihaar1d(x: &mut [f32]) {
    let n = x.len();
    debug_assert!(n >= 2 && n.is_power_of_two());
    let inv_sqrt2 = std::f32::consts::FRAC_1_SQRT_2;
    let mut len = 2usize;
    while len <= n {
        let half = len / 2;
        let low: Vec<f32> = x[..half].to_vec();
        let high: Vec<f32> = x[half..len].to_vec();
        for i in 0..half {
            x[2 * i] = (low[i] + high[i]) * inv_sqrt2;
            x[2 * i + 1] = (low[i] - high[i]) * inv_sqrt2;
        }
        len *= 2;
    }
}

// ─── Group transform ──────────────────────────────────────────────────────────

/// Smallest power of 2 >= n (minimum 1).
fn next_pow2(n: usize) -> usize {
    if n <= 1 {
        return 1;
    }
    let mut p = 1usize;
    while p < n {
        p <<= 1;
    }
    p
}

/// Apply 2D DCT to each patch in the group, then Haar on the group axis.
/// `group`: flat `[n_patches][PATCH*PATCH]` row-major.
fn transform_group(group: &mut [f32], n_patches: usize) {
    let pp = PATCH * PATCH;
    // 2D DCT on each patch
    for p in 0..n_patches {
        let mut block = [0f32; PATCH * PATCH];
        block.copy_from_slice(&group[p * pp..(p + 1) * pp]);
        dct2d(&mut block);
        group[p * pp..(p + 1) * pp].copy_from_slice(&block);
    }
    // Haar along group dimension for each spatial frequency coefficient
    let g_len = next_pow2(n_patches);
    if g_len < 2 {
        return;
    }
    let mut stack = vec![0f32; g_len];
    for coeff in 0..pp {
        for p in 0..n_patches {
            stack[p] = group[p * pp + coeff];
        }
        for p in n_patches..g_len {
            stack[p] = 0.0;
        }
        haar1d(&mut stack[..g_len]);
        for p in 0..n_patches {
            group[p * pp + coeff] = stack[p];
        }
    }
}

/// Inverse of `transform_group`.
fn itransform_group(group: &mut [f32], n_patches: usize) {
    let pp = PATCH * PATCH;
    let g_len = next_pow2(n_patches);
    if g_len >= 2 {
        let mut stack = vec![0f32; g_len];
        for coeff in 0..pp {
            for p in 0..n_patches {
                stack[p] = group[p * pp + coeff];
            }
            for p in n_patches..g_len {
                stack[p] = 0.0;
            }
            ihaar1d(&mut stack[..g_len]);
            for p in 0..n_patches {
                group[p * pp + coeff] = stack[p];
            }
        }
    }
    // Inverse 2D DCT on each patch
    for p in 0..n_patches {
        let mut block = [0f32; PATCH * PATCH];
        block.copy_from_slice(&group[p * pp..(p + 1) * pp]);
        idct2d(&mut block);
        group[p * pp..(p + 1) * pp].copy_from_slice(&block);
    }
}

// ─── Patch extraction ─────────────────────────────────────────────────────────

/// Extract a PATCH×PATCH patch from image at (row, col) with mirror padding.
fn extract_patch(img: &[f32], width: usize, height: usize, row: usize, col: usize)
    -> [f32; PATCH * PATCH]
{
    let mut out = [0f32; PATCH * PATCH];
    for pr in 0..PATCH {
        for pc in 0..PATCH {
            let r = mirror(row as isize + pr as isize, height);
            let c = mirror(col as isize + pc as isize, width);
            out[pr * PATCH + pc] = img[r * width + c];
        }
    }
    out
}

/// Mirror-clamp an index into [0, len).
fn mirror(i: isize, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    if i < 0 {
        let j = (-i - 1) as usize;
        j.min(len - 1)
    } else if (i as usize) >= len {
        let over = i as usize - len;
        (len - 1).saturating_sub(over)
    } else {
        i as usize
    }
}

/// Squared L2 distance between two patches, normalized by patch area.
fn patch_distance(a: &[f32; PATCH * PATCH], b: &[f32; PATCH * PATCH]) -> f32 {
    let pp = PATCH * PATCH;
    let mut s = 0f32;
    for i in 0..pp {
        let d = a[i] - b[i];
        s += d * d;
    }
    s / pp as f32
}

// ─── Block matching ───────────────────────────────────────────────────────────

/// Find up to `max_group` similar patches to reference at (ref_row, ref_col).
/// Sorted by (dist.to_bits(), row, col) for determinism.
fn block_match(
    img: &[f32],
    width: usize,
    height: usize,
    ref_row: usize,
    ref_col: usize,
    max_group: usize,
) -> Vec<(f32, usize, usize)> {
    let ref_patch = extract_patch(img, width, height, ref_row, ref_col);

    let row_min = ref_row.saturating_sub(SEARCH);
    let row_max = (ref_row + SEARCH).min(height.saturating_sub(PATCH));
    let col_min = ref_col.saturating_sub(SEARCH);
    let col_max = (ref_col + SEARCH).min(width.saturating_sub(PATCH));

    let mut candidates: Vec<(f32, usize, usize)> = Vec::new();
    for r in row_min..=row_max {
        for c in col_min..=col_max {
            let p = extract_patch(img, width, height, r, c);
            let dist = patch_distance(&ref_patch, &p);
            candidates.push((dist, r, c));
        }
    }

    // Deterministic sort: tie-break by (row, col) position
    candidates.sort_unstable_by(|a, b| {
        let da = a.0.to_bits();
        let db = b.0.to_bits();
        da.cmp(&db).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2))
    });

    candidates.truncate(max_group);
    candidates
}

// ─── Stage 1: Hard thresholding ──────────────────────────────────────────────

fn stage1_ref_patch(
    img: &[f32],
    width: usize,
    height: usize,
    ref_row: usize,
    ref_col: usize,
    sigma: f32,
    kaiser: &[f32; PATCH * PATCH],
    num: &mut [f32],
    den: &mut [f32],
) {
    let matches = block_match(img, width, height, ref_row, ref_col, GROUP1);
    let n_patches = matches.len().max(1);
    let pp = PATCH * PATCH;

    // Build group
    let mut group = vec![0f32; n_patches * pp];
    for (idx, &(_, r, c)) in matches.iter().enumerate() {
        let patch = extract_patch(img, width, height, r, c);
        group[idx * pp..(idx + 1) * pp].copy_from_slice(&patch);
    }

    // Transform
    transform_group(&mut group, n_patches);

    // Hard threshold + count NNZ
    let threshold = LAMBDA * sigma;
    let mut nnz = 0usize;
    for v in group.iter_mut() {
        if v.abs() < threshold {
            *v = 0.0;
        } else {
            nnz += 1;
        }
    }
    let weight = 1.0 / nnz.max(1) as f32;

    // Inverse transform
    itransform_group(&mut group, n_patches);

    // Accumulate into maps (only within image bounds)
    for (idx, &(_, r, c)) in matches.iter().enumerate() {
        let restored = &group[idx * pp..(idx + 1) * pp];
        for pr in 0..PATCH {
            let ir = r + pr;
            if ir >= height {
                continue;
            }
            for pc in 0..PATCH {
                let ic = c + pc;
                if ic >= width {
                    continue;
                }
                let k = kaiser[pr * PATCH + pc];
                let w = k * weight;
                num[ir * width + ic] += restored[pr * PATCH + pc] * w;
                den[ir * width + ic] += w;
            }
        }
    }
}

// ─── Stage 2: Wiener shrinkage ────────────────────────────────────────────────

fn stage2_ref_patch(
    img: &[f32],
    estimate: &[f32],
    width: usize,
    height: usize,
    ref_row: usize,
    ref_col: usize,
    sigma: f32,
    kaiser: &[f32; PATCH * PATCH],
    num: &mut [f32],
    den: &mut [f32],
) {
    let matches = block_match(img, width, height, ref_row, ref_col, GROUP2);
    let n_patches = matches.len().max(1);
    let pp = PATCH * PATCH;

    // Build noisy and estimate groups
    let mut noisy_group = vec![0f32; n_patches * pp];
    let mut est_group = vec![0f32; n_patches * pp];
    for (idx, &(_, r, c)) in matches.iter().enumerate() {
        let patch_noisy = extract_patch(img, width, height, r, c);
        let patch_est = extract_patch(estimate, width, height, r, c);
        noisy_group[idx * pp..(idx + 1) * pp].copy_from_slice(&patch_noisy);
        est_group[idx * pp..(idx + 1) * pp].copy_from_slice(&patch_est);
    }

    // Transform both groups
    transform_group(&mut noisy_group, n_patches);
    transform_group(&mut est_group, n_patches);

    // Wiener coefficients: w = |Y_hat|^2 / (|Y_hat|^2 + sigma^2)
    let sigma2 = sigma * sigma;
    let mut sum_w2 = 0f32;
    let mut filtered_group = vec![0f32; n_patches * pp];
    for i in 0..(n_patches * pp) {
        let y_hat2 = est_group[i] * est_group[i];
        let w = y_hat2 / (y_hat2 + sigma2);
        filtered_group[i] = w * noisy_group[i];
        sum_w2 += w * w;
    }
    let weight = 1.0 / sum_w2.max(1e-12);

    // Inverse transform
    itransform_group(&mut filtered_group, n_patches);

    // Accumulate: weight = 1/sum_w^2 * kaiser
    for (idx, &(_, r, c)) in matches.iter().enumerate() {
        let restored = &filtered_group[idx * pp..(idx + 1) * pp];
        for pr in 0..PATCH {
            let ir = r + pr;
            if ir >= height {
                continue;
            }
            for pc in 0..PATCH {
                let ic = c + pc;
                if ic >= width {
                    continue;
                }
                let k = kaiser[pr * PATCH + pc];
                let w = k * weight;
                num[ir * width + ic] += restored[pr * PATCH + pc] * w;
                den[ir * width + ic] += w;
            }
        }
    }
}

// ─── Tiled BM3D ──────────────────────────────────────────────────────────────

/// Process a halo-extended tile through both BM3D stages.
/// Returns (stage1_estimate, final_output), each `width_h × height_h`.
fn process_tile(
    tile_img: &[f32],
    width_h: usize,
    height_h: usize,
    sigma: f32,
    kaiser: &[f32; PATCH * PATCH],
) -> (Vec<f32>, Vec<f32>) {
    let n = width_h * height_h;
    // Initialize num with tile_img * epsilon so that pixels which receive zero patch
    // contributions (possible at image edges with large REF_STEP) fall back to the
    // input value rather than returning 0.
    let epsilon = 1e-12f32;
    let mut num1: Vec<f32> = tile_img.iter().map(|&v| v * epsilon).collect();
    let mut den1 = vec![epsilon; n];

    // Extend ref bounds beyond `width_h - PATCH` to ensure every pixel position is
    // visited as a reference. Patches that start near the boundary use mirror padding
    // in `extract_patch`; accumulation bounds-checks prevent out-of-bounds writes.
    let ref_row_end = height_h;
    let ref_col_end = width_h;

    // Stage 1
    let mut r = 0;
    while r < ref_row_end {
        let mut c = 0;
        while c < ref_col_end {
            stage1_ref_patch(
                tile_img, width_h, height_h, r, c, sigma, kaiser,
                &mut num1, &mut den1,
            );
            c += REF_STEP;
        }
        r += REF_STEP;
    }

    let stage1: Vec<f32> = num1.iter().zip(den1.iter()).map(|(n, d)| n / d).collect();

    // Stage 2
    let mut num2: Vec<f32> = tile_img.iter().map(|&v| v * epsilon).collect();
    let mut den2 = vec![epsilon; n];

    let mut r = 0;
    while r < ref_row_end {
        let mut c = 0;
        while c < ref_col_end {
            stage2_ref_patch(
                tile_img, &stage1, width_h, height_h, r, c, sigma, kaiser,
                &mut num2, &mut den2,
            );
            c += REF_STEP;
        }
        r += REF_STEP;
    }

    let final_out: Vec<f32> = num2.iter().zip(den2.iter()).map(|(n, d)| n / d).collect();
    (stage1, final_out)
}

/// Per-tile processing result.
struct TileResult {
    /// Tile position in the output grid.
    tile_row: usize,
    tile_col: usize,
    /// The inner (non-halo) denoised pixels.
    out_tile: Vec<f32>,
    /// Inner tile dimensions.
    t_rows: usize,
    t_cols: usize,
}

/// Extract a halo region, run BM3D on it, and return the inner result.
fn process_one_tile(
    input: &[f32],
    width: usize,
    height: usize,
    sigma: f32,
    kaiser: &[f32; PATCH * PATCH],
    tile_row: usize,
    tile_col: usize,
) -> TileResult {
    let row0 = tile_row * TILE;
    let col0 = tile_col * TILE;
    let t_rows = TILE.min(height.saturating_sub(row0));
    let t_cols = TILE.min(width.saturating_sub(col0));

    // Halo-extended bounds
    let h_row0 = row0.saturating_sub(HALO);
    let h_col0 = col0.saturating_sub(HALO);
    let h_row1 = (row0 + TILE + HALO).min(height);
    let h_col1 = (col0 + TILE + HALO).min(width);
    let width_h = h_col1 - h_col0;
    let height_h = h_row1 - h_row0;

    // Extract halo region
    let mut tile_img = vec![0f32; width_h * height_h];
    for r in 0..height_h {
        let src_r = h_row0 + r;
        for c in 0..width_h {
            let src_c = h_col0 + c;
            tile_img[r * width_h + c] = input[src_r * width + src_c];
        }
    }

    let (_, final_tile) = process_tile(&tile_img, width_h, height_h, sigma, kaiser);

    // Extract inner (non-halo) portion
    let inner_row_start = row0 - h_row0;
    let inner_col_start = col0 - h_col0;
    let mut out_tile = vec![0f32; t_rows * t_cols];
    for pr in 0..t_rows {
        for pc in 0..t_cols {
            let hr = inner_row_start + pr;
            let hc = inner_col_start + pc;
            out_tile[pr * t_cols + pc] = final_tile[hr * width_h + hc];
        }
    }

    TileResult { tile_row, tile_col, out_tile, t_rows, t_cols }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// BM3D denoiser — deterministic two-stage (hard threshold + Wiener).
///
/// # Arguments
/// * `input` — single-channel normalized image (row-major), already VST-applied.
/// * `width`, `height` — image dimensions.
/// * `sigma` — noise sigma in the stabilized domain (≈1.0 after proper VST).
///
/// # Returns
/// Denoised image, same dimensions as input.
pub fn bm3d_denoise(input: &[f32], width: usize, height: usize, sigma: f32) -> Vec<f32> {
    assert_eq!(input.len(), width * height);

    // Mirror-pad the input by PATCH pixels on each side to prevent boundary artifacts.
    // Without padding, BM3D produces artifacts at image edges because reference-patch
    // iteration stops PATCH pixels before the boundary, leaving edge pixels with few
    // accumulation contributions. The pad ensures every pixel is covered by at least
    // one reference. Always removed before returning.
    let pad = PATCH;
    let pw = width + 2 * pad;
    let ph = height + 2 * pad;
    let mut padded = vec![0f32; pw * ph];
    for pr in 0..ph {
        for pc in 0..pw {
            let sr = mirror(pr as isize - pad as isize, height);
            let sc = mirror(pc as isize - pad as isize, width);
            padded[pr * pw + pc] = input[sr * width + sc];
        }
    }

    let kaiser = kaiser2d();

    let tile_rows = (ph + TILE - 1) / TILE;
    let tile_cols = (pw + TILE - 1) / TILE;

    let tile_coords: Vec<(usize, usize)> = (0..tile_rows)
        .flat_map(|tr| (0..tile_cols).map(move |tc| (tr, tc)))
        .collect();

    // Process tiles in parallel — each tile is independent (reads from `padded`, writes to its
    // own TileResult). Output merge is sequential with no races.
    #[cfg(feature = "parallel")]
    let results: Vec<TileResult> = {
        use rayon::prelude::*;
        tile_coords
            .par_iter()
            .map(|&(tr, tc)| process_one_tile(&padded, pw, ph, sigma, &kaiser, tr, tc))
            .collect()
    };

    #[cfg(not(feature = "parallel"))]
    let results: Vec<TileResult> = tile_coords
        .iter()
        .map(|&(tr, tc)| process_one_tile(&padded, pw, ph, sigma, &kaiser, tr, tc))
        .collect();

    // Merge sequentially — output regions are non-overlapping
    let mut padded_out = vec![0f32; pw * ph];
    for r in results {
        let row0 = r.tile_row * TILE;
        let col0 = r.tile_col * TILE;
        for pr in 0..r.t_rows {
            for pc in 0..r.t_cols {
                let ir = row0 + pr;
                let ic = col0 + pc;
                if ir < ph && ic < pw {
                    padded_out[ir * pw + ic] = r.out_tile[pr * r.t_cols + pc];
                }
            }
        }
    }

    // Crop inner region (remove padding) to recover the original image size
    let mut output = vec![0f32; width * height];
    for r in 0..height {
        for c in 0..width {
            output[r * width + c] = padded_out[(r + pad) * pw + (c + pad)];
        }
    }

    output
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bessel_i0_at_zero_is_one() {
        let v = modified_bessel_i0(0.0);
        assert!((v - 1.0).abs() < 1e-5, "I0(0)={v}");
    }

    #[test]
    fn bessel_i0_monotone_positive() {
        // I0 is even and increasing for x >= 0
        let prev = modified_bessel_i0(0.0);
        for xi in 1..=20u32 {
            let x = xi as f32 * 0.5;
            let curr = modified_bessel_i0(x);
            assert!(curr >= prev, "I0 not monotone at x={x}");
        }
    }

    #[test]
    fn kaiser_window_sum_positive() {
        let w = kaiser_window(8, 2.0);
        let sum: f32 = w.iter().sum();
        assert!(sum > 0.0);
        assert_eq!(w.len(), 8);
    }

    #[test]
    fn dct_roundtrip() {
        let original = [
            0.1f32, 0.5, 0.3, 0.8, 0.2, 0.6, 0.4, 0.7,
            0.9, 0.1, 0.5, 0.3, 0.7, 0.2, 0.8, 0.4,
            0.3, 0.7, 0.1, 0.6, 0.5, 0.9, 0.2, 0.8,
            0.6, 0.4, 0.8, 0.2, 0.9, 0.3, 0.7, 0.1,
            0.2, 0.8, 0.6, 0.4, 0.1, 0.7, 0.5, 0.3,
            0.7, 0.3, 0.9, 0.1, 0.6, 0.4, 0.8, 0.2,
            0.4, 0.6, 0.2, 0.7, 0.3, 0.8, 0.1, 0.9,
            0.8, 0.2, 0.4, 0.9, 0.7, 0.1, 0.3, 0.6,
        ];
        let mut block = original;
        dct2d(&mut block);
        idct2d(&mut block);
        for (i, (&orig, &rec)) in original.iter().zip(block.iter()).enumerate() {
            assert!(
                (orig - rec).abs() < 1e-4,
                "DCT roundtrip error at {i}: orig={orig} rec={rec}"
            );
        }
    }

    #[test]
    fn haar_roundtrip() {
        let original = [1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        let mut x = original;
        haar1d(&mut x);
        ihaar1d(&mut x);
        for (i, (&orig, &rec)) in original.iter().zip(x.iter()).enumerate() {
            assert!((orig - rec).abs() < 1e-5, "Haar roundtrip error at {i}");
        }
    }

    #[test]
    fn next_pow2_values() {
        assert_eq!(next_pow2(1), 1);
        assert_eq!(next_pow2(2), 2);
        assert_eq!(next_pow2(3), 4);
        assert_eq!(next_pow2(16), 16);
        assert_eq!(next_pow2(17), 32);
    }

    #[test]
    fn mirror_indices() {
        assert_eq!(mirror(0, 10), 0);
        assert_eq!(mirror(9, 10), 9);
        assert_eq!(mirror(-1, 10), 0);
        assert_eq!(mirror(-2, 10), 1);
        assert_eq!(mirror(10, 10), 9);
        assert_eq!(mirror(11, 10), 8);
    }

    #[test]
    fn bm3d_flat_field_reduces_noise() {
        let width = 32;
        let height = 32;
        let true_val = 0.5f32;
        let sigma = 0.1f32;

        // xorshift32 PRNG (seed 9999) for deterministic noise
        let mut state = 9999u32;
        let noisy: Vec<f32> = (0..width * height)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                (true_val + sigma * (state as i32 as f32) / (i32::MAX as f32)).clamp(0.0, 1.0)
            })
            .collect();

        let denoised = bm3d_denoise(&noisy, width, height, sigma);

        let noisy_rms: f32 = noisy.iter().map(|&v| (v - true_val).powi(2)).sum::<f32>()
            / (width * height) as f32;
        let denoised_rms: f32 = denoised
            .iter()
            .map(|&v| (v - true_val).powi(2))
            .sum::<f32>()
            / (width * height) as f32;

        assert!(
            denoised_rms < noisy_rms,
            "BM3D did not reduce noise: denoised_rms={denoised_rms:.6} noisy_rms={noisy_rms:.6}"
        );
    }
}

