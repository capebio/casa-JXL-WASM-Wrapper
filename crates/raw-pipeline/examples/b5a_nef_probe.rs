//! Classic-NEF decode probe for the B-5a speed lane: `b5a_nef_probe <reps> <file>...`.
//! Decodes every file `reps` times through `panasonic::decode_nef` and prints one
//! line per file with `fnv=<hex>` of the first rep's plane (broker `ab` checks it).
fn main() {
    let mut a = std::env::args().skip(1);
    let reps: usize = a.next().and_then(|r| r.parse().ok()).expect("usage: b5a_nef_probe <reps> <file>...");
    for f in a {
        let d = std::fs::read(&f).unwrap();
        let mut h: u64 = 0xcbf29ce484222325;
        for rep in 0..reps {
            let img = raw_pipeline::panasonic::decode_nef(&d).unwrap_or_else(|e| panic!("{f}: {e}"));
            if rep == 0 {
                for v in &img.raw {
                    h = (h ^ *v as u64).wrapping_mul(0x100000001b3);
                }
                println!("{f} {}x{} fnv={h:016x}", img.width, img.height);
            }
        }
    }
}
