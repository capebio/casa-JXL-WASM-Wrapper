# LibRaw And Hand RAW Decoders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browser-WASM RAW support for non-native manufacturers through LibRaw, plus first hand-rolled NEF/CRW/RW2 decoders guarded by LibRaw fallback and tests.

**Architecture:** Keep current ORF/CR2/DNG Rust decoders as preferred fast paths. Add `libraw-wasm` as a browser-side generic decoder and standard oracle. Normalize LibRaw and hand decoder output into a `RawMosaicPayload` consumed by one new Rust WASM `process_raw_mosaic_with_flags` entry.

**Tech Stack:** Rust `wasm-bindgen`, existing `raw-pipeline`, Bun/Vitest, `libraw-wasm@1.6.0`, raw.pixls.us samples.

## Global Constraints

- Use `rtk proxy` for shell commands.
- Use TDD: write failing test, verify failure, implement minimal code, verify pass.
- Do not touch progressive JXL bridge behavior.
- Do not alter existing ORF/CR2/DNG decode behavior except shared helper extraction needed by the generic raw entry.
- Work in the existing checkout because user requested unattended progress and the checkout is already dirty.
- Do not commit unless explicitly requested.

---

### Task 1: RAW Extension Routing

**Files:**
- Modify: `web/format-detect.js`
- Modify: `web/format-detect.test.js`

**Interfaces:**
- Produces: `detectRawKind(bytes, name)` returns `libraw` for non-native RAW formats, `orf|cr2|dng` for native formats, `unknown` for invalid data.

- [ ] **Step 1: Write failing test**

Add assertions that `.nef`, `.nrw`, `.crw`, `.cr3`, `.rw2`, `.rwl`, `.arw`, `.raf`, `.pef`, `.srw`, `.x3f`, `.3fr`, `.fff`, `.iiq` classify as `raw`, and `detectRawKind` routes them to `libraw` instead of `unsupported`.

- [ ] **Step 2: Verify RED**

Run: `rtk proxy bun test web/format-detect.test.js`

Expected: tests fail because current implementation returns `unsupported` or `unknown`.

- [ ] **Step 3: Implement minimal routing**

Change `RAW_EXT` and `detectRawKind` extension handling. Preserve ORF/CR2/DNG branches first.

- [ ] **Step 4: Verify GREEN**

Run: `rtk proxy bun test web/format-detect.test.js`

Expected: all format-detect tests pass.

### Task 2: LibRaw Payload Normalizer

**Files:**
- Create: `web/libraw-normalize.js`
- Create: `web/libraw-normalize.test.js`

**Interfaces:**
- Produces: `metadataToRawMosaicPayload(meta, rawImageData, decoderName)` returns normalized fields for Rust.
- Produces: `cfaPhaseFromLibRawFilters(filters, cdesc)` returns `0..3` for Bayer layouts or `null`.
- Produces: `orientationFromLibRawFlip(flip)` returns EXIF orientation tag `1|3|6|8`.

- [ ] **Step 1: Write failing tests**

Tests cover RGGB, BGGR, GBRG, GRBG filter masks, black/white/WB extraction from `color_data`, and orientation mapping.

- [ ] **Step 2: Verify RED**

Run: `rtk proxy bun test web/libraw-normalize.test.js`

Expected: module missing failure.

- [ ] **Step 3: Implement normalizer**

Implement pure JS helpers, no LibRaw runtime dependency.

- [ ] **Step 4: Verify GREEN**

Run: `rtk proxy bun test web/libraw-normalize.test.js`

Expected: tests pass.

### Task 3: Generic Rust Raw Mosaic Processor

**Files:**
- Modify: `src/lib.rs`

**Interfaces:**
- Produces: `process_raw_mosaic_with_flags(...) -> Result<ProcessResult, JsValue>`.

- [ ] **Step 1: Write failing Rust test**

Add unit test that calls an internal helper with a synthetic RGGB mosaic and checks dimensions, black/white retention, and non-empty thumb/lightbox outputs.

- [ ] **Step 2: Verify RED**

Run: `rtk proxy cargo test --lib process_raw_mosaic`

Expected: missing helper/function failure.

- [ ] **Step 3: Implement minimal helper and wasm export**

Reuse `demosaic::demosaic_bayer_mhc`, `process_dng_impl` shape, `ProcessResult`, and `PipelineParams`.

- [ ] **Step 4: Verify GREEN**

Run: `rtk proxy cargo test --lib process_raw_mosaic`

Expected: test passes.

### Task 4: Browser LibRaw Integration

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `web/worker.js`
- Create: `web/libraw-decode.js`
- Create: `web/libraw-decode.test.js`

**Interfaces:**
- Produces: `decodeWithLibRaw(bytes, name)` returns `RawMosaicPayload`.
- Worker uses `process_raw_mosaic_with_flags` for `libraw` routes.

- [ ] **Step 1: Write failing tests**

