//! SIMD `apply_tone_math` — the compute-bound ~90% of the tone pass (matrix +
//! saturation/vibrance). SoA bulk: vectorize the per-pixel math across pixels.
//! `pipeline::apply_tone_math` is the scalar parity oracle.
//!
//! Profiling (20.5 MP ORF, single-thread): apply_tone_math = 1436 ms (90% of
//! tone), LUT gather = 160 ms (10%). Unlike the memory-bound metrics kernel,
//! this is compute-bound and per-pixel independent → SIMD pays.
//!
//! Backends, auto-dispatched by `apply_tone_bulk`:
//!   - x86_64 AVX2+FMA (8-wide)
//!   - wasm32 SIMD128 `f32x4` (4-wide; wasm ships `+simd128`) — the shipping target
//!   - branchless scalar fallback that LLVM autovectorizes (SSE/NEON/baseline wasm)
//!
//! Algebra. Luma is a linear functional of the *input*: `luma = lm·rgb` where
//! `lm = Lᵀ·M` (`luma_weights`). So the `vib_zero` tone (matrix + constant-`sat`
//! blend) collapses to a single 3×3: `M' = sat·M + (1-sat)·[lm;lm;lm]`
//! (`vib_zero_matrix`), which also subsumes the `sat==1` identity (`M' == M`). The
//! vibrance-active path keeps `M` for the post-matrix RGB but takes `luma` straight
//! from the input via `lm` (decoupled from the matrix → better ILP), with
//! `scale = c1 - c2·psat`, `psat = 1 - mn/mx` (masked to 0 when `raw_mx<=0`, proven
//! in [0,1] so no clamp), and the lerp blend `luma + (x-luma)·scale`. All forms are
//! algebraically equal to the oracle within the SIMD reassociation tolerance
//! (parity tests assert ≤0.05 abs OR <1e-3 rel).

#[allow(unused_imports)]
use crate::pipeline::apply_tone_math;

const LUMA_R: f32 = 0.2126;
const LUMA_G: f32 = 0.7152;
const LUMA_B: f32 = 0.0722;

/// `lm = Lᵀ·M` — the per-input-channel weights that yield post-matrix luma directly
/// from the *input* RGB (`luma = lm·rgb`). Reusable seam for adjacent code that needs
/// post-matrix luma (preview/histogram in `pipeline.rs`) without running the matrix.
#[inline(always)]
pub(crate) fn luma_weights(m: &[[f32; 3]; 3]) -> [f32; 3] {
    [
        LUMA_R * m[0][0] + LUMA_G * m[1][0] + LUMA_B * m[2][0],
        LUMA_R * m[0][1] + LUMA_G * m[1][1] + LUMA_B * m[2][1],
        LUMA_R * m[0][2] + LUMA_G * m[1][2] + LUMA_B * m[2][2],
    ]
}

/// The `vib_zero` tone collapsed to one 3×3: `M'[i][j] = sat·M[i][j] + (1-sat)·lm[j]`.
/// Applying `M'·rgb` reproduces `luma + sat·(M·rgb - luma)` exactly. `sat==1 ⇒ M'==M`
/// (identity), `sat==0 ⇒ every row == lm` (full desaturate to grayscale).
/// Reusable seam: `pipeline.rs` can premultiply this into the pre-LUT→matrix step so
/// the common no-vibrance path is a single matrix multiply with no luma/blend.
#[inline(always)]
pub fn vib_zero_matrix(m: &[[f32; 3]; 3], sat: f32) -> [[f32; 3]; 3] {
    let lm = luma_weights(m);
    let inv = 1.0 - sat;
    let mut mp = [[0f32; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            mp[i][j] = sat * m[i][j] + inv * lm[j];
        }
    }
    mp
}

/// Vibrance-active per-pixel tone. Branchless (the `raw_mx>0` test is a multiply by a
/// 0/1 mask) so the SoA loop autovectorizes. `lm = luma_weights(m)`, `c1 = sat*(1+vib*0.6)`,
/// `c2 = sat*vib*0.6` (all folded once by the caller).
#[inline(always)]
fn tone_active(
    rr: f32,
    gg: f32,
    bb: f32,
    m: &[[f32; 3]; 3],
    lm: &[f32; 3],
    c1: f32,
    c2: f32,
) -> (f32, f32, f32) {
    let r2 = m[0][0].mul_add(rr, m[0][1].mul_add(gg, m[0][2] * bb));
    let g2 = m[1][0].mul_add(rr, m[1][1].mul_add(gg, m[1][2] * bb));
    let b2 = m[2][0].mul_add(rr, m[2][1].mul_add(gg, m[2][2] * bb));
    let luma = lm[0].mul_add(rr, lm[1].mul_add(gg, lm[2] * bb)); // from input, parallel to matrix
    let raw_mx = r2.max(g2).max(b2);
    let mx = raw_mx.max(1.0);
    let mn = r2.min(g2).min(b2).max(0.0);
    let psat = (1.0 - mn / mx) * ((raw_mx > 0.0) as u32 as f32);
    let scale = c1 - c2 * psat;
    (
        scale.mul_add(r2 - luma, luma),
        scale.mul_add(g2 - luma, luma),
        scale.mul_add(b2 - luma, luma),
    )
}

