# Codec Paper Comparison Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `CodecPaperTest.mjs` — a paper-comparison suite that runs our WASM JXL, original libjxl (`@jsquash/jxl`), and JPEG/WebP/AVIF/PNG (native + WASM) over a hybrid corpus (Kodak 24 + our 8 RAW-derived), producing rate-distortion curves, a Pareto plot, an ours-vs-original-JXL delta, a BD-rate table, and a `figures.html` gallery.

**Architecture:** Reuse Part-1 modules (adapters, butteraugli search, JXL loader/quality). Add a `jxl_orig` adapter, a Kodak fetcher, and four new **pure** modules (`rd-sweep`, `bd-rate`, `svg-figures`, `codec-paper-serialize`) each unit-tested, plus an orchestrator. Figures are hand-rolled static SVG strings.

**Tech Stack:** Node ESM, `@jsquash/{jpeg,webp,avif,jxl}` (WASM), `sharp` (native), facade `computeButteraugli` + `PerceptualComparer` (quality), hand-rolled SVG. Tests via `node --test`.

**Spec:** `docs/superpowers/specs/2026-07-05-codec-paper-suite-design.md`
**Worktree/branch:** `C:/Foo/rcw-codec-compare` on `feat/codec-compare-benchmark`.
**Constraint:** Do NOT modify `StandardMultifileTest.mjs`.

---

## Task 1: `jxl_orig` adapter (original libjxl)

**Files:**
- Modify: `benchmark/codec-adapters.mjs`
- Test: `benchmark/test/codec-adapters.test.mjs` (extend existing)

- [ ] **Step 1: Extend the round-trip test to require jxl_orig**

Add to `benchmark/test/codec-adapters.test.mjs` after the existing tests:
```js
test("jxl_orig adapter present, wasm, round-trips", async () => {
  const a = ADAPTERS.find(x => x.key === "jxl_orig");
  assert.ok(a, "jxl_orig adapter missing");
  assert.equal(a.runtime, "wasm");
  const bytes = await a.encode(rgba, w, h, 75);
  assert.ok(bytes.length > 0);
  const back = await a.decode(bytes);
  assert.equal(back.width, w);
  assert.equal(back.data.length, w * h * 4);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test benchmark/test/codec-adapters.test.mjs`
Expected: FAIL — `jxl_orig adapter missing`.

- [ ] **Step 3: Add the jxl_orig adapter**

In `benchmark/codec-adapters.mjs`, add imports near the other @jsquash imports:
```js
import jxlEnc, { init as initJxlEnc } from "@jsquash/jxl/encode.js";
import jxlDec, { init as initJxlDec } from "@jsquash/jxl/decode.js";
```
Add the init pair next to the other `onceInit` lines:
```js
const ensureJxlEnc = onceInit(initJxlEnc, "@jsquash/jxl/encode.js", "codec/enc/jxl_enc.wasm");
const ensureJxlDec = onceInit(initJxlDec, "@jsquash/jxl/decode.js", "codec/dec/jxl_dec.wasm");
```
The existing `jsquashAdapter` passes `{ [qKey]: quality, ...encOpts }`; pass `effort:3` via encOpts. Add to the `ADAPTERS` array (after `avif_wasm`):
```js
  jsquashAdapter("jxl_orig", jxlEnc, jxlDec, ensureJxlEnc, ensureJxlDec, { effort: 3 }),
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test benchmark/test/codec-adapters.test.mjs`
Expected: PASS (all tests incl. jxl_orig).

- [ ] **Step 5: Commit**

```bash
git add benchmark/codec-adapters.mjs benchmark/test/codec-adapters.test.mjs
git commit -m "feat(codec-paper): add jxl_orig (@jsquash/jxl) adapter at matched effort 3"
```

- [ ] **Step 6: Make our JXL adapter quality-parametric**

Our JXL needs a real RD curve, so `makeJxlAdapter` must accept a swept quality (the facade maps `quality`→distance; verified monotonic q30=81KB→q95=570KB). In `benchmark/codec-compare-jxl.mjs`, add an `encode(rgba, w, h, quality)` method to the object returned by `makeJxlAdapter` (keep `encodeAnchor` for other callers), mirroring `encodeAnchor` but with `quality: quality` and NO fixed `distance`:
```js
    async encode(rgba, w, h, quality) {
      const encoder = facade.createEncoder({
        format: "rgba8", width: w, height: h, hasAlpha: true,
        iccProfile: null, exif: null, xmp: null,
        quality, effort: 3,
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
```

- [ ] **Step 7: Smoke-test the quality-parametric JXL encode**

Run:
```bash
node -e "import('./benchmark/codec-compare-jxl.mjs').then(async m=>{await m.initCodecCompareJxl(); const r=await m.loadTargetRgba('C:/Foo/raw-converter/tests/P1110226.ORF'); const a=m.makeJxlAdapter(); const b30=(await a.encode(r.rgba,r.tgtW,r.tgtH,30)).length, b90=(await a.encode(r.rgba,r.tgtW,r.tgtH,90)).length; console.log('jxl q30',b30,'q90',b90, b30<b90?'OK':'FAIL');})" 2>&1 | grep -vE "jxl-enc-bridge|take_chunk" | tail -1
```
Expected: `jxl q30 <smaller> q90 <larger> OK`.

