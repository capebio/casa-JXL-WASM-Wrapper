//! box_downscale_rgb_parity_flip — proves the RGB-native cascade step is byte-identical to
//! the RGBA cascade step + alpha strip, and times the two.
//!
//! The opaque (RAW) pyramid path used to downscale 4 channels then strip alpha off every
//! level. The meta-seam cut downscales 3 channels directly. Because box averaging is
//! per-channel independent, the RGB output is byte-identical — this harness asserts that,
//! then measures the per-level cost:
//!
//!   A = box_downscale_rgba8(rgba) then strip_rgba_to_rgb   (old per-level work)
//!   B = box_downscale_rgb8(rgb)                            (new — 25% less traffic, no strip)
//!
//! Interleaved, start-rotated; round 0 dropped; median + stdev reported.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example box_downscale_rgb_parity_flip

use std::time::Instant;

// ── copies of the private casabio_encode helpers (examples can't see private fns) ──

fn strip_rgba_to_rgb(rgba: &[u8]) -> Vec<u8> {
    let n = rgba.len() / 4;
    let mut rgb = Vec::with_capacity(n * 3);
    rgb.extend(rgba.chunks_exact(4).flat_map(|px| [px[0], px[1], px[2]]));
    rgb
}

fn box_downscale_rgba8(src: &[u8], sw: u32, sh: u32, dst: &mut [u8], dw: u32, dh: u32) -> bool {
    if dw == 0 || dh == 0 { return false; }
    let src_len = (sw as usize).checked_mul(sh as usize).and_then(|n| n.checked_mul(4));
    let dst_len = (dw as usize).checked_mul(dh as usize).and_then(|n| n.checked_mul(4));
    let (src_len, dst_len) = match (src_len, dst_len) { (Some(s), Some(d)) => (s, d), _ => return false };
    if src.len() < src_len || dst.len() < dst_len { return false; }
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw; let ystep = sh / dh; let count = xstep * ystep;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut r, mut g, mut b, mut a) = (0u32, 0u32, 0u32, 0u32);
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    let row = &src[(y as usize * sw as usize * 4)..];
                    for xx in 0..xstep {
                        let x = dx * xstep + xx;
                        let px = &row[(x as usize * 4)..];
                        r += px[0] as u32; g += px[1] as u32; b += px[2] as u32; a += px[3] as u32;
                    }
                }
                let out = &mut dst[(dy as usize * dw as usize + dx as usize) * 4..];
                out[0] = (r / count) as u8; out[1] = (g / count) as u8;
                out[2] = (b / count) as u8; out[3] = (a / count) as u8;
            }
        }
        return true;
    }
    let x_ranges: Vec<(u32, u32)> = (0..dw).map(|dx| {
        let x0 = ((dx as u64 * sw as u64) / dw as u64) as u32;
        let x1 = (((dx as u64 + 1) * sw as u64 + dw as u64 - 1) / dw as u64).min(sw as u64) as u32;
        (x0, x1)
    }).collect();
    for dy in 0..dh {
        let y0 = ((dy as u64 * sh as u64) / dh as u64) as u32;
        let y1 = (((dy as u64 + 1) * sh as u64 + dh as u64 - 1) / dh as u64).min(sh as u64) as u32;
        for dx in 0..dw {
            let (x0, x1) = x_ranges[dx as usize];
            let count = (x1 - x0) * (y1 - y0);
            let (mut r, mut g, mut b, mut a) = (0u32, 0u32, 0u32, 0u32);
            for sy in y0..y1 {
                let row = &src[(sy as usize * sw as usize * 4)..];
                for sx in x0..x1 {
                    let px = &row[(sx as usize * 4)..];
                    r += px[0] as u32; g += px[1] as u32; b += px[2] as u32; a += px[3] as u32;
                }
            }
            if count == 0 { continue; }
            let out = &mut dst[(dy as usize * dw as usize + dx as usize) * 4..];
            out[0] = (r / count) as u8; out[1] = (g / count) as u8;
            out[2] = (b / count) as u8; out[3] = (a / count) as u8;
        }
    }
    true
}

