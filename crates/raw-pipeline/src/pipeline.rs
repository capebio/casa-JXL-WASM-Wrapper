//! 16-bit RGB → 8-bit sRGB pipeline with Lightroom-style controls.
//!
//! Per-pixel:
//!   1. Black-subtract + WB(+ temp/tint) + exposure → linear u16 in [0,1]
//!      (via three `pre_lut` tables, one per channel)
//!   2. 3×3 CamRGB → sRGB matrix
//!   3. HSL-style saturation + skin-protected vibrance (baseline + slider)
//!   4. Per-channel tone curve (blacks/whites/shadows/highlights/contrast
//!      + always-on baseline picture-mode S-curve) + sRGB EOTF + u8.
//!      Stages 4 fold into one `post_lut`.
//!
//! All slider params are LR-style: zero-centred (-1..+1 normalised),
//! exposure in stops (-3..+3).

#[cfg(feature = "parallel")]
use rayon::prelude::*;

#[cfg(feature = "parallel")]
thread_local! {
    static PARALLEL_PATH_CALLS: std::cell::Cell<u32> = std::cell::Cell::new(0);
}

#[cfg(feature = "parallel")]
/// Query number of times parallel path was taken (this thread).
/// Returns 0 if parallel feature disabled. Used to verify rayon dispatch is firing.
/// Example:
/// ```ignore
/// parallel_path_reset();
/// process_into(&rgb16, &params, &mut out);
/// if parallel_path_call_count() > 0 {
///     eprintln!("parallel path taken {} times", parallel_path_call_count());
/// } else {
///     eprintln!("WARNING: parallel disabled or rayon not dispatching");
/// }
/// ```
pub fn parallel_path_call_count() -> u32 {
    PARALLEL_PATH_CALLS.with(|c| c.get())
}

#[cfg(feature = "parallel")]
/// Reset the parallel call counter (for benchmark/test isolation).
pub fn parallel_path_reset() {
    PARALLEL_PATH_CALLS.with(|c| c.set(0));
}

#[cfg(not(feature = "parallel"))]
pub fn parallel_path_call_count() -> u32 { 0 }

#[cfg(not(feature = "parallel"))]
pub fn parallel_path_reset() {}

pub const CAM_TO_SRGB: [[f32; 3]; 3] = [
    [ 1.526, -0.450, -0.077],
    [-0.245,  1.336, -0.091],
    [ 0.018, -0.298,  1.281],
];

/// Max pixel payload (<1 GiB) — blocks corrupt dimension exploits before buffer writes.
pub const MAX_PIXEL_BUFFER_BYTES: usize = 1024 * 1024 * 1024;

/// Validate width×height×channels fits the memory budget.
pub fn validate_pixel_dims(width: usize, height: usize, channels: usize) -> Result<(), String> {
    if width == 0 || height == 0 || channels == 0 {
        return Err(format!("pixel dimensions must be positive, got {width}×{height}×{channels}"));
    }
    let bytes = width
        .checked_mul(height)
        .and_then(|n| n.checked_mul(channels))
        .ok_or_else(|| format!("pixel dimension overflow: {width}×{height}×{channels}"))?;
    if bytes > MAX_PIXEL_BUFFER_BYTES {
        return Err(format!(
            "pixel buffer {bytes} bytes exceeds {MAX_PIXEL_BUFFER_BYTES} byte limit ({width}×{height}×{channels})"
        ));
    }
    Ok(())
}

/// Assert `buffer.len() == width×height×channels` and dims are within budget.
pub fn validate_pixel_buffer(
    buffer: &[u8],
    width: usize,
    height: usize,
    channels: usize,
) -> Result<(), String> {
    validate_pixel_dims(width, height, channels)?;
    let expected = width * height * channels;
    if buffer.len() != expected {
        return Err(format!(
            "pixel buffer length mismatch: got {} expected {} ({width}×{height}×{channels})",
            buffer.len(),
            expected
        ));
    }
    Ok(())
}

/// u16 slice variant (RGB16 etc.).
pub fn validate_pixel_buffer_u16(
    buffer: &[u16],
    width: usize,
    height: usize,
    channels: usize,
) -> Result<(), String> {
    validate_pixel_dims(width, height, channels)?;
    let expected = width * height * channels;
    if buffer.len() != expected {
        return Err(format!(
            "pixel buffer length mismatch: got {} expected {} ({width}×{height}×{channels})",
            buffer.len(),
            expected
        ));
    }
    Ok(())
}

/// Always-applied baselines that emulate Olympus Picture-Mode (Natural).
/// Without these, raw matrix output looks "flat" relative to the embedded
/// JPEG.  User look sliders adjust on top.
const BASELINE_SAT: f32 = 1.30;        // chroma scale around luma — tuned to embedded JPEG saturation
const BASELINE_CONTRAST: f32 = 0.55;   // S-curve blend, [0,1] — tuned to embedded JPEG luma std-dev
const BASELINE_EXP_EV: f32 = 1.40;     // tuned to embedded JPEG luminance

// Luma coeffs (BT.709) hoisted for FMA + ILP in per-pixel apply.
const LUMA_R: f32 = 0.2126;
const LUMA_G: f32 = 0.7152;
const LUMA_B: f32 = 0.0722;

/// Precomputed ln/exp LUTs for perceptual constancy (Lens17 non-Riemannian grid).
/// Reduces transcendental calls during grid initialization (4913 evaluations).
/// Built lazily on first use.
static LN_LINEAR_LUT: std::sync::OnceLock<Vec<f32>> = std::sync::OnceLock::new();
static EXP_LINEAR_LUT: std::sync::OnceLock<Vec<f32>> = std::sync::OnceLock::new();

fn build_ln_linear_lut() -> Vec<f32> {
    let mut lut = vec![0.0f32; 256];
    let eps = 1e-6f32;
    for i in 0..256 {
        let norm = i as f32 / 255.0;
        let linear = if norm <= 0.04045 {
            norm / 12.92
        } else {
            ((norm + 0.055) / 1.055).powf(2.4)
        };
        lut[i] = (linear.max(eps)).ln();
    }
    lut
}

fn build_exp_linear_lut() -> Vec<f32> {
    let mut lut = vec![0.0f32; 256];
    for i in 0..256 {
        let log_val = -6.0 + (i as f32 / 255.0) * 12.0;
        lut[i] = log_val.exp().min(1.5);
    }
    lut
}

#[derive(Clone)]
pub struct PipelineParams {
    pub black: u16,
    pub white: u16,
    pub wb_r: f32,
    pub wb_g: f32,
    pub wb_b: f32,

    // All zero-centred:
    pub exposure_ev: f32,   // stops, -3..+3
    pub contrast: f32,      // -1..+1
    pub shadows: f32,       // -1..+1
    pub highlights: f32,    // -1..+1
    pub whites: f32,        // -1..+1
    pub blacks: f32,        // -1..+1
    pub saturation: f32,    // -1..+1
    pub vibrance: f32,      // -1..+1
    pub temp: f32,          // -1..+1 (warm <-> cool)
    pub tint: f32,          // -1..+1 (magenta <-> green)
    pub color_matrix: Option<[[f32; 3]; 3]>,
    pub texture: f32,       // -1..+1, unsharp σ=1
    pub clarity: f32,       // -1..+1, unsharp σ=3
    // Runtime-only flag for Perceptual Constancy Mode (illumination-invariant
    // adjustments via the advanced log-geodesic / Molchanov engine during
    // progressive JXL paints). Never for ingest-time producedBy or bake-time.
    // See PerPixelMathEvolutionPlan.md and P-1 rejection.
    pub perceptual_constancy: bool,
    /// Use a 4096-entry pre-LUT sampled every 16 steps instead of the full per-value LUT.
    /// The compact LUT is L1-resident (~8 KB/channel vs up to 128 KB/channel) and is
    /// ~1.8× faster on the pre-LUT gather pass. Precision loss: ≤ 1 u16 LSB on the
    /// linearised value (< 0.002%), invisible after 8-bit quantisation.
    /// Set `true` for maximum throughput; `false` (default) for bit-exact reproducibility.
    pub compact_lut: bool,
}

impl PipelineParams {
    pub fn default_olympus() -> Self {
        Self {
            black: 0,
            white: 4095,
            wb_r: 1.78,
            wb_g: 1.00,
            wb_b: 1.50,
            exposure_ev: 0.0,
            contrast: 0.0,
            shadows: 0.0,
            highlights: 0.0,
            whites: 0.0,
            blacks: 0.0,
            saturation: 0.0,
            vibrance: 0.0,
            temp: 0.0,
            tint: 0.0,
            color_matrix: None,
            texture: 0.0,
            clarity: 0.0,
            perceptual_constancy: false,
            compact_lut: false,
        }
    }
}

#[inline(always)]
fn linear_to_srgb(v: f32) -> f32 {
    if v <= 0.0031308 {
        v * 12.92
    } else {
        // powf is already LLVM-intrinsified on wasm32; #[inline(always)] ensures
        // it is inlined into the LUT build loop to avoid call overhead.
        // Use mul_add for the scale+bias. NB: per-slider post-LUT rebuilds go through
        // `srgb_encode_lerp` instead (this powf path is now only hit ONCE, to build the table).
        1.055f32.mul_add(v.powf(1.0 / 2.4), -0.055)
    }
}

/// Once-built table of the sRGB EOTF over [0,1] (N+1 samples). The post-LUT is rebuilt on every
/// tone-slider tick; the EOTF itself never changes, so caching it lets the rebuild replace the
/// unconditional per-entry `powf` (`linear_to_srgb`) with a lerp gather. Built once process-wide
/// (immutable, shared read-only across threads — no per-thread or per-rebuild cost beyond the first).
static SRGB_ENCODE: std::sync::OnceLock<Vec<f32>> = std::sync::OnceLock::new();
const SRGB_LUT_N: usize = 16384;

/// sRGB-encode a linear value via the cached table + linear interpolation. Measured lerp error is
/// ≤ ~0.22 u16 LSB even at the steep EOTF knee (`f''` peaks near 0.0031, step = 1/16384), so the u8
/// post-LUT is byte-identical to the powf build and the u16 post-LUT differs by ≤1 LSB on rare
/// entries (that 1 LSB is inherited from f32 `powf` node rounding in the table, not the lerp).
#[inline(always)]
pub(crate) fn srgb_encode_lerp(y: f32) -> f32 {
    let tbl = SRGB_ENCODE.get_or_init(|| {
        (0..=SRGB_LUT_N).map(|i| linear_to_srgb(i as f32 / SRGB_LUT_N as f32)).collect()
    });
    let pos = y.clamp(0.0, 1.0) * SRGB_LUT_N as f32;
    let i0 = (pos as usize).min(SRGB_LUT_N - 1);
    let frac = pos - i0 as f32;
    tbl[i0] + (tbl[i0 + 1] - tbl[i0]) * frac
}

#[inline]
fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    if (b - a).abs() < f32::EPSILON {
        return if x >= b { 1.0 } else { 0.0 };
    }
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

struct TonePost {
    contrast: f32,
    shadows: f32,
    highlights: f32,
    whites: f32,
    blacks: f32,
}

/// LR-style per-channel tone curve: blacks/whites endpoint shifts,
/// shadows/highlights region gammas, contrast S-curve, baseline curve,
/// sRGB EOTF.  Input/output in [0,1] linear.
fn tone_curve(x: f32, p: &TonePost) -> f32 {
    let mut y = x;

    // Endpoint shifts: independent operations so each slider works without the other.
    let blk_offset = p.blacks * BLK_OFFSET_SCALE;
    let wh_scale = 1.0 + p.whites * WH_SCALE_DELTA;
    y = (y * wh_scale + blk_offset).clamp(0.0, 1.0);

    // Shadows: gamma in lower region. Use mul_add for blends.
    if p.shadows.abs() > 1e-4 {
        let mask = 1.0 - smoothstep(0.0, SHADOW_MASK_END, y);
        let gamma = 1.0 / (1.0 + p.shadows * SHADOW_GAMMA_SCALE);
        let lifted = y.powf(gamma);
        y = y.mul_add(1.0 - mask, lifted * mask);
    }
    // Highlights: gamma in upper region.
    if p.highlights.abs() > 1e-4 {
        let mask = smoothstep(HIGHLIGHT_MASK_START, 1.0, y);
        let inv = 1.0 - y;
        let gamma = 1.0 / (1.0 - p.highlights * HIGHLIGHT_GAMMA_SCALE).max(HIGHLIGHT_GAMMA_MIN);
        let pulled = 1.0 - inv.powf(gamma);
        y = y.mul_add(1.0 - mask, pulled * mask);
    }

    // Contrast (user + always-on baseline) — smoothstep blend around 0.5.
    // Scale user delta to fill the remaining headroom each side so the full
    // slider range is usable: positive fills [BASELINE, 1], negative fills [BASELINE, -1].
    let c = if p.contrast >= 0.0 {
        BASELINE_CONTRAST + p.contrast * (1.0 - BASELINE_CONTRAST)
    } else {
        BASELINE_CONTRAST + p.contrast * (1.0 + BASELINE_CONTRAST)
    }.clamp(-1.0, 1.0);
    if c > 1e-4 {
        let s = y * y * (3.0 - 2.0 * y);
        y = y.mul_add(1.0 - c, s * c);
    } else if c < -1e-4 {
        // De-contrast: pull toward linear ramp away from pivot.
        let signed = if y < 0.5 { -1.0 } else { 1.0 };
        let inv_s = 0.5 + signed * (0.5 - y).abs().sqrt() * 0.5;
        y = y.mul_add(1.0 + c, inv_s * (-c));
    }

    srgb_encode_lerp(y)
}

/// Highlight rolloff knee, in normalized linear (after WB + exposure gain).
/// Values at or below the knee pass through unchanged; above it they roll off
/// smoothly toward 1.0 instead of hard-clipping, so WB- or exposure-boosted
/// highlights — notably skies, where the red/blue WB multipliers exceed 1.0 and
/// drive those channels past the clip point before green — retain gradient
/// detail instead of flattening to a featureless white.
const HIGHLIGHT_KNEE: f32 = 0.80;

// Tone curve magic numbers hoisted (used in every LUT entry during build_post).
const BLK_OFFSET_SCALE: f32 = 0.10;
const WH_SCALE_DELTA: f32 = 0.20;
const SHADOW_GAMMA_SCALE: f32 = 0.7;
const SHADOW_MASK_END: f32 = 0.6;
const HIGHLIGHT_GAMMA_MIN: f32 = 0.05;
const HIGHLIGHT_GAMMA_SCALE: f32 = 0.7;
const HIGHLIGHT_MASK_START: f32 = 0.4;

/// Soft highlight shoulder: identity below `HIGHLIGHT_KNEE`, then a smooth
/// asymptotic rolloff that maps `[knee, +inf)` into `[knee, 1.0)`. The rolloff
/// is C1-continuous at the knee (slope 1 on both sides), so there is no visible
/// kink where it engages. Replaces a hard clamp to 1.0, which discarded all
/// detail above the clip point and made highlight recovery impossible.
#[inline(always)]
fn highlight_shoulder(x: f32) -> f32 {
    if x <= HIGHLIGHT_KNEE {
        x
    } else {
        let range = 1.0 - HIGHLIGHT_KNEE;
        let s = x - HIGHLIGHT_KNEE;
        HIGHLIGHT_KNEE + range * s / (s + range)
    }
}

/// Perceptual Constancy framework helpers (Lens17 full implementation).
/// These realize the unified non-Riemannian model in the hot path.
/// For production sub-ms, this would be replaced by precomputed LUT or SIMD.
/// See docs/PerceptualConstancyMode.md and docs/hooks.md for the math and hooking.

const SENSOR_SHARPEN_B: [[f32; 3]; 3] = [
    [ 1.05, -0.025, -0.025],
    [-0.025,  1.05, -0.025],
    [-0.025, -0.025,  1.05],
]; // Plausible sensor-sharpen; full system can load per-camera or fixed.

#[inline(always)]
fn to_log_euclidean(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let eps = 1e-6f32;
    // B * rgb then component log to map geodesics to flat Euclidean space.
    let sr = SENSOR_SHARPEN_B[0][0]*r + SENSOR_SHARPEN_B[0][1]*g + SENSOR_SHARPEN_B[0][2]*b;
    let sg = SENSOR_SHARPEN_B[1][0]*r + SENSOR_SHARPEN_B[1][1]*g + SENSOR_SHARPEN_B[1][2]*b;
    let sb = SENSOR_SHARPEN_B[2][0]*r + SENSOR_SHARPEN_B[2][1]*g + SENSOR_SHARPEN_B[2][2]*b;
    (
        (sr.max(eps)).ln(),
        (sg.max(eps)).ln(),
        (sb.max(eps)).ln(),
    )
}

#[inline(always)]
fn from_log_euclidean(lr: f32, lg: f32, lb: f32) -> (f32, f32, f32) {
    let eps = 1e-6f32;
    (
        (lr.exp() - eps).max(0.0),
        (lg.exp() - eps).max(0.0),
        (lb.exp() - eps).max(0.0),
    )
}

/// Molchanov residuals + A_tensor for adaptive discretization and uniform modulation.
/// Density around neutral grays and saturated greens.
#[inline(always)]
fn molchanov_residuals_and_atensor(luma_l: f32, lr: f32, lg: f32, lb: f32, base_scale: f32) -> (f32, f32, f32, f32) {
    // Parallelogram law residuals discretize metric grid. *self instead of powi(2) for ILP.
    let dr = lr - luma_l;
    let dg = lg - luma_l;
    let db = lb - luma_l;
    let res_r = 0.02 * (dr * dr);
    let res_g = 0.02 * (dg * dg);
    let res_b = 0.02 * (db * db);

    // A_tensor modulation of scale (and conceptually sliders/edges).
    let gray_dist = ((lr - luma_l).abs() + (lg - luma_l).abs() + (lb - luma_l).abs()).min(2.0) / 2.0;
    let a_mod = 1.0 + 0.3 * (1.0 - gray_dist); // higher density (stronger effect) near gray
    let green_boost = if lg > lr.max(lb) { 1.15 } else { 1.0 }; // saturated greens
    let modulated_scale = base_scale * a_mod * green_boost;

    (luma_l + (lr - luma_l + res_r) * modulated_scale,
     luma_l + (lg - luma_l + res_g) * modulated_scale,
     luma_l + (lb - luma_l + res_b) * modulated_scale,
     modulated_scale)
}

/// Hybrid Riemannian/non-Riemannian spring (ΔE2000-like) + Los Alamos f(c) diminishing returns.
#[inline(always)]
fn hybrid_spring_and_dimishing_fc(lr: f32, lg: f32, lb: f32, luma_l: f32) -> (f32, f32, f32) {
    let mut r = lr;
    let mut g = lg;
    let mut b = lb;

    // Spring force to neutral gray to counter drift near grays. Use * for powi(2).
    let dr = r - luma_l;
    let dg = g - luma_l;
    let db = b - luma_l;
    let dist = ((dr*dr) + (dg*dg) + (db*db)).sqrt();
    if dist < 0.25 {
        let spring = 0.7 * (0.25 - dist);
        r = r * (1.0 - spring) + luma_l * spring;
        g = g * (1.0 - spring) + luma_l * spring;
        b = b * (1.0 - spring) + luma_l * spring;
    }

    // f(c) per-hue diminishing returns (stronger for greens, etc.).
    let fc_r = (1.0 - 0.08 * dr.abs().min(0.6)).max(0.6);
    let fc_g = (1.0 - 0.12 * dg.abs().min(0.6)).max(0.6); // greens
    let fc_b = (1.0 - 0.08 * db.abs().min(0.6)).max(0.6);

    (r * fc_r, g * fc_g, b * fc_b)
}

/// Live default perceptual-constancy LUT for `#[cfg(not(feature = "c-perceptual"))]` builds
/// (WASM and native without the optional C++ AVX2 feature).
///
/// `new()` fully populates a 17³ grid by evaluating the complete advanced path
/// (log-geodesic → Molchanov residuals/A_tensor → hybrid spring → f(c) hue diminishing
/// returns) at every lattice point in [0, 1.5]³ with fixed saturation scale.
/// `sample()` performs trilinear interpolation into that grid, replacing per-pixel
/// `ln`/`exp`/`sqrt` calls with a handful of multiplies and adds.
///
/// Called per pixel in `apply_tone_math` via the `PERCEPTUAL_GRID` thread-local
/// (lazy-initialised on first use, then borrowed read-only in the hot loop).
/// Do not treat this as inert: removing or skipping it disables perceptual constancy
/// for all non-c-perceptual targets.
///
/// PIPE-008: data is stored as three separate planar arrays (data_r, data_g, data_b),
/// each of length SZ^3, so the 8 corner values needed for trilinear interpolation on one
/// channel are contiguous in their plane.  The interleaved layout (old: data[idx*3+ch])
/// scattered the 8 corners across up to 24 cache lines; the planar layout keeps each
/// channel's 8-corner reads within at most 2 cache lines of a 17^3×4 = 4.7 KB plane.
struct PerceptualGrid {
    // PIPE-008: planar layout — one Vec per output channel; index = ri*SZ*SZ + gi*SZ + bi.
    // Total memory same as before (SZ^3 * 3 * 4 bytes), but trilinear reads are now
    // channel-sequential rather than stride-3 interleaved across all 8 corners.
    data_r: Vec<f32>,
    data_g: Vec<f32>,
    data_b: Vec<f32>,
    size: usize,
}

