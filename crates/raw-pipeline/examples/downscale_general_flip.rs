//! downscale_general_flip — A/B for the x0/x1 loop-invariant hoist in box_downscale_rgba8.
//!
//! The general (non-exact-ratio) branch computes x0/x1 per pixel. x0/x1 depend only on
//! dx/sw/dw, NOT on dy, so they can be precomputed once per column (dx) and reused for
//! every row (dy). This saves 2 u64 divides × dw × (dh-1) iterations.
//!
//!   A = baseline: x0/x1 computed inside dy loop (pre-hoist)
//!   B = hoisted:  x_ranges Vec precomputed outside dy loop (post-hoist)
//!
//! Output is byte-identical (same arithmetic, just reordered). Interleaved start-rotated;
//! round 0 dropped; median + stdev reported.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example downscale_general_flip

use std::time::Instant;

// Variant A — x0/x1 computed inside dy loop (original order)
fn downscale_general_baseline(src: &[u8], sw: u32, sh: u32, dst: &mut [u8], dw: u32, dh: u32) {
    for dy in 0..dh {
        let y0 = ((dy as u64 * sh as u64) / dh as u64) as u32;
        let y1 = (((dy as u64 + 1) * sh as u64 + dh as u64 - 1) / dh as u64).min(sh as u64) as u32;
        for dx in 0..dw {
            let x0 = ((dx as u64 * sw as u64) / dw as u64) as u32;
            let x1 =
                (((dx as u64 + 1) * sw as u64 + dw as u64 - 1) / dw as u64).min(sw as u64) as u32;
            let mut r = 0u32;
            let mut g = 0u32;
            let mut b = 0u32;
            let mut a = 0u32;
            let mut count = 0u32;
            for sy in y0..y1 {
                let row = &src[(sy as usize * sw as usize * 4)..];
                for sx in x0..x1 {
                    let px = &row[(sx as usize * 4)..];
                    r += px[0] as u32;
                    g += px[1] as u32;
                    b += px[2] as u32;
                    a += px[3] as u32;
                    count += 1;
                }
            }
            if count == 0 {
                continue;
            }
            let out = &mut dst[(dy as usize * dw as usize + dx as usize) * 4..];
            out[0] = (r / count) as u8;
            out[1] = (g / count) as u8;
            out[2] = (b / count) as u8;
            out[3] = (a / count) as u8;
        }
    }
}

// Variant C — x0/x1 hoisted AND per-pixel `count` replaced by the rectangle
// cardinality (x1-x0)*(y1-y0). This is the current casabio_encode.rs source: it drops
// one increment per source sample from the inner accumulation loop. Byte-identical to
// B (the old per-px count reaches exactly this value).
fn downscale_general_counthoist(src: &[u8], sw: u32, sh: u32, dst: &mut [u8], dw: u32, dh: u32) {
    let x_ranges: Vec<(u32, u32)> = (0..dw)
        .map(|dx| {
            let x0 = ((dx as u64 * sw as u64) / dw as u64) as u32;
            let x1 =
                (((dx as u64 + 1) * sw as u64 + dw as u64 - 1) / dw as u64).min(sw as u64) as u32;
            (x0, x1)
        })
        .collect();
    for dy in 0..dh {
        let y0 = ((dy as u64 * sh as u64) / dh as u64) as u32;
        let y1 = (((dy as u64 + 1) * sh as u64 + dh as u64 - 1) / dh as u64).min(sh as u64) as u32;
        for dx in 0..dw {
            let (x0, x1) = x_ranges[dx as usize];
            let count = (x1 - x0) * (y1 - y0);
            let mut r = 0u32;
            let mut g = 0u32;
            let mut b = 0u32;
            let mut a = 0u32;
            for sy in y0..y1 {
                let row = &src[(sy as usize * sw as usize * 4)..];
                for sx in x0..x1 {
                    let px = &row[(sx as usize * 4)..];
                    r += px[0] as u32;
                    g += px[1] as u32;
                    b += px[2] as u32;
                    a += px[3] as u32;
                }
            }
            if count == 0 {
                continue;
            }
            let out = &mut dst[(dy as usize * dw as usize + dx as usize) * 4..];
            out[0] = (r / count) as u8;
            out[1] = (g / count) as u8;
            out[2] = (b / count) as u8;
            out[3] = (a / count) as u8;
        }
    }
}

// Variant B — x0/x1 precomputed as x_ranges outside dy loop (hoisted)
fn downscale_general_hoisted(src: &[u8], sw: u32, sh: u32, dst: &mut [u8], dw: u32, dh: u32) {
    let x_ranges: Vec<(u32, u32)> = (0..dw)
        .map(|dx| {
            let x0 = ((dx as u64 * sw as u64) / dw as u64) as u32;
            let x1 =
                (((dx as u64 + 1) * sw as u64 + dw as u64 - 1) / dw as u64).min(sw as u64) as u32;
            (x0, x1)
        })
        .collect();
    for dy in 0..dh {
        let y0 = ((dy as u64 * sh as u64) / dh as u64) as u32;
        let y1 = (((dy as u64 + 1) * sh as u64 + dh as u64 - 1) / dh as u64).min(sh as u64) as u32;
        for dx in 0..dw {
            let (x0, x1) = x_ranges[dx as usize];
            let mut r = 0u32;
            let mut g = 0u32;
            let mut b = 0u32;
            let mut a = 0u32;
            let mut count = 0u32;
            for sy in y0..y1 {
                let row = &src[(sy as usize * sw as usize * 4)..];
                for sx in x0..x1 {
                    let px = &row[(sx as usize * 4)..];
                    r += px[0] as u32;
                    g += px[1] as u32;
                    b += px[2] as u32;
                    a += px[3] as u32;
                    count += 1;
                }
            }
            if count == 0 {
                continue;
            }
            let out = &mut dst[(dy as usize * dw as usize + dx as usize) * 4..];
            out[0] = (r / count) as u8;
            out[1] = (g / count) as u8;
            out[2] = (b / count) as u8;
            out[3] = (a / count) as u8;
        }
    }
}

