//! `djxl` — minimal JXL→PNG decoder for byte-exact baseline verification.
//!
//! Usage: djxl <input.jxl> <output.png>
//!
//! Decodes with single-threaded `jxl_casadecoder::decode_jxl_rgba8` (RGBA8,
//! deterministic) and saves via the `image` crate PNG encoder.
//! Exit 0 on success, 1 on any error.
//!
//! Requires the `jxl-codec` feature (default on for raw-pipeline).

use std::env;
use std::fs;
use std::process;

use image::RgbaImage;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        eprintln!("Usage: djxl <input.jxl> <output.png>");
        process::exit(1);
    }
    let jxl_path = &args[1];
    let out_path = &args[2];

    let jxl_bytes = match fs::read(jxl_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("error reading {jxl_path}: {e}");
            process::exit(1);
        }
    };

    // Single-threaded, deterministic, RGBA8 output.
    let (pixels, width, height) = match raw_pipeline::jxl_casadecoder::decode_jxl_rgba8(&jxl_bytes)
    {
        Some(r) => r,
        None => {
            eprintln!("failed to decode {jxl_path}");
            process::exit(1);
        }
    };

    let img = match RgbaImage::from_raw(width, height, pixels) {
        Some(i) => i,
        None => {
            eprintln!("buffer size mismatch for {jxl_path}");
            process::exit(1);
        }
    };

    if let Err(e) = img.save(out_path) {
        eprintln!("failed to save {out_path}: {e}");
        process::exit(1);
    }
}
