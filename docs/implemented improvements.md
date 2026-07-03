# Registry of Implemented Improvements & Optimizations

This document provides a systematic audit and running tally of the optimization and handoff documents located in the `docs` and root directories. It tracks which specifications have been fully integrated, which are checked in git, and which files still require optimization.

## Executive Summary

Based on an exhaustive audit of the codebase, git history, and latest working tree changes, we have verified that:
1. **The `jxl-policy` package is now FULLY IMPLEMENTED (`DONE`):** The user has recently implemented the outstanding changes from `JxlPolicyIndexDecisionsState - DONE.md` in `packages/jxl-policy/src/index.ts`! The preset tables (`decodePolicies`/`encodePolicies`) are now frozen, type derivation via index access is complete, runtime policy validation has been added, and the `downsampleForContainer` utility as well as the `mlInference` preset are fully coded.
2. **Most Core Pipeline Handoffs and Code Reviews are Fully Implemented:** Standard browser/node pipeline optimizations, stream range fetching, worker loader/spawners, native-codec bindings, scheduler queues/budgets, progressive saliency, and most notably, the massive **Epic Code Reviews** on both the Rust WASM metadata pipeline and the `jxl-pyramid` decode trio are fully implemented and checked in.
3. **Key Tooling and Scripts are Completed, while Core Optimization Clusters Remain Outstanding:**
   - **Preflight & Script Robustness (`HANDOFF-jxl-capabilities-index-probe-wb-probe-lens-review - DONE.md`):** Fully completed! `probe.ts` has received full preflight connection checks and fallback launching options, and `wb-probe.ts` has been refactored to use named constants for its 15 parameters with automated PowerShell wildcard directory expansion and exit status reporting.
   - **Advanced Browser Decoder & Facade Optimizations (`HANDOFF-worker-decode-handler-facade-lens-review.md`):** Partially implemented. Only `worker.ts` has received the lifecycle safety additions (aborted starts and serialization listeners). The major browser performance optimizations (such as `R14-F1` removing full-frame copies on region decodes and `R14-D1` ending worker decodes early on progressive targets) have **not** been implemented.
   - **Tauri Native Region/ROI Decode:** Tiled ROI / JXTC region decode is pending native implementation.

---

## Implemented Improvements Tally

The following table records the status of each optimization plan, code review, and handoff document.

