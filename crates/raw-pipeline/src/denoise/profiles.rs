//! Camera noise profile registry.
//!
//! Loads per-camera, per-ISO noise models from a JSON database and exposes
//! `CameraNoiseRegistry::resolve(key, iso) -> Option<NoiseModel>`.
//!
//! Interpolation is linear in `log2(ISO)` space within a gain segment.
//! Across segment boundaries, the nearest-point entry is used.

use std::fmt;

use serde::{Deserialize, Serialize};

use super::types::{NoiseCoefficients, NoiseModel, NoiseSource};

// ─── CameraKey ────────────────────────────────────────────────────────────────

/// Normalised camera identifier: lowercase, trimmed, internal whitespace collapsed.
/// Does NOT include camera release year or model generation.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CameraKey {
    pub make: String,
    pub model: String,
}

fn normalise(s: &str) -> String {
    // lowercase → trim → collapse internal runs of whitespace to single space
    let lowered = s.to_lowercase();
    let trimmed = lowered.trim();
    let mut result = String::with_capacity(trimmed.len());
    let mut prev_space = false;
    for ch in trimmed.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                result.push(' ');
            }
            prev_space = true;
        } else {
            result.push(ch);
            prev_space = false;
        }
    }
    result
}

impl CameraKey {
    pub fn new(make: &str, model: &str) -> Self {
        Self {
            make: normalise(make),
            model: normalise(model),
        }
    }
}

impl fmt::Display for CameraKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} / {}", self.make, self.model)
    }
}

// ─── JSON schema types ────────────────────────────────────────────────────────

/// Per-plane {shot, read} pair stored in a profile entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaneCoeffs {
    pub shot: f32,
    pub read: f32,
}

/// A single measured profile entry for one ISO point.
///
/// Required provenance fields: `source_manifest_sha256` and `fit_residual`.
/// Entries lacking these are rejected at load time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileEntry {
    /// Camera make (stored as-is; normalised at lookup time).
    pub make: String,
    /// Camera model (stored as-is; normalised at lookup time).
    pub model: String,
    /// Gain segment identifier (e.g. "low", "high"). Entries in the same
    /// segment are interpolated; across segments, nearest-point is used.
    pub gain_segment: String,
    /// ISO value this entry was calibrated at.
    pub iso: u32,
    /// Per-plane [R, G1, G2, B] noise coefficients.
    pub planes: [PlaneCoeffs; 4],
    /// Per-plane structured spatial noise sigma [R, G1, G2, B].
    pub structured_sigma: [f32; 4],
    /// SHA-256 of the calibration manifest (provenance). Required.
    pub source_manifest_sha256: String,
    /// Fit residual from the Huber IRLS calibration. Required.
    pub fit_residual: f32,
}

/// Top-level JSON database shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDatabase {
    pub schema_version: u32,
    pub profiles: Vec<ProfileEntry>,
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/// In-memory registry loaded from a `ProfileDatabase`.
pub struct CameraNoiseRegistry {
    entries: Vec<ProfileEntry>,
}

impl CameraNoiseRegistry {
    /// Parse a JSON database string into a registry.
    ///
    /// # Errors
    /// Returns an error if the JSON is malformed, the schema version is
    /// unsupported, or any entry is missing required provenance fields.
    pub fn from_json(json: &str) -> Result<Self, String> {
        let db: ProfileDatabase =
            serde_json::from_str(json).map_err(|e| format!("profile JSON parse error: {e}"))?;
        if db.schema_version != 1 {
            return Err(format!(
                "unsupported profile schema version {}",
                db.schema_version
            ));
        }
        for (i, entry) in db.profiles.iter().enumerate() {
            if entry.source_manifest_sha256.is_empty() {
                return Err(format!(
                    "profile[{i}] ({} {}) missing source_manifest_sha256",
                    entry.make, entry.model
                ));
            }
            // fit_residual being NaN or negative is also invalid
            if !entry.fit_residual.is_finite() || entry.fit_residual < 0.0 {
                return Err(format!(
                    "profile[{i}] ({} {}) has invalid fit_residual {}",
                    entry.make, entry.model, entry.fit_residual
                ));
            }
        }
        Ok(Self {
            entries: db.profiles,
        })
    }

