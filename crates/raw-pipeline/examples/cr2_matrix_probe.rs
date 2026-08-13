//! Is the CR2 colour matrix the wrong one (camera->XYZ used as camera->sRGB)?
//!
//! `docs/CR2-ADH1234-divergence-2026-08-13.md` records the structural argument: our resolved
//! CR2 matrix is all-positive and row-normalised, where LibRaw's `rgb_cam` (camera->sRGB) has
//! large negative off-diagonals. An all-positive row-normalised matrix is a weighted average
//! of the channels and can only desaturate.
//!
//! Structure is an argument, not evidence. This renders each Canon file twice -- once with the
//! matrix the pipeline resolves today, once with the matrix derived dcraw's way from LibRaw's
//! `cam_xyz` for the body -- and scores both against the camera's own embedded JPEG. If the
//! derived matrix lands closer, the hypothesis holds and the fix is a matrix-resolution change.
//!
//! Run: cargo run --release --example cr2_matrix_probe -- [dir_or_file ...]

use image::{imageops, ImageBuffer, Rgb};
use raw_pipeline::{cr2, demosaic, image_formats, pipeline, tiff};
use std::{fs, path::PathBuf};

/// sRGB (D65) primaries -> XYZ. dcraw's `xyz_rgb`.
const XYZ_RGB: [[f64; 3]; 3] = [
    [0.412453, 0.357580, 0.180423],
    [0.212671, 0.715160, 0.072169],
    [0.019334, 0.119193, 0.950227],
];

/// LibRaw's `cam_xyz` per body, read out of the corpus via
/// `META=1 node tools/colour-verify-corpus.mjs` (they come from LibRaw's built-in
/// Adobe-coefficient table, not from the files).
///
/// The 550D matters: the comment that disabled `canon_cam_xyz` in `cr2.rs` cites it by
/// name as the body where adobe coefficients "cause channel collapse (G->0 with
/// r_mult~2.2)". If dcraw's normalise-then-invert derivation renders it correctly, that
/// objection is answered on its own counterexample.
const CAM_XYZ: &[(&str, [[f64; 3]; 3])] = &[
    (
        "EOS M5",
        [
            [0.8532, -0.0701, -0.1167],
            [-0.4095, 1.1879, 0.2508],
            [-0.0797, 0.2424, 0.7010],
        ],
    ),
    (
        "EOS 550D",
        [
            [0.6941, -0.1164, -0.0857],
            [-0.3825, 1.1597, 0.2534],
            [-0.0416, 0.1540, 0.6039],
        ],
    ),
    // Same body, other regional names. LibRaw normalises these to "EOS 550D"; our decoder
    // reports the EXIF string verbatim, so a table keyed on the raw model would silently
    // miss two of the three names this camera ships under. Any real per-model table needs
    // the same aliasing.
    (
        "EOS Kiss X4",
        [
            [0.6941, -0.1164, -0.0857],
            [-0.3825, 1.1597, 0.2534],
            [-0.0416, 0.1540, 0.6039],
        ],
    ),
    (
        "EOS Rebel T2i",
        [
            [0.6941, -0.1164, -0.0857],
            [-0.3825, 1.1597, 0.2534],
            [-0.0416, 0.1540, 0.6039],
        ],
    ),
];

fn cam_xyz_for(model: &str) -> Option<[[f64; 3]; 3]> {
    CAM_XYZ
        .iter()
        .find(|(m, _)| model.eq_ignore_ascii_case(m) || model.to_ascii_lowercase().contains(&m.to_ascii_lowercase()))
        .map(|(_, m)| *m)
}

/// dcraw's `cam_xyz_coeff`: cam_rgb = cam_xyz . xyz_rgb, rows normalised to unit sum
/// (that normalisation is where dcraw's `pre_mul` comes from), then inverted to give
/// `rgb_cam` -- the camera->sRGB matrix actually applied to pixels.
fn derive_rgb_cam(cam_xyz: [[f64; 3]; 3]) -> ([[f64; 3]; 3], [[f64; 3]; 3]) {
    let mut cam_rgb = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            cam_rgb[i][j] = (0..3).map(|k| cam_xyz[i][k] * XYZ_RGB[k][j]).sum();
        }
    }
    let mut norm = cam_rgb;
    for row in norm.iter_mut() {
        let s: f64 = row.iter().sum();
        if s.abs() > 1e-12 {
            for v in row.iter_mut() {
                *v /= s;
            }
        }
    }
    (norm, invert3(norm))
}

fn invert3(m: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    let d = if det.abs() < 1e-12 { 1.0 } else { det };
    let mut o = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            let (a, b) = ((i + 1) % 3, (i + 2) % 3);
            let (c, e) = ((j + 1) % 3, (j + 2) % 3);
            // Transposed cofactor / det.
            o[j][i] = (m[a][c] * m[b][e] - m[a][e] * m[b][c]) / d;
        }
    }
    o
}

fn to_f32(m: [[f64; 3]; 3]) -> [[f32; 3]; 3] {
    let mut o = [[0.0f32; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            o[i][j] = m[i][j] as f32;
        }
    }
    o
}

