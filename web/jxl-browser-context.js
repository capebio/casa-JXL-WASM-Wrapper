// Lazy singleton JxlContext for browser callers. Import with:
//   import { getContext } from './jxl-browser-context.js';
// The context is created on first call; subsequent calls return the same instance.
// Requires the @casabio/jxl-session import map entry to be active.
//
// Calibration (finding 9): pass the calibrated pool size at creation time so the
// shared JxlContext scheduler honours the measured worker count. Call
// setCalibrationPoolSize(n) BEFORE the first getContext() call (e.g. after
// ensureCalibrated() resolves in main.js) for the hint to take effect.

import { createBrowserContext } from '@casabio/jxl-session';

let _ctx = null;
let _calibratedPoolSize = null;

/**
 * Set the calibrated pool size for the next context creation.
 * Must be called before the first getContext() to have effect.
 * No-op if the context was already created.
 * @param {number|null} workers
 */
export function setCalibrationPoolSize(workers) {
    if (_ctx !== null) return; // already created — too late
    if (typeof workers === 'number' && workers >= 1) {
        _calibratedPoolSize = Math.max(1, Math.round(workers));
    }
}

export function getContext() {
    if (_ctx === null) {
        try {
            const opts = _calibratedPoolSize != null ? { poolSize: _calibratedPoolSize } : undefined;
            _ctx = createBrowserContext(opts);
        } catch (err) {
            console.error('[jxl-browser-context] Failed to create JxlContext:', err);
            // Surface the real failure immediately rather than installing a no-op
            // stub that defers it to first decode/encode with a generic message
            // (and whose capabilities() === {} reads as "feature absent"). Leave
            // _ctx null so a later call can retry once the misconfiguration is fixed.
            throw new Error(
                '[jxl-browser-context] Failed to create JxlContext: ' + (err?.message ?? String(err)),
                { cause: err },
            );
        }
    }
    return _ctx;
}

export async function resetContext() {
    // Capture and detach the old context BEFORE awaiting its shutdown so a
    // concurrent getContext() can never observe the mid-shutdown instance —
    // it will create a fresh one instead.
    const old = _ctx;
    _ctx = null;
    if (old?.shutdown) {
        try {
            await old.shutdown();
        } catch {}
    }
    return getContext();
}
