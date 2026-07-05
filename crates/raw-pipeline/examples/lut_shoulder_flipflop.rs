//! lut_shoulder_flipflop — A/B bench for highlight_shoulder LUT optimization.
//!
//! A (old): scalar division s / (s + range)
//! B (new): 256-entry LUT with linear interpolation
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example lut_shoulder_flipflop

use std::time::Instant;

const HIGHLIGHT_KNEE: f32 = 0.80;

// Original implementation
#[inline(always)]
fn highlight_shoulder_orig(x: f32) -> f32 {
    if x <= HIGHLIGHT_KNEE {
        x
    } else {
        let range = 1.0 - HIGHLIGHT_KNEE;
        let s = x - HIGHLIGHT_KNEE;
        HIGHLIGHT_KNEE + range * s / (s + range)
    }
}

// LUT-based implementation
fn build_shoulder_lut() -> Vec<f32> {
    let mut lut = vec![0.0f32; 256];
    let range = 1.0 - 0.80;
    for i in 0..256 {
        let t = i as f32 / 255.0;
        let s = t * 1.7;
        lut[i] = 0.80 + range * s / (s + range);
    }
    lut
}

#[inline(always)]
fn highlight_shoulder_lut(x: f32, lut: &[f32]) -> f32 {
    if x <= HIGHLIGHT_KNEE {
        x
    } else {
        let s = x - HIGHLIGHT_KNEE;
        let t = (s / 1.7).min(1.0);
        let idx_f = t * 255.0;
        let idx = (idx_f as usize).min(255);
        let frac = idx_f - idx as f32;
        let v0 = lut[idx];
        let v1 = lut[(idx + 1).min(255)];
        v0 + frac * (v1 - v0)
    }
}

fn main() {
    let lut = build_shoulder_lut();
    let n = 10_000_000usize;

    // Generate test data (range [0, ~2.5], typical for pre-LUT input after WB+exposure)
    let mut buf: Vec<f32> = Vec::with_capacity(n);
    let mut s: u32 = 0x9e37_79b9;
    let mut next = || {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (s as f32 / u32::MAX as f32) * 2.5
    };
    for _ in 0..n {
        buf.push(next());
    }

    // Correctness: max diff
    let mut max_diff = 0.0f32;
    for &x in &buf {
        let a = highlight_shoulder_orig(x);
        let b = highlight_shoulder_lut(x, &lut);
        max_diff = max_diff.max((a - b).abs());
    }

    // Timing: interleaved rounds
    let rounds = 11usize;
    let mut ta = Vec::with_capacity(rounds);
    let mut tb = Vec::with_capacity(rounds);
    let mut sink = 0f64;

    let run_a = |sink: &mut f64| {
        let t = Instant::now();
        let mut acc = 0f32;
        for &x in &buf {
            acc += highlight_shoulder_orig(x);
        }
        *sink += acc as f64;
        t.elapsed().as_secs_f64() * 1e3
    };

    let run_b = |sink: &mut f64| {
        let t = Instant::now();
        let mut acc = 0f32;
        let lut_ref = &lut; // capture once, not in loop
        for &x in &buf {
            acc += highlight_shoulder_lut(x, lut_ref);
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

    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec();
        w.sort_by(|a, b| a.partial_cmp(b).unwrap());
        w[w.len() / 2]
    };
    let ma = med(&ta);
    let mb = med(&tb);
    let saved = (ma - mb) / ma * 100.0;

    println!("lut_shoulder_flipflop  n={n}  (sink={sink:.0})");
    println!(
        "  correctness: max_diff={max_diff:.7}  -> {}",
        if max_diff < 0.001 {
            "PASS (≤0.001 tolerance)"
        } else {
            "INVESTIGATE"
        }
    );
    println!("  A (orig):     {ma:.2} ms");
    println!("  B (lut):      {mb:.2} ms");
    println!("  B speedup:    {saved:.1}% faster");
}
