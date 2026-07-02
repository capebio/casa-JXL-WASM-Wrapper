# Memory-Weighted Admission Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat count-based decode concurrency cap with a byte-budget weighted semaphore so cheap pyramid decodes run many-concurrent (memory-safe) while full decodes stay ~2.

**Architecture:** A new `MemoryWeightedAdmissionGate` (same shape as `CoreBudget`, cost = output bytes) implements the existing `AdmissionGate` interface, extended with an optional `weight`. The scheduler passes each task's weight from `acquireSlot`; sessions supply it (encode: `w*h*bpp`; decode: `expectedOutputBytes` hint or `targetWidth*targetHeight*4`). The worker-pool ceiling is raised at the app layer so the byte budget is the effective concurrency limiter. Opt-in: no gate injected ⇒ identical to today.

**Tech Stack:** TypeScript, `node:test` (`describe`/`it`, `node:assert/strict`), compiled via `tsc -p tsconfig.test.json` then `node --test dist-test/test/*.test.js`.

**Spec:** `docs/superpowers/specs/2026-07-02-memory-admission-gate-design.md`

---

## File Structure

- **Create** `packages/jxl-scheduler/src/memory-admission-gate.ts` — the gate class (only responsibility: memory-weighted admission).
- **Create** `packages/jxl-scheduler/test/memory-admission-gate.test.ts` — gate unit tests.
- **Modify** `packages/jxl-scheduler/src/types.ts` — add optional `weight` to `AdmissionGate.admit`.
- **Modify** `packages/jxl-scheduler/src/scheduler.ts` — `acquireSlot` gains `weight?`, passed to `admit`.
- **Modify** `packages/jxl-scheduler/test/scheduler.admission.test.ts` — integration: weight reaches gate, released on all exits.
- **Modify** `packages/jxl-session/src/decode-session.ts` — decode opts `expectedOutputBytes?`; derive + pass `weight`.
- **Modify** `packages/jxl-session/src/encode-session.ts` — pass `weight = width*height*bpp`.
- **Modify** app/context wiring (identified in Task 8) — construct + inject gate, raise pool ceiling, supply hints.

Run tests from `packages/jxl-scheduler`: full = `npm test`; single file = `npx tsc -p tsconfig.test.json && node --test dist-test/test/memory-admission-gate.test.js`.

---

## Task 1: Gate core — admit / fits / release

**Files:**
- Create: `packages/jxl-scheduler/src/memory-admission-gate.ts`
- Test: `packages/jxl-scheduler/test/memory-admission-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/jxl-scheduler/test/memory-admission-gate.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryWeightedAdmissionGate } from "../src/memory-admission-gate.js";

const MB = 1024 * 1024;

describe("MemoryWeightedAdmissionGate core", () => {
  it("admits tasks whose cumulative weight fits the budget", async () => {
    const gate = new MemoryWeightedAdmissionGate({ budgetBytes: 300 * MB });
    await gate.admit("a", "visible", 100 * MB);
    await gate.admit("b", "visible", 100 * MB);
    assert.equal(gate.runningBytes, 200 * MB);
    assert.equal(gate.pendingCount, 0);
  });

  it("queues a task that would exceed the budget until a release frees room", async () => {
    const gate = new MemoryWeightedAdmissionGate({ budgetBytes: 300 * MB });
    const relA = await gate.admit("a", "visible", 200 * MB);
    let admittedC = false;
    const pC = gate.admit("c", "visible", 200 * MB).then((r) => { admittedC = true; return r; });
    await Promise.resolve(); // let the pending promise settle its microtasks
    assert.equal(admittedC, false, "c must wait — 200+200 > 300");
    assert.equal(gate.pendingCount, 1);
    relA(); // frees 200MB
    await pC;
    assert.equal(admittedC, true);
    assert.equal(gate.runningBytes, 200 * MB);
    assert.equal(gate.pendingCount, 0);
  });

  it("throws on an invalid budget", () => {
    assert.throws(() => new MemoryWeightedAdmissionGate({ budgetBytes: 0 }));
    assert.throws(() => new MemoryWeightedAdmissionGate({ budgetBytes: -1 }));
    assert.throws(() => new MemoryWeightedAdmissionGate({ budgetBytes: Number.POSITIVE_INFINITY }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jxl-scheduler && npx tsc -p tsconfig.test.json && node --test dist-test/test/memory-admission-gate.test.js`
