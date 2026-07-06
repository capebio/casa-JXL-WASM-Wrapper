//! flip_native — an interleaved A/B/N timing harness for IN-PROCESS Rust code.
//!
//! WHY NOT `flipflop` (the .mjs skill)?  flipflop runs *JavaScript* variants, or
//! external commands timed by **process wall-clock**. To point it at a Rust function
//! you must either (a) compile to wasm and drive it through `flipflopdom` in a browser,
//! or (b) shell out per measurement — and process-startup (tens of ms) swamps a 50 ms
//! demosaic, destroying the signal. For a pure-native Rust kernel the correct vehicle is
//! an *in-process* interleaved timer. This file is that vehicle, keeping flipflop's
//! discipline:
//!   • N variants of one op, run **interleaved with per-round start-rotation** so thermal
//!     / turbo / scheduler drift hits every arm equally (the core flipflop idea).
//!   • round 0 is a warmup and excluded from the warm median (flipflop's `first_paint`).
//!   • headline = median time; **memory rides along** (peak transient alloc via a counting
//!     global allocator); `%saved` vs a chosen baseline.
//!   • a `trust` verdict from the coefficient of variation (stdev/median). flipflop's own
//!     docs note that on this desktop CPU temp/freq are not reliable signals — so it leans
//!     on the interleave + stdev too. We do the same; there is no temperature column.
//!   • optional per-variant `quality` scalar (caller-supplied, like flipflop's `quality()`
//!     hook — the harness bundles no metric). Correctness/quality of the half-res preview
//!     is gated separately by `demosaic_preview_demo` (Butteraugli + PSNR + visual).
//!
//! Run: cargo run -p raw-pipeline --release --no-default-features --example flip_native

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

use raw_pipeline::demosaic;

// ── counting allocator: peak transient bytes per timed block (the memory ride-along) ──
struct Counting;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            let c = CUR.fetch_add(l.size(), Relaxed) + l.size();
            let mut pk = PEAK.load(Relaxed);
            while c > pk {
                match PEAK.compare_exchange_weak(pk, c, Relaxed, Relaxed) {
                    Ok(_) => break,
                    Err(x) => pk = x,
                }
            }
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        CUR.fetch_sub(l.size(), Relaxed);
        System.dealloc(p, l);
    }
}
#[global_allocator]
static GA: Counting = Counting;

const MB: f64 = 1024.0 * 1024.0;

/// One variant: a name, whether it is the `%saved` baseline, the closure to time, and
/// an optional caller-supplied quality scalar (lower-is-closer by convention).
struct Variant<'a> {
    name: &'a str,
    baseline: bool,
    run: Box<dyn FnMut() + 'a>,
    quality: Option<f64>,
}

struct Stat {
    name: String,
    median_ms: f64,
    mean_ms: f64,
    stdev_ms: f64,
    min_ms: f64,
    max_ms: f64,
    peak_mb: f64,
    pct_saved: f64,
    trust: &'static str,
    quality: Option<f64>,
}

/// Interleaved flip. `rounds` warm rounds (plus 1 discarded warmup); `inner` calls per
/// timed sample (raise for sub-ms ops so the clock has signal).
fn flip(variants: &mut [Variant], rounds: usize, inner: usize) -> Vec<Stat> {
    let k = variants.len();
    let mut times: Vec<Vec<f64>> = vec![Vec::with_capacity(rounds); k];
    let mut peaks: Vec<f64> = vec![0.0; k];

    // round 0 = warmup (caches, pages, branch predictors), not recorded.
    for r in 0..=rounds {
        for slot in 0..k {
            // start-rotation: which variant leads changes every round.
            let i = (slot + r) % k;
            let base = CUR.load(Relaxed);
            PEAK.store(base, Relaxed);
            let t = Instant::now();
            for _ in 0..inner {
                (variants[i].run)();
            }
            let ms = t.elapsed().as_secs_f64() * 1000.0 / inner as f64;
            if r > 0 {
                times[i].push(ms);
                let pk = (PEAK.load(Relaxed).saturating_sub(base)) as f64 / MB;
                peaks[i] = peaks[i].max(pk);
            }
        }
    }

    let med = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };
    let base_idx = variants.iter().position(|v| v.baseline).unwrap_or(0);
    let base_median = med(&mut times[base_idx].clone());

    let mut out = Vec::with_capacity(k);
    for i in 0..k {
        let mut t = times[i].clone();
        let median = med(&mut t);
        let mean = t.iter().sum::<f64>() / t.len() as f64;
        let var = t.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / t.len() as f64;
        let stdev = var.sqrt();
        let cv = if median > 0.0 { stdev / median } else { 1.0 };
        out.push(Stat {
            name: variants[i].name.to_string(),
            median_ms: median,
            mean_ms: mean,
            stdev_ms: stdev,
            min_ms: *t.first().unwrap(),
            max_ms: *t.last().unwrap(),
            peak_mb: peaks[i],
            pct_saved: (base_median - median) / base_median * 100.0,
            trust: if cv < 0.10 { "high" } else { "low" },
            quality: variants[i].quality,
        });
    }
    out
}

