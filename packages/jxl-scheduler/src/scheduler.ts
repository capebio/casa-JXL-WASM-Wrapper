// jxl-scheduler/src/scheduler.ts
// Core scheduler: pool, three priority lanes, preemption, dedupe, budget.
// Spec: Section 12, T-SCHEDULER brief.
//
// Preemption invariant (Section 12.2):
//   A visible job entering a full pool preempts one background job.
//   Steps: send decode_cancel/encode_cancel, await cancelled ack, reassign worker.
//   Preempted job caller receives cancelled message and is responsible for resubmit.
//
// Dedupe invariant (Section 12.4):
//   Second request for same sourceKey returns fan-out subscription.
//   Cancel by one subscriber does not cancel primary unless all cancel.
//
// Budget invariant (Section 12.3):
//   budgetMs is session-level elapsed time from session construction; never per-stage.
//   On breach: session emits decode_budget_exceeded with best frame so far.
//
// Queue wait observability: when a session is forced to wait for a worker slot,
// we capture queuedAt and emit "scheduler_queue_wait_ms" (via the normal metric
// fan-out) on the queued→running transition. This enables parity measurements
// against the Tauri PrioritySem (ProcessResult.queue_wait_ms) and the synthetic
// lightbox_bench qwait column under concurrency + promotion (scenarios C/D).

import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  MsgDecodeStart,
  MsgEncodeStart,
} from "@casabio/jxl-core/protocol";

import type { AdmissionGate, Priority, PoolWorker, WorkerFactory, WorkerHandle } from "./types.js";
import { WorkerPool, RESERVED_SESSION_ID } from "./pool.js";
import { PriorityQueue } from "./queue.js";
import { DedupeRegistry } from "./dedupe.js";
import type { CoreBudget } from "./budget.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SchedulerOptions {
  factory: WorkerFactory;
  maxWorkers: number;
  idleTimeoutMs?: number;
  // Backpressure high-water mark: pushes after this depth block until worker drains. Default: 4.
  pushHwm?: number;
  // Number of workers to spawn eagerly at construction to eliminate first-image boot latency. Default: 0.
  prewarmSize?: number;
  // Optional shared CoreBudget for cross-scheduler bounding of live WASM thread pools (sched-1).
  coreBudget?: CoreBudget;
  /**
   * Declared core cost per worker from this pool (sched-1).
   * 1 for single-threaded workers (simd/scalar); N=hardwareConcurrency for MT workers
   * (relaxed-simd-mt / simd-mt). When used with coreBudget, bounds concurrent MT to ~1.
   */
  workerCost?: number;
  // Optional pre-acquisition gate (sched-2). admit() awaited before any pool touches.
  admissionGate?: AdmissionGate;
  // Bounded parked decoder sessions (S15).
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

// ---------------------------------------------------------------------------
// Private types
// ---------------------------------------------------------------------------

// A session waiting in the queue for a worker slot.
interface PendingSession {
  sessionId: string;
  priority: Priority;
  startMsg: MsgDecodeStart | MsgEncodeStart;
  // Chunks accumulated before the worker was assigned.
  bufferedChunks: Array<{ msg: MainToWorkerMessage; transfer: ArrayBuffer[] }>;
  resolve: () => void;
  reject: (err: unknown) => void;
  signal: AbortSignal | null;
  isRequeue: boolean;
  // Monotonic timestamp (performance.now()) captured at the moment we decided
  // to queue this session. Used to compute scheduler queue wait for benchmarks
  // and parity with the Tauri PrioritySem + lightbox_bench "qwait" metric.
  queuedAt: number;
}

interface BackpressureState {
  queueDepth: number;
  pendingPushes: Array<{ resolve: () => void; waitedAt: number }>;
  pendingHead: number;
}

// Single record per active session. Replaces six separate Maps that previously
// tracked worker, pending, handlers, backpressure, priority, and kind independently.
interface SessionRecord {
  sessionId: string;
  state: "queued" | "running" | "cancelling" | "paused";
  priority: Priority;
  kind: "decode" | "encode";
  handlers: Array<(msg: WorkerToMainMessage) => void>;
  // Set only while running; absent for queued sessions and dedupe subscribers.
  worker?: PoolWorker;
  // Set only while queued; cleared when a worker is assigned.
  pending?: PendingSession;
  backpressure?: BackpressureState;
  // Worker holding the paused WASM decoder state. Set only for "paused" sessions.
  pausedOnWorker?: PoolWorker;
  // Monotonic time (performance.now()) the session was created. Used for victim scoring.
  createdAt: number;
  // Monotonic time we entered the scheduler queue (only meaningful while state==="queued").
  // Populated for benchmark observability (parity with Tauri queue_wait_ms and lightbox_bench).
  queuedAt?: number;
  // Fractional decode progress [0, 1]. Updated from decode_progress stage messages.
  // Encode sessions stay at 0 (no protocol progress messages exist for encode).
  progress: number;
  // Cleanup fn for AbortSignal listener (stored to allow removal on normal completion; prevents leak on page-lifespan signals).
  abortCleanup?: () => void;
  // True for dedupe fan-out subscribers (they never own a worker; counted separately in metrics).
  isSubscriber?: boolean;
}

const DEFAULT_PUSH_HWM = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

// Upper bound on the cancel-before-acquire tombstone set and per-worker discard set.
// These are pruned on the normal acquire/terminal-ack paths; the cap is a safety net for
// the abnormal paths (stray cancel, recycled worker that never acks) so neither set can
// grow without limit over a long-lived scheduler. Evicts oldest (FIFO) when exceeded.
const MAX_CANCELLED_DURING_ACQUISITION = 1024;
const MAX_DISCARD_SESSIONS_PER_WORKER = 256;

// Max consecutive async-drain retry attempts before the wedged queue head is rejected
// instead of being retried forever (errors-0004). Backoff doubles from 50ms up to 2s.
const MAX_DRAIN_RETRIES = 6;

// Minimum consumed-prefix length before signalDrain copyWithin-compacts the pendingPushes
// ring under steady partial drain (logic-0005). Matches queue.ts's small floor; kept >=64 so
// we never churn the array on tiny backpressure bursts (CLAUDE.md: no compactQueue threshold <64).
const PENDING_PUSHES_COMPACT_MIN = 64;

