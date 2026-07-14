# Release And Compatibility Implementation Plan

> **For agentic workers:** A release is one compatible set of web assets, WASM
> artifacts, manifests, cache namespaces, and Tauri protocol. Work in isolated
> named worktrees and branches. Never publish from a dirty or unverifiable build.

**Goal:** Make clean installation, quality gates, hosting behavior, artifact
provenance, browser tiers, schema migration, and cross-repository protocol
compatibility one reversible release contract.

**Findings owned:** 23 release tail, 32 distribution dependency, 99-103, 112.  
**Lead quality:** Opus, sticky for compatibility and rollback work.  
**Effort:** XL program.  
**Lead worktree:** `C:\Foo\rcw-release-compatibility-opus-20260711`  
**Lead branch:** `chore/release-compatibility-opus-20260711`

## Finding Record

| Find | Priority | File and lines | Opportunity |
|---:|---|---|---|
| 99 | P0 | `web/CROSS-ORIGIN-ISOLATION.md:3-19,52-61`; `web/_headers:1-4`; `web/vercel.json:1-12`; `tools/dev-server.mjs:35-42,94-99`; `serve.ts:429-485`; `packages/jxl-capabilities/src/index.ts:93-116`; `packages/jxl-wasm/scripts/verify-dist.mjs:186-227` | Connect hosting headers, Range/CORS/MIME/cache behavior, browser/WASM tier matrix, provenance, and rollback into a mandatory production delivery contract. |
| 100 | P0 | `packages/pyramid-ingest/src/schema.ts:214-217`; `packages/jxl-pyramid/src/manifest-validate.ts:20-23,276-277`; `packages/pyramid-ingest/src/migrate.ts:94-194`; `web/casv-lightbox/TAURI_WIRING.md:45-71`; `web/tauri-pyramid-client.js:55-69`; `web/tauri-parity-lightbox.test.js:1-6` | Make schema rollout reversible and generate/version the Tauri command protocol instead of relying on manual cross-repo wiring and structural tests. |
| 101 | P0 | `packages/jxl-native/binding.gyp:56-60`; `packages/jxl-native/package.json:17`; `packages/jxl-native/README.md:46`; `packages/jxl-native/BLOCKED.md:5` | Clean install currently invokes host `node-gyp` and fails without `jxl.lib`. Make native support an explicit optional/prebuilt capability with a clear source-build path. |
| 102 | P0 | `packages/jxl-wasm/src/loader.ts:52,152`; `packages/jxl-wasm/src/facade.ts:2728,3627`; root `package.json:9` | Fix current `exactOptionalPropertyTypes` and environment typing failures so root typecheck can gate releases. |
| 103 | P0 | `packages/pyramid-ingest/src/raw-backend.ts:7,19`; root `package.json:8` | Root tests import absent generated RAW WASM. Provide a pinned build artifact or injectable test backend so clean-clone tests are hermetic. |
| 112 | P2 | root `package.json:1-17`; Node-safe modules such as `web/casv-lightbox/casv-lightbox.js`, `web/format-detect.js`, and `web/timelapse.js` | Node reparses ESM because root package type is unspecified. Audit CommonJS consumers, then declare module boundaries to remove warnings and avoid ambiguous loading. |

## Release Unit

Every release manifest must identify:

- Git commit and source-tree cleanliness.
- JS/CSS/worker/WASM/native artifact names, sizes, SHA-256 digests, roles, tiers,
  and toolchain provenance.
- Supported manifest read/write versions and migration/rollback range.
- Cache namespace and invalidation rule.
- Browser/runtime capability matrix and expected fallback.
- Tauri protocol version and compatible desktop build range.
- Hosted smoke result and rollback target.

## Task Order

```text
1 clean install + root quality gates
2 host contract
3 versioned assets/cache
4 browser/tier matrix
5 mandatory provenance release gate
6 reversible schema migration
7 generated Tauri protocol
8 compatibility and rollback drill
```

### Task 1: Make Clean Install And Root Gates Honest

**Findings:** 101-103, 112  
**Agent:** Sonnet / L  
**Worktree:** `C:\Foo\rcw-clean-install-gates-sonnet-20260711`  
**Branch:** `fix/clean-install-gates-sonnet-20260711`

- [ ] Decide whether `@casabio/jxl-native` ships prebuilds, is an optional dependency,
  or source-builds only behind explicit opt-in. Default JS/WASM install must not fail
  because an unused native capability is unavailable.
- [ ] Test supported Windows/Linux installs with and without libjxl/toolchain.
- [ ] Fix JXL WASM environment typings without weakening strict compiler options.
- [ ] Make pyramid-ingest tests inject a fake backend or consume a pinned generated
  artifact; no hardcoded local build path.
- [ ] Audit ESM/CJS boundaries before adding root `type`; rename/configure exceptions
  explicitly.
- [ ] Run install, build, typecheck, test, package dry-run, and consumer import smoke
  from a clean temporary checkout.

### Task 2: Define Hosted HTTP Behavior

**Finding:** 99a  
**Agent:** Opus / L  
**Worktree:** `C:\Foo\rcw-f99a-host-contract-opus-20260711`  
**Branch:** `fix/f99a-host-contract-opus-20260711`

- [ ] Specify COOP, COEP, CORP, CSP, CORS, MIME, compression, immutable asset cache,
  manifest/index revalidation, and byte Range behavior.
