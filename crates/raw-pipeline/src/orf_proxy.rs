//! Embedded-JPEG PROXY decode path for ORF (and any TIFF-container RAW that embeds
//! a preview JPEG). For a view/delivery target whose long edge is ≤ the embedded
//! preview's, decoding the camera's baked preview JPEG + downscaling is ~5-30× cheaper
//! than the full decompress→demosaic→tone pipeline (measured: examples/orf_proxy_vs_full).
//!
//! SEMANTICS: the output is the CAMERA's 8-bit, already-rendered preview (baked WB /
//! tone / sharpening), NOT the custom RAW pipeline. Use only for view/gallery/proxy/
//! quick-export where camera rendering is acceptable; the full pipeline remains the
//! path for edit / high-quality / >preview-resolution / 16-bit output.
//!
//! Extraction is decode-validated (not byte-span heuristics): Olympus previews embed a
//! nested EXIF thumbnail SOI, so we hand each candidate SOI to the JPEG decoder — which
//! finds the true EOI and ignores trailing bytes — and keep the largest that decodes.
//! The scan is bounded by the raw strip so stray 0xFFD8/0xFFD9 bytes inside the
//! compressed mosaic can't produce a bogus blob (the failure mode of
//! `tiff::find_embedded_jpeg_range`'s fixed-window scan; see QUESTIONS 000-logic-19).

use crate::pipeline;
use crate::tiff;

/// Result of a proxy decode: downscaled RGB8 (`w*h*3` bytes) plus the RAW container's
/// authoritative orientation (embedded JPEGs frequently lack their own EXIF).
pub struct ProxyImage {
    pub width: usize,
    pub height: usize,
    pub rgb8: Vec<u8>,
    pub orientation: u16,
    /// Native dimensions of the embedded preview that was decoded (pre-downscale),
    /// so a caller can decide whether it was large enough for the target.
    pub preview_w: usize,
    pub preview_h: usize,
}

/// Downscale factor targeting `target_long_edge` on the longer axis (never upscales).
fn target_dims(w: usize, h: usize, target_long_edge: usize) -> (usize, usize) {
    let long = w.max(h);
    if target_long_edge == 0 || long <= target_long_edge {
        return (w, h);
    }
    if w >= h {
        let dw = target_long_edge;
        let dh = ((h * dw + w / 2) / w).max(1);
        (dw, dh)
    } else {
        let dh = target_long_edge;
        let dw = ((w * dh + h / 2) / h).max(1);
        (dw, dh)
    }
}

/// Collect candidate SOI offsets (`FF D8 FF`) in `data[..limit]`.
fn soi_offsets(data: &[u8], limit: usize) -> Vec<usize> {
    let end = limit.min(data.len());
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 2 < end {
        if data[i] == 0xFF && data[i + 1] == 0xD8 && data[i + 2] == 0xFF {
            out.push(i);
            i += 2;
        } else {
            i += 1;
        }
    }
    out
}

/// Decode the largest embedded preview JPEG to RGB8 and downscale so its long edge is
/// `target_long_edge` (0 = keep native preview size). Returns `Err` if the file has no
/// decodable embedded JPEG (caller should fall back to the full RAW pipeline).
pub fn orf_proxy_rgb8(orf: &[u8], target_long_edge: usize) -> Result<ProxyImage, String> {
    let info = tiff::parse(orf).map_err(|e| format!("tiff::parse: {e}"))?;
    let orientation = info.orientation;
    // Bound the JPEG scan by the raw strip: everything below strip_offset is the
    // compressed mosaic (full of stray 0xFFD8/0xFFD9), which must never be scanned.
    let scan_limit = (info.strip_offset as usize).min(orf.len());

    // Decode-validate each candidate; keep the largest by decoded pixel count. The
    // decoder finds each JPEG's true EOI (nested EXIF thumbnails handled correctly);
    // false SOIs in metadata fail fast and are skipped.
    let mut best: Option<(usize, usize, Vec<u8>)> = None; // (w, h, rgb8)
    for soi in soi_offsets(orf, scan_limit) {
        let Ok(img) = image::load_from_memory(&orf[soi..]) else {
            continue;
        };
        let rgb = img.to_rgb8();
        let (jw, jh) = (rgb.width() as usize, rgb.height() as usize);
        let px = jw * jh;
        if best.as_ref().map_or(true, |(bw, bh, _)| px > bw * bh) {
            best = Some((jw, jh, rgb.into_raw()));
        }
    }
    let (pw, ph, rgb8) = best.ok_or_else(|| "no decodable embedded JPEG".to_string())?;

    let (dw, dh) = target_dims(pw, ph, target_long_edge);
    let out = if (dw, dh) == (pw, ph) {
        rgb8
    } else {
        pipeline::downscale_rgb8(&rgb8, pw, ph, dw, dh)
    };
    Ok(ProxyImage {
        width: dw,
        height: dh,
        rgb8: out,
        orientation,
        preview_w: pw,
        preview_h: ph,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_dims_never_upscales_and_keeps_aspect() {
        // long edge already <= target → unchanged
        assert_eq!(target_dims(1600, 1200, 1920), (1600, 1200));
        assert_eq!(target_dims(1200, 1600, 1920), (1200, 1600));
        // landscape 3200×2400 → 1920 long edge
        assert_eq!(target_dims(3200, 2400, 1920), (1920, 1440));
        // portrait 2400×3200 → 1920 long edge on height
        assert_eq!(target_dims(2400, 3200, 1920), (1440, 1920));
        // 0 target = keep native
        assert_eq!(target_dims(3200, 2400, 0), (3200, 2400));
    }

    #[test]
    fn soi_scan_finds_markers_and_skips_overlaps() {
        // two SOIs; the 3rd "FF D8" lacks the trailing FF so is not an SOI start.
        let data = [
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, // SOI @0
            0xAA, 0xBB, 0xFF, 0xD8, 0xFF, 0xDB, // SOI @7
            0xFF, 0xD8, 0x00, // not an SOI (no FF after D8)
        ];
        assert_eq!(soi_offsets(&data, data.len()), vec![0, 7]);
        // limit excludes the second SOI
        assert_eq!(soi_offsets(&data, 5), vec![0]);
    }

    #[test]
    fn orf_proxy_errs_on_non_orf() {
        // Not a TIFF/ORF container → parse error surfaces as Err (caller falls back).
        let junk = vec![0u8; 64];
        assert!(orf_proxy_rgb8(&junk, 1920).is_err());
    }
}
