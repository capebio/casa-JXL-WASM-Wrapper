// @casabio/asset-store — memory-governed, content-addressed asset store (S3).
//
// ONE governor for the browser's ad-hoc byte caches. It owns a single
// byte-budget + LRU eviction policy, a single QuotaExceededError handler, and a
// single `navigator.storage.estimate()`-aware ceiling. Existing caches
// (peepCache, the file-picker IDB byte cap, pyramid level bytes, the manifest
// cache) become CLIENTS of this instead of each re-implementing half a policy.
//
// Layer boundary (see CLAUDE.md): this GOVERNS caches; it does NOT replace
// jxl-cache's OPFS backend. jxl-cache stays the OPFS L2 store and can be plugged
// in as the optional `persistent` backend below — AssetStore drives it, it keeps
// its own OPFS quota handling. AssetStore holds no session/scheduler protocol
// knowledge; it is content-agnostic (keys are opaque strings, values opaque
// byte-carriers). Backpressure/dedupe/session logic must NOT leak in here.
//
// Plain ESM JavaScript (no build step) so the un-bundled `web/` layer can import
// it directly; a hand-written `index.d.ts` gives TS consumers types. Pure logic
// is unit-tested under `test/` with node:test; the browser wiring is exercised
// in the app.

/** @typedef {import('./index.js').PersistentBackend} PersistentBackend */

/**
 * Best-effort byte size of a value. Handles the byte-carriers the browser caches
 * actually hold; opaque objects must pass an explicit `sizeBytes` to `set`.
 * @param {unknown} value
 * @returns {number} bytes, or NaN if not measurable
 */
export function measureBytes(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length * 2; // UTF-16 code units
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
    return value.byteLength;
  }
  // TypedArray / DataView
  if (ArrayBuffer.isView(value)) return /** @type {ArrayBufferView} */ (value).byteLength;
  return NaN;
}

/**
 * FNV-1a 64-bit content hash → lowercase hex. Synchronous and deterministic, so
 * it works in node tests and in a Worker without `crypto.subtle` (which is async
 * and DOM-scoped). Content addressing: identical bytes → identical key → the
 * store dedupes automatically. Not cryptographic; collision-resistant enough for
 * cache keying.
 * @param {ArrayBuffer | ArrayBufferView | string} data
 * @returns {string} 16-char hex
 */
export function contentHash(data) {
  /** @type {Uint8Array} */
  let bytes;
  if (typeof data === "string") {
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    throw new TypeError("contentHash: expected ArrayBuffer, view, or string");
  }
  // 64-bit FNV-1a via two 32-bit lanes (BigInt-free for speed on hot paths).
  let h1 = 0x811c9dc5 | 0; // low
  let h2 = 0xcbf29ce4 | 0; // high
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    h1 ^= b;
    h2 ^= b;
    // multiply by FNV prime 0x100000001b3, folded across the two lanes
    const l = (h1 >>> 0) * 0x01b3;
    const hgh = (h2 >>> 0) * 0x01b3 + (((h1 >>> 0) * 0x0100) & 0xffffffff);
    h1 = l | 0;
    h2 = hgh | 0;
  }
  const hex = (x) => (x >>> 0).toString(16).padStart(8, "0");
  return hex(h2) + hex(h1);
}

/**
 * Greedy byte-budget admission — the SINGLE place the "which entries fit under a
 * byte cap" decision lives. Callers (e.g. the file-picker's per-key persistence)
 * feed candidate items in priority order (most-wanted first); items that fit
 * within `budgetBytes` are admitted in order, the rest are skipped. Pure — no
 * store mutation — so it is trivially testable and reusable.
 *
 * @template T
 * @param {Iterable<T>} items          candidates, most-important first
 * @param {number} budgetBytes         hard byte cap (>= 0)
 * @param {(item: T) => number} sizeOf byte size of an item
 * @returns {{ admitted: T[], skipped: T[], usedBytes: number }}
 */
export function fitWithinBudget(items, budgetBytes, sizeOf) {
  const admitted = [];
  const skipped = [];
  let used = 0;
  const cap = Number.isFinite(budgetBytes) && budgetBytes > 0 ? budgetBytes : 0;
  for (const item of items) {
    const sz = Math.max(0, sizeOf(item) | 0);
    if (used + sz <= cap) {
      admitted.push(item);
      used += sz;
    } else {
      skipped.push(item);
    }
  }
  return { admitted, skipped, usedBytes: used };
}

