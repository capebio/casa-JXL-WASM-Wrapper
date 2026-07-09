//! Machine profile: the persisted result of calibration + the process-global
//! overrides the runtime reads.
//!
//! A profile is keyed by a hardware signature and applied only when that signature
//! matches the current machine (so a golden-image profile cloned onto different vCPU
//! self-invalidates). Absent a profile every override is `None` → today's behaviour.
//! See design §4.5.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};

/// Bump when the on-disk shape changes; old profiles then fail `matches_current_hw`.
pub const SCHEMA_VERSION: u32 = 1;

// ---- Process-global overrides (read by shipped selectors) ---------------------
// Default 0 = "no override" everywhere, so a process that never calibrates is
// bit-identical to before this module existed.

static BACKEND_OVERRIDE: AtomicU16 = AtomicU16::new(0); // 0 = none, else backend_id + 1
static ENCODE_THREADS: AtomicUsize = AtomicUsize::new(0); // 0 = none
static DECODE_THREADS: AtomicUsize = AtomicUsize::new(0); // 0 = none

/// Set (or clear) the perceptual-backend override by `Backend` discriminant id.
pub fn set_backend_override(id: Option<u8>) {
    BACKEND_OVERRIDE.store(id.map(|i| i as u16 + 1).unwrap_or(0), Ordering::Relaxed);
}

/// The overriding backend id, if a profile selected one. Read by
/// `perceptual::resolve_backend`'s `Auto` arm.
pub fn backend_override_id() -> Option<u8> {
    match BACKEND_OVERRIDE.load(Ordering::Relaxed) {
        0 => None,
        v => Some((v - 1) as u8),
    }
}

/// Set (or clear) the recommended encode thread count.
pub fn set_encode_threads(n: Option<usize>) {
    ENCODE_THREADS.store(n.unwrap_or(0), Ordering::Relaxed);
}

/// The recommended encode thread count, if calibrated. Consumed by `casa_video`.
pub fn encode_threads() -> Option<usize> {
    match ENCODE_THREADS.load(Ordering::Relaxed) {
        0 => None,
        n => Some(n),
    }
}

/// Set (or clear) the recommended decode thread count.
pub fn set_decode_threads(n: Option<usize>) {
    DECODE_THREADS.store(n.unwrap_or(0), Ordering::Relaxed);
}

/// The recommended decode thread count, if calibrated.
pub fn decode_threads() -> Option<usize> {
    match DECODE_THREADS.load(Ordering::Relaxed) {
        0 => None,
        n => Some(n),
    }
}

/// Clear every override (test isolation + explicit "run uncalibrated").
pub fn clear_overrides() {
    set_backend_override(None);
    set_encode_threads(None);
    set_decode_threads(None);
}

// ---- Hardware signature -------------------------------------------------------

/// Identifies the hardware a profile was calibrated for. Two machines with the same
/// signature are treated as interchangeable; a mismatch invalidates the profile.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct HwSignature {
    pub arch: String,
    /// Sorted CPU feature flags relevant to backend selection.
    pub cpu_features: Vec<String>,
    /// cgroup-clamped effective core budget.
    pub core_budget: usize,
}

impl HwSignature {
    /// Detect the current machine's signature.
    pub fn detect() -> Self {
        HwSignature {
            arch: std::env::consts::ARCH.to_string(),
            cpu_features: detect_cpu_features(),
            core_budget: crate::calibration::prober::effective_core_budget(),
        }
    }

    /// A stable one-line key (for filenames / telemetry).
    pub fn key(&self) -> String {
        format!(
            "{}-cb{}-{}",
            self.arch,
            self.core_budget,
            self.cpu_features.join("+")
        )
    }
}

fn detect_cpu_features() -> Vec<String> {
    let mut f = Vec::new();
    #[cfg(target_arch = "x86_64")]
    {
        for (name, present) in [
            ("sse4.2", std::is_x86_feature_detected!("sse4.2")),
            ("avx", std::is_x86_feature_detected!("avx")),
            ("avx2", std::is_x86_feature_detected!("avx2")),
            ("fma", std::is_x86_feature_detected!("fma")),
            ("avx512f", std::is_x86_feature_detected!("avx512f")),
            ("avx512bw", std::is_x86_feature_detected!("avx512bw")),
        ] {
            if present {
                f.push(name.to_string());
            }
        }
    }
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        f.push("simd128".to_string());
    }
    f.sort();
    f
}

// ---- Profile ------------------------------------------------------------------

/// What calibration chose for this machine (throughput-only axes).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Selections {
    /// Perceptual SIMD backend `Backend` discriminant.
    pub perceptual_backend: Option<u8>,
    pub perceptual_backend_label: Option<String>,
    pub encode_threads: Option<usize>,
    pub decode_threads: Option<usize>,
}

/// The persisted calibration result.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MachineProfile {
    pub schema_version: u32,
    pub signature: HwSignature,
    /// Wall-clock stamp (ms since epoch), set by the orchestrator. 0 if unknown.
    pub generated_unix_ms: u64,
    pub selections: Selections,
    /// Free-form measurement detail (timings, CoV, confidence) for humans/telemetry.
    pub measurements: serde_json::Value,
    pub notes: Vec<String>,
}

impl MachineProfile {
    /// True when this profile was made for the current schema + hardware.
    pub fn matches_current_hw(&self) -> bool {
        self.schema_version == SCHEMA_VERSION && self.signature == HwSignature::detect()
    }

