//! A/B timing for dec_transforms-inl.h + dec_group.cc optimizations (10 opts).
//!
//! What each section exercises:
//!   effort=3  — DCT-heavy mix (most blocks are plain DCT8x8 at e3; the
//!               LLF/DC bypass [Opt 10] and DCT2x2 opts [1-3] are targeted here)
//!   effort=5  — broader strategy mix including DCT4x4, DCT8x4, DCT4x8 (row-copy
//!               opts 7/8, butterfly opts 4/5, and the IDENTITY centre opt 6)
//!   effort=7 parallel — stress-tests all changes under thread contention; the
//!               per-block savings compound across many parallel threads
//!
//! Workflow:
//!   1. Build OLD binary (current source, no changes):
//!        .\build-msvc.ps1 build --release --example jxl_dec_transforms_bench -p raw-pipeline
//!      Copy: cp target\release\examples\jxl_dec_transforms_bench.exe trans_bench_old.exe
//!
//!   2. Apply changes (or set $env:LIBJXL_SOURCE_DIR to a worktree with changes),
//!      then rebuild:
//!        .\build-msvc.ps1 build --release --example jxl_dec_transforms_bench -p raw-pipeline
//!      Copy: cp target\release\examples\jxl_dec_transforms_bench.exe trans_bench_new.exe
//!
//!   3. Run flipflop (interleaved to cancel thermal drift):
//!        for ($i=0; $i -lt 5; $i++) {
//!            .\trans_bench_old.exe; .\trans_bench_new.exe
//!        }
//!
//! Gate: ≥3% median improvement on any section = meaningful decode win.

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
mod bench {
    use raw_pipeline::jxl_casadecoder::{Channels, DecodeOptions, Decoder};
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

    fn encode_jxl(pixels: &[u8], w: u32, h: u32, opts: &EncodeOptions) -> Vec<u8> {
        let frame = Frame::rgb(pixels, w, h);
        let mut enc = Encoder::new(opts.clone()).expect("JxlEncoderCreate");
        let mut out = Vec::new();
        enc.encode_into(&frame, &mut out).expect("encode");
        out
    }

    fn median(v: &mut Vec<f64>) -> f64 {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    }

    fn time_decode(label: &str, jxl: &[u8], parallel: bool, warmup: usize, iters: usize) {
        let mut dec = Decoder::new(DecodeOptions {
            parallel,
            ..Default::default()
        })
        .expect("JxlDecoderCreate");

        for _ in 0..warmup {
            let _ = dec.decode::<u8>(jxl, Channels::Rgb).expect("warmup decode");
        }

        let mut times = Vec::with_capacity(iters);
        for _ in 0..iters {
            let t = std::time::Instant::now();
            let img = dec.decode::<u8>(jxl, Channels::Rgb).expect("decode");
            times.push(t.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(img.data.len());
        }

        let med = median(&mut times);
        let min = times.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = times.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let mode = if parallel { "par" } else { "st" };
        println!("  {label} [{mode}]: med={med:.3}ms min={min:.3}ms max={max:.3}ms");
    }

    pub fn run() {
        const WARMUP: usize = 5;
        const ITERS: usize = 40;

        let nthreads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);

        let sizes: &[(u32, u32, &str)] = &[
            (512, 512, "512x512"),
            (1920, 1080, "1920x1080"),
            (4096, 2160, "4096x2160"),
        ];

        println!("=== jxl_dec_transforms_bench: dec_transforms + dec_group 10-opt A/B ===");
        println!("warmup={WARMUP} iters={ITERS} nthreads={nthreads}\n");

        // ── effort=3 single-thread (DCT-dominant) ───────────────────────────
        // At e3 almost all AC blocks are plain DCT8x8.  The LLF/DC bypass
        // [Opt 10, dec_group.cc] removes 3 function-call + 3 switch dispatches
        // on every block. DCT2x2 [Opts 1-3] and IDCT2 butterfly [Opt 2] also
        // trigger on the minority of non-DCT blocks at this effort.
        println!("--- effort=3 single-thread (DCT-heavy; Opt 10 LLF bypass + Opts 1-3 DCT2x2) ---");
        let opts_e3 = EncodeOptions::distance(1.0).with_effort(3);
        for &(w, h, label) in sizes {
            let pix = mkpix(w, h, 0xdeadbeef);
            let jxl = encode_jxl(&pix, w, h, &opts_e3);
            println!("  {label} e3 encoded {}B", jxl.len());
            time_decode(label, &jxl, false, WARMUP, ITERS);
        }

        // ── effort=5 single-thread (broader strategy mix) ───────────────────
        // e5 activates ACS, introducing DCT4x4, DCT8x4, DCT4x8, IDENTITY and
        // AFV blocks alongside DCT8x8. Exercises:
        //   Opt 4/5  — butterfly on IDENTITY/DCT4x4 DC reconstruction
        //   Opt 6    — IDENTITY centre local (saves 3 repeated pixel reads)
        //   Opt 7/8  — DCT8x4/DCT4x8 memcpy row-packing (replaces nested loop)
        //   Opt 9    — AFV constexpr orientation + partial sum
        //   Opt 10   — LLF/DC bypass still fires for all 1-block strategies
        println!("\n--- effort=5 single-thread (broad strategy mix; Opts 4-10) ---");
        let opts_e5 = EncodeOptions::distance(1.0).with_effort(5);
        for &(w, h, label) in sizes {
            let pix = mkpix(w, h, 0xdeadbeef);
            let jxl = encode_jxl(&pix, w, h, &opts_e5);
            println!("  {label} e5 encoded {}B", jxl.len());
            time_decode(label, &jxl, false, WARMUP, ITERS);
        }

        // ── effort=5 parallel ────────────────────────────────────────────────
        // Same strategy mix; measures thread-contention behaviour.
        println!("\n--- effort=5 parallel={nthreads} (Opts 4-10 under thread contention) ---");
        for &(w, h, label) in sizes {
            let pix = mkpix(w, h, 0xdeadbeef);
            let jxl = encode_jxl(&pix, w, h, &opts_e5);
            time_decode(label, &jxl, true, WARMUP, ITERS);
        }

        // ── effort=7 parallel (stress all opts) ─────────────────────────────
        // e7 enables more AFV and higher-order transforms; the per-block savings
        // compound across the larger block variety. Parallel run stresses all
        // opts simultaneously under thermal load.
        println!("\n--- effort=7 parallel={nthreads} (stress-test all 10 opts) ---");
        let opts_e7 = EncodeOptions::distance(1.0).with_effort(7);
        for &(w, h, label) in sizes {
            let pix = mkpix(w, h, 0xdeadbeef);
            let jxl = encode_jxl(&pix, w, h, &opts_e7);
            println!("  {label} e7 encoded {}B", jxl.len());
            time_decode(label, &jxl, true, WARMUP, ITERS);
        }

        println!("\nDone.");
        println!("Gate: ≥3% med improvement on any section = meaningful win.");
        println!("Compare: run OLD then NEW binary, or flipflop 5× each.");
    }
}

fn main() {
    #[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
    bench::run();

    #[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
    eprintln!("requires: cargo run --release --example jxl_dec_transforms_bench --features jxl-codec (native)");
}
