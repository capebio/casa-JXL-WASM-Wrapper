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
    await Promise.resolve();
    assert.equal(admittedC, false, "c must wait — 200+200 > 300");
    assert.equal(gate.pendingCount, 1);
    relA();
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
