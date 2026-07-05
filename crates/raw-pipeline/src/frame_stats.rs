//! Native frame-stats telemetry kernel (server / batch path; e.g. time-lapse triage).
//! RGBA8 single-pass reduction: alpha min/max, alpha-zero count, rgb-nonzero count,
//! luma mean/variance accumulators, and an 8-lane word-hash (content-change id).
//! Parallels the wasm `frame_stats` kernel in raw-converter-wasm/src/lib.rs, but the two
//! are *independent contracts*: the wasm kernel accumulates luma in plain f64 to byte-match
//! the JS `analyzeProgressiveFrame` reference (JS numbers are f64), while this native/batch
//! kernel accumulates luma in exact u64 (see FS-D1 below) and converts once at the end. They
//! are not required to be bit-identical to each other and aren't past ~6 MP — do not "sync"
//! them by porting u64 into the wasm kernel; that would break the wasm↔JS byte contract.
//!
//! FS-D1: luma is integer (`54r+183g+18b ≤ 65025`, so `luma² ≤ 4.23e9`). Summed in u64 it is
//! exact to ~4.3 gigapixels (luma_sq) / ~2.8e14 px (luma_sum) — beyond any addressable RGBA
//! buffer — so no Kahan compensation is needed and `analyze_scalar`/`analyze_avx2` are
//! bit-identical for *every* input (not just well-conditioned ones). The public `luma_sum`/
//! `luma_sq` stay f64 (the exact integer rounded once to nearest f64).
//!
//! Here the server can use AVX2 (256-bit). scalar and avx2 produce bit-identical results.
//!
//! Use for batch/time-lapse: frameHash (near-duplicate / change detection), mean_luma
//! (exposure/lighting trajectory), luma_variance (detail/contrast over time).

const PRIME: u32 = 0x0100_0193;
const OFFSET: u32 = 0x811c_9dc5;

#[inline]
fn lane_seed(k: u32) -> u32 {
    OFFSET ^ k.wrapping_mul(0x9e37_79b9)
}

