# Decode Throughput Lateral Optimization Design

Date: 2026-07-12  
Branch: `grok/decode-throughput-lateral-2`  
Base: `main` at `b8bfc5c2`

## Goal

Reduce end-to-end browser decode wall time and improve sustained decode throughput for
representative large JXL, ORF, DNG, and CR2 inputs without changing decoded pixels,
metadata requested by callers, progressive checkpoint behavior, cancellation, budget,
or scheduling contracts.

Kernel floors and the boundary wins in `f99b0010` are the baseline, not candidates to
repeat. New work must find deeper waste in runner sizing, optional decoder work, and
RAW stage materialization.

## Acceptance Gate

Every performance candidate is independent and disposable. Before implementation, run
Scannerbot prior-art refusal. Then require:

1. Relevant build succeeds, including rebuilt WASM when C++ or Rust/WASM changes.
2. Touched package behavioral tests pass.
3. Output parity records `max_abs_diff`, differing-pixel count, dimensions, and metadata
   equality. Integer-stable candidates require byte identity.
4. Interleaved flipflop measurement has at least 10 samples, median and IQR, start-order
   rotation, and high thermal trust.
5. Relevant stage improves by at least 5%, and end-to-end browser wall time does not
   regress. Throughput candidates must also improve multi-file completion time.
6. Combined winners pass full parity and end-to-end measurement after one rebuild.

Candidates failing any rung are reverted and recorded with measured rejection data.

## Baselines

Measure current `main` artifacts before edits:

- Large JXL final-only decode through browser worker and session path.
- Same JXL through progressive `lastPasses` and diagnostic `passes` chunk feeding.
- Representative ORF, DNG, and CR2 full RGB8 decode through browser WASM.
- Concurrent JXL batch throughput under scheduler admission.
- Stage attribution: WASM decode, heap input copy, final pixel materialization, worker
  transfer, RAW decompress, demosaic, tone, and orientation.

Use existing corpus files and benchmark harness patterns where possible. New same-process
arms remain in the repository so later runs can reproduce results.

## Candidate 1: Decoder Runner Budget Alignment

### Observation

Decoder MT artifacts prewarm four Emscripten pthread workers, while `GetSharedRunner()`
asks `JxlThreadParallelRunnerDefaultNumWorkerThreads()` for a hardware-wide count. Source
comments still describe a hardware-wide prewarmed pool and no longer match build flags.
The mismatch can trigger lazy worker creation, excess synchronization, or a poor
single-file/throughput tradeoff.

### Experiment

Build same-source decoder variants whose libjxl runner uses controlled counts: 1, 2, 4,
and current default. Compare in fresh browser pages so pthread pools cannot leak between
arms. Measure both one large decode and scheduler-admitted batches.

### Possible Implementation

If a stable winner exists, make decoder runner size explicit and consistent with the
artifact's pool contract. Prefer build-defined constant over mutable per-session state.
Do not move core budgeting or admission into `decode-handler.ts`; those stay scheduler
responsibilities. If workload-dependent sizing is necessary, expose immutable module
configuration before the singleton runner is created and charge the same core cost in
the scheduler.

### Risks

- Fewer threads can improve throughput but regress large single-image latency.
- Lazy Emscripten spawn behavior differs between Node and browser.
- Runner singleton initialization order must remain deterministic.

No change lands unless both latency and the declared scheduling/core-cost contract are
measured honestly.

## Candidate 2: Skip Unrequested Container Box Work

### Observation

Progressive decoder creation always subscribes to `JXL_DEC_BOX` and maintains gain-map
box state. Most final pixel decodes request neither preserved metadata nor a gain map.
The bridge and facade already carry preservation intent, but the subscription is not
conditional.

### Experiment

Add a test-only decoder flag that disables box subscription while leaving pixel events
unchanged. Flipflop plain codestreams, normal containers, metadata-heavy containers, and
gain-map containers. Compare pixel bytes and requested metadata.

### Possible Implementation

Only if measurement clears the gate, thread an explicit `want_boxes` flag from facade to
bridge. Default behavior must preserve existing public API semantics. Worker calls may
disable boxes only when their decode options prove no box-derived result can be observed.
Gain-map or metadata-preserving callers retain current path.

### Risks

