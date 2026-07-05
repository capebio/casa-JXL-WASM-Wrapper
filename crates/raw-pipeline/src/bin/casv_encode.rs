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
    default_thresh_for_distance, encode_casv_proxy_rgb8, encode_casv_video,
    encode_casv_video_streaming_with_audio_progress, CasaVideoOptions, SkipMode, VideoFrameSource,
    VideoRate,
};
use raw_pipeline::jxl_casaencoder::EncodeOptions;

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("casv_encode: {msg}");
    std::process::exit(1);
}

/// Machine-readable progress for the desktop app to relay to the lightbox UI.
///
/// One line per event on **stderr** (stdout is reserved for the final
/// `OK <bytes> <out>` result line): `CASVENC <stage> <done> <total>`.
/// `total == 0` means indeterminate (e.g. ffmpeg extract is one opaque call).
/// The Tauri `encode_casv_video` command streams these lines and re-emits each
/// as a `casv-encode-progress` event — see web/casv-lightbox/TAURI_WIRING.md.
fn progress(stage: &str, done: usize, total: usize) {
    eprintln!("CASVENC {stage} {done} {total}");
}

// ── video-mode helpers ────────────────────────────────────────────────────────

fn probe_fps(video: &str) -> (u32, u32) {
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
        Err(_) => return (30, 1),
    };
    let s = String::from_utf8_lossy(&out.stdout);
    let s = s.trim();
    if let Some((n, d)) = s.split_once('/') {
        let num = n.parse().unwrap_or(30);
        let den = d.parse().unwrap_or(1);
        (num.max(1), den.max(1))
    } else {
        (s.parse().unwrap_or(30), 1)
    }
}

/// Best-effort total frame count from the container metadata, for a determinate
/// extract bar. Fast (reads header metadata, does not decode); returns None when
/// the container doesn't record `nb_frames` (common for VFR / some webm/mkv), in
/// which case the extract bar stays indeterminate with a live count.
fn probe_frame_count(video: &str) -> Option<usize> {
    let out = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_frames",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
            video,
        ])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    s.trim().parse::<usize>().ok().filter(|&n| n > 0)
}

