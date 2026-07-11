# Web Product Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn existing browser capabilities into coherent, bounded user workflows: scheduled ingest, per-asset edits, efficient preview/render, full-resolution export, metadata, HDR, timelapse, and AI-ID.

**Architecture:** `jxl-session`/`jxl-scheduler` own work admission and cancellation. Stable asset IDs key per-card state and the existing AssetStore. Product services expose explicit Develop, Export, Timelapse, and AI-ID commands. Optional modules load on first use; render/decode resources have generation and lifetime ownership.

**Tech Stack:** JavaScript, TypeScript packages, Web Workers, WebGL, OPFS/IndexedDB, JXL/RAW WASM, browser File APIs.

## Global Constraints

- Master program: `docs/superpowers/plans/2026-07-11-codebase-opportunity-roadmap.md`.
- Findings owned here: 3, 9-16, 29, 30, 39-41, 43-48.
- Lead model: Sonnet. Program effort: XL.
- Lead worktree: `C:\Foo\rcw-web-product-workflows-sonnet-20260711`.
- Lead branch: `feat/web-product-workflows-sonnet-20260711`.
- Delegated worktree: `C:\Foo\rcw-web-<task-slug>-<agent-id>`.
- Delegated branch: `feat/web-<task-slug>-<agent-id>`.
- Keep the Sonnet lead for adjacent product work. Delegate only isolated tests, labels, or import registration to Haiku.
- Consume packet 1 identity/schema/security and packet 2 delivery/runtime contracts; do not create browser-only substitutes.
- No performance claim without `flipflopdom`; memory claims also use `flipflopMem`.
- Preserve output colour/orientation/metadata; changed output requires explicit golden/reference approval.

---

## Finding Evidence

| Find | Evidence | Opportunity |
|---:|---|---|
| 3 | `web/main.js:663-979,5798-5814`; `web/jxl-browser-context.js:6-40`; `packages/jxl-session/src/browser.ts:39`; `src/context-base.ts:111-139,213-237`; `packages/jxl-scheduler/src/pool.ts:35-132`; `src/scheduler.ts:150-215` | Replace main's private JXL queue with tested session/scheduler ownership |
| 9 | `web/main.js:65-85,749-768`; `web/worker.js:195-204`; `web/calibration/calibrate.mjs:13-19,32-62` | Send calibrated thread limits into actual worker/session requests |
| 10 | `web/main.js:504-520,1925-2018,2178` | Expose proxy mode and Develop Selected |
| 11 | `web/worker.js:171-174,755-762`; `web/main.js:1014-1023,1246-1270,2076-2085,3248-3256` | Bound card/worker retained state and implement deletion/LRU |
| 12 | `web/lightbox/webgl-pipeline.js:80-88,127-159,161-198,246-249`; `web/tauri-parity-lightbox.js:266-280,318-324`; `web/lightbox/pyramid-lightbox.js:541` | Cache/reuse renderer, framebuffer, texture, and source resources |
| 13 | `web/index.html:531-537`; `web/main.js:2029-2036,3410-3417,3611-3618`; `web/worker.js:670-688,778-786` | Wire Export Selected to one full-resolution ExportService |
| 14 | `web/format-detect.js:15-21`; `web/worker.js:590-605`; `web/main.js:2228-2231,3982-4008`; `web/index.html:100-103` | Align picker/drag-drop formats with existing detector/routes |
| 15 | `web/timelapse-core.js:173-215`; `web/timelapse.js:289-298,352-405`; `web/timelapse.html:82-88`; `web/index.html:47-60` | Integrate timelapse using selected assets, sequential reads, cancellation, and budget |
| 16 | `web/ai-id/README.md:16-19`; `web/ai-id/proxy.mjs:1-12,24-49`; `sources.mjs:1-4`; `sidecar.mjs:15-25`; `manifest.mjs:5-13` | Split pure/browser/Node AI-ID adapters and wire asset cards |
| 29 | `packages/jxl-cache/src/browser.ts:73-173,284-375`; `web/pyramid-gallery/image-store.js:104-130` | Persist derived assets through the main product cache |
| 30 | `packages/jxl-wasm/src/facade.ts:1574-1593`; `web/lightbox/pyramid-lightbox.js:337-561,802-882`; `web/lightbox/webgl-pipeline.js:82-369`; `web/main.js:1541-1635,2718-2754` | Route standard JXL RGBA16/float through the existing HDR renderer |
| 39 | `web/main.js:797-830,1925-1928,2019-2039,2211-2219` | Reserve admission before full file reads |
| 40 | `web/main.js:3192-3205,3534-3567`; `web/panels.js:258-295,329-395` | Own edit/sidecar state per card and navigation generation |
| 41 | `web/crop.js:261-310,577-585,652-661`; `web/panels.js:355-364` | Make crop mode transactional and persist straighten fields |
| 43 | `web/main.js:2146-2155,2418-2475`; `web/jxl-decode-worker.js:75-85,154-160`; `packages/jxl-core/src/types.ts:210-217` | Decode thumbnail-sized output instead of a full master for grid |
| 44 | `web/main.js:1043-1062`; `packages/jxl-core/src/types.ts:152-160`; `packages/jxl-session/src/encode-session.ts:43-50`; `web/worker.js:735-752` | Carry ICC/EXIF/XMP with a keep/strip-GPS privacy policy |
| 45 | `web/main.js:3025-3045`; `web/worker.js:405-410` | Show actual format and bit depth |
| 46 | `web/panels.js:253-306`; `web/main.js:1272-1297,1911-1915,2024,2387-2397` | Stop basename collisions and surface persistence errors |
| 47 | `web/main.js:9-34,4375-5590,5688-5705` | Lazy-load dormant WASM/HDR/lens and benchmark modules |
| 48 | `web/main.js:2092-2109,2418-2475,3083-3100`; `web/jxl-decode-worker.js:235-258` | Cancel/generation-guard old decode after reprocess |

