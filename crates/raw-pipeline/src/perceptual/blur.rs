//! Separable O(n) box blur, clamp-to-edge. Port of the JS `boxBlur`.

/// Horizontal box-blur pass: `src` (w×h) → `tmp`, sliding window radius `r`,
/// clamp-to-edge, scaled by `inv = 1/(2r+1)`. Extracted so the AVX2 vertical
/// kernel (`simd::avx2::box_blur_avx2`) can share the identical horizontal pass
/// — the H pass is a per-row scalar recurrence (sequential `sum += add - sub`),
/// so it stays scalar in every backend; only the column-parallel V pass vectorises.
pub(crate) fn box_blur_h(src: &[f32], tmp: &mut [f32], w: usize, h: usize, r: usize, inv: f32) {
    let w_max = w - 1;
    for y in 0..h {
        let base = y * w;
        let mut sum = src[base] * (r as f32 + 1.0);
        for k in 1..=r {
            sum += src[base + k.min(w_max)];
        }
        for x in 0..w {
            tmp[base + x] = sum * inv;
            let add = src[base + (x + r + 1).min(w_max)];
            let sub = src[base + x.saturating_sub(r)];
            sum += add - sub;
        }
    }
}

/// Box blur of `src` (w×h) with radius `r` into a fresh Vec. Scalar path +
/// parity oracle for `box_blur_avx2`.
pub(crate) fn box_blur(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let n = w * h;
    // Zero-extent plane is a no-op: with w==0 (or h==0) the passes would index
    // an empty buffer (src[0]) and underflow `w - 1`/`h - 1` to usize::MAX.
    if n == 0 {
        return Vec::new();
    }
    let mut tmp = vec![0f32; n];
    let mut dst = vec![0f32; n];
    let inv = 1.0 / (2 * r + 1) as f32;

    box_blur_h(src, &mut tmp, w, h, r, inv);

    // Vertical: process TILE columns at a time to improve cache locality.
    // The naive column-by-column loop accesses memory at stride w (up to 16 KB
    // per step at w=4096), thrashing L1. Tiling processes TILE adjacent columns
    // together so each y-step reads/writes TILE consecutive floats — reducing
    // cache-line evictions by TILE×.
    const TILE: usize = 8;
    let h_max = h - 1;
    let mut x = 0usize;
    while x + TILE <= w {
        let mut sums = [0f32; TILE];
        for t in 0..TILE {
            sums[t] = tmp[x + t] * (r as f32 + 1.0);
        }
        for k in 1..=r {
            let row = k.min(h_max) * w;
            for t in 0..TILE {
                sums[t] += tmp[row + x + t];
            }
        }
        for y in 0..h {
            let drow = y * w;
            for t in 0..TILE {
                dst[drow + x + t] = sums[t] * inv;
            }
            let add_row = (y + r + 1).min(h_max) * w;
            let sub_row = y.saturating_sub(r) * w;
            for t in 0..TILE {
                sums[t] += tmp[add_row + x + t] - tmp[sub_row + x + t];
            }
        }
        x += TILE;
    }
    // Scalar remainder for columns that don't fill a full tile.
    for col in x..w {
        let mut sum = tmp[col] * (r as f32 + 1.0);
        for k in 1..=r {
            sum += tmp[k.min(h - 1) * w + col];
        }
        for y in 0..h {
            dst[y * w + col] = sum * inv;
            let add = tmp[(y + r + 1).min(h - 1) * w + col];
            let sub = tmp[y.saturating_sub(r) * w + col];
            sum += add - sub;
        }
    }

    dst
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_field_is_preserved() {
        let w = 8; let h = 6;
        let src = vec![3.5f32; w * h];
        let out = box_blur(&src, w, h, 2);
        for v in out {
            assert!((v - 3.5).abs() < 1e-4);
        }
    }

    #[test]
    fn radius_one_averages_neighbors_interior() {
        // 1-row impulse, interior pixel should be (0+9+0)/3 = 3 after H pass only;
        // with H+V on a single row, V pass clamps to itself → stays.
        let w = 5; let h = 1;
        let mut src = vec![0f32; w];
        src[2] = 9.0;
        let out = box_blur(&src, w, h, 1);
        assert!((out[2] - 3.0).abs() < 1e-4, "got {}", out[2]);
        assert!((out[1] - 3.0).abs() < 1e-4, "got {}", out[1]);
    }
}