/// In-place SoA tone math over `r`/`g`/`b`. Dispatches AVX2+FMA (x86_64), SIMD128
/// (wasm32), else the branchless scalar path. Length is clamped to the shortest
/// slice so a misuse can't read out of bounds in the unsafe kernels.
#[inline]
pub fn apply_tone_bulk(
    r: &mut [f32],
    g: &mut [f32],
    b: &mut [f32],
    m: &[[f32; 3]; 3],
    sat: f32,
    vib: f32,
    vib_zero: bool,
) {
    let n = r.len().min(g.len()).min(b.len());
    debug_assert_eq!(g.len(), r.len());
    debug_assert_eq!(b.len(), r.len());
    #[cfg(target_arch = "x86_64")]
    {
        if std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma") {
            unsafe { apply_tone_bulk_avx2(r, g, b, m, sat, vib, vib_zero, n) };
            return;
        }
    }
    // wasm32 ships with `+simd128` (see .cargo/config.toml) so the SIMD128 body
    // is always valid — no runtime detect needed (same idiom as demosaic.rs).
    #[cfg(target_arch = "wasm32")]
    {
        apply_tone_bulk_wasm(r, g, b, m, sat, vib, vib_zero, n);
        return;
    }
    #[allow(unreachable_code)]
    apply_tone_bulk_scalar(r, g, b, m, sat, vib, vib_zero, n);
}

/// Scalar-forced bulk (the branchless parity path), exposed for benchmarking against
/// the SIMD path. Production callers use `apply_tone_bulk` (auto-dispatches).
pub fn apply_tone_bulk_ref(
    r: &mut [f32],
    g: &mut [f32],
    b: &mut [f32],
    m: &[[f32; 3]; 3],
    sat: f32,
    vib: f32,
    vib_zero: bool,
) {
    let n = r.len().min(g.len()).min(b.len());
    apply_tone_bulk_scalar(r, g, b, m, sat, vib, vib_zero, n);
}

