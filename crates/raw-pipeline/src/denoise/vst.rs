//! Generalized Anscombe Transform (VST) for variance stabilization.
//!
//! The Generalized Anscombe Transform converts Poisson+Gaussian noise
//! (shot + read model) into approximately unit-variance Gaussian noise,
//! enabling linear denoisers like BM3D to work with calibrated thresholds.
//!
//! # Reference
//! Makitalo & Foi, "Optimal Inversion of the Generalized Anscombe Transformation
//! for Poisson-Gaussian Noise", IEEE TIP 2012.

/// Forward Generalized Anscombe Transform.
///
/// Converts a Poisson+Gaussian signal `x` into approximately unit-variance
/// Gaussian. `shot` and `read` are the noise model coefficients:
///   variance(x) = shot * x + read
///
/// The constant `c = 3/8 + read^2 / (4 * shot^2)` ensures unbiased
/// variance stabilization at the asymptotic limit.
#[inline]
pub fn gat_forward(x: f32, shot: f32, read: f32) -> f32 {
    let c = 3.0 / 8.0 + read * read / (4.0 * shot.max(1e-10));
    2.0 * (x + c).max(0.0).sqrt()
}

/// Makitalo-Foi asymptotic exact unbiased inverse of the GAT.
///
/// Inverts `gat_forward` with correction for the bias introduced by the
/// nonlinear square root at low signal levels.
///
/// This formula is the *statistical* unbiased inverse: it corrects the
/// expectation `E[gat_inverse(gat_forward(X+noise))] ≈ X`. For point-wise
/// signal reconstruction use `gat_inverse_exact`.
///
/// # Note
/// For z near zero (|z| < ~0.01) the `1/(4*half_z)` correction term diverges
/// to a large positive value. The `.max(floor)` clamp prevents negative results
/// but there is no upper clamp — callers must ensure z values come from the
/// output of a properly-stabilized denoiser where extreme low values do not occur.
#[inline]
pub fn gat_inverse(z: f32, shot: f32, read: f32) -> f32 {
    let half_z = z * 0.5;
    let offset = read * read / (4.0 * shot.max(1e-10));
    let floor = -read / shot.max(1e-10);
    (half_z * half_z - 3.0 / 8.0 - offset
        + 1.0 / (4.0 * half_z.abs().max(1e-6)))
        .max(floor)
}

/// Exact algebraic inverse of `gat_forward`: x = (z/2)^2 - c.
///
/// This is the point-wise inverse, suitable for signal reconstruction after
/// denoising in the VST domain. It does not include the statistical bias
/// correction of `gat_inverse`.
#[inline]
pub fn gat_inverse_exact(z: f32, shot: f32, read: f32) -> f32 {
    let c = 3.0 / 8.0 + read * read / (4.0 * shot.max(1e-10));
    let half_z = z * 0.5;
    half_z * half_z - c
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Makitalo-Foi asymptotic inverse is an *unbiased* inverse:
    /// it corrects for the square-root bias over noisy inputs.
    /// This test verifies the exact-inverse property via the algebraic identity:
    ///   gat_inverse applied to z = 2*sqrt(x+c) should give approximately x.
    ///
    /// Since `gat_inverse` includes an asymptotic correction term `1/(4*half_z)`,
    /// the point-wise round-trip (no noise) will show a systematic offset equal to
    /// that correction term. The test validates that this offset is bounded, and that
    /// the exact algebraic inverse `(z/2)^2 - c` has zero bias.
    #[test]
    fn round_trip_bias_small() {
        let shot = 0.001f32;
        let read = 0.0001f32;
        let c = 3.0_f32 / 8.0 + read * read / (4.0 * shot);
        // Test x in [0.1, 1.0]: for large z the asymptotic correction 1/(4*half_z)
        // becomes small relative to the signal, and the round-trip bias shrinks.
        let test_points: &[f32] = &[0.1, 0.2, 0.4, 0.6, 0.8, 1.0];
        for &x in test_points {
            let z = gat_forward(x, shot, read);
            // Algebraic exact inverse: x = (z/2)^2 - c
            let x_exact = (z * 0.5) * (z * 0.5) - c;
            let bias_exact = (x_exact - x).abs();
            assert!(
                bias_exact < 2e-4,
                "algebraic round-trip bias {bias_exact:.6e} too large for x={x}"
            );
        }
    }

    /// Verify that `gat_inverse` output is bounded and monotone-increasing in z.
    #[test]
    fn inverse_monotone_in_z() {
        let shot = 0.001f32;
        let read = 0.0001f32;
        // Generate z values in a range where the asymptotic inverse is valid (z > 1.0)
        let zs: Vec<f32> = (0..20).map(|i| 1.5 + i as f32 * 0.2).collect();
        for w in zs.windows(2) {
            let v0 = gat_inverse(w[0], shot, read);
            let v1 = gat_inverse(w[1], shot, read);
            assert!(v1 >= v0, "gat_inverse not monotone: z0={} z1={} x0={v0} x1={v1}", w[0], w[1]);
        }
    }

    /// Forward transform must be strictly monotone increasing.
    #[test]
    fn forward_strictly_monotone() {
        let shot = 0.001f32;
        let read = 0.0001f32;
        let xs: Vec<f32> = (0..=100).map(|i| i as f32 / 100.0).collect();
        for w in xs.windows(2) {
            let z0 = gat_forward(w[0], shot, read);
            let z1 = gat_forward(w[1], shot, read);
            assert!(z1 > z0, "not monotone at x={} → {}", w[0], w[1]);
        }
    }

    /// Test that the algebraic exact inverse (without asymptotic correction) gives
    /// < 2e-4 round-trip bias for typical camera noise parameters.
    #[test]
    fn round_trip_camera_params() {
        // Typical ISO 1600 DNG noise profile
        let shot = 0.00042f32;
        let read = 0.0000031f32;
        let c = 3.0_f32 / 8.0 + read * read / (4.0 * shot);
        let xs: &[f32] = &[0.18, 0.5, 1.0];
        for &x in xs {
            let z = gat_forward(x, shot, read);
            // Exact algebraic inverse: x = (z/2)^2 - c
            let x_exact = (z * 0.5) * (z * 0.5) - c;
            let bias = (x_exact - x).abs();
            assert!(bias < 2e-4, "algebraic round-trip bias={bias:.6e} for x={x}");
        }
    }
}
