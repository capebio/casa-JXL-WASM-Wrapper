#![no_main]
//! Fuzz `casa_video::parse_casv_audio_box` — locates the optional CSAU audio box
//! and returns a borrowed slice; box-length arithmetic must stay in bounds.
//! Gated behind `codec`; no-op stub otherwise.
use libfuzzer_sys::fuzz_target;

#[cfg(feature = "codec")]
fuzz_target!(|data: &[u8]| {
    let _ = raw_pipeline::casa_video::parse_casv_audio_box(data);
});

#[cfg(not(feature = "codec"))]
fuzz_target!(|_data: &[u8]| {});
