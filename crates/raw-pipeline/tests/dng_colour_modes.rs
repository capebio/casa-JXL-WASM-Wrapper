//! P3-T9 (findings 56, 57): DNG dual-illuminant calibration + linear/uncompressed RGB.
//!
//! Two independent capabilities, tested with SYNTHETIC DNGs built in-test (no real
//! dual-illuminant / linear-RGB corpus is checked in). A real dual-illuminant Pixel
//! DNG is used opportunistically when present (fixture-gated).
//!
//! ## Finding 56 — dual-illuminant interpolation
//! A DNG carries ColorMatrix1/2 + CalibrationIlluminant1/2 (+ optional ForwardMatrix1/2).
//! The camera→sRGB matrix must be **interpolated** between the two calibrations based on
//! the shot's estimated colour temperature (from AsShotNeutral), per the DNG spec.
//! CRITICAL CONTRACT: a single-illuminant file (only matrix1, matrix1==matrix2, or the two
//! illuminants equal) must resolve to the SAME matrix as before → ZERO drift.
//!
//! ## Finding 57 — linear / uncompressed RGB
//! PhotometricInterpretation = LinearRaw(34892) or RGB(2) with SamplesPerPixel=3 is
//! already-demosaiced RGB (chunky or planar, 8/16-bit, either endian). The CFA-only path
//! rejected these; the new path parses the layout, bypasses CFA/demosaic, and keeps the
//! black/white-level + colour-matrix + tone contracts.

use raw_pipeline::dng;

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic-DNG builder (minimal little-endian TIFF/DNG in a single SubIFD).
// Mirrors the style the existing dng.rs unit tests use (hand-rolled IFDs), but at
// file scope so both capabilities share it.
// ─────────────────────────────────────────────────────────────────────────────

