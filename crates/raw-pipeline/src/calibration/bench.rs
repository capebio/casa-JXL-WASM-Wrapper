//! Timing harness (native). Measures the accessible pathways with VM-grade noise
//! controls (warmup, median-of-N, coefficient-of-variation gate) and emits every
//! contest to a shared sink so what the user sees equals what gets persisted.
//! See design §4.4.

use crate::calibration::fractal::{Dataset, FractalSpec};
use crate::calibration::parity::parity_check;
use crate::perceptual::{BackendChoice, Comparer, Opts};
use std::hint::black_box;
use std::time::Instant;

/// A robust timing of one repeated operation.
#[derive(Clone, Debug)]
pub struct Sample {
    pub median_ns: f64,
    /// Coefficient of variation (stddev/mean) — the noise gauge.
    pub cov: f64,
    pub runs: usize,
    /// True when `cov` stayed under `MAX_COV` after the allowed re-runs.
    pub confident: bool,
}

/// CoV above this = noisy (shared-VM neighbour, throttling). We re-sample, then flag.
const MAX_COV: f64 = 0.15;

/// Knobs for the whole run. `default()` targets the 1–3 min budget; `quick()` is for
/// tests.
#[derive(Clone, Copy, Debug)]
pub struct BenchConfig {
    /// Square edge (px) of the backend-bench image.
    pub backend_dim: usize,
    pub backend_warmup: usize,
    pub backend_runs: usize,
    /// Number of fractal tiles in the thread-scaling batch.
    pub thread_tiles: usize,
    pub thread_dim: usize,
    pub thread_runs: usize,
}

impl Default for BenchConfig {
    fn default() -> Self {
        BenchConfig {
            backend_dim: 384,
            backend_warmup: 3,
            backend_runs: 9,
            thread_tiles: 48,
            thread_dim: 256,
            thread_runs: 5,
        }
    }
}

impl BenchConfig {
    /// Tiny, fast config for unit tests.
    pub fn quick() -> Self {
        BenchConfig {
            backend_dim: 48,
            backend_warmup: 1,
            backend_runs: 3,
            thread_tiles: 4,
            thread_dim: 32,
            thread_runs: 2,
        }
    }
}

/// Run `f` `warmup` times (discarded) then `runs` times, returning the median elapsed
/// ns + CoV. If the CoV is high it re-samples once more (bounded) before flagging.
pub fn time_median<F: FnMut()>(warmup: usize, runs: usize, mut f: F) -> Sample {
    for _ in 0..warmup {
        f();
    }
    let mut sample = measure(runs.max(1), &mut f);
    if !sample.confident {
        // One bounded re-sample with more runs — noise sometimes clears.
        let retry = measure((runs * 2).max(2), &mut f);
        if retry.cov < sample.cov {
            sample = retry;
        }
    }
    sample
}

fn measure<F: FnMut()>(runs: usize, f: &mut F) -> Sample {
    let mut times = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t0 = Instant::now();
        f();
        times.push(t0.elapsed().as_nanos() as f64);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = times[times.len() / 2];
    let mean = times.iter().sum::<f64>() / times.len() as f64;
    let var = times.iter().map(|t| (t - mean).powi(2)).sum::<f64>() / times.len() as f64;
    let cov = if mean > 0.0 { var.sqrt() / mean } else { 0.0 };
    Sample {
        median_ns: median,
        cov,
        runs,
        confident: cov <= MAX_COV,
    }
}

fn distort(px: &[u8]) -> Vec<u8> {
    px.iter()
        .enumerate()
        .map(|(i, &v)| if i % 4 == 3 { v } else { v.wrapping_add(7) })
        .collect()
}

/// Timing + parity verdict for one backend.
#[derive(Clone, Debug)]
pub struct BackendTiming {
    pub variant: &'static str,
    pub backend_id: u8,
    pub sample: Sample,
    pub parity_ok: bool,
}

/// The executable backends to time, as (label, id, choice). Mirrors the parity gate.
fn candidate_backends() -> Vec<(&'static str, u8, BackendChoice)> {
    let mut v = vec![("scalar", 0u8, BackendChoice::ForceScalar)];
    #[cfg(target_arch = "x86_64")]
    {
        let avx2 = std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma");
        let avx512 = avx2
            && std::is_x86_feature_detected!("avx512f")
            && std::is_x86_feature_detected!("avx512bw");
        if avx2 {
            v.push(("avx2-strict", 1, BackendChoice::Force(1)));
            v.push(("avx2-rsqrt", 2, BackendChoice::Force(2)));
        }
        if avx512 {
            v.push(("avx512-strict", 3, BackendChoice::Force(3)));
            v.push(("avx512-rsqrt", 5, BackendChoice::Force(5)));
        }
    }
    v
}