- [ ] **Step 8: Commit**

```bash
git add benchmark/codec-compare-jxl.mjs
git commit -m "feat(codec-paper): quality-parametric encode on JXL adapter for RD sweep"
```

---

## Task 2: Kodak corpus fetcher

**Files:**
- Create: `scripts/fetch-kodak.mjs`

- [ ] **Step 1: Write the fetcher**

Create `scripts/fetch-kodak.mjs`:
```js
// Idempotent Kodak 24 download. Skips files already present. Node 18+ global fetch.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "outputs", "codec-paper", "corpus", "kodak");
const BASE = "https://r0k.us/graphics/kodak/kodak";

export async function fetchKodak({ log = console.log } = {}) {
  mkdirSync(OUT, { recursive: true });
  const got = [];
  for (let i = 1; i <= 24; i++) {
    const name = `kodim${String(i).padStart(2, "0")}.png`;
    const dest = join(OUT, name);
    if (existsSync(dest)) { got.push(dest); continue; }
    try {
      const res = await fetch(`${BASE}/${name}`);
      if (!res.ok) { log(`  [!] ${name}: HTTP ${res.status}`); continue; }
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      got.push(dest);
      log(`  fetched ${name}`);
    } catch (e) { log(`  [!] ${name}: ${e.message}`); }
  }
  return got;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("fetch-kodak.mjs")) {
  fetchKodak().then(g => console.log(`Kodak: ${g.length}/24 present at ${OUT}`));
}
```

- [ ] **Step 2: Run it (smoke)**

Run: `node scripts/fetch-kodak.mjs`
Expected: `Kodak: N/24 present ...` with N up to 24. If offline, N may be 0 — that is acceptable (orchestrator falls back to raw-only); note the count.

- [ ] **Step 3: Ignore the fetched corpus in git**

Append to `.gitignore` (create the line if the file lacks it):
```
docs/outputs/codec-paper/corpus/
```

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-kodak.mjs .gitignore
git commit -m "feat(codec-paper): idempotent Kodak 24 corpus fetcher"
```

---

## Task 3: RD sweep (pure)

**Files:**
- Create: `benchmark/rd-sweep.mjs`
- Test: `benchmark/test/rd-sweep.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `benchmark/test/rd-sweep.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepQualityLadder, DEFAULT_LADDER } from "../rd-sweep.mjs";

// fake codec: encode returns q*10 bytes; decode echoes the byte length so metrics can vary by q.
const fake = {
  key: "fake", runtime: "wasm",
  async encode(rgba, w, h, q) { return new Uint8Array(q * 10); },
  async decode(bytes) { return { data: new Uint8Array([bytes.length & 0xff]), width: 2, height: 2, _n: bytes.length }; },
};
// metrics injected: butteraugli falls as bytes rise; ssim fixed.
const metrics = async (decoded) => ({ butteraugli: 1000 / decoded._n, ssim: 0.99 });

test("returns one point per ladder quality with bytes/bpp/butter/ssim from injected metrics", async () => {
  const pts = await sweepQualityLadder(fake, { rgba: new Uint8Array(), width: 2, height: 2, npx: 100, metrics, ladder: [25, 50, 100] });
  assert.equal(pts.length, 3);
  assert.deepEqual(pts.map(p => p.quality), [25, 50, 100]);
  assert.equal(pts[1].bytes, 500);            // q=50 -> 500 bytes
  assert.equal(pts[1].bpp, (500 * 8) / 100);  // bpp = bytes*8/npx
  assert.equal(pts[2].butteraugli, 1000 / 1000); // q=100 -> 1000 bytes -> butter 1.0
  assert.ok(pts.every(p => p.ssim === 0.99 && p.codec === "fake" && p.runtime === "wasm"));
});

test("DEFAULT_LADDER is 8 ascending points in 1..100", () => {
  assert.equal(DEFAULT_LADDER.length, 8);
  assert.deepEqual([...DEFAULT_LADDER].sort((a,b)=>a-b), DEFAULT_LADDER);
  assert.ok(DEFAULT_LADDER[0] >= 1 && DEFAULT_LADDER.at(-1) <= 100);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test benchmark/test/rd-sweep.test.mjs`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `benchmark/rd-sweep.mjs`:
