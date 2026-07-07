// Parity tests for the JS mirror of the Rust RAW-decode memory model
// (`crates/raw-pipeline/src/mem_budget.rs`). The oracle is the Rust module's own
// documented worked numbers (its `#[test]` block + the S3 ADR table): if this
// port ever diverges from the Rust arithmetic, these fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateDecodePeak,
  estimateDecodePeakBytes,
  OUT_FULL_RGB8,
  OUT_LIGHTBOX,
  OUT_THUMB,
  OUT_FULL_16,
  OUT_NO_ORIENT,
  OUT_FULL_DISP16,
  OUT_BATCH_DEFAULT,
} from "../src/mem-budget.js";

// 24 MP reference frame, matching the Rust tests / ADR table.
const W = 6000;
const H = 4000;
const N = W * H; // 24_000_000

// Preview byte constants (6 B/px), derived exactly as the Rust `preview_pixels`:
//   lightbox  = 1800 × floor(4000·1800/6000)=1200  → 1800·1200 = 2_160_000 px
//   thumbnail =  360 × floor(4000·360/6000)  = 240  →  360· 240 =    86_400 px
const LB = 1800 * 1200 * 6; // 12_960_000
const THUMB = 360 * 240 * 6; //    518_400
const PREV = LB + THUMB; //     13_478_400

test("flag bits mirror the Rust OUT_* layout", () => {
  assert.equal(OUT_FULL_RGB8, 1);
  assert.equal(OUT_LIGHTBOX, 2);
  assert.equal(OUT_THUMB, 4);
  assert.equal(OUT_FULL_16, 8);
  assert.equal(OUT_NO_ORIENT, 16);
  assert.equal(OUT_FULL_DISP16, 32);
  assert.equal(OUT_BATCH_DEFAULT, OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB); // "7"
});

test("zero dims are zero", () => {
  const e = estimateDecodePeak(0, 0, 0xff);
  assert.equal(e.pixels, 0);
  assert.equal(e.retainedBytes, 0);
  assert.equal(e.peakBytes, 0);
});

test("no flags → no buffers materialized", () => {
  const e = estimateDecodePeak(W, H, 0);
  assert.equal(e.retainedBytes, 0);
  assert.equal(e.peakBytes, 0);
});

test("shipping flags 7 (RGB8|LB|THUMB): retained 3n+previews, peak 9n+previews", () => {
  const e = estimateDecodePeak(W, H, OUT_BATCH_DEFAULT);
  assert.equal(e.retainedBytes, N * 3 + PREV); // 85_478_400
  assert.equal(e.peakBytes, N * 9 + PREV); // 229_478_400 — render stage (6n+3n) dominates decode 8n
  assert.equal(estimateDecodePeakBytes(W, H, OUT_BATCH_DEFAULT), e.peakBytes);
});

test("all flags + assumed rotate → 21n render transient + previews", () => {
  const flags = OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB | OUT_FULL_16 | OUT_FULL_DISP16;
  const e = estimateDecodePeak(W, H, flags);
  assert.equal(e.peakBytes, N * 21 + PREV); // 517_478_400
});

test("OUT_NO_ORIENT sheds the rotate transient (21n → 15n)", () => {
  const withRotate = estimateDecodePeak(W, H, OUT_FULL_RGB8 | OUT_FULL_DISP16);
  const noRotate = estimateDecodePeak(W, H, OUT_FULL_RGB8 | OUT_FULL_DISP16 | OUT_NO_ORIENT);
  assert.equal(withRotate.peakBytes, N * 21); // no previews requested
  assert.equal(noRotate.peakBytes, N * 15);
  assert.ok(noRotate.peakBytes < withRotate.peakBytes);
});

test("preview-only (LB|THUMB): decode-stage bound 8n+previews, tiny retained", () => {
  const e = estimateDecodePeak(W, H, OUT_LIGHTBOX | OUT_THUMB);
  assert.equal(e.peakBytes, N * 8 + PREV); // 205_478_400
  assert.equal(e.retainedBytes, PREV);
});

test("peak never below retained across all flag combos", () => {
  for (let flags = 0; flags < 64; flags++) {
    for (const [w, h] of [
      [64, 48],
      [4000, 3000],
      [7728, 5368],
    ]) {
      const e = estimateDecodePeak(w, h, flags);
      assert.ok(
        e.peakBytes >= e.retainedBytes,
        `flags=${flags} ${w}x${h}: peak ${e.peakBytes} < retained ${e.retainedBytes}`,
      );
    }
  }
});

test("monotonic in pixels for a fixed flag set", () => {
  const small = estimateDecodePeakBytes(2000, 1500, OUT_BATCH_DEFAULT);
  const big = estimateDecodePeakBytes(6000, 4000, OUT_BATCH_DEFAULT);
  assert.ok(big > small);
});

test("preview projection never upsamples (lightbox native, thumb still downscales)", () => {
  // 800×600 is below the 1800 lightbox edge → lightbox stays native (no upsample);
  // the 360 thumb edge still downscales it. lb=800·600 px, thumb=360·270 px.
  const e = estimateDecodePeak(800, 600, OUT_LIGHTBOX | OUT_THUMB);
  const n = 800 * 600;
  const lb = 800 * 600 * 6; // native — proves no upsample past the source size
  const thumb = 360 * 270 * 6; // downscaled to the 360 long edge
  assert.equal(e.retainedBytes, lb + thumb);
  assert.equal(e.peakBytes, n * 8 + lb + thumb);
});

test("absurd dims saturate to a large finite value (no wrap)", () => {
  const e = estimateDecodePeak(0xffffffff, 0xffffffff, 0xff);
  assert.ok(e.peakBytes > 0);
  assert.ok(Number.isFinite(e.peakBytes));
  assert.equal(e.peakBytes, Number.MAX_SAFE_INTEGER);
  assert.ok(e.peakBytes >= e.retainedBytes);
});
