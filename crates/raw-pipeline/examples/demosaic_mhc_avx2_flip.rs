//! demosaic_mhc_avx2_flip — native interleaved A/B for the AVX2 MHC interior
//! kernel (ADR-4 remainder; the quality-demosaic dominator):
//!
//!   A = pre-change interior-split scalar MHC (verbatim copy)
//!   B = production demosaic_bayer_mhc (AVX2 interior rows + scalar borders)
//!
//! Both arms run the production row-parallel driver. Bit-exact parity asserted
//! up front (also pinned by the in-crate avx2 test). Interleaved rounds with
//! start rotation; round 0 dropped; median per size.
//!
//! Run: cd crates/raw-pipeline &&
//!   ..\..\build-msvc.ps1 run --release --example demosaic_mhc_avx2_flip
#![allow(clippy::too_many_arguments)]
use raw_pipeline::demosaic::demosaic_bayer_mhc;
use rayon::prelude::*;
use std::time::Instant;

#[inline(always)]
fn at(plane: &[u16], stride: usize, r: usize, c: usize) -> i32 {
    plane[r * stride + c] as i32
}

#[inline(always)]
fn clampi(v: isize, lo: isize, hi: isize) -> usize {
    v.clamp(lo, hi) as usize
}

#[inline(always)]
fn mhc_pixel_phased(
    raw: &[u16], width: usize, r_c: usize, r_n: usize, r_s: usize, r_n2: usize, r_s2: usize,
    col: usize, c_w: usize, c_e: usize, c_w2: usize, c_e2: usize, phase: (usize, usize),
) -> (i32, i32, i32) {
    match ((r_c + phase.0) & 1, (col + phase.1) & 1) {
        (0, 0) => {
            let rc = at(raw, width, r_c, col);
            let gn = at(raw, width, r_n, col);
            let ge = at(raw, width, r_c, c_e);
            let gs = at(raw, width, r_s, col);
            let gw = at(raw, width, r_c, c_w);
            let rn2 = at(raw, width, r_n2, col);
            let re2 = at(raw, width, r_c, c_e2);
            let rs2 = at(raw, width, r_s2, col);
            let rw2 = at(raw, width, r_c, c_w2);
            let sum_g4 = gn + ge + gs + gw;
            let sum_d4 = rn2 + re2 + rs2 + rw2;
            let g_mhc = (2 * sum_g4 + 4 * rc - sum_d4) >> 3;
            let sum_b4 = at(raw, width, r_n, c_w) + at(raw, width, r_n, c_e)
                + at(raw, width, r_s, c_w) + at(raw, width, r_s, c_e);
            let b_v = sum_b4 >> 2;
            (rc, g_mhc.clamp(0, 65535), b_v.clamp(0, 65535))
        }
        (0, 1) => {
            let gc = at(raw, width, r_c, col);
            let re = at(raw, width, r_c, c_e);
            let rw = at(raw, width, r_c, c_w);
            let bn = at(raw, width, r_n, col);
            let bs = at(raw, width, r_s, col);
            let ge2 = at(raw, width, r_c, c_e2);
            let gw2 = at(raw, width, r_c, c_w2);
            let gn2 = at(raw, width, r_n2, col);
            let gs2 = at(raw, width, r_s2, col);
            let r_v = (2 * (re + rw) + 2 * gc - ge2 - gw2) >> 2;
            let b_v = (2 * (bn + bs) + 2 * gc - gn2 - gs2) >> 2;
            (r_v.clamp(0, 65535), gc, b_v.clamp(0, 65535))
        }
        (1, 0) => {
            let gc = at(raw, width, r_c, col);
            let rn = at(raw, width, r_n, col);
            let rs = at(raw, width, r_s, col);
            let be = at(raw, width, r_c, c_e);
            let bw = at(raw, width, r_c, c_w);
            let gn2 = at(raw, width, r_n2, col);
            let gs2 = at(raw, width, r_s2, col);
            let ge2 = at(raw, width, r_c, c_e2);
            let gw2 = at(raw, width, r_c, c_w2);
            let r_v = (2 * (rn + rs) + 2 * gc - gn2 - gs2) >> 2;
            let b_v = (2 * (be + bw) + 2 * gc - ge2 - gw2) >> 2;
            (r_v.clamp(0, 65535), gc, b_v.clamp(0, 65535))
        }
        _ => {
            let bc = at(raw, width, r_c, col);
            let gn = at(raw, width, r_n, col);
            let ge = at(raw, width, r_c, c_e);
            let gs = at(raw, width, r_s, col);
            let gw = at(raw, width, r_c, c_w);
            let bn2 = at(raw, width, r_n2, col);
            let be2 = at(raw, width, r_c, c_e2);
            let bs2 = at(raw, width, r_s2, col);
            let bw2 = at(raw, width, r_c, c_w2);
            let g_mhc = (2 * (gn + ge + gs + gw) + 4 * bc - bn2 - be2 - bs2 - bw2) >> 3;
            let r_v = (2 * (at(raw, width, r_n, c_e) + at(raw, width, r_n, c_w)
                + at(raw, width, r_s, c_e) + at(raw, width, r_s, c_w))
                + 4 * bc - bn2 - be2 - bs2 - bw2) >> 3;
            (r_v.clamp(0, 65535), g_mhc.clamp(0, 65535), bc)
        }
    }
}

