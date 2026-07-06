//! Decode a .jxl file with the NATIVE fork decoder. Localizes the WASM bug:
//! if this decodes WASM-enc output fine -> wasm DECODER bug; if it fails ->
//! wasm ENCODER produces corrupt output. Run: ... --example jxl_decode_file -- <file.jxl>
use raw_pipeline::jxl_casadecoder::{Channels, DecodeOptions, Decoder, Image};
fn main() {
    let path = std::env::args().nth(1).expect("jxl file");
    let jxl = std::fs::read(&path).expect("read");
    println!("file {} ({} bytes)", path, jxl.len());
    let mut d = Decoder::new(DecodeOptions::default()).expect("dec");
    match d.decode::<u8>(&jxl, Channels::Rgba) {
        Ok(img) => {
            let img: Image<u8> = img;
            let mut sum: u64 = 0;
            for &b in img.data.iter().take(4096) {
                sum += b as u64;
            }
            println!(
                "NATIVE DECODE OK: {}x{} ch={} bytes={} checksum4k={}",
                img.width,
                img.height,
                img.channels,
                img.data.len(),
                sum
            );
        }
        Err(e) => println!("NATIVE DECODE FAILED: {:?}", e),
    }
}
