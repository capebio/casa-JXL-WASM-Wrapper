//! CasaVideo (`.casv`) — an all-intra JPEG-XL video container.
//!
//! Pure container math layered over the BSD-clean `jxl_casaencoder` /
//! `jxl_casadecoder`, exactly as `JXTC` layers spatial tiles. Every frame is an
//! independent JXL codestream (Architecture A); a 32-byte header + an
//! `(offset,len)` index give O(1) random access. Native + `jxl-codec` only.
//!
//! Ergonomic entry — [`encode_casv_video`] + [`CasaVideoOptions`] presets pick the
//! tier and skip mode; the individual `encode_casv_*` functions remain for direct
//! use.
//! ```ignore
//! let casv = encode_casv_video(&frames, w, h, 24, 1, &CasaVideoOptions::streaming(1.0))?;
//! let out  = decode_casv_all_rgb8(&casv).unwrap();
//! // byte-exact archival instead: CasaVideoOptions::lossless_archive()
//! ```
//!
//! GOP delta (P2): `encode_casv_delta_rgb8(frames, w, h, fps_num, fps_den, gop_len, opts)`
//! codes frame `i%gop_len==0` as an I-frame and the rest as wrapping-residual
//! P-frames vs the previous frame (single-reference, lossless ⇒ drift-free).
//!
//! Static skip: `encode_casv_delta_bbox_rgb8(..., gop_len, opts)` codes each
//! P-frame as only the changed bounding rectangle (`CASV_BBOX_FLAG`), so
//! localized-motion content decodes/encodes far fewer pixels. Byte-exact.
//!
//! Per-tile skip: `encode_casv_delta_tiled_rgb8(..., gop_len, tile, opts)` codes
//! only changed tiles (`CASV_TILE_FLAG`, atlas of residual tiles), for scattered
//! multi-region motion. Byte-exact.
//!
//! Lossy tier: `encode_casv_delta_lossy_bbox_rgb8` / `..._lossy_tiled_rgb8` code
//! changed regions (bounding box / tiles, above a `thresh`) as *fresh lossy pixels*
//! and REPLACE them (`CASV_REPLACE_FLAG`), copying unchanged regions — the working
//! lossy inter-frame path (residual-through-VarDCT and `BLEND_ADD` do not work; see
//! the code comment).
//!
//! Streaming: `encode_casv_video_streaming(src: &mut dyn VideoFrameSource, opts)`
//! pulls frames one at a time and encodes I-frames via the chunked constant-peak
//! encoder ([`crate::jxl_casaencoder::encode_chunked`]) + replace-skip P-frames —
//! a whole video without buffering all raw frames (the video ⋈ streaming-export fusion).

#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]

use crate::jxl_casaencoder::{
    encode_chunked, encode_rgb8, EncodeError, EncodeOptions, Encoder, Frame, WholeImageSource,
};
use crate::jxl_casadecoder::{Channels, DecodeOptions, Decoder};
use rayon::prelude::*;

pub const CASV_MAGIC: u32 = 0x5641_5343; // 'CASV' little-endian
pub const CASV_VERSION: u32 = 1;
pub const CASV_HEADER_BYTES: usize = 32;
pub const CASV_INDEX_ENTRY_BYTES: usize = 8;
/// Top bit of an index `len` field flags a P-frame (delta vs previous frame).
/// All-intra files leave it 0, so they remain valid.
pub const CASV_PFRAME_FLAG: u32 = 0x8000_0000;
/// Second flag bit: a P-frame stored as a bounding-box (changed-rectangle) frame.
pub const CASV_BBOX_FLAG: u32 = 0x4000_0000;
/// Third flag bit: a P-frame stored as a tile-grid (changed-tiles) frame.
pub const CASV_TILE_FLAG: u32 = 0x2000_0000;
/// Fourth flag bit: a P-frame whose region payload is *fresh pixels to replace*
/// (not a residual to add). Used by the lossy tier — coding real pixels keeps
/// JXL's perceptual model correct (a residual would be misjudged).
pub const CASV_REPLACE_FLAG: u32 = 0x1000_0000;
/// Header-level flag (CasvHeader.flags bit 1): every frame codestream in this
/// file is FableBraid (crate::fable_braid), not JXL. I-frames are intra images;
/// P-frames are temporal mod-256 deltas against the previous frame (COPY rows
/// make unchanged rows near-free, subsuming the bbox/tile machinery).
/// Bit 1, NOT bit 0: bit 0 is `CASV_HDRFLAG_LOSSY` (JOLT) — the fb8x branch
/// picked bit 0 before JOLT landed and the two collided at integration
/// (every JOLT file mis-routed to the fable decoder).
pub const CASV_HDR_FABLE_FLAG: u32 = 0x0000_0002;

/// All index-entry flag bits (the `len` field's payload mask is the complement).
const CASV_FLAG_BITS: u32 =
    CASV_PFRAME_FLAG | CASV_BBOX_FLAG | CASV_TILE_FLAG | CASV_REPLACE_FLAG;

/// JE-8: high bit of the tile payload's leading `tile_size` u16 selects the v2
/// **square atlas** layout (changed tiles packed into a ceil(sqrt(n))-column
/// grid) instead of the v1 t-wide sliver. Tile sizes are far below 0x8000, so
/// the bit is free; v1 payloads (bit clear) keep decoding unchanged.
pub const CASV_TILE_V2_BIT: u16 = 0x8000;

/// v2 atlas grid for `n` changed tiles: ~square, ceil(sqrt(n)) columns.
#[inline]
fn atlas_grid_v2(n: usize) -> (usize, usize) {
    debug_assert!(n > 0);
    let cols = (n as f64).sqrt().ceil() as usize;
    let rows = n.div_ceil(cols);
    (cols, rows)
}

// ── JOLT rate metadata (CasvHeader.flags layout) ──────────────────────────────
// JOLT (JXL-Optimized Lossy Transport) is the lossy streaming profile of CASV.
// The header `flags` word — previously always 0 — carries the rate signal so a
// player can distinguish archival-lossless from JOLT files and read the encode
// distance/effort without probing frames. Decoders ignore unknown bits, so v1
// files (flags == 0) and v1 readers stay compatible.
//
//   bit 0       CASV_HDRFLAG_LOSSY — the file was encoded with VideoRate::Lossy
//   bits 8..15  quantized butteraugli distance, round(distance * 10), 0..255
//   bits 16..19 libjxl effort (1..10)
/// Header flag bit 0: lossy (JOLT) file.
pub const CASV_HDRFLAG_LOSSY: u32 = 1;

/// Pack the JOLT rate signal into a CasvHeader `flags` word.
pub fn casv_rate_flags(opts: &CasaVideoOptions) -> u32 {
    match opts.rate {
        VideoRate::Lossless => 0,
        VideoRate::Lossy(d) => {
            let d10 = (d * 10.0).round().clamp(0.0, 255.0) as u32;
            let effort = (opts.effort as u32).min(15);
            CASV_HDRFLAG_LOSSY | (d10 << 8) | (effort << 16)
        }
    }
}

#[derive(thiserror::Error, Debug)]
pub enum VideoError {
    #[error("frame encode: {0}")]
    Encode(#[from] crate::jxl_casaencoder::EncodeError),
    #[error("no frames supplied")]
    Empty,
    #[error("frame {idx}: expected {expected} RGB8 bytes, got {got}")]
    FrameSize { idx: usize, expected: usize, got: usize },
    #[error("streaming encode requires the lossy tier (bbox or tile skip)")]
    Unsupported,
    #[error("sink write failed")]
    Io,
}

/// Parsed 32-byte CasaVideo header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CasvHeader {
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub flags: u32,
}

impl CasvHeader {
    /// True when the file carries the JOLT (lossy) rate flag.
    pub fn is_lossy(&self) -> bool {
        self.flags & CASV_HDRFLAG_LOSSY != 0
    }
    /// The encode's butteraugli distance (0.1 steps), if the file is lossy
    /// and the encoder recorded it. `None` for lossless / legacy files.
    pub fn lossy_distance(&self) -> Option<f32> {
        if !self.is_lossy() {
            return None;
        }
        Some(((self.flags >> 8) & 0xFF) as f32 / 10.0)
    }
    /// The recorded libjxl effort (1..10); 0 for lossless / legacy files.
    pub fn rate_effort(&self) -> u8 {
        ((self.flags >> 16) & 0xF) as u8
    }
}

/// Serialize the 32-byte little-endian header.
pub fn build_casv_header(h: &CasvHeader) -> [u8; CASV_HEADER_BYTES] {
    let mut b = [0u8; CASV_HEADER_BYTES];
    b[0..4].copy_from_slice(&CASV_MAGIC.to_le_bytes());
    b[4..8].copy_from_slice(&CASV_VERSION.to_le_bytes());
    b[8..12].copy_from_slice(&h.width.to_le_bytes());
    b[12..16].copy_from_slice(&h.height.to_le_bytes());
    b[16..20].copy_from_slice(&h.frame_count.to_le_bytes());
    b[20..24].copy_from_slice(&h.fps_num.to_le_bytes());
    b[24..28].copy_from_slice(&h.fps_den.to_le_bytes());
    b[28..32].copy_from_slice(&h.flags.to_le_bytes());
    b
}

/// Parse and validate the header. `None` on bad magic/version/zero dims.
pub fn parse_casv_header(data: &[u8]) -> Option<CasvHeader> {
    if data.len() < CASV_HEADER_BYTES {
        return None;
    }
    let rd = |o: usize| u32::from_le_bytes(data[o..o + 4].try_into().unwrap());
    if rd(0) != CASV_MAGIC || rd(4) != CASV_VERSION {
        return None;
    }
    let h = CasvHeader {
        width: rd(8),
        height: rd(12),
        frame_count: rd(16),
        fps_num: rd(20),
        fps_den: rd(24),
        flags: rd(28),
    };
    if h.width == 0 || h.height == 0 || h.frame_count == 0 || h.fps_den == 0 {
        return None;
    }
    Some(h)
}

/// Magic at the end of a *footer-indexed* streaming `.casv` (data-first, index +
/// footer appended). Lets frames stream straight to a sink without knowing the
/// frame count up front. See [`encode_casv_video_streaming_to`].
pub const CASV_FOOTER_MAGIC: u32 = 0x4653_4143; // 'CASF' little-endian
pub const CASV_FOOTER_BYTES: usize = 32;

/// Magic for the audio box: 'CSAU' little-endian (bytes C S A U on disk).
pub const CASV_AUDIO_BOX_MAGIC: u32 = 0x5541_5343;
/// Byte count of the CSAU box header (magic + payload length field).
pub const CASV_AUDIO_BOX_HDR: usize = 8;

/// Append a CSAU box (8-byte header + Ogg/Opus payload) to a buffer.
/// Call this after the CASR box and before the CASV footer.
pub fn write_csau_box(out: &mut Vec<u8>, ogg_opus: &[u8]) {
    out.extend_from_slice(&CASV_AUDIO_BOX_MAGIC.to_le_bytes());
    out.extend_from_slice(&(ogg_opus.len() as u32).to_le_bytes());
    out.extend_from_slice(ogg_opus);
}

/// Extract the Ogg/Opus payload from a footer-format `.casv` that contains a CSAU box.
/// Returns `None` if absent, file too short, or magic mismatch.
pub fn parse_casv_audio_box(data: &[u8]) -> Option<&[u8]> {
    let f = parse_casv_footer(data)?;
    let idx_end = f.index_offset as usize
        + f.frame_count as usize * CASV_INDEX_ENTRY_BYTES;
    let footer_start = data.len() - CASV_FOOTER_BYTES;
    let mut pos = idx_end;
    // Skip optional CASR box.
    if pos + 8 <= footer_start {
        let magic = u32::from_le_bytes(data[pos..pos + 4].try_into().ok()?);
        if magic == CASV_RATE_BOX_MAGIC {
            pos += 8;
        }
    }
    // Check for CSAU.
    if pos + CASV_AUDIO_BOX_HDR > footer_start {
        return None;
    }
    let magic = u32::from_le_bytes(data[pos..pos + 4].try_into().ok()?);
    if magic != CASV_AUDIO_BOX_MAGIC {
        return None;
    }
    let len = u32::from_le_bytes(data[pos + 4..pos + 8].try_into().ok()?) as usize;
    let start = pos + CASV_AUDIO_BOX_HDR;
    if start + len > footer_start {
        return None;
    }
    Some(&data[start..start + len])
}

/// Private: pull frames from a `&[Vec<u8>]` slice for use with the streaming encoder.
struct SliceFrameSource<'a> {
    frames: &'a [Vec<u8>],
    i: usize,
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
}

impl<'a> VideoFrameSource for SliceFrameSource<'a> {
    fn dims(&self) -> (u32, u32) {
        (self.width, self.height)
    }
    fn fps(&self) -> (u32, u32) {
        (self.fps_num, self.fps_den)
    }
    fn next_frame(&mut self) -> Option<Vec<u8>> {
        if self.i < self.frames.len() {
            let f = self.frames[self.i].clone();
            self.i += 1;
            Some(f)
        } else {
            None
        }
    }
}

/// Encode frames to footer-format `.casv` with an optional Ogg/Opus audio track
/// embedded as a `CSAU` box between the CASR box and the CASV footer.
///
/// `frames` — interleaved RGB8 pixel data (`len == width * height * 3`) for each frame.
/// `ogg_opus` — full Ogg/Opus stream, or `None` for silent output.
pub fn encode_casv_video_with_audio(
    frames: &[Vec<u8>],
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    opts: &CasaVideoOptions,
    ogg_opus: Option<&[u8]>,
) -> Result<Vec<u8>, VideoError> {
    let mut src = SliceFrameSource {
        frames,
        i: 0,
        width,
        height,
        fps_num,
        fps_den,
    };
    let mut buf = Vec::new();
    // Use the footer-format sink encoder: writes [frames][index][CASR][footer].
    encode_casv_video_streaming_to(&mut src, opts, &mut buf)?;
    if let Some(audio) = ogg_opus {
        // Insert CSAU between the CASR box and the 32-byte footer.
        let footer = buf.split_off(buf.len() - CASV_FOOTER_BYTES);
        write_csau_box(&mut buf, audio);
        buf.extend_from_slice(&footer);
    }
    Ok(buf)
}

/// Trailing footer of a streaming `.casv`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CasvFooter {
    pub index_offset: u64,
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
    pub fps_num: u32,
    pub fps_den: u32,
}

fn build_casv_footer(f: &CasvFooter) -> [u8; CASV_FOOTER_BYTES] {
    let mut b = [0u8; CASV_FOOTER_BYTES];
    b[0..8].copy_from_slice(&f.index_offset.to_le_bytes());
    b[8..12].copy_from_slice(&f.width.to_le_bytes());
    b[12..16].copy_from_slice(&f.height.to_le_bytes());
    b[16..20].copy_from_slice(&f.frame_count.to_le_bytes());
    b[20..24].copy_from_slice(&f.fps_num.to_le_bytes());
    b[24..28].copy_from_slice(&f.fps_den.to_le_bytes());
    b[28..32].copy_from_slice(&CASV_FOOTER_MAGIC.to_le_bytes());
    b
}

/// Parse the 32-byte trailing footer of a streaming `.casv`. `None` if absent/invalid.
pub fn parse_casv_footer(data: &[u8]) -> Option<CasvFooter> {
    if data.len() < CASV_FOOTER_BYTES {
        return None;
    }
    let o = data.len() - CASV_FOOTER_BYTES;
    let rd4 = |i: usize| u32::from_le_bytes(data[o + i..o + i + 4].try_into().unwrap());
    if rd4(28) != CASV_FOOTER_MAGIC {
        return None;
    }
    let f = CasvFooter {
        index_offset: u64::from_le_bytes(data[o..o + 8].try_into().unwrap()),
        width: rd4(8),
        height: rd4(12),
        frame_count: rd4(16),
        fps_num: rd4(20),
        fps_den: rd4(24),
    };
    if f.width == 0 || f.height == 0 || f.frame_count == 0 || f.fps_den == 0 {
        return None;
    }
    let idx_end = f.index_offset as usize + f.frame_count as usize * CASV_INDEX_ENTRY_BYTES;
    if idx_end + CASV_FOOTER_BYTES > data.len() {
        return None;
    }
    Some(f)
}

// ── Ergonomic top-level API ────────────────────────────────────────────────────

/// Heuristic default change-detection threshold for a lossy `distance` (tolerate
/// near-static change roughly below the lossy quant error). Clamped to `[0, 16]`.
pub fn default_thresh_for_distance(distance: f32) -> u8 {
    (distance * 4.0).round().clamp(0.0, 16.0) as u8
}

/// How P-frames reduce redundancy vs the reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipMode {
    /// Whole-frame residual (lossless) — no spatial skipping.
    None,
    /// Skip to the changed bounding rectangle (localized motion).
    Bbox,
    /// Skip to changed tiles (scattered / multi-region motion).
    Tile,
}

/// Quality tier.
#[derive(Clone, Copy, Debug)]
pub enum VideoRate {
    /// Byte-exact (archival / science tier).
    Lossless,
    /// Lossy at the given JXL butteraugli distance (streaming tier).
    Lossy(f32),
}

/// JOLT rate control (spec §3.5, feedback form): a per-GOP leaky-bucket (VBV)
/// controller that adjusts the encode distance toward a byte-rate target.
///
/// JXL is quality-targeted; this thin outer loop makes the streaming encoders
/// bitrate-targeted. Implementation note vs the spec: instead of a per-GOP
/// 1-D *search* with probe encodes (extra encode work per GOP), the controller
/// uses closed-loop feedback — measured bytes of the finished GOP steer the
/// next GOP's distance (damped multiplicative update) with a VBV term that
/// corrects accumulated over/undershoot. Converges within a few GOPs at zero
/// probe cost; the initial `VideoRate::Lossy(d)` is the starting distance.
#[derive(Clone, Copy, Debug)]
pub struct RateControl {
    /// Target encoded bytes per second (bitrate / 8).
    pub target_bytes_per_sec: u32,
    /// Quality ceiling: distance never drops below this (bits stop improving).
    pub min_distance: f32,
    /// Quality floor: distance never rises above this (rate may overshoot).
    pub max_distance: f32,
    /// Leaky-bucket capacity in seconds of target rate (burst tolerance).
    pub vbv_seconds: f32,
}

impl RateControl {
    /// A sensible default envelope for a byte-rate target: distance free to
    /// move in [0.3, 8.0], 2-second VBV.
    pub fn targeting(target_bytes_per_sec: u32) -> Self {
        RateControl { target_bytes_per_sec, min_distance: 0.3, max_distance: 8.0, vbv_seconds: 2.0 }
    }
}

