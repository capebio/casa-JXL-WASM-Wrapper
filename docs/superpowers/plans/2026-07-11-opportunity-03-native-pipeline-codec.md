# Native Pipeline And Codec ABI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose latent libjxl capabilities, make stream APIs genuinely incremental, remove avoidable RAW/developed-image materialization, and preserve metadata/colour truth across native, WASM, and browser boundaries.

**Architecture:** A role-aware facade selects the smallest correct JXL artifact and presents one typed capability surface. Stateful native/WASM sessions own input and pixels until explicitly released. RAW exporters operate row/band-wise, while metadata and colour policy are resolved once and reused by preview and final paths.

**Tech Stack:** Rust, wasm-bindgen, C++, Emscripten/libjxl, N-API, TypeScript, Web Workers, SIMD128.

## Global Constraints

- Master program: `docs/superpowers/plans/2026-07-11-codebase-opportunity-roadmap.md`.
- Findings owned here: 4-7, 17-22, 31, 34, 35, 50-58.
- Lead model: Opus. Program effort: XL.
- Lead worktree: `C:\Foo\rcw-native-pipeline-codec-opus-20260711`.
- Lead branch: `feat/native-pipeline-codec-opus-20260711`.
- Delegated worktree: `C:\Foo\rcw-native-<task-slug>-<agent-id>`.
- Delegated branch: `feat/native-<task-slug>-<agent-id>`.
- Start ABI/schema commits from integrated packet 1 contracts.
- Keep the Opus lead for adjacent ABI, ownership, and colour tasks. Haiku may only register deterministic tests or regenerate verified artifacts in a separate worktree.
- Any `bridge.cpp` edit requires protected progressive tests before and after.
- Output-changing colour work requires fixtures/reference comparison, not only unit tests.
- Every speed or memory claim follows the master flipflop gate.

---

## Finding Evidence

