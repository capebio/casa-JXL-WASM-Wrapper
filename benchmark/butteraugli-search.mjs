// Binary-search a codec quality knob to hit a target butteraugli distance.
// Assumes butteraugli decreases monotonically as quality increases.
// `measure(q)` -> Promise<number> (butteraugli of encode@q vs source).
export async function searchQuality({ measure, target, tol = 0.15, qMin = 1, qMax = 100, maxIters = 8 }) {
  let lo = qMin, hi = qMax;
  let best = null; // { quality, achieved, dist }
  let iters = 0;
  const consider = (q, achieved) => {
    const dist = Math.abs(achieved - target);
    if (!best || dist < best.dist) best = { quality: q, achieved, dist };
  };
  // Probe endpoints first so out-of-range targets clamp correctly.
  const aHi = await measure(qMax); iters++; consider(qMax, aHi);
  if (aHi > target) { // even max quality can't reach target (target too low/strict)
    return { quality: qMax, achieved: aHi, converged: aHi - target <= tol, iters };
  }
  const aLo = await measure(qMin); iters++; consider(qMin, aLo);
  if (aLo < target) { // even min quality overshoots (target too lenient)
    return { quality: qMin, achieved: aLo, converged: target - aLo <= tol, iters };
  }
  while (iters < maxIters) {
    const mid = Math.round((lo + hi) / 2);
    const a = await measure(mid); iters++;
    consider(mid, a);
    if (Math.abs(a - target) <= tol) return { quality: mid, achieved: a, converged: true, iters };
    if (a > target) lo = mid; else hi = mid; // a>target => need more quality => raise lo
    if (hi - lo <= 1) break;
  }
  return { quality: best.quality, achieved: best.achieved, converged: best.dist <= tol, iters };
}
