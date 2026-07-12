# Decode Throughput Lateral Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce end-to-end browser JXL and RAW decode wall time and improve sustained throughput without changing observable decode results.

**Architecture:** Treat each optimization as a separate measured experiment. Start at system seams: align libjxl runner width with Emscripten pool and scheduler core cost, remove unobservable BOX events from facade decodes, then test bounded RAW strip demosaic-plus-tone against the whole-frame path. Keep only candidates that pass build, behavior, byte-parity, fresh-page flipflop, and combined-set gates.

**Tech Stack:** C++17, libjxl 0.11.x decoder API, Emscripten pthreads/WASM SIMD, TypeScript 5.5, Bun tests, Rust/wasm-bindgen, Rayon, Playwright Chromium, repository `flipflop.mjs`.

## Global Constraints

- Work only in `C:\Foo\raw-converter-wasm\.worktrees\grok-decode-throughput-lateral-2` on branch `grok/decode-throughput-lateral-2`.
- Base is local `main` at `b8bfc5c2`; do not merge, push, or remove the worktree.
- Prefix every shell command with `rtk`; use `rtk proxy` when raw output is needed.
- Run Scannerbot prior-art refusal before implementing each performance hypothesis.
- Require at least 10 interleaved samples, rotated start order, median, IQR, and `trust: high`.
- Require at least 5% relevant-stage improvement and no end-to-end wall-time regression.
- Integer-stable candidates require `max_abs_diff=0`, `px_differ_count=0`, equal dimensions, and equal requested metadata.
- Revert every failed candidate; record measured rejection instead of banking speculative code.
- Before any `packages/jxl-wasm/src/bridge.cpp` edit, run both protected progressive tests from project instructions.
- Preserve `opportunistic_flush_generation != input_generation` and one opportunistic flush attempt per `input_generation` after frame start.
- Do not add progressive frame hashes/checksums except behind an explicit runtime experiment flag.
- Keep diagnostic/throttled Single Progressive chunk-fed and yielding.
- Scheduler owns admission, core budgeting, backpressure, and preemption; worker handler owns worker queue drain, budget enforcement, and cleanup.
- No output pixel-buffer pool and no borrowed WASM view without an explicit consumer release protocol.
- PGO is optional, last, and rejected unless it independently clears the same 5% browser gate.

---

### Task 1: Establish Reproducible Baselines and Ledger

**Files:**
- Create: `docs/ScannerBot-12-07-26-Decode-Throughput-Lateral.md`
- Create: `.flipflop/tests/jxl-decode-e2e-browser.mjs`
- Modify: none
- Test: existing protected progressive and package suites

**Interfaces:**
- Consumes: shipped `packages/jxl-wasm/dist` artifacts at `b8bfc5c2`, existing JXL/RAW corpus files, `flipflop.mjs`.
- Produces: browser harness CLI supporting `--artifact`, `--mode`, and `--concurrency`; baseline commands below pin concrete values used by every later task.

- [ ] **Step 1: Verify isolated branch and install workspace dependencies**

Run:

```powershell
rtk proxy git status --short --branch
rtk bun install
```

Expected: branch is `grok/decode-throughput-lateral-2`; install exits 0 without modifying tracked lockfiles.

- [ ] **Step 2: Run protected progressive baselines before any bridge edit**

Run:

```powershell
rtk proxy bun test packages/jxl-wasm/test/progressive-visible-passes.test.ts
rtk proxy bun test web/jxl-single-progressive-page.test.js
```

Expected: both exit 0. If either fails because a tracked fixture is absent on `main`, record exact error in ledger and prove failure exists at `b8bfc5c2` before continuing.

- [ ] **Step 3: Run untouched behavioral baselines**

Run:

```powershell
rtk proxy bun test packages/jxl-worker-browser/test/handlers.test.ts
rtk proxy bun test packages/jxl-worker-browser/test/decoder-lifecycle.test.ts
rtk proxy bun test packages/jxl-wasm/test/facade.test.ts
rtk proxy bun test packages/jxl-wasm/test/progressive-detail.test.ts
rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml --no-default-features --lib
```

