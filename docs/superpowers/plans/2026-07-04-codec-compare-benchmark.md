# Codec-Compare Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `CodecCompareTest.mjs` — a benchmark that encodes the 8 standard files (post-raw-pipeline RGBA @1920) through our WASM JXL plus sharp-native (JPEG/WebP/AVIF/PNG) and @jsquash-WASM (mozjpeg/webp/avif) codecs, tuned to match our JXL's per-file butteraugli, reporting size/encode/decode/TTFP/quality/FPS into a new `codec-compare` toon family.

**Architecture:** Three focused modules — `benchmark/codec-adapters.mjs` (uniform `{encode,decode,search}` interface per codec, the only place codec-specific API lives), `benchmark/butteraugli-search.mjs` (pure binary-search logic, codec-injected), and `CodecCompareTest.mjs` (orchestrator: load RGBA → anchor → search → timed measure → serialize toon). Registry gets an additive `codec-compare` family branch.

**Tech Stack:** Node ESM, `sharp` 0.35 (native libvips), `@jsquash/{jpeg,webp,avif}` (WASM), our `pkg/raw_converter_wasm.js` (`PerceptualComparer`, RAW loaders), `packages/jxl-wasm/dist` facade (`createEncoder`/`createDecoder`). Tests via `node --test`.

**Spec:** `docs/superpowers/specs/2026-07-04-codec-compare-benchmark-design.md`

**Constraint:** Do NOT modify `StandardMultifileTest.mjs` or the `standard-multifile` family.

---

## Task 1: Install deps + probe codec APIs

**Files:**
- Modify: `package.json` (devDependencies)
- Create: `benchmark/probe-codecs.mjs` (throwaway probe, deleted in Step 5)

- [ ] **Step 1: Install the three WASM codec packages**

Run:
```bash
bun add -d @jsquash/jpeg @jsquash/webp @jsquash/avif
```
Expected: all three appear under `node_modules/@jsquash/` and in `package.json` devDependencies.

- [ ] **Step 2: Write a probe that round-trips each codec + confirms the quality option key**

Create `benchmark/probe-codecs.mjs`:
```js
import jpegEnc from "@jsquash/jpeg/encode.js";
import jpegDec from "@jsquash/jpeg/decode.js";
import webpEnc from "@jsquash/webp/encode.js";
import webpDec from "@jsquash/webp/decode.js";
import avifEnc from "@jsquash/avif/encode.js";
import avifDec from "@jsquash/avif/decode.js";
import sharp from "sharp";

const w = 64, h = 64;
const data = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < data.length; i += 4) { data[i] = 100; data[i+1] = 150; data[i+2] = 200; data[i+3] = 255; }
const img = { data, width: w, height: h };

for (const [name, enc, dec, opts] of [
  ["jpeg_wasm", jpegEnc, jpegDec, { quality: 50 }],
  ["webp_wasm", webpEnc, webpDec, { quality: 50 }],
  ["avif_wasm", avifEnc, avifDec, { quality: 50 }],
]) {
  const buf = await enc(img, opts);
  const back = await dec(buf);
  console.log(name, "enc bytes", buf.byteLength, "dec", back.width + "x" + back.height, "ch", back.data.length / (back.width * back.height));
}
const sBuf = await sharp(Buffer.from(data), { raw: { width: w, height: h, channels: 4 } }).jpeg({ quality: 50 }).toBuffer();
const sBack = await sharp(sBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
console.log("sharp jpeg", sBuf.length, "dec", sBack.info.width + "x" + sBack.info.height, "ch", sBack.info.channels);
```

- [ ] **Step 3: Run the probe**

Run: `node benchmark/probe-codecs.mjs`
Expected: each line prints non-zero enc bytes, `64x64`, `ch 4`. If any `@jsquash` codec rejects `{quality}`, open that package's `meta.d.ts` and use the correct key (record it in a comment). If a codec needs explicit `init()`, note it.

- [ ] **Step 4: Record confirmed option keys**

