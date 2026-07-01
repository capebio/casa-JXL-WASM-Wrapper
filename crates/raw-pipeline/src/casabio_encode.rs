//! Shared "encode 3 JXL variants for Casabio" routine.
//! Inputs RGBA8 + dimensions + source type + HQ override.
//! Outputs three JXL byte buffers plus the chosen fullsize quality.
//!
//! Built on the BSD-clean `jxl_casaencoder` layer (own FFI over libjxl), replacing
//! the GPL `jpegxl-rs` encoder and the `transmute`-based frame-setting hacks.
//! Reuse is explicit: the sequential variant path and the pyramid loop each hold
//! **one** [`Encoder`](crate::jxl_casaencoder::Encoder) and call `.encode()` per level
//! (only the options change between levels). Under rayon, each parallel branch
//! owns its own `Encoder` (normal owned-value semantics).

use std::sync::atomic::{AtomicBool, Ordering};

use crate::jxl_casaencoder::{Encoder, EncodeOptions, Frame, GroupOrder};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceType {
    Jpeg,
    Raw,
    Other,
}

#[derive(Debug)]
pub struct VariantSet {
    pub thumb_300: Vec<u8>,
    pub preview_1080: Vec<u8>,
    pub full: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub thumb_w: u32,
    pub thumb_h: u32,
    pub preview_w: u32,
    pub preview_h: u32,
    pub full_quality: u8,
    /// True if the input RGBA had any pixel with alpha < 255.
    /// When false the three encoded variants are RGB (no extra channel).
    pub has_alpha: bool,
}

#[derive(thiserror::Error, Debug)]
pub enum EncodeError {
    #[error("encoder failed: {0}")]
    Jxl(String),
    #[error("encoder channel error: {0}")]
    Channels(String),
    #[error("encoder size mismatch: expected {expected} samples, got {got}")]
    Size { expected: usize, got: usize },
    #[error("encoder create failed")]
    Create,
    #[error("resize failed")]
    Resize,
    #[error("invalid input: expected {expected} bytes, got {got}")]
    Input { expected: usize, got: usize },
    #[error("cancelled")]
    Cancelled,
}

