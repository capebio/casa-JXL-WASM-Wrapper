//! process_simd_flip — end-to-end flip for the SIMD-path routing (full pipeline, not just the
//! tone kernel). Two interleaved A/B groups over a real-size (24 MP) deterministic rgb16 buffer:
//!
//!   8-bit  : A = `process` (scalar, the old apply_look / LookRenderer path)
//!            B = `process_simd` (SIMD, what those paths now call via `process_auto`)   [#1]
//!   16-bit : A = `process_16bit_scalar`   B = `process_16bit_simd`                       [#2]
//!
//! Start-rotated rounds so drift hits both arms equally; round 0 (warm-up, builds the LUT cache)
//! dropped; median reported. Also prints max abs output diff (parity: ≤1-LUT-step reassociation).
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --features parallel --example process_simd_flip
use raw_pipeline::pipeline::{
    process, process_16bit_scalar, process_16bit_simd, process_simd, PipelineParams,
};
use std::time::Instant;

fn main() {
    let (w, h) = (6000usize, 4000usize); // 24 MP, a real CR2 size
    let n = w * h;
    let params = PipelineParams::default_olympus(); // non-perceptual ⇒ SIMD path is live

    // Deterministic post-demosaic rgb16 (3 u16/pixel) in the sensor 0..white domain.
    let mut s: u32 = 0x9e37_79b9;
    let mut rgb16 = vec![0u16; n * 3];
    for v in rgb16.iter_mut() {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *v = ((s >> 8) & 0x3fff) as u16; // 14-bit raw range
    }

    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec();
        w.sort_by(|a, b| a.partial_cmp(b).unwrap());
        w[w.len() / 2]
    };

    let flip = |label: &str,
                run_a: &dyn Fn() -> Vec<u8>,
                run_b: &dyn Fn() -> Vec<u8>,
                bytes_per_ch: usize| {
        // parity on a warm pair
        let a0 = run_a();
        let b0 = run_b();
        let max_diff = a0
            .iter()
            .zip(b0.iter())
            .map(|(x, y)| (*x as i32 - *y as i32).abs())
            .max()
            .unwrap_or(0);

        let rounds = 9usize;
        let (mut ta, mut tb) = (Vec::new(), Vec::new());
        let mut sink = 0u64;
        let time = |f: &dyn Fn() -> Vec<u8>, sink: &mut u64| {
            let t = Instant::now();
            let out = f();
            *sink = sink.wrapping_add(out.get(out.len() / 2).copied().unwrap_or(0) as u64);
            t.elapsed().as_secs_f64() * 1e3
        };
        for r in 0..rounds {
            if r % 2 == 0 {
                ta.push(time(run_a, &mut sink));
                tb.push(time(run_b, &mut sink));
            } else {
                tb.push(time(run_b, &mut sink));
                ta.push(time(run_a, &mut sink));
            }
        }
        let (ma, mb) = (med(&ta), med(&tb));
        println!("\n[{label}]  (sink={sink})");
        println!(
            "  parity: max abs output diff = {max_diff} ({} unit)",
            if bytes_per_ch == 1 { "u8" } else { "u16" }
        );
        println!("  A scalar: {ma:.1} ms median");
        println!("  B simd:   {mb:.1} ms median");
        if ma > 0.0 && mb > 0.0 {
            println!(
                "  %saved (B vs A): {:.1}%   speedup {:.2}×",
                (ma - mb) / ma * 100.0,
                ma / mb
            );
        } else {
            println!("  %saved (B vs A): (timing too fast to measure reliably)");
        }
    };

    println!(
        "process_simd_flip  {w}×{h} = {:.1} MP  parallel={}",
        n as f64 / 1e6,
        cfg!(feature = "parallel")
    );

    flip(
        "8-bit  process vs process_simd  (#1 apply_look / LookRenderer path)",
        &|| process(&rgb16, &params),
        &|| process_simd(&rgb16, &params),
        1,
    );

    // 16-bit outputs are Vec<u16>; widen to bytes for the shared u8 closure signature would lose
    // the per-channel diff, so run that group inline here.
    {
        let run_a = || process_16bit_scalar(&rgb16, &params);
        let run_b = || process_16bit_simd(&rgb16, &params);
        let a0 = run_a();
        let b0 = run_b();
        let max_diff = a0
            .iter()
            .zip(b0.iter())
            .map(|(x, y)| (*x as i32 - *y as i32).abs())
            .max()
            .unwrap_or(0);
        let rounds = 9usize;
        let (mut ta, mut tb) = (Vec::new(), Vec::new());
        let mut sink = 0u64;
        let time = |f: &dyn Fn() -> Vec<u16>, sink: &mut u64| {
            let t = Instant::now();
            let out = f();
            *sink = sink.wrapping_add(out.get(out.len() / 2).copied().unwrap_or(0) as u64);
            t.elapsed().as_secs_f64() * 1e3
        };
        for r in 0..rounds {
            if r % 2 == 0 {
                ta.push(time(&run_a, &mut sink));
                tb.push(time(&run_b, &mut sink));
            } else {
                tb.push(time(&run_b, &mut sink));
                ta.push(time(&run_a, &mut sink));
            }
        }
        let (ma, mb) = (med(&ta), med(&tb));
        println!("\n[16-bit  process_16bit_scalar vs process_16bit_simd  (#2)]  (sink={sink})");
        println!("  parity: max abs output diff = {max_diff} (u16)");
        println!("  A scalar: {ma:.1} ms median");
        println!("  B simd:   {mb:.1} ms median");
        if ma > 0.0 && mb > 0.0 {
            println!(
                "  %saved (B vs A): {:.1}%   speedup {:.2}×",
                (ma - mb) / ma * 100.0,
                ma / mb
            );
        } else {
            println!("  %saved (B vs A): (timing too fast to measure reliably)");
        }
    }
}
