//! RAW decode pipeline benchmark: ORF, DNG, and CR2.
//!
//! Run: `cargo run --bin raw_decode_bench --release`
//!   or via MSVC toolchain: `.\build-msvc.ps1 run --bin raw_decode_bench --release --features jxl-codec,parallel`
//!
//! Measures each stage independently:
//!   - File I/O (excluded from timing)
//!   - Parse + LJPEG decode (incl. crop for CR2)
//!   - Demosaic (RGGB MHC)
//!   - Tonemap (black/WB/matrix/curve → RGB8)
//!   - JXL encode (effort=3/Falcon, quality=90, native threads)
//!   - JXL decode (BSD jxl_decode full decode)
//!   - Total end-to-end (RAW stages only; JXL is additive)
//!
//! Results are written to stdout and to `benchmark/results_native.json`.
//! Schema aligns with WASM `raw-format-sweep-results.json` + handoff metrics:
//!   decompressMs = parse+decomp for ORF; full decode for DNG/CR2.
//!   encodeMs / decodeMs use the same effort=3 / quality=90 settings as the
//!   WASM bench, but native threading is used (expected faster than WASM
//!   single-threaded encode).
//!   directRgbaMs: time for pipeline::process_rgba (fused tone→RGBA8 for direct
//!   JXL encode feed, P3/Tauri parity experiment). The reported encode path now
//!   uses 4ch direct rgba to demonstrate never-materialized 3ch intermediate.
//!
//! Reference sets for Tauri/WASM parity (see docs/HANDOFF-tauri-parity-2026-06-03.md + continuation):
//!   GOB_SCAN_LIMIT + GOB_ROOT for 30-file Gobabeb encode (direct-rgba prep/encode).
//!   P2200_SCAN_LIMIT + P2200_ROOT for 11-file P2200 decode/ROI (extend for JXTC/tiled/progressive).
//!   Emits decode_buffer_extract_ms (0 in native), decode_region_downsample_ms, source_pixels_decoded,
//!   decode_strategy for apples-to-apples with WASM onMetric + crop-benchmark reports.
//!
//! Low-level progressive/ROI decode model lives in `raw_pipeline::jxl_decode` (BSD own-FFI codec).
//! For the full-load progressive demo to use *progressively-encoded* assets (realistic early
//! first-pixel via Dc/groupOrder), enable "jxl-codec":
//!   cargo ... --features jxl-codec,parallel
//!   or: .\build-msvc.ps1 run --bin raw_decode_bench --release --features jxl-codec,parallel
//! This lets the bench and (future) Tauri app share the same libjxl state machine + encode variants.

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use raw_pipeline::{cr2, demosaic, dng, pipeline};

#[cfg(feature = "jxl-codec")]
use raw_pipeline::jxl_decode::{
    bench_jxl_decode_lowlevel_full, bench_jxl_decode_lowlevel_progressive,
};

#[cfg(feature = "jxl-codec")]
use raw_pipeline::casabio_encode::{encode_variants_with_progressive, SourceType};

static SMALL_CROP_TIMES: Mutex<Vec<(String, usize, f64)>> = Mutex::new(Vec::new());
static LOWLEVEL_PROG_FIRSTS: Mutex<Vec<f64>> = Mutex::new(Vec::new());

const RUNS: usize = 3;
// Match WASM bench encode settings (targeted-wasm-timings.mjs).
const JXL_QUALITY: f32 = 90.0;

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Run `f` `RUNS` times and return the minimum duration (wall clock).
fn bench<F: Fn() -> T, T>(f: F) -> (Duration, T) {
    let mut best = Duration::MAX;
    let mut last_result: Option<T> = None;
    for _ in 0..RUNS {
        let t = Instant::now();
        let r = f();
        let elapsed = t.elapsed();
        if elapsed < best {
            best = elapsed;
        }
        last_result = Some(r);
    }
    (best, last_result.unwrap())
}

// ─── JXL encode / decode ─────────────────────────────────────────────────────

/// Encode buffer (RGB8 or RGBA8) to JXL. num_ch must be 3 or 4.
/// Used for the direct-RGBA (native parity) encode path: tone directly to 4ch
/// and feed encoder without ever materializing a retained 3ch RGB8.
fn bench_jxl_encode_with_ch(
    data: &[u8],
    width: u32,
    height: u32,
    num_ch: u32,
) -> Option<(Duration, Vec<u8>)> {
    use raw_pipeline::jxl_casaencoder::{EncodeOptions, Encoder, Frame};

    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let mut best = Duration::MAX;
    let mut last_bytes: Vec<u8> = Vec::new();
    for _ in 0..RUNS {
        // Effort 3 = Falcon (matches WASM bench). Multi-threaded for representative numbers.
        let mut encoder =
            Encoder::with_threads(EncodeOptions::quality(JXL_QUALITY).with_effort(3), threads)
                .ok()?;
        let t = Instant::now();
        let bytes = if num_ch == 4 {
            encoder.encode(&Frame::rgba8(data, width, height)).ok()?
        } else {
            encoder.encode(&Frame::rgb(data, width, height)).ok()?
        };
        let elapsed = t.elapsed();
        if elapsed < best {
            best = elapsed;
        }
        last_bytes = bytes;
    }
    Some((best, last_bytes))
}

/// Decode JXL bytes via the BSD `jxl_decode` layer. Returns min decode duration
/// over RUNS.
///
/// Uses a multi-threaded runner so the decode side matches the encode side
/// (which already threads). libjxl MT decode is deterministic => byte-identical
/// reconstruction.
///
/// Holds ONE `Decoder` (handle + thread runner created once) and ONE output
/// buffer, reused across all RUNS — no per-iteration create/destroy or
/// allocation on the measured hot path (spec §8 criterion 4; `decode_into` =
/// zero-copy out, zero per-decode alloc).
fn bench_jxl_decode(jxl_bytes: &[u8]) -> Option<Duration> {
    use raw_pipeline::jxl_decode::{Channels, DecodeOptions, Decoder};
    let mut dec = Decoder::new(DecodeOptions {
        parallel: true,
        ..Default::default()
    })?;
    let mut buf: Vec<u8> = Vec::new();
    let mut best = Duration::MAX;
    for _ in 0..RUNS {
        let t = Instant::now();
        dec.decode_into::<u8>(jxl_bytes, Channels::Rgba, &mut buf)
            .ok()?;
        let elapsed = t.elapsed();
        if elapsed < best {
            best = elapsed;
        }
    }
    Some(best)
}