impl From<crate::jxl_casaencoder::EncodeError> for EncodeError {
    fn from(e: crate::jxl_casaencoder::EncodeError) -> Self {
        use crate::jxl_casaencoder::EncodeError as Src;
        match e {
            Src::Jxl(msg) => EncodeError::Jxl(msg),
            Src::Channels(msg) => EncodeError::Channels(msg),
            Src::Size { expected, got } => EncodeError::Size { expected, got },
            Src::Create => EncodeError::Create,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProgressiveOpts {
    pub progressive_dc: u32,
    pub group_order: u32,
    pub center: Option<(u32, u32)>,
}

// Variant effort ladder (was jpegxl-rs EncoderSpeed Lightning/Falcon → libjxl Effort).
const EFFORT_THUMB: u8 = 1; // Lightning
const EFFORT_PREVIEW: u8 = 3; // Falcon
const EFFORT_FULL: u8 = 3; // Falcon

pub fn encode_variants(
    rgba: &[u8],
    width: u32,
    height: u32,
    source: SourceType,
    hq_override: bool,
) -> Result<VariantSet, EncodeError> {
    encode_variants_progressive_opts(rgba, width, height, source, hq_override, ProgressiveOpts::default())
}

pub fn encode_variants_with_progressive(
    rgba: &[u8],
    width: u32,
    height: u32,
    source: SourceType,
    hq_override: bool,
    progressive_dc: u32,
    group_order: u32,
) -> Result<VariantSet, EncodeError> {
    encode_variants_progressive_opts(rgba, width, height, source, hq_override, ProgressiveOpts {
        progressive_dc,
        group_order,
        center: None,
    })
}

pub fn encode_variants_progressive_opts(
    rgba: &[u8],
    width: u32,
    height: u32,
    source: SourceType,
    hq_override: bool,
    opts: ProgressiveOpts,
) -> Result<VariantSet, EncodeError> {
    encode_variants_cancellable(rgba, width, height, source, hq_override, opts, &AtomicBool::new(false))
}

pub fn encode_variants_cancellable(
    rgba: &[u8],
    width: u32,
    height: u32,
    source: SourceType,
    hq_override: bool,
    opts: ProgressiveOpts,
    cancel: &AtomicBool,
) -> Result<VariantSet, EncodeError> {
    if cancel.load(Ordering::Acquire) {
        return Err(EncodeError::Cancelled);
    }
    // checked_mul: on 32-bit/wasm usize, width*height*4 can overflow and wrap to a
    // small value that spuriously equals rgba.len(), defeating the contract. None
    // means the requested buffer can't exist on this target → reject.
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|wh| wh.checked_mul(4));
    if width == 0 || height == 0 || expected != Some(rgba.len()) {
        return Err(EncodeError::Input {
            expected: expected.unwrap_or(usize::MAX),
            got: rgba.len(),
        });
    }

    // Detect alpha once from the full-res input; all variant encode calls use this result.
    // RAW images always have alpha=255 → false → 3ch RGB encode path (fast, no extra-channel issues).
    // CRAWL F1: the full-res RGB strip that alpha_strip also produced was dropped here (the
    // variants re-strip at their own 3 sizes), so we paid a full-frame n*3 alloc+write for
    // nothing. has_meaningful_alpha does the same early-out alpha scan with zero allocation.
    let has_alpha = has_meaningful_alpha(rgba);

    let full_quality: u8 = if hq_override {
        95
    } else if source == SourceType::Raw {
        90 // Pixel 9 DNG optimized: Q90/E3 balance speed + quality
    } else {
        85
    };

    let max_dim = width.max(height);

    // Cascade resizing: full -> preview (1080) -> thumb (300)
    let (preview_rgba, pw, ph) = if max_dim > 1080 {
        let scale = 1080.0 / max_dim as f32;
        let dw = (width as f32 * scale).round().max(1.0) as u32;
        let dh = (height as f32 * scale).round().max(1.0) as u32;
        (Some(resize_rgba(rgba, width, height, dw, dh)?), dw, dh)
    } else {
        (None, width, height)
    };
    if cancel.load(Ordering::Acquire) {
        return Err(EncodeError::Cancelled);
    }

    let preview_src: &[u8] = preview_rgba.as_deref().unwrap_or(rgba);

    let preview_long = pw.max(ph); // handoff item 5: compute the long edge once
    let (thumb_rgba, tw, th) = if preview_long > 300 {
        let scale = 300.0 / preview_long as f32;
        let dw = (pw as f32 * scale).round().max(1.0) as u32;
        let dh = (ph as f32 * scale).round().max(1.0) as u32;
        // Thumbnail (≤300px): Triangle filter is ~3× faster than Lanczos3 and
        // perceptually equivalent at this scale.
        (Some(resize_rgba_fast(preview_src, pw, ph, dw, dh)?), dw, dh)
    } else {
        (None, pw, ph)
    };
    if cancel.load(Ordering::Acquire) {
        return Err(EncodeError::Cancelled);
    }

    let thumb_src: &[u8] = thumb_rgba.as_deref().unwrap_or(preview_src);

    let preview_opts = ProgressiveOpts {
        progressive_dc: 0,
        group_order: opts.group_order,
        center: opts.center,
    };
    let thumb_opts = ProgressiveOpts::default();

    #[cfg(feature = "parallel")]
    let (thumb_300, preview_1080, full) = {
        // Each rayon branch owns its own Encoder (owned-value semantics).
        let (thumb_res, (preview_res, full_res)) = rayon::join(
            || {
                if cancel.load(Ordering::Acquire) {
                    return Err(EncodeError::Cancelled);
                }
                encode_variant(thumb_src, tw, th, 85, EFFORT_THUMB, thumb_opts, has_alpha, width, height)
            },
            || {
                rayon::join(
                    || {
                        if cancel.load(Ordering::Acquire) {
                            return Err(EncodeError::Cancelled);
                        }
                        encode_variant(preview_src, pw, ph, 85, EFFORT_PREVIEW, preview_opts, has_alpha, width, height)
                    },
                    || {
                        if cancel.load(Ordering::Acquire) {
                            return Err(EncodeError::Cancelled);
                        }
                        encode_variant(rgba, width, height, full_quality, EFFORT_FULL, opts, has_alpha, width, height)
                    },
                )
            },
        );
        (thumb_res?, preview_res?, full_res?)
    };

    #[cfg(not(feature = "parallel"))]
    let (thumb_300, preview_1080, full) = {
        // One held Encoder, reused across the whole variant set.
        let mut enc = Encoder::new(EncodeOptions::default())?;
        let t = encode_into(&mut enc, thumb_src, tw, th, 85, EFFORT_THUMB, thumb_opts, has_alpha, width, height)?;
        if cancel.load(Ordering::Acquire) {
            return Err(EncodeError::Cancelled);
        }
        let p = encode_into(&mut enc, preview_src, pw, ph, 85, EFFORT_PREVIEW, preview_opts, has_alpha, width, height)?;
        if cancel.load(Ordering::Acquire) {
            return Err(EncodeError::Cancelled);
        }
        let f = encode_into(&mut enc, rgba, width, height, full_quality, EFFORT_FULL, opts, has_alpha, width, height)?;
        (t, p, f)
    };

    Ok(VariantSet {
        thumb_300,
        preview_1080,
        full,
        width,
        height,
        thumb_w: tw,
        thumb_h: th,
        preview_w: pw,
        preview_h: ph,
        full_quality,
        has_alpha,
    })
}

/// Build encode options for one variant level (quality + effort + progressive).
/// Group-order center is scaled from full-res coords into this level's coords.
fn build_opts(
    quality: u8,
    effort: u8,
    prog: ProgressiveOpts,
    w: u32,
    h: u32,
    orig_w: u32,
    orig_h: u32,
) -> EncodeOptions {
    let mut o = EncodeOptions::quality(quality as f32).with_effort(effort);
    if prog.progressive_dc > 0 {
        o.progressive_dc = Some(prog.progressive_dc as i64);
    }
    if prog.group_order > 0 {
        let center = prog.center.map(|(cx, cy)| {
            // Integer coordinate scaling (handoff item 4): deterministic, no f32
            // precision edge cases. u32×u32 widened to u64 cannot overflow.
            let mx = if orig_w > 0 { (cx as u64 * w as u64 / orig_w as u64) as i64 } else { cx as i64 };
            let my = if orig_h > 0 { (cy as u64 * h as u64 / orig_h as u64) as i64 } else { cy as i64 };
            (mx, my)
        });
        o.group_order = Some(GroupOrder { center });
    }
    o
}

/// Encode one variant reusing a held [`Encoder`]. RAW (alpha=255) strips to RGB.
#[allow(clippy::too_many_arguments)]
fn encode_into(
    enc: &mut Encoder,
    pixels: &[u8], // RGBA8, w*h*4
    w: u32,
    h: u32,
    quality: u8,
    effort: u8,
    prog: ProgressiveOpts,
    has_alpha: bool,
    orig_w: u32,
    orig_h: u32,
) -> Result<Vec<u8>, EncodeError> {
    // Buffer-shape contract: `pixels` is always RGBA8 here (resize/cascade outputs
    // are RGBA8); rgba_to_rgb strips to RGB internally for the no-alpha path. Assert
    // len before handing (w,h) to the C encoder so a wrong-sized derived buffer is
    // rejected instead of triggering an OOB read inside libjxl.
    let expected = (w as usize)
        .checked_mul(h as usize)
        .and_then(|wh| wh.checked_mul(4));
    if expected != Some(pixels.len()) {
        return Err(EncodeError::Input {
            expected: expected.unwrap_or(usize::MAX),
            got: pixels.len(),
        });
    }
    enc.set_options(build_opts(quality, effort, prog, w, h, orig_w, orig_h));
    let bytes = if has_alpha {
        enc.encode(&Frame::rgba8(pixels, w, h))?
    } else {
        // RAW images always have alpha=255; strip to RGB for smaller output.
        // Use strip_rgba_to_rgb (no alpha scan) — caller already determined has_alpha=false.
        let rgb = strip_rgba_to_rgb(pixels);
        enc.encode(&Frame::rgb(&rgb, w, h))?
    };
    Ok(bytes)
}

/// Encode one variant with a fresh one-shot [`Encoder`] (rayon branch).
#[allow(clippy::too_many_arguments)]
fn encode_variant(
    pixels: &[u8],
    w: u32,
    h: u32,
    quality: u8,
    effort: u8,
    prog: ProgressiveOpts,
    has_alpha: bool,
    orig_w: u32,
    orig_h: u32,
) -> Result<Vec<u8>, EncodeError> {
    let mut enc = Encoder::new(EncodeOptions::default())?;
    encode_into(&mut enc, pixels, w, h, quality, effort, prog, has_alpha, orig_w, orig_h)
}

fn resize_rgba(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Result<Vec<u8>, EncodeError> {
    use image::{imageops, ImageBuffer, Rgba};
    let img: ImageBuffer<Rgba<u8>, &[u8]> =
        ImageBuffer::from_raw(sw, sh, src).ok_or(EncodeError::Resize)?;
    let resized = imageops::resize(&img, dw, dh, imageops::FilterType::Lanczos3);
    Ok(resized.into_raw())
}

/// Fast resize using bilinear (Triangle) filter — ~3× faster than Lanczos3.
/// Perceptually equivalent at thumbnail scales (≤300px long edge).
fn resize_rgba_fast(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Result<Vec<u8>, EncodeError> {
    use image::{imageops, ImageBuffer, Rgba};
    let img: ImageBuffer<Rgba<u8>, &[u8]> =
        ImageBuffer::from_raw(sw, sh, src).ok_or(EncodeError::Resize)?;
    let resized = imageops::resize(&img, dw, dh, imageops::FilterType::Triangle);
    Ok(resized.into_raw())
}

/// Convenience for Tauri/native encode flows that hold pre-tone RGB16 + params.
/// Produces the three JXL variants directly from the 16-bit buffer.
pub fn encode_variants_from_rgb16(
    rgb16: &[u16],
    params: &crate::pipeline::PipelineParams,
    width: u32,
    height: u32,
    source: SourceType,
    hq_override: bool,
) -> Result<VariantSet, EncodeError> {
    encode_variants_from_rgb16_with_progressive(rgb16, params, width, height, source, hq_override, 0, 0)
}

/// Like `encode_variants_from_rgb16` but with progressive_dc / group_order.
pub fn encode_variants_from_rgb16_with_progressive(
    rgb16: &[u16],
    params: &crate::pipeline::PipelineParams,
    width: u32,
    height: u32,
    source: SourceType,
    hq_override: bool,
    progressive_dc: u32,
    group_order: u32,
) -> Result<VariantSet, EncodeError> {
    let rgba = if params.texture != 0.0 || params.clarity != 0.0 {
        let mut rgb16_mut = rgb16.to_vec();
        crate::pipeline::apply_unsharp_masks(&mut rgb16_mut, width as usize, height as usize, params);
        crate::pipeline::process_rgba(&rgb16_mut, params)
    } else {
        crate::pipeline::process_rgba(rgb16, params)
    };
    encode_variants_with_progressive(&rgba, width, height, source, hq_override, progressive_dc, group_order)
}

// PR-6b: native sidecar pyramid encoder (v2 per-level distances, no 1.5 floor, box cascade).
#[derive(Debug, Clone)]
pub struct PyramidLevel {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub bits_per_sample: u8,
}

/// Strip RGBA8 to RGB8 without scanning for alpha (caller already knows has_alpha=false).
fn strip_rgba_to_rgb(rgba: &[u8]) -> Vec<u8> {
    // Single bandwidth pass: reserve exact, then extend from a flat [r,g,b] byte
    // iterator. Beats both the old per-chunk `extend_from_slice` (drops the per-chunk
    // len-update + 3-byte memcpy call) and a zero-init `vec![0; n*3]` variant (no memset
    // before overwrite). flipflop: −24.9% @24MP, byte-exact — see
    // examples/strip_rgba_to_rgb_flip.rs.
    let n = rgba.len() / 4;
    let mut rgb = Vec::with_capacity(n * 3);
    rgb.extend(rgba.chunks_exact(4).flat_map(|px| [px[0], px[1], px[2]]));
    rgb
}

/// Returns true if any pixel has alpha < 255.
///
/// Alpha-only strided scan: reads just the α byte (index 3, 7, 11, …) of each pixel,
/// skipping the RGB triples the chunks-window form materialised. flipflop: −9.1% on the
/// dominant opaque 24MP scan, identical result — see examples/alpha_stepby_flip.rs.
fn has_meaningful_alpha(rgba: &[u8]) -> bool {
    if rgba.len() < 4 {
        return false;
    }
    rgba[3..].iter().step_by(4).any(|&a| a < 255)
}

fn box_downscale_rgba8(src: &[u8], sw: u32, sh: u32, dst: &mut [u8], dw: u32, dh: u32) -> bool {
    if dw == 0 || dh == 0 {
        return false;
    }
    // Checked multiply: on 32-bit/WASM targets the product can overflow usize and
    // wrap to a small value that spuriously passes the length guard.
    let src_len = (sw as usize).checked_mul(sh as usize).and_then(|n| n.checked_mul(4));
    let dst_len = (dw as usize).checked_mul(dh as usize).and_then(|n| n.checked_mul(4));
    let (src_len, dst_len) = match (src_len, dst_len) {
        (Some(s), Some(d)) => (s, d),
        _ => return false, // overflow → reject
    };
    if src.len() < src_len || dst.len() < dst_len {
        return false;
    }

    // exact integer fast path (matches C++ IMPROVEMENT-5)
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        // `count` is loop-invariant in the exact-ratio branch: every destination
        // pixel averages exactly xstep*ystep source pixels, so compute it once
        // rather than accumulating it per pixel.
        let count = xstep * ystep;
        for dy in 0..dh {
            for dx in 0..dw {
                let mut r = 0u32;
                let mut g = 0u32;
                let mut b = 0u32;
                let mut a = 0u32;
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    let row = &src[(y as usize * sw as usize * 4)..];
                    for xx in 0..xstep {
                        let x = dx * xstep + xx;
                        let px = &row[(x as usize * 4)..];
                        r += px[0] as u32;
                        g += px[1] as u32;
                        b += px[2] as u32;
                        a += px[3] as u32;
                    }
                }
                let out = &mut dst[(dy as usize * dw as usize + dx as usize) * 4..];
                out[0] = (r / count) as u8;
                out[1] = (g / count) as u8;
                out[2] = (b / count) as u8;
                out[3] = (a / count) as u8;
            }
        }
        return true;
    }

    // general coverage (ceiling for end)
    // Use u64 for intermediate products to avoid u32 overflow on large images.
    //
    // x0/x1 depend only on dx, sw, dw — NOT on dy. Precompute once to avoid
    // recomputing dh times for each column (loop-invariant hoisting).
    let x_ranges: Vec<(u32, u32)> = (0..dw)
        .map(|dx| {
            let x0 = ((dx as u64 * sw as u64) / dw as u64) as u32;
            let x1 = (((dx as u64 + 1) * sw as u64 + dw as u64 - 1) / dw as u64)
                .min(sw as u64) as u32;
            (x0, x1)
        })
        .collect();
    for dy in 0..dh {
        let y0 = ((dy as u64 * sh as u64) / dh as u64) as u32;
        let y1 = (((dy as u64 + 1) * sh as u64 + dh as u64 - 1) / dh as u64).min(sh as u64) as u32;
        for dx in 0..dw {
            let (x0, x1) = x_ranges[dx as usize];
            // The coverage rectangle [x0,x1)×[y0,y1) is fully known before any pixel
            // is read, so its cardinality is a single multiply — mirroring the exact
            // branch's hoisted `count`. This drops one increment per source sample
            // from the hottest inner loop (byte-exact: the old per-px accumulation
            // reached exactly this value). Products fit u32: (x1-x0)≤sw, (y1-y0)≤sh,
            // sw*sh ≤ 24M ≪ u32::MAX on any real image.
            let count = (x1 - x0) * (y1 - y0);
            let mut r = 0u32;
            let mut g = 0u32;
            let mut b = 0u32;
            let mut a = 0u32;
            for sy in y0..y1 {
                let row = &src[(sy as usize * sw as usize * 4)..];
                for sx in x0..x1 {
                    let px = &row[(sx as usize * 4)..];
                    r += px[0] as u32;
                    g += px[1] as u32;
                    b += px[2] as u32;
                    a += px[3] as u32;
                }
            }
            // Defensive guard: count==0 (degenerate/upscale column producing an empty
            // coverage interval) leaves the destination pixel at its zero-init value,
            // identical to the previous per-px-count behaviour. Prevents div-by-zero.
            if count == 0 {
                continue;
            }
            let out = &mut dst[(dy as usize * dw as usize + dx as usize) * 4..];
            out[0] = (r / count) as u8;
            out[1] = (g / count) as u8;
            out[2] = (b / count) as u8;
            out[3] = (a / count) as u8;
        }
    }
    true
}

/// 3-channel twin of [`box_downscale_rgba8`] for the opaque (RGB) cascade.
///
/// Box averaging is per-channel independent, so the r/g/b outputs are **byte-identical**
/// to `box_downscale_rgba8` followed by `strip_rgba_to_rgb` — dropping the alpha channel
/// from the accumulation cannot perturb the colour math. Operating natively in RGB removes
/// the alpha plane's averaging+store (≈25% of the inner-loop traffic) and, paired with the
/// pyramid's RGB-native path, the per-level strip allocation. Proven equal across sizes in
/// `examples/box_downscale_rgb_parity_flip.rs`.
fn box_downscale_rgb8(src: &[u8], sw: u32, sh: u32, dst: &mut [u8], dw: u32, dh: u32) -> bool {
    if dw == 0 || dh == 0 {
        return false;
    }
    // Checked multiply: on 32-bit/WASM targets the product can overflow usize and
    // wrap to a small value that spuriously passes the length guard.
    let src_len = (sw as usize).checked_mul(sh as usize).and_then(|n| n.checked_mul(3));
    let dst_len = (dw as usize).checked_mul(dh as usize).and_then(|n| n.checked_mul(3));
    let (src_len, dst_len) = match (src_len, dst_len) {
        (Some(s), Some(d)) => (s, d),
        _ => return false,
    };
    if src.len() < src_len || dst.len() < dst_len {
        return false;
    }

    // exact integer fast path (loop-invariant count, mirrors the RGBA variant)
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let count = xstep * ystep;
        for dy in 0..dh {
            for dx in 0..dw {
                let mut r = 0u32;
                let mut g = 0u32;
                let mut b = 0u32;
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    let row = &src[(y as usize * sw as usize * 3)..];
                    for xx in 0..xstep {
                        let x = dx * xstep + xx;
                        let px = &row[(x as usize * 3)..];
                        r += px[0] as u32;
                        g += px[1] as u32;
                        b += px[2] as u32;
                    }
                }
                let out = &mut dst[(dy as usize * dw as usize + dx as usize) * 3..];
                out[0] = (r / count) as u8;
                out[1] = (g / count) as u8;
                out[2] = (b / count) as u8;
            }
        }
        return true;
    }

