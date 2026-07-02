//! Canon CR2 raw decoder.
//!
//! CR2 is a TIFF container with a Canon-specific extension at bytes 8–15.
//! The raw image is stored as a Lossless JPEG (LJPEG) strip in IFD3.
//! White balance is extracted from the Canon MakerNote ColorData tag (0x4001).
//!
//! # Optimisation notes (Response 1 + Response 2)
//!
//! - IFD traversal: zero-allocation visitor pattern (no Vec per IFD).
//! - ColorData WB: parsed directly from file bytes (no Vec<u16>).
//! - BlackLevel: IFD tags 0xC61A / 0xC632 are now applied (was dead stub).
//! - Crop: in-place compaction within the decode buffer; second Vec eliminated.
//! - SOF parser: seg_len bounds-checked before advancing.
//! - IFD entry count capped at 512 for corrupt-file safety.
//! - CR2Slices: validated before use.
//! - ScratchBuffers API: reuse decode buffer across batch calls.
//! - Cr2Timings: per-phase timing for benchmarks.
//! - Multi-lens review: overflow guard on decoded dimensions; vestigial Cfa re-export removed.

use crate::ljpeg;
use crate::tiff::{visit_ifd, RawImageMeta};
use anyhow::{anyhow, bail, Context, Result};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct Cr2Image {
    pub width:        usize,
    pub height:       usize,
    pub raw:          Vec<u16>,
    pub black:        u16,
    pub white:        u16,
    pub wb_r:         f32,
    pub wb_g:         f32,
    pub wb_b:         f32,
    pub iso:          Option<u32>,
    pub color_matrix: Option<[[f32; 3]; 3]>,
    pub make:         String,
    pub model:        String,
    pub orientation:  u16,
    /// Bayer CFA phase (row_parity, col_parity) of the top-left cropped pixel.
    /// (0,0) = RGGB origin (Red at top-left). Derived from the SensorInfo
    /// active-area origin parity when the tag is present and consistent; the
    /// center-crop fallback is even-snapped so it always reports (0,0). The
    /// demosaicer must be told this.
    pub cfa_phase:    (u8, u8),
}

impl Cr2Image {
    pub fn meta(&self) -> RawImageMeta {
        RawImageMeta {
            width: self.width,
            height: self.height,
            wb_r: self.wb_r,
            wb_g: self.wb_g,
            wb_b: self.wb_b,
            color_matrix: self.color_matrix,
            orientation: self.orientation,
            make: self.make.clone(),
            model: self.model.clone(),
        }
    }
}

/// Per-phase decode timing. Zero-cost when `time_phases` is false.
#[derive(Debug, Default, Clone)]
pub struct Cr2Timings {
    /// Total wall time for decode_bytes.
    pub total_ms: f64,
    /// TIFF/EXIF/MakerNote parse time.
    pub parse_ms: f64,
    /// LJPEG decode time (dominant stage).
    pub ljpeg_ms: f64,
    /// Slice reassembly time. Fused path (shipped): the single fused
    /// reassemble+crop pass (crop_ms is then 0). Split path (bench-only): the
    /// full-raster rebuild. 0 for single-slice files.
    pub reassemble_ms: f64,
    /// Crop/output-construction time (single-slice compaction, scratch row copy,
    /// or split-path crop).
    pub crop_ms: f64,
    /// Bytes in full-frame decode buffer (before crop).
    pub raw_buf_bytes: usize,
    /// Bytes in final cropped output.
    pub crop_buf_bytes: usize,
    /// Canon CR2Slices geometry [n_full_slices, full_width, remainder_width].
    /// All zero ⇒ single-slice file (raster order, no reassembly).
    pub slices: [u16; 3],
}

/// Reusable decode-buffer for batch processing. Avoids per-call full-frame allocation.
#[derive(Default)]
pub struct ScratchBuffers {
    pub raw: Vec<u16>,
}

// ---------------------------------------------------------------------------
// Low-level byte helpers
// ---------------------------------------------------------------------------

#[inline(always)]
fn read_u16(data: &[u8], off: usize, le: bool) -> u16 {
    // Bounds-safe (mirrors dng::read_u16). Returns 0 on OOB/overflow; for valid files the
    // offset is always in range so this is output-identical. Direct `&data[off..off + 2]`
    // panics on OOB and `off + 2` can wrap on 32-bit/wasm.
    let end = match off.checked_add(2) {
        Some(e) => e,
        None => return 0,
    };
    match data.get(off..end) {
        Some(b) => {
            if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) }
        }
        None => 0,
    }
}

#[inline(always)]
fn read_u32(data: &[u8], off: usize, le: bool) -> u32 {
    // Bounds-safe (mirrors dng::read_u32). Returns 0 on OOB/overflow; for valid files the
    // offset is always in range so this is output-identical.
    let end = match off.checked_add(4) {
        Some(e) => e,
        None => return 0,
    };
    match data.get(off..end) {
        Some(b) => {
            if le { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) }
        }
        None => 0,
    }
}

fn type_size(t: u16) -> usize {
    match t {
        1 | 2 | 6 | 7 => 1,
        3 | 8          => 2,
        4 | 9 | 11     => 4,
        5 | 10 | 12    => 8,
        _              => 0,
    }
}

fn entry_first_u32(data: &[u8], dtype: u16, cnt: u32, val: u32, inline_pos: usize, le: bool) -> Option<u32> {
    if cnt == 0 { return None; }
    let ts = type_size(dtype);
    if ts == 0 { return None; }
    // u64 math: ts*cnt is file-controlled and can wrap usize on 32-bit/wasm,
    // spuriously selecting the inline branch. Same result for all valid files.
    let inline = (ts as u64) * (cnt as u64) <= 4;
    let p = if inline { inline_pos } else { val as usize };
    // Checked add: `p` and `ts` are file-controlled; `p + ts` can wrap on 32-bit/wasm and
    // defeat the bounds guard. OOB/overflow returns None (unchanged for valid files).
    if p.checked_add(ts).map_or(true, |e| e > data.len()) { return None; }
    match dtype {
        1 | 6 => data.get(p).map(|&b| b as u32),
        3 | 8 => Some(read_u16(data, p, le) as u32),
        4 | 9 => Some(read_u32(data, p, le)),
        _     => None,
    }
}

fn read_ascii(data: &[u8], cnt: u32, val: u32, inline_pos: usize) -> String {
    if cnt == 0 { return String::new(); }
    let (p, len) = if cnt <= 4 { (inline_pos, cnt as usize) } else { (val as usize, cnt as usize) };
    // Checked add: on 32-bit/wasm `p + len` (both from file-controlled u32) can wrap below
    // data.len() and pass an unchecked compare, then `&data[p..p + len]` panics. Same valid
    // output: in-bounds returns the string; OOB/overflow returns empty (unchanged behaviour).
    match p.checked_add(len) {
        Some(end) if end <= data.len() => {}
        _ => return String::new(),
    }
    String::from_utf8_lossy(&data[p..p + len])
        .trim_end_matches('\0')
        .to_string()
}

// ---------------------------------------------------------------------------
// Zero-alloc ColorData WB extraction  (Response 1 item 5)
// ---------------------------------------------------------------------------

/// Extract WB multipliers directly from file bytes — no Vec<u16> allocation.
/// Reads version word then navigates to the AsShot WB index.
fn extract_wb_from_raw(data: &[u8], off: usize, cnt: u32, le: bool) -> Option<(f32, f32)> {
    // Checked offset derivation: `off` is file-controlled (val as usize from MakerNote tag).
    // On 32-bit/wasm `off + 2` and `base + 8` (base = off + wb_index*2) can wrap below
    // data.len() and defeat the bounds guard, reading unrelated bytes as WB multipliers.
    // For valid files base is small and in-bounds, so WB is unchanged.
    if cnt < 1 || off.checked_add(2).map_or(true, |e| e > data.len()) { return None; }
    let version   = read_u16(data, off, le);
    let wb_index: usize = if version >= 6 { 63 } else { 25 };
    if (cnt as usize) < wb_index + 4 { return None; }
    let base = match off.checked_add(wb_index * 2) {
        Some(b) => b,
        None => return None,
    };
    if base.checked_add(8).map_or(true, |e| e > data.len()) { return None; }
    let r  = read_u16(data, base,     le) as f32;
    let g1 = read_u16(data, base + 2, le) as f32;
    // g2 = read_u16(data, base + 4, le) — not used
    let b  = read_u16(data, base + 6, le) as f32;
    if g1 < 1.0 { return None; }
    Some((r / g1, b / g1))
}

