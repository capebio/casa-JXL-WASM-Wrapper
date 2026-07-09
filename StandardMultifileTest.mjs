
import { execSync, spawn } from 'child_process';
import os from 'os';
import { collectHardwareTelemetry, formatTelemetryReport, toToonMetrics } from './benchmark/hardware-telemetry.mjs';

function runSystemTelemetry() {
  console.log('\n=========================================');
  console.log('💻 SYSTEM TELEMETRY & HARDWARE SENTINEL');
  console.log('=========================================');

  const telemetry = collectHardwareTelemetry();
  console.log(formatTelemetryReport(telemetry));

  console.log('=========================================\n');
  return telemetry;
}



import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Worker as NodeWorker } from "node:worker_threads";
import { buildGraphAggregateHtml, buildGraphHistory } from "./benchmark/standard-multifile-history-graph.mjs";
import { consolidateBenchmarkHistory } from "./benchmark/benchmark-history-conversion.mjs";
import { assessSeamComparison } from "./benchmark/seam-comparison-threshold.mjs";
import { buildGraphBrowserLaunchPlan, chooseGraphBrowser, getNextGraphBrowserLaunchMethod } from "./benchmark/graph-browser-launcher.mjs";

// 1. Browser-like Worker Shim for Node.js thread context
class BrowserLikeWorker {
  #worker;
  #onmessage = null;
  #onerror = null;

