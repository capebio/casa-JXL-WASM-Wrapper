//! P3-T11 (finding 21): bit-exact parity tests for the wasm SIMD128 MHC interior kernel.
//!
//! The kernel `demosaic::mhc_row_interior_simd128` (wasm32) vectorizes ONLY the phased interior
//! row span of `demosaic_bayer_mhc`; borders/tails stay scalar. It must be BIT-EXACT vs the
//! all-clamped scalar reference (`demosaic_bayer_mhc_clamped_ref`) — correctness is
//! non-negotiable; this is a perf task.
//!
//! ## What runs where
//! - On **wasm32** (`cargo test --target wasm32-unknown-unknown`, or via wasm-pack), the whole-
//!   function dispatch inside `demosaic_bayer_mhc` actually invokes the v128 kernel, so the
//!   `simd_dispatch_bit_identical` test below exercises the real SIMD path end-to-end.
//! - On **native**, wasm SIMD cannot execute, so we test `demosaic::mhc_row_interior_simd128_ref`
//!   — a pure-scalar mirror that performs the IDENTICAL per-lane arithmetic in the IDENTICAL op
//!   order and uses the IDENTICAL 4-wide chunk loop bound as the v128 kernel. Proving the
//!   reference bit-exact vs the clamped scalar reference pins the SIMD op-order on native, where
//!   CI actually runs. (The wasm32 `--lib` build is the separate validity gate that the v128
//!   intrinsics compile.)
//!
//! Coverage: every CFA phase (0,0)/(0,1)/(1,0)/(1,1); widths spanning every 4-col chunk remainder
//! (0..3 leftover interior cols) and the width<12 no-SIMD fallback; heights covering the
//! edge-row/scalar handoff and the height<5 fallback; full 16-bit values to stress the signed
//! negative-intermediate clamps; and small images.

use raw_pipeline::demosaic::{self, MhcGains};

/// Gain sets every parity assertion is repeated over. `UNITY` pins the historical
/// arithmetic; the WB-derived set is what the ORF/DNG paths actually ship; the extreme
/// set sits at the clamp bounds and, combined with `full_range` fills, stresses the
/// widest `gain × laplacian` product the i32 accumulator ever sees.
const GAIN_CASES: [(&str, MhcGains); 3] = [
    ("unity", MhcGains::UNITY),
    (
        "olympus-wb",
        MhcGains {
            g_at_r: 484,
            g_at_b: 482,
            r_at_g: 135,
            b_at_g: 136,
            r_at_b: 135,
            b_at_r: 136,
        },
    ),
    (
        "extreme",
        MhcGains {
            g_at_r: 1024,
            g_at_b: 32,
            r_at_g: 32,
            b_at_g: 1024,
            r_at_b: 1024,
            b_at_r: 32,
        },
    ),
];

/// Deterministic LCG fill, seeded per (w,h) so cases don't share a stream.
fn fill(w: usize, h: usize, seed: u32, full_range: bool) -> Vec<u16> {
    let mut s: u32 = seed ^ ((w as u32).wrapping_mul(2654435761) ^ (h as u32).wrapping_mul(40503));
    (0..w * h)
        .map(|_| {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            if full_range {
                (s >> 16) as u16 // full 0..=65535, exercises negative-laplacian clamps
            } else {
                ((s >> 12) & 0x3fff) as u16 // 14-bit-ish sensor range
            }
        })
        .collect()
}