// ---------------------------------------------------------------------------
// LJPEG SOF3 scan  (Response 1 item 13 — hardened)
// ---------------------------------------------------------------------------

/// Parse SOF3 marker inside a LJPEG stream. Returns (precision, height, width, ncomp).
/// Segment lengths are bounds-checked before advancing to prevent malformed-marker traversal.
fn parse_ljpeg_sof(data: &[u8], strip_off: usize, strip_len: usize) -> Option<(u8, u16, u16, u8)> {
    // SEC-005: strip_off + strip_len can overflow usize on wasm32 when
    // file-supplied values are near usize::MAX.
    let end = strip_off.checked_add(strip_len)?.min(data.len());
    let buf = data.get(strip_off..end)?;
    let mut i = 0;
    while i + 3 < buf.len() {
        if buf[i] != 0xFF { i += 1; continue; }
        let marker = buf[i + 1];
        if marker == 0xC3 {
            if i + 10 > buf.len() { return None; }
            let precision = buf[i + 4];
            let height    = u16::from_be_bytes([buf[i + 5], buf[i + 6]]);
            let width     = u16::from_be_bytes([buf[i + 7], buf[i + 8]]);
            let ncomp     = buf[i + 9];
            return Some((precision, height, width, ncomp));
        }
        match marker {
            0xD8 => { i += 2; continue; }  // SOI — no length field
            0xDA | 0xD9 => return None,     // SOS (data starts) or EOI
            _ => {}
        }
        // Variable-length segment: validate seg_len before advancing.
        if i + 4 > buf.len() { return None; }
        let seg_len = u16::from_be_bytes([buf[i + 2], buf[i + 3]]) as usize;
        if seg_len < 2 { return None; }           // malformed: length includes itself
        let next = i + 2 + seg_len;
        if next > buf.len() { return None; }       // OOB guard
        i = next;
    }
    None
}

// ---------------------------------------------------------------------------
// Per-model camera colour matrices (CR2 has no DNG ColorMatrix tag)
// ---------------------------------------------------------------------------

/// dcraw/libraw-style camera characterisation matrices (XYZ -> camera RGB, scaled *10000).
///
/// DISABLED: direct use of adobe_coeff XYZ→cam matrices in CasaWASM's WB-first pipeline
/// produces severely imbalanced output. The matrices assume un-WB-normalised camera values;
/// CasaWASM's pre-LUT applies WB gain before the matrix, causing channel collapse (e.g. G→0
/// on the 550D with r_mult≈2.2). Proper use requires scene-relative WB correction derived
/// from the matrix's implied D65 neutral — a non-trivial change deferred for a dedicated fix.
/// Until then, all bodies fall through to the generic CANON_CAM_TO_SRGB fallback.
#[allow(dead_code)]
fn canon_cam_xyz(_model: &str) -> Option<[i32; 9]> {
    None
}

/// Camera->sRGB matrix for a Canon body, or None (→ pipeline uses the generic CAM_TO_SRGB
/// fallback). Mirrors the DNG path (dng::choose_camera_to_srgb_matrix): treat the published
/// XYZ->cam like a DNG ColorMatrix, invert to camera->XYZ, then apply XYZ_D50_TO_SRGB. This
/// keeps CR2 colour consistent with how DNG colour is rendered in this pipeline.
fn canon_color_matrix(make: &str, model: &str) -> Option<[[f32; 3]; 3]> {
    // Alloc-free ASCII case-insensitive "canon" search (was a String alloc per decode).
    let has_canon = make.as_bytes().windows(5).any(|w| w.eq_ignore_ascii_case(b"canon"));
    if !has_canon {
        return None;
    }
    let raw = canon_cam_xyz(model)?;
    let cam_xyz = [
        [raw[0] as f32 / 10000.0, raw[1] as f32 / 10000.0, raw[2] as f32 / 10000.0],
        [raw[3] as f32 / 10000.0, raw[4] as f32 / 10000.0, raw[5] as f32 / 10000.0],
        [raw[6] as f32 / 10000.0, raw[7] as f32 / 10000.0, raw[8] as f32 / 10000.0],
    ];
    let cam_to_xyz = crate::dng::invert3x3(cam_xyz)?;
    Some(crate::dng::mul3x3(crate::dng::XYZ_D50_TO_SRGB, cam_to_xyz))
}

// ---------------------------------------------------------------------------
// Decode entry points
// ---------------------------------------------------------------------------

/// Bench/parity-only selector for the slice-reassembly pipeline.
/// Fused is the shipped path; Split* preserve the legacy two-pass pipeline
/// (full-raster rebuild, then in-place crop) for A/B flips and parity tests.
#[doc(hidden)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReassemblyVariant { Fused, SplitBulk, SplitScatter }

/// Decode CR2 from raw bytes. Single call, no second Vec allocation.
pub fn decode_bytes(data: &[u8]) -> Result<Cr2Image> {
    let mut buf = Vec::new();
    decode_impl(data, &mut buf, true, None, false, ReassemblyVariant::Fused)
        .map(|(img, _, _)| img)
}

/// Decode forcing a legacy split slice-reassembly variant (bench only).
/// `use_scatter=true` selects the pre-#1 scalar scatter; `false` the split bulk copy.
#[doc(hidden)]
pub fn decode_bytes_variant(data: &[u8], use_scatter: bool) -> Result<Cr2Image> {
    let v = if use_scatter { ReassemblyVariant::SplitScatter } else { ReassemblyVariant::SplitBulk };
    decode_bytes_reassembly(data, v)
}

/// Decode with an explicit reassembly variant (bench/parity only).
#[doc(hidden)]
pub fn decode_bytes_reassembly(data: &[u8], v: ReassemblyVariant) -> Result<Cr2Image> {
    let mut buf = Vec::new();
    decode_impl(data, &mut buf, true, None, false, v).map(|(img, _, _)| img)
}

/// Decode with per-phase timings for benchmarking (native — uses std::time::Instant).
pub fn decode_bytes_bench(data: &[u8]) -> Result<(Cr2Image, Cr2Timings)> {
    let mut buf = Vec::new();
    let base = std::time::Instant::now();
    let clock = move || base.elapsed().as_secs_f64() * 1000.0;
    decode_impl(data, &mut buf, true, Some(&clock), false, ReassemblyVariant::Fused)
        .map(|(img, t, _)| (img, t))
}

/// Decode with per-phase timings using a caller-supplied monotonic millisecond clock.
/// Lets the wasm pipeline measure phases via now_ms() (std::time::Instant is unavailable
/// on wasm32-unknown-unknown). Returns the same Cr2Timings as decode_bytes_bench.
pub fn decode_bytes_with_clock(
    data: &[u8],
    clock: &dyn Fn() -> f64,
) -> Result<(Cr2Image, Cr2Timings)> {
    let mut buf = Vec::new();
    decode_impl(data, &mut buf, true, Some(clock), false, ReassemblyVariant::Fused)
        .map(|(img, t, _)| (img, t))
}

/// Decode with full LJPEG stage statistics (for profiling only — slightly slower due to counters).
pub fn decode_bytes_with_ljpeg_stats(data: &[u8]) -> Result<(Cr2Image, ljpeg::LjpegStats)> {
    let mut buf = Vec::new();
    decode_impl(data, &mut buf, true, None, true, ReassemblyVariant::Fused)
        .map(|(img, _, stats)| (img, stats.expect("capture_stats=true always yields Some")))
}