fn extract_png_frames(video: &str, dim: &str, total: usize) -> Vec<u8> {
    use std::io::Read;
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
    // Stream stdout instead of one opaque `output()`: count PNG signatures as
    // frames arrive so the UI shows extraction advancing (ffmpeg gives no
    // upfront frame total, so `total` stays 0 → indeterminate bar with a live
    // count). stderr is null, so draining only stdout can't deadlock.
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("casv_encode: ffmpeg failed: {e}");
            std::process::exit(1);
        }
    };
    let mut out = child.stdout.take().expect("ffmpeg stdout piped");
    let mut data: Vec<u8> = Vec::new();
    let mut buf = [0u8; 64 * 1024];
    let mut scan = 0usize; // next index to test for a signature (monotonic)
    let mut frames = 0usize;
    let mut reported = 0usize;
    loop {
        match out.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                data.extend_from_slice(&buf[..n]);
                // Advance a monotonic cursor: never rescans, and a signature
                // split across two reads is found once (cursor waits for bytes).
                while scan + PNG_MAGIC.len() <= data.len() {
                    if data[scan..scan + PNG_MAGIC.len()] == *PNG_MAGIC {
                        frames += 1;
                        scan += PNG_MAGIC.len();
                    } else {
                        scan += 1;
                    }
                }
                // Throttle stderr: report every 4th new frame. `total` from
                // ffprobe (0 if unknown → indeterminate bar with a live count).
                if frames >= reported + 4 {
                    progress("extract", frames, total);
                    reported = frames;
                }
            }
            Err(e) => {
                eprintln!("casv_encode: ffmpeg read failed: {e}");
                std::process::exit(1);
            }
        }
    }
    let _ = child.wait();
    data
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
    let mut fps_den: u32 = args[4].parse().unwrap_or_else(|_| fail("bad fps_den"));
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
        let (pn, pd) = probe_fps(in_video);
        fps_num = pn;
        fps_den = pd;
    }

    // Extract audio as Ogg/Opus. Unique per-process temp name so concurrent
    // encodes don't clobber each other's audio file.
    let audio_tmp = std::env::temp_dir().join(format!("casv_audio_tmp_{}.ogg", std::process::id()));
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
            audio_tmp.to_str().unwrap_or_else(|| fail("temp dir path not UTF-8")),
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

    // Extract video frames as a concatenated PNG stream, then split. ffprobe
    // gives a best-effort frame total for a determinate extract bar.
    let probed = probe_frame_count(in_video).unwrap_or(0);
    progress("extract", 0, probed);
    let png_data = extract_png_frames(in_video, dim_str, probed);
    let frames_png = split_png_frames(&png_data);
    if frames_png.is_empty() {
        fail("no frames extracted from video");
    }
    let n = frames_png.len();

    // Dims from the first frame (decoded once; the lazy source reuses it).
    let first_rgb = image::load_from_memory(frames_png[0])
        .unwrap_or_else(|e| fail(format!("decode first frame: {e}")))
        .to_rgb8();
    let (w, h) = (first_rgb.width(), first_rgb.height());

    // Full-dimensioned editor proxy: rate = "proxy2" / "proxy4" (any "proxy<N>").
    // All-intra, each frame stored at 1/N res but declaring full dims (self-
    // upsampling on decode) — a fast, dimension-identical, instant-random-access
    // scrub stand-in. No audio (a proxy is for editing, not playback).
    if let Some(factor) = args[5]
        .strip_prefix("proxy")
        .and_then(|s| s.parse::<u32>().ok())
    {
        // Proxy is all-intra and frame-parallel, so every frame must be resident
        // (unlike the lazy streaming path below). Decode them all up front.
        let mut frames: Vec<Vec<u8>> = Vec::with_capacity(n);
        for (i, png) in frames_png.iter().enumerate() {
            frames.push(decode_png_rgb(png));
            progress("decode", i + 1, n);
        }
        progress("encode", 0, n);
        let refs: Vec<&[u8]> = frames.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_proxy_rgb8(
            &refs,
            w,
            h,
            fps_num.max(1),
            fps_den.max(1),
            factor.max(1),
            EncodeOptions::distance(distance).with_effort(effort.clamp(1, 10)),
        )
        .unwrap_or_else(|e| fail(format!("proxy encode failed: {e:?}")));
        progress("encode", n, n);
        std::fs::write(out_casv, &bytes)
            .unwrap_or_else(|e| fail(format!("write {out_casv}: {e}")));
        println!("OK {} {}", bytes.len(), out_casv);
        std::process::exit(0);
    }

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

    // Lazy frame source: decode each PNG on demand and drop it, so peak memory
    // is ~2 decoded frames (encoder ping-pong) + the compressed PNG buffer,
    // instead of every decoded RGB frame resident at once. The streaming encoder
    // pulls frames one at a time; decode+encode are fused per frame.
    struct LazyPngSource<'a> {
        pngs: &'a [&'a [u8]],
        first: Option<Vec<u8>>,
        i: usize,
        w: u32,
        h: u32,
        fps_num: u32,
        fps_den: u32,
    }
    impl VideoFrameSource for LazyPngSource<'_> {
        fn dims(&self) -> (u32, u32) {
            (self.w, self.h)
        }
        fn fps(&self) -> (u32, u32) {
            (self.fps_num, self.fps_den)
        }
        fn next_frame(&mut self) -> Option<Vec<u8>> {
            if self.i >= self.pngs.len() {
                return None;
            }
            let rgb = if self.i == 0 {
                self.first
                    .take()
                    .unwrap_or_else(|| decode_png_rgb(self.pngs[0]))
            } else {
                decode_png_rgb(self.pngs[self.i])
            };
            self.i += 1;
            Some(rgb)
        }
    }

    let mut src = LazyPngSource {
        pngs: &frames_png,
        first: Some(first_rgb.into_raw()),
        i: 0,
        w,
        h,
        fps_num: fps_num.max(1),
        fps_den: fps_den.max(1),
    };

    progress("encode", 0, n);
    let bytes = encode_casv_video_streaming_with_audio_progress(
        &mut src,
        &opts,
        ogg_bytes.as_deref(),
        &mut |done| progress("encode", done, n),
    )
    .unwrap_or_else(|e| fail(format!("encode failed: {e:?}")));

    std::fs::write(out_casv, &bytes)
        .unwrap_or_else(|e| fail(format!("write {out_casv}: {e}")));
    println!("OK {} {}", bytes.len(), out_casv);
    std::process::exit(0);
}

/// Decode one PNG frame to interleaved RGB8, or exit with a message.
fn decode_png_rgb(png: &[u8]) -> Vec<u8> {
    image::load_from_memory(png)
        .unwrap_or_else(|e| fail(format!("decode png frame: {e}")))
        .to_rgb8()
        .into_raw()
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
    let n = inputs.len();
    let mut frames: Vec<Vec<u8>> = Vec::with_capacity(n);
    let (mut w, mut h) = (0u32, 0u32);
    for (i, path) in inputs.iter().enumerate() {
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
        progress("decode", i + 1, n);
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
    progress("encode", 0, n);
    let bytes = encode_casv_video(&refs, w, h, fps_num.max(1), fps_den.max(1), &opts)
        .unwrap_or_else(|e| fail(format!("encode failed: {e:?}")));
    progress("encode", n, n);
    std::fs::write(out, &bytes).unwrap_or_else(|e| fail(format!("write {out}: {e}")));
    println!("OK {} {}", bytes.len(), out);
}
