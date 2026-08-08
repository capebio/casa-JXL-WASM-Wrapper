//! AVX2 + FMA implementations. Each public fn is `unsafe` and must only be called
//! when `detect_native` confirmed avx2+fma. 8-wide f32 lanes.

#![cfg(target_arch = "x86_64")]
// SpeedCodeReview ✓ 2026-06-19 · opus-4.8[1m] · sweeps=2 · Arch 2/0/1 Alg 2/0/0 Code 6/5/1 (x/y/z=found/green/red, +3 deferred)

use super::scalar::{downsample_row_tail, scale_err_tail, xyb_tail};
use crate::perceptual::blur::box_blur_h;
use core::arch::x86_64::*;

#[inline]
unsafe fn hsum256(v: __m256) -> f32 {
    let lo = _mm256_castps256_ps128(v);
    let hi = _mm256_extractf128_ps(v, 1);
    let s = _mm_add_ps(lo, hi);
    let sh = _mm_movehdup_ps(s);
    let sums = _mm_add_ps(s, sh);
    let sh2 = _mm_movehl_ps(sh, sums);
    _mm_cvtss_f32(_mm_add_ss(sums, sh2))
}

/// AVX2 strict scale error (full sqrt). Mirrors scalar `scale_err`. Returns the
/// p-norm (p=3). `rsqrt_path` selects the reciprocal/rsqrt approximation variant.
#[target_feature(enable = "avx2,fma")]
pub unsafe fn scale_err_avx2(
    mask: &[f32],
    rx: &[f32],
    ry: &[f32],
    rb: &[f32],
    tx: &[f32],
    ty: &[f32],
    tb: &[f32],
    n: usize,
    kx: f32,
    ky: f32,
    kb: f32,
    rsqrt_path: bool,
) -> f32 {
    // Guard n==0: dividing by n below would produce NaN, matching the scalar oracle
    // in butteraugli.rs which also early-returns 0.0 for degenerate empty levels.
    if n == 0 {
        return 0.0;
    }
    // Length precondition: every input plane must cover all n elements. The
    // loadu/scalar-tail reads index up to n-1 via raw pointer add, so a short
    // slice would read past its allocation (UB). For the in-call-graph caller
    // all slices are sized to n, so this is a no-op; it converts an adversarial
    // desync into a defined panic instead of OOB.
    assert!(
        mask.len() >= n
            && rx.len() >= n
            && ry.len() >= n
            && rb.len() >= n
            && tx.len() >= n
            && ty.len() >= n
            && tb.len() >= n,
        "scale_err_avx2: all input slices must have len >= n"
    );
    // Drain the f32 lane accumulator to f64 every FLUSH iterations to prevent
    // precision loss when summing > ~4096 values (f32 exact range ≈ 2^24).
    // Keeps SIMD throughput while achieving f64 accumulation precision end-to-end.
    const FLUSH: usize = 4096;
    const FLUSH_PX: usize = FLUSH * 8; // lanes per drained f64 block (32768 px)
    let lanes = n / 8 * 8;
    let mut sum = 0f64;

    // Flush-block band parallelism — BIT-EXACT, not merely equivalent: the serial
    // kernel already resets its f32 accumulator at every FLUSH boundary and folds
    // one f64 value per block, left-to-right. Bands aligned to those boundaries
    // compute the exact same per-block f64 values (fresh acc, same lane ops), and
    // the final left-fold below replays the identical f64 addition sequence. The
    // only difference vs serial is skipping a trailing `+= hsum(zero-acc)` when
    // lanes is an exact block multiple — adding +0.0 to a non-negative sum is a
    // bit-level identity, so the result is unchanged. Compute-bound (div/sqrt per
    // lane), so this survives the DS-ROWPAR bandwidth rule; gated ≥2M px (bench:
    // examples/scale_err_mt_flip.rs).
    #[cfg(feature = "parallel")]
    {
        const BLOCKS_PER_BAND: usize = 8; // 262144 px per band
        if n >= SCALE_ERR_PAR_MIN_PIXELS && lanes >= 2 * BLOCKS_PER_BAND * FLUSH_PX {
            use rayon::prelude::*;
            let band_px = BLOCKS_PER_BAND * FLUSH_PX;
            let bands = lanes.div_ceil(band_px);
            let partials: Vec<Vec<f64>> = (0..bands)
                .into_par_iter()
                .map(|k| {
                    let i0 = k * band_px;
                    let i1 = (i0 + band_px).min(lanes);
                    let mut out = Vec::with_capacity(BLOCKS_PER_BAND);
                    // SAFETY: avx2+fma verified by the dispatching caller; i0 is a
                    // FLUSH_PX multiple so drains land on the serial boundaries.
                    unsafe {
                        scale_err_lanes_avx2(
                            mask, rx, ry, rb, tx, ty, tb, i0, i1, kx, ky, kb, rsqrt_path,
                            &mut out,
                        )
                    };
                    out
                })
                .collect();
            for band in &partials {
                for &v in band {
                    sum += v; // identical left-to-right f64 fold as serial
                }
            }
            sum = scale_err_tail(mask, rx, ry, rb, tx, ty, tb, n, kx, ky, kb, lanes, sum);
            return ((sum / n as f64).cbrt()) as f32;
        }
    }

    let mut blocks: Vec<f64> = Vec::new();
    scale_err_lanes_avx2(
        mask, rx, ry, rb, tx, ty, tb, 0, lanes, kx, ky, kb, rsqrt_path, &mut blocks,
    );
    for &v in &blocks {
        sum += v;
    }
    sum = scale_err_tail(mask, rx, ry, rb, tx, ty, tb, n, kx, ky, kb, lanes, sum);
    // cbrt() is faster and more accurate than powf(1.0/3.0) (two transcendentals).
    ((sum / n as f64).cbrt()) as f32
}

/// Engage the parallel scale_err pass only at ≥2M pixels.
#[cfg(feature = "parallel")]
const SCALE_ERR_PAR_MIN_PIXELS: usize = 1 << 21;

