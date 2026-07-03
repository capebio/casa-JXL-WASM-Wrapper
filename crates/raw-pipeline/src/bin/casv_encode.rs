//! casv_encode — native CASAVA (.casv) encoder sidecar.
//!
//! Encodes a sequence of images into a `.casv` container via
//! `raw_pipeline::casa_video::encode_casv_video`. Built native-only (the JXL
//! codec is `jxl-codec` / not-wasm); the desktop (Tauri) app spawns this exe
//! to give the browser-hosted CASAVA lightbox a real encode + save path
//! without pulling the (identically-named, diverged) codec crate into its own
//! graph. See web/casv-lightbox/TAURI_WIRING.md.
//!
//! Usage:
//!   casv_encode <out.casv> <fps_num> <fps_den> <rate> <distance> <effort> \
//!               <gop> <skip> <tile> <thresh|auto> <img...>
//!   rate  = lossy | lossless
//!   skip  = none | bbox | tile
//!   thresh = 0..255 | auto   (auto = distance*4 clamped to 16)
//!
//! Prints `OK <bytes> <out>` on success; exits non-zero with a message on error.

use raw_pipeline::casa_video::{
    default_thresh_for_distance, encode_casv_video, CasaVideoOptions, SkipMode, VideoRate,
};

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("casv_encode: {msg}");
    std::process::exit(1);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 11 {
        fail("usage: casv_encode <out.casv> <fps_num> <fps_den> <rate> <distance> <effort> <gop> <skip> <tile> <thresh|auto> <img...>");
    }
    let out = &args[0];
    let fps_num: u32 = args[1].parse().unwrap_or_else(|_| fail("bad fps_num"));
    let fps_den: u32 = args[2].parse().unwrap_or_else(|_| fail("bad fps_den"));
    let rate_kind = args[3].as_str();
    let distance: f32 = args[4].parse().unwrap_or_else(|_| fail("bad distance"));
    let effort: u8 = args[5].parse().unwrap_or_else(|_| fail("bad effort"));
    let gop: u32 = args[6].parse().unwrap_or_else(|_| fail("bad gop"));
    let skip = match args[7].as_str() {
        "bbox" => SkipMode::Bbox,
        "tile" => SkipMode::Tile,
        "none" => SkipMode::None,
        other => fail(format!("bad skip '{other}'")),
    };
    let tile: u32 = args[8].parse().unwrap_or_else(|_| fail("bad tile"));
    let thresh: Option<u8> = if args[9] == "auto" {
        None
    } else {
        Some(args[9].parse().unwrap_or_else(|_| fail("bad thresh")))
    };
    let inputs = &args[10..];
    if inputs.is_empty() {
        fail("no input images");
    }

    // Decode every image to tightly-packed RGB8; all frames must share dims.
    let mut frames: Vec<Vec<u8>> = Vec::with_capacity(inputs.len());
    let (mut w, mut h) = (0u32, 0u32);
    for path in inputs {
        let img = image::open(path)
            .unwrap_or_else(|e| fail(format!("{path}: {e}")))
            .to_rgb8();
        let (iw, ih) = img.dimensions();
        if w == 0 {
            w = iw;
            h = ih;
        } else if iw != w || ih != h {
            fail(format!("{path}: {iw}x{ih} != {w}x{h} (all frames must match)"));
        }
        frames.push(img.into_raw());
    }

    let rate = match rate_kind {
        "lossless" => VideoRate::Lossless,
        "lossy" => VideoRate::Lossy(distance),
        other => fail(format!("bad rate '{other}'")),
    };
    let opts = CasaVideoOptions {
        rate,
        gop_len: gop.max(1),
        skip,
        tile: tile.max(8),
        effort: effort.clamp(1, 10),
        thresh: Some(thresh.unwrap_or_else(|| default_thresh_for_distance(distance))),
        rate_control: None,
    };

    let refs: Vec<&[u8]> = frames.iter().map(|f| f.as_slice()).collect();
    let bytes = encode_casv_video(&refs, w, h, fps_num.max(1), fps_den.max(1), &opts)
        .unwrap_or_else(|e| fail(format!("encode failed: {e:?}")));
    std::fs::write(out, &bytes).unwrap_or_else(|e| fail(format!("write {out}: {e}")));
    println!("OK {} {}", bytes.len(), out);
}
