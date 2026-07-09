// Identical A/B flip-flop trust probe for the RAW->JXL baseline.
//
// Purpose: give per-file *trust* to the baseline-dump rows by running the SAME
// encode->decode roundtrip as two interleaved variants (A and B are byte-identical
// paths). Because A and B are identical, any median divergence is pure machine
// noise/thermal drift, so a tight A~=B agreement => trust:high. We also capture,
// per file: source-vs-decoded Butteraugli (RGBA8), an FNV-1a hash of the decoded
// RGBA (determinism check across flips), and process RSS around the work.
//
// Mirrors StandardMultifileTest.mjs load path exactly (root pkg/ WASM, TARGET=1920,
// PROCESS_ARGS, OUTPUT flags) and its `shot` encode params (rgba8, distance 1.0,
// effort 3, non-progressive).

import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";

// --- RAW pipeline WASM (root pkg/) : same imports the harness uses ---
import initRaw, {
  downscale_rgb,
  process_orf_with_flags,
  process_cr2_with_flags,
  process_dng_with_flags,
  rgb_to_rgba,
} from "../../pkg/raw_converter_wasm.js";

// --- libjxl facade (auto-loads correct core tier in Node; has butteraugli bridge) ---
const { createEncoder, createDecoder, computeButteraugli } = await import(
  "../../packages/jxl-wasm/dist/index.js"
);

await initRaw({
  module_or_path: readFileSync(new URL("../../pkg/raw_converter_wasm_bg.wasm", import.meta.url)),
});

// ---- constants copied verbatim from StandardMultifileTest.mjs ----
const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const GOB_ROOT = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const TIMING_SOURCE = String.raw`.timing-source`;
const TARGET = 1920;
const OUTPUT_FULL_RGB = 1 | 2 | 4;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

