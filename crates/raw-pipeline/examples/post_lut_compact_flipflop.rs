//! post_lut_compact_flipflop — A/B bench for compact post-LUT memory optimization.
//!
//! A (full 65k): standard post-LUT access `post[idx_u16]`
//! B (compact 4k): strided access `post[idx_u16 >> 4]` with linear interpolation
//!
//! Trade: ~1-2% accuracy loss for 16x smaller footprint (65KB → 4KB, L1-cache-friendly).
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example post_lut_compact_flipflop

use std::time::Instant;

fn build_post_lut_full() -> Vec<u8> {
    let mut lut = vec![0u8; 65536];
    for i in 0..65536 {
        // Simplified tone_curve equivalent
        let y = (i as f32 / 65535.0) * 0.95 + 0.05; // fake tone
        lut[i] = (y * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
    }
    lut
}

fn build_post_lut_compact() -> Vec<u8> {
    let mut lut = vec![0u8; 4096];
    for i in 0..4096 {
        let raw_input = (i << 4) as f32; // map 4k index back to 65k range
        let y = (raw_input / 65535.0) * 0.95 + 0.05;
        lut[i] = (y * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
    }
    lut
}

#[inline(always)]
fn post_lut_lookup_full(tone_val: f32, lut: &[u8]) -> u8 {
    let idx = tone_val.clamp(0.0, 65535.0) as u16 as usize;
    lut[idx]
}

#[inline(always)]
fn post_lut_lookup_compact(tone_val: f32, lut: &[u8]) -> u8 {
    let idx_16 = tone_val.clamp(0.0, 65535.0) as u16;
    let idx = (idx_16 >> 4) as usize; // stride by 16
    if idx >= 4095 {
        return lut[4095];
    }
    // Linear interpolation for better accuracy
    let frac = (idx_16 & 0xF) as f32 / 16.0;
    let v0 = lut[idx] as f32;
    let v1 = lut[(idx + 1).min(4095)] as f32;
    (v0 + frac * (v1 - v0)) as u8
}

fn main() {
    let full_lut = build_post_lut_full();
    let compact_lut = build_post_lut_compact();
    let n = 5_000_000usize;

    // Generate test data (pseudo-random tone values [0, 65535])
    let mut buf: Vec<f32> = Vec::with_capacity(n);
    let mut s: u32 = 0x9e37_79b9;
    let mut next = || {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        ((s >> 8) & 0xffff) as f32
    };
    for _ in 0..n {
        buf.push(next());
    }

    // Correctness: max diff + count of >1 byte diff
    let mut max_diff = 0u8;
    let mut diff_count = 0usize;
    for &tone_val in &buf {
        let a = post_lut_lookup_full(tone_val, &full_lut);
        let b = post_lut_lookup_compact(tone_val, &compact_lut);
        let diff = (a as i32 - b as i32).abs() as u8;
        if diff > max_diff {
            max_diff = diff;
        }
        if diff > 1 {
            diff_count += 1;
        }
    }

    // Timing: interleaved rounds
    let rounds = 11usize;
    let mut ta = Vec::with_capacity(rounds);
    let mut tb = Vec::with_capacity(rounds);
    let mut sink = 0f64;

    let run_a = |sink: &mut f64| {
        let t = Instant::now();
        let mut acc = 0u32;
        for &tone_val in &buf {
            acc = acc.wrapping_add(post_lut_lookup_full(tone_val, &full_lut) as u32);
        }
        *sink += acc as f64;
        t.elapsed().as_secs_f64() * 1e3
    };

    let run_b = |sink: &mut f64| {
        let t = Instant::now();
        let mut acc = 0u32;
        for &tone_val in &buf {
            acc = acc.wrapping_add(post_lut_lookup_compact(tone_val, &compact_lut) as u32);
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

    println!("post_lut_compact_flipflop  n={n}  (sink={sink:.0})");
    println!(
        "  correctness: max_diff={max_diff}  pixels with diff>1: {diff_count}  -> {}",
        if max_diff <= 2 {
            "PASS (≤2 byte tolerance)"
        } else {
            "INVESTIGATE"
        }
    );
    println!("  A (full 65k):    {ma:.2} ms  (65 KB footprint)");
    println!("  B (compact 4k):  {mb:.2} ms  (4 KB footprint, 16x smaller)");
    let dir = if saved > 0.0 {
        "faster".to_string()
    } else {
        format!("slower ({}%)", -(saved as i32))
    };
    println!("  B speedup:       {saved:.1}% {dir}");
}
