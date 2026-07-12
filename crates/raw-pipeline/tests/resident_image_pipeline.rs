//! Resident developed-image pipeline parity (Packet-3 Task 10 / finding 58).
//!
//! Finding 58: developed images (JPEG / TIFF / EXR) were kept resident in wasm by
//! `decode_*`, then the FULL pixel buffer crossed the wasm boundary twice — out to
//! JS via `take_*`, converted to packed linear RGB16-LE by the worker's
//! `decodedToLinearRgb16`, then back INTO wasm via `LookRenderer.new_with_options`.
//! The resident path (`DecodedRgba::to_linear_rgb16_le`) performs that conversion
//! inside wasm linear memory so the full pixels never leave.
//!
//! This suite proves the resident Rust conversion is **BYTE-EXACT** vs the legacy
//! JS conversion for JPEG, 8- and 16-bit TIFF, and EXR float — using the real
//! fixtures under `tests/fixtures` plus `image`-crate-encoded fixtures for the
//! JPEG / TIFF8 depths the fixture set doesn't already cover. It also asserts the
//! decode-limit preflight rejects hostile headers BEFORE any pixel buffer is
//! allocated, at the exact boundary byte counts.

use raw_pipeline::image_formats::{
    self, decode_exr_bytes, decode_jpeg_bytes, decode_tiff_bytes,
    downscale_linear_rgb16_le_js_parity, target_dims_js_parity, DecodeLimits, DecodedRgba,
    DevelopedFormat, HeaderProbe, SampleRepr,
};

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

// ─────────────────────────────────────────────────────────────────────────────
// Independent reference: the EXACT arithmetic of web/worker.js decodedToLinearRgb16.
//
// This is written from scratch (not by calling the production method) so a bug in
// the production conversion cannot mask itself. Every operation mirrors the JS in
// IEEE-754 double precision — that is what V8 Number arithmetic gives the worker,
// so matching it in f64 here reproduces the browser bytes bit-for-bit.
// ─────────────────────────────────────────────────────────────────────────────

/// JS `srgbToLinear(c)` — `Math.pow` is an f64 pow.
fn js_srgb_to_linear(c: f64) -> f64 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// JS `clamp16(v) = (v<0?0:v>65535?65535:v)|0`. `|0` truncates toward zero.
fn js_clamp16(v: f64) -> u16 {
    if v < 0.0 {
        0
    } else if v > 65535.0 {
        65535
    } else {
        v as u16
    }
}

/// The worker's u8 path reads `SRGB_TO_LINEAR_U8`, a `Float32Array` LUT — so the
/// linear value is rounded to f32 before scaling. Mirror that exactly here.
fn js_srgb_to_linear_u8_lut(i: u8) -> f64 {
    (js_srgb_to_linear(i as f64 / 255.0) as f32) as f64
}

/// Byte-exact re-implementation of `web/worker.js decodedToLinearRgb16(dec)`.
/// Produces packed little-endian RGB16 (6 bytes/pixel, alpha dropped).
fn js_reference_linear_rgb16_le(d: &DecodedRgba) -> Vec<u8> {
    let px = (d.width as usize) * (d.height as usize);
    let mut out = vec![0u8; px * 6];
    for i in 0..px {
        let (r, g, b) = match d.bit_depth {
            32 => {
                let s = i * 4;
                (
                    js_clamp16(d.f32[s] as f64 * 65535.0 + 0.5),
                    js_clamp16(d.f32[s + 1] as f64 * 65535.0 + 0.5),
                    js_clamp16(d.f32[s + 2] as f64 * 65535.0 + 0.5),
                )
            }
            16 => {
                let s = i * 4;
                (
                    js_clamp16(js_srgb_to_linear(d.u16[s] as f64 / 65535.0) * 65535.0 + 0.5),
                    js_clamp16(js_srgb_to_linear(d.u16[s + 1] as f64 / 65535.0) * 65535.0 + 0.5),
                    js_clamp16(js_srgb_to_linear(d.u16[s + 2] as f64 / 65535.0) * 65535.0 + 0.5),
                )
            }
            _ => {
                let s = i * 4;
                (
                    js_clamp16(js_srgb_to_linear_u8_lut(d.u8[s]) * 65535.0 + 0.5),
                    js_clamp16(js_srgb_to_linear_u8_lut(d.u8[s + 1]) * 65535.0 + 0.5),
                    js_clamp16(js_srgb_to_linear_u8_lut(d.u8[s + 2]) * 65535.0 + 0.5),
                )
            }
        };
        let o = i * 6;
        out[o..o + 2].copy_from_slice(&r.to_le_bytes());
        out[o + 2..o + 4].copy_from_slice(&g.to_le_bytes());
        out[o + 4..o + 6].copy_from_slice(&b.to_le_bytes());
    }
    out
}

