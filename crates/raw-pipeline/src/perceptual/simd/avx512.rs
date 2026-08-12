//! AVX-512 implementations (f32x16). Mirrors the AVX2 module at 2× width, with
//! the fast `vgatherdps` that motivates this path on server CPUs.
//!
//! NOT executed on the dev machine (i7-10850H lacks AVX-512); the parity tests
//! below skip unless `avx512f`+`avx512bw` are detected. Each public fn is `unsafe`
//! and must only be called after `detect_native` confirmed AVX-512.

#![cfg(target_arch = "x86_64")]
// SpeedCodeReview ✓ 2026-06-19 · opus-4.8[1m] · sweeps=2 · Arch 2/0/1 Alg 2/0/0 Code 6/5/1 (x/y/z=found/green/red, +3 deferred)

use super::scalar::{downsample_row_tail, scale_err_tail, xyb_tail};
use core::arch::x86_64::*;

/// Drain a 16-lane i32 partial ([R,G,B,A]×4 pixels) into a per-channel u64[4]:
/// lanes {0,4,8,12}→R, {1,5,9,13}→G, {2,6,10,14}→B, {3,7,11,15}→A. The alpha
/// lanes were always accumulated in the vector registers; keeping them lets
/// `Comparer::all()` derive the PSNR SSD from these sums and skip its pass.
/// Unsigned `as u32 as u64` widen, same guard rationale as `hsum256i_u64`.
#[inline]
unsafe fn drain16_rgba(v: __m512i, acc: &mut [u64; 4]) {
    let mut t = [0i32; 16];
    _mm512_storeu_si512(t.as_mut_ptr() as *mut __m512i, v);
    for k in 0..4 {
        acc[0] += t[k * 4] as u32 as u64;
        acc[1] += t[k * 4 + 1] as u32 as u64;
        acc[2] += t[k * 4 + 2] as u32 as u64;
        acc[3] += t[k * 4 + 3] as u32 as u64;
    }
}

