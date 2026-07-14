// src/denoise_session.rs — Tiled learned-denoise session API (Task 8).
//
// A `DenoiseSession` owns everything needed to run a *learned* (model-based)
// denoiser tile-by-tile from JavaScript without ever exposing a raw pointer:
//
//   * the decoded Bayer mosaic (+ per-plane black/white),
//   * the resolved noise model (for per-pixel sigma maps),
//   * the MHC-demosaiced RGB16 baseline,
//   * a committed-tile bitmap and the assembled output RGB16.
//
// The JS worker pulls a packed `[20, 320, 320]` input tile (`take_input_tile`),
// runs the model to produce `[12, 256, 256]` RGB residuals, and pushes them back
// (`commit_output_tile`). Once every tile is committed, `finish_with_options`
// runs the existing look/tone pipeline over the stitched, denoised RGB16.
// `finish_classical` is the model-free fallback (Task 5 classical denoise).
//
// # Tile geometry (fixed)
//   input tile  : 320 × 320 pixels
//   halo        : 32 pixels each side
//   committed core: 256 × 256 pixels ( = 320 − 2·32 )
//
// For a W × H image the core grid is `ceil(W/256) × ceil(H/256)`. Tile
// `(tx, ty)`'s core lands at image `(tx·256, ty·256)`; its 320×320 input region
// spans image cols `tx·256−32 .. tx·256+288` and rows `ty·256−32 .. ty·256+288`,
// clamped by mirror reflection at the borders.
//
// Only the geometry/packing/commit *core* is unit-tested natively; the
// wasm-bindgen surface is a thin wrapper compiled for wasm32.

use raw_pipeline::denoise::dng_tags::RawNoiseMetadata;
use raw_pipeline::denoise::types::NoiseModel;

// ─── Fixed tile constants ───────────────────────────────────────────────────────

pub(crate) const TILE_IN: usize = 320; // packed input side
pub(crate) const HALO: usize = 32; // halo on each side
pub(crate) const CORE: usize = TILE_IN - 2 * HALO; // 256 committed core side
const IN_CHANNELS: usize = 20; // 4 mosaic + 4 sigma + 12 MHC
const OUT_CHANNELS: usize = 12; // 4 positions × 3 RGB residuals

/// Number of core tiles along a dimension of length `n` (`ceil(n / CORE)`).
pub(crate) fn tiles_along(n: usize) -> usize {
    if n == 0 {
        0
    } else {
        (n + CORE - 1) / CORE
    }
}

/// Mirror-reflect an out-of-range coordinate back into `[0, n)`.
///
/// Symmetric padding without edge repetition (…c b a | a b c … | c b a…), which
/// matches the estimation module's `[-ε, 1]` reflection contract and keeps model
/// inputs continuous across the border. `n` must be ≥ 1.
pub(crate) fn reflect(coord: isize, n: usize) -> usize {
    debug_assert!(n >= 1);
    if n == 1 {
        return 0;
    }
    let n = n as isize;
    // Period of the reflection is 2*(n-1) for whole-sample symmetric padding.
    let period = 2 * (n - 1);
    let mut c = coord % period;
    if c < 0 {
        c += period;
    }
    if c >= n {
        c = period - c;
    }
    c as usize
}

/// CFA plane index (0=R, 1=G1, 2=G2, 3=B) for an *absolute* image pixel, given the
/// image's CFA phase (`cfa_index`: 0=RGGB,1=GRBG,2=GBRG,3=BGGR).
///
/// The phase fixes which colour sits at even/even. The four planes are addressed
/// by the pixel's (row parity, col parity):
///   RGGB → (0,0)=R (0,1)=G1 (1,0)=G2 (1,1)=B, and the other phases are the same
///   grid rotated. We resolve via the phase's 2×2 colour map.
pub(crate) fn plane_at(row: usize, col: usize, cfa_index: usize) -> usize {
    // colour map for the 2×2 block, indexed [row_parity][col_parity], value = plane.
    // Plane numbering: 0=R, 1=G1, 2=G2, 3=B.  G1 is the green sharing R's row,
    // G2 the green sharing B's row.
    let map: [[usize; 2]; 2] = match cfa_index {
        0 => [[0, 1], [2, 3]], // RGGB
        1 => [[1, 0], [3, 2]], // GRBG
        2 => [[2, 3], [0, 1]], // GBRG
        _ => [[3, 2], [1, 0]], // BGGR
    };
    map[row & 1][col & 1]
}

