// Joint worker × threads-per-worker grid — the browser analogue of the native thread
// sweep. The pathological case the app ships today is the PRODUCT: min(HC,12) workers
// each initialising HC rayon threads = up to 144 live threads on a 12-core box. This
// picks the (workers, threadsPerWorker) split that maximises throughput while keeping
// the product within the effective concurrency, and prefers the smaller total on a
// tie so we never over-subscribe for no gain. Pure + timer-injected → unit-testable.

/** Candidate splits whose thread product does not exceed `hc`. */
export function candidateSplits(hc) {
  const budget = Math.max(1, hc | 0);
  const seen = new Set();
  const out = [];
  const add = (workers, tpw) => {
    if (workers < 1 || tpw < 1) return;
    if (workers * tpw > budget) return;
    const key = `${workers}x${tpw}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ workers, threadsPerWorker: tpw });
  };
  // Worker ladder 1,2,4,… up to budget; for each, a few thread depths.
  const ladder = [];
  for (let w = 1; w < budget; w *= 2) ladder.push(w);
  ladder.push(budget);
  for (const workers of ladder) {
    add(workers, 1);
    add(workers, 2);
    add(workers, 4);
    add(workers, Math.max(1, Math.floor(budget / workers))); // fill the budget
  }
  add(1, budget); // all threads in one worker
  return out;
}

/**
 * Pick the split with the best throughput; on a tie (within `tieFrac`) prefer the
 * one with the FEWER total threads (workers*threadsPerWorker), then fewer workers.
 * @param {{workers:number,threadsPerWorker:number,throughput:number}[]} measured
 */
export function pickSplit(measured, tieFrac = 0.05) {
  if (!measured || measured.length === 0) return null;
  const best = measured.reduce((a, b) => (b.throughput > a.throughput ? b : a));
  const threshold = best.throughput * (1 - tieFrac);
  const contenders = measured.filter((m) => m.throughput >= threshold);
  contenders.sort((a, b) => {
    const pa = a.workers * a.threadsPerWorker;
    const pb = b.workers * b.threadsPerWorker;
    if (pa !== pb) return pa - pb; // fewer total threads first
    return a.workers - b.workers; // then fewer workers
  });
  const { workers, threadsPerWorker } = contenders[0];
  return { workers, threadsPerWorker };
}

/**
 * Measure every candidate split via an injected async `measure(workers, tpw) =>
 * throughput` and return the chosen split plus the raw grid. `measure` is the only
 * impurity — in the app it times real decode work; in tests it is a stub.
 */
export async function measureAndPick(hc, measure, emit = () => {}) {
  const grid = [];
  for (const { workers, threadsPerWorker } of candidateSplits(hc)) {
    const throughput = await measure(workers, threadsPerWorker);
    emit(`split ${workers}w x ${threadsPerWorker}t -> ${throughput.toFixed(1)}/s`);
    grid.push({ workers, threadsPerWorker, throughput });
  }
  const chosen = pickSplit(grid);
  emit(`-> chosen split: ${chosen.workers}w x ${chosen.threadsPerWorker}t`);
  return { chosen, grid };
}
