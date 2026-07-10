//! DNG sensor-noise metadata parser.
//!
//! Reads these DNG tags from a pre-parsed IFD walk and produces
//! `RawNoiseMetadata`, a per-CFA-plane (RGGB order) summary ready for
//! the noise-aware denoise pipeline.
//!
//! Tag overview
//! ─────────────────────────────────────────────────────────────────
//! 0xC616  CFAPlaneColor        — maps CFA plane index → colour (R/G/B)
//! 0xC619  BlackLevelRepeatDim  — repeat pattern dimensions for BlackLevel
//! 0xC61A  BlackLevel           — per-pixel black levels in CFA repeat order
//! 0xC61B  BlackLevelDeltaH     — per-column black delta (SRATIONAL array)
//! 0xC61C  BlackLevelDeltaV     — per-row black delta (SRATIONAL array)
//! 0xC61D  WhiteLevel           — sensor white level (already parsed elsewhere)
//! 0xC62B  BaselineNoise        — RATIONAL: relative noise vs baseline ISO
//! 0xC6F7  NoiseReductionApplied — RATIONAL: fraction of NR already applied
//! 0xC761  NoiseProfile         — DOUBLE: 2N shot+read coefficients for N planes

use super::types::{NoiseCoefficients, NoiseModel, NoiseSource};

// ─── Tag constants ────────────────────────────────────────────────────────────

pub const TAG_CFA_PLANE_COLOR: u16 = 0xC616;
pub const TAG_BLACK_LEVEL_REPEAT_DIM: u16 = 0xC619;
pub const TAG_BLACK_LEVEL: u16 = 0xC61A;
pub const TAG_BLACK_LEVEL_DELTA_H: u16 = 0xC61B;
pub const TAG_BLACK_LEVEL_DELTA_V: u16 = 0xC61C;
pub const TAG_WHITE_LEVEL: u16 = 0xC61D;
pub const TAG_BASELINE_NOISE: u16 = 0xC62B;
pub const TAG_NOISE_REDUCTION_APPLIED: u16 = 0xC6F7;
pub const TAG_NOISE_PROFILE: u16 = 0xC761;

// ─── Output type ──────────────────────────────────────────────────────────────

/// Per-CFA-plane (RGGB order: [R, G1, G2, B]) noise metadata extracted from DNG tags.
#[derive(Debug, Clone)]
pub struct RawNoiseMetadata {
    /// Black level per CFA plane in sensor counts.
    /// Derived from BlackLevel tag (0xC61A); falls back to the scalar black level
    /// already parsed elsewhere, replicated across all 4 planes.
    pub black: [f32; 4],

    /// White level per CFA plane in sensor counts.
    /// Currently replicated from the scalar WhiteLevel tag across all planes.
    pub white: [f32; 4],

    /// Embedded per-plane Poisson + Gaussian noise model (from NoiseProfile 0xC761),
    /// mapped to RGGB CFA plane order via CFAPlaneColor.
    pub embedded_noise: Option<NoiseModel>,

    /// BaselineNoise (0xC62B): relative noise of this image vs baseline ISO.
    /// A RATIONAL value; `None` when the tag is absent or invalid.
    pub baseline_noise: Option<f32>,

    /// NoiseReductionApplied (0xC6F7): fraction of in-camera NR already applied.
    /// 0.0 = none, 1.0 = full.  `None` when the tag is absent or invalid.
    pub noise_reduction_applied: Option<f32>,

    /// BlackLevelDeltaH (0xC61B): per-column black-level corrections (SRATIONAL array).
    /// Length equals the number of columns in the BlackLevelRepeatDim repeat pattern.
    /// `None` when the tag is absent or could not be parsed.
    pub black_delta_h: Option<Vec<f32>>,

    /// BlackLevelDeltaV (0xC61C): per-row black-level corrections (SRATIONAL array).
    /// Length equals the number of rows in the BlackLevelRepeatDim repeat pattern.
    /// `None` when the tag is absent or could not be parsed.
    pub black_delta_v: Option<Vec<f32>>,

    /// BlackLevelRepeatDim (0xC619): repeat pattern dimensions `[rows, cols]`
    /// for the BlackLevel tag.  `None` when the tag is absent or malformed.
    pub black_repeat_dim: Option<[u32; 2]>,
}

