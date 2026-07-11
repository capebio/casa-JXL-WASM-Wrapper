# Contracts And Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make developed-image limits, JXTC offsets, pyramid schemas, source identity, cancellation, locking, and browser trust boundaries explicit and cross-language consistent.

**Architecture:** `@casabio/pyramid-ingest` owns the persisted gallery contract and exports parsers/types for consumers. Binary JXTC uses absolute file offsets everywhere. Source identity and freshness become separate concepts. All asynchronous mutation runs under an abortable transaction whose lock outlives workers and checkpoint flushes.

**Tech Stack:** Rust, TypeScript, Zod, Bun, Node worker threads, JXTC, JSON, filesystem locks, AbortSignal.

## Global Constraints

- Master program: `docs/superpowers/plans/2026-07-11-codebase-opportunity-roadmap.md`.
- Findings owned here: 59-69, 72, 73, 75.
- Lead model: Opus. Program effort: XL.
- Lead worktree: `C:\Foo\rcw-contracts-reliability-opus-20260711`.
- Lead branch: `feat/contracts-reliability-opus-20260711`.
- Delegated task worktree: `C:\Foo\rcw-contracts-<task-slug>-<agent-id>`.
- Delegated task branch: `fix/contracts-<task-slug>-<agent-id>`.
- Create every worktree from the integrator-pinned `<base-ref>`; never share worktrees.
- Do not remove unknown manifest fields during migration.
- Old persisted data needs an explicit read/migrate/reject decision. Never silently reinterpret bytes.
- No performance claim without the master flipflop gate.

---

## Finding Evidence

| Find | Evidence | Opportunity |
|---:|---|---|
| 59 | `crates/raw-pipeline/src/image_formats.rs:8-45,61-93`; `src/lib.rs:1896-1915,3478-3589,4253-4279`; `tools/build-mt-wasm.sh:32-35` | Probe headers and apply byte-based output limits before TIFF/EXR/JPEG allocation |
| 60 | `packages/jxl-wasm/src/bridge.cpp:1905-1931,1956-1988`; `crates/raw-pipeline/src/jxl_casadecoder.rs:2088-2127,2897-2904`; `packages/jxl-pyramid/src/tiling.ts:87-118,221-249` | Declare JXTC offsets absolute; cross-language golden proves readers and writers agree |
| 61 | `packages/pyramid-ingest/src/ingest.ts:392-411,945-975`; `src/schema.ts:159-187`; `src/manifest.ts:93-327`; `package.json:5-12`; `tsconfig.json:4-16`; `web/pyramid-gallery/image-store.js:86-91`; `web/pyramid-gallery.js:180-184,252-263,478-484` | Stop storing binary payloads under `.json`; remove CommonJS `require` from ESM parsing |
| 62 | `packages/pyramid-ingest/src/schema.ts:51-84`; `src/manifest.ts:93-176,179-275,278-327`; `src/ingest.ts:566-608`; `src/migrate.ts:30-55,106-115`; `packages/jxl-pyramid/src/manifest-validate.ts:20-22,119-169` | Remove or version lossy compact codecs that drop fields and wrap geometry |
| 63 | `packages/pyramid-ingest/src/schema.ts:39-48`; `src/manifest.ts:31-42`; `src/ladder.ts:12-18,34-64,97-102,112-137,205-216`; `packages/jxl-pyramid/src/manifest.ts:73-90`; `src/manifest-validate.ts:119-169`; `src/tiling.ts:3-10` | Persist a tiling descriptor and share tile constants |
| 64 | `packages/pyramid-ingest/src/ingest.ts:65-81,266-275,531-608`; `src/backends.ts:4-6,61-63`; `src/schema.ts:51-55`; `packages/jxl-pyramid/src/manifest.ts:5-23`; `src/manifest-validate.ts:82-95` | Separate detected source provenance from available decoder capability |
| 65 | `packages/pyramid-ingest/src/schema.ts:87-112`; `src/manifest.ts:45-67`; `src/migrate.ts:83-103`; `packages/jxl-pyramid/src/manifest-validate.ts:16-22,197-210,243-255` | One owner for current schema and supported read versions |
| 66 | `packages/pyramid-ingest/src/hash.ts:4-39`; `src/manifest.ts:83-87`; `src/ingest.ts:37-40,427-467,684-704,840-860` | Stable catalog identity plus content/freshness fingerprint |
| 67 | `packages/pyramid-ingest/src/ingest.ts:419-475,511-528,821-837` | Deadline must abort worker/decode/write work, not only `Promise.race` waiter |
| 68 | `packages/pyramid-ingest/src/cli.ts:147-152,222-257,298-321`; `src/rm.ts:42-50`; `src/ingest.ts:385-415,936-975,990-1055`; `src/lock.ts:157-189` | Mutation APIs acquire capabilities/transactions; callers cannot omit or invert locks |
| 69 | `packages/pyramid-ingest/src/cli.ts:247-253,416-439,484-491`; `src/ingest.ts:821-837,919-924` | Abort, terminate/join workers, flush checkpoints, then release lock |
| 72 | `packages/pyramid-ingest/src/manifest.ts:45-67`; `web/pyramid-gallery/image-store.js:10-33,85-93`; `packages/jxl-pyramid/src/manifest-validate.ts:197-210,243-263` | Browser consumes shared schema parser instead of schema-1-only duplicate |
| 73 | `web/pyramid-gallery/pyramid-gallery.js:20-37,69-88`; `image-store.js:15-32,74-120`; `packages/jxl-pyramid/src/manifest-validate.ts:19-27,119-194` | Validate finite bounds, root-contained URLs, response sizes, and hashes |
| 75 | `packages/pyramid-ingest/src/ingest.ts:183-195,277-284,338-353,545-560`; `packages/jxl-pyramid/src/manifest.ts:8-20,103-109`; `web/pyramid-gallery/image-store.js:15-33`; `web/pyramid-gallery/pyramid-gallery.js:69-116`; `web/lightbox/pyramid-lightbox.js:372-484` | Preserve EXIF orientation 1-8 or explicitly record baked orientation |

