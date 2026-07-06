//! ssim_moments_mt_flip — native A/B for the pixel-band-parallel SSIM moments
//! (`ssim_moments_avx2_cal`, the wired per-compare Avx2 SSIM path):
//!
//!   A = serial  (verbatim pre-change kernel: one walk over all pixels)
//!   B = parallel (landed kernel: rayon map-reduce over 1M-px bands ≥2M px)
//!
//! Moments are u64 integer sums, so parity is EXACT by algebra (integer adds
//! commute) — asserted anyway. Interleaved, start-rotated, round 0 dropped,
//! median.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --example ssim_moments_mt_flip
#[cfg(target_arch = "x86_64")]
use core::arch::x86_64::*;
use raw_pipeline::perceptual::avx2_kernels::ssim_moments_avx2_cal;
use std::time::Instant;

#[cfg(target_arch = "x86_64")]
#[inline]
unsafe fn drain8_rgb(v: __m256i, out: &mut [u64; 3]) {
    let mut lanes = [0i32; 8];
    _mm256_storeu_si256(lanes.as_mut_ptr() as *mut __m256i, v);
    // lanes = [R0,G0,B0,A0, R1,G1,B1,A1] partial sums; A discarded.
    out[0] += (lanes[0] as u32 as u64) + (lanes[4] as u32 as u64);
    out[1] += (lanes[1] as u32 as u64) + (lanes[5] as u32 as u64);
    out[2] += (lanes[2] as u32 as u64) + (lanes[6] as u32 as u64);
}

/// Verbatim pre-change serial kernel.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn ssim_moments_serial(a: &[u8], b: &[u8], np: usize) -> ([u64; 3], [u64; 3], [u64; 3]) {
    let mut sa = [0u64; 3];
    let mut saa = [0u64; 3];
    let mut sab = [0u64; 3];
    let mut va = _mm256_setzero_si256();
    let mut vaa = _mm256_setzero_si256();
    let mut vab = _mm256_setzero_si256();
    const FLUSH: usize = 32000;
    let mut fc = 0usize;
    let groups = np / 2;
    let mut p = 0usize;
    let mut g = 0usize;
    while g < groups {
        let off = p * 4;
        let av = _mm256_cvtepu8_epi32(_mm_loadl_epi64(a.as_ptr().add(off) as *const __m128i));
        let bv = _mm256_cvtepu8_epi32(_mm_loadl_epi64(b.as_ptr().add(off) as *const __m128i));
        va = _mm256_add_epi32(va, av);
        vaa = _mm256_add_epi32(vaa, _mm256_mullo_epi32(av, av));
        vab = _mm256_add_epi32(vab, _mm256_mullo_epi32(av, bv));
        p += 2;
        g += 1;
        fc += 1;
        if fc == FLUSH {
            drain8_rgb(va, &mut sa);
            drain8_rgb(vaa, &mut saa);
            drain8_rgb(vab, &mut sab);
            va = _mm256_setzero_si256();
            vaa = _mm256_setzero_si256();
            vab = _mm256_setzero_si256();
            fc = 0;
        }
    }
    drain8_rgb(va, &mut sa);
    drain8_rgb(vaa, &mut saa);
    drain8_rgb(vab, &mut sab);
    let mut j = p * 4;
    while p < np {
        for c in 0..3 {
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
        "ssim_moments_mt_flip   A=serial   B=parallel-bands   threads={}",
        rayon::current_num_threads()
    );
    for (w, h) in sizes {
        let np = w * h;
        let mut a = vec![0u8; np * 4];
        let mut b = vec![0u8; np * 4];
        let mut s: u32 = 0x9e37_79b9;
        for i in 0..np * 4 {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            a[i] = (s >> 16) as u8;
            b[i] = (s >> 8) as u8;
        }

        let ra = unsafe { ssim_moments_serial(&a, &b, np) };
        let rb = unsafe { ssim_moments_avx2_cal(&a, &b, np) };
        let parity = ra == rb;

        let rounds = 11usize;
        let mut times: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
        let mut sink = 0u64;
        for round in 0..rounds {
            for k in 0..2 {
                let which = (round + k) % 2;
                let t = Instant::now();
                let r = if which == 0 {
                    unsafe { ssim_moments_serial(&a, &b, np) }
                } else {
                    unsafe { ssim_moments_avx2_cal(&a, &b, np) }
                };
                let dt = t.elapsed().as_secs_f64() * 1e3;
                sink = sink.wrapping_add(r.1[1]);
                times[which].push(dt);
            }
        }
        let (ma, mb) = (med(&times[0]), med(&times[1]));
        println!(
            "  {w}×{h} = {:.1} MP   parity(exact): {}",
            np as f64 / 1e6,
            if parity { "PASS" } else { "FAIL" }
        );
        println!("    A serial:          {ma:.3} ms median");
        println!(
            "    B parallel-bands:  {mb:.3} ms median   %saved {:+.1}%   {:.2}×   gate(≥5%): {}",
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
