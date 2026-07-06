import { test } from "node:test";
import assert from "node:assert/strict";
import { searchQuality } from "../butteraugli-search.mjs";

// Synthetic codec: higher quality => lower butteraugli, monotonic.
// butter(q) = 6 - q/20  (q=20 -> 5.0, q=100 -> 1.0)
const fakeMeasure = async (q) => 6 - q / 20;

test("hits target within tolerance", async () => {
  const r = await searchQuality({ measure: fakeMeasure, target: 2.0, tol: 0.15, qMin: 1, qMax: 100, maxIters: 8 });
  assert.ok(Math.abs(r.achieved - 2.0) <= 0.15, `achieved ${r.achieved}`);
  assert.ok(r.quality >= 1 && r.quality <= 100);
  assert.equal(r.converged, true);
  assert.ok(r.iters <= 8);
});

test("keeps closest when not converged in budget", async () => {
  const r = await searchQuality({ measure: fakeMeasure, target: 2.0, tol: 0.0001, qMin: 1, qMax: 100, maxIters: 3 });
  assert.equal(r.converged, false);
  assert.ok(r.achieved != null && r.quality != null);
});

test("clamps target below achievable floor", async () => {
  const r = await searchQuality({ measure: fakeMeasure, target: 0.5, tol: 0.15, qMin: 1, qMax: 100, maxIters: 8 });
  assert.equal(r.quality, 100); // best it can do
});