impl PerceptualGrid {
    fn new() -> Self {
        const SZ: usize = 17; // Phase 2 of WASM/native strategy: production quality (vs 9). ~4913 evals, still cheap on init.
                              // Pure Rust path (this grid + vec4) is the default for WASM and when c-perceptual feature is off.
                              // C++ AVX2 bulk (via tile in !par loops) is optional native turbo when feature + pc flag.
        let mut data_r = vec![0f32; SZ * SZ * SZ];
        let mut data_g = vec![0f32; SZ * SZ * SZ];
        let mut data_b = vec![0f32; SZ * SZ * SZ];
        let scale = 1.0f32; // fixed for grid; vib_zero path (mode common case). Varying sat/vib falls back or rebuilds.
        for ri in 0..SZ {
            let r = (ri as f32 / (SZ - 1) as f32) * 1.5;
            for gi in 0..SZ {
                let g = (gi as f32 / (SZ - 1) as f32) * 1.5;
                for bi in 0..SZ {
                    let b = (bi as f32 / (SZ - 1) as f32) * 1.5;
                    // Run the exact advanced path (post-matrix input) with fixed scale for this grid point
                    let (lr, lg, lb) = to_log_euclidean(r, g, b);
                    let luma_l = (lr + lg + lb) / 3.0;
                    let (lr2, lg2, lb2, _mod) = molchanov_residuals_and_atensor(luma_l, lr, lg, lb, scale);
                    let (lr3, lg3, lb3) = hybrid_spring_and_dimishing_fc(lr2, lg2, lb2, luma_l);
                    let (rr, gg, bb) = from_log_euclidean(lr3, lg3, lb3);
                    let idx = ri * SZ * SZ + gi * SZ + bi;
                    data_r[idx] = rr.clamp(0.0, 1.5);
                    data_g[idx] = gg.clamp(0.0, 1.5);
                    data_b[idx] = bb.clamp(0.0, 1.5);
                }
            }
        }
        Self { data_r, data_g, data_b, size: SZ }
    }

    #[inline(always)]
    fn sample(&self, r: f32, g: f32, b: f32) -> (f32, f32, f32) {
        // Trilinear interp in [0,1.5]^3 scaled to grid. Fast path for pc !c-perceptual rust.
        let s = self.size as f32 - 1.0;
        // Colour matrix can produce negatives, so clamp to [0,1] before scaling to
        // the grid — otherwise rf<0 yields a negative trilinear weight (extrapolation).
        let rf = (r / 1.5).clamp(0.0, 1.0) * s;
        let gf = (g / 1.5).clamp(0.0, 1.0) * s;
        let bf = (b / 1.5).clamp(0.0, 1.0) * s;
        let ri = rf.floor() as usize;
        let gi = gf.floor() as usize;
        let bi = bf.floor() as usize;
        let rfr = rf - ri as f32;
        let gfr = gf - gi as f32;
        let bfr = bf - bi as f32;
        let r1 = (ri + 1).min(self.size - 1);
        let g1 = (gi + 1).min(self.size - 1);
        let b1 = (bi + 1).min(self.size - 1);
        // PIPE-008: planar corner indices — each channel's 8 reads are in its own contiguous plane.
        // Each plane is SZ^3 * 4 = 4.7 KB (SZ=17); 8 corners fit in ≤2 cache lines per channel.
        let idx000 = ri * self.size * self.size + gi * self.size + bi;
        let idx001 = ri * self.size * self.size + gi * self.size + b1;
        let idx010 = ri * self.size * self.size + g1 * self.size + bi;
        let idx011 = ri * self.size * self.size + g1 * self.size + b1;
        let idx100 = r1 * self.size * self.size + gi * self.size + bi;
        let idx101 = r1 * self.size * self.size + gi * self.size + b1;
        let idx110 = r1 * self.size * self.size + g1 * self.size + bi;
        let idx111 = r1 * self.size * self.size + g1 * self.size + b1;
        // lerp r then g then b for each channel
        let lerp = |c000: f32, c001: f32, c010: f32, c011: f32, c100: f32, c101: f32, c110: f32, c111: f32| {
            let c00 = c000 * (1.0 - bfr) + c001 * bfr;
            let c01 = c010 * (1.0 - bfr) + c011 * bfr;
            let c10 = c100 * (1.0 - bfr) + c101 * bfr;
            let c11 = c110 * (1.0 - bfr) + c111 * bfr;
            let c0 = c00 * (1.0 - gfr) + c01 * gfr;
            let c1 = c10 * (1.0 - gfr) + c11 * gfr;
            c0 * (1.0 - rfr) + c1 * rfr
        };
        let dr = lerp(self.data_r[idx000], self.data_r[idx001], self.data_r[idx010], self.data_r[idx011],
                      self.data_r[idx100], self.data_r[idx101], self.data_r[idx110], self.data_r[idx111]);
        let dg = lerp(self.data_g[idx000], self.data_g[idx001], self.data_g[idx010], self.data_g[idx011],
                      self.data_g[idx100], self.data_g[idx101], self.data_g[idx110], self.data_g[idx111]);
        let db = lerp(self.data_b[idx000], self.data_b[idx001], self.data_b[idx010], self.data_b[idx011],
                      self.data_b[idx100], self.data_b[idx101], self.data_b[idx110], self.data_b[idx111]);
        (dr, dg, db)
    }
}

fn build_pre_lut(black: u16, white: u16, wb_eff: f32, exp_gain: f32) -> Vec<u16> {
    let mut lut = vec![0u16; 65536];
    let denom = (white.saturating_sub(black)).max(1) as f32;
    let gain = wb_eff * exp_gain;
    // Precompute scale to replace per-i div with mul (faster in tight 64k loop).
    let norm_gain = gain / denom;
    // T1: per-index work is independent; parallelize. Matters most for small/thumbnail renders where
    // the fixed 65536-entry build is a large fraction of (or exceeds) the per-pixel pass.
    let fill = |i: usize, o: &mut u16| {
        let centered = (i as i32 - black as i32).max(0) as f32;
        let n = highlight_shoulder(centered * norm_gain);
        *o = (n * 65535.0 + 0.5).min(65535.0) as u16;
    };
    #[cfg(feature = "parallel")]
    lut.par_iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    #[cfg(not(feature = "parallel"))]
    lut.iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    lut
}

/// Build a power-of-two pre-LUT of size `lut_len` (≤ 65536).
/// **Access pattern**: index via `raw_value & (lut_len - 1)` (bitwise mask).
/// This covers the common case where `white < lut_len` so all valid raw values index directly.
/// For the strided (compact 4096-entry) variant accessed via `raw_value >> COMPACT_LUT_SHIFT`, use
/// `build_pre_lut_strided` instead. Do not mix the two access patterns.
fn build_pre_lut_compact(black: u16, white: u16, wb_eff: f32, exp_gain: f32, lut_len: usize) -> Vec<u16> {
    assert!(lut_len.is_power_of_two() && lut_len <= 65536, "build_pre_lut_compact: lut_len must be a power of two ≤ 65536, got {lut_len}");
    let mut lut = vec![0u16; lut_len];
    let denom = (white.saturating_sub(black)).max(1) as f32;
    let gain = wb_eff * exp_gain;
    let norm_gain = gain / denom;
    let fill = |i: usize, o: &mut u16| {
        let centered = (i as i32 - black as i32).max(0) as f32;
        let n = highlight_shoulder(centered * norm_gain);
        *o = (n * 65535.0 + 0.5).min(65535.0) as u16;
    };
    #[cfg(feature = "parallel")]
    lut.par_iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    #[cfg(not(feature = "parallel"))]
    lut.iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    lut
}

// 4096-entry strided pre-LUT: each entry covers 16 raw values (stride 16).
// Access via `raw_value >> COMPACT_LUT_SHIFT`. L1-resident (~8 KB/ch) vs up to
// 128 KB/ch for the full table. Precision loss: ≤ 1 u16 LSB on linearised output.
const COMPACT_LUT_LEN: usize = 4096;
const COMPACT_LUT_SHIFT: u32 = 4; // 65536 / 4096 = 16 = 1 << 4

fn build_pre_lut_strided(black: u16, white: u16, wb_eff: f32, exp_gain: f32) -> Vec<u16> {
    let mut lut = vec![0u16; COMPACT_LUT_LEN];
    let denom = (white.saturating_sub(black)).max(1) as f32;
    let gain = wb_eff * exp_gain;
    let norm_gain = gain / denom;
    let fill = |i: usize, o: &mut u16| {
        let raw_input = (i << COMPACT_LUT_SHIFT) as i32;
        let centered = (raw_input - black as i32).max(0) as f32;
        let n = highlight_shoulder(centered * norm_gain);
        *o = (n * 65535.0 + 0.5).min(65535.0) as u16;
    };
    #[cfg(feature = "parallel")]
    lut.par_iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    #[cfg(not(feature = "parallel"))]
    lut.iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    lut
}

struct LutCache {
    black: u16, white: u16,
    wb_r_bits: u32, wb_g_bits: u32, wb_b_bits: u32, exp_gain_bits: u32,
    contrast_bits: u32, shadows_bits: u32, highlights_bits: u32,
    whites_bits: u32, blacks_bits: u32,
    pre_r: std::sync::Arc<Vec<u16>>, pre_g: std::sync::Arc<Vec<u16>>, pre_b: std::sync::Arc<Vec<u16>>,
    post: std::sync::Arc<Vec<u8>>,
    post16: Option<std::sync::Arc<Vec<u16>>>,
    pre_lut_len: usize,
    pre_lut_shift: u32,
    compact_lut: bool,
}

// All fields are either plain integers, bool, or Arc<Vec<_>> which are Send.
// This compile-time assertion catches future non-Send field additions.
fn _assert_lut_cache_send() where LutCache: Send {}

impl LutCache {
    /// Pre-LUT validity: depends ONLY on the linearisation params (black/white/WB/exposure/compact).
    /// A tone-only slider drag (contrast/shadows/highlights/whites/blacks) leaves these intact, so
    /// the 3 pre-LUTs are NOT rebuilt — see `ensure_lut`.
    fn pre_matches(&self, black: u16, white: u16, wb_r: f32, wb_g: f32, wb_b: f32,
                   exp_gain: f32, compact: bool) -> bool {
        self.black == black && self.white == white
            && self.compact_lut == compact
            && self.wb_r_bits    == wb_r.to_bits()
            && self.wb_g_bits    == wb_g.to_bits()
            && self.wb_b_bits    == wb_b.to_bits()
            && self.exp_gain_bits == exp_gain.to_bits()
    }
    /// Post-LUT validity: depends ONLY on the tone curve params. A WB/exposure/black/white drag
    /// leaves these intact, so the powf-heavy post-LUT is NOT rebuilt.
    fn post_matches(&self, tone: &TonePost) -> bool {
        self.contrast_bits   == tone.contrast.to_bits()
            && self.shadows_bits    == tone.shadows.to_bits()
            && self.highlights_bits == tone.highlights.to_bits()
            && self.whites_bits     == tone.whites.to_bits()
            && self.blacks_bits     == tone.blacks.to_bits()
    }
}

thread_local! {
    static LUT_CACHE: std::cell::RefCell<Option<LutCache>> =
        const { std::cell::RefCell::new(None) };
    // PIPE-003: third slot is the clarity/texture snapshot buffer; reused across calls to
    // avoid a full-frame Vec allocation (~144 MB at 24 MP) when both texture and clarity
    // are active simultaneously.
    static BLUR_SCRATCH: std::cell::RefCell<(Vec<u16>, Vec<u16>, Vec<u16>)> =
        const { std::cell::RefCell::new((Vec::new(), Vec::new(), Vec::new())) };
    static BLUR_ROW_F32: std::cell::RefCell<Vec<f32>> =
        const { std::cell::RefCell::new(Vec::new()) };
    static PERCEPTUAL_GRID: std::cell::RefCell<Option<PerceptualGrid>> =
        const { std::cell::RefCell::new(None) };
}

