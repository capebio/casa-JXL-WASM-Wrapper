//! wasm32 v128 SIMD kernels (4-wide f32). Mirrors the scalar oracle; verified
//! against the JS reference in Node (wasm intrinsics can't run under `cargo test`).
//! The whole module requires the build to enable `+simd128`.
#![cfg(target_arch = "wasm32")]
// SpeedCodeReview ✓ 2026-06-19 · opus-4.8[1m] · sweeps=2 · Arch 2/0/1 Alg 2/0/0 Code 6/5/1 (x/y/z=found/green/red, +3 deferred)

use super::scalar::{scale_err_tail, xyb_tail};
use core::arch::wasm32::*;

/// 4-wide horizontal sum.
#[inline]
fn hsum(v: v128) -> f32 {
    f32x4_extract_lane::<0>(v)
        + f32x4_extract_lane::<1>(v)
        + f32x4_extract_lane::<2>(v)
        + f32x4_extract_lane::<3>(v)
}

/// wasm v128 scale error (p=3). Strict full sqrt; mirrors scalar `scale_err`.
pub fn scale_err_wasm(
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
) -> f32 {
    // Guard n==0 before the `sum / n` divide below: 0.0/0.0 is NaN, whereas the
    // scalar oracle (butteraugli.rs) and the avx2/avx512 kernels all early-return
    // 0.0 for degenerate empty levels. Keep this path bit-consistent with them.
    if n == 0 {
        return 0.0;
    }
    // All seven slices are read via v128_load up to index `lanes < n` and indexed
    // up to `n-1` in the scalar tail. Use assert! (not debug_assert!) to match
    // avx2.rs:36-40 — WASM release builds ship as the primary production target and
    // must also be guarded so OOB reads are a defined panic, not silent UB.
    assert!(
        mask.len() >= n
            && rx.len() >= n
            && ry.len() >= n
            && rb.len() >= n
            && tx.len() >= n
            && ty.len() >= n
            && tb.len() >= n,
        "scale_err_wasm: a slice is shorter than n"
    );
    let vkx = f32x4_splat(kx);
    let vky = f32x4_splat(ky);
    let vkb = f32x4_splat(kb);
    let v2 = f32x4_splat(2.0);
    let v015 = f32x4_splat(0.15);
    let veps = f32x4_splat(1e-12);
    let one = f32x4_splat(1.0);
    let mut acc = f32x4_splat(0.0);
    // Drain f32 acc to f64 every 4096 SIMD iterations (16384 scalar values).
    // AVX2 uses 32768 scalar values per drain (4096 × 8-wide); both thresholds are
    // within f32 exact integer range for typical XYB error magnitudes. The count is
    // per-SIMD-iteration, not per-scalar-element, so the effective scalar counts differ by 2×.
    const FLUSH: usize = 4096;
    let mut flush_count = 0usize;
    let mut sum = 0f64;
    let lanes = n / 4 * 4;
    let mut i = 0;
    unsafe {
        while i < lanes {
            let m = v128_load(mask.as_ptr().add(i) as *const v128);
            let mm = f32x4_max(f32x4_add(f32x4_mul(m, v2), v015), v015);
            let inv = f32x4_div(one, mm);
            let ex = f32x4_mul(
                f32x4_sub(
                    v128_load(rx.as_ptr().add(i) as *const v128),
                    v128_load(tx.as_ptr().add(i) as *const v128),
                ),
                inv,
            );
            let ey = f32x4_mul(
                f32x4_sub(
                    v128_load(ry.as_ptr().add(i) as *const v128),
                    v128_load(ty.as_ptr().add(i) as *const v128),
                ),
                inv,
            );
            let eb = f32x4_mul(
                f32x4_sub(
                    v128_load(rb.as_ptr().add(i) as *const v128),
                    v128_load(tb.as_ptr().add(i) as *const v128),
                ),
                inv,
            );
            let e2 = f32x4_add(
                f32x4_add(
                    f32x4_mul(vkx, f32x4_mul(ex, ex)),
                    f32x4_mul(vky, f32x4_mul(ey, ey)),
                ),
                f32x4_mul(vkb, f32x4_mul(eb, eb)),
            );
            let root = f32x4_sqrt(f32x4_add(e2, veps));
            acc = f32x4_add(acc, f32x4_mul(e2, root));
            i += 4;
            flush_count += 1;
            if flush_count == FLUSH {
                sum += hsum(acc) as f64;
                acc = f32x4_splat(0.0);
                flush_count = 0;
            }
        }
    }
    sum += hsum(acc) as f64;
    sum = scale_err_tail(mask, rx, ry, rb, tx, ty, tb, n, kx, ky, kb, i, sum);
    // cbrt() is faster and more accurate than powf(1.0/3.0) (two transcendentals).
    ((sum / n as f64).cbrt()) as f32
}

