import type { MainToWorkerMessage, WorkerToMainMessage, MsgDecodeStart, MsgEncodeStart } from "@casabio/jxl-core/protocol";
import type { AdmissionGate, Priority, WorkerFactory } from "./types.js";
import type { CoreBudget } from "./budget.js";
export interface SchedulerOptions {
    factory: WorkerFactory;
    maxWorkers: number;
    idleTimeoutMs?: number;
    pushHwm?: number;
    prewarmSize?: number;
    coreBudget?: CoreBudget;
    /**
     * Declared core cost per worker from this pool (sched-1).
     * 1 for single-threaded workers (simd/scalar); N=hardwareConcurrency for MT workers
     * (relaxed-simd-mt / simd-mt). When used with coreBudget, bounds concurrent MT to ~1.
     */
    workerCost?: number;
    admissionGate?: AdmissionGate;
    maxParkedSessions?: number;
}
export interface SchedulerMetrics {
    /** Sessions currently assigned to a worker (includes cancelling). */
    running: number;
    /** Sessions waiting in the priority queue for a worker slot. */
    queued: number;
    /** Decode sessions paused on a worker, awaiting a resume slot. */
    paused: number;
    /** Running sessions with background priority. */
    background: number;
    /** Total preemptions performed since construction. */
    preemptions: number;
    /** Total sessions created since construction. */
    totalSessions: number;
    /** Deduped subscriber sessions (fan-out listeners holding no worker). */
    subscribers: number;
    /** EMA of observed push drain latency (ms) driving adaptive backpressure. */
    drainLatencyEmaMs: number;
    /** Current effective backpressure HWM (adapts with drainLatencyEma). */
    effectiveHwm: number;
    poolSize: number;
    poolIdle: number;
    poolParked: number;
    poolSpawning: number;
}
export declare class Scheduler {
    private readonly pool;
    private readonly queue;
    private readonly dedupe;
    private readonly admissionGate;
    private readonly gateReleases;
    private readonly sessions;
    private readonly pendingHandlers;
    private readonly backgroundWorkers;
    private readonly workerPausedSession;
    private readonly discardSessions;
    private readonly cancelledDuringAcquisition;
    private readonly wiredWorkers;
    private readonly pushHwm;
    private readonly maxParkedSessions;
    private destroyed;
    private drainingQueue;
    private drainRetryCount;
    private preemptionCount;
    private totalSessionCount;
    private _runningCount;
    private _queuedCount;
    private _pausedCount;
    private _subscriberCount;
    private readonly PREEMPT_PROGRESS_W;
    private readonly PREEMPT_AGE_W;
    private readonly PREEMPT_ENCODE_W;
    private readonly PREEMPT_AGE_NORM_MS;
    private drainLatencyEma;
    private readonly DRAIN_EMA_ALPHA;
    constructor(opts: SchedulerOptions);
    private abortAcquisition;
    acquireSlot(params: {
        sessionId: string;
        priority: Priority;
        startMsg: MsgDecodeStart | MsgEncodeStart;
        sourceKey: string | null;
        signal: AbortSignal | null;
        weight?: number;
    }): Promise<{
        workerId: number;
    }>;
    send(sessionId: string, msg: MainToWorkerMessage, transfer?: ArrayBuffer[]): void;
    onMessage(sessionId: string, handler: (msg: WorkerToMainMessage) => void): void;
    /**
     * Viewport-driven real-time re-prioritization of an active session without canceling/restarting (S14).
     * Moves a queued session to the back of the new priority lane (same semantics as dedupe escalation),
     * or updates a running session's background Worker membership for preemption tracking.
     */
    setPriority(sessionId: string, priority: Priority): boolean;
    completeSession(sessionId: string): void;
    cancelSession(sessionId: string): boolean;
    waitForDrain(sessionId: string): Promise<void>;
    private signalDrain;
    private adaptiveHwm;
    private updateDrainEma;
    private unblockBackpressure;
    /**
     * Returns a shallow-cloned, frozen snapshot of scheduler metrics counters (S16).
     * Decouples callers from internal mutable state. The returned object may be
     * retained across async boundaries; later mutations to scheduler (counters,
     * queue transitions, preemption counts) will not be visible to holders.
     * Freezing prevents receivers from mutating the snapshot they received.
     * Architectural guard for sched-4 (Metric Object Copy Protection).
     */
    getMetrics(): SchedulerMetrics;
    /**
     * Ensures a metric message's payload is decoupled before dispatch to any
     * onMessage handler (which ultimately feeds onMetric in jxl-session).
     * - Always returns a fresh top-level object for the dispatch (existing spread
     *   already did this for primary and per-subscriber copies).
     * - For type:"metric", shallow-clones the CodecMetric sub-object and freezes
     *   both wrapper and metric so that in-place mutation of "active" metric
     *   objects by producers cannot produce torn views for async listeners.
     *   Listeners holding the metric across ticks see the value at dispatch time.
     * This is the central enforcement point for sched-4.
     * Supports an optional stampSessionId parameter performing one spread + freeze (S16).
     */
    private protectMetricForDispatch;
    private adjustSessionCount;
    private tryPreempt;
    private scoreVictim;
    private findBackgroundWorker;
    private resumePausedSession;
    private assignWorker;
    private ensureWorkerWired;
    private static readonly STAGE_PROGRESS;
    private handleWorkerMessage;
    private isTerminalMessage;
    private setupSignalAbort;
    private takePendingHandlers;
    private releaseAdmission;
    private releaseAllAdmissions;
    private cleanupSession;
    private releaseSession;
    private drainQueue;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=scheduler.d.ts.map