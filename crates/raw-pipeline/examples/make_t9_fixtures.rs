//! P3-T9 colour sign-off: emit SYNTHETIC DNG fixtures (dual-illuminant, single-matrix,
//! linear-RGB) to a directory so BOTH the origin/main (BEFORE) and branch (AFTER)
//! worktrees render byte-identical INPUT, isolating the colour change to the code.
//!
//! Also copies the one real dual-illuminant Pixel DNG in if present.
//!
//! Usage: cargo run --release --example make_t9_fixtures -- <out_dir>
//!
//! Emitted files (all little-endian single-SubIFD DNGs unless noted):
//!   synth_single_matrix.dng      — ColorMatrix1 only (must be ZERO-drift)
//!   synth_dual_illuminant.dng    — ColorMatrix1/2 + illuminant1/2 (WILL drift)
//!   synth_linear_rgb_chunky.dng  — LinearRaw RGB, chunky 16-bit (newly supported)
//!   synth_linear_rgb_planar.dng  — LinearRaw RGB, planar 16-bit (newly supported)

use std::path::Path;

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
fn rational_triple(v: [f32; 3]) -> Vec<u8> {
    let mut out = Vec::with_capacity(24);
    for x in v {
        let num = (x * 100000.0).round() as u32;
        out.extend_from_slice(&num.to_le_bytes());
        out.extend_from_slice(&100000u32.to_le_bytes());
    }
    out
}
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
fn patch_strip(mut tiff: Vec<u8>, strip: &[u8]) -> Vec<u8> {
    let strip_off = tiff.len() as u32;
    let ifd0 = u32::from_le_bytes([tiff[4], tiff[5], tiff[6], tiff[7]]) as usize;
    let n = u16::from_le_bytes([tiff[ifd0], tiff[ifd0 + 1]]) as usize;
    for i in 0..n {
        let e = ifd0 + 2 + i * 12;
        if u16::from_le_bytes([tiff[e], tiff[e + 1]]) == 0x0111 {
            tiff[e + 8..e + 12].copy_from_slice(&strip_off.to_le_bytes());
        }
    }
    tiff.extend_from_slice(strip);
    tiff
}

const IL_STD_A: u16 = 17;
const IL_D65: u16 = 21;
const CM_D65: [[f32; 3]; 3] = [[0.85, 0.05, 0.05], [-0.10, 1.05, 0.05], [0.02, -0.15, 1.10]];
const CM_TUNGSTEN: [[f32; 3]; 3] = [[0.70, 0.10, 0.10], [-0.05, 0.95, 0.10], [0.05, -0.25, 1.25]];