/// Per-session state shared by native tests and the wasm wrapper.
///
/// Model-independent: holds decoded inputs + committed output, exposes packing
/// and commit as pure methods. `finish_*` (which need the wasm-only pipeline)
/// live on the wasm wrapper.
pub(crate) struct SessionCore {
    pub(crate) raw: Vec<u16>,
    pub(crate) width: usize,
    pub(crate) height: usize,
    pub(crate) cfa_index: usize,
    /// Per-plane black/white (from noise metadata) for mosaic normalisation.
    pub(crate) black: [f32; 4],
    pub(crate) white: [f32; 4],
    /// Resolved noise model for per-pixel sigma maps. `None` → sigma channels 0.
    pub(crate) model: Option<NoiseModel>,
    /// MHC-demosaiced RGB16 baseline (interleaved RGB, width×height×3).
    pub(crate) mhc: Vec<u16>,
    /// Committed-tile bitmap, row-major `tiles_y × tiles_x`.
    pub(crate) committed: Vec<bool>,
    pub(crate) tiles_x: usize,
    pub(crate) tiles_y: usize,
    /// Assembled denoised RGB16 (interleaved, width×height×3). Starts as MHC copy
    /// so uncommitted regions (if finish is forced) degrade to baseline, but
    /// finish_with_options requires full commit.
    pub(crate) assembled: Vec<u16>,
}

impl SessionCore {
    pub(crate) fn new(
        raw: Vec<u16>,
        width: usize,
        height: usize,
        cfa_index: usize,
        metadata: &RawNoiseMetadata,
        model: Option<NoiseModel>,
        mhc: Vec<u16>,
    ) -> Self {
        let tiles_x = tiles_along(width);
        let tiles_y = tiles_along(height);
        let assembled = mhc.clone();
        SessionCore {
            raw,
            width,
            height,
            cfa_index,
            black: metadata.black,
            white: metadata.white,
            model,
            mhc,
            committed: vec![false; tiles_x * tiles_y],
            tiles_x,
            tiles_y,
            assembled,
        }
    }

    #[inline]
    fn n_tiles(&self) -> usize {
        self.tiles_x * self.tiles_y
    }

    /// Sample the mosaic at image `(row, col)` with mirror reflection, returning
    /// the normalised value and its CFA plane.
    #[inline]
    fn sample_mosaic_norm(&self, row: isize, col: isize) -> (f32, usize) {
        let r = reflect(row, self.height);
        let c = reflect(col, self.width);
        let plane = plane_at(r, c, self.cfa_index);
        let raw = self.raw[r * self.width + c] as f32;
        let span = (self.white[plane] - self.black[plane]).max(1.0);
        let v = ((raw - self.black[plane]) / span).clamp(-0.05, 1.25);
        (v, plane)
    }

    /// Sample the MHC RGB16 baseline at image `(row, col)` with mirror reflection,
    /// returning normalised R,G,B in `[0, 1]`.
    #[inline]
    fn sample_mhc_norm(&self, row: isize, col: isize) -> [f32; 3] {
        let r = reflect(row, self.height);
        let c = reflect(col, self.width);
        let base = (r * self.width + c) * 3;
        [
            self.mhc[base] as f32 / 65535.0,
            self.mhc[base + 1] as f32 / 65535.0,
            self.mhc[base + 2] as f32 / 65535.0,
        ]
    }

