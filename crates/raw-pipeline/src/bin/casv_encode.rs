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
//!               <effort> <gop> <skip> <tile> <thresh|auto> <dim> [bps]
//!   rate  = lossy | lossless | auto (auto = lossy with given distance)
//!   dim   = <max_px> | exact  (scale longest edge to max_px; exact = no scale)
//!   bps   = optional target bytes/sec (lossy only): JOLT rate control plus
//!           confidence-scheduled tile admission. 0 or absent = quality-targeted
//!           encode exactly as before.
//!
//! Prints `OK <bytes> <out>` on success; exits non-zero with a message on error.

use raw_pipeline::casa_video::{
    default_thresh_for_distance, encode_casv_proxy_rgb8, encode_casv_video,
    encode_casv_video_streaming_with_audio_progress, CasaVideoOptions, RateControl, SkipMode,
    VideoFrameSource, VideoRate,
};
use raw_pipeline::jxl_casaencoder::EncodeOptions;
use raw_pipeline::raw_video::{RawVideoLook, RawVideoSource};

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

const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Whole-buffer PNG splitter — the oracle the incremental [`PngChunker`] is
/// tested against (the streaming path uses the chunker, not this).
#[cfg(test)]
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

/// First index at or after `from` where `PNG_MAGIC` begins, if any.
fn find_magic(buf: &[u8], from: usize) -> Option<usize> {
    if buf.len() < PNG_MAGIC.len() {
        return None;
    }
    (from..=buf.len() - PNG_MAGIC.len()).find(|&i| buf[i..i + PNG_MAGIC.len()] == *PNG_MAGIC)
}

/// Incremental splitter for a concatenated-PNG byte stream (ffmpeg image2pipe).
/// Fed arbitrary chunks; emits each complete PNG the moment the *next* frame's
/// signature appears (or on `finish` for the last one). Holds at most ~one frame
/// in flight, so the whole video need not be buffered. Byte-for-byte equivalent
/// to [`split_png_frames`] over the full stream — proven in the unit test — so
/// the frames handed to the encoder (and thus the `.casv`) are identical to the
/// buffered path.
struct PngChunker {
    buf: Vec<u8>,
    scan: usize,
    started: bool,
}
impl PngChunker {
    fn new() -> Self {
        PngChunker { buf: Vec::new(), scan: 0, started: false }
    }
    fn push(&mut self, bytes: &[u8], out: &mut Vec<Vec<u8>>) {
        self.buf.extend_from_slice(bytes);
        self.drain(out);
    }
    /// Flush the trailing (final) frame at end of stream.
    fn finish(&mut self, out: &mut Vec<Vec<u8>>) {
        self.drain(out);
        if self.started && self.buf.len() >= PNG_MAGIC.len() {
            out.push(std::mem::take(&mut self.buf));
        }
    }
    fn drain(&mut self, out: &mut Vec<Vec<u8>>) {
        if !self.started {
            match find_magic(&self.buf, 0) {
                Some(p) => {
                    self.buf.drain(..p);
                    self.started = true;
                    self.scan = PNG_MAGIC.len();
                }
                None => {
                    // Keep only a possible straddling prefix of the signature.
                    let keep = self.buf.len().saturating_sub(PNG_MAGIC.len() - 1);
                    self.buf.drain(..keep);
                    return;
                }
            }
        }
        loop {
            let from = self.scan.max(PNG_MAGIC.len());
            match find_magic(&self.buf, from) {
                Some(p) => {
                    out.push(self.buf[..p].to_vec());
                    self.buf.drain(..p);
                    self.scan = PNG_MAGIC.len();
                }
                None => {
                    // Resume near the tail so a signature straddling the next
                    // push is still found; never before the current frame's own.
                    self.scan = self
                        .buf
                        .len()
                        .saturating_sub(PNG_MAGIC.len() - 1)
                        .max(PNG_MAGIC.len());
                    break;
                }
            }
        }
    }
}

/// Spawn ffmpeg to emit the video as a concatenated PNG stream on stdout
/// (optionally downscaled). stderr is discarded so draining only stdout can't
/// deadlock. Same invocation the buffered extractor used.
fn spawn_ffmpeg_png(video: &str, dim: &str) -> std::process::Child {
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
    cmd.spawn().unwrap_or_else(|e| fail(format!("ffmpeg spawn failed: {e}")))
}

