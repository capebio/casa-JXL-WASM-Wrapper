// Main thread.  Builds a Worker pool, dispatches each ORF to a free worker,
// streams events back (thumb → lightbox-preview → JXL bytes), and renders
// thumbnails + a clickable lightbox grid.
//
// Worker code lives in ./worker.js — one wasm instance + jSquash JXL
// encoder per worker, single-threaded inside.  Pool size scales with
// `navigator.hardwareConcurrency` so a batch saturates all cores.

import { getContext } from './jxl-browser-context.js';
import { WorkerMsg } from './worker-message-types.js';
import { createTauriParityLightbox } from './tauri-parity-lightbox.js';
// S3: the memory-governed asset store. peepCache's decoded-RGBA LRU is a client
// of it (one governed budget + one eviction policy), replacing the bespoke Map.
import { AssetStore } from '../packages/asset-store/src/index.js';
// Capability-detection namespace import over the RAW WASM pkg. Binding the
// module does NOT instantiate WASM (init is lazy via default()/initSync), so
// this is safe at page load. We only read which functions the build exported —
// the H29 develop-channel fns (apply_look_stream / jxl_progressive_pass) are
// absent until the Rust H29 work is built, so the channel path stays gated.
import * as rawWasm from './pkg/raw_converter_wasm.js';
import {
    applyLens, estimateSceneWhiteLms,
    normalizedLabBuffer, selectByColour, unionMask, maskBorder, maskCoverage,
    probe as probeColour,
} from './perceptual-color.mjs';

const IS_TAURI = typeof window !== 'undefined' && !!window.__TAURI__;
window.IS_TAURI = IS_TAURI;
const { invoke } = IS_TAURI ? window.__TAURI__.core : {};
const { listen } = IS_TAURI ? window.__TAURI__.event : {};

const POOL_SIZE = Math.min(navigator.hardwareConcurrency || 4, 12);

// Assessment switch (default OFF = blob/O1 behaviour unchanged). Add
// `?alphaProgressive=1` to the page URL to let alpha/extra-channel VarDCT
// images emit intermediate progressive paints, so the win (or lack of it) can
// be measured on real images. Requires the fork (0.12) decode WASM; the stock
// 0.11.2 module ignores it. See web/jxl-decode-worker.js plumbing.
const ALPHA_PROGRESSIVE = (() => {
    try {
        return new URLSearchParams(globalThis.location?.search ?? '')
            .get('alphaProgressive') === '1';
    } catch (_) { return false; }
})();

// Build tag the page reports — lets you tell at a glance whether the
// browser is on the latest version after a refresh.
const BUILD_TAG = '2026-05-13j / live-lightbox + toggle fixes';

// Visible build badge — top-left corner, always present.
{
    const badge = document.createElement('div');
    badge.id = 'build-badge';
    badge.textContent = BUILD_TAG;
    document.body.appendChild(badge);
}

// Info + effort popovers
{
    const allPopovers = () => [
        document.getElementById('info-popover'),
        document.getElementById('effort-popover'),
    ];
    function closeAllPopovers() { allPopovers().forEach(p => { if (p) p.hidden = true; }); }
    function togglePopover(id, e) {
        e.stopPropagation();
        const target = document.getElementById(id);
        const wasHidden = target.hidden;
        closeAllPopovers();
        target.hidden = !wasHidden;
    }

    const infoPop = document.getElementById('info-popover');
    document.getElementById('info-build-tag').textContent = BUILD_TAG;
    document.getElementById('info-pool-size').textContent = POOL_SIZE;
    document.getElementById('info-hw-cores').textContent = navigator.hardwareConcurrency || '?';
    document.getElementById('info-btn').addEventListener('click', (e) => togglePopover('info-popover', e));
    infoPop.addEventListener('click', (e) => e.stopPropagation());

    document.getElementById('effort-info-btn').addEventListener('click', (e) => togglePopover('effort-popover', e));
    document.getElementById('effort-popover').addEventListener('click', (e) => e.stopPropagation());

    document.addEventListener('click', closeAllPopovers);
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const grid = document.getElementById('grid');
const drop = document.getElementById('drop');
const pick = document.getElementById('pick');
const fileInput = document.getElementById('file-input');
const statusBar = document.getElementById('status');
const progressEl = document.getElementById('progress');
const statusText = document.getElementById('status-text');

const lightbox = document.getElementById('lightbox');
const lightboxCanvas = document.getElementById('lightbox-canvas');
const plOverlayCanvas = document.getElementById('pl-overlay');
const lightboxInfo = lightbox.querySelector('.lightbox-info');
const lightboxClose = lightbox.querySelector('.lightbox-close');
const lightboxPrev = lightbox.querySelector('.lightbox-prev');
const lightboxNext = lightbox.querySelector('.lightbox-next');
const lbViewport = lightbox.querySelector('.lightbox-viewport');
const lbZoomLabel = lightbox.querySelector('.lb-zoom-label');
const lbZoomIn = lightbox.querySelector('.lb-zoom-in');
const lbZoomOut = lightbox.querySelector('.lb-zoom-out');
const lbZoomReset = lightbox.querySelector('.lb-zoom-reset');
const lbDownloadBtn = lightbox.querySelector('.lb-download-btn');
const lbPreviewBadge = lightbox.querySelector('.lb-preview-badge');
const lbLoadingBadge = lightbox.querySelector('.lb-loading-badge');
const lbToggleJpegBtn = lightbox.querySelector('.lb-toggle-jpeg');
const lbSourceBanner  = lightbox.querySelector('#lb-source-banner');
const lbSourceLabelEl = document.getElementById('lb-source-label');

const lbStraighten = document.getElementById('lb-straighten');
const lbStraightenVal = document.getElementById('lb-straighten-val');
const lbStraightenAuto = document.getElementById('lb-straighten-auto');

let filmstripEl = null;
let filmstripScroll = null;
let filmstripActions = null;
let filmstripSelection = new Set();
let filmstripLastClicked = -1;
initFilmstrip();

const qualityRange = document.getElementById('quality-range');
const qualityLabel = document.getElementById('quality-label');
const effortSelect = document.getElementById('effort-select');
const losslessToggle = document.getElementById('lossless-toggle');

const reprocessBtn = document.getElementById('reprocess-btn');
const applyLookBtn = document.getElementById('apply-look');
const resetLookBtn = document.getElementById('reset-look');
const contrastBoostEl = document.getElementById('contrast-boost');
const presetBtns = [...document.querySelectorAll('[data-preset]')];

// LR-style controls are declared as <input data-look="<name>"> in the
// markup; we discover them at runtime so the JS doesn't need to know every
// slider by id.  Each control reports a [-100, 100] integer except
// exposureEv which is [-3, +3] EV.  Internally the pipeline takes ±1
// normalised values, so we divide the integer by 100 before forwarding.
const lookInputs = [...document.querySelectorAll('[data-look]')];
const lookLabels = new Map(
    [...document.querySelectorAll('[data-label]')].map((el) => [el.dataset.label, el]),
);

function lookValueFor(name) {
    const el = lookInputs.find((i) => i.dataset.look === name);
    if (!el) return 0;
    const raw = Number(el.value);
    if (name === 'exposureEv') return raw;          // already in stops
    return raw / 100;                                // -100..+100 → -1..+1
}

function lookDisplay(name) {
    const el = lookInputs.find((i) => i.dataset.look === name);
    if (!el) return '0';
    const v = Number(el.value);
    if (name === 'exposureEv') return v.toFixed(2);
    return String(v | 0);
}

function refreshLookLabels() {
    for (const [name, el] of lookLabels) el.textContent = lookDisplay(name);
}

function looksTouched() {
    return lookInputs.some((el) => Number(el.value) !== 0);
}

// Control visibility on adjust
{
    const controlsEl = document.querySelector('.controls');
    const headerEl = document.querySelector('body > header');
    const lookColumns = [...document.querySelectorAll('.look-column')];
    let adjustTimer = null;

    function getColumnForInput(input) {
        for (const col of lookColumns) {
            if (col.contains(input)) return col;
        }
        return null;
    }

    function startAdjusting(input) {
        const col = getColumnForInput(input);
        if (!col) return;

        clearTimeout(adjustTimer);
        controlsEl.classList.add('adjusting');
        headerEl.classList.add('adjusting-control');
        lookColumns.forEach(c => c.classList.remove('active'));
        col.classList.add('active');

        // Hide all labels in column, show only the one for this input
        const allLabels = col.querySelectorAll('.lr');
        allLabels.forEach(label => {
            if (label.contains(input)) {
                label.classList.add('active-control');
            } else {
                label.classList.remove('active-control');
            }
        });
    }

    function stopAdjusting() {
        clearTimeout(adjustTimer);
        adjustTimer = setTimeout(() => {
            controlsEl.classList.remove('adjusting');
            headerEl.classList.remove('adjusting-control');
            lookColumns.forEach(c => c.classList.remove('active'));
            lookInputs.forEach(input => {
                const label = input.closest('.lr');
                if (label) label.classList.remove('active-control');
            });
        }, 200);
    }

    for (const input of lookInputs) {
        input.addEventListener('pointerdown', () => startAdjusting(input));
        input.addEventListener('touchstart', () => startAdjusting(input));
    }

    document.addEventListener('pointerup', stopAdjusting);
    document.addEventListener('touchend', stopAdjusting);
}

const statsLog = document.getElementById('stats-log');
const copyStatsBtn = document.getElementById('copy-stats');
const clearStatsBtn = document.getElementById('clear-stats');

// Seed the stats log with build / env info so the paste-back is self-describing.
const statsLines = [];
const statsKeyIdx = new Map();   // key → index into statsLines for mutable rows
let _statsLogPending = false;
function _flushStatsLog() {
    _statsLogPending = false;
    statsLog.textContent = statsLines.join('\n');
    statsLog.scrollTop = statsLog.scrollHeight;
}
function _scheduleStatsFlush() {
    if (_statsLogPending) return;
    _statsLogPending = true;
    requestAnimationFrame(_flushStatsLog);
}
function pushStat(line) {
    statsLines.push(line);
    _scheduleStatsFlush();
}
// Mutable row that overwrites in place when the same key is pushed again.
// Used to collapse "N files share this signature" rollups (jpeg sizes,
// wb/matrix groups, etc) into one line that updates as the batch progresses.
function updateStat(key, line) {
    let idx = statsKeyIdx.get(key);
    if (idx === undefined) {
        idx = statsLines.length;
        statsKeyIdx.set(key, idx);
        statsLines.push(line);
    } else {
        statsLines[idx] = line;
    }
    _scheduleStatsFlush();
}
function resetStatKeys() { statsKeyIdx.clear(); }
pushStat(`build:        ${BUILD_TAG}`);
pushStat(`pool size:    ${POOL_SIZE}`);
pushStat(`hw cores:     ${navigator.hardwareConcurrency || '?'}`);
pushStat(`UA:           ${navigator.userAgent}`);
pushStat('');

function copyTextToClipboard(text) {
    // Tauri WebView2 lacks the clipboard permission so the async
    // navigator.clipboard.writeText() promise can hang waiting for a grant
    // that never arrives.  Use the synchronous textarea/execCommand fallback
    // first, which works without permissions; fall back to the async API on
    // the off chance execCommand is disabled.
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) return Promise.resolve();
    } catch (_) { /* fall through */ }
    return (navigator.clipboard && navigator.clipboard.writeText)
        ? navigator.clipboard.writeText(text)
        : Promise.reject(new Error('no clipboard API'));
}

copyStatsBtn.addEventListener('click', () => {
    copyTextToClipboard(statsLines.join('\n')).then(() => {
        copyStatsBtn.textContent = 'copied';
        setTimeout(() => (copyStatsBtn.textContent = 'Copy'), 1200);
    }).catch(() => {
        copyStatsBtn.textContent = 'copy failed';
        setTimeout(() => (copyStatsBtn.textContent = 'Copy'), 1500);
    });
});
clearStatsBtn.addEventListener('click', () => {
    statsLines.length = 0;
    _flushStatsLog(); // immediate — user expects instant clear
    resetStatKeys();
    jpegSignatureCounts.clear();
    wbMatrixCounts.clear();
    pushStat(`build:        ${BUILD_TAG}`);
    pushStat(`pool size:    ${POOL_SIZE}`);
    pushStat(`hw cores:     ${navigator.hardwareConcurrency || '?'}`);
    pushStat(`UA:           ${navigator.userAgent}`);
    pushStat('');
});
// Rolling counters for collapsed stat rows.
const jpegSignatureCounts = new Map();  // "WxH oriN + WxH oriN" → count
const wbMatrixCounts      = new Map();  // "wb R… B… | matrix" → count
function bumpJpegSignature(sig) {
    const n = (jpegSignatureCounts.get(sig) || 0) + 1;
    jpegSignatureCounts.set(sig, n);
    updateStat(`jpeg:${sig}`, `[jpeg] ${String(n).padStart(3,' ')} files  ${sig}`);
}
function bumpWbMatrix(wbStr, matrixStr) {
    const sig = `${wbStr} | ${matrixStr || '—'}`;
    const n = (wbMatrixCounts.get(sig) || 0) + 1;
    wbMatrixCounts.set(sig, n);
    updateStat(`wb:${sig}`, `[wb ] ${String(n).padStart(3,' ')} files  ${sig}`);
}

function fmtMs(v) { return (v ?? 0).toFixed(0).padStart(5, ' ') + ' ms'; }
function fmtKb(v) { return (v / 1024).toFixed(0).padStart(5, ' ') + ' KB'; }

let statSeq = 0;

// ---------------------------------------------------------------------------
// Look slider helpers
// ---------------------------------------------------------------------------
function resetLookSliders() {
    for (const el of lookInputs) el.value = '0';
    contrastBoostEl.checked = false;
    refreshLookLabels();
}

// ---------------------------------------------------------------------------
// Encoder option state
// ---------------------------------------------------------------------------
function currentLook() {
    return {
        exposureEv: lookValueFor('exposureEv'),
        contrast:   Math.max(-1, Math.min(1, lookValueFor('contrast') + (contrastBoostEl.checked ? 0.15 : 0.0))),
        highlights: lookValueFor('highlights'),
        shadows:    lookValueFor('shadows'),
        whites:     lookValueFor('whites'),
        blacks:     lookValueFor('blacks'),
        saturation: lookValueFor('saturation'),
        vibrance:   lookValueFor('vibrance'),
        temp:       lookValueFor('temp'),
        tint:       lookValueFor('tint'),
        texture:    lookValueFor('texture'),
        clarity:    lookValueFor('clarity'),
    };
}
window.currentLook = currentLook;
// Accessor for sidecar / crop modules — returns the card currently displayed
// in the lightbox, or null if no lightbox is open.
window.lightboxCard = () => (lightboxIndex >= 0 ? cards[lightboxIndex] : null);
window.lightboxRefreshDraw = () => {
    if (lightboxIndex >= 0 && cards[lightboxIndex]) {
        drawLightboxForCard(cards[lightboxIndex]);
    }
};
window.allCards = () => cards;

// Decode the parent's full-resolution JXL into card._jxlDecoded if not already
// cached. Used by crop.js to render focal-subject thumbnails from the JXL
// roundtrip. Returns a promise that resolves when the buffer is in place.
window.decodeFullJxlFor = function decodeFullJxlFor(card) {
    return new Promise((resolve) => {
        if (!card?._blobUrl) { resolve(null); return; }
        if (card._jxlDecoded) { resolve(card._jxlDecoded); return; }
        pool.decodeJxl(card._blobUrl, (msg) => {
            if (msg.type === 'decode_error') { resolve(null); return; }
            if (msg.type !== 'jxl_decoded' && msg.isFinal !== true) return;
            resolve(card._jxlDecoded ?? { rgba: msg.rgba, w: msg.w, h: msg.h });
        }, 'low', {
            progressive: true,
            cachePolicy: 'onFinal',
            progressiveDetail: 'lastPasses',
            cacheTarget: card,
        });
    });
};

// Open the lightbox on a parent card with a specific subject auto-focused —
// the lightbox will paint as usual but immediately zoom to fit the subject
// bounds so it occupies the viewport. Pressing arrow keys cycles through the
// parent + its subjects (the "connected set").
window.openLightboxAtSubject = function openLightboxAtSubject(parentCard, subjectId) {
    if (!parentCard) return;
    openLightbox(parentCard);
    parentCard._focusedSubjectId = subjectId;
    // After open, queue a frame to apply the subject zoom — the canvas needs
    // to have been painted first.
    requestAnimationFrame(() => focusOnSubject(parentCard, subjectId));
};

function focusOnSubject(card, subjectId) {
    const subj = (card?._subjects || []).find(s => s.id === subjectId);
    if (!subj) return;
    focusOnRegion(subj.x, subj.y, subj.w, subj.h);
}
window.focusOnSubject = focusOnSubject;

// Centre + fit a normalised rectangle of the current canvas into the viewport.
// Used by both subject focus and crop "fit to crop" on open.
function focusOnRegion(x, y, w, h) {
    const canvas = lightboxCanvas;
    if (canvas.width <= 1 || canvas.height <= 1) return;
    const vp = lbViewport.getBoundingClientRect();
    const regionPxW = w * canvas.width;
    const regionPxH = h * canvas.height;
    if (regionPxW <= 0 || regionPxH <= 0) return;
    const fit = Math.min(vp.width / regionPxW, vp.height / regionPxH, LB_ZOOM_MAX);
    lbZoom = fit;
    const cx = (x + w / 2) * canvas.width;
    const cy = (y + h / 2) * canvas.height;
    lbPanX = (canvas.width  / 2 - cx) * lbZoom;
    lbPanY = (canvas.height / 2 - cy) * lbZoom;
    lbDisplayLongPx = Math.max(canvas.width, canvas.height) * lbZoom;
    applyLbTransform();
}
window.focusOnRegion = focusOnRegion;

function currentOptions() {
    return {
        quality: Number(qualityRange.value),
        effort: Number(effortSelect.value),
        lossless: losslessToggle.checked,
        look: currentLook(),
        // WB R/B numeric override — no longer surfaced as sliders.  Temp /
        // tint sliders give relative shifts; auto WB used as base.
        wbR: NaN,
        wbB: NaN,
    };
}

qualityRange.addEventListener('input', () => {
    qualityLabel.textContent = qualityRange.value;
});
losslessToggle.addEventListener('change', () => {
    qualityRange.disabled = losslessToggle.checked;
});

let focusedFieldset = null;
for (const el of lookInputs) {
    el.addEventListener('pointerdown', () => {
        const fieldset = el.closest('fieldset');
        if (fieldset && fieldset !== focusedFieldset) {
            if (focusedFieldset) focusedFieldset.classList.remove('focused-control');
            focusedFieldset = fieldset;
            fieldset.classList.add('focused-control');
            document.body.classList.add('control-focus-mode');
        }
    });
    el.addEventListener('input', () => {
        const name = el.dataset.look;
        const lbl = lookLabels.get(name);
        if (lbl) lbl.textContent = lookDisplay(name);
        scheduleLiveUpdate();
        scheduleGalleryLiveUpdate();
    });
}
document.addEventListener('pointerup', () => {
    if (focusedFieldset) {
        focusedFieldset.classList.remove('focused-control');
        focusedFieldset = null;
        document.body.classList.remove('control-focus-mode');
    }
});

reprocessBtn.addEventListener('click', () => reprocessSelected());

applyLookBtn.addEventListener('click', () => {
    const selected = cards.filter(c => c.classList.contains('selected') && c._file);
    const targets = selected.length ? selected : cards.filter(c => c._file);
    if (!targets.length) return;
    if (!selected.length) {
        // No explicit selection — select all, then reprocess all.
        for (const c of cards) {
            if (c._file) {
                c.classList.add('selected');
                c.querySelector('.thumb-select').textContent = '✓';
            }
        }
        refreshReprocessLabel();
    }
    reprocessSelected();
});

resetLookBtn.addEventListener('click', () => {
    resetLookSliders();
    scheduleLiveUpdate();
    scheduleGalleryLiveUpdate();
});

// ---------------------------------------------------------------------------
// Presets (1-10, stored in localStorage)
// ---------------------------------------------------------------------------
const PRESET_STORAGE_KEY = 'orf-converter-presets';
let presets = (() => {
    try { return JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY)) || new Array(10).fill(null); }
    catch { return new Array(10).fill(null); }
})();

function savePresetsToStorage() {
    try { localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets)); } catch {}
}

function applyLookValues(look) {
    for (const el of lookInputs) {
        const name = el.dataset.look;
        const v = look[name] ?? 0;
        el.value = name === 'exposureEv' ? v : v * 100;
    }
    contrastBoostEl.checked = false;
    refreshLookLabels();
    scheduleLiveUpdate();
    scheduleGalleryLiveUpdate();
}
window.applyLookValues = applyLookValues;

function updatePresetButtons() {
    for (const btn of presetBtns) {
        const slot = Number(btn.dataset.preset);
        const p = presets[slot];
        btn.classList.toggle('assigned', !!p);
        btn.title = p ? p.name : `Click to assign current look to slot ${slot + 1}`;
    }
}

for (const btn of presetBtns) {
    btn.addEventListener('click', (e) => {
        const slot = Number(btn.dataset.preset);
        if (e.shiftKey || !presets[slot]) {
            // Assign current look to this slot
            const defaultName = `Preset ${slot + 1}`;
            const name = prompt('Name this preset:', defaultName);
            if (name === null) return; // cancelled
            presets[slot] = { name: name || defaultName, look: currentLook() };
            savePresetsToStorage();
            updatePresetButtons();
        } else {
            applyLookValues(presets[slot].look);
        }
    });
}
updatePresetButtons();

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------
const jxlFirstProgressCacheSeen = new Set();

// NOTE: The default cache policy for visible lightbox JXL paints is currently 'onFirstProgress'.
// That means straighten/live editing may use the first progressive frame as the clean baseline
// during refinement. The policy may change in the future; the per-request flag exists so the
// difference remains measurable and controllable. Do not remove the three-policy wiring without
// updating the P3.1 lightbox progressive decoder design notes.
function applyJxlDecodeCachePolicy(card, decodeId, pixels, w, h, isFinal, policy) {
    if (!card || !pixels || !w || !h || policy === 'never') return;
    if (policy === 'onFirstProgress') {
        if (jxlFirstProgressCacheSeen.has(decodeId)) return;
        jxlFirstProgressCacheSeen.add(decodeId);
        card._jxlProgressCacheDecodeId = decodeId;
        card._jxlDecoded = { rgba: pixels, w, h };
        return;
    }
    if (policy === 'onFinal' && isFinal) {
        card._jxlDecoded = { rgba: pixels, w, h };
    }
}

class WorkerPool {
    constructor(size) {
        this.size = size;
        this.workers = [];
        this.free = [];
        this.queue = [];
        this.tasks = new Map(); // id -> handlers
        this.nextId = 1;
        this.workerForTask = new Map(); // taskId -> worker (populated on _releaseWorker)
        this._jxlDecodeCallbacks = new Map(); // decodeId -> { url, listeners: [{ cb, options }] }
        this._jxlNextDecodeId    = 1;
        this._jxlDecodeQueue = [];           // { decodeId, url, priority, options }
        this._jxlDecodeBusy  = false;
        this._jxlPendingByUrl = new Map();   // url -> decodeId (dedupe)
    }

    _jxlPriorityRank(p) { return p === 'high' ? 0 : p === 'low' ? 2 : 1; }
    _sortJxlQueue() {
        const rank = this._jxlPriorityRank.bind(this);
        this._jxlDecodeQueue.sort((a, b) => rank(a.priority) - rank(b.priority));
    }
    _pumpJxlQueue() {
        if (this._jxlDecodeBusy) return;
        const next = this._jxlDecodeQueue.shift();
        if (!next) return;
        this._jxlDecodeBusy = true;
        this._jxlDecodeWorker.postMessage({
            type: 'decode_jxl', decodeId: next.decodeId, url: next.url,
            progressive: next.options?.progressive === true,
            cachePolicy: next.options?.cachePolicy,
            progressiveDetail: next.options?.progressiveDetail,
            previewFirst: next.options?.previewFirst === true,
            allowAlphaProgressive: next.options?.allowAlphaProgressive ?? ALPHA_PROGRESSIVE,
            region: next.options?.region ?? null,
            downsample: next.options?.downsample ?? null,
            frameIndex: next.options?.frameIndex ?? null,
            jpegReconstructionAvailable: next.options?.jpegReconstructionAvailable === true,
        });
    }
    _onJxlDecodeResponse(data) {
        const isFinal = data.type === 'jxl_decoded' || data.isFinal === true;
        const isTerminal = data.type === 'jxl_decoded' || data.type === 'decode_error';
        const entry = this._jxlDecodeCallbacks.get(data.decodeId);
        if (entry) {
            for (const listener of entry.listeners) {
                if (typeof listener.options?.guard === 'function' && !listener.options.guard()) continue;
                // See the policy note above: cache writes stay centralized here.
                if (data.type === 'jxl_progress' || data.type === 'jxl_decoded') {
                    applyJxlDecodeCachePolicy(
                        listener.options?.cacheTarget,
                        data.decodeId,
                        data.rgba,
                        data.w,
                        data.h,
                        isFinal,
                        listener.options?.cachePolicy ?? 'never',
                    );
                }
                listener.cb(data);
            }
            if (isTerminal) {
                this._jxlDecodeCallbacks.delete(data.decodeId);
                this._jxlPendingByUrl.delete(entry.url);
                jxlFirstProgressCacheSeen.delete(data.decodeId);
            }
        }
        // Release the single decode slot only on a true terminal message.
        // header / preview / recon_jpeg / progress are mid-decode signals — they
        // must NOT free the slot, or the next queued decode is dispatched to the
        // same worker while this one is still running (overlapping decodes,
        // out-of-order frames, unbounded WASM decoder instances).
        if (isTerminal) {
            this._jxlDecodeBusy = false;
            this._pumpJxlQueue();
        }
    }

    init() {
        for (let i = 0; i < this.size; i++) {
            this._spawnWorker();
        }
        // TTFP-1: prewarm the RAW-pipeline WASM in the workers the next submits
        // will actually receive. `_dispatch` pops from the TAIL of `free`, so
        // warm the last two spawned workers — the first 1-2 files then skip the
        // fetch+compile+instantiate+rayon-init leg entirely. Only two (not all
        // `size`) so a user who never drops a file doesn't pay `size` WASM
        // instances + rayon pools; the rest warm lazily on their first task.
        const PREWARM_COUNT = Math.min(2, this.free.length);
        for (let i = 0; i < PREWARM_COUNT; i++) {
            this.free[this.free.length - 1 - i].postMessage({ type: WorkerMsg.PRELOAD });
        }
    }

    _spawnWorker() {
        const w = new Worker(new URL('./worker.js', import.meta.url), {
            type: 'module',
        });
        w.addEventListener('message', (ev) => this._onMessage(w, ev));
        w.addEventListener('error', (ev) => {
            console.error('worker error:', ev);
            // Find any pending task assigned to this worker and unblock it.
            for (const [id, t] of this.tasks) {
                if (t.worker === w && !t.released) {
                    if (t.handlers.onError) {
                        t.handlers.onError({ type: WorkerMsg.ERROR, error: ev.message || 'worker crashed' });
                    }
                    this.tasks.delete(id);
                    break;
                }
            }
            // Remove the dead worker — do NOT return it to free pool.
            const wi = this.workers.indexOf(w);
            if (wi !== -1) this.workers.splice(wi, 1);
            const fi = this.free.indexOf(w);
            if (fi !== -1) this.free.splice(fi, 1);
            // Dispatch any queued task with remaining workers; also shrink size
            // so subsequent submits don't wait forever.
            this.size = Math.max(1, this.size - 1);
            const next = this.queue.shift();
            if (next) this._dispatch(next);
        });
        this.workers.push(w);
        this.free.push(w);
    }

    submit(bytes, options, handlers, priority = 'normal') {
        const id = this.nextId++;
        this.tasks.set(id, { handlers, worker: null, released: false, priority });
        this._dispatch({ id, bytes, options, priority });
        return id;
    }

    _rawPriorityRank(p) { return p === 'high' ? 0 : p === 'medium' ? 1 : p === 'low' ? 3 : 2; }
    _sortQueue() {
        const rank = this._rawPriorityRank.bind(this);
        this.queue.sort((a, b) => rank(a.priority) - rank(b.priority));
    }

    setPriority(taskId, priority) {
        const t = this.tasks.get(taskId);
        if (t) t.priority = priority;
        const q = this.queue.find(x => x.id === taskId);
        if (q) {
            q.priority = priority;
            this._sortQueue();
        }
    }

    _dispatch(task) {
        const w = this.free.pop();
        if (!w) {
            this.queue.push(task);
            this._sortQueue();
            return;
        }
        this.tasks.get(task.id).worker = w;
        // Transfer the ORF bytes so we don't hold a copy in the main thread.
        w.postMessage(task, [task.bytes.buffer]);
    }

    _onMessage(worker, ev) {
        const { id, type } = ev.data;
        if (type === WorkerMsg.LIGHTBOX_LIVE || type === WorkerMsg.ERROR_LIVE) {
            if (this._liveHandler) this._liveHandler(ev.data);
            return;
        }
        if (type === WorkerMsg.THUMB_LIVE) {
            if (this._thumbLiveHandler) this._thumbLiveHandler(ev.data);
            return;
        }
        if (type === WorkerMsg.ENCODE_REQUEST) {
            const { id, pixels, rgba, format, width, height, quality, effort, lossless, progressive, orientation, pipelineMs, phaseMs } = ev.data;
            // TTFP-4: ENCODE_REQUEST is the RAW worker's final message for a
            // task (the encode itself runs on the jxl worker pool), so release
            // the worker slot here. Previously released on LIGHTBOX — with the
            // two-phase split LIGHTBOX arrives before the full-res phase, when
            // the worker is still genuinely busy.
            const reqTask = this.tasks.get(id);
            if (reqTask && !reqTask.released) this._releaseWorker(worker, id);
            const t0 = performance.now();
            // A3: accept new pixels/format fields; fall back to legacy rgba field for jxl-progressive.js
            encodeJxlSession(pixels ?? rgba, width, height, quality, effort, Boolean(lossless), Boolean(progressive), format ?? 'rgba8', orientation)
                .then((jxl) => {
                    const jxlMs = performance.now() - t0;
                    const t = this.tasks.get(id);
                    if (t?.handlers.onDone) {
                        // pipelineMs/phaseMs: split-task totals (both WASM
                        // phases); absent for monolithic CR2/EXR/TIFF tasks.
                        t.handlers.onDone({ id, type: WorkerMsg.DONE, jxl, jxlMs, w: width, h: height, effortUsed: effort, effortRequested: effort, pipelineMs, phaseMs });
                    }
                    this.tasks.delete(id);
                })
                .catch((err) => {
                    const t = this.tasks.get(id);
                    if (t?.handlers.onError) {
                        t.handlers.onError({ type: WorkerMsg.ERROR, error: String(err?.message ?? err) });
                    }
                    this.tasks.delete(id);
                });
            return;
        }
        const t = this.tasks.get(id);
        if (!t) return;
        const handlers = t.handlers;
        if (type === WorkerMsg.THUMB && handlers.onThumb) handlers.onThumb(ev.data);
        else if (type === WorkerMsg.LIGHTBOX && handlers.onLightbox) {
            handlers.onLightbox(ev.data);
            // TTFP-4: do NOT release the worker here. With the two-phase RAW
            // split, LIGHTBOX posts right after the streaming preview phase
            // while the worker still owns the full-res phase; the release
            // moved to ENCODE_REQUEST (the task's final worker message).
        }
        else if (type === WorkerMsg.DONE) {
            if (handlers.onDone) handlers.onDone(ev.data);
            this.tasks.delete(id);  // Worker already freed on encode_request
            // KEEP workerForTask[id] alive — the owning worker still holds
            // liveStateMap[id], so reprocess_live for the lightbox needs to
            // know which worker to message even long after JXL is done.
            // Mapping is overwritten if the same card is re-submitted (new
            // taskId issued), so it doesn't leak.
        } else if (type === WorkerMsg.ERROR) {
            if (handlers.onError) handlers.onError(ev.data);
            // Error may arrive before or after lightbox — only release worker if not yet done.
            if (!t.released) this._releaseWorker(worker, id);
            this.tasks.delete(id);
            this.workerForTask.delete(id);
        }
    }

