#![no_main]
//! Fuzz `casa_video::parse_casv_footer` — the CSAV trailer/index (frame table,
//! offsets read from the tail). Gated behind `codec`; no-op stub otherwise.
use libfuzzer_sys::fuzz_target;

#[cfg(feature = "codec")]
fuzz_target!(|data: &[u8]| {
    let _ = raw_pipeline::casa_video::parse_casv_footer(data);
});

#[cfg(not(feature = "codec"))]
fuzz_target!(|_data: &[u8]| {});
