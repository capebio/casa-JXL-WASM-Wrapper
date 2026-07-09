//! Declarative catalog of hardware-dependent pathways.
//!
//! The explicit "map" of every tunable, hardware-sensitive route through the engine.
//! Data only — consumed by the prober (accessibility), the `routes` report (human
//! view), and later the bench harness. Quality/size knobs are intentionally absent;
//! this calibration tunes only hardware-sensitive throughput. See design §4.1 / §5.

/// The throughput dimension a pathway moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    /// Which SIMD kernel implementation runs (scalar / AVX2 / AVX-512 / wasm-v128).
    SimdBackend,
    /// Thread / worker concurrency.
    Concurrency,
    /// Which WASM build tier loads (browser).
    WasmTier,
}

/// Where a pathway is reachable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Env {
    Native,
    Browser,
    Both,
}

/// One tunable, hardware-dependent route through the engine. Data only — the
/// declarative map the design calls for.
#[derive(Clone, Copy, Debug)]
pub struct Pathway {
    /// Stable key, e.g. `native.backend.perceptual`.
    pub id: &'static str,
    pub description: &'static str,
    /// The mutually-exclusive implementations to choose among.
    pub variants: &'static [&'static str],
    /// Where the runtime currently selects, as `file:line`.
    pub selector_site: &'static str,
    pub axis: Axis,
    pub env: Env,
}

/// The native (server-primary) catalog. Kept in sync with the design's §5 table.
pub fn native_registry() -> Vec<Pathway> {
    vec![
        Pathway {
            id: "native.backend.perceptual",
            description: "Perceptual SIMD kernels (xyb/blur/ssim/psnr/downsample)",
            variants: &[
                "scalar",
                "avx2-strict",
                "avx2-rsqrt",
                "avx512-strict",
                "avx512-rsqrt",
            ],
            selector_site:
                "perceptual/simd/mod.rs:38 (detect_native) / perceptual/mod.rs:644 (resolve_backend)",
            axis: Axis::SimdBackend,
            env: Env::Native,
        },
        Pathway {
            id: "native.telemetry.analyze",
            description: "Frame-stats + histogram (analyze_fused)",
            variants: &["scalar", "avx2"],
            selector_site: "perceptual/telemetry.rs:314 (analyze_fused)",
            axis: Axis::SimdBackend,
            env: Env::Native,
        },
        Pathway {
            id: "native.tone.bulk",
            description: "Tone matrix multiply (apply_tone_bulk)",
            variants: &["scalar", "avx2-fma"],
            selector_site: "tone_simd.rs:95 (apply_tone_bulk)",
            axis: Axis::SimdBackend,
            env: Env::Native,
        },
        Pathway {
            id: "native.decode.threads",
            description: "JXL decode threading (Decoder::with_threads)",
            variants: &["single-thread", "rayon-N"],
            selector_site: "jxl_casadecoder.rs:321 (with_threads)",
            axis: Axis::Concurrency,
            env: Env::Native,
        },
        Pathway {
            id: "native.encode.threads",
            description: "JXL encode threading (Encoder::with_threads)",
            variants: &["single-thread", "rayon-N"],
            selector_site: "jxl_casaencoder.rs:453 (with_threads)",
            axis: Axis::Concurrency,
            env: Env::Native,
        },
        Pathway {
            id: "native.casv.enc.threads",
            description: "CASV streaming encode threads (CASV_ENC_THREADS)",
            variants: &["available_parallelism", "env-override-N"],
            selector_site: "casa_video.rs:833 (CASV_ENC_THREADS)",
            axis: Axis::Concurrency,
            env: Env::Native,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_non_empty_and_well_formed() {
        let r = native_registry();
        assert!(!r.is_empty());
        for p in &r {
            assert!(!p.id.is_empty(), "pathway id empty");
            assert!(!p.variants.is_empty(), "{} has no variants", p.id);
            assert!(!p.selector_site.is_empty(), "{} has no selector site", p.id);
        }
    }

    #[test]
    fn ids_are_unique() {
        let r = native_registry();
        let mut ids: Vec<&str> = r.iter().map(|p| p.id).collect();
        ids.sort_unstable();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n, "duplicate pathway ids");
    }

    #[test]
    fn covers_simd_backend_axis() {
        let r = native_registry();
        assert!(
            r.iter().any(|p| p.axis == Axis::SimdBackend),
            "no SIMD-backend pathway in registry"
        );
    }
}