    /// Pack the `[20, 320, 320]` CHW input tensor for core tile `(tx, ty)`.
    pub(crate) fn pack_input_tile(&self, tx: usize, ty: usize) -> Result<Vec<f32>, String> {
        if tx >= self.tiles_x || ty >= self.tiles_y {
            return Err(format!(
                "tile ({tx},{ty}) out of range ({}×{})",
                self.tiles_x, self.tiles_y
            ));
        }
        let plane_size = TILE_IN * TILE_IN;
        let mut out = vec![0.0f32; IN_CHANNELS * plane_size];

        // Image-space origin of the 320×320 window (top-left, including halo).
        let ox = tx as isize * CORE as isize - HALO as isize;
        let oy = ty as isize * CORE as isize - HALO as isize;

        for r in 0..TILE_IN {
            let img_row = oy + r as isize;
            for l in 0..TILE_IN {
                let img_col = ox + l as isize;
                let px = r * TILE_IN + l;

                // Channels 0..3: normalised RGGB mosaic (only the pixel's own plane
                // carries its value; the other three planes are 0 at this site).
                let (mv, plane) = self.sample_mosaic_norm(img_row, img_col);
                out[plane * plane_size + px] = mv;

                // Channels 4..7: per-pixel sigma maps sqrt(S·max(x,0)+O) per plane.
                for p in 0..4 {
                    let sigma = match &self.model {
                        Some(m) => {
                            let c = m.planes[p];
                            (c.shot * mv.max(0.0) + c.read).max(0.0).sqrt()
                        }
                        None => 0.0,
                    };
                    out[(4 + p) * plane_size + px] = sigma;
                }

                // Channels 8..19: packed 2×2 MHC RGB baseline. Position within the
                // block is (row parity, col parity); each position writes RGB.
                let rgb = self.sample_mhc_norm(img_row, img_col);
                let pos = 2 * (r & 1) + (l & 1); // 0..3
                let base_ch = 8 + pos * 3;
                out[base_ch * plane_size + px] = rgb[0];
                out[(base_ch + 1) * plane_size + px] = rgb[1];
                out[(base_ch + 2) * plane_size + px] = rgb[2];
            }
        }
        Ok(out)
    }

    /// Commit a `[12, 256, 256]` residual tensor for core tile `(tx, ty)`.
    ///
    /// Each residual is clamped to `[-0.25, 0.25]`, added to the *core-region*
    /// packed MHC baseline, cropped of the 32-pixel halo, and quantised to
    /// normalised RGB16. Overlapping cores are never averaged — each core owns a
    /// disjoint image region.
    pub(crate) fn commit_core(
        &mut self,
        tx: usize,
        ty: usize,
        residuals: &[f32],
    ) -> Result<(), String> {
        if tx >= self.tiles_x || ty >= self.tiles_y {
            return Err(format!(
                "commit ({tx},{ty}) out of range ({}×{})",
                self.tiles_x, self.tiles_y
            ));
        }
        let idx = ty * self.tiles_x + tx;
        if self.committed[idx] {
            return Err(format!("tile ({tx},{ty}) already committed"));
        }
        let core_px = CORE * CORE;
        if residuals.len() != OUT_CHANNELS * core_px {
            return Err(format!(
                "residuals len {} != {}×{}×{}",
                residuals.len(),
                OUT_CHANNELS,
                CORE,
                CORE
            ));
        }

        let ox = tx * CORE;
        let oy = ty * CORE;
        for rr in 0..CORE {
            let img_row = oy + rr;
            if img_row >= self.height {
                break;
            }
            for cc in 0..CORE {
                let img_col = ox + cc;
                if img_col >= self.width {
                    break;
                }
                let core_i = rr * CORE + cc;
                // 2×2 packed position for this pixel, measured in *image* space to
                // match pack_input_tile. CORE=256 is even, so core-local parity ==
                // image parity — the residual channel for a position lines up with
                // the MHC baseline channel packed at the same position on input.
                let pos = 2 * (img_row & 1) + (img_col & 1);
                let base = (img_row * self.width + img_col) * 3;
                for ch in 0..3 {
                    // Residual channel (position pos, colour ch); add to packed MHC.
                    let res_ch = (pos * 3 + ch) * core_px + core_i;
                    let residual = residuals[res_ch].clamp(-0.25, 0.25);
                    let mhc_norm = self.mhc[base + ch] as f32 / 65535.0;
                    let v = (mhc_norm + residual).clamp(0.0, 1.0);
                    self.assembled[base + ch] = (v * 65535.0 + 0.5) as u16;
                }
            }
        }
        self.committed[idx] = true;
        Ok(())
    }