impl Default for RawNoiseMetadata {
    fn default() -> Self {
        Self {
            black: [0.0; 4],
            white: [16383.0; 4],
            embedded_noise: None,
            baseline_noise: None,
            noise_reduction_applied: None,
            black_delta_h: None,
            black_delta_v: None,
            black_repeat_dim: None,
        }
    }
}

// ─── Intermediate builder ─────────────────────────────────────────────────────

/// Accumulated raw tag values gathered during an IFD walk.
/// Call `build()` once all tags have been seen.
#[derive(Default, Debug)]
pub struct NoiseTagAccumulator {
    /// CFAPlaneColor: maps plane index → colour (0=R, 1=G, 2=B).
    pub cfa_plane_color: Option<Vec<u8>>,

    /// BlackLevel DOUBLE/RATIONAL/SHORT/LONG array in CFA repeat order.
    pub black_levels: Vec<f32>,

    /// WhiteLevel — scalar or first value, in sensor counts.
    pub white_level: Option<f32>,

    /// NoiseProfile DOUBLE array (2N values for N colour planes).
    pub noise_profile: Option<Vec<f64>>,

    /// BaselineNoise RATIONAL (num, den).
    pub baseline_noise: Option<(u32, u32)>,

    /// NoiseReductionApplied RATIONAL (num, den).
    pub noise_reduction_applied: Option<(u32, u32)>,

    /// BlackLevelDeltaH (0xC61B): per-column black delta, parsed as f32.
    pub black_delta_h: Option<Vec<f32>>,

    /// BlackLevelDeltaV (0xC61C): per-row black delta, parsed as f32.
    pub black_delta_v: Option<Vec<f32>>,

    /// BlackLevelRepeatDim (0xC619): `[rows, cols]` of the repeat pattern.
    pub black_repeat_dim: Option<[u32; 2]>,
}

impl NoiseTagAccumulator {
    /// Consume the accumulated tags and produce `RawNoiseMetadata`.
    ///
    /// `fallback_black` / `fallback_white`: scalar values already parsed by the
    /// main DNG walker (used when the per-plane tags are absent/invalid).
    pub fn build(self, fallback_black: f32, fallback_white: f32) -> RawNoiseMetadata {
        // ── Black ──────────────────────────────────────────────────────────────
        // Use per-plane black levels if we have exactly 4; otherwise replicate scalar.
        let black = if self.black_levels.len() >= 4 {
            [
                self.black_levels[0],
                self.black_levels[1],
                self.black_levels[2],
                self.black_levels[3],
            ]
        } else if self.black_levels.len() == 1 {
            [self.black_levels[0]; 4]
        } else {
            [fallback_black; 4]
        };

        // ── White ──────────────────────────────────────────────────────────────
        let white_val = self.white_level.unwrap_or(fallback_white);
        let white = [white_val; 4];

        // ── Embedded noise model (NoiseProfile) ────────────────────────────────
        let embedded_noise = self
            .noise_profile
            .as_deref()
            .and_then(|profile| parse_noise_profile(profile, self.cfa_plane_color.as_deref()));

        // ── Baseline noise ─────────────────────────────────────────────────────
        let baseline_noise = self.baseline_noise.and_then(|(n, d)| {
            if d == 0 {
                return None;
            }
            let v = n as f32 / d as f32;
            if v.is_finite() && v >= 0.0 {
                Some(v)
            } else {
                None
            }
        });

        // ── NR applied ─────────────────────────────────────────────────────────
        let noise_reduction_applied =
            self.noise_reduction_applied.and_then(|(n, d)| {
                if d == 0 {
                    return None;
                }
                let v = n as f32 / d as f32;
                if v.is_finite() && v >= 0.0 && v <= 1.0 {
                    Some(v)
                } else {
                    None
                }
            });

        RawNoiseMetadata {
            black,
            white,
            embedded_noise,
            baseline_noise,
            noise_reduction_applied,
            black_delta_h: self.black_delta_h,
            black_delta_v: self.black_delta_v,
            black_repeat_dim: self.black_repeat_dim,
        }
    }
}

// ─── NoiseProfile parser ───────────────────────────────────────────────────────

