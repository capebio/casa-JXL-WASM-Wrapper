# JPEG First-Class Input — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make JPEG a first-class, editable input format — losslessly archivable, non-destructively editable in the lightbox, exportable as archival (lossless) or developed (lossy), and exercised for real in the test-suite.

**Architecture:** JPEG rides the **existing developed-image path** (the one EXR/TIFF already use): a new `decode_jpeg` WASM export → `DecodedImage` → `decodedToLinearRgb16` → `LookRenderer` live-edit → JXL encode. Non-destructive edits reuse the **existing sidecar** (`web/panels.js` `saveSidecar`/`loadSidecar`, keyed by filename, localStorage/Tauri) — no new module. Lossless archival is the existing `transcodeJpegToJxl` facade bridge, exported on demand from the retained original JPEG (source of truth); the developed JXL is the card's normal encode output.

**Tech Stack:** Rust (`raw-pipeline`, `image` crate w/ `jpeg` feature already enabled), wasm-bindgen, `web/worker.js` + `web/main.js` + `web/format-detect.js`, libjxl WASM bridge (`transcodeJpegToJxl`), Node `--test`.

## Spec deviations discovered during grounding (intentional simplifications)

1. **No new `recipe-store` module.** Spec §4 proposed one; grounding found `web/panels.js` `saveSidecar`/`loadSidecar` already persists `{filename, look, crop, subjects, ...}` per file, and `startConvert` already calls `loadSidecar` (`main.js:1868`). JPEG reuses it unchanged — follows existing pattern, less code.
2. **Archival JXL generated lazily on export**, not held in memory at import. The retained original JPEG (`_file`) is the immutable source of truth; `transcodeJpegToJxl` is deterministic, so the lossless JXL is reproducible on demand. Cheaper, same preservation guarantee.
3. JPEG rides `processImageFormat` (EXR/TIFF path) rather than a bespoke pipeline.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `crates/raw-pipeline/src/image_formats.rs` | Pure decoders (TIFF/EXR) | **Add** `decode_jpeg_bytes` |
| `src/lib.rs` | WASM exports | **Add** `decode_jpeg` (mirror `decode_tiff` `:4596`) |
| `web/format-detect.js` | Magic-byte routing | JPEG `FFD8FF`: `'sdr'` → `'jpeg'` |
| `web/worker.js` | Decode routing + dev-image path | Import `decode_jpeg`; accept `'jpeg'` route; `processImageFormat` picks `decode_jpeg` |
| `web/main.js` | UI ingest + lightbox | `isOrf` regex + archival-export action |
| `web/index.html` | File picker | `accept` += jpeg extensions |
| `StandardMultifileTest.mjs` | Benchmark harness | Replace `sharp` JPEG stub; add lossless + lossy real rows |
| `crates/raw-pipeline/tests/` + `packages/jxl-wasm/test/` | Tests | New assertions |

---

## Phase A — Rust `decode_jpeg`

### Task A1: `decode_jpeg_bytes` in raw-pipeline

**Files:**
- Modify: `crates/raw-pipeline/src/image_formats.rs` (after `decode_exr_bytes`, ~line 83)
- Test: same file `#[cfg(test)]` module (append)

- [ ] **Step 1: Write the failing test**

Append to the tests module at the bottom of `crates/raw-pipeline/src/image_formats.rs` (create a `#[cfg(test)] mod tests { ... }` block if none exists):

