//! S1 parity corpus: end-to-end pipeline on real RAW files.
//!
//! Confirms the canonical crate decodes real ORF + DNG files without panicking,
//! produces correctly-sized non-trivial pixel output, and prints FNV hashes for
//! archival comparison against the old vendored pipeline.
//!
//! Fixture-gated: each test skips gracefully when the asset file is absent.

use raw_pipeline::{dng, pipeline, tiff};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

// ── helpers ──────────────────────────────────────────────────────────────────

fn buf_hash(data: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    data.hash(&mut h);
    h.finish()
}

fn assert_nontrivial(pixels: &[u8], label: &str) {
    let sum: u64 = pixels.iter().map(|&b| b as u64).sum();
    let mean = sum as f64 / pixels.len() as f64;
    assert!(
        mean > 5.0 && mean < 250.0,
        "{label}: mean pixel {mean:.1} out of range 5–250 (all-black or clipped?)"
    );
    let nonzero = pixels.iter().filter(|&&b| b != 0).count();
    assert!(
        nonzero > pixels.len() / 4,
        "{label}: <25% non-zero pixels ({nonzero}/{})",
        pixels.len()
    );
}

// ── ORF corpus ────────────────────────────────────────────────────────────────

fn find_orf() -> Option<Vec<u8>> {
    for p in [
        r"C:\Foo\raw-converter\tests\P1110226.ORF",
        r"C:\Foo\casabio-expedition-planner\.ignore\P1100092 test.ORF",
    ] {
        if let Ok(d) = std::fs::read(p) {
            return Some(d);
        }
    }
    None
}

/// Full ORF → rgba8 pipeline (process_rgba path).
#[test]
fn orf_rgba8_sanity() {
    let data = match find_orf() {
        Some(d) => d,
        None => { eprintln!("SKIP: ORF fixture not found"); return; }
    };

    let (rgba8, w, h) = tiff::decode_orf_rgba8(&data).expect("decode_orf_rgba8");
    assert!(w > 0 && h > 0);
    assert_eq!(rgba8.len(), w as usize * h as usize * 4);
    assert_nontrivial(&rgba8, "orf_rgba8");

    println!("ORF rgba8  {w}×{h}  hash={:#018x}", buf_hash(&rgba8));
}

/// process() (rgb8 path, no width arg) via bench_pipeline_orf — 3 runs, reports avg.
#[test]
fn orf_process_rgb8_timing() {
    let data = match find_orf() {
        Some(d) => d,
        None => { eprintln!("SKIP: ORF fixture not found"); return; }
    };

    const RUNS: usize = 3;
    let mut dec_sum = 0f64;
    let mut dem_sum = 0f64;
    let mut tone_sum = 0f64;
    let mut w = 0u32;
    let mut h = 0u32;

    for _ in 0..RUNS {
        let bench = tiff::bench_pipeline_orf(&data).expect("bench_pipeline_orf");
        dec_sum += bench.decompress_ms;
        dem_sum += bench.demosaic_ms;
        tone_sum += bench.tone_ms;
        w = bench.width;
        h = bench.height;
    }

    let (d, dm, t, total) = (
        dec_sum / RUNS as f64,
        dem_sum / RUNS as f64,
        tone_sum / RUNS as f64,
        (dec_sum + dem_sum + tone_sum) / RUNS as f64,
    );
    println!(
        "CANONICAL  {w}×{h}  decompress={d:.1}ms  demosaic={dm:.1}ms  tone={t:.1}ms  total={total:.1}ms  (avg {RUNS} runs)"
    );
}

/// process() is deterministic: same input → bit-exact same output.
#[test]
fn orf_rgba8_deterministic() {
    let data = match find_orf() {
        Some(d) => d,
        None => { eprintln!("SKIP: ORF fixture not found"); return; }
    };

    let (a, aw, ah) = tiff::decode_orf_rgba8(&data).unwrap();
    let (b, bw, bh) = tiff::decode_orf_rgba8(&data).unwrap();
    assert_eq!((aw, ah), (bw, bh), "dimensions vary across calls");
    assert_eq!(a, b, "decode_orf_rgba8 is non-deterministic");
    println!("ORF determinism OK  {aw}×{ah}");
}

// ── DNG corpus ────────────────────────────────────────────────────────────────

fn find_dng() -> Option<Vec<u8>> {
    for p in [
        r"C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
        "PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
    ] {
        if let Ok(d) = std::fs::read(p) {
            return Some(d);
        }
    }
    None
}

/// DNG demosaiced decode → process() → sanity checks.
#[test]
fn dng_rgb8_sanity() {
    let data = match find_dng() {
        Some(d) => d,
        None => { eprintln!("SKIP: DNG fixture not found"); return; }
    };

    let dem = dng::decode_bytes_demosaiced(&data).expect("decode_bytes_demosaiced");
    let w = dem.width;
    let h = dem.height;
    assert!(w > 0 && h > 0);
    assert_eq!(dem.rgb.len(), w * h * 3, "DngDemosaiced.rgb wrong size");

    let params = pipeline::PipelineParams::default_olympus();
    let rgb8 = pipeline::process(&dem.rgb, &params);
    assert_eq!(rgb8.len(), w * h * 3, "process() output wrong size");
    assert_nontrivial(&rgb8, "dng_rgb8");

    println!("DNG rgb8  {w}×{h}  hash={:#018x}", buf_hash(&rgb8));
}

/// DNG rgb8 is deterministic.
#[test]
fn dng_rgb8_deterministic() {
    let data = match find_dng() {
        Some(d) => d,
        None => { eprintln!("SKIP: DNG fixture not found"); return; }
    };

    let dem1 = dng::decode_bytes_demosaiced(&data).unwrap();
    let dem2 = dng::decode_bytes_demosaiced(&data).unwrap();
    assert_eq!((dem1.width, dem1.height), (dem2.width, dem2.height));
    assert_eq!(dem1.rgb, dem2.rgb, "decode_bytes_demosaiced is non-deterministic");

    let params = pipeline::PipelineParams::default_olympus();
    let out1 = pipeline::process(&dem1.rgb, &params);
    let out2 = pipeline::process(&dem2.rgb, &params);
    assert_eq!(out1, out2, "process() is non-deterministic");
    println!("DNG determinism OK  {}×{}", dem1.width, dem1.height);
}

/// align_to_rggb returns a plain tuple (not Result) — infallible on real file.
#[test]
fn dng_align_to_rggb_infallible() {
    let data = match find_dng() {
        Some(d) => d,
        None => { eprintln!("SKIP: DNG fixture not found"); return; }
    };

    let img = dng::decode_bytes(&data).expect("decode_bytes");
    let (_slice, w, h) = dng::align_to_rggb(&img.raw, img.width, img.height, img.cfa);
    assert!(w > 0 && h > 0);
    println!("align_to_rggb infallible OK  {w}×{h}");
}
