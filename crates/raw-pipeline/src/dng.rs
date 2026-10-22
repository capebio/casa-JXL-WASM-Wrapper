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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

/// Global counter of container decodes (`decode_bytes` / `decode_bytes_inner`).
///
/// A DNG "container decode" is the expensive TIFF-walk + LJPEG/uncompressed
/// un-decompress that produces the raw Bayer mosaic. The deferred-finish
/// contract (P3-T8, finding 34) is that a preview→final two-phase flow decodes
/// the container **exactly once** and reuses the retained mosaic for the final.
/// This counter lets tests assert that invariant directly (`decode_count()`
/// stays flat across a finish). Test-observability only — no effect on decode.
static DECODE_COUNT: AtomicU64 = AtomicU64::new(0);

/// Number of DNG container decodes performed since process start (or since the
/// last `reset_decode_count`). See [`DECODE_COUNT`].
pub fn decode_count() -> u64 {
    DECODE_COUNT.load(Ordering::Relaxed)
}

/// Reset the container-decode counter to 0. Tests call this to fence a scenario.
pub fn reset_decode_count() {
    DECODE_COUNT.store(0, Ordering::Relaxed);
}

/// DNG 1.6 ProfileGainTableMap (tag 0xCD2D): a spatial grid of tone TABLES —
/// at each of `points_v × points_h` grid positions sits a `num_table_points`
/// gain table indexed by a weighted input level. Per the dng_sdk reference
/// (RefBaselineProfileGainTableMap): for each pixel of the ACTIVE image in
/// normalized coordinates, `weight = w·[r, g, b, min(rgb), max(rgb)]` clamped
/// to [0,1], and the gain — trilinear across (row, col, weight·num_table_points)
/// — multiplies all three channels of the linear RGB, before the tone curve.
/// This is Apple ProRAW's local tone map. Version-1 layout only (f32 gains,
/// gamma 1); ProfileGainTableMap2's extra types are not parsed.
#[derive(Debug, Clone, PartialEq)]
pub struct GainTableMap {
    pub points_v: u32,
    pub points_h: u32,
    /// Normalized-coordinate spacing/origin of the grid over the active image.
    pub spacing_v: f64,
    pub spacing_h: f64,
    pub origin_v: f64,
    pub origin_h: f64,
    pub num_table_points: u32,
    pub map_input_weights: [f32; 5],
    /// `points_v * points_h * num_table_points` gains, row-major, table-minor.
    pub gains: Vec<f32>,
}

impl GainTableMap {
    /// The gain at image-normalized position (`u` across, `v` down, pixel
    /// centres in [0,1]) for a pixel whose linear RGB, already scaled to the
    /// map's input domain (v / WhiteLevel × 2^BaselineExposure), is `rgb`.
    /// Trilinear over (row, col, weight); one gain multiplies R, G and B.
    pub fn gain(&self, u: f64, v: f64, rgb: [f32; 3]) -> f32 {
        let (pv, ph) = (self.points_v as usize, self.points_h as usize);
        let nt = self.num_table_points as usize;
        let y_map = ((v - self.origin_v) / self.spacing_v).clamp(0.0, (pv - 1) as f64);
        let x_map = ((u - self.origin_h) / self.spacing_h).clamp(0.0, (ph - 1) as f64);
        let (y0, yf) = (y_map as usize, y_map.fract() as f32);
        let (x0, xf) = (x_map as usize, x_map.fract() as f32);
        let (y1, x1) = ((y0 + 1).min(pv - 1), (x0 + 1).min(ph - 1));
        let [w0, w1, w2, w3, w4] = self.map_input_weights;
        let [r, g, b] = rgb;
        let (mn, mx) = (r.min(g).min(b), r.max(g).max(b));
        let weight = (w0 * r + w1 * g + w2 * b + w3 * mn + w4 * mx).clamp(0.0, 1.0);
        // Reference quirk kept: scaled by tableSize, index min'd to limit.
        let ws = weight * nt as f32;
        let t0 = (ws as usize).min(nt - 1);
        let t1 = (t0 + 1).min(nt - 1);
        let tf = ws - t0 as f32;
        let lerp = |a: f32, b: f32, f: f32| a + (b - a) * f;
        let e = |r: usize, c: usize| {
            let o = (r * ph + c) * nt;
            lerp(self.gains[o + t0], self.gains[o + t1], tf)
        };
        lerp(lerp(e(y0, x0), e(y0, x1), xf), lerp(e(y1, x0), e(y1, x1), xf), yf)
    }
}

/// Parse a v1 ProfileGainTableMap blob (values in the FILE's byte order).
fn parse_gain_table_map(d: &[u8], le: bool) -> Option<GainTableMap> {
    if d.len() < 64 {
        return None;
    }
    let u32_at = |o: usize| read_u32(d, o, le);
    let f64_at = |o: usize| {
        let (hi, lo) = if le { (u32_at(o + 4), u32_at(o)) } else { (u32_at(o), u32_at(o + 4)) };
        f64::from_bits(((hi as u64) << 32) | lo as u64)
    };
    let points_v = u32_at(0);
    let points_h = u32_at(4);
    let num_table_points = u32_at(40);
    let n = (points_v as usize)
        .checked_mul(points_h as usize)?
        .checked_mul(num_table_points as usize)?;
    if points_v == 0 || points_h == 0 || num_table_points == 0 || d.len() != 64 + n * 4 {
        return None; // not the v1 f32 layout (or a hostile size)
    }
    let mut weights = [0f32; 5];
    for (i, w) in weights.iter_mut().enumerate() {
        *w = f32::from_bits(u32_at(44 + 4 * i));
    }
    Some(GainTableMap {
        points_v,
        points_h,
        spacing_v: f64_at(8),
        spacing_h: f64_at(16),
        origin_v: f64_at(24),
        origin_h: f64_at(32),
        num_table_points,
        map_input_weights: weights,
        gains: (0..n).map(|i| f32::from_bits(u32_at(64 + 4 * i))).collect(),
    })
}

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
    /// `samples_per_pixel == 1`: one `u16` per photosite (Bayer mosaic).
    /// `samples_per_pixel == 3`: interleaved RGB (`raw[(y*width + x)*3 + c]`) —
    /// a Linear DNG (PhotometricInterpretation 34892), e.g. Apple ProRAW. The
    /// values are the STORED codes; any LinearizationTable is NOT applied.
    pub raw: Vec<u16>,
    /// Interleaved sample count per pixel (1 = Bayer mosaic, 3 = linear RGB).
    pub samples_per_pixel: usize,
    /// DNG 1.7 JXLDistance (tag 0xCD49) from the raw IFD: `Some(0.0)` =
    /// lossless JPEG XL, `Some(>0)` = lossy, `None` = tag absent (non-JXL
    /// files, or a writer that omitted it — most real files omit it).
    pub jxl_distance: Option<f32>,
    /// The JXL CODESTREAM's own word on lossiness: `Some(true)` = XYB-encoded
    /// (lossy), `Some(false)` = modular/`uses_original_profile` (the lossless
    /// mode), `None` = not JPEG XL-compressed. An archiver that refuses lossy
    /// sources should trust this over [`Self::jxl_distance`], which most
    /// writers omit.
    pub jxl_lossy: Option<bool>,
    /// The raw IFD is lossy JPEG (compression 34892): 8-bit baseline JPEG tiles,
    /// decoded through [`set_lossy_jpeg_decoder`]'s hook and mapped to linear
    /// 16-bit through OpcodeList2's MapPolynomial. An archiver refuses this like
    /// lossy JPEG XL; a viewer shows it.
    pub lossy_jpeg: bool,
    /// Meaningless (left at the Rggb default) when `samples_per_pixel == 3`.
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
    /// DNG BaselineExposure (EV) — suggested exposure shift, applied as the render's
    /// exposure baseline. 0.0 when the tag is absent.
    pub baseline_exposure: f32,
    pub color_matrix: Option<[[f32; 3]; 3]>,
    /// ForwardMatrix2/1 verbatim when the file carries one. Semantics matter to
    /// a renderer: `color_matrix` built FROM a ForwardMatrix expects
    /// WHITE-BALANCED camera data (FM maps balanced camera → XYZ D50), while
    /// the ColorMatrix⁻¹ fallback expects UNBALANCED data (white balance lives
    /// inside ColorMatrix). `Some` here tells the consumer which contract
    /// `color_matrix` follows.
    pub forward_matrix: Option<[[f32; 3]; 3]>,
    /// DNG ProfileToneCurve (0xC6FC): interleaved (x, y) control points in
    /// [0,1], empty when absent. The tone curve the profile intends on top of
    /// the linear rendition.
    pub profile_tone_curve: Vec<f32>,
    /// DNG ActiveArea (0xC68D) as [top, left, bottom, right] in plane
    /// coordinates, when present: pixels outside it are masked/padding and a
    /// viewer should crop to it. `None` = whole plane is active.
    pub active_area: Option<[u32; 4]>,
    /// DNG 1.6 ProfileGainTableMap (0xCD2D) from the raw IFD — Apple ProRAW's
    /// local tone map ("the Apple look"). See [`GainTableMap`].
    pub profile_gain_table_map: Option<GainTableMap>,
    /// LinearizationTable (0xC618) from the raw IFD, empty when absent.
    /// `raw` holds the STORED codes; true linear values are
    /// `linearization_table[code]` (Apple ProRAW: 12-bit codes → 16-bit
    /// linear), and `white`/the PGTM weight scale live in THAT domain.
    pub linearization_table: Vec<u16>,
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

    /// Crop `raw` (and `width`/`height`) to [`Self::active_area`]: pixels outside it
    /// are masked/padding (a dark border on the Adobe Bayer sample, whose stored
    /// plane is 10240x7168 with 9600x6376 active). The CFAPattern origin is the
    /// ActiveArea's top-left (DNG spec), so `cfa` stays valid. No-op when absent,
    /// degenerate, or the whole plane.
    pub fn crop_to_active_area(&mut self) {
        let Some([top, left, bottom, right]) = self.active_area else { return };
        let (t, l) = (top as usize, left as usize);
        let (b, r) = ((bottom as usize).min(self.height), (right as usize).min(self.width));
        if b <= t || r <= l || (b - t == self.height && r - l == self.width) {
            return;
        }
        let cps = self.samples_per_pixel;
        let (nw, nh) = (r - l, b - t);
        let mut v = vec![0u16; nw * nh * cps];
        for y in 0..nh {
            let src = ((t + y) * self.width + l) * cps;
            v[y * nw * cps..(y + 1) * nw * cps].copy_from_slice(&self.raw[src..src + nw * cps]);
        }
        self.raw = v;
        self.width = nw;
        self.height = nh;
    }
}

const TAG_COLOR_MATRIX_1: u16 = 0xC621;
const TAG_COLOR_MATRIX_2: u16 = 0xC622;
const TAG_FORWARD_MATRIX_1: u16 = 0xC714;
const TAG_FORWARD_MATRIX_2: u16 = 0xC715;
const TAG_CALIBRATION_ILLUMINANT_1: u16 = 0xC65A;
const TAG_CALIBRATION_ILLUMINANT_2: u16 = 0xC65B;

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
///
/// **Two callers, and the second one is not a benchmark.** It was exposed for
/// A/B benchmarking the LJPEG decoder in isolation, and the sibling `blizz`
/// tree's `src/ingest.rs` now also calls it to build a BLKB archive of a DNG:
/// it needs the byte ranges of the sensor payload so everything outside them —
/// maker notes, GPS, thumbnails — rides along verbatim in the archive's
/// sidecar. Nothing else here reports where the payload lives.
///
/// Still not part of the stable API, and still `#[doc(hidden)]`. But
/// **changing or removing it breaks camera RAW ingest in another repository**,
/// invisibly to this crate's tests. `blizz`'s documented fallback is to go back
/// to *refusing* DNG rather than writing an archive with an empty sidecar; that
/// is a decision to take deliberately, not a consequence to discover.
///
/// `blizz_ingest_api_pins` at the bottom of this file fails if the signature
/// moves.
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

/// Byte ranges of the sensor payload within `data`, for EVERY compression the
/// walker accepts (1 uncompressed, 7 LJPEG, 8 deflate, 34892 lossy JPEG, 52546
/// JPEG XL) — tiles or strips. This is pure tag arithmetic (offsets + byte
/// counts); no decoding.
///
/// The archive use case (`blizz` ingest): everything outside these ranges rides
/// along verbatim in the archive's sidecar. (`blizz` refuses a lossy DNG before
/// it gets here: [`DngImage::lossy_jpeg`].)
///
/// Sibling of [`ljpeg_tile_ranges`], which stays pinned to compression 7 for
/// its existing callers.
pub fn payload_ranges(data: &[u8]) -> Result<Vec<(usize, usize)>> {
    let (_state, raw, _le) = load_dng(data)?;
    let (offsets, counts) = if !raw.tile_offsets.is_empty() {
        (&raw.tile_offsets, &raw.tile_byte_counts)
    } else {
        (&raw.strip_offsets, &raw.strip_byte_counts)
    };
    if offsets.len() != counts.len() {
        bail!("DNG: offset/byte-count length mismatch");
    }
    let mut ranges = Vec::with_capacity(offsets.len());
    for (o, c) in offsets.iter().zip(counts.iter()) {
        let off = *o as usize;
        let end = off
            .checked_add(*c as usize)
            .filter(|&e| e <= data.len())
            .ok_or_else(|| anyhow!("payload range OOB"))?;
        ranges.push((off, end));
    }
    Ok(ranges)
}

pub fn decode_bytes(data: &[u8]) -> Result<DngImage> {
    decode_bytes_inner(data, false, None, None)
}

/// One JPEG XL tile/strip codestream -> `(samples, width, height, xyb)`, samples
/// interleaved `cps` per pixel in the convention [`jxl_segment_oxide`] and
/// [`jxl_segment_libjxl`] share (stored codes for an integer codestream; XYB
/// linear with 1.0 = 65535 * 255 / intensity_target, libjxl's scale).
pub type JxlSegmentFn<'a> =
    &'a (dyn Fn(&[u8], usize) -> std::result::Result<(Vec<u16>, u32, u32, bool), String> + Sync);

/// [`decode_bytes`] with the JPEG XL tiles decoded by `seg` instead of the
/// build's own backend: lets a caller pick libjxl natively, or hand in a
/// separately loaded WASM libjxl in a browser. Non-JXL DNGs ignore `seg`.
pub fn decode_bytes_with_jxl(data: &[u8], seg: JxlSegmentFn) -> Result<DngImage> {
    decode_bytes_inner(data, false, Some(seg), None)
}

/// A caller's parallel-for: run `task(i)` for every `i` in `0..n`, on any
/// threads and in any order, and return once every call has finished.
/// Handed to [`decode_bytes_with`] so an embedder runs the tile loops
/// (LJPEG 7, deflate 8, JPEG XL 52546) on its own pool and thread count
/// instead of rayon. Output does not depend on the order or thread count.
pub type TileExecFn<'a> = &'a dyn Fn(usize, &(dyn Fn(usize) + Sync));

/// [`decode_bytes`] with an optional JPEG XL tile decoder (see
/// [`decode_bytes_with_jxl`]) and an optional tile executor. `exec: None`
/// keeps the build's default: rayon under `parallel`, serial otherwise.
pub fn decode_bytes_with(
    data: &[u8],
    seg: Option<JxlSegmentFn>,
    exec: Option<TileExecFn>,
) -> Result<DngImage> {
    decode_bytes_inner(data, false, seg, exec)
}

/// Run `task` over `0..n` through `exec`, or the build's default.
fn for_each_tile(exec: Option<TileExecFn>, n: usize, task: &(dyn Fn(usize) + Sync)) {
    if let Some(exec) = exec {
        return exec(n, task);
    }
    #[cfg(feature = "parallel")]
    (0..n).into_par_iter().for_each(|i| task(i));
    #[cfg(not(feature = "parallel"))]
    (0..n).for_each(task);
}

