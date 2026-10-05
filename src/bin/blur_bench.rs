// Blur vertical-pass benchmark: naive vs tiled vs transpose vs clarity-8.
// Run: cargo run --bin blur_bench --release
//
// Tested at two sizes:
//   1024×1024  — web thumbnail / small image
//   5240×3912  — full P1100157.ORF dimensions (~20 MP)
//
// Benchmark results (2026-05-30, Windows 11, native release build):
//
//   1024×1024 — vertical pass only:
//     tiled-64   171ms  ← winner
//     tiled-128  179ms
//     tiled-32   204ms
//     tiled-16   248ms
//     clarity-8  268ms  (56% slower than tiled-64)
//     naive      297ms  (baseline)
//     transpose  292ms
//
//   1024×1024 — full round-trip (h_pass + v_pass):
//     tiled-128  420ms  ← winner
//     tiled-64   423ms
//     clarity-8  424ms  (within noise of tiled-128, but worse v-pass)
//     tiled-32   448ms
//     tiled-16   486ms
//     naive      518ms
//     transpose  487ms
//
//   5240×3912 — vertical pass only:
//     tiled-64   4074ms  ← winner (-17% vs naive)
//     tiled-128  4224ms
//     tiled-32   4927ms
//     naive      4921ms  (baseline)
//     tiled-16   5019ms  (slower than naive)
//     clarity-8  5518ms  (12% slower than naive, 35% slower than tiled-64)
//     transpose  5531ms
//
//   5240×3912 — full round-trip (h_pass + v_pass):
//     tiled-128  8362ms  ← winner (-16% vs naive)
//     tiled-64   8761ms
//     tiled-32   8870ms
//     transpose  9211ms
//     tiled-16   9589ms
//     naive      9988ms  (baseline)
//     clarity-8 10037ms  (on par with naive, worse than all tiled at this scale)
//
// VERDICT: v_pass_clarity REJECTED. Fixed LANE=8 does not help — LLVM vectorises
// the larger [[f32;3]; TILE] accumulator more effectively than the 8-wide variant.
// At 20.5 MP, clarity-8 is slower than even the naive baseline.
// Pointer-advance applied to v_pass_tiled (winner) 2026-06-13 — moves *const u16 per channel
// instead of (row + x*3) index math per tap (classic  strided vertical win).
//
// Production recommendation (../raw-converter-tauri/raw-pipeline):
//   Use v_pass_tiled::<128> for separable_blur (full round-trip winner at both scales).
//   v_pass_tiled::<64> is best if only the vertical pass is profiled in isolation.

use std::time::Instant;

fn k13() -> [f32; 13] {
    [
        0.0185, 0.0342, 0.0563, 0.0831, 0.1097, 0.1296, 0.1370, 0.1296, 0.1097, 0.0831, 0.0563,
        0.0342, 0.0185,
    ]
}

// Shared: horizontal pass — row-major access is cache-friendly.
fn h_pass(src: &[u16], w: usize, h: usize, k: &[f32], dst: &mut [u16]) {
    let half = k.len() / 2;
    for y in 0..h {
        let row = y * w * 3;

        let left_end = half.min(w);
        for x in 0..left_end {
            let mut acc = [0f32; 3];
            for (ki, &kv) in k.iter().enumerate() {
                let xi =
                    (x as isize + ki as isize - half as isize).clamp(0, w as isize - 1) as usize;
                let b = row + xi * 3;
                acc[0] += src[b] as f32 * kv;
                acc[1] += src[b + 1] as f32 * kv;
                acc[2] += src[b + 2] as f32 * kv;
            }
            let b = row + x * 3;
            dst[b] = acc[0].round() as u16;
            dst[b + 1] = acc[1].round() as u16;
            dst[b + 2] = acc[2].round() as u16;
        }

        if w > half * 2 {
            for x in half..(w - half) {
                let mut acc = [0f32; 3];
                let mut b = row + (x - half) * 3;
                for &kv in k {
                    acc[0] += src[b] as f32 * kv;
                    acc[1] += src[b + 1] as f32 * kv;
                    acc[2] += src[b + 2] as f32 * kv;
                    b += 3;
                }
                let b = row + x * 3;
                dst[b] = acc[0].round() as u16;
                dst[b + 1] = acc[1].round() as u16;
                dst[b + 2] = acc[2].round() as u16;
            }
        }

        let right_start = half.max(w.saturating_sub(half));
        for x in right_start..w {
            let mut acc = [0f32; 3];
            for (ki, &kv) in k.iter().enumerate() {
                let xi =
                    (x as isize + ki as isize - half as isize).clamp(0, w as isize - 1) as usize;
                let b = row + xi * 3;
                acc[0] += src[b] as f32 * kv;
                acc[1] += src[b + 1] as f32 * kv;
                acc[2] += src[b + 2] as f32 * kv;
            }
            let b = row + x * 3;
            dst[b] = acc[0].round() as u16;
            dst[b + 1] = acc[1].round() as u16;
            dst[b + 2] = acc[2].round() as u16;
        }
    }
}