    // general coverage (ceiling for end) — x ranges hoisted, count hoisted.
    let x_ranges: Vec<(u32, u32)> = (0..dw)
        .map(|dx| {
            let x0 = ((dx as u64 * sw as u64) / dw as u64) as u32;
            let x1 = (((dx as u64 + 1) * sw as u64 + dw as u64 - 1) / dw as u64)
                .min(sw as u64) as u32;
            (x0, x1)
        })
        .collect();
    for dy in 0..dh {
        let y0 = ((dy as u64 * sh as u64) / dh as u64) as u32;
        let y1 = (((dy as u64 + 1) * sh as u64 + dh as u64 - 1) / dh as u64).min(sh as u64) as u32;
        for dx in 0..dw {
            let (x0, x1) = x_ranges[dx as usize];
            let count = (x1 - x0) * (y1 - y0);
            let mut r = 0u32;
            let mut g = 0u32;
            let mut b = 0u32;
            for sy in y0..y1 {
                let row = &src[(sy as usize * sw as usize * 3)..];
                for sx in x0..x1 {
                    let px = &row[(sx as usize * 3)..];
                    r += px[0] as u32;
                    g += px[1] as u32;
                    b += px[2] as u32;
                }
            }
            if count == 0 {
                continue;
            }
            let out = &mut dst[(dy as usize * dw as usize + dx as usize) * 3..];
            out[0] = (r / count) as u8;
            out[1] = (g / count) as u8;
            out[2] = (b / count) as u8;
        }
    }
    true
}

