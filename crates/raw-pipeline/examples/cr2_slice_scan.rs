//! cr2_slice_scan — classify CR2 files as single- vs multi-slice and print phase timings.
//! Multi-slice files (slices != [0,0,0]) exercise the reassembly stage that #1 optimizes.
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example cr2_slice_scan -- <file.cr2>...
use raw_pipeline::cr2;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: cr2_slice_scan <file.cr2>...");
        std::process::exit(2);
    }
    println!(
        "{:<28} {:>5}x{:<5} {:>14} {:>10} {:>10} {:>10}",
        "file", "w", "h", "slices[n,nw,lw]", "ljpeg_ms", "total_ms", "kind"
    );
    for path in &args {
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(e) => {
                println!("{:<28} read error: {e}", short(path));
                continue;
            }
        };
        match cr2::decode_bytes_bench(&data) {
            Ok((img, t)) => {
                let multi = t.slices != [0, 0, 0];
                println!(
                    "{:<28} {:>5}x{:<5} {:>14} {:>10.1} {:>10.1} {:>10}",
                    short(path),
                    img.width,
                    img.height,
                    format!("[{},{},{}]", t.slices[0], t.slices[1], t.slices[2]),
                    t.ljpeg_ms,
                    t.total_ms,
                    if multi { "MULTI" } else { "single" }
                );
            }
            Err(e) => println!("{:<28} decode error: {e}", short(path)),
        }
    }
}

fn short(p: &str) -> String {
    p.rsplit(['\\', '/']).next().unwrap_or(p).to_string()
}
