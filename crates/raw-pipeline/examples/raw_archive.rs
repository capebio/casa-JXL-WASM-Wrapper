//! RAW file in, archive out, verified — the end-to-end path.
//!
//! Everything before this measured *sensor planes*. A RAW file is a sensor plane
//! **plus** its TIFF structure, EXIF, MakerNotes and a full-size embedded JPEG
//! preview, and an archiver that keeps only the pixels has thrown the shot away.
//! This carries both: the plane through `blizz::bayer`, and every other byte of
//! the original verbatim as a sidecar.
//!
//! **What is preserved:** every sensor sample, and every metadata byte.
//! **What is not:** the original file's bytes. Reproducing those would mean
//! reproducing the camera's own compressed sensor bitstream, which any codec that
//! beats the camera has by definition given up. DNG makes the same bargain.
//!
//! Run: cargo run --release --no-default-features --features blink-bench \
//!        --example raw_archive -- <file-or-dir>
use blizz::bayer::{decode_bayer_archive, encode_bayer_archive};
use raw_pipeline::panasonic::{decode_nef, decode_rw2};

/// `(plane, w, h, sensor_strip_range)` — the range is what the sidecar omits.
fn open_raw(
    path: &std::path::Path,
    d: &[u8],
) -> Result<(Vec<u16>, usize, usize, std::ops::Range<usize>), String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "orf" => {
            let info = raw_pipeline::tiff::parse(d).map_err(|e| format!("{e}"))?;
            let (w, h) = (info.width as usize, info.height as usize);
            let s = info.strip_offset as usize;
            let n = info.strip_byte_count as usize;
            let strip = d.get(s..s + n).ok_or("ORF: strip past end of file")?;
            let raw = raw_pipeline::decompress::decompress(strip, w, h).map_err(|e| format!("{e}"))?;
            Ok((raw, w, h, s..s + n))
        }
        // RW2/NEF expose no strip range through the current API, so the sidecar
        // would be the whole file and the archive would be larger than the
        // original. Refused loudly rather than measured dishonestly.
        "rw2" | "rwl" => {
            let b = decode_rw2(d)?;
            let _ = b;
            Err("RW2: strip range not exposed yet -- see the note in open_raw".into())
        }
        "nef" | "nrw" => {
            let b = decode_nef(d)?;
            let _ = b;
            Err("NEF: strip range not exposed yet -- see the note in open_raw".into())
        }
        other => Err(format!("no Bayer decoder for .{other}")),
    }
}

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

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: raw_archive <file-or-dir> [take]");
        std::process::exit(2);
    }
    let take: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(usize::MAX);
    let mut paths = Vec::new();
    walk(std::path::Path::new(&args[1]), &mut paths);
    paths.sort();
    paths.retain(|p| {
        p.extension()
            .and_then(|s| s.to_str())
            .is_some_and(|x| matches!(x.to_ascii_lowercase().as_str(), "orf" | "rw2" | "rwl" | "nef" | "nrw"))
    });
    paths.truncate(take);

    println!(
        "{:<26}{:>12}{:>12}{:>11}{:>10}{:>9}",
        "frame", "original", "archive", "sidecar", "saved", "verify"
    );
    let (mut to, mut ta, mut ts, mut n, mut skipped) = (0u64, 0u64, 0u64, 0usize, 0usize);
    for path in &paths {
        let stem = path.file_stem().unwrap().to_string_lossy().to_string();
        let d = match std::fs::read(path) {
            Ok(d) => d,
            Err(e) => {
                println!("{:<26}  SKIP  read: {e}", &stem[..stem.len().min(24)]);
                skipped += 1;
                continue;
            }
        };
        let (px, w, h, strip) = match open_raw(path, &d) {
            Ok(v) => v,
            Err(e) => {
                println!("{:<26}  SKIP  {e}", &stem[..stem.len().min(24)]);
                skipped += 1;
                continue;
            }
        };

        // The sidecar is the ORIGINAL FILE MINUS the sensor strip, in order.
        let mut sidecar = Vec::with_capacity(d.len() - strip.len());
        sidecar.extend_from_slice(&d[..strip.start]);
        sidecar.extend_from_slice(&d[strip.end..]);

        let arc = encode_bayer_archive(&px, w, h, 12, 128, &sidecar);

        // **Verify before reporting a saving.** An archive that has not been read
        // back is a claim, not a result.
        let (back, bw, bh, side_back) = match decode_bayer_archive(&arc) {
            Ok(v) => v,
            Err(e) => {
                println!("{:<26}  FAIL  archive does not decode: {e}", &stem[..stem.len().min(24)]);
                skipped += 1;
                continue;
            }
        };
        let ok = (bw, bh) == (w, h) && back == px && side_back == sidecar;
        if !ok {
            println!("{:<26}  FAIL  round trip differs", &stem[..stem.len().min(24)]);
            skipped += 1;
            continue;
        }

        to += d.len() as u64;
        ta += arc.len() as u64;
        ts += sidecar.len() as u64;
        n += 1;
        println!(
            "{:<26}{:>12}{:>12}{:>11}{:>9.1}%{:>9}",
            &stem[..stem.len().min(24)],
            d.len(),
            arc.len(),
            sidecar.len(),
            100.0 * (1.0 - arc.len() as f64 / d.len() as f64),
            "OK"
        );
    }
    if n > 0 {
        println!(
            "\nARCHIVED {n} files ({skipped} skipped)\n  original {:.1} MB\n  archive  {:.1} MB\n  \
sidecar  {:.1} MB ({:.1}% of the originals, carried verbatim)\n  SAVED    {:.1}%  \
-- every sample and every metadata byte preserved, all round-trips verified",
            to as f64 / 1e6,
            ta as f64 / 1e6,
            ts as f64 / 1e6,
            100.0 * ts as f64 / to as f64,
            100.0 * (1.0 - ta as f64 / to as f64)
        );
    } else {
        println!("\nNo file archived ({skipped} skipped).");
    }
}