    #[inline]
    pub(crate) fn is_committed(&self, tx: usize, ty: usize) -> bool {
        if tx >= self.tiles_x || ty >= self.tiles_y {
            return false;
        }
        self.committed[ty * self.tiles_x + tx]
    }

    #[inline]
    pub(crate) fn all_committed(&self) -> bool {
        self.n_tiles() > 0 && self.committed.iter().all(|&b| b)
    }
}

// ─── Wasm-bindgen session surface ────────────────────────────────────────────────
//
// `DenoiseSession` wraps a `SessionCore` plus the decode-time metadata shell
// (`DngDecoded` fields minus the pixel buffers) so the finish paths can drive the
// existing look/tone pipeline. No raw pointer is exposed to JS: tiles cross the
// boundary as owned `Vec<f32>` tensors.

use crate::{DngDecoded, ProcessResult, RawProcessOptions};
use raw_pipeline::denoise::{estimate_noise, iso_fallback_model, resolve_noise_model};
use raw_pipeline::pipeline::PipelineParams;
use wasm_bindgen::prelude::*;

/// The decode-time metadata of a `DngDecoded` minus its pixel buffers. Held by a
/// session so a finish path can rebuild a full `DngDecoded` around the selected
/// (denoised) RGB16 without a second decode.
pub(crate) struct DngShell {
    params: PipelineParams,
    color_matrix_flat: [f32; 9],
    decode_ms: f64,
    demosaic_ms: f64,
    orientation: u16,
    make: String,
    model: String,
    iso: u32,
    baseline_exposure: f32,
    datetime: String,
    gps_lat: Option<f64>,
    gps_lon: Option<f64>,
    gps_alt: Option<f64>,
    noise_metadata: RawNoiseMetadata,
    baseline_exposure: f32,
    wb_from_camera: bool,
}

impl DngShell {
    /// Split a decoded DNG into (shell, raw mosaic, MHC rgb16, metadata, cfa, w, h).
    #[allow(clippy::type_complexity)]
    fn split(
        d: DngDecoded,
    ) -> (
        DngShell,
        Vec<u16>,
        Vec<u16>,
        RawNoiseMetadata,
        usize,
        usize,
        usize,
    ) {
        let shell = DngShell {
            params: d.params.clone(),
            color_matrix_flat: d.color_matrix_flat,
            decode_ms: d.decode_ms,
            demosaic_ms: d.demosaic_ms,
            orientation: d.orientation,
            make: d.make,
            model: d.model,
            iso: d.iso,
            baseline_exposure: d.baseline_exposure,
            datetime: d.datetime,
            gps_lat: d.gps_lat,
            gps_lon: d.gps_lon,
            gps_alt: d.gps_alt,
            noise_metadata: d.noise_metadata.clone(),
            baseline_exposure: d.baseline_exposure,
            wb_from_camera: d.wb_from_camera,
        };
        (
            shell,
            d.raw_mosaic,
            d.rgb16,
            d.noise_metadata,
            d.cfa_index,
            d.aw,
            d.ah,
        )
    }

    /// Rebuild a full `DngDecoded` around the selected RGB16 for a finish path.
    /// Raw mosaic and preview caches are empty — finish always recomputes previews
    /// from the denoised RGB.
    fn rebuild(&self, rgb16: Vec<u16>, core: &SessionCore) -> DngDecoded {
        DngDecoded {
            rgb16,
            aw: core.width,
            ah: core.height,
            params: self.params.clone(),
            color_matrix_flat: self.color_matrix_flat,
            decode_ms: self.decode_ms,
            demosaic_ms: self.demosaic_ms,
            orientation: self.orientation,
            make: self.make.clone(),
            model: self.model.clone(),
            iso: self.iso,
            baseline_exposure: self.baseline_exposure,
            datetime: self.datetime.clone(),
            gps_lat: self.gps_lat,
            gps_lon: self.gps_lon,
            gps_alt: self.gps_alt,
            lb_packed: Vec::new(),
            lb_w: 0,
            lb_h: 0,
            thumb_packed: Vec::new(),
            thumb_w: 0,
            thumb_h: 0,
            fast_preview: false,
            raw_mosaic: Vec::new(),
            cfa_index: core.cfa_index,
            noise_metadata: self.noise_metadata.clone(),
            baseline_exposure: self.baseline_exposure,
            wb_from_camera: self.wb_from_camera,
        }
    }
}