fn ratios(rgb: &[u8]) -> (f64, f64) {
    let (mut r, mut g, mut b) = (0.0f64, 0.0, 0.0);
    for p in rgb.chunks_exact(3) {
        r += p[0] as f64;
        g += p[1] as f64;
        b += p[2] as f64;
    }
    let g = if g == 0.0 { 1e-9 } else { g };
    (r / g, b / g)
}

fn render(data: &[u8], matrix: Option<[[f32; 3]; 3]>) -> Option<(usize, usize, Vec<u8>)> {
    let img = cr2::decode_bytes(data).ok()?;
    let (w, h) = (img.width, img.height);
    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = img.black;
    params.white = img.white;
    params.wb_r = img.wb_r;
    params.wb_b = img.wb_b;
    params.color_matrix = match matrix {
        Some(m) => pipeline::ColorMatrix::Camera(m),
        None => img.color_matrix.into(),
    };
    let gains = demosaic::MhcGains::from_wb(params.wb_r, params.wb_g, params.wb_b);
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

    for (model, cam_xyz) in CAM_XYZ {
        let (cam_rgb, rgb_cam) = derive_rgb_cam(*cam_xyz);
        println!("{model}");
        println!("  cam_rgb (camera-from-sRGB, row-normalised — the all-positive shape):");
        for r in &cam_rgb {
            println!("    {:8.4} {:8.4} {:8.4}", r[0], r[1], r[2]);
        }
        println!("  rgb_cam (camera->sRGB, dcraw-derived = inverse of the above):");
        for r in &rgb_cam {
            println!("    {:8.4} {:8.4} {:8.4}", r[0], r[1], r[2]);
        }
    }
    if let Some(f) = files.first() {
        if let Ok(d) = fs::read(f) {
            if let Ok(img) = cr2::decode_bytes(&d) {
                let m: pipeline::ColorMatrix = img.color_matrix.into();
                println!("ours (the one generic fallback every Canon body gets today):");
                for r in m.as_matrix() {
                    println!("    {:8.4} {:8.4} {:8.4}", r[0], r[1], r[2]);
                }
            }
        }
    }

    println!(
        "\n{:<16} {:>17} {:>17} {:>17}   {}",
        "file", "camera JPEG", "ours (today)", "dcraw rgb_cam", "closer"
    );
    let (mut n, mut wins_ours, mut wins_derived, mut sum_ours, mut sum_derived) = (0, 0, 0, 0.0, 0.0);

    for f in &files {
        let Ok(data) = fs::read(f) else { continue };
        let name: String = f.file_name().unwrap().to_string_lossy().chars().take(16).collect();
        let Some(range) = tiff::find_embedded_jpeg_range(&data) else { continue };
        let Ok(emb) = image_formats::decode_jpeg_bytes(&data[range]) else { continue };
        let (ew, eh) = (emb.width as usize, emb.height as usize);
        let mut ergb = vec![0u8; ew * eh * 3];
        for i in 0..ew * eh {
            ergb[i * 3] = emb.u8[i * 4];
            ergb[i * 3 + 1] = emb.u8[i * 4 + 1];
            ergb[i * 3 + 2] = emb.u8[i * 4 + 2];
        }
        let (erg, ebg) = ratios(&ergb);

        // Per-body coefficients, so the 550D is tested against its own matrix rather than
        // the M5's — otherwise the comparison would be measuring the wrong thing.
        let model = cr2::decode_bytes(&data).map(|i| i.model.clone()).unwrap_or_default();
        let Some(cam_xyz) = cam_xyz_for(&model) else {
            println!("{name:<16} (no cam_xyz for model {model:?} — skipped)");
            continue;
        };
        let (_, rgb_cam) = derive_rgb_cam(cam_xyz);

        let Some((w, h, a)) = render(&data, None) else { continue };
        let Some((_, _, b)) = render(&data, Some(to_f32(rgb_cam))) else { continue };
        let (arg, abg) = ratios(&resize_to(&a, w, h, ew as u32, eh as u32));
        let (brg, bbg) = ratios(&resize_to(&b, w, h, ew as u32, eh as u32));

        // Same distance the browser harness uses: |dR/G| + |dB/G| against the camera.
        let da = (arg - erg).abs() + (abg - ebg).abs();
        let db = (brg - erg).abs() + (bbg - ebg).abs();
        let closer = if db < da { wins_derived += 1; "dcraw rgb_cam" } else { wins_ours += 1; "ours" };
        n += 1;
        sum_ours += da;
        sum_derived += db;
        println!(
            "{name:<16} {:>8.3}{:>9.3} {:>8.3}{:>9.3} {:>8.3}{:>9.3}   {closer} (d {:.3} vs {:.3})",
            erg, ebg, arg, abg, brg, bbg, da, db
        );
    }

    if n > 0 {
        println!("\n{n} files: ours closer on {wins_ours}, dcraw rgb_cam closer on {wins_derived}");
        println!(
            "  mean distance to camera JPEG:  ours {:.3}   dcraw rgb_cam {:.3}",
            sum_ours / n as f64,
            sum_derived / n as f64
        );
    }
}
