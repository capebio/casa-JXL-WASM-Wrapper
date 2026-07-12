//! Sensor noise calibration CLI.
//!
//! Fits a per-plane Poisson + Gaussian noise model from dark frames and flat
//! pairs, then appends the result to a camera noise profile JSON database.
//!
//! Usage:
//!   raw_noise_calibrate --manifest <manifest.json> --output <profiles.json>
//!                       --camera-key "make/model"
//!
//! Exit codes:
//!   0   Success.
//!   1   Insufficient data (< MIN_DARK_FRAMES, < MIN_FLAT_PAIRS,
//!       or < MIN_SIGNAL_LEVELS unsaturated levels for any ISO).
//!   2   Manifest parse error or I/O error.
//!   3   Profile database write error.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process;

use raw_pipeline::denoise::calibrate::{calibrate, RawFrame, MIN_DARK_FRAMES, MIN_FLAT_PAIRS, MIN_SIGNAL_LEVELS, CalibrationError};
use raw_pipeline::denoise::profiles::{
    CameraKey, PlaneCoeffs, ProfileDatabase, ProfileEntry,
};

// ─── Manifest types ───────────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
struct Manifest {
    /// SHA-256 of this manifest file (populated by the caller, e.g. via sha256sum).
    sha256: String,
    /// Calibration ISO batches.
    isos: Vec<IsoBatch>,
    /// Black level in sensor counts.
    black: f64,
    /// Saturation level in sensor counts.
    saturation: f64,
    /// Gain segment label (e.g. "low", "high").
    gain_segment: String,
}

#[derive(Debug, serde::Deserialize)]
struct IsoBatch {
    iso: u32,
    /// Paths to dark frames (TIFF or raw binary, 16-bit, row-major).
    dark_frames: Vec<PathBuf>,
    /// Pairs of flat frame paths.
    flat_pairs: Vec<[PathBuf; 2]>,
    /// Image width in pixels.
    width: usize,
    /// CFA phase (0=RGGB, 1=GRBG, 2=GBRG, 3=BGGR).
    cfa_phase: usize,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn load_raw16(path: &PathBuf, width: usize, cfa_phase: usize) -> Result<RawFrame, String> {
    let bytes = std::fs::read(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    if bytes.len() % 2 != 0 {
        return Err(format!("{}: odd byte count", path.display()));
    }
    let pixels: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    Ok(RawFrame::from_bayer(&pixels, width, cfa_phase))
}

fn parse_args() -> Result<(PathBuf, PathBuf, CameraKey), String> {
    let args: Vec<String> = std::env::args().collect();
    let mut manifest: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut camera_key: Option<CameraKey> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--manifest" => {
                i += 1;
                manifest = Some(PathBuf::from(args.get(i).ok_or("--manifest needs a value")?));
            }
            "--output" => {
                i += 1;
                output = Some(PathBuf::from(args.get(i).ok_or("--output needs a value")?));
            }
            "--camera-key" => {
                i += 1;
                let raw = args.get(i).ok_or("--camera-key needs a value")?;
                let parts: Vec<&str> = raw.splitn(2, '/').collect();
                if parts.len() != 2 {
                    return Err(format!(
                        "--camera-key must be \"make/model\", got {:?}",
                        raw
                    ));
                }
                camera_key = Some(CameraKey::new(parts[0].trim(), parts[1].trim()));
            }
            other => return Err(format!("unknown argument: {other}")),
        }
        i += 1;
    }

    Ok((
        manifest.ok_or("--manifest is required")?,
        output.ok_or("--output is required")?,
        camera_key.ok_or("--camera-key is required")?,
    ))
}

fn main() {
    let (manifest_path, output_path, key) = match parse_args() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("error: {e}");
            eprintln!("usage: raw_noise_calibrate --manifest <path> --output <path> --camera-key \"make/model\"");
            process::exit(2);
        }
    };

    // Load manifest
    let manifest_json = match std::fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error reading manifest {}: {e}", manifest_path.display());
            process::exit(2);
        }
    };
    let manifest: Manifest = match serde_json::from_str(&manifest_json) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("error parsing manifest: {e}");
            process::exit(2);
        }
    };

    // Load or create output database
    let mut db: ProfileDatabase = if output_path.exists() {
        match std::fs::read_to_string(&output_path)
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        {
            Ok(d) => d,
            Err(e) => {
                eprintln!("error reading output database {}: {e}", output_path.display());
                process::exit(3);
            }
        }
    } else {
        ProfileDatabase {
            schema_version: 1,
            profiles: Vec::new(),
        }
    };

    // Process each ISO batch
    let mut any_error = false;
    for batch in &manifest.isos {
        let iso = batch.iso;

        // Load frames
        let dark_frames: Vec<RawFrame> = match batch
            .dark_frames
            .iter()
            .map(|p| load_raw16(p, batch.width, batch.cfa_phase))
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(v) => v,
            Err(e) => {
                eprintln!("ISO {iso}: {e}");
                process::exit(2);
            }
        };

        let flat_pairs: Vec<(RawFrame, RawFrame)> = match batch
            .flat_pairs
            .iter()
            .map(|[pa, pb]| {
                let a = load_raw16(pa, batch.width, batch.cfa_phase)?;
                let b = load_raw16(pb, batch.width, batch.cfa_phase)?;
                Ok::<_, String>((a, b))
            })
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(v) => v,
            Err(e) => {
                eprintln!("ISO {iso}: {e}");
                process::exit(2);
            }
        };

        match calibrate(&dark_frames, &flat_pairs, manifest.black, manifest.saturation) {
            Ok(result) => {
                let planes: [PlaneCoeffs; 4] = std::array::from_fn(|i| PlaneCoeffs {
                    shot: result.planes[i].coeffs.shot as f32,
                    read: result.planes[i].coeffs.read as f32,
                });
                let structured_sigma = [0.0f32; 4]; // spatial noise not estimated here
                let fit_residual = result
                    .planes
                    .iter()
                    .map(|p| p.fit_residual)
                    .sum::<f64>() as f32
                    / 4.0;
                db.profiles.push(ProfileEntry {
                    make: key.make.clone(),
                    model: key.model.clone(),
                    gain_segment: manifest.gain_segment.clone(),
                    iso,
                    planes,
                    structured_sigma,
                    source_manifest_sha256: manifest.sha256.clone(),
                    fit_residual,
                });
                println!("ISO {iso}: fit complete (residual={:.4})", fit_residual);
            }
            Err(CalibrationError::InsufficientData {
                dark_frames: nd,
                flat_pairs: np,
                signal_levels: ns,
            }) => {
                eprintln!(
                    "ISO {iso}: insufficient data: {nd} dark frames \
                     (need {MIN_DARK_FRAMES}), {np} flat pairs (need {MIN_FLAT_PAIRS}), \
                     {ns} signal levels (need {MIN_SIGNAL_LEVELS})"
                );
                any_error = true;
            }
            Err(CalibrationError::FitFailed(msg)) => {
                eprintln!("ISO {iso}: fit failed: {msg}");
                any_error = true;
            }
        }
    }

    // Write database
    let json = match serde_json::to_string_pretty(&db) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error serialising database: {e}");
            process::exit(3);
        }
    };
    if let Err(e) = std::fs::write(&output_path, json) {
        eprintln!("error writing {}: {e}", output_path.display());
        process::exit(3);
    }

    if any_error {
        process::exit(1);
    }
}
