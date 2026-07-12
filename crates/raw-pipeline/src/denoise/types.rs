/// Per-channel Poisson + Gaussian noise model coefficients.
/// variance(signal) = shot * signal + read
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseCoefficients {
    pub shot: f32,
    pub read: f32,
}

impl NoiseCoefficients {
    /// Variance at a given normalised signal level.
    pub fn variance(self, signal: f32) -> f32 {
        (self.shot * signal.max(0.0) + self.read).max(0.0)
    }
}

/// How denoise is activated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationMode {
    /// Decide based on measured noise level and confidence (default).
    Auto,
    /// Apply whenever ISO meets the threshold.
    Iso,
    /// Always apply, regardless of ISO or noise measurement.
    Always,
}

/// Where the noise model came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoiseSource {
    /// Embedded DNG NoiseProfile tag.
    DngNoiseProfile,
    /// Per-camera profile database.
    CameraProfile,
    /// Blind estimation from the image itself.
    BlindFit,
    /// ISO-derived heuristic (low-confidence fallback).
    IsoFallback,
    /// No usable source.
    Unavailable,
}

/// 4-plane (R/G/G/B) noise model for a RAW image.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseModel {
    pub planes: [NoiseCoefficients; 4],
    pub structured_sigma: [f32; 4],
    pub confidence: f32,
    pub source: NoiseSource,
}

/// Display-space noise metrics derived from the RAW noise model or blind estimation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseMetrics {
    /// 90th-percentile sigma in display-space (0–1 normalised).
    pub display_sigma_p90: f32,
    /// Sigma at 18% grey.
    pub sigma_18: f32,
    /// Sigma in the shadow region.
    pub sigma_shadow: f32,
    /// Signal-to-noise ratio at 18% grey, in dB.
    pub snr_18_db: f32,
    /// Estimation confidence \[0, 1\].
    pub confidence: f32,
    /// Where this estimate came from.
    pub source: NoiseSource,
}

/// User-facing denoise options.
///
/// # Defaults
/// enabled=false, Auto, iso_threshold=1600, noise_threshold=4.0, strength=1.0
///
/// # Clamping
/// - iso_threshold: 25..=409600
/// - noise_threshold: 0.5..=8.0
/// - strength: 0.0..=1.5
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DenoiseOptions {
    /// Master on/off switch. Default: false (opt-in).
    pub enabled: bool,
    /// Activation policy. Default: Auto.
    pub activation: ActivationMode,
    /// ISO threshold for Iso and Auto-fallback modes. Default: 1600.
    pub iso_threshold: u32,
    /// Noise threshold (display_sigma_p90) for Auto mode. Default: 4.0.
    pub noise_threshold: f32,
    /// Multiplier applied to the internal filter strength. Default: 1.0.
    pub strength: f32,
}

impl Default for DenoiseOptions {
    fn default() -> Self {
        Self {
            enabled: false,
            activation: ActivationMode::Auto,
            iso_threshold: 1600,
            noise_threshold: 4.0,
            strength: 1.0,
        }
    }
}

impl DenoiseOptions {
    /// Clamp all tunables into their valid ranges.
    pub fn clamped(mut self) -> Self {
        self.iso_threshold = self.iso_threshold.clamp(25, 409_600);
        self.noise_threshold = self.noise_threshold.clamp(0.5, 8.0);
        self.strength = self.strength.clamp(0.0, 1.5);
        self
    }
}

/// Why the policy reached its decision.
///
/// All variants are stable and serialisation-safe — do not reorder or remove.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenoiseReason {
    /// enabled=false.
    Disabled,
    /// activation=Always — applied unconditionally.
    AlwaysOn,
    /// activation=Iso but ISO is missing from metadata.
    IsoUnavailable,
    /// activation=Iso and ISO is below iso_threshold.
    BelowIsoThreshold,
    /// activation=Iso and ISO >= iso_threshold.
    IsoThreshold,
    /// activation=Auto, high-confidence noise measurement met the threshold.
    NoiseThreshold,
    /// activation=Auto, high-confidence noise measurement, below noise_threshold → skip.
    BelowNoiseThreshold,
    /// activation=Auto, low-confidence fallback: ISO >= iso_threshold.
    LowConfidenceFallbackIso,
    /// activation=Auto, low-confidence fallback: ISO < iso_threshold.
    LowConfidenceFallbackBelowIso,
    /// activation=Auto but neither reliable metrics nor ISO available.
    NoiseUnavailable,
    /// effective_strength ended up below 0.05 (prior RAW reduction already sufficient).
    StrengthZero,
}

/// Result of the denoise policy decision.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DenoiseDecision {
    /// Whether to apply denoising.
    pub apply: bool,
    /// Strength after accounting for prior noise reduction already applied.
    pub effective_strength: f32,
    /// Reason this decision was reached.
    pub reason: DenoiseReason,
    /// Noise source that drove the decision, if any.
    pub source: Option<NoiseSource>,
}
