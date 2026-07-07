#![no_main]
//! Fuzz `tiff::parse` — the ORF/TIFF IFD walker (offsets, strip geometry, WB
//! tags). Must return Err on malformed input, never panic or read OOB.
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = raw_pipeline::tiff::parse(data);
});
