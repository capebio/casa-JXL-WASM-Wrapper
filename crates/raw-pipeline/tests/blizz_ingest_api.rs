//! Pins the `raw-pipeline` surface the sibling `blizz` tree's camera RAW
//! ingest is built on.
//!
//! **Why this file exists.** `blizz/src/ingest.rs` turns a camera file into a
//! BLKB sensor archive, and it does not contain a single decoder of its own —
//! every one is this crate, taken as an optional path dependency. Two of the
//! functions it needs are `#[doc(hidden)]` and were, until this commit,
//! documented as bench/parity tooling: `cr2::ljpeg_strip_geometry` and
//! `dng::ljpeg_tile_ranges`. They are the only things here that report **where
//! the sensor payload lives inside the original file**, which is what lets an
//! archive carry the maker notes, GPS and thumbnails through verbatim as a
//! sidecar instead of duplicating the whole file.
//!
//! So a refactor in this repo that renames, re-signs or feature-gates any of
//! the items below breaks camera RAW ingest in a different repository, and
//! nothing in this crate's own tests would notice. This file makes that break
//! loud and local: it is a **compile-time** signature pin, so it fails at
//! `cargo test` in the tree doing the renaming.
//!
//! It asserts nothing about behaviour. It is not a substitute for the parity
//! tests beside each decoder; it only fixes the shape of the contract.
//!
//! **If you are here because this file stopped compiling:** that is the intended
//! outcome, not an obstacle. Decide deliberately, then update both trees in the
//! same change. `blizz`'s documented fallback is to go back to *refusing* the
//! affected format rather than quietly writing an archive with an empty
//! sidecar, and that is a call for a person to make.
//!
//! `blizz` consumes this crate with `default-features = false` (it wants
//! neither rayon nor the JXL FFI), so everything pinned here must stay
//! reachable in that configuration. Moving any of it behind `jxl-codec`,
//! `parallel` or a new default feature is the same break as deleting it.

use std::ops::Range;

/// The exact calls `blizz/src/ingest.rs` makes, as typed function pointers.
///
/// A function pointer coerced to a written-out type is the cheapest total
/// signature check Rust offers: argument types, return type and arity all have
/// to match, and it costs nothing at runtime.
#[test]
fn blizz_ingest_api_pins() {
    // --- ORF -------------------------------------------------------------
    // Geometry and payload extents come off `OrfInfo` directly.
    let _parse: fn(&[u8]) -> anyhow::Result<raw_pipeline::tiff::OrfInfo> = raw_pipeline::tiff::parse;

    // --- CR2 -------------------------------------------------------------
    let _cr2: fn(&[u8]) -> anyhow::Result<raw_pipeline::cr2::Cr2Image> =
        raw_pipeline::cr2::decode_bytes;
    // (strip_offset, strip_len, stride_pixels, rows) — the payload extent.
    let _cr2_strip: fn(&[u8]) -> anyhow::Result<(usize, usize, usize, usize)> =
        raw_pipeline::cr2::ljpeg_strip_geometry;

    // --- DNG -------------------------------------------------------------
    let _dng: fn(&[u8]) -> anyhow::Result<raw_pipeline::dng::DngImage> =
        raw_pipeline::dng::decode_bytes;
    // One (offset, len) per LJPEG tile — the payload extents.
    let _dng_tiles: fn(&[u8]) -> anyhow::Result<Vec<(usize, usize)>> =
        raw_pipeline::dng::ljpeg_tile_ranges;
    let _phase: fn(raw_pipeline::dng::Cfa) -> (u8, u8) = raw_pipeline::dng::cfa_phase;

    // --- RW2 / RWL / NEF -------------------------------------------------
    // These hand back the payload range directly, on `BayerImage::strip`.
    let _rw2: fn(&[u8]) -> Result<raw_pipeline::panasonic::BayerImage, String> =
        raw_pipeline::panasonic::decode_rw2;
    let _nef: fn(&[u8]) -> Result<raw_pipeline::panasonic::BayerImage, String> =
        raw_pipeline::panasonic::decode_nef;
}

/// Every `BayerImage` field `blizz` reads, named individually.
///
/// A struct-literal destructure with no `..` is exhaustive: adding a field is
/// fine and does not break this, but **removing or renaming one of these fails
/// to compile**, which is the direction that matters. `strip` in particular is
/// the whole reason RW2/RWL/NEF ingest can exist — without it the sidecar would
/// have to be the entire original file and the archive would come out larger
/// than what it replaced.
#[test]
fn bayer_image_carries_what_an_archiver_needs() {
    fn uses(b: &raw_pipeline::panasonic::BayerImage) {
        let raw_pipeline::panasonic::BayerImage {
            width: _w,
            height: _h,
            raw: _raw,
            cfa_phase: _phase,
            black: _black,
            white: _white,
            wb_r: _wb_r,
            wb_g: _wb_g,
            wb_b: _wb_b,
            make: _make,
            model: _model,
            strip: _strip,
        } = b;
        let _: &Range<usize> = _strip;
        let _: &Vec<u16> = _raw;
        let _: &(u8, u8) = _phase;
    }
    let _ = uses;
}
