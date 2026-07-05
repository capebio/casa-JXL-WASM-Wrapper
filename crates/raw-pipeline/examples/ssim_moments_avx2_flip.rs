//! ssim_moments_avx2_flip — native A/B for the AVX2 SSIM-moment kernels over a real-size
//! (24 MP) deterministic RGBA buffer:
//!
//!   A = `ssim_moments_avx2`      (the shipped, deliberately-scalar moments)
//!   B = `ssim_moments_avx2_cal`  (EXPERIMENTAL channel-as-lane, 8-wide / 2 px per iter)
//!
//! The wasm v128 form of the channel-as-lane layout is bench-measured at 3.73× over
//! scalar; this asks whether the win transfers to AVX2 (8-wide). Start-rotated rounds so
//! drift hits both arms equally; round 0 (warm-up) dropped; median reported. Parity is
//! exact (both produce identical u64 moment tuples).
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example ssim_moments_avx2_flip
use raw_pipeline::perceptual::avx2_kernels::{ssim_moments_avx2, ssim_moments_avx2_cal};
use std::time::Instant;

fn main() {
    if !std::is_x86_feature_detected!("avx2") {
        println!("avx2 unavailable on this CPU — skipping");
        return;
    }
    let (w, h) = (6000usize, 4000usize); // 24 MP
    let np = w * h;

    // Deterministic RGBA test (a) + reference (b) buffers.
    let mut s: u32 = 0x9e37_79b9;
    let mut rnd = || {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (s >> 24) as u8
    };
    let mut a = vec![0u8; np * 4];
    let mut b = vec![0u8; np * 4];
    for i in 0..np * 4 {
        a[i] = rnd();
        b[i] = a[i].wrapping_add(rnd()).wrapping_sub(128);
    }

    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec(); // drop warm-up round 0
        w.sort_by(|x, y| x.partial_cmp(y).unwrap());
        w[w.len() / 2]
    };

    // Parity (exact).
    let ra = unsafe { ssim_moments_avx2(&a, &b, np) };
    let rb = unsafe { ssim_moments_avx2_cal(&a, &b, np) };
    let parity = ra == rb;

    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut sink = 0u64;
    let time = |cal: bool, sink: &mut u64| {
        let t = Instant::now();
        let (sa, _saa, _sab) = if cal {
            unsafe { ssim_moments_avx2_cal(&a, &b, np) }
        } else {
            unsafe { ssim_moments_avx2(&a, &b, np) }
        };
        *sink = sink.wrapping_add(sa[0]);
        t.elapsed().as_secs_f64() * 1e3
    };
    for r in 0..rounds {
        if r % 2 == 0 {
            ta.push(time(false, &mut sink));
            tb.push(time(true, &mut sink));
        } else {
            tb.push(time(true, &mut sink));
            ta.push(time(false, &mut sink));
        }
    }
    let (ma, mb) = (med(&ta), med(&tb));
    println!(
        "ssim_moments_avx2_flip  {w}×{h} = {:.1} MP  (sink={sink})",
        np as f64 / 1e6
    );
    println!(
        "  parity (exact u64 tuples): {}",
        if parity { "PASS" } else { "FAIL" }
    );
    println!("  A scalar (ssim_moments_avx2):     {ma:.2} ms median");
    println!("  B cal    (ssim_moments_avx2_cal): {mb:.2} ms median");
    if ma > 0.0 && mb > 0.0 {
        let pct = (ma - mb) / ma * 100.0;
        println!(
            "  %saved (B vs A): {pct:.1}%   speedup {:.2}×   gate(≥5%): {}",
            ma / mb,
            if pct >= 5.0 { "PASS" } else { "FAIL" }
        );
    }
}
