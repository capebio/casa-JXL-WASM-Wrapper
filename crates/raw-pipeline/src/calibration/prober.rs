//! Accessibility + core-budget probing.
//!
//! Answers "which pathways are reachable on THIS machine + build, and why". The
//! effective core budget is cgroup-aware (the key server-correctness value: thread
//! pools must never exceed it). See design §4.2 / §8.

use crate::calibration::registry::{Axis, Pathway};

/// The number of CPUs the process may actually use — the effective concurrency
/// ceiling. `available_parallelism()` already honours OS affinity on modern
/// platforms, but Linux cgroup v2 CPU *bandwidth* limits (common in containers) are
/// NOT reflected in it, so we additionally clamp to the cgroup quota.
pub fn effective_core_budget() -> usize {
    let logical = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    #[cfg(target_os = "linux")]
    {
        if let Some(quota) = cgroup_cpu_quota() {
            return logical.min(quota).max(1);
        }
    }
    logical.max(1)
}

/// Parse a cgroup v2 `cpu.max` line ("<quota> <period>" or "max <period>") into a
/// whole-core count. Fractional quotas round UP (never under-provision). `None` when
/// unlimited or unparseable.
#[cfg(target_os = "linux")]
fn parse_cpu_max(s: &str) -> Option<usize> {
    let mut it = s.split_whitespace();
    let quota = it.next()?;
    let period: f64 = it.next()?.parse().ok()?;
    if quota == "max" || period <= 0.0 {
        return None;
    }
    let quota: f64 = quota.parse().ok()?;
    let cores = (quota / period).ceil() as usize;
    Some(cores.max(1))
}

/// Read cgroup v2 (`/sys/fs/cgroup/cpu.max`), falling back to v1
/// (`cpu.cfs_quota_us` / `cpu.cfs_period_us`). `None` when no limit is set.
#[cfg(target_os = "linux")]
fn cgroup_cpu_quota() -> Option<usize> {
    use std::fs::read_to_string;
    if let Ok(v2) = read_to_string("/sys/fs/cgroup/cpu.max") {
        return parse_cpu_max(v2.trim());
    }
    let quota: i64 = read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let period: i64 = read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
        .ok()?
        .trim()
        .parse()
        .ok()?;
    if quota <= 0 || period <= 0 {
        return None;
    }
    Some((((quota as f64) / (period as f64)).ceil() as usize).max(1))
}

/// Result of probing one pathway on THIS machine + build.
#[derive(Clone, Debug)]
pub struct Accessibility {
    pub id: &'static str,
    pub accessible: bool,
    /// Human-readable why (feature present/absent, core count, etc.).
    pub reason: String,
}

/// The perceptual SIMD variant the engine will auto-select right now, as the string
/// used in the registry's `variants` list.
pub fn active_perceptual_variant() -> &'static str {
    #[cfg(target_arch = "x86_64")]
    {
        use crate::perceptual::Backend;
        return match crate::perceptual::detect_native(false) {
            Backend::Scalar => "scalar",
            Backend::Avx2Strict => "avx2-strict",
            Backend::Avx2Rsqrt => "avx2-rsqrt",
            Backend::Avx512Strict => "avx512-strict",
            Backend::Avx512Rsqrt => "avx512-rsqrt",
            Backend::WasmSimd => "scalar", // unreachable on x86_64
        };
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        "scalar"
    }
}

/// True when this CPU can execute the named perceptual variant (x86 feature check).
fn perceptual_variant_accessible(variant: &str) -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        let avx2 = std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma");
        let avx512 = avx2
            && std::is_x86_feature_detected!("avx512f")
            && std::is_x86_feature_detected!("avx512bw");
        return match variant {
            "scalar" => true,
            "avx2-strict" | "avx2-rsqrt" | "avx2" | "avx2-fma" => avx2,
            "avx512-strict" | "avx512-rsqrt" => avx512,
            _ => false,
        };
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        variant == "scalar"
    }
}

/// Probe every pathway for accessibility on this machine + build. A SIMD-backend
/// pathway is accessible if AT LEAST its best variant is executable; a concurrency
/// pathway is accessible if the effective core budget exceeds one.
pub fn probe(pathways: &[Pathway]) -> Vec<Accessibility> {
    let cores = effective_core_budget();
    pathways
        .iter()
        .map(|p| match p.axis {
            Axis::SimdBackend => {
                let mut best: Option<&str> = None;
                let mut parts = Vec::new();
                for v in p.variants {
                    let ok = perceptual_variant_accessible(v);
                    if ok {
                        best = Some(v);
                    }
                    parts.push(format!("{v}={}", if ok { "ok" } else { "-" }));
                }
                Accessibility {
                    id: p.id,
                    accessible: best.is_some(),
                    reason: format!("best={} [{}]", best.unwrap_or("none"), parts.join(" ")),
                }
            }
            Axis::Concurrency => Accessibility {
                id: p.id,
                accessible: cores > 1,
                reason: format!("effective_core_budget={cores}"),
            },
            Axis::WasmTier => Accessibility {
                id: p.id,
                accessible: false,
                reason: "wasm tier probed in browser, not native".to_string(),
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calibration::registry::{native_registry, Axis};

    #[test]
    fn core_budget_is_at_least_one() {
        assert!(effective_core_budget() >= 1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parse_cgroup_v2_quota() {
        assert_eq!(parse_cpu_max("max 100000"), None);
        assert_eq!(parse_cpu_max("200000 100000"), Some(2));
        // Round up a fractional quota (1.5 cores → 2 so we never under-provision).
        assert_eq!(parse_cpu_max("150000 100000"), Some(2));
        assert_eq!(parse_cpu_max("50000 100000"), Some(1)); // never zero
        assert_eq!(parse_cpu_max("garbage"), None);
    }

    #[test]
    fn probe_reports_every_pathway() {
        let reg = native_registry();
        let report = probe(&reg);
        assert_eq!(report.len(), reg.len());
        for r in &report {
            assert!(!r.reason.is_empty(), "{} has no reason", r.id);
        }
    }

    #[test]
    fn active_perceptual_backend_is_a_listed_variant() {
        // CI reachability guard: the backend the engine will actually pick MUST be one
        // of the variants the registry advertises. Catches a backend accidentally
        // cfg'd out of the build.
        let reg = native_registry();
        let p = reg
            .iter()
            .find(|p| p.id == "native.backend.perceptual")
            .expect("perceptual pathway missing");
        let active = active_perceptual_variant();
        assert!(
            p.variants.contains(&active),
            "active backend {active:?} not in advertised variants {:?}",
            p.variants
        );
    }

    #[test]
    fn concurrency_pathways_are_accessible_when_multicore() {
        if effective_core_budget() > 1 {
            let reg = native_registry();
            let report = probe(&reg);
            for r in report
                .iter()
                .filter(|r| reg.iter().any(|p| p.id == r.id && p.axis == Axis::Concurrency))
            {
                assert!(r.accessible, "{} should be accessible on multicore", r.id);
            }
        }
    }
}