## Target Public Contracts

Names may change only in Task 1 contract review. After that commit, dependent packets consume them unchanged.

```ts
export const CURRENT_MANIFEST_SCHEMA = 5;
export const READABLE_MANIFEST_SCHEMAS = [1, 2, 4, 5] as const;

export type SourceIdentity = {
  catalogId: string;
  sourceKey: string;
};

export type SourceFingerprint = {
  byteLength: number;
  mtimeMs: number;
  quickHash: string;
  contentHash?: string;
};

export type TilingDescriptor = {
  container: "jxtc";
  version: 1 | 2;
  tileSize: number;
  bitsPerSample: 8 | 16;
  offsetBase: "file";
};

export type OrientationDescriptor = {
  exif: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  pixels: "source" | "baked-upright";
};
```

```rust
pub struct DecodeLimits {
    pub max_input_bytes: u64,
    pub max_width: u32,
    pub max_height: u32,
    pub max_pixels: u64,
    pub max_output_bytes: u64,
}
```

JXTC v1/v2 invariant: every index offset is an absolute byte offset from byte zero of the complete JXTC file. Readers reject offsets inside the header/index and any checked `offset + length` beyond the file.

## Task Order

```text
1 contract fixtures and version decision
2 developed-image DecodeLimits                 (parallel after 1)
3 JXTC absolute-offset repair                   (parallel after 1)
4 JSON/schema/tiling/format/orientation         (after 1)
5 stable identity and freshness                 (after 4)
6 abortable ingest deadlines                    (after 4)
7 transactional locks and ordered shutdown      (after 6)
8 browser trust boundary                        (after 3-5)
9 compatibility and integration gate            (last)
```

