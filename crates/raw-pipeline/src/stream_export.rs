//! Fused streaming full-res JXL export: RawRowSource → demosaic_bayer_mhc_band → tone,
//! served to the chunked encoder through rolling raw + RGB8 windows. Byte-identical to the
//! whole-frame export at O(super-tile band) peak. Generic over the row source: ORF
//! (`OrfRowDecoder`, phase (0,0)) and DNG (`DngRowSource`, phased). Native + jxl-codec only.
//!
//! libjxl pulls ≤2048-row super-tiles top-to-bottom (validated monotonic; see
//! `examples/jxl_chunked_pull_order.rs`). On each pull the source materializes the needed
//! rows forward and front-drops what's below the request. Two rolling buffers:
//!   - raw window: decoded Bayer rows [raw_first, raw_decoded); keeps 2 halo rows behind
//!     `produced` so MHC demosaic never re-decodes (RawRowSource is forward-only).
//!   - rgb8 window: toned output rows [win_first, produced).
//! Demosaic+tone run in 256-row sub-chunks so the rgb16 transient stays bounded.
#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]

use crate::decompress::{OrfRowDecoder, RawRowSource};
use crate::demosaic::demosaic_bayer_mhc_band;
use crate::dng::DngRowSource;
use crate::jxl_casaencoder::{encode_chunked, ChunkedColorSource};
use crate::pipeline::{self, PipelineParams};

const SUB_ROWS: usize = 256;

pub struct StreamingExportSource<S: RawRowSource> {
    src: S,
    w: usize,
    h: usize,
    params: PipelineParams,
    nr_strength: f32, // luminance-NR strength (0 = off); external, ISO-derived like the app
    phase: (u8, u8), // R position in the 2x2 (ORF/RGGB = (0,0); DNG per CFA)
    // rolling raw window [raw_first, raw_decoded)
    raw_win: Vec<u16>,
    raw_first: usize,
    raw_decoded: usize,
    // rolling toned RGB8 window [win_first, produced)
    rgb8: Vec<u8>,
    win_first: usize,
    produced: usize,
}

/// Stacked vertical-FIR halo of the look-adjusted (spatial) path: luminance-NR uses a 5-tap
/// blur (half 2), unsharp-clarity a 13-tap blur (half 6). Running them on a band clamps at the
/// band edge; a whole-frame interior row does not. Padding each band by NR-half + clarity-half
/// = 2 + 6 = 8 rows of real data makes the cropped inner rows byte-identical to the whole frame
/// (NR-output exact on local `[2, B_h-3]`; unsharp reads `[r±6]` ⊂ that ⇒ cropped `[8, B_h-9]`
/// fits exactly). The demosaic adds its own 2-row halo on top ⇒ 10 raw halo rows.
const SPATIAL_HALO: usize = 8;

impl<S: RawRowSource> StreamingExportSource<S> {
    pub fn new(
        src: S, w: usize, h: usize, params: PipelineParams, nr_strength: f32, phase: (u8, u8),
    ) -> Self {
        Self {
            src, w, h, params, nr_strength, phase,
            raw_win: Vec::new(), raw_first: 0, raw_decoded: 0,
            rgb8: Vec::new(), win_first: 0, produced: 0,
        }
    }

    /// True when a spatial (halo-needing) look op is active. Off ⇒ the tone-only fast path
    /// (2-row halo, byte-exact as before); on ⇒ the deep-halo fresh-recompute band path.
    #[inline]
    fn spatial_active(&self) -> bool {
        self.nr_strength > 0.0 || self.params.texture != 0.0 || self.params.clarity != 0.0
    }

    #[inline]
    fn raw_row(&self, g_clamped: usize) -> &[u16] {
        let li = g_clamped - self.raw_first;
        &self.raw_win[li * self.w..li * self.w + self.w]
    }

    /// Materialize toned RGB8 rows forward until `produced >= target` (clamped to h).
    /// Tone-only when no spatial look op is active (2-row halo, byte-exact); otherwise the
    /// deep-halo band path that also runs luminance-NR + unsharp (still byte-exact).
    fn extend_to(&mut self, target: usize) -> Result<(), String> {
        let target = target.min(self.h);
        if self.produced >= target {
            return Ok(());
        }
        if self.spatial_active() {
            self.extend_to_spatial(target)
        } else {
            self.extend_to_tone_only(target)
        }
    }

