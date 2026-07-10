# AI Identification Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the RAW→JXL converter emit a lean, machine-readable ID metadata sidecar per image plus a folder manifest, and generate a 768px JPEG identification proxy on demand from the cheapest available source — without storing per-image proxies and without any classifier.

**Architecture:** New Node/ESM library under `web/ai-id/`. Pure builders produce the `casava-ai/1` sidecar and `casava-ai-manifest/1` manifest from an already-decoded `ProcessResult`. A source-priority chain (`resolveProxy`) walks ordered source providers (live buffer → pyramid 1024 level → embedded preview → master decode → RAW re-decode) and encodes the first non-null result to a 768px q80 4:2:0 JPEG. Platform-specific bits (JPEG encoder, live-buffer/pyramid byte retrieval) are injected so the core is fully Node-testable. A thin CLI writes sidecars + manifest for a folder.

**Tech Stack:** Node 24 (global `fetch`/`FormData` unused here), ESM `.mjs`, `node --test`, `sharp` (Node JPEG encode), our `pkg/raw_converter_wasm` (RAW decode + `downscale_rgba` + `rgb_to_rgba`), our libjxl facade `packages/jxl-wasm/dist/index.js` (JXL level/master decode). Design basis: `docs/superpowers/specs/2026-07-10-ai-id-foundation-design.md`.

---

## Reference facts (verified in the codebase)

- Decoded result getters (from `src/lib.rs`): `width`, `height`, `orientation` (public readonly); `gps_lat`, `gps_lon`, `gps_alt`, `has_gps` (public readonly); `datetime()` getter (`src/lib.rs:527`, returns `"YYYY:MM:DD HH:MM:SS"` or `""`); `take_rgb()` → RGB8 `Uint8Array`.
- Decode entry points (from `benchmark/codec-compare-jxl.mjs`): `raw.process_cr2_with_flags(bytes, 1, ...ARGS)`, `process_dng_with_flags`, `process_orf_with_flags`, with `ARGS = [0,0,0,0,0,0,0,0,0,0, NaN, NaN, 0,0]`. Flag `1` applies orientation (pixels upright).
- `raw.rgb_to_rgba(rgb)` → RGBA8; `raw.downscale_rgba(rgba, srcW, srcH, dstW, dstH)` → single-step area-average (this is the "direct" downscale we chose; NOT cascaded pyramid).
- WASM init: `await raw.default({ module_or_path: readFileSync(new URL("../../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) })`.
- Facade JXL decode pattern: see `makeJxlAdapter().decode()` in `benchmark/codec-compare-jxl.mjs:227` (facade `createDecoder({format:"rgba8", ...})`, push bytes, collect `progress`/`final` events → `pixels`).
- Proxy spec (empirical, `ai-id-bakeoff/`): 768px long-edge · JPEG q80 · 4:2:0.

All new files live in `web/ai-id/`. Relative to that dir: `pkg` = `../../pkg/…`, facade = `../../packages/jxl-wasm/dist/index.js`. Tests are `.test.mjs`, run with `node --test <path>`.

## File Structure

- `web/ai-id/datetime-geo.mjs` — pure helpers: `exifDatetimeToIso`, `geoBlock`.
- `web/ai-id/sidecar.mjs` — `buildSidecar(input)` → `casava-ai/1` object.
- `web/ai-id/manifest.mjs` — `buildManifest(entries)` → `casava-ai-manifest/1` object.
- `web/ai-id/embedded-preview.mjs` — `findJpegStreams`, `extractPreview` (ported from the proven `ai-id-bakeoff/extract-preview.mjs`).
- `web/ai-id/proxy.mjs` — `encodeProxyJpeg(rgba,w,h,opts)`, `resolveProxy(sources,opts)` (the chain), `nodeEncodeJpeg`, `nodeDownscaleRgba`.
- `web/ai-id/sources.mjs` — source constructors: `liveBufferSource`, `pyramidLevelSource`, `embeddedPreviewSource`, `masterDecodeSource`, `rawDecodeSource`.
- `web/ai-id/decode.mjs` — `initWasm()`, `decodeRaw(path)` → `{ result, rgb, width, height }` (thin wrapper over `pkg`).
- `web/ai-id/export.mjs` — CLI: folder → write `<name>.ai.json` per image + `manifest.json`.
- Tests: one `*.test.mjs` beside each module.

---

### Task 1: datetime + geo helpers