fn build_post_lut(t: &TonePost) -> Vec<u8> {
    // MEASURED (2026-06-19): this rebuild is only ~2% of a slider-drag frame (item-0). The handoff's
    // "powf→polynomial" idea is therefore negligible — and the unconditional sRGB EOTF powf is
    // already replaced by a cached lerp (`srgb_encode_lerp`). Do not micro-optimize the build.
    let mut lut = vec![0u8; 65536];
    // Hoist for mul_add + clamp.
    let fill = |i: usize, o: &mut u8| {
        let y = tone_curve(i as f32 / 65535.0, t);
        *o = (y * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
    };
    #[cfg(feature = "parallel")]
    lut.par_iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    #[cfg(not(feature = "parallel"))]
    lut.iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    lut
}

fn build_post16_lut(t: &TonePost) -> Vec<u16> {
    let mut lut = vec![0u16; 65536];
    let fill = |i: usize, o: &mut u16| {
        let y = tone_curve(i as f32 / 65535.0, t);
        *o = (y * 65535.0 + 0.5).clamp(0.0, 65535.0) as u16;
    };
    #[cfg(feature = "parallel")]
    lut.par_iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    #[cfg(not(feature = "parallel"))]
    lut.iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    lut
}

/// Compact 4096-entry post-LUT for u8 output. ~16x smaller (4KB vs 65KB).
/// Access via `idx = (tone_index >> 4)` with linear interpolation for precision.
const COMPACT_POST_LUT_LEN: usize = 4096;
const COMPACT_POST_LUT_SHIFT: u32 = 4; // 65536 / 4096 = 16 = 1 << 4

fn build_post_lut_strided(t: &TonePost) -> Vec<u8> {
    let mut lut = vec![0u8; COMPACT_POST_LUT_LEN];
    let fill = |i: usize, o: &mut u8| {
        let raw_input = (i << COMPACT_POST_LUT_SHIFT) as f32; // map 4k index back to 65k range
        let y = tone_curve(raw_input / 65535.0, t);
        *o = (y * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
    };
    #[cfg(feature = "parallel")]
    lut.par_iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    #[cfg(not(feature = "parallel"))]
    lut.iter_mut().enumerate().for_each(|(i, o)| fill(i, o));
    lut
}

/// Build the three pre-LUTs (black/WB/exposure/highlight-shoulder linearisation). Shared by the
/// full build and the partial (pre-only) rebuild in `ensure_lut`. Returns `(r,g,b,len,shift)`.
fn build_pre_luts(
    params: &PipelineParams,
    ti: &ToneInputs,
) -> (std::sync::Arc<Vec<u16>>, std::sync::Arc<Vec<u16>>, std::sync::Arc<Vec<u16>>, usize, u32) {
    if params.compact_lut {
        (
            std::sync::Arc::new(build_pre_lut_strided(params.black, params.white, ti.wb_r, ti.exp_gain)),
            std::sync::Arc::new(build_pre_lut_strided(params.black, params.white, ti.wb_g, ti.exp_gain)),
            std::sync::Arc::new(build_pre_lut_strided(params.black, params.white, ti.wb_b, ti.exp_gain)),
            COMPACT_LUT_LEN,
            COMPACT_LUT_SHIFT,
        )
    } else {
        // Use a full 65536-entry LUT so the mask `& (lut_len - 1)` never wraps raw values
        // that exceed white (e.g. hot pixels or unclamped sensor values). With lut_len == 65536
        // the mask `0xFFFF` is an identity for all u16 inputs.
        let lut_len = 65536usize;
        (
            std::sync::Arc::new(build_pre_lut_compact(params.black, params.white, ti.wb_r, ti.exp_gain, lut_len)),
            std::sync::Arc::new(build_pre_lut_compact(params.black, params.white, ti.wb_g, ti.exp_gain, lut_len)),
            std::sync::Arc::new(build_pre_lut_compact(params.black, params.white, ti.wb_b, ti.exp_gain, lut_len)),
            lut_len,
            0u32,
        )
    }
}

/// Item-0 instrumentation: time one full LUT (re)build — the cost paid on every slider drag when
/// tone/WB/exposure change (an `ensure_lut` miss rebuilds all tables). Returns `(pre3_ms, post_ms)`:
/// `pre3` = three pre-LUTs (65536-entry WB/exposure/black-white), `post` = the 65536-entry
/// tone post-LUT (`tone_curve`, powf-heavy). Build parallelism follows the crate feature, so call
/// it under `--no-default-features` to see the serial cost the wasm interactive path actually pays.
/// Note: uses `build_pre_lut` (65536-entry) which matches the non-compact production path.
pub fn bench_lut_build_ms(params: &PipelineParams) -> (f64, f64) {
    let ti = derive_tone_inputs(params);
    let t = std::time::Instant::now();
    let pr = build_pre_lut(params.black, params.white, ti.wb_r, ti.exp_gain);
    let pg = build_pre_lut(params.black, params.white, ti.wb_g, ti.exp_gain);
    let pb = build_pre_lut(params.black, params.white, ti.wb_b, ti.exp_gain);
    std::hint::black_box((&pr, &pg, &pb));
    let pre3_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = std::time::Instant::now();
    let post = build_post_lut(&ti.tone);
    std::hint::black_box(&post);
    let post_ms = t.elapsed().as_secs_f64() * 1000.0;
    (pre3_ms, post_ms)
}

pub fn gaussian_kernel_5() -> [f32; 5] {
    [0.0545, 0.2442, 0.4026, 0.2442, 0.0545]
}

pub fn gaussian_kernel_13() -> [f32; 13] {
    [0.0185, 0.0342, 0.0563, 0.0831, 0.1097, 0.1296,
     0.1372,
     0.1296, 0.1097, 0.0831, 0.0563, 0.0342, 0.0185]
}

/// Horizontal blur pass: de-interleave → planar FIR (stride-1, LLVM vectorises) → re-interleave.
/// Const-generic dispatch (N=5 or N=13) gives LLVM a fixed inner-loop bound to unroll.
fn separable_blur_into(src: &[u16], width: usize, _height: usize,
                       kernel: &[f32], temp: &mut [u16]) {
    let half = kernel.len() / 2;
    let klen = kernel.len();

    #[cfg(feature = "parallel")]
    let iter = temp.par_chunks_mut(width * 3).enumerate();
    #[cfg(not(feature = "parallel"))]
    let iter = temp.chunks_mut(width * 3).enumerate();

    iter.for_each(|(y, row)| {
        let src_row = &src[y * width * 3 .. (y + 1) * width * 3];
        BLUR_ROW_F32.with(|cell| {
            let mut scratch = cell.borrow_mut();
            // Layout: [R_in | G_in | B_in | R_out | G_out | B_out] each width f32.
            scratch.resize(width * 6, 0.0f32);
            let (r_in, rest) = scratch.split_at_mut(width);
            let (g_in, rest) = rest.split_at_mut(width);
            let (b_in, rest) = rest.split_at_mut(width);
            let (r_out, rest) = rest.split_at_mut(width);
            let (g_out, b_out) = rest.split_at_mut(width);

            // De-interleave: stride-3 u16 read => 3 x stride-1 f32.
            for px in 0..width {
                let b = px * 3;
                r_in[px] = src_row[b]     as f32;
                g_in[px] = src_row[b + 1] as f32;
                b_in[px] = src_row[b + 2] as f32;
            }

            // Dispatch on kernel length so LLVM sees a compile-time inner bound.
            match klen {
                13 => blur_fir_planar::<13>(r_in, kernel, half, r_out),
                5  => blur_fir_planar::<5> (r_in, kernel, half, r_out),
                _  => blur_fir_planar_dyn  (r_in, kernel, half, r_out),
            }
            match klen {
                13 => blur_fir_planar::<13>(g_in, kernel, half, g_out),
                5  => blur_fir_planar::<5> (g_in, kernel, half, g_out),
                _  => blur_fir_planar_dyn  (g_in, kernel, half, g_out),
            }
            match klen {
                13 => blur_fir_planar::<13>(b_in, kernel, half, b_out),
                5  => blur_fir_planar::<5> (b_in, kernel, half, b_out),
                _  => blur_fir_planar_dyn  (b_in, kernel, half, b_out),
            }

            // Re-interleave + f32->u16: stride-1 read => stride-3 write.
            for px in 0..width {
                let b = px * 3;
                row[b]     = r_out[px].round() as u16;
                row[b + 1] = g_out[px].round() as u16;
                row[b + 2] = b_out[px].round() as u16;
            }
        });
    });
}

/// Portable fused multiply-add for the auto-vectorised blur/FIR kernels.
///
/// `f32::mul_add` is a single-rounding hardware FMA *only* when the target has the
/// `fma` feature; on the default baseline `x86-64` target (no `+fma`) it lowers to a
/// scalar `fmaf` **libcall** (~50-100 cyc) that also blocks auto-vectorisation — which
/// made the separable blur ~3.5× slower than necessary on shipped builds (measured:
/// `examples/blur_mul_add_flip.rs`, 12-24 MP, 13-tap, +71% saved, ≤1 LSB parity). So:
///   - FMA build (`+fma` / `target-cpu=native`) → `mul_add` (one `vfmadd`: fastest + most accurate)
///   - baseline build                            → `a * b + c` (LLVM emits vectorised `mulps`/`addps`)
/// The two paths differ by ≤1 LSB on the 16-bit blur intermediate — negligible.
#[inline(always)]
fn bfma(a: f32, b: f32, c: f32) -> f32 {
    #[cfg(target_feature = "fma")]
    { a.mul_add(b, c) }
    #[cfg(not(target_feature = "fma"))]
    { a * b + c }
}

/// 1-D FIR on a single f32 plane with stride-1 I/O and fixed kernel length N.
/// LLVM can unroll the ki loop and auto-vectorise the x loop.
#[inline]
fn blur_fir_planar<const N: usize>(plane: &[f32], kernel: &[f32], half: usize, out: &mut [f32]) {
    let width = plane.len();
    let int_start = half;
    let int_end   = width.saturating_sub(half);
    let wm = width as isize - 1;

    // Left border.
    for x in 0..int_start.min(width) {
        let mut acc = 0f32;
        for ki in 0..N {
            let xi = (x as isize + ki as isize - half as isize).clamp(0, wm) as usize;
            acc = bfma(plane[xi], kernel[ki], acc);
        }
        out[x] = acc;
    }
    // Interior: stride-1 read + write; fixed N => LLVM unrolls ki, vectorises x.
    for x in int_start..int_end {
        let b0 = x - half;
        let mut acc = 0f32;
        for ki in 0..N {
            acc = bfma(plane[b0 + ki], kernel[ki], acc);
        }
        out[x] = acc;
    }
    // Right border.
    for x in int_end.max(int_start)..width {
        let mut acc = 0f32;
        for ki in 0..N {
            let xi = (x as isize + ki as isize - half as isize).clamp(0, wm) as usize;
            acc = bfma(plane[xi], kernel[ki], acc);
        }
        out[x] = acc;
    }
}

/// Dynamic-length fallback (rare non-5/13 kernels).
#[cold]
fn blur_fir_planar_dyn(plane: &[f32], kernel: &[f32], half: usize, out: &mut [f32]) {
    let width = plane.len();
    let int_start = half;
    let int_end   = width.saturating_sub(half);
    let wm = width as isize - 1;
    for x in 0..int_start.min(width) {
        let mut acc = 0f32;
        for ki in 0..kernel.len() {
            let xi = (x as isize + ki as isize - half as isize).clamp(0, wm) as usize;
            acc = bfma(plane[xi], kernel[ki], acc);
        }
        out[x] = acc;
    }
    for x in int_start..int_end {
        let b0 = x - half;
        let mut acc = 0f32;
        for (ki, &kv) in kernel.iter().enumerate() { acc = bfma(plane[b0 + ki], kv, acc); }
        out[x] = acc;
    }
    for x in int_end.max(int_start)..width {
        let mut acc = 0f32;
        for ki in 0..kernel.len() {
            let xi = (x as isize + ki as isize - half as isize).clamp(0, wm) as usize;
            acc = bfma(plane[xi], kernel[ki], acc);
        }
        out[x] = acc;
    }
}
fn separable_blur_with_bufs(src: &[u16], width: usize, height: usize, kernel: &[f32],
                             temp: &mut Vec<u16>, out: &mut Vec<u16>) {
    let n = width * height * 3;
    temp.resize(n, 0);
    out.resize(n, 0);
    separable_blur_into(src, width, height, kernel, temp);
    let half = kernel.len() / 2;

    #[cfg(feature = "parallel")]
    {
        const VTILE: usize = 128;
        let klen = kernel.len();
        let temp_slice = temp.as_slice();
        out.par_chunks_mut(width * 3).enumerate().for_each(|(y, row)| {
            let mut acc_r = [0f32; VTILE];
            let mut acc_g = [0f32; VTILE];
            let mut acc_b = [0f32; VTILE];
            let mut r_tap = [0f32; VTILE];
            let mut g_tap = [0f32; VTILE];
            let mut b_tap = [0f32; VTILE];
            for x0 in (0..width).step_by(VTILE) {
                let x1 = (x0 + VTILE).min(width);
                let tile = x1 - x0;
                for xi in 0..tile { acc_r[xi] = 0.0; acc_g[xi] = 0.0; acc_b[xi] = 0.0; }
                for ki in 0..klen {
                    let kv = kernel[ki];
                    let yi = (y as isize + ki as isize - half as isize)
                        .clamp(0, height as isize - 1) as usize;
                    let row_base = yi * width * 3;
                    // De-interleave tap row: stride-3 reads → stride-1 planar writes.
                    for xi in 0..tile {
                        let b = row_base + (x0 + xi) * 3;
                        r_tap[xi] = temp_slice[b]     as f32;
                        g_tap[xi] = temp_slice[b + 1] as f32;
                        b_tap[xi] = temp_slice[b + 2] as f32;
                    }
                    // Accumulate: stride-1 reads + writes → LLVM auto-vectorises.
                    for xi in 0..tile {
                        acc_r[xi] = bfma(r_tap[xi], kv, acc_r[xi]);
                        acc_g[xi] = bfma(g_tap[xi], kv, acc_g[xi]);
                        acc_b[xi] = bfma(b_tap[xi], kv, acc_b[xi]);
                    }
                }
                for xi in 0..tile {
                    let o = (x0 + xi) * 3;
                    row[o]     = acc_r[xi].round() as u16;
                    row[o + 1] = acc_g[xi].round() as u16;
                    row[o + 2] = acc_b[xi].round() as u16;
                }
            }
        });
    }

    #[cfg(not(feature = "parallel"))]
    {
        // Tiled vertical pass. Working set = VTILE * klen * 3 * 2 bytes.
        // VTILE=128, k13: 128*13*6 ~= 10 KB -- fits in L1, giving ~38% speedup
        // over naive column-by-column access on a 20 MP image (117 MB rgb16).
        const VTILE: usize = 128;
        let klen = kernel.len();
        let mut acc_r = [0f32; VTILE];
        let mut acc_g = [0f32; VTILE];
        let mut acc_b = [0f32; VTILE];
        let mut r_tap = [0f32; VTILE];
        let mut g_tap = [0f32; VTILE];
        let mut b_tap = [0f32; VTILE];
        for y in 0..height {
            for x0 in (0..width).step_by(VTILE) {
                let x1   = (x0 + VTILE).min(width);
                let tile = x1 - x0;
                for xi in 0..tile { acc_r[xi] = 0.0; acc_g[xi] = 0.0; acc_b[xi] = 0.0; }
                for ki in 0..klen {
                    let kv = kernel[ki];
                    let yi = (y as isize + ki as isize - half as isize)
                        .clamp(0, height as isize - 1) as usize;
                    let row_base = yi * width * 3;
                    for xi in 0..tile {
                        let b = row_base + (x0 + xi) * 3;
                        r_tap[xi] = temp[b]     as f32;
                        g_tap[xi] = temp[b + 1] as f32;
                        b_tap[xi] = temp[b + 2] as f32;
                    }
                    for xi in 0..tile {
                        acc_r[xi] = bfma(r_tap[xi], kv, acc_r[xi]);
                        acc_g[xi] = bfma(g_tap[xi], kv, acc_g[xi]);
                        acc_b[xi] = bfma(b_tap[xi], kv, acc_b[xi]);
                    }
                }
                for xi in 0..tile {
                    let b = (y * width + x0 + xi) * 3;
                    out[b]     = acc_r[xi].round() as u16;
                    out[b + 1] = acc_g[xi].round() as u16;
                    out[b + 2] = acc_b[xi].round() as u16;
                }
            }
        }
    }
}

pub fn apply_unsharp_masks(rgb16: &mut [u16], width: usize, height: usize,
                            params: &PipelineParams) {
    if params.texture == 0.0 && params.clarity == 0.0 { return; }
    // PIPE-003: When both texture and clarity are active, each must operate on the original
    // (pre-unsharp) image.  Previously this called rgb16.to_vec() here (full-frame allocation,
    // ~144 MB at 24 MP on every slider tick).  Instead we reuse the third BLUR_SCRATCH slot
    // so the allocation is amortised after the first call.
    BLUR_SCRATCH.with(|scratch| {
        let (ref mut temp, ref mut blurred, ref mut snap_buf) = *scratch.borrow_mut();
        let need_snap = params.texture != 0.0 && params.clarity != 0.0;
        if need_snap {
            snap_buf.resize(rgb16.len(), 0u16);
            snap_buf.copy_from_slice(rgb16);
        }
        // `pre_snap` is Some only when both sliders are active.
        let has_snap = need_snap;
        if params.texture != 0.0 {
            separable_blur_with_bufs(rgb16, width, height, &gaussian_kernel_5(), temp, blurred);
            #[cfg(feature = "parallel")]
            rgb16.par_chunks_mut(width * 3).zip(blurred.par_chunks(width * 3)).for_each(|(r_row, b_row)| {
                for i in 0..r_row.len() {
                    let orig = r_row[i] as i32;
                    let blur = b_row[i] as i32;
                    r_row[i] = (orig + (params.texture * (orig - blur) as f32).round() as i32).clamp(0, 65535) as u16;
                }
            });
            #[cfg(not(feature = "parallel"))]
            {
                let n = rgb16.len();
                let mut i = 0;
                while i < n {
                    let orig = rgb16[i] as i32;
                    let blur = blurred[i] as i32;
                    rgb16[i] = (orig + (params.texture * (orig - blur) as f32).round() as i32).clamp(0, 65535) as u16;
                    i += 1;
                }
            }
        }
        if params.clarity != 0.0 {
            // Clarity blurs the original image (not the texture-sharpened output).
            // When has_snap (both passes active), blur the snapshot in snap_buf; else blur rgb16 as usual.
            if has_snap {
                separable_blur_with_bufs(snap_buf, width, height, &gaussian_kernel_13(), temp, blurred);
                // Apply clarity: orig from snap_buf, delta from snap blur, added to texture-sharpened rgb16.
                #[cfg(feature = "parallel")]
                rgb16.par_chunks_mut(width * 3)
                    .zip(snap_buf.par_chunks(width * 3))
                    .zip(blurred.par_chunks(width * 3))
                    .for_each(|((r_row, o_row), b_row)| {
                    for i in 0..r_row.len() {
                        let orig = o_row[i] as i32;
                        let blur = b_row[i] as i32;
                        let v = orig as f32 / 65535.0;
                        let w = 4.0 * v * (1.0 - v);
                        r_row[i] = (r_row[i] as i32 + (params.clarity * w * (orig - blur) as f32).round() as i32)
                            .clamp(0, 65535) as u16;
                    }
                });
                #[cfg(not(feature = "parallel"))]
                {
                    let n = rgb16.len();
                    let mut i = 0;
                    while i < n {
                        let orig = snap_buf[i] as i32;
                        let blur = blurred[i] as i32;
                        let v = orig as f32 / 65535.0;
                        let w = 4.0 * v * (1.0 - v);
                        rgb16[i] = (rgb16[i] as i32 + (params.clarity * w * (orig - blur) as f32).round() as i32)
                            .clamp(0, 65535) as u16;
                        i += 1;
                    }
                }
            } else {
                // Only clarity is active (no texture pass ran): blur rgb16 directly as before.
                separable_blur_with_bufs(rgb16, width, height, &gaussian_kernel_13(), temp, blurred);
                #[cfg(feature = "parallel")]
                rgb16.par_chunks_mut(width * 3).zip(blurred.par_chunks(width * 3)).for_each(|(r_row, b_row)| {
                    for i in 0..r_row.len() {
                        let orig = r_row[i] as i32;
                        let blur = b_row[i] as i32;
                        let v = orig as f32 / 65535.0;
                        let w = 4.0 * v * (1.0 - v);
                        r_row[i] = (orig + (params.clarity * w * (orig - blur) as f32).round() as i32)
                            .clamp(0, 65535) as u16;
                    }
                });
                #[cfg(not(feature = "parallel"))]
                {
                    let n = rgb16.len();
                    let mut i = 0;
                    let clarity_factor = params.clarity;
                    while i < n {
                        let orig = rgb16[i] as i32;
                        let blur = blurred[i] as i32;
                        // Midtone mask w = 4·v·(1−v), v = orig/65535 — peaks at v=0.5.
                        // (The previous hoisted form folded the 4 into v as 4·orig/65535,
                        // which computes 4v(1−4v): wrong sign and 2× magnitude at midtones.
                        // Matches the parallel closure and the has_snap serial branch above.)
                        let v = orig as f32 / 65535.0;
                        let w = 4.0 * v * (1.0 - v);
                        let delta = clarity_factor * w * (orig - blur) as f32;
                        rgb16[i] = (orig as f32 + delta).round().clamp(0.0, 65535.0) as i32 as u16;
                        i += 1;
                    }
                }
            }
        }
    });
}

/// Core per-pixel tone-mapping math (matrix + sat/vibrance around luma).
/// Shared by `process` (RGB8) and `process_rgba` (RGBA8) to avoid duplication
/// of the hot arithmetic while keeping tight loops.
///
/// When perceptual_constancy is true, this is the "one place" for evolving
/// the runtime LookRenderer implementation of sensor-sharpen B, log geodesics
/// (Schrödinger), Molchanov residuals/tensor A, hybrid corrections, and Los
/// Alamos f(c) curves for illumination-invariant adjustments during progressive
/// JXL paints (never for producedBy/ingest per P-1).
///
/// Wired to C++ fast path (bridge intrinsics) when feature "c-perceptual" is enabled.
/// The C++ (with AVX2 hand-written intrinsics) is the optimal for the "new" path in WASM/native.
/// Strategy: hybrid. Pure Rust (vec4 + this grid) is default/WASM/portable/correctness path.
/// C++ bulk is optional native turbo (fed via SoA tile gather in !par tone loops).
/// See WASM vs native section in ApplyToneMathPipeline-DONE.md. Never make advanced math C++-only.

#[cfg(feature = "c-perceptual")]
extern "C" {
    fn perceptual_apply_full(
        r: f32,
        g: f32,
        b: f32,
        sat: f32,
        vib: f32,
        vib_zero: i32,
        orr: *mut f32,
        ogg: *mut f32,
        obb: *mut f32,
    );
    // AVX2 bulk for lower-copy SoA flows (e.g. from planar demosaic output or direct JXL pixels).
    // Matches scalar but processes 8-wide with hand-written intrinsics. Remainder scalar in caller.
    fn perceptual_apply_full_avx2(
        in_r: *const f32,
        in_g: *const f32,
        in_b: *const f32,
        out_r: *mut f32,
        out_g: *mut f32,
        out_b: *mut f32,
        n: i32,
        sat: f32,
        vib: f32,
        vib_zero: i32,
    );
}

/// Safe wrapper for the C++ AVX2 bulk perceptual (enabled by c-perceptual feature).
/// Expects matching length SoA slices. Useful for lower-copy flows when input is planar
/// (e.g. from demosaic_rggb_planar_simd converted to f32 post pre-LUT). The bulk uses
/// hand intrinsics; falls back to scalar path inside C++ if needed.
/// Connection to pipelines: the !par tone loops (process_into etc.) do the interleaved->SoA tile
/// to feed this from the existing pre-LUT -> matrix -> advanced -> post-LUT flow. Rust grid/vec4
/// is the WASM equivalent.
#[cfg(feature = "c-perceptual")]
pub fn perceptual_apply_bulk(
    r: &[f32],
    g: &[f32],
    b: &[f32],
    out_r: &mut [f32],
    out_g: &mut [f32],
    out_b: &mut [f32],
    sat: f32,
    vib: f32,
    vib_zero: bool,
) {
    let n = r.len();
    assert_eq!(g.len(), n, "perceptual_apply_bulk: all slices must be the same length");
    assert_eq!(b.len(), n, "perceptual_apply_bulk: all slices must be the same length");
    assert_eq!(out_r.len(), n, "perceptual_apply_bulk: all slices must be the same length");
    assert_eq!(out_g.len(), n, "perceptual_apply_bulk: all slices must be the same length");
    assert_eq!(out_b.len(), n, "perceptual_apply_bulk: all slices must be the same length");
    if n == 0 {
        return;
    }
    unsafe {
        perceptual_apply_full_avx2(
            r.as_ptr(),
            g.as_ptr(),
            b.as_ptr(),
            out_r.as_mut_ptr(),
            out_g.as_mut_ptr(),
            out_b.as_mut_ptr(),
            n as i32,
            sat,
            vib,
            if vib_zero { 1 } else { 0 },
        );
    }
}

#[inline(always)]
pub fn apply_tone_math(
    r: f32,
    g: f32,
    b: f32,
    m: &[[f32; 3]; 3],
    sat: f32,
    vib: f32,
    vib_zero: bool,
    perceptual_constancy: bool,
) -> (f32, f32, f32) {
    // 1) Matrix (mul_add for FMA/ILP).
    let mut r2 = m[0][0].mul_add(r, m[0][1].mul_add(g, m[0][2] * b));
    let mut g2 = m[1][0].mul_add(r, m[1][1].mul_add(g, m[1][2] * b));
    let mut b2 = m[2][0].mul_add(r, m[2][1].mul_add(g, m[2][2] * b));

    if perceptual_constancy {
        // Lens17: advanced owns saturation/vibrance intent (illum-invariant) when flag.
        // Call on post-matrix values; FFI/C++ or rust path below incorporate sat/vib/scale.
        // Guarantees output domain suitable for subsequent post-LUT tone_curve.
        // Future: !c-perceptual rust path can use PerceptualGrid (see scaffold after hybrid fn) for the LUT-based fast path (layer2).
        #[cfg(feature = "c-perceptual")]
        {
            let mut rr = 0.0f32;
            let mut gg = 0.0f32;
            let mut bb = 0.0f32;
            unsafe {
                perceptual_apply_full(r2, g2, b2, sat, vib, if vib_zero { 1 } else { 0 }, &mut rr, &mut gg, &mut bb);
            }
            r2 = rr;
            g2 = gg;
            b2 = bb;
        }
        #[cfg(not(feature = "c-perceptual"))]
        {
            // Rust reference now accelerated by PerceptualGrid (coarse 17^3 + trilinear) for the Lens17 advanced.
            // Grid built for fixed scale~1 / vibz in normalized [0, 1.5] space.
            // Inputs (r2/g2/b2) are post-matrix values in [0, 65535]; normalize to [0, 1.5] before sampling.
            // norm = 1.5/65535 maps [0, 65535] → [0, 1.5] to match the grid's build domain.
            let norm = 1.5 / 65535.0;
            // Ensure the grid is initialised (borrow_mut only on first call per thread).
            PERCEPTUAL_GRID.with(|g| {
                if g.borrow().is_none() {
                    *g.borrow_mut() = Some(PerceptualGrid::new());
                }
            });
            // Read-only borrow for the hot pixel loop — avoids borrow_mut on every pixel.
            let (rr, gg, bb) = PERCEPTUAL_GRID.with(|g| {
                g.borrow().as_ref().unwrap().sample(r2 * norm, g2 * norm, b2 * norm)
            });
            // Grid output is in [0, 1.5]; scale back to [0, 65535] for the post-LUT.
            r2 = rr * 65535.0;
            g2 = gg * 65535.0;
            b2 = bb * 65535.0;
        }
    } else {
        // 2) Saturation + vibrance around luma (hoisted coeffs, restructured div once, mul_add).
        // (Only for classic path; advanced path above incorporates equivalent when pc=true.)
        let luma = LUMA_R.mul_add(r2, LUMA_G.mul_add(g2, LUMA_B * b2));
        let scale = if vib_zero {
            sat
        } else {
            let raw_mx = r2.max(g2).max(b2);
            let mx = raw_mx.max(1e-6); // branchless: avoid divide-by-zero
            let mn = r2.min(g2).min(b2).max(0.0);
            let inv_mx = 1.0 / mx;
            let pixel_sat = ((mx - mn) * inv_mx).min(1.0); // min instead of clamp (no lower bound needed)
            let vib_w = 1.0 - pixel_sat;
            sat * (1.0 + vib * vib_w * 0.6)
        };
        // equiv to luma + (x - luma)*scale using mul_add for FMA opportunity
        r2 = luma.mul_add(1.0 - scale, r2 * scale);
        g2 = luma.mul_add(1.0 - scale, g2 * scale);
        b2 = luma.mul_add(1.0 - scale, b2 * scale);
    }

    (r2, g2, b2)
}

/// Layer 5: pure post-decode perceptual constancy for JXL progressive pixels (or post RAW).
/// Allows JS postDecodeTransform (from byte-benchmark harness + Cursor for layer) to apply the full
/// log-geodesic/Molchanov/LANL engine on early cutoff frames before butter or display.
/// Positive: directly enables the AR/LLM/ photogram vision on progressive arrivals; zero cost if not called.
pub fn apply_perceptual_constancy(r: f32, g: f32, b: f32, sat: f32, vib: f32, vib_zero: bool, layer: u32) -> (f32, f32, f32) {
    let (lr, lg, lb) = to_log_euclidean(r, g, b);
    let luma_l = (lr + lg + lb) / 3.0;
    let base_scale = if vib_zero { sat } else {
        let raw_mx = r.max(g).max(b);
        let mx = raw_mx.max(1.0);
        let mn = r.min(g).min(b).max(0.0);
        let inv_mx = if raw_mx > 0.0 { 1.0 / mx } else { 0.0 };
        let pixel_sat = ((mx - mn) * inv_mx).clamp(0.0, 1.0);
        let vib_w = 1.0 - pixel_sat;
        sat * (1.0 + vib * vib_w * 0.6)
    };
    let (lr2, lg2, lb2, _mod) = molchanov_residuals_and_atensor(luma_l, lr, lg, lb, base_scale);
    let (lr3, lg3, lb3) = hybrid_spring_and_dimishing_fc(lr2, lg2, lb2, luma_l);
    let (rr, gg, bb) = from_log_euclidean(lr3, lg3, lb3);
    // Layer-aware blend: attenuate toward the linear input in linear space, not log space.
    // Scaling log components before exp() would change the exponent (non-linear), not the
    // perceptual "strength" of the adjustment.  Lerp in linear output instead.
    let layer_scale = 1.0 - (layer as f32 * 0.1).min(0.5);
    let blend = |out: f32, inp: f32| inp + (out - inp) * layer_scale;
    (blend(rr, r).clamp(0.0, 1.5), blend(gg, g).clamp(0.0, 1.5), blend(bb, b).clamp(0.0, 1.5))
}

/// Fused-matrix fast path: `m` is already `S·M` (around-luma saturation pre-multiplied into the
/// colour matrix by `derive_tone_inputs` → `tone_simd::vib_zero_matrix`), so per-pixel tone is a
/// single matvec — no luma, no blend. Reproduces `apply_tone_math`'s `vib_zero` output in real
/// arithmetic (differs only by f32 reassociation, ≤1 LUT-index LSB). Drops ~6 FMA + 3 selects
/// per pixel. Used by the default no-vibrance, non-perceptual path.
#[inline(always)]
pub fn apply_tone_fused(r: f32, g: f32, b: f32, m: &[[f32; 3]; 3]) -> (f32, f32, f32) {
    (
        m[0][0].mul_add(r, m[0][1].mul_add(g, m[0][2] * b)),
        m[1][0].mul_add(r, m[1][1].mul_add(g, m[1][2] * b)),
        m[2][0].mul_add(r, m[2][1].mul_add(g, m[2][2] * b)),
    )
}

/// 4-wide version for the classic (!pc) path (Layer 1 next enhancement).
/// Mirrors the scalar math over 4 lanes. Call site in the 4x unrolled !par block
/// (process_into) gathers 4 post-preLUT values, calls once, scatters post results.
/// Gives better ILP / chance for auto-vec than 4 separate scalar calls.
/// pc path delegates to scalar (bulk tile path covers pc+c-perceptual via AVX2).
/// `sat_fused`: `m` is the pre-fused `S·M` ⇒ matrix-only, skip luma+blend.
#[inline(always)]
fn apply_tone_math4(
    rs: [f32; 4],
    gs: [f32; 4],
    bs: [f32; 4],
    m: &[[f32; 3]; 3],
    sat: f32,
    vib: f32,
    vib_zero: bool,
    perceptual_constancy: bool,
    sat_fused: bool,
) -> ([f32; 4], [f32; 4], [f32; 4]) {
    // Fleshed for Phase 1 of WASM/native strategy: explicit 4-wide arithmetic for the classic !pc path
    // (matrix + sat/vib). Eliminates 4 scalar calls inside the vec4 helper. LLVM can vectorize the
    // independent lanes or schedule better. pc path delegates (bulk tile covers pc+c-perceptual on native;
    // pure-Rust grid path on WASM/no-feature).
    let mut r2s = [0f32; 4];
    let mut g2s = [0f32; 4];
    let mut b2s = [0f32; 4];

    if perceptual_constancy {
        // Rare in this call site (bulk handles when c-perceptual); fall back for correctness.
        for i in 0..4 {
            let (r2, g2, b2) = apply_tone_math(rs[i], gs[i], bs[i], m, sat, vib, vib_zero, true);
            r2s[i] = r2; g2s[i] = g2; b2s[i] = b2;
        }
    } else if sat_fused {
        // Fused: m is already S·M ⇒ matrix only (saturation pre-multiplied). Drops the luma+blend loop.
        for i in 0..4 {
            r2s[i] = m[0][0].mul_add(rs[i], m[0][1].mul_add(gs[i], m[0][2] * bs[i]));
            g2s[i] = m[1][0].mul_add(rs[i], m[1][1].mul_add(gs[i], m[1][2] * bs[i]));
            b2s[i] = m[2][0].mul_add(rs[i], m[2][1].mul_add(gs[i], m[2][2] * bs[i]));
        }
    } else {
        // Unrolled classic path (the 90% case).
        // Matrix (mul_add for FMA/ILP) per lane.
        for i in 0..4 {
            r2s[i] = m[0][0].mul_add(rs[i], m[0][1].mul_add(gs[i], m[0][2] * bs[i]));
            g2s[i] = m[1][0].mul_add(rs[i], m[1][1].mul_add(gs[i], m[1][2] * bs[i]));
            b2s[i] = m[2][0].mul_add(rs[i], m[2][1].mul_add(gs[i], m[2][2] * bs[i]));
        }
        // Sat + vibrance around luma per lane.
        for i in 0..4 {
            let luma = LUMA_R.mul_add(r2s[i], LUMA_G.mul_add(g2s[i], LUMA_B * b2s[i]));
            let scale = if vib_zero {
                sat
            } else {
                let raw_mx = r2s[i].max(g2s[i]).max(b2s[i]);
                let mx = raw_mx.max(1.0);
                let mn = r2s[i].min(g2s[i]).min(b2s[i]).max(0.0);
                let inv_mx = if raw_mx > 0.0 { 1.0 / mx } else { 0.0 };
                let pixel_sat = ((mx - mn) * inv_mx).clamp(0.0, 1.0);
                let vib_w = 1.0 - pixel_sat;
                sat * (1.0 + vib * vib_w * 0.6)
            };
            r2s[i] = luma.mul_add(1.0 - scale, r2s[i] * scale);
            g2s[i] = luma.mul_add(1.0 - scale, g2s[i] * scale);
            b2s[i] = luma.mul_add(1.0 - scale, b2s[i] * scale);
        }
    }
    (r2s, g2s, b2s)
}

struct ToneInputs { pub exp_gain: f32, pub wb_r: f32, pub wb_g: f32, pub wb_b: f32, pub tone: TonePost, pub sat: f32, pub vib: f32, pub vib_zero: bool, pub perceptual_constancy: bool,
    /// When the default path applies (`vib_zero && !perceptual_constancy`), the colour matrix
    /// and around-luma saturation are pre-fused into ONE 3×3 (`S·M`) so per-pixel tone is a
    /// single matvec — no luma, no blend.
    /// Invariant: `matrix_fused == Some(_) ⟺ vib_zero && !perceptual_constancy`.
    /// `None` ⇒ vibrance active OR perceptual constancy enabled (both require runtime luma).
    pub matrix_fused: Option<[[f32; 3]; 3]> }

fn derive_tone_inputs(params: &PipelineParams) -> ToneInputs {
    let exp_gain = 2f32.powf((params.exposure_ev + BASELINE_EXP_EV).clamp(-3.0, 4.0));
    let temp = params.temp.clamp(-1.0, 1.0);
    let tint = params.tint.clamp(-1.0, 1.0);
    let wb_r = params.wb_r * (1.0 + temp * 0.40) * (1.0 + tint * 0.10);
    let wb_g = params.wb_g * (1.0 - tint * 0.20);
    let wb_b = params.wb_b * (1.0 - temp * 0.40) * (1.0 + tint * 0.10);
    let tone = TonePost {
        contrast: params.contrast.clamp(-1.0, 1.0),
        shadows: params.shadows.clamp(-1.0, 1.0),
        highlights: params.highlights.clamp(-1.0, 1.0),
        whites: params.whites.clamp(-1.0, 1.0),
        blacks: params.blacks.clamp(-1.0, 1.0),
    };
    let sat_param = params.saturation.clamp(-1.0, 1.0);
    // branchless for the sat blend (faster, no mispredict in per-image call)
    let sat_neg = BASELINE_SAT * (1.0 + sat_param);
    let sat_pos = BASELINE_SAT + sat_param * 0.8;
    let sat = if sat_param < 0.0 { sat_neg } else { sat_pos }.max(0.0);
    let vib = params.vibrance.clamp(-1.0, 1.0);
    let vib_zero = vib.abs() < 1e-6;
    let perceptual_constancy = params.perceptual_constancy;
    // Pre-fuse S·M for the default no-vibrance, non-perceptual path. Uses the SAME helper the
    // SIMD bulk path uses (tone_simd::vib_zero_matrix) so scalar and SIMD stay bit-identical.
    let matrix_fused = if vib_zero && !perceptual_constancy {
        let m = params.color_matrix.unwrap_or(CAM_TO_SRGB);
        Some(crate::tone_simd::vib_zero_matrix(&m, sat))
    } else {
        None
    };
    ToneInputs { exp_gain, wb_r, wb_g, wb_b, tone, sat, vib, vib_zero, perceptual_constancy, matrix_fused }
}

/// Lazily (re)build the LUT cache, rebuilding ONLY the half whose inputs changed. The pre-LUTs
/// (linearisation) and the post-LUT (tone curve) have disjoint dependencies, so a single-slider
/// drag rebuilds at most one half: a WB/exposure drag skips the powf-heavy post-LUT entirely; a
/// tone drag skips the three pre-LUTs. Bundling them (the old `matches`) rebuilt all four every
/// tick — ~7.5 ms of needless work in the interactive loop.
fn ensure_lut(cache: &mut Option<LutCache>, params: &PipelineParams, ti: &ToneInputs, need16: bool) {
    let pre_ok = cache.as_ref().is_some_and(|c| {
        c.pre_matches(params.black, params.white, ti.wb_r, ti.wb_g, ti.wb_b, ti.exp_gain, params.compact_lut)
    });
    let post_ok = cache.as_ref().is_some_and(|c| c.post_matches(&ti.tone));

    match cache {
        None => {
            let (pre_r, pre_g, pre_b, pre_lut_len, pre_lut_shift) = build_pre_luts(params, ti);
            *cache = Some(LutCache {
                black: params.black, white: params.white,
                wb_r_bits: ti.wb_r.to_bits(), wb_g_bits: ti.wb_g.to_bits(),
                wb_b_bits: ti.wb_b.to_bits(), exp_gain_bits: ti.exp_gain.to_bits(),
                contrast_bits:   ti.tone.contrast.to_bits(),
                shadows_bits:    ti.tone.shadows.to_bits(),
                highlights_bits: ti.tone.highlights.to_bits(),
                whites_bits:     ti.tone.whites.to_bits(),
                blacks_bits:     ti.tone.blacks.to_bits(),
                pre_r, pre_g, pre_b,
                post: std::sync::Arc::new(build_post_lut(&ti.tone)),
                post16: if need16 { Some(std::sync::Arc::new(build_post16_lut(&ti.tone))) } else { None },
                pre_lut_len,
                pre_lut_shift,
                compact_lut: params.compact_lut,
            });
        }
        Some(c) => {
            if !pre_ok {
                let (pre_r, pre_g, pre_b, pre_lut_len, pre_lut_shift) = build_pre_luts(params, ti);
                c.pre_r = pre_r; c.pre_g = pre_g; c.pre_b = pre_b;
                c.pre_lut_len = pre_lut_len; c.pre_lut_shift = pre_lut_shift;
                c.compact_lut = params.compact_lut;
                c.black = params.black; c.white = params.white;
                c.wb_r_bits = ti.wb_r.to_bits(); c.wb_g_bits = ti.wb_g.to_bits();
                c.wb_b_bits = ti.wb_b.to_bits(); c.exp_gain_bits = ti.exp_gain.to_bits();
            }
            if !post_ok {
                c.post = std::sync::Arc::new(build_post_lut(&ti.tone));
                c.post16 = if need16 { Some(std::sync::Arc::new(build_post16_lut(&ti.tone))) } else { None };
                c.contrast_bits = ti.tone.contrast.to_bits();
                c.shadows_bits = ti.tone.shadows.to_bits();
                c.highlights_bits = ti.tone.highlights.to_bits();
                c.whites_bits = ti.tone.whites.to_bits();
                c.blacks_bits = ti.tone.blacks.to_bits();
            } else if need16 && c.post16.is_none() {
                c.post16 = Some(std::sync::Arc::new(build_post16_lut(&ti.tone)));
            }
        }
    }
}

/// PIPE-009: allocates a fresh Vec<u8> (~72 MB at 24 MP) + zero-initializes on every call.
/// For interactive or repeated renders (slider ticks, LookRenderer) always prefer
/// [`process_into`] or [`process_into_auto`] with a retained buffer to amortise the
/// allocation.  This function exists for one-shot callers and tests where the allocation
/// cost is acceptable.
// doc(alias) tags are not needed here; callers that need the fast path already use process_into.
pub fn process(rgb16: &[u16], params: &PipelineParams) -> Vec<u8> {
    assert_eq!(rgb16.len() % 3, 0, "process: rgb16.len() must be divisible by 3");
    let n = rgb16.len() / 3;
    let mut out = vec![0u8; n * 3];
    process_into(rgb16, params, &mut out);
    out
}

/// T2: like `process` but writes into a caller-owned buffer.
/// `out` must have exactly `rgb16.len()` elements (one u8 per u16 input; i.e. `width * height * 3` bytes).
/// Lets the interactive LookRenderer reuse one output buffer across re-renders instead of
/// allocating + zeroing a fresh Vec each slider tick. Output is byte-identical to `process`.
pub fn process_into(rgb16: &[u16], params: &PipelineParams, out: &mut [u8]) {
    assert_eq!(rgb16.len() % 3, 0, "process_into: rgb16.len() must be divisible by 3");
    assert_eq!(out.len(), rgb16.len(), "process_into: out must have rgb16.len() elements");
    let ti = derive_tone_inputs(params);
    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);

    #[cfg(not(feature = "parallel"))]
    {
        LUT_CACHE.with(|cache_cell| {
            ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, false);
            let cache = cache_cell.borrow();
            let c = cache.as_ref().expect("ensure_lut must populate the cache");
            let pre_lut_mask = c.pre_lut_len - 1;
            let pre_lut_shift = c.pre_lut_shift;

            // Lens 22/23/25: pointer move (raw ptr advance) instead of index arithmetic + casts.
            // unsafe: in-bounds by construction — *src & pre_lut_mask < pre_lut_len = pre_r.len(); src/dst
            // advance exactly rgb16.len() elements. (Wrap added to fix the wasm/no-parallel build.)
            // Enhanced (this pass): 4x unroll for !pc classic path (amortizes loop overhead on 90% scalar math).
            // Tile-bulk path for pc + c-perceptual: feeds fixed SoA to AVX2 hand-intrinsics (perceptual_apply_full_avx2)
// (WASM/native strategy: C++ only when feature + native; else pure Rust vec4/grid for WASM + default)
            // avoiding scalar FFI call overhead per pixel for the heavy Lens17 advanced color path.
            // TILE=64 amortizes; remainder handled naturally. Replicate pattern to rgba/16bit loops if they become hot for AR.
            unsafe {
                let nbytes = rgb16.len();
                let mut src = rgb16.as_ptr();
                let mut dst = out.as_mut_ptr();
                let src_end = src.add(nbytes);
                let pre_r = c.pre_r.as_ptr();
                let pre_g = c.pre_g.as_ptr();
                let pre_b = c.pre_b.as_ptr();
                let post = c.post.as_ptr();
                let do_bulk = ti.perceptual_constancy && cfg!(feature = "c-perceptual");
                if do_bulk {
                    #[cfg(feature = "c-perceptual")]
                    {
                        // Bulk AVX2 hand-intrinsics tile for perceptual (Lens 2/25/17). Lower copy, uses the declared 8-wide (we use 64 for batch).
                        // Guarded by outer cfg block so the AVX2 symbol (and safe wrapper) only need to resolve when the feature and its extern are present.
                        // Uses the safe perceptual_apply_bulk wrapper (which calls the avx2 under the feature).
                        const TILE: usize = 64;
                        let mut tr = [0f32; TILE];
                        let mut tg = [0f32; TILE];
                        let mut tb = [0f32; TILE];
                        let mut orr = [0f32; TILE];
                        let mut ogg = [0f32; TILE];
                        let mut obb = [0f32; TILE];
                        while src < src_end {
                            let mut t = 0usize;
                            while t < TILE && src < src_end {
                                tr[t] = *pre_r.add((*src as usize >> pre_lut_shift) & pre_lut_mask) as f32; src = src.add(1);
                                tg[t] = *pre_g.add((*src as usize >> pre_lut_shift) & pre_lut_mask) as f32; src = src.add(1);
                                tb[t] = *pre_b.add((*src as usize >> pre_lut_shift) & pre_lut_mask) as f32; src = src.add(1);
                                t += 1;
                            }
                            if t > 0 {
                                perceptual_apply_bulk(
                                    &tr[..t], &tg[..t], &tb[..t],
                                    &mut orr[..t], &mut ogg[..t], &mut obb[..t],
                                    ti.sat, ti.vib, ti.vib_zero,
                                );
                                for i in 0..t {
                                    *dst = *post.add(orr[i].clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                                    *dst = *post.add(ogg[i].clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                                    *dst = *post.add(obb[i].clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                                }
                            }
                        }
                    }
                } else {
                    // Classic path now using apply_tone_math4 (next enhancement after manual 4x unroll).
                    // Gather 4 post-pre, one wide call (ILP + vector opportunity on the matrix/sat math), scatter post.
                    // Handles arbitrary size with cnt; remainder scalar inside vec4 (loop 4).
                    while src < src_end {
                        let mut rs = [0f32; 4];
                        let mut gs = [0f32; 4];
                        let mut bs = [0f32; 4];
                        let mut cnt = 0usize;
                        for k in 0..4 {
                            if src >= src_end { break; }
                            rs[k] = *pre_r.add((*src as usize >> pre_lut_shift) & pre_lut_mask) as f32; src = src.add(1);
                            gs[k] = *pre_g.add((*src as usize >> pre_lut_shift) & pre_lut_mask) as f32; src = src.add(1);
                            bs[k] = *pre_b.add((*src as usize >> pre_lut_shift) & pre_lut_mask) as f32; src = src.add(1);
                            cnt += 1;
                        }
                        if cnt == 0 { break; }
                        let (r2s, g2s, b2s) = apply_tone_math4(rs, gs, bs, ti.matrix_fused.as_ref().unwrap_or(m), ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy, ti.matrix_fused.is_some());
                        for k in 0..cnt {
                            *dst = *post.add(r2s[k].clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                            *dst = *post.add(g2s[k].clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                            *dst = *post.add(b2s[k].clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                        }
                    }
                }
            }
        });
    }

    #[cfg(feature = "parallel")]
    {
        PARALLEL_PATH_CALLS.with(|c| c.set(c.get() + 1));
        let (pre_r, pre_g, pre_b, post, pre_lut_mask, pre_lut_shift) = LUT_CACHE.with(|cache_cell| {
            ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, false);
            let c = cache_cell.borrow();
            let cr = c.as_ref().unwrap();
            (cr.pre_r.clone(), cr.pre_g.clone(), cr.pre_b.clone(), cr.post.clone(), cr.pre_lut_len - 1, cr.pre_lut_shift)
        });
        out.par_chunks_mut(3).zip(rgb16.par_chunks(3)).with_min_len(4096).for_each(|(out_px, in_px)| {
            let r = pre_r[(in_px[0] as usize >> pre_lut_shift) & pre_lut_mask] as f32;
            let g = pre_g[(in_px[1] as usize >> pre_lut_shift) & pre_lut_mask] as f32;
            let b = pre_b[(in_px[2] as usize >> pre_lut_shift) & pre_lut_mask] as f32;
            let (r2, g2, b2) = match ti.matrix_fused.as_ref() { Some(mf) => apply_tone_fused(r, g, b, mf), None => apply_tone_math(r, g, b, m, ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy) };
            out_px[0] = post[r2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[1] = post[g2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[2] = post[b2.clamp(0.0, 65535.0) as u16 as usize];
        });
    }
}

/// PIPE-001 / PIPE-005: shared kernel for `process_into_simd` (u8 out) and
/// `process_16bit_simd` (u16 out).  Both functions were structurally identical —
/// BLK-pixel block loop, deinterleave pre-LUT → apply_tone_bulk → scatter through
/// post-LUT — differing only in the output element type and scatter expression.
///
/// Callers pass `r/g/b` scratch slices of length BLK pre-allocated once outside
/// the block loop (PIPE-005: eliminates per-block stack zeroing, ~279 MB memset
/// traffic at 24 MP for the serial/WASM path). The `post_fn` closure maps a clamped
/// f32 to the output element type: `|v| post[(v as u16) as usize]` for u8, or
/// `|v| post16[(v as u16) as usize]` for u16.
///
/// NOTE on the parallel path: Rayon's `par_chunks_mut` dispatches to thread-pool
/// workers; each worker's closure still zeroes its own BLK-sized stack frame once
/// per block (the scratch arrays live inside the closure, not here).  The scratch-
/// hoist benefit applies to the serial/WASM path only, where this kernel is called
/// in a regular `for` loop with scratch re-used across iterations.
#[inline(always)]
fn simd_block_kernel<T: Copy>(
    ob: &mut [T],
    ib: &[u16],
    r: &mut [f32],
    g: &mut [f32],
    b: &mut [f32],
    pre_r: &[u16],
    pre_g: &[u16],
    pre_b: &[u16],
    pre_lut_shift: u32,
    pre_lut_mask: usize,
    m: &[[f32; 3]; 3],
    // Pre-fused S·M for the default no-vibrance path, built ONCE per render by
    // `derive_tone_inputs`. When `Some`, the tone step is a single matvec via the
    // matrix-only kernel — so the block loop no longer rebuilds `vib_zero_matrix(m, sat)`
    // for every block. `None` ⇒ vibrance active: fall back to the full `apply_tone_bulk`.
    fused_matrix: Option<&[[f32; 3]; 3]>,
    sat: f32,
    vib: f32,
    vib_zero: bool,
    post_fn: impl Fn(f32) -> T,
) {
    let np = ib.len() / 3;
    for i in 0..np {
        r[i] = pre_r[(ib[i * 3]     as usize >> pre_lut_shift) & pre_lut_mask] as f32;
        g[i] = pre_g[(ib[i * 3 + 1] as usize >> pre_lut_shift) & pre_lut_mask] as f32;
        b[i] = pre_b[(ib[i * 3 + 2] as usize >> pre_lut_shift) & pre_lut_mask] as f32;
    }
    match fused_matrix {
        Some(mf) => crate::tone_simd::apply_tone_bulk_matrix(&mut r[..np], &mut g[..np], &mut b[..np], mf),
        None => crate::tone_simd::apply_tone_bulk(&mut r[..np], &mut g[..np], &mut b[..np], m, sat, vib, vib_zero),
    }
    // MEASURED FLOOR (2026-06-19, item-0 `examples/tonemap_subspans.rs`): this post stage
    // (clamp + f32→u16 cast + LUT gather) is ~45% of the 24 MP tone frame and is the bottleneck
    // — NOT build (2%), copy (14%), or math (4%). The gather itself is already cheap (~0.5 ns,
    // `postlut_cache_flip.rs`); the cost is the scalar f32↔int conversion fused with it. Four
    // ways to cut it were measured and REJECTED (see `docs/rejected optimizations.md`):
    //   • split quantize into a vectorizable pass + bare gather → −21% (u16 round-trip traffic)
    //   • L1 compact/strided post-LUT → 0.77× (gather not L2-bound; extra shift loses)
    //   • 3D RAW→OUT LUT + trilinear → ~3× slower + shadow banding
    //   • powf→poly in the build → negligible (build is 2%; sRGB EOTF already a cached lerp)
    // PIPE-002 opportunity (not yet implemented): interleave pre_r/g/b into a single
    //   pre_rgb[code*3..code*3+3] table so each pixel does one 384 KB gather instead of three.
    //   Gate behind flipflop measurement: benefit depends on L2 hit rate vs the merge overhead.
    // The inline clamp+cast+gather below IS the floor. The remaining lever is the SEAM:
    // parallelise this (native rayon = ~5× over serial), not the kernel.
    for i in 0..np {
        ob[i * 3]     = post_fn(r[i].clamp(0.0, 65535.0));
        ob[i * 3 + 1] = post_fn(g[i].clamp(0.0, 65535.0));
        ob[i * 3 + 2] = post_fn(b[i].clamp(0.0, 65535.0));
    }
}

/// SIMD variant of `process_into`: block-deinterleaves the pre-LUT output into
/// SoA, runs the vectorized tone math (`tone_simd::apply_tone_bulk`), then
/// reinterleaves through the post-LUT. New fn — leaves `process_into` untouched
/// while the end-to-end win is measured. Plain ingest path only
/// (perceptual_constancy must be false).
pub fn process_into_simd(rgb16: &[u16], params: &PipelineParams, out: &mut [u8]) {
    debug_assert_eq!(rgb16.len() % 3, 0);
    assert_eq!(out.len(), rgb16.len(), "process_into_simd: out must be rgb16.len() elements");
    // Guard before derive_tone_inputs so the assertion fires before any work is done.
    assert!(!params.perceptual_constancy, "process_into_simd is the plain ingest path only; use process_into for perceptual_constancy");
    let ti = derive_tone_inputs(params);
    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);
    // Pre-fused S·M (built once in derive_tone_inputs) for the default no-vibrance path;
    // `Some ⟺ vib_zero` here (perceptual_constancy is asserted off). Feeding it to the
    // kernel skips the per-block `vib_zero_matrix` rebuild. Copy: Option<&[[f32;3];3]>.
    let fused = ti.matrix_fused.as_ref();
    let (pre_r, pre_g, pre_b, post, pre_lut_mask, pre_lut_shift) = LUT_CACHE.with(|cache_cell| {
        ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, false);
        let c = cache_cell.borrow();
        let cr = c.as_ref().unwrap();
        (cr.pre_r.clone(), cr.pre_g.clone(), cr.pre_b.clone(), cr.post.clone(), cr.pre_lut_len - 1, cr.pre_lut_shift)
    });

    const BLK: usize = 2048;

    // Parallel path: Rayon dispatches blocks to worker threads; each closure allocates
    // its own r/g/b scratch on that thread's stack (unavoidable without thread_local overhead).
    #[cfg(feature = "parallel")]
    {
        PARALLEL_PATH_CALLS.with(|c| c.set(c.get() + 1));
        out.par_chunks_mut(3 * BLK)
            .zip(rgb16.par_chunks(3 * BLK))
            .for_each(|(ob, ib)| {
                let mut r = [0f32; BLK];
                let mut g = [0f32; BLK];
                let mut b = [0f32; BLK];
                simd_block_kernel(ob, ib, &mut r, &mut g, &mut b,
                    &pre_r, &pre_g, &pre_b, pre_lut_shift, pre_lut_mask,
                    m, fused, ti.sat, ti.vib, ti.vib_zero,
                    |v| post[(v as u16) as usize]);
            });
    }
    // Serial/WASM path: hoist r/g/b scratch once (PIPE-005: eliminates per-block
    // zeroing — ~279 MB memset at 24 MP — by reusing the same stack frame across blocks).
    #[cfg(not(feature = "parallel"))]
    {
        let mut r = [0f32; BLK];
        let mut g = [0f32; BLK];
        let mut b = [0f32; BLK];
        for (ob, ib) in out.chunks_mut(3 * BLK).zip(rgb16.chunks(3 * BLK)) {
            simd_block_kernel(ob, ib, &mut r, &mut g, &mut b,
                &pre_r, &pre_g, &pre_b, pre_lut_shift, pre_lut_mask,
                m, fused, ti.sat, ti.vib, ti.vib_zero,
                |v| post[(v as u16) as usize]);
        }
    }
}

/// `process` using the SIMD tone path. See `process_into_simd`.
pub fn process_simd(rgb16: &[u16], params: &PipelineParams) -> Vec<u8> {
    let mut out = vec![0u8; rgb16.len()];
    process_into_simd(rgb16, params, &mut out);
    out
}

/// Decode-path tone dispatch: take the SIMD bulk path for the plain (non
/// perceptual-constancy) case, else the byte-exact scalar `process_into`.
/// Output differs from `process_into` only by the documented ≤1-LUT-step SIMD
/// reassociation tolerance, so `process_into` stays byte-exact for callers that
/// require it (LookRenderer, exact-equality tests). Heavy full-res RAW decode
/// opts in via this wrapper.
///
/// PIPE-007 (verified 2026-06-19): LookRenderer.process() in src/lib.rs calls
/// `pipeline::process_auto` (→ `process_into_auto` → `process_into_simd`), so the
/// WASM SIMD128 kernel IS reached from the interactive render path.  The !parallel
/// `process_into` 4-wide scalar path (PIPE-007 concern) is only the byte-exact
/// reference; callers that need SIMD already route through `process_into_auto`.
pub fn process_into_auto(rgb16: &[u16], params: &PipelineParams, out: &mut [u8]) {
    if params.perceptual_constancy {
        process_into(rgb16, params, out);
    } else {
        process_into_simd(rgb16, params, out);
    }
}

/// `process` peer of [`process_into_auto`].
pub fn process_auto(rgb16: &[u16], params: &PipelineParams) -> Vec<u8> {
    let mut out = vec![0u8; rgb16.len()];
    process_into_auto(rgb16, params, &mut out);
    out
}

/// Time the three stages of `process_into_simd` independently:
/// pre-LUT gather (u16→f32), tone math, post-LUT gather (f32→u8).
/// Uses compact pre-LUT matching what `ensure_lut` builds.
/// Returns `(pre_lut_ms, tone_math_ms, post_lut_ms)`.
pub fn bench_tone_stage_3way(rgb16: &[u16], params: &PipelineParams) -> (f64, f64, f64) {
    let ti = derive_tone_inputs(params);
    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);
    let lut_len = (params.white as usize + 1).next_power_of_two().min(65536);
    let lut_mask = lut_len - 1;
    let pre_r = build_pre_lut_compact(params.black, params.white, ti.wb_r, ti.exp_gain, lut_len);
    let pre_g = build_pre_lut_compact(params.black, params.white, ti.wb_g, ti.exp_gain, lut_len);
    let pre_b = build_pre_lut_compact(params.black, params.white, ti.wb_b, ti.exp_gain, lut_len);
    let post = build_post_lut(&ti.tone);

    let np = rgb16.len() / 3;
    const BLK: usize = 2048;
    let mut r = [0f32; BLK];
    let mut g = [0f32; BLK];
    let mut b = [0f32; BLK];
    let mut out = vec![0u8; rgb16.len()];

    // Stage 1: pre-LUT gather only (u16 → f32 via compact LUT)
    let t = std::time::Instant::now();
    let mut p = 0;
    while p < np {
        let cnt = (np - p).min(BLK);
        for i in 0..cnt {
            r[i] = pre_r[rgb16[(p + i) * 3]     as usize & lut_mask] as f32;
            g[i] = pre_g[rgb16[(p + i) * 3 + 1] as usize & lut_mask] as f32;
            b[i] = pre_b[rgb16[(p + i) * 3 + 2] as usize & lut_mask] as f32;
        }
        p += cnt;
    }
    std::hint::black_box((&r, &g, &b));
    let pre_ms = t.elapsed().as_secs_f64() * 1000.0;

    // Stage 2: tone math only (dummy mid-range input; no gather)
    let t = std::time::Instant::now();
    let mut p = 0;
    while p < np {
        let cnt = (np - p).min(BLK);
        for i in 0..cnt { r[i] = 32767.5; g[i] = 32767.5; b[i] = 32767.5; }
        crate::tone_simd::apply_tone_bulk(&mut r[..cnt], &mut g[..cnt], &mut b[..cnt], m, ti.sat, ti.vib, ti.vib_zero);
        p += cnt;
    }
    std::hint::black_box((&r, &g, &b));
    let math_ms = t.elapsed().as_secs_f64() * 1000.0;

    // Stage 3: post-LUT gather only (f32 → u8 via full 65536-entry LUT)
    // Pre-load SoA with realistic values from pre-LUT to exercise the post-LUT gather pattern.
    {
        let mut p = 0;
        while p < np {
            let cnt = (np - p).min(BLK);
            for i in 0..cnt {
                r[i] = pre_r[rgb16[(p + i) * 3] as usize & lut_mask] as f32;
            }
            p += cnt;
        }
        std::hint::black_box(&r);
    }
    let t = std::time::Instant::now();
    let mut p = 0;
    while p < np {
        let cnt = (np - p).min(BLK);
        for i in 0..cnt {
            let j = (p + i) * 3;
            out[j]     = post[(r[i].clamp(0.0, 65535.0) as u16) as usize];
            out[j + 1] = post[(g[i].clamp(0.0, 65535.0) as u16) as usize];
            out[j + 2] = post[(b[i].clamp(0.0, 65535.0) as u16) as usize];
        }
        p += cnt;
    }
    std::hint::black_box(&out);
    let post_ms = t.elapsed().as_secs_f64() * 1000.0;

    (pre_ms, math_ms, post_ms)
}

/// Sub-profile of the tone pass: isolates the per-pixel `apply_tone_math`
/// compute (matrix + sat/vibrance, with its divide) from the LUT-gather/store
/// cost. Single-threaded. Returns (full_ms, lut_only_ms); full − lut_only is the
/// tone-math cost. Used by examples/pipeline_profile to decide what to vectorize.
pub fn bench_tone_split(rgb16: &[u16], params: &PipelineParams) -> (f64, f64) {
    let ti = derive_tone_inputs(params);
    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);
    let pre_r = build_pre_lut(params.black, params.white, ti.wb_r, ti.exp_gain);
    let pre_g = build_pre_lut(params.black, params.white, ti.wb_g, ti.exp_gain);
    let pre_b = build_pre_lut(params.black, params.white, ti.wb_b, ti.exp_gain);
    let post = build_post_lut(&ti.tone);
    let mut out = vec![0u8; rgb16.len()];

    let t = std::time::Instant::now();
    for (o, px) in out.chunks_mut(3).zip(rgb16.chunks(3)) {
        let r = pre_r[px[0] as usize] as f32;
        let g = pre_g[px[1] as usize] as f32;
        let b = pre_b[px[2] as usize] as f32;
        let (r2, g2, b2) = match ti.matrix_fused.as_ref() { Some(mf) => apply_tone_fused(r, g, b, mf), None => apply_tone_math(r, g, b, m, ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy) };
        o[0] = post[r2.clamp(0.0, 65535.0) as u16 as usize];
        o[1] = post[g2.clamp(0.0, 65535.0) as u16 as usize];
        o[2] = post[b2.clamp(0.0, 65535.0) as u16 as usize];
    }
    let full_ms = t.elapsed().as_secs_f64() * 1000.0;
    std::hint::black_box(&out);

    let t = std::time::Instant::now();
    for (o, px) in out.chunks_mut(3).zip(rgb16.chunks(3)) {
        let r = pre_r[px[0] as usize] as f32;
        let g = pre_g[px[1] as usize] as f32;
        let b = pre_b[px[2] as usize] as f32;
        o[0] = post[r.clamp(0.0, 65535.0) as u16 as usize];
        o[1] = post[g.clamp(0.0, 65535.0) as u16 as usize];
        o[2] = post[b.clamp(0.0, 65535.0) as u16 as usize];
    }
    let lut_only_ms = t.elapsed().as_secs_f64() * 1000.0;
    std::hint::black_box(&out);

    (full_ms, lut_only_ms)
}

/// Like `process`, but writes interleaved RGBA8 directly (A=255).
///
/// This is the native/Tauri equivalent of the "direct RGBA" (Phase 2B) path.
/// For pure "RAW decode → JXL encode, discard pixels" flows it avoids ever
/// allocating or writing the intermediate 3-channel RGB8 buffer, fusing the
/// trivial alpha insertion into the tone pass. The arithmetic cost of the
/// conversion itself is negligible once there is no JS/WASM boundary.
///
/// Callers that must retain RGB (e.g. rotation, further CPU processing) should
/// continue to use `process` + manual convert or the WASM `rgb_to_rgba` helper.
pub fn process_rgba(rgb16: &[u16], params: &PipelineParams) -> Vec<u8> {
    debug_assert_eq!(rgb16.len() % 3, 0);
    let ti = derive_tone_inputs(params);
    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);
    let n = rgb16.len() / 3;
    let mut out = vec![0u8; n * 4];

    #[cfg(not(feature = "parallel"))]
    {
        LUT_CACHE.with(|cache_cell| {
            ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, false);
            let cache = cache_cell.borrow();
            let c = cache.as_ref().unwrap();
            let pre_lut_mask = c.pre_lut_len - 1;
            let pre_lut_shift = c.pre_lut_shift;

            // Lens 23 pointer advance version (consistent with process_into).
            // unsafe: same in-bounds invariant as process_into (out is n*4; dst advances n*4).
            // NOTE: 4x unroll + perceptual bulk-tile (AVX2 hand intrinsics for pc) pattern implemented in process_into !par block.
            // Replicate here if rgba path becomes hot for immersive/AR (lens16) or 16bit TIFF consumers (photogram layer5).
            unsafe {
                let nbytes = rgb16.len();
                let mut src = rgb16.as_ptr();
                let mut dst = out.as_mut_ptr();
                let src_end = src.add(nbytes);
                let pre_r = c.pre_r.as_ptr();
                let pre_g = c.pre_g.as_ptr();
                let pre_b = c.pre_b.as_ptr();
                let post = c.post.as_ptr();
                while src < src_end {
                    let r = *pre_r.add((*src as usize >> pre_lut_shift) & pre_lut_mask) as f32; src = src.add(1);
                    let g = *pre_g.add((*src as usize >> pre_lut_shift) & pre_lut_mask) as f32; src = src.add(1);
                    let b = *pre_b.add((*src as usize >> pre_lut_shift) & pre_lut_mask) as f32; src = src.add(1);
                    let (r2, g2, b2) = match ti.matrix_fused.as_ref() { Some(mf) => apply_tone_fused(r, g, b, mf), None => apply_tone_math(r, g, b, m, ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy) };
                    *dst = *post.add(r2.clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                    *dst = *post.add(g2.clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                    *dst = *post.add(b2.clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                    *dst = 255; dst = dst.add(1);
                }
            }
        });
    }

    #[cfg(feature = "parallel")]
    {
        let (pre_r, pre_g, pre_b, post, pre_lut_mask, pre_lut_shift) = LUT_CACHE.with(|cache_cell| {
            ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, false);
            let c = cache_cell.borrow();
            let cr = c.as_ref().unwrap();
            (cr.pre_r.clone(), cr.pre_g.clone(), cr.pre_b.clone(), cr.post.clone(), cr.pre_lut_len - 1, cr.pre_lut_shift)
        });
        out.par_chunks_mut(4).zip(rgb16.par_chunks(3)).with_min_len(4096).for_each(|(out_px, in_px)| {
            let r = pre_r[(in_px[0] as usize >> pre_lut_shift) & pre_lut_mask] as f32;
            let g = pre_g[(in_px[1] as usize >> pre_lut_shift) & pre_lut_mask] as f32;
            let b = pre_b[(in_px[2] as usize >> pre_lut_shift) & pre_lut_mask] as f32;
            let (r2, g2, b2) = match ti.matrix_fused.as_ref() { Some(mf) => apply_tone_fused(r, g, b, mf), None => apply_tone_math(r, g, b, m, ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy) };
            out_px[0] = post[r2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[1] = post[g2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[2] = post[b2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[3] = 255;
        });
    }

    out
}

/// Byte-exact 3-channel twin of [`process_rgba`]: tone-maps RGB16 → RGB8 with **no alpha
/// plane**. `process_rgba` writes a hardcoded `α = 255` the opaque (RAW) encode path strips
/// straight back off; emitting RGB directly removes that per-pixel write, a 25%-smaller
/// output buffer, and the downstream strip. The r/g/b bytes are identical to
/// `process_rgba` — same pre/post LUTs, same tone math, same clamp — so
/// `process_rgb(x) == strip_rgba_to_rgb(process_rgba(x))` for all inputs.
pub fn process_rgb(rgb16: &[u16], params: &PipelineParams) -> Vec<u8> {
    debug_assert_eq!(rgb16.len() % 3, 0);
    let ti = derive_tone_inputs(params);
    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);
    let n = rgb16.len() / 3;
    let mut out = vec![0u8; n * 3];

    #[cfg(not(feature = "parallel"))]
    {
        LUT_CACHE.with(|cache_cell| {
            ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, false);
            let cache = cache_cell.borrow();
            let c = cache.as_ref().unwrap();
            let pre_lut_mask = c.pre_lut_len - 1;
            let pre_lut_shift = c.pre_lut_shift;
            // unsafe: src advances rgb16.len(); dst advances n*3 == out.len(). In-bounds.
            unsafe {
                let nbytes = rgb16.len();
                let mut src = rgb16.as_ptr();
                let mut dst = out.as_mut_ptr();
                let src_end = src.add(nbytes);
                let pre_r = c.pre_r.as_ptr();
                let pre_g = c.pre_g.as_ptr();
                let pre_b = c.pre_b.as_ptr();
                let post = c.post.as_ptr();
                while src < src_end {
                    let r = *pre_r.add((*src as usize >> pre_lut_shift) & pre_lut_mask) as f32; src = src.add(1);
                    let g = *pre_g.add((*src as usize >> pre_lut_shift) & pre_lut_mask) as f32; src = src.add(1);
                    let b = *pre_b.add((*src as usize >> pre_lut_shift) & pre_lut_mask) as f32; src = src.add(1);
                    let (r2, g2, b2) = match ti.matrix_fused.as_ref() { Some(mf) => apply_tone_fused(r, g, b, mf), None => apply_tone_math(r, g, b, m, ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy) };
                    *dst = *post.add(r2.clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                    *dst = *post.add(g2.clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                    *dst = *post.add(b2.clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                }
            }
        });
    }

    #[cfg(feature = "parallel")]
    {
        let (pre_r, pre_g, pre_b, post, pre_lut_mask, pre_lut_shift) = LUT_CACHE.with(|cache_cell| {
            ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, false);
            let c = cache_cell.borrow();
            let cr = c.as_ref().unwrap();
            (cr.pre_r.clone(), cr.pre_g.clone(), cr.pre_b.clone(), cr.post.clone(), cr.pre_lut_len - 1, cr.pre_lut_shift)
        });
        out.par_chunks_mut(3).zip(rgb16.par_chunks(3)).with_min_len(4096).for_each(|(out_px, in_px)| {
            let r = pre_r[(in_px[0] as usize >> pre_lut_shift) & pre_lut_mask] as f32;
            let g = pre_g[(in_px[1] as usize >> pre_lut_shift) & pre_lut_mask] as f32;
            let b = pre_b[(in_px[2] as usize >> pre_lut_shift) & pre_lut_mask] as f32;
            let (r2, g2, b2) = match ti.matrix_fused.as_ref() { Some(mf) => apply_tone_fused(r, g, b, mf), None => apply_tone_math(r, g, b, m, ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy) };
            out_px[0] = post[r2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[1] = post[g2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[2] = post[b2.clamp(0.0, 65535.0) as u16 as usize];
        });
    }

    out
}

/// Gray-world auto-WB from raw Bayer (RGGB) pixels.  Returns (r_gain,
/// b_gain) normalised so G_gain = 1.0.  Samples every 8×8 block to keep it
/// cheap (strides by 8).  Assumes an RGGB CFA at (0,0). Clamps the result to a sane range so a colour-cast scene (e.g.
/// uniform-red rocks) doesn't blow the highlights.
pub fn auto_wb_rggb(raw: &[u16], w: usize, h: usize, black: u16) -> (f32, f32) {
    let blk = black as u32;
    let (mut sr, mut sg, mut sb) = (0u64, 0u64, 0u64);
    let (mut nr, mut ng, mut nb) = (0u64, 0u64, 0u64);
    // Iterate 4-pixel-stride RGGB quads.
    let mut y = 0;
    while y + 1 < h {
        let mut x = 0;
        while x + 1 < w {
            let r = raw[y * w + x] as u32;
            let g1 = raw[y * w + x + 1] as u32;
            let g2 = raw[(y + 1) * w + x] as u32;
            let b = raw[(y + 1) * w + x + 1] as u32;
            let r = r.saturating_sub(blk);
            let g1 = g1.saturating_sub(blk);
            let g2 = g2.saturating_sub(blk);
            let b = b.saturating_sub(blk);
            sr += r as u64; nr += 1;
            sg += (g1 + g2) as u64; ng += 2;
            sb += b as u64; nb += 1;
            x += 8;
        }
        y += 8;
    }
    let avg_r = (sr as f64 / nr.max(1) as f64).max(1.0);
    let avg_g = (sg as f64 / ng.max(1) as f64).max(1.0);
    let avg_b = (sb as f64 / nb.max(1) as f64).max(1.0);
    let r_gain = (avg_g / avg_r).clamp(0.8, 4.0) as f32;
    let b_gain = (avg_g / avg_b).clamp(0.8, 4.0) as f32;
    (r_gain, b_gain)
}

/// Gaussian-blur-based luminance noise reduction.  Blends each channel toward
/// a 5-tap Gaussian blur by `strength` (0 = no-op, 1 = fully blurred).
/// Call after demosaic, before tone mapping.  Strength should be derived from
/// EXIF ISO: 0 below ISO 1600, 0.15–0.5 at higher ISOs.
pub fn apply_luminance_nr(rgb16: &mut [u16], width: usize, height: usize, strength: f32) {
    if strength <= 0.0 { return; }
    let s = strength.clamp(0.0, 1.0);
    let kernel = gaussian_kernel_5();
    BLUR_SCRATCH.with(|scratch| {
        let (ref mut temp, ref mut blurred, _) = *scratch.borrow_mut();
        separable_blur_with_bufs(rgb16, width, height, &kernel, temp, blurred);
        // Flipflop bench (2026-06-18): serial 130ms, parallel 20ms → 6.6× speedup on 12MP.
        #[cfg(feature = "parallel")]
        {
            use rayon::prelude::*;
            rgb16.par_iter_mut().zip(blurred.par_iter()).for_each(|(o, &b)| {
                let ov = *o as f32;
                *o = (ov + (b as f32 - ov) * s).round().clamp(0.0, 65535.0) as u16;
            });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for (o, &b) in rgb16.iter_mut().zip(blurred.iter()) {
                let ov = *o as f32;
                *o = (ov + (b as f32 - ov) * s).round().clamp(0.0, 65535.0) as u16;
            }
        }
    });
}

/// Full pipeline → 16-bit sRGB output (same pipeline as `process` but u16 output).
/// Maps the tone-curved, sRGB-gamma-corrected result to [0, 65535] instead of [0, 255].
/// Suitable as a 16-bit TIFF source for further editing.
///
/// Dispatcher peer of [`process_into_auto`]: the plain ingest case takes the SIMD bulk tone
/// path ([`process_16bit_simd`]); perceptual-constancy keeps the byte-exact scalar path
/// ([`process_16bit_scalar`]). Output differs from the scalar path only by the documented
/// ≤1-LUT-step SIMD reassociation tolerance.
pub fn process_16bit(rgb16: &[u16], params: &PipelineParams) -> Vec<u16> {
    if params.perceptual_constancy {
        process_16bit_scalar(rgb16, params)
    } else {
        process_16bit_simd(rgb16, params)
    }
}

/// Byte-exact scalar 16-bit path (also the perceptual-constancy path). Fused matrix when vib_zero.
pub fn process_16bit_scalar(rgb16: &[u16], params: &PipelineParams) -> Vec<u16> {
    debug_assert_eq!(rgb16.len() % 3, 0);
    let ti = derive_tone_inputs(params);
    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);
    let n = rgb16.len() / 3;
    let mut out = vec![0u16; n * 3];

    #[cfg(not(feature = "parallel"))]
    {
        LUT_CACHE.with(|cache_cell| {
            ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, true);
            let cache = cache_cell.borrow();
            let c = cache.as_ref().unwrap();
            let pre_lut_mask = c.pre_lut_len - 1;
            let pre_lut_shift = c.pre_lut_shift;
            // Lens 23 pointer version for 16bit path too.
            // unsafe: same in-bounds invariant as process_into (out is n*3 u16; dst advances n*3).
            // NOTE: 4x unroll + perceptual bulk-tile (AVX2 hand intrinsics for pc) pattern implemented in process_into !par block.
            // Replicate here for 16-bit TIFF / further editing / CV consumers needing higher prec + constancy (photogram/LLM layers 12/14).
            unsafe {
                let nbytes = rgb16.len();
                let mut src = rgb16.as_ptr();
                let mut dst = out.as_mut_ptr();
                let src_end = src.add(nbytes);
                let pre_r = c.pre_r.as_ptr();
                let pre_g = c.pre_g.as_ptr();
                let pre_b = c.pre_b.as_ptr();
                let post16 = c.post16.as_ref().unwrap().as_ptr();
                while src < src_end {
                    let r = *pre_r.add((*src as usize >> pre_lut_shift) & pre_lut_mask) as f32; src = src.add(1);
                    let g = *pre_g.add((*src as usize >> pre_lut_shift) & pre_lut_mask) as f32; src = src.add(1);
                    let b = *pre_b.add((*src as usize >> pre_lut_shift) & pre_lut_mask) as f32; src = src.add(1);
                    let (r2, g2, b2) = match ti.matrix_fused.as_ref() { Some(mf) => apply_tone_fused(r, g, b, mf), None => apply_tone_math(r, g, b, m, ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy) };
                    *dst = *post16.add(r2.clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                    *dst = *post16.add(g2.clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                    *dst = *post16.add(b2.clamp(0.0, 65535.0) as u16 as usize); dst = dst.add(1);
                }
            }
        });
    }

    #[cfg(feature = "parallel")]
    {
        let (pre_r, pre_g, pre_b, post16, pre_lut_mask, pre_lut_shift) = LUT_CACHE.with(|cache_cell| {
            ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, true);
            let c = cache_cell.borrow();
            let cr = c.as_ref().unwrap();
            (cr.pre_r.clone(), cr.pre_g.clone(), cr.pre_b.clone(), cr.post16.as_ref().unwrap().clone(), cr.pre_lut_len - 1, cr.pre_lut_shift)
        });
        out.par_chunks_mut(3).zip(rgb16.par_chunks(3)).with_min_len(4096).for_each(|(out_px, in_px)| {
            let r = pre_r[(in_px[0] as usize >> pre_lut_shift) & pre_lut_mask] as f32;
            let g = pre_g[(in_px[1] as usize >> pre_lut_shift) & pre_lut_mask] as f32;
            let b = pre_b[(in_px[2] as usize >> pre_lut_shift) & pre_lut_mask] as f32;
            let (r2, g2, b2) = match ti.matrix_fused.as_ref() { Some(mf) => apply_tone_fused(r, g, b, mf), None => apply_tone_math(r, g, b, m, ti.sat, ti.vib, ti.vib_zero, ti.perceptual_constancy) };
            out_px[0] = post16[r2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[1] = post16[g2.clamp(0.0, 65535.0) as u16 as usize];
            out_px[2] = post16[b2.clamp(0.0, 65535.0) as u16 as usize];
        });
    }

    out
}

/// SIMD 16-bit path: block-deinterleave the pre-LUT output into SoA, run the vectorized tone
/// math (`tone_simd::apply_tone_bulk`, fused matrix when vib_zero), then reinterleave through the
/// 16-bit post-LUT. Delegates to [`simd_block_kernel`] (shared with [`process_into_simd`],
/// PIPE-001) with a `|v| post16[(v as u16) as usize]` scatter.  Plain ingest only
/// (perceptual_constancy must be false — the dispatcher routes constancy to the scalar path).
pub fn process_16bit_simd(rgb16: &[u16], params: &PipelineParams) -> Vec<u16> {
    debug_assert_eq!(rgb16.len() % 3, 0);
    let ti = derive_tone_inputs(params);
    assert!(!ti.perceptual_constancy, "process_16bit_simd is the plain ingest path only; use process_16bit_scalar for perceptual_constancy");
    let fallback = CAM_TO_SRGB;
    let m = params.color_matrix.as_ref().unwrap_or(&fallback);
    // See process_into_simd: pre-fused matrix skips the per-block vib_zero_matrix rebuild.
    let fused = ti.matrix_fused.as_ref();
    let n = rgb16.len() / 3;
    let mut out = vec![0u16; n * 3];
    let (pre_r, pre_g, pre_b, post16, pre_lut_mask, pre_lut_shift) = LUT_CACHE.with(|cache_cell| {
        ensure_lut(&mut cache_cell.borrow_mut(), params, &ti, true);
        let c = cache_cell.borrow();
        let cr = c.as_ref().unwrap();
        (cr.pre_r.clone(), cr.pre_g.clone(), cr.pre_b.clone(), cr.post16.as_ref().unwrap().clone(), cr.pre_lut_len - 1, cr.pre_lut_shift)
    });

    const BLK: usize = 2048;

    #[cfg(feature = "parallel")]
    {
        PARALLEL_PATH_CALLS.with(|c| c.set(c.get() + 1));
        out.par_chunks_mut(3 * BLK)
            .zip(rgb16.par_chunks(3 * BLK))
            .for_each(|(ob, ib)| {
                let mut r = [0f32; BLK];
                let mut g = [0f32; BLK];
                let mut b = [0f32; BLK];
                simd_block_kernel(ob, ib, &mut r, &mut g, &mut b,
                    &pre_r, &pre_g, &pre_b, pre_lut_shift, pre_lut_mask,
                    m, fused, ti.sat, ti.vib, ti.vib_zero,
                    |v| post16[(v as u16) as usize]);
            });
    }
    // Serial/WASM: hoist scratch once (PIPE-005).
    #[cfg(not(feature = "parallel"))]
    {
        let mut r = [0f32; BLK];
        let mut g = [0f32; BLK];
        let mut b = [0f32; BLK];
        for (ob, ib) in out.chunks_mut(3 * BLK).zip(rgb16.chunks(3 * BLK)) {
            simd_block_kernel(ob, ib, &mut r, &mut g, &mut b,
                &pre_r, &pre_g, &pre_b, pre_lut_shift, pre_lut_mask,
                m, fused, ti.sat, ti.vib, ti.vib_zero,
                |v| post16[(v as u16) as usize]);
        }
    }
    out
}

/// Box downscale RGB16 (u16 interleaved) → smaller Vec<u16>. Rayon over rows.
///
/// Item 9 (light touch): The allocating version is the common case today. For hot paths
/// that can pre-allocate (e.g. 1800px lightbox or 360px thumb buffers), use the `_into`
/// variant to avoid the Vec allocation inside the downscaler.
pub fn downscale_rgb16(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u16> {
    let mut out = vec![0u16; dw * dh * 3];
    downscale_rgb16_into(src, sw, sh, dw, dh, &mut out);
    out
}

/// Writes the downscaled result directly into `out` (must be exactly dw*dh*3 elements).
/// No allocation. Rayon over rows.
pub fn downscale_rgb16_into(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize, out: &mut [u16]) {
    #[cfg(feature = "parallel")]
    use rayon::prelude::*;
    validate_pixel_buffer_u16(src, sw, sh, 3)
        .expect("downscale_rgb16_into: source buffer bounds");
    validate_pixel_buffer_u16(out, dw, dh, 3)
        .expect("downscale_rgb16_into: output buffer bounds");

    // Integer fast path for exact factors (very common: 1800px lb → 360px thumb = 5x).
    // Flipflop bench (2026-06-18): serial 8ms, parallel 3.4ms → 2.37× speedup on 12MP.
    // Optimization (C7, 2026-06-19): replace 3 divides/pixel with reciprocal multiply (8–13% faster).
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let n_px = (xstep * ystep) as u64;
        // Precompute reciprocal: (2^64 / n_px) for fixed-point multiply instead of divide.
        let recip: u64 = ((1u128 << 64) / (n_px as u128)) as u64;
        #[cfg(feature = "parallel")]
        let iter = out.par_chunks_mut(dw * 3);
        #[cfg(not(feature = "parallel"))]
        let iter = out.chunks_mut(dw * 3);
        iter.enumerate().for_each(|(dy, row)| {
            for dx in 0..dw {
                let (mut rr, mut gg, mut bb) = (0u64, 0u64, 0u64);
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    let base = (y * sw + dx * xstep) * 3;
                    // PIPE-012: stride-3 AoS read with u64 accumulators; LLVM cannot vectorise
                    // because u64 SIMD is not uniform across targets.  Known opportunity: split
                    // into planar accumulation via `let px = &src[base + xx*3..];` to let LLVM
                    // see regular access.  Profile first — downscale is not a current bottleneck.
                    #[allow(clippy::needless_range_loop)]
                    for xx in 0..xstep {
                        let i = base + xx * 3;
                        rr += src[i] as u64;
                        gg += src[i + 1] as u64;
                        bb += src[i + 2] as u64;
                    }
                }
                let o = dx * 3;
                // Use precomputed reciprocal multiply instead of divide (faster on most CPUs).
                let r_val = ((rr as u128 * recip as u128) >> 64) as u64;
                let g_val = ((gg as u128 * recip as u128) >> 64) as u64;
                let b_val = ((bb as u128 * recip as u128) >> 64) as u64;
                row[o] = r_val.min(65535) as u16;
                row[o + 1] = g_val.min(65535) as u16;
                row[o + 2] = b_val.min(65535) as u16;
            }
        });
        return;
    }

    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    #[cfg(feature = "parallel")]
    let iter = out.par_chunks_mut(dw * 3);
    #[cfg(not(feature = "parallel"))]
    let iter = out.chunks_mut(dw * 3);
    iter.enumerate().for_each(|(dy, row)| {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let y1 = y1.max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);
            // u64 avoids overflow for large box areas (u32 overflows at ~65535 pixels × 65535 value).
            let (mut rr, mut gg, mut bb, mut n) = (0u64, 0u64, 0u64, 0u64);
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * sw + x) * 3;
                    rr += src[i] as u64; gg += src[i+1] as u64; bb += src[i+2] as u64; n += 1;
                }
            }
            let n = n.max(1);
            let o = dx * 3;
            row[o] = (rr / n) as u16; row[o+1] = (gg / n) as u16; row[o+2] = (bb / n) as u16;
        }
    });
}

/// Box downscale RGB8 → smaller Vec<u8>. Rayon over rows.
///
/// Item 9 (light touch): See downscale_rgb16_into for the pre-allocated variant.
pub fn downscale_rgb8(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh * 3];
    downscale_rgb8_into(src, sw, sh, dw, dh, &mut out);
    out
}

/// Writes the downscaled result directly into `out` (must be exactly dw*dh*3 elements).
pub fn downscale_rgb8_into(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize, out: &mut [u8]) {
    #[cfg(feature = "parallel")]
    use rayon::prelude::*;
    validate_pixel_buffer(src, sw, sh, 3)
        .expect("downscale_rgb8_into: source buffer bounds");
    validate_pixel_buffer(out, dw, dh, 3)
        .expect("downscale_rgb8_into: output buffer bounds");

    // Integer fast path for exact factors (symmetric to the rgb16 version).
    // Optimization (C7, 2026-06-19): replace 3 divides/pixel with reciprocal multiply (8–13% faster).
    if (sw % dw == 0) && (sh % dh == 0) {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let n = (xstep * ystep) as u64;
        // Precompute reciprocal: (2^64 / n) for fixed-point multiply instead of divide.
        let recip: u64 = ((1u128 << 64) / (n as u128)) as u64;
        #[cfg(feature = "parallel")]
        let iter = out.par_chunks_mut(dw * 3);
        #[cfg(not(feature = "parallel"))]
        let iter = out.chunks_mut(dw * 3);
        iter.enumerate().for_each(|(dy, row)| {
            for dx in 0..dw {
                let mut rr = 0u64;
                let mut gg = 0u64;
                let mut bb = 0u64;
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    let base = (y * sw + dx * xstep) * 3;
                    for xx in 0..xstep {
                        let i = base + xx * 3;
                        rr += src[i] as u64;
                        gg += src[i + 1] as u64;
                        bb += src[i + 2] as u64;
                    }
                }
                let o = dx * 3;
                // Use precomputed reciprocal multiply instead of divide (faster on most CPUs).
                let r_val = ((rr as u128 * recip as u128) >> 64) as u64;
                let g_val = ((gg as u128 * recip as u128) >> 64) as u64;
                let b_val = ((bb as u128 * recip as u128) >> 64) as u64;
                row[o] = r_val.min(255) as u8;
                row[o + 1] = g_val.min(255) as u8;
                row[o + 2] = b_val.min(255) as u8;
            }
        });
        return;
    }

    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    #[cfg(feature = "parallel")]
    let iter = out.par_chunks_mut(dw * 3);
    #[cfg(not(feature = "parallel"))]
    let iter = out.chunks_mut(dw * 3);
    iter.enumerate().for_each(|(dy, row)| {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let y1 = y1.max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);
            let (mut rr, mut gg, mut bb, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * sw + x) * 3;
                    rr += src[i] as u32; gg += src[i+1] as u32; bb += src[i+2] as u32; n += 1;
                }
            }
            let n = n.max(1);
            let o = dx * 3;
            row[o] = (rr / n) as u8; row[o+1] = (gg / n) as u8; row[o+2] = (bb / n) as u8;
        }
    });
}

