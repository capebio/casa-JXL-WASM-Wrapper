//! jolt_rc_demo — JOLT rate control on a real frame sequence: encodes the clip
//! at a fixed distance, then bitrate-targeted at 0.5x / 1x / 2x the fixed
//! outcome, and prints per-GOP byte rates so convergence is visible.
//!
//! Run (MSVC, release), from crates/raw-pipeline:
//!   ..\..\build-msvc.ps1 run --release --example jolt_rc_demo --features jxl-codec -- <frames_dir>
#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{
        casv_frame_slice, encode_casv_video_streaming, parse_casv_header, CasaVideoOptions,
        VideoFrameSource,
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
                self.i += 1;
                Some(self.frames[self.i - 1].clone())
            } else {
                None
            }
        }
    }

    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests\real_video_ghana".to_string());
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .expect("frames dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "png"))
        .collect();
    paths.sort();
    let mut frames = Vec::new();
    let (mut w, mut h) = (0u32, 0u32);
    for p in &paths {
        let img = image::open(p).expect("png").to_rgb8();
        w = img.width();
        h = img.height();
        frames.push(img.into_raw());
    }
    let n = frames.len();
    let secs = n as f64 / 24.0;
    let gop = 12u32;

    let run = |opts: &CasaVideoOptions| {
        let mut fs = VecFrames {
            frames: frames.clone(),
            i: 0,
            w,
            h,
        };
        encode_casv_video_streaming(&mut fs, opts).unwrap()
    };

    let mut fixed = CasaVideoOptions::streaming(1.0);
    fixed.gop_len = gop;
    let fixed_out = run(&fixed);
    let fixed_rate = fixed_out.len() as f64 / secs;
    println!(
        "{n} frames @ {w}x{h} ({secs:.1} s, GOP {gop})   fixed d1.0: {} bytes  ({:.0} B/s)",
        fixed_out.len(),
        fixed_rate
    );

    for mult in [0.5f64, 1.0, 2.0] {
        let target = (fixed_rate * mult) as u32;
        let mut o = CasaVideoOptions::streaming_bitrate(1.0, target);
        o.gop_len = gop;
        let out = run(&o);
        let hdr = parse_casv_header(&out).unwrap();
        let gops = (n as u32).div_ceil(gop) as usize;
        let mut sizes = vec![0usize; gops];
        for i in 0..n {
            sizes[i / gop as usize] += casv_frame_slice(&out, i).unwrap().len();
        }
        let gop_secs = gop as f64 / 24.0;
        let rates: Vec<String> = sizes
            .iter()
            .map(|&s| format!("{:.0}k", s as f64 / gop_secs / 1000.0))
            .collect();
        println!(
            "  target {:>8} B/s ({mult}x): total {:>9} bytes  ({:.0} B/s, {:+.1}% vs target)   per-GOP B/s: [{}]   hdr d={:?}",
            target,
            out.len(),
            out.len() as f64 / secs,
            (out.len() as f64 / secs - target as f64) / target as f64 * 100.0,
            rates.join(", "),
            hdr.lossy_distance(),
        );
    }
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("jolt_rc_demo requires --features jxl-codec on a native target");
}