Expected: FAIL — `Cannot find module '../src/memory-admission-gate.js'` (or tsc error: file missing).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/jxl-scheduler/src/memory-admission-gate.ts
// MemoryWeightedAdmissionGate: byte-budget weighted semaphore implementing AdmissionGate.
// Cost = a task's estimated output bytes; capacity = budgetBytes. Same shape as CoreBudget
// (budget.ts) but keyed on memory instead of cores. Opt-in — only active if injected.
import type { AdmissionGate, AdmissionRelease, Priority } from "./types.js";

const MB = 1024 * 1024;

const PRIORITY_RANK: Record<Priority, number> = { visible: 0, near: 1, background: 2 };

interface Waiter {
  sessionId: string;
  priority: Priority;
  weight: number;
  resolve: (release: AdmissionRelease) => void;
}

export interface MemoryWeightedAdmissionGateOptions {
  /** Byte capacity the running decode set must fit under. Default 512 MB (fits wasm32). */
  budgetBytes?: number;
  /** Weight applied when admit() is called without a weight. Default 256 MB (≈ one full decode). */
  defaultWeightBytes?: number;
}

export class MemoryWeightedAdmissionGate implements AdmissionGate {
  private readonly budgetBytes: number;
  private readonly defaultWeightBytes: number;
  private _runningBytes = 0;
  private readonly waiters: Waiter[] = [];