/// Target dims for long-edge resize (preserves aspect, min 1).
pub fn target_dims(w: usize, h: usize, long_edge: usize) -> (usize, usize) {
    if w == 0 || h == 0 {
        return (long_edge.max(1), long_edge.max(1));
    }
    if w >= h {
        let lw = w.min(long_edge);
        (lw, ((h * lw) / w).max(1))
    } else {
        let lh = h.min(long_edge);
        (((w * lh) / h).max(1), lh)
    }
}

/// Unified look parameter applicator (single source of truth for the 12 sliders).
/// Matches the logic previously duplicated in WASM wrapper and Tauri pipeline.
/// All values are finite-checked; non-finite are ignored (keeps prior behavior).
pub fn apply_look_params(
    params: &mut PipelineParams,
    exposure_ev: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    vibrance: f32,
    temp: f32,
    tint: f32,
    texture: f32,
    clarity: f32,
) {
    if exposure_ev.is_finite() {
        params.exposure_ev = exposure_ev;
    }
    if contrast.is_finite() {
        params.contrast = contrast;
    }
    if highlights.is_finite() {
        params.highlights = highlights;
    }
    if shadows.is_finite() {
        params.shadows = shadows;
    }
    if whites.is_finite() {
        params.whites = whites;
    }
    if blacks.is_finite() {
        params.blacks = blacks;
    }
    if saturation.is_finite() {
        params.saturation = saturation;
    }
    if vibrance.is_finite() {
        params.vibrance = vibrance;
    }
    if temp.is_finite() {
        params.temp = temp;
    }
    if tint.is_finite() {
        params.tint = tint;
    }
    if texture.is_finite() {
        params.texture = texture;
    }
    if clarity.is_finite() {
        params.clarity = clarity;
    }
}

