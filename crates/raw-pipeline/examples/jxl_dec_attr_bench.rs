//! Attribution bench: isolate Opt-10 (LLF bypass) vs Opts 1-9 (transform micros).
//!
//! Fixed at 1920×1080 single-thread, effort=3 and effort=5 only.
//! Run each of the 4 binaries (labelled via ATTR_LABEL env var or argv[1]).
//!
//! Workflow (PowerShell):
//!   # Step 1 – get original and new file contents from submodule git:
//!   $orig_t  = git -C external/libjxl-012 show HEAD~1:lib/jxl/dec_transforms-inl.h
//!   $orig_g  = git -C external/libjxl-012 show HEAD~1:lib/jxl/dec_group.cc
//!   $new_t   = git -C external/libjxl-012 show HEAD:lib/jxl/dec_transforms-inl.h
//!   $new_g   = git -C external/libjxl-012 show HEAD:lib/jxl/dec_group.cc
//!
//!   # Step 2 – build 4 binaries:
//!   #  A) baseline (both original)
//!   $orig_t | Set-Content external/libjxl-012/lib/jxl/dec_transforms-inl.h
//!   $orig_g | Set-Content external/libjxl-012/lib/jxl/dec_group.cc
//!   .\build-msvc.ps1 build --release --example jxl_dec_attr_bench -p raw-pipeline
//!   Copy-Item C:\Tmp\raw-converter-wasm-msvc-target\release\examples\jxl_dec_attr_bench.exe attr_baseline.exe
//!
//!   #  B) Opt-10 only (orig transforms + new dec_group)
//!   $orig_t | Set-Content external/libjxl-012/lib/jxl/dec_transforms-inl.h
//!   $new_g  | Set-Content external/libjxl-012/lib/jxl/dec_group.cc
//!   .\build-msvc.ps1 build --release --example jxl_dec_attr_bench -p raw-pipeline
//!   Copy-Item C:\Tmp\raw-converter-wasm-msvc-target\release\examples\jxl_dec_attr_bench.exe attr_opt10.exe
//!
//!   #  C) Opts 1-9 only (new transforms + orig dec_group)
//!   $new_t  | Set-Content external/libjxl-012/lib/jxl/dec_transforms-inl.h
//!   $orig_g | Set-Content external/libjxl-012/lib/jxl/dec_group.cc
//!   .\build-msvc.ps1 build --release --example jxl_dec_attr_bench -p raw-pipeline
//!   Copy-Item C:\Tmp\raw-converter-wasm-msvc-target\release\examples\jxl_dec_attr_bench.exe attr_opt19.exe
//!
//!   #  D) Combined (both new) — restore submodule to HEAD state
//!   $new_t  | Set-Content external/libjxl-012/lib/jxl/dec_transforms-inl.h
//!   $new_g  | Set-Content external/libjxl-012/lib/jxl/dec_group.cc
//!   .\build-msvc.ps1 build --release --example jxl_dec_attr_bench -p raw-pipeline
//!   Copy-Item C:\Tmp\raw-converter-wasm-msvc-target\release\examples\jxl_dec_attr_bench.exe attr_combined.exe
//!
//!   # Step 3 – interleaved attribution run:
//!   for ($i=0; $i -lt 5; $i++) {
//!       .\attr_baseline.exe baseline
//!       .\attr_opt10.exe   "opt-10"
//!       .\attr_opt19.exe   "opts-1-9"
//!       .\attr_combined.exe combined
//!   }
//!
//! Expected outcome:
//!   opt-10    ≈ most of the gain (removes 3 calls + switch + stack every block)
//!   opts-1-9  ≈ smaller remainder (arithmetic + gather + stack micro-savings)
//!   combined  ≈ sum (if independent; may be sub-additive on DCT-heavy corpus)

#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
mod bench {
    use raw_pipeline::jxl_casadecoder::{Channels, DecodeOptions, Decoder};
    use raw_pipeline::jxl_casaencoder::{EncodeOptions, Encoder, Frame};

    fn mkpix(w: u32, h: u32, seed: u64) -> Vec<u8> {
        let n = (w as usize) * (h as usize) * 3;
        let mut v = Vec::with_capacity(n);
        let mut s = seed;
        for _ in 0..n {
            s = s
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            v.push(((s >> 33) & 0xff) as u8);
        }
        v
    }

    fn encode_jxl(pixels: &[u8], w: u32, h: u32, opts: &EncodeOptions) -> Vec<u8> {
        let frame = Frame::rgb(pixels, w, h);
        let mut enc = Encoder::new(opts.clone()).expect("JxlEncoderCreate");
        let mut out = Vec::new();
        enc.encode_into(&frame, &mut out).expect("encode");
        out
    }

    fn median(v: &mut Vec<f64>) -> f64 {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    }

    fn time_decode(label: &str, tag: &str, effort: u32, jxl: &[u8]) {
        const WARMUP: usize = 5;
        const ITERS: usize = 60;

        let mut dec = Decoder::new(DecodeOptions {
            parallel: false,
            ..Default::default()
        })
        .expect("JxlDecoderCreate");

        for _ in 0..WARMUP {
            let _ = dec.decode::<u8>(jxl, Channels::Rgb).expect("warmup");
        }

        let mut times = Vec::with_capacity(ITERS);
        for _ in 0..ITERS {
            let t = std::time::Instant::now();
            let img = dec.decode::<u8>(jxl, Channels::Rgb).expect("decode");
            times.push(t.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(img.data.len());
        }

        let med = median(&mut times);
        let min = times.iter().cloned().fold(f64::INFINITY, f64::min);
        // label | tag | effort | med | min
        println!("{label}  [{tag}]  e{effort}  med={med:.3}ms  min={min:.3}ms");
    }

    pub fn run(tag: &str) {
        const W: u32 = 1920;
        const H: u32 = 1080;
        let pix = mkpix(W, H, 0xdeadbeef);

        // effort=3: DCT-heavy. Opt-10 fires on every single-block strategy.
        let e3 = EncodeOptions::distance(1.0).with_effort(3);
        let jxl3 = encode_jxl(&pix, W, H, &e3);

        // effort=5: broader strategy mix. Opts 4-9 also activated here.
        let e5 = EncodeOptions::distance(1.0).with_effort(5);
        let jxl5 = encode_jxl(&pix, W, H, &e5);

        time_decode("1920x1080", tag, 3, &jxl3);
        time_decode("1920x1080", tag, 5, &jxl5);
    }
}

fn main() {
    let tag = std::env::args().nth(1).unwrap_or_else(|| "?".to_string());

    #[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
    bench::run(&tag);

    #[cfg(not(all(feature = "jxl-codec", not(target_arch = "wasm32"))))]
    eprintln!("requires default features + native target");
}