In a comment block at the top of `benchmark/probe-codecs.mjs`, write the confirmed quality-option key per codec (e.g. `// jpeg_wasm: {quality:1-100}; webp_wasm: {quality:0-100}; avif_wasm: {quality:0-100}`). These feed Task 3.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock* benchmark/probe-codecs.mjs
git commit -m "chore(codec-compare): add jsquash deps + codec API probe"
```

---

## Task 2: Butteraugli search loop (pure logic, TDD)

**Files:**
- Create: `benchmark/butteraugli-search.mjs`
- Test: `benchmark/test/butteraugli-search.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `benchmark/test/butteraugli-search.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchQuality } from "../butteraugli-search.mjs";

// Synthetic codec: higher quality => lower butteraugli, monotonic.
// butter(q) = 6 - q/20  (q=20 -> 5.0, q=100 -> 1.0)
const fakeMeasure = async (q) => 6 - q / 20;

test("hits target within tolerance", async () => {
  const r = await searchQuality({ measure: fakeMeasure, target: 2.0, tol: 0.15, qMin: 1, qMax: 100, maxIters: 8 });
  assert.ok(Math.abs(r.achieved - 2.0) <= 0.15, `achieved ${r.achieved}`);
  assert.ok(r.quality >= 1 && r.quality <= 100);
  assert.equal(r.converged, true);
  assert.ok(r.iters <= 8);
});

test("keeps closest when not converged in budget", async () => {
  const r = await searchQuality({ measure: fakeMeasure, target: 2.0, tol: 0.0001, qMin: 1, qMax: 100, maxIters: 3 });
  assert.equal(r.converged, false);
  assert.ok(r.achieved != null && r.quality != null);
});

test("clamps target below achievable floor", async () => {
  const r = await searchQuality({ measure: fakeMeasure, target: 0.5, tol: 0.15, qMin: 1, qMax: 100, maxIters: 8 });
  assert.equal(r.quality, 100); // best it can do
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test benchmark/test/butteraugli-search.test.mjs`
Expected: FAIL — `searchQuality` is not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

Create `benchmark/butteraugli-search.mjs`:
```js
// Binary-search a codec quality knob to hit a target butteraugli distance.
// Assumes butteraugli decreases monotonically as quality increases.
// `measure(q)` -> Promise<number> (butteraugli of encode@q vs source).
export async function searchQuality({ measure, target, tol = 0.15, qMin = 1, qMax = 100, maxIters = 8 }) {
  let lo = qMin, hi = qMax;
  let best = null; // { quality, achieved, dist }
  let iters = 0;
  const consider = (q, achieved) => {
    const dist = Math.abs(achieved - target);
    if (!best || dist < best.dist) best = { quality: q, achieved, dist };
  };
  // Probe endpoints first so out-of-range targets clamp correctly.
  const aHi = await measure(qMax); iters++; consider(qMax, aHi);
  if (aHi > target) { // even max quality can't reach target (target too low/strict)
    return { quality: qMax, achieved: aHi, converged: aHi - target <= tol, iters };
  }
  const aLo = await measure(qMin); iters++; consider(qMin, aLo);
  if (aLo < target) { // even min quality overshoots (target too lenient)
    return { quality: qMin, achieved: aLo, converged: target - aLo <= tol, iters };
  }
  while (iters < maxIters) {
    const mid = Math.round((lo + hi) / 2);
    const a = await measure(mid); iters++;
    consider(mid, a);
    if (Math.abs(a - target) <= tol) return { quality: mid, achieved: a, converged: true, iters };
    if (a > target) lo = mid; else hi = mid; // a>target => need more quality => raise lo
    if (hi - lo <= 1) break;
  }
  return { quality: best.quality, achieved: best.achieved, converged: best.dist <= tol, iters };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test benchmark/test/butteraugli-search.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmark/butteraugli-search.mjs benchmark/test/butteraugli-search.test.mjs
git commit -m "feat(codec-compare): butteraugli quality-search loop + tests"
```

---

## Task 3: Codec adapters (uniform interface)

**Files:**
- Create: `benchmark/codec-adapters.mjs`
- Test: `benchmark/test/codec-adapters.test.mjs`

Each adapter exposes `{ key, runtime, lossless?, encode(rgba,w,h,quality)->Promise<Uint8Array>, decode(bytes)->Promise<{data,width,height}> }`. `rgba` is a `Uint8Array` (4ch). Decoded `data` is a `Uint8Array`/`Uint8ClampedArray` (4ch).

- [ ] **Step 1: Write the failing test**

Create `benchmark/test/codec-adapters.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS } from "../codec-adapters.mjs";

const w = 48, h = 48;
const rgba = new Uint8Array(w * h * 4);
for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 80; rgba[i+1] = 160; rgba[i+2] = 40; rgba[i+3] = 255; }

test("every non-jxl adapter round-trips rgba at correct dims + 4ch", async () => {
  for (const a of ADAPTERS.filter(x => x.key !== "jxl")) {
    const q = a.lossless ? undefined : 60;
    const bytes = await a.encode(rgba, w, h, q);
    assert.ok(bytes.length > 0, `${a.key} produced empty output`);
    const back = await a.decode(bytes);
    assert.equal(back.width, w, `${a.key} width`);
    assert.equal(back.height, h, `${a.key} height`);
    assert.equal(back.data.length, w * h * 4, `${a.key} channels`);
  }
});

test("adapter keys are unique and runtime-tagged", () => {
  const keys = ADAPTERS.map(a => a.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const a of ADAPTERS) assert.ok(a.runtime === "native" || a.runtime === "wasm");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test benchmark/test/codec-adapters.test.mjs`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

