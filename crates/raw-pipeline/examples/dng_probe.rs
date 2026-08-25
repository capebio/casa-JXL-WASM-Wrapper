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
                println!(
                    "{a}: OK {}x{} cfa={:?} black={} white={} samples={} mean={mean:.1} max={mx} make={} model={}",
                    img.width, img.height, img.cfa, img.black, img.white, n, img.make, img.model
                );
            }
            Err(e) => println!("{a}: DECODE FAIL {e:#}"),
        }
        match raw_pipeline::dng::ljpeg_tile_ranges(&bytes) {
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
