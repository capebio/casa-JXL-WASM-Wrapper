//! RAW-timelapse frame-decode A/B: SERIAL vs PARALLEL decode of a sequence of RAW
//! stills into CASV batch-tier frames. Proves the parallel decode is byte-identical
//! to the serial decode (both the decoded RGB8 frames AND the final encoded `.casv`
//! bytes) and reports the wall-clock speedup.
//!
//! Both arms decode ALL frames fresh (no cached-frame-0 shortcut) through the SAME
//! `decode_one` primitive, so the only difference is serial vs rayon scheduling —
//! isolating the decode-parallelism win. `decode_all_parallel` is exactly what the
//! `casv_encode --raw-frames` batch tier (lossless / lossy skip=none) now uses.
//!
//! ```text
//! cargo run --release --example raw_timelapse_decode_ab -- [dir] [max_px|exact]
//!   dir     directory holding the RAW files  (default: C:\Foo\raw-converter\tests)
//!   max_px  downscale longest edge for the encode gate (default 1920; "exact" = native)
//!           NOTE: decode always runs the full-res pipeline regardless of max_px —
//!           downscale is a cheap post-step, so decode cost (the thing measured) is
//!           unaffected; a smaller max_px only keeps the lossless encode gate fast.
//! ```
//! Files are the RAW stills matching `*.CR2`/`*.cr2` in `dir`, sorted by name.

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{
        encode_casv_video, CasaVideoOptions, SkipMode, VideoFrameSource, VideoRate,
    };
    use raw_pipeline::raw_video::{RawVideoLook, RawVideoSource};
    use std::path::PathBuf;
    use std::time::Instant;

    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests".to_string());
    let max_px: Option<u32> = match std::env::args().nth(2).as_deref() {
        Some("exact") => None,
        Some(s) => Some(s.parse().expect("bad max_px")),
        None => Some(1920),
    };

    // Collect RAW files (*.CR2) in the directory, sorted by name for a stable order.
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read_dir {dir}: {e}"))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("cr2"))
        })
        .collect();
    files.sort();
    if files.is_empty() {
        panic!("no *.CR2 files found in {dir}");
    }
    let n = files.len();
    println!("RAW-timelapse decode A/B — {n} frames from {dir}");
    println!("rayon threads: {}", rayon::current_num_threads());
    for f in &files {
        println!("  {}", f.display());
    }

    let look = RawVideoLook::default();
    // One source builds the sequence + learns the target dims (decodes frame 0).
    let src = RawVideoSource::new(files.clone(), look, 0.0, 30, 1, max_px, None)
        .unwrap_or_else(|e| panic!("raw source: {e}"));
    let (w, h) = src.dims();
    println!(
        "target dims {w}x{h} (max_px {:?}); decode runs full-res pipeline regardless\n",
        max_px
    );

    // ── SERIAL decode: all frames fresh, one at a time, in order ──────────────
    let t = Instant::now();
    let serial_frames: Vec<Vec<u8>> = (0..n)
        .map(|i| src.decode_one(i).unwrap_or_else(|e| panic!("serial decode {i}: {e:?}")))
        .collect();
    let serial_ms = t.elapsed().as_secs_f64() * 1000.0;

    // ── PARALLEL decode: rayon, order-preserving (production batch path) ───────
    let t = Instant::now();
    let par_frames = src
        .decode_all_parallel(&|_| {})
        .unwrap_or_else(|e| panic!("parallel decode: {e:?}"));
    let par_ms = t.elapsed().as_secs_f64() * 1000.0;

    // ── GATE 1: decoded frames byte-identical ─────────────────────────────────
    assert_eq!(serial_frames.len(), par_frames.len(), "frame count mismatch");
    for (i, (a, b)) in serial_frames.iter().zip(&par_frames).enumerate() {
        assert_eq!(a.len(), b.len(), "frame {i}: length mismatch");
        assert!(a == b, "frame {i}: decoded bytes differ (serial vs parallel)");
    }
    println!("GATE 1 PASS: all {n} decoded frames byte-identical (serial == parallel)");

    // ── GATE 2: encoded .casv bytes byte-identical (lossless batch tier) ───────
    let opts = CasaVideoOptions {
        rate: VideoRate::Lossless,
        gop_len: 1,
        skip: SkipMode::None,
        tile: 32,
        effort: 3,
        thresh: Some(4),
        rate_control: None,
    };
    let refs_s: Vec<&[u8]> = serial_frames.iter().map(|v| v.as_slice()).collect();
    let refs_p: Vec<&[u8]> = par_frames.iter().map(|v| v.as_slice()).collect();
    let enc_s = encode_casv_video(&refs_s, w, h, 30, 1, &opts).expect("serial encode");
    let enc_p = encode_casv_video(&refs_p, w, h, 30, 1, &opts).expect("parallel encode");
    assert_eq!(enc_s.len(), enc_p.len(), "encoded length differs");
    assert!(enc_s == enc_p, "encoded .casv bytes differ (serial vs parallel decode)");
    println!(
        "GATE 2 PASS: encoded .casv byte-identical ({} bytes, lossless skip=none)",
        enc_s.len()
    );

    // ── Throughput ────────────────────────────────────────────────────────────
    let nf = n as f64;
    println!("\n── decode wall-clock ──────────────────────────────");
    println!("  serial    {serial_ms:>8.0} ms   {:>7.1} ms/frame", serial_ms / nf);
    println!("  parallel  {par_ms:>8.0} ms   {:>7.1} ms/frame", par_ms / nf);
    println!("  SPEEDUP   {:>8.2}x", serial_ms / par_ms);
    println!(
        "\nNote: {n} frames is a short pipeline (fill/drain limits the observed speedup\n\
         vs the saturated asymptote). Asymptotic ceiling ≈ per-frame-MT (~1.27x) scaled\n\
         to physical cores as independent frames saturate all lanes."
    );
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("raw_timelapse_decode_ab requires --features jxl-codec on a native target");
}