/// Resolve the best available noise model for a session (embedded → blind → ISO
/// fallback). Used only to populate the per-pixel sigma channels of input tiles.
fn resolve_session_model(
    raw: &[u16],
    width: usize,
    height: usize,
    cfa_index: usize,
    metadata: &RawNoiseMetadata,
    iso: Option<u32>,
) -> Option<NoiseModel> {
    let blind = estimate_noise(raw, width, height, cfa_index, metadata);
    resolve_noise_model(metadata.embedded_noise, None, blind)
        .or_else(|| iso.map(iso_fallback_model))
}

/// Tiled learned-denoise session. Owns decoded inputs and the assembled output;
/// exposes packed input tiles and residual commits to a JS model runner.
#[wasm_bindgen]
pub struct DenoiseSession {
    core: SessionCore,
    shell: DngShell,
    output_flags: u32,
}

impl DenoiseSession {
    /// Construct from a fully-decoded `DngDecoded` shell (which carries the raw
    /// mosaic, MHC RGB16 baseline, dims, CFA phase, and all metadata).
    pub(crate) fn from_decoded(decoded: DngDecoded, output_flags: u32) -> DenoiseSession {
        let iso = if decoded.iso > 0 { Some(decoded.iso) } else { None };
        let model = resolve_session_model(
            &decoded.raw_mosaic,
            decoded.aw,
            decoded.ah,
            decoded.cfa_index,
            &decoded.noise_metadata,
            iso,
        );
        let (shell, raw, mhc, metadata, cfa_index, aw, ah) = DngShell::split(decoded);
        let core = SessionCore::new(raw, aw, ah, cfa_index, &metadata, model, mhc);
        DenoiseSession {
            core,
            shell,
            output_flags,
        }
    }
}

#[wasm_bindgen]
impl DenoiseSession {
    pub fn tiles_x(&self) -> u32 {
        self.core.tiles_x as u32
    }
    pub fn tiles_y(&self) -> u32 {
        self.core.tiles_y as u32
    }
    pub fn width(&self) -> u32 {
        self.core.width as u32
    }
    pub fn height(&self) -> u32 {
        self.core.height as u32
    }

    pub fn is_tile_committed(&self, tile_x: u32, tile_y: u32) -> bool {
        self.core.is_committed(tile_x as usize, tile_y as usize)
    }

    pub fn all_tiles_committed(&self) -> bool {
        self.core.all_committed()
    }

    /// Returns the packed CHW `[20, 320, 320]` input tensor for `(tile_x, tile_y)`.
    pub fn take_input_tile(&self, tile_x: u32, tile_y: u32) -> Result<Vec<f32>, JsError> {
        self.core
            .pack_input_tile(tile_x as usize, tile_y as usize)
            .map_err(|e| JsError::new(&e))
    }

    /// Commits a `[12, 256, 256]` residual tensor for `(tile_x, tile_y)`.
    pub fn commit_output_tile(
        &mut self,
        tile_x: u32,
        tile_y: u32,
        residuals: Vec<f32>,
    ) -> Result<(), JsError> {
        self.core
            .commit_core(tile_x as usize, tile_y as usize, &residuals)
            .map_err(|e| JsError::new(&e))
    }

    /// Finish via the learned model output. Every tile must be committed. The
    /// assembled (already normalised) RGB16 becomes the pipeline input, so black
    /// and white are pinned to 0/65535 before the look/tone path runs.
    pub fn finish_with_options(&mut self, options: JsValue) -> Result<ProcessResult, JsError> {
        if !self.core.all_committed() {
            return Err(JsError::new(
                "finish_with_options: not all tiles committed",
            ));
        }
        let opts = RawProcessOptions::from_js(&options)?;
        let assembled = std::mem::take(&mut self.core.assembled);
        let mut decoded = self.shell.rebuild(assembled, &self.core);
        // Assembled RGB is already black-subtracted + white-normalised.
        decoded.params.black = 0;
        decoded.params.white = 65535;
        crate::process_dng_impl(decoded, self.output_flags, &opts.look)
    }

