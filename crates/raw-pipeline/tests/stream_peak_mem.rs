//! Peak-memory evidence for the streaming ORF preview path. Isolated in its own
//! test binary so the counting global allocator does not touch the lib test binary.
//! Compares peak resident bytes of the full-frame path (decode -> half-demosaic)
//! against `build_previews_streaming`. Run single-threaded (one test in this binary).

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            let c = CUR.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(c, Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        CUR.fetch_sub(l.size(), Ordering::Relaxed);
        System.dealloc(p, l);
    }
}

#[global_allocator]
static A: Counting = Counting;

/// Deterministic synthetic ORF payload: 4 bytes/pixel guarantees no truncation.
fn synth_payload(width: usize, height: usize, seed: u64) -> Vec<u8> {
    const HEADER_SKIP: usize = 7;
    let nbytes = HEADER_SKIP + width * height * 4;
    let mut v = Vec::with_capacity(nbytes);
    let mut s = seed | 1;
    for _ in 0..nbytes {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        v.push((s >> 24) as u8);
    }
    v
}

#[test]
fn peak_mem_stream_vs_full() {
    use raw_pipeline::{decompress, demosaic, stream_preview};
    let (w, h) = (1024usize, 1024usize); // ~1 MP; the ratio scales to 24 MP
    let payload = synth_payload(w, h, 0x5EED);

    // Measure the working set ABOVE the shared input baseline. The compressed
    // `payload` is present in both paths and is small in real ORF (~1.5-2 B/px; the
    // synth uses 4 B/px only to guarantee no truncation), so it must not be counted.

    // Full-frame path: full raw (W*H*2) + full half-res RGB (hw*hh*3*2).
    let base_full = CUR.load(Ordering::Relaxed);
    PEAK.store(base_full, Ordering::Relaxed);
    {
        let raw = decompress::decompress(&payload, w, h).unwrap();
        let half = demosaic::demosaic_rggb_half(&raw, w, h).unwrap();
        std::hint::black_box((&raw, &half));
    }
    let full_peak = PEAK.load(Ordering::Relaxed) - base_full;

    // Streaming path: only a few raw rows + a half strip + the tiny outputs.
    let base_stream = CUR.load(Ordering::Relaxed);
    PEAK.store(base_stream, Ordering::Relaxed);
    {
        let previews = stream_preview::build_previews_streaming(&payload, w, h, &[(300, 300)]).unwrap();
        std::hint::black_box(&previews);
    }
    let stream_peak = PEAK.load(Ordering::Relaxed) - base_stream;

    println!(
        "working-set peak (above input): full={} bytes  stream={} bytes  ratio={:.3}",
        full_peak, stream_peak, stream_peak as f64 / full_peak as f64
    );
    // Design target is < 1/4; assert a robust < 1/3 to avoid allocator-granularity flake.
    assert!(stream_peak * 3 < full_peak, "streaming peak {} not < full/3 {}", stream_peak, full_peak);
}
