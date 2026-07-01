//! JXL decode batch concurrency: full-res photo vs pyramid levels, swept over worker
//! count. Answers the scheduler question: does a "cheap" JXL decode have the memory-
//! light profile that would justify relaxing the flat concurrency cap for it (as the
//! RAW superpixel previews do)?
//!
//! NOTE: `DecodeOptions` exposes NO reduced-resolution/downsample knob — libjxl fills a
//! full-res output buffer regardless of progressive detail. So the app's cheap JXL
//! preview is decoding a small PRE-MADE pyramid level (small input -> small output),
//! not reduced-detail decoding of a big file. This bench therefore sweeps decoded
//! *size*: full photo, 2048 px level, 256 px level.
//!
//! For each (size, N) we run `reps` decodes (N threads pull from a shared counter) and
//! report throughput + per-run peak working-set RSS (background sampler, reset per run).
//!
//! Build with libjxl, WITHOUT `parallel` so N threads are the only parallelism:
//!   cargo run --release --no-default-features --features jxl-codec \
//!     --example jxl_decode_concurrency -- [reps]

use raw_pipeline::jxl_casadecoder::decode_full;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(windows)]
mod winmem {
    #[repr(C)]
    struct Pmc {
        cb: u32, page_fault_count: u32, peak_working_set_size: usize, working_set_size: usize,
        quota_peak_paged: usize, quota_paged: usize, quota_peak_nonpaged: usize, quota_nonpaged: usize,
        pagefile: usize, peak_pagefile: usize,
    }
    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(p: isize, c: *mut Pmc, cb: u32) -> i32;
    }
    pub fn working_set() -> u64 {
        unsafe {
            let mut c: Pmc = core::mem::zeroed();
            c.cb = core::mem::size_of::<Pmc>() as u32;
            if K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) != 0 { c.working_set_size as u64 } else { 0 }
        }
    }
}
#[cfg(not(windows))]
mod winmem { pub fn working_set() -> u64 { 0 } }

fn run(n_workers: usize, reps: usize, data: Arc<Vec<u8>>) -> f64 {
    let next = Arc::new(AtomicUsize::new(0));
    let wall = Instant::now();
    let mut handles = Vec::new();
    for _ in 0..n_workers {
        let (next, data) = (Arc::clone(&next), Arc::clone(&data));
        handles.push(std::thread::spawn(move || loop {
            let i = next.fetch_add(1, Ordering::Relaxed);
            if i >= reps { break; }
            // decode_full allocates the full output buffer, decodes, discards. Panics
            // are surfaced by unwrap so a bad fixture fails loudly.
            let _ = std::hint::black_box(decode_full(&data).expect("jxl decode"));
        }));
    }
    for h in handles { let _ = h.join(); }
    reps as f64 / wall.elapsed().as_secs_f64()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let reps: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(48).max(1);
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let modes: [(&str, String); 3] = [
        ("full   ", format!("{root}/docs/Benchmark results/P2200619-prog-p6-q85.jxl")),
        ("L2_2048", format!("{root}/timings/fastest/pyramid-L2-2048.jxl")),
        ("L0_256 ", format!("{root}/timings/fastest/pyramid-L0-256.jxl")),
    ];
    let cores = std::thread::available_parallelism().map(|x| x.get()).unwrap_or(8);
    let ns: Vec<usize> = [1usize, 2, 4, cores, cores * 2]
        .into_iter().collect::<std::collections::BTreeSet<_>>().into_iter().collect();

    // Background WS sampler.
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

    println!("=== JXL decode concurrency: {reps} decodes/run, {cores} cores ===");
    println!("(cheap JXL preview = decode a small pyramid level; libjxl has no reduced-res output)\n");
    println!("{:<8} {:>4}  {:>10}  {:>10}", "size", "N", "dec/s", "peakRSS_MB");
    for (label, path) in &modes {
        let data = match std::fs::read(path) {
            Ok(d) => Arc::new(d),
            Err(e) => { println!("{label}  skip: {e}"); continue; }
        };
        for &n in &ns {
            ws_max.store(winmem::working_set(), Ordering::Relaxed);
            let tput = run(n, reps, Arc::clone(&data));
            let peak = ws_max.load(Ordering::Relaxed) as f64 / 1_048_576.0;
            println!("{:<8} {:>4}  {:>10.1}  {:>10.0}", label, n, tput, peak);
        }
        println!("  ({} KB input)\n", data.len() / 1024);
    }
    stop.store(true, Ordering::Relaxed);
    let _ = sampler.join();
}