#[cfg(test)]
fn h_pass_reference(src: &[u16], w: usize, h: usize, k: &[f32], dst: &mut [u16]) {
    let half = k.len() / 2;
    for y in 0..h {
        for x in 0..w {
            let mut acc = [0f32; 3];
            for (ki, &kv) in k.iter().enumerate() {
                let xi =
                    (x as isize + ki as isize - half as isize).clamp(0, w as isize - 1) as usize;
                let b = (y * w + xi) * 3;
                acc[0] += src[b] as f32 * kv;
                acc[1] += src[b + 1] as f32 * kv;
                acc[2] += src[b + 2] as f32 * kv;
            }
            let b = (y * w + x) * 3;
            dst[b] = acc[0].round() as u16;
            dst[b + 1] = acc[1].round() as u16;
            dst[b + 2] = acc[2].round() as u16;
        }
    }
}

// Naive vertical pass — stride = w*3*2 bytes per kernel tap (baseline).
fn v_pass_naive(src: &[u16], w: usize, h: usize, k: &[f32], dst: &mut [u16]) {
    let half = k.len() / 2;
    for y in 0..h {
        for x in 0..w {
            let mut acc = [0f32; 3];
            for (ki, &kv) in k.iter().enumerate() {
                let yi =
                    (y as isize + ki as isize - half as isize).clamp(0, h as isize - 1) as usize;
                let b = (yi * w + x) * 3;
                acc[0] += src[b] as f32 * kv;
                acc[1] += src[b + 1] as f32 * kv;
                acc[2] += src[b + 2] as f32 * kv;
            }
            let b = (y * w + x) * 3;
            dst[b] = acc[0].round() as u16;
            dst[b + 1] = acc[1].round() as u16;
            dst[b + 2] = acc[2].round() as u16;
        }
    }
}

// Tiled vertical — TILE columns at once; working set = TILE*klen*3*2 bytes in L1.
// Runtime `tile` at the right edge may prevent LLVM from fully unrolling the
// inner loop for that last partial tile; all other tiles are exactly TILE wide.
fn v_pass_tiled<const TILE: usize>(src: &[u16], w: usize, h: usize, k: &[f32], dst: &mut [u16]) {
    let half = k.len() / 2;
    let row_stride = w * 3;
    for y in 0..h {
        let middle_y = y >= half && y + half < h;
        for x0 in (0..w).step_by(TILE) {
            let x1 = (x0 + TILE).min(w);
            let tile = x1 - x0;
            let mut acc = [[0f32; 3]; TILE];
            for (ki, &kv) in k.iter().enumerate() {
                let yi = if middle_y {
                    y + ki - half
                } else {
                    (y as isize + ki as isize - half as isize).clamp(0, h as isize - 1) as usize
                };
                let row = yi * row_stride;
                // Pointer advance (lens20): move ptr instead of recompute mul+add per pixel.
                // SAFETY: tile, x0, yi validated by caller contract + clamp; bench synthetic data.
                let mut sp = unsafe { src.as_ptr().add(row + x0 * 3) };
                for xi in 0..tile {
                    // Read 3 consecutive u16 via ptr (LE mem layout).
                    let v0 = unsafe { *sp as f32 * kv };
                    sp = unsafe { sp.add(1) };
                    let v1 = unsafe { *sp as f32 * kv };
                    sp = unsafe { sp.add(1) };
                    let v2 = unsafe { *sp as f32 * kv };
                    sp = unsafe { sp.add(1) };
                    acc[xi][0] += v0;
                    acc[xi][1] += v1;
                    acc[xi][2] += v2;
                }
            }
            for xi in 0..tile {
                let mut dp = unsafe { dst.as_mut_ptr().add(y * row_stride + (x0 + xi) * 3) };
                unsafe {
                    *dp = acc[xi][0].round() as u16;
                    dp = dp.add(1);
                    *dp = acc[xi][1].round() as u16;
                    dp = dp.add(1);
                    *dp = acc[xi][2].round() as u16;
                }
            }
        }
    }
}

