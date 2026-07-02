// jxl-scheduler/src/types.ts
// Scheduler-internal types. Not part of the public jxl-core contract.

import type { WorkerToMainMessage, MainToWorkerMessage } from "@casabio/jxl-core/protocol";

export type Priority = "visible" | "near" | "background";

export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

/** Release callback returned by AdmissionGate.admit(). Call exactly once to free the slot. */
export type AdmissionRelease = () => void;

// A worker slot in the pool.
export interface PoolWorker {
  id: number;
  handle: WorkerHandle;
  // Current session bound to this worker, or null if idle.
  activeSessionId: string | null;
  // True while a cancel is in flight (decode_cancel sent, awaiting decode_cancelled).
  cancelling: boolean;
  idleTimer: TimerHandle | null;
}

// Minimal handle surface needed by scheduler. Implemented by jxl-worker-browser/spawn.ts
// and jxl-worker-node/spawn.ts.
export interface WorkerHandle {
  send(msg: MainToWorkerMessage, transfer?: ArrayBuffer[]): void;
  onMessage(handler: (msg: WorkerToMainMessage) => void): void;
  shutdown(timeoutMs?: number): Promise<void>;
  readonly terminated: boolean;
  /** Optional: fired on worker-level error; pool recycles the worker (T2). */
  onError?(handler: (err: unknown) => void): void;
  /** Optional: fired on unexpected worker exit; pool recycles the worker (T2). */
  onExit?(handler: () => void): void;
}

// Factory function the scheduler uses to create workers.
export type WorkerFactory = () => Promise<WorkerHandle>;

export interface AdmissionGate {
  /**
   * Request admission slot for a session.
   * Note on cancellation contract (T3):
   * admit() may resolve after the session was cancelled or the scheduler destroyed;
   * the scheduler releases the returned token immediately in that case.
   * Implementations should resolve promptly and must tolerate the release being
   * the first and only interaction.
   * @param weight optional estimated memory footprint (output bytes) of the task; a
   *   memory-weighted gate uses it to bound the concurrent working set. Ignored by
   *   gates that only count sessions.
   */
  admit(sessionId: string, priority: Priority, weight?: number): Promise<AdmissionRelease>;
}