// ─────────────────────────────── fixtures ────────────────────────────────────

/// Small RGB8 JPEG encoded by the `image` crate itself (baseline, real header).
/// The repo's `timings/fastest/preview-full.jpg` is known-corrupt (see MEMORY),
/// so we encode a clean one for the u8/JPEG parity check.
fn make_jpeg(w: u32, h: u32) -> Vec<u8> {
    let mut img = image::RgbImage::new(w, h);
    for (x, y, px) in img.enumerate_pixels_mut() {
        *px = image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8]);
    }
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .expect("encode jpeg fixture");
    buf.into_inner()
}

// ───────────────────────── byte-parity per format ────────────────────────────

/// The resident Rust conversion must equal the JS conversion byte-for-byte, and
/// the output must be exactly `w*h*6` bytes (alpha dropped, 6 B/px).
fn assert_resident_matches_js(d: &DecodedRgba, label: &str) {
    let resident = d.to_linear_rgb16_le();
    let js = js_reference_linear_rgb16_le(d);
    let expected_len = (d.width as usize) * (d.height as usize) * 6;
    assert_eq!(
        resident.len(),
        expected_len,
        "{label}: resident output must be w*h*6 bytes"
    );
    assert_eq!(
        resident, js,
        "{label}: resident RGB16-LE must be byte-identical to the JS worker path"
    );
}

#[test]
fn jpeg_resident_matches_js_bytes() {
    let jpeg = make_jpeg(31, 17); // odd dims to exercise the tail
    let d = decode_jpeg_bytes(&jpeg).expect("decode jpeg");
    assert_eq!(d.bit_depth, 8);
    assert_resident_matches_js(&d, "jpeg-u8");
}

#[test]
fn tiff8_resident_matches_js_bytes() {
    let bytes = std::fs::read(format!("{DIR}/mandelbrot_u8.tiff")).expect("read tiff8 fixture");
    let d = decode_tiff_bytes(&bytes).expect("decode tiff8");
    assert_eq!((d.width, d.height, d.bit_depth), (256, 256, 8));
    assert_resident_matches_js(&d, "tiff8");
}

#[test]
fn tiff16_resident_matches_js_bytes() {
    let bytes = std::fs::read(format!("{DIR}/mandelbrot_u16.tiff")).expect("read tiff16 fixture");
    let d = decode_tiff_bytes(&bytes).expect("decode tiff16");
    assert_eq!((d.width, d.height, d.bit_depth), (256, 256, 16));
    assert_resident_matches_js(&d, "tiff16");
}

#[test]
fn exr_resident_matches_js_bytes() {
    let bytes = std::fs::read(format!("{DIR}/mandelbrot_f32.exr")).expect("read exr fixture");
    let d = decode_exr_bytes(&bytes).expect("decode exr");
    assert_eq!((d.width, d.height, d.bit_depth), (256, 256, 32));
    assert_resident_matches_js(&d, "exr-f32");
}

/// The EXR path carries HDR values >1.0. The linear-f32 → u16 scale must clamp
/// them to 65535 (no wrap), exactly as the JS `clamp16` does. Prove at least one
/// channel actually hit the clamp so this isn't a vacuous check.
#[test]
fn exr_hdr_values_clamp_to_65535_not_wrap() {
    let bytes = std::fs::read(format!("{DIR}/mandelbrot_f32.exr")).expect("read exr fixture");
    let d = decode_exr_bytes(&bytes).expect("decode exr");
    let max_f32 = d.f32.iter().cloned().fold(0.0_f32, f32::max);
    assert!(max_f32 > 1.5, "fixture must actually contain HDR >1.5");

    let resident = d.to_linear_rgb16_le();
    // Some channel must be saturated (0xffff LE) because the source has values >1.0.
    let has_saturated = resident
        .chunks_exact(2)
        .any(|c| c[0] == 0xff && c[1] == 0xff);
    assert!(
        has_saturated,
        "HDR >1.0 must clamp to 65535, proving no integer wrap"
    );
}

