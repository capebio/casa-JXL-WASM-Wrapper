//! AC-strategy entropy-kernel encode bench (premium high-effort path).
//!
//! Times `encode_into` on a real photo crop at a chosen effort, and (optionally)
//! dumps the encoded `.jxl` bytes so an external driver can byte-compare two
//! builds — the decision-ordering test for "byte-exact" cleanups in
//! `enc_ac_strategy.cc`.
//!
//! The AC-strategy selection kernel (EstimateEntropy + merge) only runs at
//! speed_tier <= kHare, i.e. effort >= 5; the floating/non-aligned duplicate
//! evaluations that the memoization targets run at speed_tier < kHare (effort
//! >= 6). So bench at effort 7 (kSquirrel) and 9 (kTortoise).
//!
//! Usage:
//!   acs_effort_bench <ppm> <effort> <reps> [out.jxl] [crop_w crop_h]
//!
//! Workflow (driven by run-acs-ab.ps1):
//!   1. build baseline -> copy exe -> acs_bench_baseline.exe
//!   2. apply edits, build -> acs_bench_variant.exe
//!   3. interleave both, compare min-ms (2% gate) + cmp out.jxl (byte-exact).

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
mod bench {
    use raw_pipeline::jxl_casaencoder::{EncodeOptions, Encoder, Frame};
    use std::io::Write;

    /// Minimal binary P6 PPM parser. Returns (w, h, rgb-bytes).
    fn parse_p6(bytes: &[u8]) -> (u32, u32, Vec<u8>) {
        // Expect "P6" then w h maxval, whitespace/comment separated.
        let mut vals: Vec<u64> = Vec::with_capacity(3);
        assert!(bytes[0] == b'P' && bytes[1] == b'6', "not a P6 PPM");
        let mut i = 2usize; // skip magic
        while vals.len() < 3 {
            // skip whitespace
            while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r') {
                i += 1;
            }
            // skip comment
            if i < bytes.len() && bytes[i] == b'#' {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            let s = i;
            while i < bytes.len() && !matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r') {
                i += 1;
            }
            let n: u64 = std::str::from_utf8(&bytes[s..i]).unwrap().parse().unwrap();
            vals.push(n);
        }
        i += 1; // single whitespace after maxval
        let (w, h) = (vals[0] as u32, vals[1] as u32);
        let need = (w as usize) * (h as usize) * 3;
        let rgb = bytes[i..i + need].to_vec();
        (w, h, rgb)
    }

    /// Center-crop a cw x ch region from a w x h RGB buffer.
    fn crop_center(rgb: &[u8], w: u32, h: u32, cw: u32, ch: u32) -> (u32, u32, Vec<u8>) {
        let cw = cw.min(w);
        let ch = ch.min(h);
        let x0 = (w - cw) / 2;
        let y0 = (h - ch) / 2;
        let mut out = Vec::with_capacity((cw as usize) * (ch as usize) * 3);
        for y in 0..ch {
            let src = (((y0 + y) as usize) * (w as usize) + x0 as usize) * 3;
            out.extend_from_slice(&rgb[src..src + (cw as usize) * 3]);
        }
        (cw, ch, out)
    }

    pub fn run() {
        let args: Vec<String> = std::env::args().collect();
        if args.len() < 4 {
            eprintln!("usage: acs_effort_bench <ppm> <effort> <reps> [out.jxl] [crop_w crop_h]");
            std::process::exit(2);
        }
        let ppm = &args[1];
        let effort: u8 = args[2].parse().unwrap();
        let reps: usize = args[3].parse().unwrap();
        let out_path = args.get(4).cloned();
        let cw: u32 = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(1920);
        let ch: u32 = args.get(6).and_then(|s| s.parse().ok()).unwrap_or(1280);
        let warmup: usize = args.get(7).and_then(|s| s.parse().ok()).unwrap_or(3);

        let raw = std::fs::read(ppm).expect("read ppm");
        let (w0, h0, rgb0) = parse_p6(&raw);
        let (w, h, rgb) = crop_center(&rgb0, w0, h0, cw, ch);

        let opts = EncodeOptions::distance(1.0).with_effort(effort);
        let frame = Frame::rgb(&rgb, w, h);
        // JXL_BENCH_THREADS=1 gives a low-noise single-thread measurement under
        // multi-process contention; default = all cores.
        let nthreads = std::env::var("JXL_BENCH_THREADS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| {
                std::thread::available_parallelism()
                    .map(|n| n.get())
                    .unwrap_or(8)
            });
        let mut enc = if nthreads > 1 {
            Encoder::with_threads(opts.clone(), nthreads).expect("encoder")
        } else {
            Encoder::new(opts.clone()).expect("encoder")
        };

        let mut out: Vec<u8> = Vec::with_capacity(rgb.len() / 2);
        // warmup
        for _ in 0..warmup {
            out.clear();
            enc.encode_into(&frame, &mut out).expect("warmup");
        }
        let mut times = Vec::with_capacity(reps);
        for _ in 0..reps {
            out.clear();
            let t = std::time::Instant::now();
            enc.encode_into(&frame, &mut out).expect("encode");
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let min = times[0];
        let med = times[times.len() / 2];
        // Machine-parseable line: RESULT <wxh> e<effort> min=.. med=.. size=..
        println!(
            "RESULT {}x{} e{} min={:.3} med={:.3} size={} threads={}",
            w,
            h,
            effort,
            min,
            med,
            out.len(),
            nthreads
        );
        if let Some(p) = out_path {
            let mut f = std::fs::File::create(&p).expect("create out");
            f.write_all(&out).expect("write out");
        }
    }
}

fn main() {
    #[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
    bench::run();
    #[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
    eprintln!("requires native + jxl-codec feature");
}
