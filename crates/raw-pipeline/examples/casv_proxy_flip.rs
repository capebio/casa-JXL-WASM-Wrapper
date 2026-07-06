//! Full-dimensioned editor proxy: encode_casv_proxy_rgb8 (all-intra, each frame
//! stores 1/factor res but declares full dims, self-upsampling) vs a full-res
//! all-intra .casv. Interleaved timing; size; average decode-back PSNR vs the
//! full-res source. Shows the proxy is a fast, dimension-identical, instant-
//! random-access scrub stand-in for a video editor.
//!
//!   cargo run --release --example casv_proxy_flip -- [w] [h] [frames] [distance] [iters]

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{decode_casv_all_rgb8, encode_casv_proxy_rgb8, encode_casv_rgb8};
    use raw_pipeline::jxl_casaencoder::EncodeOptions;
    use std::time::Instant;

    let arg = |n: usize, d: f64| -> f64 {
        std::env::args().nth(n).and_then(|s| s.parse().ok()).unwrap_or(d)
    };
    let (w, h) = (arg(1, 1280.0) as u32, arg(2, 720.0) as u32);
    let nframes = arg(3, 48.0) as usize;
    let distance = arg(4, 1.0) as f32;
    let iters = arg(5, 11.0) as usize;

    let frames: Vec<Vec<u8>> = (0..nframes).map(|f| gen_frame(w as usize, h as usize, f)).collect();
    let refs: Vec<&[u8]> = frames.iter().map(|v| v.as_slice()).collect();

    // (label, factor). factor 1 = full-res all-intra baseline.
    let arms: [(&str, u32); 3] = [("full", 1), ("proxy-2", 2), ("proxy-4", 4)];
    let enc = |factor: u32| -> Vec<u8> {
        let o = EncodeOptions::distance(distance).with_effort(3);
        if factor == 1 {
            encode_casv_rgb8(&refs, w, h, 24, 1, o).unwrap()
        } else {
            encode_casv_proxy_rgb8(&refs, w, h, 24, 1, factor, o).unwrap()
        }
    };

    println!("{w}x{h} x{nframes} all-intra, distance {distance}, effort 3; {iters} interleaved iters");

    let mut times: Vec<Vec<f64>> = vec![Vec::new(); arms.len()];
    for _ in 0..iters {
        for (ai, &(_, f)) in arms.iter().enumerate() {
            let t = Instant::now();
            let out = enc(f);
            times[ai].push(t.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(out.len());
        }
    }
    let med = |v: &mut Vec<f64>| { v.sort_by(|a, b| a.partial_cmp(b).unwrap()); v[v.len() / 2] };

    println!("{:>8}  {:>9}  {:>10}  {:>8}  {:>8}", "arm", "enc ms", "bytes", "PSNR dB", "vs full");
    let mut base = 0.0;
    for (ai, &(label, f)) in arms.iter().enumerate() {
        let out = enc(f);
        let decoded = decode_casv_all_rgb8(&out).expect("decode");
        let mut psum = 0.0f64;
        for (i, (px, dw, dh)) in decoded.iter().enumerate() {
            assert_eq!((*dw, *dh), (w, h), "{label}: frame {i} must decode to full dims");
            psum += psnr_u8(&frames[i], px);
        }
        let psnr = psum / decoded.len() as f64;
        let ms = med(&mut times[ai]);
        if ai == 0 { base = ms; }
        println!("{label:>8}  {ms:>9.1}  {:>10}  {psnr:>8.2}  {:>7.2}x", out.len(), base / ms);
    }
}

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn gen_frame(w: usize, h: usize, f: usize) -> Vec<u8> {
    let mut px = vec![0u8; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 3;
            let fx = x as f32 / w as f32;
            let fy = y as f32 / h as f32;
            let tex = ((x as f32 * 0.05).sin() * (y as f32 * 0.04).cos() * 30.0) as i32;
            px[i] = ((fx * 200.0 + 30.0) as i32 + tex).clamp(0, 255) as u8;
            px[i + 1] = ((fy * 200.0 + 30.0) as i32 + tex / 2).clamp(0, 255) as u8;
            px[i + 2] = (((fx + fy) * 110.0 + 20.0) as i32 - tex / 2).clamp(0, 255) as u8;
        }
    }
    // moving block so frames differ (proxy is all-intra; this just varies content)
    let (bw, bh) = (w / 6, h / 6);
    let bx = (f * 17) % (w - bw).max(1);
    let by = (h - bh) / 2;
    for y in by..(by + bh).min(h) {
        for x in bx..(bx + bw).min(w) {
            let i = (y * w + x) * 3;
            px[i] = (f * 37 & 0xff) as u8;
            px[i + 1] = (f * 53 & 0xff) as u8;
            px[i + 2] = (f * 97 & 0xff) as u8;
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
    eprintln!("casv_proxy_flip requires --features jxl-codec on a native target");
}
