//! blur_cache_tile_flip — thermal-cancelled A/B for `separable_blur_with_bufs`
//! (the clarity/texture unsharp-mask blur). Resurrected from stash{1} (base ecd946ec).
//!
//! Clarity blur is the #1 pipeline cost center: deferred-timings.md measured it at
//! 80% (20MP ORF) — 179% (12MP DNG) of total pipeline, **memory-bandwidth bound**.
//! The proposed (un-landed) lever: cache-tiled strips, est. 5–10×.
//!
//!   A = current pipeline.rs: full-image `temp` (w·h·3·2 B ≈ 120 MB @20MP), planar
//!       de-interleave horizontal pass (FMA `mul_add`), then a full-image tiled
//!       vertical pass that re-reads the entire `temp` 13× → full DRAM round-trip.
//!   B = stash{1}: process the image in BLUR_STRIP_H=160-row strips. `temp` is
//!       strip-sized (172 rows ≈ 4.8 MB, L3-resident); horizontal + vertical fused
//!       per strip so the vertical pass hits L3, not DRAM. Interleaved stride-3
//!       arithmetic, non-FMA (`+= x*kv`).
//!
//! Numerics: A uses FMA, B does not, and the horizontal layout differs (planar vs
//! interleaved). Output is NOT expected byte-exact — a few-LSB delta is the FMA/order
//! rounding floor for a 16-bit blur intermediate. A genuine strip-seam *bug* would
//! instead spike the diff at row multiples of 160; we print the worst-diff row to catch that.
//!
//! Scalar single-thread: the cache-residency win is structural and shows clearest here.
//! The shipped path is `parallel` (rayon) — real-world gain may differ (more cores →
//! more DRAM contention, which tends to favor B further). Treat % as directional.
//!
//! Interleaved start-rotated rounds; round 0 dropped; median + %saved. Gate ≥5%.
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example blur_cache_tile_flip

use std::time::Instant;

const STRIP_H: usize = 160;
const VTILE: usize = 128;

fn k13() -> [f32; 13] {
    [
        0.0185, 0.0342, 0.0563, 0.0831, 0.1097, 0.1296, 0.1372, 0.1296, 0.1097, 0.0831, 0.0563,
        0.0342, 0.0185,
    ]
}
fn k5() -> [f32; 5] {
    [0.0545, 0.2442, 0.4026, 0.2442, 0.0545]
}

// ── A: current pipeline.rs ─────────────────────────────────────────────────────
// 1-D FIR on an f32 plane, stride-1, FMA — mirrors blur_fir_planar.
fn fir_planar(plane: &[f32], kernel: &[f32], half: usize, out: &mut [f32]) {
    let width = plane.len();
    let int_start = half;
    let int_end = width.saturating_sub(half);
    let wm = width as isize - 1;
    for x in 0..int_start.min(width) {
        let mut acc = 0f32;
        for ki in 0..kernel.len() {
            let xi = (x as isize + ki as isize - half as isize).clamp(0, wm) as usize;
            acc = plane[xi].mul_add(kernel[ki], acc);
        }
        out[x] = acc;
    }
    for x in int_start..int_end {
        let b0 = x - half;
        let mut acc = 0f32;
        for ki in 0..kernel.len() {
            acc = plane[b0 + ki].mul_add(kernel[ki], acc);
        }
        out[x] = acc;
    }
    for x in int_end.max(int_start)..width {
        let mut acc = 0f32;
        for ki in 0..kernel.len() {
            let xi = (x as isize + ki as isize - half as isize).clamp(0, wm) as usize;
            acc = plane[xi].mul_add(kernel[ki], acc);
        }
        out[x] = acc;
    }
}

