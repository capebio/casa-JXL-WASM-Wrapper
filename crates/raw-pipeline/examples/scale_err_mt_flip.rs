//! scale_err_mt_flip — native A/B for the flush-block-parallel butteraugli
//! scale error (`scale_err_avx2`, the per-level per-compare kernel):
//!
//!   A = serial   (verbatim pre-change kernel: one walk, FLUSH-drained)
//!   B = parallel (landed kernel: rayon bands aligned to the FLUSH boundaries,
//!                 partials left-folded in band order = identical f64 sequence)
//!
//! Parity is BIT-exact by construction (same per-block f64 values, same fold
//! order) — asserted. Interleaved, start-rotated, round 0 dropped, median.
//! div+sqrt per lane → compute-bound → expected to survive the DS-ROWPAR rule.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --example scale_err_mt_flip
#[cfg(target_arch = "x86_64")]
use core::arch::x86_64::*;
use raw_pipeline::perceptual::avx2_kernels::scale_err_avx2;
use std::time::Instant;

#[cfg(target_arch = "x86_64")]
#[inline]
unsafe fn hsum256(v: __m256) -> f32 {
    let lo = _mm256_castps256_ps128(v);
    let hi = _mm256_extractf128_ps(v, 1);
    let s = _mm_add_ps(lo, hi);
    let sh = _mm_movehdup_ps(s);
    let sums = _mm_add_ps(s, sh);
    let sh2 = _mm_movehl_ps(sh, sums);
    _mm_cvtss_f32(_mm_add_ss(sums, sh2))
}

/// Verbatim pre-change serial kernel (strict-sqrt path only — the Auto default).
#[cfg(target_arch = "x86_64")]
#[allow(clippy::too_many_arguments)]
#[target_feature(enable = "avx2,fma")]
unsafe fn scale_err_serial(
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
    let vkx = _mm256_set1_ps(kx);
    let vky = _mm256_set1_ps(ky);
    let vkb = _mm256_set1_ps(kb);
    let v2 = _mm256_set1_ps(2.0);
    let v015 = _mm256_set1_ps(0.15);
    let veps = _mm256_set1_ps(1e-12);
    let mut acc = _mm256_setzero_ps();
    const FLUSH: usize = 4096;
    let mut flush_count = 0usize;
    let mut sum = 0f64;
    let lanes = n / 8 * 8;
    let mut i = 0;
    while i < lanes {
        let m = _mm256_loadu_ps(mask.as_ptr().add(i));
        let mm = _mm256_max_ps(_mm256_fmadd_ps(m, v2, v015), v015);
        let inv = _mm256_div_ps(_mm256_set1_ps(1.0), mm);
        let ex = _mm256_mul_ps(
            _mm256_sub_ps(
                _mm256_loadu_ps(rx.as_ptr().add(i)),
                _mm256_loadu_ps(tx.as_ptr().add(i)),
            ),
            inv,
        );
        let ey = _mm256_mul_ps(
            _mm256_sub_ps(
                _mm256_loadu_ps(ry.as_ptr().add(i)),
                _mm256_loadu_ps(ty.as_ptr().add(i)),
            ),
            inv,
        );
        let eb = _mm256_mul_ps(
            _mm256_sub_ps(
                _mm256_loadu_ps(rb.as_ptr().add(i)),
                _mm256_loadu_ps(tb.as_ptr().add(i)),
            ),
            inv,
        );
        let mut e2 = _mm256_mul_ps(vkx, _mm256_mul_ps(ex, ex));
        e2 = _mm256_fmadd_ps(vky, _mm256_mul_ps(ey, ey), e2);
        e2 = _mm256_fmadd_ps(vkb, _mm256_mul_ps(eb, eb), e2);
        let root = _mm256_sqrt_ps(_mm256_add_ps(e2, veps));
        acc = _mm256_fmadd_ps(e2, root, acc);
        i += 8;
        flush_count += 1;
        if flush_count == FLUSH {
            sum += hsum256(acc) as f64;
            acc = _mm256_setzero_ps();
            flush_count = 0;
        }
    }
    sum += hsum256(acc) as f64;
    // scalar tail (verbatim scale_err_tail logic)
    let mut j = i;
    while j < n {
        let mmv = (mask[j] * 2.0 + 0.15).max(0.15);
        let inv = 1.0 / mmv;
        let ex = (rx[j] - tx[j]) * inv;
        let ey = (ry[j] - ty[j]) * inv;
        let eb = (rb[j] - tb[j]) * inv;
        let e2 = kx * ex * ex + ky * ey * ey + kb * eb * eb;
        sum += (e2 * (e2 + 1e-12).sqrt()) as f64;
        j += 1;
    }
    ((sum / n as f64).cbrt()) as f32
}

