//! box_downscale_hoist_flip — thermal-cancelled A/B for casabio_encode.rs
//! `box_downscale_rgba8`. Handoff items 2 (hoist stride math) + 7 (enumerate x_ranges).
//!
//! Box downscale runs once per cascade step (full→preview→thumb) and once per
//! pyramid sidecar level. Bandwidth-bound; the question is whether LLVM already
//! hoists the per-row `sw*4` / per-pixel `dw*4` index math and elides the
//! `x_ranges[dx]` bounds check — i.e. whether items 2+7 are real or compiler-neutral.
//!
//!   A = current:  per-row `&src[y*sw*4..]`, per-pixel `(dy*dw+dx)*4`, indexed `x_ranges[dx]`.
//!   B = hoisted:  precomputed `src_stride=sw*4`, `dst_stride=dw*4`, `x_ranges.iter().enumerate()`.
//!
//! Both exact-ratio (integer factor) and general (non-integer) paths are exercised.
//! Interleaved start-rotated rounds; round 0 dropped; median + %saved. Parity byte-EXACT.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example box_downscale_hoist_flip

use std::time::Instant;

// ── A: current casabio_encode.rs box_downscale_rgba8 (both paths) ──────────────
fn box_a(src: &[u8], sw: u32, sh: u32, dst: &mut [u8], dw: u32, dh: u32) {
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let count = xstep * ystep;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut r, mut g, mut b, mut a) = (0u32, 0u32, 0u32, 0u32);
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    let row = &src[(y as usize * sw as usize * 4)..];
                    for xx in 0..xstep {
                        let x = dx * xstep + xx;
                        let px = &row[(x as usize * 4)..];
                        r += px[0] as u32;
                        g += px[1] as u32;
                        b += px[2] as u32;
                        a += px[3] as u32;
                    }
                }
                let out = &mut dst[(dy as usize * dw as usize + dx as usize) * 4..];
                out[0] = (r / count) as u8;
                out[1] = (g / count) as u8;
                out[2] = (b / count) as u8;
                out[3] = (a / count) as u8;
            }
        }
        return;
    }
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
            let (mut r, mut g, mut b, mut a, mut count) = (0u32, 0u32, 0u32, 0u32, 0u32);
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

// ── B: hoisted strides + enumerate x_ranges (items 2+7) ────────────────────────
fn box_b(src: &[u8], sw: u32, sh: u32, dst: &mut [u8], dw: u32, dh: u32) {
    let src_stride = sw as usize * 4;
    let dst_stride = dw as usize * 4;
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let count = xstep * ystep;
        for dy in 0..dh {
            let out_row = &mut dst[dy as usize * dst_stride..];
            for dx in 0..dw {
                let (mut r, mut g, mut b, mut a) = (0u32, 0u32, 0u32, 0u32);
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    let row = &src[y as usize * src_stride..];
                    for xx in 0..xstep {
                        let x = dx * xstep + xx;
                        let px = &row[x as usize * 4..];
                        r += px[0] as u32;
                        g += px[1] as u32;
                        b += px[2] as u32;
                        a += px[3] as u32;
                    }
                }
                let out = &mut out_row[dx as usize * 4..];
                out[0] = (r / count) as u8;
                out[1] = (g / count) as u8;
                out[2] = (b / count) as u8;
                out[3] = (a / count) as u8;
            }
        }
        return;
    }
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
        let out_row = &mut dst[dy as usize * dst_stride..];
        for (dx, &(x0, x1)) in x_ranges.iter().enumerate() {
            let (mut r, mut g, mut b, mut a, mut count) = (0u32, 0u32, 0u32, 0u32, 0u32);
            for sy in y0..y1 {
                let row = &src[sy as usize * src_stride..];
                for sx in x0..x1 {
                    let px = &row[sx as usize * 4..];
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
            let out = &mut out_row[dx * 4..];
            out[0] = (r / count) as u8;
            out[1] = (g / count) as u8;
            out[2] = (b / count) as u8;
            out[3] = (a / count) as u8;
        }
    }
}

fn median(v: &[f64]) -> f64 {
    let mut w: Vec<f64> = v[1..].to_vec();
    w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    w[w.len() / 2]
}

fn run_case(label: &str, sw: u32, sh: u32, dw: u32, dh: u32) {
    let mut s: u32 = 0xdead_beef;
    let mut src = vec![0u8; sw as usize * sh as usize * 4];
    for v in src.iter_mut() {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *v = (s >> 24) as u8;
    }
    let mut da = vec![0u8; dw as usize * dh as usize * 4];
    let mut db = vec![0u8; dw as usize * dh as usize * 4];

    box_a(&src, sw, sh, &mut da, dw, dh);
    box_b(&src, sw, sh, &mut db, dw, dh);
    let parity = da == db;

    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut sink = 0u64;
    let mut scratch = vec![0u8; dw as usize * dh as usize * 4];
    for r in 0..rounds {
        let do_a = |scratch: &mut [u8], sink: &mut u64| {
            let t = Instant::now();
            box_a(&src, sw, sh, scratch, dw, dh);
            *sink = sink.wrapping_add(scratch[scratch.len() / 2] as u64);
            t.elapsed().as_secs_f64() * 1e3
        };
        let do_b = |scratch: &mut [u8], sink: &mut u64| {
            let t = Instant::now();
            box_b(&src, sw, sh, scratch, dw, dh);
            *sink = sink.wrapping_add(scratch[scratch.len() / 2] as u64);
            t.elapsed().as_secs_f64() * 1e3
        };
        if r % 2 == 0 {
            ta.push(do_a(&mut scratch, &mut sink));
            tb.push(do_b(&mut scratch, &mut sink));
        } else {
            tb.push(do_b(&mut scratch, &mut sink));
            ta.push(do_a(&mut scratch, &mut sink));
        }
    }
    std::hint::black_box(sink);

    let (ma, mb) = (median(&ta), median(&tb));
    let saved = (ma - mb) / ma * 100.0;
    println!(
        "{:>22} {:>5}×{:<5}→{:>5}×{:<5} | A {:>8.3}ms  B {:>8.3}ms  saved {:>6.1}%  parity {}",
        label,
        sw,
        sh,
        dw,
        dh,
        ma,
        mb,
        saved,
        if parity { "EXACT" } else { "*** BROKEN ***" }
    );
}

fn main() {
    println!("box_downscale_rgba8 flip — A=current  B=hoisted strides + enumerate (items 2+7)\n");
    // Exact-ratio path (integer factor) — the common cascade case.
    run_case("exact 4× (cascade)", 2048, 2048, 512, 512);
    run_case("exact 4× wide", 4096, 2160, 1024, 540);
    // General path (non-integer ratio) — preview/sidecar odd dims.
    run_case("general 1.78×", 1920, 1280, 1080, 720);
    run_case("general 5.0×ish", 6000, 4000, 1620, 1080);
    println!("\nGate ≥5% decides items 2+7. If ~0%, LLVM already hoists → keep current, register as neutral.");
}