/// `f(i, band_i)` over `out.chunks_mut(stride)` through [`for_each_tile`].
/// Bands are disjoint, so each sits behind its own (uncontended) lock. The
/// first error in band order wins, as in a serial loop; a band the executor
/// never ran is an error, not silent zeros.
fn for_each_band(
    exec: Option<TileExecFn>,
    out: &mut [u16],
    stride: usize,
    f: &(dyn Fn(usize, &mut [u16]) -> Result<()> + Sync),
) -> Result<()> {
    let bands: Vec<Mutex<(&mut [u16], Option<Result<()>>)>> =
        out.chunks_mut(stride.max(1)).map(|b| Mutex::new((b, None))).collect();
    for_each_tile(exec, bands.len(), &|i| {
        let mut g = bands[i].lock().unwrap();
        let (band, r) = &mut *g;
        *r = Some(f(i, band));
    });
    bands
        .into_iter()
        .map(|m| {
            m.into_inner()
                .unwrap()
                .1
                .unwrap_or_else(|| Err(anyhow!("DNG: tile executor skipped a band")))
        })
        .collect()
}

/// Whether this DNG's raw image is JPEG XL-compressed (52546), i.e. whether a
/// JXL decoder must be loaded before [`decode_bytes`] can succeed.
pub fn uses_jxl(data: &[u8]) -> bool {
    load_dng(data).is_ok_and(|(_, raw, _)| raw.compression == 52546)
}

/// A/B bench entry: identical to `decode_bytes` but routes LJPEG tiles through the
/// legacy compact-buffer + serial-blit path (`decode_tiles_blit`) instead of the
/// band-parallel direct-write path. Exists only so an example can flip the two on a
/// real file for parity + timing; not part of the stable API.
#[doc(hidden)]
pub fn decode_bytes_blit(data: &[u8]) -> Result<DngImage> {
    decode_bytes_inner(data, true, None, None)
}

fn decode_bytes_inner(
    data: &[u8],
    use_blit: bool,
    seg: Option<JxlSegmentFn>,
    exec: Option<TileExecFn>,
) -> Result<DngImage> {
    // Count every container decode so the deferred-finish contract (decode the
    // container exactly once, then reuse the retained mosaic) is testable.
    DECODE_COUNT.fetch_add(1, Ordering::Relaxed);
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

    // 1 sample/pixel = Bayer mosaic; 3 = Linear DNG (interleaved RGB — Apple
    // ProRAW). Anything else is refused by number rather than mis-decoded.
    if cps != 1 && cps != 3 {
        bail!("DNG: SamplesPerPixel {cps} not supported (1 = Bayer, 3 = linear RGB)");
    }
    let mut out = vec![0u16; width * height * cps];

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
    // `mut` is only exercised by the jxl-codec arm below.
    #[allow(unused_mut)]
    let mut jxl_lossy: Option<bool> = None;
    let mut white_mapped = None;
    match raw.compression {
        34892 => white_mapped = decode_lossy_jpeg(data, &raw, width, height, cps, &mut out)?,
        1 => decode_uncompressed(data, &raw, width, height, le, &mut out)?,
        7 if use_blit => decode_tiles_blit(data, &raw, width, height, cps, &mut out)?,
        7 => decode_tiles(data, &raw, width, height, cps, &mut out, exec)?,
        8 => decode_deflate(data, &raw, width, height, le, &mut out, exec)?,
        52546 => {
            let seg = seg.or(DEFAULT_JXL_SEGMENT).ok_or_else(|| {
                anyhow!("DNG compression 52546 (JPEG XL) needs the jxl-codec or jxl-pure feature, or a decoder passed to decode_bytes_with_jxl")
            })?;
            jxl_lossy = Some(decode_jxl(data, &raw, width, height, cps, &mut out, seg, exec)?)
        }
        c => bail!("DNG compression {c} not supported"),
    }

    // DNG RowInterleaveFactor / ColumnInterleaveFactor: the stored image is
    // R×C stacked color-plane fields (each compresses far better than the raw
    // mosaic under JXL); reorder to the true mosaic. Whole pixels move — all
    // `cps` samples together.
    let ri = raw.row_interleave.unwrap_or(1).max(1) as usize;
    let ci = raw.column_interleave.unwrap_or(1).max(1) as usize;
    if ri > 1 || ci > 1 {
        if ri > height || ci > width {
            bail!("DNG: interleave factors {ri}x{ci} exceed the image dimensions");
        }
        deinterleave_fields(&mut out, width, height, cps, ri, ci);
    }

    let wb_r_neutral = state.as_shot_neutral.map(|n| n[0]).unwrap_or(1.0);
    let wb_g_neutral = state.as_shot_neutral.map(|n| n[1]).unwrap_or(1.0);
    let wb_b_neutral = state.as_shot_neutral.map(|n| n[2]).unwrap_or(1.0);
    let wb_r = wb_g_neutral / wb_r_neutral.max(1e-6);
    let wb_g = 1.0;
    let wb_b = wb_g_neutral / wb_b_neutral.max(1e-6);

    // A MapPolynomial-mapped lossy plane is already black-subtracted and
    // normalised to 0..=65535.
    let black = if white_mapped.is_some() { 0 } else { raw.black_level.unwrap_or(0) };
    let white = white_mapped.unwrap_or_else(|| raw.white_level.unwrap_or(16383));
    let color_matrix = state.resolved_color_matrix.or_else(|| {
        choose_camera_to_srgb_matrix(
            state.forward_matrix_1,
            state.forward_matrix_2,
            state.color_matrix_1,
            state.color_matrix_2,
        )
    });
    // Color matrix (camera native -> sRGB via XYZ) is passed through to higher
    // LookRenderer for the advanced non-Riemannian / log geodesic / Molchanov
    // perceptual model (lens17). The demosaic stage (incl. optional mhc_matrix
    // fusion) + this + black/white/wb provide the clean linear starting point.

    let noise_metadata = state.noise_tags.build(black as f32, white as f32);

    Ok(DngImage {
        width,
        height,
        raw: out,
        samples_per_pixel: cps,
        jxl_distance: raw.jxl_distance,
        jxl_lossy,
        lossy_jpeg: raw.compression == 34892,
        cfa,
        black,
        white,
        wb_r,
        wb_g,
        wb_b,
        wb_from_camera: state.as_shot_neutral.is_some(),
        iso: state.iso,
        baseline_exposure: state.baseline_exposure.unwrap_or(0.0),
        color_matrix,
        forward_matrix: state.forward_matrix_2.or(state.forward_matrix_1),
        profile_tone_curve: state.profile_tone_curve.clone(),
        active_area: raw.active_area,
        profile_gain_table_map: raw
            .pgtm_range
            .and_then(|(off, len)| {
                off.checked_add(len).filter(|&e| e <= data.len()).map(|e| &data[off..e])
            })
            .and_then(|blob| parse_gain_table_map(blob, le)),
        linearization_table: raw.linearization.clone(),
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
///
/// Finding 50/51: this is the streaming-preview arm of the ONE metadata carrier.
/// It must preserve the SAME datetime/GPS/wb-provenance the full decode (`DngImage`)
/// carries — the streaming preview path used to drop them, so the info panel lost
/// datetime/GPS and `wb_from_camera` was faked to `true` regardless of provenance.
pub struct DngMeta {
    pub width: usize,
    pub height: usize,
    pub cfa: Cfa,
    pub black: u16,
    pub white: u16,
    pub wb_r: f32,
    pub wb_b: f32,
    /// `true` only when WB genuinely came from AsShotNeutral (or the derived
    /// AsShotWhiteXY). `false` = the 1.0/1.0 grey fallback fired. Not a fake default.
    pub wb_from_camera: bool,
    pub color_matrix: Option<[[f32; 3]; 3]>,
    pub iso: Option<u32>,
    pub baseline_exposure: f32,
    pub orientation: u16,
    pub make: String,
    pub model: String,
    /// Per-CFA-plane noise metadata (black/white levels, embedded NoiseProfile, etc.).
    pub noise_metadata: RawNoiseMetadata,
    /// EXIF DateTimeOriginal (or DateTime), "YYYY:MM:DD HH:MM:SS", empty if absent.
    pub datetime: String,
    /// Decimal GPS (None when the file has no GPS IFD or it is out of range).
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub gps_alt: Option<f64>,
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
        // Finding 51: honest provenance — mirrors DngImage (AsShotNeutral presence).
        wb_from_camera: state.as_shot_neutral.is_some(),
        color_matrix: state.resolved_color_matrix.or_else(|| {
            choose_camera_to_srgb_matrix(
                state.forward_matrix_1,
                state.forward_matrix_2,
                state.color_matrix_1,
                state.color_matrix_2,
            )
        }),
        iso: state.iso,
        baseline_exposure: state.baseline_exposure.unwrap_or(0.0),
        orientation: state.orientation.unwrap_or(1),
        make: state.make.clone(),
        model: state.model.clone(),
        noise_metadata,
        // Finding 50: preserve the datetime/GPS the walk already parsed into state.exif.
        datetime: state.exif.datetime.clone(),
        gps_lat: state.exif.gps_lat,
        gps_lon: state.exif.gps_lon,
        gps_alt: state.exif.gps_alt,
    }
}

/// Streaming DNG raw-row source. Both comp=7 (LJPEG tiles) and comp=1 (uncompressed
/// strips or tiles) decode one raster row-band at a time into a reused buffer and dole
/// rows out of it — no full-resolution mosaic is ever materialised (finding 53). Yields
/// rows byte-identical to `decode_bytes().raw`, top-to-bottom, without the full-res
/// demosaiced RGB. Feeds the generic `stream_preview::build_previews_streaming`.
pub struct DngRowSource<'a> {
    data: &'a [u8],
    raw: RawIfd,
    meta: DngMeta,
    le: bool,
    row: usize,
    // comp=7 LJPEG tile-band streaming
    tiled: bool,
    tw: usize,
    tl: usize,
    coltiles: usize,
    // comp=1 uncompressed strip/tile-band streaming
    uncompressed: Option<UncompressedLayout>,
    // Shared row-band scratch (reused across bands; holds at most one row-band).
    band_buf: Vec<u16>,
    band_first: usize,
    band_rows: usize,
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
        // Streaming yields whole-plane rows; a real ActiveArea crop takes the full
        // path (`DngImage::crop_to_active_area`) so previews match the final.
        if let Some([t, l, b, r]) = raw.active_area {
            if (t, l) != (0, 0) || (b as usize) < height || (r as usize) < width {
                return Err("DNG: ActiveArea crop not streamable".into());
            }
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
                    le,
                    row: 0,
                    tiled: true,
                    tw,
                    tl,
                    coltiles,
                    uncompressed: None,
                    band_buf: Vec::new(),
                    band_first: 0,
                    band_rows: 0,
                })
            }
            1 => {
                // Uncompressed: resolve the strip/tile layout once, then decode a single
                // row-band on demand in `next_row_into` (finding 53). No full-res mosaic
                // is allocated — peak is one row-band + the caller's preview outputs.
                let layout = uncompressed_layout(&raw, width, height)
                    .map_err(|e| format!("DNG uncompressed: {e}"))?;
                Ok(Self {
                    data,
                    raw,
                    meta,
                    le,
                    row: 0,
                    tiled: false,
                    tw: 0,
                    tl: 0,
                    coltiles: 0,
                    uncompressed: Some(layout),
                    band_buf: Vec::new(),
                    band_first: 0,
                    band_rows: 0,
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
            // comp=7 LJPEG: decode the row's tile-band into band_buf on first touch.
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
                    1, // DngRowSource::new rejects cps != 1
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
        } else if let Some(layout) = self.uncompressed {
            // comp=1: decode the strip / tile-row containing row `r` into band_buf on
            // first touch, then serve rows out of it (finding 53 — no full mosaic).
            if self.band_rows == 0 || r >= self.band_first + self.band_rows {
                let band_stride = match layout {
                    UncompressedLayout::Tiled { tl, .. } => tl,
                    UncompressedLayout::Strips { rows_per_strip } => rows_per_strip,
                };
                let band_first = (r / band_stride) * band_stride;
                let rows = layout.band_rows(band_first, h);
                self.band_buf.resize(rows * w, 0);
                decode_uncompressed_band(
                    self.data,
                    &self.raw,
                    layout,
                    w,
                    h,
                    self.le,
                    band_first,
                    &mut self.band_buf,
                )
                .map_err(|e| format!("DNG uncompressed band @{band_first}: {e}"))?;
                self.band_first = band_first;
                self.band_rows = rows;
            }
            let local = r - self.band_first;
            dst[..w].copy_from_slice(&self.band_buf[local * w..local * w + w]);
        } else {
            return Err("DNG: row source has no decode path".into());
        }
        self.row += 1;
        Ok(true)
    }
}

/// Decode one row-tile band `tr` (comp=7 LJPEG tiles) into `band` (len == active_h*width,
/// rows [tr*tl, min((tr+1)*tl, height))), for the streaming `DngRowSource`.
/// Byte-identical to `decode_tiles`.
fn decode_band_into(
    data: &[u8],
    raw: &RawIfd,
    width: usize,
    height: usize,
    cps: usize,
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
        // All geometry below is in raw SAMPLE units (pixel * cps): for cps=1
        // this is exactly the old math; for cps=3 (Linear DNG) each pixel is
        // three interleaved samples.
        ljpeg::decode_tile(
            src,
            band,
            col_start * cps,
            width * cps,
            active_w * cps,
            active_h,
        )
        .with_context(|| format!("tile r={tr} c={tc}"))?;
    }
    Ok(())
}

/// Decode LJPEG tiles (compression=7) into the strided output mosaic, one
/// [`for_each_tile`] task per **tile**.
///
/// Each row-tile band is a disjoint, contiguous run of `out` rows behind its own lock. A
/// tile that finds its band free decodes straight into its sub-rect via the strided
/// `ljpeg::decode_tile`; one that finds it busy decodes into a compact buffer and copies
/// it in under the lock. Serially every tile takes the direct path.
///
/// Band-sized tasks (the previous shape) capped the parallelism at `rowtiles`, which is
/// 6 on a 48-tile Apple ProRAW. `decode_tiles_blit`'s per-tile scratch + single-threaded
/// serial blit (measured ~34% of `decode_bytes` wall time) stays avoided: only contended
/// tiles copy, and they copy in parallel.
/// One baseline JPEG (a lossy DNG tile or strip) -> `(width, height, components,
/// samples)`, 8-bit, interleaved, colour-converted as the JPEG's own markers say.
pub type LossyJpegFn = fn(&[u8]) -> std::result::Result<(usize, usize, usize, Vec<u8>), String>;

static LOSSY_JPEG: std::sync::OnceLock<LossyJpegFn> = std::sync::OnceLock::new();

/// Hand in the JPEG decoder for lossy DNG (compression 34892). This crate has
/// none of its own; the first call wins, later calls are ignored.
pub fn set_lossy_jpeg_decoder(f: LossyJpegFn) {
    let _ = LOSSY_JPEG.set(f);
}