/// One coherent knob-set for [`encode_casv_video`].
#[derive(Clone, Copy, Debug)]
pub struct CasaVideoOptions {
    pub rate: VideoRate,
    /// I-frame period; `1` = all-intra.
    pub gop_len: u32,
    pub skip: SkipMode,
    /// Tile size for [`SkipMode::Tile`].
    pub tile: u32,
    /// libjxl effort (1..=10), applied to every tier (lossless, all-intra lossy,
    /// and the lossy bbox/tile skip tiers — batch and streaming alike).
    pub effort: u8,
    /// Change-detection threshold; `None` = auto from the lossy distance
    /// ([`default_thresh_for_distance`]). Lossless skipping is always exact.
    pub thresh: Option<u8>,
    /// Optional bitrate targeting for the STREAMING lossy encoders
    /// ([`encode_casv_video_streaming`] / [`encode_casv_video_streaming_to`]).
    /// `None` = fixed distance (the batch encoders ignore this field).
    pub rate_control: Option<RateControl>,
}

impl Default for CasaVideoOptions {
    fn default() -> Self {
        Self::streaming(1.0)
    }
}

impl CasaVideoOptions {
    /// Byte-exact archival: lossless, bbox skip, GOP 24.
    pub fn lossless_archive() -> Self {
        CasaVideoOptions { rate: VideoRate::Lossless, gop_len: 24, skip: SkipMode::Bbox, tile: 32, effort: 3, thresh: Some(0), rate_control: None }
    }
    /// Streaming: lossy at `distance`, tile replace-skip, GOP 24, auto threshold.
    pub fn streaming(distance: f32) -> Self {
        CasaVideoOptions { rate: VideoRate::Lossy(distance), gop_len: 24, skip: SkipMode::Tile, tile: 32, effort: 3, thresh: None, rate_control: None }
    }
    /// Bitrate-targeted streaming (JOLT rate control): starts at `distance`
    /// and steers toward `target_bytes_per_sec` per GOP. See [`RateControl`].
    pub fn streaming_bitrate(start_distance: f32, target_bytes_per_sec: u32) -> Self {
        CasaVideoOptions {
            rate_control: Some(RateControl::targeting(target_bytes_per_sec)),
            ..Self::streaming(start_distance)
        }
    }
    /// JOLT preset → options. See [`JoltPreset`].
    pub fn jolt(preset: JoltPreset) -> Self {
        match preset {
            // Fastest wall-clock: e1 intra, coarser distance, tile skip. For
            // live capture / screen share where encode speed rules.
            JoltPreset::Realtime => CasaVideoOptions {
                rate: VideoRate::Lossy(2.0),
                gop_len: 24,
                skip: SkipMode::Tile,
                tile: 32,
                effort: 1,
                thresh: None,
                rate_control: None,
            },
            // The measured sweet spot of the lossy tier (d1.0/e3, tile skip)
            // — same as `streaming(1.0)`.
            JoltPreset::Balanced => CasaVideoOptions::streaming(1.0),
            // Visually-transparent tier: d0.5, effort 4, tighter auto
            // threshold via the distance heuristic.
            JoltPreset::Quality => CasaVideoOptions {
                rate: VideoRate::Lossy(0.5),
                gop_len: 24,
                skip: SkipMode::Tile,
                tile: 32,
                effort: 4,
                thresh: None,
                rate_control: None,
            },
        }
    }
}

// ── JOLT — JXL-Optimized Lossy Transport ──────────────────────────────────────
// JOLT is the lossy streaming profile of the CASV container: JXL VarDCT
// intra frames (chunked constant-peak encoder) + fresh-pixel REPLACE skip
// P-frames (bbox or tile). Drift-freedom comes from REPLACE semantics plus
// source-frame change detection — replaced regions are fresh decoder-side
// decodes and unchanged regions stay at I-frame-level error, so the encoder
// never decodes its own frames (the decoder-side reconstruction is the only
// one). Additive lossy residuals are proven NOT to work in JXL (the
// perceptual model misjudges residual planes — see the design doc); coding
// real pixels and replacing regions is the design that measured −94% size on
// low-motion content at d1.0/t6. Rate metadata rides CasvHeader.flags
// (header files) or the CASR rate box (footer/streamed files).

/// JOLT encode presets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JoltPreset {
    /// Fastest encode (effort 1, distance 2.0) — live capture / screen share.
    Realtime,
    /// The measured default (distance 1.0, effort 3).
    Balanced,
    /// Visually transparent (distance 0.5, effort 4).
    Quality,
}

/// One-call JOLT batch encode: all frames resident, returns a header-format
/// `.casv` stamped with the JOLT rate flags. Decode with [`decode_casv_all_rgb8`].
pub fn jolt_encode(
    frames: &[&[u8]],
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    preset: JoltPreset,
) -> Result<Vec<u8>, VideoError> {
    encode_casv_video(frames, width, height, fps_num, fps_den, &CasaVideoOptions::jolt(preset))
}

/// One-call JOLT streaming encode straight to a sink (footer format + CASR
/// rate box): holds only prev+current frame. Decode with
/// [`decode_casv_footer_all_rgb8`]; read the rate with [`parse_casv_rate_box`].
pub fn jolt_encode_stream_to<W: std::io::Write>(
    src: &mut dyn VideoFrameSource,
    preset: JoltPreset,
    sink: &mut W,
) -> Result<(), VideoError> {
    encode_casv_video_streaming_to(src, &CasaVideoOptions::jolt(preset), sink)
}

/// One ergonomic entry that dispatches to the right encoder for `opts`:
/// - Lossless + None → whole-frame residual delta (all-intra if `gop_len==1`)
/// - Lossless + Bbox/Tile → residual skip (bounding-box / tiles), byte-exact
/// - Lossy + Bbox/Tile → fresh-pixel **replace** skip (the working lossy tier)
/// - Lossy + None → all-intra lossy (each frame independent)
///
/// (Lossy *additive-residual* delta does not work in JXL — see the code comment;
/// the lossy tiers code fresh pixels and replace regions instead.)
pub fn encode_casv_video(
    frames: &[&[u8]],
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    opts: &CasaVideoOptions,
) -> Result<Vec<u8>, VideoError> {
    let mut out = match opts.rate {
        VideoRate::Lossless => {
            let enc = EncodeOptions::lossless().with_effort(opts.effort);
            match opts.skip {
                SkipMode::None => encode_casv_delta_rgb8(frames, width, height, fps_num, fps_den, opts.gop_len, enc),
                SkipMode::Bbox => encode_casv_delta_bbox_rgb8(frames, width, height, fps_num, fps_den, opts.gop_len, enc),
                SkipMode::Tile => encode_casv_delta_tiled_rgb8(frames, width, height, fps_num, fps_den, opts.gop_len, opts.tile, enc),
            }
        }
        VideoRate::Lossy(distance) => {
            let thresh = opts.thresh.unwrap_or_else(|| default_thresh_for_distance(distance));
            let enc = EncodeOptions::distance(distance).with_effort(opts.effort);
            match opts.skip {
                SkipMode::None => {
                    encode_casv_rgb8(frames, width, height, fps_num, fps_den, enc)
                }
                SkipMode::Bbox => encode_casv_delta_lossy_bbox_rgb8(frames, width, height, fps_num, fps_den, opts.gop_len, enc, thresh),
                SkipMode::Tile => encode_casv_delta_lossy_tiled_rgb8(frames, width, height, fps_num, fps_den, opts.gop_len, opts.tile, enc, thresh),
            }
        }
    }?;
    // Stamp the JOLT rate signal into the header flags word (bytes 28..32).
    // The low-level encoders write flags=0; stamping at the dispatcher covers
    // every tier without threading opts through each of them.
    out[28..32].copy_from_slice(&casv_rate_flags(opts).to_le_bytes());
    Ok(out)
}

/// A pull source of RGB8 video frames (from disk, a decode pipeline, a camera…).
/// Frames are pulled one at a time so the whole video need not be resident.
pub trait VideoFrameSource {
    fn dims(&self) -> (u32, u32);
    fn fps(&self) -> (u32, u32);
    /// Next frame's interleaved RGB8 (`len == w*h*3`), or `None` at end of stream.
    fn next_frame(&mut self) -> Option<Vec<u8>>;
    /// Pull the next frame into `buf`, returning `false` at end of stream. The
    /// default delegates to [`Self::next_frame`]; sources that can fill a
    /// caller buffer should override it so the streaming encoder's ping-pong
    /// frame buffers avoid a fresh allocation per frame.
    fn next_frame_into(&mut self, buf: &mut Vec<u8>) -> bool {
        match self.next_frame() {
            Some(v) => {
                *buf = v;
                true
            }
            None => false,
        }
    }
}

/// **Streaming** lossy-tier encode: pulls frames one at a time from `src` and
/// encodes each — **I-frames via the chunked (constant-peak) encoder**
/// ([`encode_chunked`]), P-frames via bbox replace-skip — so a whole video encodes
/// while holding only the previous + current frame (plus the compressed output),
/// not all raw frames. This is where the video codec meets the streaming-export
/// band engine. P-frames use bbox or tile replace-skip per `opts.skip`.
///
/// Requires the streaming tier: `opts.rate = VideoRate::Lossy` and
/// `opts.skip = SkipMode::Bbox` or `SkipMode::Tile` (else [`VideoError::Unsupported`]).
/// `distance`, `gop_len`, `effort`, and `thresh` come from `opts`.
///
/// v1 buffers the compressed output in RAM (small vs raw frames); a true
/// stream-to-sink footer format is a later step.
struct StreamCtx {
    width: u32,
    height: u32,
    distance: f32,
    effort: i64,
    skip: SkipMode,
    tile: u32,
    thresh: u8,
    /// One `JxlEncoder` handle reused for every P-frame crop/atlas encode
    /// (`encode_into` Resets it between encodes) — kills the per-frame
    /// create/destroy + settings resend and appends compressed bytes straight
    /// into `payload` (no intermediate Vec + memcpy).
    enc: Encoder,
    /// Per-frame scratch reused across frames (capacity persists; contents are
    /// rebuilt from empty every frame, so reuse cannot leak stale bytes).
    changed: Vec<usize>,
    bitmap: Vec<u8>,
    atlas: Vec<u8>,
    crop: Vec<u8>,
}

fn stream_ctx(width: u32, height: u32, opts: &CasaVideoOptions) -> Result<StreamCtx, VideoError> {
    let distance = match opts.rate {
        VideoRate::Lossy(d) => d,
        VideoRate::Lossless => return Err(VideoError::Unsupported),
    };
    if matches!(opts.skip, SkipMode::None) {
        return Err(VideoError::Unsupported);
    }
    Ok(StreamCtx {
        width,
        height,
        distance,
        effort: opts.effort as i64,
        skip: opts.skip,
        tile: opts.tile,
        thresh: opts.thresh.unwrap_or_else(|| default_thresh_for_distance(distance)),
        enc: Encoder::new(EncodeOptions::distance(distance).with_effort(opts.effort))?,
        changed: Vec::new(),
        bitmap: Vec::new(),
        atlas: Vec::new(),
        crop: Vec::new(),
    })
}

impl StreamCtx {
    /// Rate-control hook: retarget the encoder to a new distance at a GOP
    /// boundary. Rebuilds the reused Encoder handle (cheap: JxlEncoderCreate is
    /// malloc + struct init) and re-derives the auto change threshold so
    /// detection stays matched to the quantization error.
    fn set_distance(&mut self, d: f32, opts: &CasaVideoOptions) -> Result<(), VideoError> {
        if d == self.distance {
            return Ok(());
        }
        self.distance = d;
        self.enc = Encoder::new(EncodeOptions::distance(d).with_effort(opts.effort))?;
        if opts.thresh.is_none() {
            self.thresh = default_thresh_for_distance(d);
        }
        Ok(())
    }
}

/// Leaky-bucket rate controller state (see [`RateControl`]).
struct RateState {
    ctrl: RateControl,
    /// Target bytes per frame (target_bytes_per_sec × fps_den / fps_num).
    frame_budget: f64,
    /// Bucket capacity in bytes (target rate × vbv_seconds).
    cap: f64,
    /// Signed fullness: positive = under budget (credit), negative = debt.
    bucket: f64,
    gop_bytes: f64,
    gop_frames: u32,
}

impl RateState {
    fn new(ctrl: RateControl, fps_num: u32, fps_den: u32) -> Self {
        let fps = fps_num.max(1) as f64 / fps_den.max(1) as f64;
        let frame_budget = ctrl.target_bytes_per_sec as f64 / fps;
        RateState {
            ctrl,
            frame_budget,
            cap: (ctrl.target_bytes_per_sec as f64 * ctrl.vbv_seconds as f64).max(frame_budget),
            bucket: 0.0,
            gop_bytes: 0.0,
            gop_frames: 0,
        }
    }

    /// Account one encoded frame's bytes.
    fn on_frame(&mut self, bytes: usize) {
        self.bucket = (self.bucket + self.frame_budget - bytes as f64).clamp(-self.cap, self.cap);
        self.gop_bytes += bytes as f64;
        self.gop_frames += 1;
    }

    /// Distance for the next GOP, from the finished GOP's measured rate plus
    /// the VBV term. Damped multiplicative update: distance ∝ size is roughly
    /// inverse-monotone, so ratio^0.5 halves the log-domain step; the bucket
    /// term (±50% at full debt/credit) corrects accumulated drift.
    fn next_gop_distance(&mut self, cur: f32) -> f32 {
        if self.gop_frames == 0 {
            return cur;
        }
        let actual_per_frame = self.gop_bytes / self.gop_frames as f64;
        let ratio = (actual_per_frame / self.frame_budget).max(1e-6);
        let mut d = cur as f64 * ratio.sqrt();
        d *= 1.0 - 0.5 * (self.bucket / self.cap);
        self.gop_bytes = 0.0;
        self.gop_frames = 0;
        d.clamp(self.ctrl.min_distance as f64, self.ctrl.max_distance as f64) as f32
    }
}

/// Encode one streaming frame into `payload` (cleared by the caller). I-frame via
/// the chunked constant-peak encoder, P-frame via bbox/tile replace-skip. Returns
/// the index flag bits. Shared by the buffered and stream-to-sink encoders.
///
/// The encoder never decodes its own output: change detection runs on *source*
/// frames, and REPLACE semantics keep the decoder drift-free (replaced regions
/// are fresh decodes; unchanged regions stay at I-frame-level error).
fn encode_stream_frame(
    px: &[u8],
    prev_src: &[u8],
    is_iframe: bool,
    ctx: &mut StreamCtx,
    payload: &mut Vec<u8>,
) -> Result<u32, VideoError> {
    let (width, height) = (ctx.width, ctx.height);
    if is_iframe {
        let mut isrc = WholeImageSource { data: px, width: width as usize };
        encode_chunked(width, height, ctx.distance, ctx.effort, &mut isrc, payload)?;
        return Ok(0);
    }
    if matches!(ctx.skip, SkipMode::Tile) {
        let t = ctx.tile.max(1);
        let (txn, _tyn) = tile_grid(width, height, t);
        let (wus, ts) = (width as usize, t as usize);
        let map = changed_tile_map_thresh(px, prev_src, width, height, t, ctx.thresh);
        ctx.changed.clear();
        ctx.changed.extend(map.iter().enumerate().filter(|(_, &c)| c).map(|(i, _)| i));
        // JE-8: square-atlas (v2) layout, signalled by the tile-size high bit.
        // The old t-wide sliver atlas (one t×t slot per row) is the shape that
        // made multi-threaded encode SLOWER (CV-E6: 32px-wide strips starve
        // libjxl's 256px group parallelism and its 2-D context modelling); a
        // ~square atlas of ceil(sqrt(n)) columns fixes both.
        payload.extend_from_slice(&((t as u16) | CASV_TILE_V2_BIT).to_le_bytes());
        let bitmap_len = map.len().div_ceil(8);
        ctx.bitmap.clear();
        ctx.bitmap.resize(bitmap_len, 0);
        for &i in &ctx.changed {
            ctx.bitmap[i / 8] |= 1 << (i % 8);
        }
        payload.extend_from_slice(&ctx.bitmap);
        if !ctx.changed.is_empty() {
            let (cols, rows) = atlas_grid_v2(ctx.changed.len());
            let (aw, ah) = (cols * ts, rows * ts);
            // Zero-filled from empty every frame: edge-tile padding bytes and
            // trailing empty slots are load-bearing (they are encoded), so a
            // reused buffer must never leak a previous frame's pixels.
            ctx.atlas.clear();
            ctx.atlas.resize(aw * ah * 3, 0);
            for (slot, &i) in ctx.changed.iter().enumerate() {
                let tx = (i as u32 % txn) as usize;
                let ty = (i as u32 / txn) as usize;
                let bw = ts.min(wus - tx * ts);
                let bh = ts.min(height as usize - ty * ts);
                let (sx, sy) = (slot % cols, slot / cols);
                for row in 0..bh {
                    let s = ((ty * ts + row) * wus + tx * ts) * 3;
                    let d = ((sy * ts + row) * aw + sx * ts) * 3;
                    ctx.atlas[d..d + bw * 3].copy_from_slice(&px[s..s + bw * 3]);
                }
            }
            ctx.enc
                .encode_into(&Frame::rgb(ctx.atlas.as_slice(), aw as u32, ah as u32), payload)?;
        }
        return Ok(CASV_PFRAME_FLAG | CASV_TILE_FLAG | CASV_REPLACE_FLAG);
    }
    match changed_bbox_thresh(px, prev_src, width, height, ctx.thresh) {
        None => {
            for _ in 0..4 {
                payload.extend_from_slice(&0u16.to_le_bytes());
            }
        }
        Some((x, y, bw, bh)) => {
            crop_rgb_into(px, width, x, y, bw, bh, &mut ctx.crop);
            payload.extend_from_slice(&(x as u16).to_le_bytes());
            payload.extend_from_slice(&(y as u16).to_le_bytes());
            payload.extend_from_slice(&(bw as u16).to_le_bytes());
            payload.extend_from_slice(&(bh as u16).to_le_bytes());
            ctx.enc.encode_into(&Frame::rgb(ctx.crop.as_slice(), bw, bh), payload)?;
        }
    }
    Ok(CASV_PFRAME_FLAG | CASV_BBOX_FLAG | CASV_REPLACE_FLAG)
}

