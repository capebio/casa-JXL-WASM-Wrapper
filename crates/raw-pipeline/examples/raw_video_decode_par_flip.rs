//! raw_video_decode_par_flip — interleaved A/B of the RAW-timelapse batch decode:
//! **serial** per-frame drain vs **rayon parallel** whole-sequence decode
//! (`decode_all_parallel`, the strategy now wired into both the `casv_encode
//! --raw-frames` CLI and the `encode_casv_from_raws` library batch tier).
//!
//! Keeps flip_native's discipline: two variants of one op run interleaved with
//! per-round start-rotation (thermal/turbo drift hits both arms equally), round 0
//! is a discarded warmup, headline = warm median, `%saved` vs the serial baseline,
//! `trust` from the coefficient of variation. Byte-identity of the two arms is
//! asserted once per frame-count (independent decodes → same result set in file
//! order). Sweeps a set of frame counts so the parallel-scaling curve is visible
//! (each RAW decode is ALREADY rayon-parallel internally, so frame-level
//! parallelism stacks on top of a busy pool — the speedup saturates below the raw
//! thread count, which is the honest, useful result).
//!
//! Path-gated to the local ORF corpus; a no-op (exit 0) where the files are absent
//! (CI). The 2 real stills are repeated to N to exercise pool scaling — decode cost
//! per frame is the full sensor-res demosaic+tone regardless of the downscale.
//!
//! Run: cargo run -p raw-pipeline --release --example raw_video_decode_par_flip
//!      [-- <frames>...]        (default sweep: 4 8 16)

#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]

use raw_pipeline::casa_video::VideoFrameSource; // brings dims() into scope
use raw_pipeline::raw_video::{RawVideoLook, RawVideoSource};
use std::path::PathBuf;
use std::time::Instant;

const CORPUS_ORF: [&str; 2] = [
    "C:/995/2026-02-20 Gobabeb To Windhoek/P2200474.ORF",
    "C:/995/2026-02-20 Gobabeb To Windhoek/P2200475 Kissenia capensis.ORF",
];
const MAX_PX: Option<u32> = Some(1600); // downscale target (decode cost is ~full regardless)
const ROUNDS: usize = 7; // warm interleaved rounds per frame-count (plus 1 discarded warmup)

fn corpus_base() -> Option<Vec<PathBuf>> {
    let base: Vec<PathBuf> = CORPUS_ORF.iter().map(PathBuf::from).collect();
    base.iter().all(|p| p.exists()).then_some(base)
}

/// Serial baseline: decode every frame one at a time (mirror of the old
/// `next_frame_into` drain — each RAW is an independent `decode_one`).
fn serial(src: &RawVideoSource) -> Vec<Vec<u8>> {
    (0..src.len())
        .map(|i| src.decode_one(i).expect("serial decode"))
        .collect()
}

fn median(v: &mut [f64]) -> (f64, f64) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let m = v[v.len() / 2];
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    let sd = (v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / v.len() as f64).sqrt();
    (m, sd)
}

/// One frame-count point: builds a source over `frames` repeats of the 2 stills,
/// proves serial==parallel byte-identity, then interleaved-times both arms.
fn run_point(base: &[PathBuf], frames: usize) {
    let files: Vec<PathBuf> = (0..frames).map(|i| base[i % base.len()].clone()).collect();
    let src = RawVideoSource::new(files, RawVideoLook::default(), 0.0, 24, 1, MAX_PX, None)
        .expect("build RawVideoSource");
    let (w, h) = src.dims();

    // Byte-identity guard (once): serial drain == parallel decode.
    let a = serial(&src);
    let b = src.decode_all_parallel(&|_| {}).expect("parallel decode");
    assert_eq!(a.len(), b.len(), "frame count differs");
    assert!(a == b, "parallel decode is NOT byte-identical to serial drain");

    let mut t_serial: Vec<f64> = Vec::new();
    let mut t_par: Vec<f64> = Vec::new();
    for r in 0..=ROUNDS {
        for slot in 0..2 {
            let i = (slot + r) % 2; // start-rotation
            let t = Instant::now();
            if i == 0 {
                std::hint::black_box(serial(&src));
            } else {
                std::hint::black_box(src.decode_all_parallel(&|_| {}).unwrap());
            }
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            if r > 0 {
                if i == 0 { t_serial.push(ms) } else { t_par.push(ms) }
            }
        }
    }
    let (ms_s, sd_s) = median(&mut t_serial);
    let (ms_p, sd_p) = median(&mut t_par);
    let saved = (ms_s - ms_p) / ms_s * 100.0;
    let cv_p = if ms_p > 0.0 { sd_p / ms_p } else { 1.0 };
    let trust = if cv_p < 0.10 { "high" } else { "low" };
    println!(
        "  {frames:>3} {w:>5}x{h:<5} {ms_s:>10.1} {sd_s:>7.1} {ms_p:>10.1} {sd_p:>7.1} {:>7.2}x {saved:>+6.0}%  {trust}",
        ms_s / ms_p
    );
}

fn main() {
    let Some(base) = corpus_base() else {
        eprintln!("skip raw_video_decode_par_flip: ORF corpus absent");
        return;
    };
    let frames: Vec<usize> = {
        let a: Vec<usize> = std::env::args().skip(1).filter_map(|s| s.parse().ok()).collect();
        if a.is_empty() { vec![4, 8, 16] } else { a }
    };
    let threads = rayon::current_num_threads();
    println!(
        "\n=== RAW-timelapse batch decode: serial drain vs decode_all_parallel ({threads} rayon threads) ==="
    );
    println!("  all frame-counts byte-identical serial==parallel ✓  (downscale target {:?})", MAX_PX);
    println!(
        "  {:>3} {:>11} {:>10} {:>7} {:>10} {:>7} {:>8} {:>6}  {}",
        "N", "dims", "serial ms", "stdev", "par ms", "stdev", "speedup", "saved", "trust"
    );
    for &f in &frames {
        run_point(&base, f);
    }
    println!("\n  (serial re-decodes every frame through decode_one; parallel = rayon par_iter,");
    println!("   order-preserving → byte-identical. Each frame's own demosaic/tone is already MT.)");
}
