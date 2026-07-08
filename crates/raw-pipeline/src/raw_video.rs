//! K4: RAW time-lapse → CASV. `RawVideoSource` implements [`VideoFrameSource`]
//! so a sequence of RAW stills (ORF / DNG / CR2) feeds the streaming CASV encoder
//! directly — no PNG / ffmpeg detour.
//!
//! Per frame: sniff format → build a [`StreamingBandSource`] (K1 decode spine) with
//! a **fixed per-sequence look** (flicker-free by construction) → drain full-res RGB8
//! → box-downscale to the target dims into the encoder's ping-pong buffer via the
//! `next_frame_into` override (no per-frame heap frame). Peak ≈ one full-res RGB8
//! transient + two downscaled ping-pong frames + compressed output.
//!
//! Fixed-look rationale: the same look applied to every frame yields maximally-similar,
//! flicker-free frames (handoff decision 2026-07-06 — no temporal smoothing). Sensor
//! metadata (black/white/WB/matrix/CFA phase) still comes per-file from each RAW; for a
//! locked time-lapse from one body these are constant, so colour is stable too.
//!
//! Scene-cut (opt-in, off by default per the no-evidence-free-tunables rule): a
//! luma-mean delta over consecutive frames above a caller threshold forces an I-frame.
//! We deliberately do NOT use `frame_stats` frameHash for this: the hash is a content
//! *fingerprint* (identical-frame dedup), not a change *magnitude* — RAW frames always
//! differ by sensor noise, so a hash-delta trigger would fire every frame. A luma-mean
//! delta is the correct magnitude signal, and this leaves the frameHash algorithm
//! untouched (hard stable contract).

#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use rayon::prelude::*;

use crate::casa_video::{
    encode_casv_video, encode_casv_video_streaming, CasaVideoOptions, SkipMode, VideoError,
    VideoFrameSource, VideoRate,
};
use crate::casabio_encode::box_downscale_rgb8;
use crate::decompress::RawRowSource;
use crate::pipeline::PipelineParams;
use crate::stream_band::StreamingBandSource;

/// Fixed look applied to every frame of a sequence (flicker-free). `None` WB fields
/// keep each file's metadata WB; `Some` overrides it (use for locked-WB time-lapse).
/// All tone fields are the same zero-centred ranges as [`PipelineParams`].
#[derive(Clone, Copy, Debug)]
pub struct RawVideoLook {
    pub exposure_ev: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub saturation: f32,
    pub vibrance: f32,
    pub temp: f32,
    pub tint: f32,
    pub texture: f32,
    pub clarity: f32,
    pub wb_r: Option<f32>,
    pub wb_b: Option<f32>,
}

impl Default for RawVideoLook {
    /// Neutral look (all sliders at 0; keep metadata WB).
    fn default() -> Self {
        Self {
            exposure_ev: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            whites: 0.0,
            blacks: 0.0,
            saturation: 0.0,
            vibrance: 0.0,
            temp: 0.0,
            tint: 0.0,
            texture: 0.0,
            clarity: 0.0,
            wb_r: None,
            wb_b: None,
        }
    }
}

