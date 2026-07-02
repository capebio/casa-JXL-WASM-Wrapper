//! ae_golden — golden-output hasher for the app-side encode pathway (agent appe3, jul02).
//!
//! Prints one FNV-1a-64 line per (entry point × fixture × config) covering:
//!   - encode_variants / _with_progressive (opaque + alpha, resize + coalesced + hq + odd dims)
//!   - encode_variants_from_rgb16(_with_progressive) (texture/clarity on & off)
//!   - encode_rgba8_pyramid (opaque + alpha) + encode_rgba8_pyramid_from_rgb16
//!   - a real-DNG-derived rgb16 variant set when the fixture file is present
//!
//! Run on the unmodified baseline, save the output, re-run after each change and
//! diff — every line must be identical for a byte-exact claim.
//!
//!   cargo run --release --example ae_golden

use raw_pipeline::casabio_encode::{
    encode_rgba8_pyramid, encode_rgba8_pyramid_from_rgb16, encode_variants,
    encode_variants_from_rgb16, encode_variants_from_rgb16_with_progressive,
    encode_variants_with_progressive, SourceType, VariantSet,
};
use raw_pipeline::pipeline::PipelineParams;

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn rand_rgba(w: u32, h: u32, alpha: bool) -> Vec<u8> {
    let n = (w * h) as usize;
    let mut v = vec![0u8; n * 4];
    let mut s: u32 = 0x9e37_79b9u32.wrapping_mul(w).wrapping_add(h).wrapping_add(7);
    for (i, px) in v.chunks_exact_mut(4).enumerate() {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        px[0] = (s >> 24) as u8;
        px[1] = (s >> 16) as u8;
        px[2] = (s >> 8) as u8;
        px[3] = if alpha && i % 5 == 0 { (s >> 1) as u8 } else { 255 };
    }
    v
}

fn rand_rgb16(w: u32, h: u32) -> Vec<u16> {
    let n = (w * h) as usize * 3;
    let mut v = vec![0u16; n];
    let mut s: u32 = 0x85eb_ca6bu32.wrapping_mul(w).wrapping_add(h).wrapping_add(3);
    for x in v.iter_mut() {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *x = (s >> 16) as u16;
    }
    v
}

fn vs_line(name: &str, v: &VariantSet) {
    println!(
        "{name}: thumb={:016x} ({}x{}) preview={:016x} ({}x{}) full={:016x} q={} has_alpha={}",
        fnv1a(&v.thumb_300), v.thumb_w, v.thumb_h,
        fnv1a(&v.preview_1080), v.preview_w, v.preview_h,
        fnv1a(&v.full), v.full_quality, v.has_alpha,
    );
}

fn pyr_line(name: &str, levels: &[raw_pipeline::casabio_encode::PyramidLevel]) {
    let parts: Vec<String> = levels
        .iter()
        .map(|l| format!("{}x{}={:016x}", l.width, l.height, fnv1a(&l.data)))
        .collect();
    println!("{name}: {}", parts.join(" "));
}

