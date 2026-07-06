//! tile_admission_ab — real-footage A/B of confidence-scheduled tile admission.
//!
//! Extracts `seconds` of a video via ffmpeg (rgb24 pipe, scaled to `max_px`
//! longest edge), then encodes the same frames three ways:
//!
//!   fixed  — lossy d=1.0, tile skip, no rate control (measures content rate)
//!   rc     — JOLT distance-only rate control at `target_frac` × fixed rate
//!   admit  — same target, plus confidence-scheduled tile admission
//!
//! Prints per-pass totals, rate adherence (average and worst 1-second window),
//! per-frame peaks, tiles-per-P-frame, decode quality vs source, wall time.
//!
//! With a 5th arg, also writes a side-by-side demo (rc | admit decoded output
//! composited into one mp4 for exact sync) plus a stats page to that directory.
//!
//! Usage: tile_admission_ab <video> [seconds=10] [max_px=640] [target_frac=0.35] [demo_dir]

use raw_pipeline::casa_video::{
    casv_frame_info, casv_frame_is_tile, casv_frame_slice, decode_casv_all_rgb8,
    encode_casv_video_streaming, parse_casv_header, CasaVideoOptions, VideoFrameSource,
};
use std::io::Read;
use std::time::Instant;

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("tile_admission_ab: {msg}");
    std::process::exit(1);
}

fn probe(video: &str, entry: &str) -> String {
    let out = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            &format!("stream={entry}"),
            "-of",
            "default=nokey=1:noprint_wrappers=1",
            video,
        ])
        .output()
        .unwrap_or_else(|e| fail(format!("ffprobe: {e}")));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

struct VecSource {
    frames: Vec<Vec<u8>>,
    i: usize,
    w: u32,
    h: u32,
    fps: (u32, u32),
}
impl VideoFrameSource for VecSource {
    fn dims(&self) -> (u32, u32) {
        (self.w, self.h)
    }
    fn fps(&self) -> (u32, u32) {
        self.fps
    }
    fn next_frame(&mut self) -> Option<Vec<u8>> {
        let f = self.frames.get(self.i).cloned();
        self.i += 1;
        f
    }
}

struct PassStats {
    label: String,
    total: usize,
    bytes_per_sec: f64,
    worst_window_bps: f64,
    worst_pframe: usize,
    avg_tiles: f64,
    skip_frames: usize,
    mean_diff: f64,
    wall_ms: u128,
}

