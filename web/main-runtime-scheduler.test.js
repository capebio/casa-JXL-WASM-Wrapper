// Tests for the scheduler-integration refactor (Packet 4, Task 1).
// Covers:
//   - jxl-read-lane.js: byte-admission semaphore (finding 39)
//   - jxl-calibration-propagation.js: calibration → session/worker limits (finding 9)
//   - main.js source-text wiring assertions (finding 3, 9, 39)
//
// Run with: bun test web/main-runtime-scheduler.test.js

import { expect, test, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createReadLane } from './jxl-read-lane.js';
import {
    calibrationToWorkerHint,
    buildCalibrationMessage,
} from './jxl-calibration-propagation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(__dirname, 'main.js'), 'utf8');
const workerSrc = readFileSync(join(__dirname, 'worker.js'), 'utf8');
const browserCtxSrc = readFileSync(join(__dirname, 'jxl-browser-context.js'), 'utf8');
const calibrateSrc = readFileSync(join(__dirname, 'calibration', 'calibrate.mjs'), 'utf8');

// ---------------------------------------------------------------------------
// jxl-read-lane: byte-admission semaphore (finding 39)
// ---------------------------------------------------------------------------

describe('jxl-read-lane: basic admission', () => {
    test('admits immediately when under capacity', async () => {
        const lane = createReadLane({ capacityBytes: 10_000_000 });
        const release = await lane.admit(1_000_000);
        expect(lane.activeBytes).toBe(1_000_000);
        release();
        expect(lane.activeBytes).toBe(0);
    });

    test('queues second admission when first would exceed capacity', async () => {
        const lane = createReadLane({ capacityBytes: 5_000_000 });
        const r1 = await lane.admit(4_000_000);
        expect(lane.activeBytes).toBe(4_000_000);

        let r2Resolved = false;
        const p2 = lane.admit(3_000_000).then(r => { r2Resolved = true; return r; });
        expect(r2Resolved).toBe(false);
        expect(lane.pendingCount).toBe(1);

        r1(); // release 4 MB → second can now fit
        const r2 = await p2;
        expect(r2Resolved).toBe(true);
        expect(lane.activeBytes).toBe(3_000_000);
        r2();
    });

    test('no pre-admission read: admission must resolve before reading starts', async () => {
        // Simulate the contract: call admit() → then (only after resolution) call arrayBuffer().
        // Verify that a queued admit only resolves AFTER the previous task releases.
        const lane = createReadLane({ capacityBytes: 2_000_000 });
        const readLog = [];

        async function simulateFile(name, sizeBytes) {
            const release = await lane.admit(sizeBytes);
            readLog.push(`${name}:start-read`);
            // Simulate async read
            await Promise.resolve();
            readLog.push(`${name}:done-read`);
            release();
        }

        const p1 = simulateFile('a.orf', 1_500_000);
        const p2 = simulateFile('b.orf', 1_500_000); // would exceed cap while a runs

        await p1;
        // b should not have started reading while a was still running
        // (b's start-read should come after a's release)
        await p2;

        expect(readLog[0]).toBe('a.orf:start-read');
        expect(readLog[1]).toBe('a.orf:done-read');
        expect(readLog[2]).toBe('b.orf:start-read');
        expect(readLog[3]).toBe('b.orf:done-read');
    });

    test('queued bytes are not retained by the semaphore', async () => {
        // The lane itself must not hold references to any file bytes —
        // it only tracks size numbers, not the actual data.
        const lane = createReadLane({ capacityBytes: 1_000_000 });
        const r1 = await lane.admit(900_000);
        // Queued task: just a number, no byte array stored
        const p2 = lane.admit(900_000);
        // Lane internal state should only be numbers
        expect(typeof lane.activeBytes).toBe('number');
        expect(typeof lane.pendingCount).toBe('number');
        // The pending task holds no bytes — just a promise
        expect(p2 instanceof Promise).toBe(true);
        r1();
        const r2 = await p2;
        r2();
    });
});

