//! alpha_stepby_flip — thermal-cancelled A/B for casabio_encode.rs
//! `has_meaningful_alpha`. Handoff item 3 (alpha-only traversal).
//!
//! Runs once per encode on the full-res input to pick RGB vs RGBA. For RAW
//! (always opaque) it is a full no-early-exit scan of 24MP — the dominant case.
//!
//!   A = current:  rgba.chunks_exact(4).any(|px| px[3] < 255)   — 4-byte windows, reads px[3]
//!   B = step_by:  rgba[3..].iter().step_by(4).any(|&a| a < 255) — alpha bytes only
//!
//! Memory traffic is identical (same cache lines touched); the question is whether the
//! strided single-byte loop (B) beats the contiguous chunk loop (A) in issued work, or
//! loses prefetch/vectorization. Interleaved start-rotated; round 0 dropped; parity EXACT.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example alpha_stepby_flip

use std::time::Instant;

fn alpha_a(rgba: &[u8]) -> bool {
    rgba.chunks_exact(4).any(|px| px[3] < 255)
}

fn alpha_b(rgba: &[u8]) -> bool {
    rgba[3..].iter().step_by(4).any(|&a| a < 255)
}

fn median(v: &[f64]) -> f64 {
    let mut w: Vec<f64> = v[1..].to_vec();
    w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    w[w.len() / 2]
}

fn run_case(label: &str, rgba: &[u8], expect: bool) {
    assert_eq!(alpha_a(rgba), expect, "{label}: A wrong result");
    assert_eq!(
        alpha_b(rgba),
        expect,
        "{label}: B wrong result / parity broken"
    );

    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut sink = 0u64;
    let time = |f: &dyn Fn(&[u8]) -> bool, sink: &mut u64| {
        let t = Instant::now();
        let out = f(rgba);
        *sink = sink.wrapping_add(out as u64);
        t.elapsed().as_secs_f64() * 1e3
    };
    for r in 0..rounds {
        if r % 2 == 0 {
            ta.push(time(&alpha_a, &mut sink));
            tb.push(time(&alpha_b, &mut sink));
        } else {
            tb.push(time(&alpha_b, &mut sink));
            ta.push(time(&alpha_a, &mut sink));
        }
    }
    std::hint::black_box(sink);
    let (ma, mb) = (median(&ta), median(&tb));
    let saved = (ma - mb) / ma * 100.0;
    println!(
        "{:>22} | A {:>8.4}ms  B {:>8.4}ms  saved {:>6.1}%  (result {})",
        label, ma, mb, saved, expect
    );
}

fn main() {
    let (w, h) = (6000usize, 4000usize); // 24 MP
    let n = w * h;

    // Opaque — full scan, no early exit. The dominant RAW case.
    let opaque = vec![255u8; n * 4];

    // One transparent pixel at the very end — worst case for both (full scan, then true).
    let mut tail = vec![255u8; n * 4];
    tail[n * 4 - 1] = 128;

    println!("has_meaningful_alpha flip — A=chunks_exact(4).any  B=[3..].step_by(4).any  @24MP\n");
    run_case("opaque (false)", &opaque, false);
    run_case("alpha at tail (true)", &tail, true);
    println!(
        "\nGate ≥5% on the opaque row decides item 3. If A ≥ B, keep current chunks_exact form."
    );
}
