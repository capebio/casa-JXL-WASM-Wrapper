//! Hostile-header preflight tests for developed-image decode limits (Finding 59).
//!
//! These assert that oversized / overflowing developed-image headers are REJECTED
//! by a cheap header probe BEFORE any pixel buffer is allocated or decoded, and
//! that a valid small image still decodes. The probe must read dimensions,
//! channels, and sample representation from the format libraries' structured
//! metadata APIs — never by decoding pixels to discover the shape.

use raw_pipeline::image_formats::{
    self, decode_jpeg_bytes, probe_developed_header, DecodeLimits, DevelopedFormat, SampleRepr,
};

// ── Fixtures: encoded by the `image` crate itself so the headers are real. ──

/// A tiny valid RGB8 JPEG (16×12). Must pass every limit and decode.
fn small_jpeg() -> Vec<u8> {
    let mut img = image::RgbImage::new(16, 12);
    for (x, y, px) in img.enumerate_pixels_mut() {
        *px = image::Rgb([(x % 256) as u8, (y % 256) as u8, 128]);
    }
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .expect("encode jpeg fixture");
    buf.into_inner()
}

/// A valid small RGBA-f32 EXR (2×2). Real EXR header; used to prove the probe
/// reads f32 sample representation and 400 MP-scale output byte accounting.
fn small_exr() -> Vec<u8> {
    let img: image::ImageBuffer<image::Rgba<f32>, Vec<f32>> =
        image::ImageBuffer::from_raw(2, 2, vec![1.0; 2 * 2 * 4]).unwrap();
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba32F(img)
        .write_to(&mut buf, image::ImageFormat::OpenExr)
        .expect("encode exr fixture");
    buf.into_inner()
}

/// A valid small RGB16 TIFF (2×2).
fn small_tiff() -> Vec<u8> {
    let img: image::ImageBuffer<image::Rgb<u16>, Vec<u16>> =
        image::ImageBuffer::from_raw(2, 2, vec![1000u16; 2 * 2 * 3]).unwrap();
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb16(img)
        .write_to(&mut buf, image::ImageFormat::Tiff)
        .expect("encode tiff fixture");
    buf.into_inner()
}

// ───────────────────────── Probe: reads real headers ─────────────────────────

#[test]
fn probe_reads_jpeg_header_without_decoding_pixels() {
    let p = probe_developed_header(&small_jpeg(), DevelopedFormat::Jpeg).expect("probe jpeg");
    assert_eq!(p.format, DevelopedFormat::Jpeg);
    assert_eq!((p.width, p.height), (16, 12));
    assert_eq!(p.sample, SampleRepr::U8);
    // Output is always RGBA at the source depth: 16*12*4 bytes for u8.
    assert_eq!(p.output_bytes, 16 * 12 * 4);
}

#[test]
fn probe_reads_exr_f32_sample_representation() {
    let p = probe_developed_header(&small_exr(), DevelopedFormat::Exr).expect("probe exr");
    assert_eq!(p.sample, SampleRepr::F32);
    assert_eq!((p.width, p.height), (2, 2));
    // RGBA f32 = 16 B/px.
    assert_eq!(p.output_bytes, 2 * 2 * 16);
}

#[test]
fn probe_reads_tiff_u16_sample_representation() {
    let p = probe_developed_header(&small_tiff(), DevelopedFormat::Tiff).expect("probe tiff");
    assert_eq!(p.sample, SampleRepr::U16);
    assert_eq!((p.width, p.height), (2, 2));
    // RGBA16 = 8 B/px.
    assert_eq!(p.output_bytes, 2 * 2 * 8);
}

// ─────────────────────── Limit profiles: sane relative order ───────────────────

#[test]
fn wasm_profile_is_tighter_than_native() {
    let w = DecodeLimits::wasm();
    let n = DecodeLimits::native();
    assert!(w.max_pixels <= n.max_pixels);
    assert!(w.max_output_bytes <= n.max_output_bytes);
    assert!(w.max_input_bytes <= n.max_input_bytes);
}