  constructor(opts: MemoryWeightedAdmissionGateOptions = {}) {
    const budget = opts.budgetBytes ?? 512 * MB;
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error("[jxl-scheduler] MemoryWeightedAdmissionGate: budgetBytes must be finite > 0");
    }
    const dflt = opts.defaultWeightBytes ?? 256 * MB;
    if (!Number.isFinite(dflt) || dflt <= 0) {
      throw new Error("[jxl-scheduler] MemoryWeightedAdmissionGate: defaultWeightBytes must be finite > 0");
    }
    this.budgetBytes = budget;
    this.defaultWeightBytes = dflt;
  }

  /** Bytes currently reserved by admitted-but-not-released tasks. */
  get runningBytes(): number {
    return this._runningBytes;
  }

  /** Number of tasks waiting for budget. */
  get pendingCount(): number {
    return this.waiters.length;
  }

  admit(sessionId: string, priority: Priority, weight?: number): Promise<AdmissionRelease> {
    const w = this.normalizeWeight(weight);
    if (this.fits(w)) {
      this._runningBytes += w;
      return Promise.resolve(this.makeRelease(w));
    }
    return new Promise<AdmissionRelease>((resolve) => {
      this.waiters.push({ sessionId, priority, weight: w, resolve });
    });
  }

  private normalizeWeight(weight?: number): number {
    if (weight === undefined || !Number.isFinite(weight) || weight <= 0) {
      return this.defaultWeightBytes;
    }
    return weight;
  }

  private fits(w: number): boolean {
    // Fits if it stays under budget, OR nothing is running (a single over-budget
    // task must still run alone — a decode can't be split — to avoid deadlock).
    return this._runningBytes + w <= this.budgetBytes || this._runningBytes === 0;
  }

  private makeRelease(w: number): AdmissionRelease {
    let released = false;
    return () => {
      if (released) return; // idempotent
      released = true;
      this._runningBytes -= w;
      this.drain();
    };
  }

  private drain(): void {
    // Admit the first fitting waiter, repeat until none fit. (Priority ordering
    // is added in Task 2; Task 1 uses FIFO order.)
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < this.waiters.length; i++) {
        if (this.fits(this.waiters[i].weight)) {
          const [waiter] = this.waiters.splice(i, 1);
          this._runningBytes += waiter.weight;
          waiter.resolve(this.makeRelease(waiter.weight));
          progress = true;
          break;
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jxl-scheduler && npx tsc -p tsconfig.test.json && node --test dist-test/test/memory-admission-gate.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-scheduler/src/memory-admission-gate.ts packages/jxl-scheduler/test/memory-admission-gate.test.ts
git commit -m "feat(scheduler): MemoryWeightedAdmissionGate core admit/release/budget"
```

---

## Task 2: Priority-ordered queue

**Files:**
- Modify: `packages/jxl-scheduler/src/memory-admission-gate.ts` (drain/insert)
- Test: `packages/jxl-scheduler/test/memory-admission-gate.test.ts`

- [ ] **Step 1: Write the failing test** (append inside the file)

```ts
describe("MemoryWeightedAdmissionGate priority", () => {
  it("drains the highest-priority waiter first, even if enqueued later", async () => {
    const gate = new MemoryWeightedAdmissionGate({ budgetBytes: 100 * MB });
    const rel = await gate.admit("running", "visible", 100 * MB); // fills budget
    const order: string[] = [];
    // Enqueue background first, then visible — visible must win on drain.
    const pBg = gate.admit("bg", "background", 100 * MB).then((r) => { order.push("bg"); return r; });
    const pVis = gate.admit("vis", "visible", 100 * MB).then((r) => { order.push("vis"); return r; });
    await Promise.resolve();
    assert.equal(gate.pendingCount, 2);
    rel(); // frees 100MB — only one of the two 100MB waiters can admit at a time
    const r1 = await pVis;      // visible admitted first
    assert.deepEqual(order, ["vis"]);
    r1();                       // release visible → background admits
    await pBg;
    assert.deepEqual(order, ["vis", "bg"]);
  });

  it("preserves FIFO within the same priority", async () => {
    const gate = new MemoryWeightedAdmissionGate({ budgetBytes: 100 * MB });
    const rel = await gate.admit("run", "visible", 100 * MB);
    const order: string[] = [];
    const p1 = gate.admit("first", "near", 100 * MB).then((r) => { order.push("first"); return r; });
    const p2 = gate.admit("second", "near", 100 * MB).then((r) => { order.push("second"); return r; });
    await Promise.resolve();
    rel();
    const r1 = await p1;
    assert.deepEqual(order, ["first"]);
    r1();
    await p2;
    assert.deepEqual(order, ["first", "second"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jxl-scheduler && npx tsc -p tsconfig.test.json && node --test dist-test/test/memory-admission-gate.test.js`
Expected: FAIL — the priority test fails (drain currently FIFO, admits "bg" first).

- [ ] **Step 3: Write minimal implementation** — replace the `admit` push and `drain` scan with priority-ordered insertion, so a simple in-order scan is already priority-correct.

In `admit`, replace `this.waiters.push({ sessionId, priority, weight: w, resolve });` with:

```ts
      this.insertWaiter({ sessionId, priority, weight: w, resolve });
```

Add this private method (below `normalizeWeight`):

```ts
  private insertWaiter(waiter: Waiter): void {
    // Priority-ordered (visible < near < background by rank), FIFO within a priority:
    // insert after the last waiter of equal-or-higher priority.
    const rank = PRIORITY_RANK[waiter.priority];
    let i = this.waiters.length;
    while (i > 0 && PRIORITY_RANK[this.waiters[i - 1].priority] > rank) i--;
    this.waiters.splice(i, 0, waiter);
  }
```

(No `drain` change needed — the queue is now priority-ordered, so the first-fitting scan already prefers higher priority.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jxl-scheduler && npx tsc -p tsconfig.test.json && node --test dist-test/test/memory-admission-gate.test.js`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-scheduler/src/memory-admission-gate.ts packages/jxl-scheduler/test/memory-admission-gate.test.ts
git commit -m "feat(scheduler): priority-ordered admission queue (visible before background)"
```

---

## Task 3: Over-budget-alone, default weight, idempotent release

**Files:**
- Test: `packages/jxl-scheduler/test/memory-admission-gate.test.ts`
- (No src change expected — these behaviors are already implemented in Task 1/2. This task is characterization tests that lock them in. If any fails, fix the src as noted.)

- [ ] **Step 1: Write the failing test** (append)

```ts
describe("MemoryWeightedAdmissionGate edge cases", () => {
  it("admits a single over-budget task alone, then queues the next", async () => {
    const gate = new MemoryWeightedAdmissionGate({ budgetBytes: 100 * MB });
    const rel = await gate.admit("huge", "visible", 500 * MB); // > budget, running empty → admit alone
    assert.equal(gate.runningBytes, 500 * MB);
    let admitted2 = false;
    const p2 = gate.admit("next", "visible", 10 * MB).then((r) => { admitted2 = true; return r; });
    await Promise.resolve();
    assert.equal(admitted2, false, "nothing admits while an over-budget task runs");
    assert.equal(gate.pendingCount, 1);
    rel();
    await p2;
    assert.equal(admitted2, true);
  });

  it("applies the default weight when admit() is called without a weight", async () => {
    const gate = new MemoryWeightedAdmissionGate({ budgetBytes: 300 * MB, defaultWeightBytes: 200 * MB });
    await gate.admit("a", "visible"); // no weight → 200MB
    assert.equal(gate.runningBytes, 200 * MB);
    let admittedB = false;
    gate.admit("b", "visible").then(() => { admittedB = true; }); // 200MB → 400 > 300 → queued
    await Promise.resolve();
    assert.equal(admittedB, false);
    assert.equal(gate.pendingCount, 1);
  });

  it("treats a non-positive / non-finite weight as the default", async () => {
    const gate = new MemoryWeightedAdmissionGate({ budgetBytes: 300 * MB, defaultWeightBytes: 200 * MB });
    await gate.admit("a", "visible", 0);
    await gate.admit("b", "visible", -5);
    // both → 200MB each; second queues
    assert.equal(gate.runningBytes, 200 * MB);
    assert.equal(gate.pendingCount, 1);
  });

  it("release is idempotent (double-call frees budget once)", async () => {
    const gate = new MemoryWeightedAdmissionGate({ budgetBytes: 300 * MB });
    const rel = await gate.admit("a", "visible", 100 * MB);
    rel();
    rel(); // second call must be a no-op
    assert.equal(gate.runningBytes, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd packages/jxl-scheduler && npx tsc -p tsconfig.test.json && node --test dist-test/test/memory-admission-gate.test.js`
Expected: PASS (behaviors implemented in Tasks 1–2). If the "non-finite weight" test fails, confirm `normalizeWeight` rejects `NaN`/`Infinity` (it does via `Number.isFinite`).

- [ ] **Step 3: Fix only if a test failed** — no change expected. If the default-weight test failed, verify `normalizeWeight` is called in `admit` before `fits`.

- [ ] **Step 4: Run full package test suite**

Run: `cd packages/jxl-scheduler && npm test`
Expected: PASS (existing suite + new gate tests; no regressions).

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-scheduler/test/memory-admission-gate.test.ts
git commit -m "test(scheduler): lock over-budget-alone, default weight, idempotent release"
```

---

## Task 4: Extend the `AdmissionGate` interface with optional `weight`

**Files:**
- Modify: `packages/jxl-scheduler/src/types.ts:49`

- [ ] **Step 1: Write the failing check** — the gate already types `admit(sessionId, priority, weight?)`; assert the interface allows a weight-less caller and a weighted caller. Append to the gate test file:

```ts
describe("AdmissionGate interface", () => {
  it("accepts implementations called with or without weight", async () => {
    const gate = new MemoryWeightedAdmissionGate({ budgetBytes: 300 * MB });
    // Both call shapes must type-check and run.
    const r1 = await gate.admit("a", "visible");
    const r2 = await gate.admit("b", "near", 50 * MB);
    r1(); r2();
    assert.equal(gate.runningBytes, 0);
  });
});
```

- [ ] **Step 2: Run to verify it fails at compile** — because `types.ts` `admit` has no `weight` param, the class's wider signature is fine but the interface must permit the 3-arg call for arbitrary `AdmissionGate` values used elsewhere.

Run: `cd packages/jxl-scheduler && npx tsc -p tsconfig.test.json`
Expected: The test compiles against the class (which has the param), so it may PASS. Proceed to make the *interface* carry `weight` so the scheduler (which holds an `AdmissionGate`, not the concrete class) can pass it in Task 5.

- [ ] **Step 3: Edit the interface**

In `packages/jxl-scheduler/src/types.ts`, change the `admit` signature (line ~49):

```ts
  admit(sessionId: string, priority: Priority, weight?: number): Promise<AdmissionRelease>;
```

Add a doc line above it:

```ts
   * @param weight optional estimated memory footprint (output bytes) of the task; a
   *   memory-weighted gate uses it to bound the concurrent working set. Ignored by
   *   gates that only count sessions.
```

- [ ] **Step 4: Run test + typecheck to verify it passes**

Run: `cd packages/jxl-scheduler && npx tsc -p tsconfig.test.json && node --test dist-test/test/memory-admission-gate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-scheduler/src/types.ts packages/jxl-scheduler/test/memory-admission-gate.test.ts
git commit -m "feat(scheduler): AdmissionGate.admit accepts optional memory weight"
```

---

## Task 5: Scheduler passes `weight` to `admit`

**Files:**
- Modify: `packages/jxl-scheduler/src/scheduler.ts:296-302` (acquireSlot params), `:348` (admit call)
- Test: `packages/jxl-scheduler/test/scheduler.admission.test.ts`

- [ ] **Step 1: Write the failing test** — replace the stub file contents with a spy-gate test.

```ts
// packages/jxl-scheduler/test/scheduler.admission.test.ts
// sched-2: the scheduler forwards acquireSlot({weight}) to AdmissionGate.admit(...).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { FakeWorker, fakeWorkerFactory } from "./helpers.js";
import type { AdmissionGate, AdmissionRelease } from "../src/types.js";
import type { MsgDecodeStart } from "@casabio/jxl-core/protocol";

function decodeStart(sessionId: string): MsgDecodeStart {
  return { type: "decode_start", sessionId, format: "rgba8", region: null, downsample: 1,
    progressionTarget: "final", emitEveryPass: true, progressiveDetail: null, preserveIcc: true,
    preserveMetadata: true, priority: "visible", budgetMs: null, targetWidth: null,
    targetHeight: null, fitMode: null } as MsgDecodeStart;
}

describe("scheduler admission weight", () => {
  it("forwards the acquireSlot weight to gate.admit and releases it on completion", async () => {
    const calls: Array<{ sessionId: string; weight: number | undefined }> = [];
    let released = 0;
    const gate: AdmissionGate = {
      admit: (sessionId, _priority, weight): Promise<AdmissionRelease> => {
        calls.push({ sessionId, weight });
        return Promise.resolve(() => { released++; });
      },
    };
    const workers: FakeWorker[] = [];
    const scheduler = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 2,
      admissionGate: gate,
    });
    await scheduler.acquireSlot({
      sessionId: "s1", priority: "visible", startMsg: decodeStart("s1"),
      sourceKey: null, signal: null, weight: 12345,
    });
    assert.deepEqual(calls, [{ sessionId: "s1", weight: 12345 }]);
    // Drive the session to completion so the admission token is released.
    scheduler.cancelSession("s1");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(released, 1, "admission token released on session end");
    await scheduler.shutdown();
  });
});
```

> The `Scheduler` constructor options are `{ factory, maxWorkers, admissionGate, ... }` (see `scheduler.ts:40-95` and existing tests). The invariant that must hold: `calls[0].weight === 12345`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jxl-scheduler && npx tsc -p tsconfig.test.json && node --test dist-test/test/scheduler.admission.test.js`
Expected: FAIL — `acquireSlot` does not accept `weight` (tsc error) / `calls[0].weight` is `undefined`.

- [ ] **Step 3: Edit the scheduler**

In `packages/jxl-scheduler/src/scheduler.ts`, add `weight?: number;` to the `acquireSlot` params object type (after `signal: AbortSignal | null;`):

```ts
  async acquireSlot(params: {
    sessionId: string;
    priority: Priority;
    startMsg: MsgDecodeStart | MsgEncodeStart;
    sourceKey: string | null;
    signal: AbortSignal | null;
    weight?: number;
  }): Promise<{ workerId: number }> {
```

Change the admit call (line ~348) to forward the weight:

```ts
      const release = await this.admissionGate.admit(params.sessionId, params.priority, params.weight);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jxl-scheduler && npx tsc -p tsconfig.test.json && node --test dist-test/test/scheduler.admission.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-scheduler/src/scheduler.ts packages/jxl-scheduler/test/scheduler.admission.test.ts
git commit -m "feat(scheduler): forward acquireSlot weight to AdmissionGate.admit"
```

---

## Task 6: Decode session supplies `expectedOutputBytes` weight

**Files:**
- Modify: `packages/jxl-session/src/decode-session.ts` (opts type + acquireSlot call ~104)
- Test: `packages/jxl-session/test/` (decode-session unit test — check the dir for the existing pattern; if none targets acquireSlot, add `decode-session.weight.test.ts`)

- [ ] **Step 1: Write the failing test** — assert the decode session passes a weight derived from `expectedOutputBytes`, falling back to `targetWidth*targetHeight*4`, else `undefined`.

```ts
// packages/jxl-session/test/decode-session.weight.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeDecodeWeight } from "../src/decode-session.js";

describe("computeDecodeWeight", () => {
  it("uses expectedOutputBytes when provided", () => {
    assert.equal(computeDecodeWeight({ expectedOutputBytes: 5_000_000 }), 5_000_000);
  });
  it("derives width*height*4 from target dims when no explicit bytes", () => {
    assert.equal(computeDecodeWeight({ targetWidth: 256, targetHeight: 256 }), 256 * 256 * 4);
  });
  it("returns undefined when neither is known (gate applies its default)", () => {
    assert.equal(computeDecodeWeight({}), undefined);
  });
  it("ignores non-finite / non-positive values", () => {
    assert.equal(computeDecodeWeight({ expectedOutputBytes: -1, targetWidth: 10, targetHeight: 10 }), 10 * 10 * 4);
    assert.equal(computeDecodeWeight({ expectedOutputBytes: Number.NaN }), undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jxl-session && npm test 2>&1 | head -30`
Expected: FAIL — `computeDecodeWeight` is not exported.

- [ ] **Step 3: Implement + wire**

In `packages/jxl-session/src/decode-session.ts`, add to the decode options interface (find `interface DecodeOptions`/the opts type used by the ctor):

```ts
  /** Estimated decoded output size in bytes; the scheduler's memory gate uses it as the
   *  admission weight. If absent, derived from targetWidth*targetHeight*4, else the gate default. */
  expectedOutputBytes?: number;
```

Add the exported helper (near the top-level exports of the module):

```ts
export function computeDecodeWeight(opts: {
  expectedOutputBytes?: number;
  targetWidth?: number | null;
  targetHeight?: number | null;
}): number | undefined {
  const explicit = opts.expectedOutputBytes;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return explicit;
  const w = opts.targetWidth;
  const h = opts.targetHeight;
  if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) {
    const bytes = w * h * 4;
    if (Number.isFinite(bytes) && bytes <= Number.MAX_SAFE_INTEGER) return bytes;
  }
  return undefined;
}
```

In the `initAcquire` `scheduler.acquireSlot({...})` call (~104), add:

```ts
        weight: computeDecodeWeight(opts),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jxl-session && npm test 2>&1 | head -30`
Expected: PASS (new weight tests + existing suite).

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-session/src/decode-session.ts packages/jxl-session/test/decode-session.weight.test.ts
git commit -m "feat(session): decode supplies expectedOutputBytes admission weight"
```

---

## Task 7: Encode session supplies `width*height*bpp` weight

**Files:**
- Modify: `packages/jxl-session/src/encode-session.ts` (bpp helper + acquireSlot call ~130)
- Test: `packages/jxl-session/test/encode-session.weight.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/jxl-session/test/encode-session.weight.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeEncodeWeight } from "../src/encode-session.js";

describe("computeEncodeWeight", () => {
  it("computes width*height*bpp per format", () => {
    assert.equal(computeEncodeWeight({ width: 100, height: 100, format: "rgba8" }), 100 * 100 * 4);
    assert.equal(computeEncodeWeight({ width: 100, height: 100, format: "rgb8" }), 100 * 100 * 3);
    assert.equal(computeEncodeWeight({ width: 100, height: 100, format: "rgba16" }), 100 * 100 * 8);
  });
  it("returns undefined for hostile/overflowing dims (gate applies its default)", () => {
    assert.equal(computeEncodeWeight({ width: 2 ** 30, height: 2 ** 30, format: "rgba16" }), undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jxl-session && npm test 2>&1 | head -30`
Expected: FAIL — `computeEncodeWeight` not exported.

- [ ] **Step 3: Implement + wire** — reuse the exact bpp mapping already in `getStats` (encode-session.ts:220).

Add the exported helper:

```ts
export function computeEncodeWeight(opts: {
  width: number;
  height: number;
  format: string;
}): number | undefined {
  const bpp = opts.format === "rgba8" ? 4 : opts.format === "rgba16" ? 8 : opts.format === "rgb8" ? 3 : 16;
  const bytes = opts.width * opts.height * bpp;
  return Number.isFinite(bytes) && bytes > 0 && bytes <= Number.MAX_SAFE_INTEGER ? bytes : undefined;
}
```

In the `initAcquire` `scheduler.acquireSlot({...})` call (~130), add:

```ts
        weight: computeEncodeWeight(opts),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jxl-session && npm test 2>&1 | head -30`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-session/src/encode-session.ts packages/jxl-session/test/encode-session.weight.test.ts
git commit -m "feat(session): encode supplies width*height*bpp admission weight"
```

---

## Task 8: App wiring — construct + inject the gate, raise the pool ceiling

**Files:**
- Modify: the context/app construction site. Identify it first:
  - `grep -rn "maxWorkers\|admissionGate\|new JxlContext\|createContext\|maxActiveDecoders" packages/jxl-session/src web src` to find where the scheduler `maxWorkers` and options are chosen and where the gallery decodes are issued.
- Likely: `packages/jxl-session/src/context-base.ts` (`createScheduler(..., maxWorkers, ...)`) and the app entry that constructs the context / gallery.

- [ ] **Step 1: Write the failing integration test** — a scheduler-level test proving that with a memory gate injected and a raised pool ceiling, more cheap tasks run concurrently than the old flat 4.

```ts
// packages/jxl-scheduler/test/scheduler.memory-concurrency.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { FakeWorker, fakeWorkerFactory } from "./helpers.js";
import { MemoryWeightedAdmissionGate } from "../src/memory-admission-gate.js";
import type { MsgDecodeStart } from "@casabio/jxl-core/protocol";

function decodeStart(id: string): MsgDecodeStart {
  return { type: "decode_start", sessionId: id, format: "rgba8", region: null, downsample: 1,
    progressionTarget: "final", emitEveryPass: true, progressiveDetail: null, preserveIcc: true,
    preserveMetadata: true, priority: "visible", budgetMs: null, targetWidth: null,
    targetHeight: null, fitMode: null } as MsgDecodeStart;
}

describe("memory-weighted concurrency", () => {
  it("runs many cheap decodes concurrently under a byte budget (pool ceiling raised)", async () => {
    const MB = 1024 * 1024;
    const gate = new MemoryWeightedAdmissionGate({ budgetBytes: 640 * MB });
    const workers: FakeWorker[] = [];
    const scheduler = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 16,         // ceiling raised so the byte budget is the limiter
      admissionGate: gate,
    });
    // 8 cheap (80MB) decodes: 8*80 = 640 ≤ budget → all admit concurrently.
    const acquired: Array<Promise<{ workerId: number }>> = [];
    for (let i = 0; i < 8; i++) {
      acquired.push(scheduler.acquireSlot({
        sessionId: `c${i}`, priority: "visible", startMsg: decodeStart(`c${i}`),
        sourceKey: null, signal: null, weight: 80 * MB,
      }));
    }
    await Promise.all(acquired);
    assert.equal(gate.pendingCount, 0, "all 8 cheap decodes admitted concurrently");
    assert.equal(gate.runningBytes, 640 * MB);
    await scheduler.shutdown();
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd packages/jxl-scheduler && npx tsc -p tsconfig.test.json && node --test dist-test/test/scheduler.memory-concurrency.test.js`
Expected: PASS if `maxWorkers: 16` is accepted and workers spawn (fake factory). If the pool caps below 8, inspect `pool.ts maxSize` and the `Scheduler` → pool `maxSize` plumbing; the pool `maxSize` must equal the passed `maxWorkers`.

- [ ] **Step 3: Wire the app** — in the context/app construction site found above:
  1. Compute `maxWorkers`: when a memory gate is used, raise the ceiling to `Math.max(existingClamp, 2 * hardwareConcurrency)` (config-gated — keep the existing clamp when no gate). Example, in `context-base.ts` where `maxWorkers` is chosen:

```ts
     const hwc = Math.max(1, (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 4);
     const maxWorkers = opts?.memoryGate ? Math.max(baseMax, 2 * hwc) : baseMax;
```

  2. Construct + inject the gate when the app opts in:

```ts
     const admissionGate = opts?.memoryGate
       ? new MemoryWeightedAdmissionGate({ budgetBytes: opts.memoryBudgetBytes ?? 512 * 1024 * 1024 })
       : opts?.admissionGate;
```

     Pass `admissionGate` into `createScheduler`/`new Scheduler({ ..., admissionGate })`. Add `memoryGate?: boolean` and `memoryBudgetBytes?: number` to `ContextOptions`.
  3. Gallery decode calls pass `expectedOutputBytes` (the requested pyramid level: `targetWidth*targetHeight*4`, or the manifest's level bytes). If the gallery already passes `targetWidth/targetHeight`, Task 6's derivation covers it with no further change.

- [ ] **Step 4: Run the full workspace tests**

Run: `cd packages/jxl-scheduler && npm test && cd ../jxl-session && npm test`
Expected: PASS (all suites). If a build config lists new files, ensure `tsconfig`/`package.json` globs include `memory-admission-gate.ts` (they use `src/*.ts` globs — verify).

- [ ] **Step 5: Commit**

```bash
git add packages/jxl-scheduler/test/scheduler.memory-concurrency.test.ts packages/jxl-session/src/context-base.ts
git commit -m "feat(session): opt-in memory gate + raised pool ceiling wiring"
```

---

## Task 9: Docs + rejected-log update

**Files:**
- Modify: `CLAUDE.md` (submodule root of this repo) — note the memory gate is opt-in and evidence-backed.
- Modify: `docs/1 rejected optimizations.md` — annotate G2-F6: the memory-weighted admission gate is now IMPLEMENTED (evidence-backed), distinct from the MT-routing hint that remains rejected.

- [ ] **Step 1: Append to `docs/1 rejected optimizations.md`** (under or near G2-F6):

```markdown
### G2-F6 follow-up (2026-07-02): memory-weighted admission gate IMPLEMENTED
The concurrency-shape concern is now benchmark-justified (project-preview-concurrency-evidence:
pyramid decode ~80MB-flat scales past core count; full decode ~250MB/worker). Shipped opt-in
`MemoryWeightedAdmissionGate` (jxl-scheduler): admission weight ∝ output bytes, pool ceiling
raised when the gate is present. This is DISTINCT from the still-rejected MT-routing work-class
hint in G2-F6 (that concerned router.pick, not admission). Spec:
docs/superpowers/specs/2026-07-02-memory-admission-gate-design.md.
```

- [ ] **Step 2: Run the full test suites one more time**

Run: `cd packages/jxl-scheduler && npm test && cd ../jxl-session && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "docs/1 rejected optimizations.md"
git commit -m "docs: memory-weighted admission gate implemented (G2-F6 follow-up, evidence-backed)"
```

---

## Deferred (separate follow-up branches, not this plan)

- **Validation benchmark**: drive `examples/*_concurrency.rs` (or a JS equivalent) to confirm the ~2× gallery / +66% cheap-task numbers with the gate live.
- **Cancel-while-queued optimization**: an explicit gate `cancel(sessionId)` so a cancelled queued task never briefly admits (correct today, just mildly wasteful).
- **Device-memory-derived budget** at the app layer (`navigator.deviceMemory`).
