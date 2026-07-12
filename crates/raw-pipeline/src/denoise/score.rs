//! Re-exports and supplementary wrappers for the noise scoring API.
//!
//! The core implementation lives in `estimate.rs`.  This module re-exports
//! the public surface and provides the `NoiseScore` builder, which wires
//! `resolve_noise_model` + `iso_fallback_model` + `score_noise` together
//! in one call.

pub use super::estimate::{
    estimate_noise, iso_fallback_model, linear_to_srgb, resolve_noise_model, score_noise,
};

use super::dng_tags::RawNoiseMetadata;
use super::types::{NoiseMetrics, NoiseModel};

/// Convenience wrapper: resolve the best available model and score it.
///
/// Priority: embedded > registry > blind > ISO fallback.
/// If ISO fallback is also unavailable, returns `None`.
pub fn resolve_and_score(
    raw: &[u16],
    width: usize,
    height: usize,
    cfa: usize,
    metadata: &RawNoiseMetadata,
    embedded: Option<NoiseModel>,
    registry: Option<NoiseModel>,
    blind: Option<NoiseModel>,
    iso: Option<u32>,
    wb: &[f32; 4],
) -> Option<NoiseMetrics> {
    let model = resolve_noise_model(embedded, registry, blind)
        .or_else(|| iso.map(iso_fallback_model))?;

    Some(score_noise(raw, width, height, cfa, metadata, &model, wb))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::denoise::types::{NoiseCoefficients, NoiseSource};

    fn flat_raw(w: usize, h: usize, signal_norm: f32) -> (Vec<u16>, RawNoiseMetadata) {
        const BLACK: f32 = 512.0;
        const WHITE: f32 = 16383.0;
        let raw = vec![((signal_norm * (WHITE - BLACK) + BLACK) as u16).min(WHITE as u16); w * h];
        let meta = RawNoiseMetadata {
            black: [BLACK; 4],
            white: [WHITE; 4],
            ..Default::default()
        };
        (raw, meta)
    }

    #[test]
    fn resolve_and_score_uses_embedded_first() {
        let (raw, meta) = flat_raw(128, 128, 0.20);
        let embedded = Some(NoiseModel {
            planes: [NoiseCoefficients { shot: 1e-3, read: 1e-5 }; 4],
            structured_sigma: [0.0; 4],
            confidence: 1.0,
            source: NoiseSource::DngNoiseProfile,
        });
        let wb = [1.0f32; 4];
        let metrics = resolve_and_score(&raw, 128, 128, 0, &meta, embedded, None, None, None, &wb);
        assert!(metrics.is_some());
        let m = metrics.unwrap();
        assert_eq!(m.source, NoiseSource::DngNoiseProfile);
    }

    #[test]
    fn resolve_and_score_falls_back_to_iso() {
        let (raw, meta) = flat_raw(128, 128, 0.20);
        let wb = [1.0f32; 4];
        let metrics = resolve_and_score(&raw, 128, 128, 0, &meta, None, None, None, Some(1600), &wb);
        assert!(metrics.is_some());
        let m = metrics.unwrap();
        assert_eq!(m.source, NoiseSource::IsoFallback);
    }

    #[test]
    fn resolve_and_score_returns_none_when_nothing_available() {
        let (raw, meta) = flat_raw(128, 128, 0.20);
        let wb = [1.0f32; 4];
        let result = resolve_and_score(&raw, 128, 128, 0, &meta, None, None, None, None, &wb);
        assert!(result.is_none());
    }

    #[test]
    fn iso_fallback_priority_order() {
        // embedded > registry > blind > iso
        let embedded = Some(NoiseModel {
            planes: [NoiseCoefficients { shot: 1e-4, read: 1e-6 }; 4],
            structured_sigma: [0.0; 4],
            confidence: 1.0,
            source: NoiseSource::DngNoiseProfile,
        });
        let registry = Some(NoiseModel {
            planes: [NoiseCoefficients { shot: 2e-4, read: 2e-6 }; 4],
            structured_sigma: [0.0; 4],
            confidence: 0.9,
            source: NoiseSource::CameraProfile,
        });
        let blind = Some(NoiseModel {
            planes: [NoiseCoefficients { shot: 3e-4, read: 3e-6 }; 4],
            structured_sigma: [0.0; 4],
            confidence: 0.7,
            source: NoiseSource::BlindFit,
        });

        // embedded wins
        let m = resolve_noise_model(embedded.clone(), registry.clone(), blind.clone()).unwrap();
        assert_eq!(m.source, NoiseSource::DngNoiseProfile);

        // registry wins over blind
        let m = resolve_noise_model(None, registry.clone(), blind.clone()).unwrap();
        assert_eq!(m.source, NoiseSource::CameraProfile);

        // blind alone
        let m = resolve_noise_model(None, None, blind.clone()).unwrap();
        assert_eq!(m.source, NoiseSource::BlindFit);

        // iso fallback (manual — resolve returns None, caller uses fallback)
        assert!(resolve_noise_model(None, None, None).is_none());
        let fallback = iso_fallback_model(200);
        assert_eq!(fallback.source, NoiseSource::IsoFallback);
        assert!((fallback.confidence - 0.3).abs() < 1e-6);
    }

    #[test]
    fn higher_iso_gives_larger_sigma_in_score() {
        let (raw, meta) = flat_raw(128, 128, 0.25);
        let wb = [1.0f32; 4];

        let m_low = resolve_and_score(
            &raw, 128, 128, 0, &meta, None, None, None, Some(200), &wb,
        )
        .unwrap();
        let m_high = resolve_and_score(
            &raw, 128, 128, 0, &meta, None, None, None, Some(3200), &wb,
        )
        .unwrap();

        assert!(
            m_high.display_sigma_p90 > m_low.display_sigma_p90,
            "ISO 3200 ({}) should have higher sigma than ISO 200 ({})",
            m_high.display_sigma_p90,
            m_low.display_sigma_p90
        );
    }

    #[test]
    fn linear_to_srgb_identity_at_endpoints() {
        assert!((linear_to_srgb(0.0) - 0.0).abs() < 1e-6, "sRGB(0)=0");
        assert!((linear_to_srgb(1.0) - 1.0).abs() < 1e-4, "sRGB(1)=1");
    }
}
