//! Codec-independent streaming pixel band producer: `RawRowSource` → demosaic band → (optional
//! luminance-NR + unsharp) → tone → RGB8, served through rolling raw + RGB8 windows at
//! O(super-tile band) peak. This is the shared core behind BOTH the native JXL streaming export
//! (`stream_export` wraps this with `encode_chunked`) and the browser streaming export (a
//! wasm-bindgen binding feeds `band()` into the bridge chunked encoder). It has NO dependency on
//! the JXL codec (jxl-ffi), so — unlike `stream_export` — it compiles for wasm32.
//!
//! Consumers pull top-to-bottom in monotonic bands (libjxl super-tiles are ≤2048 rows). On each
//! pull the producer materializes the needed rows forward and front-drops what's below the
//! request. Two rolling buffers:
//!   - raw window: decoded Bayer rows [raw_first, raw_decoded); keeps a halo behind `produced`
//!     so MHC demosaic never re-decodes (RawRowSource is forward-only).
//!   - rgb8 window: toned output rows [win_first, produced).
//! Demosaic (+ spatial ops) + tone run in 256-row sub-chunks so the rgb16 transient stays bounded.

use crate::decompress::{OrfRowDecoder, RawRowSource};
use crate::demosaic::demosaic_bayer_mhc_band;
use crate::dng::DngRowSource;
use crate::pipeline::{self, PipelineParams};

const SUB_ROWS: usize = 256;

/// Stacked vertical-FIR halo of the look-adjusted (spatial) path: luminance-NR uses a 5-tap
/// blur (half 2), unsharp-clarity a 13-tap blur (half 6). Running them on a band clamps at the
/// band edge; a whole-frame interior row does not. Padding each band by NR-half + clarity-half
/// = 2 + 6 = 8 rows of real data makes the cropped inner rows byte-identical to the whole frame
/// (NR-output exact on local `[2, B_h-3]`; unsharp reads `[r±6]` ⊂ that ⇒ cropped `[8, B_h-9]`
/// fits exactly). The demosaic adds its own 2-row halo on top ⇒ 10 raw halo rows.
const SPATIAL_HALO: usize = 8;

pub struct StreamingBandSource<S: RawRowSource> {
    src: S,
    w: usize,
    h: usize,
    params: PipelineParams,
    nr_strength: f32, // luminance-NR strength (0 = off); external, ISO-derived like the app
    phase: (u8, u8),  // R position in the 2x2 (ORF/RGGB = (0,0); DNG per CFA)
    // rolling raw window [raw_first, raw_decoded)
    raw_win: Vec<u16>,
    raw_first: usize,
    raw_decoded: usize,
    // rolling toned RGB8 window [win_first, produced)
    rgb8: Vec<u8>,
    win_first: usize,
    produced: usize,
    // Reused scratch (contents are per-chunk transients): raw row decode buffer,
    // clamped-chunk demosaic context, and the rgb16 demosaic/tone transient. Hoisted
    // from per-call/per-chunk allocations — strictly less allocator traffic (rule #10).
    rowbuf: Vec<u16>,
    ctx: Vec<u16>,
    rgb16: Vec<u16>,
}

/// Append `n` bytes of *unzeroed* tail to `v`, skipping the `resize(.., 0)` memset.
/// Caller contract: the appended region is fully overwritten before any read —
/// `process_into_auto` asserts exact output length and stores every byte. Same
/// reserve-then-commit shape as the encoder output drain (`jxl_casaencoder.rs`),
/// which also hands out spare capacity and commits `len` after the write.
#[inline]
fn extend_for_overwrite(v: &mut Vec<u8>, n: usize) {
    v.reserve(n);
    // SAFETY: capacity ≥ len+n after reserve; u8 has no invalid bit patterns and the
    // new tail is fully overwritten by the immediately following process_into_auto
    // before any byte of it is read.
    unsafe { v.set_len(v.len() + n) };
}

impl<S: RawRowSource> StreamingBandSource<S> {
    pub fn new(
        src: S,
        w: usize,
        h: usize,
        params: PipelineParams,
        nr_strength: f32,
        phase: (u8, u8),
    ) -> Self {
        Self {
            src,
            w,
            h,
            params,
            nr_strength,
            phase,
            raw_win: Vec::new(),
            raw_first: 0,
            raw_decoded: 0,
            rgb8: Vec::new(),
            win_first: 0,
            produced: 0,
            rowbuf: Vec::new(),
            ctx: Vec::new(),
            rgb16: Vec::new(),
        }
    }

