//! Pure-Rust decoders for already-developed RGB image formats (TIFF, EXR),
//! built on the `image` crate already in raw-pipeline's deps. Distinct from
//! `tiff.rs`, which parses RAW (Bayer) TIFF containers. Output is always RGBA.

use image::DynamicImage;
use std::io::Cursor;

/// Maximum pixel count accepted from an untrusted developed-image header before
/// decoding, mirroring fast-jpeg's decompression-bomb guard. 400 MP is well above
/// any real photographic source while bounding the worst-case ingest allocation
/// (EXR is 16 B/px RGBA f32 → ~6.4 GB at the cap, so callers on wasm32 should pick
/// a tighter budget; native hosts decode lazily). The guard rejects a hostile
/// "small file, gigantic dimensions" header before any large buffer is allocated.
pub const MAX_INGEST_PIXELS: u64 = 400_000_000;

#[derive(thiserror::Error, Debug)]
pub enum ImageFormatError {
    #[error("image decode failed: {0}")]
    Decode(String),
    #[error("image too large: {0}x{1} ({2} px) exceeds the {3} px ingest budget")]
    TooLarge(u32, u32, u64, u64),
}

/// True when `width*height` exceeds the ingest pixel budget. Pure so the boundary
/// is unit-testable without constructing a multi-gigapixel fixture.
#[inline]
fn exceeds_pixel_budget(width: u32, height: u32) -> bool {
    (width as u64).saturating_mul(height as u64) > MAX_INGEST_PIXELS
}

/// Read just the header to get dimensions, then reject decompression bombs before
/// the full decode allocates. Cheap: header parse only, no pixel decode.
fn guard_dimensions(bytes: &[u8], fmt: image::ImageFormat) -> Result<(), ImageFormatError> {
    let (w, h) = image::ImageReader::with_format(Cursor::new(bytes), fmt)
        .into_dimensions()
        .map_err(|e| ImageFormatError::Decode(e.to_string()))?;
    if exceeds_pixel_budget(w, h) {
        return Err(ImageFormatError::TooLarge(
            w,
            h,
            (w as u64).saturating_mul(h as u64),
            MAX_INGEST_PIXELS,
        ));
    }
    Ok(())
}

/// RGBA pixel buffer at a single bit depth. Exactly one of u8/u16/f32 is set.
#[derive(Default)]
pub struct DecodedRgba {
    pub width: u32,
    pub height: u32,
    pub bit_depth: u8,
    pub u8: Vec<u8>,
    pub u16: Vec<u16>,
    pub f32: Vec<f32>,
}

/// Decode a general RGB(A) TIFF. 16-bit files keep 16 bits; everything else
/// collapses to RGBA8.
pub fn decode_tiff_bytes(bytes: &[u8]) -> Result<DecodedRgba, ImageFormatError> {
    guard_dimensions(bytes, image::ImageFormat::Tiff)?;
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Tiff)
        .map_err(|e| ImageFormatError::Decode(e.to_string()))?;
    Ok(dynamic_to_rgba(img))
}

/// Decode an OpenEXR image to interleaved RGBA f32 (linear, scene-referred).
/// HDR values above 1.0 are preserved.
pub fn decode_exr_bytes(bytes: &[u8]) -> Result<DecodedRgba, ImageFormatError> {
    guard_dimensions(bytes, image::ImageFormat::OpenExr)?;
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::OpenExr)
        .map_err(|e| ImageFormatError::Decode(e.to_string()))?;
    let (width, height) = (img.width(), img.height());
    let rgba = img.to_rgba32f();
    Ok(DecodedRgba {
        width,
        height,
        bit_depth: 32,
        f32: rgba.into_raw(),
        ..Default::default()
    })
}

/// Decode a baseline/progressive JPEG to RGBA8. JPEG is always 8-bit, so the
/// output is RGBA8 (bit_depth == 8). Mirrors `decode_tiff_bytes`; rides the same
/// `image` crate (jpeg feature already enabled in Cargo.toml) and the shared
/// decompression-bomb guard.
pub fn decode_jpeg_bytes(bytes: &[u8]) -> Result<DecodedRgba, ImageFormatError> {
    guard_dimensions(bytes, image::ImageFormat::Jpeg)?;
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg)
        .map_err(|e| ImageFormatError::Decode(e.to_string()))?;
    Ok(dynamic_to_rgba(img))
}

/// Pick 16-bit output when the source is >8-bit, else 8-bit. Always RGBA.
fn dynamic_to_rgba(img: DynamicImage) -> DecodedRgba {
    let (width, height) = (img.width(), img.height());
    let sixteen = matches!(
        img.color(),
        image::ColorType::L16
            | image::ColorType::La16
            | image::ColorType::Rgb16
            | image::ColorType::Rgba16
    );
    if sixteen {
        let rgba = img.to_rgba16();
        DecodedRgba {
            width,
            height,
            bit_depth: 16,
            u16: rgba.into_raw(),
            ..Default::default()
        }
    } else {
        let rgba = img.to_rgba8();
        DecodedRgba {
            width,
            height,
            bit_depth: 8,
            u8: rgba.into_raw(),
            ..Default::default()
        }
    }
}

