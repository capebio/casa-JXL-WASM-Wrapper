//! ae6_peak_probe — peak-RSS + interleaved wall-time A/B for routing full-res tier
//! encodes through the chunked encoder (AE-6).
//!
//! Two production-shaped arms on a real DNG-derived RGB8 (byte-equality is proven
//! separately by chunked_vs_whole_ab; this probe measures memory + time only):
//!   variants full tier: d = distance_from_quality(90) = 1.0, e3, single-threaded
//!   pyramid full-res:   d = 0.55, e3, num_threads = cores (post-barrier)
//!
//! Interleaved (flipflop) scheduling: whole/chunked alternate per iteration with
//! start rotation, medians reported — sequential all-OLD-then-all-NEW is banned for
//! <10% deltas per house rules.
//!
//!   cargo run --release --example ae6_peak_probe [iters]

use raw_pipeline::jxl_casaencoder::{
    distance_from_quality, encode_chunked_threaded, EncodeOptions, Encoder, Frame, Rate,
    WholeImageSource,
};
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

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let iters: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(7);
    let dng_path = r"C:\Foo\raw-converter\tests\PXL_20260527_180319603.RAW-02.ORIGINAL.dng";
    let data = std::fs::read(dng_path).expect("fixture DNG");
    let img = raw_pipeline::dng::decode_bytes(&data).expect("dng decode");
    let phase = match img.cfa {
        raw_pipeline::dng::Cfa::Rggb => (0, 0),
        raw_pipeline::dng::Cfa::Grbg => (0, 1),
        raw_pipeline::dng::Cfa::Gbrg => (1, 0),
        raw_pipeline::dng::Cfa::Bggr => (1, 1),
    };
    let rgb16 = raw_pipeline::demosaic::demosaic_bayer_mhc(&img.raw, img.width, img.height, phase)
        .expect("demosaic");
    let mut p = raw_pipeline::pipeline::PipelineParams::default_olympus();
    p.black = img.black;
    p.white = img.white;
    p.wb_r = img.wb_r;
    p.wb_b = img.wb_b;
    p.color_matrix = img.color_matrix;
    let rgb = raw_pipeline::pipeline::process_rgb(&rgb16, &p);
    drop(rgb16);
    let (w, h) = (img.width, img.height);
    println!("=== AE-6 probe: {w}x{h} ({:.1} MP), iters={iters} ===", (w * h) as f64 / 1e6);

    let ws_max = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let sampler = {
        let (m, s) = (Arc::clone(&ws_max), Arc::clone(&stop));
        std::thread::spawn(move || {
            while !s.load(Ordering::Relaxed) {
                m.fetch_max(winmem::ws(), Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(2));
            }
        })
    };

    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let arms: &[(&str, f32, usize)] = &[
        ("variants_full_q90_st", distance_from_quality(90.0), 1),
        ("pyramid_full_d055_mt", 0.55, cores),
    ];

    for (arm, dist, threads) in arms {
        let mut ms_whole = Vec::new();
        let mut ms_chunk = Vec::new();
        let mut peak_whole: f64 = 0.0;
        let mut peak_chunk: f64 = 0.0;
        for i in 0..iters {
            // start rotation: alternate which mode goes first each iteration
            let order: [&str; 2] = if i % 2 == 0 { ["whole", "chunk"] } else { ["chunk", "whole"] };
            for mode in order {
                let base = winmem::ws();
                ws_max.store(base, Ordering::Relaxed);
                let t = Instant::now();
                let out = if mode == "whole" {
                    let opts = EncodeOptions { rate: Rate::Distance(*dist), ..Default::default() }
                        .with_effort(3);
                    let mut enc = Encoder::with_threads(opts, *threads).unwrap();
                    enc.encode(&Frame::rgb(&rgb, w as u32, h as u32)).unwrap()
                } else {
                    let mut o = Vec::new();
                    encode_chunked_threaded(
                        w as u32, h as u32, *dist, 3, *threads,
                        &mut WholeImageSource { data: &rgb, width: w }, &mut o,
                    )
                    .unwrap();
                    o
                };
                let ms = t.elapsed().as_secs_f64() * 1e3;
                std::hint::black_box(&out);
                let peak = (ws_max.load(Ordering::Relaxed).saturating_sub(base)) as f64 / 1_048_576.0;
                if mode == "whole" {
                    ms_whole.push(ms);
                    peak_whole = peak_whole.max(peak);
                } else {
                    ms_chunk.push(ms);
                    peak_chunk = peak_chunk.max(peak);
                }
            }
        }
        println!(
            "{arm}: whole med {:.0} ms / peak +{:.0} MB   chunked med {:.0} ms / peak +{:.0} MB   (dMs {:+.1}%, dPeak {:+.0} MB)",
            median(ms_whole.clone()), peak_whole,
            median(ms_chunk.clone()), peak_chunk,
            (median(ms_chunk) - median(ms_whole.clone())) / median(ms_whole) * 100.0,
            peak_chunk - peak_whole,
        );
    }
    stop.store(true, Ordering::Relaxed);
    let _ = sampler.join();
}