/// Shared JXL encode (direct-4ch preferred) + decode metrics for parity.
/// Returns (encode_ms, jxl_size_kb, decode_ms). Dedupes the 4-line tail in bench_* fns.
fn bench_jxl_roundtrip(
    rgba8: &[u8],
    rgb8_fb: &[u8],
    w: u32,
    h: u32,
) -> (Option<f64>, Option<f64>, Option<f64>) {
    let jxl = bench_jxl_encode_with_ch(rgba8, w, h, 4)
        .or_else(|| bench_jxl_encode_with_ch(rgb8_fb, w, h, 3));
    let ems = jxl.as_ref().map(|(d, _)| ms(*d));
    let sz = jxl.as_ref().map(|(_, b)| b.len() as f64 / 1024.0);
    let dms = jxl
        .as_ref()
        .and_then(|(_, b)| bench_jxl_decode(b))
        .map(|d| ms(d));
    (ems, sz, dms)
}

// ─── Result collection ───────────────────────────────────────────────────────

struct BenchRow {
    file: String,
    format: &'static str,
    width: usize,
    height: usize,
    size_mb: f64,
    /// parse+decomp for ORF; full LJPEG decode for DNG/CR2.
    decompress_ms: f64,
    demosaic_ms: f64,
    tonemap_ms: f64,
    total_ms: f64,
    /// JXL encode time; None if encode failed.
    encode_ms: Option<f64>,
    jxl_size_kb: Option<f64>,
    /// JXL decode time; None if decode failed (requires encode success).
    decode_ms: Option<f64>,
    /// Direct RGBA tone time (process_rgba) — the native "prep" path for encode-only flows.
    /// Measures the fused tone+alpha path that avoids an intermediate RGB8 Vec.
    direct_rgba_ms: Option<f64>,

    // --- Shared handoff metrics (for WASM/Tauri apples-to-apples parity per HANDOFF-tauri-parity) ---
    /// decode_buffer_extract_ms: cost of pulling pixels out for consumer. Expect ~0 in native (direct ownership / zero-copy to texture).
    decode_buffer_extract_ms: Option<f64>,
    /// decode_region_downsample_ms: the decode work performed for the requested region (or full for baseline).
    decode_region_downsample_ms: Option<f64>,
    /// source_pixels_decoded: authoritative count of source pixels the decoder actually processed (full size vs ROI savings visible here).
    source_pixels_decoded: Option<u64>,
    /// decode_strategy: "full" | "region-full-then-crop" | "native-crop" | "tiled" | "jxtc" | "progressive-dc" etc. for breakdown tables.
    decode_strategy: Option<String>,
}

fn opt_f64(v: f64) -> String {
    format!("{:.3}", v)
}

fn json_opt(v: Option<f64>) -> String {
    match v {
        Some(x) => format!("{:.3}", x),
        None => "null".to_string(),
    }
}

