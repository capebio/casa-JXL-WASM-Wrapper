//! CASV tier benchmark on a real frame sequence: the three JOLT lossy presets
//! (streaming footer encode — the production shape), the JXL lossless archive
//! tier, and the FableBraid lossless tier. Reports size, encode ms/frame, and
//! two decode shapes per tier: batch (GOP-parallel where available) and
//! sequential playback (for_each, MT inner decode for the JXL tiers).
//!
//! Run (MSVC, release), from `crates/raw-pipeline`:
//!   ..\..\build-msvc.ps1 run --release --example tier_bench --features jxl-codec,parallel -- <frames_dir> [gop]
//!
//! `frames_dir` holds numbered PNG frames; `gop` defaults to 24.

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{
        decode_casv_all_rgb8, decode_casv_footer_all_rgb8, decode_casv_footer_for_each_rgb8_threaded,
        decode_casv_for_each_rgb8_threaded, encode_casv_fable_rgb8, encode_casv_video,
        jolt_encode_stream_to, CasaVideoOptions, JoltPreset, VideoFrameSource,
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

    let dir = std::env::args().nth(1).expect("usage: tier_bench <frames_dir> [gop]");
    let gop: u32 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(24);
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);

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
        "CASV tier benchmark: {n} frames @ {w}x{h}  raw {raw_mb:.1} MB  gop {gop}  {threads} threads  (24fps budget 41.7 ms/f)\n"
    );
    println!(
        "{:<18} {:>8} {:>7} {:>9} {:>12} {:>8} {:>12} {:>8}",
        "tier", "size MB", "vs raw", "enc ms/f", "batch ms/f", "fps", "seq-MT ms/f", "fps"
    );

    enum Tier {
        Jolt(JoltPreset),
        Archive,
        Fable,
    }

    let mut run = |label: &str, tier: Tier| {
        let refs: Vec<&[u8]> = frames.iter().map(|v| v.as_slice()).collect();
        let t0 = Instant::now();
        let bytes = match &tier {
            Tier::Jolt(p) => {
                let mut src = VecFrames { frames: frames.clone(), i: 0, w, h };
                let mut sink: Vec<u8> = Vec::new();
                jolt_encode_stream_to(&mut src, *p, &mut sink).unwrap();
                sink
            }
            Tier::Archive => {
                let mut o = CasaVideoOptions::lossless_archive();
                o.gop_len = gop;
                encode_casv_video(&refs, w, h, 24, 1, &o).unwrap()
            }
            Tier::Fable => encode_casv_fable_rgb8(&refs, w, h, 24, 1, gop).unwrap(),
        };
        let enc_ms = t0.elapsed().as_secs_f64() * 1000.0 / n as f64;

        // Batch decode (GOP-parallel on the JXL tiers, serial chain on fable).
        let t1 = Instant::now();
        let decoded = match &tier {
            Tier::Jolt(_) => decode_casv_footer_all_rgb8(&bytes).unwrap(),
            _ => decode_casv_all_rgb8(&bytes).unwrap(),
        };
        let batch_ms = t1.elapsed().as_secs_f64() * 1000.0 / n as f64;
        assert_eq!(decoded.len(), n);
        if !matches!(tier, Tier::Jolt(_)) {
            for (i, (px, _, _)) in decoded.iter().enumerate() {
                assert_eq!(px, &frames[i], "lossless tier must roundtrip frame {i}");
            }
        }
        drop(decoded);

        // Sequential playback shape: for_each, MT inner decode on JXL tiers.
        let t2 = Instant::now();
        let mut seen = 0usize;
        match &tier {
            Tier::Jolt(_) => {
                decode_casv_footer_for_each_rgb8_threaded(&bytes, threads, |_, _, _, _| seen += 1)
                    .unwrap();
            }
            Tier::Archive => {
                decode_casv_for_each_rgb8_threaded(&bytes, threads, |_, _, _, _| seen += 1)
                    .unwrap();
            }
            Tier::Fable => {
                // Fable batch path IS the sequential shape (session-carried
                // planar state; plane-parallel inside the frame).
                seen = decode_casv_all_rgb8(&bytes).unwrap().len();
            }
        }
        let seq_ms = t2.elapsed().as_secs_f64() * 1000.0 / n as f64;
        assert_eq!(seen, n);

        let size_mb = bytes.len() as f64 / 1e6;
        println!(
            "{:<18} {:>8.2} {:>6.1}% {:>9.1} {:>12.1} {:>8.0} {:>12.1} {:>8.0}",
            label,
            size_mb,
            size_mb / raw_mb * 100.0,
            enc_ms,
            batch_ms,
            1000.0 / batch_ms,
            seq_ms,
            1000.0 / seq_ms,
        );
    };

    run("JOLT Realtime", Tier::Jolt(JoltPreset::Realtime));
    run("JOLT Balanced", Tier::Jolt(JoltPreset::Balanced));
    run("JOLT Quality", Tier::Jolt(JoltPreset::Quality));
    run("archive (JXL)", Tier::Archive);
    run("fable (braid)", Tier::Fable);
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("tier_bench requires --features jxl-codec on a native target");
}
