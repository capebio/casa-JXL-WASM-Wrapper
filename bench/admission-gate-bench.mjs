// Simulated throughput/memory benchmark for the memory-weighted admission gate.
// Drives the REAL MemoryWeightedAdmissionGate through a workload where each task
// holds a worker for a simulated "decode" duration, then measures makespan (throughput)
// and peak memory (sum of weights of tasks actually occupying a worker).
//
// Three configs:
//   A "today"      : worker cap 4, no memory gate (the current flat count cap)
//   B "naive-highcap": worker cap 2*HWC, no memory gate (raises concurrency but memory unbounded)
//   C "gate"       : worker cap 2*HWC + MemoryWeightedAdmissionGate(budget) (the feature)
//
// Run: node bench/admission-gate-bench.mjs
import { MemoryWeightedAdmissionGate } from "../packages/jxl-scheduler/dist/memory-admission-gate.js";
import os from "node:os";

const MB = 1024 * 1024;
const HWC = os.cpus().length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Simple async counting semaphore = the worker-count cap (pool maxWorkers).
class CountSem {
  constructor(n) { this.n = n; this.free = n; this.q = []; }
  async acquire() {
    if (this.free > 0) { this.free--; return; }
    await new Promise((res) => this.q.push(res));
    this.free--;
  }
  release() { this.free++; const r = this.q.shift(); if (r) r(); }
}

async function run(tasks, { cap, gate }) {
  const memSem = new CountSem(cap);
  let occBytes = 0, peakBytes = 0, occCount = 0, peakConc = 0;
  const t0 = performance.now();
  await Promise.all(tasks.map(async (t) => {
    // Mirror the scheduler: admit (gate) BEFORE acquiring a worker slot.
    const relMem = gate ? await gate.admit(t.id, t.priority, t.weight) : null;
    await memSem.acquire();
    // Now "decoding": occupies a worker + its output memory.
    occBytes += t.weight; occCount++;
    if (occBytes > peakBytes) peakBytes = occBytes;
    if (occCount > peakConc) peakConc = occCount;
    await sleep(t.durMs);
    occBytes -= t.weight; occCount--;
    memSem.release();
    if (relMem) relMem();
  }));
  const makespan = performance.now() - t0;
  return { makespan, peakBytes, peakConc };
}

function mkTasks(spec) {
  // spec: [{ n, weight, durMs, priority }]
  const tasks = [];
  let id = 0;
  for (const s of spec) for (let i = 0; i < s.n; i++)
    tasks.push({ id: `t${id++}`, weight: s.weight, durMs: s.durMs, priority: s.priority ?? "visible" });
  return tasks;
}

const workloads = {
  "gallery thumbnails (200 × 256px)": mkTasks([{ n: 200, weight: 256 * 256 * 4, durMs: 15 }]),
  "full-res batch (30 × 24MP)":       mkTasks([{ n: 30, weight: 24_000_000 * 4, durMs: 120 }]),
  "mixed (150 thumb + 10 full)":      mkTasks([
    { n: 150, weight: 256 * 256 * 4, durMs: 15, priority: "visible" },
    { n: 10, weight: 24_000_000 * 4, durMs: 120, priority: "background" },
  ]),
};

const BUDGET = 512 * MB;

console.log(`HWC=${HWC}  budget=${(BUDGET / MB) | 0}MB  cap: today=4, raised=${2 * HWC}\n`);

for (const [name, tasks] of Object.entries(workloads)) {
  console.log(`# ${name}  (${tasks.length} tasks)`);
  const configs = [
    ["A today (cap 4, no gate)", { cap: 4, gate: null }],
    [`B naive (cap ${2 * HWC}, no gate)`, { cap: 2 * HWC, gate: null }],
    [`C gate  (cap ${2 * HWC} + ${(BUDGET / MB) | 0}MB budget)`, { cap: 2 * HWC, gate: new MemoryWeightedAdmissionGate({ budgetBytes: BUDGET }) }],
  ];
  let base = null;
  for (const [label, cfg] of configs) {
    const r = await run(tasks, cfg);
    if (base === null) base = r.makespan;
    const thr = (tasks.length / (r.makespan / 1000)).toFixed(0);
    const spd = (base / r.makespan).toFixed(2);
    console.log(
      `  ${label.padEnd(40)} makespan ${r.makespan.toFixed(0).padStart(6)}ms  ` +
      `thr ${thr.padStart(5)}/s  peakConc ${String(r.peakConc).padStart(3)}  ` +
      `peakMem ${(r.peakBytes / MB).toFixed(0).padStart(5)}MB  (${spd}× vs A)`,
    );
  }
  console.log("");
}