fn json_str(v: &str) -> String {
    let mut out = String::with_capacity(v.len() + 2);
    out.push('"');
    for ch in v.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c <= '\u{1f}' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn rows_to_json(rows: &[BenchRow], generated_at: &str) -> String {
    let mut out = String::new();
    out.push_str("{\n");
    out.push_str(&format!("  \"generatedAt\": {},\n", json_str(generated_at)));
    out.push_str(&format!("  \"runsPerFile\": {RUNS},\n"));
    out.push_str("  \"reporting\": \"minimum\",\n");
    out.push_str(&format!("  \"jxlQuality\": {JXL_QUALITY},\n"));
    out.push_str("  \"jxlEffort\": 3,\n");
    out.push_str("  \"rows\": [\n");
    for (i, row) in rows.iter().enumerate() {
        let comma = if i + 1 < rows.len() { "," } else { "" };
        out.push_str("    {\n");
        out.push_str(&format!(
            "      \"file\": {},\n",
            json_str(&row.file.replace('\\', "/"))
        ));
        out.push_str(&format!("      \"format\": {},\n", json_str(row.format)));
        out.push_str(&format!("      \"width\": {},\n", row.width));
        out.push_str(&format!("      \"height\": {},\n", row.height));
        out.push_str(&format!("      \"sizeMB\": {},\n", opt_f64(row.size_mb)));
        out.push_str(&format!(
            "      \"decompressMs\": {},\n",
            opt_f64(row.decompress_ms)
        ));
        out.push_str(&format!(
            "      \"demosaicMs\": {},\n",
            opt_f64(row.demosaic_ms)
        ));
        out.push_str(&format!(
            "      \"tonemapMs\": {},\n",
            opt_f64(row.tonemap_ms)
        ));
        out.push_str(&format!("      \"totalMs\": {},\n", opt_f64(row.total_ms)));
        out.push_str(&format!(
            "      \"encodeMs\": {},\n",
            json_opt(row.encode_ms)
        ));
        out.push_str(&format!(
            "      \"jxlSizeKB\": {},\n",
            json_opt(row.jxl_size_kb)
        ));
        out.push_str(&format!(
            "      \"decodeMs\": {},\n",
            json_opt(row.decode_ms)
        ));
        out.push_str(&format!(
            "      \"directRgbaMs\": {},\n",
            json_opt(row.direct_rgba_ms)
        ));
        out.push_str(&format!(
            "      \"decodeBufferExtractMs\": {},\n",
            json_opt(row.decode_buffer_extract_ms)
        ));
        out.push_str(&format!(
            "      \"decodeRegionDownsampleMs\": {},\n",
            json_opt(row.decode_region_downsample_ms)
        ));
        out.push_str(&format!(
            "      \"sourcePixelsDecoded\": {},\n",
            row.source_pixels_decoded
                .map(|v| v.to_string())
                .unwrap_or_else(|| "null".to_string())
        ));
        out.push_str(&format!(
            "      \"decodeStrategy\": {}\n",
            row.decode_strategy
                .as_ref()
                .map(|s| json_str(s))
                .unwrap_or_else(|| "null".to_string())
        ));
        out.push_str(&format!("    }}{comma}\n"));
    }
    out.push_str("  ]\n");
    out.push_str("}\n");
    out
}

struct ClarityTimings {
    cold: Duration,
    warm: Duration,
}

struct ToneOutputs {
    tone_dur: Duration,
    rgb8: Vec<u8>,
    direct_rgba_dur: Duration,
    rgba8: Vec<u8>,
}

fn measure_clarity(
    rgb16: &[u16],
    w: usize,
    h: usize,
    params: &pipeline::PipelineParams,
) -> ClarityTimings {
    let mut cp = params.clone();
    cp.clarity = 0.5;
    let mut scratch = rgb16.to_vec();
    let s = Instant::now();
    pipeline::apply_unsharp_masks(&mut scratch, w, h, &cp);
    let cold = s.elapsed();

    scratch.copy_from_slice(rgb16);
    let s = Instant::now();
    pipeline::apply_unsharp_masks(&mut scratch, w, h, &cp);
    let warm = s.elapsed();

    ClarityTimings { cold, warm }
}

fn bench_tone_outputs(rgb16: &[u16], params: &pipeline::PipelineParams) -> ToneOutputs {
    let (tone_dur, rgb8) = bench(|| pipeline::process(rgb16, params));
    let (direct_rgba_dur, rgba8) = bench(|| pipeline::process_rgba(rgb16, params));
    ToneOutputs {
        tone_dur,
        rgb8,
        direct_rgba_dur,
        rgba8,
    }
}

fn print_jxl_result(encode_ms: Option<f64>, jxl_size_kb: Option<f64>, decode_ms: Option<f64>) {
    match (encode_ms, jxl_size_kb, decode_ms) {
        (Some(enc), Some(sz), Some(dec)) => {
            println!("  jxl encode {enc:.1}ms  {sz:.1} KB  decode {dec:.1}ms  (via direct rgba)")
        }
        _ => println!("  jxl encode/decode: failed"),
    }
}

#[allow(clippy::too_many_arguments)]
fn push_full_row(
    rows: &mut Vec<BenchRow>,
    file: String,
    format: &'static str,
    width: usize,
    height: usize,
    size_mb: f64,
    decompress_ms: f64,
    demosaic_dur: Duration,
    tone: &ToneOutputs,
    total: Duration,
    encode_ms: Option<f64>,
    jxl_size_kb: Option<f64>,
    decode_ms: Option<f64>,
) {
    rows.push(BenchRow {
        file,
        format,
        width,
        height,
        size_mb,
        decompress_ms,
        demosaic_ms: ms(demosaic_dur),
        tonemap_ms: ms(tone.tone_dur),
        total_ms: ms(total),
        encode_ms,
        jxl_size_kb,
        decode_ms,
        direct_rgba_ms: Some(ms(tone.direct_rgba_dur)),
        decode_buffer_extract_ms: Some(0.0),
        decode_region_downsample_ms: decode_ms,
        source_pixels_decoded: Some((width * height) as u64),
        decode_strategy: Some("full".to_string()),
    });
}

// ─── Format benchmarks ───────────────────────────────────────────────────────

fn bench_dng(path: &str, rows: &mut Vec<BenchRow>) {
    let Ok(data) = std::fs::read(path) else {
        eprintln!("  [skip] {path} — not found");
        return;
    };
    let size_mb = data.len() as f64 / 1e6;

    let (decode_dur, img) = bench(|| dng::decode_bytes(&data).expect("DNG decode"));
    let orig_w = img.width;
    let orig_h = img.height;

    let (raw_aligned, w, h) = dng::align_to_rggb(&img.raw, orig_w, orig_h, img.cfa);
    let mp = w * h;

    let (demosaic_dur, rgb16) =
        bench(|| demosaic::demosaic_rggb_mhc(&raw_aligned, w, h).expect("demosaic"));

    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = img.black;
    params.white = img.white;
    params.wb_r = img.wb_r;
    params.wb_b = img.wb_b;
    params.color_matrix = img.color_matrix.into();

    let clarity = measure_clarity(&rgb16, w, h, &params);
    let tone = bench_tone_outputs(&rgb16, &params);

    // Use direct RGBA + 4ch encode for the measured JXL path (Tauri direct-feed parity).
    // This never materializes a standalone owned 3ch RGB8 for the encode-only case.
    // Fallback to 3ch (from the tone result) if 4ch encode fails for this file (seen on some DNG test images).
    let (encode_ms, jxl_size_kb, decode_ms) =
        bench_jxl_roundtrip(&tone.rgba8, &tone.rgb8, w as u32, h as u32);

    let name = Path::new(path).file_name().unwrap().to_string_lossy();
    let total = decode_dur + demosaic_dur + tone.tone_dur;
    let demosaic_s = ms(demosaic_dur) / 1000.0;
    let mpps = if demosaic_s > 0.0 {
        mp as f64 / 1e6 / demosaic_s
    } else {
        0.0
    };

    println!("DNG  {name}");
    println!("  {w}×{h}  {:.1} MB  ({} MP)", size_mb, mp / 1_000_000);
    println!(
        "  decode {:.1}ms  demosaic {:.1}ms ({:.1} MP/s)  tone {:.1}ms  direct-rgba {:.1}ms  total {:.1}ms",
        ms(decode_dur), ms(demosaic_dur), mpps, ms(tone.tone_dur), ms(tone.direct_rgba_dur), ms(total)
    );
    println!(
        "  clarity@0.5  cold={:.1}ms  warm={:.1}ms  ({:.1}% of total warm)",
        ms(clarity.cold),
        ms(clarity.warm),
        100.0 * ms(clarity.warm) / ms(total)
    );
    println!(
        "  WB R={:.3} B={:.3}  black={}  white={}",
        img.wb_r, img.wb_b, img.black, img.white
    );
    print_jxl_result(encode_ms, jxl_size_kb, decode_ms);
    println!();

    push_full_row(
        rows,
        name.into_owned(),
        "DNG",
        w,
        h,
        size_mb,
        ms(decode_dur),
        demosaic_dur,
        &tone,
        total,
        encode_ms,
        jxl_size_kb,
        decode_ms,
    );
}

fn bench_cr2(path: &str, rows: &mut Vec<BenchRow>) {
    let Ok(data) = std::fs::read(path) else {
        eprintln!("  [skip] {path} — not found");
        return;
    };
    let size_mb = data.len() as f64 / 1e6;

    let (decode_dur, img) = bench(|| cr2::decode_bytes(&data).expect("CR2 decode"));
    let w = img.width;
    let h = img.height;
    let mp = w * h;

    let (demosaic_dur, rgb16) =
        bench(|| demosaic::demosaic_rggb_mhc(&img.raw, w, h).expect("demosaic"));

    let mut params = pipeline::PipelineParams::default_olympus();
    params.black = img.black;
    params.white = img.white;
    params.wb_r = img.wb_r;
    params.wb_b = img.wb_b;
    params.color_matrix = img.color_matrix.into();
    let tone = bench_tone_outputs(&rgb16, &params);

    // Use direct RGBA + 4ch encode for the measured JXL path (Tauri direct-feed parity).
    // This never materializes a standalone owned 3ch RGB8 for the encode-only case.
    // Fallback to 3ch (from the tone result) if 4ch encode fails for this file (seen on some DNG test images).
    let (encode_ms, jxl_size_kb, decode_ms) =
        bench_jxl_roundtrip(&tone.rgba8, &tone.rgb8, w as u32, h as u32);

    let name = Path::new(path).file_name().unwrap().to_string_lossy();
    let total = decode_dur + demosaic_dur + tone.tone_dur;
    let demosaic_s = ms(demosaic_dur) / 1000.0;
    let mpps = if demosaic_s > 0.0 {
        mp as f64 / 1e6 / demosaic_s
    } else {
        0.0
    };

    println!("CR2  {name}");
    println!("  {w}×{h}  {:.1} MB  ({} MP)", size_mb, mp / 1_000_000);
    println!(
        "  decode {:.1}ms  demosaic {:.1}ms ({:.1} MP/s)  tone {:.1}ms  direct-rgba {:.1}ms  total {:.1}ms",
        ms(decode_dur), ms(demosaic_dur), mpps, ms(tone.tone_dur), ms(tone.direct_rgba_dur), ms(total)
    );
    println!(
        "  WB R={:.3} B={:.3}  black={}  white={}  ISO={:?}",
        img.wb_r, img.wb_b, img.black, img.white, img.iso
    );
    print_jxl_result(encode_ms, jxl_size_kb, decode_ms);
    println!();

    push_full_row(
        rows,
        name.into_owned(),
        "CR2",
        w,
        h,
        size_mb,
        ms(decode_dur),
        demosaic_dur,
        &tone,
        total,
        encode_ms,
        jxl_size_kb,
        decode_ms,
    );
}

fn bench_orf(path: &str, rows: &mut Vec<BenchRow>) {
    use raw_pipeline::{decompress, tiff};

    let Ok(data) = std::fs::read(path) else {
        eprintln!("  [skip] {path} — not found");
        return;
    };
    let size_mb = data.len() as f64 / 1e6;

    let (parse_dur, info) = bench(|| tiff::parse(&data).expect("ORF parse"));
    let w = info.width as usize;
    let h = info.height as usize;
    let mp = w * h;
    let strip_end = info.strip_offset as usize + info.strip_byte_count as usize;
    if strip_end > data.len() {
        eprintln!(
            "  [skip] {path} — strip out of bounds ({strip_end} > {})",
            data.len()
        );
        return;
    }
    let strip = &data[info.strip_offset as usize..strip_end];

    let (decomp_dur, raw) = bench(|| decompress::decompress(strip, w, h).expect("ORF decompress"));
    let (demosaic_dur, rgb16) = bench(|| demosaic::demosaic_rggb(&raw, w, h).expect("demosaic"));

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

    let clarity = measure_clarity(&rgb16, w, h, &params);
    let tone = bench_tone_outputs(&rgb16, &params);

    // Use direct RGBA + 4ch encode for the measured JXL path (Tauri direct-feed parity).
    // This never materializes a standalone owned 3ch RGB8 for the encode-only case.
    // Fallback to 3ch (from the tone result) if 4ch encode fails for this file (seen on some DNG test images).
    let (encode_ms, jxl_size_kb, decode_ms) =
        bench_jxl_roundtrip(&tone.rgba8, &tone.rgb8, w as u32, h as u32);

    let name = Path::new(path).file_name().unwrap().to_string_lossy();
    let total = parse_dur + decomp_dur + demosaic_dur + tone.tone_dur;
    let demosaic_s = ms(demosaic_dur) / 1000.0;
    let mpps = if demosaic_s > 0.0 {
        mp as f64 / 1e6 / demosaic_s
    } else {
        0.0
    };

    println!("ORF  {name}");
    println!("  {w}×{h}  {:.1} MB  ({} MP)", size_mb, mp / 1_000_000);
    println!(
        "  parse {:.1}ms  decomp {:.1}ms  demosaic {:.1}ms ({:.1} MP/s)  tone {:.1}ms  direct-rgba {:.1}ms  total {:.1}ms",
        ms(parse_dur), ms(decomp_dur), ms(demosaic_dur), mpps, ms(tone.tone_dur), ms(tone.direct_rgba_dur), ms(total)
    );
    println!(
        "  clarity@0.5  cold={:.1}ms  warm={:.1}ms  ({:.1}% of total warm)",
        ms(clarity.cold),
        ms(clarity.warm),
        100.0 * ms(clarity.warm) / ms(total)
    );
    print_jxl_result(encode_ms, jxl_size_kb, decode_ms);
    println!();

    // decompressMs = parse+decomp combined. WASM ProcessResult.decompress_ms
    // covers only the decompress step; parse overhead is noted here.
    push_full_row(
        rows,
        name.into_owned(),
        "ORF",
        w,
        h,
        size_mb,
        ms(parse_dur) + ms(decomp_dur),
        demosaic_dur,
        &tone,
        total,
        encode_ms,
        jxl_size_kb,
        decode_ms,
    );
}

// ─── Perf flipflop benches ────────────────────────────────────────────────────

fn median_dur(v: &mut Vec<Duration>) -> Duration {
    v.sort_unstable();
    let n = v.len();
    if n == 0 {
        return Duration::ZERO;
    }
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2
    }
}

