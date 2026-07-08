//! ORF decode: embedded-JPEG PROXY path vs FULL raw pipeline, to a 1920px target.
//!
//! Proves the "manufacturer shortcut" win: for a view/delivery target, decoding the
//! embedded ~3200×2400 preview JPEG (already ≥ the 1920 target) + downscale is far
//! cheaper than decompress→demosaic→tone on the full sensor mosaic. The two outputs
//! are NOT pixel-identical (proxy = camera's baked 8-bit render; full = our custom
//! 16-bit-derived pipeline) — this measures the SPEED gap for the hybrid fast path.
//!
//! Run (native, MSVC):
//!   .\build-msvc.ps1 run -p raw-pipeline --no-default-features --features parallel \
//!     --example orf_proxy_vs_full --release
//! Optional arg: path to an .orf (defaults to the repo test file).

use std::time::Instant;

use raw_pipeline::{decompress, demosaic, pipeline, tiff};

const TARGET_LONG_EDGE: usize = 1920;

fn med(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

/// Downscale so the long edge == TARGET_LONG_EDGE, preserving aspect.
fn target_dims(w: usize, h: usize) -> (usize, usize) {
    if w >= h {
        let dw = TARGET_LONG_EDGE.min(w);
        let dh = ((h * dw + w / 2) / w).max(1);
        (dw, dh)
    } else {
        let dh = TARGET_LONG_EDGE.min(h);
        let dw = ((w * dh + h / 2) / h).max(1);
        (dw, dh)
    }
}

/// FULL raw pipeline → RGB8 at 1920. Mirrors raw_decode_bench::bench_orf stages.
fn full_decode(data: &[u8]) -> (usize, usize, Vec<u8>) {
    let info = tiff::parse(data).expect("ORF parse");
    let w = info.width as usize;
    let h = info.height as usize;
    let end = info.strip_offset as usize + info.strip_byte_count as usize;
    let strip = &data[info.strip_offset as usize..end];
    let raw = decompress::decompress(strip, w, h).expect("decompress");
    let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).expect("demosaic");
    let mut params = pipeline::PipelineParams::default_olympus();
    if let Some(r) = info.wb_r {
        params.wb_r = r;
    }
    if let Some(b) = info.wb_b {
        params.wb_b = b;
    }
    if let Some(m) = info.color_matrix {
        params.color_matrix = Some(m).into();
    }
    let rgb8 = pipeline::process(&rgb16, &params);
    let (dw, dh) = target_dims(w, h);
    let out = pipeline::downscale_rgb8(&rgb8, w, h, dw, dh);
    (dw, dh, out)
}

/// PROXY path via the engine primitive: extract largest embedded JPEG (decode-validated,
/// strip-bounded) → decode → downscale to 1920. Returns (preview_w, preview_h, out_w, out_h, rgb8).
fn proxy_decode(data: &[u8]) -> Option<(usize, usize, usize, usize, Vec<u8>)> {
    let p = raw_pipeline::orf_proxy::orf_proxy_rgb8(data, TARGET_LONG_EDGE).ok()?;
    Some((p.preview_w, p.preview_h, p.width, p.height, p.rgb8))
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| r"C:\Foo\raw-converter\tests\P1110226.ORF".to_string());
    let data = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    println!(
        "orf_proxy_vs_full: {}  ({:.1} MB)  parallel={}",
        path,
        data.len() as f64 / 1e6,
        cfg!(feature = "parallel")
    );

    // Sanity + report the embedded JPEG size once.
    match proxy_decode(&data) {
        Some((jw, jh, dw, dh, out)) => {
            println!(
                "  embedded preview {}×{} → proxy out {}×{} ({} B)",
                jw,
                jh,
                dw,
                dh,
                out.len()
            );
        }
        None => {
            eprintln!("  [warn] no embedded JPEG found — proxy path unavailable");
        }
    }
    let (fw, fh, fout) = full_decode(&data);
    println!("  full raw → {}×{} ({} B)", fw, fh, fout.len());

    // Interleaved A/B (flip = proxy, flop = full) with per-iteration order rotation
    // to cancel thermal drift. Warm up once each first.
    let _ = proxy_decode(&data);
    let _ = full_decode(&data);
    let iters = 9usize;
    let (mut proxy_ms, mut full_ms) = (Vec::new(), Vec::new());
    for k in 0..iters {
        if k % 2 == 0 {
            let t = Instant::now();
            let _ = proxy_decode(&data);
            proxy_ms.push(t.elapsed().as_secs_f64() * 1000.0);
            let t = Instant::now();
            let _ = full_decode(&data);
            full_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        } else {
            let t = Instant::now();
            let _ = full_decode(&data);
            full_ms.push(t.elapsed().as_secs_f64() * 1000.0);
            let t = Instant::now();
            let _ = proxy_decode(&data);
            proxy_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        }
    }
    let (p, f) = (med(proxy_ms), med(full_ms));
    println!("\n  === medians of {} interleaved runs (native, {} threads) ===", iters,
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1));
    println!("  PROXY (embedded JPEG → 1920) : {:8.2} ms", p);
    println!("  FULL  (raw decode   → 1920)  : {:8.2} ms", f);
    println!("  speed-up (full / proxy)      : {:8.2}×", f / p.max(0.001));
    println!("\n  NOTE: outputs differ (proxy = camera 8-bit render; full = custom pipeline).");
    println!("  Native full-decode uses rayon; WASM single-thread full-decode is ~3-5× slower,");
    println!("  so the in-browser proxy advantage is correspondingly larger.");
}