/// Decode reusing scratch buffer to avoid per-call full-frame allocation (batch mode).
/// The scratch.raw buffer grows to full-frame size on the first call and is reused thereafter.
pub fn decode_with_scratch(data: &[u8], scratch: &mut ScratchBuffers) -> Result<Cr2Image> {
    decode_impl(data, &mut scratch.raw, false, None, false, ReassemblyVariant::Fused)
        .map(|(img, _, _)| img)
}

/// Batch decode with reusable scratch AND per-phase timings — the production
/// wasm path: the full-frame decode buffer stays warm across frames within a
/// worker, so repeat decodes skip the full-frame allocation + zero-fill.
/// `clock` is a caller-supplied monotonic millisecond clock (wasm-safe; see
/// decode_bytes_with_clock).
pub fn decode_with_scratch_clock(
    data: &[u8],
    scratch: &mut ScratchBuffers,
    clock: &dyn Fn() -> f64,
) -> Result<(Cr2Image, Cr2Timings)> {
    decode_impl(data, &mut scratch.raw, false, Some(clock), false, ReassemblyVariant::Fused)
        .map(|(img, t, _)| (img, t))
}

/// Reorder Canon multi-slice LJPEG output from stream-stacked vertical slices into
/// a single side-by-side raster of width `stride`. The decoded buffer holds slice 0's
/// whole `nw × high` block, then slice 1's, …, then a trailing remainder slice of
/// width `lw`. Slice i (i<n) lands at column `i*nw`; the remainder at `n*nw`.
///
/// Contiguous per-row copies — no per-pixel division/modulo. Equivalent to the scalar
/// reference `row = local/sw; col = local%sw + i*nw` (see reassemble_slices_scatter in
/// tests), since each (slice,row) is a contiguous `sw`-wide run in both source and dest.
fn reassemble_slices(
    src: &[u16],
    stride: usize,
    high: usize,
    n: usize,
    nw: usize,
    lw: usize,
) -> Vec<u16> {
    let buf_len = src.len(); // == stride * high
    let mut raster = vec![0u16; stride * high];
    let block = nw.saturating_mul(high);
    for i in 0..n {
        let col0 = i * nw;
        if nw == 0 || col0 >= stride { break; }
        let run = nw.min(stride - col0);
        let src_base = i * block;
        for row in 0..high {
            let s = src_base + row * nw;
            if s + run > buf_len { break; }
            let d = row * stride + col0;
            raster[d..d + run].copy_from_slice(&src[s..s + run]);
        }
    }
    if lw != 0 {
        let col0 = n * nw;
        if col0 < stride {
            let run = lw.min(stride - col0);
            let src_base = n * block;
            for row in 0..high {
                let s = src_base + row * lw;
                if s + run > buf_len { break; }
                let d = row * stride + col0;
                raster[d..d + run].copy_from_slice(&src[s..s + run]);
            }
        }
    }
    raster
}

/// Reference scalar scatter — the pre-#1 slice mapping (per-pixel divisions). Retained
/// for parity tests and the bulk-vs-scatter flip bench; `reassemble_slices` must stay
/// byte-identical to this. Not used by the shipped decode path.
#[doc(hidden)]
pub fn reassemble_slices_scatter(
    src: &[u16], stride: usize, high: usize, n: usize, nw: usize, lw: usize,
) -> Vec<u16> {
    let block = nw * high;
    let mut raster = vec![0u16; stride * high];
    for jidx in 0..(stride * high) {
        let mut i = jidx / block;
        let last = i >= n;
        if last { i = n; }
        let local = jidx - i * block;
        let sw = if last { lw } else { nw };
        if sw == 0 { break; }
        let row = local / sw;
        let col = local % sw + i * nw;
        if row < high && col < stride {
            raster[row * stride + col] = src[jidx];
        }
    }
    raster
}

/// Locate the raw LJPEG strip and its output geometry (bench/parity tooling
/// only — mirrors the strip/SOF3 walk in decode_impl without decoding).
/// Returns (strip_offset, strip_len, stride_pixels = sof_w*ncomp, rows = sof_h).
#[doc(hidden)]
pub fn ljpeg_strip_geometry(data: &[u8]) -> Result<(usize, usize, usize, usize)> {
    if data.len() < 16 {
        bail!("CR2: file too small ({} bytes)", data.len());
    }
    let le = match &data[0..4] {
        [0x49, 0x49, 0x2A, 0x00] => true,
        [0x4D, 0x4D, 0x00, 0x2A] => false,
        m => bail!("CR2: not a TIFF file (magic {:?})", m),
    };
    if &data[8..10] != b"CR" {
        bail!("CR2: missing Canon CR marker at offset 8");
    }
    let raw_ifd_off = read_u32(data, 12, le) as usize;
    if raw_ifd_off == 0 || raw_ifd_off >= data.len() {
        bail!("CR2: invalid raw IFD offset {}", raw_ifd_off);
    }
    let mut strip_offset: u32 = 0;
    let mut strip_byte_count: u32 = 0;
    visit_ifd(data, raw_ifd_off, le, |tag, dtype, cnt, val, ip| match tag {
        0x0111 => strip_offset     = entry_first_u32(data, dtype, cnt, val, ip, le).unwrap_or(0),
        0x0117 => strip_byte_count = entry_first_u32(data, dtype, cnt, val, ip, le).unwrap_or(0),
        _ => {}
    });
    if strip_offset == 0 || strip_byte_count == 0 {
        bail!("CR2: missing strip offset or byte count in raw IFD");
    }
    let strip_off = strip_offset as usize;
    let strip_len = strip_byte_count as usize;
    match strip_off.checked_add(strip_len) {
        Some(e) if e <= data.len() => {}
        _ => bail!("CR2: strip out of bounds"),
    }
    let (_prec, sof_h, sof_w, ncomp) = parse_ljpeg_sof(data, strip_off, strip_len)
        .ok_or_else(|| anyhow!("CR2: could not find SOF3 marker in LJPEG strip"))?;
    Ok((strip_off, strip_len, sof_w as usize * ncomp as usize, sof_h as usize))
}

/// Canon MakerNote SensorInfo (tag 0x00E0): true sensor geometry + active-area
/// borders. Border indices follow exiftool's CanonSensorInfo: the active image
/// area is [left..=right] × [top..=bottom] in decoded-sensor coordinates.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SensorInfo {
    pub sensor_width:  u16,
    pub sensor_height: u16,
    pub left:   u16,
    pub top:    u16,
    pub right:  u16,
    pub bottom: u16,
}

impl SensorInfo {
    #[inline]
    pub fn active_width(&self) -> usize {
        (self.right as usize).saturating_sub(self.left as usize) + 1
    }
    #[inline]
    pub fn active_height(&self) -> usize {
        (self.bottom as usize).saturating_sub(self.top as usize) + 1
    }
}

/// Decode a MakerNote SensorInfo entry (tag 0x00E0, SHORT array, ≥ 9 elements:
/// idx 0 reserved, 1..=8 geometry). Returns None unless the borders are ordered
/// and inside the sensor grid.
fn sensor_info_from_entry(
    data: &[u8], dtype: u16, cnt: u32, val: u32, ip: usize, le: bool,
) -> Option<SensorInfo> {
    if dtype != 3 || cnt < 9 { return None; }
    // cnt ≥ 9 SHORTs never fits inline, but keep the general multiply-free test.
    let p = if cnt <= 2 { ip } else { val as usize };
    // 9 SHORTs = 18 bytes needed from p (checked add: p is file-controlled).
    if p.checked_add(18).map_or(true, |e| e > data.len()) { return None; }
    let at = |i: usize| read_u16(data, p + i * 2, le);
    let cand = SensorInfo {
        sensor_width:  at(1),
        sensor_height: at(2),
        left:   at(5),
        top:    at(6),
        right:  at(7),
        bottom: at(8),
    };
    (cand.left < cand.right
        && cand.top < cand.bottom
        && (cand.right as usize) < cand.sensor_width as usize
        && (cand.bottom as usize) < cand.sensor_height as usize)
        .then_some(cand)
}