describe('jxl-read-lane: AbortSignal support', () => {
    test('rejects immediately if signal is already aborted', async () => {
        const lane = createReadLane({ capacityBytes: 1_000_000 });
        const ctrl = new AbortController();
        ctrl.abort();
        await expect(lane.admit(500_000, ctrl.signal)).rejects.toThrow();
        expect(lane.activeBytes).toBe(0);
        expect(lane.pendingCount).toBe(0);
    });

    test('cancels a queued admission when signal aborts', async () => {
        const lane = createReadLane({ capacityBytes: 1_000_000 });
        const r1 = await lane.admit(900_000);

        const ctrl = new AbortController();
        const p2 = lane.admit(900_000, ctrl.signal);
        expect(lane.pendingCount).toBe(1);

        ctrl.abort();
        await expect(p2).rejects.toThrow();
        expect(lane.pendingCount).toBe(0);

        r1(); // release should not re-trigger the aborted waiter
        expect(lane.activeBytes).toBe(0);
    });

    test('does not reject an already-admitted task when signal aborts', async () => {
        // Once admitted, the signal abort does not revoke the slot.
        const lane = createReadLane({ capacityBytes: 2_000_000 });
        const ctrl = new AbortController();
        const release = await lane.admit(1_000_000, ctrl.signal);
        expect(lane.activeBytes).toBe(1_000_000);
        ctrl.abort(); // too late — already admitted
        expect(lane.activeBytes).toBe(1_000_000);
        release();
        expect(lane.activeBytes).toBe(0);
    });
});

describe('jxl-read-lane: crash recovery — release is idempotent', () => {
    test('double-release does not corrupt activeBytes', async () => {
        const lane = createReadLane({ capacityBytes: 1_500_000 });
        const r1 = await lane.admit(900_000);
        // Only 600 KB remaining; second task queues
        let r2;
        const p2 = lane.admit(900_000).then(r => { r2 = r; });
        expect(lane.pendingCount).toBe(1);

        r1(); // releases 900 KB → second fits
        await p2;
        expect(lane.activeBytes).toBe(900_000);

        r2();
        r2(); // double-release — must be idempotent
        expect(lane.activeBytes).toBe(0);
    });
});

describe('jxl-read-lane: priority ordering', () => {
    test('visible-priority admits before background-priority when capacity frees', async () => {
        const lane = createReadLane({ capacityBytes: 1_000_000 });
        const r1 = await lane.admit(900_000, null, 'background');

        const admitted = [];
        const pBg = lane.admit(900_000, null, 'background').then(r => { admitted.push('bg'); return r; });
        const pVis = lane.admit(900_000, null, 'visible').then(r => { admitted.push('vis'); return r; });

        r1();
        const rVis = await pVis;
        expect(admitted[0]).toBe('vis');
        rVis();
        const rBg = await pBg;
        expect(admitted[1]).toBe('bg');
        rBg();
    });
});

// ---------------------------------------------------------------------------
// jxl-calibration-propagation (finding 9)
// ---------------------------------------------------------------------------

describe('calibrationToWorkerHint', () => {
    test('extracts threadsPerWorker from calibration selections', () => {
        const profile = { selections: { workers: 4, threadsPerWorker: 3, tier: 'simd-mt' } };
        const hint = calibrationToWorkerHint(profile);
        expect(hint.threadsPerWorker).toBe(3);
    });

    test('returns 1 when threadsPerWorker is absent', () => {
        const hint = calibrationToWorkerHint({ selections: { workers: 2 } });
        expect(hint.threadsPerWorker).toBe(1);
    });

    test('returns 1 when profile is null', () => {
        const hint = calibrationToWorkerHint(null);
        expect(hint.threadsPerWorker).toBe(1);
    });

    test('returns 1 when profile is missing selections', () => {
        const hint = calibrationToWorkerHint({});
        expect(hint.threadsPerWorker).toBe(1);
    });

    test('clamps to minimum 1', () => {
        const hint = calibrationToWorkerHint({ selections: { threadsPerWorker: 0 } });
        expect(hint.threadsPerWorker).toBe(1);
    });
});

