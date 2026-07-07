//! RAW render CALIBRATION harness.
//!
//! Each RAW file carries its own ground-truth: the embedded preview JPEG (the
//! camera's / Google-HDR+'s own finished render). This measures OUR pipeline's
//! final render against that reference — per file and aggregated per format — so
//! the exposure and colour divergence are detected automatically instead of
//! eyeballed, and the right per-format correction falls out of the numbers.
//!
//! Run (defaults to C:\Foo\raw-converter\tests; override with RAW_CAL_DIR):
//!   cargo test --no-default-features --features parallel --test calibration -- --nocapture
//!
//! Reports, for each RAW: reference vs our mean luma + R/G,B/G, the exposure_ev
//! that best matches the reference brightness, and the residual colour cast. Then
//! the per-format median EV correction + colour cast → the calibration to apply.

use raw_pipeline::pipeline::{self, PipelineParams};
use std::path::Path;

// ── reference extraction ────────────────────────────────────────────────────

/// Largest strip-based JPEG preview in a TIFF/DNG (skips the tiled raw), decoded.
fn tiff_preview(data: &[u8]) -> Option<image::RgbImage> {
    if data.len() < 16 {
        return None;
    }
    let le = data[0] == 0x49 && data[1] == 0x49;
    let be = data[0] == 0x4D && data[1] == 0x4D;
    if !le && !be {
        return None;
    }
    let u16a = |o: usize| -> u32 {
        if o + 2 > data.len() { return 0; }
        if le { data[o] as u32 | (data[o + 1] as u32) << 8 } else { (data[o] as u32) << 8 | data[o + 1] as u32 }
    };
    let u32a = |o: usize| -> u32 {
        if o + 4 > data.len() { return 0; }
        if le {
            data[o] as u32 | (data[o + 1] as u32) << 8 | (data[o + 2] as u32) << 16 | (data[o + 3] as u32) << 24
        } else {
            (data[o] as u32) << 24 | (data[o + 1] as u32) << 16 | (data[o + 2] as u32) << 8 | data[o + 3] as u32
        }
    };
    let type_sz = |t: u32| -> u32 { match t { 1 | 2 | 7 => 1, 3 => 2, 4 | 9 | 11 => 4, 5 | 10 | 12 => 8, _ => 1 } };
    let first = |off: usize| -> u32 {
        let t = u16a(off + 2);
        let c = u32a(off + 4);
        let vo = if type_sz(t) * c <= 4 { off + 8 } else { u32a(off + 8) as usize };
        if t == 3 { u16a(vo) } else { u32a(vo) }
    };
    let mut best: Option<(u32, u32, u32)> = None; // (pixels, offset, len)
    let mut seen = std::collections::HashSet::new();
    let mut stack = vec![u32a(4)];
    while let Some(ifd) = stack.pop() {
        let ifd = ifd as usize;
        if ifd == 0 || ifd + 2 > data.len() || !seen.insert(ifd) {
            continue;
        }
        let n = u16a(ifd) as usize;
        if ifd + 2 + n * 12 > data.len() {
            continue;
        }
        let (mut w, mut h, mut comp, mut so, mut sl, mut tiled) = (0u32, 0u32, 0u32, 0u32, 0u32, false);
        for e in 0..n {
            let off = ifd + 2 + e * 12;
            match u16a(off) {
                0x100 => w = first(off),
                0x101 => h = first(off),
                0x103 => comp = first(off),
                0x111 => so = first(off),
                0x117 => sl = first(off),
                0x144 => tiled = true,
                0x14A => {
                    let t = u16a(off + 2);
                    let c = u32a(off + 4);
                    let base = if type_sz(t) * c <= 4 { off + 8 } else { u32a(off + 8) as usize };
                    for s in 0..c as usize {
                        stack.push(u32a(base + s * 4));
                    }
                }
                _ => {}
            }
        }
        stack.push(u32a(ifd + 2 + n * 12)); // next IFD
        if (comp == 6 || comp == 7) && !tiled && so > 0 && sl > 0 && w > 0 && h > 0 {
            let px = w * h;
            if best.map_or(true, |(bp, _, _)| px > bp) {
                best = Some((px, so, sl));
            }
        }
    }
    let (_, off, len) = best?;
    let end = (off as usize + len as usize).min(data.len());
    image::load_from_memory(data.get(off as usize..end)?).ok().map(|i| i.to_rgb8())
}

