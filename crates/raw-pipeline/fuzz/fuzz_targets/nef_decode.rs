#![no_main]
//! Fuzz `panasonic::decode_nef` — the Nikon NEF/NRW path (SubIFD walk, three
//! uncompressed layouts, and the 34713 Huffman DPCM + MakerNote linearisation
//! curve). Must reject malformed input without panic, OOB read, or unbounded
//! decode loops.
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = raw_pipeline::panasonic::decode_nef(data);
});
