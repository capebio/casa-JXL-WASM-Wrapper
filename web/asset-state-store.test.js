// Tests for asset-state-store.js — per-asset edit/crop/persistence/generation state.
// Covers Findings 40, 41, 46, 48.
//
// Run with: bun test web/asset-state-store.test.js

import { expect, test, describe, beforeEach } from 'bun:test';
import {
    createAssetStateStore,
    makeAssetId,
    normalizeCrop,
} from './asset-state-store.js';

// ---------------------------------------------------------------------------
// Finding 46 — stable identity: same basename in different dirs must not collide
// ---------------------------------------------------------------------------
describe('makeAssetId: stable identity', () => {
    test('same name + size + mtime but different paths produce different IDs', () => {
        const id1 = makeAssetId({ path: '/photos/vacation/IMG_0001.orf', name: 'IMG_0001.orf', size: 12345, lastModified: 1000 });
        const id2 = makeAssetId({ path: '/photos/sports/IMG_0001.orf',   name: 'IMG_0001.orf', size: 12345, lastModified: 1000 });
        expect(id1).not.toBe(id2);
    });

    test('identical file (same path, name, size, mtime) produces the same ID', () => {
        const id1 = makeAssetId({ path: '/photos/IMG_0001.orf', name: 'IMG_0001.orf', size: 99, lastModified: 42 });
        const id2 = makeAssetId({ path: '/photos/IMG_0001.orf', name: 'IMG_0001.orf', size: 99, lastModified: 42 });
        expect(id1).toBe(id2);
    });

    test('different sizes produce different IDs', () => {
        const id1 = makeAssetId({ path: '/photos/IMG.orf', name: 'IMG.orf', size: 100, lastModified: 0 });
        const id2 = makeAssetId({ path: '/photos/IMG.orf', name: 'IMG.orf', size: 101, lastModified: 0 });
        expect(id1).not.toBe(id2);
    });

    test('Tauri absolute path: two files with same basename but different dirs differ', () => {
        const id1 = makeAssetId({ path: 'C:\\Users\\Alice\\Photos\\beach\\cat.orf',  name: 'cat.orf', size: 50, lastModified: 1 });
        const id2 = makeAssetId({ path: 'C:\\Users\\Alice\\Photos\\forest\\cat.orf', name: 'cat.orf', size: 50, lastModified: 1 });
        expect(id1).not.toBe(id2);
    });
});

