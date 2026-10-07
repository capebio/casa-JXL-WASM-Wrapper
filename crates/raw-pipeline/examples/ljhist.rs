//! ljhist — LJPEG category histogram (and fused-path split) of a CR2 or LJPEG DNG.
//!   cargo run --release --example ljhist -- <file.cr2|file.dng>
use raw_pipeline::{cr2, dng, ljpeg};

fn main() {
    let path = std::env::args().nth(1).expect("file");
    let data = std::fs::read(&path).expect("read");
    let mut hist = [0u64; 17];
    let mut n = 0u64;
    if path.to_ascii_lowercase().ends_with(".cr2") {
        let (_, s) = cr2::decode_bytes_with_ljpeg_stats(&data).expect("cr2");
        println!("cps={} prec={} {}x{}", s.cps, s.precision, s.sof_w, s.sof_h);
        hist = s.category_hist;
        n = s.total_symbols;
    } else {
        for (o, e) in dng::ljpeg_tile_ranges(&data).expect("tiles") {
            let src = &data[o..e];
            let i = ljpeg::probe_tile(src).expect("probe");
            let w = i.width as usize * i.components as usize;
            let mut buf = vec![0u16; w * i.height as usize];
            let s = ljpeg::decode_tile_stats(src, &mut buf, 0, w, w, i.height as usize).expect("stats");
            for (h, c) in hist.iter_mut().zip(s.category_hist) {
                *h += c;
            }
            n += s.total_symbols;
        }
    }
    println!("symbols {n}");
    for (t, c) in hist.iter().enumerate() {
        if *c > 0 {
            println!("t={t:2} {:6.2}%", *c as f64 * 100.0 / n as f64);
        }
    }
}