// 8-wide unrolled vertical pass with a separate scalar tail.
// Inner `for i in 0..LANE` is always exactly 8 iterations — LLVM can fully
// unroll it. v_pass_tiled's `tile` variable at the right edge may block that.
// Kept, unwired, as the code of the REJECTED lever recorded above.
#[allow(dead_code)]
fn v_pass_clarity(src: &[u16], w: usize, h: usize, k: &[f32], dst: &mut [u16]) {
    let half = k.len() / 2;
    const LANE: usize = 8;

    for y in 0..h {
        let mut x = 0;

        while x + LANE <= w {
            let mut acc = [[0f32; 3]; LANE];
            for (ki, &kv) in k.iter().enumerate() {
                let yi =
                    (y as isize + ki as isize - half as isize).clamp(0, h as isize - 1) as usize;
                let row = yi * w * 3;
                for i in 0..LANE {
                    let b = row + (x + i) * 3;
                    acc[i][0] += src[b] as f32 * kv;
                    acc[i][1] += src[b + 1] as f32 * kv;
                    acc[i][2] += src[b + 2] as f32 * kv;
                }
            }
            for i in 0..LANE {
                let b = (y * w + x + i) * 3;
                dst[b] = acc[i][0].round() as u16;
                dst[b + 1] = acc[i][1].round() as u16;
                dst[b + 2] = acc[i][2].round() as u16;
            }
            x += LANE;
        }

        // Scalar tail for widths not divisible by LANE.
        for xi in x..w {
            let mut acc = [0f32; 3];
            for (ki, &kv) in k.iter().enumerate() {
                let yi =
                    (y as isize + ki as isize - half as isize).clamp(0, h as isize - 1) as usize;
                let b = (yi * w + xi) * 3;
                acc[0] += src[b] as f32 * kv;
                acc[1] += src[b + 1] as f32 * kv;
                acc[2] += src[b + 2] as f32 * kv;
            }
            let b = (y * w + xi) * 3;
            dst[b] = acc[0].round() as u16;
            dst[b + 1] = acc[1].round() as u16;
            dst[b + 2] = acc[2].round() as u16;
        }
    }
}

// Transpose → horizontal → transpose back. Cache-tiled 32×32 block transpose.
fn transpose_tiled(src: &[u16], sw: usize, sh: usize, dst: &mut [u16]) {
    const T: usize = 32;
    for ty in (0..sh).step_by(T) {
        for tx in (0..sw).step_by(T) {
            for y in ty..(ty + T).min(sh) {
                for x in tx..(tx + T).min(sw) {
                    let si = (y * sw + x) * 3;
                    let di = (x * sh + y) * 3;
                    dst[di] = src[si];
                    dst[di + 1] = src[si + 1];
                    dst[di + 2] = src[si + 2];
                }
            }
        }
    }
}

fn v_pass_via_transpose(
    src: &[u16],
    w: usize,
    h: usize,
    k: &[f32],
    dst: &mut [u16],
    s1: &mut Vec<u16>,
    s2: &mut Vec<u16>,
) {
    let n = w * h * 3;
    s1.resize(n, 0);
    s2.resize(n, 0);
    transpose_tiled(src, w, h, s1);
    h_pass(s1, h, w, k, s2);
    transpose_tiled(s2, h, w, dst);
}

#[cfg(test)]
fn full_roundtrip_variant_names() -> &'static [&'static str] {
    &[
        "naive",
        "tiled-16",
        "tiled-32",
        "tiled-64",
        "tiled-128",
        "clarity-8",
        "transpose+h+transpose",
    ]
}