```rust
#[cfg(test)]
mod jpeg_tests {
    use super::*;
    use image::{DynamicImage, RgbImage};
    use std::io::Cursor;

    fn make_jpeg(w: u32, h: u32) -> Vec<u8> {
        let mut img = RgbImage::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = image::Rgb([(x % 256) as u8, (y % 256) as u8, 128]);
        }
        let mut buf = Vec::new();
        DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Jpeg)
            .expect("encode jpeg fixture");
        buf
    }

    #[test]
    fn decode_jpeg_bytes_returns_rgba8() {
        let jpeg = make_jpeg(16, 12);
        let d = decode_jpeg_bytes(&jpeg).expect("decode jpeg");
        assert_eq!(d.width, 16);
        assert_eq!(d.height, 12);
        assert_eq!(d.bit_depth, 8);
        assert_eq!(d.u8.len(), 16 * 12 * 4); // RGBA
        assert!(d.u16.is_empty() && d.f32.is_empty());
    }

    #[test]
    fn decode_jpeg_bytes_rejects_garbage() {
        assert!(decode_jpeg_bytes(&[0, 1, 2, 3, 4, 5]).is_err());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.\build-msvc.ps1 test -p raw-pipeline jpeg_tests`
Expected: FAIL — `cannot find function decode_jpeg_bytes`.

- [ ] **Step 3: Write minimal implementation**

Insert after `decode_exr_bytes` (after line 83) in `crates/raw-pipeline/src/image_formats.rs`:

```rust
/// Decode a baseline/progressive JPEG to RGBA8. JPEG is always 8-bit, so the
/// output is RGBA8 (bit_depth == 8). Mirrors `decode_tiff_bytes`; rides the same
/// `image` crate (jpeg feature already enabled in Cargo.toml) and the shared
/// decompression-bomb guard.
pub fn decode_jpeg_bytes(bytes: &[u8]) -> Result<DecodedRgba, ImageFormatError> {
    guard_dimensions(bytes, image::ImageFormat::Jpeg)?;
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg)
        .map_err(|e| ImageFormatError::Decode(e.to_string()))?;
    Ok(dynamic_to_rgba(img))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.\build-msvc.ps1 test -p raw-pipeline jpeg_tests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/image_formats.rs
git commit -m "feat(raw-pipeline): decode_jpeg_bytes for developed-image JPEG ingest"
```

### Task A2: `decode_jpeg` WASM export

**Files:**
- Modify: `src/lib.rs` (after `decode_exr` `:4604-4608`)

- [ ] **Step 1: Write the export** (no unit test — trivial forwarder identical to the trusted `decode_tiff`/`decode_exr` wrappers; verified by the wasm build gate in Step 2 and the Node integration in Phase D)

Insert after `decode_exr` (after line 4608) in `src/lib.rs`:

```rust
/// Decode a JPEG to RGBA8 for the developed-image edit path (mirrors
/// `decode_tiff`/`decode_exr`). The lossless archival transcode is a separate
/// facade path (`transcodeJpegToJxl`); this is the editable-pixels decode.
#[wasm_bindgen]
pub fn decode_jpeg(bytes: &[u8]) -> Result<DecodedImage, JsValue> {
    raw_pipeline::image_formats::decode_jpeg_bytes(bytes)
        .map(decoded_to_wasm)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
```

- [ ] **Step 2: Gate both build targets** (per repo rule: root `src/lib.rs` ≠ `raw-pipeline` crate; gate wasm + native `--lib`)

