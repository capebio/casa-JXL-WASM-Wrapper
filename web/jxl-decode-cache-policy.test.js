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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { commitJxlDecodeCache } from './jxl-decode-cache-policy.js';
import { createAssetStateStore } from './asset-state-store.js';
import { createDerivedCache } from './jxl-derived-cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(__dirname, 'main.js'), 'utf8');
const cropSrc = readFileSync(join(__dirname, 'crop.js'), 'utf8');

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

// ---------------------------------------------------------------------------
// Source-text assertion: decodeFullJxlFor passes cacheTag (Finding 48 gate)
// ---------------------------------------------------------------------------

describe('main.js source-text: decodeFullJxlFor passes cacheTag (Finding 48)', () => {
    test('decodeFullJxlFor dispatch includes cacheTag', () => {
        // The decodeFullJxlFor site must capture a result-tag at dispatch time
        // and pass it as cacheTag so the cache-write is gated on generation.
        // A missing cacheTag lets stale pixels from a pre-bump decode commit to
        // _jxlDecoded unguarded (the original F48 race).
        //
        // Strategy: find the function body (window.decodeFullJxlFor = function ...
        // up to the next window.* assignment that closes it), then assert cacheTag
        // appears within that span.
        const fnStart = mainSrc.indexOf('window.decodeFullJxlFor = function decodeFullJxlFor');
        expect(fnStart).toBeGreaterThan(-1);
        // The function ends with "};" — grab up to 2000 chars from the definition.
        const fnBody = mainSrc.slice(fnStart, fnStart + 2000);
        expect(fnBody).toContain('cacheTag');
    });

    test('decodeFullJxlFor cacheTag is derived from assetStateStore.makeResultTag', () => {
        // The tag must be a fresh result-tag, not a hardcoded value.
        const fnStart = mainSrc.indexOf('window.decodeFullJxlFor = function decodeFullJxlFor');
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = mainSrc.slice(fnStart, fnStart + 2000);
        expect(fnBody).toContain('makeResultTag');
    });
});

// ---------------------------------------------------------------------------
// M-3: derived-cache read-path (Finding I-1)
//
// Post-migration, decodeFullJxlFor resolves with the pixels stored in
// jxlDerivedCache (keyed by assetId). The bug was that crop.js read
// parentCard._jxlDecoded directly, which is undefined for assetId cards
// because the write now goes to jxlDerivedCache, not to the DOM element
// property. This section verifies:
//   1. (Behavioral) commitJxlDecodeCache writes to derivedCache and the
//      written value is readable back via derivedCache.get(assetId).
//   2. (Behavioral) a miss on an unknown assetId returns undefined.
//   3. (Behavioral) after invalidation the entry is no longer readable.
//   4. (Source assertion) crop.js does NOT read parentCard._jxlDecoded
//      as the final pixel source; it uses the return value of decodeFullJxlFor.
// ---------------------------------------------------------------------------

