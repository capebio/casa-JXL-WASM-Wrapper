//! Byte-exact gate + timing for the exact-dims path of `RawVideoSource`
//! (Task 1.4: move-not-copy the decoded frame into `buf`).
//!
//! Two independent SHA-256 digests over the ADH CR2 time-lapse at NATIVE dims:
//!   * FRAMES_SHA — the concatenated RGB8 frame bytes handed to the encoder,
//!     pulled straight through `next_frame_into` (batch take-ownership pull).
//!     This is encoder-INDEPENDENT: it proves the frame bytes are identical
//!     before vs after the edit regardless of any encode non-determinism.
//!   * CASV_SHA — the full `.casv` from `encode_casv_from_raws` at the lossless
//!     `skip=none` tier (the tier that exercises the exact-dims batch path).
//!
//! Usage: `cargo run --release --example raw_video_exact_sha -- [dir]`
//! `dir` defaults to `C:\Foo\raw-converter\tests` and globs `ADH *.CR2` sorted.

use std::path::PathBuf;
use std::time::Instant;

use raw_pipeline::casa_video::{CasaVideoOptions, SkipMode, VideoError, VideoRate};
use raw_pipeline::raw_video::{encode_casv_from_raws, RawVideoLook, RawVideoSource};
use sha2::{Digest, Sha256};

use raw_pipeline::casa_video::VideoFrameSource;

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn adh_files(dir: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read_dir {dir}: {e}"))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            name.starts_with("ADH ") && name.to_ascii_uppercase().ends_with(".CR2")
        })
        .collect();
    v.sort();
    v
}

fn lossless_none_opts() -> CasaVideoOptions {
    CasaVideoOptions {
        rate: VideoRate::Lossless,
        gop_len: 24,
        skip: SkipMode::None,
        tile: 32,
        effort: 3,
        thresh: None,
        rate_control: None,
    }
}

fn main() -> Result<(), VideoError> {
    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests".to_string());
    let files = adh_files(&dir);
    assert!(!files.is_empty(), "no `ADH *.CR2` files under {dir}");
    println!("files: {} under {dir}", files.len());
    for f in &files {
        println!("  {}", f.display());
    }

    // ---- FRAMES pass: hash the bytes handed to the encoder (encoder-independent).
    let t_frames = Instant::now();
    let mut src = RawVideoSource::new(
        files.clone(),
        RawVideoLook::default(),
        0.0,
        24,
        1,
        None, // native / exact dims -> exact-dims branch
        None,
    )?;
    let (dw, dh) = src.dims();
    let mut hasher = Sha256::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut total: u64 = 0;
    let mut n = 0usize;
    while src.next_frame_into(&mut buf) {
        hasher.update(&buf);
        total += buf.len() as u64;
        n += 1;
        buf = Vec::new(); // mimic the batch take-ownership pull (frames.push(take(buf)))
    }
    if let Some(e) = src.take_error() {
        panic!("frame pull error: {e}");
    }
    let frames_sha = hex(&hasher.finalize());
    let frames_ms = t_frames.elapsed().as_secs_f64() * 1e3;
    println!("dims: {dw}x{dh}  frames: {n}  frame_bytes: {total}");
    println!("FRAMES_SHA  {frames_sha}");
    println!("frames_pull_ms  {frames_ms:.1}");

    // ---- CASV pass: hash the full .casv (lossless skip=none, exact dims).
    let opts = lossless_none_opts();
    let t_casv = Instant::now();
    let mut sink: Vec<u8> = Vec::new();
    let wrote = encode_casv_from_raws(
        files.clone(),
        RawVideoLook::default(),
        0.0,
        24,
        1,
        None,
        None,
        &opts,
        &mut sink,
    )?;
    let casv_ms = t_casv.elapsed().as_secs_f64() * 1e3;
    assert_eq!(wrote, sink.len(), "wrote count != sink len");
    let casv_sha = hex(&Sha256::digest(&sink));
    println!("casv_bytes: {}", sink.len());
    println!("CASV_SHA  {casv_sha}");
    println!("casv_encode_ms  {casv_ms:.1}");

    Ok(())
}
