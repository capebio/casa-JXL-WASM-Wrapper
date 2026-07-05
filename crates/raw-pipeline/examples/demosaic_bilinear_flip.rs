//! Flipflop: demosaic_rggb (RGGB-specialized bilinear) vs demosaic_bayer (generic CFA-dispatch bilinear).
//! ADR-4 claim: RGGB-specialized path +22% vs generic per-pixel CFA-dispatch.
//! Gate: ≥5% speedup to PASS.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example demosaic_bilinear_flip

use raw_pipeline::demosaic::{demosaic_bayer, demosaic_rggb};

fn make_bayer(width: usize, height: usize, seed: u32) -> Vec<u16> {
    let mut s = seed;
    (0..width * height)
        .map(|_| {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((s >> 12) & 0x3fff) as u16
        })
        .collect()
}

fn median(v: &mut Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn bench_pair(raw: &[u16], w: usize, h: usize, rounds: usize, iters: usize) -> (f64, f64) {
    // Warmup
    for _ in 0..3 {
        std::hint::black_box(demosaic_rggb(raw, w, h).unwrap());
        std::hint::black_box(demosaic_bayer(raw, w, h, (0, 0)).unwrap());
    }

    let mut ta: Vec<f64> = Vec::with_capacity(rounds);
    let mut tb: Vec<f64> = Vec::with_capacity(rounds);

    for r in 0..rounds {
        let time_a = || -> f64 {
            let t = std::time::Instant::now();
            for _ in 0..iters {
                std::hint::black_box(demosaic_rggb(raw, w, h).unwrap());
            }
            t.elapsed().as_secs_f64() * 1000.0 / iters as f64
        };
        let time_b = || -> f64 {
            let t = std::time::Instant::now();
            for _ in 0..iters {
                std::hint::black_box(demosaic_bayer(raw, w, h, (0, 0)).unwrap());
            }
            t.elapsed().as_secs_f64() * 1000.0 / iters as f64
        };
        if r % 2 == 0 {
            ta.push(time_a());
            tb.push(time_b());
        } else {
            tb.push(time_b());
            ta.push(time_a());
        }
    }

    (median(&mut ta), median(&mut tb))
}

fn main() {
    let sizes: &[(usize, usize, &str)] = &[
        (512, 512, "0.26MP"),
        (1024, 1024, "1.05MP"),
        (2048, 2048, "4.19MP"),
        (4096, 4096, "16.78MP"),
    ];

    println!("\n=== DEMOSAIC FLIPFLOP: demosaic_rggb (A) vs demosaic_bayer (B) ===");
    println!("    Gate: A speedup over B ≥5%\n");

    // Parity check on 512×512
    {
        let raw = make_bayer(512, 512, 42);
        let out_a = demosaic_rggb(&raw, 512, 512).unwrap();
        let out_b = demosaic_bayer(&raw, 512, 512, (0, 0)).unwrap();
        let exact = out_a == out_b;
        println!(
            "  Parity (512×512): {}",
            if exact { "EXACT" } else { "DIFF! *** BUG ***" }
        );
        if !exact {
            // Show first mismatch
            for i in 0..out_a.len() {
                if out_a[i] != out_b[i] {
                    println!(
                        "    First diff at index {}: rggb={} bayer={}",
                        i, out_a[i], out_b[i]
                    );
                    break;
                }
            }
        }
        println!();
    }

    let rounds = 11usize;
    let mut all_speedups: Vec<f64> = Vec::new();

    for &(w, h, label) in sizes {
        let raw = make_bayer(w, h, 0xdeadbeef);
        // Calibrate iters: aim for ~200ms per arm per round
        let iters = {
            // rough estimate: rggb ≈ 400 MP/s on modern x86
            let mpix = (w * h) as f64 / 1e6;
            let ms_per_call = mpix / 400.0 * 1000.0; // rough
            let target_ms = 50.0_f64;
            ((target_ms / ms_per_call).ceil() as usize).max(1).min(20)
        };

        let (ma, mb) = bench_pair(&raw, w, h, rounds, iters);
        let speedup = mb / ma;
        let pct_saved = (mb - ma) / mb * 100.0;
        all_speedups.push(speedup);

        let gate = if speedup >= 1.05 { "PASS" } else { "FAIL" };
        println!("  [{gate}] {label} ({w}×{h}):  rggb={ma:.3}ms  bayer={mb:.3}ms  speedup={speedup:.2}x  saved={pct_saved:.1}%");
    }

    println!();
    let overall = all_speedups.iter().sum::<f64>() / all_speedups.len() as f64;
    let gate_pass = overall >= 1.05;
    let verdict = if gate_pass { "PASS" } else { "FAIL" };
    println!("  Overall avg speedup: {overall:.2}x  → GATE: {verdict} (threshold 1.05×)");

    // Print the largest size result for structured output
    let (w, h, _) = sizes[3];
    let raw_large = make_bayer(w, h, 0xdeadbeef);
    let iters = 3usize;
    let (ma_large, mb_large) = bench_pair(&raw_large, w, h, rounds, iters);
    let speedup_large = mb_large / ma_large;
    println!("\n  4096×4096 summary: rggb={ma_large:.3}ms  bayer={mb_large:.3}ms  speedup={speedup_large:.3}x");
    println!("  STRUCTURED: variant=demosaic_rggb msec={ma_large:.3} speedup={speedup_large:.3} gatePass={gate_pass}");
}