| Find | Evidence | Opportunity |
|---:|---|---|
| 4 | `src/lib.rs:36-125`; `crates/raw-pipeline/src/stream_band.rs:389-432`; `packages/jxl-wasm/src/stream-fusion.ts:1-85`; `packages/jxl-wasm/src/bridge.cpp:765-979,2752-2763`; `web/worker.js:642-660` | Productize existing RAW-to-JXL band fusion in a dedicated worker |
| 5 | `packages/jxl-wasm/src/bridge.cpp:982-1135`; `src/facade.ts:404-505,767-784` | Bind gain-map encode/decode |
| 6 | `packages/jxl-wasm/src/bridge.cpp:2059-2220`; `src/facade.ts:2266-2274` | Bind animation frames, timing, loop, names, blend |
| 7 | `packages/jxl-wasm/src/bridge.cpp:2923-2984,3446-3519`; `src/facade.ts:767-784,2450-2451` | Use streaming metadata setter rather than buffered fallback |
| 17 | `packages/jxl-wasm/src/facade.ts:692-711,1417-1420,2690-2725`; `scripts/build.mjs:57-60` | Cache/load JXL WASM by encoder/decoder role and tier |
| 18 | `packages/jxl-wasm/src/facade.ts:220-352,723-760,2292,2651-2681`; `src/bridge.cpp:1140-1319,2841-2919` | Wire extra channels and descriptors end to end |
| 19 | `packages/jxl-wasm/src/facade.ts:723-760,2651-2681`; `src/bridge.cpp:313-320,2841-2919,3340-3445` | Replace silent/no-op advanced controls with a generic frame-setting ABI |
| 20 | `packages/jxl-native/src/native.cc:917-923,944-1330,1583-1708,1747-1882`; `src/index.ts:137-141,241-253` | Process pushes incrementally; emit events/chunks before close with backpressure |
| 21 | `crates/raw-pipeline/src/demosaic.rs:373-375,1179-1440,2540-2570`; `src/lib.rs:305-390`; `tools/demtone-st.mjs` | SIMD128 MHC interior kernel with exact scalar borders/tails |
| 22 | `packages/jxl-wasm/src/bridge.cpp:3446-3519,3557-3685`; `src/facade.ts:404-505,2450-2451` | Expose JPEG transcode v2, metadata boxes, and JUMBF preservation |
| 31 | `packages/jxl-worker-browser/src/decoder-pool.ts:33-160`; `src/decode-handler.ts:247-260,339-348`; `src/worker.ts:107-108,408-415` | Remove dead one-shot DecoderPool or add real reset/release ABI |
| 34 | `src/lib.rs:3447-3662`; `web/worker.js:642-660`; ORF retained-state model at `src/lib.rs:1186-1210,1447-1528` | Retain DNG mosaic/parameters and defer final development |
| 35 | `crates/raw-pipeline/src/stream_band.rs:389-432`; `src/lib.rs:36-125`; `web/worker.js:642-660` | Route CR2 through RawStreamExporter streaming core |
| 50 | `crates/raw-pipeline/src/dng.rs:187-226,875-916`; `src/lib.rs:3447-3557` | Preserve DNG datetime/GPS already parsed |
| 51 | `crates/raw-pipeline/src/dng.rs:187-226`; `src/cr2.rs:357-374`; `src/lib.rs:3776-3900,4017-4033` | Preserve real camera-WB provenance |
| 52 | `crates/raw-pipeline/src/cr2.rs:357-374,1429`; `src/lib.rs:4293-4304`; `web/worker.js:737-752` | Resolve one CR2 matrix for preview and final tone |
| 53 | `crates/raw-pipeline/src/dng.rs:257-275,337-410,683-803` | Stream compression-1 DNG rows/tiles without full mosaic |
| 54 | `crates/raw-pipeline/src/cr2.rs:437-456,1460-1468,1790-1822` | Gather CFA phase information during row mapping, not via a full cropped mosaic |
| 55 | `src/lib.rs:36-125`; `crates/raw-pipeline/src/stream_band.rs:389-432` | Let RawStreamExporter own/borrow input without a second full RAW copy |
| 56 | `crates/raw-pipeline/src/dng.rs:69-72,939-952,1018-1125,1444-1455` | Resolve dual-illuminant DNG calibration |
| 57 | `crates/raw-pipeline/src/dng.rs:122-158`; `crates/raw-pipeline/src/pipeline.rs`; `src/lib.rs:3447-3662` | Parse linear/uncompressed RGB DNG and bypass CFA/demosaic |
| 58 | `crates/raw-pipeline/src/image_formats.rs:8-45,61-93`; `src/lib.rs:5356-5442`; `web/worker.js:299-335,396-446` | Keep TIFF/EXR/JPEG pixels resident instead of WASM-JS-WASM round trip |

## Target Interfaces

Task 1 locks naming. Later tasks consume it.

```ts
export type JxlRole = "decode" | "encode" | "perceptual";
export type JxlTier = "scalar-st" | "simd-st" | "scalar-mt" | "simd-mt";

export function loadJxlModule(request: {
  role: JxlRole;
  tier?: JxlTier;
  signal?: AbortSignal;
}): Promise<JxlModule>;

export interface NativeStream<TEvent, TChunk> {
  push(bytes: Uint8Array): Promise<void>;
  events(): AsyncIterable<TEvent>;
  chunks(): AsyncIterable<TChunk>;
  finish(): Promise<void>;
  cancel(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}
```

```rust
pub trait RawBandSource {
    fn dimensions(&self) -> (u32, u32);
    fn next_band(&mut self, max_rows: u32) -> Result<Option<RgbBand>, RawError>;
}

pub struct DecodedImageHandle {
    // Owns decoded pixels and typed metadata until consumed or freed.
}
```

Generic advanced controls are typed at the facade and validated by the bridge. An unknown/unsupported setting returns a deterministic error; it is never silently ignored.

## Task Order

```text
1 role-aware loader and decoder lifetime
2 generic settings + extra channels
3 gain map, animation, metadata, JPEG/JUMBF
4 genuinely live native streams
5 RAW band fusion + CR2 + input ownership
6 remove DNG/CR2 hidden mosaic work
7 metadata and colour truth
8 DNG deferred finish
9 dual-illuminant + linear DNG
10 resident developed-image pipeline
11 SIMD128 MHC
12 cross-tier integration and performance gate
```

