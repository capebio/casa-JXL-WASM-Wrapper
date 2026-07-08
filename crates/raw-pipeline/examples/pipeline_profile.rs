//! End-to-end per-stage profile of the ORF → RGB8 pipeline. Locates the real
//! cost center (container-parse / decompress / demosaic / tone / orientation)
//! on a real file.
//!
//! Run: cargo run -p raw-pipeline --release --no-default-features \
//!        --example pipeline_profile -- <path-to.orf>
//! Default file: C:/Foo/raw-converter/tests/P1110226.ORF
//!
//! Measured split — P1110226.ORF (5240x3912, 20.5 MP), median of 7 runs,
//! MSVC release --no-default-features (2026-07-08):
//!   container-parse     0.01 ms   0.0%
//!   decompress        223.59 ms  32.7%
//!   demosaic          103.92 ms  15.2%
//!   tone              355.25 ms  52.0%
//!   orientation         0.00 ms   0.0%  (orientation 1 → identity move)
//!   TOTAL             682.77 ms  (33.3 ms/MP)
//! Container-parse (IFD walk + makernote) and orientation (identity move for
//! landscape ORFs) are both negligible vs decompress/demosaic/tone.

use raw_pipeline::tiff::{
    bench_pipeline_orf, bench_tone_e2e_orf, bench_tone_split_orf, bench_tone_stage_3way_orf,
};
use std::fs;

fn med(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "C:/Foo/raw-converter/tests/P1110226.ORF".to_string());
    let data = fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    println!("profiling {} ({} KB)", path, data.len() / 1024);

    let _ = bench_pipeline_orf(&data).expect("decode (warmup)");
    let runs = 7;
    let (mut parse, mut dec, mut dem, mut tone, mut ori) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut wh = (0u32, 0u32);
    for _ in 0..runs {
        let b = bench_pipeline_orf(&data).expect("decode");
        parse.push(b.parse_ms);
        dec.push(b.decompress_ms);
        dem.push(b.demosaic_ms);
        tone.push(b.tone_ms);
        ori.push(b.orientation_ms);
        wh = (b.width, b.height);
    }
    let (p, d, m, t, o) = (med(parse), med(dec), med(dem), med(tone), med(ori));
    let total = p + d + m + t + o;
    let mp = wh.0 as f64 * wh.1 as f64 / 1e6;
    println!("{}x{}  ({:.1} MP), median of {} runs", wh.0, wh.1, mp, runs);
    println!("  container-parse {:9.2} ms  {:5.1}%", p, 100.0 * p / total);
    println!("  decompress      {:9.2} ms  {:5.1}%", d, 100.0 * d / total);
    println!("  demosaic        {:9.2} ms  {:5.1}%", m, 100.0 * m / total);
    println!("  tone            {:9.2} ms  {:5.1}%", t, 100.0 * t / total);
    println!("  orientation     {:9.2} ms  {:5.1}%", o, 100.0 * o / total);
    println!("  ──────────────────────────────────────");
    println!("  TOTAL           {:9.2} ms  ({:.1} ms/MP)", total, total / mp);

    // Sub-profile the tone pass (single-thread): apply_tone_math vs LUT gather.
    let _ = bench_tone_split_orf(&data);
    let (mut full, mut luto) = (Vec::new(), Vec::new());
    for _ in 0..runs {
        let (f, l) = bench_tone_split_orf(&data).expect("tone split");
        full.push(f);
        luto.push(l);
    }
    let (f, l) = (med(full), med(luto));
    let math = (f - l).max(0.0);
    println!("\ntone sub-profile (single-thread, median of {}):", runs);
    println!("  LUT gather+store {:9.2} ms  {:5.1}%", l, 100.0 * l / f);
    println!(
        "  apply_tone_math  {:9.2} ms  {:5.1}%  (matrix + sat/vibrance + divide)",
        math,
        100.0 * math / f
    );
    println!("  tone full        {:9.2} ms", f);

    // 3-stage sub-profile: pre-LUT gather / tone math / post-LUT gather.
    let _ = bench_tone_stage_3way_orf(&data);
    let (mut pre, mut math2, mut post) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..runs {
        let (pr, ma, po) = bench_tone_stage_3way_orf(&data).expect("3way");
        pre.push(pr);
        math2.push(ma);
        post.push(po);
    }
    let (pr, ma, po) = (med(pre), med(math2), med(post));
    let subtotal = pr + ma + po;
    println!(
        "\ntone 3-stage sub-profile (single-thread, compact pre-LUT, median of {}):",
        runs
    );
    println!(
        "  pre-LUT gather   {:9.2} ms  {:5.1}%",
        pr,
        100.0 * pr / subtotal
    );
    println!(
        "  tone math        {:9.2} ms  {:5.1}%",
        ma,
        100.0 * ma / subtotal
    );
    println!(
        "  post-LUT gather  {:9.2} ms  {:5.1}%",
        po,
        100.0 * po / subtotal
    );
    println!("  ──────────────────────────────────────");
    println!("  (3-stage total   {:9.2} ms)", subtotal);

    // End-to-end tone: scalar process_into vs SIMD process_into_simd (parallel) + parity.
    let (mut sc, mut si, mut md, mut nd) = (Vec::new(), Vec::new(), 0u8, 0usize);
    for _ in 0..runs {
        let (s, i, maxd, ndiff) = bench_tone_e2e_orf(&data).expect("e2e");
        sc.push(s);
        si.push(i);
        md = md.max(maxd);
        nd = ndiff;
    }
    let (s, i) = (med(sc), med(si));
    println!("\nend-to-end tone (parallel, median of {}):", runs);
    println!("  scalar process_into      {:9.2} ms", s);
    println!("  SIMD   process_into_simd {:9.2} ms   ({:.2}x)", i, s / i);
    println!(
        "  output parity: {} px differ (of {}), max byte diff {}",
        nd,
        mp_px(wh),
        md
    );
}

fn mp_px(wh: (u32, u32)) -> usize {
    wh.0 as usize * wh.1 as usize * 3
}
