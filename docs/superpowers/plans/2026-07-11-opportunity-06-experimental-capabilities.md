# Experimental Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate progressive confidence stopping and complete the CASV Fable browser path without putting unproven algorithms, unbounded memory, or full-file delivery into the default product.

**Architecture:** Experiments live behind explicit runtime flags and emit comparable telemetry. CASV gains a byte-source abstraction, bounded GOP/frame cache, then FableDelta decode wiring. Progressive AI is trained/evaluated offline and fails open to the deterministic policy. Promotion requires correctness, quality, memory, and flipflop proof.

**Tech Stack:** JavaScript/TypeScript, Rust/WASM, CASV/FableDelta, HTTP Range/Blob slicing, browser workers, offline model evaluation, flipflop tooling.

## Global Constraints

- Master program: `docs/superpowers/plans/2026-07-11-codebase-opportunity-roadmap.md`.
- Findings owned here: 27, 36-38.
- Lead model quality: Fable. Program effort: XL.
- Lead worktree: `C:\Foo\rcw-experimental-capabilities-fable-20260711`.
- Lead branch: `experiment/capabilities-fable-20260711`.
- Delegated worktree: `C:\Foo\rcw-experiment-<task-slug>-<agent-id>`.
- Delegated branch: `experiment/<task-slug>-<agent-id>`.
- Keep the Fable lead for the whole document once context is loaded. Haiku/Sonnet may only build independent fixtures or deterministic harness adapters in separate worktrees.
- The Claude model-quality label `Fable` is distinct from the codebase's FableDelta codec name.
- Experiments default off. Failure or low confidence falls back to current deterministic/full-quality behavior.
- No default promotion without the master flipflop gate, quality thresholds, bounded memory, and owner approval.
- Preserve protected progressive decode checkpoints and run their tests before/after progressive-path edits.

---

## Finding Evidence

| Find | Evidence | Opportunity |
|---:|---|---|
| 27 | `web/jxl-progressive-frame-stats.js:1-175`; `web/jxl-single-progressive.js:254-321,894-955`; `packages/pyramid-ingest/src/backends.ts:266-402` | Predict useful progressive stopping from existing frame stats, saliency, bytes, dimensions, and confidence |
| 36 | `packages/casv-web/src/index.ts:137-196,297-320,348-458`; stale `dist/index.js:8,220`; `src/lib.rs:5531-5604`; `web/casv-lightbox/casv-lightbox.js:189,237-281`; `casv-platform.js:69-99` | Rebuild dist and wire FableDelta source/session into the browser UI |
| 37 | `web/casv-lightbox/casv-lightbox.js:237-281`; `packages/casv-web/src/index.ts:297-320,348-458` | Replace all-frame decoded RGBA retention with bounded GOP/LRU and I-frame replay |
| 38 | `packages/casv-web/src/index.ts:192-286,353-418`; `web/casv-lightbox/casv-lightbox.js:189,239-251`; `web/casv-lightbox/casv-lightbox.html:56` | Read header/index first and fetch frame/audio ranges lazily |

## Experiment Promotion Contract

Every experiment produces a record with:

```ts
export type ExperimentVerdict = {
  name: string;
  baselineCommit: string;
  candidateCommit: string;
  fixtureDigest: string;
  enabledBy: string;
  correctness: "pass" | "fail";
  quality: { metric: string; threshold: number; worst: number }[];
  performance: { journalTimestamp: string; trust: "high" | "low" };
  memory: { budgetBytes: number; peakBytes: number; slopeBytesPerMinute: number };
  promoted: boolean;
  reason: string;
};
```

Promotion means: default-on product code, docs, CI, and compatibility commitment. A useful but unpromoted prototype remains behind its flag and must not be described as shipped.

## Task Order

```text
1 experiment harness and flags
2 CASV byte source/range delivery
3 bounded GOP/frame cache and seeking
4 FableDelta source/dist/UI closure
5 progressive confidence model experiment          parallel after 1
6 promotion review and integration gate             last
```

### Task 1: Pin Flags, Telemetry, Fixtures, And Promotion Gates

**Findings:** 27, 36-38  
**Model/Effort:** Fable / M

