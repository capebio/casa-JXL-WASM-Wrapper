//! Real ORF -> JXL batch bench, FILE-LEVEL CONCURRENT (release).
//!
//! N worker threads pull files from a shared index; each worker does a
//! single-thread decode + an encode using (logical_cores / N) libjxl threads,
//! so total threads ~= core count (default 6 workers x 2 enc threads = 12 on a
//! 6C/12T box — the measured optimum). Contrast with the serial harness
//! (orf_jxl_release_bench): higher throughput, but ~N x the transient memory
//! because N files are in flight at once. Outputs are measured then DISCARDED.
//!
//! Run (NO `parallel` feature — file concurrency is the parallelism):
//!   cargo run --release --no-default-features --features jxl-codec \
//!     --example orf_jxl_batch_concurrent -- "C:\995\2026-02-20 Gobabeb To Windhoek" 6
//!   (arg2 = worker count, default 6; arg3 = max files, default all)
use raw_pipeline::jxl_casaencoder::{EncodeOptions, Encoder, Frame};
use raw_pipeline::{
    decompress, demosaic,
    pipeline::{self, PipelineParams},
    tiff,
};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

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
    /// (current_working_set_bytes, peak_working_set_bytes)
    pub fn working_set() -> (u64, u64) {
        unsafe {
            let mut c: Pmc = core::mem::zeroed();
            c.cb = core::mem::size_of::<Pmc>() as u32;
            if K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) != 0 {
                (c.working_set_size as u64, c.peak_working_set_size as u64)
            } else {
                (0, 0)
            }
        }
    }
}
#[cfg(not(windows))]
mod winmem {
    pub fn working_set() -> (u64, u64) {
        (0, 0)
    }
}

fn decode_orf(data: &[u8]) -> Result<(Vec<u8>, usize, usize), String> {
    let info = tiff::parse(data).map_err(|e| format!("tiff::parse: {e}"))?;
    let w = info.width as usize;
    let h = info.height as usize;
    let end = info.strip_offset as usize + info.strip_byte_count as usize;
    let strip = data.get(info.strip_offset as usize..end).ok_or_else(|| {
        format!(
            "strip {}..{} OOB (len {})",
            info.strip_offset,
            end,
            data.len()
        )
    })?;
    let raw = decompress::decompress(strip, w, h).map_err(|e| format!("decompress: {e}"))?;
    let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).map_err(|e| format!("demosaic: {e}"))?;
    let mut p = PipelineParams::default_olympus();
    p.wb_r = info.wb_r.unwrap_or(1.797);
    p.wb_g = 1.0;
    p.wb_b = info.wb_b.unwrap_or(1.797);
    p.color_matrix = info.color_matrix;
    let mut rgb8 = vec![0u8; w * h * 3];
    pipeline::process_into_auto(&rgb16, &p, &mut rgb8);
    Ok((rgb8, w, h))
}

fn process(data: &[u8], enc_threads: usize) -> Result<(f64, f64, usize, usize, usize), String> {
    let t = Instant::now();
    let (rgb8, w, h) = decode_orf(data)?;
    let dec_ms = t.elapsed().as_secs_f64() * 1e3;
    let frame = Frame::rgb(&rgb8, w as u32, h as u32);
    let opts = EncodeOptions {
        use_container: true,
        ..EncodeOptions::distance(1.0).with_effort(3)
    };
    let mut enc =
        Encoder::with_threads(opts, enc_threads).map_err(|e| format!("with_threads: {e:?}"))?;
    let mut out = Vec::with_capacity(rgb8.len() / 3);
    let t = Instant::now();
    enc.encode_into(&frame, &mut out)
        .map_err(|e| format!("encode: {e:?}"))?;
    Ok((dec_ms, t.elapsed().as_secs_f64() * 1e3, out.len(), w, h))
}

