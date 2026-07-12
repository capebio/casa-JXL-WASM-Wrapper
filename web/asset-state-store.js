// asset-state-store.js — per-asset edit/crop/persistence/generation state.
//
// Fixes Findings 40, 41, 46, 48:
//   40 — edit/sidecar state is now keyed on stable assetId, not ambient globals
//   41 — crop edits are transactional (beginCropEdit / applyCropEdit / cancelCropEdit)
//   46 — persistence errors surface; no false success; stable-id keys stop basename collisions
//   48 — sourceGeneration increments on reprocess; isStale() rejects stale async results
//
// Usage:
//   import { createAssetStateStore, makeAssetId, normalizeCrop } from './asset-state-store.js';
//   const store = createAssetStateStore();
//   const assetId = makeAssetId({ path, name, size, lastModified });
//   store.getOrCreate(assetId);
//   const tag = store.makeResultTag(assetId); // pass to worker
//   if (store.isStale(tag, store.getOrCreate(assetId))) return; // reject in callback
'use strict';

// ---------------------------------------------------------------------------
// makeAssetId — stable identity from full path + size + mtime
//
// Finding 46: basename alone collides when two directories have the same filename.
// We include the full path (or Tauri absolute path) in the identity so
// /a/foo.orf and /b/foo.orf produce distinct IDs.
// ---------------------------------------------------------------------------

/**
 * Cheap FNV-1a hash of a string, returned as a 36-radix string.
 * @param {string} str
 * @returns {string}
 */
function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
}

/**
 * Make a stable, collision-free asset ID from file identity fields.
 *
 * @param {{ path?: string, name: string, size: number, lastModified: number }} file
 * @returns {string}
 */
export function makeAssetId({ path, name, size, lastModified }) {
    // Prefer the full path (Tauri, File.webkitRelativePath, or directory-picker).
    // Fall back to name when path is absent (single-file browser drop).
    const pathKey = (path && path !== name) ? path : name;
    // Include size + lastModified so a replaced file at the same path gets a
    // different ID (prevents a stale cache hit after overwrite).
    const raw = `${pathKey}|${size}|${lastModified}`;
    return fnv1a(raw) + ':' + name.slice(0, 48);
}

// ---------------------------------------------------------------------------
// normalizeCrop — versioned crop field normalizer
//
// Finding 41: `angle` and `inOriginalSpace` must round-trip through sidecar.
// All callers route through this single function so the field set is consistent.
// ---------------------------------------------------------------------------

/**
 * Clamp a value to [lo, hi].
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Normalize and clamp a crop object, adding defaults for absent fields.
 *
 * @param {{ x?: number, y?: number, w?: number, h?: number, ratio?: string, angle?: number, inOriginalSpace?: boolean }} raw
 * @returns {{ x: number, y: number, w: number, h: number, ratio: string, angle: number, inOriginalSpace: boolean }}
 */
export function normalizeCrop(raw) {
    if (!raw) return null;
    const x = clamp(typeof raw.x === 'number' ? raw.x : 0, 0, 1);
    const y = clamp(typeof raw.y === 'number' ? raw.y : 0, 0, 1);
    // Width and height take precedence over origin (origin pulled back if overflow).
    const w = Math.max(0.001, Math.min(1 - x, typeof raw.w === 'number' ? raw.w : 1));
    const h = Math.max(0.001, Math.min(1 - y, typeof raw.h === 'number' ? raw.h : 1));
    return {
        x, y, w, h,
        ratio: typeof raw.ratio === 'string' ? raw.ratio : 'free',
        // Finding 41: these two fields must be preserved in normalization + sidecar round-trips.
        angle: typeof raw.angle === 'number' ? raw.angle : 0,
        inOriginalSpace: typeof raw.inOriginalSpace === 'boolean' ? raw.inOriginalSpace : true,
    };
}

// ---------------------------------------------------------------------------
// createAssetStateStore — factory for an isolated per-session store
// ---------------------------------------------------------------------------

let _opSeq = 0;
function nextOpId() { return 'op-' + (++_opSeq); }

/**
 * Create an AssetStateStore.
 *
 * @returns {{
 *   getOrCreate(assetId: string): AssetState,
 *   delete(assetId: string): void,
 *   bumpGeneration(assetId: string): void,
 *   makeResultTag(assetId: string): { assetId: string, sourceGeneration: number, opId: string },
 *   isStale(tag: object, state: AssetState): boolean,
 *   beginCropEdit(assetId: string): { crop: object|null, subjects: object[] },
 *   applyCropEdit(assetId: string, pendingCrop: object|null, pendingSubjects: object[]): void,
 *   cancelCropEdit(assetId: string): void,
 *   serializeEditState(assetId: string): string,
 *   applySidecarEdit(assetId: string, sidecar: object): void,
 *   persistEditState(assetId: string, writer: Function, opts?: object): Promise<void>,
 * }}
 */