## Target Product Contracts

```ts
export interface AssetState {
  assetId: string;
  sourceGeneration: number;
  edit: EditState;
  status: "queued" | "preview" | "developed" | "error";
}

export interface EditState {
  crop: CropState | null;
  subjects: SubjectState[];
  look: LookState;
  revision: number;
}

export interface ExportRequest {
  assetIds: string[];
  output: "jxl" | "jpeg" | "png" | "tiff";
  metadata: "keep" | "strip-gps" | "strip-all";
  resolution: "full";
}
```

Every async result carries `assetId`, `sourceGeneration`, and operation ID. The receiver rejects mismatches before cache, card, canvas, or persistence mutation.

## Task Order

```text
1 session scheduler + calibrated admission + bounded reads
2 per-asset identity/edit/crop/generation state         after packet 1 identity
3 memory, derived cache, renderer, thumbnail path       after 1-2 and packet 2 runtime
4 full-resolution export + metadata + format truth      after 2-3
5 proxy/develop + multi-format intake                    after 1-2
6 timelapse + AI-ID workflows                            after 4-5
7 HDR product path                                       after packet 3 decode ABI + packet 2 display
8 startup split                                           after module boundaries settle
9 browser integration/performance gate                   last
```

### Task 1: Adopt JXL Sessions And Admit Bytes Before Reading

**Findings:** 3, 9, 39  
**Model/Effort:** Sonnet / XL

**Files:**
- Modify: `web/main.js:65-85,663-979,1925-2039,2211-2219,5798-5814`
- Modify: `web/jxl-browser-context.js:6-40`
- Modify: `web/worker.js:195-204`
- Modify: `web/calibration/calibrate.mjs:13-19,32-62`
- Modify only if contract gaps exist: `packages/jxl-session/src/context-base.ts:111-139,213-237`
- Modify only if contract gaps exist: `packages/jxl-scheduler/src/pool.ts:35-132`
- Create: `web/main-runtime-scheduler.test.js`

**Interfaces:**
- Consumes existing jxl-session/scheduler APIs.
- Produces one browser context/scheduler and a byte-weighted file-read admission lane.