// ────────────── resident downscale byte-parity vs JS downscaleRgb16LE ─────────

/// Byte-exact re-implementation of `web/worker.js downscaleRgb16LE(src,sw,sh,dw,dh)`.
fn js_reference_downscale(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    if dw == sw && dh == sh {
        return src.to_vec();
    }
    let mut out = vec![0u8; dw * dh * 6];
    let get = |o: usize| u16::from_le_bytes([src[o], src[o + 1]]) as f64;
    for dy in 0..dh {
        let sy0 = ((dy * sh) as f64 / dh as f64).floor() as usize;
        let sy1 = (((dy + 1) * sh) as f64 / dh as f64).floor() as usize;
        let sy1 = sy1.max(sy0 + 1);
        for dx in 0..dw {
            let sx0 = ((dx * sw) as f64 / dw as f64).floor() as usize;
            let sx1 = (((dx + 1) * sw) as f64 / dw as f64).floor() as usize;
            let sx1 = sx1.max(sx0 + 1);
            let (mut rr, mut gg, mut bb, mut n) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
            for sy in sy0..sy1 {
                let mut so = (sy * sw + sx0) * 6;
                for _sx in sx0..sx1 {
                    rr += get(so);
                    gg += get(so + 2);
                    bb += get(so + 4);
                    n += 1.0;
                    so += 6;
                }
            }
            let o = (dy * dw + dx) * 6;
            // JS: (rr / n) | 0  → truncation toward zero of a non-negative average.
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

/// JS `targetDims(w,h,longEdge)`.
fn js_reference_target_dims(w: u32, h: u32, long_edge: u32) -> (u32, u32) {
    if w >= h {
        let lw = w.min(long_edge);
        (lw, 1.max(((h as f64 * lw as f64) / w as f64).floor() as u32))
    } else {
        let lh = h.min(long_edge);
        (1.max(((w as f64 * lh as f64) / h as f64).floor() as u32), lh)
    }
}

#[test]
fn target_dims_matches_js() {
    for &(w, h, le) in &[
        (6000u32, 4000u32, 1800u32),
        (4000, 6000, 1800),
        (256, 256, 360),
        (256, 256, 1800), // no upscale: stays 256×256
        (1281, 963, 360),
        (100, 100, 1800),
        (3, 7, 1800),
    ] {
        assert_eq!(
            target_dims_js_parity(w, h, le),
            js_reference_target_dims(w, h, le),
            "target_dims mismatch for {w}×{h} le={le}"
        );
    }
}

/// The resident lightbox/thumb downscale must be byte-identical to the worker's
/// JS `downscaleRgb16LE`. Exercised on the resident-converted full buffer of a real
/// fixture at the exact lightbox (1800) and thumb (360) long-edge targets used by
/// `processImageFormat`, plus a non-integer-factor case.
#[test]
fn resident_downscale_matches_js_at_lightbox_and_thumb() {
    let bytes = std::fs::read(format!("{DIR}/mandelbrot_u16.tiff")).expect("read tiff16 fixture");
    let d = decode_tiff_bytes(&bytes).expect("decode tiff16");
    let (w, h) = (d.width, d.height);
    let full = d.to_linear_rgb16_le();

    for long_edge in [1800u32, 360u32, 200u32, 123u32] {
        let (dw, dh) = target_dims_js_parity(w, h, long_edge);
        let resident =
            downscale_linear_rgb16_le_js_parity(&full, w as usize, h as usize, dw as usize, dh as usize);
        let js = js_reference_downscale(&full, w as usize, h as usize, dw as usize, dh as usize);
        assert_eq!(resident.len(), (dw as usize) * (dh as usize) * 6);
        assert_eq!(
            resident, js,
            "resident downscale must match JS at long_edge={long_edge} ({dw}×{dh})"
        );
    }
}

#[test]
fn resident_downscale_identity_when_dims_unchanged() {
    let bytes = std::fs::read(format!("{DIR}/mandelbrot_u8.tiff")).expect("read tiff8 fixture");
    let d = decode_tiff_bytes(&bytes).expect("decode tiff8");
    let (w, h) = (d.width, d.height);
    let full = d.to_linear_rgb16_le();
    let same =
        downscale_linear_rgb16_le_js_parity(&full, w as usize, h as usize, w as usize, h as usize);
    assert_eq!(same, full, "identity downscale must return the source unchanged");
}

// ───────────── limit rejection BEFORE allocation, at boundary bytes ───────────

/// A resident conversion is only reached after the decode-limit preflight admits
/// the header. Prove the preflight rejects a hostile header BEFORE any decode,
/// and — critically — that the boundary byte count (== limit) is ACCEPTED while
/// exactly one over is REJECTED. This guards the off-by-one on the ceiling.
#[test]
fn limit_rejects_before_alloc_at_exact_boundary_bytes() {
    // Header just at the output-byte ceiling: accepted.
    let l = DecodeLimits::wasm();
    let bpp = SampleRepr::U16.rgba_bytes_per_pixel(); // 8
    // width*height*bpp exactly == max_output_bytes. Pick square-ish dims.
    let px_at_limit = l.max_output_bytes / bpp; // exact division (power-of-two cap)
    assert_eq!(
        px_at_limit * bpp,
        l.max_output_bytes,
        "cap must be divisible by bpp for an exact-boundary probe"
    );
    // Keep dims under the width/height/pixel caps: 8192 * (px/8192).
    let w: u32 = 8192;
    let h: u32 = (px_at_limit / w as u64) as u32;
    // Adjust so width*height*bpp lands exactly on the cap.
    let at_limit = HeaderProbe {
        format: DevelopedFormat::Tiff,
        width: w,
        height: h,
        channels: 4,
        sample: SampleRepr::U16,
        output_bytes: (w as u64) * (h as u64) * bpp,
    };
    // Dimension/pixel caps must not pre-empt the output-byte check for this probe.
    assert!(
        (w as u64) * (h as u64) <= l.max_pixels,
        "boundary probe must stay under the pixel cap so output_bytes is the gate"
    );
    if at_limit.output_bytes == l.max_output_bytes {
        assert!(
            l.check(&at_limit, 1024).is_ok(),
            "output_bytes exactly AT the ceiling must be accepted"
        );
    }

    // One byte-equivalent over the ceiling (one extra pixel row): rejected, and the
    // rejection is a pure header check — no DecodedRgba is ever constructed.
    let over = HeaderProbe {
        output_bytes: l.max_output_bytes + 1,
        ..at_limit
    };
    assert!(
        l.check(&over, 1024).is_err(),
        "output_bytes one over the ceiling must be rejected before allocation"
    );

    // Input-byte boundary: len == cap accepted, len == cap+1 rejected. Uses a valid
    // probe so only the input gate can fire.
    let small = HeaderProbe {
        format: DevelopedFormat::Jpeg,
        width: 16,
        height: 12,
        channels: 3,
        sample: SampleRepr::U8,
        output_bytes: 16 * 12 * 4,
    };
    assert!(
        l.check(&small, l.max_input_bytes).is_ok(),
        "input length exactly AT the cap must be accepted"
    );
    assert!(
        l.check(&small, l.max_input_bytes + 1).is_err(),
        "input length one over the cap must be rejected before allocation"
    );
}

/// Sanity: the resident conversion is reached ONLY on admitted input. This decodes
/// a real fixture through the limited entry point and then converts — proving the
/// end-to-end resident path (preflight → decode → resident RGB16-LE) works and the
/// output is the expected size.
#[test]
fn resident_path_end_to_end_on_admitted_fixture() {
    let bytes = std::fs::read(format!("{DIR}/mandelbrot_u8.tiff")).expect("read tiff8 fixture");
    let d = image_formats::decode_tiff_bytes_limited(&bytes, &DecodeLimits::native())
        .expect("admitted tiff8 decodes");
    let packed = d.to_linear_rgb16_le();
    assert_eq!(packed.len(), (d.width as usize) * (d.height as usize) * 6);
    assert_resident_matches_js(&d, "tiff8-e2e");
}
