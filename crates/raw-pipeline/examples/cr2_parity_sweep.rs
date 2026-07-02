//! cr2_parity_sweep — byte-exactness gate over a set of real CR2 files.
//! For each file: Fused (shipped) vs SplitBulk vs SplitScatter vs warm-scratch
//! decode must produce identical raw pixels + metadata. Prints per-file status
//! and phase timings (reassemble_ms now visible). Exits non-zero on any mismatch.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example cr2_parity_sweep -- <file.cr2>...
use raw_pipeline::cr2::{self, ReassemblyVariant, ScratchBuffers};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: cr2_parity_sweep <file.cr2>...");
        std::process::exit(2);
    }
    let mut scratch = ScratchBuffers::default(); // ONE scratch across all files: warm-reuse gate
    let mut failed = false;
    println!("{:<28} {:>5}x{:<5} {:>14} {:>9} {:>11} {:>8} {:>7}",
        "file", "w", "h", "slices", "ljpeg_ms", "reasm_ms", "crop_ms", "parity");
    for path in &args {
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(e) => { println!("{:<28} read error: {e}", short(path)); failed = true; continue; }
        };
        let (f, t) = match cr2::decode_bytes_bench(&data) {
            Ok(v) => v,
            Err(e) => { println!("{:<28} decode error: {e}", short(path)); failed = true; continue; }
        };
        let b = cr2::decode_bytes_reassembly(&data, ReassemblyVariant::SplitBulk).expect("bulk");
        let s = cr2::decode_bytes_reassembly(&data, ReassemblyVariant::SplitScatter).expect("scatter");
        let w = cr2::decode_with_scratch(&data, &mut scratch).expect("scratch");
        let ok = f.raw == b.raw && f.raw == s.raw && f.raw == w.raw
            && (f.width, f.height, f.black, f.white, f.cfa_phase)
                == (b.width, b.height, b.black, b.white, b.cfa_phase)
            && f.wb_r.to_bits() == b.wb_r.to_bits()
            && f.wb_b.to_bits() == b.wb_b.to_bits();
        if !ok { failed = true; }
        println!("{:<28} {:>5}x{:<5} {:>14} {:>9.1} {:>11.1} {:>8.1} {:>7}",
            short(path), f.width, f.height,
            format!("[{},{},{}]", t.slices[0], t.slices[1], t.slices[2]),
            t.ljpeg_ms, t.reassemble_ms, t.crop_ms,
            if ok { "EXACT" } else { "DIFF!" });
    }
    if failed { std::process::exit(1); }
    println!("all files byte-identical across Fused / SplitBulk / SplitScatter / warm scratch");
}

fn short(p: &str) -> String {
    p.rsplit(['\\', '/']).next().unwrap_or(p).to_string()
}
