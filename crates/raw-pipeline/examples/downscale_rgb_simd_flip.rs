//! downscale_rgb_simd_flip — A/B for the general (non-exact) box-downscale inner
//! accumulate in the SHIPPED wasm export `downscale_rgb` (root src/lib.rs:1250).
//!
//! This is the function behind StandardMultifileTest's `scale_ms`: take_rgb() →
//! downscale_rgb(rgb, srcW, srcH, tgtW, tgtH) with a non-exact ratio (e.g. 4224→1920
//! = 2.2×), so the general branch fires. RGB8, 3 channels, u32 accumulators, stride-3
//! interleaved reads — the case the source comments flag as a SIMD opportunity that
//! "LLVM cannot vectorise" (3-way deinterleave of a u8 AoS stream).
//!
//!   A = scalar           (exact replica of the src/lib.rs general branch)
//!   B = SSE4.1 i32x4     (channel-as-lane, 1 px / add — the wasm128 v128 proxy)
//!
//! B packs each pixel's [R,G,B] into three lanes of one i32x4 (lane 3 masked off):
//! one SIMD add replaces three scalar adds. It is the structural twin of the wasm128
//! path that would ship (same 128-bit width, same 1-px/iter algorithm). If B beats A
//! here, the v128 path is likely to win in-browser.
//!
//! Byte-exact by construction: identical x0/x1/y0/y1 (same f32 math) and `n`, integer
//! adds (associative), lane 3 masked to 0 so it contributes nothing, and the same
//! `sum / n` truncating divide → identical output bytes. u8 box sums never exceed u32
//! (255 × box-area ≪ 2^32 for any real downscale), so i32 lanes need no u64 drain.
//! Parity is asserted bit-for-bit on the output bytes.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example downscale_rgb_simd_flip
#![allow(clippy::needless_range_loop)]

use std::time::Instant;

#[cfg(target_arch = "x86_64")]
use std::arch::x86_64::*;

// ── Variant A — scalar (exact replica of src/lib.rs::downscale_rgb general branch) ──
fn down_scalar(src: &[u8], sw: usize, sh: usize, dst: &mut [u8], dw: usize, dh: usize) {
    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    let mut o = 0usize;
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = (((dy as f32 + 1.0) * yr).min(sh as f32) as usize).max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = (((dx as f32 + 1.0) * xr).min(sw as f32) as usize).max(x0 + 1);
            let x_count = x1 - x0;
            let n = ((y1 - y0) * x_count).max(1) as u32;
            let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
            let mut row_base = (y0 * sw + x0) * 3;
            for _y in y0..y1 {
                let mut i = row_base;
                for _ in 0..x_count {
                    rr += src[i] as u32;
                    gg += src[i + 1] as u32;
                    bb += src[i + 2] as u32;
                    i += 3;
                }
                row_base += sw * 3;
            }
            dst[o] = (rr / n) as u8;
            dst[o + 1] = (gg / n) as u8;
            dst[o + 2] = (bb / n) as u8;
            o += 3;
        }
    }
}

// ── Variant B — SSE4.1 channel-as-lane, 1 px / add (the wasm128 v128 proxy) ─────────
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "sse4.1")]
unsafe fn down_sse(src: &[u8], sw: usize, sh: usize, dst: &mut [u8], dw: usize, dh: usize) {
    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    let len = src.len();
    let sp = src.as_ptr();
    // Keep lanes 0/1/2 (R,G,B), zero lane 3 (the 4th byte the 32-bit load drags in).
    // _mm_set_epi32 args are hi→lo: lane3=0, lane2=lane1=lane0=0xFFFF_FFFF.
    let mask3 = _mm_set_epi32(0, -1, -1, -1);
    let mut o = 0usize;
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = (((dy as f32 + 1.0) * yr).min(sh as f32) as usize).max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = (((dx as f32 + 1.0) * xr).min(sw as f32) as usize).max(x0 + 1);
            let x_count = x1 - x0;
            let n = ((y1 - y0) * x_count).max(1) as u32;
            let mut acc = _mm_setzero_si128();
            let mut row_base = (y0 * sw + x0) * 3;
            for _y in y0..y1 {
                let mut i = row_base;
                for _ in 0..x_count {
                    // One unaligned 32-bit load = R,G,B + 1 dragged byte → zero-extend
                    // u8→i32 → [R,G,B,next] → mask off `next`. The bound check fires only
                    // for the image's final pixel (i+4 > len), handled scalar to avoid a
                    // 1-byte over-read; for every other pixel it is in-bounds.
                    let w = if i + 4 <= len {
                        let bits = (sp.add(i) as *const i32).read_unaligned();
                        _mm_and_si128(_mm_cvtepu8_epi32(_mm_cvtsi32_si128(bits)), mask3)
                    } else {
                        _mm_set_epi32(0, src[i + 2] as i32, src[i + 1] as i32, src[i] as i32)
                    };
                    acc = _mm_add_epi32(acc, w);
                    i += 3;
                }
                row_base += sw * 3;
            }
            let mut t = [0i32; 4];
            _mm_storeu_si128(t.as_mut_ptr() as *mut __m128i, acc);
            dst[o] = (t[0] as u32 / n) as u8;
            dst[o + 1] = (t[1] as u32 / n) as u8;
            dst[o + 2] = (t[2] as u32 / n) as u8;
            o += 3;
        }
    }
}