// Shared empty array — avoids per-message allocation when no handlers registered.
const EMPTY_HANDLERS: ReadonlyArray<(msg: WorkerToMainMessage) => void> = [];

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  private readonly pool: WorkerPool;
  private readonly queue: PriorityQueue<PendingSession>;
  private readonly dedupe: DedupeRegistry;
  private readonly admissionGate: AdmissionGate | undefined;
  private readonly gateReleases = new Map<string, () => void>();

  // All active sessions: primaries (running or queued) and dedupe subscribers.
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly pendingHandlers = new Map<string, Array<(msg: WorkerToMainMessage) => void>>();

  // Workers currently running background-priority sessions — enables O(n_background)
  // candidate scan for preemption without iterating the full session map.
  private readonly backgroundWorkers = new Set<PoolWorker>();

  // Maps worker id → paused session id. A worker holds at most one paused decode session
  // (the WASM decoder state is bound to that worker's heap and cannot migrate).
  //
  // Memory: each parked session pins a full WASM decoder (including its output pixel
  // buffers) in the worker. Parked workers are removed from the active/idle sets.
  // No cap exists; concurrent visible preemptions can pin multiple decoder heaps.
  // Candidate future feature (not implemented): evict/cancel oldest parked when
  // parked count exceeds a threshold to bound memory under pathological preemption.
  private readonly workerPausedSession = new Map<number, string>();

  // Track stale session ids per worker and drop their traffic at the wire (S1)
  private readonly discardSessions = new Map<number, Set<string>>();

  // Tracking sessions cancelled during admission or spawn waits to prevent ghost decode (S5)
  private readonly cancelledDuringAcquisition = new Set<string>();

  // Workers whose onMessage handler has already been wired — prevents stale-closure
  // accumulation when a worker handles multiple sessions across its lifetime.
  private readonly wiredWorkers = new WeakSet<PoolWorker>();

  private readonly pushHwm: number;
  private readonly maxParkedSessions: number;

  private destroyed = false;
  private drainingQueue = false;
  // Consecutive async-drain failures, for bounded exponential backoff (errors-0004).
  private drainRetryCount = 0;
  private preemptionCount = 0;
  private totalSessionCount = 0;
  private _runningCount = 0;
  private _queuedCount = 0;
  private _pausedCount = 0;
  private _subscriberCount = 0;

  // Preemption victim scoring weights.
  private readonly PREEMPT_PROGRESS_W = 3.0;
  private readonly PREEMPT_AGE_W = 1.0;
  // Cancelled encodes lose all work; paused decodes lose none (S10)
  private readonly PREEMPT_ENCODE_W = 1.5;
  // Age is normalised over this window before scoring (sessions older than this score identically on age).
  private readonly PREEMPT_AGE_NORM_MS = 60_000;

  // Adaptive backpressure: EMA of how long a push actually blocked (ms).
  // Initialised to 50ms so the HWM starts neutral (no change from the configured base).
  private drainLatencyEma = 50;
  private readonly DRAIN_EMA_ALPHA = 0.2;

  constructor(opts: SchedulerOptions) {
    // Build pool options without relying on spread under exactOptionalPropertyTypes.
    // Always supply the required fields; conditionally attach coreBudget only when
    // provided (the value itself, never the |undefined form in the object shape).
    const poolCtorOpts: {
      factory: WorkerFactory;
      maxSize: number;
      idleTimeoutMs: number;
      coreBudget?: CoreBudget;
      workerCost?: number;
    } = {
      factory: opts.factory,
      maxSize: opts.maxWorkers,
      idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    };
    if (opts.coreBudget !== undefined) {
      poolCtorOpts.coreBudget = opts.coreBudget;
    }
    if (opts.workerCost !== undefined) {
      poolCtorOpts.workerCost = opts.workerCost;
    }
    this.pool = new WorkerPool(poolCtorOpts);

    this.queue = new PriorityQueue<PendingSession>();
    this.dedupe = new DedupeRegistry();
    this.admissionGate = opts.admissionGate;
    this.pushHwm = opts.pushHwm ?? DEFAULT_PUSH_HWM;
    this.maxParkedSessions = opts.maxParkedSessions ?? Infinity;
    if (opts.prewarmSize && opts.prewarmSize > 0) {
      this.pool.prewarm(opts.prewarmSize);
    }
  }

  // Helper to cleanly abort acquisition when aborted or cancelled mid-flight (S5)
  private abortAcquisition(params: { sessionId: string; sourceKey: string | null }, reason: string): never {
    this.releaseAdmission(params.sessionId);
    if (params.sourceKey !== null) {
      // Notify active subscribers before completing primary
      const subs = this.dedupe.subscribers(params.sessionId);
      for (const sub of subs) {
        if (sub !== params.sessionId) {
          const subRec = this.sessions.get(sub);
          if (subRec !== undefined) {
            // Kind-aware terminal: an encode subscriber must receive encode_cancelled,
            // not decode_cancelled — otherwise its consumer never recognizes the terminal
            // and hangs. Mirrors the kind-aware synthesis in shutdown() and the preempt-
            // timeout path; the abort-before-assignment path was previously decode-only.
            const cancelType = subRec.kind === "encode" ? "encode_cancelled" : "decode_cancelled";
            for (const h of subRec.handlers) {
              try { h({ type: cancelType, sessionId: sub } as WorkerToMainMessage); } catch {}
            }
            this.cleanupSession(sub);
          }
        }
      }
      this.dedupe.complete(params.sessionId); // removes key→primary mapping
    }
    throw new Error(reason);
  }

  // ---------------------------------------------------------------------------
  // Session acquisition — called by jxl-session to reserve a worker slot
  // ---------------------------------------------------------------------------

  async acquireSlot(params: {
    sessionId: string;
    priority: Priority;
    startMsg: MsgDecodeStart | MsgEncodeStart;
    sourceKey: string | null;
    signal: AbortSignal | null;
    weight?: number;
  }): Promise<{ workerId: number }> {
    if (this.destroyed) throw new Error("[jxl-scheduler] Scheduler is shut down.");

    // Dedupe check: if a session for this sourceKey already exists, fan out.
    if (params.sourceKey !== null) {
      const primaryId = this.dedupe.findPrimary(params.sourceKey);
      if (primaryId !== null) {
        this.dedupe.subscribe(params.sessionId, primaryId);
        // Dedupe priority invariant: visible subscriber on background primary escalates primary.
        // Prevents visible view from inheriting background pacing or being preemptable.
        const primaryRecord = this.sessions.get(primaryId);
        if (primaryRecord !== undefined && params.priority === "visible" && primaryRecord.priority === "background") {
          primaryRecord.priority = "visible";
          if (primaryRecord.worker !== undefined) this.backgroundWorkers.delete(primaryRecord.worker);
          if (primaryRecord.state === "queued" && primaryRecord.pending !== undefined) {
            this.queue.remove(primaryId, "background");
            primaryRecord.pending.priority = "visible";
            this.queue.enqueue({ priority: "visible", sessionId: primaryId, payload: primaryRecord.pending });
          }
        }
        // Subscriber gets a lightweight record — handlers only, no worker/pending.
        this.sessions.set(params.sessionId, {
          sessionId: params.sessionId,
          state: "running",
          priority: params.priority,
          kind: params.startMsg.type === "encode_start" ? "encode" : "decode",
          handlers: this.takePendingHandlers(params.sessionId),
          createdAt: performance.now(),
          progress: 0,
          isSubscriber: true,
        });
        this._subscriberCount++;
        this.totalSessionCount++;
        // Wire the subscriber's AbortSignal too — every other acquisition exit does this, and
        // without it signal.abort() on a deduped session is a silent no-op (the subscriber stays
        // subscribed, counted, and leaking until the primary finishes) (concurrency-a1f6c2e0).
        this.setupSignalAbort(params.sessionId, params.signal);
        return { workerId: primaryRecord?.worker?.id ?? -1 };
      }
      this.dedupe.register(params.sessionId, params.sourceKey);
    }

    // Pre-acquisition admission gate (sched-2): await BEFORE any pool.acquire,
    // tryAcquireIdle, or preemption. Controls concurrent active sessions
    // before workers are touched. Only primaries (non-deduped) reach here.
    if (this.admissionGate !== undefined) {
      const release = await this.admissionGate.admit(params.sessionId, params.priority, params.weight);
      this.gateReleases.set(params.sessionId, release);
      if (this.destroyed) this.abortAcquisition(params, "[jxl-scheduler] Scheduler is shut down.");
      if (params.signal?.aborted) this.abortAcquisition(params, "[jxl-scheduler] Session aborted before assignment.");
      if (this.cancelledDuringAcquisition.has(params.sessionId)) {
        this.cancelledDuringAcquisition.delete(params.sessionId);
        this.abortAcquisition(params, "[jxl-scheduler] Session cancelled during acquisition.");
      }
    }

    // Sync fast path: if an idle worker is available immediately, skip the
    // async hop (Promise + microtask) that pool.acquire() always incurs.
    const idleWorker = this.pool.tryAcquireIdle();
    if (idleWorker !== null) {
      this.assignWorker(idleWorker, params.sessionId, params.startMsg);
      this.setupSignalAbort(params.sessionId, params.signal);
      return { workerId: idleWorker.id };
    }

    // No idle worker — try spawn (async path).
    const worker = await this.pool.acquire();
    if (this.destroyed) this.abortAcquisition(params, "[jxl-scheduler] Scheduler is shut down.");
    if (params.signal?.aborted) this.abortAcquisition(params, "[jxl-scheduler] Session aborted before assignment.");
    if (this.cancelledDuringAcquisition.has(params.sessionId)) {
      this.cancelledDuringAcquisition.delete(params.sessionId);
      this.abortAcquisition(params, "[jxl-scheduler] Session cancelled during acquisition.");
    }
    if (worker !== null) {
      this.assignWorker(worker, params.sessionId, params.startMsg);
      this.setupSignalAbort(params.sessionId, params.signal);
      return { workerId: worker.id };
    }

    // No worker available — check for preemption opportunity.
    if (params.priority === "visible") {
      const preempted = await this.tryPreempt(params);
      if (this.destroyed) this.abortAcquisition(params, "[jxl-scheduler] Scheduler is shut down.");
      if (params.signal?.aborted) this.abortAcquisition(params, "[jxl-scheduler] Session aborted before assignment.");
      if (this.cancelledDuringAcquisition.has(params.sessionId)) {
        this.cancelledDuringAcquisition.delete(params.sessionId);
        this.abortAcquisition(params, "[jxl-scheduler] Session cancelled during acquisition.");
      }
      if (preempted !== null) return { workerId: preempted };
    }

    // Queue the session and wait for a slot.
    return new Promise<{ workerId: number }>((resolve, reject) => {
      const pending: PendingSession = {
        sessionId: params.sessionId,
        priority: params.priority,
        startMsg: params.startMsg,
        bufferedChunks: [],
        resolve: () => resolve({ workerId: this.sessions.get(params.sessionId)?.worker?.id ?? -1 }),
        reject,
        signal: params.signal,
        isRequeue: false,
        queuedAt: performance.now(),
      };
      this.sessions.set(params.sessionId, {
        sessionId: params.sessionId,
        state: "queued",
        priority: params.priority,
        kind: params.startMsg.type === "encode_start" ? "encode" : "decode",
        handlers: this.takePendingHandlers(params.sessionId),
        pending,
        createdAt: performance.now(),
        queuedAt: pending.queuedAt,
        progress: 0,
      });
      this._queuedCount++;
      this.totalSessionCount++;
      this.queue.enqueue({ priority: params.priority, sessionId: params.sessionId, payload: pending });
      this.setupSignalAbort(params.sessionId, params.signal);
    });
  }

  // ---------------------------------------------------------------------------
  // Message forwarding — called by jxl-session to send messages to a worker
  // ---------------------------------------------------------------------------

  send(sessionId: string, msg: MainToWorkerMessage, transfer: ArrayBuffer[] = []): void {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;

    if (record.worker !== undefined) {
      record.worker.handle.send(msg, transfer);
      return;
    }

    // Paused: decoder lives in pausedOnWorker's WASM heap; forward directly so
    // chunks queue up inside the handler and are ready when the session resumes.
    if (record.state === "paused" && record.pausedOnWorker !== undefined) {
      record.pausedOnWorker.handle.send(msg, transfer);
      return;
    }

    // Queued: buffer the chunk for delivery once a worker is assigned.
    if (record.pending !== undefined) {
      record.pending.bufferedChunks.push({ msg, transfer });
    }
  }

  // Register a handler to receive messages from the worker for this session.
  onMessage(sessionId: string, handler: (msg: WorkerToMainMessage) => void): void {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      let handlers = this.pendingHandlers.get(sessionId);
      if (handlers === undefined) {
        handlers = [];
        this.pendingHandlers.set(sessionId, handlers);
      }
      handlers.push(handler);
      return;
    }
    record.handlers.push(handler);
  }

  /**
   * Viewport-driven real-time re-prioritization of an active session without canceling/restarting (S14).
   * Moves a queued session to the back of the new priority lane (same semantics as dedupe escalation),
   * or updates a running session's background Worker membership for preemption tracking.
   */
  setPriority(sessionId: string, priority: Priority): boolean {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return false;
    if (record.priority === priority) return true;
    const oldPriority = record.priority;
    record.priority = priority;
    if (record.state === "queued" && record.pending !== undefined) {
      this.queue.remove(sessionId, oldPriority);
      record.pending.priority = priority;
      this.queue.enqueue({ priority, sessionId: record.pending.sessionId, payload: record.pending });
    } else if (record.worker !== undefined) {
      if (priority === "background") this.backgroundWorkers.add(record.worker);
      else this.backgroundWorkers.delete(record.worker);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Session completion / cancellation
  // ---------------------------------------------------------------------------

  completeSession(sessionId: string): void {
    this.cleanupSession(sessionId);
    this.drainQueue();
  }

  cancelSession(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      this.dedupe.cancelSubscriber(sessionId);
      // Cancel-before-acquire: a still-pending acquireSlot will consume this entry at its
      // post-await ghost guards. A handler registered via onMessage() before acquireSlot is
      // also orphaned here, so drop it now to avoid an unbounded pendingHandlers leak for
      // sessions that never acquire (errors-0002 / security-7a2d4c19).
      this.pendingHandlers.delete(sessionId);
      // Bound the tombstone set so a stray/duplicate/post-completion cancel for a sessionId
      // that never (re)enters acquireSlot cannot grow it without limit (errors-0001 /
      // security-3f1c8e2a / concurrency-29de5068). FIFO-evict the oldest tombstone; the
      // worst case is that an evicted ghost is no longer suppressed, which only re-raises the
      // pre-existing benign-race window, never corrupts live state.
      if (this.cancelledDuringAcquisition.size >= MAX_CANCELLED_DURING_ACQUISITION) {
        const oldest = this.cancelledDuringAcquisition.values().next().value;
        if (oldest !== undefined) this.cancelledDuringAcquisition.delete(oldest);
      }
      this.cancelledDuringAcquisition.add(sessionId);
      return false;
    }

    // Call cancelSubscriber up-front using priority-aware subscriber selection callback (D2)
    const { cancelWorker, promotedTo } = this.dedupe.cancelSubscriber(
      sessionId,
      (candidates) => {
        let best: string | undefined;
        let bestPriority: Priority = "background";
        for (const cand of candidates) {
          const r = this.sessions.get(cand);
          if (r !== undefined) {
            if (r.priority === "visible") {
              return cand; // visible is best, return immediately
            }
            if (r.priority === "near" && bestPriority === "background") {
              best = cand;
              bestPriority = "near";
            } else if (best === undefined) {
              best = cand;
            }
          }
        }
        return best;
      }
    );
    
    if (promotedTo !== undefined) {
      // Primary was cancelled, but a subscriber was promoted (S4).
      // We must clean up the primary's record and rebind the worker/pending/paused state to the new primary.
      const promotedRecord = this.sessions.get(promotedTo);
      if (record.worker !== undefined && promotedRecord !== undefined) {
        // Transfer the worker to the promoted subscriber.
        promotedRecord.worker = record.worker;
        record.worker.activeSessionId = promotedTo;
        // Dedupe promotion can change priority (bg <-> visible); keep backgroundWorkers set correct for preemption eligibility.
        if (promotedRecord.priority === "background") this.backgroundWorkers.add(record.worker);
        else this.backgroundWorkers.delete(record.worker);
        // Normalize state: subscriber init contract sets state="running"; make explicit so the
        // count adjustment at line 575 always sees the correct state regardless of future
        // refactors that might alter subscriber initialization (A3).
        promotedRecord.state = "running";
      } else if (record.pausedOnWorker !== undefined && promotedRecord !== undefined) {
        // Transfer paused state.
        promotedRecord.state = "paused";
        promotedRecord.pausedOnWorker = record.pausedOnWorker;
        this.workerPausedSession.set(record.pausedOnWorker.id, promotedTo);
      } else if (record.pending !== undefined && promotedRecord !== undefined) {
        // Transfer queue position if still pending.
        promotedRecord.state = "queued";
        promotedRecord.pending = record.pending;
        promotedRecord.pending.sessionId = promotedTo;
        // Update the queue entry
        this.queue.remove(sessionId, record.priority);
        this.queue.enqueue({ priority: promotedRecord.priority, sessionId: promotedTo, payload: promotedRecord.pending });
      }

      // Transfer gate admission (if held) to promoted so it is released when promoted work ends.
      const grel = this.gateReleases.get(sessionId);
      if (grel !== undefined && promotedRecord !== undefined) {
        this.gateReleases.delete(sessionId);
        this.gateReleases.set(promotedTo, grel);
      }

      // Old primary (record) leaves its bucket. Promoted former-sub leaves subscriber count and enters primary bucket.
      this.adjustSessionCount(record, -1);
      if (promotedRecord?.isSubscriber) {
        this._subscriberCount = Math.max(0, this._subscriberCount - 1);
        delete promotedRecord.isSubscriber;
        if (promotedRecord.state === "running" || promotedRecord.state === "cancelling") this._runningCount++;
        else if (promotedRecord.state === "queued") this._queuedCount++;
        else if (promotedRecord.state === "paused") this._pausedCount++;
      }
      record.abortCleanup?.(); // remove the old primary's abort listener (concurrency-b2d7e3f1)
      this.sessions.delete(sessionId);
      return true;
    }

    // No promotion (promotedTo === undefined). We are cancelling the actual work or a lone subscriber.
    if (!cancelWorker) {
      this.releaseAdmission(sessionId);
      this.adjustSessionCount(record, -1);
      record.abortCleanup?.(); // detach abort listener on lone-subscriber cancel (concurrency-b2d7e3f1)
      this.sessions.delete(sessionId);
      return true;
    }

    // Paused: send cancel to the worker hosting the dormant decoder, notify caller,
    // clean up immediately. Register in discardSessions (S1).
    if (record.state === "paused" && record.pausedOnWorker !== undefined) {
      const w = record.pausedOnWorker;
      let ds = this.discardSessions.get(w.id);
      if (ds === undefined) {
        ds = new Set();
        this.discardSessions.set(w.id, ds);
      }
      // Stale ids are normally removed when the worker's terminal ack reaches the wire filter
      // (ensureWorkerWired). If the worker is recycled/terminated before acking, that entry can
      // never be pruned and the per-worker Set would grow without limit (errors-0008 /
      // security-6b3f9d22). Cap it: FIFO-evict the oldest discarded id. Worst case an evicted id
      // is no longer suppressed at the wire, but activeSessionId / RESERVED gating downstream
      // already drops traffic for non-active sessions, so this cannot resurrect a dead session.
      if (ds.size >= MAX_DISCARD_SESSIONS_PER_WORKER) {
        const oldest = ds.values().next().value;
        if (oldest !== undefined) ds.delete(oldest);
      }
      ds.add(sessionId);

      this.workerPausedSession.delete(w.id);
      w.handle.send({ type: "decode_cancel", sessionId });
      delete record.pausedOnWorker;
      for (const h of record.handlers) h({ type: "decode_cancelled", sessionId });
      this.releaseAdmission(sessionId);
      this._pausedCount--;
      this.unblockBackpressure(record); // unblock any waitForDrain callers (paused sessions can hold pending pushes)
      record.abortCleanup?.(); // detach abort listener on paused-session cancel (concurrency-b2d7e3f1)
      this.sessions.delete(sessionId);
      return true;
    }

    // Queued: remove from queue and reject the pending promise (S4).
    if (record.state === "queued" && record.pending !== undefined) {
      // queue.remove() may return false if a stale priority hint left the entry under a different
      // lane; the pending promise still must be rejected and the record torn down regardless,
      // otherwise the queued branch falls through to the running/orphan handling below — which
      // never rejects record.pending, hanging the caller while still decrementing the counter
      // (logic-0006). Reject + clean up unconditionally for any queued record.
      this.unblockBackpressure(record);
      this.queue.remove(sessionId, record.priority);
      record.pending.reject(new Error("[jxl-scheduler] Session cancelled."));
      this.releaseAdmission(sessionId);
      this._queuedCount--;
      record.abortCleanup?.(); // detach abort listener on queued-session cancel (concurrency-b2d7e3f1)
      this.sessions.delete(sessionId);
      return true;
    }

    // Running primary: send cancel to worker. Keep record until worker acks
    // (terminal message arrives in handleWorkerMessage → cleanupSession).
    if (record.worker !== undefined) {
      this.releaseAdmission(sessionId);
      this.unblockBackpressure(record);
      // running → cancelling: no counter change (cancelling counts as running).
      record.state = "cancelling";
      record.handlers = []; // No more fan-out to this session's caller.
      record.worker.cancelling = true;
      record.worker.handle.send({
        type: record.kind === "encode" ? "encode_cancel" : "decode_cancel",
        sessionId,
      });
    } else {
      // No worker, no pending — orphaned. Clean up.
      this.releaseAdmission(sessionId);
      this.adjustSessionCount(record, -1);
      record.abortCleanup?.(); // detach abort listener on orphan cleanup (concurrency-b2d7e3f1)
      this.sessions.delete(sessionId);
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Backpressure
  // ---------------------------------------------------------------------------

  async waitForDrain(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) return;

    if (record.backpressure === undefined) {
      record.backpressure = { queueDepth: 0, pendingPushes: [], pendingHead: 0 };
    }

    const bp = record.backpressure;
    bp.queueDepth++;
    if (bp.queueDepth < this.adaptiveHwm()) return;

    return new Promise<void>((resolve) => {
      bp.pendingPushes.push({ resolve, waitedAt: performance.now() });
    });
  }

  private signalDrain(sessionId: string): void {
    const bp = this.sessions.get(sessionId)?.backpressure;
    if (bp === undefined) return;

    bp.queueDepth = Math.max(0, bp.queueDepth - 1);
    // Dev-only invariant: queueDepth must never go negative (A3).
    if (process.env.NODE_ENV !== "production" && bp.queueDepth < 0) {
      throw new Error(`Scheduler invariant violated: queueDepth went negative (${bp.queueDepth}) for session ${sessionId}`);
    }

    const hwm = this.adaptiveHwm();
    if (bp.pendingHead < bp.pendingPushes.length) {
      // Resolve as many waiters as needed to keep queue depth below adaptive HWM (S13)
      while (bp.queueDepth < hwm && bp.pendingHead < bp.pendingPushes.length) {
        const waiter = bp.pendingPushes[bp.pendingHead++];
        this.updateDrainEma(performance.now() - waiter!.waitedAt);
        waiter!.resolve();
        bp.queueDepth = Math.max(0, bp.queueDepth - 1);
      }
    } else {
      // No waiter: drains are keeping up; decay EMA toward neutral so HWM recovers (S12)
      this.drainLatencyEma += (50 - this.drainLatencyEma) * 0.05;
    }

    // Compact when head has consumed the whole array.
    if (bp.pendingHead >= bp.pendingPushes.length) {
      bp.pendingPushes.length = 0;
      bp.pendingHead = 0;
    } else if (bp.pendingHead >= PENDING_PUSHES_COMPACT_MIN && bp.pendingHead * 2 >= bp.pendingPushes.length) {
      // Steady partial drain never reaches the full-consume branch above, so the old
      // head>=1024 trigger let up to ~1023 resolved waiter objects stay pinned (logic-0005).
      // Mirror the queue.ts amortised heuristic: once the consumed prefix is past a small floor
      // AND at least half the array, copyWithin-compact (no-alloc, the contract-preserved move
      // CLAUDE.md keeps) so retention stays O(live waiters) instead of O(total pushes seen).
      bp.pendingPushes.copyWithin(0, bp.pendingHead);
      bp.pendingPushes.length -= bp.pendingHead;
      bp.pendingHead = 0;
    }
  }

  // Scale HWM up when draining fast, down when slow.
  // At 50ms EMA (init): factor ≈ 1 → HWM = pushHwm (neutral).
  // At 10ms: factor = 2 (capped) → HWM = pushHwm * 2, up to pushHwm * 2 (default 8).
  // At 200ms: factor = 0.25 (floor) → HWM = max(2, pushHwm * 0.25).
  private adaptiveHwm(): number {
    const factor = Math.max(0.25, Math.min(2, 50 / (this.drainLatencyEma + 1)));
    return Math.max(2, Math.round(this.pushHwm * factor));
  }

  private updateDrainEma(latencyMs: number): void {
    this.drainLatencyEma = this.DRAIN_EMA_ALPHA * latencyMs + (1 - this.DRAIN_EMA_ALPHA) * this.drainLatencyEma;
  }

  // Unblock all pending waitForDrain calls — used on cancel/shutdown so callers don't hang.
  private unblockBackpressure(record: SessionRecord): void {
    if (record.backpressure === undefined) return;
    const { pendingPushes, pendingHead } = record.backpressure;
    for (let i = pendingHead; i < pendingPushes.length; i++) {
      pendingPushes[i]!.resolve();
    }
    delete record.backpressure;
  }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  /**
   * Returns a shallow-cloned, frozen snapshot of scheduler metrics counters (S16).
   * Decouples callers from internal mutable state. The returned object may be
   * retained across async boundaries; later mutations to scheduler (counters,
   * queue transitions, preemption counts) will not be visible to holders.
   * Freezing prevents receivers from mutating the snapshot they received.
   * Architectural guard for sched-4 (Metric Object Copy Protection).
   */
  getMetrics(): SchedulerMetrics {
    const snapshot: SchedulerMetrics = {
      running: this._runningCount,
      queued: this._queuedCount,
      paused: this._pausedCount,
      background: this.backgroundWorkers.size,
      preemptions: this.preemptionCount,
      totalSessions: this.totalSessionCount,
      subscribers: this._subscriberCount,
      drainLatencyEmaMs: this.drainLatencyEma,
      effectiveHwm: this.adaptiveHwm(),
      poolSize: this.pool.size,
      poolIdle: this.pool.idleCount,
      poolParked: this.pool.parkedCount,
      poolSpawning: this.pool.spawningCount,
    };
    return Object.freeze(snapshot);
  }

  /**
   * Lightweight dashboard-facing stats snapshot.
   * Read-only; no side effects; additive (no behavior change).
   * Shape is stable across refactors — callers must not depend on internal field names.
   */
  getStats(): {
    activeWorkers: number;
    idleWorkers: number;
    queueDepth: number;
    dedupeSize: number;
    draining: boolean;
  } {
    return {
      activeWorkers: this._runningCount,
      idleWorkers: this.pool.idleCount,
      queueDepth: this._queuedCount,
      // _subscriberCount = fan-out dedupe subscriber sessions (non-worker-holding).
      dedupeSize: this._subscriberCount,
      draining: this.drainingQueue,
    };
  }

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
  private protectMetricForDispatch(msg: WorkerToMainMessage, stampSessionId?: string): WorkerToMainMessage {
    const rawMsg = msg as { sessionId?: string; type: string; metric?: unknown };
    const targetSessionId = stampSessionId ?? rawMsg.sessionId;
    if (rawMsg.type !== "metric") {
      if (stampSessionId !== undefined && rawMsg.sessionId !== stampSessionId) {
        return { ...msg, sessionId: stampSessionId } as WorkerToMainMessage;
      }
      return msg;
    }
    const clonedMetric = Object.freeze({ ...(rawMsg.metric as object) });
    const protectedMsg = Object.freeze({ ...msg, sessionId: targetSessionId, metric: clonedMetric }) as WorkerToMainMessage;
    return protectedMsg;
  }

  // Route count adjustment for a record. Subscribers are tracked separately from
  // primary running/queued/paused so that "running" accurately reflects worker assignments.
  private adjustSessionCount(record: SessionRecord | undefined, delta: number): void {
    if (record === undefined) return;
    if (record.isSubscriber) {
      this._subscriberCount = Math.max(0, this._subscriberCount + delta);
      return;
    }
    if (record.state === "running" || record.state === "cancelling") {
      this._runningCount = Math.max(0, this._runningCount + delta);
    } else if (record.state === "queued") {
      this._queuedCount = Math.max(0, this._queuedCount + delta);
    } else if (record.state === "paused") {
      this._pausedCount = Math.max(0, this._pausedCount + delta);
    }
  }

  // ---------------------------------------------------------------------------
  // Preemption (Section 12.2)
  // ---------------------------------------------------------------------------

  private async tryPreempt(params: {
    sessionId: string;
    priority: Priority;
    startMsg: MsgDecodeStart | MsgEncodeStart;
    signal: AbortSignal | null;
  }): Promise<number | null> {
    const backgroundWorker = this.findBackgroundWorker();
    if (backgroundWorker === null) return null;

    const victimSessionId = backgroundWorker.activeSessionId!;
    const victimRecord = this.sessions.get(victimSessionId);
    const victimKind = victimRecord?.kind ?? "decode";

    // Decode victims are paused (WASM state preserved for resume).
    // Encode victims are cancelled (no in-progress state worth preserving).
    const usePause = victimKind === "decode";

    backgroundWorker.cancelling = true;
    const prevHandlers = victimRecord?.handlers ?? [];
    let ackResolved = false;

    // Remove our ack handler by identity, not position. The previous code unshifted onto index 0
    // and shifted index 0 off on match/timeout; unshift made handleWorkerMessage's for..of skip
    // the victim's first real handler when the ack handler shifted itself out mid-dispatch
    // (logic-0002), and positional shift() could remove the wrong handler if the array was mutated
    // by a concurrent cancel/promote (errors-0006). Appending (push) keeps it last so self-removal
    // during dispatch only ends the for..of cleanly, and identity splice removes exactly this one.
    const removeAckHandler = (handler: (msg: WorkerToMainMessage) => void): void => {
      const i = prevHandlers.indexOf(handler);
      if (i !== -1) prevHandlers.splice(i, 1);
    };

    let resolvedKind: "paused" | "cancelled" | "terminal" | null = null;
    let ackHandler: ((msg: WorkerToMainMessage) => void) | undefined;
    const ack = new Promise<void>((resolve) => {
      const handler = (msg: WorkerToMainMessage) => {
        // Match terminal messages in the pause branch too (S2)
        const matched = usePause
          ? ((msg.type === "decode_paused" && msg.sessionId === victimSessionId)
              || (this.isTerminalMessage(msg) && msg.sessionId === victimSessionId))
          : ((msg.type === "decode_cancelled" || msg.type === "encode_cancelled") && msg.sessionId === victimSessionId)
            || (this.isTerminalMessage(msg) && msg.sessionId === victimSessionId);
        if (matched) {
          ackResolved = true;
          if (usePause && msg.type === "decode_paused") resolvedKind = "paused";
          else if (!usePause && (msg.type === "decode_cancelled" || msg.type === "encode_cancelled")) resolvedKind = "cancelled";
          else if (this.isTerminalMessage(msg)) resolvedKind = "terminal";
          resolve();
          if (victimRecord) removeAckHandler(handler);
        }
      };
      ackHandler = handler;
      if (victimRecord) prevHandlers.push(handler);

      if (usePause) {
        backgroundWorker.handle.send({ type: "decode_pause", sessionId: victimSessionId });
      } else if (victimKind === "encode") {
        backgroundWorker.handle.send({ type: "encode_cancel", sessionId: victimSessionId, reason: "preempted" });
      } else {
        backgroundWorker.handle.send({ type: "decode_cancel", sessionId: victimSessionId, reason: "preempted" });
      }
    });

    // 2-second timeout prevents indefinite wait on an unresponsive worker.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ack,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("preempt-timeout")), 2000);
        }),
      ]);
    } catch {
      if (victimRecord && ackHandler !== undefined) removeAckHandler(ackHandler);
      this.pool.recycle(backgroundWorker);
    } finally {
      clearTimeout(timeout);
    }
    backgroundWorker.cancelling = false;

    if (resolvedKind === "terminal") {
      // Victim finished naturally (decode_final etc) in the window between selection and preemption signal.
      // Normal handleWorkerMessage already cleaned the victim and released the worker to pool.
      // Do not park/cancel or double-clean; acquire via fallback (may reclaim the just-released worker).
      const newWorker = await this.pool.acquire();
      if (newWorker !== null) {
        this.assignWorker(newWorker, params.sessionId, params.startMsg);
        this.setupSignalAbort(params.sessionId, params.signal);
        this.preemptionCount++;
        return newWorker.id;
      }
      return null;
    }

    if (!ackResolved) {
      // Timed out: worker recycled (pool.recycle terminates it). The terminal
      // decode_cancelled from the worker may never arrive (activeSessionId is
      // cleared during teardown, so handleWorkerMessage silently drops it).
      // Synthesize terminal for victim's handlers so their done()/streams do not hang forever.
      const victimHandlers = this.sessions.get(victimSessionId)?.handlers ?? [];
      const cancelType = victimKind === "encode" ? "encode_cancelled" : "decode_cancelled";
      const cancelMsg = { type: cancelType, sessionId: victimSessionId } as WorkerToMainMessage;
      for (const h of victimHandlers) { try { h(cancelMsg); } catch { /* handler must not throw */ } }
      this.cleanupSession(victimSessionId);
      const newWorker = await this.pool.acquire();
      if (newWorker !== null) {
        this.assignWorker(newWorker, params.sessionId, params.startMsg);
        this.setupSignalAbort(params.sessionId, params.signal);
        this.preemptionCount++;
        return newWorker.id;
      }
      return null;
    }

    if (usePause) {
      // Park the victim: keep its session record alive but detach from the active worker.
      // The WASM decoder state remains in the worker's heap until the session resumes.
      if (victimRecord !== undefined) {
        // running → paused
        this._runningCount--;
        this._pausedCount++;
        victimRecord.state = "paused";
        delete victimRecord.worker;
        victimRecord.pausedOnWorker = backgroundWorker;
        this.backgroundWorkers.delete(backgroundWorker);
      }
      this.workerPausedSession.set(backgroundWorker.id, victimSessionId);
      this.pool.park(backgroundWorker);
      this.pool.unpark(backgroundWorker);
      backgroundWorker.activeSessionId = RESERVED_SESSION_ID;
      backgroundWorker.cancelling = false;

      // Bound parked decoder memory (S15)
      if (this.workerPausedSession.size > this.maxParkedSessions) {
        let oldestRecord: SessionRecord | undefined;
        for (const pid of this.workerPausedSession.values()) {
          const r = this.sessions.get(pid);
          if (r !== undefined && r.state === "paused") {
            if (oldestRecord === undefined || r.createdAt < oldestRecord.createdAt) {
              oldestRecord = r;
            }
          }
        }
        if (oldestRecord !== undefined) {
          this.cancelSession(oldestRecord.sessionId);
        }
      }

      if (!backgroundWorker.handle.terminated) {
        this.assignWorker(backgroundWorker, params.sessionId, params.startMsg);
        this.setupSignalAbort(params.sessionId, params.signal);
        this.preemptionCount++;
        return backgroundWorker.id;
      }

      // Worker died between ack and reassign (rare). If paused, clean up the parked session.
      this.workerPausedSession.delete(backgroundWorker.id);
      if (victimRecord !== undefined) {
        // paused → cancelling (counts as running for metrics)
        this._pausedCount--;
        this._runningCount++;
        victimRecord.state = "cancelling";
        delete victimRecord.pausedOnWorker;
      }
      this.releaseSession(victimSessionId);

      const newWorker = await this.pool.acquire();
      if (newWorker !== null) {
        this.assignWorker(newWorker, params.sessionId, params.startMsg);
        this.setupSignalAbort(params.sessionId, params.signal);
        this.preemptionCount++;
        return newWorker.id;
      }
      return null;
    } else {
      // encode_cancelled is terminal: handleWorkerMessage already cleaned the victim
      // and released (possibly reassigned) the worker. Acquire through the pool (S3).
      this.releaseSession(victimSessionId); // defensive no-op
      const newWorker = await this.pool.acquire();
      if (newWorker !== null) {
        this.assignWorker(newWorker, params.sessionId, params.startMsg);
        this.setupSignalAbort(params.sessionId, params.signal);
        this.preemptionCount++;
        return newWorker.id;
      }
      return null;
    }
  }

  // Score a candidate preemption victim. Lower score = better victim.
  // Prefer sessions with low progress (less re-work on resubmit) and low age
  // (less wall-clock time invested). Age is normalised to [0,1] to keep it
  // on the same scale as progress.
  private scoreVictim(record: SessionRecord): number {
    const ageNorm = Math.min(1, (performance.now() - record.createdAt) / this.PREEMPT_AGE_NORM_MS);
    return record.progress * this.PREEMPT_PROGRESS_W
      + ageNorm * this.PREEMPT_AGE_W
      + (record.kind === "encode" ? this.PREEMPT_ENCODE_W : 0);
  }

  private findBackgroundWorker(): PoolWorker | null {
    let bestWorker: PoolWorker | null = null;
    let bestScore = Infinity;

    for (const worker of this.backgroundWorkers) {
      if (worker.cancelling || worker.activeSessionId === null) continue;
      // Skip workers already holding a paused session — their decoder slot is occupied.
      if (this.workerPausedSession.has(worker.id)) continue;
      const record = this.sessions.get(worker.activeSessionId);
      if (record === undefined) continue;
      // Dedupe priority: if primary or any subscriber is visible, this worker is not a preemption victim.
      // A visible consumer attached via fan-out "escalates" the session for preemption eligibility.
      let hasVisible = record.priority === "visible";
      if (!hasVisible) {
        this.dedupe.forEachSubscriber(worker.activeSessionId, (sid) => {
          const sr = this.sessions.get(sid);
          if (sr?.priority === "visible") hasVisible = true;
        });
      }
      if (hasVisible) continue;
      const score = this.scoreVictim(record);
      if (score < bestScore) {
        bestScore = score;
        bestWorker = worker;
      }
    }
    return bestWorker;
  }

  // Resume a paused session on the worker that holds its decoder state.
  private resumePausedSession(worker: PoolWorker, sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (worker.handle.terminated || record === undefined || record.state !== "paused") {
      if (record !== undefined && record.state === "paused") {
        for (const h of record.handlers) { try { h({ type: "decode_cancelled", sessionId } as WorkerToMainMessage); } catch {} }
        this.cleanupSession(sessionId);
      } else if (!worker.handle.terminated) {
        this.pool.release(worker);
      }
      this.drainQueue();
      return;
    }
    this.pool.bind(worker, sessionId);
    // paused → running
    this._pausedCount--;
    this._runningCount++;
    record.state = "running";
    record.worker = worker;
    delete record.pausedOnWorker;
    if (record.priority === "background") this.backgroundWorkers.add(worker);
    else this.backgroundWorkers.delete(worker);
    this.ensureWorkerWired(worker);
    worker.handle.send({ type: "decode_resume", sessionId });
  }

  // ---------------------------------------------------------------------------
  // Assignment helpers
  // ---------------------------------------------------------------------------

  private assignWorker(worker: PoolWorker, sessionId: string, startMsg: MsgDecodeStart | MsgEncodeStart): void {
    this.pool.bind(worker, sessionId);

    // Derive priority from current record status to pick up dedupe escalation (S8)
    const existing = this.sessions.get(sessionId);
    const priority = existing?.priority ?? startMsg.priority;
    const kind = startMsg.type === "encode_start" ? "encode" : "decode";

    // Queued → running transition: update existing record in-place.
    if (existing !== undefined) {
      // queued → running
      this._queuedCount--;
      this._runningCount++;
      existing.state = "running";
      existing.worker = worker;
      delete existing.pending;

      // Emit scheduler-level queue wait metric for benchmarks / parity with
      // Tauri process_file.queue_wait_ms and the synthetic lightbox_bench qwait.
      // Only queued sessions have a meaningful wait; immediate/preempt paths
      // never entered the PendingSession queue.
      if (existing.queuedAt != null) {
        const waitMs = performance.now() - existing.queuedAt;
        // Construct *fresh* metric payload every time (no pre-allocated mutable).
        // protectMetricForDispatch will shallow-clone the CodecMetric and freeze
        // before the handler call. This guarantees that any onMetric consumer
        // (or test that stashes the payload across a tick) sees a stable value
        // even if more queue-waits or counter mutations happen later in the
        // scheduler. Enforces sched-4: no torn async views of active metrics.
        const metricMsg = {
          type: "metric" as const,
          sessionId,
          metric: { name: "scheduler_queue_wait_ms" as const, value: waitMs },
        } as WorkerToMainMessage;
        for (const h of existing.handlers) {
          try { h(this.protectMetricForDispatch(metricMsg, sessionId)); } catch { /* handler must not throw */ }
        }
      }
      delete existing.queuedAt;
    } else {
      // Fresh session (immediate acquire or post-preemption).
      this.sessions.set(sessionId, {
        sessionId,
        state: "running",
        priority,
        kind,
        handlers: this.takePendingHandlers(sessionId),
        worker,
        createdAt: performance.now(),
        progress: 0,
      });
      this._runningCount++;
      this.totalSessionCount++;
    }

    if (priority === "background") this.backgroundWorkers.add(worker);
    else this.backgroundWorkers.delete(worker);

    // Wire the worker's message callback exactly once per worker lifetime —
    // prevents stale closures accumulating across session reuse.
    this.ensureWorkerWired(worker);

    worker.handle.send(startMsg);
  }

  private ensureWorkerWired(worker: PoolWorker): void {
    if (this.wiredWorkers.has(worker)) return;
    this.wiredWorkers.add(worker);
    worker.handle.onMessage((msg) => {
      // S1: Filter stale sessions per worker at the wire before restamping
      const raw = (msg as { sessionId?: string }).sessionId;
      if (raw !== undefined) {
        const ds = this.discardSessions.get(worker.id);
        if (ds?.has(raw)) {
          if (this.isTerminalMessage(msg)) { // ack consumed; stop discarding
            ds.delete(raw);
            if (ds.size === 0) this.discardSessions.delete(worker.id);
          }
          return;
        }
      }

      // worker_error without a sessionId is a worker-lifecycle event — it cannot
      // be attributed to any session. Drop it here so it does not accidentally
      // terminate the currently-active session.
      if (msg.type === "worker_error" && raw === undefined) return;

      const sessionId = worker.activeSessionId;
      if (sessionId === null || sessionId === RESERVED_SESSION_ID) return;
      this.handleWorkerMessage(sessionId, worker, msg);
    });
  }

  private static readonly STAGE_PROGRESS: Readonly<Record<string, number>> = {
    header: 0.1,
    dc: 0.3,
    pass: 0.6,
    final: 0.95,
  };

  private handleWorkerMessage(sessionId: string, worker: PoolWorker, rawMsg: WorkerToMainMessage): void {
    // The worker re-stamps nothing — it emits its original embedded sessionId, which can lag
    // the JS-side `sessionId` (worker.activeSessionId) after a dedupe promotion. Dispatch goes
    // through protectMetricForDispatch(rawMsg, target), which re-stamps per target, and the
    // local control-flow checks below compare against the `sessionId` variable directly (the
    // re-stamp made the old `msg.sessionId === sessionId` test unconditionally true), so the
    // previously-allocated `{ ...rawMsg, sessionId }` spread was never actually needed for
    // dispatch — dropped to avoid the per-message allocation on the promotion path (perf-2a7b1d33).
    const msgType = (rawMsg as { type: string }).type;

    const record = this.sessions.get(sessionId);
    const handlers = record?.handlers ?? EMPTY_HANDLERS;
    // Compute the protected (frozen, re-stamped) payload once per target sessionId rather than
    // once per handler — protectMetricForDispatch clones+freezes for type:"metric", which was
    // being repeated for every handler of the same target (perf-1f3a9c20). All handlers of one
    // target can share the same frozen object (sched-4 contract preserved).
    // Handlers must not be able to abort dispatch: a throwing consumer would propagate out of
    // the worker.handle.onMessage callback and skip the terminal-cleanup block below, leaking
    // the worker and stalling the drain (errors-0013). Guard each call.
    if (handlers.length > 0) {
      const protectedMsg = this.protectMetricForDispatch(rawMsg, sessionId);
      for (const h of handlers) { try { h(protectedMsg); } catch { /* handler must not throw */ } }
    }

    // Fan out to dedupe subscribers.
    this.dedupe.forEachSubscriber(sessionId, (subId) => {
      if (subId === sessionId) return;
      const subRecord = this.sessions.get(subId);
      const subHandlers = subRecord?.handlers ?? EMPTY_HANDLERS;
      if (subHandlers.length === 0) return;
      const protectedSubMsg = this.protectMetricForDispatch(rawMsg, subId);
      for (const h of subHandlers) { try { h(protectedSubMsg); } catch { /* handler must not throw */ } }
    });

    // Track decode progress for victim scoring. The stage is used as a proxy for
    // fractional completion so that nearly-done sessions are spared from preemption.
    if (record !== undefined && msgType === "decode_progress") {
      const p = Scheduler.STAGE_PROGRESS[(rawMsg as { stage: string }).stage];
      if (p !== undefined) record.progress = Math.max(record.progress, p);
    }

    if (msgType === "worker_drain") {
      this.signalDrain(sessionId);
    }

    // On completion: clean up, then either resume a parked session on this worker
    // or release it to the pool for the queue drain.
    if (this.isTerminalMessage(rawMsg)) {
      this.cleanupSession(sessionId);
      const pausedId = this.workerPausedSession.get(worker.id);
      if (pausedId !== undefined) {
        this.workerPausedSession.delete(worker.id);
        this.resumePausedSession(worker, pausedId);
      } else {
        this.pool.release(worker);
        this.drainQueue();
      }
    }
  }

  private isTerminalMessage(msg: WorkerToMainMessage): msg is WorkerToMainMessage & { sessionId: string } {
    switch (msg.type) {
      case "decode_final":
      case "decode_cancelled":
      case "decode_error":
      case "decode_budget_exceeded":
      case "encode_done":
      case "encode_cancelled":
      case "encode_error":
        return true;
      case "worker_error":
        // worker_error is terminal only when it carries a sessionId — the session-
        // less variant is a worker lifecycle event, not a per-session terminal.
        return (msg as { sessionId?: string }).sessionId !== undefined;
      default:
        return false;
    }
  }

  private setupSignalAbort(sessionId: string, signal: AbortSignal | null): void {
    if (signal === null) return;
    const rec = this.sessions.get(sessionId);
    if (rec?.abortCleanup !== undefined) return; // already wired (S6)

    if (signal.aborted) {
      this.cancelSession(sessionId);
      return;
    }
    const onAbort = () => this.cancelSession(sessionId);
    signal.addEventListener("abort", onAbort, { once: true });
    if (rec) rec.abortCleanup = () => signal.removeEventListener("abort", onAbort);
  }

  private takePendingHandlers(sessionId: string): Array<(msg: WorkerToMainMessage) => void> {
    const handlers = this.pendingHandlers.get(sessionId);
    if (handlers === undefined) return [];
    this.pendingHandlers.delete(sessionId);
    return handlers;
  }

  // Release the AdmissionGate slot (if any) for this sessionId (sched-2).
  private releaseAdmission(sessionId: string): void {
    const rel = this.gateReleases.get(sessionId);
    if (rel !== undefined) {
      this.gateReleases.delete(sessionId);
      try { rel(); } catch { /* releases must not propagate */ }
    }
  }

  private releaseAllAdmissions(): void {
    for (const [, rel] of this.gateReleases) {
      try { rel(); } catch { /* releases must not propagate */ }
    }
    this.gateReleases.clear();
  }

  // Tears down session state without triggering a queue drain.
  private cleanupSession(sessionId: string): void {
    this.releaseAdmission(sessionId);
    const record = this.sessions.get(sessionId);
    if (record !== undefined) {
      this.adjustSessionCount(record, -1);
      record.abortCleanup?.();
      this.unblockBackpressure(record); // unblock backpressure waiters (S7)
    }
    this.releaseSession(sessionId);
    this.dedupe.complete(sessionId);
    this.sessions.delete(sessionId);
    this.pendingHandlers.delete(sessionId);
  }

  private releaseSession(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record?.worker !== undefined) {
      this.backgroundWorkers.delete(record.worker);
    }
    if (record?.pausedOnWorker !== undefined) {
      this.backgroundWorkers.delete(record.pausedOnWorker);
      this.workerPausedSession.delete(record.pausedOnWorker.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Queue drain (called after a worker becomes idle)
  // ---------------------------------------------------------------------------

  private drainQueue(): void {
    if (this.queue.isEmpty || this.drainingQueue) return;
    this.drainingQueue = true;

    // Sync fast path: drain all entries that have an immediately available idle
    // worker, skipping the async hop (Promise allocation + microtask scheduling).
    // Common steady-state case: a worker just finished, queue has work, pool has
    // an idle slot — no need for an async round-trip.
    while (!this.queue.isEmpty) {
      const worker = this.pool.tryAcquireIdle();
      if (worker === null) break;
      const entry = this.queue.dequeue();
      if (entry === null) { this.pool.release(worker); break; }
      const { payload: pending } = entry;
      // assignWorker → pool.bind can throw (terminated/non-reserved worker). This sync section
      // is not inside the async try/catch below, so an unguarded throw would leave the dequeued
      // pending un-rejected, the worker un-released, and drainingQueue stuck true — permanently
      // wedging the drain (errors-0005). Guard each iteration: reject the pending, recycle the
      // worker, reset the guard, and stop (the failing head is consumed so we don't spin on it).
      try {
        this.assignWorker(worker, pending.sessionId, pending.startMsg);
        this.setupSignalAbort(pending.sessionId, pending.signal);
        for (const { msg, transfer } of pending.bufferedChunks) {
          worker.handle.send(msg, transfer);
        }
        pending.resolve();
      } catch (err: unknown) {
        // Bad head: reject it and recycle the worker, but continue draining —
        // stopping here would leave remaining queued sessions waiting for the
        // next unrelated worker completion (slow recovery on a quiet pool).
        try { pending.reject(err); } catch { /* reject must not propagate */ }
        try { this.pool.recycle(worker); } catch { /* recycle must not propagate */ }
        // Fall through to next iteration: try another idle worker if available.
      }
    }

    if (this.queue.isEmpty) {
      this.drainingQueue = false;
      return;
    }

    // Async path: no idle workers available; wait for spawn or worker release.
    void (async () => {
      try {
        while (!this.queue.isEmpty) {
          const worker = await this.pool.acquire();
          if (worker === null) break;
          const entry = this.queue.dequeue();
          if (entry === null) {
            this.pool.release(worker);
            break;
          }
          const { payload: pending } = entry;
          this.assignWorker(worker, pending.sessionId, pending.startMsg);
          this.setupSignalAbort(pending.sessionId, pending.signal);
          for (const { msg, transfer } of pending.bufferedChunks) {
            worker.handle.send(msg, transfer);
          }
          pending.resolve();
        }
        // Drained without error — clear the backoff counter.
        this.drainRetryCount = 0;
      } catch (err: unknown) {
        console.error("[jxl-scheduler] drainQueue error:", err);
        // Bounded exponential backoff. The previous unconditional setTimeout(...,50) retried
        // forever at a fixed 50ms with no escalation, so a persistently faulting queue head
        // (e.g. pool.bind throwing) became an unbounded busy-retry loop while its pending
        // promise never settled (errors-0004). Cap the attempts; once exhausted, reject the
        // wedged head so its caller stops hanging and the queue can make progress.
        if (this.drainRetryCount < MAX_DRAIN_RETRIES && !this.destroyed) {
          this.drainRetryCount++;
          const delayMs = Math.min(2000, 50 * 2 ** (this.drainRetryCount - 1));
          setTimeout(() => this.drainQueue(), delayMs);
        } else {
          this.drainRetryCount = 0;
          const head = this.queue.dequeue();
          if (head !== null) {
            try { head.payload.reject(err); } catch { /* reject must not propagate */ }
          }
        }
      } finally {
        this.drainingQueue = false;
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.destroyed = true;

    // Reject/notify all non-running sessions so their callers don't hang.
    const shutdownErr = new Error("[jxl-scheduler] Scheduler shut down.");
    for (const record of this.sessions.values()) {
      if (record.state === "queued" && record.pending !== undefined) {
        this.unblockBackpressure(record);
        record.pending.reject(shutdownErr);
      } else if (record.state === "paused") {
        // Notify paused-session callers with a synthetic cancelled message.
        this.unblockBackpressure(record); // unblock any pending waitForDrain promises (backpressure)
        for (const h of record.handlers) h({ type: "decode_cancelled", sessionId: record.sessionId });
      } else if (record.state === "running" || record.state === "cancelling") {
        // Running sessions lose their workers on pool.shutdown(); synthesize terminal so callers do not hang.
        this.unblockBackpressure(record); // unblock any pending waitForDrain promises (backpressure)
        const t = record.kind === "encode" ? "encode_cancelled" : "decode_cancelled";
        for (const h of record.handlers) { try { h({ type: t, sessionId: record.sessionId } as WorkerToMainMessage); } catch {} }
      }
    }

    this.releaseAllAdmissions();

    await this.pool.shutdown();
    this._runningCount = 0;
    this._queuedCount = 0;
    this._pausedCount = 0;
    this._subscriberCount = 0;
    this.sessions.clear();
    this.backgroundWorkers.clear();
    this.workerPausedSession.clear();
    this.discardSessions.clear();
    this.cancelledDuringAcquisition.clear();
    this.gateReleases.clear();
  }
}
