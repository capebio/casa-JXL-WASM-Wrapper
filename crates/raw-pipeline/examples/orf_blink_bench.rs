//! RAW -> blink, entirely in memory. No PPM, no .rgb, no intermediate of any kind.
//!
//! `orf_jxl_sweep.rs` established this shape for JXL and this mirrors it for blink.
//! The point is not only the ~244 MB of disk traffic a frame it removes: a
//! whole-process blink measurement carries a 6.30 ms spawn on this box, which is
//! larger than the encode gap being measured. blink became a library module
//! (`blizz::blink`) precisely so this file could exist.
//!
//! HALIC is an external executable and can only be fed a file, so ONE temp PPM per
//! frame is written for it and deleted immediately. blink's own path never touches
//! the disk.
//!
//! Run:
//!   cargo run --release --no-default-features --features blink-bench \
//!     --example orf_blink_bench -- "C:\995\2026-02-20 Gobabeb To Windhoek" 10
//!   cargo run --release --no-default-features --features blink-bench \
//!     --example orf_blink_bench -- "C:\Foo\raw-converter\tests\raw-pixls" 99
use blizz::blink::{choose, decode, encode, Opts};
use raw_pipeline::{cr2, demosaic, dng, pipeline};
use std::time::Instant;

/// Decoded frame as three 8-bit planes, which is what blink takes.
struct Planes {
    p: [Vec<u8>; 3],
    w: usize,
    h: usize,
}

fn to_planes(rgb8: &[u8], w: usize, h: usize) -> Planes {
    let n = w * h;
    let mut p = [vec![0u8; n], vec![0u8; n], vec![0u8; n]];
    for (i, px) in rgb8.chunks_exact(3).enumerate().take(n) {
        p[0][i] = px[0];
        p[1][i] = px[1];
        p[2][i] = px[2];
    }
    Planes { p, w, h }
}

fn from_rgba(rgba: &[u8], w: usize, h: usize) -> Planes {
    let n = w * h;
    let mut p = [vec![0u8; n], vec![0u8; n], vec![0u8; n]];
    for (i, px) in rgba.chunks_exact(4).enumerate().take(n) {
        p[0][i] = px[0];
        p[1][i] = px[1];
        p[2][i] = px[2];
    }
    Planes { p, w, h }
}

/// Bayer -> demosaic -> tone, the same chain `render_dump.rs` uses. Shared by the
/// CR2 and DNG arms so the two cannot drift apart.
fn render_bayer(
    raw: &[u16],
    w: usize,
    h: usize,
    cfa_phase: (u8, u8),
    black: u16,
    white: u16,
    wb_r: f32,
    wb_b: f32,
) -> Option<Planes> {
    let rgb16 = demosaic::demosaic_bayer_mhc(raw, w, h, cfa_phase).ok()?;
    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = black;
    params.white = white;
    params.wb_r = wb_r;
    params.wb_b = wb_b;
    let rgb8 = pipeline::process_auto(&rgb16, &params);
    Some(to_planes(&rgb8, w, h))
}

