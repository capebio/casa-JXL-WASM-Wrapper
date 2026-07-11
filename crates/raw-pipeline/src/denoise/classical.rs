//! Classical VST+BM3D denoise orchestration.
//!
//! Routes between low-noise (demosaic first) and high-noise (CFA denoise first)
//! regimes, applies the Generalized Anscombe Transform, runs BM3D per channel
//! in YCoCg space, inverts the VST, then blends with the MHC baseline at
//! `effective_strength`.

use crate::denoise::bm3d::bm3d_denoise;
use crate::denoise::dng_tags::RawNoiseMetadata;
use crate::denoise::types::{NoiseMetrics, NoiseModel};
use crate::denoise::vst::{gat_forward, gat_inverse_exact};

// ─── Public API ───────────────────────────────────────────────────────────────

/// Denoise a RAW image and return a normalized RGB16 output.
///
/// # Arguments
/// * `raw`      — Raw Bayer u16 pixels (row-major).
/// * `rgb_mhc`  — MHC demosaic baseline (interleaved RGB16, width×height×3).
/// * `width`, `height` — image dimensions.
/// * `metadata` — per-plane black/white levels and embedded noise model.
/// * `model`    — 4-plane shot+read noise model for VST parameterization.
/// * `metrics`  — display-space noise metrics (drives low/high-noise routing).
/// * `strength` — effective denoise strength from the policy decision (0.0–1.5).
///
/// # Returns
/// Normalized RGB16 image (`black = 0`, `white = 65535`).
///
/// # Contract
/// * `strength < 1e-4` → byte-identical copy of `rgb_mhc` (no processing).
/// * `strength >= 1.0` → full BM3D output.
/// * Otherwise → linear blend: `lerp(rgb_mhc, bm3d_output, strength)`.
pub fn denoise(
    raw: &[u16],
    rgb_mhc: &[u16],
    width: usize,
    height: usize,
    metadata: &RawNoiseMetadata,
    model: &NoiseModel,
    metrics: &NoiseMetrics,
    strength: f32,
) -> Vec<u16> {
    // Fast path: zero strength → byte-identical copy
    if strength < 1e-4 {
        return rgb_mhc.to_vec();
    }

    let rgb_denoised = if metrics.display_sigma_p90 < 4.0 {
        // Low-noise: demosaic already done, denoise in YCoCg
        denoise_rgb_ycocg(rgb_mhc, width, height, model, strength)
    } else {
        // High-noise: CFA denoise first, then demosaic, then YCoCg pass
        let raw_denoised = denoise_cfa(raw, width, height, metadata, model);
        let rgb_from_denoised = demosaic_raw(&raw_denoised, width, height, metadata);
        denoise_rgb_ycocg(&rgb_from_denoised, width, height, model, strength)
    };

    blend_to_u16(&rgb_denoised, rgb_mhc, strength, width, height)
}

// ─── RGB → YCoCg denoising ────────────────────────────────────────────────────

