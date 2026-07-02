//! downsample_hadd_flip — native interleaved A/B for the AVX2 2× box downsample
//! (`dn2`'s SIMD kernel, run per pyramid level in the butteraugli comparer):
//!
//!   A = shipped shuffle network (8× permutevar8x32 + 4× permute2f128 per 8 out px)
//!   B = hadd rewrite            (2× hadd_ps + 1× permute4x64 per 8 out px)
//!
//! VERDICT (2026-07-02, this machine): REJECTED — bit-exact but a wash.
//! +2.8% / +0.7% / −3.6% / +4.4% / −0.1% across 0.4–24 MP planes; the kernel is
//! memory-bound, so cutting 12 shuffle uops to ~5 does not move the median and
//! regresses at 24 MP. Production keeps the shuffle network. Both variants are
//! carried locally here so the record stays reproducible.
//!
//! Bit-exact parity asserted up front (same adds, same association — only the
//! shuffle plumbing differs). Variants run interleaved with per-round start
//! rotation; round 0 (warm-up) dropped; median per size.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example downsample_hadd_flip
#![cfg(target_arch = "x86_64")]
use std::arch::x86_64::*;
use std::time::Instant;

/// The hadd candidate (B arm): pair sums via hadd_ps, one permute4x64(0xD8)
/// to unscramble [A,B,C,D] 64-bit blocks into [A,C,B,D].
#[target_feature(enable = "avx2")]
unsafe fn downsample_hadd(src: &[f32], dst: &mut [f32], w: usize, h: usize, dw: usize, dh: usize) {
    let quarter = _mm256_set1_ps(0.25);
    for y in 0..dh {
        let sy0 = y << 1;
        let sy1 = if sy0 + 1 < h { sy0 + 1 } else { h - 1 };
        let row0 = sy0 * w;
        let row1 = sy1 * w;
        let drow = y * dw;
        let mut x = 0usize;
        while x + 8 <= dw && 2 * x + 16 <= w {
            let p00 = _mm256_loadu_ps(src.as_ptr().add(row0 + 2 * x));
            let p01 = _mm256_loadu_ps(src.as_ptr().add(row0 + 2 * x + 8));
            let p10 = _mm256_loadu_ps(src.as_ptr().add(row1 + 2 * x));
            let p11 = _mm256_loadu_ps(src.as_ptr().add(row1 + 2 * x + 8));
            let h0 = _mm256_hadd_ps(p00, p01);
            let h1 = _mm256_hadd_ps(p10, p11);
            let sum_scrambled = _mm256_add_ps(h0, h1);
            let sum = _mm256_castpd_ps(_mm256_permute4x64_pd(
                _mm256_castps_pd(sum_scrambled),
                0xD8,
            ));
            _mm256_storeu_ps(dst.as_mut_ptr().add(drow + x), _mm256_mul_ps(sum, quarter));
            x += 8;
        }
        while x < dw {
            let sx0 = x << 1;
            let sx1 = if sx0 + 1 < w { sx0 + 1 } else { w - 1 };
            dst[drow + x] = (src[row0 + sx0] + src[row0 + sx1]
                + src[row1 + sx0] + src[row1 + sx1]) * 0.25;
            x += 1;
        }
    }
}

