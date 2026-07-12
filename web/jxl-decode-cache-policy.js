// jxl-decode-cache-policy.js — the gated JXL decode cache-write commit.
//
// Finding 48: the card cache (`state._jxlDecoded`) must NEVER be written for a
// stale decode. Previously broadcast() wrote the cache BEFORE calling the
// per-listener callback, so the isStale guard inside each callback protected only
// the canvas paint — the cache commit slipped through unguarded. A decode that
// completed after a reprocess (generation bump) poisoned the card cache with
// pixels for the OLD source bytes.
//
// This module owns the ONE place that writes `_jxlDecoded`, and gates that write
// on `store.isStale(tag, state)` BEFORE writing. main.js's
// applyJxlDecodeCachePolicy delegates here with target = getCardState(card).
'use strict';

/**
 * Commit a decoded JXL frame into a card's `_jxlDecoded` cache, honouring the
 * decode cache policy AND the per-result staleness tag (Finding 48).
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
 * @param {Set<number>} args.seen  Per-decode dedupe set for the 'onFirstProgress' policy.
 * @param {number}  args.decodeId
 * @param {Uint8ClampedArray} args.pixels
 * @param {number}  args.w
 * @param {number}  args.h
 * @param {boolean} args.isFinal
 * @param {'never'|'onFirstProgress'|'onFinal'} args.policy
 * @returns {boolean} true if a write occurred, false otherwise.
 */
export function commitJxlDecodeCache({ target, tag, store, seen, decodeId, pixels, w, h, isFinal, policy }) {
    if (!target || !pixels || !w || !h || policy === 'never') return false;

    // Finding 48: reject a stale decode BEFORE touching the cache. Only gate when
    // we actually have a tag + store; assetId-less cards keep legacy behaviour.
    if (tag && store) {
        const state = store.getOrCreate(tag.assetId);
        if (store.isStale(tag, state)) return false;
    }

    if (policy === 'onFirstProgress') {
        if (seen && seen.has(decodeId)) return false;
        if (seen) seen.add(decodeId);
        target._jxlProgressCacheDecodeId = decodeId;
        target._jxlDecoded = { rgba: pixels, w, h };
        return true;
    }

    if (policy === 'onFinal' && isFinal) {
        target._jxlDecoded = { rgba: pixels, w, h };
        return true;
    }

    return false;
}
