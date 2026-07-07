# HANDOFF — S2: One browser delivery engine

- **Worktree:** `C:\Foo\rcw-s2`  **Branch:** `s2/wave2-overnight`
- **Date:** 2026-07-07 (overnight, autonomous)  **Scope:** pure JS/TS in `web/` + `packages/` — no Rust/WASM build.
- **Source of task:** `docs/STRATEGIC-MAP-wave2-2026-07-06.md §S2`; evidence `QUESTIONS.md §002 (web/main.js, web/worker.js, pyramid-gallery)` + `§003 (lightbox webgl/tiled/pyramid)`.

## Goal
Consolidate the browser delivery path: kill dead GL/grid code, make the live
decode worker use one format sniffer (no ARW/NEF/RW2 misroute), make the tiled
decode pool actually work (worker↔pool protocol), and close the
wasted-decode/leak class in main.js — additively, without breaking working paths.

## Headline finding: most of S2 was already landed on `main`
This branch (`s2/wave2-overnight` = `main` + 1 commit) is **far ahead of the
QUESTIONS §002/§003 evidence**, which was captured on 2026-06-22. A prior pass
already:
- **deleted** the dead `web/pyramid-gallery-grid.{js,html,test.js}` (commit `70929357`);
- **restored** `buildColorMatrix` / `clampAdjustments` (+ `applyColorMatrixInPlace`,
  `applyToneMapInPlace`) to `web/lightbox/filter-engine.js` as a 20-element 4×5
  matrix, so `webgl-pipeline.js`'s import **now resolves** and its `matrixUniforms`
  layout matches — §003.A1/A2 resolved;
- **de-duplicated** `redraw()`/`clampPan()` in `web/lightbox/pyramid-lightbox.js`
  (there is exactly one of each now) and moved 16-bit rendering into the single
  `webgl-pipeline.js` engine of record via `reapplyToOffscreen` — §003.C1 resolved;
- **rewrote** `web/lightbox/tiled-decode-worker.js` to the pool's `v:1` protocol
  (load/ready/decode-reply, `bytesId` cache, `format`→use16) — §003.B resolved;
- wired `pool.cancelTask()` + `releaseState()` + index-map cleanup into
  `removeCard()` (main.js) — card-delete cancel done;
- added the `peepCache` decoded-RGBA **LRU cap** (`PEEP_DECODED_LRU_MAX=24`,
  `peepDecodedLru`, `peepLruRecord`/`peepLruTouch`, wired) — main.js peepCache done.

So the SAFE-SUBSET items #1 (dead code) and #3 (tiled rewrite) were already
complete, and #4 was mostly complete. Verified each on disk before acting; only
the genuinely-remaining gaps were changed.

## Landed this session (additive, behavior-neutral except the intended loud errors)

### L1 — Single-source RAW sub-router; ARW/NEF/RW2 fail loudly (Task #2)
- **`web/format-detect.js`:** new `detectRawKind(bytes, name) -> 'orf'|'cr2'|'dng'|'unsupported'|'unknown'`.
  Single source for the RAW decoder decision. ARW/NEF/RW2 (no WASM decoder) →
  `'unsupported'`; unrecognized magic with no supported extension → `'unknown'`.
- **`web/worker.js`:** `pickRawDecoderWithFlags(bytes, name)` now consumes
  `detectRawKind` (worker no longer re-implements its own magic table) and
  **throws** for `unsupported`/`unknown`; the decode try/catch surfaces it as a
  `WorkerMsg.ERROR`. Call site passes `opts.name`. Top-level routing already used
  `detectFormat` (sdr/jxl/unknown already loudly rejected — unchanged).
- **Behavior delta vs before:** previously ARW/NEF silently hit the DNG decoder
  and RW2 silently hit the ORF decoder (garbage/throw). Now they raise a clear
  "not yet supported" error. ORF/CR2/DNG routing is otherwise unchanged (a `.raw`
  file with foreign, non-TIFF magic now errors instead of being fed to ORF — the
  intended "unknown magic = loud error", aligns with K1 `decode_raw`).

### L2 — closeLightbox stops the live-update loop (Task #4)
- **`web/main.js` `closeLightbox()`:** now `clearTimeout(liveDebounceTimer)` and
  resets `liveInFlight=false; livePendingLook=null`. Prevents a live reprocess
  that resolves after close from stashing a stale pending look (which defeats the
  debounce on the next open). The worker `liveStateMap` is intentionally **not**
  freed here so re-opening the same card still supports live slider edits;
  genuine teardown frees it via `removeCard()`.