/// Parse the DNG NoiseProfile DOUBLE array into a 4-plane `NoiseModel`.
///
/// Layout:
/// - 2 values  → coefficients apply to all planes (replicate).
/// - 2N values → one (S, O) pair per colour plane, mapped via `cfa_plane_color`
///   to RGGB CFA plane order.
///
/// Returns `None` if any coefficient is NaN, infinite, or negative, or if the
/// count is not 2 or 2N for N ∈ {3, 4}.
pub fn parse_noise_profile(
    profile: &[f64],
    cfa_plane_color: Option<&[u8]>,
) -> Option<NoiseModel> {
    let n = profile.len();
    if n == 0 || n % 2 != 0 {
        return None;
    }
    let n_planes = n / 2;

    // Validate all values: reject NaN, Inf, negative.
    for &v in profile {
        if !v.is_finite() || v < 0.0 {
            return None;
        }
    }

    let planes: [NoiseCoefficients; 4] = match n_planes {
        1 => {
            // 2-value: apply to all planes.
            let c = NoiseCoefficients {
                shot: profile[0] as f32,
                read: profile[1] as f32,
            };
            [c; 4]
        }
        2 => {
            // 4-value: treat as [R, G] → replicate G for G2, derive B if absent
            // (unusual; map plane 0→R, 1→G, 2→G2, 3→B using best-effort).
            let c0 = NoiseCoefficients {
                shot: profile[0] as f32,
                read: profile[1] as f32,
            };
            let c1 = NoiseCoefficients {
                shot: profile[2] as f32,
                read: profile[3] as f32,
            };
            [c0, c1, c1, c0]
        }
        3 => {
            // 6-value RGB: map through CFAPlaneColor to RGGB order.
            map_rgb_to_rggb(profile, cfa_plane_color)?
        }
        4 => {
            // 8-value: already 4 planes, map through CFAPlaneColor if present.
            map_4plane_to_rggb(profile, cfa_plane_color)?
        }
        _ => return None,
    };

    Some(NoiseModel {
        planes,
        structured_sigma: [0.0; 4],
        confidence: 1.0,
        source: NoiseSource::DngNoiseProfile,
    })
}

/// Map a 3-colour (RGB) noise profile to RGGB CFA plane order using CFAPlaneColor.
///
/// CFAPlaneColor maps CFA plane index → colour: 0=R, 1=G, 2=B.
/// A typical RGGB DNG has CFAPlaneColor = [0, 1, 2] (R=plane0, G=plane1, B=plane2),
/// meaning the NoiseProfile pairs are [S_R, O_R, S_G, O_G, S_B, O_B].
/// We need to rearrange to [R, G1, G2, B] where G1=G2.
fn map_rgb_to_rggb(profile: &[f64], cfa_plane_color: Option<&[u8]>) -> Option<[NoiseCoefficients; 4]> {
    // Build R, G, B coefficients indexed by colour.
    // Default CFAPlaneColor for RGGB = [0=R, 1=G, 2=B].
    let mut color_coeff = [None::<NoiseCoefficients>; 3]; // index = colour (R=0,G=1,B=2)

    let mapping: &[u8] = cfa_plane_color.unwrap_or(&[0, 1, 2]);
    // mapping.len() may be shorter than 3; only iterate up to min.
    let pairs = profile.len() / 2;
    for plane_idx in 0..pairs.min(3) {
        let colour = *mapping.get(plane_idx)? as usize;
        if colour > 2 {
            return None; // Invalid colour code.
        }
        color_coeff[colour] = Some(NoiseCoefficients {
            shot: profile[plane_idx * 2] as f32,
            read: profile[plane_idx * 2 + 1] as f32,
        });
    }

    let r = color_coeff[0]?; // red
    let g = color_coeff[1]?; // green
    let b = color_coeff[2]?; // blue

    // RGGB: [R, G1, G2, B] — both greens share the same model.
    Some([r, g, g, b])
}

/// Map a 4-plane noise profile to RGGB CFA plane order.
///
/// When `cfa_plane_color` is provided and has ≥4 entries, rearrange according to it.
/// Otherwise treat the values as already in RGGB order.
fn map_4plane_to_rggb(
    profile: &[f64],
    cfa_plane_color: Option<&[u8]>,
) -> Option<[NoiseCoefficients; 4]> {
    let to_nc = |i: usize| NoiseCoefficients {
        shot: profile[i * 2] as f32,
        read: profile[i * 2 + 1] as f32,
    };

    if let Some(colors) = cfa_plane_color {
        if colors.len() >= 4 {
            // Build destination indexed by colour.
            let mut dest = [None::<NoiseCoefficients>; 4];
            for (plane_idx, &colour) in colors.iter().take(4).enumerate() {
                let c = colour as usize;
                if c >= 4 {
                    return None;
                }
                dest[c] = Some(to_nc(plane_idx));
            }
            // RGGB destination: [R=0, G1=1, G2=2, B=3] — if color codes are
            // 0=R,1=G,1=G,2=B then dest[1] covers G1; G2 may be None, use same.
            let r = dest[0]?;
            let g = dest[1]?;
            let g2 = dest[2].unwrap_or(g);
            let b = dest[3]?;
            return Some([r, g, g2, b]);
        }
    }

    // No mapping: assume already in RGGB order.
    Some([to_nc(0), to_nc(1), to_nc(2), to_nc(3)])
}