/// Encode one pyramid level (by butteraugli distance) reusing a held [`Encoder`].
fn encode_distance_into(
    enc: &mut Encoder,
    pixels: &[u8],
    w: u32,
    h: u32,
    distance: f32,
    effort: u8,
    has_alpha: bool,
) -> Result<Vec<u8>, EncodeError> {
    // Distance is applied directly (Rate::Distance) — no quality<->distance
    // double conversion. Cleaner than the old jpeg_quality_for_distance hop.
    enc.set_options(EncodeOptions::distance(distance).with_effort(effort));
    let bytes = if has_alpha {
        enc.encode(&Frame::rgba8(pixels, w, h))?
    } else {
        // Use strip_rgba_to_rgb (no alpha scan) — caller already determined has_alpha=false.
        let rgb = strip_rgba_to_rgb(pixels);
        enc.encode(&Frame::rgb(&rgb, w, h))?
    };
    Ok(bytes)
}

/// Encode one pyramid level from an **already-RGB** (3ch) buffer, reusing a held
/// [`Encoder`]. The RGB-native opaque path carries no alpha plane, so there is no strip:
/// `pixels` is handed straight to `Frame::rgb`. Output is byte-identical to
/// `encode_distance_into(.., has_alpha=false)` fed the matching RGBA buffer.
fn encode_distance_rgb_into(
    enc: &mut Encoder,
    rgb: &[u8],
    w: u32,
    h: u32,
    distance: f32,
    effort: u8,
) -> Result<Vec<u8>, EncodeError> {
    enc.set_options(EncodeOptions::distance(distance).with_effort(effort));
    Ok(enc.encode(&Frame::rgb(rgb, w, h))?)
}

