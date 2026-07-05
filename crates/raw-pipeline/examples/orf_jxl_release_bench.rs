//! Real ORF -> JXL batch bench (release). Streams one line per file as it is
//! processed, proves memory is released per file (live working-set / RSS), and
//! times the whole run.
//!
//! Per file: tiff::parse -> decompress -> demosaic (MHC) ->
//! pipeline::process_into_auto (tone/look) -> RGB8, then jxl_casaencoder
//! parallel encode (distance=1.0, effort=3, container). All buffers (input
//! bytes, rgb16, rgb8, jxl output) drop at end of each iteration — nothing is
//! accumulated, so peak memory ~= one file. Encoded output is measured then
//! DISCARDED (timing run). Each file is wrapped in catch_unwind so a malformed
//! RAW prints a failure and the batch continues.
//!
//! Run:
//!   cargo run --release --no-default-features --features "jxl-codec parallel" \
//!     --example orf_jxl_release_bench -- "C:\995\2026-02-20 Gobabeb To Windhoek"
//!   (optional 2nd arg = max file count; default = all)
use raw_pipeline::jxl_casaencoder::{EncodeOptions, Encoder, Frame};
use raw_pipeline::{
    decompress, demosaic,
    pipeline::{self, PipelineParams},
    tiff,
};
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

/// Live process working-set (current_MB, peak_MB) via kernel32. Proves buffers
/// are freed each iteration rather than accumulating across the batch.
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
    pub fn working_set_mb() -> (f64, f64) {
        unsafe {
            let mut c: Pmc = core::mem::zeroed();
            c.cb = core::mem::size_of::<Pmc>() as u32;
            if K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) != 0 {
                (
                    c.working_set_size as f64 / 1_048_576.0,
                    c.peak_working_set_size as f64 / 1_048_576.0,
                )
            } else {
                (0.0, 0.0)
            }
        }
    }
}
#[cfg(not(windows))]
mod winmem {
    pub fn working_set_mb() -> (f64, f64) {
        (0.0, 0.0)
    }
}

/// Full RAW -> RGB8. Returns (rgb8, w, h).
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

/// One file: decode + one parallel encode. Returns (decode_ms, enc_ms, jxl_bytes, w, h).
/// All large buffers are local and dropped on return.
fn process(data: &[u8], nthreads: usize) -> Result<(f64, f64, usize, usize, usize), String> {
    let t = Instant::now();
    let (rgb8, w, h) = decode_orf(data)?;
    let dec_ms = t.elapsed().as_secs_f64() * 1e3;

    let frame = Frame::rgb(&rgb8, w as u32, h as u32);
    let opts = EncodeOptions {
        use_container: true,
        ..EncodeOptions::distance(1.0).with_effort(3)
    };
    let mut enc =
        Encoder::with_threads(opts, nthreads).map_err(|e| format!("with_threads: {e:?}"))?;
    let mut out = Vec::with_capacity(rgb8.len() / 3);
    let t = Instant::now();
    enc.encode_into(&frame, &mut out)
        .map_err(|e| format!("encode: {e:?}"))?;
    let enc_ms = t.elapsed().as_secs_f64() * 1e3;
    Ok((dec_ms, enc_ms, out.len(), w, h))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let folder = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| r"C:\995\2026-02-20 Gobabeb To Windhoek".into());
    let nthreads = std::thread::available_parallelism()
        .map(|x| x.get())
        .unwrap_or(6);

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
    if let Some(n) = args.get(2).and_then(|s| s.parse::<usize>().ok()) {
        files.truncate(n);
    }
    let total = files.len();

    println!("=== ORF -> JXL batch (release) — {total} files — effort=3 d=1.0 container — {nthreads} threads ===");
    println!("(outputs measured then discarded; RSS = live process working set)\n");

    let (mut ok, mut fail) = (0usize, 0usize);
    let (mut sum_dec, mut sum_enc, mut sum_mp) = (0.0f64, 0.0f64, 0.0f64);
    let mut sum_bytes = 0u64;
    let mut peak_rss = 0.0f64;
    let wall = Instant::now();

    for (idx, path) in files.iter().enumerate() {
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("?");
        let short: String = name.chars().take(26).collect();
        let i = idx + 1;
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(e) => {
                println!("[{i:>3}/{total}] {short:<26} READ FAIL — {e}");
                fail += 1;
                continue;
            }
        };
        let res = std::panic::catch_unwind(|| process(&data, nthreads));
        let (rss, peak) = winmem::working_set_mb();
        if peak > peak_rss {
            peak_rss = peak;
        }
        match res {
            Ok(Ok((dec, enc, bytes, w, h))) => {
                let mp = (w * h) as f64 / 1e6;
                let ratio = (w * h * 3) as f64 / bytes as f64;
                println!(
                    "[{i:>3}/{total}] {short:<26} {mp:>4.1}MP  dec {dec:>4.0}  enc {enc:>4.0}ms  {:>5.0}KB  {ratio:>4.1}x  RSS {rss:>4.0}MB",
                    bytes as f64 / 1024.0
                );
                ok += 1;
                sum_dec += dec;
                sum_enc += enc;
                sum_mp += mp;
                sum_bytes += bytes as u64;
            }
            Ok(Err(e)) => {
                println!("[{i:>3}/{total}] {short:<26} FAIL — {e}");
                fail += 1;
            }
            Err(_) => {
                println!("[{i:>3}/{total}] {short:<26} PANIC (bug to squash)");
                fail += 1;
            }
        }
        let _ = std::io::stdout().flush();
    }

    let secs = wall.elapsed().as_secs_f64();
    let (end_rss, _) = winmem::working_set_mb();
    println!("\n=== done in {secs:.1}s — {ok} ok, {fail} fail ===");
    if ok > 0 {
        println!(
            "throughput: {:.1} files/min ({:.2}s/file) · {:.1} MP/s",
            ok as f64 / secs * 60.0,
            secs / ok as f64,
            sum_mp / secs,
        );
        println!(
            "avg/file: decode {:.0}ms · encode {:.0}ms · {:.1}MP",
            sum_dec / ok as f64,
            sum_enc / ok as f64,
            sum_mp / ok as f64,
        );
        println!(
            "total JXL (if written): {:.1} MB · avg ratio vs RGB8 {:.1}x",
            sum_bytes as f64 / 1_048_576.0,
            (sum_mp * 1e6 * 3.0) / sum_bytes as f64,
        );
    }
    println!("memory: peak working set {peak_rss:.0}MB · at-exit {end_rss:.0}MB (flat across batch = buffers freed per file)");
}
