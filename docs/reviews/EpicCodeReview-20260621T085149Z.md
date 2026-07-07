# EpicCodeReview — `packages/jxl-scheduler/` — 2026-06-21

**Branch:** `EpicCodeReviewJxl-Scheduler`  **Commit:** `eb51ff6b`
**Mode:** workalone (Sonnet/Opus finders, parallel)  **Baseline → final tests:** 47/47 → **49/49 pass**

## Scope

| Section | Files | Reviewed |
|---------|-------|----------|
| `src/` | 7 (`scheduler.ts`, `pool.ts`, `queue.ts`, `dedupe.ts`, `budget.ts`, `types.ts`, `index.ts`) | ✅ full |
| `test/` | 10 | light (added 1 file) |
| `dist-test/` | 34 | ⏭ skipped — generated TS output of `src/` |

Three parallel finder agents (correctness, perf/hacker, structure) over `src/`. The package is
**mature and heavily pre-reviewed** — ~16 prior rounds visible as inline markers (S1–S16,
`logic-0002`, `errors-0004`, `concurrency-b2d7e3f1`, `sched-1`…). Findings were filtered hard
against "already documented as handled."

## Fixed & committed (`eb51ff6b`)

### 1. `abortAcquisition` synthesized the wrong terminal kind for encode subscribers — **issue, medium**
`scheduler.ts`. When a deduped primary aborts *before* worker assignment (destroyed / signal
aborted / cancelled during the admission-gate or spawn await), `abortAcquisition` notified every
fan-out subscriber with a hardcoded `decode_cancelled`. An **encode** subscriber's consumer waits
for an encode terminal and never recognizes `decode_cancelled` → hang. `shutdown()` and the
preempt-timeout path were already kind-aware; this path was decode-only.
**Fix:** derive `encode_cancelled` / `decode_cancelled` from the subscriber record's `kind`.