/// Verbatim copy of the pre-hadd kernel (the A-arm baseline), including the
/// same scalar tail math as the production kernel.
#[target_feature(enable = "avx2")]
unsafe fn downsample_old(src: &[f32], dst: &mut [f32], w: usize, h: usize, dw: usize, dh: usize) {
    let quarter = _mm256_set1_ps(0.25);
    let even_idx = _mm256_setr_epi32(0, 2, 4, 6, 0, 2, 4, 6);
    let odd_idx = _mm256_setr_epi32(1, 3, 5, 7, 1, 3, 5, 7);
    for y in 0..dh {
        let sy0 = y << 1;
        let sy1 = if sy0 + 1 < h { sy0 + 1 } else { h - 1 };
        let row0 = sy0 * w;
        let row1 = sy1 * w;
        let drow = y * dw;
        let mut x = 0usize;
        while x + 8 <= dw && 2 * x + 16 <= w {
            let p00 = _mm256_loadu_ps(src.as_ptr().add(row0 + 2 * x));
            let p01 = _mm256_loadu_ps(src.as_ptr().add(row0 + 2 * x + 8));
            let p10 = _mm256_loadu_ps(src.as_ptr().add(row1 + 2 * x));
            let p11 = _mm256_loadu_ps(src.as_ptr().add(row1 + 2 * x + 8));
            let e0 = _mm256_permutevar8x32_ps(p00, even_idx);
            let e1 = _mm256_permutevar8x32_ps(p01, even_idx);
            let even_r0 = _mm256_permute2f128_ps(e0, e1, 0x20);
            let o0 = _mm256_permutevar8x32_ps(p00, odd_idx);
            let o1 = _mm256_permutevar8x32_ps(p01, odd_idx);
            let odd_r0 = _mm256_permute2f128_ps(o0, o1, 0x20);
            let e0b = _mm256_permutevar8x32_ps(p10, even_idx);
            let e1b = _mm256_permutevar8x32_ps(p11, even_idx);
            let even_r1 = _mm256_permute2f128_ps(e0b, e1b, 0x20);
            let o0b = _mm256_permutevar8x32_ps(p10, odd_idx);
            let o1b = _mm256_permutevar8x32_ps(p11, odd_idx);
            let odd_r1 = _mm256_permute2f128_ps(o0b, o1b, 0x20);
            let sum = _mm256_add_ps(
                _mm256_add_ps(even_r0, odd_r0),
                _mm256_add_ps(even_r1, odd_r1),
            );
            _mm256_storeu_ps(dst.as_mut_ptr().add(drow + x), _mm256_mul_ps(sum, quarter));
            x += 8;
        }
        // Same clamped scalar tail as production downsample_row_tail.
        while x < dw {
            let sx0 = x << 1;
            let sx1 = if sx0 + 1 < w { sx0 + 1 } else { w - 1 };
            dst[drow + x] = (src[row0 + sx0] + src[row0 + sx1]
                + src[row1 + sx0] + src[row1 + sx1]) * 0.25;
            x += 1;
        }
    }
}

fn main() {
    if !std::is_x86_feature_detected!("avx2") {
        println!("avx2 unavailable — skipping");
        return;
    }
    // Butteraugli pyramid levels for typical RAW previews + full frames.
    let sizes = [(1024usize, 1024usize), (3000, 2000), (6000, 4000), (1500, 1000), (750, 500)];
    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec();
        w.sort_by(|x, y| x.partial_cmp(y).unwrap());
        w[w.len() / 2]
    };

    println!("downsample_hadd_flip   A=old shuffle network   B=hadd+permute4x64");
    for (w, h) in sizes {
        let n = w * h;
        let (dw, dh) = (w.div_ceil(2), h.div_ceil(2));
        let mut src = vec![0f32; n];
        let mut s: u32 = 0x9e37_79b9;
        for v in &mut src {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *v = (s >> 8) as f32 / 65_536.0;
        }

        let mut a0 = vec![0f32; dw * dh];
        let mut b0 = vec![0f32; dw * dh];
        unsafe { downsample_old(&src, &mut a0, w, h, dw, dh) };
        unsafe { downsample_hadd(&src, &mut b0, w, h, dw, dh) };
        let parity = a0.iter().zip(&b0).all(|(x, y)| x.to_bits() == y.to_bits());

        let rounds = 33usize;
        let iters = (40_000_000 / n).max(1);
        let mut times: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
        let mut out = vec![0f32; dw * dh];
        let mut sink = 0u32;
        for round in 0..rounds {
            for k in 0..2 {
                let which = (round + k) % 2;
                let t = Instant::now();
                for _ in 0..iters {
                    if which == 0 {
                        unsafe { downsample_old(&src, &mut out, w, h, dw, dh) };
                    } else {
                        unsafe { downsample_hadd(&src, &mut out, w, h, dw, dh) };
                    }
                }
                let dt = t.elapsed().as_secs_f64() * 1e3 / iters as f64;
                sink = sink.wrapping_add(out[dw * dh / 2].to_bits());
                times[which].push(dt);
            }
        }
        let (ma, mb) = (med(&times[0]), med(&times[1]));
        println!(
            "  {w}×{h} -> {dw}×{dh}   parity(bit-exact): {}",
            if parity { "PASS" } else { "FAIL" }
        );
        println!("    A old:   {ma:.4} ms median");
        println!(
            "    B hadd:  {mb:.4} ms median   %saved {:+.1}%   {:.2}×   gate(≥5%): {}",
            (ma - mb) / ma * 100.0,
            ma / mb,
            if (ma - mb) / ma * 100.0 >= 5.0 { "PASS" } else { "FAIL" }
        );
        println!("    (sink={sink})");
    }
}