/// **Streaming** lossy-tier encode (header-indexed, buffered output): pulls frames
/// one at a time, I-frames via `encode_chunked` (constant peak), P-frames via
/// bbox/tile replace-skip — holding only prev+cur frame. Returns the standard
/// (header-first) `.casv`, decodable by [`decode_casv_all_rgb8`]. For long / live
/// streams that must not buffer the compressed output, use
/// [`encode_casv_video_streaming_to`] (footer format, straight to a sink).
///
/// Requires `opts.rate = Lossy` and `opts.skip = Bbox`/`Tile` (else [`VideoError::Unsupported`]).
pub fn encode_casv_video_streaming(
    src: &mut dyn VideoFrameSource,
    opts: &CasaVideoOptions,
) -> Result<Vec<u8>, VideoError> {
    let (width, height) = src.dims();
    let (fps_num, fps_den) = src.fps();
    let mut ctx = stream_ctx(width, height, opts)?;
    let gop = opts.gop_len.max(1) as usize;
    let expected = (width as usize) * (height as usize) * 3;

    let mut index: Vec<(u32, u32)> = Vec::new(); // (flags, len)
    let mut data: Vec<u8> = Vec::new();
    // Ping-pong frame buffers: after each frame `cur` becomes `prev_src` and the
    // old `prev_src` buffer is refilled by the source (no per-frame allocation
    // for sources implementing `next_frame_into`).
    let mut cur: Vec<u8> = Vec::new();
    let mut prev_src: Vec<u8> = Vec::new();
    let mut idx = 0usize;
    let mut payload = Vec::new();
    let mut rc = opts.rate_control.map(|c| RateState::new(c, fps_num, fps_den));

    loop {
        std::mem::swap(&mut cur, &mut prev_src);
        if !src.next_frame_into(&mut cur) {
            break;
        }
        if cur.len() != expected {
            return Err(VideoError::FrameSize { idx, expected, got: cur.len() });
        }
        let is_iframe = idx % gop == 0;
        if is_iframe && idx > 0 {
            if let Some(rc) = rc.as_mut() {
                let d = rc.next_gop_distance(ctx.distance);
                ctx.set_distance(d, opts)?;
            }
        }
        payload.clear();
        let flags = encode_stream_frame(&cur, &prev_src, is_iframe, &mut ctx, &mut payload)?;
        if let Some(rc) = rc.as_mut() {
            rc.on_frame(payload.len());
        }
        index.push((flags, payload.len() as u32));
        data.extend_from_slice(&payload);
        idx += 1;
    }
    if index.is_empty() {
        return Err(VideoError::Empty);
    }

    let header = CasvHeader {
        width,
        height,
        frame_count: index.len() as u32,
        fps_num,
        fps_den,
        flags: casv_rate_flags(opts),
    };
    let data_start = CASV_HEADER_BYTES + index.len() * CASV_INDEX_ENTRY_BYTES;
    let mut out = Vec::with_capacity(data_start + data.len());
    out.extend_from_slice(&build_casv_header(&header));
    let mut offset = data_start;
    for (flags, len) in &index {
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&(len | flags).to_le_bytes());
        offset += *len as usize;
    }
    out.extend_from_slice(&data);
    Ok(out)
}

/// **Streaming to a sink** (footer-indexed): identical encode to
/// [`encode_casv_video_streaming`] but writes each frame's codestream straight to
/// `sink` as produced, buffering only the tiny index (8 bytes/frame), then appends
/// the index + a 32-byte footer. Constant peak for *both* raw frames and compressed
/// output — for long / live streams. Read back with [`decode_casv_footer_all_rgb8`].
pub fn encode_casv_video_streaming_to<W: std::io::Write>(
    src: &mut dyn VideoFrameSource,
    opts: &CasaVideoOptions,
    sink: &mut W,
) -> Result<(), VideoError> {
    let (width, height) = src.dims();
    let (fps_num, fps_den) = src.fps();
    let mut ctx = stream_ctx(width, height, opts)?;
    let gop = opts.gop_len.max(1) as usize;
    let expected = (width as usize) * (height as usize) * 3;

    let mut index: Vec<(u32, u32)> = Vec::new(); // (offset, len_field)
    // Ping-pong frame buffers (see encode_casv_video_streaming).
    let mut cur: Vec<u8> = Vec::new();
    let mut prev_src: Vec<u8> = Vec::new();
    let mut idx = 0usize;
    let mut offset: u64 = 0;
    let mut payload = Vec::new();
    let mut rc = opts.rate_control.map(|c| RateState::new(c, fps_num, fps_den));

    loop {
        std::mem::swap(&mut cur, &mut prev_src);
        if !src.next_frame_into(&mut cur) {
            break;
        }
        if cur.len() != expected {
            return Err(VideoError::FrameSize { idx, expected, got: cur.len() });
        }
        let is_iframe = idx % gop == 0;
        if is_iframe && idx > 0 {
            if let Some(rc) = rc.as_mut() {
                let d = rc.next_gop_distance(ctx.distance);
                ctx.set_distance(d, opts)?;
            }
        }
        payload.clear();
        let flags = encode_stream_frame(&cur, &prev_src, is_iframe, &mut ctx, &mut payload)?;
        if let Some(rc) = rc.as_mut() {
            rc.on_frame(payload.len());
        }
        sink.write_all(&payload).map_err(|_| VideoError::Io)?;
        index.push((offset as u32, (payload.len() as u32) | flags));
        offset += payload.len() as u64;
        idx += 1;
    }
    if index.is_empty() {
        return Err(VideoError::Empty);
    }

    let index_offset = offset;
    for (off, lenf) in &index {
        sink.write_all(&off.to_le_bytes()).map_err(|_| VideoError::Io)?;
        sink.write_all(&lenf.to_le_bytes()).map_err(|_| VideoError::Io)?;
    }
    // Optional JOLT rate box between index and footer: [CASR magic][flags].
    // Legacy readers never look here (they walk index_offset + count from the
    // footer), so old files without it and old parsers reading new files both
    // keep working. See parse_casv_rate_box.
    sink.write_all(&CASV_RATE_BOX_MAGIC.to_le_bytes()).map_err(|_| VideoError::Io)?;
    sink.write_all(&casv_rate_flags(opts).to_le_bytes()).map_err(|_| VideoError::Io)?;
    let footer = build_casv_footer(&CasvFooter {
        index_offset,
        width,
        height,
        frame_count: index.len() as u32,
        fps_num,
        fps_den,
    });
    sink.write_all(&footer).map_err(|_| VideoError::Io)?;
    Ok(())
}

/// Magic of the optional 8-byte rate box a JOLT streaming-to-sink encode places
/// between the index and the footer: `[u32 'CASR'][u32 flags]` with the same
/// flags layout as [`casv_rate_flags`].
pub const CASV_RATE_BOX_MAGIC: u32 = 0x5253_4143; // 'CASR' little-endian

/// Read the rate flags of a footer-indexed streaming `.casv`, if the encoder
/// wrote a rate box. `None` for legacy files (no box) or invalid data.
pub fn parse_casv_rate_box(data: &[u8]) -> Option<u32> {
    let f = parse_casv_footer(data)?;
    let idx_end = f.index_offset as usize + f.frame_count as usize * CASV_INDEX_ENTRY_BYTES;
    let box_end = idx_end.checked_add(8)?;
    if box_end + CASV_FOOTER_BYTES > data.len() {
        return None;
    }
    let rd4 = |o: usize| u32::from_le_bytes(data[o..o + 4].try_into().unwrap());
    if rd4(idx_end) != CASV_RATE_BOX_MAGIC {
        return None;
    }
    Some(rd4(idx_end + 4))
}

/// Decode a footer-indexed streaming `.casv` (from [`encode_casv_video_streaming_to`])
/// **in place**, straight off the trailing index — no re-framing copy of the
/// compressed stream (the old path memcpy'd the entire file into a rebuilt
/// header-format Vec first: ~file-size peak memory + an O(file) copy before the
/// first frame decoded). Byte-identical output; GOP-parallel like
/// [`decode_casv_all_rgb8`]. Streaming consumers that don't need all frames
/// resident want [`decode_casv_footer_for_each_rgb8`].
pub fn decode_casv_footer_all_rgb8(data: &[u8]) -> Option<Vec<(Vec<u8>, u32, u32)>> {
    decode_casv_view_all_rgb8(&CasvView::from_footer(data)?)
}

/// Encode a sequence of interleaved RGB8 frames into a `.casv` byte vector.
/// Every frame is an independent JXL codestream (all-intra, Architecture A).
///
/// `frames[i]` must be exactly `width*height*3` bytes. `opts` is applied to every
/// frame (use `EncodeOptions::lossless()` for byte-exact round-trips).
pub fn encode_casv_rgb8(
    frames: &[&[u8]],
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    opts: EncodeOptions,
) -> Result<Vec<u8>, VideoError> {
    if frames.is_empty() {
        return Err(VideoError::Empty);
    }
    let expected = (width as usize) * (height as usize) * 3;

    // Encode every frame first so we know each codestream length for the index.
    // Frames are independent → encode in parallel (order preserved by collect).
    let streams: Vec<Vec<u8>> = frames
        .par_iter()
        .enumerate()
        .map(|(idx, px)| {
            if px.len() != expected {
                return Err(VideoError::FrameSize { idx, expected, got: px.len() });
            }
            Ok(encode_rgb8(px, width, height, opts.clone())?)
        })
        .collect::<Result<Vec<_>, VideoError>>()?;

    let header = CasvHeader {
        width,
        height,
        frame_count: frames.len() as u32,
        fps_num,
        fps_den,
        flags: 0,
    };
    let index_bytes = frames.len() * CASV_INDEX_ENTRY_BYTES;
    let data_start = CASV_HEADER_BYTES + index_bytes;

    let total: usize = data_start + streams.iter().map(|s| s.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&build_casv_header(&header));

    // Index: absolute offsets from file start.
    let mut offset = data_start;
    for s in &streams {
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&(s.len() as u32).to_le_bytes());
        offset += s.len();
    }
    // Data.
    for s in &streams {
        out.extend_from_slice(s);
    }
    Ok(out)
}

/// Encode a **16-bit-offset** residual (`cur - prev + 32768`) of a `w×h` RGB8
/// region as a lossless JXL. The tight unimodal distribution around 32768
/// compresses far better than an 8-bit wrapping residual (which maps −1→255, a
/// high-entropy bimodal signal that inflates on noisy content).
fn encode_residual16(
    cur: &[u8],
    prev: &[u8],
    w: u32,
    h: u32,
    opts: &EncodeOptions,
) -> Result<Vec<u8>, EncodeError> {
    let resid: Vec<u16> = cur
        .iter()
        .zip(prev)
        .map(|(&c, &p)| ((c as i32 - p as i32) + 32768) as u16)
        .collect();
    Encoder::new(opts.clone())?.encode(&Frame::rgb(resid.as_slice(), w, h))
}

/// Encode RGB8 frames with a GOP: frame `i` is an I-frame when `i % gop_len == 0`,
/// otherwise a P-frame carrying the wrapping residual vs the previous frame.
/// `gop_len == 1` ⇒ all-intra (identical bytes to `encode_casv_rgb8`).
///
/// Coded lossless ⇒ drift-free (reconstruction equals source), so no in-loop
/// decode is needed. `opts` should be `EncodeOptions::lossless()` for v0.
pub fn encode_casv_delta_rgb8(
    frames: &[&[u8]],
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    gop_len: u32,
    opts: EncodeOptions,
) -> Result<Vec<u8>, VideoError> {
    if frames.is_empty() {
        return Err(VideoError::Empty);
    }
    let expected = (width as usize) * (height as usize) * 3;
    let gop = gop_len.max(1) as usize;

    // (is_p, jxl_bytes) per frame — encoded in parallel (each frame independent).
    let streams: Vec<(bool, Vec<u8>)> = (0..frames.len())
        .into_par_iter()
        .map(|idx| {
            let px = frames[idx];
            if px.len() != expected {
                return Err(VideoError::FrameSize { idx, expected, got: px.len() });
            }
            let is_p = idx % gop != 0;
            let jxl = if is_p {
                encode_residual16(px, frames[idx - 1], width, height, &opts)?
            } else {
                encode_rgb8(px, width, height, opts.clone())?
            };
            Ok((is_p, jxl))
        })
        .collect::<Result<Vec<_>, VideoError>>()?;

    let header = CasvHeader {
        width,
        height,
        frame_count: frames.len() as u32,
        fps_num,
        fps_den,
        flags: 0,
    };
    let index_bytes = frames.len() * CASV_INDEX_ENTRY_BYTES;
    let data_start = CASV_HEADER_BYTES + index_bytes;
    let total: usize = data_start + streams.iter().map(|(_, s)| s.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&build_casv_header(&header));

    let mut offset = data_start;
    for (is_p, s) in &streams {
        let mut len_field = s.len() as u32;
        if *is_p {
            len_field |= CASV_PFRAME_FLAG;
        }
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&len_field.to_le_bytes());
        offset += s.len();
    }
    for (_, s) in &streams {
        out.extend_from_slice(s);
    }
    Ok(out)
}

// LOSSY inter-frame findings:
//  1. Residual-image through JXL's lossy VarDCT does NOT work — the +32768 offset
//     wastes precision, the perceptual model smooths the residual, and error
//     accumulates across the GOP (prior-frame error re-fed as a residual the codec
//     cannot re-code).
//  2. `JXL_BLEND_ADD` does NOT help either — it is a *compositing* add (`bg + fg`
//     in float, `blending.cc`), so the encoder still codes the delta perceptually
//     (same problem) and unsigned pixels can only brighten. Not inter-frame
//     prediction.
// What DOES work (below): code changed regions as *fresh pixels* (perceptually
// correct — real content) and REPLACE them onto the reference; copy unchanged
// regions. A lossy skip tier.

/// Copy a `bw×bh` RGB8 crop into a `width`-wide frame at `(x,y)`.
fn blit_into(dst: &mut [u8], width: u32, x: u32, y: u32, bw: u32, bh: u32, crop: &[u8]) {
    let (w, x, y, bw, bh) = (width as usize, x as usize, y as usize, bw as usize, bh as usize);
    for row in 0..bh {
        let d = ((y + row) * w + x) * 3;
        let s = row * bw * 3;
        dst[d..d + bw * 3].copy_from_slice(&crop[s..s + bw * 3]);
    }
}

/// Lossy streaming tier: GOP + bounding-box **replace** P-frames. Each P-frame
/// codes only the changed rectangle's *fresh pixels* (lossy at `distance`); the
/// decoder overwrites that region on the previous reconstructed frame and copies
/// the rest. Because it codes real pixels (not a residual), JXL's perceptual
/// model is correct — no residual drift. Error is bounded (I-frame-level in
/// unchanged regions, `distance`-level in changed ones) and does not accumulate;
/// change detection runs on *source* frames, so the encoder never decodes its
/// own output. Emits `PFRAME|BBOX|REPLACE` frames.
///
/// `opts` (typically `EncodeOptions::distance(d).with_effort(e)`) is applied to
/// I-frames and P-frame crops alike; `thresh` is the change-detection threshold.
pub fn encode_casv_delta_lossy_bbox_rgb8(
    frames: &[&[u8]],
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    gop_len: u32,
    opts: EncodeOptions,
    thresh: u8,
) -> Result<Vec<u8>, VideoError> {
    if frames.is_empty() {
        return Err(VideoError::Empty);
    }
    let expected = (width as usize) * (height as usize) * 3;
    let gop = gop_len.max(1) as usize;

    // Each frame depends only on resident source frames (change detection runs
    // on `frames[idx-1]`, never on encoder state) → encode in parallel, exactly
    // like the lossless siblings (order preserved by collect).
    let streams: Vec<(u32, Vec<u8>)> = (0..frames.len())
        .into_par_iter()
        .map(|idx| {
            let px = frames[idx];
            if px.len() != expected {
                return Err(VideoError::FrameSize { idx, expected, got: px.len() });
            }
            if idx % gop == 0 {
                return Ok((0, encode_rgb8(px, width, height, opts.clone())?));
            }
            let mut payload = Vec::new();
            // Detect genuinely-changed regions vs the previous SOURCE frame
            // (comparing against a lossy reconstruction would flag the whole
            // frame via quant noise). `thresh` skips near-static regions —
            // essential on noisy real content.
            match changed_bbox_thresh(px, frames[idx - 1], width, height, thresh) {
                None => {
                    for _ in 0..4 {
                        payload.extend_from_slice(&0u16.to_le_bytes());
                    }
                }
                Some((x, y, bw, bh)) => {
                    let crop = crop_rgb(px, width, x, y, bw, bh); // fresh pixels, not a residual
                    let jxl = encode_rgb8(&crop, bw, bh, opts.clone())?;
                    payload.extend_from_slice(&(x as u16).to_le_bytes());
                    payload.extend_from_slice(&(y as u16).to_le_bytes());
                    payload.extend_from_slice(&(bw as u16).to_le_bytes());
                    payload.extend_from_slice(&(bh as u16).to_le_bytes());
                    payload.extend_from_slice(&jxl);
                }
            }
            Ok((CASV_PFRAME_FLAG | CASV_BBOX_FLAG | CASV_REPLACE_FLAG, payload))
        })
        .collect::<Result<Vec<_>, VideoError>>()?;

    let header = CasvHeader {
        width, height, frame_count: frames.len() as u32, fps_num, fps_den, flags: 0,
    };
    let index_bytes = frames.len() * CASV_INDEX_ENTRY_BYTES;
    let data_start = CASV_HEADER_BYTES + index_bytes;
    let total: usize = data_start + streams.iter().map(|(_, s)| s.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&build_casv_header(&header));
    let mut offset = data_start;
    for (flags, s) in &streams {
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&((s.len() as u32) | flags).to_le_bytes());
        offset += s.len();
    }
    for (_, s) in &streams {
        out.extend_from_slice(s);
    }
    Ok(out)
}