/// The scale_err vector loop over lane range `[i0, i1)` (both multiples of 8;
/// `i0` additionally a multiple of `FLUSH*8` so drains land on the same global
/// boundaries as the serial walk). Pushes one drained f64 per completed FLUSH
/// block plus one for a trailing partial block (if any) — exactly the values the
/// original loop folded into `sum`, in the same order.
///
/// SAFETY: caller guarantees avx2+fma and all seven slices have `len() >= i1`.
#[allow(clippy::too_many_arguments)]
#[target_feature(enable = "avx2,fma")]
unsafe fn scale_err_lanes_avx2(
    mask: &[f32],
    rx: &[f32],
    ry: &[f32],
    rb: &[f32],
    tx: &[f32],
    ty: &[f32],
    tb: &[f32],
    i0: usize,
    i1: usize,
    kx: f32,
    ky: f32,
    kb: f32,
    rsqrt_path: bool,
    out: &mut Vec<f64>,
) {
    let vkx = _mm256_set1_ps(kx);
    let vky = _mm256_set1_ps(ky);
    let vkb = _mm256_set1_ps(kb);
    let v2 = _mm256_set1_ps(2.0);
    let v015 = _mm256_set1_ps(0.15);
    let veps = _mm256_set1_ps(1e-12);
    let half = _mm256_set1_ps(0.5); // loop-invariant rsqrt Newton constants
    let threehalf = _mm256_set1_ps(1.5);
    let mut acc = _mm256_setzero_ps();
    const FLUSH: usize = 4096;
    let mut flush_count = 0usize;
    let mut i = i0;
    while i < i1 {
        let m = _mm256_loadu_ps(mask.as_ptr().add(i));
        // m = max(mask*2 + 0.15, 0.15)
        let mm = _mm256_max_ps(_mm256_fmadd_ps(m, v2, v015), v015);
        let inv = if rsqrt_path {
            // rcp(mm) refined one Newton step: r1 = r0 * (2 - mm*r0)
            let r0 = _mm256_rcp_ps(mm);
            _mm256_mul_ps(r0, _mm256_fnmadd_ps(mm, r0, v2))
        } else {
            _mm256_div_ps(_mm256_set1_ps(1.0), mm)
        };
        let ex = _mm256_mul_ps(
            _mm256_sub_ps(
                _mm256_loadu_ps(rx.as_ptr().add(i)),
                _mm256_loadu_ps(tx.as_ptr().add(i)),
            ),
            inv,
        );
        let ey = _mm256_mul_ps(
            _mm256_sub_ps(
                _mm256_loadu_ps(ry.as_ptr().add(i)),
                _mm256_loadu_ps(ty.as_ptr().add(i)),
            ),
            inv,
        );
        let eb = _mm256_mul_ps(
            _mm256_sub_ps(
                _mm256_loadu_ps(rb.as_ptr().add(i)),
                _mm256_loadu_ps(tb.as_ptr().add(i)),
            ),
            inv,
        );
        // e2 = kx*ex^2 + ky*ey^2 + kb*eb^2
        let mut e2 = _mm256_mul_ps(vkx, _mm256_mul_ps(ex, ex));
        e2 = _mm256_fmadd_ps(vky, _mm256_mul_ps(ey, ey), e2);
        e2 = _mm256_fmadd_ps(vkb, _mm256_mul_ps(eb, eb), e2);
        // term = e2 * sqrt(e2 + eps)
        let root = if rsqrt_path {
            // sqrt(z) = z * rsqrt(z); one Newton step on rsqrt for accuracy.
            // Note: rsqrt is computed on z = e2+eps (not e2), so the Newton refinement
            // and the final sqrt are both consistent with z. Changing eps would need
            // to be applied to z before the rsqrt call, not after — do not split them.
            let z = _mm256_add_ps(e2, veps);
            let y0 = _mm256_rsqrt_ps(z);
            // y1 = y0 * (1.5 - 0.5*z*y0*y0)  (one Newton step on 1/sqrt(z))
            let y1 = _mm256_mul_ps(
                y0,
                _mm256_fnmadd_ps(_mm256_mul_ps(half, z), _mm256_mul_ps(y0, y0), threehalf),
            );
            _mm256_mul_ps(z, y1) // z * rsqrt(z) ≈ sqrt(z)
        } else {
            _mm256_sqrt_ps(_mm256_add_ps(e2, veps))
        };
        acc = _mm256_fmadd_ps(e2, root, acc);
        i += 8;
        flush_count += 1;
        if flush_count == FLUSH {
            out.push(hsum256(acc) as f64);
            acc = _mm256_setzero_ps();
            flush_count = 0;
        }
    }
    if flush_count > 0 {
        out.push(hsum256(acc) as f64);
    }
}

/// AVX2 PSNR sum-of-squared-diffs over packed u8. Returns the integer sum (exact
/// for buffers up to ~2^53/255^2 ≈ 1.4e11 elements). Caller computes dB.
///
/// The per-chunk partials live in an `__m256i` of eight i32 lanes (`acc`). Each
/// `_mm256_madd_epi16` partial is at most 2·255² = 130050, so a lane overflows
/// i32 after ⌊(2³¹−1)/130050⌋ ≈ 16511 accumulations. To match the scalar u64
/// oracle (psnr.rs) on megapixel buffers we drain `acc` into a u64 `sum` and
/// reset every `FLUSH_CHUNKS` iterations, well under that limit. Small buffers
/// hit the flush at most once at the end, so their result is bit-identical.
#[target_feature(enable = "avx2")]
pub unsafe fn ssd_avx2(a: &[u8], b: &[u8]) -> u64 {
    // Use assert_eq! (not debug_assert_eq!) to match ssim_moments_avx2's assert! —
    // mismatched buffers would cause OOB SIMD reads in release builds (silent UB).
    assert_eq!(a.len(), b.len(), "ssd_avx2: buffers must have equal length");
    // Byte-band parallelism: SSD is a u64 integer sum, so any band split sums to
    // exactly the same total (same unconditional-exactness argument as
    // ssim_moments_avx2_cal). Bands are 16-byte aligned so every band keeps the
    // same vector/scalar boundary shape. Gated ≥8 MB (bench:
    // examples/ssd_mt_flip.rs); small compares stay serial.
    #[cfg(feature = "parallel")]
    {
        const BAND_BYTES: usize = 4 << 20; // 4 MB, multiple of 16
        if a.len() >= SSD_PAR_MIN_BYTES {
            use rayon::prelude::*;
            let bands = a.len().div_ceil(BAND_BYTES);
            return (0..bands)
                .into_par_iter()
                .map(|k| {
                    let i0 = k * BAND_BYTES;
                    let i1 = (i0 + BAND_BYTES).min(a.len());
                    // SAFETY: avx2 verified by the dispatching caller; band
                    // slices are in-bounds and equal-length by construction.
                    unsafe { ssd_band_avx2(&a[i0..i1], &b[i0..i1]) }
                })
                .sum();
        }
    }
    ssd_band_avx2(a, b)
}

/// Engage the parallel SSD pass only at ≥8 MB per buffer (2M RGBA px).
#[cfg(feature = "parallel")]
const SSD_PAR_MIN_BYTES: usize = 8 << 20;

/// SSD over one equal-length byte band — exactly the original `ssd_avx2` loop.
///
/// SAFETY: caller guarantees avx2 and `a.len() == b.len()`.
#[target_feature(enable = "avx2")]
unsafe fn ssd_band_avx2(a: &[u8], b: &[u8]) -> u64 {
    let len = a.len();
    // Drain the i32 lane accumulator into u64 before any lane can wrap.
    // 130050 · 16000 = 2.0808e9 < 2³¹−1 (2.1475e9), with margin.
    const FLUSH_EVERY: usize = 16000;
    let mut acc = _mm256_setzero_si256();
    let mut sum: u64 = 0;
    let chunks = len / 16 * 16;
    let mut i = 0;
    let mut since_flush = 0usize;
    while i < chunks {
        // 16 bytes each → widen to i16 diffs, square via madd
        let va = _mm_loadu_si128(a.as_ptr().add(i) as *const __m128i);
        let vb = _mm_loadu_si128(b.as_ptr().add(i) as *const __m128i);
        let aw = _mm256_cvtepu8_epi16(va);
        let bw = _mm256_cvtepu8_epi16(vb);
        let d = _mm256_sub_epi16(aw, bw); // fits i16 (|d|<=255)
        let sq = _mm256_madd_epi16(d, d); // 8 × i32 partial sums of pairs
        acc = _mm256_add_epi32(acc, sq);
        i += 16;
        since_flush += 1;
        if since_flush == FLUSH_EVERY {
            sum += hsum256i_u64(acc);
            acc = _mm256_setzero_si256();
            since_flush = 0;
        }
    }
    // drain remaining lanes
    sum += hsum256i_u64(acc);
    while i < len {
        let d = a[i] as i64 - b[i] as i64;
        sum += (d * d) as u64;
        i += 1;
    }
    sum
}

