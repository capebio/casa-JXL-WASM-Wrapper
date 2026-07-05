//! Flipflop benchmark: casabio_encode optimizations vs baseline equivalents.
//!
//! Covers:
//!   A) FUSED alpha-scan + RGB-strip vs separate scan-then-copy (Tasks 1+2).
//!   B) Pyramid cascade with move vs clone (Tasks 3+4).
//!   C) box_downscale exact-ratio: count hoisted vs count per-pixel (Task 5).
//!
//! Run: cargo run --release --example casabio_encode_flip --no-default-features
//!
//! PARITY check: each op prints "PARITY OK" or "PARITY FAIL" before timing.

fn mkbuf(n_pixels: usize, seed: u32, all_opaque: bool) -> Vec<u8> {
    let mut d = vec![0u8; n_pixels * 4];
    let mut s = seed;
    for (i, slot) in d.iter_mut().enumerate() {
        s = s.wrapping_mul(1103515245).wrapping_add(12345);
        if i % 4 == 3 {
            *slot = if all_opaque {
                255
            } else {
                ((s >> 16) & 0xff) as u8
            };
        } else {
            *slot = (s >> 16) as u8;
        }
    }
    d
}

// ── A. Alpha scan + RGB strip (Tasks 1+2) ───────────────────────────────────

/// BASELINE: two separate passes.
fn baseline_alpha_then_strip(rgba: &[u8]) -> (bool, Option<Vec<u8>>) {
    // Pass 1: scan alpha.
    let has_alpha = rgba.chunks_exact(4).any(|px| px[3] < 255);
    if has_alpha {
        return (true, None);
    }
    // Pass 2: strip to RGB (unconditional alloc+copy).
    let n = rgba.len() / 4;
    let mut rgb = Vec::with_capacity(n * 3);
    for px in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&px[0..3]);
    }
    (false, Some(rgb))
}

/// OPTIMIZED: single fused pass (from alpha_strip in casabio_encode.rs).
fn optimized_alpha_strip(rgba: &[u8]) -> (bool, Option<Vec<u8>>) {
    let n = rgba.len() / 4;
    let mut rgb = Vec::with_capacity(n * 3);
    for px in rgba.chunks_exact(4) {
        if px[3] < 255 {
            return (true, None);
        }
        rgb.extend_from_slice(&px[0..3]);
    }
    (false, Some(rgb))
}

// ── B. Cascade clone vs move (Tasks 3+4) ────────────────────────────────────

fn box_downscale(src: &[u8], sw: u32, sh: u32, dst: &mut [u8], dw: u32, dh: u32) {
    if sw % dw == 0 && sh % dh == 0 {
        let xstep = (sw / dw) as usize;
        let ystep = (sh / dh) as usize;
        let count = (xstep * ystep) as u32;
        for dy in 0..dh as usize {
            for dx in 0..dw as usize {
                let mut r = 0u32;
                let mut g = 0u32;
                let mut b = 0u32;
                let mut a = 0u32;
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    let row = &src[(y * sw as usize * 4)..];
                    for xx in 0..xstep {
                        let x = dx * xstep + xx;
                        let px = &row[(x * 4)..];
                        r += px[0] as u32;
                        g += px[1] as u32;
                        b += px[2] as u32;
                        a += px[3] as u32;
                    }
                }
                let out = &mut dst[(dy * dw as usize + dx) * 4..];
                out[0] = (r / count) as u8;
                out[1] = (g / count) as u8;
                out[2] = (b / count) as u8;
                out[3] = (a / count) as u8;
            }
        }
    }
}

/// BASELINE: cascade using clone before move (original pattern).
fn cascade_clone(rgba: &[u8], w: u32, h: u32, steps: &[(u32, u32)]) -> Vec<(Vec<u8>, u32, u32)> {
    let mut scaled_bufs: Vec<(Vec<u8>, u32, u32)> = Vec::with_capacity(steps.len());
    let mut current = rgba.to_vec();
    let mut cw = w;
    let mut ch = h;
    for &(tw, th) in steps {
        let mut thumb = vec![0u8; tw as usize * th as usize * 4];
        box_downscale(&current, cw, ch, &mut thumb, tw, th);
        cw = tw;
        ch = th;
        scaled_bufs.push((thumb.clone(), tw, th)); // CLONE here
        current = thumb; // then MOVE
    }
    scaled_bufs
}

