//! CR2 streaming row-source parity (K1 HARD GATE).
//!
//! `Cr2RowSource` (the K1 row-source wrapper) must reproduce the existing batch CR2
//! decode path bit-for-bit, for BOTH:
//!   - single-slice CR2 (raster-order mosaic, direct row slice), and
//!   - multi-slice CR2 (stacked-slice resident mosaic, on-demand reassembly).
//!
//! Two independent gates per file:
//!   1. Raw-mosaic row parity: the streamed rows, concatenated, byte-equal
//!      `cr2::decode_bytes().raw` (the existing cropped mosaic). This isolates the
//!      row-source layer — no demosaic / tone / encode in the comparison.
//!   2. Full decoded-pixel SHA-256 parity: the streaming band-pull RGB8 output equals
//!      the existing path's `decode_bytes → demosaic_bayer_mhc(phase) → tone → RGB8`.
//!
//! Plus an end-to-end streaming-export == whole-frame-encode gate (mirrors
//! `dng_stream::dng_export_bytes_equal_whole`).
//!
//! Fixture-gated: skips gracefully when the CR2 corpus is absent (CI / other machines).
//! Override the corpus dir with `CR2_FIXTURE_DIR`; default `C:\Foo\raw-converter\tests`.

use raw_pipeline::decompress::RawRowSource;
use raw_pipeline::{cr2, demosaic, jxl_casaencoder, pipeline, stream_export};
use raw_pipeline::stream_band::StreamingBandSource;
use sha2::{Digest, Sha256};

/// Single-slice Canon body (decoded grid IS the raster; CR2Slices all zero).
const SINGLE_SLICE: &str = "ADH 1234.CR2";
/// Multi-slice Canon body (5D-era; CR2Slices=[N,nw,lw], N>0 — stacked-slice mosaic).
const MULTI_SLICE: &str = "_MG_1744.CR2";

fn fixture(name: &str) -> Option<Vec<u8>> {
    let dir = std::env::var("CR2_FIXTURE_DIR").unwrap_or_else(|_| r"C:\Foo\raw-converter\tests".into());
    let p = std::path::Path::new(&dir).join(name);
    if !p.exists() {
        return None;
    }
    std::fs::read(p).ok()
}

fn sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let d = h.finalize();
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// Concatenate every streamed raw row from `Cr2RowSource` into one buffer.
fn stream_raw_rows(data: &[u8]) -> (usize, usize, Vec<u16>) {
    let mut src = cr2::cr2_row_source(data).expect("cr2_row_source");
    let (w, h) = (src.width(), src.height());
    let mut rowbuf = vec![0u16; w];
    let mut out = Vec::with_capacity(w * h);
    while src.next_row_into(&mut rowbuf).expect("next_row_into") {
        out.extend_from_slice(&rowbuf);
    }
    (w, h, out)
}

/// Build the existing-path full RGB8: `decode_bytes → demosaic_bayer_mhc(phase) → tone`.
/// Mirrors what `StreamingBandSource::from_cr2_bytes` streams (default_olympus params +
/// per-file black/white/WB/matrix, phase = decoder's CFA phase, nr = 0).
fn batch_rgb8(data: &[u8]) -> (usize, usize, Vec<u8>) {
    let img = cr2::decode_bytes(data).expect("decode_bytes");
    let (w, h) = (img.width, img.height);
    // Params first: the demosaic needs the WB ratios. StreamingBandSource::from_cr2_bytes
    // builds exactly these fields and then demosaics with MhcGains::from_wb, so the
    // reference must too — the no-gains entry point is MhcGains::UNITY, correct only for
    // an already-white-balanced mosaic, and this mosaic is white-balanced later in tone.
    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = img.black;
    params.white = img.white;
    params.wb_r = img.wb_r;
    params.wb_b = img.wb_b;
    params.color_matrix = img.color_matrix.into();
    let gains = demosaic::MhcGains::from_wb(params.wb_r, params.wb_g, params.wb_b);
    let rgb16 = demosaic::demosaic_bayer_mhc_gains(&img.raw, w, h, img.cfa_phase, gains)
        .expect("demosaic");
    let mut rgb8 = vec![0u8; w * h * 3];
    pipeline::process_into_auto(&rgb16, &params, &mut rgb8);
    (w, h, rgb8)
}

/// Pull the whole image from a `StreamingBandSource` in monotonic 256-row bands
/// and assemble the full RGB8 buffer.
fn stream_rgb8(data: &[u8]) -> (usize, usize, Vec<u8>) {
    let mut s = StreamingBandSource::from_cr2_bytes(data, 0.0).expect("from_cr2_bytes");
    let (w, h) = (s.width(), s.height());
    let stride = w * 3;
    let mut out = vec![0u8; w * h * 3];
    let mut y = 0usize;
    while y < h {
        let ys = 256.min(h - y);
        let (p, src_stride) = s.band(0, y, w, ys);
        for r in 0..ys {
            unsafe {
                let srow = std::slice::from_raw_parts(p.add(r * src_stride), stride);
                out[(y + r) * stride..(y + r) * stride + stride].copy_from_slice(srow);
            }
        }
        y += 256;
    }
    (w, h, out)
}

