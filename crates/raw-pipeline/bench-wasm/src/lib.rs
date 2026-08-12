//! wasm-bindgen bench shims for the perceptual PSNR (SSD) kernel.
//!
//! Exposes the real v128 `ssd_wasm` from raw-pipeline alongside an independent
//! scalar reference, so the node harness can (a) assert exact parity and (b) time
//! SIMD vs scalar in a real wasm runtime. `bench()` runs the inner loop entirely
//! inside wasm, so the wasm-bindgen slice copy is paid once per call, not per iter.

use wasm_bindgen::prelude::*;
use raw_pipeline::perceptual::wasm_kernels::{ssd_wasm, ssim_moments_wasm};

/// Independent scalar SSD — deliberately NOT the crate's own scalar (cross-checks
/// the SIMD kernel against a separate implementation, not a self-referential one).
#[inline]
fn ssd_scalar(a: &[u8], b: &[u8]) -> u64 {
    let mut sum = 0u64;
    for i in 0..a.len() {
        let d = a[i] as i64 - b[i] as i64;
        sum += (d * d) as u64;
    }
    sum
}

/// Single SSD via the SIMD kernel. Returned as f64 (exact for SSD < 2^53 ≈ 9e15;
/// a 24MP RGBA buffer maxes at ~100M·255² ≈ 6.5e12, well inside exact range).
#[wasm_bindgen]
pub fn ssd_simd_once(a: &[u8], b: &[u8]) -> f64 {
    ssd_wasm(a, b) as f64
}

/// Single SSD via the scalar reference.
#[wasm_bindgen]
pub fn ssd_scalar_once(a: &[u8], b: &[u8]) -> f64 {
    ssd_scalar(a, b) as f64
}

/// Run `iters` SSDs over the same pair entirely inside wasm; return the SSD of the
/// last iteration (also the parity value). `simd=true` exercises the v128 kernel.
/// JS times the wrapping call, so per-iter cost excludes the boundary copy.
#[wasm_bindgen]
pub fn bench(a: &[u8], b: &[u8], iters: u32, simd: bool) -> f64 {
    let mut last = 0u64;
    for _ in 0..iters {
        last = if simd { ssd_wasm(a, b) } else { ssd_scalar(a, b) };
        // touch `last` so the optimizer can't hoist the call out of the loop
        core::hint::black_box(last);
    }
    last as f64
}

// --- SSIM moments ---

/// Independent scalar moments — mirrors `ssim_moments_avx2`'s scalar body
/// (4 lanes: the kernels keep the alpha lane for the PSNR-from-sums derivation).
fn moments_scalar(a: &[u8], b: &[u8], np: usize) -> ([u64; 4], [u64; 4], [u64; 4]) {
    let mut sa = [0u64; 4];
    let mut saa = [0u64; 4];
    let mut sab = [0u64; 4];
    let mut j = 0;
    for _ in 0..np {
        for c in 0..4 {
            let x = a[j + c] as u64;
            let y = b[j + c] as u64;
            sa[c] += x;
            saa[c] += x * x;
            sab[c] += x * y;
        }
        j += 4;
    }
    (sa, saa, sab)
}

#[inline]
fn moments_checksum(m: ([u64; 4], [u64; 4], [u64; 4])) -> f64 {
    let (sa, saa, sab) = m;
    let mut acc = 0u64;
    for v in sa.iter().chain(saa.iter()).chain(sab.iter()) {
        acc = acc.wrapping_add(*v);
    }
    acc as f64
}

/// 0.0 if the v128 moments equal the scalar moments exactly, else 1.0.
#[wasm_bindgen]
pub fn ssim_moments_parity(a: &[u8], b: &[u8], np: usize) -> f64 {
    if ssim_moments_wasm(a, b, np) == moments_scalar(a, b, np) { 0.0 } else { 1.0 }
}

/// Time `iters` moment passes inside wasm; returns the checksum (anti-DCE).
#[wasm_bindgen]
pub fn bench_moments(a: &[u8], b: &[u8], np: usize, iters: u32, simd: bool) -> f64 {
    let mut last = 0f64;
    for _ in 0..iters {
        let m = if simd { ssim_moments_wasm(a, b, np) } else { moments_scalar(a, b, np) };
        last = moments_checksum(m);
        core::hint::black_box(last);
    }
    last
}