fn med(v: &[f64]) -> f64 {
    let mut x: Vec<f64> = v[1..].to_vec(); // drop round 0 (cold)
    x.sort_by(|a, b| a.partial_cmp(b).unwrap());
    x[x.len() / 2]
}

fn stdev(v: &[f64], m: f64) -> f64 {
    let var = v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64;
    var.sqrt()
}

fn check_equal(a: &[u8], b: &[u8]) -> bool {
    a == b
}

fn main() {
    // Use non-exact-ratio dimensions so general branch always fires.
    // 4224×3168 → 1080×810: 4224/1080 = 3.911... (never exact).
    // Also test a smaller size for quick warmup verification.
    let sizes: &[(u32, u32, u32, u32)] = &[
        (1024, 768, 270, 202),   // small: 1024/270 = 3.792...
        (2592, 1944, 810, 608),  // medium: Olympus thumb crop
        (4224, 3168, 1080, 810), // large: typical preview
    ];

    let rounds = 13usize;

    for &(sw, sh, dw, dh) in sizes {
        // Deterministic synthetic RGBA8 source
        let npx = sw as usize * sh as usize;
        let mut src = vec![0u8; npx * 4];
        let mut s: u32 = 0x9e37_79b9u32.wrapping_mul(sw).wrapping_add(sh);
        for i in 0..npx {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            src[i * 4] = (s >> 24) as u8;
            src[i * 4 + 1] = (s >> 16) as u8;
            src[i * 4 + 2] = (s >> 8) as u8;
            src[i * 4 + 3] = 255;
        }

        let dst_len = dw as usize * dh as usize * 4;
        let mut dst_a = vec![0u8; dst_len];
        let mut dst_b = vec![0u8; dst_len];
        let mut dst_c = vec![0u8; dst_len];

        // Parity check (round 0) — all three variants must be byte-identical.
        downscale_general_baseline(&src, sw, sh, &mut dst_a, dw, dh);
        downscale_general_hoisted(&src, sw, sh, &mut dst_b, dw, dh);
        downscale_general_counthoist(&src, sw, sh, &mut dst_c, dw, dh);
        assert!(
            check_equal(&dst_a, &dst_b),
            "PARITY A!=B at {sw}x{sh}→{dw}x{dh}"
        );
        assert!(
            check_equal(&dst_b, &dst_c),
            "PARITY B!=C at {sw}x{sh}→{dw}x{dh}"
        );

        let time = |f: &mut dyn FnMut(), probe: u8, sink: &mut u64| {
            let t = Instant::now();
            f();
            *sink = sink.wrapping_add(probe as u64);
            t.elapsed().as_secs_f64() * 1e3
        };
        let (mut ta, mut tb, mut tc) = (Vec::new(), Vec::new(), Vec::new());
        let mut sink = 0u64;
        // 3-way start-rotation cancels thermal drift across A/B/C.
        for i in 0..rounds {
            let mut run_a = |sink: &mut u64| {
                let p = dst_a[dst_len / 2];
                ta.push(time(
                    &mut || downscale_general_baseline(&src, sw, sh, &mut dst_a, dw, dh),
                    p,
                    sink,
                ));
            };
            let mut run_b = |sink: &mut u64| {
                let p = dst_b[dst_len / 2];
                tb.push(time(
                    &mut || downscale_general_hoisted(&src, sw, sh, &mut dst_b, dw, dh),
                    p,
                    sink,
                ));
            };
            let mut run_c = |sink: &mut u64| {
                let p = dst_c[dst_len / 2];
                tc.push(time(
                    &mut || downscale_general_counthoist(&src, sw, sh, &mut dst_c, dw, dh),
                    p,
                    sink,
                ));
            };
            match i % 3 {
                0 => {
                    run_a(&mut sink);
                    run_b(&mut sink);
                    run_c(&mut sink);
                }
                1 => {
                    run_b(&mut sink);
                    run_c(&mut sink);
                    run_a(&mut sink);
                }
                _ => {
                    run_c(&mut sink);
                    run_a(&mut sink);
                    run_b(&mut sink);
                }
            }
        }
        std::hint::black_box(sink);

        let (ma, mb, mc) = (med(&ta), med(&tb), med(&tc));
        let sb = stdev(&tb[1..], mb);
        let sc = stdev(&tc[1..], mc);
        let mpx = (dw as f64 * dh as f64) / 1e6;
        let saved_bc = (mb - mc) / mb * 100.0; // the landed change: B(old src) → C(new src)
        println!(
            "{sw}x{sh}→{dw}x{dh} ({mpx:.2} Mpx):  A={ma:.2}  B(x-hoist)={mb:.2}±{sb:.2}  C(+count-hoist)={mc:.2}±{sc:.2}  B→C saved={saved_bc:+.1}%  parity=OK"
        );
    }
}