/**
 * @param {() => Promise<{ quota?: number, usage?: number } | null>} [override]
 * @returns {() => Promise<{ quota?: number, usage?: number } | null>}
 */
function defaultEstimator(override) {
  if (override) return override;
  return async () => {
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.storage &&
        typeof navigator.storage.estimate === "function"
      ) {
        return await navigator.storage.estimate();
      }
    } catch {
      /* ignore — treat as unknown quota */
    }
    return null;
  };
}

/**
 * Adapt a jxl-cache-shaped L2 cache into an AssetStore `PersistentBackend`
 * (S3-Q5). Duck-typed on purpose — this does NOT import jxl-cache; pass any
 * object exposing `get`/`set`/`delete` (and optionally `has`/`init`). The layer
 * boundary holds: asset-store never hard-requires the cache; the app injects it.
 *
 * Two shape gaps are bridged: (1) jxl-cache's `set(key, buffer)` requires a
 * tight, non-shared `ArrayBuffer`, so any TypedArray/DataView view or
 * `SharedArrayBuffer` value is copied into one first; a plain `ArrayBuffer`
 * passes through. (2) If the cache exposes `init()`, it is awaited once
 * (idempotent — jxl-cache caches its own init promise) before the first op so
 * OPFS is ready. Once wrapped, `AssetStore.store()`/`load()` provide the
 * write-through / read-through the handoff describes (put also persists; a
 * memory miss reads through and promotes).
 *
 * @param {{ get(key: string): Promise<ArrayBufferLike | ArrayBufferView | undefined | null>,
 *           set(key: string, buffer: ArrayBuffer): Promise<void>,
 *           delete(key: string): Promise<void>,
 *           has?(key: string): Promise<boolean>,
 *           init?(): Promise<void> }} cache
 * @returns {PersistentBackend}
 */
export function persistentBackendFromCache(cache) {
  if (!cache || typeof cache.get !== "function" || typeof cache.set !== "function") {
    throw new TypeError("persistentBackendFromCache: cache must expose get() and set()");
  }
  /** @type {Promise<void> | null} */
  let ready = null;
  const ensure = () => {
    if (typeof cache.init !== "function") return undefined;
    return (ready ??= Promise.resolve(cache.init()).catch(() => {}));
  };
  /** Copy any byte-carrier into a fresh, tight, non-shared ArrayBuffer. */
  const toArrayBuffer = (value) => {
    if (value instanceof ArrayBuffer) return value; // already tight + non-shared
    let view;
    if (ArrayBuffer.isView(value)) {
      view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
      view = new Uint8Array(value);
    } else {
      throw new TypeError("persistentBackendFromCache: value must be an ArrayBuffer or a view");
    }
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return copy.buffer;
  };
  return {
    async get(key) {
      await ensure();
      return cache.get(key);
    },
    async set(key, value) {
      await ensure();
      await cache.set(key, toArrayBuffer(value));
    },
    async delete(key) {
      await ensure();
      await cache.delete(key);
    },
    async has(key) {
      await ensure();
      if (typeof cache.has === "function") return cache.has(key);
      return (await cache.get(key)) != null;
    },
  };
}

/** Is an error a storage-quota rejection, across browsers/engines? */
export function isQuotaExceeded(err) {
  if (!err) return false;
  // DOMException.QUOTA_EXCEEDED_ERR === 22; Firefox legacy code 1014.
  const name = err.name;
  const code = err.code;
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    code === 1014
  );
}

/**
 * Memory-governed, content-addressed asset store.
 *
 * The in-memory tier is synchronous (matches the ad-hoc `Map` caches it
 * replaces): `get/set/has/peek/delete`. When an optional `persistent` backend is
 * supplied, the async `load/store` pair reads through / writes through it, and
 * the ONE `QuotaExceededError` handler lives in `#handleQuota`.
 */
