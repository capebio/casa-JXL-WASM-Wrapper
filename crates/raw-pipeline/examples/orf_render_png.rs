// Native ORF → PNG render with tunable black / exposure / contrast / saturation / WB.
// Visual tuning tool — preview pipeline changes without rebuilding the WASM pkg.
// Run: cargo run --example orf_render_png --no-default-features -- \
//        "<path.orf>" --black 256 --exp 0 --contrast 0 --sat 0 --out preview.png
use raw_pipeline::{
    decompress, demosaic,
    pipeline::{self, PipelineParams},
    tiff,
};

fn arg_f(args: &[String], flag: &str, def: f32) -> f32 {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(def)
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let path = args
        .get(1)
        .cloned()
        .unwrap_or("C:/Foo/raw-converter/tests/P1110226.ORF".into());
    let black = arg_f(&args, "--black", 256.0) as u16;
    let exp = arg_f(&args, "--exp", 0.0);
    let contrast = arg_f(&args, "--contrast", 0.0);
    let sat = arg_f(&args, "--sat", 0.0);
    let out = args
        .iter()
        .position(|a| a == "--out")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or("docs/outputs/ChatGPT plus Claude Outputs/Done Deal/orf-render.png".into());

    let data = std::fs::read(&path)?;
    let info = tiff::parse(&data).map_err(|e| anyhow::anyhow!("{e}"))?;
    let w = info.width as usize;
    let h = info.height as usize;
    let strip_end = info.strip_offset as usize + info.strip_byte_count as usize;
    let strip = &data[info.strip_offset as usize..strip_end];
    let raw = decompress::decompress(strip, w, h).map_err(|e| anyhow::anyhow!("{e}"))?;
    let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).map_err(|e| anyhow::anyhow!("{e}"))?;

    let mut p = PipelineParams::default_olympus();
    p.black = black;
    p.wb_r = info.wb_r.unwrap_or(1.797);
    p.wb_g = 1.0;
    p.wb_b = info.wb_b.unwrap_or(1.797);
    p.color_matrix = info.color_matrix;
    p.exposure_ev = exp;
    p.contrast = contrast;
    p.saturation = sat;

    let mut rgb8 = vec![0u8; w * h * 3];
    pipeline::process_into(&rgb16, &p, &mut rgb8);

    // Downscale (nearest) to ~1024 wide for a quick viewable preview.
    let target_w = 1024usize.min(w);
    let scale = w as f32 / target_w as f32;
    let target_h = (h as f32 / scale) as usize;
    let mut small = image::RgbImage::new(target_w as u32, target_h as u32);
    for ty in 0..target_h {
        let sy = (ty as f32 * scale) as usize;
        for tx in 0..target_w {
            let sx = (tx as f32 * scale) as usize;
            let si = (sy * w + sx) * 3;
            small.put_pixel(
                tx as u32,
                ty as u32,
                image::Rgb([rgb8[si], rgb8[si + 1], rgb8[si + 2]]),
            );
        }
    }
    small.save(&out)?;
    println!(
        "wrote {out}  (black={black} exp={exp} contrast={contrast} sat={sat} wb={}/{})",
        p.wb_r, p.wb_b
    );
    Ok(())
}
