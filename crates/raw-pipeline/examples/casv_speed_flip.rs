//! Phase 2 tradeoff table: the lightbox "encode speed" slider (0..100 → effort +
//! distance, matching speedToSettings in casv-lightbox-core.js) on a real moving-
//! block video. For each slider point: median streaming encode time (interleaved
//! arms), output size, and average decode-back PSNR vs the source frames — so you
//! can see whether the quality loss is worth the time saved.
//!
//!   cargo run --release --example casv_speed_flip -- [w] [h] [frames] [iters]

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{
        decode_casv_all_rgb8, encode_casv_video_streaming, CasaVideoOptions, VideoFrameSource,
    };
    use std::time::Instant;

    let arg = |n: usize, d: usize| -> usize {
        std::env::args().nth(n).and_then(|s| s.parse().ok()).unwrap_or(d)
    };
    let (w, h) = (arg(1, 1280) as u32, arg(2, 720) as u32);
    let nframes = arg(3, 48);
    let iters = arg(4, 11);

    let frames: Vec<Vec<u8>> = (0..nframes).map(|f| gen_frame(w as usize, h as usize, f)).collect();

    struct VecFrames<'a> {
        frames: &'a [Vec<u8>],
        w: u32,
        h: u32,
        i: usize,
    }
    impl<'a> VideoFrameSource for VecFrames<'a> {
        fn dims(&self) -> (u32, u32) { (self.w, self.h) }
        fn fps(&self) -> (u32, u32) { (24, 1) }
        fn next_frame(&mut self) -> Option<Vec<u8>> {
            let v = self.frames.get(self.i).cloned();
            if v.is_some() { self.i += 1; }
            v
        }
    }

    // speedToSettings(0/25/50/75/100): effort = round(4 - s/100*3), distance = 0.5 + s/100*1.5.
    let points: [(u32, u8, f32); 5] = [
        (0, 4, 0.5),
        (25, 3, 0.88),
        (50, 3, 1.25),
        (75, 2, 1.63),
        (100, 1, 2.0),
    ];
    let opts_at = |effort: u8, distance: f32| {
        let mut o = CasaVideoOptions::streaming(distance);
        o.effort = effort;
        o
    };
    let enc = |effort: u8, distance: f32| -> (Vec<u8>, f64) {
        let mut src = VecFrames { frames: &frames, w, h, i: 0 };
        let o = opts_at(effort, distance);
        let t = Instant::now();
        let out = encode_casv_video_streaming(&mut src, &o).unwrap();
        (out, t.elapsed().as_secs_f64() * 1000.0)
    };

    println!("{w}x{h} x{nframes} frames, streaming tile GOP24; {iters} interleaved iters");

    // Interleaved timing across all points to cancel drift.
    let mut times: Vec<Vec<f64>> = vec![Vec::new(); points.len()];
    for _ in 0..iters {
        for (pi, &(_, e, d)) in points.iter().enumerate() {
            times[pi].push(enc(e, d).1);
        }
    }
    let med = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };

    println!("{:>6}  {:>7}  {:>4}  {:>9}  {:>10}  {:>8}  {:>7}", "speed", "effort", "dist", "enc ms", "bytes", "PSNR dB", "vs s0");
    let mut base_ms = 0.0;
    for (pi, &(s, e, d)) in points.iter().enumerate() {
        let (out, _) = enc(e, d);
        let decoded = decode_casv_all_rgb8(&out).expect("decode");
        let mut psum = 0.0f64;
        for (i, (px, _, _)) in decoded.iter().enumerate() {
            psum += psnr_u8(&frames[i], px);
        }
        let psnr = psum / decoded.len() as f64;
        let ms = med(&mut times[pi]);
        if pi == 0 { base_ms = ms; }
        println!(
            "{:>6}  {:>7}  {:>4.2}  {:>9.1}  {:>10}  {:>8.2}  {:>6.2}x",
            s, e, d, ms, out.len(), psnr, base_ms / ms
        );
    }
}

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn gen_frame(w: usize, h: usize, f: usize) -> Vec<u8> {
    let mut px = vec![0u8; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 3;
            px[i] = ((x * 7 + y * 3) & 0xff) as u8;
            px[i + 1] = ((x * 3 + y * 11) & 0xff) as u8;
            px[i + 2] = ((x ^ y) & 0xff) as u8;
        }
    }
    let (bw, bh) = (w / 6, h / 6);
    let bx = (f * 17) % (w - bw).max(1);
    let by = (h - bh) / 2;
    let (r, g, b) = ((f * 37 & 0xff) as u8, (f * 53 & 0xff) as u8, (f * 97 & 0xff) as u8);
    for y in by..(by + bh).min(h) {
        for x in bx..(bx + bw).min(w) {
            let i = (y * w + x) * 3;
            px[i] = r;
            px[i + 1] = g;
            px[i + 2] = b;
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
    eprintln!("casv_speed_flip requires --features jxl-codec on a native target");
}