/// Horizontal sum of eight i32 lanes (all non-negative here) widened to u64.
///
/// Uses `v as u32 as u64` (unsigned widening) rather than `v as u64` (sign-extending
/// cast) so that a future increase of FLUSH_EVERY past the i32-safe ceiling cannot
/// silently produce huge u64 values from a wrapped-negative i32 lane.
/// The safe FLUSH_EVERY ceiling is ⌊(2³¹−1) / (2 · 255²)⌋ ≈ 16494; current value
/// FLUSH_EVERY=16000 keeps the worst-case lane well under i32::MAX.
#[inline]
unsafe fn hsum256i_u64(acc: __m256i) -> u64 {
    let mut tmp = [0i32; 8];
    _mm256_storeu_si256(tmp.as_mut_ptr() as *mut __m256i, acc);
    tmp.iter().map(|&v| v as u32 as u64).sum()
}

/// Drain lanes {0,4}/{1,5}/{2,6}/{3,7} (R/G/B/A of 2 pixel-slots) of an i32x8
/// partial into a per-channel u64[4]. Unsigned widen, as in `hsum256i_u64`.
/// The alpha lanes were always accumulated in the vector registers; keeping them
/// (instead of discarding at drain time) lets `Comparer::all()` derive the PSNR
/// SSD from these sums and skip its whole test+ref traversal.
#[inline]
unsafe fn drain8_rgba(v: __m256i, acc: &mut [u64; 4]) {
    let mut t = [0i32; 8];
    _mm256_storeu_si256(t.as_mut_ptr() as *mut __m256i, v);
    for k in 0..2 {
        acc[0] += t[k * 4] as u32 as u64;
        acc[1] += t[k * 4 + 1] as u32 as u64;
        acc[2] += t[k * 4 + 2] as u32 as u64;
        acc[3] += t[k * 4 + 3] as u32 as u64;
    }
}

/// AVX2 channel-as-lane SSIM moments (8-wide, 2 px/iter). Same contract as
/// `ssim_moments_avx2`, but packs 2 RGBA pixels into the 8 i32 lanes and fuses the
/// three products. flip-measured 1.33–1.51× over the scalar kernel at 24MP, parity
/// exact (examples/ssim_moments_avx2_flip.rs) — so this is the WIRED Avx2 SSIM path.
/// The old AVX2 *deinterleave* attempt that lost was a different layout; the scalar
/// `ssim_moments_avx2` below is kept as the parity oracle for tests + the flip.
#[target_feature(enable = "avx2")]
pub unsafe fn ssim_moments_avx2_cal(
    a: &[u8],
    b: &[u8],
    np: usize,
) -> ([u64; 4], [u64; 4], [u64; 4]) {
    assert!(
        a.len() / 4 >= np && b.len() / 4 >= np,
        "ssim_moments_avx2_cal: a.len() and b.len() must be >= np*4"
    );
    // Pixel-band parallelism: the moments are u64 INTEGER sums, so any band
    // split reduces to the exact same totals (integer addition is associative
    // and commutative — unlike the f32 kernels, bit-exactness is unconditional,
    // not an op-order argument). Bands are read-only map tasks reduced by
    // element-wise add; no shared mutable state. Gated ≥2M px (bench:
    // examples/ssim_moments_mt_flip.rs); small compares stay serial.
    #[cfg(feature = "parallel")]
    {
        const BAND_PX: usize = 1 << 20;
        if np >= SSIM_PAR_MIN_PIXELS {
            use rayon::prelude::*;
            let bands = np.div_ceil(BAND_PX);
            return (0..bands)
                .into_par_iter()
                .map(|k| {
                    let p0 = k * BAND_PX;
                    let p1 = (p0 + BAND_PX).min(np);
                    // SAFETY: avx2 verified by the dispatching caller (same
                    // contract as the enclosing #[target_feature] fn).
                    unsafe { ssim_moments_band_avx2(a, b, p0, p1) }
                })
                .reduce(
                    || ([0u64; 4], [0u64; 4], [0u64; 4]),
                    |(mut sa, mut saa, mut sab), (xa, xaa, xab)| {
                        for c in 0..4 {
                            sa[c] += xa[c];
                            saa[c] += xaa[c];
                            sab[c] += xab[c];
                        }
                        (sa, saa, sab)
                    },
                );
        }
    }
    ssim_moments_band_avx2(a, b, 0, np)
}

/// Engage the parallel SSIM-moments pass only at ≥2M pixels.
#[cfg(feature = "parallel")]
const SSIM_PAR_MIN_PIXELS: usize = 1 << 21;

/// Channel-as-lane moment sums over the pixel range `[p0, p1)` — exactly the
/// original `ssim_moments_avx2_cal` loop with band bounds (2-px vector groups,
/// FLUSH-drained i32 lanes, scalar tail for an odd trailing pixel).
///
/// SAFETY: caller guarantees avx2 and `a.len()/4 >= p1 && b.len()/4 >= p1`.
#[target_feature(enable = "avx2")]
unsafe fn ssim_moments_band_avx2(
    a: &[u8],
    b: &[u8],
    p0: usize,
    p1: usize,
) -> ([u64; 4], [u64; 4], [u64; 4]) {
    let mut sa = [0u64; 4];
    let mut saa = [0u64; 4];
    let mut sab = [0u64; 4];
    let mut va = _mm256_setzero_si256();
    let mut vaa = _mm256_setzero_si256();
    let mut vab = _mm256_setzero_si256();
    // Each i32 lane gains ≤255² per iter; drain at 32000 (< 33025 i32 ceiling).
    const FLUSH: usize = 32000;
    let mut fc = 0usize;
    let groups = (p1 - p0) / 2;
    let mut p = p0;
    let mut g = 0usize;
    while g < groups {
        let off = p * 4;
        // Load 8 bytes (2 RGBA px) into the low 64 bits, widen u8→i32 → 8 lanes
        // [R0,G0,B0,A0, R1,G1,B1,A1].
        let av = _mm256_cvtepu8_epi32(_mm_loadl_epi64(a.as_ptr().add(off) as *const __m128i));
        let bv = _mm256_cvtepu8_epi32(_mm_loadl_epi64(b.as_ptr().add(off) as *const __m128i));
        va = _mm256_add_epi32(va, av);
        vaa = _mm256_add_epi32(vaa, _mm256_mullo_epi32(av, av));
        vab = _mm256_add_epi32(vab, _mm256_mullo_epi32(av, bv));
        p += 2;
        g += 1;
        fc += 1;
        if fc == FLUSH {
            drain8_rgba(va, &mut sa);
            drain8_rgba(vaa, &mut saa);
            drain8_rgba(vab, &mut sab);
            va = _mm256_setzero_si256();
            vaa = _mm256_setzero_si256();
            vab = _mm256_setzero_si256();
            fc = 0;
        }
    }
    drain8_rgba(va, &mut sa);
    drain8_rgba(vaa, &mut saa);
    drain8_rgba(vab, &mut sab);
    let mut j = p * 4;
    while p < p1 {
        for c in 0..4 {
            let x = a[j + c] as u64;
            let y = b[j + c] as u64;
            sa[c] += x;
            saa[c] += x * x;
            sab[c] += x * y;
        }
        j += 4;
        p += 1;
    }
    (sa, saa, sab)
}

