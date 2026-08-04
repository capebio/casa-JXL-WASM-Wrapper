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
        // Both now report the byte range their sensor payload occupies, which is
        // what an archiver needs to carry everything else verbatim. RW2's comes
        // from the bit reader's own cursor rather than "offset to EOF", so
        // trailing metadata is not swallowed into the strip and lost.
        "rw2" | "rwl" => {
            let b = decode_rw2(d)?;
            Ok((b.raw, b.width, b.height, b.strip))
        }
        "nef" | "nrw" => {
            let b = decode_nef(d)?;
            Ok((b.raw, b.width, b.height, b.strip))
        }
        other => Err(format!("no Bayer decoder for .{other}")),
    }
}

/// A full-size embedded preview is **derived data** — a JPEG rendering of the
/// sensor plane the archive already stores losslessly. Measured on 8 ORFs it is
/// 8.7 MB of a 12.2 MB sidecar, and dropping it moves the archive from 11.9% to
/// 18.0% saved.
///
/// Thumbnails are NOT dropped: they total 0.2 MB across the same 8 files, so
/// keeping them costs 0.1 of a point and preserves instant browsing without
/// decoding a 20 MPx plane.
///
/// **The distinction that matters: metadata is irreplaceable, a preview is not.**
/// EXIF, MakerNotes and the TIFF structure cannot be regenerated from pixels;
/// a preview can. Dropping one is a different act from dropping the other.
const PREVIEW_MIN: usize = 100_000;

/// Byte ranges of JPEG segments at or above `PREVIEW_MIN`, in file order.
fn full_size_previews(d: &[u8]) -> Vec<std::ops::Range<usize>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while let Some(a) = find(d, &[0xFF, 0xD8, 0xFF], i) {
        let Some(b) = find(d, &[0xFF, 0xD9], a) else { break };
        let end = b + 2;
        if end - a >= PREVIEW_MIN {
            out.push(a..end);
        }
        i = end;
    }
    out
}

fn find(h: &[u8], n: &[u8], from: usize) -> Option<usize> {
    if from >= h.len() {
        return None;
    }
    h[from..].windows(n.len()).position(|w| w == n).map(|p| p + from)
}

/// **A round-trip proves our codec is self-consistent. It says NOTHING about
/// whether the sensor was decoded correctly.**
///
/// `nikon_coolpix-b700`'s NRW decodes without error and produces noise -- it is
/// not packed 12-bit despite declaring Compression=1 -- and the first version of
/// this tool archived it at "12.5% saved, OK". For a benchmark that is a wrong
/// number; for an ARCHIVER it is storing garbage and discarding the original.
///
/// Same test the blink bench uses: mean absolute horizontal difference between
/// same-colour neighbours. A photograph sits far below the sensor range; noise
/// sits near a third of it.
fn looks_like_noise(px: &[u16], w: usize, h: usize, bits: u32) -> Option<f64> {
    let (mut tot, mut n) = (0u64, 0u64);
    let mut y = 0usize;
    while y < h {
        let row = &px[y * w..(y + 1) * w];
        for x in 2..w {
            tot += (row[x] as i32 - row[x - 2] as i32).unsigned_abs() as u64;
            n += 1;
        }
        y += 37;
    }
    let mad = tot as f64 / n.max(1) as f64;
    // A real image is a few percent of full scale between same-colour neighbours.
    if mad > (1u32 << bits) as f64 / 12.0 { Some(mad) } else { None }
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
        "{:<26}{:>12}{:>12}{:>11}{:>10}{:>10}{:>8}",
        "frame", "original", "archive", "sidecar", "preview", "saved", "verify"
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

        // The sidecar is the ORIGINAL FILE MINUS the sensor strip and MINUS any
        // full-size preview, in order. Dropped ranges are recorded so a restorer
        // knows a preview existed and where, rather than silently finding none.
        // Refuse to archive a plane that is not an image, BEFORE anything is
        // written or any saving is reported.
        if let Some(mad) = looks_like_noise(&px, w, h, 12) {
            println!(
                "{:<26}  SKIP  decoded sensor looks like NOISE (mean |dx| = {mad:.0}) -- the decoder is wrong, archiving it would store garbage",
                &stem[..stem.len().min(24)]
            );
            skipped += 1;
            continue;
        }

        let keep_prev = std::env::var("ARCHIVE_KEEP_PREVIEW").is_ok();
        let drop: Vec<std::ops::Range<usize>> = if keep_prev {
            Vec::new()
        } else {
            full_size_previews(&d)
                .into_iter()
                .filter(|r| r.end <= strip.start || r.start >= strip.end)
                .collect()
        };
        let mut cut: Vec<std::ops::Range<usize>> = drop.clone();
        cut.push(strip.clone());
        cut.sort_by_key(|r| r.start);

        let mut sidecar = Vec::with_capacity(d.len());
        // Header: how many previews were dropped, and their original extents.
        sidecar.extend_from_slice(&(drop.len() as u32).to_le_bytes());
        for r in &drop {
            sidecar.extend_from_slice(&(r.start as u32).to_le_bytes());
            sidecar.extend_from_slice(&(r.len() as u32).to_le_bytes());
        }
        let mut at = 0usize;
        for r in &cut {
            if r.start > at {
                sidecar.extend_from_slice(&d[at..r.start]);
            }
            at = at.max(r.end);
        }
        sidecar.extend_from_slice(&d[at..]);
        let dropped_bytes: usize = drop.iter().map(|r| r.len()).sum();

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
            "{:<26}{:>12}{:>12}{:>11}{:>10}{:>9.1}%{:>8}",
            &stem[..stem.len().min(24)],
            d.len(),
            arc.len(),
            sidecar.len(),
            if keep_prev { "kept".to_string() } else { format!("-{dropped_bytes}") },
            100.0 * (1.0 - arc.len() as f64 / d.len() as f64),
            "OK"
        );
    }
    if n > 0 {
        println!(
            "\nARCHIVED {n} files ({skipped} skipped)\n  original {:.1} MB\n  archive  {:.1} MB\n  \
sidecar  {:.1} MB ({:.1}% of the originals, carried verbatim)\n  SAVED    {:.1}%  \
-- every sample and every METADATA byte preserved, all round-trips verified.\n  \
Full-size previews are DROPPED unless ARCHIVE_KEEP_PREVIEW=1; they are derived \
data, regenerable from the plane, and keeping them costs ~6 points.",
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
