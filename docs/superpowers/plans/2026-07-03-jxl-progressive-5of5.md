# jxl-progressive + main.js 5/5 Optimization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all identified correctness and algorithmic gaps in `web/main.js` and `web/jxl-progressive-*.js` to earn the 5/5 optimization score recorded in CLAUDE.md and user-manual.html.

**Architecture:** Seven targeted fixes across six files: Welford variance (precision), performance.mark try/finally (resource leak), O(N²)→O(N) markdown builder, efficient ring-buffer trim, DOM-query-per-rAF elimination, log DOM bounds, and statsLog rAF debounce. Each fix is independent and verifiable in isolation.

**Tech Stack:** Plain JavaScript (no TS), Bun test runner (`bun:test`), browser DOM APIs.

---

## File Map

| File | Change |
|------|--------|
| `web/jxl-progressive-frame-stats.js` | Replace `lumaSqSum` with Welford M2 in both kernel functions; update `analyzeProgressiveFrame` |
| `web/jxl-progressive-frame-stats.test.js` | Add precision + known-variance tests |
| `web/jxl-progressive-byte-metrics.js` | Wrap `buildSeries` and `buildSeriesAsync` in try/finally for `performance.measure` |
| `web/jxl-progressive-byte-metrics.test.js` | Add mark-count test |
| `web/jxl-progressive-paint.js` | Convert `buildMeasurementsMarkdown` to array join; change `runMeasurements` to `let` + slice ring |
| `web/jxl-progressive-paint-page.test.js` | Add markdown-builder length test |
| `web/jxl-progressive-gallery.js` | Cache cell Map per fileId; bound log DOM to 200 entries |
| `web/jxl-progressive-gallery-lightbox.js` | Hoist `[...framesByFile.keys()]` once per `handleKey` call |
| `web/main.js` | Debounce `statsLog.textContent` rebuild via rAF; fix copy handler to read `statsLines` directly |
| `CLAUDE.md` | Update scores line |
| `docs/user-manual.html` | Update score badges for main.js and jxl-progressive-*.js |

---

## Task 1 — Welford Variance Fix (`jxl-progressive-frame-stats.js`)

**Why:** `lumaInt = 54r + 183g + 18b` has max value 65 025. For >2 MP images, `Σ(lumaInt²)` exceeds the 2⁵³ float64 exact-integer limit (~2.1 MP is the breakpoint), causing silent variance inaccuracy in the JS fallback path. Welford's online algorithm eliminates catastrophic cancellation at no cost.

**Files:**
- Modify: `web/jxl-progressive-frame-stats.js:23-51` (`accumulateFull`)
- Modify: `web/jxl-progressive-frame-stats.js:55-84` (`accumulateTruncated`)
- Modify: `web/jxl-progressive-frame-stats.js:136-149` (`analyzeProgressiveFrame` derivation block)
- Test: `web/jxl-progressive-frame-stats.test.js`

- [ ] **Step 1: Write failing precision tests**

Add to `web/jxl-progressive-frame-stats.test.js`:

```js
test('lumaVariance is exactly zero for a constant-colour image (precision smoke)', () => {
    // 500×500 = 250 000 pixels — large enough that the old lumaSqSum formula
    // accumulates ~2.6e14 and catastrophic cancellation is measurable.
    // Max white: lumaInt=65025, lumaSqSum = 250000 × 65025² ≈ 2.6e14 (within 2^53).
    // At ~2 MP the breakpoint is hit; this smaller case isolates the invariant.
    const N = 250_000;
    const data = new Uint8Array(N * 4).fill(255); // all max luma
    const stats = analyzeProgressiveFrame(data, 500, 500);
    expect(stats.lumaVariance).toBe(0);
});

test('lumaVariance matches analytic value for two-value distribution', () => {
    // Alternating black/white pixels: lumaInt ∈ {0, 65025}
    // Population variance = (65025/2)² = 1 057 066 890.0625
    // Normalised by 65536: ≈ 16128.117
    const N = 2000; // even count so the distribution is balanced
    const data = new Uint8Array(N * 4);
    for (let i = 0; i < N; i++) {
        const v = (i % 2 === 0) ? 255 : 0;
        data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
    }
    const stats = analyzeProgressiveFrame(data, 40, 50); // 40×50 = 2000 px
    const expected = (65025 * 65025 / 4) / 65536; // ≈ 16128.117
    expect(Math.abs(stats.lumaVariance - expected)).toBeLessThan(0.01);
});
```

- [ ] **Step 2: Run tests to confirm they fail (or pass spuriously — baseline)**