/// Alternating flip (current serial impl) / flop (parallel candidate) rounds.
/// No separate baseline needed — the flip side IS the baseline.
fn bench_perf_flipflop() {
    const ROUNDS: usize = 8; // 4 flip + 4 flop per experiment

    println!("=== Perf Flipflop Bench (serial vs parallel candidates) ===\n");

    // ── 1. apply_luminance_nr blend loop ─────────────────────────────────────
    // 4000×3000×3 ch ≈ 12 MP (representative ORF size)
    let w = 4000usize;
    let h = 3000usize;
    let n = w * h * 3;
    // Synthetic data — we're timing the blend arithmetic, not the blur itself.
    let mut rgb16: Vec<u16> = (0..n)
        .map(|i| ((i.wrapping_mul(37).wrapping_add(13)) % 65536) as u16)
        .collect();
    let blurred: Vec<u16> = (0..n)
        .map(|i| ((i.wrapping_mul(17).wrapping_add(7)) % 65536) as u16)
        .collect();
    let s = 0.3f32;

    let mut flip_times: Vec<Duration> = Vec::new();
    let mut flop_times: Vec<Duration> = Vec::new();

    for round in 0..ROUNDS {
        if round % 2 == 0 {
            // flip — serial while loop (current impl in pipeline.rs:1507-1514)
            let t = Instant::now();
            let mut i = 0;
            while i < n {
                let o = rgb16[i] as f32;
                let b = blurred[i] as f32;
                rgb16[i] = (o + (b - o) * s).round().clamp(0.0, 65535.0) as u16;
                i += 1;
            }
            flip_times.push(t.elapsed());
        } else {
            // flop — par_iter_mut (candidate)
            #[cfg(feature = "parallel")]
            {
                use rayon::prelude::*;
                let t = Instant::now();
                rgb16
                    .par_iter_mut()
                    .zip(blurred.par_iter())
                    .for_each(|(o, &b)| {
                        let ov = *o as f32;
                        *o = (ov + (b as f32 - ov) * s).round().clamp(0.0, 65535.0) as u16;
                    });
                flop_times.push(t.elapsed());
            }
            #[cfg(not(feature = "parallel"))]
            {
                // rayon unavailable — flop mirrors flip so verdict prints "keep serial"
                let t = Instant::now();
                let mut i = 0;
                while i < n {
                    let o = rgb16[i] as f32;
                    let b = blurred[i] as f32;
                    rgb16[i] = (o + (b - o) * s).round().clamp(0.0, 65535.0) as u16;
                    i += 1;
                }
                flop_times.push(t.elapsed());
            }
        }
    }

    let flip_med = median_dur(&mut flip_times);
    let flop_med = median_dur(&mut flop_times);
    let speedup = if ms(flop_med) > 0.001 {
        ms(flip_med) / ms(flop_med)
    } else {
        0.0
    };
    println!("apply_luminance_nr blend loop  ({w}×{h}×3ch, strength={s})");
    println!("  flip (serial):   {:.2}ms", ms(flip_med));
    println!("  flop (parallel): {:.2}ms", ms(flop_med));
    println!(
        "  speedup: {speedup:.2}×  →  {}",
        if speedup > 1.15 {
            "PARALLEL WINS — apply in pipeline.rs"
        } else {
            "keep serial (overhead dominates)"
        }
    );
    println!();

    // ── 2. downscale_rgb16_into exact-factor path ─────────────────────────────
    // 4000×3000 → 800×600 (5× exact — most common thumbnail ratio)
    let sw = 4000usize;
    let sh = 3000usize;
    let dw = 800usize;
    let dh = 600usize;
    let xstep = sw / dw; // 5
    let ystep = sh / dh; // 5
    let n_src = sw * sh * 3;
    let n_dst = dw * dh * 3;
    let src: Vec<u16> = (0..n_src)
        .map(|i| ((i.wrapping_mul(37).wrapping_add(13)) % 65536) as u16)
        .collect();
    let mut out_a = vec![0u16; n_dst];
    let mut out_b = vec![0u16; n_dst];

    let mut flip_times2: Vec<Duration> = Vec::new();
    let mut flop_times2: Vec<Duration> = Vec::new();

    for round in 0..ROUNDS {
        if round % 2 == 0 {
            // flip — serial for dy (current impl in pipeline.rs:1612-1634)
            let n_px = (xstep * ystep) as u32;
            let t = Instant::now();
            for dy in 0..dh {
                let row = &mut out_a[dy * dw * 3..(dy + 1) * dw * 3];
                for dx in 0..dw {
                    let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                    for yy in 0..ystep {
                        let y = dy * ystep + yy;
                        let base = (y * sw + dx * xstep) * 3;
                        for xx in 0..xstep {
                            let i = base + xx * 3;
                            rr += src[i] as u32;
                            gg += src[i + 1] as u32;
                            bb += src[i + 2] as u32;
                        }
                    }
                    let o = dx * 3;
                    row[o] = (rr / n_px) as u16;
                    row[o + 1] = (gg / n_px) as u16;
                    row[o + 2] = (bb / n_px) as u16;
                }
            }
            flip_times2.push(t.elapsed());
        } else {
            // flop — par_chunks_mut (candidate)
            #[cfg(feature = "parallel")]
            {
                use rayon::prelude::*;
                let n_px = (xstep * ystep) as u32;
                let t = Instant::now();
                out_b
                    .par_chunks_mut(dw * 3)
                    .enumerate()
                    .for_each(|(dy, row)| {
                        for dx in 0..dw {
                            let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                            for yy in 0..ystep {
                                let y = dy * ystep + yy;
                                let base = (y * sw + dx * xstep) * 3;
                                for xx in 0..xstep {
                                    let i = base + xx * 3;
                                    rr += src[i] as u32;
                                    gg += src[i + 1] as u32;
                                    bb += src[i + 2] as u32;
                                }
                            }
                            let o = dx * 3;
                            row[o] = (rr / n_px) as u16;
                            row[o + 1] = (gg / n_px) as u16;
                            row[o + 2] = (bb / n_px) as u16;
                        }
                    });
                flop_times2.push(t.elapsed());
            }
            #[cfg(not(feature = "parallel"))]
            {
                let n_px = (xstep * ystep) as u32;
                let t = Instant::now();
                for dy in 0..dh {
                    let row = &mut out_b[dy * dw * 3..(dy + 1) * dw * 3];
                    for dx in 0..dw {
                        let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
                        for yy in 0..ystep {
                            let y = dy * ystep + yy;
                            let base = (y * sw + dx * xstep) * 3;
                            for xx in 0..xstep {
                                let i = base + xx * 3;
                                rr += src[i] as u32;
                                gg += src[i + 1] as u32;
                                bb += src[i + 2] as u32;
                            }
                        }
                        let o = dx * 3;
                        row[o] = (rr / n_px) as u16;
                        row[o + 1] = (gg / n_px) as u16;
                        row[o + 2] = (bb / n_px) as u16;
                    }
                }
                flop_times2.push(t.elapsed());
            }
        }
    }

    let flip_med2 = median_dur(&mut flip_times2);
    let flop_med2 = median_dur(&mut flop_times2);
    let speedup2 = if ms(flop_med2) > 0.001 {
        ms(flip_med2) / ms(flop_med2)
    } else {
        0.0
    };
    println!("downscale_rgb16_into exact 5×  ({sw}×{sh} → {dw}×{dh})");
    println!("  flip (serial):   {:.2}ms", ms(flip_med2));
    println!("  flop (parallel): {:.2}ms", ms(flop_med2));
    println!(
        "  speedup: {speedup2:.2}×  →  {}",
        if speedup2 > 1.15 {
            "PARALLEL WINS — apply in pipeline.rs"
        } else {
            "keep serial (overhead dominates)"
        }
    );
    println!();

    println!("=== End Flipflop ===\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

fn main() {
    println!("=== RAW Decode Pipeline Benchmark ===");
    println!("Runs per file: {RUNS} (reporting minimum)");
    println!("JXL: effort=3 (Falcon), quality={JXL_QUALITY}");
    // Loud guard: the tone/demosaic passes only multi-thread when the root
    // `parallel` feature (-> raw-pipeline/parallel = rayon) is enabled. It is NOT
    // a default (the root crate is also the WASM cdylib; rayon would break that
    // build). Built without it, tone/demosaic run the single-threaded scalar path
    // and timings are ~5-7x slower — which looks like "the optimisation was lost".
    if cfg!(feature = "parallel") {
        println!("Pipeline threading: ON (rayon, --features parallel)\n");
    } else {
        eprintln!("\n!!! WARNING: built WITHOUT `parallel` — tone/demosaic run SINGLE-THREADED.");
        eprintln!("!!! Timings will be ~5-7x slower. Re-run with:");
        eprintln!("!!!   .\\build-msvc.ps1 run --bin raw_decode_bench --release --features \"jxl-codec,parallel\"\n");
    }

    // Flipflop perf bench — runs before heavy file benches while CPU is cool.
    // Skip with env SKIP_FLIPFLOP=1.
    if std::env::var("SKIP_FLIPFLOP").unwrap_or_default() != "1" {
        bench_perf_flipflop();
    }

    let test_dir = r"C:\Foo\raw-converter\tests";
    let mut rows: Vec<BenchRow> = Vec::new();

    if std::env::var("SKIP_INITIAL_TEST_BENCHES").unwrap_or_default() != "1" {
        bench_orf(&format!("{test_dir}\\P1110226.ORF"), &mut rows);

        bench_dng(
            &format!("{test_dir}\\PXL_20260501_093507165.RAW-02.ORIGINAL.dng"),
            &mut rows,
        );
        bench_dng(
            &format!("{test_dir}\\PXL_20260501_095020990.RAW-02.ORIGINAL.dng"),
            &mut rows,
        );
        bench_dng(
            &format!("{test_dir}\\PXL_20260501_100404049.RAW-02.ORIGINAL.dng"),
            &mut rows,
        );

        bench_cr2(&format!("{test_dir}\\_MG_1744.CR2"), &mut rows);
        bench_cr2(&format!("{test_dir}\\_MG_1747.CR2"), &mut rows);
        bench_cr2(&format!("{test_dir}\\ADH 1234.CR2"), &mut rows);
        bench_cr2(&format!("{test_dir}\\ADH 1248.CR2"), &mut rows);
        bench_cr2(&format!("{test_dir}\\ADH 1490.CR2"), &mut rows);
    }

    // Reference set parity runs (Gobabeb encode + P2200 decode/ROI).
    // Drive with env (matches JS harness style):
    //   GOB_SCAN_LIMIT=30 GOB_ROOT=...  cargo run --bin raw_decode_bench --release
    //   P2200_SCAN_LIMIT=11 P2200_ROOT=... (falls back to GOB_ROOT)
    let gob_limit: usize = std::env::var("GOB_SCAN_LIMIT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if gob_limit > 0 {
        run_gobabeb_encode_parity(&mut rows, gob_limit);
    }
    let p2200_limit: usize = std::env::var("P2200_SCAN_LIMIT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if p2200_limit > 0 {
        run_p2200_decode_roi_scan(&mut rows, p2200_limit);
    }

    println!("=== Done ===");
    println!("Tip: use --release + MSVC toolchain for representative numbers.");
    println!(
        "     `parallel` is REQUIRED for representative tone/demosaic numbers (multi-threaded):"
    );
    println!("     .\\build-msvc.ps1 run --bin raw_decode_bench --release --features \"jxl-codec,parallel\" 2>&1 | tee benchmark/results_latest.txt");
    println!("For Tauri/WASM parity ref sets (per HANDOFF-tauri-parity-2026-06-03.md):");
    println!("     $env:GOB_SCAN_LIMIT=30; $env:P2200_SCAN_LIMIT=11; .\\build-msvc.ps1 run --bin raw_decode_bench --release --features \"jxl-codec,parallel\"");

    if rows.is_empty() {
        eprintln!("[warn] no files processed; JSON not written");
        return;
    }

    let generated_at = approximate_iso8601_utc();
    let json = rows_to_json(&rows, &generated_at);
    let out_path = "benchmark/results_native.json";
    match std::fs::write(out_path, &json) {
        Ok(()) => println!("\nResults written to {out_path}"),
        Err(e) => eprintln!("\n[warn] could not write {out_path}: {e}"),
    }

    // Emit handoff parity summary (self-describing like crop benchmark MD tables).
    print_handoff_parity_summary(&rows, &generated_at);
}

fn print_handoff_parity_summary(rows: &[BenchRow], generated_at: &str) {
    if rows.is_empty() {
        return;
    }
    println!("\n=== Handoff Parity Summary (native vs WASM boundary metrics) ===");
    println!("generated: {generated_at}");
    println!("(Use with docs/boundary-cost-audit.md §12-13 and docs/suggested-settings.md Native section.)");
    println!();

    // Encode prep (direct rgba) aggregate for Gobabeb-style
    let direct_rgba_vals: Vec<f64> = rows.iter().filter_map(|r| r.direct_rgba_ms).collect();
    if !direct_rgba_vals.is_empty() {
        let n = direct_rgba_vals.len();
        let sum: f64 = direct_rgba_vals.iter().sum();
        let avg = sum / n as f64;
        let minv = direct_rgba_vals.iter().fold(f64::MAX, |a, &b| a.min(b));
        let maxv = direct_rgba_vals.iter().fold(f64::MIN, |a, &b| a.max(b));
        println!("direct_rgba (native encode prep, process_rgba path): n={n} avg={avg:.1}ms min={minv:.1} max={maxv:.1}");
        println!("  (Compare to WASM JS rgb_to_rgba ~65ms mean on Gobabeb 30-file; native should be faster + no 3ch retain.)");
    }

    // Decode handoff metrics aggregates
    let extract_vals: Vec<f64> = rows
        .iter()
        .filter_map(|r| r.decode_buffer_extract_ms)
        .collect();
    let region_ds_vals: Vec<f64> = rows
        .iter()
        .filter_map(|r| r.decode_region_downsample_ms)
        .collect();
    if !extract_vals.is_empty() || !region_ds_vals.is_empty() {
        println!("\nDecode Pixel Handoff (native; expect extract≈0, downsample≈JXL decode work for requested region):");
        if !extract_vals.is_empty() {
            let n = extract_vals.len();
            let avg = extract_vals.iter().sum::<f64>() / n as f64;
            println!("  decode_buffer_extract_ms: avg={avg:.2}ms over {n} (near-zero = win vs any WASM glue)");
        }
        if !region_ds_vals.is_empty() {
            let n = region_ds_vals.len();
            let avg = region_ds_vals.iter().sum::<f64>() / n as f64;
            println!("  decode_region_downsample_ms: avg={avg:.1}ms over {n} (the real decode cost; ROI paths will shrink this)");
        }
    }

    // Per-strategy note
    let strategies: std::collections::HashSet<_> = rows
        .iter()
        .filter_map(|r| r.decode_strategy.as_ref())
        .collect();
    if !strategies.is_empty() {
        println!("\nStrategies seen: {:?}", strategies);
    }
    println!("(ROI/progressive exercised via pre-crop sim + lowlevel-prog when P2200 scan active. See jxl_lowlevel.rs + handoff for Tauri wiring of real SetCrop/JXTC.)");

    // Small pre-cropped region results (from P2200 scan simulation of subject-rect fast path)
    if let Ok(crops) = SMALL_CROP_TIMES.lock() {
        if !crops.is_empty() {
            println!("\nSmall pre-cropped region JXL decodes (subject rect at encode time or JXTC-like tiles):");
            for sz in [128usize, 256] {
                let vals: Vec<f64> = crops
                    .iter()
                    .filter(|(_, s, _)| *s == sz)
                    .map(|(_, _, m)| *m)
                    .collect();
                if !vals.is_empty() {
                    let avg = vals.iter().sum::<f64>() / vals.len() as f64;
                    let minv = vals.iter().fold(f64::MAX, |a, &b| a.min(b));
                    println!("  {}px: avg={:.1}ms min={:.1} over {} samples (this is the 9-15ms class target for thumbs/subjects vs full ~600ms+)", sz, avg, minv, vals.len());
                }
            }
            println!("  (In real Tauri: pass normalized subject rect at decode time to select pre-produced small JXL or decode only overlapping tiles from a tiled/JXTC asset.)");
        }
    }

    // Low-level progressive first-pixel (stateful FRAME_PROGRESSION path)
    if let Ok(firsts) = LOWLEVEL_PROG_FIRSTS.lock() {
        if !firsts.is_empty() {
            let n = firsts.len();
            let avg = firsts.iter().sum::<f64>() / n as f64;
            let minv = firsts.iter().fold(f64::MAX, |a, &b| a.min(b));
            println!(
                "\nLow-level progressive (jpegxl-sys stateful, first FRAME_PROGRESSION+Flush):"
            );
            println!("  time_to_first_pixel_ms: avg={:.1}ms min={:.1} over {} samples (early paint target; vs full decode cost reported above)", avg, minv, n);
            println!("  (Wire equivalent in Tauri lightbox/gallery for DC/early passes direct to egui/wgpu; no worker hop. For small assets first often collapses to total.)");
        }
    }
}

fn approximate_iso8601_utc() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    let y400 = days / 146097;
    let rem = days % 146097;
    let y100 = (rem / 36524).min(3);
    let rem = rem - y100 * 36524;
    let y4 = rem / 1461;
    let rem = rem % 1461;
    let y1 = (rem / 365).min(3);
    let year = y400 * 400 + y100 * 100 + y4 * 4 + y1 + 1970;
    let day_of_year = rem - y1 * 365;
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let months: [u64; 12] = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u32;
    let mut dom = day_of_year;
    for mlen in &months {
        if dom < *mlen {
            break;
        }
        dom -= mlen;
        month += 1;
    }
    format!("{year:04}-{month:02}-{:02}T{h:02}:{m:02}:{s:02}Z", dom + 1)
}

// ─── Reference set scanning (Gobabeb 30-file encode parity + P2200 11-file decode/ROI) ───

fn env_or_default(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn scan_orf_dir(root: &str, limit: usize, name_filter: Option<&str>) -> Vec<String> {
    // Collect *all* matches, then sort, then truncate to `limit`. Selecting the
    // first N in filesystem readdir order (which varies run-to-run) and only
    // sorting afterwards yielded a non-reproducible file set; sort-then-truncate
    // makes the benchmark corpus deterministic (lens 27: benchmark integrity).
    let mut files = Vec::new();
    let filter_lc = name_filter.map(|f| f.to_lowercase()); // hoist out of the loop
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension()
                .map_or(false, |ext| ext.eq_ignore_ascii_case("orf"))
            {
                let name = p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if let Some(f) = &filter_lc {
                    if !name.to_lowercase().contains(f.as_str()) {
                        continue;
                    }
                }
                files.push(p.to_string_lossy().into_owned());
            }
        }
    } else {
        eprintln!("  [scan] root not readable: {root}");
    }
    files.sort();
    files.truncate(limit);
    files
}

