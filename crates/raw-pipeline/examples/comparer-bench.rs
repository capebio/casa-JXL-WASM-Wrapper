// comparer-bench — psnr+channel_moments 2-pass vs fused 1-pass
// Usage: <binary> --variant twopasses|onepass --in <rgba8> --out <metrics> [--reps N]
//
// EpicCodeReview item 3: "Comparer::all() walks the buffers ~4× ... psnr + channel_moments as
// separate full passes". This bench isolates just those two passes (no butteraugli — that's
// ~7s/MP and would dominate, hiding the per-pass saving we actually want to measure).
//
// twopasses: separate psnr scan (1×) + separate channel_means scan (1×) = 2 full buffer reads
// onepass:   fused scan computes MSE + per-channel means together = 1 full buffer read
//
// Expected: onepass ~50% faster (memory-bound: same total work, half the cache-line fetches).
// Output: 3 LE f32s [psnr_dB, mean_r, mean_g] for equal() parity check (within tolerance).
//
// No feature flags needed — pure safe Rust, no C dependencies.

use std::{env, fs, io, time::Instant};

fn psnr_pass(reference: &[u8], test: &[u8]) -> f32 {
    let n3 = (reference.len() / 4 * 3) as f64;
    let mut mse_acc = 0u64;
    let n = reference.len() / 4;
    for i in 0..n {
        for c in 0..3usize {
            let a = reference[i * 4 + c] as i64;
            let b = test[i * 4 + c] as i64;
            let d = a - b;
            mse_acc += (d * d) as u64;
        }
    }
    let mse = mse_acc as f64 / n3;
    if mse == 0.0 {
        f32::INFINITY
    } else {
        (10.0 * (255.0f64 * 255.0 / mse).log10()) as f32
    }
}

fn means_pass(test: &[u8]) -> [f32; 3] {
    let n = test.len() / 4;
    let mut sums = [0u64; 3];
    for i in 0..n {
        sums[0] += test[i * 4] as u64;
        sums[1] += test[i * 4 + 1] as u64;
        sums[2] += test[i * 4 + 2] as u64;
    }
    [
        sums[0] as f32 / n as f32,
        sums[1] as f32 / n as f32,
        sums[2] as f32 / n as f32,
    ]
}

fn psnr_means_fused(reference: &[u8], test: &[u8]) -> (f32, [f32; 3]) {
    let n = reference.len() / 4;
    let mut mse_acc = 0u64;
    let mut ch_sums = [0u64; 3];
    for i in 0..n {
        for c in 0..3usize {
            let a = reference[i * 4 + c] as i64;
            let b = test[i * 4 + c] as i64;
            let d = a - b;
            mse_acc += (d * d) as u64;
            ch_sums[c] += b as u64;
        }
    }
    let mse = mse_acc as f64 / (n * 3) as f64;
    let psnr = if mse == 0.0 {
        f32::INFINITY
    } else {
        (10.0 * (255.0f64 * 255.0 / mse).log10()) as f32
    };
    let means: [f32; 3] = std::array::from_fn(|c| ch_sums[c] as f32 / n as f32);
    (psnr, means)
}

fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().collect();
    let mut variant = "twopasses";
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

    let rgba = fs::read(&in_path)?;
    if rgba.len() % 4 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "input not 4-byte aligned",
        ));
    }
    let n = rgba.len() / 4;
    // Synthesise test image: each byte +15 (wrapping), simulates codec artifact noise.
    let test: Vec<u8> = rgba.iter().map(|&b| b.wrapping_add(15)).collect();

    // Auto-calibrate: target ~500ms assuming ~10 GB/s memory throughput (2×buffer reads).
    let reps = reps_arg.unwrap_or_else(|| {
        let bytes_per_op = rgba.len() as u64 * 2; // both ref + test buffers
        let ns_per_op = bytes_per_op / 10; // 10 GB/s → 0.1 ns/byte
        let target_ns = 500_000_000u64;
        ((target_ns / ns_per_op.max(1)) as usize).clamp(4, 200_000)
    });

    // Warm-up (excluded from timing).
    let _ = psnr_means_fused(&rgba, &test);

    let (psnr_val, mean_r, mean_g) = {
        let t0 = Instant::now();
        let mut psnr_out = 0f32;
        let mut means_out = [0f32; 3];
        for _ in 0..reps {
            match variant {
                "twopasses" => {
                    psnr_out = psnr_pass(&rgba, &test);
                    means_out = means_pass(&test);
                }
                "onepass" => {
                    let (p, m) = psnr_means_fused(&rgba, &test);
                    psnr_out = p;
                    means_out = m;
                }
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "variant must be twopasses or onepass",
                    ))
                }
            }
        }
        let elapsed_ms = t0.elapsed().as_millis();
        eprintln!("comparer-bench: variant={variant} n={n} reps={reps} elapsed={elapsed_ms}ms");
        (psnr_out, means_out[0], means_out[1])
    };

    let mut out = [0u8; 12];
    out[0..4].copy_from_slice(&psnr_val.to_le_bytes());
    out[4..8].copy_from_slice(&mean_r.to_le_bytes());
    out[8..12].copy_from_slice(&mean_g.to_le_bytes());
    fs::write(&out_path, &out)?;
    Ok(())
}
