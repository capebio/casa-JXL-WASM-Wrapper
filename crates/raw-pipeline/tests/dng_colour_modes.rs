//! P3-T9 (finding 56): DNG dual-illuminant calibration interpolation.
//!
//! Tested with SYNTHETIC DNGs built in-test (no real dual-illuminant corpus is checked
//! in; a real dual-illuminant Pixel DNG is used opportunistically elsewhere).
//!
//! A DNG carries ColorMatrix1/2 + CalibrationIlluminant1/2 (+ optional ForwardMatrix1/2).
//! The camera→sRGB matrix must be **interpolated** between the two calibrations based on
//! the shot's estimated colour temperature (from AsShotNeutral), per the DNG spec.
//! CRITICAL CONTRACT: a single-illuminant file (only matrix1, matrix1==matrix2, or the two
//! illuminants equal) must resolve to the SAME matrix as before → ZERO drift.
//!
//! (Finding 57 — linear/uncompressed RGB — is tested in `dng_linear_rgb.rs`.)

use raw_pipeline::dng;

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic-DNG builder (minimal little-endian TIFF/DNG in a single SubIFD).
// ─────────────────────────────────────────────────────────────────────────────

struct Tag {
    tag: u16,
    dtype: u16,
    count: u32,
    val: TagVal,
}
enum TagVal {
    Inline([u8; 4]),
    Ptr(Vec<u8>),
}

fn u16le(v: u16) -> [u8; 4] {
    let b = v.to_le_bytes();
    [b[0], b[1], 0, 0]
}
fn u32le(v: u32) -> [u8; 4] {
    v.to_le_bytes()
}

/// SRATIONAL (type 10) 3x3 matrix → 72 bytes (9 * (i32 num, i32 den)), den=10000.
fn srational_matrix(m: [[f32; 3]; 3]) -> Vec<u8> {
    let mut out = Vec::with_capacity(72);
    for row in 0..3 {
        for col in 0..3 {
            let num = (m[row][col] * 10000.0).round() as i32;
            out.extend_from_slice(&num.to_le_bytes());
            out.extend_from_slice(&10000i32.to_le_bytes());
        }
    }
    out
}

/// RATIONAL (type 5) triple for AsShotNeutral → 24 bytes.
fn rational_triple(v: [f32; 3]) -> Vec<u8> {
    let mut out = Vec::with_capacity(24);
    for x in v {
        let num = (x * 100000.0).round() as u32;
        out.extend_from_slice(&num.to_le_bytes());
        out.extend_from_slice(&100000u32.to_le_bytes());
    }
    out
}

/// Assemble a single-IFD little-endian TIFF from `tags` (sorted by tag ascending).
fn build_tiff(mut tags: Vec<Tag>) -> Vec<u8> {
    tags.sort_by_key(|t| t.tag);
    let n = tags.len();
    let ifd_start = 8usize;
    let entries_len = 2 + n * 12 + 4;
    let mut blob_off = ifd_start + entries_len;
    let mut blobs: Vec<(usize, Vec<u8>)> = Vec::new();
    let mut ptr_off: Vec<Option<u32>> = Vec::with_capacity(n);
    for t in &tags {
        match &t.val {
            TagVal::Inline(_) => ptr_off.push(None),
            TagVal::Ptr(bytes) => {
                ptr_off.push(Some(blob_off as u32));
                blobs.push((blob_off, bytes.clone()));
                blob_off += bytes.len();
                if blob_off % 2 == 1 {
                    blob_off += 1;
                }
            }
        }
    }
    let mut out = vec![0u8; blob_off];
    out[0..4].copy_from_slice(&[0x49, 0x49, 0x2A, 0x00]);
    out[4..8].copy_from_slice(&(ifd_start as u32).to_le_bytes());
    out[ifd_start..ifd_start + 2].copy_from_slice(&(n as u16).to_le_bytes());
    for (i, t) in tags.iter().enumerate() {
        let e = ifd_start + 2 + i * 12;
        out[e..e + 2].copy_from_slice(&t.tag.to_le_bytes());
        out[e + 2..e + 4].copy_from_slice(&t.dtype.to_le_bytes());
        out[e + 4..e + 8].copy_from_slice(&t.count.to_le_bytes());
        let valbytes = match (&t.val, ptr_off[i]) {
            (TagVal::Inline(b), _) => *b,
            (TagVal::Ptr(_), Some(off)) => u32le(off),
            (TagVal::Ptr(_), None) => unreachable!(),
        };
        out[e + 8..e + 12].copy_from_slice(&valbytes);
    }
    for (off, bytes) in blobs {
        out[off..off + bytes.len()].copy_from_slice(&bytes);
    }
    out
}