#[cfg(not(target_arch = "x86_64"))]
fn main() {
    println!("x86_64 only");
}

#[cfg(target_arch = "x86_64")]
fn main() {
    if !(std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma")) {
        println!("avx2+fma unavailable — skipping");
        return;
    }
    let sizes = [(2048usize, 1100usize), (3000, 2000), (6000, 4000)]; // 2.25, 6, 24 MP
    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec();
        w.sort_by(|x, y| x.partial_cmp(y).unwrap());
        w[w.len() / 2]
    };
    let (kx, ky, kb) = (0.7f32, 1.1, 0.9);

    println!(
        "scale_err_mt_flip   A=serial   B=parallel-flush-bands   threads={}",
        rayon::current_num_threads()
    );
    for (w, h) in sizes {
        let n = w * h;
        let mk = |seed: u32| -> Vec<f32> {
            let mut s = seed;
            (0..n)
                .map(|_| {
                    s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    (s >> 8) as f32 / 16_777_216.0
                })
                .collect()
        };
        let (mask, rx, ry, rb) = (mk(1), mk(2), mk(3), mk(4));
        let (tx, ty, tb) = (mk(5), mk(6), mk(7));

        let a0 = unsafe { scale_err_serial(&mask, &rx, &ry, &rb, &tx, &ty, &tb, n, kx, ky, kb) };
        let b0 =
            unsafe { scale_err_avx2(&mask, &rx, &ry, &rb, &tx, &ty, &tb, n, kx, ky, kb, false) };
        let parity = a0.to_bits() == b0.to_bits();

        let rounds = 11usize;
        let mut times: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
        let mut sink = 0u32;
        for round in 0..rounds {
            for k in 0..2 {
                let which = (round + k) % 2;
                let t = Instant::now();
                let r = if which == 0 {
                    unsafe { scale_err_serial(&mask, &rx, &ry, &rb, &tx, &ty, &tb, n, kx, ky, kb) }
                } else {
                    unsafe {
                        scale_err_avx2(&mask, &rx, &ry, &rb, &tx, &ty, &tb, n, kx, ky, kb, false)
                    }
                };
                let dt = t.elapsed().as_secs_f64() * 1e3;
                sink = sink.wrapping_add(r.to_bits());
                times[which].push(dt);
            }
        }
        let (ma, mb) = (med(&times[0]), med(&times[1]));
        println!(
            "  {w}×{h} = {:.1} MP   parity(bit-exact): {}",
            n as f64 / 1e6,
            if parity { "PASS" } else { "FAIL" }
        );
        println!("    A serial:                {ma:.3} ms median");
        println!(
            "    B parallel-flush-bands:  {mb:.3} ms median   %saved {:+.1}%   {:.2}×   gate(≥5%): {}",
            (ma - mb) / ma * 100.0,
            ma / mb,
            if (ma - mb) / ma * 100.0 >= 5.0 {
                "PASS"
            } else {
                "FAIL"
            }
        );
        println!("    (sink={sink})");
    }
}
