//! xyb_gather_flip — native A/B for the AVX2 RGBA(u8)→planar XYB kernels:
//!
//!   A = pixels_to_xyb_avx2            (i32-gather: 3× vgatherdps per 8 px)
//!   B = pixels_to_xyb_avx2_scalar_lut (24 scalar L1 LUT loads + 2× vinsertf128)
//!
//! The question: does replacing the gathers with scalar LUT assembly win on this
//! box, and does the win survive at 24 MP where the three streamed planar writes
//! grow? Variants run interleaved A/B with per-round start rotation so thermal/
//! system drift hits both arms equally; round 0 (warm-up) is dropped; median
//! reported per size. Parity is bit-exact — both emit identical f32 bit patterns
//! by construction. (A 16-px gather-unroll control was also flipped here; it only
//! recovered ~8–14% vs B's ~62%, so it was dropped — see the branch's results.)
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example xyb_gather_flip
use raw_pipeline::perceptual::avx2_kernels::{pixels_to_xyb_avx2, pixels_to_xyb_avx2_scalar_lut};
use std::time::Instant;

/// Same sqrt(sRGB-decode(i/255)) table as `perceptual::xyb` (which is pub(crate),
/// so rebuilt here). Any consistent 256-entry table proves parity; this one keeps
/// the gather indices realistic.
fn build_lut() -> [f32; 256] {
    let mut t = [0f32; 256];
    for (i, slot) in t.iter_mut().enumerate() {
        let v = i as f64 / 255.0;
        let lin = if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        };
        *slot = lin.sqrt() as f32;
    }
    t
}

fn main() {
    if !(std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma")) {
        println!("avx2+fma unavailable on this CPU — skipping");
        return;
    }
    let lut = build_lut();
    let sizes = [(1024usize, 1024usize), (3000, 2000), (6000, 4000)]; // 1, 6, 24 MP

    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec(); // drop warm-up round 0
        w.sort_by(|x, y| x.partial_cmp(y).unwrap());
        w[w.len() / 2]
    };

    println!("xyb_gather_flip   A=gather   B=scalar-LUT");
    for (w, h) in sizes {
        let n = w * h;
        let mut px = vec![0u8; n * 4];
        let mut s: u32 = 0x9e37_79b9;
        for v in &mut px {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *v = (s >> 24) as u8;
        }
        let (mut ax, mut ay, mut ab) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        let (mut bx, mut by, mut bb) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);

        // Parity (bit-exact), computed up front.
        unsafe {
            pixels_to_xyb_avx2(&px, n, &lut, &mut ax, &mut ay, &mut ab);
            pixels_to_xyb_avx2_scalar_lut(&px, n, &lut, &mut bx, &mut by, &mut bb);
        }
        let bits = |v: &[f32]| v.iter().map(|f| f.to_bits()).collect::<Vec<u32>>();
        let parity = bits(&ax) == bits(&bx) && bits(&ay) == bits(&by) && bits(&ab) == bits(&bb);

        let rounds = 11usize;
        let mut times: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
        let mut sink = 0u32;
        for r in 0..rounds {
            for k in 0..2 {
                let which = (r + k) % 2; // start-rotation cancels per-round drift bias
                let t = Instant::now();
                unsafe {
                    if which == 0 {
                        pixels_to_xyb_avx2(&px, n, &lut, &mut ax, &mut ay, &mut ab);
                    } else {
                        pixels_to_xyb_avx2_scalar_lut(&px, n, &lut, &mut bx, &mut by, &mut bb);
                    }
                }
                let dt = t.elapsed().as_secs_f64() * 1e3;
                sink = sink.wrapping_add(if which == 0 {
                    ax[n / 2].to_bits()
                } else {
                    bx[n / 2].to_bits()
                });
                times[which].push(dt);
            }
        }
        let (ma, mb) = (med(&times[0]), med(&times[1]));
        println!(
            "  {w}×{h} = {:.1} MP   parity(bit-exact): {}",
            n as f64 / 1e6,
            if parity { "PASS" } else { "FAIL" }
        );
        println!("    A gather:      {ma:.3} ms median");
        println!(
            "    B scalar-LUT:  {mb:.3} ms median   %saved {:+.1}%   {:.2}×   gate(≥5%): {}",
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
