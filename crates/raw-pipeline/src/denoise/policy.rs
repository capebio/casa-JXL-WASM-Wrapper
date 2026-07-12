use crate::denoise::types::{
    ActivationMode, DenoiseDecision, DenoiseOptions, DenoiseReason, NoiseMetrics,
};

/// Decide whether to apply denoise given the current options, image ISO, measured noise metrics,
/// and any prior noise-reduction already applied (0.0 = none, 1.0 = fully reduced).
///
/// # Decision table
///
/// | Condition | Result |
/// |-----------|--------|
/// | enabled=false | skip: Disabled |
/// | activation=Always | apply |
/// | activation=Iso + ISO missing | skip: IsoUnavailable |
/// | activation=Iso + ISO < threshold | skip: BelowIsoThreshold |
/// | activation=Iso + ISO >= threshold | apply: IsoThreshold |
/// | activation=Auto + confidence >= 0.5 | apply iff display_sigma_p90 >= noise_threshold |
/// | activation=Auto + confidence < 0.5 | use ISO threshold as fallback |
/// | activation=Auto + neither available | skip: NoiseUnavailable |
///
/// effective_strength = strength * (1 - clamp(noise_reduction_applied, 0, 1))
/// If effective_strength < 0.05 after computing apply=true → reason becomes StrengthZero.
pub fn decide(
    options: &DenoiseOptions,
    iso: Option<u32>,
    metrics: Option<NoiseMetrics>,
    noise_reduction_applied: Option<f32>,
) -> DenoiseDecision {
    if !options.enabled {
        return DenoiseDecision {
            apply: false,
            effective_strength: 0.0,
            reason: DenoiseReason::Disabled,
            source: None,
        };
    }

    let prior = noise_reduction_applied.unwrap_or(0.0).clamp(0.0, 1.0);

    let (apply, reason, source) = match options.activation {
        ActivationMode::Always => (true, DenoiseReason::AlwaysOn, metrics.map(|m| m.source)),

        ActivationMode::Iso => {
            let Some(iso_val) = iso else {
                return DenoiseDecision {
                    apply: false,
                    effective_strength: 0.0,
                    reason: DenoiseReason::IsoUnavailable,
                    source: None,
                };
            };
            if iso_val >= options.iso_threshold {
                (true, DenoiseReason::IsoThreshold, metrics.map(|m| m.source))
            } else {
                return DenoiseDecision {
                    apply: false,
                    effective_strength: 0.0,
                    reason: DenoiseReason::BelowIsoThreshold,
                    source: None,
                };
            }
        }

        ActivationMode::Auto => {
            match metrics {
                Some(m) if m.confidence >= 0.5 => {
                    if m.display_sigma_p90 >= options.noise_threshold {
                        (true, DenoiseReason::NoiseThreshold, Some(m.source))
                    } else {
                        return DenoiseDecision {
                            apply: false,
                            effective_strength: 0.0,
                            reason: DenoiseReason::BelowNoiseThreshold,
                            source: Some(m.source),
                        };
                    }
                }
                // Low-confidence: fall back to ISO threshold
                Some(m) => {
                    let src = Some(m.source);
                    let Some(iso_val) = iso else {
                        return DenoiseDecision {
                            apply: false,
                            effective_strength: 0.0,
                            reason: DenoiseReason::NoiseUnavailable,
                            source: src,
                        };
                    };
                    if iso_val >= options.iso_threshold {
                        (true, DenoiseReason::LowConfidenceFallbackIso, src)
                    } else {
                        return DenoiseDecision {
                            apply: false,
                            effective_strength: 0.0,
                            reason: DenoiseReason::LowConfidenceFallbackBelowIso,
                            source: src,
                        };
                    }
                }
                // No metrics at all — treat as unavailable regardless of ISO
                // (we cannot trust ISO alone in Auto mode with no noise measurement)
                None => {
                    return DenoiseDecision {
                        apply: false,
                        effective_strength: 0.0,
                        reason: DenoiseReason::NoiseUnavailable,
                        source: None,
                    };
                }
            }
        }
    };

    let effective_strength = options.strength * (1.0 - prior);
    if apply && effective_strength < 0.05 {
        return DenoiseDecision {
            apply: false,
            effective_strength: 0.0,
            reason: DenoiseReason::StrengthZero,
            source,
        };
    }

    DenoiseDecision {
        apply,
        effective_strength,
        reason,
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::denoise::types::*;

    fn default_opts() -> DenoiseOptions {
        DenoiseOptions { enabled: true, ..Default::default() }
    }

    fn high_noise_metrics() -> NoiseMetrics {
        NoiseMetrics {
            display_sigma_p90: 6.0,
            sigma_18: 0.01,
            sigma_shadow: 0.02,
            snr_18_db: 28.0,
            confidence: 0.9,
            source: NoiseSource::BlindFit,
        }
    }

    fn low_noise_metrics() -> NoiseMetrics {
        NoiseMetrics {
            display_sigma_p90: 0.5,
            sigma_18: 0.001,
            sigma_shadow: 0.002,
            snr_18_db: 45.0,
            confidence: 0.9,
            source: NoiseSource::DngNoiseProfile,
        }
    }

    // disabled — always skips
    #[test]
    fn disabled_skips() {
        let opts = DenoiseOptions { enabled: false, ..Default::default() };
        let d = decide(&opts, Some(3200), Some(high_noise_metrics()), None);
        assert!(!d.apply);
        assert_eq!(d.reason, DenoiseReason::Disabled);
    }

    // always mode — ignores ISO and metrics
    #[test]
    fn always_applies_regardless_of_noise() {
        let opts = DenoiseOptions {
            enabled: true,
            activation: ActivationMode::Always,
            ..Default::default()
        };
        let d = decide(&opts, None, None, None);
        assert!(d.apply);
        assert_eq!(d.reason, DenoiseReason::AlwaysOn);
    }

    // iso mode — ISO missing
    #[test]
    fn iso_mode_missing_iso_skips() {
        let opts = DenoiseOptions {
            enabled: true,
            activation: ActivationMode::Iso,
            iso_threshold: 800,
            ..Default::default()
        };
        let d = decide(&opts, None, None, None);
        assert!(!d.apply);
        assert_eq!(d.reason, DenoiseReason::IsoUnavailable);
    }

    // iso mode — ISO strictly below threshold
    #[test]
    fn iso_mode_below_threshold_skips() {
        let opts = DenoiseOptions {
            enabled: true,
            activation: ActivationMode::Iso,
            iso_threshold: 1600,
            ..Default::default()
        };
        let d = decide(&opts, Some(800), None, None);
        assert!(!d.apply);
        assert_eq!(d.reason, DenoiseReason::BelowIsoThreshold);
    }

    // iso mode — ISO at threshold applies
    #[test]
    fn iso_mode_at_threshold_applies() {
        let opts = DenoiseOptions {
            enabled: true,
            activation: ActivationMode::Iso,
            iso_threshold: 1600,
            ..Default::default()
        };
        let d = decide(&opts, Some(1600), None, None);
        assert!(d.apply);
        assert_eq!(d.reason, DenoiseReason::IsoThreshold);
    }

    // auto mode — trusted score triggers at ISO 200 (high noise measured)
    #[test]
    fn trusted_noise_can_trigger_at_iso_200() {
        let options = DenoiseOptions { enabled: true, ..Default::default() };
        let metrics = NoiseMetrics {
            display_sigma_p90: 6.0,
            sigma_18: 0.004,
            sigma_shadow: 0.012,
            snr_18_db: 33.1,
            confidence: 0.91,
            source: NoiseSource::BlindFit,
        };
        let d = decide(&options, Some(200), Some(metrics), None);
        assert!(d.apply);
        assert_eq!(d.reason, DenoiseReason::NoiseThreshold);
    }

    // auto mode — low confidence + ISO >= threshold → fallback apply
    #[test]
    fn low_confidence_iso_fallback_applies() {
        let opts = DenoiseOptions {
            enabled: true,
            activation: ActivationMode::Auto,
            iso_threshold: 1600,
            ..Default::default()
        };
        let metrics = NoiseMetrics {
            display_sigma_p90: 2.0,
            sigma_18: 0.005,
            sigma_shadow: 0.01,
            snr_18_db: 30.0,
            confidence: 0.40, // low
            source: NoiseSource::IsoFallback,
        };
        let d = decide(&opts, Some(3200), Some(metrics), None);
        assert!(d.apply);
        assert_eq!(d.reason, DenoiseReason::LowConfidenceFallbackIso);
    }

    // auto mode — low confidence + ISO below threshold → skip
    #[test]
    fn low_confidence_below_iso_skips() {
        let opts = DenoiseOptions {
            enabled: true,
            activation: ActivationMode::Auto,
            iso_threshold: 1600,
            ..Default::default()
        };
        let metrics = NoiseMetrics {
            display_sigma_p90: 1.8,
            sigma_18: 0.004,
            sigma_shadow: 0.009,
            snr_18_db: 31.0,
            confidence: 0.45, // below 0.5 threshold → low-confidence ISO fallback
            source: NoiseSource::IsoFallback,
        };
        let d = decide(&opts, Some(800), Some(metrics), None);
        assert!(!d.apply);
        assert_eq!(d.reason, DenoiseReason::LowConfidenceFallbackBelowIso);
    }

    // auto mode — missing metadata entirely
    #[test]
    fn missing_metadata_skips() {
        let opts = default_opts();
        let d = decide(&opts, None, None, None);
        assert!(!d.apply);
        assert_eq!(d.reason, DenoiseReason::NoiseUnavailable);
    }

    // auto mode — no metrics but ISO available → still unavailable (Auto requires noise measurement)
    #[test]
    fn no_metrics_auto_skips_even_with_iso() {
        let opts = default_opts();
        let d = decide(&opts, Some(6400), None, None);
        assert!(!d.apply);
        assert_eq!(d.reason, DenoiseReason::NoiseUnavailable);
    }

    // prior RAW reduction fully blocks application
    #[test]
    fn prior_full_noise_reduction_blocks() {
        let opts = default_opts();
        let d = decide(&opts, Some(3200), Some(high_noise_metrics()), Some(1.0));
        assert!(!d.apply);
        assert_eq!(d.reason, DenoiseReason::StrengthZero);
    }

    // prior partial reduction reduces effective_strength
    #[test]
    fn prior_partial_reduction_scales_strength() {
        let opts = DenoiseOptions {
            enabled: true,
            strength: 1.0,
            ..Default::default()
        };
        let d = decide(&opts, Some(3200), Some(high_noise_metrics()), Some(0.5));
        assert!(d.apply);
        assert!((d.effective_strength - 0.5).abs() < 1e-5);
    }

    // auto mode — high confidence but noise below threshold → skip
    #[test]
    fn clean_image_high_confidence_skips() {
        let opts = default_opts(); // noise_threshold = 4.0
        let d = decide(&opts, Some(200), Some(low_noise_metrics()), None); // sigma_p90 = 0.5
        assert!(!d.apply);
        assert_eq!(d.reason, DenoiseReason::BelowNoiseThreshold);
    }

    // auto mode — low confidence + ISO missing → skip as unavailable
    #[test]
    fn low_confidence_missing_iso_skips() {
        let options = DenoiseOptions { enabled: true, ..Default::default() };
        let metrics = NoiseMetrics {
            display_sigma_p90: 2.5,
            sigma_18: 0.005,
            sigma_shadow: 0.015,
            snr_18_db: 30.0,
            confidence: 0.40, // below 0.5
            source: NoiseSource::BlindFit,
        };
        let d = decide(&options, None, Some(metrics), None);
        assert!(!d.apply);
        assert_eq!(d.reason, DenoiseReason::NoiseUnavailable);
    }

    // effective_strength propagated correctly on apply
    #[test]
    fn effective_strength_is_strength_when_no_prior() {
        let opts = DenoiseOptions {
            enabled: true,
            strength: 0.8,
            ..Default::default()
        };
        let d = decide(&opts, Some(3200), Some(high_noise_metrics()), None);
        assert!(d.apply);
        assert!((d.effective_strength - 0.8).abs() < 1e-5);
    }
}