fn blur_a(
    src: &[u16],
    width: usize,
    height: usize,
    kernel: &[f32],
    temp: &mut Vec<u16>,
    out: &mut Vec<u16>,
) {
    let half = kernel.len() / 2;
    let n = width * height * 3;
    temp.resize(n, 0);
    out.resize(n, 0);

    // Horizontal: per-row de-interleave → planar FIR → re-interleave into full-image temp.
    let mut r_in = vec![0f32; width];
    let mut g_in = vec![0f32; width];
    let mut b_in = vec![0f32; width];
    let mut r_out = vec![0f32; width];
    let mut g_out = vec![0f32; width];
    let mut b_out = vec![0f32; width];
    for y in 0..height {
        let src_row = &src[y * width * 3..(y + 1) * width * 3];
        for px in 0..width {
            let b = px * 3;
            r_in[px] = src_row[b] as f32;
            g_in[px] = src_row[b + 1] as f32;
            b_in[px] = src_row[b + 2] as f32;
        }
        fir_planar(&r_in, kernel, half, &mut r_out);
        fir_planar(&g_in, kernel, half, &mut g_out);
        fir_planar(&b_in, kernel, half, &mut b_out);
        let row = &mut temp[y * width * 3..(y + 1) * width * 3];
        for px in 0..width {
            let b = px * 3;
            row[b] = r_out[px].round() as u16;
            row[b + 1] = g_out[px].round() as u16;
            row[b + 2] = b_out[px].round() as u16;
        }
    }

    // Vertical: full-image tiled pass, FMA. Re-reads all of `temp` (DRAM).
    let klen = kernel.len();
    let mut acc_r = [0f32; VTILE];
    let mut acc_g = [0f32; VTILE];
    let mut acc_b = [0f32; VTILE];
    let mut r_tap = [0f32; VTILE];
    let mut g_tap = [0f32; VTILE];
    let mut b_tap = [0f32; VTILE];
    for y in 0..height {
        for x0 in (0..width).step_by(VTILE) {
            let x1 = (x0 + VTILE).min(width);
            let tile = x1 - x0;
            for xi in 0..tile {
                acc_r[xi] = 0.0;
                acc_g[xi] = 0.0;
                acc_b[xi] = 0.0;
            }
            for ki in 0..klen {
                let kv = kernel[ki];
                let yi = (y as isize + ki as isize - half as isize).clamp(0, height as isize - 1)
                    as usize;
                let row_base = yi * width * 3;
                for xi in 0..tile {
                    let b = row_base + (x0 + xi) * 3;
                    r_tap[xi] = temp[b] as f32;
                    g_tap[xi] = temp[b + 1] as f32;
                    b_tap[xi] = temp[b + 2] as f32;
                }
                for xi in 0..tile {
                    acc_r[xi] = r_tap[xi].mul_add(kv, acc_r[xi]);
                    acc_g[xi] = g_tap[xi].mul_add(kv, acc_g[xi]);
                    acc_b[xi] = b_tap[xi].mul_add(kv, acc_b[xi]);
                }
            }
            for xi in 0..tile {
                let b = (y * width + x0 + xi) * 3;
                out[b] = acc_r[xi].round() as u16;
                out[b + 1] = acc_g[xi].round() as u16;
                out[b + 2] = acc_b[xi].round() as u16;
            }
        }
    }
}

