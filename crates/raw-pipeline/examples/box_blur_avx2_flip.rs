//! box_blur_avx2_flip — native A/B for the separable box-blur (the reference-mask
//! kernel, the dominant Comparer::new cost per examples/ref_build_effect.rs):
//!
//!   A = scalar box_blur       (SSE2-baseline tiled vertical pass)
//!   B = box_blur_avx2         (8-wide AVX2 vertical pass, shared scalar H pass)
//!
//! The scalar `blur::box_blur` is pub(crate), so the A arm carries a verbatim copy
//! (kept honest by a bit-exact parity check against B before timing). Variants run
//! interleaved with per-round start rotation; round 0 (warm-up) dropped; median per
//! size at the production radius r=min(w>>6,8). Parity is bit-exact by construction
//! (identical per-column float ops; only the vector width differs).
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example box_blur_avx2_flip
use raw_pipeline::perceptual::avx2_kernels::box_blur_avx2;
use std::time::Instant;

/// Verbatim copy of `blur::box_blur` (pub(crate)) — the A-arm timing baseline.
fn scalar_box_blur(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let n = w * h;
    if n == 0 {
        return Vec::new();
    }
    let mut tmp = vec![0f32; n];
    let mut dst = vec![0f32; n];
    let inv = 1.0 / (2 * r + 1) as f32;
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
    const TILE: usize = 8;
    let h_max = h - 1;
    let mut x = 0usize;
    while x + TILE <= w {
        let mut sums = [0f32; TILE];
        for t in 0..TILE {
            sums[t] = tmp[x + t] * (r as f32 + 1.0);
        }
        for k in 1..=r {
            let row = k.min(h_max) * w;
            for t in 0..TILE {
                sums[t] += tmp[row + x + t];
            }
        }
        for y in 0..h {
            let drow = y * w;
            for t in 0..TILE {
                dst[drow + x + t] = sums[t] * inv;
            }
            let add_row = (y + r + 1).min(h_max) * w;
            let sub_row = y.saturating_sub(r) * w;
            for t in 0..TILE {
                sums[t] += tmp[add_row + x + t] - tmp[sub_row + x + t];
            }
        }
        x += TILE;
    }
    for col in x..w {
        let mut sum = tmp[col] * (r as f32 + 1.0);
        for k in 1..=r {
            sum += tmp[k.min(h - 1) * w + col];
        }
        for y in 0..h {
            dst[y * w + col] = sum * inv;
            let add = tmp[(y + r + 1).min(h - 1) * w + col];
            let sub = tmp[y.saturating_sub(r) * w + col];
            sum += add - sub;
        }
    }
    dst
}

fn main() {
    if !std::is_x86_feature_detected!("avx2") {
        println!("avx2 unavailable — skipping");
        return;
    }
    let sizes = [(1024usize, 1024usize), (3000, 2000), (6000, 4000)]; // 1, 6, 24 MP
    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec();
        w.sort_by(|x, y| x.partial_cmp(y).unwrap());
        w[w.len() / 2]
    };

    println!("box_blur_avx2_flip   A=scalar   B=avx2");
    for (w, h) in sizes {
        let n = w * h;
        let r = (w >> 6).clamp(1, 8); // production mask radius
        let mut src = vec![0f32; n];
        let mut s: u32 = 0x9e37_79b9;
        for v in &mut src {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *v = (s >> 8) as f32 / 65_536.0;
        }

        // Parity (bit-exact) up front.
        let a0 = scalar_box_blur(&src, w, h, r);
        let b0 = unsafe { box_blur_avx2(&src, w, h, r) };
        let parity = a0.iter().zip(&b0).all(|(x, y)| x.to_bits() == y.to_bits());

        let rounds = 9usize;
        let mut times: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
        let mut sink = 0u32;
        for round in 0..rounds {
            for k in 0..2 {
                let which = (round + k) % 2;
                let t = Instant::now();
                let out = if which == 0 {
                    scalar_box_blur(&src, w, h, r)
                } else {
                    unsafe { box_blur_avx2(&src, w, h, r) }
                };
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
        println!("    A scalar:  {ma:.3} ms median");
        println!(
            "    B avx2:    {mb:.3} ms median   %saved {:+.1}%   {:.2}×   gate(≥5%): {}",
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
