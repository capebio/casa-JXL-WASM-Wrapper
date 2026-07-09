//! Watchable calibration demo: renders every fractal dataset to a PNG you can open,
//! then runs the calibration with a moderate (fast) config, broadcasting each contest
//! as it happens and printing the chosen profile.
//!
//! Run: cargo run -p raw-pipeline --example calibrate_demo --no-default-features --features parallel --release

use image::RgbaImage;
use raw_pipeline::calibration::bench::BenchConfig;
use raw_pipeline::calibration::fractal::{Dataset, FractalSpec, DATASETS};
use raw_pipeline::calibration::orchestrator::run_calibration;
use std::path::Path;

fn save_png(spec: &FractalSpec, path: &Path) {
    let px = spec.render_rgba8();
    let img = RgbaImage::from_raw(spec.width as u32, spec.height as u32, px)
        .expect("buffer sized w*h*4");
    img.save(path).unwrap_or_else(|e| eprintln!("save {}: {e}", path.display()));
}

fn main() {
    let out = Path::new("calibration-samples");
    std::fs::create_dir_all(out).unwrap();

    println!("== rendering fractal corpus -> {}/ ==", out.display());
    // Seahorse gets a bigger canvas so the detail is visible.
    let seahorse = FractalSpec::preset(Dataset::MandelbrotSeahorse, 512, 512);
    save_png(&seahorse, &out.join("mandelbrot-seahorse.png"));
    println!("  mandelbrot-seahorse.png  512x512");
    save_png(&seahorse.dithered(), &out.join("mandelbrot-seahorse-dithered.png"));
    println!("  mandelbrot-seahorse-dithered.png  512x512 (photo-like entropy)");
    for d in DATASETS {
        if *d == Dataset::MandelbrotSeahorse {
            continue;
        }
        let spec = FractalSpec::preset(*d, 320, 240);
        save_png(&spec, &out.join(format!("{}.png", d.label())));
        println!("  {}.png  320x240", d.label());
    }

    println!();
    println!("== running calibration (moderate config, live) ==");
    // Moderate config: real timings, ~watchable duration (not the full 1-3 min budget).
    let cfg = BenchConfig {
        backend_dim: 256,
        backend_warmup: 2,
        backend_runs: 5,
        thread_tiles: 16,
        thread_dim: 160,
        thread_runs: 3,
    };
    let profile = run_calibration(&cfg, &mut |line| println!("  {line}"));

    println!();
    println!("== chosen profile ==");
    println!("{}", serde_json::to_string_pretty(&profile).unwrap());
}
