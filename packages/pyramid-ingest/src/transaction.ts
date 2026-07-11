// Task 7 (findings 68, 69): transactional locking + ordered shutdown.
//
// PROBLEM (finding 68): commands acquired/released advisory locks by convention. A command could
//   - omit locking entirely (reindex mutated index.json with no lock), or
//   - invert the order (rm took the IMAGE lock, then the GLOBAL lock for its rebuild),
// and nothing caught it. PROBLEM (finding 69): on a signal the global lock was released immediately,
// *before* workers were terminated and the checkpoint flushed, so another process could grab the lock
// while our workers were still writing.
//
// SOLUTION: lock ownership is encapsulated here. A mutation runs *inside* a transaction and receives a
// capability token; it cannot acquire a lock itself. The image lock REQUIRES the global-lock token as a
// mandatory argument, so GLOBAL-then-IMAGE order is enforced at the type level (you cannot call
// withImageWriteTransaction without a GlobalWriteToken) and at runtime (a released/stale token is
// rejected with LockOrderError). Ordered shutdown steps registered on the write transaction all run —
// in registration order, while the lock is still held — before the global lock is released.

import { acquireReadLock, acquireWriteLock, acquireImageWriteLock, type AdvisoryLock } from "./lock.js";

/** Raised when the lock ORDER is violated (e.g. an image lock is requested without a live global lock). */
export class LockOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockOrderError";
  }
}

// Branded capability tokens. The brand is unforgeable outside this module (the symbol is private), so a
// caller cannot fabricate a token to bypass a transaction.
declare const GLOBAL_WRITE_BRAND: unique symbol;
declare const GLOBAL_READ_BRAND: unique symbol;

export interface GlobalWriteToken {
  readonly [GLOBAL_WRITE_BRAND]: true;
}
export interface GlobalReadToken {
  readonly [GLOBAL_READ_BRAND]: true;
}

// Internal shape behind the brand: tracks liveness so a token used after release is caught.
interface LiveToken {
  live: boolean;
}

/** A shutdown step. Runs (in registration order) while the global lock is STILL held. */
export type ShutdownStep = () => void | Promise<void>;

export interface WriteTransaction {
  /** Capability proving the global write lock is held. Required to acquire an image lock. */
  readonly token: GlobalWriteToken;
  /**
   * Register a teardown step (finding 69). All registered steps run — in order — after the body
   * settles (whether it returns or throws) and BEFORE the global lock is released. Use this to
   * terminate/join workers and flush/close the checkpoint before letting another process in.
   */
  onShutdown(step: ShutdownStep): void;
}

export interface TransactionOptions {
  timeoutMs?: number;
}

function makeWriteToken(): { token: GlobalWriteToken; live: LiveToken } {
  const live: LiveToken = { live: true };
  // The token carries its liveness object non-enumerably; the brand is purely a compile-time marker.
  const token = { __live: live } as unknown as GlobalWriteToken;
  return { token, live };
}

function liveOf(token: GlobalWriteToken): LiveToken | undefined {
  return (token as any)?.__live as LiveToken | undefined;
}

/**
 * Runtime guard for the GLOBAL-then-IMAGE order at points that acquire an image lock but did not go
 * through withImageWriteTransaction (e.g. the batch worker loop, which interleaves acquire/work/release
 * across many images). Throws LockOrderError if the token is missing or its write transaction has
 * already released the global lock. `where` is used in the error for diagnostics.
 */
export function assertGlobalWriteHeld(token: GlobalWriteToken | undefined, where: string): void {
  const live = token ? liveOf(token) : undefined;
  if (!live || !live.live) {
    throw new LockOrderError(
      `${where}: an image write lock requires a live global write lock (GLOBAL then IMAGE); none is held`,
    );
  }
}

/**
 * Run `fn` under the exclusive GLOBAL write lock. Acquisition failure is FATAL — it propagates (the
 * body never runs). Registered shutdown steps run in order before the lock is released; the lock is
 * released exactly once, on the way out, even if the body or a step throws.
 */
export async function withWriteTransaction<T>(
  outDir: string,
  fn: (tx: WriteTransaction) => Promise<T>,
  opts: TransactionOptions = {},
): Promise<T> {
  const lock: AdvisoryLock = await acquireWriteLock(outDir, opts.timeoutMs);
  const { token, live } = makeWriteToken();
  const steps: ShutdownStep[] = [];
  const tx: WriteTransaction = {
    token,
    onShutdown(step) { steps.push(step); },
  };
  let bodyError: unknown;
  let result: T;
  try {
    result = await fn(tx);
  } catch (e) {
    bodyError = e;
  }
  // finding 69: run shutdown steps (workers-join, checkpoint-flush, ...) in order while STILL holding
  // the lock. A failing step must not abort the remaining steps or leak the lock; collect and rethrow.
  const stepErrors: unknown[] = [];
  for (const step of steps) {
    try { await step(); } catch (e) { stepErrors.push(e); }
  }
  // Only now — workers stopped, checkpoint flushed — release the global lock and invalidate the token.
  live.live = false;
  await lock.release().catch(() => {});
  if (bodyError !== undefined) throw bodyError;
  if (stepErrors.length > 0) throw stepErrors[0];
  return result!;
}

/**
 * Run `fn` under a shared GLOBAL read lock. Acquisition failure is FATAL. Multiple read transactions
 * may overlap; a write transaction waits for readers to drain.
 */
export async function withReadTransaction<T>(
  outDir: string,
  fn: (token: GlobalReadToken) => Promise<T>,
  opts: TransactionOptions = {},
): Promise<T> {
  const lock: AdvisoryLock = await acquireReadLock(outDir, opts.timeoutMs);
  const token = {} as unknown as GlobalReadToken;
  try {
    return await fn(token);
  } finally {
    await lock.release().catch(() => {});
  }
}

/**
 * Run `fn` under a per-image write lock. The GLOBAL write token is a MANDATORY argument: an image lock
 * can only be taken while the global lock is held (GLOBAL-then-IMAGE order). This is enforced at the
 * type level (the signature requires a GlobalWriteToken) and at runtime (a released/forged token is
 * rejected with LockOrderError before any image lock is acquired). The image lock is released before
 * this returns, but the global lock stays with the enclosing write transaction.
 */
export async function withImageWriteTransaction<T>(
  globalToken: GlobalWriteToken,
  outDir: string,
  imageId: string,
  fn: () => Promise<T>,
  opts: TransactionOptions = {},
): Promise<T> {
  const live = liveOf(globalToken);
  if (!live || !live.live) {
    throw new LockOrderError(
      "image write lock requires a live global write lock (GLOBAL then IMAGE); the global transaction is not active",
    );
  }
  const imgLock: AdvisoryLock = await acquireImageWriteLock(outDir, imageId, opts.timeoutMs);
  try {
    return await fn();
  } finally {
    await imgLock.release().catch(() => {});
  }
}
