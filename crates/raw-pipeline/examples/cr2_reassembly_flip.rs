//! cr2_reassembly_flip — thermal-cancelled A/B for the CR2 multi-slice reassembly (#1).
//!
//!   A = scalar per-pixel scatter (old: row=local/sw, col=local%sw — divisions per sample)
//!   B = bulk per-row copy_from_slice (new: reassemble_slices, no per-pixel div/mod)
//!
//! Interleaved start-rotated rounds (drift hits both arms equally); round 0 (warm-up) dropped;
//! median reported with %saved. Real Canon multi-slice geometry n=2 nw=1728 lw=1888
//! (stride=5312), scaled across 5 row counts. Parity asserted byte-identical each size.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example cr2_reassembly_flip
use std::time::Instant;

// --- B: the shipped bulk implementation (mirror of cr2::reassemble_slices) ---
fn bulk(src: &[u16], stride: usize, high: usize, n: usize, nw: usize, lw: usize) -> Vec<u16> {
    let buf_len = src.len();
    let mut raster = vec![0u16; stride * high];
    let block = nw.saturating_mul(high);
    for i in 0..n {
        let col0 = i * nw;
        if nw == 0 || col0 >= stride {
            break;
        }
        let run = nw.min(stride - col0);
        let src_base = i * block;
        for row in 0..high {
            let s = src_base + row * nw;
            if s + run > buf_len {
                break;
            }
            let d = row * stride + col0;
            raster[d..d + run].copy_from_slice(&src[s..s + run]);
        }
    }
    if lw != 0 {
        let col0 = n * nw;
        if col0 < stride {
            let run = lw.min(stride - col0);
            let src_base = n * block;
            for row in 0..high {
                let s = src_base + row * lw;
                if s + run > buf_len {
                    break;
                }
                let d = row * stride + col0;
                raster[d..d + run].copy_from_slice(&src[s..s + run]);
            }
        }
    }
    raster
}

// --- A: the old scalar scatter (mirror of the pre-#1 inline loop / test reference) ---
fn scatter(src: &[u16], stride: usize, high: usize, n: usize, nw: usize, lw: usize) -> Vec<u16> {
    let block = nw * high;
    let mut raster = vec![0u16; stride * high];
    for jidx in 0..(stride * high) {
        let mut i = jidx / block;
        let last = i >= n;
        if last {
            i = n;
        }
        let local = jidx - i * block;
        let sw = if last { lw } else { nw };
        if sw == 0 {
            break;
        }
        let row = local / sw;
        let col = local % sw + i * nw;
        if row < high && col < stride {
            raster[row * stride + col] = src[jidx];
        }
    }
    raster
}

fn main() {
    let (n, nw, lw) = (2usize, 1728usize, 1888usize); // real Canon CR2Slices
    let stride = n * nw + lw; // 5312
    let sizes = [256usize, 512, 1024, 2048, 3648]; // row counts (3648 ≈ real 5D-era height)

    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec(); // drop round 0 (warm-up)
        w.sort_by(|a, b| a.partial_cmp(b).unwrap());
        w[w.len() / 2]
    };

    println!("CR2 slice-reassembly flip  geometry n={n} nw={nw} lw={lw} stride={stride}");
    println!(
        "{:>6} | {:>10} {:>10} {:>8} | parity",
        "rows", "scatter_ms", "bulk_ms", "%saved"
    );

    for &high in &sizes {
        let total = stride * high;
        // Deterministic stacked-slice source.
        let mut s: u32 = 0x9e37_79b9;
        let mut src = vec![0u16; total];
        for v in src.iter_mut() {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *v = ((s >> 8) & 0x3fff) as u16;
        }

        let run_a = || scatter(&src, stride, high, n, nw, lw);
        let run_b = || bulk(&src, stride, high, n, nw, lw);

        // parity (warm pair)
        let a0 = run_a();
        let b0 = run_b();
        let max_diff = a0
            .iter()
            .zip(b0.iter())
            .map(|(x, y)| (*x as i32 - *y as i32).abs())
            .max()
            .unwrap_or(0);

        let rounds = 11usize;
        let (mut ta, mut tb) = (Vec::new(), Vec::new());
        let mut sink = 0u64;
        let time = |f: &dyn Fn() -> Vec<u16>, sink: &mut u64| {
            let t = Instant::now();
            let out = f();
            *sink = sink.wrapping_add(out[out.len() / 2] as u64);
            t.elapsed().as_secs_f64() * 1e3
        };
        for r in 0..rounds {
            if r % 2 == 0 {
                ta.push(time(&run_a, &mut sink));
                tb.push(time(&run_b, &mut sink));
            } else {
                tb.push(time(&run_b, &mut sink));
                ta.push(time(&run_a, &mut sink));
            }
        }
        std::hint::black_box(sink);

        let ma = med(&ta);
        let mb = med(&tb);
        let saved = (ma - mb) / ma * 100.0;
        println!(
            "{:>6} | {:>10.3} {:>10.3} {:>7.1}% | {}",
            high,
            ma,
            mb,
            saved,
            if max_diff == 0 { "EXACT" } else { "DIFF!" }
        );
        assert_eq!(max_diff, 0, "parity broken at rows={high}");
    }
}
