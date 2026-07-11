# Tooling And Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CI, workspace execution, benchmark registration, fuzzing, distribution provenance, PGO, and non-COI builds truthful enough to gate the other packets.

**Architecture:** Root scripts discover the workspace dependency graph and run bounded parallel tasks with deterministic logs. CI calls the same authoritative commands as developers. Build artifacts carry a digest over all real inputs and tier/toolchain data. Fuzz and PGO jobs fail closed when they did not exercise their intended parser/profile.

**Tech Stack:** Bun, Node, GitHub Actions, Cargo fuzz, Emscripten/LLVM PGO, WASM build manifests, browser capability routing.

## Global Constraints

- Master program: `docs/superpowers/plans/2026-07-11-codebase-opportunity-roadmap.md`.
- Findings owned here: 1, 8, 23-25, 28, 32.
- Lead model: Sonnet. Program effort: L.
- Lead worktree: `C:\Foo\rcw-tooling-performance-sonnet-20260711`.
- Lead branch: `chore/tooling-performance-sonnet-20260711`.
- Delegated worktree: `C:\Foo\rcw-tooling-<task-slug>-<agent-id>`.
- Delegated branch: `chore/tooling-<task-slug>-<agent-id>`.
- A Haiku worker may register deterministic scripts/tests only in `C:\Foo\rcw-tooling-test-registration-<agent-id>` on `test/tooling-test-registration-<agent-id>`.
- Start every worktree from pinned `<base-ref>`; never share worktrees.
- CI must fail on omission, missing artifact, no-op fuzz target, unapplied profile, or provenance mismatch.
- Performance claims require flipflop proof; CI duration improvements also need old/new workflow timing from comparable runs.

---

## Finding Evidence

| Find | Evidence | Opportunity |
|---:|---|---|
| 1 | `tools/run-workspaces.mjs:9-22,28-44`; `package.json:4-12` | Discover workspaces/dependencies; run independent tasks in bounded parallel order |
| 8 | `.github/workflows/verify.yml:16-24,29-91`; root/package test scripts | Run authoritative workspace and web gates on pull requests |
| 23 | `packages/jxl-wasm/scripts/build.mjs:178-202,295-310,544-586`; `test/build-script.test.ts:40-79` | Digest bridge, exports, flags, scripts, toolchain, libjxl revision/dirty state; reject stale tier merges |
| 24 | `crates/raw-pipeline/fuzz/Cargo.toml:10-16,26-29,81-108`; `fuzz_targets/casv_header.rs`, `casv_footer.rs`, `casv_audio_box.rs`, `jxtc_header.rs:6-14`; `.github/workflows/verify.yml:69-79,99-119,133-134` | Ensure codec fuzz targets reach real parsers and CI runs the feature-enabled binaries |
| 25 | `packages/jxl-wasm/scripts/build.mjs:125-154,193-202`; `scripts/build-pgo.mjs:62-80,109-182,649-660`; `package.json:19-21`; `test/pgo-corpus-benchmark.test.ts:1-40` | Generate, merge, apply, and verify profiles on the shipped tier |
| 28 | `packages/jxl-wasm/package.json:18-24`; `packages/jxl-wasm/test/pgo-corpus-benchmark.test.ts:4,28-40`; root runner | Register benchmark tests; fail when test-bearing workspace is omitted |
| 32 | `web/worker.js:31-36,62-73,182-210`; `build-parallel-wasm.ps1:35,164-208`; `tools/build-mt-wasm.sh:31-45`; `packages/jxl-wasm/test/stream-export-e2e.mjs:8-16,23-43` | Build/select single-thread RAW WASM when COI/SAB/threads unavailable |

## Target Contracts

```ts
export type WorkspaceTask = {
  name: string;
  directory: string;
  command: string;
  dependencies: string[];
};

export type BuildProvenance = {
  inputDigest: string;
  sourceCommit: string;
  sourceDirty: boolean;
  libjxlCommit: string;
  libjxlDirty: boolean;
  toolchain: Record<string, string>;
  role: "encode" | "decode" | "perceptual";
  tier: string;
  flags: string[];
  pgo?: { profileDigest: string; applied: boolean };
};
```

The root runner fails when a workspace declares a requested script but is not scheduled. A release build fails when source/libjxl is dirty unless an explicit non-release mode records that fact.

## Task Order

```text
1 authoritative workspace/test/benchmark runner
2 pull-request CI uses authoritative runner
3 build provenance and artifact verification
4 meaningful fuzz matrix
5 real PGO on shipped tier
6 portable single-thread RAW WASM
7 full tooling verification
```

### Task 1: Build The Authoritative Workspace And Benchmark Runner

**Findings:** 1, 28  
**Model/Effort:** Sonnet / L; Haiku may register isolated scripts after contract approval

**Files:**
- Modify: `tools/run-workspaces.mjs:9-44`
- Modify: `package.json:4-12`
- Modify: `packages/jxl-wasm/package.json:18-24`
- Create: `tools/run-workspaces.test.mjs`
- Modify: package scripts only where inventory shows a real test/build/typecheck target