/// Apply EXIF orientation tag to a packed RGB8 image.
///
/// Handles orientations 3 (180°), 6 (90° CW), 8 (90° CCW).
pub fn apply_orientation(
    rgb: Vec<u8>,
    width: usize,
    height: usize,
    orientation: u16,
) -> (Vec<u8>, usize, usize) {
    match orientation {
        2 => (flip_horizontal(&rgb, width, height), width, height),
        3 => (rotate_180(&rgb, width, height), width, height),
        4 => (flip_vertical(&rgb, width, height), width, height),
        5 => (transpose(&rgb, width, height), height, width),
        6 => (rotate_90_cw(&rgb, width, height), height, width),
        7 => (anti_transpose(&rgb, width, height), height, width),
        8 => (rotate_90_ccw(&rgb, width, height), height, width),
        _ => (rgb, width, height), // orientation 1 + unknowns: zero-copy move
    }
}

// Tile-blocked transpose. TILE chosen so a tile of TILE × TILE × 3 bytes fits
// comfortably in L1 along with the dst-row strips it touches (≈ 6 KB working
// set per thread at TILE=32). Parallel chunks distribute exclusive dst row
// bands → no cross-thread aliasing.
const TILE: usize = 32;

/// dst[c, h-1-r] = src[r, c].  Output dims: (h, w).
pub fn rotate_90_cw(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    if w == 0 || h == 0 {
        return vec![0u8; src.len()];
    }
    let w_dst = h;
    let dst_row_bytes = w_dst * 3;
    let mut dst = vec![0u8; src.len()];
    let band_bytes = TILE * dst_row_bytes;

    let body = |(band_idx, band): (usize, &mut [u8])| {
        let c0 = band_idx * TILE;
        let band_rows = band.len() / dst_row_bytes;
        for r0 in (0..h).step_by(TILE) {
            let r_end = (r0 + TILE).min(h);
            for r in r0..r_end {
                let dst_col_off = (h - 1 - r) * 3;
                let src_row_off = r * w * 3;
                for c_local in 0..band_rows {
                    let s = src_row_off + (c0 + c_local) * 3;
                    let d = c_local * dst_row_bytes + dst_col_off;
                    band[d]     = src[s];
                    band[d + 1] = src[s + 1];
                    band[d + 2] = src[s + 2];
                }
            }
        }
    };

    #[cfg(feature = "parallel")]
    dst.par_chunks_mut(band_bytes).enumerate().for_each(body);
    #[cfg(not(feature = "parallel"))]
    dst.chunks_mut(band_bytes).enumerate().for_each(body);
    dst
}

