//! Lossless (modular) streaming vs whole-frame: the density/peak/round-trip gate for
//! streaming *lossless* JXL encode. Decodes a real photo to RGB8, then encodes it two ways
//! at MATCHED lossless settings:
//!   whole  = Encoder(EncodeOptions::lossless())  (JxlEncoderSetFrameLossless, whole frame)
//!   stream = encode_chunked_rgb8(.., distance=0) (SetFrameLossless via chunked input)
//! Reports SIZE (density), per-encode peak RSS, time, and verifies BOTH decode back to the
//! EXACT source (true lossless). Answers: does streaming stay byte-exact + low-density-cost
//! for lossless/modular, so archival exports can also stream?
//!
//!   cargo run --release --no-default-features --features jxl-codec \
//!     --example jxl_lossless_stream_density -- [source.jxl] [effort]

use raw_pipeline::jxl_casadecoder::decode_interleaved;
use raw_pipeline::jxl_casaencoder::{encode_chunked_rgb8, EncodeOptions, Encoder, Frame};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(windows)]
mod winmem {
    #[repr(C)]
    struct Pmc { cb: u32, pfc: u32, peak_ws: usize, ws: usize, qpp: usize, qp: usize, qpn: usize, qn: usize, pf: usize, ppf: usize }
    extern "system" { fn GetCurrentProcess() -> isize; fn K32GetProcessMemoryInfo(p: isize, c: *mut Pmc, cb: u32) -> i32; }
    pub fn ws() -> u64 { unsafe { let mut c: Pmc = core::mem::zeroed(); c.cb = core::mem::size_of::<Pmc>() as u32;
        if K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) != 0 { c.ws as u64 } else { 0 } } }
}
#[cfg(not(windows))]
mod winmem { pub fn ws() -> u64 { 0 } }

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let src_path = args.get(1).cloned().unwrap_or_else(||
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/Benchmark results/P2200619-prog-p6-q85.jxl").into());
    let effort: u8 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(2);

    let jxl = match std::fs::read(&src_path) { Ok(d) => d, Err(e) => { eprintln!("read {src_path}: {e}"); return; } };
    let (rgb, w, h) = match decode_interleaved::<u8>(&jxl, 3) { Some(t) => t, None => { eprintln!("decode source failed"); return; } };
    let (w, h) = (w as usize, h as usize);
    println!("=== LOSSLESS streaming vs whole: {w}x{h} ({:.1} MP), effort={effort} ===\n", (w * h) as f64 / 1e6);

    let ws_max = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let sampler = { let (m, s) = (Arc::clone(&ws_max), Arc::clone(&stop));
        std::thread::spawn(move || { while !s.load(Ordering::Relaxed) { m.fetch_max(winmem::ws(), Ordering::Relaxed); std::thread::sleep(Duration::from_millis(2)); } }) };

    println!("{:<8} {:>10} {:>8} {:>10} {:>12}", "mode", "size_KB", "ms", "peakRSS_MB", "roundtrip");
    let mut whole_size = 0usize; let mut stream_size = 0usize;
    for mode in ["whole", "stream"] {
        let base = winmem::ws(); ws_max.store(base, Ordering::Relaxed);
        let t = Instant::now();
        let out = if mode == "whole" {
            let mut enc = Encoder::with_threads(EncodeOptions::lossless().with_effort(effort), 1).expect("enc");
            let mut o = Vec::new();
            enc.encode_into(&Frame::rgb(&rgb, w as u32, h as u32), &mut o).expect("whole lossless");
            o
        } else {
            encode_chunked_rgb8(&rgb, w as u32, h as u32, 0.0, effort as i64).expect("stream lossless")
        };
        let ms = t.elapsed().as_secs_f64() * 1e3;
        let peak = (ws_max.load(Ordering::Relaxed).saturating_sub(base)) as f64 / 1_048_576.0;
        // lossless round-trip: decoded output must EQUAL the source exactly.
        let rt = match decode_interleaved::<u8>(&out, 3) {
            Some((dec, dw, dh)) if dw as usize == w && dh as usize == h => if dec == rgb { "EXACT" } else { "LOSSY!" },
            _ => "DECODE-FAIL",
        };
        println!("{:<8} {:>10.1} {:>8.0} {:>10.0} {:>12}", mode, out.len() as f64 / 1024.0, ms, peak, rt);
        if mode == "whole" { whole_size = out.len(); } else { stream_size = out.len(); }
    }
    stop.store(true, Ordering::Relaxed); let _ = sampler.join();
    if whole_size > 0 && stream_size > 0 {
        println!("\ndensity: stream is {:+.2}% vs whole ({} vs {} bytes)",
            (stream_size as f64 - whole_size as f64) / whole_size as f64 * 100.0, stream_size, whole_size);
    }
}
