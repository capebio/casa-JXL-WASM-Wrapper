//! Pure-Rust decoders for already-developed RGB image formats (TIFF, EXR),
//! built on the `image` crate already in raw-pipeline's deps. Distinct from
//! `tiff.rs`, which parses RAW (Bayer) TIFF containers. Output is always RGBA.

use image::{DynamicImage, ImageDecoder};
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
    /// A header limit was exceeded at preflight, BEFORE any pixel buffer was
    /// allocated. `what` names the limit (e.g. "pixels", "output_bytes"),
    /// `got`/`limit` are the offending value and the ceiling.
    #[error("developed image rejected: {what} {got} exceeds limit {limit}")]
    LimitExceeded {
        what: &'static str,
        got: u64,
        limit: u64,
    },
}

/// Which developed-image container a header probe / decode targets. Selected by
/// the caller (mirrors the wasm `decode_tiff`/`decode_exr`/`decode_jpeg` entry
/// points) so the probe reads the correct format's structured metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevelopedFormat {
    Tiff,
    Exr,
    Jpeg,
}

/// Sample representation carried by a developed image, derived from the header's
/// colour type — NOT by decoding pixels. Drives the per-pixel output byte cost.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleRepr {
    /// 8-bit unsigned per channel (JPEG, 8-bit TIFF).
    U8,
    /// 16-bit unsigned per channel (16-bit TIFF).
    U16,
    /// 32-bit float per channel (EXR, linear HDR).
    F32,
}

impl SampleRepr {
    /// Bytes for one RGBA pixel at this representation (the decoders always emit
    /// RGBA, so the output cost is 4 channels wide regardless of source channels).
    #[inline]
    pub fn rgba_bytes_per_pixel(self) -> u64 {
        match self {
            SampleRepr::U8 => 4,
            SampleRepr::U16 => 8,
            SampleRepr::F32 => 16,
        }
    }
}

/// Structured, decode-free view of a developed-image header: format, dimensions,
/// channel count, sample representation, and the CHECKED (saturating) count of
/// bytes the RGBA decode will materialize. Produced by `probe_developed_header`
/// and consumed by `DecodeLimits::check` so callers reject before allocating.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeaderProbe {
    pub format: DevelopedFormat,
    pub width: u32,
    pub height: u32,
    /// Channels present in the SOURCE header (informational). The materialized
    /// output is always RGBA; `output_bytes` reflects that.
    pub channels: u8,
    pub sample: SampleRepr,
    /// `width * height * rgba_bytes_per_pixel(sample)`, saturating. This is the
    /// exact size of the buffer `dynamic_to_rgba` / the EXR path will allocate.
    pub output_bytes: u64,
}

/// Explicit resource ceilings for an untrusted developed-image decode. Owned by
/// the preflight (Finding 59); consumers reject BEFORE allocating or decoding
/// when any limit is exceeded. Two named profiles exist: [`DecodeLimits::wasm`]
/// (tight, sized to the 2 GiB shared wasm heap) and [`DecodeLimits::native`]
/// (loose, host RAM bound).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeLimits {
    /// Maximum accepted COMPRESSED input length in bytes.
    pub max_input_bytes: u64,
    /// Maximum accepted image width in pixels.
    pub max_width: u32,
    /// Maximum accepted image height in pixels.
    pub max_height: u32,
    /// Maximum accepted `width * height`.
    pub max_pixels: u64,
    /// Maximum accepted DECODED RGBA output size in bytes — the decompression-bomb
    /// guard for "tiny compressed, gigantic decoded" inputs.
    pub max_output_bytes: u64,
}