/// A pull `VideoFrameSource` over ffmpeg's PNG stdout: reads the pipe on demand,
/// splits frames incrementally ([`PngChunker`]) and decodes each to RGB8 — so the
/// whole video is never buffered (peak ≈ one compressed PNG + the decoded frames
/// the consumer keeps). Frame 0 is pre-pulled to report `dims()`.
struct FfmpegPngSource {
    child: std::process::Child,
    out: Option<std::process::ChildStdout>,
    chunker: PngChunker,
    ready: std::collections::VecDeque<Vec<u8>>,
    first: Option<Vec<u8>>,
    w: u32,
    h: u32,
    fps_num: u32,
    fps_den: u32,
}

impl FfmpegPngSource {
    fn spawn(video: &str, dim: &str, fps_num: u32, fps_den: u32) -> Self {
        let mut child = spawn_ffmpeg_png(video, dim);
        let out = child.stdout.take();
        let mut s = FfmpegPngSource {
            child,
            out,
            chunker: PngChunker::new(),
            ready: std::collections::VecDeque::new(),
            first: None,
            w: 0,
            h: 0,
            fps_num,
            fps_den,
        };
        // Pre-pull + decode frame 0 for dims.
        let png0 = s.pull_png().unwrap_or_else(|| fail("no frames extracted from video"));
        let img = image::load_from_memory(&png0)
            .unwrap_or_else(|e| fail(format!("decode first frame: {e}")))
            .to_rgb8();
        s.w = img.width();
        s.h = img.height();
        s.first = Some(img.into_raw());
        s
    }

    /// Next complete raw PNG, reading more of ffmpeg's stdout as needed.
    fn pull_png(&mut self) -> Option<Vec<u8>> {
        use std::io::Read;
        let mut rbuf = [0u8; 64 * 1024];
        loop {
            if let Some(p) = self.ready.pop_front() {
                return Some(p);
            }
            let Some(out) = self.out.as_mut() else {
                return None; // stream fully drained
            };
            match out.read(&mut rbuf) {
                Ok(0) => {
                    let mut done = Vec::new();
                    self.chunker.finish(&mut done);
                    self.ready.extend(done);
                    self.out = None;
                    let _ = self.child.wait();
                }
                Ok(n) => {
                    let mut done = Vec::new();
                    self.chunker.push(&rbuf[..n], &mut done);
                    self.ready.extend(done);
                }
                Err(e) => fail(format!("ffmpeg read failed: {e}")),
            }
        }
    }
}

impl VideoFrameSource for FfmpegPngSource {
    fn dims(&self) -> (u32, u32) {
        (self.w, self.h)
    }
    fn fps(&self) -> (u32, u32) {
        (self.fps_num, self.fps_den)
    }
    fn next_frame(&mut self) -> Option<Vec<u8>> {
        if let Some(f) = self.first.take() {
            return Some(f);
        }
        let png = self.pull_png()?;
        Some(decode_png_rgb(&png))
    }
}

/// Drain a source into a resident frame vector (for the all-frames-resident batch
/// tiers: proxy, lossless, skip=none), reporting per-frame decode progress.
fn drain_all(src: &mut dyn VideoFrameSource, total: usize) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    while let Some(f) = src.next_frame() {
        frames.push(f);
        progress("decode", frames.len(), total);
    }
    if frames.is_empty() {
        fail("no frames extracted from video");
    }
    frames
}