- [ ] Run hosted smoke against the actual deployment adapter/CDN, not only the dev
  server. Verify 200/206/416, redirect behavior, `Vary`, compressed WASM, worker load,
  and non-COI fallback.
- [ ] Expose a capability-health diagnostic without exposing source paths or private
  metadata.

### Task 3: Version Assets And Cache Namespaces

**Finding:** 99b; consumes 92 and 109-110  
**Agent:** Opus / L  
**Worktree:** `C:\Foo\rcw-f99b-cache-versioning-opus-20260711`  
**Branch:** `feat/f99b-cache-versioning-opus-20260711`

- [ ] Use verified content-addressed asset names and a release manifest.
- [ ] Version memory, IDB, OPFS, service-worker if adopted, index, manifest, and
  derived-asset namespaces deliberately.
- [ ] Keep last-known-good release/cache state and bound old generations.
- [ ] Test interrupted update, mixed tab versions, corrupt cache, quota eviction,
  downgrade, and offline restart.
- [ ] If claiming faster startup or fewer transferred bytes, use
  `flipflopdom.mjs .flipflop/dom-tests/cache-versioning.mjs` with cold/warm/offline
  rounds and verified visual/module equality.

### Task 4: Run The Browser And Artifact Tier Matrix

**Findings:** 32, 99c  
**Agent:** Opus / XL  
**Worktree:** `C:\Foo\rcw-f99c-browser-matrix-opus-20260711`  
**Branch:** `test/f99c-browser-matrix-opus-20260711`

- [ ] Build and select scalar/ST, SIMD/ST, and SIMD/MT artifacts by actual capability.
- [ ] Test Chromium, Firefox, and WebKit where supported; COI/non-COI; WebGL2,
  WebGL1/CPU fallback; online/offline; 8/16-bit; progressive and tiled decode.
- [ ] Assert identical output or declared quality across artifact tiers.
- [ ] Non-COI browser must decode through the ST RAW/JXL route rather than skip.
- [ ] Performance tier claims require start-rotated `flipflopdom` on identical
  artifacts/fixtures. Record first paint, final, transferred bytes, memory, and trust.

### Task 5: Enforce Distribution Provenance Before Publish

**Findings:** 23, 99d  
**Agent:** Sonnet / L  
**Worktree:** `C:\Foo\rcw-f99d-release-gate-sonnet-20260711`  
**Branch:** `ci/f99d-release-gate-sonnet-20260711`

- [ ] Wire `verify-dist --release` into package/root scripts, CI release job, and
  publish path.
- [ ] Run a real clean release build; verify every expected role/tier artifact and
  source/toolchain digest.
- [ ] Tamper with JS, WASM, manifest field, and provenance input; each must block
  publication.
- [ ] Delegate only deterministic generated-file/path assertions to Haiku in
  `C:\Foo\rcw-release-assertions-haiku-20260711` on
  `test/release-assertions-haiku-20260711`.

### Task 6: Make Schema Migration Reversible

**Finding:** 100a  
**Agent:** Opus / XL  
**Worktree:** `C:\Foo\rcw-f100a-schema-rollback-opus-20260711`  
**Branch:** `feat/f100a-schema-rollback-opus-20260711`

- [ ] Add migration journal, catalog-level backup/snapshot, shadow validation, and
  explicit commit point.
- [ ] Support mixed old/new readers during rollout; preserve unknown additive fields.
- [ ] Inject crash after each file/catalog boundary and prove restart/rollback.
- [ ] Prevent downgrade from silently rewriting unsupported future state.

### Task 7: Generate And Test The Tauri Protocol

**Finding:** 100b  
**Agent:** Opus / L  
**Worktree:** `C:\Foo\rcw-f100b-tauri-contract-opus-20260711`  
**Branch:** `feat/f100b-tauri-contract-opus-20260711`

- [ ] Define one versioned schema for commands, payloads, errors, progress, cancel,
  capabilities, and manifest-bearing responses.
- [ ] Generate TypeScript and Rust bindings or validate both against the same schema.
- [ ] Run an integration harness against the pinned `raw-converter-tauri` commit;
  structural source-string tests are insufficient.
- [ ] Reject incompatible protocol versions with a recoverable user-facing path.

### Task 8: Run Compatibility And Rollback Drill

**Finding:** 100c; depends on 99a-99d and 100a-100b  
**Agent:** Opus / L  
**Worktree:** `C:\Foo\rcw-f100c-compat-release-opus-20260711`  
**Branch:** `test/f100c-compat-release-opus-20260711`

- [ ] Exercise old/new web assets, old/new manifests, ST/MT WASM, caches, and old/new
  Tauri binaries in every supported direction.
- [ ] Deploy candidate, interrupt update, corrupt one artifact/cache record, then
  restore last-known-good and verify project/catalog integrity.
- [ ] Record recovery time, data outcome, remaining cache state, and exact rollback
  command/artifact.

## Release Gate

- [ ] Default install succeeds without an undeclared host libjxl dependency.
- [ ] Root build/typecheck/test passes from clean checkout.
- [ ] Hosted HTTP smoke and browser/tier matrix pass.
- [ ] Release provenance verifier is publish-blocking.
- [ ] Runtime cache/artifact identities match verified release manifest digests.
- [ ] Schema migration and Tauri protocol are versioned and reversible.
- [ ] Last-known-good rollback drill completes without lost catalog/project state.
