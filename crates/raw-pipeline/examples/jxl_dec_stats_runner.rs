// Decode a real JXL file N times so JXL_DEC_TRANSFORM_STATS captures real data.
// Build WITH the flag:
//   $env:JXL_DEC_TRANSFORM_STATS=1
//   .\build-msvc.ps1 build --release --example jxl_dec_stats_runner -p raw-pipeline
// Run:
//   .\target\release\examples\jxl_dec_stats_runner.exe path\to\file.jxl [iters]

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
fn run() {
    use raw_pipeline::jxl_casadecoder::{Channels, DecodeOptions, Decoder};

    let path = std::env::args()
        .nth(1)
        .expect("usage: runner <file.jxl> [iters]");
    let iters: usize = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(20);

    let jxl = std::fs::read(&path).expect("read jxl");
    println!("Loaded {} ({} bytes)", path, jxl.len());

    let mut dec = Decoder::new(DecodeOptions {
        parallel: false,
        ..Default::default()
    })
    .expect("JxlDecoderCreate");

    // warmup
    for _ in 0..3 {
        let _ = dec.decode::<u8>(&jxl, Channels::Rgb).expect("warmup");
    }

    let mut times = Vec::with_capacity(iters);
    for i in 0..iters {
        let t = std::time::Instant::now();
        let img = dec.decode::<u8>(&jxl, Channels::Rgb).expect("decode");
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        times.push(ms);
        std::hint::black_box(img.data.len());
        eprint!("\r  iter {}/{} {:.1}ms   ", i + 1, iters, ms);
    }
    eprintln!();

    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let med = times[times.len() / 2];
    let min = times[0];

    // Pixel checksum for parity testing
    let ref_img = dec.decode::<u8>(&jxl, Channels::Rgb).expect("ref decode");
    let psum: u64 = ref_img.data.iter().map(|&x| x as u64).sum();
    println!("psum={psum}  pixels={}", ref_img.data.len());
    println!("Done: med={med:.1}ms min={min:.1}ms  (stats dump follows on stderr)");
    // DecTransformStats destructor fires here → dumps to stderr
}

fn main() {
    #[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
    run();
    #[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
    eprintln!("requires jxl-codec feature + native target");
}
