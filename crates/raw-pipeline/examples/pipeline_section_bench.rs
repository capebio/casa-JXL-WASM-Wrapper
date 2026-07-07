//! Pipeline section bench — per-section + whole-pipeline timing for one .dng,
//! .cr2, .orf each, so the impact of any change (raw-pipeline OR libjxl) can be
//! attributed to a SECTION (raw_parse / demosaic / tone / encode / decode / ttfp)
//! and to the end-to-end "RAW -> displayed in a lightbox" wall.
//!
//! Develop colour fidelity is irrelevant to timing: we encode then decode the
//! SAME RGB8, so butteraugli measures JXL roundtrip fidelity regardless of how
//! the raw was developed. The develop only needs correct dimensions.
//!
//! Env: EFFORT (3), ROUNDS (5 — per-section median), TAG (build label).
//! Emits one JSON line per file. Format detected by extension.
//! Run: cargo run --release -p raw-pipeline --example pipeline_section_bench -- <files...>

use raw_pipeline::jxl_casadecoder::{
    decode_progressive_first_total, Channels, DecodeOptions, Decoder, Image,
};
use raw_pipeline::jxl_casaencoder::{EncodeOptions, Encoder, Frame};
use raw_pipeline::pipeline::{self, PipelineParams};
use raw_pipeline::{cr2, decompress, demosaic, dng, tiff};
use std::time::Instant;

struct Developed {
    rgb8: Vec<u8>,
    w: u32,
    h: u32,
    parse_ms: f64,
    demosaic_ms: f64,
    tone_ms: f64,
}

fn ms_since(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn develop(path: &std::path::Path) -> Option<(Developed, &'static str)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let data = std::fs::read(path).ok()?;
    match ext.as_str() {
        "orf" | "raw" => {
            let t = Instant::now();
            let info = tiff::parse(&data).ok()?;
            let (w, h) = (info.width as usize, info.height as usize);
            let end = info.strip_offset as usize + info.strip_byte_count as usize;
            let strip = data.get(info.strip_offset as usize..end)?;
            let raw = decompress::decompress(strip, w, h).ok()?;
            let parse_ms = ms_since(t);
            let t = Instant::now();
            let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).ok()?;
            let demosaic_ms = ms_since(t);
            let mut p = PipelineParams::default_olympus();
            p.wb_r = info.wb_r.unwrap_or(1.797);
            p.wb_g = 1.0;
            p.wb_b = info.wb_b.unwrap_or(1.797);
            p.color_matrix = info.color_matrix.into();
            let mut rgb8 = vec![0u8; w * h * 3];
            let t = Instant::now();
            pipeline::process_into_auto(&rgb16, &p, &mut rgb8);
            Some((
                Developed {
                    rgb8,
                    w: w as u32,
                    h: h as u32,
                    parse_ms,
                    demosaic_ms,
                    tone_ms: ms_since(t),
                },
                "orf",
            ))
        }
        "cr2" => {
            let t = Instant::now();
            let img = cr2::decode_bytes(&data).ok()?;
            let parse_ms = ms_since(t);
            let (w, h) = (img.width, img.height);
            let t = Instant::now();
            let rgb16 = demosaic::demosaic_rggb(&img.raw, w, h).ok()?;
            let demosaic_ms = ms_since(t);
            let mut p = PipelineParams::default_olympus();
            p.black = img.black;
            p.white = img.white;
            p.wb_r = img.wb_r;
            p.wb_g = img.wb_g;
            p.wb_b = img.wb_b;
            p.color_matrix = img.color_matrix.into();
            let mut rgb8 = vec![0u8; w * h * 3];
            let t = Instant::now();
            pipeline::process_into_auto(&rgb16, &p, &mut rgb8);
            Some((
                Developed {
                    rgb8,
                    w: w as u32,
                    h: h as u32,
                    parse_ms,
                    demosaic_ms,
                    tone_ms: ms_since(t),
                },
                "cr2",
            ))
        }
        "dng" => {
            let t = Instant::now();
            let img = dng::decode_bytes(&data).ok()?;
            let parse_ms = ms_since(t);
            let (w, h) = (img.width, img.height);
            let phase = match img.cfa {
                dng::Cfa::Rggb => (0, 0),
                dng::Cfa::Grbg => (0, 1),
                dng::Cfa::Gbrg => (1, 0),
                dng::Cfa::Bggr => (1, 1),
            };
            let t = Instant::now();
            let rgb16 = demosaic::demosaic_bayer_mhc(&img.raw, w, h, phase).ok()?;
            let demosaic_ms = ms_since(t);
            let mut p = PipelineParams::default_olympus();
            p.black = img.black;
            p.white = img.white;
            p.wb_r = img.wb_r;
            p.wb_g = img.wb_g;
            p.wb_b = img.wb_b;
            p.color_matrix = img.color_matrix.into();
            let mut rgb8 = vec![0u8; w * h * 3];
            let t = Instant::now();
            pipeline::process_into_auto(&rgb16, &p, &mut rgb8);
            Some((
                Developed {
                    rgb8,
                    w: w as u32,
                    h: h as u32,
                    parse_ms,
                    demosaic_ms,
                    tone_ms: ms_since(t),
                },
                "dng",
            ))
        }
        _ => None,
    }
}