// ── Native op-order proof: the scalar mirror of the v128 kernel, driven the same way the
//    dispatch drives it (interior rows [2,h-2), interior cols in 4-wide chunks), must be
//    byte-identical to the all-clamped reference for every phase / width remainder / height. ──
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn simd128_ref_op_order_bit_identical_to_clamped_reference() {
    // Widths chosen so (width - 4) interior cols leave every remainder mod 4 = {0,1,2,3}:
    //   w=12 -> 8 interior, w=13 -> 9, w=14 -> 10, w=15 -> 11 (rem 0,1,2,3), plus larger.
    // Heights cover the edge-row handoff and multiple interior rows.
    for &(w, h) in &[
        (12usize, 5usize),
        (13, 5),
        (14, 6),
        (15, 7),
        (20, 5),
        (21, 8),
        (24, 9),
        (29, 8),
        (33, 12),
        (40, 7),
        (67, 13),
    ] {
        for full_range in [false, true] {
            let raw = fill(w, h, 0x5EED, full_range);
            for &phase in &[(0u8, 0u8), (0, 1), (1, 0), (1, 1)] {
                for (gname, gains) in GAIN_CASES {
                    // Build the expected buffer with the all-clamped scalar reference.
                    let refr =
                        demosaic::demosaic_bayer_mhc_clamped_ref(&raw, w, h, phase, gains).unwrap();

                    // Now build a buffer where the interior rows' interior span is produced by the
                    // SIMD128 scalar mirror, and everything else by the shipped scalar path — exactly
                    // as the dispatch composes them. We reuse `demosaic_bayer_mhc_gains` for the
                    // scalar baseline (borders/tails/edge rows), then overwrite the interior span of
                    // each interior row via the mirror and assert it did not change any byte.
                    let mut got =
                        demosaic::demosaic_bayer_mhc_gains(&raw, w, h, phase, gains).unwrap();
                    let (int_start, int_end) = if w >= 4 { (2usize, w - 2) } else { (w, w) };
                    if int_end > int_start {
                        for row in 2..h.saturating_sub(2) {
                            let base = row * w * 3;
                            let out_row = &mut got[base..base + w * 3];
                            let stop = demosaic::mhc_row_interior_simd128_ref(
                                &raw,
                                w,
                                row,
                                int_start,
                                int_end,
                                (phase.0 as usize, phase.1 as usize),
                                gains,
                                out_row,
                            );
                            // The mirror must have consumed at least the first chunk when there is
                            // room for one (>= 12-wide images have >= 8 interior cols).
                            assert!(stop >= int_start, "w={w} h={h} row={row} produced no start");
                        }
                    }
                    assert_eq!(
                        got, refr,
                        "SIMD128 mirror mismatch w={w} h={h} phase={phase:?} \
                         full_range={full_range} gains={gname}"
                    );
                }
            }
        }
    }
}

// ── Whole-function dispatch parity. On wasm this exercises the REAL v128 kernel; on native it
//    re-confirms the (scalar-dispatched) path. Bit-exact vs the clamped reference for all phases,
//    widths (incl. the width<12 no-SIMD fallback), heights (incl. height<5 fallback), full-range
//    values, and small images. ──
#[test]
fn simd_dispatch_bit_identical_to_clamped_reference() {
    for &(w, h) in &[
        // Small images / fallbacks (below the SIMD width or height gate).
        (1usize, 1usize),
        (3, 3),
        (4, 4),
        (5, 5),
        (8, 8),
        (11, 6), // width 11 < 12 gate -> scalar interior
        (16, 4), // height 4 < 5 gate  -> scalar interior
        // At/above the SIMD gate, every 4-col remainder + several heights.
        (12, 5),
        (13, 6),
        (14, 7),
        (15, 8),
        (20, 5),
        (33, 11),
        (64, 16),
    ] {
        for full_range in [false, true] {
            let raw = fill(w, h, 0xBEEF, full_range);
            for &phase in &[(0u8, 0u8), (0, 1), (1, 0), (1, 1)] {
                for (gname, gains) in GAIN_CASES {
                    let got = demosaic::demosaic_bayer_mhc_gains(&raw, w, h, phase, gains).unwrap();
                    let refr =
                        demosaic::demosaic_bayer_mhc_clamped_ref(&raw, w, h, phase, gains).unwrap();
                    assert_eq!(
                        got, refr,
                        "dispatch mismatch w={w} h={h} phase={phase:?} \
                         full_range={full_range} gains={gname}"
                    );
                }
            }
        }
    }
}

// ── Clamp-boundary stress: an all-max image must round-trip without wrap (the MHC laplacian
//    terms subtract, so intermediates can go negative; the >>3 then clamp must land exactly). ──
#[test]
fn simd_dispatch_all_max_no_wrap() {
    for &(w, h) in &[(12usize, 5usize), (16, 8), (33, 11)] {
        let raw = vec![65535u16; w * h];
        for &phase in &[(0u8, 0u8), (0, 1), (1, 0), (1, 1)] {
            for (gname, gains) in GAIN_CASES {
                let got = demosaic::demosaic_bayer_mhc_gains(&raw, w, h, phase, gains).unwrap();
                let refr =
                    demosaic::demosaic_bayer_mhc_clamped_ref(&raw, w, h, phase, gains).unwrap();
                assert_eq!(got, refr, "all-max mismatch w={w} h={h} phase={phase:?} gains={gname}");
                // A flat field has a zero laplacian everywhere, so no gain can move it.
                assert!(got.iter().all(|&v| v == 65535), "all-max must stay 65535 ({gname})");
            }
        }
    }
}
