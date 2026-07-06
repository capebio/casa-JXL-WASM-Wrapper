//! CV-E6 flip: streaming lossy CASV encode single-threaded (`CASV_ENC_THREADS=1`)
//! vs multi-threaded libjxl runner (`CASV_ENC_THREADS=0` = auto = all cores), on
//! a synthetic moving-block video that exercises both the I-frame chunked encode
//! and the JE-8 square-atlas P-frame encode. Interleaved A,B,A,B with start
//! rotation; asserts the two thread counts produce a BYTE-IDENTICAL `.casv`
//! (thread count must only move wall-clock), then reports the median delta.
//!
//!   cargo run --release --example casv_mt_flip -- [w] [h] [frames] [iters]

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{
        encode_casv_video_streaming, CasaVideoOptions, VideoFrameSource,
    };
    use std::time::Instant;

    let arg = |n: usize, d: usize| -> usize {
        std::env::args()
            .nth(n)
            .and_then(|s| s.parse().ok())
            .unwrap_or(d)
    };
    let (w, h) = (arg(1, 1280) as u32, arg(2, 720) as u32);
    let nframes = arg(3, 48);
    let iters = arg(4, 15);
    let gop = arg(5, 24) as u32;
    let motion_pct = arg(6, 16); // moving-block edge as % of frame edge

    // Pre-generate frames once (not timed): static textured background + a
    // moving colored block, so a subset of tiles changes each frame.
    let frames: Vec<Vec<u8>> = (0..nframes)
        .map(|f| gen_frame(w as usize, h as usize, f, motion_pct))
        .collect();

    struct VecFrames<'a> {
        frames: &'a [Vec<u8>],
        w: u32,
        h: u32,
        i: usize,
    }
    impl<'a> VideoFrameSource for VecFrames<'a> {
        fn dims(&self) -> (u32, u32) {
            (self.w, self.h)
        }
        fn fps(&self) -> (u32, u32) {
            (24, 1)
        }
        fn next_frame(&mut self) -> Option<Vec<u8>> {
            let v = self.frames.get(self.i).cloned();
            if v.is_some() {
                self.i += 1;
            }
            v
        }
    }

    let mut opts = CasaVideoOptions::streaming(1.0); // Balanced: d1.0, e3, tile skip
    opts.gop_len = gop;
    let encode = |threads: &str| -> (Vec<u8>, f64) {
        std::env::set_var("CASV_ENC_THREADS", threads);
        let mut src = VecFrames {
            frames: &frames,
            w,
            h,
            i: 0,
        };
        let t = Instant::now();
        let out = encode_casv_video_streaming(&mut src, &opts).unwrap();
        (out, t.elapsed().as_secs_f64() * 1000.0)
    };

    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    println!(
        "{w}x{h} x{nframes} frames, streaming tile d1.0/e3 GOP{gop} motion{motion_pct}%; {iters} interleaved iters; {cores} cores"
    );

    // Byte-equality proof once (not timed): MT output must equal ST output.
    let (b1, _) = encode("1");
    let (bm, _) = encode("0");
    assert_eq!(
        b1, bm,
        "MT streaming encode must be byte-identical to single-threaded"
    );
    println!("byte-identical ST vs MT: OK ({} bytes)", b1.len());

    let (mut t_st, mut t_mt) = (Vec::new(), Vec::new());
    for it in 0..iters {
        let st_first = it % 2 == 0;
        for arm in 0..2 {
            let is_st = (arm == 0) == st_first;
            if is_st {
                t_st.push(encode("1").1);
            } else {
                t_mt.push(encode("0").1);
            }
        }
    }
    let med = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };
    let (ms, mm) = (med(&mut t_st), med(&mut t_mt));
    println!(
        "single-thread {ms:>9.1} ms | MT runner {mm:>9.1} ms | delta {:>+6.2}%  speedup {:.2}x  (byte-equal)",
        (mm / ms - 1.0) * 100.0,
        ms / mm
    );
}

/// Deterministic frame: static textured background + a moving colored block.
#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn gen_frame(w: usize, h: usize, f: usize, motion_pct: usize) -> Vec<u8> {
    let mut px = vec![0u8; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 3;
            // Static background texture (frame-independent).
            px[i] = ((x * 7 + y * 3) & 0xff) as u8;
            px[i + 1] = ((x * 3 + y * 11) & 0xff) as u8;
            px[i + 2] = ((x ^ y) & 0xff) as u8;
        }
    }
    // Moving block drifting horizontally, color varies per frame. Its edge is
    // `motion_pct`% of the frame edge → controls changed-tile area (atlas size).
    let bw = (w * motion_pct / 100).max(1);
    let bh = (h * motion_pct / 100).max(1);
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

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("casv_mt_flip requires --features jxl-codec on a native target");
}