/// Horizontal sum of four i32x4 lanes (all non-negative here) widened to u64.
/// Mirrors `avx2::hsum256i_u64`: uses `lane as u32 as u64` (unsigned widening) so a
/// future FLUSH_EVERY past the i32-safe ceiling cannot turn a wrapped-negative lane
/// into a huge u64.
#[inline]
fn hsum_i32x4_u64(v: v128) -> u64 {
    (i32x4_extract_lane::<0>(v) as u32 as u64)
        + (i32x4_extract_lane::<1>(v) as u32 as u64)
        + (i32x4_extract_lane::<2>(v) as u32 as u64)
        + (i32x4_extract_lane::<3>(v) as u32 as u64)
}

/// wasm v128 PSNR sum-of-squared-diffs over packed u8. Mirrors `avx2::ssd_avx2`;
/// returns the exact integer SSD, caller computes dB. Widens each 16-byte chunk to
/// two i16x8 halves, squares via `i32x4_dot_i16x8`, and drains the i32x4 accumulator
/// into u64 before any lane can overflow.
pub fn ssd_wasm(a: &[u8], b: &[u8]) -> u64 {
    // assert_eq! (not debug_assert_eq!) to match ssd_avx2 — mismatched buffers would
    // cause OOB SIMD reads in release builds (silent UB in WASM linear memory).
    assert_eq!(a.len(), b.len(), "ssd_wasm: buffers must have equal length");
    let len = a.len();
    // Each chunk feeds two dot products (low+high half) into the SAME i32x4 lanes;
    // each dot lane sums two products, so a lane gains up to 4·255² = 260100 per
    // chunk. i32 overflows after ⌊(2³¹−1)/260100⌋ ≈ 8256 chunks, so drain well under
    // that. 260100·8000 = 2.0808e9 < 2³¹−1 (2.1475e9), with margin. (Half the AVX2
    // ceiling: 4-wide → 2 dots/chunk vs AVX2's single 8-wide madd.)
    const FLUSH_EVERY: usize = 8000;
    let mut acc = i32x4_splat(0);
    let mut sum: u64 = 0;
    let chunks = len / 16 * 16;
    let mut i = 0;
    let mut since_flush = 0usize;
    unsafe {
        while i < chunks {
            let va = v128_load(a.as_ptr().add(i) as *const v128);
            let vb = v128_load(b.as_ptr().add(i) as *const v128);
            // Widen u8x16 → two i16x8 halves (|diff| ≤ 255 fits i16).
            let d_lo = i16x8_sub(i16x8_extend_low_u8x16(va), i16x8_extend_low_u8x16(vb));
            let d_hi = i16x8_sub(i16x8_extend_high_u8x16(va), i16x8_extend_high_u8x16(vb));
            // dot(d,d): adjacent i16 pairs multiplied and summed → i32x4 partial sums.
            acc = i32x4_add(acc, i32x4_dot_i16x8(d_lo, d_lo));
            acc = i32x4_add(acc, i32x4_dot_i16x8(d_hi, d_hi));
            i += 16;
            since_flush += 1;
            if since_flush == FLUSH_EVERY {
                sum += hsum_i32x4_u64(acc);
                acc = i32x4_splat(0);
                since_flush = 0;
            }
        }
    }
    sum += hsum_i32x4_u64(acc);
    while i < len {
        let d = a[i] as i64 - b[i] as i64;
        sum += (d * d) as u64;
        i += 1;
    }
    sum
}