- [ ] Add priority, cancellation, crash recovery, shutdown, calibration propagation, pending-byte cap, and visible-card priority tests.
- [ ] Assert no full `arrayBuffer()` starts before admission and queued tasks do not retain complete file bytes.
- [ ] Run scheduler/session/calibration/worker tests; expected initial failures: private queue and pre-admission reads.
- [ ] Replace `_jxl*` queue/state with the shared browser context and scheduler.
- [ ] Translate calibration output into session worker/thread limits once; pass it with requests.
- [ ] Add bounded read/preview lanes with AbortSignal and byte accounting.
- [ ] Run targeted and root web tests.
- [ ] Compare frozen old/new batch throughput, queue wait, first preview, and peak memory using flipflopdom/flipflopMem.
- [ ] Commit as `refactor(web): use shared JXL scheduler` unless performance proof supports `perf`.

### Task 2: Own Edit, Crop, Persistence, And Generations Per Asset

**Findings:** 40, 41, 46, 48  
**Model/Effort:** Sonnet / L

**Files:**
- Create: `web/asset-state-store.js`
- Create: `web/asset-state-store.test.js`
- Modify: `web/main.js:1272-1297,1911-1915,2024,2092-2109,2387-2475,3083-3100,3192-3205,3534-3567`
- Modify: `web/panels.js:253-306,329-395`
- Modify: `web/crop.js:261-310,577-585,652-661`
- Modify: `web/jxl-decode-worker.js:235-258`

**Interfaces:**
- Consumes packet 1 stable asset identity.
- Produces `AssetState`/`EditState` store, explicit serializer target, and generation-tagged operations.

- [ ] Test same basename in different directories, late sidecar A while B is active, batch save of distinct states, failed durable write, crop mode switch, Apply/Cancel, straighten reload, and stale reprocess decode.
- [ ] Run tests; expected initial failures: global state bleed, pre-Apply commit, missing fields, false save-success, stale paint/cache.
- [ ] Move all editable state to stable asset keys. Pass target state explicitly to serializers and persistence calls.
- [ ] Snapshot both crop modes; switch pending-only; Apply atomically; Cancel restores snapshot.
- [ ] Include `angle` and `inOriginalSpace` in one versioned crop normalizer.
- [ ] Increment source generation whenever bytes change; propagate cancellation and reject stale results before every commit.
- [ ] Surface persistence errors and set success state only after durable completion.
- [ ] Run crop/panel/sidecar/worker/browser tests.
- [ ] Commit as `fix(web): isolate asset edits and decode generations`.

### Task 3: Bound Render, Decode, And Derived-Asset Lifetime

**Findings:** 11, 12, 29, 43  
**Model/Effort:** Sonnet / L

**Files:**
- Modify: `web/main.js:1014-1023,1246-1270,2076-2085,2146-2155,2418-2475,3248-3256`
- Modify: `web/worker.js:171-174,755-762`
- Modify: `web/jxl-decode-worker.js:75-85,154-160`
- Modify: `web/lightbox/webgl-pipeline.js:80-88,127-198,246-249`
- Modify: `web/lightbox/pyramid-lightbox.js:541`
- Modify: `packages/jxl-cache/src/browser.ts:73-173,284-375`
- Modify: `packages/asset-store/src/index.js`
- Create: `web/resource-lifetime.test.js`

**Interfaces:**
- Consumes packet 2 runtime/carrier lifetime and packet 1 identity.
- Produces byte-budgeted derived cache, explicit delete/clear, reusable render resources, and thumbnail decode request.

- [ ] Test repeated add/process/reprocess/delete/open/close cycles; assert bounded card bytes, worker bytes, ImageBitmaps, object URLs, textures, framebuffers, and cache entries.
- [ ] Add a 360px thumbnail test asserting requested/decoded pixel dimensions and reference pixels.
- [ ] Run tests; expected initial evidence: full master decode for thumb and unbounded/per-open resources.
- [ ] Make main caches clients of AssetStore with stable keys, byte budgets, LRU, and explicit invalidation on generation change/delete.
- [ ] Reuse one renderer and compatible GPU resources; resize/reallocate only when format/dimensions require it.
- [ ] Request decoder downsample or encoded sidecar-sized source for the grid; do not full-decode solely to canvas-downscale.
- [ ] Run WebGL/lightbox/cache/worker tests.
- [ ] Use flipflopdom plus flipflopMem for scroll, lightbox cycling, rapid reprocess, thumb work, cache hit, GPU count, and long-session slope.
- [ ] Commit as `perf(web): bound render and derived assets` only with accepted proof.

