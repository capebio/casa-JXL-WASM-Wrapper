//! Does the WB-scaled MHC demosaic help CR2 the way it helped ORF?
//!
//! `src/lib.rs` demosaics the un-white-balanced CR2/DNG mosaic with `MhcGains::UNITY`
//! while `tiff.rs` (ORF), `dng.rs` and `stream_band.rs` use `MhcGains::from_wb`. The
//! argument for `from_wb` (d8579328) is that the MHC cross-channel gradient terms are
//! ~1.9x hot on R/B and ~0.5x cold on G before white balance, which locks green speckle
//! to the CFA lattice. That was measured for ORF against the camera's own JPEG; this
//! runs the same measurement for CR2, so the shipped change rests on numbers rather
//! than on a test going green.
//!
//! Metrics are the ones `tools/green-probe-scripts/census_corpus.py` reports, so the
//! output is comparable with the ORF census: mean luma, % of frame >= 240, and the
//! green-sparkle count per megapixel (g > r+40 && g > b+40 && g > 140). Our render is
//! resized to the embedded preview's dimensions first — sparkle density is
//! scale-dependent, and the camera JPEG is the only independent reference we have.
//!
//! Run: cargo run --release --example cr2_gains_census -- [dir_or_file ...]

use image::{imageops, ImageBuffer, Rgb};
use raw_pipeline::{cr2, demosaic, image_formats, pipeline, tiff};
use std::{fs, path::PathBuf};

/// census_corpus.py's `census()`, byte-for-byte in intent.
struct Census {
    luma: f64,
    clip: f64,
    sparkle_per_mp: f64,
}

fn census(rgb: &[u8], w: usize, h: usize) -> Census {
    let n = w * h;
    let mp = n as f64 / 1e6;
    let mut sum = 0.0f64;
    let mut clipped = 0usize;
    let mut sparks = 0usize;
    for i in 0..n {
        let (r, g, b) = (rgb[i * 3] as f64, rgb[i * 3 + 1] as f64, rgb[i * 3 + 2] as f64);
        let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sum += y;
        if y >= 240.0 {
            clipped += 1;
        }
        if g > r + 40.0 && g > b + 40.0 && g > 140.0 {
            sparks += 1;
        }
    }
    Census {
        luma: sum / n as f64,
        clip: 100.0 * clipped as f64 / n as f64,
        sparkle_per_mp: sparks as f64 / mp.max(1e-9),
    }
}

/// The shipping CR2 batch render (mirrors src/lib.rs process_cr2), with the demosaic
/// gains as the single variable.
fn render(data: &[u8], gains: demosaic::MhcGains) -> Option<(usize, usize, Vec<u8>)> {
    let img = cr2::decode_bytes(data).ok()?;
    let (w, h) = (img.width, img.height);
    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = img.black;
    params.white = img.white;
    params.wb_r = img.wb_r;
    params.wb_b = img.wb_b;
    params.color_matrix = img.color_matrix.into();
    let rgb16 = demosaic::demosaic_bayer_mhc_gains(&img.raw, w, h, img.cfa_phase, gains).ok()?;
    let mut rgb8 = vec![0u8; w * h * 3];
    pipeline::process_into_auto(&rgb16, &params, &mut rgb8);
    Some((w, h, rgb8))
}

