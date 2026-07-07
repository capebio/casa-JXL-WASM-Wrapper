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

export default AssetStore;
