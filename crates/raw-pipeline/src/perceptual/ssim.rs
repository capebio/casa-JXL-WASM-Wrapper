//! Global moment-based SSIM (image-wide, no local windows) — port of the legacy
//! JS `computeSsimVsFinal`. Channel-averaged over the first min(channels,3).

const C1: f64 = (0.01 * 255.0) * (0.01 * 255.0); // 6.5025
const C2: f64 = (0.03 * 255.0) * (0.03 * 255.0); // 58.5225

/// Per-channel raw moments of a reference buffer: (sum, sum_sq) for c in 0..3.
/// Precomputed once per reference. `ch` is the channel stride (4 for RGBA).
pub(crate) fn ref_moments(b: &[u8], np: usize, ch: usize) -> ([u64; 3], [u64; 3]) {
    // Length precondition: the loop reads b[j+c] with j up to (np-1)*ch and
    // c in 0..ch.min(3); a short buffer would otherwise index-OOB with no
    // descriptive message. No-op for the sized caller (b.len()==np*4, ch==4).
    // Mirrors the assert in ssim_moments_avx2 (simd/avx2.rs).
    assert!(
        ch == 0 || np == 0 || b.len() >= (np - 1) * ch + ch.min(3),
        "ref_moments: b.len() must hold np pixels of stride ch"
    );
    let wch = ch.min(3);
    let mut sb = [0u64; 3];
    let mut sbb = [0u64; 3];
    let mut j = 0;
    for _ in 0..np {
        for c in 0..wch {
            let y = b[j + c] as u64;
            sb[c] += y;
            sbb[c] += y * y;
        }
        j += ch;
    }
    (sb, sbb)
}

/// SSIM of `a` (test) vs precomputed reference moments. `sab`/`saa`/`sa` are
/// accumulated here over the test buffer paired with the reference bytes `b`.
pub(crate) fn ssim_with_ref(
    a: &[u8],
    b: &[u8],
    np: usize,
    ch: usize,
    sb: &[u64; 3],
    sbb: &[u64; 3],
) -> f32 {
    if np == 0 {
        return 0.0;
    }
    // Length precondition: both buffers must hold np pixels of stride ch. The
    // loop reads a[j+c]/b[j+c] with j up to (np-1)*ch and c in 0..ch.min(3);
    // a short buffer would otherwise index-OOB with no descriptive message.
    // No-op for the sized caller (len==np*4, ch==4). Mirrors ssim_moments_avx2.
    assert!(
        ch == 0 || (a.len() >= (np - 1) * ch + ch.min(3) && b.len() >= (np - 1) * ch + ch.min(3)),
        "ssim_with_ref: a.len()/b.len() must hold np pixels of stride ch"
    );
    let wch = ch.min(3);
    let (sa, saa, sab) = ssim_sums(a, b, np, ch);
    finalize_ssim(&sa, sb, &saa, sbb, &sab, np, wch)
}

/// The scalar SSIM accumulation: per-channel test sums `sa=Σx`, `saa=Σx²`, and the
/// cross term `sab=Σxy` over `np` pixels of stride `ch`. Split out of
/// `ssim_with_ref` so `all()` can reuse `sa`/`saa` for `channel_moments` instead of
/// re-streaming the test buffer (the SIMD backends already return these three sums).
pub(crate) fn ssim_sums(
    a: &[u8],
    b: &[u8],
    np: usize,
    ch: usize,
) -> ([u64; 3], [u64; 3], [u64; 3]) {
    let wch = ch.min(3);
    let mut sa = [0u64; 3];
    let mut saa = [0u64; 3];
    let mut sab = [0u64; 3];
    let mut j = 0;
    for _ in 0..np {
        for c in 0..wch {
            let x = a[j + c] as u64;
            let y = b[j + c] as u64;
            sa[c] += x;
            saa[c] += x * x;
            sab[c] += x * y;
        }
        j += ch;
    }
    (sa, saa, sab)
}

/// Derive `channel_moments`' (mus, vars) directly from the test sums `sa=Σx`,
/// `saa=Σx²` that the SSIM path already accumulated. Bit-identical to
/// `channel_moments` (same u64 sums, same f64 arithmetic) while saving a full
/// strided pass over the test buffer. `nch` is the channel count moments cover.
pub(crate) fn moments_from_sums(
    sa: &[u64; 3],
    saa: &[u64; 3],
    np: usize,
    nch: usize,
) -> ([f32; 3], [f32; 3], usize) {
    let nch = nch.min(3);
    let mut mus = [0f32; 3];
    let mut vars = [0f32; 3];
    if np == 0 {
        return (mus, vars, 0);
    }
    let n = np as f64;
    for c in 0..nch {
        let mu = sa[c] as f64 / n;
        mus[c] = mu as f32;
        vars[c] = (saa[c] as f64 / n - mu * mu) as f32;
    }
    (mus, vars, nch)
}