  constructor(url, options = {}) {
    const workerUrl = url instanceof URL ? url.href : String(url);
    this.#worker = new NodeWorker(new URL("./jxl-worker-shim.mjs", import.meta.url), {
      workerData: { url: workerUrl, name: options.name ?? "" },
    });
    this.#worker.on("message", (data) => this.#onmessage?.({ data }));
    this.#worker.on("error", (error) => this.#onerror?.(error));
  }

  postMessage(message, transfer) { this.#worker.postMessage(message, transfer); }
  terminate() { return this.#worker.terminate(); }
  set onmessage(handler) { this.#onmessage = handler; }
  get onmessage() { return this.#onmessage; }
  set onerror(handler) { this.#onerror = handler; }
  get onerror() { return this.#onerror; }
}

globalThis.Worker = BrowserLikeWorker;

// 2. Initialize WASM Raw Converter
import initRaw, {
  downscale_rgb,
  process_orf_with_flags,
  process_cr2_with_flags,
  process_dng_with_flags,
  rgb_to_rgba,
  decode_jpeg,
} from "./pkg/raw_converter_wasm.js";

const {
  createDecoder,
  createEncoder,
  encodeRgba8Pyramid,
  encodeTileContainerRgba8,
  decodeTileContainerRegionRgba8,
  setForcedTier,
  encodeRgb16Planar
} = await import("./packages/jxl-wasm/dist/index.js");

// Lossless archival JPEG->JXL transcode lives in the facade (not re-exported by index).
const { transcodeJpegToJxl, extractJpegReconstructionFromJxl } = await import("./packages/jxl-wasm/dist/facade.js");

await initRaw({ module_or_path: readFileSync(new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });

// Direct low-level planar16 encode shim.
// Uses the just-built core (jxl-core.simd) so the _jxl_wasm_encode_rgb16_planar
// symbol from our bridge addition is exercised even if the high-level facade
// wrapper in dist/index is stale. This puts the zero-copy entry point "in place"
// for the benchmark measurement (split planes -> ensure + call + take buffer).
let _directPlanar = null;
async function getDirectPlanar16() {
  if (_directPlanar) return _directPlanar;
  const wasmPath = new URL("./packages/jxl-wasm/dist/jxl-core.simd.wasm", import.meta.url);
  const wasmBinary = readFileSync(wasmPath);
  const core = await import("./packages/jxl-wasm/dist/jxl-core.simd.js");
  const factory = core.default || core;
  const mod = await (typeof factory === "function" ? factory({ wasmBinary }) : factory);
  const fn = mod && mod._jxl_wasm_encode_rgb16_planar;
  if (typeof fn !== "function") return null;
  const ensureU16 = (m, arr) => {
    const nbytes = arr.byteLength;
    const p = m._malloc(nbytes);
    if (!p) throw new Error("u16 malloc failed for planar");
    new Uint8Array(m.HEAPU8.buffer, p, nbytes).set(new Uint8Array(arr.buffer, arr.byteOffset || 0, nbytes));
    return p;
  };
  const take = (m, h) => {
    const dp = m._jxl_wasm_buffer_data(h);
    const sz = m._jxl_wasm_buffer_size(h);
    const out = new Uint8Array(sz);
    out.set(new Uint8Array(m.HEAPU8.buffer, dp, sz));
    m._jxl_wasm_buffer_free(h);
    return out;
  };
  _directPlanar = async (r, g, b, w, h, distance=1, effort=3, ...rest) => {
    const m = mod;
    const rp = (typeof r === "number") ? r : ensureU16(m, r);
    const gp = (typeof g === "number") ? g : ensureU16(m, g);
    const bp = (typeof b === "number") ? b : ensureU16(m, b);
    const hdl = m._jxl_wasm_encode_rgb16_planar(rp, gp, bp, w, h, distance, effort, ...rest);
    if (typeof r !== "number") m._free(rp);
    if (typeof g !== "number") m._free(gp);
    if (typeof b !== "number") m._free(bp);
    return take(m, hdl);
  };
  return _directPlanar;
}



// 3. Resolve Standard Test Files (2 of each format: ORF, CR2, DNG, JPG)
const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const GOB_ROOT = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const TIMING_SOURCE = String.raw`.timing-source`;

const FILES_CONFIG = [
  // --- JPG formats ---
  { name: "small_file.jpg", paths: [join(TEST_ROOT, "small_file.jpg")] },
  { name: "P1110226 windows.jpg", paths: [join(TEST_ROOT, "P1110226 windows.jpg")] },
  // --- DNG formats ---
  {
    name: "PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
    paths: [
      join(TEST_ROOT, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng"),
      join(TIMING_SOURCE, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng"),
      String.raw`C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng`
    ]
  },
  { name: "PXL_20260501_093507165.RAW-02.ORIGINAL.dng", paths: [
      join(TEST_ROOT, "PXL_20260501_093507165.RAW-02.ORIGINAL.dng"),
      String.raw`C:\Foo\raw-converter-wasm\.timing-source\PXL_20260501_093507165.RAW-02.ORIGINAL.dng`
    ] },
  // --- ORF formats ---
  { name: "P1110226.ORF", paths: [join(TEST_ROOT, "P1110226.ORF")] },
  { name: "P2200474.ORF", paths: [join(GOB_ROOT, "P2200474.ORF")] },
  // --- CR2 formats ---
  { name: "_MG_1750.CR2", paths: [join(TEST_ROOT, "_MG_1750.CR2")] },
  { name: "ADH 1248.CR2", paths: [join(TEST_ROOT, "ADH 1248.CR2")] }
];

const TARGET = 1920;
const OUTPUT_FULL_RGB = 1 | 2 | 4; // full + lightbox + thumb: populate preview packed 6B/px + always-on preview_demosaic_ms / downscale_ms / fast_preview (precompute was already free; return of small buffers negligible)
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

// 4. Helper to ensure correct Buffer extraction
function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function concatChunks(chunks) {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

// Flip-flop style median (matches tools/demosaic-flipflop.mjs and Rust tonemap_flip_flops / flipflop_ab)
function median(arr) {
  if (!arr || !arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

// 5. JXL Encoding Helper (Progressive or One-shot)
async function encodeJxl(rgba, width, height, isProgressive) {
  const encoder = createEncoder({
    format: "rgba8", width, height, hasAlpha: true,
    iccProfile: null, exif: null, xmp: null,
    distance: 1.0, quality: 85, effort: 3,
    progressive: isProgressive, progressiveFlavor: "ac", previewFirst: false,
    chunked: true,
  });
  const chunks = [];
  let chunkError = null;
  const chunkTask = (async () => {
    try {
      for await (const chunk of encoder.chunks()) {
        chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      }
    } catch (e) {
      chunkError = e;
    }
  })();
  const t0 = performance.now();
  try {
    await encoder.pushPixels(exactBuffer(rgba));
    await encoder.finish();
  } catch (e) {
    console.error(`❌ Encoder error during push/finish (${width}x${height}):`, e.message);
    throw e;
  }
  await chunkTask;
  if (chunkError) {
    console.error(`❌ Chunk collection error (${width}x${height}):`, chunkError.message);
    throw chunkError;
  }
  await encoder.dispose();
  const ms = performance.now() - t0;
  const result = concatChunks(chunks);

  // Validate: sanity check output size
  const minExpectedSize = Math.max(100, width * height / 100); // very loose lower bound
  if (result.byteLength < minExpectedSize) {
    const chunkInfo = chunks.map(c => c.byteLength).join('+');
    console.warn(`⚠️  Encoder output suspiciously small: ${result.byteLength}B for ${width}x${height} (${chunkInfo}). Expected >${minExpectedSize}B. Progressive=${isProgressive}`);
  }

  return { bytes: result, ms };
}

async function encodeJxlVariant(rgba, width, height, extra = {}) {
  const encoder = createEncoder({
    format: "rgba8", width, height, hasAlpha: true,
    iccProfile: null, exif: null, xmp: null,
    distance: 1.0, quality: 85, effort: 3,
    progressive: false, progressiveFlavor: "ac", previewFirst: false,
    chunked: true,
    ...extra,
  });
  const chunks = [];
  const chunkTask = (async () => {
    for await (const chunk of encoder.chunks()) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
  })();
  const t0 = performance.now();
  await encoder.pushPixels(exactBuffer(rgba));
  await encoder.finish();
  await chunkTask;
  await encoder.dispose();
  const ms = performance.now() - t0;
  return { bytes: concatChunks(chunks), ms };
}

// 6. JXL Decoding Helper with optional ROI region
async function decodeJxl(jxlBytes, isProgressive, options = {}) {
  const metrics = {};
  const decoder = createDecoder({
    format: "rgba8",
    progressionTarget: options.progressionTarget ?? "final",
    emitEveryPass: options.emitEveryPass ?? isProgressive,
    progressiveDetail: options.progressiveDetail ?? (isProgressive ? "passes" : "none"),
    downsample: options.downsample ?? 1,
    preserveIcc: false, preserveMetadata: false,
    region: options.region ?? null,
    onMetric: (name, value) => { metrics[name] = value; },
  });

  let passCount = 0;
  let firstFrameMs = null;
  let decodedPixels = null;
  const t0 = performance.now();
  try {
    const evTask = (async () => {
      for await (const ev of decoder.events()) {
        if (ev.type === "progress" || ev.type === "final") {
          passCount++;
          if (ev.pixels) decodedPixels = ev.pixels;
          if (firstFrameMs === null) firstFrameMs = performance.now() - t0;
        }
        else if (ev.type === "error") throw new Error(`${ev.code}: ${ev.message}`);
      }
    })();
    await decoder.push(exactBuffer(jxlBytes));
    await decoder.close();
    await evTask;


  } finally {
    try { await decoder.dispose(); } catch (_) {}
  }
  const ms = performance.now() - t0;
  return { ms, firstFrameMs: firstFrameMs ?? ms, passCount, pixels: decodedPixels, metrics };
}

// Streaming chunked-input progressive decode simulation (covers test_1 / progressive-timing-benchmark chunked steps)
async function timedChunkedInputDecode(jxlBytes, steps, isProgressive, options = {}) {
  const decoder = createDecoder({
    format: "rgba8",
    progressionTarget: options.progressionTarget ?? "final",
    emitEveryPass: options.emitEveryPass ?? isProgressive,
    progressiveDetail: options.progressiveDetail ?? (isProgressive ? "passes" : "none"),
    downsample: options.downsample ?? 1,
    preserveIcc: false, preserveMetadata: false,
    region: options.region ?? null,
  });
  let firstFrameMs = null;
  let passCount = 0;
  const t0 = performance.now();
  try {
    const evTask = (async () => {
      for await (const ev of decoder.events()) {
        if (ev.type === "progress" || ev.type === "final") {
          passCount++;
          if (firstFrameMs === null) firstFrameMs = performance.now() - t0;
        } else if (ev.type === "error") {
          // ignore truncation for partial pushes in sim
        }
      }
    })();
    const src = (jxlBytes instanceof Uint8Array) ? jxlBytes : new Uint8Array(jxlBytes);
    const chunkSize = Math.ceil(src.byteLength / steps);
    for (let i = 0; i < steps; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, src.byteLength);
      if (end > start) await decoder.push(exactBuffer(src.subarray(start, end)));
    }
    await decoder.close();
    await evTask;
  } finally {
    try { await decoder.dispose(); } catch (_) {}
  }
  const ms = performance.now() - t0;
  return { ms, firstFrameMs: firstFrameMs ?? ms, passCount };
}

// 7. Benchmark Suite Entrypoint
async function main() {
  globalThis.systemTelemetry = runSystemTelemetry();
  let finalEncMetrics = {};
  const batchName = process.argv[2] || process.env.SPEEDTEST_BATCH || "general";
  const runTimestamp = new Date().toISOString();
  
  console.log(`=========================================`);
  console.log(`🚀 RUNNING STANDARDIZED SPEEDTEST WITH DEEP DIAGNOSTICS`);
  console.log(`   Batch Name: ${batchName}`);
  console.log(`   Timestamp:  ${runTimestamp}`);
  console.log(`=========================================\n`);

  const loadedFiles = [];

  // --- 7.1 Pre-load and scale all assets (RAW & JPG decoding) ---
  console.log(`--- [1/6] Pre-loading & Scaling Assets ---`);
  for (const config of FILES_CONFIG) {
    let resolvedPath = null;
    for (const path of config.paths) {
      if (existsSync(path)) { resolvedPath = path; break; }
    }
    if (!resolvedPath) {
      console.warn(`⚠️  Skipping missing benchmark file: ${config.name}`);
      continue;
    }

    const ext = extname(resolvedPath).toLowerCase();
    const raw = new Uint8Array(readFileSync(resolvedPath));
    const heapBefore = process.memoryUsage().heapUsed;
    const tRawStart = performance.now();
    let rgb, srcW, srcH;
    let jpegTranscodeMs = null, jpegArchivalRatio = null, jpegReversible = null;
    let rawDecompress = 0, rawDemosaic = 0, rawTonemap = 0, rawOrient = 0;
    let previewDem = 0, previewDown = 0, fastPrev = false;
    let lbPack = null, lbWw = 0, lbHh = 0, thPack = null, thWw = 0, thHh = 0;

    if (ext === ".jpg" || ext === ".jpeg" || ext === ".jfif") {
      // DEVELOPED/LOSSY pathway: decode via the SAME wasm decoder the app uses
      // (decode_jpeg), dropping the sharp Node-native dependency on the JPEG path.
      const dec = decode_jpeg(raw);
      const rgba = dec.take_rgba8();          // RGBA8
      srcW = dec.width; srcH = dec.height; dec.free();
      rgb = new Uint8Array(srcW * srcH * 3);  // RGBA8 -> RGB8 (harness expects rgb)
      for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
        rgb[o] = rgba[i]; rgb[o + 1] = rgba[i + 1]; rgb[o + 2] = rgba[i + 2];
      }
      // LOSSLESS/ARCHIVAL pathway: measure the JPEG->JXL transcode + size ratio.
      // In-app bit-exact reconstruction (extract) is JXTC-only today, so it
      // returns null for the standard-JXL transcode; the JXL is still losslessly
      // reconstructable via `djxl --jpeg` (see docs plan C1 Step 3a).
      const tT0 = performance.now();
      const archivalJxl = await transcodeJpegToJxl(raw);
      jpegTranscodeMs = performance.now() - tT0;
      jpegArchivalRatio = archivalJxl.byteLength / raw.byteLength;
      const recovered = extractJpegReconstructionFromJxl(archivalJxl);
      jpegReversible = recovered ? (Buffer.compare(Buffer.from(recovered), Buffer.from(raw)) === 0) : null;
      console.log(`  JPEG archival: transcode=${Math.round(jpegTranscodeMs)}ms ratio=${jpegArchivalRatio.toFixed(3)} reconstruct=${jpegReversible === null ? 'via djxl (in-app bridge pending)' : jpegReversible}`);
    } else {
      let decoded;
      // Use preview bits only for ORF (fast planar + packed implemented there).
      // CR2/DNG use plain full to avoid binding surprises with extra bits in those paths.
      const usePreview = (ext === ".orf" || ext === ".raw");
      const fl = usePreview ? OUTPUT_FULL_RGB : 1;
      if (ext === ".orf" || ext === ".raw") decoded = process_orf_with_flags(raw, fl, ...PROCESS_ARGS);
      else if (ext === ".cr2") decoded = process_cr2_with_flags(raw, fl, ...PROCESS_ARGS);
      else if (ext === ".dng") decoded = process_dng_with_flags(raw, fl, ...PROCESS_ARGS);
      rawDecompress = decoded.decompress_ms ?? 0;
      rawDemosaic = decoded.demosaic_ms ?? 0;
      rawTonemap = decoded.tonemap_ms ?? 0;
      rawOrient = decoded.orient_ms ?? 0;
      previewDem = decoded.preview_demosaic_ms ?? 0;
      previewDown = decoded.preview_downscale_ms ?? 0;
      fastPrev = !!decoded.fast_preview;
      // Packed 6B/px (per-pixel rgb16 LE) from fast planar path (when flags include lightbox/thumb bits).
      // Small for lb/thumb; enables zero-copy planar16 encode demo via the new hook without full-res materialization.
      lbPack = decoded.rgb16_lb || null;
      lbWw = decoded.lb_w || 0;
      lbHh = decoded.lb_h || 0;
      thPack = decoded.rgb16_thumb || null;
      thWw = decoded.thumb_w || 0;
      thHh = decoded.thumb_h || 0;
      rgb = decoded.take_rgb(); srcW = decoded.width; srcH = decoded.height; decoded.free();
    }
    const rawMs = performance.now() - tRawStart;
    const rawHeapDeltaMb = ((process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024)).toFixed(1);

    const tScaleStart = performance.now();
    const longEdge = Math.max(srcW, srcH);
    const scale = longEdge > TARGET ? TARGET / longEdge : 1;
    const tgtW = Math.round(srcW * scale);
    const tgtH = Math.round(srcH * scale);
    const rgba = scale < 1 ? rgb_to_rgba(downscale_rgb(rgb, srcW, srcH, tgtW, tgtH)) : rgb_to_rgba(rgb);
    const scaleMs = performance.now() - tScaleStart;

    console.log(`  Loaded ${basename(resolvedPath)}: decode=${Math.round(rawMs)}ms scale=${Math.round(scaleMs)}ms (${tgtW}x${tgtH}) heap_delta=${rawHeapDeltaMb}MB preview_demosaic=${Math.round(previewDem)} down=${Math.round(previewDown)} fast=${fastPrev}`);
    loadedFiles.push({ file: basename(resolvedPath), rgba, tgtW, tgtH, rawMs, scaleMs, rawDecompress, rawDemosaic, rawTonemap, rawOrient, previewDem, previewDown, fastPrev, lbPack, lbW: lbWw, lbH: lbHh, thPack, thW: thWw, thH: thHh, jpegTranscodeMs, jpegArchivalRatio, jpegReversible });
  }
  console.log("");

  // === Tier Flip-Flop Core (A/B alternating, repo-standard flip-flop style) ===
  // Alternates blocks of all files under simd then relaxed-simd-mt (multiple rounds).
  // Produces medians for exactly the 4 headline numbers from the original complaint
  // (prog_enc, first_paint, final_paint, shot_dec). Lightweight: no variants, no pyr,
  // no ds2/region/chunked/mod/photon, no extra shot_enc in reporting.
  // Purpose: stable apples-to-apples simd vs mt comparison (controls warm-up, freq,
  // cache state between tiers) + direct match to the "printed ~500ms vs counted 4s" gap.
  // The body= in the rich [2/6]/[3/6] lines (below) will now also show full per-file wall.
  const FLIP_ROUNDS = 10;
  console.log(`--- Tier Flip-Flop Core (simd <-> relaxed-simd-mt, ${FLIP_ROUNDS} rounds for medians) ---`);
  const flipSamples = Object.create(null);
  for (const f of loadedFiles) {
    flipSamples[f.file] = {
      simd: { prog_enc: [], first: [], final: [], shot_dec: [] },
      mt:   { prog_enc: [], first: [], final: [], shot_dec: [] },
    };
  }

  for (let r = 0; r < FLIP_ROUNDS; r++) {
    // simd block (one module load for the tier, then all files reuse)
    setForcedTier("simd");
    for (const f of loadedFiles) {
      const progEnc = await encodeJxl(f.rgba, f.tgtW, f.tgtH, true);
      let progDec = { firstFrameMs: 0, ms: 0 };
      try {
        progDec = await decodeJxl(progEnc.bytes, true);
      } catch (e) {
        console.warn(`⚠️  Decode failed for ${f.file} (prog): ${e.message}`);
      }
      const shotEnc = await encodeJxl(f.rgba, f.tgtW, f.tgtH, false);
      let shotDec = { ms: 0 };
      try {
        shotDec = await decodeJxl(shotEnc.bytes, false);
      } catch (e) {
        console.warn(`⚠️  Decode failed for ${f.file} (shot): ${e.message}`);
      }
      const s = flipSamples[f.file].simd;
      s.prog_enc.push(progEnc.ms);
      s.first.push(progDec.firstFrameMs);
      s.final.push(progDec.ms);
      s.shot_dec.push(shotDec.ms);
    }

    // mt block (flip)
    setForcedTier("relaxed-simd-mt");
    for (const f of loadedFiles) {
      const progEnc = await encodeJxl(f.rgba, f.tgtW, f.tgtH, true);
      let progDec = { firstFrameMs: 0, ms: 0 };
      try {
        progDec = await decodeJxl(progEnc.bytes, true);
      } catch (e) {
        console.warn(`⚠️  Decode failed for ${f.file} (prog): ${e.message}`);
      }
      const shotEnc = await encodeJxl(f.rgba, f.tgtW, f.tgtH, false);
      let shotDec = { ms: 0 };
      try {
        shotDec = await decodeJxl(shotEnc.bytes, false);
      } catch (e) {
        console.warn(`⚠️  Decode failed for ${f.file} (shot): ${e.message}`);
      }
      const m = flipSamples[f.file].mt;
      m.prog_enc.push(progEnc.ms);
      m.first.push(progDec.firstFrameMs);
      m.final.push(progDec.ms);
      m.shot_dec.push(shotDec.ms);
    }
  }

  // Compute medians + print (flip-flop output, stable numbers for the quoted metrics)
  const flipFlopResults = [];
  for (const f of loadedFiles) {
    const s = flipSamples[f.file].simd;
    const m = flipSamples[f.file].mt;
    const sm = {
      prog: median(s.prog_enc),
      first: median(s.first),
      final: median(s.final),
      shot: median(s.shot_dec),
    };
    const mm = {
      prog: median(m.prog_enc),
      first: median(m.first),
      final: median(m.final),
      shot: median(m.shot_dec),
    };
    const spdProg = sm.prog / Math.max(1, mm.prog);
    const spdFirst = sm.first / Math.max(1, mm.first);
    const spdFinal = sm.final / Math.max(1, mm.final);
    const spdShot = sm.shot / Math.max(1, mm.shot);
    console.log(
      `  ➔ ${f.file} [flip]: ` +
      `prog_enc simd=${sm.prog.toFixed(0)}/mt=${mm.prog.toFixed(0)} (${spdProg.toFixed(2)}x) ` +
      `first=${sm.first.toFixed(0)}/${mm.first.toFixed(0)} (${spdFirst.toFixed(2)}x) ` +
      `final=${sm.final.toFixed(0)}/${mm.final.toFixed(0)} (${spdFinal.toFixed(2)}x) ` +
      `shot_dec=${sm.shot.toFixed(0)}/${mm.shot.toFixed(0)} (${spdShot.toFixed(2)}x)`
    );
    flipFlopResults.push({
      file: f.file,
      simd_prog: Math.round(sm.prog), mt_prog: Math.round(mm.prog), spd_prog: parseFloat(spdProg.toFixed(2)),
      simd_first: Math.round(sm.first), mt_first: Math.round(mm.first), spd_first: parseFloat(spdFirst.toFixed(2)),
      simd_final: Math.round(sm.final), mt_final: Math.round(mm.final), spd_final: parseFloat(spdFinal.toFixed(2)),
      simd_shot: Math.round(sm.shot), mt_shot: Math.round(mm.shot), spd_shot: parseFloat(spdShot.toFixed(2)),
    });
  }
  console.log("  (flip-flop medians from interleaved rounds; reload cost on tier switch included fairly)\n");

  // Helper to run sequential benchmark loop on a specific JXL tier
  async function runSequentialSuite(tierName) {
    console.log(`--- Run sequential JXL benchmarks on tier [${tierName}] ---`);
    setForcedTier(tierName);
    const results = [];

    for (const f of loadedFiles) {
      const tBodyStart = performance.now();

      // Progressive JXL Benchmarks
      const progEnc = await encodeJxl(f.rgba, f.tgtW, f.tgtH, true);
      let progDec = { firstFrameMs: 0, ms: 0, passCount: 0, pixels: null, metrics: {} };
      try {
        progDec = await decodeJxl(progEnc.bytes, true);
      } catch (e) {
        console.warn(`⚠️  Decode failed for ${f.file} (prog in sequential): ${e.message}`);
      }

      // One-shot JXL Benchmarks
      const shotEnc = await encodeJxl(f.rgba, f.tgtW, f.tgtH, false);
      let shotDec = { ms: 0, firstFrameMs: 0, passCount: 0 };
      try {
        shotDec = await decodeJxl(shotEnc.bytes, false);
      } catch (e) {
        console.warn(`⚠️  Decode failed for ${f.file} (shot in sequential): ${e.message}`);
      }

      // JXTC Tile-Container Encode Benchmark (mirrors pyramid-ingest ladder.ts jxtcEncodeMs/jxtcKb per level)
      // Measures: single-level JXTC encode of the target-size rgba at effort=3/distance=1.0 (same params as ingest).
      // Compare jxtc_enc_ms vs shot_enc_ms to quantify JXTC container overhead vs plain one-shot JXL.
      let jxtcEncMs = 0;
      let jxtcKb = 0;
      if (typeof encodeTileContainerRgba8 === "function") {
        try {
          const tJxtc = performance.now();
          const jxtcOut = await encodeTileContainerRgba8(exactBuffer(f.rgba), f.tgtW, f.tgtH, {
            tileSize: 256,
            distance: 1.0,
            effort: 3,
            hasAlpha: false,
          });
          jxtcEncMs = performance.now() - tJxtc;
          jxtcKb = jxtcOut.byteLength / 1024;
        } catch (e) {
          console.warn(`⚠️  JXTC encode failed for ${f.file}: ${e.message}`);
        }
      }

      // Pyramid JXL Benchmarks
      let pyrEncMs = 0;
      let pyrDecTotMs = 0;
      let pyrLevelsCount = 0;
      if (typeof encodeRgba8Pyramid === "function") {
        const tPyrEnc = performance.now();
        const levels = await encodeRgba8Pyramid(f.rgba, f.tgtW, f.tgtH, {
          fullDistance: 1.0,
          sidecarSizes: [256, 512, 1024, 2048],
          sidecarDistances: [1.45, 1.45, 1.45, 1.45],
          effort: 3,
          hasAlpha: false,
        });
        pyrEncMs = performance.now() - tPyrEnc;
        pyrLevelsCount = levels.length;

        for (const lvl of levels) {
          const tDecStart = performance.now();
          try {
            await decodeJxl(lvl.data, false);
            pyrDecTotMs += performance.now() - tDecStart;
          } catch (_) {
            // pyramid level decode failed, skip timing
          }
        }
      }

      // --- Additional timings pulled from benchmark/*.mjs (test_1, progressive-timing-benchmark, timing-tests, targeted, test_1x sweeps) ---
      // Rich decode variants (ds2, region crops) for prog vs oneshot
      const regionEx = { x: Math.floor(f.tgtW * 0.25), y: Math.floor(f.tgtH * 0.25), w: Math.floor(f.tgtW * 0.5), h: Math.floor(f.tgtH * 0.5) };
      let progDs2 = { ms: 0, firstFrameMs: 0, passCount: 0 };
      let progRegion = { ms: 0, firstFrameMs: 0, passCount: 0 };
      let shotDs2 = { ms: 0, firstFrameMs: 0, passCount: 0 };
      let shotRegion = { ms: 0, firstFrameMs: 0, passCount: 0 };
      let progChunked = { ms: 0, firstFrameMs: 0, passCount: 0 };
      try { progDs2 = await decodeJxl(progEnc.bytes, true, { downsample: 2 }); } catch (_) {}
      try { progRegion = await decodeJxl(progEnc.bytes, true, { region: regionEx }); } catch (_) {}
      try { shotDs2 = await decodeJxl(shotEnc.bytes, false, { downsample: 2 }); } catch (_) {}
      try { shotRegion = await decodeJxl(shotEnc.bytes, false, { region: regionEx }); } catch (_) {}
      // Chunked-input streaming sim for progressive (4 steps)
      try { progChunked = await timedChunkedInputDecode(progEnc.bytes, 4, true); } catch (_) {}
      // Encode variants for modular / other options coverage (timing-tests, test_14, test_17 etc)
      let modProgEncMs = 0, modProgSize = 0;
      let photonEncMs = 0, photonSize = 0;
      try {
        // opaque source: rgb8 drops the constant alpha plane's Modular Squeeze pass.
        // In Modular mode with progressive:true, RESPONSIVE=1 is forced (bridge.cpp:561),
        // so EVERY plane — including a constant 0xFF alpha — gets a full multi-resolution
        // Squeeze lifting + residual-subband entropy pass (~1/4 of per-plane cost, pure
        // waste on a flat channel). Dropping alpha also trims the MA-tree property set
        // (enc_modular.cc:595 max_properties = num_extra_channels+2: 3->2). Pack stride-4
        // RGBA -> stride-3 RGB and encode hasAlpha:false / format:"rgb8" (num_extra_channels=0);
        // the 3 colour planes stay bit-identical (alpha constant) so the image is unchanged.
        // Verified: flipflop modular-rgb8-noalpha ~21.9% faster, Butteraugli Δ=0.0.
        const _np = f.tgtW * f.tgtH;
        const _rgb = new Uint8Array(_np * 3);
        const _src = f.rgba || new Uint8Array();
        const _ch = (_src.length / _np) | 0 || 4;
        for (let i = 0, s = 0, d = 0; i < _np; i++, s += _ch, d += 3) {
          _rgb[d] = _src[s]; _rgb[d + 1] = _src[s + 1]; _rgb[d + 2] = _src[s + 2];
        }
        const modP = await encodeJxlVariant(_rgb, f.tgtW, f.tgtH, { progressive: true, modular: 1, format: "rgb8", hasAlpha: false });
        modProgEncMs = modP.ms; modProgSize = modP.bytes.byteLength;
      } catch (_) {}
      try {
        // opaque source: rgb8 drops alpha-plane VarDCT pass.
        // Source JPEG/RAW pixels carry a constant 0xFF alpha; encoding it through the
        // full VarDCT entropy pipeline is pure waste. Pack stride-4 RGBA -> stride-3 RGB
        // and encode hasAlpha:false / format:"rgb8" (bridge fmt=3, num_extra_channels=0):
        // drops the alpha encode AND shrinks the JS->WASM heap copy 4->3.
        const _np = f.tgtW * f.tgtH;
        const _rgb = new Uint8Array(_np * 3);
        const _src = f.rgba || new Uint8Array();
        const _ch = (_src.length / _np) | 0 || 4;
        for (let i = 0, s = 0, d = 0; i < _np; i++, s += _ch, d += 3) {
          _rgb[d] = _src[s]; _rgb[d + 1] = _src[s + 1]; _rgb[d + 2] = _src[s + 2];
        }
        // qProgressiveAc:0 collapses the redundant second (quantized) AC progressive pass.
        // With progressiveFlavor:'ac' (line 231 default) the baseline emits progressiveDc=1,
        // progressiveAc=1, qProgressiveAc=1; the extra qProgressiveAc pass re-runs histogram
        // clustering + context-tree build over the photon-grain AC coefficients for ~0 perceptual
        // gain (Butteraugli Δ=0.0, flipflop-verified). Honored via resolveEncoderBridgeSettings
        // (facade.ts:585, `qProgressiveAc != null`); progressiveDc/progressiveAc stay 1 so
        // DC-preview progressivity + RESPONSIVE (bridge.cpp:561) are preserved.
        const pho = await encodeJxlVariant(_rgb, f.tgtW, f.tgtH, { progressive: true, photonNoiseIso: 800, format: "rgb8", hasAlpha: false, qProgressiveAc: 0 });
        photonEncMs = pho.ms; photonSize = pho.bytes.byteLength;
      } catch (_) {}

      // Zero/low-copy planar16 encode path measurement (the hook).
      // Split the target rgba to 3 u16 planes (promote), feed via encodeRgb16Planar
      // (JS does 3 smaller ensureU16Heap, bridge does fast interleave + EncodeRgba).
      // Compare to the normal rgba8 path to quantify the input marshal/boundary
      // cost difference for this pipeline. "with" = using the planar entry point.
      let planar16ShotMs = 0;
      const doPlanar = (typeof encodeRgb16Planar === 'function') ? encodeRgb16Planar : await getDirectPlanar16();
      if (doPlanar) {
        try {
          const npix = f.tgtW * f.tgtH;
          const pr = new Uint16Array(npix), pg = new Uint16Array(npix), pb = new Uint16Array(npix);
          const src = f.rgba || new Uint8Array();
          const ch = (src.length / npix) | 0 || 4;
          for (let i = 0, o = 0; i < npix; i++, o += ch) {
            const rv = src[o] || 0, gv = src[o + 1] || 0, bv = src[o + 2] || 0;
            pr[i] = rv * 257; pg[i] = gv * 257; pb[i] = bv * 257;  // 8->16 promote
          }
          const t0 = performance.now();
          const _ = await doPlanar(pr, pg, pb, f.tgtW, f.tgtH, 1.0, 3, 0, 0, 0, 0, 0, 1);
          planar16ShotMs = performance.now() - t0;
        } catch (_) {}
      }

      const bodyMs = performance.now() - tBodyStart;

      results.push({
        file: f.file,
        prog_enc_ms: Math.round(progEnc.ms),
        prog_first_ms: Math.round(progDec.firstFrameMs),
        prog_final_ms: Math.round(progDec.ms),
        prog_passes: progDec.passCount,
        prog_size: progEnc.bytes.byteLength,
        shot_enc_ms: Math.round(shotEnc.ms),
        shot_dec_ms: Math.round(shotDec.ms),
        shot_size: shotEnc.bytes.byteLength,
        pyr_enc_ms: Math.round(pyrEncMs),
        pyr_dec_tot_ms: Math.round(pyrDecTotMs),
        pyr_levels: pyrLevelsCount,
        shot_bytes: shotEnc.bytes,
        body_wall_ms: Math.round(bodyMs),
        // additional from benchmark sweeps
        prog_ds2_first_ms: Math.round(progDs2.firstFrameMs),
        prog_ds2_final_ms: Math.round(progDs2.ms),
        prog_region_ms: Math.round(progRegion.ms),
        shot_ds2_ms: Math.round(shotDs2.ms),
        shot_region_ms: Math.round(shotRegion.ms),
        prog_chunked4_first_ms: Math.round(progChunked.firstFrameMs),
        prog_chunked4_final_ms: Math.round(progChunked.ms),
        mod_prog_enc_ms: Math.round(modProgEncMs),
        photon_prog_enc_ms: Math.round(photonEncMs),
        planar16_shot_enc_ms: Math.round(planar16ShotMs),
        // R14 timing hooks: frame prep (buffer take + region/downsample + resize) and WASM decode
        prog_frame_prep_ms: Math.round(progDec.metrics?.prog_frame_prep_ms ?? 0),
        prog_frame_count: progDec.metrics?.prog_frame_count ?? 0,
        shot_wasm_ms: Math.round(shotDec.metrics?.shot_wasm_ms ?? 0),
        shot_transform_ms: Math.round(shotDec.metrics?.shot_transform_ms ?? 0),
        // JXTC tile-container encode metrics (mirrors pyramid-ingest ladder.ts jxtcEncodeMs/jxtcKb)
        jxtc_enc_ms: Math.round(jxtcEncMs),
        jxtc_kb: parseFloat(jxtcKb.toFixed(1)),
      });
      const jxtcRatioStr = (shotEnc.ms > 0 && jxtcEncMs > 0)
        ? ` jxtc=${Math.round(jxtcEncMs)}ms/${jxtcKb.toFixed(0)}KB ratio=${(jxtcEncMs / shotEnc.ms).toFixed(2)}x`
        : (jxtcEncMs > 0 ? ` jxtc=${Math.round(jxtcEncMs)}ms/${jxtcKb.toFixed(0)}KB` : " jxtc=N/A");
      console.log(`  ➔ ${f.file}: prog_enc=${Math.round(progEnc.ms)}ms first_paint=${Math.round(progDec.firstFrameMs)}ms final_paint=${Math.round(progDec.ms)}ms | shot_dec=${Math.round(shotDec.ms)}ms | pyr_dec=${Math.round(pyrDecTotMs)}ms | body=${Math.round(bodyMs)}ms | planar16_shot=${Math.round(planar16ShotMs)} |${jxtcRatioStr} | +ds2/region/chunked/mod/photon +planar16 variants`);
    }
    console.log("");
    return results;
  }

  // --- 7.2 Run Single-Threaded sequential benchmarks (simd) ---
  // (rich: all variants + body= full per-file wall now logged. Stable core medians + speedups were already emitted by the preceding flip-flop A/B.)
  console.log(`--- [2/6] Executing Single-Threaded Sequential (simd) ---`);
  const simdResults = await runSequentialSuite("simd");

  // --- 7.3 Run Multi-Threaded sequential benchmarks (relaxed-simd-mt) ---
  console.log(`--- [3/6] Executing Multi-Threaded Sequential (relaxed-simd-mt) ---`);
  const mtResults = await runSequentialSuite("relaxed-simd-mt");

  // Optional baseline dump for optimize-codec-times workflow (opt-in via --json).
  {
    const jsonIdx = process.argv.indexOf('--json');
    if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
      const { writeDump } = await import('./benchmark/optimize/harness-dump.mjs');
      writeDump(process.argv[jsonIdx + 1], { loadedFiles, simdResults, mtResults, telemetry: globalThis.systemTelemetry });
      console.log(`  baseline dump → ${process.argv[jsonIdx + 1]}`);
    }
  }

  // --- Combined: Flip-Flop Core (new, stable interleaved medians + speedups) + Rich headlines + observed body (old full diagnostic run) ---
  // This directly merges the flip-flop A/B results (for trustworthy core tier comparison on the 4 headline metrics)
  // with the rich per-iteration numbers (prog/shot + the body= wall time that explains the "4s per file" count).
  console.log(`--- Combined Flip-Flop + Rich Headlines + Body Summary ---`);
  for (let i = 0; i < loadedFiles.length; i++) {
    const f = loadedFiles[i];
    const ff = (flipFlopResults || []).find(r => r.file === f.file) || {};
    const s = simdResults[i] || {};
    const m = mtResults[i] || {};
    console.log(
      `  ${f.file}: ` +
      `FLIP prog=${ff.simd_prog || 0}/${ff.mt_prog || 0} (${ff.spd_prog || 0}x) ` +
      `first=${ff.simd_first || 0}/${ff.mt_first || 0} (${ff.spd_first || 0}x) ` +
      `final=${ff.simd_final || 0}/${ff.mt_final || 0} (${ff.spd_final || 0}x) ` +
      `shot=${ff.simd_shot || 0}/${ff.mt_shot || 0} (${ff.spd_shot || 0}x) | ` +
      `RICH_s prog=${s.prog_enc_ms || 0} first=${s.prog_first_ms || 0} final=${s.prog_final_ms || 0} shot=${s.shot_dec_ms || 0} body=${s.body_wall_ms || 0}ms prep=${s.prog_frame_prep_ms || 0}ms[${s.prog_frame_count || 0}f] wasm=${s.shot_wasm_ms || 0}+tx=${s.shot_transform_ms || 0} | ` +
      `RICH_m prog=${m.prog_enc_ms || 0} first=${m.prog_first_ms || 0} final=${m.prog_final_ms || 0} shot=${m.shot_dec_ms || 0} body=${m.body_wall_ms || 0}ms prep=${m.prog_frame_prep_ms || 0}ms[${m.prog_frame_count || 0}f] wasm=${m.shot_wasm_ms || 0}+tx=${m.shot_transform_ms || 0}`
    );
  }
  console.log("  (FLIP = 10-round interleaved medians for core stability; RICH = full variant diagnostic pass with explicit body wall)");

  // --- 7.4 Run Multiple Workers parallel benchmark (scheduler stack) ---
  // createNodeContext spins a worker_thread pool (OS threads via jxl-worker-node).
  // Promise.all below achieves real CPU parallelism — unlike the old facade path where
  // all WASM ran on one thread and Promise.all serialized onto the same event loop.
  console.log(`--- [4/6] Executing Parallel Concurrency (jxl-session → jxl-scheduler → jxl-worker-node pool) ---`);
  const { createNodeContext } = await import("./packages/jxl-session/dist/index.js");
  const poolSize = Math.max(1, os.cpus().length - 1);
  const nodeCtx = createNodeContext({ poolSize });

  const tParallelStart = performance.now();
  const parallelDecResults = await Promise.all(
    simdResults.map(async (r) => {
      const tLvlDec = performance.now();
      const session = nodeCtx.decode({
        format: "rgba8",
        progressionTarget: "final",
        emitEveryPass: false,
        progressiveDetail: "none",
        downsample: 1,
        preserveIcc: false,
        preserveMetadata: false,
      });
      // DS-2: consume frames() before done()
      const framesTask = (async () => {
        try { for await (const _ of session.frames()) {} } catch (_) {}
      })();
      // Copy before push: session.push() transfers the ArrayBuffer to the worker
      // (detaches it). shot_bytes is reused in section [6/6], so must not transfer original.
      await session.push(r.shot_bytes.buffer.slice(0)).catch(() => {});
      await session.close().catch(() => {});
      await framesTask;
      try { await session.done(); } catch (_) {}
      return performance.now() - tLvlDec;
    })
  );
  const parallelWallMs = Math.round(performance.now() - tParallelStart);
  await nodeCtx.shutdown();

  const sequentialDecSum = simdResults.reduce((sum, r) => sum + r.shot_dec_ms, 0);
  const throughputGain = (sequentialDecSum / parallelWallMs).toFixed(2);

  console.log(`  Pool size:                 ${poolSize} workers (OS threads via jxl-worker-node)`);
  console.log(`  Sequential Sum of Decodes: ${sequentialDecSum}ms`);
  console.log(`  Parallel Wall-Clock Time:  ${parallelWallMs}ms`);
  console.log(`  🚀 Multi-Worker Speedup:   ${throughputGain}x (Parallel vs Sequential throughput)\n`);




  // =========================================================================
  // --- 7.5 DEEP DIAGNOSTIC 1: Transferable vs Structured Clone Cost (U1) ---
  // =========================================================================
  console.log(`--- [5/6] Diagnostic U1: Transferable vs. Structured Clone (Copy) Cost ---`);
  
  // Create an artificial worker to act as the reflection postMessage target
  const dummyWorkerUrl = new URL("./jxl-worker-shim.mjs", import.meta.url).href;
  const dummyWorker = new NodeWorker(new URL("./jxl-worker-shim.mjs", import.meta.url), {
    workerData: { url: dummyWorkerUrl, name: "dummy-diag" },
  });

  const sizesToTest = [
    { label: "1MB", bytes: 1024 * 1024 },
    { label: "10MB", bytes: 10 * 1024 * 1024 },
    { label: "30MB (Typical 1920 RGBA at benchmark target scale)", bytes: 1920 * 1440 * 4 } // benchmark uses 1920px long-edge, not native 20MP size
  ];

  const diagTransferResults = [];
  for (const s of sizesToTest) {
    // Measure structured clone (Copy)
    const bufCopy = new ArrayBuffer(s.bytes);
    const tCopyStart = performance.now();
    // Simulate Structured Clone (which serializes/clones across thread boundary)
    const cloneBytes = structuredClone(bufCopy);
    const copyMs = performance.now() - tCopyStart;

    // Measure Transfer (moving ownership zero-copy)
    const bufTransfer = new ArrayBuffer(s.bytes);
    const tTransferStart = performance.now();
    // In Node.js worker_threads, we move buffer ownership using the transferList option on postMessage
    dummyWorker.postMessage({ cmd: "noop", buffer: bufTransfer }, [bufTransfer]);
    const transferMs = performance.now() - tTransferStart;

    diagTransferResults.push({
      label: s.label,
      bytes: s.bytes,
      copyMs: parseFloat(copyMs.toFixed(3)),
      transferMs: parseFloat(transferMs.toFixed(3)),
      ratio: (copyMs / Math.max(0.001, transferMs)).toFixed(1)
    });
    console.log(`  ➔ Size ${s.label}: structured_clone=${copyMs.toFixed(3)}ms | transferable_postMessage=${transferMs.toFixed(3)}ms (Transfer is ${diagTransferResults[diagTransferResults.length-1].ratio}x faster)`);
  }
  await dummyWorker.terminate();
  console.log("");


  // =========================================================================
  // --- 7.6 DEEP DIAGNOSTIC 2: JXTC Tiled Container ROI vs. Monolithic ROI ---
  // =========================================================================
  console.log(`--- [6/6] Diagnostic G3: Real JXTC Tiled Container Region of Interest (ROI) Decodes ---`);
  
  const diagRoiResults = [];
  // Use a large file from our config to get meaningful ROI measurements
  const largeFileIndex = loadedFiles.findIndex(f => f.file === "PXL_20260501_093507165.RAW-02.ORIGINAL.dng" || f.file === "P1110226.ORF");
  
  if (largeFileIndex !== -1) {
    const f = loadedFiles[largeFileIndex];
    
    // --- 1. Encode into a REAL JXTC Tiled Container (256px tile size) ---
    console.log(`  Encoding ${f.file} into JXTC Tiled Container (tileSize=256)...`);
    const encMetrics = {};
    const tJxtcEnc = performance.now();
    const jxtcBytes = await encodeTileContainerRgba8(exactBuffer(f.rgba), f.tgtW, f.tgtH, {
      tileSize: 256,
      distance: 1.0, // Quality 85
      effort: 3,
      onMetric: (name, val) => {
        encMetrics[name] = val;
      }
    });
    const jxtcEncMs = performance.now() - tJxtcEnc;
    globalThis.finalEncMetrics = encMetrics; // Save for TOON serialization
    console.log(`    ➔ JXTC Encoding complete: size=${(jxtcBytes.byteLength / 1024).toFixed(0)}KB | time=${Math.round(jxtcEncMs)}ms`);
    console.log(`      ⚡ Granular FFI Sub-timers:`);
    console.log(`         - Input Prep:   ${(encMetrics.enc_input_prep || 0).toFixed(1)}ms`);
    console.log(`         - Heap Malloc:  ${(encMetrics.enc_malloc || 0).toFixed(1)}ms`);
    console.log(`         - Heap Copy:    ${(encMetrics.enc_heap_set || 0).toFixed(1)}ms`);
    console.log(`         - Core Compress: ${(encMetrics.enc_wasm_encode || 0).toFixed(1)}ms (C++ libjxl)`);
    console.log(`         - Buffer Read:  ${(encMetrics.enc_buffer_read || 0).toFixed(1)}ms`);
    console.log(`         - Heap Free:    ${(encMetrics.enc_free || 0).toFixed(1)}ms`);
    
    const initOverhead = (encMetrics.enc_input_prep || 0) + (encMetrics.enc_malloc || 0) + (encMetrics.enc_heap_set || 0);
    const teardownOverhead = (encMetrics.enc_buffer_read || 0) + (encMetrics.enc_free || 0);
    console.log(`         🚀 Boundary Setup Overhead:    ${initOverhead.toFixed(1)}ms`);
    console.log(`         🚀 Boundary Teardown Overhead: ${teardownOverhead.toFixed(1)}ms`);

    // Target a central 512x512 ROI region
    const roiW = 512;
    const roiH = 512;
    const roiX = Math.round((f.tgtW - roiW) / 2);
    const roiY = Math.round((f.tgtH - roiH) / 2);

    const region = { x: roiX, y: roiY, w: roiW, h: roiH };

    console.log(`[DEBUG G3] f.tgtW=${f.tgtW}, f.tgtH=${f.tgtH}, roiX=${roiX}, roiY=${roiY}, roiW=${roiW}, roiH=${roiH}`);

    // 2. Decode unified ROI on MONOLITHIC JXL
    const monolithicBytes = simdResults[largeFileIndex].shot_bytes;
    const tMonRoiStart = performance.now();
    const monRoiRes = await decodeJxl(monolithicBytes, false, { region });
    const monRoiMs = performance.now() - tMonRoiStart;

    // 3. Decode unified ROI on REAL JXTC Tiled Container (seek-aware crop)
    const tJxtcRoiStart = performance.now();
    const jxtcRoiRes = await decodeTileContainerRegionRgba8(jxtcBytes, { x: roiX, y: roiY, w: roiW, h: roiH });
    const jxtcRoiMs = performance.now() - tJxtcRoiStart;

    // --- P-4 Seam Test Correctness Verification ---
    console.log(`\n  [P-4 Seam Test] Comparing JXTC ROI vs. Monolithic ROI pixel-by-pixel...`);
    const monPixels = monRoiRes.pixels; // Uint8Array of monolithic ROI pixels
    const jxtcPixels = jxtcRoiRes.pixels; // Uint8Array of JXTC ROI pixels

    if (!monPixels) {
      console.error(`  ⚠️  [P-4 Seam Test] Warning: Monolithic ROI did not return pixel array to compare.`);
    } else if (monPixels.length !== jxtcPixels.length) {
      console.error(`  ❌ FAIL: [P-4 Seam Test] Buffer lengths differ! Monolithic=${monPixels.length} | JXTC=${jxtcPixels.length}`);
    } else {
      let mismatches = 0;
      let maxDiff = 0;
      for (let i = 0; i < monPixels.length; i++) {
        if (monPixels[i] !== jxtcPixels[i]) {
          mismatches++;
          const diff = Math.abs(monPixels[i] - jxtcPixels[i]);
          if (diff > maxDiff) maxDiff = diff;
        }
      }
        if (mismatches === 0) {
          console.log(`  ✅ SUCCESS: [P-4 Seam Test] Passed! JXTC Tiled Region Decode is 100% pixel-exact byte-identical to Monolithic ROI Decode! (0 byte mismatches, 0 drift)`);
        } else {
          const seamAssessment = assessSeamComparison({
            mismatches,
            totalBytes: monPixels.length,
            maxDiff,
          });
          if (seamAssessment.shouldFail) {
            console.error(`  ❌ FAIL: [P-4 Seam Test] Failed! ${seamAssessment.message}`);
          } else {
            console.warn(`  ⚠️  [P-4 Seam Test] ${seamAssessment.message}`);
          }
        }
      }

    // 4. 4-Tile Split Decode on JXTC (decompressing individual tiles independently)
    const tiles = [
      { x: roiX, y: roiY, w: 256, h: 256 },
      { x: roiX + 256, y: roiY, w: 256, h: 256 },
      { x: roiX, y: roiY + 256, w: 256, h: 256 },
      { x: roiX + 256, y: roiY + 256, w: 256, h: 256 }
    ];

    const tTiledSeqStart = performance.now();
    for (const tile of tiles) {
      await decodeTileContainerRegionRgba8(jxtcBytes, { x: tile.x, y: tile.y, w: tile.w, h: tile.h });
    }
    const tiledSeqMs = performance.now() - tTiledSeqStart;

    // 5. 4-Tile Parallel Decode on JXTC (Promise.all)
    const tTiledParStart = performance.now();
    await Promise.all(
      tiles.map(async (tile) => {
        return await decodeTileContainerRegionRgba8(jxtcBytes, { x: tile.x, y: tile.y, w: tile.w, h: tile.h });
      })
    );
    const tiledParMs = performance.now() - tTiledParStart;

    // 6. --- Full-Size Decoding Benchmarks (Tiled vs Monolithic) ---
    console.log(`\n  Benchmarking FULL-SIZE Decodes on ${f.file}...`);
    const monolithicFullMs = simdResults[largeFileIndex].shot_dec_ms;

    // Unified Full JXTC Decode (1 call)
    const tJxtcFullStart = performance.now();
    await decodeTileContainerRegionRgba8(jxtcBytes, { x: 0, y: 0, w: f.tgtW, h: f.tgtH });
    const jxtcFullMs = performance.now() - tJxtcFullStart;

    // Compute all tiles for the entire image (256px grid)
    const fullTiles = [];


    const tileSize = 256;
    for (let ty = 0; ty < Math.ceil(f.tgtH / tileSize); ty++) {
      for (let tx = 0; tx < Math.ceil(f.tgtW / tileSize); tx++) {
        const tw = Math.min(tileSize, f.tgtW - tx * tileSize);
        const th = Math.min(tileSize, f.tgtH - ty * tileSize);
        fullTiles.push({ x: tx * tileSize, y: ty * tileSize, w: tw, h: th });
      }
    }

    // Sequential All-Tile JXTC Decode (Sequential Stitch)
    const tFullTiledSeqStart = performance.now();
    for (const tile of fullTiles) {
      await decodeTileContainerRegionRgba8(jxtcBytes, { x: tile.x, y: tile.y, w: tile.w, h: tile.h });
    }
    const fullTiledSeqMs = performance.now() - tFullTiledSeqStart;

    // Parallel All-Tile JXTC Decode (Concurrent Workers)
    const tFullTiledParStart = performance.now();
    await Promise.all(
      fullTiles.map(async (tile) => {
        return await decodeTileContainerRegionRgba8(jxtcBytes, { x: tile.x, y: tile.y, w: tile.w, h: tile.h });
      })
    );
    const fullTiledParMs = performance.now() - tFullTiledParStart;

    // 7. --- JXTC Tiled Encoding vs. Monolithic/Single-Shot Encoding ---
    const monolithicEncMs = simdResults[largeFileIndex].shot_enc_ms;

    diagRoiResults.push({
      file: f.file,
      monolithicMs: Math.round(monRoiMs),
      jxtcMs: Math.round(jxtcRoiMs),
      tiledSeqMs: Math.round(tiledSeqMs),
      tiledParMs: Math.round(tiledParMs),
      monolithicFullMs: Math.round(monolithicFullMs),
      jxtcFullMs: Math.round(jxtcFullMs),
      fullTiledSeqMs: Math.round(fullTiledSeqMs),
      fullTiledParMs: Math.round(fullTiledParMs),
      monolithicEncMs: Math.round(monolithicEncMs),
      jxtcEncMs: Math.round(jxtcEncMs),
    });

    console.log(`\n  --- ROI (512x512) CROP TIMINGS ---`);
    console.log(`  ➔ Monolithic ROI Crop Decode (No Tiling):     ${Math.round(monRoiMs)}ms`);
    console.log(`  ➔ Real JXTC Tiled ROI Crop Decode (One Call):  ${Math.round(jxtcRoiMs)}ms (Speedup: ${(monRoiMs / jxtcRoiMs).toFixed(1)}x)`);
    console.log(`  ➔ JXTC Sequential 4-Tile Crop Decodes:        ${Math.round(tiledSeqMs)}ms`);
    console.log(`  ➔ JXTC Parallel 4-Tile Crop Decodes:          ${Math.round(tiledParMs)}ms`);

    console.log(`\n  --- BENCHMARK SCALE (1920px long-edge target; native 20MP RAWs scaled for consistent timing) ---`);
    console.log(`  ➔ Monolithic Full Decode (Standard):          ${Math.round(monolithicFullMs)}ms`);
    console.log(`  ➔ Real JXTC Tiled Full Decode (One Call):     ${Math.round(jxtcFullMs)}ms`);
    console.log(`  ➔ JXTC Sequential All-Tile Decode (Stitch):   ${Math.round(fullTiledSeqMs)}ms`);
    console.log(`  ➔ JXTC Parallel All-Tile Decode (Workers):     ${Math.round(fullTiledParMs)}ms (${fullTiles.length} tiles)`);

    console.log(`\n  --- ENCODING TIMINGS (Tiled vs Monolithic) ---`);
    console.log(`  ➔ Monolithic JXL Encoding Speed:              ${Math.round(monolithicEncMs)}ms`);
    console.log(`  ➔ Real JXTC Tiled Container Encoding Speed:   ${Math.round(jxtcEncMs)}ms (Overhead: +${(jxtcEncMs - monolithicEncMs).toFixed(0)}ms)`);

    // Wire + exercise the JXL encode zero-copy hook (encodeRgb16Planar): 3 u16 planes direct (no JS interleaved rgb16 alloc/copy).
    // Demo 1: promoted from the target rgba (exercises planar marshal/ensureU16Heap + bridge interleave vs rgba8 path).
    // Demo 2 (when available): real 16-bit from fast preview thumb packed (6B/px from planar dem+downscale in raw decode; deinterleave small, then planar encode).
    // This is the "see what a difference" measurement point for boundary cost after the planar hypercar changes.
    if (typeof encodeRgb16Planar === 'function') {
      try {
        const npix = f.tgtW * f.tgtH;
        const r16 = new Uint16Array(npix), g16 = new Uint16Array(npix), b16 = new Uint16Array(npix);
        const src = f.rgba || new Uint8Array();
        const ch = src.length >= npix * 3 ? (src.length / npix | 0) : 4;
        for (let i = 0, o = 0; i < npix; i++, o += ch) {
          const rv = src[o] || 0, gv = src[o + 1] || 0, bv = src[o + 2] || 0;
          r16[i] = (rv << 8) | rv; g16[i] = (gv << 8) | gv; b16[i] = (bv << 8) | bv;
        }
        const tP = performance.now();
        const p16 = await encodeRgb16Planar(r16, g16, b16, f.tgtW, f.tgtH, 1.0, 3, 0, 0, 0, 0, 0, 1);
        const p16ms = performance.now() - tP;
        console.log(`  ➔ planar16_enc (hook, promoted rgba8->u16 planes): ${Math.round(p16ms)}ms size=${(p16.byteLength/1024).toFixed(0)}KB (vs monolithic rgba8 ${Math.round(monolithicEncMs)}ms)`);
      } catch (e) {
        console.log(`  ➔ planar16_enc hook: skipped (${e && e.message ? e.message : e}) — rebuild jxl-wasm bridge if symbol missing`);
      }

      // Real data from fast preview path (if this large file had thumb packed populated by the |2|4 flags + orf/dng path)
      if (f.thPack && f.thW && f.thH) {
        try {
          const n = f.thW * f.thH;
          const pr = new Uint16Array(n), pg = new Uint16Array(n), pb = new Uint16Array(n);
          const pk = f.thPack;
          for (let i = 0, o = 0; i < n; i++, o += 6) {
            pr[i] = pk[o] | (pk[o + 1] << 8);
            pg[i] = pk[o + 2] | (pk[o + 3] << 8);
            pb[i] = pk[o + 4] | (pk[o + 5] << 8);
          }
          const tThumb = performance.now();
          const thumbJ = await encodeRgb16Planar(pr, pg, pb, f.thW, f.thH, 1.0, 3);
          const thumbMs = performance.now() - tThumb;
          console.log(`  ➔ planar16_thumb (real 16b from fast planar preview path + zero-copy hook): ${Math.round(thumbMs)}ms size=${(thumbJ.byteLength/1024).toFixed(1)}KB (${f.thW}x${f.thH})`);
        } catch (e) {
          console.log(`  ➔ planar16_thumb from preview: ${e && e.message ? e.message : e}`);
        }
      }
    } else {
      console.log("  ➔ encodeRgb16Planar not in jxl-wasm export (source has it; dist rebuild will surface)");
    }
  } else {
    console.log("  ⚠️  Skipping ROI diagnostics: No large RAW file was loaded.");
  }
  console.log("");

  // --- 7.7 RUN ADDITIONAL TIMINGS from benchmark/*.mjs + examined timings/*.mjs ---
  // Covers permutations, rich decode variants, substage, progressive chunk/stream, sweeps (modular, photon, brotli, quality etc) not in core path.
  // timings/ *.mjs (single-progressive-*.mjs, probe-wasm-tier.mjs) are browser+server launchers for web single-prog page; left as separate (require http://localhost:9000 + playwright).
  // We run limited node-only ones here so their .toon land in timing dir for consolidate+graph.
  console.log(`--- [7/7] Additional timings from benchmark/*.mjs (limited to keep responsive) ---`);
  const addEnvBase = { ...process.env };
  const tried = [];
  function runLimitedBench(script, extraEnv = {}, timeoutMs = 60000) {
    const env = { ...addEnvBase, ...extraEnv };
    const cmd = `node ${script}`;
    tried.push(script);
    try {
      execSync(cmd, { stdio: "ignore", timeout: timeoutMs, env, cwd: process.cwd() });
      console.log(`  ✓ ${script} (limited)`);
      return true;
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 120);
      console.log(`  - ${script} (skipped/partial: ${msg})`);
      return false;
    }
  }
  if (process.env.SKIP_ADDITIONAL_BENCHES) {
    console.log(`  (SKIP_ADDITIONAL_BENCHES=1 — skipping limited additional benches to guarantee .toon + graph write)`);
  } else {
    runLimitedBench("benchmark/timing-tests.mjs", {
      TIMING_RAW_LIMIT: "1", TIMING_JPEG_LIMIT: "1", TIMING_TARGET: "400",
      TIMING_EFFORTS: "3", TIMING_MODES: "std,std+chunked"
    }, 90000);
    runLimitedBench("benchmark/progressive-timing-benchmark.mjs", {
      PT_LIMIT: "1", PT_SIZES: "400", PT_QUALITY: "85", PT_EFFORT: "3", PT_STEPS: "4"
    }, 90000);
    runLimitedBench("benchmark/targeted-wasm-timings.mjs", {
      TEST_RUNS: "1", TEST_SCAN_LIMIT: "1", GOB_SCAN_LIMIT: "0", GOB_OFFENDER_COUNT: "0", TRACE_PROGRESS: "0", TRACE_STAGES: "0"
    }, 60000);
    // A couple of the numbered sweep tests (via their env overrides if present; most default to small via utils)
    runLimitedBench("benchmark/test_14_modular_mode_sweep.mjs", { TEST14_LIMIT: "1" }, 60000);
    runLimitedBench("benchmark/test_11_brotli_effort_sweep.mjs", { /* may honor or use 1 file */ }, 60000);
    console.log(`  (examined also: timings/probe-wasm-tier.mjs, timings/single-progressive-*.mjs — browser CDP paths for lastPasses/passes single-prog metrics)`);
    console.log(`  Additional tried: ${tried.join(", ")}`);
  }
  console.log("");


  // --- 8. Build Combined Modified TOON Format Output ---
  const toonLines = [
    `TestName: StandardMultifileTest - ${batchName}`,
    `RunTimestamp: ${runTimestamp}`,
    `Agent: gemini-cli`,
    `Tier: simd+relaxed-simd-mt`,
    `Source: multi-format`,
    `Target: ${TARGET}`,
    `Quality: 85`,
    `Efforts: 3`,
    `TimeBase: timeBase`,
    "",
    "# System Context & Telemetry",
    `SystemPlatform: ${globalThis.systemTelemetry?.platform || 'Unknown'}`,
    `SystemCpuModel: ${globalThis.systemTelemetry?.cpuModel || 'Unknown'}`,
    `SystemCores: ${globalThis.systemTelemetry?.cores || 'N/A'}`,
    `SystemMemoryFreeGb: ${globalThis.systemTelemetry?.memoryFreeGb || 'N/A'}`,
    `SystemMemoryTotalGb: ${globalThis.systemTelemetry?.memoryTotalGb || 'N/A'}`,
    `NodeHeapActiveMb: ${globalThis.systemTelemetry?.nodeHeapMb || 'N/A'}`,
    "",
    "# CPU Metrics",
    `CpuLoadPct: ${globalThis.systemTelemetry?.cpuLoadPct || 'N/A'}`,
    `CpuClockCurrentGhz: ${globalThis.systemTelemetry?.cpuClockCurrentGhz || 'N/A'}`,
    `CpuClockMaxGhz: ${globalThis.systemTelemetry?.cpuClockMaxGhz || 'N/A'}`,
    `CpuThrottlingState: ${globalThis.systemTelemetry?.cpuThrottlingState || 'Optimal'}`,
    `CpuTemperatureCelsius: ${globalThis.systemTelemetry?.cpuTemperatureCelsius || 'N/A'}`,
    `CpuVoltageMv: ${globalThis.systemTelemetry?.cpuVoltageMv || 'N/A'}`,
    `CpuPowerW: ${globalThis.systemTelemetry?.cpuPowerW || 'N/A'}`,
    `CpuFanRpm: ${globalThis.systemTelemetry?.cpuFanRpm || 'N/A'}`,
    `CpuFanDutyPct: ${globalThis.systemTelemetry?.cpuFanDutyPct || 'N/A'}`,
    "",
    "# GPU Metrics",
    `GpuClockMhz: ${globalThis.systemTelemetry?.gpuClockMhz || 'N/A'}`,
    `GpuMemoryMhz: ${globalThis.systemTelemetry?.gpuMemoryMhz || 'N/A'}`,
    `GpuMemoryUsedMb: ${globalThis.systemTelemetry?.gpuMemoryUsedMb || 'N/A'}`,
    `GpuMemoryTotalMb: ${globalThis.systemTelemetry?.gpuMemoryTotalMb || 'N/A'}`,
    `GpuLoadPct: ${globalThis.systemTelemetry?.gpuLoadPct || 'N/A'}`,
    `GpuTemperatureCelsius: ${globalThis.systemTelemetry?.gpuTemperatureCelsius || 'N/A'}`,
    `GpuPowerW: ${globalThis.systemTelemetry?.gpuPowerW || 'N/A'}`,
    "",
    "# System Power & Storage",
    `SystemPowerW: ${globalThis.systemTelemetry?.systemPowerW || 'N/A'}`,
    `StorageTemperatureCelsius: ${globalThis.systemTelemetry?.storageTemperatureCelsius || 'N/A'}`,
    "",

    "",
    "---",
    `runs[${loadedFiles.length}]{file|raw_ms|scale_ms|raw_decompress_ms|raw_demosaic_ms|raw_tonemap_ms|prog_enc_simd_ms|prog_enc_mt_ms|prog_first_simd_ms|prog_first_mt_ms|prog_final_simd_ms|prog_final_mt_ms|shot_enc_simd_ms|shot_enc_mt_ms|shot_dec_simd_ms|shot_dec_mt_ms|pyr_enc_simd_ms|pyr_enc_mt_ms|pyr_dec_simd_ms|pyr_dec_mt_ms|prog_ds2_first_simd_ms|prog_ds2_final_simd_ms|prog_region_simd_ms|shot_ds2_simd_ms|shot_region_simd_ms|prog_chunked4_first_simd_ms|mod_prog_enc_simd_ms|photon_prog_enc_simd_ms|body_wall_ms|jxtc_enc_simd_ms|jxtc_kb_simd}:`
  ];

  for (let i = 0; i < loadedFiles.length; i++) {
    const f = loadedFiles[i];
    const s = simdResults[i];
    const m = mtResults[i];
    toonLines.push(`  ${f.file} | ${Math.round(f.rawMs)} | ${Math.round(f.scaleMs)} | ${Math.round(f.rawDecompress||0)} | ${Math.round(f.rawDemosaic||0)} | ${Math.round(f.rawTonemap||0)} | ${s.prog_enc_ms} | ${m.prog_enc_ms} | ${s.prog_first_ms} | ${m.prog_first_ms} | ${s.prog_final_ms} | ${m.prog_final_ms} | ${s.shot_enc_ms} | ${m.shot_enc_ms} | ${s.shot_dec_ms} | ${m.shot_dec_ms} | ${s.pyr_enc_ms} | ${m.pyr_enc_ms} | ${s.pyr_dec_tot_ms} | ${m.pyr_dec_tot_ms} | ${s.prog_ds2_first_ms||0} | ${s.prog_ds2_final_ms||0} | ${s.prog_region_ms||0} | ${s.shot_ds2_ms||0} | ${s.shot_region_ms||0} | ${s.prog_chunked4_first_ms||0} | ${s.mod_prog_enc_ms||0} | ${s.photon_prog_enc_ms||0} | ${s.body_wall_ms||0} | ${s.jxtc_enc_ms||0} | ${s.jxtc_kb||0}`);
  }

  // Compute Averages
  const avgRaw = Math.round(loadedFiles.reduce((s, r) => s + r.rawMs, 0) / loadedFiles.length);
  const avgScale = Math.round(loadedFiles.reduce((s, r) => s + r.scaleMs, 0) / loadedFiles.length);
  const avgRawDecomp = Math.round(loadedFiles.reduce((s, r) => s + (r.rawDecompress||0), 0) / loadedFiles.length);
  const avgRawDemo   = Math.round(loadedFiles.reduce((s, r) => s + (r.rawDemosaic||0), 0) / loadedFiles.length);
  const avgRawTone   = Math.round(loadedFiles.reduce((s, r) => s + (r.rawTonemap||0), 0) / loadedFiles.length);
  // New hooks (preview fast path from planar dem+down; meaningful for RAW files; jpgs stay 0)
  const avgPrevDem = Math.round(loadedFiles.reduce((s, r) => s + (r.previewDem||0), 0) / loadedFiles.length);
  const avgPrevDown = Math.round(loadedFiles.reduce((s, r) => s + (r.previewDown||0), 0) / loadedFiles.length);

  const avgProgEncSimd = Math.round(simdResults.reduce((s, r) => s + r.prog_enc_ms, 0) / loadedFiles.length);
  const avgProgEncMt   = Math.round(mtResults.reduce((s, r) => s + r.prog_enc_ms, 0) / loadedFiles.length);
  const avgProgFirstSimd = Math.round(simdResults.reduce((s, r) => s + r.prog_first_ms, 0) / loadedFiles.length);
  const avgProgFirstMt   = Math.round(mtResults.reduce((s, r) => s + r.prog_first_ms, 0) / loadedFiles.length);
  const avgProgFinalSimd = Math.round(simdResults.reduce((s, r) => s + r.prog_final_ms, 0) / loadedFiles.length);
  const avgProgFinalMt   = Math.round(mtResults.reduce((s, r) => s + r.prog_final_ms, 0) / loadedFiles.length);

  const avgShotEncSimd = Math.round(simdResults.reduce((s, r) => s + r.shot_enc_ms, 0) / loadedFiles.length);
  const avgShotEncMt   = Math.round(mtResults.reduce((s, r) => s + r.shot_enc_ms, 0) / loadedFiles.length);
  const avgShotDecSimd = Math.round(simdResults.reduce((s, r) => s + r.shot_dec_ms, 0) / loadedFiles.length);
  const avgShotDecMt   = Math.round(mtResults.reduce((s, r) => s + r.shot_dec_ms, 0) / loadedFiles.length);

  const avgPyrEncSimd = Math.round(simdResults.reduce((s, r) => s + r.pyr_enc_ms, 0) / loadedFiles.length);
  const avgPyrEncMt   = Math.round(mtResults.reduce((s, r) => s + r.pyr_enc_ms, 0) / loadedFiles.length);
  const avgPyrDecSimd = Math.round(simdResults.reduce((s, r) => s + r.pyr_dec_tot_ms, 0) / loadedFiles.length);
  const avgPyrDecMt   = Math.round(mtResults.reduce((s, r) => s + r.pyr_dec_tot_ms, 0) / loadedFiles.length);

  // additional avgs (simd-focused coverage for benchmark/ missing timings)
  const avgProgDs2First = Math.round(simdResults.reduce((s, r) => s + (r.prog_ds2_first_ms||0), 0) / loadedFiles.length);
  const avgProgChunkedFirst = Math.round(simdResults.reduce((s, r) => s + (r.prog_chunked4_first_ms||0), 0) / loadedFiles.length);
  const avgModProgEnc = Math.round(simdResults.reduce((s, r) => s + (r.mod_prog_enc_ms||0), 0) / loadedFiles.length);
  const avgPhotonProgEnc = Math.round(simdResults.reduce((s, r) => s + (r.photon_prog_enc_ms||0), 0) / loadedFiles.length);
  const avgPlanar16ShotEncSimd = Math.round(simdResults.reduce((s, r) => s + (r.planar16_shot_enc_ms||0), 0) / loadedFiles.length);

  // JXTC per-file encode metrics (mirrors pyramid-ingest ladder.ts jxtcEncodeMs/jxtcKb)
  const avgJxtcEncSimd = Math.round(simdResults.reduce((s, r) => s + (r.jxtc_enc_ms||0), 0) / loadedFiles.length);
  const avgJxtcEncMt   = Math.round(mtResults.reduce((s, r) => s + (r.jxtc_enc_ms||0), 0) / loadedFiles.length);
  const avgJxtcKbSimd  = parseFloat((simdResults.reduce((s, r) => s + (r.jxtc_kb||0), 0) / loadedFiles.length).toFixed(1));
  const jxtcVsShotRatioSimd = avgShotEncSimd > 0 && avgJxtcEncSimd > 0
    ? parseFloat((avgJxtcEncSimd / avgShotEncSimd).toFixed(2))
    : null;

  // JXTC per-file summary: print to console for immediate visibility
  if (avgJxtcEncSimd > 0) {
    console.log(`--- JXTC Encode Overhead Summary ---`);
    console.log(`  avg JXL one-shot (simd):  ${avgShotEncSimd}ms`);
    console.log(`  avg JXTC encode (simd):   ${avgJxtcEncSimd}ms  avg size: ${avgJxtcKbSimd}KB`);
    if (jxtcVsShotRatioSimd !== null) {
      console.log(`  JXTC overhead ratio:      ${jxtcVsShotRatioSimd}x (vs one-shot JXL)`);
    }
    console.log(`  Per-file breakdown (simd):`);
    for (let i = 0; i < loadedFiles.length; i++) {
      const sf = loadedFiles[i];
      const sr = simdResults[i] || {};
      const ratio = (sr.shot_enc_ms||0) > 0 && (sr.jxtc_enc_ms||0) > 0
        ? ` ratio=${((sr.jxtc_enc_ms||0) / (sr.shot_enc_ms||1)).toFixed(2)}x`
        : "";
      console.log(`    ${sf.file}: JXL=${sr.shot_enc_ms||0}ms JXTC=${sr.jxtc_enc_ms||0}ms/${(sr.jxtc_kb||0).toFixed(0)}KB${ratio}`);
    }
    console.log("");
  }

  toonLines.push("", "# Aggregates");
  toonLines.push(`TotalRecords: ${loadedFiles.length}`);
  toonLines.push(`MultiWorkerSequentialDecSumMs: ${sequentialDecSum}`);
  toonLines.push(`MultiWorkerParallelWallMs: ${parallelWallMs}`);
  toonLines.push(`MultiWorkerSpeedupRatio: ${throughputGain}`);

  toonLines.push("", "# Diagnostics U1 (Transfer vs Structured Clone Copy ms)");
  for (const t of diagTransferResults) {
    toonLines.push(`  TransferSize_${t.label}: clone_copy=${t.copyMs}ms | transferable_transfer=${t.transferMs}ms | transfer_speedup=${t.ratio}x`);
  }

  if (diagRoiResults.length > 0) {
    const r = diagRoiResults[0];
    toonLines.push("", "# Diagnostics G3 (Unified JXTC Tiled ROI vs Monolithic ROI ms)");
    toonLines.push(`  RoiFileUnderBenchmark: ${r.file}`);
    toonLines.push(`  MonolithicRoi_512_512_Ms: ${r.monolithicMs}`);
    toonLines.push(`  RealJxtcTiledRoi_512_512_Ms: ${r.jxtcMs}`);
    toonLines.push(`  JxtcTiledSequential_4_256_256_Ms: ${r.tiledSeqMs}`);
    toonLines.push(`  JxtcTiledParallel_4_256_256_Ms: ${r.tiledParMs}`);
  }

  // Flip-flop core (performed alternating blocks for stable tier A/B on headline metrics)
  toonLines.push("", "# Flip-Flop Core (interleaved simd <-> mt medians, 3 rounds)");
  for (const ff of (flipFlopResults || [])) {
    toonLines.push(
      `  ${ff.file} | ` +
      `simd_prog=${ff.simd_prog} mt=${ff.mt_prog} spd=${ff.spd_prog}x | ` +
      `first=${ff.simd_first}/${ff.mt_first} (${ff.spd_first}x) | ` +
      `final=${ff.simd_final}/${ff.mt_final} (${ff.spd_final}x) | ` +
      `shot=${ff.simd_shot}/${ff.mt_shot} (${ff.spd_shot}x)`
    );
  }

  toonLines.push("", "# Averages");
  toonLines.push(`AvgRawMs: ${avgRaw}`);
  toonLines.push(`AvgScaleMs: ${avgScale}`);
  toonLines.push(`AvgRawDecompressMs: ${avgRawDecomp} | AvgRawDemosaicMs: ${avgRawDemo} | AvgRawTonemapMs: ${avgRawTone}`);
  toonLines.push(`AvgPreviewDemosaicMs: ${avgPrevDem} | AvgPreviewDownscaleMs: ${avgPrevDown} | (fast planar bilinear dem + planar box for lb/thumb; mhc only full; fast_preview flag per-RAW)`);
  toonLines.push(`AvgProgEncSimdMs: ${avgProgEncSimd} | AvgProgEncMtMs: ${avgProgEncMt}`);
  toonLines.push(`AvgProgFirstSimdMs: ${avgProgFirstSimd} | AvgProgFirstMtMs: ${avgProgFirstMt}`);
  toonLines.push(`AvgProgFinalSimdMs: ${avgProgFinalSimd} | AvgProgFinalMtMs: ${avgProgFinalMt}`);
  toonLines.push(`AvgShotEncSimdMs: ${avgShotEncSimd} | AvgShotEncMtMs: ${avgShotEncMt}`);
  toonLines.push(`AvgShotDecSimdMs: ${avgShotDecSimd} | AvgShotDecMtMs: ${avgShotDecMt}`);
  toonLines.push(`AvgPyrEncSimdMs: ${avgPyrEncSimd} | AvgPyrEncMtMs: ${avgPyrEncMt}`);
  toonLines.push(`AvgPyrDecSimdMs: ${avgPyrDecSimd} | AvgPyrDecMtMs: ${avgPyrDecMt}`);
  toonLines.push(`AvgProgDs2FirstSimdMs: ${avgProgDs2First} | AvgProgChunked4FirstSimdMs: ${avgProgChunkedFirst}`);
  toonLines.push(`AvgModProgEncSimdMs: ${avgModProgEnc}`);
  toonLines.push(`AvgPhotonProgEncSimdMs: ${avgPhotonProgEnc}`);
  toonLines.push(`AvgPlanar16ShotEncSimdMs: ${avgPlanar16ShotEncSimd} (planar16 low-copy encode path vs rgba8 baseline for the target encodes)`);
  toonLines.push(`AvgJxtcEncSimdMs: ${avgJxtcEncSimd} | AvgJxtcEncMtMs: ${avgJxtcEncMt} | AvgJxtcKbSimd: ${avgJxtcKbSimd} | JxtcVsShotRatioSimd: ${jxtcVsShotRatioSimd !== null ? jxtcVsShotRatioSimd + 'x' : 'N/A'} (JXTC tile-container encode overhead vs one-shot JXL)`);

  // JXTC per-file detail in TOON
  if (avgJxtcEncSimd > 0) {
    toonLines.push("", "# JXTC Encode Per-File (simd: JXL one-shot ms vs JXTC ms + KB + ratio)");
    for (let i = 0; i < loadedFiles.length; i++) {
      const sf = loadedFiles[i];
      const sr = simdResults[i] || {};
      const ratio = (sr.shot_enc_ms||0) > 0 && (sr.jxtc_enc_ms||0) > 0
        ? ((sr.jxtc_enc_ms||0) / (sr.shot_enc_ms||1)).toFixed(2) + "x"
        : "N/A";
      toonLines.push(`  ${sf.file}: JXL=${sr.shot_enc_ms||0}ms JXTC=${sr.jxtc_enc_ms||0}ms/${(sr.jxtc_kb||0).toFixed(0)}KB ratio=${ratio}`);
    }
  }

  // flip-flop avgs (medians of the stable interleaved samples)
  if (flipFlopResults && flipFlopResults.length) {
    const avgS = (k) => (flipFlopResults.reduce((sum, r) => sum + (r[k] || 0), 0) / flipFlopResults.length).toFixed(1);
    toonLines.push(`FlipProgSpdX: ${avgS('spd_prog')} | FlipFirstSpdX: ${avgS('spd_first')} | FlipFinalSpdX: ${avgS('spd_final')} | FlipShotSpdX: ${avgS('spd_shot')}`);
  }

  let toonString = toonLines.join("\n");

  console.log(`=========================================`);
  console.log(`📊 TOON RESULTS (Sequential, Parallel, Multi-Thread & Deep Diagnostics)`);
  console.log(`=========================================`);
  console.log(toonString);
  console.log(`=========================================\n`);

  // Write TOON file to output directory.
  // Use dynamic path from this script's location (avoids hardcoded absolute Windows paths
  // that can trigger extended-length prefix handling in Node/fs on deep dirs with spaces,
  // which previously broke some file:// launches for the aggregate graph HTML).
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const OUT_DIR = join(scriptDir, 'docs', 'outputs', 'timing tests');
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const stamp = runTimestamp.replace(/[:.]/g, "-");
  const fileName = `${stamp}-StandardMultifileTest-${batchName}.toon`;
  const outPath = join(OUT_DIR, fileName);

  // Append granular FFI encode timings dynamically before writing!
  const finalEnc = globalThis.finalEncMetrics || {};
  let ffiBlock = "\n# Granular Encoding FFI Sub-timers (ms)\n";
  ffiBlock += `EncInputPrepMs: ${finalEnc.enc_input_prep !== undefined ? finalEnc.enc_input_prep.toFixed(2) : 'N/A'}\n`;
  ffiBlock += `EncHeapMallocMs: ${finalEnc.enc_malloc !== undefined ? finalEnc.enc_malloc.toFixed(2) : 'N/A'}\n`;
  ffiBlock += `EncHeapCopyMs: ${finalEnc.enc_heap_set !== undefined ? finalEnc.enc_heap_set.toFixed(2) : 'N/A'}\n`;
  ffiBlock += `EncCoreCompressMs: ${finalEnc.enc_wasm_encode !== undefined ? finalEnc.enc_wasm_encode.toFixed(2) : 'N/A'}\n`;
  ffiBlock += `EncBufferReadMs: ${finalEnc.enc_buffer_read !== undefined ? finalEnc.enc_buffer_read.toFixed(2) : 'N/A'}\n`;
  ffiBlock += `EncHeapFreeMs: ${finalEnc.enc_free !== undefined ? finalEnc.enc_free.toFixed(2) : 'N/A'}\n\n`;
  
  toonString = toonString.replace("---", ffiBlock + "---");

  writeFileSync(outPath, toonString);
  console.log(`✅ TOON file successfully written to: ${outPath}\n`);

  const consolidation = consolidateBenchmarkHistory({
    timingDir: OUT_DIR,
    legacyRoots: [
      join(scriptDir, 'docs', 'Benchmark results'),
      join(OUT_DIR, "backup"),
    ],
    backupDirName: "backup",
  });
  const historicalRuns = consolidation.toonFiles
    .filter((name) => name.endsWith(".toon"))
    .filter((name) => !name.endsWith("GraphAggregateResults.toon"));
  const graphModel = buildGraphHistory(historicalRuns);
  const launchStatePath = join(OUT_DIR, ".graph-browser-launch-state.json");
  const launchSelection = getNextGraphBrowserLaunchMethod({
    statePath: launchStatePath,
    overrideMethodId: process.env.STANDARD_MULTIFILE_OPEN_GRAPH_METHOD || null,
  });
  const launchBadge = `${launchSelection.method.label} - ${launchSelection.method.description}`;
  const graphHtml = buildGraphAggregateHtml(graphModel, { launchBadge });
  const graphPath = join(OUT_DIR, "GraphAggregateResults.html");
  writeFileSync(graphPath, graphHtml);
  console.log(`✅ Graph aggregate HTML successfully written to: ${graphPath}\n`);
  console.log(`Graph launch method: ${launchBadge}`);

  if (process.env.STANDARD_MULTIFILE_OPEN_GRAPH !== "0") {
    try {
      if (process.platform === "win32") {
        const browser = chooseGraphBrowser({
          chromePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          edgePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          bravePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        });
        // Prefer direct-spawn (clean file:// URL + browser isolation flags) because explorer/cmd/rundll
        // often trigger "blocked" warnings or fail on large self-contained history HTMLs with inline JSON/JS.
        // This makes the graphs actually appear without security interstitials.
        let launchMethodId = "direct-spawn";
        if (!browser.path) {
          launchMethodId = launchSelection.method.id;  // fall back only if no browser binary found
        }
        const plan = buildGraphBrowserLaunchPlan({
          methodId: launchMethodId,
          browserPath: browser.path,
          filePath: graphPath,
        });
        if (plan.browserPath) {
          const child = spawn(plan.browserPath, plan.args, plan.options);
          child.unref();
        }
      } else if (process.platform === "darwin") {
        execSync(`open "${graphPath.replace(/"/g, '\\"')}"`, { stdio: "ignore" });
      } else {
        execSync(`xdg-open "${graphPath.replace(/"/g, '\\"')}"`, { stdio: "ignore" });
      }
      console.log(`✅ Graph aggregate HTML opened in browser.\n`);
    } catch (err) {
      console.log(`⚠️  Graph aggregate HTML could not be opened automatically.\n`);
    }
  }
}

// Hard-exit guard fires unconditionally — covers hangs in main() itself (e.g. nodeCtx.shutdown())
const _hardExitTimer = setTimeout(() => {
  console.error("\n⏱️  Hard-exit timeout — benchmark exceeded max runtime, forcing exit");
  process.exit(1);
}, 10 * 60 * 1000); // 10 minutes
_hardExitTimer.unref(); // don't keep event loop alive just for this timer

main().then(() => {
  clearTimeout(_hardExitTimer);
  // Force exit after a short grace period to flush output and close any residual WASM workers
  setTimeout(() => {
    console.log("\n⏱️  Force-exit timeout (all workers should be closed by now)");
    process.exit(0);
  }, 2000);
}).catch(err => {
  clearTimeout(_hardExitTimer);
  console.error("Benchmark failed:", err);
  setTimeout(() => process.exit(1), 500);
});