fn run_pass(
    label: &str,
    frames: &[Vec<u8>],
    w: u32,
    h: u32,
    fps: (u32, u32),
    opts: &CasaVideoOptions,
    secs: f64,
) -> (Vec<u8>, PassStats) {
    let mut src = VecSource {
        frames: frames.to_vec(),
        i: 0,
        w,
        h,
        fps,
    };
    let t0 = Instant::now();
    let out = encode_casv_video_streaming(&mut src, opts).unwrap_or_else(|e| fail(format!("{e:?}")));
    let wall_ms = t0.elapsed().as_millis();

    let n = frames.len();
    let hdr = parse_casv_header(&out).unwrap_or_else(|| fail("bad header"));
    assert_eq!(hdr.frame_count as usize, n);
    let sizes: Vec<usize> = (0..n)
        .map(|i| casv_frame_slice(&out, i).unwrap().len())
        .collect();

    // Worst 1-second sliding window (fps frames) of payload bytes.
    let win = (fps.0 as usize / fps.1.max(1) as usize).max(1);
    let worst_window: usize = (0..n.saturating_sub(win - 1))
        .map(|i| sizes[i..i + win].iter().sum())
        .max()
        .unwrap_or(0);

    // Tile P-frame stats: set bits per bitmap; 4-byte payload = pure skip.
    let ntiles = (w.div_ceil(32) * h.div_ceil(32)) as usize;
    let mut tile_frames = 0usize;
    let mut tile_sum = 0usize;
    let mut skip_frames = 0usize;
    let mut worst_pframe = 0usize;
    for i in 0..n {
        if casv_frame_is_tile(&out, i) != Some(true) {
            continue;
        }
        worst_pframe = worst_pframe.max(sizes[i]);
        let (_, slice) = casv_frame_info(&out, i).unwrap();
        let bm = &slice[2..2 + ntiles.div_ceil(8)];
        let bits: usize = (0..ntiles).filter(|&t| bm[t / 8] & (1 << (t % 8)) != 0).count();
        tile_frames += 1;
        tile_sum += bits;
        if bits == 0 {
            skip_frames += 1;
        }
    }

    // Quality: mean abs diff of three decoded frames vs source (early/mid/last).
    let dec = decode_casv_all_rgb8(&out).unwrap_or_else(|| fail("decode failed"));
    assert_eq!(dec.len(), n);
    let mut diff_sum = 0u64;
    let mut diff_px = 0u64;
    for &i in &[n / 4, n / 2, n - 1] {
        let (d, s) = (&dec[i].0, &frames[i]);
        diff_sum += d.iter().zip(s).map(|(&a, &b)| a.abs_diff(b) as u64).sum::<u64>();
        diff_px += d.len() as u64;
    }

    let stats = PassStats {
        label: label.to_string(),
        total: out.len(),
        bytes_per_sec: out.len() as f64 / secs,
        worst_window_bps: worst_window as f64,
        worst_pframe,
        avg_tiles: tile_sum as f64 / tile_frames.max(1) as f64,
        skip_frames,
        mean_diff: diff_sum as f64 / diff_px.max(1) as f64,
        wall_ms,
    };
    (out, stats)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        fail("usage: tile_admission_ab <video> [seconds=10] [max_px=640] [target_frac=0.35]");
    }
    let video = &args[1];
    let seconds: f64 = args.get(2).map_or(10.0, |s| s.parse().unwrap_or(10.0));
    let max_px: u32 = args.get(3).map_or(640, |s| s.parse().unwrap_or(640));
    let target_frac: f64 = args.get(4).map_or(0.35, |s| s.parse().unwrap_or(0.35));

    // Probe source geometry + fps, compute even-sized scaled dims.
    let (sw, sh): (u32, u32) = (
        probe(video, "width").parse().unwrap_or_else(|_| fail("probe width")),
        probe(video, "height").parse().unwrap_or_else(|_| fail("probe height")),
    );
    let fps_str = probe(video, "r_frame_rate");
    let fps: (u32, u32) = fps_str
        .split_once('/')
        .map(|(a, b)| (a.parse().unwrap_or(30), b.parse().unwrap_or(1)))
        .unwrap_or((30, 1));
    let scale = (max_px as f64 / sw.max(sh) as f64).min(1.0);
    let (w, h) = (
        ((sw as f64 * scale) as u32) & !1,
        ((sh as f64 * scale) as u32) & !1,
    );
    let frame_bytes = (w * h * 3) as usize;
    let want = (seconds * fps.0 as f64 / fps.1 as f64).round() as usize;

    // Extract rgb24 frames straight off an ffmpeg pipe.
    let mut child = std::process::Command::new("ffmpeg")
        .args([
            "-v", "error",
            "-t", &format!("{seconds}"),
            "-i", video,
            "-vf", &format!("scale={w}:{h}"),
            "-f", "rawvideo",
            "-pix_fmt", "rgb24",
            "pipe:1",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap_or_else(|e| fail(format!("ffmpeg: {e}")));
    let mut stdout = child.stdout.take().unwrap();
    let mut frames: Vec<Vec<u8>> = Vec::with_capacity(want);
    loop {
        let mut buf = vec![0u8; frame_bytes];
        let mut got = 0;
        while got < frame_bytes {
            match stdout.read(&mut buf[got..]) {
                Ok(0) => break,
                Ok(k) => got += k,
                Err(e) => fail(format!("pipe read: {e}")),
            }
        }
        if got < frame_bytes {
            break;
        }
        frames.push(buf);
    }
    let _ = child.wait();
    if frames.len() < 30 {
        fail(format!("only {} frames extracted", frames.len()));
    }
    let secs = frames.len() as f64 * fps.1 as f64 / fps.0 as f64;
    println!(
        "clip: {video}\n  {w}x{h} @ {}/{} fps, {} frames ({secs:.1} s), gop 30, tile 32, d=1.0 e3",
        fps.0,
        fps.1,
        frames.len()
    );

    let mut base_opts = CasaVideoOptions::streaming(1.0);
    base_opts.gop_len = 30;

    // Pass 1: fixed distance — measures what the content wants to spend.
    let (_, fixed) = run_pass("fixed", &frames, w, h, fps, &base_opts, secs);
    let target = (fixed.bytes_per_sec * target_frac) as u32;
    println!(
        "  fixed rate {:.0} B/s -> starved target {} B/s ({}%)\n",
        fixed.bytes_per_sec,
        target,
        (target_frac * 100.0) as u32
    );

    // Pass 2: distance-only JOLT. Pass 3: + tile admission.
    let mut rc_opts = CasaVideoOptions::streaming_bitrate(1.0, target);
    rc_opts.gop_len = 30;
    let (rc_out, rc) = run_pass("rc", &frames, w, h, fps, &rc_opts, secs);
    let mut adm_opts = CasaVideoOptions::streaming_bitrate_admitted(1.0, target);
    adm_opts.gop_len = 30;
    let (adm_out, adm) = run_pass("admit", &frames, w, h, fps, &adm_opts, secs);

    println!(
        "{:<6} {:>9} {:>9} {:>7} {:>10} {:>7} {:>9} {:>6} {:>9} {:>8}",
        "pass", "bytes", "B/s", "vs tgt", "worst-1s", "vs tgt", "worst-Pf", "tiles", "skip-fr", "wall-ms"
    );
    for s in [&fixed, &rc, &adm] {
        let vs = if s.label == "fixed" {
            "-".to_string()
        } else {
            format!("{:.2}x", s.bytes_per_sec / target as f64)
        };
        let wvs = if s.label == "fixed" {
            "-".to_string()
        } else {
            format!("{:.2}x", s.worst_window_bps / target as f64)
        };
        println!(
            "{:<6} {:>9} {:>9.0} {:>7} {:>10.0} {:>7} {:>9} {:>6.1} {:>9} {:>8}",
            s.label,
            s.total,
            s.bytes_per_sec,
            vs,
            s.worst_window_bps,
            wvs,
            s.worst_pframe,
            s.avg_tiles,
            s.skip_frames,
            s.wall_ms
        );
    }
    println!("\nquality (mean abs diff vs source, 3 sampled frames):");
    for s in [&fixed, &rc, &adm] {
        println!("  {:<6} {:.2}", s.label, s.mean_diff);
    }

    if let Some(dir) = args.get(5) {
        write_demo(dir, &frames, &rc_out, &adm_out, w, h, fps, target, secs, &rc, &adm);
    }
}

/// Pipe `left | divider | right` composite frames into one x264 mp4 —
/// a single video keeps the halves frame-locked by construction.
fn mux_side_by_side(
    path: &str,
    left: &[&[u8]],
    right: &[&[u8]],
    w: u32,
    h: u32,
    fps: (u32, u32),
) {
    use std::io::Write;
    let (wu, hu) = (w as usize, h as usize);
    let gap = 8usize;
    let cw = wu * 2 + gap;
    let mut child = std::process::Command::new("ffmpeg")
        .args([
            "-v", "error", "-y",
            "-f", "rawvideo",
            "-pix_fmt", "rgb24",
            "-s", &format!("{cw}x{hu}"),
            "-r", &format!("{}/{}", fps.0, fps.1),
            "-i", "pipe:0",
            "-c:v", "libx264",
            "-crf", "12",
            "-pix_fmt", "yuv420p",
            path,
        ])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| fail(format!("ffmpeg mux: {e}")));
    let mut stdin = child.stdin.take().unwrap();
    let mut row = vec![0u8; cw * 3];
    for i in 0..left.len().min(right.len()) {
        let (l, r) = (left[i], right[i]);
        for y in 0..hu {
            let o = y * wu * 3;
            row[..wu * 3].copy_from_slice(&l[o..o + wu * 3]);
            row[wu * 3..(wu + gap) * 3].fill(24);
            row[(wu + gap) * 3..].copy_from_slice(&r[o..o + wu * 3]);
            stdin.write_all(&row).unwrap_or_else(|e| fail(format!("mux write: {e}")));
        }
    }
    drop(stdin);
    let status = child.wait().unwrap_or_else(|e| fail(format!("ffmpeg wait: {e}")));
    if !status.success() {
        fail("ffmpeg mux failed");
    }
}

