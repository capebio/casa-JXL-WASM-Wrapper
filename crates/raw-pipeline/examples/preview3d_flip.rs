//! preview3d_flip — spike for the architectural "preview 3D LUT" (handoff Tier 3, items 9/10 done
//! RIGHT). The colour matrix MIXES channels, so a per-channel 1D RAW→OUT LUT is incorrect; a 3D LUT
//! + trilinear interp is the correct collapse of pre-LUT ×3 + matrix + tone + post-LUT into ONE
//! cache-resident table. Preview only — export keeps the full math.
//!
//! Measures the two things that decide whether it's worth building for real:
//!   SPEED   — trilinear 3D-LUT apply vs `process_simd` (the current cached-LUT chain). The risk:
//!             trilinear is 8 node lookups/pixel, so it only wins if the LUT stays L1-resident.
//!   QUALITY — max + mean u8 error vs the full-math `process` output (the steep shadow/tone region
//!             is the worst case for interpolation).
//! across node counts N ∈ {9,17,33,65}. The build (N³ pixels through `process`) is one-time per
//! look, so it's reported but excluded from the per-frame apply timing.
//!
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --features parallel --example preview3d_flip
use raw_pipeline::pipeline::{process, process_simd, PipelineParams};
use std::time::Instant;

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

/// Build an N³ RGB→RGB u8 LUT by running the exact pipeline on every node triple.
/// Node domain = [0, white] per channel (uniform). Returns flat (N*N*N*3) u8.
fn build_lut(n: usize, white: u16, params: &PipelineParams) -> Vec<u8> {
    let step = white as f32 / (n - 1) as f32;
    let mut nodes = vec![0u16; n * n * n * 3];
    let mut k = 0;
    for ri in 0..n {
        for gi in 0..n {
            for bi in 0..n {
                nodes[k] = (ri as f32 * step).round() as u16;
                nodes[k + 1] = (gi as f32 * step).round() as u16;
                nodes[k + 2] = (bi as f32 * step).round() as u16;
                k += 3;
            }
        }
    }
    process(&nodes, params) // exact pipeline ⇒ nodes are ground-truth
}

/// Trilinear sample the 3D LUT. rgb16 → u8 (3 channels), interpolated.
#[inline(always)]
fn apply_lut(rgb16: &[u16], lut: &[u8], n: usize, white: u16, out: &mut [u8]) {
    let scale = (n - 1) as f32 / white as f32;
    let nm1 = (n - 1) as f32;
    let idx = |ri: usize, gi: usize, bi: usize| ((ri * n + gi) * n + bi) * 3;
    for (o, px) in out.chunks_mut(3).zip(rgb16.chunks(3)) {
        let fr = (px[0] as f32 * scale).min(nm1);
        let fg = (px[1] as f32 * scale).min(nm1);
        let fb = (px[2] as f32 * scale).min(nm1);
        let (r0, g0, b0) = (fr as usize, fg as usize, fb as usize);
        let (r1, g1, b1) = (
            (r0 + 1).min(n - 1),
            (g0 + 1).min(n - 1),
            (b0 + 1).min(n - 1),
        );
        let (dr, dg, db) = (fr - r0 as f32, fg - g0 as f32, fb - b0 as f32);
        for c in 0..3 {
            let l = |ri: usize, gi: usize, bi: usize| lut[idx(ri, gi, bi) + c] as f32;
            let c00 = l(r0, g0, b0) * (1.0 - dr) + l(r1, g0, b0) * dr;
            let c01 = l(r0, g0, b1) * (1.0 - dr) + l(r1, g0, b1) * dr;
            let c10 = l(r0, g1, b0) * (1.0 - dr) + l(r1, g1, b0) * dr;
            let c11 = l(r0, g1, b1) * (1.0 - dr) + l(r1, g1, b1) * dr;
            let c0 = c00 * (1.0 - dg) + c10 * dg;
            let c1 = c01 * (1.0 - dg) + c11 * dg;
            o[c] = (c0 * (1.0 - db) + c1 * db + 0.5) as u8;
        }
    }
}

fn main() {
    let (w, h) = (6000usize, 4000usize);
    let n_px = w * h;
    let params = PipelineParams::default_olympus();
    let white = params.white;

    let mut s: u32 = 0x9e37_79b9;
    let mut rgb16 = vec![0u16; n_px * 3];
    for v in rgb16.iter_mut() {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *v = ((s as u64 * (white as u64 + 1) >> 32) as u16).min(white); // uniform in [0,white]
    }

    let truth = process(&rgb16, &params); // full-math reference
    let _ = process_simd(&rgb16, &params); // warm LUT cache
    let rounds = 9usize;

    // baseline: current chain (cached LUTs)
    let mut base = Vec::new();
    for _ in 0..rounds {
        let t = Instant::now();
        let o = process_simd(&rgb16, &params);
        std::hint::black_box(&o);
        base.push(t.elapsed().as_secs_f64() * 1e3);
    }
    let base_ms = median(&mut base);
    println!(
        "preview3d_flip  {w}×{h} = {:.1} MP  white={white}  parallel={}",
        n_px as f64 / 1e6,
        cfg!(feature = "parallel")
    );
    println!("baseline process_simd (cached chain): {base_ms:.1} ms\n");
    println!("  N   lut_kb  build_ms  apply_ms  speedup   maxΔ  meanΔ");

    let mut out = vec![0u8; n_px * 3];
    for &n in &[9usize, 17, 33, 65] {
        let tb = Instant::now();
        let lut = build_lut(n, white, &params);
        let build_ms = tb.elapsed().as_secs_f64() * 1e3;
        let lut_kb = lut.len() as f64 / 1024.0;

        // accuracy vs full math
        apply_lut(&rgb16, &lut, n, white, &mut out);
        let (mut sum, mut maxd) = (0u64, 0i32);
        for (a, b) in truth.iter().zip(out.iter()) {
            let d = (*a as i32 - *b as i32).abs();
            sum += d as u64;
            maxd = maxd.max(d);
        }
        let mean = sum as f64 / truth.len() as f64;

        // apply speed (interleaved vs baseline already captured; just median apply)
        let mut ap = Vec::new();
        for _ in 0..rounds {
            let t = Instant::now();
            apply_lut(&rgb16, &lut, n, white, &mut out);
            std::hint::black_box(&out);
            ap.push(t.elapsed().as_secs_f64() * 1e3);
        }
        let apply_ms = median(&mut ap);
        println!(
            "{n:4}  {lut_kb:6.1}  {build_ms:8.2}  {apply_ms:8.1}  {:6.2}×  {maxd:5}  {mean:5.2}",
            base_ms / apply_ms
        );
    }
    println!(
        "\n(apply is single-threaded here; baseline process_simd is parallel — compare shapes, and"
    );
    println!(" judge quality by maxΔ/meanΔ. A real impl would parallel-tile the apply like process_simd.)");
}
