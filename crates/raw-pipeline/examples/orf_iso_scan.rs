//! orf_iso_scan — one line of provenance per ORF: model, ISO, and which
//! exposure-baseline tier `pipeline::orf_baseline_ev` puts it in. Used to
//! validate the ISO < 200 extended-LOW gate across bodies in the local library
//! (HANDOFF-orf-baseline item 6).
//!
//! Run: cargo run --release --no-default-features --features parallel \
//!        --example orf_iso_scan -- <dir-or-file> [...]
use std::path::PathBuf;

fn main() {
    let mut files: Vec<PathBuf> = Vec::new();
    for arg in std::env::args().skip(1) {
        let p = PathBuf::from(&arg);
        if p.is_dir() {
            let mut stack = vec![p];
            while let Some(d) = stack.pop() {
                for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        stack.push(p);
                    } else if p
                        .extension()
                        .and_then(|s| s.to_str())
                        .is_some_and(|s| s.eq_ignore_ascii_case("orf"))
                    {
                        files.push(p);
                    }
                }
            }
        } else {
            files.push(p);
        }
    }
    files.sort();
    let mut tally: std::collections::BTreeMap<String, usize> = Default::default();
    for f in &files {
        let data = match std::fs::read(f) {
            Ok(d) => d,
            Err(e) => {
                println!("{}\tREAD-ERR {e}", f.display());
                continue;
            }
        };
        match raw_pipeline::tiff::parse(&data) {
            Ok(info) => {
                let ev = raw_pipeline::pipeline::orf_baseline_ev(info.iso);
                let tier = match info.iso {
                    Some(i) if i < 200 => "LOW",
                    Some(_) => "native",
                    None => "unknown",
                };
                println!(
                    "{}\tmodel={}\tiso={:?}\ttier={tier}\tbaseline_ev={ev:.2}",
                    f.display(),
                    info.model.trim(),
                    info.iso
                );
                *tally
                    .entry(format!("{} / {tier}", info.model.trim()))
                    .or_default() += 1;
            }
            Err(e) => println!("{}\tPARSE-ERR {e}", f.display()),
        }
    }
    println!("\n== tally ==");
    for (k, n) in &tally {
        println!("{n:5}  {k}");
    }
}
