//! DNG streaming decode: DngRowSource rows must equal the full decode_bytes().raw,
//! and the streaming preview build must use far less peak memory than the full path.
//! Fixture-gated (comp=7 real DNG); skips gracefully in CI without the asset.
use raw_pipeline::decompress::RawRowSource;
use raw_pipeline::dng;

// Counting allocator (this test binary only) for the peak-mem probe.
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

fn find_dng() -> Option<Vec<u8>> {
    for p in [
        r"C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
        "PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
    ] {
        if let Ok(d) = std::fs::read(p) {
            return Some(d);
        }
    }
    None
}

/// DNG streaming full-res export == whole-frame (decode→bayer_mhc(phase)→tone→encode).
/// Fixture-gated (real comp=7 DNG); exercises the phase-aware band demosaic end-to-end.
#[test]
fn dng_export_bytes_equal_whole() {
    use raw_pipeline::{demosaic, jxl_casaencoder, pipeline, stream_export};
    let Some(data) = find_dng() else {
        eprintln!("skip: no DNG fixture");
        return;
    };
    let img = dng::decode_bytes(&data).expect("decode");
    let (w, h) = (img.width, img.height);
    let phase = dng::cfa_phase(img.cfa);
    let rgb16 = demosaic::demosaic_bayer_mhc(&img.raw, w, h, phase).expect("demosaic");
    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = img.black;
    params.white = img.white;
    params.wb_r = img.wb_r;
    params.wb_b = img.wb_b;
    params.color_matrix = img.color_matrix;
    let mut rgb8 = vec![0u8; w * h * 3];
    pipeline::process_into_auto(&rgb16, &params, &mut rgb8);
    let whole = jxl_casaencoder::encode_chunked_rgb8(&rgb8, w as u32, h as u32, 1.0, 3).unwrap();

    let mut streamed = Vec::new();
    stream_export::export_dng_jxl_streaming(&data, 1.0, 3, &mut streamed).unwrap();

    assert_eq!(streamed.len(), whole.len(), "DNG export size differs");
    assert!(streamed == whole, "DNG export bytes differ");
}

#[test]
fn dng_rowsource_rows_equal_full_decode() {
    let Some(data) = find_dng() else {
        eprintln!("skip: no DNG fixture");
        return;
    };
    let full = dng::decode_bytes(&data).expect("full decode");
    let mut src = dng::DngRowSource::new(&data).expect("streaming parse");
    assert_eq!(src.width(), full.width);
    assert_eq!(src.height(), full.height);
    let w = full.width;
    let mut rowbuf = vec![0u16; w];
    let mut streamed = Vec::with_capacity(full.raw.len());
    while src.next_row_into(&mut rowbuf).expect("row") {
        streamed.extend_from_slice(&rowbuf);
    }
    assert_eq!(streamed.len(), full.raw.len());
    assert!(streamed == full.raw, "streamed rows != full decode raw");
}

#[test]
fn dng_peak_mem_stream_vs_full() {
    let Some(data) = find_dng() else {
        eprintln!("skip: no DNG fixture");
        return;
    };
    // Full path working set (above shared input): full raw + full-res MHC RGB.
    let base_full = CUR.load(Ordering::Relaxed);
    PEAK.store(base_full, Ordering::Relaxed);
    {
        let img = dng::decode_bytes(&data).unwrap();
        let rgb = raw_pipeline::demosaic::demosaic_bayer_mhc(
            &img.raw, img.width, img.height, dng::cfa_phase(img.cfa),
        ).unwrap();
        std::hint::black_box((&img.raw, &rgb));
    }
    let full_peak = PEAK.load(Ordering::Relaxed) - base_full;

    // Streaming path working set: one tile-band + tiny half-strip + preview outputs.
    let base_s = CUR.load(Ordering::Relaxed);
    PEAK.store(base_s, Ordering::Relaxed);
    {
        let src = dng::DngRowSource::new(&data).unwrap();
        let (w, h, phase) = (src.meta().width, src.meta().height, src.phase());
        let prev = raw_pipeline::stream_preview::build_previews_streaming(
            src, w, h, phase, &[(300, 300), (120, 120)],
        ).unwrap();
        std::hint::black_box(&prev);
    }
    let stream_peak = PEAK.load(Ordering::Relaxed) - base_s;

    println!("DNG working-set peak: full={} stream={} ratio={:.3}",
        full_peak, stream_peak, stream_peak as f64 / full_peak as f64);
    // comp=7 target ~1/14; assert a robust < 1/2 (also covers a comp=1 ~1/3.5 fixture).
    assert!(stream_peak * 2 < full_peak, "stream peak {} not < full/2 {}", stream_peak, full_peak);
}
