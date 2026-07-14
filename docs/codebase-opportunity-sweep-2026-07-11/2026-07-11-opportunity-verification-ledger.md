# Codebase Opportunity Verification Ledger

**Audit base:** `origin/main` at `cdd9e6b2`  
**Scope:** Documentation and verification only. No product source changes.

This ledger reconciles findings 1-82 from the first sweep against the current Git
state. The original packet documents remain the implementation specifications and
evidence index. This file records what has landed, what is only partial, and what
must be measured before closure.

## Outcome Priority

1. Zero silent data loss, corruption, stale publication, or misattached edits in a
   mixed-format ingest-to-export workflow.
2. Bounded memory and cancellation ownership across long browser and CLI sessions.
3. Lower p95 time to first usable preview and lower export latency, after a current
   baseline exists.
4. Turn latent codec, metadata, catalog, and offline foundations into complete user
   workflows.

Numeric latency and memory targets below are provisional until packet 7 records a
representative corpus and device matrix.

## Status Vocabulary

| Status | Meaning |
|---|---|
| Closed | Merged behavior and focused tests satisfy the original finding. |
| Partial | Useful implementation exists, but one or more acceptance gates remain. |
| Open | No merged implementation closes the original opportunity. |
| Branch-ready | Implementation exists on an unmerged branch and still needs review/gates. |
| Measurement | Functional work landed, but the performance or memory claim is unproved. |
| Research | Experimental work should not be scheduled as production wiring yet. |

## Baseline Snapshot

| Command | Result at audit base | Meaning |
|---|---|---|
| `rtk proxy node --test tools/run-workspaces.test.mjs` | 20 pass | Workspace DAG runner behavior is covered. |
| `rtk proxy bun install --frozen-lockfile` | Fail: linker cannot find `jxl.lib` | Clean install is host-dependent. |
| `rtk proxy bun install --frozen-lockfile --ignore-scripts` | Pass | JS dependency graph can install only when native scripts are suppressed. |
| `rtk proxy bun run test` | Fail: 2 pyramid-ingest errors from missing `pkg/raw_converter_wasm.js` | Root test command is not clean-clone hermetic. |
| `rtk proxy bun run typecheck` | Fail in `@casabio/jxl-wasm` | Root typecheck is not a usable gate yet. |
| `rtk proxy node --test tools/verify-workflow.test.mjs` | 24 pass | Workflow structure and discovery guards pass locally. |
| Node-safe web discovery | 79 pass | The runnable Node subset passes. |
| Benchmark smoke discovery | 76 pass | Registered JS/MJS benchmark smoke subset passes. |
| Full discovery inventory | 32 runnable, 65 skipped, 9 known failures | CI truth is explicit but incomplete. |
| Protected progressive tests | 1 pass and 10 pass | Required progressive checkpoint behavior remains intact. |
| Modular gallery/lightbox tests | 17 pass, 1 skipped | Core modular path works; HDR export coverage remains skipped. |

## Findings 1-58

Evidence anchors for each finding remain in packets 2-6. Current exceptions and
closure evidence are called out here.