fn run_gobabeb_encode_parity(rows: &mut Vec<BenchRow>, limit: usize) {
    let root = env_or_default("GOB_ROOT", r"C:\995\2026-02-20 Gobabeb To Windhoek");
    let files = scan_orf_dir(&root, limit, None);
    println!("\n=== Gobabeb encode parity scan (direct-rgba path) ===");
    println!("GOB_ROOT={root}  limit={limit}  found={}", files.len());
    for f in files {
        bench_orf(&f, rows);
    }
}

fn run_p2200_decode_roi_scan(rows: &mut Vec<BenchRow>, limit: usize) {
    // P2200 herbarium set for decode/ROI parity (11-file crop benchmark equivalent).
    // Uses same collection root by default; filter names containing P2200 for the crop set.
    let root = env_or_default(
        "P2200_ROOT",
        &env_or_default("GOB_ROOT", r"C:\995\2026-02-20 Gobabeb To Windhoek"),
    );
    let files = scan_orf_dir(&root, limit, Some("P2200"));
    println!("\n=== P2200 decode/ROI scan (full + region baseline) ===");
    println!("P2200_ROOT={root}  limit={limit}  found={}", files.len());
    for f in files {
        bench_orf(&f, rows); // full encode/decode roundtrip + direct rgba

        // ROI baseline simulation for P2200 set (per handoff "Decode (Region/ROI)"):
        // Re-process to rgba8, then for small subject-like crops produce a dedicated small JXL
        // (simulates "at encode time for _subjects sidecar, also emit small region JXL or JXTC tile").
        // Time only the small JXL decode — this is the fast path that can hit the 9-15ms class
        // for 128px thumbs/subjects instead of full ~500-800ms decode.
        if let Some((rgba, w, h)) = process_orf_to_rgba8(&f) {
            for &sz in &[128usize, 256] {
                let small = crop_rgba_center(&rgba, w, h, sz, sz);
                // Use simple high-level encode for small crops (no MT runner) to avoid ApiUsage issues seen with forced ThreadsRunner on some paths/sizes.
                // This mimics casabio_encode which reliably handles 4ch rgba for small and large.
                if let Some(jxl) = encode_small_rgba_jxl(&small, sz as u32, sz as u32) {
                    if let Some(dur) = bench_jxl_decode(&jxl) {
                        let ms = dur.as_secs_f64() * 1000.0;
                        println!("  small pre-crop {}px decode: {:.1}ms (dedicated small JXL from subject rect)", sz, ms);
                        if let Ok(mut v) = SMALL_CROP_TIMES.lock() {
                            v.push((
                                Path::new(&f)
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .into_owned(),
                                sz,
                                ms,
                            ));
                        }
                    }
                    // Real low-level stateful progressive decode (the continuation target for full loads + ROI assets).
                    // Exercises FRAME_PROGRESSION + FlushImage + SetProgressiveDetail. Emits first-pixel timing.
                    // Only available when bench built with --features jxl-lowlevel (shared impl in raw-pipeline).
                    #[cfg(feature = "jxl-codec")]
                    if let Some((first_ms, total_ms)) = bench_jxl_decode_lowlevel_progressive(&jxl)
                    {
                        println!(
                            "  lowlevel-prog (stateful) {}px: first={:.1}ms total={:.1}ms",
                            sz, first_ms, total_ms
                        );
                    }
                }
            }
            // Demo real low-level progressive for a "full load" using the file's rgba (proxy for produced JXL variant in Tauri ingest).
            // Gated: requires --features jxl-lowlevel at bench build time (pulls the shared jxl_lowlevel impl).
            #[cfg(feature = "jxl-codec")]
            if let Some(jxl_full) = encode_full_proxy_jxl(&rgba, w as u32, h as u32) {
                if let Some((first_ms, total_ms)) = bench_jxl_decode_lowlevel_progressive(&jxl_full)
                {
                    let prog_note = if cfg!(feature = "jxl-codec") {
                        ", progressive asset"
                    } else {
                        ""
                    };
                    println!(
                        "  lowlevel-prog full-load ({}x{}): first={:.1}ms total={:.1}ms (model for Tauri direct-to-texture{})",
                        w, h, first_ms, total_ms, prog_note
                    );
                    if let Ok(mut v) = LOWLEVEL_PROG_FIRSTS.lock() {
                        v.push(first_ms);
                    }
                }
                if let Some(d) = bench_jxl_decode_lowlevel_full(&jxl_full) {
                    println!("  lowlevel-full ({}x{}): {:.1}ms", w, h, ms(d));
                }
            }
        }
    }
}

