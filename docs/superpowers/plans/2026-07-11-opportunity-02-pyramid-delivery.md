# Pyramid Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one modular gallery consume one bounded tiled/progressive delivery runtime with stable source identity, correct cancellation, and explicit precision/tiling policy.

**Architecture:** `@casabio/jxl-pyramid` owns level selection and decode orchestration. The browser supplies a stable `LevelSource`, worker/cache capabilities, and view demand. Workers lease byte sources instead of cloning or retaining complete containers indefinitely. The modular gallery becomes the only product entry point.

**Tech Stack:** TypeScript, JavaScript, Web Workers, SharedArrayBuffer, ArrayBuffer, JXTC, JXL progressive manifests, browser cache, WebGL/Canvas.

## Global Constraints

- Master program: `docs/superpowers/plans/2026-07-11-codebase-opportunity-roadmap.md`.
- Findings owned here: 2, 26, 33, 42, 49, 70, 71, 74, 76-82.
- Lead model: Opus. Program effort: XL.
- Lead worktree: `C:\Foo\rcw-pyramid-delivery-opus-20260711`.
- Lead branch: `feat/pyramid-delivery-opus-20260711`.
- Delegated worktree: `C:\Foo\rcw-pyramid-<task-slug>-<agent-id>`.
- Delegated branch: `feat/pyramid-<task-slug>-<agent-id>`.
- Start contract-dependent tasks from the integrated packet 1 commit, not an older base.
- Do not copy packet 1 parsers, manifest types, identity, or trust-boundary code.
- Preserve progressive decode checkpoint behavior and run its protected tests around bridge changes.
- Every delivery/performance claim uses `flipflopdom`; memory/carrier claims also use `flipflopMem`.

---

## Finding Evidence

| Find | Evidence | Opportunity |
|---:|---|---|
| 2 | `web/jxl-progressive-session.js:17-62`; `web/jxl-progressive-decode.js:119-170`; `web/pyramid-gallery/image-store.js:104-130`; `web/pyramid-gallery/pyramid-decode.js:12-49`; `web/pyramid-gallery/grid-controller.js:41-62` | Use the existing manifest/range/progressive stack instead of full-file gallery fetches |
| 26 | `packages/jxl-pyramid/src/choose-level.ts:10-62`; `web/pyramid-gallery.js:76,190,235,461`; `web/lightbox/pyramid-lightbox.js:117-125,326-380,633-640`; `web/tauri-pyramid-client.js:22-23,104-162`; `web/tauri-parity-lightbox.js:183-184` | One LOD/ROI/quality resolver |
| 33 | `packages/jxl-cache/src/browser.ts:73-76,124-173,284-307,363-375`; `packages/jxl-cache/test/browser.test.ts:92-109`; `packages/asset-store/src/index.js` | Select an appropriate shared, owned, cached, or ranged byte carrier without repeated whole-buffer copies |
| 42 | `web/lightbox/pyramid-lightbox.js:372-484,642-649,702-783` | Abort/generation-guard overlapping image and level loads |
| 49 | `web/pyramid-gallery/grid-controller.js:41-91` | Count every shared-decode consumer and cancel only after all release |
| 70 | `packages/pyramid-ingest/src/ladder.ts:20-34,38-109,112-143`; `src/backends.ts:65-85,151-160` | Honor RGB16 tiling policy and allow monolithic 16-bit levels |
| 71 | `packages/pyramid-ingest/src/ladder.ts:151-173`; `src/backends.ts:231-264,266-313,323-395` | Bound convergence profiling and reuse reference decodes |
| 74 | `web/index.html:56-57`; `web/pyramid-gallery.html:54`; `web/pyramid-gallery.js:1-616`; `web/pyramid-gallery/pyramid-gallery.html:65`; `web/pyramid-gallery/pyramid-gallery.js:1-128` | Make modular gallery canonical and retire legacy product duplication |
| 76 | `packages/jxl-pyramid/src/manifest.ts:182-198`; `src/manifest-validate.ts:287-308`; `packages/pyramid-ingest/src/schema.ts:95-110`; `src/manifest.ts:70-80`; `src/ingest.ts:236-260,936-975`; `web/pyramid-gallery/pyramid-gallery.js:69-122` | Use existing thumbhash, group/next, metadata, and pagination fields |
| 77 | `packages/jxl-pyramid/src/decode-level.ts:34-141,144-456,503-520`; `src/tiled-decode-pool.ts:1-33,886-910,1093-1412`; `src/decode-core.ts:342-369,452-485`; `src/index.ts:12-20` | Consolidate two public decode orchestration engines |
| 78 | `web/pyramid-gallery/pyramid-decode.js:1-30`; `packages/jxl-pyramid/src/decode-core.ts:326-369`; `src/tiled-decode-pool.ts:260-266,340-346,760-790,811-838,1120-1124,1270-1300` | Keep one pool, stable source key, and supported options; stop byte reloads |
| 79 | `packages/jxl-pyramid/src/tiled-decode-pool.ts:760-790,1281-1300`; `src/tiling.ts:87-118,212-249`; `web/pyramid-gallery/pyramid-decode.js:13-28` | Avoid cloning a complete JXTC container into each non-SAB worker |
| 80 | `packages/jxl-pyramid/src/worker-protocol.ts:22-33`; `src/tiled-decode-pool.ts:260-266,760-790`; `web/lightbox/tiled-decode-worker.js:14-46` | Add unload/refcount/budget; do not `.slice()` shared memory into ownership |
| 81 | `packages/pyramid-ingest/src/ladder.ts:38-66`; `src/manifest.ts:70-80`; `packages/jxl-pyramid/src/manifest.ts:173-190`; `web/pyramid-gallery/grid-controller.js:41-62,141-154`; `web/pyramid-gallery/pyramid-gallery.js:109-116` | Make L0 transport and precision explicit instead of assuming monolithic RGBA8 |
| 82 | `packages/jxl-pyramid/src/tiling.ts:188-208`; `src/tiled-decode-pool.ts:798-808` | Separate Worker availability from SAB/cross-origin-isolation capability |

