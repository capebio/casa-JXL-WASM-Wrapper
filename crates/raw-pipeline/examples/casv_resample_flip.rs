//! Phase 2a lever check: JXL codestream RESAMPLING (1/2/4) as a quality↔time↔
//! size tradeoff on a photo-like frame. For each factor: median encode time
//! (interleaved arms to cancel drift), output size, and decode-back PSNR vs the
//! source. Shows whether the speed/size win is worth the quality loss — the
//! data behind the lightbox "Fast"/resampling controls.
//!
//!   cargo run --release --example casv_resample_flip -- [w] [h] [distance] [iters]

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::jxl_casadecoder::decode_interleaved;
    use raw_pipeline::jxl_casaencoder::{EncodeOptions, Encoder, Frame};
    use std::time::Instant;

    let arg = |n: usize, d: f64| -> f64 {
        std::env::args()
            .nth(n)
            .and_then(|s| s.parse().ok())
            .unwrap_or(d)
    };
    let (w, h) = (arg(1, 1280.0) as u32, arg(2, 720.0) as u32);
    let distance = arg(3, 1.0) as f32;
    let iters = arg(4, 21.0) as usize;

    let src = gen_photo(w as usize, h as usize);
    let factors = [1i64, 2, 4];
    println!("{w}x{h} photo-like, distance {distance}, effort 3; {iters} interleaved iters");

    // Interleaved timing: cycle factor arms so thermal drift hits all equally.
    let mut times: Vec<Vec<f64>> = vec![Vec::new(); factors.len()];
    for _ in 0..iters {
        for (ai, &f) in factors.iter().enumerate() {
            let opts = EncodeOptions::distance(distance)
                .with_effort(3)
                .with_resampling(f);
            let mut enc = Encoder::new(opts).unwrap();
            let t = Instant::now();
            let out = enc.encode(&Frame::rgb(&src, w, h)).unwrap();
            times[ai].push(t.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(out.len());
        }
    }
    let med = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };

    println!("{:>6}  {:>10}  {:>10}  {:>8}  {:>8}", "resamp", "enc ms", "bytes", "PSNR dB", "vs r1");
    let mut base_ms = 0.0;
    for (ai, &f) in factors.iter().enumerate() {
        let opts = EncodeOptions::distance(distance)
            .with_effort(3)
            .with_resampling(f);
        let out = Encoder::new(opts).unwrap().encode(&Frame::rgb(&src, w, h)).unwrap();
        let (dec, dw, dh) = decode_interleaved::<u8>(&out, 3).unwrap();
        assert_eq!((dw, dh), (w, h), "decoder must upsample back to full res");
        let psnr = psnr_u8(&src, &dec);
        let ms = med(&mut times[ai]);
        if ai == 0 {
            base_ms = ms;
        }
        println!(
            "{:>6}  {:>10.1}  {:>10}  {:>8.2}  {:>7.2}x",
            f,
            ms,
            out.len(),
            psnr,
            base_ms / ms
        );
    }
}

/// Photo-like frame: smooth gradients + mid-frequency sinusoidal texture, so
/// downsampling has a realistic (visible but graceful) effect.
#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn gen_photo(w: usize, h: usize) -> Vec<u8> {
    let mut px = vec![0u8; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 3;
            let fx = x as f32 / w as f32;
            let fy = y as f32 / h as f32;
            let tex = ((x as f32 * 0.09).sin() * (y as f32 * 0.07).cos() * 40.0) as i32;
            let r = (fx * 200.0 + 30.0) as i32 + tex;
            let g = (fy * 200.0 + 30.0) as i32 + tex / 2;
            let b = ((fx + fy) * 110.0 + 20.0) as i32 - tex / 2;
            px[i] = r.clamp(0, 255) as u8;
            px[i + 1] = g.clamp(0, 255) as u8;
            px[i + 2] = b.clamp(0, 255) as u8;
        }
    }
    px
}

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn psnr_u8(a: &[u8], b: &[u8]) -> f64 {
    let n = a.len().min(b.len());
    let mut se = 0.0f64;
    for i in 0..n {
        let d = a[i] as f64 - b[i] as f64;
        se += d * d;
    }
    let mse = se / n as f64;
    if mse == 0.0 {
        return 99.0;
    }
    10.0 * (255.0f64 * 255.0 / mse).log10()
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("casv_resample_flip requires --features jxl-codec on a native target");
}
