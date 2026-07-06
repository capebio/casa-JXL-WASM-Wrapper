//! Quantifies the copy-back CRAWL E1 eliminates in CR2 multi-slice reassembly:
//! the old `raw_buf.clear(); raw_buf.extend_from_slice(&raster)` copied the whole
//! reassembled frame back into raw_buf. E1 replaces it with `*raw_buf = raster`
//! (O(1) move). This times the eliminated full-frame copy.
//!
//! Run: cargo run --release --no-default-features --example cr2_finalize_membench

use std::time::Instant;

fn main() {
    // Multi-slice CR2 raster, ~24 MP u16 (= 48 MB). 5DS-class files are larger still.
    let n = 6000usize * 4000;
    let raster = vec![1u16; n];
    let mut dst: Vec<u16> = Vec::with_capacity(n);

    let reps = 31;
    let mut copy_ms = Vec::new();
    // warm
    dst.clear();
    dst.extend_from_slice(&raster);
    for _ in 0..reps {
        let t = Instant::now();
        dst.clear();
        dst.extend_from_slice(&raster); // <- the work E1 removes
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        std::hint::black_box(&dst);
        copy_ms.push(ms);
    }
    copy_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = copy_ms[copy_ms.len() / 2];
    println!(
        "CR2 reassembly copy-back @ {:.1} MP ({} MB):",
        n as f64 / 1e6,
        n * 2 / 1024 / 1024
    );
    println!("  eliminated copy median_ms : {:.3}", median);
    println!("  (E1 replaces this with *raw_buf = raster, a pointer move ~= 0 ms,");
    println!(
        "   and also drops one ~{}MB transient that briefly coexisted with raster)",
        n * 2 / 1024 / 1024
    );
}