/// AVX-512 strict scale error (p=3). `rsqrt_path` swaps `1/m` and `sqrt(e2)` for
/// refined rcp14/rsqrt14 approximations. Mirrors `avx2::scale_err_avx2`.
#[target_feature(enable = "avx512f")]
pub unsafe fn scale_err_avx512(
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
    rsqrt_path: bool,
) -> f32 {
    // All seven slices are read via _mm512_loadu_ps up to index `lanes < n` and
    // indexed up to `n-1` in the scalar tail. Use assert! (not debug_assert!) to
    // match avx2.rs:36-40 — release builds on AVX-512 hardware must also be guarded
    // so an OOB read in an unsafe function is a defined panic, not silent UB.
    if n == 0 {
        return 0.0;
    }
    assert!(
        mask.len() >= n
            && rx.len() >= n
            && ry.len() >= n
            && rb.len() >= n
            && tx.len() >= n
            && ty.len() >= n
            && tb.len() >= n,
        "scale_err_avx512: a slice is shorter than n"
    );
    let vkx = _mm512_set1_ps(kx);
    let vky = _mm512_set1_ps(ky);
    let vkb = _mm512_set1_ps(kb);
    let v2 = _mm512_set1_ps(2.0);
    let v015 = _mm512_set1_ps(0.15);
    let veps = _mm512_set1_ps(1e-12);
    let vone = _mm512_set1_ps(1.0);
    let half = _mm512_set1_ps(0.5);
    let threehalf = _mm512_set1_ps(1.5);
    let mut acc = _mm512_setzero_ps();
    // Drain the f32 lane accumulator to f64 every FLUSH iterations — same strategy
    // as avx2.rs — prevents f32 precision loss at > ~4096 accumulated values.
    const FLUSH: usize = 4096;
    let mut flush_count = 0usize;
    let mut sum = 0f64;

    let lanes = n / 16 * 16;
    let mut i = 0;
    while i < lanes {
        let m = _mm512_loadu_ps(mask.as_ptr().add(i));
        let mm = _mm512_max_ps(_mm512_fmadd_ps(m, v2, v015), v015);
        let inv = if rsqrt_path {
            // rcp14(mm) refined one Newton step: r1 = r0 * (2 - mm*r0)
            let r0 = _mm512_rcp14_ps(mm);
            _mm512_mul_ps(r0, _mm512_fnmadd_ps(mm, r0, v2))
        } else {
            _mm512_div_ps(vone, mm)
        };
        let ex = _mm512_mul_ps(
            _mm512_sub_ps(
                _mm512_loadu_ps(rx.as_ptr().add(i)),
                _mm512_loadu_ps(tx.as_ptr().add(i)),
            ),
            inv,
        );
        let ey = _mm512_mul_ps(
            _mm512_sub_ps(
                _mm512_loadu_ps(ry.as_ptr().add(i)),
                _mm512_loadu_ps(ty.as_ptr().add(i)),
            ),
            inv,
        );
        let eb = _mm512_mul_ps(
            _mm512_sub_ps(
                _mm512_loadu_ps(rb.as_ptr().add(i)),
                _mm512_loadu_ps(tb.as_ptr().add(i)),
            ),
            inv,
        );
        let mut e2 = _mm512_mul_ps(vkx, _mm512_mul_ps(ex, ex));
        e2 = _mm512_fmadd_ps(vky, _mm512_mul_ps(ey, ey), e2);
        e2 = _mm512_fmadd_ps(vkb, _mm512_mul_ps(eb, eb), e2);
        let root = if rsqrt_path {
            let z = _mm512_add_ps(e2, veps);
            let y0 = _mm512_rsqrt14_ps(z);
            let y1 = _mm512_mul_ps(
                y0,
                _mm512_fnmadd_ps(_mm512_mul_ps(half, z), _mm512_mul_ps(y0, y0), threehalf),
            );
            _mm512_mul_ps(z, y1)
        } else {
            _mm512_sqrt_ps(_mm512_add_ps(e2, veps))
        };
        acc = _mm512_fmadd_ps(e2, root, acc);
        i += 16;
        flush_count += 1;
        if flush_count == FLUSH {
            sum += _mm512_reduce_add_ps(acc) as f64;
            acc = _mm512_setzero_ps();
            flush_count = 0;
        }
    }
    sum += _mm512_reduce_add_ps(acc) as f64;
    sum = scale_err_tail(mask, rx, ry, rb, tx, ty, tb, n, kx, ky, kb, i, sum);
    // cbrt() is a dedicated cube-root: faster and more accurate than powf(1.0/3.0)
    // which internally uses exp(log(x)*exponent) — two transcendentals.
    ((sum / n as f64).cbrt()) as f32
}

/// AVX-512 RGBA(u8) → planar X/Y/B via 16-wide `vgatherdps` over the sqrt-linear
/// LUT. This is the fast-gather path that motivates AVX-512 here.
#[target_feature(enable = "avx512f")]
pub unsafe fn pixels_to_xyb_avx512(
    px: &[u8],
    n: usize,
    lut: &[f32; 256],
    x: &mut [f32],
    y: &mut [f32],
    b: &mut [f32],
) {
    // px is read at indices up to (n-1)*4 + 2 (RGBA stride); x/y/b are written up
    // to n-1. Use assert! (not debug_assert!) to match avx2.rs:210-213 — release
    // builds must be guarded so OOB via get_unchecked is a defined panic, not UB.
    assert!(
        px.len() / 4 >= n && x.len() >= n && y.len() >= n && b.len() >= n,
        "pixels_to_xyb_avx512: px or an output plane is shorter than required for n"
    );
    let half = _mm512_set1_ps(0.5);
    let lanes = n / 16 * 16;
    let mut i = 0;
    while i < lanes {
        let mut ri = [0i32; 16];
        let mut gi = [0i32; 16];
        let mut bi = [0i32; 16];
        for l in 0..16 {
            let base = (i + l) * 4;
            ri[l] = *px.get_unchecked(base) as i32;
            gi[l] = *px.get_unchecked(base + 1) as i32;
            bi[l] = *px.get_unchecked(base + 2) as i32;
        }
        let lp = lut.as_ptr();
        let r = _mm512_i32gather_ps::<4>(_mm512_loadu_si512(ri.as_ptr() as *const __m512i), lp);
        let g = _mm512_i32gather_ps::<4>(_mm512_loadu_si512(gi.as_ptr() as *const __m512i), lp);
        let bb = _mm512_i32gather_ps::<4>(_mm512_loadu_si512(bi.as_ptr() as *const __m512i), lp);
        _mm512_storeu_ps(
            x.as_mut_ptr().add(i),
            _mm512_mul_ps(_mm512_sub_ps(r, bb), half),
        );
        _mm512_storeu_ps(
            y.as_mut_ptr().add(i),
            _mm512_fmadd_ps(_mm512_add_ps(r, bb), half, g),
        );
        _mm512_storeu_ps(b.as_mut_ptr().add(i), bb);
        i += 16;
    }
    // lut is a plain &[f32; 256] — shared with the scalar tail directly, no cast.
    xyb_tail(px, lut, n, i, x, y, b);
}