/// Combine accumulated moments into the channel-averaged SSIM scalar. Shared by
/// the scalar path and the SIMD path (which produces the same five sums).
pub(crate) fn finalize_ssim(
    sa: &[u64; 3],
    sb: &[u64; 3],
    saa: &[u64; 3],
    sbb: &[u64; 3],
    sab: &[u64; 3],
    np: usize,
    wch: usize,
) -> f32 {
    if wch == 0 {
        return 0.0;
    }
    // Guard np==0: dividing by n below would produce NaN that propagates silently
    // through consumer arithmetic. Return 0.0 for degenerate empty buffers.
    if np == 0 {
        return 0.0;
    }
    let n = np as f64;
    let mut s = 0.0f64;
    for c in 0..wch {
        let mua = sa[c] as f64 / n;
        let mub = sb[c] as f64 / n;
        let va = saa[c] as f64 / n - mua * mua;
        let vb = sbb[c] as f64 / n - mub * mub;
        let cov = sab[c] as f64 / n - mua * mub;
        let num = (2.0 * mua * mub + C1) * (2.0 * cov + C2);
        let den = (mua * mua + mub * mub + C1) * (va + vb + C2);
        s += num / den;
    }
    (s / wch as f64) as f32
}

/// Per-channel mean/variance feature side-output (port of `computeChannelMoments`).
pub(crate) fn channel_moments(
    px: &[u8],
    np: usize,
    ch: usize,
    max_ch: usize,
) -> ([f32; 3], [f32; 3], usize) {
    let nch = max_ch.min(ch).min(3);
    let mut mus = [0f32; 3];
    let mut vars = [0f32; 3];
    if np == 0 {
        return (mus, vars, 0);
    }
    // Length precondition: px must hold np pixels of stride ch. The loop reads
    // px[j] with j up to (np-1)*ch + (nch-1); a short buffer would otherwise
    // index-OOB with no descriptive message. No-op for the sized caller
    // (px.len()==np*4, ch==4). Mirrors the assert in ssim_moments_avx2.
    assert!(
        nch == 0 || px.len() >= (np - 1) * ch + nch,
        "channel_moments: px.len() must hold np pixels of stride ch"
    );
    let n = np as f64;
    for c in 0..nch {
        let mut sum = 0u64;
        let mut sum2 = 0u64;
        let mut j = c;
        for _ in 0..np {
            let v = px[j] as u64;
            sum += v;
            sum2 += v * v;
            j += ch;
        }
        let mu = sum as f64 / n;
        mus[c] = mu as f32;
        vars[c] = (sum2 as f64 / n - mu * mu) as f32;
    }
    (mus, vars, nch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_rgba_is_one() {
        let a = [
            10u8, 200, 30, 255, 90, 40, 160, 255, 5, 5, 5, 255, 250, 1, 128, 255,
        ];
        let np = 4;
        let (sb, sbb) = ref_moments(&a, np, 4);
        let s = ssim_with_ref(&a, &a, np, 4, &sb, &sbb);
        assert!(
            (s - 1.0).abs() < 1e-5,
            "identical SSIM should be ~1, got {s}"
        );
    }

    #[test]
    fn matches_js_reference_value() {
        // Deterministic 2x2 RGBA; expected computed offline from the JS formula.
        let a = [
            0u8, 0, 0, 255, 255, 255, 255, 255, 64, 128, 192, 255, 200, 100, 50, 255,
        ];
        let mut b = a;
        b[0] = 20;
        b[5] = 200;
        b[8] = 70;
        let np = 4;
        let (sb, sbb) = ref_moments(&b, np, 4);
        let s = ssim_with_ref(&a, &b, np, 4, &sb, &sbb);
        // Reference value computed from the JS computeSsimVsFinal formula on the same buffers.
        // (Mathematically verified: ch0=0.9954, ch1=0.9510, ch2=1.0 → avg=0.9821)
        assert!((s - 0.982_1).abs() < 5e-3, "got {s}");
    }
}