#[inline]
fn combine_lanes(lanes: &[u32; 8]) -> u32 {
    let mut h = OFFSET;
    for &l in lanes.iter() {
        h = (h ^ l).wrapping_mul(PRIME);
    }
    h
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameStats {
    pub alpha_min: u32,
    pub alpha_max: u32,
    /// Count of pixels with alpha == 0.
    pub alpha_zero: u64,
    /// Count of non-zero *channel values* (not pixels): each pixel contributes 0–3.
    /// Maximum value is `pixel_count * 3`. Named for historical compatibility.
    pub rgb_nonzero: u64,
    /// Sum of per-pixel luma values: `l = 54*r + 183*g + 18*b` (u8 inputs → max 65025/px).
    pub luma_sum: f64,
    /// Sum of squared per-pixel luma values (same units as luma_sum^2).
    pub luma_sq: f64,
    pub hash: u32,
    pub pixel_count: usize,
}

impl FrameStats {
    pub fn mean_luma(&self) -> f64 {
        if self.pixel_count == 0 {
            0.0
        } else {
            self.luma_sum / self.pixel_count as f64
        }
    }

    /// Combine two partial `FrameStats` (e.g. from parallel strips or tiles).
    /// Enables safe future parallelization of the analysis kernel without silent f64 precision loss.
    /// Hash merging XORs the two hashes — callers that require order-preserving hash chaining must
    /// combine fields directly.
    pub fn merge(self, other: FrameStats) -> FrameStats {
        FrameStats {
            alpha_min: self.alpha_min.min(other.alpha_min),
            alpha_max: self.alpha_max.max(other.alpha_max),
            alpha_zero: self.alpha_zero + other.alpha_zero,
            rgb_nonzero: self.rgb_nonzero + other.rgb_nonzero,
            luma_sum: self.luma_sum + other.luma_sum,
            luma_sq: self.luma_sq + other.luma_sq,
            hash: self.hash ^ other.hash,
            pixel_count: self.pixel_count + other.pixel_count,
        }
    }
    /// Returns luma variance scaled by 1/65025.0 (= max luma per pixel = 255×255).
    /// 0.0 = uniform frame; larger = more contrast/detail. This is a *scale*, not a
    /// [0,1] normalization: variance peaks at 65025²/4 (a half-black/half-white frame),
    /// so the result can reach ~16256.25. Keep this divisor in lock-step with the WASM
    /// `frame_stats` mirror — changing it here alone would desync cross-target telemetry.
    pub fn luma_variance(&self) -> f64 {
        if self.pixel_count == 0 {
            return 0.0;
        }
        let m = self.mean_luma();
        ((self.luma_sq / self.pixel_count as f64) - m * m).max(0.0) / 65025.0
    }
}

/// Portable scalar kernel. 8-lane word-hash (matches AVX2). Tail-safe.
pub fn analyze_scalar(d: &[u8], px: usize) -> FrameStats {
    // Bounds guard: clamp pixel count so we never index past the slice.
    // For valid full-length input (d.len() >= px*4) this is a no-op; only
    // undersized/malformed input is affected (avoids an OOB index panic).
    let px = px.min(d.len() / 4);
    let (mut a_min, mut a_max, mut a_zero, mut rgb_nz) = (255u32, 0u32, 0u64, 0u64);
    // FS-D1: exact u64 luma accumulation (no Kahan — see module header). Bit-identical
    // to analyze_avx2 for every input because both sum the same exact integers.
    let (mut l_sum, mut l_sq) = (0u64, 0u64);
    let mut lanes = [
        lane_seed(0),
        lane_seed(1),
        lane_seed(2),
        lane_seed(3),
        lane_seed(4),
        lane_seed(5),
        lane_seed(6),
        lane_seed(7),
    ];
    // FS-003: iterate whole RGBA words via chunks_exact(4) — one bounds-checked word
    // load per pixel instead of four byte loads plus a redundant from_le_bytes re-read.
    for (p, px4) in d[..px * 4].chunks_exact(4).enumerate() {
        let w = u32::from_le_bytes([px4[0], px4[1], px4[2], px4[3]]);
        lanes[p & 7] = (lanes[p & 7] ^ w).wrapping_mul(PRIME);
        let r = w & 0xff;
        let g = (w >> 8) & 0xff;
        let b = (w >> 16) & 0xff;
        let a = w >> 24;
        rgb_nz += (r != 0) as u64 + (g != 0) as u64 + (b != 0) as u64;
        if a < a_min {
            a_min = a;
        }
        if a > a_max {
            a_max = a;
        }
        if a == 0 {
            a_zero += 1;
        }
        let l = (54 * r + 183 * g + 18 * b) as u64; // ≤ 65025
        l_sum += l;
        l_sq += l * l; // ≤ 4.23e9 per px; u64 exact to ~4.3 Gpx
    }
    // px == 0 ⇒ the loop body never runs, so a_min/a_max keep their 255/0 init.
    FrameStats {
        alpha_min: a_min,
        alpha_max: a_max,
        alpha_zero: a_zero,
        rgb_nonzero: rgb_nz,
        luma_sum: l_sum as f64,
        luma_sq: l_sq as f64,
        hash: combine_lanes(&lanes),
        pixel_count: px,
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
/// # Safety
/// Caller must ensure `d.len() >= px * 4` and that AVX2 is available.
/// The function reads `(px / 8) * 32` bytes in the SIMD loop and then
/// `(px % 8) * 4` bytes in the scalar tail — both within `d[..px*4]`.
unsafe fn analyze_avx2(d: &[u8], px: usize) -> FrameStats {
    use core::arch::x86_64::*;

    // Guard: clamp px so the SIMD loop never reads past d.
    let px = px.min(d.len() / 4);
    let chunks = px / 8; // 8 px = 32 bytes per __m256i
    let (mut a_zero, mut rgb_nz) = (0u64, 0u64);
    // FS-D1: exact u64 luma accumulation (no Kahan — see module header).
    let (mut l_sum, mut l_sq) = (0u64, 0u64);

    let mut hv = _mm256_setr_epi32(
        lane_seed(0) as i32,
        lane_seed(1) as i32,
        lane_seed(2) as i32,
        lane_seed(3) as i32,
        lane_seed(4) as i32,
        lane_seed(5) as i32,
        lane_seed(6) as i32,
        lane_seed(7) as i32,
    );
    let prime_v = _mm256_set1_epi32(PRIME as i32);

    let rgb_or = _mm256_set1_epi32(0x00FF_FFFFu32 as i32); // r,g,b -> 0xff, a -> 0x00
    let alpha_and = _mm256_set1_epi32(0xFF00_0000u32 as i32); // a kept, r,g,b -> 0
    let mut vmin = _mm256_set1_epi8(-1); // 0xff
    let mut vmax = _mm256_setzero_si256();
    let zero = _mm256_setzero_si256();

    let wv = _mm256_set_epi16(
        0, 18, 183, 54, 0, 18, 183, 54, 0, 18, 183, 54, 0, 18, 183, 54,
    );

    for c in 0..chunks {
        let pv = _mm256_loadu_si256(d.as_ptr().add(c * 32) as *const __m256i);

        hv = _mm256_mullo_epi32(_mm256_xor_si256(hv, pv), prime_v);

        vmin = _mm256_min_epu8(vmin, _mm256_or_si256(pv, rgb_or));
        vmax = _mm256_max_epu8(vmax, _mm256_and_si256(pv, alpha_and));

        let zmask = _mm256_movemask_epi8(_mm256_cmpeq_epi8(pv, zero)) as u32;
        a_zero += (zmask & 0x8888_8888).count_ones() as u64;
        rgb_nz += 24 - (zmask & 0x7777_7777).count_ones() as u64;

        // FS-003: register-only luma reduction (supersedes FS-001/FS-002's stack path).
        // madd→hadd packs the 8 per-pixel luma values into one vector — permuted, but
        // order is irrelevant for a sum / sum-of-squares — then we reduce in registers.
        // Removes the 64-byte stack store + 16 scalar reloads + two iterator passes per
        // chunk (a store-to-load forwarding stall). chunk_sum / chunk_sq_sum are the SAME
        // exact integers as the old array path, so l_sum / l_sq stay bit-identical.
        let lo16 = _mm256_cvtepu8_epi16(_mm256_castsi256_si128(pv));
        let hi16 = _mm256_cvtepu8_epi16(_mm256_extracti128_si256(pv, 1));
        // Each madd pairs (54r+183g, 18b); hadd folds the pair → full per-pixel luma.
        let luma_v = _mm256_hadd_epi32(_mm256_madd_epi16(lo16, wv), _mm256_madd_epi16(hi16, wv));

        // chunk_sum = Σ luma  (≤ 8 × 65025 = 520200, fits i32).
        let s4 = _mm_add_epi32(
            _mm256_castsi256_si128(luma_v),
            _mm256_extracti128_si256(luma_v, 1),
        );
        let s2 = _mm_hadd_epi32(s4, s4);
        let s1 = _mm_hadd_epi32(s2, s2);
        let chunk_sum = _mm_cvtsi128_si32(s1) as u32 as i64;

        // chunk_sq_sum = Σ luma². Each luma² ≤ 65025² ≈ 4.23e9 fits u32 (mullo's low 32
        // bits are exact); widen UNSIGNED before the 8-way sum (≤ 3.4e10 needs 64-bit).
        let sq32 = _mm256_mullo_epi32(luma_v, luma_v);
        let sq64 = _mm256_add_epi64(
            _mm256_cvtepu32_epi64(_mm256_castsi256_si128(sq32)),
            _mm256_cvtepu32_epi64(_mm256_extracti128_si256(sq32, 1)),
        );
        let sq2 = _mm_add_epi64(
            _mm256_castsi256_si128(sq64),
            _mm256_extracti128_si256(sq64, 1),
        );
        let sq1 = _mm_add_epi64(sq2, _mm_unpackhi_epi64(sq2, sq2));
        let chunk_sq_sum = _mm_cvtsi128_si64(sq1);

        l_sum += chunk_sum as u64; // chunk_sum ≥ 0 (≤ 520200)
        l_sq += chunk_sq_sum as u64; // chunk_sq_sum ≥ 0 (≤ 3.4e10)
    }

    let mut mins = [0u8; 32];
    let mut maxs = [0u8; 32];
    _mm256_storeu_si256(mins.as_mut_ptr() as *mut __m256i, vmin);
    _mm256_storeu_si256(maxs.as_mut_ptr() as *mut __m256i, vmax);
    let mut a_min = 255u32;
    let mut a_max = 0u32;
    let mut k = 3;
    while k < 32 {
        if (mins[k] as u32) < a_min {
            a_min = mins[k] as u32;
        }
        if (maxs[k] as u32) > a_max {
            a_max = maxs[k] as u32;
        }
        k += 4;
    }

    let mut lanes = [0u32; 8];
    _mm256_storeu_si256(lanes.as_mut_ptr() as *mut __m256i, hv);

    for p in (chunks * 8)..px {
        let i = p * 4;
        let r = d[i] as u32;
        let g = d[i + 1] as u32;
        let b = d[i + 2] as u32;
        let a = d[i + 3] as u32;
        let w = u32::from_le_bytes([d[i], d[i + 1], d[i + 2], d[i + 3]]);
        let lane = p & 7;
        lanes[lane] = (lanes[lane] ^ w).wrapping_mul(PRIME);
        rgb_nz += (r != 0) as u64 + (g != 0) as u64 + (b != 0) as u64;
        if a < a_min {
            a_min = a;
        }
        if a > a_max {
            a_max = a;
        }
        if a == 0 {
            a_zero += 1;
        }
        let l = (54 * r + 183 * g + 18 * b) as u64;
        l_sum += l;
        l_sq += l * l;
    }
    if px == 0 {
        a_min = 255;
        a_max = 0;
    }

    FrameStats {
        alpha_min: a_min,
        alpha_max: a_max,
        alpha_zero: a_zero,
        rgb_nonzero: rgb_nz,
        luma_sum: l_sum as f64,
        luma_sq: l_sq as f64,
        hash: combine_lanes(&lanes),
        pixel_count: px,
    }
}

/// Runtime-dispatched entry. Uses AVX2 when present, else the scalar kernel.
pub fn analyze(pixels: &[u8], width: usize, height: usize) -> FrameStats {
    // Use checked_mul so giant dimensions (e.g. from untrusted input) cannot silently saturate
    // to a wrong pixel count and cause the kernel to read stale/zeroed padding as real pixels.
    let px = match width.checked_mul(height) {
        Some(n) => n,
        None => {
            return FrameStats {
                alpha_min: 255,
                alpha_max: 0,
                alpha_zero: 0,
                rgb_nonzero: 0,
                luma_sum: 0.0,
                luma_sq: 0.0,
                hash: combine_lanes(&[
                    lane_seed(0),
                    lane_seed(1),
                    lane_seed(2),
                    lane_seed(3),
                    lane_seed(4),
                    lane_seed(5),
                    lane_seed(6),
                    lane_seed(7),
                ]),
                pixel_count: 0,
            }
        }
    };
    if pixels.len() < px.saturating_mul(4) {
        // Buffer is shorter than the declared pixel count: analyze only the complete pixels
        // actually present. Avoid zero-padding which would skew alpha_zero and luma stats
        // with phantom pixels.
        let px_actual = pixels.len() / 4;
        return analyze_scalar(pixels, px_actual);
    }
    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") {
            return unsafe { analyze_avx2(pixels, px) };
        }
    }
    analyze_scalar(pixels, px)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn mkbuf(px: usize, seed: u32) -> Vec<u8> {
        let mut d = vec![0u8; px * 4];
        let mut s = seed;
        for slot in d.iter_mut() {
            s = s.wrapping_mul(1103515245).wrapping_add(12345);
            *slot = (s & 0xff) as u8;
        }
        d
    }

    #[test]
    #[ignore] // byte-exact gate: run on OLD and NEW binaries, diff stdout (must be identical)
    fn dump_fixed() {
        for (w, h, seed) in [
            (64usize, 48usize, 1u32),
            (101, 49, 7),
            (257, 257, 3),
            (1920, 1280, 11),
            (6000, 4000, 99),
        ] {
            let buf = mkbuf(w * h, seed);
            let s = analyze(&buf, w, h);
            println!(
                "{}x{} amin={} amax={} az={} nz={} ls={:016x} lq={:016x} h={:08x} pc={}",
                w,
                h,
                s.alpha_min,
                s.alpha_max,
                s.alpha_zero,
                s.rgb_nonzero,
                s.luma_sum.to_bits(),
                s.luma_sq.to_bits(),
                s.hash,
                s.pixel_count,
            );
        }
    }

    fn assert_parity(buf: &[u8], px: usize, tag: &str) {
        let sc = analyze_scalar(buf, px);
        #[cfg(target_arch = "x86_64")]
        if is_x86_feature_detected!("avx2") {
            let av = unsafe { analyze_avx2(buf, px) };
            assert_eq!(sc, av, "scalar vs avx2 mismatch at {tag}");
        }
        #[cfg(not(target_arch = "x86_64"))]
        let _ = (sc, tag);
    }

    #[test]
    fn scalar_avx2_parity() {
        // Including 24MP: l_sq there exceeds f64's exact range, so this exercises the
        // u64 accumulation that small frames never stress (FS-D1).
        for (w, h) in [(64usize, 48usize), (101, 49), (1920, 1280), (6000, 4000)] {
            let buf = mkbuf(w * h, (w + h) as u32);
            assert_parity(&buf, w * h, &format!("{w}x{h}"));
        }
        // FS-D1 worst case: all-max luma (every byte 255 ⇒ luma=65025) at 4MP. l_sq here is
        // ~1.7e16, well past 2^53; u64 stays exact so scalar and avx2 must still agree.
        assert_parity(&vec![255u8; 2048 * 2048 * 4], 2048 * 2048, "all-max-4MP");
        // Every SIMD tail length 0..=17 (full-block boundary is 8 px): the tail must
        // restart hashing at lane 0 and match scalar exactly.
        for px in 0..=17usize {
            let buf = mkbuf(px, px as u32 + 17);
            assert_parity(&buf, px, &format!("tail-{px}"));
        }
        // Degenerate content: all-zero (alpha_zero/rgb edge) and all-opaque-white.
        assert_parity(&vec![0u8; 17 * 4], 17, "all-zero");
        assert_parity(&vec![255u8; 17 * 4], 17, "all-white");
        // Unaligned RGBA base address — AVX2 uses loadu, must stay correct.
        let mut un = vec![0x5au8];
        un.extend_from_slice(&mkbuf(17, 0x1234_5678));
        assert_parity(&un[1..], 17, "unaligned");
    }

    #[test]
    #[ignore] // run: cargo test --no-default-features --release -- --ignored --nocapture native_bench
    fn native_bench() {
        let sizes = [
            (1920usize, 1280usize, "2.46MP"),
            (1024, 1024, "1.05MP"),
            (6000, 4000, "24.0MP"),
        ];
        #[cfg(target_arch = "x86_64")]
        let has_avx2 = is_x86_feature_detected!("avx2");
        #[cfg(not(target_arch = "x86_64"))]
        let has_avx2 = false;
        println!(
            "\n=== NATIVE frame-stats: scalar vs AVX2 (min ms/call) === avx2={}",
            has_avx2
        );
        for (w, h, label) in sizes {
            let px = w * h;
            let buf = mkbuf(px, 7);
            let bench = |f: &dyn Fn() -> FrameStats| {
                for _ in 0..8 {
                    std::hint::black_box(f());
                }
                let mut best = f64::INFINITY;
                for _ in 0..12 {
                    let t = Instant::now();
                    for _ in 0..10 {
                        std::hint::black_box(f());
                    }
                    let ms = t.elapsed().as_secs_f64() * 1000.0 / 10.0;
                    if ms < best {
                        best = ms;
                    }
                }
                best
            };
            let sc = bench(&|| analyze_scalar(&buf, px));
            #[cfg(target_arch = "x86_64")]
            let av = if has_avx2 {
                bench(&|| unsafe { analyze_avx2(&buf, px) })
            } else {
                f64::NAN
            };
            #[cfg(not(target_arch = "x86_64"))]
            let av = f64::NAN;
            println!(
                "{}: scalar {:.3} ms   avx2 {:.3} ms   speedup {:.2}x",
                label,
                sc,
                av,
                sc / av
            );
        }
    }
}
