# Codebase Opportunity Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert findings 1-82 from the 2026-07-11 read-only audit into an ordered, independently executable improvement program without losing evidence, dependencies, or performance proof.

**Architecture:** This file is the program index and assignment ledger. Six companion plans own implementation detail. Each finding has exactly one primary packet; cross-packet dependencies are links, not duplicate work. A packet keeps one lead model loaded for its full context, while cheaper agents receive only isolated mechanical tasks.

**Tech Stack:** Rust, wasm-bindgen, Emscripten/libjxl, TypeScript, JavaScript, Bun, Node, browser workers, WebGL, OPFS/IndexedDB, Git worktrees, repo flipflop tooling.

## Global Constraints

- Follow `AGENTS.md`, `C:\Users\User\.codex\RTK.md`, and `docs/0 Agent implementation rules.md`.
- Every shell command starts with `rtk`.
- Do not modify the primary checkout. Every implementation agent owns a separate named worktree and branch.
- Never remove or deduplicate the opportunistic progressive flush behavior protected by `AGENTS.md`.
- Before and after any edit to `packages/jxl-wasm/src/bridge.cpp`, run the two progressive checkpoint tests named below.
- Do not claim a performance improvement without the applicable flipflop proof described below.
- Preserve unrelated work. The audit baseline had user changes in `StandardMultifileTest.mjs`, `benchmark/hardware-telemetry.mjs`, and `.work/`.
- Generated `dist/` changes require a source change, reproducible build command, and provenance verification.
- One finding has one primary packet. A dependent packet consumes the earlier packet's public contract.

---

## 1. Document Set And Completion Order

| Order | Document | Lead model | Program effort | Starts when |
|---|---|---:|---:|---|
| 0 | This roadmap and ledger | Sonnet | S | Approved |
| 1 | [Contracts and Reliability](2026-07-11-opportunity-01-contracts-reliability.md) | Opus | XL | First |
| 2 | [Pyramid Delivery](2026-07-11-opportunity-02-pyramid-delivery.md) | Opus | XL | Contract fixtures stable |
| 3 | [Native Pipeline and Codec ABI](2026-07-11-opportunity-03-native-pipeline-codec.md) | Opus | XL | May start beside packet 1; ABI/schema land after packet 1 contracts |
| 4 | [Web Product Workflows](2026-07-11-opportunity-04-web-product-workflows.md) | Sonnet | XL | Identity and cancellation contracts stable |
| 5 | [Tooling and Performance](2026-07-11-opportunity-05-tooling-performance.md) | Sonnet | L | Starts immediately; CI expansion precedes risky packets |
| 6 | [Experimental Capabilities](2026-07-11-opportunity-06-experimental-capabilities.md) | Fable | XL | Stable delivery, native ABI, and measurement gates |

Recommended program waves:

```text
Wave 0: packet 5 CI/benchmark/fuzz truth + packet 1 contract fixtures
Wave 1: packet 1 data safety, cancellation, locking, identity
Wave 2: packet 2 canonical delivery engine + packet 3 native streaming/ABI
Wave 3: packet 4 product state, memory, export, metadata, HDR
Wave 4: packet 5 PGO/build/provenance performance closure
Wave 5: packet 6 measured experiments; promote only proven results
```

Packets 2 and 3 may run in parallel after their consumed contracts are pinned. Packet 4 may start isolated UI work earlier, but must not invent replacement identity, cancellation, manifest, or codec contracts.

## 2. Worktree And Branch Topology

The integrator pins one `<base-ref>` before dispatch. Record its full commit SHA in each packet's handoff. Do not silently refresh a worktree to a newer base.

### Integration owner

- Worktree: `C:\Foo\rcw-opportunity-integration-20260711`
- Branch: `integration/codebase-opportunities-20260711`
- Responsibility: serial cherry-picks, cross-packet gates, conflict reconciliation, final verification.

### Packet leads

