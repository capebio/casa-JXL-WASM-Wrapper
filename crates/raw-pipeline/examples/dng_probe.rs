//! Probe: run the DNG decoder on files and report outcome + basic stats.
//! Usage: dng_probe <file.dng>...
fn main() {
    for a in std::env::args().skip(1) {
        let bytes = match std::fs::read(&a) {
            Ok(b) => b,
            Err(e) => {
                println!("{a}: READ FAIL {e}");
                continue;
            }
        };
        match raw_pipeline::dng::decode_bytes(&bytes) {
            Ok(img) => {
                let n = img.raw.len();
                let mean = img.raw.iter().map(|&v| v as u64).sum::<u64>() as f64 / n as f64;
                let mx = img.raw.iter().copied().max().unwrap_or(0);
                // FNV-1a 64 over the samples as u16 LE (interleaved), the zoo's plane hash.
                let fnv = img.raw.iter().flat_map(|v| v.to_le_bytes()).fold(0xcbf29ce484222325u64, |h, b| {
                    (h ^ b as u64).wrapping_mul(0x100000001b3)
                });
                println!(
                    "{a}: OK {}x{} cps={} cfa={:?} black={} white={} samples={} mean={mean:.1} max={mx} fnv={fnv:016x} make={} model={}",
                    img.width, img.height, img.samples_per_pixel, img.cfa, img.black, img.white, n, img.make, img.model
                );
            }
            Err(e) => println!("{a}: DECODE FAIL {e:#}"),
        }
        match raw_pipeline::dng::payload_ranges(&bytes) {
            Ok(r) => {
                let lo = r.iter().map(|x| x.0).min().unwrap_or(0);
                let hi = r.iter().map(|x| x.1).max().unwrap_or(0);
                let sum: usize = r.iter().map(|x| x.1 - x.0).sum();
                println!("  ranges: {} tiles [{lo}..{hi}] sum={sum}", r.len());
            }
            Err(e) => println!("  ranges: FAIL {e:#}"),
        }
    }
}
