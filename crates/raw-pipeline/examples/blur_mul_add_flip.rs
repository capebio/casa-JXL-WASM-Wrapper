//! blur_mul_add_flip — isolate the `mul_add` libcall from cache-tiling.
//!
//! Same blur STRUCTURE as current pipeline.rs (planar de-interleave horizontal +
//! full-image tiled vertical). The ONLY difference between arms is the inner
//! fused-multiply-add:
//!   A (mul_add) = `x.mul_add(k, acc)` — current code. On a build WITHOUT `+fma`
//!                 this lowers to a scalar `fmaf` LIBCALL (~50-100 cyc, no vectorization).
//!   B (plain)   = `x * k + acc` — LLVM vectorizes (mulps/addps) on baseline SSE2.
//!   C (helper)  = `bfma()` — `#[cfg(target_feature="fma")]` picks mul_add, else plain.
//!                 Should equal B on a baseline build, equal A on an FMA build.
//!
//! Expected: baseline → B,C ≈ 3× faster than A (A pays the libcall). FMA build
//! (`RUSTFLAGS=-C target-cpu=native`) → A,C fastest, B ~6% behind (plain = 2 ops vs 1 fma).
//! That proves the cfg-helper is the portable fix: fast on BOTH targets.
//!
//! Run baseline:  cd crates/raw-pipeline && cargo run --release --no-default-features --example blur_mul_add_flip
//! Run with FMA:  RUSTFLAGS="-C target-cpu=native" cargo run --release --no-default-features --example blur_mul_add_flip

use std::time::Instant;

const VTILE: usize = 128;

fn k13() -> [f32; 13] {
    [
        0.0185, 0.0342, 0.0563, 0.0831, 0.1097, 0.1296, 0.1372, 0.1296, 0.1097, 0.0831, 0.0563,
        0.0342, 0.0185,
    ]
}

/// Portable FMA helper — the proposed fix. Compiles to one op per target.
#[inline(always)]
fn bfma(a: f32, b: f32, c: f32) -> f32 {
    #[cfg(target_feature = "fma")]
    {
        a.mul_add(b, c)
    }
    #[cfg(not(target_feature = "fma"))]
    {
        a * b + c
    }
}

/// Mode-dispatched fused multiply-add. `match M` const-folds per monomorphization.
#[inline(always)]
fn fma_m<const M: u8>(a: f32, b: f32, c: f32) -> f32 {
    match M {
        0 => a.mul_add(b, c), // A: current
        1 => a * b + c,       // B: plain
        _ => bfma(a, b, c),   // C: cfg helper
    }
}

fn fir_planar<const M: u8>(plane: &[f32], kernel: &[f32], half: usize, out: &mut [f32]) {
    let width = plane.len();
    let int_start = half;
    let int_end = width.saturating_sub(half);
    let wm = width as isize - 1;
    for x in 0..int_start.min(width) {
        let mut acc = 0f32;
        for ki in 0..kernel.len() {
            let xi = (x as isize + ki as isize - half as isize).clamp(0, wm) as usize;
            acc = fma_m::<M>(plane[xi], kernel[ki], acc);
        }
        out[x] = acc;
    }
    for x in int_start..int_end {
        let b0 = x - half;
        let mut acc = 0f32;
        for ki in 0..kernel.len() {
            acc = fma_m::<M>(plane[b0 + ki], kernel[ki], acc);
        }
        out[x] = acc;
    }
    for x in int_end.max(int_start)..width {
        let mut acc = 0f32;
        for ki in 0..kernel.len() {
            let xi = (x as isize + ki as isize - half as isize).clamp(0, wm) as usize;
            acc = fma_m::<M>(plane[xi], kernel[ki], acc);
        }
        out[x] = acc;
    }
}

fn blur<const M: u8>(
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
        fir_planar::<M>(&r_in, kernel, half, &mut r_out);
        fir_planar::<M>(&g_in, kernel, half, &mut g_out);
        fir_planar::<M>(&b_in, kernel, half, &mut b_out);
        let row = &mut temp[y * width * 3..(y + 1) * width * 3];
        for px in 0..width {
            let b = px * 3;
            row[b] = r_out[px].round() as u16;
            row[b + 1] = g_out[px].round() as u16;
            row[b + 2] = b_out[px].round() as u16;
        }
    }

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
                    acc_r[xi] = fma_m::<M>(r_tap[xi], kv, acc_r[xi]);
                    acc_g[xi] = fma_m::<M>(g_tap[xi], kv, acc_g[xi]);
                    acc_b[xi] = fma_m::<M>(b_tap[xi], kv, acc_b[xi]);
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