/// Overwrite the look fields of `p` with the fixed sequence look, keeping the
/// per-file sensor fields (black/white/wb_g/matrix) that `from_*_bytes` derived.
fn apply_look(look: &RawVideoLook, p: &mut PipelineParams) {
    p.exposure_ev = look.exposure_ev;
    p.contrast = look.contrast;
    p.highlights = look.highlights;
    p.shadows = look.shadows;
    p.whites = look.whites;
    p.blacks = look.blacks;
    p.saturation = look.saturation;
    p.vibrance = look.vibrance;
    p.temp = look.temp;
    p.tint = look.tint;
    p.texture = look.texture;
    p.clarity = look.clarity;
    if let Some(r) = look.wb_r {
        p.wb_r = r;
    }
    if let Some(b) = look.wb_b {
        p.wb_b = b;
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RawFmt {
    Orf,
    Dng,
    Cr2,
}

/// Sniff the RAW container by magic. CR2 (`II*\0` + `CR`@8) is checked before the
/// generic-TIFF (DNG) branch since it is also little-endian TIFF; ORF has its own
/// distinct magics. No silent ORF fallback — an unknown magic is a typed error.
fn sniff(b: &[u8]) -> Result<RawFmt, VideoError> {
    if b.len() < 16 {
        return Err(VideoError::Raw(format!("file too small ({} bytes)", b.len())));
    }
    // CR2: little-endian TIFF with the Canon "CR" marker at offset 8.
    if b[0] == 0x49 && b[1] == 0x49 && b[2] == 0x2A && b[3] == 0x00 && b[8] == b'C' && b[9] == b'R'
    {
        return Ok(RawFmt::Cr2);
    }
    // ORF: Olympus raw magics (LE IIRO/IIRS/IIUS, BE MMOR/MMMR).
    match &b[0..4] {
        b"IIRO" | b"IIRS" | b"IIUS" | b"MMOR" | b"MMMR" => return Ok(RawFmt::Orf),
        _ => {}
    }
    // Generic TIFF (LE II*\0 / BE MM\0*) → DNG.
    if (b[0] == 0x49 && b[1] == 0x49 && b[2] == 0x2A && b[3] == 0x00)
        || (b[0] == 0x4D && b[1] == 0x4D && b[2] == 0x00 && b[3] == 0x2A)
    {
        return Ok(RawFmt::Dng);
    }
    Err(VideoError::Raw(format!(
        "unrecognized RAW magic {:02X?}",
        &b[0..4]
    )))
}

/// Pull the whole frame from a band source into `out` (native full-res RGB8). Pulls
/// in monotonic top-to-bottom row chunks so the band source keeps only ~a chunk +
/// halo resident; `out` accumulates the full frame (the downscale needs it whole).
fn drain_full_rgb8<S: RawRowSource>(bs: &mut StreamingBandSource<S>, out: &mut Vec<u8>) {
    let w = bs.width();
    let h = bs.height();
    let rowbytes = w * 3;
    out.clear();
    out.resize(rowbytes * h, 0);
    const CHUNK: usize = 256;
    let mut y = 0usize;
    while y < h {
        let ys = CHUNK.min(h - y);
        let (ptr, stride) = bs.band(0, y, w, ys);
        for r in 0..ys {
            let dst_off = (y + r) * rowbytes;
            // SAFETY: band() guarantees `ys` valid rows of `w` px starting at `ptr`
            // with `stride` bytes between rows; we read exactly `rowbytes` (≤ stride)
            // per row into a buffer sized `h * rowbytes`.
            let srcrow = unsafe { std::slice::from_raw_parts(ptr.add(r * stride), rowbytes) };
            out[dst_off..dst_off + rowbytes].copy_from_slice(srcrow);
        }
        y += ys;
    }
}

/// Decode one RAW into full-res RGB8 (into `out`) with the fixed look applied.
/// Returns the native (width, height).
fn decode_raw_full(
    bytes: &[u8],
    look: &RawVideoLook,
    nr: f32,
    out: &mut Vec<u8>,
) -> Result<(usize, usize), VideoError> {
    match sniff(bytes)? {
        RawFmt::Orf => {
            let mut bs = StreamingBandSource::from_orf_bytes(bytes, nr).map_err(VideoError::Raw)?;
            apply_look(look, bs.params_mut());
            let d = (bs.width(), bs.height());
            drain_full_rgb8(&mut bs, out);
            Ok(d)
        }
        RawFmt::Dng => {
            let mut bs = StreamingBandSource::from_dng_bytes(bytes, nr).map_err(VideoError::Raw)?;
            apply_look(look, bs.params_mut());
            let d = (bs.width(), bs.height());
            drain_full_rgb8(&mut bs, out);
            Ok(d)
        }
        RawFmt::Cr2 => {
            let mut bs = StreamingBandSource::from_cr2_bytes(bytes, nr).map_err(VideoError::Raw)?;
            apply_look(look, bs.params_mut());
            let d = (bs.width(), bs.height());
            drain_full_rgb8(&mut bs, out);
            Ok(d)
        }
    }
}

/// Decode one RAW file straight to its downscaled (or exact) target RGB8 frame —
/// the exact per-frame work `next_frame_into` performs for the batch tiers, minus
/// the scene-cut / `force_iframe` bookkeeping (the batch encoder never consults it).
/// Self-contained and independent of any other frame, so a whole sequence can be
/// decoded across frames in parallel and stay byte-identical to a serial drain.
fn decode_frame_downscaled(
    path: &Path,
    look: &RawVideoLook,
    nr: f32,
    dw: u32,
    dh: u32,
) -> Result<Vec<u8>, VideoError> {
    let bytes =
        std::fs::read(path).map_err(|e| VideoError::Raw(format!("read {}: {e}", path.display())))?;
    let mut full = Vec::new();
    let (w, h) = decode_raw_full(&bytes, look, nr, &mut full)?;
    let (dwu, dhu) = (dw as usize, dh as usize);
    if dwu == w && dhu == h {
        // Exact target: the native frame is the output — mirror of the
        // `buf.extend_from_slice(src)` fast path in `next_frame_into`.
        full.truncate(w * h * 3);
        Ok(full)
    } else {
        let src = &full[..w * h * 3];
        let mut out = vec![0u8; dwu * dhu * 3];
        if box_downscale_rgb8(src, w as u32, h as u32, &mut out, dw, dh) {
            Ok(out)
        } else {
            Err(VideoError::Raw(format!("downscale {w}x{h} -> {dw}x{dh} failed")))
        }
    }
}

/// Integer BT.601 luma mean of a packed RGB8 frame (scene-cut magnitude).
fn luma_mean_rgb8(px: &[u8]) -> f32 {
    let n = px.len() / 3;
    if n == 0 {
        return 0.0;
    }
    let mut sum = 0u64;
    for c in px.chunks_exact(3) {
        sum += ((77 * c[0] as u32 + 150 * c[1] as u32 + 29 * c[2] as u32) >> 8) as u64;
    }
    sum as f32 / n as f32
}

/// Aspect-preserving target dims: `None` = native (exact); `Some(cap)` scales the
/// longest edge down to `cap` (never up).
fn target_dims(w: usize, h: usize, max_px: Option<u32>) -> (u32, u32) {
    match max_px {
        None => (w as u32, h as u32),
        Some(cap) => {
            let long = w.max(h) as f32;
            if cap == 0 || cap as f32 >= long {
                (w as u32, h as u32)
            } else {
                let s = cap as f32 / long;
                (
                    ((w as f32 * s).round() as u32).max(1),
                    ((h as f32 * s).round() as u32).max(1),
                )
            }
        }
    }
}

/// A [`VideoFrameSource`] over a list of RAW files. Decodes each on demand with a
/// fixed look and downscales to the target dims.
pub struct RawVideoSource {
    files: Vec<PathBuf>,
    idx: usize,
    look: RawVideoLook,
    nr_strength: f32,
    fps_num: u32,
    fps_den: u32,
    dw: u32,
    dh: u32,
    /// Reused full-res RGB8 transient. After `new()` holds frame 0 (`cached_first`).
    full_rgb8: Vec<u8>,
    cur_w: usize,
    cur_h: usize,
    cached_first: bool,
    scene_cut: Option<f32>,
    prev_luma: Option<f32>,
    pending_force_iframe: bool,
    /// Set when a frame fails to decode mid-stream. `next_frame_into` returns `false`
    /// (the trait cannot surface an error), so the caller MUST check `take_error()`
    /// after the encode to distinguish a real end-of-stream from a truncating failure.
    last_err: Option<String>,
}

impl RawVideoSource {
    /// Build from a non-empty list of RAW file paths. Decodes frame 0 immediately to
    /// learn the native dims and cache the first frame. `max_px`: `None` = native
    /// resolution, `Some(cap)` scales the longest edge to `cap`. `scene_cut`: `None`
    /// = pure GOP schedule; `Some(thresh)` forces an I-frame when the luma-mean delta
    /// between consecutive frames exceeds `thresh` (0..255).
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        files: Vec<PathBuf>,
        look: RawVideoLook,
        nr_strength: f32,
        fps_num: u32,
        fps_den: u32,
        max_px: Option<u32>,
        scene_cut: Option<f32>,
    ) -> Result<Self, VideoError> {
        if files.is_empty() {
            return Err(VideoError::Empty);
        }
        let bytes = std::fs::read(&files[0])
            .map_err(|e| VideoError::Raw(format!("read {}: {e}", files[0].display())))?;
        let mut full = Vec::new();
        let (w, h) = decode_raw_full(&bytes, &look, nr_strength, &mut full)?;
        let (dw, dh) = target_dims(w, h, max_px);
        Ok(Self {
            files,
            idx: 0,
            look,
            nr_strength,
            fps_num,
            fps_den,
            dw,
            dh,
            full_rgb8: full,
            cur_w: w,
            cur_h: h,
            cached_first: true,
            scene_cut,
            prev_luma: None,
            pending_force_iframe: false,
            last_err: None,
        })
    }

    /// Take a decode error that aborted the stream, if any. Call after the encode.
    pub fn take_error(&mut self) -> Option<String> {
        self.last_err.take()
    }

    /// Number of frames (RAW files) in the sequence.
    pub fn len(&self) -> usize {
        self.files.len()
    }

    /// Always false — a `RawVideoSource` is built from a non-empty file list.
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    /// Decode frame `idx` (in file order) to its downscaled RGB8 target buffer,
    /// independently of stream position. Byte-identical to the frame `next_frame_into`
    /// would produce at that index. Exposed for the serial-vs-parallel decode A/B.
    pub fn decode_one(&self, idx: usize) -> Result<Vec<u8>, VideoError> {
        decode_frame_downscaled(&self.files[idx], &self.look, self.nr_strength, self.dw, self.dh)
    }

    /// Decode **all** frames concurrently (rayon) into an order-preserving vector of
    /// downscaled RGB8 frames — the parallel counterpart of draining `next_frame` for
    /// the batch tiers (lossless / lossy skip=none), which materialise every frame
    /// before encoding anyway. Each RAW file is an independent decode, so the result is
    /// byte-identical to a serial drain: `par_iter().collect()` preserves file order,
    /// and the first decode error short-circuits the collect. `on_frame(done)` fires
    /// once per completed frame (unordered) for progress reporting.
    ///
    /// Peak memory ≈ all N result frames resident (same as the serial batch drain) plus
    /// up to `rayon::current_num_threads()` full-res decode transients in flight.
    pub fn decode_all_parallel(
        &self,
        on_frame: &(dyn Fn(usize) + Sync),
    ) -> Result<Vec<Vec<u8>>, VideoError> {
        let look = self.look;
        let nr = self.nr_strength;
        let (dw, dh) = (self.dw, self.dh);
        let done = AtomicUsize::new(0);
        self.files
            .par_iter()
            .map(|path| {
                let frame = decode_frame_downscaled(path, &look, nr, dw, dh)?;
                on_frame(done.fetch_add(1, Ordering::Relaxed) + 1);
                Ok(frame)
            })
            .collect()
    }
}

/// Encode a sorted list of RAW stills (ORF / DNG / CR2) directly into a `.casv`,
/// written to `sink`; returns the number of bytes written. This is the
/// programmatic sibling of the `casv_encode --raw-frames` CLI mode (which layers
/// on per-frame progress + audio-free file output).
///
/// Builds a [`RawVideoSource`] with a fixed per-sequence look and routes exactly
/// like that CLI mode:
/// - **streaming, constant-peak** encoder ([`encode_casv_video_streaming`]) for the
///   lossy bbox/tile tiers — holds ~2 downscaled frames + one full-res transient;
/// - **buffered batch** encoder ([`encode_casv_video`]) for the all-frames-resident
///   tiers (lossless, or lossy `skip=none`), where every decoded frame is resident.
///
/// A mid-stream RAW decode failure ends the pull early (the [`VideoFrameSource`]
/// trait cannot surface an error); this surfaces it as [`VideoError::Raw`] instead
/// of silently truncating the video. `look` / `nr_strength` / `fps_*` / `max_px` /
/// `scene_cut` configure the source exactly as [`RawVideoSource::new`]; `opts` is the
/// encoder knob-set.
#[allow(clippy::too_many_arguments)]
pub fn encode_casv_from_raws<W: std::io::Write>(
    files: Vec<PathBuf>,
    look: RawVideoLook,
    nr_strength: f32,
    fps_num: u32,
    fps_den: u32,
    max_px: Option<u32>,
    scene_cut: Option<f32>,
    opts: &CasaVideoOptions,
    sink: &mut W,
) -> Result<usize, VideoError> {
    let mut src =
        RawVideoSource::new(files, look, nr_strength, fps_num, fps_den, max_px, scene_cut)?;
    let (w, h) = src.dims();
    let streaming_capable =
        matches!(opts.rate, VideoRate::Lossy(_)) && !matches!(opts.skip, SkipMode::None);
    let bytes = if streaming_capable {
        let r = encode_casv_video_streaming(&mut src, opts);
        if let Some(err) = src.take_error() {
            return Err(VideoError::Raw(err));
        }
        r?
    } else {
        // Batch tiers (lossless / lossy skip=none) materialise every frame before
        // encoding. Each RAW is an independent decode, so decode the whole sequence
        // concurrently (rayon, order-preserving → byte-identical to the serial drain)
        // rather than one frame at a time ahead of the already-parallel batch encoder.
        // This mirrors the `casv_encode --raw-frames` CLI batch path (which was already
        // parallel); the previous serial `next_frame_into` drain here was leftover
        // drift. The N result frames are the same resident set batch already held; the
        // only added peak is a bounded pool of in-flight full-res decode transients
        // (≤ rayon thread count) — see `decode_all_parallel`'s doc.
        let frames = src.decode_all_parallel(&|_done| {})?;
        if frames.is_empty() {
            return Err(VideoError::Empty);
        }
        let refs: Vec<&[u8]> = frames.iter().map(|v| v.as_slice()).collect();
        encode_casv_video(&refs, w, h, fps_num, fps_den, opts)?
    };
    sink.write_all(&bytes).map_err(|_| VideoError::Io)?;
    Ok(bytes.len())
}

impl VideoFrameSource for RawVideoSource {
    fn dims(&self) -> (u32, u32) {
        (self.dw, self.dh)
    }
    fn fps(&self) -> (u32, u32) {
        (self.fps_num, self.fps_den)
    }
    fn next_frame(&mut self) -> Option<Vec<u8>> {
        let mut v = Vec::new();
        if self.next_frame_into(&mut v) {
            Some(v)
        } else {
            None
        }
    }
    fn next_frame_into(&mut self, buf: &mut Vec<u8>) -> bool {
        if self.idx >= self.files.len() {
            return false;
        }
        // Fill full_rgb8 with this frame's native RGB8.
        if self.idx == 0 && self.cached_first {
            self.cached_first = false; // frame 0 already in full_rgb8 from new()
        } else {
            let bytes = match std::fs::read(&self.files[self.idx]) {
                Ok(b) => b,
                Err(e) => {
                    self.last_err =
                        Some(format!("read {}: {e}", self.files[self.idx].display()));
                    return false;
                }
            };
            let look = self.look;
            match decode_raw_full(&bytes, &look, self.nr_strength, &mut self.full_rgb8) {
                Ok((w, h)) => {
                    self.cur_w = w;
                    self.cur_h = h;
                }
                Err(e) => {
                    self.last_err = Some(format!("frame {}: {e}", self.idx));
                    return false;
                }
            }
        }
        // Produce the downscaled (or exact) frame into the ping-pong buffer.
        let (w, h) = (self.cur_w, self.cur_h);
        let (dw, dh) = (self.dw as usize, self.dh as usize);
        if dw == w && dh == h {
            // Exact dims: move the decoded frame into buf instead of copying it.
            // full_rgb8 and buf ping-pong across frames; the next decode reuses the
            // swapped-out alloc (drain_full_rgb8 clears + resizes + fully overwrites
            // it, so no stale bytes leak into a later frame).
            std::mem::swap(&mut self.full_rgb8, buf);
            buf.truncate(w * h * 3); // decode may leave extra capacity; match the old exact len
        } else {
            let src = &self.full_rgb8[..w * h * 3];
            buf.clear();
            buf.resize(dw * dh * 3, 0);
            if !box_downscale_rgb8(src, w as u32, h as u32, buf, self.dw, self.dh) {
                self.last_err = Some(format!(
                    "downscale {}x{} -> {}x{} failed",
                    w, h, self.dw, self.dh
                ));
                return false;
            }
        }
        // Scene cut (opt-in): luma-mean delta over the downscaled frame.
        if let Some(thresh) = self.scene_cut {
            let m = luma_mean_rgb8(buf);
            self.pending_force_iframe = self.prev_luma.is_some_and(|p| (p - m).abs() > thresh);
            self.prev_luma = Some(m);
        }
        self.idx += 1;
        true
    }
    fn force_iframe(&self) -> bool {
        self.pending_force_iframe
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decompress::{self, OrfRowDecoder};
    use crate::{demosaic, pipeline};

    #[test]
    fn drain_matches_whole_frame() {
        for (w, h) in [(64usize, 96usize), (80, 120), (40, 300)] {
            let strip = decompress::tests_synth_payload(w, h, 0x51);
            let params = pipeline::PipelineParams::default_olympus();
            let raw = decompress::decompress(&strip, w, h).unwrap();
            let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
            let mut want = vec![0u8; w * h * 3];
            pipeline::process_into_auto(&rgb16, &params, &mut want);

            let src = OrfRowDecoder::new(&strip, w, h).unwrap();
            let mut bs = StreamingBandSource::new(src, w, h, params.clone(), 0.0, (0, 0));
            let mut got = Vec::new();
            drain_full_rgb8(&mut bs, &mut got);
            assert_eq!(got, want, "drain != whole {}x{}", w, h);
        }
    }

    #[test]
    fn apply_look_overwrites_tone_keeps_sensor() {
        let mut p = pipeline::PipelineParams::default_olympus();
        p.black = 256;
        p.white = 4095;
        p.color_matrix = pipeline::ColorMatrix::Identity; // was Some(identity); byte-identical
        let mut look = RawVideoLook::default();
        look.exposure_ev = 0.5;
        look.contrast = 0.3;
        look.wb_r = Some(2.1);
        apply_look(&look, &mut p);
        assert_eq!(p.exposure_ev, 0.5);
        assert_eq!(p.contrast, 0.3);
        assert_eq!(p.wb_r, 2.1);
        // sensor fields untouched
        assert_eq!(p.black, 256);
        assert_eq!(p.white, 4095);
        assert!(p.color_matrix.to_option().is_some());
    }

    #[test]
    fn exact_downscale_is_identity() {
        let src = vec![1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; // 2x2
        let mut dst = vec![0u8; 12];
        assert!(box_downscale_rgb8(&src, 2, 2, &mut dst, 2, 2));
        assert_eq!(dst, src);
    }

    #[test]
    fn box_downscale_2to1_averages() {
        let src = vec![
            0u8, 0, 0, 10, 20, 30, // row 0
            40, 60, 80, 100, 120, 140, // row 1
        ];
        let mut dst = vec![0u8; 3];
        assert!(box_downscale_rgb8(&src, 2, 2, &mut dst, 1, 1));
        assert_eq!(
            dst,
            vec![(0 + 10 + 40 + 100) / 4, (0 + 20 + 60 + 120) / 4, (0 + 30 + 80 + 140) / 4]
        );
    }

    #[test]
    fn luma_mean_flat_gray() {
        let px = vec![100u8; 3 * 16];
        assert!((luma_mean_rgb8(&px) - 100.0).abs() < 1.0);
    }

    #[test]
    fn target_dims_caps_longest_edge() {
        assert_eq!(target_dims(6000, 4000, Some(4000)), (4000, 2667));
        assert_eq!(target_dims(4000, 6000, Some(4000)), (2667, 4000));
        assert_eq!(target_dims(1000, 800, Some(4000)), (1000, 800)); // never upscales
        assert_eq!(target_dims(6000, 4000, None), (6000, 4000)); // exact
    }

    #[test]
    fn sniff_recognizes_magics() {
        let mut cr2 = vec![0u8; 16];
        cr2[0] = 0x49;
        cr2[1] = 0x49;
        cr2[2] = 0x2A;
        cr2[3] = 0x00;
        cr2[8] = b'C';
        cr2[9] = b'R';
        assert_eq!(sniff(&cr2).unwrap(), RawFmt::Cr2);

        let mut orf = vec![0u8; 16];
        orf[0..4].copy_from_slice(b"IIRO");
        assert_eq!(sniff(&orf).unwrap(), RawFmt::Orf);

        let mut dng = vec![0u8; 16];
        dng[0] = 0x49;
        dng[1] = 0x49;
        dng[2] = 0x2A;
        dng[3] = 0x00;
        assert_eq!(sniff(&dng).unwrap(), RawFmt::Dng);

        assert!(sniff(&[0u8; 4]).is_err());
    }

    /// Two real Olympus ORF stills from the local capture corpus. Path-gated:
    /// the assertions run only when the files are present (this dev machine),
    /// and the test passes as a no-op elsewhere (CI has no corpus).
    const CORPUS_ORF: [&str; 2] = [
        "C:/995/2026-02-20 Gobabeb To Windhoek/P2200474.ORF",
        "C:/995/2026-02-20 Gobabeb To Windhoek/P2200475 Kissenia capensis.ORF",
    ];

    fn corpus_files() -> Option<Vec<std::path::PathBuf>> {
        let files: Vec<std::path::PathBuf> =
            CORPUS_ORF.iter().map(std::path::PathBuf::from).collect();
        files.iter().all(|p| p.exists()).then_some(files)
    }

    /// K4: a two-file `RawVideoSource` yields exactly two full RGB8 frames, then
    /// end-of-stream, with no decode error.
    #[test]
    fn raw_video_source_two_frames() {
        let Some(files) = corpus_files() else {
            eprintln!("skip raw_video_source_two_frames: corpus ORF files absent");
            return;
        };
        let mut src = RawVideoSource::new(
            files,
            RawVideoLook::default(),
            0.0,
            24,
            1,
            Some(1024), // cap the longest edge so the test stays fast + low-mem
            None,
        )
        .expect("build RawVideoSource");
        let (w, h) = src.dims();
        assert!(w > 0 && h > 0, "non-zero target dims");
        let expected = w as usize * h as usize * 3;
        let f0 = src.next_frame().expect("frame 0");
        assert_eq!(f0.len(), expected, "frame 0 is packed RGB8 at target dims");
        let f1 = src.next_frame().expect("frame 1");
        assert_eq!(f1.len(), expected, "frame 1 is packed RGB8 at target dims");
        assert!(src.next_frame().is_none(), "exactly two frames");
        assert!(src.take_error().is_none(), "no decode error");
    }

    /// K4: the two ORF stills encode end-to-end to a non-empty `.casv` via the
    /// `encode_casv_from_raws` convenience entry (lossy tile streaming tier).
    #[test]
    fn encode_casv_from_raws_two_frames() {
        let Some(files) = corpus_files() else {
            eprintln!("skip encode_casv_from_raws_two_frames: corpus ORF files absent");
            return;
        };
        let opts = CasaVideoOptions::streaming(2.0); // lossy · tile skip · gop 24
        let mut out = Vec::new();
        let n = encode_casv_from_raws(
            files,
            RawVideoLook::default(),
            0.0,
            24,
            1,
            Some(640),
            None,
            &opts,
            &mut out,
        )
        .expect("encode_casv_from_raws");
        assert!(n > 0, "non-empty .casv written");
        assert_eq!(out.len(), n, "byte count matches written buffer");
    }
}