```js
// Pure quality-ladder sweep for one codec over one image. Encodes + decodes ONCE per
// ladder point; `metrics(decodedData)` (injected) returns {butteraugli, ssim} so this
// is unit-testable without WASM and never double-encodes.
export const DEFAULT_LADDER = [30, 45, 55, 65, 75, 85, 92, 98];

// codec: { key, runtime, encode(rgba,w,h,q)->bytes(Uint8Array), decode(bytes)->{data,...} }
// metrics: async (decoded) -> { butteraugli, ssim }
export async function sweepQualityLadder(codec, { rgba, width, height, npx, metrics, ladder = DEFAULT_LADDER }) {
  const pts = [];
  for (const q of ladder) {
    const bytes = await codec.encode(rgba, width, height, q);
    const decoded = await codec.decode(bytes);
    const { butteraugli, ssim } = await metrics(decoded);
    pts.push({ codec: codec.key, runtime: codec.runtime, quality: q, bytes: bytes.length, bpp: (bytes.length * 8) / npx, butteraugli, ssim });
  }
  return pts;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test benchmark/test/rd-sweep.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmark/rd-sweep.mjs benchmark/test/rd-sweep.test.mjs
git commit -m "feat(codec-paper): pure RD quality-ladder sweep + tests"
```

---

## Task 4: BD-rate (Bjøntegaard, pure)

**Files:**
- Create: `benchmark/bd-rate.mjs`
- Test: `benchmark/test/bd-rate.test.mjs`

Implements the **linear (trapezoidal) BD-rate**: average horizontal (log-rate) distance between two RD curves over their overlapping distortion range, expressed as a percentage. Distortion axis is butteraugli (lower = better) so lower rate at equal distortion = better codec → negative BD-rate = bytes saved.

- [ ] **Step 1: Write the failing test**

Create `benchmark/test/bd-rate.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { bdRate } from "../bd-rate.mjs";

// curve = array of {bpp, butteraugli}. Distortion = butteraugli.
const ref = [{ bpp: 1, butteraugli: 4 }, { bpp: 2, butteraugli: 3 }, { bpp: 4, butteraugli: 2 }, { bpp: 8, butteraugli: 1 }];

test("identical curves -> ~0%", () => {
  assert.ok(Math.abs(bdRate(ref, ref)) < 1e-6);
});

test("test curve at half the rate everywhere -> ~ -50%", () => {
  const half = ref.map(p => ({ bpp: p.bpp / 2, butteraugli: p.butteraugli }));
  const bd = bdRate(ref, half); // half uses 50% of ref bytes at equal quality
  assert.ok(bd < -49 && bd > -51, `bd=${bd}`);
});

test("returns null when distortion ranges do not overlap", () => {
  const disjoint = [{ bpp: 1, butteraugli: 10 }, { bpp: 2, butteraugli: 8 }];
  assert.equal(bdRate(ref, disjoint), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test benchmark/test/bd-rate.test.mjs`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `benchmark/bd-rate.mjs`:
```js
// Linear (trapezoidal) BD-rate. ref/test = [{bpp, butteraugli}, ...].
// Returns percent change in rate of `test` vs `ref` at equal distortion,
// integrated over the overlapping butteraugli range. Negative = test smaller.
// Returns null if the curves share no distortion overlap or have <2 points.
function sortByDist(curve) {
  // ascending distortion (butteraugli). Use log10(bpp) for the rate integral.
  return [...curve].filter(p => p.bpp > 0 && Number.isFinite(p.butteraugli))
    .sort((a, b) => a.butteraugli - b.butteraugli)
    .map(p => ({ d: p.butteraugli, r: Math.log10(p.bpp) }));
}
function interpRate(pts, d) {
  // linear interpolation of rate at distortion d; pts ascending in d.
  if (d <= pts[0].d) return pts[0].r;
  if (d >= pts.at(-1).d) return pts.at(-1).r;
  for (let i = 1; i < pts.length; i++) {
    if (d <= pts[i].d) {
      const t = (d - pts[i-1].d) / (pts[i].d - pts[i-1].d);
      return pts[i-1].r + t * (pts[i].r - pts[i-1].r);
    }
  }
  return pts.at(-1).r;
}
export function bdRate(ref, test) {
  const R = sortByDist(ref), T = sortByDist(test);
  if (R.length < 2 || T.length < 2) return null;
  const lo = Math.max(R[0].d, T[0].d);
  const hi = Math.min(R.at(-1).d, T.at(-1).d);
  if (!(hi > lo)) return null;
  // integrate (rate_test - rate_ref) d(distortion) via trapezoid on a fine grid, then average.
  const N = 100;
  let acc = 0;
  for (let i = 0; i < N; i++) {
    const d0 = lo + (hi - lo) * (i / N);
    const d1 = lo + (hi - lo) * ((i + 1) / N);
    const f0 = interpRate(T, d0) - interpRate(R, d0);
    const f1 = interpRate(T, d1) - interpRate(R, d1);
    acc += 0.5 * (f0 + f1) * (d1 - d0);
  }
  const avgLogRatio = acc / (hi - lo);       // mean log10(rate_test/rate_ref)
  return (Math.pow(10, avgLogRatio) - 1) * 100;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test benchmark/test/bd-rate.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmark/bd-rate.mjs benchmark/test/bd-rate.test.mjs
git commit -m "feat(codec-paper): trapezoidal BD-rate + tests"
```

---

## Task 5: SVG figures (pure)

**Files:**
- Create: `benchmark/svg-figures.mjs`
- Test: `benchmark/test/svg-figures.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `benchmark/test/svg-figures.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { rdCurve, barChart } from "../svg-figures.mjs";

