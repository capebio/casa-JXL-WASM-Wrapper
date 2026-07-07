//! Native proxy for the BROWSER decode-pool thread-oversubscription question
//! (throughput decision, Task 2.1 evidence).
//!
//! The browser runs a batch as POOL_SIZE decode Web Workers (web/main.js:38,
//! `min(hardwareConcurrency, 12)`), and EACH worker calls
//! `initThreadPool(hardwareConcurrency)` (web/worker.js:160) — so every one of
//! the N in-flight decodes gets a FULL rayon pool of C threads. On a C-core box
//! that is N x C rayon threads all live at once (e.g. 12 x 12 = 144 on 12 cores).
//!
//! A single ORF decode = decompress (SERIAL, ~74% of decode, no rayon) +
//! demosaic_rggb_mhc + pipeline::process (both rayon `par_chunks_mut`,
//! memory-bandwidth-bound). Hypothesis: under a saturated batch, giving each
//! decode C rayon threads is WORSE than giving it 1 — the memory-bound stages
//! don't scale past physical cores (repo "DS-ROWPAR" rule), so the extra threads
//! only add contention/thrash while the dominant serial decompress uses 1 thread
//! regardless. Proposed fix: N workers x 1 rayon thread each (total = N threads).
//!
//! This example reproduces that contention physics NATIVELY: N OS threads decode
//! the SAME ORF strip CONCURRENTLY (the saturated-batch condition), each confined
//! to its own T-thread rayon pool via `pool.install(...)` — exactly like each Web
//! Worker's private rayon pool. We sweep T in {C, 2, 1}, flip-flop the regime
//! order across rounds to cancel thermal drift, take the median wall-clock, and
//! assert the decoded RGB8 is byte-identical across thread counts.
//!
//! CAVEAT: this is a native proxy. Native rayon/OS threads are not browser Web
//! Workers — thread-spawn and message-passing overheads differ. It measures the
//! same CPU/memory-bandwidth CONTENTION physics, not the browser's scheduling.
//!
//! Run (crate dir; no jxl-codec/libjxl needed):
//!   cargo run --release --no-default-features --features parallel \
//!     --example batch_concurrency_flip -- "C:\Foo\raw-converter\tests\P1110226.ORF"

use raw_pipeline::pipeline::PipelineParams;
use raw_pipeline::{decompress, demosaic, pipeline, tiff};
use std::time::Instant;

// ---- Windows AC-power probe (battery throttles CPU → matters for perf numbers) ----
#[cfg(windows)]
mod power {
    #[repr(C)]
    struct SystemPowerStatus {
        ac_line_status: u8,
        battery_flag: u8,
        battery_life_percent: u8,
        system_status_flag: u8,
        battery_life_time: u32,
        battery_full_life_time: u32,
    }
    extern "system" {
        fn GetSystemPowerStatus(s: *mut SystemPowerStatus) -> i32;
    }
    /// "AC", "battery", or "unknown".
    pub fn ac_state() -> &'static str {
        unsafe {
            let mut s: SystemPowerStatus = core::mem::zeroed();
            if GetSystemPowerStatus(&mut s) != 0 {
                match s.ac_line_status {
                    0 => "battery",
                    1 => "AC",
                    _ => "unknown",
                }
            } else {
                "unknown"
            }
        }
    }
}
#[cfg(not(windows))]
mod power {
    pub fn ac_state() -> &'static str {
        "unknown"
    }
}

/// Full-quality browser decode: decompress (serial) -> MHC demosaic -> pipeline.
/// rayon work inside runs on whatever pool `install`'d us (or global if none).
fn decode_full(strip: &[u8], w: usize, h: usize, params: &PipelineParams) -> Vec<u8> {
    let raw = decompress::decompress(strip, w, h).expect("decompress failed");
    let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).expect("demosaic failed");
    pipeline::process(&rgb16, params)
}