/// SSIM moment accumulation over RGBA test+ref. Produces three per-channel sums
/// (sa, saa, sab) for c in 0..3; sb/sbb are precomputed on the reference.
///
/// NOTE: this is a *scalar* u64 reduction. A madd-based SIMD *deinterleave* gave no
/// measured win, so it stayed scalar — BUT the channel-as-lane layout
/// (`ssim_moments_avx2_cal`) since flip-measured 1.33–1.51× and is now the wired Avx2
/// path. This scalar version is retained as the exact parity oracle (tests + flip).
/// Carries `#[target_feature(enable = "avx2")]` only for call-site uniformity; it
/// uses no AVX2 intrinsics. This is intentional: FMA is also not needed here.
/// Do not add AVX2 intrinsics without a measured win from the flip-flop bench.
#[target_feature(enable = "avx2")]
pub unsafe fn ssim_moments_avx2(a: &[u8], b: &[u8], np: usize) -> ([u64; 4], [u64; 4], [u64; 4]) {
    // Length precondition: both buffers must hold np RGBA pixels (np*4 bytes).
    // The loop reads a[j+c]/b[j+c] with j up to (np-1)*4 and c in 0..4; a short
    // buffer would otherwise index-OOB with no descriptive message. No-op for
    // the sized caller.
    assert!(
        a.len() / 4 >= np && b.len() / 4 >= np,
        "ssim_moments_avx2: a.len() and b.len() must be >= np*4"
    );
    // Scalar-clean deinterleave is hard to beat for correctness here; use a
    // tight scalar loop with u64 accumulators (madd-based SIMD over a deinterleaved
    // temp gave no measured win — see flip-flop). Kept in the avx2 module so the
    // dispatcher has a single call site; correctness == scalar by construction.
    // 4 lanes (alpha kept) to stay the exact oracle of the widened cal kernel.
    let mut sa = [0u64; 4];
    let mut saa = [0u64; 4];
    let mut sab = [0u64; 4];
    let mut j = 0;
    for _ in 0..np {
        for c in 0..4 {
            let x = a[j + c] as u64;
            let y = b[j + c] as u64;
            sa[c] += x;
            saa[c] += x * x;
            sab[c] += x * y;
        }
        j += 4;
    }
    (sa, saa, sab)
}

/// AVX2 RGBA(u8) → planar X/Y/B using i32-gather over the sqrt-linear LUT.
/// `lut` is a 256-entry static f32 table reference. Processes 8 px/iter + scalar tail.
///
/// NOTE: superseded for dispatch by `pixels_to_xyb_avx2_scalar_lut`, which the
/// gather flip (examples/xyb_gather_flip.rs) measured ~2.6× faster at 1/6/24 MP
/// with bit-identical output. This gather kernel is retained as that flip's
/// baseline arm and as the bit-exact reference the scalar-LUT path is checked
/// against (xyb_gather_candidates_bit_identical). Do not re-wire it into dispatch
/// without a fresh flip showing gather wins on the target fleet.
///
/// Declares `fma` because the Y row uses `_mm256_fmadd_ps`; the dispatcher only
/// reaches this path when `detect_native` confirmed avx2+fma. The explicit
/// mul/sub/add intrinsics are not auto-contracted, so the byte output is the
/// same as it was under the bare `avx2` declaration.
#[target_feature(enable = "avx2,fma")]
pub unsafe fn pixels_to_xyb_avx2(
    px: &[u8],
    n: usize,
    lut: &[f32; 256],
    x: &mut [f32],
    y: &mut [f32],
    b: &mut [f32],
) {
    // Length precondition: px must hold n RGBA pixels (n*4 bytes) and each
    // planar output must hold n floats. get_unchecked reads (i+l)*4+2 and the
    // bulk storeu writes index up to n-1, so a short px / x / y / b would be an
    // OOB read/write (UB). No-op for the sized caller; defined panic otherwise.
    assert!(
        px.len() / 4 >= n && x.len() >= n && y.len() >= n && b.len() >= n,
        "pixels_to_xyb_avx2: px.len() must be >= n*4 and x/y/b len >= n"
    );
    let half = _mm256_set1_ps(0.5);
    // Byte-lane masks for extracting R/G/B from packed RGBA i32 lanes.
    // Each pixel occupies one i32 lane as [R, G, B, A] in little-endian order.
    // A single 256-bit loadu of 32 bytes places 8 RGBA pixels one-per-i32-lane;
    // we then AND-mask each channel byte in the lane and shift it down to bits
    // [7:0] to build the gather index (0..255). No widen/deinterleave step.
    let mask_r = _mm256_set1_epi32(0x0000_00FF); // byte 0 of each i32 lane
    let mask_g = _mm256_set1_epi32(0x0000_FF00); // byte 1 of each i32 lane
    let mask_b = _mm256_set1_epi32(0x00FF_0000); // byte 2 of each i32 lane
    let lp = lut.as_ptr(); // loop-invariant base for the gathers
    let lanes = n / 8 * 8;
    let mut i = 0;
    while i < lanes {
        // Load 8 RGBA pixels (32 bytes) as one __m256i: each i32 lane = [R,G,B,A].
        // A single 256-bit load replaces 24 scalar byte reads (8 pixels × 3 channels).
        let pv = _mm256_loadu_si256(px.as_ptr().add(i * 4) as *const __m256i);
        // Extract R indices: byte 0 of each i32 lane (already in bits [7:0], no shift needed).
        let ri = _mm256_and_si256(pv, mask_r);
        // Extract G indices: byte 1 → shift right 8 to bring into bits [7:0].
        let gi = _mm256_srli_epi32::<8>(_mm256_and_si256(pv, mask_g));
        // Extract B indices: byte 2 → shift right 16 to bring into bits [7:0].
        let bi = _mm256_srli_epi32::<16>(_mm256_and_si256(pv, mask_b));
        let r = _mm256_i32gather_ps(lp, ri, 4);
        let g = _mm256_i32gather_ps(lp, gi, 4);
        let bb = _mm256_i32gather_ps(lp, bi, 4);
        // X=(r-b)*0.5 ; Y=(r+b)*0.5+g ; B=b
        _mm256_storeu_ps(
            x.as_mut_ptr().add(i),
            _mm256_mul_ps(_mm256_sub_ps(r, bb), half),
        );
        _mm256_storeu_ps(
            y.as_mut_ptr().add(i),
            _mm256_fmadd_ps(_mm256_add_ps(r, bb), half, g),
        );
        _mm256_storeu_ps(b.as_mut_ptr().add(i), bb);
        i += 8;
    }
    // lut is a plain &[f32; 256] — shared with the scalar tail directly, no cast.
    xyb_tail(px, lut, n, i, x, y, b);
}

/// Assemble eight `lut[idx]` f32 values for one RGB channel of an 8-pixel RGBA
/// group into a 256-bit register using ordinary (L1-resident) scalar loads
/// instead of a `vgatherdps`. `p` points at byte 0 of pixel 0 of the group;
/// `channel` is 0 (R), 1 (G), or 2 (B). Lane k holds `lut[p[k*4 + channel]]`,
/// matching the gather kernel's lane order exactly. Caller guarantees 32
/// readable bytes from `p` (8 RGBA pixels).
#[inline(always)]
unsafe fn lut8_scalar_insert(p: *const u8, channel: usize, lut: *const f32) -> __m256 {
    let lo = _mm_setr_ps(
        *lut.add(*p.add(channel) as usize),
        *lut.add(*p.add(4 + channel) as usize),
        *lut.add(*p.add(8 + channel) as usize),
        *lut.add(*p.add(12 + channel) as usize),
    );
    let hi = _mm_setr_ps(
        *lut.add(*p.add(16 + channel) as usize),
        *lut.add(*p.add(20 + channel) as usize),
        *lut.add(*p.add(24 + channel) as usize),
        *lut.add(*p.add(28 + channel) as usize),
    );
    _mm256_insertf128_ps(_mm256_castps128_ps256(lo), hi, 1)
}

