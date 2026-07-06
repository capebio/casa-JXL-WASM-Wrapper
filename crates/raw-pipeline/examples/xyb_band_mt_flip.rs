//! xyb_band_mt_flip — native A/B for the pixel-band-parallel XYB conversion
//! (`convert_xyb` dispatch banding; kernel = `pixels_to_xyb_avx2_scalar_lut`):
//!
//!   A = serial   (one kernel call over all pixels — pre-change dispatch)
//!   B = parallel (1M-px rayon bands calling the same kernel on subslices —
//!                 local replica of the landed mod.rs banding, which is private)
//!
//! The conversion is a pure per-pixel map → banding is unconditionally
//! bit-identical (asserted). Interleaved, start-rotated, round 0 dropped, median.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --example xyb_band_mt_flip
use raw_pipeline::perceptual::avx2_kernels::pixels_to_xyb_avx2_scalar_lut;
use std::time::Instant;

/// Local sqrt-linear LUT replica (crate `xyb` module is private; same shape as
/// the production table — the flip compares band-split vs serial, not tables).
fn build_lut() -> [f32; 256] {
    let mut lut = [0f32; 256];
    for (i, v) in lut.iter_mut().enumerate() {
        let u = i as f32 / 255.0;
        let lin = if u <= 0.04045 {
            u / 12.92
        } else {
            ((u + 0.055) / 1.055).powf(2.4)
        };
        *v = lin.sqrt();
    }
    lut
}

#[cfg(not(target_arch = "x86_64"))]
fn main() {
    println!("x86_64 only");
}

#[cfg(target_arch = "x86_64")]
fn main() {
    if !(std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma")) {
        println!("avx2+fma unavailable — skipping");
        return;
    }
    let lut = build_lut();
    let sizes = [(2048usize, 1100usize), (3000, 2000), (6000, 4000)]; // 2.25, 6, 24 MP
    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec();
        w.sort_by(|x, y| x.partial_cmp(y).unwrap());
        w[w.len() / 2]
    };
    const BAND_PX: usize = 1 << 20;

    println!(
        "xyb_band_mt_flip   A=serial   B=parallel-bands   threads={}",
        rayon::current_num_threads()
    );
    for (w, h) in sizes {
        let n = w * h;
        let mut px = vec![0u8; n * 4];
        let mut s: u32 = 0x9e37_79b9;
        for v in &mut px {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *v = (s >> 16) as u8;
        }

        let banded = |px: &[u8], x: &mut [f32], y: &mut [f32], b: &mut [f32]| {
            use rayon::prelude::*;
            x[..n].par_chunks_mut(BAND_PX)
                .zip(y[..n].par_chunks_mut(BAND_PX))
                .zip(b[..n].par_chunks_mut(BAND_PX))
                .enumerate()
                .for_each(|(k, ((xb, yb), bb))| {
                    let p0 = k * BAND_PX;
                    let m = xb.len();
                    unsafe {
                        pixels_to_xyb_avx2_scalar_lut(
                            &px[p0 * 4..(p0 + m) * 4],
                            m,
                            &lut,
                            xb,
                            yb,
                            bb,
                        )
                    };
                });
        };

        let (mut xa, mut ya, mut ba) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        let (mut xb, mut yb, mut bb) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        unsafe { pixels_to_xyb_avx2_scalar_lut(&px, n, &lut, &mut xa, &mut ya, &mut ba) };
        banded(&px, &mut xb, &mut yb, &mut bb);
        let parity = xa.iter().zip(&xb).all(|(p, q)| p.to_bits() == q.to_bits())
            && ya.iter().zip(&yb).all(|(p, q)| p.to_bits() == q.to_bits())
            && ba.iter().zip(&bb).all(|(p, q)| p.to_bits() == q.to_bits());

        let rounds = 11usize;
        let mut times: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
        let mut sink = 0u32;
        for round in 0..rounds {
            for k in 0..2 {
                let which = (round + k) % 2;
                let t = Instant::now();
                if which == 0 {
                    unsafe {
                        pixels_to_xyb_avx2_scalar_lut(&px, n, &lut, &mut xa, &mut ya, &mut ba)
                    };
                    sink = sink.wrapping_add(ya[n / 2].to_bits());
                } else {
                    banded(&px, &mut xb, &mut yb, &mut bb);
                    sink = sink.wrapping_add(yb[n / 2].to_bits());
                }
                let dt = t.elapsed().as_secs_f64() * 1e3;
                times[which].push(dt);
            }
        }
        let (ma, mb) = (med(&times[0]), med(&times[1]));
        println!(
            "  {w}×{h} = {:.1} MP   parity(bit-exact): {}",
            n as f64 / 1e6,
            if parity { "PASS" } else { "FAIL" }
        );
        println!("    A serial:          {ma:.3} ms median");
        println!(
            "    B parallel-bands:  {mb:.3} ms median   %saved {:+.1}%   {:.2}×   gate(≥5%): {}",
            (ma - mb) / ma * 100.0,
            ma / mb,
            if (ma - mb) / ma * 100.0 >= 5.0 {
                "PASS"
            } else {
                "FAIL"
            }
        );
        println!("    (sink={sink})");
    }
}
