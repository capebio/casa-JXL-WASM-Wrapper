//! Test B — Butteraugli rate-distortion. Decodes 12 Gobabeb ORF -> RGB8, encodes
//! d=1.0/effort=EFFORT (default 3) via Casa -> jxl-ffi -> libjxl, decodes the JXL
//! back to RGBA8, and scores butteraugli(source vs roundtrip) with the rust-native
//! Comparer (build-independent judge). Prints per-file bytes + butteraugli so the
//! same exe, built against two libjxl variants, exposes rate-vs-quality.
//!
//! Run: cargo run --release --no-default-features --features "jxl-codec parallel" \
//!        --example encoder_ab_rd -- "C:\995\2026-02-20 Gobabeb To Windhoek" 12

use raw_pipeline::jxl_casadecoder::{Channels, DecodeOptions, Decoder, Image};
use raw_pipeline::jxl_casaencoder::{EncodeOptions, Encoder, Frame};
use raw_pipeline::perceptual::{Comparer, Opts};
use raw_pipeline::{
    decompress, demosaic,
    pipeline::{self, PipelineParams},
    tiff,
};

fn decode_orf(path: &str) -> Option<(Vec<u8>, u32, u32)> {
    let data = std::fs::read(path).ok()?;
    let info = tiff::parse(&data).ok()?;
    let w = info.width as usize;
    let h = info.height as usize;
    let end = info.strip_offset as usize + info.strip_byte_count as usize;
    let strip = data.get(info.strip_offset as usize..end)?;
    let raw = decompress::decompress(strip, w, h).ok()?;
    let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).ok()?;
    let mut p = PipelineParams::default_olympus();
    p.wb_r = info.wb_r.unwrap_or(1.797);
    p.wb_g = 1.0;
    p.wb_b = info.wb_b.unwrap_or(1.797);
    p.color_matrix = info.color_matrix;
    let mut rgb8 = vec![0u8; w * h * 3];
    pipeline::process_into_auto(&rgb16, &p, &mut rgb8);
    Some((rgb8, w as u32, h as u32))
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

fn main() {
    let folder = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\995\2026-02-20 Gobabeb To Windhoek".into());
    let n: usize = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(12);
    let effort: u8 = std::env::var("EFFORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3);

    let mut files: Vec<_> = std::fs::read_dir(&folder)
        .expect("readdir")
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("orf"))
                .unwrap_or(false)
        })
        .collect();
    files.sort();
    files.truncate(n);

    println!("effort={effort}  d=1.0  judge=rust-native Comparer (build-independent)\n");
    println!("{:<14} {:>10} {:>9}", "file", "bytes", "butter");

    let opts = EncodeOptions {
        use_container: true,
        ..EncodeOptions::distance(1.0).with_effort(effort)
    };

    let mut tot_bytes = 0usize;
    let mut sum_butter = 0.0f64;
    let mut max_butter = 0.0f32;
    for p in &files {
        let (rgb, w, h) = decode_orf(p.to_str().unwrap()).expect("decode orf");

        let mut enc = Encoder::with_threads(opts.clone(), 1).expect("encoder");
        let mut jxl = Vec::with_capacity(rgb.len() / 3);
        enc.encode_into(&Frame::rgb(&rgb, w, h), &mut jxl)
            .expect("encode");

        let mut dec = Decoder::new(DecodeOptions::default()).expect("decoder");
        let img: Image<u8> = dec.decode(&jxl, Channels::Rgba).expect("decode jxl");

        let src_rgba = rgb8_to_rgba8(&rgb);
        let mut cmp = Comparer::new(src_rgba, w as usize, h as usize, Opts::default());
        let b = cmp.butteraugli(&img.data);

        let name = p.file_name().unwrap().to_string_lossy();
        println!("{:<14} {:>10} {:>9.4}", name, jxl.len(), b);
        tot_bytes += jxl.len();
        sum_butter += b as f64;
        max_butter = max_butter.max(b);
    }
    let nimg = files.len() as f64;
    println!(
        "\nbytes_total: {}  ({:.1} KB/img)",
        tot_bytes,
        tot_bytes as f64 / 1024.0 / nimg
    );
    println!(
        "butter mean: {:.4}   max: {:.4}",
        sum_butter / nimg,
        max_butter
    );
}