/// Verbatim pre-AVX2 demosaic_bayer_mhc (interior-split scalar, row-parallel).
fn mhc_scalar(raw: &[u16], width: usize, height: usize, phase: (u8, u8)) -> Vec<u16> {
    let mut rgb = vec![0u16; width * height * 3];
    let w_max = (width - 1) as isize;
    let h_max = (height - 1) as isize;
    let phase = (phase.0 as usize, phase.1 as usize);
    let do_row = |row: usize, out_row: &mut [u16]| {
        let r = row as isize;
        let r_n = clampi(r - 1, 0, h_max);
        let r_s = clampi(r + 1, 0, h_max);
        let r_n2 = clampi(r - 2, 0, h_max);
        let r_s2 = clampi(r + 2, 0, h_max);
        let (int_start, int_end) = if width >= 4 { (2usize, width - 2) } else { (width, width) };
        for col in 0..int_start {
            let c = col as isize;
            let (rr, gg, bb) = mhc_pixel_phased(
                raw, width, row, r_n, r_s, r_n2, r_s2, col,
                clampi(c - 1, 0, w_max), clampi(c + 1, 0, w_max),
                clampi(c - 2, 0, w_max), clampi(c + 2, 0, w_max), phase,
            );
            let o = col * 3;
            out_row[o] = rr as u16; out_row[o + 1] = gg as u16; out_row[o + 2] = bb as u16;
        }
        for col in int_start..int_end {
            let (rr, gg, bb) = mhc_pixel_phased(
                raw, width, row, r_n, r_s, r_n2, r_s2, col,
                col - 1, col + 1, col - 2, col + 2, phase,
            );
            let o = col * 3;
            out_row[o] = rr as u16; out_row[o + 1] = gg as u16; out_row[o + 2] = bb as u16;
        }
        for col in int_end..width {
            let c = col as isize;
            let (rr, gg, bb) = mhc_pixel_phased(
                raw, width, row, r_n, r_s, r_n2, r_s2, col,
                clampi(c - 1, 0, w_max), clampi(c + 1, 0, w_max),
                clampi(c - 2, 0, w_max), clampi(c + 2, 0, w_max), phase,
            );
            let o = col * 3;
            out_row[o] = rr as u16; out_row[o + 1] = gg as u16; out_row[o + 2] = bb as u16;
        }
    };
    rgb.par_chunks_mut(width * 3).enumerate().for_each(|(row, out_row)| do_row(row, out_row));
    rgb
}

fn main() {
    if !std::is_x86_feature_detected!("avx2") {
        println!("avx2 unavailable — skipping");
        return;
    }
    let sizes = [(1600usize, 1200usize), (3000, 2000), (6000, 4000)];
    let med = |v: &[f64]| {
        let mut s: Vec<f64> = v[1..].to_vec();
        s.sort_by(|a, b| a.partial_cmp(b).unwrap());
        s[s.len() / 2]
    };

    println!("demosaic_mhc_avx2_flip   A=scalar interior-split   B=avx2 interior   (row-parallel, phase RGGB)");
    for (w, h) in sizes {
        let mut s: u32 = 0x9e37_79b9;
        let raw: Vec<u16> = (0..w * h)
            .map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (s >> 16) as u16
            })
            .collect();

        let a0 = mhc_scalar(&raw, w, h, (0, 0));
        let b0 = demosaic_bayer_mhc(&raw, w, h, (0, 0)).unwrap();
        let parity = a0 == b0;

        let rounds = 11usize;
        let mut times: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
        let mut sink = 0u64;
        for round in 0..rounds {
            for k in 0..2 {
                let which = (round + k) % 2;
                let t = Instant::now();
                let out = if which == 0 {
                    mhc_scalar(&raw, w, h, (0, 0))
                } else {
                    demosaic_bayer_mhc(&raw, w, h, (0, 0)).unwrap()
                };
                times[which].push(t.elapsed().as_secs_f64() * 1e3);
                sink = sink.wrapping_add(out[out.len() / 2] as u64);
            }
        }
        let (ma, mb) = (med(&times[0]), med(&times[1]));
        println!(
            "  {w}×{h} = {:.1} MP   parity(bit-exact): {}",
            (w * h) as f64 / 1e6,
            if parity { "PASS" } else { "FAIL" }
        );
        println!("    A scalar: {ma:.2} ms median");
        println!(
            "    B avx2:   {mb:.2} ms median   %saved {:+.1}%   {:.2}×   gate(≥5%): {}   (sink={sink})",
            (ma - mb) / ma * 100.0,
            ma / mb,
            if (ma - mb) / ma * 100.0 >= 5.0 { "PASS" } else { "FAIL" }
        );
    }
}
