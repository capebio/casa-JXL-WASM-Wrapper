//! Quantifies the work CRAWL A-1 skips on the OUT_FULL_RGB8-only ORF path:
//! the full-res planar bilinear demosaic (`demosaic_rggb_planar`) that previously
//! ran unconditionally and was discarded when no preview output was requested.
//!
//! Run: cargo run --release --no-default-features --example planar_demosaic_membench
//!
//! Reports peak/total/alloc-count/time for one demosaic_rggb_planar at Olympus 20MP.
//! (The two planar downscales A-1 also skips live in the root crate; this captures
//!  the dominant skipped cost.)

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

use raw_pipeline::demosaic;

struct Counting;
static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static TOTAL: AtomicUsize = AtomicUsize::new(0);
static COUNT: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            let cur = CURRENT.fetch_add(l.size(), Relaxed) + l.size();
            TOTAL.fetch_add(l.size(), Relaxed);
            COUNT.fetch_add(1, Relaxed);
            let mut pk = PEAK.load(Relaxed);
            while cur > pk {
                match PEAK.compare_exchange_weak(pk, cur, Relaxed, Relaxed) {
                    Ok(_) => break,
                    Err(x) => pk = x,
                }
            }
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        CURRENT.fetch_sub(l.size(), Relaxed);
        System.dealloc(p, l);
    }
}

#[global_allocator]
static A: Counting = Counting;

const MB: f64 = 1024.0 * 1024.0;

fn main() {
    let (w, h) = (5184usize, 3888); // Olympus E-M1 III, ~20.2 MP, even/RGGB
    let raw = vec![1000u16; w * h];
    // warm
    let _ = demosaic::demosaic_rggb_planar(&raw, w, h).unwrap();

    let reps = 7;
    let mut peaks = Vec::new();
    let mut totals = Vec::new();
    let mut counts = Vec::new();
    let mut times = Vec::new();
    for _ in 0..reps {
        let base = CURRENT.load(Relaxed);
        PEAK.store(base, Relaxed);
        TOTAL.store(0, Relaxed);
        COUNT.store(0, Relaxed);
        let t = Instant::now();
        let planes = demosaic::demosaic_rggb_planar(&raw, w, h).unwrap();
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        peaks.push((PEAK.load(Relaxed).saturating_sub(base)) as f64 / MB);
        totals.push(TOTAL.load(Relaxed) as f64 / MB);
        counts.push(COUNT.load(Relaxed));
        times.push(ms);
        std::hint::black_box(&planes);
        drop(planes);
    }
    let med = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };
    println!(
        "demosaic_rggb_planar @ {}x{} ({:.1} MP)",
        w,
        h,
        (w * h) as f64 / 1e6
    );
    println!("  peak_transient_MB : {:.1}", med(&mut peaks));
    println!("  total_alloc_MB    : {:.1}", med(&mut totals));
    println!("  alloc_count       : {}", counts[counts.len() / 2]);
    println!("  median_ms         : {:.2}", med(&mut times));
    println!("(this is the per-image cost CRAWL A-1 eliminates on OUT_FULL_RGB8-only decode,");
    println!(" plus two planar downscales that live in the root crate)");
}
