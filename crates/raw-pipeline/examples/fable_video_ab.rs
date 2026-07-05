//! Whole-clip casv A/B: FableBraid lossless tier vs JXL lossless (bbox, e3).
//!
//! Usage: fable_video_ab <rgb-file> <w> <h> <frames> [gop]

use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 5 {
        eprintln!("usage: fable_video_ab <rgb-file> <w> <h> <frames> [gop]");
        std::process::exit(1);
    }
    let (path, w, h, count) = (
        &a[1],
        a[2].parse::<u32>().unwrap(),
        a[3].parse::<u32>().unwrap(),
        a[4].parse::<usize>().unwrap(),
    );
    let gop = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(24u32);
    let flen = (w * h * 3) as usize;
    let raw = std::fs::read(path).expect("read rgb");
    let frames: Vec<&[u8]> = (0..count).map(|i| &raw[i * flen..(i + 1) * flen]).collect();
    let raw_mb = (flen * count) as f64 / 1e6;

    use raw_pipeline::casa_video::*;
    use raw_pipeline::jxl_casaencoder::EncodeOptions;

    let t = Instant::now();
    let fable = encode_casv_fable_rgb8(&frames, w, h, 24, 1, gop).unwrap();
    let fb_enc = t.elapsed().as_secs_f64() * 1e3;
    let t = Instant::now();
    let dec = decode_casv_all_rgb8(&fable).expect("fable decode");
    let fb_dec = t.elapsed().as_secs_f64() * 1e3;
    for (i, (px, _, _)) in dec.iter().enumerate() {
        assert_eq!(px, frames[i], "fable frame {i} byte-exact");
    }

    let t = Instant::now();
    let jxl =
        encode_casv_delta_bbox_rgb8(&frames, w, h, 24, 1, gop, EncodeOptions::lossless()).unwrap();
    let jx_enc = t.elapsed().as_secs_f64() * 1e3;
    let t = Instant::now();
    let dec = decode_casv_all_rgb8(&jxl).expect("jxl decode");
    let jx_dec = t.elapsed().as_secs_f64() * 1e3;
    for (i, (px, _, _)) in dec.iter().enumerate() {
        assert_eq!(px, frames[i], "jxl frame {i} byte-exact");
    }

    println!("clip {count} frames {w}x{h} (raw {raw_mb:.0} MB), gop {gop}, lossless both:");
    println!("  FableBraid: {:>9} B ({:.2}x)  enc {fb_enc:>7.0} ms  dec {fb_dec:>7.0} ms ({:.2} ms/f, {:.0} fps)",
             fable.len(), raw_mb * 1e6 / fable.len() as f64, fb_dec / count as f64, count as f64 / (fb_dec / 1e3));
    println!("  JXL bbox e3:{:>9} B ({:.2}x)  enc {jx_enc:>7.0} ms  dec {jx_dec:>7.0} ms ({:.2} ms/f, {:.0} fps)",
             jxl.len(), raw_mb * 1e6 / jxl.len() as f64, jx_dec / count as f64, count as f64 / (jx_dec / 1e3));
    println!(
        "  => decode speedup {:.2}x, bytes {:+.1}%",
        jx_dec / fb_dec,
        100.0 * (fable.len() as f64 - jxl.len() as f64) / jxl.len() as f64
    );
}
