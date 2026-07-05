// Visual gate for the CR2 de-slice fix: decode → demosaic → quick WB+gamma → downscale → PNG.
// Structure (recognizable photo vs scrambled banding) tells us if the slice reassembly is right.
use image::{imageops, ImageBuffer, Rgb};
use raw_pipeline::{cr2, demosaic};
use std::fs;

fn render(path: &str, out: &str) {
    let data = fs::read(path).unwrap();
    let img = cr2::decode_bytes(&data).unwrap();
    let (w, h) = (img.width, img.height);
    let rgb16 = demosaic::demosaic_rggb(&img.raw, w, h).unwrap();
    let black = img.black as f32;
    let denom = (img.white as f32 - black).max(1.0);
    let (wr, wb) = (img.wb_r, img.wb_b);
    let mut buf = ImageBuffer::<Rgb<u8>, _>::new(w as u32, h as u32);
    for y in 0..h {
        for x in 0..w {
            let o = (y * w + x) * 3;
            let norm = |v: u16, mul: f32| {
                let n = ((v as f32 - black) / denom * mul).clamp(0.0, 1.0);
                (n.sqrt() * 255.0) as u8 // sqrt gamma for visibility
            };
            buf.put_pixel(
                x as u32,
                y as u32,
                Rgb([
                    norm(rgb16[o], wr),
                    norm(rgb16[o + 1], 1.0),
                    norm(rgb16[o + 2], wb),
                ]),
            );
        }
    }
    let scale = 480.0 / w as f32;
    let small = imageops::resize(
        &buf,
        (w as f32 * scale) as u32,
        (h as f32 * scale) as u32,
        imageops::FilterType::Triangle,
    );
    small.save(out).unwrap();
    eprintln!(
        "{} -> {} ({}x{})",
        path.rsplit('/').next().unwrap(),
        out,
        w,
        h
    );
}

fn main() {
    let dir = "C:/Foo/raw-converter-wasm/docs/outputs/ChatGPT plus Claude Outputs/Done Deal";
    std::fs::create_dir_all(dir).ok();
    render(
        "C:/Foo/raw-converter/tests/_MG_1744.CR2",
        &format!("{dir}/cr2-deslice-_MG_1744.png"),
    );
    render(
        "C:/Foo/raw-converter/tests/ADH 1234.CR2",
        &format!("{dir}/cr2-deslice-ADH1234.png"),
    );
}
