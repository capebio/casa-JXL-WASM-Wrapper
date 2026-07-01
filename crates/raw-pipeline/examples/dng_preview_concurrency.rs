//! DNG preview batch concurrency: FULL vs STREAM, swept over worker count.
//!
//! Question: does the streaming preview memory win convert to concurrency headroom?
//! FULL  = decode_bytes -> full MHC demosaic -> box-downscale to previews (high peak:
//!         full raw + full-res RGB per worker).
//! STREAM= build_previews_streaming via DngRowSource (low peak: one tile-band + tiny).
//!
//! For each worker count N and each mode we run `reps` decodes (N threads pull from a
//! shared counter) and report throughput + PER-RUN peak working-set RSS (a background
//! sampler tracks max current WS, reset before each run, so peaks don't bleed across
//! runs). Prediction: STREAM's peak RSS stays ~flat as N grows and it keeps scaling to
//! core count; FULL's peak RSS grows ~N× and throughput plateaus/thrashes earlier.
//!
//! Build WITHOUT `parallel` so file-concurrency is the ONLY parallelism (1 worker =
//! 1 core of work), matching orf_jxl_batch_concurrent's methodology:
//!   cargo run --release --no-default-features --example dng_preview_concurrency -- <file.dng> [reps]

use raw_pipeline::{demosaic, dng, stream_preview};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(windows)]
mod winmem {
    #[repr(C)]
    struct Pmc {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged: usize,
        quota_paged: usize,
        quota_peak_nonpaged: usize,
        quota_nonpaged: usize,
        pagefile: usize,
        peak_pagefile: usize,
    }
    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(p: isize, c: *mut Pmc, cb: u32) -> i32;
    }
    /// current working-set bytes
    pub fn working_set() -> u64 {
        unsafe {
            let mut c: Pmc = core::mem::zeroed();
            c.cb = core::mem::size_of::<Pmc>() as u32;
            if K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) != 0 {
                c.working_set_size as u64
            } else {
                0
            }
        }
    }
}
#[cfg(not(windows))]
mod winmem {
    pub fn working_set() -> u64 { 0 }
}

/// Verbatim box-downscale (integer + float paths) matching downscale_rgb16_impl, so the
/// FULL arm does the same preview work as STREAM. Interleaved RGB16 -> packed LE u8.
fn box_downscale(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh * 6];
    let w16 = |out: &mut [u8], o: usize, r: u16, g: u16, b: u16| {
        out[o] = r as u8; out[o + 1] = (r >> 8) as u8;
        out[o + 2] = g as u8; out[o + 3] = (g >> 8) as u8;
        out[o + 4] = b as u8; out[o + 5] = (b >> 8) as u8;
    };
    if sw % dw == 0 && sh % dh == 0 {
        let (xs, ys) = (sw / dw, sh / dh);
        let pc = (xs * ys) as u32;
        let mut o = 0;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                let mut rb = dy * ys * sw;
                for _ in 0..ys {
                    let mut i = (rb + dx * xs) * 3;
                    for _ in 0..xs { rr += src[i] as u32; gg += src[i + 1] as u32; bb += src[i + 2] as u32; i += 3; }
                    rb += sw;
                }
                w16(&mut out, o, (rr / pc) as u16, (gg / pc) as u16, (bb / pc) as u16);
                o += 6;
            }
        }
        return out;
    }
    let (xr, yr) = (sw as f32 / dw as f32, sh as f32 / dh as f32);
    let mut o = 0;
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = (((dy as f32 + 1.0) * yr).min(sh as f32) as usize).max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = (((dx as f32 + 1.0) * xr).min(sw as f32) as usize).max(x0 + 1);
            let n = ((y1 - y0) * (x1 - x0)).max(1) as u32;
            let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
            let mut rb = y0 * sw;
            for _ in y0..y1 {
                for x in x0..x1 { let i = (rb + x) * 3; rr += src[i] as u32; gg += src[i + 1] as u32; bb += src[i + 2] as u32; }
                rb += sw;
            }
            w16(&mut out, o, (rr / n) as u16, (gg / n) as u16, (bb / n) as u16);
            o += 6;
        }
    }
    out
}

