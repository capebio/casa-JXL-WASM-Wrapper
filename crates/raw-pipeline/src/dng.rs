//! DNG raw decoder. Walks IFD0 + SubIFDs, finds the full-resolution raw
//! SubIFD, then decodes its lossless-JPEG tiles (compression=7) or raw strips
//! (compression=1). Pulls BlackLevel, WhiteLevel, AsShotNeutral and CFAPattern
//! out of the same IFD chain.

use crate::demosaic;
use crate::denoise::dng_tags::{
    read_doubles, read_rational, read_srational_array, NoiseTagAccumulator, RawNoiseMetadata,
    TAG_BASELINE_NOISE, TAG_BLACK_LEVEL_DELTA_H, TAG_BLACK_LEVEL_DELTA_V,
    TAG_BLACK_LEVEL_REPEAT_DIM, TAG_CFA_PLANE_COLOR, TAG_NOISE_PROFILE,
    TAG_NOISE_REDUCTION_APPLIED,
};
use crate::ljpeg;
use crate::tiff::{visit_ifd, RawImageMeta};
use anyhow::{anyhow, bail, Context, Result};
#[cfg(feature = "parallel")]
use rayon::prelude::*;
use std::collections::HashSet;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cfa {
    Rggb,
    Gbrg,
    Grbg,
    Bggr,
}

pub struct DngImage {
    pub width: usize,
    pub height: usize,
    pub raw: Vec<u16>,
    pub cfa: Cfa,
    pub black: u16,
    pub white: u16,
    pub wb_r: f32,
    pub wb_g: f32,
    pub wb_b: f32,
    /// `true` when WB was derived from AsShotNeutral; `false` = the 1.0/1.0
    /// grey fallback fired. Informational only; does not affect WB math.
    pub wb_from_camera: bool,
    pub iso: Option<u32>,
    pub color_matrix: Option<[[f32; 3]; 3]>,
    pub make: String,
    pub model: String,
    pub orientation: u16,
    /// EXIF DateTimeOriginal (or DateTime), "YYYY:MM:DD HH:MM:SS", empty if absent.
    pub datetime: String,
    /// Decimal GPS (None when the file has no GPS IFD or it is out of range).
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub gps_alt: Option<f64>,
    /// Per-CFA-plane noise metadata (black/white levels, embedded NoiseProfile, etc.).
    pub noise_metadata: RawNoiseMetadata,
}

impl DngImage {
    pub fn meta(&self) -> RawImageMeta {
        RawImageMeta {
            width: self.width,
            height: self.height,
            wb_r: self.wb_r,
            wb_g: self.wb_g,
            wb_b: self.wb_b,
            wb_from_camera: self.wb_from_camera,
            color_matrix: self.color_matrix,
            orientation: self.orientation,
            make: self.make.clone(),
            model: self.model.clone(),
        }
    }
}

const TAG_COLOR_MATRIX_1: u16 = 0xC621;
const TAG_COLOR_MATRIX_2: u16 = 0xC622;
const TAG_FORWARD_MATRIX_1: u16 = 0xC714;
const TAG_FORWARD_MATRIX_2: u16 = 0xC715;

pub(crate) const XYZ_D50_TO_SRGB: [[f32; 3]; 3] = [
    [3.133_856_1, -1.616_866_7, -0.490_614_6],
    [-0.978_768_4, 1.916_141_5, 0.033_454_0],
    [0.071_945_3, -0.228_991_4, 1.405_242_7],
];

pub fn decode(path: &std::path::Path) -> Result<DngImage> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    decode_bytes(&bytes)
}

/// Byte ranges of each LJPEG-compressed tile (compression=7) within `data`.
/// Exposed for A/B benchmarking the LJPEG decoder in isolation; not part of the
/// stable API.
#[doc(hidden)]
pub fn ljpeg_tile_ranges(data: &[u8]) -> Result<Vec<(usize, usize)>> {
    let (_state, raw, _le) = load_dng(data)?;
    if raw.compression != 7 {
        bail!(
            "DNG: not LJPEG-compressed (compression={})",
            raw.compression
        );
    }
    let mut ranges = Vec::with_capacity(raw.tile_offsets.len());
    for (o, c) in raw.tile_offsets.iter().zip(raw.tile_byte_counts.iter()) {
        let off = *o as usize;
        let end = off
            .checked_add(*c as usize)
            .filter(|&e| e <= data.len())
            .ok_or_else(|| anyhow!("tile range OOB"))?;
        ranges.push((off, end));
    }
    Ok(ranges)
}

pub fn decode_bytes(data: &[u8]) -> Result<DngImage> {
    decode_bytes_inner(data, false)
}

/// A/B bench entry: identical to `decode_bytes` but routes LJPEG tiles through the
/// legacy compact-buffer + serial-blit path (`decode_tiles_blit`) instead of the
/// band-parallel direct-write path. Exists only so an example can flip the two on a
/// real file for parity + timing; not part of the stable API.
#[doc(hidden)]
pub fn decode_bytes_blit(data: &[u8]) -> Result<DngImage> {
    decode_bytes_inner(data, true)
}

fn decode_bytes_inner(data: &[u8], use_blit: bool) -> Result<DngImage> {
    let (state, raw, le) = load_dng(data)?;

    let width = raw.width as usize;
    let height = raw.height as usize;
    // Decompression-bomb guard: width/height are file-controlled (IFD tags
    // 0x0100/0x0101). Cap at 200 MP (matches cr2.rs) and use u64 so width*height
    // cannot under-allocate via usize overflow on wasm32 (000-security-10 / 000-errors-12).
    // Only rejects implausible/corrupt files; valid DNGs are unaffected.
    if (width as u64).saturating_mul(height as u64) > 200_000_000 {
        bail!("DNG: implausible dimensions {width}×{height}");
    }
    let cps = raw.samples_per_pixel.max(1) as usize;
    let cfa = match raw.cfa_pattern {
        Some(p) => match p {
            [0, 1, 1, 2] => Cfa::Rggb,
            [1, 2, 0, 1] => Cfa::Gbrg,
            [1, 0, 2, 1] => Cfa::Grbg,
            [2, 1, 1, 0] => Cfa::Bggr,
            _ => bail!("unsupported CFA pattern: {p:?}"),
        },
        None => Cfa::Rggb,
    };

    let mut out = vec![0u16; width * height];

    // Guard: decode_uncompressed assumes 1 sample/pixel (one u16 per mosaic cell).
    // A multi-sample uncompressed DNG (e.g. linear/demosaiced RGB, cps>1) would be
    // silently mis-decoded as Bayer data — wrong stride, garbage output. Bail early
    // with a clear error rather than produce corrupt pixel data. Multi-sample
    // uncompressed decode is not implemented (out of scope).
    if raw.compression == 1 && cps != 1 {
        bail!(
            "DNG: uncompressed multi-sample DNG not supported (SamplesPerPixel={}); \
             only single-sample (Bayer mosaic) is implemented",
            cps
        );
    }
    match raw.compression {
        1 => decode_uncompressed(data, &raw, width, height, le, &mut out)?,
        7 if use_blit => decode_tiles_blit(data, &raw, width, height, cps, &mut out)?,
        7 => decode_tiles(data, &raw, width, height, cps, &mut out)?,
        c => bail!("DNG compression {c} not supported"),
    }

    let wb_r_neutral = state.as_shot_neutral.map(|n| n[0]).unwrap_or(1.0);
    let wb_g_neutral = state.as_shot_neutral.map(|n| n[1]).unwrap_or(1.0);
    let wb_b_neutral = state.as_shot_neutral.map(|n| n[2]).unwrap_or(1.0);
    let wb_r = wb_g_neutral / wb_r_neutral.max(1e-6);
    let wb_g = 1.0;
    let wb_b = wb_g_neutral / wb_b_neutral.max(1e-6);

    let black = raw.black_level.unwrap_or(0);
    let white = raw.white_level.unwrap_or(16383);
    let color_matrix = choose_camera_to_srgb_matrix(
        state.forward_matrix_1,
        state.forward_matrix_2,
        state.color_matrix_1,
        state.color_matrix_2,
    );
    // Color matrix (camera native -> sRGB via XYZ) is passed through to higher
    // LookRenderer for the advanced non-Riemannian / log geodesic / Molchanov
    // perceptual model (lens17). The demosaic stage (incl. optional mhc_matrix
    // fusion) + this + black/white/wb provide the clean linear starting point.

    let noise_metadata = state.noise_tags.build(black as f32, white as f32);

    Ok(DngImage {
        width,
        height,
        raw: out,
        cfa,
        black,
        white,
        wb_r,
        wb_g,
        wb_b,
        wb_from_camera: state.as_shot_neutral.is_some(),
        iso: state.iso,
        color_matrix,
        make: state.make,
        model: state.model,
        orientation: state.orientation.unwrap_or(1),
        datetime: state.exif.datetime,
        gps_lat: state.exif.gps_lat,
        gps_lon: state.exif.gps_lon,
        gps_alt: state.exif.gps_alt,
        noise_metadata,
    })
}

/// Preview-path metadata (no raw). Mirrors the fields `decode_bytes_inner` derives.
pub struct DngMeta {
    pub width: usize,
    pub height: usize,
    pub cfa: Cfa,
    pub black: u16,
    pub white: u16,
    pub wb_r: f32,
    pub wb_b: f32,
    pub color_matrix: Option<[[f32; 3]; 3]>,
    pub iso: Option<u32>,
    pub orientation: u16,
    pub make: String,
    pub model: String,
    /// Per-CFA-plane noise metadata (black/white levels, embedded NoiseProfile, etc.).
    pub noise_metadata: RawNoiseMetadata,
}

/// Build `DngMeta` from a parsed IFD + walk state. The expressions match
/// `decode_bytes_inner` exactly (kept in sync by construction; not shared to avoid
/// perturbing the proven full-decode path).
fn dng_meta(
    state: &WalkState,
    raw: &RawIfd,
    width: usize,
    height: usize,
    cfa: Cfa,
    noise_metadata: RawNoiseMetadata,
) -> DngMeta {
    let wb_g_neutral = state.as_shot_neutral.map(|n| n[1]).unwrap_or(1.0);
    let wb_r_neutral = state.as_shot_neutral.map(|n| n[0]).unwrap_or(1.0);
    let wb_b_neutral = state.as_shot_neutral.map(|n| n[2]).unwrap_or(1.0);
    DngMeta {
        width,
        height,
        cfa,
        black: raw.black_level.unwrap_or(0),
        white: raw.white_level.unwrap_or(16383),
        wb_r: wb_g_neutral / wb_r_neutral.max(1e-6),
        wb_b: wb_g_neutral / wb_b_neutral.max(1e-6),
        color_matrix: choose_camera_to_srgb_matrix(
            state.forward_matrix_1,
            state.forward_matrix_2,
            state.color_matrix_1,
            state.color_matrix_2,
        ),
        iso: state.iso,
        orientation: state.orientation.unwrap_or(1),
        make: state.make.clone(),
        model: state.model.clone(),
        noise_metadata,
    }
}

