//! Dump a RAW file's **sensor plane** as 16-bit PGM, and report what the camera
//! itself spent on it.
//!
//! Every "RAW class" figure in the blink project is measured on 8-bit demosaiced
//! RGB — 3 bytes a pixel of *rendered* output. Real sensor data is one plane at
//! 12–14 bits, Bayer-mosaiced: half the payload and a completely different
//! correlation structure. Nothing has ever measured blink there.
//!
//! 16-bit PGM is the useful container because HALIC accepts `.pgm`, so the same
//! reference codec can be pointed at the sensor plane without any new tooling.
//!
//! The camera's own compressed size is printed beside it because it is the
//! baseline that actually matters for archival: the question is not only whether
//! blink beats HALIC on sensor data, but whether either beats what the camera
//! already achieved in-body.
//!
//! Run: cargo run --release --no-default-features --example bayer_dump -- <file-or-dir> <outdir>
use raw_pipeline::panasonic::{decode_nef, decode_rw2, BayerImage};

fn walk(root: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    if root.is_file() {
        out.push(root.to_path_buf());
        return;
    }
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}

/// `(plane, width, height, bits, camera_payload_bytes)`
fn to_bayer(path: &std::path::Path) -> Result<(Vec<u16>, usize, usize, u32, usize), String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let d = std::fs::read(path).map_err(|e| format!("read: {e}"))?;
    match ext.as_str() {
        "rw2" | "rwl" => {
            let b: BayerImage = decode_rw2(&d)?;
            // Panasonic stores the payload from the raw offset to end of file.
            let n = d.len();
            Ok((b.raw, b.width, b.height, 12, n))
        }
        "nef" | "nrw" => {
            let b: BayerImage = decode_nef(&d)?;
            Ok((b.raw, b.width, b.height, 12, d.len()))
        }
        "orf" => {
            let info = raw_pipeline::tiff::parse(&d).map_err(|e| format!("{e}"))?;
            let (w, h) = (info.width as usize, info.height as usize);
            let s = info.strip_offset as usize;
            let n = info.strip_byte_count as usize;
            let strip = d.get(s..s + n).ok_or("ORF: strip past end of file")?;
            let raw = raw_pipeline::decompress::decompress(strip, w, h)
                .map_err(|e| format!("{e}"))?;
            Ok((raw, w, h, 12, n))
        }
        other => Err(format!("no Bayer decoder for .{other}")),
    }
}

fn write_pgm16(path: &std::path::Path, p: &[u16], w: usize, h: usize, maxval: u16) {
    // PGM stores 16-bit samples BIG-endian; getting this backwards produces a
    // file that opens fine and compresses like noise.
    let mut v = format!("P5\n{w} {h}\n{maxval}\n").into_bytes();
    v.reserve(p.len() * 2);
    for &s in p {
        v.push((s >> 8) as u8);
        v.push(s as u8);
    }
    let _ = std::fs::write(path, v);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: bayer_dump <file-or-dir> <outdir>");
        std::process::exit(2);
    }
    let outdir = std::path::PathBuf::from(&args[2]);
    std::fs::create_dir_all(&outdir).ok();
    let mut paths = Vec::new();
    walk(std::path::Path::new(&args[1]), &mut paths);
    paths.sort();

    println!(
        "{:<34}{:>12}{:>7}{:>11}{:>11}{:>10}",
        "frame", "sensor", "bits", "cam bytes", "cam b/smp", "max"
    );
    for p in &paths {
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(ext.as_str(), "rw2" | "rwl" | "nef" | "nrw" | "orf") {
            continue;
        }
        let stem = p.file_stem().unwrap().to_string_lossy().to_string();
        match to_bayer(p) {
            Ok((plane, w, h, bits, cam)) => {
                let mx = plane.iter().copied().max().unwrap_or(0);
                // A Bayer plane that is not an image is the failure mode that
                // produced a fictional -25% earlier in this project; refuse to
                // publish a number for one.
                let mut tot = 0u64;
                let mut cnt = 0u64;
                let mut y = 0;
                while y < h {
                    for x in 2..w {
                        let a = plane[y * w + x] as i32;
                        let b = plane[y * w + x - 2] as i32;
                        tot += (a - b).unsigned_abs() as u64;
                        cnt += 1;
                    }
                    y += 41;
                }
                let mad = tot as f64 / cnt.max(1) as f64;
                if mad > (1u32 << bits) as f64 / 12.0 {
                    println!("{:<34}  SKIP  plane looks like NOISE (mean |dx| = {mad:.0})", &stem[..stem.len().min(32)]);
                    continue;
                }
                write_pgm16(
                    &outdir.join(format!("{stem}.pgm")),
                    &plane,
                    w,
                    h,
                    mx.max(4095),
                );
                println!(
                    "{:<34}{:>12}{:>7}{:>11}{:>11.4}{:>10}",
                    &stem[..stem.len().min(32)],
                    format!("{w}x{h}"),
                    bits,
                    cam,
                    cam as f64 * 8.0 / (w * h) as f64,
                    mx
                );
            }
            Err(e) => println!("{:<34}  SKIP  {e}", &stem[..stem.len().min(32)]),
        }
    }
}