### Task 1: Pin Contract Fixtures And Version Policy

**Findings:** 60-65, 72, 75  
**Model/Effort:** Opus / M

**Files:**
- Create: `packages/pyramid-ingest/test/fixtures/contracts/manifest-v1.json`
- Create: `packages/pyramid-ingest/test/fixtures/contracts/manifest-v2.json`
- Create: `packages/pyramid-ingest/test/fixtures/contracts/manifest-v4.json`
- Create: `packages/pyramid-ingest/test/fixtures/contracts/jxtc-v1.bin`
- Create: `packages/pyramid-ingest/test/contract-compat.test.ts`
- Create: `packages/jxl-pyramid/test/cross-language-jxtc.test.ts`
- Modify: `packages/pyramid-ingest/src/schema.ts:87-112`

**Interfaces:**
- Produces the schema/version and JXTC offset invariants above.
- Produces fixture hashes consumed by Rust, C++, TypeScript, ingest, and browser tests.

- [ ] Write tests that read every committed fixture, assert its SHA-256, and assert the declared read/migrate result.
- [ ] Add a JXTC fixture with at least two different tile lengths; assert the first absolute offset equals `32 + tileCount * 8`.
- [ ] Add malformed siblings for offset-inside-index, checked-add overflow, unsupported schema, invalid orientation, and missing tiling descriptor.
- [ ] Run `rtk proxy bun test packages/pyramid-ingest/test/contract-compat.test.ts packages/jxl-pyramid/test/cross-language-jxtc.test.ts`; expected initial result: contract assertions fail against current readers.
- [ ] Record the approved v5 additive schema and compatibility table at the top of `schema.ts`; do not implement migrations yet.
- [ ] Commit as `test(contracts): pin pyramid and JXTC compatibility fixtures`.

### Task 2: Preflight Developed Images With Byte-Based Decode Limits

**Finding:** 59  
**Model/Effort:** Opus / L

**Files:**
- Modify: `crates/raw-pipeline/src/image_formats.rs:8-93`
- Modify: `src/lib.rs:1896-1915,3478-3589,4253-4279`
- Create: `crates/raw-pipeline/tests/decode_limits.rs`
- Modify: `tools/build-mt-wasm.sh:32-35`

**Interfaces:**
- Produces `DecodeLimits` and a header probe returning format, dimensions, channels, sample representation, and checked output bytes.
- Consumers must reject before allocating or decoding when any limit is exceeded.

- [ ] Write hostile-header tests for a 400 MP EXR, overflowing TIFF dimensions, valid small JPEG, and a file whose compressed size is small but decoded size exceeds the WASM budget.
- [ ] Run `rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml --test decode_limits`; expected initial result: oversized cases reach allocation/decode or lack the API.
- [ ] Implement checked header probes using the format libraries' structured metadata APIs. Do not decode pixels to discover dimensions.
- [ ] Thread one explicit WASM limit profile and one native limit profile through developed-image entry points.
- [ ] Assert the wasm32 profile remains below the configured memory maximum after input, output, scratch, and safety margin are included.
- [ ] Re-run the targeted test and `rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml --release`.
- [ ] If claiming faster rejection or lower peak memory, add `.flipflop/tests/developed-image-limits.mjs` and run `flipflopMem.mjs` against valid and hostile headers.
- [ ] Commit as `fix(raw): preflight developed-image decode limits`.

### Task 3: Repair The JXTC Offset Contract

**Finding:** 60  
**Model/Effort:** Opus / M

**Files:**
- Modify: `packages/jxl-pyramid/src/tiling.ts:79-118,212-249`
- Modify: `packages/jxl-wasm/src/bridge.cpp:1689-1709,1905-1931,1940-1988`
- Modify: `crates/raw-pipeline/src/jxl_casadecoder.rs:2088-2127,2688-2712,2854-2905`
- Test: `packages/jxl-pyramid/test/cross-language-jxtc.test.ts`
- Test: `packages/jxl-pyramid/test/tiling.test.ts`

