/**
 * finding 71: a byte-weighted counting semaphore. Bounds the TOTAL in-flight weight (bytes) of
 * concurrently-running tasks to a fixed budget, so a fan-out over many large buffers (e.g. per-level
 * convergence profiling, each holding a full-resolution reference image) cannot blow past the ingest
 * memory budget. Unlike a slot-count semaphore, a single big task can consume the whole budget.
 *
 * Semantics:
 *  - `acquire(weight)` resolves with a `release` function once `weight` fits under the budget.
 *  - A task whose weight EXCEEDS the whole budget still runs (alone) — otherwise it would deadlock.
 *  - FIFO among waiters (a small task does not starve behind a large one; each waiter is only
 *    admitted when the head of the queue fits, preserving order and preventing indefinite deferral).
 *  - `release` is idempotent: calling it twice frees the reservation only once.
 */
export class ByteWeightedSemaphore {
  private readonly budget: number;
  private inUse = 0;
  private readonly waiters: Array<{ weight: number; resolve: (release: () => void) => void }> = [];

  constructor(budgetBytes: number) {
    if (!(budgetBytes > 0)) throw new Error(`ByteWeightedSemaphore budget must be > 0, got ${budgetBytes}`);
    this.budget = budgetBytes;
  }

  acquire(weight: number): Promise<() => void> {
    const w = Math.max(0, weight | 0 || weight); // tolerate float weights
    return new Promise<() => void>((resolve) => {
      this.waiters.push({ weight: w, resolve });
      this.pump();
    });
  }

  private pump(): void {
    // Admit waiters from the FRONT while the head fits. Head-only admission preserves FIFO order and
    // stops a stream of small tasks from starving a large one queued ahead of them.
    while (this.waiters.length > 0) {
      const head = this.waiters[0]!;
      // Fits if it stays within budget, OR nothing is running and it alone exceeds the budget
      // (an over-budget task must be admitted alone rather than deadlock forever).
      const fits = this.inUse + head.weight <= this.budget || this.inUse === 0;
      if (!fits) break;
      this.waiters.shift();
      this.inUse += head.weight;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.inUse -= head.weight;
        if (this.inUse < 0) this.inUse = 0;
        this.pump();
      };
      head.resolve(release);
    }
  }
}