/// A deterministic 64x48 RGGB Bayer sensor mosaic with a smooth colour gradient so the
/// rendered thumbnail actually shows colour (not flat grey) → visible drift in the sheet.
fn cfa_strip(w: usize, h: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(w * h * 2);
    for y in 0..h {
        for x in 0..w {
            // Rough RGGB: brighten toward corners to give the matrix something to act on.
            let base = 2000i32 + (x as i32 * 60) + (y as i32 * 40);
            let v = (base.clamp(0, 16383)) as u16;
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    out
}

fn build_cfa_dng(dual: bool) -> Vec<u8> {
    let (w, h) = (64usize, 48usize);
    let strip = cfa_strip(w, h);
    let mut tags = vec![
        Tag { tag: 0x0100, dtype: 3, count: 1, val: TagVal::Inline(u16le(w as u16)) },
        Tag { tag: 0x0101, dtype: 3, count: 1, val: TagVal::Inline(u16le(h as u16)) },
        Tag { tag: 0x0102, dtype: 3, count: 1, val: TagVal::Inline(u16le(16)) },
        Tag { tag: 0x0103, dtype: 3, count: 1, val: TagVal::Inline(u16le(1)) },
        Tag { tag: 0x0106, dtype: 3, count: 1, val: TagVal::Inline(u16le(32803)) },
        Tag { tag: 0x0111, dtype: 4, count: 1, val: TagVal::Inline(u32le(0)) },
        Tag { tag: 0x0115, dtype: 3, count: 1, val: TagVal::Inline(u16le(1)) },
        Tag { tag: 0x0116, dtype: 4, count: 1, val: TagVal::Inline(u32le(h as u32)) },
        Tag { tag: 0x0117, dtype: 4, count: 1, val: TagVal::Inline(u32le(strip.len() as u32)) },
        Tag { tag: 0x828E, dtype: 1, count: 4, val: TagVal::Inline([0, 1, 1, 2]) },
        Tag { tag: 0xC621, dtype: 10, count: 9, val: TagVal::Ptr(srational_matrix(CM_TUNGSTEN)) },
        Tag { tag: 0xC628, dtype: 5, count: 3, val: TagVal::Ptr(rational_triple([0.55, 1.0, 0.75])) },
        Tag { tag: 0xC65A, dtype: 3, count: 1, val: TagVal::Inline(u16le(IL_STD_A)) },
    ];
    if dual {
        tags.push(Tag { tag: 0xC622, dtype: 10, count: 9, val: TagVal::Ptr(srational_matrix(CM_D65)) });
        tags.push(Tag { tag: 0xC65B, dtype: 3, count: 1, val: TagVal::Inline(u16le(IL_D65)) });
    }
    patch_strip(build_tiff(tags), &strip)
}

fn build_linear_rgb_dng(planar: bool) -> Vec<u8> {
    let (w, h) = (64usize, 48usize);
    // 16-bit RGB ramp with real colour variation.
    let px = |x: usize, y: usize, c: usize| -> u16 {
        let v = match c {
            0 => (x * 900) as u32,
            1 => (y * 1100) as u32,
            _ => ((x + y) * 500) as u32,
        };
        v.min(0xffff) as u16
    };
    let mut strip: Vec<u8> = Vec::new();
    if planar {
        for c in 0..3 {
            for y in 0..h {
                for x in 0..w {
                    strip.extend_from_slice(&px(x, y, c).to_le_bytes());
                }
            }
        }
    } else {
        for y in 0..h {
            for x in 0..w {
                for c in 0..3 {
                    strip.extend_from_slice(&px(x, y, c).to_le_bytes());
                }
            }
        }
    }
    let bps_blob = {
        let mut v = Vec::new();
        for _ in 0..3 {
            v.extend_from_slice(&16u16.to_le_bytes());
        }
        v
    };
    let tags = vec![
        Tag { tag: 0x0100, dtype: 3, count: 1, val: TagVal::Inline(u16le(w as u16)) },
        Tag { tag: 0x0101, dtype: 3, count: 1, val: TagVal::Inline(u16le(h as u16)) },
        Tag { tag: 0x0102, dtype: 3, count: 3, val: TagVal::Ptr(bps_blob) },
        Tag { tag: 0x0103, dtype: 3, count: 1, val: TagVal::Inline(u16le(1)) },
        Tag { tag: 0x0106, dtype: 3, count: 1, val: TagVal::Inline(u16le(34892)) },
        Tag { tag: 0x0111, dtype: 4, count: 1, val: TagVal::Inline(u32le(0)) },
        Tag { tag: 0x0115, dtype: 3, count: 1, val: TagVal::Inline(u16le(3)) },
        Tag { tag: 0x0116, dtype: 4, count: 1, val: TagVal::Inline(u32le(h as u32)) },
        Tag { tag: 0x0117, dtype: 4, count: 1, val: TagVal::Inline(u32le(strip.len() as u32)) },
        Tag { tag: 0x011C, dtype: 3, count: 1, val: TagVal::Inline(u16le(if planar { 2 } else { 1 })) },
        Tag { tag: 0xC621, dtype: 10, count: 9, val: TagVal::Ptr(srational_matrix(CM_D65)) },
        Tag { tag: 0xC628, dtype: 5, count: 3, val: TagVal::Ptr(rational_triple([0.55, 1.0, 0.75])) },
    ];
    patch_strip(build_tiff(tags), &strip)
}

fn main() {
    let out_dir = std::env::args().nth(1).expect("arg: out dir");
    let out = Path::new(&out_dir);
    std::fs::create_dir_all(out).unwrap();
    let write = |name: &str, bytes: Vec<u8>| {
        let p = out.join(name);
        std::fs::write(&p, &bytes).unwrap();
        println!("wrote {} ({} bytes)", p.display(), bytes.len());
    };
    write("synth_single_matrix.dng", build_cfa_dng(false));
    write("synth_dual_illuminant.dng", build_cfa_dng(true));
    write("synth_linear_rgb_chunky.dng", build_linear_rgb_dng(false));
    write("synth_linear_rgb_planar.dng", build_linear_rgb_dng(true));

    // Copy the real dual-illuminant Pixel DNG in, if available.
    for real in [
        r"C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
    ] {
        if let Ok(d) = std::fs::read(real) {
            write("real_pixel_dual_illuminant.dng", d);
        } else {
            eprintln!("note: real DNG {real} not found (skipping)");
        }
    }
}