### Task 1: Role-Aware Loading And Decoder Lifetime

**Findings:** 17, 31  
**Model/Effort:** Opus / M

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts:692-711,1417-1420,2690-2725`
- Modify: `packages/jxl-wasm/scripts/build.mjs:57-60`
- Modify: `packages/jxl-worker-browser/src/decoder-pool.ts:33-160`
- Modify: `packages/jxl-worker-browser/src/decode-handler.ts:247-260,339-348`
- Modify: `packages/jxl-worker-browser/src/worker.ts:107-108,408-415`
- Create: `packages/jxl-wasm/test/role-loader.test.ts`

**Interfaces:**
- Produces `loadJxlModule({role,tier,signal})` and explicit decoder lifecycle.
- Preferred decision: remove the unused DecoderPool unless a tested reset ABI is demonstrably cheaper.

- [ ] Add fetch/import spies proving decode does not load encoder assets and encode does not load decoder assets.
- [ ] Add fallback tests for SIMD/MT capability combinations and simultaneous callers sharing one module promise.
- [ ] Add worker lifecycle assertions proving no unused pool allocation survives decode/dispose.
- [ ] Run tests; expected initial failures: role-agnostic module selection and constructed-but-unreleased pool.
- [ ] Cache by `{role,tier}` and make preload role-aware.
- [ ] Remove DecoderPool and its dead ownership if no reset ABI exists; otherwise implement/reset-test it before reuse.
- [ ] Run jxl-wasm and jxl-worker-browser build/typecheck/test.
- [ ] Use `flipflopdom` for cold decode/encode startup, bytes transferred, compile time, and first operation.
- [ ] Commit as `perf(jxl): load role-specific modules` only if measured; otherwise `refactor`.

### Task 2: Make Advanced Settings And Extra Channels Real

**Findings:** 18, 19  
**Model/Effort:** Opus / L

**Files:**
- Modify: `packages/jxl-wasm/src/facade.ts:220-352,723-760,2292,2651-2681`
- Modify: `packages/jxl-wasm/src/bridge.cpp:313-320,1140-1319,2841-2919,3340-3445`
- Create: `packages/jxl-wasm/test/advanced-settings.contract.test.ts`
- Create: `packages/jxl-wasm/test/extra-channels.roundtrip.test.ts`

**Interfaces:**
- Consumes role-aware module.
- Produces one validated generic frame-setting call and typed extra-channel descriptors/pixel planes.

- [ ] Run protected progressive tests before the bridge edit.
- [ ] Write tests for known setting changing the encoded configuration, unsupported ID rejection, and streaming/buffered parity.
- [ ] Write depth, spot-colour, alpha, and spectral plane round trips including descriptor metadata.
- [ ] Run tests; expected initial failures: no-op settings and unpatched extra-channel descriptors.
- [ ] Allocate descriptors/planes with checked byte math, call existing `_ec` bridge, and free on every error/cancel path.
- [ ] Implement one bridge setting function backed by libjxl validation. Do not mirror a growing switch in JS.
- [ ] Run protected progressive tests after the bridge edit and all targeted tests.
- [ ] Commit as `feat(jxl): expose settings and extra channels`.

### Task 3: Bind Container-Rich Codec Features

**Findings:** 5, 6, 7, 22  
**Model/Effort:** Opus / XL

**Files:**
- Modify: `packages/jxl-wasm/src/bridge.cpp:982-1135,2059-2220,2923-2984,3446-3519,3557-3685`
- Modify: `packages/jxl-wasm/src/facade.ts:404-505,767-784,2266-2274,2450-2451`
- Modify: `packages/jxl-core/src/types.ts`
- Create: `packages/jxl-wasm/test/gain-map.roundtrip.test.ts`
- Create: `packages/jxl-wasm/test/animation.roundtrip.test.ts`
- Create: `packages/jxl-wasm/test/container-metadata.roundtrip.test.ts`
- Create: `packages/jxl-wasm/test/jpeg-transcode-v2.test.ts`

**Interfaces:**
- Consumes Task 2 setting/channel contract.
- Produces typed gain-map, animation, streaming metadata, and JPEG reconstruction/JUMBF options.

- [ ] Run protected progressive tests before bridge edits.
- [ ] Add gain-map base/alternate colour encoding and reconstruction tests.
- [ ] Add multi-frame duration, ticks, loop, name, crop, and blend round trips.
- [ ] Assert streaming metadata output matches buffered metadata and peak retained bytes are bounded.
- [ ] Assert JPEG reconstruction remains bit-exact while EXIF/XMP/custom/JUMBF boxes survive according to policy.
- [ ] Implement the minimal typed facade and bridge wiring; share metadata validation/ownership between buffered and streaming paths.
- [ ] Run protected progressive tests and all new/existing container tests.
- [ ] Run `flipflopMem` for streaming vs buffered metadata and multi-frame encode.
- [ ] Commit each independently reviewable capability separately while retaining one Opus lead/worktree.

### Task 4: Make Native Stream APIs Genuinely Incremental

**Finding:** 20  
**Model/Effort:** Opus / XL

**Files:**
- Modify: `packages/jxl-native/src/native.cc:917-923,944-1330,1583-1708,1747-1882`
- Modify: `packages/jxl-native/src/index.ts:137-141,241-253`
- Create: `packages/jxl-native/test/live-stream.test.ts`

**Interfaces:**
- Produces `NativeStream` contract above with bounded queues/backpressure.
- First progress event or output chunk must be observable before `finish()` when libjxl can produce it.

- [ ] Write tests that push several chunks, pause consumption, cancel mid-frame, truncate input, and dispose with pending N-API references.
- [ ] Assert at least one event/chunk precedes finish and retained memory is bounded by chunk budget plus active frame.
- [ ] Run tests; expected initial result: no processing/output until close.
- [ ] Move libjxl processing into push/worker execution. Use bounded async event/chunk queues and stop accepting pushes under backpressure.
- [ ] Release N-API references promptly on finish, cancel, error, and dispose.
- [ ] Run all jxl-native tests plus sanitizer/leak checks available in the package.
- [ ] Compare batch vs streaming latency and memory with flipflop/flipflopMem; require output equality.
- [ ] Commit as `feat(jxl-native): process streams incrementally`.

### Task 5: Productize RAW-To-JXL Band Fusion

**Findings:** 4, 35, 55  
**Model/Effort:** Opus / L

**Files:**
- Modify: `src/lib.rs:36-125`
- Modify: `crates/raw-pipeline/src/stream_band.rs:389-432`
- Modify: `packages/jxl-wasm/src/stream-fusion.ts:1-85`
- Modify: `packages/jxl-wasm/src/bridge.cpp:765-979,2752-2763`
- Modify: `web/worker.js:642-660`
- Create: `web/raw-jxl-fusion-worker.js`
- Create: `web/raw-jxl-fusion.test.js`

**Interfaces:**
- Produces `RawBandSource` implementations for ORF, DNG, and CR2.
- Dedicated worker owns RAW WASM, JXL WASM, input, band buffers, and cancellation.

- [ ] Run protected progressive tests before the bridge edit.
- [ ] Add whole-frame vs band-fused pixel/codestream decode parity for real ORF/DNG/CR2 fixtures.
- [ ] Assert cancellation/error frees both sessions, concurrent jobs do not share mutable encoder state, and input is not duplicated.
- [ ] Run tests; expected initial failures: CR2 exporter omission and product not using existing fusion.
- [ ] Add CR2 `RawBandSource`; change exporter input ownership to owned handle or borrowed immutable view.
- [ ] Wire a dedicated worker that calls existing `streamEncodeRgb8` and transfers only bounded bands/output chunks.
- [ ] Run protected progressive and fusion tests.
- [ ] Prove peak JS heap/WASM pages, bytes copied, first-output time, and total latency with flipflop/flipflopMem.
- [ ] Commit as `feat(raw): fuse streaming decode and JXL encode` only with parity and memory proof.

### Task 6: Remove Hidden Full-Mosaic Work

**Findings:** 53, 54  
**Model/Effort:** Opus / L

**Files:**
- Modify: `crates/raw-pipeline/src/dng.rs:257-275,337-410,683-803`
- Modify: `crates/raw-pipeline/src/cr2.rs:437-456,1460-1468,1790-1822`
- Create: `crates/raw-pipeline/tests/stream_rows.rs`

**Interfaces:**
- Consumes `RawBandSource`.
- Produces DNG row/tile cursor and CR2 phase accumulator without full auxiliary mosaics.

- [ ] Add bit-exact full-vs-row tests across DNG strips/tiles, compression 1, endian cases, crop edges, and malformed truncation.
- [ ] Add all four CFA phases and CR2 slice-layout cases.
- [ ] Run targeted tests; expected initial result: full mosaic allocation remains observable.
- [ ] Decode/copy only requested DNG rows and gather CR2 phase statistics during existing row mapping.
- [ ] Run raw-pipeline release tests and parity corpus.
- [ ] Run flipflopMem and flipflop on real files; require output equality and a lower peak allocation target.
- [ ] Commit DNG and CR2 changes separately.

### Task 7: Preserve Metadata And Colour Truth

**Findings:** 50, 51, 52  
**Model/Effort:** Opus / M

**Files:**
- Modify: `crates/raw-pipeline/src/dng.rs:187-226,875-916`
- Modify: `crates/raw-pipeline/src/cr2.rs:357-374,1429`
- Modify: `src/lib.rs:3447-3557,3776-3900,4017-4033,4293-4304`
- Modify: `web/worker.js:737-752`
- Create: `crates/raw-pipeline/tests/raw_metadata_colour.rs`

**Interfaces:**
- Produces one metadata carrier containing datetime, GPS, WB values, `wb_from_camera`, and resolved colour-matrix provenance.
- Preview and final consume the same resolved matrix/policy.

- [ ] Add metadata-only/full DNG equality, missing-WB false provenance, and real camera-WB fixtures.
- [ ] Add CR2 preview/final matrix parity and compare selected files with embedded JPEG/approved reference output.
- [ ] Run tests; expected initial failures: dropped fields, hardcoded provenance, and different preview/final matrices.
- [ ] Thread metadata without re-parsing or substituting default provenance.
- [ ] Resolve colour policy once and carry the typed result into both preview and final tone.
- [ ] Run parity corpus and browser worker metadata tests.
- [ ] Record intentional colour changes for owner approval; do not hide them as refactors.
- [ ] Commit as `fix(raw): preserve metadata and colour provenance`.

### Task 8: Add Deferred DNG Finish

**Finding:** 34  
**Model/Effort:** Opus / L

**Files:**
- Modify: `src/lib.rs:3447-3662`
- Modify: `web/worker.js:642-660`
- Test: `web/two-phase-raw.test.js`
- Create: `crates/raw-pipeline/tests/dng_deferred_finish.rs`

**Interfaces:**
- Consumes Task 7 metadata/colour carrier.
- Produces retained DNG raw state whose finalization does not re-decode the container.

- [ ] Add monolithic vs two-phase preview/final byte parity and decode-count assertions.
- [ ] Run tests; expected initial failure: DNG preview path drops state and repeats full work.
- [ ] Generalize the proven ORF retained-state model to DNG with explicit ownership/free.
- [ ] Define one preview algorithm used by monolithic and split entry points.
- [ ] Run raw-pipeline and two-phase browser tests.
- [ ] Use flipflop/flipflopMem for first-preview, final latency, decode count, and retained bytes.
- [ ] Commit as `feat(dng): retain state for deferred final development`.

### Task 9: Support Dual-Illuminant And Linear RGB DNG

**Findings:** 56, 57  
**Model/Effort:** Opus / XL

**Files:**
- Modify: `crates/raw-pipeline/src/dng.rs:69-72,122-158,939-952,1018-1125,1444-1455`
- Modify: `crates/raw-pipeline/src/pipeline.rs`
- Modify: `src/lib.rs:3447-3662`
- Create: `crates/raw-pipeline/tests/dng_colour_modes.rs`

**Interfaces:**
- Consumes Task 7 typed colour policy.
- Produces explicit DNG pixel layout (`cfa`, `linear-rgb-chunky`, `linear-rgb-planar`) and calibration selection/interpolation.

- [ ] Add dual-illuminant endpoint/midpoint fixtures and require single-matrix files remain unchanged.
- [ ] Add chunky/planar, 8/16-bit, endian, strip/tile, and malformed linear-RGB fixtures.
- [ ] Run tests; expected initial failures: unconditional matrix2 and CFA-only rejection.
- [ ] Parse calibration illuminants/matrices and implement DNG-spec interpolation with explicit fallback/provenance.
- [ ] Bypass CFA alignment/demosaic for linear RGB while retaining black/white/colour/tone contracts.
- [ ] Compare reference renders and quantify colour error; obtain owner approval for intentional changes.
- [ ] Run raw-pipeline release/parity suites.
- [ ] Commit dual-illuminant and linear-RGB support separately.

### Task 10: Keep Developed Images Resident

**Finding:** 58  
**Model/Effort:** Opus / XL

**Files:**
- Modify: `crates/raw-pipeline/src/image_formats.rs:8-93`
- Modify: `src/lib.rs:5356-5442`
- Modify: `web/worker.js:299-335,396-446`
- Create: `crates/raw-pipeline/tests/resident_image_pipeline.rs`
- Create: `web/resident-image-pipeline.test.js`

**Interfaces:**
- Consumes packet 1 `DecodeLimits`.
- Produces `DecodedImageHandle` operations for resize, tone/render, and JXL encode without exporting/reimporting full pixels.

- [ ] Add resident vs old-path byte parity for JPEG, TIFF 8/16-bit, and EXR float fixtures.
- [ ] Assert limit rejection precedes allocation and handles boundary byte counts.
- [ ] Run tests; expected initial evidence: full pixels cross WASM-JS-WASM.
- [ ] Store typed pixels in a handle and add consuming/borrowing operations with explicit free.
- [ ] Keep a compatibility `take_*` escape hatch; do not make it the product path.
- [ ] Run raw-pipeline and browser tests.
- [ ] Measure boundary bytes, peak memory, and end-to-end latency with flipflop/flipflopMem.
- [ ] Commit as `perf(raw): keep developed images resident` only if measurement gate passes.

### Task 11: Implement SIMD128 MHC Behind Dispatch

**Finding:** 21  
**Model/Effort:** Opus / L

**Files:**
- Modify: `crates/raw-pipeline/src/demosaic.rs:373-375,1179-1440,2540-2570`
- Modify: `src/lib.rs:305-390`
- Create: `crates/raw-pipeline/tests/mhc_simd128.rs`
- Create: `.flipflop/tests/mhc-simd128.mjs`

**Interfaces:**
- Produces runtime/build dispatch between scalar and SIMD128; borders/tails stay scalar.

- [ ] Add randomized bit-exact tests for every CFA phase, width/alignment/tail, signed intermediate, clamp boundary, and small image.
- [ ] Run tests; expected initial result: SIMD128 implementation absent.
- [ ] Vectorize only the phased interior row kernel while preserving exact scalar operation order.
- [ ] Run native/wasm parity and real RAW corpus hashes.
- [ ] Run interleaved scalar/SIMD flipflop in browser and Node WASM. Predeclare at least 15% median improvement on representative frames and no small-image regression.
- [ ] Reject or keep experimental behind a flag if the gate fails.
- [ ] Commit as `perf(raw): vectorize MHC for wasm SIMD128` only on accepted proof.

### Task 12: Cross-Tier Integration Gate

**Findings:** 4-7, 17-22, 31, 34, 35, 50-58  
**Model/Effort:** Opus / M

**Files:**
- Create: `docs/outputs/native-pipeline/2026-07-11-native-codec-verification.md`
- Extend targeted package tests created above

- [ ] Run protected progressive tests.
- [ ] Run raw-pipeline release/parity tests and targeted JXL WASM/native/worker suites.
- [ ] Verify scalar-ST, SIMD-ST, scalar-MT, and SIMD-MT where supported; ensure role fallback is deterministic.
- [ ] Run flipflop/flipflopMem records for every claimed native/WASM performance or memory improvement.
- [ ] Record fixture hashes, artifact manifests, output equality/quality, TOON timestamps, and rejected claims.
- [ ] Push the named branch and hand it to the integrator. Do not merge it.