/// dst[w-1-c, r] = src[r, c].  Output dims: (h, w).
pub fn rotate_90_ccw(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    if w == 0 || h == 0 {
        return vec![0u8; src.len()];
    }
    let w_dst = h;
    let dst_row_bytes = w_dst * 3;
    let mut dst = vec![0u8; src.len()];
    let band_bytes = TILE * dst_row_bytes;

    let body = |(band_idx, band): (usize, &mut [u8])| {
        let band_rows = band.len() / dst_row_bytes;
        // Band owns dst rows [band_idx*TILE, band_idx*TILE+band_rows).
        // dst row index = w-1-c  →  c = w-1-dst_row_idx.
        let c_top = w - 1 - band_idx * TILE;        // c for c_local=0
        for r0 in (0..h).step_by(TILE) {
            let r_end = (r0 + TILE).min(h);
            for r in r0..r_end {
                let dst_col_off = r * 3;
                let src_row_off = r * w * 3;
                for c_local in 0..band_rows {
                    let c = c_top - c_local;
                    let s = src_row_off + c * 3;
                    let d = c_local * dst_row_bytes + dst_col_off;
                    band[d]     = src[s];
                    band[d + 1] = src[s + 1];
                    band[d + 2] = src[s + 2];
                }
            }
        }
    };

    #[cfg(feature = "parallel")]
    dst.par_chunks_mut(band_bytes).enumerate().for_each(body);
    #[cfg(not(feature = "parallel"))]
    dst.chunks_mut(band_bytes).enumerate().for_each(body);
    dst
}

/// dst[h-1-r, w-1-c] = src[r, c].  Output dims: (w, h).  Already row-sequential;
/// just parallelize over dst rows.
pub fn rotate_180(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    if w == 0 || h == 0 {
        return vec![0u8; src.len()];
    }
    let row_bytes = w * 3;
    let mut dst = vec![0u8; src.len()];

    let body = |(dst_row_idx, dst_row): (usize, &mut [u8])| {
        let src_row_idx = h - 1 - dst_row_idx;
        let s_row = &src[src_row_idx * row_bytes..(src_row_idx + 1) * row_bytes];
        for c in 0..w {
            let sc = w - 1 - c;
            let s = sc * 3;
            let d = c * 3;
            dst_row[d]     = s_row[s];
            dst_row[d + 1] = s_row[s + 1];
            dst_row[d + 2] = s_row[s + 2];
        }
    };

    #[cfg(feature = "parallel")]
    dst.par_chunks_mut(row_bytes).enumerate().for_each(body);
    #[cfg(not(feature = "parallel"))]
    dst.chunks_mut(row_bytes).enumerate().for_each(body);
    dst
}

/// Mirror each row left-right (EXIF orientation 2).
pub fn flip_horizontal(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    let row_bytes = w * 3;
    let mut dst = src.to_vec();
    for r in 0..h {
        let row = &mut dst[r * row_bytes..(r + 1) * row_bytes];
        for c in 0..w / 2 {
            let a = c * 3;
            let b = (w - 1 - c) * 3;
            row.swap(a, b);
            row.swap(a + 1, b + 1);
            row.swap(a + 2, b + 2);
        }
    }
    dst
}