fn box_downscale_rgb8(src: &[u8], sw: u32, sh: u32, dst: &mut [u8], dw: u32, dh: u32) -> bool {
    if dw == 0 || dh == 0 { return false; }
    let src_len = (sw as usize).checked_mul(sh as usize).and_then(|n| n.checked_mul(3));
    let dst_len = (dw as usize).checked_mul(dh as usize).and_then(|n| n.checked_mul(3));
    let (src_len, dst_len) = match (src_len, dst_len) { (Some(s), Some(d)) => (s, d), _ => return false };
    if src.len() < src_len || dst.len() < dst_len { return false; }
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw; let ystep = sh / dh; let count = xstep * ystep;
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    let row = &src[(y as usize * sw as usize * 3)..];
                    for xx in 0..xstep {
                        let x = dx * xstep + xx;
                        let px = &row[(x as usize * 3)..];
                        r += px[0] as u32; g += px[1] as u32; b += px[2] as u32;
                    }
                }
                let out = &mut dst[(dy as usize * dw as usize + dx as usize) * 3..];
                out[0] = (r / count) as u8; out[1] = (g / count) as u8; out[2] = (b / count) as u8;
            }
        }
        return true;
    }
    let x_ranges: Vec<(u32, u32)> = (0..dw).map(|dx| {
        let x0 = ((dx as u64 * sw as u64) / dw as u64) as u32;
        let x1 = (((dx as u64 + 1) * sw as u64 + dw as u64 - 1) / dw as u64).min(sw as u64) as u32;
        (x0, x1)
    }).collect();
    for dy in 0..dh {
        let y0 = ((dy as u64 * sh as u64) / dh as u64) as u32;
        let y1 = (((dy as u64 + 1) * sh as u64 + dh as u64 - 1) / dh as u64).min(sh as u64) as u32;
        for dx in 0..dw {
            let (x0, x1) = x_ranges[dx as usize];
            let count = (x1 - x0) * (y1 - y0);
            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            for sy in y0..y1 {
                let row = &src[(sy as usize * sw as usize * 3)..];
                for sx in x0..x1 {
                    let px = &row[(sx as usize * 3)..];
                    r += px[0] as u32; g += px[1] as u32; b += px[2] as u32;
                }
            }
            if count == 0 { continue; }
            let out = &mut dst[(dy as usize * dw as usize + dx as usize) * 3..];
            out[0] = (r / count) as u8; out[1] = (g / count) as u8; out[2] = (b / count) as u8;
        }
    }
    true
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
    // Representative cascade steps (mix of exact and general ratios).
    let sizes: &[(u32, u32, u32, u32)] = &[
        (2048, 1536, 1024, 768),   // exact 2:1
        (2592, 1944, 1080, 810),   // general
        (4224, 3168, 2048, 1536),  // general, large
        (1080, 810,  300, 225),    // general, thumb-ish
    ];
    let rounds = 13usize;

    println!("box_downscale_rgb_parity_flip — A=rgba8+strip  B=rgb8-native\n");
    for &(sw, sh, dw, dh) in sizes {
        let rgba = {
            let n = sw as usize * sh as usize;
            let mut v = vec![0u8; n * 4];
            let mut s: u32 = 0x9e37_79b9u32.wrapping_mul(sw).wrapping_add(sh);
            for i in 0..n {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                v[i * 4] = (s >> 24) as u8; v[i * 4 + 1] = (s >> 16) as u8;
                v[i * 4 + 2] = (s >> 8) as u8; v[i * 4 + 3] = 255;
            }
            v
        };
        let rgb = strip_rgba_to_rgb(&rgba);

        // Parity (round 0)
        let mut da4 = vec![0u8; (dw * dh * 4) as usize];
        let mut db3 = vec![0u8; (dw * dh * 3) as usize];
        box_downscale_rgba8(&rgba, sw, sh, &mut da4, dw, dh);
        box_downscale_rgb8(&rgb, sw, sh, &mut db3, dw, dh);
        assert_eq!(strip_rgba_to_rgb(&da4), db3, "PARITY FAIL at {sw}x{sh}->{dw}x{dh}");

        let time = |f: &mut dyn FnMut(), probe: u8, sink: &mut u64| {
            let t = Instant::now(); f();
            *sink = sink.wrapping_add(probe as u64);
            t.elapsed().as_secs_f64() * 1e3
        };
        let (mut ta, mut tb) = (Vec::new(), Vec::new());
        let mut sink = 0u64;
        for i in 0..rounds {
            // A = downscale rgba8 then strip (the old per-level work)
            let mut run_a = |sink: &mut u64| {
                let p = da4[da4.len() / 2];
                ta.push(time(&mut || {
                    box_downscale_rgba8(&rgba, sw, sh, &mut da4, dw, dh);
                    let s = strip_rgba_to_rgb(&da4);
                    std::hint::black_box(&s);
                }, p, sink));
            };
            let mut run_b = |sink: &mut u64| {
                let p = db3[db3.len() / 2];
                tb.push(time(&mut || { box_downscale_rgb8(&rgb, sw, sh, &mut db3, dw, dh); }, p, sink));
            };
            if i % 2 == 0 { run_a(&mut sink); run_b(&mut sink); }
            else { run_b(&mut sink); run_a(&mut sink); }
        }
        std::hint::black_box(sink);

        let (ma, mb) = (med(&ta), med(&tb));
        let sa = stdev(&ta[1..], ma);
        let sb = stdev(&tb[1..], mb);
        let mpx = (dw as f64 * dh as f64) / 1e6;
        let saved = (ma - mb) / ma * 100.0;
        println!(
            "{sw}x{sh}->{dw}x{dh} ({mpx:.2} Mpx):  A(rgba8+strip)={ma:.2}ms±{sa:.2}  B(rgb8)={mb:.2}ms±{sb:.2}  saved={saved:+.1}%  parity=OK"
        );
    }
}