/// wasm v128 separable box blur (radius `r`, clamp-to-edge) → fresh Vec.
/// BIT-IDENTICAL to `blur::box_blur` by construction: the horizontal pass is the
/// shared scalar `box_blur_h`, and the vertical pass runs the exact same
/// per-column float ops (`sums = tmp*(r+1)`, `+= tmp[row]`, store `sums*inv`,
/// `sums += add - sub`) 4 columns at a time in one `v128` — per-column op order
/// is unchanged (lane t == the scalar TILE slot for that column), only the
/// column-group width differs, and columns are fully independent, so every
/// f32 result is the same IEEE op sequence as the scalar oracle. The `x..w`
/// scalar remainder is verbatim `box_blur`.
///
/// This is the reference-mask blur (`blur_mask`), the dominant Comparer::new
/// cost — previously the only major perceptual kernel still scalar on
/// WasmSimd (native got `box_blur_avx2`, +13.7/11.3/30.1% at 1/6/24 MP; the
/// 4-wide v128 form targets the same win class over the SSE2-shaped scalar
/// tile the wasm build otherwise emits).
pub fn box_blur_wasm(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let n = w * h;
    if n == 0 {
        return Vec::new();
    }
    // assert! (not debug_assert!) matching scale_err_wasm — the v128 loads below
    // trust this bound and WASM release is the primary production target.
    assert!(src.len() >= n, "box_blur_wasm: src shorter than w*h");
    // tmp and dst are FULLY overwritten before any read (box_blur_h writes every
    // tmp element; the v128 pass + scalar remainder write every dst element), so
    // vec![0f32; n] would be 2·n·4 B of dead memset — and on the wasm dlmalloc
    // heap (which memsets on reuse, unlike fresh native pages) that cost is real.
    // SAFETY: f32 has no invalid bit patterns; every slot exposed by set_len is
    // written before it is read; f32 has no Drop. Same pattern as box_blur /
    // box_blur_avx2.
    let mut tmp: Vec<f32> = Vec::with_capacity(n);
    let mut dst: Vec<f32> = Vec::with_capacity(n);
    unsafe {
        tmp.set_len(n);
        dst.set_len(n);
    }
    let inv = 1.0 / (2 * r + 1) as f32;

    // Horizontal pass: shared scalar recurrence (identical to box_blur).
    crate::perceptual::blur::box_blur_h(src, &mut tmp, w, h, r, inv);

    // Vertical pass: 4 columns per iteration in one v128 lane group.
    let rp1 = f32x4_splat(r as f32 + 1.0);
    let inv_v = f32x4_splat(inv);
    let h_max = h - 1;
    let tp = tmp.as_ptr();
    let dp = dst.as_mut_ptr();
    let mut x = 0usize;
    // SAFETY: every load/store below is bounded by row.min(h_max)*w + x + 4 <=
    // (h-1)*w + w = n while x + 4 <= w (v128_load/store carry no alignment
    // requirement in wasm).
    unsafe {
        while x + 4 <= w {
            // seed the window: tmp[x..x+4]*(r+1) + Σ_{k=1..=r} tmp[k.min(h_max)*w + x..]
            let mut sums = f32x4_mul(v128_load(tp.add(x) as *const v128), rp1);
            for k in 1..=r {
                let row = k.min(h_max) * w;
                sums = f32x4_add(sums, v128_load(tp.add(row + x) as *const v128));
            }
            for y in 0..h {
                let drow = y * w;
                v128_store(dp.add(drow + x) as *mut v128, f32x4_mul(sums, inv_v));
                let add_row = (y + r + 1).min(h_max) * w;
                let sub_row = y.saturating_sub(r) * w;
                let add = v128_load(tp.add(add_row + x) as *const v128);
                let sub = v128_load(tp.add(sub_row + x) as *const v128);
                sums = f32x4_add(sums, f32x4_sub(add, sub));
            }
            x += 4;
        }
    }
    // Scalar remainder for the < 4 trailing columns — identical to box_blur.
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
    dst
}

/// Drain lanes 0/1/2/3 (R,G,B,A) of an i32x4 partial into a u64[4] accumulator.
/// The alpha lane was always accumulated in the vector register; keeping it
/// (instead of discarding at drain time) lets `Comparer::all()` derive the PSNR
/// SSD from these sums and skip its whole test+ref traversal.
/// Unsigned `as u32 as u64` widen for the same reason as ssd.
#[inline]
fn drain4(v: v128, acc: &mut [u64; 4]) {
    acc[0] += i32x4_extract_lane::<0>(v) as u32 as u64;
    acc[1] += i32x4_extract_lane::<1>(v) as u32 as u64;
    acc[2] += i32x4_extract_lane::<2>(v) as u32 as u64;
    acc[3] += i32x4_extract_lane::<3>(v) as u32 as u64;
}