Create `benchmark/codec-adapters.mjs`. Use the quality-option keys confirmed in Task 1 Step 4. The `jxl` adapter is added in Task 5 (it needs the facade); here define the native + wasm codecs. Leave a documented export slot for `jxl`.
```js
import sharp from "sharp";
import jpegEnc from "@jsquash/jpeg/encode.js";
import jpegDec from "@jsquash/jpeg/decode.js";
import webpEnc from "@jsquash/webp/encode.js";
import webpDec from "@jsquash/webp/decode.js";
import avifEnc from "@jsquash/avif/encode.js";
import avifDec from "@jsquash/avif/decode.js";

const toU8 = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x.buffer ?? x));

// --- sharp native adapters ---
function sharpAdapter(key, format, applyQuality) {
  return {
    key, runtime: "native", lossless: format === "png",
    async encode(rgba, w, h, quality) {
      let pipe = sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: w, height: h, channels: 4 } });
      pipe = applyQuality(pipe, quality);
      return toU8(await pipe.toBuffer());
    },
    async decode(bytes) {
      const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data: toU8(data), width: info.width, height: info.height };
    },
  };
}

// --- jsquash wasm adapters ---
function jsquashAdapter(key, enc, dec, qKey = "quality") {
  return {
    key, runtime: "wasm", lossless: false,
    async encode(rgba, w, h, quality) {
      const img = { data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width: w, height: h };
      const buf = await enc(img, { [qKey]: quality });
      return toU8(buf);
    },
    async decode(bytes) {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const img = await dec(ab);
      return { data: toU8(img.data), width: img.width, height: img.height };
    },
  };
}

export const ADAPTERS = [
  sharpAdapter("jpeg_native", "jpeg", (p, q) => p.jpeg({ quality: q })),
  sharpAdapter("webp_native", "webp", (p, q) => p.webp({ quality: q })),
  sharpAdapter("avif_native", "avif", (p, q) => p.avif({ quality: q })),
  sharpAdapter("png_native", "png", (p) => p.png()),
  jsquashAdapter("jpeg_wasm", jpegEnc, jpegDec),
  jsquashAdapter("webp_wasm", webpEnc, webpDec),
  jsquashAdapter("avif_wasm", avifEnc, avifDec),
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test benchmark/test/codec-adapters.test.mjs`
Expected: PASS. If an `@jsquash` codec throws on `{quality}`, correct `qKey` per the Task 1 note and re-run.

- [ ] **Step 5: Commit**

```bash
git add benchmark/codec-adapters.mjs benchmark/test/codec-adapters.test.mjs
git commit -m "feat(codec-compare): uniform native+wasm codec adapters + round-trip tests"
```

---

## Task 4: Toon serialization + aggregates (pure, TDD)

