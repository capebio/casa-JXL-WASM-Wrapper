#![no_main]
//! Fuzz `panasonic::decode_rw2` — the Panasonic RW2/Leica RWL path (TIFF-85 tag
//! walk + PanaBits paged DPCM unpack). Hand-written entropy decode over
//! untrusted bytes; dims are bounded by the decoder's own guards, so a crash
//! here is a real find.
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = raw_pipeline::panasonic::decode_rw2(data);
});
