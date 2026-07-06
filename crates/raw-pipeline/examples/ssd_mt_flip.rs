//! ssd_mt_flip — native A/B for the byte-band-parallel PSNR SSD (`ssd_avx2`):
//!
//!   A = serial   (verbatim pre-change kernel)
//!   B = parallel (landed kernel: rayon over 4 MB bands ≥8 MB)
//!
//! SSD is a u64 integer sum → parity EXACT by algebra; asserted anyway.
//! Interleaved, start-rotated, round 0 dropped, median. This kernel is lighter
//! per byte than the SSIM moments (1 madd per 16-byte chunk), so the
//! DS-ROWPAR bandwidth ceiling may bite — the ≥5% gate decides.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --example ssd_mt_flip
#[cfg(target_arch = "x86_64")]
use core::arch::x86_64::*;
use raw_pipeline::perceptual::avx2_kernels::ssd_avx2;
use std::time::Instant;

#[cfg(target_arch = "x86_64")]
#[inline]
unsafe fn hsum256i_u64(v: __m256i) -> u64 {
    let mut lanes = [0i32; 8];
    _mm256_storeu_si256(lanes.as_mut_ptr() as *mut __m256i, v);
    lanes.iter().map(|&x| x as u32 as u64).sum()
}

/// Verbatim pre-change serial kernel.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn ssd_serial(a: &[u8], b: &[u8]) -> u64 {
    let len = a.len();
    const FLUSH_EVERY: usize = 16000;
    let mut acc = _mm256_setzero_si256();
    let mut sum: u64 = 0;
    let chunks = len / 16 * 16;
    let mut i = 0;
    let mut since_flush = 0usize;
    while i < chunks {
        let va = _mm_loadu_si128(a.as_ptr().add(i) as *const __m128i);
        let vb = _mm_loadu_si128(b.as_ptr().add(i) as *const __m128i);
        let aw = _mm256_cvtepu8_epi16(va);
        let bw = _mm256_cvtepu8_epi16(vb);
        let d = _mm256_sub_epi16(aw, bw);
        let sq = _mm256_madd_epi16(d, d);
        acc = _mm256_add_epi32(acc, sq);
        i += 16;
        since_flush += 1;
        if since_flush == FLUSH_EVERY {
            sum += hsum256i_u64(acc);
            acc = _mm256_setzero_si256();
            since_flush = 0;
        }
    }
    sum += hsum256i_u64(acc);
    while i < len {
        let d = a[i] as i64 - b[i] as i64;
        sum += (d * d) as u64;
        i += 1;
    }
    sum
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
    let sizes = [(2048usize, 1100usize), (3000, 2000), (6000, 4000)]; // 2.25, 6, 24 MP RGBA
    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec();
        w.sort_by(|x, y| x.partial_cmp(y).unwrap());
        w[w.len() / 2]
    };

    println!(
        "ssd_mt_flip   A=serial   B=parallel-bands   threads={}",
        rayon::current_num_threads()
    );
    for (w, h) in sizes {
        let n = w * h * 4;
        let mut a = vec![0u8; n];
        let mut b = vec![0u8; n];
        let mut s: u32 = 0x9e37_79b9;
        for i in 0..n {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            a[i] = (s >> 16) as u8;
            b[i] = (s >> 8) as u8;
        }

        let parity = unsafe { ssd_serial(&a, &b) } == unsafe { ssd_avx2(&a, &b) };

        let rounds = 11usize;
        let mut times: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
        let mut sink = 0u64;
        for round in 0..rounds {
            for k in 0..2 {
                let which = (round + k) % 2;
                let t = Instant::now();
                let r = if which == 0 {
                    unsafe { ssd_serial(&a, &b) }
                } else {
                    unsafe { ssd_avx2(&a, &b) }
                };
                let dt = t.elapsed().as_secs_f64() * 1e3;
                sink = sink.wrapping_add(r);
                times[which].push(dt);
            }
        }
        let (ma, mb) = (med(&times[0]), med(&times[1]));
        println!(
            "  {w}×{h} RGBA = {:.1} MB   parity(exact): {}",
            n as f64 / 1e6,
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