- Box subscription may be cheap enough that the result is noise.
- Gain-map discovery is observable even when pixels match.
- Old WASM artifacts must retain compatibility through optional-symbol/flag handling.

## Candidate 3: RAW RGB16 Materialization Elision

### Observation

`finish_from_raw` commonly builds a full-frame RGB16 MHC result, then reads it once to
produce RGB8. Existing `stream_band` code proves strip MHC plus tone can be byte-identical
and bounds intermediate storage, but the full RGB8 common path still materializes the
whole RGB16 image.

### Experiment

Add a same-process flipflop between current whole-frame MHC-plus-tone and strip-based
MHC-plus-tone over the already-decoded mosaic. Measure representative dimensions and
real ORF/DNG/CR2 mosaics. Record peak bytes as supporting evidence, but accept only on
time.

### Possible Implementation

Use strip processing only when semantics permit it:

- `OUT_FULL_RGB8` requested.
- No full RGB16 or display-16 output needs the master buffer.
- No spatial operation requires whole-frame RGB16 state.
- MHC phase, look parameters, orientation, and output dimensions remain identical.

Fallback stays current whole-frame path for full16, display16, unsharp/clarity, or any
case lacking an exact strip oracle. Avoid per-strip output copies by writing disjoint
row ranges directly. Reuse bounded strip scratch instead of allocating per strip when
measurement shows allocation cost.

### Risks

- Existing pipelined source overlaps serial decode; a mosaic-backed source may not gain
  enough after decode already completed.
- Strip setup can defeat whole-frame SIMD/parallel efficiency.
- Telemetry currently separates demosaic and tone; fused work needs a documented combined
  measurement rather than fabricated attribution.

## Candidate 4: PGO Artifact Experiment

PGO is non-core and last. No source design depends on it. Run only after source candidates
reach a fixed point, using a representative decode corpus and fresh-page A/B artifacts.
Reject unless byte identity holds and end-to-end browser median improves by at least 5%
with high trust. Do not commit profiles or binary churn for a wash.

## Progressive Decode Contract

Before any `bridge.cpp` edit, run:

```powershell
rtk proxy bun test packages/jxl-wasm/test/progressive-visible-passes.test.ts
rtk proxy bun test web/jxl-single-progressive-page.test.js
```

Preserve these invariants:

- On `JXL_DEC_NEED_MORE_INPUT`, after frame start and before final, attempt one
  opportunistic flush per `input_generation`.
- Keep `opportunistic_flush_generation != input_generation`.
- Do not add checksum/frame-hash dedupe outside an explicit experiment flag.
- Diagnostic `passes` and throttled progressive decode remain chunk-fed with yields.
- Single Progressive defaults remain aligned with the documented Sneyers baseline.

## Worker and Scheduler Contracts

`decode-handler.ts` owns worker-side queue draining, budget enforcement, event transfer,
and session cleanup. Scheduler owns admission, core budgeting, backpressure policy, and
preemption. Candidate changes must not cross those boundaries.

Pixel buffers transferred with `postMessage` remain terminal ownership transfers. No
output-buffer pool or implicit reuse is introduced. Shared WASM views are not exposed
without an explicit lifetime/release protocol, which is outside this run.

## Error Handling

- Allocation failure remains terminal and frees decoder/input/output state.
- Unsupported old bridge symbols use existing compatibility fallbacks.
- Metadata/gain-map requests never silently take a pixels-only fast path.
- Cancellation and budget completion preserve existing terminal messages and partial
  frame behavior.
- Benchmark timeout or low thermal trust rejects evidence; it never counts as a win.

## Verification

Run the touched layer's focused tests after every candidate and full suites for the final
combined set. Required coverage includes:

- Progressive visible-pass and page contracts.
- `jxl-wasm` facade, deferred-release, progressive detail, ABI, and runtime tests.
- `jxl-worker-browser` handler and decoder lifecycle tests.
- Raw-pipeline library tests and strip-versus-whole parity oracles.
- Rebuilt browser WASM smoke decode for every changed native source.
- Fresh end-to-end browser flipflop for JXL and RAW corpus.

## Deliverables

- Separate commits for accepted candidates only.
- Reproducible flipflop harnesses and parity records.
- Dated optimization ledger listing accepted and rejected hypotheses, local delta, and
  Amdahl-bounded end-to-end estimate.
- No push, merge, or worktree removal.