/// Lossy streaming tier, tile granularity: like `encode_casv_delta_lossy_bbox_rgb8`
/// but codes each *changed tile*'s fresh pixels into an atlas and REPLACEs those
/// tiles on decode — for scattered / multi-region motion. Emits
/// `PFRAME|TILE|REPLACE` frames. Changed tiles detected vs the previous source.
///
/// `opts` (typically `EncodeOptions::distance(d).with_effort(e)`) is applied to
/// I-frames and P-frame atlases alike; `thresh` is the change-detection threshold.
pub fn encode_casv_delta_lossy_tiled_rgb8(
    frames: &[&[u8]],
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    gop_len: u32,
    tile: u32,
    opts: EncodeOptions,
    thresh: u8,
) -> Result<Vec<u8>, VideoError> {
    if frames.is_empty() {
        return Err(VideoError::Empty);
    }
    let expected = (width as usize) * (height as usize) * 3;
    let gop = gop_len.max(1) as usize;
    let t = tile.max(1);
    let (txn, _tyn) = tile_grid(width, height, t);
    let (w, ts) = (width as usize, t as usize);

    // Frame-parallel exactly like the lossless tiled sibling: change detection
    // reads only source frames, so P-frames have no encoder-state dependency.
    let streams: Vec<(u32, Vec<u8>)> = (0..frames.len())
        .into_par_iter()
        .map(|idx| {
            let px = frames[idx];
            if px.len() != expected {
                return Err(VideoError::FrameSize { idx, expected, got: px.len() });
            }
            if idx % gop == 0 {
                return Ok((0, encode_rgb8(px, width, height, opts.clone())?));
            }
            // Changed tiles detected vs the previous SOURCE frame (see the bbox path).
            let map = changed_tile_map_thresh(px, frames[idx - 1], width, height, t, thresh);
            let changed: Vec<usize> =
                map.iter().enumerate().filter(|(_, &c)| c).map(|(i, _)| i).collect();

            let mut payload = Vec::new();
            // JE-8: square-atlas v2 (see encode_stream_frame — layouts must stay
            // byte-identical between the batch and streaming paths).
            payload.extend_from_slice(&((t as u16) | CASV_TILE_V2_BIT).to_le_bytes());
            let bitmap_len = map.len().div_ceil(8);
            let mut bitmap = vec![0u8; bitmap_len];
            for &i in &changed {
                bitmap[i / 8] |= 1 << (i % 8);
            }
            payload.extend_from_slice(&bitmap);

            if !changed.is_empty() {
                // atlas of FRESH pixels (not residuals), zero-padded edge tiles
                // + trailing empty slots.
                let (cols, rows) = atlas_grid_v2(changed.len());
                let (aw, ah) = (cols * ts, rows * ts);
                let mut atlas = vec![0u8; aw * ah * 3];
                for (slot, &i) in changed.iter().enumerate() {
                    let tx = (i as u32 % txn) as usize;
                    let ty = (i as u32 / txn) as usize;
                    let bw = ts.min(w - tx * ts);
                    let bh = ts.min(height as usize - ty * ts);
                    let (sx, sy) = (slot % cols, slot / cols);
                    for row in 0..bh {
                        let src = ((ty * ts + row) * w + tx * ts) * 3;
                        let dst = ((sy * ts + row) * aw + sx * ts) * 3;
                        atlas[dst..dst + bw * 3].copy_from_slice(&px[src..src + bw * 3]);
                    }
                }
                let jxl = encode_rgb8(&atlas, aw as u32, ah as u32, opts.clone())?;
                payload.extend_from_slice(&jxl);
            }
            Ok((CASV_PFRAME_FLAG | CASV_TILE_FLAG | CASV_REPLACE_FLAG, payload))
        })
        .collect::<Result<Vec<_>, VideoError>>()?;

    let header = CasvHeader {
        width, height, frame_count: frames.len() as u32, fps_num, fps_den, flags: 0,
    };
    let index_bytes = frames.len() * CASV_INDEX_ENTRY_BYTES;
    let data_start = CASV_HEADER_BYTES + index_bytes;
    let total: usize = data_start + streams.iter().map(|(_, s)| s.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&build_casv_header(&header));
    let mut offset = data_start;
    for (flags, s) in &streams {
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&((s.len() as u32) | flags).to_le_bytes());
        offset += s.len();
    }
    for (_, s) in &streams {
        out.extend_from_slice(s);
    }
    Ok(out)
}

/// Borrow the JXL codestream bytes for frame `index`, validated against the
/// index table and file bounds. `None` if `index` is out of range or the index
/// entry points outside the file.
pub fn casv_frame_slice(data: &[u8], index: usize) -> Option<&[u8]> {
    casv_frame_info(data, index).map(|(_, slice)| slice)
}

/// Like `casv_frame_slice` but also reports whether the frame is a P-frame
/// (delta) vs an I-frame (keyframe).
pub fn casv_frame_info(data: &[u8], index: usize) -> Option<(bool, &[u8])> {
    let view = CasvView::from_header(data)?;
    let (flags, slice) = view.entry(index)?;
    Some((flags & CASV_PFRAME_FLAG != 0, slice))
}

/// In-place `base[i] += residual16[i] - 32768`, clamped to `[0,255]`. The clamp
/// is a no-op for lossless residuals (result already in range) and keeps lossy
/// residuals valid.
fn add_residual16_into(base: &mut [u8], resid: &[u16]) {
    for (b, &r) in base.iter_mut().zip(resid) {
        *b = (*b as i32 + r as i32 - 32768).clamp(0, 255) as u8;
    }
}

/// Index of the I-frame at or before `index` (the GOP start needed to decode
/// it). Probes the already-parsed view — one header parse for the whole O(GOP)
/// backward scan instead of one per probed frame.
fn preceding_iframe(view: &CasvView, index: usize) -> Option<usize> {
    (0..=index)
        .rev()
        .find(|&j| matches!(view.entry(j), Some((flags, _)) if flags & CASV_PFRAME_FLAG == 0))
}

/// Tight bounding box `(x, y, w, h)` of pixels whose max channel difference
/// between `cur` and `prev` exceeds `thresh`. `None` if none exceed it. `thresh=0`
/// means any difference (exact). A larger `thresh` skips *near*-static regions,
/// which is what makes the lossy tier work on mildly-noisy real content.
fn changed_bbox_thresh(cur: &[u8], prev: &[u8], width: u32, height: u32, thresh: u8) -> Option<(u32, u32, u32, u32)> {
    let w = width as usize;
    let (mut minx, mut miny, mut maxx, mut maxy) = (usize::MAX, usize::MAX, 0usize, 0usize);
    let mut any = false;
    let t = thresh as i32;
    for y in 0..height as usize {
        for x in 0..w {
            let o = (y * w + x) * 3;
            let d = (cur[o] as i32 - prev[o] as i32)
                .abs()
                .max((cur[o + 1] as i32 - prev[o + 1] as i32).abs())
                .max((cur[o + 2] as i32 - prev[o + 2] as i32).abs());
            if d > t {
                any = true;
                if x < minx { minx = x; }
                if x > maxx { maxx = x; }
                if y < miny { miny = y; }
                if y > maxy { maxy = y; }
            }
        }
    }
    if !any {
        return None;
    }
    Some((minx as u32, miny as u32, (maxx - minx + 1) as u32, (maxy - miny + 1) as u32))
}

/// Tight bounding box of pixels that differ at all (exact). `None` if identical.
fn changed_bbox(cur: &[u8], prev: &[u8], width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    changed_bbox_thresh(cur, prev, width, height, 0)
}

/// Copy a `bw×bh` RGB8 sub-rectangle at `(x,y)` out of a `width`-wide image.
fn crop_rgb(src: &[u8], width: u32, x: u32, y: u32, bw: u32, bh: u32) -> Vec<u8> {
    let mut out = Vec::new();
    crop_rgb_into(src, width, x, y, bw, bh, &mut out);
    out
}

/// [`crop_rgb`] into a caller-supplied buffer (cleared first; capacity reused).
fn crop_rgb_into(src: &[u8], width: u32, x: u32, y: u32, bw: u32, bh: u32, out: &mut Vec<u8>) {
    let (w, x, y, bw, bh) = (width as usize, x as usize, y as usize, bw as usize, bh as usize);
    out.clear();
    out.reserve(bw * bh * 3);
    for row in 0..bh {
        let start = ((y + row) * w + x) * 3;
        out.extend_from_slice(&src[start..start + bw * 3]);
    }
}

/// Report whether P-frame `index` is stored in bounding-box form.
pub fn casv_frame_is_bbox(data: &[u8], index: usize) -> Option<bool> {
    let hdr = parse_casv_header(data)?;
    if index >= hdr.frame_count as usize {
        return None;
    }
    let entry = CASV_HEADER_BYTES + index * CASV_INDEX_ENTRY_BYTES;
    if data.len() < entry + CASV_INDEX_ENTRY_BYTES {
        return None;
    }
    let len_field = u32::from_le_bytes(data[entry + 4..entry + 8].try_into().ok()?);
    Some((len_field & CASV_BBOX_FLAG) != 0)
}

/// Report whether P-frame `index` is stored in tile-grid form.
pub fn casv_frame_is_tile(data: &[u8], index: usize) -> Option<bool> {
    let hdr = parse_casv_header(data)?;
    if index >= hdr.frame_count as usize {
        return None;
    }
    let entry = CASV_HEADER_BYTES + index * CASV_INDEX_ENTRY_BYTES;
    if data.len() < entry + CASV_INDEX_ENTRY_BYTES {
        return None;
    }
    let len_field = u32::from_le_bytes(data[entry + 4..entry + 8].try_into().ok()?);
    Some((len_field & CASV_TILE_FLAG) != 0)
}

/// Report whether P-frame `index` carries replace-pixels (lossy tier) rather than
/// an additive residual.
pub fn casv_frame_is_replace(data: &[u8], index: usize) -> Option<bool> {
    let hdr = parse_casv_header(data)?;
    if index >= hdr.frame_count as usize {
        return None;
    }
    let entry = CASV_HEADER_BYTES + index * CASV_INDEX_ENTRY_BYTES;
    if data.len() < entry + CASV_INDEX_ENTRY_BYTES {
        return None;
    }
    let len_field = u32::from_le_bytes(data[entry + 4..entry + 8].try_into().ok()?);
    Some((len_field & CASV_REPLACE_FLAG) != 0)
}

/// `(tiles_x, tiles_y)` for a `width×height` image at `tile` size.
fn tile_grid(width: u32, height: u32, tile: u32) -> (u32, u32) {
    (width.div_ceil(tile), height.div_ceil(tile))
}

/// Per-tile changed flags (row-major, index = ty*tiles_x + tx): a tile is
/// changed if any channel of any pixel differs by more than `thresh`. `thresh=0`
/// means any difference (exact).
fn changed_tile_map_thresh(cur: &[u8], prev: &[u8], width: u32, height: u32, tile: u32, thresh: u8) -> Vec<bool> {
    let (txn, tyn) = tile_grid(width, height, tile);
    let (w, t) = (width as usize, tile as usize);
    let th = thresh as i32;
    let mut map = vec![false; (txn * tyn) as usize];
    for ty in 0..tyn as usize {
        for tx in 0..txn as usize {
            let x0 = tx * t;
            let y0 = ty * t;
            let bw = t.min(w - x0);
            let bh = t.min(height as usize - y0);
            let mut changed = false;
            'tile: for row in 0..bh {
                let base = ((y0 + row) * w + x0) * 3;
                for c in 0..bw * 3 {
                    if (cur[base + c] as i32 - prev[base + c] as i32).abs() > th {
                        changed = true;
                        break 'tile;
                    }
                }
            }
            map[ty * txn as usize + tx] = changed;
        }
    }
    map
}

/// Per-tile changed flags with exact detection (`thresh=0`).
fn changed_tile_map(cur: &[u8], prev: &[u8], width: u32, height: u32, tile: u32) -> Vec<bool> {
    changed_tile_map_thresh(cur, prev, width, height, tile, 0)
}

/// Encode RGB8 frames with GOP + **tile-grid** P-frames. Each P-frame payload is
/// `[tile_size u16][changed-tile bitmap][atlas JXL]`; the atlas is one
/// `tile_size`-wide image stacking each changed tile's residual in a
/// `tile_size×tile_size` slot (edge tiles zero-padded). Best for scattered /
/// multi-region motion. Lossless ⇒ drift-free.
pub fn encode_casv_delta_tiled_rgb8(
    frames: &[&[u8]],
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    gop_len: u32,
    tile: u32,
    opts: EncodeOptions,
) -> Result<Vec<u8>, VideoError> {
    if frames.is_empty() {
        return Err(VideoError::Empty);
    }
    let expected = (width as usize) * (height as usize) * 3;
    let gop = gop_len.max(1) as usize;
    let t = tile.max(1);
    let (txn, _tyn) = tile_grid(width, height, t);
    let (w, ts) = (width as usize, t as usize);

    let streams: Vec<(bool, Vec<u8>)> = (0..frames.len())
        .into_par_iter()
        .map(|idx| {
            let px = frames[idx];
            if px.len() != expected {
                return Err(VideoError::FrameSize { idx, expected, got: px.len() });
            }
            if idx % gop == 0 {
                return Ok((false, encode_rgb8(px, width, height, opts.clone())?));
            }
            let prev = frames[idx - 1];
            let map = changed_tile_map(px, prev, width, height, t);
            let changed: Vec<usize> =
                map.iter().enumerate().filter(|(_, &c)| c).map(|(i, _)| i).collect();

            let mut payload = Vec::new();
            payload.extend_from_slice(&(t as u16).to_le_bytes());
            let bitmap_len = map.len().div_ceil(8);
            let mut bitmap = vec![0u8; bitmap_len];
            for &i in &changed {
                bitmap[i / 8] |= 1 << (i % 8);
            }
            payload.extend_from_slice(&bitmap);

            if !changed.is_empty() {
                // 16-bit-offset atlas; padding stays at 32768 (== zero diff).
                let mut atlas = vec![32768u16; ts * ts * 3 * changed.len()];
                for (slot, &i) in changed.iter().enumerate() {
                    let tx = (i as u32 % txn) as usize;
                    let ty = (i as u32 / txn) as usize;
                    let bw = ts.min(w - tx * ts);
                    let bh = ts.min(height as usize - ty * ts);
                    for row in 0..bh {
                        for col in 0..bw {
                            let src = ((ty * ts + row) * w + tx * ts + col) * 3;
                            let dst = ((slot * ts + row) * ts + col) * 3;
                            for c in 0..3 {
                                atlas[dst + c] = ((px[src + c] as i32 - prev[src + c] as i32) + 32768) as u16;
                            }
                        }
                    }
                }
                let jxl = Encoder::new(opts.clone())?
                    .encode(&Frame::rgb(atlas.as_slice(), t, t * changed.len() as u32))?;
                payload.extend_from_slice(&jxl);
            }
            Ok((true, payload))
        })
        .collect::<Result<Vec<_>, VideoError>>()?;

    let header = CasvHeader {
        width, height, frame_count: frames.len() as u32, fps_num, fps_den, flags: 0,
    };
    let index_bytes = frames.len() * CASV_INDEX_ENTRY_BYTES;
    let data_start = CASV_HEADER_BYTES + index_bytes;
    let total: usize = data_start + streams.iter().map(|(_, s)| s.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&build_casv_header(&header));

    let mut offset = data_start;
    for (is_p, s) in &streams {
        let mut len_field = s.len() as u32;
        if *is_p {
            len_field |= CASV_PFRAME_FLAG | CASV_TILE_FLAG;
        }
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&len_field.to_le_bytes());
        offset += s.len();
    }
    for (_, s) in &streams {
        out.extend_from_slice(s);
    }
    Ok(out)
}

/// Encode RGB8 frames with GOP + **bounding-box** P-frames: each P-frame stores
/// an 8-byte `[x,y,w,h]` (u16 LE) header followed by the lossless JXL residual of
/// just that changed rectangle (empty rect ⇒ no image). Best for localized-motion
/// content; falls back to a full-frame rect on scattered change. Lossless ⇒
/// drift-free.
pub fn encode_casv_delta_bbox_rgb8(
    frames: &[&[u8]],
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    gop_len: u32,
    opts: EncodeOptions,
) -> Result<Vec<u8>, VideoError> {
    if frames.is_empty() {
        return Err(VideoError::Empty);
    }
    let expected = (width as usize) * (height as usize) * 3;
    let gop = gop_len.max(1) as usize;

    let streams: Vec<(bool, bool, Vec<u8>)> = (0..frames.len())
        .into_par_iter()
        .map(|idx| {
            let px = frames[idx];
            if px.len() != expected {
                return Err(VideoError::FrameSize { idx, expected, got: px.len() });
            }
            if idx % gop == 0 {
                return Ok((false, false, encode_rgb8(px, width, height, opts.clone())?));
            }
            let prev = frames[idx - 1];
            let mut payload = Vec::new();
            match changed_bbox(px, prev, width, height) {
                None => {
                    for _ in 0..4 {
                        payload.extend_from_slice(&0u16.to_le_bytes());
                    }
                }
                Some((x, y, bw, bh)) => {
                    let cur_crop = crop_rgb(px, width, x, y, bw, bh);
                    let prev_crop = crop_rgb(prev, width, x, y, bw, bh);
                    let jxl = encode_residual16(&cur_crop, &prev_crop, bw, bh, &opts)?;
                    payload.extend_from_slice(&(x as u16).to_le_bytes());
                    payload.extend_from_slice(&(y as u16).to_le_bytes());
                    payload.extend_from_slice(&(bw as u16).to_le_bytes());
                    payload.extend_from_slice(&(bh as u16).to_le_bytes());
                    payload.extend_from_slice(&jxl);
                }
            }
            Ok((true, true, payload))
        })
        .collect::<Result<Vec<_>, VideoError>>()?;

    let header = CasvHeader {
        width, height, frame_count: frames.len() as u32, fps_num, fps_den, flags: 0,
    };
    let index_bytes = frames.len() * CASV_INDEX_ENTRY_BYTES;
    let data_start = CASV_HEADER_BYTES + index_bytes;
    let total: usize = data_start + streams.iter().map(|(_, _, s)| s.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&build_casv_header(&header));

    let mut offset = data_start;
    for (is_p, is_bbox, s) in &streams {
        let mut len_field = s.len() as u32;
        if *is_p { len_field |= CASV_PFRAME_FLAG; }
        if *is_bbox { len_field |= CASV_BBOX_FLAG; }
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&len_field.to_le_bytes());
        offset += s.len();
    }
    for (_, _, s) in &streams {
        out.extend_from_slice(s);
    }
    Ok(out)
}

/// Zero-copy view over a parsed CASV container, header-indexed or
/// footer-indexed (streamed). Carries the geometry plus an index accessor that
/// parses and validates one entry **once** per frame — `(flags, codestream)` —
/// which is what lets footer files decode **in place** (no re-framing memcpy of
/// the whole compressed stream) and spares the decode loops the four
/// header/index re-parses per frame the public flag helpers would cost.
struct CasvView<'a> {
    data: &'a [u8],
    width: u32,
    height: u32,
    frame_count: usize,
    /// Byte offset of the index table.
    index_pos: usize,
    /// Frame offsets below this are invalid (header layout: the header itself).
    min_offset: usize,
    /// Frame slices must end at or before this (footer layout: the index start).
    max_end: usize,
}

impl<'a> CasvView<'a> {
    fn from_header(data: &'a [u8]) -> Option<Self> {
        let hdr = parse_casv_header(data)?;
        Some(CasvView {
            data,
            width: hdr.width,
            height: hdr.height,
            frame_count: hdr.frame_count as usize,
            index_pos: CASV_HEADER_BYTES,
            min_offset: CASV_HEADER_BYTES,
            max_end: data.len(),
        })
    }