/// Thread count for a single **serial** encode of a `px`-pixel image.
///
/// Returns 1 (→ `Encoder::with_threads` allocates no runner) below ~0.25 MP, where
/// thread spin-up outweighs the gain; otherwise the machine's parallelism. Bench
/// (effort=3, `examples/jxl_encode_cpp_bench.rs`): single-image multithreaded encode
/// = 1.33–1.51× at ≥512×512, output byte-identical.
///
/// Use this ONLY for encodes that run serially (e.g. the full-res pass after the
/// sidecar/variant fan-out's barrier). NEVER inside the rayon fan-out itself — that
/// already saturates every core, so per-encode threads would oversubscribe and slow
/// the whole set down.
fn serial_encode_threads(px: usize) -> usize {
    if px < 512 * 512 {
        return 1;
    }
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
}

/// One sidecar level target: dimensions + butteraugli distance. Channel-agnostic —
/// shared by the RGBA and RGB-native cascades.
#[derive(Clone, Copy)]
struct Sc {
    tw: u32,
    th: u32,
    dist: f32,
}

/// Build the sidecar level list (sizes→dims, skip no-ops/upscales) and sort it
/// largest→smallest by long edge. Validates that sizes and distances pair up. Channel-
/// and pixel-agnostic, so both pyramid entry points share one source of truth for the
/// cascade shape.
fn build_sorted_scs(
    width: u32,
    height: u32,
    sidecar_sizes: &[u32],
    sidecar_distances: &[f32],
) -> Result<Vec<Sc>, EncodeError> {
    if sidecar_sizes.len() != sidecar_distances.len() {
        return Err(EncodeError::Jxl(
            "sidecar_sizes and sidecar_distances length mismatch".into(),
        ));
    }
    let longer = width.max(height);
    let mut scs: Vec<Sc> = Vec::new();
    for (i, &max_dim) in sidecar_sizes.iter().enumerate() {
        if max_dim == 0 || max_dim >= longer {
            continue;
        }
        let (tw, th) = if width >= height {
            let tw = max_dim;
            let th = std::cmp::max(1u32, (((max_dim as u64 * height as u64) + (width as u64 / 2)) / (width as u64)) as u32);
            (tw, th)
        } else {
            let th = max_dim;
            let tw = std::cmp::max(1u32, (((max_dim as u64 * width as u64) + (height as u64 / 2)) / (height as u64)) as u32);
            (tw, th)
        };
        scs.push(Sc { tw, th, dist: sidecar_distances[i] });
    }

    // Sort descending by the actual LONG edge so the cascade (largest → smallest)
    // always downscales, regardless of the order sidecar_sizes was passed in.
    // Keying on `tw` alone breaks for ultra-narrow portraits (tw saturates to 1 across
    // levels while th still distinguishes them); max(tw,th) — the long edge, i.e. the
    // original max_dim — is byte-identical for the monotone cases and restores a strict
    // downscale for the degenerate ones. Tie-break tw then th for a total order.
    scs.sort_unstable_by(|a, b| {
        b.tw.max(b.th)
            .cmp(&a.tw.max(a.th))
            .then_with(|| b.tw.cmp(&a.tw))
            .then_with(|| b.th.cmp(&a.th))
    });
    Ok(scs)
}

/// RGB-native sidecar pyramid: cascade and encode entirely in 3-channel space.
///
/// `rgb` is the full-resolution RGB8 master (`width*height*3`). Used by the opaque path
/// of [`encode_rgba8_pyramid`] (after a single full-frame strip) and directly by
/// [`encode_rgba8_pyramid_from_rgb16`] (RGB straight out of `process_rgb`, zero strips).
/// Output is byte-identical to the RGBA cascade + per-level strip it replaces.
fn pyramid_encode_rgb(
    rgb: &[u8],
    width: u32,
    height: u32,
    full_distance: f32,
    scs: &[Sc],
    effort: u8,
) -> Result<Vec<PyramidLevel>, EncodeError> {
    // Phase 1: cascade in RGB (3ch); each level reads the previous level's buffer.
    let mut scaled_bufs: Vec<(Vec<u8>, u32, u32, f32)> = Vec::with_capacity(scs.len());
    {
        let mut cw = width;
        let mut ch = height;
        for sc in scs.iter() {
            let mut buf = vec![0u8; sc.tw as usize * sc.th as usize * 3];
            let src: &[u8] = if scaled_bufs.is_empty() { rgb } else { &scaled_bufs.last().unwrap().0 };
            if !box_downscale_rgb8(src, cw, ch, &mut buf, sc.tw, sc.th) {
                return Err(EncodeError::Resize);
            }
            cw = sc.tw;
            ch = sc.th;
            scaled_bufs.push((buf, sc.tw, sc.th, sc.dist));
        }
    }

    // Phase 2: encode sidecars via Frame::rgb — no per-level strip.
    #[cfg(feature = "parallel")]
    let mut sides: Vec<PyramidLevel> = {
        use rayon::prelude::*;
        let results: Vec<Result<PyramidLevel, EncodeError>> = scaled_bufs
            .into_par_iter()
            .map_init(
                || Encoder::new(EncodeOptions::default()),
                |enc_slot, (buf, tw, th, dist)| {
                    let enc = enc_slot.as_mut().map_err(|_| EncodeError::Jxl("encoder init".into()))?;
                    let data = encode_distance_rgb_into(enc, &buf, tw, th, dist, effort)?;
                    Ok(PyramidLevel { data, width: tw, height: th, bits_per_sample: 8 })
                },
            )
            .collect();
        results.into_iter().collect::<Result<Vec<_>, _>>()?
    };

    #[cfg(not(feature = "parallel"))]
    let mut sides: Vec<PyramidLevel> = {
        let mut enc = Encoder::new(EncodeOptions::default())?;
        let mut v = Vec::with_capacity(scaled_bufs.len());
        for (buf, tw, th, dist) in scaled_bufs {
            let data = encode_distance_rgb_into(&mut enc, &buf, tw, th, dist, effort)?;
            v.push(PyramidLevel { data, width: tw, height: th, bits_per_sample: 8 });
        }
        v
    };

    // Sidecars built largest→smallest; reverse to smallest→largest for consumers.
    sides.reverse();

    // Full-resolution encode (serial, post-barrier → libjxl gets its own thread runner).
    let full = {
        let threads = serial_encode_threads(width as usize * height as usize);
        let mut enc = Encoder::with_threads(EncodeOptions::default(), threads)?;
        encode_distance_rgb_into(&mut enc, rgb, width, height, full_distance, effort)?
    };
    sides.push(PyramidLevel { data: full, width, height, bits_per_sample: 8 });
    Ok(sides)
}