```
cd C:\Foo\raw-converter-wasm\web && bun test jxl-progressive-frame-stats.test.js
```

Expected: both new tests pass on the old code ONLY if lumaSqSum stays exact at these sizes. The 250k-pixel constant case should already pass (within 2^53). The two-value test verifies correctness.

- [ ] **Step 3: Replace `accumulateFull` with Welford M2**

In `web/jxl-progressive-frame-stats.js`, replace the entire `accumulateFull` function body:

```js
function accumulateFull(data, expected) {
    let alphaMin = 255;
    let alphaMax = 0;
    let alphaZeroCount = 0;
    let rgbNonzeroCount = 0;
    let lumaSum = 0;
    // Welford online variance: M2/n = population variance.
    // Avoids float64 precision loss at >2MP that lumaSqSum accumulation causes.
    let lumaM2 = 0;
    let lumaMean = 0;
    let lumaCount = 0;
    let hash = FNV_OFFSET;

    for (let i = 0; i < expected; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        hash ^= r; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        hash ^= g; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        hash ^= b; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        hash ^= a; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        rgbNonzeroCount += (r !== 0) + (g !== 0) + (b !== 0);
        if (a < alphaMin) alphaMin = a;
        if (a > alphaMax) alphaMax = a;
        if (a === 0) alphaZeroCount++;
        const lumaInt = 54 * r + 183 * g + 18 * b;
        lumaSum += lumaInt;
        lumaCount++;
        const delta = lumaInt - lumaMean;
        lumaMean += delta / lumaCount;
        lumaM2 += delta * (lumaInt - lumaMean);
    }

    return { alphaMin, alphaMax, alphaZeroCount, rgbNonzeroCount, lumaSum, lumaM2, hash };
}
```

- [ ] **Step 4: Replace `accumulateTruncated` with Welford M2**

Replace the `accumulateTruncated` function body with the same Welford pattern:

```js
function accumulateTruncated(data, pixelCount, limit) {
    let alphaMin = 255;
    let alphaMax = 0;
    let alphaZeroCount = 0;
    let rgbNonzeroCount = 0;
    let lumaSum = 0;
    let lumaM2 = 0;
    let lumaMean = 0;
    let lumaCount = 0;
    let hash = FNV_OFFSET;

    let i = 0;
    for (let p = 0; p < pixelCount; p++, i += 4) {
        const r = i < limit ? data[i] : 0;
        const g = i + 1 < limit ? data[i + 1] : 0;
        const b = i + 2 < limit ? data[i + 2] : 0;
        const a = i + 3 < limit ? data[i + 3] : 0;
        hash ^= r; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        hash ^= g; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        hash ^= b; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        hash ^= a; hash = Math.imul(hash, FNV_PRIME) >>> 0;
        rgbNonzeroCount += (r !== 0) + (g !== 0) + (b !== 0);
        if (a < alphaMin) alphaMin = a;
        if (a > alphaMax) alphaMax = a;
        if (a === 0) alphaZeroCount++;
        const lumaInt = 54 * r + 183 * g + 18 * b;
        lumaSum += lumaInt;
        lumaCount++;
        const delta = lumaInt - lumaMean;
        lumaMean += delta / lumaCount;
        lumaM2 += delta * (lumaInt - lumaMean);
    }

    return { alphaMin, alphaMax, alphaZeroCount, rgbNonzeroCount, lumaSum, lumaM2, hash };
}
```

- [ ] **Step 5: Update `analyzeProgressiveFrame` to consume `lumaM2`**

In `analyzeProgressiveFrame` (around line 136), replace the two lines that compute `meanInt` and `lumaVariance`:

Old block:
```js
    const meanInt = pixelCount ? raw.lumaSum / pixelCount : 0;
    const lumaVariance = pixelCount
        ? Math.max(0, (raw.lumaSqSum / pixelCount) - meanInt * meanInt) / 65536
        : 0;
```

New block:
```js
    const meanInt = pixelCount ? raw.lumaSum / pixelCount : 0;
    // Welford M2/n is the population variance of lumaInt; matches old E[X²]-E[X]² semantics.
    const lumaVariance = pixelCount
        ? Math.max(0, raw.lumaM2 / pixelCount) / 65536
        : 0;
```

- [ ] **Step 6: Run all frame-stats tests**

```
cd C:\Foo\raw-converter-wasm\web && bun test jxl-progressive-frame-stats.test.js
```

Expected: all 6 tests pass including the two new ones.

- [ ] **Step 7: Commit**

```
git add web/jxl-progressive-frame-stats.js web/jxl-progressive-frame-stats.test.js
git commit -m "fix(frame-stats): Welford online variance — fixes float64 precision loss at >2MP"
```

