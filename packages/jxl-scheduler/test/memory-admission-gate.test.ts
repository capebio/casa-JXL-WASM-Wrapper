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

describe("MemoryWeightedAdmissionGate edge cases", () => {
  it("admits a single over-budget task alone, then queues the next", async () => {
    const gate = new MemoryWeightedAdmissionGate({ budgetBytes: 100 * MB });
    const rel = await gate.admit("huge", "visible", 500 * MB);
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
    await gate.admit("a", "visible");
    assert.equal(gate.runningBytes, 200 * MB);
    let admittedB = false;
    gate.admit("b", "visible").then(() => { admittedB = true; });
    await Promise.resolve();
    assert.equal(admittedB, false);
    assert.equal(gate.pendingCount, 1);
  });

  it("treats a non-positive / non-finite weight as the default", async () => {
    // Budget fits all four so none queue; each must consume exactly the default weight,
    // proving 0 / negative / NaN / Infinity all normalize to defaultWeightBytes.
    const gate = new MemoryWeightedAdmissionGate({ budgetBytes: 1000 * MB, defaultWeightBytes: 200 * MB });
    await gate.admit("a", "visible", 0);
    await gate.admit("b", "visible", -5);
    await gate.admit("c", "visible", Number.NaN);
    await gate.admit("d", "visible", Number.POSITIVE_INFINITY);
    assert.equal(gate.runningBytes, 800 * MB); // 4 × 200MB default
    assert.equal(gate.pendingCount, 0);
  });

  it("release is idempotent (double-call frees budget once)", async () => {
    const gate = new MemoryWeightedAdmissionGate({ budgetBytes: 300 * MB });
    const rel = await gate.admit("a", "visible", 100 * MB);
    rel();
    rel();
    assert.equal(gate.runningBytes, 0);
  });
});

describe("AdmissionGate interface", () => {
  it("accepts implementations called with or without weight", async () => {
    // Budget fits both (a=default 256MB weightless + b=50MB) so neither queues.
    const gate = new MemoryWeightedAdmissionGate({ budgetBytes: 512 * MB });
    const r1 = await gate.admit("a", "visible");        // no weight → default
    const r2 = await gate.admit("b", "near", 50 * MB);  // explicit weight
    r1(); r2();
    assert.equal(gate.runningBytes, 0);
  });
});