/// A tiny raw-image strip: `w*h` u16 sensor counts, little-endian, mid-grey-ish.
fn strip_u16(w: usize, h: usize, fill: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(w * h * 2);
    for i in 0..w * h {
        let v = fill.wrapping_add((i as u16).wrapping_mul(7));
        out.extend_from_slice(&(v & 0x3fff).to_le_bytes());
    }
    out
}

const PHOTOMETRIC_CFA: u16 = 32803;
const IL_STD_A: u16 = 17;
const IL_D65: u16 = 21;

const CM_D65: [[f32; 3]; 3] = [
    [0.85, 0.05, 0.05],
    [-0.10, 1.05, 0.05],
    [0.02, -0.15, 1.10],
];
const CM_TUNGSTEN: [[f32; 3]; 3] = [
    [0.70, 0.10, 0.10],
    [-0.05, 0.95, 0.10],
    [0.05, -0.25, 1.25],
];

/// Build a single-SubIFD CFA DNG. If `dual`, adds ColorMatrix2 + illuminant2.
fn build_cfa_dng(w: usize, h: usize, dual: bool, cm1: [[f32; 3]; 3], cm2: [[f32; 3]; 3]) -> Vec<u8> {
    let strip = strip_u16(w, h, 2000);
    let mut tags = vec![
        Tag { tag: 0x0100, dtype: 3, count: 1, val: TagVal::Inline(u16le(w as u16)) },
        Tag { tag: 0x0101, dtype: 3, count: 1, val: TagVal::Inline(u16le(h as u16)) },
        Tag { tag: 0x0102, dtype: 3, count: 1, val: TagVal::Inline(u16le(16)) },
        Tag { tag: 0x0103, dtype: 3, count: 1, val: TagVal::Inline(u16le(1)) },
        Tag { tag: 0x0106, dtype: 3, count: 1, val: TagVal::Inline(u16le(PHOTOMETRIC_CFA)) },
        Tag { tag: 0x0111, dtype: 4, count: 1, val: TagVal::Inline(u32le(0)) },
        Tag { tag: 0x0115, dtype: 3, count: 1, val: TagVal::Inline(u16le(1)) },
        Tag { tag: 0x0116, dtype: 4, count: 1, val: TagVal::Inline(u32le(h as u32)) },
        Tag { tag: 0x0117, dtype: 4, count: 1, val: TagVal::Inline(u32le(strip.len() as u32)) },
        Tag { tag: 0x828E, dtype: 1, count: 4, val: TagVal::Inline([0, 1, 1, 2]) },
        Tag { tag: 0xC621, dtype: 10, count: 9, val: TagVal::Ptr(srational_matrix(cm1)) },
        Tag { tag: 0xC628, dtype: 5, count: 3, val: TagVal::Ptr(rational_triple([0.5, 1.0, 0.7])) },
        Tag { tag: 0xC65A, dtype: 3, count: 1, val: TagVal::Inline(u16le(IL_STD_A)) },
    ];
    if dual {
        tags.push(Tag { tag: 0xC622, dtype: 10, count: 9, val: TagVal::Ptr(srational_matrix(cm2)) });
        tags.push(Tag { tag: 0xC65B, dtype: 3, count: 1, val: TagVal::Inline(u16le(IL_D65)) });
    }
    patch_strip(build_tiff(tags), &strip)
}

/// Append `strip` bytes at EOF and patch the StripOffsets (0x0111) value to point there.
fn patch_strip(mut tiff: Vec<u8>, strip: &[u8]) -> Vec<u8> {
    let strip_off = tiff.len() as u32;
    let le = tiff[0] == 0x49;
    let r16 = |t: &[u8], o: usize| if le { u16::from_le_bytes([t[o], t[o + 1]]) } else { u16::from_be_bytes([t[o], t[o + 1]]) };
    let ifd0 = if le {
        u32::from_le_bytes([tiff[4], tiff[5], tiff[6], tiff[7]])
    } else {
        u32::from_be_bytes([tiff[4], tiff[5], tiff[6], tiff[7]])
    } as usize;
    let n = r16(&tiff, ifd0) as usize;
    for i in 0..n {
        let e = ifd0 + 2 + i * 12;
        if r16(&tiff, e) == 0x0111 {
            let ob = if le { strip_off.to_le_bytes() } else { strip_off.to_be_bytes() };
            tiff[e + 8..e + 12].copy_from_slice(&ob);
        }
    }
    tiff.extend_from_slice(strip);
    tiff
}