    fn extend_to_tone_only(&mut self, target: usize) -> Result<(), String> {
        let (w, h) = (self.w, self.h);

        // 1) decode raw forward to target+2 (bottom halo), clamped at image end.
        let need_raw = (target + 2).min(h);
        let mut rowbuf = vec![0u16; w];
        while self.raw_decoded < need_raw {
            if !self.src.next_row_into(&mut rowbuf)? {
                break;
            }
            self.raw_win.extend_from_slice(&rowbuf);
            self.raw_decoded += 1;
        }

        // 2) demosaic+tone in 256-row sub-chunks (each with its own 2-row halo from the
        //    rolling raw window → chunking-independent, byte-exact with the whole demosaic).
        let mut rgb16: Vec<u16> = Vec::new();
        let mut s0 = self.produced;
        while s0 < target {
            let s1 = (s0 + SUB_ROWS).min(target);
            let ns = s1 - s0;
            // demosaic_bayer_mhc_band derives CFA parity from the local ctx row; with an even
            // halo the local parity matches the global row only when s0 is even. Pull ypos are
            // multiples of 8 and sub-chunks step by 256, so s0 is always even.
            debug_assert_eq!(s0 % 2, 0, "sub-chunk start must be even for correct CFA phase");
            let ctx_h = ns + 4; // 2 halo above + ns band + 2 halo below
            let mut ctx = vec![0u16; ctx_h * w];
            for i in 0..ctx_h {
                let g = (s0 as isize - 2 + i as isize).clamp(0, h as isize - 1) as usize;
                ctx[i * w..i * w + w].copy_from_slice(self.raw_row(g));
            }
            rgb16.resize(ns * w * 3, 0);
            demosaic_bayer_mhc_band(&ctx, w, ctx_h, 2, self.phase, 0, ns, &mut rgb16)?;
            let start = self.rgb8.len();
            self.rgb8.resize(start + ns * w * 3, 0);
            pipeline::process_into_auto(&rgb16, &self.params, &mut self.rgb8[start..]);
            s0 = s1;
        }
        self.produced = target;

        // 3) front-drop raw rows below produced-2 (keep 2 halo for the next extend).
        let keep_from = self.produced.saturating_sub(2);
        if keep_from > self.raw_first {
            let drop_rows = keep_from - self.raw_first;
            self.raw_win.drain(0..drop_rows * w);
            self.raw_first = keep_from;
        }
        Ok(())
    }

