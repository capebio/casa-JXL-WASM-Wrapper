//! green_probe — stage-by-stage dump for the green-sparkle / highlight investigation.
//!
//! Mirrors the app's default ORF still render (`decode_orf_raw` + `finish_from_raw`
//! with no look overrides: black=256, camera WB, camera 0x1011 matrix if present,
//! `demosaic_rggb_mhc_gains`, `process_into` default look) and dumps every stage:
//!
//!   <stem>.mosaic      [u32 w][u32 h][w*h u16 LE]     raw sensor mosaic
//!   <stem>.lin16       [u32 w][u32 h][w*h*3 u16 LE]   demosaic output (pre-tone)
//!   <stem>-render.png  full-res 8-bit default render (no orientation)
//!   <stem>-meta.txt    wb / matrix / per-CFA-class raw histogram tail
//!
//! Run: cargo run --release --no-default-features --features parallel \
//!        --manifest-path crates/raw-pipeline/Cargo.toml --example green_probe -- <orf> <out_dir>

use raw_pipeline::{
    decompress, demosaic,
    pipeline::{self, PipelineParams},
    tiff,
};
use std::fmt::Write as _;
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let orf = args.get(1).expect("arg1: orf path");
    let out_dir = args.get(2).map(String::as_str).unwrap_or("green-probe-out");
    let out_dir = Path::new(out_dir);
    std::fs::create_dir_all(out_dir)?;

    let data = std::fs::read(orf)?;
    let info = tiff::parse(&data).map_err(|e| anyhow::anyhow!("{e}"))?;
    let (w, h) = (info.width as usize, info.height as usize);
    let strip = &data
        [info.strip_offset as usize..(info.strip_offset as usize + info.strip_byte_count as usize)];
    let mosaic = decompress::decompress(strip, w, h).map_err(|e| anyhow::anyhow!("{e}"))?;

    // Params exactly as the app's ORF default path sets them.
    let mut params = PipelineParams::default_olympus();
    params.black = 256;
    params.baseline_ev = pipeline::orf_baseline_ev(info.iso);
    if let Some(r) = info.wb_r {
        params.wb_r = r;
    }
    if let Some(b) = info.wb_b {
        params.wb_b = b;
    }
    if let Some(m) = info.color_matrix {
        params.color_matrix = Some(m).into();
    }

    let mut rgb16 = demosaic::demosaic_rggb_mhc_gains(
        &mosaic,
        w,
        h,
        demosaic::MhcGains::from_wb(params.wb_r, params.wb_g, params.wb_b),
    )
    .map_err(|e| anyhow::anyhow!("{e}"))?;

    // Mirror the app's base-ISO chroma-only NR (finish_from_raw, iso < 1600).
    if info.iso.unwrap_or(0) < 1600 {
        pipeline::apply_chroma_nr(&mut rgb16, w, h, pipeline::ORF_BASE_ISO_CHROMA_NR);
    }

    let mut rgb8 = vec![0u8; w * h * 3];
    pipeline::process_into(&rgb16, &params, &mut rgb8);

    let stem = Path::new(orf)
        .file_stem()
        .unwrap()
        .to_string_lossy()
        .replace(' ', "_");

    let write16 = |name: &str, vals: &[u16]| -> anyhow::Result<()> {
        let mut out = Vec::with_capacity(8 + vals.len() * 2);
        out.extend_from_slice(&(w as u32).to_le_bytes());
        out.extend_from_slice(&(h as u32).to_le_bytes());
        for &v in vals {
            out.extend_from_slice(&v.to_le_bytes());
        }
        std::fs::write(out_dir.join(name), out)?;
        Ok(())
    };
    write16(&format!("{stem}.mosaic"), &mosaic)?;
    write16(&format!("{stem}.lin16"), &rgb16)?;

    image::RgbImage::from_raw(w as u32, h as u32, rgb8)
        .expect("rgb8 buffer size")
        .save(out_dir.join(format!("{stem}-render.png")))?;

    // Per-CFA-class raw histogram tails: reveals the true per-channel saturation point.
    let mut hist = [[0u32; 4096]; 4]; // R, G1, G2, B (RGGB)
    for y in 0..h {
        for x in 0..w {
            let class = (y & 1) * 2 + (x & 1);
            let v = (mosaic[y * w + x] as usize).min(4095);
            hist[class][v] += 1;
        }
    }
    let names = ["R ", "G1", "G2", "B "];
    let mut meta = String::new();
    writeln!(
        meta,
        "file={orf}\nw={w} h={h}\nblack={} white={} wb_r={:.4} wb_g={:.4} wb_b={:.4} matrix_from_mn={} iso={:?} baseline_ev={:.2}",
        params.black,
        params.white,
        params.wb_r,
        params.wb_g,
        params.wb_b,
        info.color_matrix.is_some(),
        info.iso,
        params.baseline_ev
    )?;
    let m = params.color_matrix.matrix();
    for row in m.iter() {
        writeln!(meta, "matrix {:+.4} {:+.4} {:+.4}", row[0], row[1], row[2])?;
    }
    for (c, name) in hist.iter().zip(names) {
        let total: u64 = c.iter().map(|&n| n as u64).sum();
        let max = c.iter().rposition(|&n| n > 0).unwrap_or(0);
        // top 8 distinct populated values
        let mut tail = String::new();
        let mut shown = 0;
        for v in (0..=max).rev() {
            if c[v] > 0 {
                write!(tail, " {v}:{}", c[v])?;
                shown += 1;
                if shown == 8 {
                    break;
                }
            }
        }
        // cumulative count in the top 1% of the range below max (near-saturation mass)
        let near_lo = max.saturating_sub(40);
        let near: u64 = (near_lo..=max).map(|v| c[v] as u64).sum();
        writeln!(
            meta,
            "class {name} max={max} near[{near_lo}..{max}]={near} ({:.4}%) tail:{tail}",
            near as f64 / total as f64 * 100.0
        )?;
    }
    std::fs::write(out_dir.join(format!("{stem}-meta.txt")), &meta)?;
    print!("{meta}");
    Ok(())
}
