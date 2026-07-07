#![no_main]
//! Fuzz the Olympus ORF decompressor (`decompress::decompress`). Width/height
//! are attacker-controllable at the real call site (read from the TIFF header),
//! so the target derives them from the first 4 input bytes — bounded to <=256 so
//! the output buffer stays small and the fuzzer targets the bit-reader / Huffman
//! adaptive-width logic (the historical overflow surface) rather than allocation.
use libfuzzer_sys::fuzz_target;
use raw_pipeline::decompress;

fuzz_target!(|data: &[u8]| {
    if data.len() < 4 {
        return;
    }
    let w = (u16::from_le_bytes([data[0], data[1]]) as usize % 256) + 1;
    let h = (u16::from_le_bytes([data[2], data[3]]) as usize % 256) + 1;
    let _ = decompress::decompress(&data[4..], w, h);
});
