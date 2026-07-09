// Browser calibration orchestrator: on first session, detect capability, run the
// worker×thread grid, persist the profile, and apply it. Non-blocking by design — the
// app uses today's defaults until this resolves. Analogue of orchestrator.rs.
//
// The measurement of a split (spinning up N workers × M threads and timing real decode
// work) is injected as `measureSplit` so this module stays pure/testable and free of
// WASM/worker wiring; the app supplies the real timer. When no measurer is available
// (or threads are unavailable) we fall back to a safe non-oversubscribing default.

import { measureAndPick, pickSplit } from "./grid.mjs";
import * as profile from "./profile.mjs";

/** A safe default split that never oversubscribes: workers = min(HC,4), 1 thread each. */
export function safeDefaultSplit(sig = profile.detectSignature()) {
  const hc = sig.hardwareConcurrency || 4;
  if (!profile.threadsAvailable(sig)) {
    return { workers: Math.min(hc, 4), threadsPerWorker: 1, tier: "simd" };
  }
  return { workers: Math.min(hc, 4), threadsPerWorker: 1, tier: "simd-mt" };
}

/**
 * Ensure the browser is calibrated. If a matching profile exists, apply it and return.
 * Otherwise run the grid (if a `measureSplit` is provided) or fall back to the safe
 * default, persist, and apply.
 *
 * @param {object} [opts]
 * @param {(workers:number,threadsPerWorker:number)=>Promise<number>} [opts.measureSplit]
 * @param {(line:string)=>void} [opts.emit]
 * @param {number} [opts.nowMs] wall-clock stamp (injected; avoids Date in pure paths)
 */
export async function ensureCalibrated(opts = {}) {
  const emit = opts.emit || (() => {});
  const sig = profile.detectSignature();

  const existing = profile.load();
  if (profile.matchesCurrent(existing, sig)) {
    profile.apply(existing);
    emit(`loaded profile: ${existing.selections.workers}w x ${existing.selections.threadsPerWorker}t`);
    return { profile: existing, applied: true, fresh: false };
  }

  let selections;
  let measurements = null;
  if (opts.measureSplit && profile.threadsAvailable(sig)) {
    emit(`calibrating worker x thread split (HC=${sig.hardwareConcurrency})`);
    const { chosen, grid } = await measureAndPick(
      sig.hardwareConcurrency,
      opts.measureSplit,
      emit
    );
    selections = { ...chosen, tier: "simd-mt" };
    measurements = grid;
  } else {
    selections = safeDefaultSplit(sig);
    emit(`no measurer / threads unavailable → safe default ${selections.workers}w x ${selections.threadsPerWorker}t`);
  }

  const p = profile.makeProfile(selections, opts.nowMs || 0, measurements);
  profile.save(p);
  profile.apply(p);
  return { profile: p, applied: true, fresh: true };
}

export { pickSplit };
