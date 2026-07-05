//! dng_mhc_interior_flip — thermal-cancelled A/B for the DNG MHC demosaic interior split.
//! Not memcpy/shuffle: a data-dependent gather kernel where the win is dropping 4 per-pixel
//! clamp() calls in the interior (clamp of an in-bounds index is the identity).
//!
//!   A = all-clamped reference (pre)   B = interior-split (clamp only at borders)
//!
//! Interleaved start-rotated rounds; round 0 dropped; median + %saved. Parity byte-EXACT.
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example dng_mhc_interior_flip
use raw_pipeline::demosaic::{demosaic_bayer_mhc, demosaic_bayer_mhc_clamped_ref};
use std::time::Instant;

fn main() {
    let (w, h) = (4000usize, 3000usize); // 12 MP, typical phone DNG
    let phase = (0u8, 0u8);
    let mut s: u32 = 0x9e37_79b9;
    let raw: Vec<u16> = (0..w * h)
        .map(|_| {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((s >> 12) & 0x3fff) as u16
        })
        .collect();

    let exact = demosaic_bayer_mhc(&raw, w, h, phase).unwrap()
        == demosaic_bayer_mhc_clamped_ref(&raw, w, h, phase).unwrap();

    let med = |v: &[f64]| {
        let mut x: Vec<f64> = v[1..].to_vec();
        x.sort_by(|a, b| a.partial_cmp(b).unwrap());
        x[x.len() / 2]
    };
    let time = |f: &dyn Fn() -> Vec<u16>, sink: &mut u64| {
        let t = Instant::now();
        let out = f();
        *sink = sink.wrapping_add(out[out.len() / 2] as u64);
        t.elapsed().as_secs_f64() * 1e3
    };
    let run_a = || demosaic_bayer_mhc_clamped_ref(&raw, w, h, phase).unwrap();
    let run_b = || demosaic_bayer_mhc(&raw, w, h, phase).unwrap();

    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut sink = 0u64;
    for r in 0..rounds {
        if r % 2 == 0 {
            ta.push(time(&run_a, &mut sink));
            tb.push(time(&run_b, &mut sink));
        } else {
            tb.push(time(&run_b, &mut sink));
            ta.push(time(&run_a, &mut sink));
        }
    }
    std::hint::black_box(sink);
    let (ma, mb) = (med(&ta), med(&tb));
    println!(
        "DNG MHC demosaic interior-split flip  {w}x{h} (12 MP)  parity: {}",
        if exact { "EXACT" } else { "DIFF!" }
    );
    println!(
        "  clamped(ref)={ma:.3}ms  interior-split={mb:.3}ms  saved={:.1}% ({:.1}ms)",
        (ma - mb) / ma * 100.0,
        ma - mb
    );
    assert!(exact, "parity broken");
}
