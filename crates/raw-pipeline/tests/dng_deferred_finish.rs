//! P3-T8 (finding 34): deferred DNG finish — retained raw state.
//!
//! The interactive DNG path decodes the container once (TIFF-walk + LJPEG /
//! uncompressed un-decompress → raw Bayer mosaic), shows a preview, then
//! finalizes full-resolution development. The deferred-finish contract is that
//! the **final development does NOT re-decode the container**: it reuses the
//! retained raw mosaic + CFA phase, so it runs demosaic+tone only.
//!
//! This crate-level test pins the two invariants that make the split sound at
//! the `raw_pipeline` layer (the `src/lib.rs` wasm surface — `DngDecoded` +
//! `finish_dng_from_raw` + `ProcessResult::finish_dng_full_rgb8` — is a thin
//! carrier over exactly these primitives):
//!
//!   1. **Decode count == 1.** A preview→retain→final flow calls
//!      `dng::decode_bytes` exactly once. A separate second decode (the naive
//!      "decode twice" shape the deferred finish replaces) is what we must NOT
//!      pay — and we assert that the retained-mosaic finish adds zero decodes.
//!   2. **Byte parity.** Demosaicing from the retained mosaic is byte-identical
//!      to demosaicing from a fresh decode, because both feed the SAME raw +
//!      SAME CFA phase into the SAME `demosaic_bayer_mhc`. The retained-state
//!      carrier also preserves the decode-time colour truth (baseline_exposure,
//!      honest wb_from_camera, colour matrix, noise_metadata) so the deferred
//!      final matches T7's colour truth field-for-field.
//!
//! Fixture-gated: skips gracefully when the real DNG corpus is absent (CI /
//! other machines). Override the dir via DNG_FIXTURE_DIR.

use raw_pipeline::demosaic::demosaic_bayer_mhc;
use raw_pipeline::dng::{self, cfa_phase, DngImage};

fn dng_fixture(name: &str) -> Option<Vec<u8>> {
    let dirs = [
        std::env::var("DNG_FIXTURE_DIR").unwrap_or_else(|_| r"C:\Foo\raw-converter\tests".into()),
        r"C:\Foo\raw-converter-wasm\.timing-source".into(),
    ];
    for d in dirs {
        let p = std::path::Path::new(&d).join(name);
        if p.exists() {
            return std::fs::read(p).ok();
        }
    }
    None
}

/// Real Pixel DNGs. One carries GPS + a positive BaselineExposure; NIGHT is a
/// low-light shot whose BaselineExposure the deferred final must preserve so the
/// image renders at intended brightness (regression for the 99ed8d00 fix).
const DNG_WITH_GPS: &str = "PXL_20260501_093507165.RAW-02.ORIGINAL.dng";
const DNG_DATETIME_ONLY: &str = "PXL_20260527_180319603.RAW-02.ORIGINAL.dng";
const DNG_NIGHT: &str = "PXL_20260526_194503279.NIGHT.RAW-02.ORIGINAL.dng";

/// The retained-state carrier: everything the deferred final needs to reproduce
/// the monolithic output WITHOUT touching the container again. Mirrors the
/// `DngDecoded`/`DngShell` shape in `src/lib.rs` — raw mosaic + CFA phase + the
/// full decode-time metadata (colour truth). No `data: &[u8]` field: by
/// construction the final cannot re-decode the container.
struct RetainedDng {
    raw: Vec<u16>,
    width: usize,
    height: usize,
    phase: (u8, u8),
    // Decode-time colour truth (T7). Present so the deferred final is a
    // byte-identical continuation of the same decode, not a re-derivation.
    black: u16,
    white: u16,
    wb_r: f32,
    wb_b: f32,
    wb_from_camera: bool,
    baseline_exposure: f32,
    color_matrix: Option<[[f32; 3]; 3]>,
    datetime: String,
    gps_lat: Option<f64>,
    gps_lon: Option<f64>,
    gps_alt: Option<f64>,
}

impl RetainedDng {
    /// Split a decoded container into the retained-state carrier. Consumes the
    /// raw mosaic (moved, not cloned) — explicit ownership transfer, mirroring
    /// `DngShell::split` / the ORF `Some(raw)` retain in `src/lib.rs`.
    fn from_decoded(d: DngImage) -> Self {
        let phase = cfa_phase(d.cfa);
        RetainedDng {
            width: d.width,
            height: d.height,
            phase,
            raw: d.raw,
            black: d.black,
            white: d.white,
            wb_r: d.wb_r,
            wb_b: d.wb_b,
            wb_from_camera: d.wb_from_camera,
            baseline_exposure: d.baseline_exposure,
            color_matrix: d.color_matrix,
            datetime: d.datetime,
            gps_lat: d.gps_lat,
            gps_lon: d.gps_lon,
            gps_alt: d.gps_alt,
        }
    }

    /// The deferred final: demosaic FROM the retained mosaic. This is the step
    /// that must not re-decode the container. Returns full-res interleaved RGB16
    /// (the same buffer the monolithic `decode_dng_raw` produces before tone).
    fn finish_rgb16(&self) -> Vec<u16> {
        demosaic_bayer_mhc(&self.raw, self.width, self.height, self.phase)
            .expect("deferred finish: demosaic from retained mosaic")
    }
}

