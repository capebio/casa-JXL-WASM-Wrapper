//! Highlight-rolloff tuning harness. Measures luma + %clipped(>=250) per format
//! so HIGHLIGHT_KNEE can be tuned to cut bright-scene blow-out (DNG) WITHOUT
//! regressing ORF (constraint: ORF must stay ~unchanged). Removed before commit.
//!   cargo test --no-default-features --features parallel --test highlight_tune -- --nocapture
use raw_pipeline::pipeline::{self, PipelineParams};
use std::path::Path;

fn stats_rgb8(px: &[u8], ch: usize) -> (f64, f64) {
    let n = px.len() / ch;
    let step = (n / 60_000).max(1);
    let (mut lum, mut clip, mut c) = (0f64, 0f64, 0f64);
    let mut i = 0;
    while i < n {
        let (r, g, b) = (px[i * ch] as f64, px[i * ch + 1] as f64, px[i * ch + 2] as f64);
        lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if r >= 250.0 && g >= 250.0 && b >= 250.0 { clip += 1.0; }
        c += 1.0; i += step;
    }
    (lum / c, 100.0 * clip / c) // (mean luma, % near-white pixels)
}

#[test]
fn highlight_metrics() {
    let dir = std::env::var("RAW_CAL_DIR").unwrap_or_else(|_| r"C:\Foo\raw-converter\tests".into());
    let dir = Path::new(&dir);
    if !dir.is_dir() { eprintln!("SKIP"); return; }
    println!("\n===== HIGHLIGHT metrics (HIGHLIGHT_KNEE tune) =====");
    println!("{:<40} {:>4} {:>8} {:>8}", "file", "fmt", "luma", "%clip");
    let mut files: Vec<_> = std::fs::read_dir(dir).unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|s| s.to_str())
            .map(|s| { let s = s.to_ascii_lowercase(); s == "cr2" || s == "dng" || s == "orf" }).unwrap_or(false))
        .collect();
    files.sort();
    for path in &files {
        let name = path.file_name().unwrap().to_string_lossy();
        let ext = path.extension().unwrap().to_string_lossy().to_ascii_lowercase();
        let data = std::fs::read(path).unwrap();
        let (luma, clip) = if ext == "orf" {
            match raw_pipeline::tiff::decode_orf_rgba8(&data) {
                Ok((px, _, _)) => stats_rgb8(&px, 4),
                Err(_) => continue,
            }
        } else {
            let (raw, w, h, phase, black, white, wr, wg, wb, cm) = if ext == "cr2" {
                let c = match raw_pipeline::cr2::decode_bytes(&data) { Ok(c) => c, Err(_) => continue };
                (c.raw, c.width, c.height, c.cfa_phase, c.black, c.white, c.wb_r, c.wb_g, c.wb_b, c.color_matrix)
            } else {
                let d = match raw_pipeline::dng::decode_bytes(&data) { Ok(d) => d, Err(_) => continue };
                let ph = match d.cfa {
                    raw_pipeline::dng::Cfa::Rggb => (0, 0), raw_pipeline::dng::Cfa::Grbg => (0, 1),
                    raw_pipeline::dng::Cfa::Gbrg => (1, 0), raw_pipeline::dng::Cfa::Bggr => (1, 1),
                };
                (d.raw, d.width, d.height, ph, d.black, d.white, d.wb_r, d.wb_g, d.wb_b, d.color_matrix)
            };
            let rgb16 = match raw_pipeline::demosaic::demosaic_bayer_mhc(&raw, w, h, phase) { Ok(v) => v, Err(_) => continue };
            let mut p = PipelineParams::default_olympus();
            p.black = black; p.white = white; p.wb_r = wr; p.wb_g = wg; p.wb_b = wb;
            p.color_matrix = cm.into();
            stats_rgb8(&pipeline::process(&rgb16, &p), 3)
        };
        println!("{:<40} {:>4} {:>8.0} {:>8.2}", name, ext, luma, clip);
    }
    println!("(goal: cut %clip on the bright DNGs; ORF luma/%clip must stay ~unchanged)\n");
}
