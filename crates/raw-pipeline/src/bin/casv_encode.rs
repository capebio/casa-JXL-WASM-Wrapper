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
//! Video mode:
//!   casv_encode --video <in> <out> <fps_num> <fps_den> <rate> <distance> \
//!               <effort> <gop> <skip> <tile> <thresh|auto> <dim>
//!   rate  = lossy | lossless | auto (auto = lossy with given distance)
//!   dim   = <max_px> | exact  (scale longest edge to max_px; exact = no scale)
//!
//! Prints `OK <bytes> <out>` on success; exits non-zero with a message on error.

use raw_pipeline::casa_video::{
    default_thresh_for_distance, encode_casv_video, encode_casv_video_with_audio,
    CasaVideoOptions, SkipMode, VideoRate,
};

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("casv_encode: {msg}");
    std::process::exit(1);
}

// ── video-mode helpers ────────────────────────────────────────────────────────

fn probe_fps(video: &str) -> u32 {
    let out = match std::process::Command::new("ffprobe")
        .args([
            "-v",
            "quiet",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=r_frame_rate",
            "-of",
            "csv=p=0",
            video,
        ])
        .output()
    {
        Ok(o) => o,
        Err(_) => return 30,
    };
    let s = String::from_utf8_lossy(&out.stdout);
    let s = s.trim();
    if let Some((n, _)) = s.split_once('/') {
        n.parse().unwrap_or(30)
    } else {
        s.parse().unwrap_or(30)
    }
}

fn extract_png_frames(video: &str, dim: &str) -> Vec<u8> {
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(["-i", video]);
    if dim != "exact" {
        if let Ok(n) = dim.parse::<u32>() {
            if n > 0 {
                cmd.args([
                    "-vf",
                    &format!(
                        "scale={n}:{n}:force_original_aspect_ratio=decrease,\
                         scale=trunc(iw/2)*2:trunc(ih/2)*2"
                    ),
                ]);
            }
        }
    }
    cmd.args(["-f", "image2pipe", "-vcodec", "png", "pipe:1"]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    match cmd.output() {
        Ok(o) => o.stdout,
        Err(e) => {
            eprintln!("casv_encode: ffmpeg failed: {e}");
            std::process::exit(1);
        }
    }
}

const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

fn split_png_frames(data: &[u8]) -> Vec<&[u8]> {
    let mut starts: Vec<usize> = Vec::new();
    let mut i = 0;
    while i + PNG_MAGIC.len() <= data.len() {
        if data[i..i + PNG_MAGIC.len()] == *PNG_MAGIC {
            starts.push(i);
            i += PNG_MAGIC.len();
        } else {
            i += 1;
        }
    }
    starts
        .windows(2)
        .map(|w| &data[w[0]..w[1]])
        .chain(starts.last().map(|&s| &data[s..]))
        .collect()
}

fn run_video_mode(args: &[String]) -> ! {
    // args[0] == "--video"
    // args[1] = in_video, args[2] = out_casv
    // args[3] = fps_num, args[4] = fps_den
    // args[5] = rate (lossy|lossless|auto), args[6] = distance
    // args[7] = effort, args[8] = gop
    // args[9] = skip, args[10] = tile, args[11] = thresh|auto, args[12] = dim
    if args.len() < 13 {
        fail("usage: casv_encode --video <in> <out> <fps_num> <fps_den> <rate> <d> <e> <gop> <skip> <tile> <thresh> <dim>");
    }
    let in_video = &args[1];
    let out_casv = &args[2];
    let mut fps_num: u32 = args[3].parse().unwrap_or_else(|_| fail("bad fps_num"));
    let fps_den: u32 = args[4].parse().unwrap_or_else(|_| fail("bad fps_den"));
    let distance: f32 = args[6].parse().unwrap_or_else(|_| fail("bad distance"));
    let effort: u8 = args[7].parse().unwrap_or_else(|_| fail("bad effort"));
    let gop: u32 = args[8].parse().unwrap_or_else(|_| fail("bad gop"));
    let skip = match args[9].as_str() {
        "bbox" => SkipMode::Bbox,
        "tile" => SkipMode::Tile,
        "none" | "0" => SkipMode::None,
        other => fail(format!("bad skip '{other}'")),
    };
    let tile: u32 = args[10].parse().unwrap_or(32).max(8);
    let thresh: Option<u8> = if args[11] == "auto" {
        None
    } else {
        Some(args[11].parse().unwrap_or_else(|_| fail("bad thresh")))
    };
    let dim_str = args[12].as_str();

    if fps_num == 0 {
        fps_num = probe_fps(in_video);
    }

    // Extract audio as Ogg/Opus
    let audio_tmp = std::env::temp_dir().join("casv_audio_tmp.ogg");
    let audio_status = std::process::Command::new("ffmpeg")
        .args([
            "-i",
            in_video,
            "-vn",
            "-acodec",
            "libopus",
            "-f",
            "ogg",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-y",
            audio_tmp.to_str().unwrap(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let ogg_bytes: Option<Vec<u8>> = match audio_status {
        Ok(s) if s.success() => std::fs::read(&audio_tmp).ok(),
        _ => {
            eprintln!("casv_encode: no audio track found, producing silent .casv");
            None
        }
    };
    let _ = std::fs::remove_file(&audio_tmp);

    // Extract video frames as concatenated PNG stream, then split
    let png_data = extract_png_frames(in_video, dim_str);
    let frames_png = split_png_frames(&png_data);
    if frames_png.is_empty() {
        fail("no frames extracted from video");
    }

    // Decode PNGs to RGB8
    let first_img = image::load_from_memory(frames_png[0])
        .unwrap_or_else(|e| fail(format!("decode first frame: {e}")));
    let (w, h) = (first_img.width(), first_img.height());
    let frames: Vec<Vec<u8>> = frames_png
        .iter()
        .map(|png| {
            image::load_from_memory(png)
                .unwrap_or_else(|e| fail(format!("decode png frame: {e}")))
                .to_rgb8()
                .into_raw()
        })
        .collect();

    let rate = match args[5].as_str() {
        "lossless" => VideoRate::Lossless,
        _ => VideoRate::Lossy(distance),
    };
    let opts = CasaVideoOptions {
        rate,
        gop_len: gop.max(1),
        skip,
        tile,
        effort: effort.clamp(1, 10),
        thresh: Some(thresh.unwrap_or_else(|| default_thresh_for_distance(distance))),
        rate_control: None,
    };

    let bytes = encode_casv_video_with_audio(
        &frames,
        w,
        h,
        fps_num.max(1),
        fps_den.max(1),
        &opts,
        ogg_bytes.as_deref(),
    )
    .unwrap_or_else(|e| fail(format!("encode failed: {e:?}")));

    std::fs::write(out_casv, &bytes)
        .unwrap_or_else(|e| fail(format!("write {out_casv}: {e}")));
    println!("OK {} {}", bytes.len(), out_casv);
    std::process::exit(0);
}

// ── main ──────────────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.first().map(|s| s.as_str()) == Some("--video") {
        run_video_mode(&args);
    }

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