#[derive(Default)]
struct Agg {
    ok: usize,
    fail: usize,
    sum_dec: f64,
    sum_enc: f64,
    sum_mp: f64,
    sum_bytes: u64,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let folder = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| r"C:\995\2026-02-20 Gobabeb To Windhoek".into());
    let logical = std::thread::available_parallelism()
        .map(|x| x.get())
        .unwrap_or(12);
    let workers: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(6).max(1);
    let enc_threads = (logical / workers).max(1);

    let mut files: Vec<PathBuf> = match std::fs::read_dir(&folder) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.extension()
                    .and_then(|x| x.to_str())
                    .map(|x| x.eq_ignore_ascii_case("orf"))
                    .unwrap_or(false)
            })
            .collect(),
        Err(e) => {
            eprintln!("read_dir {folder}: {e}");
            return;
        }
    };
    files.sort();
    if let Some(n) = args.get(3).and_then(|s| s.parse::<usize>().ok()) {
        files.truncate(n);
    }
    let total = files.len();

    println!("=== ORF -> JXL CONCURRENT ({workers} workers x {enc_threads} enc threads = {}) — {total} files — effort=3 d=1.0 ===", workers * enc_threads);
    println!("(outputs discarded; {workers} files in flight => ~{workers}x transient memory)\n");

    let files = Arc::new(files);
    let next = Arc::new(AtomicUsize::new(0));
    let done = Arc::new(AtomicUsize::new(0));
    let peak_rss = Arc::new(AtomicU64::new(0));
    let agg = Arc::new(Mutex::new(Agg::default()));
    let plock = Arc::new(Mutex::new(()));

    let wall = Instant::now();
    let mut handles = Vec::new();
    for _ in 0..workers {
        let files = Arc::clone(&files);
        let next = Arc::clone(&next);
        let done = Arc::clone(&done);
        let peak_rss = Arc::clone(&peak_rss);
        let agg = Arc::clone(&agg);
        let plock = Arc::clone(&plock);
        handles.push(std::thread::spawn(move || loop {
            let i = next.fetch_add(1, Ordering::Relaxed);
            if i >= files.len() {
                break;
            }
            let path = &files[i];
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("?");
            let short: String = name.chars().take(26).collect();

            let result = std::fs::read(path)
                .map_err(|e| format!("read: {e}"))
                .and_then(|data| {
                    std::panic::catch_unwind(|| process(&data, enc_threads))
                        .unwrap_or_else(|_| Err("PANIC during decode/encode".into()))
                });

            let (cur, pk) = winmem::working_set();
            peak_rss.fetch_max(pk, Ordering::Relaxed);
            let d = done.fetch_add(1, Ordering::Relaxed) + 1;

            let _g = plock.lock().unwrap();
            match result {
                Ok((dec, enc, bytes, w, h)) => {
                    let mp = (w * h) as f64 / 1e6;
                    let ratio = (w * h * 3) as f64 / bytes as f64;
                    println!(
                        "[{d:>3}/{total}] {short:<26} {mp:>4.1}MP  dec {dec:>4.0}  enc {enc:>4.0}ms  {:>5.0}KB  {ratio:>5.1}x  RSS {:>5.0}MB",
                        bytes as f64 / 1024.0,
                        cur as f64 / 1_048_576.0
                    );
                    let mut a = agg.lock().unwrap();
                    a.ok += 1;
                    a.sum_dec += dec;
                    a.sum_enc += enc;
                    a.sum_mp += mp;
                    a.sum_bytes += bytes as u64;
                }
                Err(e) => {
                    println!("[{d:>3}/{total}] {short:<26} FAIL — {e}");
                    agg.lock().unwrap().fail += 1;
                }
            }
            let _ = std::io::stdout().flush();
        }));
    }
    for h in handles {
        let _ = h.join();
    }

    let secs = wall.elapsed().as_secs_f64();
    let (end_cur, _) = winmem::working_set();
    let peak_mb = peak_rss.load(Ordering::Relaxed) as f64 / 1_048_576.0;
    let a = agg.lock().unwrap();
    println!(
        "\n=== done in {secs:.1}s — {} ok, {} fail ===",
        a.ok, a.fail
    );
    if a.ok > 0 {
        println!(
            "throughput: {:.1} files/min ({:.2}s/file wall) · {:.1} MP/s",
            a.ok as f64 / secs * 60.0,
            secs / a.ok as f64,
            a.sum_mp / secs,
        );
        println!(
            "avg/file (sum of per-file CPU, overlaps across workers): decode {:.0}ms · encode {:.0}ms",
            a.sum_dec / a.ok as f64,
            a.sum_enc / a.ok as f64,
        );
        println!(
            "total JXL (if written): {:.1} MB · avg ratio vs RGB8 {:.1}x",
            a.sum_bytes as f64 / 1_048_576.0,
            (a.sum_mp * 1e6 * 3.0) / a.sum_bytes as f64,
        );
    }
    println!(
        "memory: peak working set {peak_mb:.0}MB · at-exit {:.0}MB ({workers} files in flight)",
        end_cur as f64 / 1_048_576.0
    );
}