    /// Install this profile's selections as process-global overrides — but ONLY if it
    /// matches the current hardware. Returns whether it was applied.
    pub fn apply(&self) -> bool {
        if !self.matches_current_hw() {
            return false;
        }
        set_backend_override(self.selections.perceptual_backend);
        set_encode_threads(self.selections.encode_threads);
        set_decode_threads(self.selections.decode_threads);
        true
    }
}

// ---- Persistence (native only — wasm uses browser storage in the TS port) -----

#[cfg(not(target_arch = "wasm32"))]
pub use native_io::{default_path, load, save};

#[cfg(not(target_arch = "wasm32"))]
mod native_io {
    use super::{MachineProfile, SCHEMA_VERSION};
    use std::path::{Path, PathBuf};

    /// Where the profile lives. Overridable via `RAW_PIPELINE_CALIBRATION`; else an
    /// OS-appropriate config dir; else the working directory.
    pub fn default_path() -> PathBuf {
        if let Ok(p) = std::env::var("RAW_PIPELINE_CALIBRATION") {
            return PathBuf::from(p);
        }
        let dir = config_dir().unwrap_or_else(|| PathBuf::from("."));
        dir.join("raw-pipeline").join("machine-profile.json")
    }

    #[cfg(windows)]
    fn config_dir() -> Option<PathBuf> {
        std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("APPDATA"))
            .map(PathBuf::from)
    }

    #[cfg(not(windows))]
    fn config_dir() -> Option<PathBuf> {
        if let Some(x) = std::env::var_os("XDG_CONFIG_HOME") {
            return Some(PathBuf::from(x));
        }
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))
    }

    /// Persist a profile as pretty JSON, creating parent dirs.
    pub fn save(profile: &MachineProfile, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(profile)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(path, json)
    }

    /// Load a profile. Returns `None` when the file is missing, unparseable, or of a
    /// stale schema (never surfaces an error — a bad profile just means recalibrate).
    pub fn load(path: &Path) -> Option<MachineProfile> {
        let bytes = std::fs::read(path).ok()?;
        let profile: MachineProfile = serde_json::from_slice(&bytes).ok()?;
        if profile.schema_version != SCHEMA_VERSION {
            return None;
        }
        Some(profile)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_round_trip_and_clear() {
        clear_overrides();
        assert_eq!(backend_override_id(), None);
        set_backend_override(Some(3));
        assert_eq!(backend_override_id(), Some(3));
        set_backend_override(Some(0)); // Backend::Scalar id 0 must not read as "none"
        assert_eq!(backend_override_id(), Some(0));
        set_encode_threads(Some(8));
        assert_eq!(encode_threads(), Some(8));
        clear_overrides();
        assert_eq!(backend_override_id(), None);
        assert_eq!(encode_threads(), None);
        assert_eq!(decode_threads(), None);
    }

    #[test]
    fn signature_is_stable_and_matches_self() {
        let a = HwSignature::detect();
        let b = HwSignature::detect();
        assert_eq!(a, b);
        assert!(a.core_budget >= 1);
        assert!(!a.key().is_empty());
    }

    #[test]
    fn profile_json_round_trips() {
        let p = MachineProfile {
            schema_version: SCHEMA_VERSION,
            signature: HwSignature::detect(),
            generated_unix_ms: 0,
            selections: Selections {
                perceptual_backend: Some(1),
                perceptual_backend_label: Some("avx2-strict".into()),
                encode_threads: Some(6),
                decode_threads: Some(4),
            },
            measurements: serde_json::json!({"note": "unit"}),
            notes: vec!["hello".into()],
        };
        let s = serde_json::to_string(&p).unwrap();
        let back: MachineProfile = serde_json::from_str(&s).unwrap();
        assert_eq!(back.selections.perceptual_backend, Some(1));
        assert!(back.matches_current_hw());
    }

    #[test]
    fn stale_signature_does_not_apply() {
        clear_overrides();
        let mut p = MachineProfile {
            schema_version: SCHEMA_VERSION,
            signature: HwSignature {
                arch: "made-up-arch".into(),
                cpu_features: vec![],
                core_budget: 999,
            },
            generated_unix_ms: 0,
            selections: Selections {
                perceptual_backend: Some(3),
                ..Default::default()
            },
            measurements: serde_json::Value::Null,
            notes: vec![],
        };
        assert!(!p.apply(), "mismatched-hw profile must not apply");
        assert_eq!(backend_override_id(), None);
        // A matching signature applies.
        p.signature = HwSignature::detect();
        assert!(p.apply());
        assert_eq!(backend_override_id(), Some(3));
        clear_overrides();
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn save_load_round_trip() {
        let mut path = std::env::temp_dir();
        path.push(format!("rawpipe-cal-test-{}.json", HwSignature::detect().key()));
        let p = MachineProfile {
            schema_version: SCHEMA_VERSION,
            signature: HwSignature::detect(),
            generated_unix_ms: 0,
            selections: Selections::default(),
            measurements: serde_json::Value::Null,
            notes: vec![],
        };
        save(&p, &path).unwrap();
        let loaded = load(&path).expect("should load");
        assert_eq!(loaded.schema_version, SCHEMA_VERSION);
        let _ = std::fs::remove_file(&path);
    }
}