**Interfaces:**
- Produces workspace discovery, dependency DAG, bounded concurrency, deterministic buffered logs, fail-fast scheduling, and complete task inventory.

- [ ] Write fixtures for dependency order, two independent workspaces running concurrently, failure preventing dependents, deterministic log order, missing script skip, and test-bearing workspace omission failure.
- [ ] Inventory all workspace `package.json` files and tests; assert every test-bearing workspace exposes a test command or documented runner adapter.
- [ ] Run `rtk proxy node --test tools/run-workspaces.test.mjs`; expected initial failures: hardcoded list, omission, serial execution.
- [ ] Parse root workspace patterns and package dependencies; topologically schedule up to an explicit concurrency bound.
- [ ] Buffer output per workspace and print in stable task order while retaining live concise status.
- [ ] Add benchmark-test registration as a distinct authoritative task; do not mix microbenchmark execution into ordinary unit tests unless bounded/deterministic.
- [ ] Run root build/test/typecheck and the new runner tests.
- [ ] If claiming faster CI/local execution, compare old/new representative runs with a command-mode flipflop test and predeclared wall-time threshold.
- [ ] Commit runner contract first; let Haiku register mechanical package scripts in a separate branch for integrator cherry-pick.

### Task 2: Make Pull-Request CI Call The Same Gates

**Finding:** 8  
**Model/Effort:** Sonnet / M

**Files:**
- Modify: `.github/workflows/verify.yml:16-24,29-134`
- Create or modify: `.github/actions/setup-repo/action.yml` only if repeated setup already warrants a composite action
- Create: `tools/verify-workflow.test.mjs`

**Interfaces:**
- Consumes Task 1 root commands.
- Produces PR jobs for workspace unit/type/build, web tests, benchmark smoke/registration, Rust safety/parity, and existing ABI gates.

- [ ] Write a static workflow test asserting each authoritative root command is present and no critical lane is path-filtered away from files it owns.
- [ ] Run workflow/static tests; expected initial result: workspace/web gaps.
- [ ] Add cache keys containing lockfile, toolchain, build-script, and relevant source hashes.
- [ ] Shard only independent authoritative commands; do not copy private test lists into YAML.
- [ ] Keep environment-blocked Emscripten tests explicit; never turn them into silent passes.
- [ ] Validate YAML and run the same commands locally.
- [ ] Commit as `ci: run authoritative workspace and web gates`.

### Task 3: Bind Distribution Artifacts To Complete Provenance

**Finding:** 23  
**Model/Effort:** Sonnet / M

**Files:**
- Modify: `packages/jxl-wasm/scripts/build.mjs:178-202,295-310,544-586`
- Modify: `packages/jxl-wasm/scripts/write-manifest.mjs`
- Modify: `packages/jxl-wasm/test/build-script.test.ts:40-79`
- Create: `packages/jxl-wasm/scripts/verify-dist.mjs`
- Create: `packages/jxl-wasm/test/dist-provenance.test.ts`

**Interfaces:**
- Produces `BuildProvenance`, artifact SHA-256/SRI, and a verifier invoked by release/CI.
- Partial-tier merge is legal only when the complete provenance key matches.

- [ ] Test that changing bridge source, exports, flags, build script, libjxl commit, dirty state, toolchain, role, tier, or PGO profile changes the input digest.
- [ ] Test stale partial tier, modified artifact, missing manifest field, and release dirty-source rejection.
- [ ] Run tests; expected initial result: incomplete provenance permits stale merge.
- [ ] Hash structured normalized inputs; never hash only generated output or a partial source list.
- [ ] Stamp each artifact and verify artifact hash/SRI plus provenance before package publication/use.
- [ ] Run build-script and provenance tests.
- [ ] Commit as `build(jxl): verify complete distribution provenance`.

### Task 4: Make Codec Fuzz Targets Reach Real Parsers

**Finding:** 24  
**Model/Effort:** Sonnet / L

**Files:**
- Modify: `crates/raw-pipeline/fuzz/Cargo.toml:10-16,26-29,81-108`
- Modify: `crates/raw-pipeline/fuzz/fuzz_targets/casv_header.rs`
- Modify: `crates/raw-pipeline/fuzz/fuzz_targets/casv_footer.rs`
- Modify: `crates/raw-pipeline/fuzz/fuzz_targets/casv_audio_box.rs`
- Modify: `crates/raw-pipeline/fuzz/fuzz_targets/jxtc_header.rs`
- Add seeds under: `crates/raw-pipeline/fuzz/corpus/<target>/`
- Modify: `.github/workflows/verify.yml:69-79,99-119,133-134`

**Interfaces:**
- Codec targets compile with `codec` and call the production parser. Pure targets remain libjxl-free.
- A smoke assertion proves a parser path executed; a no-op binary fails the job.