#[inline]
fn apply_tone_bulk_scalar(
    r: &mut [f32],
    g: &mut [f32],
    b: &mut [f32],
    m: &[[f32; 3]; 3],
    sat: f32,
    vib: f32,
    vib_zero: bool,
    n: usize,
) {
    if vib_zero {
        // Entire tone is the single 3×3 M' — applied by the shared matrix-only kernel.
        let p = vib_zero_matrix(m, sat);
        apply_tone_bulk_matrix_scalar(r, g, b, &p, n);
    } else {
        let lm = luma_weights(m);
        let vib6 = vib * 0.6;
        let (c1, c2) = (sat * (1.0 + vib6), sat * vib6);
        for i in 0..n {
            let (nr, ng, nb) = tone_active(r[i], g[i], b[i], m, &lm, c1, c2);
            r[i] = nr;
            g[i] = ng;
            b[i] = nb;
        }
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2,fma")]
unsafe fn apply_tone_bulk_avx2(
    r: &mut [f32],
    g: &mut [f32],
    b: &mut [f32],
    m: &[[f32; 3]; 3],
    sat: f32,
    vib: f32,
    vib_zero: bool,
    n: usize,
) {
    // Safety: caller (apply_tone_bulk) passes n = min(r.len(), g.len(), b.len()) so all
    // three slices are guaranteed to have at least n elements.
    debug_assert!(n <= r.len() && n <= g.len() && n <= b.len());
    use core::arch::x86_64::*;
    let lanes = n / 8 * 8;
    let mut i = 0;
    if vib_zero {
        // M'·rgb — one matrix multiply covers matrix + sat blend + identity.
        // Delegated to the shared matrix-only kernel (same lanes + fused tail).
        let p = vib_zero_matrix(m, sat);
        apply_tone_bulk_matrix_avx2(r, g, b, &p, n);
    } else {
        let (m00, m01, m02) = (
            _mm256_set1_ps(m[0][0]),
            _mm256_set1_ps(m[0][1]),
            _mm256_set1_ps(m[0][2]),
        );
        let (m10, m11, m12) = (
            _mm256_set1_ps(m[1][0]),
            _mm256_set1_ps(m[1][1]),
            _mm256_set1_ps(m[1][2]),
        );
        let (m20, m21, m22) = (
            _mm256_set1_ps(m[2][0]),
            _mm256_set1_ps(m[2][1]),
            _mm256_set1_ps(m[2][2]),
        );
        let lm = luma_weights(m);
        let (l0, l1, l2) = (
            _mm256_set1_ps(lm[0]),
            _mm256_set1_ps(lm[1]),
            _mm256_set1_ps(lm[2]),
        );
        let one = _mm256_set1_ps(1.0);
        let zero = _mm256_setzero_ps();
        let vib6 = vib * 0.6;
        let c1 = _mm256_set1_ps(sat * (1.0 + vib6));
        let neg_c2 = _mm256_set1_ps(-(sat * vib6));
        while i < lanes {
            let vr = _mm256_loadu_ps(r.as_ptr().add(i));
            let vg = _mm256_loadu_ps(g.as_ptr().add(i));
            let vb = _mm256_loadu_ps(b.as_ptr().add(i));
            let r2 = _mm256_fmadd_ps(m00, vr, _mm256_fmadd_ps(m01, vg, _mm256_mul_ps(m02, vb)));
            let g2 = _mm256_fmadd_ps(m10, vr, _mm256_fmadd_ps(m11, vg, _mm256_mul_ps(m12, vb)));
            let b2 = _mm256_fmadd_ps(m20, vr, _mm256_fmadd_ps(m21, vg, _mm256_mul_ps(m22, vb)));
            // luma straight from input (decoupled from the matrix chain).
            let luma = _mm256_fmadd_ps(l0, vr, _mm256_fmadd_ps(l1, vg, _mm256_mul_ps(l2, vb)));
            let raw_mx = _mm256_max_ps(_mm256_max_ps(r2, g2), b2);
            let mx = _mm256_max_ps(raw_mx, one);
            let mn = _mm256_max_ps(_mm256_min_ps(_mm256_min_ps(r2, g2), b2), zero);
            let inv = _mm256_div_ps(one, mx);
            let psat = _mm256_and_ps(
                _mm256_fnmadd_ps(mn, inv, one),
                _mm256_cmp_ps::<_CMP_GT_OQ>(raw_mx, zero),
            );
            let scale = _mm256_fmadd_ps(neg_c2, psat, c1);
            let nr = _mm256_fmadd_ps(scale, _mm256_sub_ps(r2, luma), luma);
            let ng = _mm256_fmadd_ps(scale, _mm256_sub_ps(g2, luma), luma);
            let nb = _mm256_fmadd_ps(scale, _mm256_sub_ps(b2, luma), luma);
            _mm256_storeu_ps(r.as_mut_ptr().add(i), nr);
            _mm256_storeu_ps(g.as_mut_ptr().add(i), ng);
            _mm256_storeu_ps(b.as_mut_ptr().add(i), nb);
            i += 8;
        }
        // scalar tail via the oracle → parity on the ragged end (vibrance-active path).
        while i < n {
            let (r2, g2, b2) = apply_tone_math(r[i], g[i], b[i], m, sat, vib, vib_zero, false);
            r[i] = r2;
            g[i] = g2;
            b[i] = b2;
            i += 1;
        }
    }
}

/// wasm32 SIMD128 (`f32x4`) bulk tone math — the wasm peer of `apply_tone_bulk_avx2`.
/// Baseline simd128 has no fused multiply-add intrinsic; `mul`+`add` is used, which
/// stays inside the same reassociation tolerance the parity tests assert.
#[cfg(target_arch = "wasm32")]
fn apply_tone_bulk_wasm(
    r: &mut [f32],
    g: &mut [f32],
    b: &mut [f32],
    m: &[[f32; 3]; 3],
    sat: f32,
    vib: f32,
    vib_zero: bool,
    n: usize,
) {
    use core::arch::wasm32::*;
    let lanes = n / 4 * 4;
    let mut i = 0;
    unsafe {
        if vib_zero {
            // Delegated to the shared matrix-only kernel (same lanes + fused mul+add tail).
            // It processes the full [0, n) range, so advance `i` to `n` to make the shared
            // scalar tail below a no-op (otherwise it would re-apply the matrix to every pixel).
            let p = vib_zero_matrix(m, sat);
            apply_tone_bulk_matrix_wasm(r, g, b, &p, n);
            i = n;
        } else {
            let (m00, m01, m02) = (
                f32x4_splat(m[0][0]),
                f32x4_splat(m[0][1]),
                f32x4_splat(m[0][2]),
            );
            let (m10, m11, m12) = (
                f32x4_splat(m[1][0]),
                f32x4_splat(m[1][1]),
                f32x4_splat(m[1][2]),
            );
            let (m20, m21, m22) = (
                f32x4_splat(m[2][0]),
                f32x4_splat(m[2][1]),
                f32x4_splat(m[2][2]),
            );
            let lm = luma_weights(m);
            let (l0, l1, l2) = (f32x4_splat(lm[0]), f32x4_splat(lm[1]), f32x4_splat(lm[2]));
            let one = f32x4_splat(1.0);
            let zero = f32x4_splat(0.0);
            let vib6 = vib * 0.6;
            let c1 = f32x4_splat(sat * (1.0 + vib6));
            let neg_c2 = f32x4_splat(-(sat * vib6));
            while i < lanes {
                let vr = v128_load(r.as_ptr().add(i) as *const v128);
                let vg = v128_load(g.as_ptr().add(i) as *const v128);
                let vb = v128_load(b.as_ptr().add(i) as *const v128);
                let r2 = f32x4_add(
                    f32x4_mul(m00, vr),
                    f32x4_add(f32x4_mul(m01, vg), f32x4_mul(m02, vb)),
                );
                let g2 = f32x4_add(
                    f32x4_mul(m10, vr),
                    f32x4_add(f32x4_mul(m11, vg), f32x4_mul(m12, vb)),
                );
                let b2 = f32x4_add(
                    f32x4_mul(m20, vr),
                    f32x4_add(f32x4_mul(m21, vg), f32x4_mul(m22, vb)),
                );
                let luma = f32x4_add(
                    f32x4_mul(l0, vr),
                    f32x4_add(f32x4_mul(l1, vg), f32x4_mul(l2, vb)),
                );
                let raw_mx = f32x4_max(f32x4_max(r2, g2), b2);
                let mx = f32x4_max(raw_mx, one);
                let mn = f32x4_max(f32x4_min(f32x4_min(r2, g2), b2), zero);
                // PIPE-010 (evaluated, no change): f32x4_div(one, mx) is the exact reciprocal.
                // WASM SIMD128 has no reciprocal-estimate intrinsic (x86 rcp is not available).
                // A Newton-Raphson approximation would need more ops than the divide on WASM.
                // The vibrance path is also a minority branch (only when vib != 0). No net gain.
                let inv = f32x4_div(one, mx);
                let psat = v128_and(f32x4_sub(one, f32x4_mul(mn, inv)), f32x4_gt(raw_mx, zero));
                let scale = f32x4_add(c1, f32x4_mul(neg_c2, psat));
                let nr = f32x4_add(luma, f32x4_mul(scale, f32x4_sub(r2, luma)));
                let ng = f32x4_add(luma, f32x4_mul(scale, f32x4_sub(g2, luma)));
                let nb = f32x4_add(luma, f32x4_mul(scale, f32x4_sub(b2, luma)));
                v128_store(r.as_mut_ptr().add(i) as *mut v128, nr);
                v128_store(g.as_mut_ptr().add(i) as *mut v128, ng);
                v128_store(b.as_mut_ptr().add(i) as *mut v128, nb);
                i += 4;
            }
        }
    }
    // scalar tail via the oracle → guaranteed parity.
    while i < n {
        let (r2, g2, b2) = apply_tone_math(r[i], g[i], b[i], m, sat, vib, vib_zero, false);
        r[i] = r2;
        g[i] = g2;
        b[i] = b2;
        i += 1;
    }
}

/// Apply an **already-prepared** 3×3 tone matrix `M'` in-place over the SoA planes.
///
/// This is the body of the `vib_zero` branch with preparation lifted out: the caller
/// owns `M'`. In the normal no-vibrance path that is the `matrix_fused` matrix that
/// `pipeline::derive_tone_inputs` builds **once per render** (via the same
/// `vib_zero_matrix`), so the block loop no longer rebuilds it for every ~2048-pixel
/// block. Byte-exact to the `vib_zero` path of `apply_tone_bulk` (identical lanes and
/// fused tail). Dispatches AVX2+FMA / SIMD128 / branchless scalar exactly like
/// `apply_tone_bulk`; length is clamped to the shortest slice.
#[inline]
pub fn apply_tone_bulk_matrix(r: &mut [f32], g: &mut [f32], b: &mut [f32], p: &[[f32; 3]; 3]) {
    let n = r.len().min(g.len()).min(b.len());
    debug_assert_eq!(g.len(), r.len());
    debug_assert_eq!(b.len(), r.len());
    #[cfg(target_arch = "x86_64")]
    {
        if std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma") {
            unsafe { apply_tone_bulk_matrix_avx2(r, g, b, p, n) };
            return;
        }
    }
    #[cfg(target_arch = "wasm32")]
    {
        apply_tone_bulk_matrix_wasm(r, g, b, p, n);
        return;
    }
    #[allow(unreachable_code)]
    apply_tone_bulk_matrix_scalar(r, g, b, p, n);
}

/// Scalar matrix-only matvec (`M'·rgb`), FMA via `mul_add`. Matches the previous inline
/// `vib_zero` scalar body verbatim.
#[inline]
fn apply_tone_bulk_matrix_scalar(
    r: &mut [f32],
    g: &mut [f32],
    b: &mut [f32],
    p: &[[f32; 3]; 3],
    n: usize,
) {
    for i in 0..n {
        let (rr, gg, bb) = (r[i], g[i], b[i]);
        r[i] = p[0][0].mul_add(rr, p[0][1].mul_add(gg, p[0][2] * bb));
        g[i] = p[1][0].mul_add(rr, p[1][1].mul_add(gg, p[1][2] * bb));
        b[i] = p[2][0].mul_add(rr, p[2][1].mul_add(gg, p[2][2] * bb));
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2,fma")]
unsafe fn apply_tone_bulk_matrix_avx2(
    r: &mut [f32],
    g: &mut [f32],
    b: &mut [f32],
    p: &[[f32; 3]; 3],
    n: usize,
) {
    // Safety: callers pass n = min(r.len(), g.len(), b.len()); all three slices hold ≥ n.
    debug_assert!(n <= r.len() && n <= g.len() && n <= b.len());
    use core::arch::x86_64::*;
    let lanes = n / 8 * 8;
    let mut i = 0;
    let (p00, p01, p02) = (
        _mm256_set1_ps(p[0][0]),
        _mm256_set1_ps(p[0][1]),
        _mm256_set1_ps(p[0][2]),
    );
    let (p10, p11, p12) = (
        _mm256_set1_ps(p[1][0]),
        _mm256_set1_ps(p[1][1]),
        _mm256_set1_ps(p[1][2]),
    );
    let (p20, p21, p22) = (
        _mm256_set1_ps(p[2][0]),
        _mm256_set1_ps(p[2][1]),
        _mm256_set1_ps(p[2][2]),
    );
    while i < lanes {
        let vr = _mm256_loadu_ps(r.as_ptr().add(i));
        let vg = _mm256_loadu_ps(g.as_ptr().add(i));
        let vb = _mm256_loadu_ps(b.as_ptr().add(i));
        let nr = _mm256_fmadd_ps(p00, vr, _mm256_fmadd_ps(p01, vg, _mm256_mul_ps(p02, vb)));
        let ng = _mm256_fmadd_ps(p10, vr, _mm256_fmadd_ps(p11, vg, _mm256_mul_ps(p12, vb)));
        let nb = _mm256_fmadd_ps(p20, vr, _mm256_fmadd_ps(p21, vg, _mm256_mul_ps(p22, vb)));
        _mm256_storeu_ps(r.as_mut_ptr().add(i), nr);
        _mm256_storeu_ps(g.as_mut_ptr().add(i), ng);
        _mm256_storeu_ps(b.as_mut_ptr().add(i), nb);
        i += 8;
    }
    // Fused tail — reuse the SAME M' as the lanes so the ragged block end stays byte-exact.
    while i < n {
        let (rr, gg, bb) = (r[i], g[i], b[i]);
        r[i] = p[0][0].mul_add(rr, p[0][1].mul_add(gg, p[0][2] * bb));
        g[i] = p[1][0].mul_add(rr, p[1][1].mul_add(gg, p[1][2] * bb));
        b[i] = p[2][0].mul_add(rr, p[2][1].mul_add(gg, p[2][2] * bb));
        i += 1;
    }
}

/// wasm32 SIMD128 matrix-only matvec — `mul`+`add` (no FMA), matching the previous inline
/// `vib_zero` wasm body. Processes the full `[0, n)` range (lanes + scalar mul+add tail).
#[cfg(target_arch = "wasm32")]
fn apply_tone_bulk_matrix_wasm(
    r: &mut [f32],
    g: &mut [f32],
    b: &mut [f32],
    p: &[[f32; 3]; 3],
    n: usize,
) {
    use core::arch::wasm32::*;
    let lanes = n / 4 * 4;
    let mut i = 0;
    unsafe {
        let (p00, p01, p02) = (
            f32x4_splat(p[0][0]),
            f32x4_splat(p[0][1]),
            f32x4_splat(p[0][2]),
        );
        let (p10, p11, p12) = (
            f32x4_splat(p[1][0]),
            f32x4_splat(p[1][1]),
            f32x4_splat(p[1][2]),
        );
        let (p20, p21, p22) = (
            f32x4_splat(p[2][0]),
            f32x4_splat(p[2][1]),
            f32x4_splat(p[2][2]),
        );
        while i < lanes {
            let vr = v128_load(r.as_ptr().add(i) as *const v128);
            let vg = v128_load(g.as_ptr().add(i) as *const v128);
            let vb = v128_load(b.as_ptr().add(i) as *const v128);
            let nr = f32x4_add(
                f32x4_mul(p00, vr),
                f32x4_add(f32x4_mul(p01, vg), f32x4_mul(p02, vb)),
            );
            let ng = f32x4_add(
                f32x4_mul(p10, vr),
                f32x4_add(f32x4_mul(p11, vg), f32x4_mul(p12, vb)),
            );
            let nb = f32x4_add(
                f32x4_mul(p20, vr),
                f32x4_add(f32x4_mul(p21, vg), f32x4_mul(p22, vb)),
            );
            v128_store(r.as_mut_ptr().add(i) as *mut v128, nr);
            v128_store(g.as_mut_ptr().add(i) as *mut v128, ng);
            v128_store(b.as_mut_ptr().add(i) as *mut v128, nb);
            i += 4;
        }
    }
    // Fused tail (mul+add to match the lanes; simd128 has no FMA).
    while i < n {
        let (rr, gg, bb) = (r[i], g[i], b[i]);
        r[i] = p[0][0] * rr + (p[0][1] * gg + p[0][2] * bb);
        g[i] = p[1][0] * rr + (p[1][1] * gg + p[1][2] * bb);
        b[i] = p[2][0] * rr + (p[2][1] * gg + p[2][2] * bb);
        i += 1;
    }
}

/// Fused single-pass tone for the caller's `process_into_simd` shape (Blueprint
/// Ch.1/6: eliminate copies + per-block zeroing, fuse kernels). Interleaved u16 →
/// pre-LUT gather → matrix/sat/vibrance (SIMD via `apply_tone_bulk`) → post-LUT →
/// interleaved u8, reusing **one** stack SoA scratch (zeroed once, not per block).
///
/// `pre_*` (65536×u16) and `post` (65536×u8) are the caller-owned LUTs. Byte-exact to
/// the explicit pre-LUT → `apply_tone_bulk` → post-LUT two-pass (same kernel, same
/// clamp, same LUTs).
///
/// STATUS (2026-06): on an isolated single-thread bench this is ~0.8–0.9× the
/// two-pass — the path is **gather-bound** (random-access LUT lookups dominate; the
/// SoA round-trip it removes is L1-resident and the per-block stack zeroing is
/// effectively free). Retained as a dormant primitive: it becomes a win once the
/// surrounding cost is moved — cache-resident/smaller LUTs, SIMD gather, or a fused
/// post-LUT — at which point removing the round-trip and zeroing matters. See
/// `docs/ToneSimd-LutGather-JsWasm-handoff.md`.
pub fn apply_tone_fused_u16_u8(
    rgb16: &[u16],
    pre_r: &[u16],
    pre_g: &[u16],
    pre_b: &[u16],
    post: &[u8],
    m: &[[f32; 3]; 3],
    sat: f32,
    vib: f32,
    vib_zero: bool,
    out: &mut [u8],
) {
    // Each pre-LUT must cover the full u16 range so that rgb16[i] (any u16 value) is a valid index.
    assert!(
        pre_r.len() >= 65536,
        "apply_tone_fused_u16_u8: pre_r must have at least 65536 entries"
    );
    assert!(
        pre_g.len() >= 65536,
        "apply_tone_fused_u16_u8: pre_g must have at least 65536 entries"
    );
    assert!(
        pre_b.len() >= 65536,
        "apply_tone_fused_u16_u8: pre_b must have at least 65536 entries"
    );
    // The post-LUT is indexed by the full u16 domain (clamped f32→u16), so it must cover it too.
    assert!(
        post.len() >= 65536,
        "apply_tone_fused_u16_u8: post must have at least 65536 entries"
    );
    const BLK: usize = 2048;
    let np = (rgb16.len() / 3).min(out.len() / 3);
    // One reused stack scratch (zeroed once), not a fresh zeroed buffer per block.
    let mut rs = [0f32; BLK];
    let mut gs = [0f32; BLK];
    let mut bs = [0f32; BLK];
    let mut p = 0;
    while p < np {
        let cnt = (np - p).min(BLK);
        for i in 0..cnt {
            let j = 3 * (p + i);
            rs[i] = pre_r[rgb16[j] as usize] as f32;
            gs[i] = pre_g[rgb16[j + 1] as usize] as f32;
            bs[i] = pre_b[rgb16[j + 2] as usize] as f32;
        }
        apply_tone_bulk(
            &mut rs[..cnt],
            &mut gs[..cnt],
            &mut bs[..cnt],
            m,
            sat,
            vib,
            vib_zero,
        );
        for i in 0..cnt {
            let j = 3 * (p + i);
            out[j] = post[(rs[i].clamp(0.0, 65535.0) as u16) as usize];
            out[j + 1] = post[(gs[i].clamp(0.0, 65535.0) as u16) as usize];
            out[j + 2] = post[(bs[i].clamp(0.0, 65535.0) as u16) as usize];
        }
        p += cnt;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: [[f32; 3]; 3] = [[1.7, -0.5, -0.2], [-0.3, 1.4, -0.1], [0.0, -0.4, 1.4]];

    fn data(n: usize) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
        let mut r = vec![0f32; n];
        let mut g = vec![0f32; n];
        let mut b = vec![0f32; n];
        for i in 0..n {
            let f = i as f32;
            r[i] = (f * 0.013).sin() * 30000.0 + 30000.0;
            g[i] = (f * 0.021).cos() * 28000.0 + 30000.0;
            b[i] = (f * 0.017).sin() * 25000.0 + 28000.0;
        }
        (r, g, b)
    }

    fn ok(a: f32, b: f32) -> bool {
        // Tone values live in the 0..65535 post-LUT-index domain; an absolute diff
        // < 1.0 can't move the output past the adjacent LUT entry. FMA reassociation
        // noise is ~0.005 abs, so |Δ| < 0.05 (10× noise) OR rel < 1e-3 is the real
        // parity criterion — a true logic error would diverge far past it.
        (a - b).abs() < 0.05 || (a - b).abs() / a.abs().max(b.abs()).max(1e-6) < 1e-3
    }

    fn oracle(
        r: &[f32],
        g: &[f32],
        b: &[f32],
        m: &[[f32; 3]; 3],
        sat: f32,
        vib: f32,
        vib_zero: bool,
    ) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
        let (mut sr, mut sg, mut sb) = (r.to_vec(), g.to_vec(), b.to_vec());
        for i in 0..r.len() {
            let (r2, g2, b2) = apply_tone_math(sr[i], sg[i], sb[i], m, sat, vib, vib_zero, false);
            sr[i] = r2;
            sg[i] = g2;
            sb[i] = b2;
        }
        (sr, sg, sb)
    }

    fn assert_parity(sr: &[f32], sg: &[f32], sb: &[f32], ar: &[f32], ag: &[f32], ab: &[f32]) {
        for i in 0..sr.len() {
            assert!(ok(sr[i], ar[i]), "r[{i}] {} vs {}", sr[i], ar[i]);
            assert!(ok(sg[i], ag[i]), "g[{i}] {} vs {}", sg[i], ag[i]);
            assert!(ok(sb[i], ab[i]), "b[{i}] {} vs {}", sb[i], ab[i]);
        }
    }

    // Auto-dispatched path (SIMD on capable hosts).
    fn check(m: &[[f32; 3]; 3], vib_zero: bool, sat: f32, vib: f32, n: usize) {
        let (r0, g0, b0) = data(n);
        let (sr, sg, sb) = oracle(&r0, &g0, &b0, m, sat, vib, vib_zero);
        let (mut ar, mut ag, mut ab) = (r0.clone(), g0.clone(), b0.clone());
        apply_tone_bulk(&mut ar, &mut ag, &mut ab, m, sat, vib, vib_zero);
        assert_parity(&sr, &sg, &sb, &ar, &ag, &ab);
    }

    // Branchless scalar path explicitly (not reached by check() on SIMD hosts).
    fn check_scalar(m: &[[f32; 3]; 3], vib_zero: bool, sat: f32, vib: f32, n: usize) {
        let (r0, g0, b0) = data(n);
        let (sr, sg, sb) = oracle(&r0, &g0, &b0, m, sat, vib, vib_zero);
        let (mut ar, mut ag, mut ab) = (r0.clone(), g0.clone(), b0.clone());
        apply_tone_bulk_ref(&mut ar, &mut ag, &mut ab, m, sat, vib, vib_zero);
        assert_parity(&sr, &sg, &sb, &ar, &ag, &ab);
    }

    #[test]
    fn parity_vib_zero() {
        check(&M, true, 1.30, 0.0, 1000);
    }
    #[test]
    fn parity_vibrance_active() {
        check(&M, false, 1.30, 0.5, 1000);
    }
    #[test]
    fn parity_desaturate() {
        check(&M, false, 0.7, -0.4, 1000);
    }

    #[test]
    fn parity_identity_fast_path() {
        check(&M, true, 1.0, 0.0, 1000);
    }

    #[test]
    fn parity_full_desaturate() {
        check(&M, true, 0.0, 0.0, 1000);
    }

    #[test]
    fn parity_empty() {
        let mut e: Vec<f32> = vec![];
        let (mut a, mut bb) = (Vec::<f32>::new(), Vec::<f32>::new());
        apply_tone_bulk(&mut a, &mut bb, &mut e, &M, 1.3, 0.5, false);
    }

    #[test]
    fn parity_pure_tail() {
        // n < lane width → only the scalar tail runs.
        check(&M, false, 1.30, 0.5, 3);
        check(&M, false, 1.30, 0.5, 7);
        check(&M, true, 1.0, 0.0, 5);
    }

    #[test]
    fn parity_negative_matrix() {
        // All-negative post-matrix → raw_mx <= 0 → exercises the masked-inv branch
        // that the positive M never reaches.
        const NEG: [[f32; 3]; 3] = [[-1.0, -1.0, -1.0], [-1.0, -1.0, -1.0], [-1.0, -1.0, -1.0]];
        check(&NEG, false, 1.30, 0.5, 64);
        check_scalar(&NEG, false, 1.30, 0.5, 64);
    }

    #[test]
    fn parity_scalar_paths() {
        check_scalar(&M, true, 1.30, 0.0, 1000);
        check_scalar(&M, false, 1.30, 0.5, 1000);
        check_scalar(&M, false, 0.7, -0.4, 1000);
        check_scalar(&M, true, 1.0, 0.0, 1000);
    }

    // Locks the algebra: M'·rgb == luma + sat·(M·rgb - luma), and sat==1 ⇒ M'==M.
    #[test]
    fn algebra_vib_zero_matrix() {
        let lm = luma_weights(&M);
        for &sat in &[0.0f32, 0.5, 1.0, 1.3] {
            let p = vib_zero_matrix(&M, sat);
            for &(rr, gg, bb) in &[
                (12000.0f32, 30000.0, 51000.0),
                (0.0, 0.0, 0.0),
                (60000.0, 5.0, 33000.0),
            ] {
                let r2 = M[0][0] * rr + M[0][1] * gg + M[0][2] * bb;
                let g2 = M[1][0] * rr + M[1][1] * gg + M[1][2] * bb;
                let b2 = M[2][0] * rr + M[2][1] * gg + M[2][2] * bb;
                let luma = lm[0] * rr + lm[1] * gg + lm[2] * bb;
                let want = (
                    luma + sat * (r2 - luma),
                    luma + sat * (g2 - luma),
                    luma + sat * (b2 - luma),
                );
                let got = (
                    p[0][0] * rr + p[0][1] * gg + p[0][2] * bb,
                    p[1][0] * rr + p[1][1] * gg + p[1][2] * bb,
                    p[2][0] * rr + p[2][1] * gg + p[2][2] * bb,
                );
                assert!(
                    ok(want.0, got.0) && ok(want.1, got.1) && ok(want.2, got.2),
                    "sat={sat} want={want:?} got={got:?}"
                );
            }
        }
        // sat==1 ⇒ identity.
        let p1 = vib_zero_matrix(&M, 1.0);
        for i in 0..3 {
            for j in 0..3 {
                assert!((p1[i][j] - M[i][j]).abs() < 1e-4);
            }
        }
    }

    // Fused u16→u8 path is byte-exact to the explicit two-pass (pre-LUT, tone, post-LUT).
    #[test]
    fn parity_fused_u16_u8() {
        let pre: Vec<u16> = (0..=65535u32).map(|x| x as u16).collect();
        let post: Vec<u8> = (0..=65535u32).map(|x| (x >> 8) as u8).collect();
        let np = 1000usize;
        let mut rgb16 = vec![0u16; np * 3];
        for i in 0..np {
            rgb16[3 * i] = (i.wrapping_mul(7919) & 0xffff) as u16;
            rgb16[3 * i + 1] = (i.wrapping_mul(104729) & 0xffff) as u16;
            rgb16[3 * i + 2] = (i.wrapping_mul(1299709) & 0xffff) as u16;
        }
        for &(vz, sat, vib) in &[
            (true, 1.3f32, 0f32),
            (false, 1.3, 0.5),
            (false, 0.7, -0.4),
            (true, 1.0, 0.0),
        ] {
            // explicit two-pass oracle
            let (mut r, mut g, mut b) = (vec![0f32; np], vec![0f32; np], vec![0f32; np]);
            for i in 0..np {
                r[i] = pre[rgb16[3 * i] as usize] as f32;
                g[i] = pre[rgb16[3 * i + 1] as usize] as f32;
                b[i] = pre[rgb16[3 * i + 2] as usize] as f32;
            }
            apply_tone_bulk(&mut r, &mut g, &mut b, &M, sat, vib, vz);
            let mut want = vec![0u8; np * 3];
            for i in 0..np {
                want[3 * i] = post[(r[i].clamp(0.0, 65535.0) as u16) as usize];
                want[3 * i + 1] = post[(g[i].clamp(0.0, 65535.0) as u16) as usize];
                want[3 * i + 2] = post[(b[i].clamp(0.0, 65535.0) as u16) as usize];
            }
            // fused
            let mut got = vec![0u8; np * 3];
            apply_tone_fused_u16_u8(&rgb16, &pre, &pre, &pre, &post, &M, sat, vib, vz, &mut got);
            assert_eq!(want, got, "fused mismatch vz={vz} sat={sat} vib={vib}");
        }
    }

    // Parity across lengths that straddle the SIMD lane width (full vectors + a ragged
    // tail of every residue), for both the vib_zero (matrix-only) and active paths.
    #[test]
    fn parity_vector_plus_tail() {
        for &n in &[1usize, 3, 7, 8, 9, 15, 16, 17, 31, 1009] {
            check(&M, true, 1.30, 0.0, n);
            check(&M, false, 1.30, 0.5, n);
            check_scalar(&M, true, 1.30, 0.0, n);
            check_scalar(&M, false, 1.30, 0.5, n);
        }
    }

    // The prepared matrix-only kernel (`apply_tone_bulk_matrix`) must be BIT-IDENTICAL to the
    // vib_zero path of `apply_tone_bulk` — both run the same lanes + fused tail on the same M'.
    // This locks the seam used by `simd_block_kernel` (which feeds it `ti.matrix_fused`).
    #[test]
    fn matrix_only_matches_vib_zero_path() {
        for &n in &[3usize, 7, 8, 17, 1009] {
            for &sat in &[0.0f32, 0.5, 1.0, 1.30] {
                let (r0, g0, b0) = data(n);
                // regular vib_zero path
                let (mut vr, mut vg, mut vb) = (r0.clone(), g0.clone(), b0.clone());
                apply_tone_bulk(&mut vr, &mut vg, &mut vb, &M, sat, 0.0, true);
                // prepared matrix-only path
                let p = vib_zero_matrix(&M, sat);
                let (mut mr, mut mg, mut mb) = (r0, g0, b0);
                apply_tone_bulk_matrix(&mut mr, &mut mg, &mut mb, &p);
                assert_eq!(
                    vr.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
                    mr.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
                    "r n={n} sat={sat}"
                );
                assert_eq!(
                    vg.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
                    mg.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
                    "g n={n} sat={sat}"
                );
                assert_eq!(
                    vb.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
                    mb.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
                    "b n={n} sat={sat}"
                );
            }
        }
    }
}