| Packet | Lead worktree | Lead branch |
|---|---|---|
| 1 | `C:\Foo\rcw-contracts-reliability-opus-20260711` | `feat/contracts-reliability-opus-20260711` |
| 2 | `C:\Foo\rcw-pyramid-delivery-opus-20260711` | `feat/pyramid-delivery-opus-20260711` |
| 3 | `C:\Foo\rcw-native-pipeline-codec-opus-20260711` | `feat/native-pipeline-codec-opus-20260711` |
| 4 | `C:\Foo\rcw-web-product-workflows-sonnet-20260711` | `feat/web-product-workflows-sonnet-20260711` |
| 5 | `C:\Foo\rcw-tooling-performance-sonnet-20260711` | `chore/tooling-performance-sonnet-20260711` |
| 6 | `C:\Foo\rcw-experimental-capabilities-fable-20260711` | `experiment/capabilities-fable-20260711` |

Create a lead worktree from the pinned base:

```powershell
rtk proxy git worktree add "C:\Foo\rcw-contracts-reliability-opus-20260711" -b "feat/contracts-reliability-opus-20260711" "<base-ref>"
```

Any delegated worker gets another worktree and branch. Never share the lead's worktree:

```text
Worktree: C:\Foo\rcw-<packet>-<task-slug>-<quality>-20260711-<agent-id>
Branch:   feat/<packet>-<task-slug>-<quality>-20260711-<agent-id>
```

Use `fix/`, `test/`, `perf/`, or `chore/` instead of `feat/` where that better names the task. Keep `<agent-id>` unique. Push after the first commit and every accepted milestone. Agents hand off branch names; only the integrator lands them.

## 3. Agent Quality Policy

| Model | Use | Do not spend it on |
|---|---|---|
| Haiku | Deterministic test registration, path lists, docs, generated-file checks, small UI labels | Ownership, concurrency, ABI, migrations, performance conclusions |
| Sonnet | Established feature wiring across several files, normal refactors, CI/build work, browser product workflows | Novel codec algorithms or ambiguous cross-language contracts without an approved design |
| Opus | Schemas, migrations, identity, cancellation, locking, ABI, memory ownership, colour correctness, delivery-engine consolidation | Independent mechanical tails after the contract is settled |
| Fable | Novel codec/ML experiments where the solution must be discovered and measured | Production wiring already described by an existing interface |

Packet lead quality is sticky. Once an Opus or Fable lead has loaded a packet's context, keep it for adjacent tasks. Delegate only independent mechanical leaves whose review boundary is explicit. This avoids reloading the same code into several cheaper contexts.

## 4. Effort Policy

| Level | Expected scope |
|---|---|
| S | Under half a day; one local contract or test surface |
| M | One to two days; several files in one module |
| L | Three to five days; cross-module behavior plus tests |
| XL | More than five days or phased research/migration; split into reviewable commits |

Effort is implementation and verification effort, not model quality. An S task may still require Opus when a wrong decision corrupts data.

## 5. Mandatory Performance Proof

Use the appropriate repo vehicle whenever a task promises lower latency, higher throughput, lower memory, faster startup, fewer decodes, or less UI work:

| Claim | Required vehicle |
|---|---|
| Synchronous/async kernel, encode, decode, ingest, scheduler throughput | `flipflop.mjs` |
| RSS, JS heap, WASM pages, retained bytes, long-session growth | `flipflopMem.mjs` |
| Browser paint, interaction, worker/display pipeline, startup | `flipflopdom.mjs` |

Canonical command shapes:

```powershell
rtk proxy node --expose-gc flipflop.mjs .flipflop/tests/<task>.mjs --inputs "<fixture-glob>" --print
rtk proxy node --expose-gc flipflopMem.mjs .flipflop/tests/<task>.mjs --inputs "<fixture-glob>"
rtk proxy node flipflopdom.mjs .flipflop/dom-tests/<task>.mjs --print
```

Every performance task must:

1. Preserve a runnable baseline built from `<base-ref>` and a candidate built from the task branch.
2. Exercise identical inputs and output settings in interleaved, start-rotated A/B rounds.
3. Provide `equal()` for lossless work or `quality()` plus a declared threshold for lossy/output-changing work.
4. Report `median_warm`, first-paint, variance, thermal state, and trust.
5. Reject timing claims with equality mismatch, quality breach, thermal throttling, or `trust:low`.
6. Predeclare the acceptance threshold. Default speed gate: at least 5% geomean `median_warm` improvement with no material fixture regression. Use a stricter product SLO when one exists.
7. For memory work, prove the target metric and absence of positive long-session growth; a faster result does not substitute for the memory gate.
8. Retain the TOON journal record and cite its timestamp in the handoff.

Unit tests and benchmarks serve different purposes. Both are required when behavior changes and performance is claimed.

## 6. Protected Progressive Decode Gate

Before and after any `packages/jxl-wasm/src/bridge.cpp` edit:

```powershell
rtk proxy bun test packages/jxl-wasm/test/progressive-visible-passes.test.ts
rtk proxy bun test web/jxl-single-progressive-page.test.js
```

Keep the `opportunistic_flush_generation != input_generation` guard. Preserve chunk feeding/yields for diagnostic passes and the documented Single Progressive defaults in `AGENTS.md`.

## 7. Finding Assignment Ledger

Priority: `P0` data loss, security, deadlock, incorrect output, or broken core path; `P1` high product/performance leverage; `P2` valuable capability/polish; `R` research until promoted.