/// One saturated-batch regime: build N fresh T-thread pools (like each Web
/// Worker's private rayon pool), then run N CONCURRENT decodes, each confined to
/// its own pool. Returns total wall-clock (ms) for all N to finish.
/// Pool construction (thread spawn) is OUTSIDE the timed region — we measure
/// steady-state decode contention, not pool creation.
fn run_regime(t: usize, n: usize, strip: &[u8], w: usize, h: usize, params: &PipelineParams) -> f64 {
    let pools: Vec<rayon::ThreadPool> = (0..n)
        .map(|_| {
            rayon::ThreadPoolBuilder::new()
                .num_threads(t)
                .build()
                .expect("pool build")
        })
        .collect();

    let wall = Instant::now();
    std::thread::scope(|s| {
        for pool in &pools {
            s.spawn(move || {
                let out = pool.install(|| decode_full(strip, w, h, params));
                std::hint::black_box(&out);
            });
        }
    });
    wall.elapsed().as_secs_f64() * 1e3
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests\P1110226.ORF".into());

    let data = match std::fs::read(&path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("read {path}: {e}");
            return;
        }
    };

    // Parse once; extract the compressed strip so each decode re-runs the FULL
    // pipeline (decompress -> demosaic -> tone) from the compressed bytes.
    let info = tiff::parse(&data).expect("tiff::parse failed");
    let w = info.width as usize;
    let h = info.height as usize;
    let end = info.strip_offset as usize + info.strip_byte_count as usize;
    let strip = &data[info.strip_offset as usize..end];

    // Browser full-quality params (mirror examples/orf_jxl_batch_concurrent.rs).
    let mut params = PipelineParams::default_olympus();
    params.wb_r = info.wb_r.unwrap_or(1.797);
    params.wb_g = 1.0;
    params.wb_b = info.wb_b.unwrap_or(1.797);
    params.color_matrix = info.color_matrix.into();

    // C = "cores" as the browser sees them (hardwareConcurrency ~= logical CPUs).
    let c = std::thread::available_parallelism()
        .map(|x| x.get())
        .unwrap_or(12);
    let n = c.min(12); // mirrors POOL_SIZE = min(hardwareConcurrency, 12)
    let t_fix = (c / n).max(1); // proposed batch fix: ~1 thread per worker

    // Distinct thread-count regimes to compare: C (current browser), 2 (middle), 1/T_fix (fix).
    let mut regimes: Vec<usize> = vec![c, 2, t_fix, 1];
    regimes.sort_unstable();
    regimes.dedup();

    // --- Untimed correctness pass: decode once per regime T, assert byte-identical. ---
    let reference = {
        let p = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap();
        p.install(|| decode_full(strip, w, h, &params))
    };
    assert_eq!(reference.len(), w * h * 3, "unexpected RGB8 length");
    for &t in &regimes {
        let p = rayon::ThreadPoolBuilder::new()
            .num_threads(t)
            .build()
            .unwrap();
        let out = p.install(|| decode_full(strip, w, h, &params));
        assert!(
            out == reference,
            "RGB8 differs at T={t} — thread count changed output (BUG)"
        );
    }

    let mp = (w * h) as f64 / 1e6;
    println!("=== batch decode-pool oversubscription: native proxy (Task 2.1) ===");
    println!(
        "file: {path}\n{w}x{h} = {mp:.1} MP · strip {} KB · power: {}",
        strip.len() / 1024,
        power::ac_state()
    );
    println!(
        "C (available_parallelism) = {c} · N (POOL_SIZE = min(C,12)) = {n} · T_fix = max(1,C/N) = {t_fix}"
    );
    println!(
        "N={n} decodes run CONCURRENTLY; each confined to its own T-thread rayon pool.\n\
         Browser today = N x C = {} rayon threads; proposed fix = N x {t_fix} = {} threads.\n\
         RGB8 verified byte-identical across all T. (native proxy — see file header)\n",
        n * c,
        n * t_fix
    );

    // --- Flip-flop timing: rounds with rotated regime order, median of ≥5. ---
    let rounds = 7usize;
    let mut samples: Vec<Vec<f64>> = vec![Vec::with_capacity(rounds); regimes.len()];
    for r in 0..rounds {
        // rotate start index to cancel any position/thermal bias
        let rot = r % regimes.len();
        for k in 0..regimes.len() {
            let idx = (rot + k) % regimes.len();
            let t = regimes[idx];
            let ms = run_regime(t, n, strip, w, h, &params);
            samples[idx].push(ms);
        }
        eprintln!("  round {}/{rounds} done", r + 1);
    }

    // --- Report table ---
    println!(
        "{:>4}  {:>13}  {:>16}  {:>14}  {:>12}",
        "T", "totalThreads", "medianWall_ms", "decodes/s", "MP/s"
    );
    let mut med_by_t: std::collections::BTreeMap<usize, f64> = Default::default();
    for (i, &t) in regimes.iter().enumerate() {
        let med = median(samples[i].clone());
        med_by_t.insert(t, med);
        let secs = med / 1e3;
        let dps = n as f64 / secs;
        let mps = n as f64 * mp / secs;
        println!(
            "{:>4}  {:>13}  {:>16.1}  {:>14.2}  {:>12.1}",
            t,
            n * t,
            med,
            dps,
            mps
        );
    }

    // --- Headline: T=1 (or T_fix) vs T=C ---
    let m_c = med_by_t.get(&c).copied();
    let m_one = med_by_t.get(&1).or_else(|| med_by_t.get(&t_fix)).copied();
    println!();
    if let (Some(mc), Some(m1)) = (m_c, m_one) {
        let speedup = mc / m1;
        let tag = if 1 == t_fix { "T=1" } else { "T=T_fix" };
        println!(
            "HEADLINE  {tag} vs T=C ({c}):  {mc:.1}ms -> {m1:.1}ms  =>  {speedup:.2}x {}",
            if speedup >= 1.0 { "FASTER (fix wins)" } else { "SLOWER (fix loses)" }
        );
        println!(
            "  i.e. capping each concurrent decode to 1 rayon thread is {:.0}% {} than giving it C.",
            (speedup - 1.0).abs() * 100.0,
            if speedup >= 1.0 { "faster" } else { "slower" }
        );
    }
    println!(
        "\nrounds={rounds} (median), regimes flip-flopped per round. power={}",
        power::ac_state()
    );
}