Expected: all runnable suites exit 0; any pre-existing failure is recorded with command, test name, and base-commit reproduction.

- [ ] **Step 4: Write end-to-end browser harness first**

Implement `.flipflop/tests/jxl-decode-e2e-browser.mjs` with these exact result fields:

```js
window.__decodeResult = {
  ok: true,
  mode,
  concurrency,
  samplesMs,
  medianMs: median(samplesMs),
  iqrMs: percentile(samplesMs, 0.75) - percentile(samplesMs, 0.25),
  throughputMpixPerSec,
  width,
  height,
  byteHash: hashBytes(finalPixels),
  pxDifferCount: 0,
  maxAbsDiff: 0,
};
```

Serve artifacts with COOP/COEP headers, create a fresh browser context per arm, close each context after samples, and hard-timeout at five minutes. Final mode uses `progressionTarget: "final"`, `emitEveryPass: false`; passes mode chunk-feeds and awaits `sleep(0)` between pushes.

- [ ] **Step 5: Prove harness parity and collect baseline**

Run:

```powershell
rtk proxy node .flipflop/tests/jxl-decode-e2e-browser.mjs --artifact packages/jxl-wasm/dist --mode final --concurrency 1
rtk proxy node .flipflop/tests/jxl-decode-e2e-browser.mjs --artifact packages/jxl-wasm/dist --mode passes --concurrency 1
rtk proxy node .flipflop/tests/jxl-decode-e2e-browser.mjs --artifact packages/jxl-wasm/dist --mode final --concurrency 4
rtk proxy node tools/decode-mt-bench.mjs --reps 10
```

Expected: each browser run reports `pxDifferCount=0`, stable hashes within mode, `n>=10`, median/IQR, and high trust; RAW benchmark reports equal output checksum.

- [ ] **Step 6: Write and commit baseline ledger**

Ledger records hardware, browser version, artifact SHA, corpus path/hash, each stage fraction, median/IQR, trust, and command. Commit only harness and ledger:

```powershell
rtk proxy git add -- .flipflop/tests/jxl-decode-e2e-browser.mjs docs/ScannerBot-12-07-26-Decode-Throughput-Lateral.md
rtk proxy git commit -m "bench(decode): establish browser throughput baselines"
```

---

### Task 2: Align Decoder Runner Width and Scheduler Cost

**Files:**
- Create: `packages/jxl-wasm/test/decoder-runner-contract.test.ts`
- Create: `.flipflop/tests/jxl-decoder-runner-width.mjs`
- Modify: `packages/jxl-wasm/scripts/build.mjs:302`
- Modify: `packages/jxl-wasm/src/bridge.cpp:243`
- Modify only if four-worker runner wins: `packages/jxl-session/src/context-base.ts:97`
- Create only if scheduler cost changes: `packages/jxl-session/test/context-worker-cost.test.ts`

**Interfaces:**
- Consumes: environment variable `JXL_WASM_DEC_RUNNER_WORKERS` during artifact construction.
- Produces: compile definition `JXL_WASM_DEC_RUNNER_WORKERS=<0|1|2|4>`; `0` retains libjxl default. If `4` wins, MT scheduler worker cost becomes `min(defaultCoreBudgetCapacity(), 4)`.

- [ ] **Step 1: Run prior-art refusal**

Run:

```powershell
rtk proxy node C:\Users\User\.agents\skills\scannerbot\scripts\prior-art.mjs "align libjxl decoder runner width with four-worker Emscripten pool" packages/jxl-wasm/src/bridge.cpp
```

Expected: exit 0, or exit 3 followed by manual cited-block comparison proving this differs from already-shipped runner singleton reuse. Exit 2 rejects task.

- [ ] **Step 2: Write failing runner/build contract test**