**Interfaces:**
- Consumes Task 1 JXTC fixture.
- Produces absolute offsets. Removes `dataBase + offset` from TypeScript extraction.

- [ ] Run the protected progressive tests before touching `bridge.cpp`.
- [ ] Extend the golden test to parse a C++-produced and Rust-produced JXTC in TypeScript, then decode the same tiles in all available readers.
- [ ] Run the targeted JXTC tests; expected initial result: TypeScript seeks past the fixture tile payload.
- [ ] Change TypeScript index representation from `{offsets, lengths, dataBase}` to absolute `{offsets, lengths}` and use checked bounds.
- [ ] Add explicit comments and assertions to C++ and Rust writers/readers that offsets are file-relative.
- [ ] Run `rtk proxy bun test packages/jxl-pyramid/test/tiling.test.ts packages/jxl-pyramid/test/cross-language-jxtc.test.ts` and the raw-pipeline JXTC tests.
- [ ] Run the protected progressive tests after the bridge edit.
- [ ] Commit as `fix(jxtc): standardize absolute tile offsets`.

### Task 4: Make One Lossless Manifest Contract

**Findings:** 61-65, 72, 75  
**Model/Effort:** Opus / XL

**Files:**
- Modify: `packages/pyramid-ingest/src/schema.ts:39-112,159-187`
- Modify: `packages/pyramid-ingest/src/manifest.ts:31-327`
- Modify: `packages/pyramid-ingest/src/ingest.ts:392-411,531-608,938-975`
- Modify: `packages/pyramid-ingest/src/migrate.ts:30-55,83-115`
- Modify: `packages/pyramid-ingest/src/backends.ts:4-6,61-63`
- Modify: `packages/jxl-pyramid/src/constants.ts`
- Modify: `packages/jxl-pyramid/src/manifest.ts:5-23,73-109`
- Modify: `packages/jxl-pyramid/src/manifest-validate.ts:16-27,82-95,119-210,243-263`
- Modify: `web/pyramid-gallery/image-store.js:10-33,85-93`
- Test: `packages/pyramid-ingest/test/manifest.test.ts`
- Test: `packages/pyramid-ingest/test/lifecycle.integration.test.ts`
- Test: `packages/jxl-pyramid/test/manifest-validate.test.ts`

**Interfaces:**
- Consumes Task 1 compatibility table and Task 3 offset contract.
- Produces JSON on `.json` paths and a separate explicitly versioned binary extension only if measured need remains.
- Produces provenance enum independent of decoder capability and exact orientation/tiling descriptors.

- [ ] Add round-trip tests containing maximum legal geometry, exact EXIF orientation 1-8, format provenance, metadata, stubs, layout, tiling, and an unknown extension field.
- [ ] Add browser-consumer tests for schema 1, 2, 4, and 5 fixtures.
- [ ] Run targeted tests; expected initial failures: binary `.json`, dropped fields, schema-1-only browser validation, and tile-size disagreement.
- [ ] Make JSON the canonical persisted representation. If compact storage is retained, name/version it explicitly and make its round trip lossless for the complete schema.
- [ ] Remove runtime `require("./manifest.js")`; keep the ESM dependency graph static and cycle-free by moving codec code to a focused module if retained.
- [ ] Export shared parser/types/constants from `@casabio/pyramid-ingest`; make `jxl-pyramid` and browser code consume them.
- [ ] Model `sourceFormat` separately from `decoderCapability`; reject unsupported decoding without erasing provenance.
- [ ] Persist `TilingDescriptor` and `OrientationDescriptor`. Define whether width/height are stored-source or baked-upright dimensions.
- [ ] Migrate additively while preserving unknown fields. Refuse unsupported future major schemas.
- [ ] Run package build/typecheck/test plus all compatibility fixtures.
- [ ] Commit schema, migration, consumer adoption, and generated `dist/` in separate reviewable commits.