**Files:**
- Create: `packages/casv-web/test/fixtures/experiment-manifest.json`
- Create: `web/experiments/registry.js`
- Create: `web/experiments/registry.test.js`
- Create: `docs/outputs/experiments/README.md`
- Extend existing real CASV/JXL fixture manifests without copying large assets

**Interfaces:**
- Produces named flags, telemetry schema, frozen fixture digests, baseline commits, and promotion thresholds.

- [ ] Add tests proving every experiment defaults off, unknown flags reject, telemetry records baseline/candidate/fixture, and runtime failure activates deterministic fallback.
- [ ] Record representative small/large/long CASV and progressive JXL fixtures plus corruption/truncation cases.
- [ ] Predeclare CASV budgets: transferred bytes, time-to-first-frame, seek latency, decoded-frame count, and memory ceiling.
- [ ] Predeclare progressive thresholds: usable-paint metric, final quality, false-stop ceiling, bytes/time saved, model bytes, and startup cost.
- [ ] Run registry tests; expected initial result: no common experiment/promotion contract.
- [ ] Implement only the registry/telemetry plumbing; no algorithm yet.
- [ ] Commit as `test(experiments): pin capability promotion gates`.

### Task 2: Add A Range-Backed CASV Byte Source

**Finding:** 38  
**Model/Effort:** Fable / XL

**Files:**
- Modify: `packages/casv-web/src/index.ts:192-286,353-418`
- Create: `packages/casv-web/src/source.ts`
- Create: `packages/casv-web/test/source.test.ts`
- Modify: `web/casv-lightbox/casv-lightbox.js:189,239-251`
- Modify: `web/casv-lightbox/casv-lightbox.html:56`

**Interfaces:**

```ts
export interface CasvSource {
  size(signal?: AbortSignal): Promise<number>;
  read(start: number, endExclusive: number, signal?: AbortSignal): Promise<Uint8Array>;
}
```

Implementations: HTTP Range with validated `206`/Content-Range, local `Blob.slice`, immutable in-memory fallback.

- [ ] Test valid range, server ignoring Range, shifted/malformed Content-Range, truncation, oversized index, cancellation, redirect policy, and local File/Blob.
- [ ] Assert reader fetches only header/footer/index before first selected frame payload.
- [ ] Run tests; expected initial evidence: constructor requires whole file.
- [ ] Refactor parser/reader to checked offset reads through `CasvSource`; retain whole-buffer adapter for compatibility.
- [ ] Validate all offsets/lengths before payload fetch and cap response bytes while streaming.
- [ ] Wire lightbox open through source rather than `arrayBuffer()`.
- [ ] Run CASV core/platform/lightbox tests.
- [ ] Use flipflopdom/flipflopMem for large-file time-to-first-frame, transferred bytes, cancel latency, and peak memory.
- [ ] Commit as `experiment(casv): stream ranges from byte source`.

### Task 3: Bound Decoded Frames And Seek From I-Frames

**Finding:** 37  
**Model/Effort:** Fable / L

**Files:**
- Create: `packages/casv-web/src/frame-cache.ts`
- Create: `packages/casv-web/test/frame-cache.test.ts`
- Modify: `packages/casv-web/src/index.ts:297-320,348-458`
- Modify: `web/casv-lightbox/casv-lightbox.js:237-281`

**Interfaces:**
- Consumes `CasvSource`.
- Produces byte-budgeted decoded-frame LRU/GOP cache and `seek(frameIndex, signal)` replaying from nearest keyframe.

- [ ] Test sequential play, reverse/random seek, repeated nearby seek, cache eviction, one-frame-over-budget handling, cancellation mid-replay, corrupted delta, and long video.
- [ ] Assert cache bytes never exceed budget except one explicitly permitted active-frame oversize and returns to budget after release.
- [ ] Run tests; expected initial evidence: every RGBA frame remains retained.
- [ ] Store keyframe/index metadata separately from decoded pixels; retain only budgeted decoded frames/GOP state.
- [ ] Replay deltas from nearest I-frame when target is absent; coalesce concurrent identical seeks.
- [ ] Run CASV core/lightbox/random-seek/audio tests.
- [ ] Use flipflop/flipflopMem for sequential play, random seek latency, decode count, peak heap, and long-session slope.
- [ ] Commit as `experiment(casv): bound frame cache and seek replay`.

### Task 4: Close The FableDelta Source-To-Dist-To-UI Loop