**Files:**
- Create: `web/ai-id/datetime-geo.mjs`
- Test: `web/ai-id/datetime-geo.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// web/ai-id/datetime-geo.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { exifDatetimeToIso, geoBlock } from "./datetime-geo.mjs";

test("exifDatetimeToIso converts EXIF colon date to ISO 8601", () => {
  assert.equal(exifDatetimeToIso("2026:05:27 17:53:12"), "2026-05-27T17:53:12");
});

test("exifDatetimeToIso returns null for empty/blank/garbage", () => {
  assert.equal(exifDatetimeToIso(""), null);
  assert.equal(exifDatetimeToIso("   "), null);
  assert.equal(exifDatetimeToIso("not a date"), null);
});

test("geoBlock returns decimal block when GPS present", () => {
  assert.deepEqual(
    geoBlock({ has_gps: true, gps_lat: -25.85, gps_lon: 28.19, gps_alt: 1300 }),
    { lat: -25.85, lon: 28.19, alt: 1300 },
  );
});

test("geoBlock returns null when GPS absent", () => {
  assert.equal(geoBlock({ has_gps: false, gps_lat: 0, gps_lon: 0, gps_alt: 0 }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/ai-id/datetime-geo.test.mjs`
Expected: FAIL — `Cannot find module './datetime-geo.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// web/ai-id/datetime-geo.mjs

/** EXIF datetime "YYYY:MM:DD HH:MM:SS" → ISO 8601 "YYYY-MM-DDTHH:MM:SS". null if absent/malformed. */
export function exifDatetimeToIso(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}`;
}