/// Largest decodable baseline JPEG found by SOI/EOI scan (CR2/ORF).
fn scan_preview(data: &[u8]) -> Option<image::RgbImage> {
    let mut sois = vec![];
    let mut i = 0;
    while i + 2 < data.len() {
        if data[i] == 0xFF && data[i + 1] == 0xD8 && data[i + 2] == 0xFF {
            sois.push(i);
            i += 2;
        }
        i += 1;
    }
    let mut best: Option<image::RgbImage> = None;
    for (n, &s) in sois.iter().enumerate() {
        let e = if n + 1 < sois.len() { sois[n + 1] } else { data.len() };
        if e - s < 40_000 {
            continue; // skip tiny thumbnails
        }
        if let Ok(img) = image::load_from_memory(&data[s..e]) {
            let rgb = img.to_rgb8();
            if best.as_ref().map_or(true, |b| (rgb.width() * rgb.height()) > (b.width() * b.height())) {
                best = Some(rgb);
            }
        }
    }
    best
}

fn img_stats(img: &image::RgbImage) -> (f64, f64, f64) {
    let (mut r, mut g, mut b, mut c) = (0f64, 0f64, 0f64, 0f64);
    let step = ((img.width() * img.height()) / 40_000).max(1);
    for (i, p) in img.pixels().enumerate() {
        if i as u32 % step != 0 { continue; }
        r += p[0] as f64; g += p[1] as f64; b += p[2] as f64; c += 1.0;
    }
    (r / c, g / c, b / c)
}

fn rgb8_stats(rgb8: &[u8]) -> (f64, f64, f64) {
    let n = rgb8.len() / 3;
    let step = (n / 40_000).max(1);
    let (mut r, mut g, mut b, mut c) = (0f64, 0f64, 0f64, 0f64);
    let mut i = 0;
    while i < n {
        r += rgb8[i * 3] as f64; g += rgb8[i * 3 + 1] as f64; b += rgb8[i * 3 + 2] as f64; c += 1.0;
        i += step;
    }
    (r / c, g / c, b / c)
}

fn luma((r, g, b): (f64, f64, f64)) -> f64 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

// ── our render per format ───────────────────────────────────────────────────

fn our_render(data: &[u8], ext: &str, ev: f32) -> Option<Vec<u8>> {
    let (raw, w, h, phase, black, white, wb_r, wb_g, wb_b, cm) = match ext {
        "cr2" => {
            let c = raw_pipeline::cr2::decode_bytes(data).ok()?;
            (c.raw, c.width, c.height, c.cfa_phase, c.black, c.white, c.wb_r, c.wb_g, c.wb_b, c.color_matrix)
        }
        "dng" => {
            let d = raw_pipeline::dng::decode_bytes(data).ok()?;
            let ph = match d.cfa {
                raw_pipeline::dng::Cfa::Rggb => (0, 0),
                raw_pipeline::dng::Cfa::Grbg => (0, 1),
                raw_pipeline::dng::Cfa::Gbrg => (1, 0),
                raw_pipeline::dng::Cfa::Bggr => (1, 1),
            };
            (d.raw, d.width, d.height, ph, d.black, d.white, d.wb_r, d.wb_g, d.wb_b, d.color_matrix)
        }
        _ => return None,
    };
    let rgb16 = raw_pipeline::demosaic::demosaic_bayer_mhc(&raw, w, h, phase).ok()?;
    let mut p = PipelineParams::default_olympus();
    p.black = black; p.white = white; p.wb_r = wb_r; p.wb_g = wb_g; p.wb_b = wb_b;
    p.color_matrix = cm.into();
    p.exposure_ev = ev;
    Some(pipeline::process(&rgb16, &p))
}