    /// Finish via the classical (model-free) denoiser from Task 5. No tile commits
    /// are required — the raw mosaic and MHC baseline drive the classical path.
    pub fn finish_classical(&mut self, options: JsValue) -> Result<ProcessResult, JsError> {
        let opts = RawProcessOptions::from_js(&options)?;
        let iso = if self.shell.iso > 0 {
            Some(self.shell.iso)
        } else {
            None
        };
        let mhc = self.core.mhc.clone();
        let (tel, denoised_rgb16) = crate::run_denoise_on_rgb16(
            &self.core.raw,
            mhc,
            self.core.width,
            self.core.height,
            self.core.cfa_index,
            &self.shell.noise_metadata,
            iso,
            &opts.denoise,
        );
        // Mirror `process_dng_with_options` exactly: feed the (possibly un-applied)
        // denoise output straight into the pipeline without altering black/white,
        // so a not-applied decision reproduces the baseline byte-for-byte.
        let decoded = self.shell.rebuild(denoised_rgb16, &self.core);
        let mut result = crate::process_dng_impl(decoded, self.output_flags, &opts.look)?;
        crate::apply_denoise_telemetry(&mut result, tel, &opts.denoise);
        Ok(result)
    }
}

// ─── Native unit tests (geometry / packing / commit / seams) ─────────────────────
//
// These run under `cargo test --lib denoise_session` and never touch wasm-bindgen.
#[cfg(test)]
mod tests {
    use super::*;
    use raw_pipeline::denoise::types::{NoiseCoefficients, NoiseSource};

    fn zero_model() -> NoiseModel {
        NoiseModel {
            planes: [NoiseCoefficients { shot: 0.0, read: 0.0 }; 4],
            structured_sigma: [0.0; 4],
            confidence: 1.0,
            source: NoiseSource::BlindFit,
        }
    }

    fn meta(black: f32, white: f32) -> RawNoiseMetadata {
        RawNoiseMetadata {
            black: [black; 4],
            white: [white; 4],
            ..RawNoiseMetadata::default()
        }
    }

    /// Build a session over a synthetic mosaic and MHC baseline.
    fn make_session(w: usize, h: usize, cfa: usize, model: Option<NoiseModel>) -> SessionCore {
        let mut raw = vec![0u16; w * h];
        for (i, v) in raw.iter_mut().enumerate() {
            *v = ((i * 7 + 13) % 4096) as u16;
        }
        let mut mhc = vec![0u16; w * h * 3];
        for (i, v) in mhc.iter_mut().enumerate() {
            *v = ((i * 11 + 5) % 65536) as u16;
        }
        SessionCore::new(raw, w, h, cfa, &meta(256.0, 4095.0), model, mhc)
    }

    // ── Tile geometry ─────────────────────────────────────────────────────────

    #[test]
    fn tiles_along_ceils() {
        assert_eq!(tiles_along(0), 0);
        assert_eq!(tiles_along(1), 1);
        assert_eq!(tiles_along(256), 1);
        assert_eq!(tiles_along(257), 2);
        assert_eq!(tiles_along(512), 2);
        assert_eq!(tiles_along(513), 3);
    }

    #[test]
    fn odd_dimensions_tile_count() {
        // 300×513 → ceil(300/256)=2, ceil(513/256)=3
        let s = make_session(300, 513, 0, None);
        assert_eq!(s.tiles_x, 2);
        assert_eq!(s.tiles_y, 3);
        assert_eq!(s.committed.len(), 6);
    }

    // ── Reflection ────────────────────────────────────────────────────────────

    #[test]
    fn reflect_symmetric() {
        // n = 5 → indices reflect …3,2,1|0,1,2,3,4|3,2,1…
        assert_eq!(reflect(-1, 5), 1);
        assert_eq!(reflect(-2, 5), 2);
        assert_eq!(reflect(0, 5), 0);
        assert_eq!(reflect(4, 5), 4);
        assert_eq!(reflect(5, 5), 3);
        assert_eq!(reflect(6, 5), 2);
    }

    #[test]
    fn reflect_single_column() {
        assert_eq!(reflect(-3, 1), 0);
        assert_eq!(reflect(7, 1), 0);
    }