fn full_preview(data: &[u8], targets: &[(usize, usize)]) -> Result<usize, String> {
    let img = dng::decode_bytes(data).map_err(|e| e.to_string())?;
    let rgb = demosaic::demosaic_bayer_mhc(&img.raw, img.width, img.height, dng::cfa_phase(img.cfa))?;
    let mut bytes = 0;
    for &(dw, dh) in targets {
        bytes += box_downscale(&rgb, img.width, img.height, dw, dh).len();
    }
    Ok(bytes)
}

fn stream_preview_fn(data: &[u8], targets: &[(usize, usize)]) -> Result<usize, String> {
    let src = dng::DngRowSource::new(data)?;
    let (w, h, phase) = (src.meta().width, src.meta().height, src.phase());
    let prev = stream_preview::build_previews_streaming(src, w, h, phase, targets)?;
    Ok(prev.iter().map(|p| p.len()).sum())
}

fn run(mode: &str, n_workers: usize, reps: usize, data: Arc<Vec<u8>>, targets: Arc<Vec<(usize, usize)>>) -> (f64, u64) {
    let next = Arc::new(AtomicUsize::new(0));
    let wall = Instant::now();
    let mut handles = Vec::new();
    for _ in 0..n_workers {
        let (next, data, targets, mode) = (Arc::clone(&next), Arc::clone(&data), Arc::clone(&targets), mode.to_string());
        handles.push(std::thread::spawn(move || loop {
            let i = next.fetch_add(1, Ordering::Relaxed);
            if i >= reps { break; }
            let r = if mode == "stream" {
                stream_preview_fn(&data, &targets)
            } else {
                full_preview(&data, &targets)
            };
            std::hint::black_box(r.expect("decode"));
        }));
    }
    for h in handles { let _ = h.join(); }
    let secs = wall.elapsed().as_secs_f64();
    (reps as f64 / secs, 0) // peak filled by caller via sampler
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let file = args.get(1).cloned().unwrap_or_else(||
        r"C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng".into());
    let reps: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(24).max(1);
    let data = Arc::new(match std::fs::read(&file) { Ok(d) => d, Err(e) => { eprintln!("read {file}: {e}"); return; } });

    // Preview targets sized from the image (both modes produce the same output dims).
    let (w, h) = { let s = dng::DngRowSource::new(&data).expect("parse"); (s.meta().width, s.meta().height) };
    let targets = Arc::new(vec![(w / 4, h / 4), (w / 12, h / 12)]);
    let cores = std::thread::available_parallelism().map(|x| x.get()).unwrap_or(8);

    // Background WS sampler: tracks max current working-set; reset per run.
    let ws_max = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let sampler = {
        let (ws_max, stop) = (Arc::clone(&ws_max), Arc::clone(&stop));
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                ws_max.fetch_max(winmem::working_set(), Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(3));
            }
        })
    };

    let ns: Vec<usize> = [1usize, 2, 4, cores, cores * 2].into_iter().filter(|&n| n >= 1).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    println!("=== DNG preview concurrency: {w}x{h}, {reps} decodes/run, {cores} cores ===");
    println!("(build --no-default-features so N threads = the only parallelism)\n");
    println!("{:<8} {:>4}  {:>10}  {:>10}", "mode", "N", "dec/s", "peakRSS_MB");
    for mode in ["full", "stream"] {
        for &n in &ns {
            ws_max.store(winmem::working_set(), Ordering::Relaxed); // reset to current baseline
            let (tput, _) = run(mode, n, reps, Arc::clone(&data), Arc::clone(&targets));
            let peak = ws_max.load(Ordering::Relaxed) as f64 / 1_048_576.0;
            println!("{:<8} {:>4}  {:>10.1}  {:>10.0}", mode, n, tput, peak);
        }
        println!();
    }
    stop.store(true, Ordering::Relaxed);
    let _ = sampler.join();
}
