//! Cross-backend parity gate.
//!
//! The fractal corpus has known, deterministic output, so it doubles as a correctness
//! oracle: every executable SIMD backend must reproduce the scalar reference's
//! butteraugli score. A backend that disagrees is disqualified before it can be timed.
//! See design §4.4.

use crate::calibration::fractal::FractalSpec;
use crate::perceptual::{BackendChoice, Comparer, Opts};

/// One backend's parity result against the scalar oracle.
#[derive(Clone, Debug)]
pub struct ParityResult {
    pub variant: &'static str,
    pub score: f32,
    pub scalar_score: f32,
    pub matches_scalar: bool,
}

/// Distort a copy of the fractal so the butteraugli score is non-trivial (a
/// self-compare would be 0 on every backend and prove nothing). Deterministic.
fn distort(px: &[u8]) -> Vec<u8> {
    px.iter()
        .enumerate()
        .map(|(i, &v)| if i % 4 == 3 { v } else { v.wrapping_add(7) })
        .collect()
}

/// The forced-backend ids to test, paired with their registry variant label. Only
/// those the CPU can actually execute are run, so the report is honest about what ran.
fn candidate_backends() -> Vec<(&'static str, BackendChoice)> {
    let mut v = vec![("scalar", BackendChoice::ForceScalar)];
    #[cfg(target_arch = "x86_64")]
    {
        let avx2 = std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma");
        let avx512 = avx2
            && std::is_x86_feature_detected!("avx512f")
            && std::is_x86_feature_detected!("avx512bw");
        if avx2 {
            v.push(("avx2-strict", BackendChoice::Force(1)));
            v.push(("avx2-rsqrt", BackendChoice::Force(2)));
        }
        if avx512 {
            v.push(("avx512-strict", BackendChoice::Force(3)));
            v.push(("avx512-rsqrt", BackendChoice::Force(5)));
        }
    }
    v
}

/// Relative tolerance for *strict* SIMD backends vs the scalar oracle. The final
/// butteraugli score is not bit-identical to scalar: the AVX2/AVX-512 kernels use
/// fused multiply-add (`fmadd`) where the scalar path rounds each mul then add, so
/// the score carries a rounding asymmetry (~2e-7 relative on the seahorse corpus,
/// measured 2026-07-09). `1e-4` is ~1000× that drift — tight enough to catch a
/// genuinely broken/miscompiled backend (which diverges by percent), loose enough to
/// pass fmadd rounding noise.
const STRICT_REL_TOL: f32 = 1e-4;
/// Relative tolerance for *rsqrt* backends, which additionally use reciprocal-sqrt
/// approximations (rsqrt14/rcp14) by design — a coarser but still bounded error.
const RSQRT_REL_TOL: f32 = 5e-3;

/// Run the parity gate on `spec`: every executable backend must reproduce the scalar
/// butteraugli score on the fractal, within a documented tolerance. Returns one row
/// per backend that ran.
pub fn parity_check(spec: &FractalSpec) -> Vec<ParityResult> {
    let reference = spec.render_rgba8();
    let test = distort(&reference);
    let (w, h) = (spec.width, spec.height);

    let score_with = |choice: BackendChoice| -> f32 {
        let opts = Opts {
            backend: choice,
            ..Opts::default()
        };
        let mut cmp = Comparer::new(reference.clone(), w, h, opts);
        cmp.butteraugli(&test)
    };

    let scalar_score = score_with(BackendChoice::ForceScalar);
    candidate_backends()
        .into_iter()
        .map(|(variant, choice)| {
            let score = score_with(choice);
            let tol = if variant.contains("rsqrt") {
                RSQRT_REL_TOL
            } else {
                STRICT_REL_TOL
            };
            let denom = scalar_score.abs().max(1e-6);
            let matches = ((score - scalar_score).abs() / denom) < tol;
            ParityResult {
                variant,
                score,
                scalar_score,
                matches_scalar: matches,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calibration::fractal::{Dataset, FractalSpec};

    #[test]
    fn scalar_vs_active_backend_agree_on_fractal() {
        let spec = FractalSpec::preset(Dataset::MandelbrotSeahorse, 96, 96);
        let report = parity_check(&spec);
        assert!(report.iter().any(|r| r.variant == "scalar"));
        for r in &report {
            assert!(
                r.matches_scalar,
                "backend {} disagrees with scalar: score={} scalar={}",
                r.variant, r.score, r.scalar_score
            );
        }
    }
}