| Script / Document Name | Target File | Checked in Git? | Checked in Code? | Status & Notes |
|:---|:---|:---:|:---:|:---|
| **EpicCodeReview - DONE.md** (Root-level) & **EpicCodeReviewSummary - DONE.md** | `src/tiff.rs`, `src/lib.rs`, `web/jxl-worker.js` | **Yes** | **Yes** | Fully implemented. Fixed critical GPS hemisphere blank tags, WASM32 arithmetic overflow, unbounded MakerNote sub-IFD count, WB validation, and worker OOM recovery. |
| **docs/EpicCodeReview - DONE.md** & **docs/EpicCodeReview - jxl-pyramid - DONE.md** | `packages/jxl-pyramid/src/decode-level.ts`, `choose-level.ts`, `tiled-decode-pool.ts` | **Yes** | **Yes** | Fully implemented. Addressed 16-bit progressive decode corruption, sorted `chooseLevelForTarget` by longEdge instead of area, implemented WeakMap memoization (commit `9c607d70`). |
| **FableSuggestions - DONE.md** (Root-level) | `packages/jxl-pyramid/src/decode-level.ts`, `level-source.ts`, `decode-core.ts` | **Yes** | **Yes** | Fully implemented via subsequent sequential Agent runs (Agent 2 `9e690ff4`, Agent 4 `97a48634`, Agent 6 `552a4f22`, Caching `8137763e`). Resolved NaN index math and viewport grid stitching alignment bugs. |
| **docs/LevelSuggestions - DONE.md** | `packages/jxl-pyramid/src/decode-level.ts`, `level-source.ts`, `decode-core.ts` | **Yes** | **Yes** | Fully implemented. Fixed `createLevelSource` single-parse violation and nominal casts. |
| **docs/JxlPolicyIndexDecisionsState - DONE.md** (or `JxlPolicyIndexDecisionsState.md`) | `packages/jxl-policy/src/index.ts` | **Yes** | **Yes** | **Fully implemented!** Presets are now frozen, type derivation is complete, `downsampleForContainer` utility uses clz32, `mlInference` preset added, and validation guards are in place. |
| | `packages/jxl-policy/DECISIONS.md` | **Yes** | **Yes** | **Fully implemented!** Up to date. |
| | `packages/jxl-policy/STATE.md` | **Yes** | **Yes** | **Fully implemented!** Complete. |
| **docs/JxlNativeIndexNativeccCodecTestBindingGyp - DONE.md** (or `JxlNativeIndexNativeccCodecTestBindingGyp.md`) | `packages/jxl-native/src/index.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-native/src/native.cc` | **Yes** | **Yes** | Fully implemented (zero-copy native push and removed redundant per-frame animation copies). |
| | `packages/jxl-native/test/codec.test.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-native/binding.gyp` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-jxl-capabilities-index-probe-wb-probe-lens-review - DONE.md** | `packages/jxl-capabilities/src/index.ts` | **Yes** | **Yes** | Fully implemented (lazy SIMD, runtime ordering, `_isNode()`). |
| | `probe.ts` | **Yes** | **Yes** | **Fully implemented!** Added preflight server checks, file existence checks, and flexible browser options. |
| | `wb-probe.ts` | **Yes** | **Yes** | **Fully implemented!** Refactored to use named constants for 15 parameters, added directory expansion, usage instructions on zero args, and NDJSON outputs. |
| **HANDOFF-worker-decode-handler-facade-lens-review.md** | `packages/jxl-worker-browser/src/worker.ts` | **Yes** | **Yes** | Fully implemented (aborted starts, queue caps, `messageerror`). |
| | `packages/jxl-worker-browser/src/decode-handler.ts` | **No** | **No** | **Unimplemented** (R14-D1 to R14-D4 optimizations missing). |
| | `packages/jxl-wasm/src/facade.ts` | **No** | **No** | **Unimplemented** (R14-F1 to R14-F15 facade optimizations missing). |
| **PyramidManifestCachePlan.md** | `packages/jxl-pyramid/src/cache.ts` | **Yes** | **Yes** | Partially implemented (C1 guard is present; others pending). |
| | `packages/jxl-pyramid/src/manifest.ts` | **Yes** | **Yes** | Partially implemented (M1 `convergedByteEnd` is present; others pending). |
| **HANDOFF-tauri-parity-2026-06-03.md** | `crates/raw-pipeline/src/casabio_encode.rs` | **Yes** | **Yes** | Fully implemented (RGBA direct paths and progressive controls). |
| | `crates/raw-pipeline/src/pipeline.rs` | **Yes** | **Yes** | Fully implemented (RGBA processing). |
| | `crates/raw-pipeline/src/jxl_lowlevel.rs` | **No** | **No** | **Unimplemented** (Region/ROI native decode is incomplete). |
| **EncodehandlerFacadeEncodestart - DONE.md** | `packages/jxl-worker-browser/src/encode-handler.ts` | **Yes** | **Yes** | Fully implemented (`disablePerceptualHeuristics` + orientation). |
| | `packages/jxl-wasm/src/facade.ts` | **Yes** | **Yes** | Fully implemented (`disablePerceptualHeuristics` + PGO testing). |
| | `packages/jxl-core/src/schemas/encode_start.json` | **Yes** | **Yes** | Fully implemented. |
| **EncodesessionTypesEncodeSessiontest - DONE.md** | `packages/jxl-session/src/encode-session.ts` | **Yes** | **Yes** | Fully implemented (session-side options forwarding). |
| | `packages/jxl-core/src/types.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-session/test/encode-session.test.ts` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-build-mjs-build-pgo-dockerfile-build-parallel-wasm-lens-review - DONE.md** | `build-parallel-wasm.ps1` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-wasm/scripts/build-pgo.mjs` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-wasm/Dockerfile` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-compare-analyze-serve-jxl-roundtrip-colour-cmp-example-wasm-usage-lens-review - DONE.md** | `compare.ts`, `analyze.ts`, `serve.ts` | **Yes** | **Yes** | Fully implemented (zero-copy moves and unified metrics). |
| | `jxl-roundtrip.ts`, `colour-cmp.ts` | **Yes** | **Yes** | Fully implemented. |
| | `example-wasm-usage.ts` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-decode-session-event-stream-stream-browser-lens-review - DONE.md** | `packages/jxl-session/src/decode-session.ts` | **Yes** | **Yes** | Fully implemented (event streams & budget integration). |
| | `packages/jxl-stream/src/stream-browser.ts` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-jxl-cache-lru-browser-node-lens-review  - DONE.md** | `packages/jxl-cache/src/lru-browser.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-cache/src/lru-node.ts` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-jxl-capabilities-wasm-loader-spawn-lens-review - DONE.md** | `packages/jxl-worker-browser/src/wasm-loader.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-worker-browser/src/spawn.ts` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-jxl-core-types-protocol-decode-start-schema-errors-lens-review - DONE.md** | `packages/jxl-core/src/types.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-core/src/protocol.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-core/src/schemas/decode_start.json` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-core/src/errors.ts` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-jxl-native-index-nativecc-codec-test-binding-gyp-lens-review - DONE.md** | `packages/jxl-native/src/index.ts` | **Yes** | **Yes** | Fully implemented (zero-copy native push). |
| | `packages/jxl-native/src/native.cc` | **Yes** | **Yes** | Fully implemented (removed redundant per-frame animation copies). |
| | `packages/jxl-native/test/codec.test.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-native/binding.gyp` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-jxl-native-index-node-decode-handler-lens-review - DONE.md** | `packages/jxl-native/src/index.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-worker-node/src/decode-handler.ts` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-jxl-pyramid-decode-level-cache-tiled-pool-lens-review - DONE.md** | `packages/jxl-pyramid/src/decode-level.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-pyramid/src/cache.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-pyramid/src/tiled-decode-pool.ts` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-jxl-pyramid-level-source-decode-level-decode-core-tiled-pool-cache-lens-review - Done.md** | `packages/jxl-pyramid/src/level-source.ts` | **Yes** | **Yes** | Fully implemented (megatexture tiling, caching, prefetching). |
| | `packages/jxl-pyramid/src/decode-level.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-pyramid/src/decode-core.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-pyramid/src/tiled-decode-pool.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-pyramid/src/cache.ts` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-jxl-stream-node-browser-range-test-lens-review - DONE.md** | `packages/jxl-stream/src/stream-node.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-stream/src/stream-browser.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-stream/src/range.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-stream/test/stream.test.ts` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-jxl-test-corpus-loader-manifest-types-pgo-lens-review - DONE.md** | `packages/jxl-test-corpus/src/loader.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-test-corpus/src/manifest.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-test-corpus/src/types.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-test-corpus/src/pgo.ts` | **Yes** | **Yes** | Fully implemented (dynamic PGO training corpus). |
| **HANDOFF-jxl-worker-node-worker-decode-encode-backend-selector-spawn-index-lens-review - DONE.md** | `packages/jxl-worker-node/src/worker.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-worker-node/src/decode-handler.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-worker-node/src/encode-handler.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-worker-node/src/backend-selector.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-worker-node/src/spawn.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-worker-node/src/index.ts` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-pyramid-ingest-ladder-quality-lens-review - DONE.md** | `packages/pyramid-ingest/src/ladder.ts` | **Yes** | **Yes** | Fully implemented (ladder-quality sweep). |
| | `packages/pyramid-ingest/src/quality.ts` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-verify-browser-bun-chrome-node-cdp-progressive-probe-lens-review - DONE.md** | `verify-browser.ts` | **Yes** | **Yes** | Fully implemented (browser launching + telemetry). |
| | `bun-persistent-chrome-check.ts` | **Yes** | **Yes** | Fully implemented. |
| | `node-cdp-check.mjs` | **Yes** | **Yes** | Fully implemented. |
| | `node-cdp-ps-check.mjs` | **Yes** | **Yes** | Fully implemented. |
| | `node-persistent-check.mjs` | **Yes** | **Yes** | Fully implemented. |
| | `node-attach-check.mjs` | **Yes** | **Yes** | Fully implemented. |
| | `probe.ts` | **Yes** | **Yes** | Fully implemented. |
| **SchedulerPoolQueueBudgetDedupeTypes - DONE.md** | `packages/jxl-scheduler/src/scheduler.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-scheduler/src/pool.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-scheduler/src/queue.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-scheduler/src/budget.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-scheduler/src/dedupe.ts` | **Yes** | **Yes** | Fully implemented. |
| | `packages/jxl-scheduler/src/types.ts` | **Yes** | **Yes** | Fully implemented. |
| **raw-pipeline-22-lens-handoffs - DONE.md** | `crates/raw-pipeline/src/lib.rs` | **Yes** | **Yes** | Fully implemented. |
| | `crates/raw-pipeline/src/pipeline.rs` | **Yes** | **Yes** | Fully implemented. |
| | `crates/raw-pipeline/src/casabio_encode.rs` | **Yes** | **Yes** | Fully implemented. |
| | `crates/raw-pipeline/src/tiff.rs` | **Yes** | **Yes** | Fully implemented. |
| **EncodePipelineCrossencoder - DONE.md** | `crates/raw-pipeline/src/crossencoder.rs` | **Yes** | **Yes** | Fully implemented. |
| | `crates/raw-pipeline/src/pipeline.rs` | **Yes** | **Yes** | Fully implemented. |
| **Butteraugli-implementation-handoff - DONE.md** | `packages/jxl-wasm/src/bridge.cpp` | **Yes** | **Yes** | Fully implemented (`jxl_wasm_butteraugli_compare` added). |
| | `packages/jxl-wasm/src/facade.ts` | **Yes** | **Yes** | Fully implemented (calls FFI comparator). |
| **HANDOFF-progressive-paint-speedup-A3-A4-2026-06-06 - DONE.md** | `web/jxl-progressive-paint.js` | **Yes** | **Yes** | Fully implemented (A3 canvas reuse, `makePassCanvas` removed). |
| **ProgressiveSaliencyImplementationPlan - DONE.md** | (Duplicates Session / Encode plans) | **Yes** | **Yes** | Fully implemented. |
| **agent6-1-corebudget-pyramid - DONE.md** | `packages/jxl-pyramid/src/tiled-decode-pool.ts` | **Yes** | **Yes** | Fully implemented (CoreBudget & pool controls). |
| | `packages/jxl-pyramid/src/decode-core.ts` | **Yes** | **Yes** | Fully implemented. |
| **agent6-2-animation-frames - DONE.md** | `packages/jxl-wasm/src/facade.ts` | **Yes** | **Yes** | Fully implemented (progressive animation frames). |
| **agent6-3-jxtc-v2-reader - DONE.md** | `packages/jxl-pyramid/src/tiling.ts` | **Yes** | **Yes** | Fully implemented (fast JXTC index reads). |
| **agent6-4-icc-pyramid-canvas - DONE.md** | `packages/jxl-pyramid/src/decode-level.ts` | **Yes** | **Yes** | Fully implemented (ICC preservation controls). |
| **HANDOFF-predator-continuation-2026-06-encode-matrix - DONE.md** | `web/jxl-correlation-matrix.js` | **Yes** | **Yes** | Fully implemented. Integrated `progressiveDc` and `groupOrder` into correlation matrix sweeps and factors. |
| | `web/jxl-correlation-worker.js` | **Yes** | **Yes** | Fully implemented. |
| **HANDOFF-progressive-paint-sneyers-gallery-issues - DONE.md** | `web/jxl-progressive-paint.js` | **Yes** | **Yes** | Fully implemented. Resolved progressive sneyers rendering and binary buffer size calculation issues. |
| **HANDOFF-single-progressive-progressive-tuning-2026-06-05 - DONE.md** | `web/jxl-single-progressive.js` | **Yes** | **Yes** | Fully implemented. Re-enabled multi-checkpoint progressive visualization and speed tracking. |
| **HANDOFF-tauri-parity-continuation-2026-06-04.md** | `crates/raw-pipeline/src/jxl_lowlevel.rs` | **Yes** | **Yes** | Partially implemented. Continues Tauri/WASM parity on ROI, full progressive loads, and shared lightbox metrics. |
| **Session-handoff-2026-06-05 - DONE.md** | `packages/jxl-scheduler/src/scheduler.ts` | **Yes** | **Yes** | Fully implemented. Integrated JXTC extraction, previewFirst, downsample, and animation metadata. |
| | `packages/jxl-wasm/src/facade.ts` | **Yes** | **Yes** | Fully implemented. |
| **Opus4.8ThrottleHandoff - DONE.md** | `web/jxl-single-progressive.js` | **Yes** | **Yes** | Fully implemented. Fixed progressive rendering overhead, added async `createImageBitmap`, and disabled borders > 4 MP. |
| | `packages/jxl-worker-browser/src/worker.ts` | **Yes** | **Yes** | Fully implemented (decode-in-worker defaults to ON). |
| **BENCHMARK_AND_TESTING_HANDOFF - DONE.md** | General | **Yes** | **Yes** | Fully implemented. Historical snapshot of production assessments, RAW pipeline orient, and release hygiene. |
| **docs/superpowers/plans/2026-06-12-jxl-session-mt-fallback-routing - DONE.md** | `packages/jxl-session/src/tier-routing.ts`, `context-base.ts`, `test/tier-routing.test.ts`, `test/tiered-context.test.ts` | **Yes** | **Yes** | **Fully implemented!** Added browser-session routing with fallback to ST workers under contention and comprehensive unit tests. |
| **docs/superpowers/plans/2026-06-03-truly-progressive-jxl - DONE.md** | `packages/jxl-wasm/src/facade.ts`, `web/jxl-progressive-quality.js`, `benchmark/jpeg-progressive-stream.mjs` | **Yes** | **Yes** | **Fully implemented.** Added byte-streaming benchmarks, network-throttled UI controls, monotone-quality assertions, and wired Sneyers preset. |
| **docs/superpowers/plans/2026-06-05-butteraugli-bridge - DONE.md** | `packages/jxl-wasm/src/bridge.cpp`, `packages/jxl-wasm/src/facade.ts`, `benchmark/streaming-ssim-benchmark.mjs` | **Yes** | **Yes** | **Fully implemented.** Exposed libjxl Butteraugli FFI compare binding, wrapped in facade, and integrated into streaming SSIM benchmarks. |
| **docs/superpowers/plans/2026-06-06-progressive-decode-perf - DONE.md** | `packages/jxl-wasm/src/bridge.cpp`, `packages/jxl-wasm/test/progressive-detail.test.ts` | **Yes** | **Yes** | **Fully implemented.** Removed open-stream opportunistic flushes, skipped redundant all-zero scans after first flush, and speeded up progressive loads. |
| **docs/superpowers/plans/2026-06-06-progressive-paint-speedup - DONE.md** | `web/jxl-progressive-paint.js`, `web/jxl-single-progressive.js` | **Yes** | **Yes** | **Fully implemented.** Removed artificial inter-step delays, implemented rAF event coalescing, and tile-aware memoized diff algorithm. |
| **docs/superpowers/plans/2026-06-09-convergence-profiling - DONE.md** | `packages/pyramid-ingest/src/schema.ts`, `packages/pyramid-ingest/src/manifest.ts` | **Yes** | **Yes** | **Fully implemented.** Expanded ingestion compiler manifest schema and CLI arguments with `convergedByteEnd` and quality-aware profiling. |
| **docs/superpowers/plans/unified implementation plan - DONE.md** | General | **Yes** | **Yes** | **Fully implemented.** Grand unification roadmap for all progressive JXL improvements, closing progressive-vs-one-shot gap, and worker frame-stats offload. |
| **JxlByteCutoffBenchmarks-DONE.md** | docs/ (Group 13: exactly the 5 web/ files for client-side bandwidth & cutoff profiling lens review) | **Yes** (this commit) | N/A (plan/doc + verification only; no source code changes in plan-mode pass) | Complete. 21-lens review (linkage/APIs/stages/state/kernels/boundaries + creative: owl/backwards/astronomy/LLM/gaming/photogram/AR/perceptual color). 5 agent handoffs (one file each) with required phrases + snippets. StandardMultifileTest.mjs baseline run (exit 0, timings captured, no regressions). Renamed to -DONE per instruction. docs/outputs/ (test artifacts) respected via .gitignore. |

---

## Detailed Outstanding Work (What files have NOT been optimized yet?)

This section compiles the specific files and folders that have been missed or are partially implemented:

### 1. Browser Decoder & Facade Optimizations (R14-D and R14-F)
* **Document Ref:** `docs/HANDOFF-worker-decode-handler-facade-lens-review.md`
* **Status:** Partially Implemented (only `worker.ts` has abortedStarts/messageerror additions).
* **Missing Work in `decode-handler.ts` (browser):**
  - **R14-D1:** Early progression targets (`"dc" | "pass"`) do not terminate worker slots early; sessions remain active and locked inside `decodeSessions` until manually released by the main thread.
  - **R14-D2:** Pause signals are not checked between chunks during active inner feed-loops (can cause the worker to continue decoding during active scheduler pauses).
  - **R14-D4:** Skip `decode_cancelled` emissions for `release_state` actions to avoid dead structured-clone roundtrips.
* **Missing Work in `facade.ts` (WASM):**
  - **R14-F1 (Critical Perf Win):** Fuse buffer views and crop/downsample/resize directly to avoid allocating and copying a full-frame pixel slice. This causes massive memory bandwidth and GC overhead on high-res gallery and viewer renders.
  - **R14-F5:** Dedupe FFI field reads; extract a helper `readBufferFields(module, handle)` instead of duplicated HEAPU32 offsets.
  - **R14-F7:** Butteraugli compare uploads both images on every call; needs resident reference caching to half the FFI transfer costs during convergence sweeps.
  - **R14-F12:** Fuse cover-mode resize + crop: avoid resizing pixel lines that get cropped out immediately.

### 2. Native Parity decode_region (Tauri)
* **Document Ref:** `docs/HANDOFF-tauri-parity-2026-06-03.md`
* **Status:** Partially Implemented.
* **Missing Work in `crates/raw-pipeline/src/jxl_lowlevel.rs`:**
  - Plumb tiled ROI decoding down to native structures.
  - Pass the normalized subject rect down to native codecs to crop inside the low-level decoder instead of full-decode-then-crop.

## JXL Pipeline Files Optimization Status

This section provides a complete review of all JXL pipeline source files and their current optimization status based on the registry above.

### Fully Optimized
- `crates/raw-pipeline/src/casabio_encode.rs`
- `crates/raw-pipeline/src/lib.rs`
- `crates/raw-pipeline/src/pipeline.rs`
- `crates/raw-pipeline/src/tiff.rs`
- `packages/jxl-capabilities/src/index.ts`
- `packages/jxl-core/src/errors.ts`
- `packages/jxl-core/src/protocol.ts`
- `packages/jxl-core/src/types.ts`
- `packages/jxl-native/src/index.ts`
- `packages/jxl-policy/src/index.ts`
- `packages/jxl-pyramid/src/decode-core.ts`
- `packages/jxl-pyramid/src/decode-level.ts`
- `packages/jxl-pyramid/src/level-source.ts`
- `packages/jxl-pyramid/src/tiled-decode-pool.ts`
- `packages/jxl-pyramid/src/tiling.ts`
- `packages/jxl-scheduler/src/budget.ts`
- `packages/jxl-scheduler/src/dedupe.ts`
- `packages/jxl-scheduler/src/pool.ts`
- `packages/jxl-scheduler/src/queue.ts`
- `packages/jxl-scheduler/src/scheduler.ts`
- `packages/jxl-scheduler/src/types.ts`
- `packages/jxl-session/src/decode-session.ts`
- `packages/jxl-session/src/encode-session.ts`
- `packages/jxl-test-corpus/src/loader.ts`
- `packages/jxl-test-corpus/src/manifest.ts`
- `packages/jxl-test-corpus/src/types.ts`
- `packages/jxl-worker-browser/src/encode-handler.ts`
- `packages/jxl-worker-browser/src/spawn.ts`
- `packages/jxl-worker-browser/src/wasm-loader.ts`
- `packages/jxl-worker-browser/src/worker.ts`
- `packages/jxl-worker-node/src/backend-selector.ts`
- `packages/jxl-worker-node/src/decode-handler.ts`
- `packages/jxl-worker-node/src/encode-handler.ts`
- `packages/jxl-worker-node/src/index.ts`
- `packages/jxl-worker-node/src/spawn.ts`
- `packages/jxl-worker-node/src/worker.ts`
- `packages/pyramid-ingest/src/ladder.ts`
- `packages/pyramid-ingest/src/quality.ts`
- `src/lib.rs`
- `web/jxl-correlation-matrix.js`
- `web/jxl-correlation-worker.js`
- `web/jxl-progressive-paint.js`
- `web/jxl-single-progressive.js`
- `web/jxl-worker.js`

### Partially Optimized
- `packages/jxl-pyramid/src/cache.ts`
- `packages/jxl-pyramid/src/manifest.ts`

### Unoptimized (Known Missing Work)
- `crates/raw-pipeline/src/jxl_lowlevel.rs`
- `packages/jxl-wasm/src/facade.ts`
- `packages/jxl-worker-browser/src/decode-handler.ts`

### Not Yet Assessed / No Optimizations Tracked
- `crates/raw-pipeline/src/cr2.rs`
- `crates/raw-pipeline/src/decompress.rs`
- `crates/raw-pipeline/src/demosaic.rs`
- `crates/raw-pipeline/src/dng.rs`
- `crates/raw-pipeline/src/exif.rs`
- `crates/raw-pipeline/src/ljpeg.rs`
- `packages/jxl-cache/src/browser.ts`
- `packages/jxl-cache/src/index.ts`
- `packages/jxl-cache/src/lru.ts`
- `packages/jxl-cache/src/node.ts`
- `packages/jxl-core/src/index.ts`
- `packages/jxl-progressive/src/index.ts`
- `packages/jxl-progressive/src/progressive-cache.ts`
- `packages/jxl-progressive/src/progressive-manifest.ts`
- `packages/jxl-progressive/src/progressive-profile.ts`
- `packages/jxl-progressive/src/progressive-scheduler.ts`
- `packages/jxl-progressive/src/progressive-stream.ts`
- `packages/jxl-progressive/src/saliency-policy.ts`
- `packages/jxl-progressive/src/types.ts`
- `packages/jxl-pyramid/src/choose-level.ts`
- `packages/jxl-pyramid/src/constants.ts`
- `packages/jxl-pyramid/src/fixtures.ts`
- `packages/jxl-pyramid/src/grid-layout.ts`
- `packages/jxl-pyramid/src/index.ts`
- `packages/jxl-pyramid/src/plan.ts`
- `packages/jxl-pyramid/src/worker-protocol.ts`
- `packages/jxl-scheduler/src/index.ts`
- `packages/jxl-session/src/browser.ts`
- `packages/jxl-session/src/context-base.ts`
- `packages/jxl-session/src/context.ts`
- `packages/jxl-session/src/event-stream.ts`
- `packages/jxl-session/src/index.ts`
- `packages/jxl-session/src/tier-routing.ts`
- `packages/jxl-session/src/util.ts`
- `packages/jxl-stream/src/browser.ts`
- `packages/jxl-stream/src/index.ts`
- `packages/jxl-stream/src/node.ts`
- `packages/jxl-test-corpus/src/index.ts`
- `packages/jxl-wasm/src/index.ts`
- `packages/jxl-wasm/src/loader.ts`
- `packages/jxl-worker-browser/src/index.ts`
- `packages/pyramid-ingest/src/backends.ts`
- `packages/pyramid-ingest/src/checkpoint.ts`
- `packages/pyramid-ingest/src/cli.ts`
- `packages/pyramid-ingest/src/hash.ts`
- `packages/pyramid-ingest/src/ingest-worker.ts`
- `packages/pyramid-ingest/src/ingest.ts`
- `packages/pyramid-ingest/src/lock.ts`
- `packages/pyramid-ingest/src/manifest.ts`
- `packages/pyramid-ingest/src/migrate.ts`
- `packages/pyramid-ingest/src/raw-backend.ts`
- `packages/pyramid-ingest/src/rgb16.ts`
- `packages/pyramid-ingest/src/rm.ts`
- `packages/pyramid-ingest/src/schema.ts`
- `packages/pyramid-ingest/src/shard.ts`
- `packages/pyramid-ingest/src/telemetry-tty.ts`
- `packages/pyramid-ingest/src/validate.ts`
- `src/bin/blur_bench.rs`
- `src/bin/raw_decode_bench.rs`
- `web/jxl-benchmark-progress.js`
- `web/jxl-benchmark-progress.test.js`
- `web/jxl-benchmark-progressive.test.js`
- `web/jxl-benchmark.js`
- `web/jxl-bridge-orientation.test.js`
- `web/jxl-browser-context.js`
- `web/jxl-butteraugli.js`
- `web/jxl-byte-cutoff-probe.js`
- `web/jxl-byte-cutoff-probe.test.js`
- `web/jxl-compare-page.test.js`
- `web/jxl-compare.js`
- `web/jxl-crop-benchmark.js`
- `web/jxl-crop-benchmark.test.js`
- `web/jxl-dashboard-controls.test.js`
- `web/jxl-dashboard-ui.js`
- `web/jxl-debug-console.js`
- `web/jxl-decode-worker.js`
- `web/jxl-encode-space.js`
- `web/jxl-encode-space.test.js`
- `web/jxl-file-picker.js`
- `web/jxl-frame-stats-worker.js`
- `web/jxl-orientation.test.js`
- `web/jxl-preset-benchmark.js`
- `web/jxl-progressive-best-preset.js`
- `web/jxl-progressive-best-preset.test.js`
- `web/jxl-progressive-byte-benchmark.js`
- `web/jxl-progressive-byte-benchmark.test.js`
- `web/jxl-progressive-byte-metrics.js`
- `web/jxl-progressive-byte-metrics.test.js`
- `web/jxl-progressive-decode.js`
- `web/jxl-progressive-decode.test.js`
- `web/jxl-progressive-diff.test.js`
- `web/jxl-progressive-frame-stats.js`
- `web/jxl-progressive-frame-stats.test.js`
- `web/jxl-progressive-gallery-coordinator.js`
- `web/jxl-progressive-gallery-coordinator.test.js`
- `web/jxl-progressive-gallery-frame.js`
- `web/jxl-progressive-gallery-frame.test.js`
- `web/jxl-progressive-gallery-lightbox.js`
- `web/jxl-progressive-gallery-lightbox.test.js`
- `web/jxl-progressive-gallery-push.js`
- `web/jxl-progressive-gallery-push.test.js`
- `web/jxl-progressive-gallery.js`
- `web/jxl-progressive-gallery.test.js`
- `web/jxl-progressive-import.test.js`
- `web/jxl-progressive-page.test.js`
- `web/jxl-progressive-paint-coalesce.test.js`
- `web/jxl-progressive-paint-page.test.js`
- `web/jxl-progressive-policy.js`
- `web/jxl-progressive-policy.test.js`
- `web/jxl-progressive-quality.js`
- `web/jxl-progressive-quality.test.js`
- `web/jxl-progressive-session.backends.test.js`
- `web/jxl-progressive-session.js`
- `web/jxl-progressive-session.test.js`
- `web/jxl-progressive.js`
- `web/jxl-single-progressive-page.test.js`
- `web/jxl-source-folder.js`
- `web/jxl-worker-policy.js`
- `web/jxl-worker-policy.test.js`
- `web/jxl-wrapper-lab.js`
- `web/jxl-wrapper-lab.test.js`
- `web/jxl-wrapper-performance.test.js`
- `web/jxl-wrapper-timing.test.js`

---

## 2026-07-02 — Deferred-items implementation batch (QUESTIONS.md / Questions_deferred.md sweep)

Ten deferred items attempted + JOLT lossy video. Winners below; the losers (downsample hadd rewrite, compressed_dc DC X-zero) and the verified-stale items are recorded in `docs/1 rejected optimizations.md` (DS-HADD, DC-XZERO, STALE-JUL02, NOWIN-JUL02).

| Item | Where | Result | Evidence |
|:---|:---|:---|:---|
| **Metadata encode arg-shift** (WS4-B1) | `packages/jxl-wasm/src/facade.ts` | **Two live HIGH bugs fixed.** (1) Bridge `encode_rgba8_with_metadata` takes 19 params (`..., buffering, group_order, resampling, icc...`, verified arity 19 in shipped dist wasm); facade passed 17 → every ICC/EXIF/XMP pointer shifted 2 slots (ICC landed in group_order, XMP dropped). Plain rgba8/16/f32 calls likewise dropped groupOrder/resampling. (2) `chunks()` branched on `caps.streamingEncode` *before* the metadata path → metadata encodes routed through `enc_push_pixels` (no metadata params) and boxes were silently dropped. | `test/metadata-argshift.test.ts` pins arities 19/12 + XMP marker round-trip vs real scalar dist; facade ICC test now uses a real sRGB2014.icc (the old 4-byte dummy only "worked" because it was dropped). Commit on main. |
| **Progressive decoder leak on pre-alloc OOM** (WS4-B5) | `facade.ts` eventsProgressive | expectedBytes malloc ran before the try/finally that frees the decoder → OOM leaked the native decoder. Moved inside the try. | `test/progressive-dec-leak.test.ts` — red on the previous revision, green now (exactly one `dec_free` + error event). |
| **dec_ans alphabet-size uint16 wrap** (dec_ans TTFP #6) | `external/libjxl-012 lib/jxl/dec_ans.cc` | `DecodeVarLenUint16()+1` = 65536 wrapped to 0 in `uint16_t` BEFORE the max_alphabet_size check → bogus 65536-symbol alphabet passed validation as empty. Widened to u32 before the check; byte-exact for valid streams. | Harness `tools/dec_ans_alphabet_wrap_ab.cc`: OLD accepts the wrap stream, NEW rejects; 4097>4096 rejected and 1-symbol accepted by both. Branch `fix/dec-ans-alphabet-size-wrap-jul02-a7f2` (capebio, parked remote like other sub branches). |
| **dng.rs read_ascii OOB panic** (000-security) | `crates/raw-pipeline/src/dng.rs` | Inline `cnt<=4` branch sliced unchecked (crafted IFD near EOF panicked); pointer branch's `p + cnt` could wrap usize on wasm32 and bypass its guard. Both now checked_add + get(), "" on OOB; valid files identical. | Unit test covers in-bounds / inline-EOF / pointer-EOF / usize-wrap. 13 dng tests pass (MSVC). |
| **box_blur H-pass row-parallel + alloc elision** (box_blur follow-ups a–c) | `perceptual/blur.rs`, `perceptual/mod.rs` | `box_blur_h` (shared by scalar + AVX2 blur — the ref-build dominator) now row-parallel under `parallel`; scalar `box_blur` tmp/dst and the Comparer::new pyramid buffers (rx/ry/rb, nx/ny/nb) allocate uninit (all fully overwritten before read; same pattern as box_blur_avx2). WASM keeps serial. | Interleaved flipflop `examples/box_blur_h_par_flip.rs` (12 threads): **+79.2% @1MP, +79.3% @6MP, +77.2% @24MP (4.4–4.8×), bit-exact**. 31 perceptual tests pass; wasm32 check clean. |
| **casabio preview+full leaf coalescing** (CASA-ENC D3) | `crates/raw-pipeline/src/casabio_encode.rs` | When long edge ≤1080, quality 85 (non-RAW/non-HQ) and progressive_dc==0, preview and full are the identical encode (EFFORT_PREVIEW==EFFORT_FULL==3, same opts) → encode once, share bytes. Drops one whole e3 encode (~halves encode work) for small/medium non-RAW uploads; byte-exact by construction; debug_assert pins the predicate. | Tests: coalesced tiers byte-identical + controls (HQ q95 / RAW q90 / progressive / >1080) stay separate. 16 casabio tests pass (MSVC). |
| **estimateLightnessStats percentile sort** (perceptual-color batch a) | `web/perceptual-color.mjs` | `Array.from(Float32Array).sort(comparator)` → `Float32Array.slice().sort()` (typed numeric sort, no boxing/comparator). Value-identical percentiles. | Node flipflop `web/test/perceptual-color-sort-flip.mjs`: **+78.0% @1MP (4.55×), +84.5% @6MP (6.47×)**; percentile identity asserted incl. n=1. 22 perceptual-color tests pass. |
| **conv5 pool-Status propagation** (conv5 leftovers #5) | `external/libjxl-012 lib/jxl/enc_convolve_separable5.cc` | `RunInteriorRows` DASSERTed then discarded the RunOnPool Status (runner failure reported as success). Status now threads RunInteriorRows → RunRows → Run(). No data-path change. | clang++ -fsyntax-only clean. Branch `fix/conv5-status-propagation-jul02-s3v1` (capebio). |

### JOLT — JXL-Optimized Lossy Transport (new)

The lossy CASAVA (Casabio's Video Apparatus) tier is now a branded codec profile (`docs/jolt-lossy-video.md`): JXL VarDCT intra (chunked constant-peak encoder) + fresh-pixel REPLACE-skip P-frames with in-loop reconstruct. New in this batch: **rate metadata in the container** (CasvHeader.flags bit0=lossy, distance q0.1 in bits 8..15, effort in 16..19 + accessors; CASR rate box for footer/streamed files with legacy-safe parsing), **presets** (`JoltPreset::{Realtime, Balanced, Quality}`), one-call `jolt_encode` / `jolt_encode_stream_to`, and `examples/jolt_bench.rs`.

Measured on 48 real dashcam frames @1280×720 (single-threaded decode, 24 fps budget):

| tier | size vs raw | dec ms/f | dec fps | real-time? |
|---|---|---|---|---|
| JOLT Realtime (d2.0/e1) | **3.0%** | 18.1 | 55 | PASS |
| JOLT Balanced (d1.0/e3) | 5.2% | 23.8 | 42 | PASS |
| JOLT Quality (d0.5/e4) | 8.1% | 18.8 | 53 | PASS |
| lossless archive | 13.3% | 109.7 | 9 | over |

Every JOLT preset decodes 720p in real time; the lossless tier does not — that gap is what JOLT fills. 27 casa_video tests pass (2 new: header rate flags + CASR box incl. legacy splice compatibility).

---

## 2026-07-03 — Deferred batch 2 (moonshots) — branch feat/deferred-batch2-jul03-m8x4

Off super main b15c3cb4. Video moonshots first, then perf/hardening. Losers → `docs/1 rejected optimizations.md` (AQ-RIDERS, ENT-D1-DEFER, STALE-JUL03).

### CASAVA / JOLT video (3 moonshots)

| Item | Where | Result |
|:---|:---|:---|
| **JE-8 square atlas** | `casa_video.rs` tile P-frames | The lossy-tile REPLACE atlas packed changed tiles into a t-wide sliver — the shape that made MT encode SLOWER (CV-E6). Now a ~square `ceil(sqrt(n))`-column grid, signalled by the tile-size u16 high bit (`CASV_TILE_V2_BIT`); v1 payloads + lossless residual tier stay v1. Ghana 720p A/B (`examples/atlas_v2_flip.rs`): **t16 size −6.5% / enc −61.1% / dec −41.8%; t32 size −4.6% / enc −40.9% / dec −24.7%**, reconstruction mean-err unchanged. Batch/stream byte-parity held; v1 back-compat + v2 square-dims tests. |
| **JOLT rate control** | `casa_video.rs` streaming encoders | Spec §3.5 delivered as closed-loop feedback (not per-GOP probe searches — zero extra encode work). New `RateControl{target_bytes_per_sec,min/max_distance,vbv_seconds}` + `CasaVideoOptions::streaming_bitrate`. Per-GOP leaky-bucket VBV + damped multiplicative distance update (`d*=sqrt(actual/target)` × bucket term, clamped). Hook `StreamCtx::set_distance` rebuilds the reused Encoder + re-derives auto thresh. Real 720p (`examples/jolt_rc_demo.rs`, GOP12): **1× target lands +0.5%**; 0.5× walks 3245k→1392k B/s, 2× walks 3245k→6226k B/s, converging by GOP 3–4. Streaming-only; fixed-distance default bit-identical. Tests: both-direction steering + clamps/extremes. |
| **casv-web browser playback** | new `packages/casv-web` | CASAVA was native-only. New TS package parses header+footer+index+rate-box, decodes I-frames via any injected JXL decoder (pairs with `@casabio/jxl-wasm createDecoder`, zero hard deps), composites REPLACE bbox + tile (v1 sliver + v2 square) P-frames into running RGBA. Lossless-residual + Fable tiers guarded with clear errors. Fixtures generated natively (`examples/casv_web_fixtures.rs`); **8 bun tests** compare browser output vs native decode (RGB max-diff ≤3 / mean ≤1.0 — wasm-scalar vs native-SIMD JXL decode is not bit-specified — alpha exactly 255), rate metadata exact, reuseBuffer pixel-identical, reject paths covered. tsc clean. |

### Perf / hardening

| Item | Where | Result |
|:---|:---|:---|
| **wasm128 downscale_rgba** | `src/lib.rs` | Integer-multiple thumbnail box filter: RGBA lanes stay 4-byte-aligned, so u8x16→u16x8 accumulate with zero deinterleave, fold to u32x4 [R,G,B,A]. Pixel-identical (integer sums order-independent); xstep 2..512 takes SIMD. Two-module Node flipflop (`web/test/downscale-rgba-simd-flip.mjs`): **2×+14.8%, 4×+53.5%, 8×+62.8%, 6×+42.2%**. (Planar-rgb16 sibling dropped: private fn, arbitrary-fit callers, unmeasurable.) |
| **MHC demosaic AVX2** | `crates/raw-pipeline/src/demosaic.rs` | The quality-demosaic dominator ran scalar. New `mhc_row_interior_avx2` vectorizes interior rows: fixed row-parity means only two of four arms alternate per column — both evaluated from 13 widening contiguous loads (no gathers), blended by a constant column-parity mask. Same i32 ops/shifts/clamps → bit-identical (7 sizes × 4 phases, full-range). Flipflop (`examples/demosaic_mhc_avx2_flip.rs`): **+52.2/+51.4/+54.2% (2.1×) @1.9/6/24 MP**, beating the +22% estimate. |
| **decode-handler test gaps** | `jxl-worker-browser/test/handlers.test.ts` | Closed all 4 CLAUDE.md gaps: cancel-while-paused (dispose+decode_cancelled), cancel-during-active-push (safe dispose, no resurrection), worker_drain byte-HWM coalescing, DRAIN_MIN_INTERVAL_MS spam gate (frozen-clock). 20 handler tests pass. |
