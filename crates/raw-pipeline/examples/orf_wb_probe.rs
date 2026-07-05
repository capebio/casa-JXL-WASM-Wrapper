// Probe: what WB does each strategy give for an ORF?
//   - camera 0x0100 fixed calibration (info.wb_r/wb_b)
//   - gray-world (auto_wb_rggb) — the proposed fallback
//   - wb_mode (discriminator: user-defined modes => 0x0100 is fixed calibration)
// Usage: cargo run --example orf_wb_probe --no-default-features -- "<path.orf>"
use raw_pipeline::{decompress, pipeline, tiff};

fn main() -> anyhow::Result<()> {
    let path = std::env::args()
        .nth(1)
        .expect("usage: orf_wb_probe <file.orf>");
    let data = std::fs::read(&path)?;
    let info = tiff::parse(&data).map_err(|e| anyhow::anyhow!("{e}"))?;
    let w = info.width as usize;
    let h = info.height as usize;
    let strip_end = info.strip_offset as usize + info.strip_byte_count as usize;
    let strip = &data[info.strip_offset as usize..strip_end];
    let raw = decompress::decompress(strip, w, h).map_err(|e| anyhow::anyhow!("{e}"))?;

    let black = pipeline::PipelineParams::default_olympus().black;
    let (gw_r, gw_b) = pipeline::auto_wb_rggb(&raw, w, h, black);

    println!("file        {}", path);
    println!("model       {} {}", info.make, info.model);
    println!("dims        {}x{}  black={}", w, h, black);
    println!("wb_mode     {:?}", info.wb_mode);
    println!(
        "camera WB   r={:?} b={:?}  (0x0100 / MakerNote)",
        info.wb_r, info.wb_b
    );
    println!("gray-world  r={:.4} b={:.4}  (auto_wb_rggb)", gw_r, gw_b);
    println!(
        "matrix      {}",
        if info.color_matrix.is_some() {
            "present (MakerNote)"
        } else {
            "None (CAM_TO_SRGB)"
        }
    );
    Ok(())
}
