//! tone_fuse_flipflop — A/B for the vib_zero matrix×saturation fusion.
//!
//! A (unfused): `apply_tone_math` vib_zero path = 3×3 colour matrix + BT.709 luma + sat lerp.
//! B (fused):   `apply_tone_fused` with `S·M` pre-fused by `tone_simd::vib_zero_matrix`
//!              (the SAME helper the SIMD bulk path uses — keeps scalar == SIMD bit-identical).
//!
//! Verifies byte-exactness (max u16 LUT-index diff: the post-LUT indexes by `clamp(0,65535) as u16`,
//! so a 0 index-diff ⇒ identical output bytes) and reports the speedup of dropping luma+blend.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example tone_fuse_flipflop
use raw_pipeline::pipeline::{apply_tone_fused, apply_tone_math};
use raw_pipeline::tone_simd::vib_zero_matrix;
use std::time::Instant;

// A representative camera→sRGB matrix (rows sum near 1, off-diagonals negative).
const M: [[f32; 3]; 3] = [
    [1.70, -0.60, -0.10],
    [-0.20, 1.40, -0.20],
    [0.00, -0.35, 1.35],
];

#[inline(always)]
fn idx(v: f32) -> u16 {
    v.clamp(0.0, 65535.0) as u16
}

fn main() {
    let n: usize = 4_000_000;
    let sat: f32 = 1.28;
    let mf = vib_zero_matrix(&M, sat);

    // Synthetic post-preLUT buffer (values live in [0,65535], the LUT domain).
    let mut buf: Vec<(f32, f32, f32)> = Vec::with_capacity(n);
    let mut s: u32 = 0x9e37_79b9;
    let mut next = || {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        ((s >> 8) & 0xffff) as f32
    };
    for _ in 0..n {
        buf.push((next(), next(), next()));
    }

    // --- Correctness: max abs diff + max u16 LUT-index diff ---
    let mut max_abs = 0f32;
    let mut max_idx = 0i32;
    for &(r, g, b) in &buf {
        let (ar, ag, ab) = apply_tone_math(r, g, b, &M, sat, 0.0, true, false);
        let (br, bg, bb) = apply_tone_fused(r, g, b, &mf);
        max_abs = max_abs
            .max((ar - br).abs())
            .max((ag - bg).abs())
            .max((ab - bb).abs());
        max_idx = max_idx
            .max((idx(ar) as i32 - idx(br) as i32).abs())
            .max((idx(ag) as i32 - idx(bg) as i32).abs())
            .max((idx(ab) as i32 - idx(bb) as i32).abs());
    }

    // --- Timing: interleaved rounds, start-rotated so any drift hits both arms equally ---
    let rounds = 11usize;
    let mut ta = Vec::with_capacity(rounds);
    let mut tb = Vec::with_capacity(rounds);
    let mut sink = 0f64;
    let run_a = |sink: &mut f64| {
        let t = Instant::now();
        let mut acc = 0f32;
        for &(r, g, b) in &buf {
            let (x, y, z) = apply_tone_math(r, g, b, &M, sat, 0.0, true, false);
            acc += x + y + z;
        }
        *sink += acc as f64;
        t.elapsed().as_secs_f64() * 1e3
    };
    let run_b = |sink: &mut f64| {
        let t = Instant::now();
        let mut acc = 0f32;
        for &(r, g, b) in &buf {
            let (x, y, z) = apply_tone_fused(r, g, b, &mf);
            acc += x + y + z;
        }
        *sink += acc as f64;
        t.elapsed().as_secs_f64() * 1e3
    };
    for round in 0..rounds {
        if round % 2 == 0 {
            ta.push(run_a(&mut sink));
            tb.push(run_b(&mut sink));
        } else {
            tb.push(run_b(&mut sink));
            ta.push(run_a(&mut sink));
        }
    }

    // Drop round 0 (warm-up) and take the median.
    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec();
        w.sort_by(|a, b| a.partial_cmp(b).unwrap());
        w[w.len() / 2]
    };
    let ma = med(&ta);
    let mb = med(&tb);
    let saved = (ma - mb) / ma * 100.0;

    println!("tone_fuse_flipflop  n={n} sat={sat}  (sink={sink:.0})");
    println!(
        "  correctness: max_abs_diff={max_abs:.5}  max_u16_index_diff={max_idx}  -> {}",
        if max_idx == 0 {
            "BYTE-EXACT through post-LUT"
        } else {
            "differs (inspect LUT shoulders)"
        }
    );
    println!("  A unfused (matrix+luma+sat): {ma:.2} ms median");
    println!("  B fused   (S·M matvec):      {mb:.2} ms median");
    println!("  %saved (B vs A): {saved:.1}%");
}