Run: `cargo build --target wasm32-unknown-unknown --lib`
Expected: builds clean.
Run: `.\build-msvc.ps1 build --lib`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib.rs
git commit -m "feat(wasm): decode_jpeg export mirroring decode_tiff/decode_exr"
```

### Task A3: Rebuild shipped WASM (`web/pkg`)

**Files:**
- Modify: `web/pkg/*` (generated)

> The web app and `StandardMultifileTest.mjs` load the **prebuilt** `web/pkg` WASM. Rust edits do not reach them until rebuilt.

- [ ] **Step 1: Rebuild**

Run: `wasm-pack build --target web --out-dir web/pkg --release`
Expected: succeeds; `web/pkg/raw_converter_wasm.d.ts` now contains `export function decode_jpeg(bytes: Uint8Array): DecodedImage;`

- [ ] **Step 2: Verify the symbol is present**

Grep `web/pkg/raw_converter_wasm.d.ts` for `decode_jpeg`.
Expected: one match (the exported signature).

- [ ] **Step 3: Commit**

```bash
git add web/pkg
git commit -m "build(wasm): rebuild web/pkg with decode_jpeg"
```

---

## Phase B — Route JPEG through the editable dev-image path

### Task B1: `format-detect.js` — JPEG becomes its own route

**Files:**
- Modify: `web/format-detect.js` (JPEG line: `if (m(0xff, 0xd8, 0xff)) return 'sdr';`)
- Test: `web/test/format-detect.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `web/test/format-detect.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat } from '../format-detect.js';

test('JPEG magic routes to the jpeg pipeline, not sdr', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
  assert.equal(detectFormat(jpeg, 'photo.jpg'), 'jpeg');
});

test('PNG still routes to sdr (browser-native)', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  assert.equal(detectFormat(png, 'x.png'), 'sdr');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/test/format-detect.test.mjs`
Expected: FAIL — first test gets `'sdr'`, expected `'jpeg'`.

- [ ] **Step 3: Implement**

In `web/format-detect.js`, change the JPEG branch (the `return 'sdr'` for `m(0xff, 0xd8, 0xff)`):

```javascript
  if (m(0xff, 0xd8, 0xff)) return 'jpeg';                      // JPEG -> editable dev-image path
```

(Leave PNG/GIF/WEBP/ISO-BMFF returning `'sdr'` unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/test/format-detect.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/format-detect.js web/test/format-detect.test.mjs
git commit -m "feat(web): route JPEG magic to editable jpeg pipeline"
```

### Task B2: `worker.js` — accept the `jpeg` route

**Files:**
- Modify: `web/worker.js` (import destructure ~line 69–71; route branch ~line 570; `processImageFormat` decode line ~line 361)

- [ ] **Step 1: Import `decode_jpeg`**

In the wasm destructure (`web/worker.js:69-71`), add `decode_jpeg`:

```javascript
({ process_orf, process_orf_with_flags, process_cr2_with_flags, process_dng_with_flags, LookRenderer, rotate_rgb8,
   process_orf_with_look, process_dng_with_look, process_cr2_with_look,
   decode_exr, decode_tiff, decode_jpeg } = rawWasm);
```

- [ ] **Step 2: Accept the route**

In the message handler branch (`web/worker.js` ~line 570), extend the dev-image condition and remove `jpeg` from the reject text path:

```javascript
        const route = detectFormat(bytes, opts.name || '');
        if (route === 'exr' || route === 'tiff' || route === 'jpeg') {
            processImageFormat(id, bytes, opts, look, route);
            return;
        }
        if (route === 'sdr' || route === 'jxl' || route === 'unknown') {
            self.postMessage({
                id, type: WorkerMsg.ERROR,
                error: route === 'sdr'
                    ? 'Standard images (PNG/etc.) use the browser decode path, not the RAW pipeline.'
                    : route === 'jxl'
                        ? 'JXL files use the JXL decode path, not the RAW pipeline.'
                        : `Unsupported or unrecognized file format (${opts.name || 'unknown'}).`,
            });
            return;
        }
```

- [ ] **Step 3: Route the decode in `processImageFormat`**

In `processImageFormat` (`web/worker.js` ~line 361), extend the decoder selection:

```javascript
    const dec = route === 'exr' ? decode_exr(bytes)
              : route === 'jpeg' ? decode_jpeg(bytes)
              : decode_tiff(bytes);
```

- [ ] **Step 4: Verify (build/lint)**

Run: `node --check web/worker.js`
Expected: no syntax errors.

- [ ] **Step 5: Commit**

```bash
git add web/worker.js
git commit -m "feat(worker): decode JPEG via the dev-image LookRenderer path"
```

### Task B3: `main.js` `isOrf` + `index.html` accept — stop dropping JPEG

**Files:**
- Modify: `web/main.js:2164-2166` (`isOrf`)
- Modify: `web/index.html:101` (`accept`)

- [ ] **Step 1: Widen `isOrf`**

`web/main.js:2165`:

```javascript
function isOrf(file) {
    return /\.(orf|cr2|dng|exr|tif|tiff|jpg|jpeg|jfif)$/i.test(file.name);
}
```

- [ ] **Step 2: Widen the picker `accept`**

`web/index.html:101`:

```html
                <input type="file" id="file-input" multiple accept=".orf,.ORF,.cr2,.CR2,.dng,.DNG,.jpg,.jpeg,.jfif,.JPG,.JPEG,.JFIF" class="visually-hidden" />
```

- [ ] **Step 3: Verify**

Run: `node --check web/main.js`
Expected: no syntax errors.

- [ ] **Step 4: Commit**

```bash
git add web/main.js web/index.html
git commit -m "feat(web): accept JPEG in file picker and drag-drop filter"
```

### Task B4: Manual browser verification (editable JPEG + sidecar)

- [ ] **Step 1: Serve and load**

Run the app (existing dev serve; see `web/`), drag a `.jpg` in.
Expected: card appears (no "Standard images…" error), lightbox opens, image renders.

- [ ] **Step 2: Edit + persist**

Move exposure/contrast sliders → live update visible. Close and reopen the lightbox.
Expected: edits re-applied from the existing sidecar (`loadSidecar` at `main.js:1868` restores `look`). No archival JXL was rewritten.

- [ ] **Step 3: No commit** (verification only). If a defect surfaces, fix in the owning task and re-commit there.

---

## Phase C — Archival (lossless) export

### Task C1: Facade transcode + reversibility test (Node)

**Files:**
- Test: `packages/jxl-wasm/test/jpeg-archival.test.ts` (create)

> `transcodeJpegToJxl` (`facade.ts:766`) and `extractJpegReconstructionFromJxl` (`facade.ts:1018`) already exist. This locks the round-trip contract the archival export depends on and the test-suite reuses.

- [ ] **Step 1: Write the failing test**

Create `packages/jxl-wasm/test/jpeg-archival.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  transcodeJpegToJxl,
  extractJpegReconstructionFromJxl,
  getCapabilities,
} from "../src/facade";
import { loadLibjxlModule } from "../src/facade";

// Uses an existing repo JPEG fixture; adjust the path if the test corpus moves.
const JPEG = new Uint8Array(readFileSync(join(process.cwd(), "test-assets", "small_file.jpg")));

test("lossless JPEG->JXL transcode is byte-reversible", async () => {
  const caps = getCapabilities(await loadLibjxlModule());
  if (!caps.jpegTranscode) { console.warn("jpegTranscode capability absent — skipping"); return; }
  const jxl = await transcodeJpegToJxl(JPEG);
  assert.ok(jxl.byteLength > 0, "transcode produced output");
  const recovered = extractJpegReconstructionFromJxl(jxl);
  assert.ok(recovered, "reconstruction extracted");
  assert.deepEqual(Buffer.from(recovered!), Buffer.from(JPEG), "recovered JPEG is bit-exact");
});
```

> If `test-assets/small_file.jpg` does not exist, first copy the harness's `small_file.jpg` (referenced in `StandardMultifileTest.mjs` `FILES_CONFIG`) into `packages/jxl-wasm/test-assets/`, or synthesize one with `sharp`/`image` and commit it. Do this as Step 1a and `git add` the fixture.

- [ ] **Step 2: Run to verify it fails (or skips on missing WASM)**

Run: `node --test --import tsx packages/jxl-wasm/test/jpeg-archival.test.ts`
Expected: FAIL if the fixture is missing (add it), else PASS/skip. Confirm it runs the assertions when `jpegTranscode` is present.

- [ ] **Step 3: (Green already if bridge present.)** No production code needed — this test ratifies existing behavior. If `extractJpegReconstructionFromJxl` returns null for a standard (non-JXTC) JXL container, note it: the transcode output here is a standard JXL codestream with a JPEG reconstruction box, not JXTC — see Step 3a.

- [ ] **Step 3a: Confirm the reconstruction path for standard JXL.** `extractJpegReconstructionFromJxl` (`facade.ts:1018`) currently only scans **JXTC** containers. `transcodeJpegToJxl` emits a standard JXL. If extraction returns null, add a decoder-side reconstruction using libjxl's `JxlDecoderReconstructJPEG` via a small facade helper `reconstructJpegFromJxl(jxl)` (bridge already links `JxlDecoderSetJPEGBuffer`; expose a `jxl_wasm_reconstruct_jpeg` bridge fn mirroring the transcode bridge). Scope: only if Step 2 shows null. Prefer this over widening the JXTC scanner.

- [ ] **Step 4: Commit**

```bash
git add packages/jxl-wasm/test/jpeg-archival.test.ts packages/jxl-wasm/test-assets
git commit -m "test(jxl-wasm): lossless JPEG->JXL transcode reversibility"
```

### Task C2: Lightbox archival-export action

**Files:**
- Modify: `web/main.js` (near `lbDownloadBtn` handler `:3531-3542`)

- [ ] **Step 1: Add an archival-export handler**

The existing `lbDownloadBtn` (`:3531`) exports a canvas JPEG screenshot; the developed JXL is the card `_blobUrl`. Add a distinct archival path for JPEG cards. Insert after the `lbDownloadBtn` handler (after `:3542`):

```javascript
// Archival (lossless) export for JPEG cards: transcode the ORIGINAL jpeg bytes
// to a lossless JXL (bit-exact recoverable), independent of any edits. Edits
// live in the sidecar; this ships the untouched original as JXL.
async function exportArchivalJxl(card) {
    const file = getCardState(card)?._file;
    if (!file) return;
    const name = (file.name || 'image');
    if (!/\.(jpg|jpeg|jfif)$/i.test(name)) return; // archival lossless only meaningful for JPEG
    const { transcodeJpegToJxl } = await import('../packages/jxl-wasm/dist/facade.js');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let jxl;
    try {
        jxl = await transcodeJpegToJxl(bytes);
    } catch (e) {
        console.error('archival transcode failed', e);
        return;
    }
    const stem = name.replace(/\.(jpg|jpeg|jfif)$/i, '');
    const url = URL.createObjectURL(new Blob([jxl], { type: 'image/jxl' }));
    const a = document.createElement('a');
    a.href = url; a.download = stem + '.archival.jxl'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}
window.exportArchivalJxl = exportArchivalJxl;
```

- [ ] **Step 2: Wire a trigger**

Add an "Archival (lossless)" button beside the download control in the lightbox markup (`web/index.html`, near `.lb-download-btn`), visible only for JPEG cards, calling `window.exportArchivalJxl(cards[lightboxIndex])`. Match the existing button class pattern:

```html
                    <button class="lb-download-btn lb-archival-btn" title="Export lossless archival JXL (JPEG only)">Archival JXL</button>
```

Then in `web/main.js`, after the `lbDownloadBtn` handler, bind it:

```javascript
const lbArchivalBtn = lightbox.querySelector('.lb-archival-btn');
if (lbArchivalBtn) {
    lbArchivalBtn.addEventListener('click', () => {
        const card = cards[lightboxIndex];
        if (card) exportArchivalJxl(card);
    });
}
```

- [ ] **Step 3: Verify import path** — confirm the app bundles `packages/jxl-wasm/dist/facade.js` and that `transcodeJpegToJxl` is a named export there. If the app imports the facade under a different specifier (check `web/`'s existing jxl-wasm imports), use that specifier instead. Run the app, open a JPEG, click "Archival JXL".
Expected: a `.archival.jxl` downloads; feeding it back through the reversibility check (Task C1) recovers the original JPEG bit-exact.

- [ ] **Step 4: Commit**

```bash
git add web/main.js web/index.html
git commit -m "feat(web): lossless archival JXL export for JPEG cards"
```

---

## Phase D — Test-suite: real JPEG, both pathways, drop sharp

### Task D1: Replace the `sharp` JPEG stub with the real decode + lossless transcode row

**Files:**
- Modify: `StandardMultifileTest.mjs` (JPEG branch `:368-370`; asset-load loop)

- [ ] **Step 1: Import the real code paths**

At the top of `StandardMultifileTest.mjs`, ensure `decode_jpeg` is destructured from the wasm pkg import (alongside `process_orf_with_flags`, etc.) and import the transcode facade:

```javascript
// wasm pkg import — add decode_jpeg to the existing destructure
const { /* ...existing... */ decode_jpeg } = rawWasm;
// libjxl facade for the lossless archival pathway
import { transcodeJpegToJxl, extractJpegReconstructionFromJxl } from './packages/jxl-wasm/dist/facade.js';
```

- [ ] **Step 2: Replace the JPEG branch**

Replace `StandardMultifileTest.mjs:368-370`:

```javascript
    if (ext === ".jpg" || ext === ".jpeg" || ext === ".jfif") {
      // Editable/lossy pathway: decode via the SAME wasm decoder the app uses
      // (drops the sharp Node-native dependency).
      const dec = decode_jpeg(raw);
      const rgba = dec.take_rgba8();          // RGBA8
      srcW = dec.width; srcH = dec.height; dec.free();
      // RGBA8 -> RGB8 (harness downstream expects rgb, see below)
      rgb = new Uint8Array(srcW * srcH * 3);
      for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
        rgb[o] = rgba[i]; rgb[o + 1] = rgba[i + 1]; rgb[o + 2] = rgba[i + 2];
      }
      // Lossless archival pathway: measure transcode + prove reversibility.
      const tT0 = performance.now();
      const archivalJxl = await transcodeJpegToJxl(raw);
      const transcodeMs = performance.now() - tT0;
      const recovered = extractJpegReconstructionFromJxl(archivalJxl);
      const reversible = !!recovered && Buffer.compare(Buffer.from(recovered), Buffer.from(raw)) === 0;
      console.log(`  JPEG archival: transcode=${Math.round(transcodeMs)}ms  ratio=${(archivalJxl.byteLength / raw.byteLength).toFixed(3)}  reversible=${reversible}`);
    } else {
```

(Keep the existing `else { ...RAW... }` block that follows; only the JPEG branch changes.)

- [ ] **Step 3: Run the harness on the JPEG entries**

Run: `node StandardMultifileTest.mjs` (or the harness's existing invocation; a `LIMIT`/single-file smoke if supported).
Expected: JPEG files load via `decode_jpeg` (no `sharp`), and a `JPEG archival:` line prints `reversible=true` with a `<1.0` ratio. The existing lossy encode measurement rows still populate for JPEG (developed pathway).

- [ ] **Step 4: Remove the `sharp` JPEG dependency**

Confirm `sharp` is no longer referenced on the JPEG path. If `sharp` is used nowhere else in the file, remove its import.
Run: `node --check StandardMultifileTest.mjs`
Expected: no syntax errors; no `sharp` import if unused.

- [ ] **Step 5: Commit**

```bash
git add StandardMultifileTest.mjs
git commit -m "test(bench): JPEG via real decode_jpeg + lossless transcode reversibility; drop sharp"
```

### Task D2: Record both pathways as distinct result metrics

**Files:**
- Modify: `StandardMultifileTest.mjs` (`loadedFiles.push({...})` `:409`; results/reporting)

- [ ] **Step 1: Thread the archival metrics into the per-file record**

Extend the JPEG-branch locals and the `loadedFiles.push` so the archival numbers are recorded (not just logged). In the JPEG branch, capture into outer-scoped vars declared near `let rgb, srcW, srcH;`:

```javascript
    let jpegTranscodeMs = null, jpegArchivalRatio = null, jpegReversible = null;
```

Set them inside the JPEG branch (replace the bare `console.log`):

```javascript
      jpegTranscodeMs = transcodeMs;
      jpegArchivalRatio = archivalJxl.byteLength / raw.byteLength;
      jpegReversible = reversible;
```

Then add them to the `loadedFiles.push({...})` object (`:409`):

```javascript
    loadedFiles.push({ file: basename(resolvedPath), rgba, tgtW, tgtH, rawMs, scaleMs, rawDecompress, rawDemosaic, rawTonemap, rawOrient, previewDem, previewDown, fastPrev, lbPack, lbW: lbWw, lbH: lbHh, thPack, thW: thWw, thH: thHh, jpegTranscodeMs, jpegArchivalRatio, jpegReversible });
```

- [ ] **Step 2: Surface in the summary**

Wherever the harness prints/writes its per-file results table, add columns for `jpegTranscodeMs`, `jpegArchivalRatio`, `jpegReversible` (blank for non-JPEG rows). Match the existing `fmtMs`/`fmtKb` formatting helpers (`:364-365`).

- [ ] **Step 3: Run and verify both pathways appear**

Run: `node StandardMultifileTest.mjs`
Expected: JPEG rows show a lossy/developed encode measurement (existing columns) **and** the archival transcode ms + ratio + `reversible=true`.

- [ ] **Step 4: Commit**

```bash
git add StandardMultifileTest.mjs
git commit -m "test(bench): record JPEG archival + developed pathway metrics"
```

---

## Self-Review

**Spec coverage:**
- §1 importable / editable → Phase A + B (rides dev-image path, sidecar reused). ✓
- §2 lossless archival immutable source → Phase C (lazy transcode from retained `_file`) + C1 reversibility. ✓
- §3 non-destructive edit recipe → existing `saveSidecar`/`loadSidecar` (deviation #1). ✓
- §4 sidecar storage → existing localStorage/Tauri sidecar (deviation #1). ✓
- §5 dual export → developed = card `_blobUrl` (existing encode); archival = Task C2. ✓
- §6 test-suite real transcode + round-trip + both pathways, drop sharp → Phase D. ✓
- §7 web UI accept → Task B3. ✓
- §8 non-goals (embedded box, no `process_jpeg`, fast-jpeg thumbnails) → untouched. ✓

**Placeholder scan:** C1 Step 3a and C2 Step 3 contain conditional/verify steps (reconstruction-path fallback; import-specifier confirmation) — these are genuine runtime-dependent forks with concrete instructions and code, not TODOs.

**Type consistency:** `decode_jpeg_bytes` → `DecodedRgba`; `decode_jpeg` → `DecodedImage` via `decoded_to_wasm` (matches `decode_tiff`). `DecodedImage.take_rgba8()` used in Phase D matches the getter at `lib.rs:4557`. `transcodeJpegToJxl`/`extractJpegReconstructionFromJxl` names match `facade.ts:766/1018`. Route string `'jpeg'` consistent across `format-detect.js`, `worker.js` handler, and `processImageFormat`.

## Risks / Open verification points

- **C1 reversibility** may require the `jxl_wasm_reconstruct_jpeg` bridge fallback (Step 3a) if `extractJpegReconstructionFromJxl` only handles JXTC. Resolve empirically in C1 Step 2 before building C2's UI.
- **C2 import specifier** for the facade in the browser build must be confirmed against the app's existing jxl-wasm import graph (Step 3).
- **CMYK / L16 JPEGs**: `image` crate decodes CMYK JPEG to RGB, so `decode_jpeg` is fine; the lossless transcode via `JxlEncoderAddJPEGFrame` handles baseline + progressive. Exotic subsampling that libjxl rejects should surface as a transcode error → fall back to developed-only export with a notice (already the natural behavior since developed export is independent).
- **Execution isolation:** run this plan in a dedicated worktree on `feat/jpeg-input-jul09` cut from the active branch `perf/casv-video-simd-v2-jul05` (NOT from `main`, per CLAUDE.md branch rule).