/// Time every executable perceptual backend on a fractal and report each with its
/// parity verdict. `emit` receives one human line per backend.
pub fn bench_backends(cfg: &BenchConfig, emit: &mut dyn FnMut(&str)) -> Vec<BackendTiming> {
    let spec = FractalSpec::preset(Dataset::MandelbrotSeahorse, cfg.backend_dim, cfg.backend_dim);
    let reference = spec.render_rgba8();
    let test = distort(&reference);
    let (w, h) = (cfg.backend_dim, cfg.backend_dim);

    // Parity first: a backend that fails is reported but never selected.
    let parity: std::collections::HashMap<&str, bool> = parity_check(&spec)
        .into_iter()
        .map(|r| (r.variant, r.matches_scalar))
        .collect();

    let mut out = Vec::new();
    for (variant, backend_id, choice) in candidate_backends() {
        let opts = Opts {
            backend: choice,
            ..Opts::default()
        };
        let mut cmp = Comparer::new(reference.clone(), w, h, opts);
        let sample = time_median(cfg.backend_warmup, cfg.backend_runs, || {
            black_box(cmp.butteraugli(black_box(&test)));
        });
        let parity_ok = *parity.get(variant).unwrap_or(&false);
        emit(&format!(
            "backend {:<14} median={:>8.1}us cov={:>5.1}%{} parity={}",
            variant,
            sample.median_ns / 1000.0,
            sample.cov * 100.0,
            if sample.confident { "" } else { " (noisy)" },
            if parity_ok { "ok" } else { "FAIL" },
        ));
        out.push(BackendTiming {
            variant,
            backend_id,
            sample,
            parity_ok,
        });
    }
    out
}

/// Choose the fastest parity-passing backend. Returns `(chosen_id, label, timings)`.
/// `None` id means "keep runtime default" (only scalar available, or all non-scalar
/// failed parity).
pub fn pick_backend(
    cfg: &BenchConfig,
    emit: &mut dyn FnMut(&str),
) -> (Option<u8>, Option<String>, Vec<BackendTiming>) {
    let timings = bench_backends(cfg, emit);
    let best = timings
        .iter()
        .filter(|t| t.parity_ok)
        .min_by(|a, b| a.sample.median_ns.partial_cmp(&b.sample.median_ns).unwrap());
    match best {
        Some(t) => {
            emit(&format!(
                "-> chosen backend: {} ({:.1}us)",
                t.variant,
                t.sample.median_ns / 1000.0
            ));
            (Some(t.backend_id), Some(t.variant.to_string()), timings)
        }
        None => {
            emit("-> no parity-passing backend; keeping runtime default");
            (None, None, timings)
        }
    }
}

/// Throughput of the perceptual batch at a given worker count.
#[derive(Clone, Debug)]
pub struct ThreadTiming {
    pub threads: usize,
    pub median_ns: f64,
    pub cov: f64,
    /// Tiles processed per second (higher = better).
    pub throughput: f64,
}

/// The worker counts to probe: 1, 2, 4, … up to the effective core budget (plus the
/// budget itself). Deduped + sorted.
fn thread_ladder(budget: usize) -> Vec<usize> {
    let mut v = vec![1usize];
    let mut n = 2;
    while n < budget {
        v.push(n);
        n *= 2;
    }
    if budget >= 2 {
        v.push(budget);
    }
    v.sort_unstable();
    v.dedup();
    v
}

/// Bench the perceptual batch across worker counts to find the throughput-optimal
/// thread count. Faithful proxy for the encode/decode hot path: it runs the real
/// XYB/blur/downsample/butteraugli kernels under memory-bandwidth pressure. Clamped
/// to the cgroup-aware effective core budget. `emit` gets one line per worker count.
///
/// (A real end-to-end JXL-encode variant is a `jxl-codec`-gated follow-up; this
/// proxy needs no codec and captures the same bandwidth ceiling.)
#[cfg(feature = "parallel")]
pub fn bench_thread_scaling(cfg: &BenchConfig, emit: &mut dyn FnMut(&str)) -> Vec<ThreadTiming> {
    use rayon::prelude::*;

    let budget = crate::calibration::prober::effective_core_budget();
    // Build the tile batch once: distinct fractals so the compiler/cache can't cheat.
    let dim = cfg.thread_dim;
    let tiles: Vec<(Vec<u8>, Vec<u8>)> = (0..cfg.thread_tiles)
        .map(|i| {
            let mut spec = FractalSpec::preset(Dataset::MandelbrotSeahorse, dim, dim);
            spec.palette_phase = i as f64 * 0.3;
            let img = spec.render_rgba8();
            let dis = distort(&img);
            (img, dis)
        })
        .collect();

    let run_batch = |pool: &rayon::ThreadPool| {
        pool.install(|| {
            tiles.par_iter().for_each(|(img, dis)| {
                let mut cmp = Comparer::new(img.clone(), dim, dim, Opts::default());
                black_box(cmp.butteraugli(black_box(dis)));
            });
        });
    };

    let mut out = Vec::new();
    for threads in thread_ladder(budget) {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .expect("rayon pool");
        let sample = time_median(1, cfg.thread_runs, || run_batch(&pool));
        let throughput = cfg.thread_tiles as f64 / (sample.median_ns / 1e9);
        emit(&format!(
            "threads {:>3}  batch={:>8.1}ms  throughput={:>8.1} tiles/s  cov={:.1}%",
            threads,
            sample.median_ns / 1e6,
            throughput,
            sample.cov * 100.0
        ));
        out.push(ThreadTiming {
            threads,
            median_ns: sample.median_ns,
            cov: sample.cov,
            throughput,
        });
    }
    out
}