/// Streaming DNG raw-row source. comp=7 (LJPEG tiles) decodes one row-tile band at a
/// time into a reused buffer; comp=1 (uncompressed) decodes the whole raw once and doles
/// rows. Yields rows byte-identical to `decode_bytes().raw`, top-to-bottom, without the
/// full-res demosaiced RGB. Feeds the generic `stream_preview::build_previews_streaming`.
pub struct DngRowSource<'a> {
    data: &'a [u8],
    raw: RawIfd,
    meta: DngMeta,
    row: usize,
    // comp=7 tile-band streaming
    tiled: bool,
    tw: usize,
    tl: usize,
    coltiles: usize,
    band_buf: Vec<u16>,
    band_first: usize,
    band_rows: usize,
    // comp=1 fallback: whole raw decoded up front
    full: Vec<u16>,
}

impl<'a> DngRowSource<'a> {
    /// Parse a DNG for streaming. `Err` if unsupported (caller falls back to the full
    /// path): compression not in {1,7}, cps != 1, unsupported CFA, or implausible dims.
    pub fn new(data: &'a [u8]) -> Result<Self, String> {
        let (mut state, raw, le) = load_dng(data).map_err(|e| format!("DNG parse: {e}"))?;
        let width = raw.width as usize;
        let height = raw.height as usize;
        if width == 0 || height == 0 {
            return Err("DNG: zero dimension".into());
        }
        if (width as u64).saturating_mul(height as u64) > 200_000_000 {
            return Err(format!("DNG: implausible dimensions {width}×{height}"));
        }
        let cps = raw.samples_per_pixel.max(1) as usize;
        if cps != 1 {
            return Err(format!(
                "DNG: streaming needs single-sample Bayer (cps={cps})"
            ));
        }
        let cfa = match raw.cfa_pattern {
            Some([0, 1, 1, 2]) => Cfa::Rggb,
            Some([1, 2, 0, 1]) => Cfa::Gbrg,
            Some([1, 0, 2, 1]) => Cfa::Grbg,
            Some([2, 1, 1, 0]) => Cfa::Bggr,
            Some(p) => return Err(format!("DNG: unsupported CFA {p:?}")),
            None => Cfa::Rggb,
        };
        let noise_metadata = std::mem::take(&mut state.noise_tags)
            .build(raw.black_level.unwrap_or(0) as f32, raw.white_level.unwrap_or(16383) as f32);
        let meta = dng_meta(&state, &raw, width, height, cfa, noise_metadata);

        match raw.compression {
            7 => {
                let tw = raw.tile_width.ok_or("DNG: missing TileWidth")? as usize;
                let tl = raw.tile_length.ok_or("DNG: missing TileLength")? as usize;
                if tw == 0 || tl == 0 {
                    return Err("DNG: zero TileWidth/TileLength".into());
                }
                let coltiles = width.div_ceil(tw);
                let rowtiles = height.div_ceil(tl);
                let expected = coltiles
                    .checked_mul(rowtiles)
                    .ok_or("DNG: tile grid overflow")?;
                if raw.tile_offsets.len() != expected || raw.tile_byte_counts.len() != expected {
                    return Err("DNG: tile count mismatch".into());
                }
                Ok(Self {
                    data,
                    raw,
                    meta,
                    row: 0,
                    tiled: true,
                    tw,
                    tl,
                    coltiles,
                    band_buf: Vec::new(),
                    band_first: 0,
                    band_rows: 0,
                    full: Vec::new(),
                })
            }
            1 => {
                // Uncompressed: decode the whole raw once (cheap, no entropy) and dole
                // rows. Reuses the crate's endianness/strip/tile-aware unpack. Avoids the
                // full-res RGB (the dominant DNG buffer); keeps the raw (~3.5× peak).
                let mut full = vec![0u16; width * height];
                decode_uncompressed(data, &raw, width, height, le, &mut full)
                    .map_err(|e| format!("DNG uncompressed: {e}"))?;
                Ok(Self {
                    data,
                    raw,
                    meta,
                    row: 0,
                    tiled: false,
                    tw: 0,
                    tl: 0,
                    coltiles: 0,
                    band_buf: Vec::new(),
                    band_first: 0,
                    band_rows: 0,
                    full,
                })
            }
            c => Err(format!("DNG: compression {c} not streamable")),
        }
    }

    pub fn phase(&self) -> (u8, u8) {
        cfa_phase(self.meta.cfa)
    }
    pub fn meta(&self) -> &DngMeta {
        &self.meta
    }
}

impl crate::decompress::RawRowSource for DngRowSource<'_> {
    fn width(&self) -> usize {
        self.meta.width
    }
    fn height(&self) -> usize {
        self.meta.height
    }

    fn next_row_into(&mut self, dst: &mut [u16]) -> Result<bool, String> {
        let (w, h) = (self.meta.width, self.meta.height);
        if self.row >= h {
            return Ok(false);
        }
        let r = self.row;
        if self.tiled {
            if self.band_rows == 0 || r >= self.band_first + self.band_rows {
                let tr = r / self.tl;
                let row_start = tr * self.tl;
                let active_h = ((tr + 1) * self.tl).min(h) - row_start;
                self.band_buf.resize(active_h * w, 0);
                decode_band_into(
                    self.data,
                    &self.raw,
                    w,
                    h,
                    self.tw,
                    self.tl,
                    self.coltiles,
                    tr,
                    &mut self.band_buf,
                )
                .map_err(|e| format!("DNG band {tr}: {e}"))?;
                self.band_first = row_start;
                self.band_rows = active_h;
            }
            let local = r - self.band_first;
            dst[..w].copy_from_slice(&self.band_buf[local * w..local * w + w]);
        } else {
            dst[..w].copy_from_slice(&self.full[r * w..r * w + w]);
        }
        self.row += 1;
        Ok(true)
    }
}

/// Decode one row-tile band `tr` (comp=7 LJPEG tiles) into `band` (len == active_h*width,
/// rows [tr*tl, min((tr+1)*tl, height))). Shared by `decode_tiles` (parallel full-frame
/// blit) and the streaming `DngRowSource`. Byte-identical to the previous inline closure.
fn decode_band_into(
    data: &[u8],
    raw: &RawIfd,
    width: usize,
    height: usize,
    tw: usize,
    tl: usize,
    coltiles: usize,
    tr: usize,
    band: &mut [u16],
) -> Result<()> {
    let row_start = tr * tl;
    let row_end = ((tr + 1) * tl).min(height);
    let active_h = row_end - row_start;
    for tc in 0..coltiles {
        let idx = tr * coltiles + tc;
        let off = raw.tile_offsets[idx] as usize;
        let bc = raw.tile_byte_counts[idx] as usize;
        let end = off
            .checked_add(bc)
            .ok_or_else(|| anyhow!("tile {idx} OOB"))?;
        let src = data
            .get(off..end)
            .ok_or_else(|| anyhow!("tile {idx} OOB"))?;
        let col_start = tc * tw;
        let col_end = ((tc + 1) * tw).min(width);
        let active_w = col_end - col_start;
        ljpeg::decode_tile(src, band, col_start, width, active_w, active_h)
            .with_context(|| format!("tile r={tr} c={tc}"))?;
    }
    Ok(())
}

/// Decode LJPEG tiles (compression=7) directly into the strided output mosaic,
/// parallelised over **row-tile bands**.
///
/// Each band is a disjoint, contiguous run of `out` rows (`par_chunks_mut`), so bands
/// can be decoded concurrently with no aliasing — and tiles *within* a band are decoded
/// serially via the strided `ljpeg::decode_tile` (the same primitive the fused
/// `decode_bytes_demosaiced` path uses), writing straight into their sub-rect of the band.
///
/// This replaces `decode_tiles_blit`'s per-tile scratch `Vec` + single-threaded serial
/// blit (measured ~34% of `decode_bytes` wall time: 165 allocations + a full-image copy
/// that ran *after* all parallel decode finished — pure Amdahl serialization). Output is
/// byte-identical to the blit path (proven by `examples/dng_tiles_direct_flip.rs`).
///
/// Parallelism granularity drops from `coltiles*rowtiles` independent tasks to `rowtiles`
/// bands; for real DNGs `rowtiles` comfortably exceeds the core count, and removing the
/// serial blit + allocations more than compensates (see the flip example's numbers).
fn decode_tiles(
    data: &[u8],
    raw: &RawIfd,
    width: usize,
    height: usize,
    cps: usize,
    out: &mut [u16],
) -> Result<()> {
    let tw = raw.tile_width.ok_or_else(|| anyhow!("missing TileWidth"))? as usize;
    let tl = raw
        .tile_length
        .ok_or_else(|| anyhow!("missing TileLength"))? as usize;
    if tw == 0 || tl == 0 {
        bail!("DNG: zero TileWidth/TileLength");
    }
    let coltiles = width.div_ceil(tw);
    let rowtiles = height.div_ceil(tl);
    let expected = coltiles
        .checked_mul(rowtiles)
        .ok_or_else(|| anyhow!("DNG: tile grid overflow"))?;
    if raw.tile_offsets.len() != expected || raw.tile_byte_counts.len() != expected {
        bail!(
            "tile count mismatch: expected {} got {}/{}",
            expected,
            raw.tile_offsets.len(),
            raw.tile_byte_counts.len()
        );
    }
    let _ = cps; // implied by SOF

    // One row-tile band (tr) decoded into its slice of `out`. `band` covers rows
    // [tr*tl, row_end) at full `width` stride, so a tile at column tc writes its active
    // sub-rect at base = col_start (row 0 of the band), stride = width.
    let decode_band = |tr: usize, band: &mut [u16]| -> Result<()> {
        decode_band_into(data, raw, width, height, tw, tl, coltiles, tr, band)
    };

    // par_chunks_mut(tl*width) yields exactly `rowtiles` disjoint bands (the last shorter
    // when height isn't a multiple of tl); tl*width ≤ height*width ≤ 200 MP (caller guard)
    // so it cannot overflow usize on wasm32.
    let band_stride = tl * width;
    #[cfg(feature = "parallel")]
    {
        out.par_chunks_mut(band_stride)
            .enumerate()
            .try_for_each(|(tr, band)| decode_band(tr, band))?;
    }
    #[cfg(not(feature = "parallel"))]
    {
        for (tr, band) in out.chunks_mut(band_stride).enumerate() {
            decode_band(tr, band)?;
        }
    }
    Ok(())
}