### Task 5: Separate Stable Identity From Freshness

**Finding:** 66  
**Model/Effort:** Opus / XL

**Files:**
- Modify: `packages/pyramid-ingest/src/hash.ts:4-39`
- Modify: `packages/pyramid-ingest/src/manifest.ts:45-87`
- Modify: `packages/pyramid-ingest/src/ingest.ts:37-40,427-467,684-704,840-860`
- Modify: `packages/pyramid-ingest/src/cli.ts:19-54,207-217,364-410`
- Create: `packages/pyramid-ingest/src/source-identity.ts`
- Create: `packages/pyramid-ingest/test/source-identity.test.ts`

**Interfaces:**
- Consumes v5 manifest from Task 4.
- Produces `SourceIdentity`, `SourceFingerprint`, `isFresh(existing, observed)`, and an explicit move/relink operation.

- [ ] Write tests for same basename in different directories, moved unchanged file, replaced bytes with preserved mtime, Unicode/case-normalized paths, and two files sharing metadata but not content.
- [ ] Run the identity test; expected initial failures: path-hash duplication and mtime-only false freshness.
- [ ] Define `catalogId` as persistent catalog identity. Define `sourceKey`/fingerprint as change detection; do not conflate either with the level content hash.
- [ ] Use size + mtime + quick hash for normal freshness and full content hash for ambiguity, move detection, or durable identity promotion.
- [ ] Add a migration/relink report. Never merge two catalog entries silently.
- [ ] Run lifecycle, hash, CLI, and manifest tests.
- [ ] If hashing/admission performance changes, prove it on real mixed-size files with `flipflop.mjs` and ensure saved decode work is not hidden inside the timed arm.
- [ ] Commit as `feat(ingest): separate catalog identity and freshness`.

### Task 6: Propagate Abortable Deadlines Through Ingest

**Finding:** 67  
**Model/Effort:** Opus / L

**Files:**
- Modify: `packages/pyramid-ingest/src/ingest.ts:419-528,625-924`
- Modify: `packages/pyramid-ingest/src/ingest-worker.ts`
- Modify: `packages/pyramid-ingest/src/backends.ts`
- Create: `packages/pyramid-ingest/test/deadline.integration.test.ts`

**Interfaces:**
- Produces one combined `AbortSignal` per image from caller cancellation and deadline.
- Worker/backend/write stages accept that signal and stop before publishing artifacts.

- [ ] Write a deterministic test backend that blocks at read, decode, encode, and pre-rename checkpoints; expire the deadline at each checkpoint.
- [ ] Assert no detached promise continues, no manifest/level is published, temporary files are cleaned, worker settles, and result is `ABORT_ERR` with stage metadata.
- [ ] Run the test; expected initial result: `Promise.race` rejects while the loser continues.
- [ ] Replace the detached timeout with a deadline AbortController combined with caller signal.
- [ ] Propagate signal checks into read, backend, worker protocol, encode, and atomic publish boundaries.
- [ ] Join the canceled work before returning the timeout result.
- [ ] Run deadline, guard, ingest, and lifecycle tests.
- [ ] Commit as `fix(ingest): cancel timed-out work end to end`.

### Task 7: Make Mutation A Locked Transaction And Order Shutdown

**Findings:** 68, 69  
**Model/Effort:** Opus / L

**Files:**
- Modify: `packages/pyramid-ingest/src/lock.ts:95-189`
- Modify: `packages/pyramid-ingest/src/cli.ts:147-152,222-257,298-321,416-491`
- Modify: `packages/pyramid-ingest/src/rm.ts:9-50`
- Modify: `packages/pyramid-ingest/src/ingest.ts:385-415,821-837,919-924,936-1055`
- Create: `packages/pyramid-ingest/src/transaction.ts`
- Create: `packages/pyramid-ingest/test/transaction.integration.test.ts`

