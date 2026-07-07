//! Additive, behavior-neutral memory preflight for the RAW decode pipeline.
//!
//! `estimate_decode_peak(width, height, output_flags)` projects the peak
//! working-set (bytes) a decode will allocate, and the steady-state bytes it
//! will retain in the returned `ProcessResult`, from image dimensions plus the
//! output-flag combination — WITHOUT running the decode. It is pure arithmetic:
//! no allocation, no I/O, no decode-output effect. Identical result on native
//! and wasm targets, so it is unit-tested natively (this module) and re-exported
//! across the wasm-bindgen boundary by the top-level crate.
//!
//! Intended use: browser-side admission control ("will this decode fit in the
//! ~360 MB WASM heap / my memory budget before I start it?") and the
//! `AssetStore` governor's retained-bytes accounting. See
//! `docs/adr/S3-memory-budget.md` for the derivation and the observed-vs-model
//! relationship.
//!
//! MIRROR: the shipped `web/pkg` is not always rebuilt to surface the
//! wasm-bindgen export, so a pure-JS copy of this exact model lives in
//! `packages/asset-store/src/mem-budget.js` (`estimateDecodePeak`). If you change
//! the buffer model or the OUT_* semantics here, update that mirror too — its
//! parity test (`packages/asset-store/test/mem-budget.test.js`) pins to the same
//! worked numbers this module's `#[test]` block asserts.
//!
//! ## Model (see ADR for the full derivation)
//!
//! Buffers, in bytes, for an `n = width*height`-pixel frame:
//!   * RAW   sensor mosaic  = `n * 2`  (u16, one sample/px)
//!   * RGB16 interleaved     = `n * 6`  (u16 × 3ch — demosaic output, 16-bit
//!                                       master, and display-referred buffers)
//!   * RGB8  interleaved     = `n * 3`  (u8 × 3ch — the JXL-encode buffer)
//!
//! `retained_bytes` is the sum of the buffers that survive in `ProcessResult`
//! for the requested flags (what the caller must budget for as long as it holds
//! the result, before the `take_*` moves hand ownership to JS).
//!
//! `peak_bytes` is the maximum, over the two heavy stages, of the buffers that
//! are simultaneously live during the decode (>= `retained_bytes`):
//!   * **decode stage**: RAW and the RGB16 demosaic output coexist (`8n`).
//!   * **render stage** (only with `OUT_FULL_RGB8` / `OUT_FULL_16` /
//!     `OUT_FULL_DISP16`): the live RGB16, the RGB8 tone output, and — when a
//!     display-referred 16-bit buffer is requested — its orientation transient
//!     coexist. A 90° orientation rotate briefly holds the source and
//!     destination of the rotated buffer at once; the estimate assumes this
//!     transient unless `OUT_NO_ORIENT` is set (the file's true EXIF
//!     orientation is not known at preflight, so we take the conservative,
//!     over-reserving branch).
//!
//! The model counts *logical live bytes*. Observed WASM RSS runs higher
//! (allocator fragmentation, the heap never shrinking, the input container
//! bytes the caller already holds) — empirically ~1.3–1.6× on this pipeline.
//! Over-reserving is the safe direction for admission control, so callers may
//! apply an additional safety multiplier on top of `peak_bytes`.

/// Output-flag bits — mirror of the private `OUT_*` constants in the wasm
/// crate's `src/lib.rs` (`process_orf_with_flags` / `process_dng_with_flags`).
/// Duplicated here so the estimator is testable natively without wasm-bindgen;
/// the wasm crate has a compile-time assert that the two sets agree.
pub const OUT_FULL_RGB8: u32 = 1;
/// 1800 px RGB16 lightbox preview (packed LE, 6 B/px).
pub const OUT_LIGHTBOX: u32 = 2;
/// 360 px RGB16 thumbnail preview (packed LE, 6 B/px).
pub const OUT_THUMB: u32 = 4;
/// Full-resolution RGB16 master (u16 × 3ch).
pub const OUT_FULL_16: u32 = 8;
/// Skip the CPU orientation rotate on the full RGB8 output.
pub const OUT_NO_ORIENT: u32 = 16;
/// Full-resolution display-referred RGB16 (u16 × 3ch, oriented).
pub const OUT_FULL_DISP16: u32 = 32;
/// Mode 3: retain the full RAW u16 mosaic in the result for a deferred full-res
/// finish (`ProcessResult::finish_full_rgb8`) — no second decompress. Not a
/// full-res *output* flag, so the peak/retained model is unaffected; mirrored
/// here only to keep the wasm crate's compile-time flag-parity assert happy.
pub const OUT_RETAIN_RAW: u32 = 64;