/// RGBA(u8) → planar X/Y/B via scalar LUT loads assembled into 8-wide vectors —
/// trades three `vgatherdps` per 8 px for 24 L1-resident loads + two
/// `vinsertf128`. Bit-identical to `pixels_to_xyb_avx2` by construction: same
/// LUT, same per-lane values, same X/Y/B arithmetic in the same association.
///
/// This is the WIRED AVX2 xyb path (fill_test_xyb). The gather flip
/// (examples/xyb_gather_flip.rs) measured it ~2.6× faster than the gather kernel
/// at 1/6/24 MP on a Comet Lake core; the win holds at 24 MP, so the three
/// streamed planar writes do not erode it. `vgatherdps` over a 1 KiB (L1-hot)
/// LUT is throughput-bound on the gather port, not on cache — scalar loads win.
#[target_feature(enable = "avx2,fma")]
pub unsafe fn pixels_to_xyb_avx2_scalar_lut(
    px: &[u8],
    n: usize,
    lut: &[f32; 256],
    x: &mut [f32],
    y: &mut [f32],
    b: &mut [f32],
) {
    assert!(
        px.len() / 4 >= n && x.len() >= n && y.len() >= n && b.len() >= n,
        "pixels_to_xyb_avx2_scalar_lut: px.len() must be >= n*4 and x/y/b len >= n"
    );
    let half = _mm256_set1_ps(0.5);
    let lp = lut.as_ptr();
    let lanes = n / 8 * 8;
    let mut i = 0;
    while i < lanes {
        let p = px.as_ptr().add(i * 4);
        let r = lut8_scalar_insert(p, 0, lp);
        let g = lut8_scalar_insert(p, 1, lp);
        let bb = lut8_scalar_insert(p, 2, lp);
        _mm256_storeu_ps(
            x.as_mut_ptr().add(i),
            _mm256_mul_ps(_mm256_sub_ps(r, bb), half),
        );
        _mm256_storeu_ps(
            y.as_mut_ptr().add(i),
            _mm256_fmadd_ps(_mm256_add_ps(r, bb), half, g),
        );
        _mm256_storeu_ps(b.as_mut_ptr().add(i), bb);
        i += 8;
    }
    xyb_tail(px, lut, n, i, x, y, b);
}

/// AVX2 2× box downsample of a single plane (w×h) into `dst` (dw×dh).
/// Interior fast path: 8 output px/iter via permutevar8x32 deinterleave;
/// edges handled by scalar remainder.
#[target_feature(enable = "avx2")]
pub unsafe fn downsample_avx2(
    src: &[f32],
    dst: &mut [f32],
    w: usize,
    h: usize,
    dw: usize,
    dh: usize,
) {
    // Length precondition: src must cover the w×h source plane and dst the
    // dw×dh destination. Interior loadu reads src[row1 + 2x + 15] and the
    // bulk/scalar stores write dst[drow + x] up to dw*dh-1; a dimension desync
    // (e.g. dst too small) would be an OOB write (UB). No-op for the sized
    // caller; defined panic on mismatch.
    assert!(
        src.len() >= w * h && dst.len() >= dw * dh,
        "downsample_avx2: src.len() must be >= w*h and dst.len() >= dw*dh"
    );
    let quarter = _mm256_set1_ps(0.25);
    // Index vectors for _mm256_permutevar8x32_ps to extract even/odd lanes
    // from a 16-float pair of 256-bit registers.
    // Given p00=[s0,s1,s2,s3,s4,s5,s6,s7] and p01=[s8,s9,s10,s11,s12,s13,s14,s15]:
    //   even = [s0,s2,s4,s6, s8,s10,s12,s14]  (indices 0,2,4,6 from p00, 0,2,4,6 from p01)
    //   odd  = [s1,s3,s5,s7, s9,s11,s13,s15]  (indices 1,3,5,7 from p00, 1,3,5,7 from p01)
    // We use _mm256_permutevar8x32_ps on each register with even/odd index vectors,
    // then combine with _mm256_permute2f128_ps.
    //
    // _mm256_permutevar8x32_ps permutes within the full 256-bit register (all 8 lanes).
    // For p00: even_lo_idx=[0,2,4,6,0,2,4,6], odd_lo_idx=[1,3,5,7,1,3,5,7]
    // For p01: same indices
    // Then we take [lo 128 of permuted_p00, lo 128 of permuted_p01] via permute2f128.
    let even_idx = _mm256_setr_epi32(0, 2, 4, 6, 0, 2, 4, 6);
    let odd_idx = _mm256_setr_epi32(1, 3, 5, 7, 1, 3, 5, 7);

    for y in 0..dh {
        let sy0 = y << 1;
        let sy1 = if sy0 + 1 < h { sy0 + 1 } else { h - 1 };
        let row0 = sy0 * w;
        let row1 = sy1 * w;
        let drow = y * dw;
        // Bulk: 8 output px at a time. Each reads 16 src floats per row (2 src px per out px).
        // Need 2*8=16 src floats, which means src indices start at 2*x, length 16.
        // Require 2*x+15 < w, i.e. x <= (w-16)/2 = dw - 8 when w is even.
        // Safe bulk count: we need row0+2*x+15 < w*h and row1+2*x+15 similarly.
        // Simplest: bulk while 2*(x+8) <= w, i.e., x+8 <= dw (w even case).
        // For safety just check 2*x+15 < w for the last bulk iteration.
        // Bulk reads src[2x..2x+16] per row, so the guard `2*x+16 <= w` keeps the
        // load in-bounds; the scalar remainder handles the (clamped) odd-width tail.
        let mut x = 0usize;
        while x + 8 <= dw && 2 * x + 16 <= w {
            // Load 16 consecutive src floats per row starting at src[row0 + 2*x].
            let p00 = _mm256_loadu_ps(src.as_ptr().add(row0 + 2 * x)); // s0..s7
            let p01 = _mm256_loadu_ps(src.as_ptr().add(row0 + 2 * x + 8)); // s8..s15
            let p10 = _mm256_loadu_ps(src.as_ptr().add(row1 + 2 * x));
            let p11 = _mm256_loadu_ps(src.as_ptr().add(row1 + 2 * x + 8));

            // Deinterleave: extract even-indexed lanes (sx0) and odd-indexed (sx1).
            // permutevar8x32 on p00 with even_idx=[0,2,4,6,0,2,4,6]:
            //   lo 4 lanes = s0,s2,s4,s6 (correct even from p00)
            //   hi 4 lanes = s0,s2,s4,s6 (duplicate — discarded)
            // permutevar8x32 on p01 with even_idx:
            //   lo 4 lanes = s8,s10,s12,s14 (correct even from p01)
            //   hi 4 lanes = duplicate — discarded
            // Then permute2f128 with imm8=0x20 takes lo128 of first, lo128 of second.
            let e0_perm = _mm256_permutevar8x32_ps(p00, even_idx);
            let e1_perm = _mm256_permutevar8x32_ps(p01, even_idx);
            let even_r0 = _mm256_permute2f128_ps(e0_perm, e1_perm, 0x20); // [s0,s2,s4,s6,s8,s10,s12,s14]

            let o0_perm = _mm256_permutevar8x32_ps(p00, odd_idx);
            let o1_perm = _mm256_permutevar8x32_ps(p01, odd_idx);
            let odd_r0 = _mm256_permute2f128_ps(o0_perm, o1_perm, 0x20); // [s1,s3,s5,s7,s9,s11,s13,s15]

            let e0_perm10 = _mm256_permutevar8x32_ps(p10, even_idx);
            let e1_perm10 = _mm256_permutevar8x32_ps(p11, even_idx);
            let even_r1 = _mm256_permute2f128_ps(e0_perm10, e1_perm10, 0x20);

            let o0_perm10 = _mm256_permutevar8x32_ps(p10, odd_idx);
            let o1_perm10 = _mm256_permutevar8x32_ps(p11, odd_idx);
            let odd_r1 = _mm256_permute2f128_ps(o0_perm10, o1_perm10, 0x20);

            // sum = (even_r0 + odd_r0) + (even_r1 + odd_r1)
            let sum = _mm256_add_ps(
                _mm256_add_ps(even_r0, odd_r0),
                _mm256_add_ps(even_r1, odd_r1),
            );
            _mm256_storeu_ps(dst.as_mut_ptr().add(drow + x), _mm256_mul_ps(sum, quarter));
            x += 8;
        }
        // scalar remainder + clamped last column
        downsample_row_tail(src, w, h, &mut dst[drow..drow + dw], dw, y, x);
    }
}

