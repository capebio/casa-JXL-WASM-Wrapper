// jxl-scheduler/test/scheduler.dedupe-promotion.test.ts
//
// Coverage for scheduler.ts lines 573-578:
//
//   // Transfer gate admission (if held) to promoted so it is released when promoted work ends.
//   const grel = this.gateReleases.get(sessionId);
//   if (grel !== undefined && promotedRecord !== undefined) {
//     this.gateReleases.delete(sessionId);
//     this.gateReleases.set(promotedTo, grel);
//   }
//
// Trigger: cancelSession(primary) while it still has a dedupe subscriber.
//   dedupe.cancelSubscriber() returns { cancelWorker: false, promotedTo: subscriber }
//   → scheduler promotes the subscriber to primary, transferring (not releasing) the gate token.
// Assertion: the released counter increments exactly once — when the promoted session ends —
//   and does not increment during promotion, on re-cancel, or on shutdown.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { FakeWorker, fakeWorkerFactory, makeDecodeStart } from "./helpers.js";
import type { AdmissionGate } from "../src/types.js";

describe("scheduler dedupe promotion: gate-token transfer", () => {
  it("transfers the held gate token from a cancelled primary to its promoted subscriber and releases it exactly once", async () => {
    // Spy gate: resolves immediately; tracks how many times admit() fires and
    // how many times each returned release callback is invoked.
    let admitCount = 0;
    let releaseCount = 0;
    const gate: AdmissionGate = {
      admit: (_sessionId, _priority, _weight) => {
        admitCount++;
        return Promise.resolve(() => {
          releaseCount++;
        });
      },
    };

    const workers: FakeWorker[] = [];
    const sched = new Scheduler({
      factory: fakeWorkerFactory(workers),
      maxWorkers: 2,
      idleTimeoutMs: 60_000,
      admissionGate: gate,
    });

    // ── Step 1: primary acquires a slot ──────────────────────────────────────
    // admissionGate.admit() is awaited for primaries only.
    // After acquireSlot resolves, gateReleases["prim"] = release callback.
    await sched.acquireSlot({
      sessionId: "prim",
      priority: "background",
      startMsg: makeDecodeStart("prim", "background"),
      sourceKey: "shared-key",
      signal: null,
    });

    assert.equal(admitCount, 1, "gate.admit called once for the primary");
    assert.equal(releaseCount, 0, "gate token held (not yet released)");

    // ── Step 2: subscriber fans out onto the same sourceKey ──────────────────
    // dedupe.subscribe() is called; gate is NOT called for subscribers.
    // "sub" gets a lightweight session record with isSubscriber: true.
    await sched.acquireSlot({
      sessionId: "sub",
      priority: "background",
      startMsg: makeDecodeStart("sub", "background"),
      sourceKey: "shared-key",
      signal: null,
    });

    assert.equal(admitCount, 1, "gate.admit still called exactly once after subscriber joins");
    assert.equal(releaseCount, 0, "gate token still held after subscriber joins");

    // ── Step 3: cancel the primary while the subscriber is still live ────────
    // dedupe.cancelSubscriber("prim") finds "sub" as the only remaining candidate
    // and returns { cancelWorker: false, promotedTo: "sub" }.
    // Scheduler lines 573-578 execute:
    //   gateReleases.delete("prim")
    //   gateReleases.set("sub", grel)
    // The token is TRANSFERRED, not released.
    sched.cancelSession("prim");

    // Drain one microtask tick so any post-cancel async bookkeeping settles.
    await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(releaseCount, 0, "gate token must NOT be released during promotion transfer");
    assert.equal(admitCount, 1, "no extra admit call during promotion");

    // ── Step 4: promoted session completes ───────────────────────────────────
    // completeSession → cleanupSession → releaseAdmission("sub")
    //   → gateReleases.get("sub") returns the transferred release callback
    //   → release() is called, releaseCount becomes 1
    //   → gateReleases.delete("sub")
    sched.completeSession("sub");

    assert.equal(releaseCount, 1, "gate token released exactly once when promoted session ends");
    assert.equal(admitCount, 1, "admit count unchanged after promoted session completes");

    // ── Step 5: shutdown must not double-release ─────────────────────────────
    // gateReleases is now empty; releaseAllAdmissions() is a no-op.
    await sched.shutdown();

    assert.equal(releaseCount, 1, "gate token not double-released on shutdown");
  });
});