    /// Look-adjusted band path: demosaic a band padded by `SPATIAL_HALO` real rows each side,
    /// run luminance-NR + unsharp on the padded band, then crop the inner rows and tone them.
    /// The extra halo makes the cropped rows byte-identical to the whole-frame
    /// `demosaic → NR → unsharp → tone` (fresh recompute per band — no residual carried across
    /// bands, so nothing accumulates). Order matches the app (lib.rs): NR before unsharp.
    fn extend_to_spatial(&mut self, target: usize) -> Result<(), String> {
        let (w, h) = (self.w, self.h);

        // 1) decode raw forward to target + spatial halo + demosaic halo, clamped at image end.
        let need_raw = (target + SPATIAL_HALO + 2).min(h);
        let mut rowbuf = vec![0u16; w];
        while self.raw_decoded < need_raw {
            if !self.src.next_row_into(&mut rowbuf)? {
                break;
            }
            self.raw_win.extend_from_slice(&rowbuf);
            self.raw_decoded += 1;
        }

        // 2) per 256-row sub-chunk: demosaic a band padded by SPATIAL_HALO real rows each side,
        //    apply NR + unsharp on the padded band, then crop the inner rows and tone them.
        let mut rgb16: Vec<u16> = Vec::new();
        let mut s0 = self.produced;
        while s0 < target {
            let s1 = (s0 + SUB_ROWS).min(target);
            let ns = s1 - s0;
            debug_assert_eq!(s0 % 2, 0, "sub-chunk start must be even for correct CFA phase");
            // Padded band [b_lo, b_hi): halo rows of real data (clamped to the image). b_lo stays
            // even (s0 even, SPATIAL_HALO even, or 0) so the CFA parity is preserved; at the image
            // top/bottom the clamp coincides with the whole-frame clamp ⇒ still byte-exact.
            let b_lo = s0.saturating_sub(SPATIAL_HALO);
            let b_hi = (s1 + SPATIAL_HALO).min(h);
            let b_h = b_hi - b_lo;
            debug_assert_eq!(b_lo % 2, 0, "band start must be even for correct CFA phase");
            // Demosaic the padded band (its own 2-row halo read from the rolling raw window).
            let ctx_h = b_h + 4;
            let mut ctx = vec![0u16; ctx_h * w];
            for i in 0..ctx_h {
                let g = (b_lo as isize - 2 + i as isize).clamp(0, h as isize - 1) as usize;
                ctx[i * w..i * w + w].copy_from_slice(self.raw_row(g));
            }
            rgb16.resize(b_h * w * 3, 0);
            demosaic_bayer_mhc_band(&ctx, w, ctx_h, 2, self.phase, 0, b_h, &mut rgb16)?;
            // Spatial look ops in place on the padded band (matches app order: NR → unsharp).
            if self.nr_strength > 0.0 {
                pipeline::apply_luminance_nr(&mut rgb16, w, b_h, self.nr_strength);
            }
            pipeline::apply_unsharp_masks(&mut rgb16, w, b_h, &self.params);
            // Crop the inner rows [s0, s1) out of the padded band and tone them into the window.
            let src_off = (s0 - b_lo) * w * 3;
            let start = self.rgb8.len();
            self.rgb8.resize(start + ns * w * 3, 0);
            pipeline::process_into_auto(
                &rgb16[src_off..src_off + ns * w * 3], &self.params, &mut self.rgb8[start..],
            );
            s0 = s1;
        }
        self.produced = target;

        // 3) front-drop raw rows below produced-(halo) (keep the halo for the next band's top).
        let keep_from = self.produced.saturating_sub(SPATIAL_HALO + 2);
        if keep_from > self.raw_first {
            let drop_rows = keep_from - self.raw_first;
            self.raw_win.drain(0..drop_rows * w);
            self.raw_first = keep_from;
        }
        Ok(())
    }

    fn drop_front_to(&mut self, y: usize) {
        if y > self.win_first {
            let drop = (y - self.win_first).min(self.produced - self.win_first) * self.w * 3;
            self.rgb8.drain(0..drop);
            self.win_first += drop / (self.w * 3);
        }
    }
}

impl<S: RawRowSource> ChunkedColorSource for StreamingExportSource<S> {
    fn num_channels(&self) -> u32 { 3 }
    fn rect(&mut self, xpos: usize, ypos: usize, _xs: usize, ysize: usize) -> (*const u8, usize) {
        assert!(ypos >= self.win_first, "non-monotonic pull ypos {} < win_first {}", ypos, self.win_first);
        self.drop_front_to(ypos);
        self.extend_to(ypos + ysize).expect("streaming decode/demosaic failed");
        let stride = self.w * 3;
        let off = (ypos - self.win_first) * stride + xpos * 3;
        (unsafe { self.rgb8.as_ptr().add(off) }, stride)
    }
}

/// Export a full-res JXL from an ORF strip bitstream (no container) — the testable core.
/// `nr_strength > 0` and/or `params.texture`/`params.clarity != 0` engage the look-adjusted
/// (spatial band-halo) path; all-zero keeps the tone-only path.
pub fn export_jxl_streaming_from_strip(
    strip: &[u8], w: usize, h: usize, params: PipelineParams, nr_strength: f32,
    distance: f32, effort: i64, out: &mut Vec<u8>,
) -> Result<(), String> {
    let src = OrfRowDecoder::new(strip, w, h)?;
    let mut s = StreamingExportSource::new(src, w, h, params, nr_strength, (0, 0));
    encode_chunked(w as u32, h as u32, distance, effort, &mut s, out).map_err(|e| format!("{e:?}"))
}