    // Release the worker slot for the next queued ORF without deleting the task
    // (task stays alive until 'done' or 'error' arrives with the JXL result).
    _releaseWorker(worker, id) {
        const t = this.tasks.get(id);
        if (t) t.released = true;
        // Track which worker owns this taskId so reprocessLive can find it.
        this.workerForTask.set(id, worker);
        if (!worker._taskIds) worker._taskIds = new Set();
        worker._taskIds.add(id);
        this.free.push(worker);
        const next = this.queue.shift();
        if (next) this._dispatch(next);
    }

    // Full release (error before lightbox, or legacy callers).
    _release(worker, id) {
        this.tasks.delete(id);
        this._releaseWorker(worker, id);
    }

    setLiveHandler(fn) { this._liveHandler = fn; }
    setThumbLiveHandler(fn) { this._thumbLiveHandler = fn; }

    setJxlDecodeWorker(w) {
        this._jxlDecodeWorker = w;
        w.addEventListener('message', ({ data }) => this._onJxlDecodeResponse(data));
        w.addEventListener('error', (ev) => {
            console.error('jxl-decode-worker error:', ev.message);
            // A worker crash otherwise wedges the queue forever: `_jxlDecodeBusy`
            // never clears and pending callbacks never resolve (loaders spin).
            // Fail every in-flight decode and resume the pump so the UI recovers.
            const reason = ev.message || 'decode worker crashed';
            for (const [decodeId, entry] of this._jxlDecodeCallbacks) {
                for (const listener of entry.listeners) {
                    try { listener.cb({ type: 'decode_error', decodeId, error: reason }); } catch {}
                }
                this._jxlPendingByUrl.delete(entry.url);
                jxlFirstProgressCacheSeen.delete(decodeId);
            }
            this._jxlDecodeCallbacks.clear();
            this._jxlDecodeBusy = false;
            this._pumpJxlQueue();
        });
        w.postMessage({ type: 'preload' });
    }

    /**
     * @param {string} url
     * @param {(msg: any) => void} callback
     * @param {'high'|'normal'|'low'} [priority='normal']
     * @param {{progressive?: boolean, cachePolicy?: 'onFirstProgress'|'onFinal'|'never', progressiveDetail?: string, cacheTarget?: any, guard?: () => boolean}} [options]
     */
    decodeJxl(url, callback, priority = 'normal', options = {}) {
        // Dedupe — if same URL already pending, chain callback + promote priority.
        const existingId = this._jxlPendingByUrl.get(url);
        if (existingId != null) {
            const entry = this._jxlDecodeCallbacks.get(existingId);
            if (entry) {
                entry.listeners.push({ cb: callback, options: { ...options } });
            }
            // Promote priority if higher
            const newRank = this._jxlPriorityRank(priority);
            for (const q of this._jxlDecodeQueue) {
                if (q.decodeId === existingId) {
                    if (newRank < this._jxlPriorityRank(q.priority)) q.priority = priority;
                    break;
                }
            }
            this._sortJxlQueue();
            return;
        }
        const decodeId = this._jxlNextDecodeId++;
        this._jxlDecodeCallbacks.set(decodeId, { url, listeners: [{ cb: callback, options: { ...options } }] });
        this._jxlPendingByUrl.set(url, decodeId);
        this._jxlDecodeQueue.push({ decodeId, url, priority, options: { ...options } });
        this._sortJxlQueue();
        this._pumpJxlQueue();
    }

    reprocessLive(taskId, look) {
        // TTFP-4: workerForTask is populated at ENCODE_REQUEST (worker
        // release), but with the two-phase split the lightbox is interactive
        // during phase 2 — fall back to the task's assigned worker (same
        // pattern as cancelTask) so live slider edits route correctly in that
        // window. The worker answers after its current phase completes.
        const worker = this.workerForTask.get(taskId)
            || this.tasks.get(taskId)?.worker;
        if (!worker) return false;
        worker.postMessage({ id: taskId, type: WorkerMsg.REPROCESS_LIVE, look });
        return true;
    }

    reprocessAllLive(taskIds, look) {
        if (!taskIds.length) return;
        // TTFP-4: route via workerForTask (released tasks — same contents as
        // the old per-worker _taskIds scan) PLUS the tasks map, so split tasks
        // still mid-phase-2 (thumb posted, worker not yet released) also get
        // gallery-wide thumb look updates; the worker answers after its
        // current phase completes (thumbStateMap is populated in phase 1).
        const byWorker = new Map();
        for (const id of taskIds) {
            const w = this.workerForTask.get(id) || this.tasks.get(id)?.worker;
            if (!w) continue;
            let mine = byWorker.get(w);
            if (!mine) byWorker.set(w, mine = []);
            mine.push(id);
        }
        for (const [w, mine] of byWorker) {
            w.postMessage({ type: WorkerMsg.REPROCESS_THUMB_LIVE, taskIds: mine, look });
        }
    }

    // Drop the cached rgb16 live/thumb state for a task that is being
    // re-submitted. Without this, re-processing the same file N times leaks
    // ~15 MB per reprocess inside the worker's liveStateMap.
    releaseState(taskId) {
        const worker = this.workerForTask.get(taskId);
        if (!worker) return;
        worker.postMessage({ type: WorkerMsg.RELEASE_STATE, id: taskId });
        this.workerForTask.delete(taskId);
        if (worker._taskIds) worker._taskIds.delete(taskId);
    }

    // Cancel an in-flight / no-longer-needed RAW task (lightbox closed, card
    // removed). Best-effort: the worker frees cached renderer state and stops
    // emitting further output for this task between messages (the synchronous
    // WASM decode itself cannot be interrupted). Fire-and-forget; safe to call
    // even if the task already completed or never reached a worker.
    cancelTask(taskId) {
        if (taskId == null) return;
        const worker = this.workerForTask.get(taskId)
            || this.tasks.get(taskId)?.worker;
        if (worker) worker.postMessage({ type: WorkerMsg.CANCEL, id: taskId });
    }
}

const pool = new WorkerPool(POOL_SIZE);
pool.init();

pool.setJxlDecodeWorker(new Worker(new URL('./jxl-decode-worker.js', import.meta.url), { type: 'module' }));

async function encodeJxlSession(pixels, width, height, quality, effort, lossless, progressive, format = 'rgba8', orientation) {
    // A3: rgb8 carries 3 channels (no alpha), rgba8/rgba16/rgbaf32 carry 4.
    const hasAlpha = format !== 'rgb8';
    const encOpts = {
        format,
        width,
        height,
        hasAlpha,
        distance: lossless ? 0 : null,
        quality: lossless ? null : quality,
        effort,
        progressive,
        priority: 'visible',
    };
    // JXL "free rotation": record EXIF orientation in basic info instead of
    // rotating pixels. Pixels are sensor-native, decoder applies the transform.
    if (orientation != null && orientation >= 1 && orientation <= 8) {
        encOpts.orientation = orientation;
    }
    const session = getContext().encode(encOpts);
    const buf = pixels instanceof ArrayBuffer ? pixels : pixels.buffer;
    await session.pushPixels(buf);
    await session.finish();
    const parts = [];
    for await (const chunk of session.chunks()) {
        parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
    const total = parts.reduce((n, a) => n + a.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.byteLength; }
    return out;
}

// ---------------------------------------------------------------------------
// Live lightbox re-render (debounced, in-flight gating)
// ---------------------------------------------------------------------------
let liveDebounceTimer = null;
let liveInFlight = false;
let livePendingLook = null;

function scheduleLiveUpdate() {
    if (lightboxIndex < 0) return;
    clearTimeout(liveDebounceTimer);
    liveDebounceTimer = setTimeout(() => {
        if (liveInFlight) {
            livePendingLook = typeof mergedLook === 'function' ? mergedLook(currentLook()) : currentLook();
            return;
        }
        triggerLiveUpdate(typeof mergedLook === 'function' ? mergedLook(currentLook()) : currentLook());
    }, 80);
}
window.scheduleLiveUpdate = scheduleLiveUpdate;

function triggerLiveUpdate(look) {
    if (IS_TAURI) { triggerLiveUpdateTauri(look); return; }
    const card = cards[lightboxIndex];
    if (!card || !card._taskId) return;
    if (!pool.reprocessLive(card._taskId, look)) return;
    liveInFlight = true;
}

pool.setLiveHandler((msg) => {
    if (msg.type === WorkerMsg.ERROR_LIVE) {
        console.warn('live reprocess error:', msg.error);
        liveInFlight = false;
        if (livePendingLook) {
            const pending = livePendingLook;
            livePendingLook = null;
            triggerLiveUpdate(pending);
        }
        return;
    }
    liveInFlight = false;
    if (lightboxIndex >= 0) {
        const card = cards[lightboxIndex];
        if (msg.type === WorkerMsg.LIGHTBOX_LIVE && card && msg.id === card._taskId) {
            // Phase 2: worker sends sensor-orientation pixels + orientation tag.
            // Apply rotation via GPU canvas transform — no CPU pixel-shuffle.
            const sW = msg.nativeW ?? msg.w;
            const sH = msg.nativeH ?? msg.h;
            const ori = msg.orientation ?? 1;
            drawSensorWithOrientation(lightboxCanvas, msg.rgb, sW, sH, ori);
            if (lightboxCanvas.width > 0) {
                const ctx = lightboxCanvas.getContext('2d');
                captureCleanAndApplyLens(ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
            }
        }
    }
    if (livePendingLook) {
        const pending = livePendingLook;
        livePendingLook = null;
        triggerLiveUpdate(pending);
    }
});

contrastBoostEl.addEventListener('change', () => { scheduleLiveUpdate(); scheduleGalleryLiveUpdate(); });

// ---------------------------------------------------------------------------
// Gallery live thumb re-render (debounced, fans out to all selected cards)
// ---------------------------------------------------------------------------
const cardByTaskId = new Map();
let galleryDebounceTimer = null;

function scheduleGalleryLiveUpdate() {
    clearTimeout(galleryDebounceTimer);
    galleryDebounceTimer = setTimeout(() => triggerGalleryLiveUpdate(currentLook()), 80);
}

function triggerGalleryLiveUpdate(look) {
    const taskIds = cards
        .filter(c => c.classList.contains('selected') && c._taskId)
        .map(c => c._taskId);
    pool.reprocessAllLive(taskIds, look);
}

pool.setThumbLiveHandler((msg) => {
    const card = cardByTaskId.get(msg.id);
    if (card) {
        card._thumbRgb = msg.rgb;
        card._thumbW   = msg.w;
        card._thumbH   = msg.h;
        // Phase 2: sensor dims + orientation for GPU-rotate draw.
        card._thumbNativeW = msg.nativeW ?? msg.w;
        card._thumbNativeH = msg.nativeH ?? msg.h;
        card._thumbOrientation = msg.orientation ?? 1;
        redrawThumbRotated(card);
    }
});

// ---------------------------------------------------------------------------
// Card grid + per-file state
// ---------------------------------------------------------------------------
const cards = []; // ordered list of card elements for lightbox prev/next

// Remove a card from the gallery and tear down everything that referenced it:
//   - cancel its in-flight RAW worker task (best-effort between chunks),
//   - drop it from BOTH index maps (cardByTaskId keyed on _taskId, and the
//     Tauri cardByFilename keyed on the full path) so neither map leaks an entry
//     pointing at a detached DOM node,
//   - release any worker-side LookRenderer state and revoke blob URLs,
//   - splice it out of `cards` and remove the DOM element.
// Single source of truth for card teardown — any future delete/clear UI must
// route through here rather than dropping the element directly.
function removeCard(card) {
    if (!card) return;
    if (card._taskId != null) {
        pool.cancelTask(card._taskId);
        try { pool.releaseState(card._taskId); } catch {}
        cardByTaskId.delete(card._taskId);
    }
    if (card._tauriPath != null) cardByFilename.delete(card._tauriPath);
    if (card._blobUrl) { try { URL.revokeObjectURL(card._blobUrl); } catch {} card._blobUrl = null; }
    const i = cards.indexOf(card);
    if (i !== -1) cards.splice(i, 1);
    try { card.remove(); } catch {}
}
// Expose for any external/UI caller wiring a delete affordance.
window.removeCard = removeCard;

const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB hard limit before WASM
const seenFiles = new Set(); // "name|size|lastModified" — prevents duplicate-drop cards

function fileKey(f) { return `${f.name}|${f.size}|${f.lastModified}`; }

function makeCard(name) {
    const card = document.createElement('div');
    card.className = 'thumb busy';
    // Pre-size canvas to the RAW-thumb default (360×270 landscape 4:3, the
    // common Olympus aspect).  Without this, the canvas starts 0×0 and the
    // card collapses to the CSS min in view-natural mode, then expands when
    // the first thumb arrives — a visible layout pop.  Orientation may swap
    // to portrait once file_thumb_fast lands; that's a smaller shift than
    // empty→full.
    card.innerHTML = `
        <canvas width="360" height="270"></canvas>
        <div class="thumb-select" title="Select for re-process">·</div>
        <button class="thumb-rot-cw"  title="Rotate 90° CW">↻</button>
        <button class="thumb-rot-ccw" title="Rotate 90° CCW">↺</button>
        <button class="thumb-toggle-jpeg" hidden title="Toggle camera JPEG view">JXL</button>
        <button class="thumb-dl-btn" hidden title="Download JPEG">⬇ JPEG</button>
        <div class="meta">
            <span class="name"></span>
            <span class="time"></span>
            <span class="size"></span>
        </div>
    `;
    card.querySelector('.name').textContent = name.replace(/\.(orf|cr2|dng)$/i, '');
    card.querySelector('.thumb-select').addEventListener('click', (e) => {
        e.stopPropagation();
        card.classList.toggle('selected');
        card.querySelector('.thumb-select').textContent =
            card.classList.contains('selected') ? '✓' : '·';
        refreshReprocessLabel();
    });
    card.querySelector('.thumb-dl-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const stem = (card._file?.name || 'image').replace(/\.(orf|cr2|dng)$/i, '');
        const cv = card.querySelector('canvas');
        cv.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = stem + '.jpg'; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        }, 'image/jpeg', 0.95);
    });
    card.querySelector('.thumb-rot-cw').addEventListener('click', (e) => { e.stopPropagation(); rotateCard(card, 90); });
    card.querySelector('.thumb-rot-ccw').addEventListener('click', (e) => { e.stopPropagation(); rotateCard(card, -90); });
    card.querySelector('.thumb-toggle-jpeg').addEventListener('click', (e) => {
        e.stopPropagation();
        cycleSourceForCard(card, 1);
    });
    card.addEventListener('click', () => openLightbox(card));

    if (IS_TAURI) {
        const uploadBtn = document.createElement('button');
        uploadBtn.className = 'tauri-upload-btn';
        uploadBtn.title = 'Upload to planner';
        uploadBtn.textContent = '↑';
        uploadBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!card._tauriResult) return;
            uploadBtn.disabled = true; uploadBtn.textContent = '…';
            try {
                const [settings, token] = await Promise.all([invoke('get_settings'), invoke('get_token')]);
                const { jxl, exif } = card._tauriResult;
                const _jb = new Uint8Array(jxl); let _js = '';
                // Chunked binary-string build: String.fromCharCode.apply over
                // 0x8000-byte windows avoids the super-linear cost of per-byte
                // string concat on MB-scale JXL payloads. Identical base64 out.
                for (let _i = 0; _i < _jb.length; _i += 0x8000) _js += String.fromCharCode.apply(null, _jb.subarray(_i, _i + 0x8000));
                const jxl_b64 = btoa(_js);
                const result = await invoke('push_to_planner', {
                    payload: { filename: name, jxl_b64, exif, planner_url: settings.planner_url, token: token ?? '' },
                });
                uploadBtn.textContent = result.ok ? '✓' : '✗';
                uploadBtn.title = result.error ?? 'Uploaded';
            } catch (err) {
                uploadBtn.textContent = '✗'; uploadBtn.title = String(err);
            }
        });
        card.style.position = 'relative';
        card.appendChild(uploadBtn);
    }

    return card;
}

// Cycle the display source for a card: raw → jxl → jpeg → raw (dir=+1) or reverse (dir=-1).
function cycleSourceForCard(card, dir = 1) {
    const order = ['raw', 'jxl', 'jpeg'];
    const available = order.filter(m => {
        if (m === 'raw')  return !!card._lightbox;
        if (m === 'jxl')  return !!card._blobUrl;
        if (m === 'jpeg') return !!card._embeddedPreview;
        return false;
    });
    if (available.length < 2) return;
    const cur = available.indexOf(card._sourceMode ?? 'raw');
    const next = available[(cur + dir + available.length) % available.length];
    card._sourceMode = next;
    const labels = { raw: 'RAW', jxl: 'JXL', jpeg: 'JPEG' };
    refreshThumbToggleButton(card);
    if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
        liveInFlight = false;
        livePendingLook = null;
        drawLightboxForCard(card);
        flashSourceBanner();
        showSourceLabel(labels[next]);
        if (next === 'raw') scheduleLiveUpdate();
    }
    redrawThumbRotated(card);
}

function refreshThumbToggleButton(card) {
    const btn = card.querySelector('.thumb-toggle-jpeg');
    if (!btn) return;
    const available = ['raw', 'jxl', 'jpeg'].filter(m => {
        if (m === 'raw')  return !!card._lightbox;
        if (m === 'jxl')  return !!card._blobUrl;
        if (m === 'jpeg') return !!card._embeddedPreview;
    });
    btn.hidden = available.length < 2;
    if (available.length < 2) return;
    const mode   = card._sourceMode ?? 'raw';
    const labels = { raw: 'RAW', jxl: 'JXL', jpeg: 'JPEG' };
    btn.textContent = labels[mode] ?? 'RAW';
    btn.setAttribute('data-mode', mode);
    // Legacy class kept for external CSS hooks.
    btn.classList.toggle('showing-jpeg', mode === 'jpeg');
}

function refreshReprocessLabel() {
    const n = document.querySelectorAll('.thumb.selected').length;
    reprocessBtn.textContent = n ? `Re-process ${n} selected` : 'Re-process all';
}

// ---------------------------------------------------------------------------
// Gallery view mode (rect / square / natural) — persisted
// ---------------------------------------------------------------------------
const VIEW_MODE_KEY = 'orf-view-mode';
const viewBtns = [...document.querySelectorAll('.view-btn')];

function setViewMode(mode) {
    grid.classList.remove('view-square', 'view-natural');
    if (mode === 'square')  grid.classList.add('view-square');
    if (mode === 'natural') grid.classList.add('view-natural');
    for (const btn of viewBtns) btn.classList.toggle('active', btn.dataset.view === mode);
    try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch {}
}

for (const btn of viewBtns) {
    btn.addEventListener('click', () => setViewMode(btn.dataset.view));
}

// Restore persisted mode (default: rect).
setViewMode((() => { try { return localStorage.getItem(VIEW_MODE_KEY) || 'rect'; } catch { return 'rect'; } })());

function rgbToRgba(rgb, w, h) {
    const n = w * h;
    const buf = new ArrayBuffer(n * 4);
    const rgba = new Uint8ClampedArray(buf);
    const u32 = new Uint32Array(buf);
    // Pack RGBA as little-endian 0xFFBBGGRR using Uint32 writes (~4x fewer stores).
    for (let i = 0, p = 0; i < n; i++, p += 3) {
        u32[i] = (rgb[p]) | (rgb[p + 1] << 8) | (rgb[p + 2] << 16) | 0xFF000000;
    }
    return rgba;
}

function drawCanvas(canvas, w, h, rgb) {
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    // If worker already sent RGBA (byteLength === w*h*4) use it directly.
    const rgba = (rgb.byteLength === w * h * 4)
        ? (rgb instanceof Uint8ClampedArray ? rgb : new Uint8ClampedArray(rgb.buffer, rgb.byteOffset, rgb.byteLength))
        : rgbToRgba(rgb, w, h);
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
}

// Draw a sensor-orientation RGB8 buffer into a canvas, applying the EXIF
// orientation tag (1..8) as a 2D-context transform. drawImage with rotation is
// GPU-accelerated, so this costs ~0 ms regardless of image size — the rotation
// no longer lives in CPU pixel-shuffle work.
//
// Canvas dims are set to the displayed (post-rotation) size; sensor dims come
// from `sw`/`sh`. For mirror variants (2/4/5/7) a horizontal flip is composed.
function drawSensorWithOrientation(canvas, rgb, sw, sh, orientation) {
    if (!canvas) return;
    const ori = (orientation >= 1 && orientation <= 8) ? orientation : 1;
    // Map EXIF ori → (cw degrees, flipX).
    // 1=0/no, 2=0/yes, 3=180/no, 4=180/yes, 5=90/yes, 6=90/no, 7=270/yes, 8=270/no.
    const cw = (ori === 6 || ori === 5) ? 90
             : (ori === 3 || ori === 4) ? 180
             : (ori === 8 || ori === 7) ? 270
             : 0;
    const flipX = (ori === 2 || ori === 4 || ori === 5 || ori === 7);
    const swap = (cw === 90 || cw === 270);
    const dW = swap ? sh : sw;
    const dH = swap ? sw : sh;
    if (canvas.width !== dW)  canvas.width = dW;
    if (canvas.height !== dH) canvas.height = dH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rgba = rgbToRgba(rgb, sw, sh);
    if (cw === 0 && !flipX) {
        ctx.putImageData(new ImageData(rgba, sw, sh), 0, 0);
        return;
    }
    const tmp = document.createElement('canvas');
    tmp.width = sw; tmp.height = sh;
    const tctx = tmp.getContext('2d');
    if (tctx) tctx.putImageData(new ImageData(rgba, sw, sh), 0, 0);
    ctx.save();
    ctx.translate(dW / 2, dH / 2);
    ctx.rotate(cw * Math.PI / 180);
    if (flipX) ctx.scale(-1, 1);
    ctx.drawImage(tmp, -sw / 2, -sh / 2, sw, sh);
    ctx.restore();
}

// Draw an RGB8 buffer into canvas with an arbitrary CW rotation (0/90/180/270).
function drawRotatedCanvas(canvas, rgb, w, h, degrees) {
    if (!canvas) return;
    const d = ((degrees % 360) + 360) % 360;
    const swap = d === 90 || d === 270;
    const dW = swap ? h : w, dH = swap ? w : h;
    canvas.width = dW; canvas.height = dH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rgba = rgbToRgba(rgb, w, h);
    if (d === 0) { ctx.putImageData(new ImageData(rgba, w, h), 0, 0); return; }
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext('2d');
    if (tctx) tctx.putImageData(new ImageData(rgba, w, h), 0, 0);
    ctx.save();
    ctx.translate(dW / 2, dH / 2);
    ctx.rotate(d * Math.PI / 180);
    ctx.drawImage(tmp, -w / 2, -h / 2, w, h);
    ctx.restore();
}

// Redraw a card's thumbnail applying the current userRotations entry.  Routes
// through card._sourceMode: when 'jpeg' and we have an embedded preview cached,
// the camera's JPEG is rendered at the same canvas pixel dims as the JXL/RGB
// thumb so toggling doesn't change the viewport.
function redrawThumbRotated(card) {
    const deg = card._file?.name ? (userRotations[card._file.name] || 0) : 0;
    const canvas = card.querySelector('canvas');
    if (card._sourceMode === 'jpeg' && card._embeddedPreview && card._thumbW && card._thumbH) {
        drawJpegToTargetDims(canvas, card._embeddedPreview.bmp,
                             card._embeddedPreview.orientation || 1,
                             card._thumbW, card._thumbH);
        canvas.style.transform = deg ? `rotate(${deg}deg)` : '';
        setThumbSource(card, classifyJpegThumbSource(
            card._embeddedPreview.w, card._embeddedPreview.h));
        return;
    }
    // Prefer the cached JXL-decoded thumb when it's available — the badge
    // says "JXL thumb" so the pixels should match.
    if (card._jxlThumbBmp && card._jxlThumbW && card._jxlThumbH) {
        canvas.width  = card._jxlThumbW;
        canvas.height = card._jxlThumbH;
        canvas.getContext('2d').drawImage(card._jxlThumbBmp, 0, 0);
        canvas.style.transform = deg ? `rotate(${deg}deg)` : '';
        setThumbSource(card, 'jxl');
        return;
    }
    if (!card._thumbRgb) return;
    // Phase 2: rgb is sensor-orientation if nativeW/H/orientation present;
    // GPU-rotated draw avoids the CPU transpose. Falls back to plain putImageData
    // for older messages or when orientation is identity.
    if (card._thumbNativeW && card._thumbOrientation && card._thumbOrientation !== 1) {
        drawSensorWithOrientation(canvas, card._thumbRgb,
            card._thumbNativeW, card._thumbNativeH, card._thumbOrientation);
    } else {
        drawCanvas(canvas, card._thumbW, card._thumbH, card._thumbRgb);
    }
    canvas.style.transform = deg ? `rotate(${deg}deg)` : '';
    // RAW-pipeline thumb — no badge.
    setThumbSource(card, null);
}

// Rotate a card by delta degrees and persist + sync lightbox if open.
function rotateCard(card, delta) {
    const name = card._file?.name;
    if (!name) return;
    userRotations[name] = (((userRotations[name] || 0) + delta) % 360 + 360) % 360;
    saveUserRotations();
    redrawThumbRotated(card);
    if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
        lbRotation = userRotations[name];
        fitLbZoom();
    }
}

let totalSubmitted = 0;
let totalDone = 0;

const statusTimings = document.getElementById('status-timings');
const EMA_A = 0.25;
let emaPipeline = null; // Rust RAW pipeline (ms)
let emaEncode = null;   // JXL encode (ms)

// ---------------------------------------------------------------------------
// Embedded JPEG thumbnail extraction + orientation (pure JS, before WASM)
// ---------------------------------------------------------------------------
function sized(srcW, srcH, longEdge) {
    if (srcW >= srcH) {
        const w = Math.min(longEdge, srcW);
        return { w, h: Math.max(1, Math.round((srcH * w) / srcW)) };
    }
    const h = Math.min(longEdge, srcH);
    return { w: Math.max(1, Math.round((srcW * h) / srcH)), h };
}

// Extract all JPEG bitstreams embedded in a RAW/TIFF container.
// Strategy: find every SOI (FF D8 FF). For each, take the LAST FF D9 before
// the next SOI — this avoids truncation by entropy-coded FF D9 runs.
// Returns an array of Uint8Array blobs (unvalidated; createImageBitmap filters).
function extractEmbeddedJpegs(bytes) {
    const sois = [];
    for (let i = 0; i < bytes.length - 2; i++) {
        if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8 && bytes[i + 2] === 0xFF) {
            sois.push(i);
            i += 2;
        }
    }
    const blobs = [];
    for (let n = 0; n < sois.length; n++) {
        const start = sois[n];
        const end = n + 1 < sois.length ? sois[n + 1] : bytes.length;
        let eoi = -1;
        for (let j = end - 2; j >= start + 2; j--) {
            if (bytes[j] === 0xFF && bytes[j + 1] === 0xD9) { eoi = j; break; }
        }
        if (eoi !== -1) blobs.push(bytes.slice(start, eoi + 2));
    }
    return blobs;
}

// Parse EXIF orientation (tag 0x0112) from a JPEG byte array.
// Returns 1 (normal) when absent or unreadable.
function readJpegOrientation(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return 1;
    let i = 2;
    while (i + 4 <= bytes.length) {
        if (bytes[i] !== 0xFF) break;
        const marker = bytes[i + 1];
        const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
        if (marker === 0xE1 && i + 10 <= bytes.length &&
            bytes[i+4]===0x45&&bytes[i+5]===0x78&&bytes[i+6]===0x69&&
            bytes[i+7]===0x66&&bytes[i+8]===0x00&&bytes[i+9]===0x00) {
            const t = i + 10; // TIFF header base
            const le = bytes[t] === 0x49;
            const r16 = o => le ? (bytes[t+o] | bytes[t+o+1]<<8)
                                : (bytes[t+o]<<8 | bytes[t+o+1]);
            const r32 = o => le
                ? ((bytes[t+o] | bytes[t+o+1]<<8 | bytes[t+o+2]<<16 | bytes[t+o+3]<<24) >>> 0)
                : ((bytes[t+o]<<24 | bytes[t+o+1]<<16 | bytes[t+o+2]<<8 | bytes[t+o+3]) >>> 0);
            const ifd0 = r32(4);
            if (t + ifd0 + 2 > bytes.length) break;
            const nEntries = r16(ifd0);
            for (let e = 0; e < nEntries; e++) {
                const off = ifd0 + 2 + e * 12;
                if (t + off + 12 > bytes.length) break;
                if (r16(off) === 0x0112) return r16(off + 8); // SHORT inline value
            }
            break;
        }
        if (marker === 0xDA || segLen < 2) break; // SOS — no more metadata
        i += 2 + segLen;
    }
    return 1;
}

