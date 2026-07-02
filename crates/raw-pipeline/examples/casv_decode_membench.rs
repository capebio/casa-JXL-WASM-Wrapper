//! Peak-RSS probe: batch `decode_casv_all_rgb8` vs streaming
//! `decode_casv_for_each_rgb8` (CV-D4). A background sampler tracks max
//! working-set during each run (reset per run, same method as
//! dng_preview_concurrency). Streaming should stay ~flat (one recon buffer)
//! while batch grows ~frame_count × frame_size.
//!
//!   cargo run --release --example casv_decode_membench -- <file.casv>

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
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

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn main() {
    use raw_pipeline::casa_video::{decode_casv_all_rgb8, decode_casv_for_each_rgb8};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;

    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Tmp\jf-cvdec-golden\arch_bbox_g24.casv".to_string());
    let data = std::fs::read(&path).unwrap();
    if raw_pipeline::casa_video::parse_casv_header(&data).is_none() {
        eprintln!("{path}: not header-format (footer-indexed files use their own entry points)");
        return;
    }

    let peak = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let sampler = {
        let (peak, stop) = (peak.clone(), stop.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                peak.fetch_max(winmem::working_set(), Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        })
    };
    let run = |label: &str, f: &dyn Fn() -> (usize, u64)| {
        peak.store(winmem::working_set(), Ordering::Relaxed);
        let t = std::time::Instant::now();
        let (frames, checksum) = f();
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let pk = peak.load(Ordering::Relaxed) as f64 / 1e6;
        println!("{label:<28} {frames} frames  {ms:>8.1} ms  peak RSS {pk:>8.1} MB  fnv {checksum:016x}");
    };
    let fnv = |acc: u64, bytes: &[u8]| {
        let mut hsh = acc;
        for &b in bytes {
            hsh = (hsh ^ b as u64).wrapping_mul(0x100000001b3);
        }
        hsh
    };

    // Streaming first so the batch run's page residue can't deflate its peak.
    run("streaming for_each", &|| {
        let mut hsh = 0xcbf29ce484222325u64;
        let mut n = 0usize;
        decode_casv_for_each_rgb8(&data, |_, px, _, _| {
            hsh = fnv(hsh, px);
            n += 1;
        })
        .unwrap();
        (n, hsh)
    });
    run("batch decode_casv_all", &|| {
        let frames = decode_casv_all_rgb8(&data).unwrap();
        let mut hsh = 0xcbf29ce484222325u64;
        for (px, _, _) in &frames {
            hsh = fnv(hsh, px);
        }
        (frames.len(), hsh)
    });

    stop.store(true, Ordering::Relaxed);
    sampler.join().unwrap();
}

#[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
fn main() {
    eprintln!("casv_decode_membench requires --features jxl-codec on a native target");
}
