//! Native JXL streaming export: wraps the codec-independent [`StreamingBandSource`] (see
//! `stream_band`) with the JXL chunked encoder so a full-res RAW → JXL export runs at
//! O(super-tile band) peak, byte-identical to the whole-frame export. The pixel band production
//! (rolling windows, demosaic, NR/unsharp, tone) lives in `stream_band` and is WASM-capable; this
//! module adds only the `ChunkedColorSource` bridge + the encode entry points, so it stays
//! jxl-codec + native only. Generic over the row source: ORF (`OrfRowDecoder`, phase (0,0)) and
//! DNG (`DngRowSource`, phased).
#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]

use crate::cr2::Cr2RowSource;
use crate::decompress::{OrfRowDecoder, RawRowSource};
use crate::jxl_casaencoder::{encode_chunked, ChunkedColorSource};
use crate::pipeline::PipelineParams;
use crate::stream_band::StreamingBandSource;

/// Bridge the codec-independent band producer to libjxl's chunked pull input. libjxl pulls
/// ≤2048-row super-tiles top-to-bottom (validated monotonic; see
/// `examples/jxl_chunked_pull_order.rs`), which is exactly `band()`'s contract.
impl<S: RawRowSource> ChunkedColorSource for StreamingBandSource<S> {
    fn num_channels(&self) -> u32 {
        3
    }
    fn rect(&mut self, xpos: usize, ypos: usize, xsize: usize, ysize: usize) -> (*const u8, usize) {
        self.band(xpos, ypos, xsize, ysize)
    }
}

/// Export a full-res JXL from an ORF strip bitstream (no container) — the testable core.
/// `nr_strength > 0` and/or `params.texture`/`params.clarity != 0` engage the look-adjusted
/// (spatial band-halo) path; all-zero keeps the tone-only path.
pub fn export_jxl_streaming_from_strip(
    strip: &[u8],
    w: usize,
    h: usize,
    params: PipelineParams,
    nr_strength: f32,
    distance: f32,
    effort: i64,
    out: &mut Vec<u8>,
) -> Result<(), String> {
    let src = OrfRowDecoder::new(strip, w, h)?;
    let mut s = StreamingBandSource::new(src, w, h, params, nr_strength, (0, 0));
    encode_chunked(w as u32, h as u32, distance, effort, &mut s, out).map_err(|e| format!("{e:?}"))
}

/// Export a full-res JXL from ORF container bytes (parses TIFF, then streams).
/// Container entry stays tone-only (nr_strength = 0); spatial look is driven through the
/// `_from_strip` core / `StreamingBandSource` directly (params carries texture/clarity).
pub fn export_orf_jxl_streaming(
    orf: &[u8],
    distance: f32,
    effort: i64,
    out: &mut Vec<u8>,
) -> Result<(usize, usize), String> {
    let mut s = StreamingBandSource::from_orf_bytes(orf, 0.0)?;
    let (w, h) = (s.width(), s.height());
    encode_chunked(w as u32, h as u32, distance, effort, &mut s, out)
        .map_err(|e| format!("{e:?}"))?;
    Ok((w, h))
}

/// Export a full-res JXL from CR2 container bytes. Decodes LJPEG mosaic upfront
/// (resident buffer) then streams bands — peak ≈ mosaic + one band vs the batch
/// path which holds mosaic + rgb16 + rgb8 simultaneously.
pub fn export_cr2_jxl_streaming(
    cr2: &[u8],
    distance: f32,
    effort: i64,
    out: &mut Vec<u8>,
) -> Result<(usize, usize), String> {
    let mut s = StreamingBandSource::<Cr2RowSource>::from_cr2_bytes(cr2, 0.0)?;
    let (w, h) = (s.width(), s.height());
    encode_chunked(w as u32, h as u32, distance, effort, &mut s, out)
        .map_err(|e| format!("{e:?}"))?;
    Ok((w, h))
}

