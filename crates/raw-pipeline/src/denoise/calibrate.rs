//! Pair-based sensor noise calibration.
//!
//! Fits a Poisson + Gaussian noise model
//!
//!   variance(signal) = S · signal + O
//!
//! per CFA plane from (dark-frame, flat-frame) pairs using Huber IRLS.
//!
//! # Input requirements (per ISO)
//! - ≥ 16 dark frames
//! - ≥ 8 flat pairs (A + B)
//! - ≥ 6 distinct unsaturated signal levels
//!
//! If any threshold is not met the calibration function returns
//! `CalibrationError::InsufficientData`.

use std::fmt;

// ─── Public output types ──────────────────────────────────────────────────────

/// Shot-noise slope `S` and read-noise offset `O` for one CFA plane.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FitCoeffs {
    /// Slope of variance vs signal (shot noise).
    pub shot: f64,
    /// Offset of variance (read noise squared).
    pub read: f64,
}

/// Result of fitting one CFA plane.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlaneFit {
    /// Fitted coefficients.
    pub coeffs: FitCoeffs,
    /// Number of (signal, variance) pairs used in the final weighted fit.
    pub sample_count: usize,
    /// Normalised root-mean-square weighted residual.
    pub fit_residual: f64,
}

/// Full 4-plane calibration result for one ISO.
#[derive(Debug, Clone)]
pub struct CalibrationResult {
    /// Per-plane [R, G1, G2, B] fits.
    pub planes: [PlaneFit; 4],
    /// Variance of per-frame dark means, per plane (independent O sanity check).
    ///
    /// This equals `σ_pixel² / pixel_count`, **not** the per-pixel read noise
    /// variance.  It is useful as a relative consistency check across planes and
    /// ISOs; do not compare it directly against `FitCoeffs::read`.
    pub dark_mean_variance: [f64; 4],
}

/// Reasons why calibration can fail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CalibrationError {
    /// Not enough dark frames, flat pairs, or signal levels.
    InsufficientData {
        dark_frames: usize,
        flat_pairs: usize,
        signal_levels: usize,
    },
    /// IRLS did not converge (should not happen with well-formed input).
    FitFailed(String),
}

impl fmt::Display for CalibrationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InsufficientData {
                dark_frames,
                flat_pairs,
                signal_levels,
            } => write!(
                f,
                "insufficient calibration data: {dark_frames} dark frames, \
                 {flat_pairs} flat pairs, {signal_levels} signal levels \
                 (need ≥16, ≥8, ≥6)"
            ),
            Self::FitFailed(msg) => write!(f, "calibration fit failed: {msg}"),
        }
    }
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

pub const MIN_DARK_FRAMES: usize = 16;
pub const MIN_FLAT_PAIRS: usize = 8;
pub const MIN_SIGNAL_LEVELS: usize = 6;

// ─── Frame type ───────────────────────────────────────────────────────────────

/// A single raw frame: `data[plane][pixel]` in sensor counts.
pub struct RawFrame {
    /// Per-plane pixel values.  Length = 4 planes × (width × height).
    /// data[plane] must be the same length for all frames in a batch.
    pub planes: [Vec<f64>; 4],
}