// ── harness ─────────────────────────────────────────────────────────────────

#[test]
fn calibrate_exposure_and_colour() {
    let dir = std::env::var("RAW_CAL_DIR").unwrap_or_else(|_| r"C:\Foo\raw-converter\tests".into());
    let dir = Path::new(&dir);
    if !dir.is_dir() {
        eprintln!("SKIP: {dir:?} not present (set RAW_CAL_DIR)");
        return;
    }
    let mut files: Vec<_> = std::fs::read_dir(dir).unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|s| s.to_str())
            .map(|s| { let s = s.to_ascii_lowercase(); s == "cr2" || s == "dng" }).unwrap_or(false))
        .collect();
    files.sort();

    // exposure ladder (BASELINE_EXP_EV=1.40 is added on top of these).
    let evs = [0.5f32, 0.0, -0.5, -1.0, -1.5, -2.0];
    // per-format accumulators: (best_ev, our R/G ÷ ref R/G, our B/G ÷ ref B/G)
    let mut agg: std::collections::BTreeMap<String, Vec<(f32, f64, f64)>> = Default::default();

    println!("\n===== RAW CALIBRATION (our render vs embedded reference) =====");
    println!("{:<40} {:>4} {:>7} {:>7} {:>7} {:>18} {:>18}", "file", "fmt", "refLum", "ourLum0", "bestEV", "R/G our|ref", "B/G our|ref");
    for path in &files {
        let name = path.file_name().unwrap().to_string_lossy();
        let ext = path.extension().unwrap().to_string_lossy().to_ascii_lowercase();
        let data = match std::fs::read(path) { Ok(d) => d, Err(_) => continue };
        let refimg = if ext == "dng" { tiff_preview(&data) } else { scan_preview(&data) };
        let Some(refimg) = refimg else { println!("{name:<40} {ext:>4}  (no reference preview)"); continue };
        let refm = img_stats(&refimg);
        let ref_lum = luma(refm);
        let (ref_rg, ref_bg) = (refm.0 / refm.1, refm.2 / refm.1);

        // render across the ladder; pick the ev whose luma is closest to the reference.
        let mut best = (f32::NAN, f64::INFINITY, (0.0, 0.0, 0.0));
        let mut lum0 = 0.0;
        for &ev in &evs {
            let Some(rgb8) = our_render(&data, &ext, ev) else { continue };
            let m = rgb8_stats(&rgb8);
            let l = luma(m);
            if ev == 0.0 { lum0 = l; }
            let d = (l - ref_lum).abs();
            if d < best.1 { best = (ev, d, m); }
        }
        if best.0.is_nan() { println!("{name:<40} {ext:>4}  (decode failed)"); continue; }
        let (our_rg, our_bg) = (best.2 .0 / best.2 .1, best.2 .2 / best.2 .1);
        println!("{:<40} {:>4} {:>7.0} {:>7.0} {:>+7.1} {:>8.3}|{:<8.3} {:>8.3}|{:<8.3}",
            name, ext, ref_lum, lum0, best.0, our_rg, ref_rg, our_bg, ref_bg);
        agg.entry(ext).or_default().push((best.0, our_rg / ref_rg, our_bg / ref_bg));
    }

    println!("\n----- PER-FORMAT CALIBRATION (median) -----");
    for (fmt, v) in &agg {
        let med = |mut xs: Vec<f64>| { xs.sort_by(|a, b| a.partial_cmp(b).unwrap()); xs[xs.len() / 2] };
        let ev = med(v.iter().map(|x| x.0 as f64).collect());
        let rg = med(v.iter().map(|x| x.1).collect());
        let bg = med(v.iter().map(|x| x.2).collect());
        println!("{fmt}: n={} | exposure_ev correction ~{ev:+.1} (add to decode) | residual cast R/G ×{rg:.3} B/G ×{bg:.3} vs reference", v.len());
    }
    println!("(exposure_ev correction is what to apply per format on top of BASELINE_EXP_EV; residual cast ≠1.0 → matrix/WB work)\n");
}
