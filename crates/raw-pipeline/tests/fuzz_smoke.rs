//! S4 fuzz-smoke — executable stand-in for `cargo fuzz run`.
//!
//! This box has no nightly-MSVC sanitizer runtime, so `cargo fuzz build/run`
//! cannot execute here (see docs/HANDOFF-S4-verification-hardening-2026-07-06.md).
//! Instead this test drives each cargo-fuzz target's *exact* harness body over
//! the checked-in seed corpus (`fuzz/corpus/<target>/`) plus deterministic
//! mutations — truncations, bit-flips, byte-sets, and structure-free PRNG bytes —
//! asserting the parsers never panic on adversarial input.
//!
//! Run in the DEFAULT debug profile (do NOT add --release): debug builds panic on
//! arithmetic overflow, so this actually exercises the hand-patched overflow
//! guards that motivated S4. A panic here == a real found-bug to fix or document.
//!
//! The CASV/JXTC bodies are gated behind `jxl-codec` (they live in libjxl-fed
//! modules); they compile out of the default no-libjxl run and light up under
//! `cargo test --features jxl-codec`.

use raw_pipeline::{cr2, decompress, dng, ljpeg, panasonic, tiff};
use std::path::PathBuf;

// ── corpus + mutation engine ──────────────────────────────────────────────────

fn corpus_dir(target: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("fuzz");
    p.push("corpus");
    p.push(target);
    p
}

fn read_seeds(target: &str) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(corpus_dir(target)) {
        for e in rd.flatten() {
            if e.path().is_file() {
                if let Ok(b) = std::fs::read(e.path()) {
                    out.push(b);
                }
            }
        }
    }
    out
}

/// Deterministic xorshift64 byte stream — structure-free random inputs.
fn prng_bytes(seed: u64, len: usize) -> Vec<u8> {
    let mut s = seed | 1;
    (0..len)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            (s >> 24) as u8
        })
        .collect()
}

/// Adversarial case set for a target: empties, tiny constants, PRNG buffers, and
/// — for every checked-in seed — truncations, bit-flips, and byte-sets.
fn corpus_cases(target: &str) -> Vec<Vec<u8>> {
    let mut cases: Vec<Vec<u8>> = vec![
        Vec::new(),
        vec![0u8],
        vec![0xFFu8; 2],
        vec![0xFFu8, 0xD8, 0xFF], // near-SOI
    ];
    for i in 0..24u64 {
        cases.push(prng_bytes(i.wrapping_mul(0x9E37_79B9_7F4A_7C15), 3 + (i as usize % 96)));
    }
    for seed in read_seeds(target) {
        for &n in &[0usize, 1, 2, 3, 4, 6, 8, 12, 16, 32, 64, 256, 1024, 4096] {
            let k = seed.len().min(n);
            cases.push(seed[..k].to_vec());
        }
        cases.push(seed.clone());
        if seed.is_empty() {
            continue;
        }
        for k in 0..40usize {
            let mut m = seed.clone();
            let idx = k.wrapping_mul(2_654_435_761) % m.len();
            m[idx] ^= 1u8 << (k % 8);
            cases.push(m);
        }
        for k in 0..12usize {
            let mut m = seed.clone();
            let idx = k.wrapping_mul(40_503) % m.len();
            m[idx] = [0x00u8, 0xFF, 0x7F, 0x80][k % 4];
            cases.push(m);
        }
    }
    cases
}

// ── target harness bodies (mirror fuzz/fuzz_targets/*.rs exactly) ──────────────

fn run_tiff(data: &[u8]) {
    let _ = tiff::parse(data);
}

fn run_cr2(data: &[u8]) {
    let _ = cr2::decode_bytes(data);
}

fn run_dng(data: &[u8]) {
    let _ = dng::decode_bytes(data);
}

fn run_ljpeg(data: &[u8]) {
    let info = match ljpeg::probe_tile(data) {
        Ok(i) => i,
        Err(_) => return,
    };
    let w = info.width as usize;
    let h = info.height as usize;
    let c = info.components.max(1) as usize;
    let px = w.saturating_mul(h).saturating_mul(c);
    if w == 0 || h == 0 || px == 0 || px > (1 << 22) {
        return;
    }
    let mut out = vec![0u16; px];
    let _ = ljpeg::decode_tile_compact(data, &mut out, w, h);
}

fn run_rw2(data: &[u8]) {
    let _ = panasonic::decode_rw2(data);
}

fn run_nef(data: &[u8]) {
    let _ = panasonic::decode_nef(data);
}

fn run_decompress(data: &[u8]) {
    if data.len() < 4 {
        return;
    }
    let w = (u16::from_le_bytes([data[0], data[1]]) as usize % 256) + 1;
    let h = (u16::from_le_bytes([data[2], data[3]]) as usize % 256) + 1;
    let _ = decompress::decompress(&data[4..], w, h);
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[test]
fn fuzz_smoke_tiff_parse() {
    let cases = corpus_cases("tiff_parse");
    assert!(cases.len() > 30, "expected a non-trivial case set");
    for c in &cases {
        run_tiff(c);
    }
}

#[test]
fn fuzz_smoke_cr2_decode() {
    for c in corpus_cases("cr2_decode") {
        run_cr2(&c);
    }
}

#[test]
fn fuzz_smoke_dng_decode() {
    for c in corpus_cases("dng_decode") {
        run_dng(&c);
    }
}

#[test]
fn fuzz_smoke_ljpeg_decode() {
    for c in corpus_cases("ljpeg_decode") {
        run_ljpeg(&c);
    }
}

#[test]
fn fuzz_smoke_decompress() {
    for c in corpus_cases("decompress") {
        run_decompress(&c);
    }
}

#[test]
fn fuzz_smoke_rw2_decode() {
    for c in corpus_cases("rw2_decode") {
        run_rw2(&c);
    }
}

#[test]
fn fuzz_smoke_nef_decode() {
    for c in corpus_cases("nef_decode") {
        run_nef(&c);
    }
}

// CASV/JXTC container-header parsers — libjxl-gated (jxl-codec feature).
#[cfg(feature = "jxl-codec")]
#[test]
fn fuzz_smoke_casv_and_jxtc() {
    for c in corpus_cases("casv_header") {
        let _ = raw_pipeline::casa_video::parse_casv_header(&c);
    }
    for c in corpus_cases("casv_footer") {
        let _ = raw_pipeline::casa_video::parse_casv_footer(&c);
    }
    for c in corpus_cases("casv_audio_box") {
        let _ = raw_pipeline::casa_video::parse_casv_audio_box(&c);
    }
    for c in corpus_cases("jxtc_header") {
        let _ = raw_pipeline::jxl_casadecoder::parse_jxtc_header(&c);
    }
}