impl RawFrame {
    /// Construct from a flat row-major Bayer array (`width × height` u16 values)
    /// using the given CFA phase (top-left pixel index 0..4 → R/G1/G2/B order
    /// matching RGGB phase 0 convention).
    ///
    /// cfa_phase: 0=RGGB, 1=GRBG, 2=GBRG, 3=BGGR
    pub fn from_bayer(data: &[u16], width: usize, cfa_phase: usize) -> Self {
        // Channel mapping table: cfa_phase × 4 positions → plane index [R,G1,G2,B]
        // Position order: (0,0) (0,1) (1,0) (1,1)
        const CHANNEL: [[usize; 4]; 4] = [
            [0, 1, 2, 3], // RGGB: R G1 G2 B
            [1, 0, 3, 2], // GRBG: G1 R B G2
            [2, 3, 0, 1], // GBRG: G2 B R G1
            [3, 2, 1, 0], // BGGR: B G2 G1 R
        ];
        let phase = cfa_phase & 3;
        let map = CHANNEL[phase];
        let height = data.len() / width;
        let n = (width / 2) * (height / 2);
        let mut planes: [Vec<f64>; 4] = [
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        ];
        for y in (0..height).step_by(2) {
            for x in (0..width).step_by(2) {
                planes[map[0]].push(data[y * width + x] as f64);
                planes[map[1]].push(data[y * width + x + 1] as f64);
                planes[map[2]].push(data[(y + 1) * width + x] as f64);
                planes[map[3]].push(data[(y + 1) * width + x + 1] as f64);
            }
        }
        Self { planes }
    }
}

// ─── Calibration entry point ──────────────────────────────────────────────────

