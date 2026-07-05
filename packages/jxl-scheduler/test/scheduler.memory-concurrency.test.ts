// The memory-weighted gate + a raised worker ceiling let many cheap decodes run
// concurrently under a byte budget (vs the old flat count cap of ~4).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { FakeWorker, fakeWorkerFactory } from "./helpers.js";
import { MemoryWeightedAdmissionGate } from "../src/memory-admission-gate.js";
import type { MsgDecodeStart } from "@casabio/jxl-core/protocol";

function decodeStart(id: string): MsgDecodeStart {
  return { type: "decode_start", sessionId: id, format: "rgba8", region: null, downsample: 1,
    progressionTarget: "final", emitEveryPass: true, progressiveDetail: null, suppressDuplicateProgress: false, preserveIcc: true,
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
      maxWorkers: 16, // ceiling raised so the byte budget is the limiter
      admissionGate: gate,
    });
    // 8 cheap (80MB) decodes: 8*80 = 640 <= budget -> all admit concurrently.
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