| Find | Status | Current evidence or remaining gate |
|---:|---|---|
| 1 | Measurement | `tools/run-workspaces.mjs:43-104,131-197,219-229,280-366`; dependency-aware runner landed, but no representative before/after wall-time flipflop exists. |
| 2 | Open | Gallery still fetches whole manifests/levels instead of consuming one progressive range-delivery contract. |
| 3 | Partial | Modular gallery uses `jxl-session`; `web/main.js:5798-5814` still adapts its private worker pool. |
| 4 | Open | Low-memory RAW-to-JXL band fusion remains an unused capability, not a product route. |
| 5 | Partial | Gain-map bridge APIs exist in `bridge.cpp:990-1079,2945-3005`; product HDR negotiation/composition is absent. |
| 6 | Partial | Animation bridge support exists at `bridge.cpp:2081-2118,2964`; it remains lab-only and outside catalog intake. |
| 7 | Partial | Streaming metadata setter exists at `bridge.cpp:3468-3535`; end-to-end retention/privacy policy remains incomplete. |
| 8 | Partial | `.github/workflows/verify.yml:85-267` adds workspace/web/benchmark jobs; built-WASM, Bun, Vitest, and browser lanes remain absent. |
| 9 | Open | Calibrated thread budgets are not the single worker admission authority. |
| 10 | Open | Proxy mode and Develop Selected are not complete product workflows. |
| 11 | Partial | `asset-store` provides budgets/LRU, but card, worker, and WASM ownership is not governed by one policy. |
| 12 | Open | WebGL renderer/framebuffer/source reuse still needs lifecycle and long-session proof. |
| 13 | Open | `web/main.js:3611-3640` does not provide one true full-resolution selected export contract. |
| 14 | Open | Picker capability and actual SDR/RAW detection remain separately maintained. |
| 15 | Partial | Timelapse exists as a standalone workflow, not bounded mixed-media catalog intake. |
| 16 | Partial | AI-ID pure/proxy/sidecar foundations exist; cards, consent, correction, and cancellation are unwired. |
| 17 | Branch-ready | `feat/jxl-role-loader` contains `d210f1ab`, `c8dee57b`, and `afdef2b5`; not merged into the audit base. |
| 18 | Partial | Extra-channel facade/native types and bridge paths exist; complete product and cross-runtime parity remain unproved. |
| 19 | Open | Advanced settings still include ignored fields; `bridge.cpp:3374-3378` explicitly discards several values. |
| 20 | Open | Public native stream APIs remain close-buffered rather than truly incremental. |
| 21 | Open | SIMD128 MHC demosaic lacks completed implementation and corpus proof. |
| 22 | Partial | C++ exposes JPEG transcode v2 at `bridge.cpp:3635`; facade capability still exposes the older entry point and JUMBF contract is incomplete. |
| 23 | Partial | Provenance verification landed, but `verify-dist` is not a mandatory package/root/CI publish gate. |
| 24 | Open | Fuzz targets and workflow still need codec-feature builds, parser-reached assertions, corpora, and crash retention. |
| 25 | Open | PGO metadata/profile application remains unproved on the shipped tier; requires quality parity plus flipflop. |
| 26 | Partial | `jxl-progressive/src/lod-resolver.ts:263-281` exists; gallery/lightbox still choose levels directly and do not consume it. |
| 27 | Research | Progressive AI saliency/confidence stopping remains an experiment requiring measured value. |
| 28 | Partial | JS/MJS benchmark discovery landed; `jxl-wasm/test/pgo-corpus-benchmark.test.ts` is still outside authoritative root/PR runners. |
| 29 | Partial | OPFS/asset-store foundations exist, but all derived assets and index/manifests do not share one durable cache lifecycle. |
| 30 | Partial | 16-bit lightbox/render/export code exists; real HDR/gain-map contract and one export test remain absent/skipped. |
| 31 | Branch-ready | `feat/jxl-role-loader` commit `38682163` removes dead `DecoderPool`; not merged into the audit base. |
| 32 | Open | No single-thread RAW WASM artifact/selector or non-COI decode E2E exists. |
| 33 | Open | Non-SAB delivery still repeats full-buffer ownership/copies instead of using one carrier policy. |
| 34 | Open | DNG mosaic state is not retained as the deferred-development source of truth. |
| 35 | Open | CR2 does not consistently route through the streaming exporter core. |
| 36 | Research | Fable CASV source-to-distribution-to-UI loop remains experimental. |
| 37 | Open | CASV decoded-frame ring and I-frame seek need bounded implementation. |
| 38 | Open | CASV byte-source/range streaming remains incomplete. |
| 39 | Open | Browser intake can still read many RAW files before bounded admission. |
| 40 | Partial | Card state has moved behind explicit state helpers, but sidecar ownership and stale navigation generations remain incomplete. |
| 41 | Open | Crop Apply/Cancel and straighten state still need one transactional command. |
| 42 | Open | Overlapping pyramid level loads still need abort/reject semantics for stale generations. |
| 43 | Open | Thumbnail paths can still pay full JXL decode cost. |
| 44 | Partial | ICC/EXIF/XMP plumbing exists; explicit retain/redact/upload policy is incomplete. |
| 45 | Open | UI still needs authoritative source format and bit-depth presentation. |
| 46 | Open | Browser identity/durable-save error behavior remains basename/stat oriented. |
| 47 | Open | Dormant WASM/HDR/lens/benchmark modules need measured lazy loading. |
| 48 | Open | Reprocess does not fully cancel/generation-guard stale JXL decode output. |
| 49 | Open | Shared decode cancellation needs reference-counted waiter ownership. |
| 50 | Open | DNG datetime/GPS parser output is not preserved consistently end to end. |
| 51 | Open | DNG/CR2 white-balance provenance remains incomplete. |
| 52 | Open | CR2 preview/final color-matrix selection remains divergent. |
| 53 | Open | Uncompressed DNG still needs row streaming without full mosaic materialization. |
| 54 | Open | Sparse CFA sampling still creates avoidable CR2 cropped-mosaic work. |
| 55 | Open | `RawStreamExporter` still needs removal of full-input duplication. |
| 56 | Open | Dual-illuminant DNG calibration still needs illuminant-aware resolution. |
| 57 | Open | Linear-RGB DNG needs a correct demosaic bypass. |
| 58 | Open | TIFF/EXR/JPEG decoded pixels are not retained across all pipeline stages. |

