//! One-time hardware calibration entry.
//!
//! Runs the harness (targets the 1–3 min budget), writes the machine profile, and
//! broadcasts every contest plus the final explicit choices. Headless / server-safe.
//!
//! Run (with thread scaling):
//!   cargo run -p raw-pipeline --example calibrate --no-default-features --features parallel --release
//! Optional first arg = profile path; else `RAW_PIPELINE_CALIBRATION` / OS config dir.
//!
//! Idempotent: if a matching profile already exists it is loaded, not recomputed.
//! To force a fresh run, delete the profile file (or pass `--fresh`).

use raw_pipeline::calibration::bench::BenchConfig;
use raw_pipeline::calibration::orchestrator::{ensure_calibrated, run_calibration};
use raw_pipeline::calibration::profile::{self, default_path};
use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    let mut fresh = false;
    let mut path: Option<PathBuf> = None;
    for a in args.by_ref() {
        match a.as_str() {
            "--fresh" => fresh = true,
            other => path = Some(PathBuf::from(other)),
        }
    }
    let path = path.unwrap_or_else(default_path);
    println!("== raw-pipeline hardware calibration ==");
    println!("profile path: {}", path.display());
    println!();

    let mut emit = |line: &str| println!("  {line}");
    let profile = if fresh {
        let p = run_calibration(&BenchConfig::default(), &mut emit);
        match profile::save(&p, &path) {
            Ok(()) => println!("  saved: {}", path.display()),
            Err(e) => println!("  WARN save failed: {e}"),
        }
        p.apply();
        p
    } else {
        ensure_calibrated(&path, &mut emit).profile
    };

    println!();
    println!("== persisted profile ==");
    match serde_json::to_string_pretty(&profile) {
        Ok(json) => println!("{json}"),
        Err(e) => println!("(could not serialize: {e})"),
    }
}