/// Convert interleaved RGBA f32 (linear) to RGBA8 for display/preview.
/// Colour channels get the sRGB OETF; alpha is linear-scaled. HDR clamps to 1.0.
///
/// The OETF is evaluated through the shared cached 16384-entry sRGB-encode LUT
/// (`pipeline::srgb_encode_lerp`) instead of a per-channel `powf`: ~88% faster on a
/// 12 MP buffer (examples/srgb8_lut_flip.rs). The lerp matches the `powf` build to
/// ≤1 u8 LSB (~4e-4 % of channels cross a u8 rounding boundary) — sub-perceptual for
/// a display preview path; endpoints (0 / 255) and the HDR clamp are exact.
pub fn f32_linear_to_srgb8(rgba_f32: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba_f32.len());
    for px in rgba_f32.chunks_exact(4) {
        for &c in &px[..3] {
            let s = crate::pipeline::srgb_encode_lerp(c); // clamps [0,1] internally
            out.push((s * 255.0 + 0.5) as u8);
        }
        out.push((px[3].clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2x1 RGB8 TIFF, red then green, encoded by the image crate itself.
    fn make_rgb8_tiff() -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        let img = image::RgbImage::from_raw(2, 1, vec![255, 0, 0, 0, 255, 0]).unwrap();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, image::ImageFormat::Tiff)
            .unwrap();
        buf.into_inner()
    }

    fn make_rgb16_tiff() -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        let img: image::ImageBuffer<image::Rgb<u16>, Vec<u16>> =
            image::ImageBuffer::from_raw(1, 1, vec![65535, 1000, 0]).unwrap();
        image::DynamicImage::ImageRgb16(img)
            .write_to(&mut buf, image::ImageFormat::Tiff)
            .unwrap();
        buf.into_inner()
    }

    fn make_rgba32f_exr() -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        // one HDR pixel above 1.0 to prove float range survives
        let img: image::ImageBuffer<image::Rgba<f32>, Vec<f32>> =
            image::ImageBuffer::from_raw(1, 1, vec![4.0, 0.5, 0.0, 1.0]).unwrap();
        image::DynamicImage::ImageRgba32F(img)
            .write_to(&mut buf, image::ImageFormat::OpenExr)
            .unwrap();
        buf.into_inner()
    }

    #[test]
    fn decode_tiff_rgb8_to_rgba8() {
        let d = decode_tiff_bytes(&make_rgb8_tiff()).unwrap();
        assert_eq!((d.width, d.height, d.bit_depth), (2, 1, 8));
        assert_eq!(&d.u8[..8], &[255, 0, 0, 255, 0, 255, 0, 255]); // R, A=255, G, A=255
        assert!(d.u16.is_empty() && d.f32.is_empty());
    }

    #[test]
    fn decode_tiff_rgb16_keeps_16bit() {
        let d = decode_tiff_bytes(&make_rgb16_tiff()).unwrap();
        assert_eq!(d.bit_depth, 16);
        assert_eq!(&d.u16[..4], &[65535, 1000, 0, 65535]); // R G B, A=65535
    }

    #[test]
    fn decode_exr_keeps_f32_hdr() {
        let d = decode_exr_bytes(&make_rgba32f_exr()).unwrap();
        assert_eq!((d.width, d.height, d.bit_depth), (1, 1, 32));
        assert!(
            (d.f32[0] - 4.0).abs() < 1e-4,
            "HDR value >1.0 must survive: {}",
            d.f32[0]
        );
        assert!((d.f32[3] - 1.0).abs() < 1e-4);
    }

    #[test]
    fn f32_linear_to_srgb8_maps_and_clamps() {
        // linear 0 -> 0; linear 1 -> 255; linear >1 clamps to 255; alpha passes through scaled.
        let lin = [0.0_f32, 1.0, 4.0, 1.0, 0.5, 0.5, 0.5, 0.25];
        let out = f32_linear_to_srgb8(&lin);
        assert_eq!(out[0], 0);
        assert_eq!(out[1], 255);
        assert_eq!(out[2], 255); // HDR clamp
        assert_eq!(out[3], 255); // alpha 1.0 -> 255
                                 // sRGB(0.5 linear) ~ 0.7353 -> ~188
        assert!((out[4] as i32 - 188).abs() <= 1, "got {}", out[4]);
        assert_eq!(out[7], 64); // alpha 0.25 -> 64 (linear, no sRGB on alpha)
    }

    // Small RGB JPEG encoded by the image crate itself (baseline).
    fn make_jpeg(w: u32, h: u32) -> Vec<u8> {
        let mut img = image::RgbImage::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = image::Rgb([(x % 256) as u8, (y % 256) as u8, 128]);
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, image::ImageFormat::Jpeg)
            .expect("encode jpeg fixture");
        buf.into_inner()
    }

    #[test]
    fn decode_jpeg_bytes_returns_rgba8() {
        let jpeg = make_jpeg(16, 12);
        let d = decode_jpeg_bytes(&jpeg).expect("decode jpeg");
        assert_eq!((d.width, d.height, d.bit_depth), (16, 12, 8));
        assert_eq!(d.u8.len(), 16 * 12 * 4); // RGBA
        assert!(d.u16.is_empty() && d.f32.is_empty());
    }

    #[test]
    fn decode_jpeg_bytes_rejects_garbage() {
        assert!(decode_jpeg_bytes(&[0, 1, 2, 3, 4, 5]).is_err());
    }
}