/// wasm v128 SSIM moment accumulation over RGBA test+ref. Returns per-channel
/// (sa, saa, sab) for c in 0..4 (RGBA) — same contract as `avx2::ssim_moments_avx2`.
///
/// Strategy: channel-as-lane. Each pixel's [R,G,B,A] occupies one i32x4, so the
/// three independent products (a, a*a, a*b) are computed for all channels in one
/// vector op each — no deinterleave (which is what made the AVX2 SIMD attempt a
/// wash). i32x4 partials drain to u64 every FLUSH pixels before saa/sab (≤255² per
/// pixel) can overflow i32. NOTE: x86 keeps the scalar moments — this v128 path is
/// only worth selecting if the wasm bench shows a real win (see bench-wasm).
pub fn ssim_moments_wasm(a: &[u8], b: &[u8], np: usize) -> ([u64; 4], [u64; 4], [u64; 4]) {
    // assert! (not debug_assert!) to match ssim_moments_avx2 — a short buffer would
    // OOB the v128_load32_zero in a release WASM build (silent UB).
    assert!(
        a.len() / 4 >= np && b.len() / 4 >= np,
        "ssim_moments_wasm: a.len() and b.len() must be >= np*4"
    );
    let mut sa = [0u64; 4];
    let mut saa = [0u64; 4];
    let mut sab = [0u64; 4];
    let mut va = i32x4_splat(0);
    let mut vaa = i32x4_splat(0);
    let mut vab = i32x4_splat(0);
    // saa/sab lanes gain ≤255² = 65025 per pixel; i32 overflows after
    // ⌊(2³¹−1)/65025⌋ ≈ 33025 pixels. 32000·65025 = 2.0808e9 < 2³¹−1, with margin.
    const FLUSH: usize = 32000;
    let mut fc = 0usize;
    unsafe {
        let mut p = 0;
        while p < np {
            let j = p * 4;
            // Load the 4 channel bytes into the low i32 lane, then widen u8→u16→u32
            // so each channel sits in its own i32x4 lane: [R, G, B, A].
            let av = u32x4_extend_low_u16x8(u16x8_extend_low_u8x16(v128_load32_zero(
                a.as_ptr().add(j) as *const u32,
            )));
            let bv = u32x4_extend_low_u16x8(u16x8_extend_low_u8x16(v128_load32_zero(
                b.as_ptr().add(j) as *const u32,
            )));
            va = i32x4_add(va, av);
            vaa = i32x4_add(vaa, i32x4_mul(av, av));
            vab = i32x4_add(vab, i32x4_mul(av, bv));
            p += 1;
            fc += 1;
            if fc == FLUSH {
                drain4(va, &mut sa);
                drain4(vaa, &mut saa);
                drain4(vab, &mut sab);
                va = i32x4_splat(0);
                vaa = i32x4_splat(0);
                vab = i32x4_splat(0);
                fc = 0;
            }
        }
    }
    drain4(va, &mut sa);
    drain4(vaa, &mut saa);
    drain4(vab, &mut sab);
    (sa, saa, sab)
}

/// wasm v128 RGBA→planar XYB. Scalar LUT loads (no wasm gather) + vector arithmetic.
pub fn pixels_to_xyb_wasm(
    px: &[u8],
    n: usize,
    lut: &[f32; 256],
    x: &mut [f32],
    y: &mut [f32],
    b: &mut [f32],
) {
    // Reads px via get_unchecked up to (n-1)*4+2 and v128_store/index x/y/b up to
    // n-1. Use assert! (not debug_assert!) to match avx2.rs:210-213 — WASM release
    // builds are the primary production target and must be guarded so OOB reads via
    // get_unchecked are a defined panic, not silent UB in WASM linear memory.
    assert!(
        px.len() / 4 >= n && x.len() >= n && y.len() >= n && b.len() >= n,
        "pixels_to_xyb_wasm: px shorter than n*4 or an output plane shorter than n"
    );
    let half = f32x4_splat(0.5);
    let lanes = n / 4 * 4;
    let mut i = 0;
    unsafe {
        while i < lanes {
            let mut r = [0f32; 4];
            let mut g = [0f32; 4];
            let mut bb = [0f32; 4];
            for l in 0..4 {
                let j = (i + l) * 4;
                r[l] = lut[*px.get_unchecked(j) as usize];
                g[l] = lut[*px.get_unchecked(j + 1) as usize];
                bb[l] = lut[*px.get_unchecked(j + 2) as usize];
            }
            let rv = v128_load(r.as_ptr() as *const v128);
            let gv = v128_load(g.as_ptr() as *const v128);
            let bv = v128_load(bb.as_ptr() as *const v128);
            v128_store(
                x.as_mut_ptr().add(i) as *mut v128,
                f32x4_mul(f32x4_sub(rv, bv), half),
            );
            v128_store(
                y.as_mut_ptr().add(i) as *mut v128,
                f32x4_add(f32x4_mul(f32x4_add(rv, bv), half), gv),
            );
            v128_store(b.as_mut_ptr().add(i) as *mut v128, bv);
            i += 4;
        }
    }
    // Use the shared scalar tail (same as AVX2/AVX-512 paths) to avoid
    // divergence if the XYB formula ever changes. The inline version was
    // byte-identical but not linked to the canonical implementation.
    xyb_tail(px, lut, n, i, x, y, b);
}