/// Export a full-res JXL from ORF container bytes (parses TIFF, then streams).
pub fn export_orf_jxl_streaming(
    orf: &[u8], distance: f32, effort: i64, out: &mut Vec<u8>,
) -> Result<(usize, usize), String> {
    let info = crate::tiff::parse(orf).map_err(|e| format!("tiff::parse: {e}"))?;
    let w = info.width as usize;
    let h = info.height as usize;
    let end = (info.strip_offset as usize)
        .checked_add(info.strip_byte_count as usize)
        .ok_or("strip range overflow")?;
    let strip = orf.get(info.strip_offset as usize..end).ok_or("strip OOB")?;
    let mut params = PipelineParams::default_olympus();
    params.black = 256; // Olympus 12-bit pedestal (matches decode_orf_raw)
    if let Some(r) = info.wb_r { params.wb_r = r; }
    if let Some(b) = info.wb_b { params.wb_b = b; }
    if let Some(m) = info.color_matrix { params.color_matrix = Some(m); }
    // Container entry stays tone-only (nr_strength = 0); spatial look is driven through the
    // `_from_strip` core / `StreamingExportSource` directly (params carries texture/clarity).
    export_jxl_streaming_from_strip(strip, w, h, params, 0.0, distance, effort, out)?;
    Ok((w, h))
}