    fn from_footer(data: &'a [u8]) -> Option<Self> {
        let f = parse_casv_footer(data)?;
        let n = f.frame_count as usize;
        let idx_start = f.index_offset as usize;
        // Replicate the retired re-framing decoder's per-entry
        // `offset + delta` u32-overflow refusal so in-place decode accepts and
        // rejects the exact same files (the case is only reachable with
        // pathological >4 GB in-memory streams, but parity is parity).
        let delta = (CASV_HEADER_BYTES + n * CASV_INDEX_ENTRY_BYTES) as u32;
        for i in 0..n {
            let e = idx_start + i * CASV_INDEX_ENTRY_BYTES;
            let off = u32::from_le_bytes(data[e..e + 4].try_into().ok()?);
            off.checked_add(delta)?;
        }
        Some(CasvView {
            data,
            width: f.width,
            height: f.height,
            frame_count: n,
            index_pos: idx_start,
            min_offset: 0,
            max_end: idx_start,
        })
    }

    /// `(flags, codestream slice)` for frame `index`: one parse, one validation
    /// (the same bounds checks `casv_frame_info` performs, generalized over the
    /// two layouts).
    fn entry(&self, index: usize) -> Option<(u32, &'a [u8])> {
        if index >= self.frame_count {
            return None;
        }
        let e = self.index_pos + index * CASV_INDEX_ENTRY_BYTES;
        if self.data.len() < e + CASV_INDEX_ENTRY_BYTES {
            return None;
        }
        let offset = u32::from_le_bytes(self.data[e..e + 4].try_into().ok()?) as usize;
        let len_field = u32::from_le_bytes(self.data[e + 4..e + 8].try_into().ok()?);
        let len = (len_field & !CASV_FLAG_BITS) as usize;
        let end = offset.checked_add(len)?;
        if offset < self.min_offset || end > self.max_end {
            return None;
        }
        Some((len_field & CASV_FLAG_BITS, &self.data[offset..end]))
    }
}

/// Persistent per-loop decode state for the CASV decode paths: one reusable
/// [`Decoder`] (a single `JxlDecoderCreate` for the whole video instead of one
/// per frame) plus u8/u16 scratch buffers reused across frames (region payloads
/// — replace-pixel atlas/crop and residuals — are pure scratch, so their
/// allocations amortize to zero after the first frame). Byte-exact vs the
/// per-frame `decode_interleaved` path by construction: `decode_into_dims`
/// drives the same `run_full_into` loop with the same `DecodeOptions::default()`
/// (the decoder resets between decodes on every exit path).
struct CasvDecodeSession {
    dec: Decoder,
    /// u8 region scratch (replace-pixel atlas / bbox crop).
    px8: Vec<u8>,
    /// u16 residual scratch (full-frame / bbox / tile-atlas residuals).
    px16: Vec<u16>,
}

impl CasvDecodeSession {
    fn new() -> Option<Self> {
        Self::with_threads(1)
    }

    /// `num_threads <= 1` = single-threaded (bit-for-bit the shape
    /// `decode_interleaved` had); `> 1` holds a persistent libjxl thread runner
    /// across all frames — MT decode is deterministic and byte-identical to ST
    /// (pinned by `parallel_decode_byte_identical_to_serial`).
    fn with_threads(num_threads: usize) -> Option<Self> {
        Some(CasvDecodeSession {
            dec: Decoder::with_threads(DecodeOptions::default(), num_threads)?,
            px8: Vec::new(),
            px16: Vec::new(),
        })
    }

    /// Decode `jxl` into the u8 scratch; `(width, height)` on success.
    fn decode_u8(&mut self, jxl: &[u8]) -> Option<(u32, u32)> {
        let (w, h, _) = self.dec.decode_into_dims::<u8>(jxl, Channels::Rgb, &mut self.px8).ok()?;
        Some((w, h))
    }

    /// Decode `jxl` into the u16 scratch; `(width, height)` on success.
    fn decode_u16(&mut self, jxl: &[u8]) -> Option<(u32, u32)> {
        let (w, h, _) = self.dec.decode_into_dims::<u16>(jxl, Channels::Rgb, &mut self.px16).ok()?;
        Some((w, h))
    }

    /// Decode a full frame into `out` (the reconstruction buffer), reusing its
    /// capacity across frames.
    fn decode_frame_into(&mut self, jxl: &[u8], out: &mut Vec<u8>) -> Option<(u32, u32)> {
        let (w, h, _) = self.dec.decode_into_dims::<u8>(jxl, Channels::Rgb, out).ok()?;
        Some((w, h))
    }
}

/// Encode RGB8 frames as a FableBraid `.casv` (lossless, drift-free): I-frames
/// every `gop_len`, P-frames as full-frame mod-256 temporal deltas against the
/// previous *source* frame (lossless ⇒ reconstruction equals source, no in-loop
/// decode). Decode side is the SIMD-rate FableBraid path — this is the tier
/// that answers the Huffman challenge.
pub fn encode_casv_fable_rgb8(
    frames: &[&[u8]],
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    gop_len: u32,
) -> Result<Vec<u8>, VideoError> {
    if frames.is_empty() {
        return Err(VideoError::Empty);
    }
    let expected = (width as usize) * (height as usize) * 3;
    let gop = gop_len.max(1) as usize;

    let streams: Vec<(u32, Vec<u8>)> = (0..frames.len())
        .into_par_iter()
        .map(|idx| {
            let px = frames[idx];
            if px.len() != expected {
                return Err(VideoError::FrameSize { idx, expected, got: px.len() });
            }
            if idx % gop == 0 {
                Ok((0u32, crate::fable_braid::encode_rgb8(px, width, height)))
            } else {
                let delta =
                    crate::fable_braid::encode_rgb8_delta(px, frames[idx - 1], width, height);
                Ok((CASV_PFRAME_FLAG, delta))
            }
        })
        .collect::<Result<Vec<_>, VideoError>>()?;

    let header = CasvHeader {
        width,
        height,
        frame_count: frames.len() as u32,
        fps_num,
        fps_den,
        flags: CASV_HDR_FABLE_FLAG,
    };
    let index_bytes = frames.len() * CASV_INDEX_ENTRY_BYTES;
    let data_start = CASV_HEADER_BYTES + index_bytes;
    let total: usize = data_start + streams.iter().map(|(_, s)| s.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&build_casv_header(&header));
    let mut offset = data_start;
    for (flags, s) in &streams {
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        out.extend_from_slice(&((s.len() as u32) | flags).to_le_bytes());
        offset += s.len();
    }
    for (_, s) in &streams {
        out.extend_from_slice(s);
    }
    Ok(out)
}

/// Reconstruct a P-frame in place: `prev` holds the previous reconstructed frame
/// and is mutated into the current frame. Handles both full-residual and
/// bounding-box P-frames. `None` on malformed payloads.
fn apply_pframe(
    sess: &mut CasvDecodeSession,
    prev: &mut [u8],
    is_bbox: bool,
    is_tile: bool,
    is_replace: bool,
    slice: &[u8],
    width: u32,
    height: u32,
) -> Option<()> {
    if is_tile {
        if slice.len() < 2 {
            return None;
        }
        let t_field = u16::from_le_bytes(slice[0..2].try_into().unwrap());
        // JE-8: high bit selects the v2 square-atlas layout.
        let v2 = t_field & CASV_TILE_V2_BIT != 0;
        let t = (t_field & !CASV_TILE_V2_BIT) as u32;
        if t == 0 {
            return None;
        }
        let (txn, tyn) = tile_grid(width, height, t);
        let n = (txn * tyn) as usize;
        let bitmap_len = n.div_ceil(8);
        if slice.len() < 2 + bitmap_len {
            return None;
        }
        let bitmap = &slice[2..2 + bitmap_len];
        // Changed-tile positions are read straight off the bitmap (same
        // ascending order, same count as the old collected Vec — zero alloc).
        let tile_set = |i: usize| bitmap[i / 8] & (1 << (i % 8)) != 0;
        let changed_count = (0..n).filter(|&i| tile_set(i)).count();
        if changed_count == 0 {
            return Some(());
        }
        let (w, ts) = (width as usize, t as usize);
        if is_replace {
            // lossy tier: atlas holds fresh pixels — replace each tile.
            let (aw, ah) = sess.decode_u8(&slice[2 + bitmap_len..])?;
            // Atlas geometry: v2 = ceil(sqrt(n)) columns; v1 = one-column sliver.
            let (cols, rows) = if v2 { atlas_grid_v2(changed_count) } else { (1, changed_count) };
            if aw != (cols * ts) as u32 || ah != (rows * ts) as u32 {
                return None;
            }
            let awus = aw as usize;
            let atlas = &sess.px8;
            for (slot, i) in (0..n).filter(|&i| tile_set(i)).enumerate() {
                let tx = (i as u32 % txn) as usize;
                let ty = (i as u32 / txn) as usize;
                let bw = ts.min(w - tx * ts);
                let bh = ts.min(height as usize - ty * ts);
                let (sx, sy) = (slot % cols, slot / cols);
                for row in 0..bh {
                    let d = ((ty * ts + row) * w + tx * ts) * 3;
                    let s = ((sy * ts + row) * awus + sx * ts) * 3;
                    prev[d..d + bw * 3].copy_from_slice(&atlas[s..s + bw * 3]);
                }
            }
            return Some(());
        }
        if v2 {
            // v2 exists only on the lossy REPLACE tier; a residual payload
            // claiming v2 is malformed.
            return None;
        }
        let (aw, ah) = sess.decode_u16(&slice[2 + bitmap_len..])?;
        if aw != t || ah != t * changed_count as u32 {
            return None;
        }
        let atlas = &sess.px16;
        for (slot, i) in (0..n).filter(|&i| tile_set(i)).enumerate() {
            let tx = (i as u32 % txn) as usize;
            let ty = (i as u32 / txn) as usize;
            let bw = ts.min(w - tx * ts);
            let bh = ts.min(height as usize - ty * ts);
            for row in 0..bh {
                for col in 0..bw {
                    let asrc = ((slot * ts + row) * ts + col) * 3;
                    let fdst = ((ty * ts + row) * w + tx * ts + col) * 3;
                    for c in 0..3 {
                        prev[fdst + c] = (prev[fdst + c] as i32 + atlas[asrc + c] as i32 - 32768).clamp(0, 255) as u8;
                    }
                }
            }
        }
        return Some(());
    }
    if !is_bbox {
        sess.decode_u16(slice)?;
        if sess.px16.len() != prev.len() {
            return None;
        }
        add_residual16_into(prev, &sess.px16);
        return Some(());
    }
    if slice.len() < 8 {
        return None;
    }
    let rd = |o: usize| u16::from_le_bytes(slice[o..o + 2].try_into().unwrap()) as u32;
    let (x, y, bw, bh) = (rd(0), rd(2), rd(4), rd(6));
    if bw == 0 || bh == 0 {
        return Some(());
    }
    if is_replace {
        // lossy tier: payload is fresh pixels for the rect — overwrite, don't add.
        let (dw, dh) = sess.decode_u8(&slice[8..])?;
        if dw != bw || dh != bh || sess.px8.len() != (bw * bh * 3) as usize {
            return None;
        }
        blit_into(prev, width, x, y, bw, bh, &sess.px8);
        return Some(());
    }
    let (dw, dh) = sess.decode_u16(&slice[8..])?;
    if dw != bw || dh != bh || sess.px16.len() != (bw * bh * 3) as usize {
        return None;
    }
    let resid = &sess.px16;
    let w = width as usize;
    for row in 0..bh as usize {
        let dst = ((y as usize + row) * w + x as usize) * 3;
        let srow = row * bw as usize * 3;
        for c in 0..(bw as usize * 3) {
            prev[dst + c] = (prev[dst + c] as i32 + resid[srow + c] as i32 - 32768).clamp(0, 255) as u8;
        }
    }
    Some(())
}

/// Decode a single frame to interleaved RGB8. For a P-frame this decodes forward
/// from the preceding I-frame (O(GOP)), reconstructing each residual. One
/// persistent decoder + reused scratch serve the whole chain.
pub fn decode_casv_frame_rgb8(data: &[u8], index: usize) -> Option<(Vec<u8>, u32, u32)> {
    let hdr = parse_casv_header(data)?;
    if hdr.flags & CASV_HDR_FABLE_FLAG != 0 {
        // FableBraid tier: one session carries the previous frame's planar
        // subtract-green form across the P-chain (no per-frame re-derivation).
        let view = CasvView::from_header(data)?;
        let start = preceding_iframe(&view, index)?;
        let (w, h) = (view.width, view.height);
        let mut sess = crate::fable_braid::DeltaDecodeSession::new();
        let mut cur: Option<Vec<u8>> = None;
        for i in start..=index {
            let (flags, slice) = view.entry(i)?;
            cur = Some(if flags & CASV_PFRAME_FLAG != 0 {
                let prev = cur.take()?;
                sess.decode_delta(slice, &prev, w, h)?
            } else {
                let (px, dw, dh) = sess.decode_intra(slice)?;
                if (dw, dh) != (w, h) {
                    return None;
                }
                px
            });
        }
        return cur.map(|px| (px, w, h));
    }
    let view = CasvView::from_header(data)?;
    let start = preceding_iframe(&view, index)?;
    let end = index.checked_add(1)?;
    let (w, h) = (view.width, view.height);
    let mut sess = CasvDecodeSession::new()?;
    let mut cur: Vec<u8> = Vec::new();
    decode_casv_range(&view, start..end, &mut sess, &mut cur, &mut |_, _| {})?;
    if cur.is_empty() {
        return None;
    }
    Some((cur, w, h))
}

/// Core sequential reconstruct loop: decode frames `range` in order, lending
/// each reconstructed frame to `sink` as `(frame_index, pixels)`. `range.start`
/// must be an I-frame unless `recon` already holds the prior reconstruction
/// (`recon` is non-empty exactly when a frame with validated dims is resident).
fn decode_casv_range(
    view: &CasvView,
    range: std::ops::Range<usize>,
    sess: &mut CasvDecodeSession,
    recon: &mut Vec<u8>,
    sink: &mut impl FnMut(usize, &[u8]),
) -> Option<()> {
    let (w, h) = (view.width, view.height);
    for i in range {
        let (flags, slice) = view.entry(i)?;
        if flags & CASV_PFRAME_FLAG != 0 {
            // A P-frame needs a full previous reconstruction.
            if recon.is_empty() {
                return None;
            }
            apply_pframe(
                sess,
                recon,
                flags & CASV_BBOX_FLAG != 0,
                flags & CASV_TILE_FLAG != 0,
                flags & CASV_REPLACE_FLAG != 0,
                slice,
                w,
                h,
            )?;
        } else {
            let (dw, dh) = sess.decode_frame_into(slice, recon)?;
            if (dw, dh) != (w, h) {
                return None;
            }
        }
        sink(i, recon);
    }
    Some(())
}

/// Sequential decode loop shared by the MT batch entry point and single-GOP
/// files: one session, one running reconstruction, one owned clone per frame.
fn decode_casv_all_rgb8_with(
    view: &CasvView,
    mut sess: CasvDecodeSession,
) -> Option<Vec<(Vec<u8>, u32, u32)>> {
    let (w, h) = (view.width, view.height);
    let mut out = Vec::with_capacity(view.frame_count);
    let mut recon: Vec<u8> = Vec::new();
    decode_casv_range(view, 0..view.frame_count, &mut sess, &mut recon, &mut |_, px| {
        out.push((px.to_vec(), w, h))
    })?;
    Some(out)
}

/// Decode every frame in order, reconstructing P-frames against the running
/// previous frame. `None` if any frame fails to decode.
///
/// Batch decode is **GOP-parallel**: reconstruction chains only run
/// I-frame→P…P within a GOP, and each GOP starts at its own I-frame, so GOPs
/// are mutually independent by construction. Each GOP decodes serially on its
/// own worker (persistent decoder + reused buffers per worker, single-threaded
/// inner decode — no oversubscription); ordered collect preserves frame order,
/// so the output is byte-identical to the serial loop. Playback consumers that
/// need frame-at-a-time latency instead of batch throughput want
/// [`decode_casv_all_rgb8_threaded`].
pub fn decode_casv_all_rgb8(data: &[u8]) -> Option<Vec<(Vec<u8>, u32, u32)>> {
    let hdr = parse_casv_header(data)?;
    if hdr.flags & CASV_HDR_FABLE_FLAG != 0 {
        // FableBraid tier: serial chain — one session carries the previous
        // frame's planar subtract-green state across P-frames, and the fable
        // decoder never mutates its reference, so the last pushed frame is
        // borrowed instead of cloned.
        let view = CasvView::from_header(data)?;
        let (w, h) = (view.width, view.height);
        let mut out: Vec<(Vec<u8>, u32, u32)> = Vec::with_capacity(view.frame_count);
        let mut sess = crate::fable_braid::DeltaDecodeSession::new();
        for i in 0..view.frame_count {
            let (flags, slice) = view.entry(i)?;
            let recon = if flags & CASV_PFRAME_FLAG != 0 {
                let base = &out.last()?.0;
                sess.decode_delta(slice, base, w, h)?
            } else {
                let (px, dw, dh) = sess.decode_intra(slice)?;
                if (dw, dh) != (w, h) {
                    return None;
                }
                px
            };
            out.push((recon, w, h));
        }
        return Some(out);
    }
    decode_casv_view_all_rgb8(&CasvView::from_header(data)?)
}

/// GOP-parallel batch decode over either container layout (see
/// [`decode_casv_all_rgb8`] for the parallelism contract).
fn decode_casv_view_all_rgb8(view: &CasvView) -> Option<Vec<(Vec<u8>, u32, u32)>> {
    let (w, h) = (view.width, view.height);
    let n = view.frame_count;
    // GOP boundaries = I-frame positions. The scan also validates every index
    // entry up front (any malformed entry fails the whole decode, exactly as
    // the serial loop's lazy per-frame parse would).
    let mut starts: Vec<usize> = Vec::new();
    for i in 0..n {
        let (flags, _) = view.entry(i)?;
        if flags & CASV_PFRAME_FLAG == 0 {
            starts.push(i);
        }
    }
    // A leading P-frame has no reference — fail as the serial loop does.
    if starts.first() != Some(&0) {
        return None;
    }
    if starts.len() == 1 {
        // Single GOP: nothing to fan out.
        return decode_casv_all_rgb8_with(view, CasvDecodeSession::new()?);
    }
    let gops: Vec<Vec<(Vec<u8>, u32, u32)>> = starts
        .par_iter()
        .enumerate()
        .map(|(k, &s)| {
            let e = starts.get(k + 1).copied().unwrap_or(n);
            let mut sess = CasvDecodeSession::new()?;
            let mut recon: Vec<u8> = Vec::new();
            let mut out = Vec::with_capacity(e - s);
            decode_casv_range(view, s..e, &mut sess, &mut recon, &mut |_, px| {
                out.push((px.to_vec(), w, h))
            })?;
            Some(out)
        })
        .collect::<Option<Vec<_>>>()?;
    Some(gops.into_iter().flatten().collect())
}

