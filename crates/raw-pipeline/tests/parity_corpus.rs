//! S1 parity corpus + S4 golden SHA ledger: end-to-end pipeline on real RAW
//! files, plus a machine-independent ledger over the checked-in fixtures.
//!
//! Confirms the canonical crate decodes real ORF + DNG files without panicking,
//! produces correctly-sized non-trivial pixel output, and — new in S4 — asserts
//! the decoded-pixel digests against pinned values so any silent pixel drift
//! (a colour-math or parser change) fails CI instead of shipping.
//!
//! ## Ledger design (S4)
//! Two tiers:
//!   1. **Machine-gated RAW tier** — real ORF/DNG on this dev box. Skips
//!      gracefully when absent (other machines / CI). Pinned digests reuse the
//!      values recorded in `docs/S1-timings-report.md`.
//!   2. **Always-present fixture tier** (`golden_fixture_ledger`) — the checked-in
//!      `tests/fixtures/mandelbrot_*` TIFF/EXR. Runs everywhere including CI, so
//!      the ledger is never all-skipped.
//!
//! ## Determinism contract
//! Digests are `std::hash::DefaultHasher` (SipHash-1-3 with fixed keys —
//! stable within a Rust release, deterministic across processes/threads). The
//! pins were verified reproducible on rustc 1.95.0 across TWO independent
//! release builds — one `-C target-cpu=native` (AVX2 demosaic/decompress) and
//! one scalar — proving the SIMD paths are byte-exact vs scalar at the whole
//! pipeline level. Run single-threaded (`--test-threads=1`) for the ledger; the
//! pipeline's internal rayon is per-pixel deterministic so the digest is
//! thread-count-invariant, but pinning ST removes any doubt.
//!
//! If a pin ever legitimately changes (intentional colour-pipeline evolution),
//! update the constant AND record the reason in `docs/S1-timings-report.md`.
//! Never "silently adopt" a new digest.

use raw_pipeline::{dng, image_formats, pipeline, tiff};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

// ── pinned digests (S4 golden ledger) ─────────────────────────────────────────
// RAW tier — reused verbatim from docs/S1-timings-report.md (rustc 1.95.0).
// Re-pinned 2026-07-08 to the corrected output after intentional, author-validated tone/colour
// fixes flowed into main via the jul07 aggregation. NOT silent — drift traced to the exact fixes
// below; verify visually via the S5 golden-approval workflow if in doubt.
// Re-pinned 2026-07-28 for the MHC demosaic correctness fix. Two changes moved these,
// both demosaic-only (no tone/colour math was touched):
//   1. B-at-R now takes the same gradient correction R-at-B always took. The kernel was
//      asymmetric under R/B exchange — blue came out blurred where red came out sharpened,
//      on the same quincunx (see `mhc_red_blue_exchange_invariant`).
//   2. MHC's cross-channel gradient terms are scaled by the WB ratios, because the mosaic
//      reaching the demosaic is unbalanced (raw green sits ~1.9× above R/B). dcraw/LibRaw
//      get this by running scale_colors() before demosaic; we scale in-kernel to keep the
//      mosaic in its native domain for the denoiser (see `MhcGains`).
// Validated over the 11-frame Gobabeb corpus, each scored on its own worst-speckle 512²
// window: green-magenta Nyquist chroma −43% mean, CFA-lattice chroma spread −33% mean,
// all 11 frames improving on both (bliss/gobabeb-comparison/index.html).
// Re-pinned 2026-07-29 (HANDOFF-orf-baseline items 4 + 2 + 1, one session):
//   4. decode_orf_rgba8 made app-representative — black=256, camera WB (gray-world
//      fallback), MakerNote 0x1011 matrix, WB-scaled MHC gains, like decode_orf_raw.
//   2. native-ISO ORF baseline 1.40 → ORF_BASELINE_EXP_EV (1.6), per-shot via
//      pipeline::orf_baseline_ev — P1110226 is native-ISO so its render brightened.
//   1. base-ISO chroma-only NR (apply_chroma_nr @ ORF_BASE_ISO_CHROMA_NR, iso<1600),
//      matching the app's finish_from_raw.
// Intentional; DNG pin untouched (CR2/DNG keep BASELINE_EXP_EV, no chroma NR).
const ORF_RGBA8_HASH: u64 = 0x1cc3_46e7_3c26_d8cb; // P1110226.ORF → decode_orf_rgba8 (was 0xda80_8882_dc6b_1e96; placeholder params + legacy 1.40 + no chroma NR)
const DNG_RGB8_HASH: u64 = 0x40c9_457b_04b0_b032; //  PXL…dng → process() rgb8 (was 0x7a27_17d8_cdbb_e4c2; same MHC fix)
// Fixture tier — captured on rustc 1.95.0 from the checked-in mandelbrot assets.
// tiff8 == exr-display: the EXR is the HDR-linear twin of the same pattern the
// 8-bit TIFF stores as sRGB, so linear→sRGB8 display reproduces the TIFF exactly
// (an intentional cross-check, not a collision — 256 KiB SipHash collision ≈ 2^-64).
const FIX_TIFF8_HASH: u64 = 0x59c4_4f57_580a_1f5a;
const FIX_TIFF16_HASH: u64 = 0x09c1_95e2_e8ad_c961;
const FIX_EXR_DISP8_HASH: u64 = 0x59c4_4f57_580a_1f5a;

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

    let hash = buf_hash(&rgba8);
    println!("ORF rgba8  {w}×{h}  hash={hash:#018x}");
    // S4 golden ledger: pixel digest is pinned. A mismatch = the ORF→rgba8 path
    // changed output (parser, demosaic, or tone math). If intentional, update
    // ORF_RGBA8_HASH + docs/S1-timings-report.md; never adopt silently.
    assert_eq!(
        hash, ORF_RGBA8_HASH,
        "ORF rgba8 digest drift: got {hash:#018x}, pinned {ORF_RGBA8_HASH:#018x}"
    );
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

    let hash = buf_hash(&rgb8);
    println!("DNG rgb8  {w}×{h}  hash={hash:#018x}");
    // S4 golden ledger: pinned decoded-pixel digest (see ORF note above).
    assert_eq!(
        hash, DNG_RGB8_HASH,
        "DNG rgb8 digest drift: got {hash:#018x}, pinned {DNG_RGB8_HASH:#018x}"
    );
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

