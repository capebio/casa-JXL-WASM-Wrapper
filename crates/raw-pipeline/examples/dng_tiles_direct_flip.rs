//! dng_tiles_direct_flip — A/B the compressed DNG tile path.
//!
//!   A (blit)   = `decode_bytes_blit`  : per-tile compact Vec + single-threaded serial blit
//!   B (direct) = `decode_bytes`       : band-parallel direct strided decode into `out`
//!
//! Asserts the two produce a BYTE-IDENTICAL raw mosaic (parity gate), then times them
//! interleaved with start rotation to cancel thermal drift (speed gate). Run:
//!   cd crates/raw-pipeline && cargo run --release --no-default-features \
//!       --features parallel --example dng_tiles_direct_flip -- <file.dng>
use raw_pipeline::{dng, ljpeg};
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        r"C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng"
            .into()
    });
    let data = std::fs::read(&path).expect("read DNG");

    // --- diagnostics: tile geometry vs grid units ---
    if let Ok(ranges) = dng::ljpeg_tile_ranges(&data) {
        if let Some(&(o, e)) = ranges.first() {
            if let Ok(i) = ljpeg::probe_tile(&data[o..e]) {
                println!(
                    "tile0 SOF: width(samples)={} height={} cps={} prec={}  (tiles={})",
                    i.width,
                    i.height,
                    i.components,
                    i.precision,
                    ranges.len()
                );
            }
        }
    }

    // --- parity: byte-identical raw mosaic ---
    let a = dng::decode_bytes_blit(&data).expect("blit decode");
    let b = dng::decode_bytes(&data).expect("direct decode");
    assert_eq!(a.width, b.width, "width mismatch");
    assert_eq!(a.height, b.height, "height mismatch");
    assert_eq!(a.raw.len(), b.raw.len(), "raw len mismatch");
    let w = a.width;
    let diffs = a
        .raw
        .iter()
        .zip(b.raw.iter())
        .filter(|(x, y)| x != y)
        .count();
    let max_abs = a
        .raw
        .iter()
        .zip(b.raw.iter())
        .map(|(x, y)| (*x as i32 - *y as i32).unsigned_abs())
        .max()
        .unwrap_or(0);
    println!(
        "parity: {}x{}  px_differ_count={diffs}  max_abs_diff={max_abs}  ({})",
        a.width,
        a.height,
        if diffs == 0 { "BIT-EXACT" } else { "DIVERGENT" }
    );
    // First 8 divergences with (row,col) to expose the pattern (stride/unit/edge).
    let mut shown = 0;
    for (idx, (x, y)) in a.raw.iter().zip(b.raw.iter()).enumerate() {
        if x != y {
            println!(
                "  diff @ idx={idx} (row={}, col={})  blit={x} direct={y}",
                idx / w,
                idx % w
            );
            shown += 1;
            if shown >= 8 {
                break;
            }
        }
    }
    assert_eq!(
        diffs, 0,
        "tile paths diverged ({diffs} px, max_abs={max_abs})"
    );

    // --- timing: interleaved, start-rotated, round-0 dropped ---
    let blit = || -> f64 {
        let t = Instant::now();
        let img = dng::decode_bytes_blit(&data).expect("blit");
        std::hint::black_box(img.raw[img.raw.len() / 2]);
        t.elapsed().as_secs_f64() * 1e3
    };
    let direct = || -> f64 {
        let t = Instant::now();
        let img = dng::decode_bytes(&data).expect("direct");
        std::hint::black_box(img.raw[img.raw.len() / 2]);
        t.elapsed().as_secs_f64() * 1e3
    };

    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    for r in 0..13 {
        if r % 2 == 0 {
            ta.push(blit());
            tb.push(direct());
        } else {
            tb.push(direct());
            ta.push(blit());
        }
    }
    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec();
        w.sort_by(|a, b| a.partial_cmp(b).unwrap());
        w[w.len() / 2]
    };
    let (ma, mb) = (med(&ta), med(&tb));
    let delta = (mb - ma) / ma * 100.0;
    println!("  A blit (Vec+serial blit) : {ma:.2} ms");
    println!("  B direct (band-parallel) : {mb:.2} ms");
    println!(
        "  delta: {delta:+.1}%  ({})",
        if delta < 0.0 { "B faster" } else { "B slower" }
    );
}