    // ── CFA phases ────────────────────────────────────────────────────────────

    #[test]
    fn all_four_cfa_phases_map_distinct_planes() {
        // For each phase, the 2×2 block must map to the four planes {0,1,2,3}.
        for cfa in 0..4 {
            let mut seen = [false; 4];
            for r in 0..2 {
                for c in 0..2 {
                    seen[plane_at(r, c, cfa)] = true;
                }
            }
            assert!(seen.iter().all(|&b| b), "cfa {cfa} did not cover all planes");
        }
    }

    #[test]
    fn rggb_phase_positions() {
        assert_eq!(plane_at(0, 0, 0), 0); // R
        assert_eq!(plane_at(0, 1, 0), 1); // G1
        assert_eq!(plane_at(1, 0, 0), 2); // G2
        assert_eq!(plane_at(1, 1, 0), 3); // B
    }

    // ── Input tile shape / channel layout ─────────────────────────────────────

    #[test]
    fn input_tile_has_exact_shape() {
        let s = make_session(300, 300, 0, Some(zero_model()));
        let t = s.pack_input_tile(0, 0).unwrap();
        assert_eq!(t.len(), 20 * 320 * 320);
    }

    #[test]
    fn input_tile_out_of_range_errors() {
        let s = make_session(300, 300, 0, None);
        assert!(s.pack_input_tile(5, 0).is_err());
        assert!(s.pack_input_tile(0, 5).is_err());
    }

    #[test]
    fn sigma_channels_zero_without_model() {
        let s = make_session(300, 300, 0, None);
        let t = s.pack_input_tile(0, 0).unwrap();
        let plane = 320 * 320;
        for p in 0..4 {
            let ch = 4 + p;
            let slice = &t[ch * plane..(ch + 1) * plane];
            assert!(slice.iter().all(|&v| v == 0.0));
        }
    }

    #[test]
    fn sigma_channels_positive_with_read_noise() {
        let mut m = zero_model();
        for c in &mut m.planes {
            c.read = 0.04;
        }
        let s = make_session(300, 300, 0, Some(m));
        let t = s.pack_input_tile(0, 0).unwrap();
        let plane = 320 * 320;
        // channel 4 (plane 0 sigma) should be sqrt(0.04)=0.2 everywhere.
        let slice = &t[4 * plane..5 * plane];
        assert!(slice.iter().all(|&v| (v - 0.2).abs() < 1e-4));
    }

    #[test]
    fn mosaic_channels_sparse_one_plane_per_pixel() {
        // At each pixel exactly one of channels 0..3 is (potentially) nonzero:
        // its own CFA plane. Verify the other three are exactly 0.
        let s = make_session(300, 300, 0, Some(zero_model()));
        let t = s.pack_input_tile(0, 0).unwrap();
        let plane = 320 * 320;
        for r in 0..320usize {
            for l in 0..320usize {
                let px = r * 320 + l;
                // image coords for tile (0,0): ox=-32, oy=-32
                let img_r = super::reflect(r as isize - 32, 300);
                let img_c = super::reflect(l as isize - 32, 300);
                let own = plane_at(img_r, img_c, 0);
                for p in 0..4 {
                    let v = t[p * plane + px];
                    if p != own {
                        assert_eq!(v, 0.0, "plane {p} nonzero at ({r},{l})");
                    }
                }
            }
        }
    }

    #[test]
    fn mhc_packed_positions_normalised() {
        let s = make_session(300, 300, 0, Some(zero_model()));
        let t = s.pack_input_tile(0, 0).unwrap();
        let plane = 320 * 320;
        // All MHC channels 8..19 must lie in [0,1].
        for ch in 8..20 {
            let slice = &t[ch * plane..(ch + 1) * plane];
            assert!(slice.iter().all(|&v| (0.0..=1.0).contains(&v)));
        }
    }

    // ── Commit shape / rejection ──────────────────────────────────────────────

    #[test]
    fn commit_requires_exact_shape() {
        let mut s = make_session(300, 300, 0, Some(zero_model()));
        let wrong = vec![0.0f32; 12 * 256 * 256 - 1];
        assert!(s.commit_core(0, 0, &wrong).is_err());
        let ok = vec![0.0f32; 12 * 256 * 256];
        assert!(s.commit_core(0, 0, &ok).is_ok());
    }