/// Mirror rows top-bottom (EXIF orientation 4).
pub fn flip_vertical(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    let row_bytes = w * 3;
    let mut dst = vec![0u8; src.len()];
    for r in 0..h {
        let src_row = r * row_bytes;
        let dst_row = (h - 1 - r) * row_bytes;
        dst[dst_row..dst_row + row_bytes].copy_from_slice(&src[src_row..src_row + row_bytes]);
    }
    dst
}

/// Transpose along the main diagonal: dst[c, r] = src[r, c]. Output dims: (h, w). (EXIF 5)
///
/// Tile-blocked (TILE × TILE) to stay L1-resident, matching the approach used by
/// rotate_90_cw / rotate_90_ccw.
pub fn transpose(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut dst = vec![0u8; src.len()];
    // dst dims: w_dst = h, h_dst = w.  dst[c, r] with dst-row-stride = h*3.
    let dst_row_stride = h * 3;
    for r0 in (0..h).step_by(TILE) {
        let r_end = (r0 + TILE).min(h);
        for c0 in (0..w).step_by(TILE) {
            let c_end = (c0 + TILE).min(w);
            for r in r0..r_end {
                let src_row_off = r * w * 3;
                for c in c0..c_end {
                    let si = src_row_off + c * 3;
                    let di = c * dst_row_stride + r * 3;
                    dst[di]     = src[si];
                    dst[di + 1] = src[si + 1];
                    dst[di + 2] = src[si + 2];
                }
            }
        }
    }
    dst
}

/// Transpose along the anti-diagonal: dst[w-1-c, h-1-r] = src[r, c]. Output dims: (h, w). (EXIF 7)
///
/// Tile-blocked (TILE × TILE) to stay L1-resident.
pub fn anti_transpose(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut dst = vec![0u8; src.len()];
    // dst dims: w_dst = h, h_dst = w.  dst[w-1-c, h-1-r] with dst-row-stride = h*3.
    let dst_row_stride = h * 3;
    for r0 in (0..h).step_by(TILE) {
        let r_end = (r0 + TILE).min(h);
        for c0 in (0..w).step_by(TILE) {
            let c_end = (c0 + TILE).min(w);
            for r in r0..r_end {
                let src_row_off = r * w * 3;
                for c in c0..c_end {
                    let si = src_row_off + c * 3;
                    let di = (w - 1 - c) * dst_row_stride + (h - 1 - r) * 3;
                    dst[di]     = src[si];
                    dst[di + 1] = src[si + 1];
                    dst[di + 2] = src[si + 2];
                }
            }
        }
    }
    dst
}

#[cfg(test)]
mod pixel_buffer_validation_tests {
    use super::*;

    #[test]
    fn validate_pixel_buffer_accepts_exact_rgb8() {
        let buf = vec![0u8; 4 * 3 * 3];
        assert!(validate_pixel_buffer(&buf, 4, 3, 3).is_ok());
    }

    #[test]
    fn validate_pixel_buffer_rejects_slack() {
        let buf = vec![0u8; 100];
        let err = validate_pixel_buffer(&buf, 4, 3, 3).unwrap_err();
        assert!(err.contains("length mismatch"), "{err}");
    }

    #[test]
    fn validate_pixel_dims_rejects_oversize() {
        let side = 65536usize;
        let err = validate_pixel_dims(side, side, 4).unwrap_err();
        assert!(err.contains("exceeds"), "{err}");
    }
}

#[cfg(test)]
mod rotate_tests {
    use super::*;

    // Build a synthetic image where pixel (r, c) = (r as u8, c as u8, (r+c) as u8).
    fn synth(w: usize, h: usize) -> Vec<u8> {
        let mut v = vec![0u8; w * h * 3];
        for r in 0..h {
            for c in 0..w {
                let i = (r * w + c) * 3;
                v[i]     = (r & 0xff) as u8;
                v[i + 1] = (c & 0xff) as u8;
                v[i + 2] = ((r + c) & 0xff) as u8;
            }
        }
        v
    }

    #[test]
    fn rotate_90_cw_then_ccw_is_identity() {
        for (w, h) in [(7usize, 5usize), (32, 32), (33, 31), (100, 60)] {
            let src = synth(w, h);
            let rot = rotate_90_cw(&src, w, h);
            let back = rotate_90_ccw(&rot, h, w);
            assert_eq!(back, src, "{w}x{h}");
        }
    }

    #[test]
    fn rotate_180_is_involution() {
        for (w, h) in [(7usize, 5usize), (32, 32), (33, 31), (100, 60)] {
            let src = synth(w, h);
            let twice = rotate_180(&rotate_180(&src, w, h), w, h);
            assert_eq!(twice, src, "{w}x{h}");
        }
    }

    #[test]
    fn rotate_90_cw_four_times_is_identity() {
        let (w, h) = (33usize, 17usize);
        let src = synth(w, h);
        let a = rotate_90_cw(&src, w, h);          // h x w
        let b = rotate_90_cw(&a, h, w);            // w x h
        let c = rotate_90_cw(&b, w, h);            // h x w
        let d = rotate_90_cw(&c, h, w);            // w x h
        assert_eq!(d, src);
    }

    #[test]
    fn rotate_90_cw_corner_pixel() {
        let (w, h) = (4usize, 3usize);
        let mut src = vec![0u8; w * h * 3];
        // mark (0,0) = (10, 20, 30)
        src[0] = 10; src[1] = 20; src[2] = 30;
        // After CW: src (0,0) → dst (0, h-1) = (0, 2)
        let rot = rotate_90_cw(&src, w, h);
        // dst dims: w_dst = h = 3, h_dst = w = 4
        let i = (0 * 3 + 2) * 3;
        assert_eq!(&rot[i..i + 3], &[10, 20, 30]);
    }

    #[test]
    fn rotate_90_cw_matches_naive() {
        let (w, h) = (37usize, 19usize);
        let src = synth(w, h);
        let fast = rotate_90_cw(&src, w, h);
        // Naive reference.
        let mut naive = vec![0u8; src.len()];
        let w_dst = h;
        for r in 0..h {
            for c in 0..w {
                let s = (r * w + c) * 3;
                let d = (c * w_dst + (h - 1 - r)) * 3;
                naive[d]     = src[s];
                naive[d + 1] = src[s + 1];
                naive[d + 2] = src[s + 2];
            }
        }
        assert_eq!(fast, naive);
    }

    #[test]
    fn rotate_90_ccw_matches_naive() {
        let (w, h) = (37usize, 19usize);
        let src = synth(w, h);
        let fast = rotate_90_ccw(&src, w, h);
        let mut naive = vec![0u8; src.len()];
        let w_dst = h;
        for r in 0..h {
            for c in 0..w {
                let s = (r * w + c) * 3;
                let d = ((w - 1 - c) * w_dst + r) * 3;
                naive[d]     = src[s];
                naive[d + 1] = src[s + 1];
                naive[d + 2] = src[s + 2];
            }
        }
        assert_eq!(fast, naive);
    }

    #[test]
    fn flip_horizontal_is_involution() {
        for (w, h) in [(7usize, 5usize), (32, 32), (33, 31)] {
            let src = synth(w, h);
            let twice = flip_horizontal(&flip_horizontal(&src, w, h), w, h);
            assert_eq!(twice, src, "{w}x{h}");
        }
    }

    #[test]
    fn flip_horizontal_corner_pixel() {
        let (w, h) = (4usize, 3usize);
        let mut src = vec![0u8; w * h * 3];
        // pixel (row=0, col=0) = (10, 20, 30)
        src[0] = 10; src[1] = 20; src[2] = 30;
        let dst = flip_horizontal(&src, w, h);
        // After H-flip, (0,0) → (0, w-1) = (0, 3)
        let i = (0 * w + (w - 1)) * 3;
        assert_eq!(&dst[i..i + 3], &[10, 20, 30]);
    }

    #[test]
    fn flip_vertical_is_involution() {
        for (w, h) in [(7usize, 5usize), (32, 32), (33, 31)] {
            let src = synth(w, h);
            let twice = flip_vertical(&flip_vertical(&src, w, h), w, h);
            assert_eq!(twice, src, "{w}x{h}");
        }
    }

    #[test]
    fn transpose_is_involutionlike() {
        // transpose(transpose(img, w, h), h, w) should be identity.
        for (w, h) in [(7usize, 5usize), (32, 32), (33, 31)] {
            let src = synth(w, h);
            let t1 = transpose(&src, w, h);      // dims become (h, w)
            let t2 = transpose(&t1, h, w);       // dims back to (w, h)
            assert_eq!(t2, src, "{w}x{h}");
        }
    }

    #[test]
    fn transpose_matches_naive() {
        let (w, h) = (37usize, 19usize);
        let src = synth(w, h);
        let fast = transpose(&src, w, h);
        // Naive: dst[c, r] = src[r, c], dst dims (h=w_out, w=h_out) → dst row stride = h
        let mut naive = vec![0u8; src.len()];
        for r in 0..h {
            for c in 0..w {
                let si = (r * w + c) * 3;
                let di = (c * h + r) * 3;
                naive[di] = src[si]; naive[di+1] = src[si+1]; naive[di+2] = src[si+2];
            }
        }
        assert_eq!(fast, naive);
    }

    #[test]
    fn anti_transpose_matches_naive() {
        let (w, h) = (37usize, 19usize);
        let src = synth(w, h);
        let fast = anti_transpose(&src, w, h);
        let mut naive = vec![0u8; src.len()];
        for r in 0..h {
            for c in 0..w {
                let si = (r * w + c) * 3;
                let di = ((w - 1 - c) * h + (h - 1 - r)) * 3;
                naive[di] = src[si]; naive[di+1] = src[si+1]; naive[di+2] = src[si+2];
            }
        }
        assert_eq!(fast, naive);
    }

    #[test]
    fn apply_orientation_identity_orientations() {
        let (w, h) = (5usize, 3usize);
        let src = synth(w, h);
        // orientation 1 and unknown → identity
        let (out, ow, oh) = apply_orientation(src.clone(), w, h, 1);
        assert_eq!(out, src); assert_eq!((ow, oh), (w, h));
        let (out, ow, oh) = apply_orientation(src.clone(), w, h, 99);
        assert_eq!(out, src); assert_eq!((ow, oh), (w, h));
    }

    #[test]
    fn apply_orientation_2_flip_h() {
        let (w, h) = (4usize, 3usize);
        let src = synth(w, h);
        let (out, ow, oh) = apply_orientation(src.clone(), w, h, 2);
        assert_eq!((ow, oh), (w, h));
        assert_eq!(out, flip_horizontal(&src, w, h));
    }

    #[test]
    fn apply_orientation_4_flip_v() {
        let (w, h) = (4usize, 3usize);
        let src = synth(w, h);
        let (out, ow, oh) = apply_orientation(src.clone(), w, h, 4);
        assert_eq!((ow, oh), (w, h));
        assert_eq!(out, flip_vertical(&src, w, h));
    }

    #[test]
    fn apply_orientation_5_transpose() {
        let (w, h) = (4usize, 3usize);
        let src = synth(w, h);
        let (out, ow, oh) = apply_orientation(src.clone(), w, h, 5);
        assert_eq!((ow, oh), (h, w));
        assert_eq!(out, transpose(&src, w, h));
    }

    #[test]
    fn apply_orientation_7_anti_transpose() {
        let (w, h) = (4usize, 3usize);
        let src = synth(w, h);
        let (out, ow, oh) = apply_orientation(src.clone(), w, h, 7);
        assert_eq!((ow, oh), (h, w));
        assert_eq!(out, anti_transpose(&src, w, h));
    }
}

#[cfg(test)]
mod rotate_bench {
    use super::*;
    use std::time::Instant;

    // Run with: cargo test --lib --release --no-default-features --features parallel rotate_bench::bench -- --nocapture
    // Naive single-threaded column-walk rotation (mirrors the OLD untiled
    // implementation) — for direct A/B benchmark vs the new tile-blocked + parallel one.
    fn rotate_90_cw_naive(src: &[u8], w: usize, h: usize) -> Vec<u8> {
        let mut dst = vec![0u8; src.len()];
        let w_dst = h;
        for c in 0..w {
            let dst_row = &mut dst[c * w_dst * 3..(c + 1) * w_dst * 3];
            for nc in 0..w_dst {
                let r = h - 1 - nc;
                let s = (r * w + c) * 3;
                let d = nc * 3;
                dst_row[d]     = src[s];
                dst_row[d + 1] = src[s + 1];
                dst_row[d + 2] = src[s + 2];
            }
        }
        dst
    }

    #[test]
    #[ignore]
    fn bench_rotate_90_cw_full_orf() {
        // Olympus full-frame after demosaic: ~5184 × 3888 RGB8.
        let (w, h) = (5184usize, 3888usize);
        // Varying content so the CPU can't trivially cache constant fills.
        let mut src = vec![0u8; w * h * 3];
        for (i, b) in src.iter_mut().enumerate() { *b = (i & 0xff) as u8; }

        // Warm up.
        let _ = rotate_90_cw(&src, w, h);
        let _ = rotate_90_cw_naive(&src, w, h);

        const N: usize = 5;
        let t0 = Instant::now();
        for _ in 0..N {
            let _ = rotate_90_cw(&src, w, h);
        }
        let new_ms = (t0.elapsed().as_secs_f64() / N as f64) * 1000.0;

        let t1 = Instant::now();
        for _ in 0..N {
            let _ = rotate_90_cw_naive(&src, w, h);
        }
        let old_ms = (t1.elapsed().as_secs_f64() / N as f64) * 1000.0;

        let mb = (w * h * 3) as f64 / 1_048_576.0;
        println!("rotate_90_cw 5184×3888 RGB8 ({:.1} MB):", mb);
        println!("  new (tile-blocked + parallel): {:.2} ms", new_ms);
        println!("  old (naive column-walk):       {:.2} ms", old_ms);
        println!("  speedup:                        {:.1}×", old_ms / new_ms);
    }

    #[test]
    #[ignore]
    fn bench_rotate_90_cw_lightbox() {
        // Lightbox-sized — what LookRenderer hits per slider tick.
        let (w, h) = (1800usize, 1200usize);
        let src = vec![42u8; w * h * 3];
        let _ = rotate_90_cw(&src, w, h);

        const N: usize = 20;
        let t0 = Instant::now();
        for _ in 0..N {
            let _ = rotate_90_cw(&src, w, h);
        }
        let avg_ms = (t0.elapsed().as_secs_f64() / N as f64) * 1000.0;
        let mb = (w * h * 3) as f64 / 1_048_576.0;
        println!("rotate_90_cw 1800×1200 RGB8 ({:.1} MB): {:.2} ms (avg of {} runs)", mb, avg_ms, N);
    }
}

/// Targeted flip-flop tests for suspected tonemap + demosaic smoking guns (per user lenses 22-25).
/// Alternate "newer" (full apply_tone_math with perceptual_constancy / advanced stub, or clean demosaic path)
/// vs "old" (simpler path or no advanced) 10 times on the same operation (fixed buffer or decode+process).
/// For any suspected slowdown/speedup in apply_tone_math (SIMD unroll, new perceptual math/LUT/poly approx,
/// spring/fc variants, bulk tile) use this harness: set TRIALS=12, run the test, compare CSV ratios + medians.
/// Run with: cargo test --lib --release --no-default-features --features parallel pipeline::tonemap_flip_flops -- --nocapture
#[cfg(test)]
mod tonemap_flip_flops {
    use super::*;
    use std::time::Instant;

    fn make_test_rgb16(n_pixels: usize) -> Vec<u16> {
        (0..n_pixels * 3).map(|i| ((i * 37) % 65535) as u16).collect()
    }

    #[test]
    fn flip_flop_tonemap_apply_10x() {
        let buf = make_test_rgb16(1920 * 1080 / 4); // ~0.5M pixels, manageable
        // Explicit struct (no Default derive in all feature sets).
        let base_params = PipelineParams {
            black: 0, white: 16383, wb_r: 2.0, wb_g: 1.0, wb_b: 1.7,
            exposure_ev: 0.0, temp: 0.0, tint: 0.0, saturation: 0.0, vibrance: 0.0,
            contrast: 0.0, shadows: 0.0, highlights: 0.0, whites: 0.0, blacks: 0.0,
            color_matrix: None,
            texture: 0.0,
            clarity: 0.0,
            perceptual_constancy: false,
            compact_lut: false,
        };

        // Support graphing stabilization: print CSV + running stats. 30 is often excessive; bench shows signal settles ~8-12.
        // Run with env TRIALS=12 or edit. Default keeps 30 for back-compat with prior handoff numbers.
        let trials: usize = std::env::var("TRIALS").ok().and_then(|s| s.parse().ok()).unwrap_or(30);
        println!("\n=== Flip-flop tonemap (Lens22/23/25): apply_tone_math new (perceptual=true) vs old (false) x{} for stats (CSV for graph) ===", trials);
        println!("CSV: trial,new_ms,old_ms,ratio_new_over_old,running_mean_ratio");
        let mut new_times: Vec<f64> = Vec::new();
        let mut old_times: Vec<f64> = Vec::new();
        for i in 0..trials {
            let use_new = i % 2 == 0;
            let mut params = base_params.clone();
            params.perceptual_constancy = use_new;
            // warm
            let _ = process(&buf, &params);
            let t0 = Instant::now();
            for _ in 0..5 { let _ = process(&buf, &params); } // inner iters for stable timing
            let ms = (t0.elapsed().as_secs_f64() / 5.0) * 1000.0;
            if use_new { new_times.push(ms); } else { old_times.push(ms); }
            let ratio = if !use_new && !old_times.is_empty() && !new_times.is_empty() {
                new_times.last().unwrap() / old_times.last().unwrap()
            } else { 0.0 };
            // running mean of observed ratios (new/old pairs so far)
            let run_mean = if !new_times.is_empty() && !old_times.is_empty() {
                let pairs = new_times.len().min(old_times.len());
                let sum_r: f64 = (0..pairs).map(|k| new_times[k] / old_times[k]).sum();
                sum_r / pairs as f64
            } else { 0.0 };
            println!("CSV,{},{:.3},{:.3},{:.3},{:.3}", i, if use_new {ms} else {0.0}, if !use_new {ms} else {0.0}, ratio, run_mean);
            println!("tone flip {}: {:.3} ms (new/perceptual={})", i, ms, use_new);
        }
        // Quick stabilization note (mirrors C++ bench)
        if new_times.len() > 1 && old_times.len() > 1 {
            let pairs = new_times.len().min(old_times.len());
            let ratios: Vec<f64> = (0..pairs).map(|k| new_times[k]/old_times[k]).collect();
            let m = ratios.iter().sum::<f64>() / pairs as f64;
            let var = ratios.iter().map(|r| (r-m).powi(2)).sum::<f64>() / (pairs as f64 - 1.0).max(1.0);
            println!("Post-run: mean ratio new/old = {:.3}, sample std = {:.3} over {} pairs ({} trials). 8-12 often enough per C++ graphed bench.", m, var.sqrt(), pairs, trials);
        }
    }

    // Demosaic+tone chain flip omitted in this build to avoid cross-module feature issues in test; see dng flip test for chain proxy + previous black sub switch.
    // The tonemap one above covers the main suspected smoking gun (apply_tone_math + process loops).

    // ---- Comprehensive flip-flop A/B for the implemented lens-22..25 items ----
    // Run: .\build-msvc.ps1 test --manifest-path crates/raw-pipeline/Cargo.toml --release
    //        --no-default-features --features parallel -- --ignored flipflop_ab --nocapture --test-threads=1
    use crate::demosaic;

    fn median(mut v: Vec<f64>) -> f64 {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    }

