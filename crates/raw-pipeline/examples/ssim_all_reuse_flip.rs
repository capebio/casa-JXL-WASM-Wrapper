//! ssim_all_reuse_flip — thermal-cancelled A/B for Comparer::all()'s moment work.
//!
//! all() calls ssim() (which accumulates per-channel sa=Σx, saa=Σx² over the test
//! buffer) and then channel_moments(), which streams the SAME test buffer again to
//! recompute Σx / Σx². But mus[c]=sa/n and vars[c]=saa/n-mu² are exactly derivable
//! from the sa/saa the SSIM path already computed and threw away.
//!
//!   A = current: ssim_with_ref(full pass) THEN channel_moments(second full pass)
//!   B = fused:   one pass computes sa/saa/sab (ssim) AND derives mus/vars from sa/saa
//!
//! Parity must be BIT-EXACT: identical u64 sums, identical f64 arithmetic.
//! Interleaved, start-rotated, round 0 dropped.
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example ssim_all_reuse_flip

use std::time::Instant;

const C1: f64 = (0.01 * 255.0) * (0.01 * 255.0);
const C2: f64 = (0.03 * 255.0) * (0.03 * 255.0);

fn ref_moments(b: &[u8], np: usize, ch: usize) -> ([u64; 3], [u64; 3]) {
    let wch = ch.min(3);
    let (mut sb, mut sbb) = ([0u64; 3], [0u64; 3]);
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

fn finalize(
    sa: &[u64; 3],
    sb: &[u64; 3],
    saa: &[u64; 3],
    sbb: &[u64; 3],
    sab: &[u64; 3],
    np: usize,
    wch: usize,
) -> f32 {
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

// ---- shared SSIM pass: accumulates sa/saa/sab, returns them + the score ----
fn ssim_pass(
    a: &[u8],
    b: &[u8],
    np: usize,
    ch: usize,
    sb: &[u64; 3],
    sbb: &[u64; 3],
) -> (f32, [u64; 3], [u64; 3]) {
    let wch = ch.min(3);
    let (mut sa, mut saa, mut sab) = ([0u64; 3], [0u64; 3], [0u64; 3]);
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
    (finalize(&sa, sb, &saa, sbb, &sab, np, wch), sa, saa)
}

// ---- current channel_moments: independent full pass ----
fn channel_moments(px: &[u8], np: usize, ch: usize, max_ch: usize) -> ([f32; 3], [f32; 3]) {
    let nch = max_ch.min(ch).min(3);
    let (mut mus, mut vars) = ([0f32; 3], [0f32; 3]);
    let n = np as f64;
    for c in 0..nch {
        let (mut sum, mut sum2) = (0u64, 0u64);
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
    (mus, vars)
}

// ---- derive moments from the sa/saa the ssim pass already produced ----
fn moments_from_sums(sa: &[u64; 3], saa: &[u64; 3], np: usize, nch: usize) -> ([f32; 3], [f32; 3]) {
    let (mut mus, mut vars) = ([0f32; 3], [0f32; 3]);
    let n = np as f64;
    for c in 0..nch {
        let mu = sa[c] as f64 / n;
        mus[c] = mu as f32;
        vars[c] = (saa[c] as f64 / n - mu * mu) as f32;
    }
    (mus, vars)
}

fn median(v: &[f64]) -> f64 {
    let mut w: Vec<f64> = v[1..].to_vec();
    w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    w[w.len() / 2]
}

fn variant_a(
    a: &[u8],
    b: &[u8],
    np: usize,
    sb: &[u64; 3],
    sbb: &[u64; 3],
) -> (f32, [f32; 3], [f32; 3]) {
    let (s, _sa, _saa) = ssim_pass(a, b, np, 4, sb, sbb);
    let (mus, vars) = channel_moments(a, np, 4, 3); // independent second pass
    (s, mus, vars)
}
fn variant_b(
    a: &[u8],
    b: &[u8],
    np: usize,
    sb: &[u64; 3],
    sbb: &[u64; 3],
) -> (f32, [f32; 3], [f32; 3]) {
    let (s, sa, saa) = ssim_pass(a, b, np, 4, sb, sbb);
    let (mus, vars) = moments_from_sums(&sa, &saa, np, 3);
    (s, mus, vars)
}

fn main() {
    let (w, h) = (6000usize, 4000usize); // 24 MP RGBA
    let np = w * h;
    let mut a = vec![0u8; np * 4];
    let mut b = vec![0u8; np * 4];
    for i in 0..np * 4 {
        a[i] = ((i.wrapping_mul(1103515245).wrapping_add(12345)) >> 8) as u8;
        b[i] = a[i].wrapping_add((i as u8) & 7); // slightly different test image
    }
    let (sb, sbb) = ref_moments(&b, np, 4);

    let ra = variant_a(&a, &b, np, &sb, &sbb);
    let rb = variant_b(&a, &b, np, &sb, &sbb);
    let parity = ra == rb;

    let rounds = 11usize;
    let (mut ta, mut tb) = (Vec::new(), Vec::new());
    let mut sink = 0f64;
    let time =
        |f: &dyn Fn(&[u8], &[u8], usize, &[u64; 3], &[u64; 3]) -> (f32, [f32; 3], [f32; 3]),
         sink: &mut f64| {
            let t = Instant::now();
            let r = f(&a, &b, np, &sb, &sbb);
            *sink += r.0 as f64 + r.1[0] as f64 + r.2[2] as f64;
            t.elapsed().as_secs_f64() * 1e3
        };
    for r in 0..rounds {
        if r % 2 == 0 {
            ta.push(time(&variant_a, &mut sink));
            tb.push(time(&variant_b, &mut sink));
        } else {
            tb.push(time(&variant_b, &mut sink));
            ta.push(time(&variant_a, &mut sink));
        }
    }
    std::hint::black_box(sink);
    let (ma, mb) = (median(&ta), median(&tb));
    let saved = (ma - mb) / ma * 100.0;
    println!("Comparer::all() moment reuse flip @24MP  A=ssim+channel_moments  B=ssim+derive\n");
    println!("  A two-pass {:>8.3} ms", ma);
    println!("  B fused    {:>8.3} ms   saved {:.1}%", mb, saved);
    println!("  parity (ssim+mus+vars bit-exact): {}", parity);
    println!("\n  Gate >=2% AND parity=true -> thread sa/saa out of ssim() into all().");
}
