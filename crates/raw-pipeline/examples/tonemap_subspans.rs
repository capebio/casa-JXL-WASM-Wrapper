//! tonemap_subspans — Pipeline.rs optimization handoff, ITEM 0 (blocking).
//!
//! Decomposes the ~70% "ToneMap" stage timer into what it actually covers, and separates
//! steady-state full-render throughput from interactive slider-drag latency:
//!
//!   (a) LUT build      — pre-LUTs ×3 + post-LUT (powf), rebuilt on every param change
//!   (b) per-pixel apply — the tone math kernel (matrix + sat)
//!   (c) gather + pack   — pre-LUT gather (u16→f32) and post-LUT gather/pack (f32→u8)
//!   (d) buffer copy     — the 24 MP rgb16 clone the look paths do per drag
//!
//!   cached frame  = process_simd with the LUT cache warm (steady-state re-render)
//!   drag frame    = process_simd with params perturbed each call ⇒ full LUT rebuild every frame
//!   ⇒ rebuild tax = drag − cached  (the interactive cost the handoff says dominates)
//!
//! Run BOTH (the wasm interactive path is serial — that build cost is the real slider latency):
//!   cd crates/raw-pipeline && cargo run --release --no-default-features --example tonemap_subspans
//!   cd crates/raw-pipeline && cargo run --release --no-default-features --features parallel --example tonemap_subspans
use raw_pipeline::pipeline::{
    bench_lut_build_ms, bench_tone_stage_3way, process_simd, PipelineParams,
};
use std::time::Instant;

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let (w, h) = (6000usize, 4000usize); // 24 MP
    let n = w * h;
    let base = PipelineParams::default_olympus();

    let mut s: u32 = 0x9e37_79b9;
    let mut rgb16 = vec![0u16; n * 3];
    for v in rgb16.iter_mut() {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *v = ((s >> 8) & 0x3fff) as u16;
    }

    let rounds = 9usize;
    println!(
        "tonemap_subspans  {w}×{h} = {:.1} MP  parallel={}",
        n as f64 / 1e6,
        cfg!(feature = "parallel")
    );

    // (a) LUT build — median of one full rebuild (3 pre + 1 post)
    let (mut pre3, mut post) = (Vec::new(), Vec::new());
    for _ in 0..rounds {
        let (a, b) = bench_lut_build_ms(&base);
        pre3.push(a);
        post.push(b);
    }
    let (pre3_ms, post_ms) = (median(&mut pre3), median(&mut post));
    let build_ms = pre3_ms + post_ms;

    // (b)+(c) inner-loop split: pre-gather, tone-math, post-gather (LUT build excluded)
    let (mut pg, mut tm, mut pp) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..rounds {
        let (a, b, c) = bench_tone_stage_3way(&rgb16, &base);
        pg.push(a);
        tm.push(b);
        pp.push(c);
    }
    let (pre_gather, tone_math, post_pack) = (median(&mut pg), median(&mut tm), median(&mut pp));

    // (d) buffer copy — the per-drag 24 MP rgb16 clone (apply_look texture path / LookRenderer)
    let mut cp = Vec::new();
    for _ in 0..rounds {
        let t = Instant::now();
        let c = rgb16.clone();
        std::hint::black_box(&c);
        cp.push(t.elapsed().as_secs_f64() * 1e3);
    }
    let copy_ms = median(&mut cp);

    // cached frame: warm the LUT cache, then time steady-state re-renders (same params)
    let _ = process_simd(&rgb16, &base);
    let mut cached = Vec::new();
    for _ in 0..rounds {
        let t = Instant::now();
        let o = process_simd(&rgb16, &base);
        std::hint::black_box(&o);
        cached.push(t.elapsed().as_secs_f64() * 1e3);
    }
    let cached_ms = median(&mut cached);

    // drag frame: perturb a tone slider each call ⇒ ensure_lut miss ⇒ full rebuild every frame
    let mut drag = Vec::new();
    for i in 0..rounds {
        let mut p = base.clone();
        p.contrast = 0.10 + i as f32 * 1e-4; // unique each round ⇒ post-LUT (powf) rebuild
        p.exposure_ev = 0.20 + i as f32 * 1e-4; // ⇒ pre-LUT rebuild too
        let t = Instant::now();
        let o = process_simd(&rgb16, &p);
        std::hint::black_box(&o);
        drag.push(t.elapsed().as_secs_f64() * 1e3);
    }
    let drag_ms = median(&mut drag);
    let rebuild_tax = drag_ms - cached_ms;

    println!("\n--- sub-spans (median of {rounds}, 24 MP) ---");
    println!("(a) LUT build total      {build_ms:7.2} ms   [pre×3 {pre3_ms:.2} + post(powf) {post_ms:.2}]");
    println!("(b) tone-math apply      {tone_math:7.2} ms");
    println!("(c) pre-gather           {pre_gather:7.2} ms");
    println!("    post-gather/pack     {post_pack:7.2} ms");
    println!("(d) rgb16 clone (copy)   {copy_ms:7.2} ms");
    println!("\n--- frames ---");
    println!("cached re-render         {cached_ms:7.2} ms   (LUT warm — full-render throughput)");
    println!("slider-drag re-render    {drag_ms:7.2} ms   (LUT rebuilt every frame)");
    println!(
        "  ⇒ rebuild tax          {rebuild_tax:7.2} ms   ({:.0}% of the drag frame)",
        rebuild_tax / drag_ms * 100.0
    );
    println!("\n--- verdict ---");
    let inner = tone_math + pre_gather + post_pack;
    println!("inner loop (b+c)         {inner:7.2} ms");
    println!("build+copy (a+d)         {:7.2} ms", build_ms + copy_ms);
    println!(
        "interactive bottleneck: {}",
        if build_ms + copy_ms > inner {
            "LUT BUILD + COPY (handoff hypothesis CONFIRMED)"
        } else {
            "inner loop"
        }
    );
}
