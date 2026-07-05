//! ljpeg_hotpath_flip — cross-build OLD(z7k) vs NEW(hot-path) verifier + timer.
//!
//! The hot-path pass (remove real_in_buf/truncated + mask-at-fill, prevalidate
//! max_symbol≤precision, branchless extend, drop the row==0 predictor branch) is
//! byte-exact by construction but lives entirely in this build's `ljpeg`, so an
//! in-binary A/B isn't possible. Instead this prints a stable pixel fingerprint
//! plus interleaved decode timing; run the SAME example at the z7k base and at
//! the hot-path branch and compare:
//!   * FINGERPRINT must be identical  → byte-exact (the correctness gate)
//!   * decode median/min NEW ≤ OLD    → the speed gate (decode is latency-bound
//!                                       on the predictor+bit-buffer recurrence,
//!                                       so expect a small win, not a large one)
//!
//! It also re-asserts generic==dispatched parity within this build (the same
//! invariant ljpeg_c1_flip checks) so a single run is self-validating.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features \
//!        --example ljpeg_hotpath_flip -- <file.dng>
use raw_pipeline::{dng, ljpeg};
use std::time::Instant;

/// FNV-1a over the little-endian bytes of every decoded sample — order-sensitive
/// and collision-resistant enough to prove two builds produced identical pixels.
fn fnv1a_u16(seed: u64, pixels: &[u16]) -> u64 {
    let mut h = seed;
    for &p in pixels {
        for b in p.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    h
}

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        r"C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng"
            .into()
    });
    let data = std::fs::read(&path).expect("read DNG");
    let ranges = dng::ljpeg_tile_ranges(&data).expect("ljpeg tile ranges");
    assert!(!ranges.is_empty(), "no LJPEG tiles");

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

    let tiles: Vec<(&[u8], usize, usize)> = ranges
        .iter()
        .map(|&(o, e)| {
            let src = &data[o..e];
            let i = ljpeg::probe_tile(src).expect("probe tile");
            (src, i.width as usize, i.height as usize)
        })
        .collect();

    // Correctness gate 1: generic == dispatched within this build (every tile).
    // Correctness gate 2: whole-frame FNV fingerprint (compare across builds).
    let mut fp = 0xcbf29ce484222325u64;
    for (idx, &(src, w, h)) in tiles.iter().enumerate() {
        let mut g = vec![0u16; w * h];
        let mut d = vec![0u16; w * h];
        ljpeg::decode_tile_generic(src, &mut g, 0, w, w, h).expect("generic");
        ljpeg::decode_tile(src, &mut d, 0, w, w, h).expect("dispatched");
        assert_eq!(g, d, "generic vs dispatched parity mismatch on tile {idx}");
        fp = fnv1a_u16(fp, &d);
    }
    println!("FINGERPRINT(all tiles, dispatched): {fp:#018x}   parity(generic==dispatched): EXACT");

    // Timing: one full-frame pass = decode every tile once (dispatched/production).
    let decode_all = |sink: &mut u64| -> f64 {
        let t = Instant::now();
        for &(src, w, h) in &tiles {
            let mut buf = vec![0u16; w * h];
            ljpeg::decode_tile(src, &mut buf, 0, w, w, h).expect("decode");
            *sink = sink.wrapping_add(buf[buf.len() / 2] as u64);
        }
        t.elapsed().as_secs_f64() * 1e3
    };

    let rounds = 11usize;
    let mut ts = Vec::new();
    let mut sink = 0u64;
    for _ in 0..rounds {
        ts.push(decode_all(&mut sink));
    }
    std::hint::black_box(sink);

    let mut sorted: Vec<f64> = ts[1..].to_vec(); // drop warm-up round 0
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = sorted[sorted.len() / 2];
    let min = sorted[0];
    println!(
        "decode full-frame ({} tiles), {} rounds (round0 dropped):  median {:.2} ms   min {:.2} ms",
        tiles.len(),
        rounds,
        median,
        min
    );
}
