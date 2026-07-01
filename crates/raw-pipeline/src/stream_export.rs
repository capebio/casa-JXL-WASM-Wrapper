//! Fused streaming full-res JXL export: OrfRowDecoder → demosaic_rggb_mhc_band → tone,
//! served to the chunked encoder through rolling raw + RGB8 windows. Byte-identical to the
//! whole-frame export at O(super-tile band) peak. Native + jxl-codec only.
//!
//! libjxl pulls ≤2048-row super-tiles top-to-bottom (validated monotonic; see
//! `examples/jxl_chunked_pull_order.rs`). On each pull the source materializes the needed
//! rows forward and front-drops what's below the request. Two rolling buffers:
//!   - raw window: decoded Bayer rows [raw_first, raw_decoded); keeps 2 halo rows behind
//!     `produced` so MHC demosaic never re-decodes (OrfRowDecoder is forward-only).
//!   - rgb8 window: toned output rows [win_first, produced).
//! Demosaic+tone run in 256-row sub-chunks so the rgb16 transient stays bounded regardless
//! of the (up to ~2048-row) super-tile size.
#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]

use crate::decompress::{OrfRowDecoder, RawRowSource};
use crate::demosaic::demosaic_rggb_mhc_band;
use crate::jxl_casaencoder::{encode_chunked, ChunkedColorSource};
use crate::pipeline::{self, PipelineParams};

const SUB_ROWS: usize = 256;

pub struct StreamingExportSource<'a> {
    dec: OrfRowDecoder<'a>,
    w: usize,
    h: usize,
    params: PipelineParams,
    // rolling raw window [raw_first, raw_decoded)
    raw_win: Vec<u16>,
    raw_first: usize,
    raw_decoded: usize,
    // rolling toned RGB8 window [win_first, produced)
    rgb8: Vec<u8>,
    win_first: usize,
    produced: usize,
}

impl<'a> StreamingExportSource<'a> {
    pub fn new(strip: &'a [u8], w: usize, h: usize, params: PipelineParams) -> Result<Self, String> {
        let dec = OrfRowDecoder::new(strip, w, h)?;
        Ok(Self {
            dec, w, h, params,
            raw_win: Vec::new(), raw_first: 0, raw_decoded: 0,
            rgb8: Vec::new(), win_first: 0, produced: 0,
        })
    }

    #[inline]
    fn raw_row(&self, g_clamped: usize) -> &[u16] {
        let li = g_clamped - self.raw_first;
        &self.raw_win[li * self.w..li * self.w + self.w]
    }

    /// Materialize toned RGB8 rows forward until `produced >= target` (clamped to h).
    fn extend_to(&mut self, target: usize) -> Result<(), String> {
        let target = target.min(self.h);
        if self.produced >= target {
            return Ok(());
        }
        let (w, h) = (self.w, self.h);

        // 1) decode raw forward to target+2 (bottom halo), clamped at image end.
        let need_raw = (target + 2).min(h);
        let mut rowbuf = vec![0u16; w];
        while self.raw_decoded < need_raw {
            if !self.dec.next_row_into(&mut rowbuf)? {
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
            let ctx_h = ns + 4; // 2 halo above + ns band + 2 halo below
            let mut ctx = vec![0u16; ctx_h * w];
            for i in 0..ctx_h {
                let g = (s0 as isize - 2 + i as isize).clamp(0, h as isize - 1) as usize;
                ctx[i * w..i * w + w].copy_from_slice(self.raw_row(g));
            }
            rgb16.resize(ns * w * 3, 0);
            demosaic_rggb_mhc_band(&ctx, w, ctx_h, 2, s0, 0, ns, &mut rgb16)?;
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

    fn drop_front_to(&mut self, y: usize) {
        if y > self.win_first {
            let drop = (y - self.win_first).min(self.produced - self.win_first) * self.w * 3;
            self.rgb8.drain(0..drop);
            self.win_first += drop / (self.w * 3);
        }
    }
}

impl ChunkedColorSource for StreamingExportSource<'_> {
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
pub fn export_jxl_streaming_from_strip(
    strip: &[u8], w: usize, h: usize, params: PipelineParams, distance: f32, effort: i64, out: &mut Vec<u8>,
) -> Result<(), String> {
    let mut src = StreamingExportSource::new(strip, w, h, params)?;
    encode_chunked(w as u32, h as u32, distance, effort, &mut src, out).map_err(|e| format!("{e:?}"))
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
    // Match decode_orf_raw's Olympus black pedestal (256) for full-res parity.
    params.black = 256;
    if let Some(r) = info.wb_r { params.wb_r = r; }
    if let Some(b) = info.wb_b { params.wb_b = b; }
    if let Some(m) = info.color_matrix { params.color_matrix = Some(m); }
    export_jxl_streaming_from_strip(strip, w, h, params, distance, effort, out)?;
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
            // reference: whole decode -> whole MHC demosaic -> whole tone
            let raw = decompress::decompress(&strip, w, h).unwrap();
            let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
            let params = pipeline::PipelineParams::default_olympus();
            let mut want = vec![0u8; w * h * 3];
            pipeline::process_into_auto(&rgb16, &params, &mut want);

            // pull the source in monotonic bands with border overlap (like real libjxl pulls).
            let mut src = StreamingExportSource::new(&strip, w, h, params.clone()).unwrap();
            let mut got = vec![0u8; w * h * 3];
            let band = 64usize;
            let mut y = 0usize;
            while y < h {
                let ys = (band + 2).min(h - y);
                let (p, stride) = src.rect(0, y, w, ys);
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
}
