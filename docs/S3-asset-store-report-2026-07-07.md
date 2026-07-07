# S3 — Memory-Governed Asset Store — implementation report (2026-07-07)

**Branch:** `feat/s3-asset-store-jul07` · **Worktree:** `Foorcw-s1-unify`
**Handoff:** `docs/HANDOFF-s3-asset-store-2026-07-07.md`

## Result

`packages/asset-store` tests: **42/42 pass** (was 23) via
`node --test --test-force-exit test/*.test.js`. `node --check web/main.js` and
`web/jxl-file-picker.js`: OK. No WASM/Rust build. Files touched stay within the
allowed set (`packages/asset-store/`, `web/main.js`).

## Ground-truth corrections vs the handoff

The handoff had two location errors; both resolved by reading the code:

1. **`estimate_decode_peak` is not in `facade.ts`.** It is a Rust/WASM export
   (`src/lib.rs:773`, model in `crates/raw-pipeline/src/mem_budget.rs`) and is
   **absent from the shipped `web/pkg/raw_converter_wasm.js`** — the pkg was not
   rebuilt to surface it (verified: symbol not present). A WASM rebuild is out of
   scope. → Ported the pure model to JS (`asset-store/src/mem-budget.js`), so the
   browser gets the preflight today; swap for the WASM export once the pkg ships it.
2. **`MAX_OUTPUT_BYTES_GUARD` lives in `decode-handler.ts`** (a
   `jxl-worker-browser` file), which is **outside the 4 allowed files**. Left
   as-is (cannot edit in scope). It guards the JXL worker output-alloc; the RAW
   preflight added here is the estimate-based path the handoff wanted introduced.

## Task 1 — decode-admission preflight (S3-Q3)

- **`asset-store/src/mem-budget.js`** (new): faithful JS mirror of
  `mem_budget.rs` — `OUT_*` flag bits, `estimateDecodePeak(w,h,flags) →
  {pixels, retainedBytes, peakBytes}`, `estimateDecodePeakBytes(...)`,
  `OUT_BATCH_DEFAULT` (the shipping "7"). Pure integer arithmetic; float64 is
  exact for real dims, clamps to `MAX_SAFE_INTEGER` on absurd dims (no wrap).
  Kept in asset-store (not the JXL facade): the S3 ADR pairs the estimate with
  the AssetStore governor, and it is node-testable with no WASM dependency.
- **`AssetStore.admit(estimatedPeakBytes, opts)`**: log-only preflight. Warns
  (never rejects) when `peak × multiplier > budget`. `multiplier` default **1.5**
  (ADR RSS headroom); `budgetBytes` default = the store's remaining RAM headroom;
  `warn` injectable. Adds an `admissionWarnings` stat. Content-agnostic — takes a
  byte count, not image knowledge, so the governor never learns the RAW pipeline.
- **`web/main.js` wiring**: a module-level `rawDecodeGovernor`
  (`maxBytes = RAW_DECODE_BUDGET_BYTES = 384 MB`) + a log-only preflight in the
  RAW-ingest **Phase A** handler. The largest embedded JPEG (~sensor resolution)
  feeds `estimateDecodePeak(w,h, OUT_BATCH_DEFAULT)` → `admit(...)`.
  **Observational only** — the decode pipeline (Phase B) already runs
  concurrently; this warns, it does not gate. A real pre-gate needs the scheduler
  retained-HWM governor (S3-Q4, separate approved handoff). No hot-path behavior
  change: when the projection fits, `admit` only does arithmetic (no warn).

  *Note:* there is no in-browser `process_orf(w,h,flags)` call site in `main.js`
  (RAW decode runs Tauri-side or in a worker), so a true pre-decode gate is not
  reachable from the 4 allowed files. The Phase-A signal is the closest honest
  in-scope wiring and is genuinely useful for the non-Tauri web deployment.

## Task 2 — AssetStore drives jxl-cache OPFS (S3-Q5)

