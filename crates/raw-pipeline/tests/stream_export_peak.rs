//! Peak-memory: streaming full-res export vs whole-frame export (working set above the
//! shared input baseline). Own counting global allocator (this test binary only).
#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]

use raw_pipeline::{decompress, demosaic, jxl_casaencoder, pipeline, stream_export};
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

/// Deterministic synthetic ORF strip (4 bytes/pixel ⇒ decode never truncates). Mirrors
/// `decompress::tests::synth_payload` (not reachable from an integration test binary).
fn synth_strip(width: usize, height: usize, seed: u64) -> Vec<u8> {
    const HEADER_SKIP: usize = 7;
    let n = HEADER_SKIP + width * height * 4;
    let mut v = Vec::with_capacity(n);
    let mut s = seed | 1;
    for _ in 0..n {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        v.push((s >> 24) as u8);
    }
    v
}

fn measure(w: usize, h: usize, params: &pipeline::PipelineParams) -> (usize, usize) {
    let strip = synth_strip(w, h, 0x5EED);
    let base = CUR.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    {
        let raw = decompress::decompress(&strip, w, h).unwrap();
        let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
        let mut rgb8 = vec![0u8; w * h * 3];
        pipeline::process_into_auto(&rgb16, params, &mut rgb8);
        let out = jxl_casaencoder::encode_chunked_rgb8(&rgb8, w as u32, h as u32, 1.0, 3).unwrap();
        std::hint::black_box((&raw, &rgb16, &rgb8, &out));
    }
    let whole = PEAK.load(Ordering::Relaxed) - base;

    let base = CUR.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    {
        let mut out = Vec::new();
        stream_export::export_jxl_streaming_from_strip(&strip, w, h, params.clone(), 0.0, 1.0, 3, &mut out).unwrap();
        std::hint::black_box(&out);
    }
    let stream = PEAK.load(Ordering::Relaxed) - base;
    (whole, stream)
}

#[test]
fn streaming_export_peak_is_constant_and_below_whole() {
    let params = pipeline::PipelineParams::default_olympus();
    // Same width, increasing height (more super-tile bands). Streaming peak ≈ one band
    // (constant); whole-frame peak grows with height. That constant-memory property is
    // the win (it's what makes gigapixel viable), not a fixed ratio.
    let (whole2, stream2) = measure(2048, 4096, &params); // ~2 bands
    let (whole4, stream4) = measure(2048, 8192, &params); // ~4 bands
    println!("h=4096: whole={} stream={} ratio={:.3}", whole2, stream2, stream2 as f64 / whole2 as f64);
    println!("h=8192: whole={} stream={} ratio={:.3}", whole4, stream4, stream4 as f64 / whole4 as f64);

    // Streaming is below whole at both, and the win widens with height.
    assert!(stream2 < whole2, "stream {stream2} !< whole {whole2} @4096");
    assert!(stream4 * 2 < whole4, "stream {stream4} !< whole/2 {whole4} @8192 (win should widen)");
    // Streaming peak is ~constant in height (O(band)), whole roughly doubles.
    assert!(stream4 < stream2 * 3 / 2, "stream peak grew too much with height: {stream2} -> {stream4}");
    assert!(whole4 > whole2 * 3 / 2, "whole peak should grow ~linearly with height: {whole2} -> {whole4}");
}