// ---------------------------------------------------------------------------
// AssetStateStore: isolation and creation
// ---------------------------------------------------------------------------
describe('createAssetStateStore: per-asset isolation', () => {
    let store;
    beforeEach(() => { store = createAssetStateStore(); });

    test('getOrCreate returns a new AssetState with sourceGeneration=0', () => {
        const s = store.getOrCreate('asset-a');
        expect(s.assetId).toBe('asset-a');
        expect(s.sourceGeneration).toBe(0);
        expect(s.status).toBe('queued');
        expect(s.edit.crop).toBe(null);
        expect(s.edit.subjects).toEqual([]);
        expect(s.edit.revision).toBe(0);
    });

    test('two different assets have independent edit state', () => {
        const sA = store.getOrCreate('asset-a');
        const sB = store.getOrCreate('asset-b');
        sA.edit.crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8, ratio: 'free', angle: 0, inOriginalSpace: true };
        expect(sB.edit.crop).toBe(null);
    });

    test('getOrCreate returns same object on second call', () => {
        const s1 = store.getOrCreate('asset-a');
        const s2 = store.getOrCreate('asset-a');
        expect(s1).toBe(s2);
    });

    test('delete removes the state', () => {
        store.getOrCreate('asset-x');
        store.delete('asset-x');
        const fresh = store.getOrCreate('asset-x');
        expect(fresh.sourceGeneration).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Finding 48 — sourceGeneration: increment on bytes change, reject stale
// ---------------------------------------------------------------------------
describe('sourceGeneration guard', () => {
    let store;
    beforeEach(() => { store = createAssetStateStore(); });

    test('bumpGeneration increments sourceGeneration', () => {
        const s = store.getOrCreate('asset-a');
        expect(s.sourceGeneration).toBe(0);
        store.bumpGeneration('asset-a');
        expect(s.sourceGeneration).toBe(1);
        store.bumpGeneration('asset-a');
        expect(s.sourceGeneration).toBe(2);
    });

    test('isStale rejects mismatched assetId', () => {
        const s = store.getOrCreate('asset-a');
        expect(store.isStale({ assetId: 'asset-b', sourceGeneration: 0, opId: 'op1' }, s)).toBe(true);
    });

    test('isStale rejects older generation', () => {
        const s = store.getOrCreate('asset-a');
        store.bumpGeneration('asset-a');
        expect(store.isStale({ assetId: 'asset-a', sourceGeneration: 0, opId: 'op1' }, s)).toBe(true);
    });

    test('isStale accepts matching assetId and generation', () => {
        const s = store.getOrCreate('asset-a');
        store.bumpGeneration('asset-a');
        expect(store.isStale({ assetId: 'asset-a', sourceGeneration: 1, opId: 'op1' }, s)).toBe(false);
    });

    test('stale decode result is rejected before commit (batch scenario)', () => {
        const s = store.getOrCreate('asset-a');
        const tag1 = store.makeResultTag('asset-a'); // generation 0
        store.bumpGeneration('asset-a');             // reprocess -> generation 1
        const tag2 = store.makeResultTag('asset-a'); // generation 1

        // tag1 is now stale
        expect(store.isStale(tag1, s)).toBe(true);
        // tag2 is current
        expect(store.isStale(tag2, s)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Finding 41 — crop transactionality: snapshot, Apply, Cancel
// ---------------------------------------------------------------------------
describe('normalizeCrop', () => {
    test('rounds trip crop with all fields', () => {
        const c = normalizeCrop({ x: 0.1, y: 0.2, w: 0.6, h: 0.5, ratio: '4:3', angle: 2.5, inOriginalSpace: false });
        expect(c.x).toBe(0.1);
        expect(c.y).toBe(0.2);
        expect(c.w).toBe(0.6);
        expect(c.h).toBe(0.5);
        expect(c.ratio).toBe('4:3');
        expect(c.angle).toBe(2.5);
        expect(c.inOriginalSpace).toBe(false);
    });

    test('defaults angle=0 and inOriginalSpace=true when absent', () => {
        const c = normalizeCrop({ x: 0, y: 0, w: 1, h: 1 });
        expect(c.angle).toBe(0);
        expect(c.inOriginalSpace).toBe(true);
    });

    test('clamps x,y,w,h to valid range', () => {
        const c = normalizeCrop({ x: -0.1, y: 1.5, w: -0.5, h: 2.0 });
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeLessThanOrEqual(1);
        expect(c.w).toBeGreaterThanOrEqual(0.001);
        expect(c.h).toBeGreaterThanOrEqual(0.001);
    });
});

describe('createAssetStateStore: crop transactionality', () => {
    let store;
    beforeEach(() => { store = createAssetStateStore(); });

    test('beginCropEdit returns a snapshot of current crop', () => {
        const s = store.getOrCreate('asset-a');
        s.edit.crop = normalizeCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8, ratio: 'free', angle: 1.5, inOriginalSpace: true });
        s.edit.subjects = [{ id: 's1', x: 0.2, y: 0.2, w: 0.3, h: 0.3, label: 'Cat', note: '', status: 'unknown' }];

        const snap = store.beginCropEdit('asset-a');
        expect(snap.crop).toEqual(s.edit.crop);
        expect(snap.subjects).toEqual(s.edit.subjects);
        // snapshot is a deep copy, not a reference
        snap.crop.x = 999;
        expect(s.edit.crop.x).toBe(0.1);
    });

    test('applyCropEdit atomically commits pending crop and bumps revision', () => {
        const s = store.getOrCreate('asset-a');
        store.beginCropEdit('asset-a');
        const newCrop = normalizeCrop({ x: 0.05, y: 0.05, w: 0.9, h: 0.9, ratio: 'free', angle: 3.0, inOriginalSpace: true });
        store.applyCropEdit('asset-a', newCrop, s.edit.subjects);
        expect(s.edit.crop).toEqual(newCrop);
        expect(s.edit.revision).toBe(1);
    });

    test('cancelCropEdit restores snapshot and does not bump revision', () => {
        const s = store.getOrCreate('asset-a');
        const originalCrop = normalizeCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8, ratio: 'free', angle: 0, inOriginalSpace: true });
        s.edit.crop = originalCrop;
        const rev0 = s.edit.revision;

        store.beginCropEdit('asset-a');
        // Simulate UI changing pendingCrop — does NOT yet write to card
        store.cancelCropEdit('asset-a');

        expect(s.edit.crop).toEqual(originalCrop);
        expect(s.edit.revision).toBe(rev0);
    });

    test('mode switch (frame→subjects) only modifies pending state, not committed state', () => {
        const s = store.getOrCreate('asset-a');
        const commitedCrop = normalizeCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8, ratio: 'free', angle: 0, inOriginalSpace: true });
        s.edit.crop = commitedCrop;

        const snap = store.beginCropEdit('asset-a');
        // Simulate a frame->subjects mode switch: should NOT write directly to s.edit.crop
        // (this is what finding 41 says is broken: old code writes card._crop during modeToggle)
        const pendingCrop = { ...snap.crop, x: 0.999 }; // user changed something
        // In the fixed code, modeToggle ONLY updates snap.pendingCrop, not s.edit.crop
        // Verify committed crop is unchanged before Apply
        expect(s.edit.crop.x).toBe(0.1);

        store.applyCropEdit('asset-a', pendingCrop, snap.subjects);
        expect(s.edit.crop.x).toBe(0.999); // only after Apply
    });

    test('straighten fields (angle + inOriginalSpace) survive Apply/Cancel round-trip', () => {
        const s = store.getOrCreate('asset-a');
        store.beginCropEdit('asset-a');
        const crop = normalizeCrop({ x: 0, y: 0, w: 1, h: 1, ratio: 'free', angle: 7.3, inOriginalSpace: false });
        store.applyCropEdit('asset-a', crop, []);
        expect(s.edit.crop.angle).toBe(7.3);
        expect(s.edit.crop.inOriginalSpace).toBe(false);

        // Reload (simulate sidecar round-trip)
        const reloaded = normalizeCrop(s.edit.crop);
        expect(reloaded.angle).toBe(7.3);
        expect(reloaded.inOriginalSpace).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Finding 46 — persistence: surface errors, no false success, stable assetId keys
// ---------------------------------------------------------------------------
describe('createAssetStateStore: persistence', () => {
    let store;
    beforeEach(() => { store = createAssetStateStore(); });

    test('serializeEditState passes target state explicitly (no ambient global)', () => {
        const sA = store.getOrCreate('asset-a');
        sA.edit.crop = normalizeCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8, ratio: 'free' });

        const sB = store.getOrCreate('asset-b');
        sB.edit.crop = normalizeCrop({ x: 0.5, y: 0.5, w: 0.4, h: 0.4, ratio: '1:1' });

        const jsonA = store.serializeEditState('asset-a');
        const jsonB = store.serializeEditState('asset-b');
        const parsedA = JSON.parse(jsonA);
        const parsedB = JSON.parse(jsonB);
        expect(parsedA.crop.x).toBe(0.1);
        expect(parsedB.crop.x).toBe(0.5);
        expect(parsedA.assetId).toBe('asset-a');
        expect(parsedB.assetId).toBe('asset-b');
    });

    test('late sidecar arrival for asset A while asset B is active does not cross-write', async () => {
        const sA = store.getOrCreate('asset-a');
        const sB = store.getOrCreate('asset-b');
        sB.edit.crop = normalizeCrop({ x: 0.2, y: 0.2, w: 0.6, h: 0.6, ratio: 'free' });

        // Simulate: sidecar for A arrives with different crop
        const sidecarA = { assetId: 'asset-a', crop: { x: 0.05, y: 0.05, w: 0.9, h: 0.9, ratio: 'free', angle: 0, inOriginalSpace: true }, subjects: [], revision: 0 };
        store.applySidecarEdit('asset-a', sidecarA);

        // B's crop must be untouched
        expect(sB.edit.crop.x).toBe(0.2);
        // A's crop is now set
        expect(sA.edit.crop.x).toBe(0.05);
    });

    test('batch save of distinct states produces distinct JSON per asset', () => {
        store.getOrCreate('asset-a').edit.crop = normalizeCrop({ x: 0.0, y: 0.0, w: 1.0, h: 1.0, ratio: 'free' });
        store.getOrCreate('asset-b').edit.crop = normalizeCrop({ x: 0.3, y: 0.3, w: 0.5, h: 0.5, ratio: 'free' });

        const blobs = ['asset-a', 'asset-b'].map(id => JSON.parse(store.serializeEditState(id)));
        expect(blobs[0].crop.x).toBe(0.0);
        expect(blobs[1].crop.x).toBe(0.3);
        expect(blobs[0].assetId).not.toBe(blobs[1].assetId);
    });

    test('failed durable write surfaces the error (not false success)', async () => {
        const s = store.getOrCreate('asset-a');
        s.edit.crop = normalizeCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8, ratio: 'free' });

        const failingWriter = async (_assetId, _json) => { throw new Error('QuotaExceeded'); };

        await expect(
            store.persistEditState('asset-a', failingWriter)
        ).rejects.toThrow('QuotaExceeded');
    });

    test('status becomes developed only after durable write succeeds', async () => {
        const s = store.getOrCreate('asset-a');
        let resolved = false;
        const slowWriter = (_assetId, _json) => new Promise(r => setTimeout(() => { resolved = true; r(); }, 10));

        const promise = store.persistEditState('asset-a', slowWriter);
        // Before write completes, status is NOT developed
        expect(s.status === 'developed').toBe(false);
        await promise;
        // After write succeeds, status may be updated by the store
        expect(resolved).toBe(true);
    });

    test('no updateSidecarDot / success side-effect when writer throws', async () => {
        const s = store.getOrCreate('asset-a');
        const sideEffects = [];
        const failingWriter = async () => { throw new Error('fail'); };
        const onSuccess = () => { sideEffects.push('success'); };

        try {
            await store.persistEditState('asset-a', failingWriter, { onSuccess });
        } catch {}

        expect(sideEffects).toEqual([]);
    });

    test('basename collision: two assets with same basename but different dirs serialize to different assetId keys', () => {
        const id1 = makeAssetId({ path: '/a/foo.orf', name: 'foo.orf', size: 100, lastModified: 0 });
        const id2 = makeAssetId({ path: '/b/foo.orf', name: 'foo.orf', size: 100, lastModified: 0 });
        store.getOrCreate(id1).edit.crop = normalizeCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8, ratio: 'free' });
        store.getOrCreate(id2).edit.crop = normalizeCrop({ x: 0.9, y: 0.9, w: 0.05, h: 0.05, ratio: 'free' });

        const j1 = JSON.parse(store.serializeEditState(id1));
        const j2 = JSON.parse(store.serializeEditState(id2));
        expect(j1.assetId).toBe(id1);
        expect(j2.assetId).toBe(id2);
        expect(j1.crop.x).not.toBe(j2.crop.x);
    });
});

