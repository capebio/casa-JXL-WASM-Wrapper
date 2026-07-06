// tile-decode-bench — DNG uncompressed tile decode: per-pixel branch vs hoisted
// Usage: <binary> --variant branched|hoisted --in <bytes> --out <u16s> [--reps N]
//
// Input: raw bytes treated as 16-bit LE tile data (2 bytes per raw pixel).
// Output: decoded u16 values written as LE byte pairs.
//
// --reps N: repeat the decode N times; default auto-calibrates to ~500ms compute.
//
// branched: per-pixel `if le` + per-pixel bounds check (compiler can't vectorize)
// hoisted:  pre-validate full tile size once, hoist endianness, two tight loops (vectorizable)

use std::{env, fs, io, time::Instant};

fn decode_branched(src: &[u8], out: &mut [u16], rows: usize, cols: usize, tile_w: usize, le: bool) {
    let mut sp = 0usize;
    for r in 0..rows {
        for c in 0..cols {
            if sp + 2 > src.len() {
                break;
            }
            out[r * cols + c] = if le {
                u16::from_le_bytes([src[sp], src[sp + 1]])
            } else {
                u16::from_be_bytes([src[sp], src[sp + 1]])
            };
            sp += 2;
        }
        sp += tile_w.saturating_sub(cols) * 2;
    }
}

fn decode_hoisted(src: &[u8], out: &mut [u16], rows: usize, cols: usize, tile_w: usize, le: bool) {
    let needed = rows * tile_w * 2;
    if needed > src.len() {
        return;
    }
    let mut sp = 0usize;
    if le {
        for r in 0..rows {
            for c in 0..cols {
                out[r * cols + c] = u16::from_le_bytes([src[sp], src[sp + 1]]);
                sp += 2;
            }
            sp += tile_w.saturating_sub(cols) * 2;
        }
    } else {
        for r in 0..rows {
            for c in 0..cols {
                out[r * cols + c] = u16::from_be_bytes([src[sp], src[sp + 1]]);
                sp += 2;
            }
            sp += tile_w.saturating_sub(cols) * 2;
        }
    }
}

fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().collect();
    let mut variant = "branched";
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
    let cols = (n_u16 as f64).sqrt() as usize;
    let rows = if cols > 0 { n_u16 / cols } else { 0 };
    let tile_w = cols;

    let mut out = vec![0u16; rows * cols];

    // Auto-calibrate reps: target ~500ms of compute assuming ~5 GB/s scalar throughput.
    // Calibration is conservative so even the slower branched variant fills the window.
    let reps = reps_arg.unwrap_or_else(|| {
        let data_bytes = (rows * cols * 2).max(1) as u64;
        // 5 GB/s → 0.2 ns/byte → data_ns = data_bytes / 5
        let data_ns = data_bytes / 5;
        let target_ns = 500_000_000u64;
        ((target_ns / data_ns.max(1)) as usize).clamp(10, 500_000)
    });

    let decode = match variant {
        "branched" => decode_branched as fn(&[u8], &mut [u16], usize, usize, usize, bool),
        "hoisted" => decode_hoisted as fn(&[u8], &mut [u16], usize, usize, usize, bool),
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "variant must be branched or hoisted",
            ))
        }
    };

    // Warm-up round excluded from output.
    decode(&src, &mut out, rows, cols, tile_w, true);

    let t0 = Instant::now();
    for _ in 0..reps {
        decode(&src, &mut out, rows, cols, tile_w, true);
    }
    let elapsed_ms = t0.elapsed().as_millis();
    eprintln!("tile-decode-bench: variant={variant} rows={rows} cols={cols} reps={reps} elapsed={elapsed_ms}ms");

    let out_bytes: Vec<u8> = out.iter().flat_map(|&v| v.to_le_bytes()).collect();
    fs::write(&out_path, &out_bytes)?;
    Ok(())
}
