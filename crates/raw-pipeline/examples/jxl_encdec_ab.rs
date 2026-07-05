//! libjxl A/B — full-res JXL encode + decode timing on pre-dumped RGB bins.
//! Format-agnostic: reads <name>.rgb (u32 LE w, u32 LE h, w*h*3 RGB8) so the SAME
//! pixels are encoded/decoded by whichever libjxl this binary was built against
//! (LIBJXL_SOURCE_DIR = 0.11.2 vs 012). One JSON line per file to stdout.
//!
//! Env: EFFORT (default 3), ROUNDS (default 3, per-file median), TAG (label).
//! Run: cargo run --release -p raw-pipeline --example jxl_encdec_ab -- C:\Tmp\rcw-rgb

use raw_pipeline::jxl_casadecoder::{Channels, DecodeOptions, Decoder, Image};
use raw_pipeline::jxl_casaencoder::{EncodeOptions, Encoder, Frame};
use raw_pipeline::perceptual::{Comparer, Opts};
use std::time::Instant;

fn read_rgb(path: &std::path::Path) -> Option<(Vec<u8>, u32, u32)> {
    let b = std::fs::read(path).ok()?;
    if b.len() < 8 {
        return None;
    }
    let w = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
    let h = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
    let need = 8 + (w as usize) * (h as usize) * 3;
    if b.len() < need {
        return None;
    }
    Some((b[8..need].to_vec(), w, h))
}

fn rgb8_to_rgba8(rgb: &[u8]) -> Vec<u8> {
    let mut out = vec![255u8; rgb.len() / 3 * 4];
    for (i, c) in rgb.chunks_exact(3).enumerate() {
        out[i * 4] = c[0];
        out[i * 4 + 1] = c[1];
        out[i * 4 + 2] = c[2];
    }
    out
}

fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Tmp\rcw-rgb".into());
    let effort: u8 = std::env::var("EFFORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3);
    let rounds: usize = std::env::var("ROUNDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3);
    let tag = std::env::var("TAG").unwrap_or_else(|_| "lib".into());

    let opts = EncodeOptions {
        use_container: true,
        ..EncodeOptions::distance(1.0).with_effort(effort)
    };

    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .expect("readdir")
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("rgb"))
                .unwrap_or(false)
        })
        .collect();
    files.sort();

    for p in &files {
        let Some((rgb, w, h)) = read_rgb(p) else {
            eprintln!("skip bad {}", p.display());
            continue;
        };
        let name = p.file_stem().unwrap().to_string_lossy().to_string();

        // warm (build masks/LUTs; libjxl thread/setup amortized in median anyway)
        let mut enc = Encoder::with_threads(opts.clone(), 1).expect("enc");
        let mut jxl = Vec::with_capacity(rgb.len() / 3);
        enc.encode_into(&Frame::rgb(&rgb, w, h), &mut jxl)
            .expect("encode");

        let mut enc_ms = Vec::new();
        let mut dec_ms = Vec::new();
        let mut bytes = 0usize;
        let mut butter = 0.0f32;
        let src_rgba = rgb8_to_rgba8(&rgb);

        for r in 0..rounds {
            // encode
            let mut e = Encoder::with_threads(opts.clone(), 1).expect("enc");
            let mut out = Vec::with_capacity(rgb.len() / 3);
            let t = Instant::now();
            e.encode_into(&Frame::rgb(&rgb, w, h), &mut out)
                .expect("encode");
            enc_ms.push(t.elapsed().as_secs_f64() * 1000.0);
            bytes = out.len();

            // decode (full)
            let mut d = Decoder::new(DecodeOptions::default()).expect("dec");
            let t2 = Instant::now();
            let img: Image<u8> = d.decode(&out, Channels::Rgba).expect("decode");
            dec_ms.push(t2.elapsed().as_secs_f64() * 1000.0);

            if r == 0 {
                let mut cmp =
                    Comparer::new(src_rgba.clone(), w as usize, h as usize, Opts::default());
                butter = cmp.butteraugli(&img.data);
            }
        }
        let e_med = median(&mut enc_ms);
        let d_med = median(&mut dec_ms);
        println!(
            "{{\"tag\":\"{tag}\",\"file\":\"{name}\",\"w\":{w},\"h\":{h},\"mp\":{:.2},\"effort\":{effort},\"enc_ms\":{:.2},\"dec_ms\":{:.2},\"bytes\":{bytes},\"butter\":{:.4}}}",
            (w as f64 * h as f64) / 1e6, e_med, d_med, butter
        );
    }
}
