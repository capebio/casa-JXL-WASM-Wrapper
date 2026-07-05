/**
 * probe-16bit-disp.mjs
 *
 * Verifies the OUT_FULL_DISP16=32 path end-to-end:
 *   take_rgb16_disp(), disp16_w/h, downscale_rgb16_pub(), rgb16_to_rgba16()
 *
 * Run:
 *   node tools/probe-16bit-disp.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";

// ── pkg load ─────────────────────────────────────────────────────────────────
// Mirror the exact pattern from benchmark/codec-compare-jxl.mjs lines 6-11.
const raw = await import("../pkg/raw_converter_wasm.js");
await raw.default({
  module_or_path: readFileSync(
    new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)
  ),
});

// ── constants ─────────────────────────────────────────────────────────────────
const OUT_FULL_RGB8    = 1;
const OUT_FULL_DISP16  = 32;
const TARGET_LONG_EDGE = 1920;

// Verbatim from benchmark/codec-compare-jxl.mjs line 15
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];

// ── RAW file candidates ───────────────────────────────────────────────────────
const CANDIDATES = [
  "C:\\Foo\\raw-converter\\tests\\P1110226.ORF",
  "C:\\995\\2026-02-20 Gobabeb To Windhoek\\P2200474.ORF",
  "C:\\Foo\\raw-converter\\tests\\_MG_1750.CR2",
  "C:\\Foo\\raw-converter\\tests\\ADH 1248.CR2",
  "C:\\Foo\\raw-converter\\tests\\PXL_20260527_180319603.RAW-02.ORIGINAL.dng",
];

const rawPath = CANDIDATES.find((p) => existsSync(p));
if (!rawPath) {
  console.warn("SKIP: no candidate RAW file found on disk — cannot verify");
  process.exit(0);
}
console.log(`Using: ${rawPath}`);

// ── dispatch helper ───────────────────────────────────────────────────────────
function decode(bytes, flag) {
  const ext = extname(rawPath).toLowerCase();
  if (ext === ".orf" || ext === ".raw") {
    return raw.process_orf_with_flags(bytes, flag, ...PROCESS_ARGS);
  } else if (ext === ".cr2") {
    return raw.process_cr2_with_flags(bytes, flag, ...PROCESS_ARGS);
  } else if (ext === ".dng") {
    return raw.process_dng_with_flags(bytes, flag, ...PROCESS_ARGS);
  } else {
    throw new Error(`Unsupported extension: ${ext}`);
  }
}

// ── assert helper ─────────────────────────────────────────────────────────────
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// ── load file bytes ───────────────────────────────────────────────────────────
const fileBytes = new Uint8Array(readFileSync(rawPath));

// ── Decode 1: 8-bit RGB (flag = OUT_FULL_RGB8 = 1) ───────────────────────────
const res8 = decode(fileBytes, OUT_FULL_RGB8);
const rgb8 = res8.take_rgb();   // Uint8Array
const width = res8.width;
const height = res8.height;
res8.free();
assert(rgb8 instanceof Uint8Array, `take_rgb() should return Uint8Array, got ${rgb8?.constructor?.name}`);
assert(rgb8.length === width * height * 3, `rgb8.length mismatch: ${rgb8.length} !== ${width}*${height}*3=${width*height*3}`);
console.log(`8-bit decode: ${width}x${height}`);

// ── Decode 2: 16-bit display-referred (flag = OUT_FULL_DISP16 = 32) ──────────
const res16 = decode(fileBytes, OUT_FULL_DISP16);
const rgb16   = res16.take_rgb16_disp();  // should be Uint16Array
const disp16_w = res16.disp16_w;
const disp16_h = res16.disp16_h;
res16.free();

// Assert 1: type
assert(rgb16 instanceof Uint16Array, `take_rgb16_disp() should return Uint16Array, got ${rgb16?.constructor?.name}`);
// Assert 2: length
assert(
  rgb16.length === disp16_w * disp16_h * 3,
  `rgb16.length ${rgb16.length} !== disp16_w*disp16_h*3 = ${disp16_w*disp16_h*3}`
);
// Assert 3: dims match 8-bit
assert(
  disp16_w === width && disp16_h === height,
  `disp16 dims ${disp16_w}x${disp16_h} differ from 8-bit ${width}x${height}`
);
// Assert 4: full-range (max sample > 255<<8 = 65280, proving not 8-bit-shifted)
let maxSample = 0;
for (let i = 0; i < rgb16.length; i++) {
  if (rgb16[i] > maxSample) maxSample = rgb16[i];
}
assert(
  maxSample > (255 << 8),
  `max sample ${maxSample} <= ${255 << 8}; looks like 8-bit-shifted data, not true 16-bit`
);

// Assert 5: 8-bit consistency: (rgb16[i] >> 8) within ±1 of rgb8[i] for ≥98% of samples
let badCount = 0;
const totalSamples = rgb8.length;
for (let i = 0; i < totalSamples; i++) {
  if (Math.abs((rgb16[i] >> 8) - rgb8[i]) > 1) badCount++;
}
const badFrac = badCount / totalSamples;
console.log(`8-bit consistency bad-frac: ${(badFrac * 100).toFixed(4)}%`);
assert(
  badFrac <= 0.02,
  `8-bit consistency bad-frac ${(badFrac * 100).toFixed(4)}% > 2% threshold`
);

// ── Downscale + RGBA pack ────────────────────────────────────────────────────
const tw = width >= height ? 1920 : Math.round(width * 1920 / height);
const th = width >= height ? Math.round(height * 1920 / width) : 1920;
const downscaled = raw.downscale_rgb16_pub(rgb16, disp16_w, disp16_h, tw, th);
assert(
  downscaled instanceof Uint16Array,
  `downscale_rgb16_pub should return Uint16Array, got ${downscaled?.constructor?.name}`
);
assert(
  downscaled.length === tw * th * 3,
  `downscaled.length ${downscaled.length} !== tw*th*3 = ${tw*th*3}`
);

const rgba16 = raw.rgb16_to_rgba16(downscaled);
assert(
  rgba16 instanceof Uint16Array,
  `rgb16_to_rgba16 should return Uint16Array, got ${rgba16?.constructor?.name}`
);
assert(rgba16.length === tw * th * 4, `rgba16.length ${rgba16.length} !== tw*th*4 = ${tw*th*4}`);
assert(rgba16[3] === 0xFFFF, `rgba16[3] alpha should be 0xFFFF, got ${rgba16[3]}`);

console.log(
  `OK 16-bit disp: ${width}x${height} -> ${tw}x${th}, max=${maxSample}, consistency bad-frac=${(badFrac * 100).toFixed(4)}%`
);
