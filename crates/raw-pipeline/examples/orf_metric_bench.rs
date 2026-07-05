//! orf_metric_bench — compare perceptual-approx butteraugli vs libjxl butteraugli
//! timing on real ORF files.
//!
//! Decodes each ORF to RGBA8, then for every consecutive pair (A, B):
//!   • Times raw_pipeline::perceptual::Comparer::butteraugli (our approx)
//!   • Writes RGBA8 pair to temp binary files so the caller can pipe them
//!     through bench/butter_time.exe for the libjxl full-butteraugli timing
//!
//! Output (stdout): JSON Lines, one object per pair:
//!   {"pair":"A|B","w":W,"h":H,"perc_build_ms":X,"perc_ms":Y,
//!    "ref_raw":"path","test_raw":"path"}
//!
//! Run (with parallel feature for row-parallel box_blur H-pass):
//!   cargo run -p raw-pipeline --release --features parallel \
//!     --example orf_metric_bench -- <orf1> <orf2> ...
//!
//! Reps for the timed loop can be overridden with ORF_BENCH_REPS env var (default 7).

use raw_pipeline::{
    decode_orf_rgba8,
    perceptual::{Comparer, Opts},
};
use std::{env, fs, path::Path, time::Instant};

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: orf_metric_bench <orf1> <orf2> ...");
        std::process::exit(1);
    }
    let reps: usize = env::var("ORF_BENCH_REPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(7);

    let tmp = env::temp_dir().join("orf_metric_bench");
    fs::create_dir_all(&tmp).expect("tmp dir");

    // Decode all ORFs up-front (decode time not part of the metric bench).
    eprintln!("[decode] loading {} ORF files...", args.len());
    let images: Vec<(String, Vec<u8>, u32, u32)> = args
        .iter()
        .map(|path| {
            let data = fs::read(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
            let (rgba, w, h) =
                decode_orf_rgba8(&data).unwrap_or_else(|e| panic!("decode {path}: {e}"));
            let name = Path::new(path)
                .file_stem()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            eprintln!("  {name}  {w}×{h}  {:.1} MP", (w as f64 * h as f64) / 1e6);
            (name, rgba, w, h)
        })
        .collect();

    // Consecutive pairs.
    for i in 0..images.len().saturating_sub(1) {
        let (ref ref_name, ref ref_rgba, rw, rh) = images[i];
        let (ref test_name, ref test_rgba, tw, th) = images[i + 1];

        if rw != tw || rh != th {
            eprintln!(
                "[skip] {ref_name} vs {test_name}: dimension mismatch {rw}×{rh} vs {tw}×{th}"
            );
            continue;
        }
        let w = rw as usize;
        let h = rh as usize;

        // --- Perceptual approx: time Comparer::new (reference build) ---
        let t0 = Instant::now();
        let mut cmp = Comparer::new(ref_rgba.clone(), w, h, Opts::default());
        let build_ms = t0.elapsed().as_secs_f64() * 1000.0;

        // warmup
        let _ = cmp.butteraugli(test_rgba);

        // timed reps
        let mut times = Vec::with_capacity(reps);
        for _ in 0..reps {
            let t = Instant::now();
            let score = cmp.butteraugli(test_rgba);
            times.push(t.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(score);
        }
        let perc_ms = median(times);

        // --- Write RGBA8 binary dumps for butter_time.exe ---
        let ref_raw = tmp.join(format!("{ref_name}.raw"));
        let test_raw = tmp.join(format!("{test_name}.raw"));
        fs::write(&ref_raw, ref_rgba).expect("write ref raw");
        fs::write(&test_raw, test_rgba).expect("write test raw");

        // JSON line — forward-slash paths to avoid JSON backslash escaping
        let ref_raw_s = ref_raw.to_str().unwrap().replace('\\', "/");
        let test_raw_s = test_raw.to_str().unwrap().replace('\\', "/");
        println!(
            r#"{{"pair":"{ref_name}|{test_name}","w":{rw},"h":{rh},"perc_build_ms":{build_ms:.2},"perc_ms":{perc_ms:.2},"ref_raw":"{ref_raw_s}","test_raw":"{test_raw_s}"}}"#
        );
    }
}