fn decode_any(path: &std::path::Path) -> Result<Planes, String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let data = std::fs::read(path).map_err(|e| format!("read: {e}"))?;
    match ext.as_str() {
        "orf" => {
            let (rgba, w, h) =
                raw_pipeline::decode_orf_rgba8(&data).map_err(|e| format!("orf: {e}"))?;
            Ok(from_rgba(&rgba, w as usize, h as usize))
        }
        "cr2" => {
            let img = cr2::decode_bytes(&data).map_err(|e| format!("cr2: {e}"))?;
            render_bayer(
                &img.raw, img.width, img.height, img.cfa_phase, img.black, img.white, img.wb_r,
                img.wb_b,
            )
            .ok_or_else(|| "cr2: demosaic failed".to_string())
        }
        "dng" => {
            let img = dng::decode_bytes(&data).map_err(|e| format!("dng: {e}"))?;
            // Same mapping `render_dump.rs` uses; DngImage carries a Cfa enum
            // where Cr2Image carries the phase pair directly.
            let phase = match img.cfa {
                dng::Cfa::Rggb => (0u8, 0u8),
                dng::Cfa::Grbg => (0, 1),
                dng::Cfa::Gbrg => (1, 0),
                dng::Cfa::Bggr => (1, 1),
            };
            render_bayer(
                &img.raw, img.width, img.height, phase, img.black, img.white, img.wb_r, img.wb_b,
            )
            .ok_or_else(|| "dng: demosaic failed".to_string())
        }
        // NEF, NRW and RW2 are TIFF-based, so the DNG and CR2 readers may well
        // eat them even though nothing names them. Probe rather than assume --
        // the extension is not the format.
        other => {
            if let Ok(img) = dng::decode_bytes(&data) {
                let phase = match img.cfa {
                    dng::Cfa::Rggb => (0u8, 0u8),
                    dng::Cfa::Grbg => (0, 1),
                    dng::Cfa::Gbrg => (1, 0),
                    dng::Cfa::Bggr => (1, 1),
                };
                if let Some(pl) = render_bayer(
                    &img.raw, img.width, img.height, phase, img.black, img.white, img.wb_r,
                    img.wb_b,
                ) {
                    eprintln!("  (.{other} decoded by the DNG reader)");
                    return Ok(pl);
                }
            }
            if let Ok(img) = cr2::decode_bytes(&data) {
                if let Some(pl) = render_bayer(
                    &img.raw, img.width, img.height, img.cfa_phase, img.black, img.white,
                    img.wb_r, img.wb_b,
                ) {
                    eprintln!("  (.{other} decoded by the CR2 reader)");
                    return Ok(pl);
                }
            }
            Err(format!("no native decoder for .{other}, and neither DNG nor CR2 accepts it"))
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: orf_blink_bench <dir> [take]");
        std::process::exit(2);
    }
    let root = &args[1];
    let take: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(10);

    let mut paths: Vec<std::path::PathBuf> = walk(std::path::Path::new(root));
    paths.sort();
    paths.truncate(take);

    let halic = std::path::Path::new(
        r"C:\Foo\raw-converter\tests\fractal_gen\_compress_probe\codec\HALIC\HALIC_ENCODE_V.0.7.2_ST_FAST_AVX2.exe",
    );
    let tmp = std::env::temp_dir().join(format!("blinkbench-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).ok();

    println!(
        "{:<34}{:>8}{:>13}{:>10}{:>10}{:>9}{:>9}",
        "frame", "MPx", "blink B", "blk bpp", "hal bpp", "vs hal", "enc ms"
    );
    let (mut tb, mut th, mut tn, mut ok, mut skipped) = (0usize, 0usize, 0usize, 0usize, 0usize);
    for path in &paths {
        let stem = path.file_stem().unwrap().to_string_lossy().to_string();
        let pl = match decode_any(path) {
            Ok(p) => p,
            Err(e) => {
                // Report, never skip silently -- a corpus that quietly shrinks is
                // how a codec gets measured on content it never saw.
                println!("{:<34}  SKIP  {}", &stem[..stem.len().min(32)], e);
                skipped += 1;
                continue;
            }
        };
        let (w, h) = (pl.w, pl.h);
        let n = w * h;

        let (pred, rct, coder) = choose(&pl.p, w, h);
        let o = Opts::new(coder, pred, rct, false).expect("chooser produced a legal arm");
        let t = Instant::now();
        let bytes = encode(&pl.p, w, h, o);
        let ms = t.elapsed().as_secs_f64() * 1e3;

        // The gate: the in-memory path must round-trip byte-exact with no file.
        let (back, bw, bh) = decode(&bytes).expect("blink decode");
        assert_eq!((bw, bh), (w, h), "{stem}: dims");
        assert_eq!(back, pl.p, "{stem}: NOT byte-exact");

        // HALIC needs a file. One temp PPM, deleted immediately.
        let ppm = tmp.join("h.ppm");
        let hb = {
            let mut v = Vec::with_capacity(n * 3 + 32);
            v.extend_from_slice(format!("P6\n{w} {h}\n255\n").as_bytes());
            for i in 0..n {
                v.push(pl.p[0][i]);
                v.push(pl.p[1][i]);
                v.push(pl.p[2][i]);
            }
            std::fs::write(&ppm, &v).ok();
            let out = tmp.join("h.halic");
            let _ = std::process::Command::new(halic).arg(&ppm).arg(&out).output();
            let len = std::fs::metadata(&out).map(|m| m.len() as usize).unwrap_or(0);
            std::fs::remove_file(&ppm).ok();
            std::fs::remove_file(&out).ok();
            len
        };

        let bbpp = bytes.len() as f64 * 8.0 / (n * 3) as f64;
        let hbpp = if hb > 0 { hb as f64 * 8.0 / (n * 3) as f64 } else { f64::NAN };
        println!(
            "{:<34}{:>8.2}{:>13}{:>10.4}{:>10.4}{:>8.2}%{:>9.1}",
            &stem[..stem.len().min(32)],
            n as f64 / 1e6,
            bytes.len(),
            bbpp,
            hbpp,
            100.0 * (bytes.len() as f64 - hb as f64) / hb as f64,
            ms
        );
        tb += bytes.len();
        th += hb;
        tn += n * 3;
        ok += 1;
    }
    std::fs::remove_dir_all(&tmp).ok();
    if ok > 0 {
        println!(
            "\nCORPUS {ok} frames ({skipped} skipped), {:.1} MPx\n  blink      {:>14} B  {:.4} bits/sample\n  HALIC-fast {:>14} B  {:.4} bits/sample\n  blink vs HALIC-fast: {:+.2}%",
            tn as f64 / 3e6,
            tb,
            tb as f64 * 8.0 / tn as f64,
            th,
            th as f64 * 8.0 / tn as f64,
            100.0 * (tb as f64 - th as f64) / th as f64
        );
    }
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else if p
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|x| matches!(x.to_ascii_lowercase().as_str(), "orf" | "cr2" | "dng" | "crw" | "cr3" | "nef" | "nrw" | "rw2" | "rwl"))
        {
            out.push(p);
        }
    }
    out
}
