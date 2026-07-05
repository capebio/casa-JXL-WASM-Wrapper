//! CR2 decode benchmark — 10-run flip-flop between two files.
//!
//! Run:
//!   cargo run --release --no-default-features --example cr2_bench -p raw-pipeline \
//!     -- "<file1.CR2>" "<file2.CR2>"
//!
//! Default files:
//!   C:/Foo/raw-converter/tests/_MG_1744.CR2
//!   C:/Foo/raw-converter/tests/ADH 1248.CR2
//!
//! Outputs a .toon summary to docs/outputs/timing tests/ and prints it to stdout.

use raw_pipeline::cr2;
use raw_pipeline::ljpeg::LjpegStats;
use std::fs;
use std::path::Path;
use std::time::Instant;

struct Run {
    file: String,
    size_kb: usize,
    total_ms: f64,
    parse_ms: f64,
    ljpeg_ms: f64,
    crop_ms: f64,
    width: usize,
    height: usize,
    raw_mb: f64,
    crop_mb: f64,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let file1 = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| r"C:/Foo/raw-converter/tests/_MG_1744.CR2".into());
    let file2 = args
        .get(2)
        .cloned()
        .unwrap_or_else(|| r"C:/Foo/raw-converter/tests/ADH 1248.CR2".into());

    let data1 = fs::read(&file1).unwrap_or_else(|e| panic!("read {file1}: {e}"));
    let data2 = fs::read(&file2).unwrap_or_else(|e| panic!("read {file2}: {e}"));

    let files = [(file1.clone(), &data1), (file2.clone(), &data2)];

    println!("CR2 flip-flop benchmark — 10 runs");
    println!("File A: {} ({} KB)", file1, data1.len() / 1024);
    println!("File B: {} ({} KB)\n", file2, data2.len() / 1024);

    // Warmup (not counted) — also used to collect LJPEG stage stats.
    let _ = cr2::decode_bytes_bench(&data1);
    let _ = cr2::decode_bytes_bench(&data2);

    // LJPEG stage breakdown (diagnostic — runs once per file after warmup).
    println!("=== LJPEG stage breakdown (L1-L5) ===");
    for (label, data) in [("A", &data1), ("B", &data2)] {
        let (img, stats) = cr2::decode_bytes_with_ljpeg_stats(data)
            .unwrap_or_else(|e| panic!("stats decode failed [{label}]: {e}"));
        print_ljpeg_stats(label, &img, &stats);
    }
    println!();

    let mut runs: Vec<Run> = Vec::new();

    for i in 0..10 {
        let (fname, data) = &files[i % 2];
        let label = if i % 2 == 0 { "A" } else { "B" };
        let t0 = Instant::now();
        let (img, timings) = cr2::decode_bytes_bench(data)
            .unwrap_or_else(|e| panic!("decode failed on {fname}: {e}"));
        let wall_ms = t0.elapsed().as_secs_f64() * 1000.0;
        println!(
            "Run {:2} [{label}] total={:.1}ms  ljpeg={:.1}ms  crop={:.1}ms  {}×{}",
            i + 1,
            timings.total_ms,
            timings.ljpeg_ms,
            timings.crop_ms,
            img.width,
            img.height
        );
        runs.push(Run {
            file: fname.clone(),
            size_kb: data.len() / 1024,
            total_ms: timings.total_ms,
            parse_ms: timings.parse_ms,
            ljpeg_ms: timings.ljpeg_ms,
            crop_ms: timings.crop_ms,
            width: img.width,
            height: img.height,
            raw_mb: timings.raw_buf_bytes as f64 / (1024.0 * 1024.0),
            crop_mb: timings.crop_buf_bytes as f64 / (1024.0 * 1024.0),
        });
        let _ = wall_ms; // suppress unused warning
    }

    println!();

    let toon = generate_toon(&runs, &file1, &file2);
    println!("{toon}");

    // Save
    let ts = chrono_now();
    let dir = "docs/outputs/timing tests";
    fs::create_dir_all(dir).ok();
    let path = format!("{dir}/cr2-flipflop-{ts}.toon");
    fs::write(&path, &toon).ok();
    eprintln!("saved → {path}");
}

fn print_ljpeg_stats(label: &str, img: &raw_pipeline::cr2::Cr2Image, s: &LjpegStats) {
    let syms = s.total_symbols as f64;
    let fills = s.fill_calls as f64;
    println!(
        "--- File {label} ({}×{}, sof {}×{}×{} prec={}) ---",
        img.width, img.height, s.sof_w, s.sof_h, s.cps, s.precision
    );
    println!("  L2 Huffman decode:");
    println!("    total symbols  : {}", s.total_symbols);
    println!(
        "    fast8 hits     : {} ({:.1}%)",
        s.fast8_hits,
        100.0 * s.fast8_hits as f64 / syms
    );
    println!(
        "    slow_huffman   : {} ({:.1}%)",
        s.slow_huffman_hits,
        100.0 * s.slow_huffman_hits as f64 / syms
    );
    println!("  L3 Magnitude receive:");
    println!(
        "    get_bits calls : {} ({:.1}% of symbols)",
        s.get_bits_calls,
        100.0 * s.get_bits_calls as f64 / syms
    );
    println!(
        "    avg t per call : {:.2} bits",
        if s.get_bits_calls > 0 {
            s.get_bits_total_bits as f64 / s.get_bits_calls as f64
        } else {
            0.0
        }
    );
    println!("  L1 Bitstream refill (fill() calls):");
    println!(
        "    fill() calls   : {} (1 per {:.1} symbols)",
        s.fill_calls,
        if fills > 0.0 { syms / fills } else { 0.0 }
    );
    println!(
        "    bulk_fill hits : {} ({:.1}% of fill iters)",
        s.bulk_fill_hits,
        100.0 * s.bulk_fill_hits as f64 / (s.bulk_fill_hits + s.slow_fill_hits).max(1) as f64
    );
    println!(
        "    slow_fill hits : {} ({:.1}% of fill iters)",
        s.slow_fill_hits,
        100.0 * s.slow_fill_hits as f64 / (s.bulk_fill_hits + s.slow_fill_hits).max(1) as f64
    );
    let compressed_bits = (s.bulk_fill_hits * 32 + s.slow_fill_hits * 8) as f64;
    let huff_bits = s.fast8_hits as f64 * 6.0; // rough: avg code len 6 bits for common tables
    println!(
        "  approx bits:    compressed={:.1}M  symbols≈{}  L3_bits={}M",
        compressed_bits / 1e6,
        s.total_symbols,
        s.get_bits_total_bits / 1_000_000
    );
}