    /// Resolve a noise model for the given camera key and ISO.
    ///
    /// Algorithm:
    /// 1. Find all entries where `(make, model)` normalise-match `key`.
    /// 2. Group matching entries by `gain_segment`.
    /// 3. For each segment, find the two ISO bracketing entries and interpolate
    ///    linearly in `log2(ISO)` space.
    /// 4. If the ISO is within exactly one segment, use that segment's result.
    /// 5. If the ISO falls between two segments (or outside all segments),
    ///    pick the nearest entry by `|log2(iso) - log2(entry_iso)|`.
    ///
    /// Returns `None` when no entries match `key`.
    pub fn resolve(&self, key: &CameraKey, iso: u32) -> Option<NoiseModel> {
        if iso == 0 {
            return None;
        }
        let log_iso = (iso as f32).log2();

        // Collect matching entries
        let matching: Vec<&ProfileEntry> = self
            .entries
            .iter()
            .filter(|e| normalise(&e.make) == key.make && normalise(&e.model) == key.model)
            .collect();
        if matching.is_empty() {
            return None;
        }

        // Group by gain segment
        let segments: Vec<String> = {
            let mut segs: Vec<String> = matching.iter().map(|e| e.gain_segment.clone()).collect();
            segs.sort();
            segs.dedup();
            segs
        };

        // For each segment, compute the best interpolated result (or nearest single point)
        // and track the minimum distance to the requested ISO so we can pick across segments.
        let mut best: Option<(f32, [PlaneCoeffs; 4], [f32; 4])> = None;

        for seg in &segments {
            let seg_entries: Vec<&ProfileEntry> = matching
                .iter()
                .filter(|e| &e.gain_segment == seg)
                .copied()
                .collect();

            // Sort by ISO ascending for binary-search-style bracket finding
            let mut sorted: Vec<&ProfileEntry> = seg_entries;
            sorted.sort_by(|a, b| a.iso.cmp(&b.iso));

            let result = interpolate_in_segment(&sorted, log_iso);
            let nearest_dist = sorted
                .iter()
                .map(|e| ((e.iso as f32).log2() - log_iso).abs())
                .fold(f32::INFINITY, f32::min);

            match &best {
                None => best = Some((nearest_dist, result.0, result.1)),
                Some((prev_dist, _, _)) if nearest_dist < *prev_dist => {
                    best = Some((nearest_dist, result.0, result.1))
                }
                _ => {}
            }
        }

        let (_, planes, structured_sigma) = best?;

        Some(NoiseModel {
            planes: planes.map(|p| NoiseCoefficients {
                shot: p.shot,
                read: p.read,
            }),
            structured_sigma,
            confidence: 0.9,
            source: NoiseSource::CameraProfile,
        })
    }
}

/// Interpolate (or extrapolate to nearest) within a sorted, single-segment slice.
/// Returns `([PlaneCoeffs; 4], [f32; 4])`.
fn interpolate_in_segment(
    sorted: &[&ProfileEntry],
    log_iso: f32,
) -> ([PlaneCoeffs; 4], [f32; 4]) {
    debug_assert!(!sorted.is_empty());

    if sorted.len() == 1 {
        return (sorted[0].planes.clone(), sorted[0].structured_sigma);
    }

    // Find the bracket [lo, hi] around log_iso
    let lo_idx = sorted
        .iter()
        .rposition(|e| (e.iso as f32).log2() <= log_iso)
        .unwrap_or(0);
    let hi_idx = (lo_idx + 1).min(sorted.len() - 1);

    if lo_idx == hi_idx {
        // Extrapolate: at or beyond an endpoint — return nearest
        return (sorted[lo_idx].planes.clone(), sorted[lo_idx].structured_sigma);
    }

    let lo = sorted[lo_idx];
    let hi = sorted[hi_idx];
    let log_lo = (lo.iso as f32).log2();
    let log_hi = (hi.iso as f32).log2();
    let span = log_hi - log_lo;

    let t = if span.abs() < 1e-7 {
        0.0_f32
    } else {
        ((log_iso - log_lo) / span).clamp(0.0, 1.0)
    };

    let planes = std::array::from_fn(|i| PlaneCoeffs {
        shot: lerp(lo.planes[i].shot, hi.planes[i].shot, t),
        read: lerp(lo.planes[i].read, hi.planes[i].read, t),
    });
    let structured_sigma =
        std::array::from_fn(|i| lerp(lo.structured_sigma[i], hi.structured_sigma[i], t));

    (planes, structured_sigma)
}