fn report(title: &str, stats: &[Stat]) {
    println!("\n=== {title} ===");
    println!(
        "  {:<22} {:>9} {:>9} {:>8} {:>9} {:>8} {:>7}  {}",
        "variant", "median ms", "stdev", "cv", "peak MB", "%saved", "trust", "quality"
    );
    for s in stats {
        let cv = if s.median_ms > 0.0 {
            s.stdev_ms / s.median_ms
        } else {
            0.0
        };
        let q = s
            .quality
            .map(|q| format!("{q:.4}"))
            .unwrap_or_else(|| "-".into());
        println!(
            "  {:<22} {:>9.2} {:>9.2} {:>8.3} {:>9.1} {:>+8.0} {:>7}  {}",
            s.name, s.median_ms, s.stdev_ms, cv, s.peak_mb, s.pct_saved, s.trust, q
        );
    }
    // TOON-ish journal append (mirrors flipflop's append-only record location).
    use std::io::Write;
    let dir = std::path::PathBuf::from("docs/outputs/timing tests/flip-native");
    std::fs::create_dir_all(&dir).ok();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("journal.toon"))
    {
        let _ = writeln!(f, "=== {title}");
        for s in stats {
            let _ = writeln!(
                f,
                "  {{name:{},median_ms:{:.3},stdev_ms:{:.3},peak_mb:{:.2},pct_saved:{:.1},trust:{}}}",
                s.name, s.median_ms, s.stdev_ms, s.peak_mb, s.pct_saved, s.trust
            );
        }
    }
}

fn bench_size(w: usize, h: usize) {
    let raw = vec![1000u16; w * h];
    let r1 = raw.clone();
    let r2 = raw.clone();
    let mut variants = vec![
        Variant {
            name: "full bilinear (planar)",
            baseline: true,
            run: Box::new(move || {
                std::hint::black_box(demosaic::demosaic_rggb_planar(&r1, w, h).unwrap());
            }),
            quality: None,
        },
        Variant {
            name: "half 2x2 superpixel",
            baseline: false,
            run: Box::new(move || {
                std::hint::black_box(demosaic::demosaic_rggb_half(&r2, w, h).unwrap());
            }),
            // perceptual quality is gated by demosaic_preview_demo (Butteraugli 0.063 on a
            // real 20 MP ORF); plumbed here as a constant so the column is populated.
            quality: Some(0.063),
        },
    ];
    let stats = flip(&mut variants, 9, 1);
    report(
        &format!("demosaic preview, {w}x{h} ({:.1} MP)", (w * h) as f64 / 1e6),
        &stats,
    );
}

fn main() {
    println!(
        "flip_native — interleaved in-process timing (parallel={})",
        cfg!(feature = "parallel")
    );
    bench_size(5184, 3888); // ~20 MP
    bench_size(4032, 3024); // ~12 MP
    println!("\nquality column = Butteraugli vs full-res preview (from demosaic_preview_demo); <1.0 ≈ invisible.");
    println!("journal → docs/outputs/timing tests/flip-native/journal.toon");
}
