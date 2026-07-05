//! tone_matrix_prepared_flip — isolates the matrix-fused SEAM at the real per-block granularity.
//!
//!   A = `apply_tone_bulk(m, sat, vib=0, vib_zero=true)`  — REBUILDS `vib_zero_matrix(m,sat)`
//!       on every call (the old `simd_block_kernel` behaviour: once per ~2048-pixel block).
//!   B = `apply_tone_bulk_matrix(prepared)`                — caller-prepared matrix (the new path;
//!       `derive_tone_inputs` builds it ONCE per render, kernel just applies it).
//!
//! Both are byte-exact (locked by `tone_simd::matrix_only_matches_vib_zero_path`); this only
//! measures the per-block rebuild overhead the seam removes. BLK = 2048 (the production block),
//! many reps, interleaved + start-rotated rounds, warm-up round dropped, median reported.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example tone_matrix_prepared_flip
use raw_pipeline::tone_simd::{apply_tone_bulk, apply_tone_bulk_matrix, vib_zero_matrix};
use std::time::Instant;

fn main() {
    const BLK: usize = 2048;
    const REPS: usize = 20_000; // ~ blocks in a 40 MP frame; amortizes timer noise
    let m = [
        [1.526, -0.450, -0.077],
        [-0.245, 1.336, -0.091],
        [0.018, -0.298, 1.281],
    ];
    let sat = 1.30f32;
    let prepared = vib_zero_matrix(&m, sat);

    // Deterministic post-pre-LUT block in the 0..65535 domain.
    let mut s: u32 = 0x9e37_79b9;
    let mut base = vec![0f32; BLK * 3];
    for v in base.iter_mut() {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *v = ((s >> 8) & 0xffff) as f32;
    }

    let med = |v: &[f64]| {
        let mut w = v[1..].to_vec();
        w.sort_by(|a, b| a.partial_cmp(b).unwrap());
        w[w.len() / 2]
    };

    let run_a = |sink: &mut f32| {
        let (mut r, mut g, mut b) = (
            base[..BLK].to_vec(),
            base[BLK..2 * BLK].to_vec(),
            base[2 * BLK..].to_vec(),
        );
        for _ in 0..REPS {
            apply_tone_bulk(&mut r, &mut g, &mut b, &m, sat, 0.0, true);
        }
        *sink += r[BLK / 2] + g[0] + b[BLK - 1];
    };
    let run_b = |sink: &mut f32| {
        let (mut r, mut g, mut b) = (
            base[..BLK].to_vec(),
            base[BLK..2 * BLK].to_vec(),
            base[2 * BLK..].to_vec(),
        );
        for _ in 0..REPS {
            apply_tone_bulk_matrix(&mut r, &mut g, &mut b, &prepared);
        }
        *sink += r[BLK / 2] + g[0] + b[BLK - 1];
    };

    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut sink = 0f32;
    let time = |f: &dyn Fn(&mut f32), sink: &mut f32| {
        let t = Instant::now();
        f(sink);
        t.elapsed().as_secs_f64() * 1e3
    };
    for r in 0..rounds {
        if r % 2 == 0 {
            ta.push(time(&run_a, &mut sink));
            tb.push(time(&run_b, &mut sink));
        } else {
            tb.push(time(&run_b, &mut sink));
            ta.push(time(&run_a, &mut sink));
        }
    }
    let (ma, mb) = (med(&ta), med(&tb));
    println!("tone_matrix_prepared_flip  BLK={BLK} reps={REPS}  (sink={sink:.1})");
    println!("  A rebuild-per-call : {ma:.2} ms median");
    println!("  B prepared-matrix  : {mb:.2} ms median");
    if ma > 0.0 && mb > 0.0 {
        println!(
            "  %saved (B vs A): {:.1}%   speedup {:.3}×",
            (ma - mb) / ma * 100.0,
            ma / mb
        );
        println!(
            "  per-block delta: {:.1} ns (the per-block matrix rebuild the seam removes)",
            (ma - mb) * 1e6 / REPS as f64
        );
    }
}