/// Long-edge target of the lightbox preview (px). Matches `target_dims(_, 1800)`.
const LIGHTBOX_LONG_EDGE: u64 = 1800;
/// Long-edge target of the thumbnail preview (px). Matches `target_dims(_, 360)`.
const THUMB_LONG_EDGE: u64 = 360;

/// Result of the preflight projection. All byte counts are `u64` and saturate
/// (rather than overflow) on absurd dimensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodePeakEstimate {
    pub width: u32,
    pub height: u32,
    pub output_flags: u32,
    /// `width * height` (saturating).
    pub pixels: u64,
    /// Bytes retained in the returned `ProcessResult` for these flags.
    pub retained_bytes: u64,
    /// Transient working-set high-water during decode (>= `retained_bytes`).
    pub peak_bytes: u64,
}

#[inline]
fn has(flags: u32, bit: u32) -> bool {
    flags & bit != 0
}

/// Long-edge preserving downscale target, mirroring `target_dims` in the wasm
/// crate. Returns the preview pixel count `dw * dh`.
#[inline]
fn preview_pixels(w: u64, h: u64, long_edge: u64) -> u64 {
    if w == 0 || h == 0 {
        return 0;
    }
    if w >= h {
        let lw = w.min(long_edge);
        let lh = ((h * lw) / w).max(1);
        lw * lh
    } else {
        let lh = h.min(long_edge);
        let lw = ((w * lh) / h).max(1);
        lw * lh
    }
}

/// Project the decode peak / retained working set for a frame of the given
/// dimensions and output-flag combination. Pure; see the module docs for the
/// model. `width`/`height` are the *active-area* (post-crop, pre-orientation)
/// pixel dimensions — the same `w`/`h` the ORF path and the `aw`/`ah` the
/// DNG/CR2 path feed the demosaic.
pub fn estimate_decode_peak(width: u32, height: u32, output_flags: u32) -> DecodePeakEstimate {
    let w = width as u64;
    let h = height as u64;
    let n = w.saturating_mul(h);

    // Per-buffer byte sizes for a full-frame buffer (saturating).
    let raw = n.saturating_mul(2); //   u16 mosaic
    let rgb16 = n.saturating_mul(6); // u16 × 3
    let rgb8 = n.saturating_mul(3); //  u8  × 3

    let want_rgb8 = has(output_flags, OUT_FULL_RGB8);
    let want_full16 = has(output_flags, OUT_FULL_16);
    let want_disp16 = has(output_flags, OUT_FULL_DISP16);
    let want_lb = has(output_flags, OUT_LIGHTBOX);
    let want_thumb = has(output_flags, OUT_THUMB);
    let need_full_rgb = want_rgb8 || want_full16 || want_disp16;
    // The true EXIF orientation is unknown at preflight; assume a rotate unless
    // the caller explicitly skips orientation. Conservative (over-reserves).
    let rotate = !has(output_flags, OUT_NO_ORIENT);

    // Retained previews (packed LE, 6 B/px) — allocated in the decode/preview
    // stage and held through render into the result.
    let lb_bytes = if want_lb {
        preview_pixels(w, h, LIGHTBOX_LONG_EDGE).saturating_mul(6)
    } else {
        0
    };
    let thumb_bytes = if want_thumb {
        preview_pixels(w, h, THUMB_LONG_EDGE).saturating_mul(6)
    } else {
        0
    };
    let preview_retained = lb_bytes.saturating_add(thumb_bytes);

    // ---- retained_bytes: what survives in ProcessResult ----
    let mut retained = preview_retained;
    if want_rgb8 {
        retained = retained.saturating_add(rgb8);
    }
    if want_full16 {
        // Held as Vec<u16> (n*3 u16), packed to bytes lazily in take_rgb16_full.
        retained = retained.saturating_add(rgb16);
    }
    if want_disp16 {
        retained = retained.saturating_add(rgb16);
    }

    // ---- peak_bytes: max simultaneously-live over the heavy stages ----
    // Stage 1 — decode + demosaic. When any full-res output is needed the MHC
    // demosaic materializes RGB16 alongside the RAW mosaic. Preview-only decodes
    // also decode the mosaic and build a planar preview of comparable size; we
    // take the same conservative RAW+RGB16 bound (the streaming ¼-res fast path,
    // when eligible, uses far less — documented in the ADR).
    let stage_decode = if need_full_rgb || want_lb || want_thumb {
        raw.saturating_add(rgb16)
    } else {
        0
    };

    // Stage 2 — render (tone / display-referred / orientation).
    let stage_render = if want_rgb8 {
        // RGB16 stays live through tone + disp16; RGB8 is the tone output.
        // disp16 (if requested) briefly doubles under a rotate transient.
        let disp_term = if want_disp16 {
            if rotate {
                rgb16.saturating_mul(2)
            } else {
                rgb16
            }
        } else {
            0
        };
        let during_disp = rgb16.saturating_add(rgb8).saturating_add(disp_term);

        // After RGB16 is moved into the full-16 master (or dropped) and disp16 is
        // done, the RGB8 orientation rotate transiently holds src+dst, alongside
        // the retained full16 / disp16 buffers.
        let orient_rgb8 = if rotate { rgb8.saturating_mul(2) } else { rgb8 };
        let full16_ret = if want_full16 { rgb16 } else { 0 };
        let disp16_ret = if want_disp16 { rgb16 } else { 0 };
        let after_move = orient_rgb8
            .saturating_add(full16_ret)
            .saturating_add(disp16_ret);

        during_disp.max(after_move)
    } else if want_full16 || want_disp16 {
        // No RGB8 tone output; RGB16 live, plus a disp16 rotate transient.
        let disp_term = if want_disp16 {
            if rotate {
                rgb16.saturating_mul(2)
            } else {
                rgb16
            }
        } else {
            0
        };
        rgb16.saturating_add(disp_term)
    } else {
        0
    };

    let peak = stage_decode
        .max(stage_render)
        .saturating_add(preview_retained);

    DecodePeakEstimate {
        width,
        height,
        output_flags,
        pixels: n,
        retained_bytes: retained,
        peak_bytes: peak,
    }
}