/// Assert the file's slice geometry so a mis-labelled fixture is caught, not silently passed.
/// `expect_multi = true` requires CR2Slices[0] > 0 (stacked slices); false requires all-zero.
fn assert_slice_kind(data: &[u8], expect_multi: bool) {
    let (_img, t) = cr2::decode_bytes_bench(data).expect("decode_bytes_bench");
    let is_multi = t.slices[0] > 0;
    assert_eq!(
        is_multi, expect_multi,
        "fixture slice geometry {:?}: expected multi={}, got multi={}",
        t.slices, expect_multi, is_multi
    );
}

// --- Gate 1: raw-mosaic row parity (isolates the row-source layer) ---------------------

#[test]
fn cr2_single_slice_row_source_parity() {
    let Some(data) = fixture(SINGLE_SLICE) else {
        eprintln!("skip: no single-slice CR2 fixture ({SINGLE_SLICE})");
        return;
    };
    assert_slice_kind(&data, false);
    let full = cr2::decode_bytes(&data).expect("full decode");
    let (w, h, streamed) = stream_raw_rows(&data);
    assert_eq!((w, h), (full.width, full.height), "dims differ");
    assert_eq!(streamed.len(), full.raw.len(), "raw length differs");
    assert!(streamed == full.raw, "single-slice streamed rows != decode_bytes().raw");
}

#[test]
fn cr2_multi_slice_row_source_parity() {
    let Some(data) = fixture(MULTI_SLICE) else {
        eprintln!("skip: no multi-slice CR2 fixture ({MULTI_SLICE})");
        return;
    };
    assert_slice_kind(&data, true);
    let full = cr2::decode_bytes(&data).expect("full decode");
    let (w, h, streamed) = stream_raw_rows(&data);
    assert_eq!((w, h), (full.width, full.height), "dims differ");
    assert_eq!(streamed.len(), full.raw.len(), "raw length differs");
    assert!(
        streamed == full.raw,
        "multi-slice resident-mosaic streamed rows != decode_bytes().raw"
    );
}

// --- Gate 2: full decoded-pixel SHA-256 parity (existing path vs streaming band-pull) ---

fn full_rgb_sha_parity(name: &str, expect_multi: bool) {
    let Some(data) = fixture(name) else {
        eprintln!("skip: no CR2 fixture ({name})");
        return;
    };
    assert_slice_kind(&data, expect_multi);
    let (bw, bh, batch) = batch_rgb8(&data);
    let (sw, sh, stream) = stream_rgb8(&data);
    assert_eq!((bw, bh), (sw, sh), "{name}: dims differ");
    let batch_sha = sha256(&batch);
    let stream_sha = sha256(&stream);
    println!("{name}: full RGB8 SHA-256 batch={batch_sha} stream={stream_sha}");
    assert_eq!(
        batch_sha, stream_sha,
        "{name}: full decoded RGB8 SHA-256 differs (streaming vs existing path)"
    );
}

#[test]
fn cr2_single_slice_full_rgb_sha_parity() {
    full_rgb_sha_parity(SINGLE_SLICE, false);
}

#[test]
fn cr2_multi_slice_full_rgb_sha_parity() {
    full_rgb_sha_parity(MULTI_SLICE, true);
}

// --- Gate 3: end-to-end streaming JXL export == whole-frame encode ---------------------

fn export_bytes_equal_whole(name: &str) {
    let Some(data) = fixture(name) else {
        eprintln!("skip: no CR2 fixture ({name})");
        return;
    };
    let (w, h, rgb8) = batch_rgb8(&data);
    let whole = jxl_casaencoder::encode_chunked_rgb8(&rgb8, w as u32, h as u32, 1.0, 3).expect("whole encode");

    let mut streamed = Vec::new();
    let (ew, eh) = stream_export::export_cr2_jxl_streaming(&data, 1.0, 3, &mut streamed).expect("stream export");
    assert_eq!((ew, eh), (w, h), "{name}: export dims differ");
    assert_eq!(streamed.len(), whole.len(), "{name}: CR2 export size differs");
    assert!(streamed == whole, "{name}: CR2 streaming export bytes differ from whole-frame");
}

#[test]
fn cr2_single_slice_export_bytes_equal_whole() {
    export_bytes_equal_whole(SINGLE_SLICE);
}

#[test]
fn cr2_multi_slice_export_bytes_equal_whole() {
    export_bytes_equal_whole(MULTI_SLICE);
}