pub fn encode_rgba8_pyramid(
    rgba: &[u8],
    width: u32,
    height: u32,
    full_distance: f32,
    sidecar_sizes: &[u32],
    sidecar_distances: &[f32],
    effort: u32,
) -> Result<Vec<PyramidLevel>, EncodeError> {
    if rgba.is_empty() || width == 0 || height == 0 {
        return Err(EncodeError::Jxl("empty or zero-dim input".into()));
    }
    // Exact-shape contract for the FFI boundary. The cascade is guarded by
    // box_downscale's own length check, but when `sidecar_sizes` is empty (or every
    // entry is skipped) the cascade never runs and the original `rgba` is handed
    // straight to `encode_distance_into` → `Frame::rgba8`/`strip_rgba_to_rgb`. A
    // truncated buffer there is an out-of-bounds read inside libjxl. Validate once,
    // up front, with the same checked_mul used by the variant entry points.
    let expected_rgba = (width as usize)
        .checked_mul(height as usize)
        .and_then(|wh| wh.checked_mul(4));
    if expected_rgba != Some(rgba.len()) {
        return Err(EncodeError::Input {
            expected: expected_rgba.unwrap_or(usize::MAX),
            got: rgba.len(),
        });
    }
    let effort = effort.clamp(1, 10) as u8;
    let scs = build_sorted_scs(width, height, sidecar_sizes, sidecar_distances)?;

    // CRAWL F1: only has_alpha is needed here (the strip was discarded); use the
    // zero-allocation scan instead of alpha_strip's full-frame n*3 strip build.
    let has_alpha = has_meaningful_alpha(rgba);

    // Meta-seam cut: on the dominant opaque (RAW) path the alpha plane is pure
    // ballast — manufactured upstream, averaged at every cascade level, then discarded
    // by the FFI. Strip the full frame ONCE and run the entire cascade in RGB:
    // box_downscale_rgb8 is byte-identical to rgba8+strip, and each level encodes via
    // Frame::rgb with no per-level strip allocation. Alpha images keep the RGBA path.
    if !has_alpha {
        let rgb_full = strip_rgba_to_rgb(rgba);
        return pyramid_encode_rgb(&rgb_full, width, height, full_distance, &scs, effort);
    }

    // Phase 1: cascade all scales sequentially (each level reads from previous).
    // Produces (pixels, w, h, distance) tuples for parallel encoding.
    //
    // The cascade reads each level's output as input for the next level.
    // We move `thumb` directly into `scaled_bufs` (no clone), then borrow the last
    // element for the next downscale. The original full-res `rgba` slice is kept for
    // the first iteration via `src_ref` / separate pointer tracking.
    let mut scaled_bufs: Vec<(Vec<u8>, u32, u32, f32)> = Vec::with_capacity(scs.len());
    {
        let mut cw = width;
        let mut ch = height;
        for sc in scs.iter() {
            let mut thumb = vec![0u8; sc.tw as usize * sc.th as usize * 4];
            // Source for this iteration: last pushed buffer or original rgba.
            let src: &[u8] = if scaled_bufs.is_empty() { rgba } else { &scaled_bufs.last().unwrap().0 };
            if !box_downscale_rgba8(src, cw, ch, &mut thumb, sc.tw, sc.th) {
                return Err(EncodeError::Resize);
            }
            cw = sc.tw;
            ch = sc.th;
            // Move into scaled_bufs — no clone needed.
            scaled_bufs.push((thumb, sc.tw, sc.th, sc.dist));
        }
    }

    // Phase 2: encode all sidecar levels. With the "parallel" feature, use rayon
    // so levels compress concurrently; without it, fall back to one held Encoder.
    #[cfg(feature = "parallel")]
    let mut sides: Vec<PyramidLevel> = {
        use rayon::prelude::*;
        let results: Vec<Result<PyramidLevel, EncodeError>> = scaled_bufs
            .into_par_iter()
            .map_init(
                || Encoder::new(EncodeOptions::default()),
                |enc_slot, (buf, tw, th, dist)| {
                    let enc = enc_slot.as_mut().map_err(|_| EncodeError::Jxl("encoder init".into()))?;
                    enc.set_options(EncodeOptions::distance(dist).with_effort(effort));
                    let bytes = if has_alpha {
                        enc.encode(&Frame::rgba8(&buf, tw, th))?
                    } else {
                        // Use strip_rgba_to_rgb (no alpha scan) — has_alpha already determined.
                        let rgb = strip_rgba_to_rgb(&buf);
                        enc.encode(&Frame::rgb(&rgb, tw, th))?
                    };
                    Ok(PyramidLevel { data: bytes, width: tw, height: th, bits_per_sample: 8 })
                },
            )
            .collect();
        results.into_iter().collect::<Result<Vec<_>, _>>()?
    };

    #[cfg(not(feature = "parallel"))]
    let mut sides: Vec<PyramidLevel> = {
        let mut enc = Encoder::new(EncodeOptions::default())?;
        let mut v = Vec::with_capacity(scaled_bufs.len());
        for (buf, tw, th, dist) in scaled_bufs {
            let data = encode_distance_into(&mut enc, &buf, tw, th, dist, effort, has_alpha)?;
            v.push(PyramidLevel { data, width: tw, height: th, bits_per_sample: 8 });
        }
        v
    };

    // Sidecar levels were built largest→smallest; reverse to smallest→largest for consumers.
    sides.reverse();

    // Full-resolution encode (always serial — only one full image). It runs AFTER
    // the sidecar fan-out's barrier, so every core is free: hand libjxl its own
    // thread runner to bank the measured single-image win (effort=3: 1.33–1.51× at
    // ≥512², output byte-identical). This is the largest, slowest encode in the
    // pyramid. The sidecar fan-out above stays single-threaded per worker — rayon
    // already saturates cores there, so threading it would oversubscribe.
    let full = {
        let threads = serial_encode_threads(width as usize * height as usize);
        let mut enc = Encoder::with_threads(EncodeOptions::default(), threads)?;
        encode_distance_into(&mut enc, rgba, width, height, full_distance, effort, has_alpha)?
    };
    sides.push(PyramidLevel { data: full, width, height, bits_per_sample: 8 });
    Ok(sides)
}

