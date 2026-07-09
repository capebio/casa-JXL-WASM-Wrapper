//! Static fallback prior (design §7, Approach C — demoted).
//!
//! When calibration cannot run (locked out, budget-starved, sandbox forbids timing)
//! the selector still needs *some* choice. This gives a conservative one keyed by a
//! coarse hardware signature. It is NOT a measurement and never overrides a real
//! profile — it is only the last resort before falling back to raw feature-presence.

use crate::calibration::profile::{HwSignature, Selections};

/// A conservative prior for `sig`. Deliberately cautious on AVX-512: even when the
/// feature is present we do NOT assume it is fastest (VM downclocking / gather cost is
/// exactly what calibration exists to measure), so the prior stays on AVX2. Threads
/// default to the effective core budget.
pub fn prior_for(sig: &HwSignature) -> Selections {
    let has = |f: &str| sig.cpu_features.iter().any(|x| x == f);

    let backend = if sig.arch == "x86_64" {
        if has("avx2") && has("fma") {
            Some(1) // avx2-strict — safe, no downclock surprise
        } else {
            Some(0) // scalar
        }
    } else {
        None // non-x86: let the runtime default (wasm simd / scalar) stand
    };

    // Conservative: use the whole (cgroup-clamped) budget. The measured pass may lower
    // this if scaling plateaus; the prior just avoids under- or over-provisioning.
    let threads = if sig.core_budget > 1 {
        Some(sig.core_budget)
    } else {
        None
    };

    Selections {
        perceptual_backend: backend,
        perceptual_backend_label: backend.map(|id| match id {
            0 => "scalar".to_string(),
            1 => "avx2-strict".to_string(),
            _ => "unknown".to_string(),
        }),
        encode_threads: threads,
        decode_threads: threads,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig(arch: &str, features: &[&str], cores: usize) -> HwSignature {
        HwSignature {
            arch: arch.to_string(),
            cpu_features: features.iter().map(|s| s.to_string()).collect(),
            core_budget: cores,
        }
    }

    #[test]
    fn avx512_present_still_priors_avx2_for_safety() {
        let s = sig("x86_64", &["avx2", "fma", "avx512f", "avx512bw"], 16);
        let sel = prior_for(&s);
        assert_eq!(sel.perceptual_backend, Some(1), "prior must stay on avx2, not avx512");
        assert_eq!(sel.encode_threads, Some(16));
    }

    #[test]
    fn no_avx2_priors_scalar() {
        let s = sig("x86_64", &["sse4.2"], 4);
        assert_eq!(prior_for(&s).perceptual_backend, Some(0));
    }

    #[test]
    fn single_core_leaves_threads_default() {
        let s = sig("x86_64", &["avx2", "fma"], 1);
        assert_eq!(prior_for(&s).encode_threads, None);
    }

    #[test]
    fn non_x86_leaves_backend_default() {
        let s = sig("wasm32", &["simd128"], 8);
        assert_eq!(prior_for(&s).perceptual_backend, None);
    }
}
