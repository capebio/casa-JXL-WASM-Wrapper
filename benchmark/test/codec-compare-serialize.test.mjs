import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodecToon } from "../codec-compare-serialize.mjs";

const rows = [
  { file: "a.jpg", codec: "jxl",         runtime: "wasm",   quality: null, target_butter: 1.2, achieved_butter: 1.2, converged: true, ssim: 0.99, enc_ms: 100, dec_ms: 50, ttfp_ms: 20, ttfp_kind: "progressive", bytes: 1000, bpp: 1.0 },
  { file: "a.jpg", codec: "jpeg_native", runtime: "native", quality: 88,   target_butter: 1.2, achieved_butter: 1.25, converged: true, ssim: 0.98, enc_ms: 5,  dec_ms: 3,  ttfp_ms: 3,  ttfp_kind: "full", bytes: 1500, bpp: 1.5 },
];

test("emits header, caveat, rows, and namespaced aggregates + fps", () => {
  const toon = buildCodecToon({ rows, batchName: "general", runTimestamp: "2026-07-04T20:00:00.000Z", target: 1920 });
  assert.match(toon, /TestName: CodecCompare - general/);
  assert.match(toon, /# CAVEAT:.*NOT COMPARABLE ACROSS RUNTIMES/);
  assert.match(toon, /rows\[2\]\{file\|codec\|runtime\|/);
  assert.match(toon, /a\.jpg \| jpeg_native \| native \| 88 /);
  // size-vs-jxl ratio for jpeg_native = 1500/1000 = 1.5
  assert.match(toon, /Avg_jpeg_native_SizeVsJxlRatio: 1\.50/);
  // fps overlay = 1000/dec_ms ; jpeg_native dec 3ms -> 333
  assert.match(toon, /Avg_jpeg_native_DecFps: 333/);
});