**Files:**
- Create: `benchmark/codec-compare-serialize.mjs`
- Test: `benchmark/test/codec-compare-serialize.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `benchmark/test/codec-compare-serialize.test.mjs`:
```js
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
  assert.match(toon, /Avg_jpeg_native_SizeVsJxlRatio: 1\.5/);
  // fps overlay = 1000/dec_ms ; jpeg_native dec 3ms -> 333
  assert.match(toon, /Avg_jpeg_native_DecFps: 333/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test benchmark/test/codec-compare-serialize.test.mjs`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

Create `benchmark/codec-compare-serialize.mjs`:
```js
const COLS = ["file","codec","runtime","quality","target_butter","achieved_butter","converged","ssim","enc_ms","dec_ms","ttfp_ms","ttfp_kind","bytes","bpp","enc_fps","dec_fps"];
const r0 = (x) => (x == null ? "" : Math.round(x));
const f2 = (x) => (x == null ? "" : Number(x).toFixed(2));
const fps = (ms) => (ms && ms > 0 ? Math.round(1000 / ms) : "");

export function buildCodecToon({ rows, batchName, runTimestamp, target }) {
  const lines = [
    `TestName: CodecCompare - ${batchName}`,
    `RunTimestamp: ${runTimestamp}`,
    `Target: ${target}`,
    `Quality parity: per-file butteraugli anchored to our JXL @ distance 1.0`,
    "# CAVEAT: native (sharp; libvips MT+SIMD) vs wasm (@jsquash, our JXL) — ENCODE/DECODE MS + FPS NOT COMPARABLE ACROSS RUNTIMES. SIZE + QUALITY ARE.",
    "",
    `---`,
    `rows[${rows.length}]{${COLS.join("|")}}:`,
  ];
  for (const r of rows) {
    lines.push("  " + [
      r.file, r.codec, r.runtime, r0(r.quality), f2(r.target_butter), f2(r.achieved_butter),
      r.converged ? 1 : 0, f2(r.ssim), r0(r.enc_ms), r0(r.dec_ms), r0(r.ttfp_ms), r.ttfp_kind,
      r.bytes, f2(r.bpp), fps(r.enc_ms), fps(r.dec_ms),
    ].join(" | "));
  }
  // aggregates per codec key
  lines.push("", "# Aggregates (per codec key)");
  const jxlBytesByFile = new Map(rows.filter(r => r.codec === "jxl").map(r => [r.file, r.bytes]));
  const byKey = new Map();
  for (const r of rows) { if (!byKey.has(r.codec)) byKey.set(r.codec, []); byKey.get(r.codec).push(r); }
  const avg = (arr, sel) => { const v = arr.map(sel).filter(x => x != null); return v.length ? v.reduce((s,x)=>s+x,0)/v.length : null; };
  for (const [key, arr] of byKey) {
    const ratios = arr.map(r => { const jb = jxlBytesByFile.get(r.file); return jb ? r.bytes / jb : null; }).filter(x => x != null);
    const sizeRatio = ratios.length ? ratios.reduce((s,x)=>s+x,0)/ratios.length : null;
    lines.push(
      `Avg_${key}_Bytes: ${r0(avg(arr, r=>r.bytes))} | Avg_${key}_Bpp: ${f2(avg(arr, r=>r.bpp))} | ` +
      `Avg_${key}_EncMs: ${r0(avg(arr, r=>r.enc_ms))} | Avg_${key}_DecMs: ${r0(avg(arr, r=>r.dec_ms))} | ` +
      `Avg_${key}_AchievedButter: ${f2(avg(arr, r=>r.achieved_butter))} | Avg_${key}_Ssim: ${f2(avg(arr, r=>r.ssim))} | ` +
      `Avg_${key}_SizeVsJxlRatio: ${sizeRatio == null ? "" : sizeRatio.toFixed(2)} | ` +
      `Avg_${key}_EncFps: ${fps(avg(arr, r=>r.enc_ms))} | Avg_${key}_DecFps: ${fps(avg(arr, r=>r.dec_ms))}`
    );
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test benchmark/test/codec-compare-serialize.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add benchmark/codec-compare-serialize.mjs benchmark/test/codec-compare-serialize.test.mjs
git commit -m "feat(codec-compare): toon serializer + per-codec aggregates/fps + tests"
```

---

## Task 5: Registry family branch (additive)

**Files:**
- Modify: `benchmark/benchmark-history-registry.mjs`
- Test: `benchmark/test/codec-compare-family.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `benchmark/test/codec-compare-family.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveFamilyIdFromArtifactName, familyLabelFromId, familyColorFromId } from "../benchmark-history-registry.mjs";

test("codec-compare family resolves stably across timestamps, no collision", () => {
  for (const ts of ["2026-07-04t20-00-00-000z", "2026-07-05t09-30-00-000z"]) {
    const id = deriveFamilyIdFromArtifactName(`${ts}-CodecCompare-general.toon`, "CodecCompare - general");
    assert.equal(id, "codec-compare");
  }
  assert.equal(familyLabelFromId("codec-compare"), "Codec Compare");
  assert.equal(familyColorFromId("codec-compare"), "#e879f9");
  // standard family unaffected
  assert.equal(deriveFamilyIdFromArtifactName("x-StandardMultifileTest-general.toon", "StandardMultifileTest - general"), "standard-multifile");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test benchmark/test/codec-compare-family.test.mjs`
Expected: FAIL — id resolves to the timestamped stem, label/color are auto-generated.

- [ ] **Step 3: Add the family branch + overrides**

In `benchmark/benchmark-history-registry.mjs`, add to `FAMILY_LABEL_OVERRIDES` (after the `standard-multifile` entry):
```js
  ["codec-compare", "Codec Compare"],
```
Add to `FAMILY_COLOR_OVERRIDES` (after the `standard-multifile` entry):
```js
  ["codec-compare", "#e879f9"],
```
In `deriveFamilyIdFromArtifactName`, add this line immediately before the `standardmultifiletest` check:
```js
  if (candidates.some((value) => value.includes("codeccompare"))) return "codec-compare";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test benchmark/test/codec-compare-family.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add benchmark/benchmark-history-registry.mjs benchmark/test/codec-compare-family.test.mjs
git commit -m "feat(codec-compare): register codec-compare graph family"
```

---

## Task 6: RGBA loader + JXL adapter/anchor helpers

**Files:**
- Create: `benchmark/codec-compare-jxl.mjs` (JXL encode/decode adapter + loader, WASM-backed)
- Test: manual smoke (WASM/RAW deps — not unit-tested)

- [ ] **Step 1: Implement the loader + JXL adapter**

Create `benchmark/codec-compare-jxl.mjs` (loader + settings taken verbatim from `StandardMultifileTest.mjs:155,368-405` and the `encodeJxl`/`decodeJxl` helpers at `:180-289`):
```js
import { readFileSync } from "node:fs";
import { extname, basename } from "node:path";
import sharp from "sharp";

let raw, facade, PerceptualComparer;
export async function initCodecCompareJxl() {
  raw = await import("../pkg/raw_converter_wasm.js");
  await raw.default({ module_or_path: readFileSync(new URL("../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });
  PerceptualComparer = raw.PerceptualComparer;
  facade = await import("../packages/jxl-wasm/dist/index.js");
}

const TARGET = 1920;
// Verbatim from StandardMultifileTest.mjs:155
const PROCESS_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];
const exactBuffer = (u8) => (u8.buffer.byteLength === u8.byteLength ? u8 : u8.slice());
function rgbaToRgb(d, w, h) { const out = new Uint8Array(w*h*3); for (let i=0,s=0,o=0;i<w*h;i++,s+=4,o+=3){ out[o]=d[s]; out[o+1]=d[s+1]; out[o+2]=d[s+2]; } return out; }

export async function loadTargetRgba(path) {
  const ext = extname(path).toLowerCase();
  let rgb, srcW, srcH;
  if (ext === ".jpg" || ext === ".jpeg") {
    const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    rgb = info.channels === 4 ? rgbaToRgb(data, info.width, info.height) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    srcW = info.width; srcH = info.height;
  } else {
    const bytes = new Uint8Array(readFileSync(path));
    let decoded;
    if (ext === ".orf" || ext === ".raw") decoded = raw.process_orf_with_flags(bytes, 1, ...PROCESS_ARGS);
    else if (ext === ".cr2") decoded = raw.process_cr2_with_flags(bytes, 1, ...PROCESS_ARGS);
    else if (ext === ".dng") decoded = raw.process_dng_with_flags(bytes, 1, ...PROCESS_ARGS);
    else throw new Error(`Unsupported ext ${ext}`);
    rgb = decoded.take_rgb(); srcW = decoded.width; srcH = decoded.height; decoded.free();
  }
  const longEdge = Math.max(srcW, srcH);
  const scale = longEdge > TARGET ? TARGET / longEdge : 1;
  const tgtW = Math.round(srcW * scale), tgtH = Math.round(srcH * scale);
  const rgba = scale < 1 ? raw.rgb_to_rgba(raw.downscale_rgb(rgb, srcW, srcH, tgtW, tgtH)) : raw.rgb_to_rgba(rgb);
  return { rgba: new Uint8Array(rgba), tgtW, tgtH, file: basename(path) };
}

export function perceptualComparer(sourceRgba, w, h) { return new PerceptualComparer(sourceRgba, w, h); }

// JXL adapter — distance 1.0 anchor. Encode/decode settings mirror encodeJxl/decodeJxl in the standard test.
export function makeJxlAdapter() {
  return {
    key: "jxl", runtime: "wasm", lossless: false,
    async encodeAnchor(rgba, w, h) {
      const encoder = facade.createEncoder({
        format: "rgba8", width: w, height: h, hasAlpha: true,
        iccProfile: null, exif: null, xmp: null,
        distance: 1.0, quality: 85, effort: 3,
        progressive: true, progressiveFlavor: "ac", previewFirst: false, chunked: true,
      });
      const chunks = [];
      const collect = (async () => { for await (const c of encoder.chunks()) chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c)); })();
      await encoder.pushPixels(exactBuffer(rgba));
      await encoder.finish();
      await collect;
      await encoder.dispose();
      let n = 0; for (const c of chunks) n += c.length;
      const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },
    async decode(bytes) {
      const decoder = facade.createDecoder({ format: "rgba8", progressionTarget: "final", emitEveryPass: true, progressiveDetail: "passes", preserveIcc: false, preserveMetadata: false });
      let firstFrameMs = null, pixels = null, width = 0, height = 0;
      const t0 = performance.now();
      const ev = (async () => {
        for await (const e of decoder.events()) {
          if (e.type === "progress" || e.type === "final") {
            if (firstFrameMs === null) firstFrameMs = performance.now() - t0;
            if (e.pixels) { pixels = e.pixels; width = e.width ?? width; height = e.height ?? height; }
          } else if (e.type === "error") throw new Error(`${e.code}: ${e.message}`);
        }
      })();
      await decoder.push(exactBuffer(bytes));
      await decoder.close();
      await ev;
      await decoder.dispose();
      return { data: new Uint8Array(pixels.buffer ?? pixels), width, height, firstFrameMs: firstFrameMs ?? (performance.now() - t0) };
    },
  };
}
```
NOTE: `PerceptualComparer.butteraugli(data)` uses the source dims it was constructed with and expects `data.length === w*h*4` — decode dims don't need extracting, only correct length. If the facade decode event field names differ (`e.pixels`/`e.width`), correct them from `StandardMultifileTest.mjs:270-274`.

- [ ] **Step 2: Smoke-test the loader on one RAW + one JPG**

```bash
node -e "import('./benchmark/codec-compare-jxl.mjs').then(async m=>{await m.initCodecCompareJxl(); const r=await m.loadTargetRgba('P1110226.ORF'); console.log(r.file, r.tgtW+'x'+r.tgtH, 'rgba', r.rgba.length, 'expect', r.tgtW*r.tgtH*4);})"
node -e "import('./benchmark/codec-compare-jxl.mjs').then(async m=>{await m.initCodecCompareJxl(); const r=await m.loadTargetRgba('C:/Foo/raw-converter/tests/small_file.jpg'); console.log(r.file, r.tgtW+'x'+r.tgtH, 'rgba', r.rgba.length, 'expect', r.tgtW*r.tgtH*4);})"
```
Expected: both print dims and `rgba` length == `tgtW*tgtH*4`.

- [ ] **Step 3: Smoke-test the JXL adapter round-trip**

```bash
node -e "import('./benchmark/codec-compare-jxl.mjs').then(async m=>{await m.initCodecCompareJxl(); const r=await m.loadTargetRgba('P1110226.ORF'); const a=m.makeJxlAdapter(); const enc=await a.encodeAnchor(r.rgba,r.tgtW,r.tgtH); const dec=await a.decode(enc); const pc=m.perceptualComparer(r.rgba,r.tgtW,r.tgtH); console.log('bytes',enc.length,'butter',pc.butteraugli(dec.data),'ssim',pc.ssim(dec.data),'ttfp',dec.firstFrameMs); pc.free();})"
```
Expected: non-zero bytes, butteraugli ~0.5–2.0, ssim ~0.97–1.0, a finite ttfp. If `dec.data.length !== r.rgba.length`, fix the decode field mapping before proceeding.

- [ ] **Step 4: Commit**

```bash
git add benchmark/codec-compare-jxl.mjs
git commit -m "feat(codec-compare): RAW->RGBA loader + JXL anchor adapter"
```

---

## Task 7: Orchestrator — CodecCompareTest.mjs

**Files:**
- Create: `CodecCompareTest.mjs`
- Test: end-to-end run (Task 8)

- [ ] **Step 1: Implement the orchestrator**

Create `CodecCompareTest.mjs`. The `FILES_CONFIG` + roots below are copied verbatim from `StandardMultifileTest.mjs:124-151`.
```js
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initCodecCompareJxl, loadTargetRgba, perceptualComparer, makeJxlAdapter } from "./benchmark/codec-compare-jxl.mjs";
import { ADAPTERS } from "./benchmark/codec-adapters.mjs";
import { searchQuality } from "./benchmark/butteraugli-search.mjs";
import { buildCodecToon } from "./benchmark/codec-compare-serialize.mjs";

const N_ROUNDS = 5;
const TARGET = 1920;
const TOL = 0.15;
const MAX_ITERS = 8;
const median = (a) => { const s = [...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
async function timeMs(fn) { const t0 = performance.now(); const out = await fn(); return { ms: performance.now() - t0, out }; }

// verbatim from StandardMultifileTest.mjs:124-151
const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const GOB_ROOT = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const TIMING_SOURCE = String.raw`.timing-source`;
const FILES_CONFIG = [
  { name: "small_file.jpg", paths: [join(TEST_ROOT, "small_file.jpg")] },
  { name: "P1110226 windows.jpg", paths: [join(TEST_ROOT, "P1110226 windows.jpg")] },
  { name: "PXL_20260527_180319603.RAW-02.ORIGINAL.dng", paths: [join(TEST_ROOT, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng"), join(TIMING_SOURCE, "PXL_20260527_180319603.RAW-02.ORIGINAL.dng"), String.raw`C:\Foo\raw-converter-wasm\.timing-source\PXL_20260527_180319603.RAW-02.ORIGINAL.dng`] },
  { name: "PXL_20260501_093507165.RAW-02.ORIGINAL.dng", paths: [join(TEST_ROOT, "PXL_20260501_093507165.RAW-02.ORIGINAL.dng"), String.raw`C:\Foo\raw-converter-wasm\.timing-source\PXL_20260501_093507165.RAW-02.ORIGINAL.dng`] },
  { name: "P1110226.ORF", paths: [join(TEST_ROOT, "P1110226.ORF")] },
  { name: "P2200474.ORF", paths: [join(GOB_ROOT, "P2200474.ORF")] },
  { name: "_MG_1750.CR2", paths: [join(TEST_ROOT, "_MG_1750.CR2")] },
  { name: "ADH 1248.CR2", paths: [join(TEST_ROOT, "ADH 1248.CR2")] },
];
function resolveFile(cfg) { for (const p of cfg.paths) if (existsSync(p)) return p; return null; }

async function main() {
  const batchName = process.argv[2] || "general";
  const runTimestamp = new Date().toISOString();
  await initCodecCompareJxl();
  const FILES = FILES_CONFIG.map(c => ({ name: c.name, path: resolveFile(c) })).filter(f => f.path);
  if (FILES.length === 0) throw new Error("No standard files resolved — check TEST_ROOT paths");
  const jxl = makeJxlAdapter();
  const rows = [];

  for (const f of FILES) {
    const { rgba, tgtW, tgtH, file } = await loadTargetRgba(f.path);
    const pc = perceptualComparer(rgba, tgtW, tgtH);
    const npx = tgtW * tgtH;

    // Anchor: our JXL @ d1.0
    const jxlEnc = await jxl.encodeAnchor(rgba, tgtW, tgtH);
    const jxlDec = await jxl.decode(jxlEnc);
    const targetButter = pc.butteraugli(jxlDec.data);
    const jxlEncMs = median(await roundsOf(N_ROUNDS, () => jxl.encodeAnchor(rgba, tgtW, tgtH)));
    const jxlDecTimed = await manyDecode(N_ROUNDS, () => jxl.decode(jxlEnc));
    rows.push({ file, codec: "jxl", runtime: "wasm", quality: null, target_butter: targetButter,
      achieved_butter: targetButter, converged: true, ssim: pc.ssim(jxlDec.data),
      enc_ms: jxlEncMs, dec_ms: median(jxlDecTimed.ms), ttfp_ms: jxlDec.firstFrameMs, ttfp_kind: "progressive",
      bytes: jxlEnc.length, bpp: (jxlEnc.length * 8) / npx });

    // Each other codec: search to target, then time
    for (const a of ADAPTERS) {
      if (a.lossless) {
        const bytes = await a.encode(rgba, tgtW, tgtH);
        const dec = await a.decode(bytes);
        const encMs = median(await roundsOf(N_ROUNDS, () => a.encode(rgba, tgtW, tgtH)));
        const dt = await manyDecode(N_ROUNDS, () => a.decode(bytes));
        rows.push({ file, codec: a.key, runtime: a.runtime, quality: null, target_butter: targetButter,
          achieved_butter: pc.butteraugli(dec.data), converged: true, ssim: pc.ssim(dec.data),
          enc_ms: encMs, dec_ms: median(dt.ms), ttfp_ms: median(dt.ms), ttfp_kind: "full",
          bytes: bytes.length, bpp: (bytes.length * 8) / npx });
        continue;
      }
      const measure = async (q) => { const b = await a.encode(rgba, tgtW, tgtH, q); const d = await a.decode(b); return pc.butteraugli(d.data); };
      const sr = await searchQuality({ measure, target: targetButter, tol: TOL, maxIters: MAX_ITERS });
      const bytes = await a.encode(rgba, tgtW, tgtH, sr.quality);
      const dec = await a.decode(bytes);
      const encMs = median(await roundsOf(N_ROUNDS, () => a.encode(rgba, tgtW, tgtH, sr.quality)));
      const dt = await manyDecode(N_ROUNDS, () => a.decode(bytes));
      if (!sr.converged) console.warn(`  [!] ${file} ${a.key}: not converged (target ${targetButter.toFixed(2)}, got ${sr.achieved.toFixed(2)} @q${sr.quality})`);
      rows.push({ file, codec: a.key, runtime: a.runtime, quality: sr.quality, target_butter: targetButter,
        achieved_butter: sr.achieved, converged: sr.converged, ssim: pc.ssim(dec.data),
        enc_ms: encMs, dec_ms: median(dt.ms), ttfp_ms: median(dt.ms), ttfp_kind: "full",
        bytes: bytes.length, bpp: (bytes.length * 8) / npx });
    }
    pc.free();
    console.log(`✓ ${file}`);
  }

  const toon = buildCodecToon({ rows, batchName, runTimestamp, target: TARGET });
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const OUT_DIR = join(scriptDir, "docs", "outputs", "timing tests");
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const stamp = runTimestamp.replace(/[:.]/g, "-");
  const outPath = join(OUT_DIR, `${stamp}-CodecCompare-${batchName}.toon`);
  writeFileSync(outPath, toon);
  console.log("Wrote", outPath);
}

async function roundsOf(n, fn) { const out = []; for (let i = 0; i < n; i++) out.push((await timeMs(fn)).ms); return out; }
async function manyDecode(n, fn) { const ms = []; for (let i = 0; i < n; i++) ms.push((await timeMs(fn)).ms); return { ms }; }

main().then(() => setTimeout(() => process.exit(0), 500)).catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Commit**

```bash
git add CodecCompareTest.mjs
git commit -m "feat(codec-compare): orchestrator runner"
```

---

## Task 8: End-to-end validation

**Files:** none (validation only)

- [ ] **Step 1: Run the full benchmark**

Run: `node ./CodecCompareTest.mjs`
Expected: `✓` per file (8), warnings only for genuine non-converged codecs, `Wrote .../<stamp>-CodecCompare-general.toon`.

- [ ] **Step 2: Validate the toon + family resolution**

Run:
```bash
node -e "import('./benchmark/benchmark-history-registry.mjs').then(m=>{const fs=require('fs');const dir='docs/outputs/timing tests';const f=fs.readdirSync(dir).filter(x=>x.includes('CodecCompare')).sort().pop();const t=fs.readFileSync(dir+'/'+f,'utf8');const id=m.deriveFamilyIdFromArtifactName(f,(t.match(/TestName: (.*)/)||[])[1]||'');console.log('family',id,'rows',/rows\[(\d+)\]/.exec(t)[1]);console.log('has caveat', t.includes('NOT COMPARABLE'));console.log('sample ratio line', (t.match(/Avg_jpeg_native_SizeVsJxlRatio: [\d.]+/)||[])[0]);})"
```
Expected: `family codec-compare`, `rows 64` (8 files × 8 codecs incl jxl), `has caveat true`, a printed size-vs-jxl ratio.

- [ ] **Step 3: Run the full test suite for the new modules**

Run: `node --test benchmark/test/butteraugli-search.test.mjs benchmark/test/codec-adapters.test.mjs benchmark/test/codec-compare-serialize.test.mjs benchmark/test/codec-compare-family.test.mjs`
Expected: all PASS.

- [ ] **Step 4: Delete the throwaway probe**

```bash
git rm benchmark/probe-codecs.mjs
git commit -m "chore(codec-compare): remove codec API probe"
```

- [ ] **Step 5: Sanity-read the headline numbers**

Open the toon; confirm: JXL rows have `ttfp_kind progressive`; all others `full`; `achieved_butter` within ±0.15 of `target_butter` for converged codecs; `Avg_*_SizeVsJxlRatio` plausible (JPEG > 1, AVIF often < 1). Note any surprises for follow-up.

---

## Notes for the implementer

- **Never touch `StandardMultifileTest.mjs`** or the `standard-multifile` family.
- Fill every `/* ... */` slot in Task 6 by reading the exact code in `StandardMultifileTest.mjs` (loader flags, JXL encode/decode settings) — do not guess RAW-processing arguments.
- If `@jsquash` codecs need `init()` before first use in Node, add it inside the adapter's first call (lazy-init guard).
- Native (sharp) vs WASM ms are not comparable — never rank across runtimes on time; the toon caveat documents this.
- Run in a dedicated git worktree if executing unattended (per repo git-isolation rules); the primary checkout is on `main`.
