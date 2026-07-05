//! A/B timing for dec_group.cc structural improvements (7 changes, commit abc6c858).
//!
//! Workflow:
//!   1. Build OLD binary (current LIBJXL_SOURCE_DIR):
//!        .\build-msvc.ps1 build --release --example jxl_dec_group_bench -p raw-pipeline
//!      Copy: cp target\release\examples\jxl_dec_group_bench.exe dec_bench_old.exe
//!
//!   2. Set worktree source and rebuild:
//!        $env:LIBJXL_SOURCE_DIR = "C:/Foo/rcw-dec-group-impl"
//!        .\build-msvc.ps1 build --release --example jxl_dec_group_bench -p raw-pipeline
//!      Copy: cp target\release\examples\jxl_dec_group_bench.exe dec_bench_new.exe
//!
//!   3. Run flipflop (interleaved to control for thermal):
//!        for ($i=0; $i -lt 5; $i++) {
//!            .\dec_bench_old.exe; .\dec_bench_new.exe
//!        }
//!
//! What this exercises:
//!   Change 1 (DecodeGroupNoDraw) — progressive-encoded images; the kDontDraw path
//!             skips all render setup and hits the new fast path
//!   Change 2 (stack GetBlockFromBitstream) — all VarDCT decodes
//!   Change 3 (JpegGroupParams cache) — standard (non-progressive) VarDCT decode
//!   Change 4 (acq_rel on GroupDone) — parallel multi-threaded decode
//!   Change 5 (RowInfo hoist) — all VarDCT decodes (saves 4 allocs per group)
//!   Change 6 (DecodeACFn cached) — all VarDCT decodes (eliminates branch per block)
//!   Change 7 (vectorisable GetBlockFromEncoder) — roundtrip path (encode→decode)
//!
//! Gate: ≥3% median improvement on any section = meaningful decode win.

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
mod bench {
    use raw_pipeline::jxl_casadecoder::{Channels, DecodeOptions, Decoder};
    use raw_pipeline::jxl_casaencoder::{EncodeOptions, Encoder, Frame, FrameSettingId};

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

        // warmup
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

        println!("=== jxl_dec_group_bench: dec_group.cc 7-change structural A/B ===");
        println!("warmup={WARMUP} iters={ITERS} nthreads={nthreads}\n");

        // ── Standard VarDCT decode (effort=5, single-pass) ───────────────────
        // Exercises Changes 2/3/5/6 (stack GetBlock, JpegGroupParams, RowInfo
        // hoist, DecodeACFn cache). No progressive passes → kDontDraw never fires.
        println!("--- effort=5 standard (single-pass VarDCT) ---");
        let opts_e5 = EncodeOptions::distance(1.0).with_effort(5);
        for &(w, h, label) in sizes {
            let pix = mkpix(w, h, 0xdeadbeef);
            let jxl = encode_jxl(&pix, w, h, &opts_e5);
            println!("  {label} encoded {}B", jxl.len());
            time_decode(label, &jxl, false, WARMUP, ITERS);
        }

        // ── Progressive AC decode (effort=5, progressive_ac=1) ───────────────
        // Exercises Change 1 (DecodeGroupNoDraw): intermediate kDontDraw passes
        // now bypass all render pipeline setup. Also exercises 2/5/6.
        println!("\n--- effort=5 progressive_ac (Change 1 — kDontDraw fast path) ---");
        let opts_prog = EncodeOptions {
            extra: vec![(FrameSettingId::ProgressiveAc, 1)],
            ..EncodeOptions::distance(1.0).with_effort(5)
        };
        for &(w, h, label) in sizes {
            let pix = mkpix(w, h, 0xdeadbeef);
            let jxl = encode_jxl(&pix, w, h, &opts_prog);
            println!("  {label} prog encoded {}B", jxl.len());
            time_decode(label, &jxl, false, WARMUP, ITERS);
        }

        // ── Progressive DC (effort=5, progressive_dc=2) ──────────────────────
        // Also exercises Change 1 on the DC pass; heavier progressive structure.
        println!("\n--- effort=5 progressive_dc=2 (Change 1 — DC kDontDraw) ---");
        let opts_pdc = EncodeOptions {
            progressive_dc: Some(2),
            extra: vec![(FrameSettingId::ProgressiveAc, 1)],
            ..EncodeOptions::distance(1.0).with_effort(5)
        };
        for &(w, h, label) in sizes {
            let pix = mkpix(w, h, 0xdeadbeef);
            let jxl = encode_jxl(&pix, w, h, &opts_pdc);
            println!("  {label} pdc encoded {}B", jxl.len());
            time_decode(label, &jxl, false, WARMUP, ITERS);
        }

        // ── Parallel decode — standard (Change 4 — acq_rel on GroupDone) ─────
        // Border-assigner atomic ordering matters only in parallel decode.
        println!("\n--- effort=5 standard  parallel={nthreads} (Change 4 — atomic ordering) ---");
        for &(w, h, label) in sizes {
            let pix = mkpix(w, h, 0xdeadbeef);
            let jxl = encode_jxl(&pix, w, h, &opts_e5);
            time_decode(label, &jxl, true, WARMUP, ITERS);
        }

        // ── Parallel decode — progressive (Changes 1+4 combined) ─────────────
        println!("\n--- effort=5 progressive_ac  parallel={nthreads} (Changes 1+4) ---");
        for &(w, h, label) in sizes {
            let pix = mkpix(w, h, 0xdeadbeef);
            let jxl = encode_jxl(&pix, w, h, &opts_prog);
            time_decode(label, &jxl, true, WARMUP, ITERS);
        }

        // ── Effort=7 standard (more AC passes → Change 6 impact larger) ──────
        // More passes → more DecodeACFn lookups per block. Change 6's cached
        // function pointer pays off proportionally to pass count.
        println!("\n--- effort=7 standard single-thread (Change 6 — DecodeACFn cache) ---");
        let opts_e7 = EncodeOptions::distance(1.0).with_effort(7);
        for &(w, h, label) in sizes {
            let pix = mkpix(w, h, 0xdeadbeef);
            let jxl = encode_jxl(&pix, w, h, &opts_e7);
            println!("  {label} e7 encoded {}B", jxl.len());
            time_decode(label, &jxl, false, WARMUP, ITERS);
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
    eprintln!(
        "requires: cargo run --release --example jxl_dec_group_bench (default features, native)"
    );
}