- **`persistentBackendFromCache(cache)`** (new export, `asset-store/src/index.js`):
  the ~10-line injectable adapter. Duck-typed on a `get/set/delete/(has)/(init)`
  shape — **does not import jxl-cache** (layer boundary held; the app injects it).
  Bridges two gaps: normalizes any view/`SharedArrayBuffer` value to a tight,
  non-shared `ArrayBuffer` (jxl-cache's `set` rejects shared buffers); awaits
  `init()` once before the first op. Once wrapped, `AssetStore.store()`/`load()`
  already provide the write-through / read-through the handoff describes.
- Verified by tests: `store → RAM evict → load reads through the OPFS L2 mock →
  promote`; view→tight-`ArrayBuffer` normalization; `has()` fallback; bad-cache
  guard.

**`web/main.js` wiring deferred (documented):** there is no `jxlCache` instance
nor a byte-holding `AssetStore` in `main.js` to attach OPFS to today —
`peepDecodedStore` holds count-markers (value `true`, size 1), with the real RGBA
in `peepCache`; attaching OPFS there would change behavior for no gain. Per S3-Q5
itself ("wire when the pyramid level-byte cache migrates"), the real L2 client is
`packages/jxl-pyramid/src/cache.ts` — **out of scope** for this pass. The adapter
is ready to drop in when that migration lands.

## Files

| File | Change |
|---|---|
| `packages/asset-store/src/mem-budget.js` | **new** — JS mirror of the Rust decode-peak model |
| `packages/asset-store/src/index.js` | `admit()` + `admissionWarnings` stat + `persistentBackendFromCache()` + mem-budget re-exports |
| `packages/asset-store/index.d.ts` | types for the above |
| `packages/asset-store/test/mem-budget.test.js` | **new** — port-parity vs the Rust worked numbers |
| `packages/asset-store/test/asset-store.test.js` | admit tests + adapter round-trip |
| `web/main.js` | `rawDecodeGovernor` + Phase-A log-only preflight |

## Post-implementation — browser measurement + calibration (2026-07-07)

A temporary `worker.js` MEMPROBE (uncommitted, reverted) logged WASM-linear-heap
high-water vs the model peak per decode, over a real browser sweep (dev-server
`tools/dev-server.mjs`, cross-origin-isolated). 15 clean points, DNG/CR2/ORF,
9.9–24 MP:

| MP | fmt | heap/model |
|----|-----|-----------|
| 9.9 landscape | DNG | 1.47–1.49 |
| 9.9 portrait | DNG | 1.75 |
| 12.5 | DNG | 1.72–1.73 |
| 17.9 | CR2 | 1.63–1.65 |
| 24.0 | CR2 | 1.62–1.66 |

Findings:
- **Ratio does not grow with pixels** (small portrait 1.75 > big 24 MP 1.66) —
  fixed allocator/preview overhead as a shrinking fraction of `n`. Safe to
  extrapolate to 45/60 MP (trends lower).
- **Portrait > landscape at equal MP** — the worker decodes with `NO_ORIENT`, so
  the model assumes no rotate, but portrait shots still pay an orientation-rotate
  transient the model omits. The multiplier absorbs it.
- **The 384 MB budget guess was wrong** — the build's WASM shared memory caps at
  `maximum:32768`×64 KiB = **2 GiB**, and a 24 MP decode legitimately uses
  ~362 MB and completes. A 384 MB hard gate would have false-rejected normal files.

Calibration landed in `web/main.js`: `RAW_DECODE_SAFETY_MULT` **1.5 → 1.7**
(measured), `RAW_DECODE_BUDGET_BYTES` **384 MB → ~1.8 GiB** (2 GiB ceiling −
headroom). Kept **soft/log-only**; the signal now only trips at ~110 MP+.

## Surfaced bugs

- **FIXED — `scheduler.ts` `process.env` in `signalDrain`** (commit `05684e7e`):
  read `process.env.NODE_ENV` unguarded before the `queueDepth<0` check → threw
  `ReferenceError: process is not defined` on **every** browser worker message,
  silently breaking backpressure drain. Guarded with `typeof process !==
  "undefined"` (the idiom already used in `budget.ts`/`pool.ts`); fixed in src +
  the compiled `dist/scheduler.js` the browser loads.
- **OPEN — DNG embedded-preview too bright.** The Phase-A embedded-JPEG thumbnail
  paints too bright, then corrects when the colour-managed RAW thumb lands. Real
  colour-pipeline bug (embedded preview drawn uncorrected); not a quick guard-fix.
  Not investigated — logged for a dedicated pass.

## Follow-ups (out of scope, unchanged)

- Turn the soft preflight into a true pre-`pool.submit` hard reject (now that the
  multiplier/budget are calibrated); then retire `MAX_OUTPUT_BYTES_GUARD` in
  `decode-handler.ts`.
- Wire `persistentBackendFromCache` into the pyramid level-byte cache (S3-Q5).
- Per-session retained-frame governor (S3-Q4) — scheduler layer.
- DNG embedded-preview colour correction (surfaced above).
