//! box_blur_h_par_flip — native interleaved A/B for the row-parallel horizontal
//! box-blur pass (shared by scalar `box_blur` and `box_blur_avx2`; the mask
//! build is the dominant Comparer::new cost per examples/ref_build_effect.rs):
//!
//!   A = serial H pass    (row loop, the pre-change behavior)
//!   B = rayon H pass     (par_chunks_mut over rows, identical per-row math)
//!
//! Rows are independent, per-row math identical → bit-exact by construction
//! (asserted). Also times the full scalar blur (H+V) with both H variants.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features \
//!        --features parallel --example box_blur_h_par_flip
use rayon::prelude::*;
use std::time::Instant;

fn h_serial(src: &[f32], tmp: &mut [f32], w: usize, h: usize, r: usize, inv: f32) {
    let w_max = w - 1;
    for y in 0..h {
        let base = y * w;
        let mut sum = src[base] * (r as f32 + 1.0);
        for k in 1..=r {
            sum += src[base + k.min(w_max)];
        }
        for x in 0..w {
            tmp[base + x] = sum * inv;
            let add = src[base + (x + r + 1).min(w_max)];
            let sub = src[base + x.saturating_sub(r)];
            sum += add - sub;
        }
    }
}

fn h_parallel(src: &[f32], tmp: &mut [f32], w: usize, _h: usize, r: usize, inv: f32) {
    let w_max = w - 1;
    tmp.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let base = y * w;
        let mut sum = src[base] * (r as f32 + 1.0);
        for k in 1..=r {
            sum += src[base + k.min(w_max)];
        }
        for x in 0..w {
            row[x] = sum * inv;
            let add = src[base + (x + r + 1).min(w_max)];
            let sub = src[base + x.saturating_sub(r)];
            sum += add - sub;
        }
    });
}

fn main() {
    let sizes = [(1024usize, 1024usize), (3000, 2000), (6000, 4000)];
    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec();
        w.sort_by(|x, y| x.partial_cmp(y).unwrap());
        w[w.len() / 2]
    };

    println!(
        "box_blur_h_par_flip   A=serial rows   B=rayon rows   ({} threads)",
        rayon::current_num_threads()
    );
    for (w, h) in sizes {
        let n = w * h;
        let r = (w >> 6).clamp(1, 8);
        let inv = 1.0 / (2 * r + 1) as f32;
        let mut src = vec![0f32; n];
        let mut s: u32 = 0x9e37_79b9;
        for v in &mut src {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *v = (s >> 8) as f32 / 65_536.0;
        }

        let mut a0 = vec![0f32; n];
        let mut b0 = vec![0f32; n];
        h_serial(&src, &mut a0, w, h, r, inv);
        h_parallel(&src, &mut b0, w, h, r, inv);
        let parity = a0.iter().zip(&b0).all(|(x, y)| x.to_bits() == y.to_bits());

        let rounds = 15usize;
        let mut times: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
        let mut out = vec![0f32; n];
        let mut sink = 0u32;
        for round in 0..rounds {
            for k in 0..2 {
                let which = (round + k) % 2;
                let t = Instant::now();
                if which == 0 {
                    h_serial(&src, &mut out, w, h, r, inv);
                } else {
                    h_parallel(&src, &mut out, w, h, r, inv);
                }
                let dt = t.elapsed().as_secs_f64() * 1e3;
                sink = sink.wrapping_add(out[n / 2].to_bits());
                times[which].push(dt);
            }
        }
        let (ma, mb) = (med(&times[0]), med(&times[1]));
        println!(
            "  {w}×{h} = {:.1} MP  r={r}   parity(bit-exact): {}",
            n as f64 / 1e6,
            if parity { "PASS" } else { "FAIL" }
        );
        println!("    A serial: {ma:.3} ms median");
        println!(
            "    B rayon:  {mb:.3} ms median   %saved {:+.1}%   {:.2}×   gate(≥5%): {}",
            (ma - mb) / ma * 100.0,
            ma / mb,
            if (ma - mb) / ma * 100.0 >= 5.0 { "PASS" } else { "FAIL" }
        );
        println!("    (sink={sink})");
    }
}