/// Streaming decode: lend every frame, in order, to `f` as
/// `(frame_index, pixels, width, height)` **without retaining previous
/// frames** — peak memory is one reconstruction buffer plus decode scratch
/// (~2 frames) instead of `frame_count × frame_size` (a 10 s 720p24 batch is
/// ~660 MB resident; this is ~8 MB). The pixel borrow is invalidated when `f`
/// returns (the same lend-then-reuse contract as `Decoder::decode_view`);
/// clone inside `f` if a frame must outlive the callback. Returns the frame
/// count; `None` if any frame fails to decode (frames already delivered to `f`
/// stand — the return value is the success signal).
pub fn decode_casv_for_each_rgb8(
    data: &[u8],
    f: impl FnMut(usize, &[u8], u32, u32),
) -> Option<usize> {
    decode_casv_for_each_rgb8_threaded(data, 1, f)
}

/// [`decode_casv_for_each_rgb8`] with a persistent **multi-threaded** inner
/// libjxl decoder (`num_threads <= 1` = single-threaded, byte-identical output
/// either way): the sequential-playback shape — frame-at-a-time latency with
/// libjxl group parallelism inside each frame, and streaming peak memory.
pub fn decode_casv_for_each_rgb8_threaded(
    data: &[u8],
    num_threads: usize,
    f: impl FnMut(usize, &[u8], u32, u32),
) -> Option<usize> {
    decode_casv_view_for_each(&CasvView::from_header(data)?, num_threads, f)
}

/// Streaming decode of a **footer-indexed** (streamed/JOLT) `.casv`, straight
/// off the index — no re-framing copy, no batch buffering. Same contract as
/// [`decode_casv_for_each_rgb8`].
pub fn decode_casv_footer_for_each_rgb8(
    data: &[u8],
    f: impl FnMut(usize, &[u8], u32, u32),
) -> Option<usize> {
    decode_casv_view_for_each(&CasvView::from_footer(data)?, 1, f)
}

/// [`decode_casv_footer_for_each_rgb8`] with a persistent multi-threaded inner
/// libjxl decoder (`num_threads <= 1` = single-threaded, byte-identical).
pub fn decode_casv_footer_for_each_rgb8_threaded(
    data: &[u8],
    num_threads: usize,
    f: impl FnMut(usize, &[u8], u32, u32),
) -> Option<usize> {
    decode_casv_view_for_each(&CasvView::from_footer(data)?, num_threads, f)
}

fn decode_casv_view_for_each(
    view: &CasvView,
    num_threads: usize,
    mut f: impl FnMut(usize, &[u8], u32, u32),
) -> Option<usize> {
    let (w, h) = (view.width, view.height);
    let mut sess = CasvDecodeSession::with_threads(num_threads)?;
    let mut recon: Vec<u8> = Vec::new();
    decode_casv_range(view, 0..view.frame_count, &mut sess, &mut recon, &mut |i, px| {
        f(i, px, w, h)
    })?;
    Some(view.frame_count)
}

