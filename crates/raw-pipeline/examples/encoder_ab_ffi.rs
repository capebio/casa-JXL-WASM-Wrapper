//! Encoder A/B — jxl-ffi/Casa side. Decodes 12 Gobabeb ORF -> RGB8, dumps each to
//! %TEMP%\rcab\NN.rgb8 (so the Tauri jpegxl-rs harness encodes the IDENTICAL
//! pixels), then runs 3 rounds of 12-wide x 1-thread encode via Casa -> jxl-ffi ->
//! libjxl 0.11.2 (d=1.0/q90, effort=3). Reports files/sec per round + median.
//!
//! Run: cargo run --release --no-default-features --features jxl-codec \
//!        --example encoder_ab_ffi -- "C:\995\2026-02-20 Gobabeb To Windhoek" 12
use raw_pipeline::jxl_casaencoder::{EncodeOptions, Encoder, Frame};
use raw_pipeline::{
    decompress, demosaic,
    pipeline::{self, PipelineParams},
    tiff,
};
use rayon::prelude::*;
use std::io::Write;
use std::time::Instant;

fn decode(path: &str) -> Option<(Vec<u8>, u32, u32)> {
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

fn casa_encode(rgb: &[u8], w: u32, h: u32, threads: usize) -> usize {
    let opts = EncodeOptions {
        use_container: true,
        ..EncodeOptions::distance(1.0).with_effort(3)
    };
    let mut enc = Encoder::with_threads(opts, threads).expect("encoder");
    let mut out = Vec::with_capacity(rgb.len() / 3);
    enc.encode_into(&Frame::rgb(rgb, w, h), &mut out)
        .expect("encode");
    out.len()
}

fn main() {
    let folder = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\995\2026-02-20 Gobabeb To Windhoek".into());
    let n: usize = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(12);

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

    // Decode once + dump RGB8 so the Tauri harness encodes identical pixels.
    let dumpdir = std::env::temp_dir().join("rcab");
    std::fs::create_dir_all(&dumpdir).unwrap();
    let mut imgs: Vec<(Vec<u8>, u32, u32)> = Vec::new();
    for (i, p) in files.iter().enumerate() {
        let (rgb, w, h) = decode(p.to_str().unwrap()).expect("decode");
        let mut f = std::fs::File::create(dumpdir.join(format!("{i:02}.rgb8"))).unwrap();
        f.write_all(&w.to_le_bytes()).unwrap();
        f.write_all(&h.to_le_bytes()).unwrap();
        f.write_all(&rgb).unwrap();
        imgs.push((rgb, w, h));
    }
    println!(
        "decoded + dumped {} imgs -> {}",
        imgs.len(),
        dumpdir.display()
    );
    println!(
        "stack: Casa -> jxl-ffi -> libjxl 0.11.2 ; 12-wide x 1 thread ; d=1.0(=q90) effort=3\n"
    );

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(imgs.len().max(1))
        .build()
        .unwrap();
    let mut secs = Vec::new();
    for r in 1..=3 {
        let t = Instant::now();
        let acc: usize = pool.install(|| {
            imgs.par_iter()
                .map(|(rgb, w, h)| casa_encode(rgb, *w, *h, 1))
                .sum()
        });
        std::hint::black_box(acc);
        let s = t.elapsed().as_secs_f64();
        println!("round {r}: {s:.3}s  {:.2} files/sec", imgs.len() as f64 / s);
        secs.push(s);
    }
    secs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "\njxl-ffi (libjxl 0.11.2) median: {:.3}s  {:.2} files/sec",
        secs[1],
        imgs.len() as f64 / secs[1]
    );
}