### L3 — Worker↔pool protocol contract test (Task #3)
- **`packages/jxl-pyramid/test/worker-protocol.contract.test.ts`** (bun; zero
  runtime deps): exercises `validateWorkerRequest` against the exact request
  shapes the pool emits (load/decode-rgba8/decode-rgba16/cancel) and rejects
  malformed/legacy shapes (bad `v`, missing `bytesId`, non-numeric region,
  unknown `format`, unknown type). Also statically asserts the web worker source
  conforms to the `v:1` reply protocol (posts `ready`; replies `decode-reply`
  with `w`/`h`+`v:1`; keys 16-bit off `format` not the legacy `bpp`; caches by
  `bytesId`; guards `msg.v !== 1`).

### L4 — Format-detect unit coverage for all six RAW families (Task #2)
- **`web/format-detect.test.js`:** +6 tests covering `detectRawKind` for ORF/CR2
  (magic and extension), DNG (LE/BE TIFF), ARW/NEF/RW2 → `unsupported`, unknown
  magic → `unknown`, and the Olympus `II*` fall-through → `orf`.

## Verification
| Check | Command | Result |
|---|---|---|
| format-detect + detectRawKind | `cd web && npx vitest run format-detect.test.js` | **14 passed** (was 8, +6) |
| worker.js syntax | `node --check web/worker.js` | OK |
| format-detect.js syntax | `node --check web/format-detect.js` | OK |
| main.js syntax | `node --check web/main.js` | OK |
| worker↔pool contract | `cd packages/jxl-pyramid && bun test test/worker-protocol.contract.test.ts` | **3 passed / 22 assertions** |

**UNVERIFIED (no real browser / no workspace node_modules in this worktree):**
- Real-Worker tiled decode e2e (`decode-pool.worker.integration.test.ts`,
  bun+Worker) — needs the `@casabio/jxl-wasm` workspace linked; `bun test` here
  fails to resolve it. This is the decode-count proof that the pooled path (not
  the direct-decode fallback) is hit; it exists but is not runnable in `rcw-s2`.
- 16-bit WebGL display render + slider parity (flipflopdom / headless GL).
- main.js runtime (Worker/DOM): the closeLightbox flag reset is reasoned, not
  browser-run.

## File map
- `web/format-detect.js` — +`detectRawKind` (single-source RAW sub-router).
- `web/format-detect.test.js` — +6 detectRawKind tests.
- `web/worker.js` — `pickRawDecoderWithFlags` consumes `detectRawKind`, loud errors, name threaded.
- `web/main.js` — `closeLightbox` resets live-update state.
- `packages/jxl-pyramid/test/worker-protocol.contract.test.ts` — new contract test.
- `docs/WAVE2-QUESTIONS-DEFERRED.md` — §S2 deferred judgment calls.

## Deferred (see docs/WAVE2-QUESTIONS-DEFERRED.md §S2)
- S2-Q1 WebGL liveness (fix-vs-drop is moot — already consolidated; browser-verify only).
- S2-Q2 tone-math single-sourcing (§003.C3) — needs browser parity.
- S2-Q3 route lightbox `loadLevel` through the pooled tiled path (§003.C2) — needs real WASM tiled decode.
- S2-Q4 main.js `CardState` WeakMap + `_lightbox` discriminated-union refactor — staged plan below.
- S2-Q5 stale `dist/worker-protocol.js` — rebuild `tsc` or wire `validateWorkerRequest`.

## Staged plan — main.js CardState refactor (the deferred big rewrite)
1. Introduce `const cardState = new WeakMap<HTMLElement, CardState>()` with a typed
   `CardState` record; add `getState(card)` / accessor helpers. Auto-GC on element
   removal also closes the `cardByTaskId` / `cardByFilename` stale-entry leak class.
2. Migrate the ~30 `_`-prefixed fields (`_taskId`, `_file`, `_lightbox`, `_thumb*`,
   `_crop`, `_subjects`, `_tauriResult`, `_sensorW/H`, …) field-by-field behind the
   accessors, one batch per commit; keep the expando as a thin alias during migration
   so sibling modules (`panels.js`, `tauri-pyramid-client.js`, `tauri-parity-lightbox.js`,
   `window.renderSubjectThumb`) keep working until each is ported.
3. Type `card._lightbox` as a discriminated union `{ kind:'decoded', rgb, w, h }` |
   `{ kind:'lazy', w, h, id, fetching }`; replace `rgb == null` truthiness checks with
   `kind` switches at the paint sites.
4. Verify each batch in a real browser across gallery + lightbox + Tauri batch paths
   (this is why it is deferred — the reference surface is too large to restructure
   correct-by-construction without runtime exercise).

## Notes / invariants respected
- Backpressure stayed at the scheduler/worker boundary; dedupe stayed in the
  scheduler; cache untouched. No session-protocol leakage into cache/stream.
- No file deleted this session (the dead grid file was already gone). No Rust.
- Left the tree clean; not pushed.