// Parse orientation tag (0x0112) from an ORF/TIFF file's own IFD0.
// The embedded JPEG previews often lack EXIF APP1 entirely; the RAW TIFF
// header is always present and is the authoritative source.
// Returns 1 (normal) when absent or unreadable.
function readOrfOrientation(bytes) {
    if (bytes.length < 8) return 1;
    const le = bytes[0] === 0x49 && bytes[1] === 0x49; // 'II' = little-endian
    if (!le && !(bytes[0] === 0x4D && bytes[1] === 0x4D)) return 1;
    const r16 = o => le ? (bytes[o] | bytes[o+1]<<8) : (bytes[o]<<8 | bytes[o+1]);
    const r32 = o => le
        ? ((bytes[o] | bytes[o+1]<<8 | bytes[o+2]<<16 | bytes[o+3]<<24) >>> 0)
        : ((bytes[o]<<24 | bytes[o+1]<<16 | bytes[o+2]<<8 | bytes[o+3]) >>> 0);
    // Olympus ORF uses non-TIFF magic at bytes 2-3 (IIRO/IIRS/IIUS = 0x524F/5253/5553)
    // rather than the standard TIFF 0x002A — skip the magic check entirely.
    // IFD0 offset at bytes 4-7 is standard across all variants.
    const ifd0 = r32(4);
    if (ifd0 + 2 > bytes.length) return 1;
    const n = r16(ifd0);
    for (let i = 0; i < n; i++) {
        const off = ifd0 + 2 + i * 12;
        if (off + 12 > bytes.length) break;
        if (r16(off) === 0x0112) {
            const val = r16(off + 8); // SHORT, inline value
            return (val >= 1 && val <= 8) ? val : 1;
        }
    }
    return 1;
}

// Draw a bitmap into canvas at thumbnail size, applying EXIF orientation via
// canvas transform (scaled to fit longEdge). Orientations 5-8 swap axes.
// Transform derivation: scaled version of the standard EXIF canvas transforms.
function drawOrientedThumb(canvas, bmp, orientation, longEdge) {
    const o = (orientation >= 1 && orientation <= 8) ? orientation : 1;
    const swap = o >= 5;
    const srcW = bmp.width, srcH = bmp.height;
    const dispW = swap ? srcH : srcW;
    const dispH = swap ? srcW : srcH;
    const { w: tw, h: th } = sized(dispW, dispH, longEdge);
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    if (o === 1) { ctx.drawImage(bmp, 0, 0, tw, th); return; }
    const sx = tw / dispW, sy = th / dispH;
    ctx.save();
    // Each case is the full-size EXIF transform with (srcW,srcH) replaced by
    // (tw/sx, th/sy) = (dispW, dispH) and translation scaled accordingly.
    switch (o) {
        case 2: ctx.transform(-sx,  0,   0,  sy,  tw,  0); break;
        case 3: ctx.transform(-sx,  0,   0, -sy,  tw, th); break;
        case 4: ctx.transform( sx,  0,   0, -sy,   0, th); break;
        case 5: ctx.transform(  0, sx,  sy,   0,   0,  0); break;
        case 6: ctx.transform(  0, sx, -sy,   0,  tw,  0); break;
        case 7: ctx.transform(  0,-sx, -sy,   0,  tw, th); break;
        case 8: ctx.transform(  0,-sx,  sy,   0,   0, th); break;
    }
    ctx.drawImage(bmp, 0, 0, srcW, srcH);
    ctx.restore();
}

// Draw a bitmap at full display size with EXIF orientation (for lightbox).
function drawBitmapOriented(canvas, bmp, orientation) {
    const o = (orientation >= 1 && orientation <= 8) ? orientation : 1;
    const swap = o >= 5;
    const srcW = bmp.width, srcH = bmp.height;
    const dW = swap ? srcH : srcW, dH = swap ? srcW : srcH;
    canvas.width = dW; canvas.height = dH;
    const ctx = canvas.getContext('2d');
    if (o === 1) { ctx.drawImage(bmp, 0, 0); return; }
    ctx.save();
    switch (o) {
        case 2: ctx.transform(-1, 0,  0,  1,  dW,  0); break;
        case 3: ctx.transform(-1, 0,  0, -1,  dW, dH); break;
        case 4: ctx.transform( 1, 0,  0, -1,   0, dH); break;
        case 5: ctx.transform( 0, 1,  1,  0,   0,  0); break;
        case 6: ctx.transform( 0, 1, -1,  0,  dW,  0); break;
        case 7: ctx.transform( 0,-1, -1,  0,  dW, dH); break;
        case 8: ctx.transform( 0,-1,  1,  0,   0, dH); break;
    }
    ctx.drawImage(bmp, 0, 0, srcW, srcH);
    ctx.restore();
}

// Draw an embedded-JPEG ImageBitmap into `canvas` so the resulting pixel grid
// matches the JXL/RGB render exactly: same canvas.width/height and same EXIF
// orientation applied.  The JPEG is rescaled (linear interpolation via the
// canvas drawImage path) into target dims and oriented in pixel space.  CSS
// zoom/pan/rotate transforms on the canvas then behave identically whether
// the JXL pixels or JPEG pixels are showing — that's the whole point of the
// JXL↔JPEG toggle: same viewport, just different pixel source.
//
// Implementation: instead of EXIF affine matrices on a fixed destination rect,
// we translate the origin to the canvas centre, rotate/flip, then draw the
// source bitmap centred at the pre-rotation rect.  Cleaner math, avoids the
// off-canvas drift bug the matrix form had for orientations 5-8.
function drawJpegToTargetDims(canvas, bmp, orientation, targetW, targetH) {
    const o = (orientation >= 1 && orientation <= 8) ? orientation : 1;
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (o === 1) { ctx.drawImage(bmp, 0, 0, targetW, targetH); return; }
    let rad = 0, flipX = 1, flipY = 1;
    switch (o) {
        case 2: flipX = -1; break;
        case 3: rad = Math.PI; break;
        case 4: flipY = -1; break;
        case 5: rad =  Math.PI / 2; flipX = -1; break;
        case 6: rad =  Math.PI / 2; break;
        case 7: rad = -Math.PI / 2; flipX = -1; break;
        case 8: rad = -Math.PI / 2; break;
    }
    // After rotation, the source maps onto the canvas like this: for
    // 90°/270° orientations the source's long edge aligns with the canvas's
    // long edge, so the pre-rotation dest-rect must use swapped dims.
    const swap = o >= 5;
    const dW = swap ? targetH : targetW;
    const dH = swap ? targetW : targetH;
    ctx.save();
    ctx.translate(targetW / 2, targetH / 2);
    ctx.rotate(rad);
    ctx.scale(flipX, flipY);
    ctx.drawImage(bmp, -dW / 2, -dH / 2, dW, dH);
    ctx.restore();
}

// How many bytes to read upfront for embedded JPEG extraction.
// Olympus ORF stores the embedded preview within the first ~1–2 MB; 3 MB is safe.
const PREVIEW_SLICE = 3 * 1024 * 1024;

function startConvert(file, existingCard) {
    if (!existingCard) {
        const key = fileKey(file);
        if (seenFiles.has(key)) return; // duplicate drop — same file already queued
        seenFiles.add(key);
        if (file.size > MAX_FILE_BYTES) {
            const card = makeCard(file.name);
            cards.push(card);
            grid.appendChild(card);
            card.classList.remove('busy');
            card.classList.add('error');
            card.dataset.error = `File too large (${(file.size / 1024 / 1024).toFixed(0)} MB > ${MAX_FILE_BYTES / 1024 / 1024} MB limit)`;
            totalSubmitted++; totalDone++; refreshStatus();
            return;
        }
    }
    const card = existingCard || makeCard(file.name);
    if (!existingCard) {
        cards.push(card);
        grid.appendChild(card);
    } else {
        // Re-processing: release old rgb16 state from the worker before re-submitting,
        // otherwise liveStateMap accumulates ~15 MB per reprocess of the same card.
        if (card._taskId) pool.releaseState(card._taskId);
        card.classList.remove('encoding', 'error', 'embedded-thumb');
        card.classList.add('busy');
        card._lightbox = null;
        // Keep _embeddedPreview alive across reprocess — JPEG-vs-JXL toggle needs it.
        // Force the JXL view back on so the user actually sees the result of
        // pressing Apply/Re-process; otherwise they'd be staring at the
        // (unchanged) camera JPEG and assume the action did nothing.
        card._sourceMode = 'raw';
        refreshThumbToggleButton(card);
        if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
            drawLightboxForCard(card);
        }
    }
    totalSubmitted++;
    card._file = file;
    // Check for existing sidecar dot + hydrate crop/subjects so any focal
    // subjects show up as sibling cards before the user opens the lightbox.
    if (typeof loadSidecar === 'function' && file.name) {
        loadSidecar(file.name).then(s => {
            if (!s) return;
            if (typeof updateSidecarDot === 'function') updateSidecarDot(file.name, true);
            if (typeof window.applyCropAndSubjectsToCard === 'function') {
                window.applyCropAndSubjectsToCard(card, s);
            }
        });
    }
    refreshStatus();

    // Phase A — fast: read only the first PREVIEW_SLICE bytes to extract the
    // embedded JPEG preview and show an oriented thumbnail immediately.
    // Runs concurrently with the full read below; failure is non-fatal.
    file.slice(0, PREVIEW_SLICE).arrayBuffer().then(sliceBuf => {
        const bytes = new Uint8Array(sliceBuf);
        // RAW TIFF orientation is authoritative — embedded JPEGs often lack EXIF.
        // Fall back to JPEG EXIF only if the RAW header is unreadable.
        const rawOrientation = readOrfOrientation(bytes);
        const candidates = extractEmbeddedJpegs(bytes);
        if (!candidates.length) return;
        Promise.allSettled(
            candidates.map(c => {
                const orientation = rawOrientation !== 1 ? rawOrientation : readJpegOrientation(c);
                return createImageBitmap(new Blob([c], { type: 'image/jpeg' }))
                    .then(bmp => ({ bmp, pixels: bmp.width * bmp.height,
                                    w: bmp.width, h: bmp.height, orientation }));
            })
        ).then(results => {
            const valid = results
                .filter(r => r.status === 'fulfilled')
                .map(r => r.value)
                .sort((a, b) => a.pixels - b.pixels);
            if (!valid.length) { pushStat('[jpeg] 0 valid'); return; }

            bumpJpegSignature(valid.map(v => `${v.w}×${v.h} ori${v.orientation}`).join(' + '));

            const largest = valid[valid.length - 1];

            if (card.classList.contains('busy') || card.classList.contains('embedded-thumb')) {
                drawOrientedThumb(card.querySelector('canvas'), largest.bmp, largest.orientation, 360);
                card.classList.remove('busy');
                card.classList.add('embedded-thumb');
                setThumbSource(card, classifyJpegThumbSource(largest.w, largest.h));
            }

            card._embeddedPreview = { bmp: largest.bmp, w: largest.w, h: largest.h,
                                      orientation: largest.orientation };
            refreshThumbToggleButton(card);
            if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
                if (!card._lightbox) {
                    // drawLightboxForCard ends with syncZoomToDisplayLong()
                    // which preserves displayed size (or fits on first paint).
                    drawLightboxForCard(card);
                } else {
                    // Refresh toggle button enabled-state now that the pair is complete.
                    updateToggleButtonState(card);
                }
            }

            for (let vi = 0; vi < valid.length - 1; vi++) valid[vi].bmp.close();
        });
    }).catch(() => {}); // preview failure is non-fatal

    // Phase B+C — full file read for WASM pipeline + JXL encode.
    file.arrayBuffer()
        .then((buf) => {
            const bytes = new Uint8Array(buf);
            const opts = currentOptions();
            opts.userRotation = userRotations[file.name] || 0;
            // Carry the filename so the worker's detectFormat can disambiguate
            // TIFF-magic RAW (orf/dng/cr2) from developed TIFF. Detection still
            // works on magic bytes alone if name is absent (e.g. EXR/CR2).
            opts.name = file.name || '';
            const initialPriority = card._pendingPriority || 'normal';
            card._pendingPriority = null;
            const taskId = pool.submit(bytes, opts, {
                onThumb(msg) {
                    card._thumbRgb = msg.rgb;
                    card._thumbW   = msg.w;
                    card._thumbH   = msg.h;
                    // Phase 2: sensor dims + orientation for GPU-rotate draw.
                    card._thumbNativeW = msg.nativeW ?? msg.w;
                    card._thumbNativeH = msg.nativeH ?? msg.h;
                    card._thumbOrientation = msg.orientation ?? 1;
                    // Fresh RAW thumb — drop any stale JXL bitmap from a prior
                    // process so redrawThumbRotated paints the new RAW pixels
                    // rather than the old JXL cache.
                    if (card._jxlThumbBmp) {
                        try { card._jxlThumbBmp.close(); } catch {}
                        card._jxlThumbBmp = null;
                    }
                    try {
                        redrawThumbRotated(card);
                    } catch (e) {
                        console.error('redrawThumb error:', e);
                        pushStat(`[redrawThumb ERROR] ${e?.message || e} (w=${msg.w} h=${msg.h} rgb=${msg.rgb?.byteLength})`);
                        drawCanvas(card.querySelector('canvas'), msg.w, msg.h, msg.rgb);
                    }
                    refreshThumbToggleButton(card);
                    card._pipelineMs = msg.pipelineMs;
                    card._phaseMs = msg.phaseMs;
                    card._wb = { r: msg.wbR, b: msg.wbB };
                    card._colorMatrixFromMn = msg.colorMatrixFromMn;
                    card._camera = [msg.make, msg.model].filter(Boolean).join(' ') || '?';
                    card._exif = msg.exif || null;
                    card.querySelector('.thumb-dl-btn').hidden = false;
                    card.classList.remove('busy', 'embedded-thumb');
                    card.classList.add('encoding');
                    setThumbSource(card, null);
                },
                onLightbox(msg) {
                    // Phase 2: cache sensor pixels + orientation so the lightbox
                    // draw applies rotation via canvas transform (GPU) rather than CPU.
                    card._lightbox = {
                        rgb: msg.rgb,
                        w: msg.w, h: msg.h,
                        nativeW: msg.nativeW ?? msg.w,
                        nativeH: msg.nativeH ?? msg.h,
                        orientation: msg.orientation ?? 1,
                    };
                    // Keep _embeddedPreview around — the JXL/JPEG toggle needs it.
                    refreshThumbToggleButton(card);
                    if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
                        drawLightboxForCard(card);
                    }
                },
                onDone(msg) {
                    card.classList.remove('encoding');
                    // TTFP-4 (two-phase RAW split): THUMB carried phase-1-only
                    // timings and exif with width/height 0 (lib.rs previews-only
                    // results have no sensor dims). Patch the real totals and
                    // dims now — before the stats push below reads them.
                    if (msg.pipelineMs != null) card._pipelineMs = msg.pipelineMs;
                    if (msg.phaseMs) card._phaseMs = msg.phaseMs;
                    if (card._exif && !card._exif.width && msg.w) {
                        card._exif.width  = msg.w;
                        card._exif.height = msg.h;
                    }
                    const blob = new Blob([msg.jxl], { type: 'image/jxl' });
                    // Revoke any previous blob URL for this card before creating a new one.
                    if (card._blobUrl) URL.revokeObjectURL(card._blobUrl);
                    const url = URL.createObjectURL(blob);
                    card._blobUrl = url;
                    card._jxlDecoded = null;  // cache stale once bytes change
                    card.querySelector('.size').textContent =
                        `${(msg.jxl.byteLength / 1024).toFixed(0)} KB`;
                    const totalMs = card._pipelineMs + msg.jxlMs;
                    const effortNote = (msg.effortUsed && msg.effortRequested && msg.effortUsed < msg.effortRequested)
                        ? ` (effort ${msg.effortRequested}→${msg.effortUsed}: OOM)` : '';
                    card.querySelector('.time').textContent =
                        (totalMs >= 60000
                            ? `${Math.floor(totalMs / 60000)}m ${((totalMs % 60000) / 1000).toFixed(0)}s`
                            : `${(totalMs / 1000).toFixed(1)}s`) + effortNote;
                    card._meta =
                        `${msg.w}×${msg.h} • pipeline ${card._pipelineMs.toFixed(0)} ms • JXL ${msg.jxlMs.toFixed(0)} ms${effortNote}`;

                    // Stats line — keeps everything one image needs on one row.
                    statSeq++;
                    const p = card._phaseMs || {};
                    const wb = card._wb || {};
                    const name = file.name.padEnd(18, ' ').slice(0, 18);
                    const wbStr = wb.r != null
                        ? `wb R${wb.r.toFixed(3)} B${wb.b.toFixed(3)}`
                        : 'wb ?';
                    const matrixStr = card._colorMatrixFromMn === true ? 'mn-matrix'
                                    : card._colorMatrixFromMn === false ? 'fallback-matrix'
                                    : '';
                    bumpWbMatrix(wbStr, matrixStr);
                    pushStat(
                        `[${String(statSeq).padStart(3, ' ')}] ${name} ${msg.w}×${msg.h}  ` +
                        `dec ${fmtMs(p.decompress)}  ` +
                        `dem ${fmtMs(p.demosaic)}  ` +
                        `tone ${fmtMs(p.tonemap)}  ` +
                        `ori ${fmtMs(p.orient)}  ` +
                        `pipe ${fmtMs(card._pipelineMs)}  ` +
                        `jxl ${fmtMs(msg.jxlMs)}  ` +
                        `out ${fmtKb(msg.jxl.byteLength)}`,
                    );

                    emaPipeline = emaPipeline == null ? card._pipelineMs : EMA_A * card._pipelineMs + (1 - EMA_A) * emaPipeline;
                    emaEncode   = emaEncode   == null ? msg.jxlMs        : EMA_A * msg.jxlMs        + (1 - EMA_A) * emaEncode;
                    totalDone++;
                    refreshStatus();
                    // Replace the RAW-pipeline thumb with a JXL-decoded one so
                    // the grid shows what the JXL roundtrip looks like.
                    repaintThumbFromJxl(card);
                    // Subject sibling cards: now that JXL is ready, render
                    // their thumbnails from the parent's full-res JXL pixels.
                    if (card._subjects?.length && typeof window.renderSubjectThumb === 'function') {
                        window.renderSubjectThumb(card).catch(() => {});
                    }
                },
                onError(msg) {
                    card.classList.remove('busy', 'encoding');
                    card.classList.add('error');
                    card.dataset.error = msg.error;
                    statSeq++;
                    pushStat(`[${String(statSeq).padStart(3, ' ')}] ${file.name.padEnd(18,' ').slice(0,18)} ERROR: ${msg.error}`);
                    totalDone++;
                    refreshStatus();
                },
            }, initialPriority);
            card._taskId = taskId;
            cardByTaskId.set(taskId, card);
        })
        .catch((e) => {
            card.classList.add('error');
            card.dataset.error = e.message || String(e);
            totalDone++;
            refreshStatus();
        });
}

function fmtAvg(ms) {
    if (ms == null) return '—';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
}

function refreshStatus() {
    if (totalSubmitted === 0) {
        statusBar.hidden = true;
        return;
    }
    statusBar.hidden = false;
    progressEl.max = totalSubmitted;
    progressEl.value = totalDone;
    if (totalDone < totalSubmitted) {
        statusText.textContent = `${totalDone} / ${totalSubmitted}`;
    } else {
        statusText.textContent = `done — ${totalSubmitted} file${totalSubmitted === 1 ? '' : 's'}`;
    }
    if (emaPipeline != null) {
        const emaTotal = (emaPipeline ?? 0) + (emaEncode ?? 0);
        statusTimings.textContent =
            `RAW pipeline ${fmtAvg(emaPipeline)}  ·  JXL encode ${fmtAvg(emaEncode)}  ·  per file ${fmtAvg(emaTotal)}`;
    } else {
        statusTimings.textContent = '';
    }
}

// ---------------------------------------------------------------------------
// File / folder ingest
// ---------------------------------------------------------------------------
async function handleFileList(fileList) {
    const orfs = [...fileList].filter(isOrf);
    if (!orfs.length) return;

    window.dockSidebar();

    resetLookSliders();
    for (const f of orfs) startConvert(f);
}

// Supported pipeline formats: RAW (Olympus ORF, Canon CR2, Adobe/Pixel DNG) plus
// developed high-bit images (EXR, TIFF) which the worker decodes via decode_exr/
// decode_tiff and renders through the same LookRenderer live-edit engine. (Name
// kept `isOrf` for the many existing call sites.)
function isOrf(file) {
    return /\.(orf|cr2|dng|exr|tif|tiff)$/i.test(file.name);
}

// Walk a DataTransfer entry tree (only available on `drop` via
// `dataTransfer.items[*].webkitGetAsEntry()`).  Returns all ORF files
// found at any depth.
async function gatherFromItems(items) {
    const entries = [];
    for (const item of items) {
        if (typeof item.webkitGetAsEntry === 'function') {
            const entry = item.webkitGetAsEntry();
            if (entry) entries.push(entry);
        }
    }
    const out = [];
    async function walk(entry) {
        if (entry.isFile) {
            await new Promise((res, rej) => entry.file((f) => { if (isOrf(f)) out.push(f); res(); }, rej));
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            let batch;
            do {
                batch = await new Promise((res, rej) => reader.readEntries(res, rej));
                for (const child of batch) await walk(child);
            } while (batch.length);
        }
    }
    for (const e of entries) await walk(e);
    return out;
}

// Resize handle helper
function makeResizable(handle, panel, minW, maxW) {
    let startX, startW;
    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        startX = e.clientX;
        startW = panel.offsetWidth;
        handle.classList.add('dragging');
        handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
        if (!handle.classList.contains('dragging')) return;
        const w = Math.min(maxW, Math.max(minW, startW + (e.clientX - startX)));
        panel.style.width = w + 'px';
    });
    handle.addEventListener('pointerup', () => handle.classList.remove('dragging'));
}

// Timings sidebar — click-only, no hover
{
    const timingsSidebar = document.getElementById('timings-sidebar');
    const timingsTab = document.getElementById('timings-tab');
    const timingsClose = document.getElementById('timings-close');

    function toggleTimings(e) { e.stopPropagation(); timingsSidebar.classList.toggle('open'); }
    function closeTimings() { timingsSidebar.classList.remove('open'); }

    timingsTab.addEventListener('click', toggleTimings);
    timingsClose.addEventListener('click', closeTimings);

    makeResizable(document.getElementById('timings-resize'), document.getElementById('timings-panel'), 280, 900);
}

{
    makeResizable(document.getElementById('files-resize'), document.getElementById('sidebar-panel'), 160, 480);
}

// File sidebar open/close — runs regardless of Tauri/browser
{
    const sidebarEl = document.getElementById('file-sidebar');
    const sidebarTab = document.getElementById('sidebar-tab');

    function openSidebar() {
        if (sidebarEl.dataset.docked === '1') sidebarEl.classList.add('open');
    }
    function closeSidebar() {
        if (sidebarEl.dataset.docked === '1') sidebarEl.classList.remove('open');
    }
    function toggleSidebar() { sidebarEl.classList.toggle('open'); }

    window.dockSidebar = () => {
        sidebarEl.dataset.docked = '1';
        sidebarEl.classList.remove('open');
    };

    sidebarTab.addEventListener('click', (e) => { e.stopPropagation(); toggleSidebar(); });
    sidebarEl.addEventListener('mouseenter', openSidebar);
    sidebarEl.addEventListener('mouseleave', closeSidebar);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'l' || e.key === 'L') {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            toggleSidebar();
        }
    });
}

if (IS_TAURI) {
    pick.addEventListener('click', async () => {
        const paths = await invoke('pick_files');
        if (paths.length > 0) {
            window.dockSidebar();
            startBatchTauri(paths);
        }
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
    drop.addEventListener('dragover', (e) => e.preventDefault());
    drop.addEventListener('drop', (e) => e.preventDefault());
} else {
    pick.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => { await handleFileList(e.target.files); });

    // Window-level catch keeps the browser from saving a dropped file as a
    // download when the user misses the drop zone.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    drop.addEventListener('dragover', (e) => {
        e.preventDefault();
        drop.classList.add('dragging');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
    drop.addEventListener('drop', async (e) => {
        e.preventDefault();
        drop.classList.remove('dragging');
        let files = [];
        if (e.dataTransfer.items && e.dataTransfer.items.length) {
            files = await gatherFromItems(e.dataTransfer.items);
        }
        if (!files.length) files = [...e.dataTransfer.files].filter(isOrf);
        await handleFileList(files);
    });
}

// ---------------------------------------------------------------------------
// Lightbox — zoom / pan / download
// ---------------------------------------------------------------------------
let lightboxIndex = -1;

// Zoom / pan / rotation state
const LB_ZOOM_MIN = 0.05;
const LB_ZOOM_MAX = 8.0;
const LB_ZOOM_STEP = 1.25;
// Cap fit-to-viewport at 2× so tiny placeholders don't stretch absurdly while
// still filling the viewport rather than sitting at 100% pixel size.
const LB_FIT_CAP = 2.0;
let lbZoom = 1;
let lbPanX = 0;
let lbPanY = 0;
let lbRotation = 0; // 0 | 90 | 180 | 270
// Tracks the desired displayed long-edge in CSS pixels so a source swap
// (RAW ↔ JXL ↔ JPEG) keeps the image at the same visible size even though the
// underlying canvas pixel dimensions differ. null = "fit on next paint".
let lbDisplayLongPx = null;

const USER_ROT_KEY    = 'orf-user-rotations';
const LB_ROTATION_KEY = 'orf-lb-rotations'; // legacy — migrated on load
let userRotations = (() => {
    try {
        const legacy = JSON.parse(localStorage.getItem(LB_ROTATION_KEY)) || {};
        const saved  = JSON.parse(localStorage.getItem(USER_ROT_KEY))    || {};
        return { ...legacy, ...saved };
    } catch { return {}; }
})();
function saveUserRotations() {
    try { localStorage.setItem(USER_ROT_KEY, JSON.stringify(userRotations)); } catch {}
}

// Label what's actually on the thumb canvas right now.
//   'embedded'  — small camera IFD1 thumb pulled straight from the RAW
//   'downsized' — a larger embedded JPEG preview scaled down for the grid
//   'jxl'       — decoded back from the encoded JXL bytes
//   null        — RAW-pipeline thumb (no badge — that's the "real" output)
function setThumbSource(card, src) {
    if (src) card.setAttribute('data-thumb-src', src);
    else card.removeAttribute('data-thumb-src');
}

// Heuristic: anything wider than ~480px on the long edge was a full preview
// JPEG (e.g. Olympus ~1620×1080) that got scaled down for the grid; smaller
// images came from the tiny IFD1 thumb embedded in the RAW container.
const THUMB_EMBEDDED_MAX_LONG = 480;
function classifyJpegThumbSource(w, h) {
    return Math.max(w | 0, h | 0) > THUMB_EMBEDDED_MAX_LONG ? 'downsized' : 'embedded';
}

// After JXL encode finishes, decode and downsample to thumb dims so the grid
// shows what the JXL roundtrip actually looks like (replacing whatever embedded
// or RAW-pipeline thumb was there). Best-effort — failures stay silent.
function repaintThumbFromJxl(card) {
    if (!card?._blobUrl) return;
    // TTFP-6 (bounded cache-join): this decode runs at FULL resolution and was
    // previously discarded after the 360px resize. If the card sits inside the
    // lightbox prefetch neighbourhood (current ±PREFETCH_NEIGHBORS, wrap-around
    // exactly like prefetchAroundCurrent's modulo), let it double as the
    // prefetch cache write: prefetchJxl would otherwise decode the same URL
    // again moments later and cache the same final frame ('onFinal'), so the
    // memory cost equals existing prefetch policy while one full-res decode is
    // saved (and a subsequent lightbox open paints instantly from the cache —
    // same final pixels the progressive decode would converge to). Cards
    // OUTSIDE the neighbourhood keep today's no-cache behaviour: a batch
    // encode must not pin 4·W·H bytes per card (~80 MB at 20 MP).
    let cacheOpts;
    if (lightboxIndex >= 0 && cards.length > 0) {
        const idx = cards.indexOf(card);
        if (idx >= 0) {
            const d = Math.abs(idx - lightboxIndex);
            if (Math.min(d, cards.length - d) <= PREFETCH_NEIGHBORS) {
                cacheOpts = { cachePolicy: 'onFinal', cacheTarget: card };
            }
        }
    }
    pool.decodeJxl(card._blobUrl, (msg) => {
        if (msg.type === 'decode_error') {
            console.warn('JXL thumb decode error:', msg.error);
            return;
        }
        const canvas = card.querySelector('canvas');
        if (!canvas) return;
        const { rgba, w, h } = msg;
        const LONG_EDGE = 360;
        const long = Math.max(w, h);
        const targetW = long > LONG_EDGE ? Math.max(1, Math.round(w * LONG_EDGE / long)) : w;
        const targetH = long > LONG_EDGE ? Math.max(1, Math.round(h * LONG_EDGE / long)) : h;
        // Build the source ImageBitmap then high-quality draw into the thumb.
        // Cache the downsampled bitmap so rotation can repaint without
        // re-decoding the full JXL.
        createImageBitmap(new ImageData(rgba, w, h), {
            resizeWidth: targetW, resizeHeight: targetH, resizeQuality: 'high',
        }).then(bmp => {
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bmp, 0, 0);
            if (card._jxlThumbBmp && card._jxlThumbBmp !== bmp) {
                try { card._jxlThumbBmp.close(); } catch {}
            }
            card._jxlThumbBmp = bmp;
            card._jxlThumbW   = targetW;
            card._jxlThumbH   = targetH;
            card.classList.remove('embedded-thumb');
            setThumbSource(card, 'jxl');
        }).catch(e => console.warn('JXL thumb bitmap failed:', e));
    }, 'low', cacheOpts);
}

// ---------------------------------------------------------------------------
// Perceptual Lens + Colour Selector
// ---------------------------------------------------------------------------
let cleanSnapshot = null;
const perceptualLens = { active: false, strength: 0.7, lightness: true };
const colourSelect = { labBuf: null, mask: null, tolerance: 30, seeds: [] };

function captureCleanAndApplyLens(imageData) {
    cleanSnapshot = imageData;
    if (typeof setCleanCanvas === 'function') setCleanCanvas(imageData);
    // Feed the Tauri-parity M2 FilterEngine the clean 8-bit baseline (the
    // pre-lens snapshot) so its colour sliders have pixels to transform. This is
    // the only caller; without it paintFromBaseline always missed and the panel
    // was inert. Pass the snapshot directly to avoid a canvas read-back and to
    // avoid capturing lens-modified pixels.
    feedTauriParityBaseline(imageData);
    applyPerceptualLens();
}

