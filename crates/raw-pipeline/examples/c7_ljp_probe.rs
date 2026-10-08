//! LJPEG decode probe for the B-c7 LJP lane: `c7_ljp_probe <reps> <file>...`.
//! `.cr2` goes through `cr2::decode_bytes`, anything else through
//! `dng::decode_bytes_with` on a serial tile executor; both reach `ljpeg`. Prints one line per file with
//! `fnv=<hex>` of the first rep's plane (broker `ab` checks it).
fn main() {
    let mut a = std::env::args().skip(1);
    let reps: usize = a.next().and_then(|r| r.parse().ok()).expect("usage: c7_ljp_probe <reps> <file>...");
    for f in a {
        let d = std::fs::read(&f).unwrap();
        let cr2 = f.to_ascii_lowercase().ends_with(".cr2");
        let mut h: u64 = 0xcbf29ce484222325;
        for rep in 0..reps {
            let (w, ht, raw) = if cr2 {
                let i = raw_pipeline::cr2::decode_bytes(&d).unwrap_or_else(|e| panic!("{f}: {e}"));
                (i.width, i.height, i.raw)
            } else {
                // Serial tile executor: one thread, so a pinned `pmc` counts it all.
                let serial = |n: usize, t: &(dyn Fn(usize) + Sync)| (0..n).for_each(t);
                let i = raw_pipeline::dng::decode_bytes_with(&d, None, Some(&serial))
                    .unwrap_or_else(|e| panic!("{f}: {e}"));
                (i.width, i.height, i.raw)
            };
            if rep == 0 {
                for v in &raw {
                    h = (h ^ *v as u64).wrapping_mul(0x100000001b3);
                }
                println!("{f} {w}x{ht} fnv={h:016x}");
            }
        }
    }
}
