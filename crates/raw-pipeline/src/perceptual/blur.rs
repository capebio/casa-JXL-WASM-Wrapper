//! Separable O(n) box blur, clamp-to-edge. Port of the JS `boxBlur`.

/// Horizontal box-blur pass: `src` (w×h) → `tmp`, sliding window radius `r`,
/// clamp-to-edge, scaled by `inv = 1/(2r+1)`. Extracted so the AVX2 vertical
/// kernel (`simd::avx2::box_blur_avx2`) can share the identical horizontal pass
/// — the H pass is a per-row scalar recurrence (sequential `sum += add - sub`),
/// so it stays scalar in every backend; only the column-parallel V pass vectorises.
pub(crate) fn box_blur_h(src: &[f32], tmp: &mut [f32], w: usize, h: usize, r: usize, inv: f32) {
    // Per-row kernel: the sliding-window recurrence is sequential within a row,
    // but rows are fully independent — identical math whether rows run serial
    // or parallel, so the parallel path below is byte-exact by construction.
    let row_pass = |y: usize, out_row: &mut [f32]| {
        let w_max = w - 1;
        let base = y * w;
        let mut sum = src[base] * (r as f32 + 1.0);
        for k in 1..=r {
            sum += src[base + k.min(w_max)];
        }
        for x in 0..w {
            out_row[x] = sum * inv;
            let add = src[base + (x + r + 1).min(w_max)];
            let sub = src[base + x.saturating_sub(r)];
            sum += add - sub;
        }
    };
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        // Row-parallel H pass. Measured via examples/box_blur_h_par_flip.rs
        // (see header there for numbers); rows chunked by rayon, one output
        // row per task, no shared mutable state.
        let _ = h;
        tmp.par_chunks_mut(w)
            .enumerate()
            .for_each(|(y, row)| row_pass(y, row));
    }
    #[cfg(not(feature = "parallel"))]
    {
        for (y, row) in tmp.chunks_mut(w).enumerate().take(h) {
            row_pass(y, row);
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
    // tmp and dst are FULLY overwritten before any read (box_blur_h writes every
    // tmp element; the tiled V pass + scalar remainder write every dst element),
    // so vec![0f32; n] would be 2·n·4 B of dead memset. Same pattern as
    // box_blur_avx2.
    // SAFETY: f32 has no invalid bit patterns; every slot exposed by set_len is
    // written before it is read, and f32 has no Drop, so leaking uninit on
    // panic is sound.
    let mut tmp: Vec<f32> = Vec::with_capacity(n);
    let mut dst: Vec<f32> = Vec::with_capacity(n);
    unsafe {
        tmp.set_len(n);
        dst.set_len(n);
    }
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
        let w = 8;
        let h = 6;
        let src = vec![3.5f32; w * h];
        let out = box_blur(&src, w, h, 2);
        for v in out {
            assert!((v - 3.5).abs() < 1e-4);
        }
    }

    /// Native proxy for `simd::wasm::box_blur_wasm` (which only compiles on
    /// wasm32): emulates its vertical pass exactly — 4-column groups with the
    /// same per-column op order (`[f32;4]` lanes ≙ one v128), `x+4<=w` boundary,
    /// verbatim scalar remainder — and asserts BIT-identical output vs
    /// `box_blur` (TILE=8). Locks the kernel's core claim: per-column op order
    /// is width-independent, so any column-group width is bit-exact.
    #[test]
    fn four_wide_column_groups_bit_identical_to_box_blur() {
        for (w, h, r) in [(37usize, 23usize, 3usize), (16, 16, 1), (5, 9, 8), (129, 31, 2)] {
            let n = w * h;
            let mut src = vec![0f32; n];
            let mut s: u32 = 0x1234_5678;
            for v in &mut src {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *v = (s >> 8) as f32 / 65_536.0;
            }
            let oracle = box_blur(&src, w, h, r);

            // 4-wide emulation of box_blur_wasm's V pass.
            let inv = 1.0 / (2 * r + 1) as f32;
            let mut tmp = vec![0f32; n];
            box_blur_h(&src, &mut tmp, w, h, r, inv);
            let mut dst = vec![0f32; n];
            let h_max = h - 1;
            let mut x = 0usize;
            while x + 4 <= w {
                let mut sums = [0f32; 4];
                for t in 0..4 {
                    sums[t] = tmp[x + t] * (r as f32 + 1.0);
                }
                for k in 1..=r {
                    let row = k.min(h_max) * w;
                    for t in 0..4 {
                        sums[t] += tmp[row + x + t];
                    }
                }
                for y in 0..h {
                    let drow = y * w;
                    for t in 0..4 {
                        dst[drow + x + t] = sums[t] * inv;
                    }
                    let add_row = (y + r + 1).min(h_max) * w;
                    let sub_row = y.saturating_sub(r) * w;
                    for t in 0..4 {
                        sums[t] += tmp[add_row + x + t] - tmp[sub_row + x + t];
                    }
                }
                x += 4;
            }
            for col in x..w {
                let mut sum = tmp[col] * (r as f32 + 1.0);
                for k in 1..=r {
                    sum += tmp[k.min(h_max) * w + col];
                }
                for y in 0..h {
                    dst[y * w + col] = sum * inv;
                    let add = tmp[(y + r + 1).min(h_max) * w + col];
                    let sub = tmp[y.saturating_sub(r) * w + col];
                    sum += add - sub;
                }
            }

            for (i, (a, b)) in oracle.iter().zip(&dst).enumerate() {
                assert_eq!(
                    a.to_bits(),
                    b.to_bits(),
                    "bit mismatch at {i} for {w}x{h} r={r}"
                );
            }
        }
    }

    #[test]
    fn radius_one_averages_neighbors_interior() {
        // 1-row impulse, interior pixel should be (0+9+0)/3 = 3 after H pass only;
        // with H+V on a single row, V pass clamps to itself → stays.
        let w = 5;
        let h = 1;
        let mut src = vec![0f32; w];
        src[2] = 9.0;
        let out = box_blur(&src, w, h, 1);
        assert!((out[2] - 3.0).abs() < 1e-4, "got {}", out[2]);
        assert!((out[1] - 3.0).abs() < 1e-4, "got {}", out[1]);
    }
}