#[test]
fn wasm_profile_output_plus_input_plus_scratch_fits_under_two_gib() {
    // The threaded wasm build caps shared memory at 2 GiB (tools/build-mt-wasm.sh
    // --max-memory=2G). The developed-image path holds, at peak: the input
    // container bytes + the decoder's intermediate buffer + the RGBA output.
    // Model peak as input + 2× output (output-sized decode scratch) and require
    // it, with a safety margin, to stay under the ceiling.
    const WASM_MEMORY_MAX: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB shared heap
    const SAFETY_MARGIN: u64 = 256 * 1024 * 1024; // allocator frag + worker stacks
    let l = DecodeLimits::wasm();
    let projected_peak = l.max_input_bytes + l.max_output_bytes.saturating_mul(2);
    assert!(
        projected_peak + SAFETY_MARGIN <= WASM_MEMORY_MAX,
        "wasm peak {} + margin exceeds 2 GiB",
        projected_peak
    );
}

// ───────────────────── Hostile headers: rejected before decode ─────────────────

#[test]
fn rejects_400mp_exr_before_allocating() {
    // A synthetic EXR header claiming ~400 MP (20000×20000). At RGBA f32 that is
    // ~25.6 GB of output — must be rejected by the pixel/output-byte limits, not
    // by running out of memory mid-decode.
    let probe = image_formats::HeaderProbe {
        format: DevelopedFormat::Exr,
        width: 20_000,
        height: 20_000,
        channels: 4,
        sample: SampleRepr::F32,
        output_bytes: 20_000u64 * 20_000 * 16,
    };
    let l = DecodeLimits::wasm();
    assert!(l.check(&probe, 4096).is_err(), "400 MP EXR must be rejected");
}

#[test]
fn rejects_tiff_with_overflowing_dimensions() {
    // width*height overflows a naive u32 product; the checked probe must saturate
    // to max_pixels and reject rather than wrap to a small value.
    let probe = image_formats::HeaderProbe {
        format: DevelopedFormat::Tiff,
        width: u32::MAX,
        height: u32::MAX,
        channels: 4,
        sample: SampleRepr::U16,
        output_bytes: u64::MAX,
    };
    let l = DecodeLimits::native();
    assert!(
        l.check(&probe, 1024).is_err(),
        "overflowing TIFF dims must be rejected without panicking"
    );
}

#[test]
fn rejects_tiny_compressed_but_huge_decoded() {
    // A file whose COMPRESSED size is tiny (4 KB) but whose DECODED output exceeds
    // the wasm budget. The output-byte limit — not the input-byte limit — must
    // catch it. 10000×8000 RGBA16 = 640 MB decoded, over the 512 MiB output cap,
    // while still under the 100 MP dimension cap (80 MP).
    let probe = image_formats::HeaderProbe {
        format: DevelopedFormat::Tiff,
        width: 10_000,
        height: 8_000,
        channels: 4,
        sample: SampleRepr::U16,
        output_bytes: 10_000u64 * 8_000 * 8,
    };
    let l = DecodeLimits::wasm();
    let tiny_input = 4 * 1024u64;
    assert!(tiny_input <= l.max_input_bytes, "input itself is within budget");
    assert!(
        l.check(&probe, tiny_input).is_err(),
        "huge decoded output from tiny input must be rejected"
    );
}

// ──────────────── End-to-end: probe-gated decoders reject / accept ─────────────

#[test]
fn decode_jpeg_with_limits_accepts_small_valid_image() {
    let jpeg = small_jpeg();
    let l = DecodeLimits::wasm();
    let d = image_formats::decode_jpeg_bytes_limited(&jpeg, &l).expect("small jpeg decodes");
    assert_eq!((d.width, d.height, d.bit_depth), (16, 12, 8));
    assert_eq!(d.u8.len(), 16 * 12 * 4);
}

#[test]
fn decode_jpeg_with_limits_rejects_when_input_over_budget() {
    // A valid small JPEG, but a limit profile whose input cap is below the file
    // size, must be rejected at the input-byte gate before decoding.
    let jpeg = small_jpeg();
    let tight = DecodeLimits {
        max_input_bytes: 8, // smaller than the JPEG
        ..DecodeLimits::wasm()
    };
    assert!(
        image_formats::decode_jpeg_bytes_limited(&jpeg, &tight).is_err(),
        "over-budget input must be rejected"
    );
}

#[test]
fn unlimited_decode_jpeg_still_works() {
    // The original unguarded entry point still decodes a valid small JPEG.
    let d = decode_jpeg_bytes(&small_jpeg()).expect("decode jpeg");
    assert_eq!((d.width, d.height, d.bit_depth), (16, 12, 8));
}