// --- ROI helpers for native parity (surgical addition to deliver the 9-15ms small-crop class) ---

fn crop_rgba_center(src: &[u8], sw: usize, sh: usize, cw: usize, ch: usize) -> Vec<u8> {
    let ox = (sw.saturating_sub(cw)) / 2;
    let oy = (sh.saturating_sub(ch)) / 2;
    let mut dst = vec![0u8; cw * ch * 4];
    for y in 0..ch {
        let src_off = ((oy + y) * sw + ox) * 4;
        let dst_off = y * cw * 4;
        dst[dst_off..dst_off + cw * 4].copy_from_slice(&src[src_off..src_off + cw * 4]);
    }
    dst
}

fn process_orf_to_rgba8(path: &str) -> Option<(Vec<u8>, usize, usize)> {
    use raw_pipeline::{decompress, demosaic, pipeline, tiff};
    let data = std::fs::read(path).ok()?;
    let info = tiff::parse(&data).ok()?;
    let w = info.width as usize;
    let h = info.height as usize;
    let strip_end = info.strip_offset as usize + info.strip_byte_count as usize;
    if strip_end > data.len() {
        return None;
    }
    let strip = &data[info.strip_offset as usize..strip_end];
    let raw = decompress::decompress(strip, w, h).ok()?;
    let rgb16 = demosaic::demosaic_rggb(&raw, w, h).ok()?;
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
    let rgba = pipeline::process_rgba(&rgb16, &params);
    Some((rgba, w, h))
}

