//! cr2_fused_flip — thermal-cancelled end-to-end A/B of the fused reassemble+crop path.
//! Both arms run the full cr2 decode; only the output-construction pipeline differs:
//!
//!   A = SplitBulk (legacy: full-raster reassemble → in-place crop → truncate)
//!   B = Fused     (shipped: crop-window segments copied straight into the output)
//!
//! Also flips the scratch-mode path (decode_with_scratch, warm buffer) fused-vs-legacy
//! by proxy: scratch arm B reuses one ScratchBuffers so the no-truncate warm path is hit.
//! Interleaved start-rotated rounds; round 0 dropped; median + %saved. Raw buffers
//! asserted byte-identical. Single-slice files exercise only the crop/scratch arms.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example cr2_fused_flip -- <file.cr2>
use raw_pipeline::cr2::{self, ReassemblyVariant, ScratchBuffers};
use std::time::Instant;

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests\_MG_1750.CR2".into());
    let data = std::fs::read(&path).expect("read CR2");

    // parity (warm pair)
    let a0 =
        cr2::decode_bytes_reassembly(&data, ReassemblyVariant::SplitBulk).expect("split decode");
    let b0 = cr2::decode_bytes_reassembly(&data, ReassemblyVariant::Fused).expect("fused decode");
    let exact = a0.raw == b0.raw;
    let mut sc = ScratchBuffers::default();
    let s0 = cr2::decode_with_scratch(&data, &mut sc).expect("scratch decode");
    let scratch_exact = s0.raw == b0.raw;

    let med = |v: &[f64]| {
        let mut w: Vec<f64> = v[1..].to_vec(); // drop round 0
        w.sort_by(|a, b| a.partial_cmp(b).unwrap());
        w[w.len() / 2]
    };
    let time_variant = |v: ReassemblyVariant, sink: &mut u64| {
        let t = Instant::now();
        let img = cr2::decode_bytes_reassembly(&data, v).expect("decode");
        *sink = sink.wrapping_add(img.raw[img.raw.len() / 2] as u64);
        t.elapsed().as_secs_f64() * 1e3
    };
    let time_scratch = |sc: &mut ScratchBuffers, sink: &mut u64| {
        let t = Instant::now();
        let img = cr2::decode_with_scratch(&data, sc).expect("decode");
        *sink = sink.wrapping_add(img.raw[img.raw.len() / 2] as u64);
        t.elapsed().as_secs_f64() * 1e3
    };

    let rounds = 13usize;
    let (mut ta, mut tb, mut ts) = (Vec::new(), Vec::new(), Vec::new());
    let mut sink = 0u64;
    for r in 0..rounds {
        // 3-arm rotation cancels thermal drift.
        match r % 3 {
            0 => {
                ta.push(time_variant(ReassemblyVariant::SplitBulk, &mut sink));
                tb.push(time_variant(ReassemblyVariant::Fused, &mut sink));
                ts.push(time_scratch(&mut sc, &mut sink));
            }
            1 => {
                tb.push(time_variant(ReassemblyVariant::Fused, &mut sink));
                ts.push(time_scratch(&mut sc, &mut sink));
                ta.push(time_variant(ReassemblyVariant::SplitBulk, &mut sink));
            }
            _ => {
                ts.push(time_scratch(&mut sc, &mut sink));
                ta.push(time_variant(ReassemblyVariant::SplitBulk, &mut sink));
                tb.push(time_variant(ReassemblyVariant::Fused, &mut sink));
            }
        }
    }
    std::hint::black_box(sink);

    let (ma, mb, ms) = (med(&ta), med(&tb), med(&ts));
    println!("file: {}", path.rsplit(['\\', '/']).next().unwrap_or(&path));
    println!("full decode, interleaved {rounds} rounds (3-arm rotation), round0 dropped:");
    println!("  A split-bulk (legacy): {ma:.1} ms");
    println!(
        "  B fused      (shipped): {mb:.1} ms   saved {:.1} ms ({:.1}%)",
        ma - mb,
        (ma - mb) / ma * 100.0
    );
    println!(
        "  S fused scratch (warm): {ms:.1} ms   vs split {:.1} ms ({:.1}%)",
        ma - ms,
        (ma - ms) / ma * 100.0
    );
    println!(
        "  parity: owned {}  scratch {}",
        if exact { "EXACT" } else { "DIFF!" },
        if scratch_exact { "EXACT" } else { "DIFF!" }
    );
    assert!(exact && scratch_exact, "parity broken");
}
