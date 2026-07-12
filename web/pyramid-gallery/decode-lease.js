// decode-lease.js
// Packet 2 Task 5 (findings 42, 49): refcounted ownership of a shared decode.
//
// Problem (finding 49): a shared/deduped decode is joined by several consumers.
// The underlying decode must be cancelled ONLY when NO consumer wants it any
// more — i.e. when every consumer has released. The prior grid scheme counted
// only consumers that carried an AbortSignal, so a consumer WITHOUT a signal
// was invisible: an aborting joiner could drop the refcount to zero and cancel
// a decode a no-signal caller still wanted.
//
// Model: `createSharedDecode(start)` invokes `start(sharedSignal)` exactly once
// and hands out `DecodeLease` objects via `acquire(signal?)`. EVERY consumer —
// signal or not — owns exactly one lease and must release it once. The shared
// decode is aborted (via the shared AbortController) only when the live lease
// count returns to zero. A consumer with an AbortSignal auto-releases its lease
// when that signal aborts; a consumer without one keeps its lease until it
// explicitly releases in `finally`.
//
// This is the concrete implementation of the `DecodeLease<T>` interface pinned
// in packages/jxl-pyramid/src/runtime.ts (finding 76).

/**
 * @template T
 * @typedef {{ promise: Promise<T>, release: () => boolean }} DecodeLease
 */

/**
 * Create a refcounted, cancel-at-zero shared decode.
 *
 * @template T
 * @param {(sharedSignal: AbortSignal) => Promise<T>} start
 *   Runs the underlying decode. Called exactly once, lazily, on the first
 *   `acquire()`. Receives the shared AbortSignal; it must abort the decode when
 *   that signal fires (which only happens once ALL leases are released).
 * @param {{ onCancel?: () => void }} [opts]
 *   `onCancel` is invoked SYNCHRONOUSLY at the instant the shared decode is
 *   cancelled at refcount zero (inside `cancelIfIdle`, before the abort listener
 *   settles the promise). A registry uses it to evict its entry immediately so a
 *   re-`acquire()` in the same synchronous tick starts fresh instead of joining
 *   the already-cancelled decode (finding I-1). Fires at most once.
 * @returns {{ acquire: (signal?: AbortSignal | null) => DecodeLease<T>, readonly leaseCount: number, readonly cancelled: boolean }}
 */
export function createSharedDecode(start, { onCancel } = {}) {
  const sharedController = new AbortController();
  let count = 0;
  let started = false;
  let promise = null;
  let cancelled = false;

  function ensureStarted() {
    if (!started) {
      started = true;
      // Start the decode SYNCHRONOUSLY so its abort listener / internal state are
      // wired up before acquire() returns — otherwise an immediate release()
      // could fire the shared abort before start() had a chance to observe it.
      // A synchronous throw in start() is normalized into a rejected promise.
      try {
        promise = Promise.resolve(start(sharedController.signal));
      } catch (err) {
        promise = Promise.reject(err);
      }
      // Keep the shared promise's rejection always handled internally: when the
      // decode is cancelled at refcount 0, no lease may be awaiting it, and an
      // unhandled rejection would leak. Consumers still get the real `promise`.
      promise.catch(() => {});
    }
    return promise;
  }

  function cancelIfIdle() {
    if (count <= 0 && !cancelled) {
      cancelled = true;
      // Evict-on-cancel hook FIRST (finding I-1): drop the registry entry
      // synchronously, before aborting, so a re-acquire in this same tick cannot
      // rejoin the about-to-be-cancelled shared. onCancel must not throw.
      onCancel?.();
      sharedController.abort();
    }
  }

  /**
   * The caller MUST always call `release()` on the returned lease — including on
   * success, in a `finally`. If a lease is never released, its refcount is never
   * returned, so the shared decode never cancels and (when a `signal` was passed)
   * its `abort` listener leaks.
   * @param {AbortSignal | null} [signal]
   * @returns {DecodeLease<T>}
   */
  function acquire(signal = null) {
    const p = ensureStarted();
    count += 1;

    // Per-lease "live" flag so a double release (explicit + auto-on-abort, or
    // two explicit calls) cannot over-decrement the shared count.
    let live = true;

    /** @returns {boolean} true if this call actually released a live lease. */
    function release() {
      if (!live) return false;
      live = false;
      count -= 1;
      if (signal) signal.removeEventListener('abort', onAbort);
      cancelIfIdle();
      return true;
    }

    function onAbort() {
      release();
    }

    if (signal) {
      if (signal.aborted) {
        // Pre-aborted consumer: it took a lease (so it is counted) but wants
        // out immediately. Release now — this does NOT cancel the shared decode
        // unless it was the last lease, which is exactly the desired semantics.
        release();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    return { promise: p, release };
  }

  return {
    acquire,
    get leaseCount() {
      return count;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

/**
 * A registry of in-flight shared decodes keyed by a job key (e.g.
 * `imageId:contenthash`). Multiple callers for the same key dedupe onto ONE
 * underlying decode and each receive their own lease. The underlying decode is
 * cancelled only when every caller for that key has released (finding 49), and
 * the registry entry is evicted once the decode settles so a later call for the
 * same key starts fresh.
 *
 * @template T
 * @returns {{
 *   decode: (key: string, start: (sharedSignal: AbortSignal) => Promise<T>, signal?: AbortSignal | null) => DecodeLease<T>,
 *   has: (key: string) => boolean,
 *   size: () => number,
 * }}
 */
export function createInflightDecodes() {
  /** @type {Map<string, ReturnType<typeof createSharedDecode>>} */
  const inflight = new Map();

  /**
   * The caller MUST always call `release()` on the returned lease — including on
   * success, in a `finally`. A lease that is never released keeps the shared
   * decode from cancelling and leaks its `signal` abort listener.
   * @param {string} key
   * @param {(sharedSignal: AbortSignal) => Promise<T>} start
   * @param {AbortSignal | null} [signal]
   * @returns {DecodeLease<T>}
   */
  function decode(key, start, signal = null) {
    let shared = inflight.get(key);
    // Defensive (finding I-1): never rejoin a shared that has already been
    // cancelled at refcount zero. The onCancel hook below normally evicts it
    // synchronously, but this guard also covers any path that leaves a cancelled
    // shared mapped — drop it and fall through to a fresh decode.
    if (shared && shared.cancelled) {
      inflight.delete(key);
      shared = undefined;
    }
    if (!shared) {
      // `evict` only removes THIS entry (identity-checked) so it can never delete
      // a fresher decode that replaced it under the same key. Idempotent.
      const evict = () => { if (inflight.get(key) === shared) inflight.delete(key); };
      shared = createSharedDecode((sharedSignal) => {
        // Call the real decode SYNCHRONOUSLY (its abort listener must be wired
        // before acquire() returns; see ensureStarted). Evict the registry entry
        // once the decode settles (success OR failure) so the key is reusable and
        // a settled decode is never rejoined.
        let p;
        try {
          p = Promise.resolve(start(sharedSignal));
        } catch (err) {
          evict();
          throw err;
        }
        p.then(evict, evict);
        return p;
      }, {
        // Cancel-at-zero evicts the entry SYNCHRONOUSLY (finding I-1), before the
        // async settle path runs, so a re-decode(key) in the same tick starts
        // fresh instead of attaching to the just-cancelled shared. `evict` is
        // identity-checked and idempotent, so a later async settle is a no-op.
        onCancel: () => evict(),
      });
      inflight.set(key, shared);
    }
    return shared.acquire(signal);
  }

  return {
    decode,
    has: (key) => inflight.has(key),
    size: () => inflight.size,
  };
}
