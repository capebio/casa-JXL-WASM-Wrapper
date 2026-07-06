#![no_main]
//! Fuzz `jxl_casadecoder::parse_jxtc_header` — the JXTC tiled-container header
//! (tile grid, per-tile byte offsets). Gated behind `codec`; no-op stub otherwise.
use libfuzzer_sys::fuzz_target;

#[cfg(feature = "codec")]
fuzz_target!(|data: &[u8]| {
    let _ = raw_pipeline::jxl_casadecoder::parse_jxtc_header(data);
});

#[cfg(not(feature = "codec"))]
fuzz_target!(|_data: &[u8]| {});
