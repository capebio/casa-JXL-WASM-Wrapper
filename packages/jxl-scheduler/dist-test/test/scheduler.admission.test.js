// sched-2: the scheduler forwards acquireSlot({weight}) to AdmissionGate.admit(...).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { FakeWorker, fakeWorkerFactory } from "./helpers.js";
function decodeStart(sessionId) {
    return { type: "decode_start", sessionId, format: "rgba8", region: null, downsample: 1,
        progressionTarget: "final", emitEveryPass: true, progressiveDetail: null, preserveIcc: true,
        preserveMetadata: true, priority: "visible", budgetMs: null, targetWidth: null,
        targetHeight: null, fitMode: null };
}
describe("scheduler admission weight", () => {
    it("forwards the acquireSlot weight to gate.admit and releases it on completion", async () => {
        const calls = [];
        let released = 0;
        const gate = {
            admit: (sessionId, _priority, weight) => {
                calls.push({ sessionId, weight });
                return Promise.resolve(() => { released++; });
            },
        };
        const workers = [];
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
        scheduler.cancelSession("s1");
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(released, 1, "admission token released on session end");
        await scheduler.shutdown();
    });
});
//# sourceMappingURL=scheduler.admission.test.js.map