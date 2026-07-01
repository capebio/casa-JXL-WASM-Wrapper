//! Streaming vs whole-frame JXL encode: the density + peak-memory gate for the
//! streaming-full-res-encode thread. Decodes a real photo to RGB8, then encodes it two
//! ways at MATCHED settings (sRGB, VarDCT lossy, same distance/effort):
//!   whole  = Encoder::encode_into  (JxlEncoderAddImageFrame, whole-frame float copy)
//!   stream = encode_chunked_rgb8    (JxlEncoderAddChunkedFrame + output processor)
//! Reports output SIZE (density), per-encode peak working-set RSS, encode time, and
//! PSNR vs the source (quality parity). Also decodes the streamed output to confirm it
//! is a valid, correctly-sized JXL.
//!
//!   cargo run --release --no-default-features --features jxl-codec \
//!     --example jxl_stream_encode_density -- [source.jxl] [distance] [effort]

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

fn psnr(a: &[u8], b: &[u8]) -> f64 {
    let n = a.len().min(b.len());
    if n == 0 { return 0.0; }
    let mut se = 0u64;
    for i in 0..n { let d = a[i] as i64 - b[i] as i64; se += (d * d) as u64; }
    let mse = se as f64 / n as f64;
    if mse == 0.0 { return 99.0; }
    10.0 * (255.0f64 * 255.0 / mse).log10()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let src_path = args.get(1).cloned().unwrap_or_else(|| {
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/Benchmark results/P2200619-prog-p6-q85.jxl").into()
    });
    let distance: f32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1.0);
    let effort: i64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(3);

    let jxl = match std::fs::read(&src_path) { Ok(d) => d, Err(e) => { eprintln!("read {src_path}: {e}"); return; } };
    let (rgb, w, h) = match decode_interleaved::<u8>(&jxl, 3) {
        Some(t) => t, None => { eprintln!("decode source failed"); return; }
    };
    let (w, h) = (w as usize, h as usize);
    println!("=== streaming vs whole JXL encode: {w}x{h} ({:.1} MP), d={distance} e={effort} ===\n", (w * h) as f64 / 1e6);

    // WS sampler.
    let ws_max = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let sampler = { let (m, s) = (Arc::clone(&ws_max), Arc::clone(&stop));
        std::thread::spawn(move || { while !s.load(Ordering::Relaxed) { m.fetch_max(winmem::ws(), Ordering::Relaxed); std::thread::sleep(Duration::from_millis(2)); } }) };

    let reps = 3;
    println!("{:<8} {:>9} {:>8} {:>10} {:>7}", "mode", "size_KB", "ms", "peakRSS_MB", "PSNR");

    let mut whole_size = 0usize;
    let mut stream_size = 0usize;
    for mode in ["whole", "stream"] {
        ws_max.store(winmem::ws(), Ordering::Relaxed);
        let base = winmem::ws();
        let mut out = Vec::new();
        let mut ms = 0.0f64;
        for _ in 0..reps {
            let t = Instant::now();
            out = if mode == "whole" {
                let mut enc = Encoder::with_threads(EncodeOptions::distance(distance).with_effort(effort as u8), 1).expect("enc");
                let mut o = Vec::new();
                enc.encode_into(&Frame::rgb(&rgb, w as u32, h as u32), &mut o).expect("whole encode");
                o
            } else {
                encode_chunked_rgb8(&rgb, w as u32, h as u32, distance, effort).expect("stream encode")
            };
            ms += t.elapsed().as_secs_f64() * 1e3;
        }
        ms /= reps as f64;
        let peak = (ws_max.load(Ordering::Relaxed).saturating_sub(base)) as f64 / 1_048_576.0;

        // validate + PSNR vs source
        let p = match decode_interleaved::<u8>(&out, 3) {
            Some((dec, dw, dh)) if dw as usize == w && dh as usize == h => psnr(&dec, &rgb),
            Some((_, dw, dh)) => { println!("  {mode}: WARNING decoded {dw}x{dh} != {w}x{h}"); -1.0 }
            None => { println!("  {mode}: WARNING output did not decode"); -1.0 }
        };
        println!("{:<8} {:>9.1} {:>8.0} {:>10.0} {:>7.2}", mode, out.len() as f64 / 1024.0, ms, peak, p);
        if mode == "whole" { whole_size = out.len(); } else { stream_size = out.len(); }
    }
    stop.store(true, Ordering::Relaxed);
    let _ = sampler.join();

    if whole_size > 0 && stream_size > 0 {
        let d = (stream_size as f64 - whole_size as f64) / whole_size as f64 * 100.0;
        println!("\ndensity: stream is {:+.2}% vs whole ({} vs {} bytes)", d, stream_size, whole_size);
    }
}
