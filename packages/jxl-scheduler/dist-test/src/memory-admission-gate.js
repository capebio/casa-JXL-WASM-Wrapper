const MB = 1024 * 1024;
const PRIORITY_RANK = { visible: 0, near: 1, background: 2 };
export class MemoryWeightedAdmissionGate {
    budgetBytes;
    defaultWeightBytes;
    _runningBytes = 0;
    waiters = [];
    constructor(opts = {}) {
        const budget = opts.budgetBytes ?? 512 * MB;
        if (!Number.isFinite(budget) || budget <= 0) {
            throw new Error("[jxl-scheduler] MemoryWeightedAdmissionGate: budgetBytes must be finite > 0");
        }
        const dflt = opts.defaultWeightBytes ?? 256 * MB;
        if (!Number.isFinite(dflt) || dflt <= 0) {
            throw new Error("[jxl-scheduler] MemoryWeightedAdmissionGate: defaultWeightBytes must be finite > 0");
        }
        this.budgetBytes = budget;
        this.defaultWeightBytes = dflt;
    }
    /** Bytes currently reserved by admitted-but-not-released tasks. */
    get runningBytes() {
        return this._runningBytes;
    }
    /** Number of tasks waiting for budget. */
    get pendingCount() {
        return this.waiters.length;
    }
    admit(sessionId, priority, weight) {
        const w = this.normalizeWeight(weight);
        if (this.fits(w)) {
            this._runningBytes += w;
            return Promise.resolve(this.makeRelease(w));
        }
        return new Promise((resolve) => {
            this.insertWaiter({ sessionId, priority, weight: w, resolve });
        });
    }
    normalizeWeight(weight) {
        if (weight === undefined || !Number.isFinite(weight) || weight <= 0) {
            return this.defaultWeightBytes;
        }
        return weight;
    }
    insertWaiter(waiter) {
        // Priority-ordered (visible < near < background by rank), FIFO within a priority:
        // insert after the last waiter of equal-or-higher priority.
        const rank = PRIORITY_RANK[waiter.priority];
        let i = this.waiters.length;
        while (i > 0 && PRIORITY_RANK[this.waiters[i - 1].priority] > rank)
            i--;
        this.waiters.splice(i, 0, waiter);
    }
    fits(w) {
        // Fits if it stays under budget, OR nothing is running (a single over-budget
        // task must still run alone — a decode can't be split — to avoid deadlock).
        return this._runningBytes + w <= this.budgetBytes || this._runningBytes === 0;
    }
    makeRelease(w) {
        let released = false;
        return () => {
            if (released)
                return; // idempotent
            released = true;
            this._runningBytes -= w;
            this.drain();
        };
    }
    drain() {
        // Admit the first fitting waiter (scan-forward: a non-fitting task does not block smaller
        // tasks behind it); repeat until none fit. Queue is priority-ordered by insertWaiter.
        let progress = true;
        while (progress) {
            progress = false;
            for (let i = 0; i < this.waiters.length; i++) {
                if (this.fits(this.waiters[i].weight)) {
                    const [waiter] = this.waiters.splice(i, 1);
                    const w = waiter.weight;
                    this._runningBytes += w;
                    waiter.resolve(this.makeRelease(w));
                    progress = true;
                    break;
                }
            }
        }
    }
}
//# sourceMappingURL=memory-admission-gate.js.map