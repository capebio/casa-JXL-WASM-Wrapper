//! P3-T7 colour sign-off: native reproduction of the WASM INITIAL/default render
//! for CR2 + DNG, used to measure the before/after colour drift of findings 50/51/52.
//!
//! This mirrors `src/lib.rs::decode_cr2_raw` / `decode_dng_raw` + `process_dng_impl`
//! exactly for the DEFAULT look (no slider overrides): same demosaic
//! (`demosaic_bayer_mhc` with the decoder's CFA phase), same PipelineParams
//! (black/white/wb_r/wb_b + `color_matrix` taken from the decoder — which is the
//! ONE field this branch changes), same ISO-gated luminance NR, DNG BaselineExposure
//! folded into exposure, and the same `process_auto` tone stage.
//!
//! The whole point of finding 52 is that `Cr2Image.color_matrix` differs between
//! origin/main (None → pipeline Olympus generic `CAM_TO_SRGB`) and this branch
//! (Some(Canon generic) via `resolved_color_matrix`). We read it from whichever
//! tree we are built in, so running this in each worktree reproduces the drift 1:1.
//!
//! Output: for each fixture `<name>` an `<name>.rgb` file = u32 LE width, u32 LE
//! height, then width*height*3 RGB8 bytes (post-orientation-independent: we do NOT
//! rotate, so before/after are pixel-aligned regardless of EXIF orientation).
//!
//! Usage: cargo run --release --example render_dump -- <fixture_dir> <out_dir>

use raw_pipeline::{cr2, demosaic, dng, pipeline};
use std::path::Path;

fn iso_nr_strength(iso: u32) -> f32 {
    match iso {
        iso if iso >= 6400 => 0.50,
        iso if iso >= 3200 => 0.35,
        iso if iso >= 1600 => 0.20,
        _ => 0.0,
    }
}

fn write_rgb(out_dir: &Path, name: &str, w: usize, h: usize, rgb: &[u8]) {
    assert_eq!(rgb.len(), w * h * 3, "rgb len mismatch for {name}");
    let mut buf = Vec::with_capacity(8 + rgb.len());
    buf.extend_from_slice(&(w as u32).to_le_bytes());
    buf.extend_from_slice(&(h as u32).to_le_bytes());
    buf.extend_from_slice(rgb);
    let p = out_dir.join(format!("{name}.rgb"));
    std::fs::write(&p, &buf).unwrap_or_else(|e| panic!("write {}: {e}", p.display()));
    println!("wrote {} ({}x{})", p.display(), w, h);
}

/// CR2 initial/default render — mirrors decode_cr2_raw (no look overrides).
fn render_cr2(data: &[u8]) -> Option<(usize, usize, Vec<u8>, String)> {
    let img = cr2::decode_bytes(data).ok()?;
    let (w, h) = (img.width, img.height);
    if w == 0 || h == 0 {
        return None;
    }
    let mut rgb16 = demosaic::demosaic_bayer_mhc(&img.raw, w, h, img.cfa_phase).ok()?;
    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = img.black;
    params.white = img.white;
    params.wb_r = img.wb_r;
    params.wb_b = img.wb_b;
    // THE finding-52 field: None on main (→ Olympus generic), Some(Canon) on branch.
    params.color_matrix = img.color_matrix.into();
    let iso = img.iso.unwrap_or(100);
    let s = iso_nr_strength(iso);
    if s > 0.0 {
        pipeline::apply_luminance_nr(&mut rgb16, w, h, s);
    }
    let rgb8 = pipeline::process_auto(&rgb16, &params);
    // Provenance line for the report.
    let mat = params.color_matrix.matrix();
    let prov = format!(
        "make={:?} model={:?} wb_r={:.4} wb_b={:.4} wb_from_camera={} matrix[0]=[{:.4},{:.4},{:.4}]",
        img.make, img.model, img.wb_r, img.wb_b, img.wb_from_camera, mat[0][0], mat[0][1], mat[0][2]
    );
    Some((w, h, rgb8, prov))
}

/// DNG initial/default render — mirrors decode_dng_raw + process_dng_impl default look
/// (BaselineExposure folded into exposure_ev; no slider overrides).
fn render_dng(data: &[u8]) -> Option<(usize, usize, Vec<u8>, String)> {
    let img = dng::decode_bytes(data).ok()?;
    let (w, h) = (img.width, img.height);
    if w == 0 || h == 0 {
        return None;
    }
    let phase = match img.cfa {
        dng::Cfa::Rggb => (0u8, 0u8),
        dng::Cfa::Grbg => (0, 1),
        dng::Cfa::Gbrg => (1, 0),
        dng::Cfa::Bggr => (1, 1),
    };
    // Finding 57: linear/uncompressed-RGB DNGs are already demosaiced (img.raw is w*h*3
    // interleaved RGB16) → bypass MHC. CFA DNGs demosaic as before.
    let mut rgb16 = if img.is_linear_rgb {
        img.raw.clone()
    } else {
        demosaic::demosaic_bayer_mhc(&img.raw, w, h, phase).ok()?
    };
    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = img.black;
    params.white = img.white;
    params.wb_r = img.wb_r;
    params.wb_b = img.wb_b;
    params.color_matrix = img.color_matrix.into();
    let iso = img.iso.unwrap_or(100);
    let s = iso_nr_strength(iso);
    if s > 0.0 {
        pipeline::apply_luminance_nr(&mut rgb16, w, h, s);
    }
    // Fold BaselineExposure into exposure (default look: exposure_ev = 0 + baseline).
    pipeline::apply_look_params(
        &mut params,
        img.baseline_exposure,
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    );
    let rgb8 = pipeline::process_auto(&rgb16, &params);
    let prov = format!(
        "make={:?} model={:?} wb_r={:.4} wb_b={:.4} wb_from_camera={} baseline_ev={:.3}",
        img.make, img.model, img.wb_r, img.wb_b, img.wb_from_camera, img.baseline_exposure
    );
    Some((w, h, rgb8, prov))
}

fn main() {
    let mut args = std::env::args().skip(1);
    let fixture_dir = args.next().expect("arg1: fixture dir");
    let out_dir = args.next().expect("arg2: out dir");
    let fixture_dir = Path::new(&fixture_dir);
    let out_dir = Path::new(&out_dir);
    std::fs::create_dir_all(out_dir).unwrap();

    let mut entries: Vec<_> = std::fs::read_dir(fixture_dir)
        .expect("read fixture dir")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    entries.sort();

    for path in entries {
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let stem = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let data = match std::fs::read(&path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let rendered = match ext.as_str() {
            "cr2" => render_cr2(&data),
            "dng" => render_dng(&data),
            _ => None,
        };
        match rendered {
            Some((w, h, rgb, prov)) => {
                println!("[{stem}] {prov}");
                write_rgb(out_dir, &stem, w, h, &rgb);
            }
            None => {
                if ext == "cr2" || ext == "dng" {
                    eprintln!("[{stem}] FAILED to render (skipped)");
                }
            }
        }
    }
}
