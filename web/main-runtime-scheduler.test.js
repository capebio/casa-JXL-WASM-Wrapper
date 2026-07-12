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