impl DecodeLimits {
    /// Tight profile for the browser/wasm32 build. Sized so the peak working set
    /// (input container + decoder intermediate ≈ output-sized + RGBA output +
    /// safety margin) stays under the 2 GiB shared-memory ceiling declared by
    /// `tools/build-mt-wasm.sh` (`--max-memory=2G`).
    ///
    /// Budget arithmetic (worst case = 2×output + input + margin):
    ///   input 256 MiB + 2·output 512 MiB + margin 256 MiB = 1536 MiB ≤ 2048 MiB.
    ///
    /// `max_output_bytes` is the governing constraint for HDR EXR (16 B/px):
    /// 512 MiB / 16 = 32 MP for f32, / 8 = 64 MP for u16 TIFF, / 4 = 128 MP for
    /// u8 JPEG — each capped by the same output-byte ceiling at its own depth.
    pub const fn wasm() -> Self {
        DecodeLimits {
            max_input_bytes: 256 * 1024 * 1024,   // 256 MiB
            max_width: 30_000,
            max_height: 30_000,
            max_pixels: 100_000_000,              // 100 MP dimension guard
            max_output_bytes: 512 * 1024 * 1024,  // 512 MiB decoded RGBA
        }
    }

    /// Loose profile for native hosts (host RAM bound, not the wasm heap). Still
    /// rejects absurd / overflowing headers but permits large legitimate images.
    pub const fn native() -> Self {
        DecodeLimits {
            max_input_bytes: 4 * 1024 * 1024 * 1024, // 4 GiB
            max_width: 100_000,
            max_height: 100_000,
            max_pixels: MAX_INGEST_PIXELS,           // 400 MP (matches legacy guard)
            max_output_bytes: 8 * 1024 * 1024 * 1024, // 8 GiB decoded RGBA
        }
    }

    /// Reject when the input length or the probed header exceeds any ceiling.
    /// Pure: no allocation, no decode. Returns the FIRST violated limit.
    pub fn check(&self, probe: &HeaderProbe, input_len: u64) -> Result<(), ImageFormatError> {
        if input_len > self.max_input_bytes {
            return Err(ImageFormatError::LimitExceeded {
                what: "input_bytes",
                got: input_len,
                limit: self.max_input_bytes,
            });
        }
        if probe.width > self.max_width {
            return Err(ImageFormatError::LimitExceeded {
                what: "width",
                got: probe.width as u64,
                limit: self.max_width as u64,
            });
        }
        if probe.height > self.max_height {
            return Err(ImageFormatError::LimitExceeded {
                what: "height",
                got: probe.height as u64,
                limit: self.max_height as u64,
            });
        }
        let pixels = (probe.width as u64).saturating_mul(probe.height as u64);
        if pixels > self.max_pixels {
            return Err(ImageFormatError::LimitExceeded {
                what: "pixels",
                got: pixels,
                limit: self.max_pixels,
            });
        }
        if probe.output_bytes > self.max_output_bytes {
            return Err(ImageFormatError::LimitExceeded {
                what: "output_bytes",
                got: probe.output_bytes,
                limit: self.max_output_bytes,
            });
        }
        Ok(())
    }
}

/// Map an `image::ColorType` header colour type to (channels, sample-repr) using
/// the decoder's structured metadata — never a pixel decode. Anything not RGB(A)
/// still reports its native depth; the decoders up-convert to RGBA on decode.
fn color_type_to_repr(ct: image::ColorType) -> (u8, SampleRepr) {
    use image::ColorType::*;
    let channels = ct.channel_count();
    let sample = match ct {
        L8 | La8 | Rgb8 | Rgba8 => SampleRepr::U8,
        L16 | La16 | Rgb16 | Rgba16 => SampleRepr::U16,
        Rgb32F | Rgba32F => SampleRepr::F32,
        // Future-proof: any other colour type the image crate adds — treat as the
        // widest (f32) so the output-byte guard over-reserves rather than under.
        _ => SampleRepr::F32,
    };
    (channels, sample)
}