fn generate_toon(runs: &[Run], file1: &str, file2: &str) -> String {
    let totals: Vec<f64> = runs.iter().map(|r| r.total_ms).collect();
    let ljpegs: Vec<f64> = runs.iter().map(|r| r.ljpeg_ms).collect();
    let crops: Vec<f64> = runs.iter().map(|r| r.crop_ms).collect();
    let parses: Vec<f64> = runs.iter().map(|r| r.parse_ms).collect();

    let avg_total = avg(&totals);
    let avg_ljpeg = avg(&ljpegs);
    let avg_crop = avg(&crops);
    let avg_parse = avg(&parses);
    let med_total = median(totals.clone());
    let min_total = totals.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_total = totals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let std_total = stddev(&totals);

    let r0 = &runs[0];

    let mut out = String::new();
    out += &format!("TestName: cr2-decode-flipflop\n");
    out += &format!("RunTimestamp: {}\n", chrono_now());
    out += &format!("FileA: {}\n", file1);
    out += &format!("FileB: {}\n", file2);
    out += &format!("ImageDims: {}x{}\n", r0.width, r0.height);
    out += &format!("RawBufMB: {:.1}\n", r0.raw_mb);
    out += &format!("CropBufMB: {:.1}\n", r0.crop_mb);
    out += &format!("Runs: {}\n\n", runs.len());

    out += "---\n";
    out += &format!(
        "runs[{}]{{run|file|total_ms|parse_ms|ljpeg_ms|crop_ms}}:\n",
        runs.len()
    );
    for (i, r) in runs.iter().enumerate() {
        let label = if i % 2 == 0 { "A" } else { "B" };
        out += &format!(
            "  {:2} | {} | {:8.2} | {:6.2} | {:8.2} | {:6.2}\n",
            i + 1,
            label,
            r.total_ms,
            r.parse_ms,
            r.ljpeg_ms,
            r.crop_ms
        );
    }

    out += "\n# Aggregates (all 10 runs)\n";
    out += &format!("AvgTotal:  {avg_total:.2} ms\n");
    out += &format!("MedTotal:  {med_total:.2} ms\n");
    out += &format!("MinTotal:  {min_total:.2} ms\n");
    out += &format!("MaxTotal:  {max_total:.2} ms\n");
    out += &format!("StdDev:    {std_total:.2} ms\n");
    out += &format!(
        "AvgParse:  {avg_parse:.2} ms  ({:.1}%)\n",
        100.0 * avg_parse / avg_total
    );
    out += &format!(
        "AvgLJPEG:  {avg_ljpeg:.2} ms  ({:.1}%)\n",
        100.0 * avg_ljpeg / avg_total
    );
    out += &format!(
        "AvgCrop:   {avg_crop:.2} ms  ({:.1}%)\n",
        100.0 * avg_crop / avg_total
    );
    out += &format!(
        "OtherMs:   {:.2} ms  ({:.1}%)\n",
        avg_total - avg_parse - avg_ljpeg - avg_crop,
        100.0 * (avg_total - avg_parse - avg_ljpeg - avg_crop) / avg_total
    );

    // Per-file split
    let a_runs: Vec<f64> = runs.iter().step_by(2).map(|r| r.total_ms).collect();
    let b_runs: Vec<f64> = runs.iter().skip(1).step_by(2).map(|r| r.total_ms).collect();
    if !a_runs.is_empty() && !b_runs.is_empty() {
        out += &format!("\nFileA avg: {:.2} ms\n", avg(&a_runs));
        out += &format!("FileB avg: {:.2} ms\n", avg(&b_runs));
    }

    out
}

fn avg(v: &[f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.iter().sum::<f64>() / v.len() as f64
}

fn median(mut v: Vec<f64>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn stddev(v: &[f64]) -> f64 {
    if v.len() < 2 {
        return 0.0;
    }
    let m = avg(v);
    let var = v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64;
    var.sqrt()
}

fn chrono_now() -> String {
    // Simple time stamp without chrono dep
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    // Approximate date from epoch (good enough for file naming)
    let year = 1970 + days / 365;
    let doy = days % 365;
    let month = doy / 30 + 1;
    let day = doy % 30 + 1;
    format!("{year:04}-{month:02}-{day:02}T{h:02}-{m:02}-{s:02}Z")
}