fn med(v: &[f64]) -> f64 {
    let mut x: Vec<f64> = v[1..].to_vec();
    x.sort_by(|a, b| a.partial_cmp(b).unwrap());
    x[x.len() / 2]
}
fn stdev(v: &[f64], m: f64) -> f64 {
    (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt()
}

fn main() {
    #[cfg(not(target_arch = "x86_64"))]
    {
        println!("downscale_rgb_simd_flip: native x86_64 only. skipping.");
    }
    #[cfg(target_arch = "x86_64")]
    {
        let have_sse = is_x86_feature_detected!("sse4.1");
        println!("downscale_rgb_simd_flip   A=scalar  B=SSE4.1(1px RGB, wasm128 proxy)   sse4.1={have_sse}");
        if !have_sse {
            println!("  sse4.1 unavailable — cannot run B. abort.");
            return;
        }

        // Real scale_ms ratios. TARGET=1920 long-edge from typical RAW dims (all non-exact).
        let sizes: &[(usize, usize, usize, usize)] = &[
            (4224, 3168, 1920, 1440), // Pixel DNG → 1920 (the dominant SMFT case)
            (5184, 3456, 1920, 1280), // Canon CR2 → 1920
            (4032, 3024, 1920, 1440), // ORF-ish → 1920
            (1024, 768, 480, 360),    // small control
        ];
        let rounds = 13usize;

        for &(sw, sh, dw, dh) in sizes {
            let npx = sw * sh;
            let mut src = vec![0u8; npx * 3];
            let mut s: u32 = 0x9e37_79b9u32
                .wrapping_mul(sw as u32)
                .wrapping_add(sh as u32);
            for v in &mut src {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *v = (s >> 24) as u8;
            }
            let dlen = dw * dh * 3;
            let (mut da, mut db) = (vec![0u8; dlen], vec![0u8; dlen]);

            down_scalar(&src, sw, sh, &mut da, dw, dh);
            unsafe { down_sse(&src, sw, sh, &mut db, dw, dh) };
            assert!(da == db, "PARITY A!=B at {sw}x{sh}->{dw}x{dh}");

            let time = |f: &mut dyn FnMut(), probe: u8, sink: &mut u64| {
                let t = Instant::now();
                f();
                *sink = sink.wrapping_add(probe as u64);
                t.elapsed().as_secs_f64() * 1e3
            };
            let (mut ta, mut tb) = (Vec::new(), Vec::new());
            let mut sink = 0u64;
            for i in 0..rounds {
                let mut run_a = |sink: &mut u64| {
                    let p = da[dlen / 2];
                    ta.push(time(
                        &mut || down_scalar(&src, sw, sh, &mut da, dw, dh),
                        p,
                        sink,
                    ));
                };
                let mut run_b = |sink: &mut u64| {
                    let p = db[dlen / 2];
                    tb.push(time(
                        &mut || unsafe { down_sse(&src, sw, sh, &mut db, dw, dh) },
                        p,
                        sink,
                    ));
                };
                if i % 2 == 0 {
                    run_a(&mut sink);
                    run_b(&mut sink);
                } else {
                    run_b(&mut sink);
                    run_a(&mut sink);
                }
            }
            std::hint::black_box(sink);

            let (ma, mb) = (med(&ta), med(&tb));
            let sb = stdev(&tb[1..], mb);
            let saved = (ma - mb) / ma * 100.0;
            let mpx = (dw * dh) as f64 / 1e6;
            println!(
                "{sw}x{sh}->{dw}x{dh} ({mpx:.2} Mpx out):  A={ma:.2}  B(sse1px)={mb:.2}±{sb:.2}  {saved:+.1}%  {:.2}x  gate(>=5%)={}  parity=OK",
                ma / mb,
                if saved >= 5.0 { "PASS" } else { "FAIL" }
            );
        }
    }
}
