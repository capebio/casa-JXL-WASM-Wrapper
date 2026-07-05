//! Before/after timer for C++ encode.cc micro-optimizations (002-hacker-*).
//!
//! These micro-opts are in C++ so they can't be inline A/B in the same binary.
//! Workflow:
//!   1.  cargo run --release --example jxl_encode_cpp_bench > before.txt
//!   2.  Edit encode.cc (or let this session apply them), then rebuild:
//!         cargo build -p raw-pipeline --release
//!   3.  cargo run --release --example jxl_encode_cpp_bench > after.txt
//!   4.  diff before.txt after.txt  (expect delta < 2%; these are nano-opt)
//!
//! What this exercises:
//!   002-hacker-a1b2  box_header: heap alloc/free replaced by stack array
//!                    → ONLY active on the container path (use_container=true)
//!   002-hacker-c3d4  frame_name: string copy → std::move
//!                    → empty name (SSO) = ~0 savings; exercises code path
//!   002-hacker-g7h8  MustUseContainer(): 2 bool-expr evals → 1 cached const
//!                    → compiler likely already folds this; clarity improvement
//!   002-hacker-u1v2  StoreFrameIndexBox: loop `auto` → `const auto&`
//!                    → saves 1 struct copy per entry; single-frame = 1 entry
//!
//! Gate: ≥5% improvement on the relevant path to commit as a perf fix.
//! Expected outcome: <1% change (sub-µs savings vs 10ms+ encode time).
//! These are code quality improvements that happen to have micro-perf value.

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
mod bench {
    use raw_pipeline::jxl_casaencoder::{EncodeOptions, Encoder, Frame};

    fn mkpix(w: u32, h: u32, seed: u64) -> Vec<u8> {
        let n = (w as usize) * (h as usize) * 3;
        let mut v = Vec::with_capacity(n);
        let mut s = seed;
        for _ in 0..n {
            s = s
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            v.push(((s >> 33) & 0xff) as u8);
        }
        v
    }

    fn median(v: &mut Vec<f64>) -> f64 {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    }

    fn time_encode(label: &str, w: u32, h: u32, opts: &EncodeOptions, warmup: usize, iters: usize) {
        time_encode_threads(label, w, h, opts, 0, warmup, iters);
    }

    fn time_encode_threads(
        label: &str,
        w: u32,
        h: u32,
        opts: &EncodeOptions,
        nthreads: usize,
        warmup: usize,
        iters: usize,
    ) {
        let pixels = mkpix(w, h, 0xdeadbeef);
        let frame = Frame::rgb(&pixels, w, h);
        let mut enc = if nthreads > 1 {
            Encoder::with_threads(opts.clone(), nthreads).expect("JxlEncoderCreate+threads")
        } else {
            Encoder::new(opts.clone()).expect("JxlEncoderCreate")
        };
        let mut out: Vec<u8> = Vec::with_capacity(pixels.len() / 2);

        for _ in 0..warmup {
            out.clear();
            enc.encode_into(&frame, &mut out).expect("warmup encode");
        }

        let mut times = Vec::with_capacity(iters);
        for _ in 0..iters {
            out.clear();
            let t = std::time::Instant::now();
            enc.encode_into(&frame, &mut out).expect("encode");
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }

        let med = median(&mut times);
        let min = times.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = times.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        println!(
            "  {label}: med={med:.3}ms min={min:.3}ms max={max:.3}ms out={}B",
            out.len()
        );
    }

    pub fn run() {
        const WARMUP: usize = 6;
        const ITERS: usize = 50;

        let sizes: &[(u32, u32, &str)] = &[
            (512, 512, "512x512"),
            (1920, 1080, "1920x1080"),
            (4096, 2160, "4096x2160"),
        ];

        println!("=== jxl_encode_cpp_bench: C++ ProcessFrame overhead timing ===");
        println!("warmup={WARMUP} iters={ITERS} (rebuild to compare before/after)\n");

        // ── Non-container path (default) ─────────────────────────────────────
        // Exercises: frame_name move, MustUseContainer cache.
        // Does NOT exercise: box_header alloc (container path off).
        println!("--- effort=3  non-container (default) ---");
        let opts_nc = EncodeOptions::distance(1.0).with_effort(3);
        for &(w, h, label) in sizes {
            time_encode(label, w, h, &opts_nc, WARMUP, ITERS);
        }

        // ── Container path (use_container=true) ──────────────────────────────
        // Exercises: box_header heap alloc (002-hacker-a1b2), MustUseContainer.
        // This is the path where the most C++ overhead savings land.
        println!("\n--- effort=3  container (use_container=true) ---");
        let opts_c = EncodeOptions {
            use_container: true,
            ..EncodeOptions::distance(1.0).with_effort(3)
        };
        for &(w, h, label) in sizes {
            time_encode(label, w, h, &opts_c, WARMUP, ITERS);
        }

        // ── Effort=1 container: overhead is larger fraction of total ──────────
        // At effort=1 (Lightning), encode time is ~3-5ms vs 20ms at effort=3.
        // The C++ overhead (box alloc, bool evals) is a larger % of total time.
        // If micro-opts show anywhere, it's here.
        println!("\n--- effort=1  container (use_container=true) ---");
        let opts_e1 = EncodeOptions {
            use_container: true,
            ..EncodeOptions::distance(1.0).with_effort(1)
        };
        for &(w, h, label) in sizes {
            time_encode(label, w, h, &opts_e1, WARMUP, ITERS);
        }

        // ── Parallel runner: effort=3 container, N threads ───────────────────
        // JxlThreadParallelRunner dispatches group-encode work across threads.
        // Expected: 2–4× speedup at FHD/4K (more groups → more parallelism).
        // 512×512 may show less gain (fewer groups, threading overhead dominates).
        let nthreads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        println!("\n--- effort=3  container  parallel ({nthreads} threads) ---");
        let opts_par = EncodeOptions {
            use_container: true,
            ..EncodeOptions::distance(1.0).with_effort(3)
        };
        for &(w, h, label) in sizes {
            time_encode_threads(label, w, h, &opts_par, nthreads, WARMUP, ITERS);
        }

        // ── Parallel runner: effort=1 container, N threads ───────────────────
        // Effort=1 uses FJXL fast path — may not parallelize well (different code path).
        println!("\n--- effort=1  container  parallel ({nthreads} threads) ---");
        let opts_par_e1 = EncodeOptions {
            use_container: true,
            ..EncodeOptions::distance(1.0).with_effort(1)
        };
        for &(w, h, label) in sizes {
            time_encode_threads(label, w, h, &opts_par_e1, nthreads, WARMUP, ITERS);
        }

        println!("\nDone. Compare before/after by running with rebuilt C++ binary.");
        println!("Gate: ≥5% median improvement on container path = pass as perf fix.");
        println!("Expected parallel speedup: 2–4× at FHD/4K; less at 512×512.");
    }
}

fn main() {
    #[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
    bench::run();

    #[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
    eprintln!(
        "requires: cargo run --release --example jxl_encode_cpp_bench (default features, native)"
    );
}