### Task 4: Implement Full-Resolution Export And Metadata Policy

**Findings:** 13, 44, 45  
**Model/Effort:** Sonnet / L

**Files:**
- Create or complete: `web/export-service.js`
- Create: `web/export-service.test.js`
- Modify: `web/index.html:531-537`
- Modify: `web/main.js:1043-1062,2029-2036,3025-3045,3410-3417,3611-3618`
- Modify: `web/worker.js:405-410,670-688,735-752,778-786`
- Modify: `packages/jxl-session/src/encode-session.ts:43-50`

**Interfaces:**
- Consumes per-asset state, resident/full-resolution paths, and metadata-capable encoder.
- Produces `ExportRequest` and progress/result per asset.

- [ ] Add multi-select order, full dimensions, orientation, bit depth, colour profile, EXIF/XMP, keep/strip-GPS/strip-all, filename collision, cancel, and partial-failure tests.
- [ ] Decode exported RAW/JPEG/JXL/TIFF fixtures and assert pixel/metadata round trip.
- [ ] Run tests; expected initial failures: unwired command, preview-resolution path, metadata absent, hardcoded ORF info.
- [ ] Route button and programmatic calls through one ExportService; never export grid/lightbox preview bytes as full resolution.
- [ ] Carry source metadata bytes or valid synthesized blocks with explicit privacy policy.
- [ ] Display actual worker-reported format and bit depth.
- [ ] Run export, orientation, metadata, and multi-format tests.
- [ ] Use flipflop/flipflopMem for real 20-50 MP batch export if throughput/memory claims are made.
- [ ] Commit as `feat(web): add full-resolution export service`.

### Task 5: Expose Proxy/Develop And Align Multi-Format Intake

**Findings:** 10, 14  
**Model/Effort:** Sonnet / M

**Files:**
- Modify: `web/main.js:504-520,1925-2018,2178,2228-2231,3982-4008`
- Modify: `web/index.html:100-103`
- Modify: `web/format-detect.js:15-21`
- Modify: `web/worker.js:590-605`
- Modify: `web/format-detect.test.js`
- Modify: `web/test/format-detect.test.mjs`

**Interfaces:**
- Produces explicit intake mode and Develop Selected command using Task 1 scheduler.

- [ ] Test picker and drag/drop parity for every detector-supported SDR/RAW/JXL format.
- [ ] Test proxy-first to developed transition, selected-only scope, cancellation, failure, and state preservation.
- [ ] Run tests; expected initial result: accepted-detector formats filtered by picker and no exposed command.
- [ ] Derive accept list/routes from the canonical format registry delivered by packet 1.
- [ ] Add mode control and Develop Selected command without duplicating process logic.
- [ ] Run format, round-trip, two-phase, and scheduler tests.
- [ ] Use flipflopdom for time-to-first-proxy and develop latency if claims are made.
- [ ] Commit as `feat(web): expose proxy and selected development`.

### Task 6: Integrate Timelapse And AI-ID

**Findings:** 15, 16  
**Model/Effort:** Sonnet / L

**Files:**
- Modify: `web/timelapse-core.js:173-215`
- Modify: `web/timelapse.js:289-298,352-405`
- Modify: `web/timelapse.html:82-88`
- Modify: `web/index.html:47-60`
- Split: `web/ai-id/proxy.mjs:1-49`
- Split: `web/ai-id/sources.mjs`
- Modify: `web/ai-id/sidecar.mjs:15-25`
- Modify: `web/ai-id/manifest.mjs:5-13`
- Create: `web/ai-id/browser-adapter.js`
- Test: `web/timelapse-core.test.js`
- Test: `web/ai-id/*.test.mjs`

**Interfaces:**
- Consumes stable asset/edit state, scheduler, ExportService, and derived cache.
- Produces selected-asset timelapse workflow and browser-safe AI-ID preparation.