/// AVX-512 2× box downsample (16 output px/iter interior, scalar edge). Uses
/// `permutex2var_ps` to split 32 contiguous src floats into even (sx0) / odd (sx1).
#[target_feature(enable = "avx512f")]
pub unsafe fn downsample_avx512(
    src: &[f32],
    dst: &mut [f32],
    w: usize,
    h: usize,
    dw: usize,
    dh: usize,
) {
    // Mirror avx2.rs:261-264: both source and destination dimensions must be in-bounds
    // before any _mm512_loadu_ps/_mm512_storeu_ps call, or reads/writes are silent UB.
    assert!(
        src.len() >= w * h && dst.len() >= dw * dh,
        "downsample_avx512: src.len() must be >= w*h and dst.len() >= dw*dh"
    );
    let quarter = _mm512_set1_ps(0.25);
    // even = src indices 0,2,...,30 ; odd = 1,3,...,31 across the concatenated a||b.
    let even_idx = _mm512_setr_epi32(0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30);
    let odd_idx = _mm512_setr_epi32(1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31);
    for yy in 0..dh {
        let sy0 = yy << 1;
        let sy1 = if sy0 + 1 < h { sy0 + 1 } else { h - 1 };
        let row0 = sy0 * w;
        let row1 = sy1 * w;
        let drow = yy * dw;
        let mut xx = 0usize;
        while xx + 16 <= dw && 2 * xx + 32 <= w {
            let a0 = _mm512_loadu_ps(src.as_ptr().add(row0 + 2 * xx));
            let b0 = _mm512_loadu_ps(src.as_ptr().add(row0 + 2 * xx + 16));
            let a1 = _mm512_loadu_ps(src.as_ptr().add(row1 + 2 * xx));
            let b1 = _mm512_loadu_ps(src.as_ptr().add(row1 + 2 * xx + 16));
            let even_r0 = _mm512_permutex2var_ps(a0, even_idx, b0);
            let odd_r0 = _mm512_permutex2var_ps(a0, odd_idx, b0);
            let even_r1 = _mm512_permutex2var_ps(a1, even_idx, b1);
            let odd_r1 = _mm512_permutex2var_ps(a1, odd_idx, b1);
            let sum = _mm512_add_ps(
                _mm512_add_ps(even_r0, odd_r0),
                _mm512_add_ps(even_r1, odd_r1),
            );
            _mm512_storeu_ps(dst.as_mut_ptr().add(drow + xx), _mm512_mul_ps(sum, quarter));
            xx += 16;
        }
        downsample_row_tail(src, w, h, &mut dst[drow..drow + dw], dw, yy, xx);
    }
}

