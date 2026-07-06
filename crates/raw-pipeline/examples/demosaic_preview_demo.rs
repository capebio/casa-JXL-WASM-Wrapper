//! VISUAL + PERCEPTUAL demonstration of the P2 preview decision.
//!
//! Two ways to build the ORF *preview* (lightbox), differing ONLY in the demosaic:
//!   FULL : demosaic_rggb        (full-res bilinear, the SHIPPED preview path)  → downscale
//!   HALF : demosaic_rggb_half   (2x2 superpixel, ¼ res, PROPOSED P2)           → downscale
//! Both then share the SAME box downscale and the SAME tone pipeline (process_rgba),
//! so every pixel difference you see is attributable to the demosaic alone.
//!
//! Emits, under docs/outputs/demosaic-preview-demo/ :
//!   full.png        – preview built the current way
//!   half.png        – preview built the proposed way
//!   diff_x8.png     – |full-half| per channel, amplified 8x (shows WHERE they differ)
//!   crop_montage.png – 100% center crop:  [ FULL | HALF | DIFF x8 ]  side by side
//! and prints Butteraugli (house perceptual distance), PSNR, max/mean abs diff, timing.
//!
//! Run (real Olympus ORF, best):
//!   cargo run -p raw-pipeline --release --no-default-features --example demosaic_preview_demo -- "C:\\995\\...\\P2200407.ORF"
//! Run (auto-find a known ORF, else synthetic high-detail target):
//!   cargo run -p raw-pipeline --release --no-default-features --example demosaic_preview_demo

use std::path::{Path, PathBuf};
use std::time::Instant;

use raw_pipeline::perceptual::{Comparer, Opts};
use raw_pipeline::pipeline::PipelineParams;
use raw_pipeline::{decompress, demosaic, pipeline, tiff};

const OLYMPUS_BLACK_LEVEL: u16 = 256;

/// Even-rounded longest-edge scale (mirrors src/lib.rs target_dims).
fn target_dims(w: usize, h: usize, longest: usize) -> (usize, usize) {
    if w >= h {
        let dw = longest.min(w);
        let dh = ((dw * h) / w).max(1);
        (dw & !1, dh & !1)
    } else {
        let dh = longest.min(h);
        let dw = ((dh * w) / h).max(1);
        (dw & !1, dh & !1)
    }
}

