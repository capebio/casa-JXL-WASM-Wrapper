//! srgb8_lut_flip — thermal-cancelled A/B for image_formats::f32_linear_to_srgb8.
//!
//!   A = current: per-channel sRGB OETF via powf(1/2.4) piecewise        (transcendental per channel)
//!   B = LUT:     cached 16384-entry sRGB-encode table + linear interp   (mirrors pipeline::srgb_encode_lerp)
//!
//! This kernel converts interleaved RGBA f32 (linear, HDR) → RGBA8 for EXR/HDR display preview.
//! pipeline.rs already proved the LUT lerp is u8 byte-identical to the powf build on the tone path.
//! Here we re-verify byte-exactness on a continuous HDR input and time it.
//!
//! Interleaved, start-rotated, round 0 dropped. Parity = exact u8 match (diff count printed).
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example srgb8_lut_flip

use std::time::Instant;

#[inline(always)]
fn linear_to_srgb(v: f32) -> f32 {
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055f32.mul_add(v.powf(1.0 / 2.4), -0.055)
    }
}

// ---- A: current powf piecewise ----
fn srgb8_powf(rgba_f32: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba_f32.len());
    for px in rgba_f32.chunks_exact(4) {
        for &c in &px[..3] {
            let c = c.clamp(0.0, 1.0);
            let s = if c <= 0.0031308 {
                12.92 * c
            } else {
                1.055 * c.powf(1.0 / 2.4) - 0.055
            };
            out.push((s * 255.0 + 0.5) as u8);
        }
        out.push((px[3].clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
    }
    out
}

// ---- B: cached LUT + lerp (mirror of pipeline::srgb_encode_lerp) ----
const SRGB_LUT_N: usize = 16384;
fn build_tbl() -> Vec<f32> {
    (0..=SRGB_LUT_N)
        .map(|i| linear_to_srgb(i as f32 / SRGB_LUT_N as f32))
        .collect()
}
#[inline(always)]
fn srgb_encode_lerp(tbl: &[f32], y: f32) -> f32 {
    let pos = y.clamp(0.0, 1.0) * SRGB_LUT_N as f32;
    let i0 = (pos as usize).min(SRGB_LUT_N - 1);
    let frac = pos - i0 as f32;
    tbl[i0] + (tbl[i0 + 1] - tbl[i0]) * frac
}
fn srgb8_lut(rgba_f32: &[f32], tbl: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba_f32.len());
    for px in rgba_f32.chunks_exact(4) {
        for &c in &px[..3] {
            let s = srgb_encode_lerp(tbl, c);
            out.push((s * 255.0 + 0.5) as u8);
        }
        out.push((px[3].clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
    }
    out
}

fn median(v: &[f64]) -> f64 {
    let mut w: Vec<f64> = v[1..].to_vec();
    w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    w[w.len() / 2]
}

fn main() {
    // 12 MP HDR fractal-ish buffer: channel-distinct, peaks > 1.0 to exercise clamp + curve.
    let (w, h) = (4000usize, 3000usize);
    let n = w * h;
    let mut buf = Vec::with_capacity(n * 4);
    for i in 0..n {
        let t = (i as f32 / n as f32);
        let r = (0.5 + 0.5 * (t * 17.0).sin()) * (1.0 + 2.0 * t); // up to ~3.0
        let g = (0.5 + 0.5 * (t * 17.0 + 2.0).sin()) * (1.0 + 2.0 * t);
        let b = (0.5 + 0.5 * (t * 17.0 + 4.0).sin()) * 0.02; // some in the 12.92 linear segment
        buf.extend_from_slice(&[r, g, b, 1.0]);
    }

    let tbl = build_tbl();
    let oa = srgb8_powf(&buf);
    let ob = srgb8_lut(&buf, &tbl);
    let diffs = oa.iter().zip(&ob).filter(|(a, b)| a != b).count();
    let maxdiff = oa
        .iter()
        .zip(&ob)
        .map(|(a, b)| (*a as i32 - *b as i32).abs())
        .max()
        .unwrap_or(0);

    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut sink = 0u64;
    let time_a = |sink: &mut u64| {
        let t = Instant::now();
        let o = srgb8_powf(&buf);
        *sink = sink.wrapping_add(o[o.len() / 2] as u64);
        t.elapsed().as_secs_f64() * 1e3
    };
    let time_b = |sink: &mut u64| {
        let t = Instant::now();
        let o = srgb8_lut(&buf, &tbl);
        *sink = sink.wrapping_add(o[o.len() / 2] as u64);
        t.elapsed().as_secs_f64() * 1e3
    };
    for r in 0..rounds {
        if r % 2 == 0 {
            ta.push(time_a(&mut sink));
            tb.push(time_b(&mut sink));
        } else {
            tb.push(time_b(&mut sink));
            ta.push(time_a(&mut sink));
        }
    }
    std::hint::black_box(sink);
    let (ma, mb) = (median(&ta), median(&tb));
    let saved = (ma - mb) / ma * 100.0;
    println!("srgb8 linear->u8 flip @12MP  A=powf  B=LUT-lerp\n");
    println!("  A powf  {:>8.3} ms", ma);
    println!("  B LUT   {:>8.3} ms   saved {:.1}%", mb, saved);
    println!(
        "  parity: {} byte diffs / {} (max |Δ| = {} u8)",
        diffs,
        oa.len(),
        maxdiff
    );
    println!("\n  Gate >=2% AND byte-exact (0 diffs) -> apply to image_formats.rs.");
}