/// Parse Canon SensorInfo (MakerNote tag 0x00E0) from a CR2.
/// Walk mirrors decode_impl: IFD0 → ExifIFD → MakerNote. Returns None when the
/// tag is missing/malformed (caller falls back to the center-crop heuristic).
#[doc(hidden)]
pub fn parse_sensor_info(data: &[u8]) -> Option<SensorInfo> {
    if data.len() < 16 { return None; }
    let le = match &data[0..4] {
        [0x49, 0x49, 0x2A, 0x00] => true,
        [0x4D, 0x4D, 0x00, 0x2A] => false,
        _ => return None,
    };
    if &data[8..10] != b"CR" { return None; }
    let ifd0_off = read_u32(data, 4, le) as usize;

    let mut exif_ifd_off: u32 = 0;
    visit_ifd(data, ifd0_off, le, |tag, _dtype, _cnt, val, _ip| {
        if tag == 0x8769 { exif_ifd_off = val; }
    });
    if exif_ifd_off == 0 || (exif_ifd_off as usize) >= data.len() { return None; }

    let mut makernote_off: u32 = 0;
    let mut makernote_len: u32 = 0;
    visit_ifd(data, exif_ifd_off as usize, le, |tag, _dtype, cnt, val, _ip| {
        if tag == 0x927C { makernote_off = val; makernote_len = cnt; }
    });
    if makernote_off == 0 || makernote_len < 2 { return None; }
    let mn_off = makernote_off as usize;
    if mn_off.checked_add(2).map_or(true, |e| e > data.len()) { return None; }

    let mut si: Option<SensorInfo> = None;
    visit_ifd(data, mn_off, le, |tag, dtype, cnt, val, ip| {
        if tag == 0x00E0 {
            if let Some(cand) = sensor_info_from_entry(data, dtype, cnt, val, ip, le) {
                si = Some(cand);
            }
        }
    });
    si
}

/// Select the crop origin + CFA phase. Prefers the camera's own SensorInfo
/// active-area borders when they are consistent with the decoded grid and the
/// IFD0 crop dims; otherwise falls back to the even-snapped center-crop
/// heuristic (phase (0,0) by construction). The SensorInfo origin is NOT
/// snapped — its true parity is carried out as the CFA phase.
fn choose_crop_origin(
    si: Option<SensorInfo>,
    decoded_width: usize,
    decoded_height: usize,
    crop_w: usize,
    crop_h: usize,
) -> (usize, usize, (u8, u8)) {
    if let Some(si) = si {
        let (ls, ts) = (si.left as usize, si.top as usize);
        if si.active_width() == crop_w
            && si.active_height() == crop_h
            && si.sensor_width as usize == decoded_width
            && si.sensor_height as usize == decoded_height
            && ls + crop_w <= decoded_width
            && ts + crop_h <= decoded_height
        {
            return (ls, ts, ((ts & 1) as u8, (ls & 1) as u8));
        }
    }
    let mut left = (decoded_width - crop_w) / 2;
    let mut top = (decoded_height - crop_h) / 2;
    if left & 1 != 0 { left -= 1; }
    if top & 1 != 0 { top -= 1; }
    (left, top, (0, 0))
}