/// Denoise interleaved RGB16 by converting to YCoCg f32, applying VST+BM3D
/// per channel, inverting the VST, and converting back to interleaved f32 RGB.
///
/// Returns interleaved RGB f32 in [0.0, 1.0].
fn denoise_rgb_ycocg(
    rgb_mhc: &[u16],
    width: usize,
    height: usize,
    model: &NoiseModel,
    strength: f32,
) -> Vec<f32> {
    let n = width * height;

    // Convert RGB16 → normalized f32 planar YCoCg
    let mut y_plane = vec![0f32; n];
    let mut co_plane = vec![0f32; n];
    let mut cg_plane = vec![0f32; n];

    for i in 0..n {
        let r = rgb_mhc[i * 3] as f32 / 65535.0;
        let g = rgb_mhc[i * 3 + 1] as f32 / 65535.0;
        let b = rgb_mhc[i * 3 + 2] as f32 / 65535.0;
        // YCoCg-R (lossless integer variant, but here in f32 floating)
        let co = r - b;
        let tmp = b + co * 0.5;
        let cg = g - tmp;
        let y = tmp + cg * 0.5;
        y_plane[i] = y;
        co_plane[i] = co;
        cg_plane[i] = cg;
    }

    // Use Y-channel noise params (derived from green plane mean)
    // Green plane is planes[1] (G1) — luminance-like.
    let g_coeff = model.planes[1];
    // For chroma, use mean of R and B coefficients (scaled down for chroma energy).
    let r_coeff = model.planes[0];
    let b_coeff = model.planes[3];
    let chroma_shot = (r_coeff.shot + b_coeff.shot) * 0.5 * 0.5;
    let chroma_read = (r_coeff.read + b_coeff.read) * 0.5 * 0.5;

    // Compute the correct BM3D sigma in the VST domain.
    //
    // After gat_forward(x, shot, read) = 2*sqrt(x + c):
    //   var(z) ≈ (dz/dx)² * var(x) = (1/(x+c)) * (shot*x + read)
    //   sigma_z = sqrt(shot*x + read) / sqrt(x + c)
    //
    // We evaluate at the 18% grey operating point (x = 0.18), which is
    // representative of the mid-tone noise level. This is multiplied by
    // `strength` to scale the denoising intensity.
    let x_op = 0.18f32;
    let c_y = 3.0 / 8.0 + g_coeff.read * g_coeff.read / (4.0 * g_coeff.shot.max(1e-12));
    let sigma_y = (g_coeff.shot * x_op + g_coeff.read).max(0.0).sqrt()
        / (x_op + c_y).max(1e-12).sqrt()
        * strength;
    let c_co = 3.0 / 8.0 + chroma_read * chroma_read / (4.0 * chroma_shot.max(1e-12));
    let x_co = 0.5f32; // chroma centered at 0.5 (after +0.5 offset)
    let sigma_co = (chroma_shot * x_co + chroma_read).max(0.0).sqrt()
        / (x_co + c_co).max(1e-12).sqrt()
        * strength;

    // Clamp sigma to a reasonable range: [1e-6, 0.5].
    // If sigma is too small BM3D becomes a no-op (all thresholds zero).
    // If sigma is too large, all coefficients are zeroed (image destroyed).
    let sigma_y = sigma_y.clamp(1e-6, 0.5);
    let sigma_co = sigma_co.clamp(1e-6, 0.5);

    // VST + BM3D on Y channel
    let y_vst: Vec<f32> = y_plane
        .iter()
        .map(|&v| gat_forward(v, g_coeff.shot, g_coeff.read))
        .collect();
    let y_bm3d = bm3d_denoise(&y_vst, width, height, sigma_y);
    let y_denoised: Vec<f32> = y_bm3d
        .iter()
        .map(|&z| gat_inverse_exact(z, g_coeff.shot, g_coeff.read))
        .collect();

    // VST + BM3D on Co channel (chroma — offset to positive domain)
    let co_vst: Vec<f32> = co_plane
        .iter()
        .map(|&v| gat_forward(v + 0.5, chroma_shot, chroma_read))
        .collect();
    let co_bm3d = bm3d_denoise(&co_vst, width, height, sigma_co);
    let co_denoised: Vec<f32> = co_bm3d
        .iter()
        .map(|&z| gat_inverse_exact(z, chroma_shot, chroma_read) - 0.5)
        .collect();

    // VST + BM3D on Cg channel
    let cg_vst: Vec<f32> = cg_plane
        .iter()
        .map(|&v| gat_forward(v + 0.5, chroma_shot, chroma_read))
        .collect();
    let cg_bm3d = bm3d_denoise(&cg_vst, width, height, sigma_co);
    let cg_denoised: Vec<f32> = cg_bm3d
        .iter()
        .map(|&z| gat_inverse_exact(z, chroma_shot, chroma_read) - 0.5)
        .collect();

    // Convert YCoCg back to interleaved RGB f32
    let mut rgb_f32 = vec![0f32; n * 3];
    for i in 0..n {
        let y = y_denoised[i];
        let co = co_denoised[i];
        let cg = cg_denoised[i];
        let tmp = y - cg * 0.5;
        let g = cg + tmp;
        let b = tmp - co * 0.5;
        let r = b + co;
        rgb_f32[i * 3] = r.clamp(0.0, 1.0);
        rgb_f32[i * 3 + 1] = g.clamp(0.0, 1.0);
        rgb_f32[i * 3 + 2] = b.clamp(0.0, 1.0);
    }

    rgb_f32
}