## Target Interfaces

Task 1 may refine names. Later tasks must use the accepted signatures.

```ts
export type LodRequest = {
  targetLongEdge: number;
  dpr: number;
  region?: { x: number; y: number; width: number; height: number };
  quality?: "preview" | "interactive" | "final";
};

export type DecodeCapabilities = {
  workers: boolean;
  sharedMemory: boolean;
  rangeRequests: boolean;
  rgba16: boolean;
};

export interface LevelSource {
  readonly sourceKey: string;
  size(): Promise<number>;
  read(range?: { start: number; endExclusive: number }, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface DecodeLease<T> {
  readonly promise: Promise<T>;
  release(): void;
}
```

One public decode entry point accepts manifest, stable `LevelSource`, demand, capabilities, signal, and runtime/pool. Gallery code does not create a pool inside a decode call.

## Task Order

```text
1 pin modular entry point and runtime contract
2 precision/tiling/ladder policy                    after packet 1 schema
3 consolidate decode runtime                        after 1-2
4 byte carriers and worker lifetime                 after 3
5 cancellation and stale-result ownership           after 3
6 progressive/range LOD resolver                    after 3-5
7 gallery latent features and legacy retirement     after 6
8 end-to-end performance and memory proof            last
```

### Task 1: Pin The Canonical Gallery And Decode Runtime Contract

**Findings:** 74, 77, 78  
**Model/Effort:** Opus / M

**Files:**
- Modify: `web/index.html:56-57`
- Modify: `web/pyramid-gallery/pyramid-gallery.html:65`
- Modify: `web/pyramid-gallery/pyramid-gallery.js:1-128`
- Create: `packages/jxl-pyramid/src/runtime.ts`
- Modify: `packages/jxl-pyramid/src/index.ts:12-20`
- Create: `packages/jxl-pyramid/test/runtime.contract.test.ts`

**Interfaces:**
- Produces the target interfaces above and names modular gallery as engine of record.
- Legacy gallery remains a temporary redirect/compatibility test until Task 7.