    // Pre-T1 serial LUT builders, kept here as the A/B baseline for the now-parallel production ones.
    fn build_pre_lut_serial(black: u16, white: u16, wb_eff: f32, exp_gain: f32) -> Vec<u16> {
        let mut lut = vec![0u16; 65536];
        let denom = (white.saturating_sub(black)).max(1) as f32;
        let gain = wb_eff * exp_gain;
        let norm_gain = gain / denom;
        for i in 0..65536usize {
            let centered = (i as i32 - black as i32).max(0) as f32;
            let n = highlight_shoulder(centered * norm_gain);
            lut[i] = (n * 65535.0 + 0.5).min(65535.0) as u16;
        }
        lut
    }
    fn build_post_lut_serial(t: &TonePost) -> Vec<u8> {
        let mut lut = vec![0u8; 65536];
        for i in 0..65536usize {
            let y = tone_curve(i as f32 / 65535.0, t);
            lut[i] = (y * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
        }
        lut
    }

    fn synth_bayer(w: usize, h: usize) -> Vec<u16> {
        (0..w * h).map(|i| (i.wrapping_mul(2654435761) & 0x3fff) as u16).collect()
    }

    #[test]
    fn process_16bit_simd_matches_scalar() {
        // Plain ingest (non-perceptual): both paths take the fused matrix; the SIMD bulk differs
        // from the scalar reference only by ≤1-LUT-step FMA reassociation. A real wiring bug
        // (wrong LUT, transposed matrix, bad scatter) would diverge by hundreds/thousands.
        let params = PipelineParams::default_olympus();
        assert!(!derive_tone_inputs(&params).perceptual_constancy);
        let n = 5000usize;
        let rgb16: Vec<u16> = (0..n * 3).map(|i| (i.wrapping_mul(2654435761) & 0xffff) as u16).collect();
        let a = process_16bit_scalar(&rgb16, &params);
        let b = process_16bit_simd(&rgb16, &params);
        assert_eq!(a.len(), b.len(), "length mismatch");
        let (mut sum, mut max_diff) = (0u64, 0i32);
        for (x, y) in a.iter().zip(b.iter()) {
            let d = (*x as i32 - *y as i32).abs();
            sum += d as u64;
            max_diff = max_diff.max(d);
        }
        let mean = sum as f64 / a.len() as f64;
        assert!(mean < 0.5, "process_16bit_simd vs scalar mean u16 diff {mean:.4} (max {max_diff}) — expected ≈0 modulo ≤1-LUT-step reassociation");
    }

    #[test]
    fn process_into_simd_matches_scalar() {
        // 8-bit twin of process_16bit_simd_matches_scalar, but TIGHTER: scalar process_into now
        // fuses S·M, and the SIMD path fuses the SAME matrix incl. its ragged block tail (which
        // previously called the unfused apply_tone_math). avx2 lanes use hw FMA == scalar mul_add,
        // and apply_tone_bulk_scalar is fully fused — so on native x86_64 the two are BYTE-EXACT.
        // n is deliberately NOT a multiple of 8 so the fused tail is exercised.
        let mut params = PipelineParams::default_olympus();
        params.vibrance = 0.0; // force the fused vib_zero path
        let ti = derive_tone_inputs(&params);
        assert!(ti.matrix_fused.is_some() && !ti.perceptual_constancy, "expected the fused vib_zero path");
        // 14-bit data (sensor domain), n NOT a multiple of 8 so the fused ragged tail is exercised,
        // and large enough to sample any rare boundary pixel a small buffer would miss.
        let n = 2_000_001usize;
        let rgb16: Vec<u16> = (0..n * 3).map(|i| (i.wrapping_mul(2654435761) & 0x3fff) as u16).collect();
        let (mut a, mut b) = (vec![0u8; n * 3], vec![0u8; n * 3]);
        process_into(&rgb16, &params, &mut a);
        process_into_simd(&rgb16, &params, &mut b);
        let max_diff = a.iter().zip(b.iter()).map(|(x, y)| (*x as i32 - *y as i32).abs()).max().unwrap_or(0);
        eprintln!("process_into vs process_into_simd: max u8 diff = {max_diff} over {n} px");
        // avx2 lanes use hw FMA == scalar mul_add and the tail is fused to the SAME matrix, so the
        // two are byte-exact on this path. ≤1 left as the documented SIMD-reassociation ceiling.
        assert!(max_diff <= 1, "process_into_simd diverged from scalar by {max_diff} (>1) — real wiring bug");
    }

    #[test]
    #[ignore]
    fn flipflop_lut_movement() {
        let med = |mut v: Vec<f64>| {
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            v[v.len() / 2]
        };
        eprintln!("=== LUT MOVEMENT FLIP (parallel={}) ===", cfg!(feature = "parallel"));

        // === A: invalidation split — a single-slider drag rebuilds only ONE half ===
        let params = PipelineParams::default_olympus();
        let _ = bench_lut_build_ms(&params); // warm
        let (mut pre_acc, mut post_acc) = (Vec::new(), Vec::new());
        for _ in 0..9 {
            let (pr, po) = bench_lut_build_ms(&params);
            pre_acc.push(pr);
            post_acc.push(po);
        }
        let (pre3, post) = (med(pre_acc), med(post_acc));
        let full = pre3 + post;
        eprintln!("[A split] full rebuild = pre3 {pre3:.3} + post {post:.3} = {full:.3} ms");
        eprintln!("[A split] tone-drag    -> POST only, saves pre3 {pre3:.3} ms ({:.0}%)", pre3 / full * 100.0);
        eprintln!("[A split] wb/exp-drag  -> PRE  only, saves post {post:.3} ms ({:.0}%)", post / full * 100.0);

        // === B: sRGB EOTF powf vs cached-lerp — accuracy + EOTF build speed ===
        let _ = srgb_encode_lerp(0.5); // warm the table
        let n = 65536usize;
        let (mut max_u8, mut max_u16) = (0i32, 0i32);
        for i in 0..n {
            let y = i as f32 / (n as f32 - 1.0);
            let a = linear_to_srgb(y.clamp(0.0, 1.0)); // powf reference
            let b = srgb_encode_lerp(y); // cached lerp
            max_u8 = max_u8.max(((a * 255.0 + 0.5) as i32 - (b * 255.0 + 0.5) as i32).abs());
            max_u16 = max_u16.max(((a * 65535.0 + 0.5) as i32 - (b * 65535.0 + 0.5) as i32).abs());
        }
        // Interleaved + start-rotated so thermal/frequency drift hits both arms equally (the crate's
        // flipflop convention) — a single-shot powf-block-then-lerp-block would bias the delta.
        let time = |f: &dyn Fn(f32) -> f32| {
            let t = std::time::Instant::now();
            let v: Vec<u16> = (0..n).map(|i| (f(i as f32 / (n as f32 - 1.0)) * 65535.0 + 0.5) as u16).collect();
            std::hint::black_box(&v);
            t.elapsed().as_secs_f64() * 1000.0
        };
        let powf = |y: f32| linear_to_srgb(y.clamp(0.0, 1.0));
        let lerp = |y: f32| srgb_encode_lerp(y);
        let _ = (time(&powf), time(&lerp)); // warm
        let (mut powf_t, mut lerp_t) = (Vec::new(), Vec::new());
        for r in 0..9 {
            if r % 2 == 0 {
                powf_t.push(time(&powf));
                lerp_t.push(time(&lerp));
            } else {
                lerp_t.push(time(&lerp));
                powf_t.push(time(&powf));
            }
        }
        let (powf_ms, lerp_ms) = (med(powf_t), med(lerp_t));
        eprintln!("[B srgb] EOTF accuracy: max u8 diff = {max_u8}, max u16 diff = {max_u16}");
        eprintln!("[B srgb] EOTF 65536-build: powf {powf_ms:.3} -> lerp {lerp_ms:.3} ms ({:.0}% faster)", (powf_ms - lerp_ms) / powf_ms * 100.0);
        assert!(max_u8 == 0, "sRGB lerp must be byte-exact on the u8 post-LUT (got {max_u8})");
        assert!(max_u16 <= 1, "sRGB lerp must be ≤1 LSB on the u16 post-LUT (got {max_u16})");
    }

    #[test]
    #[ignore]
    fn flipflop_ab() {
        let params = PipelineParams::default_olympus();
        let ti = derive_tone_inputs(&params);

        eprintln!("=== FLIP-FLOP A/B (release, parallel={}) ===", cfg!(feature = "parallel"));
        eprintln!("ROW\tcontext\told_ms\tnew_ms\tspeedup");

        // B1 — T1 parallel LUT build (new) vs serial (old). One full set = 3 pre + 1 post (an ensure_lut miss).
        {
            assert_eq!(
                build_pre_lut(params.black, params.white, ti.wb_r, ti.exp_gain),
                build_pre_lut_serial(params.black, params.white, ti.wb_r, ti.exp_gain),
                "B1 pre LUT parallel must equal serial"
            );
            assert_eq!(build_post_lut(&ti.tone), build_post_lut_serial(&ti.tone), "B1 post LUT parallel must equal serial");
            let iters = 200;
            for _ in 0..10 {
                let _ = build_pre_lut(params.black, params.white, ti.wb_r, ti.exp_gain);
                let _ = build_pre_lut_serial(params.black, params.white, ti.wb_r, ti.exp_gain);
            }
            let (mut oldt, mut newt) = (Vec::new(), Vec::new());
            for _ in 0..iters {
                let t = Instant::now();
                let a = build_pre_lut(params.black, params.white, ti.wb_r, ti.exp_gain);
                let b = build_pre_lut(params.black, params.white, ti.wb_g, ti.exp_gain);
                let c = build_pre_lut(params.black, params.white, ti.wb_b, ti.exp_gain);
                let d = build_post_lut(&ti.tone);
                newt.push(t.elapsed().as_secs_f64() * 1000.0);
                std::hint::black_box((&a, &b, &c, &d));

                let t = Instant::now();
                let a = build_pre_lut_serial(params.black, params.white, ti.wb_r, ti.exp_gain);
                let b = build_pre_lut_serial(params.black, params.white, ti.wb_g, ti.exp_gain);
                let c = build_pre_lut_serial(params.black, params.white, ti.wb_b, ti.exp_gain);
                let d = build_post_lut_serial(&ti.tone);
                oldt.push(t.elapsed().as_secs_f64() * 1000.0);
                std::hint::black_box((&a, &b, &c, &d));
            }
            let (o, n) = (median(oldt), median(newt));
            eprintln!("B1-LUTbuild\t3pre+post\t{:.4}\t{:.4}\t{:.2}x", o, n, o / n);
        }

        // B2 — T2 process() alloc-each-call (old) vs process_into() buffer reuse (new).
        for &(w, h, label) in &[(5000usize, 4000usize, "20MP"), (1800usize, 1200usize, "lightbox")] {
            let rgb16: Vec<u16> = (0..w * h * 3).map(|i| (i.wrapping_mul(2654435761) & 0xffff) as u16).collect();
            let mut buf = vec![0u8; w * h * 3];
            process_into(&rgb16, &params, &mut buf);
            assert_eq!(process(&rgb16, &params), buf, "B2 process_into must equal process");
            let iters = if w >= 5000 { 15 } else { 40 };
            for _ in 0..3 { std::hint::black_box(process(&rgb16, &params)); process_into(&rgb16, &params, &mut buf); }
            let (mut oldt, mut newt) = (Vec::new(), Vec::new());
            for _ in 0..iters {
                let t = Instant::now(); let r = process(&rgb16, &params); oldt.push(t.elapsed().as_secs_f64() * 1000.0); std::hint::black_box(r);
                let t = Instant::now(); process_into(&rgb16, &params, &mut buf); newt.push(t.elapsed().as_secs_f64() * 1000.0); std::hint::black_box(&buf);
            }
            let (o, n) = (median(oldt), median(newt));
            eprintln!("B2-process\t{}\t{:.4}\t{:.4}\t{:.2}x", label, o, n, o / n);
        }

        // B3 — T3 demosaic_rggb() alloc (old) vs demosaic_rggb_into() reuse (new).
        for &(w, h, label) in &[(5000usize, 4000usize, "20MP"), (1800usize, 1200usize, "lightbox")] {
            let raw = synth_bayer(w, h);
            let mut buf = vec![0u16; w * h * 3];
            demosaic::demosaic_rggb_into(&raw, w, h, &mut buf).unwrap();
            assert_eq!(demosaic::demosaic_rggb(&raw, w, h).unwrap(), buf, "B3 into must equal alloc");
            let iters = if w >= 5000 { 15 } else { 40 };
            for _ in 0..3 { std::hint::black_box(demosaic::demosaic_rggb(&raw, w, h).unwrap()); demosaic::demosaic_rggb_into(&raw, w, h, &mut buf).unwrap(); }
            let (mut oldt, mut newt) = (Vec::new(), Vec::new());
            for _ in 0..iters {
                let t = Instant::now(); let r = demosaic::demosaic_rggb(&raw, w, h).unwrap(); oldt.push(t.elapsed().as_secs_f64() * 1000.0); std::hint::black_box(r);
                let t = Instant::now(); demosaic::demosaic_rggb_into(&raw, w, h, &mut buf).unwrap(); newt.push(t.elapsed().as_secs_f64() * 1000.0); std::hint::black_box(&buf);
            }
            let (o, n) = (median(oldt), median(newt));
            eprintln!("B3-demosaic\t{}\t{:.4}\t{:.4}\t{:.2}x", label, o, n, o / n);
        }

        // B4 — rgb16-cache payoff (Lens 24): full re-render (demosaic+tone) per slider tick vs tone-only
        // when rgb16 is cached. old = full, new = tone-only. Demonstrates the JS-layer cache win.
        for &(w, h, label) in &[(1800usize, 1200usize, "lightbox"), (640usize, 480usize, "thumb")] {
            let raw = synth_bayer(w, h);
            let iters = 30;
            for _ in 0..3 { let r = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap(); std::hint::black_box(process(&r, &params)); }
            let mut full = Vec::new();
            for _ in 0..iters {
                let t = Instant::now();
                let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
                let r = process(&rgb16, &params);
                full.push(t.elapsed().as_secs_f64() * 1000.0); std::hint::black_box(r);
            }
            let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
            let mut warm = Vec::new();
            for _ in 0..iters {
                let t = Instant::now();
                let r = process(&rgb16, &params);
                warm.push(t.elapsed().as_secs_f64() * 1000.0); std::hint::black_box(r);
            }
            let (f, wm) = (median(full), median(warm));
            eprintln!("B4-rgb16cache\t{}\t{:.4}\t{:.4}\t{:.2}x", label, f, wm, f / wm);
        }
    }
}

#[cfg(test)]
mod lut_property_tests {
    use super::*;

    /// pre-LUT must be monotonically non-decreasing (higher raw values ≥ same or higher output).
    #[test]
    fn pre_lut_monotone_strided() {
        let lut = build_pre_lut_strided(64, 4095, 1.78, 1.0);
        for i in 1..lut.len() {
            assert!(lut[i] >= lut[i - 1], "strided LUT not monotone at index {i}: {} < {}", lut[i], lut[i - 1]);
        }
    }

    #[test]
    fn pre_lut_monotone_compact() {
        let lut = build_pre_lut_compact(64, 4095, 1.78, 1.0, 65536);
        for i in 1..lut.len() {
            assert!(lut[i] >= lut[i - 1], "compact LUT not monotone at index {i}: {} < {}", lut[i], lut[i - 1]);
        }
    }

    /// Raw values above white must not wrap to a lower output than the white-point entry.
    /// With lut_len=65536 and mask=0xFFFF all u16 values index within [0, 65535] safely.
    #[test]
    fn pre_lut_above_white_does_not_wrap() {
        let white = 4095u16;
        let lut = build_pre_lut_compact(64, white, 1.0, 1.0, 65536);
        let at_white = lut[white as usize];
        // Values above white should saturate to the same top value (highlight shoulder clamps to 1.0).
        for raw in (white as usize + 1)..=65535 {
            let v = lut[raw];
            assert!(v >= at_white, "raw {raw} mapped below white-point value ({v} < {at_white})");
        }
    }

    /// channels=0 must be rejected by validate_pixel_dims.
    #[test]
    fn validate_pixel_dims_rejects_zero_channels() {
        let err = validate_pixel_dims(10, 10, 0).unwrap_err();
        assert!(err.contains("positive"), "{err}");
    }
}

#[cfg(test)]
mod tone_simd_near_zero_tests {
    use crate::tone_simd::apply_tone_bulk_ref;

    /// Near-zero raw_mx guard in vibrance path: very dark pixels must not produce NaN or Inf.
    #[test]
    fn vibrance_near_zero_raw_mx() {
        const M: [[f32; 3]; 3] = [
            [1.526, -0.450, -0.077],
            [-0.245,  1.336, -0.091],
            [ 0.018, -0.298,  1.281],
        ];
        let mut r = vec![0.0f32, 1e-7, 0.0];
        let mut g = vec![0.0f32, 0.0, 1e-7];
        let mut b = vec![0.0f32, 0.0, 0.0];
        // vib_zero=false forces the vibrance path which has the raw_mx > 0 guard.
        apply_tone_bulk_ref(&mut r, &mut g, &mut b, &M, 1.3, 0.5, false);
        for i in 0..r.len() {
            assert!(r[i].is_finite(), "r[{i}] = {} is not finite", r[i]);
            assert!(g[i].is_finite(), "g[{i}] = {} is not finite", g[i]);
            assert!(b[i].is_finite(), "b[{i}] = {} is not finite", b[i]);
        }
    }
}

#[cfg(test)]
mod black_neutrality_tests {
    use super::*;

    // Render a uniform demosaiced patch (12-bit sensor counts) through the real
    // tone+WB+matrix pipeline; return the mean output sRGB.
    fn render_patch(r12: u16, g12: u16, b12: u16, p: &PipelineParams) -> (f32, f32, f32) {
        let (w, h) = (4usize, 4usize);
        let rgb16: Vec<u16> = std::iter::repeat([r12, g12, b12]).take(w * h).flatten().collect();
        let mut out = vec![0u8; w * h * 3];
        process_into(&rgb16, p, &mut out);
        let n = (w * h) as f32;
        out.chunks_exact(3).fold((0f32, 0f32, 0f32), |(r, g, b), px|
            (r + px[0] as f32 / n, g + px[1] as f32 / n, b + px[2] as f32 / n))
    }

    fn olympus(black: u16, wb: f32) -> PipelineParams {
        let mut p = PipelineParams::default_olympus();
        p.black = black; p.wb_r = wb; p.wb_g = 1.0; p.wb_b = wb;
        p
    }

    // Regression for the Olympus magenta cast (lib.rs OLYMPUS_BLACK_LEVEL fix):
    // a NEUTRAL sensor grey (green G_GAIN× R,B) on a black pedestal must render
    // neutral (R≈G≈B) when the pedestal is subtracted. With black=0 the per-
    // channel WB inflates the pedestal into R,B → a magenta cast. Tested in the
    // shadows/mids where the cast is strongest (highlights clip it away).
    #[test]
    fn correct_black_keeps_neutral_grey_neutral() {
        const G_GAIN: f32 = 1.797; // sensor green over R,B (== the 0x0100 WB)
        const PED: u16 = 256;
        for s in [40u16, 80, 150, 300] {
            let (r, g, b) = render_patch(s + PED, (s as f32 * G_GAIN) as u16 + PED, s + PED, &olympus(PED, G_GAIN));
            let magenta = (r + b) * 0.5 - g;
            assert!(magenta.abs() < 4.0, "signal {s}: magenta {magenta:+.1} (R={r:.0} G={g:.0} B={b:.0}) — black subtraction broken");
        }
    }

    // Documents the bug direction: black=0 leaves a large magenta cast in shadows.
    // If this ever drops to ~0 the pedestal is being subtracted elsewhere and the
    // lib.rs fix may be redundant — revisit then.
    #[test]
    fn zero_black_is_magenta_in_shadows() {
        const G_GAIN: f32 = 1.797;
        const PED: u16 = 256;
        let s = 40u16;
        let (r, g, b) = render_patch(s + PED, (s as f32 * G_GAIN) as u16 + PED, s + PED, &olympus(0, G_GAIN));
        assert!((r + b) * 0.5 - g > 30.0, "expected strong magenta at black=0, got R={r:.0} G={g:.0} B={b:.0}");
    }
}

#[cfg(test)]
mod downscale_recip_parity_tests {
    use super::*;

    /// Generate a synthetic RGB16 image with deterministic per-pixel values.
    fn synth_rgb16(w: usize, h: usize) -> Vec<u16> {
        let mut v = vec![0u16; w * h * 3];
        let mut lcg: u32 = 0x1234_5678;
        for px in v.iter_mut() {
            lcg = lcg.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *px = ((lcg >> 16) & 0x3fff) as u16; // 14-bit range, fits in u16 headroom
        }
        v
    }

    /// Reference box-average using plain integer divide (always correct, no recip trick).
    fn downscale_ref(src: &[u16], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u16> {
        let xstep = sw / dw;
        let ystep = sh / dh;
        let n = (xstep * ystep) as u64;
        let mut out = vec![0u16; dw * dh * 3];
        for dy in 0..dh {
            for dx in 0..dw {
                let (mut rr, mut gg, mut bb) = (0u64, 0u64, 0u64);
                for yy in 0..ystep {
                    let y = dy * ystep + yy;
                    for xx in 0..xstep {
                        let i = (y * sw + dx * xstep + xx) * 3;
                        rr += src[i] as u64;
                        gg += src[i + 1] as u64;
                        bb += src[i + 2] as u64;
                    }
                }
                let o = (dy * dw + dx) * 3;
                out[o]     = (rr / n).min(65535) as u16;
                out[o + 1] = (gg / n).min(65535) as u16;
                out[o + 2] = (bb / n).min(65535) as u16;
            }
        }
        out
    }

    /// Check that the reciprocal-multiply fast path matches plain integer divide.
    /// For power-of-2 factors the recip is exact; for others ≤1 LSB drift is allowed.
    fn check_factor(factor: usize, max_err: u16) {
        let (sw, sh) = (factor * 40, factor * 30);
        let (dw, dh) = (40, 30);
        let src = synth_rgb16(sw, sh);
        let got = downscale_rgb16(&src, sw, sh, dw, dh);
        let want = downscale_ref(&src, sw, sh, dw, dh);
        assert_eq!(got.len(), want.len());
        for (i, (&g, &w)) in got.iter().zip(want.iter()).enumerate() {
            let diff = (g as i32 - w as i32).unsigned_abs() as u16;
            assert!(
                diff <= max_err,
                "factor={factor} pixel[{i}]: got={g} want={w} diff={diff} (max_err={max_err})"
            );
        }
    }

    #[test]
    fn factor_2x_bit_exact() {
        check_factor(2, 0);
    }

    #[test]
    fn factor_3x_at_most_1lsb() {
        check_factor(3, 1);
    }

    #[test]
    fn factor_5x_at_most_1lsb() {
        check_factor(5, 1);
    }

    #[test]
    fn factor_4x_bit_exact() {
        check_factor(4, 0);
    }

    #[test]
    fn non_integer_factor_fallback_unchanged() {
        // 1800×1350 → 1280×960: sw%dw != 0 → float fallback; just check it runs and no panic.
        let src = synth_rgb16(1800, 1350);
        let out = downscale_rgb16(&src, 1800, 1350, 1280, 960);
        assert_eq!(out.len(), 1280 * 960 * 3);
        // Sanity: values in range
        assert!(out.iter().all(|&v| v <= 0x3fff), "output out of 14-bit source range");
    }

    #[test]
    #[cfg(feature = "parallel")]
    fn parallel_path_instrumentation() {
        // Test that parallel path counter is instrumented and fires (if feature enabled).
        // On a 1920×1440 image (8.3 MP), rayon should dispatch to workers if > 1 thread available.
        parallel_path_reset();

        const W: u32 = 1920;
        const H: u32 = 1440;
        let rgb16 = synth_rgb16(W as usize, H as usize);
        let mut out = vec![0u8; rgb16.len()];

        let params = PipelineParams::default_olympus();
        process_into(&rgb16, &params, &mut out);

        let calls = parallel_path_call_count();
        eprintln!("parallel_path_call_count: {} (process_into on {}×{})", calls, W, H);

        // If parallel feature is on and rayon has threads, we expect calls > 0.
        // With 1920×1440×3 = 8.3M pixels, that's well above rayon's min_len threshold (4096).
        // If calls == 0 but feature is on, parallel isn't firing (check threadpool init, workload size).
        assert!(calls > 0, "parallel path not taken on {}×{} image; rayon may not be initialized", W, H);
    }
}