Create `decoder-runner-contract.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const bridge = readFileSync(new URL("../src/bridge.cpp", import.meta.url), "utf8");
const build = readFileSync(new URL("../scripts/build.mjs", import.meta.url), "utf8");

test("decoder runner width is an explicit build contract", () => {
  expect(build).toContain("JXL_WASM_DEC_RUNNER_WORKERS");
  expect(build).toContain("-DJXL_WASM_DEC_RUNNER_WORKERS=");
  expect(bridge).toContain("DecoderRunnerWorkerCount");
  expect(bridge).toContain("JXL_WASM_DEC_RUNNER_WORKERS");
});
```

- [ ] **Step 3: Run test and verify RED**

Run:

```powershell
rtk proxy bun test packages/jxl-wasm/test/decoder-runner-contract.test.ts
```

Expected: FAIL because explicit runner build contract does not exist.

- [ ] **Step 4: Add minimal compile-time experiment control**

In `build.mjs`, parse only `0`, `1`, `2`, or `4`, default decoder MT builds to `4`, and append:

```js
const decoderRunnerWorkers = process.env.JXL_WASM_DEC_RUNNER_WORKERS ?? "4";
if (!new Set(["0", "1", "2", "4"]).has(decoderRunnerWorkers)) {
  throw new Error(`JXL_WASM_DEC_RUNNER_WORKERS must be 0, 1, 2, or 4; got ${decoderRunnerWorkers}`);
}
// In decoder MT tierFlags only:
`-DJXL_WASM_DEC_RUNNER_WORKERS=${decoderRunnerWorkers}`
```

In `bridge.cpp`:

```cpp
#ifndef JXL_WASM_DEC_RUNNER_WORKERS
#define JXL_WASM_DEC_RUNNER_WORKERS 0
#endif

static size_t DecoderRunnerWorkerCount() {
#if JXL_WASM_DEC_RUNNER_WORKERS > 0
  return static_cast<size_t>(JXL_WASM_DEC_RUNNER_WORKERS);
#else
  return JxlThreadParallelRunnerDefaultNumWorkerThreads();
#endif
}
```

Use `DecoderRunnerWorkerCount()` only for `JxlThreadParallelRunnerCreate`; encoder behavior stays unchanged. Correct stale pool comments.

- [ ] **Step 5: Run test and verify GREEN**

Run:

```powershell
rtk proxy bun test packages/jxl-wasm/test/decoder-runner-contract.test.ts
rtk proxy bun test packages/jxl-wasm/test/progressive-visible-passes.test.ts
rtk proxy bun test web/jxl-single-progressive-page.test.js
```

Expected: all exit 0.

- [ ] **Step 6: Build controlled artifacts**

For worker counts `0`, `1`, `2`, and `4`, run host-toolchain decoder MT build, then copy that run's `jxl-core.dec.simd-mt.{js,wasm}` to `C:\Tmp\jxl-dec-runner-0`, `C:\Tmp\jxl-dec-runner-1`, `C:\Tmp\jxl-dec-runner-2`, or `C:\Tmp\jxl-dec-runner-4`. Exact build sequence for each count:

```powershell
$env:JXL_WASM_ONLY_KIND='dec'
$env:JXL_WASM_DEC_RUNNER_WORKERS='4'
rtk proxy node packages/jxl-wasm/scripts/build.mjs --host-toolchain --include-mt --only-mt
```

Expected: each build exits 0 and artifacts differ only by intended runner-width code/configuration.

- [ ] **Step 7: Flipflop runner variants**

Implement `.flipflop/tests/jxl-decoder-runner-width.mjs` as fresh-context round-robin `0 -> 1 -> 2 -> 4`, then reverse order. Run at concurrency 1 and 4, `n>=10` each. Require identical final bytes and dimensions.

Run:

```powershell
rtk proxy node .flipflop/tests/jxl-decoder-runner-width.mjs --concurrency 1
rtk proxy node .flipflop/tests/jxl-decoder-runner-width.mjs --concurrency 4
```

Expected: ranked table with median/IQR, trust, output hashes, local delta, and end-to-end delta.

- [ ] **Step 8: Align scheduler cost only when runner width 4 wins**

First add `packages/jxl-session/test/context-worker-cost.test.ts` with a failing test asserting an MT URL costs four tokens when capacity is at least four:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWorkerCostForWasmUrl } from '../src/context-base.js';