/** Decoded-result GPS getters → decimal geo block, or null when absent. */
export function geoBlock(decoded) {
  if (!decoded?.has_gps) return null;
  return { lat: decoded.gps_lat, lon: decoded.gps_lon, alt: decoded.gps_alt };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/ai-id/datetime-geo.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/ai-id/datetime-geo.mjs web/ai-id/datetime-geo.test.mjs
git commit -m "feat(ai-id): datetime + geo sidecar helpers"
```

---

### Task 2: `buildSidecar` (casava-ai/1)

**Files:**
- Create: `web/ai-id/sidecar.mjs`
- Test: `web/ai-id/sidecar.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// web/ai-id/sidecar.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSidecar } from "./sidecar.mjs";

const base = {
  filename: "ADH 1248.CR2", sha256: "abc123", bytes: 39416383, format: "cr2",
  width: 6000, height: 4000, orientationApplied: true,
  datetimeExif: "2026:05:27 17:53:12",
  decoded: { has_gps: true, gps_lat: -25.85, gps_lon: 28.19, gps_alt: 1300 },
};

test("buildSidecar produces the casava-ai/1 shape with decimal geo + ISO datetime", () => {
  const s = buildSidecar(base);
  assert.equal(s.schema, "casava-ai/1");
  assert.deepEqual(s.source, { filename: "ADH 1248.CR2", sha256: "abc123", bytes: 39416383, format: "cr2" });
  assert.deepEqual(s.image, { width: 6000, height: 4000, orientation_applied: true });
  assert.deepEqual(s.colour, { space: "sRGB", icc_embedded: false });
  assert.equal(s.datetime, "2026-05-27T17:53:12");
  assert.deepEqual(s.geo, { lat: -25.85, lon: 28.19, alt: 1300 });
  assert.deepEqual(s.proxy, { spec: "768px/q80/4:2:0", stored: false });
  assert.deepEqual(s.generator, { name: "casava-ai", version: 1 });
});

test("buildSidecar sets geo and datetime null when absent", () => {
  const s = buildSidecar({ ...base, datetimeExif: "", decoded: { has_gps: false } });
  assert.equal(s.geo, null);
  assert.equal(s.datetime, null);
});

test("buildSidecar excludes photographic EXIF (no camera/lens/iso/exposure keys)", () => {
  const s = buildSidecar(base);
  for (const k of ["camera", "lens", "iso", "exposure", "fnumber", "focal_length", "capture"]) {
    assert.equal(k in s, false, `unexpected key ${k}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/ai-id/sidecar.test.mjs`
Expected: FAIL — `Cannot find module './sidecar.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// web/ai-id/sidecar.mjs
import { exifDatetimeToIso, geoBlock } from "./datetime-geo.mjs";

export const SIDECAR_SCHEMA = "casava-ai/1";
export const PROXY_SPEC = "768px/q80/4:2:0";

/**
 * Build a lean, ID-focused casava-ai/1 sidecar object.
 * `input`: { filename, sha256, bytes, format, width, height, orientationApplied,
 *            datetimeExif, decoded } where `decoded` exposes has_gps/gps_lat/lon/alt.
 * Photographic EXIF (camera/lens/iso/exposure) is intentionally excluded — it stays in
 * the master RAW; full-EXIF preservation is the separate JXL-embed follow-up.
 */
export function buildSidecar(input) {
  return {
    schema: SIDECAR_SCHEMA,
    source: { filename: input.filename, sha256: input.sha256, bytes: input.bytes, format: input.format },
    image: { width: input.width, height: input.height, orientation_applied: !!input.orientationApplied },
    colour: { space: "sRGB", icc_embedded: false },
    datetime: exifDatetimeToIso(input.datetimeExif),
    geo: geoBlock(input.decoded),
    proxy: { spec: PROXY_SPEC, stored: false },
    generator: { name: "casava-ai", version: 1 },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/ai-id/sidecar.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/ai-id/sidecar.mjs web/ai-id/sidecar.test.mjs
git commit -m "feat(ai-id): lean casava-ai/1 sidecar builder"
```

---

### Task 3: `buildManifest` (casava-ai-manifest/1)

**Files:**
- Create: `web/ai-id/manifest.mjs`
- Test: `web/ai-id/manifest.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// web/ai-id/manifest.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "./manifest.mjs";

test("buildManifest aggregates entries with count + schema", () => {
  const m = buildManifest([
    { name: "a.CR2", sidecar: "a.ai.json", sha256: "h1", hasGeo: true, width: 6000, height: 4000 },
    { name: "b.dng", sidecar: "b.ai.json", sha256: "h2", hasGeo: false, width: 4032, height: 3024 },
  ]);
  assert.equal(m.schema, "casava-ai-manifest/1");
  assert.equal(m.count, 2);
  assert.deepEqual(m.items[0], { name: "a.CR2", sidecar: "a.ai.json", sha256: "h1", has_geo: true, width: 6000, height: 4000 });
  assert.equal(m.items[1].has_geo, false);
});

test("buildManifest handles empty input", () => {
  const m = buildManifest([]);
  assert.equal(m.count, 0);
  assert.deepEqual(m.items, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/ai-id/manifest.test.mjs`
Expected: FAIL — `Cannot find module './manifest.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// web/ai-id/manifest.mjs
export const MANIFEST_SCHEMA = "casava-ai-manifest/1";

/** entries: [{ name, sidecar, sha256, hasGeo, width, height }] → manifest object. */
export function buildManifest(entries) {
  return {
    schema: MANIFEST_SCHEMA,
    count: entries.length,
    items: entries.map((e) => ({
      name: e.name, sidecar: e.sidecar, sha256: e.sha256,
      has_geo: !!e.hasGeo, width: e.width, height: e.height,
    })),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/ai-id/manifest.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/ai-id/manifest.mjs web/ai-id/manifest.test.mjs
git commit -m "feat(ai-id): folder manifest builder"
```

---

### Task 4: embedded-preview extractor (port)

**Files:**
- Create: `web/ai-id/embedded-preview.mjs`
- Test: `web/ai-id/embedded-preview.test.mjs`

**Note:** This ports the proven extractor from `ai-id-bakeoff/extract-preview.mjs` so the foundation owns it. Copy that file's `findJpegStreams` + `extractPreview` verbatim, minus the CLI block at the bottom.

- [ ] **Step 1: Write the failing test**

```javascript
// web/ai-id/embedded-preview.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPreview } from "./embedded-preview.mjs";

const CR2 = "c:/Foo/raw-converter/tests/ADH 1248.CR2";

test("extractPreview picks the largest viewable JPEG from a CR2, skipping lossless raw", () => {
  const { buffer, w, h, sof } = extractPreview(CR2);
  assert.ok(buffer.length > 0);
  assert.equal(w, 6000);          // full baseline preview, not the 160x120 thumb
  assert.equal(h, 4000);
  assert.equal([0xc0, 0xc1, 0xc2].includes(sof), true); // viewable, not C3 lossless
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/ai-id/embedded-preview.test.mjs`
Expected: FAIL — `Cannot find module './embedded-preview.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Copy `ai-id-bakeoff/extract-preview.mjs` into `web/ai-id/embedded-preview.mjs`, keeping the `import { readFileSync } from "node:fs";` line and the `VIEWABLE_SOF`, `NON_SOF`, `parseJpegAt`, `findJpegStreams`, and `extractPreview` definitions. **Delete** the trailing `if (import.meta.url === ...)` CLI block. Ensure both `findJpegStreams` and `extractPreview` are `export`ed (they already are in the source).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/ai-id/embedded-preview.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add web/ai-id/embedded-preview.mjs web/ai-id/embedded-preview.test.mjs
git commit -m "feat(ai-id): own the embedded-preview extractor"
```

---

### Task 5: proxy encoder + `resolveProxy` chain

**Files:**
- Create: `web/ai-id/proxy.mjs`
- Test: `web/ai-id/proxy.test.mjs`

**Contracts:**
- A *source* is `{ label: string, get: () => Promise<{ rgba: Uint8Array, w: number, h: number } | null> }`.
- `resolveProxy(sources, opts)` tries each source in order; the first returning non-null is encoded and returned as `{ jpeg, w, h, source }`. Throws if all sources return null.
- `encodeProxyJpeg(rgba, w, h, opts)` downscales to `maxEdge` long-edge (single-step, direct) then JPEG-encodes at `quality`, 4:2:0. `opts.downscaleRgba` and `opts.encodeJpeg` are injected for platform independence and testing.

- [ ] **Step 1: Write the failing test**

```javascript
// web/ai-id/proxy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeProxyJpeg, resolveProxy } from "./proxy.mjs";

// Fakes: identity downscale that records the requested dims; stub encoder returns a tagged buffer.
function fakeDeps() {
  const calls = [];
  return {
    downscaleRgba: (rgba, sw, sh, dw, dh) => { calls.push([sw, sh, dw, dh]); return new Uint8Array(dw * dh * 4); },
    encodeJpeg: async (rgba, w, h, q) => new Uint8Array([0xff, 0xd8, w & 0xff, h & 0xff, q]),
    calls,
  };
}

test("encodeProxyJpeg downscales to 768 long-edge preserving aspect, encodes 4:2:0", async () => {
  const d = fakeDeps();
  const src = new Uint8Array(6000 * 4000 * 4);
  const out = await encodeProxyJpeg(src, 6000, 4000, { maxEdge: 768, quality: 80, downscaleRgba: d.downscaleRgba, encodeJpeg: d.encodeJpeg });
  assert.deepEqual(d.calls[0], [6000, 4000, 768, 512]); // 768/6000*4000 = 512
  assert.equal(out.w, 768);
  assert.equal(out.h, 512);
  assert.equal(out.jpeg[0], 0xff);
});

test("encodeProxyJpeg does not upscale a small source", async () => {
  const d = fakeDeps();
  const out = await encodeProxyJpeg(new Uint8Array(400 * 300 * 4), 400, 300, { maxEdge: 768, quality: 80, downscaleRgba: d.downscaleRgba, encodeJpeg: d.encodeJpeg });
  assert.equal(d.calls.length, 0); // no downscale call
  assert.equal(out.w, 400);
  assert.equal(out.h, 300);
});

test("resolveProxy returns the first non-null source and its label", async () => {
  const d = fakeDeps();
  const sources = [
    { label: "buffer", get: async () => null },
    { label: "pyramid", get: async () => ({ rgba: new Uint8Array(100 * 100 * 4), w: 100, h: 100 }) },
    { label: "raw", get: async () => { throw new Error("should not reach"); } },
  ];
  const out = await resolveProxy(sources, { maxEdge: 768, quality: 80, downscaleRgba: d.downscaleRgba, encodeJpeg: d.encodeJpeg });
  assert.equal(out.source, "pyramid");
  assert.equal(out.w, 100);
});

test("resolveProxy throws when all sources are null", async () => {
  const d = fakeDeps();
  const sources = [{ label: "a", get: async () => null }, { label: "b", get: async () => null }];
  await assert.rejects(
    () => resolveProxy(sources, { maxEdge: 768, quality: 80, downscaleRgba: d.downscaleRgba, encodeJpeg: d.encodeJpeg }),
    /no proxy source available/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/ai-id/proxy.test.mjs`
Expected: FAIL — `Cannot find module './proxy.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// web/ai-id/proxy.mjs
import sharp from "sharp";

export const DEFAULT_MAX_EDGE = 768;
export const DEFAULT_QUALITY = 80;

/** Node JPEG encoder: RGBA raw → JPEG q, 4:2:0. */
export async function nodeEncodeJpeg(rgba, w, h, quality) {
  const buf = await sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: w, height: h, channels: 4 } })
    .jpeg({ quality, chromaSubsampling: "4:2:0" })
    .toBuffer();
  return new Uint8Array(buf);
}

/** Downscale target dims for a long-edge cap, preserving aspect. Returns null if no downscale needed. */
function targetDims(w, h, maxEdge) {
  const long = Math.max(w, h);
  if (long <= maxEdge) return null;
  const s = maxEdge / long;
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Downscale (direct, single-step) to maxEdge then JPEG-encode 4:2:0. */
export async function encodeProxyJpeg(rgba, w, h, opts = {}) {
  const maxEdge = opts.maxEdge ?? DEFAULT_MAX_EDGE;
  const quality = opts.quality ?? DEFAULT_QUALITY;
  const downscaleRgba = opts.downscaleRgba;
  const encodeJpeg = opts.encodeJpeg ?? nodeEncodeJpeg;
  const t = targetDims(w, h, maxEdge);
  let ow = w, oh = h, buf = rgba;
  if (t) {
    if (!downscaleRgba) throw new Error("encodeProxyJpeg: downscaleRgba required to resize");
    buf = downscaleRgba(rgba, w, h, t.w, t.h);
    ow = t.w; oh = t.h;
  }
  const jpeg = await encodeJpeg(buf, ow, oh, quality);
  return { jpeg, w: ow, h: oh };
}

/** Walk ordered sources; encode the first that yields pixels. Throws if none do. */
export async function resolveProxy(sources, opts = {}) {
  for (const src of sources) {
    const r = await src.get();
    if (r && r.rgba) {
      const enc = await encodeProxyJpeg(r.rgba, r.w, r.h, opts);
      return { ...enc, source: src.label };
    }
  }
  throw new Error("no proxy source available");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/ai-id/proxy.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/ai-id/proxy.mjs web/ai-id/proxy.test.mjs
git commit -m "feat(ai-id): proxy encoder + source-priority chain"
```

---

### Task 6: WASM decode wrapper

**Files:**
- Create: `web/ai-id/decode.mjs`
- Test: `web/ai-id/decode.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// web/ai-id/decode.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { initWasm, decodeRaw } from "./decode.mjs";

test("decodeRaw returns oriented RGB + dims + metadata getters for a CR2", async () => {
  await initWasm();
  const d = await decodeRaw("c:/Foo/raw-converter/tests/ADH 1248.CR2");
  assert.equal(d.width, 6000);
  assert.equal(d.height, 4000);
  assert.equal(d.rgb.length, 6000 * 4000 * 3);
  assert.equal(typeof d.result.datetime, "string");
  assert.equal(typeof d.result.has_gps, "boolean");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/ai-id/decode.test.mjs`
Expected: FAIL — `Cannot find module './decode.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// web/ai-id/decode.mjs
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];
let raw;

export async function initWasm() {
  if (raw) return raw;
  raw = await import("../../pkg/raw_converter_wasm.js");
  await raw.default({ module_or_path: readFileSync(new URL("../../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });
  return raw;
}

export function getRaw() {
  if (!raw) throw new Error("initWasm() not called");
  return raw;
}

export const SUPPORTED_RAW = new Set([".cr2", ".dng", ".orf", ".raw"]);

/** Decode a RAW file to oriented RGB8 + dims; `result` exposes the metadata getters. */
export async function decodeRaw(path) {
  await initWasm();
  const ext = extname(path).toLowerCase();
  const bytes = new Uint8Array(readFileSync(path));
  let result;
  if (ext === ".cr2") result = raw.process_cr2_with_flags(bytes, 1, ...ARGS);
  else if (ext === ".dng") result = raw.process_dng_with_flags(bytes, 1, ...ARGS);
  else if (ext === ".orf" || ext === ".raw") result = raw.process_orf_with_flags(bytes, 1, ...ARGS);
  else throw new Error(`decodeRaw: unsupported extension ${ext}`);
  const width = result.width, height = result.height;
  const rgb = result.take_rgb();
  return { result, rgb, width, height };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/ai-id/decode.test.mjs`
Expected: PASS (1 test). (First WASM load can take a few seconds.)

- [ ] **Step 5: Commit**

```bash
git add web/ai-id/decode.mjs web/ai-id/decode.test.mjs
git commit -m "feat(ai-id): node WASM decode wrapper"
```

---

### Task 7: source constructors

**Files:**
- Create: `web/ai-id/sources.mjs`
- Test: `web/ai-id/sources.test.mjs`

**Contracts** — each constructor returns a `{ label, get }` source (see Task 5):
- `liveBufferSource(rgba, w, h)` — wraps already-decoded pixels; `get` returns null if `rgba` falsy.
- `pyramidLevelSource(getJxlBytes, decodeJxl)` — `getJxlBytes()` returns the 1024-level JXL bytes or null; `decodeJxl(bytes)` → `{ data, width, height }`.
- `embeddedPreviewSource(path, sharpMod)` — extracts the embedded preview, decodes to RGBA; null if none or < `minEdge` (default 768) long-edge.
- `rawDecodeSource(path, decodeRawFn, rgbToRgba)` — full pipeline decode → RGBA.
- `masterDecodeSource(getMasterBytes, decodeJxl)` — decode the sibling `.jxl` master → RGBA; null if no master.

- [ ] **Step 1: Write the failing test**

```javascript
// web/ai-id/sources.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveBufferSource, pyramidLevelSource, embeddedPreviewSource, rawDecodeSource } from "./sources.mjs";

test("liveBufferSource yields the given pixels, or null when absent", async () => {
  const rgba = new Uint8Array(4 * 4 * 4);
  assert.deepEqual(await liveBufferSource(rgba, 4, 4).get(), { rgba, w: 4, h: 4 });
  assert.equal(await liveBufferSource(null, 0, 0).get(), null);
});

test("pyramidLevelSource decodes level bytes to RGBA; null when no bytes", async () => {
  const decodeJxl = async (b) => ({ data: new Uint8Array(2 * 2 * 4), width: 2, height: 2 });
  const src = pyramidLevelSource(() => new Uint8Array([1, 2, 3]), decodeJxl);
  assert.deepEqual(await src.get(), { rgba: new Uint8Array(2 * 2 * 4), w: 2, h: 2 });
  assert.equal(await pyramidLevelSource(() => null, decodeJxl).get(), null);
});

test("embeddedPreviewSource returns RGBA for a CR2 with a large preview", async () => {
  const sharp = (await import("sharp")).default;
  const src = embeddedPreviewSource("c:/Foo/raw-converter/tests/ADH 1248.CR2", sharp, { minEdge: 768 });
  const r = await src.get();
  assert.equal(r.w, 6000);
  assert.equal(r.rgba.length, r.w * r.h * 4);
});

test("rawDecodeSource decodes a RAW to RGBA via injected fns", async () => {
  const decodeRawFn = async () => ({ rgb: new Uint8Array(2 * 2 * 3), width: 2, height: 2 });
  const rgbToRgba = (rgb) => new Uint8Array(2 * 2 * 4);
  const r = await rawDecodeSource("x.cr2", decodeRawFn, rgbToRgba).get();
  assert.equal(r.w, 2);
  assert.equal(r.rgba.length, 2 * 2 * 4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/ai-id/sources.test.mjs`
Expected: FAIL — `Cannot find module './sources.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// web/ai-id/sources.mjs
import { extractPreview } from "./embedded-preview.mjs";

/** Already-decoded pixels (browser lightbox / batch loop). */
export function liveBufferSource(rgba, w, h) {
  return { label: "buffer", get: async () => (rgba ? { rgba, w, h } : null) };
}

/** JXL pyramid 1024 level. getJxlBytes()->Uint8Array|null; decodeJxl(bytes)->{data,width,height}. */
export function pyramidLevelSource(getJxlBytes, decodeJxl) {
  return {
    label: "pyramid",
    get: async () => {
      const bytes = await getJxlBytes();
      if (!bytes) return null;
      const d = await decodeJxl(bytes);
      return { rgba: d.data, w: d.width, h: d.height };
    },
  };
}

/** Camera embedded preview (no decode). Rejects previews below minEdge long-edge (default 768). */
export function embeddedPreviewSource(path, sharpMod, { minEdge = 768 } = {}) {
  return {
    label: "embedded-preview",
    get: async () => {
      let p;
      try { p = extractPreview(path); } catch { return null; }
      if (Math.max(p.w, p.h) < minEdge) return null;
      const { data, info } = await sharpMod(Buffer.from(p.buffer)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), w: info.width, h: info.height };
    },
  };
}

/** Sibling .jxl archival master. getMasterBytes()->Uint8Array|null; decodeJxl(bytes)->{data,width,height}. */
export function masterDecodeSource(getMasterBytes, decodeJxl) {
  return {
    label: "master",
    get: async () => {
      const bytes = await getMasterBytes();
      if (!bytes) return null;
      const d = await decodeJxl(bytes);
      return { rgba: d.data, w: d.width, h: d.height };
    },
  };
}

/** Full RAW re-decode (last resort). decodeRawFn(path)->{rgb,width,height}; rgbToRgba(rgb)->Uint8Array. */
export function rawDecodeSource(path, decodeRawFn, rgbToRgba) {
  return {
    label: "raw",
    get: async () => {
      const d = await decodeRawFn(path);
      return { rgba: new Uint8Array(rgbToRgba(d.rgb)), w: d.width, h: d.height };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/ai-id/sources.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/ai-id/sources.mjs web/ai-id/sources.test.mjs
git commit -m "feat(ai-id): proxy source constructors"
```

---

### Task 8: end-to-end proxy from a RAW file (integration)

**Files:**
- Test: `web/ai-id/proxy-e2e.test.mjs`

This proves the real chain: for a standalone RAW (no gallery pyramid, no master), the chain
falls to embedded-preview → raw-decode and yields a genuine 768px q80 4:2:0 JPEG.

- [ ] **Step 1: Write the failing test**

```javascript
// web/ai-id/proxy-e2e.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { initWasm, getRaw, decodeRaw } from "./decode.mjs";
import { embeddedPreviewSource, rawDecodeSource } from "./sources.mjs";
import { resolveProxy, nodeEncodeJpeg } from "./proxy.mjs";

test("CR2 → 768px q80 4:2:0 JPEG via the real source chain", async () => {
  await initWasm();
  const raw = getRaw();
  const path = "c:/Foo/raw-converter/tests/ADH 1248.CR2";
  const sources = [
    embeddedPreviewSource(path, sharp),
    rawDecodeSource(path, decodeRaw, raw.rgb_to_rgba),
  ];
  const out = await resolveProxy(sources, {
    maxEdge: 768, quality: 80,
    downscaleRgba: (rgba, sw, sh, dw, dh) => new Uint8Array(raw.downscale_rgba(rgba, sw, sh, dw, dh)),
    encodeJpeg: nodeEncodeJpeg,
  });
  assert.equal(out.source, "embedded-preview");     // preview wins for CR2
  assert.equal(Math.max(out.w, out.h), 768);
  // Verify it's a real, decodable JPEG at 4:2:0.
  const meta = await sharp(Buffer.from(out.jpeg)).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.chromaSubsampling, "4:2:0");
  assert.equal(Math.max(meta.width, meta.height), 768);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/ai-id/proxy-e2e.test.mjs`
Expected: initially FAIL only if an upstream module is missing; with Tasks 4–7 done it should PASS. If it fails, fix the offending module before continuing.

- [ ] **Step 3: (no new code — integration wiring only)**

If the test fails on `chromaSubsampling`, confirm `nodeEncodeJpeg` passes `chromaSubsampling: "4:2:0"`. If it fails on dims, confirm `targetDims` math in `proxy.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/ai-id/proxy-e2e.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add web/ai-id/proxy-e2e.test.mjs
git commit -m "test(ai-id): end-to-end RAW→proxy chain"
```

---

### Task 9: batch CLI — sidecars + manifest for a folder

**Files:**
- Create: `web/ai-id/export.mjs`
- Test: `web/ai-id/export.test.mjs`

**Behaviour:** `exportFolder(dir, { outDir })` scans `dir` for supported RAWs, decodes each,
writes `<base>.ai.json` (sidecar) into `outDir` (default = `dir`), and writes a `manifest.json`.
Returns `{ sidecars: string[], manifestPath: string }`. A `main()` wraps it for CLI use
(`node web/ai-id/export.mjs <dir> [outDir]`).

- [ ] **Step 1: Write the failing test**

```javascript
// web/ai-id/export.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportFolder } from "./export.mjs";

test("exportFolder writes a lean sidecar + manifest for a folder of RAWs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiid-"));
  copyFileSync("c:/Foo/raw-converter/tests/ADH 1248.CR2", join(dir, "ADH 1248.CR2"));
  const { sidecars, manifestPath } = await exportFolder(dir, {});
  assert.equal(sidecars.length, 1);

  const sc = JSON.parse(readFileSync(join(dir, "ADH 1248.ai.json"), "utf8"));
  assert.equal(sc.schema, "casava-ai/1");
  assert.equal(sc.source.format, "cr2");
  assert.equal(sc.image.width, 6000);
  assert.equal("camera" in sc, false); // lean: no photographic EXIF

  assert.ok(existsSync(manifestPath));
  const mf = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(mf.schema, "casava-ai-manifest/1");
  assert.equal(mf.count, 1);
  assert.equal(mf.items[0].name, "ADH 1248.CR2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/ai-id/export.test.mjs`
Expected: FAIL — `Cannot find module './export.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// web/ai-id/export.mjs
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, decodeRaw, SUPPORTED_RAW } from "./decode.mjs";
import { buildSidecar } from "./sidecar.mjs";
import { buildManifest } from "./manifest.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Decode one RAW → lean sidecar object (no proxy generated/stored). */
async function sidecarForFile(path) {
  const bytes = readFileSync(path);
  const { result, width, height } = await decodeRaw(path);
  return buildSidecar({
    filename: basename(path), sha256: sha256(bytes), bytes: bytes.length,
    format: extname(path).toLowerCase().slice(1),
    width, height, orientationApplied: true,
    datetimeExif: result.datetime,
    decoded: result,
  });
}

export async function exportFolder(dir, { outDir } = {}) {
  await initWasm();
  const dest = outDir ?? dir;
  const files = readdirSync(dir).filter((f) => SUPPORTED_RAW.has(extname(f).toLowerCase()) && statSync(join(dir, f)).isFile());
  const sidecars = [];
  const entries = [];
  for (const f of files) {
    const sc = await sidecarForFile(join(dir, f));
    const sidecarName = f.replace(/\.[^.]+$/, "") + ".ai.json";
    writeFileSync(join(dest, sidecarName), JSON.stringify(sc, null, 2));
    sidecars.push(sidecarName);
    entries.push({ name: f, sidecar: sidecarName, sha256: sc.source.sha256, hasGeo: sc.geo != null, width: sc.image.width, height: sc.image.height });
  }
  const manifestPath = join(dest, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(buildManifest(entries), null, 2));
  return { sidecars, manifestPath };
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, outDir] = process.argv.slice(2);
  if (!dir) { console.error("usage: node web/ai-id/export.mjs <dir> [outDir]"); process.exit(1); }
  exportFolder(dir, { outDir }).then((r) => console.log(`wrote ${r.sidecars.length} sidecars + ${r.manifestPath}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/ai-id/export.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add web/ai-id/export.mjs web/ai-id/export.test.mjs
git commit -m "feat(ai-id): batch CLI writes sidecars + manifest"
```

---

### Task 10: README + full test run

**Files:**
- Create: `web/ai-id/README.md`

- [ ] **Step 1: Write the README**

```markdown
# web/ai-id — AI identification foundation

Facilitates external plant/animal ID (no classifier). Emits a lean `casava-ai/1` metadata
sidecar per image + a folder `manifest.json`, and generates a 768px q80 4:2:0 JPEG proxy
**on demand** — never stored. See `docs/superpowers/specs/2026-07-10-ai-id-foundation-design.md`.

## Batch metadata

    node web/ai-id/export.mjs <folder> [outDir]

Writes `<name>.ai.json` (source, output dims, sRGB colour, ISO datetime, decimal geo) beside
each RAW, plus `manifest.json`. Photographic EXIF stays in the master RAW (not duplicated here).

## On-demand proxy

`resolveProxy(sources, opts)` walks a source-priority chain and encodes the first available:
live buffer → pyramid 1024 level → embedded preview (≥768) → master decode → RAW re-decode.
Node callers inject `nodeEncodeJpeg` + `raw.downscale_rgba`; browser callers inject a canvas
encoder and OPFS/pyramid byte getters. See `sources.mjs` for the constructors.

## Empirical basis

Proxy parameters (768px / q80 / 4:2:0 / direct downscale) were chosen from the bake-offs in
`ai-id-bakeoff/` (iNaturalist + Gemini across resolution, quality, and chroma sweeps).

## Tests

    node --test web/ai-id/
```

- [ ] **Step 2: Run the whole suite**

Run: `node --test web/ai-id/`
Expected: PASS — all tests across datetime-geo, sidecar, manifest, embedded-preview, proxy, decode, sources, proxy-e2e, export.

- [ ] **Step 3: Commit**

```bash
git add web/ai-id/README.md
git commit -m "docs(ai-id): foundation README"
```

---

## Deferred (documented, not in this plan)

These are real follow-ups; each is out of scope for v1 and noted so the wiring isn't forgotten:

- **Browser lightbox hook** — a "Prepare ID proxy" action that builds `[liveBufferSource(currentPixels), pyramidLevelSource(getOpfsLevel, facadeDecode), embeddedPreviewSource(...), masterDecodeSource(...), rawDecodeSource(...)]` and calls `resolveProxy` with a **canvas** JPEG encoder (`canvas.toBlob("image/jpeg", 0.8)` → but canvas gives 4:2:0 already) instead of `nodeEncodeJpeg`. The source constructors are already platform-neutral and unit-tested.
- **Pyramid byte retrieval** — an OPFS/manifest adapter that returns the stored 1024-level JXL bytes for an image (`packages/pyramid-ingest` storage). Feeds `pyramidLevelSource`.
- **Export integration into the real converter** — call `sidecarForFile` + append to `manifest.json` at the point the `.jxl` master is written, so every export drops a sidecar. (v1 CLI proves the logic standalone.)
- **JXL-embedded EXIF** — preserve full photographic EXIF *inside* the `.jxl` via the `bridge.cpp` metadata-box path, reusing the same field set. This is the home for camera/lens/ISO/exposure (deliberately excluded from the lean sidecar).

## Success criteria (from the spec)

1. Every exported image gets a valid `casava-ai/1` sidecar, `geo` populated when GPS present — **Task 9**.
2. `resolveProxy` returns a 768px q80 4:2:0 JPEG from the first available source, recording which — **Tasks 5, 7, 8**.
3. A folder export produces a `manifest.json` indexing every sidecar — **Task 9**.
4. No standing per-image proxy is ever written — **Tasks 5–9** (proxy is return-only; nothing writes it).
5. Existing export behaviour unchanged — new files only; no edits to existing modules in v1.