// ─── DOUBLE reader ─────────────────────────────────────────────────────────────

/// Read `count` IEEE-754 double values (dtype=12) from `data` at `offset`,
/// honoring endianness `le`. Returns `None` on any out-of-bounds access.
pub fn read_doubles(data: &[u8], offset: usize, count: usize, le: bool) -> Option<Vec<f64>> {
    const SZ: usize = 8;
    let end = offset.checked_add(count.checked_mul(SZ)?)?;
    if end > data.len() {
        return None;
    }
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let p = offset + i * SZ;
        let b: [u8; 8] = data[p..p + SZ].try_into().ok()?;
        out.push(if le {
            f64::from_le_bytes(b)
        } else {
            f64::from_be_bytes(b)
        });
    }
    Some(out)
}

/// Read a RATIONAL or SRATIONAL pair (dtype=5 or 10) from `data` at `offset`.
/// Returns the raw (numerator, denominator) as (u32, u32).
pub fn read_rational(data: &[u8], offset: usize, le: bool) -> Option<(u32, u32)> {
    let end = offset.checked_add(8)?;
    if end > data.len() {
        return None;
    }
    let n_bytes: [u8; 4] = data[offset..offset + 4].try_into().ok()?;
    let d_bytes: [u8; 4] = data[offset + 4..offset + 8].try_into().ok()?;
    let n = if le {
        u32::from_le_bytes(n_bytes)
    } else {
        u32::from_be_bytes(n_bytes)
    };
    let d = if le {
        u32::from_le_bytes(d_bytes)
    } else {
        u32::from_be_bytes(d_bytes)
    };
    Some((n, d))
}

