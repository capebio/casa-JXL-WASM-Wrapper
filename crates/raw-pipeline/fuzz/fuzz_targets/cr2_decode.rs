#![no_main]
//! Fuzz `cr2::decode_bytes` — the full Canon CR2 path (TIFF container + slice
//! geometry + LJPEG entropy decode + reassembly). Adversarial dims are bounded
//! by the decoder's own guards; a crash here is a real find.
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = raw_pipeline::cr2::decode_bytes(data);
});
