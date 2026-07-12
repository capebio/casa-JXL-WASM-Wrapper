// web/lightbox/worker-store.js
// Extracted worker byte-store logic so tests can unit-exercise it with a small budget.
// Imported by tiled-decode-worker.js (production default: 256 MiB) and by byte-carrier
// tests that inject a tiny budget to exercise LRU eviction without allocating real data.
//
// NOTE: This module has NO production-behaviour change — createWorkerStore() called with
// no argument uses the same 256 MiB BYTE_BUDGET as the old inline code.

/** Default retained-byte budget per worker (256 MiB). Only overridden in tests. */
export const DEFAULT_BYTE_BUDGET = 256 * 1024 * 1024;

/**
 * Create an isolated worker byte-store instance.
 *
 * @param {number} [budget=DEFAULT_BYTE_BUDGET] Override for tests; does NOT change the
 *   production default. Pass a small value (e.g. 1024) to exercise eviction without
 *   real 256 MiB allocations.
 */
export function createWorkerStore(budget = DEFAULT_BYTE_BUDGET) {
  /** @type {Map<number, import('./worker-store.js').StoreEntry>} bytesId -> entry (insertion order = LRU recency) */
  const store = new Map();
  let storeBytes = 0;

  /** Mark an entry most-recently-used (Map preserves insertion order → reinsert to move to end). */
  function touch(bytesId) {
    const e = store.get(bytesId);
    if (e) { store.delete(bytesId); store.set(bytesId, e); }
  }

  function dropEntry(bytesId) {
    const e = store.get(bytesId);
    if (!e) return;
    storeBytes -= e.bytes;
    store.delete(bytesId);
  }

  /** Evict LRU entries with no outstanding refs until under budget. */
  function evictToBudget() {
    if (storeBytes <= budget) return;
    for (const [id, e] of store) {
      if (storeBytes <= budget) break;
      if (e.refs > 0) continue; // never evict a referenced entry
      dropEntry(id);
    }
  }

  function upsertWhole(bytesId, kind, view, byteLen) {
    const prev = store.get(bytesId);
    if (prev) storeBytes -= prev.bytes;
    const entry = { kind, whole: view, bytes: byteLen, refs: (prev?.refs ?? 0) + 1 };
    store.set(bytesId, entry);
    storeBytes += byteLen;
    touch(bytesId);
    evictToBudget();
  }

  function loadMessage(msg) {
    if (msg.sab !== undefined) {
      const view = new Uint8Array(msg.sab, 0, msg.byteLength);
      upsertWhole(msg.bytesId, 'sab', view, msg.byteLength);
    } else if (msg.ranges !== undefined) {
      let entry = store.get(msg.bytesId);
      if (!entry || entry.kind !== 'ranges') {
        entry = { kind: 'ranges', ranges: new Map(), offsets: new Set(), bytes: 0, refs: 0 };
        store.set(msg.bytesId, entry);
      }
      for (const r of msg.ranges) {
        if (entry.offsets.has(r.offset)) continue;
        const b = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes);
        entry.ranges.set(`${r.gx},${r.gy}`, b);
        entry.offsets.add(r.offset);
        entry.bytes += b.byteLength;
        storeBytes += b.byteLength;
      }
      entry.refs += 1;
      touch(msg.bytesId);
      evictToBudget();
    } else {
      const b = msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes);
      upsertWhole(msg.bytesId, 'whole', b, b.byteLength);
    }
  }

  /**
   * Handle an unload message. Returns true if the entry was freed (refcount→0).
   * @param {number} bytesId
   * @returns {boolean}
   */
  function unloadMessage(bytesId) {
    const e = store.get(bytesId);
    if (e) {
      e.refs -= 1;
      if (e.refs <= 0) { dropEntry(bytesId); return true; }
    }
    return false;
  }

  return {
    /** The backing store Map (bytesId → StoreEntry). Exposed for test assertions. */
    store,
    /** Current tracked byte count. Exposed for test assertions. */
    get storeBytes() { return storeBytes; },
    touch,
    dropEntry,
    evictToBudget,
    loadMessage,
    unloadMessage,
    upsertWhole,
  };
}