Stub `LibRaw` class in test and assert `decodeWithLibRaw` calls `open`, `metadata(true)`, `rawImageData()`, and normalizes payload.

- [ ] **Step 2: Verify RED**

Run: `rtk proxy bun test web/libraw-decode.test.js`

Expected: module missing failure.

- [ ] **Step 3: Add dependency**

Patch `package.json` with `"libraw-wasm": "1.6.0"`, then run `rtk bun install`.

- [ ] **Step 4: Implement decoder wrapper and worker branch**

Use dynamic import so LibRaw worker is loaded only for `libraw` routes.

- [ ] **Step 5: Verify GREEN**

Run: `rtk proxy bun test web/libraw-decode.test.js`

Expected: tests pass.

### Task 5: Hand Decoder Skeletons And Fallback

**Files:**
- Create: `web/hand-raw-decoders.js`
- Create: `web/hand-raw-decoders.test.js`
- Modify: `web/worker.js`

**Interfaces:**
- Produces: `tryDecodeHandRaw(bytes, name)` returns `{ ok: true, payload }` or `{ ok: false, reason }`.
- Worker tries hand path for `nef`, `crw`, `rw2`; falls back to LibRaw on `ok: false`.

- [ ] **Step 1: Write failing tests**

Assert NEF/CRW/RW2 route attempts hand decoder first and falls back to LibRaw on unsupported mode.

- [ ] **Step 2: Verify RED**

Run: `rtk proxy bun test web/hand-raw-decoders.test.js`

Expected: module missing failure.

- [ ] **Step 3: Implement skeleton parsers**

Implement container sniffers: NEF TIFF header, CRW CIFF header, RW2 `IIU\0` header. Return unsupported with explicit reason until fixture submode logic lands.

- [ ] **Step 4: Verify GREEN**

Run: `rtk proxy bun test web/hand-raw-decoders.test.js`

Expected: tests pass for fallback contract.

### Task 6: Download Corpus Samples

**Files:**
- Write outside workspace: `C:\Foo\raw-converter\tests\*.NEF`, `*.NRW`, `*.CR3`, `*.CRW`, `*.RW2`, `*.RWL`
- Create outside workspace: `C:\Foo\raw-converter\tests\raw-thirdparty-samples.json`

**Interfaces:**
- Produces: local public-domain fixture files from raw.pixls.us.

- [ ] **Step 1: Select files**

Use `https://raw.pixls.us/data/` listings for Nikon, Canon, Panasonic, and Leica.

- [ ] **Step 2: Download with approval**

Use escalated shell command because destination is outside writable root.

- [ ] **Step 3: Write manifest**

Record URL, filename, byte size, SHA-256, and raw.pixls.us public-domain declaration.

### Task 7: Fixture-Driven Hand Decoder Expansion

**Files:**
- Modify: `web/hand-raw-decoders.js`
- Modify: `web/hand-raw-decoders.test.js`
- Create: `tools/compare-handraw-libraw.mjs`

**Interfaces:**
- Produces: hand NEF/CRW/RW2 decode when fixture submode is recognized.
- Produces: comparison report against LibRaw.

- [ ] **Step 1: Write fixture comparison test**

Test checks each downloaded NEF/CRW/RW2 either decodes hand path with sane dimensions or returns explicit unsupported reason and LibRaw fallback succeeds.

- [ ] **Step 2: Verify RED**

Run: `rtk proxy bun test web/hand-raw-decoders.test.js`

Expected: fixture hand decode assertions fail until implemented.

- [ ] **Step 3: Implement first supported fixture submodes**

Add only verified submodes. Do not guess compression.

- [ ] **Step 4: Verify GREEN or record unsupported**

Run: `rtk proxy bun test web/hand-raw-decoders.test.js`

Expected: supported submodes pass; unsupported modes are explicit and fallback works.

### Task 8: Build And Regression Verification

**Files:**
- No new files unless bug fixes required.

**Interfaces:**
- Produces: verified browser build and tests.

- [ ] **Step 1: Run targeted tests**

Run:

```powershell
rtk proxy bun test web/format-detect.test.js
rtk proxy bun test web/libraw-normalize.test.js
rtk proxy bun test web/libraw-decode.test.js
rtk proxy bun test web/hand-raw-decoders.test.js
rtk proxy cargo test --lib process_raw_mosaic
```

- [ ] **Step 2: Run build**

Run: `rtk proxy bun run build`

- [ ] **Step 3: Report actual state**

Report completed items, failed checks, unsupported fixture submodes, and exact next work.

## Self-Review

Spec coverage: extension routing, LibRaw browser path, Rust generic renderer entry, hand decoder fallback, fixture download, and verification are covered.

Placeholder scan: plan contains no TBD/TODO placeholders. Hand decoder unsupported cases are explicit intended behavior, not placeholders.

Type consistency: `RawMosaicPayload`, `process_raw_mosaic_with_flags`, `decodeWithLibRaw`, and `tryDecodeHandRaw` names match across tasks.