/// Compression 34892: every tile (or strip) is an 8-bit baseline JPEG with
/// `cps` components. OpcodeList2's MapPolynomial opcodes (id 8) are the
/// encoding curve back to linear (Adobe DNG Converter writes one cubic per
/// plane): when present they are applied here, on (code - black) / (white -
/// black) per DNG §6 stage 2, and the plane comes back normalised to 0..=65535
/// (`Some(65535)` = the new white, black 0). Without them the 8-bit codes are
/// returned as stored (`None`).
fn decode_lossy_jpeg(
    data: &[u8],
    raw: &RawIfd,
    width: usize,
    height: usize,
    cps: usize,
    out: &mut [u16],
) -> Result<Option<u16>> {
    let dec = LOSSY_JPEG.get().ok_or_else(|| {
        anyhow!("DNG compression 34892 (lossy JPEG) needs a JPEG decoder: none was set (set_lossy_jpeg_decoder)")
    })?;
    let (tw, tl, offs, cnts) = if !raw.tile_offsets.is_empty() {
        let tw = raw.tile_width.ok_or_else(|| anyhow!("missing TileWidth"))? as usize;
        let tl = raw.tile_length.ok_or_else(|| anyhow!("missing TileLength"))? as usize;
        (tw, tl, &raw.tile_offsets, &raw.tile_byte_counts)
    } else {
        let rps = raw.rows_per_strip.map_or(height, |r| (r as usize).min(height));
        (width, rps, &raw.strip_offsets, &raw.strip_byte_counts)
    };
    if tw == 0 || tl == 0 {
        bail!("DNG: zero tile/strip size");
    }
    let across = width.div_ceil(tw);
    if offs.len() != across * height.div_ceil(tl) || cnts.len() != offs.len() {
        bail!("DNG 34892: {} segments for a {width}x{height} image of {tw}x{tl}", offs.len());
    }
    // The stored 8-bit codes; `out` gets them, or their mapped values.
    let mut codes = vec![0u8; out.len()];
    // ponytail: serial tile loop; hand it the TileExecFn if lossy DNG view time matters.
    for (i, (&o, &n)) in offs.iter().zip(cnts.iter()).enumerate() {
        let seg = data
            .get(o as usize..(o as usize).saturating_add(n as usize))
            .ok_or_else(|| anyhow!("DNG 34892: segment {i} past end of file"))?;
        let (jw, jh, jc, px) = dec(seg).map_err(|e| anyhow!("DNG 34892 segment {i}: {e}"))?;
        if jc != cps || px.len() < jw * jh * jc {
            bail!("DNG 34892 segment {i}: {jc} components, {cps} expected");
        }
        let (x0, y0) = ((i % across) * tw, (i / across) * tl);
        for y in 0..jh.min(tl).min(height - y0) {
            let n = jw.min(tw).min(width - x0) * cps;
            let at = ((y0 + y) * width + x0) * cps;
            codes[at..at + n].copy_from_slice(&px[y * jw * cps..][..n]);
        }
    }
    let maps = raw.opcode_list2.map_or_else(Vec::new, |(o, n)| map_polynomials(data.get(o..o.saturating_add(n)).unwrap_or(&[])));
    if maps.is_empty() {
        for (d, &c) in out.iter_mut().zip(&codes) {
            *d = c as u16;
        }
        return Ok(None);
    }
    let black = raw.black_level.unwrap_or(0) as f64;
    let range = (raw.white_level.unwrap_or(255) as f64 - black).max(1.0);
    // Samples no opcode covers still get the same normalisation.
    for (d, &c) in out.iter_mut().zip(&codes) {
        *d = (((c as f64 - black) / range).clamp(0.0, 1.0) * 65535.0).round() as u16;
    }
    for m in &maps {
        let lut: Vec<u16> = (0..256)
            .map(|c| {
                let x = (c as f64 - black) / range;
                let y = m.coef.iter().rev().fold(0.0, |acc, &k| acc * x + k);
                (y.clamp(0.0, 1.0) * 65535.0).round() as u16
            })
            .collect();
        let (bottom, right) = (m.bottom.min(height), m.right.min(width));
        for y in (m.top..bottom).step_by(m.row_pitch.max(1)) {
            for x in (m.left..right).step_by(m.col_pitch.max(1)) {
                for pl in m.plane..(m.plane + m.planes).min(cps) {
                    let at = (y * width + x) * cps + pl;
                    out[at] = lut[codes[at] as usize];
                }
            }
        }
    }
    Ok(Some(65535))
}

/// DNG MapPolynomial opcode (id 8): `y = sum coef[k] x^k` over an area/plane range.
struct MapPoly {
    top: usize,
    left: usize,
    bottom: usize,
    right: usize,
    plane: usize,
    planes: usize,
    row_pitch: usize,
    col_pitch: usize,
    coef: Vec<f64>,
}

/// The MapPolynomial opcodes of an opcode list (big-endian per the DNG spec);
/// other opcodes are skipped by their byte count.
fn map_polynomials(b: &[u8]) -> Vec<MapPoly> {
    let u = |p: usize| b.get(p..p + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]) as usize);
    let mut v = Vec::new();
    let Some(n) = u(0) else { return v };
    let mut p = 4;
    for _ in 0..n {
        let (Some(id), Some(len)) = (u(p), u(p + 12)) else { break };
        let q = p + 16;
        if id == 8 {
            let f = |k: usize| u(q + 4 * k).unwrap_or(0);
            let deg = f(8);
            let coef: Vec<f64> = (0..=deg.min(8))
                .filter_map(|k| b.get(q + 36 + 8 * k..q + 44 + 8 * k).map(|s| f64::from_be_bytes(s.try_into().unwrap())))
                .collect();
            if coef.len() == deg.min(8) + 1 {
                v.push(MapPoly {
                    top: f(0),
                    left: f(1),
                    bottom: f(2),
                    right: f(3),
                    plane: f(4),
                    planes: f(5),
                    row_pitch: f(6),
                    col_pitch: f(7),
                    coef,
                });
            }
        }
        p = q + len;
    }
    v
}