/// Fused multi-slice reassembly + crop. Builds the final crop_w×crop_h raster
/// directly from the STACKED slice decode buffer — no full-raster temp, no
/// zero-fill, no separate crop pass. Row-major output construction: for each
/// output row, append the crop-window intersection of each vertical slice in
/// left-to-right order. The intersections tile [0, crop_w) exactly because the
/// slices tile [0, stride) and decode_impl enforces stride == n*nw + lw.
/// Byte-identical to reassemble_slices(..) followed by the row crop (see
/// tests::fused_reassemble_crop_matches_split_composition).
fn reassemble_slices_crop(
    src: &[u16],
    stride: usize,
    high: usize,
    n: usize,
    nw: usize,
    lw: usize,
    left: usize,
    top: usize,
    crop_w: usize,
    crop_h: usize,
) -> Vec<u16> {
    // Per-slice crop intersection: source block base, slice width, first source
    // column, run length. ≤ n+1 entries — computed once, reused for every row.
    struct Seg { src_base: usize, sw: usize, src_col: usize, run: usize }
    let block = nw * high;
    let crop_right = left + crop_w;
    let mut segs: Vec<Seg> = Vec::with_capacity(n + 1);
    for i in 0..=n {
        let sw = if i < n { nw } else { lw };
        if sw == 0 { continue; } // lw==0 → no remainder slice
        let col0 = i * nw;
        if col0 >= stride { break; }
        let sw_eff = sw.min(stride - col0);
        let lo = col0.max(left);
        let hi = (col0 + sw_eff).min(crop_right);
        if lo >= hi { continue; }
        segs.push(Seg { src_base: i * block, sw, src_col: lo - col0, run: hi - lo });
    }
    let mut out = Vec::with_capacity(crop_w * crop_h);
    for row in 0..crop_h {
        let y = top + row;
        for s in &segs {
            let p = s.src_base + y * s.sw + s.src_col;
            out.extend_from_slice(&src[p..p + s.run]);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

/// `move_buf`: when true, moves `raw_buf` into the returned Cr2Image (no copy of crop data).
///             when false, clones crop data from raw_buf (scratch retains capacity).
fn decode_impl(
    data:           &[u8],
    raw_buf:        &mut Vec<u16>,
    move_buf:       bool,
    clock:          Option<&dyn Fn() -> f64>,
    capture_stats:  bool,
    variant:        ReassemblyVariant, // Fused = shipped; Split* = bench/parity only
) -> Result<(Cr2Image, Cr2Timings, Option<ljpeg::LjpegStats>)> {
    // Phase timing is driven by an injected monotonic millisecond clock rather than
    // std::time::Instant, which is unavailable on wasm32-unknown-unknown (panics).
    // Native callers pass an Instant-backed closure; the wasm pipeline passes now_ms.
    // `mark()` samples a start; `elapsed()` returns the delta (0.0 when untimed).
    let mark = || clock.map(|c| c());
    let elapsed = |start: Option<f64>| match (clock, start) {
        (Some(c), Some(s)) => c() - s,
        _ => 0.0,
    };
    let t_total = mark();

    // Minimum: TIFF header (8) + CR2 extension (8) = 16 bytes.
    if data.len() < 16 {
        bail!("CR2: file too small ({} bytes)", data.len());
    }

    let le = match &data[0..4] {
        [0x49, 0x49, 0x2A, 0x00] => true,
        [0x4D, 0x4D, 0x00, 0x2A] => false,
        m => bail!("CR2: not a TIFF file (magic {:?})", m),
    };

    if &data[8..10] != b"CR" {
        bail!("CR2: missing Canon CR marker at offset 8");
    }

    let ifd0_off    = read_u32(data, 4,  le) as usize;
    let raw_ifd_off = read_u32(data, 12, le) as usize;

    // -----------------------------------------------------------------------
    // Parse pass: IFD0 → ExifIFD → MakerNote → RAW IFD
    // -----------------------------------------------------------------------
    let t_parse = mark();

    // IFD0: image dimensions, orientation, strings, ExifIFD pointer
    let mut img_width:    u32 = 0;
    let mut img_height:   u32 = 0;
    let mut orientation:  u16 = 1;
    let mut make          = String::new();
    let mut model         = String::new();
    let mut exif_ifd_off: u32 = 0;

    visit_ifd(data, ifd0_off, le, |tag, dtype, cnt, val, ip| match tag {
        0x0100 => img_width    = entry_first_u32(data, dtype, cnt, val, ip, le).unwrap_or(0),
        0x0101 => img_height   = entry_first_u32(data, dtype, cnt, val, ip, le).unwrap_or(0),
        0x0112 => orientation  = entry_first_u32(data, dtype, cnt, val, ip, le).unwrap_or(1) as u16,
        0x010F => make         = read_ascii(data, cnt, val, ip),
        0x0110 => model        = read_ascii(data, cnt, val, ip),
        0x8769 => exif_ifd_off = val,
        _      => {}
    });

    if img_width == 0 || img_height == 0 {
        bail!("CR2: zero image dimensions in IFD0 (w={}, h={})", img_width, img_height);
    }

    // ExifIFD: ISO, MakerNote pointer
    let mut iso:           Option<u32> = None;
    let mut makernote_off: u32 = 0;
    let mut makernote_len: u32 = 0;

    if exif_ifd_off > 0 && (exif_ifd_off as usize) < data.len() {
        visit_ifd(data, exif_ifd_off as usize, le, |tag, dtype, cnt, val, ip| match tag {
            0x8827 => iso           = entry_first_u32(data, dtype, cnt, val, ip, le),
            0x927C => { makernote_off = val; makernote_len = cnt; }
            _      => {}
        });
    }

    // Canon MakerNote: zero-alloc WB extraction (item 5) + SensorInfo capture
    // (0x00E0, true active-area borders) in the same single visit.
    let mut wb_r: f32 = 2.0;
    let mut wb_b: f32 = 1.7;
    let mut sensor_info: Option<SensorInfo> = None;

    if makernote_off > 0 && makernote_len >= 2 {
        let mn_off = makernote_off as usize;
        // Checked add: makernote_off is file-controlled; `mn_off + 2` can wrap on 32-bit.
        if mn_off.checked_add(2).map_or(false, |e| e <= data.len()) {
            visit_ifd(data, mn_off, le, |tag, dtype, cnt, val, ip| match tag {
                0x4001 if dtype == 3 && cnt > 0 => {
                    // cnt<=2 ⟺ 2*cnt<=4 without the file-controlled multiply
                    // (2*cnt wraps usize on 32-bit/wasm for huge cnt).
                    let p = if cnt <= 2 { ip } else { val as usize };
                    if let Some((r, b)) = extract_wb_from_raw(data, p, cnt, le) {
                        wb_r = r;
                        wb_b = b;
                    }
                }
                0x00E0 => {
                    if let Some(cand) = sensor_info_from_entry(data, dtype, cnt, val, ip, le) {
                        sensor_info = Some(cand);
                    }
                }
                _ => {}
            });
        }
    }

    // RAW IFD: strip address, CR2Slices, BlackLevel (item 1)
    if raw_ifd_off == 0 || raw_ifd_off >= data.len() {
        bail!("CR2: invalid raw IFD offset {}", raw_ifd_off);
    }

    let mut strip_offset:     u32 = 0;
    let mut strip_byte_count: u32 = 0;
    let mut cr2_slices:       [u16; 3] = [0; 3];
    let mut have_slices:      bool = false;
    let mut black_from_ifd:   u16 = 0;

    visit_ifd(data, raw_ifd_off, le, |tag, dtype, cnt, val, ip| match tag {
        0x0111 => strip_offset     = entry_first_u32(data, dtype, cnt, val, ip, le).unwrap_or(0),
        0x0117 => strip_byte_count = entry_first_u32(data, dtype, cnt, val, ip, le).unwrap_or(0),
        0xC640 if dtype == 3 && cnt >= 3 => {
            // cnt >= 3 SHORTs = 6 bytes — never inline; the old `2 * cnt` form
            // could wrap usize on 32-bit/wasm and spuriously pick the inline arm.
            let p = val as usize;
            // Checked add: `p + 6` can wrap on 32-bit/wasm and spuriously pass the guard.
            if p.checked_add(6).map_or(false, |e| e <= data.len()) {
                cr2_slices[0] = read_u16(data, p,     le);
                cr2_slices[1] = read_u16(data, p + 2, le);
                cr2_slices[2] = read_u16(data, p + 4, le);
                have_slices = cr2_slices[0] > 0;
            }
        }
        // BlackLevel tags: 0xC61A (first plausible value wins) (item 1 fix)
        0xC61A | 0xC632 if black_from_ifd == 0 => {
            if let Some(b) = entry_first_u32(data, dtype, cnt, val, ip, le) {
                if b > 0 && b < 8192 {
                    black_from_ifd = b as u16;
                }
            }
        }
        _ => {}
    });

    let parse_ms = elapsed(t_parse);

    if strip_offset == 0 || strip_byte_count == 0 {
        bail!("CR2: missing strip offset or byte count in raw IFD");
    }

    let strip_off = strip_offset     as usize;
    let strip_len = strip_byte_count as usize;
    // Checked add: strip_off/strip_len are file-controlled; `strip_off + strip_len` can wrap
    // on 32-bit/wasm and pass the guard, then `&data[strip_off..strip_off + strip_len]` (below)
    // would panic. Reject on overflow or OOB. Unchanged for valid files.
    let strip_end = match strip_off.checked_add(strip_len) {
        Some(e) if e <= data.len() => e,
        _ => bail!("CR2: strip [off={}, len={}] out of bounds (file size {})",
                   strip_off, strip_len, data.len()),
    };

    // -----------------------------------------------------------------------
    // SOF3 parse
    // -----------------------------------------------------------------------
    let (precision, sof_h, sof_w, ncomp) = parse_ljpeg_sof(data, strip_off, strip_len)
        .ok_or_else(|| anyhow!("CR2: could not find SOF3 marker in LJPEG strip"))?;

    let sof_h = sof_h as usize;
    let sof_w = sof_w as usize;
    let ncomp = ncomp as usize;

    if sof_w == 0 || sof_h == 0 || ncomp == 0 {
        bail!("CR2: invalid SOF3 dimensions {}×{} ncomp={}", sof_w, sof_h, ncomp);
    }
    // Overflow guard: corrupt files can claim huge dimensions → OOM (multi-lens review).
    // No known RAW sensor exceeds 200 MP.
    let total_check = (sof_w as u64)
        .saturating_mul(ncomp as u64)
        .saturating_mul(sof_h as u64);
    if total_check > 200_000_000 {
        bail!("CR2: implausible decoded dimensions {}×{}×{} = {} px", sof_w, sof_h, ncomp, total_check);
    }

    // CR2Slices: validated before use (item 15)
    let decoded_width: usize = if have_slices {
        let n  = cr2_slices[0] as usize;
        let nw = cr2_slices[1] as usize;
        let lw = cr2_slices[2] as usize;
        if n > 32 || nw == 0 {
            bail!("CR2: implausible CR2Slices [{} {} {}]", n, nw, lw);
        }
        n * nw + lw
    } else {
        sof_w * ncomp
    };

    // -----------------------------------------------------------------------
    // LJPEG decode — single allocation, in-place crop eliminates second Vec
    // -----------------------------------------------------------------------
    let stride        = sof_w * ncomp;

    // The decode buffer's true row length is `stride` (decode_tile is called with
    // stride_pixels = stride below); the crop steps source addresses by `stride` while
    // bounds-checking/centering against `decoded_width`. For valid CR2 files the CR2Slices
    // triple satisfies n*nw + lw == sof_w*ncomp, so these are equal. If they differ the
    // file is inconsistent and the stride-stepped crop would shear/garble (or panic);
    // fail explicitly instead of emitting corrupt pixels. Guard-only — no valid output change.
    if decoded_width != stride {
        bail!(
            "CR2: CR2Slices width {} disagrees with LJPEG stride {} (sof_w={} ncomp={})",
            decoded_width, stride, sof_w, ncomp
        );
    }

    let total_pixels  = stride * sof_h;
    let raw_buf_bytes = total_pixels * 2;

    raw_buf.resize(total_pixels, 0);

    let strip_bytes = &data[strip_off..strip_end];
    let t_ljpeg = mark();
    let ljpeg_stats = if capture_stats {
        let s = ljpeg::decode_tile_stats(strip_bytes, raw_buf, 0, stride, stride, sof_h)
            .with_context(|| "CR2: LJPEG decode failed")?;
        Some(s)
    } else {
        ljpeg::decode_tile(strip_bytes, raw_buf, 0, stride, stride, sof_h)
            .with_context(|| "CR2: LJPEG decode failed")?;
        None
    };
    let ljpeg_ms = elapsed(t_ljpeg);

    // -----------------------------------------------------------------------
    // Black/white levels: IFD value overrides precision-table default (item 1)
    // -----------------------------------------------------------------------
    let (mut black, white) = match precision {
        14 => (2048u16, 15300u16),
        12 => (512u16,  4095u16),
        // precision is an unchecked u8 from the LJPEG SOF3 marker. `1u16 << precision`
        // overflows (panic in debug, wrong value in release) for precision >= 16. Guard:
        // precision >= 16 saturates white to u16::MAX; valid 8/10-bit paths are unchanged.
        _ if precision >= 16 => (0u16, u16::MAX),
        _  => (0u16, (1u16 << precision).saturating_sub(1)),
    };
    if black_from_ifd > 0 && black_from_ifd < white {
        black = black_from_ifd;
    }

    // -----------------------------------------------------------------------
    // Crop geometry
    // -----------------------------------------------------------------------
    let crop_w = img_width  as usize;
    let crop_h = img_height as usize;

    if decoded_width < crop_w || sof_h < crop_h {
        bail!("CR2: decoded size {}×{} smaller than expected {}×{}",
              decoded_width, sof_h, crop_w, crop_h);
    }

    // Crop origin: prefer the camera's own active-area borders (SensorInfo,
    // MakerNote 0x00E0) over the legacy center-crop heuristic. On real bodies
    // the center guess is wrong by up to 132 columns — it keeps optical-black
    // masked pixels in the output (band mean == black level) and discards the
    // same width of live image on the opposite edge (proof:
    // examples/cr2_activearea_evidence.rs). The CFA phase is the true origin
    // parity (no snapping); the green-channel check in the caller (src/lib.rs)
    // remains as a safety net for bodies whose LJPEG origin is not RGGB.
    // Fallback (tag absent/inconsistent): even-snapped center crop, phase (0,0).
    let (left, top, cfa_phase) =
        choose_crop_origin(sensor_info, decoded_width, sof_h, crop_w, crop_h);

    if left + crop_w > decoded_width || top + crop_h > sof_h {
        bail!("CR2: crop region [left={}, top={}, w={}, h={}] exceeds decoded {}×{}",
              left, top, crop_w, crop_h, decoded_width, sof_h);
    }

    // -----------------------------------------------------------------------
    // Output construction. Multi-slice: the LJPEG decodes to a buffer where the
    // N+1 vertical slices are STACKED in stream order (slice 0's whole nw×sof_h
    // block, then slice 1's, …); without reordering, multi-slice CR2s (e.g.
    // 5D-era, CR2Slices=[2,1728,1888], ncomp=4) decode to scrambled garbage.
    // Shipped Fused path: build the final crop directly from the stacked buffer
    // (no full-raster temp, no zero-fill, no separate crop pass). Algorithm
    // mirrors dcraw's lossless_jpeg slice distribution; components (ncomp) are
    // absorbed into `stride` so they need no separate de-interleave.
    // Single-slice files are already in raster order: owned path compacts rows
    // in place (no second Vec); scratch path copies crop rows straight out.
    // -----------------------------------------------------------------------
    let crop_len = crop_w * crop_h;
    let mut reassemble_ms = 0.0;
    let mut crop_ms = 0.0;
    let raw_out: Vec<u16>;

    if have_slices {
        let n  = cr2_slices[0] as usize;
        let nw = cr2_slices[1] as usize;
        let lw = cr2_slices[2] as usize;
        // Overflow guard for nw*high (both paths derive block = nw*high).
        nw.checked_mul(sof_h).ok_or_else(|| anyhow!("CR2: slice block overflow"))?;
        if variant == ReassemblyVariant::Fused {
            // raw_buf keeps the full-length stacked decode → in scratch mode the
            // next resize(total_pixels) is a no-op (no tail re-zero-fill).
            let t = mark();
            let out = reassemble_slices_crop(
                raw_buf, stride, sof_h, n, nw, lw, left, top, crop_w, crop_h);
            reassemble_ms = elapsed(t);
            if out.len() != crop_len {
                bail!("CR2: fused reassembly produced {} px, expected {}", out.len(), crop_len);
            }
            raw_out = out;
        } else {
            // Legacy split pipeline (bench/parity only): full raster, then crop.
            let t = mark();
            let raster = if variant == ReassemblyVariant::SplitScatter {
                reassemble_slices_scatter(raw_buf, stride, sof_h, n, nw, lw)
            } else {
                reassemble_slices(raw_buf, stride, sof_h, n, nw, lw)
            };
            // CRAWL E1: O(1) pointer move; the old stacked-slice buffer drops here.
            *raw_buf = raster;
            reassemble_ms = elapsed(t);
            let t_crop = mark();
            let crop_needed = top != 0 || left != 0 || decoded_width != crop_w;
            if crop_needed {
                for row in 0..crop_h {
                    let src = (top + row) * stride + left;
                    raw_buf.copy_within(src..src + crop_w, row * crop_w);
                }
            }
            raw_buf.truncate(crop_len);
            crop_ms = elapsed(t_crop);
            raw_out = if move_buf {
                std::mem::take(raw_buf)     // zero-copy — raw_buf left empty
            } else {
                raw_buf[..crop_len].to_vec()   // batch mode: clone crop, retain capacity
            };
        }
    } else if move_buf {
        // Single-slice owned path: in-place compaction within raw_buf — no
        // second Vec (items 8,9) — then move out.
        let t_crop = mark();
        let crop_needed = top != 0 || left != 0 || decoded_width != crop_w;
        if crop_needed {
            for row in 0..crop_h {
                let src = (top + row) * stride + left;
                raw_buf.copy_within(src..src + crop_w, row * crop_w);
            }
        }
        raw_buf.truncate(crop_len);
        crop_ms = elapsed(t_crop);
        raw_out = std::mem::take(raw_buf);  // zero-copy — raw_buf left empty
    } else {
        // Single-slice scratch path: copy crop rows straight into the output —
        // raw_buf is untouched and stays full-length, so the next decode's
        // resize(total_pixels) is a no-op (kills the warm-path tail re-zero and
        // the old crop-in-place + clone double copy).
        let t_crop = mark();
        let mut out = Vec::with_capacity(crop_len);
        for row in 0..crop_h {
            let src = (top + row) * stride + left;
            out.extend_from_slice(&raw_buf[src..src + crop_w]);
        }
        crop_ms = elapsed(t_crop);
        raw_out = out;
    }

    let crop_buf_bytes = crop_len * 2;
    let total_ms = elapsed(t_total);

    let timings = Cr2Timings {
        total_ms, parse_ms, ljpeg_ms, reassemble_ms, crop_ms,
        raw_buf_bytes, crop_buf_bytes,
        slices: if have_slices { cr2_slices } else { [0; 3] },
    };

    Ok((Cr2Image {
        width:        crop_w,
        height:       crop_h,
        raw:          raw_out,
        black,
        white,
        wb_r,
        wb_g:         1.0,
        wb_b,
        iso,
        color_matrix: canon_color_matrix(&make, &model),
        make,
        model,
        orientation,
        cfa_phase,
    }, timings, ljpeg_stats))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_too_small_data() {
        let result = decode_bytes(&[0u8; 8]);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("CR2"), "error should mention CR2: {msg}");
    }

    #[test]
    fn rejects_non_tiff_magic() {
        let mut data = vec![0u8; 16];
        data[0] = 0x42;
        data[1] = 0x42;
        assert!(decode_bytes(&data).is_err());
    }

    #[test]
    fn rejects_missing_cr_marker() {
        let mut data = vec![0u8; 16];
        data[0] = 0x49; data[1] = 0x49; data[2] = 0x2A; data[3] = 0x00;
        data[8] = 0x00; data[9] = 0x00;
        let result = decode_bytes(&data);
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("CR marker"), "error should mention CR marker: {msg}");
    }

    // Zero-alloc WB extraction from raw file bytes
    #[test]
    fn extract_wb_version6() {
        let mut data = vec![0u8; 140]; // 70 u16s × 2 bytes
        // Write version=6 at offset 0
        data[0] = 6; data[1] = 0; // version = 6 LE
        // WB at index 63: offset 63*2 = 126
        let r:  u16 = 2166;
        let g1: u16 = 1024;
        let b:  u16 = 1789;
        data[126] = (r  & 0xFF) as u8; data[127] = (r  >> 8) as u8;
        data[128] = (g1 & 0xFF) as u8; data[129] = (g1 >> 8) as u8;
        data[130] = 0; data[131] = 0; // g2
        data[132] = (b  & 0xFF) as u8; data[133] = (b  >> 8) as u8;
        let (wb_r, wb_b) = extract_wb_from_raw(&data, 0, 70, true).unwrap();
        let er = 2166.0 / 1024.0;
        let eb = 1789.0 / 1024.0;
        assert!((wb_r - er).abs() < 1e-4, "wb_r={wb_r} expected={er}");
        assert!((wb_b - eb).abs() < 1e-4, "wb_b={wb_b} expected={eb}");
    }

    #[test]
    fn extract_wb_version1() {
        let mut data = vec![0u8; 60]; // 30 u16s × 2 bytes
        data[0] = 1; data[1] = 0; // version = 1 LE
        // WB at index 25: offset 25*2 = 50
        let r:  u16 = 1800;
        let g1: u16 = 1024;
        let b:  u16 = 1600;
        data[50] = (r  & 0xFF) as u8; data[51] = (r  >> 8) as u8;
        data[52] = (g1 & 0xFF) as u8; data[53] = (g1 >> 8) as u8;
        data[54] = 0; data[55] = 0; // g2
        data[56] = (b  & 0xFF) as u8; data[57] = (b  >> 8) as u8;
        let (wb_r, wb_b) = extract_wb_from_raw(&data, 0, 30, true).unwrap();
        assert!((wb_r - 1800.0 / 1024.0).abs() < 1e-4);
        assert!((wb_b - 1600.0 / 1024.0).abs() < 1e-4);
    }

    #[test]
    fn extract_wb_returns_none_for_zero_g1() {
        let mut data = vec![0u8; 140];
        data[0] = 6; // version = 6
        // R at 126..128, G1 at 128..130 = 0
        data[126] = 0xD0; data[127] = 0x07; // R = 2000
        // G1 stays 0
        assert!(extract_wb_from_raw(&data, 0, 70, true).is_none());
    }

    #[test]
    fn visit_ifd_empty_returns_zero() {
        // Empty IFD (count=0) should not call visitor and return next offset
        let mut data = vec![0u8; 8];
        data[0] = 0; data[1] = 0; // count = 0
        // next offset at bytes 2..6
        data[2] = 0; data[3] = 0; data[4] = 0; data[5] = 0;
        let mut called = false;
        let next = visit_ifd(&data, 0, true, |_, _, _, _, _| { called = true; });
        assert!(!called);
        assert_eq!(next, 0);
    }

    #[test]
    fn visit_ifd_corruption_guard() {
        // IFD claiming > 512 entries should return 0, no visitor calls
        let mut data = vec![0u8; 4];
        data[0] = 0xFF; data[1] = 0x03; // count = 1023 LE
        let mut called = false;
        let next = visit_ifd(&data, 0, true, |_, _, _, _, _| { called = true; });
        assert!(!called);
        assert_eq!(next, 0);
    }

    #[test]
    fn real_cr2_decodes() {
        let path = std::env::var("CR2_TEST_FILE")
            .unwrap_or_else(|_| r"C:\Foo\raw-converter\tests\_MG_1744.CR2".into());
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(_) => return, // file not present — skip
        };
        let img = decode_bytes(&data).expect("CR2 decode failed");
        assert_eq!(img.width,  5184, "width");
        assert_eq!(img.height, 3456, "height");
        assert!(img.wb_r > 1.0 && img.wb_r < 5.0, "wb_r={}", img.wb_r);
        assert!(img.wb_b > 1.0 && img.wb_b < 5.0, "wb_b={}", img.wb_b);
        assert_eq!(img.raw.len(), img.width * img.height);
        assert!(img.iso.is_some());
        assert!(!img.make.is_empty());
        assert!(!img.model.is_empty());
    }

    #[test]
    fn bench_api_returns_timings() {
        let path = std::env::var("CR2_TEST_FILE")
            .unwrap_or_else(|_| r"C:\Foo\raw-converter\tests\_MG_1744.CR2".into());
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(_) => return,
        };
        let (img, t) = decode_bytes_bench(&data).expect("bench decode failed");
        assert_eq!(img.raw.len(), img.width * img.height);
        assert!(t.total_ms > 0.0, "total_ms should be positive: {}", t.total_ms);
        assert!(t.ljpeg_ms > 0.0, "ljpeg_ms should be positive: {}", t.ljpeg_ms);
        assert!(t.ljpeg_ms <= t.total_ms, "ljpeg_ms={} > total_ms={}", t.ljpeg_ms, t.total_ms);
        assert!(t.raw_buf_bytes > t.crop_buf_bytes,
            "raw_buf_bytes={} should exceed crop_buf_bytes={}", t.raw_buf_bytes, t.crop_buf_bytes);
    }

    #[test]
    fn slice_reassembly_matches_scalar_reference() {
        // Geometries: (n, nw, lw, high). stride = n*nw + lw. Covers single-remainder,
        // even/odd widths, lw==nw, and the classic 5D-era CR2Slices=[2,1728,1888]→here
        // scaled down to keep the test fast while exercising the same index arithmetic.
        let cases = [
            (2usize, 4usize, 6usize, 5usize),
            (3, 8, 8, 7),
            (1, 16, 4, 9),
            (2, 1728, 1888, 12), // real Canon slice widths, few rows
            (4, 5, 3, 6),
        ];
        for &(n, nw, lw, high) in &cases {
            let stride = n * nw + lw;
            let total = stride * high;
            // Deterministic distinct values so any mis-mapped sample is detectable.
            let src: Vec<u16> = (0..total).map(|i| (i % 65535) as u16).collect();
            let bulk = reassemble_slices(&src, stride, high, n, nw, lw);
            let scalar = reassemble_slices_scatter(&src, stride, high, n, nw, lw);
            assert_eq!(bulk, scalar,
                "mismatch for n={n} nw={nw} lw={lw} high={high}");
        }
    }

    /// Real-fixture loader: CR2_FIXTURE_DIR override, default raw-converter tests dir.
    /// Returns None (test skips) when the file is not present on this machine.
    fn fixture(name: &str) -> Option<Vec<u8>> {
        let dir = std::env::var("CR2_FIXTURE_DIR")
            .unwrap_or_else(|_| r"C:\Foo\raw-converter\tests".into());
        std::fs::read(std::path::Path::new(&dir).join(name)).ok()
    }

    #[test]
    fn choose_crop_origin_prefers_valid_sensor_info() {
        // Real ADH-body geometry: active 6000x4000 at (276,48) inside 6288x4056.
        let si = SensorInfo { sensor_width: 6288, sensor_height: 4056, left: 276, top: 48, right: 6275, bottom: 4047 };
        assert_eq!(choose_crop_origin(Some(si), 6288, 4056, 6000, 4000), (276, 48, (0, 0)));
        // Odd origin → real parity carried through as CFA phase, no snapping.
        let si_odd = SensorInfo { sensor_width: 100, sensor_height: 60, left: 5, top: 3, right: 84, bottom: 42 };
        assert_eq!(choose_crop_origin(Some(si_odd), 100, 60, 80, 40), (5, 3, (1, 1)));
    }

    #[test]
    fn choose_crop_origin_falls_back_when_inconsistent() {
        // Active dims disagree with the IFD0 crop → center fallback.
        let si = SensorInfo { sensor_width: 100, sensor_height: 60, left: 4, top: 2, right: 93, bottom: 51 };
        assert_eq!(choose_crop_origin(Some(si), 100, 60, 80, 40), (10, 10, (0, 0)));
        // Sensor grid disagrees with the decoded grid → center fallback.
        let si2 = SensorInfo { sensor_width: 200, sensor_height: 60, left: 4, top: 2, right: 83, bottom: 41 };
        assert_eq!(choose_crop_origin(Some(si2), 100, 60, 80, 40), (10, 10, (0, 0)));
        // Tag absent → center fallback (even-snapped).
        assert_eq!(choose_crop_origin(None, 100, 60, 80, 40), (10, 10, (0, 0)));
        assert_eq!(choose_crop_origin(None, 101, 61, 80, 40), (10, 10, (0, 0)));
    }

    #[test]
    fn sensor_crop_matches_grid_single_slice() {
        // Single-slice body: the decoded grid IS the raster, so the shipped crop
        // must equal grid rows at the SensorInfo origin, row for row.
        let Some(data) = fixture("ADH 1234.CR2") else { return };
        let si = parse_sensor_info(&data).expect("SensorInfo present");
        let (off, len, stride, rows) = ljpeg_strip_geometry(&data).unwrap();
        let img = decode_bytes(&data).unwrap();
        assert_eq!(img.width, si.active_width());
        assert_eq!(img.height, si.active_height());
        let mut grid = vec![0u16; stride * rows];
        crate::ljpeg::decode_tile(&data[off..off + len], &mut grid, 0, stride, stride, rows).unwrap();
        let (ls, ts) = (si.left as usize, si.top as usize);
        for &row in &[0usize, img.height / 2, img.height - 1] {
            let g = (ts + row) * stride + ls;
            assert_eq!(&img.raw[row * img.width..(row + 1) * img.width],
                       &grid[g..g + img.width], "row {row}");
        }
        assert_eq!(img.cfa_phase, (0, 0), "ADH origin is even/even");
    }

    #[test]
    fn variants_byte_identical_on_real_files() {
        // Fused (shipped) == SplitBulk == SplitScatter on one multi-slice and one
        // single-slice body. The full 11-fixture sweep lives in the release
        // example cr2_fused_flip / Task-7 verification.
        for name in ["_MG_1744.CR2", "ADH 1234.CR2"] {
            let Some(data) = fixture(name) else { continue };
            let f = decode_bytes_reassembly(&data, ReassemblyVariant::Fused).expect("fused");
            let b = decode_bytes_reassembly(&data, ReassemblyVariant::SplitBulk).expect("bulk");
            let s = decode_bytes_reassembly(&data, ReassemblyVariant::SplitScatter).expect("scatter");
            assert_eq!(f.raw, b.raw, "fused vs bulk: {name}");
            assert_eq!(f.raw, s.raw, "fused vs scatter: {name}");
            assert_eq!((f.width, f.height, f.black, f.white, f.cfa_phase),
                       (b.width, b.height, b.black, b.white, b.cfa_phase), "{name}");
            assert_eq!(f.wb_r.to_bits(), b.wb_r.to_bits(), "{name}");
            assert_eq!(f.wb_b.to_bits(), b.wb_b.to_bits(), "{name}");
        }
    }

    #[test]
    fn scratch_warm_reuse_across_geometries() {
        // multi → single → multi with ONE scratch: byte-identical to fresh decodes.
        // Exercises the no-truncate warm path (stale tail must be fully overwritten
        // by the next LJPEG decode — full-write invariant).
        let (Some(m), Some(s)) = (fixture("_MG_1744.CR2"), fixture("ADH 1234.CR2")) else { return };
        let mut sc = ScratchBuffers::default();
        for (i, data) in [&m, &s, &m].into_iter().enumerate() {
            let a = decode_with_scratch(data, &mut sc).expect("scratch decode");
            let b = decode_bytes(data).expect("fresh decode");
            assert_eq!(a.raw, b.raw, "call {i}");
            assert_eq!((a.width, a.height, a.black, a.white), (b.width, b.height, b.black, b.white));
        }
    }

    #[test]
    fn fused_reassemble_crop_matches_split_composition() {
        // (n, nw, lw, high, left, top, crop_w, crop_h); stride = n*nw + lw.
        // left/top even (decode_impl snaps), crop within bounds. Includes real 550D
        // geometry, lw==0 (no remainder), crop==full, crop inside one slice, crop
        // spanning all slices.
        let cases = [
            (2usize, 4usize, 6usize, 5usize, 2usize, 0usize, 8usize, 4usize),
            (3, 8, 8, 7, 0, 2, 32, 5),
            (1, 16, 4, 9, 4, 2, 10, 6),
            (2, 1728, 1888, 12, 80, 2, 5184, 8),  // real Canon widths
            (4, 5, 3, 6, 0, 0, 23, 6),             // crop == full frame
            (2, 8, 0, 5, 2, 0, 12, 5),             // lw == 0
            (3, 10, 5, 8, 12, 2, 6, 4),            // crop inside slice 1
        ];
        for &(n, nw, lw, high, left, top, cw, ch) in &cases {
            let stride = n * nw + lw;
            assert!(left + cw <= stride && top + ch <= high, "bad case");
            let src: Vec<u16> = (0..stride * high).map(|i| (i % 65535) as u16).collect();
            // Split composition: full reassemble then crop.
            let raster = reassemble_slices(&src, stride, high, n, nw, lw);
            let mut want = Vec::with_capacity(cw * ch);
            for row in 0..ch {
                let s = (top + row) * stride + left;
                want.extend_from_slice(&raster[s..s + cw]);
            }
            let got = reassemble_slices_crop(&src, stride, high, n, nw, lw, left, top, cw, ch);
            assert_eq!(got, want, "n={n} nw={nw} lw={lw} high={high} l={left} t={top} {cw}x{ch}");
        }
    }

    #[test]
    fn scratch_produces_same_output() {
        let path = std::env::var("CR2_TEST_FILE")
            .unwrap_or_else(|_| r"C:\Foo\raw-converter\tests\_MG_1744.CR2".into());
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(_) => return,
        };
        let img1 = decode_bytes(&data).expect("decode 1");
        let mut sc = ScratchBuffers::default();
        let img2 = decode_with_scratch(&data, &mut sc).expect("decode 2");
        assert_eq!(img1.raw, img2.raw, "scratch must produce identical output");
        assert_eq!(img1.black, img2.black);
        assert_eq!(img1.wb_r.to_bits(), img2.wb_r.to_bits());
    }

    #[test]
    fn entry_first_u32_huge_count_no_wrap() {
        // cnt*ts would wrap 32-bit usize; must fall through to the out-of-line branch
        // (val as usize = OOB) and return None — not read the inline area.
        let data = vec![0xABu8; 32];
        // dtype=3 (SHORT, ts=2), cnt = 0x8000_0003 → 2*cnt wraps to 6 on 32-bit.
        assert_eq!(entry_first_u32(&data, 3, 0x8000_0003, 0xFFFF_FFFF, 4, true), None);
    }

    #[test]
    fn canon_make_check_case_variants() {
        // Same behavior for all case variants; still None while canon_cam_xyz is disabled.
        assert!(canon_color_matrix("CANON", "Canon EOS 550D").is_none());
        assert!(canon_color_matrix("canon inc.", "Canon EOS 550D").is_none());
        assert!(canon_color_matrix("Nikon", "D850").is_none());
        assert!(canon_color_matrix("Cano", "trunc").is_none()); // shorter than needle
    }

    #[test]
    fn canon_color_matrix_disabled_until_neutral_correction_implemented() {
        // Per-model matrices are temporarily disabled: direct adobe_coeff use in
        // CasaWASM's WB-first pipeline produces channel collapse (see canon_cam_xyz comment).
        // All bodies fall through to the generic CANON_CAM_TO_SRGB fallback.
        for model in ["Canon EOS 550D", "Canon EOS Kiss X4", "Canon EOS M5", "Canon EOS 9999X"] {
            assert!(canon_color_matrix("Canon", model).is_none(), "expected None for {model}");
        }
        assert!(canon_color_matrix("OM Digital Solutions", "OM-5").is_none());
    }
}
