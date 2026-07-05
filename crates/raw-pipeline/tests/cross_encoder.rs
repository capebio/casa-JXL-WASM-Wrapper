//! Encode with libjxl (via raw-pipeline::casabio_encode) and decode with
//! jxl-oxide. The web client uses `jxl-oxide-wasm`, which wraps the same
//! crate — so a successful decode here means the Tauri uploader's bytes
//! will round-trip through the gallery's web decoder.

#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]

use jxl_oxide::JxlImage;
use raw_pipeline::casabio_encode::{encode_variants, encode_variants_with_progressive, SourceType};

fn gradient(w: u32, h: u32) -> Vec<u8> {
    (0..(w * h * 4)).map(|i| (i & 0xFF) as u8).collect()
}

#[test]
fn libjxl_encoded_variants_decode_with_oxide() {
    let rgba = gradient(1024, 768);
    let v = encode_variants(&rgba, 1024, 768, SourceType::Jpeg, false).unwrap();

    let img_thumb = JxlImage::builder()
        .read(v.thumb_300.as_slice())
        .expect("oxide parse");
    let _ = img_thumb.render_frame(0).expect("oxide decode");
    assert!(img_thumb.width().max(img_thumb.height()) <= 300);

    let img_preview = JxlImage::builder()
        .read(v.preview_1080.as_slice())
        .expect("oxide parse");
    let _ = img_preview.render_frame(0).expect("oxide decode");
    assert!(img_preview.width().max(img_preview.height()) <= 1080);

    let img_full = JxlImage::builder()
        .read(v.full.as_slice())
        .expect("oxide parse");
    let _ = img_full.render_frame(0).expect("oxide decode");
    assert_eq!(img_full.width(), 1024);
    assert_eq!(img_full.height(), 768);

    let aspect_orig = 1024.0 / 768.0;

    let aspect_thumb = img_thumb.width() as f32 / img_thumb.height() as f32;
    assert!(
        (aspect_orig - aspect_thumb).abs() < 0.02,
        "aspect ratio mismatch: thumb {aspect_thumb} vs orig {aspect_orig}"
    );

    let aspect_preview = img_preview.width() as f32 / img_preview.height() as f32;
    assert!(
        (aspect_orig - aspect_preview).abs() < 0.02,
        "aspect ratio mismatch: preview {aspect_preview} vs orig {aspect_orig}"
    );
}

#[test]
fn full_variant_roundtrips_pixels_through_oxide() {
    let (w, h) = (64u32, 64u32);
    let mut rgba = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            rgba[i] = (x * 4) as u8;
            rgba[i + 1] = (y * 4) as u8;
            rgba[i + 2] = ((x + y) * 2) as u8;
            rgba[i + 3] = 255;
        }
    }
    let v = encode_variants(&rgba, w, h, SourceType::Jpeg, false).unwrap();
    let img = JxlImage::builder().read(v.full.as_slice()).unwrap();
    let render = img.render_frame(0).unwrap();
    let fb = render.image_all_channels();
    let (buf, ch) = (fb.buf(), fb.channels());
    // jxl-oxide returns sRGB values for a sRGB-tagged JXL; compare only in sRGB.
    // Pre-compute sRGB→linear LUT to avoid per-pixel powf; not needed here but
    // kept for future reference. We compare only against the sRGB domain.
    let mut max_err = 0f32;
    for p in 0..(w * h) as usize {
        for c in 0..3 {
            let want_srgb = rgba[p * 4 + c] as f32 / 255.0;
            let got = buf[p * ch + c];
            let err = (got - want_srgb).abs();
            max_err = max_err.max(err);
        }
    }
    // Q85 JXL lossy: expect ≤3% channel error. A failure here usually indicates
    // a channel-count mismatch (wrong stride) or colorspace confusion at the FFI boundary.
    assert!(max_err < 0.03, "max sRGB channel error {max_err:.4} — channel-count or colorspace mismatch at libjxl boundary");
}

#[test]
fn progressive_dc2_center_out_decodes_with_oxide() {
    let rgba = gradient(512, 384);
    let v =
        encode_variants_with_progressive(&rgba, 512, 384, SourceType::Raw, false, 2, 1).unwrap();
    let img = JxlImage::builder()
        .read(v.full.as_slice())
        .expect("oxide parse progressive");
    let render = img.render_frame(0).expect("oxide decode progressive");
    assert_eq!(img.width(), 512);
    assert_eq!(img.height(), 384);
    let _ = render.image_all_channels();
}

#[test]
fn ct5_encode_variants_from_rgb16_smoke() {
    let (w, h) = (64, 64);
    let mut rgb16 = vec![0u16; (w * h * 3) as usize];
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 3) as usize;
            rgb16[i] = (x * 4 * 256) as u16;
            rgb16[i + 1] = (y * 4 * 256) as u16;
            rgb16[i + 2] = ((x + y) * 2 * 256) as u16;
        }
    }
    let params = raw_pipeline::pipeline::PipelineParams::default_olympus();
    let v = raw_pipeline::casabio_encode::encode_variants_from_rgb16(
        &rgb16,
        &params,
        w,
        h,
        SourceType::Raw,
        false,
    )
    .unwrap();

    let img_full = JxlImage::builder()
        .read(v.full.as_slice())
        .expect("oxide parse");
    let _ = img_full.render_frame(0).expect("oxide decode");
    assert_eq!(img_full.width(), 64);
    assert_eq!(img_full.height(), 64);
}

#[test]
#[ignore = "jxl-oxide partial-input API not yet exercised; truncated-stream safety surface unverified"]
fn ct6_progressive_dc2_truncated_stream() {
    // TODO: feed a truncated JXL bitstream to jxl-oxide's chunked reader and assert it does
    // not panic. The oxide partial-input API requires explicit NeedMoreData handling and
    // knowledge of DC frame byte boundaries — implement once those are stable.
    let rgba = gradient(64, 64);
    let v = encode_variants_with_progressive(&rgba, 64, 64, SourceType::Jpeg, false, 2, 1)
        .expect("encode progressive");
    // Truncate to ~25% of the bitstream — must not panic (may return an error).
    let truncated = &v.full[..v.full.len() / 4];
    let result = std::panic::catch_unwind(|| {
        let _ = JxlImage::builder().read(truncated);
    });
    assert!(result.is_ok(), "jxl-oxide panicked on truncated input");
}
