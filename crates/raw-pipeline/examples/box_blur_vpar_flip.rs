//! box_blur_vpar_flip — native A/B for the parallel vertical pass of the AVX2
//! reference-mask box blur:
//!
//!   A = serial V   (verbatim pre-change box_blur_avx2: one 8-wide walk 0..w)
//!   B = parallel V (landed box_blur_avx2: rayon over 256-column bands ≥2 MP)
//!
//! Both share the identical (row-parallel) H pass via the public kernel's own
//! code path — the A arm carries a verbatim serial copy of the old V walk (kept
//! honest by a bit-exact parity check against B before timing). Interleaved
//! with per-round start rotation; round 0 dropped; median at the production
//! mask radius r=min(w>>6,8).
//!
//! Run: cd crates/raw-pipeline && cargo run --release --example box_blur_vpar_flip
#[cfg(target_arch = "x86_64")]
use core::arch::x86_64::*;
use raw_pipeline::perceptual::avx2_kernels::box_blur_avx2;
use std::time::Instant;

/// Verbatim copy of the pre-change box_blur_avx2 (serial V walk) — A-arm baseline.
/// The H pass is ROW-PARALLEL like production `box_blur_h` (that win landed
/// earlier and ships in both arms), so the only timed difference is the V pass.
#[cfg(target_arch = "x86_64")]
unsafe fn box_blur_avx2_serial_v(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let n = w * h;
    if n == 0 {
        return Vec::new();
    }
    let mut tmp: Vec<f32> = Vec::with_capacity(n);
    let mut dst: Vec<f32> = Vec::with_capacity(n);
    tmp.set_len(n);
    dst.set_len(n);
    let inv = 1.0 / (2 * r + 1) as f32;
    // H pass — row-parallel, bit-equal replica of blur::box_blur_h.
    {
        use rayon::prelude::*;
        let w_max = w - 1;
        tmp.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
            let base = y * w;
            let mut sum = src[base] * (r as f32 + 1.0);
            for k in 1..=r {
                sum += src[base + k.min(w_max)];
            }
            for x in 0..w {
                row[x] = sum * inv;
                let add = src[base + (x + r + 1).min(w_max)];
                let sub = src[base + x.saturating_sub(r)];
                sum += add - sub;
            }
        });
    }
    // V pass: the original serial 8-wide walk.
    let rp1 = _mm256_set1_ps(r as f32 + 1.0);
    let inv_v = _mm256_set1_ps(inv);
    let h_max = h - 1;
    let tp = tmp.as_ptr();
    let dp = dst.as_mut_ptr();
    let mut x = 0usize;
    while x + 8 <= w {
        let mut sums = _mm256_mul_ps(_mm256_loadu_ps(tp.add(x)), rp1);
        for k in 1..=r {
            let row = k.min(h_max) * w;
            sums = _mm256_add_ps(sums, _mm256_loadu_ps(tp.add(row + x)));
        }
        for y in 0..h {
            let drow = y * w;
            _mm256_storeu_ps(dp.add(drow + x), _mm256_mul_ps(sums, inv_v));
            let add_row = (y + r + 1).min(h_max) * w;
            let sub_row = y.saturating_sub(r) * w;
            let add = _mm256_loadu_ps(tp.add(add_row + x));
            let sub = _mm256_loadu_ps(tp.add(sub_row + x));
            sums = _mm256_add_ps(sums, _mm256_sub_ps(add, sub));
        }
        x += 8;
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
    dst
}

#[cfg(not(target_arch = "x86_64"))]
fn main() {
    println!("x86_64 only");
}

#[cfg(target_arch = "x86_64")]
fn main() {
    if !std::is_x86_feature_detected!("avx2") {
        println!("avx2 unavailable — skipping");
        return;
    }
    let sizes = [(2048usize, 1100usize), (3000, 2000), (6000, 4000)]; // 2.25, 6, 24 MP
    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec();
        w.sort_by(|x, y| x.partial_cmp(y).unwrap());
        w[w.len() / 2]
    };

    println!(
        "box_blur_vpar_flip   A=serial-V   B=parallel-V(bands)   threads={}",
        rayon::current_num_threads()
    );
    for (w, h) in sizes {
        let n = w * h;
        let r = (w >> 6).clamp(1, 8);
        let mut src = vec![0f32; n];
        let mut s: u32 = 0x9e37_79b9;
        for v in &mut src {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *v = (s >> 8) as f32 / 65_536.0;
        }

        let a0 = unsafe { box_blur_avx2_serial_v(&src, w, h, r) };
        let b0 = unsafe { box_blur_avx2(&src, w, h, r) };
        let parity = a0.iter().zip(&b0).all(|(x, y)| x.to_bits() == y.to_bits());

        let rounds = 11usize;
        let mut times: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
        let mut sink = 0u32;
        for round in 0..rounds {
            for k in 0..2 {
                let which = (round + k) % 2;
                let t = Instant::now();
                let out = if which == 0 {
                    unsafe { box_blur_avx2_serial_v(&src, w, h, r) }
                } else {
                    unsafe { box_blur_avx2(&src, w, h, r) }
                };
                let dt = t.elapsed().as_secs_f64() * 1e3;
                sink = sink.wrapping_add(out[n / 2].to_bits());
                times[which].push(dt);
            }
        }
        let (ma, mb) = (med(&times[0]), med(&times[1]));
        println!(
            "  {w}×{h} = {:.1} MP  r={r}   parity(bit-exact): {}",
            n as f64 / 1e6,
            if parity { "PASS" } else { "FAIL" }
        );
        println!("    A serial-V:   {ma:.3} ms median");
        println!(
            "    B parallel-V: {mb:.3} ms median   %saved {:+.1}%   {:.2}×   gate(≥5%): {}",
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