// ── Always-present fixture ledger (S4) ─────────────────────────────────────────

const FIX_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

/// Golden SHA ledger over the checked-in mandelbrot fixtures. Unlike the RAW
/// tier this needs no machine-local asset, so it runs everywhere (incl. CI) and
/// guards the TIFF/EXR ingest + display-conversion paths against silent drift.
///
/// Digests below are pinned; a mismatch means `image_formats` decode changed
/// output. Update the constant + note the reason if the change is intentional.
#[test]
fn golden_fixture_ledger() {
    // 8-bit TIFF → RGBA8 planar decode.
    let t8 = image_formats::decode_tiff_bytes(
        &std::fs::read(format!("{FIX_DIR}/mandelbrot_u8.tiff")).unwrap(),
    )
    .unwrap();
    assert_eq!((t8.width, t8.height, t8.bit_depth), (256, 256, 8));
    let h8 = buf_hash(&t8.u8);
    println!("FIX tiff8   256×256  hash={h8:#018x}");

    // 16-bit TIFF → RGBA16; hash the little-endian byte view for a stable digest.
    let t16 = image_formats::decode_tiff_bytes(
        &std::fs::read(format!("{FIX_DIR}/mandelbrot_u16.tiff")).unwrap(),
    )
    .unwrap();
    assert_eq!((t16.width, t16.height, t16.bit_depth), (256, 256, 16));
    let t16_bytes: Vec<u8> = t16.u16.iter().flat_map(|v| v.to_le_bytes()).collect();
    let h16 = buf_hash(&t16_bytes);
    println!("FIX tiff16  256×256  hash={h16:#018x}");

    // EXR f32 HDR → linear→sRGB8 display conversion (the shipped display path).
    let exr = image_formats::decode_exr_bytes(
        &std::fs::read(format!("{FIX_DIR}/mandelbrot_f32.exr")).unwrap(),
    )
    .unwrap();
    assert_eq!((exr.width, exr.height, exr.bit_depth), (256, 256, 32));
    let disp = image_formats::f32_linear_to_srgb8(&exr.f32);
    let hd = buf_hash(&disp);
    println!("FIX exr8    256×256  hash={hd:#018x}");

    assert_eq!(h8, FIX_TIFF8_HASH, "tiff8 digest drift: got {h8:#018x}");
    assert_eq!(h16, FIX_TIFF16_HASH, "tiff16 digest drift: got {h16:#018x}");
    assert_eq!(hd, FIX_EXR_DISP8_HASH, "exr disp8 digest drift: got {hd:#018x}");
}