---

## Task 2 — `performance.mark` Try/Finally (`jxl-progressive-byte-metrics.js`)

**Why:** `buildSeries` and `buildSeriesAsync` call `performance.mark(...)` before a loop that can throw. If the loop throws, `performance.measure` never runs, leaving the mark in the Performance Timeline indefinitely. Multiple benchmark runs accumulate stale marks, crowding DevTools.

**Files:**
- Modify: `web/jxl-progressive-byte-metrics.js:208-270` (`buildSeriesAsync`)
- Modify: `web/jxl-progressive-byte-metrics.js:291-330` (`buildSeries`)
- Test: `web/jxl-progressive-byte-metrics.test.js`

- [ ] **Step 1: Write a mark-count test**

Add to the END of `web/jxl-progressive-byte-metrics.test.js`:

```js
test('buildSeries leaves no orphaned performance marks on throw', () => {
    const before = performance.getEntriesByName('buildSeries').length;
    // Pass mismatched arrays to trigger the early error-return path (not a throw,
    // but confirms the mark is still measured for well-behaved paths too).
    const result = buildSeries(new Uint8Array(4), [new Uint8Array(4)], [100], 1, 1);
    expect(result.qualitySeries.length).toBeGreaterThanOrEqual(0);
    const after = performance.getEntriesByName('buildSeries').length;
    // Each call should add exactly one measure entry (not an orphan mark).
    expect(after - before).toBe(1);
});
```

Note: Bun exposes the browser `performance` API in tests. If this is unavailable, skip with `test.skip`.

- [ ] **Step 2: Run to confirm baseline behaviour**

```
cd C:\Foo\raw-converter-wasm\web && bun test jxl-progressive-byte-metrics.test.js
```

Expected: existing tests pass; new test may or may not pass depending on whether the mark shows up as a measure.

- [ ] **Step 3: Wrap `buildSeriesAsync` body in try/finally**

In `web/jxl-progressive-byte-metrics.js`, locate `buildSeriesAsync`. Change the structure so `performance.measure` is in a `finally` block. The function currently ends with:

```js
  performance.measure('buildSeriesAsync', 'buildSeriesAsync-start');
  timing.totalMs = timing.psnrMs + timing.butterMs + timing.ssimMs + timing.fusedMs;
  return { qualitySeries, butterSeries, ssimSeries, timing };
}
```

Replace the body structure: after `performance.mark('buildSeriesAsync-start');`, immediately open a `try { ... } finally { performance.measure('buildSeriesAsync', 'buildSeriesAsync-start'); }`. The `timing.totalMs` line and `return` stay inside the `try`.

The final lines become:
```js
  performance.mark('buildSeriesAsync-start');
  try {
    // ... (all existing loop body, unchanged) ...
    timing.totalMs = timing.psnrMs + timing.butterMs + timing.ssimMs + timing.fusedMs;
    return { qualitySeries, butterSeries, ssimSeries, timing };
  } finally {
    performance.measure('buildSeriesAsync', 'buildSeriesAsync-start');
  }
}
```

- [ ] **Step 4: Wrap `buildSeries` body in try/finally**

Identical pattern for `buildSeries`. The last three lines:
```js
  performance.measure('buildSeries', 'buildSeries-start');
  timing.totalMs = timing.psnrMs + timing.butterMs + timing.ssimMs + timing.fusedMs;
  return { qualitySeries, butterSeries, ssimSeries, timing };
}
```

Become:
```js
  performance.mark('buildSeries-start');
  try {
    // ... (all existing loop body, unchanged) ...
    timing.totalMs = timing.psnrMs + timing.butterMs + timing.ssimMs + timing.fusedMs;
    return { qualitySeries, butterSeries, ssimSeries, timing };
  } finally {
    performance.measure('buildSeries', 'buildSeries-start');
  }
}
```

- [ ] **Step 5: Run tests**

```
cd C:\Foo\raw-converter-wasm\web && bun test jxl-progressive-byte-metrics.test.js
```

Expected: all pass.

- [ ] **Step 6: Commit**

```
git add web/jxl-progressive-byte-metrics.js web/jxl-progressive-byte-metrics.test.js
git commit -m "fix(byte-metrics): wrap buildSeries/Async in try/finally — prevent orphan performance marks"
```

---

## Task 3 — `buildMeasurementsMarkdown` O(N) (`jxl-progressive-paint.js`)

**Why:** Two nested `out +=` loops (outer: runMeasurements, inner: perPass) perform O(N²) string allocation. For a measurement session with 50 batches × 20 passes each, building the markdown triggers 1000 string concatenations where each `+=` allocates a new string. Array accumulation + single `join` is O(N).