/// Single-thread stub when rayon is compiled out — the thread axis is not tunable.
#[cfg(not(feature = "parallel"))]
pub fn bench_thread_scaling(_cfg: &BenchConfig, emit: &mut dyn FnMut(&str)) -> Vec<ThreadTiming> {
    emit("thread scaling skipped: `parallel` feature off");
    Vec::new()
}

/// Pick the worker count with the best throughput, but prefer FEWER threads when a
/// larger count is within `TIE_FRAC` of the best (avoids the 144-oversubscription
/// trap: extra threads that don't actually help are not chosen). Returns `None` when
/// no scaling data (single-thread build).
pub fn pick_thread_count(timings: &[ThreadTiming]) -> Option<usize> {
    let best = timings
        .iter()
        .max_by(|a, b| a.throughput.partial_cmp(&b.throughput).unwrap())?;
    const TIE_FRAC: f64 = 0.05; // within 5% of best throughput = a tie
    let threshold = best.throughput * (1.0 - TIE_FRAC);
    // Smallest thread count whose throughput reaches the threshold.
    timings
        .iter()
        .filter(|t| t.throughput >= threshold)
        .map(|t| t.threads)
        .min()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_median_reports_runs_and_cov() {
        let mut counter = 0u64;
        let s = time_median(1, 5, || {
            counter = counter.wrapping_add(1);
            black_box(counter);
        });
        assert!(s.runs >= 5);
        assert!(s.median_ns >= 0.0);
        assert!(s.cov >= 0.0);
    }

    #[test]
    fn bench_backends_covers_scalar_and_reports_parity() {
        let mut lines = Vec::new();
        let timings = bench_backends(&BenchConfig::quick(), &mut |s| lines.push(s.to_string()));
        assert!(timings.iter().any(|t| t.variant == "scalar"));
        // Scalar is the oracle: always parity-ok.
        assert!(timings.iter().find(|t| t.variant == "scalar").unwrap().parity_ok);
        assert_eq!(lines.len(), timings.len());
    }

    #[test]
    fn pick_backend_returns_a_parity_passing_choice() {
        let (id, label, timings) = pick_backend(&BenchConfig::quick(), &mut |_| {});
        assert!(!timings.is_empty());
        if let Some(id) = id {
            let chosen = timings.iter().find(|t| t.backend_id == id).unwrap();
            assert!(chosen.parity_ok, "chosen backend failed parity");
        }
        let _ = label;
    }

    #[test]
    fn thread_ladder_is_sorted_unique_and_bounded() {
        let l = thread_ladder(12);
        assert_eq!(l.first(), Some(&1));
        assert_eq!(l.last(), Some(&12));
        let mut sorted = l.clone();
        sorted.sort_unstable();
        assert_eq!(l, sorted);
        assert!(l.windows(2).all(|w| w[0] < w[1]), "not strictly increasing");
    }

    #[test]
    fn pick_thread_count_prefers_fewer_on_a_tie() {
        // 4 threads is the throughput peak; 8 is within 5% → prefer 4.
        let timings = vec![
            ThreadTiming { threads: 1, median_ns: 0.0, cov: 0.0, throughput: 100.0 },
            ThreadTiming { threads: 2, median_ns: 0.0, cov: 0.0, throughput: 180.0 },
            ThreadTiming { threads: 4, median_ns: 0.0, cov: 0.0, throughput: 200.0 },
            ThreadTiming { threads: 8, median_ns: 0.0, cov: 0.0, throughput: 196.0 },
        ];
        assert_eq!(pick_thread_count(&timings), Some(4));
    }

    #[cfg(feature = "parallel")]
    #[test]
    fn thread_scaling_runs_and_picks() {
        let timings = bench_thread_scaling(&BenchConfig::quick(), &mut |_| {});
        assert!(!timings.is_empty());
        let n = pick_thread_count(&timings);
        assert!(n.is_some());
        assert!(n.unwrap() >= 1);
    }
}
