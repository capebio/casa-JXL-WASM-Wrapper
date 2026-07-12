// jxl-derived-cache.js — byte-budgeted, LRU-evicting cache for decoded JXL
// RGBA pixel buffers (finding 11, 29).
//
// Previously _jxlDecoded was stored directly on per-card state (a WeakMap) with
// no byte accounting, no eviction, and no cross-card LRU. Under a long session
// with many cards, every full-res RGBA buffer (~80 MB at 20 MP) stayed in memory
// until GC collected the detached card — effectively unbounded.
//
// This module wraps AssetStore into a typed, purpose-built API:
//   - Keys are opaque strings (assetId or any stable per-card key).
//   - Values are { rgba: Uint8ClampedArray, w: number, h: number }.
//   - Byte size is the rgba.byteLength of each entry.
//   - LRU eviction enforces the byte budget: oldest entry is evicted first.
//   - invalidate(key) / delete(key): explicit removal on generation change or card delete.
//   - onEvict callback: optional hook for tests/metrics.
//
// Layer: sits beside peepDecodedStore in main.js — a governed cache client of
// AssetStore (S3 pattern). It has NO session/scheduler protocol knowledge.

import { AssetStore } from '../packages/asset-store/src/index.js';

/**
 * Create a byte-budgeted, LRU-evicting cache for decoded JXL pixel buffers.
 *
 * @param {{
 *   maxBytes: number,
 *   onEvict?: ((key: string, reason: 'lru'|'delete'|'clear') => void) | null,
 *   name?: string,
 * }} opts
 * @returns {{
 *   get(key: string): {rgba: Uint8ClampedArray, w: number, h: number} | undefined,
 *   set(key: string, value: {rgba: Uint8ClampedArray, w: number, h: number}, sizeBytes: number): void,
 *   invalidate(key: string): boolean,
 *   delete(key: string): boolean,
 *   clear(): void,
 *   readonly bytes: number,
 *   readonly size: number,
 * }}
 */
export function createDerivedCache({ maxBytes, onEvict = null, name = 'jxl-derived' } = {}) {
    const store = new AssetStore({
        maxBytes,
        name,
        onEvict: onEvict ? (key, sizeBytes, reason) => onEvict(key, reason) : null,
    });

    return {
        /**
         * Retrieve a decoded entry by key. Returns undefined on miss.
         * Promotes the entry to most-recently-used.
         * @param {string} key
         * @returns {{rgba: Uint8ClampedArray, w: number, h: number} | undefined}
         */
        get(key) {
            return /** @type {any} */ (store.get(key));
        },

        /**
         * Store a decoded entry. sizeBytes must be the rgba.byteLength.
         * Enforces the byte budget via LRU eviction.
         * @param {string} key
         * @param {{rgba: Uint8ClampedArray, w: number, h: number}} value
         * @param {number} sizeBytes
         */
        set(key, value, sizeBytes) {
            store.set(key, value, sizeBytes);
        },

        /**
         * Explicitly remove a key. Called when a card's source generation changes
         * (reprocess) or when the card is deleted.
         * Fires onEvict(key, 'delete') if a listener is registered.
         * @param {string} key
         * @returns {boolean} whether the key existed
         */
        invalidate(key) {
            return store.delete(key);
        },

        /**
         * Alias for invalidate — identical semantics, conventional name.
         * @param {string} key
         * @returns {boolean}
         */
        delete(key) {
            return store.delete(key);
        },

        /** Drop all entries. */
        clear() {
            store.clear();
        },

        /** Current byte usage. */
        get bytes() {
            return store.bytes;
        },

        /** Number of live entries. */
        get size() {
            return store.size;
        },
    };
}