/// OPTIMIZED: cascade using move only (no clone).
fn cascade_move(rgba: &[u8], w: u32, h: u32, steps: &[(u32, u32)]) -> Vec<(Vec<u8>, u32, u32)> {
    let mut scaled_bufs: Vec<(Vec<u8>, u32, u32)> = Vec::with_capacity(steps.len());
    let mut cw = w;
    let mut ch = h;
    for &(tw, th) in steps {
        let mut thumb = vec![0u8; tw as usize * th as usize * 4];
        let src: &[u8] = if scaled_bufs.is_empty() {
            rgba
        } else {
            &scaled_bufs.last().unwrap().0
        };
        box_downscale(src, cw, ch, &mut thumb, tw, th);
        cw = tw;
        ch = th;
        scaled_bufs.push((thumb, tw, th)); // MOVE only — no clone
    }
    scaled_bufs
}

// ── C. count hoisted vs per-pixel (Task 5) ──────────────────────────────────

/// BASELINE: count incremented per pixel (original).
fn downscale_count_per_pixel(src: &[u8], sw: u32, sh: u32, dst: &mut [u8], dw: u32, dh: u32) {
    let xstep = sw / dw;
    let ystep = sh / dh;
    for dy in 0..dh {
        for dx in 0..dw {
            let mut r = 0u32;
            let mut g = 0u32;
            let mut b = 0u32;
            let mut a = 0u32;
            let mut count = 0u32;
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
                    count += 1;
                }
            }
            let out = &mut dst[(dy as usize * dw as usize + dx as usize) * 4..];
            out[0] = (r / count) as u8;
            out[1] = (g / count) as u8;
            out[2] = (b / count) as u8;
            out[3] = (a / count) as u8;
        }
    }
}

