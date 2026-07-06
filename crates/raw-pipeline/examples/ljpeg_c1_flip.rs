//! ljpeg_c1_flip — thermal-cancelled A/B of the LJPEG entropy decoder on REAL
//! DNG tiles, isolating the monomorphized single-component kernel:
//!
//!   A = generic  (decode_tile_generic — arbitrary cps/precision loop)
//!   B = c1       (decode_tile — dispatches cps=1 to decode_c1::<PRECISION>)
//!
//! All compression-7 tiles of the DNG are decoded each round (compact buffers).
//! Interleaved start-rotated rounds; round 0 dropped; median + %saved. Outputs
//! are asserted byte-identical (parity gate) before timing.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features \
//!        --example ljpeg_c1_flip -- <file.dng>
use raw_pipeline::{dng, ljpeg};
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        r"C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng"
            .into()
    });
    let data = std::fs::read(&path).expect("read DNG");
    let ranges = dng::ljpeg_tile_ranges(&data).expect("ljpeg tile ranges");
    assert!(!ranges.is_empty(), "no LJPEG tiles");

    // Probe geometry (first tile) and pre-size compact buffers per tile.
    let info0 = ljpeg::probe_tile(&data[ranges[0].0..ranges[0].1]).expect("probe");
    println!(
        "file: {}  tiles: {}  tile0: {}x{} cps={} prec={}",
        path.rsplit(['\\', '/']).next().unwrap_or(&path),
        ranges.len(),
        info0.width,
        info0.height,
        info0.components,
        info0.precision,
    );

    // Per-tile (slice, buf_w, buf_h).
    let tiles: Vec<(&[u8], usize, usize)> = ranges
        .iter()
        .map(|&(o, e)| {
            let src = &data[o..e];
            let i = ljpeg::probe_tile(src).expect("probe tile");
            (src, i.width as usize, i.height as usize)
        })
        .collect();

    // Parity gate: every tile must decode byte-identically on both paths.
    for (idx, &(src, w, h)) in tiles.iter().enumerate() {
        let mut a = vec![0u16; w * h];
        let mut b = vec![0u16; w * h];
        ljpeg::decode_tile_generic(src, &mut a, 0, w, w, h).expect("generic decode");
        ljpeg::decode_tile(src, &mut b, 0, w, w, h).expect("c1 decode");
        assert_eq!(a, b, "parity mismatch on tile {idx}");
    }

    // Huffman code-length distribution: fast8 (<=8-bit) vs slow (>8-bit) path.
    // Decides whether a wider fast12 prefix table would pay off.
    {
        let (mut fast8, mut slow, mut gbits) = (0u64, 0u64, 0u64);
        let mut hist = [0u64; 17];
        for &(src, w, h) in &tiles {
            let mut buf = vec![0u16; w * h];
            let s = ljpeg::decode_tile_stats(src, &mut buf, 0, w, w, h).expect("stats");
            fast8 += s.fast8_hits;
            slow += s.slow_huffman_hits;
            gbits += s.get_bits_total_bits;
            for (i, c) in s.category_hist.iter().enumerate() {
                hist[i] += c;
            }
        }
        let total = (fast8 + slow).max(1);
        println!(
            "huffman: fast8(<=8b)={:.2}%  slow(>8b)={:.2}%  ({} symbols, {} magnitude bits, avg cat {:.2})",
            fast8 as f64 / total as f64 * 100.0,
            slow as f64 / total as f64 * 100.0,
            total, gbits,
            gbits as f64 / total as f64,
        );
        print!("category histogram: ");
        for (cat, &n) in hist.iter().enumerate() {
            if n > 0 {
                print!("{cat}:{:.1}% ", n as f64 / total as f64 * 100.0);
            }
        }
        println!();
    }

    // One full-frame decode pass = decode every tile once.
    let decode_all = |use_c1: bool, sink: &mut u64| -> f64 {
        let t = Instant::now();
        for &(src, w, h) in &tiles {
            let mut buf = vec![0u16; w * h];
            if use_c1 {
                ljpeg::decode_tile(src, &mut buf, 0, w, w, h).expect("c1");
            } else {
                ljpeg::decode_tile_generic(src, &mut buf, 0, w, w, h).expect("generic");
            }
            *sink = sink.wrapping_add(buf[buf.len() / 2] as u64);
        }
        t.elapsed().as_secs_f64() * 1e3
    };

    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec(); // drop round 0
        w.sort_by(|a, b| a.partial_cmp(b).unwrap());
        w[w.len() / 2]
    };

    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut sink = 0u64;
    for r in 0..rounds {
        if r % 2 == 0 {
            ta.push(decode_all(false, &mut sink)); // generic
            tb.push(decode_all(true, &mut sink)); // c1
        } else {
            tb.push(decode_all(true, &mut sink));
            ta.push(decode_all(false, &mut sink));
        }
    }
    std::hint::black_box(sink);

    let ma = med(&ta);
    let mb = med(&tb);
    println!(
        "LJPEG full-frame decode ({} tiles), interleaved {rounds} rounds, round0 dropped:",
        tiles.len()
    );
    println!("  A generic   : {ma:.2} ms");
    println!("  B dispatched: {mb:.2} ms  (cps=1->c1, cps=2->c2, else generic)");
    println!(
        "  saved: {:.2} ms  ({:.1}%)  parity: EXACT",
        ma - mb,
        (ma - mb) / ma * 100.0
    );
}
