// MemoryWeightedAdmissionGate: byte-budget weighted semaphore implementing AdmissionGate.
// Cost = a task's estimated output bytes; capacity = budgetBytes. Same shape as CoreBudget
// (budget.ts) but keyed on memory instead of cores. Opt-in — only active if injected.
import type { AdmissionGate, AdmissionRelease, Priority } from "./types.js";

const MB = 1024 * 1024;

const PRIORITY_RANK: Record<Priority, number> = { visible: 0, near: 1, background: 2 };

interface Waiter {
  sessionId: string;
  priority: Priority;
  weight: number;
  resolve: (release: AdmissionRelease) => void;
}

export interface MemoryWeightedAdmissionGateOptions {
  /** Byte capacity the running decode set must fit under. Default 512 MB (fits wasm32). */
  budgetBytes?: number;
  /** Weight applied when admit() is called without a weight. Default 256 MB (≈ one full decode). */
  defaultWeightBytes?: number;
}

export class MemoryWeightedAdmissionGate implements AdmissionGate {
  private readonly budgetBytes: number;
  private readonly defaultWeightBytes: number;
  private _runningBytes = 0;
  private readonly waiters: Waiter[] = [];

  constructor(opts: MemoryWeightedAdmissionGateOptions = {}) {
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
  get runningBytes(): number {
    return this._runningBytes;
  }

  /** Number of tasks waiting for budget. */
  get pendingCount(): number {
    return this.waiters.length;
  }

  admit(sessionId: string, priority: Priority, weight?: number): Promise<AdmissionRelease> {
    const w = this.normalizeWeight(weight);
    if (this.fits(w)) {
      this._runningBytes += w;
      return Promise.resolve(this.makeRelease(w));
    }
    return new Promise<AdmissionRelease>((resolve) => {
      this.insertWaiter({ sessionId, priority, weight: w, resolve });
    });
  }

  private normalizeWeight(weight?: number): number {
    if (weight === undefined || !Number.isFinite(weight) || weight <= 0) {
      return this.defaultWeightBytes;
    }
    return weight;
  }

  private insertWaiter(waiter: Waiter): void {
    // Priority-ordered (visible < near < background by rank), FIFO within a priority:
    // insert after the last waiter of equal-or-higher priority.
    const rank = PRIORITY_RANK[waiter.priority];
    let i = this.waiters.length;
    while (i > 0 && PRIORITY_RANK[this.waiters[i - 1]!.priority] > rank) i--;
    this.waiters.splice(i, 0, waiter);
  }

  private fits(w: number): boolean {
    // Fits if it stays under budget, OR nothing is running (a single over-budget
    // task must still run alone — a decode can't be split — to avoid deadlock).
    return this._runningBytes + w <= this.budgetBytes || this._runningBytes === 0;
  }

  private makeRelease(w: number): AdmissionRelease {
    let released = false;
    return () => {
      if (released) return; // idempotent
      released = true;
      this._runningBytes -= w;
      this.drain();
    };
  }

  private drain(): void {
    // Admit the first fitting waiter (scan-forward: a non-fitting task does not block smaller
    // tasks behind it); repeat until none fit. Queue is priority-ordered by insertWaiter.
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < this.waiters.length; i++) {
        if (this.fits(this.waiters[i]!.weight)) {
          const [waiter] = this.waiters.splice(i, 1);
          const w = waiter!.weight;
          this._runningBytes += w;
          waiter!.resolve(this.makeRelease(w));
          progress = true;
          break;
        }
      }
    }
  }
}