/// [`decode_casv_all_rgb8`] with a persistent **multi-threaded** libjxl decoder:
/// the sequential-playback latency lever. Each frame's JXL decode fans out over
/// `num_threads` libjxl worker threads (one runner held across all frames);
/// `num_threads <= 1` is single-threaded and identical to
/// [`decode_casv_all_rgb8`]. libjxl MT decode is deterministic and
/// byte-identical to ST, so the output is byte-exact either way — use this
/// where per-frame latency (not batch throughput) is the budget, e.g. the
/// lossless-archive tier whose I/P frames are whole-image lossless decodes.
pub fn decode_casv_all_rgb8_threaded(
    data: &[u8],
    num_threads: usize,
) -> Option<Vec<(Vec<u8>, u32, u32)>> {
    decode_casv_all_rgb8_with(&CasvView::from_header(data)?, CasvDecodeSession::with_threads(num_threads)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Deterministic gradient RGB8 frame; `seed` shifts colours so frames differ.
    fn gradient(w: u32, h: u32, seed: u8) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h {
            for x in 0..w {
                v.push((x as u8).wrapping_add(seed));
                v.push((y as u8).wrapping_add(seed.wrapping_mul(2)));
                v.push(((x + y) as u8).wrapping_add(seed.wrapping_mul(3)));
            }
        }
        v
    }

    #[test]
    fn header_roundtrips_and_rejects_garbage() {
        let h = CasvHeader { width: 64, height: 48, frame_count: 10, fps_num: 24, fps_den: 1, flags: 0 };
        let bytes = build_casv_header(&h);
        assert_eq!(parse_casv_header(&bytes), Some(h));

        let mut bad = bytes;
        bad[0] ^= 0xFF; // corrupt magic
        assert_eq!(parse_casv_header(&bad), None);

        assert_eq!(parse_casv_header(&bytes[..16]), None); // truncated

        let mut zero_fps = build_casv_header(&h);
        zero_fps[24..28].copy_from_slice(&0u32.to_le_bytes()); // fps_den = 0
        assert_eq!(parse_casv_header(&zero_fps), None);
    }

    #[test]
    fn encode_produces_valid_header() {
        let (w, h) = (16u32, 12u32);
        let f0 = gradient(w, h, 0);
        let f1 = gradient(w, h, 40);
        let frames: [&[u8]; 2] = [&f0, &f1];
        let bytes = encode_casv_rgb8(&frames, w, h, 24, 1, EncodeOptions::lossless()).unwrap();

        let hdr = parse_casv_header(&bytes).expect("valid header");
        assert_eq!(hdr.width, w);
        assert_eq!(hdr.height, h);
        assert_eq!(hdr.frame_count, 2);
        assert_eq!(hdr.fps_num, 24);
        assert_eq!(hdr.fps_den, 1);

        // empty input rejected
        assert!(matches!(encode_casv_rgb8(&[], w, h, 24, 1, EncodeOptions::lossless()), Err(VideoError::Empty)));

        // wrong-sized frame rejected
        let short = vec![0u8; 10];
        let bad: [&[u8]; 1] = [&short];
        assert!(matches!(
            encode_casv_rgb8(&bad, w, h, 24, 1, EncodeOptions::lossless()),
            Err(VideoError::FrameSize { idx: 0, .. })
        ));
    }

    #[test]
    fn lossless_roundtrip_is_byte_exact() {
        let (w, h) = (24u32, 16u32);
        let src: Vec<Vec<u8>> = (0..3).map(|s| gradient(w, h, (s * 50) as u8)).collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_rgb8(&refs, w, h, 24, 1, EncodeOptions::lossless()).unwrap();

        let all = decode_casv_all_rgb8(&bytes).expect("decode all");
        assert_eq!(all.len(), 3);
        for (i, (px, dw, dh)) in all.iter().enumerate() {
            assert_eq!((*dw, *dh), (w, h), "frame {i} dims");
            assert_eq!(px, &src[i], "frame {i} must be byte-exact (lossless)");
        }
    }

    #[test]
    fn fable_roundtrip_is_byte_exact_with_gop_and_random_access() {
        let (w, h) = (30u32, 22u32);
        // 9 frames, GOP 4 → I at 0/4/8; includes identical consecutive frames
        // (all-COPY deltas) and motion.
        let mut src: Vec<Vec<u8>> = Vec::new();
        for i in 0..9u32 {
            let mut f = gradient(w, h, (i * 17) as u8);
            if i == 3 {
                f = src[2].clone(); // identical frame → pure-COPY P-frame
            }
            src.push(f);
        }
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_fable_rgb8(&refs, w, h, 24, 1, 4).unwrap();

        let hdr = parse_casv_header(&bytes).unwrap();
        assert_eq!(hdr.flags & CASV_HDR_FABLE_FLAG, CASV_HDR_FABLE_FLAG);
        assert!(!casv_frame_info(&bytes, 0).unwrap().0, "frame 0 is I");
        assert!(casv_frame_info(&bytes, 1).unwrap().0, "frame 1 is P");
        assert!(!casv_frame_info(&bytes, 4).unwrap().0, "frame 4 is I (GOP)");

        let all = decode_casv_all_rgb8(&bytes).expect("decode all");
        assert_eq!(all.len(), 9);
        for (i, (px, dw, dh)) in all.iter().enumerate() {
            assert_eq!((*dw, *dh), (w, h), "frame {i} dims");
            assert_eq!(px, &src[i], "frame {i} byte-exact");
        }
        // Random access decodes forward from the preceding I-frame.
        for i in [0usize, 3, 5, 8] {
            let (px, _, _) = decode_casv_frame_rgb8(&bytes, i).expect("random access");
            assert_eq!(px, src[i], "random access frame {i}");
        }
    }

    #[test]
    fn random_access_and_corruption_are_safe() {
        let (w, h) = (20u32, 20u32);
        let src: Vec<Vec<u8>> = (0..4).map(|s| gradient(w, h, (s * 30) as u8)).collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_rgb8(&refs, w, h, 30, 1, EncodeOptions::lossless()).unwrap();

        // O(1) random access: frame 2 decodes to frame 2 without touching others.
        let (px2, _, _) = decode_casv_frame_rgb8(&bytes, 2).expect("frame 2");
        assert_eq!(px2, src[2]);

        // Out-of-range index.
        assert!(decode_casv_frame_rgb8(&bytes, 4).is_none());
        assert!(casv_frame_slice(&bytes, 99).is_none());

        // Corrupt magic → no header → no frames.
        let mut corrupt = bytes.clone();
        corrupt[1] ^= 0xFF;
        assert!(decode_casv_all_rgb8(&corrupt).is_none());

        // Truncated file (index says more bytes than exist) → safe None, no panic.
        let truncated = &bytes[..bytes.len() - 5];
        let last = parse_casv_header(&bytes).unwrap().frame_count as usize - 1;
        assert!(casv_frame_slice(truncated, last).is_none());
    }

    #[test]
    fn frame_flag_encodes_in_len_top_bit() {
        let (w, h) = (12u32, 8u32);
        let src: Vec<Vec<u8>> = (0..3).map(|s| gradient(w, h, (s * 20) as u8)).collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_rgb8(&refs, w, h, 24, 1, EncodeOptions::lossless()).unwrap();
        for i in 0..3 {
            let (is_p, slice) = casv_frame_info(&bytes, i).expect("info");
            assert!(!is_p, "all-intra frame {i} must be I");
            assert_eq!(slice, casv_frame_slice(&bytes, i).unwrap());
        }
        assert!(casv_frame_info(&bytes, 3).is_none()); // out of range
    }

    #[test]
    fn delta_encode_sets_gop_frame_types() {
        let (w, h) = (16u32, 16u32);
        let src: Vec<Vec<u8>> = (0..8).map(|s| gradient(w, h, (s * 8) as u8)).collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 4, EncodeOptions::lossless()).unwrap();

        let expect_i = [true, false, false, false, true, false, false, false];
        for i in 0..8 {
            let (is_p, _) = casv_frame_info(&bytes, i).unwrap();
            assert_eq!(is_p, !expect_i[i], "frame {i} type");
        }
        let all_i = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 1, EncodeOptions::lossless()).unwrap();
        for i in 0..8 {
            assert!(!casv_frame_info(&all_i, i).unwrap().0, "gop=1 frame {i} must be I");
        }
    }

    #[test]
    fn delta_roundtrip_is_byte_exact() {
        let (w, h) = (32u32, 24u32);
        let src: Vec<Vec<u8>> = (0..8).map(|s| gradient(w, h, (s * 11) as u8)).collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 4, EncodeOptions::lossless()).unwrap();

        let all = decode_casv_all_rgb8(&bytes).expect("decode all");
        assert_eq!(all.len(), 8);
        for (i, (px, dw, dh)) in all.iter().enumerate() {
            assert_eq!((*dw, *dh), (w, h), "frame {i} dims");
            assert_eq!(px, &src[i], "frame {i} must reconstruct byte-exact through P-frames");
        }
    }

    // A near-static sequence: fixed background + a small moving square.
    fn low_motion(w: u32, h: u32, n: usize) -> Vec<Vec<u8>> {
        let base = gradient(w, h, 7);
        (0..n)
            .map(|f| {
                let mut v = base.clone();
                let cx = (2 + f as u32) % (w - 4);
                for yy in (h / 2)..(h / 2 + 3) {
                    for xx in cx..cx + 3 {
                        let o = ((yy * w + xx) * 3) as usize;
                        v[o] = 255;
                        v[o + 1] = 0;
                        v[o + 2] = 0;
                    }
                }
                v
            })
            .collect()
    }

    /// Noise-textured base + a moving noise block: lossy size responds strongly
    /// to distance (flat gradients don't), which the rate-control tests need.
    fn textured_motion(w: u32, h: u32, n: usize) -> Vec<Vec<u8>> {
        let mut s: u32 = 0x1234_5678;
        let mut rnd = move || {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (s >> 24) as u8
        };
        let base: Vec<u8> = (0..(w * h * 3) as usize).map(|_| rnd()).collect();
        (0..n)
            .map(|f| {
                let mut v = base.clone();
                // Moving 24x24 block of fresh noise (per-frame deterministic seed).
                let mut bs: u32 = 0x9e37_79b9 ^ (f as u32).wrapping_mul(0x85eb_ca6b);
                let mut brnd = move || {
                    bs = bs.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    (bs >> 24) as u8
                };
                let bx = (4 * f as u32) % (w - 24);
                let by = (3 * f as u32) % (h - 24);
                for yy in by..by + 24 {
                    for xx in bx..bx + 24 {
                        let o = ((yy * w + xx) * 3) as usize;
                        v[o] = brnd();
                        v[o + 1] = brnd();
                        v[o + 2] = brnd();
                    }
                }
                v
            })
            .collect()
    }

    /// JOLT rate control: bytes steer toward the target across GOPs, in both
    /// directions, without leaving the distance clamps or breaking decode.
    #[test]
    fn rate_control_steers_toward_target() {
        let (w, h) = (128u32, 128u32);
        let frames = textured_motion(w, h, 72); // 3 s @ 24fps, 6 GOPs of 12
        let gop = 12u32;
        let run = |opts: &CasaVideoOptions| -> Vec<u8> {
            let mut fs = VecFrames { frames: frames.clone(), i: 0, w, h };
            encode_casv_video_streaming(&mut fs, opts).unwrap()
        };

        let mut fixed = CasaVideoOptions::streaming(1.5);
        fixed.gop_len = gop;
        let fixed_bytes = run(&fixed).len();
        let fixed_rate = fixed_bytes as f64 / 3.0; // bytes/s over the 3 s clip

        // Downward: target half the fixed rate — controller must raise distance
        // and land materially below the fixed size.
        let mut down = CasaVideoOptions::streaming_bitrate(1.5, (fixed_rate * 0.5) as u32);
        down.gop_len = gop;
        let down_out = run(&down);
        assert!(
            (down_out.len() as f64) < 0.8 * fixed_bytes as f64,
            "rate control must cut bytes toward a lower target: {} vs fixed {}",
            down_out.len(),
            fixed_bytes
        );
        let decoded = decode_casv_all_rgb8(&down_out).expect("rate-controlled stream decodes");
        assert_eq!(decoded.len(), 72);

        // Upward: target double the fixed rate — distance drops toward
        // min_distance and bytes must rise.
        let mut up = CasaVideoOptions::streaming_bitrate(1.5, (fixed_rate * 2.0) as u32);
        up.gop_len = gop;
        let up_out = run(&up);
        assert!(
            up_out.len() > fixed_bytes,
            "rate control must spend more bytes toward a higher target: {} vs fixed {}",
            up_out.len(),
            fixed_bytes
        );

        // Convergence quality (downward run): the LAST two GOPs should sit
        // near the per-GOP byte budget once feedback has settled. Loose band —
        // lossy size vs distance is steppy at this resolution.
        let target_gop_bytes = fixed_rate * 0.5 * (gop as f64 / 24.0);
        let mut gop_sizes = [0usize; 6];
        for i in 0..72 {
            gop_sizes[i / 12] += casv_frame_slice(&down_out, i).unwrap().len();
        }
        for (g, &sz) in gop_sizes.iter().enumerate().skip(4) {
            let ratio = sz as f64 / target_gop_bytes;
            assert!(
                (0.4..=2.0).contains(&ratio),
                "late GOP {g} rate ratio {ratio:.2} out of band (size {sz}, target {target_gop_bytes:.0})"
            );
        }
    }

    /// Extreme targets stay inside the distance clamps and keep the stream valid.
    #[test]
    fn rate_control_clamps_and_survives_extremes() {
        let (w, h) = (96u32, 96u32);
        let frames = textured_motion(w, h, 36);
        let run = |target: u32| -> Vec<u8> {
            let mut o = CasaVideoOptions::streaming_bitrate(1.0, target);
            o.gop_len = 6;
            let mut fs = VecFrames { frames: frames.clone(), i: 0, w, h };
            encode_casv_video_streaming(&mut fs, &o).unwrap()
        };
        let starved = run(1); // 1 byte/s — pinned at max_distance
        let flooded = run(1_000_000_000); // 1 GB/s — pinned at min_distance
        assert!(starved.len() < flooded.len(), "starved must be smaller than flooded");
        assert_eq!(decode_casv_all_rgb8(&starved).unwrap().len(), 36);
        assert_eq!(decode_casv_all_rgb8(&flooded).unwrap().len(), 36);
    }

    #[test]
    fn delta_beats_intra_on_low_motion() {
        let (w, h) = (64u32, 64u32);
        let src = low_motion(w, h, 8);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let intra = encode_casv_rgb8(&refs, w, h, 24, 1, EncodeOptions::lossless()).unwrap();
        let delta = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 8, EncodeOptions::lossless()).unwrap();
        assert!(
            (delta.len() as f64) < 0.6 * (intra.len() as f64),
            "delta ({}) should be well under 60% of intra ({}) on low-motion",
            delta.len(),
            intra.len()
        );
        let out = decode_casv_all_rgb8(&delta).unwrap();
        for (i, (px, _, _)) in out.iter().enumerate() {
            assert_eq!(px, &src[i], "low-motion frame {i} exact");
        }
    }

    #[test]
    fn random_access_to_pframe_reconstructs() {
        let (w, h) = (24u32, 20u32);
        let src: Vec<Vec<u8>> = (0..8).map(|s| gradient(w, h, (s * 9) as u8)).collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 4, EncodeOptions::lossless()).unwrap();

        let (px6, _, _) = decode_casv_frame_rgb8(&bytes, 6).expect("frame 6");
        assert_eq!(px6, src[6]);
        let (px4, _, _) = decode_casv_frame_rgb8(&bytes, 4).expect("frame 4");
        assert_eq!(px4, src[4]);
    }

    #[test]
    fn changed_bbox_is_tight() {
        let (w, h) = (10u32, 8u32);
        let a = vec![0u8; (w * h * 3) as usize];
        assert_eq!(changed_bbox(&a, &a, w, h), None);
        let mut b = a.clone();
        let o = ((3 * w + 4) * 3) as usize;
        b[o + 1] = 200;
        assert_eq!(changed_bbox(&b, &a, w, h), Some((4, 3, 1, 1)));
        let mut c = a.clone();
        c[0] = 5;
        let o2 = ((7 * w + 9) * 3) as usize;
        c[o2] = 5;
        assert_eq!(changed_bbox(&c, &a, w, h), Some((0, 0, 10, 8)));
    }

    #[test]
    fn crop_and_bbox_flag() {
        let w = 4u32;
        let mut src = Vec::new();
        for y in 0..3u8 {
            for x in 0..4u8 {
                src.push(x);
                src.push(y);
                src.push(0);
            }
        }
        let sub = crop_rgb(&src, w, 1, 1, 2, 2);
        assert_eq!(sub, vec![1, 1, 0, 2, 1, 0, 1, 2, 0, 2, 2, 0]);

        let raw = 123u32;
        let field = raw | CASV_PFRAME_FLAG | CASV_BBOX_FLAG;
        assert_eq!(field & !(CASV_PFRAME_FLAG | CASV_BBOX_FLAG), raw);
    }

    #[test]
    fn bbox_encoder_marks_frames_and_shrinks() {
        let (w, h) = (64u32, 64u32);
        let src = low_motion(w, h, 8);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_bbox_rgb8(&refs, w, h, 24, 1, 8, EncodeOptions::lossless()).unwrap();

        assert!(!casv_frame_info(&bytes, 0).unwrap().0);
        for i in 1..8 {
            assert!(casv_frame_info(&bytes, i).unwrap().0, "frame {i} is P");
            assert!(casv_frame_is_bbox(&bytes, i).unwrap(), "frame {i} is bbox");
        }
        let full = encode_casv_delta_rgb8(&refs, w, h, 24, 1, 8, EncodeOptions::lossless()).unwrap();
        assert!(
            (bytes.len() as f64) < (full.len() as f64),
            "bbox ({}) should be smaller than full-residual delta ({})",
            bytes.len(),
            full.len()
        );
    }

    #[test]
    fn bbox_roundtrip_is_byte_exact() {
        let (w, h) = (64u32, 48u32);
        let src = low_motion(w, h, 10);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_bbox_rgb8(&refs, w, h, 24, 1, 5, EncodeOptions::lossless()).unwrap();

        let all = decode_casv_all_rgb8(&bytes).expect("decode all");
        assert_eq!(all.len(), 10);
        for (i, (px, _, _)) in all.iter().enumerate() {
            assert_eq!(px, &src[i], "bbox frame {i} must reconstruct byte-exact");
        }
        let (px8, _, _) = decode_casv_frame_rgb8(&bytes, 8).unwrap();
        assert_eq!(px8, src[8]);
    }

    #[test]
    fn tile_map_flags_changed_tiles() {
        let (w, h, tile) = (8u32, 8u32, 4u32);
        let a = vec![0u8; (w * h * 3) as usize];
        assert_eq!(tile_grid(w, h, tile), (2, 2));
        assert_eq!(changed_tile_map(&a, &a, w, h, tile), vec![false; 4]);
        let mut b = a.clone();
        b[((6 * w + 6) * 3) as usize] = 99;
        assert_eq!(changed_tile_map(&b, &a, w, h, tile), vec![false, false, false, true]);
    }

    #[test]
    fn tile_flag_and_mask() {
        let raw = 77u32;
        let field = raw | CASV_PFRAME_FLAG | CASV_TILE_FLAG;
        assert_eq!(field & !(CASV_PFRAME_FLAG | CASV_BBOX_FLAG | CASV_TILE_FLAG), raw);
        assert_ne!(CASV_TILE_FLAG, CASV_BBOX_FLAG);
        assert_ne!(CASV_TILE_FLAG, CASV_PFRAME_FLAG);
    }

    // Two small squares far apart move each frame → scattered change.
    fn two_region_motion(w: u32, h: u32, n: usize) -> Vec<Vec<u8>> {
        let base = gradient(w, h, 7);
        (0..n)
            .map(|f| {
                let mut v = base.clone();
                for (bx, by, col) in [
                    ((2 + f as u32) % (w / 2 - 4), 4u32, [255u8, 0, 0]),
                    (w / 2 + (2 + f as u32) % (w / 2 - 4), h - 8, [0u8, 0, 255]),
                ] {
                    for yy in by..by + 3 {
                        for xx in bx..bx + 3 {
                            let o = ((yy * w + xx) * 3) as usize;
                            v[o] = col[0];
                            v[o + 1] = col[1];
                            v[o + 2] = col[2];
                        }
                    }
                }
                v
            })
            .collect()
    }

    #[test]
    fn tile_encoder_marks_and_beats_intra_on_scatter() {
        let (w, h) = (64u32, 64u32);
        let src = two_region_motion(w, h, 8);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let tiled = encode_casv_delta_tiled_rgb8(&refs, w, h, 24, 1, 8, 16, EncodeOptions::lossless()).unwrap();

        assert!(!casv_frame_info(&tiled, 0).unwrap().0);
        for i in 1..8 {
            assert!(casv_frame_is_tile(&tiled, i).unwrap(), "frame {i} is tile");
        }
        // With 16-bit residuals unchanged regions are ~free, so tile-vs-bbox is now
        // a decode-compute distinction (tile decodes fewer pixels), not a byte one.
        // The robust byte claim: skipping unchanged tiles beats coding full frames.
        let intra = encode_casv_rgb8(&refs, w, h, 24, 1, EncodeOptions::lossless()).unwrap();
        assert!(
            (tiled.len() as f64) < 0.75 * (intra.len() as f64),
            "tiled ({}) should be well under intra ({}) by skipping unchanged tiles",
            tiled.len(),
            intra.len()
        );
    }

    #[test]
    fn tile_roundtrip_is_byte_exact() {
        let (w, h) = (64u32, 64u32);
        let src = two_region_motion(w, h, 10);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_tiled_rgb8(&refs, w, h, 24, 1, 5, 16, EncodeOptions::lossless()).unwrap();

        let all = decode_casv_all_rgb8(&bytes).expect("decode all");
        assert_eq!(all.len(), 10);
        for (i, (px, _, _)) in all.iter().enumerate() {
            assert_eq!(px, &src[i], "tile frame {i} must reconstruct byte-exact");
        }
        let (px8, _, _) = decode_casv_frame_rgb8(&bytes, 8).unwrap();
        assert_eq!(px8, src[8]);
    }

    /// JE-8 back-compat: a hand-built v1 sliver-atlas REPLACE payload (tile_size
    /// high bit clear) must still decode — the v2 square atlas is opt-in via the
    /// bit, not a breaking change.
    #[test]
    fn v1_sliver_tile_payload_still_decodes() {
        let (w, h) = (64u32, 64u32);
        let t = 16u32;
        let f0 = gradient(w, h, 0);
        let mut f1 = f0.clone();
        // Mutate tiles 5 (tx=1,ty=1) and 10 (tx=2,ty=2) of the 4×4 grid.
        let changed = [5usize, 10usize];
        for &i in &changed {
            let (tx, ty) = (i % 4, i / 4);
            for row in 0..16 {
                for col in 0..16 {
                    let o = ((ty * 16 + row) * 64 + tx * 16 + col) * 3;
                    f1[o] = 255 - f1[o];
                }
            }
        }

        let iframe = encode_rgb8(&f0, w, h, EncodeOptions::distance(1.0)).unwrap();

        // v1 payload: [t u16, bit clear][bitmap][16-wide sliver atlas].
        let mut p = Vec::new();
        p.extend_from_slice(&(t as u16).to_le_bytes());
        let mut bitmap = [0u8; 2];
        for &i in &changed {
            bitmap[i / 8] |= 1 << (i % 8);
        }
        p.extend_from_slice(&bitmap);
        let mut atlas = vec![0u8; 16 * 16 * 3 * changed.len()];
        for (slot, &i) in changed.iter().enumerate() {
            let (tx, ty) = (i % 4, i / 4);
            for row in 0..16 {
                let s = ((ty * 16 + row) * 64 + tx * 16) * 3;
                let d = ((slot * 16 + row) * 16) * 3;
                atlas[d..d + 48].copy_from_slice(&f1[s..s + 48]);
            }
        }
        let atlas_jxl = encode_rgb8(&atlas, 16, 32, EncodeOptions::distance(1.0)).unwrap();
        p.extend_from_slice(&atlas_jxl);

        // Assemble a 2-frame container by hand.
        let header = CasvHeader { width: w, height: h, frame_count: 2, fps_num: 24, fps_den: 1, flags: 0 };
        let data_start = CASV_HEADER_BYTES + 2 * CASV_INDEX_ENTRY_BYTES;
        let mut file = Vec::new();
        file.extend_from_slice(&build_casv_header(&header));
        file.extend_from_slice(&(data_start as u32).to_le_bytes());
        file.extend_from_slice(&(iframe.len() as u32).to_le_bytes());
        file.extend_from_slice(&((data_start + iframe.len()) as u32).to_le_bytes());
        file.extend_from_slice(
            &((p.len() as u32) | CASV_PFRAME_FLAG | CASV_TILE_FLAG | CASV_REPLACE_FLAG).to_le_bytes(),
        );
        file.extend_from_slice(&iframe);
        file.extend_from_slice(&p);

        let out = decode_casv_all_rgb8(&file).expect("v1 payload decodes");
        assert_eq!(out.len(), 2);
        let (d0, d1) = (&out[0].0, &out[1].0);
        // Changed tiles ≈ f1 (lossy); unchanged pixels identical to frame 0's decode.
        let mut err_sum = 0f64;
        let mut err_n = 0usize;
        for row in 0..64usize {
            for col in 0..64usize {
                let i = (row / 16) * 4 + col / 16;
                let o = (row * 64 + col) * 3;
                if changed.contains(&i) {
                    for c in 0..3 {
                        err_sum += (d1[o + c] as i32 - f1[o + c] as i32).unsigned_abs() as f64;
                        err_n += 3;
                    }
                } else {
                    assert_eq!(&d1[o..o + 3], &d0[o..o + 3], "unchanged px ({col},{row})");
                }
            }
        }
        let mean_err = err_sum / err_n as f64;
        assert!(mean_err < 8.0, "changed-tile mean err too high: {mean_err}");
    }

    /// JE-8: the v2 payload signals the high bit and carries a ~square atlas
    /// (ceil(sqrt(n)) columns), not the t-wide sliver.
    #[test]
    fn v2_tile_payload_atlas_is_square() {
        let (w, h) = (64u32, 64u32);
        let src = two_region_motion(w, h, 2);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let bytes = encode_casv_delta_lossy_tiled_rgb8(
            &refs, w, h, 24, 1, 8, 16, EncodeOptions::distance(1.0), 0,
        )
        .unwrap();
        let slice = casv_frame_slice(&bytes, 1).unwrap();
        let t_field = u16::from_le_bytes(slice[0..2].try_into().unwrap());
        assert_ne!(t_field & CASV_TILE_V2_BIT, 0, "v2 bit set");
        let t = (t_field & !CASV_TILE_V2_BIT) as u32;
        assert_eq!(t, 16);
        let bitmap = &slice[2..4]; // 16 tiles -> 2 bytes
        let cc = bitmap.iter().map(|b| b.count_ones() as usize).sum::<usize>();
        assert!(cc > 1, "test needs multiple changed tiles, got {cc}");
        let (cols, rows) = atlas_grid_v2(cc);
        let (apx, aw, ah) =
            crate::jxl_casadecoder::decode_interleaved::<u8>(&slice[4..], 3).expect("atlas decodes");
        assert_eq!((aw, ah), ((cols as u32) * t, (rows as u32) * t), "square grid dims");
        assert_eq!(apx.len(), (aw * ah * 3) as usize);
    }

    // The lossy tier: fresh-pixel REPLACE skip. Unlike the residual approach (which
    // gave ~20 mean-err and accumulated), coding real pixels is perceptually correct
    // → small error, no accumulation — and it beats lossy all-intra by skipping
    // unchanged regions.
    #[test]
    fn lossy_replace_smaller_correct_and_stable() {
        let (w, h) = (64u32, 64u32);
        let src = low_motion(w, h, 8);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let d = 1.0f32;
        let skip = encode_casv_delta_lossy_bbox_rgb8(&refs, w, h, 24, 1, 8, EncodeOptions::distance(d), 0).unwrap();
        let intra = encode_casv_rgb8(&refs, w, h, 24, 1, EncodeOptions::distance(d)).unwrap();
        assert!(
            skip.len() < intra.len(),
            "lossy skip ({}) should beat lossy all-intra ({}) by skipping unchanged regions",
            skip.len(),
            intra.len()
        );

        assert!(!casv_frame_info(&skip, 0).unwrap().0);
        for i in 1..8 {
            assert!(casv_frame_info(&skip, i).unwrap().0, "frame {i} is P");
            assert!(casv_frame_is_replace(&skip, i).unwrap(), "frame {i} is replace");
        }

        let out = decode_casv_all_rgb8(&skip).unwrap();
        assert_eq!(out.len(), 8);
        let mean_err = |i: usize| -> f64 {
            let px = &out[i].0;
            px.iter()
                .zip(&src[i])
                .map(|(&a, &b)| (a as i32 - b as i32).unsigned_abs() as f64)
                .sum::<f64>()
                / px.len() as f64
        };
        for i in 0..8 {
            assert_eq!((out[i].1, out[i].2), (w, h), "frame {i} dims");
            assert!(mean_err(i) < 8.0, "frame {i} mean err {} (should be ~visually-lossless)", mean_err(i));
        }
        assert!(
            mean_err(7) < mean_err(1) + 4.0,
            "no accumulation: f1={} f7={}",
            mean_err(1),
            mean_err(7)
        );

        let out2 = decode_casv_all_rgb8(&skip).unwrap();
        for i in 0..8 {
            assert_eq!(out[i].0, out2[i].0, "deterministic decode (frame {i})");
        }
    }

    #[test]
    fn threshold_gates_and_skips_more() {
        // Unit: a 2-unit change is caught at thresh 1, skipped at thresh 3.
        let (w, h) = (16u32, 16u32);
        let a = vec![100u8; (w * h * 3) as usize];
        let mut b = a.clone();
        b[((5 * w + 5) * 3) as usize] = 102;
        assert!(changed_bbox_thresh(&b, &a, w, h, 1).is_some());
        assert!(changed_bbox_thresh(&b, &a, w, h, 3).is_none());

        // Integration: on noisy content a higher threshold skips the noise and
        // yields a smaller lossy stream than exact change detection.
        let (w, h) = (64u32, 64u32);
        let base = gradient(w, h, 7);
        let src: Vec<Vec<u8>> = (0..6)
            .map(|f| {
                let mut v = base.clone();
                for i in (0..v.len()).step_by(37) {
                    v[i] = v[i].saturating_add(((f + i) % 3) as u8); // faint +/- noise
                }
                let cx = (2 + f as u32) % (w - 4);
                for yy in (h / 2)..(h / 2 + 3) {
                    for xx in cx..cx + 3 {
                        let o = ((yy * w + xx) * 3) as usize;
                        v[o] = 255;
                        v[o + 1] = 0;
                        v[o + 2] = 0;
                    }
                }
                v
            })
            .collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let exact = encode_casv_delta_lossy_bbox_rgb8(&refs, w, h, 24, 1, 6, EncodeOptions::distance(1.0), 0).unwrap();
        let thr = encode_casv_delta_lossy_bbox_rgb8(&refs, w, h, 24, 1, 6, EncodeOptions::distance(1.0), 4).unwrap();
        assert!(
            thr.len() < exact.len(),
            "threshold ({}) should skip noise vs exact ({})",
            thr.len(),
            exact.len()
        );
        assert!(decode_casv_all_rgb8(&thr).is_some());
    }

    #[test]
    fn lossy_tile_replace_smaller_and_stable() {
        let (w, h) = (64u32, 64u32);
        let src = two_region_motion(w, h, 8);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        let d = 1.0f32;
        let skip = encode_casv_delta_lossy_tiled_rgb8(&refs, w, h, 24, 1, 8, 16, EncodeOptions::distance(d), 0).unwrap();
        let intra = encode_casv_rgb8(&refs, w, h, 24, 1, EncodeOptions::distance(d)).unwrap();
        assert!(
            skip.len() < intra.len(),
            "lossy tile skip ({}) should beat lossy all-intra ({})",
            skip.len(),
            intra.len()
        );
        for i in 1..8 {
            assert!(casv_frame_is_tile(&skip, i).unwrap(), "frame {i} is tile");
            assert!(casv_frame_is_replace(&skip, i).unwrap(), "frame {i} is replace");
        }
        let out = decode_casv_all_rgb8(&skip).unwrap();
        assert_eq!(out.len(), 8);
        for (i, (px, _, _)) in out.iter().enumerate() {
            let me = px.iter().zip(&src[i]).map(|(&a, &b)| (a as i32 - b as i32).unsigned_abs() as f64).sum::<f64>() / px.len() as f64;
            assert!(me < 8.0, "frame {i} mean err {} (should be ~visually-lossless)", me);
        }
        let out2 = decode_casv_all_rgb8(&skip).unwrap();
        for i in 0..8 {
            assert_eq!(out[i].0, out2[i].0, "deterministic decode (frame {i})");
        }
    }

    #[test]
    fn unified_api_dispatches_and_roundtrips() {
        let (w, h) = (32u32, 24u32);
        let src: Vec<Vec<u8>> = (0..6).map(|s| gradient(w, h, (s * 20) as u8)).collect();
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();

        // Lossless archive preset → byte-exact.
        let arch = encode_casv_video(&refs, w, h, 24, 1, &CasaVideoOptions::lossless_archive()).unwrap();
        for (i, (px, _, _)) in decode_casv_all_rgb8(&arch).unwrap().iter().enumerate() {
            assert_eq!(px, &src[i], "lossless-archive frame {i} byte-exact");
        }

        // Streaming preset → decodes (lossy, not byte-exact) with right dims.
        let stream = encode_casv_video(&refs, w, h, 24, 1, &CasaVideoOptions::streaming(1.0)).unwrap();
        let s = decode_casv_all_rgb8(&stream).unwrap();
        assert_eq!(s.len(), 6);
        assert_eq!((s[0].1, s[0].2), (w, h));

        // Custom lossless tile config also byte-exact.
        let opts = CasaVideoOptions {
            rate: VideoRate::Lossless,
            gop_len: 3,
            skip: SkipMode::Tile,
            tile: 16,
            effort: 3,
            thresh: Some(0),
            rate_control: None,
        };
        let tv = encode_casv_video(&refs, w, h, 24, 1, &opts).unwrap();
        for (i, (px, _, _)) in decode_casv_all_rgb8(&tv).unwrap().iter().enumerate() {
            assert_eq!(px, &src[i], "custom lossless-tile frame {i} byte-exact");
        }
    }

    struct VecFrames {
        frames: Vec<Vec<u8>>,
        i: usize,
        w: u32,
        h: u32,
    }
    impl VideoFrameSource for VecFrames {
        fn dims(&self) -> (u32, u32) {
            (self.w, self.h)
        }
        fn fps(&self) -> (u32, u32) {
            (24, 1)
        }
        fn next_frame(&mut self) -> Option<Vec<u8>> {
            if self.i < self.frames.len() {
                let f = self.frames[self.i].clone();
                self.i += 1;
                Some(f)
            } else {
                None
            }
        }
    }

    #[test]
    fn streaming_encode_roundtrips_bounded_and_deterministic() {
        let (w, h) = (64u32, 64u32);
        let frames = low_motion(w, h, 8);
        let opts = CasaVideoOptions {
            rate: VideoRate::Lossy(1.0),
            gop_len: 8,
            skip: SkipMode::Bbox,
            tile: 32,
            effort: 3,
            thresh: Some(0),
            rate_control: None,
        };
        let mut fs = VecFrames { frames: frames.clone(), i: 0, w, h };
        let casv = encode_casv_video_streaming(&mut fs, &opts).unwrap();

        // Streaming produces the standard container → the normal decoder reads it.
        let out = decode_casv_all_rgb8(&casv).unwrap();
        assert_eq!(out.len(), 8);
        assert!(!casv_frame_info(&casv, 0).unwrap().0, "frame 0 is I");
        for i in 1..8 {
            assert!(casv_frame_is_replace(&casv, i).unwrap(), "frame {i} is replace");
        }
        for (i, (px, dw, dh)) in out.iter().enumerate() {
            assert_eq!((*dw, *dh), (w, h), "frame {i} dims");
            let me = px.iter().zip(&frames[i]).map(|(&a, &b)| (a as i32 - b as i32).unsigned_abs() as f64).sum::<f64>() / px.len() as f64;
            assert!(me < 8.0, "frame {i} mean err {} (fresh-pixel, ~visually-lossless)", me);
        }

        // Deterministic (chunked encode is single-threaded).
        let mut fs2 = VecFrames { frames: frames.clone(), i: 0, w, h };
        let casv2 = encode_casv_video_streaming(&mut fs2, &opts).unwrap();
        assert_eq!(casv, casv2, "streaming encode must be deterministic");

        // Tile skip also works via the streaming path.
        let topts = CasaVideoOptions { skip: SkipMode::Tile, tile: 16, ..opts };
        let mut fst = VecFrames { frames: frames.clone(), i: 0, w, h };
        let casvt = encode_casv_video_streaming(&mut fst, &topts).unwrap();
        let outt = decode_casv_all_rgb8(&casvt).unwrap();
        assert_eq!(outt.len(), 8);
        for i in 1..8 {
            assert!(casv_frame_is_tile(&casvt, i).unwrap(), "streaming tile frame {i}");
        }

        // Unsupported tier rejected.
        let mut fs3 = VecFrames { frames: low_motion(w, h, 2), i: 0, w, h };
        let bad = CasaVideoOptions { rate: VideoRate::Lossless, ..opts };
        assert!(matches!(encode_casv_video_streaming(&mut fs3, &bad), Err(VideoError::Unsupported)));
    }

    #[test]
    fn streaming_to_sink_footer_roundtrips() {
        let (w, h) = (48u32, 48u32);
        let frames = low_motion(w, h, 8);
        let opts = CasaVideoOptions {
            rate: VideoRate::Lossy(1.0),
            gop_len: 8,
            skip: SkipMode::Bbox,
            tile: 32,
            effort: 3,
            thresh: Some(0),
            rate_control: None,
        };

        // Stream to an in-memory sink (footer-indexed format).
        let mut fs = VecFrames { frames: frames.clone(), i: 0, w, h };
        let mut sink: Vec<u8> = Vec::new();
        encode_casv_video_streaming_to(&mut fs, &opts, &mut sink).unwrap();

        let f = parse_casv_footer(&sink).expect("footer parses");
        assert_eq!((f.width, f.height, f.frame_count), (w, h, 8));

        // Footer decode must equal the buffered (header) streaming decode.
        let via_footer = decode_casv_footer_all_rgb8(&sink).unwrap();
        let mut fs2 = VecFrames { frames: frames.clone(), i: 0, w, h };
        let header_casv = encode_casv_video_streaming(&mut fs2, &opts).unwrap();
        let via_header = decode_casv_all_rgb8(&header_casv).unwrap();
        assert_eq!(via_footer.len(), 8);
        for i in 0..8 {
            assert_eq!(via_footer[i].0, via_header[i].0, "footer vs header decode frame {i}");
            let px = &via_footer[i].0;
            let me = px.iter().zip(&frames[i]).map(|(&a, &b)| (a as i32 - b as i32).unsigned_abs() as f64).sum::<f64>() / px.len() as f64;
            assert!(me < 8.0, "frame {i} mean err {me}");
        }

        // Footer streaming for-each delivers the same frames in order (ST + MT).
        let mut k = 0usize;
        let n = decode_casv_footer_for_each_rgb8(&sink, |i, px, dw, dh| {
            assert_eq!((i, dw, dh), (k, w, h), "footer for_each frame {k} meta");
            assert_eq!(px, via_footer[k].0.as_slice(), "footer for_each frame {k}");
            k += 1;
        })
        .unwrap();
        assert_eq!((n, k), (8, 8));
        let mut k = 0usize;
        decode_casv_footer_for_each_rgb8_threaded(&sink, 4, |_, px, _, _| {
            assert_eq!(px, via_footer[k].0.as_slice(), "footer MT for_each frame {k}");
            k += 1;
        })
        .unwrap();
        assert_eq!(k, 8);
    }

    #[test]
    fn for_each_matches_batch_decode() {
        let (w, h) = (64u32, 48u32);
        let src = low_motion(w, h, 7);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        // Cover residual-none, lossless tile, and lossy REPLACE bbox tiers.
        let files = [
            encode_casv_delta_rgb8(&refs, w, h, 24, 1, 3, EncodeOptions::lossless()).unwrap(),
            encode_casv_delta_tiled_rgb8(&refs, w, h, 24, 1, 3, 16, EncodeOptions::lossless())
                .unwrap(),
            encode_casv_delta_lossy_bbox_rgb8(&refs, w, h, 24, 1, 3, EncodeOptions::distance(1.0), 0)
                .unwrap(),
        ];
        for bytes in &files {
            let batch = decode_casv_all_rgb8(bytes).unwrap();
            let mut streamed: Vec<(usize, Vec<u8>, u32, u32)> = Vec::new();
            let n = decode_casv_for_each_rgb8(bytes, |i, px, dw, dh| {
                streamed.push((i, px.to_vec(), dw, dh));
            })
            .unwrap();
            assert_eq!(n, batch.len());
            assert_eq!(streamed.len(), batch.len());
            for (i, (si, spx, sw, sh)) in streamed.iter().enumerate() {
                assert_eq!(*si, i, "callback order");
                assert_eq!((spx, *sw, *sh), (&batch[i].0, batch[i].1, batch[i].2), "frame {i}");
            }
            // MT for-each byte-identical too.
            let mut k = 0usize;
            decode_casv_for_each_rgb8_threaded(bytes, 4, |i, px, _, _| {
                assert_eq!((i, px), (k, batch[k].0.as_slice()), "MT frame {k}");
                k += 1;
            })
            .unwrap();
            assert_eq!(k, batch.len());
        }
    }

    #[test]
    fn threaded_decode_is_byte_identical_to_st() {
        let (w, h) = (64u32, 48u32);
        let src = low_motion(w, h, 6);
        let refs: Vec<&[u8]> = src.iter().map(|v| v.as_slice()).collect();
        // Lossless tile (residual P) + lossy bbox (REPLACE P) cover both
        // P-frame decode kinds plus whole-frame I decodes.
        let tile =
            encode_casv_delta_tiled_rgb8(&refs, w, h, 24, 1, 3, 16, EncodeOptions::lossless())
                .unwrap();
        let lossy =
            encode_casv_delta_lossy_bbox_rgb8(&refs, w, h, 24, 1, 3, EncodeOptions::distance(1.0), 0)
                .unwrap();
        for bytes in [&tile, &lossy] {
            let st = decode_casv_all_rgb8(bytes).unwrap();
            let mt = decode_casv_all_rgb8_threaded(bytes, 4).unwrap();
            assert_eq!(st, mt, "MT decode must be byte-identical to ST");
        }
        // num_threads <= 1 is the ST shape.
        assert_eq!(decode_casv_all_rgb8_threaded(&tile, 1).unwrap(), decode_casv_all_rgb8(&tile).unwrap());
    }

    #[test]
    fn jolt_rate_flags_ride_the_header() {
        let (w, h) = (32u32, 24u32);
        let f0 = gradient(w, h, 0);
        let f1 = gradient(w, h, 60);
        let frames: [&[u8]; 2] = [&f0, &f1];

        // JOLT (lossy) files carry the rate signal in header flags.
        let jolt = jolt_encode(&frames, w, h, 24, 1, JoltPreset::Balanced).unwrap();
        let hdr = parse_casv_header(&jolt).unwrap();
        assert!(hdr.is_lossy());
        assert_eq!(hdr.lossy_distance(), Some(1.0));
        assert_eq!(hdr.rate_effort(), 3);
        // Still a plain CASV stream for the decoder.
        assert_eq!(decode_casv_all_rgb8(&jolt).unwrap().len(), 2);

        // Lossless files keep flags == 0 (legacy shape).
        let lossless =
            encode_casv_video(&frames, w, h, 24, 1, &CasaVideoOptions::lossless_archive()).unwrap();
        let lhdr = parse_casv_header(&lossless).unwrap();
        assert_eq!(lhdr.flags, 0);
        assert!(!lhdr.is_lossy());
        assert_eq!(lhdr.lossy_distance(), None);

        // Preset knobs are what the docs promise.
        let rt = CasaVideoOptions::jolt(JoltPreset::Realtime);
        assert!(matches!(rt.rate, VideoRate::Lossy(d) if d == 2.0));
        assert_eq!(rt.effort, 1);
        let q = CasaVideoOptions::jolt(JoltPreset::Quality);
        assert!(matches!(q.rate, VideoRate::Lossy(d) if d == 0.5));
        assert_eq!(q.effort, 4);
    }

    #[test]
    fn batch_lossy_paths_honor_effort() {
        // The batch lossy skip encoders must apply `opts.effort` — the header's
        // rate_effort metadata promises the effort that was actually used, and
        // the streaming path already honors it. Proof: every batch P-frame
        // payload must be byte-identical to the streaming one (identical encoder
        // settings), for the presets whose effort differs from the old
        // hard-coded default (Realtime e1, Quality e4).
        let (w, h) = (64u32, 64u32);
        let frames = low_motion(w, h, 6);
        let refs: Vec<&[u8]> = frames.iter().map(|v| v.as_slice()).collect();

        for preset in [JoltPreset::Realtime, JoltPreset::Quality] {
            for skip in [SkipMode::Tile, SkipMode::Bbox] {
                let opts = CasaVideoOptions {
                    gop_len: 6,
                    skip,
                    thresh: Some(0),
                    ..CasaVideoOptions::jolt(preset)
                };
                let batch = encode_casv_video(&refs, w, h, 24, 1, &opts).unwrap();
                let hdr = parse_casv_header(&batch).unwrap();
                assert_eq!(hdr.rate_effort(), opts.effort, "header records the applied effort");

                let mut src = VecFrames { frames: frames.clone(), i: 0, w, h };
                let stream = encode_casv_video_streaming(&mut src, &opts).unwrap();
                for i in 1..6 {
                    assert_eq!(
                        casv_frame_slice(&batch, i).unwrap(),
                        casv_frame_slice(&stream, i).unwrap(),
                        "batch vs streaming P-frame {i} must use the same effort ({preset:?}, {skip:?})"
                    );
                }
            }
        }

        // And the knob is live: a different effort changes the P-frame bitstream.
        let e1 = encode_casv_delta_lossy_tiled_rgb8(
            &refs, w, h, 24, 1, 6, 16, EncodeOptions::distance(1.0).with_effort(1), 0,
        )
        .unwrap();
        let e3 = encode_casv_delta_lossy_tiled_rgb8(
            &refs, w, h, 24, 1, 6, 16, EncodeOptions::distance(1.0).with_effort(3), 0,
        )
        .unwrap();
        assert_ne!(e1, e3, "effort must change the encoded stream");
    }

    #[test]
    fn streaming_tile_scratch_reuse_matches_batch_on_edge_tiles() {
        // Non-multiple-of-16 dims → the right/bottom edge tiles carry zero
        // padding inside the atlas, and that padding is ENCODED. The changed
        // tile count varies frame to frame, so a reused streaming atlas that
        // failed to re-zero would leak the previous frame's pixels into the
        // padding and change output bytes. The batch encoder allocates a fresh
        // zeroed atlas per frame — byte-equal P-frame payloads prove the
        // streaming scratch reuse is clean.
        let (w, h) = (40u32, 24u32); // tile 16 → 3x2 grid, 8px right + 8px bottom padding
        let base = gradient(w, h, 7);
        let mut frames: Vec<Vec<u8>> = vec![base.clone()];
        let mut f1 = base.clone(); // touch every tile (max changed count)
        for ty in 0..2u32 {
            for tx in 0..3u32 {
                let o = (((ty * 16 + 2) * w + tx * 16 + 2) * 3) as usize;
                f1[o] = f1[o].wrapping_add(60);
            }
        }
        frames.push(f1);
        let mut f2 = frames[1].clone(); // only the corner edge tile (1-slot atlas)
        let o = (((h - 2) * w + (w - 2)) * 3) as usize;
        f2[o] = f2[o].wrapping_add(60);
        frames.push(f2);
        let mut f3 = frames[2].clone(); // two tiles (interior + bottom edge)
        let o0 = ((2 * w + 2) * 3) as usize;
        f3[o0] = f3[o0].wrapping_add(60);
        let o1 = (((h - 2) * w + 2) * 3) as usize;
        f3[o1] = f3[o1].wrapping_add(60);
        frames.push(f3);

        let opts = CasaVideoOptions {
            rate: VideoRate::Lossy(1.0),
            gop_len: 8,
            skip: SkipMode::Tile,
            tile: 16,
            effort: 3,
            thresh: Some(0),
            rate_control: None,
        };
        let refs: Vec<&[u8]> = frames.iter().map(|v| v.as_slice()).collect();
        let batch = encode_casv_video(&refs, w, h, 24, 1, &opts).unwrap();
        let mut src = VecFrames { frames: frames.clone(), i: 0, w, h };
        let stream = encode_casv_video_streaming(&mut src, &opts).unwrap();
        for i in 1..frames.len() {
            assert_eq!(
                casv_frame_slice(&batch, i).unwrap(),
                casv_frame_slice(&stream, i).unwrap(),
                "P-frame {i}: reused streaming scratch must match batch's fresh buffers"
            );
        }
        assert!(decode_casv_all_rgb8(&stream).is_some());
    }

    #[test]
    fn jolt_stream_to_sink_writes_rate_box() {
        let (w, h) = (48u32, 48u32);
        let frames = low_motion(w, h, 6);
        let mut fs = VecFrames { frames: frames.clone(), i: 0, w, h };
        let mut sink: Vec<u8> = Vec::new();
        jolt_encode_stream_to(&mut fs, JoltPreset::Balanced, &mut sink).unwrap();

        // Rate box parses and matches the preset.
        let flags = parse_casv_rate_box(&sink).expect("rate box present");
        assert_ne!(flags & CASV_HDRFLAG_LOSSY, 0);
        assert_eq!((flags >> 8) & 0xFF, 10, "distance 1.0 -> q10");
        assert_eq!((flags >> 16) & 0xF, 3, "effort 3");

        // Legacy reader path unaffected: footer parses, frames decode.
        let f = parse_casv_footer(&sink).unwrap();
        assert_eq!(f.frame_count, 6);
        assert_eq!(decode_casv_footer_all_rgb8(&sink).unwrap().len(), 6);

        // Legacy files (no rate box) read as None: splice the 8-byte box out.
        let idx_end = f.index_offset as usize + 6 * CASV_INDEX_ENTRY_BYTES;
        let mut legacy = sink[..idx_end].to_vec();
        legacy.extend_from_slice(&sink[idx_end + 8..]);
        assert!(parse_casv_footer(&legacy).is_some(), "footer still valid");
        assert_eq!(parse_casv_rate_box(&legacy), None);
        assert_eq!(decode_casv_footer_all_rgb8(&legacy).unwrap().len(), 6);
    }
}

