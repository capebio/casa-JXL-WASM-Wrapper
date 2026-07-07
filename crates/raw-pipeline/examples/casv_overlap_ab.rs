//! Phase 3.2 A/B: SERIAL vs OVERLAPPED CASV streaming encode.
//!
//! Proves the decode∥encode overlap in `casa_video::stream_encode_frames` is a pure
//! SCHEDULING change:
//!   1. BYTE GATE — encode the frames both ways (`CASV_STREAM_SERIAL=1` = legacy
//!      serial loop, default = overlapped producer/consumer) and assert the output
//!      `.casv` byte buffers are IDENTICAL, on BOTH the footer-to-sink
//!      (`encode_casv_video_streaming_to`) and the header-buffered
//!      (`encode_casv_video_streaming`) containers.
//!   2. THROUGHPUT — total wall-clock serial vs overlapped over a source that DECODES
//!      each PNG on demand (mirrors the real ffmpeg/PNG streaming path, where the
//!      per-frame source decode is the work that overlaps the previous frame's
//!      single-threaded P-frame encode). Reports speedup + fps.
//!
//! Run (MSVC, release), from `crates/raw-pipeline`:
//!   ..\..\build-msvc.ps1 run --release --features jxl-codec --example casv_overlap_ab -- <png_dir>
//! Default <png_dir> = C:\Foo\raw-converter\tests\real_video_ghana_1080  (48 x 1080p).
//! NOTE: run on AC power — battery throttles the CPU (no turbo) and skews wall-clock.

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
mod ab {
    use raw_pipeline::casa_video::{
        encode_casv_video_streaming, encode_casv_video_streaming_to, CasaVideoOptions,
        VideoFrameSource,
    };
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    /// Real per-frame PNG-decoding source. Each `next_frame_into` runs a full `image`
    /// decode — the exact work Phase 3.2 overlaps with the previous frame's encode.
    /// Holds only the compressed PNG bytes (Send: shared slice + primitives).
    pub struct PngDecodeSource<'a> {
        png: &'a [Vec<u8>],
        i: usize,
        w: u32,
        h: u32,
    }
    impl<'a> PngDecodeSource<'a> {
        pub fn new(png: &'a [Vec<u8>], w: u32, h: u32) -> Self {
            Self { png, i: 0, w, h }
        }
    }
    impl<'a> VideoFrameSource for PngDecodeSource<'a> {
        fn dims(&self) -> (u32, u32) {
            (self.w, self.h)
        }
        fn fps(&self) -> (u32, u32) {
            (24, 1)
        }
        fn next_frame(&mut self) -> Option<Vec<u8>> {
            if self.i >= self.png.len() {
                return None;
            }
            let img = image::load_from_memory(&self.png[self.i])
                .expect("decode png")
                .to_rgb8();
            self.i += 1;
            Some(img.into_raw())
        }
        fn next_frame_into(&mut self, buf: &mut Vec<u8>) -> bool {
            match self.next_frame() {
                Some(v) => {
                    *buf = v;
                    true
                }
                None => false,
            }
        }
    }

    fn set_serial(on: bool) {
        if on {
            std::env::set_var("CASV_STREAM_SERIAL", "1");
        } else {
            std::env::remove_var("CASV_STREAM_SERIAL");
        }
    }

    /// Footer-format encode of the whole clip → (bytes, wall).
    fn enc_footer(
        png: &[Vec<u8>],
        w: u32,
        h: u32,
        opts: &CasaVideoOptions,
        serial: bool,
    ) -> (Vec<u8>, Duration) {
        set_serial(serial);
        let mut src = PngDecodeSource::new(png, w, h);
        let mut sink = Vec::new();
        let t = Instant::now();
        encode_casv_video_streaming_to(&mut src, opts, &mut sink).expect("footer stream encode");
        let dt = t.elapsed();
        set_serial(false);
        (sink, dt)
    }

    /// Header-buffered encode of the whole clip → bytes.
    fn enc_buffered(png: &[Vec<u8>], w: u32, h: u32, opts: &CasaVideoOptions, serial: bool) -> Vec<u8> {
        set_serial(serial);
        let mut src = PngDecodeSource::new(png, w, h);
        let out = encode_casv_video_streaming(&mut src, opts).expect("buffered stream encode");
        set_serial(false);
        out
    }

    fn min_ms<F: FnMut() -> Duration>(k: usize, mut f: F) -> f64 {
        let mut best = f64::MAX;
        for _ in 0..k {
            best = best.min(f().as_secs_f64() * 1000.0);
        }
        best
    }

    pub fn run(png_dir: &str) {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);

        let mut paths: Vec<PathBuf> = std::fs::read_dir(png_dir)
            .unwrap_or_else(|e| panic!("read png dir {png_dir}: {e}"))
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map_or(false, |x| x == "png"))
            .collect();
        paths.sort();
        assert!(!paths.is_empty(), "no PNG frames in {png_dir}");
        let png: Vec<Vec<u8>> = paths.iter().map(|p| std::fs::read(p).unwrap()).collect();
        let n = png.len();

        // Frame-0 dims.
        let img0 = image::load_from_memory(&png[0]).expect("decode png0").to_rgb8();
        let (w, h) = (img0.width(), img0.height());

        // Balanced default (== CasaVideoOptions::streaming(1.0)): lossy d1.0, tile skip,
        // gop 24, effort 3 — the JOLT profile the CASV streaming loop actually ships.
        let opts = CasaVideoOptions::streaming(1.0);
        let gop = opts.gop_len.max(1) as usize;
        let n_i = n.div_ceil(gop);
        let n_p = n - n_i;

        println!("machine: {cores} logical cores  (run on AC power for stable numbers)");
        println!("clip: {n} PNG frames @ {w}x{h}  (gop {gop} => I {n_i} / P {n_p})\n");

        // ===================== 1. BYTE GATE =====================
        println!("== 1. Byte-identity gate (serial vs overlapped) ==");
        let (footer_serial, _) = enc_footer(&png, w, h, &opts, true);
        let (footer_overlap, _) = enc_footer(&png, w, h, &opts, false);
        assert_eq!(
            footer_serial, footer_overlap,
            "FOOTER container: overlapped bytes differ from serial"
        );
        println!(
            "  footer   (encode_casv_video_streaming_to)   : IDENTICAL  ({} bytes)",
            footer_overlap.len()
        );
        let buf_serial = enc_buffered(&png, w, h, &opts, true);
        let buf_overlap = enc_buffered(&png, w, h, &opts, false);
        assert_eq!(
            buf_serial, buf_overlap,
            "BUFFERED container: overlapped bytes differ from serial"
        );
        println!(
            "  buffered (encode_casv_video_streaming)       : IDENTICAL  ({} bytes)",
            buf_overlap.len()
        );
        println!("  => PASS: .casv codestream is byte-identical either way\n");

        // ===================== 2. THROUGHPUT =====================
        // Warm caches / thread pools once (result discarded).
        let _ = enc_footer(&png, w, h, &opts, false);

        const K: usize = 3;
        let serial_ms = min_ms(K, || enc_footer(&png, w, h, &opts, true).1);
        let overlap_ms = min_ms(K, || enc_footer(&png, w, h, &opts, false).1);

        let fps = |ms: f64| n as f64 / (ms / 1000.0);
        println!("== 2. Throughput A/B (footer path, min of {K} runs, real per-frame PNG decode) ==");
        println!(
            "  serial     : {:7.0} ms  ({:5.1} ms/f)  {:5.1} fps",
            serial_ms,
            serial_ms / n as f64,
            fps(serial_ms)
        );
        println!(
            "  overlapped : {:7.0} ms  ({:5.1} ms/f)  {:5.1} fps",
            overlap_ms,
            overlap_ms / n as f64,
            fps(overlap_ms)
        );
        println!(
            "  => speedup {:.2}x   ({:.1} -> {:.1} fps)",
            serial_ms / overlap_ms,
            fps(serial_ms),
            fps(overlap_ms)
        );
    }
}

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    let png_dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests\real_video_ghana_1080".to_string());
    ab::run(&png_dir);
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("casv_overlap_ab requires --features jxl-codec on a native target");
}
