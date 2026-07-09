//! One-shot calibration orchestration (native).
//!
//! `run_calibration` executes the harness and returns a profile; `ensure_calibrated`
//! is the "run once on first use" entry — load-and-apply if a valid profile exists,
//! else calibrate (under a lockfile so concurrent processes don't both run), save,
//! and apply. See design §4.7.

use crate::calibration::bench::{
    bench_thread_scaling, pick_backend, pick_thread_count, BenchConfig,
};
use crate::calibration::profile::{self, HwSignature, MachineProfile, Selections, SCHEMA_VERSION};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Result of `ensure_calibrated`.
#[derive(Debug)]
pub struct CalibrationOutcome {
    pub profile: MachineProfile,
    /// Whether the profile's selections were installed as process-global overrides.
    pub applied: bool,
    /// Whether this call performed a fresh calibration (vs loading an existing one).
    pub freshly_calibrated: bool,
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Execute the full calibration and build a profile for this machine. Broadcasts each
/// contest through `emit`; the returned profile's `measurements` mirror those lines,
/// so what the user saw is exactly what is persisted.
pub fn run_calibration(cfg: &BenchConfig, emit: &mut dyn FnMut(&str)) -> MachineProfile {
    let sig = HwSignature::detect();
    emit(&format!("== calibrating {} ==", sig.key()));

    emit("-- perceptual SIMD backend --");
    let (backend_id, backend_label, backend_timings) = pick_backend(cfg, emit);

    emit("-- thread scaling --");
    let thread_timings = bench_thread_scaling(cfg, emit);
    let threads = pick_thread_count(&thread_timings);
    if let Some(t) = threads {
        emit(&format!("-> chosen thread count: {t}"));
    } else {
        emit("-> thread count: runtime default (no scaling data)");
    }

    let measurements = serde_json::json!({
        "backends": backend_timings.iter().map(|t| serde_json::json!({
            "variant": t.variant,
            "backend_id": t.backend_id,
            "median_ns": t.sample.median_ns,
            "cov": t.sample.cov,
            "confident": t.sample.confident,
            "parity_ok": t.parity_ok,
        })).collect::<Vec<_>>(),
        "threads": thread_timings.iter().map(|t| serde_json::json!({
            "threads": t.threads,
            "median_ns": t.median_ns,
            "throughput_tiles_per_s": t.throughput,
            "cov": t.cov,
        })).collect::<Vec<_>>(),
    });

    let mut notes = Vec::new();
    notes.push("throughput-only calibration; quality knobs untouched".to_string());
    if backend_id.is_none() {
        notes.push("no parity-passing SIMD backend selected; runtime default kept".to_string());
    }

    let profile = MachineProfile {
        schema_version: SCHEMA_VERSION,
        signature: sig,
        generated_unix_ms: now_unix_ms(),
        selections: Selections {
            perceptual_backend: backend_id,
            perceptual_backend_label: backend_label,
            encode_threads: threads,
            decode_threads: threads,
        },
        measurements,
        notes,
    };
    emit(&format!(
        "== done: backend={:?} threads={:?} ==",
        profile.selections.perceptual_backend_label, profile.selections.encode_threads
    ));
    profile
}

/// Best-effort exclusive lock via a sidecar `.lock` file, removed on drop. If the lock
/// is already held we proceed unlocked (worst case: a redundant calibration, never a
/// corrupt profile — `save` writes atomically enough for our needs).
struct CalibLock {
    path: std::path::PathBuf,
    held: bool,
}

impl CalibLock {
    fn acquire(profile_path: &Path) -> Self {
        let path = profile_path.with_extension("lock");
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let held = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .is_ok();
        CalibLock { path, held }
    }
}

impl Drop for CalibLock {
    fn drop(&mut self) {
        if self.held {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// The "run once on first use" entry. If a profile at `path` matches this hardware,
/// apply and return it. Otherwise calibrate (under a lock), save, apply, return.
pub fn ensure_calibrated(path: &Path, emit: &mut dyn FnMut(&str)) -> CalibrationOutcome {
    if let Some(p) = profile::load(path) {
        if p.apply() {
            emit(&format!("loaded machine profile: {}", path.display()));
            return CalibrationOutcome {
                profile: p,
                applied: true,
                freshly_calibrated: false,
            };
        }
        emit("existing profile did not match this hardware; recalibrating");
    }

    let lock = CalibLock::acquire(path);
    // Re-check under the lock: another process may have just written a matching one.
    if lock.held {
        if let Some(p) = profile::load(path) {
            if p.apply() {
                emit("another process calibrated; loaded its profile");
                return CalibrationOutcome {
                    profile: p,
                    applied: true,
                    freshly_calibrated: false,
                };
            }
        }
    }

    let profile = run_calibration(&BenchConfig::default(), emit);
    match profile::save(&profile, path) {
        Ok(()) => emit(&format!("saved machine profile: {}", path.display())),
        Err(e) => emit(&format!("WARN could not save profile: {e}")),
    }
    let applied = profile.apply();
    CalibrationOutcome {
        profile,
        applied,
        freshly_calibrated: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_calibration_produces_applicable_profile() {
        profile::clear_overrides();
        let mut lines = Vec::new();
        let p = run_calibration(&BenchConfig::quick(), &mut |s| lines.push(s.to_string()));
        assert_eq!(p.schema_version, SCHEMA_VERSION);
        assert!(p.matches_current_hw());
        assert!(!lines.is_empty(), "calibration should broadcast");
        // Measurements mirror the broadcast: backends array is non-empty.
        assert!(!p.measurements["backends"].as_array().unwrap().is_empty());
        assert!(p.apply());
        profile::clear_overrides();
    }

    #[test]
    fn ensure_calibrated_writes_then_loads() {
        profile::clear_overrides();
        let mut path = std::env::temp_dir();
        path.push(format!(
            "rawpipe-cal-orch-{}-{}.json",
            HwSignature::detect().core_budget,
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);

        // Produce + save a profile via the quick path (default cfg would be slow).
        let p = run_calibration(&BenchConfig::quick(), &mut |_| {});
        profile::save(&p, &path).unwrap();

        // ensure_calibrated must load the existing profile, not recalibrate.
        let outcome = ensure_calibrated(&path, &mut |_| {});
        assert!(outcome.applied);
        assert!(!outcome.freshly_calibrated, "should have loaded, not recalibrated");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("lock"));
        profile::clear_overrides();
    }
}