| Find | Primary packet | Priority | Model | Effort | Opportunity |
|---:|---:|:---:|:---:|:---:|---|
| 1 | 5 | P1 | Sonnet | M | Replace hardcoded serial workspace runner with discovered dependency-aware execution |
| 2 | 2 | P1 | Opus | L | Use existing progressive manifests/range stack in gallery delivery |
| 3 | 4 | P1 | Sonnet | L | Replace main's private JXL queue with `jxl-session` scheduling |
| 4 | 3 | P1 | Opus | L | Productize unused low-memory RAW-to-JXL band fusion |
| 5 | 3 | P2 | Opus | M | Bind real gain-map encode/decode |
| 6 | 3 | P2 | Opus | L | Bind animation encode/decode |
| 7 | 3 | P1 | Opus | M | Bind streaming metadata setters |
| 8 | 5 | P0 | Sonnet | M | Run workspace and web tests in pull-request CI |
| 9 | 4 | P1 | Sonnet | M | Feed calibrated thread budgets into workers |
| 10 | 4 | P2 | Sonnet | M | Expose proxy mode and Develop Selected |
| 11 | 4 | P1 | Sonnet | L | Bound per-card and worker memory; explicit deletion and LRU |
| 12 | 4 | P1 | Sonnet | M | Reuse WebGL renderer, framebuffer, and source objects |
| 13 | 4 | P1 | Sonnet | L | Wire true full-resolution Export Selected through ExportService |
| 14 | 4 | P1 | Sonnet | S | Align picker formats with the existing SDR detector |
| 15 | 4 | P2 | Sonnet | L | Integrate timelapse using sequential reads and memory limits |
| 16 | 4 | P2 | Sonnet | L | Split AI-ID pure/browser/Node adapters and wire gallery cards |
| 17 | 3 | P1 | Opus | M | Load role-specific JXL WASM artifacts |
| 18 | 3 | P2 | Opus | L | Wire JXL extra channels end to end |
| 19 | 3 | P1 | Opus | M | Replace no-op advanced WASM settings with a generic setter contract |
| 20 | 3 | P1 | Opus | XL | Make native stream APIs truly incremental instead of close-buffered |
| 21 | 3 | P1 | Opus | L | Implement and prove WASM SIMD128 MHC demosaic |
| 22 | 3 | P2 | Opus | L | Expose JPEG transcode v2 and JUMBF |
| 23 | 5 | P0 | Sonnet | M | Verify distribution input digests and provenance |
| 24 | 5 | P0 | Sonnet | L | Replace no-op fuzz targets with parser entry points and corpora |
| 25 | 5 | P1 | Sonnet | L | Apply PGO profiles to the correct artifact tier and prove use |
| 26 | 2 | P1 | Opus | XL | Adopt one LOD/ROI/quality resolver across consumers |
| 27 | 6 | R | Fable | XL | Build measured progressive AI saliency/confidence stopping |
| 28 | 5 | P0 | Sonnet | S | Register benchmark tests in authoritative runners |
| 29 | 4 | P1 | Sonnet | L | Persist derived assets through the main product cache |
| 30 | 4 | P1 | Sonnet | XL | Deliver HDR JXL decode/viewing through 16-bit/float WebGL |
| 31 | 3 | P1 | Opus | M | Remove dead DecoderPool or add a real reset/release ABI |
| 32 | 5 | P0 | Sonnet | M | Build and select a single-thread RAW WASM fallback |
| 33 | 2 | P1 | Opus | L | Replace forced SAB and repeated full-buffer copies with carrier policy |
| 34 | 3 | P1 | Opus | XL | Retain DNG mosaic state and defer final development |
| 35 | 3 | P1 | Opus | L | Route CR2 through the existing streaming RawStreamExporter core |
| 36 | 6 | R | Fable | XL | Close the Fable CASV source-to-dist-to-UI loop |
| 37 | 6 | P1 | Fable | L | Bound decoded CASV frames with a ring and I-frame seek |
| 38 | 6 | P1 | Fable | XL | Add CASV byte-source/range streaming |
| 39 | 4 | P0 | Sonnet | L | Admit file reads through bounded scheduling instead of reading all RAWs |
| 40 | 4 | P0 | Sonnet | L | Own edit/sidecar state per card and guard navigation generations |
| 41 | 4 | P0 | Sonnet | M | Make crop Apply/Cancel transactional and preserve straighten fields |
| 42 | 2 | P0 | Opus | M | Abort or reject stale overlapping pyramid level loads |
| 43 | 4 | P1 | Sonnet | M | Stop full JXL decodes for 360px thumbnails |
| 44 | 4 | P1 | Sonnet | L | Carry ICC/EXIF/XMP with explicit privacy policy |
| 45 | 4 | P2 | Sonnet | S | Display real RAW format and bit depth |
| 46 | 4 | P0 | Sonnet | L | Replace basename identity; surface durable-save failures |
| 47 | 4 | P1 | Sonnet | M | Lazy-load dormant WASM/HDR/lens and benchmark modules |
| 48 | 4 | P0 | Sonnet | M | Cancel/generation-guard stale JXL decode after reprocess |
| 49 | 2 | P0 | Opus | M | Fix shared decode cancellation reference counting |
| 50 | 3 | P0 | Opus | M | Preserve DNG datetime/GPS already parsed by the decoder |
| 51 | 3 | P0 | Opus | M | Preserve DNG/CR2 white-balance provenance |
| 52 | 3 | P0 | Opus | M | Unify CR2 preview/final colour-matrix selection |
| 53 | 3 | P1 | Opus | L | Stream uncompressed DNG rows without full mosaic materialization |
| 54 | 3 | P1 | Opus | L | Avoid a full CR2 cropped mosaic for sparse CFA phase sampling |
| 55 | 3 | P1 | Opus | M | Remove RawStreamExporter full-input duplication |
| 56 | 3 | P1 | Opus | L | Resolve dual-illuminant DNG calibration instead of always matrix2 |
| 57 | 3 | P1 | Opus | L | Accept linear-RGB DNG and bypass demosaic correctly |
| 58 | 3 | P1 | Opus | XL | Keep TIFF/EXR/JPEG decoded pixels resident across pipeline stages |
| 59 | 1 | P0 | Opus | L | Enforce byte-based decode limits before huge developed-image allocation |
| 60 | 1 | P0 | Opus | M | Declare and test one absolute JXTC offset base across languages |
| 61 | 1 | P0 | Opus | L | Stop writing binary under `.json`; make ESM package loading valid |
| 62 | 1 | P0 | Opus | XL | Remove or version the lossy compact manifest/index codec |
| 63 | 1 | P0 | Opus | L | Share tiling descriptors and constants |
| 64 | 1 | P0 | Opus | M | Separate source provenance from supported decode capability |
| 65 | 1 | P0 | Opus | L | Centralize manifest schema ownership and compatibility |
| 66 | 1 | P0 | Opus | XL | Introduce stable source identity and robust freshness fingerprints |
| 67 | 1 | P0 | Opus | L | Propagate deadlines to cancel ingest work, not only the waiter |
| 68 | 1 | P0 | Opus | L | Make locking transactional and mandatory for mutating operations |
| 69 | 1 | P0 | Opus | M | Stop workers and flush checkpoints before releasing the global lock |
| 70 | 2 | P0 | Opus | L | Honor RGB16 tiling policy; do not make 16-bit tile encoder mandatory |
| 71 | 2 | P1 | Opus | M | Bound convergence profiling and reuse existing reference decodes |
| 72 | 1 | P0 | Opus | M | Delete duplicate schema-1 browser validation; consume shared parser |
| 73 | 1 | P0 | Opus | L | Enforce finite bounds, safe URLs, content lengths, and digests |
| 74 | 2 | P1 | Opus | L | Make modular pyramid gallery canonical and retire legacy duplication |
| 75 | 1 | P0 | Opus | L | Preserve exact EXIF orientation or bake it consistently |
| 76 | 2 | P2 | Opus | L | Use existing thumbhash, grouping, metadata, and pagination fields |
| 77 | 2 | P0 | Opus | XL | Consolidate the two public tiled-decode orchestration engines |
| 78 | 2 | P0 | Opus | L | Keep a stable pool/source identity and stop gallery option drift/reloads |
| 79 | 2 | P1 | Opus | L | Avoid cloning a complete JXTC file to every non-SAB worker |
| 80 | 2 | P0 | Opus | L | Add worker byte-store unload/budget and preserve SAB sharing |
| 81 | 2 | P0 | Opus | L | Make L0 precision/tiling explicit so seed decoders choose valid paths |
| 82 | 2 | P1 | Opus | S | Separate worker availability from cross-origin-isolated SAB support |

