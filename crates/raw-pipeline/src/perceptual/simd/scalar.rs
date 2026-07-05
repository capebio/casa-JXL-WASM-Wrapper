//! Shared scalar tails for SIMD kernels. Called from avx2, avx512, and wasm
//! modules after their vectorised bulk passes exhaust aligned lanes.
//! No architecture gate — compiles on all targets.
// SpeedCodeReview ✓ 2026-06-19 · opus-4.8[1m] · sweeps=2 · Arch 2/0/1 Alg 2/0/0 Code 6/5/1 (x/y/z=found/green/red, +3 deferred)

/// scale_err scalar tail: accumulates `e2*sqrt(e2+eps)` from `i_start` to `n`
/// into `sum_in` (f64) and returns the updated sum. Callers pass the residual
/// from their SIMD horizontal reduction so the f64 precision is maintained
/// end-to-end (the SIMD acc is drained to f64 *before* calling this).
#[inline]
pub fn scale_err_tail(
    mask: &[f32],
    rx: &[f32],
    ry: &[f32],
    rb: &[f32],
    tx: &[f32],
    ty: &[f32],
    tb: &[f32],
    n: usize,
    kx: f32,
    ky: f32,
    kb: f32,
    i_start: usize,
    sum_in: f64,
) -> f64 {
    let mut i = i_start;
    let mut sum = sum_in;
    while i < n {
        let m = (mask[i] * 2.0 + 0.15).max(0.15);
        let inv = 1.0 / m;
        let ex = (rx[i] - tx[i]) * inv;
        let ey = (ry[i] - ty[i]) * inv;
        let eb = (rb[i] - tb[i]) * inv;
        let e2 = kx * ex * ex + ky * ey * ey + kb * eb * eb;
        sum += (e2 * (e2 + 1e-12_f32).sqrt()) as f64;
        i += 1;
    }
    sum
}

/// pixels_to_xyb scalar tail: converts RGBA pixels in `[i_start, n)` into planar
/// X/Y/B via a 256-entry sqrt-linear LUT. Called after SIMD gather exhausts lanes.
#[inline]
pub fn xyb_tail(
    px: &[u8],
    lut: &[f32; 256],
    n: usize,
    i_start: usize,
    x: &mut [f32],
    y: &mut [f32],
    b: &mut [f32],
) {
    let mut i = i_start;
    while i < n {
        let j = i * 4;
        let r = lut[px[j] as usize];
        let g = lut[px[j + 1] as usize];
        let bb = lut[px[j + 2] as usize];
        x[i] = (r - bb) * 0.5;
        y[i] = (r + bb) * 0.5 + g;
        b[i] = bb;
        i += 1;
    }
}

/// 2× box downsample scalar edge: handles output columns `[x_start, dw)` for a
/// single output row `dy`. Called after the vectorised inner loop exhausts full-width chunks.
#[inline]
pub fn downsample_row_tail(
    src: &[f32],
    w: usize,
    h: usize,
    dst_row: &mut [f32],
    dw: usize,
    dy: usize,
    x_start: usize,
) {
    let sy0 = dy << 1;
    let sy1 = if sy0 + 1 < h { sy0 + 1 } else { h - 1 };
    let mut x = x_start;
    while x < dw {
        let sx0 = x << 1;
        let sx1 = if sx0 + 1 < w { sx0 + 1 } else { w - 1 };
        dst_row[x] =
            (src[sy0 * w + sx0] + src[sy0 * w + sx1] + src[sy1 * w + sx0] + src[sy1 * w + sx1])
                * 0.25;
        x += 1;
    }
}