describe('M-3: derived-cache write→read round-trip (I-1 regression guard)', () => {
    test('commitJxlDecodeCache with derivedCache writes pixels; get() returns them', () => {
        const store = createAssetStateStore();
        const derivedCache = createDerivedCache({ maxBytes: 10 * 1024 * 1024 });
        const assetId = 'card-subject-001';
        store.getOrCreate(assetId);
        const tag = store.makeResultTag(assetId);
        const pixels = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
        const target = {};

        commitJxlDecodeCache({
            target, tag, store, derivedCache,
            seen: new Set(),
            decodeId: 42, pixels, w: 2, h: 1, isFinal: true, policy: 'onFinal',
        });

        // The value must be readable from the derived cache, NOT from target._jxlDecoded.
        const hit = derivedCache.get(assetId);
        expect(hit).not.toBeUndefined();
        expect(hit.rgba).toBe(pixels);
        expect(hit.w).toBe(2);
        expect(hit.h).toBe(1);
        // target._jxlDecoded must NOT be set (that would be the old legacy path).
        expect(target._jxlDecoded).toBeUndefined();
    });

    test('derived-cache miss returns undefined for an assetId that was never written', () => {
        const derivedCache = createDerivedCache({ maxBytes: 10 * 1024 * 1024 });
        expect(derivedCache.get('never-written-asset')).toBeUndefined();
    });

    test('after invalidation, derived-cache read returns undefined (stale-invalidation path)', () => {
        const store = createAssetStateStore();
        const derivedCache = createDerivedCache({ maxBytes: 10 * 1024 * 1024 });
        const assetId = 'card-invalidate-me';
        store.getOrCreate(assetId);
        const tag = store.makeResultTag(assetId);
        const pixels = new Uint8ClampedArray([1, 2, 3, 4]);
        const target = {};

        commitJxlDecodeCache({
            target, tag, store, derivedCache,
            seen: new Set(),
            decodeId: 1, pixels, w: 1, h: 1, isFinal: true, policy: 'onFinal',
        });
        expect(derivedCache.get(assetId)).not.toBeUndefined();

        // Simulate reprocess / card delete → invalidate.
        derivedCache.invalidate(assetId);
        expect(derivedCache.get(assetId)).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// M-3: crop.js source-text assertion — uses decodeFullJxlFor return value
// (not a bare parentCard._jxlDecoded read) as the final pixel source.
// ---------------------------------------------------------------------------

describe('crop.js source-text: renderSubjectThumb reads pixels from decodeFullJxlFor return (I-1)', () => {
    // Extract the renderSubjectThumb function body from crop.js source.
    function renderSubjectThumbBody() {
        const fnStart = cropSrc.indexOf('async function renderSubjectThumb(');
        if (fnStart < 0) return '';
        // The function is ~60 lines; 3000 chars covers it safely.
        return cropSrc.slice(fnStart, fnStart + 3000);
    }

    test('renderSubjectThumb exists in crop.js', () => {
        expect(cropSrc.indexOf('async function renderSubjectThumb(')).toBeGreaterThan(-1);
    });

    test('renderSubjectThumb calls decodeFullJxlFor and captures its return value', () => {
        const fnBody = renderSubjectThumbBody();
        // Must call window.decodeFullJxlFor (or decodeFullJxlFor) with await.
        expect(fnBody).toContain('decodeFullJxlFor');
        expect(fnBody).toContain('await');
        // The return value must be captured (assigned to a variable), not discarded.
        // Pattern: jd = await window.decodeFullJxlFor OR const jd = await decodeFullJxlFor
        const capturesReturn = /\w+\s*=\s*await\s+(window\.)?decodeFullJxlFor/.test(fnBody);
        expect(capturesReturn).toBe(true);
    });

    test('renderSubjectThumb does NOT use parentCard._jxlDecoded as the primary (assetId-path) pixel source', () => {
        // The bug: const jd = parentCard._jxlDecoded; was undefined for assetId cards.
        // After the fix, pixels come from decodeFullJxlFor's return, with _jxlDecoded
        // only as a legacy fallback for assetId-less cards. There must be no path that
        // reads _jxlDecoded BEFORE (or instead of) calling decodeFullJxlFor.
        const fnBody = renderSubjectThumbBody();
        // decodeFullJxlFor must appear before any read of _jxlDecoded in the function body.
        const dfIdx = fnBody.indexOf('decodeFullJxlFor');
        const legacyIdx = fnBody.indexOf('_jxlDecoded');
        // decodeFullJxlFor must exist in the body.
        expect(dfIdx).toBeGreaterThan(-1);
        // If _jxlDecoded appears at all, it must come AFTER the decodeFullJxlFor call
        // (only as a fallback, not as the primary read path).
        if (legacyIdx >= 0) {
            expect(legacyIdx).toBeGreaterThan(dfIdx);
        }
    });
});

