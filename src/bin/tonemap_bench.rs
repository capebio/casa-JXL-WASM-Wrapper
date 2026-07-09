//! Tonemap (RGB16 → RGB8) benchmark — serial vs parallel flipflop.
//!
//! Build & run both ways:
//!   cargo build --bin tonemap_bench --release
//!   cargo build --bin tonemap_bench --release --no-default-features
//!   cargo run --bin tonemap_bench --release
//!
//! Or via flipflop:
//!   cd .flipflop && node tonemap_flipflop.mjs

use raw_pipeline::pipeline::{self, PipelineParams};
use std::time::Instant;

fn synth_rgb16(w: usize, h: usize) -> Vec<u16> {
    (0..(w * h * 3)).map(|i| ((i % 4096) as u16) << 2).collect()
}

fn main() {
    const W: usize = 1920;
    const H: usize = 1440;
    const RUNS: usize = 5;

    let rgb16 = synth_rgb16(W, H);
    let mut out = vec![0u8; rgb16.len()];
    let params = PipelineParams::default_olympus();

    eprintln!(
        "Tonemap bench: {}×{} = {} pixels, {} runs",
        W,
        H,
        W * H,
        RUNS
    );
    eprintln!("Feature parallel: {}", cfg!(feature = "parallel"));

    let mut times = Vec::new();
    for run in 0..RUNS {
        pipeline::parallel_path_reset();
        let t0 = Instant::now();
        pipeline::process_into(&rgb16, &params, &mut out);
        let elapsed = t0.elapsed().as_secs_f64() * 1000.0;
        let parallel_calls = pipeline::parallel_path_call_count();
        times.push(elapsed);
        eprintln!(
            "  run {}: {:.2}ms (parallel_calls={})",
            run + 1,
            elapsed,
            parallel_calls
        );
    }

    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = times[times.len() / 2];
    let min = times[0];
    let max = times[times.len() - 1];

    println!("tonemap_ms={:.2}", median);
    println!("min={:.2}", min);
    println!("max={:.2}", max);
}
