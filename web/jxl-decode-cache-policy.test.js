// Behavioral test for the JXL decode cache-write gate (Finding 48).
//
// The bug: broadcast() wrote getCardState(card)._jxlDecoded via
// applyJxlDecodeCachePolicy BEFORE invoking the per-listener callback, so the
// isStale guard inside each callback protected only the canvas paint — NEVER the
// cache commit. A decode that finished after a reprocess (generation bump) would
// still poison the card cache with pixels for the OLD source bytes.
//
// The fix threads each listener's result-tag into the cache-write path so the
// commit itself is gated by store.isStale(tag, state) BEFORE the write. This
// test drives that path directly against a fake cacheTarget and asserts a STALE
// tag does NOT write _jxlDecoded, while a FRESH tag DOES.
//
// Run with: bun test web/jxl-decode-cache-policy.test.js

import { expect, test, describe, beforeEach } from 'bun:test';
import { commitJxlDecodeCache } from './jxl-decode-cache-policy.js';
import { createAssetStateStore } from './asset-state-store.js';

describe('commitJxlDecodeCache: stale-gate BEFORE cache write (Finding 48)', () => {
    let store;
    let target;         // fake cacheTarget state object (stands in for getCardState(card))
    let seen;           // per-decode onFirstProgress dedupe set
    const pixels = new Uint8ClampedArray([1, 2, 3, 4]);

    beforeEach(() => {
        store = createAssetStateStore();
        target = {};
        seen = new Set();
    });

    test('onFinal: STALE tag does NOT write _jxlDecoded', () => {
        const assetId = 'asset-a';
        store.getOrCreate(assetId);
        // Tag captured at dispatch (generation 0)...
        const tag = store.makeResultTag(assetId);
        // ...then the card is reprocessed (bytes change) → generation bumps to 1.
        store.bumpGeneration(assetId);

        commitJxlDecodeCache({
            target, tag, store, seen,
            decodeId: 1, pixels, w: 2, h: 1, isFinal: true, policy: 'onFinal',
        });

        expect(target._jxlDecoded).toBeUndefined();
    });

    test('onFinal: FRESH tag DOES write _jxlDecoded', () => {
        const assetId = 'asset-a';
        store.getOrCreate(assetId);
        const tag = store.makeResultTag(assetId); // current generation

        commitJxlDecodeCache({
            target, tag, store, seen,
            decodeId: 1, pixels, w: 2, h: 1, isFinal: true, policy: 'onFinal',
        });

        expect(target._jxlDecoded).toEqual({ rgba: pixels, w: 2, h: 1 });
    });

    test('onFirstProgress: STALE tag does NOT write _jxlDecoded (whole point of prefetch is the cache)', () => {
        const assetId = 'asset-a';
        store.getOrCreate(assetId);
        const tag = store.makeResultTag(assetId);
        store.bumpGeneration(assetId); // reprocess after dispatch

        commitJxlDecodeCache({
            target, tag, store, seen,
            decodeId: 7, pixels, w: 2, h: 1, isFinal: false, policy: 'onFirstProgress',
        });

        expect(target._jxlDecoded).toBeUndefined();
    });

    test('onFirstProgress: FRESH tag writes _jxlDecoded and stamps the decodeId', () => {
        const assetId = 'asset-a';
        store.getOrCreate(assetId);
        const tag = store.makeResultTag(assetId);

        commitJxlDecodeCache({
            target, tag, store, seen,
            decodeId: 7, pixels, w: 2, h: 1, isFinal: false, policy: 'onFirstProgress',
        });

        expect(target._jxlDecoded).toEqual({ rgba: pixels, w: 2, h: 1 });
        expect(target._jxlProgressCacheDecodeId).toBe(7);
    });

    test('batch scenario: late decode for a reprocessed card never poisons the fresh cache', () => {
        const assetId = 'asset-a';
        store.getOrCreate(assetId);

        // Decode #1 dispatched (generation 0)
        const staleTag = store.makeResultTag(assetId);
        // User edits/reprocesses → generation 1, decode #2 dispatched
        store.bumpGeneration(assetId);
        const freshTag = store.makeResultTag(assetId);

        // Decode #2 (fresh) finishes first and commits.
        const freshPixels = new Uint8ClampedArray([9, 9, 9, 9]);
        commitJxlDecodeCache({
            target, tag: freshTag, store, seen: new Set(),
            decodeId: 2, pixels: freshPixels, w: 2, h: 1, isFinal: true, policy: 'onFinal',
        });
        expect(target._jxlDecoded.rgba).toBe(freshPixels);

        // Decode #1 (stale) finishes late — must NOT overwrite the fresh cache.
        commitJxlDecodeCache({
            target, tag: staleTag, store, seen: new Set(),
            decodeId: 1, pixels, w: 2, h: 1, isFinal: true, policy: 'onFinal',
        });
        expect(target._jxlDecoded.rgba).toBe(freshPixels); // still the fresh pixels
    });

    test('no tag (assetId-less card) falls back to unguarded write — backward compatible', () => {
        // Cards without an assetId (single-file drop before hydrate) must still cache.
        commitJxlDecodeCache({
            target, tag: null, store, seen,
            decodeId: 1, pixels, w: 2, h: 1, isFinal: true, policy: 'onFinal',
        });
        expect(target._jxlDecoded).toEqual({ rgba: pixels, w: 2, h: 1 });
    });

    test('policy "never" writes nothing regardless of tag freshness', () => {
        const assetId = 'asset-a';
        store.getOrCreate(assetId);
        const tag = store.makeResultTag(assetId);
        commitJxlDecodeCache({
            target, tag, store, seen,
            decodeId: 1, pixels, w: 2, h: 1, isFinal: true, policy: 'never',
        });
        expect(target._jxlDecoded).toBeUndefined();
    });

    test('null target is a no-op (no throw)', () => {
        expect(() => commitJxlDecodeCache({
            target: null, tag: null, store, seen,
            decodeId: 1, pixels, w: 2, h: 1, isFinal: true, policy: 'onFinal',
        })).not.toThrow();
    });
});
