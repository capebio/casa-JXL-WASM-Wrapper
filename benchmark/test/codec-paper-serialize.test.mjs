import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPaperToon } from "../codec-paper-serialize.mjs";

const sweep = [
  { image: "kodim01", class: "standard", codec: "jxl", runtime: "wasm", quality: 75, bytes: 1000, bpp: 0.5, butteraugli: 1.2, ssim: 0.99 },
  { image: "kodim01", class: "standard", codec: "jpeg_native", runtime: "native", quality: 75, bytes: 2000, bpp: 1.0, butteraugli: 1.4, ssim: 0.98 },
];
const fixed = [
  { image: "kodim01", class: "standard", codec: "jxl", runtime: "wasm", quality: 40, butteraugli: 1.5, bytes: 900, bpp: 0.45, enc_ms: 200, dec_ms: 100 },
];

test("emits sweep + fixed sections and codec-paper TestName", () => {
  const toon = buildPaperToon({ sweep, fixed, bdRates: { jpeg_native: 55.2 }, batchName: "general", runTimestamp: "2026-07-05T00:00:00.000Z" });
  assert.match(toon, /TestName: CodecPaper - general/);
  assert.match(toon, /# RD sweep/);
  assert.match(toon, /kodim01 \| standard \| jxl \| wasm \| 75 /);
  assert.match(toon, /# Fixed-quality point/);
  assert.match(toon, /BDRate_jpeg_native: 55.2/);
});