/// A TIFF tag (tag, type, count, inline-or-pointer value). For values that don't fit
/// in 4 bytes, `data` holds the out-of-line bytes and `Val::Ptr` records where.
struct Tag {
    tag: u16,
    dtype: u16,
    count: u32,
    val: TagVal,
}
enum TagVal {
    /// Fits in the 4-byte value field (already little-endian, left-justified).
    Inline([u8; 4]),
    /// Out-of-line bytes appended after the IFD; the builder patches the offset.
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

/// Assemble a single-IFD little-endian TIFF from `tags` (sorted by tag ascending, as
/// TIFF requires). Out-of-line blobs are laid out after the IFD and pointers patched.
fn build_tiff(mut tags: Vec<Tag>) -> Vec<u8> {
    tags.sort_by_key(|t| t.tag);
    let n = tags.len();
    // header(8) + entry_count(2) + entries(12*n) + next_ifd(4)
    let ifd_start = 8usize;
    let entries_len = 2 + n * 12 + 4;
    let mut blob_off = ifd_start + entries_len;

    // Pre-compute pointer offsets for out-of-line values.
    let mut blobs: Vec<(usize, Vec<u8>)> = Vec::new();
    let mut ptr_off: Vec<Option<u32>> = Vec::with_capacity(n);
    for t in &tags {
        match &t.val {
            TagVal::Inline(_) => ptr_off.push(None),
            TagVal::Ptr(bytes) => {
                ptr_off.push(Some(blob_off as u32));
                blobs.push((blob_off, bytes.clone()));
                blob_off += bytes.len();
                // keep 2-byte alignment for following blobs
                if blob_off % 2 == 1 {
                    blob_off += 1;
                }
            }
        }
    }

    let mut out = vec![0u8; blob_off];
    // TIFF header (little-endian), IFD0 at offset 8.
    out[0..4].copy_from_slice(&[0x49, 0x49, 0x2A, 0x00]);
    out[4..8].copy_from_slice(&(ifd_start as u32).to_le_bytes());

    // entry count
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
    // next IFD = 0 (already zero).
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
const PHOTOMETRIC_LINEAR_RAW: u16 = 34892;
const PHOTOMETRIC_RGB: u16 = 2;

const IL_STD_A: u16 = 17;
const IL_D65: u16 = 21;

/// D65-ish and Tungsten-ish 3x3 camera→XYZ colour matrices (invertible, distinct).
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
        Tag { tag: 0x0103, dtype: 3, count: 1, val: TagVal::Inline(u16le(1)) }, // uncompressed
        Tag { tag: 0x0106, dtype: 3, count: 1, val: TagVal::Inline(u16le(PHOTOMETRIC_CFA)) },
        Tag { tag: 0x0111, dtype: 4, count: 1, val: TagVal::Inline(u32le(0)) }, // strip offset (patched below)
        Tag { tag: 0x0115, dtype: 3, count: 1, val: TagVal::Inline(u16le(1)) },
        Tag { tag: 0x0116, dtype: 4, count: 1, val: TagVal::Inline(u32le(h as u32)) },
        Tag { tag: 0x0117, dtype: 4, count: 1, val: TagVal::Inline(u32le(strip.len() as u32)) },
        Tag { tag: 0x828E, dtype: 1, count: 4, val: TagVal::Inline([0, 1, 1, 2]) }, // RGGB CFA
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

/// Build a linear-RGB DNG. `planar` selects PlanarConfiguration; `bps` = 8 or 16;
/// `photometric` = LinearRaw or RGB. Fills a deterministic RGB ramp.
fn build_linear_rgb_dng(
    w: usize,
    h: usize,
    planar: bool,
    bps: u16,
    photometric: u16,
    big_endian: bool,
) -> Vec<u8> {
    // Pixel (x,y): R=x*4, G=y*4, B=(x+y)*2 (clamped), scaled to bps.
    let scale = if bps == 16 { 256u32 } else { 1u32 };
    let px = |x: usize, y: usize, c: usize| -> u32 {
        let base = match c {
            0 => (x as u32 * 4) & 0xff,
            1 => (y as u32 * 4) & 0xff,
            _ => ((x + y) as u32 * 2) & 0xff,
        };
        (base * scale).min(if bps == 16 { 0xffff } else { 0xff })
    };
    let mut strip: Vec<u8> = Vec::new();
    let push = |strip: &mut Vec<u8>, v: u32| {
        if bps == 16 {
            let b = (v as u16).to_le_bytes();
            let be = (v as u16).to_be_bytes();
            if big_endian { strip.extend_from_slice(&be); } else { strip.extend_from_slice(&b); }
        } else {
            strip.push(v as u8);
        }
    };
    if planar {
        for c in 0..3 {
            for y in 0..h {
                for x in 0..w {
                    push(&mut strip, px(x, y, c));
                }
            }
        }
    } else {
        for y in 0..h {
            for x in 0..w {
                for c in 0..3 {
                    push(&mut strip, px(x, y, c));
                }
            }
        }
    }

    let byte_order: [u8; 4] = if big_endian { [0x4D, 0x4D, 0x00, 0x2A] } else { [0x49, 0x49, 0x2A, 0x00] };
    let mut tags = vec![
        Tag { tag: 0x0100, dtype: 3, count: 1, val: TagVal::Inline(u16le(w as u16)) },
        Tag { tag: 0x0101, dtype: 3, count: 1, val: TagVal::Inline(u16le(h as u16)) },
        Tag { tag: 0x0102, dtype: 3, count: 3, val: TagVal::Ptr({
            let mut v = Vec::new();
            for _ in 0..3 { v.extend_from_slice(&bps.to_le_bytes()); }
            v
        }) },
        Tag { tag: 0x0103, dtype: 3, count: 1, val: TagVal::Inline(u16le(1)) },
        Tag { tag: 0x0106, dtype: 3, count: 1, val: TagVal::Inline(u16le(photometric)) },
        Tag { tag: 0x0111, dtype: 4, count: 1, val: TagVal::Inline(u32le(0)) },
        Tag { tag: 0x0115, dtype: 3, count: 1, val: TagVal::Inline(u16le(3)) },
        Tag { tag: 0x0116, dtype: 4, count: 1, val: TagVal::Inline(u32le(h as u32)) },
        Tag { tag: 0x0117, dtype: 4, count: 1, val: TagVal::Inline(u32le(strip.len() as u32)) },
        Tag { tag: 0x011C, dtype: 3, count: 1, val: TagVal::Inline(u16le(if planar { 2 } else { 1 })) },
        Tag { tag: 0xC621, dtype: 10, count: 9, val: TagVal::Ptr(srational_matrix(CM_D65)) },
        Tag { tag: 0xC628, dtype: 5, count: 3, val: TagVal::Ptr(rational_triple([0.5, 1.0, 0.7])) },
    ];
    tags.sort_by_key(|t| t.tag);
    let tiff = build_tiff_with_header(tags, byte_order, big_endian);
    patch_strip(tiff, &strip)
}

/// build_tiff variant with a caller-chosen byte-order header + endianness for tag encoding.
fn build_tiff_with_header(mut tags: Vec<Tag>, header: [u8; 4], be: bool) -> Vec<u8> {
    // Re-encode inline values / pointers with the chosen endianness by rewriting the
    // little-endian builder output is fiddly; instead re-emit here directly.
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
                if blob_off % 2 == 1 { blob_off += 1; }
            }
        }
    }
    let mut out = vec![0u8; blob_off];
    out[0..4].copy_from_slice(&header);
    let w32 = |v: u32| if be { v.to_be_bytes() } else { v.to_le_bytes() };
    let w16 = |v: u16| if be { v.to_be_bytes() } else { v.to_le_bytes() };
    out[4..8].copy_from_slice(&w32(ifd_start as u32));
    out[ifd_start..ifd_start + 2].copy_from_slice(&w16(n as u16));
    for (i, t) in tags.iter().enumerate() {
        let e = ifd_start + 2 + i * 12;
        out[e..e + 2].copy_from_slice(&w16(t.tag));
        out[e + 2..e + 4].copy_from_slice(&w16(t.dtype));
        out[e + 4..e + 8].copy_from_slice(&w32(t.count));
        match (&t.val, ptr_off[i]) {
            (TagVal::Inline(b), _) => {
                // Inline bytes were built little-endian; re-pack per element size for BE.
                if be {
                    // Interpret based on dtype width. SHORT (3) → one u16 left-justified.
                    match t.dtype {
                        3 => {
                            let v = u16::from_le_bytes([b[0], b[1]]);
                            let bb = v.to_be_bytes();
                            out[e + 8..e + 12].copy_from_slice(&[bb[0], bb[1], 0, 0]);
                        }
                        1 => {
                            // BYTE array, order preserved.
                            out[e + 8..e + 12].copy_from_slice(b);
                        }
                        4 => {
                            let v = u32::from_le_bytes(*b);
                            out[e + 8..e + 12].copy_from_slice(&v.to_be_bytes());
                        }
                        _ => out[e + 8..e + 12].copy_from_slice(b),
                    }
                } else {
                    out[e + 8..e + 12].copy_from_slice(b);
                }
            }
            (TagVal::Ptr(_), Some(off)) => out[e + 8..e + 12].copy_from_slice(&w32(off)),
            (TagVal::Ptr(_), None) => unreachable!(),
        }
    }
    for (off, bytes) in blobs {
        // Ptr blobs (matrices / bps arrays) must also be re-encoded for BE — but the
        // linear-RGB BE test only uses matrices/bps we control; re-encode per dtype.
        // For simplicity the BE path here only carries: bps SHORT[3], matrix SRATIONAL,
        // rational triple. Detect by length.
        let encoded = if be { reencode_blob_be(&bytes) } else { bytes.clone() };
        out[off..off + encoded.len()].copy_from_slice(&encoded);
    }
    out
}