/// Convenience: the transient peak only (bytes). This is the number the strategic
/// map names `estimate_decode_peak_bytes()`.
pub fn estimate_decode_peak_bytes(width: u32, height: u32, output_flags: u32) -> u64 {
    estimate_decode_peak(width, height, output_flags).peak_bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    const N24MP_W: u32 = 6000;
    const N24MP_H: u32 = 4000; // 24.0 MP

    #[test]
    fn zero_dims_are_zero() {
        let e = estimate_decode_peak(0, 0, 0xff);
        assert_eq!(e.pixels, 0);
        assert_eq!(e.retained_bytes, 0);
        assert_eq!(e.peak_bytes, 0);
    }

    #[test]
    fn no_flags_no_work() {
        // No outputs requested → no buffers materialized.
        let e = estimate_decode_peak(N24MP_W, N24MP_H, 0);
        assert_eq!(e.retained_bytes, 0);
        assert_eq!(e.peak_bytes, 0);
    }

    #[test]
    fn peak_never_below_retained() {
        // Over a spread of flag combinations, peak must dominate retained.
        for flags in 0u32..64 {
            for (w, h) in [(64u32, 48u32), (4000, 3000), (7728, 5368)] {
                let e = estimate_decode_peak(w, h, flags);
                assert!(
                    e.peak_bytes >= e.retained_bytes,
                    "flags={flags:#x} {w}x{h}: peak {} < retained {}",
                    e.peak_bytes,
                    e.retained_bytes
                );
            }
        }
    }

    #[test]
    fn retained_full_rgb8_is_three_bytes_per_pixel_plus_previews() {
        // Batch-encode flags = RGB8 | LIGHTBOX | THUMB (the shipping "7").
        let flags = OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB;
        let e = estimate_decode_peak(N24MP_W, N24MP_H, flags);
        let n = (N24MP_W as u64) * (N24MP_H as u64);
        let lb = preview_pixels(N24MP_W as u64, N24MP_H as u64, 1800) * 6;
        let thumb = preview_pixels(N24MP_W as u64, N24MP_H as u64, 360) * 6;
        assert_eq!(e.retained_bytes, n * 3 + lb + thumb);
    }

    #[test]
    fn peak_flags7_matches_render_stage_model() {
        // flags 7: decode 8n vs render (rgb16 6n + rgb8 3n = 9n) → 9n + previews.
        let flags = OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB;
        let e = estimate_decode_peak(N24MP_W, N24MP_H, flags);
        let n = (N24MP_W as u64) * (N24MP_H as u64);
        let previews = preview_pixels(N24MP_W as u64, N24MP_H as u64, 1800) * 6
            + preview_pixels(N24MP_W as u64, N24MP_H as u64, 360) * 6;
        assert_eq!(e.peak_bytes, n * 9 + previews);
    }

    #[test]
    fn all_flags_rotate_hits_21n_render_transient() {
        // All output flags, rotate assumed (no OUT_NO_ORIENT): render stage 2a =
        // rgb16(6n) + rgb8(3n) + disp16-rotate(12n) = 21n.
        let flags = OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB | OUT_FULL_16 | OUT_FULL_DISP16;
        let e = estimate_decode_peak(N24MP_W, N24MP_H, flags);
        let n = (N24MP_W as u64) * (N24MP_H as u64);
        let previews = preview_pixels(N24MP_W as u64, N24MP_H as u64, 1800) * 6
            + preview_pixels(N24MP_W as u64, N24MP_H as u64, 360) * 6;
        assert_eq!(e.peak_bytes, n * 21 + previews);
    }

    #[test]
    fn no_orient_removes_the_rotate_transient() {
        let with_rotate =
            estimate_decode_peak(N24MP_W, N24MP_H, OUT_FULL_RGB8 | OUT_FULL_DISP16);
        let no_rotate = estimate_decode_peak(
            N24MP_W,
            N24MP_H,
            OUT_FULL_RGB8 | OUT_FULL_DISP16 | OUT_NO_ORIENT,
        );
        // Rotate assumed: 6n + 3n + 12n = 21n. No-orient: 6n + 3n + 6n = 15n.
        let n = (N24MP_W as u64) * (N24MP_H as u64);
        assert_eq!(with_rotate.peak_bytes, n * 21);
        assert_eq!(no_rotate.peak_bytes, n * 15);
        assert!(no_rotate.peak_bytes < with_rotate.peak_bytes);
    }

    #[test]
    fn preview_only_peak_is_decode_stage_bound() {
        // Preview-only (LIGHTBOX|THUMB): no render stage, peak = decode 8n + previews.
        let flags = OUT_LIGHTBOX | OUT_THUMB;
        let e = estimate_decode_peak(N24MP_W, N24MP_H, flags);
        let n = (N24MP_W as u64) * (N24MP_H as u64);
        let previews = preview_pixels(N24MP_W as u64, N24MP_H as u64, 1800) * 6
            + preview_pixels(N24MP_W as u64, N24MP_H as u64, 360) * 6;
        assert_eq!(e.peak_bytes, n * 8 + previews);
        // Retained is tiny — only the two preview buffers.
        assert_eq!(e.retained_bytes, previews);
    }

    #[test]
    fn monotonic_in_pixels() {
        // More pixels never reduces the peak for a fixed flag set.
        let flags = OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB;
        let small = estimate_decode_peak(2000, 1500, flags).peak_bytes;
        let big = estimate_decode_peak(6000, 4000, flags).peak_bytes;
        assert!(big > small);
    }

    #[test]
    fn saturates_on_absurd_dims_without_panicking() {
        // u32::MAX square would overflow u64 in the naive product; must saturate.
        let e = estimate_decode_peak(u32::MAX, u32::MAX, 0xff);
        assert!(e.peak_bytes > 0);
        assert!(e.retained_bytes > 0);
        // Saturated — no wraparound to a small value.
        assert_eq!(e.peak_bytes, u64::MAX);
    }

    #[test]
    fn preview_pixels_never_upsamples() {
        // Small source below the long edge keeps its own size.
        assert_eq!(preview_pixels(800, 600, 1800), 800 * 600);
        // Large landscape source is capped at the long edge.
        assert_eq!(preview_pixels(6000, 4000, 1800), 1800 * ((4000 * 1800) / 6000));
        // Portrait uses height as the long edge.
        assert_eq!(preview_pixels(4000, 6000, 1800), ((4000 * 1800) / 6000) * 1800);
    }
}
