//! Dump decoded DNG raw samples as little-endian u16 for external comparison.
//! Usage: dng_dump <in.dng> <out.bin>   (prints "w h spp" to stdout)
fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 3 {
        eprintln!("usage: dng_dump <in.dng> <out.bin>");
        std::process::exit(1);
    }
    let bytes = std::fs::read(&a[1]).expect("read");
    let img = raw_pipeline::dng::decode_bytes(&bytes).expect("decode");
    let mut out = Vec::with_capacity(img.raw.len() * 2);
    for v in &img.raw {
        out.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(&a[2], &out).expect("write");
    println!("{} {} {}", img.width, img.height, img.samples_per_pixel);
}