fn run_video_mode(args: &[String]) -> ! {
    // args[0] == "--video"
    // args[1] = in_video, args[2] = out_casv
    // args[3] = fps_num, args[4] = fps_den
    // args[5] = rate (lossy|lossless|auto), args[6] = distance
    // args[7] = effort, args[8] = gop
    // args[9] = skip, args[10] = tile, args[11] = thresh|auto, args[12] = dim
    // args[13] = optional target bytes/sec (0/absent = no rate control)
    if args.len() < 13 {
        fail("usage: casv_encode --video <in> <out> <fps_num> <fps_den> <rate> <d> <e> <gop> <skip> <tile> <thresh> <dim> [bps]");
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

    // Streaming ffmpeg source: frames decoded on demand from ffmpeg's PNG stdout
    // — the whole video is never buffered. ffprobe gives a best-effort frame
    // total for the progress bars.
    let probed = probe_frame_count(in_video).unwrap_or(0);
    progress("extract", 0, probed);
    let mut src = FfmpegPngSource::spawn(in_video, dim_str, fps_num.max(1), fps_den.max(1));
    let (w, h) = src.dims();

    // Full-dimensioned editor proxy: rate = "proxy2" / "proxy4". All-intra and
    // frame-parallel → every frame must be resident; drain the source.
    if let Some(factor) = args[5]
        .strip_prefix("proxy")
        .and_then(|s| s.parse::<u32>().ok())
    {
        let frames = drain_all(&mut src, probed);
        let n = frames.len();
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
    // Optional bitrate target: JOLT distance feedback + confidence-scheduled
    // tile admission (lossy only — lossless has no distance to steer).
    let bps: u32 = args.get(13).map_or(0, |s| s.parse().unwrap_or_else(|_| fail("bad bps")));
    let rate_control = (bps > 0 && !matches!(rate, VideoRate::Lossless))
        .then(|| RateControl::targeting(bps).with_tile_admission());
    let opts = CasaVideoOptions {
        rate,
        gop_len: gop.max(1),
        skip,
        tile,
        effort: effort.clamp(1, 10),
        thresh: Some(thresh.unwrap_or_else(|| default_thresh_for_distance(distance))),
        rate_control,
    };

    // The streaming encoder is lossy-REPLACE only (`stream_ctx` rejects Lossless
    // and skip=None — additive residual through VarDCT is invalid). Route those
    // modes through the batch dispatcher (all-intra / additive residual / bbox /
    // tile), which needs all frames resident and writes header format (no CSAU
    // footer → no audio yet).
    let streaming_capable =
        matches!(rate, VideoRate::Lossy(_)) && !matches!(skip, SkipMode::None);
    if !streaming_capable {
        let frames = drain_all(&mut src, probed);
        let n = frames.len();
        if ogg_bytes.is_some() {
            eprintln!(
                "casv_encode: lossless / skip=none video does not carry audio yet \
                 (CSAU lives in the streaming footer format) — encoding silent"
            );
        }
        progress("encode", 0, n);
        let refs: Vec<&[u8]> = frames.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_video(&refs, w, h, fps_num.max(1), fps_den.max(1), &opts)
            .unwrap_or_else(|e| fail(format!("encode failed: {e:?}")));
        progress("encode", n, n);
        std::fs::write(out_casv, &bytes)
            .unwrap_or_else(|e| fail(format!("write {out_casv}: {e}")));
        println!("OK {} {}", bytes.len(), out_casv);
        std::process::exit(0);
    }

    // Lossy bbox/tile: stream straight through the encoder — decode+encode fused,
    // ~2 frames resident, no PNG buffer. Frame count is unknown up front (the
    // ffprobe estimate drives the bar).
    progress("encode", 0, probed);
    let bytes = encode_casv_video_streaming_with_audio_progress(
        &mut src,
        &opts,
        ogg_bytes.as_deref(),
        &mut |done| progress("encode", done, probed),
    )
    .unwrap_or_else(|e| fail(format!("encode failed: {e:?}")));

    std::fs::write(out_casv, &bytes)
        .unwrap_or_else(|e| fail(format!("write {out_casv}: {e}")));
    println!("OK {} {}", bytes.len(), out_casv);
    std::process::exit(0);
}

/// RAW time-lapse mode: encode a sequence of RAW stills (ORF/DNG/CR2) directly into
/// a `.casv`, no ffmpeg. Frames are decoded on demand with a fixed neutral look and
/// downscaled to the target dims — peak ≈ one full-res RGB8 transient + 2 ping-pong.
///
/// ```text
/// casv_encode --raw-frames <out> <fps_num> <fps_den> <rate> <distance> <effort> \
///             <gop> <skip> <tile> <thresh|auto> <dim> <file...>
///   rate = lossy | lossless        skip = none | bbox | tile
///   dim  = <max_px> | exact        thresh = 0..255 | auto
/// ```
/// (Look is neutral in the CLI; programmatic callers pass a full `RawVideoLook` to
/// `RawVideoSource::new`.)
fn run_raw_frames_mode(args: &[String]) -> ! {
    // args[0] == "--raw-frames"; args[12..] = RAW files
    if args.len() < 13 {
        fail("usage: casv_encode --raw-frames <out> <fps_num> <fps_den> <rate> <d> <e> <gop> <skip> <tile> <thresh|auto> <dim> <file...>");
    }
    let out_casv = &args[1];
    let fps_num: u32 = args[2].parse().unwrap_or_else(|_| fail("bad fps_num"));
    let fps_den: u32 = args[3].parse().unwrap_or_else(|_| fail("bad fps_den"));
    let distance: f32 = args[5].parse().unwrap_or_else(|_| fail("bad distance"));
    let effort: u8 = args[6].parse().unwrap_or_else(|_| fail("bad effort"));
    let gop: u32 = args[7].parse().unwrap_or_else(|_| fail("bad gop"));
    let skip = match args[8].as_str() {
        "bbox" => SkipMode::Bbox,
        "tile" => SkipMode::Tile,
        "none" | "0" => SkipMode::None,
        other => fail(format!("bad skip '{other}'")),
    };
    let tile: u32 = args[9].parse().unwrap_or(32).max(8);
    let thresh: Option<u8> = if args[10] == "auto" {
        None
    } else {
        Some(args[10].parse().unwrap_or_else(|_| fail("bad thresh")))
    };
    let max_px: Option<u32> = if args[11] == "exact" {
        None
    } else {
        Some(args[11].parse().unwrap_or_else(|_| fail("bad dim (expected <max_px> | exact)")))
    };
    let files: Vec<std::path::PathBuf> = args[12..].iter().map(std::path::PathBuf::from).collect();
    if files.is_empty() {
        fail("no RAW files supplied");
    }
    let total = files.len();

    let rate = match args[4].as_str() {
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

    // Neutral look; scene-cut disabled (opt-in). Programmatic callers pass a full look.
    progress("decode", 0, total);
    let mut src = RawVideoSource::new(
        files,
        RawVideoLook::default(),
        0.0,
        fps_num.max(1),
        fps_den.max(1),
        max_px,
        None,
    )
    .unwrap_or_else(|e| fail(format!("raw source: {e}")));
    let (w, h) = src.dims();

    // Streaming lossy bbox/tile: fused decode+encode, ~2 frames + band resident.
    // Lossless / skip=none route through the batch dispatcher (all frames resident —
    // the memory win is lost for those tiers; documented).
    let streaming_capable =
        matches!(rate, VideoRate::Lossy(_)) && !matches!(skip, SkipMode::None);
    let bytes = if streaming_capable {
        progress("encode", 0, total);
        let r = encode_casv_video_streaming_with_audio_progress(
            &mut src,
            &opts,
            None,
            &mut |done| progress("encode", done, total),
        );
        // A mid-stream decode failure ends the pull early (the trait can't error);
        // surface it instead of silently truncating the video.
        if let Some(err) = src.take_error() {
            fail(format!("raw frame decode: {err}"));
        }
        r.unwrap_or_else(|e| fail(format!("encode failed: {e:?}")))
    } else {
        let frames = drain_all(&mut src, total);
        if let Some(err) = src.take_error() {
            fail(format!("raw frame decode: {err}"));
        }
        let n = frames.len();
        progress("encode", 0, n);
        let refs: Vec<&[u8]> = frames.iter().map(|v| v.as_slice()).collect();
        let b = encode_casv_video(&refs, w, h, fps_num.max(1), fps_den.max(1), &opts)
            .unwrap_or_else(|e| fail(format!("encode failed: {e:?}")));
        progress("encode", n, n);
        b
    };

    std::fs::write(out_casv, &bytes).unwrap_or_else(|e| fail(format!("write {out_casv}: {e}")));
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

    if args.first().map(|s| s.as_str()) == Some("--raw-frames") {
        run_raw_frames_mode(&args);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A concatenated-PNG stream of `frame_lens` frames; each frame = the PNG
    /// signature + a body of bytes 1..=8 (never 0x89, so bodies contain no
    /// spurious signature — matching how the real splitter treats frame data).
    fn fake_stream(frame_lens: &[usize]) -> Vec<u8> {
        let mut v = Vec::new();
        for (fi, &len) in frame_lens.iter().enumerate() {
            v.extend_from_slice(PNG_MAGIC);
            for k in 0..len {
                v.push((1 + ((k + fi) % 8)) as u8);
            }
        }
        v
    }

    fn chunk_split(stream: &[u8], chunk: usize) -> Vec<Vec<u8>> {
        let mut c = PngChunker::new();
        let mut out = Vec::new();
        let mut i = 0;
        while i < stream.len() {
            let end = (i + chunk).min(stream.len());
            c.push(&stream[i..end], &mut out);
            i = end;
        }
        c.finish(&mut out);
        out
    }

    #[test]
    fn chunker_matches_split_over_arbitrary_chunkings() {
        for frame_lens in [
            vec![20usize],
            vec![20, 5, 33, 8, 100],
            vec![9, 9, 9],
            vec![0, 50, 0, 7],
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 200],
        ] {
            let stream = fake_stream(&frame_lens);
            let want: Vec<Vec<u8>> =
                split_png_frames(&stream).iter().map(|s| s.to_vec()).collect();
            for chunk in [1usize, 2, 3, 5, 7, 8, 9, 16, 64, 1024] {
                let got = chunk_split(&stream, chunk);
                assert_eq!(got, want, "frames {frame_lens:?} chunk {chunk}");
            }
        }
    }
}
