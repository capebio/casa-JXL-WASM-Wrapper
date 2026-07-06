//! A/B timing for transpose-inl.h optimisations (4-lane SIMD on GE256,
//! 2-lane SIMD, direct no-inline thunk, direct-final-stores).
//!
//! Workflow:
//!   1. Build OLD binary (unmodified transpose-inl.h):
//!        .\build-msvc.ps1 build --release --example jxl_transpose_bench -p raw-pipeline
//!      Copy: cp target\release\examples\jxl_transpose_bench.exe trans_bench_old.exe
//!
//!   2. Apply transpose changes, then rebuild:
//!        .\build-msvc.ps1 build --release --example jxl_transpose_bench -p raw-pipeline
//!      Copy: cp target\release\examples\jxl_transpose_bench.exe trans_bench_new.exe
//!
//!   3. Flipflop (interleaved 5×, thermal-cancelled):
//!        for ($i=0; $i -lt 5; $i++) {
//!            .\trans_bench_old.exe; .\trans_bench_new.exe
//!        }
//!
//! What this exercises:
//!   Encode at e5 with ACS → ACS selects DCT4x4/DCT4x8/DCT8x4/DCT8x8.
//!   DCT4x4/4x8/8x4 currently go scalar on AVX2; SIMD fix targets those.
//!   High-frequency synthetic + natural-gradient images to diversify strategy mix.
//!
//! Byte-exact parity: run OLD and NEW on parity.png (or the synthetic) and diff
//!   SHA256 of the output bytes — must be identical (byte-exact change).
//!
//! Gate: ≥2% median improvement on any section = meaningful encode win.

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
mod bench {
    use raw_pipeline::jxl_casaencoder::{EncodeOptions, Encoder, Frame};

    fn mkpix_hf(w: u32, h: u32) -> Vec<u8> {
        // High-frequency checkerboard — maximises DCT4x4/DCT4x8/DCT8x4 strategy picks.
        let (wu, hu) = (w as usize, h as usize);
        let n = wu * hu * 3;
        let mut v = Vec::with_capacity(n);
        for y in 0..hu {
            for x in 0..wu {
                let val: u8 = if (x ^ y) & 1 == 0 { 220 } else { 35 };
                v.push(val);
                v.push(val.wrapping_add(20));
                v.push(val.wrapping_sub(20));
            }
        }
        v
    }

    fn mkpix_grad(w: u32, h: u32) -> Vec<u8> {
        // Smooth gradient — exercises 8×8 and larger blocks (baseline).
        let (wu, hu) = (w as usize, h as usize);
        let n = wu * hu * 3;
        let mut v = Vec::with_capacity(n);
        for y in 0..hu {
            for x in 0..wu {
                v.push(((x * 255) / wu) as u8);
                v.push(((y * 255) / hu) as u8);
                v.push((((x + y) * 127) / (wu + hu)) as u8);
            }
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

    fn time_encode(
        label: &str,
        pixels: &[u8],
        w: u32,
        h: u32,
        opts: &EncodeOptions,
        warmup: usize,
        iters: usize,
    ) {
        // warmup
        for _ in 0..warmup {
            std::hint::black_box(encode_jxl(pixels, w, h, opts));
        }
        let mut times = Vec::with_capacity(iters);
        for _ in 0..iters {
            let t = std::time::Instant::now();
            let out = encode_jxl(pixels, w, h, opts);
            let elapsed = t.elapsed().as_secs_f64() * 1000.0;
            times.push(elapsed);
            std::hint::black_box(out.len());
        }
        let med = median(&mut times);
        let min = times.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = times.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        println!("  {label}: med={med:.2}ms min={min:.2}ms max={max:.2}ms");
    }

    pub fn run() {
        const WARMUP: usize = 3;
        const ITERS: usize = 20;

        let sizes: &[(u32, u32, &str)] = &[
            (512, 512, "512×512"),
            (1024, 768, "1024×768"),
            (1920, 1080, "1920×1080"),
        ];

        println!("=== jxl_transpose_bench: transpose-inl.h 4-lane/2-lane/thunk A/B ===");
        println!("warmup={WARMUP} iters={ITERS}\n");

        // ── e5 high-frequency (maximises DCT4×4/4×8/8×4 ACS selections) ──────
        // These shapes are scalar on AVX2 before the 4-lane dispatch fix.
        // This section should show the largest delta.
        println!("--- e5 high-frequency (DCT4x4/4x8/8x4 ACS — primary target) ---");
        let opts_e5 = EncodeOptions::distance(1.0).with_effort(5);
        for &(w, h, label) in sizes {
            let pix = mkpix_hf(w, h);
            let encoded = encode_jxl(&pix, w, h, &opts_e5);
            println!("  {label} hf encoded {}B", encoded.len());
            time_encode(
                &format!("{label} hf e5"),
                &pix,
                w,
                h,
                &opts_e5,
                WARMUP,
                ITERS,
            );
        }

        // ── e5 smooth gradient (mostly 8×8 — baseline, should be ~flat) ──────
        // Large 8×8 blocks are already on the SIMD path; expect little delta here.
        // Regression guard: if this regresses, the 8-lane path was broken.
        println!("\n--- e5 smooth gradient (mostly 8×8 — regression guard) ---");
        for &(w, h, label) in sizes {
            let pix = mkpix_grad(w, h);
            time_encode(
                &format!("{label} grad e5"),
                &pix,
                w,
                h,
                &opts_e5,
                WARMUP,
                ITERS,
            );
        }

        // ── e3 (no ACS — should be entirely flat, pure regression guard) ─────
        // At e3, ACS is skipped entirely; only 8×8 DCT runs. Transpose impact ~0.
        println!("\n--- e3 (no ACS — flat expected, pure regression guard) ---");
        let opts_e3 = EncodeOptions::distance(1.0).with_effort(3);
        for &(w, h, label) in sizes {
            let pix = mkpix_hf(w, h);
            time_encode(
                &format!("{label} hf e3"),
                &pix,
                w,
                h,
                &opts_e3,
                WARMUP,
                ITERS,
            );
        }

        println!("\nDone.");
        println!("Gate: ≥2% med on e5-hf section = meaningful win. e3 section must be flat (±1%).");
        println!("Parity: SHA256 of OLD and NEW output bytes must match (byte-exact change).");
    }
}

fn main() {
    #[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
    bench::run();

    #[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
    eprintln!("requires default features + native: .\\.\\build-msvc.ps1 build --release --example jxl_transpose_bench -p raw-pipeline");
}
