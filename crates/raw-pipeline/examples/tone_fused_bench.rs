//! Fused tone+LUT vs two-pass (caller-style per-block zeroed SoA). Blueprint Ch.10:
//! measure the effect of eliminating per-block zeroing + the SoA round-trip.
//!
//! NB: the path is gather-bound, so fused currently runs ~0.8–0.9x the two-pass.
//! Kept as the measurement of record — it flips to a win once the LUT-gather /
//! JS↔WASM boundary cost is reduced (see docs/ToneSimd-LutGather-JsWasm-handoff.md).
//! Run: cargo run --release --no-default-features --example tone_fused_bench

use raw_pipeline::tone_simd::{apply_tone_bulk, apply_tone_fused_u16_u8};
use std::time::Instant;

const M: [[f32; 3]; 3] = [[1.7, -0.5, -0.2], [-0.3, 1.4, -0.1], [0.0, -0.4, 1.4]];

// Caller-style: a fresh `[0f32; BLK]` zeroed every block, full SoA fill → tone → post.
fn two_pass(
    rgb16: &[u16],
    pre: &[u16],
    post: &[u8],
    out: &mut [u8],
    np: usize,
    sat: f32,
    vib: f32,
    vz: bool,
) {
    const BLK: usize = 2048;
    let mut p = 0;
    while p < np {
        let cnt = (np - p).min(BLK);
        let mut r = [0f32; BLK];
        let mut g = [0f32; BLK];
        let mut b = [0f32; BLK];
        for i in 0..cnt {
            let j = 3 * (p + i);
            r[i] = pre[rgb16[j] as usize] as f32;
            g[i] = pre[rgb16[j + 1] as usize] as f32;
            b[i] = pre[rgb16[j + 2] as usize] as f32;
        }
        apply_tone_bulk(
            &mut r[..cnt],
            &mut g[..cnt],
            &mut b[..cnt],
            &M,
            sat,
            vib,
            vz,
        );
        for i in 0..cnt {
            let j = 3 * (p + i);
            out[j] = post[(r[i].clamp(0.0, 65535.0) as u16) as usize];
            out[j + 1] = post[(g[i].clamp(0.0, 65535.0) as u16) as usize];
            out[j + 2] = post[(b[i].clamp(0.0, 65535.0) as u16) as usize];
        }
        p += cnt;
    }
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn run(
    label: &str,
    rgb16: &[u16],
    pre: &[u16],
    post: &[u8],
    out: &mut [u8],
    np: usize,
    sat: f32,
    vib: f32,
    vz: bool,
) {
    let rounds = 7;
    two_pass(rgb16, pre, post, out, np, sat, vib, vz); // warmup
    apply_tone_fused_u16_u8(rgb16, pre, pre, pre, post, &M, sat, vib, vz, out);
    let mut tp = Vec::new();
    let mut fu = Vec::new();
    for _ in 0..rounds {
        let t = Instant::now();
        two_pass(rgb16, pre, post, out, np, sat, vib, vz);
        std::hint::black_box(&out[0]);
        tp.push(t.elapsed().as_secs_f64() * 1000.0);
        let t = Instant::now();
        apply_tone_fused_u16_u8(rgb16, pre, pre, pre, post, &M, sat, vib, vz, out);
        std::hint::black_box(&out[0]);
        fu.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    let (m_tp, m_fu) = (median(tp), median(fu));
    println!(
        "  {:<22} two-pass {:7.2} ms  |  fused {:7.2} ms  |  {:.2}x",
        label,
        m_tp,
        m_fu,
        m_tp / m_fu
    );
}

fn main() {
    let np = 8_000_000usize; // ~8 MP
    let pre: Vec<u16> = (0..=65535u32).map(|x| x as u16).collect();
    let post: Vec<u8> = (0..=65535u32).map(|x| (x >> 8) as u8).collect();
    let mut rgb16 = vec![0u16; np * 3];
    for i in 0..np {
        rgb16[3 * i] = (i.wrapping_mul(7919) & 0xffff) as u16;
        rgb16[3 * i + 1] = (i.wrapping_mul(104729) & 0xffff) as u16;
        rgb16[3 * i + 2] = (i.wrapping_mul(1299709) & 0xffff) as u16;
    }
    let mut out = vec![0u8; np * 3];
    println!(
        "fused tone+LUT vs two-pass — {} MP, median of 7 rounds (single-thread)",
        np / 1_000_000
    );
    run(
        "vib_zero (sat only)",
        &rgb16,
        &pre,
        &post,
        &mut out,
        np,
        1.30,
        0.0,
        true,
    );
    run(
        "vibrance active (div)",
        &rgb16,
        &pre,
        &post,
        &mut out,
        np,
        1.30,
        0.5,
        false,
    );

    // 12-bit compact LUT (4096 entries) — simulates post-Task-2 cache-resident scenario.
    // rgb16 values bounded to [0, 4095] and identity pre-LUT has 4096 entries.
    let pre12: Vec<u16> = (0..4096u32).map(|x| (x * 16) as u16).collect();
    let mut rgb16_12: Vec<u16> = vec![0u16; np * 3];
    for i in 0..np {
        rgb16_12[3 * i] = (rgb16[3 * i] & 0x0FFF) as u16;
        rgb16_12[3 * i + 1] = (rgb16[3 * i + 1] & 0x0FFF) as u16;
        rgb16_12[3 * i + 2] = (rgb16[3 * i + 2] & 0x0FFF) as u16;
    }
    println!("\n--- 12-bit compact pre-LUT (4096 entries, L1-resident) ---");
    run(
        "vib_zero (compact)",
        &rgb16_12,
        &pre12,
        &post,
        &mut out,
        np,
        1.30,
        0.0,
        true,
    );
    run(
        "vibrance (compact)",
        &rgb16_12,
        &pre12,
        &post,
        &mut out,
        np,
        1.30,
        0.5,
        false,
    );
}