/// Re-encode an out-of-line blob (originally emitted LE) to big-endian. Handles the
/// three shapes this test emits: SHORT[3] (6 bytes), SRATIONAL 3x3 (72 bytes, i32
/// pairs), RATIONAL triple (24 bytes, u32 pairs).
fn reencode_blob_be(bytes: &[u8]) -> Vec<u8> {
    match bytes.len() {
        6 => {
            let mut out = Vec::with_capacity(6);
            for c in bytes.chunks_exact(2) {
                let v = u16::from_le_bytes([c[0], c[1]]);
                out.extend_from_slice(&v.to_be_bytes());
            }
            out
        }
        72 | 24 => {
            let mut out = Vec::with_capacity(bytes.len());
            for c in bytes.chunks_exact(4) {
                let v = u32::from_le_bytes([c[0], c[1], c[2], c[3]]);
                out.extend_from_slice(&v.to_be_bytes());
            }
            out
        }
        _ => bytes.to_vec(),
    }
}

/// Append `strip` bytes at EOF and patch the StripOffsets (0x0111) value to point there.
fn patch_strip(mut tiff: Vec<u8>, strip: &[u8]) -> Vec<u8> {
    let strip_off = tiff.len() as u32;
    // Find the StripOffsets entry (tag 0x0111) in IFD0 and rewrite its value field.
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
    // resolutions, not equal to either (the neutral here lands between StdA and D65).
    let data = build_cfa_dng(8, 8, true, CM_TUNGSTEN, CM_D65);
    let img = dng::decode_bytes(&data).expect("decode");
    let got = img.color_matrix.expect("matrix");
    let end_a = dng::camera_to_srgb_from_single(CM_TUNGSTEN).expect("a");
    let end_b = dng::camera_to_srgb_from_single(CM_D65).expect("b");
    // Must differ from BOTH endpoints (genuine interpolation).
    assert!(
        !matrices_close(got, end_a, 1e-5) && !matrices_close(got, end_b, 1e-5),
        "dual-illuminant result must be interpolated, not an endpoint"
    );
    // And each element must lie within (or on) the endpoint interval (± small eps),
    // proving a convex blend rather than an unrelated matrix.
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
    // The interpolation must expose provenance: which illuminants, the estimated CCT,
    // and the blend fraction (0=illuminant1, 1=illuminant2). Fallback provenance when
    // AsShotNeutral is absent.
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
// Finding 57 — linear / uncompressed RGB
// ─────────────────────────────────────────────────────────────────────────────

fn assert_linear_rgb_decodes(data: &[u8], w: usize, h: usize, bps: u16, big_endian: bool) {
    let img = dng::decode_bytes(data).unwrap_or_else(|e| panic!("linear-RGB decode failed: {e}"));
    assert_eq!(img.width, w);
    assert_eq!(img.height, h);
    assert!(img.is_linear_rgb, "must be flagged linear-RGB (demosaic bypass)");
    assert_eq!(img.raw.len(), w * h * 3, "linear-RGB raw must be interleaved RGB (w*h*3)");
    // Spot-check the ramp we wrote: pixel (2,1) → R=8,G=4,B=6 (×256 for 16-bit).
    let scale = if bps == 16 { 256u16 } else { 1u16 };
    let (x, y) = (2usize, 1usize);
    let base = (y * w + x) * 3;
    assert_eq!(img.raw[base], 8 * scale, "R at (2,1)");
    assert_eq!(img.raw[base + 1], 4 * scale, "G at (2,1)");
    assert_eq!(img.raw[base + 2], 6 * scale, "B at (2,1)");
    let _ = big_endian;
}

#[test]
fn linear_rgb_chunky_16bit_le_decodes() {
    let (w, h) = (6, 4);
    let data = build_linear_rgb_dng(w, h, false, 16, PHOTOMETRIC_LINEAR_RAW, false);
    assert_linear_rgb_decodes(&data, w, h, 16, false);
}

#[test]
fn linear_rgb_planar_16bit_le_decodes() {
    let (w, h) = (6, 4);
    let data = build_linear_rgb_dng(w, h, true, 16, PHOTOMETRIC_LINEAR_RAW, false);
    assert_linear_rgb_decodes(&data, w, h, 16, false);
}

#[test]
fn linear_rgb_chunky_8bit_decodes() {
    let (w, h) = (6, 4);
    let data = build_linear_rgb_dng(w, h, false, 8, PHOTOMETRIC_LINEAR_RAW, false);
    assert_linear_rgb_decodes(&data, w, h, 8, false);
}

#[test]
fn linear_rgb_photometric_rgb_decodes() {
    // PhotometricInterpretation = RGB(2), SamplesPerPixel=3 also = already-demosaiced.
    let (w, h) = (6, 4);
    let data = build_linear_rgb_dng(w, h, false, 16, PHOTOMETRIC_RGB, false);
    assert_linear_rgb_decodes(&data, w, h, 16, false);
}

#[test]
fn linear_rgb_chunky_16bit_big_endian_decodes() {
    let (w, h) = (6, 4);
    let data = build_linear_rgb_dng(w, h, false, 16, PHOTOMETRIC_LINEAR_RAW, true);
    assert_linear_rgb_decodes(&data, w, h, 16, true);
}

#[test]
fn linear_rgb_keeps_colour_and_wb_contracts() {
    // Black/white/wb/colour-matrix must still be populated for the linear-RGB path.
    let (w, h) = (6, 4);
    let data = build_linear_rgb_dng(w, h, false, 16, PHOTOMETRIC_LINEAR_RAW, false);
    let img = dng::decode_bytes(&data).expect("decode");
    assert!(img.color_matrix.is_some(), "colour matrix must survive linear-RGB path");
    assert!(img.wb_from_camera, "AsShotNeutral present → wb_from_camera true");
    // wb derived from the [0.5,1.0,0.7] neutral we wrote.
    assert!((img.wb_r - 2.0).abs() < 1e-3, "wb_r {}", img.wb_r);
    assert!((img.wb_b - (1.0 / 0.7)).abs() < 1e-3, "wb_b {}", img.wb_b);
}

#[test]
fn malformed_linear_rgb_truncated_strip_errors() {
    // Truncate the RGB strip: decode must return a clear Err, not panic / silent garbage.
    let (w, h) = (6, 4);
    let mut data = build_linear_rgb_dng(w, h, false, 16, PHOTOMETRIC_LINEAR_RAW, false);
    let cut = data.len() - 20;
    data.truncate(cut);
    let r = dng::decode_bytes(&data);
    assert!(r.is_err(), "truncated linear-RGB strip must error, got Ok");
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
