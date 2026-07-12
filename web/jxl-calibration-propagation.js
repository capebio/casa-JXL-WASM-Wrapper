// Calibration → session/worker limits (finding 9).
//
// Translates the persisted hardware-calibration profile (web/calibration/profile.mjs)
// into:
//   1. A JxlContext pool-size hint (workers count)
//   2. A per-worker thread-count hint (threadsPerWorker) posted before PRELOAD
//
// Kept as a pure module so it can be imported and tested in Node without any
// browser API dependencies.

/**
 * Extract the per-worker thread-count from a calibration profile.
 * Falls back to 1 when the profile is absent or incomplete.
 *
 * @param {object|null} profile  — a calibration profile as returned by profile.load()
 * @returns {{ threadsPerWorker: number }}
 */
export function calibrationToWorkerHint(profile) {
    const t = profile?.selections?.threadsPerWorker;
    const threadsPerWorker = (typeof t === 'number' && t >= 1) ? Math.max(1, Math.round(t)) : 1;
    return { threadsPerWorker };
}

/**
 * Extract the worker-pool size from a calibration profile.
 * Falls back to null (let the context use its own default) when absent.
 *
 * @param {object|null} profile
 * @returns {number|null}
 */
export function calibrationToPoolSize(profile) {
    const w = profile?.selections?.workers;
    if (typeof w === 'number' && w >= 1) return Math.max(1, Math.round(w));
    return null;
}

/**
 * Build a postMessage payload that sets the calibrated thread count on a worker.
 * The worker must handle `{ type: 'set_calibration', threadsPerWorker }` and
 * store `self.__calibratedThreads = threadsPerWorker` before calling initThreadPool.
 *
 * @param {object|null} profile
 * @returns {{ type: 'set_calibration', threadsPerWorker: number }}
 */
export function buildCalibrationMessage(profile) {
    const { threadsPerWorker } = calibrationToWorkerHint(profile);
    return { type: 'set_calibration', threadsPerWorker };
}

/**
 * Post the calibration hint to a single RAW worker BEFORE sending PRELOAD.
 * No-op if worker is null/undefined.
 *
 * @param {Worker} worker
 * @param {object|null} profile
 */
export function postCalibrationToWorker(worker, profile) {
    if (!worker) return;
    worker.postMessage(buildCalibrationMessage(profile));
}
