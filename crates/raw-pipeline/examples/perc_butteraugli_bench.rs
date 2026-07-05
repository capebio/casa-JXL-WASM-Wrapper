//! CRAWL C-3: end-to-end butteraugli timing — exercises downsample_dispatch (the 3-way
//! X/Y/B plane downsample). A/B = serial (base) vs rayon::join (C-3), both built
//! --features parallel. Cross-build comparison; run back-to-back.
//!
//! Run: cargo run --release --no-default-features --features parallel --example perc_butteraugli_bench

use raw_pipeline::perceptual::{Comparer, Opts};
use std::time::Instant;

fn main() {
    for &size in &[2048usize, 4096] {
        let n = size * size;
        let refr = vec![100u8; n * 4];
        let mut test = vec![100u8; n * 4];
        for i in (0..test.len()).step_by(7) {
            test[i] = 130;
        }
        let mut cmp = Comparer::new(refr, size, size, Opts::default()); // C-7: move (refr unused after)
        let _ = cmp.butteraugli(&test); // warm (build masks, LUTs)
        let reps = 15;
        let mut ms = Vec::new();
        for _ in 0..reps {
            let t = Instant::now();
            let b = cmp.butteraugli(&test);
            ms.push(t.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(b);
        }
        ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "{0}x{0} ({1:.1} MP): butteraugli median {2:.2} ms",
            size,
            n as f64 / 1e6,
            ms[ms.len() / 2]
        );
    }
}
