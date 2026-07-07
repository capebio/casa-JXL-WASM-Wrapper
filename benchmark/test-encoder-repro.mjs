import { execSync } from 'child_process';
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";

import initRaw, {
  downscale_rgb,
  process_orf_with_flags,
  rgb_to_rgba,
} from "./pkg/raw_converter_wasm.js";

const {
  createEncoder,
  setForcedTier,
} = await import("./packages/jxl-wasm/dist/index.js");

await initRaw({ module_or_path: readFileSync(new URL("./pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });

const TARGET = 1920;
const OUTPUT_FULL_RGB = 1 | 2 | 4;
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

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

async function encodeJxl(rgba, width, height, name) {
  const encoder = createEncoder({
    format: "rgba8", width, height, hasAlpha: true,
    iccProfile: null, exif: null, xmp: null,
    distance: 1.0, quality: 85, effort: 3,
    progressive: true, progressiveFlavor: "ac", previewFirst: false,
    chunked: true,
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
  const result = concatChunks(chunks);
  const chunkInfo = chunks.map(c => c.byteLength).join('+');
  console.log(`[${name}] ${result.byteLength}B (chunks: ${chunkInfo})`);
  return { bytes: result, ms };
}

// Load P1110226.ORF
const orfPath = "C:\\Foo\\raw-converter\\tests\\P1110226.ORF";
if (!existsSync(orfPath)) {
  console.error("Missing P1110226.ORF");
  process.exit(1);
}

const raw = new Uint8Array(readFileSync(orfPath));
const decoded = process_orf_with_flags(raw, OUTPUT_FULL_RGB, ...PROCESS_ARGS);
const rgb = decoded.take_rgb();
const srcW = decoded.width;
const srcH = decoded.height;
decoded.free();

// Scale to target
const longEdge = Math.max(srcW, srcH);
const scale = longEdge > TARGET ? TARGET / longEdge : 1;
const tgtW = Math.round(srcW * scale);
const tgtH = Math.round(srcH * scale);
const rgba = scale < 1 ? rgb_to_rgba(downscale_rgb(rgb, srcW, srcH, tgtW, tgtH)) : rgb_to_rgba(rgb);

console.log(`\nTesting ${srcW}x${srcH} → ${tgtW}x${tgtH} P1110226.ORF (${rgba.byteLength} pixels)`);
console.log("=".repeat(80));

// Test with simd tier - encode same file 20 times
setForcedTier("simd");
console.log("\n--- SIMD TIER (20 encodes) ---");
for (let i = 0; i < 20; i++) {
  try {
    await encodeJxl(rgba, tgtW, tgtH, `encode ${i+1}`);
  } catch (e) {
    console.error(`❌ Encode ${i+1} failed:`, e.message);
    break;
  }
}

console.log("\nDone. Look for pattern when output size drops.");
