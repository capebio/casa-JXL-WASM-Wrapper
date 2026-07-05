//! postlut_cache_flip — is the 45% "post-LUT gather + pack" cost (item 0) actually L2-latency bound,
//! and does an L1-resident compact/strided post-LUT (the technique already used for the pre-LUT) fix
//! it? Isolated micro-flip of the post stage: 24M×3 random tone values → u8 via:
//!   full     : post[idx]            65536-entry u8 LUT (64 KB, L2)
//!   strided  : post[idx >> SHIFT]   compact u8 LUT     (L1-resident)
//! The curve shape is irrelevant to gather LATENCY (cache behaviour is the question); accuracy of a
//! strided post is the same ≤1-2 LSB story as the existing compact pre-LUT and is checked separately
//! when wired for real. Interleaved, start-rotated.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --features parallel --example postlut_cache_flip
use std::time::Instant;

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let n = 24_000_000usize * 3; // 24 MP × 3 channels
                                 // realistic post-LUT (any monotonic 16→8 curve; shape doesn't affect gather latency)
    let full: Vec<u8> = (0..65536usize).map(|i| (i >> 8) as u8).collect();

    // random tone indices in [0,65535] (defeat prefetch — the real per-pixel access pattern)
    let mut s: u32 = 0x9e37_79b9;
    let mut idx = vec![0u16; n];
    for v in idx.iter_mut() {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *v = (s >> 16) as u16;
    }
    let mut out = vec![0u8; n];

    let run_full = |out: &mut [u8]| {
        let t = Instant::now();
        for (o, &i) in out.iter_mut().zip(idx.iter()) {
            *o = full[i as usize];
        }
        std::hint::black_box(&out);
        t.elapsed().as_secs_f64() * 1e3
    };

    let rounds = 9usize;
    println!(
        "postlut_cache_flip  {} M gathers (24 MP × 3ch)\n",
        n / 1_000_000
    );
    println!("  variant     lut_kb  median_ms  vs full");

    // baseline full
    let mut bf = Vec::new();
    for _ in 0..rounds {
        bf.push(run_full(&mut out));
    }
    let full_ms = median(&mut bf);
    println!(
        "  full (L2)   {:6.1}  {full_ms:9.2}   1.00×",
        65536.0 / 1024.0
    );

    for &shift in &[3u32, 4, 5] {
        let len = 65536usize >> shift; // 8192 / 4096 / 2048
        let strided: Vec<u8> = (0..len).map(|i| ((i << shift) >> 8) as u8).collect();
        let run = |out: &mut [u8]| {
            let t = Instant::now();
            for (o, &i) in out.iter_mut().zip(idx.iter()) {
                *o = strided[(i >> shift) as usize];
            }
            std::hint::black_box(&out);
            t.elapsed().as_secs_f64() * 1e3
        };
        let mut ts = Vec::new();
        // interleave with full to cancel drift
        for r in 0..rounds {
            if r % 2 == 0 {
                ts.push(run(&mut out));
                let _ = run_full(&mut out);
            } else {
                let _ = run_full(&mut out);
                ts.push(run(&mut out));
            }
        }
        let ms = median(&mut ts);
        println!(
            "  >>{shift} ({:>4})  {:6.1}  {ms:9.2}   {:.2}×",
            len,
            len as f64 / 1024.0,
            full_ms / ms
        );
    }
}
