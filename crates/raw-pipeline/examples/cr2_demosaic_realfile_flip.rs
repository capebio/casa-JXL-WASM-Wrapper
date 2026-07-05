//! Real-file demosaic flipflop: bilinear (demosaic_rggb) vs MHC (demosaic_bayer_mhc)
//! on the actual _MG_1744.CR2 Canon raw file (5616×3744).
//!
//! Gate: bilinear ≥5% faster than MHC? (expected: bilinear is faster — MHC trades
//! speed for quality). pixelsIdentical tracks whether the two algorithms agree (they won't —
//! different algorithms produce different interpolations).
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features \
//!          --example cr2_demosaic_realfile_flip -- [path/to/_MG_1744.CR2]

use raw_pipeline::cr2;
use raw_pipeline::demosaic::{demosaic_bayer_mhc, demosaic_rggb};
use std::time::Instant;

fn median(v: &mut Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn checksum(data: &[u16]) -> u64 {
    // FNV-1a 64-bit over u16 words
    let mut h: u64 = 14_695_981_039_346_656_037;
    for &v in data {
        h ^= v as u64;
        h = h.wrapping_mul(1_099_511_628_211);
    }
    h
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cr2_path = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| r"C:/Foo/raw-converter/tests/_MG_1744.CR2".into());

    eprintln!("Reading {cr2_path} ...");
    let data = std::fs::read(&cr2_path).unwrap_or_else(|e| panic!("Cannot read {cr2_path}: {e}"));

    eprintln!("Decoding CR2 (LJPEG + crop, not timed) ...");
    let img = cr2::decode_bytes(&data).unwrap_or_else(|e| panic!("CR2 decode failed: {e}"));

    let w = img.width;
    let h = img.height;
    let raw = &img.raw;
    let phase = (0u8, 0u8); // RGGB — CR2 Bayer phase

    eprintln!(
        "CR2 decoded: {w}x{h} ({:.1} MP)  black={} white={}",
        w as f64 * h as f64 / 1e6,
        img.black,
        img.white
    );
    eprintln!("Model: {} {}  ISO: {:?}", img.make, img.model, img.iso);
    eprintln!("Running demosaic flipflop (bilinear vs MHC) ...\n");

    // Warmup (3 rounds, not counted)
    for _ in 0..2 {
        let _ = std::hint::black_box(demosaic_rggb(raw, w, h).unwrap());
        let _ = std::hint::black_box(demosaic_bayer_mhc(raw, w, h, phase).unwrap());
    }

    let rounds = 9usize; // 9 interleaved rounds; round 0 kept (already warmed)
    let mut ta: Vec<f64> = Vec::with_capacity(rounds);
    let mut tb: Vec<f64> = Vec::with_capacity(rounds);

    let mut sum_a = 0u64;
    let mut sum_b = 0u64;

    for r in 0..rounds {
        if r % 2 == 0 {
            let t = Instant::now();
            let out = demosaic_rggb(raw, w, h).unwrap();
            ta.push(t.elapsed().as_secs_f64() * 1e3);
            sum_a = sum_a.wrapping_add(checksum(&out));

            let t = Instant::now();
            let out = demosaic_bayer_mhc(raw, w, h, phase).unwrap();
            tb.push(t.elapsed().as_secs_f64() * 1e3);
            sum_b = sum_b.wrapping_add(checksum(&out));
        } else {
            let t = Instant::now();
            let out = demosaic_bayer_mhc(raw, w, h, phase).unwrap();
            tb.push(t.elapsed().as_secs_f64() * 1e3);
            sum_b = sum_b.wrapping_add(checksum(&out));

            let t = Instant::now();
            let out = demosaic_rggb(raw, w, h).unwrap();
            ta.push(t.elapsed().as_secs_f64() * 1e3);
            sum_a = sum_a.wrapping_add(checksum(&out));
        }
    }
    std::hint::black_box((sum_a, sum_b));

    let ma = median(&mut ta);
    let mb = median(&mut tb);

    // Verify each algorithm is deterministic (same output every call): run each once more
    let out_bilinear = demosaic_rggb(raw, w, h).unwrap();
    let out_bilinear2 = demosaic_rggb(raw, w, h).unwrap();
    let bilinear_stable = out_bilinear == out_bilinear2;

    // bilinear vs MHC are different algorithms — they will not be pixel-identical
    let out_mhc = demosaic_bayer_mhc(raw, w, h, phase).unwrap();
    let pixels_identical = out_bilinear == out_mhc;

    let speedup = mb / ma; // how much faster is bilinear (A) vs MHC (B)?
    let pct = (mb - ma) / mb * 100.0;
    let gate = speedup >= 1.05;

    println!("=== DEMOSAIC REALFILE FLIPFLOP: bilinear vs MHC ===");
    println!("File:  {cr2_path}");
    println!("Size:  {w}×{h} ({:.1} MP)", w as f64 * h as f64 / 1e6);
    println!("Model: {} {}", img.make.trim(), img.model.trim());
    println!();
    println!("  bilinear (rggb)  median = {ma:.1} ms");
    println!("  MHC              median = {mb:.1} ms");
    println!("  speedup (bilinear/MHC) = {speedup:.3}x  ({pct:.1}% faster)");
    println!("  gate ≥1.05× : {}", if gate { "PASS" } else { "FAIL" });
    println!();
    println!("  bilinear deterministic : {bilinear_stable}");
    println!("  pixels identical (bilinear==MHC) : {pixels_identical}  (expected: false — different algos)");
    println!();
    println!("  chk_bilinear = {:016x}", checksum(&out_bilinear));
    println!("  chk_mhc      = {:016x}", checksum(&out_mhc));
    println!();
    if speedup >= 1.05 {
        println!("VERDICT: bilinear is {speedup:.2}x faster on real {w}×{h} CR2 — gate PASSES.");
        println!("  Memory-bound profile confirmed. MHC is quality-only; reject for speed path.");
    } else if speedup >= 1.0 {
        println!("VERDICT: bilinear marginally faster ({speedup:.2}x) — gate FAILS (< 1.05×).");
        println!("  On real files MHC overhead is negligible. Re-evaluate.");
    } else {
        println!(
            "VERDICT: MHC faster than bilinear ({speedup:.2}x) — unexpected. Check build flags."
        );
    }
}