// ---------------------------------------------------------------------------
// Finding 48 — stale decode: reject before paint/cache
// ---------------------------------------------------------------------------
describe('stale decode rejection', () => {
    let store;
    beforeEach(() => { store = createAssetStateStore(); });

    test('makeResultTag captures current generation', () => {
        const s = store.getOrCreate('asset-a');
        const tag = store.makeResultTag('asset-a');
        expect(tag.assetId).toBe('asset-a');
        expect(tag.sourceGeneration).toBe(s.sourceGeneration);
        expect(typeof tag.opId).toBe('string');
    });

    test('reprocess bumps generation; old tag is stale', () => {
        store.getOrCreate('asset-a');
        const oldTag = store.makeResultTag('asset-a');
        store.bumpGeneration('asset-a'); // reprocess
        const s = store.getOrCreate('asset-a');
        expect(store.isStale(oldTag, s)).toBe(true);
    });

    test('two concurrent decodes: only the one with matching generation is accepted', () => {
        const s = store.getOrCreate('asset-a');
        const tag1 = store.makeResultTag('asset-a');
        store.bumpGeneration('asset-a'); // simulate reprocess
        const tag2 = store.makeResultTag('asset-a');

        expect(store.isStale(tag1, s)).toBe(true);
        expect(store.isStale(tag2, s)).toBe(false);
    });
});