/// Legacy LJPEG tile path: decode each tile into a private compact `Vec<u16>` (so tiles
/// can run as fully independent parallel tasks with no shared `&mut` stride borrow), then
/// serially blit each decoded tile's active rect into `out`. Retained as the A/B baseline
/// for `examples/dng_tiles_direct_flip.rs`; superseded in production by `decode_tiles`.
fn decode_tiles_blit(
    data: &[u8],
    raw: &RawIfd,
    width: usize,
    height: usize,
    cps: usize,
    out: &mut [u16],
) -> Result<()> {
    let tw = raw.tile_width.ok_or_else(|| anyhow!("missing TileWidth"))? as usize;
    let tl = raw
        .tile_length
        .ok_or_else(|| anyhow!("missing TileLength"))? as usize;
    // TileWidth/TileLength are file-supplied; zero would div-by-zero below
    // (000-errors-6). Only triggers on malformed input.
    if tw == 0 || tl == 0 {
        bail!("DNG: zero TileWidth/TileLength");
    }
    let coltiles = width.div_ceil(tw);
    let rowtiles = height.div_ceil(tl);
    // Overflow guard on the tile grid (000-security-12): crafted tw=tl=1 with
    // large dims could overflow usize on wasm32.
    let expected = coltiles
        .checked_mul(rowtiles)
        .ok_or_else(|| anyhow!("DNG: tile grid overflow"))?;
    if raw.tile_offsets.len() != expected || raw.tile_byte_counts.len() != expected {
        bail!(
            "tile count mismatch: expected {} got {}/{}",
            expected,
            raw.tile_offsets.len(),
            raw.tile_byte_counts.len()
        );
    }

    let _ = cps; // implied by SOF

    // X1: full per-tile parallel (enabled by L13). Use probe + decode_tile_compact so each
    // task owns a small disjoint compact buffer (no shared &mut stride borrow). Collect then
    // blit active rects (edge tiles may have active < declared SOF size). Replaces the prior
    // row-of-tiles band + Mutex + inner serial cols.
    struct DecodedTile {
        row_start: usize,
        col_start: usize,
        buf: Vec<u16>,
        buf_w: usize, // declared by this tile's SOF (compact stride unit)
        buf_h: usize, // declared by this tile's SOF
        active_w: usize,
        active_h: usize,
    }

    let decode_one = |idx: usize| -> Result<DecodedTile> {
        let tr = idx / coltiles;
        let tc = idx % coltiles;
        let row_start = tr * tl;
        let row_end = ((tr + 1) * tl).min(height);
        let col_start = tc * tw;
        let col_end = ((tc + 1) * tw).min(width);
        let active_h = row_end - row_start;
        let active_w = col_end - col_start;
        let off = raw.tile_offsets[idx] as usize;
        let bc = raw.tile_byte_counts[idx] as usize;
        // checked_add: off+bc are file-controlled and can wrap usize on wasm32,
        // defeating the OOB guard (000-security-11).
        let end = off
            .checked_add(bc)
            .ok_or_else(|| anyhow!("tile {idx} OOB"))?;
        let src = data
            .get(off..end)
            .ok_or_else(|| anyhow!("tile {idx} OOB"))?;
        let info = ljpeg::probe_tile(src).with_context(|| format!("probe tile {idx}"))?;
        // Pixel width = SOF sample-width × component count. CFA DNGs from e.g. Pixel
        // phones encode the tile with cps=2 (two column-interleaved components, the
        // decoder emits `raw_col = col*cps + comp`), so the reconstructed tile is
        // `sof_w * cps` pixels wide — NOT `sof_w`. The earlier `// cps=1` assumption
        // silently truncated the right half of every cps≥2 tile to zero.
        let bw = info.width as usize * info.components.max(1) as usize;
        let bh = info.height as usize;
        let mut buf = vec![0u16; bw * bh];
        ljpeg::decode_tile_compact(src, &mut buf, bw, bh)
            .with_context(|| format!("compact tile r={tr} c={tc}"))?;
        Ok(DecodedTile {
            row_start,
            col_start,
            buf,
            buf_w: bw,
            buf_h: bh,
            active_w,
            active_h,
        })
    };

    #[cfg(feature = "parallel")]
    let tiles: Vec<DecodedTile> = (0..expected)
        .into_par_iter()
        .map(decode_one)
        .collect::<Result<Vec<_>>>()?;
    #[cfg(not(feature = "parallel"))]
    let tiles: Vec<DecodedTile> = (0..expected).map(decode_one).collect::<Result<Vec<_>>>()?;

    // Serial blit of active rects (disjoint; cheap vs decode work).
    for td in tiles {
        let aw = td.active_w.min(td.buf_w);
        // Clamp active_h by the SOF-declared tile height: a tile whose LJPEG SOF
        // reports fewer rows than active_h would cause an OOB read into td.buf
        // (DNG-002 / ERR-005).
        let ah = td.active_h.min(td.buf_h);
        for r in 0..ah {
            let src_base = r * td.buf_w;
            // SEC-008: (row_start + r) * width + col_start can overflow usize on
            // wasm32 when file-supplied tile grid values are large.
            let dst_base = (td.row_start + r)
                .checked_mul(width)
                .and_then(|v| v.checked_add(td.col_start))
                .ok_or_else(|| anyhow!("tile blit dst overflow"))?;
            let dst = out
                .get_mut(dst_base..dst_base + aw)
                .ok_or_else(|| anyhow!("tile blit OOB dst_base={dst_base} aw={aw}"))?;
            // Clamp the SOURCE read to the actual decoded buffer length (DNG-002b):
            // active_w/active_h are clamped to the *declared* SOF dims (buf_w/buf_h),
            // but if the decoder produced a shorter buffer than declared, src_base+aw
            // could read past td.buf. get() keeps reads inside the decoded buffer.
            let src = td
                .buf
                .get(src_base..src_base + aw)
                .ok_or_else(|| anyhow!("tile blit OOB src_base={src_base} aw={aw}"))?;
            dst.copy_from_slice(src);
        }
    }
    Ok(())
}

/// Fill a contiguous u16 destination row from a contiguous source byte run of the same
/// pixel count, honoring source endianness. On a little-endian target a little-endian
/// source is a single memcpy (no per-element from_le_bytes); every other case (big-endian
/// source, or big-endian host) falls back to an explicit per-element decode so output stays
/// byte-exact. `bytes.len()` must equal `dst.len() * 2` (callers guarantee this).
#[inline]
fn fill_u16_row(dst: &mut [u16], bytes: &[u8], le: bool) {
    #[cfg(target_endian = "little")]
    if le {
        // SAFETY: write dst.len()*2 bytes into dst (u16-aligned, stricter than u8); the
        // byte count matches exactly. Only taken when the source is little-endian too.
        let dstb =
            unsafe { core::slice::from_raw_parts_mut(dst.as_mut_ptr() as *mut u8, dst.len() * 2) };
        dstb.copy_from_slice(bytes);
        return;
    }
    for (o, c) in dst.iter_mut().zip(bytes.chunks_exact(2)) {
        *o = if le {
            u16::from_le_bytes([c[0], c[1]])
        } else {
            u16::from_be_bytes([c[0], c[1]])
        };
    }
}

fn decode_uncompressed(
    data: &[u8],
    raw: &RawIfd,
    width: usize,
    height: usize,
    le: bool,
    out: &mut [u16],
) -> Result<()> {
    let bps = raw.bits_per_sample;
    if bps != 16 {
        bail!("uncompressed DNG: bps {} unsupported", bps);
    }
    if !raw.tile_offsets.is_empty() {
        let tw = raw.tile_width.ok_or_else(|| anyhow!("TileWidth"))? as usize;
        let tl = raw.tile_length.ok_or_else(|| anyhow!("TileLength"))? as usize;
        // Zero tile dims would div-by-zero / underflow below (000-errors-6).
        if tw == 0 || tl == 0 {
            bail!("uncompressed DNG: zero TileWidth/TileLength");
        }
        let coltiles = (width + tw - 1) / tw;
        let rowtiles = (height + tl - 1) / tl;
        for tr in 0..rowtiles {
            for tc in 0..coltiles {
                let idx = tr * coltiles + tc;
                // Length guard before indexing, matching the compressed tile path
                // (decode_tiles): file-supplied dims can yield an idx past the
                // offset/byte-count arrays. Without this, indexing would panic on
                // hostile input (DNG-001).
                if idx >= raw.tile_offsets.len() || idx >= raw.tile_byte_counts.len() {
                    bail!("uncompressed DNG: tile {idx} index out of range");
                }
                let off = raw.tile_offsets[idx] as usize;
                let bc = raw.tile_byte_counts[idx] as usize;
                // checked_add (000-security-11): off+bc can wrap usize on wasm32.
                let end = off
                    .checked_add(bc)
                    .ok_or_else(|| anyhow!("uncompressed DNG: tile {idx} OOB"))?;
                let src = data
                    .get(off..end)
                    .ok_or_else(|| anyhow!("uncompressed DNG: tile {idx} OOB"))?;
                let col_start = tc * tw;
                let col_end = ((tc + 1) * tw).min(width);
                let row_start = tr * tl;
                let row_end = ((tr + 1) * tl).min(height);
                // Per-row contiguous copy: dst run out[r*width+col_start .. col_end] and the
                // source row segment are both dense u16 runs, so one bounds check + one
                // fill_u16_row (memcpy on LE) per row replaces the per-pixel scatter + index
                // recompute. Byte-identical; error path unchanged (bail on truncation).
                let cw = col_end - col_start; // ≤ tw
                let mut sp = 0usize;
                for r in row_start..row_end {
                    let need = cw * 2;
                    if sp + need > src.len() {
                        bail!("uncompressed DNG: tile {idx} truncated");
                    }
                    let base = r * width + col_start;
                    fill_u16_row(&mut out[base..base + cw], &src[sp..sp + need], le);
                    // saturating: for valid tiles cw ≤ tw, so the row stride is tw*2;
                    // guards underflow on hostile tw/width (000-security-27).
                    sp += tw * 2;
                }
            }
        }
        return Ok(());
    }
    if !raw.strip_offsets.is_empty() {
        if raw.strip_offsets.len() != raw.strip_byte_counts.len() {
            bail!("uncompressed DNG: strip count mismatch");
        }
        let rows_per_strip = raw.rows_per_strip.unwrap_or(height as u32).max(1) as usize;
        for (idx, (&off_u32, &bc_u32)) in raw
            .strip_offsets
            .iter()
            .zip(raw.strip_byte_counts.iter())
            .enumerate()
        {
            let off = off_u32 as usize;
            let bc = bc_u32 as usize;
            // checked_add (000-security-11): off+bc can wrap usize on wasm32.
            let end = off
                .checked_add(bc)
                .ok_or_else(|| anyhow!("uncompressed DNG: strip {idx} OOB"))?;
            let src = data
                .get(off..end)
                .ok_or_else(|| anyhow!("uncompressed DNG: strip {idx} OOB"))?;
            // checked_mul/add (000-security-11 style): idx*rows_per_strip and the
            // strip's last row can wrap usize on wasm32 for hostile strip counts,
            // defeating the OOB bound below. Saturate row_start past `height` so the
            // empty range simply skips the strip.
            let row_start = idx
                .checked_mul(rows_per_strip)
                .unwrap_or(usize::MAX)
                .min(height);
            let row_end = row_start
                .checked_add(rows_per_strip)
                .unwrap_or(usize::MAX)
                .min(height);
            // Per-row contiguous copy: a whole strip row out[r*width .. r*width+width] is a
            // dense u16 run, so one OOB-checked dst slice + one bounds check + one
            // fill_u16_row (memcpy on LE) per row replaces the per-pixel scatter, the
            // per-element checked-mul/add and get_mut. Byte-identical; errors unchanged.
            let need = width * 2;
            let mut sp = 0usize;
            for r in row_start..row_end {
                if sp + need > src.len() {
                    bail!("uncompressed DNG: strip {idx} truncated");
                }
                // r*width+width can overflow on hostile width; checked range keeps the
                // destination slice in range (preserves the old per-element get_mut guard).
                let base = r
                    .checked_mul(width)
                    .ok_or_else(|| anyhow!("uncompressed DNG: strip {idx} dst OOB"))?;
                let dst = base
                    .checked_add(width)
                    .and_then(|end| out.get_mut(base..end))
                    .ok_or_else(|| anyhow!("uncompressed DNG: strip {idx} dst OOB"))?;
                fill_u16_row(dst, &src[sp..sp + need], le);
                sp += need;
            }
        }
        return Ok(());
    }
    bail!("uncompressed DNG: missing tile or strip offsets");
}