/// AVX2 separable box blur (radius `r`, clamp-to-edge) → fresh Vec. Same result
/// as `blur::box_blur` — BIT-IDENTICAL by construction: the horizontal pass is
/// the shared scalar `box_blur_h`, and the vertical pass runs the exact same
/// per-column float ops (`sums = tmp*(r+1)`, `+= tmp[row]`, store `sums*inv`,
/// `sums += add - sub`) 8 columns at a time in one `__m256` instead of a scalar
/// `for t in 0..8`. The column-tile boundary (`while x+8<=w`) and the `x..w`
/// scalar remainder match `box_blur` exactly, so which columns are vectorised is
/// identical. Wins because the crate's baseline codegen is SSE2 (4-wide) — the
/// scalar tile only auto-vectorises to 128-bit; this forces 256-bit.
///
/// The mask blur is reference-build-only (Comparer::new), the dominant ref-build
/// cost measured in examples/ref_build_effect.rs.
#[target_feature(enable = "avx2")]
pub unsafe fn box_blur_avx2(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let n = w * h;
    if n == 0 {
        return Vec::new();
    }
    // tmp and dst are FULLY overwritten before any read: box_blur_h writes every
    // tmp element (and only reads src), then the vertical pass + scalar remainder
    // write every dst element (and only read tmp). So the `vec![0f32; n]` zero-init
    // would be 2·n·4 B of wasted memset (192 MB at 24 MP). Allocate uninitialised.
    // SAFETY: f32 has no invalid bit patterns; the n slots exposed by set_len are
    // each written before they are ever read (H fills all of tmp, V + remainder
    // fill all of dst), and f32 has no Drop, so leaking uninit on panic is sound.
    let mut tmp: Vec<f32> = Vec::with_capacity(n);
    let mut dst: Vec<f32> = Vec::with_capacity(n);
    unsafe {
        tmp.set_len(n);
        dst.set_len(n);
    }
    let inv = 1.0 / (2 * r + 1) as f32;

    // Horizontal pass: shared scalar recurrence (identical to box_blur).
    box_blur_h(src, &mut tmp, w, h, r, inv);

    // Vertical pass. Column bands are fully independent (each column's
    // recurrence reads only tmp and writes only its own dst column), so on
    // large planes the bands run in parallel under the `parallel` feature —
    // bit-identical to the serial walk by construction (identical per-column
    // op order; only which thread executes a band changes). Bench-gated via
    // examples/box_blur_vpar_flip.rs; small planes keep the serial call to
    // avoid rayon task overhead on the quarter-res pyramid levels.
    #[cfg(feature = "parallel")]
    {
        if n >= V_PAR_MIN_PIXELS && w >= 2 * V_BAND_COLS {
            use rayon::prelude::*;
            // Raw-pointer wrapper: bands write disjoint dst columns, tmp is
            // shared read-only. Sync is sound because no two bands overlap.
            struct DstPtr(*mut f32);
            unsafe impl Sync for DstPtr {}
            let dp = DstPtr(dst.as_mut_ptr());
            // Borrow the WRAPPER (not the raw field): edition-2021 disjoint
            // capture would otherwise capture the non-Sync `*mut f32` itself.
            let dp = &dp;
            let tmp_ref = &tmp;
            let bands = w.div_ceil(V_BAND_COLS);
            (0..bands).into_par_iter().for_each(|b| {
                let x0 = b * V_BAND_COLS;
                let x1 = (x0 + V_BAND_COLS).min(w);
                // SAFETY: avx2 verified by the dispatching caller; the band
                // writes only dst columns [x0,x1) — disjoint across tasks.
                unsafe { box_blur_v_band_avx2(tmp_ref, dp.0, w, h, r, inv, x0, x1) };
            });
            return dst;
        }
    }
    // Serial: one band covering every column — the original loop, verbatim.
    box_blur_v_band_avx2(&tmp, dst.as_mut_ptr(), w, h, r, inv, 0, w);
    dst
}

/// Column-band width for the parallel vertical pass — a multiple of 8 so every
/// interior band is fully vectorised; only the final band can carry a scalar
/// remainder (same columns the serial walk leaves for its remainder loop).
const V_BAND_COLS: usize = 256;
/// Engage the parallel vertical pass only at ≥2 MP (bench-gated,
/// examples/box_blur_vpar_flip.rs): below that the plane fits caches and rayon
/// task overhead outweighs the win — covers the half/quarter-res mask levels.
#[cfg(feature = "parallel")]
const V_PAR_MIN_PIXELS: usize = 1 << 21;

/// Vertical box-blur pass over columns `[x0, x1)`: 8-wide vector groups plus a
/// scalar remainder for the trailing `< 8` columns of the band. Exactly the
/// original `box_blur_avx2` vertical loop with band bounds; per-column float op
/// order is identical for every band split, so any banding (including the
/// serial `0..w` call) produces bit-identical output.
///
/// SAFETY: caller guarantees avx2, `tmp.len() == w*h`, and exclusive write
/// access to dst columns `[x0, x1)` behind `dp` (rows `0..h`, row stride `w`).
#[target_feature(enable = "avx2")]
unsafe fn box_blur_v_band_avx2(
    tmp: &[f32],
    dp: *mut f32,
    w: usize,
    h: usize,
    r: usize,
    inv: f32,
    x0: usize,
    x1: usize,
) {
    let rp1 = _mm256_set1_ps(r as f32 + 1.0);
    let inv_v = _mm256_set1_ps(inv);
    let h_max = h - 1;
    let tp = tmp.as_ptr();
    let mut x = x0;
    while x + 8 <= x1 {
        // seed the window: tmp[x..x+8]*(r+1) + Σ_{k=1..=r} tmp[k.min(h_max)*w + x..]
        let mut sums = _mm256_mul_ps(_mm256_loadu_ps(tp.add(x)), rp1);
        for k in 1..=r {
            let row = k.min(h_max) * w;
            sums = _mm256_add_ps(sums, _mm256_loadu_ps(tp.add(row + x)));
        }
        for y in 0..h {
            let drow = y * w;
            _mm256_storeu_ps(dp.add(drow + x), _mm256_mul_ps(sums, inv_v));
            let add_row = (y + r + 1).min(h_max) * w;
            let sub_row = y.saturating_sub(r) * w;
            let add = _mm256_loadu_ps(tp.add(add_row + x));
            let sub = _mm256_loadu_ps(tp.add(sub_row + x));
            sums = _mm256_add_ps(sums, _mm256_sub_ps(add, sub));
        }
        x += 8;
    }
    // Scalar remainder for the < 8 trailing columns — identical to box_blur.
    for col in x..x1 {
        let mut sum = tmp[col] * (r as f32 + 1.0);
        for k in 1..=r {
            sum += tmp[k.min(h_max) * w + col];
        }
        for y in 0..h {
            *dp.add(y * w + col) = sum * inv;
            let add = tmp[(y + r + 1).min(h_max) * w + col];
            let sub = tmp[y.saturating_sub(r) * w + col];
            sum += add - sub;
        }
    }
}

#[cfg(test)]
mod xyb_tests {
    use super::*;
    use crate::perceptual::xyb::{pixels_to_xyb, sqrt_lin_lut_ptr};