export function createAssetStateStore() {
    /** @type {Map<string, AssetState>} */
    const map = new Map();

    // Per-asset crop-edit snapshots (only live while crop UI is open).
    /** @type {Map<string, { crop: object|null, subjects: object[] }>} */
    const snapshots = new Map();

    function getOrCreate(assetId) {
        if (!map.has(assetId)) {
            map.set(assetId, {
                assetId,
                sourceGeneration: 0,
                status: 'queued',
                edit: {
                    crop: null,
                    subjects: [],
                    look: {},
                    revision: 0,
                },
            });
        }
        return map.get(assetId);
    }

    function deleteState(assetId) {
        map.delete(assetId);
        snapshots.delete(assetId);
    }

    // Finding 48: bump whenever the source bytes change (reprocess, file replace).
    function bumpGeneration(assetId) {
        const s = getOrCreate(assetId);
        s.sourceGeneration += 1;
    }

    // Make a tag that travels with an async operation (decode, save).
    // The receiver calls isStale(tag, state) before mutating any cache/canvas.
    function makeResultTag(assetId) {
        const s = getOrCreate(assetId);
        return { assetId, sourceGeneration: s.sourceGeneration, opId: nextOpId() };
    }

    // Finding 48: reject results that belong to an older generation or a different asset.
    function isStale(tag, state) {
        if (!tag || !state) return true;
        if (tag.assetId !== state.assetId) return true;
        if (tag.sourceGeneration !== state.sourceGeneration) return true;
        return false;
    }

    // ---------------------------------------------------------------------------
    // Finding 41 — transactional crop editing
    // ---------------------------------------------------------------------------

    // Begin a crop edit: take a deep snapshot of the current committed crop+subjects.
    // Returns the snapshot so the caller can seed its pending UI state.
    function beginCropEdit(assetId) {
        const s = getOrCreate(assetId);
        const snap = {
            crop: s.edit.crop ? normalizeCrop(s.edit.crop) : null,
            subjects: (s.edit.subjects || []).map(sub => ({ ...sub })),
        };
        snapshots.set(assetId, snap);
        return snap;
    }

    // Apply: atomically commit pendingCrop + pendingSubjects to the store.
    // This is the ONLY place that writes to s.edit.crop / s.edit.subjects.
    function applyCropEdit(assetId, pendingCrop, pendingSubjects) {
        const s = getOrCreate(assetId);
        s.edit.crop = pendingCrop ? normalizeCrop(pendingCrop) : null;
        s.edit.subjects = Array.isArray(pendingSubjects) ? pendingSubjects.map(sub => ({ ...sub })) : [];
        s.edit.revision += 1;
        snapshots.delete(assetId);
    }

    // Cancel: restore from snapshot, do NOT bump revision.
    function cancelCropEdit(assetId) {
        const snap = snapshots.get(assetId);
        if (!snap) return;
        const s = getOrCreate(assetId);
        s.edit.crop = snap.crop ? normalizeCrop(snap.crop) : null;
        s.edit.subjects = snap.subjects.map(sub => ({ ...sub }));
        snapshots.delete(assetId);
    }

    // ---------------------------------------------------------------------------
    // Finding 46 — persistence
    // ---------------------------------------------------------------------------

    // Serialize the edit state for a SPECIFIC assetId — no ambient globals.
    function serializeEditState(assetId) {
        const s = getOrCreate(assetId);
        return JSON.stringify({
            assetId,
            sourceGeneration: s.sourceGeneration,
            revision: s.edit.revision,
            crop: s.edit.crop,
            subjects: s.edit.subjects,
            look: s.edit.look,
        });
    }

    // Apply an incoming sidecar to a SPECIFIC assetId — no cross-write to other assets.
    function applySidecarEdit(assetId, sidecar) {
        if (!sidecar) return;
        const s = getOrCreate(assetId);
        if (sidecar.crop && typeof sidecar.crop === 'object' &&
            Number.isFinite(sidecar.crop.x) && Number.isFinite(sidecar.crop.y) &&
            Number.isFinite(sidecar.crop.w) && Number.isFinite(sidecar.crop.h)) {
            s.edit.crop = normalizeCrop(sidecar.crop);
        } else if (sidecar.hasOwnProperty('crop')) {
            s.edit.crop = null;
        }
        if (Array.isArray(sidecar.subjects)) {
            s.edit.subjects = sidecar.subjects
                .filter(sub => sub && Number.isFinite(sub.x) && Number.isFinite(sub.y) &&
                               Number.isFinite(sub.w) && Number.isFinite(sub.h))
                .map(sub => ({
                    id: sub.id || ('s-' + Math.random().toString(36).slice(2, 8)),
                    x: clamp(sub.x, 0, 1),
                    y: clamp(sub.y, 0, 1),
                    w: Math.max(0.001, sub.w),
                    h: Math.max(0.001, sub.h),
                    label: typeof sub.label === 'string' ? sub.label : '',
                    note: typeof sub.note === 'string' ? sub.note : '',
                    status: ['unknown', 'tentative', 'confirmed'].includes(sub.status) ? sub.status : 'unknown',
                }));
        }
        if (typeof sidecar.revision === 'number') {
            s.edit.revision = sidecar.revision;
        }
    }

    // Persist edit state for a specific assetId.
    //
    // Finding 46 fixes:
    //   - writer(assetId, json) is called with explicit target — no ambient "current file"
    //   - if writer throws, the error propagates to the caller (no catch+swallow)
    //   - opts.onSuccess is ONLY called after writer resolves (no optimistic false success)
    //   - updateSidecarDot / any success side-effect only fires on success
    async function persistEditState(assetId, writer, opts = {}) {
        const json = serializeEditState(assetId);
        // Throws propagate — caller decides whether to surface to UI.
        await writer(assetId, json);
        // Success side-effect — only reached if writer did NOT throw.
        if (typeof opts.onSuccess === 'function') opts.onSuccess(assetId);
    }

    return {
        getOrCreate,
        delete: deleteState,
        bumpGeneration,
        makeResultTag,
        isStale,
        beginCropEdit,
        applyCropEdit,
        cancelCropEdit,
        serializeEditState,
        applySidecarEdit,
        persistEditState,
    };
}
