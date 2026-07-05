//! dng_decode_scaling — does the per-tile LJPEG decode saturate cores?
//! Measures serial tile-decode sum vs rayon-parallel tile decode (same work),
//! plus full dng::decode_bytes wall time. Reports speedup and efficiency.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features \
//!        --features parallel --example dng_decode_scaling -- <file.dng>
use raw_pipeline::{dng, ljpeg};
use rayon::prelude::*;
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        r"C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng"
            .into()
    });
    let data = std::fs::read(&path).expect("read DNG");
    let ranges = dng::ljpeg_tile_ranges(&data).expect("tile ranges");
    let threads = rayon::current_num_threads();

    // (offset,end,w,h) per tile.
    let tiles: Vec<(usize, usize, usize, usize)> = ranges
        .iter()
        .map(|&(o, e)| {
            let i = ljpeg::probe_tile(&data[o..e]).expect("probe");
            (o, e, i.width as usize, i.height as usize)
        })
        .collect();

    let serial = |_n: usize| -> f64 {
        let t = Instant::now();
        let mut acc = 0u64;
        for &(o, e, w, h) in &tiles {
            let mut buf = vec![0u16; w * h];
            ljpeg::decode_tile_compact(&data[o..e], &mut buf, w, h).expect("dec");
            acc = acc.wrapping_add(buf[buf.len() / 2] as u64);
        }
        std::hint::black_box(acc);
        t.elapsed().as_secs_f64() * 1e3
    };

    let parallel = |_n: usize| -> f64 {
        let t = Instant::now();
        let acc: u64 = tiles
            .par_iter()
            .map(|&(o, e, w, h)| {
                let mut buf = vec![0u16; w * h];
                ljpeg::decode_tile_compact(&data[o..e], &mut buf, w, h).expect("dec");
                buf[buf.len() / 2] as u64
            })
            .sum();
        std::hint::black_box(acc);
        t.elapsed().as_secs_f64() * 1e3
    };

    let full = || -> f64 {
        let t = Instant::now();
        let img = dng::decode_bytes(&data).expect("decode_bytes");
        std::hint::black_box(img.raw[img.raw.len() / 2]);
        t.elapsed().as_secs_f64() * 1e3
    };

    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec();
        w.sort_by(|a, b| a.partial_cmp(b).unwrap());
        w[w.len() / 2]
    };

    // Interleave serial/parallel to cancel drift.
    let (mut ts, mut tp, mut tf) = (Vec::new(), Vec::new(), Vec::new());
    for r in 0..11 {
        if r % 2 == 0 {
            ts.push(serial(r));
            tp.push(parallel(r));
        } else {
            tp.push(parallel(r));
            ts.push(serial(r));
        }
        tf.push(full());
    }
    let (ms, mp, mf) = (med(&ts), med(&tp), med(&tf));
    let speedup = ms / mp;
    println!(
        "file: {}  tiles: {}  rayon threads: {threads} (6 physical)",
        path.rsplit(['\\', '/']).next().unwrap_or(&path),
        tiles.len()
    );
    println!("  serial tile decode  : {ms:.2} ms");
    println!("  parallel tile decode: {mp:.2} ms");
    println!("  speedup: {speedup:.2}x / {threads} threads = {:.0}% efficiency (6 physical cores; HT idle on latency-bound decode)", speedup / threads as f64 * 100.0);
    println!(
        "  full dng::decode_bytes: {mf:.2} ms  (LJPEG decode = {:.0}%, blit+alloc+parse = {:.0}%)",
        mp / mf * 100.0,
        (mf - mp) / mf * 100.0
    );
}
