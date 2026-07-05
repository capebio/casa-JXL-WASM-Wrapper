// tone-bench — isolate tone-curve scalar vs SIMD for flipflop
// Usage: cargo run --example tone-bench --release -- --variant scalar|simd --in <input.rgba> --out <output.rgba>
// Input: raw RGBA u8 (w×h×4). Output: same, with tone applied.

use std::env;
use std::fs;
use std::io;

fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().collect();
    let mut variant = "simd";
    let mut in_path = None;
    let mut out_path = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--variant" => {
                variant = &args[i + 1];
                i += 2;
            }
            "--in" => {
                in_path = Some(&args[i + 1]);
                i += 2;
            }
            "--out" => {
                out_path = Some(&args[i + 1]);
                i += 2;
            }
            _ => i += 1,
        }
    }

    let in_path =
        in_path.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "--in required"))?;
    let out_path =
        out_path.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "--out required"))?;

    let rgba = fs::read(in_path)?;
    if rgba.len() % 4 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "RGBA not 4-byte aligned",
        ));
    }

    let n = rgba.len() / 4;
    let mut r: Vec<f32> = (0..n).map(|i| rgba[i * 4] as f32 / 255.0).collect();
    let mut g: Vec<f32> = (0..n).map(|i| rgba[i * 4 + 1] as f32 / 255.0).collect();
    let mut b: Vec<f32> = (0..n).map(|i| rgba[i * 4 + 2] as f32 / 255.0).collect();

    // Fixed tone params (no perceptual_constancy for baseline fairness)
    let m = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]; // identity matrix
    let sat = 1.0;
    let vib = 0.0;
    let vib_zero = false;

    // Dispatch
    match variant {
        "scalar" => {
            for i in 0..n {
                let (r2, g2, b2) = raw_pipeline::pipeline::apply_tone_math(
                    r[i], g[i], b[i], &m, sat, vib, vib_zero, false,
                );
                r[i] = r2;
                g[i] = g2;
                b[i] = b2;
            }
        }
        "simd" => {
            raw_pipeline::tone_simd::apply_tone_bulk(
                &mut r, &mut g, &mut b, &m, sat, vib, vib_zero,
            );
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "variant must be scalar or simd",
            ))
        }
    }

    let mut out = Vec::with_capacity(rgba.len());
    for i in 0..n {
        out.push((r[i].clamp(0.0, 1.0) * 255.0) as u8);
        out.push((g[i].clamp(0.0, 1.0) * 255.0) as u8);
        out.push((b[i].clamp(0.0, 1.0) * 255.0) as u8);
        out.push(rgba[i * 4 + 3]); // preserve alpha
    }

    fs::write(out_path, out)?;
    Ok(())
}