/// Decode both streams, write two synced composites — original vs rc, and
/// rc vs admit — plus an HTML page with the run's numbers baked in.
#[allow(clippy::too_many_arguments)]
fn write_demo(
    dir: &str,
    src_frames: &[Vec<u8>],
    rc_out: &[u8],
    adm_out: &[u8],
    w: u32,
    h: u32,
    fps: (u32, u32),
    target: u32,
    secs: f64,
    rc: &PassStats,
    adm: &PassStats,
) {
    std::fs::create_dir_all(dir).unwrap_or_else(|e| fail(format!("mkdir {dir}: {e}")));
    let rc_dec = decode_casv_all_rgb8(rc_out).unwrap_or_else(|| fail("decode rc"));
    let adm_dec = decode_casv_all_rgb8(adm_out).unwrap_or_else(|| fail("decode admit"));
    let src: Vec<&[u8]> = src_frames.iter().map(|f| f.as_slice()).collect();
    let rcf: Vec<&[u8]> = rc_dec.iter().map(|f| f.0.as_slice()).collect();
    let admf: Vec<&[u8]> = adm_dec.iter().map(|f| f.0.as_slice()).collect();
    mux_side_by_side(&format!("{dir}/orig_vs_rc.mp4"), &src, &rcf, w, h, fps);
    mux_side_by_side(&format!("{dir}/rc_vs_admit.mp4"), &rcf, &admf, w, h, fps);

    let kbps = |b: f64| b * 8.0 / 1000.0;
    let html = format!(
        r#"<!doctype html>
<meta charset="utf-8">
<title>CASV tile admission — side by side</title>
<style>
  body {{ background:#111; color:#ddd; font:14px/1.5 system-ui, sans-serif;
         max-width: 1400px; margin: 24px auto; padding: 0 16px; }}
  h1 {{ font-size:18px; font-weight:600; }}
  .labels {{ display:flex; margin-bottom:6px; font-weight:600; }}
  .labels div {{ flex:1; text-align:center; }}
  .src {{ color:#7fb3e6; }} .rc {{ color:#e6a23c; }} .adm {{ color:#6fcf7c; }}
  video {{ width:100%; display:block; background:#000; }}
  table {{ border-collapse:collapse; margin-top:16px; }}
  td, th {{ padding:4px 14px; border-bottom:1px solid #333; text-align:right; }}
  th:first-child, td:first-child {{ text-align:left; }}
  .note {{ color:#999; margin-top:12px; max-width:70em; }}
</style>
<h1>JOLT rate control at {target_kbps:.0} kbit/s ({secs:.0} s clip, {w}×{h} @ {fpsn}/{fpsd} fps)</h1>
<div class="labels"><div class="src">original</div><div class="rc">distance-only (rc)</div></div>
<video src="orig_vs_rc.mp4" autoplay muted loop controls></video>
<div class="labels" style="margin-top:24px"><div class="rc">distance-only (rc)</div><div class="adm">+ tile admission</div></div>
<video src="rc_vs_admit.mp4" muted loop controls></video>
<table>
<tr><th>pass</th><th>kbit/s (avg)</th><th>vs target</th><th>worst 1-s window</th><th>tiles / P-frame</th><th>encode wall</th><th>mean |diff| vs source</th></tr>
<tr><td class="rc">distance-only</td><td>{rc_kbps:.0}</td><td>{rc_vs:.2}×</td><td>{rc_win:.2}×</td><td>{rc_tiles:.1}</td><td>{rc_ms} ms</td><td>{rc_q:.2}</td></tr>
<tr><td class="adm">tile admission</td><td>{adm_kbps:.0}</td><td>{adm_vs:.2}×</td><td>{adm_win:.2}×</td><td>{adm_tiles:.1}</td><td>{adm_ms} ms</td><td>{adm_q:.2}</td></tr>
</table>
<p class="note">Same source, same byte target. Left pays for overload in bitrate
spikes (worst-window overshoot) and uniform softening; right holds the byte
ceiling per frame by deferring the least-visible tile updates — watch for
briefly-stale regions during fast motion instead of rate spikes. Divider is
cosmetic; both halves decode from real .casv streams.</p>
"#,
        target_kbps = kbps(target as f64),
        secs = secs,
        w = w,
        h = h,
        fpsn = fps.0,
        fpsd = fps.1,
        rc_kbps = kbps(rc.bytes_per_sec),
        rc_vs = rc.bytes_per_sec / target as f64,
        rc_win = rc.worst_window_bps / target as f64,
        rc_tiles = rc.avg_tiles,
        rc_ms = rc.wall_ms,
        rc_q = rc.mean_diff,
        adm_kbps = kbps(adm.bytes_per_sec),
        adm_vs = adm.bytes_per_sec / target as f64,
        adm_win = adm.worst_window_bps / target as f64,
        adm_tiles = adm.avg_tiles,
        adm_ms = adm.wall_ms,
        adm_q = adm.mean_diff,
    );
    let page = format!("{dir}/index.html");
    std::fs::write(&page, html).unwrap_or_else(|e| fail(format!("write {page}: {e}")));
    println!("\ndemo written: {page}");
}
