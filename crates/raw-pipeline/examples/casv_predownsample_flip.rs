//! Fix the RESAMPLING=2 slowdown. libjxl's internal resampling
//! (ALREADY_DOWNSAMPLED=0) makes the encoder run an optimized full-res
//! downsample — measured ~5x SLOWER at factor 2 than the full-res baseline,
//! which is absurd for coding 1/4 the pixels. The "entirely different" method:
//! downsample ourselves (cheap box filter), encode the small image with
//! ALREADY_DOWNSAMPLED=1, and let the decoder upsample back to full dims — same
//! aim (a self-upsampling reduced-resolution codestream), but the encoder only
//! ever touches the small image.
//!
//! Arms (interleaved timing incl. our downsample cost; PSNR vs full-res source):
//!   full   full-res baseline
//!   int-2  libjxl internal RESAMPLING=2   (already_downsampled=0, the slow path)
//!   pre-2  our box-2 downsample + RESAMPLING=2 already_downsampled=1
//!   int-4 / pre-4  same at factor 4
//!
//!   cargo run --release --example casv_predownsample_flip -- [w] [h] [distance] [iters]

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::jxl_casadecoder::decode_interleaved;
    use raw_pipeline::jxl_casaencoder::{encode_rgb8_downsampled, EncodeOptions, Encoder, Frame};
    use std::time::Instant;

    let arg = |n: usize, d: f64| -> f64 {
        std::env::args().nth(n).and_then(|s| s.parse().ok()).unwrap_or(d)
    };
    let (w, h) = (arg(1, 1280.0) as u32, arg(2, 720.0) as u32);
    let distance = arg(3, 1.0) as f32;
    let iters = arg(4, 21.0) as usize;
    let src = gen_photo(w as usize, h as usize);

    // Arms: (label, factor, ours). factor 1 = full-res baseline.
    let arms: [(&str, u32, bool); 5] = [
        ("full", 1, false),
        ("int-2", 2, false),
        ("pre-2", 2, true),
        ("int-4", 4, false),
        ("pre-4", 4, true),
    ];

    let encode = |factor: u32, ours: bool| -> Vec<u8> {
        if factor == 1 {
            return Encoder::new(EncodeOptions::distance(distance).with_effort(3))
                .unwrap()
                .encode(&Frame::rgb(&src, w, h))
                .unwrap();
        }
        if ours {
            // our cheap box downsample + ALREADY_DOWNSAMPLED encode (library helper)
            encode_rgb8_downsampled(&src, w, h, factor, EncodeOptions::distance(distance).with_effort(3))
                .unwrap()
        } else {
            // libjxl internal resampling: feed full res, encoder downsamples
            Encoder::new(
                EncodeOptions::distance(distance)
                    .with_effort(3)
                    .with_resampling(factor as i64),
            )
            .unwrap()
            .encode(&Frame::rgb(&src, w, h))
            .unwrap()
        }
    };

    println!("{w}x{h} photo-like, distance {distance}, effort 3; {iters} interleaved iters");

    let mut times: Vec<Vec<f64>> = vec![Vec::new(); arms.len()];
    for _ in 0..iters {
        for (ai, &(_, f, ours)) in arms.iter().enumerate() {
            let t = Instant::now();
            let out = encode(f, ours);
            times[ai].push(t.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(out.len());
        }
    }
    let med = |v: &mut Vec<f64>| { v.sort_by(|a, b| a.partial_cmp(b).unwrap()); v[v.len() / 2] };

    println!("{:>6}  {:>9}  {:>10}  {:>8}  {:>8}", "arm", "enc ms", "bytes", "PSNR dB", "vs full");
    let mut base = 0.0;
    for (ai, &(label, f, ours)) in arms.iter().enumerate() {
        let out = encode(f, ours);
        let (dec, dw, dh) = decode_interleaved::<u8>(&out, 3).unwrap();
        assert_eq!((dw, dh), (w, h), "{label}: decoder must output full res");
        let psnr = psnr_u8(&src, &dec);
        let ms = med(&mut times[ai]);
        if ai == 0 { base = ms; }
        println!("{label:>6}  {ms:>9.1}  {:>10}  {psnr:>8.2}  {:>7.2}x", out.len(), base / ms);
    }
}

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn gen_photo(w: usize, h: usize) -> Vec<u8> {
    let mut px = vec![0u8; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 3;
            let fx = x as f32 / w as f32;
            let fy = y as f32 / h as f32;
            let tex = ((x as f32 * 0.09).sin() * (y as f32 * 0.07).cos() * 40.0) as i32;
            px[i] = ((fx * 200.0 + 30.0) as i32 + tex).clamp(0, 255) as u8;
            px[i + 1] = ((fy * 200.0 + 30.0) as i32 + tex / 2).clamp(0, 255) as u8;
            px[i + 2] = (((fx + fy) * 110.0 + 20.0) as i32 - tex / 2).clamp(0, 255) as u8;
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
    if mse == 0.0 { return 99.0; }
    10.0 * (255.0f64 * 255.0 / mse).log10()
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("casv_predownsample_flip requires --features jxl-codec on a native target");
}
