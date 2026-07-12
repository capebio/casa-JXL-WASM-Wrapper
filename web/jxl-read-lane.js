// Byte-admission semaphore for file reads (finding 39).
//
// Ensures a full file.arrayBuffer() read does not start until capacity is
// available, so pending tasks never hold complete file bytes in memory while
// waiting for a worker slot.
//
// Usage:
//   const lane = createReadLane({ capacityBytes: 200 * 1024 * 1024 });
//   const release = await lane.admit(estimatedBytes, abortSignal, priority);
//   // ^ resolves only when capacity is available; rejects if signal is aborted
//   const buf = await file.arrayBuffer();   // read starts AFTER admission
//   try { ... use buf ... }
//   finally { release(); }
//
// Properties:
//   lane.activeBytes   — bytes currently reserved by admitted tasks
//   lane.pendingCount  — number of tasks waiting for capacity

const PRIORITY_RANK = { visible: 0, near: 1, background: 2, normal: 1 };

/**
 * @param {object} opts
 * @param {number} opts.capacityBytes  — max concurrent-read byte budget
 */
export function createReadLane(opts = {}) {
    const capacityBytes = (opts.capacityBytes != null && opts.capacityBytes > 0)
        ? opts.capacityBytes
        : 200 * 1024 * 1024; // 200 MB default

    let _activeBytes = 0;
    /** @type {Array<{weight:number,priority:string,resolve:(r:()=>void)=>void,reject:(e:Error)=>void,abortHandler:null|(()=>void)}>} */
    const _waiters = [];

    function _rank(p) {
        return PRIORITY_RANK[p] ?? 1;
    }

    function _fits(weight) {
        // A single task that exceeds total capacity must still run alone to
        // avoid deadlock (same rule as MemoryWeightedAdmissionGate).
        return _activeBytes + weight <= capacityBytes || _activeBytes === 0;
    }

    function _makeRelease(weight) {
        let released = false;
        return function release() {
            if (released) return; // idempotent
            released = true;
            _activeBytes -= weight;
            _drain();
        };
    }

    function _drain() {
        let progress = true;
        while (progress) {
            progress = false;
            for (let i = 0; i < _waiters.length; i++) {
                const w = _waiters[i];
                if (_fits(w.weight)) {
                    _waiters.splice(i, 1);
                    // Detach abort handler before resolving so it doesn't fire
                    // after the waiter has already been admitted.
                    if (w.abortHandler) {
                        w._signal?.removeEventListener('abort', w.abortHandler);
                    }
                    _activeBytes += w.weight;
                    w.resolve(_makeRelease(w.weight));
                    progress = true;
                    break;
                }
            }
        }
    }

    function _insertWaiter(waiter) {
        const rank = _rank(waiter.priority);
        let i = _waiters.length;
        // Insert after the last waiter of equal-or-higher priority (stable FIFO within tier).
        while (i > 0 && _rank(_waiters[i - 1].priority) > rank) i--;
        _waiters.splice(i, 0, waiter);
    }

    /**
     * Admit a task of `weight` bytes. Resolves with a `release()` function.
     * The caller MUST call `release()` when the file read (and any processing
     * that holds the bytes) is complete.
     *
     * @param {number} weight  — estimated bytes this read will occupy
     * @param {AbortSignal|null} [signal]
     * @param {'visible'|'near'|'normal'|'background'} [priority='normal']
     * @returns {Promise<()=>void>}
     */
    function admit(weight, signal = null, priority = 'normal') {
        if (signal?.aborted) {
            return Promise.reject(new DOMException('Read admission aborted', 'AbortError'));
        }
        if (_fits(weight)) {
            _activeBytes += weight;
            return Promise.resolve(_makeRelease(weight));
        }
        return new Promise((resolve, reject) => {
            const waiter = { weight, priority, resolve, reject, abortHandler: null, _signal: signal };
            if (signal) {
                waiter.abortHandler = () => {
                    const idx = _waiters.indexOf(waiter);
                    if (idx !== -1) _waiters.splice(idx, 1);
                    reject(new DOMException('Read admission aborted', 'AbortError'));
                };
                signal.addEventListener('abort', waiter.abortHandler, { once: true });
            }
            _insertWaiter(waiter);
        });
    }

    return {
        admit,
        get activeBytes() { return _activeBytes; },
        get pendingCount() { return _waiters.length; },
    };
}