fn encode_small_rgba_jxl(rgba: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    use raw_pipeline::jxl_casaencoder::{encode_rgba8, EncodeOptions};
    encode_rgba8(
        rgba,
        width,
        height,
        EncodeOptions::quality(85.0).with_effort(3),
    )
    .ok()
}

/// Returns bytes for a full-size JXL to feed the low-level progressive decoder demo
/// ("full load" case in P2200 scan).
///
/// When the "jxl-encode" feature is active we use the real progressive variant
/// (progressive_dc=2, group_order=1) so that the measured `time_to_first_pixel_ms`
/// (via FRAME_PROGRESSION + FlushImage) is representative of what Tauri will see
/// for gallery/lightbox full progressive loads.
/// Falls back to the basic encoder otherwise (so `--features jxl-lowlevel` alone still works).
fn encode_full_proxy_jxl(rgba: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    #[cfg(feature = "jxl-codec")]
    {
        match encode_variants_with_progressive(rgba, w, h, SourceType::Raw, false, 2, 1) {
            Ok(variants) => return Some(variants.full),
            Err(e) => {
                eprintln!("  [warn] progressive encode for lowlevel full proxy failed ({e}); falling back to basic");
            }
        }
    }
    encode_small_rgba_jxl(rgba, w, h)
}