export class AssetStore {
  /**
   * @param {{
   *   maxBytes: number,
   *   quotaFraction?: number,
   *   persistent?: PersistentBackend | null,
   *   estimateStorage?: () => Promise<{ quota?: number, usage?: number } | null>,
   *   onEvict?: ((key: string, sizeBytes: number, reason: 'lru'|'delete'|'clear') => void) | null,
   *   now?: () => number,
   *   name?: string,
   * }} opts
   */
  constructor(opts) {
    if (!opts || !Number.isFinite(opts.maxBytes) || opts.maxBytes < 0) {
      throw new RangeError("AssetStore: opts.maxBytes must be a non-negative number");
    }
    this.name = opts.name ?? "asset-store";
    this._maxBytes = opts.maxBytes;
    this._quotaFraction =
      Number.isFinite(opts.quotaFraction) && opts.quotaFraction > 0 && opts.quotaFraction <= 1
        ? opts.quotaFraction
        : 0.5;
    this._persistent = opts.persistent ?? null;
    this._estimate = defaultEstimator(opts.estimateStorage);
    this._onEvict = opts.onEvict ?? null;
    this._now = opts.now ?? (() => Date.now());

    /** @type {Map<string, { value: unknown, size: number }>} insertion order == LRU (oldest first) */
    this._mem = new Map();
    this._bytes = 0;

    /** Effective persistent-tier ceiling after the last quota probe (bytes). */
    this._persistentLimit = Infinity;
    this._quota = { quota: undefined, usage: undefined };

    this._stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      evictions: 0,
      quotaHits: 0,
      oversized: 0,
      persistentReads: 0,
      persistentWrites: 0,
      admissionWarnings: 0,
    };
  }

  get maxBytes() {
    return this._maxBytes;
  }
  get bytes() {
    return this._bytes;
  }
  get size() {
    return this._mem.size;
  }
  get persistentLimit() {
    return this._persistentLimit;
  }

  /**
   * Adjust the in-memory byte budget at runtime, evicting LRU entries to fit.
   * @param {number} maxBytes
   */
  setMaxBytes(maxBytes) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) {
      throw new RangeError("setMaxBytes: must be a non-negative number");
    }
    this._maxBytes = maxBytes;
    this.#evictToFit(0);
  }

  /**
   * Store a value in the in-memory tier. `sizeBytes` is auto-measured for
   * byte-carriers (ArrayBuffer / TypedArray / SharedArrayBuffer / string); pass
   * it explicitly for opaque objects (e.g. `{rgba, w, h}` → `rgba.byteLength`).
   * Enforces the byte budget by LRU eviction. Returns the store (chainable).
   * @param {string} key
   * @param {unknown} value
   * @param {number} [sizeBytes]
   */
  set(key, value, sizeBytes) {
    const size = this.#resolveSize(value, sizeBytes);
    // Replace: drop the old accounting first (do not fire onEvict — it's an update).
    const prev = this._mem.get(key);
    if (prev) {
      this._bytes -= prev.size;
      this._mem.delete(key);
    }
    // Make room for the incoming entry (never evict the key we're inserting).
    this.#evictToFit(size);
    this._mem.set(key, { value, size });
    this._bytes += size;
    this._stats.sets++;
    if (size > this._maxBytes) this._stats.oversized++;
    return this;
  }

  /**
   * Read from the in-memory tier, promoting the key to most-recently-used.
   * @param {string} key
   * @returns {unknown | undefined}
   */
  get(key) {
    const e = this._mem.get(key);
    if (e === undefined) {
      this._stats.misses++;
      return undefined;
    }
    // LRU touch: re-insert to move to the end (newest).
    this._mem.delete(key);
    this._mem.set(key, e);
    this._stats.hits++;
    return e.value;
  }

  /**
   * Read without changing LRU order.
   * @param {string} key
   */
  peek(key) {
    const e = this._mem.get(key);
    return e === undefined ? undefined : e.value;
  }

  /** @param {string} key */
  has(key) {
    return this._mem.has(key);
  }

  /**
   * Remove a key. Fires `onEvict(key, size, 'delete')`.
   * @param {string} key
   * @returns {boolean} whether the key existed
   */
  delete(key) {
    const e = this._mem.get(key);
    if (e === undefined) return false;
    this._mem.delete(key);
    this._bytes -= e.size;
    this.#fireEvict(key, e.size, "delete");
    return true;
  }

  /** Drop everything (fires `onEvict(_, _, 'clear')` per entry). */
  clear() {
    for (const [key, e] of this._mem) this.#fireEvict(key, e.size, "clear");
    this._mem.clear();
    this._bytes = 0;
  }

  /** Iterate keys, oldest → newest. */
  keys() {
    return this._mem.keys();
  }

  /**
   * Consult `navigator.storage.estimate()` and clamp the effective persistent
   * ceiling to `quotaFraction × remaining`. Same policy jxl-cache applies to its
   * OPFS tier — kept here so callers governing an IDB tier share ONE rule.
   * @returns {Promise<{ quota?: number, usage?: number, remaining: number, persistentLimit: number }>}
   */
  async refreshQuota() {
    const est = await this._estimate();
    if (est && typeof est.quota === "number") {
      this._quota = est;
      const remaining = Math.max(0, (est.quota ?? 0) - (est.usage ?? 0));
      this._persistentLimit = Math.floor(remaining * this._quotaFraction);
      return { ...est, remaining, persistentLimit: this._persistentLimit };
    }
    // Unknown quota: leave the ceiling unconstrained (backend enforces its own).
    this._persistentLimit = Infinity;
    return { remaining: Infinity, persistentLimit: Infinity };
  }

  /**
   * Read through: memory tier, else the persistent backend (promoting the result
   * into memory). Requires a `persistent` backend for the L2 lookup.
   * @param {string} key
   * @returns {Promise<unknown | undefined>}
   */
  async load(key) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    if (!this._persistent) return undefined;
    const buf = await this._persistent.get(key);
    if (buf === undefined || buf === null) {
      this._stats.misses++;
      return undefined;
    }
    this._stats.persistentReads++;
    this.set(key, buf);
    return buf;
  }

  /**
   * Write through: set in memory AND persist to the backend. The SINGLE
   * QuotaExceededError policy is applied here (`#handleQuota`). If no backend is
   * configured this is just an in-memory `set`.
   * @param {string} key
   * @param {ArrayBufferLike | ArrayBufferView} value
   * @param {number} [sizeBytes]
   * @returns {Promise<void>}
   */
  async store(key, value, sizeBytes) {
    this.set(key, value, sizeBytes);
    if (!this._persistent) return;
    try {
      await this._persistent.set(key, value);
      this._stats.persistentWrites++;
    } catch (err) {
      if (!(await this.#handleQuota(err))) throw err;
      // one retry after freeing memory + surfacing the quota event
      try {
        await this._persistent.set(key, value);
        this._stats.persistentWrites++;
      } catch (err2) {
        if (isQuotaExceeded(err2)) return; // give up silently — backend is full
        throw err2;
      }
    }
  }

  /** @param {string} key */
  async remove(key) {
    this.delete(key);
    if (this._persistent) {
      try {
        await this._persistent.delete(key);
      } catch {
        /* backend delete is best-effort */
      }
    }
  }

  stats() {
    return {
      name: this.name,
      entries: this._mem.size,
      bytes: this._bytes,
      maxBytes: this._maxBytes,
      persistentLimit: this._persistentLimit,
      quota: this._quota.quota,
      usage: this._quota.usage,
      ...this._stats,
    };
  }

  /**
   * Log-only decode-admission preflight (S3-Q3). Given the projected peak byte
   * footprint of a pending decode (e.g. from `estimateDecodePeak`), warn — but do
   * NOT reject — when it would blow the memory budget. Hard-gating is deferred
   * until the model-vs-RSS multiplier is measured against real runs; the S3 ADR's
   * recommended 1.5× safety headroom is the default. Always returns
   * `admitted: true` — the caller proceeds regardless. On the hot path (peak
   * fits) this only does arithmetic: no warn, no allocation.
   *
   * Content-agnostic on purpose: it takes a byte count, not image knowledge, so
   * the governor never learns about the RAW pipeline. The domain estimate lives
   * in `mem-budget.js` (`estimateDecodePeak`); callers compose the two.
   *
   * @param {number} estimatedPeakBytes projected decode peak (bytes)
   * @param {{ budgetBytes?: number, multiplier?: number, label?: string,
   *           warn?: (msg: string) => void }} [opts]
   *   budgetBytes — memory ceiling to check against (default: this store's
   *     remaining in-memory headroom `maxBytes - bytes`);
   *   multiplier — safety headroom on the estimate (default 1.5, per the S3 ADR);
   *   label — identifier included in the warning (e.g. filename);
   *   warn — injectable sink (default `console.warn`) — tests capture it.
   * @returns {{ admitted: boolean, estimatedPeakBytes: number, budgetBytes: number,
   *             projectedBytes: number, wouldExceed: boolean }}
   */
  admit(estimatedPeakBytes, opts = {}) {
    const multiplier =
      Number.isFinite(opts.multiplier) && opts.multiplier > 0 ? opts.multiplier : 1.5;
    const budgetBytes = Number.isFinite(opts.budgetBytes)
      ? Math.max(0, opts.budgetBytes)
      : Math.max(0, this._maxBytes - this._bytes);
    const peak = Number.isFinite(estimatedPeakBytes) ? Math.max(0, estimatedPeakBytes) : 0;
    const projectedBytes = peak * multiplier;
    const wouldExceed = projectedBytes > budgetBytes;
    if (wouldExceed) {
      this._stats.admissionWarnings++;
      const warn =
        opts.warn ??
        ((m) => {
          if (typeof console !== "undefined" && console.warn) console.warn(m);
        });
      const mb = (b) => (b / (1024 * 1024)).toFixed(1);
      warn(
        `[${this.name}] decode preflight${opts.label ? ` (${opts.label})` : ""}: ` +
          `projected ~${mb(projectedBytes)} MB (peak ${mb(peak)} MB ×${multiplier}) ` +
          `exceeds budget ${mb(budgetBytes)} MB — proceeding (log-only, S3-Q3).`,
      );
    }
    return { admitted: true, estimatedPeakBytes: peak, budgetBytes, projectedBytes, wouldExceed };
  }

  /**
   * Lightweight dashboard-facing stats snapshot.
   * Read-only; no side effects; additive (no behavior change).
   */
  getStats() {
    return {
      allocatedBytes: this._bytes,
      budgetBytes: this._maxBytes,
      hits: this._stats.hits,
      misses: this._stats.misses,
      evictions: this._stats.evictions,
    };
  }

  /**
   * A namespaced view: keys are transparently prefixed with `${ns}:` so multiple
   * clients (peep, file-picker, pyramid…) share ONE governed byte budget without
   * key collisions. Returns a thin handle over this same store.
   * @param {string} ns
   */
  namespace(ns) {
    const prefix = `${ns}:`;
    const store = this;
    return {
      key: (k) => prefix + k,
      set: (k, v, s) => store.set(prefix + k, v, s),
      get: (k) => store.get(prefix + k),
      peek: (k) => store.peek(prefix + k),
      has: (k) => store.has(prefix + k),
      delete: (k) => store.delete(prefix + k),
      load: (k) => store.load(prefix + k),
      store: (k, v, s) => store.store(prefix + k, v, s),
      remove: (k) => store.remove(prefix + k),
      *keys() {
        for (const full of store.keys()) {
          if (full.startsWith(prefix)) yield full.slice(prefix.length);
        }
      },
    };
  }

  // ---- internals ----

  /** @returns {number} */
  #resolveSize(value, sizeBytes) {
    if (Number.isFinite(sizeBytes)) return Math.max(0, sizeBytes | 0);
    const m = measureBytes(value);
    if (Number.isNaN(m)) {
      throw new TypeError(
        "AssetStore.set: cannot measure value size; pass sizeBytes explicitly for opaque values",
      );
    }
    return m;
  }

  /** Evict oldest entries until `this._bytes + incoming <= maxBytes`. */
  #evictToFit(incoming) {
    if (this._maxBytes === Infinity) return;
    while (this._bytes + incoming > this._maxBytes && this._mem.size > 0) {
      const oldest = this._mem.keys().next().value;
      const e = this._mem.get(oldest);
      this._mem.delete(oldest);
      this._bytes -= e.size;
      this._stats.evictions++;
      this.#fireEvict(oldest, e.size, "lru");
    }
  }

  /**
   * The ONE QuotaExceededError policy. A persistent-tier quota rejection means
   * the *disk/OPFS* is full — evicting the RAM tier would not free disk, so we do
   * NOT touch memory here (the value stays in the L1 fallback). Instead we record
   * the event, refresh the quota-derived ceiling, and signal `store()` to retry
   * once — giving a self-evicting backend (jxl-cache freeing its own OPFS
   * entries) the chance to make room. Returns whether this was a quota error.
   */
  async #handleQuota(err) {
    if (!isQuotaExceeded(err)) return false;
    this._stats.quotaHits++;
    await this.refreshQuota();
    return true;
  }

  #fireEvict(key, size, reason) {
    if (this._onEvict) {
      try {
        this._onEvict(key, size, reason);
      } catch {
        /* client eviction hook must never break the store */
      }
    }
  }
}

// Re-export the RAW-decode memory preflight (a pure JS mirror of the Rust
// `estimate_decode_peak`) so admission callers get the estimate + the governor
// from one entry point. See `mem-budget.js`.
export {
  estimateDecodePeak,
  estimateDecodePeakBytes,
  OUT_FULL_RGB8,
  OUT_LIGHTBOX,
  OUT_THUMB,
  OUT_FULL_16,
  OUT_NO_ORIENT,
  OUT_FULL_DISP16,
  OUT_BATCH_DEFAULT,
} from "./mem-budget.js";

export default AssetStore;