fn resize_to(rgb: &[u8], w: usize, h: usize, tw: u32, th: u32) -> Vec<u8> {
    let buf: ImageBuffer<Rgb<u8>, _> =
        ImageBuffer::from_raw(w as u32, h as u32, rgb.to_vec()).expect("buffer");
    imageops::resize(&buf, tw, th, imageops::FilterType::Triangle).into_raw()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let roots = if args.is_empty() {
        vec![String::from(r"C:\Foo\raw-converter\tests")]
    } else {
        args
    };

    let mut files: Vec<PathBuf> = Vec::new();
    for r in &roots {
        let p = PathBuf::from(r);
        if p.is_dir() {
            if let Ok(rd) = fs::read_dir(&p) {
                for e in rd.flatten() {
                    let q = e.path();
                    if q.extension().is_some_and(|x| x.eq_ignore_ascii_case("cr2")) {
                        files.push(q);
                    }
                }
            }
        } else if p.is_file() {
            files.push(p);
        }
    }
    files.sort();
    if files.is_empty() {
        eprintln!("no CR2 files found in {roots:?}");
        return;
    }

    println!(
        "{:<26} {:>18} {:>18} {:>18}",
        "file", "embedded(cam)", "UNITY (shipped)", "from_wb (proposed)"
    );
    println!("{:<26} {:>18} {:>18} {:>18}", "", "luma clip spark", "luma clip spark", "luma clip spark");

    // Aggregates: mean |delta luma| vs camera, and mean sparkle/MP, per arm.
    let (mut n, mut du, mut dg, mut su, mut sg, mut sc) = (0usize, 0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);

    for f in &files {
        let Ok(data) = fs::read(f) else { continue };
        let name: String = f.file_name().unwrap().to_string_lossy().chars().take(26).collect();

        // The camera's own render, straight out of the file.
        let Some(range) = tiff::find_embedded_jpeg_range(&data) else {
            println!("{name:<26} (no embedded JPEG - skipped)");
            continue;
        };
        let Ok(emb) = image_formats::decode_jpeg_bytes(&data[range]) else {
            println!("{name:<26} (embedded JPEG failed to decode - skipped)");
            continue;
        };
        let (ew, eh) = (emb.width as usize, emb.height as usize);
        let mut ergb = vec![0u8; ew * eh * 3];
        for i in 0..ew * eh {
            ergb[i * 3] = emb.u8[i * 4];
            ergb[i * 3 + 1] = emb.u8[i * 4 + 1];
            ergb[i * 3 + 2] = emb.u8[i * 4 + 2];
        }
        let ce = census(&ergb, ew, eh);

        let Some((w, h, unity)) = render(&data, demosaic::MhcGains::UNITY) else {
            println!("{name:<26} (CR2 decode failed - skipped)");
            continue;
        };
        let img = cr2::decode_bytes(&data).unwrap();
        let wb = demosaic::MhcGains::from_wb(
            img.wb_r,
            pipeline::PipelineParams::default_olympus().wb_g,
            img.wb_b,
        );
        let Some((_, _, gained)) = render(&data, wb) else { continue };

        // Matched scale for luma/clip (comparable with the camera), but sparkle is a
        // high-frequency artefact that a downscale averages away — so it is counted at
        // full resolution, where the lattice-locked speckle actually lives.
        let cu = census(&resize_to(&unity, w, h, ew as u32, eh as u32), ew, eh);
        let cg = census(&resize_to(&gained, w, h, ew as u32, eh as u32), ew, eh);
        let fu = census(&unity, w, h);
        let fg = census(&gained, w, h);

        // Does the gains change move CR2 pixels at all?
        let (mut sumd, mut maxd, mut ndiff) = (0u64, 0u8, 0usize);
        for i in 0..unity.len() {
            let d = unity[i].abs_diff(gained[i]);
            sumd += d as u64;
            if d > maxd {
                maxd = d;
            }
            if d != 0 {
                ndiff += 1;
            }
        }
        println!(
            "    full-res sparkle/MP: UNITY {:.0} -> from_wb {:.0}   |  unity-vs-gains delta: mean {:.4} max {maxd} over {:.2}% of subpixels",
            fu.sparkle_per_mp,
            fg.sparkle_per_mp,
            sumd as f64 / unity.len() as f64,
            100.0 * ndiff as f64 / unity.len() as f64,
        );

        println!(
            "{name:<26} {:>6.1}{:>6.2}{:>6.0} {:>6.1}{:>6.2}{:>6.0} {:>6.1}{:>6.2}{:>6.0}",
            ce.luma, ce.clip, ce.sparkle_per_mp,
            cu.luma, cu.clip, cu.sparkle_per_mp,
            cg.luma, cg.clip, cg.sparkle_per_mp,
        );

        n += 1;
        du += (cu.luma - ce.luma).abs();
        dg += (cg.luma - ce.luma).abs();
        // Full-res: the matched-scale resize averages the lattice speckle away, which is
        // exactly the artefact the gains change targets.
        su += fu.sparkle_per_mp;
        sg += fg.sparkle_per_mp;
        sc += ce.sparkle_per_mp;
    }

    if n > 0 {
        let k = n as f64;
        println!("\n{n} files");
        println!("  mean |delta luma| vs camera:  UNITY {:.2}   from_wb {:.2}", du / k, dg / k);
        println!(
            "  mean sparkles/MP (full-res):  UNITY {:.2}   from_wb {:.2}   [camera, matched scale {:.2}]",
            su / k, sg / k, sc / k
        );
        println!(
            "\n  from_wb is {} on luma and {} on sparkle.",
            if dg < du { "CLOSER to the camera" } else if dg > du { "further from the camera" } else { "level" },
            if sg < su { "LOWER (better)" } else if sg > su { "higher (worse)" } else { "unchanged" }
        );
    }
}