// ─── CFA denoise ─────────────────────────────────────────────────────────────

/// Denoise raw Bayer channels by running BM3D on each of the 4 CFA planes
/// (RGGB) independently in the VST domain.
///
/// Returns denoised raw u16 values.
fn denoise_cfa(
    raw: &[u16],
    width: usize,
    height: usize,
    metadata: &RawNoiseMetadata,
    model: &NoiseModel,
) -> Vec<u16> {
    // Extract 4 half-resolution CFA planes (RGGB ordering, 2x2 Bayer cell)
    let hw = width / 2;
    let hh = height / 2;
    let n_plane = hw * hh;

    // CFA offsets for RGGB: R=(0,0), G1=(0,1), G2=(1,0), B=(1,1)
    let offsets = [(0usize, 0usize), (0, 1), (1, 0), (1, 1)];

    let mut planes = [
        vec![0f32; n_plane],
        vec![0f32; n_plane],
        vec![0f32; n_plane],
        vec![0f32; n_plane],
    ];

    for plane_idx in 0..4 {
        let (or, oc) = offsets[plane_idx];
        let black = metadata.black[plane_idx];
        let white = metadata.white[plane_idx];
        let range = (white - black).max(1.0);
        for py in 0..hh {
            for px in 0..hw {
                let iy = py * 2 + or;
                let ix = px * 2 + oc;
                if iy < height && ix < width {
                    let v = raw[iy * width + ix] as f32;
                    planes[plane_idx][py * hw + px] = (v - black) / range;
                }
            }
        }
    }

    // VST + BM3D per plane, inverse VST
    let mut denoised_planes: [Vec<f32>; 4] = [
        vec![0f32; n_plane],
        vec![0f32; n_plane],
        vec![0f32; n_plane],
        vec![0f32; n_plane],
    ];

    for plane_idx in 0..4usize {
        let coeff = model.planes[plane_idx];
        let shot = coeff.shot;
        let read = coeff.read;

        let vst: Vec<f32> = planes[plane_idx]
            .iter()
            .map(|&v| gat_forward(v, shot, read))
            .collect();
        // Compute sigma in the VST domain at 18% grey
        let x_op = 0.18f32;
        let c_vst = 3.0 / 8.0 + read * read / (4.0 * shot.max(1e-12));
        let sigma_vst = (shot * x_op + read).max(0.0).sqrt()
            / (x_op + c_vst).max(1e-12).sqrt();
        let sigma_vst = sigma_vst.clamp(1e-6, 0.5);
        let denoised_vst = bm3d_denoise(&vst, hw, hh, sigma_vst);
        denoised_planes[plane_idx] = denoised_vst
            .iter()
            .map(|&z| gat_inverse_exact(z, shot, read).clamp(0.0, 1.0))
            .collect();
    }

    // Re-interleave into raw u16
    let mut out = raw.to_vec();
    for plane_idx in 0..4 {
        let (or, oc) = offsets[plane_idx];
        let black = metadata.black[plane_idx];
        let white = metadata.white[plane_idx];
        let range = (white - black).max(1.0);
        for py in 0..hh {
            for px in 0..hw {
                let iy = py * 2 + or;
                let ix = px * 2 + oc;
                if iy < height && ix < width {
                    let v = denoised_planes[plane_idx][py * hw + px];
                    let raw_val = (v * range + black).round().clamp(0.0, 65535.0) as u16;
                    out[iy * width + ix] = raw_val;
                }
            }
        }
    }

    out
}

// ─── Minimal bilinear demosaic ────────────────────────────────────────────────

