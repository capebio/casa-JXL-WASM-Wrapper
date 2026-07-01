//! ref_build_effect — measures the effect of dispatching the reference-pyramid
//! build (Comparer::new) through the SIMD kernels instead of the scalar fallback.
//!
//! `Comparer::new` does ONLY reference-side work (RGBA→XYB + pyramid downsample +
//! mask blur + ref SSIM moments); it never touches a test image. So:
//!   A = Comparer::new(ForceScalar)  reproduces the OLD all-scalar ref build
//!   B = Comparer::new(Auto = AVX2)  is the NEW dispatched (scalar-LUT + downsample_avx2) build
//! Their ratio is exactly the speedup this change delivers — diluted by the
//! blur + ref_moments steps that are scalar in both arms (the honest whole-
//! construction figure, not the kernel-only 2.6×).
//!
//! Second half: the OUTPUT shift. Going SIMD on the ref side moves butteraugli/
//! ssim/psnr by the scalar↔fmadd rounding gap; this reports the max relative
//! delta on a real test image so "≤~1e-5, below any threshold" is a number.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example ref_build_effect
use raw_pipeline::perceptual::{BackendChoice, Comparer, Opts};
use std::time::Instant;

fn det_rgba(n: usize, seed: u32) -> Vec<u8> {
    let mut s = seed;
    let mut v = vec![0u8; n * 4];
    for b in &mut v {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *b = (s >> 24) as u8;
    }
    v
}

fn main() {
    if !(std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma")) {
        println!("avx2+fma unavailable — skipping");
        return;
    }
    let sizes = [(1024usize, 1024usize), (3000, 2000), (6000, 4000)]; // 1, 6, 24 MP
    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec(); // drop warm-up
        w.sort_by(|x, y| x.partial_cmp(y).unwrap());
        w[w.len() / 2]
    };
    let scalar_opts = || Opts { backend: BackendChoice::ForceScalar, ..Opts::default() };
    let auto_opts = || Opts { backend: BackendChoice::Auto, ..Opts::default() };

    println!("ref_build_effect   A=Comparer::new(scalar ref)   B=Comparer::new(SIMD ref)");
    for (w, h) in sizes {
        let n = w * h;
        let refimg = det_rgba(n, 0x9e37_79b9);
        let test = det_rgba(n, 0x1234_5678);

        // --- construction timing (interleaved, start-rotated) ---
        let rounds = 9usize;
        let mut times: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
        let mut sink = 0u32;
        for r in 0..rounds {
            for k in 0..2 {
                let which = (r + k) % 2;
                let opts = if which == 0 { scalar_opts() } else { auto_opts() };
                let src = refimg.clone(); // clone outside timer (new() consumes it)
                let t = Instant::now();
                let cmp = Comparer::new(src, w, h, opts);
                let dt = t.elapsed().as_secs_f64() * 1e3;
                sink = sink.wrapping_add(cmp.psnr(&test).to_bits());
                times[which].push(dt);
            }
        }
        let (ma, mb) = (med(&times[0]), med(&times[1]));

        // --- output shift: same test under all-scalar vs SIMD-ref comparer ---
        let mut cs = Comparer::new(refimg.clone(), w, h, scalar_opts());
        let mut cb = Comparer::new(refimg.clone(), w, h, auto_opts());
        let rel = |x: f32, y: f32| (x - y).abs() / x.abs().max(y.abs()).max(1e-12);
        let (bs, bb) = (cs.butteraugli(&test), cb.butteraugli(&test));
        let (ss, sb) = (cs.ssim(&test), cb.ssim(&test));
        let (ps, pb) = (cs.psnr(&test), cb.psnr(&test));

        println!("  {w}×{h} = {:.1} MP", n as f64 / 1e6);
        println!("    A scalar ref-build:  {ma:.3} ms median");
        println!(
            "    B SIMD   ref-build:  {mb:.3} ms median   %saved {:+.1}%   {:.2}×",
            (ma - mb) / ma * 100.0,
            ma / mb
        );
        println!(
            "    output shift (scalar vs SIMD ref):  butteraugli rel {:.2e}  ssim rel {:.2e}  psnr rel {:.2e}",
            rel(bs, bb),
            rel(ss, sb),
            rel(ps, pb)
        );
        println!("    (sink={sink})");
    }
}