/// Export a full-res JXL from DNG container bytes (comp=7 tiled or comp=1 uncompressed).
/// Byte-identical to `decode_bytes → demosaic_bayer_mhc(phase) → tone → encode`.
pub fn export_dng_jxl_streaming(
    dng: &[u8], distance: f32, effort: i64, out: &mut Vec<u8>,
) -> Result<(usize, usize), String> {
    let src = DngRowSource::new(dng)?;
    let phase = src.phase();
    let (w, h, black, white, wb_r, wb_b, cm) = {
        let m = src.meta();
        (m.width, m.height, m.black, m.white, m.wb_r, m.wb_b, m.color_matrix)
    };
    let mut params = PipelineParams::default_olympus();
    params.black = black;
    params.white = white;
    params.wb_r = wb_r;
    params.wb_b = wb_b;
    params.color_matrix = cm;
    let mut s = StreamingExportSource::new(src, w, h, params, 0.0, phase);
    encode_chunked(w as u32, h as u32, distance, effort, &mut s, out).map_err(|e| format!("{e:?}"))?;
    Ok((w, h))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{decompress, demosaic};

    #[test]
    fn streaming_source_matches_whole() {
        for (w, h) in [(64usize, 96usize), (66, 130), (17, 300), (40, 700)] {
            let strip = decompress::tests_synth_payload(w, h, 0xEE11);
            let raw = decompress::decompress(&strip, w, h).unwrap();
            let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
            let params = pipeline::PipelineParams::default_olympus();
            let mut want = vec![0u8; w * h * 3];
            pipeline::process_into_auto(&rgb16, &params, &mut want);

            let src = OrfRowDecoder::new(&strip, w, h).unwrap();
            let mut ss = StreamingExportSource::new(src, w, h, params.clone(), 0.0, (0, 0));
            let mut got = vec![0u8; w * h * 3];
            let band = 64usize;
            let mut y = 0usize;
            while y < h {
                let ys = (band + 2).min(h - y);
                let (p, stride) = ss.rect(0, y, w, ys);
                for r in 0..ys {
                    let gy = y + r;
                    unsafe {
                        let srow = std::slice::from_raw_parts(p.add(r * stride), w * 3);
                        got[gy * w * 3..gy * w * 3 + w * 3].copy_from_slice(srow);
                    }
                }
                y += band;
            }
            assert_eq!(got, want, "{}x{}", w, h);
        }
    }

    #[test]
    fn streaming_export_bytes_equal_whole() {
        use crate::jxl_casaencoder::encode_chunked_rgb8;
        for (w, h) in [(64usize, 96usize), (300, 520)] {
            let strip = decompress::tests_synth_payload(w, h, 0x7A5);
            let params = pipeline::PipelineParams::default_olympus();
            let raw = decompress::decompress(&strip, w, h).unwrap();
            let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
            let mut rgb8 = vec![0u8; w * h * 3];
            pipeline::process_into_auto(&rgb16, &params, &mut rgb8);
            let whole = encode_chunked_rgb8(&rgb8, w as u32, h as u32, 1.0, 3).unwrap();
            let mut streamed = Vec::new();
            export_jxl_streaming_from_strip(&strip, w, h, params.clone(), 0.0, 1.0, 3, &mut streamed).unwrap();
            assert_eq!(streamed, whole, "export bytes differ {}x{}", w, h);
        }
    }

    #[test]
    fn streaming_export_lossless_bytes_equal_whole() {
        use crate::jxl_casaencoder::{EncodeOptions, Encoder, Frame};
        for (w, h) in [(64usize, 96usize), (300, 520)] {
            let strip = decompress::tests_synth_payload(w, h, 0x7A5);
            let params = pipeline::PipelineParams::default_olympus();
            let raw = decompress::decompress(&strip, w, h).unwrap();
            let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
            let mut rgb8 = vec![0u8; w * h * 3];
            pipeline::process_into_auto(&rgb16, &params, &mut rgb8);
            let mut enc = Encoder::with_threads(EncodeOptions::lossless().with_effort(2), 1).unwrap();
            let mut whole = Vec::new();
            enc.encode_into(&Frame::rgb(&rgb8, w as u32, h as u32), &mut whole).unwrap();
            let mut streamed = Vec::new();
            export_jxl_streaming_from_strip(&strip, w, h, params.clone(), 0.0, 0.0, 2, &mut streamed).unwrap();
            assert_eq!(streamed, whole, "lossless export bytes differ {}x{}", w, h);
        }
    }

    #[test]
    fn streaming_export_spatial_source_matches_whole() {
        // NR + unsharp (texture + clarity) all active: the band-halo streamed pixels must equal
        // the whole-frame `demosaic → NR → unsharp → tone`. band=300 crosses the 256-row
        // sub-chunk split; sizes cover image-edge clamp, odd width, and multiple pulls.
        for (w, h) in [(64usize, 96usize), (66, 200), (40, 540), (300, 620)] {
            let strip = decompress::tests_synth_payload(w, h, 0x5EED);
            let mut params = pipeline::PipelineParams::default_olympus();
            params.texture = 0.7;
            params.clarity = 0.5;
            let nr = 0.3f32;

            let raw = decompress::decompress(&strip, w, h).unwrap();
            let mut rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
            pipeline::apply_luminance_nr(&mut rgb16, w, h, nr);
            pipeline::apply_unsharp_masks(&mut rgb16, w, h, &params);
            let mut want = vec![0u8; w * h * 3];
            pipeline::process_into_auto(&rgb16, &params, &mut want);

            let src = OrfRowDecoder::new(&strip, w, h).unwrap();
            let mut ss = StreamingExportSource::new(src, w, h, params.clone(), nr, (0, 0));
            let mut got = vec![0u8; w * h * 3];
            let band = 300usize;
            let mut y = 0usize;
            while y < h {
                let ys = band.min(h - y);
                let (p, stride) = ss.rect(0, y, w, ys);
                for r in 0..ys {
                    let gy = y + r;
                    unsafe {
                        let srow = std::slice::from_raw_parts(p.add(r * stride), w * 3);
                        got[gy * w * 3..gy * w * 3 + w * 3].copy_from_slice(srow);
                    }
                }
                y += band;
            }
            assert_eq!(got, want, "spatial {}x{}", w, h);
        }
    }

    #[test]
    fn streaming_export_spatial_bytes_equal_whole() {
        // End-to-end: streamed look-adjusted JXL bytes == whole-frame look-adjusted JXL bytes.
        use crate::jxl_casaencoder::encode_chunked_rgb8;
        for (w, h) in [(64usize, 96usize), (300, 520)] {
            let strip = decompress::tests_synth_payload(w, h, 0x5EED);
            let mut params = pipeline::PipelineParams::default_olympus();
            params.texture = 0.7;
            params.clarity = 0.5;
            let nr = 0.3f32;

            let raw = decompress::decompress(&strip, w, h).unwrap();
            let mut rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
            pipeline::apply_luminance_nr(&mut rgb16, w, h, nr);
            pipeline::apply_unsharp_masks(&mut rgb16, w, h, &params);
            let mut rgb8 = vec![0u8; w * h * 3];
            pipeline::process_into_auto(&rgb16, &params, &mut rgb8);
            let whole = encode_chunked_rgb8(&rgb8, w as u32, h as u32, 1.0, 3).unwrap();

            let mut streamed = Vec::new();
            export_jxl_streaming_from_strip(&strip, w, h, params.clone(), nr, 1.0, 3, &mut streamed).unwrap();
            assert_eq!(streamed, whole, "spatial export bytes differ {}x{}", w, h);
        }
    }
}
