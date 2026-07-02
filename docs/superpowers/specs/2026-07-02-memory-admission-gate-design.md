# Memory-Weighted Admission Gate — Design

Date: 2026-07-02
Status: Approved (brainstorming) — ready for implementation plan
Branch: `feat/memory-admission-gate-jul02-mag7` (superproject)

## Problem

The scheduler bounds decode concurrency by **worker/core count**, never by memory:
`pool.ts` poolSize = `clamp(HWC-1, 1..4)`, gallery `maxActiveDecoders` default 4, shared
`CoreBudget` core-token semaphore. No layer weights a task by its memory footprint.

Benchmarked evidence (`project-preview-concurrency-evidence`, branch m2r7 —
`examples/dng_preview_concurrency.rs`, `examples/jxl_decode_concurrency.rs`, 12-core box):

- **Full-res decode memory explodes** (~250 MB/worker: 278 MB@1 → 6004 MB@24). The flat
  cap of ~4 is *justified* here — 12 concurrent OOMs wasm32.
- **Small pyramid (256 px) decode is memory-flat** (~80 MB regardless of N) and throughput
  scales *past* core count (152→599@4→956 dec/s@24). The same flat cap **starves the
  gallery/thumbnail path ~2×**.

The flat count cap conflates two ~100×-different memory profiles. It is the wrong **shape**,
not the wrong value. Fix: a memory-weighted concurrency budget — each decode consumes budget
∝ its output bytes; run either ~2 full **or** ~6+ pyramid decodes concurrently, memory-safe
both ways, throughput-maximal.

`docs/1 rejected optimizations.md` G2-F6 rejected a related work-class routing hint as
"cross-layer + no evidence" = *unproven*, not disproven. The evidence above now justifies the
contract change. Placement stays in-layer (scheduler), satisfying the layer rule.

## Goal

Replace the flat count cap with a byte-budget concurrency limiter so cheap pyramid decodes run
many-concurrent (memory-safe) while full decodes stay ~2, delivering the measured 2× gallery /
+66% cheap-task throughput. Opt-in: with no gate injected, behavior is identical to today.

## Non-goals

- Device-memory auto-scaling (`navigator.deviceMemory`) — the gate takes an explicit
  `budgetBytes`; any device-derived value is computed by the app and passed in.
- Mid-flight reweighting of decodes whose real output size differs from the hint (two-phase
  reconcile) — rejected for its over-admit window + race surface.
- Changing MT/ST routing (`CoreBudget` unchanged; it still bounds concurrent MT threads).
- The throughput benchmark harness itself (validation is a separate follow-up; the native
  `examples/*_concurrency.rs` already exist).

## Architecture

The exact pattern already exists: `CoreBudget` (jxl-scheduler/src/budget.ts) is a weighted
token semaphore (MT costs N tokens, ST costs 1, FIFO waiters). The memory gate is the same
shape, keyed on **output bytes** instead of cores.

```
gallery.decode({ expectedOutputBytes, priority })
  → DecodeSessionImpl
    → scheduler.acquireSlot({ …, weight })
      → gate.admit(sessionId, priority, weight)   // BEFORE pool.acquire
          fits (runningBytes + weight ≤ budget) ? admit : priority-queue
      → pool.acquire()                            // ceiling raised to ~2*HWC
      → worker decodes
      → release → gate frees weight → drain waiters
```

Two independent limiters compose:
- **Memory gate** — bounds the concurrently-*admitted* set by Σweight ≤ budget (the new
  effective concurrency limiter).
- **CoreBudget** — bounds concurrent MT threads (unchanged).

## Components

### 1. `MemoryWeightedAdmissionGate` — new `jxl-scheduler/src/memory-admission-gate.ts`

Weighted semaphore. Implements the `AdmissionGate` interface.

- Constructor `{ budgetBytes?: number }`, default `512 * 1024 * 1024` (512 MB). Validates
  finite > 0 (mirror `CoreBudget`).
- `admit(sessionId, priority, weight)`:
  - `w = weight ?? DEFAULT_WEIGHT` (conservative — treat unknown as a full decode so it can
    never over-admit). `DEFAULT_WEIGHT` default `256 * 1024 * 1024` (256 MB ≈ one full decode
    from the bench), configurable via the constructor alongside `budgetBytes`.
  - If `runningBytes + w ≤ budgetBytes` (or running set empty — see over-budget rule): admit,
    `runningBytes += w`, record `{sessionId, w}`, return a release closure.
  - Else enqueue a waiter `{sessionId, priority, w, resolve}` in the **priority-ordered**
    queue.
- release (returned closure, idempotent — call exactly once, tolerate extra): `runningBytes -=
  w`; drain — repeatedly admit the highest-priority waiter that now fits (`runningBytes + w ≤
  budget`, or running empty).
- **Priority-ordered queue**: visible > near > background, FIFO within a priority. A background
  batch cannot starve a visible thumbnail.