test('decoder MT tier declares four-core worker cost', () => {
  assert.equal(
    computeWorkerCostForWasmUrl('/worker.js?jxlWorkerTier=simd-mt'),
    Math.min(4, globalThis.navigator?.hardwareConcurrency ?? 4),
  );
});
```

Run it once and require RED against hardware-wide current cost. Then change:

```ts
const DECODER_MT_WORKER_COST = 4;

export function computeWorkerCostForWasmUrl(url: string | undefined): number {
  if (!url) return 1;
  try {
    const tier = new URL(url, "https://dummy.invalid").searchParams.get("jxlWorkerTier");
    if (tier === "relaxed-simd-mt" || tier === "simd-mt") {
      return Math.min(defaultCoreBudgetCapacity(), DECODER_MT_WORKER_COST);
    }
  } catch {}
  return 1;
}
```

Run scheduler/session suites, then rerun concurrency-4 browser throughput. Reject scheduler change if throughput gain is below 5%, memory admission regresses, or single decode slows.

- [ ] **Step 9: Commit winner or revert candidate**

If accepted:

```powershell
rtk proxy git add -- packages/jxl-wasm/src/bridge.cpp packages/jxl-wasm/scripts/build.mjs packages/jxl-wasm/test/decoder-runner-contract.test.ts .flipflop/tests/jxl-decoder-runner-width.mjs packages/jxl-session/src/context-base.ts packages/jxl-session/test/context-worker-cost.test.ts docs/ScannerBot-12-07-26-Decode-Throughput-Lateral.md
rtk proxy git commit -m "perf(decode): align MT runner and scheduler core cost"
```

If rejected, restore candidate production/test files to task-start blobs, retain only reusable benchmark harness plus rejection ledger, and commit `bench(decode): record runner-width rejection`.

---

### Task 3: Remove Unobservable BOX Events from Facade Decodes

**Files:**
- Modify: `packages/jxl-wasm/test/progressive-detail.test.ts`
- Modify: `packages/jxl-wasm/src/facade.ts:7`
- Modify: `packages/jxl-wasm/src/bridge.cpp:2352`
- Modify: `packages/jxl-wasm/dist/facade.js` through TypeScript build only if accepted
- Create: `.flipflop/tests/jxl-box-events.mjs`

**Interfaces:**
- Consumes: `_jxl_wasm_dec_create_x(format, progressiveDetail, flags)`.
- Produces: private flag `DEC_FLAG_SKIP_BOX_EVENTS = 4`; direct bridge callers and legacy create functions retain current BOX behavior, while facade decodes opt out because facade exposes no box/gain-map result.

- [ ] **Step 1: Run prior-art refusal and protected tests**

Run:

```powershell
rtk proxy node C:\Users\User\.agents\skills\scannerbot\scripts\prior-art.mjs "skip JXL_DEC_BOX subscription when facade cannot expose box results" packages/jxl-wasm/src/bridge.cpp
rtk proxy bun test packages/jxl-wasm/test/progressive-visible-passes.test.ts
rtk proxy bun test web/jxl-single-progressive-page.test.js
```

Expected: prior art permits experiment; protected tests exit 0.

- [ ] **Step 2: Write failing source and behavior contracts**

Add test assertions:

```ts
test("facade opts out of unobservable decoder box events", () => {
  expect(facade).toContain("DEC_FLAG_SKIP_BOX_EVENTS = 4");
  expect(facade).toContain("| DEC_FLAG_SKIP_BOX_EVENTS");
  expect(bridge).toContain("(flags & 4u) == 0");
  expect(bridge).toContain("events |= JXL_DEC_BOX");
});
```

Also extend fake-module create-x test to capture flags and expect bit 4 for facade-created decoders.

- [ ] **Step 3: Run and verify RED**

Run `rtk proxy bun test packages/jxl-wasm/test/progressive-detail.test.ts`.

Expected: FAIL because bit 4 and conditional BOX subscription are absent.

- [ ] **Step 4: Implement minimal opt-out**

In facade:

```ts
const DEC_FLAG_SKIP_BOX_EVENTS = 4;
const decFlags = (this.options.suppressDuplicateProgress ? DEC_FLAG_SUPPRESS_DUPLICATE_PROGRESS : 0)
  | (this.options.allowAlphaProgressive ? DEC_FLAG_ALLOW_ALPHA_PROGRESSIVE : 0)
  | DEC_FLAG_SKIP_BOX_EVENTS;