function applyPerceptualLens() {
    if (!lightboxCanvas.width) return;
    const ctx = lightboxCanvas.getContext('2d');
    if (perceptualLens.active && cleanSnapshot) {
        const out = applyLens(
            cleanSnapshot.data, lightboxCanvas.width, lightboxCanvas.height,
            { strength: perceptualLens.strength, lightness: perceptualLens.lightness },
        );
        ctx.putImageData(new ImageData(out, lightboxCanvas.width, lightboxCanvas.height), 0, 0);
    } else if (!perceptualLens.active && cleanSnapshot) {
        ctx.putImageData(cleanSnapshot, 0, 0);
    }
    refreshSelectionOverlay();
}

function ensureLabBuf() {
    if (!cleanSnapshot || !lightboxCanvas.width) return;
    const sceneWhite = estimateSceneWhiteLms(
        cleanSnapshot.data, lightboxCanvas.width, lightboxCanvas.height,
    );
    colourSelect.labBuf = normalizedLabBuffer(
        cleanSnapshot.data, lightboxCanvas.width, lightboxCanvas.height, sceneWhite,
    );
}

function refreshSelectionOverlay() {
    if (!plOverlayCanvas) return;
    plOverlayCanvas.width = lightboxCanvas.width;
    plOverlayCanvas.height = lightboxCanvas.height;
    const vpW = lightboxCanvas.parentElement?.offsetWidth ?? 0;
    const vpH = lightboxCanvas.parentElement?.offsetHeight ?? 0;
    plOverlayCanvas.style.left = Math.round((vpW - lightboxCanvas.width) / 2) + 'px';
    plOverlayCanvas.style.top  = Math.round((vpH - lightboxCanvas.height) / 2) + 'px';
    plOverlayCanvas.style.transform = lightboxCanvas.style.transform;
    const ctx = plOverlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, plOverlayCanvas.width, plOverlayCanvas.height);
    if (!colourSelect.mask || !colourSelect.seeds.length) return;
    const border  = maskBorder(colourSelect.mask, plOverlayCanvas.width, plOverlayCanvas.height);
    const imgData = ctx.createImageData(plOverlayCanvas.width, plOverlayCanvas.height);
    for (let i = 0; i < colourSelect.mask.length; i++) {
        if (colourSelect.mask[i]) {
            imgData.data[i*4]   = 100;
            imgData.data[i*4+1] = 120;
            imgData.data[i*4+2] = 255;
            imgData.data[i*4+3] = 60;
        }
        if (border[i]) {
            imgData.data[i*4]   = 255;
            imgData.data[i*4+1] = 220;
            imgData.data[i*4+2] = 0;
            imgData.data[i*4+3] = 200;
        }
    }
    ctx.putImageData(imgData, 0, 0);
    const cov = maskCoverage(colourSelect.mask);
    const readout = document.getElementById('pl-probe-readout');
    if (readout) readout.textContent = `${(cov.fraction * 100).toFixed(1)}% selected`;
}

function handleLensClick(e) {
    ensureLabBuf();
    if (!colourSelect.labBuf) return;
    const rect = lightboxCanvas.getBoundingClientRect();
    const scaleX = lightboxCanvas.width / rect.width;
    const scaleY = lightboxCanvas.height / rect.height;
    const cx = Math.round((e.clientX - rect.left) * scaleX);
    const cy = Math.round((e.clientY - rect.top) * scaleY);
    const w = lightboxCanvas.width, h = lightboxCanvas.height;
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return;
    const p = probeColour(colourSelect.labBuf, w, h, cx, cy, 3);
    const readout = document.getElementById('pl-probe-readout');
    if (readout) readout.textContent = `H:${p.hueDeg.toFixed(0)}° S:${p.dampedSaturation.toFixed(1)} L:${p.lightness.toFixed(0)}`;
    const i = cy * w + cx;
    const seedLab = [colourSelect.labBuf[i*3], colourSelect.labBuf[i*3+1], colourSelect.labBuf[i*3+2]];
    const newMask = selectByColour(colourSelect.labBuf, w, h, seedLab, colourSelect.tolerance);
    if (e.ctrlKey && colourSelect.mask) {
        colourSelect.mask = unionMask(colourSelect.mask, newMask);
        colourSelect.seeds.push(seedLab);
    } else {
        colourSelect.mask = newMask;
        colourSelect.seeds = [seedLab];
    }
    refreshSelectionOverlay();
}

function applyLbTransform() {
    const t = `translate(${lbPanX}px, ${lbPanY}px) scale(${lbZoom}) rotate(${lbRotation}deg)`;
    lightboxCanvas.style.transform = t;
    lbZoomLabel.textContent = Math.round(lbZoom * 100) + '%';
    if (plOverlayCanvas) plOverlayCanvas.style.transform = t;
}

// Returns {fitW, fitH, vp} accounting for rotation, or null if canvas invalid.
function _lbFitDims() {
    const vp = lbViewport.getBoundingClientRect();
    const cw = lightboxCanvas.width;
    const ch = lightboxCanvas.height;
    if (cw <= 1 || ch <= 1 || vp.width <= 0 || vp.height <= 0) return null;
    const rotated = lbRotation === 90 || lbRotation === 270;
    return { fitW: rotated ? ch : cw, fitH: rotated ? cw : ch, vp };
}

function _lbFitZoom() {
    const d = _lbFitDims();
    if (!d) return 1;
    return Math.min(d.vp.width / d.fitW, d.vp.height / d.fitH, LB_FIT_CAP);
}

function _lbCanvasLongPx() {
    const d = _lbFitDims();
    return d ? Math.max(d.fitW, d.fitH) : null;
}

// Set lbZoom from current lbDisplayLongPx (preserving displayed size across
// source swaps). If lbDisplayLongPx is null or canvas is a placeholder, fall
// back to fit-to-viewport. Call after every canvas-paint that changed dims.
function syncZoomToDisplayLong() {
    const canvasLong = _lbCanvasLongPx();
    if (canvasLong == null) {
        applyLbTransform();
        return;
    }
    if (lbDisplayLongPx == null) {
        lbZoom = _lbFitZoom();
        lbPanX = 0;
        lbPanY = 0;
        lbDisplayLongPx = canvasLong * lbZoom;
    } else {
        lbZoom = lbDisplayLongPx / canvasLong;
    }
    applyLbTransform();
}

// Force-fit (without toggling to 100%). Used after rotation / new image opens.
function fitLbZoom() {
    lbDisplayLongPx = null;
    syncZoomToDisplayLong();
}

// Toolbar ⊙ button: toggle between fit-to-viewport and 100% (actual pixels).
// First press from any other zoom level snaps to fit.
function resetLbZoom() {
    const canvasLong = _lbCanvasLongPx();
    if (canvasLong == null) { lbZoom = 1; lbDisplayLongPx = null; applyLbTransform(); return; }
    const fitZoom = _lbFitZoom();
    const atFit = Math.abs(lbZoom - fitZoom) < 0.005;
    lbZoom = atFit ? 1.0 : fitZoom;
    lbPanX = 0;
    lbPanY = 0;
    lbDisplayLongPx = canvasLong * lbZoom;
    applyLbTransform();
}

function rotateBy(delta) {
    lbRotation = ((lbRotation + delta) % 360 + 360) % 360;
    const card = cards[lightboxIndex];
    if (card?._file?.name) {
        userRotations[card._file.name] = lbRotation;
        saveUserRotations();
        redrawThumbRotated(card);
    }
    // Rotation swaps long-edge orientation → refit.
    fitLbZoom();
}

function zoomAtPoint(clientX, clientY, factor) {
    const vp = lbViewport.getBoundingClientRect();
    const mx = clientX - (vp.left + vp.width / 2);
    const my = clientY - (vp.top + vp.height / 2);
    const newZoom = Math.max(LB_ZOOM_MIN, Math.min(LB_ZOOM_MAX, lbZoom * factor));
    const af = newZoom / lbZoom;
    lbPanX = lbPanX * af + mx * (1 - af);
    lbPanY = lbPanY * af + my * (1 - af);
    lbZoom = newZoom;
    const canvasLong = _lbCanvasLongPx();
    if (canvasLong != null) lbDisplayLongPx = canvasLong * lbZoom;
    applyLbTransform();
    if (pixelPeepActive) updatePeepBadges();
}

