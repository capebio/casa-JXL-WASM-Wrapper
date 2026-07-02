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
      this.waiters.push({ sessionId, priority, weight: w, resolve });
    });
  }

  private normalizeWeight(weight?: number): number {
    if (weight === undefined || !Number.isFinite(weight) || weight <= 0) {
      return this.defaultWeightBytes;
    }
    return weight;
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
    // Admit the first fitting waiter, repeat until none fit. (Priority ordering
    // is added in Task 2; Task 1 uses FIFO order.)
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < this.waiters.length; i++) {
        if (this.fits(this.waiters[i]!.weight)) {
          const [waiter] = this.waiters.splice(i, 1);
          this._runningBytes += waiter!.weight;
          waiter!.resolve(this.makeRelease(waiter!.weight));
          progress = true;
          break;
        }
      }
    }
  }
}

// PRIORITY_RANK is used starting in Task 2 for priority-ordered drain.
void (PRIORITY_RANK satisfies Record<Priority, number>);