    #[test]
    fn xyb_avx2_matches_scalar() {
        if !(std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma")) {
            return;
        }
        let n = 1000usize; // non-multiple of 8
        let px: Vec<u8> = (0..n * 4).map(|i| (i * 37 % 256) as u8).collect();
        let (mut sx, mut sy, mut sb) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        pixels_to_xyb(&px, n, &mut sx, &mut sy, &mut sb);
        let (mut ax, mut ay, mut ab) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        unsafe { pixels_to_xyb_avx2(&px, n, sqrt_lin_lut_ptr(), &mut ax, &mut ay, &mut ab) };
        for i in 0..n {
            assert!(
                (sx[i] - ax[i]).abs() < 1e-6,
                "x[{i}] {} vs {}",
                sx[i],
                ax[i]
            );
            assert!(
                (sy[i] - ay[i]).abs() < 1e-6,
                "y[{i}] {} vs {}",
                sy[i],
                ay[i]
            );
            assert!(
                (sb[i] - ab[i]).abs() < 1e-6,
                "b[{i}] {} vs {}",
                sb[i],
                ab[i]
            );
        }
    }

    /// The wired scalar-LUT kernel must agree bit-for-bit with the retained gather
    /// kernel: both read the same LUT entries into the same lane order and apply
    /// the same X/Y/B intrinsics in the same association. `n` leaves a 5-px scalar
    /// tail to exercise the shared `xyb_tail`.
    #[test]
    fn xyb_gather_candidates_bit_identical() {
        if !(std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma")) {
            return;
        }
        let n = 8 * 4096 + 13; // many 8-blocks + a 5-px scalar tail
        let mut px = vec![0u8; n * 4];
        let mut s = 0xA5A5_1234u32;
        for v in &mut px {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            *v = (s >> 24) as u8;
        }
        let lut = sqrt_lin_lut_ptr();
        let mk = || (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        let (mut gx, mut gy, mut gb) = mk();
        let (mut sx, mut sy, mut sb) = mk();
        unsafe {
            pixels_to_xyb_avx2(&px, n, lut, &mut gx, &mut gy, &mut gb);
            pixels_to_xyb_avx2_scalar_lut(&px, n, lut, &mut sx, &mut sy, &mut sb);
        }
        for i in 0..n {
            assert_eq!(gx[i].to_bits(), sx[i].to_bits(), "scalar_lut x[{i}]");
            assert_eq!(gy[i].to_bits(), sy[i].to_bits(), "scalar_lut y[{i}]");
            assert_eq!(gb[i].to_bits(), sb[i].to_bits(), "scalar_lut b[{i}]");
        }
    }
}

#[cfg(test)]
mod blur_tests {
    use super::*;
    use crate::perceptual::blur::box_blur;

    /// box_blur_avx2 must be BIT-IDENTICAL to the scalar box_blur across radii and
    /// dimensions — including widths that leave a < 8-column scalar remainder and
    /// short heights that clamp the vertical window.
    #[test]
    fn box_blur_avx2_bit_identical_to_scalar() {
        if !std::is_x86_feature_detected!("avx2") {
            return;
        }
        for (w, h) in [
            (64usize, 48usize),
            (65, 49),
            (17, 5),
            (8, 8),
            (3, 33),
            (100, 1),
        ] {
            for r in [1usize, 2, 4, 8] {
                let src: Vec<f32> = (0..w * h)
                    .map(|i| ((i * 37 % 251) as f32 * 0.013).sin() * 4.2)
                    .collect();
                let want = box_blur(&src, w, h, r);
                let got = unsafe { box_blur_avx2(&src, w, h, r) };
                assert_eq!(want.len(), got.len(), "{w}x{h} r{r} len");
                for i in 0..want.len() {
                    assert_eq!(
                        want[i].to_bits(),
                        got[i].to_bits(),
                        "{w}x{h} r{r} [{i}] {} vs {}",
                        want[i],
                        got[i]
                    );
                }
            }
        }
    }

    /// Same oracle check but at a size crossing V_PAR_MIN_PIXELS (2 MP), so under
    /// the default `parallel` feature this exercises the column-band rayon path
    /// (2049 columns → 9 bands incl. a scalar-remainder tail band) and proves it
    /// bit-identical to the scalar serial walk.
    #[test]
    fn box_blur_avx2_parallel_bands_bit_identical_to_scalar() {
        if !std::is_x86_feature_detected!("avx2") {
            return;
        }
        let (w, h, r) = (2049usize, 1100usize, 8usize); // 2.25 MP ≥ 1<<21
        let src: Vec<f32> = (0..w * h)
            .map(|i| ((i * 37 % 251) as f32 * 0.013).sin() * 4.2)
            .collect();
        let want = box_blur(&src, w, h, r);
        let got = unsafe { box_blur_avx2(&src, w, h, r) };
        assert_eq!(want.len(), got.len());
        for i in 0..want.len() {
            assert_eq!(want[i].to_bits(), got[i].to_bits(), "[{i}]");
        }
    }
}

#[cfg(test)]
mod downsample_tests {
    use super::*;
    use crate::perceptual::butteraugli::dn2;