function drawLightboxForCard(card) {
    const mode = card._sourceMode ?? 'raw';

    if (mode === 'jpeg') {
        if (card._embeddedPreview && card._lightbox) {
            const { w, h } = card._lightbox;
            const { bmp, orientation } = card._embeddedPreview;
            drawJpegToTargetDims(lightboxCanvas, bmp, orientation || 1, w, h);
            if (lightboxCanvas.width > 0) {
                const _ctx = lightboxCanvas.getContext('2d');
                captureCleanAndApplyLens(_ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
            }
            setPaintedSourceBadge('jpeg');
            lbLoadingBadge.hidden = true;
            updateToggleButtonState(card);
            syncZoomToDisplayLong();
            return;
        }
        // Fallback: lightbox not ready yet, treat as raw.
        card._sourceMode = 'raw';
    }

    if (mode === 'jxl') {
        if (!card._blobUrl) {
            // JXL not ready yet — fall back to raw.
            card._sourceMode = 'raw';
        } else if (card._jxlDecoded) {
            // Cached from prefetch — instant paint.
            const { rgba, w, h } = card._jxlDecoded;
            lightboxCanvas.width  = w;
            lightboxCanvas.height = h;
            const ctx = lightboxCanvas.getContext('2d');
            // TTFP-2: hand the ImageData we just painted straight to the
            // snapshot instead of reading the whole canvas back. The put fills
            // the full canvas at (0,0) with opaque (alpha=255) pixels, so
            // getImageData would return byte-identical data — the readback +
            // its fresh 4·W·H allocation are pure waste. Consumers of
            // cleanSnapshot (applyLens, setCleanCanvas, feedTauriParityBaseline,
            // ensureLabBuf) are all read-only or deep-copy, so aliasing the
            // cached rgba buffer is safe.
            const frame = new ImageData(rgba, w, h);
            ctx.putImageData(frame, 0, 0);
            if (lightboxCanvas.width > 0) {
                captureCleanAndApplyLens(frame);
            }
            setPaintedSourceBadge('jxl');
            lbLoadingBadge.hidden = true;
            applyStraightenToLightboxCanvas(card);
            updateToggleButtonState(card);
            syncZoomToDisplayLong();
            return;
        } else {
            // Decode in flight — keep whatever pixels are on screen, show loader.
            lbLoadingBadge.hidden = false;
            updateToggleButtonState(card);
            pool.decodeJxl(card._blobUrl, (msg) => {
                if (lightboxIndex < 0 || cards[lightboxIndex] !== card) return;
                if (msg.type === 'decode_error') {
                    console.warn('JXL decode error:', msg.error);
                    lbLoadingBadge.hidden = true;
                    return;
                }
                lightboxCanvas.width  = msg.w;
                lightboxCanvas.height = msg.h;
                const ctx = lightboxCanvas.getContext('2d');
                // TTFP-2: this runs on EVERY progressive pass at full decoded
                // resolution. Reuse the ImageData we just painted as the clean
                // snapshot rather than reading the full canvas back — the put
                // covers the whole canvas at (0,0) with opaque pixels, so the
                // readback returned byte-identical data at the cost of a full
                // GPU→CPU sync + a fresh 4·W·H allocation per pass (~80 MB at
                // 20 MP). NOTE: the putImageData inside applyPerceptualLens is
                // NOT redundant and must stay — feedTauriParityBaseline →
                // onBaseFramePainted → paintFromBaseline paints the M2-adjusted
                // baseline onto this same canvas in between, and the lens-off
                // re-put is what restores clean pixels on top of it.
                const frame = new ImageData(msg.rgba, msg.w, msg.h);
                ctx.putImageData(frame, 0, 0);
                if (lightboxCanvas.width > 0) {
                    captureCleanAndApplyLens(frame);
                }
                setPaintedSourceBadge('jxl');
                lbLoadingBadge.hidden = true;
                applyStraightenToLightboxCanvas(card);
                syncZoomToDisplayLong();
            }, 'high', {
                progressive: true,
                cachePolicy: 'onFirstProgress',
                progressiveDetail: 'lastPasses',
                cacheTarget: card,
                guard: () => lightboxIndex >= 0 && cards[lightboxIndex] === card,
            });
            return;
        }
    }

    // mode === 'raw' (or fallback from unavailable mode).
    //
    // Tauri-mode policy: embedded JPEG preview is the PRIMARY lightbox source.
    // The RAW pipeline runs in the background to populate the rgb16 cache (so
    // sliders work) and to encode JXL for export, but the lightbox never waits
    // for that work.  When the user moves a slider, `apply_look` returns a
    // fresh RGB frame which `triggerLiveUpdateTauri` paints directly.
    //
    // WASM-mode keeps the original flow: the WASM worker emits the lightbox
    // RGB so card._lightbox.rgb is set without needing a fetch; if JXL is
    // ready first, auto-promote to JXL mode so the user sees real output.
    //
    // Order of preference:
    //   1. Full lightbox-sized RGB (best — only set in WASM mode, or after
    //      a slider edit in Tauri)
    //   2. Embedded JPEG preview (the fast-arriving JPEG, swapped to the
    //      larger ~1620×1080 preview via fetchLargePreviewIfNeeded)
    //   3. JXL decode (WASM only — Tauri stays on embedded)
    //   4. 1×1 clear (nothing available yet)
    const hasFullRgb     = !!(card._lightbox && card._lightbox.rgb);
    const hasEmbedded    = !!card._embeddedPreview;

    // WASM only: when JXL bytes arrive before RGB, jump to JXL mode so the
    // user sees real encoded output instead of the JPEG preview placeholder.
    // Tauri intentionally skips this — embedded JPEG stays primary until a
    // slider edit triggers `apply_look`.
    if (!hasFullRgb && card._blobUrl && !IS_TAURI) {
        card._sourceMode = 'jxl';
        drawLightboxForCard(card);
        return;
    }

    if (hasFullRgb) {
        const lb = card._lightbox;
        // Phase 2: if sensor-orient pixels with EXIF orientation, draw rotated via GPU.
        if (lb.nativeW && lb.orientation && lb.orientation !== 1) {
            drawSensorWithOrientation(lightboxCanvas, lb.rgb, lb.nativeW, lb.nativeH, lb.orientation);
        } else {
            drawCanvas(lightboxCanvas, lb.w, lb.h, lb.rgb);
        }
        if (lightboxCanvas.width > 0) {
            const _ctx = lightboxCanvas.getContext('2d');
            captureCleanAndApplyLens(_ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
        }
        setPaintedSourceBadge('raw');
        lbLoadingBadge.hidden = true;
        applyStraightenToLightboxCanvas(card);
    } else if (hasEmbedded) {
        const { bmp, orientation } = card._embeddedPreview;
        // In Tauri mode, the initial fast-emit JPEG is the tiny ~160×120 IFD1
        // thumbnail.  Drawing it would size the lightbox canvas to that, then
        // jump bigger when fetchLargePreviewIfNeeded swaps in the ~1620×1080
        // preview (different aspect ratio — 4:3 vs 3:2).  Defer until the
        // large preview lands so the lightbox starts at the correct size.
        const isSmallInTauri = IS_TAURI && Math.max(bmp.width, bmp.height) < 600
                              && !card._largePreviewFetched;
        if (isSmallInTauri) {
            lightboxCanvas.width = 1;
            lightboxCanvas.height = 1;
            if (lbPreviewBadge) lbPreviewBadge.hidden = true;
            lbLoadingBadge.hidden = false;
            fetchLargePreviewIfNeeded(card);
        } else {
            // Render to a stable lightbox-sized canvas.  Long edge matches
            // backend's LB_LONG_EDGE (1800) — when apply_look later returns a
            // RAW frame at the same long edge, the canvas only needs an
            // aspect-ratio adjustment, not a full rescale.
            const LB_LONG = 1800;
            const o = (orientation >= 1 && orientation <= 8) ? orientation : 1;
            const swap = o >= 5;
            const srcDispW = swap ? bmp.height : bmp.width;
            const srcDispH = swap ? bmp.width  : bmp.height;
            const knownW = card._lightbox?.w;
            const knownH = card._lightbox?.h;
            let targetW, targetH;
            if (knownW > 0 && knownH > 0) {
                targetW = knownW; targetH = knownH;
            } else if (srcDispW >= srcDispH) {
                targetW = Math.min(srcDispW, LB_LONG);
                targetH = Math.max(1, Math.round(srcDispH * targetW / srcDispW));
            } else {
                targetH = Math.min(srcDispH, LB_LONG);
                targetW = Math.max(1, Math.round(srcDispW * targetH / srcDispH));
            }
            drawJpegToTargetDims(lightboxCanvas, bmp, o, targetW, targetH);
            if (lightboxCanvas.width > 0) {
                const _ctx = lightboxCanvas.getContext('2d');
                captureCleanAndApplyLens(_ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
            }
            // Actual painted source is the embedded JPEG even though mode='raw'.
            setPaintedSourceBadge('jpeg');
            lbLoadingBadge.hidden = true;
            applyStraightenToLightboxCanvas(card);
        }
    } else {
        // Clear to known state so prior card's pixels don't bleed through.
        lightboxCanvas.width  = 1;
        lightboxCanvas.height = 1;
        if (lbPreviewBadge) lbPreviewBadge.hidden = true;
        lbLoadingBadge.hidden = false;
    }
    // Tauri lightbox no longer eagerly fetches the RAW RGB on open — that
    // happens only when the user moves a slider (triggerLiveUpdateTauri →
    // apply_look returns a fresh RAW frame and paints it directly).  This
    // keeps lightbox display latency bounded by the embedded preview path
    // instead of the full RAW pipeline + JXL queue.
    updateToggleButtonState(card);
    syncZoomToDisplayLong();
    // Final safety net for straighten in any remaining paths
    if (card && card._crop && card._crop.angle) {
        applyStraightenToLightboxCanvas(card);
    }
}

function updateToggleButtonState(card) {
    const mode   = card?._sourceMode ?? 'raw';
    const labels = { raw: 'RAW', jxl: 'JXL', jpeg: 'JPEG' };
    const havePair = !!(card && (card._lightbox || card._embeddedPreview || card._blobUrl));
    if (lbToggleJpegBtn) {
        lbToggleJpegBtn.disabled = !havePair;
        lbToggleJpegBtn.textContent = labels[mode] ?? 'RAW';
        lbToggleJpegBtn.setAttribute('data-mode', mode);
        // Legacy class kept for any external CSS hooks.
        lbToggleJpegBtn.classList.toggle('showing-jpeg', mode === 'jpeg');
    }
}

// Single source-of-truth badge for the actually painted source. Colour-coded:
// JPEG=green, JXL=blue, RAW=brown. Always visible in normal lightbox mode.
// Dims are read from the canvas — that is the natural pixel size of the
// painted source, which the user wants to see so they can correlate apparent
// sharpness with source resolution (Embedded JPEG ~1620×1080 vs JXL ~5184×3888).
function setPaintedSourceBadge(source) {
    if (!lbPreviewBadge) return;
    const labels = { raw: 'RAW', jxl: 'JPEG XL', jpeg: 'Embedded JPEG' };
    const label = labels[source] ?? labels.raw;
    const cw = lightboxCanvas.width | 0;
    const ch = lightboxCanvas.height | 0;
    const dims = (cw > 1 && ch > 1) ? `  ${cw}×${ch}` : '';
    lbPreviewBadge.textContent = label + dims;
    lbPreviewBadge.setAttribute('data-source', source);
    lbPreviewBadge.hidden = false;
}

// Briefly pulse the centre banner so a toggle press is unmissable.
function flashSourceBanner() {
    if (!lbSourceBanner) return;
    lbSourceBanner.classList.remove('flash');
    // Force reflow so re-adding the class restarts the transition.
    void lbSourceBanner.offsetWidth;
    lbSourceBanner.classList.add('flash');
    clearTimeout(flashSourceBanner._t);
    flashSourceBanner._t = setTimeout(() => lbSourceBanner.classList.remove('flash'), 1200);
}

let _sourceLabelKey = 0;
function showSourceLabel(text) {
    if (!lbSourceLabelEl) return;
    lbSourceLabelEl.textContent = text;
    lbSourceLabelEl.classList.remove('active');
    void lbSourceLabelEl.offsetWidth; // force reflow to restart animation
    _sourceLabelKey++;
    lbSourceLabelEl.dataset.key = _sourceLabelKey;
    lbSourceLabelEl.classList.add('active');
}

// ---------------------------------------------------------------------------
// Lightbox EXIF info panel
// ---------------------------------------------------------------------------
const INFO_COLLAPSED_KEY = 'lb-info-collapsed';
const OLY_WB_MODE = {
    0: 'Auto', 1: 'Auto (Keep Warm Off)',
    16: '7500K Shade', 17: '6000K Cloudy', 18: '5300K Daylight',
    20: '3000K Tungsten', 21: '3600K Tungsten-like',
    22: 'Auto Setup', 23: '5500K Flash',
    33: '6600K Daylight Fluorescent', 34: '4500K Neutral Fluorescent',
    35: '4000K Cool White Fluorescent', 36: 'White Fluorescent',
    48: '3600K Tungsten-like', 67: 'Underwater',
    256: 'One Touch WB 1', 257: 'One Touch WB 2',
    258: 'One Touch WB 3', 259: 'One Touch WB 4',
    512: 'Custom WB 1', 513: 'Custom WB 2',
    514: 'Custom WB 3', 515: 'Custom WB 4',
};
const ORIENTATION_LABEL = {
    1: 'Normal', 2: 'Mirror H', 3: 'Rotate 180°',
    4: 'Mirror V', 5: 'Transpose', 6: 'Rotate 90° CW',
    7: 'Transverse', 8: 'Rotate 90° CCW',
};

function fmtShutter(rat) {
    if (!rat || !rat.d) return null;
    const v = rat.n / rat.d;
    if (v >= 1) return `${v.toFixed(v < 10 ? 1 : 0)} s`;
    // typical fractions — show 1/N rounded to a clean denominator
    const denom = Math.round(1 / v);
    return `1/${denom} s`;
}
function fmtFNumber(rat) {
    if (!rat || !rat.d) return null;
    return `ƒ/${(rat.n / rat.d).toFixed(1)}`;
}
function fmtFocal(rat, eq35) {
    if (!rat || !rat.d) return null;
    const mm = (rat.n / rat.d).toFixed(0);
    return eq35 ? `${mm} mm (≡ ${eq35} mm @ 35mm)` : `${mm} mm`;
}
function fmtDateTime(s) {
    if (!s) return null;
    // EXIF format: "YYYY:MM:DD HH:MM:SS"
    const m = /^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}:\d{2}:\d{2})/.exec(s);
    return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}` : s;
}
function fmtCoord(v, posChar, negChar) {
    if (v == null) return null;
    const abs = Math.abs(v);
    const deg = Math.floor(abs);
    const minF = (abs - deg) * 60;
    const min = Math.floor(minF);
    const sec = ((minF - min) * 60).toFixed(2);
    return `${deg}° ${min}′ ${sec}″ ${v >= 0 ? posChar : negChar}`;
}
function fmtGps(g) {
    if (!g) return null;
    const lat = fmtCoord(g.lat, 'N', 'S');
    const lon = fmtCoord(g.lon, 'E', 'W');
    const alt = g.alt != null ? ` · ${g.alt.toFixed(0)} m` : '';
    return `${lat}, ${lon}${alt}`;
}
function fmtQuality(q) {
    return { 1: 'SQ', 2: 'HQ', 3: 'SHQ', 4: 'RAW', 5: 'RAW+JPEG', 6: 'Compressed RAW' }[q] || null;
}
function fmtWb(exif) {
    if (!exif) return null;
    const mode = exif.wbMode != null ? (OLY_WB_MODE[exif.wbMode] || `mode ${exif.wbMode}`) : null;
    const gains = (exif.wbR != null && exif.wbB != null)
        ? `R ${exif.wbR.toFixed(3)} · B ${exif.wbB.toFixed(3)}`
        : null;
    const source = exif.wbFromCamera ? 'camera' : 'gray-world (auto)';
    return [mode, gains, `via ${source}`].filter(Boolean).join(' · ');
}

function buildInfoRows(card) {
    const ex = card._exif;
    if (!ex) return [];
    const camera = [ex.make, ex.model].filter(Boolean).join(' ').trim() || '—';
    const dim = (ex.width && ex.height) ? `${ex.width} × ${ex.height}` : null;
    return [
        ['Camera',    camera],
        ['Lens',      ex.lens || null],
        ['Date',      fmtDateTime(ex.datetime)],
        ['Shutter',   fmtShutter(ex.exposure)],
        ['Aperture',  fmtFNumber(ex.fnumber)],
        ['ISO',       ex.iso != null ? String(ex.iso) : null],
        ['Focal',     fmtFocal(ex.focalLength, ex.focalLength35)],
        ['GPS',       fmtGps(ex.gps)],
        ['WB',        fmtWb(ex)],
        ['Orientation', ORIENTATION_LABEL[ex.orientation] || (ex.orientation != null ? String(ex.orientation) : null)],
        ['Dimensions', dim],
        ['Format',    'ORF (Olympus 12-bit)'],
        ['Quality',   fmtQuality(ex.quality)],
        ['Pipeline',  card._pipelineMs != null ? `${card._pipelineMs.toFixed(0)} ms` : null],
    ].filter(([_, v]) => v != null);
}

function renderInfoPanel(card) {
    lightboxInfo.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'info-panel';
    if (localStorage.getItem(INFO_COLLAPSED_KEY) === '1') panel.classList.add('collapsed');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'info-toggle';
    toggle.setAttribute('aria-label', 'Toggle EXIF info');
    const updateToggle = () => {
        const collapsed = panel.classList.contains('collapsed');
        toggle.textContent = collapsed ? '▸ info' : '▾ info';
        toggle.setAttribute('aria-expanded', String(!collapsed));
    };
    toggle.addEventListener('click', () => {
        panel.classList.toggle('collapsed');
        localStorage.setItem(INFO_COLLAPSED_KEY, panel.classList.contains('collapsed') ? '1' : '0');
        updateToggle();
    });
    panel.appendChild(toggle);

    const body = document.createElement('dl');
    body.className = 'info-body';
    for (const [label, value] of buildInfoRows(card)) {
        const dt = document.createElement('dt'); dt.textContent = label;
        const dd = document.createElement('dd'); dd.textContent = value;
        body.appendChild(dt); body.appendChild(dd);
    }
    panel.appendChild(body);
    updateToggle();
    lightboxInfo.appendChild(panel);
}

// Background JXL prefetch — keeps RAW on display but stashes decoded JXL
// pixels in card._jxlDecoded so manual toggle / zoom is instant.
const PREFETCH_NEIGHBORS = 2;
function prefetchJxl(card, priority = 'normal') {
    if (!card || !card._blobUrl) return;
    if (card._jxlDecoded) return;
    if (card._jxlPrefetching) return;
    card._jxlPrefetching = true;
    pool.decodeJxl(card._blobUrl, (msg) => {
        if (msg.type === 'decode_error' || msg.type === 'jxl_decoded' || msg.isFinal === true) {
            card._jxlPrefetching = false;
        }
    }, priority, {
        progressive: true,
        cachePolicy: 'onFinal',
        progressiveDetail: 'lastPasses',
        cacheTarget: card,
    });
}
function prefetchAroundCurrent() {
    if (lightboxIndex < 0) return;
    prefetchJxl(cards[lightboxIndex], 'high');
    for (let off = 1; off <= PREFETCH_NEIGHBORS; off++) {
        const a = (lightboxIndex + off + cards.length) % cards.length;
        const b = (lightboxIndex - off + cards.length) % cards.length;
        if (a !== lightboxIndex)             prefetchJxl(cards[a], 'low');
        if (b !== lightboxIndex && b !== a)  prefetchJxl(cards[b], 'low');
    }
}

// Promote the lightboxed card's RAW-pipeline task (and neighbours) to the
// front of the pool queue so the next freed worker picks it up.  If the task
// is already running we can't preempt; if it hasn't been submitted yet (file
// arrayBuffer still pending), stash the priority on the card so submit picks
// it up.
function promoteRawAroundCurrent() {
    if (lightboxIndex < 0) return;
    const setRawPriority = (card, prio) => {
        if (!card) return;
        if (card._taskId != null) pool.setPriority(card._taskId, prio);
        else card._pendingPriority = prio;
        // Tauri side: each promote_file call allocates a fresh ever-decreasing
        // priority on the backend, so the LAST call wins the front of the
        // queue.  Order matters here — neighbours first, current last.
        if (IS_TAURI && card._tauriPath) {
            invoke('promote_file', { path: card._tauriPath }).catch(() => {});
        }
    };
    // Promote neighbours first (lowest urgency), then current LAST.  Backend
    // priority allocation: each call gets a fresher (more negative) priority,
    // so the most recent call jumps ahead of every prior promote.  Without
    // this ordering, the right-arrow target would queue behind the file that
    // was clicked first, defeating the priority bump on navigation.
    for (let off = PREFETCH_NEIGHBORS; off >= 1; off--) {
        const a = (lightboxIndex + off + cards.length) % cards.length;
        const b = (lightboxIndex - off + cards.length) % cards.length;
        if (a !== lightboxIndex)             setRawPriority(cards[a], 'medium');
        if (b !== lightboxIndex && b !== a)  setRawPriority(cards[b], 'medium');
    }
    setRawPriority(cards[lightboxIndex], 'high');
}

// Tauri-only: fetch the larger embedded preview JPEG on demand and swap
// it into card._embeddedPreview so the lightbox shows a high-quality placeholder
// while the RAW pipeline finishes.  No-op if the full RAW lightbox is already
// drawn or a fetch is already pending.
//
// Debounced — spamming right-arrow through unprocessed files would otherwise
// queue a get_large_preview RPC per step.  We wait until the user stays on
// the same card for 80 ms before firing.
let _largePrevDebounceTimer = null;
let _largePrevDebounceTarget = null;
function fetchLargePreviewIfNeeded(card) {
    if (!IS_TAURI || !card || !card._tauriPath) return;
    if (card._largePreviewFetched || card._largePreviewFetching) return;
    if (card._lightbox && card._lightbox.rgb) return; // RAW already there
    _largePrevDebounceTarget = card;
    clearTimeout(_largePrevDebounceTimer);
    _largePrevDebounceTimer = setTimeout(() => {
        if (_largePrevDebounceTarget !== card) return;
        if (card._largePreviewFetched || card._largePreviewFetching) return;
        if (card._lightbox && card._lightbox.rgb) return;
        card._largePreviewFetching = true;
        invoke('get_large_preview', { path: card._tauriPath })
            .then((bytes) => {
                const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
                const orientation = card._embeddedPreview?.orientation || 1;
                return createImageBitmap(new Blob([u8], { type: 'image/jpeg' }))
                    .then(bmp => ({ bmp, orientation }));
            })
            .then(({ bmp, orientation }) => {
                const prev = card._embeddedPreview;
                if (!prev || bmp.width * bmp.height > prev.bmp.width * prev.bmp.height) {
                    if (prev?.bmp && prev.bmp !== bmp) try { prev.bmp.close(); } catch {}
                    card._embeddedPreview = { bmp, w: bmp.width, h: bmp.height, orientation };
                } else {
                    try { bmp.close(); } catch {}
                }
                card._largePreviewFetched = true;
                if (lightboxIndex >= 0 && cards[lightboxIndex] === card &&
                    !(card._lightbox && card._lightbox.rgb)) {
                    drawLightboxForCard(card);
                }
            })
            .catch((e) => { console.warn('get_large_preview failed:', e); })
            .finally(() => { card._largePreviewFetching = false; });
    }, 80);
}

function openLightbox(card) {
    lightboxIndex = cards.indexOf(card);
    lbRotation = card._file?.name ? (userRotations[card._file.name] ?? 0) : 0;
    card._sourceMode = 'raw';
    resetLookSliders();
    // Auto-load sidecar if present
    if (typeof loadSidecar === 'function' && (card._tauriPath || card._file?.name)) {
        const sidecarPath = card._tauriPath || card._file?.name;
        loadSidecar(sidecarPath).then(sidecar => {
            if (sidecar && typeof applySidecar === 'function') applySidecar(sidecar);
            // After sidecar applied, sync sibling cards in the grid and queue
            // JXL-based thumbnail rendering once the JXL is ready.
            if (typeof window.rebuildSubjectCards === 'function') window.rebuildSubjectCards(card);
        });
    }
    // Fresh open → start fitted to viewport. drawLightboxForCard ends with
    // syncZoomToDisplayLong() which will compute fit when lbDisplayLongPx is null.
    lbDisplayLongPx = null;
    lbPanX = 0; lbPanY = 0;
    lightbox.hidden = false;
    drawLightboxForCard(card);
    renderInfoPanel(card);

    // Reset straighten slider to the card's current state (or 0)
    if (lbStraighten) {
        const ang = card._crop?.angle || 0;
        lbStraighten.value = String(ang);
        if (lbStraightenVal) lbStraightenVal.textContent = ang.toFixed(1) + '°';
    }
    // If a crop is saved on this card, fit-to-crop instead of fit-to-image.
    if (card._crop) {
        requestAnimationFrame(() => focusOnRegion(card._crop.x, card._crop.y, card._crop.w, card._crop.h));
    }
    promoteRawAroundCurrent();
    prefetchAroundCurrent();
    fetchLargePreviewIfNeeded(card);

    // Filmstrip (Phase 1)
    if (filmstripEl) {
        filmstripEl.hidden = false;
        // Defer population one frame so cards array and thumbs are stable
        requestAnimationFrame(() => {
            populateFilmstrip();
        });
    }
}

function drawLightbox() {
    const card = cards[lightboxIndex];
    if (!card) return;
    lbRotation = card._file?.name ? (userRotations[card._file.name] ?? 0) : 0;
    drawLightboxForCard(card);
    renderInfoPanel(card);
    refreshFilmstripPrimary();
}

function closeLightbox() {
    lightbox.hidden = true;
    lightboxIndex = -1;
    if (lbPreviewBadge) lbPreviewBadge.hidden = true;
    lbLoadingBadge.hidden = true;
    lbDisplayLongPx = null;
    if (filmstripEl) filmstripEl.hidden = true;
    if (filmstripActions) filmstripActions.hidden = true;
    filmstripSelection.clear();
}

function nextInLightbox(dir) {
    if (lightboxIndex < 0) return;
    // Connected-set traversal: if the user is currently focused on a subject
    // of the active parent card, arrow keys cycle parent + subjects rather
    // than jumping to the next/previous top-level photo. Falling off either
    // end returns to top-level navigation.
    const cur = cards[lightboxIndex];
    if (cur && cur._focusedSubjectId !== undefined && cur._subjects?.length) {
        const ids = [null, ...cur._subjects.map(s => s.id)];
        const at  = ids.indexOf(cur._focusedSubjectId);
        const nextAt = at + dir;
        if (nextAt >= 0 && nextAt < ids.length) {
            const nextId = ids[nextAt];
            cur._focusedSubjectId = nextId;
            if (nextId == null) {
                // Back to full parent — refit zoom to viewport.
                lbDisplayLongPx = null; lbPanX = 0; lbPanY = 0;
                syncZoomToDisplayLong();
            } else {
                focusOnSubject(cur, nextId);
            }
            return;
        }
        // Falling off the connected set → fall through to normal cycle and
        // clear focus.
        cur._focusedSubjectId = undefined;
    }
    lightboxIndex = (lightboxIndex + dir + cards.length) % cards.length;
    const card = cards[lightboxIndex];
    if (card) card._sourceMode = 'raw';
    liveInFlight = false;
    livePendingLook = null;
    resetLookSliders();
    // New image → start fitted to viewport.
    lbDisplayLongPx = null;
    lbPanX = 0; lbPanY = 0;
    drawLightbox();
    promoteRawAroundCurrent();
    prefetchAroundCurrent();
    if (card) fetchLargePreviewIfNeeded(card);
    refreshFilmstripPrimary();

    if (lbStraighten && card) {
        const ang = card._crop?.angle || 0;
        lbStraighten.value = String(ang);
        if (lbStraightenVal) lbStraightenVal.textContent = ang.toFixed(1) + '°';
    }
}

/**
 * Apply straighten (angle + rect in original space) to the current lightbox canvas content.
 * This is a post-process step that works for any source mode (RAW, JXL decoded, embedded JPEG).
 * v1 uses canvas 2D transforms + drawImage (high quality). Not pixel-perfect for extreme angles
 * but excellent for real-world straighten (-15°..+15°).
 */
function applyStraightenToLightboxCanvas(card) {
    const crop = card?._crop;
    if (!crop || !crop.angle || !lightboxCanvas.width || !lightboxCanvas.height) return;

    const angleRad = (crop.angle || 0) * Math.PI / 180;
    const srcW = lightboxCanvas.width;
    const srcH = lightboxCanvas.height;

    // Work on a temp canvas with the rotated + cropped result
    const tmp = document.createElement('canvas');
    const ctx = tmp.getContext('2d', { willReadFrequently: false });

    // We want the final output to respect the crop rect aspect if possible.
    // For simplicity in v1: rotate the full current content, then extract a centered rect
    // of the original canvas aspect (or the stored ratio if present).
    // This gives the "straightened and cropped to largest good rect" feel.
    const c = Math.cos(angleRad);
    const s = Math.sin(angleRad);

    // Bounding box after rotation of the current canvas
    const hw = srcW / 2, hh = srcH / 2;
    const corners = [[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].map(([x,y]) => [c*x - s*y, s*x + c*y]);
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    for (const [x,y] of corners) { minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y); }
    const rotW = maxX - minX;
    const rotH = maxY - minY;

    // Choose output size — keep similar long edge for visual continuity
    const outLong = Math.max(srcW, srcH);
    let outW = outLong, outH = outLong;
    if (crop.ratio && crop.ratio !== 'free') {
        const r = (crop.ratio === 'original') ? (srcW / srcH) : (ASPECT_VALUES[crop.ratio] || 1);
        if (rotW / rotH > r) { outW = rotH * r; outH = rotH; } else { outH = rotW / r; outW = rotW; }
    } else {
        outW = rotW; outH = rotH;
    }
    // Scale to reasonable display size
    const scale = Math.min(1, outLong / Math.max(outW, outH));
    tmp.width = Math.max(1, Math.round(outW * scale));
    tmp.height = Math.max(1, Math.round(outH * scale));

    ctx.save();
    ctx.translate(tmp.width/2, tmp.height/2);
    ctx.rotate(angleRad);
    // Draw the original canvas centered, scaled so the rotated content fits nicely
    const drawScale = Math.min(tmp.width / rotW, tmp.height / rotH);
    ctx.drawImage(lightboxCanvas, -srcW/2 * drawScale, -srcH/2 * drawScale, srcW * drawScale, srcH * drawScale);
    ctx.restore();

    // Now copy back to the main lightbox canvas (this becomes the new "source" for this view)
    lightboxCanvas.width = tmp.width;
    lightboxCanvas.height = tmp.height;
    const outCtx = lightboxCanvas.getContext('2d');
    outCtx.drawImage(tmp, 0, 0);

    try {
        captureCleanAndApplyLens(outCtx.getImageData(0, 0, tmp.width, tmp.height));
    } catch {}
}

// ---------------------------------------------------------------------------
// Filmstrip (Phase 1) — lightweight bottom row for navigation + future multi-select
// ---------------------------------------------------------------------------
function initFilmstrip() {
    filmstripEl = document.getElementById('lightbox-filmstrip');
    filmstripScroll = document.getElementById('filmstrip-scroll');
    filmstripActions = document.getElementById('filmstrip-actions');
    if (!filmstripEl || !filmstripScroll) return;

    // Resize handle: drag up/down to change filmstrip height (thumbs scale via CSS var)
    const resizeHandle = document.getElementById('filmstrip-resize-handle');
    if (resizeHandle) {
        let startY = 0, startH = 0;
        resizeHandle.addEventListener('pointerdown', e => {
            e.preventDefault();
            startY = e.clientY;
            startH = filmstripEl.offsetHeight;
            resizeHandle.setPointerCapture(e.pointerId);
        });
        resizeHandle.addEventListener('pointermove', e => {
            if (!resizeHandle.hasPointerCapture(e.pointerId)) return;
            const dy = startY - e.clientY; // drag up → increase height
            const newH = Math.max(60, Math.min(320, startH + dy));
            filmstripEl.style.setProperty('--filmstrip-h', newH + 'px');
        });
    }

    // Selection count + apply button (wired in P1-4/P1-5)
    const applyBtn = document.getElementById('filmstrip-apply-selection');
    if (applyBtn) {
        applyBtn.addEventListener('click', () => {
            applyLookToFilmstripSelection();
        });
    }
}

function updateFilmstripSelectionUI() {
    if (!filmstripScroll) return;
    const countEl = document.getElementById('filmstrip-selection-count');
    const hasSel = filmstripSelection.size > 1; // only show powerful batch UI when 2+
    if (filmstripActions) filmstripActions.hidden = !hasSel;
    if (countEl) countEl.textContent = filmstripSelection.size;

    // Update visual state on all thumbs
    filmstripScroll.querySelectorAll('.filmstrip-thumb').forEach((thumb, idx) => {
        const isSel = filmstripSelection.has(idx);
        const isPrimary = idx === lightboxIndex;
        thumb.classList.toggle('selected', isSel);
        thumb.classList.toggle('primary', isPrimary);
        // Simple numeric badge for multi-select
        let badge = thumb.querySelector('.sel-badge');
        if (isSel && filmstripSelection.size > 1) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'sel-badge';
                thumb.appendChild(badge);
            }
            badge.textContent = [...filmstripSelection].indexOf(idx) + 1;
        } else if (badge) {
            badge.remove();
        }
    });
}

function populateFilmstrip() {
    if (!filmstripScroll || !cards || cards.length === 0) return;
    filmstripScroll.innerHTML = '';
    filmstripSelection.clear();
    filmstripLastClicked = lightboxIndex;

    cards.forEach((card, idx) => {
        const thumb = document.createElement('div');
        thumb.className = 'filmstrip-thumb';
        thumb.dataset.index = String(idx);

        // Best-effort thumbnail source (reuse existing thumb canvas content if present)
        const srcCanvas = card.querySelector('canvas');
        if (srcCanvas) {
            const img = document.createElement('img');
            try {
                img.src = srcCanvas.toDataURL('image/jpeg', 0.7);
            } catch {
                img.style.background = '#222';
            }
            thumb.appendChild(img);
        } else {
            // Fallback colored box with filename hint
            thumb.style.background = idx % 2 ? '#1f2937' : '#111827';
            const label = document.createElement('div');
            label.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:9px;opacity:.6;color:#9ca3af;overflow:hidden;padding:2px;text-align:center';
            label.textContent = (card._file?.name || 'img').replace(/\.[^.]+$/, '').slice(-8);
            thumb.appendChild(label);
        }

        thumb.addEventListener('click', (e) => {
            const targetIdx = Number(thumb.dataset.index);
            if (e.shiftKey && filmstripLastClicked >= 0) {
                // Range select
                const [a, b] = [filmstripLastClicked, targetIdx].sort((x,y)=>x-y);
                for (let i = a; i <= b; i++) filmstripSelection.add(i);
            } else if (e.ctrlKey || e.metaKey) {
                // Toggle
                if (filmstripSelection.has(targetIdx)) filmstripSelection.delete(targetIdx);
                else filmstripSelection.add(targetIdx);
            } else {
                // Plain click = jump + clear other selection (standard single-select behavior)
                filmstripSelection.clear();
                filmstripSelection.add(targetIdx);
                // Jump the main lightbox view
                if (targetIdx !== lightboxIndex && cards[targetIdx]) {
                    lightboxIndex = targetIdx;
                    const targetCard = cards[targetIdx];
                    targetCard._sourceMode = targetCard._sourceMode || 'raw';
                    lbDisplayLongPx = null; lbPanX = 0; lbPanY = 0;
                    drawLightbox();
                    promoteRawAroundCurrent();
                    prefetchAroundCurrent();
                    if (targetCard) fetchLargePreviewIfNeeded(targetCard);
                }
            }
            filmstripLastClicked = targetIdx;
            updateFilmstripSelectionUI();
        });

        // Double-click always jumps (even in multi-select mode)
        thumb.addEventListener('dblclick', () => {
            const targetIdx = Number(thumb.dataset.index);
            if (cards[targetIdx]) {
                lightboxIndex = targetIdx;
                const c = cards[targetIdx];
                c._sourceMode = c._sourceMode || 'raw';
                lbDisplayLongPx = null; lbPanX = 0; lbPanY = 0;
                drawLightbox();
            }
        });

        filmstripScroll.appendChild(thumb);
    });

    // Prime primary highlight
    updateFilmstripSelectionUI();
}

function refreshFilmstripPrimary() {
    // Called from drawLightbox / nextInLightbox so the strip stays in sync
    if (!filmstripScroll) return;
    filmstripScroll.querySelectorAll('.filmstrip-thumb').forEach((t, i) => {
        t.classList.toggle('primary', i === lightboxIndex);
    });
}

// Called when look changes while filmstrip multi-select is active
function applyLookToFilmstripSelection() {
    if (filmstripSelection.size === 0) return;
    const look = typeof currentLook === 'function' ? currentLook() : null;
    if (!look) return;

    const indices = [...filmstripSelection];
    const taskIds = [];
    indices.forEach(i => {
        const c = cards[i];
        if (c && c._taskId) taskIds.push(c._taskId);
        // Also update any live state on the card objects themselves (for gallery)
        if (c) c._pendingLookBatch = { ...look };
    });

    // Reuse the existing live machinery (best effort)
    if (typeof pool !== 'undefined' && pool.reprocessAllLive && taskIds.length) {
        pool.reprocessAllLive(taskIds, look);
    } else if (typeof scheduleGalleryLiveUpdate === 'function') {
        // Fallback: will at least update visible gallery thumbs
        scheduleGalleryLiveUpdate();
    }

    // On Tauri we also want sidecars written for the selected files
    if (window.IS_TAURI) {
        indices.forEach(i => {
            const c = cards[i];
            const fname = c?._tauriPath || c?._file?.name;
            if (fname && typeof window.saveSidecar === 'function') {
                // saveSidecar reads current global look + the card's crop/subjects
                window.saveSidecar(fname).catch(() => {});
            }
        });
    }
}

// Toolbar buttons
lbZoomIn.addEventListener('click', () => {
    const vp = lbViewport.getBoundingClientRect();
    zoomAtPoint(vp.left + vp.width / 2, vp.top + vp.height / 2, LB_ZOOM_STEP);
});
lbZoomOut.addEventListener('click', () => {
    const vp = lbViewport.getBoundingClientRect();
    zoomAtPoint(vp.left + vp.width / 2, vp.top + vp.height / 2, 1 / LB_ZOOM_STEP);
});
lbZoomReset.addEventListener('click', resetLbZoom);

// Keep displayed size honest across viewport resizes. If the user was at fit,
// stay at fit (long-edge tracks the new viewport); otherwise leave lbZoom alone
// so absolute displayed-pixel size is preserved.
let _lbResizeRaf = 0;
window.addEventListener('resize', () => {
    if (lightbox.hidden || lightbox.classList.contains('peep-mode')) return;
    if (_lbResizeRaf) return;
    _lbResizeRaf = requestAnimationFrame(() => {
        _lbResizeRaf = 0;
        const canvasLong = _lbCanvasLongPx();
        if (canvasLong == null) return;
        const prevFit = _lbFitZoom();
        const wasAtFit = Math.abs(lbZoom - prevFit) < 0.005;
        if (wasAtFit) fitLbZoom();
        // else: preserve absolute displayed-pixel size (lbZoom unchanged).
    });
});

if (lbToggleJpegBtn) {
    lbToggleJpegBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (lightboxIndex < 0) return;
        cycleSourceForCard(cards[lightboxIndex], 1);
    });
}

// Download full-res from lightbox canvas
lbDownloadBtn.addEventListener('click', () => {
    const card = cards[lightboxIndex];
    if (!card) return;
    const stem = (card._file?.name || 'image').replace(/\.(orf|cr2|dng)$/i, '');
    lightboxCanvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = stem + '-fullres.jpg'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }, 'image/jpeg', 0.95);
});

// Straighten slider (Phase 2) — immediate visual feedback using the geometry + render path
if (lbStraighten) {
    lbStraighten.addEventListener('input', () => {
        const card = cards[lightboxIndex];
        if (!card) return;
        const angle = parseFloat(lbStraighten.value) || 0;
        if (lbStraightenVal) lbStraightenVal.textContent = angle.toFixed(1) + '°';

        // Create or update the crop descriptor with the angle
        const existing = card._crop || { x: 0.05, y: 0.05, w: 0.9, h: 0.9, ratio: 'free' };
        card._crop = {
            ...existing,
            angle,
            inOriginalSpace: true
        };
        // Re-paint with the new straighten applied (the helper we added earlier will run)
        drawLightboxForCard(card);
        // Sidecar written on crop tool Apply or other explicit save paths (keeps noise low during live slider)
    });
}
if (lbStraightenAuto) {
    lbStraightenAuto.addEventListener('click', () => {
        const card = cards[lightboxIndex];
        if (!card || !lightboxCanvas.width || !lightboxCanvas.height) return;
        const currentAngle = card._crop?.angle || 0;
        const ratio = card._crop?.ratio || 'free';
        const newCrop = computeStraightenCrop(lightboxCanvas.width, lightboxCanvas.height, currentAngle, ratio);
        if (newCrop) {
            card._crop = newCrop;
            if (lbStraighten) lbStraighten.value = String(newCrop.angle || 0);
            if (lbStraightenVal) lbStraightenVal.textContent = (newCrop.angle || 0).toFixed(1) + '°';
            drawLightboxForCard(card);
            // Sidecar written on explicit save paths
        }
    });
}

// Scroll-wheel / trackpad zoom — proportional to deltaY so trackpad feels
// smooth and deliberate while a mouse-wheel click still gives a meaningful step.
// deltaMode 0 = pixels (trackpad), 1 = lines (mouse wheel), 2 = pages.
lbViewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 20;   // lines → pixel-equivalent
    if (e.deltaMode === 2) dy *= 300;  // pages → pixel-equivalent
    dy = Math.max(-200, Math.min(200, dy)); // cap runaway values
    zoomAtPoint(e.clientX, e.clientY, Math.exp(-dy * 0.003));
}, { passive: false });

// Mouse drag to pan
let lbDragging = false;
let lbDragLast = { x: 0, y: 0 };
lbViewport.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    // Don't initiate pan when clicking inside panels (sliders, handles, chips, etc.)
    if (e.target.closest('.lb-panels')) return;
    lbDragging = true;
    lbDragLast = { x: e.clientX, y: e.clientY };
    lbViewport.classList.add('dragging');
    e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
    if (!lbDragging) return;
    lbPanX += e.clientX - lbDragLast.x;
    lbPanY += e.clientY - lbDragLast.y;
    lbDragLast = { x: e.clientX, y: e.clientY };
    applyLbTransform();
});
window.addEventListener('mouseup', () => {
    if (!lbDragging) return;
    lbDragging = false;
    lbViewport.classList.remove('dragging');
});

// Pinch-to-zoom + single-finger pan (touch)
let lbTouchPan = null;
let lbPinchStart = { dist: 0, mx: 0, my: 0 };
lbViewport.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
        lbTouchPan = null;
        const t0 = e.touches[0], t1 = e.touches[1];
        lbPinchStart = {
            dist: Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY),
            mx: (t0.clientX + t1.clientX) / 2,
            my: (t0.clientY + t1.clientY) / 2,
        };
    } else if (e.touches.length === 1) {
        lbTouchPan = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    e.preventDefault();
}, { passive: false });

lbViewport.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
        const t0 = e.touches[0], t1 = e.touches[1];
        const newDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
        const mx = (t0.clientX + t1.clientX) / 2;
        const my = (t0.clientY + t1.clientY) / 2;
        if (lbPinchStart.dist > 0) {
            zoomAtPoint(mx, my, newDist / lbPinchStart.dist);
        }
        lbPinchStart = { dist: newDist, mx, my };
    } else if (e.touches.length === 1 && lbTouchPan) {
        lbPanX += e.touches[0].clientX - lbTouchPan.x;
        lbPanY += e.touches[0].clientY - lbTouchPan.y;
        lbTouchPan = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        applyLbTransform();
    }
    e.preventDefault();
}, { passive: false });

lbViewport.addEventListener('touchend', () => { lbTouchPan = null; });

lightboxClose.addEventListener('click', () => pixelPeepActive ? exitPixelPeep() : closeLightbox());
lightboxPrev.addEventListener('click', () => pixelPeepActive ? peepNavPhoto(-1) : nextInLightbox(-1));
lightboxNext.addEventListener('click', () => pixelPeepActive ? peepNavPhoto(1)  : nextInLightbox(1));
lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) {
        if (pixelPeepActive) exitPixelPeep(); else closeLightbox();
    }
});

document.addEventListener('keydown', (e) => {
    // Colour profile shortcuts
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        // TODO: replace with custom dialog in Tauri (prompt() may behave differently)
        const name = prompt('Save profile as:');
        if (name && typeof saveCurrentAsProfile === 'function') saveCurrentAsProfile(name);
        return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'L') {
        if (!lightbox.hidden) {
            e.preventDefault();
            if (typeof togglePanel === 'function') togglePanel('c');
        }
        return;
    }
    const slotMatch = (e.ctrlKey || e.metaKey) && e.shiftKey && /^[0-9]$/.test(e.key);
    if (slotMatch) {
        e.preventDefault();
        const idx = e.key === '0' ? 9 : parseInt(e.key, 10) - 1;
        if (typeof loadUserProfileByIndex === 'function') loadUserProfileByIndex(idx);
        return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 's') {
        e.preventDefault();
        if (!lightbox.hidden) {
            const card = cards[lightboxIndex];
            const sidecarPath = card?._tauriPath || card?._file?.name;
            if (sidecarPath && typeof saveSidecar === 'function') saveSidecar(sidecarPath);
        }
        return;
    }

    // Ctrl/Cmd+A — select/deselect all thumbnails (global, any state)
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        const allSelected = cards.length > 0 && cards.every(c => c.classList.contains('selected'));
        for (const card of cards) {
            card.classList.toggle('selected', !allSelected);
            card.querySelector('.thumb-select').textContent = allSelected ? '·' : '✓';
        }
        refreshReprocessLabel();
        scheduleGalleryLiveUpdate();
        return;
    }

    // Digit keys 1-9, 0 → apply preset slot 0-9 (0 = slot 9 = "10th button")
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const digit = e.key >= '1' && e.key <= '9' ? Number(e.key) - 1
                    : e.key === '0' ? 9 : -1;
        if (digit >= 0 && presets[digit]) {
            e.preventDefault();
            applyLookValues(presets[digit].look);
            return;
        }
    }

    if (lightbox.hidden) return;

    // Pixel-peep mode: intercept arrows, Esc, source-toggle/rotate hotkeys.
    // Zoom keys (+/-/0) and wheel/drag pan fall through to existing handlers.
    if (pixelPeepActive) {
        if (e.key === 'Escape')     { e.preventDefault(); exitPixelPeep();      return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); peepNavPhoto(1);      return; }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); peepNavPhoto(-1);     return; }
        if (e.key === 'ArrowUp')    { e.preventDefault(); peepCycleQuality(1);  return; }
        if (e.key === 'ArrowDown')  { e.preventDefault(); peepCycleQuality(-1); return; }
        // Block stale handlers from acting on no-card state.
        if (e.key === ' ' || e.code === 'Space' || /^[rRlLhHcCfF]$/.test(e.key)) {
            e.preventDefault();
            return;
        }
        // Let +/-/0 zoom keys through.
    }

    // B&W quick-select (Ctrl+1–9 / Ctrl+0, lightbox only)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        if (e.key === '0') {
            if (typeof setActiveFilter === 'function') setActiveFilter(null);
        } else {
            const bwIdx = parseInt(e.key, 10) - 1;
            if (typeof setActiveFilter === 'function') setActiveFilter(window.BW_NAMES[bwIdx]);
        }
        return;
    }
    // Don't hijack typing in form controls (sliders, number inputs, prompts).
    const tag = (e.target && e.target.tagName) || '';
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (!isInput && (e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (typeof togglePanel === 'function') togglePanel('h');
        return;
    }
    if (!isInput && (e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (typeof togglePanel === 'function') togglePanel('c');
        return;
    }
    if (!isInput && (e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (typeof togglePanel === 'function') togglePanel('f');
        return;
    }
    if (e.key === 'Escape') {
        // If a subject is focused, clear focus and refit parent first; only
        // close the lightbox when there's no subject context to back out of.
        const cur = cards[lightboxIndex];
        if (cur && cur._focusedSubjectId) {
            cur._focusedSubjectId = undefined;
            lbDisplayLongPx = null; lbPanX = 0; lbPanY = 0;
            syncZoomToDisplayLong();
            e.preventDefault();
            return;
        }
        closeLightbox();
    }
    else if (!isInput && (e.key === 'r' || e.key === 'R')) rotateBy(90);
    else if (!isInput && (e.key === 'l' || e.key === 'L')) rotateBy(-90);
    else if (!isInput && (e.key === ' ' || e.code === 'Space')) {
        e.preventDefault();
        if (lightboxIndex >= 0) cycleSourceForCard(cards[lightboxIndex], 1);
    }
    else if (e.key === 'ArrowRight') nextInLightbox(1);
    else if (e.key === 'ArrowLeft') nextInLightbox(-1);
    else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (lightboxIndex >= 0) cycleSourceForCard(cards[lightboxIndex], 1);
    }
    else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (lightboxIndex >= 0) cycleSourceForCard(cards[lightboxIndex], -1);
    }
    else if (e.key === '=' || e.key === '+') {
        const vp = lbViewport.getBoundingClientRect();
        zoomAtPoint(vp.left + vp.width / 2, vp.top + vp.height / 2, LB_ZOOM_STEP);
    } else if (e.key === '-') {
        const vp = lbViewport.getBoundingClientRect();
        zoomAtPoint(vp.left + vp.width / 2, vp.top + vp.height / 2, 1 / LB_ZOOM_STEP);
    } else if (e.key === '0') {
        resetLbZoom();
    } else if (!isInput && (e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        document.getElementById('pl-lens-toggle')?.click();
    }
});

// ---------------------------------------------------------------------------
// Perceptual Lens controls + colour-select click handler
// ---------------------------------------------------------------------------
{
    const toggleBtn   = document.getElementById('pl-lens-toggle');
    const strengthEl  = document.getElementById('pl-strength');
    const lightnessEl = document.getElementById('pl-lightness');
    const toleranceEl = document.getElementById('pl-tolerance');
    const clearBtn    = document.getElementById('pl-clear');

    let lensDebounce = null;
    function scheduleLensApply() {
        clearTimeout(lensDebounce);
        lensDebounce = setTimeout(() => applyPerceptualLens(), 80);
    }

    toggleBtn?.addEventListener('click', () => {
        perceptualLens.active = !perceptualLens.active;
        toggleBtn.classList.toggle('pl-active', perceptualLens.active);
        if (!perceptualLens.active) {
            colourSelect.mask = null;
            colourSelect.seeds = [];
            colourSelect.labBuf = null;
        }
        applyPerceptualLens();
    });

    strengthEl?.addEventListener('input', () => {
        perceptualLens.strength = parseFloat(strengthEl.value);
        scheduleLensApply();
    });

    lightnessEl?.addEventListener('change', () => {
        perceptualLens.lightness = lightnessEl.checked;
        scheduleLensApply();
    });

    toleranceEl?.addEventListener('input', () => {
        colourSelect.tolerance = parseInt(toleranceEl.value, 10);
        if (colourSelect.seeds.length && colourSelect.labBuf) {
            const w = lightboxCanvas.width, h = lightboxCanvas.height;
            let mask = null;
            for (const seed of colourSelect.seeds) {
                const m = selectByColour(colourSelect.labBuf, w, h, seed, colourSelect.tolerance);
                mask = mask ? unionMask(mask, m) : m;
            }
            colourSelect.mask = mask;
            refreshSelectionOverlay();
        }
    });

    clearBtn?.addEventListener('click', () => {
        colourSelect.mask = null;
        colourSelect.seeds = [];
        colourSelect.labBuf = null;
        const readout = document.getElementById('pl-probe-readout');
        if (readout) readout.textContent = '';
        refreshSelectionOverlay();
    });

    // "Open img" — load any image file directly into lightbox for lens/selector testing
    const imgFileInput = document.getElementById('pl-image-input');
    document.getElementById('pl-load-image')?.addEventListener('click', () => imgFileInput?.click());
    imgFileInput?.addEventListener('change', async () => {
        const file = imgFileInput.files?.[0];
        if (!file) return;
        imgFileInput.value = '';
        try {
            const bmp = await createImageBitmap(file);
            const MAX = 1800;
            const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
            const w = Math.round(bmp.width * scale);
            const h = Math.round(bmp.height * scale);
            lightboxCanvas.width  = w;
            lightboxCanvas.height = h;
            const ctx = lightboxCanvas.getContext('2d');
            ctx.drawImage(bmp, 0, 0, w, h);
            bmp.close();
            lightbox.hidden = false;
            lightboxIndex = -1;
            lbDisplayLongPx = null; lbPanX = 0; lbPanY = 0; lbRotation = 0;
            syncZoomToDisplayLong();
            captureCleanAndApplyLens(ctx.getImageData(0, 0, w, h));
        } catch (err) {
            console.error('pl-load-image failed:', err);
        }
    });

    // Click-to-probe / Ctrl+click to add region — only fires when lens active and no drag occurred
    let plDragDist = 0, plDragTracking = false;
    lbViewport.addEventListener('mousedown', () => { plDragDist = 0; plDragTracking = true; }, true);
    window.addEventListener('mouseup', () => { plDragTracking = false; }, true);
    window.addEventListener('mousemove', (e) => {
        if (plDragTracking) plDragDist += Math.hypot(e.movementX, e.movementY);
    }, true);
    lbViewport.addEventListener('click', (e) => {
        if (!perceptualLens.active || plDragDist > 8) return;
        if (e.target.closest('.lb-panels, #pl-controls')) return;
        handleLensClick(e);
    });
}

// ---------------------------------------------------------------------------
// Re-process — applies current look-controls to either selected cards or all.
// ---------------------------------------------------------------------------
function reprocessSelected() {
    const selected = cards.filter((c) => c.classList.contains('selected') && c._file);
    const targets = selected.length ? selected : cards.filter((c) => c._file);
    if (!targets.length) return;
    const ls = lookInputs
        .filter((el) => Number(el.value) !== 0)
        .map((el) => `${el.dataset.look}=${el.value}`)
        .join(' ');
    pushStat(`--- reprocess (${targets.length}) ${ls || '(all zero)'} ---`);
    for (const card of targets) startConvert(card._file, card);
}

// ---------------------------------------------------------------------------
// Tauri native code paths
// ---------------------------------------------------------------------------
function lookToSnake(look) {
    return {
        exposure_ev: look.exposureEv,
        contrast:    look.contrast,
        highlights:  look.highlights,
        shadows:     look.shadows,
        whites:      look.whites,
        blacks:      look.blacks,
        saturation:  look.saturation,
        vibrance:    look.vibrance,
        temp:        look.temp,
        tint:        look.tint,
        texture:     look.texture,
        clarity:     look.clarity,
    };
}

function rgbToRgbaArr(rgb) {
    // Same fast packer as rgbToRgba (one Uint32 store per pixel, ~4x fewer
    // stores than the byte-wise form). Derives n from the RGB24 length so the
    // existing single-arg call sites (decoded-frame paint paths) are unchanged.
    // Little-endian => 0xFFBBGGRR; alpha fixed at 255. Byte-identical output.
    const n = (rgb.length / 3) | 0;
    const buf = new ArrayBuffer(n * 4);
    const rgba = new Uint8ClampedArray(buf);
    const u32 = new Uint32Array(buf);
    for (let i = 0, p = 0; i < n; i++, p += 3) {
        u32[i] = (rgb[p]) | (rgb[p + 1] << 8) | (rgb[p + 2] << 16) | 0xFF000000;
    }
    return rgba;
}

const cardByFilename = new Map();

function findTauriCard(path) {
    // Keyed on the full path — see cardByFilename note in startBatchTauri.
    return cardByFilename.get(path);
}

let tauriStatSeq = 0;
// Batch-wide timing accumulators for the rollups the user asked for:
// "N thumbs built in Xs, avg Y ms" / "first encode at +Xs, last at +Ys, Z files/s".
let batchT0 = null;
let thumbCount = 0;
let firstEncodeT = null;
let lastEncodeT  = null;
let encodeMsSum = 0;
function resetBatchCounters() {
    batchT0 = performance.now();
    thumbCount = 0;
    firstEncodeT = null;
    lastEncodeT  = null;
    encodeMsSum = 0;
    tauriStatSeq = 0;
}
function updateBatchRollups(encodeMs) {
    const now = performance.now();
    thumbCount++;
    encodeMsSum += encodeMs || 0;
    if (firstEncodeT === null) firstEncodeT = now;
    lastEncodeT = now;
    const dt = (now - batchT0) / 1000;
    const avgThumbMs = ((now - batchT0) / thumbCount).toFixed(0);
    updateStat('rollup:thumbs',
        `[thumbs]  ${String(thumbCount).padStart(3,' ')} built  total ${dt.toFixed(1)}s  avg ${avgThumbMs} ms/file`);
    const firstDt = ((firstEncodeT - batchT0) / 1000).toFixed(1);
    const lastDt  = ((lastEncodeT  - batchT0) / 1000).toFixed(1);
    const throughput = thumbCount / Math.max(0.001, (now - batchT0) / 1000);
    const avgEnc = (encodeMsSum / thumbCount).toFixed(0);
    updateStat('rollup:encode',
        `[encode]  first +${firstDt}s  last +${lastDt}s  ` +
        `avg ${avgEnc} ms/file  throughput ${throughput.toFixed(2)} files/s`);
}

function onFileDoneTauri(path, result) {
    // cardByFilename is keyed on the full path (collision-resistant): two folders
    // can hold the same basename. `filename` is the basename, used only for the
    // display labels below.
    const card = cardByFilename.get(path);
    if (!card) return;
    const filename = path.split(/[\\/]/).pop();
    card.classList.remove('busy');

    // Drop any stale JXL bitmap from a prior process so the new RAW thumb
    // doesn't get masked by a redrawThumbRotated call that prefers the cache.
    if (card._jxlThumbBmp) {
        try { card._jxlThumbBmp.close(); } catch {}
        card._jxlThumbBmp = null;
    }
    // Defensive paint — surface failures instead of leaving a black canvas.
    try {
        if (!result || !result.thumb) {
            throw new Error('result.thumb missing — IPC returned ' + JSON.stringify(Object.keys(result || {})));
        }
        const { data, width, height } = result.thumb;
        if (!data || !width || !height) {
            throw new Error(`thumb fields invalid: w=${width} h=${height} dataLen=${data?.length}`);
        }
        const canvas = card.querySelector('canvas');
        if (canvas) {
            canvas.width = width; canvas.height = height;
            canvas.getContext('2d').putImageData(
                new ImageData(rgbToRgbaArr(data), width, height), 0, 0);
        }
        // RAW-pipeline thumb is in place; clear the embedded-source label.
        card.classList.remove('embedded-thumb');
        setThumbSource(card, null);
    } catch (e) {
        console.error('[tauri-thumb] paint failed for', filename, e);
        card.classList.add('error');
        const tEl = card.querySelector('.time');
        if (tEl) tEl.textContent = 'paint: ' + (e.message || e);
    }
    card._tauriResult = result;

    // Tauri-only: ship dims now, fetch pixels lazily via get_lightbox(id) on
    // first lightbox open.  Cuts per-file IPC payload by ~30 MB JSON, which
    // benchmark showed is the dominant batch-queue gap.  card._lightbox stays
    // truthy so existing _lightbox checks (havePair, raw-mode gating) work.
    if (typeof result?.lightbox_width === 'number' && result?.id != null) {
        card._lightbox = {
            rgb: null,
            w: result.lightbox_width,
            h: result.lightbox_height,
            id: result.id,
            fetching: false,
        };
    }

    // Wire JXL blob URL so toggle/decode pipeline works in Tauri mode too.
    if (result?.jxl && (result.jxl.length || result.jxl.byteLength)) {
        const jxlBytes = typeof result.jxl === 'string'
            ? Uint8Array.from(atob(result.jxl), c => c.charCodeAt(0))
            : (result.jxl instanceof Uint8Array ? result.jxl : new Uint8Array(result.jxl));
        const blob = new Blob([jxlBytes], { type: 'image/jxl' });
        if (card._blobUrl) URL.revokeObjectURL(card._blobUrl);
        card._blobUrl = URL.createObjectURL(blob);
        card._jxlDecoded = null;
        const dlBtn = card.querySelector('.thumb-dl-btn');
        if (dlBtn) dlBtn.hidden = false;
        refreshThumbToggleButton(card);
        updateToggleButtonState(card);
        // Repaint thumb from the JXL roundtrip so the grid shows JXL output.
        repaintThumbFromJxl(card);
        // Subject sibling cards: render their thumbs now that JXL is ready.
        if (card._subjects?.length && typeof window.renderSubjectThumb === 'function') {
            window.renderSubjectThumb(card).catch(() => {});
        }
    }

    // If user is already viewing this card in the lightbox, kick the lazy
    // fetch + redraw now so they see the full-quality version instead of
    // staying on the embedded preview placeholder.
    if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
        drawLightboxForCard(card);
    }

    // Tauri-side per-file stat line.  `enc` (native libjxl) — distinct from
    // the WASM build's `jxl` so the source is obvious in pasted logs.
    const t = result?.timings || {};
    const exif = result?.exif || {};
    const pipeMs = (t.decompress_ms || 0) + (t.demosaic_ms || 0) + (t.tone_ms || 0);
    const totalMs = pipeMs + (t.encode_ms || 0);
    // Show the real sensor dimensions, not the downscaled lightbox.
    const imgW = exif.width  ?? result?.lightbox_width  ?? '?';
    const imgH = exif.height ?? result?.lightbox_height ?? '?';
    tauriStatSeq++;
    const name = filename.padEnd(18, ' ').slice(0, 18);
    pushStat(
        `[${String(tauriStatSeq).padStart(3, ' ')}] ${name} ${imgW}×${imgH}  ` +
        `dec ${fmtMs(t.decompress_ms)}  ` +
        `dem ${fmtMs(t.demosaic_ms)}  ` +
        `tone ${fmtMs(t.tone_ms)}  ` +
        `pipe ${fmtMs(pipeMs)}  ` +
        `enc ${fmtMs(t.encode_ms)}  ` +
        `out ${fmtKb(result?.jxl?.byteLength || result?.jxl?.length || 0)}`,
    );

    // Replace the stuck "encoding" label with the final timing.
    const tEl = card.querySelector('.time');
    if (tEl) tEl.textContent = `${(totalMs / 1000).toFixed(1)}s`;
    if (exif.wb_r != null && exif.wb_b != null) {
        bumpWbMatrix(`wb R${exif.wb_r.toFixed(3)} B${exif.wb_b.toFixed(3)}`,
                     exif.wb_from_camera ? 'mn-matrix' : 'fallback-matrix');
    }
    updateBatchRollups(t.encode_ms);
}

async function startBatchTauri(paths) {
    const opts = currentOptions();
    pushStat(`[mode]  tauri (native libjxl)  ${paths.length} files queued`);
    resetBatchCounters();
    const batchT0 = performance.now();
    let firstJxlT = null;   // time of first "encoding" event (first thumb done → JXL starts)
    let lastJxlT  = null;   // time of last  "encoding" event (last  thumb done → JXL starts)
    let thumbCount = 0;

    for (const path of paths) {
        const filename = path.split(/[\\/]/).pop();
        const card = makeCard(filename);
        card._file = { name: filename };
        card._tauriPath = path;
        // Key on the full path, not the basename — distinct folders can hold the
        // same filename, and a basename key would silently collide (one card
        // shadowing the other in every findTauriCard / onFileDoneTauri lookup).
        cardByFilename.set(path, card);
        cards.push(card);
        grid.appendChild(card);
        if (typeof loadSidecar === 'function') {
            loadSidecar(path).then(s => {
                if (!s) return;
                if (typeof updateSidecarDot === 'function') updateSidecarDot(filename, true);
                if (typeof window.applyCropAndSubjectsToCard === 'function') {
                    window.applyCropAndSubjectsToCard(card, s);
                }
            });
        }
    }

    const unlisten = await listen('file_progress', ({ payload }) => {
        const card = findTauriCard(payload.path);
        if (!card) return;
        const meta = card.querySelector('.time');
        if (meta) meta.textContent = payload.stage;
        // "encoding" fires after thumbnail generation, just before JXL encode begins
        if (payload.stage === 'encoding') {
            const t = performance.now();
            if (firstJxlT === null) firstJxlT = t;
            lastJxlT = t;
            thumbCount++;
        }
    });

    // file_thumb_fast: backend emits embedded JPEG bytes immediately after parse,
    // before the ~500ms pipeline. Show camera-embedded preview so the grid fills
    // instantly, then onFileDoneTauri replaces it with the pipeline thumbnail.
    const unlistenFastThumb = await listen('file_thumb_fast', ({ payload }) => {
        const card = findTauriCard(payload.path);
        if (!card || !payload.jpeg_b64) return;
        const jpeg = Uint8Array.from(atob(payload.jpeg_b64), c => c.charCodeAt(0));
        const blob = new Blob([jpeg], { type: 'image/jpeg' });
        createImageBitmap(blob).then(bmp => {
            const orientation = payload.orientation || 1;
            // Compute the RAW-pipeline thumb dims from sensor dims so the
            // canvas is sized correctly from the FIRST draw.  Pipeline uses
            // THUMB_LONG_EDGE=360 + sensor aspect (post-orientation).  Drawing
            // the small embedded JPEG into a canvas of those exact dims means
            // the RAW thumb arriving later replaces pixels without resizing
            // the canvas — no layout shift in view-natural mode.
            const sensorW = payload.sensor_width  | 0;
            const sensorH = payload.sensor_height | 0;
            const LONG_EDGE = 360;
            let targetW, targetH;
            if (sensorW > 0 && sensorH > 0) {
                const swap = orientation >= 5;
                const dispW = swap ? sensorH : sensorW;
                const dispH = swap ? sensorW : sensorH;
                if (dispW >= dispH) {
                    targetW = Math.min(dispW, LONG_EDGE);
                    targetH = Math.max(1, Math.round(dispH * targetW / dispW));
                } else {
                    targetH = Math.min(dispH, LONG_EDGE);
                    targetW = Math.max(1, Math.round(dispW * targetH / dispH));
                }
            }
            if (card.classList.contains('busy') || card.classList.contains('embedded-thumb')) {
                const canvas = card.querySelector('canvas');
                if (targetW && targetH) {
                    // Draw the embedded JPEG stretched to the RAW-thumb target
                    // dims. May look slightly blurry (160→360 upscale) but the
                    // size is correct and stable.
                    drawJpegToTargetDims(canvas, bmp, orientation, targetW, targetH);
                } else {
                    drawOrientedThumb(canvas, bmp, orientation, LONG_EDGE);
                }
                card.classList.remove('busy');
                card.classList.add('embedded-thumb');
                // Tauri's file_thumb_fast always emits the small IFD1 preview.
                setThumbSource(card, classifyJpegThumbSource(bmp.width, bmp.height));
            }
            card._embeddedPreview = { bmp, w: bmp.width, h: bmp.height, orientation };
            card._sensorW = sensorW;
            card._sensorH = sensorH;
            refreshThumbToggleButton(card);
            if (lightboxIndex >= 0 && cards[lightboxIndex] === card && !card._lightbox) {
                drawLightboxForCard(card);
            }
        }).catch(() => {});
    });

    await Promise.allSettled(paths.map(async (path) => {
        try {
            const result = await invoke('process_file', {
                path,
                options: {
                    quality: opts.quality,
                    effort: opts.effort,
                    lossless: opts.lossless,
                    look: lookToSnake(opts.look),
                    user_rotation: 0,
                    wb_r: null,
                    wb_b: null,
                },
            });
            onFileDoneTauri(path, result);
        } catch (err) {
            const card = cardByFilename.get(path);
            if (card) {
                card.classList.add('error');
                const meta = card.querySelector('.time');
                if (meta) meta.textContent = String(err);
            }
        }
    }));

    unlisten();
    unlistenFastThumb();

    const batchT3 = performance.now();
    const fmt = ms => (ms / 1000).toFixed(1) + 's';
    const n = paths.length;
    console.log(
        `[Batch] ${n} file${n === 1 ? '' : 's'} | total: ${fmt(batchT3 - batchT0)}\n` +
        `  thumbnails: last ready at t+${firstJxlT !== null ? fmt(lastJxlT  - batchT0) : '?'} ` +
            `(${thumbCount}/${n} events seen)\n` +
        `  JXL start:  first at t+${firstJxlT !== null ? fmt(firstJxlT - batchT0) : '?'} | ` +
            `last at t+${lastJxlT !== null ? fmt(lastJxlT - batchT0) : '?'}\n` +
        `  JXL finish: t+${fmt(batchT3 - batchT0)} | ` +
            `JXL phase: ${lastJxlT !== null ? fmt(batchT3 - firstJxlT) : '?'}\n` +
        `  avg per file: ${fmt((batchT3 - batchT0) / n)}`
    );
}

// ─── Benchmark harness ─────────────────────────────────────────────────────
// Runs the same set of files through several configs sequentially so the
// user can A/B perf knobs on their machine.  No UI rendering — pure perf.
// c = max files in flight (Rust file-semaphore size)
// t = encoder threads per file (libjxl ThreadsRunner)
// e = JXL effort (1 = lightning … 7 = squirrel)
// peak threads during encode ≈ c × t.  12-core dev box → c × t = 12 saturates.
//
// 2-config 200-file probe.  Topology axis exhausted (c=3 t=4 wins at 3/6/20
// file scales).  Effort axis barely tested.  Two configs at champ topology
// vary only effort: e=3 Falcon vs e=2 Thunder.  Hypothesis: Thunder is either
// faster with similar size (free win) or a Lightning-style trap (bloated
// output cancels speed gain).
const BENCH_CONFIGS = [
    { label: 'c=3 t=4 e=3  Falcon (champ)',  concurrency: 3, encoder_threads: 4, effort: 3 },
    { label: 'c=3 t=4 e=2  Thunder (probe)', concurrency: 3, encoder_threads: 4, effort: 2 },
];

function _pct(arr, p) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.floor(s.length * p));
    return s[i];
}
function _stats(arr) {
    if (!arr.length) return { avg: 0, p50: 0, p95: 0, min: 0, max: 0 };
    return {
        avg: arr.reduce((s, x) => s + x, 0) / arr.length,
        p50: _pct(arr, 0.5),
        p95: _pct(arr, 0.95),
        min: arr.reduce((m, x) => Math.min(m, x), Infinity),
        max: arr.reduce((m, x) => Math.max(m, x), -Infinity),
    };
}

async function runOneConfig(paths, cfg, opts) {
    await invoke('set_concurrency', { n: cfg.concurrency });
    // Pre-size + write-by-index so completion-race doesn't shuffle drift order.
    const perFile = new Array(paths.length);
    const t0 = performance.now();
    await Promise.allSettled(paths.map(async (path, idx) => {
        const tStart = performance.now();
        try {
            const result = await invoke('process_file', {
                path,
                options: {
                    quality: opts.quality,
                    effort: cfg.effort,
                    lossless: opts.lossless,
                    look: lookToSnake(opts.look),
                    user_rotation: 0,
                    wb_r: null,
                    wb_b: null,
                    encoder_threads: cfg.encoder_threads,
                },
            });
            const tEnd = performance.now();
            const t = result?.timings || {};
            perFile[idx] = {
                path,
                wall_ms:    tEnd - tStart,
                start_ms:   tStart - t0,
                end_ms:     tEnd - t0,
                dec_ms:     t.decompress_ms || 0,
                dem_ms:     t.demosaic_ms   || 0,
                tone_ms:    t.tone_ms       || 0,
                enc_ms:     t.encode_ms     || 0,
                qwait_ms:   result?.queue_wait_ms || 0,
                jxl_bytes:  result?.jxl?.length || 0,
            };
        } catch (err) {
            perFile[idx] = { error: String(err), path };
        }
    }));
    const wallMs = performance.now() - t0;
    return { cfg, wallMs, perFile };
}

function reportConfig(r) {
    const n = r.perFile.length;
    const ok = r.perFile.filter(p => !p.error);
    const errs = n - ok.length;
    const amortMs = r.wallMs / n;
    const tput = n / (r.wallMs / 1000);
    pushStat(
        `[bench] ${r.cfg.label}  total ${(r.wallMs / 1000).toFixed(2)}s  ` +
        `amort ${amortMs.toFixed(0)} ms/f  tput ${tput.toFixed(2)} f/s` +
        (errs ? `  ERRORS ${errs}` : '')
    );
    if (!ok.length) return;

    const dec   = _stats(ok.map(p => p.dec_ms));
    const dem   = _stats(ok.map(p => p.dem_ms));
    const tone  = _stats(ok.map(p => p.tone_ms));
    const enc   = _stats(ok.map(p => p.enc_ms));
    const qwait = _stats(ok.map(p => p.qwait_ms));
    const wall  = _stats(ok.map(p => p.wall_ms));
    const sizes = _stats(ok.map(p => p.jxl_bytes / 1024));

    pushStat(`[bench]   dec   avg ${dec.avg.toFixed(0)}  p50 ${dec.p50}  p95 ${dec.p95}  max ${dec.max} ms`);
    pushStat(`[bench]   dem   avg ${dem.avg.toFixed(0)}  p50 ${dem.p50}  p95 ${dem.p95}  max ${dem.max} ms`);
    pushStat(`[bench]   tone  avg ${tone.avg.toFixed(0)}  p50 ${tone.p50}  p95 ${tone.p95}  max ${tone.max} ms`);
    pushStat(`[bench]   enc   avg ${enc.avg.toFixed(0)}  p50 ${enc.p50}  p95 ${enc.p95}  max ${enc.max} ms`);
    pushStat(`[bench]   qwait avg ${qwait.avg.toFixed(0)}  p50 ${qwait.p50}  p95 ${qwait.p95}  max ${qwait.max} ms  (priority promotion effect under C/D)`);
    pushStat(`[bench]   wall  avg ${wall.avg.toFixed(0)}  p50 ${wall.p50.toFixed(0)}  p95 ${wall.p95.toFixed(0)}  max ${wall.max.toFixed(0)} ms`);
    pushStat(`[bench]   size  avg ${sizes.avg.toFixed(0)}  p50 ${sizes.p50.toFixed(0)}  p95 ${sizes.p95.toFixed(0)}  min ${sizes.min.toFixed(0)}  max ${sizes.max.toFixed(0)} KB  total ${(sizes.avg * ok.length / 1024).toFixed(1)} MB`);

    // Drift: split by dispatch index, compare first vs last half stage averages
    const half = Math.floor(ok.length / 2);
    const firstHalf = ok.slice(0, half);
    const lastHalf  = ok.slice(ok.length - half);
    const avg = (arr, k) => arr.reduce((s, p) => s + p[k], 0) / arr.length;
    const driftAmort  = (avg(lastHalf, 'wall_ms') - avg(firstHalf, 'wall_ms'));
    const driftDec    = (avg(lastHalf, 'dec_ms')  - avg(firstHalf, 'dec_ms'));
    const driftEnc    = (avg(lastHalf, 'enc_ms')  - avg(firstHalf, 'enc_ms'));
    const pct = (delta, base) => base > 0 ? `${delta >= 0 ? '+' : ''}${(100 * delta / base).toFixed(1)}%` : 'n/a';
    pushStat(
        `[bench]   drift  wall ${avg(firstHalf, 'wall_ms').toFixed(0)}→${avg(lastHalf, 'wall_ms').toFixed(0)} ms (${pct(driftAmort, avg(firstHalf, 'wall_ms'))})  ` +
        `dec ${pct(driftDec, avg(firstHalf, 'dec_ms'))}  enc ${pct(driftEnc, avg(firstHalf, 'enc_ms'))}`
    );

    // Top 3 slowest by wall_ms
    const fname = (p) => (p.split(/[\\/]/).pop() || p);
    const slowest = ok.slice().sort((a, b) => b.wall_ms - a.wall_ms).slice(0, 3);
    pushStat('[bench]   slowest 3:');
    for (const p of slowest) {
        pushStat(`[bench]     ${fname(p.path)}  wall ${p.wall_ms.toFixed(0)} ms  dec ${p.dec_ms} dem ${p.dem_ms} tone ${p.tone_ms} enc ${p.enc_ms} qwait ${p.qwait_ms}  ${(p.jxl_bytes/1024).toFixed(0)} KB`);
    }
    pushStat('');
}

async function runBenchmark() {
    if (!IS_TAURI) {
        pushStat('[bench] tauri-only — benchmark needs the native pipeline');
        return;
    }
    let paths;
    try {
        paths = await invoke('pick_files');
    } catch (err) {
        pushStat(`[bench] pick_files failed: ${err}`);
        return;
    }
    if (!paths?.length) { pushStat('[bench] cancelled — no files'); return; }
    const opts = currentOptions();
    pushStat(`[bench] ${paths.length} files × ${BENCH_CONFIGS.length} configs starting…`);

    const rows = [];
    for (let i = 0; i < BENCH_CONFIGS.length; i++) {
        const cfg = BENCH_CONFIGS[i];
        updateStat('bench:status', `[bench] running ${i + 1}/${BENCH_CONFIGS.length}  ${cfg.label}…`);
        const r = await runOneConfig(paths, cfg, opts);
        rows.push(r);
        reportConfig(r);
    }

    // A/B Pareto comparison (only meaningful for 2 configs).
    if (rows.length === 2) {
        pushStat('[bench] === A vs B Pareto ===');
        const a = rows[0], b = rows[1];
        const okA = a.perFile.filter(p => !p.error);
        const okB = b.perFile.filter(p => !p.error);
        const tputA = a.perFile.length / (a.wallMs / 1000);
        const tputB = b.perFile.length / (b.wallMs / 1000);
        const avgSizeA = okA.reduce((s, p) => s + p.jxl_bytes, 0) / okA.length / 1024;
        const avgSizeB = okB.reduce((s, p) => s + p.jxl_bytes, 0) / okB.length / 1024;
        const totalA = okA.reduce((s, p) => s + p.jxl_bytes, 0) / 1024 / 1024;
        const totalB = okB.reduce((s, p) => s + p.jxl_bytes, 0) / 1024 / 1024;
        const speedDelta = 100 * (tputB - tputA) / tputA;
        const sizeDelta  = 100 * (avgSizeB - avgSizeA) / avgSizeA;
        pushStat(`[bench]   A: ${a.cfg.label}`);
        pushStat(`[bench]   B: ${b.cfg.label}`);
        pushStat(`[bench]   speed  A ${tputA.toFixed(2)} f/s  →  B ${tputB.toFixed(2)} f/s  (${speedDelta >= 0 ? '+' : ''}${speedDelta.toFixed(1)}%)`);
        pushStat(`[bench]   size   A ${avgSizeA.toFixed(0)} KB/f → B ${avgSizeB.toFixed(0)} KB/f  (${sizeDelta >= 0 ? '+' : ''}${sizeDelta.toFixed(1)}%)`);
        pushStat(`[bench]   total  A ${totalA.toFixed(1)} MB    → B ${totalB.toFixed(1)} MB`);
        let verdict;
        if (speedDelta > 0 && sizeDelta <= 2) verdict = 'B WINS — faster, no size cost (replace default)';
        else if (speedDelta > 0 && sizeDelta < speedDelta) verdict = 'B Pareto-wins on speed (gains > size cost)';
        else if (speedDelta > 0)                          verdict = 'TRAP — B faster but size cost ≥ speed gain (Lightning-style)';
        else if (Math.abs(speedDelta) < 2)                verdict = 'TIE — keep A (smaller)';
        else                                              verdict = 'A holds — B slower';
        pushStat(`[bench]   ⇒ ${verdict}`);
    }

    updateStat('bench:status', `[bench] done — ${rows.length} configs, ${paths.length} files each`);

    // Restore the default concurrency for normal operation.
    await invoke('set_concurrency', { n: 3 });
}

// Wire the button at module init.
const benchBtn = document.getElementById('run-benchmark');
if (benchBtn) {
    benchBtn.addEventListener('click', () => {
        benchBtn.disabled = true;
        runBenchmark().catch(e => pushStat(`[bench] ${e?.message || e}`))
                      .finally(() => { benchBtn.disabled = false; });
    });
}

// Effort sweep: e=1..9 at fixed c=3 t=4.  Reports per-file output size so we
// can read the speed/size Pareto.  Same files run 9 times; quality + lossless
// come from current UI settings (same as Benchmark).
async function runEffortSweep() {
    if (!IS_TAURI) {
        pushStat('[sweep] tauri-only — needs the native pipeline');
        return;
    }
    let paths;
    try { paths = await invoke('pick_files'); }
    catch (err) { pushStat(`[sweep] pick_files failed: ${err}`); return; }
    if (!paths?.length) { pushStat('[sweep] cancelled — no files'); return; }
    const opts = currentOptions();
    const fname = (p) => (p.split(/[\\/]/).pop() || p);

    pushStat(`[sweep] ${paths.length} files × 9 efforts (c=3 t=4, q=${opts.quality}, lossless=${opts.lossless})`);
    pushStat('[sweep] effort key: 1 Lightning · 2 Thunder · 3 Falcon · 4 Cheetah · 5 Hare · 6 Wombat · 7 Squirrel · 8 Kitten · 9 Tortoise');

    const rows = [];
    for (let e = 1; e <= 9; e++) {
        const cfg = { label: `c=3 t=4 e=${e}`, concurrency: 3, encoder_threads: 4, effort: e };
        updateStat('bench:status', `[sweep] running e=${e}…`);
        const r = await runOneConfig(paths, cfg, opts);
        rows.push({ effort: e, ...r });
        const ok = r.perFile.filter(p => !p.error);
        const totalKB = ok.reduce((s, p) => s + p.jxl_bytes, 0) / 1024;
        const avgKB   = ok.length ? totalKB / ok.length : 0;
        const avgEnc  = ok.length ? ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length : 0;
        const sizesStr = r.perFile.map((p, i) =>
            p.error ? `${fname(paths[i])}=ERR` : `${fname(paths[i])}=${(p.jxl_bytes/1024).toFixed(0)}KB`
        ).join(' · ');
        pushStat(
            `[sweep] e=${e}  ` +
            `wall ${(r.wallMs/1000).toFixed(2)}s  ` +
            `enc ${avgEnc.toFixed(0)} ms/file  ` +
            `avg ${avgKB.toFixed(0)} KB  ` +
            `total ${totalKB.toFixed(0)} KB`
        );
        pushStat(`[sweep]   sizes: ${sizesStr}`);
    }

    pushStat('');
    pushStat('[sweep] === effort vs size table ===');
    pushStat('[sweep]  e   wall_s   enc_ms   avg_KB   total_KB');
    for (const r of rows) {
        const ok = r.perFile.filter(p => !p.error);
        const totalKB = ok.reduce((s, p) => s + p.jxl_bytes, 0) / 1024;
        const avgKB   = ok.length ? totalKB / ok.length : 0;
        const avgEnc  = ok.length ? ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length : 0;
        pushStat(
            `[sweep]  ${r.effort}` +
            `   ${(r.wallMs/1000).toFixed(2).padStart(6)}` +
            `   ${avgEnc.toFixed(0).padStart(6)}` +
            `   ${avgKB.toFixed(0).padStart(6)}` +
            `   ${totalKB.toFixed(0).padStart(8)}`
        );
    }
    updateStat('bench:status', `[sweep] done — 9 efforts × ${paths.length} files`);
    await invoke('set_concurrency', { n: 3 });
}

const sweepBtn = document.getElementById('run-effort-sweep');
if (sweepBtn) {
    sweepBtn.addEventListener('click', () => {
        sweepBtn.disabled = true;
        runEffortSweep().catch(e => pushStat(`[sweep] ${e?.message || e}`))
                        .finally(() => { sweepBtn.disabled = false; });
    });
}

// Variance × effort bench: picks 5 size-spread files from the user's
// pick, sweeps effort 3/6/7/8/9, reports size matrix + upload-quota
// economics.  Targets chosen from prior 20-file run to span ~6× output
// size range (Falcon column values: 973 → 5575 KB).
//
// Match by filename prefix so '.ORF' / ' - Copy.ORF' suffix variants
// resolve to the same logical target.
const VARIANCE_TARGETS = [
    'P1110187',  // ~973 KB Falcon — smooth scene, low entropy
    'P1100086',  // ~1866 KB
    'P1110179',  // ~3182 KB
    'P1100149',  // ~4788 KB
    'P1110202',  // ~5575 KB — high entropy
];
const VARIANCE_EFFORTS = [3, 6, 7, 8, 9];
const VARIANCE_TOPOLOGY = { concurrency: 3, encoder_threads: 4 };
// Starlink-ish assumptions for upload-time economics.  Edit as needed.
const QUOTA_GB = 50;
const UPLOAD_MBPS = 25;  // typical Starlink upload, MB-per-sec ≈ Mbps/8

async function runVarianceBench() {
    if (!IS_TAURI) { pushStat('[var] tauri-only'); return; }
    let allPaths;
    try { allPaths = await invoke('pick_files'); }
    catch (err) { pushStat(`[var] pick_files failed: ${err}`); return; }
    if (!allPaths?.length) { pushStat('[var] cancelled'); return; }

    const fname = (p) => (p.split(/[\\/]/).pop() || p);
    const baseUC = (p) => fname(p).replace(/\.[Oo][Rr][Ff]$/, '').toUpperCase();
    const selected = [];
    const missing = [];
    for (const target of VARIANCE_TARGETS) {
        const tu = target.toUpperCase();
        const hit = allPaths.find(p => baseUC(p).startsWith(tu));
        if (hit) selected.push({ target, path: hit });
        else missing.push(target);
    }
    if (missing.length) pushStat(`[var] missing: ${missing.join(', ')}`);
    if (!selected.length) { pushStat('[var] no targets found in selection'); return; }

    const opts = currentOptions();
    pushStat(`[var] ${selected.length} files × ${VARIANCE_EFFORTS.length} efforts  c=${VARIANCE_TOPOLOGY.concurrency} t=${VARIANCE_TOPOLOGY.encoder_threads} q=${opts.quality} lossless=${opts.lossless}`);
    pushStat(`[var] targets: ${selected.map(s => fname(s.path)).join(', ')}`);
    pushStat('[var] effort key: 3 Falcon · 5 Hare · 6 Wombat · 7 Squirrel · 8 Kitten · 9 Tortoise');

    const paths = selected.map(s => s.path);
    // matrix[effortIndex] = { e, perFile: [{path, enc_ms, jxl_bytes, ...}], wallMs }
    const matrix = [];
    for (let i = 0; i < VARIANCE_EFFORTS.length; i++) {
        const e = VARIANCE_EFFORTS[i];
        const cfg = { label: `e=${e}`, concurrency: VARIANCE_TOPOLOGY.concurrency, encoder_threads: VARIANCE_TOPOLOGY.encoder_threads, effort: e };
        updateStat('bench:status', `[var] ${i+1}/${VARIANCE_EFFORTS.length}  effort ${e}…`);
        const r = await runOneConfig(paths, cfg, opts);
        matrix.push({ effort: e, ...r });
        const ok = r.perFile.filter(p => !p.error);
        const totalKB = ok.reduce((s, p) => s + p.jxl_bytes, 0) / 1024;
        const avgKB   = ok.length ? totalKB / ok.length : 0;
        const avgEnc  = ok.length ? ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length : 0;
        pushStat(`[var] e=${e}  wall ${(r.wallMs/1000).toFixed(2)}s  enc ${avgEnc.toFixed(0)} ms/f  avg ${avgKB.toFixed(0)} KB  total ${totalKB.toFixed(0)} KB`);
    }

    // === size matrix: rows = files, columns = effort ===
    pushStat('');
    pushStat('[var] === size matrix (KB per file) ===');
    const header = 'file              ' + VARIANCE_EFFORTS.map(e => `   e=${e}`).join('  ');
    pushStat('[var] ' + header);
    for (let f = 0; f < paths.length; f++) {
        const row = VARIANCE_EFFORTS.map((_, ei) => {
            const p = matrix[ei].perFile[f];
            return p && !p.error ? (p.jxl_bytes/1024).toFixed(0).padStart(6) : '   ERR';
        }).join('  ');
        pushStat(`[var] ${fname(paths[f]).padEnd(18)}${row}`);
    }

    // === aggregate Pareto + quota economics ===
    pushStat('');
    pushStat('[var] === effort vs size + upload economics ===');
    pushStat(`[var]  quota = ${QUOTA_GB} GB/mo  upload = ${UPLOAD_MBPS} Mbps (${(UPLOAD_MBPS/8).toFixed(1)} MB/s)`);
    pushStat('[var]  e   avgKB   enc_s   vs_e3_size   vs_e3_enc   files/quota   upload_s   total_s');
    const baseE3 = matrix[0];
    const baseOk = baseE3.perFile.filter(p => !p.error);
    const baseAvgKB = baseOk.reduce((s, p) => s + p.jxl_bytes, 0) / baseOk.length / 1024;
    const baseAvgEnc = baseOk.reduce((s, p) => s + p.enc_ms, 0) / baseOk.length / 1000;
    const uploadMBps = UPLOAD_MBPS / 8;
    for (const r of matrix) {
        const ok = r.perFile.filter(p => !p.error);
        const avgKB  = ok.reduce((s, p) => s + p.jxl_bytes, 0) / ok.length / 1024;
        const avgEnc = ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length / 1000;
        const sizeDelta = 100 * (avgKB  - baseAvgKB)  / baseAvgKB;
        const encDelta  = 100 * (avgEnc - baseAvgEnc) / baseAvgEnc;
        const filesPerQuota = (QUOTA_GB * 1024 * 1024) / avgKB;
        const uploadS = (avgKB / 1024) / uploadMBps;   // KB → MB → s
        const totalS  = avgEnc + uploadS;
        const sdStr = (sizeDelta >= 0 ? '+' : '') + sizeDelta.toFixed(1) + '%';
        const edStr = (encDelta  >= 0 ? '+' : '') + encDelta.toFixed(1)  + '%';
        pushStat(
            `[var]  ${r.effort}` +
            `  ${avgKB.toFixed(0).padStart(6)}` +
            `  ${avgEnc.toFixed(2).padStart(6)}` +
            `  ${sdStr.padStart(11)}` +
            `  ${edStr.padStart(10)}` +
            `  ${filesPerQuota.toFixed(0).padStart(12)}` +
            `  ${uploadS.toFixed(2).padStart(8)}` +
            `  ${totalS.toFixed(2).padStart(8)}`
        );
    }

    // === verdict: pick the effort that minimises total time-to-upload ===
    pushStat('');
    let bestTotal = { effort: 0, totalS: Infinity };
    let bestSize  = { effort: 0, avgKB: Infinity };
    let bestQuota = { effort: 0, files: 0 };
    for (const r of matrix) {
        const ok = r.perFile.filter(p => !p.error);
        const avgKB  = ok.reduce((s, p) => s + p.jxl_bytes, 0) / ok.length / 1024;
        const avgEnc = ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length / 1000;
        const totalS = avgEnc + (avgKB / 1024) / uploadMBps;
        const files  = (QUOTA_GB * 1024 * 1024) / avgKB;
        if (totalS < bestTotal.totalS) bestTotal = { effort: r.effort, totalS };
        if (avgKB  < bestSize.avgKB)   bestSize  = { effort: r.effort, avgKB };
        if (files  > bestQuota.files)  bestQuota = { effort: r.effort, files };
    }
    pushStat(`[var] BEST encode+upload total time:  e=${bestTotal.effort}  (${bestTotal.totalS.toFixed(2)} s/file)`);
    pushStat(`[var] BEST output size:               e=${bestSize.effort}  (${bestSize.avgKB.toFixed(0)} KB/file)`);
    pushStat(`[var] BEST files per ${QUOTA_GB} GB quota:        e=${bestQuota.effort}  (${bestQuota.files.toFixed(0)} files)`);
    updateStat('bench:status', `[var] done`);
    await invoke('set_concurrency', { n: 3 });
}

const varBtn = document.getElementById('run-variance-bench');
if (varBtn) {
    varBtn.addEventListener('click', () => {
        varBtn.disabled = true;
        runVarianceBench().catch(e => pushStat(`[var] ${e?.message || e}`))
                          .finally(() => { varBtn.disabled = false; });
    });
}

// Quality sweep: q=80/85/90/95 at fixed c=3 t=4 e=3 Falcon on 10 files
// sampled with even spread across the picked folder.  Anchor size deltas at
// q=90 (current production default).  Headline metric = files-per-50GB-quota.
const QUALITY_VALUES = [80, 85, 90, 95];
const QUALITY_TOPOLOGY = { concurrency: 3, encoder_threads: 4, effort: 3 };
const QUALITY_SAMPLE_N = 10;

async function runQualitySweep() {
    if (!IS_TAURI) { pushStat('[q] tauri-only'); return; }
    let allPaths;
    try { allPaths = await invoke('pick_files'); }
    catch (err) { pushStat(`[q] pick_files failed: ${err}`); return; }
    if (!allPaths?.length) { pushStat('[q] cancelled'); return; }

    const fname = (p) => (p.split(/[\\/]/).pop() || p);
    const n = allPaths.length;
    // Even-spread sampling: pick floor(i * n / N) for i in 0..N.  Avoids
    // clustering that random sampling can produce.
    const paths = [];
    if (n <= QUALITY_SAMPLE_N) {
        paths.push(...allPaths);
    } else {
        for (let i = 0; i < QUALITY_SAMPLE_N; i++) {
            paths.push(allPaths[Math.floor(i * n / QUALITY_SAMPLE_N)]);
        }
    }

    const baseOpts = currentOptions();
    pushStat(`[q] picked ${n} files, sampling ${paths.length} with even spread`);
    pushStat(`[q] sweep q=${QUALITY_VALUES.join('/')} at c=${QUALITY_TOPOLOGY.concurrency} t=${QUALITY_TOPOLOGY.encoder_threads} e=${QUALITY_TOPOLOGY.effort} Falcon  lossless=${baseOpts.lossless}`);
    pushStat('[q] chosen files:');
    for (let i = 0; i < paths.length; i++) {
        pushStat(`[q]   ${String(i+1).padStart(2)}. ${fname(paths[i])}`);
    }

    // matrix[qIndex] = { quality, perFile, wallMs, cfg }
    const matrix = [];
    for (let i = 0; i < QUALITY_VALUES.length; i++) {
        const q = QUALITY_VALUES[i];
        const cfg = { label: `q=${q}`, ...QUALITY_TOPOLOGY };
        const opts = { ...baseOpts, quality: q };
        updateStat('bench:status', `[q] ${i+1}/${QUALITY_VALUES.length}  q=${q}…`);
        const r = await runOneConfig(paths, cfg, opts);
        matrix.push({ quality: q, ...r });
        const ok = r.perFile.filter(p => !p.error);
        const totalKB = ok.reduce((s, p) => s + p.jxl_bytes, 0) / 1024;
        const avgKB   = ok.length ? totalKB / ok.length : 0;
        const avgEnc  = ok.length ? ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length : 0;
        pushStat(`[q] q=${q}  wall ${(r.wallMs/1000).toFixed(2)}s  enc ${avgEnc.toFixed(0)} ms/f  avg ${avgKB.toFixed(0)} KB  total ${totalKB.toFixed(0)} KB`);
    }

    // === size matrix: rows = files, columns = quality ===
    pushStat('');
    pushStat('[q] === size matrix (KB per file) ===');
    const header = 'file                  ' + QUALITY_VALUES.map(q => `  q=${q}`).join('  ');
    pushStat('[q] ' + header);
    for (let f = 0; f < paths.length; f++) {
        const row = QUALITY_VALUES.map((_, qi) => {
            const p = matrix[qi].perFile[f];
            return p && !p.error ? (p.jxl_bytes/1024).toFixed(0).padStart(5) : '  ERR';
        }).join('  ');
        pushStat(`[q] ${fname(paths[f]).padEnd(22)}${row}`);
    }

    // === aggregate Pareto + quota economics, anchored at q=90 ===
    pushStat('');
    pushStat('[q] === quality vs size + upload economics ===');
    pushStat(`[q]  quota = ${QUOTA_GB} GB/mo  upload = ${UPLOAD_MBPS} Mbps (${(UPLOAD_MBPS/8).toFixed(1)} MB/s)  anchor = q=90`);
    pushStat('[q]  q    avgKB   p50KB   p95KB   enc_ms   vs_q90_size   files/quota   upload_s   total_s');
    const baseIdx = QUALITY_VALUES.indexOf(90);
    const baseRow = matrix[baseIdx];
    const baseOk = baseRow.perFile.filter(p => !p.error);
    const baseAvgKB = baseOk.reduce((s, p) => s + p.jxl_bytes, 0) / baseOk.length / 1024;
    const uploadMBps = UPLOAD_MBPS / 8;
    for (const r of matrix) {
        const ok = r.perFile.filter(p => !p.error);
        const sizesKB = ok.map(p => p.jxl_bytes / 1024);
        const sStats  = _stats(sizesKB);
        const avgKB   = sStats.avg;
        const avgEnc  = ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length;
        const sizeDelta = 100 * (avgKB - baseAvgKB) / baseAvgKB;
        const filesPerQuota = (QUOTA_GB * 1024 * 1024) / avgKB;
        const uploadS = (avgKB / 1024) / uploadMBps;
        const totalS  = (avgEnc / 1000) + uploadS;
        const sdStr = (sizeDelta >= 0 ? '+' : '') + sizeDelta.toFixed(1) + '%';
        pushStat(
            `[q]  ${r.quality}` +
            `  ${avgKB.toFixed(0).padStart(6)}` +
            `  ${sStats.p50.toFixed(0).padStart(6)}` +
            `  ${sStats.p95.toFixed(0).padStart(6)}` +
            `  ${avgEnc.toFixed(0).padStart(7)}` +
            `  ${sdStr.padStart(12)}` +
            `  ${filesPerQuota.toFixed(0).padStart(12)}` +
            `  ${uploadS.toFixed(2).padStart(8)}` +
            `  ${totalS.toFixed(2).padStart(8)}`
        );
    }

    // === verdicts ===
    pushStat('');
    let bestTotal = { quality: 0, totalS: Infinity };
    let bestSize  = { quality: 0, avgKB: Infinity };
    let bestQuota = { quality: 0, files: 0 };
    for (const r of matrix) {
        const ok = r.perFile.filter(p => !p.error);
        const avgKB  = ok.reduce((s, p) => s + p.jxl_bytes, 0) / ok.length / 1024;
        const avgEnc = ok.reduce((s, p) => s + p.enc_ms, 0) / ok.length / 1000;
        const totalS = avgEnc + (avgKB / 1024) / uploadMBps;
        const files  = (QUOTA_GB * 1024 * 1024) / avgKB;
        if (totalS < bestTotal.totalS) bestTotal = { quality: r.quality, totalS };
        if (avgKB  < bestSize.avgKB)   bestSize  = { quality: r.quality, avgKB };
        if (files  > bestQuota.files)  bestQuota = { quality: r.quality, files };
    }
    pushStat(`[q] BEST encode+upload total time:  q=${bestTotal.quality}  (${bestTotal.totalS.toFixed(2)} s/file)`);
    pushStat(`[q] BEST output size:               q=${bestSize.quality}  (${bestSize.avgKB.toFixed(0)} KB/file)`);
    pushStat(`[q] BEST files per ${QUOTA_GB} GB quota:        q=${bestQuota.quality}  (${bestQuota.files.toFixed(0)} files)`);
    updateStat('bench:status', `[q] done`);
    await invoke('set_concurrency', { n: 3 });
}

const qBtn = document.getElementById('run-quality-sweep');
if (qBtn) {
    qBtn.addEventListener('click', () => {
        qBtn.disabled = true;
        runQualitySweep().catch(e => pushStat(`[q] ${e?.message || e}`))
                         .finally(() => { qBtn.disabled = false; });
    });
}

// ============================================================================
// Pixel-peep quality compare mode
// ----------------------------------------------------------------------------
// Pick N photos.  Queue encodes globally in priority order — q=80 for every
// photo first (so all show up viewable fastest), then q=75/85, then 70/90/95.
// Each photo: decode all available qualities; paint the current peepQuality
// or fallback to nearest-decoded quality so something is always on screen.
// Lightbox opens at 100% pixels (no fit-to-screen).  Up/Down cycle quality;
// Left/Right switch photo preserving zoom+pan (tripod compare).  Esc exits.
// ============================================================================
// Full ladder: q=50..95 in steps of 5, then lossless JXL (bit-exact for RGB,
// i.e. visually identical to uncompressed source — just much smaller bytes).
const PEEP_QUALITIES = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 'lossless'];
// Encode order: sweet-spot + anchors first so the most informative variants
// are viewable early.  Tauri semaphore drains the rest in submission order.
const PEEP_PRIORITY  = [80, 95, 'lossless', 70, 90, 60, 85, 50, 75, 65, 55];
const PEEP_INITIAL_Q = 80;
const fmtPeepQ = (q) => typeof q === 'number' ? `q=${q}` : q;
const PEEP_EFFORT = 3;
const PEEP_ENCODER_THREADS = 4;
const PEEP_CONCURRENCY = 3;

let pixelPeepActive = false;
let peepPaths = [];
let peepIdx = 0;
let peepQuality = PEEP_INITIAL_Q;
// peepCache: Map<photoIdx, { jxlBytes:{q:Uint8Array}, decoded:{q:{rgba,w,h}}, encodeMs:{q:number}, sizeBytes:{q:number}, doneCount:number }>
const peepCache = new Map();

// Bounded LRU over decoded full-res RGBA variants. Without this, the peep cache
// accumulates one RGBA buffer per (photo × quality) it ever decodes — N photos
// × up to 11 qualities, each potentially tens of MB — and never frees them, so
// a long peep session over a folder grows memory without bound. We keep the
// small jxlBytes/sizeBytes/encodeMs metadata (cheap) but cap the count of heavy
// decoded RGBA buffers, evicting the least-recently-used. Cap ≈ 2 full quality
// ladders so the current photo plus a neighbour stay hot; evicted variants are
// transparently re-decoded from the retained jxlBytes on demand.
const PEEP_DECODED_LRU_MAX = 24;
const peepLruKey = (idx, q) => `${idx}:${q}`;
// S3: govern the decoded-RGBA LRU through AssetStore instead of a bespoke Map.
// One "unit" per decoded variant (size = 1) + a 24-unit budget reproduces the
// exact count-capped, insertion-ordered LRU (oldest = victim; touch = promote);
// the onEvict hook frees the evicted RGBA from its owning peepCache entry so it
// can be GC'd (transparently re-decoded from the retained jxlBytes on demand).
// Switching `maxBytes` to a real byte budget later is a one-line change.
const peepDecodedStore = new AssetStore({
    name: 'peep-decoded',
    maxBytes: PEEP_DECODED_LRU_MAX,
    onEvict: (key) => {
        const sep = key.lastIndexOf(':');
        const oIdx = Number(key.slice(0, sep));
        const oQ = key.slice(sep + 1);
        // PEEP_QUALITIES are numbers except 'lossless'; restore the number type
        // so the delete hits the same key the decoded variant was stored under.
        const qKey = oQ === 'lossless' ? oQ : Number(oQ);
        const oEntry = peepCache.get(oIdx);
        if (oEntry?.decoded) delete oEntry.decoded[qKey];
    },
});

// Record a freshly-decoded variant as most-recently-used; the store evicts the
// LRU victim past the cap (freeing it via onEvict above).
function peepLruRecord(idx, q) {
    peepDecodedStore.set(peepLruKey(idx, q), true, 1);
}

// Mark an already-decoded variant as recently used (e.g. on paint/nav) without
// inserting one that was never decoded (get() promotes if present, else no-op).
function peepLruTouch(idx, q) {
    peepDecodedStore.get(peepLruKey(idx, q));
}

async function runPixelPeep() {
    if (!IS_TAURI) { pushStat('[peep] tauri-only'); return; }
    let paths;
    try { paths = await invoke('pick_files'); }
    catch (err) { pushStat(`[peep] pick_files failed: ${err}`); return; }
    if (!paths?.length) { pushStat('[peep] cancelled'); return; }

    pixelPeepActive = true;
    peepPaths = paths;
    peepIdx = 0;
    peepQuality = PEEP_INITIAL_Q;
    peepCache.clear();
    peepDecodedStore.clear();
    // Seed cache entries so .then() callbacks can locate their photo idx.
    for (let i = 0; i < paths.length; i++) {
        peepCache.set(i, { jxlBytes: {}, decoded: {}, encodeMs: {}, sizeBytes: {}, doneCount: 0 });
    }

    await invoke('set_concurrency', { n: PEEP_CONCURRENCY });
    pushStat(`[peep] ${paths.length} photos  ladder=${PEEP_QUALITIES.join('/')}  e=${PEEP_EFFORT} Falcon`);
    pushStat(`[peep] queue order: ${PEEP_PRIORITY.join(' → ')}  (all photos per step)`);
    pushStat(`[peep] note: 'raw' aliases 'lossless' decode (lossless JXL is bit-exact); size shown as uncompressed RGB bytes`);
    pushStat('[peep] keys: ↑/↓ quality · ←/→ photo · Esc exit · wheel zoom · drag pan');

    openPeepLightbox();
    queuePeepEncodes();
}

function openPeepLightbox() {
    // Fresh canvas — pixel-peep starts blank until first decode arrives.
    lightboxCanvas.width = 1;
    lightboxCanvas.height = 1;
    lbZoom = 1.0;   // 100% pixels, NOT fit-to-screen
    lbPanX = 0;
    lbPanY = 0;
    lbRotation = 0;
    applyLbTransform();
    lbPreviewBadge.hidden = true;
    lbLoadingBadge.hidden = false;
    lightbox.hidden = false;
    lightbox.classList.add('peep-mode');
    // Clear stale lightbox state from any prior normal-mode open.
    lightboxIndex = -1;
    if (lightboxInfo) lightboxInfo.innerHTML = '';
    // Source indicators repurposed: show current peep quality, not RAW/JXL/JPEG.
    if (lbSourceBanner) {
        lbSourceBanner.hidden = false;
        lbSourceBanner.setAttribute('data-source', 'peep');
        lbSourceBanner.textContent = fmtPeepQ(peepQuality);
    }
    if (lbToggleJpegBtn) {
        lbToggleJpegBtn.disabled = true;
    }
    updatePeepBadges();
    pushStat(`[peep] open: lightbox.hidden=${lightbox.hidden} canvas=${lightboxCanvas.width}x${lightboxCanvas.height} zoom=${lbZoom}`);
}

function _fmtMB(bytes) {
    if (bytes == null) return '—';
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? `${mb.toFixed(1)} MB` : `${mb.toFixed(2)} MB`;
}

// Persistent HUD: current quality + compressed JXL bytes + uncompressed RGB
// bytes (raw reference) + zoom %.  Replaces the old centred fade label.
function updatePeepBadges() {
    if (!lbSourceBanner) return;
    const entry = peepCache.get(peepIdx);
    const compBytes = entry?.sizeBytes?.[peepQuality];
    // Raw RGB bytes from any decoded variant for this photo — dims are the
    // same for every quality.
    let rawBytes = null;
    if (entry?.decoded) {
        for (const k in entry.decoded) {
            const d = entry.decoded[k];
            if (d?.w && d?.h) { rawBytes = d.w * d.h * 3; break; }
        }
    }
    const compStr = compBytes != null ? _fmtMB(compBytes) : 'loading';
    const rawStr  = rawBytes  != null ? _fmtMB(rawBytes)  : '—';
    const zoomStr = `${Math.round(lbZoom * 100)}%`;
    const photoStr = peepPaths.length > 1 ? `  ${peepIdx + 1}/${peepPaths.length}` : '';
    lbSourceBanner.textContent =
        `${fmtPeepQ(peepQuality)}   ${compStr} / raw ${rawStr}   ${zoomStr}${photoStr}`;
    if (lbToggleJpegBtn) lbToggleJpegBtn.textContent = fmtPeepQ(peepQuality);
}

// Fire all N×6 encodes in priority order.  Tauri's set_concurrency semaphore
// queues excess work — order of submission decides what completes first.
function queuePeepEncodes() {
    for (const q of PEEP_PRIORITY) {
        for (let idx = 0; idx < peepPaths.length; idx++) {
            kickPeepEncode(idx, q);
        }
    }
}

function kickPeepEncode(idx, q) {
    const path = peepPaths[idx];
    const baseOpts = currentOptions();
    const isLossless = q === 'lossless';
    const t0 = performance.now();
    invoke('process_file', {
        path,
        options: {
            // Tauri side accepts quality even when lossless=true; libjxl ignores it.
            quality: isLossless ? 100 : q,
            effort: PEEP_EFFORT,
            lossless: isLossless,
            look: lookToSnake(baseOpts.look),
            user_rotation: 0,
            wb_r: null,
            wb_b: null,
            encoder_threads: PEEP_ENCODER_THREADS,
        },
    }).then((result) => {
        if (!pixelPeepActive || !peepCache.has(idx)) return;
        const e = peepCache.get(idx);
        const bytes = new Uint8Array(result.jxl);
        e.jxlBytes[q] = bytes;
        e.encodeMs[q] = performance.now() - t0;
        e.sizeBytes[q] = bytes.byteLength;
        e.doneCount++;
        pushStat(`[peep]   photo ${idx+1} ${fmtPeepQ(q)} ready  ${(e.encodeMs[q]/1000).toFixed(2)}s  ${(bytes.byteLength/1024).toFixed(0)} KB`);
        decodePeepQuality(idx, q);
        if (idx === peepIdx) updatePeepBadges();
    }).catch((err) => {
        if (!peepCache.has(idx)) return;
        const e = peepCache.get(idx);
        e.encodeMs[q] = -1;
        e.doneCount++;
        pushStat(`[peep]   photo ${idx+1} ${fmtPeepQ(q)} FAILED: ${err}`);
    });
}

function decodePeepQuality(idx, q) {
    const entry = peepCache.get(idx);
    if (!entry || !entry.jxlBytes[q] || entry.decoded[q]) return;
    const blob = new Blob([entry.jxlBytes[q]], { type: 'image/jxl' });
    const url = URL.createObjectURL(blob);
    pool.decodeJxl(url, (msg) => {
        URL.revokeObjectURL(url);
        if (!pixelPeepActive) return;
        if (!peepCache.has(idx)) return;
        if (msg.type === 'decode_error') {
            pushStat(`[peep]   photo ${idx+1} q=${q} decode error: ${msg.error}`);
            return;
        }
        const e = peepCache.get(idx);
        e.decoded[q] = { rgba: msg.rgba, w: msg.w, h: msg.h };
        peepLruRecord(idx, q);
        pushStat(`[peep]   photo ${idx+1} ${fmtPeepQ(q)} decoded  ${msg.w}×${msg.h}`);
        if (idx === peepIdx) { paintPeepCurrent(); updatePeepBadges(); }
    });
}

// Walk outward from peepQuality to find the nearest decoded variant.
function pickNearestDecoded(entry, want) {
    if (entry.decoded[want]) return { dec: entry.decoded[want], q: want, fallback: false };
    const idx = PEEP_QUALITIES.indexOf(want);
    for (let d = 1; d < PEEP_QUALITIES.length; d++) {
        const lo = idx - d, hi = idx + d;
        if (hi < PEEP_QUALITIES.length) {
            const q = PEEP_QUALITIES[hi];
            if (entry.decoded[q]) return { dec: entry.decoded[q], q, fallback: true };
        }
        if (lo >= 0) {
            const q = PEEP_QUALITIES[lo];
            if (entry.decoded[q]) return { dec: entry.decoded[q], q, fallback: true };
        }
    }
    return null;
}

function paintPeepCurrent() {
    const entry = peepCache.get(peepIdx);
    if (!entry) { lbLoadingBadge.hidden = false; return; }
    const pick = pickNearestDecoded(entry, peepQuality);
    if (!pick) {
        if (entry.jxlBytes[peepQuality]) decodePeepQuality(peepIdx, peepQuality);
        lbLoadingBadge.hidden = false;
        return;
    }
    const { dec, q: paintedQ, fallback } = pick;
    // Painting this variant makes it most-recently-used so navigation back and
    // forth across photos doesn't evict what's currently on screen.
    peepLruTouch(peepIdx, paintedQ);
    try {
        lightboxCanvas.width = dec.w;
        lightboxCanvas.height = dec.h;
        const ctx = lightboxCanvas.getContext('2d');
        // Force fresh ImageData even if rgba is plain Uint8Array (not Clamped).
        const rgba = dec.rgba instanceof Uint8ClampedArray
            ? dec.rgba
            : new Uint8ClampedArray(dec.rgba.buffer, dec.rgba.byteOffset, dec.rgba.byteLength);
        ctx.putImageData(new ImageData(rgba, dec.w, dec.h), 0, 0);
        if (lightboxCanvas.width > 0) {
            captureCleanAndApplyLens(ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
        }
        pushStat(`[peep] painted photo ${peepIdx+1} ${fmtPeepQ(paintedQ)}  ${dec.w}×${dec.h}`);
    } catch (err) {
        pushStat(`[peep] PAINT FAILED photo ${peepIdx+1} ${fmtPeepQ(paintedQ)}: ${err?.message || err}`);
        console.error('paintPeepCurrent error', err, dec);
        return;
    }
    lbLoadingBadge.hidden = !fallback;
    applyLbTransform();
    updatePeepBadges();
}

function peepNavPhoto(delta) {
    const n = peepPaths.length;
    if (n <= 1) return;
    peepIdx = (peepIdx + delta + n) % n;
    paintPeepCurrent();
    updatePeepBadges();
}

function peepCycleQuality(delta) {
    const i = PEEP_QUALITIES.indexOf(peepQuality);
    const ni = (i + delta + PEEP_QUALITIES.length) % PEEP_QUALITIES.length;
    peepQuality = PEEP_QUALITIES[ni];
    const entry = peepCache.get(peepIdx);
    if (entry && !entry.decoded[peepQuality] && entry.jxlBytes[peepQuality]) {
        decodePeepQuality(peepIdx, peepQuality);
    }
    paintPeepCurrent();
    updatePeepBadges();
}

function exitPixelPeep() {
    pixelPeepActive = false;
    peepCache.clear();
    peepDecodedStore.clear();
    peepPaths = [];
    lightbox.hidden = true;
    lightbox.classList.remove('peep-mode');
    lbLoadingBadge.hidden = true;
    pushStat('[peep] exited');
}

const peepBtn = document.getElementById('run-pixel-peep');
if (peepBtn) {
    peepBtn.addEventListener('click', () => {
        peepBtn.disabled = true;
        runPixelPeep().catch(e => pushStat(`[peep] ${e?.message || e}`))
                      .finally(() => { peepBtn.disabled = false; });
    });
}

// Measure canvas paint cost (putImageData) at each unique W×H in the bench
// rows. Paint cost depends only on dimensions, not on which decoder produced
// the buffer — so a synthetic RGBA of the right size gives an accurate paint
// timing without round-tripping the real decoded pixels through IPC (which
// would dominate the measurement with JSON-array encoding overhead).
function measurePaintTimings(rows) {
    const canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.left = '-99999px';
    canvas.style.top = '0';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const cache = new Map();
    const ITERS = 3;
    for (const r of rows) {
        if (!r.width || !r.height) { r.paint_ms = 0; continue; }
        const key = `${r.width}x${r.height}`;
        if (cache.has(key)) { r.paint_ms = cache.get(key); continue; }
        canvas.width = r.width;
        canvas.height = r.height;
        const rgba = new Uint8ClampedArray(r.width * r.height * 4);
        // Mid-grey opaque; avoids any all-zero fast-path the browser might take.
        for (let i = 0; i < rgba.length; i += 4) {
            rgba[i] = 128; rgba[i+1] = 128; rgba[i+2] = 128; rgba[i+3] = 255;
        }
        const imgData = new ImageData(rgba, r.width, r.height);
        // Warm up — first putImageData on a fresh canvas size pays extra cost.
        ctx.putImageData(imgData, 0, 0);
        const t0 = performance.now();
        for (let i = 0; i < ITERS; i++) ctx.putImageData(imgData, 0, 0);
        const ms = (performance.now() - t0) / ITERS;
        cache.set(key, ms);
        r.paint_ms = ms;
    }
    canvas.remove();
}

// JXL decoder bench — encodes a chosen ORF then decodes it with jpegxl-rs
// (libjxl, current encoder) and jxl-oxide (pure-Rust) at a ladder of sizes
// and regions, printing the timing matrix to the stats panel.
const _benchPad = (s, n) => String(s).padEnd(n, ' ');
const _benchPadN = (s, n) => String(s).padStart(n, ' ');
const _benchFmtMs1 = (ms) => `${(ms || 0).toFixed(1)}ms`;

function printBenchResult(label, result) {
    pushStat(`[${label}] file ${result.source_path}`);
    pushStat(`[${label}] full ${result.full_width}×${result.full_height}  jxl ${(result.encoded_bytes/1024).toFixed(0)} KB  encode ${result.encode_ms} ms`);
    measurePaintTimings(result.rows);
    pushStat(`[${label}] ${_benchPad('library', 11)} ${_benchPad('operation', 22)} ${_benchPadN('w', 5)}×${_benchPadN('h', 5)} ${_benchPadN('decode', 9)} ${_benchPadN('post', 8)} ${_benchPadN('paint', 9)} ${_benchPadN('total', 9)}  note`);
    for (const r of result.rows) {
        const totalWithPaint = (r.decode_ms || 0) + (r.resize_ms || 0) + (r.paint_ms || 0);
        pushStat(
            `[${label}] ${_benchPad(r.library, 11)} ${_benchPad(r.operation, 22)} ${_benchPadN(r.width, 5)}×${_benchPadN(r.height, 5)} ` +
            `${_benchPadN(r.decode_ms + 'ms', 9)} ${_benchPadN(r.resize_ms + 'ms', 8)} ${_benchPadN(_benchFmtMs1(r.paint_ms), 9)} ` +
            `${_benchPadN(totalWithPaint.toFixed(1) + 'ms', 9)}  ${r.note}`,
        );
    }
}

async function runJxlDecodeBench() {
    if (!IS_TAURI) {
        pushStat('[jxl-bench] Tauri-only — run inside the desktop app');
        return;
    }
    const defaultPath = 'C:\\995\\2026-01-09 Birthday at Cederberg\\P1100080.ORF';
    const path = prompt('JXL bench — ORF path to encode + decode:', defaultPath) || defaultPath;
    pushStat(`[jxl-bench] starting on ${path}`);
    const t0 = performance.now();
    let result;
    try {
        result = await invoke('bench_jxl_decode', { path });
    } catch (e) {
        pushStat(`[jxl-bench] FAILED: ${e?.message || e}`);
        return;
    }
    const wallMs = (performance.now() - t0).toFixed(0);
    pushStat(`[jxl-bench] wall ${wallMs} ms`);
    printBenchResult('jxl-bench', result);
    pushStat('[jxl-bench] done');
}

async function runJxlSweep() {
    if (!IS_TAURI) {
        pushStat('[jxl-sweep] Tauri-only — run inside the desktop app');
        return;
    }
    const defaultFolder = 'C:\\995\\2026-01-09 Birthday at Cederberg';
    const folder = prompt('JXL sweep — folder of ORFs:', defaultFolder) || defaultFolder;
    pushStat(`[jxl-sweep] starting on folder ${folder}`);
    const t0 = performance.now();
    const unlisten = await listen('bench_progress', ({ payload }) => {
        if (payload?.stage === 'sweep') pushStat(`[jxl-sweep] ${payload.msg}`);
    });
    let sweep;
    try {
        sweep = await invoke('bench_jxl_sweep', { folder });
    } catch (e) {
        pushStat(`[jxl-sweep] FAILED: ${e?.message || e}`);
        unlisten();
        return;
    }
    unlisten();
    const wallMs = (performance.now() - t0).toFixed(0);
    pushStat(`[jxl-sweep] ${sweep.per_image.length} images  wall ${wallMs} ms`);
    sweep.picks.forEach((p, i) => pushStat(`[jxl-sweep] pick ${i + 1}/${sweep.picks.length}  ${p}`));
    sweep.per_image.forEach((res, i) => {
        pushStat(`[jxl-sweep] ─── image ${i + 1}/${sweep.per_image.length} ───`);
        printBenchResult('jxl-sweep', res);
    });
    pushStat('[jxl-sweep] done');
}

async function runJxlStress() {
    if (!IS_TAURI) {
        pushStat('[jxl-stress] Tauri-only — run inside the desktop app');
        return;
    }
    const defaultFolder = 'C:\\995\\2026-01-09 Birthday at Cederberg';
    const folder = prompt('JXL stress — folder of ORFs:', defaultFolder) || defaultFolder;
    const sizes = [180, 480, 1080];
    const repeats = 3;
    pushStat(`[jxl-stress] starting on folder ${folder}  sizes ${sizes.join('/')}  repeats ${repeats}`);
    const t0 = performance.now();
    const unlisten = await listen('bench_progress', ({ payload }) => {
        if (payload?.stage === 'stress') pushStat(`[jxl-stress] ${payload.msg}`);
    });
    let stress;
    try {
        stress = await invoke('bench_jxl_stress', { folder, sizes, repeats });
    } catch (e) {
        pushStat(`[jxl-stress] FAILED: ${e?.message || e}`);
        unlisten();
        return;
    }
    unlisten();
    const wallMs = (performance.now() - t0).toFixed(0);
    pushStat(`[jxl-stress] picks=${stress.picks.length} sizes=${stress.sizes.length} repeats=${stress.repeats}  wall ${wallMs} ms`);
    stress.picks.forEach((p, i) => {
        const enc = stress.encode_ms_per_image[i];
        const sz = (stress.encoded_bytes_per_image[i] / 1024).toFixed(0);
        pushStat(`[jxl-stress] pick ${i + 1}  enc ${enc} ms  ${sz} KB  ${p}`);
    });

    pushStat(`[jxl-stress] ${_benchPad('image', 32)} ${_benchPad('lib', 11)} ${_benchPadN('size', 5)} ${_benchPadN('min', 8)} ${_benchPadN('mean', 8)} ${_benchPadN('p50', 8)} ${_benchPadN('p95', 8)} ${_benchPadN('max', 8)} ${_benchPadN('rs-mean', 9)} ${_benchPadN('total', 9)}`);
    const fmt = (v) => `${(v || 0).toFixed(1)}ms`;
    for (const r of stress.rows) {
        const name = r.source_path.split(/[\\/]/).pop();
        pushStat(
            `[jxl-stress] ${_benchPad(name, 32)} ${_benchPad(r.library, 11)} ${_benchPadN(r.target_long_edge, 5)} ` +
            `${_benchPadN(fmt(r.decode_min_ms), 8)} ${_benchPadN(fmt(r.decode_mean_ms), 8)} ${_benchPadN(fmt(r.decode_p50_ms), 8)} ` +
            `${_benchPadN(fmt(r.decode_p95_ms), 8)} ${_benchPadN(fmt(r.decode_max_ms), 8)} ` +
            `${_benchPadN(fmt(r.resize_mean_ms), 9)} ${_benchPadN(fmt(r.total_mean_ms), 9)}`,
        );
    }

    // Library × size aggregate across all picks (decode mean).
    const agg = new Map();
    for (const r of stress.rows) {
        const k = `${r.library}|${r.target_long_edge}`;
        if (!agg.has(k)) agg.set(k, { lib: r.library, size: r.target_long_edge, n: 0, decode: 0, resize: 0 });
        const a = agg.get(k);
        a.n += 1;
        a.decode += r.decode_mean_ms;
        a.resize += r.resize_mean_ms;
    }
    pushStat(`[jxl-stress] ─── aggregate (mean across ${stress.picks.length} images) ───`);
    for (const a of [...agg.values()].sort((x, y) => x.size - y.size || x.lib.localeCompare(y.lib))) {
        const d = a.decode / a.n;
        const rs = a.resize / a.n;
        pushStat(`[jxl-stress] ${_benchPad(a.lib, 11)} size ${_benchPadN(a.size, 5)}  decode ${fmt(d)}  resize ${fmt(rs)}  total ${fmt(d + rs)}`);
    }
    pushStat('[jxl-stress] done');
}

const jxlBenchBtn = document.getElementById('run-jxl-bench');
if (jxlBenchBtn) {
    jxlBenchBtn.addEventListener('click', () => {
        jxlBenchBtn.disabled = true;
        runJxlDecodeBench().catch(e => pushStat(`[jxl-bench] ${e?.message || e}`))
                           .finally(() => { jxlBenchBtn.disabled = false; });
    });
}

const jxlSweepBtn = document.getElementById('run-jxl-sweep');
if (jxlSweepBtn) {
    jxlSweepBtn.addEventListener('click', () => {
        jxlSweepBtn.disabled = true;
        runJxlSweep().catch(e => pushStat(`[jxl-sweep] ${e?.message || e}`))
                     .finally(() => { jxlSweepBtn.disabled = false; });
    });
}

const jxlStressBtn = document.getElementById('run-jxl-stress');
if (jxlStressBtn) {
    jxlStressBtn.addEventListener('click', () => {
        jxlStressBtn.disabled = true;
        runJxlStress().catch(e => pushStat(`[jxl-stress] ${e?.message || e}`))
                      .finally(() => { jxlStressBtn.disabled = false; });
    });
}

async function runJxlThumb() {
    if (!IS_TAURI) {
        pushStat('[jxl-thumb] Tauri-only — run inside the desktop app');
        return;
    }
    const defaultFolder = 'C:\\995\\2026-01-09 Birthday at Cederberg';
    const folder = prompt('JXL thumb bench — folder of ORFs:', defaultFolder) || defaultFolder;
    const quality = 95;
    const defaultOut = `C:\\foo\\raw-converter-tauri\\bench-output\\thumbs_q${quality}`;
    const outputDir = prompt('Output directory for thumb JXLs:', defaultOut) || defaultOut;
    const sizes = [150, 300, 640, 1080, 1920];
    const gallerySizes = [150, 300];
    const galleryCount = 100;
    const repeats = 3;
    const effort = 3;
    pushStat(`[jxl-thumb] starting  folder=${folder}  out=${outputDir}  sizes=${sizes.join('/')}  gallery=${gallerySizes.join('/')} ×${galleryCount}  reps=${repeats}  q=${quality}  e=${effort}`);
    const t0 = performance.now();
    const unlisten = await listen('bench_progress', ({ payload }) => {
        if (payload?.stage === 'thumb') pushStat(`[jxl-thumb] ${payload.msg}`);
    });
    let result;
    try {
        result = await invoke('bench_jxl_thumb', {
            folder,
            outputDir,
            sizes,
            gallerySizes,
            galleryCount,
            repeats,
            quality,
            effort,
        });
    } catch (e) {
        pushStat(`[jxl-thumb] FAILED: ${e?.message || e}`);
        unlisten();
        return;
    }
    unlisten();
    const wallMs = (performance.now() - t0).toFixed(0);
    pushStat(`[jxl-thumb] picks=${result.picks.length} sizes=${result.sizes.length}  wall ${wallMs} ms`);

    // Per-image per-size table.
    pushStat(`[jxl-thumb] ${_benchPad('image', 24)} ${_benchPadN('size', 5)} ${_benchPadN('wxh', 11)} ${_benchPadN('bytes', 8)} ${_benchPadN('enc', 7)} ${_benchPadN('libjxl', 9)} ${_benchPadN('oxide', 9)}`);
    for (const r of result.size_rows) {
        const name = r.source_path.split(/[\\/]/).pop();
        const dim = `${r.width}×${r.height}`;
        const kb = `${(r.encoded_bytes/1024).toFixed(1)}KB`;
        pushStat(
            `[jxl-thumb] ${_benchPad(name, 24)} ${_benchPadN(r.long_edge, 5)} ${_benchPadN(dim, 11)} ${_benchPadN(kb, 8)} ` +
            `${_benchPadN(r.encode_ms + 'ms', 7)} ${_benchPadN(r.libjxl_decode_mean_ms.toFixed(0) + 'ms', 9)} ${_benchPadN(r.oxide_decode_mean_ms.toFixed(0) + 'ms', 9)}`
        );
    }

    // Aggregate per size (mean across images).
    const sizeAgg = new Map();
    for (const r of result.size_rows) {
        const a = sizeAgg.get(r.long_edge) || { n: 0, bytes: 0, enc: 0, libjxl: 0, oxide: 0 };
        a.n += 1;
        a.bytes += r.encoded_bytes;
        a.enc += r.encode_ms;
        a.libjxl += r.libjxl_decode_mean_ms;
        a.oxide += r.oxide_decode_mean_ms;
        sizeAgg.set(r.long_edge, a);
    }
    pushStat(`[jxl-thumb] ─── per-size mean (across ${result.picks.length} images) ───`);
    for (const [size, a] of [...sizeAgg.entries()].sort((x, y) => x[0] - y[0])) {
        const kb = (a.bytes / a.n / 1024).toFixed(1);
        pushStat(`[jxl-thumb] size ${_benchPadN(size, 4)}  ${_benchPadN(kb + 'KB', 9)}  enc ${(a.enc/a.n).toFixed(0)}ms  libjxl ${(a.libjxl/a.n).toFixed(0)}ms  oxide ${(a.oxide/a.n).toFixed(0)}ms`);
    }

    // DC probe.
    pushStat(`[jxl-thumb] ─── DC-only probe (libjxl progressive flush) ───`);
    pushStat(`[jxl-thumb] ${_benchPad('image', 24)} ${_benchPadN('full-dec', 10)} ${_benchPadN('dc-dec', 10)} ${_benchPadN('speedup', 9)} note`);
    for (const r of result.dc_rows) {
        const name = r.source_path.split(/[\\/]/).pop();
        const full = `${r.libjxl_full_decode_ms}ms`;
        if (r.libjxl_dc_decode_ms != null) {
            const dc = `${r.libjxl_dc_decode_ms}ms`;
            const sp = (r.libjxl_full_decode_ms / Math.max(r.libjxl_dc_decode_ms, 1)).toFixed(1) + '×';
            pushStat(`[jxl-thumb] ${_benchPad(name, 24)} ${_benchPadN(full, 10)} ${_benchPadN(dc, 10)} ${_benchPadN(sp, 9)} ok`);
        } else {
            pushStat(`[jxl-thumb] ${_benchPad(name, 24)} ${_benchPadN(full, 10)} ${_benchPadN('—', 10)} ${_benchPadN('—', 9)} ${r.libjxl_dc_error || 'no DC stage'}`);
        }
    }

    // Gallery simulation.
    pushStat(`[jxl-thumb] ─── gallery simulation (${galleryCount} decodes, ${result.gallery_rows[0]?.unique_thumbs || 0} unique cycled) ───`);
    pushStat(`[jxl-thumb] ${_benchPadN('size', 5)} ${_benchPad('library', 11)} ${_benchPadN('total', 9)} ${_benchPadN('mean/dec', 11)}`);
    for (const r of result.gallery_rows) {
        pushStat(`[jxl-thumb] ${_benchPadN(r.long_edge, 5)} ${_benchPad(r.library, 11)} ${_benchPadN(r.total_ms + 'ms', 9)} ${_benchPadN(r.mean_per_decode_ms.toFixed(1) + 'ms', 11)}`);
    }
    pushStat('[jxl-thumb] done');
}

const jxlThumbBtn = document.getElementById('run-jxl-thumb');
if (jxlThumbBtn) {
    jxlThumbBtn.addEventListener('click', () => {
        jxlThumbBtn.disabled = true;
        runJxlThumb().catch(e => pushStat(`[jxl-thumb] ${e?.message || e}`))
                     .finally(() => { jxlThumbBtn.disabled = false; });
    });
}

async function runJxlDisk() {
    if (!IS_TAURI) {
        pushStat('[jxl-disk] Tauri-only — run inside the desktop app');
        return;
    }
    const folder = prompt('JXL disk arch bench — source ORF folder:', 'C:\\995\\2026-01-09 Birthday at Cederberg') || 'C:\\995\\2026-01-09 Birthday at Cederberg';
    const workDir = prompt('Working directory for sidecar + bundle:', 'C:\\foo\\raw-converter-tauri\\bench-output\\disk') || 'C:\\foo\\raw-converter-tauri\\bench-output\\disk';
    const flushFile = prompt('Flush file path (will be created if absent):', 'C:\\foo\\raw-converter-tauri\\bench-output\\flush.bin') || 'C:\\foo\\raw-converter-tauri\\bench-output\\flush.bin';
    const flushGbStr = prompt('Flush file size in GB (set ≥ system RAM for reliable cold reads):', '20') || '20';
    const flushSizeGb = parseInt(flushGbStr, 10) || 20;
    const nStr = prompt('Number of test files (≤ folder size):', '50') || '50';
    const nFiles = parseInt(nStr, 10) || 50;

    pushStat(`[jxl-disk] starting  folder=${folder}  work=${workDir}  flush=${flushFile} (${flushSizeGb} GB)  n=${nFiles}`);
    const t0 = performance.now();
    const unlisten = await listen('bench_progress', ({ payload }) => {
        if (payload?.stage === 'disk') pushStat(`[jxl-disk] ${payload.msg}`);
    });
    let result;
    try {
        result = await invoke('bench_jxl_disk', {
            folder,
            workDir,
            flushFile,
            flushSizeGb,
            nFiles,
        });
    } catch (e) {
        pushStat(`[jxl-disk] FAILED: ${e?.message || e}`);
        unlisten();
        return;
    }
    unlisten();
    const wallMs = (performance.now() - t0).toFixed(0);
    pushStat(`[jxl-disk] setup ${result.setup_ms} ms  wall ${wallMs} ms`);
    pushStat(`[jxl-disk] ${_benchPad('arch', 18)} ${_benchPad('operation', 14)} ${_benchPadN('n', 4)} ${_benchPadN('read', 9)} ${_benchPadN('decode', 9)} ${_benchPadN('total', 9)} ${_benchPadN('mean/ea', 9)} ${_benchPadN('MB', 8)}`);
    for (const r of result.rows) {
        pushStat(
            `[jxl-disk] ${_benchPad(r.architecture, 18)} ${_benchPad(r.operation, 14)} ${_benchPadN(r.n_files, 4)} ` +
            `${_benchPadN(r.read_total_ms + 'ms', 9)} ${_benchPadN(r.decode_total_ms + 'ms', 9)} ${_benchPadN(r.total_ms + 'ms', 9)} ` +
            `${_benchPadN(r.mean_per_file_ms.toFixed(1) + 'ms', 9)} ${_benchPadN((r.bytes_read / 1024 / 1024).toFixed(1), 8)}`
        );
    }
    pushStat('[jxl-disk] done');
}

const jxlDiskBtn = document.getElementById('run-jxl-disk');
if (jxlDiskBtn) {
    jxlDiskBtn.addEventListener('click', () => {
        jxlDiskBtn.disabled = true;
        runJxlDisk().catch(e => pushStat(`[jxl-disk] ${e?.message || e}`))
                    .finally(() => { jxlDiskBtn.disabled = false; });
    });
}

// Tauri live-look: invoked from triggerLiveUpdate when IS_TAURI
let tauriLiveInFlight = false;
let tauriLivePending = null;

async function triggerLiveUpdateTauri(look) {
    const card = cards[lightboxIndex];
    if (!card || !card._tauriResult) return;
    if (tauriLiveInFlight) { tauriLivePending = look; return; }
    tauriLiveInFlight = true;
    try {
        const buf = await invoke('apply_look', {
            id: card._tauriResult.id,
            look: lookToSnake(look),
        });
        const view = new DataView(buf);
        const w = view.getUint16(0, true);
        const h = view.getUint16(2, true);
        const rgb = new Uint8Array(buf, 4);
        // First slider edit on a card flips the lightbox from embedded JPEG
        // preview (potentially 3:2 ~1620×1080) to the RAW pipeline output
        // (4:3 1800×1350 for Olympus).  Resize the canvas to the RAW dims so
        // putImageData paints the full frame, not just the overlapping rect.
        const dimsChanged = (lightboxCanvas.width !== w || lightboxCanvas.height !== h);
        if (dimsChanged) {
            lightboxCanvas.width = w;
            lightboxCanvas.height = h;
            // Also cache on card so subsequent draws know the RAW dims and
            // the embedded fallback branch matches.
            if (!card._lightbox) card._lightbox = {};
            card._lightbox.w = w;
            card._lightbox.h = h;
        }
        const ctx = lightboxCanvas.getContext('2d');
        ctx.putImageData(new ImageData(rgbToRgbaArr(rgb), w, h), 0, 0);
        if (lightboxCanvas.width > 0) {
            captureCleanAndApplyLens(ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
        }
        // Real RAW pixels now on screen → update colour-coded badge accordingly,
        // and preserve displayed size if the canvas just got resized.
        setPaintedSourceBadge('raw');
        if (dimsChanged) syncZoomToDisplayLong();
    } catch (e) {
        console.warn('apply_look error:', e);
    }
    tauriLiveInFlight = false;
    if (tauriLivePending) { const p = tauriLivePending; tauriLivePending = null; triggerLiveUpdateTauri(p); }
}

// Settings modal (Tauri only)
if (IS_TAURI) {
    const settingsHtml = `
        <dialog id="tauri-settings-dialog" style="padding:1.5rem;border-radius:8px;border:1px solid #444;background:#1a1a1a;color:#eee;min-width:320px">
          <form method="dialog">
            <h3 style="margin-top:0">Planner Settings</h3>
            <label style="display:block;margin-bottom:0.75rem">Bearer token
              <input id="tauri-token-input" type="password" autocomplete="off" style="display:block;width:100%;margin-top:4px;padding:4px;background:#2a2a2a;color:#eee;border:1px solid #555">
            </label>
            <label style="display:block;margin-bottom:1rem">Planner URL
              <input id="tauri-url-input" type="url" value="http://localhost:3001" style="display:block;width:100%;margin-top:4px;padding:4px;background:#2a2a2a;color:#eee;border:1px solid #555">
            </label>
            <button type="submit" style="padding:4px 12px">Save</button>
            <button type="button" onclick="document.getElementById('tauri-settings-dialog').close()" style="padding:4px 12px;margin-left:8px">Cancel</button>
          </form>
        </dialog>`;
    document.body.insertAdjacentHTML('beforeend', settingsHtml);

    const settingsBtn = document.createElement('button');
    settingsBtn.id = 'tauri-settings-btn';
    settingsBtn.title = 'Planner Settings';
    settingsBtn.textContent = '⚙';
    settingsBtn.style.cssText = 'position:fixed;top:8px;right:8px;z-index:9999;padding:4px 8px;background:#2a2a2a;color:#eee;border:1px solid #555;border-radius:4px;cursor:pointer;display:none';
    // document.body.appendChild(settingsBtn);

    settingsBtn.addEventListener('click', async () => {
        const dialog = document.getElementById('tauri-settings-dialog');
        const [settings, token] = await Promise.all([invoke('get_settings'), invoke('get_token')]);
        document.getElementById('tauri-url-input').value = settings.planner_url;
        document.getElementById('tauri-token-input').value = token ? '••••••••' : '';
        dialog.showModal();
    });

    document.getElementById('tauri-settings-dialog').addEventListener('close', async (e) => {
        const dialog = e.target;
        const tokenInput = document.getElementById('tauri-token-input');
        const urlInput = document.getElementById('tauri-url-input');
        if (tokenInput.value && !tokenInput.value.startsWith('•')) {
            await invoke('set_token', { token: tokenInput.value });
        }
        await invoke('set_settings', { settings: { planner_url: urlInput.value } });
    });
}

// ---------------------------------------------------------------------------
// Tauri-parity M2 develop lightbox + H29 streaming-look channel
// ---------------------------------------------------------------------------
//
// The Tauri-parity lightbox (CasaBio FilterEngine M2 + optional 16-bit WebGL
// HDR) is wired into the browser bench here. In the bench there is no Tauri
// `invoke` and no pyramid client, so those are nulled out — the component is
// written to no-op gracefully (selectors → null, 16-bit toggle stays hidden,
// export ROI falls back to a plain canvas PNG). The M2 sliders drive an in-DOM
// FilterEngine repaint over an 8-bit baseline we hand it via onBaseFramePainted.
//
// H29 (Rust streaming develop channel) is capability-detected, not assumed:
// apply_look_stream / jxl_progressive_pass are absent from the shipped pkg
// until the H29 Rust work is built, so `h29` is null today and the channel
// path degrades to the existing live-update flow. When a future WASM rebuild
// exports them, `h29` becomes live and the M2 develop adjustments stream
// through apply_look_stream with jxl_progressive_pass driving refinement.
const h29 = (typeof rawWasm.apply_look_stream === 'function'
          && typeof rawWasm.jxl_progressive_pass === 'function')
    ? { applyLookStream: rawWasm.apply_look_stream, progressivePass: rawWasm.jxl_progressive_pass }
    : null;
let h29WarnedOnce = false;

// Translate the current M2 develop adjustments into a streaming look update.
// Real reference to the H29 exports (capability-gated); when the build lacks
// them it logs exactly once and lets the standard repaint path handle it.
function runH29DevelopChannel(adjustments) {
    if (!h29) {
        if (!h29WarnedOnce) {
            h29WarnedOnce = true;
            console.info('[H29] streaming develop channel unavailable — '
                + 'apply_look_stream / jxl_progressive_pass not in this WASM build; '
                + 'using standard live-update repaint. Rebuild raw-pipeline to enable.');
        }
        return false;
    }
    const card = cards[lightboxIndex];
    if (!card || !card._taskId) return false;
    try {
        // Stream the develop-slider deltas, then drive a progressive refinement
        // pass. Both are the real H29 exports detected above.
        h29.applyLookStream(card._taskId, lookToSnake(adjustments));
        h29.progressivePass(card._taskId);
        return true;
    } catch (e) {
        console.warn('[H29] develop channel failed, falling back:', e);
        return false;
    }
}

// Derive a normalised viewport ROI (in source pixels) from the lightbox zoom/pan
// so Export ROI crops what the user is actually looking at. Falls back to the
// full frame when nothing is zoomed.
function lightboxViewportRegion(imgW, imgH) {
    const full = { x: 0, y: 0, w: imgW, h: imgH };
    const cv = lightboxCanvas;
    if (!cv.width || !cv.height || lbZoom <= 1.0001) return full;
    const vp = lbViewport.getBoundingClientRect();
    // Visible source pixels = viewport size / zoom, centred on the pan offset.
    const visW = Math.min(imgW, Math.ceil((vp.width / lbZoom) * (imgW / cv.width)));
    const visH = Math.min(imgH, Math.ceil((vp.height / lbZoom) * (imgH / cv.height)));
    const cx = (cv.width / 2 - lbPanX / lbZoom) * (imgW / cv.width);
    const cy = (cv.height / 2 - lbPanY / lbZoom) * (imgH / cv.height);
    const x = Math.max(0, Math.min(imgW - visW, Math.round(cx - visW / 2)));
    const y = Math.max(0, Math.min(imgH - visH, Math.round(cy - visH / 2)));
    return { x, y, w: visW, h: visH };
}

const tauriParityLb = createTauriParityLightbox({
    rootEl: lightbox,
    canvas: lightboxCanvas,
    histCanvas: lightbox.querySelector('[data-m2-hist]'),
    // Bench has no Tauri bridge: pass the real invoke when present, else null.
    invoke: (typeof invoke === 'function') ? invoke : null,
    getActiveCard: () => (lightboxIndex >= 0 ? cards[lightboxIndex] : null) || null,
    // When the M2 FilterEngine has no cached baseline (bench single-image), ask
    // the develop channel / live pipeline to re-render the current frame.
    onRepaintRequest: () => {
        const adj = tauriParityLb?.state?.adjustments;
        if (adj && runH29DevelopChannel(adj)) return;
        scheduleLiveUpdate();
    },
    pyramidClient: null,
    getViewportRegion: lightboxViewportRegion,
    getZoom: () => lbZoom,
});
window.tauriParityLb = tauriParityLb;

// Feed the M2 FilterEngine a clean 8-bit baseline whenever a fresh frame lands
// on the lightbox canvas, so its sliders have pixels to transform.
function feedTauriParityBaseline(snapshot) {
    if (!tauriParityLb || lightboxIndex < 0) return;
    const card = cards[lightboxIndex];
    if (!card) return;
    try {
        let img = snapshot;
        if (!img) {
            if (!lightboxCanvas.width || !lightboxCanvas.height) return;
            const ctx = lightboxCanvas.getContext('2d');
            img = ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height);
        }
        tauriParityLb.onBaseFramePainted(card, img.data, img.width, img.height);
    } catch { /* cross-tainted canvas or 0-size: skip baseline feed */ }
}
window.feedTauriParityBaseline = feedTauriParityBaseline;
