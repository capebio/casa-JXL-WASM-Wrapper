// Node test for the pure browser-calibration core.
// Run: node --test web/calibration/calibration.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { preset, renderRgba8, DATASETS } from "./fractal.mjs";
import { candidateSplits, pickSplit, measureAndPick } from "./grid.mjs";
import * as profile from "./profile.mjs";
import { ensureCalibrated, safeDefaultSplit } from "./calibrate.mjs";

test("fractal: renders RGBA8 of requested size, opaque, non-flat", () => {
  const spec = preset("mandelbrot-full", 32, 24);
  const px = renderRgba8(spec);
  assert.equal(px.length, 32 * 24 * 4);
  for (let i = 3; i < px.length; i += 4) assert.equal(px[i], 255);
  const first = [px[0], px[1], px[2]].join(",");
  let varied = false;
  for (let i = 0; i < px.length; i += 4) {
    if ([px[i], px[i + 1], px[i + 2]].join(",") !== first) varied = true;
  }
  assert.ok(varied, "render is flat");
});

test("fractal: deterministic across renders", () => {
  const spec = preset("julia-a", 40, 30);
  assert.deepEqual(Array.from(renderRgba8(spec)), Array.from(renderRgba8(spec)));
});

test("fractal: every preset renders", () => {
  for (const id of DATASETS) {
    const px = renderRgba8(preset(id, 24, 24));
    assert.equal(px.length, 24 * 24 * 4);
  }
});

test("fractal: seahorse is high-detail", () => {
  const px = renderRgba8(preset("mandelbrot-seahorse", 48, 48));
  const seen = new Set();
  for (let i = 0; i < px.length; i += 4) seen.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
  assert.ok(seen.size > 100, `too flat: ${seen.size} colours`);
});

test("grid: candidate splits never exceed the concurrency budget", () => {
  for (const hc of [1, 2, 4, 8, 12, 16]) {
    for (const { workers, threadsPerWorker } of candidateSplits(hc)) {
      assert.ok(workers * threadsPerWorker <= hc, `${workers}x${threadsPerWorker} > ${hc}`);
      assert.ok(workers >= 1 && threadsPerWorker >= 1);
    }
  }
});

test("grid: pick prefers fewer total threads on a tie", () => {
  const measured = [
    { workers: 1, threadsPerWorker: 1, throughput: 100 },
    { workers: 2, threadsPerWorker: 2, throughput: 200 }, // product 4
    { workers: 3, threadsPerWorker: 4, throughput: 196 }, // product 12, within 5%
  ];
  assert.deepEqual(pickSplit(measured), { workers: 2, threadsPerWorker: 2 });
});

test("grid: measureAndPick drives the injected measurer", async () => {
  const seen = [];
  const { chosen, grid } = await measureAndPick(4, async (w, t) => {
    seen.push([w, t]);
    return w * t; // reward more threads
  });
  assert.ok(grid.length > 0);
  assert.ok(seen.length === grid.length);
  assert.ok(chosen.workers * chosen.threadsPerWorker <= 4);
});

test("profile: makeProfile matches current, mismatch does not apply", () => {
  profile.clearApplied();
  const p = profile.makeProfile({ workers: 2, threadsPerWorker: 2, tier: "simd-mt" });
  assert.ok(profile.matchesCurrent(p));
  assert.ok(profile.apply(p));
  assert.deepEqual(profile.applied(), { workers: 2, threadsPerWorker: 2, tier: "simd-mt" });

  const stale = profile.makeProfile({ workers: 9, threadsPerWorker: 9 });
  stale.signature = { ...stale.signature, hardwareConcurrency: 999 };
  assert.ok(!profile.matchesCurrent(stale));
  profile.clearApplied();
  assert.ok(!profile.apply(stale));
  assert.equal(profile.applied(), null);
});

test("calibrate: safe default never oversubscribes", () => {
  const sig = { hardwareConcurrency: 12, sab: true, coi: false, worker: false, wasm: true };
  const s = safeDefaultSplit(sig);
  assert.ok(s.workers * s.threadsPerWorker <= 12);
  assert.equal(s.threadsPerWorker, 1);
});

test("calibrate: ensureCalibrated with a measurer picks + applies (threaded env)", async () => {
  const g = globalThis;
  const savedCOI = Object.getOwnPropertyDescriptor(g, "crossOriginIsolated");
  const hadWorker = "Worker" in g;
  g.crossOriginIsolated = true;
  if (!hadWorker) g.Worker = function () {};
  profile.clearApplied();
  try {
    const lines = [];
    const out = await ensureCalibrated({
      measureSplit: async (w, t) => 1000 / (w * t + 1) + w, // some non-trivial curve
      emit: (l) => lines.push(l),
      nowMs: 123,
    });
    assert.ok(out.applied);
    assert.ok(out.fresh);
    assert.ok(out.profile.selections.workers >= 1);
    assert.ok(lines.length > 0);
  } finally {
    if (savedCOI) Object.defineProperty(g, "crossOriginIsolated", savedCOI);
    else delete g.crossOriginIsolated;
    if (!hadWorker) delete g.Worker;
    profile.clearApplied();
  }
});