- [ ] Write a contract test that constructs one runtime, performs several level decodes, and asserts one pool/source registration across calls.
- [ ] Assert unsupported option names fail at the caller boundary rather than being ignored.
- [ ] Run the runtime and gallery tests; expected initial failure: gallery recreates closure/pool state and public orchestration is ambiguous.
- [ ] Export one public runtime API without deleting old entry points yet.
- [ ] Route `web/index.html` to the modular page while retaining a temporary redirect from `web/pyramid-gallery.html`.
- [ ] Run both gallery suites and the new runtime contract.
- [ ] Commit as `refactor(pyramid): establish canonical gallery runtime`.

### Task 2: Make Precision, Seed, Tiling, And Ladder Policy Explicit

**Findings:** 70, 71, 81  
**Model/Effort:** Opus / L

**Files:**
- Modify: `packages/pyramid-ingest/src/ladder.ts:20-173`
- Modify: `packages/pyramid-ingest/src/backends.ts:65-85,151-160,231-395`
- Modify: `packages/pyramid-ingest/src/manifest.ts:70-80`
- Modify: `packages/jxl-pyramid/src/manifest.ts:173-190`
- Modify: `web/pyramid-gallery/grid-controller.js:41-62,141-154`
- Test: `packages/pyramid-ingest/test/rgb16.test.ts`
- Test: `packages/pyramid-ingest/test/ladder.test.ts`
- Test: `packages/pyramid-ingest/test/tiling-ingest.test.ts`

**Interfaces:**
- Consumes packet 1 tiling/orientation schema.
- Produces explicit per-level `transport`, `bitsPerSample`, pixel dimensions, and optional tiling descriptor.

- [ ] Add cases for RGB8/RGB16 with `never`, `adaptive`, and `always` tiling; include missing 16-bit tile encoder.
- [ ] Assert every index seed is directly decodable through its declared transport/precision.
- [ ] Add a byte-weighted semaphore test for convergence profiling and assert each reference decode occurs once.
- [ ] Run tests; expected initial failures: ignored adaptive RGB16 policy, mandatory tile encoder, tiled L0 mistaken for whole RGBA8, unbounded profiling.
- [ ] Choose monolithic L0 as the default seed. Permit tiled L0 only when the index and seed decoder declare/support it.
- [ ] Make convergence profiling reuse already generated reference pixels and obey the ingest memory budget.
- [ ] Run package tests.
- [ ] Measure encode/decode time and peak memory with `flipflop.mjs`/`flipflopMem.mjs`; keep quality/equality guards and real RGB8/RGB16 fixtures.
- [ ] Commit as `fix(pyramid): make ladder transport and precision explicit`.

### Task 3: Consolidate Decode Orchestration

**Findings:** 77, 78, 82  
**Model/Effort:** Opus / XL

**Files:**
- Modify: `packages/jxl-pyramid/src/decode-level.ts:34-520`
- Modify: `packages/jxl-pyramid/src/decode-core.ts:326-485`
- Modify: `packages/jxl-pyramid/src/tiled-decode-pool.ts:1-33,798-910,1093-1412`
- Modify: `packages/jxl-pyramid/src/tiling.ts:188-208`
- Modify: `web/pyramid-gallery/pyramid-decode.js:1-49`
- Test: `packages/jxl-pyramid/test/decode-level.test.ts`
- Test: `packages/jxl-pyramid/test/decode-pool.worker.integration.test.ts`

**Interfaces:**
- Consumes runtime contract and explicit level descriptors.
- Produces one orchestration engine with injected strategy for direct, tiled, worker, or fallback decode.

- [ ] Write matrix tests for worker/no-worker, SAB/no-SAB, tiled/whole, RGBA8/RGBA16, aborted/not-aborted.
- [ ] Assert `workers: true, sharedMemory: false` still uses parallel workers with the owned/ranged carrier.
- [ ] Run tests; expected initial failures: duplicate planning, COI gate, option drift, and pool recreation.
- [ ] Make `decode-level.ts` the single planner/orchestrator. Reduce `decode-core.ts` to focused decode primitives and pool strategy hooks.
- [ ] Lazy-load the pool. Inject one long-lived runtime from gallery bootstrap.
- [ ] Remove `sourceKey`, `priority`, or `format` calls that are not declared by the accepted interface.
- [ ] Run jxl-pyramid build/typecheck/test and modular gallery tests.
- [ ] Commit as `refactor(pyramid): unify decode orchestration`.