/// Export a full-res JXL from DNG container bytes (comp=7 tiled or comp=1 uncompressed).
/// Byte-identical to `decode_bytes → demosaic_bayer_mhc(phase) → tone → encode`.
pub fn export_dng_jxl_streaming(
    dng: &[u8],
    distance: f32,
    effort: i64,
    out: &mut Vec<u8>,
) -> Result<(usize, usize), String> {
    let mut s = StreamingBandSource::from_dng_bytes(dng, 0.0)?;
    let (w, h) = (s.width(), s.height());
    encode_chunked(w as u32, h as u32, distance, effort, &mut s, out)
        .map_err(|e| format!("{e:?}"))?;
    Ok((w, h))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jxl_casaencoder::encode_chunked_rgb8;
    use crate::{decompress, demosaic, pipeline};

    /// Whole-frame reference demosaic, using the same WB-scaled gains the streaming
    /// band path applies (stream_band.rs). The no-gains `demosaic_rggb_mhc` entry
    /// point is `MhcGains::UNITY`, correct only for an already-white-balanced
    /// mosaic — comparing the stream against it measures the WB scaling rather than
    /// the streaming.
    fn whole_reference_rgb16(
        raw: &[u16],
        w: usize,
        h: usize,
        params: &pipeline::PipelineParams,
    ) -> Vec<u16> {
        demosaic::demosaic_rggb_mhc_gains(
            raw,
            w,
            h,
            demosaic::MhcGains::from_wb(params.wb_r, params.wb_g, params.wb_b),
        )
        .unwrap()
    }

    #[test]
    fn streaming_export_bytes_equal_whole() {
        for (w, h) in [(64usize, 96usize), (300, 520)] {
            let strip = decompress::tests_synth_payload(w, h, 0x7A5);
            let params = pipeline::PipelineParams::default_olympus();
            let raw = decompress::decompress(&strip, w, h).unwrap();
            let rgb16 = whole_reference_rgb16(&raw, w, h, &params);
            let mut rgb8 = vec![0u8; w * h * 3];
            pipeline::process_into_auto(&rgb16, &params, &mut rgb8);
            let whole = encode_chunked_rgb8(&rgb8, w as u32, h as u32, 1.0, 3).unwrap();
            let mut streamed = Vec::new();
            export_jxl_streaming_from_strip(
                &strip,
                w,
                h,
                params.clone(),
                0.0,
                1.0,
                3,
                &mut streamed,
            )
            .unwrap();
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
            let rgb16 = whole_reference_rgb16(&raw, w, h, &params);
            let mut rgb8 = vec![0u8; w * h * 3];
            pipeline::process_into_auto(&rgb16, &params, &mut rgb8);
            let mut enc =
                Encoder::with_threads(EncodeOptions::lossless().with_effort(2), 1).unwrap();
            let mut whole = Vec::new();
            enc.encode_into(&Frame::rgb(&rgb8, w as u32, h as u32), &mut whole)
                .unwrap();
            let mut streamed = Vec::new();
            export_jxl_streaming_from_strip(
                &strip,
                w,
                h,
                params.clone(),
                0.0,
                0.0,
                2,
                &mut streamed,
            )
            .unwrap();
            assert_eq!(streamed, whole, "lossless export bytes differ {}x{}", w, h);
        }
    }

    #[test]
    fn streaming_export_spatial_bytes_equal_whole() {
        // End-to-end: streamed look-adjusted JXL bytes == whole-frame look-adjusted JXL bytes.
        for (w, h) in [(64usize, 96usize), (300, 520)] {
            let strip = decompress::tests_synth_payload(w, h, 0x5EED);
            let mut params = pipeline::PipelineParams::default_olympus();
            params.texture = 0.7;
            params.clarity = 0.5;
            let nr = 0.3f32;

            let raw = decompress::decompress(&strip, w, h).unwrap();
            let mut rgb16 = whole_reference_rgb16(&raw, w, h, &params);
            pipeline::apply_luminance_nr(&mut rgb16, w, h, nr);
            pipeline::apply_unsharp_masks(&mut rgb16, w, h, &params);
            let mut rgb8 = vec![0u8; w * h * 3];
            pipeline::process_into_auto(&rgb16, &params, &mut rgb8);
            let whole = encode_chunked_rgb8(&rgb8, w as u32, h as u32, 1.0, 3).unwrap();

            let mut streamed = Vec::new();
            export_jxl_streaming_from_strip(
                &strip,
                w,
                h,
                params.clone(),
                nr,
                1.0,
                3,
                &mut streamed,
            )
            .unwrap();
            assert_eq!(streamed, whole, "spatial export bytes differ {}x{}", w, h);
        }
    }
}
