//! ae2_peak_probe — live-heap high-water A/B for the owned-rgb16 variant entry (AE-2).
//!
//! Counting global allocator (System wrapper) tracks live bytes + peak. Runs the
//! borrowed entry (`encode_variants_from_rgb16`, clones rgb16 on the texture/clarity
//! path) vs the owned entry (`encode_variants_from_rgb16_owned`, in-place) on the same
//! input and prints both peaks + output equality.
//!
//!   cargo run --release --example ae2_peak_probe [w h]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct PeakAlloc;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn bump(n: usize) {
    let live = LIVE.fetch_add(n, Ordering::Relaxed) + n;
    PEAK.fetch_max(live, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for PeakAlloc {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() { bump(l.size()); }
        p
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        let p = System.alloc_zeroed(l);
        if !p.is_null() { bump(l.size()); }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
        System.dealloc(p, l);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = System.realloc(p, l, new);
        if !q.is_null() {
            if new >= l.size() {
                bump(new - l.size());
            } else {
                LIVE.fetch_sub(l.size() - new, Ordering::Relaxed);
            }
        }
        q
    }
}

#[global_allocator]
static A: PeakAlloc = PeakAlloc;

fn rand_rgb16(w: u32, h: u32) -> Vec<u16> {
    let n = (w * h) as usize * 3;
    let mut v = vec![0u16; n];
    let mut s: u32 = 0x85eb_ca6bu32.wrapping_mul(w).wrapping_add(h).wrapping_add(3);
    for x in v.iter_mut() {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *x = (s >> 16) as u16;
    }
    v
}

fn mb(b: usize) -> f64 {
    (b as f64) / (1024.0 * 1024.0)
}

fn main() {
    use raw_pipeline::casabio_encode::{
        encode_variants_from_rgb16_owned, encode_variants_from_rgb16_with_progressive, SourceType,
    };
    let args: Vec<String> = std::env::args().collect();
    let w: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(4000);
    let h: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(3000);

    let mut params = raw_pipeline::pipeline::PipelineParams::default_olympus();
    params.texture = 0.35;
    params.clarity = 0.2;

    // Arm A: borrowed entry (internal full-frame clone on the unsharp path).
    let rgb16 = rand_rgb16(w, h);
    let base = LIVE.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    let va = encode_variants_from_rgb16_with_progressive(
        &rgb16, &params, w, h, SourceType::Raw, false, 0, 0,
    )
    .unwrap();
    let peak_a = PEAK.load(Ordering::Relaxed) - base;
    drop(rgb16);

    // Arm B: owned entry (in-place unsharp, buffer dropped before the fan-out).
    let rgb16 = rand_rgb16(w, h);
    let base = LIVE.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    let vb = encode_variants_from_rgb16_owned(
        rgb16, &params, w, h, SourceType::Raw, false, 0, 0,
    )
    .unwrap();
    let peak_b = PEAK.load(Ordering::Relaxed) - base;

    let equal = va.thumb_300 == vb.thumb_300
        && va.preview_1080 == vb.preview_1080
        && va.full == vb.full;
    println!(
        "{}x{} texture/clarity on: borrowed peak-above-entry {:.1} MB, owned {:.1} MB, delta {:.1} MB, outputs {}",
        w, h,
        mb(peak_a),
        mb(peak_b),
        mb(peak_a.saturating_sub(peak_b)),
        if equal { "IDENTICAL" } else { "DIFFER (FAIL)" },
    );
    assert!(equal, "owned entry must be byte-identical to borrowed entry");
}