/// Read a developed-image header WITHOUT decoding pixels: construct the format's
/// decoder (which parses only the header/metadata), then read its dimensions and
/// colour type from the structured `ImageDecoder` API. Computes the CHECKED
/// (saturating) RGBA output-byte cost. This is the preflight probe consumers use
/// with [`DecodeLimits::check`] before allocating.
pub fn probe_developed_header(
    bytes: &[u8],
    fmt: DevelopedFormat,
) -> Result<HeaderProbe, ImageFormatError> {
    let map = |e: image::ImageError| ImageFormatError::Decode(e.to_string());
    let ((w, h), ct) = match fmt {
        DevelopedFormat::Tiff => {
            let d = image::codecs::tiff::TiffDecoder::new(Cursor::new(bytes)).map_err(map)?;
            (d.dimensions(), d.color_type())
        }
        DevelopedFormat::Exr => {
            let d = image::codecs::openexr::OpenExrDecoder::new(Cursor::new(bytes)).map_err(map)?;
            (d.dimensions(), d.color_type())
        }
        DevelopedFormat::Jpeg => {
            let d = image::codecs::jpeg::JpegDecoder::new(Cursor::new(bytes)).map_err(map)?;
            (d.dimensions(), d.color_type())
        }
    };
    let (channels, sample) = color_type_to_repr(ct);
    let output_bytes = (w as u64)
        .saturating_mul(h as u64)
        .saturating_mul(sample.rgba_bytes_per_pixel());
    Ok(HeaderProbe {
        format: fmt,
        width: w,
        height: h,
        channels,
        sample,
        output_bytes,
    })
}

