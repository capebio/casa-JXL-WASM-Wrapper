# Baselines, Test Authority, And SLO Implementation Plan

> **For agentic workers:** Execute task-by-task in isolated worktrees. Use one
> branch per worktree. Do not make performance claims without the required
> flipflop record.

**Goal:** Turn existing metrics, tests, and benchmark tools into a clean-clone
quality gate and an auditable performance baseline.

**Findings owned:** 1 measurement tail, 8/28 CI tails, 59 measurement tail,
104-108.  
**Lead quality:** Opus, because codec truth, memory policy, and SLO definitions
cross ownership boundaries.  
**Effort:** XL, split into reviewable tasks below.  
**Lead worktree:** `C:\Foo\rcw-baselines-slos-opus-20260711`  
**Lead branch:** `chore/baselines-slos-opus-20260711`

Each delegated agent receives its own listed worktree and branch. No agent shares
a checked-out worktree or changes another agent's branch.

## Finding Evidence

| Find | File and lines | Opportunity |
|---:|---|---|
| 104 | `tools/discover-node-tests.mjs:9-16,47-79,126-160`; `.github/workflows/verify.yml:166-267` | Replace recorded omissions with runner-specific Bun, Vitest, Playwright, and built-WASM gates. |
| 105 | `packages/jxl-session/test/integration.test.ts:19-80` | Run real-codec contracts for truncation, early frames, precision, metadata, latency, and scheduler behavior. |
| 106 | `docs/superpowers/plans/2026-06-18-flipflop.md`; no current tracked journal found at the audit base | Create an auditable current baseline index and retained TOON journal policy. |
| 107 | `packages/asset-store/src/index.js:227`; `packages/jxl-session/src/context-base.ts:114`; `web/main.js:1293-1295` | Replace conflicting 1.8 GiB/512 MiB defaults with one device-aware memory authority. |
| 108 | `packages/jxl-core/src/types.ts:323-351`; `packages/jxl-session/src/decode-session.ts:297-309`; integration tests above | Aggregate existing metrics into workflow SLO reports and release regressions. |

## Baseline Contract

Every recorded run must identify:

- Git base and candidate commit.
- OS, browser/runtime, CPU, logical cores, RAM, and device-memory class.
- Toolchain versions and WASM/native artifact digests.
- Fixture names, byte digests, dimensions, bit depth, source format, and output
  settings.
- Cold and warm rounds, start-order rotation, variance, thermal state, and trust.
- Exact equality for lossless output, or a declared quality threshold for lossy
  output.
- Journal timestamp and path.

Store generated samples outside Git when large. Commit the small TOON journal,
fixture digest list, command, and summary needed to reproduce the conclusion.

## Provisional Service Objectives

These are gates to formalize, not claims about current behavior.

| Area | Objective |
|---|---|
| Integrity | Zero silent catalog, manifest, pixel, metadata, or edit corruption in the supported compatibility matrix. |
| Cancellation | Every cancelled/deadline operation joins or terminates owned work, publishes no late result, and removes temporary state. |
| Quality gate | Fresh supported checkout installs, builds, typechecks, and runs authoritative tests without undocumented skips. |
| First preview | Record p50/p95 first; adopt a product target only after representative device/corpus data. The dormant 500 ms comment is not yet an SLO. |
| Final/export latency | Record p50/p95 by source format, megapixels, tier, and output mode; reject regressions outside the predeclared tolerance. |
| Memory | Stay within the selected device budget and show no statistically meaningful positive retained-memory slope after warmup. |
| Scheduler | Bound p95 queue wait by lane under the declared concurrent workload; visible work must not starve behind background work. |

## Task Order

```text
1 clean-clone failure manifest
2 authoritative runner lanes
3 deterministic real-codec corpus
4 current flipflop baseline
5 device-aware memory authority
6 SLO aggregation and release comparison
```

### Task 1: Pin Clean-Clone Failures

**Findings:** 101-105 evidence input  
**Agent:** Sonnet / M  
**Worktree:** `C:\Foo\rcw-baseline-clean-clone-sonnet-20260711`  
**Branch:** `test/baseline-clean-clone-sonnet-20260711`

- [ ] Add one scripted clean-checkout matrix for install, build, typecheck, and test.
- [ ] Distinguish required host dependencies, optional native addons, generated
  artifacts, fixtures, and network requirements.
- [ ] Fail on a new unclassified skip or known-failure entry.
- [ ] Record current failures as tests before fixing them; do not normalize red
  commands in documentation.

### Task 2: Make Runner-Specific CI Authoritative

**Findings:** 8, 28, 104  
**Agent:** Sonnet / L  
**Worktree:** `C:\Foo\rcw-ci-runner-matrix-sonnet-20260711`  
**Branch:** `ci/runner-matrix-sonnet-20260711`

- [ ] Add Bun test, Vitest/browser, Playwright, and built-WASM lanes with explicit
  fixture/artifact dependencies.
