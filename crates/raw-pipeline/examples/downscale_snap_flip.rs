//! downscale_snap_flip — thermal-cancelled A/B for the lightbox downscale (src/lib.rs
//! downscale_rgb16_planar). The production lightbox target (target_dims → e.g. 1800) rarely
//! divides the source evenly, so the FLOAT box-boundary path runs every decode. Snapping the
//! target to an integer step (round(sw/target)) lets the integer pointer-advance path fire.
//! Output is a DISPLAY PROXY only (lightbox/thumb) — the full-res master is never downscaled.
//!
//!   A = float path (dw=1800, per-pixel f32 boundaries)   B = integer-snap (dw=1728, box 3×3)
//!
//! Not byte-exact (box boundaries differ ≤1 src px; output dims shift ≤a few px). Interleaved
//! start-rotated; round 0 dropped; median + ms/Mpx (normalized for the small dim difference).
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example downscale_snap_flip
use std::time::Instant;

#[inline]
fn wr(out: &mut [u8], o: usize, r: u16, g: u16, b: u16) {
    out[o] = (r & 0xff) as u8;
    out[o + 1] = (r >> 8) as u8;
    out[o + 2] = (g & 0xff) as u8;
    out[o + 3] = (g >> 8) as u8;
    out[o + 4] = (b & 0xff) as u8;
    out[o + 5] = (b >> 8) as u8;
}

// Float box-boundary path (mirror of downscale_rgb_float_path interior).
fn planar_float(
    r: &[u16],
    g: &[u16],
    b: &[u16],
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh * 6];
    let (xr, yr) = (sw as f32 / dw as f32, sh as f32 / dh as f32);
    let mut o = 0usize;
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = (((dy as f32 + 1.0) * yr).min(sh as f32) as usize).max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = (((dx as f32 + 1.0) * xr).min(sw as f32) as usize).max(x0 + 1);
            let n = ((y1 - y0) * (x1 - x0)).max(1) as u32;
            let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
            let mut row_base = y0 * sw;
            for _y in y0..y1 {
                for x in x0..x1 {
                    rr += r[row_base + x] as u32;
                    gg += g[row_base + x] as u32;
                    bb += b[row_base + x] as u32;
                }
                row_base += sw;
            }
            wr(
                &mut out,
                o,
                (rr / n) as u16,
                (gg / n) as u16,
                (bb / n) as u16,
            );
            o += 6;
        }
    }
    out
}

// Integer pointer-advance path (mirror of downscale_rgb16_planar fast path).
fn planar_int(
    r: &[u16],
    g: &[u16],
    b: &[u16],
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh * 6];
    let (xstep, ystep) = (sw / dw, sh / dh);
    let pc = (xstep * ystep) as u32;
    let mut o = 0usize;
    for dy in 0..dh {
        for dx in 0..dw {
            let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
            let x_base = dx * xstep;
            let mut row_base = dy * ystep * sw;
            for _yy in 0..ystep {
                let mut idx = row_base + x_base;
                for _xx in 0..xstep {
                    rr += r[idx] as u32;
                    gg += g[idx] as u32;
                    bb += b[idx] as u32;
                    idx += 1;
                }
                row_base += sw;
            }
            wr(
                &mut out,
                o,
                (rr / pc) as u16,
                (gg / pc) as u16,
                (bb / pc) as u16,
            );
            o += 6;
        }
    }
    out
}

fn med(v: &[f64]) -> f64 {
    let mut x: Vec<f64> = v[1..].to_vec();
    x.sort_by(|a, b| a.partial_cmp(b).unwrap());
    x[x.len() / 2]
}

fn main() {
    let (sw, sh) = (5184usize, 3888usize); // real Olympus full-res
    let mut s: u32 = 0x9e37_79b9;
    let gen = |seed: u32| {
        let mut s = seed;
        (0..sw * sh)
            .map(move |_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((s >> 12) & 0x3fff) as u16
            })
            .collect::<Vec<u16>>()
    };
    let (r, g, b) = (gen(s), gen(s ^ 0xaaaa), gen(s ^ 0x5555));
    s = s.wrapping_add(1);
    std::hint::black_box(s);

    // A: float to 1800 (non-dividing). B: integer-snap step=3 → 1728×1296.
    let (fdw, fdh) = (1800usize, 1350usize);
    let (xstep, ystep) = (
        (sw as f32 / 1800.0).round() as usize,
        (sh as f32 / 1350.0).round() as usize,
    );
    let (idw, idh) = (sw / xstep, sh / ystep);

    let run_a = || planar_float(&r, &g, &b, sw, sh, fdw, fdh);
    let run_b = || planar_int(&r, &g, &b, sw, sh, idw, idh);

    let time = |f: &dyn Fn() -> Vec<u8>, sink: &mut u64| {
        let t = Instant::now();
        let out = f();
        *sink = sink.wrapping_add(out[out.len() / 2] as u64);
        t.elapsed().as_secs_f64() * 1e3
    };
    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut sink = 0u64;
    for i in 0..rounds {
        if i % 2 == 0 {
            ta.push(time(&run_a, &mut sink));
            tb.push(time(&run_b, &mut sink));
        } else {
            tb.push(time(&run_b, &mut sink));
            ta.push(time(&run_a, &mut sink));
        }
    }
    std::hint::black_box(sink);
    let (ma, mb) = (med(&ta), med(&tb));
    let (mpa, mpb) = ((fdw * fdh) as f64 / 1e6, (idw * idh) as f64 / 1e6);
    println!("lightbox downscale flip  src {sw}x{sh}");
    println!(
        "  A float  {fdw}x{fdh} ({mpa:.2} Mpx): {ma:.2}ms  ({:.2} ms/Mpx)",
        ma / mpa
    );
    println!(
        "  B intsnap {idw}x{idh} ({mpb:.2} Mpx): {mb:.2}ms  ({:.2} ms/Mpx)",
        mb / mpb
    );
    println!(
        "  wall saved={:.1}%  per-Mpx saved={:.1}%",
        (ma - mb) / ma * 100.0,
        ((ma / mpa) - (mb / mpb)) / (ma / mpa) * 100.0
    );
}