fn median(v: &[f64]) -> f64 {
    let mut w: Vec<f64> = v[1..].to_vec();
    w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    w[w.len() / 2]
}

fn maxdiff(a: &[u16], b: &[u16]) -> (i32, usize) {
    let mut m = 0i32;
    let mut n = 0usize;
    for i in 0..a.len() {
        let d = (a[i] as i32 - b[i] as i32).abs();
        if d > 0 {
            n += 1;
            if d > m {
                m = d;
            }
        }
    }
    (m, n)
}

fn run_case(label: &str, width: usize, height: usize, rounds: usize) {
    let kernel = k13();
    let mut s: u32 = 0xdead_beef;
    let mut src = vec![0u16; width * height * 3];
    for v in src.iter_mut() {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *v = (s >> 16) as u16;
    }

    // Parity: B and C vs A.
    let (mut oa, mut ob, mut oc): (Vec<u16>, Vec<u16>, Vec<u16>) = (vec![], vec![], vec![]);
    let mut t: Vec<u16> = Vec::new();
    blur::<0>(&src, width, height, &kernel, &mut t, &mut oa);
    blur::<1>(&src, width, height, &kernel, &mut t, &mut ob);
    blur::<2>(&src, width, height, &kernel, &mut t, &mut oc);
    let (mb, _) = maxdiff(&oa, &ob);
    let (mc, _) = maxdiff(&oa, &oc);

    let (mut ta, mut tb, mut tc) = (Vec::new(), Vec::new(), Vec::new());
    let mut sink = 0u64;
    let mut tmp: Vec<u16> = Vec::new();
    let mut out: Vec<u16> = Vec::new();
    let mut timed = |which: u8, sink: &mut u64, tmp: &mut Vec<u16>, out: &mut Vec<u16>| -> f64 {
        let t0 = Instant::now();
        match which {
            0 => blur::<0>(&src, width, height, &kernel, tmp, out),
            1 => blur::<1>(&src, width, height, &kernel, tmp, out),
            _ => blur::<2>(&src, width, height, &kernel, tmp, out),
        }
        *sink = sink.wrapping_add(out[out.len() / 2] as u64);
        t0.elapsed().as_secs_f64() * 1e3
    };
    for r in 0..rounds {
        // Rotate start order each round so drift hits all arms equally.
        let order = match r % 3 {
            0 => [0u8, 1, 2],
            1 => [1, 2, 0],
            _ => [2, 0, 1],
        };
        for &w in &order {
            let dt = timed(w, &mut sink, &mut tmp, &mut out);
            match w {
                0 => ta.push(dt),
                1 => tb.push(dt),
                _ => tc.push(dt),
            }
        }
    }
    std::hint::black_box(sink);

    let (ma, mbt, mct) = (median(&ta), median(&tb), median(&tc));
    println!(
        "{:>10} {:>5}×{:<5} | A(mul_add) {:>8.2}ms  B(plain) {:>8.2}ms ({:+5.1}%)  C(helper) {:>8.2}ms ({:+5.1}%) | Δ B={} C={}",
        label, width, height, ma,
        mbt, (ma - mbt) / ma * 100.0,
        mct, (ma - mct) / ma * 100.0,
        mb, mc
    );
}

fn main() {
    let fma = cfg!(target_feature = "fma");
    println!("blur_mul_add_flip — A=mul_add  B=plain  C=cfg-helper  (this binary: target_feature=fma is {})", fma);
    println!("baseline expect: B,C ≈ 3× faster than A.  FMA expect: A,C fastest, B ~6% behind.\n");
    run_case("12MP", 4032, 3024, 9);
    run_case("20MP", 5184, 3888, 7);
    run_case("24MP", 6000, 4000, 7);
    println!("\nHelper C should track the FAST arm on both targets (==B on baseline, ==A on FMA).");
}
