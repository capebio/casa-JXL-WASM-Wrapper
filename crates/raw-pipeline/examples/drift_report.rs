//! P3-T7 colour sign-off: compare before/after `.rgb` renders (from render_dump),
//! compute per-file colour drift, and emit downscaled PNG thumbnails + a JSON summary.
//!
//! Usage: cargo run --release --example drift_report -- <before_dir> <after_dir> <html_out_dir>
//!
//! Reads matching `<name>.rgb` files from before_dir and after_dir. For each pair it
//! computes mean per-channel |ΔRGB|, max |ΔRGB|, and the fraction of pixels that changed
//! at all, writes `<name>.before.png` and `<name>.after.png` (downscaled to <=900px on the
//! long edge) into html_out_dir, and appends a JSON record. The JSON drives index.html.

use image::{ImageBuffer, Rgb};
use std::io::Write;
use std::path::Path;

fn read_rgb(p: &Path) -> Option<(usize, usize, Vec<u8>)> {
    let buf = std::fs::read(p).ok()?;
    if buf.len() < 8 {
        return None;
    }
    let w = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    let h = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]) as usize;
    let px = &buf[8..];
    if px.len() != w * h * 3 {
        return None;
    }
    Some((w, h, px.to_vec()))
}

/// Nearest-neighbour downscale to a max long-edge, returns a PNG-ready ImageBuffer.
fn thumb(w: usize, h: usize, rgb: &[u8], max_edge: usize) -> ImageBuffer<Rgb<u8>, Vec<u8>> {
    let scale = (w.max(h) as f64 / max_edge as f64).max(1.0);
    let tw = ((w as f64) / scale).round().max(1.0) as u32;
    let th = ((h as f64) / scale).round().max(1.0) as u32;
    ImageBuffer::from_fn(tw, th, |x, y| {
        let sx = ((x as f64) * scale) as usize;
        let sy = ((y as f64) * scale) as usize;
        let sx = sx.min(w - 1);
        let sy = sy.min(h - 1);
        let i = (sy * w + sx) * 3;
        Rgb([rgb[i], rgb[i + 1], rgb[i + 2]])
    })
}

fn main() {
    let mut args = std::env::args().skip(1);
    let before_dir = args.next().expect("arg1: before dir");
    let after_dir = args.next().expect("arg2: after dir");
    let out_dir = args.next().expect("arg3: html out dir");
    let before_dir = Path::new(&before_dir);
    let after_dir = Path::new(&after_dir);
    let out_dir = Path::new(&out_dir);
    std::fs::create_dir_all(out_dir).unwrap();

    let mut records: Vec<String> = Vec::new();

    let mut names: Vec<_> = std::fs::read_dir(after_dir)
        .expect("read after dir")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("rgb"))
        .collect();
    names.sort();

    for after_path in names {
        let stem = after_path.file_stem().and_then(|s| s.to_str()).unwrap().to_string();
        let before_path = before_dir.join(after_path.file_name().unwrap());
        let after = match read_rgb(&after_path) {
            Some(a) => a,
            None => continue,
        };
        let before = read_rgb(&before_path);

        let ext = if stem.to_ascii_lowercase().ends_with(".cr2") {
            "cr2"
        } else {
            "dng"
        };

        // Always write the AFTER thumbnail.
        let (aw, ah, argb) = &after;
        thumb(*aw, *ah, argb, 900)
            .save(out_dir.join(format!("{stem}.after.png")))
            .unwrap();

        let (mean_dr, max_dr, pct_changed, dims_match) = if let Some((bw, bh, brgb)) = &before {
            thumb(*bw, *bh, brgb, 900)
                .save(out_dir.join(format!("{stem}.before.png")))
                .unwrap();
            if bw == aw && bh == ah {
                let n = aw * ah;
                let mut sum_abs: u64 = 0; // sum over all channels of |delta|
                let mut max_abs: u32 = 0;
                let mut changed: u64 = 0;
                for i in 0..(n * 3) {
                    let d = (brgb[i] as i32 - argb[i] as i32).unsigned_abs();
                    sum_abs += d as u64;
                    if d > max_abs {
                        max_abs = d;
                    }
                }
                // %changed measured per-pixel (any channel differs).
                for p in 0..n {
                    let i = p * 3;
                    if brgb[i] != argb[i] || brgb[i + 1] != argb[i + 1] || brgb[i + 2] != argb[i + 2]
                    {
                        changed += 1;
                    }
                }
                let mean = sum_abs as f64 / (n as f64 * 3.0);
                let pct = changed as f64 / n as f64 * 100.0;
                (mean, max_abs as f64, pct, true)
            } else {
                (-1.0, -1.0, -1.0, false)
            }
        } else {
            // No before render (fixture failed on main) — after-only.
            (-2.0, -2.0, -2.0, false)
        };

        // P3-T9 finding labelling by fixture name (dual-illuminant vs linear-RGB).
        let lname = stem.to_ascii_lowercase();
        let finding = if ext == "cr2" {
            "52 (+51)"
        } else if lname.contains("linear_rgb") {
            "57 linear-RGB"
        } else if lname.contains("dual") || lname.contains("real_pixel") {
            "56 dual-illum"
        } else if lname.contains("single") {
            "56 single (zero-drift)"
        } else {
            "56/57"
        };
        records.push(format!(
            "{{\"name\":{:?},\"ext\":{:?},\"finding\":{:?},\"w\":{},\"h\":{},\"meanDR\":{:.4},\"maxDR\":{:.1},\"pctChanged\":{:.4},\"dimsMatch\":{}}}",
            stem, ext, finding, aw, ah, mean_dr, max_dr, pct_changed, dims_match
        ));
        println!(
            "[{stem}] finding {finding}: meanDR={mean_dr:.4} maxDR={max_dr:.1} pctChanged={pct_changed:.4}%"
        );
    }

    let json = format!("[\n  {}\n]\n", records.join(",\n  "));
    let mut f = std::fs::File::create(out_dir.join("drift.json")).unwrap();
    f.write_all(json.as_bytes()).unwrap();
    println!("wrote {}", out_dir.join("drift.json").display());
}
