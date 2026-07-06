//! ORF -> JXL concurrency SWEEP (wasm-fork stack: Casa -> jxl-ffi -> libjxl 0.11.2).
//!
//! Mirrors the Tauri batch_sweep grid so the two stacks can be compared on the
//! SAME files: a rayon file-pool of `c` workers, each encode using `t` libjxl
//! threads. Per file: read -> decode (single-thread) -> encode. effort=3,
//! distance=1.0 (== quality 90). Reports best-of-2 batch_ms + files/sec per
//! config, relative to 3x4 (the old live default).
//!
//! Run: cargo run --release --no-default-features --features jxl-codec \
//!        --example orf_jxl_sweep -- "C:\995\2026-02-20 Gobabeb To Windhoek" 24
use raw_pipeline::jxl_casaencoder::{EncodeOptions, Encoder, Frame};
use raw_pipeline::{
    decompress, demosaic,
    pipeline::{self, PipelineParams},
    tiff,
};
use rayon::prelude::*;
use std::time::Instant;

fn encode_one(path: &str, enc_threads: usize) -> usize {
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(_) => return 0,
    };
    let info = match tiff::parse(&data) {
        Ok(i) => i,
        Err(_) => return 0,
    };
    let w = info.width as usize;
    let h = info.height as usize;
    let end = info.strip_offset as usize + info.strip_byte_count as usize;
    let strip = match data.get(info.strip_offset as usize..end) {
        Some(s) => s,
        None => return 0,
    };
    let raw = match decompress::decompress(strip, w, h) {
        Ok(r) => r,
        Err(_) => return 0,
    };
    let rgb16 = match demosaic::demosaic_rggb_mhc(&raw, w, h) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    let mut p = PipelineParams::default_olympus();
    p.wb_r = info.wb_r.unwrap_or(1.797);
    p.wb_g = 1.0;
    p.wb_b = info.wb_b.unwrap_or(1.797);
    p.color_matrix = info.color_matrix.into();
    let mut rgb8 = vec![0u8; w * h * 3];
    pipeline::process_into_auto(&rgb16, &p, &mut rgb8);

    let frame = Frame::rgb(&rgb8, w as u32, h as u32);
    let opts = EncodeOptions {
        use_container: true,
        ..EncodeOptions::distance(1.0).with_effort(3)
    };
    let mut enc = match Encoder::with_threads(opts, enc_threads) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut out = Vec::with_capacity(rgb8.len() / 3);
    if enc.encode_into(&frame, &mut out).is_err() {
        return 0;
    }
    out.len()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let folder = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| r"C:\995\2026-02-20 Gobabeb To Windhoek".into());
    let n: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(24);

    let mut uniq: Vec<String> = std::fs::read_dir(&folder)
        .expect("readdir")
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("orf"))
                .unwrap_or(false)
        })
        .filter_map(|p| p.to_str().map(String::from))
        .collect();
    uniq.sort();
    assert!(!uniq.is_empty(), "no ORF in {folder}");
    let files: Vec<String> = (0..n).map(|i| uniq[i % uniq.len()].clone()).collect();

    let cores = std::thread::available_parallelism()
        .map(|x| x.get())
        .unwrap_or(12);
    println!(
        "folder={folder}  files={} (from {} unique)  logical_cores={cores}  d=1.0(=q90) effort=3",
        files.len(),
        uniq.len()
    );
    println!("stack: Casa jxl_casaencoder -> jxl-ffi -> libjxl 0.11.2\n");

    let configs: &[(usize, usize)] = &[
        (3, 4),
        (6, 2),
        (6, 1),
        (4, 3),
        (4, 1),
        (2, 6),
        (12, 1),
        (1, 6),
    ];

    let run = |conc: usize, threads: usize| -> f64 {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(conc)
            .build()
            .unwrap();
        let t = Instant::now();
        let acc: usize = pool.install(|| files.par_iter().map(|p| encode_one(p, threads)).sum());
        std::hint::black_box(acc);
        t.elapsed().as_secs_f64() * 1000.0
    };

    let _ = run(3, 4); // warm: page files in

    println!(
        "{:<14} {:>10} {:>12} {:>10}",
        "config c×t", "batch_ms", "files/sec", "vs 3×4"
    );
    let mut baseline = 0f64;
    for &(c, t) in configs {
        let m = run(c, t).min(run(c, t));
        if c == 3 && t == 4 {
            baseline = m;
        }
        let rel = if baseline > 0.0 {
            format!("{:+.0}%", (baseline - m) / baseline * 100.0)
        } else {
            "—".into()
        };
        println!(
            "{:<14} {:>10.0} {:>12.2} {:>10}",
            format!("{c}×{t}"),
            m,
            files.len() as f64 / (m / 1000.0),
            rel
        );
    }
}