/// wasm v128 2× box downsample. Kept scalar: the 4-wide even/odd deinterleave
/// overhead rarely beats scalar at this width; the Node flip-flop (Task D2) can
/// revisit if profiling warrants.
pub fn downsample_wasm(src: &[f32], dst: &mut [f32], w: usize, h: usize, dw: usize, dh: usize) {
    // v128 box 2x: 4 outputs (8 src cols) per row via even/odd shuffle + add, both
    // rows, *0.25. node WASM-SIMD measured ~60-65% over the scalar nested loop at
    // 1024²/2048² (maxdiff 5.96e-8 — pure f32 add-association, well under the 1e-5
    // oracle tolerance). The scalar tail handles leftover outputs and the odd
    // width/height edge clamp identically to the old scalar form.
    // Length guard mirrors scale_err_wasm: WASM ships as the primary target, so an
    // OOB read/write must be a defined panic, not silent UB.
    assert!(
        src.len() >= w.saturating_mul(h) && dst.len() >= dw.saturating_mul(dh),
        "downsample_wasm: src/dst shorter than w*h / dw*dh"
    );
    let quarter = f32x4_splat(0.25);
    for y in 0..dh {
        let sy0 = y << 1;
        // Use if-form instead of `.min(h - 1)` to avoid usize underflow when h==0.
        let sy1 = if sy0 + 1 < h { sy0 + 1 } else { sy0 };
        let r0 = sy0 * w;
        let r1 = sy1 * w;
        let mut x = 0usize;
        // Bulk: while the 4-output block's last source column (2x+7) is in-bounds.
        unsafe {
            while (x + 4) * 2 <= w {
                let o0 = r0 + (x << 1);
                let a0 = v128_load(src.as_ptr().add(o0) as *const v128);
                let b0 = v128_load(src.as_ptr().add(o0 + 4) as *const v128);
                let s0 = f32x4_add(
                    u32x4_shuffle::<0, 2, 4, 6>(a0, b0),
                    u32x4_shuffle::<1, 3, 5, 7>(a0, b0),
                );
                let o1 = r1 + (x << 1);
                let a1 = v128_load(src.as_ptr().add(o1) as *const v128);
                let b1 = v128_load(src.as_ptr().add(o1 + 4) as *const v128);
                let s1 = f32x4_add(
                    u32x4_shuffle::<0, 2, 4, 6>(a1, b1),
                    u32x4_shuffle::<1, 3, 5, 7>(a1, b1),
                );
                let res = f32x4_mul(f32x4_add(s0, s1), quarter);
                v128_store(dst.as_mut_ptr().add(y * dw + x) as *mut v128, res);
                x += 4;
            }
        }
        // Scalar tail: leftover outputs incl. odd-width clamp (avoid w-1 underflow when w==0).
        while x < dw {
            let sx0 = x << 1;
            let sx1 = if sx0 + 1 < w { sx0 + 1 } else { sx0 };
            dst[y * dw + x] =
                (src[r0 + sx0] + src[r0 + sx1] + src[r1 + sx0] + src[r1 + sx1]) * 0.25;
            x += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::perceptual::butteraugli::dn2;

    /// Parity test: downsample_wasm must produce the same result as the scalar oracle (dn2).
    /// downsample_wasm now uses v128 intrinsics, so this only executes under a wasm test
    /// runner (the whole module is `#![cfg(target_arch = "wasm32")]`). The v128/scalar
    /// agreement was also measured in node (maxdiff 5.96e-8 < the 1e-5 tolerance here).
    #[test]
    fn downsample_wasm_matches_dn2() {
        for (w, h) in [(64usize, 48usize), (65, 49), (2, 2), (33, 17)] {
            let src: Vec<f32> = (0..w * h).map(|i| (i as f32 * 0.013).sin()).collect();
            let (want, dw, dh) = dn2(&src, w, h);
            let mut got = vec![0f32; dw * dh];
            downsample_wasm(&src, &mut got, w, h, dw, dh);
            for i in 0..dw * dh {
                assert!(
                    (want[i] - got[i]).abs() < 1e-5,
                    "({w}x{h})[{i}] want={} got={}",
                    want[i],
                    got[i]
                );
            }
        }
    }
}
