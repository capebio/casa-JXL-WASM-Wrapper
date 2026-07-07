#![no_main]
//! Fuzz `dng::decode_bytes` — the DNG (TIFF-based) parser: IFD walk, CFA layout,
//! tile/strip offsets. Must reject malformed input without panic or OOB read.
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = raw_pipeline::dng::decode_bytes(data);
});