- [ ] Add valid minimal seeds, truncations, oversized lengths, overlapping offsets, overflow, and random prefixes for each target.
- [ ] Add a deterministic smoke mode/counter that proves the production parser entry was invoked.
- [ ] Run existing target builds; expected initial evidence: codec-disabled no-op branches.
- [ ] Split pure and codec feature matrices; provision libjxl only for codec jobs.
- [ ] Run `rtk proxy cargo +nightly fuzz build --manifest-path crates/raw-pipeline/fuzz/Cargo.toml --features codec` and bounded runs of all four targets.
- [ ] Make CI retain crash/repro artifacts and reject a no-op coverage result.
- [ ] Commit as `test(raw): run meaningful codec fuzz targets`.

### Task 5: Apply PGO To The Shipped Tier And Prove It

**Finding:** 25  
**Model/Effort:** Sonnet / L

**Files:**
- Modify: `packages/jxl-wasm/scripts/build.mjs:125-154,193-202`
- Modify: `packages/jxl-wasm/scripts/build-pgo.mjs:62-80,109-182,463-481,649-660,906-936`
- Modify: `packages/jxl-wasm/package.json:19-21`
- Modify: `packages/jxl-wasm/test/pgo-corpus-benchmark.test.ts:1-40`
- Create: `packages/jxl-wasm/test/pgo-applied.test.ts`
- Create: `.flipflop/tests/jxl-pgo-shipped-tier.mjs`

**Interfaces:**
- Consumes complete provenance.
- Produces generate/train/merge/use pipeline for an explicitly named shipped tier; `pgo.applied` becomes true only after profile-use compilation and verifier evidence.

- [ ] Add tests for actual `tierTag`, profile/source/toolchain/corpus digest match, missing profile rejection, and manifest applied flag.
- [ ] Run tests; expected initial evidence: profile staged but ordinary build used/wrong tier tagged.
- [ ] Invoke the complete PGO pipeline from production build, initially targeting the actual shipped relaxed-SIMD-MT tier only if supported.
- [ ] Verify the plain and PGO artifacts differ, compiler profile-use diagnostics are captured, and manifests name the exact applied tier/profile digest.
- [ ] Run browser interleaved plain/PGO flipflop over the standard corpus with byte/pixel/quality equality and predeclared gain.
- [ ] Keep PGO opt-in if the gain, trust, thermal, or quality gate fails. Never mark it applied on failure.
- [ ] Commit as `build(jxl): apply verified PGO to shipped tier` only with proof.

### Task 6: Ship A Single-Thread RAW WASM Fallback

**Finding:** 32  
**Model/Effort:** Sonnet / M

**Files:**
- Modify: `build-parallel-wasm.ps1:35,164-208`
- Modify: `tools/build-mt-wasm.sh:31-45`
- Modify: `web/worker.js:31-36,62-73,182-210`
- Modify: `web/pkg/build-manifest.json` via reproducible build tooling
- Use existing: `web/pkg-st/`
- Modify: `packages/jxl-wasm/test/stream-export-e2e.mjs:8-16,23-43`
- Create: `web/raw-wasm-tier-selection.test.js`

**Interfaces:**
- Produces one manifest-driven loader selecting MT only when threads/SAB/COI requirements hold, otherwise ST.
- Both artifacts come from one source/provenance revision and share the same wrapper contract.

- [ ] Add capability matrix tests and two browser-server integration lanes: isolated selects MT; non-isolated selects ST.
- [ ] Require fallback artifact presence; remove skip-on-missing behavior from authoritative tests.
- [ ] Run tests; expected initial result: static threaded import/non-COI failure.
- [ ] Build both artifacts from one command and stamp both with Task 3 provenance.
- [ ] Select before importing/instantiating; provide deterministic failure details if neither artifact is usable.
- [ ] Run ORF/DNG/CR2 pixel parity and isolated MT throughput regression checks.
- [ ] Use flipflopdom for MT baseline/candidate throughput and non-COI startup; ST availability is correctness, not a speed claim.
- [ ] Commit as `build(raw): ship single-thread wasm fallback`.

### Task 7: Tooling Integration Gate

**Findings:** 1, 8, 23-25, 28, 32  
**Model/Effort:** Sonnet / M

**Files:**
- Create: `docs/outputs/tooling/2026-07-11-tooling-verification.md`

- [ ] Run root authoritative build/test/typecheck/benchmark-smoke commands twice: clean cache and warm cache.
- [ ] Run workflow static validation and record a real PR workflow URL/result when available.
- [ ] Build/verify every distribution tier and both RAW WASM variants from recorded source/toolchain.
- [ ] Run bounded pure/codec fuzz jobs and prove parser invocation.
- [ ] Run PGO flipflop and retain accepted/rejected verdict with TOON timestamp.
- [ ] Record workspace inventory, timings, artifact/provenance hashes, fuzz target/corpus list, profile digest/tier, and browser capability lanes.
- [ ] Push named branches and hand them to integrator. Do not merge them.