/// Simple bilinear demosaic for post-CFA-denoise use.
/// Assumes RGGB Bayer pattern. Returns interleaved RGB16.
fn demosaic_raw(
    raw: &[u16],
    width: usize,
    height: usize,
    metadata: &RawNoiseMetadata,
) -> Vec<u16> {
    let n = width * height;
    let mut rgb = vec![0u16; n * 3];

    // Normalize to f32 for processing
    let black = metadata.black[0]; // use R plane black as representative
    let white = metadata.white[0];
    let range = (white - black).max(1.0);

    let get = |r: usize, c: usize| {
        if r < height && c < width {
            (raw[r * width + c] as f32 - black) / range
        } else {
            0.0
        }
    };

    for row in 0..height {
        for col in 0..width {
            // Determine which Bayer channel this pixel is
            let is_green = (row + col) % 2 == 1;
            let is_red_row = row % 2 == 0;
            let is_red_col = col % 2 == 0;

            let (r, g, b) = if is_green {
                // Green pixel — average neighbors for R and B
                let gv = get(row, col);
                let (rv, bv) = if is_red_row {
                    // Green in red row → R is left/right, B is up/down
                    let r_avg = (get(row, col.saturating_sub(1)) + get(row, (col + 1).min(width - 1))) * 0.5;
                    let b_avg = (get(row.saturating_sub(1), col) + get((row + 1).min(height - 1), col)) * 0.5;
                    (r_avg, b_avg)
                } else {
                    // Green in blue row → B is left/right, R is up/down
                    let b_avg = (get(row, col.saturating_sub(1)) + get(row, (col + 1).min(width - 1))) * 0.5;
                    let r_avg = (get(row.saturating_sub(1), col) + get((row + 1).min(height - 1), col)) * 0.5;
                    (r_avg, b_avg)
                };
                (rv, gv, bv)
            } else if is_red_row && is_red_col {
                // Red pixel
                let rv = get(row, col);
                let g_avg = (get(row, col.saturating_sub(1))
                    + get(row, (col + 1).min(width - 1))
                    + get(row.saturating_sub(1), col)
                    + get((row + 1).min(height - 1), col))
                    * 0.25;
                let b_avg = (get(row.saturating_sub(1), col.saturating_sub(1))
                    + get(row.saturating_sub(1), (col + 1).min(width - 1))
                    + get((row + 1).min(height - 1), col.saturating_sub(1))
                    + get((row + 1).min(height - 1), (col + 1).min(width - 1)))
                    * 0.25;
                (rv, g_avg, b_avg)
            } else {
                // Blue pixel
                let bv = get(row, col);
                let g_avg = (get(row, col.saturating_sub(1))
                    + get(row, (col + 1).min(width - 1))
                    + get(row.saturating_sub(1), col)
                    + get((row + 1).min(height - 1), col))
                    * 0.25;
                let r_avg = (get(row.saturating_sub(1), col.saturating_sub(1))
                    + get(row.saturating_sub(1), (col + 1).min(width - 1))
                    + get((row + 1).min(height - 1), col.saturating_sub(1))
                    + get((row + 1).min(height - 1), (col + 1).min(width - 1)))
                    * 0.25;
                (r_avg, g_avg, bv)
            };

            let i = row * width + col;
            rgb[i * 3] = (r.clamp(0.0, 1.0) * 65535.0).round() as u16;
            rgb[i * 3 + 1] = (g.clamp(0.0, 1.0) * 65535.0).round() as u16;
            rgb[i * 3 + 2] = (b.clamp(0.0, 1.0) * 65535.0).round() as u16;
        }
    }

    rgb
}

// ─── Blend + quantize ─────────────────────────────────────────────────────────

