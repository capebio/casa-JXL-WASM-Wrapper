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

describe("MemoryWeightedAdmissionGate priority", () => {
  it("drains the highest-priority waiter first, even if enqueued later", async () => {
    const gate = new MemoryWeightedAdmissionGate({ budgetBytes: 100 * MB });
    const rel = await gate.admit("running", "visible", 100 * MB); // fills budget
    const order: string[] = [];
    const pBg = gate.admit("bg", "background", 100 * MB).then((r) => { order.push("bg"); return r; });
    const pVis = gate.admit("vis", "visible", 100 * MB).then((r) => { order.push("vis"); return r; });
    await Promise.resolve();
    assert.equal(gate.pendingCount, 2);
    rel();
    const r1 = await pVis;
    assert.deepEqual(order, ["vis"]);
    r1();
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