test("rdCurve emits an svg with one polyline per series + axis labels", () => {
  const svg = rdCurve({
    series: [
      { label: "jxl", color: "#f00", points: [{ x: 1, y: 4 }, { x: 4, y: 1 }] },
      { label: "jpeg", color: "#00f", points: [{ x: 2, y: 4 }, { x: 8, y: 1 }] },
    ],
    xLabel: "bpp", yLabel: "butteraugli", width: 800, height: 500,
  });
  assert.match(svg, /^<svg[^>]*viewBox="0 0 800 500"/);
  assert.equal((svg.match(/<polyline/g) || []).length, 2);
  assert.match(svg, />bpp<\/text>/);
  assert.match(svg, />butteraugli<\/text>/);
  assert.match(svg, />jxl<\/text>/); // legend
});

test("barChart emits one rect per bar and labels", () => {
  const svg = barChart({ bars: [{ label: "jxl", value: 10, color: "#f00" }, { label: "jpeg", value: 20, color: "#00f" }], yLabel: "bytes", width: 600, height: 400 });
  assert.equal((svg.match(/<rect/g) || []).length >= 2, true);
  assert.match(svg, />jxl<\/text>/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test benchmark/test/svg-figures.test.mjs`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `benchmark/svg-figures.mjs`:
```js
// Pure static-SVG figure generators (strings). No DOM, no deps.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const PAD = { l: 70, r: 160, t: 30, b: 60 }; // right pad leaves room for legend

function frame(width, height, xLabel, yLabel, extra = "") {
  return { width, height, plotW: width - PAD.l - PAD.r, plotH: height - PAD.t - PAD.b, xLabel, yLabel, extra };
}
function axes(f, xTicks, yTicks) {
  const x0 = PAD.l, y0 = f.height - PAD.b, x1 = f.width - PAD.r, y1 = PAD.t;
  let s = `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="#444"/>`;
  s += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}" stroke="#444"/>`;
  for (const t of xTicks) s += `<line x1="${t.px}" y1="${y0}" x2="${t.px}" y2="${y0+5}" stroke="#444"/><text x="${t.px}" y="${y0+20}" font-size="12" text-anchor="middle" fill="#333">${esc(t.label)}</text>`;
  for (const t of yTicks) s += `<line x1="${x0-5}" y1="${t.py}" x2="${x0}" y2="${t.py}" stroke="#444"/><text x="${x0-10}" y="${t.py+4}" font-size="12" text-anchor="end" fill="#333">${esc(t.label)}</text>`;
  s += `<text x="${(x0+x1)/2}" y="${f.height-15}" font-size="14" text-anchor="middle" fill="#111">${esc(f.xLabel)}</text>`;
  s += `<text x="18" y="${(y0+y1)/2}" font-size="14" text-anchor="middle" fill="#111" transform="rotate(-90 18 ${(y0+y1)/2})">${esc(f.yLabel)}</text>`;
  return s;
}
function legend(f, items) {
  const x = f.width - PAD.r + 15; let y = PAD.t + 10; let s = "";
  for (const it of items) { s += `<rect x="${x}" y="${y-9}" width="12" height="12" fill="${it.color}"/><text x="${x+18}" y="${y+1}" font-size="12" fill="#111">${esc(it.label)}</text>`; y += 20; }
  return s;
}
const ticks = (min, max, n, toPx, fmt = (v)=>v.toFixed(1)) =>
  Array.from({length: n+1}, (_, i) => { const v = min + (max-min)*i/n; return { v, label: fmt(v), ...toPx(v) }; });

export function rdCurve({ series, xLabel = "bpp", yLabel = "butteraugli", width = 800, height = 500 }) {
  const f = frame(width, height, xLabel, yLabel);
  const xs = series.flatMap(s => s.points.map(p => p.x));
  const ys = series.flatMap(s => s.points.map(p => p.y));
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const px = (x) => PAD.l + (xmax===xmin?0:(x-xmin)/(xmax-xmin))*f.plotW;
  const py = (y) => PAD.t + (ymax===ymin?0:(1-(y-ymin)/(ymax-ymin)))*f.plotH;
  let body = axes(f, ticks(xmin, xmax, 5, v=>({px:px(v)})), ticks(ymin, ymax, 5, v=>({py:py(v)})));
  for (const s of series) {
    const pts = s.points.map(p => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
    body += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
    for (const p of s.points) body += `<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="3" fill="${s.color}"/>`;
  }
  body += legend(f, series);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="sans-serif"><rect width="${width}" height="${height}" fill="#fff"/>${body}</svg>`;
}

export function paretoPlot(opts) { return rdCurve({ ...opts, xLabel: opts.xLabel || "encode ms", yLabel: opts.yLabel || "bpp" }); }

export function barChart({ bars, yLabel = "value", xLabel = "", width = 600, height = 400 }) {
  const f = frame(width, height, xLabel, yLabel);
  const max = Math.max(...bars.map(b => b.value), 1);
  const bw = f.plotW / (bars.length * 1.5);
  const py = (v) => PAD.t + (1 - v/max) * f.plotH;
  let body = axes(f, [], ticks(0, max, 5, v=>({py:py(v)}), v=>v.toFixed(0)));
  bars.forEach((b, i) => {
    const x = PAD.l + (i + 0.25) * (f.plotW / bars.length);
    const y = py(b.value), h = (f.height - PAD.b) - y;
    body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${b.color}"/>`;
    body += `<text x="${(x+bw/2).toFixed(1)}" y="${f.height-PAD.b+18}" font-size="11" text-anchor="middle" fill="#333">${esc(b.label)}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="sans-serif"><rect width="${width}" height="${height}" fill="#fff"/>${body}</svg>`;
}

// grouped delta bars (e.g. size%/enc%/dec% of ours vs original jxl); reuses barChart per group is enough for v1.
export function deltaChart({ groups, yLabel = "% of original", width = 700, height = 420 }) {
  // groups = [{ label, value, color }] already flattened by the caller (e.g. "size", "enc", "dec").
  return barChart({ bars: groups, yLabel, width, height });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test benchmark/test/svg-figures.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmark/svg-figures.mjs benchmark/test/svg-figures.test.mjs
git commit -m "feat(codec-paper): pure SVG figure generators (rd/pareto/bar/delta) + tests"
```

---

## Task 6: Data serializer + registry family

**Files:**
- Create: `benchmark/codec-paper-serialize.mjs`
- Modify: `benchmark/benchmark-history-registry.mjs`
- Test: `benchmark/test/codec-paper-serialize.test.mjs`, `benchmark/test/codec-paper-family.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `benchmark/test/codec-paper-serialize.test.mjs`:
```js
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
```

Create `benchmark/test/codec-paper-family.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveFamilyIdFromArtifactName, familyLabelFromId, familyColorFromId } from "../benchmark-history-registry.mjs";

test("codec-paper family resolves stably, no collision", () => {
  for (const ts of ["2026-07-05t00-00-00-000z", "2026-07-06t00-00-00-000z"]) {
    assert.equal(deriveFamilyIdFromArtifactName(`${ts}-CodecPaper-general.toon`, "CodecPaper - general"), "codec-paper");
  }
  assert.equal(familyLabelFromId("codec-paper"), "Codec Paper");
  assert.equal(familyColorFromId("codec-paper"), "#14b8a6");
  assert.equal(deriveFamilyIdFromArtifactName("x-CodecCompare-general.toon", "CodecCompare - general"), "codec-compare");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test benchmark/test/codec-paper-serialize.test.mjs benchmark/test/codec-paper-family.test.mjs`
Expected: FAIL (module missing; family unresolved).

- [ ] **Step 3: Implement serializer**

Create `benchmark/codec-paper-serialize.mjs`:
```js
const f2 = (x) => (x == null ? "" : Number(x).toFixed(2));
const r0 = (x) => (x == null ? "" : Math.round(x));

export function buildPaperToon({ sweep, fixed, bdRates, batchName, runTimestamp }) {
  const L = [
    `TestName: CodecPaper - ${batchName}`,
    `RunTimestamp: ${runTimestamp}`,
    `Quality parity: butteraugli via facade computeButteraugli (p3); ours vs jxl_orig at matched effort 3`,
    "# CAVEAT: native (sharp) vs wasm (@jsquash, ours) ENC/DEC MS NOT COMPARABLE ACROSS RUNTIMES. SIZE + QUALITY ARE.",
    "",
    "# RD sweep (image|class|codec|runtime|quality|bytes|bpp|butteraugli|ssim)",
  ];
  for (const s of sweep) L.push(`  ${s.image} | ${s.class} | ${s.codec} | ${s.runtime} | ${s.quality} | ${s.bytes} | ${f2(s.bpp)} | ${f2(s.butteraugli)} | ${f2(s.ssim)}`);
  L.push("", "# Fixed-quality point ~butteraugli 1.5 (image|class|codec|runtime|quality|butteraugli|bytes|bpp|enc_ms|dec_ms)");
  for (const p of fixed) L.push(`  ${p.image} | ${p.class} | ${p.codec} | ${p.runtime} | ${p.quality} | ${f2(p.butteraugli)} | ${p.bytes} | ${f2(p.bpp)} | ${r0(p.enc_ms)} | ${r0(p.dec_ms)}`);
  L.push("", "# BD-rate vs jpeg_native (percent bytes vs baseline at equal quality; negative=smaller)");
  for (const [codec, bd] of Object.entries(bdRates || {})) L.push(`BDRate_${codec}: ${bd == null ? "" : Number(bd).toFixed(1)}`);
  return L.join("\n");
}
```

- [ ] **Step 4: Add registry family branch**

In `benchmark/benchmark-history-registry.mjs`:
- In `FAMILY_LABEL_OVERRIDES`, after the `codec-compare` entry add: `["codec-paper", "Codec Paper"],`
- In `FAMILY_COLOR_OVERRIDES`, after the `codec-compare` entry add: `["codec-paper", "#14b8a6"],`
- In `deriveFamilyIdFromArtifactName`, immediately before the `codeccompare` check add: `if (candidates.some((value) => value.includes("codecpaper"))) return "codec-paper";`

- [ ] **Step 5: Run to verify they pass**

Run: `node --test benchmark/test/codec-paper-serialize.test.mjs benchmark/test/codec-paper-family.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add benchmark/codec-paper-serialize.mjs benchmark/benchmark-history-registry.mjs benchmark/test/codec-paper-serialize.test.mjs benchmark/test/codec-paper-family.test.mjs
git commit -m "feat(codec-paper): data toon serializer + codec-paper graph family"
```

---

## Task 7: Orchestrator + figures.html

**Files:**
- Create: `CodecPaperTest.mjs`
- Create: `benchmark/codec-paper-figures.mjs` (assembles figure data → SVG files + html)

- [ ] **Step 1: Implement the figures assembler**

Create `benchmark/codec-paper-figures.mjs`:
```js
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { rdCurve, paretoPlot, barChart, deltaChart } from "./svg-figures.mjs";

const PALETTE = { jxl: "#e11d48", jxl_orig: "#0ea5e9", jpeg_native: "#f59e0b", jpeg_wasm: "#fbbf24", webp_native: "#10b981", webp_wasm: "#34d399", avif_native: "#8b5cf6", avif_wasm: "#a78bfa", png_native: "#6b7280" };

// avg a metric across images per codec at each ladder quality -> RD points {x:bpp, y:metric}
function rdSeries(sweep, yKey) {
  const byCodec = new Map();
  for (const s of sweep) { if (!byCodec.has(s.codec)) byCodec.set(s.codec, new Map()); const m = byCodec.get(s.codec); if (!m.has(s.quality)) m.set(s.quality, []); m.get(s.quality).push(s); }
  const series = [];
  for (const [codec, qmap] of byCodec) {
    const points = [...qmap.entries()].map(([, arr]) => ({ x: avg(arr, r=>r.bpp), y: avg(arr, r=>r[yKey]) })).sort((a,b)=>a.x-b.x);
    series.push({ label: codec, color: PALETTE[codec] || "#000", points });
  }
  return series;
}
const avg = (arr, sel) => arr.reduce((s,x)=>s+sel(x),0) / arr.length;

export function writeFigures({ outDir, sweep, fixed, bdRates }) {
  const figDir = join(outDir, "figures");
  mkdirSync(figDir, { recursive: true });
  const files = {};
  files["rd-butteraugli.svg"] = rdCurve({ series: rdSeries(sweep, "butteraugli"), xLabel: "bpp", yLabel: "butteraugli (lower=better)" });
  files["rd-ssim.svg"] = rdCurve({ series: rdSeries(sweep, "ssim"), xLabel: "bpp", yLabel: "SSIM (higher=better)" });
  // pareto: native + wasm split at fixed point
  const paretoSeries = (rt) => [{ label: rt, color: "#333", points: fixed.filter(p=>p.runtime===rt).map(p=>({x:p.enc_ms, y:p.bpp})) }];
  files["pareto-enc-time.svg"] = paretoPlot({ series: [
    { label: "native", color: "#f59e0b", points: fixed.filter(p=>p.runtime==="native").map(p=>({x:p.enc_ms,y:p.bpp})) },
    { label: "wasm", color: "#0ea5e9", points: fixed.filter(p=>p.runtime==="wasm").map(p=>({x:p.enc_ms,y:p.bpp})) },
  ], xLabel: "encode ms (NOT comparable across runtimes)", yLabel: "bpp @ butteraugli~1.5" });
  // ours vs original jxl delta at fixed point (avg over images)
  const ours = fixed.filter(p=>p.codec==="jxl"), orig = fixed.filter(p=>p.codec==="jxl_orig");
  const pct = (a,b,key) => (avg(a,r=>r[key]) / avg(b,r=>r[key])) * 100;
  files["ours-vs-orig-jxl.svg"] = deltaChart({ groups: [
    { label: "size %", value: pct(ours,orig,"bytes"), color: "#e11d48" },
    { label: "enc %", value: pct(ours,orig,"enc_ms"), color: "#0ea5e9" },
    { label: "dec %", value: pct(ours,orig,"dec_ms"), color: "#10b981" },
  ], yLabel: "ours as % of original libjxl (100 = parity)" });
  // size/time bars at fixed point (avg bytes per codec)
  const codecs = [...new Set(fixed.map(p=>p.codec))];
  files["bars-size-time.svg"] = barChart({ bars: codecs.map(c=>({ label: c, value: avg(fixed.filter(p=>p.codec===c), r=>r.bytes)/1024, color: PALETTE[c]||"#000" })), yLabel: "KB @ butteraugli~1.5" });
  for (const [name, svg] of Object.entries(files)) writeFileSync(join(figDir, name), svg);
  // gallery
  const bdRows = Object.entries(bdRates||{}).map(([c,v])=>`<tr><td>${c}</td><td>${v==null?"":v.toFixed(1)+"%"}</td></tr>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><title>Codec Paper Figures</title>
<style>body{font-family:sans-serif;max-width:900px;margin:2rem auto}img{width:100%;border:1px solid #eee;margin:.5rem 0}h2{margin-top:2rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 10px}</style>
<h1>Codec comparison figures</h1>
<p><b>Caveat:</b> native (sharp, MT+SIMD) vs WASM (@jsquash, ours) encode/decode times are not comparable across runtimes; size and quality are.</p>
${Object.keys(files).map(n=>`<h2>${n.replace(".svg","")}</h2><img src="figures/${n}" alt="${n}">`).join("\n")}
<h2>BD-rate vs jpeg_native (negative = fewer bytes at equal quality)</h2>
<table><tr><th>codec</th><th>BD-rate</th></tr>${bdRows}</table>`;
  writeFileSync(join(outDir, "figures.html"), html);
  return { figDir, count: Object.keys(files).length };
}
```

- [ ] **Step 2: Implement the orchestrator**

Create `CodecPaperTest.mjs`:
```js
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { fetchKodak } from "./scripts/fetch-kodak.mjs";
import { initCodecCompareJxl, loadTargetRgba, perceptualComparer, butteraugliDistance, makeJxlAdapter } from "./benchmark/codec-compare-jxl.mjs";
import { ADAPTERS } from "./benchmark/codec-adapters.mjs";
import { sweepQualityLadder } from "./benchmark/rd-sweep.mjs";
import { searchQuality } from "./benchmark/butteraugli-search.mjs";
import { bdRate } from "./benchmark/bd-rate.mjs";
import { buildPaperToon } from "./benchmark/codec-paper-serialize.mjs";
import { writeFigures } from "./benchmark/codec-paper-figures.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(scriptDir, "docs", "outputs", "codec-paper");
const N_TIME = 3;
const median = (a) => { const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
async function timeMs(fn){ const t=performance.now(); await fn(); return performance.now()-t; }
async function medMs(n, fn){ const o=[]; for(let i=0;i<n;i++) o.push(await timeMs(fn)); return median(o); }

// RAW standard files (reuse Part-1 resolution)
const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`, GOB_ROOT = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const RAW_FILES = [
  join(TEST_ROOT,"P1110226.ORF"), join(GOB_ROOT,"P2200474.ORF"),
  join(TEST_ROOT,"_MG_1750.CR2"), join(TEST_ROOT,"ADH 1248.CR2"),
  join(TEST_ROOT,"PXL_20260527_180319603.RAW-02.ORIGINAL.dng"), join(TEST_ROOT,"PXL_20260501_093507165.RAW-02.ORIGINAL.dng"),
].filter(existsSync);

async function loadCorpus(log) {
  const corpus = [];
  const kodak = await fetchKodak({ log });
  for (const p of kodak) {
    const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    corpus.push({ id: basename(p, ".png"), class: "standard", rgba: new Uint8Array(data), width: info.width, height: info.height });
  }
  for (const p of RAW_FILES) {
    const r = await loadTargetRgba(p);
    corpus.push({ id: r.file, class: "raw", rgba: r.rgba, width: r.tgtW, height: r.tgtH });
  }
  return corpus;
}

async function main() {
  const batchName = process.argv[2] || "general";
  const runTimestamp = new Date().toISOString();
  await initCodecCompareJxl();
  const jxl = makeJxlAdapter();
  const corpus = await loadCorpus(console.log);
  if (corpus.length === 0) throw new Error("Empty corpus (Kodak fetch failed + no RAW files)");
  console.log(`⚡ CodecPaper — ${corpus.length} images, ${ADAPTERS.length + 1} codecs`);

  // jxl adapter shim so sweep/fixed treat ours uniformly. Uses the quality-parametric
  // encode (Task 1 Step 6) so our JXL gets a real RD curve, not a single point.
  const jxlShim = { key: "jxl", runtime: "wasm", encode: (rgba,w,h,q)=>jxl.encode(rgba,w,h,q), decode: (b)=>jxl.decode(b) };
  const allCodecs = [jxlShim, ...ADAPTERS];

  const sweep = [], fixed = [];
  for (const img of corpus) {
    const pc = perceptualComparer(img.rgba, img.width, img.height);
    const npx = img.width * img.height;
    const metrics = async (decoded) => ({ butteraugli: await butteraugliDistance(img.rgba, decoded.data, img.width, img.height), ssim: pc.ssim(decoded.data) });
    for (const c of allCodecs) {
      if (c.key === "png_native") { // lossless: single point
        const bytes = await c.encode(img.rgba, img.width, img.height);
        const m = await metrics(await c.decode(bytes));
        sweep.push({ image: img.id, class: img.class, codec: c.key, runtime: c.runtime, quality: 100, bytes: bytes.length, bpp: bytes.length*8/npx, butteraugli: m.butteraugli, ssim: m.ssim });
        continue;
      }
      // RD sweep (uses the tested pure module; encodes+decodes once per ladder point)
      const pts = await sweepQualityLadder(c, { rgba: img.rgba, width: img.width, height: img.height, npx, metrics });
      for (const p of pts) sweep.push({ image: img.id, class: img.class, ...p });
      // fixed point ~butteraugli 1.5
      const measure = async (q) => { const b = await c.encode(img.rgba,img.width,img.height,q); const d = await c.decode(b); return butteraugliDistance(img.rgba, d.data, img.width, img.height); };
      const sr = await searchQuality({ measure, target: 1.5, tol: 0.15, maxIters: 8 });
      const fb = await c.encode(img.rgba, img.width, img.height, sr.quality);
      const fm = await decMetric(fb);
      const enc_ms = await medMs(N_TIME, () => c.encode(img.rgba, img.width, img.height, sr.quality));
      const dec_ms = await medMs(N_TIME, () => c.decode(fb));
      fixed.push({ image: img.id, class: img.class, codec: c.key, runtime: c.runtime, quality: sr.quality, butteraugli: fm.butter, bytes: fb.length, bpp: fb.length*8/npx, enc_ms, dec_ms });
    }
    pc.free();
    console.log(`✓ ${img.id}`);
  }

  // BD-rate per codec vs jpeg_native, averaged over images (per-image curves -> per-image bd -> mean)
  const bdRates = {};
  const codecs = [...new Set(sweep.map(s=>s.codec))];
  for (const c of codecs) {
    if (c === "jpeg_native") { bdRates[c] = 0; continue; }
    const perImg = [];
    for (const img of corpus) {
      const ref = sweep.filter(s=>s.image===img.id && s.codec==="jpeg_native").map(s=>({bpp:s.bpp, butteraugli:s.butteraugli}));
      const tst = sweep.filter(s=>s.image===img.id && s.codec===c).map(s=>({bpp:s.bpp, butteraugli:s.butteraugli}));
      const bd = bdRate(ref, tst);
      if (bd != null) perImg.push(bd);
    }
    bdRates[c] = perImg.length ? perImg.reduce((a,b)=>a+b,0)/perImg.length : null;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const toon = buildPaperToon({ sweep, fixed, bdRates, batchName, runTimestamp });
  const stamp = runTimestamp.replace(/[:.]/g, "-");
  writeFileSync(join(OUT_DIR, `${stamp}-CodecPaper-${batchName}.toon`), toon);
  const { count } = writeFigures({ outDir: OUT_DIR, sweep, fixed, bdRates });
  console.log(`Wrote ${count} figures + figures.html + toon to ${OUT_DIR}`);
}

main().then(() => setTimeout(() => process.exit(0), 500)).catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Syntax check + commit**

```bash
node --check CodecPaperTest.mjs && node --check benchmark/codec-paper-figures.mjs
git add CodecPaperTest.mjs benchmark/codec-paper-figures.mjs
git commit -m "feat(codec-paper): orchestrator + figure assembler (SVG + figures.html)"
```

---

## Task 8: End-to-end run + validation

**Files:** none (validation)

- [ ] **Step 1: Fetch corpus + run**

Run: `node scripts/fetch-kodak.mjs && node CodecPaperTest.mjs`
Expected: `✓` per image, `Wrote 5 figures + figures.html + toon`. (10–25 min; AVIF is slow.)

- [ ] **Step 2: Validate outputs exist + family resolves**

Run:
```bash
node -e "const fs=require('fs');const d='docs/outputs/codec-paper';const figs=fs.readdirSync(d+'/figures');console.log('figures:',figs.join(','));console.log('html:',fs.existsSync(d+'/figures.html'));const t=fs.readdirSync(d).find(x=>x.includes('CodecPaper'));const toon=fs.readFileSync(d+'/'+t,'utf8');console.log('toon rows sweep:',(toon.match(/\n  /g)||[]).length,'has BDRate:',/BDRate_/.test(toon));import('./benchmark/benchmark-history-registry.mjs').then(m=>console.log('family:',m.deriveFamilyIdFromArtifactName(t,'CodecPaper - general')));"
```
Expected: 5 svgs listed, `html: true`, non-zero sweep rows, `has BDRate: true`, `family: codec-paper`.

- [ ] **Step 3: Sanity-read figures**

Open `docs/outputs/codec-paper/figures.html`. Confirm: RD curves show butteraugli decreasing as bpp rises; `jxl`/`jxl_orig`/`avif` sit below (better than) `jpeg` on the RD curve; BD-rate for jxl vs jpeg_native is strongly negative (bytes saved). Note anything surprising.

- [ ] **Step 4: Full test suite**

Run: `node --test benchmark/test/*.test.mjs`
Expected: all PASS.

---

## Notes for the implementer

- **Never modify `StandardMultifileTest.mjs`** or the `standard-multifile`/`codec-compare` families.
- Our JXL is swept by quality via the parametric `encode` added in Task 1 Step 6 (facade `quality`→distance, verified monotonic) — it gets a real RD curve like every other codec.
- @jsquash codecs need the Node WASM `init(module)` (already handled in `codec-adapters.mjs`).
- Native (sharp) vs WASM ms are not comparable — Pareto/bars are split/labelled accordingly.
- Run in the existing worktree; commit per task.
```