// ── B: stash{1} cache-tiled strips ─────────────────────────────────────────────
fn blur_b(
    src: &[u16],
    width: usize,
    height: usize,
    kernel: &[f32],
    temp: &mut Vec<u16>,
    out: &mut Vec<u16>,
) {
    let half = kernel.len() / 2;
    let buf_rows = STRIP_H + 2 * half;
    temp.resize(buf_rows * width * 3, 0);
    out.resize(width * height * 3, 0);

    let int_start = half;
    let int_end = width.saturating_sub(half);
    let right_start = int_end.max(int_start);

    let mut y0 = 0usize;
    while y0 < height {
        let strip_h = STRIP_H.min(height - y0);
        let src_r0 = y0.saturating_sub(half);
        let src_r1 = (y0 + strip_h + half).min(height);
        let buf_cnt = src_r1 - src_r0;

        // Horizontal: src rows [src_r0..src_r1] → temp[0..buf_cnt·W·3], interleaved non-FMA.
        for buf_y in 0..buf_cnt {
            let src_base = (src_r0 + buf_y) * width * 3;
            let row = &mut temp[buf_y * width * 3..(buf_y + 1) * width * 3];
            for x in 0..int_start.min(width) {
                let mut acc = [0f32; 3];
                for (ki, &kv) in kernel.iter().enumerate() {
                    let xi = (x as isize + ki as isize - half as isize).clamp(0, width as isize - 1)
                        as usize;
                    let b = src_base + xi * 3;
                    acc[0] += src[b] as f32 * kv;
                    acc[1] += src[b + 1] as f32 * kv;
                    acc[2] += src[b + 2] as f32 * kv;
                }
                let o = x * 3;
                row[o] = acc[0].round() as u16;
                row[o + 1] = acc[1].round() as u16;
                row[o + 2] = acc[2].round() as u16;
            }
            for x in int_start..int_end {
                let mut acc_r = 0f32;
                let mut acc_g = 0f32;
                let mut acc_b = 0f32;
                let b0 = src_base + (x - half) * 3;
                for (ki, &kv) in kernel.iter().enumerate() {
                    let b = b0 + ki * 3;
                    acc_r += src[b] as f32 * kv;
                    acc_g += src[b + 1] as f32 * kv;
                    acc_b += src[b + 2] as f32 * kv;
                }
                let o = x * 3;
                row[o] = acc_r.round() as u16;
                row[o + 1] = acc_g.round() as u16;
                row[o + 2] = acc_b.round() as u16;
            }
            for x in right_start..width {
                let mut acc = [0f32; 3];
                for (ki, &kv) in kernel.iter().enumerate() {
                    let xi = (x as isize + ki as isize - half as isize).clamp(0, width as isize - 1)
                        as usize;
                    let b = src_base + xi * 3;
                    acc[0] += src[b] as f32 * kv;
                    acc[1] += src[b + 1] as f32 * kv;
                    acc[2] += src[b + 2] as f32 * kv;
                }
                let o = x * 3;
                row[o] = acc[0].round() as u16;
                row[o + 1] = acc[1].round() as u16;
                row[o + 2] = acc[2].round() as u16;
            }
        }

        // Vertical: output rows y0..y0+strip_h from the L3-resident strip.
        let temp_strip: &[u16] = &temp[..buf_cnt * width * 3];
        for local_y in 0..strip_h {
            let y = y0 + local_y;
            for x0 in (0..width).step_by(VTILE) {
                let x1 = (x0 + VTILE).min(width);
                let tile = x1 - x0;
                let mut acc = [[0f32; 3]; VTILE];
                for (ki, &kv) in kernel.iter().enumerate() {
                    let yi_g = (y as isize + ki as isize - half as isize)
                        .clamp(0, height as isize - 1) as usize;
                    let row_base = (yi_g - src_r0) * width * 3;
                    for xi in 0..tile {
                        let b = row_base + (x0 + xi) * 3;
                        acc[xi][0] += temp_strip[b] as f32 * kv;
                        acc[xi][1] += temp_strip[b + 1] as f32 * kv;
                        acc[xi][2] += temp_strip[b + 2] as f32 * kv;
                    }
                }
                for xi in 0..tile {
                    let b = (y * width + x0 + xi) * 3;
                    out[b] = acc[xi][0].round() as u16;
                    out[b + 1] = acc[xi][1].round() as u16;
                    out[b + 2] = acc[xi][2].round() as u16;
                }
            }
        }

        y0 += strip_h;
    }
}

fn median(v: &[f64]) -> f64 {
    let mut w: Vec<f64> = v[1..].to_vec();
    w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    w[w.len() / 2]
}