- [ ] Test selected order, sequential read/decode, resolution cap, memory budget, edits, cancellation, export, and partial failure for timelapse.
- [ ] Assert browser AI-ID graph imports no Node built-ins; test live-buffer, pyramid, embedded preview, master, and RAW fallback order.
- [ ] Tie sidecars/manifests to stable asset identity and selected metadata privacy policy.
- [ ] Run existing/new timelapse and all AI-ID tests.
- [ ] Wire product commands using existing core logic rather than copying it into main.
- [ ] Use flipflop/flipflopMem for real-RAW timelapse and proxy preparation if performance claims are made.
- [ ] Commit timelapse and AI-ID as separate milestones in the same lead worktree.

### Task 7: Deliver The Standard HDR JXL Product Path

**Finding:** 30  
**Model/Effort:** Sonnet / XL

**Files:**
- Modify: `web/main.js:1541-1635,2718-2754`
- Modify: `web/lightbox/pyramid-lightbox.js:337-561,802-882`
- Modify: `web/lightbox/webgl-pipeline.js:82-369`
- Modify: `packages/jxl-wasm/src/facade.ts:1574-1593` only if packet 3 has not already exposed the required format
- Create: `web/hdr-jxl-product.test.js`

**Interfaces:**
- Consumes packet 3 RGBA16/float decode and packet 2 canonical lightbox/runtime.
- Produces HDR rendering with WebGL2 preferred and CPU/8-bit fallback.

- [ ] Add 16-bit gradient, highlight headroom, colour matrix, alpha, orientation, WebGL2/WebGL1/no-WebGL, and SDR fallback fixtures.
- [ ] Run tests; expected initial result: product standard JXL path paints RGBA8/Canvas only.
- [ ] Route typed RGBA16/float buffers into the existing reusable renderer; tone-map only at display boundary.
- [ ] Keep CPU fallback colour/tone math aligned with WebGL and report degraded precision explicitly.
- [ ] Run pixel/reference checks in supported browser tiers.
- [ ] Use flipflopdom for first HDR paint, interaction frame time, uploads, allocations, and fallback cost.
- [ ] Commit as `feat(web): render HDR JXL at high precision`.

### Task 8: Split Main Startup Graph

**Finding:** 47  
**Model/Effort:** Sonnet / M

**Files:**
- Modify: `web/main.js:9-34,4375-5590,5688-5705`
- Create focused modules under `web/tools/` or existing feature directories; do not invent a second feature implementation
- Create: `web/main-lazy-imports.test.js`

**Interfaces:**
- Optional feature modules expose one async initializer and are imported once on first use.

- [ ] Snapshot static import graph and test each lazy command initializes once, reports import failure, and preserves state.
- [ ] Run tests; expected initial evidence: benchmarks and optional WASM/HDR/lens code parse on first screen.
- [ ] Move benchmark harness, optional lightboxes/tools, H29/M2 paths, and lens/HDR modules behind dynamic imports at their existing command boundaries.
- [ ] Idle-prefetch only after core interaction readiness and only under resource policy.
- [ ] Run web test/build and all optional feature smoke tests.
- [ ] Use flipflopdom for cold transferred bytes, parse/eval, DOMContentLoaded, first interaction, and first optional-use cost.
- [ ] Commit as `perf(web): lazy-load optional product modules` only when proof passes.

### Task 9: Product Workflow Integration Gate

**Findings:** 3, 9-16, 29, 30, 39-41, 43-48  
**Model/Effort:** Sonnet / M

**Files:**
- Create: `.flipflop/dom-tests/web-product-workflows.mjs`
- Create: `.flipflop/tests/web-product-memory.mjs`
- Create: `docs/outputs/web/2026-07-11-product-workflow-verification.md`

- [ ] Exercise 500+ mixed assets, duplicate basenames, proxy/full transitions, rapid reprocess, lightbox cycling, edits, failed save, full export, timelapse, AI-ID, HDR, delete, and restart/cache reopen.
- [ ] Assert no stale paint/state, no silent persistence success, correct metadata/orientation/format, and bounded queues/resources.
- [ ] Run root web tests plus packet-specific tests.
- [ ] Run flipflopdom/flipflopMem against pinned baseline; require equality/quality, thermal stability, `trust:high`, and predeclared thresholds.
- [ ] Record fixture hashes, browser capabilities, TOON timestamps, and rejected claims.
- [ ] Push the named branch and hand it to the integrator. Do not merge it.
