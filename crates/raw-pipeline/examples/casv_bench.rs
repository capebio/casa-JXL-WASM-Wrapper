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
    use raw_pipeline::casa_video::{
        decode_casv_all_rgb8, encode_casv_delta_bbox_rgb8, encode_casv_delta_rgb8,
        encode_casv_delta_tiled_rgb8, encode_casv_rgb8,
    };
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
        "CasaVideo encoder comparison: {n} frames @ {w}x{h} ({mp:.2} MP), single-thread, lossless e3"
    );
    println!("(decode = sequential playback via decode_casv_all_rgb8; 24fps budget 41.7 ms/frame)\n");
    println!(
        "{:<16} {:>9} {:>10} {:>10} {:>10} {:>9}  {}",
        "encoder", "size MB", "vs intra", "enc ms/f", "dec ms/f", "dec fps", "24fps?"
    );

    let gop = 24u32;
    let tile = 32u32;
    let o = || EncodeOptions::lossless().with_effort(3);
    let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.0 / n as f64;

    let t = Instant::now();
    let intra = encode_casv_rgb8(&refs, w, h, 24, 1, o()).expect("intra");
    let e_intra = ms(t);
    let t = Instant::now();
    let delta = encode_casv_delta_rgb8(&refs, w, h, 24, 1, gop, o()).expect("delta");
    let e_delta = ms(t);
    let t = Instant::now();
    let bbox = encode_casv_delta_bbox_rgb8(&refs, w, h, 24, 1, gop, o()).expect("bbox");
    let e_bbox = ms(t);
    let t = Instant::now();
    let tiled = encode_casv_delta_tiled_rgb8(&refs, w, h, 24, 1, gop, tile, o()).expect("tile");
    let e_tile = ms(t);

    let intra_sz = intra.len() as f64;
    let show = |label: String, casv: &[u8], enc: f64| {
        let t = Instant::now();
        let frames = decode_casv_all_rgb8(casv).expect("decode");
        let dec = ms(t);
        assert_eq!(frames.len(), n);
        println!(
            "{:<16} {:>9.2} {:>+9.1}% {:>10.1} {:>10.1} {:>9.1}  {}",
            label,
            casv.len() as f64 / 1048576.0,
            (casv.len() as f64 / intra_sz - 1.0) * 100.0,
            enc,
            dec,
            1000.0 / dec,
            if dec <= 41.7 { "OK" } else { "OVER" }
        );
    };
    show("intra".into(), &intra, e_intra);
    show(format!("delta g{gop}"), &delta, e_delta);
    show(format!("bbox g{gop}"), &bbox, e_bbox);
    show(format!("tile g{gop} t{tile}"), &tiled, e_tile);
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("casv_bench requires --features jxl-codec on a native target");
}