/// Convenience for Tauri/native pyramid ingest (PR-7b) that holds pre-tone RGB16 + params.
pub fn encode_rgba8_pyramid_from_rgb16(
    rgb16: &[u16],
    params: &crate::pipeline::PipelineParams,
    width: u32,
    height: u32,
    full_distance: f32,
    sidecar_sizes: &[u32],
    sidecar_distances: &[f32],
    effort: u32,
) -> Result<Vec<PyramidLevel>, EncodeError> {
    if rgb16.is_empty() || width == 0 || height == 0 {
        return Err(EncodeError::Jxl("empty or zero-dim input".into()));
    }
    // RGB16 shape contract before the pipeline allocates/tone-maps.
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|wh| wh.checked_mul(3));
    if expected != Some(rgb16.len()) {
        return Err(EncodeError::Size {
            expected: expected.unwrap_or(usize::MAX),
            got: rgb16.len(),
        });
    }
    let effort = effort.clamp(1, 10) as u8;
    let scs = build_sorted_scs(width, height, sidecar_sizes, sidecar_distances)?;
    // RAW source → always opaque. Tone-map straight to RGB (process_rgb is the byte-exact
    // 3-channel twin of process_rgba — α was a hardcoded 255 it never needed) so the alpha
    // plane is never created and the meta-seam never forms. No strip anywhere in this path.
    let rgb = crate::pipeline::process_rgb(rgb16, params);
    pyramid_encode_rgb(&rgb, width, height, full_distance, &scs, effort)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0u8; (w * h * 4) as usize];
        for px in v.chunks_exact_mut(4) {
            px[0] = 200;
            px[1] = 100;
            px[2] = 50;
            px[3] = 255;
        }
        v
    }

    fn solid(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0u8; (w * h * 4) as usize];
        for px in v.chunks_exact_mut(4) {
            px[0] = 120;
            px[1] = 120;
            px[2] = 120;
            px[3] = 255;
        }
        v
    }

    #[test]
    fn encodes_three_variants_with_jxl_magic() {
        let rgba = gradient(2000, 1500);
        let v = encode_variants(&rgba, 2000, 1500, SourceType::Jpeg, false).unwrap();
        assert_eq!(v.full_quality, 85);
        for buf in [&v.thumb_300, &v.preview_1080, &v.full] {
            assert!(!buf.is_empty());
            let cs = buf[0] == 0xFF && buf[1] == 0x0A;
            let cont = buf.len() >= 8 && buf[0] == 0 && buf[3] == 0x0C && &buf[4..8] == b"JXL ";
            assert!(cs || cont, "missing JXL magic");
        }
    }

    #[test]
    fn raw_default_q90() {
        let rgba = gradient(100, 100);
        let v = encode_variants(&rgba, 100, 100, SourceType::Raw, false).unwrap();
        assert_eq!(v.full_quality, 90);
    }

    #[test]
    fn hq_override_forces_q95() {
        let rgba = gradient(100, 100);
        let v = encode_variants(&rgba, 100, 100, SourceType::Jpeg, true).unwrap();
        assert_eq!(v.full_quality, 95);
    }

    #[test]
    fn encode_variants_from_rgb16_smoke() {
        let rgb16: Vec<u16> = (0..(2 * 2 * 3)).map(|i| 3000 + (i as u16) * 10).collect();
        let params = crate::pipeline::PipelineParams::default_olympus();
        let v = encode_variants_from_rgb16(&rgb16, &params, 2, 2, SourceType::Raw, false).unwrap();
        assert_eq!(v.width, 2);
        assert_eq!(v.height, 2);
        assert!(!v.full.is_empty());
        assert_eq!(v.full_quality, 90);
    }

    #[test]
    fn encode_variants_with_progressive_dc2_smoke() {
        let rgba = solid(64, 64);
        let v = encode_variants_with_progressive(&rgba, 64, 64, SourceType::Raw, false, 2, 1).unwrap();
        assert!(!v.full.is_empty());
        let b = &v.full;
        let cs = b[0] == 0xFF && b[1] == 0x0A;
        let cont = b.len() >= 8 && b[0] == 0 && b[3] == 0x0C && &b[4..8] == b"JXL ";
        assert!(cs || cont);
    }

    #[test]
    fn encode_rgba8_pyramid_smoke() {
        let rgba = solid(200, 150);
        let levels = encode_rgba8_pyramid(&rgba, 200, 150, 0.55, &[128, 256], &[1.45, 1.45], 3).unwrap();
        assert_eq!(levels.len(), 2);
        assert!(levels[0].width <= 128);
        assert_eq!(levels.last().unwrap().width, 200);
        for l in &levels {
            assert!(!l.data.is_empty());
            let b = &l.data;
            let ok = (b.len() >= 2 && b[0] == 0xFF && b[1] == 0x0A)
                || (b.len() >= 8 && b[0] == 0 && b[3] == 0x0C && &b[4..8] == b"JXL ");
            assert!(ok, "pyramid level missing JXL magic");
            assert_eq!(l.bits_per_sample, 8);
        }
    }

    #[test]
    fn pyramid_skips_upscale_and_produces_ascending() {
        let rgba = solid(800, 600);
        let levels = encode_rgba8_pyramid(&rgba, 800, 600, 0.55, &[256, 512, 1024, 2048], &[1.45, 1.45, 1.45, 0.55], 3).unwrap();
        assert!(levels.len() >= 2);
        let last = levels.last().unwrap();
        assert_eq!(last.width, 800);
        assert_eq!(last.height, 600);
        assert!(levels[0].width <= 256);
    }

    #[test]
    fn encode_rgba8_pyramid_from_rgb16_smoke() {
        let rgb16: Vec<u16> = (0..(4 * 4 * 3)).map(|i| 3000 + (i as u16) * 10).collect();
        let params = crate::pipeline::PipelineParams::default_olympus();
        let levels = encode_rgba8_pyramid_from_rgb16(&rgb16, &params, 4, 4, 0.55, &[2], &[1.45], 3).unwrap();
        assert!(!levels.is_empty());
        let last = levels.last().unwrap();
        assert_eq!(last.width, 4);
        assert_eq!(last.height, 4);
        assert_eq!(last.bits_per_sample, 8);
    }

    #[test]
    fn encode_4ch_alpha_does_not_error() {
        let (w, h) = (48u32, 48u32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for i in 0..(w * h) as usize {
            rgba[i * 4] = 180;
            rgba[i * 4 + 1] = 90;
            rgba[i * 4 + 2] = 40;
            rgba[i * 4 + 3] = if i % 3 == 0 { 100 } else { 255 };
        }
        let res = encode_variants_with_progressive(&rgba, w, h, SourceType::Other, false, 0, 0);
        assert!(res.is_ok(), "4ch alpha encode errored: {:?}", res.err());
        let vs = res.unwrap();
        assert!(vs.has_alpha, "expected has_alpha=true for alpha<255 input");
        assert!(
            !vs.full.is_empty() && !vs.thumb_300.is_empty() && !vs.preview_1080.is_empty(),
            "encoded 4ch variants must be non-empty"
        );
    }

    /// Does the 4ch encode PRESERVE alpha through a full encode->decode round-trip?
    #[test]
    fn encode_4ch_alpha_roundtrips_preserves_alpha() {
        let (w, h) = (64u32, 64u32);
        let n = (w * h) as usize;
        let mut rgba = vec![0u8; n * 4];
        for i in 0..n {
            rgba[i * 4] = 180;
            rgba[i * 4 + 1] = 90;
            rgba[i * 4 + 2] = 40;
            rgba[i * 4 + 3] = if i % 3 == 0 { 100 } else { 255 };
        }
        let vs = encode_variants_with_progressive(&rgba, w, h, SourceType::Other, false, 0, 0)
            .expect("4ch alpha encode failed");
        assert!(vs.has_alpha);

        let (px, dw, dh) = crate::jxl_decode::decode_jxl_rgba8(&vs.full)
            .expect("decode of 4ch-alpha JXL returned None");
        assert_eq!((dw, dh), (w, h), "decoded dims mismatch");
        assert_eq!(px.len(), n * 4, "decoded buffer wrong size");

        let low_alpha = px.chunks_exact(4).filter(|p| p[3] < 200).count();
        let expected = n / 3;
        assert!(
            low_alpha as f64 > expected as f64 * 0.7,
            "ALPHA NOT PRESERVED through encode->decode: {} of ~{} pixels have alpha<200",
            low_alpha,
            expected
        );
    }

    /// FFI safety: with no usable sidecars the cascade never runs, so a truncated
    /// `rgba` must be rejected up front (else it reaches `Frame::rgba8` and reads OOB
    /// inside libjxl). Pre-guard this path: empty sidecar list + short buffer → Input.
    #[test]
    fn pyramid_rejects_truncated_rgba_before_ffi() {
        let rgba = vec![0u8; 4 * 4 * 4 - 1]; // 4×4 RGBA minus one byte
        let err = encode_rgba8_pyramid(&rgba, 4, 4, 0.55, &[], &[], 3).unwrap_err();
        assert!(
            matches!(err, EncodeError::Input { expected: 64, got: 63 }),
            "expected Input{{64,63}}, got {err:?}"
        );
    }

    /// The largest-→-smallest cascade must hold for ultra-narrow portraits where the
    /// short edge saturates to 1 across levels. Width-only ordering left an ascending
    /// height run (1×128 then 1×512 = an upscale); long-edge ordering fixes it.
    #[test]
    fn pyramid_ultra_narrow_portrait_orders_by_long_edge() {
        let rgba = solid(1, 1000);
        let levels =
            encode_rgba8_pyramid(&rgba, 1, 1000, 0.55, &[128, 512, 256], &[1.45, 1.45, 1.45], 3)
                .unwrap();
        // smallest→largest for consumers; final entry is the full image.
        let dims: Vec<(u32, u32)> = levels.iter().map(|l| (l.width, l.height)).collect();
        assert_eq!(dims, vec![(1, 128), (1, 256), (1, 512), (1, 1000)], "cascade not strictly ascending by long edge");
    }

    // Deterministic pseudo-random RGBA source (LCG), α set to a constant 255.
    fn rand_rgba(sw: u32, sh: u32) -> Vec<u8> {
        let n = (sw * sh) as usize;
        let mut v = vec![0u8; n * 4];
        let mut s: u32 = 0x9e37_79b9u32.wrapping_mul(sw).wrapping_add(sh).wrapping_add(1);
        for px in v.chunks_exact_mut(4) {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            px[0] = (s >> 24) as u8;
            px[1] = (s >> 16) as u8;
            px[2] = (s >> 8) as u8;
            px[3] = 255;
        }
        v
    }

    /// The meta-seam invariant: box averaging is per-channel independent, so the RGB-native
    /// downscale must be byte-identical to the 4-channel downscale followed by an alpha strip,
    /// for both the exact-ratio and general-coverage branches.
    #[test]
    fn box_downscale_rgb8_matches_rgba8_then_strip() {
        // (sw, sh, dw, dh): first two exact ratios, last two general (non-divisor).
        let cases = [(8, 8, 4, 4), (12, 9, 4, 3), (7, 5, 3, 2), (13, 11, 5, 4)];
        for (sw, sh, dw, dh) in cases {
            let rgba = rand_rgba(sw, sh);
            let rgb = strip_rgba_to_rgb(&rgba);

            let mut dst_rgba = vec![0u8; (dw * dh * 4) as usize];
            let mut dst_rgb = vec![0u8; (dw * dh * 3) as usize];
            assert!(box_downscale_rgba8(&rgba, sw, sh, &mut dst_rgba, dw, dh));
            assert!(box_downscale_rgb8(&rgb, sw, sh, &mut dst_rgb, dw, dh));

            let stripped = strip_rgba_to_rgb(&dst_rgba);
            assert_eq!(
                stripped, dst_rgb,
                "rgb8 downscale != rgba8+strip at {sw}x{sh}->{dw}x{dh}"
            );
        }
    }

    /// `process_rgb` must be the byte-exact 3ch twin of `process_rgba` (α was a constant 255
    /// the opaque path strips anyway). Guards the meta-seam's upstream half.
    #[test]
    fn process_rgb_matches_process_rgba_stripped() {
        let params = crate::pipeline::PipelineParams::default_olympus();
        // A spread of 16-bit values across the LUT domain.
        let rgb16: Vec<u16> = (0..(13 * 7 * 3)).map(|i| ((i * 911) % 65536) as u16).collect();
        let rgba = crate::pipeline::process_rgba(&rgb16, &params);
        let rgb = crate::pipeline::process_rgb(&rgb16, &params);
        assert_eq!(rgb, strip_rgba_to_rgb(&rgba), "process_rgb != strip(process_rgba)");
    }
}