fn run_case(label: &str, width: usize, height: usize, kernel: &[f32], rounds: usize) {
    // Deterministic LCG source (w·h·3 u16).
    let mut s: u32 = 0xdead_beef;
    let mut src = vec![0u16; width * height * 3];
    for v in src.iter_mut() {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *v = (s >> 16) as u16; // full 16-bit range
    }

    let (mut oa, mut ob): (Vec<u16>, Vec<u16>) = (Vec::new(), Vec::new());
    let mut sink = 0u64;
    // Parity once (outside timing).
    let mut pa_t: Vec<u16> = Vec::new();
    let mut pb_t: Vec<u16> = Vec::new();
    blur_a(&src, width, height, kernel, &mut pa_t, &mut oa);
    blur_b(&src, width, height, kernel, &mut pb_t, &mut ob);
    let mut max_diff = 0i32;
    let mut nmis = 0usize;
    let mut worst_idx = 0usize;
    for i in 0..oa.len() {
        let d = (oa[i] as i32 - ob[i] as i32).abs();
        if d > 0 {
            nmis += 1;
            if d > max_diff {
                max_diff = d;
                worst_idx = i;
            }
        }
    }
    let worst_row = (worst_idx / 3) / width;
    let pct_mis = nmis as f64 / oa.len() as f64 * 100.0;

    let mut ta = Vec::new();
    let mut tb = Vec::new();
    let mut tmp_a: Vec<u16> = Vec::new();
    let mut tmp_b: Vec<u16> = Vec::new();
    let mut out_a: Vec<u16> = Vec::new();
    let mut out_b: Vec<u16> = Vec::new();
    for r in 0..rounds {
        let mut do_a = |sink: &mut u64| {
            let t = Instant::now();
            blur_a(&src, width, height, kernel, &mut tmp_a, &mut out_a);
            *sink = sink.wrapping_add(out_a[out_a.len() / 2] as u64);
            t.elapsed().as_secs_f64() * 1e3
        };
        let mut do_b = |sink: &mut u64| {
            let t = Instant::now();
            blur_b(&src, width, height, kernel, &mut tmp_b, &mut out_b);
            *sink = sink.wrapping_add(out_b[out_b.len() / 2] as u64);
            t.elapsed().as_secs_f64() * 1e3
        };
        if r % 2 == 0 {
            ta.push(do_a(&mut sink));
            tb.push(do_b(&mut sink));
        } else {
            tb.push(do_b(&mut sink));
            ta.push(do_a(&mut sink));
        }
    }
    std::hint::black_box(sink);

    let (ma, mb) = (median(&ta), median(&tb));
    let saved = (ma - mb) / ma * 100.0;
    let verdict = if max_diff == 0 {
        "EXACT".to_string()
    } else {
        format!(
            "max|Δ|={} ({:.4}% px, worst row {})",
            max_diff, pct_mis, worst_row
        )
    };
    println!(
        "{:>18} {:>5}×{:<5} k{:<2} | A {:>8.2}ms  B {:>8.2}ms  saved {:>6.1}%  | parity {}",
        label,
        width,
        height,
        kernel.len(),
        ma,
        mb,
        saved,
        verdict
    );
}

fn main() {
    println!("blur_cache_tile_flip — A=current full-image  B=stash{{1}} cache-tiled strips");
    println!("(scalar 1-thread; clarity blur is the pipeline #1 cost center, memory-bound)\n");
    let k13 = k13();
    let k5 = k5();
    run_case("12MP DNG", 4032, 3024, &k13, 9);
    run_case("20MP ORF", 5184, 3888, &k13, 7);
    run_case("24MP", 6000, 4000, &k13, 7);
    run_case("20MP (5-tap)", 5184, 3888, &k5, 7);
    println!("\nGate ≥5% (median, round0 dropped). max|Δ| should be a few LSB (FMA/layout);");
    println!(
        "a spike concentrated at a row multiple of {} would mean a strip-seam bug.",
        STRIP_H
    );
}
