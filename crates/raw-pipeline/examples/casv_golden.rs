//! CASV/JOLT encode golden-output harness — encodes a frame directory through
//! every lossy encode entry point (batch / streaming-header / streaming-footer)
//! × preset (Realtime / Balanced / Quality) × skip mode (bbox / tile) × GOP
//! (1 / 24) and writes each `.casv` to an output directory. Hash the outputs
//! (e.g. `Get-FileHash`) to prove byte-exactness across encoder refactors.
//!
//! Run (MSVC, release), from `crates/raw-pipeline`:
//!   cargo run --release --example casv_golden --features jxl-codec -- <frames_dir> <out_dir>
//! Defaults: frames_dir = the Ghana dashcam frames, out_dir = casv_golden_out.

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{
        encode_casv_video, encode_casv_video_streaming, encode_casv_video_streaming_to,
        CasaVideoOptions, JoltPreset, SkipMode, VideoFrameSource,
    };

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

    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests\real_video_ghana".to_string());
    let out_dir = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "casv_golden_out".to_string());
    std::fs::create_dir_all(&out_dir).expect("create out dir");

    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .expect("read frames dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "png"))
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "no PNG frames in {dir}");

    let mut frames: Vec<Vec<u8>> = Vec::with_capacity(paths.len());
    let (mut w, mut h) = (0u32, 0u32);
    for p in &paths {
        let img = image::open(p).expect("open png").to_rgb8();
        w = img.width();
        h = img.height();
        frames.push(img.into_raw());
    }
    eprintln!("{} frames @ {w}x{h}", frames.len());

    for (pname, preset) in [
        ("realtime", JoltPreset::Realtime),
        ("balanced", JoltPreset::Balanced),
        ("quality", JoltPreset::Quality),
    ] {
        for (sname, skip) in [("bbox", SkipMode::Bbox), ("tile", SkipMode::Tile)] {
            for gop in [1u32, 24] {
                let opts = CasaVideoOptions {
                    skip,
                    gop_len: gop,
                    ..CasaVideoOptions::jolt(preset)
                };
                let tag = format!("{pname}_{sname}_gop{gop}");

                let refs: Vec<&[u8]> = frames.iter().map(|v| v.as_slice()).collect();
                let t0 = std::time::Instant::now();
                let batch = encode_casv_video(&refs, w, h, 24, 1, &opts).unwrap();
                let batch_ms = t0.elapsed().as_secs_f64() * 1000.0;
                std::fs::write(format!("{out_dir}/{tag}_batch.casv"), &batch).unwrap();

                let mut src = VecFrames {
                    frames: frames.clone(),
                    i: 0,
                    w,
                    h,
                };
                let t0 = std::time::Instant::now();
                let stream = encode_casv_video_streaming(&mut src, &opts).unwrap();
                let stream_ms = t0.elapsed().as_secs_f64() * 1000.0;
                std::fs::write(format!("{out_dir}/{tag}_stream.casv"), &stream).unwrap();

                let mut src = VecFrames {
                    frames: frames.clone(),
                    i: 0,
                    w,
                    h,
                };
                let mut sink: Vec<u8> = Vec::new();
                let t0 = std::time::Instant::now();
                encode_casv_video_streaming_to(&mut src, &opts, &mut sink).unwrap();
                let sink_ms = t0.elapsed().as_secs_f64() * 1000.0;
                std::fs::write(format!("{out_dir}/{tag}_sink.casv"), &sink).unwrap();

                eprintln!(
                    "{tag}: batch {} B {batch_ms:.0} ms, stream {} B {stream_ms:.0} ms, sink {} B {sink_ms:.0} ms",
                    batch.len(),
                    stream.len(),
                    sink.len()
                );
            }
        }
    }
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("casv_golden requires --features jxl-codec on a native target");
}
