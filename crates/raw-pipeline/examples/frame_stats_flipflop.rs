use raw_pipeline::frame_stats::{analyze, analyze_scalar};
use std::env;

fn main() {
    // 24MP image: 6000 x 4000
    const PIXELS: usize = 6000 * 4000;

    // Pre-allocate test buffer (RGBA8)
    let mut buf = vec![0u8; PIXELS * 4];
    let mut seed = 0xdeadbeef_u32;
    for slot in &mut buf {
        seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
        *slot = (seed & 0xff) as u8;
    }

    let variant = env::args().nth(1).unwrap_or_else(|| "auto".to_string());

    let (label, best_ms) = if variant == "scalar" {
        // Force scalar path
        let _ = analyze_scalar(&buf, PIXELS);
        let _ = analyze_scalar(&buf, PIXELS);
        let _ = analyze_scalar(&buf, PIXELS);

        let mut best = f64::INFINITY;
        for _ in 0..5 {
            let t0 = std::time::Instant::now();
            for _ in 0..10 {
                let _ = std::hint::black_box(analyze_scalar(&buf, PIXELS));
            }
            let elapsed = t0.elapsed().as_secs_f64() * 1000.0 / 10.0;
            if elapsed < best {
                best = elapsed;
            }
        }
        ("scalar", best)
    } else if variant == "auto" {
        // Runtime-dispatched (AVX2 if available, else scalar)
        let _ = analyze(&buf, 6000, 4000);
        let _ = analyze(&buf, 6000, 4000);
        let _ = analyze(&buf, 6000, 4000);

        let mut best = f64::INFINITY;
        for _ in 0..5 {
            let t0 = std::time::Instant::now();
            for _ in 0..10 {
                let _ = std::hint::black_box(analyze(&buf, 6000, 4000));
            }
            let elapsed = t0.elapsed().as_secs_f64() * 1000.0 / 10.0;
            if elapsed < best {
                best = elapsed;
            }
        }
        ("auto", best)
    } else {
        eprintln!("Usage: frame_stats_flipflop [scalar|auto]");
        std::process::exit(1);
    };

    println!("{},{:.4}", label, best_ms);
}
