//! Generate synthetic Mandelbrot test images at high bit depth.
//! Smooth (continuous) escape-time + a vivid palette with HDR peaks (>1.0) so the
//! f32 path is actually exercised. Outputs to the dir given as argv[1] (default ".").
//!   mandelbrot_f32.exr   (RGBA f32, linear, HDR)
//!   mandelbrot_u16.tiff  (RGB16)
//!   mandelbrot_u8.tiff   (RGB8)

fn smooth_iter(cx: f64, cy: f64, max_iter: u32) -> f64 {
    let (mut x, mut y) = (0.0_f64, 0.0_f64);
    for i in 0..max_iter {
        let (x2, y2) = (x * x, y * y);
        if x2 + y2 > 256.0 {
            let log_zn = (x2 + y2).ln() / 2.0;
            let nu = (log_zn / std::f64::consts::LN_2).ln() / std::f64::consts::LN_2;
            return i as f64 + 1.0 - nu; // continuous escape value
        }
        y = 2.0 * x * y + cy;
        x = x2 - y2 + cx;
    }
    max_iter as f64
}

/// iter -> linear RGB with HDR peaks (channel-separated, non-grey). Inside set = 0.
fn iter_to_linear(iter: f64, max_iter: u32) -> [f32; 3] {
    if iter >= max_iter as f64 {
        return [0.0, 0.0, 0.0];
    }
    let t = (iter / max_iter as f64).clamp(0.0, 1.0) as f32;
    // three phase-shifted sines -> distinct channels; scale to ~[0,3] for HDR.
    let tau = std::f32::consts::TAU;
    let r = 0.5 + 0.5 * (tau * (t * 3.0 + 0.00)).sin();
    let g = 0.5 + 0.5 * (tau * (t * 3.0 + 0.33)).sin();
    let b = 0.5 + 0.5 * (tau * (t * 3.0 + 0.66)).sin();
    let hdr = 1.0 + 2.0 * t; // peak ~3.0 to push past 1.0
    [r * hdr, g * hdr, b * hdr]
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let (w, h, max_iter) = (256u32, 256u32, 200u32);
    let (x_min, x_max, y_min, y_max) = (-2.5_f64, 1.0, -1.25, 1.25);

    let mut f32buf = Vec::with_capacity((w * h * 4) as usize);
    for py in 0..h {
        let cy = y_min + (py as f64 / h as f64) * (y_max - y_min);
        for px in 0..w {
            let cx = x_min + (px as f64 / w as f64) * (x_max - x_min);
            let [r, g, b] = iter_to_linear(smooth_iter(cx, cy, max_iter), max_iter);
            f32buf.extend_from_slice(&[r, g, b, 1.0]);
        }
    }

    // EXR f32 (linear, HDR preserved)
    let exr: image::ImageBuffer<image::Rgba<f32>, Vec<f32>> =
        image::ImageBuffer::from_raw(w, h, f32buf.clone()).expect("f32 buffer sized w*h*4");
    image::DynamicImage::ImageRgba32F(exr).save(format!("{dir}/mandelbrot_f32.exr"))?;

    // u16 / u8 TIFF (tone-mapped to display range so they are viewable)
    let disp = raw_pipeline::image_formats::f32_linear_to_srgb8(&f32buf); // RGBA8
    let rgb8: Vec<u8> = disp
        .chunks_exact(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .collect();
    image::RgbImage::from_raw(w, h, rgb8.clone())
        .expect("rgb8 buffer sized w*h*3")
        .save(format!("{dir}/mandelbrot_u8.tiff"))?;
    let rgb16: Vec<u16> = rgb8.iter().map(|&b| (b as u16) << 8 | b as u16).collect();
    let img16: image::ImageBuffer<image::Rgb<u16>, Vec<u16>> =
        image::ImageBuffer::from_raw(w, h, rgb16).expect("rgb16 buffer sized w*h*3");
    image::DynamicImage::ImageRgb16(img16).save(format!("{dir}/mandelbrot_u16.tiff"))?;

    println!("wrote mandelbrot_f32.exr / mandelbrot_u16.tiff / mandelbrot_u8.tiff to {dir}");
    Ok(())
}