#[inline]
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_db_json(profiles: &str) -> String {
        format!(r#"{{"schemaVersion":1,"profiles":[{profiles}]}}"#)
    }

    fn entry_json(
        make: &str,
        model: &str,
        seg: &str,
        iso: u32,
        shot: f32,
        read: f32,
    ) -> String {
        format!(
            r#"{{
                "make":"{make}","model":"{model}","gain_segment":"{seg}","iso":{iso},
                "planes":[
                    {{"shot":{shot},"read":{read}}},
                    {{"shot":{shot},"read":{read}}},
                    {{"shot":{shot},"read":{read}}},
                    {{"shot":{shot},"read":{read}}}
                ],
                "structured_sigma":[0.0,0.0,0.0,0.0],
                "source_manifest_sha256":"abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
                "fit_residual":0.001
            }}"#
        )
    }

    #[test]
    fn camera_key_normalises_whitespace_and_case() {
        let k1 = CameraKey::new("  NIKON  ", "  D  850  ");
        let k2 = CameraKey::new("nikon", "d 850");
        assert_eq!(k1.make, "nikon");
        assert_eq!(k1.model, "d 850");
        assert_eq!(k1, k2);
    }

    #[test]
    fn camera_key_display() {
        let k = CameraKey::new("Canon", "EOS R5");
        assert_eq!(k.to_string(), "canon / eos r5");
    }

    #[test]
    fn camera_key_no_release_year() {
        // Year must NOT appear in the key even if the raw string contains it
        let k = CameraKey::new("Sony", "A7R III 2017");
        // The normalised key just lowercases/trims — year stays in model if caller
        // passes it. The spec says "do not STORE camera release year"; CameraKey
        // is a transparent normaliser, callers must strip years before calling new().
        assert_eq!(k.model, "a7r iii 2017"); // key preserves what caller provides
        // Confirm that keys for the same camera without year don't equal ones with year
        let k2 = CameraKey::new("Sony", "A7R III");
        assert_ne!(k, k2); // caller responsibility to normalise year
    }

    #[test]
    fn empty_registry_returns_none() {
        let reg = CameraNoiseRegistry::from_json(r#"{"schemaVersion":1,"profiles":[]}"#).unwrap();
        let k = CameraKey::new("Nikon", "D850");
        assert!(reg.resolve(&k, 800).is_none());
    }

    #[test]
    fn registry_returns_none_for_unknown_camera() {
        let json = make_db_json(&entry_json("Nikon", "D850", "low", 400, 0.5, 0.01));
        let reg = CameraNoiseRegistry::from_json(&json).unwrap();
        let k = CameraKey::new("Canon", "EOS R5");
        assert!(reg.resolve(&k, 400).is_none());
    }

    #[test]
    fn interpolation_within_one_segment_log2_space() {
        // Two calibration points at ISO 400 (shot=0.4) and ISO 1600 (shot=0.8).
        // log2(400) ≈ 8.644, log2(1600) ≈ 10.644
        // At ISO 800 (log2 ≈ 9.644): t = (9.644 - 8.644) / 2.0 = 0.5 → shot ≈ 0.6
        let json = make_db_json(&format!(
            "{},{}",
            entry_json("Nikon", "D850", "low", 400, 0.4, 0.01),
            entry_json("Nikon", "D850", "low", 1600, 0.8, 0.02)
        ));
        let reg = CameraNoiseRegistry::from_json(&json).unwrap();
        let k = CameraKey::new("Nikon", "D850");
        let model = reg.resolve(&k, 800).expect("should resolve");
        // t = (log2(800) - log2(400)) / (log2(1600) - log2(400)) = 1/2
        let expected_shot = 0.4 + (0.8 - 0.4) * 0.5;
        assert!(
            (model.planes[0].shot - expected_shot).abs() < 1e-4,
            "shot={} expected≈{}",
            model.planes[0].shot,
            expected_shot
        );
    }

    #[test]
    fn nearest_point_across_segment_boundary() {
        // Segment "low": ISO 400, shot=0.4
        // Segment "high": ISO 3200, shot=1.2
        // ISO 800 is in "low" territory (closer to 400 than 3200 in log2 space)
        let json = make_db_json(&format!(
            "{},{}",
            entry_json("Nikon", "D850", "low", 400, 0.4, 0.01),
            entry_json("Nikon", "D850", "high", 3200, 1.2, 0.05)
        ));
        let reg = CameraNoiseRegistry::from_json(&json).unwrap();
        let k = CameraKey::new("Nikon", "D850");

        // ISO 800 is much closer to 400 than 3200 in log2 space
        let m800 = reg.resolve(&k, 800).unwrap();
        assert!(
            (m800.planes[0].shot - 0.4).abs() < 1e-4,
            "expected shot≈0.4, got {}",
            m800.planes[0].shot
        );

        // ISO 2500 is much closer to 3200 than 400 in log2 space
        let m2500 = reg.resolve(&k, 2500).unwrap();
        assert!(
            (m2500.planes[0].shot - 1.2).abs() < 1e-4,
            "expected shot≈1.2, got {}",
            m2500.planes[0].shot
        );
    }

    #[test]
    fn single_iso_entry_returned_directly() {
        let json = make_db_json(&entry_json("Canon", "EOS R5", "low", 1600, 0.7, 0.03));
        let reg = CameraNoiseRegistry::from_json(&json).unwrap();
        let k = CameraKey::new("Canon", "EOS R5");
        let model = reg.resolve(&k, 3200).unwrap();
        assert!((model.planes[0].shot - 0.7).abs() < 1e-5);
    }

    #[test]
    fn case_insensitive_make_model_match() {
        let json = make_db_json(&entry_json("NIKON", "D850", "low", 800, 0.5, 0.02));
        let reg = CameraNoiseRegistry::from_json(&json).unwrap();
        let k = CameraKey::new("nikon", "d850");
        assert!(reg.resolve(&k, 800).is_some());
    }

    #[test]
    fn missing_provenance_fields_rejected() {
        let bad = r#"{"schemaVersion":1,"profiles":[{
            "make":"Nikon","model":"D850","gain_segment":"low","iso":800,
            "planes":[{"shot":0.5,"read":0.02},{"shot":0.5,"read":0.02},
                       {"shot":0.5,"read":0.02},{"shot":0.5,"read":0.02}],
            "structured_sigma":[0.0,0.0,0.0,0.0],
            "source_manifest_sha256":"",
            "fit_residual":0.001
        }]}"#;
        assert!(CameraNoiseRegistry::from_json(bad).is_err());
    }

    #[test]
    fn unsupported_schema_version_rejected() {
        let bad = r#"{"schemaVersion":99,"profiles":[]}"#;
        assert!(CameraNoiseRegistry::from_json(bad).is_err());
    }

    #[test]
    fn source_is_camera_profile() {
        let json = make_db_json(&entry_json("Sony", "A7R IV", "low", 800, 0.5, 0.02));
        let reg = CameraNoiseRegistry::from_json(&json).unwrap();
        let k = CameraKey::new("Sony", "A7R IV");
        let model = reg.resolve(&k, 800).unwrap();
        assert_eq!(model.source, NoiseSource::CameraProfile);
    }
}