/// Trim a mosaic so its top-left pixel lands on the RGGB phase.
///
/// Returns `(pixels, width, height)` where `width` is BOTH the row stride and
/// the logical/visible width of `pixels` — the buffer is always tightly packed
/// (`pixels.len() == width * height`), so callers can address it unambiguously.
///
/// Row-only trims (RGGB identity, Gbrg) are zero-copy (`Cow::Borrowed`). When a
/// column must be dropped (Grbg/Bggr) the rows are re-packed into a fresh
/// contiguous buffer (`Cow::Owned`) so there is no column gap — this removes the
/// earlier stride-as-width footgun where a `+1` start offset left the last row
/// one pixel short and sheared an unphased consumer's row addressing.
pub fn align_to_rggb(
    raw: &[u16],
    width: usize,
    height: usize,
    cfa: Cfa,
) -> (std::borrow::Cow<'_, [u16]>, usize, usize) {
    use std::borrow::Cow;
    let stride = width;
    let (row_off, col_off): (usize, usize) = match cfa {
        Cfa::Rggb => (0, 0),
        Cfa::Gbrg => (1, 0),
        Cfa::Grbg => (0, 1),
        Cfa::Bggr => (1, 1),
    };
    if row_off == 0 && col_off == 0 {
        return (Cow::Borrowed(raw), stride, height);
    }
    // Trim columns first (shift start within each row), then trim rows.
    // For Grbg (col_off=1, row_off=0): drop col 0 → width-1, same height.
    // For Bggr (col_off=1, row_off=1): drop col 0 AND row 0.
    // For Gbrg (col_off=0, row_off=1): drop row 0 only.
    let new_w = width.saturating_sub(col_off);
    let new_h = height.saturating_sub(row_off);
    if new_w == 0 || new_h == 0 {
        return (Cow::Borrowed(&raw[..0]), 0, 0);
    }
    if col_off == 0 {
        // No column dropped: rows stay contiguous → zero-copy. width == stride.
        let start = row_off * stride;
        return (
            Cow::Borrowed(&raw[start..start + new_h * stride]),
            stride,
            new_h,
        );
    }
    // col_off >= 1 (Grbg/Bggr): re-pack each row's [col_off .. col_off + new_w]
    // into a tight new_w-stride buffer. The last row ends exactly at
    // (height-1)*stride + col_off + new_w == height*stride == raw.len(), so every
    // read is in bounds.
    let mut out = Vec::with_capacity(new_w * new_h);
    for r in 0..new_h {
        let row_start = (r + row_off) * stride + col_off;
        out.extend_from_slice(&raw[row_start..row_start + new_w]);
    }
    (Cow::Owned(out), new_w, new_h)
}

pub fn cfa_phase(cfa: Cfa) -> (u8, u8) {
    match cfa {
        Cfa::Rggb => (0, 0),
        Cfa::Grbg => (0, 1),
        Cfa::Gbrg => (1, 0),
        Cfa::Bggr => (1, 1),
    }
}

/// Common parse for both decode paths (dedup per plan).
fn load_dng(data: &[u8]) -> Result<(WalkState, RawIfd, bool)> {
    if data.len() < 8 {
        bail!("too small");
    }
    let le = match &data[0..4] {
        [0x49, 0x49, 0x2A, 0x00] => true,
        [0x4D, 0x4D, 0x00, 0x2A] => false,
        m => bail!("not TIFF: {m:?}"),
    };
    let ifd0_off = read_u32(data, 4, le);
    let mut state = WalkState::default();
    walk(data, ifd0_off as usize, le, &mut state);
    // The raw-image walk above does not read EXIF datetime / GPS tags; pull them
    // from IFD0's standard Exif/GPS sub-IFDs (same handling ORF already has).
    state.exif = crate::tiff::parse_exif_gps(data, le, ifd0_off);
    // Derive AsShotNeutral from AsShotWhiteXY (tag 0xC629) when tag 0xC628 is absent.
    // Pixel phone DNGs store only xy chromaticity coordinates.
    // Formula: XYZ_white = [x/y, 1, (1-x-y)/y]; cam_neutral = ColorMatrix × XYZ_white.
    if state.as_shot_neutral.is_none() {
        if let (Some(xy), Some(cm)) = (
            state.as_shot_white_xy,
            state.color_matrix_2.or(state.color_matrix_1),
        ) {
            let x = xy[0];
            let y = xy[1];
            if y > 1e-6 {
                let xyz = [x / y, 1.0f32, (1.0 - x - y) / y];
                let r = cm[0][0] * xyz[0] + cm[0][1] * xyz[1] + cm[0][2] * xyz[2];
                let g = cm[1][0] * xyz[0] + cm[1][1] * xyz[1] + cm[1][2] * xyz[2];
                let b = cm[2][0] * xyz[0] + cm[2][1] * xyz[1] + cm[2][2] * xyz[2];
                if r > 0.0 && g > 0.0 && b > 0.0 {
                    state.as_shot_neutral = Some([r, g, b]);
                }
            }
        }
    }
    let raw = state
        .raw_ifd
        .take()
        .ok_or_else(|| anyhow!("no raw SubIFD found"))?;
    Ok((state, raw, le))
}

#[derive(Default, Debug)]
struct RawIfd {
    width: u32,
    height: u32,
    bits_per_sample: u16,
    samples_per_pixel: u16,
    compression: u32,
    strip_offsets: Vec<u32>,
    strip_byte_counts: Vec<u32>,
    rows_per_strip: Option<u32>,
    tile_offsets: Vec<u32>,
    tile_byte_counts: Vec<u32>,
    tile_width: Option<u32>,
    tile_length: Option<u32>,
    black_level: Option<u16>,
    white_level: Option<u16>,
    cfa_pattern: Option<[u8; 4]>,
}

#[derive(Default, Debug)]
struct WalkState {
    raw_ifd: Option<RawIfd>,
    as_shot_neutral: Option<[f32; 3]>,
    as_shot_white_xy: Option<[f32; 2]>,
    color_matrix_1: Option<[[f32; 3]; 3]>,
    color_matrix_2: Option<[[f32; 3]; 3]>,
    forward_matrix_1: Option<[[f32; 3]; 3]>,
    forward_matrix_2: Option<[[f32; 3]; 3]>,
    iso: Option<u32>,
    make: String,
    model: String,
    orientation: Option<u16>,
    exif: crate::tiff::ExifGps,
    /// Accumulated noise-related DNG tags; converted to `RawNoiseMetadata` after the walk.
    noise_tags: NoiseTagAccumulator,
}

fn raw_ifd_supported_candidate(ifd: &RawIfd, new_subfile_type: u32) -> bool {
    let has_storage = (!ifd.tile_offsets.is_empty() && !ifd.tile_byte_counts.is_empty())
        || (!ifd.strip_offsets.is_empty() && !ifd.strip_byte_counts.is_empty());
    let is_subsampled = (new_subfile_type & 1) != 0;
    // PARSERS-005 / ERR-011: 0x884C (lossy DNG) is not decoded; exclude it from
    // the candidate check so walk() does not select an IFD that will fail later.
    ifd.width > 0
        && ifd.height > 0
        && has_storage
        && !is_subsampled
        && (ifd.compression == 7 || ifd.compression == 1)
}