/// Read `count` SRATIONAL values (dtype=10, each 8 bytes: i32 num + i32 den) from
/// `data` at `offset`, honoring endianness `le`.
///
/// Each rational is converted to `f32` (num/den). A zero denominator yields 0.0.
/// Returns `None` on any out-of-bounds access or if `count == 0`.
pub fn read_srational_array(data: &[u8], offset: usize, count: usize, le: bool) -> Option<Vec<f32>> {
    if count == 0 {
        return None;
    }
    const SZ: usize = 8;
    let end = offset.checked_add(count.checked_mul(SZ)?)?;
    if end > data.len() {
        return None;
    }
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let p = offset + i * SZ;
        let nb: [u8; 4] = data[p..p + 4].try_into().ok()?;
        let db: [u8; 4] = data[p + 4..p + 8].try_into().ok()?;
        let num = if le { i32::from_le_bytes(nb) } else { i32::from_be_bytes(nb) };
        let den = if le { i32::from_le_bytes(db) } else { i32::from_be_bytes(db) };
        out.push(if den != 0 { num as f32 / den as f32 } else { 0.0 });
    }
    Some(out)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::denoise::types::NoiseSource;

    // ── Helper: build a minimal synthetic TIFF-like byte buffer ──────────────

    fn le_f64(v: f64) -> [u8; 8] {
        v.to_le_bytes()
    }
    fn be_f64(v: f64) -> [u8; 8] {
        v.to_be_bytes()
    }
    fn le_u32(v: u32) -> [u8; 4] {
        v.to_le_bytes()
    }
    fn be_u32(v: u32) -> [u8; 4] {
        v.to_be_bytes()
    }

    // ── parse_noise_profile ───────────────────────────────────────────────────

    #[test]
    fn two_value_profile_replicates_to_all_planes() {
        // 2 values → same coefficients on all 4 CFA planes.
        let profile = [0.00042f64, 0.0000031f64];
        let model = parse_noise_profile(&profile, None).expect("should parse");
        assert_eq!(model.source, NoiseSource::DngNoiseProfile);
        assert!((model.confidence - 1.0).abs() < 1e-6);
        for p in &model.planes {
            assert!((p.shot - 0.00042f32).abs() < 1e-7);
            assert!((p.read - 0.0000031f32).abs() < 1e-10);
        }
    }

    #[test]
    fn six_value_rgb_profile_mapped_via_cfa_plane_color_to_rggb() {
        // CFAPlaneColor [0, 1, 2] → plane0=R, plane1=G, plane2=B
        // Profile: [S_R, O_R, S_G, O_G, S_B, O_B]
        let shot_r = 0.000100f64;
        let read_r = 0.000001f64;
        let shot_g = 0.000200f64;
        let read_g = 0.000002f64;
        let shot_b = 0.000300f64;
        let read_b = 0.000003f64;
        let profile = [shot_r, read_r, shot_g, read_g, shot_b, read_b];
        let cfa_plane_color: &[u8] = &[0, 1, 2]; // R, G, B
        let model = parse_noise_profile(&profile, Some(cfa_plane_color)).expect("should parse");

        // RGGB order: [R, G1, G2, B]
        assert!((model.planes[0].shot - shot_r as f32).abs() < 1e-7, "R shot");
        assert!((model.planes[0].read - read_r as f32).abs() < 1e-11, "R read");
        assert!((model.planes[1].shot - shot_g as f32).abs() < 1e-7, "G1 shot");
        assert!((model.planes[1].read - read_g as f32).abs() < 1e-11, "G1 read");
        assert!((model.planes[2].shot - shot_g as f32).abs() < 1e-7, "G2 shot (= G1)");
        assert!((model.planes[3].shot - shot_b as f32).abs() < 1e-7, "B shot");
        assert!((model.planes[3].read - read_b as f32).abs() < 1e-11, "B read");
    }

    #[test]
    fn reject_nan_in_noise_profile() {
        let profile = [f64::NAN, 0.001f64];
        assert!(parse_noise_profile(&profile, None).is_none());
    }

    #[test]
    fn reject_infinity_in_noise_profile() {
        let profile = [0.001f64, f64::INFINITY];
        assert!(parse_noise_profile(&profile, None).is_none());
    }

    #[test]
    fn reject_negative_in_noise_profile() {
        let profile = [-0.001f64, 0.001f64];
        assert!(parse_noise_profile(&profile, None).is_none());
    }

    #[test]
    fn reject_odd_length_noise_profile() {
        let profile = [0.001f64, 0.0001f64, 0.002f64]; // 3 values (not even)
        assert!(parse_noise_profile(&profile, None).is_none());
    }

    #[test]
    fn reject_empty_noise_profile() {
        let profile: &[f64] = &[];
        assert!(parse_noise_profile(profile, None).is_none());
    }

    #[test]
    fn reject_10_value_noise_profile() {
        // 10 values = 5 planes — not 1, 2, 3, or 4 → reject.
        let profile = [0.001f64; 10];
        assert!(parse_noise_profile(&profile, None).is_none());
    }

    // ── read_doubles ──────────────────────────────────────────────────────────

    #[test]
    fn read_doubles_little_endian() {
        let values = [1.5f64, 2.75f64];
        let mut buf = Vec::new();
        for v in &values {
            buf.extend_from_slice(&le_f64(*v));
        }
        let got = read_doubles(&buf, 0, 2, true).expect("read");
        assert!((got[0] - 1.5).abs() < 1e-15);
        assert!((got[1] - 2.75).abs() < 1e-15);
    }

    #[test]
    fn read_doubles_big_endian() {
        let values = [1.5f64, 2.75f64];
        let mut buf = Vec::new();
        for v in &values {
            buf.extend_from_slice(&be_f64(*v));
        }
        let got = read_doubles(&buf, 0, 2, false).expect("read");
        assert!((got[0] - 1.5).abs() < 1e-15);
        assert!((got[1] - 2.75).abs() < 1e-15);
    }

    #[test]
    fn read_doubles_oob_returns_none() {
        let buf = [0u8; 7]; // too short for one f64
        assert!(read_doubles(&buf, 0, 1, true).is_none());
    }

    // ── read_rational ──────────────────────────────────────────────────────────

    #[test]
    fn read_rational_le() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&le_u32(25));
        buf.extend_from_slice(&le_u32(100));
        let (n, d) = read_rational(&buf, 0, true).expect("read");
        assert_eq!(n, 25);
        assert_eq!(d, 100);
    }

    #[test]
    fn read_rational_be() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&be_u32(1));
        buf.extend_from_slice(&be_u32(4));
        let (n, d) = read_rational(&buf, 0, false).expect("read");
        assert_eq!(n, 1);
        assert_eq!(d, 4);
    }

    #[test]
    fn read_rational_oob_returns_none() {
        let buf = [0u8; 7];
        assert!(read_rational(&buf, 0, true).is_none());
    }

    // ── NoiseTagAccumulator::build ────────────────────────────────────────────

    #[test]
    fn accumulator_build_falls_back_to_scalar_black_white() {
        let acc = NoiseTagAccumulator::default();
        let m = acc.build(512.0, 15000.0);
        assert_eq!(m.black, [512.0; 4]);
        assert_eq!(m.white, [15000.0; 4]);
        assert!(m.embedded_noise.is_none());
        assert!(m.baseline_noise.is_none());
        assert!(m.noise_reduction_applied.is_none());
    }

    #[test]
    fn accumulator_build_uses_four_black_levels() {
        let mut acc = NoiseTagAccumulator::default();
        acc.black_levels = vec![512.0, 513.0, 513.0, 515.0];
        acc.white_level = Some(15000.0);
        let m = acc.build(0.0, 0.0);
        assert_eq!(m.black, [512.0, 513.0, 513.0, 515.0]);
        assert_eq!(m.white, [15000.0; 4]);
    }

    #[test]
    fn accumulator_build_parses_embedded_noise_with_correct_values() {
        let mut acc = NoiseTagAccumulator::default();
        acc.noise_profile = Some(vec![0.00042f64, 0.0000031f64]);
        let m = acc.build(0.0, 16383.0);
        let noise = m.embedded_noise.expect("noise model present");
        assert_eq!(noise.source, NoiseSource::DngNoiseProfile);
        assert!((noise.confidence - 1.0).abs() < 1e-6);
        assert!((noise.planes[0].shot - 0.00042f32).abs() < 1e-7);
        assert!((noise.planes[0].read - 0.0000031f32).abs() < 1e-10);
    }

    #[test]
    fn accumulator_build_parses_noise_reduction_applied() {
        let mut acc = NoiseTagAccumulator::default();
        acc.noise_reduction_applied = Some((25, 100)); // 0.25
        let m = acc.build(0.0, 16383.0);
        let nra = m.noise_reduction_applied.expect("nra present");
        assert!((nra - 0.25f32).abs() < 1e-6);
    }

    #[test]
    fn accumulator_build_rejects_zero_denominator_nra() {
        let mut acc = NoiseTagAccumulator::default();
        acc.noise_reduction_applied = Some((1, 0)); // den = 0
        let m = acc.build(0.0, 16383.0);
        assert!(m.noise_reduction_applied.is_none());
    }

    #[test]
    fn accumulator_build_rejects_nra_above_one() {
        let mut acc = NoiseTagAccumulator::default();
        acc.noise_reduction_applied = Some((200, 100)); // 2.0 — invalid
        let m = acc.build(0.0, 16383.0);
        assert!(m.noise_reduction_applied.is_none());
    }

    #[test]
    fn accumulator_build_parses_baseline_noise() {
        let mut acc = NoiseTagAccumulator::default();
        acc.baseline_noise = Some((3, 2)); // 1.5
        let m = acc.build(0.0, 16383.0);
        let bn = m.baseline_noise.expect("baseline_noise present");
        assert!((bn - 1.5f32).abs() < 1e-6);
    }

    // ── read_srational_array ───────────────────────────────────────────────────

    #[test]
    fn read_srational_array_le_positive() {
        // Two SRATIONAL values: 1/2 = 0.5, 3/4 = 0.75
        let mut buf = Vec::new();
        buf.extend_from_slice(&1i32.to_le_bytes());
        buf.extend_from_slice(&2i32.to_le_bytes());
        buf.extend_from_slice(&3i32.to_le_bytes());
        buf.extend_from_slice(&4i32.to_le_bytes());
        let v = read_srational_array(&buf, 0, 2, true).expect("should parse");
        assert_eq!(v.len(), 2);
        assert!((v[0] - 0.5).abs() < 1e-6, "v[0]={}", v[0]);
        assert!((v[1] - 0.75).abs() < 1e-6, "v[1]={}", v[1]);
    }

    #[test]
    fn read_srational_array_le_negative() {
        // SRATIONAL: -1/4 = -0.25
        let mut buf = Vec::new();
        buf.extend_from_slice(&(-1i32).to_le_bytes());
        buf.extend_from_slice(&4i32.to_le_bytes());
        let v = read_srational_array(&buf, 0, 1, true).expect("should parse");
        assert!((v[0] - (-0.25)).abs() < 1e-6, "v[0]={}", v[0]);
    }

    #[test]
    fn read_srational_array_zero_denominator_yields_zero() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&5i32.to_le_bytes());
        buf.extend_from_slice(&0i32.to_le_bytes()); // den=0
        let v = read_srational_array(&buf, 0, 1, true).expect("should parse");
        assert_eq!(v[0], 0.0);
    }

    #[test]
    fn read_srational_array_oob_returns_none() {
        let buf = [0u8; 7]; // not enough for one SRATIONAL (needs 8)
        assert!(read_srational_array(&buf, 0, 1, true).is_none());
    }

    #[test]
    fn read_srational_array_count_zero_returns_none() {
        let buf = [0u8; 16];
        assert!(read_srational_array(&buf, 0, 0, true).is_none());
    }

    // ── NoiseTagAccumulator — new fields ──────────────────────────────────────

    #[test]
    fn accumulator_build_propagates_black_delta_h_and_v() {
        let mut acc = NoiseTagAccumulator::default();
        acc.black_delta_h = Some(vec![1.0, -0.5, 0.25]);
        acc.black_delta_v = Some(vec![0.1, -0.1]);
        let m = acc.build(0.0, 16383.0);
        let dh = m.black_delta_h.expect("black_delta_h present");
        assert_eq!(dh.len(), 3);
        assert!((dh[0] - 1.0).abs() < 1e-6);
        assert!((dh[1] - (-0.5)).abs() < 1e-6);
        assert!((dh[2] - 0.25).abs() < 1e-6);
        let dv = m.black_delta_v.expect("black_delta_v present");
        assert_eq!(dv.len(), 2);
        assert!((dv[0] - 0.1).abs() < 1e-6);
        assert!((dv[1] - (-0.1)).abs() < 1e-6);
    }

    #[test]
    fn accumulator_build_propagates_black_repeat_dim() {
        let mut acc = NoiseTagAccumulator::default();
        acc.black_repeat_dim = Some([2, 2]);
        let m = acc.build(0.0, 16383.0);
        assert_eq!(m.black_repeat_dim, Some([2, 2]));
    }

    #[test]
    fn accumulator_build_none_when_delta_and_repeat_dim_absent() {
        let acc = NoiseTagAccumulator::default();
        let m = acc.build(0.0, 16383.0);
        assert!(m.black_delta_h.is_none());
        assert!(m.black_delta_v.is_none());
        assert!(m.black_repeat_dim.is_none());
    }

    #[test]
    fn full_synthetic_fixture_matches_plan_assertions() {
        // Mirror the exact assertions from the task plan:
        //   black [512, 513, 513, 515], white [15000; 4]
        //   embedded_noise planes[0] = { shot: 0.00042, read: 0.0000031 }
        //   noise_reduction_applied = Some(0.25)
        let mut acc = NoiseTagAccumulator::default();
        acc.black_levels = vec![512.0, 513.0, 513.0, 515.0];
        acc.white_level = Some(15000.0);
        acc.noise_profile = Some(vec![0.00042f64, 0.0000031f64]);
        acc.noise_reduction_applied = Some((25, 100)); // 0.25

        let meta = acc.build(0.0, 0.0);
        assert_eq!(meta.black, [512.0, 513.0, 513.0, 515.0]);
        assert_eq!(meta.white, [15000.0; 4]);

        let noise = meta.embedded_noise.expect("noise model present");
        let p0 = noise.planes[0];
        assert!((p0.shot - 0.00042f32).abs() < 1e-7, "shot={}", p0.shot);
        assert!(
            (p0.read - 0.0000031f32).abs() < 1e-10,
            "read={}",
            p0.read
        );

        let nra = meta.noise_reduction_applied.expect("nra present");
        assert!((nra - 0.25f32).abs() < 1e-6, "nra={nra}");
    }
}
