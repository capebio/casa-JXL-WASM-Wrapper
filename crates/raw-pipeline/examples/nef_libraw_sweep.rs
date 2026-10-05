//! Decode every NEF/NRW under a root and emit what a LibRaw comparison needs.
//!
//! One TSV line per file on stdout — name, status, dims, CFA phase, white
//! balance, white level, max sample — and, for the ones that decode, the sensor
//! plane as a 16-bit PGM in `<outdir>`. `tools/nef_libraw_compare.py` reads both
//! and scores them against `rawpy`'s `raw_image`.
//!
//! **No noise guard and no skipping.** `bayer_dump` refuses to publish a plane
//! that looks like noise, which is right for a codec benchmark and wrong here:
//! the whole question is which files are wrong, so a file that decodes to
//! rubbish must reach the oracle and be counted, not vanish behind a SKIP.
//!
//! Run: cargo run --release --example nef_libraw_sweep -- <root> <outdir>
use raw_pipeline::panasonic::decode_nef;

fn walk(root: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    if root.is_file() {
        out.push(root.to_path_buf());
        return;
    }
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}

fn write_pgm16(path: &std::path::Path, p: &[u16], w: usize, h: usize, maxval: u16) {
    // PGM stores 16-bit samples BIG-endian; getting this backwards produces a
    // file that opens fine and compares as noise.
    let mut v = format!("P5\n{w} {h}\n{maxval}\n").into_bytes();
    v.reserve(p.len() * 2);
    for &s in p {
        v.push((s >> 8) as u8);
        v.push(s as u8);
    }
    let _ = std::fs::write(path, v);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: nef_libraw_sweep <root> <outdir>");
        std::process::exit(2);
    }
    let outdir = std::path::PathBuf::from(&args[2]);
    std::fs::create_dir_all(&outdir).ok();
    let mut paths = Vec::new();
    walk(std::path::Path::new(&args[1]), &mut paths);
    paths.retain(|p| {
        let e = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
        e == "nef" || e == "nrw"
    });
    paths.sort();

    println!("name\tstatus\tw\th\tcfa_x\tcfa_y\twb_r\twb_b\twhite\tmax");
    for p in &paths {
        let stem = p.file_stem().unwrap().to_string_lossy().to_string();
        let d = match std::fs::read(p) {
            Ok(d) => d,
            Err(e) => {
                println!("{stem}\tread-error: {e}\t-\t-\t-\t-\t-\t-\t-\t-");
                continue;
            }
        };
        match decode_nef(&d) {
            Ok(b) => {
                let mx = b.raw.iter().copied().max().unwrap_or(0);
                write_pgm16(&outdir.join(format!("{stem}.pgm")), &b.raw, b.width, b.height, 65535);
                println!(
                    "{stem}\tok\t{}\t{}\t{}\t{}\t{:.4}\t{:.4}\t{}\t{mx}",
                    b.width, b.height, b.cfa_phase.0, b.cfa_phase.1, b.wb_r, b.wb_b, b.white
                );
            }
            Err(e) => {
                println!("{stem}\trefused: {}\t-\t-\t-\t-\t-\t-\t-\t-", e.replace('\t', " "));
            }
        }
    }
}
