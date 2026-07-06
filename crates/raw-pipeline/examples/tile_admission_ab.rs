//! tile_admission_ab — real-footage A/B of confidence-scheduled tile admission.
//!
//! Extracts `seconds` of a video via ffmpeg (rgb24 pipe, scaled to `max_px`
//! longest edge), then encodes the same frames through multiple passes:
//!
//!   fixed    — lossy d=1.0, tile skip, no rate control (measures content rate)
//!   quality  — JOLT Quality preset (d=0.5, e=4), no rate control
//!   rc       — JOLT distance-only rate control at `target_frac` × fixed rate
//!   admit    — same target, plus confidence-scheduled tile admission
//!   lossless — FableBraid (braided-rANS) lossless at 480px / 5 s
//!
//! Prints per-pass totals, rate adherence (average and worst 1-second window),
//! per-frame peaks, tiles-per-P-frame, decode quality vs source, wall time.
//!
//! With a 5th arg, writes a demo directory containing:
//!   source_15s.mp4   — ffmpeg clip of the source
//!   pass_*.mp4       — each pass decoded and re-encoded as H.264 for browser
//!   orig_vs_rc.mp4   — legacy side-by-side composite (original | rc)
//!   rc_vs_admit.mp4  — legacy side-by-side composite (rc | admit)
//!   stats.json       — compression metrics for the HTML info panel
//!   index.html       — NOT overwritten (edit separately; loads stats.json)
//!
//! Usage: tile_admission_ab <video> [seconds=15] [max_px=960] [target_frac=0.35] [demo_dir]