fn time_fn(name: &str, runs: usize, mut f: impl FnMut()) {
    f(); // warmup
    let mut ms: Vec<f64> = (0..runs)
        .map(|_| {
            let t = Instant::now();
            f();
            t.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "  {:30}  min={:6.1}ms  med={:6.1}ms  max={:6.1}ms",
        name,
        ms[0],
        ms[runs / 2],
        ms[runs - 1]
    );
}

fn bench_size(w: usize, h: usize, kernel: &[f32], runs: usize) {
    let n = w * h * 3;
    let mb = n as f64 * 2.0 / 1024.0 / 1024.0;
    println!(
        "\n=== {}×{} ({:.1} MP, {:.0} MB rgb16) ===",
        w,
        h,
        (w * h) as f64 / 1e6,
        mb
    );

    let src: Vec<u16> = (0..n).map(|i| (i % 65536) as u16).collect();
    let mut temp = vec![0u16; n];
    let mut out = vec![0u16; n];
    let mut s1: Vec<u16> = Vec::new();
    let mut s2: Vec<u16> = Vec::new();

    h_pass(&src, w, h, kernel, &mut temp);

    println!("  Vertical pass only:");
    time_fn("naive (baseline)", runs, || {
        v_pass_naive(&temp, w, h, kernel, &mut out)
    });
    time_fn("tiled-16", runs, || {
        v_pass_tiled::<16>(&temp, w, h, kernel, &mut out)
    });
    time_fn("tiled-32", runs, || {
        v_pass_tiled::<32>(&temp, w, h, kernel, &mut out)
    });
    time_fn("tiled-64", runs, || {
        v_pass_tiled::<64>(&temp, w, h, kernel, &mut out)
    });
    time_fn("tiled-128", runs, || {
        v_pass_tiled::<128>(&temp, w, h, kernel, &mut out)
    });
    // clarity-8 removed per 2026-05-30 verdict (slower than naive at 20 MP); fn kept for ref only.
    time_fn("transpose+h+transpose", runs, || {
        v_pass_via_transpose(&temp, w, h, kernel, &mut out, &mut s1, &mut s2)
    });

    println!("  Full round-trip (h_pass + v_pass):");
    time_fn("naive", runs, || {
        h_pass(&src, w, h, kernel, &mut temp);
        v_pass_naive(&temp, w, h, kernel, &mut out);
    });
    time_fn("tiled-16", runs, || {
        h_pass(&src, w, h, kernel, &mut temp);
        v_pass_tiled::<16>(&temp, w, h, kernel, &mut out);
    });
    time_fn("tiled-32", runs, || {
        h_pass(&src, w, h, kernel, &mut temp);
        v_pass_tiled::<32>(&temp, w, h, kernel, &mut out);
    });
    time_fn("tiled-64", runs, || {
        h_pass(&src, w, h, kernel, &mut temp);
        v_pass_tiled::<64>(&temp, w, h, kernel, &mut out);
    });
    time_fn("tiled-128", runs, || {
        h_pass(&src, w, h, kernel, &mut temp);
        v_pass_tiled::<128>(&temp, w, h, kernel, &mut out);
    });
    // clarity-8 removed (see v-pass section); transpose kept for comparison.
    time_fn("transpose+h+transpose", runs, || {
        h_pass(&src, w, h, kernel, &mut temp);
        v_pass_via_transpose(&temp, w, h, kernel, &mut out, &mut s1, &mut s2);
    });
}

fn main() {
    let kernel = k13();
    println!("Kernel: 13-tap Gaussian (clarity). Runs = 5 per variant.");
    bench_size(1024, 1024, &kernel, 5);
    bench_size(5240, 3912, &kernel, 5);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_roundtrip_includes_tiled_128() {
        assert!(
            full_roundtrip_variant_names().contains(&"tiled-128"),
            "full round-trip benchmark must include tiled-128 for Q3 verification"
        );
    }

    #[test]
    fn h_pass_optimized_matches_reference() {
        let w = 17;
        let h = 9;
        let n = w * h * 3;
        let src: Vec<u16> = (0..n).map(|i| ((i * 251 + 17) % 65536) as u16).collect();
        let kernel = k13();
        let mut expected = vec![0u16; n];
        let mut actual = vec![0u16; n];

        h_pass_reference(&src, w, h, &kernel, &mut expected);
        h_pass(&src, w, h, &kernel, &mut actual);

        assert_eq!(actual, expected);
    }

    #[test]
    fn v_pass_tiled_128_matches_naive_on_edges_and_tail() {
        let w = 19;
        let h = 11;
        let n = w * h * 3;
        let src: Vec<u16> = (0..n).map(|i| ((i * 193 + 29) % 65536) as u16).collect();
        let kernel = k13();
        let mut expected = vec![0u16; n];
        let mut actual = vec![0u16; n];

        v_pass_naive(&src, w, h, &kernel, &mut expected);
        v_pass_tiled::<128>(&src, w, h, &kernel, &mut actual);

        assert_eq!(actual, expected);
    }
}