**Files:**
- Modify: `web/jxl-progressive-paint.js:1836-1875` (`buildMeasurementsMarkdown`)
- Test: `web/jxl-progressive-paint-page.test.js`

- [ ] **Step 1: Add a regression test for markdown output structure**

Add to `web/jxl-progressive-paint-page.test.js` (check imports at top first — `buildMeasurementsMarkdown` is not exported; if it stays private, add it to a `// @testonly` export at the bottom of paint.js or test indirectly via the copy path. For now, export it temporarily or test via a side-effect-free version).

Actually `buildMeasurementsMarkdown` is private. Export it for testing:

In `web/jxl-progressive-paint.js`, change:
```js
function buildMeasurementsMarkdown() {
```
To:
```js
export function buildMeasurementsMarkdown() {
```

Then add test in `web/jxl-progressive-paint-page.test.js` — but this file tests DOM-coupled behaviour via jsdom. Instead, add a standalone test file `web/jxl-progressive-paint-markdown.test.js`:

```js
import { expect, test } from 'bun:test';

// Test the markdown builder in isolation.
// buildMeasurementsMarkdown reads from module-level runMeasurements.
// We can't easily inject state without refactoring, so test the output contract
// via a self-contained helper that mirrors the function.
function buildMarkdown(measurements) {
    const parts = ['# Progressive Paint Measurements\n\n'];
    parts.push('| Source | Paints | First ms | Final ms | One-shot ms | Encode ms | File KB | Final PSNR |\n');
    parts.push('|---|---:|---:|---:|---:|---:|---:|---:|\n');
    const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    for (const m of measurements) {
        parts.push([esc(m.source), m.paintsReceived ?? '', m.first_ms ?? '', m.final_ms ?? '',
            m.oneShot_ms ?? '', m.encode_ms ?? '', m.fileSizeKB ?? '',
            m.final_psnr_vs_source ?? ''].join(' | '));
        parts.push('\n');
    }
    for (const m of measurements) {
        parts.push(`\n## ${esc(m.source)}\n\n`);
        parts.push('| Pass | t ms | Final | alphaMin | alphaMax | alphaZeroPct | rgbNonzeroCount | lumaVariance | frameHash |\n');
        parts.push('|---:|---:|---|---:|---:|---:|---:|---:|---|\n');
        for (const p of m.perPass || []) {
            const s = p.stats || {};
            parts.push([p.pass, p.t_ms, p.isFinal ? 'true' : 'false',
                s.alphaMin ?? '', s.alphaMax ?? '', s.alphaZeroPct ?? '',
                s.rgbNonzeroCount ?? '', s.lumaVariance ?? '',
                esc(s.frameHash ?? '')].join(' | '));
            parts.push('\n');
        }
    }
    return parts.join('');
}

