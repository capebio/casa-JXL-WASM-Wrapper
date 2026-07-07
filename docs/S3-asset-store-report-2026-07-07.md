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

## Follow-ups (out of scope, unchanged)

- Hard-gate on the peak estimate once the model-vs-RSS multiplier is measured on
  real runs (S3-Q3 second half); then retire `MAX_OUTPUT_BYTES_GUARD` in
  `decode-handler.ts`.
- Wire `persistentBackendFromCache` into the pyramid level-byte cache (S3-Q5).
- Per-session retained-frame governor (S3-Q4) — scheduler layer.