    #[test]
    fn downsample_avx2_matches_dn2() {
        if !std::is_x86_feature_detected!("avx2") {
            return;
        }
        for (w, h) in [(64usize, 48usize), (65, 49), (2, 2), (33, 17)] {
            let src: Vec<f32> = (0..w * h).map(|i| (i as f32 * 0.013).sin()).collect();
            let (want, dw, dh) = dn2(&src, w, h);
            let mut got = vec![0f32; dw * dh];
            unsafe { downsample_avx2(&src, &mut got, w, h, dw, dh) };
            for i in 0..dw * dh {
                assert!(
                    (want[i] - got[i]).abs() < 1e-5,
                    "({w}x{h})[{i}] {} vs {}",
                    want[i],
                    got[i]
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::perceptual::butteraugli::{scale_err, Kweights};

    #[test]
    fn avx2_scale_err_matches_scalar() {
        if !(std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma")) {
            eprintln!("avx2/fma unavailable — skipping");
            return;
        }
        let n = 1000usize; // non-multiple of 8 to exercise the tail
        let mut rx = vec![0f32; n];
        let mut ry = vec![0f32; n];
        let mut rb = vec![0f32; n];
        let mut tx = vec![0f32; n];
        let mut ty = vec![0f32; n];
        let mut tb = vec![0f32; n];
        let mut mask = vec![0f32; n];
        for i in 0..n {
            let f = i as f32;
            rx[i] = (f * 0.013).sin() * 0.4;
            tx[i] = rx[i] + (f * 0.07).cos() * 0.05;
            ry[i] = (f * 0.021).cos() * 0.5 + 0.5;
            ty[i] = ry[i] + (f * 0.03).sin() * 0.05;
            rb[i] = (f * 0.017).sin() * 0.3 + 0.3;
            tb[i] = rb[i] + (f * 0.05).cos() * 0.04;
            mask[i] = ((f * 0.009).sin() * 0.5 + 0.5).abs() * 0.6;
        }
        let k = Kweights::default();
        let want = scale_err(&mask, &rx, &ry, &rb, &tx, &ty, &tb, n, &k);
        let got_strict = unsafe {
            scale_err_avx2(
                &mask, &rx, &ry, &rb, &tx, &ty, &tb, n, k.kx, k.ky, k.kb, false,
            )
        };
        let got_rsqrt = unsafe {
            scale_err_avx2(
                &mask, &rx, &ry, &rb, &tx, &ty, &tb, n, k.kx, k.ky, k.kb, true,
            )
        };
        let rel = |a: f32, b: f32| (a - b).abs() / a.abs().max(b.abs()).max(1e-12);
        assert!(
            rel(want, got_strict) < 1e-4,
            "strict rel={} want={want} got={got_strict}",
            rel(want, got_strict)
        );
        assert!(
            rel(want, got_rsqrt) < 1e-4,
            "rsqrt rel={} want={want} got={got_rsqrt}",
            rel(want, got_rsqrt)
        );
    }
}

#[cfg(test)]
mod reduction_tests {
    use super::*;
    use crate::perceptual::ssim;

    #[test]
    fn ssd_matches_scalar() {
        if !std::is_x86_feature_detected!("avx2") {
            return;
        }
        let n = 4096 + 7;
        let a: Vec<u8> = (0..n).map(|i| (i * 31 % 251) as u8).collect();
        let b: Vec<u8> = (0..n).map(|i| (i * 17 % 239) as u8).collect();
        let mut want = 0u64;
        for i in 0..n {
            let d = a[i] as i64 - b[i] as i64;
            want += (d * d) as u64;
        }
        let got = unsafe { ssd_avx2(&a, &b) };
        assert_eq!(want, got);
    }

    #[test]
    fn ssim_moments_match_scalar_finalize() {
        if !std::is_x86_feature_detected!("avx2") {
            return;
        }
        let np = 1000;
        let a: Vec<u8> = (0..np * 4).map(|i| (i * 13 % 255) as u8).collect();
        let b: Vec<u8> = (0..np * 4).map(|i| (i * 29 % 255) as u8).collect();
        let (sb, sbb) = ssim::ref_moments(&b, np, 4);
        let want = ssim::ssim_with_ref(&a, &b, np, 4, &sb, &sbb);
        let (sa, saa, sab) = unsafe { ssim_moments_avx2(&a, &b, np) };
        let rgb = |x: &[u64; 4]| [x[0], x[1], x[2]];
        let got = ssim::finalize_ssim(&rgb(&sa), &sb, &rgb(&saa), &sbb, &rgb(&sab), np, 3);
        assert!((want - got).abs() < 1e-6, "want={want} got={got}");
    }

    #[test]
    fn ssim_moments_cal_matches_scalar() {
        if !std::is_x86_feature_detected!("avx2") {
            return;
        }
        let np = 1000usize + 1; // odd → exercise the 2-px-group scalar tail
        let a: Vec<u8> = (0..np * 4).map(|i| (i * 13 % 255) as u8).collect();
        let b: Vec<u8> = (0..np * 4).map(|i| (i * 29 % 255) as u8).collect();
        let want = unsafe { ssim_moments_avx2(&a, &b, np) };
        let got = unsafe { ssim_moments_avx2_cal(&a, &b, np) };
        assert_eq!(want, got);
    }

    /// scale_err at a pixel count crossing SCALE_ERR_PAR_MIN_PIXELS (2M), so the
    /// default `parallel` feature takes the flush-block band path. Compared
    /// BIT-exactly against the serial walk reconstructed from the same band
    /// helper (one full-range call + identical left fold + tail + cbrt) — the
    /// parallel fold must replay the exact serial f64 addition sequence. Both
    /// strict and rsqrt variants; n chosen with a partial trailing flush block
    /// AND a scalar tail (n % 8 != 0).
    #[test]
    fn scale_err_parallel_flush_bands_bit_identical_to_serial() {
        if !(std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma")) {
            return;
        }
        let n = (1usize << 21) + (1 << 15) + 13; // 2.13M px: partial block + tail
        let mk = |seed: u32| -> Vec<f32> {
            let mut s = seed;
            (0..n)
                .map(|_| {
                    s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    (s >> 8) as f32 / 16_777_216.0
                })
                .collect()
        };
        let (mask, rx, ry, rb) = (mk(1), mk(2), mk(3), mk(4));
        let (tx, ty, tb) = (mk(5), mk(6), mk(7));
        let (kx, ky, kb) = (0.7f32, 1.1, 0.9);
        for rsqrt in [false, true] {
            let got = unsafe {
                scale_err_avx2(&mask, &rx, &ry, &rb, &tx, &ty, &tb, n, kx, ky, kb, rsqrt)
            };
            // Serial reconstruction through the same band helper.
            let lanes = n / 8 * 8;
            let mut blocks: Vec<f64> = Vec::new();
            unsafe {
                scale_err_lanes_avx2(
                    &mask, &rx, &ry, &rb, &tx, &ty, &tb, 0, lanes, kx, ky, kb, rsqrt,
                    &mut blocks,
                )
            };
            let mut sum = 0f64;
            for &v in &blocks {
                sum += v;
            }
            sum = super::super::scalar::scale_err_tail(
                &mask, &rx, &ry, &rb, &tx, &ty, &tb, n, kx, ky, kb, lanes, sum,
            );
            let want = ((sum / n as f64).cbrt()) as f32;
            assert_eq!(want.to_bits(), got.to_bits(), "rsqrt={rsqrt}");
        }
    }

    /// SSD at a byte count crossing SSD_PAR_MIN_BYTES (8 MB), so under the
    /// default `parallel` feature this exercises the 4 MB band map-sum path
    /// (3 bands incl. a partial last band + a non-multiple-of-16 tail) and
    /// proves it exactly equal to the scalar oracle (u64 integer sum).
    #[test]
    fn ssd_parallel_bands_match_scalar_oracle() {
        if !std::is_x86_feature_detected!("avx2") {
            return;
        }
        let n = (8usize << 20) + (2 << 20) + 7; // 10 MB + 7, odd tail
        let a: Vec<u8> = (0..n).map(|i| (i * 13 % 255) as u8).collect();
        let b: Vec<u8> = (0..n).map(|i| (i * 29 % 255) as u8).collect();
        let want: u64 = a
            .iter()
            .zip(&b)
            .map(|(&x, &y)| {
                let d = x as i64 - y as i64;
                (d * d) as u64
            })
            .sum();
        let got = unsafe { ssd_avx2(&a, &b) };
        assert_eq!(want, got);
    }

    /// Same oracle check at a pixel count crossing SSIM_PAR_MIN_PIXELS (2M), so
    /// under the default `parallel` feature this exercises the band map-reduce
    /// path (3 bands incl. a partial last band + odd trailing pixel) and proves
    /// it exactly equal to the scalar walk (u64 integer sums — unconditional).
    #[test]
    fn ssim_moments_cal_parallel_bands_match_scalar() {
        if !std::is_x86_feature_detected!("avx2") {
            return;
        }
        let np = (1usize << 21) + (1 << 19) + 1; // 2.62M px, odd
        let a: Vec<u8> = (0..np * 4).map(|i| (i * 13 % 255) as u8).collect();
        let b: Vec<u8> = (0..np * 4).map(|i| (i * 29 % 255) as u8).collect();
        let want = unsafe { ssim_moments_avx2(&a, &b, np) };
        let got = unsafe { ssim_moments_avx2_cal(&a, &b, np) };
        assert_eq!(want, got);
    }

    /// ref_moments_dispatch reuses ssim_moments_avx2_cal(b, b): its (sa, saa) must
    /// equal the scalar ref_moments (sb, sbb) exactly (Σy, Σy² — integer, sab
    /// discarded). Odd np exercises the 2-px-group scalar tail.
    #[test]
    fn ref_moments_via_cal_matches_scalar() {
        if !std::is_x86_feature_detected!("avx2") {
            return;
        }
        let np = 1000usize + 1;
        let b: Vec<u8> = (0..np * 4).map(|i| (i * 29 % 255) as u8).collect();
        let (sb, sbb) = ssim::ref_moments(&b, np, 4);
        let (sa, saa, _sab) = unsafe { ssim_moments_avx2_cal(&b, &b, np) };
        let rgb = |x: &[u64; 4]| [x[0], x[1], x[2]];
        assert_eq!((sb, sbb), (rgb(&sa), rgb(&saa)));
    }
}