/// OPTIMIZED: count hoisted as constant (Task 5).
fn downscale_count_hoisted(src: &[u8], sw: u32, sh: u32, dst: &mut [u8], dw: u32, dh: u32) {
    let xstep = sw / dw;
    let ystep = sh / dh;
    let count = xstep * ystep; // hoisted — loop-invariant constant
    for dy in 0..dh {
        for dx in 0..dw {
            let mut r = 0u32;
            let mut g = 0u32;
            let mut b = 0u32;
            let mut a = 0u32;
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
}

// ── Benchmark harness ────────────────────────────────────────────────────────

fn median(v: &mut Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn bench<A, B>(
    label: &str,
    a_label: &str,
    b_label: &str,
    rounds: usize,
    iters: usize,
    mut a: A,
    mut b: B,
) where
    A: FnMut() -> (),
    B: FnMut() -> (),
{
    // Warmup
    for _ in 0..4 {
        a();
        b();
    }

    let mut a_times = Vec::with_capacity(rounds);
    let mut b_times = Vec::with_capacity(rounds);

    for r in 0..rounds {
        let time_a = {
            let t = std::time::Instant::now();
            for _ in 0..iters {
                a();
            }
            t.elapsed().as_secs_f64() * 1000.0 / iters as f64
        };
        let time_b = {
            let t = std::time::Instant::now();
            for _ in 0..iters {
                b();
            }
            t.elapsed().as_secs_f64() * 1000.0 / iters as f64
        };
        if r % 2 == 0 {
            a_times.push(time_a);
            b_times.push(time_b);
        } else {
            b_times.push(time_b);
            a_times.push(time_a);
        }
    }

    let a_med = median(&mut a_times);
    let b_med = median(&mut b_times);
    let speedup = a_med / b_med;
    let pct = (1.0 - b_med / a_med) * 100.0;
    println!("  {} (baseline): {:.3} ms", a_label, a_med);
    println!("  {} (optimized): {:.3} ms", b_label, b_med);
    println!("  {} speedup: {:.2}x  ({:+.1}%)\n", label, speedup, pct);
}

fn main() {
    let sizes: &[(usize, usize, &str)] = &[
        (1920, 1280, "2.46MP"),
        (3840, 2560, "9.83MP"),
        (6016, 4016, "24.16MP"),
    ];

    let rounds = 12usize;
    let iters = 8usize;

    println!("\n=== casabio_encode_flip: optimized vs baseline ===\n");

    // ── A. Alpha-scan + RGB-strip fusion (Tasks 1+2) ──────────────────────

    println!("--- A. Fused alpha-scan + RGB-strip (Tasks 1+2) ---");
    println!("(no-alpha / RAW-like path — dominant production case)\n");

    for &(w, h, label) in sizes {
        let px = w * h;
        let buf = mkbuf(px, 42, true); // all opaque — RAW path

        // Parity check
        let base_out = baseline_alpha_then_strip(&buf);
        let opt_out = optimized_alpha_strip(&buf);
        let parity = base_out.0 == opt_out.0 && base_out.1 == opt_out.1;
        println!(
            "  {} PARITY: {}",
            label,
            if parity { "OK" } else { "FAIL *** CHECK ***" }
        );

        bench(
            label,
            "separate scan+copy",
            "fused scan+copy",
            rounds,
            iters,
            || {
                std::hint::black_box(baseline_alpha_then_strip(&buf));
            },
            || {
                std::hint::black_box(optimized_alpha_strip(&buf));
            },
        );
    }

    println!("(alpha path — early-exit case)\n");
    for &(w, h, label) in sizes {
        let px = w * h;
        let buf = mkbuf(px, 99, false); // has alpha — early-abort

        let base_out = baseline_alpha_then_strip(&buf);
        let opt_out = optimized_alpha_strip(&buf);
        let parity = base_out.0 == opt_out.0;
        println!(
            "  {} (alpha) PARITY: {}",
            label,
            if parity { "OK" } else { "FAIL *** CHECK ***" }
        );

        bench(
            &format!("{} (alpha)", label),
            "separate scan (no strip)",
            "fused (early abort)",
            rounds,
            iters,
            || {
                std::hint::black_box(baseline_alpha_then_strip(&buf));
            },
            || {
                std::hint::black_box(optimized_alpha_strip(&buf));
            },
        );
    }

    // ── B. Cascade clone vs move (Tasks 3+4) ──────────────────────────────

    println!("--- B. Cascade resize: clone vs move (Tasks 3+4) ---\n");

    // Use a 3-level pyramid: 4096->2048->1024->512
    let w = 4096u32;
    let h = 4096u32;
    let steps: &[(u32, u32)] = &[(2048, 2048), (1024, 1024), (512, 512)];

    let buf = mkbuf((w * h) as usize, 7, true);

    // Parity check
    let base_levels = cascade_clone(&buf, w, h, steps);
    let opt_levels = cascade_move(&buf, w, h, steps);
    let parity = base_levels.len() == opt_levels.len()
        && base_levels
            .iter()
            .zip(opt_levels.iter())
            .all(|(a, b)| a.0 == b.0 && a.1 == b.1 && a.2 == b.2);
    println!(
        "  4096px 3-level cascade PARITY: {}",
        if parity { "OK" } else { "FAIL *** CHECK ***" }
    );

    bench(
        "4096px 3-level pyramid cascade",
        "cascade with clone",
        "cascade with move",
        rounds,
        4,
        || {
            std::hint::black_box(cascade_clone(&buf, w, h, steps));
        },
        || {
            std::hint::black_box(cascade_move(&buf, w, h, steps));
        },
    );

    // ── C. count hoisted vs per-pixel (Task 5) ────────────────────────────

    println!("--- C. box_downscale exact-ratio: count hoisted vs per-pixel (Task 5) ---\n");

    for &(w, h, label) in sizes {
        // Downscale by 4× (exact ratio)
        let dw = (w / 4) as u32;
        let dh = (h / 4) as u32;
        let sw = w as u32;
        let sh = h as u32;
        let buf = mkbuf(w * h, 13, true);
        let mut dst_base = vec![0u8; dw as usize * dh as usize * 4];
        let mut dst_opt = vec![0u8; dw as usize * dh as usize * 4];

        downscale_count_per_pixel(&buf, sw, sh, &mut dst_base, dw, dh);
        downscale_count_hoisted(&buf, sw, sh, &mut dst_opt, dw, dh);
        let parity = dst_base == dst_opt;
        println!(
            "  {} 4× downscale PARITY: {}",
            label,
            if parity { "OK" } else { "FAIL *** CHECK ***" }
        );

        bench(
            &format!("{} 4× downscale", label),
            "count per-pixel",
            "count hoisted",
            rounds,
            iters,
            || {
                let mut dst = vec![0u8; dw as usize * dh as usize * 4];
                downscale_count_per_pixel(&buf, sw, sh, &mut dst, dw, dh);
                std::hint::black_box(dst);
            },
            || {
                let mut dst = vec![0u8; dw as usize * dh as usize * 4];
                downscale_count_hoisted(&buf, sw, sh, &mut dst, dw, dh);
                std::hint::black_box(dst);
            },
        );
    }
}
