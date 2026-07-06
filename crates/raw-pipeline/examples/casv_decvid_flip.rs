//! Phase 3 probe: sequential CASV video decode single-threaded
//! (decode_casv_all_rgb8) vs a per-frame libjxl parallel runner
//! (decode_casv_all_rgb8_threaded), on a synthetic moving-block video. Same
//! symmetric question as Phase 1's encode flip: the decode loop is sequential,
//! so cores sit idle during each frame's libjxl decode — does a runner help?
//! Interleaved A/B; asserts MT decode is byte-identical to ST.
//!
//! RESULT (12 cores, byte-identical): decode-MT REGRESSES below 4K —
//!   all-intra 720p 0.50x, GOP24 720p 0.68x, 4K GOP24 1.79x.
//! Unlike encode, djxl decode is light + bandwidth-bound, so a sub-4K frame is
//! too small for the per-frame runner: fork-join sync dominates. The sequential
//! decode default (single-threaded) is therefore already correct; do NOT thread
//! it by default. The threaded variant stays available for known-large (>=4K)
//! callers only. Kept as the evidence behind that decision.
//!
//!   cargo run --release --example casv_decvid_flip -- [w] [h] [frames] [gop] [iters]

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{
        decode_casv_all_rgb8, decode_casv_all_rgb8_threaded, encode_casv_video_streaming,
        CasaVideoOptions, VideoFrameSource,
    };
    use std::time::Instant;

    let arg = |n: usize, d: usize| -> usize {
        std::env::args().nth(n).and_then(|s| s.parse().ok()).unwrap_or(d)
    };
    let (w, h) = (arg(1, 1280) as u32, arg(2, 720) as u32);
    let nframes = arg(3, 48);
    let gop = arg(4, 24) as u32;
    let iters = arg(5, 15);

    let frames: Vec<Vec<u8>> = (0..nframes).map(|f| gen_frame(w as usize, h as usize, f)).collect();
    struct VecFrames<'a> { frames: &'a [Vec<u8>], w: u32, h: u32, i: usize }
    impl<'a> VideoFrameSource for VecFrames<'a> {
        fn dims(&self) -> (u32, u32) { (self.w, self.h) }
        fn fps(&self) -> (u32, u32) { (24, 1) }
        fn next_frame(&mut self) -> Option<Vec<u8>> {
            let v = self.frames.get(self.i).cloned();
            if v.is_some() { self.i += 1; }
            v
        }
    }

    let mut opts = CasaVideoOptions::streaming(1.0);
    opts.gop_len = gop;
    let mut src = VecFrames { frames: &frames, w, h, i: 0 };
    let casv = encode_casv_video_streaming(&mut src, &opts).unwrap();

    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    println!("{w}x{h} x{nframes} GOP{gop}; {} bytes; {iters} iters; {cores} cores", casv.len());

    // Byte-equality once.
    let a = decode_casv_all_rgb8(&casv).unwrap();
    let b = decode_casv_all_rgb8_threaded(&casv, cores).unwrap();
    assert_eq!(a.len(), b.len());
    for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
        assert_eq!(x.0, y.0, "frame {i} MT decode must equal ST");
    }
    println!("byte-identical ST vs MT decode: OK");

    let (mut t_st, mut t_mt) = (Vec::new(), Vec::new());
    for it in 0..iters {
        let st_first = it % 2 == 0;
        for arm in 0..2 {
            let is_st = (arm == 0) == st_first;
            if is_st {
                let t = Instant::now();
                let r = decode_casv_all_rgb8(&casv).unwrap();
                t_st.push(t.elapsed().as_secs_f64() * 1000.0);
                std::hint::black_box(r.len());
            } else {
                let t = Instant::now();
                let r = decode_casv_all_rgb8_threaded(&casv, cores).unwrap();
                t_mt.push(t.elapsed().as_secs_f64() * 1000.0);
                std::hint::black_box(r.len());
            }
        }
    }
    let med = |v: &mut Vec<f64>| { v.sort_by(|a, b| a.partial_cmp(b).unwrap()); v[v.len() / 2] };
    let (ms, mm) = (med(&mut t_st), med(&mut t_mt));
    println!(
        "ST decode {ms:>8.1} ms | MT decode {mm:>8.1} ms | delta {:>+6.2}%  speedup {:.2}x  (byte-equal)",
        (mm / ms - 1.0) * 100.0, ms / mm
    );
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
            px[i] = r; px[i + 1] = g; px[i + 2] = b;
        }
    }
    px
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("casv_decvid_flip requires --features jxl-codec on a native target");
}
