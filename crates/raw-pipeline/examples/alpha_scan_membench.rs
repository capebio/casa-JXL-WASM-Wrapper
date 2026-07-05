//! CRAWL F1: alpha detection for casabio encode. The old `alpha_strip` built a
//! full-frame n*3 RGB strip while scanning, then the caller discarded it (the encode
//! variants re-strip at their own sizes). `has_meaningful_alpha` does the same
//! early-out scan with zero allocation. Replicas measured here (the originals are
//! private); the algorithmic difference is exact.
//!
//! Run: cargo run --release --no-default-features --example alpha_scan_membench

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

struct Counting;
static TOTAL: AtomicUsize = AtomicUsize::new(0);
static COUNT: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            TOTAL.fetch_add(l.size(), Relaxed);
            COUNT.fetch_add(1, Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l);
    }
}
#[global_allocator]
static A: Counting = Counting;

// Exact replica of the old alpha_strip (fused scan + RGB strip build).
fn alpha_strip(rgba: &[u8]) -> (bool, Option<Vec<u8>>) {
    let n = rgba.len() / 4;
    let mut rgb = Vec::with_capacity(n * 3);
    for px in rgba.chunks_exact(4) {
        if px[3] < 255 {
            return (true, None);
        }
        rgb.extend_from_slice(&px[0..3]);
    }
    (false, Some(rgb))
}
fn has_meaningful_alpha(rgba: &[u8]) -> bool {
    rgba.chunks_exact(4).any(|px| px[3] < 255)
}

const MB: f64 = 1024.0 * 1024.0;

fn bench<F: Fn() -> bool>(label: &str, reps: usize, f: F) {
    // warm
    std::hint::black_box(f());
    let mut ms = Vec::new();
    let base_total = TOTAL.load(Relaxed);
    let base_count = COUNT.load(Relaxed);
    for _ in 0..reps {
        let t = Instant::now();
        std::hint::black_box(f());
        ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    let alloc_mb = (TOTAL.load(Relaxed) - base_total) as f64 / MB / reps as f64;
    let alloc_n = (COUNT.load(Relaxed) - base_count) / reps;
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "  {:<22} median_ms {:>7.3}  alloc/call {:>6.1} MB ({} allocs)",
        label,
        ms[ms.len() / 2],
        alloc_mb,
        alloc_n
    );
}

fn main() {
    let (w, h) = (6000usize, 4000); // 24 MP
    let rgba = vec![255u8; w * h * 4]; // fully opaque (the RAW case)
    println!(
        "alpha detection @ {}x{} ({:.1} MP), opaque RGBA:",
        w,
        h,
        (w * h) as f64 / 1e6
    );
    bench("alpha_strip (old)", 21, || alpha_strip(&rgba).0);
    bench("has_meaningful_alpha", 21, || has_meaningful_alpha(&rgba));
}