// ─────────────────────────────────────────────────────────────────────────────
// Finding 56 — dual-illuminant interpolation
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn single_illuminant_matrix_unchanged() {
    // Only ColorMatrix1 + illuminant1 → the resolved matrix must equal the plain
    // single-matrix inversion path (ZERO change vs pre-T9 behaviour).
    let data = build_cfa_dng(8, 8, false, CM_D65, CM_TUNGSTEN);
    let img = dng::decode_bytes(&data).expect("decode single-illum CFA DNG");
    let expected = dng::camera_to_srgb_from_single(CM_D65).expect("single-matrix reference");
    let got = img.color_matrix.expect("color_matrix present");
    assert_matrix_close(got, expected, 1e-4, "single-illuminant must match single-matrix path");
}

#[test]
fn equal_matrices_dual_illuminant_is_identical_to_single() {
    // ColorMatrix1 == ColorMatrix2 (degenerate dual): interpolation of equal endpoints
    // must produce the same matrix as the single path → zero drift regardless of CCT.
    let data = build_cfa_dng(8, 8, true, CM_D65, CM_D65);
    let img = dng::decode_bytes(&data).expect("decode");
    let expected = dng::camera_to_srgb_from_single(CM_D65).expect("ref");
    let got = img.color_matrix.expect("matrix");
    assert_matrix_close(got, expected, 1e-4, "equal dual matrices must equal single path");
}

#[test]
fn dual_illuminant_interpolates_between_endpoints() {
    // Distinct ColorMatrix1 (StdA) / ColorMatrix2 (D65) + a neutral: the resolved
    // camera→sRGB matrix must be an INTERPOLATION — strictly between the two endpoint
    // resolutions, not equal to either.
    let data = build_cfa_dng(8, 8, true, CM_TUNGSTEN, CM_D65);
    let img = dng::decode_bytes(&data).expect("decode");
    let got = img.color_matrix.expect("matrix");
    let end_a = dng::camera_to_srgb_from_single(CM_TUNGSTEN).expect("a");
    let end_b = dng::camera_to_srgb_from_single(CM_D65).expect("b");
    assert!(
        !matrices_close(got, end_a, 1e-5) && !matrices_close(got, end_b, 1e-5),
        "dual-illuminant result must be interpolated, not an endpoint"
    );
    for r in 0..3 {
        for c in 0..3 {
            let lo = end_a[r][c].min(end_b[r][c]) - 1e-3;
            let hi = end_a[r][c].max(end_b[r][c]) + 1e-3;
            assert!(
                got[r][c] >= lo && got[r][c] <= hi,
                "element [{r}][{c}]={} outside endpoint interval [{lo},{hi}]",
                got[r][c]
            );
        }
    }
}

#[test]
fn dual_illuminant_provenance_and_fraction_reported() {
    let data = build_cfa_dng(8, 8, true, CM_TUNGSTEN, CM_D65);
    let prov = dng::calibration_provenance(&data).expect("provenance");
    assert!(prov.dual, "should be recognised as dual-illuminant");
    assert!(
        prov.fraction > 0.0 && prov.fraction < 1.0,
        "fraction {} must be strictly interior for a between-endpoint neutral",
        prov.fraction
    );
    assert!(prov.estimated_cct > 2000.0 && prov.estimated_cct < 10000.0, "cct {} implausible", prov.estimated_cct);
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

fn matrices_close(a: [[f32; 3]; 3], b: [[f32; 3]; 3], eps: f32) -> bool {
    for r in 0..3 {
        for c in 0..3 {
            if (a[r][c] - b[r][c]).abs() > eps {
                return false;
            }
        }
    }
    true
}

fn assert_matrix_close(a: [[f32; 3]; 3], b: [[f32; 3]; 3], eps: f32, msg: &str) {
    for r in 0..3 {
        for c in 0..3 {
            let d = (a[r][c] - b[r][c]).abs();
            assert!(d <= eps, "{msg}: [{r}][{c}] diff {d} a={} b={}", a[r][c], b[r][c]);
        }
    }
}