```

In bridge:

```cpp
int events = JXL_DEC_BASIC_INFO | JXL_DEC_FRAME | JXL_DEC_FULL_IMAGE;
if ((flags & 4u) == 0) events |= JXL_DEC_BOX;
if (progressive_detail != 0) events |= JXL_DEC_FRAME_PROGRESSION;
```

- [ ] **Step 5: Build, test, parity, and flipflop**

Run TypeScript build, host-toolchain decoder build, protected tests, facade tests, and the browser harness over plain codestream, normal container, metadata-heavy container, and gain-map container. The facade result must remain identical because it exposed no boxes before.

Run `.flipflop/tests/jxl-box-events.mjs` with at least 10 interleaved samples. Reject if normal representative corpus gain is below 5%, even if a synthetic box-heavy file wins.

- [ ] **Step 6: Commit winner or measured rejection**

Accepted commit message: `perf(decode): skip unobservable container box events`. Rejection commit contains only harness and ledger; all production/test changes are reverted.

---

### Task 4: Elide Full-Frame RAW RGB16 Materialization

**Files:**
- Modify: `crates/raw-pipeline/src/stream_band.rs:435`
- Modify: `crates/raw-pipeline/src/stream_band.rs` unit tests near `streaming_source_matches_whole`
- Create: `crates/raw-pipeline/examples/mosaic_strip_tone_flip.rs`
- Modify only after measured win: `src/lib.rs:1609`

**Interfaces:**
- Produces: `pub fn demosaic_tone_mosaic_strips(raw: &[u16], w: usize, h: usize, params: &PipelineParams, phase: (u8, u8), out_rgb8: &mut [u8]) -> Result<(), String>`.
- Consumes: existing byte-exact `demosaic_bayer_mhc_band` and `pipeline::process_into_auto`.

- [ ] **Step 1: Run prior-art refusal**

Run:

```powershell
rtk proxy node C:\Users\User\.agents\skills\scannerbot\scripts\prior-art.mjs "process decoded mosaic in bounded MHC plus tone strips without full RGB16" src/lib.rs
```

Expected: distinguish this from existing compressed-row pipelining and rejected closure-factoring. Exit 2 rejects task.

- [ ] **Step 2: Write failing byte-parity tests**

Add tests covering dimensions across strip boundaries and odd tails:

```rust
#[test]
fn mosaic_strips_match_whole_mhc_tone() {
    for (w, h) in [(17, 19), (257, 131), (640, 259)] {
        let raw: Vec<u16> = (0..w * h)
            .map(|i| (i.wrapping_mul(2654435761) & 0x3fff) as u16)
            .collect();
        let params = PipelineParams::default_olympus();
        let rgb16 = demosaic::demosaic_rggb_mhc(&raw, w, h).unwrap();
        let mut expected = vec![0; w * h * 3];
        pipeline::process_into_auto(&rgb16, &params, &mut expected);
        let mut actual = vec![0; expected.len()];
        demosaic_tone_mosaic_strips(&raw, w, h, &params, (0, 0), &mut actual).unwrap();
        assert_eq!(actual, expected, "{w}x{h}");
    }
}
```

- [ ] **Step 3: Run and verify RED**

Run:

```powershell
rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml --no-default-features mosaic_strips_match_whole_mhc_tone
```

Expected: compile failure because `demosaic_tone_mosaic_strips` is absent.

- [ ] **Step 4: Implement minimal strip path**

Validate exact output length. For each even-height 128-row strip, build two-row clamped halo context, run `demosaic_bayer_mhc_band`, then tone directly into that strip's final output slice. Parallel build may use indexed parallel strip iteration only when output row ranges are disjoint; non-parallel build uses identical order and math. Reuse one scratch pair per worker with `map_init` rather than allocate per strip.

- [ ] **Step 5: Run and verify GREEN plus full raw suite**

Run:

```powershell
rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml --no-default-features mosaic_strips_match_whole_mhc_tone
rtk proxy cargo test --manifest-path crates/raw-pipeline/Cargo.toml --no-default-features --lib
```

Expected: all tests pass and every parity case is byte-identical.

- [ ] **Step 6: Write and run native flipflop**

`mosaic_strip_tone_flip.rs` allocates inputs and both output buffers once, alternates whole and strip arms with rotated order, checks every byte before timing, and prints flat TOON fields: `n`, `median_a_ms`, `median_b_ms`, `iqr_a_ms`, `iqr_b_ms`, `delta_pct`, `max_abs_diff`, `px_differ_count`, `trust`.

Run release example for 12 MP, 20 MP, and 30 MP synthetic mosaics plus available real decoded mosaics. Accept only if geomean stage gain is at least 5% and no representative size regresses.

- [ ] **Step 7: Integrate only eligible `finish_from_raw` common path**

Move look application and output-flag calculation before unconditional whole-frame demosaic. Use strip path only when:

```rust
let strip_eligible = output_flags & OUT_FULL_RGB8 != 0
    && output_flags & (OUT_FULL_16 | OUT_FULL_DISP16) == 0
    && params.texture == 0.0
    && params.clarity == 0.0;
