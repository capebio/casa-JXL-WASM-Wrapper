//! comparer_scratch_flip — native A/B for the Comparer 6-plane scratch allocation
//! (PERC-13: tx/ty/tb/dx/dy/db in `Comparer::new`):
//!
//!   A = zeroed   (`vec![0f32; n]` × 6 — the old path: alloc_zeroed / memset)
//!   B = uninit   (`Vec::with_capacity + set_len` × 6 — the landed path)
//!
//! Both arms then FULLY WRITE all six planes (simulating the first
//! `fill_test_xyb`/`downsample_one` pass that the production contract guarantees
//! before any read) and fold a checksum, so the only difference timed is the dead
//! zero-init. Interleaved with per-round start rotation; round 0 dropped; median.
//! NOTE: fresh OS pages are already zeroed (alloc_zeroed can be ~free on first
//! touch); the win materialises on allocator REUSE — exactly what rounds ≥1 of an
//! interleaved loop measure, and what a warm process / wasm heap sees in practice.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example comparer_scratch_flip
use std::hint::black_box;
use std::time::Instant;

fn uninit_f32_vec(n: usize) -> Vec<f32> {
    let mut v: Vec<f32> = Vec::with_capacity(n);
    // SAFETY: fully written below before any read (mirrors perceptual::uninit_f32_vec).
    unsafe {
        v.set_len(n);
    }
    v
}

fn write_all(planes: &mut [Vec<f32>; 6], n: usize) -> f32 {
    // Simulates the first full write pass (convert_xyb / downsample_one targets).
    let mut acc = 0f32;
    for (i, p) in planes.iter_mut().enumerate() {
        let base = i as f32 * 0.25;
        for (j, v) in p.iter_mut().enumerate() {
            *v = base + (j & 1023) as f32;
        }
        acc += p[n / 2];
    }
    acc
}

fn main() {
    let sizes = [(1024usize, 1024usize), (3000, 2000), (6000, 4000)]; // 1, 6, 24 MP
    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec();
        w.sort_by(|x, y| x.partial_cmp(y).unwrap());
        w[w.len() / 2]
    };

    println!("comparer_scratch_flip   A=zeroed(vec![0f32;n]×6)   B=uninit(set_len×6)");
    for (w, h) in sizes {
        let n = w * h;
        let rounds = 11usize;
        let mut times: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
        let mut sink = 0f32;
        for round in 0..rounds {
            for k in 0..2 {
                let which = (round + k) % 2;
                let t = Instant::now();
                let mut planes: [Vec<f32>; 6] = if which == 0 {
                    [
                        vec![0f32; n],
                        vec![0f32; n],
                        vec![0f32; n],
                        vec![0f32; n],
                        vec![0f32; n],
                        vec![0f32; n],
                    ]
                } else {
                    [
                        uninit_f32_vec(n),
                        uninit_f32_vec(n),
                        uninit_f32_vec(n),
                        uninit_f32_vec(n),
                        uninit_f32_vec(n),
                        uninit_f32_vec(n),
                    ]
                };
                sink += write_all(black_box(&mut planes), n);
                let dt = t.elapsed().as_secs_f64() * 1e3;
                drop(black_box(planes));
                times[which].push(dt);
            }
        }
        let (ma, mb) = (med(&times[0]), med(&times[1]));
        println!("  {w}×{h} = {:.1} MP", n as f64 / 1e6);
        println!("    A zeroed:  {ma:.3} ms median");
        println!(
            "    B uninit:  {mb:.3} ms median   %saved {:+.1}%   {:.2}×   gate(≥5%): {}",
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