    #[inline]
    pub fn width(&self) -> usize {
        self.w
    }
    #[inline]
    pub fn height(&self) -> usize {
        self.h
    }

    /// Materialize toned RGB8 rows for [xpos, ypos, xsize×ysize] and return a pointer to the
    /// first requested pixel plus the row stride in bytes. Pulls MUST be monotonic in `ypos`
    /// (rows below `ypos` are front-dropped). The returned pointer is valid until the next call.
    /// This is the codec-independent core the native `ChunkedColorSource` and the WASM binding
    /// both call.
    pub fn band(
        &mut self,
        xpos: usize,
        ypos: usize,
        _xsize: usize,
        ysize: usize,
    ) -> (*const u8, usize) {
        assert!(
            ypos >= self.win_first,
            "non-monotonic pull ypos {} < win_first {}",
            ypos,
            self.win_first
        );
        self.drop_front_to(ypos);
        self.extend_to(ypos + ysize)
            .expect("streaming decode/demosaic failed");
        let stride = self.w * 3;
        let off = (ypos - self.win_first) * stride + xpos * 3;
        (unsafe { self.rgb8.as_ptr().add(off) }, stride)
    }

    /// True when a spatial (halo-needing) look op is active. Off ⇒ the tone-only fast path
    /// (2-row halo, byte-exact as before); on ⇒ the deep-halo fresh-recompute band path.
    #[inline]
    fn spatial_active(&self) -> bool {
        self.nr_strength > 0.0 || self.params.texture != 0.0 || self.params.clarity != 0.0
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
        self.rowbuf.resize(w, 0);
        while self.raw_decoded < need_raw {
            if !self.src.next_row_into(&mut self.rowbuf)? {
                break;
            }
            self.raw_win.extend_from_slice(&self.rowbuf);
            self.raw_decoded += 1;
        }

        // 2) demosaic+tone in 256-row sub-chunks (each with its own 2-row halo from the
        //    rolling raw window → chunking-independent, byte-exact with the whole demosaic).
        let mut s0 = self.produced;
        while s0 < target {
            let s1 = (s0 + SUB_ROWS).min(target);
            let ns = s1 - s0;
            // demosaic_bayer_mhc_band derives CFA parity from the local ctx row; with an even
            // halo the local parity matches the global row only when s0 is even. Pull ypos are
            // multiples of 8 and sub-chunks step by 256, so s0 is always even.
            debug_assert_eq!(
                s0 % 2,
                0,
                "sub-chunk start must be even for correct CFA phase"
            );
            let ctx_h = ns + 4; // 2 halo above + ns band + 2 halo below
            self.rgb16.resize(ns * w * 3, 0);
            if s0 >= 2 && s1 + 2 <= h {
                // Interior chunk: rows [s0-2, s1+2) are bit-identical to a CONTIGUOUS
                // window of raw_win — hand the borrow straight to the demosaic (no ctx
                // alloc + memset + row-copy). The band demosaic reads exactly ctx_h*w
                // elements and derives the same local parity, so bytes are unchanged.
                let a = (s0 - 2 - self.raw_first) * w;
                let b = (s1 + 2 - self.raw_first) * w;
                demosaic_bayer_mhc_band(
                    &self.raw_win[a..b],
                    w,
                    ctx_h,
                    2,
                    self.phase,
                    0,
                    ns,
                    &mut self.rgb16,
                )?;
            } else {
                // Top/bottom clamp: build the halo context row-by-row (reused scratch).
                self.ctx.resize(ctx_h * w, 0);
                for i in 0..ctx_h {
                    let g = (s0 as isize - 2 + i as isize).clamp(0, h as isize - 1) as usize;
                    let li = g - self.raw_first;
                    self.ctx[i * w..i * w + w].copy_from_slice(&self.raw_win[li * w..li * w + w]);
                }
                demosaic_bayer_mhc_band(
                    &self.ctx,
                    w,
                    ctx_h,
                    2,
                    self.phase,
                    0,
                    ns,
                    &mut self.rgb16,
                )?;
            }
            let start = self.rgb8.len();
            // No dead zero-fill: process_into_auto fully overwrites the appended tail.
            extend_for_overwrite(&mut self.rgb8, ns * w * 3);
            pipeline::process_into_auto(&self.rgb16, &self.params, &mut self.rgb8[start..]);
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
        self.rowbuf.resize(w, 0);
        while self.raw_decoded < need_raw {
            if !self.src.next_row_into(&mut self.rowbuf)? {
                break;
            }
            self.raw_win.extend_from_slice(&self.rowbuf);
            self.raw_decoded += 1;
        }

        // 2) per 256-row sub-chunk: demosaic a band padded by SPATIAL_HALO real rows each side,
        //    apply NR + unsharp on the padded band, then crop the inner rows and tone them.
        let mut s0 = self.produced;
        while s0 < target {
            let s1 = (s0 + SUB_ROWS).min(target);
            let ns = s1 - s0;
            debug_assert_eq!(
                s0 % 2,
                0,
                "sub-chunk start must be even for correct CFA phase"
            );
            // Padded band [b_lo, b_hi): halo rows of real data (clamped to the image). b_lo stays
            // even (s0 even, SPATIAL_HALO even, or 0) so the CFA parity is preserved; at the image
            // top/bottom the clamp coincides with the whole-frame clamp ⇒ still byte-exact.
            let b_lo = s0.saturating_sub(SPATIAL_HALO);
            let b_hi = (s1 + SPATIAL_HALO).min(h);
            let b_h = b_hi - b_lo;
            debug_assert_eq!(b_lo % 2, 0, "band start must be even for correct CFA phase");
            // Demosaic the padded band (its own 2-row halo read from the rolling raw window).
            let ctx_h = b_h + 4;
            self.rgb16.resize(b_h * w * 3, 0);
            if b_lo >= 2 && b_hi + 2 <= h {
                // Interior band: rows [b_lo-2, b_hi+2) are a contiguous raw_win window —
                // borrow it directly (same bytes the copy loop below would assemble).
                let a = (b_lo - 2 - self.raw_first) * w;
                let b = (b_hi + 2 - self.raw_first) * w;
                demosaic_bayer_mhc_band(
                    &self.raw_win[a..b],
                    w,
                    ctx_h,
                    2,
                    self.phase,
                    0,
                    b_h,
                    &mut self.rgb16,
                )?;
            } else {
                self.ctx.resize(ctx_h * w, 0);
                for i in 0..ctx_h {
                    let g = (b_lo as isize - 2 + i as isize).clamp(0, h as isize - 1) as usize;
                    let li = g - self.raw_first;
                    self.ctx[i * w..i * w + w].copy_from_slice(&self.raw_win[li * w..li * w + w]);
                }
                demosaic_bayer_mhc_band(
                    &self.ctx,
                    w,
                    ctx_h,
                    2,
                    self.phase,
                    0,
                    b_h,
                    &mut self.rgb16,
                )?;
            }
            // Spatial look ops in place on the padded band (matches app order: NR → unsharp).
            if self.nr_strength > 0.0 {
                pipeline::apply_luminance_nr(&mut self.rgb16, w, b_h, self.nr_strength);
            }
            pipeline::apply_unsharp_masks(&mut self.rgb16, w, b_h, &self.params);
            // Crop the inner rows [s0, s1) out of the padded band and tone them into the window.
            let src_off = (s0 - b_lo) * w * 3;
            let start = self.rgb8.len();
            // No dead zero-fill: process_into_auto fully overwrites the appended tail.
            extend_for_overwrite(&mut self.rgb8, ns * w * 3);
            pipeline::process_into_auto(
                &self.rgb16[src_off..src_off + ns * w * 3],
                &self.params,
                &mut self.rgb8[start..],
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

/// Build a band producer from ORF container bytes (parses TIFF, derives the strip + params).
/// Single source of truth for the ORF ingest — the native `export_orf_jxl_streaming` and the
/// WASM binding both go through here, so their pixels stay byte-identical.
impl<'a> StreamingBandSource<OrfRowDecoder<'a>> {
    pub fn from_orf_bytes(orf: &'a [u8], nr_strength: f32) -> Result<Self, String> {
        let info = crate::tiff::parse(orf).map_err(|e| format!("tiff::parse: {e}"))?;
        let w = info.width as usize;
        let h = info.height as usize;
        let end = (info.strip_offset as usize)
            .checked_add(info.strip_byte_count as usize)
            .ok_or("strip range overflow")?;
        let strip = orf
            .get(info.strip_offset as usize..end)
            .ok_or("strip OOB")?;
        let mut params = PipelineParams::default_olympus();
        params.black = 256; // Olympus 12-bit pedestal (matches decode_orf_raw)
        if let Some(r) = info.wb_r {
            params.wb_r = r;
        }
        if let Some(b) = info.wb_b {
            params.wb_b = b;
        }
        if let Some(m) = info.color_matrix {
            params.color_matrix = Some(m);
        }
        let src = OrfRowDecoder::new(strip, w, h)?;
        Ok(Self::new(src, w, h, params, nr_strength, (0, 0)))
    }
}

/// Build a band producer from DNG container bytes (comp=7 tiled or comp=1 uncompressed).
/// Single source of truth for the DNG ingest (see `from_orf_bytes`).
impl<'a> StreamingBandSource<DngRowSource<'a>> {
    pub fn from_dng_bytes(dng: &'a [u8], nr_strength: f32) -> Result<Self, String> {
        let src = DngRowSource::new(dng)?;
        let phase = src.phase();
        let (w, h, black, white, wb_r, wb_b, cm) = {
            let m = src.meta();
            (
                m.width,
                m.height,
                m.black,
                m.white,
                m.wb_r,
                m.wb_b,
                m.color_matrix,
            )
        };
        let mut params = PipelineParams::default_olympus();
        params.black = black;
        params.white = white;
        params.wb_r = wb_r;
        params.wb_b = wb_b;
        params.color_matrix = cm;
        Ok(Self::new(src, w, h, params, nr_strength, phase))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decompress::OrfRowDecoder;
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
            let mut ss = StreamingBandSource::new(src, w, h, params.clone(), 0.0, (0, 0));
            let mut got = vec![0u8; w * h * 3];
            let band = 64usize;
            let mut y = 0usize;
            while y < h {
                let ys = (band + 2).min(h - y);
                let (p, stride) = ss.band(0, y, w, ys);
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
    fn streaming_source_matches_whole_bigband() {
        // Pull bands >256 rows so one extend spans multiple 256-row sub-chunks:
        // exercises the interior borrowed-window fast path, the 256-crossing split,
        // the clamped top/bottom copy fallback, a tiny-h frame, and an h just past a
        // chunk boundary (both final chunks bottom-clamped).
        for (w, h) in [(64usize, 96usize), (48, 258), (32, 16), (40, 700)] {
            let strip = decompress::tests_synth_payload(w, h, 0xB16B);
            let raw = decompress::decompress(&strip, w, h).unwrap();
            let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
            let params = pipeline::PipelineParams::default_olympus();
            let mut want = vec![0u8; w * h * 3];
            pipeline::process_into_auto(&rgb16, &params, &mut want);

            let src = OrfRowDecoder::new(&strip, w, h).unwrap();
            let mut ss = StreamingBandSource::new(src, w, h, params.clone(), 0.0, (0, 0));
            let mut got = vec![0u8; w * h * 3];
            let band = 300usize;
            let mut y = 0usize;
            while y < h {
                let ys = band.min(h - y);
                let (p, stride) = ss.band(0, y, w, ys);
                for r in 0..ys {
                    let gy = y + r;
                    unsafe {
                        let srow = std::slice::from_raw_parts(p.add(r * stride), w * 3);
                        got[gy * w * 3..gy * w * 3 + w * 3].copy_from_slice(srow);
                    }
                }
                y += band;
            }
            assert_eq!(got, want, "bigband {}x{}", w, h);
        }
    }

    #[test]
    fn streaming_spatial_source_matches_whole() {
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
            let mut ss = StreamingBandSource::new(src, w, h, params.clone(), nr, (0, 0));
            let mut got = vec![0u8; w * h * 3];
            let band = 300usize;
            let mut y = 0usize;
            while y < h {
                let ys = band.min(h - y);
                let (p, stride) = ss.band(0, y, w, ys);
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
}