fn main() {
    // ── variants: RGBA entries ─────────────────────────────────────────────
    let big = rand_rgba(1600, 1200, false);
    vs_line("variants_raw_1600", &encode_variants(&big, 1600, 1200, SourceType::Raw, false).unwrap());
    vs_line("variants_jpeg_1600", &encode_variants(&big, 1600, 1200, SourceType::Jpeg, false).unwrap());
    vs_line(
        "variants_prog21_1600",
        &encode_variants_with_progressive(&big, 1600, 1200, SourceType::Raw, false, 2, 1).unwrap(),
    );

    let small = rand_rgba(640, 480, false);
    vs_line("variants_coalesce_640", &encode_variants(&small, 640, 480, SourceType::Jpeg, false).unwrap());
    vs_line("variants_hq_640", &encode_variants(&small, 640, 480, SourceType::Jpeg, true).unwrap());

    let odd = rand_rgba(97, 61, false);
    vs_line("variants_odd_97x61", &encode_variants(&odd, 97, 61, SourceType::Jpeg, false).unwrap());

    let portrait = rand_rgba(1359, 2043, false);
    vs_line("variants_portrait_1359x2043", &encode_variants(&portrait, 1359, 2043, SourceType::Raw, false).unwrap());

    let al = rand_rgba(800, 600, true);
    vs_line("variants_alpha_800", &encode_variants(&al, 800, 600, SourceType::Other, false).unwrap());

    // ── variants: from_rgb16 entries ───────────────────────────────────────
    let r16 = rand_rgb16(1600, 1200);
    let params = PipelineParams::default_olympus();
    vs_line(
        "from_rgb16_plain",
        &encode_variants_from_rgb16(&r16, &params, 1600, 1200, SourceType::Raw, false).unwrap(),
    );
    let mut params_tc = params.clone();
    params_tc.texture = 0.35;
    params_tc.clarity = 0.2;
    vs_line(
        "from_rgb16_texclar",
        &encode_variants_from_rgb16(&r16, &params_tc, 1600, 1200, SourceType::Raw, false).unwrap(),
    );
    vs_line(
        "from_rgb16_prog21",
        &encode_variants_from_rgb16_with_progressive(&r16, &params, 1600, 1200, SourceType::Raw, false, 2, 1)
            .unwrap(),
    );

    // ── pyramids ───────────────────────────────────────────────────────────
    pyr_line(
        "pyramid_opaque_1600",
        &encode_rgba8_pyramid(&big, 1600, 1200, 0.55, &[256, 1024], &[1.45, 1.45], 3).unwrap(),
    );
    pyr_line(
        "pyramid_alpha_640",
        &encode_rgba8_pyramid(&al[..(640 * 480 * 4) as usize], 640, 480, 0.55, &[256], &[1.45], 3).unwrap(),
    );
    pyr_line(
        "pyramid_from_rgb16_1600",
        &encode_rgba8_pyramid_from_rgb16(&r16, &params, 1600, 1200, 0.55, &[256, 1024], &[1.45, 1.45], 3)
            .unwrap(),
    );

    // ── real DNG-derived rgb16 (skipped when the fixture is absent) ────────
    let dng_path = r"C:\Foo\raw-converter\tests\PXL_20260501_093507165.RAW-02.ORIGINAL.dng";
    if let Ok(data) = std::fs::read(dng_path) {
        let img = raw_pipeline::dng::decode_bytes(&data).expect("dng decode");
        let phase = match img.cfa {
            raw_pipeline::dng::Cfa::Rggb => (0, 0),
            raw_pipeline::dng::Cfa::Grbg => (0, 1),
            raw_pipeline::dng::Cfa::Gbrg => (1, 0),
            raw_pipeline::dng::Cfa::Bggr => (1, 1),
        };
        let rgb16 = raw_pipeline::demosaic::demosaic_bayer_mhc(&img.raw, img.width, img.height, phase)
            .expect("demosaic");
        let mut p = PipelineParams::default_olympus();
        p.black = img.black;
        p.white = img.white;
        p.wb_r = img.wb_r;
        p.wb_b = img.wb_b;
        p.color_matrix = img.color_matrix;
        let (w, h) = (img.width as u32, img.height as u32);
        vs_line(
            "from_rgb16_realdng",
            &encode_variants_from_rgb16(&rgb16, &p, w, h, SourceType::Raw, false).unwrap(),
        );
        let mut ptc = p.clone();
        ptc.texture = 0.35;
        ptc.clarity = 0.2;
        vs_line(
            "from_rgb16_realdng_texclar",
            &encode_variants_from_rgb16(&rgb16, &ptc, w, h, SourceType::Raw, false).unwrap(),
        );
        pyr_line(
            "pyramid_from_rgb16_realdng",
            &encode_rgba8_pyramid_from_rgb16(&rgb16, &p, w, h, 0.55, &[256, 2048], &[1.45, 0.55], 3).unwrap(),
        );
    } else {
        println!("realdng: SKIPPED (fixture absent)");
    }
}