/// Linear blend between BM3D f32 result and the MHC u16 baseline, then quantize to u16.
///
/// `rgb_denoised`: interleaved RGB f32 in [0.0, 1.0] (BM3D output).
/// `rgb_mhc`:      interleaved RGB u16 baseline.
/// `strength`:     blend factor (1.0 = full denoise, 0.0 = original).
fn blend_to_u16(
    rgb_denoised: &[f32],
    rgb_mhc: &[u16],
    strength: f32,
    width: usize,
    height: usize,
) -> Vec<u16> {
    let n = width * height;
    let mut out = Vec::with_capacity(n * 3);
    let s = strength.clamp(0.0, 1.5);
    // When strength >= 1.0 we clamp the blend at 1.0 (full denoised).
    let t = s.min(1.0);
    for i in 0..(n * 3) {
        let mhc = rgb_mhc[i] as f32 / 65535.0;
        let den = rgb_denoised[i];
        let blended = mhc + t * (den - mhc);
        out.push((blended.clamp(0.0, 1.0) * 65535.0).round() as u16);
    }
    out
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::denoise::dng_tags::RawNoiseMetadata;
    use crate::denoise::types::{NoiseCoefficients, NoiseMetrics, NoiseModel, NoiseSource};

    fn flat_model() -> NoiseModel {
        let c = NoiseCoefficients { shot: 0.001, read: 0.0001 };
        NoiseModel {
            planes: [c; 4],
            structured_sigma: [0.0; 4],
            confidence: 1.0,
            source: NoiseSource::DngNoiseProfile,
        }
    }

    fn flat_metrics(sigma: f32) -> NoiseMetrics {
        NoiseMetrics {
            display_sigma_p90: sigma,
            sigma_18: sigma * 0.5,
            sigma_shadow: sigma,
            snr_18_db: 30.0,
            confidence: 1.0,
            source: NoiseSource::DngNoiseProfile,
        }
    }

    fn flat_metadata() -> RawNoiseMetadata {
        RawNoiseMetadata {
            black: [0.0; 4],
            white: [65535.0; 4],
            ..Default::default()
        }
    }

    /// strength==0 must return byte-identical copy of rgb_mhc.
    #[test]
    fn zero_strength_returns_clone() {
        let width = 8;
        let height = 8;
        let n = width * height * 3;
        let rgb_mhc: Vec<u16> = (0..n as u16).collect();
        let raw = vec![1000u16; width * height];
        let model = flat_model();
        let metrics = flat_metrics(2.0);
        let metadata = flat_metadata();

        let result = denoise(&raw, &rgb_mhc, width, height, &metadata, &model, &metrics, 0.0);
        assert_eq!(result, rgb_mhc, "zero strength must be byte-identical");
    }

    /// Strength strictly below 1e-4 must return byte-identical copy.
    #[test]
    fn tiny_strength_below_threshold_is_clone() {
        let width = 16;
        let height = 16;
        let n = width * height * 3;
        let rgb_mhc: Vec<u16> = (0..n as u16).map(|i| i % 1000 + 30000).collect();
        let raw = vec![30000u16; width * height];
        let model = flat_model();
        let metrics = flat_metrics(1.0); // low noise → YCoCg path
        let metadata = flat_metadata();

        // strength = 0.0 → must be byte-identical
        let result = denoise(&raw, &rgb_mhc, width, height, &metadata, &model, &metrics, 0.0);
        assert_eq!(result, rgb_mhc, "strength=0.0 must be byte-identical");

        // strength = 9e-5 < 1e-4 → must be byte-identical
        let result2 = denoise(&raw, &rgb_mhc, width, height, &metadata, &model, &metrics, 9e-5);
        assert_eq!(result2, rgb_mhc, "strength=9e-5 must be byte-identical");
    }

    /// High noise regime: routes through CFA path without panic.
    #[test]
    fn high_noise_regime_does_not_panic() {
        let width = 16;
        let height = 16;
        let n = width * height;
        let raw = vec![8000u16; n];
        let rgb_mhc = vec![32000u16; n * 3];
        let model = flat_model();
        let metrics = flat_metrics(5.0); // > 4.0 → CFA path
        let metadata = flat_metadata();

        let result = denoise(&raw, &rgb_mhc, width, height, &metadata, &model, &metrics, 1.0);
        assert_eq!(result.len(), n * 3);
        // All values should be in [0, 65535]
        for &v in &result {
            assert!(v <= 65535);
        }
    }

    /// blend_to_u16 with t=1.0 should equal denoised converted to u16.
    #[test]
    fn blend_full_strength_is_denoised() {
        let width = 4;
        let height = 4;
        let n = width * height;
        let rgb_denoised = vec![0.5f32; n * 3];
        let rgb_mhc = vec![0u16; n * 3];
        let result = blend_to_u16(&rgb_denoised, &rgb_mhc, 1.0, width, height);
        for &v in &result {
            assert!((v as i32 - 32767).abs() <= 1, "v={v}");
        }
    }
}