fn median(v: &mut Vec<f64>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let files: Vec<std::path::PathBuf> = std::env::args()
        .skip(1)
        .map(std::path::PathBuf::from)
        .collect();
    let effort: u8 = std::env::var("EFFORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3);
    let rounds: usize = std::env::var("ROUNDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);
    let tag = std::env::var("TAG").unwrap_or_else(|_| "lib".into());
    let opts = EncodeOptions {
        use_container: true,
        ..EncodeOptions::distance(1.0).with_effort(effort)
    };

    for path in &files {
        // RAW develop is re-run each round (it's a measured section). Sections accumulate medians.
        let mut parse = Vec::new();
        let mut dem = Vec::new();
        let mut tone = Vec::new();
        let mut enc = Vec::new();
        let mut decf = Vec::new();
        let mut ttfp = Vec::new();
        let mut load_e2e = Vec::new();
        let mut ttfp_e2e = Vec::new();
        let mut bytes = 0usize;
        let mut fmt = "";
        let mut w = 0u32;
        let mut h = 0u32;

        for _ in 0..rounds {
            let Some((d, f)) = develop(path) else {
                eprintln!("skip (develop failed) {}", path.display());
                break;
            };
            fmt = f;
            w = d.w;
            h = d.h;
            // encode
            let mut e = Encoder::with_threads(opts.clone(), 1).expect("enc");
            let mut jxl = Vec::with_capacity(d.rgb8.len() / 3);
            let te = Instant::now();
            e.encode_into(&Frame::rgb(&d.rgb8, w, h), &mut jxl)
                .expect("encode");
            let enc_ms = ms_since(te);
            bytes = jxl.len();
            // full decode
            let mut dec = Decoder::new(DecodeOptions::default()).expect("dec");
            let td = Instant::now();
            let _img: Image<u8> = dec.decode(&jxl, Channels::Rgba).expect("decode");
            let dec_ms = ms_since(td);
            // time to first paint (progressive first frame)
            let ttfp_ms = decode_progressive_first_total(&jxl)
                .map(|(first, _total)| first)
                .unwrap_or(0.0);

            let raw_total = d.parse_ms + d.demosaic_ms + d.tone_ms;
            parse.push(d.parse_ms);
            dem.push(d.demosaic_ms);
            tone.push(d.tone_ms);
            enc.push(enc_ms);
            decf.push(dec_ms);
            ttfp.push(ttfp_ms);
            // e2e: RAW bytes -> full image ready in lightbox = develop + encode + full decode.
            load_e2e.push(raw_total + enc_ms + dec_ms);
            // RAW -> first paint = develop + encode + first progressive frame.
            ttfp_e2e.push(raw_total + enc_ms + ttfp_ms);
        }
        if fmt.is_empty() {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy();
        println!(
            "{{\"tag\":\"{tag}\",\"file\":\"{name}\",\"fmt\":\"{fmt}\",\"w\":{w},\"h\":{h},\"mp\":{:.2},\"effort\":{effort},\
\"raw_parse_ms\":{:.2},\"demosaic_ms\":{:.2},\"tone_ms\":{:.2},\"encode_ms\":{:.2},\"decode_full_ms\":{:.2},\
\"ttfp_ms\":{:.2},\"load_e2e_ms\":{:.2},\"ttfp_e2e_ms\":{:.2},\"bytes\":{bytes}}}",
            (w as f64 * h as f64) / 1e6,
            median(&mut parse), median(&mut dem), median(&mut tone),
            median(&mut enc), median(&mut decf), median(&mut ttfp),
            median(&mut load_e2e), median(&mut ttfp_e2e)
        );
    }
}