use raw_pipeline::casa_video::{
    casv_frame_info, casv_frame_is_tile, casv_frame_slice, decode_casv_all_rgb8,
    encode_casv_video_streaming, parse_casv_header, CasaVideoOptions, JoltPreset,
    VideoFrameSource,
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
        fail("usage: tile_admission_ab <video> [seconds=15] [max_px=960] [target_frac=0.35] [demo_dir]");
    }
    let video = &args[1];
    let seconds: f64 = args.get(2).map_or(15.0, |s| s.parse().unwrap_or(15.0));
    let max_px: u32 = args.get(3).map_or(960, |s| s.parse().unwrap_or(960));
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
        "clip: {video}\n  {w}x{h} @ {}/{} fps, {} frames ({secs:.1} s)",
        fps.0,
        fps.1,
        frames.len()
    );

    let mut base_opts = CasaVideoOptions::streaming(1.0);
    base_opts.gop_len = 30;

    // Pass 1: fixed quality (d=1.0 balanced, no RC) — measures natural content rate.
    let (fixed_out, fixed) = run_pass("fixed", &frames, w, h, fps, &base_opts, secs);
    let target = (fixed.bytes_per_sec * target_frac) as u32;
    println!(
        "  fixed rate {:.0} B/s -> JOLT target {} B/s ({:.0}%)\n",
        fixed.bytes_per_sec,
        target,
        target_frac * 100.0,
    );

    // Pass 2: JOLT Quality preset (d=0.5, e=4) — visually transparent, no RC.
    let quality_opts = CasaVideoOptions::jolt(JoltPreset::Quality);
    let (quality_out, quality) = run_pass("quality", &frames, w, h, fps, &quality_opts, secs);

    // Pass 3: distance-only JOLT RC.
    let mut rc_opts = CasaVideoOptions::streaming_bitrate(1.0, target);
    rc_opts.gop_len = 30;
    let (rc_out, rc) = run_pass("rc", &frames, w, h, fps, &rc_opts, secs);

    // Pass 4: JOLT + confidence-scheduled tile admission.
    let mut adm_opts = CasaVideoOptions::streaming_bitrate_admitted(1.0, target);
    adm_opts.gop_len = 30;
    let (adm_out, adm) = run_pass("admit", &frames, w, h, fps, &adm_opts, secs);

    // Pass 5: FableBraid lossless — small clip & dim to keep file size manageable.
    let ll_max_px = 480u32;
    let ll_scale = (ll_max_px as f64 / sw.max(sh) as f64).min(1.0);
    let (ll_w, ll_h) = (((sw as f64 * ll_scale) as u32) & !1, ((sh as f64 * ll_scale) as u32) & !1);
    let ll_secs = seconds.min(5.0);
    let ll_want = (ll_secs * fps.0 as f64 / fps.1 as f64).round() as usize;
    let mut ll_child = std::process::Command::new("ffmpeg")
        .args(["-v","error","-t",&format!("{ll_secs}"),"-i",video,
               "-vf",&format!("scale={ll_w}:{ll_h}"),"-f","rawvideo","-pix_fmt","rgb24","pipe:1"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap_or_else(|e| fail(format!("ffmpeg lossless extract: {e}")));
    let ll_frame_bytes = (ll_w * ll_h * 3) as usize;
    let mut ll_stdout = ll_child.stdout.take().unwrap();
    let mut ll_frames: Vec<Vec<u8>> = Vec::with_capacity(ll_want);
    loop {
        let mut buf = vec![0u8; ll_frame_bytes];
        let mut got = 0;
        while got < ll_frame_bytes {
            match ll_stdout.read(&mut buf[got..]) {
                Ok(0) => break,
                Ok(k) => got += k,
                Err(e) => fail(format!("lossless pipe: {e}")),
            }
        }
        if got < ll_frame_bytes { break; }
        ll_frames.push(buf);
    }
    let _ = ll_child.wait();
    let ll_secs_actual = ll_frames.len() as f64 * fps.1 as f64 / fps.0 as f64;
    let ll_opts = CasaVideoOptions::lossless_archive();
    let (lossless_out, lossless) = run_pass("lossless", &ll_frames, ll_w, ll_h, fps, &ll_opts, ll_secs_actual);

    let all_passes: &[(&str, &PassStats)] = &[
        ("fixed",   &fixed),
        ("quality", &quality),
        ("rc",      &rc),
        ("admit",   &adm),
        ("lossless",&lossless),
    ];

    println!(
        "{:<8} {:>9} {:>9} {:>7} {:>10} {:>7} {:>9} {:>6} {:>9} {:>8}",
        "pass", "bytes", "B/s", "vs tgt", "worst-1s", "vs tgt", "worst-Pf", "tiles", "skip-fr", "wall-ms"
    );
    for (_, s) in all_passes {
        let is_rc = s.label == "rc" || s.label == "admit";
        let vs = if !is_rc { "-".to_string() } else { format!("{:.2}×", s.bytes_per_sec / target as f64) };
        let wvs = if !is_rc { "-".to_string() } else { format!("{:.2}×", s.worst_window_bps / target as f64) };
        println!(
            "{:<8} {:>9} {:>9.0} {:>7} {:>10.0} {:>7} {:>9} {:>6.1} {:>9} {:>8}",
            s.label, s.total, s.bytes_per_sec, vs, s.worst_window_bps, wvs,
            s.worst_pframe, s.avg_tiles, s.skip_frames, s.wall_ms
        );
    }
    println!("\nquality (mean |diff| vs source):");
    for (_, s) in all_passes { println!("  {:<8} {:.2}", s.label, s.mean_diff); }

    if let Some(dir) = args.get(5) {
        write_demo(
            dir, video, &frames, &fixed_out, &quality_out, &rc_out, &adm_out,
            &lossless_out, &ll_frames, w, h, ll_w, ll_h, fps, target, secs,
            &fixed, &quality, &rc, &adm, &lossless,
        );
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

/// Decode one CASV stream and write its frames as an H.264 MP4 for browser playback.
fn write_to_mp4(path: &str, casv: &[u8], w: u32, h: u32, fps: (u32, u32)) {
    use std::io::Write;
    let dec = decode_casv_all_rgb8(casv).unwrap_or_else(|| fail(format!("decode for {path}")));
    let mut child = std::process::Command::new("ffmpeg")
        .args([
            "-v", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", &format!("{w}x{h}"),
            "-r", &format!("{}/{}", fps.0, fps.1),
            "-i", "pipe:0",
            "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            path,
        ])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| fail(format!("ffmpeg {path}: {e}")));
    let mut stdin = child.stdin.take().unwrap();
    for f in &dec {
        stdin.write_all(&f.0).unwrap_or_else(|e| fail(format!("ffmpeg write: {e}")));
    }
    drop(stdin);
    child.wait().unwrap_or_else(|e| fail(format!("ffmpeg wait: {e}")));
    println!("  wrote {path} ({} frames)", dec.len());
}

/// Write source clip (first `secs` s) as H.264 MP4 via ffmpeg stream copy.
fn write_source_clip(dir: &str, video: &str, secs: f64) {
    let path = format!("{dir}/source_15s.mp4");
    let status = std::process::Command::new("ffmpeg")
        .args([
            "-v", "error", "-y",
            "-t", &format!("{secs}"),
            "-i", video,
            "-c:v", "libx264", "-crf", "15", "-preset", "fast",
            "-c:a", "aac", "-b:a", "64k",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            &path,
        ])
        .status()
        .unwrap_or_else(|e| fail(format!("ffmpeg source clip: {e}")));
    if !status.success() { fail("ffmpeg source clip failed"); }
    println!("  wrote {path}");
}

/// Serialise one pass's stats as a JSON object fragment (no outer braces).
fn pass_json(s: &PassStats, target: u32) -> String {
    let bps = s.bytes_per_sec;
    let kbps = bps * 8.0 / 1000.0;
    let mb = s.total as f64 / 1_048_576.0;
    let vs = if target > 0 { bps / target as f64 } else { 0.0 };
    let wvs = if target > 0 { s.worst_window_bps / target as f64 } else { 0.0 };
    format!(
        r#"{{"brKbps":{kbps:.0},"sizeMB":{mb:.2},"wallMs":{wall},"meanDiff":{md:.3},"worstWin":{wvs:.3},"vsTarget":{vs:.3},"avgTiles":{at:.2}}}"#,
        kbps = kbps, mb = mb, wall = s.wall_ms, md = s.mean_diff,
        wvs = wvs, vs = vs, at = s.avg_tiles,
    )
}

/// All pass outputs + info → demo directory.
#[allow(clippy::too_many_arguments)]
fn write_demo(
    dir: &str,
    video: &str,
    src_frames: &[Vec<u8>],
    fixed_out: &[u8],
    quality_out: &[u8],
    rc_out: &[u8],
    adm_out: &[u8],
    lossless_out: &[u8],
    ll_frames: &[Vec<u8>],
    w: u32,
    h: u32,
    ll_w: u32,
    ll_h: u32,
    fps: (u32, u32),
    target: u32,
    secs: f64,
    fixed: &PassStats,
    quality: &PassStats,
    rc: &PassStats,
    adm: &PassStats,
    lossless: &PassStats,
) {
    std::fs::create_dir_all(dir).unwrap_or_else(|e| fail(format!("mkdir {dir}: {e}")));
    println!("\nwriting demo to {dir}/");

    // Source clip (stream-copy, fast)
    write_source_clip(dir, video, secs);

    // Individual pass MP4s
    write_to_mp4(&format!("{dir}/pass_fixed.mp4"),   fixed_out,   w,    h,    fps);
    write_to_mp4(&format!("{dir}/pass_quality.mp4"), quality_out, w,    h,    fps);
    write_to_mp4(&format!("{dir}/pass_jolt_rc.mp4"), rc_out,      w,    h,    fps);
    write_to_mp4(&format!("{dir}/pass_jolt_admit.mp4"), adm_out,  w,    h,    fps);
    write_to_mp4(&format!("{dir}/pass_lossless.mp4"), lossless_out, ll_w, ll_h, fps);

    // Legacy side-by-side composites (kept for backward compat)
    let rc_dec  = decode_casv_all_rgb8(rc_out).unwrap_or_else(|| fail("decode rc"));
    let adm_dec = decode_casv_all_rgb8(adm_out).unwrap_or_else(|| fail("decode admit"));
    let src: Vec<&[u8]> = src_frames.iter().map(|f| f.as_slice()).collect();
    let rcf: Vec<&[u8]>  = rc_dec.iter().map(|f| f.0.as_slice()).collect();
    let admf: Vec<&[u8]> = adm_dec.iter().map(|f| f.0.as_slice()).collect();
    println!("  writing orig_vs_rc.mp4");
    mux_side_by_side(&format!("{dir}/orig_vs_rc.mp4"), &src, &rcf, w, h, fps);
    println!("  writing rc_vs_admit.mp4");
    mux_side_by_side(&format!("{dir}/rc_vs_admit.mp4"), &rcf, &admf, w, h, fps);

    // stats.json — loaded by index.html for real numbers in the info panel
    let _ll_secs = ll_frames.len() as f64 * fps.1 as f64 / fps.0 as f64;
    let ll_mb   = lossless_out.len() as f64 / 1_048_576.0;
    let stats_json = format!(
        r#"{{
  "clip": {{"width":{w},"height":{h},"fps_num":{fpn},"fps_den":{fpd},"seconds":{secs:.1},"target_bps":{target}}},
  "passes": {{
    "pass_fixed":   {fixed_j},
    "pass_quality": {qual_j},
    "pass_jolt_rc": {rc_j},
    "pass_jolt_admit": {adm_j},
    "pass_lossless": {{"brKbps":{ll_kbps:.0},"sizeMB":{ll_mb:.2},"wallMs":{ll_wall},"meanDiff":{ll_md:.3},"worstWin":null,"vsTarget":null,"avgTiles":{ll_at:.2}}}
  }}
}}"#,
        w = w, h = h, fpn = fps.0, fpd = fps.1,
        fixed_j  = pass_json(fixed,   0),
        qual_j   = pass_json(quality, 0),
        rc_j     = pass_json(rc,      target),
        adm_j    = pass_json(adm,     target),
        ll_kbps  = lossless.bytes_per_sec * 8.0 / 1000.0,
        ll_mb    = ll_mb,
        ll_wall  = lossless.wall_ms,
        ll_md    = lossless.mean_diff,
        ll_at    = lossless.avg_tiles,
    );
    let stats_path = format!("{dir}/stats.json");
    std::fs::write(&stats_path, stats_json).unwrap_or_else(|e| fail(format!("write stats.json: {e}")));
    println!("  wrote {stats_path}");
    println!("\nDemo ready — open {dir}/index.html in a browser.");
}