```

Keep current whole-frame branch for every other case. Preserve orientation after RGB8 creation. Report a measured combined demosaic-plus-tone duration explicitly; do not label overlapping/combined wall time as separate stage time.

- [ ] **Step 8: Rebuild RAW WASM and run end-to-end corpus parity**

Build `web/pkg` with parallel WASM. Decode representative ORF, DNG, and CR2 before/after through browser. Compare all RGB bytes, dimensions, orientation, WB values, flags, and requested side outputs. Run end-to-end flipflop with `n>=10`.

- [ ] **Step 9: Commit winner or revert candidate**

Accepted commit message: `perf(raw): tone MHC output in bounded strips`. If end-to-end geomean is below 5%, revert production and unit-test changes; retain benchmark harness and ledger rejection only.

---

### Task 5: Decode-Handler and Boundary Saturation Sweep

**Files:**
- Inspect: `packages/jxl-worker-browser/src/decode-handler.ts`
- Inspect: `packages/jxl-wasm/src/facade.ts`
- Inspect: `packages/jxl-wasm/src/bridge.cpp`
- Modify only for a measured winner: corresponding focused test and source file
- Modify: `docs/ScannerBot-12-07-26-Decode-Throughput-Lateral.md`

**Interfaces:**
- No new public protocol. Existing `MsgDecodeStart`, chunk transfer, budget, drain, final transfer, and cleanup contracts stay unchanged.

- [ ] **Step 1: Fold Scannerbot C6, D3, D6/E6, V, and X lenses over one-hop dataflow**

Trace bytes and awaits from transferred `MsgDecodeChunk.chunk` through `ChunkRing`, `decoder.push`, facade heap staging, bridge input release, final WASM view copy, `toTransferablePixels`, and `postMessage` transfer. Count actual full-buffer reads/writes and allocations for final and passes modes.

- [ ] **Step 2: Reject forbidden/stale shapes immediately**

Drop chunk coalescing that delays first paint, output buffer pooling, decoder reuse across sessions, handler-owned admission/backpressure policy, soft yield inside synchronous WASM push, and any reintroduction of a second final-frame slice.

- [ ] **Step 3: Test every surviving hypothesis before production edit**

For each survivor, add focused test that fails for the intended missing behavior, run RED, make minimal change, run GREEN, then use same-process or fresh-page flipflop with byte parity. Below-5% candidates are reverted and logged.

- [ ] **Step 4: Run penultimate, unifying, and seam sweeps**

Search for a new lens not represented by runner sizing, box subscription, or strip materialization; require two independent occurrences before proposing it. Cross-file unifying candidate requires predicted 10% or named structural payoff. Inspect at most eight one-hop neighbors.

- [ ] **Step 5: Commit only paying survivor or ledger-only saturation result**

If no new candidate clears gate, commit only updated ledger with conclusion `decode-handler seam saturated after f99b0010`. No cosmetic hot-path refactor.

---

### Task 6: Optional PGO Experiment

**Files:**
- Modify only if accepted: `packages/jxl-wasm/dist/jxl-core.dec.*.wasm`
- Modify only if accepted: `packages/jxl-wasm/dist/build-manifest.json`
- Modify only if accepted: `packages/jxl-wasm/dist/pgo-manifest.lock.json`
- Modify: `docs/ScannerBot-12-07-26-Decode-Throughput-Lateral.md`

**Interfaces:**
- Consumes: source-fixed-point decoder and representative JXL decode corpus.
- Produces: profile-trained decoder artifact only if browser end-to-end gate passes.

- [ ] **Step 1: Skip task unless Tasks 2-5 reached fixed point**

Do not use PGO to hide an unresolved source or contract problem.

- [ ] **Step 2: Train one representative profile and build A/B artifacts**

Use existing `packages/jxl-wasm/scripts/build-pgo.mjs` and corpus benchmark. Keep non-PGO artifact as arm A and profile-trained artifact as arm B. Do not mix runner widths or source SHAs.

- [ ] **Step 3: Fresh-page browser flipflop**

Run final, passes, and concurrency-4 modes with at least 10 samples each. Require byte identity, high trust, and at least 5% end-to-end geomean. A single-file or initialization-only win is insufficient.

- [ ] **Step 4: Commit or discard binary churn**

If accepted, commit artifact and provenance files with `build(wasm): ship measured decode PGO artifact`. Otherwise restore all artifacts and record rejection numbers in ledger.

---

### Task 7: Combined Verification and Final Ledger

**Files:**
- Modify: `docs/ScannerBot-12-07-26-Decode-Throughput-Lateral.md`
- Verify: every accepted source, test, harness, generated artifact, and design requirement

**Interfaces:**
- Produces: final branch with only independently accepted commits and reproducible measurements.

- [ ] **Step 1: Rebuild combined artifacts from clean source**

Run accepted C++/WASM and Rust/WASM build commands once from current branch. Verify generated manifest source SHA and dirty flag are correct.

- [ ] **Step 2: Run full behavioral verification**

Run protected progressive tests, complete `jxl-wasm` tests, complete `jxl-worker-browser` tests, scheduler/session tests if touched, raw-pipeline library tests, and browser smoke decode.

Expected: zero new failures; any base-known failure remains byte-for-byte same and documented.

- [ ] **Step 3: Run combined parity oracle**

For JXL final/passes and each RAW format, record `max_abs_diff`, `px_differ_count`, dimensions, orientation, requested metadata/side outputs, and final hashes. Expected: all zero/equal.

- [ ] **Step 4: Run final end-to-end flipflop**

Interleave base artifact/source against combined branch for single JXL, progressive JXL, concurrency-4 JXL, ORF, DNG, and CR2. Record local deltas and Amdahl pipeline estimates without summing kernel percentages as end-to-end gain.

- [ ] **Step 5: Self-review requirements and diff**

Run:

```powershell
rtk proxy git diff --check main...HEAD
rtk proxy git status --short
rtk proxy git log --oneline main..HEAD
```

Confirm protected progressive code remains, no rejected production candidate remains, no generated build directory is staged, and every claimed win has command plus evidence.

- [ ] **Step 6: Finalize ledger and commit**

Ledger conclusion states accepted count, rejected count, measured end-to-end deltas, throughput delta, residual risks, and exact teardown command without executing it. Commit:

```powershell
rtk proxy git add -- docs/ScannerBot-12-07-26-Decode-Throughput-Lateral.md
rtk proxy git commit -m "docs: finalize decode throughput lateral sweep"
```
