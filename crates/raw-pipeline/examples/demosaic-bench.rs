// demosaic-bench — generic Bayer MHC (4-way match/pixel) vs RGGB-specific MHC (unrolled interior)
// Usage: <binary> --variant generic|rggb-specific --in <rgba> --out <rgb16> [--reps N]
//
// Input: raw bytes interpreted as u16 LE Bayer values (2 bytes per raw pixel).
// Output: demosaiced RGB16 (u16 × 3 channels, LE) for equal() parity check.
//
// --reps N: repeat N times; default auto-calibrates to ~500ms compute.
//
// generic:       demosaic_bayer_mhc(phase=(0,0)) — per-pixel 4-way (row%2, col%2) match
// rggb-specific: demosaic_rggb_mhc — hand-specialized RGGB interior, no runtime phase dispatch

use raw_pipeline::demosaic::{demosaic_bayer_mhc, demosaic_rggb_mhc};
use std::{env, fs, io, time::Instant};

fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().collect();
    let mut variant = "generic";
    let mut in_path: Option<String> = None;
    let mut out_path: Option<String> = None;
    let mut reps_arg: Option<usize> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--variant" => {
                variant = Box::leak(args[i + 1].clone().into_boxed_str());
                i += 2;
            }
            "--in" => {
                in_path = Some(args[i + 1].clone());
                i += 2;
            }
            "--out" => {
                out_path = Some(args[i + 1].clone());
                i += 2;
            }
            "--reps" => {
                reps_arg = args[i + 1].parse().ok();
                i += 2;
            }
            _ => {
                i += 1;
            }
        }
    }

    let in_path =
        in_path.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "--in required"))?;
    let out_path =
        out_path.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "--out required"))?;

    let src = fs::read(&in_path)?;
    let n_u16 = src.len() / 2;
    let side = (n_u16 as f64).sqrt() as usize;
    let width = side & !1;
    let height = if side > 0 { (n_u16 / side) & !1 } else { 0 };
    if width < 4 || height < 4 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "input too small (need ≥4×4)",
        ));
    }

    let raw: Vec<u16> = src[..width * height * 2]
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();

    // Auto-calibrate reps: target ~500ms assuming ~200 MP/s for MHC demosaic.
    let reps = reps_arg.unwrap_or_else(|| {
        let mpix = (width * height) as u64;
        // 200 MP/s → 5 ns/pixel; target 500ms
        let ns_per_op = mpix * 5;
        let target_ns = 500_000_000u64;
        ((target_ns / ns_per_op.max(1)) as usize).clamp(2, 5_000)
    });

    // Warm-up.
    let _ = demosaic_bayer_mhc(&raw, width, height, (0, 0));

    let t0 = Instant::now();
    let mut last_rgb = Vec::new();
    for _ in 0..reps {
        last_rgb = match variant {
            "generic" => demosaic_bayer_mhc(&raw, width, height, (0, 0))
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?,
            "rggb-specific" => demosaic_rggb_mhc(&raw, width, height)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "variant must be generic or rggb-specific",
                ))
            }
        };
    }
    let elapsed_ms = t0.elapsed().as_millis();
    eprintln!(
        "demosaic-bench: variant={variant} {width}x{height} reps={reps} elapsed={elapsed_ms}ms"
    );

    let out_bytes: Vec<u8> = last_rgb.iter().flat_map(|&v| v.to_le_bytes()).collect();
    fs::write(&out_path, &out_bytes)?;
    Ok(())
}