fn walk(data: &[u8], off: usize, le: bool, state: &mut WalkState) {
    fn walk_inner(
        data: &[u8],
        off: usize,
        le: bool,
        state: &mut WalkState,
        visited: &mut HashSet<usize>,
        depth: usize,
    ) {
        const MAX_IFD_DEPTH: usize = 64;
        if depth >= MAX_IFD_DEPTH || !visited.insert(off) {
            return;
        }
        let mut subs = Vec::new();
        let mut ifd = RawIfd::default();
        let mut new_subfile_type: u32 = 0;
        let mut has_image_dims = false;
        let mut has_tiles = false;

        let next_ifd = visit_ifd(
            data,
            off,
            le,
            |tag, dtype, cnt, val, inline_pos| match tag {
                0x00FE => new_subfile_type = val,
                0x0100 => {
                    ifd.width = first_u32(data, dtype, cnt, val, inline_pos, le).unwrap_or(0);
                    has_image_dims = true;
                }
                0x0101 => {
                    ifd.height = first_u32(data, dtype, cnt, val, inline_pos, le).unwrap_or(0);
                }
                0x0102 => {
                    ifd.bits_per_sample =
                        first_u32(data, dtype, cnt, val, inline_pos, le).unwrap_or(0) as u16;
                }
                0x0103 => {
                    ifd.compression = first_u32(data, dtype, cnt, val, inline_pos, le).unwrap_or(0);
                }
                0x0115 => {
                    ifd.samples_per_pixel =
                        first_u32(data, dtype, cnt, val, inline_pos, le).unwrap_or(1) as u16;
                }
                0x0111 => {
                    ifd.strip_offsets = read_array_u32(data, dtype, cnt, val, inline_pos, le);
                }
                0x0116 => {
                    ifd.rows_per_strip = first_u32(data, dtype, cnt, val, inline_pos, le);
                }
                0x0117 => {
                    ifd.strip_byte_counts = read_array_u32(data, dtype, cnt, val, inline_pos, le);
                }
                0x0142 => {
                    ifd.tile_width = first_u32(data, dtype, cnt, val, inline_pos, le);
                }
                0x0143 => {
                    ifd.tile_length = first_u32(data, dtype, cnt, val, inline_pos, le);
                }
                0x0144 => {
                    ifd.tile_offsets = read_array_u32(data, dtype, cnt, val, inline_pos, le);
                    has_tiles = true;
                }
                0x0145 => {
                    ifd.tile_byte_counts = read_array_u32(data, dtype, cnt, val, inline_pos, le);
                }
                0x010F => state.make = read_ascii(data, dtype, cnt, val, inline_pos),
                0x0110 => state.model = read_ascii(data, dtype, cnt, val, inline_pos),
                0x0112 => {
                    state.orientation =
                        first_u32(data, dtype, cnt, val, inline_pos, le).map(|v| v as u16);
                }
                0x014A => {
                    subs = read_array_u32(data, dtype, cnt, val, inline_pos, le);
                }
                0x828D => {
                    // CFARepeatPatternDim — ignore (we assume 2x2)
                }
                0x828E => {
                    // CFAPattern: we only handle the standard 2x2 mosaic (exactly 4
                    // entries). Any other length (non-2x2 repeat, malformed, or absent
                    // tag) is an INTENTIONAL fallback to the RGGB default applied
                    // downstream — not a silent error.
                    let arr = read_array_u32(data, dtype, cnt, val, inline_pos, le);
                    if arr.len() == 4 {
                        ifd.cfa_pattern =
                            Some([arr[0] as u8, arr[1] as u8, arr[2] as u8, arr[3] as u8]);
                    }
                }
                0xC61A => {
                    // BlackLevel: scalar path for demosaic (existing) + per-plane for noise.
                    ifd.black_level = first_f32(data, dtype, cnt, val, inline_pos, le)
                        .map(|v| v.round().clamp(0.0, 65535.0) as u16);
                    // Per-CFA-plane black levels for noise metadata. Extract up to 4 values.
                    // Supports DOUBLE (12), RATIONAL (5), SHORT (3), LONG (4).
                    {
                        let n = (cnt as usize).min(4);
                        if n > 0 {
                            let ts = type_size(dtype);
                            if ts > 0 {
                                let bytes = ts.saturating_mul(n);
                                let p = if bytes <= 4 { inline_pos } else { val as usize };
                                let mut levels: Vec<f32> = Vec::with_capacity(n);
                                let mut ok = true;
                                'bl: for k in 0..n {
                                    let off = match k.checked_mul(ts).and_then(|kt| p.checked_add(kt)) {
                                        Some(o) => o,
                                        None => { ok = false; break 'bl; }
                                    };
                                    let v: Option<f32> = match dtype {
                                        3 => {
                                            if off.checked_add(2).map_or(true, |e| e > data.len()) { None }
                                            else { Some(read_u16(data, off, le) as f32) }
                                        }
                                        4 => {
                                            if off.checked_add(4).map_or(true, |e| e > data.len()) { None }
                                            else { Some(read_u32(data, off, le) as f32) }
                                        }
                                        5 => {
                                            // RATIONAL
                                            if off.checked_add(8).map_or(true, |e| e > data.len()) { None }
                                            else {
                                                let num = read_u32(data, off, le) as f32;
                                                let den = read_u32(data, off + 4, le) as f32;
                                                if den > 0.0 { Some(num / den) } else { None }
                                            }
                                        }
                                        12 => {
                                            // DOUBLE (8 bytes)
                                            read_doubles(data, off, 1, le)
                                                .and_then(|v| v.first().copied())
                                                .map(|v| v as f32)
                                        }
                                        _ => None,
                                    };
                                    match v {
                                        Some(lv) => levels.push(lv),
                                        None => { ok = false; break 'bl; }
                                    }
                                }
                                if ok && !levels.is_empty() {
                                    state.noise_tags.black_levels = levels;
                                }
                            }
                        }
                    }
                }
                0xC61D => {
                    // WhiteLevel: existing scalar path + noise metadata capture.
                    ifd.white_level = first_f32(data, dtype, cnt, val, inline_pos, le)
                        .map(|v| v.round().clamp(0.0, 65535.0) as u16);
                    if let Some(v) = first_f32(data, dtype, cnt, val, inline_pos, le) {
                        state.noise_tags.white_level = Some(v);
                    }
                }
                0x8827 => {
                    // ISOSpeedRatings — SHORT array; take first value.
                    state.iso = first_u32(data, dtype, cnt, val, inline_pos, le);
                }
                0xC628 => {
                    state.as_shot_neutral = read_as_shot_neutral(data, dtype, cnt, val, le);
                }
                0xC629 => {
                    state.as_shot_white_xy = read_as_shot_white_xy(data, dtype, cnt, val, le);
                }
                TAG_COLOR_MATRIX_1 => {
                    state.color_matrix_1 = read_matrix3x3(data, dtype, cnt, val, le);
                }
                TAG_COLOR_MATRIX_2 => {
                    state.color_matrix_2 = read_matrix3x3(data, dtype, cnt, val, le);
                }
                TAG_FORWARD_MATRIX_1 => {
                    state.forward_matrix_1 = read_matrix3x3(data, dtype, cnt, val, le);
                }
                TAG_FORWARD_MATRIX_2 => {
                    state.forward_matrix_2 = read_matrix3x3(data, dtype, cnt, val, le);
                }
                // ── Additional noise-metadata tags ────────────────────────────
                // (TAG_BLACK_LEVEL=0xC61A and TAG_WHITE_LEVEL=0xC61D are handled
                //  in their existing literal arms above; logic merged there.)
                TAG_CFA_PLANE_COLOR => {
                    // BYTE array: maps CFA plane index → colour (0=R, 1=G, 2=B).
                    if dtype == 1 && cnt > 0 {
                        let p = if (cnt as usize) <= 4 { inline_pos } else { val as usize };
                        let n = (cnt as usize).min(4);
                        if let Some(slice) = p.checked_add(n).and_then(|end| data.get(p..end)) {
                            state.noise_tags.cfa_plane_color = Some(slice.to_vec());
                        }
                    }
                }
                TAG_NOISE_PROFILE => {
                    // DOUBLE array: 2N values for N colour planes.
                    if dtype == 12 && cnt >= 2 {
                        let n = cnt as usize;
                        // Always a pointer (n*8 > 4 for any realistic count).
                        let p = val as usize;
                        if let Some(values) = read_doubles(data, p, n, le) {
                            state.noise_tags.noise_profile = Some(values);
                        }
                    }
                }
                TAG_BASELINE_NOISE => {
                    // RATIONAL (num, den). Accept dtype=5 (unsigned RATIONAL) only.
                    // dtype=10 (SRATIONAL) is skipped: read_rational returns (u32,u32),
                    // so a signed numerator would be miscast to a huge positive value.
                    // BaselineNoise is always non-negative, so unsigned RATIONAL suffices.
                    if dtype == 5 {
                        let p = val as usize;
                        if let Some(rat) = read_rational(data, p, le) {
                            state.noise_tags.baseline_noise = Some(rat);
                        }
                    }
                }
                TAG_NOISE_REDUCTION_APPLIED => {
                    // RATIONAL (num, den) in [0, 1]. Same SRATIONAL guard as above.
                    if dtype == 5 {
                        let p = val as usize;
                        if let Some(rat) = read_rational(data, p, le) {
                            state.noise_tags.noise_reduction_applied = Some(rat);
                        }
                    }
                }
                TAG_BLACK_LEVEL_REPEAT_DIM => {
                    // SHORT[2]: [rows, cols] of the BlackLevel repeat pattern.
                    // dtype=3 (SHORT), each element is 2 bytes; 2 elements = 4 bytes
                    // which fits inline (in the IFD value field).
                    if cnt >= 2 && dtype == 3 {
                        // Two SHORTs = 4 bytes, always fits inline.
                        let p = inline_pos;
                        if p.checked_add(4).map_or(false, |e| e <= data.len()) {
                            let rows = read_u16(data, p, le) as u32;
                            let cols = read_u16(data, p + 2, le) as u32;
                            state.noise_tags.black_repeat_dim = Some([rows, cols]);
                        }
                    }
                }
                TAG_BLACK_LEVEL_DELTA_H => {
                    // SRATIONAL array (dtype=10), one value per column in the repeat pattern.
                    if dtype == 10 && cnt > 0 {
                        let p = val as usize; // always a pointer (cnt*8 > 4)
                        if let Some(deltas) = read_srational_array(data, p, cnt as usize, le) {
                            state.noise_tags.black_delta_h = Some(deltas);
                        }
                    }
                }
                TAG_BLACK_LEVEL_DELTA_V => {
                    // SRATIONAL array (dtype=10), one value per row in the repeat pattern.
                    if dtype == 10 && cnt > 0 {
                        let p = val as usize;
                        if let Some(deltas) = read_srational_array(data, p, cnt as usize, le) {
                            state.noise_tags.black_delta_v = Some(deltas);
                        }
                    }
                }
                _ => {}
            },
        );

        // Determine if this IFD is the full-res raw: needs ImageWidth/Length and
        // tile offsets, and NewSubFileType bit 0 must be 0 (full-res).
        let _ = has_tiles;
        if has_image_dims && raw_ifd_supported_candidate(&ifd, new_subfile_type) {
            let area = (ifd.width as u64) * (ifd.height as u64);
            let replace = state
                .raw_ifd
                .as_ref()
                .map(|prev| area > (prev.width as u64) * (prev.height as u64))
                .unwrap_or(true);
            if replace {
                state.raw_ifd = Some(ifd);
            }
        }

        for s in subs {
            walk_inner(data, s as usize, le, state, visited, depth + 1);
        }
        // DNG-004: follow the next-IFD chain pointer so we also scan IFD1, IFD2, …
        // (SubIFD chains for things like EXIF / maker-note sub-trees are handled
        // separately via the `subs` vector above).
        if next_ifd > 0 {
            walk_inner(data, next_ifd as usize, le, state, visited, depth + 1);
        }
    }
    let mut visited = HashSet::new();
    walk_inner(data, off, le, state, &mut visited, 0);
}

fn first_u32(
    data: &[u8],
    dtype: u16,
    cnt: u32,
    val: u32,
    inline_pos: usize,
    le: bool,
) -> Option<u32> {
    if cnt == 0 {
        return None;
    }
    let ts = type_size(dtype);
    if ts == 0 {
        return None;
    }
    // SEC-003: ts * cnt can overflow usize on wasm32 for large file-supplied cnt.
    let bytes = ts.checked_mul(cnt as usize)?;
    let p = if bytes <= 4 { inline_pos } else { val as usize };
    match dtype {
        1 | 6 => data.get(p).map(|&b| b as u32),
        3 => Some(read_u16(data, p, le) as u32),
        4 => Some(read_u32(data, p, le)),
        _ => None,
    }
}

fn first_f32(
    data: &[u8],
    dtype: u16,
    cnt: u32,
    val: u32,
    inline_pos: usize,
    le: bool,
) -> Option<f32> {
    if cnt == 0 {
        return None;
    }
    let ts = type_size(dtype);
    if ts == 0 {
        return None;
    }
    // SEC-003: ts * cnt can overflow usize on wasm32 for large file-supplied cnt.
    let bytes = ts.checked_mul(cnt as usize)?;
    let p = if bytes <= 4 { inline_pos } else { val as usize };
    match dtype {
        1 | 6 => data.get(p).map(|&b| b as f32),
        3 => Some(read_u16(data, p, le) as f32),
        4 => Some(read_u32(data, p, le) as f32),
        5 => {
            let num = read_u32(data, p, le) as f32;
            let den = read_u32(data, p + 4, le) as f32;
            if den > 0.0 {
                Some(num / den)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn read_array_u32(
    data: &[u8],
    dtype: u16,
    cnt: u32,
    val: u32,
    inline_pos: usize,
    le: bool,
) -> Vec<u32> {
    let ts = type_size(dtype);
    if ts == 0 || cnt == 0 {
        return Vec::new();
    }
    // SEC-003: ts * cnt can overflow usize on wasm32 for large file-supplied cnt.
    let bytes = match ts.checked_mul(cnt as usize) {
        Some(b) => b,
        None => return Vec::new(),
    };
    let p = if bytes <= 4 { inline_pos } else { val as usize };
    // Cap the up-front reservation: cnt is file-controlled (up to u32::MAX) and the
    // loop below already breaks on OOB, so the real element count can never exceed
    // data.len()/ts. Reserving `cnt` directly would let a crafted count force a
    // multi-GB allocation (000-security-12). Output-identical: only the reserve hint
    // changes, the pushed values are unchanged.
    let max_elems = data.len() / ts;
    let mut out = Vec::with_capacity((cnt as usize).min(max_elems));
    for k in 0..cnt as usize {
        // SEC-009/011 class: `p + k*ts` and `off + ts` can wrap on wasm32 (usize=32-bit)
        // for file-controlled p/cnt, defeating the OOB guard. Derive `off` and the bound
        // with checked arithmetic, and read the BYTE/SBYTE arm via the bounds-safe get()
        // (the 3/4 arms already use read_u16/read_u32). Output-identical for valid files
        // (no wrap, all reads in-bounds); only hostile wasm32 input changes panic→break.
        let off = match k.checked_mul(ts).and_then(|kt| p.checked_add(kt)) {
            Some(o) => o,
            None => break,
        };
        if off.checked_add(ts).map_or(true, |e| e > data.len()) {
            break;
        }
        let v = match dtype {
            1 | 6 => match data.get(off) {
                Some(&b) => b as u32,
                None => break,
            },
            3 => read_u16(data, off, le) as u32,
            4 => read_u32(data, off, le),
            _ => break,
        };
        out.push(v);
    }
    out
}

fn read_as_shot_neutral(data: &[u8], dtype: u16, cnt: u32, val: u32, le: bool) -> Option<[f32; 3]> {
    if cnt < 3 {
        return None;
    }
    let p = val as usize;
    if dtype == 5 {
        let mut out = [0f32; 3];
        for k in 0..3 {
            if p + k * 8 + 8 > data.len() {
                return None;
            }
            let num = read_u32(data, p + k * 8, le) as f32;
            let den = read_u32(data, p + k * 8 + 4, le) as f32;
            out[k] = if den > 0.0 { num / den } else { 0.0 };
        }
        Some(out)
    } else if dtype == 11 {
        let mut out = [0f32; 3];
        for k in 0..3 {
            if p + k * 4 + 4 > data.len() {
                return None;
            }
            let b = &data[p + k * 4..p + k * 4 + 4];
            let arr = [b[0], b[1], b[2], b[3]];
            out[k] = if le {
                f32::from_le_bytes(arr)
            } else {
                f32::from_be_bytes(arr)
            };
        }
        Some(out)
    } else {
        None
    }
}

fn read_i32(data: &[u8], off: usize, le: bool) -> i32 {
    // Bounds-safe: file-controlled offsets (via first_u32/first_f32 `val as usize`)
    // can point past the buffer; return 0 instead of panicking. For valid files the
    // offset is always in range, so this is output-identical and only affects
    // malformed input (000-security-9 / 000-errors-5).
    let end = match off.checked_add(4) {
        Some(e) => e,
        None => return 0,
    };
    match data.get(off..end) {
        Some(b) => {
            if le {
                i32::from_le_bytes([b[0], b[1], b[2], b[3]])
            } else {
                i32::from_be_bytes([b[0], b[1], b[2], b[3]])
            }
        }
        None => 0,
    }
}

fn read_as_shot_white_xy(
    data: &[u8],
    dtype: u16,
    cnt: u32,
    val: u32,
    le: bool,
) -> Option<[f32; 2]> {
    if cnt < 2 || dtype != 5 {
        return None;
    }
    let p = val as usize;
    if p + 16 > data.len() {
        return None;
    }
    let mut out = [0f32; 2];
    for k in 0..2 {
        let num = read_u32(data, p + k * 8, le) as f32;
        let den = read_u32(data, p + k * 8 + 4, le) as f32;
        out[k] = if den > 0.0 { num / den } else { 0.0 };
    }
    Some(out)
}

fn read_matrix3x3(data: &[u8], dtype: u16, cnt: u32, val: u32, le: bool) -> Option<[[f32; 3]; 3]> {
    if cnt < 9 {
        return None;
    }
    let p = val as usize;
    let mut out = [[0f32; 3]; 3];
    match dtype {
        5 => {
            for idx in 0..9usize {
                let off = p + idx * 8;
                if off + 8 > data.len() {
                    return None;
                }
                let num = read_u32(data, off, le) as f32;
                let den = read_u32(data, off + 4, le) as f32;
                if den.abs() < 1e-9 {
                    return None;
                }
                out[idx / 3][idx % 3] = num / den;
            }
            Some(out)
        }
        10 => {
            for idx in 0..9usize {
                let off = p + idx * 8;
                if off + 8 > data.len() {
                    return None;
                }
                let num = read_i32(data, off, le) as f32;
                let den = read_i32(data, off + 4, le) as f32;
                if den.abs() < 1e-9 {
                    return None;
                }
                out[idx / 3][idx % 3] = num / den;
            }
            Some(out)
        }
        11 => {
            for idx in 0..9usize {
                let off = p + idx * 4;
                if off + 4 > data.len() {
                    return None;
                }
                let bytes = [data[off], data[off + 1], data[off + 2], data[off + 3]];
                out[idx / 3][idx % 3] = if le {
                    f32::from_le_bytes(bytes)
                } else {
                    f32::from_be_bytes(bytes)
                };
            }
            Some(out)
        }
        _ => None,
    }
}

pub(crate) fn mul3x3(a: [[f32; 3]; 3], b: [[f32; 3]; 3]) -> [[f32; 3]; 3] {
    let mut out = [[0f32; 3]; 3];
    for row in 0..3 {
        for col in 0..3 {
            out[row][col] = a[row][0] * b[0][col] + a[row][1] * b[1][col] + a[row][2] * b[2][col];
        }
    }
    out
}

pub(crate) fn invert3x3(m: [[f32; 3]; 3]) -> Option<[[f32; 3]; 3]> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-9 {
        return None;
    }
    let inv_det = 1.0 / det;
    Some([
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv_det,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * inv_det,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv_det,
        ],
        [
            (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * inv_det,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv_det,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * inv_det,
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv_det,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * inv_det,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv_det,
        ],
    ])
}

fn choose_camera_to_srgb_matrix(
    forward_matrix_1: Option<[[f32; 3]; 3]>,
    forward_matrix_2: Option<[[f32; 3]; 3]>,
    color_matrix_1: Option<[[f32; 3]; 3]>,
    color_matrix_2: Option<[[f32; 3]; 3]>,
) -> Option<[[f32; 3]; 3]> {
    if let Some(m) = forward_matrix_2.or(forward_matrix_1) {
        return Some(mul3x3(XYZ_D50_TO_SRGB, m));
    }
    let color = color_matrix_2.or(color_matrix_1)?;
    let camera_to_xyz = invert3x3(color)?;
    Some(mul3x3(XYZ_D50_TO_SRGB, camera_to_xyz))
}

fn read_ascii(data: &[u8], _dtype: u16, cnt: u32, val: u32, inline_pos: usize) -> String {
    // Both branches use checked math + get(): a crafted IFD entry can place
    // inline_pos/val near EOF (or wrap p + cnt on 32-bit wasm) — return ""
    // instead of panicking. Valid files take identical in-bounds slices.
    let slice = if cnt <= 4 {
        inline_pos
            .checked_add(cnt as usize)
            .and_then(|end| data.get(inline_pos..end))
    } else {
        let p = val as usize;
        p.checked_add(cnt as usize).and_then(|end| data.get(p..end))
    };
    match slice {
        Some(b) => String::from_utf8_lossy(b)
            .trim_end_matches('\0')
            .to_string(),
        None => String::new(),
    }
}

fn type_size(t: u16) -> usize {
    match t {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 => 4,
        5 | 10 | 12 => 8,
        _ => 0,
    }
}

fn read_u16(data: &[u8], off: usize, le: bool) -> u16 {
    // Bounds-safe (see read_i32). Returns 0 on OOB; for valid files the offset is
    // always in range so this is output-identical (000-security-9 / 000-errors-5).
    let end = match off.checked_add(2) {
        Some(e) => e,
        None => return 0,
    };
    match data.get(off..end) {
        Some(b) => {
            if le {
                u16::from_le_bytes([b[0], b[1]])
            } else {
                u16::from_be_bytes([b[0], b[1]])
            }
        }
        None => 0,
    }
}

fn read_u32(data: &[u8], off: usize, le: bool) -> u32 {
    // Bounds-safe (see read_i32). Returns 0 on OOB; for valid files the offset is
    // always in range so this is output-identical (000-security-9 / 000-errors-5).
    let end = match off.checked_add(4) {
        Some(e) => e,
        None => return 0,
    };
    match data.get(off..end) {
        Some(b) => {
            if le {
                u32::from_le_bytes([b[0], b[1], b[2], b[3]])
            } else {
                u32::from_be_bytes([b[0], b[1], b[2], b[3]])
            }
        }
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_ascii_oob_inline_and_pointer_return_empty() {
        let data = [b'A', b'B', b'C'];
        // In-bounds inline read (cnt <= 4) unchanged.
        assert_eq!(read_ascii(&data, 2, 3, 0, 0), "ABC");
        // Inline slice past EOF: inline_pos near end, cnt 4 -> was a panic.
        assert_eq!(read_ascii(&data, 2, 4, 0, 2), "");
        // Inline pos itself past EOF.
        assert_eq!(read_ascii(&data, 2, 2, 0, 7), "");
        // Pointer read past EOF.
        assert_eq!(read_ascii(&data, 2, 100, 1, 0), "");
        // Pointer read with p + cnt wrapping usize on 32-bit targets.
        assert_eq!(read_ascii(&data, 2, u32::MAX, u32::MAX, 0), "");
    }

    fn assert_matrix_close(actual: [[f32; 3]; 3], expected: [[f32; 3]; 3]) {
        for row in 0..3 {
            for col in 0..3 {
                let diff = (actual[row][col] - expected[row][col]).abs();
                assert!(
                    diff < 1e-5,
                    "matrix[{row}][{col}] diff {diff} actual={} expected={}",
                    actual[row][col],
                    expected[row][col]
                );
            }
        }
    }

    #[test]
    fn reads_srational_3x3_matrix() {
        let values = [
            (1, 2),
            (-1, 4),
            (3, 2),
            (0, 1),
            (5, 4),
            (-3, 2),
            (7, 8),
            (2, 1),
            (-9, 8),
        ];
        let mut bytes = Vec::new();
        for (num, den) in values {
            bytes.extend_from_slice(&(num as i32).to_le_bytes());
            bytes.extend_from_slice(&(den as i32).to_le_bytes());
        }

        let matrix = read_matrix3x3(&bytes, 10, 9, 0, true).expect("matrix");
        let expected = [[0.5, -0.25, 1.5], [0.0, 1.25, -1.5], [0.875, 2.0, -1.125]];
        assert_matrix_close(matrix, expected);
    }

    #[test]
    fn prefers_forward_matrix_2_for_camera_to_srgb() {
        let forward_1 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let forward_2 = [[0.9, 0.1, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.1]];

        let matrix = choose_camera_to_srgb_matrix(Some(forward_1), Some(forward_2), None, None)
            .expect("matrix");

        assert_matrix_close(matrix, mul3x3(XYZ_D50_TO_SRGB, forward_2));
    }

    #[test]
    fn falls_back_to_inverted_color_matrix_when_forward_missing() {
        let color_1 = [[2.0, 0.0, 0.0], [0.0, 4.0, 0.0], [0.0, 0.0, 5.0]];

        let matrix = choose_camera_to_srgb_matrix(None, None, Some(color_1), None).expect("matrix");
        let expected = mul3x3(
            XYZ_D50_TO_SRGB,
            [[0.5, 0.0, 0.0], [0.0, 0.25, 0.0], [0.0, 0.0, 0.2]],
        );
        assert_matrix_close(matrix, expected);
    }

    #[test]
    fn decode_uncompressed_tile_respects_big_endian() {
        let raw = RawIfd {
            bits_per_sample: 16,
            tile_offsets: vec![0],
            tile_byte_counts: vec![8],
            tile_width: Some(2),
            tile_length: Some(2),
            ..Default::default()
        };
        let data = [0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04];
        let mut out = vec![0u16; 4];
        decode_uncompressed(&data, &raw, 2, 2, false, &mut out).unwrap();
        assert_eq!(out, vec![1, 2, 3, 4]);
    }

    #[test]
    fn decode_uncompressed_strip_path_supported() {
        let raw = RawIfd {
            bits_per_sample: 16,
            strip_offsets: vec![0, 4],
            strip_byte_counts: vec![4, 4],
            rows_per_strip: Some(1),
            ..Default::default()
        };
        let data = [1, 0, 2, 0, 3, 0, 4, 0];
        let mut out = vec![0u16; 4];
        decode_uncompressed(&data, &raw, 2, 2, true, &mut out).unwrap();
        assert_eq!(out, vec![1, 2, 3, 4]);
    }

    #[test]
    fn cfa_phase_maps_all_patterns() {
        assert_eq!(cfa_phase(Cfa::Rggb), (0, 0));
        assert_eq!(cfa_phase(Cfa::Grbg), (0, 1));
        assert_eq!(cfa_phase(Cfa::Gbrg), (1, 0));
        assert_eq!(cfa_phase(Cfa::Bggr), (1, 1));
    }

    // DNG-005: tests for align_to_rggb with non-RGGB patterns (previously untested).
    #[test]
    fn align_to_rggb_rggb_is_identity() {
        let raw = [1u16, 2, 3, 4, 5, 6, 7, 8];
        let (s, w, h) = align_to_rggb(&raw, 4, 2, Cfa::Rggb);
        assert_eq!(w, 4);
        assert_eq!(h, 2);
        assert_eq!(&*s, &raw[..]);
        assert!(
            matches!(s, std::borrow::Cow::Borrowed(_)),
            "identity must be zero-copy"
        );
    }

    #[test]
    fn align_to_rggb_gbrg_drops_row() {
        // Gbrg: row_off=1, col_off=0 → drop first row, return width=4 height=1.
        let raw = [0u16; 8]; // 2 rows × 4 cols
        let (_, w, h) = align_to_rggb(&raw, 4, 2, Cfa::Gbrg);
        assert_eq!(w, 4);
        assert_eq!(h, 1, "Gbrg should trim one row");
    }

    #[test]
    fn align_to_rggb_grbg_drops_col() {
        // Grbg: row_off=0, col_off=1 → drop col 0, re-pack to tight width=3 height=2.
        let raw = [0u16; 8]; // 2 rows × 4 cols
        let (s, w, h) = align_to_rggb(&raw, 4, 2, Cfa::Grbg);
        assert_eq!(w, 3, "col-trimmed case re-packs to tight logical width");
        assert_eq!(h, 2);
        assert_eq!(s.len(), w * h, "tightly packed");
    }

    #[test]
    fn align_to_rggb_bggr_drops_row_and_col() {
        // Bggr: row_off=1, col_off=1 → drop row 0 and col 0; tight width=3 height=1.
        // Row 1 is [30,40,31,41]; dropping col 0 → [40,31,41].
        let raw = [10u16, 20, 11, 21, 30, 40, 31, 41]; // 2 rows × 4 cols
        let (s, w, h) = align_to_rggb(&raw, 4, 2, Cfa::Bggr);
        assert_eq!(w, 3, "re-packed to tight logical width");
        assert_eq!(h, 1, "Bggr should trim one row");
        assert_eq!(&*s, &[40u16, 31, 41][..], "drops row 0 and col 0, no shear");
    }

    #[test]
    fn raw_candidate_accepts_strips_and_small_width() {
        let raw = RawIfd {
            width: 640,
            height: 480,
            compression: 1,
            strip_offsets: vec![100],
            strip_byte_counts: vec![200],
            ..Default::default()
        };
        assert!(raw_ifd_supported_candidate(&raw, 0));
    }

    /// Targeted flip-flop test (per user request): alternate "newer code" (subtract_black=true,
    /// clean linear for Lens17/photogram/AR) vs "old code" (false) 10 times on the same operation.
    /// Uses real asset if findable from cwd (when running benchmark context), else synthetic
    /// timing of the black sub kernel itself (the source of the raw decode creep).
    #[test]
    fn flip_flop_raw_decode_black_sub_10x() {
        println!("\n=== Targeted flip-flop: newer (clean linear) vs old (preserve bias) 10 alternations ===");

        // Try to load a real benchmark asset for full path (works when cwd has the files, e.g. from mjs run)
        let candidates = [
            "PXL_20260501_093507165.RAW-02.ORIGINAL.dng",
            "PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
            "../PXL_20260501_093507165.RAW-02.ORIGINAL.dng",
        ];
        let mut used_real = false;
        for path in &candidates {
            if let Ok(data) = std::fs::read(path) {
                println!("Using real asset: {} ({} bytes)", path, data.len());
                for i in 0..10 {
                    let subtract = i % 2 == 0; // alternate: even = newer (true), odd = old (false)
                    let t0 = std::time::Instant::now();
                    let _res = decode_bytes_demosaiced_impl(&data, subtract);
                    let ms = t0.elapsed().as_secs_f64() * 1000.0;
                    println!("flip {}: {:.2} ms (subtract_black={})", i, ms, subtract);
                }
                used_real = true;
                break;
            }
        }

        if !used_real {
            println!("No real asset found in cwd; falling back to synthetic black-sub kernel timing (isolates the new scalar loop cost).");
            let black = 64u16;
            let mut base: Vec<u16> = (0..(1920 * 1440))
                .map(|i| (i % 1000 + 100) as u16)
                .collect();
            for i in 0..10 {
                let subtract = i % 2 == 0;
                let mut buf = base.clone();
                let t0 = std::time::Instant::now();
                if subtract {
                    demosaic::subtract_black_in_place(&mut buf, black);
                }
                let ms = t0.elapsed().as_secs_f64() * 1000.0;
                println!(
                    "synthetic flip {}: {:.4} ms (subtract_black={})",
                    i, ms, subtract
                );
            }
        }
        println!("=== End flip-flop ===\n");
    }
}

/// X2 deliverable: post-demosaic RGB16 + metadata, without a full mosaic buffer resident
/// at the same time as the RGB (strip fusion with 2-row halo for demosaic dependencies).
/// The bayer mosaic is produced band-by-band (tile-row) and dropped after its demosaic
/// contribution is written. Peak mem during fused path ~ full RGB + 1 tile-row band + 2 halo rows.
///
/// For the demosaiced path (decode_bytes_demosaiced), .rgb is black-subtracted (clean
/// linear) and .black==0 so that downstream tone (pipeline::process) receives unbiased
/// input. The bayer DngImage path preserves sensor values + original .black metadata.
#[derive(Debug)]
pub struct DngDemosaiced {
    pub width: usize,
    pub height: usize,
    pub rgb: Vec<u16>, // post-align, post-demosaic (mhc), interleaved RGB16; black-subbed in demosaiced path
    pub black: u16,
    pub white: u16,
    pub wb_r: f32,
    pub wb_g: f32,
    pub wb_b: f32,
    pub orientation: u16,
    pub make: String,
    pub model: String,
    pub color_matrix: Option<[[f32; 3]; 3]>,
    pub iso: Option<u32>,
    pub decode_ms: f64,
    pub demosaic_ms: f64,
    /// Per-CFA-plane noise metadata (black/white levels, embedded NoiseProfile, etc.).
    pub noise_metadata: RawNoiseMetadata,
}

/// Fused decode (ljpeg tiles) + demosaic (mhc) for DNG. RGGB fast path uses strip fusion
/// (band decode + halo carry + demosaic_rggb_mhc_band). Other CFA fall back to full mosaic
/// + demosaic (rare; still correct, pay old peak). Callers (wasm process_dng_raw) use this
/// to avoid simultaneous 32 MB mosaic + 120 MB rgb.
pub fn decode_bytes_demosaiced(data: &[u8]) -> Result<DngDemosaiced> {
    decode_bytes_demosaiced_impl(data, true)
}

/// Fused decode + MHC demosaic while preserving the sensor black pedestal.
///
/// This is byte-equivalent to `decode_bytes(data)` followed by
/// `demosaic_bayer_mhc(..., cfa_phase(img.cfa))`, but avoids keeping the full
/// Bayer mosaic live alongside the full RGB16 buffer for tiled RGGB DNGs.
#[doc(hidden)]
pub fn decode_bytes_demosaiced_preserve_black(data: &[u8]) -> Result<DngDemosaiced> {
    decode_bytes_demosaiced_impl(data, false)
}

/// Internal impl with switch for "newer code" (subtract_black=true, clean linear for Lens17/photogram/AR)
/// vs "old code" (false, preserve bias like pre-clean-linear change). Used for targeted flip-flop tests.
pub(crate) fn decode_bytes_demosaiced_impl(
    data: &[u8],
    subtract_black: bool,
) -> Result<DngDemosaiced> {
    let (state, raw, _le) = load_dng(data)?;

    let width = raw.width as usize;
    let height = raw.height as usize;
    // Decompression-bomb guard (see decode_bytes): cap at 200 MP via u64 so
    // width*height*3 cannot under-allocate via usize overflow on wasm32
    // (000-security-10 / 000-errors-12). Only rejects implausible/corrupt files.
    if (width as u64).saturating_mul(height as u64) > 200_000_000 {
        bail!("DNG: implausible dimensions {width}×{height}");
    }
    let _cps = raw.samples_per_pixel.max(1) as usize;
    let cfa = match raw.cfa_pattern {
        Some(p) => match p {
            [0, 1, 1, 2] => Cfa::Rggb,
            [1, 2, 0, 1] => Cfa::Gbrg,
            [1, 0, 2, 1] => Cfa::Grbg,
            [2, 1, 1, 0] => Cfa::Bggr,
            _ => bail!("unsupported CFA pattern: {p:?}"),
        },
        None => Cfa::Rggb,
    };

    // WB / matrix / black/white / iso / names (same as decode_bytes)
    let wb_r_neutral = state.as_shot_neutral.map(|n| n[0]).unwrap_or(1.0);
    let wb_g_neutral = state.as_shot_neutral.map(|n| n[1]).unwrap_or(1.0);
    let wb_b_neutral = state.as_shot_neutral.map(|n| n[2]).unwrap_or(1.0);
    let wb_r = wb_g_neutral / wb_r_neutral.max(1e-6);
    let wb_g = 1.0;
    let wb_b = wb_g_neutral / wb_b_neutral.max(1e-6);
    let black = raw.black_level.unwrap_or(0);
    let white = raw.white_level.unwrap_or(16383);
    let color_matrix = choose_camera_to_srgb_matrix(
        state.forward_matrix_1,
        state.forward_matrix_2,
        state.color_matrix_1,
        state.color_matrix_2,
    );
    // Color matrix (camera native -> sRGB via XYZ) is passed through to higher
    // LookRenderer for the advanced non-Riemannian / log geodesic / Molchanov
    // perceptual model (lens17). The demosaic stage (incl. optional mhc_matrix
    // fusion) + this + black/white/wb provide the clean linear starting point.
    let orientation = state.orientation.unwrap_or(1);
    let iso = state.iso;
    let make = state.make.clone();
    let model = state.model.clone();
    // Build noise metadata from the walk-state accumulator; must happen before the
    // fallback branches that move `state` fields but after black/white are known.
    let noise_metadata = state.noise_tags.build(black as f32, white as f32);

    if cfa != Cfa::Rggb {
        // Fallback: full mosaic path (still correct; only RGGB gets the X2 mem cut).
        let t0 = Instant::now();
        let mut img = decode_bytes(data)?;
        if subtract_black {
            demosaic::subtract_black_in_place(&mut img.raw, img.black);
        }
        let decode_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let t1 = Instant::now();
        let rgb = demosaic::demosaic_bayer_mhc(&img.raw, img.width, img.height, cfa_phase(img.cfa))
            .map_err(|e| anyhow!("demosaic: {}", e))?;
        let demosaic_ms = t1.elapsed().as_secs_f64() * 1000.0;
        return Ok(DngDemosaiced {
            width: img.width,
            height: img.height,
            rgb,
            black: if subtract_black { 0 } else { img.black },
            white: img.white,
            wb_r: img.wb_r,
            wb_g: img.wb_g,
            wb_b: img.wb_b,
            orientation: img.orientation,
            make: img.make,
            model: img.model,
            color_matrix: img.color_matrix,
            iso: img.iso,
            decode_ms,
            demosaic_ms,
            noise_metadata,
        });
    }

    // RGGB fused strip path (X2). Never materializes full mosaic alongside full rgb.
    // PARSERS-014: strip-based DNGs have no TileWidth/TileLength — fall back to the
    // full mosaic path rather than erroring on a valid but strip-organised RGGB DNG.
    let (tile_width, tile_length) = match (raw.tile_width, raw.tile_length) {
        (Some(tw), Some(tl)) if tw > 0 && tl > 0 => (tw as usize, tl as usize),
        _ => {
            // No tile dims → fall back to full mosaic decode (correct; cheaper path
            // only available when tile dims are present).
            let t0 = Instant::now();
            let mut img = decode_bytes(data)?;
            if subtract_black {
                demosaic::subtract_black_in_place(&mut img.raw, img.black);
            }
            let decode_ms = t0.elapsed().as_secs_f64() * 1000.0;
            let t1 = Instant::now();
            let rgb =
                demosaic::demosaic_bayer_mhc(&img.raw, img.width, img.height, cfa_phase(img.cfa))
                    .map_err(|e| anyhow!("demosaic: {}", e))?;
            let demosaic_ms = t1.elapsed().as_secs_f64() * 1000.0;
            return Ok(DngDemosaiced {
                width: img.width,
                height: img.height,
                rgb,
                black: if subtract_black { 0 } else { img.black },
                white: img.white,
                wb_r: img.wb_r,
                wb_g: img.wb_g,
                wb_b: img.wb_b,
                orientation: img.orientation,
                make: img.make,
                model: img.model,
                color_matrix: img.color_matrix,
                iso: img.iso,
                decode_ms,
                demosaic_ms,
                noise_metadata,
            });
        }
    };
    let tw = tile_width;
    let tl = tile_length;

    let mut rgb = vec![0u16; width * height * 3];
    let aw = width;
    let ah = height;
    let coltiles = width.div_ceil(tw);
    let rowtiles = height.div_ceil(tl);
    // Overflow guard on the tile grid (000-security-12).
    let expected = coltiles
        .checked_mul(rowtiles)
        .ok_or_else(|| anyhow!("DNG: tile grid overflow"))?;
    if raw.tile_offsets.len() != expected || raw.tile_byte_counts.len() != expected {
        bail!(
            "tile count mismatch: expected {} got {}/{}",
            expected,
            raw.tile_offsets.len(),
            raw.tile_byte_counts.len()
        );
    }

    let halo = 2usize;
    let mut halo_rows: Vec<u16> = vec![0u16; width * halo];
    let mut band = vec![0u16; width * tl.max(1)];
    let mut ctx = vec![0u16; width * (halo + tl.max(1) + halo)];
    // Hoisted carried-halo context (000-performance-10). c_h = 3*halo is constant
    // across tile rows; the tr>0 branch fully overwrites all 3*halo rows before use,
    // so reusing one allocation is output-identical to the prior per-iteration vec.
    let mut c_ctx: Vec<u16> = vec![0u16; width * (halo + halo + halo)];
    let mut rgb_write_row: usize = 0usize;

    let mut decode_ms = 0.0f64;
    let mut demosaic_ms = 0.0f64;

    for tr in 0..rowtiles {
        let row_start = tr * tl;
        let row_end = ((tr + 1) * tl).min(height);
        let row_h = row_end - row_start;

        let tdec = Instant::now();
        band.resize(width * row_h, 0);
        for tc in 0..coltiles {
            let idx = tr * coltiles + tc;
            let off = raw.tile_offsets[idx] as usize;
            let bc = raw.tile_byte_counts[idx] as usize;
            // checked_add (000-security-11): off+bc can wrap usize on wasm32.
            let end = off
                .checked_add(bc)
                .ok_or_else(|| anyhow!("tile {idx} OOB"))?;
            let src = data
                .get(off..end)
                .ok_or_else(|| anyhow!("tile {idx} OOB"))?;
            let col_start = tc * tw;
            let col_end = ((tc + 1) * tw).min(width);
            let col_w = col_end - col_start;
            ljpeg::decode_tile(src, &mut band, col_start, width, col_w, row_h)
                .with_context(|| format!("tile r={tr} c={tc}"))?;
        }
        decode_ms += tdec.elapsed().as_secs_f64() * 1000.0;

        // Subtract black on the raw mosaic band *before* demosaic (standard raw
        // processing order) and before halo ctx assembly. This delivers clean
        // linear rgb in DngDemosaiced (facilitates lens17 color engine, photogram,
        // LLM raw features) while keeping the main decode_bytes bayer path with
        // bias+metadata for other consumers.
        if subtract_black {
            demosaic::subtract_black_in_place(&mut band, black);
        }

        // ctx = [top halo | band | bottom (replicate for this pass)]
        let ctx_h = halo + row_h + halo;
        ctx.resize(width * ctx_h, 0);
        if tr == 0 {
            if row_h > 0 {
                let first = &band[0..width];
                for hi in 0..halo {
                    ctx[hi * width..(hi + 1) * width].copy_from_slice(first);
                }
            }
        } else {
            ctx[0..halo * width].copy_from_slice(&halo_rows);
        }
        let band_off = halo * width;
        ctx[band_off..band_off + row_h * width].copy_from_slice(&band);
        if row_h > 0 {
            let last_start = (row_h - 1) * width;
            let last = &band[last_start..last_start + width];
            for hi in 0..halo {
                let boff = (halo + row_h + hi) * width;
                ctx[boff..boff + width].copy_from_slice(last);
            }
        }

        let tdem = Instant::now();
        let is_last = tr + 1 == rowtiles;

        if tr > 0 && halo > 0 {
            // Demosaic the carried prev bottom halo rows now that south data (current band) exists.
            let carried_g0 = row_start - halo;
            // Dedicated temp ctx for carried demosaic to supply north halo margin (replicate top of carried data from halo_rows).
            // The main ctx build for tr>0 places the carried data at ctx[0:] without a north margin, causing OOB read in demosaic_rggb_mhc_band (which expects halo rows of context above the band being demosaiced).
            let c_halo = halo;
            let c_h = c_halo + c_halo + c_halo;
            // c_ctx reused from the hoisted buffer; fully overwritten below
            // (000-performance-10).
            if c_halo > 0 {
                let top = &halo_rows[0..width];
                for hi in 0..c_halo {
                    c_ctx[hi * width..(hi + 1) * width].copy_from_slice(top);
                }
            }
            let mid_off = c_halo * width;
            c_ctx[mid_off..mid_off + c_halo * width].copy_from_slice(&halo_rows);
            let south_top = &ctx[band_off..band_off + c_halo * width];
            let south_off = (c_halo + c_halo) * width;
            c_ctx[south_off..south_off + c_halo * width].copy_from_slice(south_top);
            demosaic::demosaic_rggb_mhc_band(
                &c_ctx,
                width,
                c_h,
                c_halo,
                carried_g0,
                0,
                c_halo,
                &mut rgb[(rgb_write_row * width * 3)..],
            )
            .map_err(|e| anyhow!("demosaic carried: {}", e))?;
            rgb_write_row += c_halo;
        }

        let safe = if is_last {
            row_h
        } else {
            row_h.saturating_sub(halo)
        };
        if safe > 0 {
            demosaic::demosaic_rggb_mhc_band(
                &ctx,
                width,
                ctx_h,
                halo,
                row_start,
                0,
                safe,
                &mut rgb[(rgb_write_row * width * 3)..],
            )
            .map_err(|e| anyhow!("demosaic band: {}", e))?;
            rgb_write_row += safe;
        }
        demosaic_ms += tdem.elapsed().as_secs_f64() * 1000.0;

        if !is_last && row_h >= halo {
            let src = (row_h - halo) * width;
            halo_rows.copy_from_slice(&band[src..src + halo * width]);
        }
    }

    if rgb_write_row != ah {
        // Incomplete demosaic: fewer rows were written than the expected output
        // height. Previously this only eprintln!'d (invisible under wasm) and
        // returned a zero-padded image. Since this fused path has no production
        // caller (only decode_bytes_demosaiced, whose only callers are tests),
        // surface the truncation as an error instead of silently degrading
        // (DNG-003 / ERR-004).
        bail!(
            "raw-pipeline: DNG demosaic incomplete: wrote {} rgb rows but expected {} (width={}, gap={})",
            rgb_write_row, ah, aw, ah - rgb_write_row
        );
    }

    Ok(DngDemosaiced {
        width: aw,
        height: ah,
        rgb,
        black: if subtract_black { 0 } else { black },
        white,
        wb_r,
        wb_g,
        wb_b,
        orientation,
        make,
        model,
        color_matrix,
        iso,
        decode_ms,
        demosaic_ms,
        noise_metadata,
    })
}
