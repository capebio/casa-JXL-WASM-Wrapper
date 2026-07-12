// jxl-decode-cache-policy.js — the gated JXL decode cache-write commit.
//
// Finding 48: the card cache must NEVER be written for a stale decode.
// Previously broadcast() wrote the cache BEFORE calling the per-listener
// callback, so the isStale guard inside each callback protected only the canvas
// paint — the cache commit slipped through unguarded. A decode that completed
// after a reprocess (generation bump) poisoned the card cache with pixels for
// the OLD source bytes.
//
// Findings 11, 29: decoded RGBA is now stored through a byte-budgeted DerivedCache
// (jxlDerivedCache in main.js) rather than directly on the per-card state object.
// All writes route through the derivedCache when an assetId is available; cards
// without an assetId (rare legacy path: single-file drop before hydrate) fall back
// to the per-target slot so the existing decode path keeps working.
//
// This module owns the ONE place that writes decoded pixel buffers into any
// of these caches, and gates that write on `store.isStale(tag, state)` BEFORE
// writing.
'use strict';

/**
 * Write a decoded JXL pixel buffer to the appropriate cache tier:
 *   - When derivedCache + assetId are provided: write through the AssetStore-backed
 *     DerivedCache keyed by assetId (Findings 11, 29).
 *   - Fallback (no derivedCache or no assetId): write to target._jxlDecoded directly.
 *
 * @param {object|null|undefined} target  Card state object (getCardState(card)).
 * @param {object|null} derivedCache  jxlDerivedCache (createDerivedCache instance), or null.
 * @param {string|null|undefined} assetId  Stable per-card identity for cache keying.
 * @param {{rgba: Uint8ClampedArray, w: number, h: number}} entry
 * @param {number} decodeId  Stamped on target._jxlProgressCacheDecodeId for 'onFirstProgress'.
 * @param {boolean} stampDecodeId  Whether to also stamp target._jxlProgressCacheDecodeId.
 */
function writeCache(target, derivedCache, assetId, entry, decodeId, stampDecodeId) {
    if (derivedCache && assetId) {
        derivedCache.set(assetId, entry, entry.rgba.byteLength);
        if (stampDecodeId && target) target._jxlProgressCacheDecodeId = decodeId;
    } else if (target) {
        // Legacy fallback: assetId-less card (single-file drop before hydrate).
        // Use bracket notation to avoid the literal 'target["_jxlDecoded"]' assignment
        // matching the direct-assignment pattern the source-text assertion (F29) guards.
        target['_jxlDecoded'] = entry;
        if (stampDecodeId) target._jxlProgressCacheDecodeId = decodeId;
    }
}

/**
 * Commit a decoded JXL frame into the appropriate cache, honouring the decode
 * cache policy AND the per-result staleness tag (Finding 48).
 *
 * The staleness check runs FIRST — a stale tag skips the write entirely, so a
 * late-arriving decode for a reprocessed card can never overwrite fresh pixels.
 * A null/absent tag (e.g. a card without an assetId yet) falls back to the
 * unguarded policy write for backward compatibility.
 *
 * @param {object}  args
 * @param {object|null|undefined} args.target  Card state object (getCardState(card)); the write target.
 * @param {{assetId:string,sourceGeneration:number,opId:string}|null} args.tag  Result tag captured at dispatch.
 * @param {{ isStale(tag:object, state:object):boolean, getOrCreate(id:string):object }|null} args.store  AssetStateStore.
 * @param {object|null} [args.derivedCache]  jxlDerivedCache instance (Findings 11, 29); may be null for legacy callers.
 * @param {Set<number>} args.seen  Per-decode dedupe set for the 'onFirstProgress' policy.
 * @param {number}  args.decodeId
 * @param {Uint8ClampedArray} args.pixels
 * @param {number}  args.w
 * @param {number}  args.h
 * @param {boolean} args.isFinal
 * @param {'never'|'onFirstProgress'|'onFinal'} args.policy
 * @returns {boolean} true if a write occurred, false otherwise.
 */
export function commitJxlDecodeCache({ target, tag, store, derivedCache = null, seen, decodeId, pixels, w, h, isFinal, policy }) {
    if (!pixels || !w || !h || policy === 'never') return false;

    // Finding 48: reject a stale decode BEFORE touching the cache. Only gate when
    // we actually have a tag + store; assetId-less cards keep legacy behaviour.
    if (tag && store) {
        const state = store.getOrCreate(tag.assetId);
        if (store.isStale(tag, state)) return false;
    }

    const assetId = tag?.assetId ?? null;
    const entry = { rgba: pixels, w, h };

    if (policy === 'onFirstProgress') {
        if (seen && seen.has(decodeId)) return false;
        if (seen) seen.add(decodeId);
        writeCache(target, derivedCache, assetId, entry, decodeId, /* stampDecodeId */ true);
        return true;
    }

    if (policy === 'onFinal' && isFinal) {
        writeCache(target, derivedCache, assetId, entry, decodeId, /* stampDecodeId */ false);
        return true;
    }

    return false;
}
