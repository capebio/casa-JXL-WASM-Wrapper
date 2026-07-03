// Encode-only flip-flop: JXL with Butteraugli vs disablePerceptualHeuristics (PSD path).
//
// No decode. Measures how much butteraugli contributes to JXL encode latency.
//
// Arm A — Butteraugli ON : standard encode (quality-guided perceptual heuristics)
// Arm B — PSD path (no-butter) : disablePerceptualHeuristics=true (AQ runs without
//          butteraugli masking; caller can validate quality externally via PSD).
//
// Usage:
//   node tools/enc-butteraugli-flip.mjs [reps=12] [effort=3] [distance=1.0]
//
// Output: per-file medians + aggregate, same style as fable-wasm-flip.mjs.

import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker as NodeWorker } from "node:worker_threads";
import sharp from "sharp";

// ── Browser-like Worker shim (required by jxl-session scheduler) ──
class BrowserLikeWorker {
  #worker; #onmessage = null; #onerror = null;
  constructor(url, options = {}) {
    const workerUrl = url instanceof URL ? url.href : String(url);
    this.#worker = new NodeWorker(
      new URL("../jxl-worker-shim.mjs", import.meta.url),
      { workerData: { url: workerUrl, name: options.name ?? "" } }
    );
    this.#worker.on("message", (data) => this.#onmessage?.({ data }));
    this.#worker.on("error",   (error) => this.#onerror?.(error));
  }
  postMessage(message, transfer) { this.#worker.postMessage(message, transfer); }
  terminate() { return this.#worker.terminate(); }
  set onmessage(h) { this.#onmessage = h; }
  get onmessage() { return this.#onmessage; }
  set onerror(h) { this.#onerror = h; }
  get onerror() { return this.#onerror; }
}
globalThis.Worker = BrowserLikeWorker;

// ── RAW WASM ──
import initRaw, {
  downscale_rgb,
  process_orf_with_flags,
  process_cr2_with_flags,
  process_dng_with_flags,
  rgb_to_rgba,
} from "../pkg/raw_converter_wasm.js";

const { createEncoder, setForcedTier } =
  await import("../packages/jxl-wasm/dist/index.js");

await initRaw({
  module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)),
});

// ── CLI args ──
const reps     = Number(process.argv[2] ?? 12);
const effort   = Number(process.argv[3] ?? 3);
const distance = Number(process.argv[4] ?? 1.0);

// ── Test files (same set as StandardMultifileTest.mjs) ──
const TEST_ROOT  = String.raw`C:\Foo\raw-converter\tests`;
const GOB_ROOT   = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const SRC_ROOT   = String.raw`C:\Foo\raw-converter-wasm\.timing-source`;
const TARGET     = 1920;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const FILES_CONFIG = [
  { name: "small_file.jpg",                 paths: [join(TEST_ROOT, "small_file.jpg")] },
  { name: "P1110226 windows.jpg",           paths: [join(TEST_ROOT, "P1110226 windows.jpg")] },
  { name: "PXL_20260527.dng",               paths: [join(TEST_ROOT, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng"), join(SRC_ROOT, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng")] },
  { name: "PXL_20260501.dng",               paths: [join(TEST_ROOT, "PXL_20260501_093507165.RAW-02.ORIGINAL.dng"), join(SRC_ROOT, "PXL_20260501_093507165.RAW-02.ORIGINAL.dng")] },
  { name: "P1110226.ORF",                   paths: [join(TEST_ROOT, "P1110226.ORF")] },
  { name: "P2200474.ORF",                   paths: [join(GOB_ROOT, "P2200474.ORF")] },
  { name: "_MG_1750.CR2",                   paths: [join(TEST_ROOT, "_MG_1750.CR2")] },
  { name: "ADH 1248.CR2",                   paths: [join(TEST_ROOT, "ADH 1248.CR2")] },
];

// ── Helpers ──
function exactBuffer(v) {
  if (v instanceof ArrayBuffer) return v;
  if (v.byteOffset === 0 && v.byteLength === v.buffer.byteLength) return v.buffer;
  return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
}

function med(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return { min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
}

// Single timed JXL encode, no decode.
async function encodeOnce(rgba, w, h, disablePerceptual) {
  const encoder = createEncoder({
    format: "rgba8", width: w, height: h, hasAlpha: true,
    iccProfile: null, exif: null, xmp: null,
    distance, effort,
    progressive: false, progressiveFlavor: "ac", previewFirst: false,
    chunked: true,
    ...(disablePerceptual ? { disablePerceptualHeuristics: true } : {}),
  });
  const chunks = [];
  const chunkTask = (async () => {
    for await (const chunk of encoder.chunks())
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  })();
  const t0 = performance.now();
  await encoder.pushPixels(exactBuffer(rgba));
  await encoder.finish();
  await chunkTask;
  const ms = performance.now() - t0;
  await encoder.dispose();
  const totalBytes = chunks.reduce((s, c) => s + c.byteLength, 0);
  return { ms, bytes: totalBytes };
}

// ── 1. Pre-load & scale all files (setup, not timed in flip-flop) ──
console.log(`enc-butteraugli-flip  reps=${reps}  effort=${effort}  distance=${distance}`);
console.log(`\n[setup] pre-loading ${FILES_CONFIG.length} files…`);

const loaded = [];
for (const cfg of FILES_CONFIG) {
  const path = cfg.paths.find(p => existsSync(p));
  if (!path) { console.warn(`  skip ${cfg.name} (not found)`); continue; }

  const ext  = extname(path).toLowerCase();
  const raw  = new Uint8Array(readFileSync(path));
  let rgb, srcW, srcH;

  const t0 = performance.now();
  if (ext === ".jpg" || ext === ".jpeg") {
    const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    rgb = data; srcW = info.width; srcH = info.height;
  } else {
    let dec;
    if (ext === ".orf" || ext === ".raw") dec = process_orf_with_flags(raw, 1, ...PROCESS_ARGS);
    else if (ext === ".cr2")              dec = process_cr2_with_flags(raw, 1, ...PROCESS_ARGS);
    else if (ext === ".dng")              dec = process_dng_with_flags(raw, 1, ...PROCESS_ARGS);
    else { console.warn(`  skip ${cfg.name} (unknown ext ${ext})`); continue; }
    rgb = dec.take_rgb(); srcW = dec.width; srcH = dec.height; dec.free();
  }

  const scale = Math.max(srcW, srcH) > TARGET ? TARGET / Math.max(srcW, srcH) : 1;
  const tgtW  = Math.round(srcW * scale);
  const tgtH  = Math.round(srcH * scale);
  const rgba  = scale < 1 ? rgb_to_rgba(downscale_rgb(rgb, srcW, srcH, tgtW, tgtH))
                           : rgb_to_rgba(rgb);
  const setupMs = Math.round(performance.now() - t0);

  console.log(`  ${cfg.name}: ${tgtW}×${tgtH}  setup=${setupMs}ms`);
  loaded.push({ name: cfg.name, rgba, w: tgtW, h: tgtH });
}

if (!loaded.length) { console.error("No files loaded — aborting."); process.exit(1); }
console.log(`  ${loaded.length} files ready.\n`);

// ── 2. Warmup (2 encodes per arm per file, results discarded) ──
setForcedTier("simd");
console.log(`[warmup] 2 rounds each arm…`);
for (let r = 0; r < 2; r++) {
  for (const f of loaded) {
    await encodeOnce(f.rgba, f.w, f.h, false);  // A
    await encodeOnce(f.rgba, f.w, f.h, true);   // B
  }
}
console.log(`  warmup done.\n`);

// ── 3. Interleaved flip-flop ──
// Pattern: A,B,B,A,B,A,A,B  (same as fable-wasm-flip.mjs — drift-resistant)
const PATTERN = ["A", "B", "B", "A", "B", "A", "A", "B"];
const perFile = {};
for (const f of loaded) perFile[f.name] = { A: [], B: [] };

console.log(`[flip-flop] ${reps} rounds (${loaded.length} files × 2 arms)…`);
for (let r = 0; r < reps; r++) {
  const arm = PATTERN[r % PATTERN.length];
  const disablePerceptual = arm === "B";
  for (const f of loaded) {
    const { ms, bytes } = await encodeOnce(f.rgba, f.w, f.h, disablePerceptual);
    perFile[f.name][arm].push({ ms, bytes });
  }
  if ((r + 1) % 4 === 0) process.stdout.write(`  round ${r + 1}/${reps}\n`);
}

// ── 4. Results ──
console.log(`\n${"─".repeat(80)}`);
console.log(`RESULTS  Arm A = butteraugli (default)   Arm B = disablePerceptualHeuristics`);
console.log(`${"─".repeat(80)}`);
console.log(
  `${"file".padEnd(24)} ${"A-med(ms)".padStart(10)} ${"A-min".padStart(8)} ${"B-med(ms)".padStart(10)} ${"B-min".padStart(8)} ${"speedup".padStart(9)} ${"B-kb".padStart(8)}`
);
console.log("─".repeat(80));

let sumA = 0, sumB = 0;
for (const f of loaded) {
  const sa = stats(perFile[f.name].A.map(x => x.ms));
  const sb = stats(perFile[f.name].B.map(x => x.ms));
  const speedup = sa.med / sb.med;
  const bKb = (med(perFile[f.name].B.map(x => x.bytes)) / 1024).toFixed(1);
  const aKb = (med(perFile[f.name].A.map(x => x.bytes)) / 1024).toFixed(1);
  sumA += sa.med;
  sumB += sb.med;
  console.log(
    `${f.name.padEnd(24)} ${sa.med.toFixed(0).padStart(10)} ${sa.min.toFixed(0).padStart(8)}` +
    ` ${sb.med.toFixed(0).padStart(10)} ${sb.min.toFixed(0).padStart(8)}` +
    ` ${(speedup.toFixed(2) + "×").padStart(9)} ${(bKb + "KB").padStart(8)}` +
    `  (A: ${aKb}KB)`
  );
}

console.log("─".repeat(80));
const avgSpeedup = sumA / sumB;
console.log(`${"AVERAGE".padEnd(24)} ${(sumA / loaded.length).toFixed(0).padStart(10)} ${"".padStart(8)} ${(sumB / loaded.length).toFixed(0).padStart(10)} ${"".padStart(8)} ${(avgSpeedup.toFixed(2) + "×").padStart(9)}`);
console.log(`\nArm B is ${avgSpeedup >= 1 ? (avgSpeedup.toFixed(2) + "× faster") : (1/avgSpeedup).toFixed(2) + "× slower"} than Arm A (butteraugli disabled = PSD path).`);
console.log(`Note: Arm B output quality not validated here — use PSD externally.`);