### Task 4: Implement Bounded Byte Carriers And Worker Lifetime

**Findings:** 33, 79, 80  
**Model/Effort:** Opus / L

**Files:**
- Modify: `packages/jxl-cache/src/browser.ts:73-76,124-173,284-307,363-375`
- Modify: `packages/jxl-pyramid/src/worker-protocol.ts:22-33`
- Modify: `packages/jxl-pyramid/src/tiled-decode-pool.ts:260-266,760-790,1270-1300`
- Modify: `packages/jxl-pyramid/src/tiling.ts:87-118,212-249`
- Modify: `web/lightbox/tiled-decode-worker.js:14-46`
- Create: `packages/jxl-pyramid/test/byte-carrier.test.ts`

**Interfaces:**
- Consumes `LevelSource` and runtime capability split.
- Produces worker `load`, `decode`, `release`, and `unload` messages with refcount and byte budget.

- [ ] Test immutable SAB view without `.slice()`, transferable owned bytes, per-tile/range reads, explicit unload, budget eviction, worker failure, and repeated source reuse.
- [ ] Assert total transferred bytes is bounded by requested tiles plus protocol overhead in non-SAB mode, not `workers * containerSize`.
- [ ] Run tests; expected initial failures: whole-container clones and retained worker bytes.
- [ ] Implement carrier selection: shared immutable view where available; range/per-tile payload transport otherwise; owned whole buffer only below a declared threshold.
- [ ] Add worker store refcount, byte budget, LRU eviction, and unload acknowledgement.
- [ ] Ensure cache access does not force SAB or introduce another full copy.
- [ ] Run worker protocol, pool state, cache, and integration tests.
- [ ] Prove bytes, peak RSS/WASM/heap, and decode latency with flipflop and flipflopMem on large JXTC fixtures.
- [ ] Commit as `perf(pyramid): bound worker byte carriers` only if gates pass; otherwise use `refactor` and report no speed claim.

### Task 5: Fix Shared Cancellation And Stale Load Ownership

**Findings:** 42, 49  
**Model/Effort:** Opus / M

**Files:**
- Modify: `web/pyramid-gallery/grid-controller.js:41-91`
- Modify: `web/lightbox/pyramid-lightbox.js:372-484,642-649,702-783`
- Create: `web/pyramid-gallery/decode-lease.js`
- Create: `web/pyramid-gallery/decode-lease.test.js`
- Modify: `web/pyramid-lightbox.test.js`

**Interfaces:**
- Consumes `DecodeLease` from Task 1.
- Every consumer, including callers without an AbortSignal, owns one lease and releases it once.
- Underlying decode cancels only when no leases remain.

- [ ] Test a no-signal first caller plus aborting joiner, already-aborted caller, all callers aborting, navigation during decode, monotonic upgrade, and old-image completion.
- [ ] Run tests; expected initial failures: invisible no-signal consumer and stale global state overwrite.
- [ ] Add per-open AbortController and generation token; capture item/source key before every await and recheck before commit.
- [ ] Commit only monotonically better levels for the same item/generation.
- [ ] Release leases in `finally`; make double release harmless and observable in tests.
- [ ] Run grid, gallery, lightbox, runtime, and pool tests.
- [ ] Commit as `fix(pyramid): own shared decode cancellation`.

### Task 6: Route Gallery Demand Through Progressive Range LOD

**Findings:** 2, 26  
**Model/Effort:** Opus / XL

