//! chunked_vs_whole_ab — AE-6 gate: is the chunked (streaming) encoder byte-identical
//! to the whole-frame `Encoder::encode` (AddImageFrame) path for the PRODUCTION lossy
//! tier configs? Lossless is already test-locked equal (stream_export.rs); the lossy
//! equality is exactly what routing full-res tiers through `encode_chunked` requires.
//!
//! Production quality→distance map (JxlEncoderDistanceFromQuality, q≥30):
//!   q95 → 0.55, q90 → 1.00, q85 → 1.45; pyramid tiers use 0.55/1.45 directly.
//!
//!   cargo run --release --example chunked_vs_whole_ab

use raw_pipeline::jxl_casaencoder::{
    encode_chunked_rgb8, encode_chunked_threaded, EncodeOptions, Encoder, Frame, Rate,
    WholeImageSource,
};

fn rand_rgb(w: usize, h: usize, seed: u32) -> Vec<u8> {
    let mut v = vec![0u8; w * h * 3];
    let mut s: u32 = seed | 1;
    for px in v.chunks_exact_mut(3) {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        px[0] = (s >> 24) as u8;
        px[1] = (s >> 16) as u8;
        px[2] = (s >> 8) as u8;
    }
    v
}

fn first_diff(a: &[u8], b: &[u8]) -> Option<usize> {
    if a.len() != b.len() {
        return Some(a.len().min(b.len()));
    }
    a.iter().zip(b).position(|(x, y)| x != y)
}

fn main() {
    // (name, w, h): odd dims, >2048 rows (super-tile crossing), 1×N degenerate.
    let mut images: Vec<(String, usize, usize, Vec<u8>)> = vec![
        ("rand640x480".into(), 640, 480, rand_rgb(640, 480, 0xA1)),
        ("rand1023x300".into(), 1023, 300, rand_rgb(1023, 300, 0xB2)),
        (
            "rand1200x2600".into(),
            1200,
            2600,
            rand_rgb(1200, 2600, 0xC3),
        ),
        ("rand1x3000".into(), 1, 3000, rand_rgb(1, 3000, 0xD4)),
    ];
    // Real DNG-derived rgb8 (tone-mapped) when present — the actual app payload.
    let dng_path = r"C:\Foo\raw-converter\tests\PXL_20260527_180319603.RAW-02.ORIGINAL.dng";
    if let Ok(data) = std::fs::read(dng_path) {
        let img = raw_pipeline::dng::decode_bytes(&data).expect("dng decode");
        let phase = match img.cfa {
            raw_pipeline::dng::Cfa::Rggb => (0, 0),
            raw_pipeline::dng::Cfa::Grbg => (0, 1),
            raw_pipeline::dng::Cfa::Gbrg => (1, 0),
            raw_pipeline::dng::Cfa::Bggr => (1, 1),
        };
        let rgb16 =
            raw_pipeline::demosaic::demosaic_bayer_mhc(&img.raw, img.width, img.height, phase)
                .expect("demosaic");
        let mut p = raw_pipeline::pipeline::PipelineParams::default_olympus();
        p.black = img.black;
        p.white = img.white;
        p.wb_r = img.wb_r;
        p.wb_b = img.wb_b;
        p.color_matrix = img.color_matrix;
        let rgb = raw_pipeline::pipeline::process_rgb(&rgb16, &p);
        images.push(("realdng".into(), img.width, img.height, rgb));
    } else {
        println!("realdng: SKIPPED (fixture absent)");
    }

    // Production tier configs: distances {0.55, 1.00, 1.45} at effort 3, plus lossless e3.
    let configs: &[(&str, Option<f32>)] = &[
        ("d0.55_e3", Some(0.55)),
        ("d1.00_e3", Some(1.00)),
        ("d1.45_e3", Some(1.45)),
        ("lossless_e3", None),
    ];

    let mut all_equal = true;
    for (name, w, h, rgb) in &images {
        for (cname, dist) in configs {
            let opts = match dist {
                Some(d) => EncodeOptions {
                    rate: Rate::Distance(*d),
                    ..Default::default()
                }
                .with_effort(3),
                None => EncodeOptions::lossless().with_effort(3),
            };
            let mut enc = Encoder::new(opts).expect("encoder");
            let whole = enc
                .encode(&Frame::rgb(rgb, *w as u32, *h as u32))
                .expect("whole encode");
            let chunked = encode_chunked_rgb8(rgb, *w as u32, *h as u32, dist.unwrap_or(0.0), 3)
                .expect("chunked encode");
            match first_diff(&whole, &chunked) {
                None => println!("{name} {cname}: EQUAL ({} bytes)", whole.len()),
                Some(off) => {
                    all_equal = false;
                    println!(
                        "{name} {cname}: DIFFER whole={}B chunked={}B first_diff@{off}",
                        whole.len(),
                        chunked.len()
                    );
                }
            }
        }
    }
    println!(
        "verdict: {}",
        if all_equal {
            "ALL EQUAL"
        } else {
            "NOT byte-identical"
        }
    );

    // ── thread-parity gate: chunked output must be byte-identical across thread counts,
    //    and whole-frame MT must match whole-frame ST (prerequisite for wiring the
    //    threaded chunked encoder into the post-barrier full-res tiers). ──
    let mut threads_equal = true;
    for (name, w, h, rgb) in &images {
        for (cname, dist) in [("d1.00_e3", 1.0f32), ("lossless_e3", 0.0)] {
            let mut st = Vec::new();
            encode_chunked_threaded(
                *w as u32,
                *h as u32,
                dist,
                3,
                1,
                &mut WholeImageSource {
                    data: rgb,
                    width: *w,
                },
                &mut st,
            )
            .expect("chunked st");
            for threads in [2usize, 4, 8] {
                let mut mt = Vec::new();
                encode_chunked_threaded(
                    *w as u32,
                    *h as u32,
                    dist,
                    3,
                    threads,
                    &mut WholeImageSource {
                        data: rgb,
                        width: *w,
                    },
                    &mut mt,
                )
                .expect("chunked mt");
                if mt != st {
                    threads_equal = false;
                    println!("{name} {cname} chunked threads={threads}: DIFFER vs ST");
                }
            }
            // whole-frame MT vs ST
            let opts = if dist > 0.0 {
                EncodeOptions {
                    rate: Rate::Distance(dist),
                    ..Default::default()
                }
                .with_effort(3)
            } else {
                EncodeOptions::lossless().with_effort(3)
            };
            let whole_st = Encoder::new(opts.clone())
                .unwrap()
                .encode(&Frame::rgb(rgb, *w as u32, *h as u32))
                .unwrap();
            let whole_mt = Encoder::with_threads(opts, 4)
                .unwrap()
                .encode(&Frame::rgb(rgb, *w as u32, *h as u32))
                .unwrap();
            if whole_mt != whole_st {
                threads_equal = false;
                println!("{name} {cname} whole MT4: DIFFER vs whole ST");
            }
        }
        println!("{name}: thread-parity checked");
    }
    println!(
        "thread-parity verdict: {}",
        if threads_equal {
            "ALL EQUAL ACROSS THREADS"
        } else {
            "THREAD-DEPENDENT OUTPUT"
        }
    );
}