/// Read just the header to get dimensions, then reject decompression bombs before
/// the full decode allocates. Cheap: header parse only, no pixel decode. Uses the
/// legacy [`MAX_INGEST_PIXELS`] cap so the existing unlimited entry points keep
/// their prior behaviour; the byte-based [`DecodeLimits`] path is opt-in via the
/// `*_limited` decoders.
fn guard_dimensions(bytes: &[u8], fmt: image::ImageFormat) -> Result<(), ImageFormatError> {
    let (w, h) = image::ImageReader::with_format(Cursor::new(bytes), fmt)
        .into_dimensions()
        .map_err(|e| ImageFormatError::Decode(e.to_string()))?;
    if (w as u64).saturating_mul(h as u64) > MAX_INGEST_PIXELS {
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

/// sRGB EOTF (gamma-encoded → linear) for a single normalised channel value in
/// `[0, 1]`. Analytic, evaluated in `f64` — a *byte-exact* mirror of the worker's
/// `srgbToLinear` (`web/worker.js`), whose `Math.pow((c+0.055)/1.055, 2.4)` is an
/// IEEE-754 double `pow`. Used by the resident RGB16-LE conversion so the WASM
/// path reproduces the legacy JS `decodedToLinearRgb16` bit-for-bit.
#[inline]
fn srgb_to_linear_f64(c: f64) -> f64 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Clamp a linear value already scaled into the u16 range to `[0, 65535]`, then
/// truncate toward zero — the exact semantics of the worker's
/// `clamp16(v) = (v<0?0:v>65535?65535:v)|0`. `|0` is a truncating cast, so the
/// caller must have added the `+0.5` rounding bias BEFORE calling this (matching
/// JS). Input/compute in `f64` for bit-parity with the JS path.
#[inline]
fn clamp16_trunc(v: f64) -> u16 {
    if v < 0.0 {
        0
    } else if v > 65535.0 {
        65535
    } else {
        // `as u16` truncates toward zero; v is in [0, 65535] here.
        v as u16
    }
}

impl DecodedRgba {
    /// Convert the decoded RGBA pixels to the packed **linear RGB16-LE** buffer
    /// (6 bytes/pixel, alpha dropped) that `LookRenderer` consumes — the same
    /// format the RAW pipeline feeds it. This is the RESIDENT conversion: it runs
    /// entirely inside wasm linear memory (finding 58), replacing the legacy
    /// `take_* → JS decodedToLinearRgb16 → LookRenderer.new_with_options`
    /// round trip that copied the full pixel buffer WASM→JS then JS→WASM.
    ///
    /// Per bit depth (byte-exact mirror of `web/worker.js decodedToLinearRgb16`):
    /// - **32 (EXR, linear f32):** `clamp16(chan * 65535 + 0.5)` — no EOTF, the
    ///   source is already linear scene-referred. HDR >1.0 clamps to 65535.
    /// - **16 (TIFF, sRGB u16):** `srgbToLinear(u16/65535)` then the same scale
    ///   + round + clamp. The worker's u16 path uses the ANALYTIC `srgbToLinear`
    ///   (an f64 `Math.pow`), so the full-`f64` computation here matches it exactly.
    /// - **8 (JPEG / 8-bit TIFF, sRGB u8):** the worker reads a precomputed 256-entry
    ///   `Float32Array` LUT (`SRGB_TO_LINEAR_U8[i] = (f32)srgbToLinear(i/255)`), so
    ///   the linear value is ROUNDED TO f32 before the `* 65535 + 0.5`. We mirror
    ///   that with an explicit `as f32 as f64` round-trip so the bytes match the LUT
    ///   path bit-for-bit (the full-f64 value would be within ≤1 u16 LSB and, for
    ///   these 256 sRGB values, never actually differs — but the explicit f32 round
    ///   keeps the mirror literal and robust).
    ///
    /// All intermediate arithmetic is `f64` to match V8's Number semantics, so the
    /// produced bytes are identical to the JS path (verified in
    /// `tests/resident_image_pipeline.rs`). Consuming: takes `&self` and returns a
    /// fresh owned buffer; the source pixels are left intact so a caller can still
    /// fall back to a `take_*` escape hatch.
    pub fn to_linear_rgb16_le(&self) -> Vec<u8> {
        let px = (self.width as usize).saturating_mul(self.height as usize);
        let mut out = vec![0u8; px.saturating_mul(6)];
        match self.bit_depth {
            32 => {
                for (i, chunk) in out.chunks_exact_mut(6).enumerate() {
                    let s = i * 4;
                    let r = clamp16_trunc(self.f32[s] as f64 * 65535.0 + 0.5);
                    let g = clamp16_trunc(self.f32[s + 1] as f64 * 65535.0 + 0.5);
                    let b = clamp16_trunc(self.f32[s + 2] as f64 * 65535.0 + 0.5);
                    chunk[0..2].copy_from_slice(&r.to_le_bytes());
                    chunk[2..4].copy_from_slice(&g.to_le_bytes());
                    chunk[4..6].copy_from_slice(&b.to_le_bytes());
                }
            }
            16 => {
                for (i, chunk) in out.chunks_exact_mut(6).enumerate() {
                    let s = i * 4;
                    let r = clamp16_trunc(
                        srgb_to_linear_f64(self.u16[s] as f64 / 65535.0) * 65535.0 + 0.5,
                    );
                    let g = clamp16_trunc(
                        srgb_to_linear_f64(self.u16[s + 1] as f64 / 65535.0) * 65535.0 + 0.5,
                    );
                    let b = clamp16_trunc(
                        srgb_to_linear_f64(self.u16[s + 2] as f64 / 65535.0) * 65535.0 + 0.5,
                    );
                    chunk[0..2].copy_from_slice(&r.to_le_bytes());
                    chunk[2..4].copy_from_slice(&g.to_le_bytes());
                    chunk[4..6].copy_from_slice(&b.to_le_bytes());
                }
            }
            _ => {
                // Mirror the worker's `Float32Array` sRGB→linear LUT: round the
                // linear value to f32 (as the LUT store does) before scaling.
                let lut8 = |v: u8| -> f64 {
                    (srgb_to_linear_f64(v as f64 / 255.0) as f32) as f64
                };
                for (i, chunk) in out.chunks_exact_mut(6).enumerate() {
                    let s = i * 4;
                    let r = clamp16_trunc(lut8(self.u8[s]) * 65535.0 + 0.5);
                    let g = clamp16_trunc(lut8(self.u8[s + 1]) * 65535.0 + 0.5);
                    let b = clamp16_trunc(lut8(self.u8[s + 2]) * 65535.0 + 0.5);
                    chunk[0..2].copy_from_slice(&r.to_le_bytes());
                    chunk[2..4].copy_from_slice(&g.to_le_bytes());
                    chunk[4..6].copy_from_slice(&b.to_le_bytes());
                }
            }
        }
        out
    }
}

/// Box-filter downscale of a packed **linear RGB16-LE** buffer (6 B/px), producing
/// another packed RGB16-LE buffer at `dw × dh`. This is a *byte-exact* mirror of
/// the worker's `downscaleRgb16LE` (`web/worker.js`) so the resident developed-image
/// path can generate the lightbox / thumbnail preview buffers inside wasm — the full
/// pixels never cross the boundary (finding 58) — while every produced byte matches
/// the legacy JS downscale.
///
/// Parity-critical details (each mirrors the JS integer arithmetic, NOT the
/// float-ratio box used by `downscale_rgb16_impl`, which rounds differently):
/// - Source-span boundaries use INTEGER math:
///   `sx0 = (dx*sw)/dw`, `sx1 = max(sx0+1, ((dx+1)*sw)/dw)` (and likewise for y),
///   matching JS `Math.floor(dx*sw/dw)` on integer operands.
/// - Channel averages truncate toward zero: `(sum/n)|0` → integer `sum/n`.
/// - Identity when `dw==sw && dh==sh` (JS returns the source unchanged).
pub fn downscale_linear_rgb16_le_js_parity(
    src: &[u8],
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
) -> Vec<u8> {
    if dw == sw && dh == sh {
        return src.to_vec();
    }
    let mut out = vec![0u8; dw * dh * 6];
    let get = |o: usize| u16::from_le_bytes([src[o], src[o + 1]]) as u64;
    for dy in 0..dh {
        let sy0 = (dy * sh) / dh;
        let sy1 = ((dy + 1) * sh / dh).max(sy0 + 1);
        for dx in 0..dw {
            let sx0 = (dx * sw) / dw;
            let sx1 = ((dx + 1) * sw / dw).max(sx0 + 1);
            let (mut rr, mut gg, mut bb, mut n) = (0u64, 0u64, 0u64, 0u64);
            for sy in sy0..sy1 {
                let mut so = (sy * sw + sx0) * 6;
                for _sx in sx0..sx1 {
                    rr += get(so);
                    gg += get(so + 2);
                    bb += get(so + 4);
                    n += 1;
                    so += 6;
                }
            }
            let o = (dy * dw + dx) * 6;
            let r = (rr / n) as u16;
            let g = (gg / n) as u16;
            let b = (bb / n) as u16;
            out[o..o + 2].copy_from_slice(&r.to_le_bytes());
            out[o + 2..o + 4].copy_from_slice(&g.to_le_bytes());
            out[o + 4..o + 6].copy_from_slice(&b.to_le_bytes());
        }
    }
    out
}

/// Long-edge clamp, aspect-preserving, no upscale — a byte-exact mirror of the
/// worker's `targetDims` (and `src/lib.rs target_dims`). Returned as `(w, h)`.
pub fn target_dims_js_parity(w: u32, h: u32, long_edge: u32) -> (u32, u32) {
    if w >= h {
        let lw = w.min(long_edge);
        (lw, 1.max((h as u64 * lw as u64 / w as u64) as u32))
    } else {
        let lh = h.min(long_edge);
        (1.max((w as u64 * lh as u64 / h as u64) as u32), lh)
    }
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

/// Preflight-gated TIFF decode: probe the header, reject via `limits` BEFORE any
/// pixel buffer is allocated, then decode. The preferred entry point for
/// untrusted input; `decode_tiff_bytes` remains for the legacy unguarded path.
pub fn decode_tiff_bytes_limited(
    bytes: &[u8],
    limits: &DecodeLimits,
) -> Result<DecodedRgba, ImageFormatError> {
    let probe = probe_developed_header(bytes, DevelopedFormat::Tiff)?;
    limits.check(&probe, bytes.len() as u64)?;
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Tiff)
        .map_err(|e| ImageFormatError::Decode(e.to_string()))?;
    Ok(dynamic_to_rgba(img))
}

/// Preflight-gated EXR decode. See [`decode_tiff_bytes_limited`].
pub fn decode_exr_bytes_limited(
    bytes: &[u8],
    limits: &DecodeLimits,
) -> Result<DecodedRgba, ImageFormatError> {
    let probe = probe_developed_header(bytes, DevelopedFormat::Exr)?;
    limits.check(&probe, bytes.len() as u64)?;
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

/// Preflight-gated JPEG decode. See [`decode_tiff_bytes_limited`].
pub fn decode_jpeg_bytes_limited(
    bytes: &[u8],
    limits: &DecodeLimits,
) -> Result<DecodedRgba, ImageFormatError> {
    let probe = probe_developed_header(bytes, DevelopedFormat::Jpeg)?;
    limits.check(&probe, bytes.len() as u64)?;
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