/// Calibrate noise model from dark frames and flat pairs.
///
/// # Parameters
/// - `dark_frames`: a list of dark-frame `RawFrame`s (no light, same exposure as flats).
/// - `flat_pairs`: list of `(A, B)` pairs shot at the same scene; signal is computed
///   from the mean `(A+B)/2 - black` and variance from `var(A-B)/2`.
/// - `black`: pedestal to subtract before computing signal.
/// - `saturation`: pixels at or above this value are considered saturated and excluded.
///
/// # Returns
/// `CalibrationResult` or `CalibrationError`.
pub fn calibrate(
    dark_frames: &[RawFrame],
    flat_pairs: &[(RawFrame, RawFrame)],
    black: f64,
    saturation: f64,
) -> Result<CalibrationResult, CalibrationError> {
    // Threshold checks
    let n_dark = dark_frames.len();
    let n_pairs = flat_pairs.len();

    // Count unsaturated signal levels (across all planes, deduped by unique signal bucket)
    // We approximate: collect distinct integer signal levels across plane 0 flat pairs
    let signal_levels = count_unsaturated_signal_levels(flat_pairs, black, saturation);

    if n_dark < MIN_DARK_FRAMES || n_pairs < MIN_FLAT_PAIRS || signal_levels < MIN_SIGNAL_LEVELS {
        return Err(CalibrationError::InsufficientData {
            dark_frames: n_dark,
            flat_pairs: n_pairs,
            signal_levels,
        });
    }

    let mut plane_fits: [Option<PlaneFit>; 4] = [None, None, None, None];
    let mut dark_read: [f64; 4] = [0.0; 4];

    for plane in 0..4 {
        // Variance of per-frame dark means (sanity check; not per-pixel read noise).
        dark_read[plane] = dark_frame_variance(dark_frames, plane);

        // Build (signal, variance) data points from flat pairs
        let mut points: Vec<(f64, f64)> = Vec::with_capacity(flat_pairs.len());
        for (fa, fb) in flat_pairs {
            if let Some(pt) = flat_pair_point(&fa.planes[plane], &fb.planes[plane], black, saturation) {
                points.push(pt);
            }
        }
        if points.is_empty() {
            return Err(CalibrationError::FitFailed(format!(
                "no valid data points for plane {plane}"
            )));
        }

        let fit = huber_irls(&points)?;
        plane_fits[plane] = Some(fit);
    }

    Ok(CalibrationResult {
        planes: [
            plane_fits[0].unwrap(),
            plane_fits[1].unwrap(),
            plane_fits[2].unwrap(),
            plane_fits[3].unwrap(),
        ],
        dark_mean_variance: dark_read,
    })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Count distinct unsaturated signal levels in flat pairs (plane 0).
fn count_unsaturated_signal_levels(
    flat_pairs: &[(RawFrame, RawFrame)],
    black: f64,
    saturation: f64,
) -> usize {
    let mut levels: Vec<u64> = Vec::new();
    for (fa, fb) in flat_pairs {
        let pa = &fa.planes[0];
        let pb = &fb.planes[0];
        let n = pa.len().min(pb.len());
        if n == 0 {
            continue;
        }
        let mean_a: f64 = pa.iter().sum::<f64>() / n as f64;
        let mean_b: f64 = pb.iter().sum::<f64>() / n as f64;
        // Skip pairs where most pixels are saturated
        let saturated_a = pa.iter().filter(|&&v| v >= saturation).count();
        let saturated_b = pb.iter().filter(|&&v| v >= saturation).count();
        if saturated_a > n / 2 || saturated_b > n / 2 {
            continue;
        }
        let signal = ((mean_a + mean_b) / 2.0 - black).max(0.0);
        // Quantise to ~1% buckets to count distinct levels
        let bucket = (signal / (saturation - black) * 100.0) as u64;
        levels.push(bucket);
    }
    levels.sort_unstable();
    levels.dedup();
    levels.len()
}

/// Compute the variance of per-frame means across dark frames for one plane.
fn dark_frame_variance(dark_frames: &[RawFrame], plane: usize) -> f64 {
    if dark_frames.is_empty() {
        return 0.0;
    }
    let means: Vec<f64> = dark_frames
        .iter()
        .map(|f| {
            let p = &f.planes[plane];
            if p.is_empty() {
                0.0
            } else {
                p.iter().sum::<f64>() / p.len() as f64
            }
        })
        .collect();
    let grand_mean = means.iter().sum::<f64>() / means.len() as f64;
    means.iter().map(|m| (m - grand_mean).powi(2)).sum::<f64>() / means.len() as f64
}

/// Compute one (signal, variance) point from a flat pair for one plane.
/// Returns `None` when the majority of pixels are saturated or signal < 0.
fn flat_pair_point(
    pa: &[f64],
    pb: &[f64],
    black: f64,
    saturation: f64,
) -> Option<(f64, f64)> {
    let n = pa.len().min(pb.len());
    if n == 0 {
        return None;
    }

    // Exclude saturated pixels
    let (mut sum_a, mut sum_b, mut sum_diff2, mut count) = (0.0f64, 0.0f64, 0.0f64, 0usize);
    for i in 0..n {
        if pa[i] >= saturation || pb[i] >= saturation {
            continue;
        }
        sum_a += pa[i];
        sum_b += pb[i];
        let diff = pa[i] - pb[i];
        sum_diff2 += diff * diff;
        count += 1;
    }

    if count < 4 {
        return None;
    }

    let mean_a = sum_a / count as f64;
    let mean_b = sum_b / count as f64;
    let signal = (mean_a + mean_b) / 2.0 - black;
    if signal <= 0.0 {
        return None;
    }

    // variance = var(A - B) / 2 = (sum of (Ai - Bi)^2 / count) / 2
    let variance = sum_diff2 / count as f64 / 2.0;

    Some((signal, variance))
}

// ─── Huber IRLS ───────────────────────────────────────────────────────────────

const HUBER_DELTA: f64 = 1.345; // standard choice for 95% efficiency under Gaussian noise
const MAX_ITER: usize = 50;
const TOLERANCE: f64 = 1e-7;

/// Fit `variance = S·signal + O` by Huber IRLS on `(signal, variance)` pairs.
fn huber_irls(points: &[(f64, f64)]) -> Result<PlaneFit, CalibrationError> {
    let n = points.len();
    if n < 2 {
        return Err(CalibrationError::FitFailed(
            "need at least 2 data points for IRLS".into(),
        ));
    }

    let signals: Vec<f64> = points.iter().map(|(s, _)| *s).collect();
    let variances: Vec<f64> = points.iter().map(|(_, v)| *v).collect();

    // OLS initialisation
    let (mut shot, mut read) = ols(&signals, &variances);

    let mut weights = vec![1.0f64; n];

    for _iter in 0..MAX_ITER {
        // Compute residuals
        let residuals: Vec<f64> = signals
            .iter()
            .zip(variances.iter())
            .map(|(&s, &v)| v - (shot * s + read))
            .collect();

        // Robust scale estimate (MAD)
        let mut abs_res: Vec<f64> = residuals.iter().map(|r| r.abs()).collect();
        abs_res.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median = if n % 2 == 0 {
            (abs_res[n / 2 - 1] + abs_res[n / 2]) / 2.0
        } else {
            abs_res[n / 2]
        };
        let mad = median / 0.6745; // convert MAD to sigma estimate
        let sigma = mad.max(1e-12);

        // Huber weights
        let new_weights: Vec<f64> = residuals
            .iter()
            .map(|&r| {
                let u = r.abs() / sigma;
                if u <= HUBER_DELTA {
                    1.0
                } else {
                    HUBER_DELTA / u
                }
            })
            .collect();

        // Weighted least squares
        let (new_shot, new_read) = wls(&signals, &variances, &new_weights);

        let d_shot = (new_shot - shot).abs();
        let d_read = (new_read - read).abs();

        shot = new_shot;
        read = new_read;
        weights = new_weights;

        if d_shot < TOLERANCE && d_read < TOLERANCE {
            break;
        }
    }

    // Compute weighted RMS residual
    let (wsum, wrss) = signals
        .iter()
        .zip(variances.iter())
        .zip(weights.iter())
        .fold((0.0f64, 0.0f64), |(ws, wrs), ((&s, &v), &w)| {
            let r = v - (shot * s + read);
            (ws + w, wrs + w * r * r)
        });
    let fit_residual = if wsum > 0.0 { (wrss / wsum).sqrt() } else { 0.0 };

    Ok(PlaneFit {
        coeffs: FitCoeffs { shot, read },
        sample_count: n,
        fit_residual,
    })
}

/// Ordinary least squares for `y = shot·x + read`.
fn ols(x: &[f64], y: &[f64]) -> (f64, f64) {
    wls(x, y, &vec![1.0; x.len()])
}

/// Weighted least squares for `y = shot·x + read`.
fn wls(x: &[f64], y: &[f64], w: &[f64]) -> (f64, f64) {
    let n = x.len();
    let (mut sw, mut swx, mut swy, mut swxx, mut swxy) = (0.0f64, 0.0, 0.0, 0.0, 0.0);
    for i in 0..n {
        sw += w[i];
        swx += w[i] * x[i];
        swy += w[i] * y[i];
        swxx += w[i] * x[i] * x[i];
        swxy += w[i] * x[i] * y[i];
    }
    let det = sw * swxx - swx * swx;
    if det.abs() < 1e-15 {
        // Degenerate: all signal at one level
        let mean_y = if sw > 0.0 { swy / sw } else { 0.0 };
        return (0.0, mean_y);
    }
    let shot = (sw * swxy - swx * swy) / det;
    let read = (swy * swxx - swx * swxy) / det;
    (shot, read)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a deterministic synthetic dark frame: all pixels at `mean` with
    /// added pixel-level noise of standard deviation `sigma`.
    ///
    /// Uses a simple LCG with fixed seed for determinism (no external deps).
    fn synthetic_dark(mean: f64, sigma: f64, pixels: usize, seed: u64) -> RawFrame {
        let planes: [Vec<f64>; 4] = std::array::from_fn(|plane_idx| {
            let noise = lcg_noise(seed.wrapping_add(plane_idx as u64 * 100_000), pixels, sigma);
            noise.iter().map(|&n| (mean + n).max(0.0)).collect()
        });
        RawFrame { planes }
    }

    /// Build a deterministic synthetic flat frame: all pixels at `signal + black`
    /// with Poisson + Gaussian noise.
    fn synthetic_flat(signal: f64, black: f64, shot: f64, read: f64, pixels: usize, seed: u64) -> RawFrame {
        // variance per pixel = shot * signal + read
        let sigma = (shot * signal + read).max(0.0).sqrt();
        let planes: [Vec<f64>; 4] = std::array::from_fn(|plane_idx| {
            // slightly different per-plane seed
            let pnoise = lcg_noise(seed.wrapping_add(plane_idx as u64 * 10_000), pixels, sigma);
            pnoise.iter().map(|&n| (signal + black + n).max(0.0)).collect()
        });
        RawFrame { planes }
    }

    /// Simple LCG PRNG → approximately normal noise via Box-Muller.
    fn lcg_noise(seed: u64, n: usize, sigma: f64) -> Vec<f64> {
        const A: u64 = 6364136223846793005;
        const C: u64 = 1442695040888963407;
        let mut state = seed;
        let mut out = Vec::with_capacity(n);
        let mut i = 0;
        while i < n {
            state = state.wrapping_mul(A).wrapping_add(C);
            // Map to (0, 1) by taking high 32 bits / 2^32 then clamping away from 0
            let u1 = ((state >> 32) as f64 / (u32::MAX as f64 + 1.0)).max(1e-15);
            state = state.wrapping_mul(A).wrapping_add(C);
            let u2 = (state >> 32) as f64 / (u32::MAX as f64 + 1.0);
            let mag = sigma * (-2.0 * u1.ln()).sqrt();
            let theta = std::f64::consts::TAU * u2;
            out.push(mag * theta.cos());
            if i + 1 < n {
                out.push(mag * theta.sin());
            }
            i += 2;
        }
        out.truncate(n);
        out
    }

    /// Build a set of calibration frames with known per-plane S and O.
    ///
    /// Planes are given the SAME S/O for simplicity (the fitter works per-plane).
    /// Uses a logarithmically-spaced signal range so that low-signal levels
    /// (where read noise matters) are well represented alongside high-signal levels.
    fn build_calibration_data(
        known_shot: f64,
        known_read: f64,
        black: f64,
        saturation: f64,
    ) -> (Vec<RawFrame>, Vec<(RawFrame, RawFrame)>) {
        const PIXELS: usize = 256 * 256; // 65536 pixels per plane — large enough for low variance
        const N_DARK: usize = 20;
        const N_PAIRS: usize = 12; // → 12 distinct signal levels (>= MIN_SIGNAL_LEVELS=6)

        // Dark frames: mean = black, sigma = sqrt(read)
        let dark_sigma = known_read.max(0.0).sqrt();
        let darks: Vec<RawFrame> = (0..N_DARK)
            .map(|i| synthetic_dark(black, dark_sigma, PIXELS, 42 + i as u64))
            .collect();

        // Flat pairs at logarithmically-spaced signal levels so that low-signal
        // (read-noise-dominated) points are well represented.  Range: ~10 counts
        // up to 90% of full scale.  This gives OLS/IRLS a good lever to separate
        // shot vs read intercept.
        let min_signal = 10.0_f64;
        let max_signal = (saturation - black) * 0.9;
        let pairs: Vec<(RawFrame, RawFrame)> = (0..N_PAIRS)
            .map(|i| {
                let t = i as f64 / (N_PAIRS - 1) as f64; // [0, 1]
                // Logarithmic spacing: exp(log(min) + t*(log(max)-log(min)))
                let signal = min_signal * (max_signal / min_signal).powf(t);
                let fa = synthetic_flat(signal, black, known_shot, known_read, PIXELS, 1000 + i as u64 * 2);
                let fb = synthetic_flat(signal, black, known_shot, known_read, PIXELS, 1001 + i as u64 * 2);
                (fa, fb)
            })
            .collect();

        (darks, pairs)
    }

    #[test]
    fn calibrate_recovers_coefficients_within_8pct() {
        let known_shot = 0.5;
        let known_read = 50.0;
        let black = 512.0;
        let saturation = 16383.0;

        let (darks, pairs) = build_calibration_data(known_shot, known_read, black, saturation);
        let result = calibrate(&darks, &pairs, black, saturation).expect("calibration should succeed");

        for plane in 0..4 {
            let fit = &result.planes[plane];
            let shot_err = (fit.coeffs.shot - known_shot).abs() / known_shot;
            let read_err = (fit.coeffs.read - known_read).abs() / known_read;

            assert!(
                shot_err <= 0.08,
                "plane {plane}: shot error {:.2}% > 8% (got {}, expected {})",
                shot_err * 100.0,
                fit.coeffs.shot,
                known_shot
            );
            assert!(
                read_err <= 0.08,
                "plane {plane}: read error {:.2}% > 8% (got {}, expected {})",
                read_err * 100.0,
                fit.coeffs.read,
                known_read
            );
        }
    }

    #[test]
    fn calibrate_reports_sample_count_and_residual() {
        let (darks, pairs) = build_calibration_data(0.5, 50.0, 512.0, 16383.0);
        let result = calibrate(&darks, &pairs, 512.0, 16383.0).unwrap();

        for plane in 0..4 {
            assert!(
                result.planes[plane].sample_count > 0,
                "plane {plane}: zero sample count"
            );
            assert!(
                result.planes[plane].fit_residual.is_finite(),
                "plane {plane}: non-finite residual"
            );
        }
    }

    #[test]
    fn calibrate_rejects_saturated_samples() {
        // Set a very low saturation so most flat pairs are excluded
        let (darks, pairs) = build_calibration_data(0.5, 50.0, 512.0, 16383.0);
        // saturation=600 excludes all signal > 600-512=88 counts → almost everything saturated
        let err = calibrate(&darks, &pairs, 512.0, 600.0).unwrap_err();
        match err {
            CalibrationError::InsufficientData { signal_levels, .. } => {
                assert!(signal_levels < MIN_SIGNAL_LEVELS, "expected insufficient signal levels");
            }
            _ => panic!("expected InsufficientData"),
        }
    }

    #[test]
    fn calibrate_fails_with_too_few_dark_frames() {
        let darks: Vec<RawFrame> = (0..5) // < MIN_DARK_FRAMES
            .map(|i| synthetic_dark(512.0, 7.0, 64, 99 + i as u64))
            .collect();
        let (_, pairs) = build_calibration_data(0.5, 50.0, 512.0, 16383.0);
        let n_pairs = pairs.len();
        let err = calibrate(&darks, &pairs, 512.0, 16383.0).unwrap_err();
        match err {
            CalibrationError::InsufficientData { dark_frames, flat_pairs, .. } => {
                assert_eq!(dark_frames, 5, "dark frame count mismatch");
                assert_eq!(flat_pairs, n_pairs, "flat pair count mismatch");
            }
            other => panic!("expected InsufficientData, got {:?}", other),
        }
    }

    #[test]
    fn calibrate_fails_with_too_few_flat_pairs() {
        let (darks, pairs_full) = build_calibration_data(0.5, 50.0, 512.0, 16383.0);
        let pairs: Vec<(RawFrame, RawFrame)> = pairs_full.into_iter().take(4).collect(); // < MIN_FLAT_PAIRS
        let err = calibrate(&darks, &pairs, 512.0, 16383.0).unwrap_err();
        match err {
            CalibrationError::InsufficientData { flat_pairs, .. } => {
                assert_eq!(flat_pairs, 4);
            }
            _ => panic!("expected InsufficientData"),
        }
    }

    #[test]
    fn dark_mean_variance_is_plausible() {
        let known_read = 64.0; // read noise variance
        let (darks, pairs) = build_calibration_data(0.5, known_read, 512.0, 16383.0);
        let result = calibrate(&darks, &pairs, 512.0, 16383.0).unwrap();
        // dark_mean_variance is the variance of per-frame means, equal to
        // sigma_pixel^2 / pixel_count.  It should be finite and non-negative.
        for plane in 0..4 {
            assert!(
                result.dark_mean_variance[plane].is_finite() && result.dark_mean_variance[plane] >= 0.0,
                "plane {plane}: dark_mean_variance invalid"
            );
        }
    }
}
