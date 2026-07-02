//! ljpeg_c4_flip — thermal-cancelled A/B of the monomorphized cps=4 kernel on a REAL
//! CR2 LJPEG strip (550D-era multi-slice bodies encode cps=4 precision=14):
//!
//!   A = decode_tile_generic (dynamic component loop)   B = decode_tile (→ decode_c4::<14>)
//!
//! Interleaved start-rotated rounds; round 0 dropped; median + %saved. Outputs asserted
//! byte-identical every round.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example ljpeg_c4_flip -- <file.cr2>
use raw_pipeline::{cr2, ljpeg};
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        r"C:\Foo\raw-converter\tests\_MG_1744.CR2".into()
    });
    let data = std::fs::read(&path).expect("read CR2");
    let (off, len, w, h) = cr2::ljpeg_strip_geometry(&data).expect("strip geometry");
    let strip = &data[off..off + len];

    let mut a = vec![0u16; w * h];
    let mut b = vec![0u16; w * h];
    ljpeg::decode_tile_generic(strip, &mut a, 0, w, w, h).expect("generic");
    ljpeg::decode_tile(strip, &mut b, 0, w, w, h).expect("dispatched");
    let exact = a == b;

    let med = |v: &[f64]| {
        let mut sorted: Vec<f64> = v[1..].to_vec(); // drop round 0
        sorted.sort_by(|x, y| x.partial_cmp(y).unwrap());
        sorted[sorted.len() / 2]
    };
    let time = |generic: bool, out: &mut [u16], sink: &mut u64| {
        let t = Instant::now();
        if generic {
            ljpeg::decode_tile_generic(strip, out, 0, w, w, h).expect("decode");
        } else {
            ljpeg::decode_tile(strip, out, 0, w, w, h).expect("decode");
        }
        *sink = sink.wrapping_add(out[out.len() / 2] as u64);
        t.elapsed().as_secs_f64() * 1e3
    };

    let rounds = 13usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut sink = 0u64;
    for r in 0..rounds {
        if r % 2 == 0 {
            ta.push(time(true, &mut a, &mut sink));
            tb.push(time(false, &mut b, &mut sink));
        } else {
            tb.push(time(false, &mut b, &mut sink));
            ta.push(time(true, &mut a, &mut sink));
        }
    }
    std::hint::black_box(sink);

    let (ma, mb) = (med(&ta), med(&tb));
    println!("file: {}  strip {}x{} px", path.rsplit(['\\', '/']).next().unwrap_or(&path), w, h);
    println!("LJPEG strip decode, interleaved {rounds} rounds, round0 dropped:");
    println!("  A generic (dyn comp loop): {ma:.1} ms");
    println!("  B decode_c4 (dispatched):  {mb:.1} ms");
    println!("  saved: {:.1} ms  ({:.1}%)  parity: {}",
        ma - mb, (ma - mb) / ma * 100.0, if exact { "EXACT" } else { "DIFF!" });
    assert!(exact, "parity broken");
}