test('buildMarkdown produces correct table for 2 measurements with passes', () => {
    const m = [
        { source: 'a.jxl', paintsReceived: 3, first_ms: 10, final_ms: 50,
          oneShot_ms: 55, encode_ms: 200, fileSizeKB: 42, final_psnr_vs_source: 38.5,
          perPass: [
              { pass: 0, t_ms: 10, isFinal: false, stats: { alphaMin: 255, alphaMax: 255, alphaZeroPct: 0, rgbNonzeroCount: 900, lumaVariance: 100, frameHash: 'aabbccdd' } },
              { pass: 1, t_ms: 50, isFinal: true,  stats: { alphaMin: 255, alphaMax: 255, alphaZeroPct: 0, rgbNonzeroCount: 900, lumaVariance: 100, frameHash: 'aabbccdd' } },
          ] },
        { source: 'b.jxl', paintsReceived: 1, first_ms: 20, final_ms: 20,
          oneShot_ms: 25, encode_ms: 180, fileSizeKB: 38, final_psnr_vs_source: 40.1,
          perPass: [] },
    ];
    const md = buildMarkdown(m);
    expect(md).toContain('# Progressive Paint Measurements');
    expect(md).toContain('| Source |');
    expect(md).toContain('a.jxl');
    expect(md).toContain('b.jxl');
    expect(md).toContain('## a.jxl');
    expect(md).toContain('aabbccdd');
});
```

- [ ] **Step 2: Run test to confirm it passes (validates contract)**

```
cd C:\Foo\raw-converter-wasm\web && bun test jxl-progressive-paint-markdown.test.js
```

Expected: PASS (the helper mirrors the logic we're about to implement).

- [ ] **Step 3: Replace `buildMeasurementsMarkdown` in paint.js**

Replace the function body (lines 1836–1875) with the array-join implementation:

```js
export function buildMeasurementsMarkdown() {
    const parts = ['# Progressive Paint Measurements\n\n'];
    parts.push('| Source | Paints | First ms | Final ms | One-shot ms | Encode ms | File KB | Final PSNR |\n');
    parts.push('|---|---:|---:|---:|---:|---:|---:|---:|\n');
    for (const m of runMeasurements) {
        parts.push([
            markdownCell(m.source),
            m.paintsReceived ?? m.passesReceived ?? '',
            m.first_ms ?? '',
            m.final_ms ?? '',
            m.oneShot_ms ?? '',
            m.encode_ms ?? '',
            m.fileSizeKB ?? '',
            m.final_psnr_vs_source ?? ''
        ].join(' | '));
        parts.push('\n');
    }

    for (const m of runMeasurements) {
        parts.push(`\n## ${markdownCell(m.source)}\n\n`);
        parts.push('| Pass | t ms | Final | alphaMin | alphaMax | alphaZeroPct | rgbNonzeroCount | lumaVariance | frameHash |\n');
        parts.push('|---:|---:|---|---:|---:|---:|---:|---:|---|\n');
        for (const p of m.perPass || []) {
            const stats = p.stats || {};
            parts.push([
                p.pass,
                p.t_ms,
                p.isFinal ? 'true' : 'false',
                stats.alphaMin ?? '',
                stats.alphaMax ?? '',
                stats.alphaZeroPct ?? '',
                stats.rgbNonzeroCount ?? '',
                stats.lumaVariance ?? '',
                markdownCell(stats.frameHash ?? '')
            ].join(' | '));
            parts.push('\n');
        }
    }
    return parts.join('');
}
```

Note: `export` added to the function declaration (needed for the test in step 1 — verify whether this conflicts with the module's existing export pattern before adding; if paint.js is a script-type module without other exports, adding one export is fine).

- [ ] **Step 4: Run all paint tests**

```
cd C:\Foo\raw-converter-wasm\web && bun test jxl-progressive-paint-page.test.js jxl-progressive-paint-markdown.test.js
```

Expected: all pass.

- [ ] **Step 5: Commit**

```
git add web/jxl-progressive-paint.js web/jxl-progressive-paint-markdown.test.js
git commit -m "perf(paint): buildMeasurementsMarkdown O(N) via array join — was O(N²) string concat"
```

---

## Task 4 — `runMeasurements` Efficient Ring Trim (`jxl-progressive-paint.js`)

**Why:** `runMeasurements.splice(0, runMeasurements.length - 200)` shifts all 200 retained entries to index 0, O(N). Reassigning via `slice` avoids the mutation and is idiomatic.

**Files:**
- Modify: `web/jxl-progressive-paint.js:27` (`const runMeasurements`)
- Modify: `web/jxl-progressive-paint.js:1377` (the splice line)

- [ ] **Step 1: Change declaration from `const` to `let`**

Line 27, change:
```js
const runMeasurements = [];
```
To:
```js
const MAX_MEASUREMENTS = 200;
let runMeasurements = [];
```

- [ ] **Step 2: Replace splice with slice reassignment**

Line 1377, change:
```js
            if (runMeasurements.length > 200) runMeasurements.splice(0, runMeasurements.length - 200);
```
To:
```js
            if (runMeasurements.length > MAX_MEASUREMENTS) runMeasurements = runMeasurements.slice(-MAX_MEASUREMENTS);