**Interfaces:**
- Consumes Task 6 abortable work.
- Produces `withReadTransaction` and `withWriteTransaction`; mutation services require the transaction capability rather than relying on caller convention.

- [ ] Write two-process tests for ingest vs rm/gc/reindex/migrate and signal during active worker/checkpoint write.
- [ ] Assert lock acquisition failure is fatal, lock order is global then image, and no mutator writes unlocked.
- [ ] Assert shutdown order: abort intake, cancel jobs, terminate/join workers, flush/close checkpoint, release image lock, release global lock.
- [ ] Run the transaction tests; expected initial failures: reindex omission, rm/gc inversion, and early signal release.
- [ ] Encapsulate lock ownership in transaction APIs and remove ad hoc acquisition from commands/services.
- [ ] Make lock order machine-checkable with a capability type or runtime assertion.
- [ ] Run CLI, lock, rm, lifecycle, deadline, and transaction tests.
- [ ] Commit as `fix(ingest): enforce transactional locks and shutdown`.

### Task 8: Harden Browser Manifest And Byte Fetch Boundaries

**Finding:** 73  
**Model/Effort:** Opus / L

**Files:**
- Modify: `packages/jxl-pyramid/src/manifest-validate.ts:19-27,119-194`
- Modify: `web/pyramid-gallery/image-store.js:15-32,74-120`
- Modify: `web/pyramid-gallery/pyramid-gallery.js:20-37,69-88`
- Create: `web/pyramid-gallery/trusted-fetch.js`
- Create: `web/pyramid-gallery/trusted-fetch.test.js`

**Interfaces:**
- Consumes Task 4 shared parser and Task 5 source identity.
- Produces `fetchVerifiedAsset({ root, relativePath, expectedBytes, sha256, signal })`.

- [ ] Test `NaN`, infinity, negative/huge dimensions, encoded path traversal, absolute/cross-origin URLs, redirect escape, missing/oversized Content-Length, streamed overrun, truncated body, and digest mismatch.
- [ ] Run the tests; expected initial result: weak structural validator and unrestricted fetch accept hostile cases.
- [ ] Resolve paths through `new URL`, then require same origin and root-path containment after normalization and redirects.
- [ ] Enforce declared byte caps before and during streaming. Abort immediately on overrun.
- [ ] Verify SHA-256 before cache publication or decode.
- [ ] Reuse the shared schema parser. Delete the schema-1 browser duplicate.
- [ ] Run jxl-pyramid validation tests and modular gallery tests.
- [ ] Commit as `fix(gallery): verify manifests and fetched assets`.

### Task 9: Compatibility And Integration Gate

**Findings:** 59-69, 72, 73, 75  
**Model/Effort:** Opus / M

**Files:**
- Modify: `packages/pyramid-ingest/test/lifecycle.integration.test.ts`
- Modify: `packages/jxl-pyramid/test/manifest-validate.test.ts`
- Modify: `.github/workflows/verify.yml` after packet 5 exposes the authoritative workspace command
- Create: `docs/outputs/contracts/2026-07-11-contract-migration-report.md`

- [ ] Ingest representative ORF/DNG/CR2/JPEG and RGB16 assets under each readable old schema; migrate; reopen through the modular gallery.
- [ ] Verify exact orientation, source format, tiling, dimensions, hashes, and JXTC tile pixels.
- [ ] Interrupt an ingest during every publish stage; restart; verify deterministic recovery and no unlocked orphan deletion.
- [ ] Run `rtk proxy bun run build`, `rtk proxy bun run typecheck`, and `rtk proxy bun run test` from the repo root.
- [ ] Run raw-pipeline release tests and the packet's targeted integration tests.
- [ ] Write the migration report with fixture hashes, supported versions, rejection behavior, and recovery evidence.
- [ ] Hand the pushed branch to the integrator. Do not merge it yourself.
