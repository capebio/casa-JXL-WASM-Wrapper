// Real-ORF black-level sweep — decode P1110226 natively through the full pipeline
// at several black pedestals (camera WB + MakerNote matrix held fixed) and report
// the mean colour + magenta index. Tests the synthetic finding on a real file.
// Run: cargo run --example orf_black_sweep --no-default-features -- "<path.orf>"
use raw_pipeline::{
    decompress, demosaic,
    pipeline::{self, PipelineParams},
    tiff,
};

fn mean(out: &[u8]) -> (f32, f32, f32) {
    let n = (out.len() / 3) as f32;
    let (mut r, mut g, mut b) = (0f32, 0f32, 0f32);
    for px in out.chunks_exact(3) {
        r += px[0] as f32;
        g += px[1] as f32;
        b += px[2] as f32;
    }
    (r / n, g / n, b / n)
}

fn main() -> anyhow::Result<()> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or("C:/Foo/raw-converter/tests/P1110226.ORF".into());
    let data = std::fs::read(&path)?;
    let info = tiff::parse(&data).map_err(|e| anyhow::anyhow!("{e}"))?;
    let w = info.width as usize;
    let h = info.height as usize;
    let strip_end = info.strip_offset as usize + info.strip_byte_count as usize;
    let strip = &data[info.strip_offset as usize..strip_end];
    let raw = decompress::decompress(strip, w, h).map_err(|e| anyhow::anyhow!("{e}"))?;

    // Estimate the optical-black pedestal from the raw histogram: the lowest values
    // in the active area approach the sensor's black floor in real shadows.
    let mut sorted = raw.clone();
    sorted.sort_unstable();
    let p = |q: f64| sorted[((sorted.len() as f64 * q) as usize).min(sorted.len() - 1)];
    println!(
        "raw stats: min={} p0.01%={} p0.1%={} p1%={} median={} max={}",
        sorted[0],
        p(0.0001),
        p(0.001),
        p(0.01),
        p(0.5),
        sorted[sorted.len() - 1]
    );

    let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).map_err(|e| anyhow::anyhow!("{e}"))?;

    let wb_r = info.wb_r.unwrap_or(1.797);
    let wb_b = info.wb_b.unwrap_or(1.797);
    println!(
        "{} {}  {}x{}  camera WB {wb_r}/{wb_b}  matrix={}",
        info.make,
        info.model,
        w,
        h,
        if info.color_matrix.is_some() {
            "MakerNote"
        } else {
            "CAM_TO_SRGB"
        }
    );
    println!("\nblack | mean R   G   B  | magenta  (ref JPEG mean R/G=0.743 B/G=1.157, i.e. cool)");
    println!("------+-----------------+--------");

    let mut out = vec![0u8; w * h * 3];
    for black in [0u16, 128, 256, 512] {
        let mut p = PipelineParams::default_olympus();
        p.black = black;
        p.wb_r = wb_r;
        p.wb_g = 1.0;
        p.wb_b = wb_b;
        p.color_matrix = info.color_matrix;
        pipeline::process_into(&rgb16, &p, &mut out);
        let (r, g, b) = mean(&out);
        println!(
            "{black:5} | {r:5.1} {g:5.1} {b:5.1} | {:+5.1}   rg={:.3} bg={:.3}",
            (r + b) * 0.5 - g,
            r / g,
            b / g
        );
    }
    Ok(())
}
