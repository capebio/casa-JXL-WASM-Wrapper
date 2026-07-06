//! JOLT preset benchmark — encodes a real frame sequence with the three JOLT
//! presets (Realtime / Balanced / Quality) plus the lossless archive tier and
//! reports size, encode/decode ms per frame, and decode fps vs the 24 fps
//! budget. Streaming (footer) encode is used for the presets — the production
//! shape (prev+current frame resident only).
//!
//! Run (MSVC, release), from `crates/raw-pipeline`:
//!   ..\..\build-msvc.ps1 run --release --example jolt_bench --features jxl-codec -- <frames_dir>
//! Default frames_dir = the extracted Ghana dashcam frames.

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{
        decode_casv_footer_all_rgb8, encode_casv_video, jolt_encode_stream_to, parse_casv_rate_box,
        CasaVideoOptions, JoltPreset, VideoFrameSource,
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

    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests\real_video_ghana".to_string());
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
    let n = frames.len();
    let raw_mb = (n as f64 * (w as f64 * h as f64 * 3.0)) / 1e6;
    println!(
        "JOLT preset benchmark: {n} frames @ {w}x{h}  raw {raw_mb:.1} MB  (24fps budget 41.7 ms/frame)\n"
    );
    println!(
        "{:<22} {:>9} {:>9} {:>10} {:>10} {:>9}  {}",
        "tier", "size MB", "vs raw", "enc ms/f", "dec ms/f", "dec fps", "24fps?"
    );

    let run = |label: &str, preset: Option<JoltPreset>| {
        let t0 = Instant::now();
        let bytes = match preset {
            Some(p) => {
                let mut src = VecFrames {
                    frames: frames.clone(),
                    i: 0,
                    w,
                    h,
                };
                let mut sink: Vec<u8> = Vec::new();
                jolt_encode_stream_to(&mut src, p, &mut sink).unwrap();
                sink
            }
            None => {
                let refs: Vec<&[u8]> = frames.iter().map(|v| v.as_slice()).collect();
                encode_casv_video(&refs, w, h, 24, 1, &CasaVideoOptions::lossless_archive())
                    .unwrap()
            }
        };
        let enc_ms = t0.elapsed().as_secs_f64() * 1000.0 / n as f64;
        let t1 = Instant::now();
        let decoded = match preset {
            Some(_) => decode_casv_footer_all_rgb8(&bytes).unwrap(),
            None => raw_pipeline::casa_video::decode_casv_all_rgb8(&bytes).unwrap(),
        };
        assert_eq!(decoded.len(), n);
        let dec_ms = t1.elapsed().as_secs_f64() * 1000.0 / n as f64;
        let size_mb = bytes.len() as f64 / 1e6;
        let fps = 1000.0 / dec_ms;
        println!(
            "{:<22} {:>9.2} {:>8.1}% {:>10.1} {:>10.1} {:>9.0}  {}",
            label,
            size_mb,
            size_mb / raw_mb * 100.0,
            enc_ms,
            dec_ms,
            fps,
            if dec_ms <= 41.7 { "PASS" } else { "over" }
        );
        if preset.is_some() {
            if let Some(flags) = parse_casv_rate_box(&bytes) {
                println!(
                    "{:<22} rate box: lossy={} d={:.1} e={}",
                    "",
                    flags & 1,
                    ((flags >> 8) & 0xFF) as f32 / 10.0,
                    (flags >> 16) & 0xF
                );
            }
        }
    };

    run("JOLT Realtime", Some(JoltPreset::Realtime));
    run("JOLT Balanced", Some(JoltPreset::Balanced));
    run("JOLT Quality", Some(JoltPreset::Quality));
    run("lossless archive", None);
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("jolt_bench requires --features jxl-codec on a native target");
}