## 8. Program Gates

- [ ] Record pinned `<base-ref>`, toolchain versions, fixture hashes, and current red tests before dispatch.
- [ ] Land packet 5 CI truth before accepting broad behavior changes.
- [ ] Land packet 1 shared contracts before packet 2 or packet 4 deletes duplicate validators/identity logic.
- [ ] Require cross-language golden fixtures for every changed binary/schema contract.
- [ ] Require abort/deadline tests for every async ownership change.
- [ ] Require unit/integration tests plus flipflop proof for every performance claim.
- [ ] Re-run protected progressive tests around every bridge edit.
- [ ] Integrator updates this ledger with branch, commit, gate result, and status when each finding lands.

## 9. Existing Artifacts To Reuse

- `docs/STRATEGIC-MAP-wave2-2026-07-06.md`: prior S2-S6 architecture and sequencing.
- `docs/PRODUCTION-READINESS-2026-07-09.md`: last recorded production gates and toolchain caveats.
- `docs/FEATURE_PARITY_MATRIX.md`: historical WASM/Tauri feature inventory.
- `docs/1 Implementation Blueprint.md`: streaming, memory, tiles, SIMD, fusion, and benchmark order.
- `docs/superpowers/plans/2026-07-10-ai-id-foundation.md`: AI-ID pure/Node boundary and deferred browser integration.
- `docs/superpowers/plans/2026-06-18-flipflop.md`: performance vehicle implementation and usage.
- `docs/superpowers/specs/2026-06-18-flipflop-design.md`: measurement contract and trust criteria.

These remain evidence. This roadmap owns the 2026-07-11 finding numbers and their implementation assignment.