const FILES_CONFIG = [
  { name: "small_file.jpg", paths: [join(TEST_ROOT, "small_file.jpg")] },
  { name: "P1110226 windows.jpg", paths: [join(TEST_ROOT, "P1110226 windows.jpg")] },
  { name: "PXL_20260527_180319603.RAW-02.ORIGINAL.dng", paths: [
      join(TEST_ROOT, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng"),
      join(TIMING_SOURCE, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng"),
      String.raw`C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng`,
    ] },
  { name: "PXL_20260501_093507165.RAW-02.ORIGINAL.dng", paths: [
      join(TEST_ROOT, "PXL_20260501_093507165.RAW-02.ORIGINAL.dng"),
      String.raw`C:\Foo\raw-converter-wasm\.timing-source\PXL_20260501_093507165.RAW-02.ORIGINAL.dng`,
    ] },
  { name: "P1110226.ORF", paths: [join(TEST_ROOT, "P1110226.ORF")] },
  { name: "P2200474.ORF", paths: [join(GOB_ROOT, "P2200474.ORF")] },
  { name: "_MG_1750.CR2", paths: [join(TEST_ROOT, "_MG_1750.CR2")] },
  { name: "ADH 1248.CR2", paths: [join(TEST_ROOT, "ADH 1248.CR2")] },
];

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
function median(arr) {
  if (!arr || !arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}
// FNV-1a 32-bit over a byte view -> 8-hex-char string.
function fnv1a(view) {
  let h = 0x811c9dc5;
  for (let i = 0; i < view.length; i++) {
    h ^= view[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Load a file to RGBA8 at TARGET, exactly like the harness.
async function loadRgba(config) {
  let resolvedPath = null;
  for (const p of config.paths) { if (existsSync(p)) { resolvedPath = p; break; } }
  if (!resolvedPath) return null;
  const ext = extname(resolvedPath).toLowerCase();
  const raw = new Uint8Array(readFileSync(resolvedPath));
  let rgb, srcW, srcH;
  if (ext === ".jpg" || ext === ".jpeg") {
    const { data, info } = await sharp(resolvedPath).raw().toBuffer({ resolveWithObject: true });
    rgb = data; srcW = info.width; srcH = info.height;
  } else {
    const usePreview = (ext === ".orf" || ext === ".raw");
    const fl = usePreview ? OUTPUT_FULL_RGB : 1;
    let decoded;
    if (ext === ".orf" || ext === ".raw") decoded = process_orf_with_flags(raw, fl, ...PROCESS_ARGS);
    else if (ext === ".cr2") decoded = process_cr2_with_flags(raw, fl, ...PROCESS_ARGS);
    else if (ext === ".dng") decoded = process_dng_with_flags(raw, fl, ...PROCESS_ARGS);
    rgb = decoded.take_rgb(); srcW = decoded.width; srcH = decoded.height; decoded.free();
  }
  const longEdge = Math.max(srcW, srcH);
  const scale = longEdge > TARGET ? TARGET / longEdge : 1;
  const tgtW = Math.round(srcW * scale);
  const tgtH = Math.round(srcH * scale);
  const rgba = scale < 1 ? rgb_to_rgba(downscale_rgb(rgb, srcW, srcH, tgtW, tgtH)) : rgb_to_rgba(rgb);
  return { file: basename(resolvedPath), rgba, w: tgtW, h: tgtH };
}

// One shot-tier encode->decode roundtrip; returns {ms, hash, decoded}.
async function roundtrip(rgba, w, h) {
  const t0 = performance.now();
  const encoder = createEncoder({
    format: "rgba8", width: w, height: h, hasAlpha: true,
    iccProfile: null, exif: null, xmp: null,
    distance: 1.0, quality: 85, effort: 3,
    progressive: false, progressiveFlavor: "ac", previewFirst: false, chunked: true,
  });
  const chunks = [];
  const chunkTask = (async () => {
    for await (const c of encoder.chunks()) chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c));
  })();
  await encoder.pushPixels(exactBuffer(rgba));
  await encoder.finish();
  await chunkTask;
  await encoder.dispose();
  const jxl = concatChunks(chunks);

  const decoder = createDecoder({
    format: "rgba8", progressionTarget: "final", emitEveryPass: false,
    progressiveDetail: "none", downsample: 1, preserveIcc: false, preserveMetadata: false, region: null,
  });
  let decoded = null;
  const evTask = (async () => {
    for await (const ev of decoder.events()) {
      if ((ev.type === "progress" || ev.type === "final") && ev.pixels) decoded = ev.pixels;
      else if (ev.type === "error") throw new Error(`${ev.code}: ${ev.message}`);
    }
  })();
  await decoder.push(exactBuffer(jxl));
  await decoder.close();
  await evTask;
  try { await decoder.dispose(); } catch {}
  const ms = performance.now() - t0;
  const dv = decoded instanceof Uint8Array ? decoded : new Uint8Array(decoded);
  return { ms, hash: fnv1a(dv), decoded: dv };
}

const ROUNDS = Number(process.env.AB_ROUNDS ?? 7);
// Median-agreement tolerance for A vs B (identical variants): rel gap under this => trust high.
const TRUST_REL = Number(process.env.AB_TRUST_REL ?? 0.15);

async function main() {
  const loaded = [];
  for (const c of FILES_CONFIG) {
    const l = await loadRgba(c);
    if (l) loaded.push(l);
    else console.error(`skip (missing): ${c.name}`);
  }

  const rows = [];
  let rssPeak = process.memoryUsage().rss;
  for (const { file, rgba, w, h } of loaded) {
    const aTimes = [], bTimes = [];
    const hashes = new Set();
    let butter = null;
    for (let r = 0; r < ROUNDS; r++) {
      // Start-rotation: alternate which variant runs first each round (cancels drift).
      const order = r % 2 === 0 ? ["A", "B"] : ["B", "A"];
      for (const variant of order) {
        const res = await roundtrip(rgba, w, h);
        (variant === "A" ? aTimes : bTimes).push(res.ms);
        hashes.add(res.hash);
        // Compute Butteraugli once (src RGBA vs decoded RGBA) from a stable roundtrip.
        if (butter === null) {
          try { butter = await computeButteraugli(rgba, res.decoded, w, h); }
          catch (e) { butter = `ERR:${e.message}`; }
        }
        const rss = process.memoryUsage().rss;
        if (rss > rssPeak) rssPeak = rss;
      }
    }
    const medA = median(aTimes), medB = median(bTimes);
    const relGap = Math.abs(medA - medB) / Math.max(1, Math.min(medA, medB));
    const deterministic = hashes.size === 1;
    const trust = (relGap <= TRUST_REL && deterministic) ? "high" : "low";
    rows.push({
      file, w, h,
      median_ms: Math.round((median([...aTimes, ...bTimes])) * 10) / 10,
      ab_median_a: Math.round(medA * 10) / 10,
      ab_median_b: Math.round(medB * 10) / 10,
      ab_rel_gap: Math.round(relGap * 1000) / 1000,
      butteraugli: typeof butter === "number" ? Math.round(butter * 10000) / 10000 : butter,
      rgba_hash: [...hashes][0],
      rgba_hash_count: hashes.size,
      deterministic,
      rss_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      trust,
    });
    console.error(`  ${file}: A=${medA.toFixed(1)} B=${medB.toFixed(1)} relgap=${relGap.toFixed(3)} ba=${typeof butter==="number"?butter.toFixed(4):butter} hash=${[...hashes][0]}(${hashes.size}) trust=${trust}`);
  }

  const out = {
    schema: "ab-trust-probe/v1",
    rounds: ROUNDS,
    trust_rel_tolerance: TRUST_REL,
    rss_peak_mb: Math.round(rssPeak / (1024 * 1024)),
    files: rows,
  };
  process.stdout.write(JSON.stringify(out));
}

await main();