#[cfg(test)]
#[cfg(feature = "jxl-codec")]
mod csau_tests {
    use super::*;

    #[test]
    fn csau_write_parse_roundtrip() {
        let fake_ogg = b"OggS\x00fake_audio_bytes";
        let frame = vec![128u8; 64 * 64 * 3];
        let frames = vec![frame.clone(), frame];
        let opts = CasaVideoOptions {
            rate: VideoRate::Lossy(1.0),
            gop_len: 2,
            skip: SkipMode::Tile,
            tile: 16,
            effort: 1,
            thresh: Some(4),
            rate_control: None,
        };
        let casv = encode_casv_video_with_audio(&frames, 64, 64, 24, 1, &opts, Some(fake_ogg))
            .unwrap();
        let audio = parse_casv_audio_box(&casv).expect("CSAU box not found in output");
        assert_eq!(audio, fake_ogg.as_slice());
    }

    #[test]
    fn csau_absent_when_no_audio_given() {
        let frame = vec![128u8; 64 * 64 * 3];
        let frames = vec![frame.clone(), frame];
        let opts = CasaVideoOptions {
            rate: VideoRate::Lossy(1.0),
            gop_len: 2,
            skip: SkipMode::Tile,
            tile: 16,
            effort: 1,
            thresh: Some(4),
            rate_control: None,
        };
        let casv = encode_casv_video_with_audio(&frames, 64, 64, 24, 1, &opts, None).unwrap();
        assert!(parse_casv_audio_box(&casv).is_none(), "no CSAU box expected when ogg=None");
    }
}
