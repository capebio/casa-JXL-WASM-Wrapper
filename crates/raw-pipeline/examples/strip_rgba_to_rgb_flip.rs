//! strip_rgba_to_rgb_flip — thermal-cancelled A/B/B2 for the RGBA8→RGB8 strip
//! (casabio_encode.rs `strip_rgba_to_rgb`). Handoff item 1.
//!
//! The no-alpha (RAW) encode path strips RGBA→RGB for EVERY variant size (thumb,
//! preview, full) and EVERY pyramid level before handing pixels to libjxl. So this
//! tiny kernel runs 3–7× per image. Bandwidth-bound.
//!
//!   A  = current:  Vec::with_capacity(n*3) + extend_from_slice(&px[0..3]) per chunk
//!                  → 1 write pass, but a per-chunk len-update + 3-byte memcpy call.
//!   B1 = handoff:  vec![0u8; n*3] + zip chunks_exact_mut(3) direct byte writes
//!                  → no per-chunk len update, BUT pays a full memset before overwrite
//!                    (2 write passes — the hidden cost the flip exists to expose).
//!   B2 = collect:  with_capacity(n*3) + extend(chunks_exact(4).flat_map([r,g,b]))
//!                  → 1 write pass, no memset, no per-chunk extend_from_slice call.
//!
//! Interleaved start-rotated rounds (cancels thermal drift); round-0 sample per
//! variant dropped; median + %saved vs A. Parity asserted byte-EXACT across all three.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example strip_rgba_to_rgb_flip

use std::time::Instant;

/// A — current casabio_encode.rs strip.
fn strip_a(rgba: &[u8]) -> Vec<u8> {
    let n = rgba.len() / 4;
    let mut rgb = Vec::with_capacity(n * 3);
    for px in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&px[0..3]);
    }
    rgb
}

/// B1 — handoff version: exact-size vec (zero-init) + direct slot writes.
fn strip_b1(rgba: &[u8]) -> Vec<u8> {
    let mut rgb = vec![0u8; rgba.len() / 4 * 3];
    for (src, dst) in rgba.chunks_exact(4).zip(rgb.chunks_exact_mut(3)) {
        dst[0] = src[0];
        dst[1] = src[1];
        dst[2] = src[2];
    }
    rgb
}

/// B2 — no-memset, single-pass: reserve exact, extend from a flat byte iterator.
fn strip_b2(rgba: &[u8]) -> Vec<u8> {
    let n = rgba.len() / 4;
    let mut rgb = Vec::with_capacity(n * 3);
    rgb.extend(rgba.chunks_exact(4).flat_map(|px| [px[0], px[1], px[2]]));
    rgb
}

fn median(v: &[f64]) -> f64 {
    // drop the first recorded sample (warm-up) for this variant
    let mut w: Vec<f64> = v[1..].to_vec();
    w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    w[w.len() / 2]
}

fn main() {
    // Strip runs at every level — measure full-res down to thumb.
    let cases: &[(usize, usize, &str)] = &[
        (6000, 4000, "24.0 MP full"),
        (1620, 1080, "1.75 MP preview"),
        (450, 300, "0.14 MP thumb"),
    ];

    println!("strip_rgba_to_rgb flip — RGBA8→RGB8 (no-alpha RAW path), opaque input");
    println!(
        "  A=with_capacity+extend_from_slice  B1=vec![0]+zip-write  B2=with_capacity+flat_map\n"
    );
    println!(
        "{:>16} | {:>9} {:>9} {:>9} | {:>8} {:>8} | winner",
        "case", "A_ms", "B1_ms", "B2_ms", "B1 %sav", "B2 %sav"
    );

    let rounds = 12usize;
    let mut all_pass_gate = true;

    for &(w, h, label) in cases {
        // Deterministic opaque RGBA (alpha=255 — the RAW path that hits strip).
        let mut s: u32 = 0x9e37_79b9;
        let mut rgba = vec![0u8; w * h * 4];
        for (i, slot) in rgba.iter_mut().enumerate() {
            if i % 4 == 3 {
                *slot = 255;
            } else {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *slot = (s >> 24) as u8;
            }
        }

        // Parity — byte EXACT across all three.
        let a0 = strip_a(&rgba);
        let b1 = strip_b1(&rgba);
        let b2 = strip_b2(&rgba);
        assert_eq!(a0, b1, "{label}: B1 parity broken");
        assert_eq!(a0, b2, "{label}: B2 parity broken");

        let runs: [&dyn Fn(&[u8]) -> Vec<u8>; 3] = [&strip_a, &strip_b1, &strip_b2];
        let mut times = [Vec::new(), Vec::new(), Vec::new()];
        let mut sink = 0u64;
        for r in 0..rounds {
            for k in 0..3 {
                let idx = (r + k) % 3; // start-rotation cancels position bias
                let t = Instant::now();
                let out = runs[idx](&rgba);
                sink = sink.wrapping_add(out[out.len() / 2] as u64);
                times[idx].push(t.elapsed().as_secs_f64() * 1e3);
            }
        }
        std::hint::black_box(sink);

        let ma = median(&times[0]);
        let mb1 = median(&times[1]);
        let mb2 = median(&times[2]);
        let sav1 = (ma - mb1) / ma * 100.0;
        let sav2 = (ma - mb2) / ma * 100.0;
        let best = if mb2 <= mb1 && mb2 <= ma {
            "B2"
        } else if mb1 < ma {
            "B1"
        } else {
            "A"
        };
        if sav2 < 5.0 && sav1 < 5.0 {
            all_pass_gate = false;
        }
        println!(
            "{:>16} | {:>9.3} {:>9.3} {:>9.3} | {:>7.1}% {:>7.1}% | {}",
            label, ma, mb1, mb2, sav1, sav2, best
        );
    }

    println!(
        "\nGate ≥5% %saved on the dominant 24MP case decides item 1. {}",
        if all_pass_gate {
            "(some case passed)"
        } else {
            "(check 24MP row)"
        }
    );
}