// Low-level decode impls moved to crates/raw-pipeline/src/jxl_lowlevel.rs (behind "jxl-lowlevel" feature).
// The bench conditionally re-exports the old `bench_jxl_decode_lowlevel_*` names from there
// (see top of file) so that call sites in run_p2200_decode_roi_scan continue to work when the
// feature is enabled. The shared module is the single source the Tauri side can depend on.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_to_json_escapes_strings() {
        let rows = vec![BenchRow {
            file: "quote\"slash\\line\n.orf".to_string(),
            format: "ORF",
            width: 1,
            height: 1,
            size_mb: 1.0,
            decompress_ms: 2.0,
            demosaic_ms: 3.0,
            tonemap_ms: 4.0,
            total_ms: 5.0,
            encode_ms: None,
            jxl_size_kb: None,
            decode_ms: None,
            direct_rgba_ms: None,
            decode_buffer_extract_ms: None,
            decode_region_downsample_ms: None,
            source_pixels_decoded: None,
            decode_strategy: Some("full\"strategy".to_string()),
        }];

        let json = rows_to_json(&rows, "2026-06-19T00:00:00Z");

        assert!(json.contains("\"file\": \"quote\\\"slash/line\\n.orf\""));
        assert!(json.contains("\"decodeStrategy\": \"full\\\"strategy\""));
    }

    #[test]
    fn median_dur_handles_even_odd_and_empty_inputs() {
        let mut empty = Vec::new();
        assert_eq!(median_dur(&mut empty), Duration::ZERO);

        let mut odd = vec![
            Duration::from_millis(9),
            Duration::from_millis(1),
            Duration::from_millis(5),
        ];
        assert_eq!(median_dur(&mut odd), Duration::from_millis(5));

        let mut even = vec![
            Duration::from_millis(10),
            Duration::from_millis(2),
            Duration::from_millis(6),
            Duration::from_millis(4),
        ];
        assert_eq!(median_dur(&mut even), Duration::from_millis(5));
    }
}
