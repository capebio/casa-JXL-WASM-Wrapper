//! Parameter sweeps for the JOLT/FableBraid paper — emits CSV on stdout.
//!
//! Modes (all take a PNG frames dir):
//!   gop <dir> <gop,gop,...> [tiers]   tiers = comma list of fable,archive,jolt (default all)
//!   threads <dir> <t,t,...>           decode thread scaling at gop 24
//!   distance <dir> <d,d,...> <effort> JOLT streaming rate ladder
//!
//! CSV: mode,tier,param,size_mb,enc_ms_f,dec_batch_ms_f,dec_seq_ms_f
//! (dec_seq = for_each MT playback shape for JXL tiers, serial session for fable;
//!  -1 = not measured for that cell)
//!
//! Run (MSVC, release), from `crates/raw-pipeline`:
//!   ..\..\build-msvc.ps1 run --release --example paper_sweeps --features jxl-codec,parallel -- <mode> <dir> ...

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{
        decode_casv_all_rgb8, decode_casv_all_rgb8_threaded, decode_casv_footer_all_rgb8,
        decode_casv_footer_for_each_rgb8_threaded, decode_casv_for_each_rgb8_threaded,
        encode_casv_fable_rgb8, encode_casv_video, encode_casv_video_streaming_to,
        CasaVideoOptions, VideoFrameSource, VideoRate,
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

    let mode = std::env::args().nth(1).expect("mode: gop|threads|distance");
    let dir = std::env::args().nth(2).expect("frames dir");

    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .expect("read frames dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "png"))
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "no PNG frames in {dir}");

    let mut frames: Vec<Vec<u8>> = Vec::new();
    let (mut w, mut h) = (0u32, 0u32);
    for p in &paths {
        let img = image::open(p).expect("open png").to_rgb8();
        w = img.width();
        h = img.height();
        frames.push(img.into_raw());
    }
    let n = frames.len();
    let nthreads = std::thread::available_parallelism()
        .map(|x| x.get())
        .unwrap_or(1);
    eprintln!("# {mode} sweep: {n} frames @ {w}x{h} from {dir}");
    println!("mode,tier,param,size_mb,enc_ms_f,dec_batch_ms_f,dec_seq_ms_f");

    fn refs(frames: &[Vec<u8>]) -> Vec<&[u8]> {
        frames.iter().map(|v| v.as_slice()).collect()
    }

    let enc_jolt = |frames: &[Vec<u8>], d: f32, e: u8, gop: u32| -> Vec<u8> {
        let mut opts = CasaVideoOptions::streaming(d);
        opts.effort = e;
        opts.rate = VideoRate::Lossy(d);
        opts.gop_len = gop;
        let mut src = VecFrames {
            frames: frames.to_vec(),
            i: 0,
            w,
            h,
        };
        let mut sink: Vec<u8> = Vec::new();
        encode_casv_video_streaming_to(&mut src, &opts, &mut sink).unwrap();
        sink
    };

    match mode.as_str() {
        "gop" => {
            let gops: Vec<u32> = std::env::args()
                .nth(3)
                .expect("gop list")
                .split(',')
                .map(|s| s.parse().unwrap())
                .collect();
            let tiers = std::env::args()
                .nth(4)
                .unwrap_or("fable,archive,jolt".into());
            for &gop in &gops {
                if tiers.contains("fable") {
                    let r = refs(&frames);
                    let t0 = Instant::now();
                    let bytes = encode_casv_fable_rgb8(&r, w, h, 24, 1, gop).unwrap();
                    let enc = t0.elapsed().as_secs_f64() * 1000.0 / n as f64;
                    let t1 = Instant::now();
                    let d = decode_casv_all_rgb8(&bytes).unwrap();
                    let dec = t1.elapsed().as_secs_f64() * 1000.0 / n as f64;
                    assert_eq!(d.len(), n);
                    println!(
                        "gop,fable,{gop},{:.3},{enc:.2},{dec:.2},-1",
                        bytes.len() as f64 / 1e6
                    );
                }
                if tiers.contains("archive") {
                    let r = refs(&frames);
                    let mut o = CasaVideoOptions::lossless_archive();
                    o.gop_len = gop;
                    let t0 = Instant::now();
                    let bytes = encode_casv_video(&r, w, h, 24, 1, &o).unwrap();
                    let enc = t0.elapsed().as_secs_f64() * 1000.0 / n as f64;
                    let t1 = Instant::now();
                    let d = decode_casv_all_rgb8(&bytes).unwrap();
                    let dec = t1.elapsed().as_secs_f64() * 1000.0 / n as f64;
                    assert_eq!(d.len(), n);
                    println!(
                        "gop,archive,{gop},{:.3},{enc:.2},{dec:.2},-1",
                        bytes.len() as f64 / 1e6
                    );
                }
                if tiers.contains("jolt") {
                    let t0 = Instant::now();
                    let bytes = enc_jolt(&frames, 2.0, 1, gop);
                    let enc = t0.elapsed().as_secs_f64() * 1000.0 / n as f64;
                    let t1 = Instant::now();
                    let d = decode_casv_footer_all_rgb8(&bytes).unwrap();
                    let dec = t1.elapsed().as_secs_f64() * 1000.0 / n as f64;
                    assert_eq!(d.len(), n);
                    println!(
                        "gop,jolt-rt,{gop},{:.3},{enc:.2},{dec:.2},-1",
                        bytes.len() as f64 / 1e6
                    );
                }
            }
        }
        "threads" => {
            let ts: Vec<usize> = std::env::args()
                .nth(3)
                .expect("thread list")
                .split(',')
                .map(|s| s.parse().unwrap())
                .collect();
            let r = refs(&frames);
            let mut o = CasaVideoOptions::lossless_archive();
            o.gop_len = 24;
            let arch = encode_casv_video(&r, w, h, 24, 1, &o).unwrap();
            let jolt = enc_jolt(&frames, 2.0, 1, 24);
            let fable = encode_casv_fable_rgb8(&r, w, h, 24, 1, 24).unwrap();
            for &t in &ts {
                let t1 = Instant::now();
                let d = decode_casv_all_rgb8_threaded(&arch, t).unwrap();
                let ms = t1.elapsed().as_secs_f64() * 1000.0 / n as f64;
                assert_eq!(d.len(), n);
                drop(d);
                let t2 = Instant::now();
                let mut seen = 0usize;
                decode_casv_for_each_rgb8_threaded(&arch, t, |_, _, _, _| seen += 1).unwrap();
                let ms2 = t2.elapsed().as_secs_f64() * 1000.0 / n as f64;
                println!("threads,archive,{t},-1,-1,{ms:.2},{ms2:.2}");
                let t3 = Instant::now();
                let mut seen2 = 0usize;
                decode_casv_footer_for_each_rgb8_threaded(&jolt, t, |_, _, _, _| seen2 += 1)
                    .unwrap();
                let ms3 = t3.elapsed().as_secs_f64() * 1000.0 / n as f64;
                println!("threads,jolt-rt,{t},-1,-1,-1,{ms3:.2}");
                assert_eq!(seen + seen2, 2 * n);
            }
            // fable: internal plane-parallel (global rayon pool), thread-invariant API
            let t4 = Instant::now();
            let d = decode_casv_all_rgb8(&fable).unwrap();
            let ms = t4.elapsed().as_secs_f64() * 1000.0 / n as f64;
            assert_eq!(d.len(), n);
            println!("threads,fable,{nthreads},-1,-1,{ms:.2},-1");
        }
        "distance" => {
            let ds: Vec<f32> = std::env::args()
                .nth(3)
                .expect("distance list")
                .split(',')
                .map(|s| s.parse().unwrap())
                .collect();
            let e: u8 = std::env::args()
                .nth(4)
                .and_then(|s| s.parse().ok())
                .unwrap_or(1);
            for &d in &ds {
                let t0 = Instant::now();
                let bytes = enc_jolt(&frames, d, e, 24);
                let enc = t0.elapsed().as_secs_f64() * 1000.0 / n as f64;
                let t1 = Instant::now();
                let dec = decode_casv_footer_all_rgb8(&bytes).unwrap();
                let ms = t1.elapsed().as_secs_f64() * 1000.0 / n as f64;
                assert_eq!(dec.len(), n);
                println!(
                    "distance,jolt-e{e},{d},{:.3},{enc:.2},{ms:.2},-1",
                    bytes.len() as f64 / 1e6
                );
            }
        }
        _ => panic!("unknown mode {mode}"),
    }
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("paper_sweeps requires --features jxl-codec on a native target");
}