**Files:**
- Modify: `packages/jxl-pyramid/src/choose-level.ts:10-62`
- Create: `packages/jxl-pyramid/src/lod-resolver.ts`
- Create: `packages/jxl-pyramid/test/lod-resolver.test.ts`
- Modify: `web/jxl-progressive-session.js:17-62`
- Modify: `web/jxl-progressive-decode.js:119-170`
- Modify: `web/pyramid-gallery/image-store.js:104-130`
- Modify: `web/pyramid-gallery/pyramid-decode.js:12-49`
- Modify: `web/pyramid-gallery/grid-controller.js:41-62`
- Modify: `web/lightbox/pyramid-lightbox.js:117-125,326-380,633-640`

**Interfaces:**
- Consumes stable runtime/source and packet 1 verified fetching.
- Produces `resolveLod(manifest, request, capabilities)` mapping demand to a whole level, JXTC ranges, or progressive prefix.

- [ ] Add resolver table tests for grid, viewer, zoomed ROI, prefetch, final export, range unsupported, and cache hit.
- [ ] Add mocked HTTP tests asserting Range headers, prefix reuse, fallback behavior, cancellation, and exact bytes delivered.
- [ ] Run protected progressive tests before progressive-path edits.
- [ ] Route grid/lightbox selection through the resolver; remove local choose-level copies.
- [ ] Reuse `jxl-progressive` manifest/session/range functions; do not recreate their queue or fetch logic.
- [ ] Run protected progressive tests after edits plus resolver, choose-level, gallery, and lightbox tests.
- [ ] Use flipflopdom to compare bytes-to-first-paint, TTFP, final-paint time, decode count, and peak memory against the frozen full-file baseline.
- [ ] Commit as `feat(pyramid): deliver resolved LOD by range` only when correctness and performance gates pass.

### Task 7: Activate Existing Gallery Fields And Retire Legacy Product Code

**Findings:** 74, 76  
**Model/Effort:** Opus / L

**Files:**
- Modify: `web/pyramid-gallery/pyramid-gallery.js:69-122`
- Modify: `web/pyramid-gallery/pyramid-gallery.html:65`
- Modify: `packages/pyramid-ingest/src/ingest.ts:236-260,936-975`
- Modify: `packages/pyramid-ingest/src/manifest.ts:70-80`
- Delete after redirect test passes: `web/pyramid-gallery.js`
- Replace with redirect or remove after link migration: `web/pyramid-gallery.html`
- Test: `web/pyramid-gallery/pyramid-gallery.test.js`

**Interfaces:**
- Consumes shared schema and canonical runtime.
- Produces placeholder, grouping, next-page, metadata, and pagination behavior from existing fields.

- [ ] Add tests for thumbhash placeholder before bytes arrive, group ordering, next-page fetch, absent optional metadata, and deep-link redirect.
- [ ] Implement existing-field consumption without adding another manifest dialect.
- [ ] Search all HTML/docs/tests for legacy URLs and migrate them.
- [ ] Delete legacy implementation only after canonical parity and redirect tests pass.
- [ ] Run both old/new URL smoke tests, gallery tests, and root web tests.
- [ ] Commit as `feat(gallery): activate manifest features and retire legacy UI`.

### Task 8: Delivery Performance And Long-Session Gate

**Findings:** 2, 26, 33, 42, 49, 70, 71, 74, 76-82  
**Model/Effort:** Opus / M

**Files:**
- Create: `.flipflop/dom-tests/pyramid-delivery.mjs`
- Create: `.flipflop/tests/pyramid-carriers.mjs`
- Create: `docs/outputs/pyramid/2026-07-11-delivery-verification.md`

- [ ] Freeze baseline and candidate builds from recorded commits.
- [ ] Exercise non-COI and COI pages, mixed whole/JXTC levels, RGB8/RGB16, cold/warm cache, rapid pan/zoom/navigation, and 500+ asset scroll.
- [ ] Run `flipflopdom` for bytes-to-first-paint, TTFP, final paint, frame time, decode count, and stale paints.
- [ ] Run `flipflopMem` for JS heap, RSS, worker store bytes, WASM pages, and long-session slope.
- [ ] Require output equality/quality, `trust:high`, thermal stability, and predeclared thresholds from the master.
- [ ] Record TOON timestamps, fixture hashes, browser isolation mode, and accepted/rejected claims.
- [ ] Hand pushed branches to integrator; do not merge them.