## Findings 59-82

| Find | Status | Current evidence or remaining gate |
|---:|---|---|
| 59 | Measurement | `image_formats.rs:92-205,309-347` and `tests/decode_limits.rs:55-200` implement guards; hostile serialized fixtures and browser/WASM peak-memory proof remain. |
| 60 | Closed | Absolute JXTC offsets landed across TypeScript, C++, Rust, and tests. |
| 61 | Closed | New manifests write canonical JSON and use static ESM parsing; binary support is legacy-read only. |
| 62 | Closed | Lossy compact writes were removed; legacy decoder is isolated. Add corrupt legacy fixtures as hardening, not reopening. |
| 63 | Partial | Descriptor propagation landed, but `ladder.ts:13` uses 256 while tiling/fallback defaults use 512. Require actual tile size and interoperability fixtures. |
| 64 | Partial | Schema accepts open `sourceFormat`; new writers at `ingest.ts:358-360,571-573` do not prove provenance independent of decoder route. |
| 65 | Partial | Version lists remain duplicated between ingest and `jxl-pyramid/src/manifest-validate.ts:20-23`. |
| 66 | Open | `hash.ts:34-40` uses path FNV identity; freshness remains mtime-oriented at `manifest.ts:108-112`. |
| 67 | Open | `ingest.ts:474-529` still uses detached timeout `Promise.race`; work can continue after waiter failure. |
| 68 | Partial | Lock APIs exist, but reindex and lock ordering remain caller-dependent at `cli.ts:147-152,298-321,419`. |
| 69 | Partial | Signal handler releases early and finalizer releases again at `cli.ts:247-250,487-489`; blind unlink at `lock.ts:111,151` can delete a successor lock. |
| 70 | Open | `ladder.ts:38-102` still makes the 16-bit tile encoder mandatory and tiles RGB16 levels regardless of policy. |
| 71 | Open | Convergence profiling remains unbounded and duplicates reference decode work. |
| 72 | Closed | Browser consumes shared manifest parser; schema-1-only duplicate validator is gone. |
| 73 | Partial | Structural parsing improved; `image-store.js:66-121` still performs unbounded, undigested fetches with interpolated URLs. |
| 74 | Partial | Modular gallery exists, but legacy gallery duplication remains and canonical ownership is not enforced. |
| 75 | Partial | Orientation descriptor landed; pixel bake/consume parity across ingest, gallery, and export remains unproved. |
| 76 | Open | Thumbhash, grouping, metadata projection, and pagination fields parse but gallery ignores them. |
| 77 | Open | Public tiled decode orchestration remains split between `decode-level` and `tiled-decode-pool`. |
| 78 | Open | Pool/source identity and option drift can still trigger reloads. |
| 79 | Open | Non-SAB workers still receive complete JXTC ownership rather than requested tile payloads/shared source service. |
| 80 | Open | Worker `byteStore` has no unload/budget protocol; SAB load also copies inside `tiled-decode-worker.js:30-32`. |
| 81 | Partial | v5 precision/tiling descriptors exist; seed/fallback paths still assume 8-bit in `pyramid-lightbox.js:747-766`. |
| 82 | Partial | `canShareContainerBytes()` is separate, but `canUseParallelTileWorkers()` at `tiling.ts:197-212` still requires cross-origin isolation for ordinary workers. |

## Landed Commit Map

| Area | Commits |
|---|---|
| Workspace DAG | `cb336fe6`, `503b327c` |
| CI discovery and hardening | `cea3c80c`, `b7b9e4db`, `7dc6b7af`, merge `37767e76` |
| Decode limits | `bb546121`, `b2e3745b` |
| JXTC offsets | `e3e7435b`, `a05d75c7`, `0605339b` |
| Manifest v5/JSON/shared parser | `f16cdfec`, `5378c8da`, `25d4be84`, merge `e6ab293b` |
| Distribution provenance | `73112022`, `215cc57a`, merge `cdd9e6b2` |
| Role loader/dead pool, unmerged | `d210f1ab`, `c8dee57b`, `38682163`, `afdef2b5` on `feat/jxl-role-loader` |

## Reconciliation Rule

Plan checkboxes are specifications, not status. A finding closes only after its
branch is merged and its behavior, failure, compatibility, and performance gates
pass. Performance closure additionally requires a retained flipflop TOON record.
