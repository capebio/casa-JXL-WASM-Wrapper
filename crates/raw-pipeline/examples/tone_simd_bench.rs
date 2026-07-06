//! 10-cycle flip-flop: scalar vs SIMD `apply_tone_math` (the compute-bound 90%
//! of the tone pass). SoA bulk over 20 M elements (≈ a 20 MP image), both the
//! vib_zero fast path and the vibrance-active (divide) path.
//!
//! Run: cargo run --release --no-default-features --example tone_simd_bench

use raw_pipeline::tone_simd::{apply_tone_bulk, apply_tone_bulk_ref};
use std::time::Instant;

const M: [[f32; 3]; 3] = [[1.7, -0.5, -0.2], [-0.3, 1.4, -0.1], [0.0, -0.4, 1.4]];

fn synth(n: usize) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let mut r = vec![0f32; n];
    let mut g = vec![0f32; n];
    let mut b = vec![0f32; n];
    for i in 0..n {
        let f = i as f32;
        r[i] = (f * 0.0013).sin() * 30000.0 + 30000.0;
        g[i] = (f * 0.0021).cos() * 28000.0 + 30000.0;
        b[i] = (f * 0.0017).sin() * 25000.0 + 28000.0;
    }
    (r, g, b)
}

fn time_one(
    simd: bool,
    base: &(Vec<f32>, Vec<f32>, Vec<f32>),
    sat: f32,
    vib: f32,
    vib_zero: bool,
) -> f64 {
    let (mut r, mut g, mut b) = (base.0.clone(), base.1.clone(), base.2.clone());
    let t = Instant::now();
    if simd {
        apply_tone_bulk(&mut r, &mut g, &mut b, &M, sat, vib, vib_zero);
    } else {
        apply_tone_bulk_ref(&mut r, &mut g, &mut b, &M, sat, vib, vib_zero);
    }
    std::hint::black_box((&r, &g, &b));
    t.elapsed().as_secs_f64() * 1000.0
}

fn run(label: &str, base: &(Vec<f32>, Vec<f32>, Vec<f32>), sat: f32, vib: f32, vib_zero: bool) {
    let rounds = 10;
    let (mut sc, mut si) = (Vec::new(), Vec::new());
    // warmup
    time_one(false, base, sat, vib, vib_zero);
    time_one(true, base, sat, vib, vib_zero);
    for _ in 0..rounds {
        sc.push(time_one(false, base, sat, vib, vib_zero));
        si.push(time_one(true, base, sat, vib, vib_zero));
    }
    sc.sort_by(|a, b| a.partial_cmp(b).unwrap());
    si.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let (cmed, imed) = (sc[rounds / 2], si[rounds / 2]);
    println!(
        "  {:<22} scalar {:7.2} ms  |  simd {:7.2} ms  |  {:.2}x",
        label,
        cmed,
        imed,
        cmed / imed
    );
}

fn main() {
    let n = 20_000_000usize; // ~20 MP
    let base = synth(n);
    println!(
        "apply_tone_math flip-flop — {} M elems, median of 10 rounds",
        n / 1_000_000
    );
    run("vib_zero (sat only)", &base, 1.30, 0.0, true);
    run("vibrance active (div)", &base, 1.30, 0.5, false);
}
