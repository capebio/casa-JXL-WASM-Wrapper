//! S4 parity-oracle family — one named home + index for the crate's
//! correctness oracles, plus the two public-API oracles that had no
//! integration-level home.
//!
//! ## What a "parity oracle" is here
//! A test that pins one implementation against an independent reference so a
//! silent divergence fails CI: SIMD vs scalar, streamed band vs whole frame,
//! lossless codec vs its own input, demosaic determinism.
//!
//! ## Family index (canonical homes)
//! Most oracles live inline next to the code they guard (they need `pub(crate)`
//! internals an integration test can't reach). This file is the discoverable
//! entry point — run `cargo test --test parity_oracles` — and the map:
//!
//! | Oracle                         | Canonical home                                   |
//! |--------------------------------|--------------------------------------------------|
//! | band vs whole (tone-only)      | src/stream_band.rs `streaming_source_matches_whole`(+`_bigband`) |
//! | band vs whole (spatial halo)   | src/stream_band.rs `streaming_spatial_source_matches_whole`      |
//! | tone band vs whole             | src/pipeline.rs `tone_band_equals_whole`         |
//! | video drain vs whole frame     | src/raw_video.rs `drain_matches_whole_frame`     |
//! | scale_err AVX2  vs scalar      | src/perceptual/simd/avx2.rs `avx2_scale_err_matches_scalar`    |
//! | scale_err AVX512 vs scalar     | src/perceptual/simd/avx512.rs `scale_err_avx512_matches_scalar`|
//! | pixels_to_xyb AVX2 vs scalar   | src/perceptual/simd/avx2.rs `xyb_avx2_matches_scalar`         |
//! | pixels_to_xyb AVX512 vs scalar | src/perceptual/simd/avx512.rs (xyb parity test)  |
//! | fable lossless roundtrip       | src/fable_braid.rs `image_roundtrip_*` + here (public API) |
//! | whole-pipeline SIMD vs scalar  | tests/parity_corpus.rs golden ledger (native==scalar digest — |
//! |                                | the ORF/DNG pins reproduce byte-for-byte under both builds)   |
//!
//! ## Known gap — WASM simd128 backend (DEFERRED, see handoff)
//! `perceptual/simd/wasm.rs` (`scale_err_wasm`, `pixels_to_xyb_wasm`) has no
//! scalar-parity oracle because wasm SIMD cannot execute under a native
//! `cargo test`. Closing it needs a node+wasm bench harness that runs the wasm
//! export against the scalar reference and pins the result. Tracked in
//! docs/WAVE2-QUESTIONS-DEFERRED.md §S4. The native AVX2/AVX512 oracles above
//! and the whole-pipeline native==scalar ledger bound the risk in the meantime.

use raw_pipeline::{demosaic, fable_braid};

// ── lossless roundtrip == source (public API) ─────────────────────────────────

fn assert_fable_lossless(rgb: &[u8], w: u32, h: u32, label: &str) {
    let enc = fable_braid::encode_rgb8(rgb, w, h);
    let (dec, dw, dh) = fable_braid::decode_rgb8(&enc).expect("decode_rgb8 returned None");
    assert_eq!((dw, dh), (w, h), "{label}: dims changed through roundtrip");
    assert_eq!(dec.len(), rgb.len(), "{label}: length changed");
    assert_eq!(dec, rgb, "{label}: NOT byte-lossless");
}

/// FableBraid `encode_rgb8`/`decode_rgb8` is byte-lossless across content classes.
/// Integration-level guard on the public codec API (the inline `image_roundtrip_*`
/// tests cover internals; this pins the exported entry points consumers call).
#[test]
fn oracle_fable_lossless_roundtrip() {
    let (w, h) = (37u32, 19u32); // deliberately non-power-of-two, odd rows/cols
    let n = (w * h) as usize;

    // flat
    assert_fable_lossless(&vec![128u8; n * 3], w, h, "flat");

    // smooth gradient (predictor-friendly)
    let mut grad = vec![0u8; n * 3];
    for y in 0..h as usize {
        for x in 0..w as usize {
            let i = (y * w as usize + x) * 3;
            grad[i] = (x * 255 / w as usize) as u8;
            grad[i + 1] = (y * 255 / h as usize) as u8;
            grad[i + 2] = ((x + y) & 0xFF) as u8;
        }
    }
    assert_fable_lossless(&grad, w, h, "gradient");

    // structure-free noise (worst case for the entropy coder — must still be exact)
    let mut s = 0x1234_5678_9abc_def0u64;
    let noise: Vec<u8> = (0..n * 3)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            (s >> 24) as u8
        })
        .collect();
    assert_fable_lossless(&noise, w, h, "noise");

    // 1×1 and single-row edge geometries
    assert_fable_lossless(&[10, 20, 30], 1, 1, "1x1");
    assert_fable_lossless(&vec![77u8; 16 * 3], 16, 1, "row");
}

// ── demosaic determinism + shape (public API) ─────────────────────────────────

/// `demosaic_rggb` yields the correct RGB16 size and is bit-exact deterministic —
/// the property the whole SHA ledger downstream relies on.
#[test]
fn oracle_demosaic_rggb_deterministic() {
    let (w, h) = (16usize, 12usize);
    // A structured RGGB-ish mosaic (varied so interpolation actually differs).
    let raw: Vec<u16> = (0..w * h).map(|i| ((i * 131) & 0x0FFF) as u16).collect();

    let a = demosaic::demosaic_rggb(&raw, w, h).expect("demosaic a");
    let b = demosaic::demosaic_rggb(&raw, w, h).expect("demosaic b");
    assert_eq!(a.len(), w * h * 3, "demosaic output size");
    assert_eq!(a, b, "demosaic_rggb is non-deterministic");
}
