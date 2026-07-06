#![no_main]
//! Fuzz `casa_video::parse_casv_header` — the CSAV container header (magic, box
//! table, u32 offsets). Gated behind `codec` (raw-pipeline/jxl-codec → libjxl);
//! compiles to a no-op when that feature is off so `cargo fuzz build` stays
//! libjxl-free.
use libfuzzer_sys::fuzz_target;

#[cfg(feature = "codec")]
fuzz_target!(|data: &[u8]| {
    let _ = raw_pipeline::casa_video::parse_casv_header(data);
});

#[cfg(not(feature = "codec"))]
fuzz_target!(|_data: &[u8]| {});