fn decode_tiles(
    data: &[u8],
    raw: &RawIfd,
    width: usize,
    height: usize,
    cps: usize,
    out: &mut [u16],
    exec: Option<TileExecFn>,
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
    // chunks_mut(tl*width*cps) yields exactly `rowtiles` disjoint bands (the last
    // shorter when height isn't a multiple of tl); tl*width*cps ≤ 3*height*width ≤
    // 600 M samples (caller guard) so it cannot overflow usize on wasm32.
    let stride = width * cps;
    let bands: Vec<Mutex<&mut [u16]>> = out.chunks_mut(tl * stride).map(Mutex::new).collect();
    let results: Vec<Mutex<Option<Result<()>>>> = (0..expected).map(|_| Mutex::new(None)).collect();

    // One task per TILE, not per band: a band is only `coltiles` wide, so
    // band units cap the parallelism at `rowtiles` (6 on a 48-tile ProRAW).
    // A tile whose band is free decodes straight into it at base
    // col_start*cps (the serial arm always takes this path, so it does
    // exactly the old work). A tile whose band is busy decodes into a compact
    // buffer and holds the band lock only for the row copy.
    let decode_one = |idx: usize| -> Result<()> {
        let (tr, tc) = (idx / coltiles, idx % coltiles);
        let off = raw.tile_offsets[idx] as usize;
        let end = off
            .checked_add(raw.tile_byte_counts[idx] as usize)
            .ok_or_else(|| anyhow!("tile {idx} OOB"))?;
        let src = data.get(off..end).ok_or_else(|| anyhow!("tile {idx} OOB"))?;
        let col_start = tc * tw;
        let aw = ((tc + 1) * tw).min(width) - col_start;
        let ah = ((tr + 1) * tl).min(height) - tr * tl;
        let (base, row) = (col_start * cps, aw * cps);
        match bands[tr].try_lock() {
            Ok(mut band) => ljpeg::decode_tile(src, &mut band, base, stride, row, ah),
            Err(std::sync::TryLockError::WouldBlock) => {
                let mut buf = vec![0u16; row * ah];
                ljpeg::decode_tile(src, &mut buf, 0, row, row, ah)?;
                let mut band = bands[tr].lock().unwrap();
                for (r, s) in buf.chunks_exact(row).enumerate() {
                    band[r * stride + base..][..row].copy_from_slice(s);
                }
                Ok(())
            }
            Err(std::sync::TryLockError::Poisoned(e)) => panic!("DNG band lock poisoned: {e}"),
        }
        .with_context(|| format!("tile r={tr} c={tc}"))
    };
    for_each_tile(exec, expected, &|idx| *results[idx].lock().unwrap() = Some(decode_one(idx)));
    results
        .into_iter()
        .map(|m| {
            m.into_inner()
                .unwrap()
                .unwrap_or_else(|| Err(anyhow!("DNG: tile executor skipped a tile")))
        })
        .collect()
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
        // A folded frame (k sensor rows per JPEG line, `ljpeg::unfold`): the
        // same buffer read as bw/k x bh*k is the tile.
        let (bw, bh) = match tl.checked_rem(bh) {
            Some(0) if bh < tl && bw % (tl / bh) == 0 => (bw / (tl / bh), tl),
            _ => (bw, bh),
        };
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

    // Serial blit of active rects (disjoint; cheap vs decode work). All widths
    // and column offsets below are in raw SAMPLE units (pixel * cps).
    for td in tiles {
        let aw = (td.active_w * cps).min(td.buf_w);
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
                .and_then(|v| v.checked_mul(cps))
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
/// Bytes one row of `n` samples occupies. TIFF packs samples narrower than 16
/// bits MSB-first, and every row starts on a byte boundary (dcraw
/// `packed_dng_load_raw`: `getbits(-1)` resets the reader per row).
fn row_bytes(n: usize, bps: u16) -> usize {
    (n * bps as usize).div_ceil(8)
}

/// One row of an uncompressed DNG: 16-bit samples in the file's byte order, or
/// 8-15-bit samples as an MSB-first bitstream (byte order does not apply to a
/// bitstream). Casio EX-FH20 writes 12-bit packed DNG; before 2026-09-27 any
/// bps but 16 was refused.
fn fill_row(dst: &mut [u16], bytes: &[u8], le: bool, bps: u16) {
    if bps == 16 {
        return fill_u16_row(dst, bytes, le);
    }
    let (bps, mask) = (bps as u32, (1u32 << bps) - 1);
    let (mut acc, mut nbits) = (0u32, 0u32);
    let mut src = bytes.iter();
    for o in dst.iter_mut() {
        while nbits < bps {
            acc = (acc << 8) | u32::from(*src.next().unwrap_or(&0));
            nbits += 8;
        }
        nbits -= bps;
        *o = ((acc >> nbits) & mask) as u16;
    }
}

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

/// Which physical layout an uncompressed (compression=1) DNG uses. Resolved once
/// so both the full decode and the streaming row source share the same geometry
/// and per-band decode primitives — finding 53 (stream comp=1 rows without a full
/// mosaic).
#[derive(Clone, Copy)]
enum UncompressedLayout {
    /// TileWidth/TileLength grid; a raster row-band = one tile row (all col tiles).
    Tiled { tw: usize, tl: usize, coltiles: usize },
    /// Strip layout; a raster row-band = one strip (`rows_per_strip` rows).
    Strips { rows_per_strip: usize },
}

impl UncompressedLayout {
    /// Rows in the row-band starting at raster row `band_first` (the band the
    /// streaming source materialises before serving rows out of it).
    fn band_rows(&self, band_first: usize, height: usize) -> usize {
        match *self {
            UncompressedLayout::Tiled { tl, .. } => {
                let row_end = band_first.saturating_add(tl).min(height);
                row_end - band_first
            }
            UncompressedLayout::Strips { rows_per_strip } => {
                let row_end = band_first.saturating_add(rows_per_strip).min(height);
                row_end - band_first
            }
        }
    }
}

/// Resolve the compression=1 layout (tiled vs strips) from the raw IFD, validating
/// the same invariants the previous inline `decode_uncompressed` enforced.
fn uncompressed_layout(raw: &RawIfd, width: usize, height: usize) -> Result<UncompressedLayout> {
    if !(8..=16).contains(&raw.bits_per_sample) {
        bail!("uncompressed DNG: bps {} unsupported", raw.bits_per_sample);
    }
    if !raw.tile_offsets.is_empty() {
        let tw = raw.tile_width.ok_or_else(|| anyhow!("TileWidth"))? as usize;
        let tl = raw.tile_length.ok_or_else(|| anyhow!("TileLength"))? as usize;
        // Zero tile dims would div-by-zero / underflow below (000-errors-6).
        if tw == 0 || tl == 0 {
            bail!("uncompressed DNG: zero TileWidth/TileLength");
        }
        let coltiles = width.div_ceil(tw);
        Ok(UncompressedLayout::Tiled { tw, tl, coltiles })
    } else if !raw.strip_offsets.is_empty() {
        if raw.strip_offsets.len() != raw.strip_byte_counts.len() {
            bail!("uncompressed DNG: strip count mismatch");
        }
        let rows_per_strip = raw.rows_per_strip.unwrap_or(height as u32).max(1) as usize;
        Ok(UncompressedLayout::Strips { rows_per_strip })
    } else {
        bail!("uncompressed DNG: missing tile or strip offsets")
    }
}

/// Decode one uncompressed row-band `[band_first, band_first+band_rows)` into `band`
/// (len == band_rows*width, full-width raster order). Byte-identical to the inline
/// per-strip / per-tile-row loops the whole-frame `decode_uncompressed` used; shared
/// so `DngRowSource` can materialise only the requested band (finding 53).
fn decode_uncompressed_band(
    data: &[u8],
    raw: &RawIfd,
    layout: UncompressedLayout,
    width: usize,
    height: usize,
    le: bool,
    band_first: usize,
    band: &mut [u16],
) -> Result<()> {
    match layout {
        UncompressedLayout::Tiled { tw, tl, coltiles } => {
            let tr = band_first / tl;
            let row_start = tr * tl;
            let row_end = ((tr + 1) * tl).min(height);
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
                // Per-row contiguous copy into the band (band-local row = r - row_start).
                let cw = col_end - col_start; // ≤ tw
                let mut sp = 0usize;
                for r in row_start..row_end {
                    let need = row_bytes(cw, raw.bits_per_sample);
                    if sp + need > src.len() {
                        bail!("uncompressed DNG: tile {idx} truncated");
                    }
                    let base = (r - band_first) * width + col_start;
                    fill_row(&mut band[base..base + cw], &src[sp..sp + need], le, raw.bits_per_sample);
                    // For valid tiles cw ≤ tw, so the row stride is a full tile row.
                    sp += row_bytes(tw, raw.bits_per_sample);
                }
            }
            Ok(())
        }
        UncompressedLayout::Strips { rows_per_strip } => {
            let idx = band_first / rows_per_strip;
            if idx >= raw.strip_offsets.len() || idx >= raw.strip_byte_counts.len() {
                bail!("uncompressed DNG: strip {idx} index out of range");
            }
            let off = raw.strip_offsets[idx] as usize;
            let mut bc = raw.strip_byte_counts[idx] as usize;
            // Hasselblad L2D-20c (DJI): StripByteCounts understates the strip
            // (41,775,360 for 42,534,912 = W*H*2), whose rows end EXACTLY at EOF;
            // LibRaw (black box) reads them all. Only that exact fit is trusted.
            let full = row_bytes(width, raw.bits_per_sample)
                .checked_mul((band_first + rows_per_strip).min(height) - band_first);
            if let Some(full) = full.filter(|&f| bc < f && off.checked_add(f) == Some(data.len())) {
                bc = full;
            }
            // checked_add (000-security-11): off+bc can wrap usize on wasm32.
            let end = off
                .checked_add(bc)
                .ok_or_else(|| anyhow!("uncompressed DNG: strip {idx} OOB"))?;
            let src = data
                .get(off..end)
                .ok_or_else(|| anyhow!("uncompressed DNG: strip {idx} OOB"))?;
            let row_end = (band_first + rows_per_strip).min(height);
            // Per-row contiguous copy into the band. r*width+width can overflow on
            // hostile width; the band slice bound preserves the old get_mut guard.
            let need = row_bytes(width, raw.bits_per_sample);
            let mut sp = 0usize;
            for r in band_first..row_end {
                if sp + need > src.len() {
                    bail!("uncompressed DNG: strip {idx} truncated");
                }
                let base = (r - band_first) * width;
                let dst = base
                    .checked_add(width)
                    .and_then(|e| band.get_mut(base..e))
                    .ok_or_else(|| anyhow!("uncompressed DNG: strip {idx} dst OOB"))?;
                fill_row(dst, &src[sp..sp + need], le, raw.bits_per_sample);
                sp += need;
            }
            Ok(())
        }
    }
}

/// Stored-index → final-index map for one axis of the DNG interleave
/// (RowInterleaveFactor 0xC71F / ColumnInterleaveFactor 0xCD43), dng_sdk
/// remainder rule: field `f` holds `ceil((total-f)/factor)` entries, stored
/// as consecutive runs field 0 first; entry `within` of field `f` lands at
/// final index `within*factor + f`. Bijective for every `total`/`factor`.
fn interleave_field_map(total: usize, factor: usize) -> Vec<u32> {
    let mut map = vec![0u32; total];
    let mut acc = 0usize;
    for f in 0..factor {
        let extent = (total - f).div_ceil(factor);
        for within in 0..extent {
            map[acc + within] = (within * factor + f) as u32;
        }
        acc += extent;
    }
    debug_assert_eq!(acc, total);
    map
}

/// Reorder `out` (stored field order) into the final mosaic, whole pixels
/// (`cps` samples) at a time. One pass through a scratch plane; the scratch is
/// the cost of not doing an in-place cycle walk nobody needs yet.
fn deinterleave_fields(out: &mut [u16], w: usize, h: usize, cps: usize, ri: usize, ci: usize) {
    let rows = interleave_field_map(h, ri);
    let cols = interleave_field_map(w, ci);
    let mut dst = vec![0u16; out.len()];
    for y in 0..h {
        let fy = rows[y] as usize;
        for x in 0..w {
            let fx = cols[x] as usize;
            let s = (y * w + x) * cps;
            let d = (fy * w + fx) * cps;
            dst[d..d + cps].copy_from_slice(&out[s..s + cps]);
        }
    }
    out.copy_from_slice(&dst);
}

/// Deflate-compressed DNG (compression 8): each strip/tile is an independent
/// zlib stream of 16-bit samples in file byte order. Single-sample (Bayer or
/// gray) only; TIFF Predictor other than 1 (none) is refused by number — DNG
/// uses predictor 2/3 with deflate only for floating-point data, which is out
/// of scope here.
fn decode_deflate(
    data: &[u8],
    raw: &RawIfd,
    width: usize,
    height: usize,
    le: bool,
    out: &mut [u16],
    exec: Option<TileExecFn>,
) -> Result<()> {
    if raw.samples_per_pixel.max(1) != 1 {
        bail!(
            "deflate DNG: SamplesPerPixel {} not supported (single-sample only)",
            raw.samples_per_pixel
        );
    }
    if let Some(p) = raw.predictor {
        if p != 1 {
            bail!("deflate DNG: Predictor {p} not supported (only 1 = none)");
        }
    }
    if raw.bits_per_sample != 16 {
        bail!("deflate DNG: bps {} unsupported (16 only)", raw.bits_per_sample);
    }
    let layout = uncompressed_layout(raw, width, height)?;
    // One band = one strip or one tile row: a disjoint run of `out` rows.
    // Clamped to `height` so a file-controlled strip/tile length cannot
    // overflow the stride; one band then covers the image, as before.
    let band_rows = match layout {
        UncompressedLayout::Strips { rows_per_strip } => rows_per_strip,
        UncompressedLayout::Tiled { tl, .. } => tl,
    }
    .min(height);
    let decode_band = |i: usize, band: &mut [u16]| -> Result<()> {
        let rows = band.len() / width;
        match layout {
            UncompressedLayout::Strips { .. } => {
                let idx = i;
                if idx >= raw.strip_offsets.len() || idx >= raw.strip_byte_counts.len() {
                    bail!("deflate DNG: strip {idx} index out of range");
                }
                let off = raw.strip_offsets[idx] as usize;
                let bc = raw.strip_byte_counts[idx] as usize;
                let end = off
                    .checked_add(bc)
                    .filter(|&e| e <= data.len())
                    .ok_or_else(|| anyhow!("deflate DNG: strip {idx} OOB"))?;
                let need = rows * width * 2;
                let bytes =
                    miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(&data[off..end], need)
                        .map_err(|e| anyhow!("deflate DNG: strip {idx} inflate: {e:?}"))?;
                if bytes.len() < need {
                    bail!(
                        "deflate DNG: strip {idx} short: {} bytes for {} rows",
                        bytes.len(),
                        rows
                    );
                }
                for r in 0..rows {
                    fill_u16_row(
                        &mut band[r * width..(r + 1) * width],
                        &bytes[r * width * 2..(r + 1) * width * 2],
                        le,
                    );
                }
            }
            UncompressedLayout::Tiled { tw, tl, coltiles } => {
                let tr = i;
                for tc in 0..coltiles {
                    let idx = tr * coltiles + tc;
                    if idx >= raw.tile_offsets.len() || idx >= raw.tile_byte_counts.len() {
                        bail!("deflate DNG: tile {idx} index out of range");
                    }
                    let off = raw.tile_offsets[idx] as usize;
                    let bc = raw.tile_byte_counts[idx] as usize;
                    let end = off
                        .checked_add(bc)
                        .filter(|&e| e <= data.len())
                        .ok_or_else(|| anyhow!("deflate DNG: tile {idx} OOB"))?;
                    let need = tl * tw * 2; // tiles are padded to full tile size
                    let bytes = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(
                        &data[off..end],
                        need,
                    )
                    .map_err(|e| anyhow!("deflate DNG: tile {idx} inflate: {e:?}"))?;
                    if bytes.len() < need {
                        bail!("deflate DNG: tile {idx} short: {} bytes", bytes.len());
                    }
                    let col_start = tc * tw;
                    let cw = ((tc + 1) * tw).min(width) - col_start;
                    for r in 0..rows {
                        let dst = r * width + col_start;
                        fill_u16_row(
                            &mut band[dst..dst + cw],
                            &bytes[r * tw * 2..r * tw * 2 + cw * 2],
                            le,
                        );
                    }
                }
            }
        }
        Ok(())
    };
    for_each_band(exec, out, band_rows * width, &decode_band)
}

/// JPEG XL-compressed DNG (compression 52546, DNG 1.7): each tile/strip is an
/// independent JXL codestream. Decoded via the BSD-clean own-FFI decoder
/// (`jxl_casadecoder`); Gray for 1 sample/pixel, Rgb for Linear DNG (cps=3).
///
/// Caveat: libjxl's UINT16 output is full-range, so a codestream whose
/// declared bit depth is below 16 comes back scaled by 65535/(2^bits-1) —
/// not the stored codes. Every real 52546 file examined (Adobe SDK samples,
/// iPhone per rawspeed#971) declares a 16-bit codestream even when
/// BitsPerSample says 10, so this is currently theoretical; revisit if a
/// sub-16-bit codestream shows up.
/// Returns whether any segment's codestream is XYB-encoded (lossy) — the
/// codestream's own word, carried up so an archiver can refuse lossy sources
/// even when the container omits JXLDistance.
fn decode_jxl(
    data: &[u8],
    raw: &RawIfd,
    width: usize,
    height: usize,
    cps: usize,
    out: &mut [u16],
    seg: JxlSegmentFn,
    exec: Option<TileExecFn>,
) -> Result<bool> {
    if !matches!(cps, 1 | 3) {
        bail!("JXL DNG: SamplesPerPixel {cps} not supported");
    }
    // Segment geometry: tiles when present, else strips (a strip = a full-width
    // band). Reuses the same offset arrays either way.
    struct Seg {
        off: usize,
        end: usize,
        col_start: usize,
        row_start: usize,
        active_w: usize,
        active_h: usize,
    }
    let mut segs = Vec::new();
    if !raw.tile_offsets.is_empty() {
        let tw = raw.tile_width.ok_or_else(|| anyhow!("missing TileWidth"))? as usize;
        let tl = raw
            .tile_length
            .ok_or_else(|| anyhow!("missing TileLength"))? as usize;
        if tw == 0 || tl == 0 {
            bail!("JXL DNG: zero TileWidth/TileLength");
        }
        let coltiles = width.div_ceil(tw);
        let rowtiles = height.div_ceil(tl);
        let expected = coltiles
            .checked_mul(rowtiles)
            .ok_or_else(|| anyhow!("JXL DNG: tile grid overflow"))?;
        if raw.tile_offsets.len() != expected || raw.tile_byte_counts.len() != expected {
            bail!("JXL DNG: tile count mismatch");
        }
        for idx in 0..expected {
            let (tr, tc) = (idx / coltiles, idx % coltiles);
            let off = raw.tile_offsets[idx] as usize;
            let end = off
                .checked_add(raw.tile_byte_counts[idx] as usize)
                .filter(|&e| e <= data.len())
                .ok_or_else(|| anyhow!("JXL DNG: tile {idx} OOB"))?;
            let col_start = tc * tw;
            let row_start = tr * tl;
            segs.push(Seg {
                off,
                end,
                col_start,
                row_start,
                active_w: ((tc + 1) * tw).min(width) - col_start,
                active_h: ((tr + 1) * tl).min(height) - row_start,
            });
        }
    } else {
        let rows_per_strip = raw.rows_per_strip.unwrap_or(height as u32).max(1) as usize;
        if raw.strip_offsets.len() != raw.strip_byte_counts.len() {
            bail!("JXL DNG: strip count mismatch");
        }
        for (idx, (o, c)) in raw
            .strip_offsets
            .iter()
            .zip(raw.strip_byte_counts.iter())
            .enumerate()
        {
            let off = *o as usize;
            let end = off
                .checked_add(*c as usize)
                .filter(|&e| e <= data.len())
                .ok_or_else(|| anyhow!("JXL DNG: strip {idx} OOB"))?;
            let row_start = idx * rows_per_strip;
            if row_start >= height {
                bail!("JXL DNG: strip {idx} beyond image");
            }
            segs.push(Seg {
                off,
                end,
                col_start: 0,
                row_start,
                active_w: width,
                active_h: (row_start + rows_per_strip).min(height) - row_start,
            });
        }
    }

    // Decode each segment (through the tile executor — one Decoder per task)
    // into a compact buffer, then blit its active rect. Correctness path;
    // segment decode dominates, the serial blit is a memcpy.
    type Decoded = (Vec<u16>, u32, u32, bool);
    let slots: Vec<Mutex<Option<Result<Decoded>>>> = segs.iter().map(|_| Mutex::new(None)).collect();
    for_each_tile(exec, segs.len(), &|i| {
        let s = &segs[i];
        let r = seg(&data[s.off..s.end], cps).map_err(|e| anyhow!(e));
        *slots[i].lock().unwrap() = Some(r);
    });
    let decoded: Vec<Decoded> = slots
        .into_iter()
        .map(|m| {
            m.into_inner()
                .unwrap()
                .unwrap_or_else(|| Err(anyhow!("JXL DNG: tile executor skipped a segment")))
        })
        .collect::<Result<Vec<_>>>()?;
    let any_xyb = decoded.iter().any(|d| d.3);

    for (seg, (buf, dw, dh, _xyb)) in segs.iter().zip(decoded.iter()) {
        let dw = *dw as usize;
        let dh = *dh as usize;
        // A tile codestream may carry the full padded tile; the active rect must
        // fit inside what actually decoded.
        if dw < seg.active_w || dh < seg.active_h {
            bail!(
                "JXL DNG: segment decoded {dw}x{dh}, smaller than active {}x{}",
                seg.active_w,
                seg.active_h
            );
        }
        for r in 0..seg.active_h {
            let src = r * dw * cps;
            let dst = ((seg.row_start + r) * width + seg.col_start) * cps;
            out[dst..dst + seg.active_w * cps]
                .copy_from_slice(&buf[src..src + seg.active_w * cps]);
        }
    }
    Ok(any_xyb)
}

/// One JXL codestream to `(samples, width, height, xyb_encoded)`.
///
/// **Backend: pure-Rust jxl-oxide when the `jxl-pure` feature is on, libjxl
/// (own FFI, needs cmake) otherwise.** The pure path needs no C toolchain and
/// builds for wasm. It returns each sample as `round(v * (2^bits - 1))` for an
/// integer codestream, so the stored codes come back exactly; libjxl's UINT16
/// output is full-range instead (see [`decode_jxl`]'s caveat). A lossy (XYB)
/// stream has no integer codes and is scaled to the full 16-bit range.
/// The build's own JXL tile decoder: jxl-oxide when `jxl-pure` is on (wasm
/// safe), else libjxl when `jxl-codec` is (native), else none.
#[cfg(feature = "jxl-pure")]
const DEFAULT_JXL_SEGMENT: Option<JxlSegmentFn<'static>> = Some(&jxl_segment_oxide);
#[cfg(all(not(feature = "jxl-pure"), feature = "jxl-codec", not(target_arch = "wasm32")))]
const DEFAULT_JXL_SEGMENT: Option<JxlSegmentFn<'static>> = Some(&jxl_segment_libjxl);
#[cfg(not(any(feature = "jxl-pure", all(feature = "jxl-codec", not(target_arch = "wasm32")))))]
const DEFAULT_JXL_SEGMENT: Option<JxlSegmentFn<'static>> = None;

/// Whether one tile codestream is XYB-encoded (lossy), from its header alone:
/// no pixels are decoded. For a caller whose own decoder does not report it.
#[cfg(feature = "jxl-pure")]
pub fn jxl_codestream_is_xyb(bytes: &[u8]) -> Option<bool> {
    let mut img = jxl_oxide::JxlImage::builder().build_uninit();
    img.feed_bytes(&bytes[..bytes.len().min(1 << 16)]).ok()?;
    match img.try_init().ok()? {
        jxl_oxide::InitializeResult::Initialized(img) => Some(img.image_header().metadata.xyb_encoded),
        jxl_oxide::InitializeResult::NeedMoreData(_) => None,
    }
}

/// jxl-oxide (pure Rust, wasm safe) for one tile codestream.
#[cfg(feature = "jxl-pure")]
pub fn jxl_segment_oxide(bytes: &[u8], cps: usize) -> std::result::Result<(Vec<u16>, u32, u32, bool), String> {
    oxide_segment(bytes, cps).map_err(|e| e.to_string())
}

#[cfg(feature = "jxl-pure")]
fn oxide_segment(bytes: &[u8], cps: usize) -> Result<(Vec<u16>, u32, u32, bool)> {
    let mut image = jxl_oxide::JxlImage::builder()
        .read(std::io::Cursor::new(bytes))
        .map_err(|e| anyhow!("JXL DNG: segment parse: {e}"))?;
    let meta = &image.image_header().metadata;
    let xyb = meta.xyb_encoded;
    let target = meta.tone_mapping.intensity_target.max(1.0);
    let bits = meta.bit_depth.bits_per_sample().clamp(1, 16);
    // **jxl-oxide tone-maps (Rec. 2408) any stream whose intensity_target is
    // above 255 nits into an SDR target**, which squashes the highlights and
    // is not what libjxl's plain linear output does (toucan.lossy-d2.00-3ev
    // declares 2040 = 8 x 255: its sky decoded at a fraction of white and
    // rendered magenta). Asking for a PQ target skips the tone map (it only
    // runs for a non-HDR target); PQ is inverted below to get the linear
    // samples back.
    let hdr = xyb && target > 255.0;
    if hdr {
        if let jxl_oxide::image::color::ColourEncoding::Enum(mut e) =
            image.image_header().metadata.colour_encoding.clone()
        {
            e.tf = jxl_oxide::color::TransferFunction::Pq;
            image.request_color_encoding(e);
        }
    }
    // **jxl-oxide gamut-maps a wide-gamut XYB stream toward grey**: it decodes
    // XYB to linear sRGB and, for other primaries with perceptual intent,
    // runs GamutMap (saturation 0.3) on the out-of-[0,1] sRGB colours BEFORE
    // the matrix to the declared primaries, moving colours the declared space
    // holds. libjxl has no such step. adobe_01 (BT.2100): 2085 samples off by
    // > 256, up to 2877, near white and black, all channels (2026-10-08,
    // blizz tools/rs/jxltile; djxl == ImageMagick on every sample). So ask
    // for sRGB primaries and apply the matrix here, unclamped.
    let to_declared = if !hdr && xyb && cps == 3 { srgb_to_declared(&mut image) } else { None };
    let max = if hdr {
        // After the PQ inverse below, 1.0 is the stream's intensity_target,
        // which is libjxl's full scale: checked against ImageMagick's libjxl
        // 0.12 on toucan.lossy-d2.00-3ev (target 2040): median 2315 both,
        // and the clip pile [0.995, 1.0) / [1.0, 1.005) of the DNG white
        // 188,987 / 154,591 here against 188,663 / 154,911. (Until 2026-09-26
        // this also applied 255/target -- right for jxl-oxide's tone-mapped
        // output, whose 1.0 is 255 nits, but 8x dark after the PQ route: the
        // clipped sky sat at 0.125 of white, never clipped, and rendered
        // lavender, GN86.)
        65535.0
    } else if xyb {
        // No tone map at or below 255 nits; libjxl's linear output here is
        // scaled by 255 / intensity_target (1.0 at the 255 default).
        65535.0 * 255.0 / target
    } else {
        ((1u32 << bits) - 1) as f32
    };
    let render = image
        .render_frame(0)
        .map_err(|e| anyhow!("JXL DNG: segment decode: {e}"))?;
    let fb = render.image_all_channels();
    let (w, h, c) = (fb.width(), fb.height(), fb.channels());
    if c < cps {
        bail!("JXL DNG: codestream has {c} channel(s), the IFD wants {cps}");
    }
    let lin = |v: f32| if hdr { pq_eotf(v) * 10000.0 / target } else { v };
    let mut buf = Vec::with_capacity(w * h * cps);
    let px_out = |v: f32| (lin(v) * max + 0.5).clamp(0.0, 65535.0) as u16;
    for px in fb.buf().chunks_exact(c) {
        match &to_declared {
            Some(m) => buf.extend(m.map(|r| px_out(r[0] * px[0] + r[1] * px[1] + r[2] * px[2]))),
            None => buf.extend(px[..cps].iter().map(|&v| px_out(v))),
        }
    }
    Ok((buf, w as u32, h as u32, xyb))
}

/// For a linear, D65, non-sRGB-primaries enum colour encoding: requests
/// linear sRGB output (what jxl-oxide decodes XYB to, so no GamutMap runs)
/// and returns the linear sRGB -> declared primaries matrix (rows), derived
/// in f64 from the chromaticities. `None` leaves the request untouched.
// ponytail: D65 + linear only (every JXL DNG seen); another white point or
// transfer would still be gamut-mapped by jxl-oxide.
#[cfg(feature = "jxl-pure")]
fn srgb_to_declared(image: &mut jxl_oxide::JxlImage) -> Option<[[f32; 3]; 3]> {
    use jxl_oxide::color::{Primaries, TransferFunction, WhitePoint};
    let jxl_oxide::image::color::ColourEncoding::Enum(mut e) = image.image_header().metadata.colour_encoding.clone() else {
        return None;
    };
    if e.tf != TransferFunction::Linear || e.white_point != WhitePoint::D65 {
        return None;
    }
    let xy = |c: &jxl_oxide::color::Customxy| [c.x as f64 / 1e6, c.y as f64 / 1e6];
    let declared = match &e.primaries {
        Primaries::Srgb => return None,
        Primaries::Bt2100 => [[0.708, 0.292], [0.170, 0.797], [0.131, 0.046]],
        Primaries::P3 => [[0.680, 0.320], [0.265, 0.690], [0.150, 0.060]],
        Primaries::Custom { red, green, blue } => [xy(red), xy(green), xy(blue)],
    };
    let to_xyz = rgb_to_xyz([[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]]);
    let from_xyz = inv3(rgb_to_xyz(declared))?;
    e.primaries = Primaries::Srgb;
    image.request_color_encoding(e);
    let m = mul3(from_xyz, to_xyz);
    Some(m.map(|r| r.map(|v| v as f32)))
}

/// Linear RGB -> XYZ for primaries `p` (x, y) and white D65 (0.3127, 0.3290).
#[cfg(feature = "jxl-pure")]
fn rgb_to_xyz(p: [[f64; 2]; 3]) -> [[f64; 3]; 3] {
    let col = |[x, y]: [f64; 2]| [x / y, 1.0, (1.0 - x - y) / y];
    let (r, g, b) = (col(p[0]), col(p[1]), col(p[2]));
    let m = [[r[0], g[0], b[0]], [r[1], g[1], b[1]], [r[2], g[2], b[2]]];
    let w = col([0.3127, 0.3290]);
    let s = mul3v(inv3(m).expect("primaries are independent"), w);
    m.map(|row| [row[0] * s[0], row[1] * s[1], row[2] * s[2]])
}

#[cfg(feature = "jxl-pure")]
fn inv3(m: [[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let c = |i: usize, j: usize| {
        let (r0, r1, c0, c1) = ((i + 1) % 3, (i + 2) % 3, (j + 1) % 3, (j + 2) % 3);
        m[r0][c0] * m[r1][c1] - m[r0][c1] * m[r1][c0]
    };
    let det = m[0][0] * c(0, 0) + m[0][1] * c(0, 1) + m[0][2] * c(0, 2);
    (det.abs() > 1e-12).then(|| std::array::from_fn(|i| std::array::from_fn(|j| c(j, i) / det)))
}

#[cfg(feature = "jxl-pure")]
fn mul3(a: [[f64; 3]; 3], b: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    std::array::from_fn(|i| std::array::from_fn(|j| (0..3).map(|k| a[i][k] * b[k][j]).sum()))
}

#[cfg(feature = "jxl-pure")]
fn mul3v(a: [[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| (0..3).map(|k| a[i][k] * v[k]).sum())
}

/// SMPTE ST 2084 EOTF: PQ signal 0..1 -> luminance as a fraction of 10 000 nits.
#[cfg(feature = "jxl-pure")]
fn pq_eotf(e: f32) -> f32 {
    const M1: f64 = 2610.0 / 16384.0;
    const M2: f64 = 2523.0 / 4096.0 * 128.0;
    const C1: f64 = 3424.0 / 4096.0;
    const C2: f64 = 2413.0 / 4096.0 * 32.0;
    const C3: f64 = 2392.0 / 4096.0 * 32.0;
    let p = (e.max(0.0) as f64).powf(1.0 / M2);
    (((p - C1).max(0.0) / (C2 - C3 * p)).powf(1.0 / M1)) as f32
}

/// libjxl (own FFI) for one tile codestream; ~4x jxl-oxide on adobe_01
/// natively (1.3 s against 5.4 s, one thread, 2026-09-26).
#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
pub fn jxl_segment_libjxl(bytes: &[u8], cps: usize) -> std::result::Result<(Vec<u16>, u32, u32, bool), String> {
    use crate::jxl_casadecoder::{Channels, DecodeOptions, Decoder};
    let ch = if cps == 1 { Channels::Gray } else { Channels::Rgb };
    let mut dec = Decoder::new(DecodeOptions::default()).ok_or("JXL DNG: decoder init failed")?;
    let mut buf: Vec<u16> = Vec::new();
    let (dw, dh, meta) = dec
        .decode_into_dims::<u16>(bytes, ch, &mut buf)
        .map_err(|e| format!("JXL DNG: segment decode: {e}"))?;
    Ok((buf, dw, dh, meta.xyb_encoded))
}

fn decode_uncompressed(
    data: &[u8],
    raw: &RawIfd,
    width: usize,
    height: usize,
    le: bool,
    out: &mut [u16],
) -> Result<()> {
    let layout = uncompressed_layout(raw, width, height)?;
    // Whole-frame decode = decode every row-band directly into its slice of `out`.
    // Byte-identical to the previous inline loops (same per-band primitive).
    let band_stride = match layout {
        UncompressedLayout::Tiled { tl, .. } => tl,
        UncompressedLayout::Strips { rows_per_strip } => rows_per_strip,
    };
    let mut band_first = 0usize;
    while band_first < height {
        let rows = layout.band_rows(band_first, height);
        // checked_mul: band_first can wrap usize on wasm32 for hostile strip counts,
        // and the band slice keeps the destination in range.
        let base = band_first
            .checked_mul(width)
            .ok_or_else(|| anyhow!("uncompressed DNG: band dst overflow"))?;
        let dst = out
            .get_mut(base..base + rows * width)
            .ok_or_else(|| anyhow!("uncompressed DNG: band dst OOB"))?;
        decode_uncompressed_band(data, raw, layout, width, height, le, band_first, dst)?;
        band_first += band_stride;
    }
    Ok(())
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
    // Derive AsShotNeutral from AsShotWhiteXY (tag 0xC629) when tag 0xC628 is
    // absent — Pixel phone DNGs store only xy chromaticity coordinates. Also
    // resolves the render matrix in the same call: both need the same
    // CCT-weighted blend of ColorMatrix1/2 (see `resolve_from_white_xy`), so
    // computing them separately would either duplicate the blend or (the
    // previous version of this code) skip it and always take ColorMatrix2 —
    // wrong whenever the shot's white point sits closer to calibration
    // illuminant 1 (confirmed: LibRaw computes no AsShotWhiteXY-derived WB at
    // all for these files, so it wasn't available as a reference to catch
    // this against; verified instead against Adobe's own DNG SDK source).
    if state.as_shot_neutral.is_none() {
        if let Some(xy) = state.as_shot_white_xy {
            if let Some((neutral, render_matrix)) = resolve_from_white_xy(
                xy,
                state.calibration_illuminant_1,
                state.calibration_illuminant_2,
                state.color_matrix_1,
                state.color_matrix_2,
                state.forward_matrix_1,
                state.forward_matrix_2,
            ) {
                state.as_shot_neutral = Some(neutral);
                state.resolved_color_matrix = Some(render_matrix);
            }
        }
    }
    // Same gap, other direction: files with a real AsShotNeutral (so the WB
    // gray-point is already right) — the render matrix still needs the CCT
    // blend, just has to work backwards from the neutral to find which white
    // xy it implies first (`neutral_to_xy`, Adobe's iterative `NeutralToXY`)
    // before `find_xyz_to_camera` can weigh ColorMatrix1/2 (and, if both are
    // present, ForwardMatrix1/2) by it. Originally gated to "no ForwardMatrix
    // at all" (files where `choose_camera_to_srgb_matrix` had nothing better
    // than a blind ColorMatrix2 pick to fall back on: iPhone/ProRAW, GoPro
    // GPR). Generalized 2026-08-31 to the case that gate excluded — a real
    // ForwardMatrix1 *and* ForwardMatrix2 both present — since
    // `choose_camera_to_srgb_matrix`'s blind ForwardMatrix2 pick has the
    // exact same defect: no CCT weighting, just always "2". Verified this is
    // NOT theoretical for the one gallery file it touches (D80: CM1 vs CM2
    // differ by up to 0.166, FM1 vs FM2 similarly) with a dedicated
    // before/after comparison — see the gallery-colour handoff.
    if state.resolved_color_matrix.is_none() {
        if let (Some(neutral), Some(cm1), Some(cm2)) =
            (state.as_shot_neutral, state.color_matrix_1, state.color_matrix_2)
        {
            let t1 = state.calibration_illuminant_1.map(illuminant_to_temperature).unwrap_or(0.0);
            let t2 = state.calibration_illuminant_2.map(illuminant_to_temperature).unwrap_or(0.0);
            if t1 > 0.0 && t2 > 0.0 && (t1 - t2).abs() > 1e-6 {
                let (t_lo, t_hi, cm_lo, cm_hi, fm_lo, fm_hi) = if t1 <= t2 {
                    (t1, t2, cm1, cm2, state.forward_matrix_1, state.forward_matrix_2)
                } else {
                    (t2, t1, cm2, cm1, state.forward_matrix_2, state.forward_matrix_1)
                };
                if let Some((x, y)) = neutral_to_xy(neutral, t_lo, t_hi, cm_lo, cm_hi) {
                    let (color_matrix, forward_matrix) =
                        find_xyz_to_camera(x, y, t_lo, t_hi, cm_lo, cm_hi, fm_lo, fm_hi);
                    let render_matrix = match forward_matrix {
                        Some(fm) => Some(mul3x3(XYZ_D50_TO_SRGB, fm)),
                        None => invert3x3(color_matrix).map(|c2x| mul3x3(XYZ_D50_TO_SRGB, c2x)),
                    };
                    if let Some(m) = render_matrix {
                        state.resolved_color_matrix = Some(m);
                    }
                }
            }
        }
    }
    let raw = state.raw_ifd.take().ok_or_else(|| {
        if state.refused_compressions.is_empty() {
            anyhow!("no raw SubIFD found")
        } else {
            let named: Vec<String> = state.refused_compressions.iter().map(|c| c.to_string()).collect();
            anyhow!(
                "no supported raw SubIFD found (refused compression: {})",
                named.join(", ")
            )
        }
    })?;
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
    /// TIFF Predictor (tag 0x013D) — relevant to deflate (compression 8) strips.
    predictor: Option<u32>,
    /// DNG 1.7 JXLDistance (tag 0xCD49, FLOAT): 0.0 = lossless JPEG XL, > 0 =
    /// lossy. Absent on non-JXL files and on writers that omit it. (0xCD43 was
    /// once misread as this tag; it is ColumnInterleaveFactor.)
    jxl_distance: Option<f32>,
    /// DNG RowInterleaveFactor (0xC71F) / ColumnInterleaveFactor (0xCD43):
    /// the mosaic is stored as R×C stacked color-plane fields and must be
    /// de-interleaved after decompression (dng_sdk remainder rule).
    row_interleave: Option<u32>,
    column_interleave: Option<u32>,
    /// ActiveArea (0xC68D): [top, left, bottom, right].
    active_area: Option<[u32; 4]>,
    /// ProfileGainTableMap (0xCD2D) blob extent in the file: (offset, len).
    pgtm_range: Option<(usize, usize)>,
    /// LinearizationTable (0xC618): stored code → linear value.
    linearization: Vec<u16>,
    /// OpcodeList2 (0xC741) blob extent in the file: (offset, len).
    opcode_list2: Option<(usize, usize)>,
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
    /// CalibrationIlluminant1/2 (0xC65A/0xC65B): EXIF LightSource codes (the
    /// same enum as tag 0x9208) naming which light each color/forward matrix
    /// pair was calibrated under. Needed to weight the two matrices by the
    /// actual shot's correlated color temperature instead of always picking
    /// one — see `find_xyz_to_camera`.
    calibration_illuminant_1: Option<u16>,
    calibration_illuminant_2: Option<u16>,
    /// Camera→sRGB matrix already resolved by CCT-weighted interpolation, set
    /// only when `as_shot_neutral` was derived from `as_shot_white_xy` (see
    /// `load_dng`) — every other file keeps using `choose_camera_to_srgb_matrix`
    /// unchanged. `None` here means "fall back to that", not "no matrix".
    resolved_color_matrix: Option<[[f32; 3]; 3]>,
    /// ProfileToneCurve (0xC6FC): interleaved (x, y) pairs, empty when absent.
    profile_tone_curve: Vec<f32>,
    iso: Option<u32>,
    baseline_exposure: Option<f32>,
    make: String,
    model: String,
    orientation: Option<u16>,
    exif: crate::tiff::ExifGps,
    /// Accumulated noise-related DNG tags; converted to `RawNoiseMetadata` after the walk.
    noise_tags: NoiseTagAccumulator,
    /// Compression numbers of full-res image IFDs refused ONLY for their
    /// compression, so the no-raw-IFD error can say why.
    refused_compressions: Vec<u32>,
}

/// Read the first value of a signed-rational (SRATIONAL, type 10) tag as f32; falls back
/// to [`first_f32`] for unsigned types. Needed because BaselineExposure (0xC62A) is signed
/// and can be negative (e.g. −0.08 EV on a bright scene).
fn first_srational_f32(
    data: &[u8],
    dtype: u16,
    cnt: u32,
    val: u32,
    inline_pos: usize,
    le: bool,
) -> Option<f32> {
    if dtype != 10 {
        return first_f32(data, dtype, cnt, val, inline_pos, le);
    }
    if cnt == 0 {
        return None;
    }
    // SRATIONAL is 8 bytes → never inline (>4), value is at `val`.
    let p = val as usize;
    if p.checked_add(8).map_or(true, |e| e > data.len()) {
        return None;
    }
    let num = read_u32(data, p, le) as i32 as f32;
    let den = read_u32(data, p + 4, le) as i32 as f32;
    if den != 0.0 {
        Some(num / den)
    } else {
        None
    }
}

/// Compressions the decode paths below can actually read: 1 = uncompressed,
/// 7 = lossless JPEG, 8 = deflate, 52546 = JPEG XL (DNG 1.7; decode needs the
/// `jxl-codec` feature but the payload is still locatable without it).
fn compression_supported(c: u32) -> bool {
    matches!(c, 1 | 7 | 8 | 34892 | 52546)
}

fn raw_ifd_supported_candidate(ifd: &RawIfd, new_subfile_type: u32) -> bool {
    let has_storage = (!ifd.tile_offsets.is_empty() && !ifd.tile_byte_counts.is_empty())
        || (!ifd.strip_offsets.is_empty() && !ifd.strip_byte_counts.is_empty());
    let is_subsampled = (new_subfile_type & 1) != 0;
    // PARSERS-005 / ERR-011: an undecodable compression is excluded from the
    // candidate check so walk() does not select an IFD that will fail later.
    ifd.width > 0
        && ifd.height > 0
        && has_storage
        && !is_subsampled
        && compression_supported(ifd.compression)
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
                0x013D => {
                    ifd.predictor = first_u32(data, dtype, cnt, val, inline_pos, le);
                }
                0xC68D => {
                    let a = read_array_u32(data, dtype, cnt, val, inline_pos, le);
                    if a.len() == 4 {
                        ifd.active_area = Some([a[0], a[1], a[2], a[3]]);
                    }
                }
                0xC71F => {
                    ifd.row_interleave = first_u32(data, dtype, cnt, val, inline_pos, le);
                }
                0xCD43 => {
                    ifd.column_interleave = first_u32(data, dtype, cnt, val, inline_pos, le);
                }
                0xC618 => {
                    // LinearizationTable: SHORT array, stored code → linear.
                    if dtype == 3 && (2..=65536).contains(&cnt) {
                        let p = val as usize;
                        let need = cnt as usize * 2;
                        if p.checked_add(need).map_or(false, |e| e <= data.len()) {
                            ifd.linearization =
                                (0..cnt as usize).map(|i| read_u16(data, p + 2 * i, le)).collect();
                        }
                    }
                }
                0xCD2D => {
                    // ProfileGainTableMap: UNDEFINED blob, parsed after the walk.
                    if dtype == 7 && cnt > 4 {
                        ifd.pgtm_range = Some((val as usize, cnt as usize));
                    }
                }
                0xC741 => {
                    // OpcodeList2: UNDEFINED blob (always big-endian), read by the
                    // lossy-JPEG arm for its MapPolynomial.
                    if dtype == 7 && cnt > 4 {
                        ifd.opcode_list2 = Some((val as usize, cnt as usize));
                    }
                }
                0xCD49 => {
                    // JXLDistance (DNG 1.7, FLOAT).
                    ifd.jxl_distance = first_f32(data, dtype, cnt, val, inline_pos, le);
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
                0xC62A => {
                    // BaselineExposure (SRATIONAL, EV) — the DNG's own suggested exposure
                    // shift. Applied as the exposure baseline so Pixel night/low-light DNGs
                    // (which set +1.3..+1.6 EV) render at the intended brightness instead of
                    // dark/crushed. Absent tag → 0 EV (no shift).
                    state.baseline_exposure =
                        first_srational_f32(data, dtype, cnt, val, inline_pos, le);
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
                TAG_CALIBRATION_ILLUMINANT_1 => {
                    state.calibration_illuminant_1 =
                        first_u32(data, dtype, cnt, val, inline_pos, le).map(|v| v as u16);
                }
                TAG_CALIBRATION_ILLUMINANT_2 => {
                    state.calibration_illuminant_2 =
                        first_u32(data, dtype, cnt, val, inline_pos, le).map(|v| v as u16);
                }
                0xC6FC => {
                    // ProfileToneCurve: FLOAT array of interleaved (x, y) pairs.
                    if dtype == 11 && cnt >= 4 && cnt % 2 == 0 && cnt <= 4096 {
                        let p = val as usize;
                        let need = cnt as usize * 4;
                        if p.checked_add(need).map_or(false, |e| e <= data.len()) {
                            state.profile_tone_curve = (0..cnt as usize)
                                .map(|i| f32::from_bits(read_u32(data, p + 4 * i, le)))
                                .collect();
                        }
                    }
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
        } else if has_image_dims
            && ifd.width > 0
            && ifd.height > 0
            && (new_subfile_type & 1) == 0
            && !compression_supported(ifd.compression)
        {
            // A full-res image IFD refused only for its compression: remember the
            // number so "no raw SubIFD found" can name WHY (e.g. an all-lossy DNG).
            state.refused_compressions.push(ifd.compression);
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
        11 => {
            // FLOAT — e.g. JXLDistance (0xCD49, DNG 1.7).
            if p.checked_add(4).map_or(true, |e| e > data.len()) {
                return None;
            }
            Some(f32::from_bits(read_u32(data, p, le)))
        }
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

/// Camera→sRGB(linear) for a DNG WITHOUT a ForwardMatrix (Apple ProRAW),
/// applied to UNBALANCED camera RGB with NO separate white-balance multipliers.
/// `fused` is [`DngImage::color_matrix`] (= XYZ2SRGB · CM⁻¹), so CM⁻¹ recovers
/// as XYZ2SRGB⁻¹ · fused. The scene white in camera space is AsShotNeutral
/// (rebuilt from the green-normalized `wb_r`/`wb_b`); its XYZ is Bradford-adapted
/// to D50, so the camera neutral maps to sRGB (1,1,1) by construction. `None`
/// when the matrix or the neutral is degenerate.
pub fn color_matrix_bradford(fused: [[f32; 3]; 3], wb_r: f32, wb_b: f32) -> Option<[[f32; 3]; 3]> {
    const BRADFORD: [[f32; 3]; 3] = [
        [0.8951, 0.2664, -0.1614],
        [-0.7502, 1.7135, 0.0367],
        [0.0389, -0.0685, 1.0296],
    ];
    const D50_WHITE: [f32; 3] = [0.9642, 1.0, 0.8249];
    let mulv = |m: [[f32; 3]; 3], v: [f32; 3]| -> [f32; 3] {
        [0, 1, 2].map(|i| m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2])
    };
    let cam2xyz_scene = mul3x3(invert3x3(XYZ_D50_TO_SRGB)?, fused);
    let n = [1.0 / wb_r.max(1e-6), 1.0, 1.0 / wb_b.max(1e-6)];
    let white_scene = mulv(cam2xyz_scene, n);
    if white_scene.iter().any(|&v| !(v > 0.0)) {
        return None;
    }
    let cone_scene = mulv(BRADFORD, white_scene);
    let cone_d50 = mulv(BRADFORD, D50_WHITE);
    if cone_scene.iter().any(|&v| v.abs() < 1e-6) {
        return None;
    }
    let mut diag = [[0f32; 3]; 3];
    for i in 0..3 {
        diag[i][i] = cone_d50[i] / cone_scene[i];
    }
    let adapt = mul3x3(invert3x3(BRADFORD)?, mul3x3(diag, BRADFORD));
    Some(mul3x3(XYZ_D50_TO_SRGB, mul3x3(adapt, cam2xyz_scene)))
}

/// Gray-world gate for a Linear DNG's white balance: some writers (Adobe SDK
/// re-encodes) store already-balanced channels while still carrying a
/// non-unity AsShotNeutral, and multiplying red by 2.8 on balanced data
/// renders pink. `true` = applying `wb_r`/`wb_b` moves the channel means of
/// the interleaved RGB `rgb` toward equal, so the WB should be applied.
pub fn wb_moves_toward_grey<T: Copy + Into<f64>>(rgb: &[T], wb_r: f32, wb_b: f32) -> bool {
    let mut mean = [0f64; 3];
    for p in rgb.chunks_exact(3) {
        for c in 0..3 {
            mean[c] += p[c].into();
        }
    }
    let spread = |m: [f64; 3]| -> f64 {
        let hi = m.iter().cloned().fold(f64::MIN, f64::max);
        let lo = m.iter().cloned().fold(f64::MAX, f64::min).max(1e-9);
        hi / lo
    };
    spread([mean[0] * wb_r as f64, mean[1], mean[2] * wb_b as f64]) < spread(mean)
}

/// EXIF LightSource code (tag 0x9208's enum, reused by DNG's
/// CalibrationIlluminant1/2) → correlated color temperature in Kelvin.
/// Adobe's `dng_camera_profile::IlluminantToTemperature` table verbatim
/// (`dng_camera_profile.cpp`, github.com/aizvorski/dng_sdk — a public mirror
/// of the real DNG SDK). 0.0 for any code with no defined temperature
/// (Unknown, Other, or a value this table doesn't cover) — callers treat
/// that as "can't interpolate", same as Adobe.
fn illuminant_to_temperature(light: u16) -> f64 {
    match light {
        3 | 17 => 2850.0,                  // Tungsten, StandardLightA
        24 => 3200.0,                       // ISOStudioTungsten
        23 => 5000.0,                       // D50
        20 | 1 | 9 | 4 | 18 => 5500.0,       // D55, Daylight, FineWeather, Flash, StandardLightB
        21 | 19 | 10 => 6500.0,             // D65, StandardLightC, CloudyWeather
        22 | 11 => 7500.0,                  // D75, Shade
        12 => (5700.0 + 7100.0) * 0.5,       // DaylightFluorescent
        13 => (4600.0 + 5500.0) * 0.5,       // DayWhiteFluorescent
        14 | 2 => (3800.0 + 4500.0) * 0.5,   // CoolWhiteFluorescent, Fluorescent
        15 => (3250.0 + 3800.0) * 0.5,       // WhiteFluorescent
        16 => (2600.0 + 3250.0) * 0.5,       // WarmWhiteFluorescent
        _ => 0.0,
    }
}

/// Wyszecki & Stiles, "Color Science" 2nd ed. p.228 — the isotherm table
/// Adobe's `dng_temperature.cpp` uses for xy→CCT (Robertson's method).
/// `(reciprocal megakelvin, u, v, isotherm slope)`.
const ROBERTSON_TABLE: [(f64, f64, f64, f64); 31] = [
    (0.0, 0.18006, 0.26352, -0.24341),
    (10.0, 0.18066, 0.26589, -0.25479),
    (20.0, 0.18133, 0.26846, -0.26876),
    (30.0, 0.18208, 0.27119, -0.28539),
    (40.0, 0.18293, 0.27407, -0.30470),
    (50.0, 0.18388, 0.27709, -0.32675),
    (60.0, 0.18494, 0.28021, -0.35156),
    (70.0, 0.18611, 0.28342, -0.37915),
    (80.0, 0.18740, 0.28668, -0.40955),
    (90.0, 0.18880, 0.28997, -0.44278),
    (100.0, 0.19032, 0.29326, -0.47888),
    (125.0, 0.19462, 0.30141, -0.58204),
    (150.0, 0.19962, 0.30921, -0.70471),
    (175.0, 0.20525, 0.31647, -0.84901),
    (200.0, 0.21142, 0.32312, -1.0182),
    (225.0, 0.21807, 0.32909, -1.2168),
    (250.0, 0.22511, 0.33439, -1.4512),
    (275.0, 0.23247, 0.33904, -1.7298),
    (300.0, 0.24010, 0.34308, -2.0637),
    (325.0, 0.24702, 0.34655, -2.4681),
    (350.0, 0.25591, 0.34951, -2.9641),
    (375.0, 0.26400, 0.35200, -3.5814),
    (400.0, 0.27218, 0.35407, -4.3633),
    (425.0, 0.28039, 0.35577, -5.3762),
    (450.0, 0.28863, 0.35714, -6.7262),
    (475.0, 0.29685, 0.35823, -8.5955),
    (500.0, 0.30505, 0.35907, -11.324),
    (525.0, 0.31320, 0.35968, -15.628),
    (550.0, 0.32129, 0.36011, -23.325),
    (575.0, 0.32931, 0.36038, -40.770),
    (600.0, 0.33724, 0.36051, -116.45),
];

/// CIE xy → correlated color temperature (Kelvin), Robertson's method. Port
/// of `dng_temperature::Set_xy_coord` (`dng_temperature.cpp`,
/// github.com/aizvorski/dng_sdk) — same table, same algorithm, minus the
/// `tint` output DNG's white-balance slider needs and `FindXYZtoCamera`
/// doesn't.
fn xy_to_cct(x: f64, y: f64) -> f64 {
    let u = 2.0 * x / (1.5 - x + 6.0 * y);
    let v = 3.0 * y / (1.5 - x + 6.0 * y);

    let mut last_dt = 0.0;
    for index in 1..31usize {
        let (_, tu, tv, slope) = ROBERTSON_TABLE[index];
        let len = (1.0 + slope * slope).sqrt();
        let (du, dv) = (1.0 / len, slope / len);
        let (uu, vv) = (u - tu, v - tv);
        let dt = -uu * dv + vv * du;
        if dt <= 0.0 || index == 30 {
            let dt = if dt > 0.0 { 0.0 } else { -dt };
            let f = if index == 1 { 0.0 } else { dt / (last_dt + dt) };
            let (r0, r1) = (ROBERTSON_TABLE[index - 1].0, ROBERTSON_TABLE[index].0);
            return 1.0e6 / (r0 * f + r1 * (1.0 - f));
        }
        last_dt = dt;
    }
    // Unreachable: index == 30 always satisfies the loop's own exit test.
    1.0e6 / ROBERTSON_TABLE[30].0
}

/// Blend ColorMatrix1/2 (and ForwardMatrix1/2, if both present) by the
/// correlated color temperature of `white` — port of
/// `dng_color_spec::FindXYZtoCamera` (`dng_color_spec.cpp`,
/// github.com/aizvorski/dng_sdk), minus the reduction-matrix and
/// camera-calibration outputs this pipeline doesn't use. `t1`/`t2` must
/// already be ordered `t1 <= t2` with `cm1`/`fm1` the matrices calibrated at
/// `t1` — the caller (`resolve_from_white_xy`) does that swap, matching
/// Adobe's `dng_color_spec` constructor.
fn find_xyz_to_camera(
    white_x: f64,
    white_y: f64,
    t1: f64,
    t2: f64,
    cm1: [[f32; 3]; 3],
    cm2: [[f32; 3]; 3],
    fm1: Option<[[f32; 3]; 3]>,
    fm2: Option<[[f32; 3]; 3]>,
) -> ([[f32; 3]; 3], Option<[[f32; 3]; 3]>) {
    let temp = xy_to_cct(white_x, white_y);

    let g = if temp <= t1 {
        1.0
    } else if temp >= t2 {
        0.0
    } else {
        let inv_t = 1.0 / temp;
        (inv_t - 1.0 / t2) / (1.0 / t1 - 1.0 / t2)
    };

    let blend3x3 = |a: [[f32; 3]; 3], b: [[f32; 3]; 3]| -> [[f32; 3]; 3] {
        let (gw, hw) = (g as f32, (1.0 - g) as f32);
        let mut out = [[0f32; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                out[i][j] = gw * a[i][j] + hw * b[i][j];
            }
        }
        out
    };

    let color_matrix = if g >= 1.0 {
        cm1
    } else if g <= 0.0 {
        cm2
    } else {
        blend3x3(cm1, cm2)
    };

    let forward_matrix = if let (Some(a), Some(b)) = (fm1, fm2) {
        if g >= 1.0 {
            Some(a)
        } else if g <= 0.0 {
            Some(b)
        } else {
            Some(blend3x3(a, b))
        }
    } else {
        fm1.or(fm2)
    };

    (color_matrix, forward_matrix)
}

/// Derive AsShotNeutral and the camera→sRGB render matrix together from
/// AsShotWhiteXY (CIE xy) — the branch Pixel/Android DNGs need, since they
/// carry AsShotWhiteXY instead of AsShotNeutral. Mirrors Adobe's
/// `dng_color_spec::SetWhiteXY` for the neutral (`colorMatrix *
/// XYZ_white`, `colorMatrix` now CCT-blended instead of always
/// ColorMatrix2) and reuses this crate's existing forward/color-matrix →
/// sRGB composition for the render matrix. Returns `None` when there isn't
/// enough calibration data to produce a plausible (all-positive) neutral.
///
/// Not implemented: Adobe additionally runs `NormalizeForwardMatrix` (scales
/// the forward matrix so all-ones camera RGB maps exactly to the D50 PCS
/// white) before using it. Skipped — it corrects small rounding drift in a
/// well-formed tag, not a wrong answer, and every fixture this was built
/// against already has a forward matrix that round-trips cleanly without it.
fn resolve_from_white_xy(
    xy: [f32; 2],
    illuminant_1: Option<u16>,
    illuminant_2: Option<u16>,
    cm1: Option<[[f32; 3]; 3]>,
    cm2: Option<[[f32; 3]; 3]>,
    fm1: Option<[[f32; 3]; 3]>,
    fm2: Option<[[f32; 3]; 3]>,
) -> Option<([f32; 3], [[f32; 3]; 3])> {
    let (x, y) = (xy[0] as f64, xy[1] as f64);
    if y <= 1e-6 {
        return None;
    }
    let xyz = xy_to_xyz(x, y);

    let (color_matrix, forward_matrix) = match (cm1, cm2) {
        (Some(a), Some(b)) => {
            let t1 = illuminant_1.map(illuminant_to_temperature).unwrap_or(0.0);
            let t2 = illuminant_2.map(illuminant_to_temperature).unwrap_or(0.0);
            // Adobe's own fallback (`dng_color_spec` constructor): if either
            // temperature is missing or they collide, there's nothing to
            // interpolate between — use ColorMatrix1 (its own "calibration 2
            // becomes calibration 1" collapse ends at the same place).
            if t1 <= 0.0 || t2 <= 0.0 || (t1 - t2).abs() < 1e-6 {
                (a, fm1.or(fm2))
            } else if t1 <= t2 {
                find_xyz_to_camera(x, y, t1, t2, a, b, fm1, fm2)
            } else {
                find_xyz_to_camera(x, y, t2, t1, b, a, fm2, fm1)
            }
        }
        (Some(a), None) | (None, Some(a)) => (a, fm1.or(fm2)),
        (None, None) => return None,
    };

    let r = color_matrix[0][0] * xyz[0] + color_matrix[0][1] * xyz[1] + color_matrix[0][2] * xyz[2];
    let g = color_matrix[1][0] * xyz[0] + color_matrix[1][1] * xyz[1] + color_matrix[1][2] * xyz[2];
    let b = color_matrix[2][0] * xyz[0] + color_matrix[2][1] * xyz[1] + color_matrix[2][2] * xyz[2];
    if !(r > 0.0 && g > 0.0 && b > 0.0) {
        return None;
    }

    let render_matrix = match forward_matrix {
        Some(fm) => mul3x3(XYZ_D50_TO_SRGB, fm),
        None => {
            let camera_to_xyz = invert3x3(color_matrix)?;
            mul3x3(XYZ_D50_TO_SRGB, camera_to_xyz)
        }
    };

    Some(([r, g, b], render_matrix))
}

/// CIE xy → XYZ (Y = 1 reference white) — the same `[x/y, 1, (1-x-y)/y]`
/// `resolve_from_white_xy` computes inline; factored out because
/// `neutral_to_xy`'s round-trip test needs the forward direction too.
fn xy_to_xyz(x: f64, y: f64) -> [f32; 3] {
    [(x / y) as f32, 1.0, ((1.0 - x - y) / y) as f32]
}

/// CIE XYZ → xy. Inverse of the above. `None` when X+Y+Z is degenerate (an
/// all-zero neutral, or a singular color matrix from a pathological
/// calibration).
fn xyz_to_xy(xyz: [f32; 3]) -> Option<(f64, f64)> {
    let (x, y, z) = (xyz[0] as f64, xyz[1] as f64, xyz[2] as f64);
    let sum = x + y + z;
    if sum.abs() < 1e-9 {
        return None;
    }
    Some((x / sum, y / sum))
}

/// Given a real, tag-provided `AsShotNeutral` (camera-space) and a
/// temperature-ordered ColorMatrix pair (`t_lo <= t_hi`, `cm_lo` calibrated
/// at `t_lo`), find which CIE xy white point produced it — the direction
/// `resolve_from_white_xy` runs, inverted. Port of
/// `dng_color_spec::NeutralToXY` (`dng_color_spec.cpp`,
/// github.com/aizvorski/dng_sdk): the matrix that converts the camera-space
/// neutral back to XYZ depends on the CCT-blended ColorMatrix, which itself
/// depends on the very white point being solved for — a fixed point, seeded
/// at D50 and refined until it stops moving (or Adobe's own 30-pass cap,
/// then average the last two estimates rather than loop forever).
fn neutral_to_xy(
    neutral: [f32; 3],
    t_lo: f64,
    t_hi: f64,
    cm_lo: [[f32; 3]; 3],
    cm_hi: [[f32; 3]; 3],
) -> Option<(f64, f64)> {
    const D50_XY: (f64, f64) = (0.34567, 0.35850);
    let mut last = D50_XY;
    for pass in 0..30 {
        let (color_matrix, _) = find_xyz_to_camera(last.0, last.1, t_lo, t_hi, cm_lo, cm_hi, None, None);
        let camera_to_xyz = invert3x3(color_matrix)?;
        let xyz = [
            camera_to_xyz[0][0] * neutral[0]
                + camera_to_xyz[0][1] * neutral[1]
                + camera_to_xyz[0][2] * neutral[2],
            camera_to_xyz[1][0] * neutral[0]
                + camera_to_xyz[1][1] * neutral[1]
                + camera_to_xyz[1][2] * neutral[2],
            camera_to_xyz[2][0] * neutral[0]
                + camera_to_xyz[2][1] * neutral[1]
                + camera_to_xyz[2][2] * neutral[2],
        ];
        let mut next = xyz_to_xy(xyz)?;
        if (next.0 - last.0).abs() + (next.1 - last.1).abs() < 1e-7 {
            return Some(next);
        }
        if pass == 29 {
            next = ((last.0 + next.0) * 0.5, (last.1 + next.1) * 0.5);
        }
        last = next;
    }
    Some(last)
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

    /// The linear sRGB -> BT.2100 matrix derived from chromaticities matches
    /// ITU-R BT.2087's published one.
    #[cfg(feature = "jxl-pure")]
    #[test]
    fn srgb_to_bt2100_matrix_matches_bt2087() {
        let s = rgb_to_xyz([[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]]);
        let t = rgb_to_xyz([[0.708, 0.292], [0.170, 0.797], [0.131, 0.046]]);
        let m = mul3(inv3(t).unwrap(), s);
        let want = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]];
        for i in 0..3 {
            for j in 0..3 {
                assert!((m[i][j] - want[i][j]).abs() < 1e-4, "m[{i}][{j}] = {} want {}", m[i][j], want[i][j]);
            }
        }
    }

    /// Minimal little-endian TIFF builder for synthesized DNG tests: one IFD0
    /// with the given entries (tag, type, count, value-or-offset), then payload
    /// bytes appended by the caller at known offsets. Entries must be sorted by
    /// tag (TIFF requirement the walker may rely on).
    fn build_tiff_le(entries: &[(u16, u16, u32, u32)], payload: &[u8]) -> Vec<u8> {
        let mut d = vec![0x49, 0x49, 0x2A, 0x00, 8, 0, 0, 0]; // header, IFD0 @ 8
        d.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for &(tag, typ, cnt, val) in entries {
            d.extend_from_slice(&tag.to_le_bytes());
            d.extend_from_slice(&typ.to_le_bytes());
            d.extend_from_slice(&cnt.to_le_bytes());
            d.extend_from_slice(&val.to_le_bytes());
        }
        d.extend_from_slice(&0u32.to_le_bytes()); // next-IFD = none
        d.extend_from_slice(payload);
        d
    }

    /// Header + IFD size for `n` entries — the offset where payload lands.
    fn payload_off(n: usize) -> u32 {
        (8 + 2 + n * 12 + 4) as u32
    }

    /// A 4x4 single-sample 16-bit DNG with the given compression and one strip
    /// whose payload is `strip` — enough shape for decode + range tests.
    fn synth_dng_1strip(compression: u16, strip: &[u8]) -> (Vec<u8>, u32) {
        let n = 8;
        let off = payload_off(n);
        let entries = [
            (0x00FE_u16, 4_u16, 1_u32, 0_u32),          // NewSubfileType: full-res
            (0x0100, 4, 1, 4),                          // width
            (0x0101, 4, 1, 4),                          // height
            (0x0102, 3, 1, 16),                         // bits per sample
            (0x0103, 3, 1, compression as u32),         // compression
            (0x0111, 4, 1, off),                        // strip offset
            (0x0116, 4, 1, 4),                          // rows per strip
            (0x0117, 4, 1, strip.len() as u32),         // strip byte count
        ];
        (build_tiff_le(&entries, strip), off)
    }

    /// JPEG XL DNG (compression 52546): the strip payload is a JXL codestream
    /// from our own encoder; decode must hand back the identical u16 samples.
    /// Gray (Bayer-shaped) and RGB (Linear-DNG-shaped) both covered.
    #[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]
    #[test]
    fn jxl_dng_round_trips_gray_and_rgb() {
        use crate::jxl_casaencoder::{EncodeOptions, Encoder, Frame};
        for cps in [1usize, 3] {
            let samples: Vec<u16> = (0..16 * cps as u16).map(|v| v.wrapping_mul(2731)).collect();
            let mut enc = Encoder::new(EncodeOptions::lossless()).expect("encoder");
            let frame = if cps == 1 {
                Frame::gray(&samples, 4, 4)
            } else {
                Frame::rgb(&samples, 4, 4)
            };
            let jxl = enc.encode(&frame).expect("encode");
            let n = 9;
            let off = payload_off(n);
            let entries = [
                (0x00FE_u16, 4_u16, 1_u32, 0_u32),
                (0x0100, 4, 1, 4),
                (0x0101, 4, 1, 4),
                (0x0102, 3, 1, 16),
                (0x0103, 3, 1, 52546),
                (0x0111, 4, 1, off),
                (0x0115, 3, 1, cps as u32), // SamplesPerPixel
                (0x0116, 4, 1, 4),
                (0x0117, 4, 1, jxl.len() as u32),
            ];
            let dng = build_tiff_le(&entries, &jxl);
            let img = decode_bytes(&dng).expect("jxl dng decode");
            assert_eq!(img.samples_per_pixel, cps);
            assert_eq!(img.raw, samples, "cps={cps}");
            let r = payload_ranges(&dng).expect("ranges");
            assert_eq!(r, vec![(off as usize, off as usize + jxl.len())]);
        }
    }

    /// Hasselblad L2D-20c: StripByteCounts understates a strip whose W*H*2 bytes
    /// end exactly at EOF -> the whole plane is read; one byte past EOF more and
    /// the understated count is not trusted (refused, as before).
    #[test]
    fn understated_strip_ending_at_eof_reads_whole_plane() {
        let samples: Vec<u16> = (0..16u16).map(|v| v.wrapping_mul(2731)).collect();
        let strip: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let (mut dng, _) = synth_dng_1strip(1, &strip);
        let n = 8;
        let bc_at = 8 + 2 + 7 * 12 + 8; // entry 7 (0x0117) value field
        assert_eq!(dng[bc_at - 8..bc_at - 6], 0x0117u16.to_le_bytes());
        dng[bc_at..bc_at + 4].copy_from_slice(&24u32.to_le_bytes());
        assert_eq!(dng.len(), payload_off(n) as usize + 32);
        assert_eq!(decode_bytes(&dng).expect("understated strip at EOF").raw, samples);
        dng.push(0);
        assert!(decode_bytes(&dng).is_err());
    }

    /// The dng_sdk remainder rule, worked by hand: field f holds
    /// ceil((N−f)/F) entries, stored consecutively, entry `within` of field f
    /// lands at final `within*F + f`.
    #[test]
    fn interleave_field_map_matches_the_worked_examples() {
        assert_eq!(interleave_field_map(5, 2), vec![0, 2, 4, 1, 3]);
        assert_eq!(interleave_field_map(6, 3), vec![0, 3, 1, 4, 2, 5]);
        assert_eq!(interleave_field_map(4, 1), vec![0, 1, 2, 3]);
        assert_eq!(interleave_field_map(7, 4), vec![0, 4, 1, 5, 2, 6, 3]);
        // Bijection at awkward sizes.
        for (n, f) in [(1usize, 2usize), (2, 2), (9, 2), (10, 4), (11, 3)] {
            let mut seen = vec![false; n];
            for v in interleave_field_map(n, f) {
                assert!(!seen[v as usize], "N={n} F={f}: {v} hit twice");
                seen[v as usize] = true;
            }
        }
    }

    /// A 4x4 uncompressed DNG whose strip is stored 2x2 FIELD-interleaved
    /// (RowInterleaveFactor/ColumnInterleaveFactor = 2, the DNG 1.7 JXL-CFA
    /// layout): decode must hand back the de-interleaved mosaic.
    #[test]
    fn interleaved_dng_is_deinterleaved_on_decode() {
        let final_plane: Vec<u16> = (0u16..16).map(|v| v * 100).collect();
        // Store it field-interleaved: stored[s] lands at final[rowmap x colmap].
        let (rm, cm) = (interleave_field_map(4, 2), interleave_field_map(4, 2));
        let mut stored = vec![0u16; 16];
        for y in 0..4 {
            for x in 0..4 {
                stored[y * 4 + x] = final_plane[rm[y] as usize * 4 + cm[x] as usize];
            }
        }
        let mut strip = Vec::new();
        for v in &stored {
            strip.extend_from_slice(&v.to_le_bytes());
        }
        let n = 10;
        let off = payload_off(n);
        let entries = [
            (0x00FE_u16, 4_u16, 1_u32, 0_u32),
            (0x0100, 4, 1, 4),
            (0x0101, 4, 1, 4),
            (0x0102, 3, 1, 16),
            (0x0103, 3, 1, 1), // uncompressed
            (0x0111, 4, 1, off),
            (0x0116, 4, 1, 4),
            (0x0117, 4, 1, strip.len() as u32),
            (0xC71F, 3, 1, 2), // RowInterleaveFactor
            (0xCD43, 3, 1, 2), // ColumnInterleaveFactor
        ];
        let dng = build_tiff_le(&entries, &strip);
        let img = decode_bytes(&dng).expect("decode");
        assert_eq!(img.raw, final_plane, "decode must de-interleave the fields");
        assert_eq!(img.jxl_lossy, None, "not a JXL stream");
    }

    #[test]
    fn deflate_dng_round_trips_known_samples() {
        let samples: Vec<u16> = (0u16..16).map(|v| v * 1000).collect();
        let mut raw_bytes = Vec::new();
        for v in &samples {
            raw_bytes.extend_from_slice(&v.to_le_bytes());
        }
        let strip = miniz_oxide::deflate::compress_to_vec_zlib(&raw_bytes, 6);
        let (dng, off) = synth_dng_1strip(8, &strip);
        let img = decode_bytes(&dng).expect("deflate decode");
        assert_eq!(img.width, 4);
        assert_eq!(img.height, 4);
        assert_eq!(img.samples_per_pixel, 1);
        assert_eq!(img.raw, samples);
        // payload_ranges: exactly the strip
        let r = payload_ranges(&dng).expect("ranges");
        assert_eq!(r, vec![(off as usize, off as usize + strip.len())]);
    }

    /// The tile executor owns the tile loop: tasks run in any order give the
    /// serial plane, and a band it never runs is an error, not zeros.
    #[test]
    fn tile_executor_is_order_free_and_a_skip_is_an_error() {
        let samples: Vec<u16> = (0u16..16).map(|v| v * 1000 + 7).collect();
        // Four deflate strips of one row each: four bands.
        let strips: Vec<Vec<u8>> = samples
            .chunks(4)
            .map(|row| {
                let b: Vec<u8> = row.iter().flat_map(|v| v.to_le_bytes()).collect();
                miniz_oxide::deflate::compress_to_vec_zlib(&b, 6)
            })
            .collect();
        let base = payload_off(8);
        let (mut payload, mut counts, mut at) = (Vec::new(), Vec::new(), base + 32);
        for s in &strips {
            payload.extend_from_slice(&at.to_le_bytes());
            counts.extend_from_slice(&(s.len() as u32).to_le_bytes());
            at += s.len() as u32;
        }
        payload.extend_from_slice(&counts);
        for s in &strips {
            payload.extend_from_slice(s);
        }
        let entries = [
            (0x00FE_u16, 4_u16, 1_u32, 0_u32),
            (0x0100, 4, 1, 4),
            (0x0101, 4, 1, 4),
            (0x0102, 3, 1, 16),
            (0x0103, 3, 1, 8),         // deflate
            (0x0111, 4, 4, base),      // strip offsets -> array
            (0x0116, 4, 1, 1),         // rows per strip
            (0x0117, 4, 4, base + 16), // strip byte counts -> array
        ];
        let dng = build_tiff_le(&entries, &payload);
        assert_eq!(decode_bytes(&dng).expect("default").raw, samples);
        let reverse = |n: usize, task: &(dyn Fn(usize) + Sync)| (0..n).rev().for_each(task);
        let img = decode_bytes_with(&dng, None, Some(&reverse)).expect("reverse order");
        assert_eq!(img.raw, samples);
        let skip_last = |n: usize, task: &(dyn Fn(usize) + Sync)| (0..n - 1).for_each(task);
        let e = decode_bytes_with(&dng, None, Some(&skip_last)).err().expect("skip").to_string();
        assert!(e.contains("skipped"), "got: {e}");
    }

    #[test]
    fn deflate_dng_truncated_stream_errors() {
        let raw_bytes = vec![0u8; 32];
        let mut strip = miniz_oxide::deflate::compress_to_vec_zlib(&raw_bytes, 6);
        strip.truncate(strip.len() / 2);
        let (dng, _) = synth_dng_1strip(8, &strip);
        let e = decode_bytes(&dng).err().expect("expected error").to_string();
        assert!(e.contains("deflate DNG"), "got: {e}");
    }

    #[test]
    fn payload_ranges_covers_uncompressed_strips() {
        let mut raw_bytes = Vec::new();
        for v in 0u16..16 {
            raw_bytes.extend_from_slice(&(v * 3).to_le_bytes());
        }
        let (dng, off) = synth_dng_1strip(1, &raw_bytes);
        // Tag arithmetic only — comp 1 decodes AND locates.
        let img = decode_bytes(&dng).expect("uncompressed decode");
        assert_eq!(img.raw.len(), 16);
        let r = payload_ranges(&dng).expect("ranges");
        assert_eq!(r, vec![(off as usize, off as usize + raw_bytes.len())]);
        // The pinned comp-7-only sibling refuses by design.
        assert!(ljpeg_tile_ranges(&dng)
            .unwrap_err()
            .to_string()
            .contains("not LJPEG-compressed"));
    }

    #[test]
    fn lossy_dng_decodes_through_the_hook() {
        // The hook is process-wide (first set wins): every test that sets one sets this one.
        set_lossy_jpeg_decoder(|b| Ok((4, 4, 1, b.iter().map(|v| v.wrapping_mul(16)).collect())));
        let strip: Vec<u8> = (0..16).collect();
        let (dng, off) = synth_dng_1strip(34892, &strip);
        let img = decode_bytes(&dng).expect("lossy DNG decodes");
        assert!(img.lossy_jpeg);
        assert_eq!(img.raw, (0..16u16).map(|v| v * 16).collect::<Vec<_>>());
        assert_eq!(payload_ranges(&dng).unwrap(), vec![(off as usize, off as usize + strip.len())]);
    }

    #[test]
    fn map_polynomial_parsed_from_opcode_list() {
        // One MapPolynomial (id 8) on plane 1 of a 10x20 area, y = 0.25 + 0.5x, then an unknown opcode.
        let mut b = Vec::new();
        for v in [2u32, 8, 0x0103_0000, 0, 36 + 16, 0, 0, 10, 20, 1, 1, 1, 1, 1] {
            b.extend(v.to_be_bytes());
        }
        b.extend(0.25f64.to_be_bytes());
        b.extend(0.5f64.to_be_bytes());
        for v in [99u32, 1, 0, 4, 7] {
            b.extend(v.to_be_bytes());
        }
        let m = map_polynomials(&b);
        assert_eq!(m.len(), 1);
        assert_eq!((m[0].bottom, m[0].right, m[0].plane, m[0].planes), (10, 20, 1, 1));
        assert_eq!(m[0].coef, vec![0.25, 0.5]);
    }

    #[test]
    fn unknown_compression_refused_by_number() {
        let (dng, _) = synth_dng_1strip(9, &[0u8; 64]);
        let e = decode_bytes(&dng).err().expect("expected error").to_string();
        assert!(e.contains('9'), "got: {e}");
    }

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
    fn baseline_exposure_reads_signed_rational() {
        // SRATIONAL (type 10): 8 bytes at `val`, num/den as i32. Positive: +1.61 EV.
        let mut data = vec![0u8; 32];
        let num: i32 = 161;
        let den: i32 = 100;
        data[8..12].copy_from_slice(&num.to_le_bytes());
        data[12..16].copy_from_slice(&den.to_le_bytes());
        let v = first_srational_f32(&data, 10, 1, 8, 0, true).unwrap();
        assert!((v - 1.61).abs() < 1e-4, "got {v}");
        // Negative baseline (bright scene, e.g. -0.08 EV).
        let neg: i32 = -8;
        let d100: i32 = 100;
        data[8..12].copy_from_slice(&neg.to_le_bytes());
        data[12..16].copy_from_slice(&d100.to_le_bytes());
        let v = first_srational_f32(&data, 10, 1, 8, 0, true).unwrap();
        assert!((v + 0.08).abs() < 1e-4, "got {v}");
        // Zero denominator → None (rejected, falls back to 0 baseline downstream).
        data[12..16].copy_from_slice(&0i32.to_le_bytes());
        assert!(first_srational_f32(&data, 10, 1, 8, 0, true).is_none());
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
    fn illuminant_to_temperature_matches_adobe_table() {
        assert_eq!(illuminant_to_temperature(17), 2850.0); // StandardLightA
        assert_eq!(illuminant_to_temperature(3), 2850.0); // Tungsten
        assert_eq!(illuminant_to_temperature(21), 6500.0); // D65
        assert_eq!(illuminant_to_temperature(23), 5000.0); // D50
        assert_eq!(illuminant_to_temperature(0), 0.0); // Unknown
        assert_eq!(illuminant_to_temperature(255), 0.0); // Other
    }

    #[test]
    fn xy_to_cct_matches_standard_illuminant_definitions() {
        // Nominal CIE xy for each illuminant; Robertson's method should land
        // within a few Kelvin of the defining temperature.
        let d65 = xy_to_cct(0.31271, 0.32902);
        assert!((d65 - 6504.0).abs() < 5.0, "D65: {d65}");

        let std_a = xy_to_cct(0.44757, 0.40745);
        assert!((std_a - 2856.0).abs() < 5.0, "StandardLightA: {std_a}");

        let d50 = xy_to_cct(0.34567, 0.35850);
        assert!((d50 - 5003.0).abs() < 5.0, "D50: {d50}");
    }

    #[test]
    fn find_xyz_to_camera_picks_cm1_at_or_below_t1() {
        let cm1 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let cm2 = [[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]];
        // t1 set far above any CCT a real xy in this table can reach, so
        // whatever xy_to_cct computes for Standard Light A's own xy (nominally
        // 2850K, but the Robertson fit puts it at ~2856K — the two are close
        // but not bit-identical) is guaranteed to clamp to g=1.0 here.
        let (m, _) = find_xyz_to_camera(0.44757, 0.40745, 1_000_000.0, 1_000_001.0, cm1, cm2, None, None);
        assert_matrix_close(m, cm1);
    }

    #[test]
    fn find_xyz_to_camera_picks_cm2_at_or_above_t2() {
        let cm1 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let cm2 = [[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]];
        // t1/t2 set far below any CCT a real xy in this table can reach (the
        // table's own lowest is ~1667K), so D65's computed CCT clamps to g=0.0.
        let (m, _) = find_xyz_to_camera(0.31271, 0.32902, 100.0, 101.0, cm1, cm2, None, None);
        assert_matrix_close(m, cm2);
    }

    #[test]
    fn find_xyz_to_camera_blends_strictly_between_the_two_illuminants() {
        let cm1 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let cm2 = [[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]];
        // D50 sits between StandardLightA (2850K) and D65 (6500K).
        let (m, _) = find_xyz_to_camera(0.34567, 0.35850, 2850.0, 6500.0, cm1, cm2, None, None);
        assert!(
            m[0][0] > 1.0 && m[0][0] < 2.0,
            "expected a blend strictly between 1.0 and 2.0, got {}",
            m[0][0]
        );
    }

    #[test]
    fn find_xyz_to_camera_forward_matrix_passthrough_when_only_one_present() {
        let cm1 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let cm2 = [[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]];
        let fwd = [[0.5, 0.0, 0.0], [0.0, 0.5, 0.0], [0.0, 0.0, 0.5]];
        let (_, forward) =
            find_xyz_to_camera(0.34567, 0.35850, 2850.0, 6500.0, cm1, cm2, Some(fwd), None);
        assert_matrix_close(forward.expect("forward matrix"), fwd);
    }

    #[test]
    fn resolve_from_white_xy_derives_a_plausible_neutral_and_matrix() {
        let cm1 = [[1.2, -0.1, 0.0], [0.0, 1.1, 0.0], [0.0, 0.0, 1.3]];
        let cm2 = [[0.9, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -0.1, 1.0]];
        // D50-ish white point, between the two calibration illuminants.
        let result = resolve_from_white_xy(
            [0.34567, 0.35850],
            Some(17), // StandardLightA
            Some(21), // D65
            Some(cm1),
            Some(cm2),
            None,
            None,
        );
        let (neutral, matrix) = result.expect("plausible neutral");
        assert!(neutral.iter().all(|&v| v > 0.0), "neutral: {neutral:?}");
        // The render matrix is XYZ_D50_TO_SRGB composed with an inverted,
        // CCT-blended color matrix — just check it produced *something*
        // (not a degenerate all-zero matrix from a failed inversion).
        assert!(matrix.iter().flatten().any(|&v| v.abs() > 1e-3), "{matrix:?}");
    }

    #[test]
    fn resolve_from_white_xy_none_when_y_is_degenerate() {
        let cm1 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        assert!(resolve_from_white_xy([0.3, 0.0], Some(17), Some(21), Some(cm1), None, None, None)
            .is_none());
    }

    #[test]
    fn neutral_to_xy_inverts_resolve_from_white_xy() {
        // Real-shaped matrices (row sums near 1, small off-diagonal terms) —
        // an identity/diagonal pair makes FindXYZtoCamera's blend degenerate
        // in a way that doesn't exercise the interesting cross terms.
        let cm1 = [[1.2, -0.1, 0.0], [0.0, 1.1, 0.0], [0.0, 0.0, 1.3]];
        let cm2 = [[0.9, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -0.1, 1.0]];
        let (t1, t2) = (2850.0, 6500.0);
        // A white point strictly between the two calibrations — the case
        // that actually needs interpolation, not just clamping to one side.
        let (want_x, want_y) = (0.36, 0.34);

        let (color_matrix, _) = find_xyz_to_camera(want_x, want_y, t1, t2, cm1, cm2, None, None);
        let xyz = xy_to_xyz(want_x, want_y);
        let neutral = [
            color_matrix[0][0] * xyz[0] + color_matrix[0][1] * xyz[1] + color_matrix[0][2] * xyz[2],
            color_matrix[1][0] * xyz[0] + color_matrix[1][1] * xyz[1] + color_matrix[1][2] * xyz[2],
            color_matrix[2][0] * xyz[0] + color_matrix[2][1] * xyz[1] + color_matrix[2][2] * xyz[2],
        ];

        let (got_x, got_y) = neutral_to_xy(neutral, t1, t2, cm1, cm2).expect("converges");
        assert!((got_x - want_x).abs() < 1e-4, "x: got {got_x}, want {want_x}");
        assert!((got_y - want_y).abs() < 1e-4, "y: got {got_y}, want {want_y}");
    }

    #[test]
    fn neutral_to_xy_none_on_an_all_zero_neutral() {
        let cm1 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let cm2 = [[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]];
        assert!(neutral_to_xy([0.0, 0.0, 0.0], 2850.0, 6500.0, cm1, cm2).is_none());
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
            let base: Vec<u16> = (0..(1920 * 1440))
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
    // This path demosaics a Bayer mosaic; a Linear DNG (cps=3, e.g. ProRAW) is
    // already demosaiced by the camera — decode it via `decode_bytes` instead.
    let cps = raw.samples_per_pixel.max(1) as usize;
    if cps != 1 {
        bail!("DNG: demosaic path needs a Bayer mosaic (SamplesPerPixel={cps}); use decode_bytes");
    }
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
    // The mosaic reaching the demosaic is unbalanced, so MHC's cross-channel gradient
    // terms must be scaled by the WB ratios it will later be corrected with. See `MhcGains`.
    let band_gains = demosaic::MhcGains::from_wb(wb_r, wb_g, wb_b);
    let black = raw.black_level.unwrap_or(0);
    let white = raw.white_level.unwrap_or(16383);
    let color_matrix = state.resolved_color_matrix.or_else(|| {
        choose_camera_to_srgb_matrix(
            state.forward_matrix_1,
            state.forward_matrix_2,
            state.color_matrix_1,
            state.color_matrix_2,
        )
    });
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
        let rgb = demosaic::demosaic_bayer_mhc_gains(
            &img.raw,
            img.width,
            img.height,
            cfa_phase(img.cfa),
            demosaic::MhcGains::from_wb(img.wb_r, img.wb_g, img.wb_b),
        )
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
                demosaic::demosaic_bayer_mhc_gains(
            &img.raw,
            img.width,
            img.height,
            cfa_phase(img.cfa),
            demosaic::MhcGains::from_wb(img.wb_r, img.wb_g, img.wb_b),
        )
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
            demosaic::demosaic_rggb_mhc_band_gains(
                &c_ctx,
                width,
                c_h,
                c_halo,
                carried_g0,
                0,
                c_halo,
                band_gains,
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
            demosaic::demosaic_rggb_mhc_band_gains(
                &ctx,
                width,
                ctx_h,
                halo,
                row_start,
                0,
                safe,
                band_gains,
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