### 2. `DedupeRegistry.forEachSubscriber` allocated a snapshot array per message — **perf, hot path**
`dedupe.ts:153`. `register()` seeds the subscriber Set with the primary's own id, so a
non-deduped session always has `size === 1`. The old `for (const sub of [...subs])` therefore
allocated a throwaway 1-element array on **every** worker→main message (`handleWorkerMessage`
calls this for each metric/progress/chunk/terminal — the hottest dispatch path).
**Fix:** `size === 0` / `size === 1` fast paths that extract the single id without a snapshot,
preserving the delete-during-iteration safety the snapshot guards (a single post-iteration `fn`
call can't skip a "next" entry).
**Measured:** isolated A/B microbench (interleaved, 100M calls) → **60.2% faster** on that path
(2.51×). Gate ≥5% ✓. Parity: 49/49 tests pass, dedupe semantics unchanged.

### Test added
`test/scheduler.abort-dedupe.test.ts` — first coverage of the **AdmissionGate-blocked
acquisition** path: an encode subscriber on an aborted primary must get `encode_cancelled`; a
decode subscriber must still get `decode_cancelled`. Both pass.

## Deferred → `QUESTIONS.md` (5 items)

| # | Sev | Item | Why deferred |
|---|-----|------|--------------|
| Q1 | med | Subscriber record/`_subscriberCount` not cleaned on **normal** primary terminal (asymmetric vs abort path) | Depends on jxl-session's `completeSession`-per-subscriber contract — outside this package; a blind fix risks double-decrement |
| Q2 | low | `setPriority` has no `paused` branch + duplicates dedupe-escalation logic | Works by invariant; cleanup only |
| Q3 | low | `acquireSlot` returns `workerId: -1` sentinel vs `number\|null` | Public return-type change (no-go without caller audit) |
| Q4 | low | No input validation at public boundaries (`acquireSlot`/`setPriority` vs `CoreBudget` which validates) | Opportunity |
| Q5 | low | Reentrant `cancelSession` during `maxParkedSessions` eviction | Rare (default `Infinity`); doc/microtask defer |

## Deliberately not pursued
`signalDrain` queueDepth gauge (CLAUDE.md: A3 FALSIFIED, intentional) · pool/queue "dead" APIs
(test-support, `@internal`) · protocol-union `as`-casts (deliberate hot-path narrowing) ·
no layer violations found (backpressure / dedupe / budget all in their CLAUDE.md-mandated layers).

## Verdict
Two real fixes (one latent hang, one hot-path allocation) on otherwise solid, well-defended code.
No correctness-breaking bugs in the core state machine. Everything uncertain or API-shaped was
deferred rather than guessed.

---

## Follow-up sweep — GC-churn across the TS packages (2026-06-21)

Requested after the `forEachSubscriber` fix: hunt the same CLASS (per-message / per-frame / per-tile
throwaway allocations) codebase-wide. Four parallel read-only finders over the hot clusters
(jxl-worker-browser, jxl-wasm/facade, jxl-session+stream, jxl-pyramid+progressive). Rust crates
excluded — no GC.

**Honest framing:** these are GC-hygiene / allocation-count reductions verified by full test parity,
NOT wall-clock movers. The pipeline is WASM-bound; eliminating these short-lived objects cuts
minor-GC pressure under bursty load, not decode/encode time.

### Fixed (committed in `f1a57528` — see note below)
1. **`jxl-session/decode-session.ts` `makeFrame`** — replaced 11 conditional-spread
   `...(cond ? { X } : {})` with guard-assign onto one object. Each spread allocated a throwaway
   intermediate `{X}`/`{}` per **frame** (per pass / per animation frame). Mirrors the existing
   `toFrameMeta()` pattern in jxl-worker-browser. Byte-identical result. **jxl-session 63 tests, 0 fail.**
2. **`jxl-progressive/progressive-scheduler.ts` `tierRank`** — hoisted the per-call
   `Record<Tier,number>` literal to a module const. Hit per-candidate per RAF tick (~60fps via
   `fairnessScore`). Pure lookup, parity-exact. **jxl-progressive 88 tests, 0 fail.**
3. **`jxl-session/util.ts`** (enabler, not GC) — fixed a **pre-existing** compile break
   (`Uint8Array.buffer` is `ArrayBufferLike` under TS 5.5 / @types/node 22) with the same
   `as ArrayBuffer` cast the sibling `toTransferablePixels` already uses. Without this, jxl-session
   did not compile and its test suite could not run to verify fix #1.

### Considered and REJECTED (with reason)
- **`jxl-wasm/facade.ts` — 0 findings.** Already aggressively swept (cached bridge refs, `EMPTY_U8`
  reuse, shared `_f32Scratch`, copyWithin compaction). All remaining per-call allocs are mandatory
  WASM-heap copy-outs or consumer-facing event objects.
- **`decode-handler.ts:731 transferList()`** — `[buf]` per frame IS the exemplar class, but the only
  safe fix is a shared mutable holder array returned to callers — a latent aliasing foot-gun for any
  future caller that retains it, for dozens-of-arrays-per-decode savings. Reward < risk; rejected on
  safety (matches the package's own conservatism).
- worker-browser `_metricMsg`/`_drainMsg`/`_chunkMsg` (already pre-allocated), encode-handler
  per-chunk wrappers (queued, not throwaway), event-stream IteratorResults / Promises (required-fresh,
  contractually mandated), pyramid `gridTile` region args (required values) — all correctly excluded.

### ⚠️ Branch / commit note
This package's branch (`EpicCodeReviewJxl-Scheduler`) is **shared with concurrent EpicCodeReview and
build processes** that committed during this run. The three GC fixes above were swept into a
concurrent commit (`f1a57528`, "perf(fast-jpeg)…") rather than landing in their own labelled commit —
the files are intact and test-verified, but the commit message does not describe them. The two
scheduler fixes are cleanly in `eb51ff6b` / `1c6cf895`. No history was rewritten (forbidden, and
unsafe against a live concurrent committer).