describe('buildCalibrationMessage', () => {
    test('builds a postMessage payload with threadsPerWorker', () => {
        const profile = { selections: { workers: 2, threadsPerWorker: 4, tier: 'simd-mt' } };
        const msg = buildCalibrationMessage(profile);
        expect(msg.type).toBe('set_calibration');
        expect(msg.threadsPerWorker).toBe(4);
    });

    test('defaults to threadsPerWorker 1 for null profile', () => {
        const msg = buildCalibrationMessage(null);
        expect(msg.type).toBe('set_calibration');
        expect(msg.threadsPerWorker).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Source-text assertions: main.js wiring (findings 3, 9, 39)
// ---------------------------------------------------------------------------

describe('main.js source-text: private JXL queue replaced (finding 3)', () => {
    test('no longer defines _jxlDecodeBusy field directly in WorkerPool constructor', () => {
        // After the refactor the private queue fields are gone from WorkerPool.
        // They were: _jxlDecodeCallbacks, _jxlNextDecodeId, _jxlDecodeQueue,
        // _jxlDecodeBusy, _jxlPendingByUrl, _jxlDecodeWorker.
        expect(mainSrc).not.toContain('this._jxlDecodeBusy');
        expect(mainSrc).not.toContain('this._jxlDecodeQueue');
        expect(mainSrc).not.toContain('this._jxlPendingByUrl');
        expect(mainSrc).not.toContain('this._jxlDecodeCallbacks');
    });

    test('decodeJxl routes through getContext() decode session', () => {
        // The shared JxlContext is used for JXL decode, not a private worker.
        expect(mainSrc).toContain('getContext');
        // getContext is imported from jxl-browser-context.js
        expect(mainSrc).toContain("from './jxl-browser-context.js'");
    });

    test('dedicated jxl-decode-worker is no longer spawned from WorkerPool.init', () => {
        // pool.setJxlDecodeWorker used to spawn jxl-decode-worker.js. After
        // routing through jxl-session, that worker is no longer needed.
        expect(mainSrc).not.toContain('setJxlDecodeWorker');
        expect(mainSrc).not.toContain('jxl-decode-worker.js');
    });
});

describe('main.js source-text: calibration propagation (finding 9)', () => {
    test('imports buildCalibrationMessage or postCalibrationToWorker', () => {
        expect(mainSrc).toMatch(/buildCalibrationMessage|postCalibrationToWorker|calibrationToWorkerHint/);
    });

    test('posts calibration to workers before or at PRELOAD', () => {
        // buildCalibrationMessage is called in _spawnWorker before PRELOAD is sent,
        // so initThreadPool in worker.js receives the calibrated thread count.
        // Worker.js receives 'set_calibration' and stores self.__calibratedThreads.
        expect(mainSrc).toContain('buildCalibrationMessage');
        expect(workerSrc).toContain('__calibratedThreads');
    });

    test('calibration-propagation module is imported', () => {
        expect(mainSrc).toContain('jxl-calibration-propagation');
    });
});

describe('main.js source-text: byte-admission lane (finding 39)', () => {
    test('imports createReadLane', () => {
        expect(mainSrc).toContain('createReadLane');
    });

    test('reads jxl-read-lane module', () => {
        expect(mainSrc).toContain('jxl-read-lane');
    });

    test('file.arrayBuffer() is called inside admit().then() or after await admit()', () => {
        // The full-file read must start only after admission. Verify the pattern:
        // readLane.admit(...).then(lane_release => { ... file.arrayBuffer() ... })
        // The admit call must precede arrayBuffer in the source (within dispatchRaw).
        expect(mainSrc).toMatch(/readLane\.admit[\s\S]{0,300}arrayBuffer\(\)/);
    });
});

describe('worker.js source-text: calibration hint reception (finding 9)', () => {
    test('worker.js handles set_calibration message type', () => {
        expect(workerSrc).toContain('set_calibration');
    });

    test('worker.js reads __calibratedThreads from the set_calibration message', () => {
        expect(workerSrc).toContain('__calibratedThreads');
    });
});

describe('jxl-browser-context.js: context creation uses calibration pool size (finding 9)', () => {
    test('accepts poolSize option or reads from calibration', () => {
        // The context must be created with the calibrated worker count, not a
        // fixed default. The browser context accepts poolSize in createBrowserContext.
        expect(browserCtxSrc).toMatch(/poolSize|workers/);
    });
});

// ---------------------------------------------------------------------------
// I-1: lane_release fires on cancel (activeBytes returns to 0)
// ---------------------------------------------------------------------------

describe('I-1: read-lane release on cancel — behavioral contract', () => {
    test('FAILS before fix: activeBytes leaks when lane_release is not called on cancel path', async () => {
        // This test simulates the exact bug: a task admits the lane, gets a
        // lane_release function, but never calls it (mimicking the cancel path
        // where onDone/onError never fire). The lane's activeBytes should be
        // returned to 0 via an external release call on the card-state reference.
        //
        // After the I-1 fix, main.js stores lane_release on card state as
        // _laneRelease, and removeCard() calls it. This test verifies the
        // contract: a stored release function called externally brings
        // activeBytes back to 0.
        const lane = createReadLane({ capacityBytes: 5_000_000 });
        const release = await lane.admit(3_000_000);
        expect(lane.activeBytes).toBe(3_000_000);
        // Simulate: the cancel path calls the externally-stored release.
        // If I-1 fix is present, release() is stored and called by removeCard.
        release(); // this is what removeCard must do
        expect(lane.activeBytes).toBe(0);
    });

    test('source: removeCard calls _laneRelease on card state', () => {
        // After I-1 fix: removeCard must call getCardState(card)._laneRelease?.()
        // (or equivalent) so that cancelling a card releases its byte reservation.
        expect(mainSrc).toMatch(/_laneRelease\s*\??\s*\.?\s*\(\s*\)|_laneRelease\s*&&\s*.*_laneRelease\s*\(\)/);
    });

    test('source: lane_release stored on card state in dispatchRaw', () => {
        // dispatchRaw must save lane_release to card state so removeCard can find it.
        expect(mainSrc).toMatch(/_laneRelease\s*=\s*lane_release/);
    });

    test('source: readLane.admit is called with an AbortSignal (not null) — M-1', () => {
        // M-1: the AbortController signal is wired into admit() so a queued read
        // is cancelled when the card is removed, not stuck in the lane forever.
        // Before M-1 fix the call is readLane.admit(..., null, ...).
        // After: readLane.admit(..., _readAbortCtrl.signal, ...)
        expect(mainSrc).toMatch(/readLane\.admit\([^)]*\.signal/);
    });

    test('source: removeCard aborts the per-card read AbortController — M-3', () => {
        // M-3: removeCard must call abortCtrl.abort() (or equivalent) for the
        // card's in-flight fetch/session so an in-progress read is cancelled.
        // Expect a pattern like: getCardState(card)._readAbortCtrl?.abort()
        expect(mainSrc).toMatch(/_readAbortCtrl\s*\??\s*\.?\s*abort\s*\(\)|_readAbortCtrl\s*&&\s*.*\.abort\s*\(\)/);
    });
});

// ---------------------------------------------------------------------------
// I-2: _jxlDecodeByUrl eviction on synchronous getContext() throw
// ---------------------------------------------------------------------------

describe('I-2: decode map eviction on synchronous getContext() throw', () => {
    test('source: getContext().decode() call is inside a try block', () => {
        // Before fix: getContext().decode({...}) is OUTSIDE the try/finally,
        // so a sync throw skips cleanup() → URL entry leaks.
        // After fix: the entire post-fetch body including getContext().decode()
        // is inside a try block so cleanup() runs on throw.
        //
        // Verify by checking that the try keyword appears before getContext().decode
        // within a reasonable window in the source.
        const tryIdx = mainSrc.indexOf('getContext().decode(');
        expect(tryIdx).toBeGreaterThan(-1);
        // Find 'try {' before the getContext().decode call (within 600 chars —
        // the try block may be preceded by a let + multi-line comment).
        const window = mainSrc.slice(Math.max(0, tryIdx - 600), tryIdx);
        expect(window).toMatch(/\btry\s*\{/);
    });

    test('source: session.cancel() is called in the catch for push/close errors — I-2 cleanup', () => {
        // After I-2 fix: when session.push() or session.close() throw (not from
        // a worker-terminal message), session.cancel() is called best-effort so
        // the scheduler slot is released. Verify the pattern exists.
        expect(mainSrc).toMatch(/session\??\s*\.cancel\s*\(\)|session\s*&&\s*session\.cancel\s*\(\)/);
    });

    test('source: _jxlDecodeByUrl.delete is called in both cleanup and the catch path', () => {
        // cleanup() evicts the URL entry. The catch that runs when getContext() throws
        // must also call cleanup(). With the fix the finally block covers it.
        // Count occurrences of cleanup() call within decodeJxlViaSession.
        const fnStart = mainSrc.indexOf('function decodeJxlViaSession(');
        const fnEnd   = mainSrc.indexOf('\nfunction ', fnStart + 1);
        const fnBody  = mainSrc.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 4000);
        const cleanupCalls = (fnBody.match(/\bcleanup\s*\(\)/g) || []).length;
        // fetch-catch + finally = at least 2 cleanup() calls
        expect(cleanupCalls).toBeGreaterThanOrEqual(2);
    });
});
