//! cr2_fulldecode_flip — thermal-cancelled end-to-end A/B of a REAL multi-slice CR2 decode,
//! isolating #1 (slice reassembly). Both arms run the full cr2::decode_bytes path; only the
//! reassembly variant differs:
//!
//!   A = scatter (pre-#1 scalar per-pixel divisions)   B = bulk (shipped per-row copy)
//!
//! Interleaved start-rotated rounds; round 0 dropped; median + %saved. Output raw buffers
//! asserted byte-identical. Use a multi-slice body (e.g. _MG_*.CR2, CR2Slices=[2,1728,1888]).
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example cr2_fulldecode_flip -- <file.cr2>
use raw_pipeline::cr2;
use std::time::Instant;

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests\_MG_1750.CR2".into());
    let data = std::fs::read(&path).expect("read CR2");

    // parity (warm pair)
    let a0 = cr2::decode_bytes_variant(&data, true).expect("scatter decode");
    let b0 = cr2::decode_bytes_variant(&data, false).expect("bulk decode");
    let exact = a0.raw == b0.raw;

    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec(); // drop round 0
        w.sort_by(|a, b| a.partial_cmp(b).unwrap());
        w[w.len() / 2]
    };
    let time = |use_scatter: bool, sink: &mut u64| {
        let t = Instant::now();
        let img = cr2::decode_bytes_variant(&data, use_scatter).expect("decode");
        *sink = sink.wrapping_add(img.raw[img.raw.len() / 2] as u64);
        t.elapsed().as_secs_f64() * 1e3
    };

    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut sink = 0u64;
    for r in 0..rounds {
        if r % 2 == 0 {
            ta.push(time(true, &mut sink));
            tb.push(time(false, &mut sink));
        } else {
            tb.push(time(false, &mut sink));
            ta.push(time(true, &mut sink));
        }
    }
    std::hint::black_box(sink);

    let ma = med(&ta);
    let mb = med(&tb);
    println!("file: {}", path.rsplit(['\\', '/']).next().unwrap_or(&path));
    println!("full decode_bytes (multi-slice), interleaved {rounds} rounds, round0 dropped:");
    println!("  A scatter (pre-#1): {ma:.1} ms");
    println!("  B bulk    (#1):     {mb:.1} ms");
    println!(
        "  saved: {:.1} ms  ({:.1}%)  parity: {}",
        ma - mb,
        (ma - mb) / ma * 100.0,
        if exact { "EXACT" } else { "DIFF!" }
    );
    assert!(exact, "parity broken");
}