- **Over-budget task** (`w > budgetBytes`, e.g. a huge full decode): admit **alone** when the
  running set is empty (a decode can't be split → refusing would deadlock).
- **Cancel tolerance (T3 contract)**: `admit()` may resolve after the session was cancelled;
  the scheduler calls release immediately. release of a still-queued waiter removes it from the
  queue and resolves nothing outstanding. release-before-admit-resolves is safe (idempotent).

Public surface: constructor + `admit()`; plus read-only `runningBytes` / `pendingCount` for
tests/telemetry. Internals (queue, drain) are not observable by consumers.

### 2. `AdmissionGate` interface — `jxl-scheduler/src/types.ts`

`admit(sessionId: string, priority: Priority, weight?: number): Promise<AdmissionRelease>`.

`weight` is **optional** — existing gate implementations, the existing scheduler call, and the
no-gate default path are unaffected. A gate that ignores `weight` behaves as before.

### 3. Scheduler — `jxl-scheduler/src/scheduler.ts`

- `acquireSlot` params gain `weight?: number`.
- At the existing admit call site (~348): `await this.admissionGate.admit(params.sessionId,
  params.priority, params.weight)`. No change to the release/transfer/cleanup paths
  (`gateReleases`, promotion transfer, `releaseAdmission`).

### 4. Sessions — `jxl-session/src/{decode,encode}-session.ts`

- Decode opts gain `expectedOutputBytes?: number`; passed through to `acquireSlot({…, weight:
  opts.expectedOutputBytes})`.
- Encode reuses the already-computed `width*height*bpp` (encode-session.ts:220) as `weight`.

### 5. Pool — `jxl-scheduler/src/pool.ts`

- Raise the worker ceiling to a configurable max, default `2 * HWC`, so the memory gate is the
  effective concurrency limiter rather than a flat ~4.
- `CoreBudget` bounds concurrent MT threads unchanged; ST pyramid workers cost 1 core token
  each, so many cheap workers is core-cheap (matches the bench).
- **Safety**: the ceiling raise is config-gated. When no gate is injected the effective default
  is preserved (see Opt-in).

### 6. App wiring — gallery / context

The gallery constructs a `MemoryWeightedAdmissionGate({ budgetBytes })`, injects it into the
scheduler (existing `opts.admissionGate`), and supplies `expectedOutputBytes` per decode (it
knows the requested pyramid level: thumb `256*256*4`, full `W*H*ch` from the manifest).

## Error handling

- Over-budget single task → admitted alone (no deadlock).
- Cancel during wait → waiter removed, no leak (scheduler already releases on all exit paths;
  gate tolerates release of a queued waiter).
- Scheduler destroyed while queued → scheduler releases the token; gate drops the waiter.
- `weight` absent → `DEFAULT_WEIGHT` (conservative full-size) so a caller that forgets the hint
  can never over-admit.
- `budgetBytes` invalid → throw at construction (mirror `CoreBudget`).

## Opt-in & safety

- **No gate injected** ⇒ scheduler never calls `admit` ⇒ identical to today.
- The pool-ceiling raise is the one always-on-looking change; it is **config-gated** and
  defaults to today's value unless a memory gate is present (or an explicit higher max is
  configured). So a deployment that does not adopt the gate sees no behavioral change.
- Adaptive/heuristic change gate (CLAUDE.md) is satisfied: this ships with the benchmarked
  evidence above.

## Testing

**Gate unit tests** (`test/memory-admission-gate.test.ts`):
- admit until budget full, next task queues
- release drains the highest-priority fitting waiter (priority ordering: visible before
  background even when enqueued later; FIFO within a priority)
- over-budget task admitted alone when running empty; queued while others run
- `weight` absent ⇒ `DEFAULT_WEIGHT` applied
- cancel-during-wait: release of a queued waiter removes it, frees nothing double
- release idempotent
- `runningBytes` / `pendingCount` reflect state

**Scheduler integration** (extend `test/scheduler.admission.test.ts`):
- `weight` from `acquireSlot` reaches `admit`
- release fires on every exit path (normal, abort-before-assign, cancel-during-acquisition,
  destroy, dedupe-subscriber) — no budget leak
- promotion transfers the gate token (existing behavior preserved)

**Session** — decode passes `expectedOutputBytes`; encode passes `width*height*bpp`.

**Validation (follow-up, not this branch)** — the `examples/*_concurrency.rs` benchmark
confirms cheap-task concurrency rises toward core count under the byte budget while full-decode
concurrency stays memory-safe.

## Files touched

- new: `jxl-scheduler/src/memory-admission-gate.ts`, `test/memory-admission-gate.test.ts`
- edit: `jxl-scheduler/src/types.ts` (interface), `scheduler.ts` (pass weight), `pool.ts`
  (ceiling), `test/scheduler.admission.test.ts`
- edit: `jxl-session/src/decode-session.ts` (opt + pass), `encode-session.ts` (pass weight)
- edit: gallery/app wiring (construct + inject gate, supply hints)