    #[test]
    fn commit_rejects_duplicate() {
        let mut s = make_session(300, 300, 0, Some(zero_model()));
        let z = vec![0.0f32; 12 * 256 * 256];
        s.commit_core(0, 0, &z).unwrap();
        assert!(s.commit_core(0, 0, &z).is_err());
    }

    #[test]
    fn commit_rejects_out_of_range() {
        let mut s = make_session(300, 300, 0, Some(zero_model()));
        let z = vec![0.0f32; 12 * 256 * 256];
        assert!(s.commit_core(9, 0, &z).is_err());
    }

    #[test]
    fn all_committed_tracks_bitmap() {
        let mut s = make_session(300, 300, 0, Some(zero_model()));
        assert!(!s.all_committed());
        let z = vec![0.0f32; 12 * 256 * 256];
        for ty in 0..s.tiles_y {
            for tx in 0..s.tiles_x {
                assert!(!s.is_committed(tx, ty));
                s.commit_core(tx, ty, &z).unwrap();
                assert!(s.is_committed(tx, ty));
            }
        }
        assert!(s.all_committed());
    }

    #[test]
    fn out_of_order_commit_allowed_but_tracked() {
        // Out-of-order *ordering* is fine; only duplicates are rejected. Verify a
        // later tile can be committed before an earlier one.
        let mut s = make_session(600, 600, 0, Some(zero_model()));
        let z = vec![0.0f32; 12 * 256 * 256];
        s.commit_core(1, 1, &z).unwrap();
        assert!(s.is_committed(1, 1));
        assert!(!s.is_committed(0, 0));
        assert!(!s.all_committed());
    }

    // ── Zero-residual seam-free assembly ──────────────────────────────────────

    #[test]
    fn zero_residuals_reproduce_mhc_no_seams() {
        // Committing zero residuals for every tile must reproduce the MHC baseline
        // exactly across the whole image — no seams at core boundaries.
        let w = 600;
        let h = 400;
        let mut s = make_session(w, h, 0, Some(zero_model()));
        let z = vec![0.0f32; 12 * 256 * 256];
        for ty in 0..s.tiles_y {
            for tx in 0..s.tiles_x {
                s.commit_core(tx, ty, &z).unwrap();
            }
        }
        // Assembled must equal MHC within one quantisation step (round-trip of
        // 16-bit → f32 [0,1] → 16-bit is exact for the (+0.5) rounding).
        for i in 0..w * h * 3 {
            assert_eq!(
                s.assembled[i], s.mhc[i],
                "seam/mismatch at index {i}"
            );
        }
    }

    #[test]
    fn constant_positive_residual_brightens_uniformly() {
        // A constant residual of +0.1 on every channel must raise every committed
        // pixel by ~0.1 (6553 codes) with no seam discontinuity.
        let w = 512;
        let h = 512;
        let mut s = make_session(w, h, 0, Some(zero_model()));
        let r = vec![0.1f32; 12 * 256 * 256];
        for ty in 0..s.tiles_y {
            for tx in 0..s.tiles_x {
                s.commit_core(tx, ty, &r).unwrap();
            }
        }
        for i in 0..w * h * 3 {
            let expect = ((s.mhc[i] as f32 / 65535.0 + 0.1).clamp(0.0, 1.0) * 65535.0 + 0.5) as u16;
            assert_eq!(s.assembled[i], expect, "at index {i}");
        }
    }

    #[test]
    fn residual_clamped_to_quarter() {
        // A huge residual is clamped to +0.25 before add.
        let w = 300;
        let h = 300;
        let mut s = make_session(w, h, 0, Some(zero_model()));
        let r = vec![10.0f32; 12 * 256 * 256];
        s.commit_core(0, 0, &r).unwrap();
        // pixel (0,0) — inside tile (0,0)'s core
        let base = 0;
        let expect =
            ((s.mhc[base] as f32 / 65535.0 + 0.25).clamp(0.0, 1.0) * 65535.0 + 0.5) as u16;
        assert_eq!(s.assembled[base], expect);
    }
}