- [ ] Register `packages/jxl-wasm/test/pgo-corpus-benchmark.test.ts` deliberately.
- [ ] Keep discovery as an omission guard, not a substitute for executing suites.
- [ ] Prove each lane by introducing a deliberate failure and observing the root
  command and PR job fail.
- [ ] Delegate only deterministic path/registration edits to Haiku in
  `C:\Foo\rcw-ci-registration-haiku-20260711` on
  `test/ci-registration-haiku-20260711`.

### Task 3: Build A Deterministic Real-Codec Corpus

**Finding:** 105  
**Agent:** Opus / L  
**Worktree:** `C:\Foo\rcw-real-codec-corpus-opus-20260711`  
**Branch:** `test/real-codec-corpus-opus-20260711`

- [ ] Replace `NEEDS_CODEC` blanket skips with capability-scoped fixtures and a
  mandatory release lane.
- [ ] Cover truncated progressive input, rgba16, ICC, EXIF/XMP, first-byte and
  first-pixel behavior, priority promotion, and cancellation.
- [ ] Commit only small redistributable fixtures; generate larger fixtures from a
  pinned tool/artifact and verify their digest.
- [ ] Keep protected progressive tests mandatory around bridge changes.

### Task 4: Record Current Flipflop Baselines

**Finding:** 106 plus measurement tails 1 and 59  
**Agent:** Sonnet / L  
**Worktree:** `C:\Foo\rcw-current-performance-baseline-sonnet-20260711`  
**Branch:** `perf/current-baseline-sonnet-20260711`

Required vehicles:

| Surface | Test | Vehicle | Required metrics |
|---|---|---|---|
| Workspace DAG | `.flipflop/tests/workspace-dag.mjs` | `flipflop.mjs` | cold/warm wall time, peak child count, output equality |
| Decode-limit rejection | `.flipflop/tests/developed-image-limits.mjs` | `flipflopMem.mjs` | rejection latency, peak RSS/WASM pages, no allocation beyond limit |
| JXL first preview/final | `.flipflop/dom-tests/jxl-first-preview.mjs` | `flipflopdom.mjs` | first paint, final paint, bytes consumed, output equality |
| Pyramid viewport | `.flipflop/dom-tests/pyramid-pan-zoom.mjs` | `flipflopdom.mjs` | first useful tile, frame misses, fetch bytes, visual equality |
| Ingest/export | `.flipflop/tests/ingest-export.mjs` | `flipflop.mjs` and `flipflopMem.mjs` | throughput, peak/retained memory, artifact digest/quality |

- [ ] Use interleaved start-rotated rounds against the pinned base.
- [ ] Mark untrusted results inconclusive; do not turn them into roadmap claims.
- [ ] Commit a small journal index containing the command, environment, fixture
  digests, result, and retained TOON path.

### Task 5: Unify Device-Aware Memory Admission

**Finding:** 107  
**Agent:** Opus / XL  
**Worktree:** `C:\Foo\rcw-memory-authority-opus-20260711`  
**Branch:** `perf/memory-authority-opus-20260711`

- [ ] Define one budget authority for JS heap, retained assets, WASM pages, worker
  copies, output buffers, and safety margin.
- [ ] Select conservative profiles for unknown/mobile/desktop/high-memory devices.
- [ ] Make session, asset store, RAW governor, pyramid pools, and exports reserve and
  release through that authority.
- [ ] Test admission, cancellation, eviction, worker failure, tab backgrounding,
  and repeated open/close cycles.
- [ ] Use `flipflopMem.mjs .flipflop/tests/device-memory-policy.mjs`; require output
  parity, budget compliance, and no positive long-session growth. Speed alone does
  not pass this task.

### Task 6: Aggregate Metrics Into Release SLO Reports

**Finding:** 108  
**Agent:** Opus / L  
**Worktree:** `C:\Foo\rcw-slo-aggregation-opus-20260711`  
**Branch:** `feat/slo-aggregation-opus-20260711`

- [ ] Define one versioned metric envelope with workflow, format, size, tier,
  session/correlation ID, stage, value, unit, and artifact build ID.
- [ ] Aggregate p50/p95, failure rate, cancellation latency, queue wait, and memory
  high-water marks without collecting source paths or image metadata.
- [ ] Compare candidate to a pinned release baseline and render machine-readable
  plus human-readable reports.
- [ ] Predeclare regression tolerances per metric. Do not use the generic 5% speed
  threshold where a stricter correctness or product objective applies.

## Completion Gate

- [ ] Root clean-clone matrix passes on supported Windows and Linux configurations.
- [ ] Every discovered test is executed by an authoritative runner or has a
  time-bounded, owner-assigned exception.
- [ ] Real codec contracts run in at least one mandatory lane.
- [ ] Current flipflop journal and fixture digest index are retained.
- [ ] Memory policy passes long-session `flipflopMem` proof.
- [ ] Release report can compare the candidate to the last accepted baseline.

