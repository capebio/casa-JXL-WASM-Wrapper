//! FableBraid vs fjxl (lossless JXL effort 1/3) A/B on real frames.
//!
//! Usage: fable_ab <rgb-file> <w> <h> <frame-index> [reps]
//!   rgb-file: raw rgb24 frames back to back (video-testbed frames/<clip>.rgb)
//!
//! Timing is interleaved per rep (FB, e1, e3, FB, e1, e3, …) so thermal drift
//! cancels (flipflop lesson: sequential per-arm timing is drift-biased).
//! Requires --features jxl-codec (MSVC build) for the JXL arms; without it,
//! FableBraid alone is timed.

use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        eprintln!("usage: fable_ab <rgb-file> <w> <h> <frame-index> [reps]");
        std::process::exit(1);
    }
    let (path, w, h, idx) = (&args[1], args[2].parse::<u32>().unwrap(),
                             args[3].parse::<u32>().unwrap(), args[4].parse::<usize>().unwrap());
    let reps = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(30usize);
    let flen = (w * h * 3) as usize;
    let raw = std::fs::read(path).expect("read rgb");
    let src = raw[idx * flen..(idx + 1) * flen].to_vec();

    // ── encode all arms once ──
    let t = Instant::now();
    let fb = raw_pipeline::fable_braid::encode_rgb8(&src, w, h);
    let fb_enc_ms = t.elapsed().as_secs_f64() * 1e3;
    {
        let (px, dw, dh) = raw_pipeline::fable_braid::decode_rgb8(&fb).expect("fb decode");
        assert_eq!((dw, dh), (w, h));
        assert_eq!(px, src, "FableBraid roundtrip must be byte-exact");
    }

    #[cfg(feature = "jxl-codec")]
    let jxl_arms: Vec<(&str, Vec<u8>)> = {
        use raw_pipeline::jxl_casaencoder::{encode_rgb8, EncodeOptions};
        vec![
            ("jxl-e1", encode_rgb8(&src, w, h, EncodeOptions::lossless().with_effort(1)).unwrap()),
            ("jxl-e3", encode_rgb8(&src, w, h, EncodeOptions::lossless().with_effort(3)).unwrap()),
        ]
    };
    #[cfg(not(feature = "jxl-codec"))]
    let jxl_arms: Vec<(&str, Vec<u8>)> = Vec::new();

    let bpp = |n: usize| n as f64 * 8.0 / (w as f64 * h as f64);
    println!("frame {idx} {w}x{h}: FableBraid {} B ({:.3} bpp, enc {fb_enc_ms:.1} ms)",
             fb.len(), bpp(fb.len()));
    for (name, bytes) in &jxl_arms {
        println!("  {name}: {} B ({:.3} bpp)  FB bytes = {:+.1}%",
                 bytes.len(), bpp(bytes.len()),
                 100.0 * (fb.len() as f64 - bytes.len() as f64) / bytes.len() as f64);
    }

    // ── interleaved decode timing ──
    let mut fb_t = Vec::with_capacity(reps);
    let mut jxl_t: Vec<Vec<f64>> = jxl_arms.iter().map(|_| Vec::with_capacity(reps)).collect();
    for _ in 0..reps {
        let t = Instant::now();
        let out = raw_pipeline::fable_braid::decode_rgb8(&fb).unwrap();
        fb_t.push(t.elapsed().as_secs_f64() * 1e3);
        std::hint::black_box(&out);

        #[cfg(feature = "jxl-codec")]
        for (k, (_, bytes)) in jxl_arms.iter().enumerate() {
            let t = Instant::now();
            let out = raw_pipeline::jxl_casadecoder::decode_interleaved::<u8>(bytes, 3).unwrap();
            jxl_t[k].push(t.elapsed().as_secs_f64() * 1e3);
            std::hint::black_box(&out);
        }
    }
    let stat = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        (v[0], v[v.len() / 2])
    };
    let (fmin, fmed) = stat(&mut fb_t);
    println!("decode x{reps} (interleaved): FableBraid min {fmin:.2} med {fmed:.2} ms");
    for (k, (name, _)) in jxl_arms.iter().enumerate() {
        let (mn, md) = stat(&mut jxl_t[k]);
        println!("  {name}: min {mn:.2} med {md:.2} ms   → FB speedup {:.2}x (med)", md / fmed);
    }
}
