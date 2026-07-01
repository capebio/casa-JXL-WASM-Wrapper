//! CasaVideo throughput benchmark.
//!
//! Encodes + decodes a real frame sequence through the `casa_video` container at
//! several effort/rate points and reports per-frame encode/decode ms and fps vs
//! the 24fps budget (41.7 ms/frame). Decode is the real-time streaming
//! constraint; encode is offline. Single-threaded per frame (GOP parallelism
//! would multiply throughput by core count — noted, not exercised here).
//!
//! Run (MSVC, release for realistic timing), from `crates/raw-pipeline`:
//!   ..\..\build-msvc.ps1 run --release --example casv_bench --features jxl-codec -- <frames_dir>
//! Default frames_dir = the extracted Ghana dashcam frames.

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{decode_casv_frame_rgb8, encode_casv_rgb8};
    use raw_pipeline::jxl_casaencoder::EncodeOptions;
    use std::time::Instant;

    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests\real_video_ghana".to_string());

    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .expect("read frames dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map_or(false, |x| x == "png"))
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
    let refs: Vec<&[u8]> = frames.iter().map(|v| v.as_slice()).collect();
    let mp = (w as f64 * h as f64) / 1e6;

    println!(
        "CasaVideo bench: {n} frames @ {w}x{h} ({mp:.2} MP), single-thread, all-intra (arch A)"
    );
    println!("24fps budget = 41.7 ms/frame; decode = real-time constraint\n");
    println!(
        "{:<16} {:>9} {:>10} {:>10} {:>9} {:>9}  {}",
        "config", "size MB", "enc ms/f", "dec ms/f", "enc fps", "dec fps", "24fps decode?"
    );

    let configs: Vec<(&str, EncodeOptions)> = vec![
        ("lossless e1", EncodeOptions::lossless().with_effort(1)),
        ("lossless e3", EncodeOptions::lossless().with_effort(3)),
        ("lossless e7", EncodeOptions::lossless().with_effort(7)),
        ("lossy d1 e3", EncodeOptions::distance(1.0).with_effort(3)),
        ("lossy d1 e7", EncodeOptions::distance(1.0).with_effort(7)),
    ];

    for (label, opts) in configs {
        let t0 = Instant::now();
        let casv = encode_casv_rgb8(&refs, w, h, 24, 1, opts).expect("encode");
        let enc = t0.elapsed().as_secs_f64() * 1000.0 / n as f64;

        let t1 = Instant::now();
        for i in 0..n {
            let _ = decode_casv_frame_rgb8(&casv, i).expect("decode");
        }
        let dec = t1.elapsed().as_secs_f64() * 1000.0 / n as f64;

        let mb = casv.len() as f64 / (1024.0 * 1024.0);
        println!(
            "{:<16} {:>9.2} {:>10.1} {:>10.1} {:>9.1} {:>9.1}  {}",
            label,
            mb,
            enc,
            dec,
            1000.0 / enc,
            1000.0 / dec,
            if dec <= 41.7 { "OK" } else { "OVER" }
        );
    }
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("casv_bench requires --features jxl-codec on a native target");
}
