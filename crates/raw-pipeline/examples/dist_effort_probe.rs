//! Distance×effort encode-time probe for the JOLT streaming path — separates
//! the two knobs to explain the tier_bench inversion (Balanced d1.0/e3 encoding
//! slower than Quality d0.5/e4 on 4K footage).
//!
//! Run (MSVC, release), from `crates/raw-pipeline`:
//!   ..\..\build-msvc.ps1 run --release --example dist_effort_probe --features jxl-codec -- <frames_dir> [n_frames]

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{
        encode_casv_video_streaming_to, CasaVideoOptions, VideoFrameSource, VideoRate,
    };
    use std::time::Instant;

    struct VecFrames {
        frames: Vec<Vec<u8>>,
        i: usize,
        w: u32,
        h: u32,
    }
    impl VideoFrameSource for VecFrames {
        fn dims(&self) -> (u32, u32) {
            (self.w, self.h)
        }
        fn fps(&self) -> (u32, u32) {
            (24, 1)
        }
        fn next_frame(&mut self) -> Option<Vec<u8>> {
            if self.i < self.frames.len() {
                let f = self.frames[self.i].clone();
                self.i += 1;
                Some(f)
            } else {
                None
            }
        }
    }

    let dir = std::env::args().nth(1).expect("usage: dist_effort_probe <frames_dir> [n]");
    let take: usize = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(12);

    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .expect("read frames dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "png"))
        .collect();
    paths.sort();
    paths.truncate(take);

    let mut frames: Vec<Vec<u8>> = Vec::new();
    let (mut w, mut h) = (0u32, 0u32);
    for p in &paths {
        let img = image::open(p).expect("open png").to_rgb8();
        w = img.width();
        h = img.height();
        frames.push(img.into_raw());
    }
    let n = frames.len();
    println!("distance x effort probe: {n} frames @ {w}x{h} (streaming footer encode)\n");
    println!("{:<16} {:>10} {:>9}", "d / e", "enc ms/f", "size MB");

    // Interleave the matrix twice in reversed order to expose drift.
    let matrix = [(2.0f32, 1u8), (1.0, 3), (0.5, 3), (1.0, 4), (0.5, 4), (2.0, 3)];
    let mut run = |d: f32, e: u8| {
        let mut opts = CasaVideoOptions::streaming(d);
        opts.effort = e;
        opts.rate = VideoRate::Lossy(d);
        let mut src = VecFrames { frames: frames.clone(), i: 0, w, h };
        let mut sink: Vec<u8> = Vec::new();
        let t0 = Instant::now();
        encode_casv_video_streaming_to(&mut src, &opts, &mut sink).unwrap();
        let ms = t0.elapsed().as_secs_f64() * 1000.0 / n as f64;
        println!("{:<16} {:>10.1} {:>9.2}", format!("d{d} / e{e}"), ms, sink.len() as f64 / 1e6);
    };
    for &(d, e) in &matrix {
        run(d, e);
    }
    for &(d, e) in matrix.iter().rev() {
        run(d, e);
    }
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("dist_effort_probe requires --features jxl-codec on a native target");
}