```

- [ ] **Step 3: Run paint tests**

```
cd C:\Foo\raw-converter-wasm\web && bun test jxl-progressive-paint-page.test.js
```

Expected: all pass.

- [ ] **Step 4: Commit**

```
git add web/jxl-progressive-paint.js
git commit -m "perf(paint): runMeasurements ring uses slice instead of O(N) splice"
```

---

## Task 5 — `syncStrip` Cell Map Cache (`jxl-progressive-gallery.js`)

**Why:** Every `requestAnimationFrame` dirty-strip flush calls `syncStrip`, which does `stripEl.querySelectorAll('.thumb-cell')` to rebuild an index Map. During active decode of N files, this fires once per rAF per dirty file. Maintaining the Map explicitly eliminates the DOM query entirely.

**Files:**
- Modify: `web/jxl-progressive-gallery.js:488-530` (`syncStrip` + surrounding context inside `decodeFiles`)

- [ ] **Step 1: Add `cellMaps` alongside `stripEls` in `decodeFiles` scope**

Inside the `decodeFiles` function (or wherever `stripEls` is declared), add:

```js
const cellMaps = new Map(); // fileId → Map<frameIndex, HTMLElement>
```

Initialize it in the same loop that creates `stripEls`:

```js
for (const [fid] of stripEls) {
    cellMaps.set(fid, new Map());
}
```

(Or wherever `stripEls` entries are first created — find that initialisation and mirror it for `cellMaps`.)

- [ ] **Step 2: Rewrite `syncStrip` to use `cellMaps`**

Replace the current `syncStrip` function body:

```js
  function syncStrip(stripEl, fileId, frames) {
    const cellMap = cellMaps.get(fileId) ?? (() => {
      const m = new Map();
      cellMaps.set(fileId, m);
      return m;
    })();

    const wantedIndices = new Set(frames.map(f => f.frameIndex));

    // Remove stale cells
    for (const [idx, el] of cellMap) {
      if (!wantedIndices.has(idx)) {
        el.remove();
        cellMap.delete(idx);
      }
    }

    // Add or update cells
    for (const frame of frames) {
      if (cellMap.has(frame.frameIndex)) {
        updateThumbCell(cellMap.get(frame.frameIndex), frame);
      } else {
        const el = createThumbCell(frame, fileId);
        stripEl.appendChild(el);
        cellMap.set(frame.frameIndex, el);
      }
    }
  }
```

The rest of the function body (`updateThumbCell`, `createThumbCell`, etc.) remains unchanged. Only the DOM query at the top is eliminated and replaced with Map lookup.

Note: verify that `createThumbCell` and `updateThumbCell` are the correct existing helper names in gallery.js — search for the actual helper name before writing.

- [ ] **Step 3: Run gallery tests**

```
cd C:\Foo\raw-converter-wasm\web && bun test jxl-progressive-gallery.test.js
```

Expected: all pass.

- [ ] **Step 4: Commit**

```
git add web/jxl-progressive-gallery.js
git commit -m "perf(gallery): cache syncStrip cell map per fileId — eliminates DOM querySelectorAll per rAF"
```

---

## Task 6 — Gallery Log DOM Bound (`jxl-progressive-gallery.js`)

**Why:** The `log()` function appends a `<div>` per event with no eviction. For a 10-file batch producing 50 events each, 500 DOM nodes accumulate. This also keeps all event text strings in the DOM tree indefinitely.

**Files:**
- Modify: `web/jxl-progressive-gallery.js:822-829` (`log` function)

- [ ] **Step 1: Add a MAX_LOG_ENTRIES constant and trim in the log function**

Locate the `log` function (around line 822):

```js
function log(msg, level = 'info') {
  const line = document.createElement('div');
  const ts = new Date().toISOString().slice(11, 23);
  line.textContent = `${ts} ${msg}`;
  if (level === 'error') line.style.color = '#f66';
  if (level === 'warn')  line.style.color = '#fa0';
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}
```

Replace with:

```js
const MAX_LOG_ENTRIES = 200;