/// AVX-512 SSIM moment accumulation (channel-as-lane, 4 px/iter). Server-only
/// optimization: returns per-channel (sa, saa, sab) for c in 0..3, same contract as
/// `avx2::ssim_moments_avx2` — but unlike that *deliberately scalar* kernel (the AVX2
/// deinterleave attempt was a measured wash), this packs 4 RGBA pixels into the 16
/// i32 lanes and fuses the three products. The wasm v128 form of the SAME layout is
/// runtime-measured at 3.73× over scalar; this is its AVX-512 width. Parity == scalar
/// by construction; perf is to be measured on real AVX-512 fleet hardware (the dev
/// machine has none), not the dev machine.
#[target_feature(enable = "avx512f")]
pub unsafe fn ssim_moments_avx512(a: &[u8], b: &[u8], np: usize) -> ([u64; 4], [u64; 4], [u64; 4]) {
    // assert! (not debug_assert!) to match ssim_moments_avx2 — a short buffer would
    // OOB the 128-bit load below in a release build (silent UB).
    assert!(
        a.len() / 4 >= np && b.len() / 4 >= np,
        "ssim_moments_avx512: a.len() and b.len() must be >= np*4"
    );
    let mut sa = [0u64; 4];
    let mut saa = [0u64; 4];
    let mut sab = [0u64; 4];
    let mut va = _mm512_setzero_si512();
    let mut vaa = _mm512_setzero_si512();
    let mut vab = _mm512_setzero_si512();
    // Each i32 lane holds one channel of one pixel-slot and gains ≤255² = 65025 per
    // iter; i32 overflows after ⌊(2³¹−1)/65025⌋ ≈ 33025 iters. Drain at 32000.
    const FLUSH: usize = 32000;
    let mut fc = 0usize;
    let groups = np / 4;
    let mut p = 0usize;
    let mut g = 0usize;
    while g < groups {
        let off = p * 4;
        // Load 16 bytes (4 RGBA px) and widen u8→i32: lanes = [R0,G0,B0,A0, R1,…, R3,…].
        let av = _mm512_cvtepu8_epi32(_mm_loadu_si128(a.as_ptr().add(off) as *const __m128i));
        let bv = _mm512_cvtepu8_epi32(_mm_loadu_si128(b.as_ptr().add(off) as *const __m128i));
        va = _mm512_add_epi32(va, av);
        vaa = _mm512_add_epi32(vaa, _mm512_mullo_epi32(av, av));
        vab = _mm512_add_epi32(vab, _mm512_mullo_epi32(av, bv));
        p += 4;
        g += 1;
        fc += 1;
        if fc == FLUSH {
            drain16_rgba(va, &mut sa);
            drain16_rgba(vaa, &mut saa);
            drain16_rgba(vab, &mut sab);
            va = _mm512_setzero_si512();
            vaa = _mm512_setzero_si512();
            vab = _mm512_setzero_si512();
            fc = 0;
        }
    }
    drain16_rgba(va, &mut sa);
    drain16_rgba(vaa, &mut saa);
    drain16_rgba(vab, &mut sab);
    // Scalar tail for the remaining np % 4 pixels.
    let mut j = p * 4;
    while p < np {
        for c in 0..4 {
            let x = a[j + c] as u64;
            let y = b[j + c] as u64;
            sa[c] += x;
            saa[c] += x * x;
            sab[c] += x * y;
        }
        j += 4;
        p += 1;
    }
    (sa, saa, sab)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::perceptual::butteraugli::{dn2, scale_err, Kweights};
    use crate::perceptual::xyb::{pixels_to_xyb, sqrt_lin_lut_ptr};

    fn avx512() -> bool {
        std::is_x86_feature_detected!("avx512f") && std::is_x86_feature_detected!("avx512bw")
    }

    #[test]
    fn scale_err_avx512_matches_scalar() {
        if !avx512() {
            eprintln!("avx512 unavailable — skipping");
            return;
        }
        let n = 1000usize;
        let mut rx = vec![0f32; n];
        let mut ry = vec![0f32; n];
        let mut rb = vec![0f32; n];
        let mut tx = vec![0f32; n];
        let mut ty = vec![0f32; n];
        let mut tb = vec![0f32; n];
        let mut mask = vec![0f32; n];
        for i in 0..n {
            let f = i as f32;
            rx[i] = (f * 0.013).sin() * 0.4;
            tx[i] = rx[i] + (f * 0.07).cos() * 0.05;
            ry[i] = (f * 0.021).cos() * 0.5 + 0.5;
            ty[i] = ry[i] + (f * 0.03).sin() * 0.05;
            rb[i] = (f * 0.017).sin() * 0.3 + 0.3;
            tb[i] = rb[i] + (f * 0.05).cos() * 0.04;
            mask[i] = ((f * 0.009).sin() * 0.5 + 0.5).abs() * 0.6;
        }
        let k = Kweights::default();
        let want = scale_err(&mask, &rx, &ry, &rb, &tx, &ty, &tb, n, &k);
        let rel = |a: f32, b: f32| (a - b).abs() / a.abs().max(b.abs()).max(1e-12);
        for rsqrt in [false, true] {
            let got = unsafe {
                scale_err_avx512(
                    &mask, &rx, &ry, &rb, &tx, &ty, &tb, n, k.kx, k.ky, k.kb, rsqrt,
                )
            };
            assert!(
                rel(want, got) < 1e-4,
                "rsqrt={rsqrt} rel={} want={want} got={got}",
                rel(want, got)
            );
        }
    }

    #[test]
    fn xyb_avx512_matches_scalar() {
        if !avx512() {
            return;
        }
        let n = 1000usize;
        let px: Vec<u8> = (0..n * 4).map(|i| (i * 37 % 256) as u8).collect();
        let (mut sx, mut sy, mut sb) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        pixels_to_xyb(&px, n, &mut sx, &mut sy, &mut sb);
        let (mut ax, mut ay, mut ab) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        unsafe {
            pixels_to_xyb_avx512(&px, n, sqrt_lin_lut_ptr(), &mut ax, &mut ay, &mut ab);
        }
        for i in 0..n {
            assert!((sx[i] - ax[i]).abs() < 1e-6);
            assert!((sy[i] - ay[i]).abs() < 1e-6);
            assert!((sb[i] - ab[i]).abs() < 1e-6);
        }
    }

    #[test]
    fn ssim_moments_avx512_matches_scalar() {
        if !avx512() {
            return;
        }
        let np = 1000usize; // non-multiple of 4 to exercise the scalar tail (1000%4==0 → bump)
        let np = np + 3;
        let a: Vec<u8> = (0..np * 4).map(|i| (i * 13 % 255) as u8).collect();
        let b: Vec<u8> = (0..np * 4).map(|i| (i * 29 % 255) as u8).collect();
        // scalar oracle (mirrors ssim_moments_avx2's scalar body, 4 lanes)
        let (mut sa, mut saa, mut sab) = ([0u64; 4], [0u64; 4], [0u64; 4]);
        let mut j = 0;
        for _ in 0..np {
            for c in 0..4 {
                let (x, y) = (a[j + c] as u64, b[j + c] as u64);
                sa[c] += x;
                saa[c] += x * x;
                sab[c] += x * y;
            }
            j += 4;
        }
        let (gsa, gsaa, gsab) = unsafe { ssim_moments_avx512(&a, &b, np) };
        assert_eq!((sa, saa, sab), (gsa, gsaa, gsab));
    }

    #[test]
    fn downsample_avx512_matches_dn2() {
        if !avx512() {
            return;
        }
        for (w, h) in [(64usize, 48usize), (65, 49), (2, 2), (33, 17)] {
            let src: Vec<f32> = (0..w * h).map(|i| (i as f32 * 0.013).sin()).collect();
            let (want, dw, dh) = dn2(&src, w, h);
            let mut got = vec![0f32; dw * dh];
            unsafe {
                downsample_avx512(&src, &mut got, w, h, dw, dh);
            }
            for i in 0..dw * dh {
                assert!((want[i] - got[i]).abs() < 1e-5);
            }
        }
    }
}