/// The monolithic reference: decode the container, then demosaic — the exact
/// two steps `decode_dng_raw`'s full-MHC path runs.
fn monolithic_rgb16(data: &[u8]) -> (Vec<u16>, usize, usize) {
    let img = dng::decode_bytes(data).expect("monolithic decode");
    let phase = cfa_phase(img.cfa);
    let rgb16 = demosaic_bayer_mhc(&img.raw, img.width, img.height, phase)
        .expect("monolithic demosaic");
    (rgb16, img.width, img.height)
}

// ── Invariant 1 + 2: single container decode + byte parity ───────────────────

#[test]
fn deferred_finish_decodes_container_once_and_is_byte_identical() {
    let Some(data) = dng_fixture(DNG_DATETIME_ONLY) else {
        eprintln!("skip: no DNG fixture ({DNG_DATETIME_ONLY})");
        return;
    };

    // Reference: monolithic decode+demosaic (this contributes ONE decode).
    let (ref_rgb16, ref_w, ref_h) = monolithic_rgb16(&data);

    // Two-phase deferred flow: fence the counter, then decode the container ONCE
    // for the preview, retain the mosaic, and finish from it. The finish must add
    // ZERO container decodes.
    dng::reset_decode_count();
    let preview = dng::decode_bytes(&data).expect("phase-1 preview decode");
    assert_eq!(
        dng::decode_count(),
        1,
        "phase-1 preview must decode the container exactly once"
    );
    let retained = RetainedDng::from_decoded(preview);
    let final_rgb16 = retained.finish_rgb16();
    assert_eq!(
        dng::decode_count(),
        1,
        "deferred final must NOT re-decode the container (still exactly 1 decode)"
    );

    // Byte parity: deferred final == monolithic full, exactly.
    assert_eq!(retained.width, ref_w);
    assert_eq!(retained.height, ref_h);
    assert_eq!(
        final_rgb16.len(),
        ref_rgb16.len(),
        "deferred RGB16 length must match monolithic"
    );
    assert!(
        final_rgb16 == ref_rgb16,
        "deferred finish RGB16 must be byte-identical to the monolithic full decode"
    );
}

// ── Colour-truth carrier: T7 metadata survives the split field-for-field ─────

#[test]
fn retained_state_carries_full_colour_truth() {
    // Prefer the GPS fixture (positive BaselineExposure + genuine AsShotNeutral +
    // GPS) so all colour-truth fields are non-trivially populated; fall back to
    // the datetime-only fixture otherwise.
    let (name, data) = match dng_fixture(DNG_WITH_GPS) {
        Some(d) => (DNG_WITH_GPS, d),
        None => match dng_fixture(DNG_DATETIME_ONLY) {
            Some(d) => (DNG_DATETIME_ONLY, d),
            None => {
                eprintln!("skip: no DNG fixture");
                return;
            }
        },
    };

    let img = dng::decode_bytes(&data).expect("decode");
    // Snapshot the decode-time truth before the mosaic is moved into the carrier.
    let want = (
        img.black,
        img.white,
        img.wb_r,
        img.wb_b,
        img.wb_from_camera,
        img.baseline_exposure,
        img.color_matrix,
        img.datetime.clone(),
        img.gps_lat,
        img.gps_lon,
        img.gps_alt,
    );

    let retained = RetainedDng::from_decoded(img);

    // Every colour-truth field must survive the split unchanged — this is what
    // lets the deferred final reproduce T7's colour output exactly.
    assert_eq!(retained.black, want.0);
    assert_eq!(retained.white, want.1);
    assert_eq!(retained.wb_r, want.2);
    assert_eq!(retained.wb_b, want.3);
    assert_eq!(retained.wb_from_camera, want.4, "honest wb_from_camera");
    assert_eq!(retained.baseline_exposure, want.5, "BaselineExposure (colour/brightness truth)");
    assert_eq!(retained.color_matrix, want.6, "resolved colour matrix");
    assert_eq!(retained.datetime, want.7);
    assert_eq!(retained.gps_lat, want.8);
    assert_eq!(retained.gps_lon, want.9);
    assert_eq!(retained.gps_alt, want.10);

    if name == DNG_WITH_GPS {
        // The GPS fixture carries genuine camera WB + GPS. (BaselineExposure varies
        // per shot and may legitimately be 0.0, so it is not asserted positive here;
        // the NIGHT fixture test exercises the non-zero-BE preservation path.)
        assert!(retained.wb_from_camera, "GPS fixture carries AsShotNeutral");
        assert!(retained.gps_lat.is_some() && retained.gps_lon.is_some(), "GPS fixture carries GPS");
        assert!(retained.baseline_exposure.is_finite(), "BaselineExposure must be a finite EV");
    }
}

// ── NIGHT fixture: BaselineExposure preserved through the deferred split ──────

#[test]
fn night_dng_baseline_exposure_survives_deferred_finish() {
    let Some(data) = dng_fixture(DNG_NIGHT) else {
        eprintln!("skip: no NIGHT DNG fixture ({DNG_NIGHT})");
        return;
    };
    // Monolithic reference pixels.
    let (ref_rgb16, ref_w, ref_h) = monolithic_rgb16(&data);

    dng::reset_decode_count();
    let preview = dng::decode_bytes(&data).expect("night preview decode");
    let want_be = preview.baseline_exposure;
    let retained = RetainedDng::from_decoded(preview);
    let final_rgb16 = retained.finish_rgb16();

    assert_eq!(dng::decode_count(), 1, "night finish adds no container decode");
    assert_eq!(retained.baseline_exposure, want_be);
    assert_eq!((retained.width, retained.height), (ref_w, ref_h));
    assert!(
        final_rgb16 == ref_rgb16,
        "night deferred finish must be byte-identical to monolithic"
    );
}