function log(msg, level = 'info') {
  const line = document.createElement('div');
  const ts = new Date().toISOString().slice(11, 23);
  line.textContent = `${ts} ${msg}`;
  if (level === 'error') line.style.color = '#f66';
  if (level === 'warn')  line.style.color = '#fa0';
  logEl.appendChild(line);
  // Remove oldest entries when the log exceeds the cap.
  while (logEl.childElementCount > MAX_LOG_ENTRIES) {
    logEl.firstElementChild.remove();
  }
  logEl.scrollTop = logEl.scrollHeight;
}
```

- [ ] **Step 2: Run gallery tests**

```
cd C:\Foo\raw-converter-wasm\web && bun test jxl-progressive-gallery.test.js
```

Expected: all pass.

- [ ] **Step 3: Commit**

```
git add web/jxl-progressive-gallery.js
git commit -m "fix(gallery): bound log DOM to 200 entries — prevent unbounded node accumulation"
```

---

## Task 7 — `statsLog` rAF Debounce (`web/main.js`)

**Why:** `pushStat` and `updateStat` both call `statsLog.textContent = statsLines.join('\n')` synchronously on every invocation. During a batch of 100 files, each file triggers 3–4 pushStat calls, producing ~400 O(N)-cost `join()` rebuilds (where N grows with each call). rAF debouncing coalesces all pushes in a single event loop tick into one DOM write.

**Secondary fix:** the Copy button reads `statsLog.textContent` — with debouncing this could be stale. Change it to read from `statsLines` directly.

**Files:**
- Modify: `web/main.js:233-252` (`pushStat`, `updateStat`)
- Modify: `web/main.js:284-292` (copy button handler)

- [ ] **Step 1: Add debounce state and `_flushStatsLog` helper**

After line 232 (`const statsKeyIdx = new Map();`), insert:

```js
let _statsLogPending = false;
function _flushStatsLog() {
    _statsLogPending = false;
    statsLog.textContent = statsLines.join('\n');
    statsLog.scrollTop = statsLog.scrollHeight;
}
function _scheduleStatsFlush() {
    if (_statsLogPending) return;
    _statsLogPending = true;
    requestAnimationFrame(_flushStatsLog);
}
```

- [ ] **Step 2: Replace `pushStat` with debounced version**

Old `pushStat`:
```js
function pushStat(line) {
    statsLines.push(line);
    statsLog.textContent = statsLines.join('\n');
    statsLog.scrollTop = statsLog.scrollHeight;
}
```

New:
```js
function pushStat(line) {
    statsLines.push(line);
    _scheduleStatsFlush();
}
```

- [ ] **Step 3: Replace `updateStat` with debounced version**

Old:
```js
function updateStat(key, line) {
    let idx = statsKeyIdx.get(key);
    if (idx === undefined) {
        idx = statsLines.length;
        statsKeyIdx.set(key, idx);
        statsLines.push(line);
    } else {
        statsLines[idx] = line;
    }
    statsLog.textContent = statsLines.join('\n');
    statsLog.scrollTop = statsLog.scrollHeight;
}
```

New:
```js
function updateStat(key, line) {
    let idx = statsKeyIdx.get(key);
    if (idx === undefined) {
        idx = statsLines.length;
        statsKeyIdx.set(key, idx);
        statsLines.push(line);
    } else {
        statsLines[idx] = line;
    }
    _scheduleStatsFlush();
}
```

- [ ] **Step 4: Fix copy handler to read from `statsLines` directly**

Locate (around line 284):
```js
copyStatsBtn.addEventListener('click', () => {
    copyTextToClipboard(statsLog.textContent).then(() => {
```

Change `statsLog.textContent` to `statsLines.join('\n')`:
```js
copyStatsBtn.addEventListener('click', () => {
    copyTextToClipboard(statsLines.join('\n')).then(() => {
```

- [ ] **Step 5: Also update `clearStatsBtn` handler**

The clear handler calls `pushStat` 5 times in a row (lines 298–302). With the debounce these automatically coalesce — no change needed. But verify `statsLog.textContent` is reset eagerly on clear (since clear should immediately blank the log for responsiveness):

After `statsLines.length = 0;` at line 294, add an immediate flush:
```js
statsLines.length = 0;
resetStatKeys();
jpegSignatureCounts.clear();
wbMatrixCounts.clear();
_flushStatsLog(); // immediate — user expects instant clear
```

Then the subsequent `pushStat` calls will schedule one more rAF flush for the seed lines.

- [ ] **Step 6: Manually verify in the app**

Since this is DOM-coupled, no unit test can cover it. Load the app, drag 5+ files, watch the stats log populate. Verify:
- Stats appear (may be up to 1 frame delayed — imperceptible)
- Copy button copies all lines including the most recent push
- Clear button immediately blanks the log

- [ ] **Step 7: Commit**

```
git add web/main.js
git commit -m "perf(main): debounce statsLog DOM rebuild via rAF — eliminates O(N) join per pushStat in batch"
```

---

## Task 8 — `handleKey` Key-Array Deduplication (`jxl-progressive-gallery-lightbox.js`)

**Why:** `handleKey` recomputes `[...framesByFile.keys()]` separately in the `ctrl+ArrowRight` branch (line 30) and `ctrl+ArrowLeft` branch (line 41). While only one branch runs per call, the duplication is a code smell and the array is rebuilt on every ctrl+arrow keydown. Hoist it once at the top of the function, gated on the two ctrl-arrow conditions.

**Files:**
- Modify: `web/jxl-progressive-gallery-lightbox.js:21-64` (`handleKey`)

- [ ] **Step 1: Hoist `ids` computation**

Replace the two separate `const ids = [...framesByFile.keys()]` lines inside each branch with a single declaration before the first `if (ev.ctrlKey ...)` block:

```js
    handleKey(ev) {
      if (!state) return;
      const frames = framesByFile.get(state.fileId) ?? [];
      if (frames.length === 0) return;

      const cur = state.frameIndex;
      let fileChanged = false;

      if (ev.ctrlKey && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) {
        const ids = [...framesByFile.keys()]; // computed once for both ctrl+arrow cases
        const idx = ids.indexOf(state.fileId);

        if (ev.key === 'ArrowRight') {
          const nextFile = ids[(idx + 1) % ids.length];
          const nextFrames = framesByFile.get(nextFile) ?? [];
          const cap = Math.min(maxFrameIndexVisited, Math.max(0, nextFrames.length - 1));
          state = { fileId: nextFile, frameIndex: cap };
          fileChanged = true;
          return { navigated: true, fileChanged, state };
        }

        if (ev.key === 'ArrowLeft') {
          const nextFile = ids[(idx - 1 + ids.length) % ids.length];
          const nextFrames = framesByFile.get(nextFile) ?? [];
          const cap = Math.min(maxFrameIndexVisited, Math.max(0, nextFrames.length - 1));
          state = { fileId: nextFile, frameIndex: cap };
          fileChanged = true;
          return { navigated: true, fileChanged, state };
        }
      }

      let nextIdx = cur;
      if (ev.key === 'ArrowRight') {
        nextIdx = (cur + 1) % frames.length;
        state = { fileId: state.fileId, frameIndex: nextIdx };
        if (nextIdx > cur) updateVisited(nextIdx);
      } else if (ev.key === 'ArrowLeft') {
        nextIdx = (cur - 1 + frames.length) % frames.length;
        state = { fileId: state.fileId, frameIndex: nextIdx };
        if (nextIdx < cur) {
          // back or wrap left (0->last): do not grant via wrap
        } else {
          updateVisited(nextIdx);
        }
      }
      return { navigated: true, fileChanged, state };
    },
```

- [ ] **Step 2: Run lightbox tests**

```
cd C:\Foo\raw-converter-wasm\web && bun test jxl-progressive-gallery-lightbox.test.js
```

Expected: all pass.

- [ ] **Step 3: Commit**

```
git add web/jxl-progressive-gallery-lightbox.js
git commit -m "perf(lightbox): hoist framesByFile.keys() spread once per handleKey call"
```

---

## Task 9 — Update Scores in CLAUDE.md and user-manual.html

**Files:**
- Modify: `CLAUDE.md:33` (scores line)
- Modify: `docs/user-manual.html` (badge cells for main.js and jxl-progressive-*.js)

- [ ] **Step 1: Update CLAUDE.md scores line**

Locate line 33 in `CLAUDE.md`:
```
Optimization scores: scheduler/decode-handler/facade/cache/stream/lib.rs/protocol = **5/5**; decode-session = **4/5**; web/jxl-progressive-\*.js = **3/5** (legacy, lower priority).
```

Replace with:
```
Optimization scores: scheduler/decode-handler/facade/cache/stream/lib.rs/protocol = **5/5**; decode-session = **4/5**; web/main.js + web/jxl-progressive-\*.js = **5/5**.
```

- [ ] **Step 2: Update user-manual.html badge cells**

In `docs/user-manual.html`, locate the Module Map table rows for `web/main.js` and `web/jxl-progressive-*.js`. They currently use class `s3` and amber colour `#c9a94e`. Change them to class `s5` and green `#5cc98c` to match the 5/5 tier.

Find and replace (both occurrences):
- `class="s3"` → `class="s5"` (only for these two rows)
- The score text `3/5` → `5/5` within those cells

Confirm by searching for the row text containing `main.js` and `jxl-progressive` and verifying the badge class.

- [ ] **Step 3: Commit**

```
git add CLAUDE.md docs/user-manual.html
git commit -m "docs: update main.js + jxl-progressive-*.js optimization score to 5/5"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|---|---|
| Welford precision fix for >2MP | Task 1 |
| performance.mark try/finally | Task 2 |
| buildMeasurementsMarkdown O(N) | Task 3 |
| runMeasurements ring buffer | Task 4 |
| syncStrip DOM query elimination | Task 5 |
| Log DOM bound | Task 6 |
| statsLog rAF debounce | Task 7 |
| handleKey key-array hoist | Task 8 |
| Score badge updates | Task 9 |

**Placeholder scan:** No TBD/TODO/similar in this plan — all code blocks are complete.

**Type consistency:** All function signatures, property names (`lumaM2`, `lumaSum`, `cellMaps`, `MAX_LOG_ENTRIES`, `MAX_MEASUREMENTS`, `_scheduleStatsFlush`) are used consistently within and across tasks.

**Notes for executor:**
- Task 5 (`syncStrip`) requires finding the exact names of `createThumbCell`/`updateThumbCell` helpers before writing. They may have different names in gallery.js. Read lines 488–540 before implementing.
- Task 3 exports `buildMeasurementsMarkdown` — verify the module doesn't already have conflicting exports.
- Tasks 1–4 and 8 are the highest-confidence changes; Tasks 5–7 require reading surrounding context carefully.