/// Area-average box downscale of an INTERLEAVED rgb16 buffer. Identical kernel for
/// both arms, so it is neutral to the comparison. Handles non-integer ratios via
/// per-dst source-rectangle averaging.
fn box_down_rgb16(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u16> {
    let mut out = vec![0u16; dw * dh * 3];
    for dy in 0..dh {
        let y0 = dy * sh / dh;
        let y1 = (((dy + 1) * sh) / dh).max(y0 + 1).min(sh);
        for dx in 0..dw {
            let x0 = dx * sw / dw;
            let x1 = (((dx + 1) * sw) / dw).max(x0 + 1).min(sw);
            let (mut r, mut g, mut b, mut n) = (0u64, 0u64, 0u64, 0u64);
            for sy in y0..y1 {
                let row = sy * sw;
                for sx in x0..x1 {
                    let o = (row + sx) * 3;
                    r += src[o] as u64;
                    g += src[o + 1] as u64;
                    b += src[o + 2] as u64;
                    n += 1;
                }
            }
            let o = (dy * dw + dx) * 3;
            out[o] = (r / n) as u16;
            out[o + 1] = (g / n) as u16;
            out[o + 2] = (b / n) as u16;
        }
    }
    out
}

/// Try CLI arg, then a few known Olympus locations.
fn find_orf() -> Option<PathBuf> {
    if let Some(a) = std::env::args().nth(1) {
        let p = PathBuf::from(a);
        if p.exists() {
            return Some(p);
        }
    }
    let candidates = [
        r"C:\995\2026-02-20 Gobabeb To Windhoek\Gobabeb Herbarium\P2200407.ORF",
        r"C:\995\2026-01-09 Birthday at Cederberg\P1100079.ORF",
    ];
    candidates.iter().map(PathBuf::from).find(|p| p.exists())
}

/// Decode a real ORF the way src/lib.rs::process_orf does: parse → decompress →
/// Olympus params (black pedestal, camera WB, MakerNote colour matrix).
fn load_orf(path: &Path) -> Result<(Vec<u16>, usize, usize, PipelineParams), String> {
    let data = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let info = tiff::parse(&data).map_err(|e| format!("tiff::parse: {e}"))?;
    if info.compression != 1 {
        return Err(format!(
            "compression {} unsupported (want Olympus 12-bit)",
            info.compression
        ));
    }
    let (w, h) = (info.width as usize, info.height as usize);
    let s = info.strip_offset as usize;
    let e = s + info.strip_byte_count as usize;
    if e > data.len() {
        return Err("strip out of bounds".into());
    }
    let raw = decompress::decompress(&data[s..e], w, h).map_err(|e| format!("decompress: {e}"))?;

    let mut params = PipelineParams::default_olympus();
    params.black = OLYMPUS_BLACK_LEVEL;
    if let (Some(r), Some(b)) = (info.wb_r, info.wb_b) {
        params.wb_r = r;
        params.wb_b = b;
    } else {
        let (ar, ab) = pipeline::auto_wb_rggb(&raw, w, h, params.black);
        params.wb_r = ar;
        params.wb_b = ab;
    }
    if let Some(m) = info.color_matrix {
        params.color_matrix = Some(m);
    }
    println!(
        "loaded REAL ORF {}  {}x{} ({:.1} MP)  wb=({:.3},{:.3})",
        path.display(),
        w,
        h,
        (w * h) as f64 / 1e6,
        params.wb_r,
        params.wb_b
    );
    Ok((raw, w, h, params))
}

/// Synthetic fallback: a high-frequency colour target mosaiced to RGGB, so the
/// superpixel-vs-bilinear difference is visible even with no camera on hand.
fn synth() -> (Vec<u16>, usize, usize, PipelineParams) {
    let (w, h) = (1536usize, 1024usize);
    let mut raw = vec![0u16; w * h];
    for y in 0..h {
        for x in 0..w {
            // radial chirp (rings get finer outward) + diagonal hairlines + colour bands
            let fx = x as f32 - w as f32 / 2.0;
            let fy = y as f32 - h as f32 / 2.0;
            let r2 = (fx * fx + fy * fy) / (w as f32 * 0.10);
            let chirp = 0.5 + 0.5 * (r2).sin();
            let hair = if (x + y) % 7 == 0 { 1.0 } else { 0.0 };
            let v = (chirp.max(hair) * 3600.0 + 200.0).min(4095.0);
            // colour: R rises L→R, B rises top→bottom, G mid — exercises chroma reconstruct
            let rscale = x as f32 / w as f32;
            let bscale = y as f32 / h as f32;
            let (rr, gg, bb) = (v * (0.4 + 0.6 * rscale), v * 0.7, v * (0.4 + 0.6 * bscale));
            let sample = match (y & 1, x & 1) {
                (0, 0) => rr,
                (1, 1) => bb,
                _ => gg,
            };
            raw[y * w + x] = sample.min(4095.0) as u16;
        }
    }
    let mut params = PipelineParams::default_olympus();
    params.black = 0;
    params.wb_r = 1.0;
    params.wb_b = 1.0;
    println!(
        "no ORF found — using SYNTHETIC high-detail target {}x{}",
        w, h
    );
    (raw, w, h, params)
}

fn abs_diff(a: &[u8], b: &[u8]) -> (u8, f64) {
    let mut maxd = 0u8;
    let mut sum = 0u64;
    let mut n = 0u64;
    // RGBA stride 4 — skip alpha
    for (i, (&x, &y)) in a.iter().zip(b).enumerate() {
        if i % 4 == 3 {
            continue;
        }
        let d = x.abs_diff(y);
        maxd = maxd.max(d);
        sum += d as u64;
        n += 1;
    }
    (maxd, sum as f64 / n as f64)
}

fn save_rgba_png(path: &Path, rgba: &[u8], w: usize, h: usize) {
    let img: image::RgbaImage =
        image::ImageBuffer::from_raw(w as u32, h as u32, rgba.to_vec()).expect("buffer fits");
    img.save(path)
        .unwrap_or_else(|e| eprintln!("save {}: {e}", path.display()));
}

/// |full-half| per channel, amplified, as an opaque RGB png.
fn save_diff_png(path: &Path, a: &[u8], b: &[u8], w: usize, h: usize, amp: u16) {
    let mut rgb = vec![0u8; w * h * 3];
    for p in 0..w * h {
        for c in 0..3 {
            let d = (a[p * 4 + c].abs_diff(b[p * 4 + c]) as u16 * amp).min(255) as u8;
            rgb[p * 3 + c] = d;
        }
    }
    let img: image::RgbImage =
        image::ImageBuffer::from_raw(w as u32, h as u32, rgb).expect("buffer fits");
    img.save(path)
        .unwrap_or_else(|e| eprintln!("save {}: {e}", path.display()));
}

/// 100% center-crop montage: [ FULL | HALF | DIFFx8 ], 1px white separators.
fn save_crop_montage(
    path: &Path,
    full: &[u8],
    half: &[u8],
    w: usize,
    h: usize,
    side: usize,
    amp: u16,
) {
    let side = side.min(w).min(h);
    let (cx, cy) = ((w - side) / 2, (h - side) / 2);
    let sep = 2usize;
    let mw = side * 3 + sep * 2;
    let mut out = vec![255u8; mw * side * 3];
    for y in 0..side {
        for x in 0..side {
            let src = ((cy + y) * w + (cx + x)) * 4;
            let put = |out: &mut [u8], panel: usize, r: u8, g: u8, b: u8| {
                let dx = panel * (side + sep) + x;
                let o = (y * mw + dx) * 3;
                out[o] = r;
                out[o + 1] = g;
                out[o + 2] = b;
            };
            put(&mut out, 0, full[src], full[src + 1], full[src + 2]);
            put(&mut out, 1, half[src], half[src + 1], half[src + 2]);
            let d = |c: usize| (full[src + c].abs_diff(half[src + c]) as u16 * amp).min(255) as u8;
            put(&mut out, 2, d(0), d(1), d(2));
        }
    }
    let img: image::RgbImage =
        image::ImageBuffer::from_raw(mw as u32, side as u32, out).expect("buffer fits");
    img.save(path)
        .unwrap_or_else(|e| eprintln!("save {}: {e}", path.display()));
}

fn med(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let (raw, w, h, params) = match find_orf() {
        Some(p) => load_orf(&p).unwrap_or_else(|e| {
            eprintln!("ORF load failed ({e}); falling back to synthetic");
            synth()
        }),
        None => synth(),
    };

    // lightbox longest edge: 1800 for a real frame; for the small synthetic, a third
    // of the long edge so BOTH arms genuinely downscale (fair).
    let longest = if w >= 3000 { 1800 } else { (w.max(h) / 3) & !1 };
    let (dw, dh) = target_dims(w, h, longest);
    println!("preview target {}x{}", dw, dh);

    // ── FULL arm: full-res bilinear demosaic → downscale ──
    let reps = 5;
    let mut t_full = Vec::new();
    let mut full_rgb16 = Vec::new();
    for _ in 0..reps {
        let t = Instant::now();
        full_rgb16 = demosaic::demosaic_rggb(&raw, w, h).unwrap();
        t_full.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    let full_down = box_down_rgb16(&full_rgb16, w, h, dw, dh);
    let full_rgba = pipeline::process_rgba(&full_down, &params);

    // ── HALF arm: 2x2 superpixel demosaic → downscale ──
    let (hw, hh) = (w / 2, h / 2);
    let mut t_half = Vec::new();
    let mut half_rgb16 = Vec::new();
    for _ in 0..reps {
        let t = Instant::now();
        half_rgb16 = demosaic::demosaic_rggb_half(&raw, w, h).unwrap();
        t_half.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    let half_down = box_down_rgb16(&half_rgb16, hw, hh, dw, dh);
    let half_rgba = pipeline::process_rgba(&half_down, &params);

    // ── perceptual + numeric comparison (FULL is the reference) ──
    let mut cmp = Comparer::new(full_rgba.clone(), dw, dh, Opts::default());
    let butter = cmp.butteraugli(&half_rgba);
    let psnr = cmp.psnr(&half_rgba);
    let (maxd, meand) = abs_diff(&full_rgba, &half_rgba);

    // ── write artifacts ──
    let dir = PathBuf::from("docs/outputs/demosaic-preview-demo");
    std::fs::create_dir_all(&dir).ok();
    save_rgba_png(&dir.join("full.png"), &full_rgba, dw, dh);
    save_rgba_png(&dir.join("half.png"), &half_rgba, dw, dh);
    save_diff_png(&dir.join("diff_x8.png"), &full_rgba, &half_rgba, dw, dh, 8);
    save_crop_montage(
        &dir.join("crop_montage.png"),
        &full_rgba,
        &half_rgba,
        dw,
        dh,
        480,
        8,
    );

    let fm = med(&mut t_full);
    let hm = med(&mut t_half);
    println!("\n=== demosaic, full-res @ {}x{} ===", w, h);
    println!("  FULL bilinear   median {:7.2} ms", fm);
    println!(
        "  HALF superpixel median {:7.2} ms   → {:.2}x faster ({:+.0}% time)",
        hm,
        fm / hm,
        (hm - fm) / fm * 100.0
    );
    println!(
        "\n=== preview quality, HALF vs FULL @ {}x{} (FULL = reference) ===",
        dw, dh
    );
    println!(
        "  Butteraugli distance : {:.4}   (house perceptual; <~1.0 ≈ not visible side-by-side)",
        butter
    );
    println!(
        "  PSNR                 : {:.2} dB  (higher = closer; >40 dB ≈ visually equivalent)",
        psnr
    );
    println!("  max abs diff (8-bit) : {}", maxd);
    println!("  mean abs diff (8-bit): {:.3}", meand);
    println!("\nartifacts → {}", dir.display());
    println!("  full.png  half.png  diff_x8.png  crop_montage.png  (open crop_montage.png first)");
}