**Finding:** 36  
**Model/Effort:** Fable / XL

**Files:**
- Modify: `packages/casv-web/src/index.ts:137-196,297-320,348-458`
- Rebuild from source: `packages/casv-web/dist/index.js`
- Modify: `src/lib.rs:5531-5604`
- Modify: `web/casv-lightbox/casv-lightbox.js:189,237-281`
- Modify: `web/casv-lightbox/casv-platform.js:69-99`
- Create: `packages/casv-web/test/fable-browser.test.ts`

**Interfaces:**
- Consumes range source and bounded frame cache.
- Produces browser FableDelta session with deterministic feature detection/fallback.

- [ ] Add source-vs-dist export parity and provenance tests; stale dist must fail CI.
- [ ] Add real browser Fable fixture playback, delta/keyframe, random seek, audio sync, cancel, corruption, and fallback tests.
- [ ] Run tests; expected initial result: source may decode while dist/UI selects native-only path.
- [ ] Wire FableDelta session through platform detection and shared reader/cache; keep native decoder as explicit fallback, not silent substitution.
- [ ] Rebuild dist reproducibly and verify source/artifact digest using packet 5 provenance.
- [ ] Run Rust, casv-web, platform, and lightbox suites.
- [ ] Compare Fable/native paths with flipflop for decode/seek and flipflopMem for long playback; include pixel/quality equivalence.
- [ ] Commit as `experiment(casv): wire FableDelta browser playback`.

### Task 5: Evaluate Confidence-Gated Progressive Stopping

**Finding:** 27  
**Model/Effort:** Fable / XL

**Files:**
- Modify: `web/jxl-progressive-frame-stats.js:1-175`
- Create: `web/progressive-stop-policy.js`
- Create: `web/progressive-stop-policy.test.js`
- Create: `tools/train-progressive-stop-model.mjs`
- Create: `benchmark/progressive-stop-evaluate.mjs`
- Modify behind flag only: `web/jxl-single-progressive.js:254-321,894-955`
- Consume profiling output: `packages/pyramid-ingest/src/backends.ts:266-402`

**Interfaces:**

```ts
export type ProgressiveStopDecision = {
  stop: boolean;
  confidence: number;
  reason: "model" | "heuristic" | "final" | "fallback";
};
```

The model may consume only information available at the decision point. Low confidence, missing model, invalid features, or distribution warning returns deterministic fallback/continue.

- [ ] Freeze train/validation/holdout asset IDs before feature/model selection; prevent burst/near-duplicate leakage across splits.
- [ ] Define usable-paint labels from existing quality/profiling data and record final-quality reference.
- [ ] Add policy tests for invalid/missing features, confidence calibration, low-confidence fallback, never-stop-after-final, and model version mismatch.
- [ ] Run protected progressive tests before editing Single Progressive.
- [ ] Train simple baselines first (threshold/logistic/small tree); compare against current deterministic cutoff. Avoid a heavier model unless holdout proof requires it.
- [ ] Evaluate holdout false-stop rate, calibration, bytes/time to usable paint, final quality, model size, parse/eval/startup cost, and camera/content strata.
- [ ] Wire only behind the experiment flag; preserve chunk feeding/yields and opportunistic checkpoint behavior.
- [ ] Run protected progressive tests after edits and all policy/page tests.
- [ ] Use flipflopdom for bytes/time-to-usable-paint and startup. Quality hook must enforce the predeclared false-stop/quality ceilings.
- [ ] Commit model, evaluator, and flagged product hook as separate experimental commits.

### Task 6: Promotion Review And Integration Gate

**Findings:** 27, 36-38  
**Model/Effort:** Fable / M

**Files:**
- Create: `docs/outputs/experiments/2026-07-11-capability-verdicts.md`
- Update experiment registry defaults only after approval

- [ ] Re-run all correctness, corruption, cancellation, quality, memory, and flipflop gates from pinned baseline/candidate commits.
- [ ] Produce one `ExperimentVerdict` per CASV range/cache/Fable path and progressive stopping model.
- [ ] Mark each `promoted`, `retained-off`, or `rejected`; include exact reason and TOON journal timestamps.
- [ ] Do not combine promotion with unrelated cleanup. Default flips get their own reviewable commit after owner approval.
- [ ] Push named experiment branch and hand it to integrator. Do not merge it.
