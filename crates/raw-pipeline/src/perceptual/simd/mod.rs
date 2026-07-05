//! Backend identification + runtime dispatch. Per-arch kernels live in `avx2`,
//! `avx512`, and `wasm`; shared scalar tails in `scalar`.
// SpeedCodeReview ✓ 2026-06-19 · opus-4.8[1m] · sweeps=2 · Arch 2/0/1 Alg 2/0/0 Code 6/5/1 (x/y/z=found/green/red, +3 deferred)

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    Scalar = 0,
    Avx2Strict = 1,
    Avx2Rsqrt = 2,
    /// AVX-512 strict (f32x16, full sqrt + div, fast gather on server CPUs). NOT
    /// benchmarked on the dev machine (i7-10850H has no AVX-512) — kept for the
    /// production fleet; correctness verified by parity tests on real hardware.
    Avx512Strict = 3,
    /// wasm32 v128 SIMD (4-wide f32). Selected at wasm build time when simd128 is on.
    WasmSimd = 4,
    /// AVX-512 rsqrt (rsqrt14/rcp14 approximations for sqrt and 1/m). Alternate
    /// route flip-flopped against Avx512Strict on real hardware.
    Avx512Rsqrt = 5,
}

/// Backend for the current wasm build: WasmSimd when compiled with `+simd128`,
/// else Scalar. (simd128 is a compile-time target feature, not runtime-probed.)
#[cfg(target_arch = "wasm32")]
pub fn detect_wasm() -> Backend {
    #[cfg(target_feature = "simd128")]
    {
        Backend::WasmSimd
    }
    #[cfg(not(target_feature = "simd128"))]
    {
        Backend::Scalar
    }
}

/// Best backend available on this CPU. Prefers AVX-512 when present (its fast
/// gather is the reason it exists here), else AVX2, else scalar. Browser wasm32
/// v128 path is selected via `detect_wasm`.
pub fn detect_native(prefer_rsqrt: bool) -> Backend {
    #[cfg(target_arch = "x86_64")]
    {
        // AVX-512 backends reuse the AVX2/FMA SSIM/PSNR kernels, so require avx2+fma too
        // (mirrors resolve_forced_backend) — never Auto-select a backend whose kernels need
        // features the CPU may lack.
        if std::is_x86_feature_detected!("avx512f")
            && std::is_x86_feature_detected!("avx512bw")
            && std::is_x86_feature_detected!("avx2")
            && std::is_x86_feature_detected!("fma")
        {
            return Backend::Avx512Strict;
        }
        if std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma") {
            return if prefer_rsqrt {
                Backend::Avx2Rsqrt
            } else {
                Backend::Avx2Strict
            };
        }
    }
    let _ = prefer_rsqrt;
    Backend::Scalar
}

/// Scalar tail helpers shared across all SIMD backends. No arch gate.
pub mod scalar;

#[cfg(target_arch = "x86_64")]
pub mod avx2;

#[cfg(target_arch = "x86_64")]
pub mod avx512;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detect_returns_something() {
        let b = detect_native(false);
        assert!(matches!(
            b,
            Backend::Scalar
                | Backend::Avx2Strict
                | Backend::Avx2Rsqrt
                | Backend::Avx512Strict
                | Backend::Avx512Rsqrt
                | Backend::WasmSimd
        ));
    }
}
