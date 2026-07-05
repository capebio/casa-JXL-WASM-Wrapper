//! 10× flip-flop A/B bench for the perceptual kernel backends. Alternates
//! candidates A,B,A,B,... to cancel thermal/scheduler drift, prints median +
//! noise margin, declares a winner only if it clears the margin ("dead tie → tie").
//!
//! Run: cargo run -p raw-pipeline --release --example perceptual_flipflop

use raw_pipeline::perceptual::{BackendChoice, Comparer, Opts};
use std::time::Instant;

fn synth(w: usize, h: usize, seed: u32) -> Vec<u8> {
    let mut s = seed | 1;
    let mut rng = || {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        s
    };
    let n = w * h;
    let mut px = vec![0u8; n * 4];
    for i in 0..n {
        let x = (i % w) as f32;
        let y = (i / w) as f32;
        // Add RNG-based noise to break coherent patterns that might alias with SIMD widths.
        let noise = (rng() >> 24) as u8;
        px[i * 4] = (((x * 255.0 / w as f32 + 40.0 * (y / 17.0).sin()) as i32 & 255) as u8)
            .wrapping_add(noise >> 4);
        px[i * 4 + 1] = (((y * 255.0 / h as f32 + 40.0 * (x / 23.0).sin()) as i32 & 255) as u8)
            .wrapping_add(noise >> 5);
        px[i * 4 + 2] =
            ((((x + y) * 127.0 / (w + h) as f32) as i32 & 255) as u8).wrapping_add(noise >> 6);
        px[i * 4 + 3] = 255;
    }
    px
}

fn time_runs(
    reference: &[u8],
    test: &[u8],
    w: usize,
    h: usize,
    choice: BackendChoice,
    iters: usize,
) -> f64 {
    let mut opts = Opts::default();
    opts.backend = choice;
    let mut cmp = Comparer::new(reference.to_vec(), w, h, opts); // C-7: by-value API
                                                                 // warmup
    let _ = cmp.butteraugli(test);
    let t0 = Instant::now();
    let mut sink = 0f32;
    for _ in 0..iters {
        sink += cmp.butteraugli(test);
    }
    std::hint::black_box(sink);
    t0.elapsed().as_secs_f64() * 1e3 / iters as f64
}

fn main() {
    let (w, h) = (1280, 800);
    let reference = synth(w, h, 0xC0FFEE);
    let test = synth(w, h, 0xBADF00D);
    let iters = 30;
    let rounds = 10;

    let mut candidates: Vec<(&str, BackendChoice)> = vec![
        ("scalar", BackendChoice::ForceScalar),
        ("avx2-strict", BackendChoice::Force(1)),
        ("avx2-rsqrt", BackendChoice::Force(2)),
    ];
    // AVX-512 routes are added only when the CPU actually supports them — forcing
    // them on a non-AVX-512 part would execute illegal instructions (SIGILL).
    // When present, candidates indices 3 (strict, Force(3)) and 4 (rsqrt, Force(5)).
    // Note: Force id 4 = WasmSimd; Force ids are non-contiguous — rsqrt uses Force(5).
    let have_avx512 =
        std::is_x86_feature_detected!("avx512f") && std::is_x86_feature_detected!("avx512bw");
    if have_avx512 {
        candidates.push(("avx512-strict", BackendChoice::Force(3)));
        candidates.push(("avx512-rsqrt", BackendChoice::Force(5)));
    } else {
        println!("(AVX-512 not detected on this CPU — avx512 routes skipped; run on server hardware to compare)");
    }

    println!(
        "perceptual butteraugli flip-flop — {}x{} ({:.2} MP), {} iters x {} rounds",
        w,
        h,
        (w * h) as f64 / 1e6,
        iters,
        rounds
    );

    // avx2-strict vs scalar, avx2-strict vs avx2-rsqrt; plus avx512 routes when present.
    let mut pairs = vec![(0usize, 1usize), (1usize, 2usize)];
    if have_avx512 {
        pairs.push((1, 3)); // avx2-strict vs avx512-strict
        pairs.push((3, 4)); // avx512-strict vs avx512-rsqrt
    }
    for &(ia, ib) in &pairs {
        let (mut a_times, mut b_times) = (Vec::new(), Vec::new());
        for r in 0..rounds {
            // Alternate start-order each round to cancel thermal drift systematically.
            if r % 2 == 0 {
                a_times.push(time_runs(&reference, &test, w, h, candidates[ia].1, iters));
                b_times.push(time_runs(&reference, &test, w, h, candidates[ib].1, iters));
            } else {
                b_times.push(time_runs(&reference, &test, w, h, candidates[ib].1, iters));
                a_times.push(time_runs(&reference, &test, w, h, candidates[ia].1, iters));
            }
        }
        a_times.sort_by(|x, y| x.partial_cmp(y).unwrap());
        b_times.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let amed = a_times[rounds / 2];
        let bmed = b_times[rounds / 2];
        let margin = (a_times[rounds - 1] - a_times[0]).max(b_times[rounds - 1] - b_times[0]) * 0.5;
        let verdict = if (amed - bmed).abs() <= margin {
            "TIE (within noise) → keep simpler".to_string()
        } else if amed < bmed {
            format!("WINNER {} ({:.2}x)", candidates[ia].0, bmed / amed)
        } else {
            format!("WINNER {} ({:.2}x)", candidates[ib].0, amed / bmed)
        };
        println!(
            "  {:<12} {:.3} ms  vs  {:<12} {:.3} ms  | margin {:.3} ms | {}",
            candidates[ia].0, amed, candidates[ib].0, bmed, margin, verdict
        );
    }
}
