// Main thread.  Builds a Worker pool, dispatches each ORF to a free worker,
// streams events back (thumb → lightbox-preview → JXL bytes), and renders
// thumbnails + a clickable lightbox grid.
//
// Worker code lives in ./worker.js — one wasm instance + jSquash JXL
// encoder per worker, single-threaded inside.  Pool size scales with
// `navigator.hardwareConcurrency` so a batch saturates all cores.

import { getContext, setCalibrationPoolSize } from './jxl-browser-context.js';
import { WorkerMsg } from './worker-message-types.js';
import { buildCalibrationMessage, calibrationToPoolSize } from './jxl-calibration-propagation.js';
import { createReadLane } from './jxl-read-lane.js';
import { RAW_ACCEPT, isRawFilename, stripRawExtension } from './raw-extensions.js';
// Finding 14 (P4 T5): single-source accept list + pipeline input predicate derived from
// format-detect.js. Both the picker accept attribute and the drag/drop filter now use
// these exports instead of hand-maintained divergent lists.
import { acceptExtensions, isPipelineInput as _isPipelineInputByName } from './format-detect.js';
// Finding 10 (P4 T5): proxy-first intake mode + "Develop Selected" command logic.
import { makeIntakeMode, selectCardsForDevelop, buildDevelopTask } from './proxy-develop.js';
// Finding 40/41/46/48: per-asset edit/crop/persistence/generation state store.
import { createAssetStateStore, makeAssetId, normalizeCrop as _normalizeCrop } from './asset-state-store.js';
// Finding 48: gated JXL decode cache-write commit (stale-tag guard BEFORE write).
import { commitJxlDecodeCache } from './jxl-decode-cache-policy.js';
// Findings 11, 29: byte-budgeted, LRU-evicting derived cache for decoded JXL
// RGBA buffers. Replaces per-card _jxlDecoded (unbounded WeakMap) with a single
// governed cache; invalidated on generation change and explicit card delete.
import { createDerivedCache } from './jxl-derived-cache.js';
import { createTauriParityLightbox } from './tauri-parity-lightbox.js';
import { readDenoiseOptions, denoiseNeedsReprocess } from './raw-denoise-options.js';
// Finding 47 (P4 T8): lazy-load helper — optional heavy modules are imported
// dynamically on first use, not at page parse time.
import { makeLazyModule } from './lazy-module.js';
// S3: the memory-governed asset store. peepCache's decoded-RGBA LRU is a client
// of it (one governed budget + one eviction policy), replacing the bespoke Map.
// `estimateDecodePeak` + `OUT_BATCH_DEFAULT` back the hard decode-admission gate
// below (S3-Q3); it mirrors the Rust `estimate_decode_peak` memory model.
// `AdmissionRejected` is thrown when the projected peak blows the WASM-heap budget.
import {
    AssetStore,
    AdmissionRejected,
    estimateDecodePeak,
    OUT_BATCH_DEFAULT,
} from '../packages/asset-store/src/index.js';
// Capability-detection namespace import over the RAW WASM pkg. Binding the
// module does NOT instantiate WASM (init is lazy via default()/initSync), so
// this is safe at page load. We only read which functions the build exported —
// the H29 develop-channel fns (apply_look_stream / jxl_progressive_pass) are
// absent until the Rust H29 work is built, so the channel path stays gated.
import * as rawWasm from './pkg/raw_converter_wasm.js';

// ---------------------------------------------------------------------------
// Finding 47 (P4 T8): lazy-loaded optional modules.
//
// Each heavy/optional module is imported dynamically on first use (at the
// existing command boundary) so parse + eval cost is deferred past first paint.
// One-time memoised via makeLazyModule — concurrent callers share the same
// promise; failures are not memoised (transient errors are retryable).
//
// formatLabel (from export-service.js) is a tiny pure function inlined here
// so the info panel (shown whenever the lightbox opens) does not force a load
// of the full export-service module.
// ---------------------------------------------------------------------------

/**
 * Lazy: perceptual-color.mjs — Perceptual Lens + Colour Selector maths.
 * Loaded on first P-key press / lens-toggle click.
 */
const lazyPerceptual = makeLazyModule(() => import('./perceptual-color.mjs'));

/**
 * Lazy: tauri-parity-lightbox.js — M2/HDR FilterEngine lightbox.
 * Loaded + constructed on first lightbox open.
 */
const lazyTauriParity = makeLazyModule(() => import('./tauri-parity-lightbox.js'));

/**
 * Lazy: export-service.js + png-encode.js — full-res export pipeline.
 * Co-loaded on first "Export selected" click.
 */
const lazyExport = makeLazyModule(async () => {
    const [exportMod, pngMod] = await Promise.all([
        import('./export-service.js'),
        import('./png-encode.js'),
    ]);
    return { ...exportMod, encodePng: pngMod.encodePng };
});

// ---------------------------------------------------------------------------
// formatLabel — inlined from export-service.js (finding 45) so the info panel
// does not force an export-service module load on every lightbox open.
// Keep in sync with export-service.js:formatLabel.
// ---------------------------------------------------------------------------
function _formatLabel(exif) {
    if (!exif || !exif.format) return 'Unknown';
    const { format, bitDepth } = exif;
    if (bitDepth && bitDepth > 0) return `${format} (${bitDepth}-bit)`;
    return format;
}

// On-page console: mirror console.* (and relayed worker logs) into a panel so
// debugging doesn't require DevTools. Panel + toggle live in index.html.
(function initPageConsole() {
    const append = (kind, parts) => {
        const p = document.getElementById('page-console');
        if (!p) return;
        const line = document.createElement('div');
        if (kind === 'warn') line.style.color = '#fd0';
        else if (kind === 'error') line.style.color = '#f66';
        line.textContent = parts.map((a) => {
            if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
            return String(a);
        }).join(' ');
        p.appendChild(line);
        while (p.childNodes.length > 600) p.removeChild(p.firstChild);
        p.scrollTop = p.scrollHeight;
    };
    for (const k of ['log', 'warn', 'error', 'info']) {
        const orig = console[k].bind(console);
        console[k] = (...a) => { try { append(k === 'info' ? 'log' : k, a); } catch {} orig(...a); };
    }
    window.pushDbg = (...a) => console.log(...a);
})();

const IS_TAURI = typeof window !== 'undefined' && !!window.__TAURI__;
window.IS_TAURI = IS_TAURI;
const { invoke } = IS_TAURI ? window.__TAURI__.core : {};
const { listen } = IS_TAURI ? window.__TAURI__.event : {};

// Apply a persisted hardware-calibration profile (if any) BEFORE pool sizing, so the
// worker count reflects this machine's measured throughput-optimal split. Synchronous
// localStorage read (fast); the full (re)calibration measurement runs async elsewhere
// and persists for the next load. Canonical schema: web/calibration/profile.mjs.
// HC-gated so a profile from a differently-sized machine is ignored.
try {
    const __calRaw = localStorage.getItem('rawpipe.calibration.v1');
    if (__calRaw) {
        const __cal = JSON.parse(__calRaw);
        if (
            __cal && __cal.schemaVersion === 1 && __cal.selections && __cal.signature &&
            __cal.signature.hardwareConcurrency === (navigator.hardwareConcurrency || 4)
        ) {
            globalThis.__rawCalibration = { ...__cal.selections };
        }
    }
} catch { /* storage blocked / unparseable → uncalibrated defaults */ }

const POOL_SIZE = (globalThis.__rawCalibration && globalThis.__rawCalibration.workers)
    ? Math.max(1, globalThis.__rawCalibration.workers)
    : Math.min(navigator.hardwareConcurrency || 4, 12);

// Finding 9: feed calibrated pool size to the shared JxlContext BEFORE first use.
// calibrationToPoolSize extracts workers from the profile; setCalibrationPoolSize
// forwards it to createBrowserContext so the jxl-session scheduler honours the
// measured worker count rather than its own HC-based default.
setCalibrationPoolSize(calibrationToPoolSize(globalThis.__rawCalibration ? { selections: globalThis.__rawCalibration } : null));

// Assessment switch (default OFF = blob/O1 behaviour unchanged). Add
// `?alphaProgressive=1` to the page URL to let alpha/extra-channel VarDCT
// images emit intermediate progressive paints, so the win (or lack of it) can
// be measured on real images. Requires the fork (0.12) decode WASM; the stock
// 0.11.2 module ignores it. Forwarded to the jxl-session decode options.
const ALPHA_PROGRESSIVE = (() => {
    try {
        return new URLSearchParams(globalThis.location?.search ?? '')
            .get('alphaProgressive') === '1';
    } catch (_) { return false; }
})();

// Build tag the page reports — lets you tell at a glance whether the
// browser is on the latest version after a refresh.
const BUILD_TAG = '2026-07-09a / LibRaw RAW ingest filters';

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
// Finding 14 (P4 T5): derive accept from the canonical format detector — one source of truth.
fileInput.accept = acceptExtensions();
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
const lbArchivalBtn = lightbox.querySelector('.lb-archival-btn');
const lbIdentifyBtn = lightbox.querySelector('.lb-identify-btn');
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

// Decode the parent's full-resolution JXL into the jxlDerivedCache if not already
// cached. Used by crop.js to render focal-subject thumbnails from the JXL
// roundtrip. Returns a promise that resolves when the buffer is in place.
window.decodeFullJxlFor = function decodeFullJxlFor(card) {
    return new Promise((resolve) => {
        if (!getCardState(card)?._blobUrl) { resolve(null); return; }
        // Findings 11, 29: check the governed DerivedCache first.
        const _fullAssetId = getCardState(card)?._assetId;
        const _cached = _fullAssetId ? jxlDerivedCache.get(_fullAssetId) : getCardState(card)['_jxlDecoded'];
        if (_cached) { resolve(_cached); return; }
        // Finding 48: stamp the generation tag at dispatch so a stale result
        // from a prior reprocess cannot commit to the cache.
        // Keep null for a genuinely id-less card (backward compatible).
        const _fullTag = (() => {
            return _fullAssetId ? assetStateStore.makeResultTag(_fullAssetId) : null;
        })();
        decodeJxlViaSession(getCardState(card)._blobUrl, (msg) => {
            if (msg.type === 'decode_error') { resolve(null); return; }
            if (msg.type !== 'jxl_decoded' && msg.isFinal !== true) return;
            // Findings 11, 29: read from DerivedCache (populated by applyJxlDecodeCachePolicy).
            const _hit = _fullAssetId ? jxlDerivedCache.get(_fullAssetId) : getCardState(card)['_jxlDecoded'];
            resolve(_hit ?? { rgba: msg.rgba, w: msg.w, h: msg.h });
        }, 'low', {
            progressive: true,
            cachePolicy: 'onFinal',
            progressiveDetail: 'lastPasses',
            cacheTarget: card,
            cacheTag: _fullTag, // Finding 48: gate cache write on generation
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
    getCardState(parentCard)._focusedSubjectId = subjectId;
    // After open, queue a frame to apply the subject zoom — the canvas needs
    // to have been painted first.
    requestAnimationFrame(() => focusOnSubject(parentCard, subjectId));
};

function focusOnSubject(card, subjectId) {
    const subj = (getCardState(card)?._subjects || []).find(s => s.id === subjectId);
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
        // Optional automatic RAW denoise (Detail column). Normalized canonical
        // shape; travels verbatim to the worker, which forwards it to the WASM
        // *_with_options RAW decoders. Default {enabled:false} = no-op.
        denoise: readDenoiseOptions(document),
    };
}

// --- Finding 10 (P4 T5): intake mode control (proxy-first vs full-develop) ----
// proxyViewMode is now backed by the makeIntakeMode() state machine from proxy-develop.js
// instead of a raw boolean, so the UI checkbox and the console API share a single
// source of truth. The 'proxy' checkbox in index.html reads/writes this via
// window.setProxyView. The "Develop Selected" button calls developSelected().
const _intakeMode = makeIntakeMode(
    (() => { try { return localStorage.getItem('proxyView') === '1'; } catch { return false; } })()
);
// Backwards-compatible getter so all existing `proxyViewMode` reads below still work.
let proxyViewMode = _intakeMode.isProxy();
// Keep proxyViewMode in sync whenever the mode changes.
function _syncProxyViewMode() { proxyViewMode = _intakeMode.isProxy(); }

// Public API (console + UI checkbox).
window.setProxyView = (on) => {
    _intakeMode.set(on);
    _syncProxyViewMode();
    try { localStorage.setItem('proxyView', on ? '1' : '0'); } catch {}
    // Reflect in UI checkbox if present.
    const cb = document.getElementById('proxy-intake-toggle');
    if (cb) cb.checked = _intakeMode.isProxy();
    return _intakeMode.isProxy();
};

// "Develop Selected" — Finding 10 (P4 T5): develop only the selected proxy-completed
// cards through the P4 T1 scheduler at high priority. Does NOT call reprocessSelected()
// (which would re-ingest ALL selected cards including already-developed ones); instead
// it submits ONLY the proxy cards that still need a full RAW decode, using startConvert
// (the canonical ingest entry point) with the card's existing _file reference.
// State is preserved: _embeddedPreview, crop, subjects, sidecar dot are all intact.
window.developSelected = function developSelected() {
    // Build the card adapter list from the gallery (DOM-level selection).
    const adapters = cards.map(c => ({
        selected: c.classList.contains('selected'),
        state:    getCardState(c),
        _card:    c,
    }));
    const eligible = selectCardsForDevelop(adapters);
    if (!eligible.length) {
        if (typeof pushStat === 'function')
            pushStat('[develop-selected] no proxy-completed selected cards to develop');
        return;
    }
    for (const adapter of eligible) {
        const card = adapter._card;
        const task = buildDevelopTask(adapter, currentOptions());
        // Mark high priority so the scheduler front-queues this card.
        getCardState(card)._pendingPriority = task.priority;
        // _forceDevelop bypasses the global proxyViewMode gate in startConvert so the
        // full RAW pipeline runs even if proxy-first intake is currently enabled.
        getCardState(card)._forceDevelop = true;
        // startConvert with the existing card re-uses card state (crop, subjects,
        // embeddedPreview) and goes through the full RAW pipeline. No duplication
        // of process logic — this IS the existing process path.
        startConvert(task.file, card);
    }
    if (typeof pushStat === 'function')
        pushStat(`[develop-selected] submitted ${eligible.length} card(s) at high priority`);
};
function proxyCompleteCard(card, largest) {
    // The embedded preview IS the deliverable: it is already drawn on the card canvas
    // (drawOrientedThumb in Phase A). Show the JPEG download, mark done — no RAW decode.
    getCardState(card)._sourceMode = 'jpeg';
    getCardState(card)._proxyView = true;
    card.classList.remove('busy', 'embedded-thumb', 'encoding');
    const dl = card.querySelector('.thumb-dl-btn'); if (dl) dl.hidden = false;
    getCardState(card)._meta = `${largest.w}×${largest.h} • camera JPEG (proxy — RAW decode skipped)`;
    const sizeEl = card.querySelector('.size'); if (sizeEl) sizeEl.textContent = 'JPEG';
    refreshThumbToggleButton(card);
    totalDone++;
    refreshStatus();
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
    const selected = cards.filter(c => c.classList.contains('selected') && getCardState(c)._file);
    const targets = selected.length ? selected : cards.filter(c => getCardState(c)._file);
    if (!targets.length) return;
    if (!selected.length) {
        // No explicit selection — select all, then reprocess all.
        for (const c of cards) {
            if (getCardState(c)._file) {
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
// Finding 48: `tag` is the per-listener result-tag captured at dispatch. The
// cache commit is gated on assetStateStore.isStale(tag, state) BEFORE the write
// (inside commitJxlDecodeCache), so a decode that finishes after a reprocess
// (generation bump) can no longer poison the card cache with stale pixels. The
// isStale guard inside each decode callback only protects the canvas paint — the
// cache write must be guarded here, at the point of write.
function applyJxlDecodeCachePolicy(card, decodeId, pixels, w, h, isFinal, policy, tag) {
    if (!card) return;
    commitJxlDecodeCache({
        target: getCardState(card),
        tag: tag ?? null,
        store: assetStateStore,
        // Findings 11, 29: route the write through the governed DerivedCache.
        derivedCache: jxlDerivedCache,
        seen: jxlFirstProgressCacheSeen,
        decodeId, pixels, w, h, isFinal, policy,
    });
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
        // Finding 3: _jxl* private queue/state removed. JXL decodes now route
        // through decodeJxlViaSession() which uses getContext() (the shared
        // jxl-session scheduler) for priority ordering, dedupe, and cancellation.
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
        // Finding 9: post calibrated thread count BEFORE any other message so
        // ensureWasm → initThreadPool uses the right per-worker thread budget.
        // globalThis.__rawCalibration is set synchronously at startup from the
        // persisted profile; absent = no-op (worker falls back to HC default).
        if (globalThis.__rawCalibration) {
            w.postMessage(buildCalibrationMessage({ selections: globalThis.__rawCalibration }));
        }
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
        if (type === 'wlog') { console.log('[worker]', ev.data.text); return; }
        if (type === WorkerMsg.LIGHTBOX_LIVE || type === WorkerMsg.ERROR_LIVE) {
            if (this._liveHandler) this._liveHandler(ev.data);
            return;
        }
        if (type === WorkerMsg.THUMB_LIVE) {
            if (this._thumbLiveHandler) this._thumbLiveHandler(ev.data);
            return;
        }
        if (type === WorkerMsg.BLISS_READY) {
            blissCache.set(id, { bliss: ev.data.bliss, width: ev.data.width, height: ev.data.height });
            // Persist to OPFS for cross-session instant preview.
            const _bc = cardByTaskId.get(id);
            const _baid = _bc && getCardState(_bc)?._assetId;
            if (_baid) blissOpfsWrite(_baid, ev.data.bliss).catch(() => undefined);
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
            blissCache.delete(id);
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
            blissCache.delete(id);
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

    // Finding 3: the private JXL queue methods removed.
    // JXL decode now goes through decodeJxlViaSession() (module level) which
    // uses getContext() (the shared jxl-session scheduler) for priority ordering,
    // dedupe, and concurrent execution. The dedicated decode worker is no longer spawned.

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
// Finding 3: the dedicated JXL decode worker is no longer spawned here.
// JXL decode routes through decodeJxlViaSession() → getContext() (jxl-session scheduler).

// Finding 44: optional `metadata` param carries { exif?: Uint8Array, xmp?: Uint8Array }
// through to the JXL encode session so EXIF/XMP bytes are embedded in the output file.
// The RAW pipeline produces these bytes at the worker level; the export service applies
// the privacy policy (keep/strip-gps/strip-all) before passing them here.
// Packet-3 integration point: when a metadata-preserving encoder lands, it will supply
// the exact EXIF block; for now we pass synthesized EXIF from the json exif blob if
// available (the JXL encoder handles null gracefully — it just omits the EXIF box).
async function encodeJxlSession(pixels, width, height, quality, effort, lossless, progressive, format = 'rgba8', orientation, metadata = null) {
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
    // Finding 44: pass raw EXIF/XMP bytes into the JXL container when provided.
    if (metadata?.exif instanceof Uint8Array) encOpts.exif = metadata.exif;
    if (metadata?.xmp  instanceof Uint8Array) encOpts.xmp  = metadata.xmp;
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
// JXL decode via shared jxl-session scheduler (finding 3)
//
// Replaces the private _jxl* queue in WorkerPool with the jxl-session scheduler
// for JXL decodes. The jxl-session handles priority ordering, concurrent execution,
// and backpressure. We maintain URL-level dedupe here so a blob URL requested
// multiple times fans out to one decode session.
//
// Protocol bridge: jxl-session decode events → legacy callback message format.
//   decode_header → { type: 'jxl_header', decodeId, w, h }
//   'dc'/'pass' frame → { type: 'jxl_progress', decodeId, rgba, w, h, isFinal: false, ... }
//   'final' frame → { type: 'jxl_progress', isFinal: true } + { type: 'jxl_decoded', ... }
//   error → { type: 'decode_error', decodeId, error }
// ---------------------------------------------------------------------------

// URL → { session, listeners: [{ cb, options }], abortCtrl } (dedup map)
const _jxlDecodeByUrl = new Map();
let _jxlNextDecodeId = 1;

/**
 * Priority mapping: the old queue used 'high'|'normal'|'low'; jxl-session uses
 * 'visible'|'near'|'background'. Map: high→visible, normal→near, low→background.
 */
function _mapJxlPriority(p) {
    if (p === 'high') return 'visible';
    if (p === 'low') return 'background';
    return 'near';
}

/**
 * Decode a JXL file from a blob URL, routing through the shared jxl-session scheduler.
 * Implements the same external API as the removed decodeJxlViaSession():
 *   decodeJxlViaSession(url, callback, priority?, options?)
 *
 * Dedupe: if the same URL is already being decoded, adds the callback as a fan-out
 * listener. Multiple callers share one decode session's output.
 *
 * @param {string} url
 * @param {(msg: any) => void} callback
 * @param {'high'|'normal'|'low'} [priority='normal']
 * @param {object} [options]
 */
function decodeJxlViaSession(url, callback, priority = 'normal', options = {}) {
    const decodeId = _jxlNextDecodeId++;

    // Dedupe: fan out to an existing in-flight decode for this URL.
    const existing = _jxlDecodeByUrl.get(url);
    if (existing) {
        existing.listeners.push({ cb: callback, options: { ...options } });
        return;
    }

    const listeners = [{ cb: callback, options: { ...options } }];
    const abortCtrl = new AbortController();
    _jxlDecodeByUrl.set(url, { listeners, abortCtrl, decodeId });

    const sessionPriority = _mapJxlPriority(priority);

    // Broadcast one message to all current listeners for this URL.
    function broadcast(msg) {
        const entry = _jxlDecodeByUrl.get(url);
        if (!entry) return;
        for (const listener of entry.listeners) {
            if (typeof listener.options?.guard === 'function' && !listener.options.guard()) continue;
            const isFinal = msg.type === 'jxl_decoded' || msg.isFinal === true;
            if (msg.type === 'jxl_progress' || msg.type === 'jxl_decoded') {
                const ct = listener.options?.cacheTarget;
                if (!(ct && ct.isConnected === false)) {
                    // Finding 48: pass this listener's result-tag so the cache
                    // commit is gated on staleness BEFORE the write, not after.
                    applyJxlDecodeCachePolicy(ct, msg.decodeId, msg.rgba, msg.w, msg.h, isFinal, listener.options?.cachePolicy ?? 'never', listener.options?.cacheTag ?? null);
                }
            }
            try { listener.cb(msg); } catch {}
        }
    }

    function cleanup() {
        _jxlDecodeByUrl.delete(url);
        jxlFirstProgressCacheSeen.delete(decodeId);
    }

    // Async decode pipeline: fetch bytes → create session → push → iterate frames.
    (async () => {
        let buf;
        try {
            const resp = await fetch(url, { signal: abortCtrl.signal });
            buf = await resp.arrayBuffer();
        } catch (err) {
            if (!abortCtrl.signal.aborted) {
                broadcast({ type: 'decode_error', decodeId, error: String(err?.message ?? err) });
            }
            cleanup();
            return;
        }

        // I-2: the try block starts here — BEFORE getContext().decode() — so a
        // synchronous throw from getContext() (context-creation failure) runs
        // cleanup() via the finally and evicts the _jxlDecodeByUrl entry.
        // A dangling entry would cause a subsequent same-URL decode to fan out
        // to a dead session that never emits.
        let session;
        try {
            session = getContext().decode({
                format: 'rgba8',
                priority: sessionPriority,
                signal: abortCtrl.signal,
                emitEveryPass: options?.progressive !== false,
                progressiveDetail: options?.progressiveDetail ?? 'lastPasses',
                region: options?.region ?? null,
                downsample: options?.downsample ?? 1,
                frameIndex: options?.frameIndex ?? 0,
                preserveIcc: true,
                preserveMetadata: true,
            });

            // Consume frames as they arrive, bridging to the legacy message format.
            const framesPromise = (async () => {
                for await (const frame of session.frames()) {
                    const w = frame.info?.width ?? 0;
                    const h = frame.info?.height ?? 0;
                    // Normalise pixels to Uint8ClampedArray for ImageData compatibility.
                    let rgba;
                    if (frame.pixels instanceof Uint8ClampedArray
                        && frame.pixels.byteOffset === 0
                        && frame.pixels.byteLength === frame.pixels.buffer.byteLength) {
                        rgba = frame.pixels;
                    } else if (frame.pixels instanceof Uint8Array
                        && frame.pixels.byteOffset === 0
                        && frame.pixels.byteLength === frame.pixels.buffer.byteLength) {
                        rgba = new Uint8ClampedArray(frame.pixels.buffer);
                    } else {
                        rgba = new Uint8ClampedArray(
                            frame.pixels instanceof ArrayBuffer ? frame.pixels : frame.pixels,
                        );
                    }
                    const isFinal = frame.stage === 'final';
                    if (isFinal) {
                        // Emit jxl_progress with isFinal:true first (same pattern as jxl-decode-worker).
                        const copy = new Uint8ClampedArray(rgba);
                        broadcast({ type: 'jxl_progress', decodeId, rgba, w, h, isFinal: true,
                                     stage: frame.stage, frameIndex: frame.frameIndex ?? 0 });
                        broadcast({ type: 'jxl_decoded',  decodeId, rgba: copy, w, h, isFinal: true,
                                     stage: frame.stage, frameIndex: frame.frameIndex ?? 0 });
                    } else {
                        broadcast({ type: 'jxl_progress', decodeId, rgba, w, h, isFinal: false,
                                     stage: frame.stage, frameIndex: frame.frameIndex ?? 0 });
                    }
                }
            })();

            await session.push(buf);
            await session.close();
            await framesPromise;
        } catch (err) {
            if (!abortCtrl.signal.aborted) {
                broadcast({ type: 'decode_error', decodeId, error: String(err?.message ?? err) });
            }
            // I-2: if push()/close() threw (not from a worker-terminal message),
            // cancel the session best-effort so the scheduler slot is released
            // and the dangling framesPromise stream ends.
            try { session?.cancel(); } catch {}
        } finally {
            cleanup();
        }
    })();
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
    if (!card || !getCardState(card)._taskId) return;
    if (!pool.reprocessLive(getCardState(card)._taskId, look)) return;
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
        if (msg.type === WorkerMsg.LIGHTBOX_LIVE && card && msg.id === getCardState(card)._taskId) {
            // Phase 2: worker sends sensor-orientation pixels + orientation tag.
            // Apply rotation via GPU canvas transform — no CPU pixel-shuffle.
            const sW = msg.nativeW ?? msg.w;
            const sH = msg.nativeH ?? msg.h;
            const ori = msg.orientation ?? 1;
            // Orientation-1 paints return their ImageData (TTFP-2 pattern) —
            // skip the per-slider-tick full-canvas readback on that path.
            const liveFrame = drawSensorWithOrientation(lightboxCanvas, msg.rgb, sW, sH, ori);
            if (lightboxCanvas.width > 0) {
                const ctx = lightboxCanvas.getContext('2d');
                captureCleanAndApplyLens(liveFrame ?? ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
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
// Automatic RAW denoise controls (Detail column).
//
// Denoise is applied inside the WASM RAW pipeline BEFORE demosaic/tone, so a
// change requires a full re-decode from raw data — it CANNOT be served by the
// live LookRenderer (whose cached RGB16 is already post-denoise). We therefore
// route denoise edits through reprocessSelected() (a full startConvert re-decode),
// never scheduleLiveUpdate() / LookRenderer.render().
const denoiseEnabledEl = document.getElementById('denoise-enabled');
const denoiseActivationEl = document.getElementById('denoise-activation');
const denoiseIsoThresholdRow = document.getElementById('denoise-iso-threshold-row');
const denoiseActivationRow = document.getElementById('denoise-activation-row');
const denoiseSensitivityRow = document.getElementById('denoise-sensitivity-row');

// Show/hide the sub-controls: they only matter when denoise is enabled, and the
// ISO≥ threshold only matters in 'iso' activation mode.
function syncDenoiseControlVisibility() {
    const on = !!(denoiseEnabledEl && denoiseEnabledEl.checked);
    if (denoiseActivationRow) denoiseActivationRow.hidden = !on;
    if (denoiseSensitivityRow) denoiseSensitivityRow.hidden = !on;
    const isoMode = on && denoiseActivationEl && denoiseActivationEl.value === 'iso';
    if (denoiseIsoThresholdRow) denoiseIsoThresholdRow.hidden = !isoMode;
}

// Track the last denoise options actually dispatched so we only re-decode when a
// change is meaningful (e.g. toggling from off→off must not reprocess).
let lastAppliedDenoise = readDenoiseOptions(document);
function onDenoiseControlChange() {
    syncDenoiseControlVisibility();
    const next = readDenoiseOptions(document);
    const needs = denoiseNeedsReprocess(lastAppliedDenoise, next);
    lastAppliedDenoise = next;
    if (needs) reprocessSelected();
}

for (const el of [denoiseEnabledEl, denoiseActivationEl,
                  document.getElementById('denoise-iso-threshold'),
                  document.getElementById('denoise-sensitivity')]) {
    if (el) el.addEventListener('change', onDenoiseControlChange);
}
syncDenoiseControlVisibility();

// ---------------------------------------------------------------------------
// Gallery live thumb re-render (debounced, fans out to all selected cards)
// ---------------------------------------------------------------------------
const cardByTaskId = new Map();
let galleryDebounceTimer = null;

// ---------------------------------------------------------------------------
// Finding 40/41/46/48: per-asset state store (edit/crop/generation isolation)
// ---------------------------------------------------------------------------
// All editable state (crop, subjects, look, revision) is keyed on a stable
// assetId generated from the file's full path + size + lastModified so two
// files with the same basename in different directories cannot collide.
// The store is the single source of truth for crop/subject persistence and
// for sourceGeneration — a counter incremented whenever the file's bytes
// change (reprocess), used to reject stale async decode results.
const assetStateStore = createAssetStateStore();
// Expose for panels.js / crop.js which run in the same page context.
window._assetStateStore = assetStateStore;
window._makeAssetId     = makeAssetId;
window._normalizeCrop   = _normalizeCrop;

// ---------------------------------------------------------------------------
// CardState WeakMap — canonical per-card state store
// ---------------------------------------------------------------------------
// State is keyed on the card <div> element. The WeakMap holds a plain
// Object.create(null) so GC can collect both key and value once the card
// element leaves the `cards` array and is removed from the DOM.
//
// Proxy getters/setters installed by initCardState keep card._field reads and
// writes in sync with the WeakMap state. This lets external code (crop.js,
// Playwright headless tests) continue to access card._field directly without
// any change, while all internal main.js code uses getCardState(card)._field.
/** @type {WeakMap<Element, CardState>} */
const cardState = new WeakMap();

// Property names that belong to CardState (matches the @typedef below).
// Used by initCardState to install proxy getters/setters on new card elements.
const _CARD_STATE_KEYS = [
    '_file', '_taskId', '_tauriPath', '_pendingPriority', '_pendingLookBatch',
    // Finding 40/48: stable identity + generation counter for each card.
    '_assetId', '_sourceGeneration',
    '_lightbox', '_embeddedPreview', '_blobUrl', '_jxlDecoded',
    '_jxlThumbBmp', '_jxlThumbW', '_jxlThumbH', '_jxlProgressCacheDecodeId',
    '_thumbRgb', '_thumbW', '_thumbH',
    '_thumbNativeW', '_thumbNativeH', '_thumbOrientation',
    '_sensorW', '_sensorH',
    '_sourceMode', '_crop', '_subjects', '_focusedSubjectId',
    '_jxlPrefetching', '_largePreviewFetching', '_largePreviewFetched',
    '_wb', '_colorMatrixFromMn', '_camera', '_exif',
    '_pipelineMs', '_phaseMs', '_meta', '_tauriResult',
    '_laneRelease', '_readAbortCtrl', '_cameraWb',
];

/**
 * Return the CardState object for a card element, or undefined if not initialised.
 * @param {Element} card
 * @returns {CardState|undefined}
 */
function getCardState(card) {
    return cardState.get(card);
}

/**
 * Create and register a CardState for `card`, pre-populated with `initialFields`.
 * Also installs proxy getters/setters on the DOM element so card._field reads and
 * writes continue to work for external code (crop.js, Playwright tests, etc.).
 * @param {Element} card
 * @param {Partial<CardState>} initialFields
 * @returns {CardState}
 */
function initCardState(card, initialFields) {
    const state = Object.assign(Object.create(null), initialFields);
    cardState.set(card, state);
    // Wire proxy getters/setters for each known key.  Closes over `state` so
    // every access is a single property lookup — no WeakMap call overhead.
    for (const key of _CARD_STATE_KEYS) {
        if (!Object.getOwnPropertyDescriptor(card, key)) {
            Object.defineProperty(card, key, {
                get()  { return state[key]; },
                set(v) { state[key] = v; },
                configurable: true,
                enumerable:   true,
            });
        }
    }
    return state;
}

function scheduleGalleryLiveUpdate() {
    clearTimeout(galleryDebounceTimer);
    galleryDebounceTimer = setTimeout(() => triggerGalleryLiveUpdate(currentLook()), 80);
}

function triggerGalleryLiveUpdate(look) {
    const taskIds = cards
        .filter(c => c.classList.contains('selected') && getCardState(c)._taskId)
        .map(c => getCardState(c)._taskId);
    pool.reprocessAllLive(taskIds, look);
}

pool.setThumbLiveHandler((msg) => {
    const card = cardByTaskId.get(msg.id);
    if (card) {
        getCardState(card)._thumbRgb = msg.rgb;
        getCardState(card)._thumbW   = msg.w;
        getCardState(card)._thumbH   = msg.h;
        // Phase 2: sensor dims + orientation for GPU-rotate draw.
        getCardState(card)._thumbNativeW = msg.nativeW ?? msg.w;
        getCardState(card)._thumbNativeH = msg.nativeH ?? msg.h;
        getCardState(card)._thumbOrientation = msg.orientation ?? 1;
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
    // I-1: release the read-lane byte reservation for this card if it is still
    // held. This fires when the worker cancelled the task (emits neither DONE
    // nor ERROR), preventing activeBytes from leaking permanently.
    // _laneRelease is nulled by onDone/onError/arrayBuffer-catch before they
    // call lane_release(), so the release() here only fires on the cancel path.
    if (getCardState(card)._laneRelease) { try { getCardState(card)._laneRelease(); } catch {} getCardState(card)._laneRelease = null; }
    // M-3: abort any still-queued or in-flight read so the AbortSignal wired
    // into readLane.admit() cancels the queued waiter, and the fetch/session
    // signal fires for an in-progress request.
    if (getCardState(card)._readAbortCtrl) { try { getCardState(card)._readAbortCtrl.abort(); } catch {} getCardState(card)._readAbortCtrl = null; }
    if (getCardState(card)._taskId != null) {
        pool.cancelTask(getCardState(card)._taskId);
        try { pool.releaseState(getCardState(card)._taskId); } catch {}
        cardByTaskId.delete(getCardState(card)._taskId);
    }
    if (getCardState(card)._tauriPath != null) cardByFilename.delete(getCardState(card)._tauriPath);
    if (getCardState(card)._blobUrl) { try { URL.revokeObjectURL(getCardState(card)._blobUrl); } catch {} getCardState(card)._blobUrl = null; }
    // Findings 11, 29: evict the derived JXL decode cache entry for this card so
    // its ~80 MB RGBA buffer is freed immediately on delete, not on next GC cycle.
    const _removeAssetId = getCardState(card)._assetId;
    if (_removeAssetId) jxlDerivedCache.delete(_removeAssetId);
    // Close per-card ImageBitmaps so their GPU-backed store is freed eagerly
    // rather than waiting on GC of the detached node — mirrors the explicit
    // .close() the thumb/lightbox paths already do when replacing a bitmap.
    if (getCardState(card)._jxlThumbBmp) { try { getCardState(card)._jxlThumbBmp.close(); } catch {} getCardState(card)._jxlThumbBmp = null; }
    if (getCardState(card)._embeddedPreview?.bmp) { try { getCardState(card)._embeddedPreview.bmp.close(); } catch {} getCardState(card)._embeddedPreview = null; }
    const i = cards.indexOf(card);
    if (i !== -1) cards.splice(i, 1);
    try { card.remove(); } catch {}
}
// Expose for any external/UI caller wiring a delete affordance.
window.removeCard = removeCard;

const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB hard limit before WASM
const seenFiles = new Set(); // "name|size|lastModified" — prevents duplicate-drop cards

// S3-Q3: hard RAW-decode admission gate. `admit()` applies the safety multiplier
// and THROWS `AdmissionRejected` when the projected peak would blow the WASM-heap
// budget; the caller catches it and surfaces a user-visible "too large for the
// memory budget" message on the card (see the preflight block below).
//
// Budget = the WASM linear-heap ceiling. The shipped build's shared memory caps
// at `maximum: 32768` pages × 64 KiB = 2 GiB (pkg glue: `new WebAssembly.Memory
// ({initial:22, maximum:32768, shared:true})`), so ~1.8 GiB (2 GiB minus
// fragmentation/non-heap headroom) is the point past which a decode risks the
// hard OOM. NOT the old 384 MB guess — measured 24 MP decodes legitimately use
// ~362 MB and complete fine.
//
// Multiplier 1.7 = measured model-vs-WASM-heap ratio (2026-07-07 browser sweep,
// DNG/CR2/ORF 9.9–24 MP: big-file cluster 1.62–1.66, worst clean 1.75; the ratio
// does NOT grow with pixels, so it holds for larger frames). Replaces the ADR's
// 1.5 estimate. The admission model here also assumes an orientation rotate
// (OUT_BATCH_DEFAULT, no NO_ORIENT), which over-reserves vs the worker's
// NO_ORIENT decode path — extra safety on top.
const RAW_DECODE_BUDGET_BYTES = Math.round(1.8 * 1024 * 1024 * 1024); // ~1.8 GiB of the 2 GiB WASM ceiling
const RAW_DECODE_SAFETY_MULT = 1.7;
const rawDecodeGovernor = new AssetStore({ name: 'raw-decode', maxBytes: RAW_DECODE_BUDGET_BYTES });

// Findings 11, 29: governed LRU cache for decoded JXL full-res RGBA buffers.
// Budget = 3 × 24 MP RGBA8 = 3 × 24_000_000 × 4 ≈ 288 MB. Keeps the 2–3 most
// recently viewed/prefetched cards in memory; older entries are evicted
// automatically. Callers must use jxlDerivedCache.get/set/invalidate — not
// _jxlDecoded directly — so the byte budget and LRU are always enforced.
// BLISS in-memory cache: taskId → { bliss: ArrayBuffer, width, height }
// Written by WorkerMsg.BLISS_READY (lightbox-sized encode); persisted to OPFS for cross-session use.
const blissCache = new Map();

// BLISS OPFS — simple subdirectory, no manifest, files keyed by assetId hash.
let _blissOpfsDir = null;
const _blissOpfsInit = (() => {
    if (typeof navigator === 'undefined' || !navigator?.storage?.getDirectory) return Promise.resolve();
    return navigator.storage.getDirectory()
        .then(root => root.getDirectoryHandle('bliss', { create: true }))
        .then(dir => { _blissOpfsDir = dir; })
        .catch(() => {});
})();

function _blissCacheName(assetId) {
    // assetId = "hex:filename" — use only the stable hash part
    return assetId.split(':')[0];
}

// CRC32 (IEEE) for cache integrity. A corrupt OPFS entry (bit-rot / partial write) fed to the WASM
// decoder can trap it (panic=abort → buffer leak); verifying a checksum before decode means only
// intact bytes ever reach the codec. Cached format: [crc32 payload, 4 bytes LE][bliss payload].
const _crc32Table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
})();
function _crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = _crc32Table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

async function blissOpfsWrite(assetId, bytes) {
    await _blissOpfsInit;
    if (!_blissOpfsDir) return;
    try {
        const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const crc = _crc32(payload);
        const framed = new Uint8Array(4 + payload.length);
        framed[0] = crc & 0xFF; framed[1] = (crc >>> 8) & 0xFF; framed[2] = (crc >>> 16) & 0xFF; framed[3] = (crc >>> 24) & 0xFF;
        framed.set(payload, 4);
        const fh = await _blissOpfsDir.getFileHandle(_blissCacheName(assetId), { create: true });
        const wr = await fh.createWritable();
        await wr.write(framed);
        await wr.close();
    } catch { /* non-fatal */ }
}

async function blissOpfsRead(assetId) {
    await _blissOpfsInit;
    if (!_blissOpfsDir) return null;
    try {
        const fh = await _blissOpfsDir.getFileHandle(_blissCacheName(assetId));
        const file = await fh.getFile();
        if (file.size <= 4) return null;
        const framed = new Uint8Array(await file.arrayBuffer());
        const stored = (framed[0] | (framed[1] << 8) | (framed[2] << 16) | (framed[3] << 24)) >>> 0;
        const payload = framed.slice(4); // own buffer — safe to transfer to the decode worker
        if (_crc32(payload) !== stored) {
            // corrupt (bit-rot / partial write) or pre-CRC legacy cache → drop it and miss → RAW fallback re-caches
            _blissOpfsDir.removeEntry(_blissCacheName(assetId)).catch(() => undefined);
            return null;
        }
        return payload;
    } catch { return null; } // NotFoundError = cache miss
}

// BLISS decode worker — single shared instance, prewarmed on first use.
let _blissDecodeWorker = null;
let _blissDecodeSeq = 0;
const _blissDecodePending = new Map(); // seq → resolve

function _initBlissDecodeWorker() {
    if (_blissDecodeWorker) return;
    _blissDecodeWorker = new Worker('./bliss-worker.js', { type: 'module' });
    _blissDecodeWorker.onmessage = (ev) => {
        const { seq, rgb, off, w, h } = ev.data;
        const resolve = _blissDecodePending.get(seq);
        if (resolve) {
            _blissDecodePending.delete(seq);
            // rgb arrives as the worker's whole decode buffer with `off` pointing
            // past the 8-byte dims header (zero-copy transfer; no slice(8) copy).
            resolve(rgb ? { rgb: new Uint8Array(rgb, off || 0), w, h } : null);
        }
    };
    _blissDecodeWorker.postMessage({ type: 'preload' });
}

function blissDecodeViaWorker(bytes) {
    return new Promise((resolve) => {
        _initBlissDecodeWorker();
        const seq = ++_blissDecodeSeq;
        _blissDecodePending.set(seq, resolve);
        _blissDecodeWorker.postMessage({ type: 'bliss_decode', seq, bliss: bytes.buffer }, [bytes.buffer]);
    });
}

// Decode only the embedded 1/8-scale BLSP preview. Does NOT transfer bytes so
// the caller can still pass them to blissDecodeViaWorker for the full decode.
function blissDecodePreviewViaWorker(bytes) {
    return new Promise((resolve) => {
        _initBlissDecodeWorker();
        const seq = ++_blissDecodeSeq;
        _blissDecodePending.set(seq, resolve);
        // No transfer list — bytes stays live on this thread for the subsequent full decode.
        _blissDecodeWorker.postMessage({ type: 'bliss_decode_preview', seq, bliss: bytes.buffer });
    });
}

function _hasBlspPrefix(bytes) {
    // BLSP = 0x42 0x4C 0x53 0x50
    return bytes.length >= 4 &&
        bytes[0] === 0x42 && bytes[1] === 0x4C && bytes[2] === 0x53 && bytes[3] === 0x50;
}

// Try OPFS BLISS for instant lightbox preview; non-fatal, no-op if card changed.
// If the stored blob has a BLSP prefix (from bliss_encode_with_preview), paints the
// 1/8-scale preview immediately while the full decode runs in parallel.
async function blissOpfsLoad(card, assetId) {
    const bytes = await blissOpfsRead(assetId);
    if (!bytes) return;
    if (lightboxIndex < 0 || cards[lightboxIndex] !== card) return;
    if (getCardState(card)?._lightbox?.rgb) { drawLightboxForCard(card); return; }

    // BLSP-first: fire preview decode without transferring so full decode can follow.
    if (_hasBlspPrefix(bytes)) {
        blissDecodePreviewViaWorker(bytes).then(prev => {
            if (!prev) return;
            if (lightboxIndex < 0 || cards[lightboxIndex] !== card) return;
            if (getCardState(card)?._lightbox?.rgb) return; // full decode already painted
            drawCanvas(lightboxCanvas, prev.w, prev.h, prev.rgb);
            setPaintedSourceBadge('bliss-preview');
            lbLoadingBadge.hidden = true;
            applyStraightenToLightboxCanvas(card);
            syncZoomToDisplayLong();
        }).catch(() => {});
    }

    const result = await blissDecodeViaWorker(bytes).catch(() => null);
    if (!result) return;
    if (lightboxIndex < 0 || cards[lightboxIndex] !== card) return;
    if (getCardState(card)?._lightbox?.rgb) { drawLightboxForCard(card); return; }
    const { rgb, w, h } = result;
    const blissFrame = drawCanvas(lightboxCanvas, w, h, rgb);
    if (lightboxCanvas.width > 0 && blissFrame) {
        captureCleanAndApplyLens(blissFrame);
    }
    setPaintedSourceBadge('bliss');
    lbLoadingBadge.hidden = true;
    applyStraightenToLightboxCanvas(card);
    syncZoomToDisplayLong();
}

const JXL_DERIVED_CACHE_BYTES = 3 * 24_000_000 * 4; // ~288 MB
const jxlDerivedCache = createDerivedCache({
    name: 'jxl-derived',
    maxBytes: JXL_DERIVED_CACHE_BYTES,
});

// Finding 39: byte-admission lane for file reads. A full file.arrayBuffer()
// read MUST NOT start before a slot is available so pending tasks never hold
// complete file bytes in memory while waiting for a worker slot. The lane
// gates on an in-memory byte budget; the read starts only after admission
// resolves, and the slot is released when the submitted task completes (done
// or error). Capacity = half the raw-decode budget (reads are transient; the
// WASM decode stage is the true peak, governed separately by rawDecodeGovernor).
const READ_LANE_CAPACITY_BYTES = Math.round(RAW_DECODE_BUDGET_BYTES / 2);
const readLane = createReadLane({ capacityBytes: READ_LANE_CAPACITY_BYTES });

function fileKey(f) { return `${f.name}|${f.size}|${f.lastModified}`; }

/**
 * Per-card state contract.
 *
 * State is stored in the module-level `cardState` WeakMap (Element → CardState)
 * and accessed via `getCardState(card)`. Proxy getters/setters installed by
 * `initCardState` keep `getCardState(card)._field` in sync with the WeakMap-backed object, so
 * external code (crop.js, Playwright tests) that reads getCardState(card)._field directly
 * continues to work without modification.
 *
 * Open-lightbox state is the module global `lightboxIndex`; live-update state
 * is `liveInFlight`/`livePendingLook`/`liveDebounceTimer` — one active lightbox
 * at a time. `peepCache` and `cardByTaskId`/`cardByFilename` are cross-card
 * indices, not per-card state — they are NOT migrated to the WeakMap.
 *
 * @typedef {{
 *   // --- identity / lifecycle ---
 *   _file?: File,                       // source RAW file (set in addCard)
 *   _taskId?: number|null,              // in-flight/last RAW worker task; key into cardByTaskId
 *   _tauriPath?: string,                // full fs path (Tauri only); key into cardByFilename
 *   _pendingPriority?: 'normal'|'high'|null, // priority hint consumed at pool.submit
 *   _pendingLookBatch?: object|null,    // batched Look for a queued gallery reprocess
 *   // --- pixel / data caches ---
 *   _lightbox?: {rgb:Uint8Array,w:number,h:number,nativeW:number,nativeH:number,orientation:number}|null,
 *                                        // full-res RAW sensor pixels; set in onLightbox, nulled on reprocess.
 *                                        // Truthiness == "RAW available" (drives havePair, raw-mode gating).
 *   _embeddedPreview?: {bmp:ImageBitmap,w:number,h:number,orientation:number}|null, // largest camera JPEG; survives reprocess
 *   _blobUrl?: string|null,             // object URL of encoded JXL blob; revoked before re-set + in removeCard
 *   _jxlDecoded?: {rgba:Uint8ClampedArray,w:number,h:number}|null, // full-res JXL decode cache; nulled when bytes change
 *   _jxlThumbBmp?: ImageBitmap|null, _jxlThumbW?: number, _jxlThumbH?: number, // cached JXL thumbnail bitmap + dims
 *   _jxlProgressCacheDecodeId?: number, // decodeId of the progressive-decode cache entry
 *   _thumbRgb?: Uint8Array, _thumbW?: number, _thumbH?: number, // RAW thumbnail pixels + display dims
 *   _thumbNativeW?: number, _thumbNativeH?: number, _thumbOrientation?: number, // sensor dims + orientation for GPU-rotate draw
 *   _sensorW?: number, _sensorH?: number, // sensor dims (Tauri lazy path)
 *   // --- display / source selection ---
 *   _sourceMode?: 'raw'|'jxl'|'jpeg',   // active display source (thumb + lightbox)
 *   _crop?: object|null,                // crop rect (from sidecar)
 *   _subjects?: Array<object>,          // focal subjects
 *   _focusedSubjectId?: (string|number)|undefined, // currently focused subject in the cycle
 *   // --- in-flight guards ---
 *   _jxlPrefetching?: boolean,          // full-res JXL prefetch in flight
 *   _largePreviewFetching?: boolean, _largePreviewFetched?: boolean, // Tauri lazy full-preview guards
 *   // --- metadata (from worker onThumb/onDone) ---
 *   _wb?: {r:number,b:number},          // white-balance multipliers
 *   _colorMatrixFromMn?: boolean,       // color matrix source (true=maker-note, false=fallback)
 *   _camera?: string,                   // "Make Model"
 *   _exif?: object|null,                // EXIF (width/height patched on done)
 *   _pipelineMs?: number, _phaseMs?: object, // timings
 *   _meta?: string,                     // one-line display summary "WxH • pipeline X ms • JXL Y ms"
 *   _tauriResult?: {jxl:ArrayBuffer,exif:object}|null, // Tauri encode result for planner upload
 * }} CardState
 *
 * Lifecycle invariants:
 *  - makeCard builds only the DOM + listeners; all data fields start undefined.
 *    addCard sets `_file` and submits to the pool, producing `_taskId`.
 *  - Reprocess (existingCard branch): `_lightbox = null`, `_sourceMode = 'raw'`,
 *    releaseState(`_taskId`); `_embeddedPreview` is deliberately kept (JXL/JPEG toggle).
 *  - onThumb: sets `_thumb*`, `_wb`, `_camera`, `_exif`, `_colorMatrixFromMn`,
 *    `_pipelineMs`, `_phaseMs`; closes any stale `_jxlThumbBmp`.
 *  - onLightbox: sets `_lightbox`.  onDone: sets `_blobUrl` + `_meta`, nulls
 *    `_jxlDecoded`, patches `_exif` dims.
 *  - Teardown is removeCard() ONLY: cancel + releaseState `_taskId`, drop from
 *    cardByTaskId/cardByFilename, revoke `_blobUrl`, close per-card ImageBitmaps,
 *    splice from `cards`, remove the node. Any delete UI must route through it.
 */
function makeCard(name) {
    const card = document.createElement('div');
    // Register the WeakMap state entry immediately so all event-listener closures
    // below and any external code (crop.js) that reads getCardState(card)._field see the same
    // WeakMap-backed state from the moment the card is created.
    initCardState(card, {});
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
    card.querySelector('.name').textContent = stripRawExtension(name);
    card.querySelector('.thumb-select').addEventListener('click', (e) => {
        e.stopPropagation();
        card.classList.toggle('selected');
        card.querySelector('.thumb-select').textContent =
            card.classList.contains('selected') ? '✓' : '·';
        refreshReprocessLabel();
    });
    card.querySelector('.thumb-dl-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const stem = stripRawExtension(getCardState(card)._file?.name || 'image');
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
            if (!getCardState(card)._tauriResult) return;
            uploadBtn.disabled = true; uploadBtn.textContent = '…';
            try {
                const [settings, token] = await Promise.all([invoke('get_settings'), invoke('get_token')]);
                const { jxl, exif } = getCardState(card)._tauriResult;
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
        if (m === 'raw')  return !!getCardState(card)._lightbox;
        if (m === 'jxl')  return !!getCardState(card)._blobUrl;
        if (m === 'jpeg') return !!getCardState(card)._embeddedPreview;
        return false;
    });
    if (available.length < 2) return;
    const cur = available.indexOf(getCardState(card)._sourceMode ?? 'raw');
    const next = available[(cur + dir + available.length) % available.length];
    getCardState(card)._sourceMode = next;
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
        if (m === 'raw')  return !!getCardState(card)._lightbox;
        if (m === 'jxl')  return !!getCardState(card)._blobUrl;
        if (m === 'jpeg') return !!getCardState(card)._embeddedPreview;
    });
    btn.hidden = available.length < 2;
    if (available.length < 2) return;
    const mode   = getCardState(card)._sourceMode ?? 'raw';
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
    const frame = new ImageData(rgba, w, h);
    ctx.putImageData(frame, 0, 0);
    // TTFP-2 pattern: return the ImageData just painted so callers that need a
    // clean snapshot can skip the full-canvas getImageData readback (the put
    // covers the whole canvas at (0,0) with opaque pixels, so the readback
    // would be byte-identical). Consumers of cleanSnapshot are read-only or
    // deep-copy, so aliasing a caller-retained buffer is safe.
    return frame;
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
        // No GPU transform: the painted ImageData IS the canvas content, so
        // return it (TTFP-2 pattern) — callers can reuse it as the clean
        // snapshot without a full-canvas getImageData readback.
        const frame = new ImageData(rgba, sw, sh);
        ctx.putImageData(frame, 0, 0);
        return frame;
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
    return null; // pixels were composed on the GPU — no ImageData to hand back
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
// through getCardState(card)._sourceMode: when 'jpeg' and we have an embedded preview cached,
// the camera's JPEG is rendered at the same canvas pixel dims as the JXL/RGB
// thumb so toggling doesn't change the viewport.
function redrawThumbRotated(card) {
    const deg = getCardState(card)._file?.name ? (userRotations[getCardState(card)._file.name] || 0) : 0;
    const canvas = card.querySelector('canvas');
    if (getCardState(card)._sourceMode === 'jpeg' && getCardState(card)._embeddedPreview && getCardState(card)._thumbW && getCardState(card)._thumbH) {
        drawJpegToTargetDims(canvas, getCardState(card)._embeddedPreview.bmp,
                             getCardState(card)._embeddedPreview.orientation || 1,
                             getCardState(card)._thumbW, getCardState(card)._thumbH);
        canvas.style.transform = deg ? `rotate(${deg}deg)` : '';
        setThumbSource(card, classifyJpegThumbSource(
            getCardState(card)._embeddedPreview.w, getCardState(card)._embeddedPreview.h));
        return;
    }
    // Prefer the cached JXL-decoded thumb when it's available — the badge
    // says "JXL thumb" so the pixels should match.
    if (getCardState(card)._jxlThumbBmp && getCardState(card)._jxlThumbW && getCardState(card)._jxlThumbH) {
        canvas.width  = getCardState(card)._jxlThumbW;
        canvas.height = getCardState(card)._jxlThumbH;
        canvas.getContext('2d').drawImage(getCardState(card)._jxlThumbBmp, 0, 0);
        canvas.style.transform = deg ? `rotate(${deg}deg)` : '';
        setThumbSource(card, 'jxl');
        return;
    }
    if (!getCardState(card)._thumbRgb) return;
    // Phase 2: rgb is sensor-orientation if nativeW/H/orientation present;
    // GPU-rotated draw avoids the CPU transpose. Falls back to plain putImageData
    // for older messages or when orientation is identity.
    if (getCardState(card)._thumbNativeW && getCardState(card)._thumbOrientation && getCardState(card)._thumbOrientation !== 1) {
        drawSensorWithOrientation(canvas, getCardState(card)._thumbRgb,
            getCardState(card)._thumbNativeW, getCardState(card)._thumbNativeH, getCardState(card)._thumbOrientation);
    } else {
        drawCanvas(canvas, getCardState(card)._thumbW, getCardState(card)._thumbH, getCardState(card)._thumbRgb);
    }
    canvas.style.transform = deg ? `rotate(${deg}deg)` : '';
    // RAW-pipeline thumb — no badge.
    setThumbSource(card, null);
}

// Rotate a card by delta degrees and persist + sync lightbox if open.
function rotateCard(card, delta) {
    const name = getCardState(card)._file?.name;
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
        if (getCardState(card)._taskId) pool.releaseState(getCardState(card)._taskId);
        card.classList.remove('encoding', 'error', 'embedded-thumb');
        card.classList.add('busy');
        getCardState(card)._lightbox = null;
        // Keep _embeddedPreview alive across reprocess — JPEG-vs-JXL toggle needs it.
        // Force the JXL view back on so the user actually sees the result of
        // pressing Apply/Re-process; otherwise they'd be staring at the
        // (unchanged) camera JPEG and assume the action did nothing.
        getCardState(card)._sourceMode = 'raw';
        refreshThumbToggleButton(card);
        if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
            drawLightboxForCard(card);
        }
        // Finding 48: bytes are changing (reprocess) — bump the generation so any
        // in-flight decode results from the prior task are rejected before commit.
        if (getCardState(card)._assetId) {
            assetStateStore.bumpGeneration(getCardState(card)._assetId);
            getCardState(card)._sourceGeneration = assetStateStore.getOrCreate(getCardState(card)._assetId).sourceGeneration;
        }
    }
    totalSubmitted++;
    getCardState(card)._file = file;
    // Finding 46/40: compute stable assetId from full path (not just basename)
    // so two files with the same name in different directories never collide.
    {
        const filePath = file.webkitRelativePath || (IS_TAURI ? getCardState(card)._tauriPath : null) || file.name;
        const assetId = makeAssetId({ path: filePath, name: file.name, size: file.size, lastModified: file.lastModified });
        getCardState(card)._assetId = assetId;
        // Mirror into the AssetStateStore — creates or retrieves the per-asset record.
        const asState = assetStateStore.getOrCreate(assetId);
        getCardState(card)._sourceGeneration = asState.sourceGeneration;
        // Expose via window so panels.js and crop.js can read it by card reference.
        window._getCardAssetId = (c) => getCardState(c)?._assetId;
    }
    // Check for existing sidecar dot + hydrate crop/subjects so any focal
    // subjects show up as sibling cards before the user opens the lightbox.
    // Finding 40: pass the assetId explicitly so applySidecarEdit targets THIS card.
    if (typeof loadSidecar === 'function' && file.name) {
        const _assetIdForSidecar = getCardState(card)._assetId;
        // Finding 46: pass the stable assetId so loadSidecar reads the same
        // stable-id key that saveSidecar writes (basename fallback is secondary).
        loadSidecar(file.name, _assetIdForSidecar).then(s => {
            if (!s) return;
            if (typeof updateSidecarDot === 'function') updateSidecarDot(file.name, true);
            // Route through assetStateStore to keep edit state isolated.
            if (_assetIdForSidecar) assetStateStore.applySidecarEdit(_assetIdForSidecar, s);
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
        if (!candidates.length) { if (proxyViewMode) dispatchRaw(); return; }
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

            // S3-Q3 decode preflight (hard gate): the largest embedded JPEG is
            // ~sensor resolution, so project the RAW decode's peak working set
            // from it and REJECT if it would blow the WASM-heap budget. Flags =
            // the shipping batch set (RGB8|lightbox|thumbnail). Mirrors the Rust
            // estimate_decode_peak model. On rejection we surface a user-visible
            // error on the card instead of letting the worker OOM. Non-admission
            // errors (e.g. estimator quirks) must never break ingest.
            if (!proxyViewMode) try {
                const peak = estimateDecodePeak(largest.w, largest.h, OUT_BATCH_DEFAULT).peakBytes;
                rawDecodeGovernor.admit(peak, {
                    multiplier: RAW_DECODE_SAFETY_MULT,
                    label: file.name || `${largest.w}×${largest.h}`,
                });
            } catch (err) {
                if (err instanceof AdmissionRejected || err?.name === 'AdmissionRejected') {
                    // Too large for the current memory budget: mark the card so the
                    // user sees why, and skip drawing the (about-to-OOM) preview.
                    card.classList.remove('busy', 'embedded-thumb');
                    card.classList.add('error');
                    card.dataset.error =
                        `Image too large for current memory budget ` +
                        `(needs ~${(err.projectedBytes / (1024 * 1024)).toFixed(0)} MB, ` +
                        `budget ${(err.budgetBytes / (1024 * 1024)).toFixed(0)} MB)`;
                    if (typeof pushStat === 'function') pushStat(`[admit] ${err.message}`);
                    for (const v of valid) { try { v.bmp.close(); } catch {} }
                    return;
                }
                /* non-admission error: preflight must never break ingest */
            }

            if (card.classList.contains('busy') || card.classList.contains('embedded-thumb')) {
                drawOrientedThumb(card.querySelector('canvas'), largest.bmp, largest.orientation, 360);
                card.classList.remove('busy');
                card.classList.add('embedded-thumb');
                setThumbSource(card, classifyJpegThumbSource(largest.w, largest.h));
            }

            getCardState(card)._embeddedPreview = { bmp: largest.bmp, w: largest.w, h: largest.h,
                                      orientation: largest.orientation };
            refreshThumbToggleButton(card);
            if (proxyViewMode) {
                // Proxy fast path: the camera JPEG is the deliverable — complete the card,
                // skip the RAW decode. Close the non-largest candidate bitmaps first.
                for (let vi = 0; vi < valid.length - 1; vi++) { try { valid[vi].bmp.close(); } catch {} }
                proxyCompleteCard(card, largest);
                return;
            }
            if (lightboxIndex >= 0 && cards[lightboxIndex] === card) {
                if (!getCardState(card)._lightbox) {
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
    }).catch(() => { if (proxyViewMode) dispatchRaw(); }); // preview failure is non-fatal (proxy: fall back to RAW)

    // Phase B+C — full file read for WASM pipeline + JXL encode. Wrapped in a hoisted
    // fn so the proxy-view fast path (Phase A) can skip it. Dispatched immediately below
    // unless proxyViewMode is on — then Phase A completes the card from the embedded JPEG,
    // or falls back to dispatchRaw() when there is no usable preview.
    function dispatchRaw() {
    // Finding 39: admit the read lane BEFORE calling file.arrayBuffer() so the
    // full file bytes are never loaded into memory until there is capacity. The
    // release() is called on task done/error or on read error, so bytes are never
    // orphaned in-memory while a card is waiting for a worker slot.
    //
    // I-1/M-1/M-3: create a per-card AbortController so removeCard() can (a)
    // cancel a still-queued admission and (b) abort an in-flight fetch/session.
    // The controller is stored on card state so removeCard() can reach it.
    const _readAbortCtrl = new AbortController();
    getCardState(card)._readAbortCtrl = _readAbortCtrl;
    const _readPriority = getCardState(card)._pendingPriority || 'normal';
    readLane.admit(file.size || 0, _readAbortCtrl.signal, _readPriority).then(lane_release => {
    // I-1: store lane_release on card state so removeCard() can call it even
    // when the worker cancels the task without emitting DONE or ERROR.
    getCardState(card)._laneRelease = lane_release;
    file.arrayBuffer()
        .then((buf) => {
            const bytes = new Uint8Array(buf);
            const opts = currentOptions();
            opts.userRotation = userRotations[file.name] || 0;
            // Carry the filename so the worker's detectFormat can disambiguate
            // TIFF-magic RAW from developed TIFF. Detection still
            // works on magic bytes alone if name is absent (e.g. EXR/CR2).
            opts.name = file.name || '';
            // opts.batch (left unset here) opts a task out of the worker's
            // interactive two-phase ORF split (previews first, full-res second)
            // and decodes each file once — a total-CPU win for headless/batch
            // exports that need no on-screen preview. This is the INTERACTIVE
            // viewer: every card shows previews, so we keep batch unset and the
            // first-paint-optimized split. opts survives postMessage (pool.submit
            // forwards `options` verbatim to the worker), so a future batch/
            // scheduler entry only needs to set opts.batch = true to opt in.
            const initialPriority = getCardState(card)._pendingPriority || _readPriority;
            getCardState(card)._pendingPriority = null;
            const taskId = pool.submit(bytes, opts, {
                onThumb(msg) {
                    getCardState(card)._thumbRgb = msg.rgb;
                    getCardState(card)._thumbW   = msg.w;
                    getCardState(card)._thumbH   = msg.h;
                    // Phase 2: sensor dims + orientation for GPU-rotate draw.
                    getCardState(card)._thumbNativeW = msg.nativeW ?? msg.w;
                    getCardState(card)._thumbNativeH = msg.nativeH ?? msg.h;
                    getCardState(card)._thumbOrientation = msg.orientation ?? 1;
                    // Fresh RAW thumb — drop any stale JXL bitmap from a prior
                    // process so redrawThumbRotated paints the new RAW pixels
                    // rather than the old JXL cache.
                    if (getCardState(card)._jxlThumbBmp) {
                        try { getCardState(card)._jxlThumbBmp.close(); } catch {}
                        getCardState(card)._jxlThumbBmp = null;
                    }
                    try {
                        redrawThumbRotated(card);
                    } catch (e) {
                        console.error('redrawThumb error:', e);
                        pushStat(`[redrawThumb ERROR] ${e?.message || e} (w=${msg.w} h=${msg.h} rgb=${msg.rgb?.byteLength})`);
                        drawCanvas(card.querySelector('canvas'), msg.w, msg.h, msg.rgb);
                    }
                    refreshThumbToggleButton(card);
                    getCardState(card)._pipelineMs = msg.pipelineMs;
                    getCardState(card)._phaseMs = msg.phaseMs;
                    getCardState(card)._wb = { r: msg.wbR, b: msg.wbB };
                    getCardState(card)._colorMatrixFromMn = msg.colorMatrixFromMn;
                    getCardState(card)._camera = [msg.make, msg.model].filter(Boolean).join(' ') || '?';
                    getCardState(card)._exif = msg.exif || null;
                    getCardState(card)._cameraWb = (msg.exif?.wbFromCamera && isFinite(msg.exif.wbR) && isFinite(msg.exif.wbB))
                        ? { r: msg.exif.wbR, g: 1.0, b: msg.exif.wbB } : null;
                    card.querySelector('.thumb-dl-btn').hidden = false;
                    card.classList.remove('busy', 'embedded-thumb');
                    card.classList.add('encoding');
                    setThumbSource(card, null);
                },
                onLightbox(msg) {
                    // Phase 2: cache sensor pixels + orientation so the lightbox
                    // draw applies rotation via canvas transform (GPU) rather than CPU.
                    getCardState(card)._lightbox = {
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
                    getCardState(card)._laneRelease = null; lane_release(); // finding 39: release byte slot — task is complete
                    card.classList.remove('encoding');
                    // TTFP-4 (two-phase RAW split): THUMB carried phase-1-only
                    // timings and exif with width/height 0 (lib.rs previews-only
                    // results have no sensor dims). Patch the real totals and
                    // dims now — before the stats push below reads them.
                    if (msg.pipelineMs != null) getCardState(card)._pipelineMs = msg.pipelineMs;
                    if (msg.phaseMs) getCardState(card)._phaseMs = msg.phaseMs;
                    if (getCardState(card)._exif && !getCardState(card)._exif.width && msg.w) {
                        getCardState(card)._exif.width  = msg.w;
                        getCardState(card)._exif.height = msg.h;
                    }
                    const blob = new Blob([msg.jxl], { type: 'image/jxl' });
                    // Revoke any previous blob URL for this card before creating a new one.
                    if (getCardState(card)._blobUrl) URL.revokeObjectURL(getCardState(card)._blobUrl);
                    const url = URL.createObjectURL(blob);
                    getCardState(card)._blobUrl = url;
                    // Findings 11, 29: invalidate the derived cache (bytes changed).
                    { const _aid = getCardState(card)._assetId; if (_aid) jxlDerivedCache.invalidate(_aid); else getCardState(card)['_jxlDecoded'] = null; }
                    card.querySelector('.size').textContent =
                        `${(msg.jxl.byteLength / 1024).toFixed(0)} KB`;
                    const totalMs = getCardState(card)._pipelineMs + msg.jxlMs;
                    const effortNote = (msg.effortUsed && msg.effortRequested && msg.effortUsed < msg.effortRequested)
                        ? ` (effort ${msg.effortRequested}→${msg.effortUsed}: OOM)` : '';
                    card.querySelector('.time').textContent =
                        (totalMs >= 60000
                            ? `${Math.floor(totalMs / 60000)}m ${((totalMs % 60000) / 1000).toFixed(0)}s`
                            : `${(totalMs / 1000).toFixed(1)}s`) + effortNote;
                    getCardState(card)._meta =
                        `${msg.w}×${msg.h} • pipeline ${getCardState(card)._pipelineMs.toFixed(0)} ms • JXL ${msg.jxlMs.toFixed(0)} ms${effortNote}`;

                    // Stats line — keeps everything one image needs on one row.
                    statSeq++;
                    const p = getCardState(card)._phaseMs || {};
                    const wb = getCardState(card)._wb || {};
                    const name = file.name.padEnd(18, ' ').slice(0, 18);
                    const wbStr = wb.r != null
                        ? `wb R${wb.r.toFixed(3)} B${wb.b.toFixed(3)}`
                        : 'wb ?';
                    const matrixStr = getCardState(card)._colorMatrixFromMn === true ? 'mn-matrix'
                                    : getCardState(card)._colorMatrixFromMn === false ? 'fallback-matrix'
                                    : '';
                    bumpWbMatrix(wbStr, matrixStr);
                    pushStat(
                        `[${String(statSeq).padStart(3, ' ')}] ${name} ${msg.w}×${msg.h}  ` +
                        `dec ${fmtMs(p.decompress)}  ` +
                        `dem ${fmtMs(p.demosaic)}  ` +
                        `tone ${fmtMs(p.tonemap)}  ` +
                        `ori ${fmtMs(p.orient)}  ` +
                        `pipe ${fmtMs(getCardState(card)._pipelineMs)}  ` +
                        `jxl ${fmtMs(msg.jxlMs)}  ` +
                        `out ${fmtKb(msg.jxl.byteLength)}`,
                    );

                    emaPipeline = emaPipeline == null ? getCardState(card)._pipelineMs : EMA_A * getCardState(card)._pipelineMs + (1 - EMA_A) * emaPipeline;
                    emaEncode   = emaEncode   == null ? msg.jxlMs        : EMA_A * msg.jxlMs        + (1 - EMA_A) * emaEncode;
                    totalDone++;
                    refreshStatus();
                    // Replace the RAW-pipeline thumb with a JXL-decoded one so
                    // the grid shows what the JXL roundtrip looks like.
                    repaintThumbFromJxl(card);
                    // Subject sibling cards: now that JXL is ready, render
                    // their thumbnails from the parent's full-res JXL pixels.
                    if (getCardState(card)._subjects?.length && typeof window.renderSubjectThumb === 'function') {
                        window.renderSubjectThumb(card).catch(() => {});
                    }
                },
                onError(msg) {
                    getCardState(card)._laneRelease = null; lane_release(); // finding 39: release byte slot on task error
                    card.classList.remove('busy', 'encoding');
                    card.classList.add('error');
                    card.dataset.error = msg.error;
                    statSeq++;
                    pushStat(`[${String(statSeq).padStart(3, ' ')}] ${file.name.padEnd(18,' ').slice(0,18)} ERROR: ${msg.error}`);
                    totalDone++;
                    refreshStatus();
                },
            }, initialPriority);
            getCardState(card)._taskId = taskId;
            cardByTaskId.set(taskId, card);
        })
        .catch((e) => {
            getCardState(card)._laneRelease = null; lane_release(); // finding 39: release byte slot on read error
            card.classList.add('error');
            card.dataset.error = e.message || String(e);
            totalDone++;
            refreshStatus();
        });
    }).catch((e) => {
        // admit() itself failed (AbortError or lane destroyed) — surface as error
        card.classList.add('error');
        card.dataset.error = e.message || String(e);
        totalDone++;
        refreshStatus();
    });
    } // end dispatchRaw
    // Finding 10 (P4 T5): _forceDevelop overrides the global proxy-first mode so
    // "Develop Selected" can dispatch the full RAW pipeline even while proxy-first intake
    // is on. The flag is cleared after use so normal re-ingests still respect the mode.
    const _forceThis = !!getCardState(card)._forceDevelop;
    if (_forceThis) getCardState(card)._forceDevelop = false;
    if (!proxyViewMode || _forceThis) dispatchRaw();
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
    const inputs = [...fileList].filter(isPipelineInputFile);
    if (!inputs.length) return;

    window.dockSidebar();

    resetLookSliders();
    for (const f of inputs) startConvert(f);
}

// Finding 14 (P4 T5): single source of truth. Delegates to format-detect.js so the
// drag/drop filter and picker accept attribute always agree with the worker's routing table.
function isPipelineInputFile(file) {
    return _isPipelineInputByName(file?.name || '');
}

// Walk a DataTransfer entry tree (only available on `drop` via
// `dataTransfer.items[*].webkitGetAsEntry()`).  Returns all supported pipeline files
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
            await new Promise((res, rej) => entry.file((f) => { if (isPipelineInputFile(f)) out.push(f); res(); }, rej));
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
        if (!files.length) files = [...e.dataTransfer.files].filter(isPipelineInputFile);
        await handleFileList(files);
    });
}

// ---------------------------------------------------------------------------
// Finding 47 (P4 T8): idle-prefetch — warm lazy modules AFTER the core
// interaction pipeline is ready and the browser is idle.
//
// Policy: prefetch only under ResourceTiming / connection hints that indicate
// the browser is on a good connection (or falls back to a conservative 2s
// setTimeout when requestIdleCallback is not available). Does NOT prefetch
// everything eagerly — only modules that the user is "likely" to need within
// a session (all three optional feature groups are touched by most users who
// open a file). The prefetch is advisory: each lazily imported module is a
// no-op if it was already loaded by an earlier user action.
// ---------------------------------------------------------------------------
{
    function prefetchLazyModules() {
        // Fire-and-forget: errors don't matter (they will retry on demand).
        lazyPerceptual().catch(() => {});
        lazyTauriParity().catch(() => {});
        lazyExport().catch(() => {});
    }

    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(prefetchLazyModules, { timeout: 4000 });
    } else {
        setTimeout(prefetchLazyModules, 2000);
    }
}

// Finding 10 (P4 T5): wire intake mode checkbox + "Develop Selected" button.
{
    const proxyToggle = document.getElementById('proxy-intake-toggle');
    if (proxyToggle) {
        // Initialise checkbox state from persisted mode.
        proxyToggle.checked = _intakeMode.isProxy();
        proxyToggle.addEventListener('change', () => {
            window.setProxyView(proxyToggle.checked);
        });
    }
    const developBtn = document.getElementById('develop-selected-btn');
    if (developBtn) {
        developBtn.addEventListener('click', () => window.developSelected());
    }
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
    if (!getCardState(card)?._blobUrl) return;
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
    // Finding 48: stamp a generation tag so the callback rejects stale results
    // from a prior encode if the card was reprocessed while the decode was in flight.
    const _thumbDecodeTag = (() => {
        const assetId = getCardState(card)?._assetId;
        return assetId ? assetStateStore.makeResultTag(assetId) : null;
    })();
    decodeJxlViaSession(getCardState(card)._blobUrl, (msg) => {
        // Finding 48: reject stale results before any canvas/cache mutation.
        if (_thumbDecodeTag) {
            const asState = assetStateStore.getOrCreate(_thumbDecodeTag.assetId);
            if (assetStateStore.isStale(_thumbDecodeTag, asState)) return;
        }
        if (msg.type === 'decode_error') {
            console.warn('JXL thumb decode error:', msg.error);
            return;
        }
        const canvas = card.querySelector('canvas');
        if (!canvas) return;
        const { rgba, w, h } = msg;
        // Finding 43: decoded at downsample:4 so w/h are already ≤ 1/4 of the
        // master. We still clamp to 360px long-edge for exact grid sizing, but the
        // createImageBitmap resize covers only a small remaining scale (e.g. 1000px
        // → 360px) rather than the full 6000px → 360px of a master decode.
        const LONG_EDGE = 360;
        const long = Math.max(w, h);
        const targetW = long > LONG_EDGE ? Math.max(1, Math.round(w * LONG_EDGE / long)) : w;
        const targetH = long > LONG_EDGE ? Math.max(1, Math.round(h * LONG_EDGE / long)) : h;
        // Build the source ImageBitmap then high-quality draw into the thumb.
        // Cache the downsampled bitmap so rotation can repaint without
        // re-decoding the JXL.
        createImageBitmap(new ImageData(rgba, w, h), {
            resizeWidth: targetW, resizeHeight: targetH, resizeQuality: 'high',
        }).then(bmp => {
            // Guard again after the async createImageBitmap — generation may have
            // advanced while we awaited the bitmap creation.
            if (_thumbDecodeTag) {
                const asState = assetStateStore.getOrCreate(_thumbDecodeTag.assetId);
                if (assetStateStore.isStale(_thumbDecodeTag, asState)) { try { bmp.close(); } catch {} return; }
            }
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bmp, 0, 0);
            if (getCardState(card)._jxlThumbBmp && getCardState(card)._jxlThumbBmp !== bmp) {
                try { getCardState(card)._jxlThumbBmp.close(); } catch {}
            }
            getCardState(card)._jxlThumbBmp = bmp;
            getCardState(card)._jxlThumbW   = targetW;
            getCardState(card)._jxlThumbH   = targetH;
            card.classList.remove('embedded-thumb');
            setThumbSource(card, 'jxl');
        }).catch(e => console.warn('JXL thumb bitmap failed:', e));
    // Finding 43: pass downsample:4 so the decoder produces ~W/4 × H/4 pixels
    // (1/16th of a 24 MP frame) rather than the full master. The thumb target is
    // 360px long-edge, so a 4× downsample of a 6000px frame gives ~1500px —
    // a small createImageBitmap rescale finishes what the decoder started, while
    // the decode itself costs ~4× less RGBA memory and ~4–8× less decode time.
    }, 'low', { ...cacheOpts, cacheTag: _thumbDecodeTag, downsample: 4 });
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

// Finding 47 (P4 T8): perceptual-color.mjs is loaded lazily on first lens activation.
// All four functions below are async; callers that are synchronous fire-and-forget
// (captureCleanAndApplyLens, event handlers) — the await is internal.

async function applyPerceptualLens() {
    if (!lightboxCanvas.width) return;
    const ctx = lightboxCanvas.getContext('2d');
    if (perceptualLens.active && cleanSnapshot) {
        const { applyLens } = await lazyPerceptual();
        const out = applyLens(
            cleanSnapshot.data, lightboxCanvas.width, lightboxCanvas.height,
            { strength: perceptualLens.strength, lightness: perceptualLens.lightness },
        );
        ctx.putImageData(new ImageData(out, lightboxCanvas.width, lightboxCanvas.height), 0, 0);
    } else if (!perceptualLens.active && cleanSnapshot) {
        ctx.putImageData(cleanSnapshot, 0, 0);
    }
    await refreshSelectionOverlay();
}

async function ensureLabBuf() {
    if (!cleanSnapshot || !lightboxCanvas.width) return;
    const { estimateSceneWhiteLms, normalizedLabBuffer } = await lazyPerceptual();
    const sceneWhite = estimateSceneWhiteLms(
        cleanSnapshot.data, lightboxCanvas.width, lightboxCanvas.height,
    );
    colourSelect.labBuf = normalizedLabBuffer(
        cleanSnapshot.data, lightboxCanvas.width, lightboxCanvas.height, sceneWhite,
    );
}

async function refreshSelectionOverlay() {
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
    const { maskBorder, maskCoverage } = await lazyPerceptual();
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

async function handleLensClick(e) {
    await ensureLabBuf();
    if (!colourSelect.labBuf) return;
    const rect = lightboxCanvas.getBoundingClientRect();
    const scaleX = lightboxCanvas.width / rect.width;
    const scaleY = lightboxCanvas.height / rect.height;
    const cx = Math.round((e.clientX - rect.left) * scaleX);
    const cy = Math.round((e.clientY - rect.top) * scaleY);
    const w = lightboxCanvas.width, h = lightboxCanvas.height;
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return;
    const { probe: probeColour, selectByColour, unionMask } = await lazyPerceptual();
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
    await refreshSelectionOverlay();
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
    if (getCardState(card)?._file?.name) {
        userRotations[getCardState(card)._file.name] = lbRotation;
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
    const mode = getCardState(card)._sourceMode ?? 'raw';

    if (mode === 'jpeg') {
        if (getCardState(card)._embeddedPreview && getCardState(card)._lightbox) {
            const { w, h } = getCardState(card)._lightbox;
            const { bmp, orientation } = getCardState(card)._embeddedPreview;
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
        getCardState(card)._sourceMode = 'raw';
    }

    if (mode === 'jxl') {
        // M-1 (Findings 11, 29): bind the derived-cache lookup once so LRU is promoted
        // exactly once and there is no between-gets eviction window.
        const _jxlAid = getCardState(card)?._assetId;
        const _hit = _jxlAid ? jxlDerivedCache.get(_jxlAid) : getCardState(card)['_jxlDecoded'];
        if (!getCardState(card)._blobUrl) {
            // JXL not ready yet — fall back to raw.
            getCardState(card)._sourceMode = 'raw';
        } else if (_hit) {
            // Cached from prefetch — instant paint (Findings 11, 29: read from DerivedCache).
            const { rgba, w, h } = _hit;
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
            // Finding 48: stamp generation at dispatch so stale results from a prior
            // reprocess are rejected before any canvas/cache mutation.
            const _lbDecodeTag = (() => {
                const assetId = getCardState(card)?._assetId;
                return assetId ? assetStateStore.makeResultTag(assetId) : null;
            })();
            decodeJxlViaSession(getCardState(card)._blobUrl, (msg) => {
                if (lightboxIndex < 0 || cards[lightboxIndex] !== card) return;
                // Finding 48: reject stale decode before touching canvas.
                if (_lbDecodeTag) {
                    const asState = assetStateStore.getOrCreate(_lbDecodeTag.assetId);
                    if (assetStateStore.isStale(_lbDecodeTag, asState)) return;
                }
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
                cacheTag: _lbDecodeTag, // Finding 48: gate cache write on generation
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
    // RGB so getCardState(card)._lightbox.rgb is set without needing a fetch; if JXL is
    // ready first, auto-promote to JXL mode so the user sees real output.
    //
    // Order of preference:
    //   1. Full lightbox-sized RGB (best — only set in WASM mode, or after
    //      a slider edit in Tauri)
    //   2. Embedded JPEG preview (the fast-arriving JPEG, swapped to the
    //      larger ~1620×1080 preview via fetchLargePreviewIfNeeded)
    //   3. JXL decode (WASM only — Tauri stays on embedded)
    //   4. 1×1 clear (nothing available yet)
    const hasFullRgb     = !!(getCardState(card)._lightbox && getCardState(card)._lightbox.rgb);
    const hasEmbedded    = !!getCardState(card)._embeddedPreview;

    // WASM only: when JXL bytes arrive before RGB, jump to JXL mode so the
    // user sees real encoded output instead of the JPEG preview placeholder.
    // Tauri intentionally skips this — embedded JPEG stays primary until a
    // slider edit triggers `apply_look`.
    if (!hasFullRgb && getCardState(card)._blobUrl && !IS_TAURI) {
        getCardState(card)._sourceMode = 'jxl';
        drawLightboxForCard(card);
        return;
    }

    if (hasFullRgb) {
        const lb = getCardState(card)._lightbox;
        // Phase 2: if sensor-orient pixels with EXIF orientation, draw rotated via GPU.
        // Non-rotated paints return their ImageData (TTFP-2 pattern) so the
        // clean snapshot skips the full-canvas readback; rotated paints were
        // composed on the GPU and still need getImageData.
        let rawFrame = null;
        if (lb.nativeW && lb.orientation && lb.orientation !== 1) {
            rawFrame = drawSensorWithOrientation(lightboxCanvas, lb.rgb, lb.nativeW, lb.nativeH, lb.orientation);
        } else {
            rawFrame = drawCanvas(lightboxCanvas, lb.w, lb.h, lb.rgb);
        }
        if (lightboxCanvas.width > 0) {
            const _ctx = lightboxCanvas.getContext('2d');
            captureCleanAndApplyLens(rawFrame ?? _ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height));
        }
        setPaintedSourceBadge('raw');
        lbLoadingBadge.hidden = true;
        applyStraightenToLightboxCanvas(card);
    } else if (hasEmbedded) {
        const { bmp, orientation } = getCardState(card)._embeddedPreview;
        // In Tauri mode, the initial fast-emit JPEG is the tiny ~160×120 IFD1
        // thumbnail.  Drawing it would size the lightbox canvas to that, then
        // jump bigger when fetchLargePreviewIfNeeded swaps in the ~1620×1080
        // preview (different aspect ratio — 4:3 vs 3:2).  Defer until the
        // large preview lands so the lightbox starts at the correct size.
        const isSmallInTauri = IS_TAURI && Math.max(bmp.width, bmp.height) < 600
                              && !getCardState(card)._largePreviewFetched;
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
            const knownW = getCardState(card)._lightbox?.w;
            const knownH = getCardState(card)._lightbox?.h;
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
        // BLISS OPFS: instant cross-session preview while RAW decode is in flight.
        const _blissAid = getCardState(card)?._assetId;
        if (_blissAid) blissOpfsLoad(card, _blissAid);
    }
    // Tauri lightbox no longer eagerly fetches the RAW RGB on open — that
    // happens only when the user moves a slider (triggerLiveUpdateTauri →
    // apply_look returns a fresh RAW frame and paints it directly).  This
    // keeps lightbox display latency bounded by the embedded preview path
    // instead of the full RAW pipeline + JXL queue.
    updateToggleButtonState(card);
    syncZoomToDisplayLong();
    // Final safety net for straighten in any remaining paths
    if (card && getCardState(card)._crop && getCardState(card)._crop.angle) {
        applyStraightenToLightboxCanvas(card);
    }
}

function updateToggleButtonState(card) {
    const mode   = getCardState(card)?._sourceMode ?? 'raw';
    const labels = { raw: 'RAW', jxl: 'JXL', jpeg: 'JPEG' };
    const havePair = !!(card && (getCardState(card)._lightbox || getCardState(card)._embeddedPreview || getCardState(card)._blobUrl));
    if (lbToggleJpegBtn) {
        lbToggleJpegBtn.disabled = !havePair;
        lbToggleJpegBtn.textContent = labels[mode] ?? 'RAW';
        lbToggleJpegBtn.setAttribute('data-mode', mode);
        // Legacy class kept for any external CSS hooks.
        lbToggleJpegBtn.classList.toggle('showing-jpeg', mode === 'jpeg');
    }
    // Lossless archival JXL export is only meaningful for JPEG sources — show the
    // button only when the card's source file is a JPEG.
    if (lbArchivalBtn) {
        const isJpegCard = /\.(jpg|jpeg|jfif)$/i.test(getCardState(card)?._file?.name || '');
        lbArchivalBtn.hidden = !isJpegCard;
    }
}

// Single source-of-truth badge for the actually painted source. Colour-coded:
// JPEG=green, JXL=blue, RAW=brown. Always visible in normal lightbox mode.
// Dims are read from the canvas — that is the natural pixel size of the
// painted source, which the user wants to see so they can correlate apparent
// sharpness with source resolution (Embedded JPEG ~1620×1080 vs JXL ~5184×3888).
function setPaintedSourceBadge(source) {
    if (!lbPreviewBadge) return;
    const labels = { raw: 'RAW', jxl: 'JPEG XL', jpeg: 'Embedded JPEG', bliss: 'BLISS (cached)' };
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

function fmtCameraWb(card) {
    const wb = getCardState(card)?._cameraWb;
    if (!wb) return null;
    return `r\xD7${wb.r.toFixed(2)}  g\xD71.00  b\xD7${wb.b.toFixed(2)}`;
}
function buildInfoRows(card) {
    const ex = getCardState(card)._exif;
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
        ['Camera WB', fmtCameraWb(card)],
        ['Orientation', ORIENTATION_LABEL[ex.orientation] || (ex.orientation != null ? String(ex.orientation) : null)],
        ['Dimensions', dim],
        ['Format',    _formatLabel(ex)],
        ['Quality',   fmtQuality(ex.quality)],
        ['Pipeline',  getCardState(card)._pipelineMs != null ? `${getCardState(card)._pipelineMs.toFixed(0)} ms` : null],
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
// pixels in the jxlDerivedCache so manual toggle / zoom is instant.
// (Findings 11, 29: no longer stored in per-card _jxlDecoded.)
const PREFETCH_NEIGHBORS = 2;
function prefetchJxl(card, priority = 'normal') {
    if (!card || !getCardState(card)._blobUrl) return;
    // Findings 11, 29: check the governed DerivedCache.
    const _prefetchAssetId0 = getCardState(card)?._assetId;
    if (_prefetchAssetId0 ? jxlDerivedCache.get(_prefetchAssetId0) : getCardState(card)['_jxlDecoded']) return;
    if (getCardState(card)._jxlPrefetching) return;
    getCardState(card)._jxlPrefetching = true;
    // Finding 48: stamp the result tag at dispatch time so the callback can
    // reject stale results that arrive after a reprocess has bumped the generation.
    const _prefetchTag = (() => {
        const assetId = getCardState(card)._assetId;
        return assetId ? assetStateStore.makeResultTag(assetId) : null;
    })();
    decodeJxlViaSession(getCardState(card)._blobUrl, (msg) => {
        if (msg.type === 'decode_error' || msg.type === 'jxl_decoded' || msg.isFinal === true) {
            getCardState(card)._jxlPrefetching = false;
        }
        // Finding 48: reject stale results before touching the cache or canvas.
        if (_prefetchTag) {
            const asState = assetStateStore.getOrCreate(_prefetchTag.assetId);
            if (assetStateStore.isStale(_prefetchTag, asState)) return;
        }
    }, priority, {
        progressive: true,
        cachePolicy: 'onFinal',
        progressiveDetail: 'lastPasses',
        cacheTarget: card,
        cacheTag: _prefetchTag, // Finding 48: gate cache write on generation
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
        if (getCardState(card)._taskId != null) pool.setPriority(getCardState(card)._taskId, prio);
        else getCardState(card)._pendingPriority = prio;
        // Tauri side: each promote_file call allocates a fresh ever-decreasing
        // priority on the backend, so the LAST call wins the front of the
        // queue.  Order matters here — neighbours first, current last.
        if (IS_TAURI && getCardState(card)._tauriPath) {
            invoke('promote_file', { path: getCardState(card)._tauriPath }).catch(() => {});
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
// it into getCardState(card)._embeddedPreview so the lightbox shows a high-quality placeholder
// while the RAW pipeline finishes.  No-op if the full RAW lightbox is already
// drawn or a fetch is already pending.
//
// Debounced — spamming right-arrow through unprocessed files would otherwise
// queue a get_large_preview RPC per step.  We wait until the user stays on
// the same card for 80 ms before firing.
let _largePrevDebounceTimer = null;
let _largePrevDebounceTarget = null;
function fetchLargePreviewIfNeeded(card) {
    if (!IS_TAURI || !card || !getCardState(card)._tauriPath) return;
    if (getCardState(card)._largePreviewFetched || getCardState(card)._largePreviewFetching) return;
    if (getCardState(card)._lightbox && getCardState(card)._lightbox.rgb) return; // RAW already there
    _largePrevDebounceTarget = card;
    clearTimeout(_largePrevDebounceTimer);
    _largePrevDebounceTimer = setTimeout(() => {
        if (_largePrevDebounceTarget !== card) return;
        if (getCardState(card)._largePreviewFetched || getCardState(card)._largePreviewFetching) return;
        if (getCardState(card)._lightbox && getCardState(card)._lightbox.rgb) return;
        getCardState(card)._largePreviewFetching = true;
        invoke('get_large_preview', { path: getCardState(card)._tauriPath })
            .then((bytes) => {
                const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
                const orientation = getCardState(card)._embeddedPreview?.orientation || 1;
                return createImageBitmap(new Blob([u8], { type: 'image/jpeg' }))
                    .then(bmp => ({ bmp, orientation }));
            })
            .then(({ bmp, orientation }) => {
                const prev = getCardState(card)._embeddedPreview;
                if (!prev || bmp.width * bmp.height > prev.bmp.width * prev.bmp.height) {
                    if (prev?.bmp && prev.bmp !== bmp) try { prev.bmp.close(); } catch {}
                    getCardState(card)._embeddedPreview = { bmp, w: bmp.width, h: bmp.height, orientation };
                } else {
                    try { bmp.close(); } catch {}
                }
                getCardState(card)._largePreviewFetched = true;
                if (lightboxIndex >= 0 && cards[lightboxIndex] === card &&
                    !(getCardState(card)._lightbox && getCardState(card)._lightbox.rgb)) {
                    drawLightboxForCard(card);
                }
            })
            .catch((e) => { console.warn('get_large_preview failed:', e); })
            .finally(() => { getCardState(card)._largePreviewFetching = false; });
    }, 80);
}

function openLightbox(card) {
    lightboxIndex = cards.indexOf(card);
    lbRotation = getCardState(card)._file?.name ? (userRotations[getCardState(card)._file.name] ?? 0) : 0;
    getCardState(card)._sourceMode = 'raw';
    resetLookSliders();
    // Auto-load sidecar if present
    if (typeof loadSidecar === 'function' && (getCardState(card)._tauriPath || getCardState(card)._file?.name)) {
        const sidecarPath = getCardState(card)._tauriPath || getCardState(card)._file?.name;
        // Finding 46: pass the stable assetId so the browser localStorage lookup
        // reads the same stable-id key saveSidecar writes (Tauri keys on path).
        loadSidecar(sidecarPath, getCardState(card)._assetId).then(sidecar => {
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
        const ang = getCardState(card)._crop?.angle || 0;
        lbStraighten.value = String(ang);
        if (lbStraightenVal) lbStraightenVal.textContent = ang.toFixed(1) + '°';
    }
    // If a crop is saved on this card, fit-to-crop instead of fit-to-image.
    if (getCardState(card)._crop) {
        requestAnimationFrame(() => focusOnRegion(getCardState(card)._crop.x, getCardState(card)._crop.y, getCardState(card)._crop.w, getCardState(card)._crop.h));
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
    lbRotation = getCardState(card)._file?.name ? (userRotations[getCardState(card)._file.name] ?? 0) : 0;
    drawLightboxForCard(card);
    renderInfoPanel(card);
    refreshFilmstripPrimary();
}

function closeLightbox() {
    lightbox.hidden = true;
    lightboxIndex = -1;
    // Stop the debounced live-update loop and clear its in-flight/pending flags.
    // Without this, a live reprocess that resolves after close leaves
    // liveInFlight=true and can stash a stale livePendingLook, which defeats the
    // debounce on the next lightbox open. The retained worker liveStateMap is
    // intentionally NOT freed here — re-opening the SAME card must still support
    // live slider edits; genuine teardown (card removal) frees it via removeCard.
    clearTimeout(liveDebounceTimer);
    liveInFlight = false;
    livePendingLook = null;
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
    if (cur && getCardState(cur)._focusedSubjectId !== undefined && getCardState(cur)._subjects?.length) {
        const ids = [null, ...getCardState(cur)._subjects.map(s => s.id)];
        const at  = ids.indexOf(getCardState(cur)._focusedSubjectId);
        const nextAt = at + dir;
        if (nextAt >= 0 && nextAt < ids.length) {
            const nextId = ids[nextAt];
            getCardState(cur)._focusedSubjectId = nextId;
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
        getCardState(cur)._focusedSubjectId = undefined;
    }
    lightboxIndex = (lightboxIndex + dir + cards.length) % cards.length;
    const card = cards[lightboxIndex];
    if (card) getCardState(card)._sourceMode = 'raw';
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
        const ang = getCardState(card)._crop?.angle || 0;
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
    const crop = getCardState(card)?._crop;
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

    // Finding 13 (P0): wire the "Export selected" button to ExportService.
    // Previously this button existed in the DOM but was never connected to any
    // handler — clicking it did nothing.  Now it drives a full-resolution export
    // of all filmstrip-selected cards using the current metadata policy from the
    // export settings (defaults to 'keep').
    const exportBtn = document.getElementById('filmstrip-export-selection');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            exportFilmstripSelection();
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
            label.textContent = (getCardState(card)._file?.name || 'img').replace(/\.[^.]+$/, '').slice(-8);
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
                    getCardState(targetCard)._sourceMode = getCardState(targetCard)._sourceMode || 'raw';
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
                getCardState(c)._sourceMode = getCardState(c)._sourceMode || 'raw';
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
        if (c && getCardState(c)._taskId) taskIds.push(getCardState(c)._taskId);
        // Also update any live state on the card objects themselves (for gallery)
        if (c) getCardState(c)._pendingLookBatch = { ...look };
    });

    // Reuse the existing live machinery (best effort)
    if (typeof pool !== 'undefined' && pool.reprocessAllLive && taskIds.length) {
        pool.reprocessAllLive(taskIds, look);
    } else if (typeof scheduleGalleryLiveUpdate === 'function') {
        // Fallback: will at least update visible gallery thumbs
        scheduleGalleryLiveUpdate();
    }

    // On Tauri we also want sidecars written for the selected files.
    // Finding 40: pass the ITERATED card `c` so buildSidecarData serializes THAT
    //   card's per-asset state via the store — not the ambient lightboxCard(),
    //   which would serialize the same card N times across the batch.
    // Finding 46: AWAIT each write and collect failures so a failed durable write
    //   is surfaced to the user instead of being swallowed by .catch(()=>{}).
    if (window.IS_TAURI) {
        (async () => {
            const failures = [];
            for (const i of indices) {
                const c = cards[i];
                const fname = getCardState(c)?._tauriPath || getCardState(c)?._file?.name;
                if (fname && typeof window.saveSidecar === 'function') {
                    try {
                        await window.saveSidecar(fname, c);
                    } catch (err) {
                        console.error('batch sidecar save failed for', fname, err);
                        failures.push(fname);
                    }
                }
            }
            if (failures.length && statusText) {
                statusBar.hidden = false;
                statusText.textContent = `save failed: ${failures.length} file${failures.length === 1 ? '' : 's'}`;
            }
        })().catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// Finding 13 (P0): Export selected via ExportService
// ---------------------------------------------------------------------------

/**
 * Export all filmstrip-selected cards at FULL RESOLUTION.
 *
 * Routes through ExportService (single entry point for all export paths).
 *
 * I-A: full resolution is sourced from the DEVELOPED FULL-RES OUTPUT — the
 *   full-res developed JXL (`_blobUrl`, dims from `_exif.width/height`) — NEVER
 *   the 1800px `_lightbox` preview.  JXL/keep passes the developed bytes through
 *   unchanged.  Other outputs decode the full-res developed JXL and re-encode.
 * I-B: only formats that genuinely encode are offered (jxl/png real; jpeg/tiff
 *   gated).  PNG produces honest PNG bytes from the full-res RGBA.
 * I-C: the metadata privacy policy is serialised to EXIF bytes and threaded into
 *   the encoder (GPS absent under strip-gps/strip-all).
 */
async function exportFilmstripSelection() {
    if (filmstripSelection.size === 0) return;

    const indices = [...filmstripSelection];
    // Collect cards and their assetIds in selection order.
    const selectedCards = indices.map(i => cards[i]).filter(Boolean);
    if (selectedCards.length === 0) return;

    // Derive assetIds; cards without one are skipped (not yet decoded).
    const assetIds = selectedCards
        .map(c => getCardState(c)?._assetId)
        .filter(Boolean);
    if (assetIds.length === 0) return;

    // Read metadata policy from an optional export-settings panel element.
    // Falls back to 'keep' when no panel element is wired yet.
    const policyEl = document.getElementById('export-metadata-policy');
    const metadata  = (policyEl?.value === 'strip-gps' || policyEl?.value === 'strip-all')
        ? policyEl.value : 'keep';

    // Read output format from optional export-format picker, default to 'jxl'.
    const fmtEl = document.getElementById('export-output-format');
    const output = (['jxl','jpeg','png','tiff'].includes(fmtEl?.value))
        ? fmtEl.value : 'jxl';

    // Finding 47 (P4 T8): load export-service + png-encode lazily on first click.
    let exportMods;
    try {
        exportMods = await lazyExport();
    } catch (err) {
        console.error('[export] failed to load export modules:', err);
        if (statusText) {
            statusBar.hidden = false;
            statusText.textContent = 'Export unavailable — module load failed.';
        }
        return;
    }
    const { ExportService, isFormatEncodable: _isFormatEncodable, encodePng: _encodePng } = exportMods;

    // I-B: guard at the entry point too (defence in depth — the UI disables
    // gated options, and the service rejects them per-asset).  Fail fast with a
    // single status message rather than emitting N identical per-asset errors.
    if (!_isFormatEncodable(output)) {
        if (statusText) {
            statusBar.hidden = false;
            statusText.textContent = `${output.toUpperCase()} export is not available yet (packet-3).`;
        }
        return;
    }

    const cardForAsset = (assetId) => cards.find(c => getCardState(c)?._assetId === assetId) ?? null;
    // Tracks which asset the service is currently processing, so decodeFullRes
    // can find the right card (the service passes bytes, not the assetId).  Set
    // on each 'preparing' progress event below (the service is strictly serial).
    let _currentExportAssetId = null;

    // Create the ExportService, injecting the developed-output source + encoders.
    const svc = new ExportService({
        getCardStateByAssetId(assetId) {
            const c = cardForAsset(assetId);
            return c ? getCardState(c) : null;
        },
        // I-A: the developed FULL-RES output.  `_blobUrl` is the full-res
        // developed JXL blob; fetch its bytes lazily.  Dims come from the sensor
        // dims patched onto _exif at DONE (msg.w/msg.h), never the preview.
        async getDevelopedOutput(state) {
            const url = state?._blobUrl;
            const w = state?._exif?.width, h = state?._exif?.height;
            if (!url || !w || !h) return null;
            const resp = await fetch(url);
            const jxlBytes = new Uint8Array(await resp.arrayBuffer());
            return { jxlBytes, w, h };
        },
        // I-A: if the developed full-res JXL is not present yet, trigger the
        // existing full-res convert flow and await it.
        async ensureDeveloped(assetId) {
            const c = cardForAsset(assetId);
            if (!c) return;
            if (getCardState(c)?._blobUrl) return;          // already developed
            await new Promise((resolve) => {
                const t0 = Date.now();
                const poll = () => {
                    if (getCardState(c)?._blobUrl || Date.now() - t0 > 60000) return resolve();
                    setTimeout(poll, 150);
                };
                // Kick a full-res reprocess if one is not already in flight.
                try { if (typeof startConvert === 'function') startConvert(getCardState(c)._file, c); } catch {}
                poll();
            });
        },
        // Decode the developed FULL-RES JXL back to full-res RGBA (never the
        // preview).  Reuses the existing full-JXL decode path.
        //
        // NOTE: `_jxlBytes` is intentionally UNUSED. We decode by asset id via
        // the card's blob URL through the shared session (decodeFullJxlFor)
        // rather than decoding the passed buffer directly — this reuses the
        // warm decode session and its full-dims sizing. The parameter is kept
        // to match the ExportService capability signature; do not wire it to a
        // fresh decode without also routing sizing/session state.
        async decodeFullRes(_jxlBytes) {
            // We decode via the card's blob URL through the shared session
            // (decodeFullJxlFor), which yields { rgba, w, h } at full dims.
            const c = cardForAsset(_currentExportAssetId);
            if (!c) throw new Error('card not found for full-res decode');
            const dec = await window.decodeFullJxlFor(c);
            if (!dec || !dec.rgba) throw new Error('full-res JXL decode failed');
            return { pixels: dec.rgba, w: dec.w, h: dec.h, format: 'rgba8' };
        },
        // Re-encode full-res pixels to the requested format, embedding the
        // policy-serialised metadata bytes (I-C).
        async encodePixels(pixels, w, h, format, orientation, outputFmt, metadataBytes) {
            if (outputFmt === 'png') {
                // I-B: honest PNG bytes.  (PNG carries no EXIF here; the privacy
                // policy is still honoured because no metadata is embedded.)
                return _encodePng(pixels, w, h, format === 'rgb8' ? 'rgb8' : 'rgba8');
            }
            // jxl re-encode with serialised EXIF/XMP (I-C).
            const quality = 90, effort = 3;
            return encodeJxlSession(pixels, w, h, quality, effort, false, false, format, orientation, metadataBytes);
        },
    });

    // Disable the button while exporting.
    const exportBtn = document.getElementById('filmstrip-export-selection');
    if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.textContent = 'Exporting…';
    }

    let doneCount = 0, errorCount = 0;

    try {
        const req = { assetIds, output, metadata, resolution: 'full' };
        for await (const ev of svc.export(req)) {
            if (ev.type === 'progress') {
                // Track the in-flight asset so decodeFullRes finds the right card.
                _currentExportAssetId = ev.assetId;
                if (exportBtn) exportBtn.textContent = `Exporting… (${ev.phase})`;
            } else if (ev.type === 'done') {
                doneCount++;
                // Trigger browser download for each exported file.
                const url = URL.createObjectURL(new Blob([ev.bytes], { type: _mimeForOutput(output) }));
                const a = document.createElement('a');
                a.href = url;
                a.download = ev.filename;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 30000);
            } else if (ev.type === 'error') {
                errorCount++;
                console.error('[export]', ev.assetId, ev.error);
            }
        }
    } finally {
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.textContent = errorCount > 0
                ? `Export selected (${errorCount} error${errorCount > 1 ? 's' : ''})`
                : 'Export selected';
        }
    }

    if (doneCount > 0 && statusText) {
        statusBar.hidden = false;
        statusText.textContent = `Exported ${doneCount} file${doneCount === 1 ? '' : 's'}` +
            (errorCount > 0 ? ` (${errorCount} failed)` : '');
    }
}

function _mimeForOutput(fmt) {
    return { jxl: 'image/jxl', jpeg: 'image/jpeg', png: 'image/png', tiff: 'image/tiff' }[fmt] ?? 'application/octet-stream';
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
    const stem = stripRawExtension(getCardState(card)._file?.name || 'image');
    lightboxCanvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = stem + '-fullres.jpg'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }, 'image/jpeg', 0.95);
});

// Archival (lossless) export for JPEG cards: transcode the ORIGINAL jpeg bytes
// to a lossless JXL (bit-exact recoverable, ~20% smaller), independent of any
// edits. Edits live in the sidecar; this ships the untouched original as JXL.
async function exportArchivalJxl(card) {
    const file = getCardState(card)?._file;
    if (!file || typeof file.arrayBuffer !== 'function') return; // browser File only (Tauri path is a follow-up)
    const name = file.name || 'image';
    if (!/\.(jpg|jpeg|jfif)$/i.test(name)) return;
    let transcodeJpegToJxl;
    try {
        ({ transcodeJpegToJxl } = await import('../packages/jxl-wasm/dist/facade.js'));
    } catch (e) { console.error('archival: facade import failed', e); return; }
    let jxl;
    try {
        jxl = await transcodeJpegToJxl(new Uint8Array(await file.arrayBuffer()));
    } catch (e) { console.error('archival transcode failed', e); return; }
    const stem = name.replace(/\.(jpg|jpeg|jfif)$/i, '');
    const url = URL.createObjectURL(new Blob([jxl], { type: 'image/jxl' }));
    const a = document.createElement('a');
    a.href = url; a.download = stem + '.archival.jxl'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}
window.exportArchivalJxl = exportArchivalJxl;
if (lbArchivalBtn) {
    lbArchivalBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = cards[lightboxIndex];
        if (card) exportArchivalJxl(card);
    });
}

// ── AI-ID "Identify" (finding 16 wiring): build the 768px proxy JPEG +
// casava-ai/1 sidecar for the current lightbox asset and download both.
// Source chain (browser-adapter): live clean snapshot → embedded JPEG inside
// the RAW bytes → archival JXL master → preview-tier RAW re-decode
// (OUT_LIGHTBOX only — the streaming half-res arm, never a full 20 MP
// develop; the sub-second capture→proxy→identify budget is dominated by
// this decode). All modules load lazily on first use.
let _idWasmReady = null;

// decodeJxl(bytes) for the master source: route through the shared
// jxl-session scheduler via a transient blob URL.
function _idDecodeJxlBytes(bytes) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jxl' }));
        let settled = false;
        const done = (fn) => (v) => {
            if (settled) return;
            settled = true;
            URL.revokeObjectURL(url);
            fn(v);
        };
        decodeJxlViaSession(url, (msg) => {
            if (msg.type === 'decode_error') done(reject)(new Error(msg.error));
            else if (msg.type === 'jxl_decoded') done(resolve)({ data: msg.rgba, width: msg.w, height: msg.h });
        }, 'high');
    });
}

// encodeJpeg for encodeProxyJpeg: OffscreenCanvas → image/jpeg bytes.
async function _idEncodeJpeg(rgba, w, h, quality) {
    const clamped = rgba instanceof Uint8ClampedArray
        ? rgba
        : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(clamped, w, h), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
    return new Uint8Array(await blob.arrayBuffer());
}

// downscaleRgba for encodeProxyJpeg (must be sync): single-step canvas resample.
function _idDownscaleRgba(rgba, w, h, tw, th) {
    const clamped = rgba instanceof Uint8ClampedArray
        ? rgba
        : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    const src = new OffscreenCanvas(w, h);
    src.getContext('2d').putImageData(new ImageData(clamped, w, h), 0, 0);
    const dst = new OffscreenCanvas(tw, th);
    const dctx = dst.getContext('2d');
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(src, 0, 0, w, h, 0, 0, tw, th);
    return new Uint8Array(dctx.getImageData(0, 0, tw, th).data.buffer);
}

// Last-resort RAW decode at preview tier (lens item 5.9): OUT_LIGHTBOX only
// (1800 px ≥ the 768 px proxy target) takes the streaming half-res superpixel
// arm — several times faster, ~6× lower peak than a full-res develop. WASM
// initializes on the main thread lazily and only if this path actually fires.
async function _idDecodeRawPreview(rawBytes, nm) {
    if (!rawBytes) throw new Error('identify: no RAW bytes in memory for ' + nm);
    const ext = (nm.toLowerCase().match(/\.([^.]+)$/) || [])[1];
    const fn = {
        orf: rawWasm.process_orf_with_flags,
        dng: rawWasm.process_dng_with_flags,
        cr2: rawWasm.process_cr2_with_flags,
    }[ext];
    if (typeof fn !== 'function') throw new Error('identify: unsupported RAW: ' + nm);
    await (_idWasmReady ||= rawWasm.default());
    const OUT_LIGHTBOX = 2; // src/lib.rs output_flags bit: 1800 px RGB16 preview
    const r = fn(rawBytes, OUT_LIGHTBOX, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
    let w, h, wbR, wbB, renderer;
    try {
        w = r.lb_w; h = r.lb_h; wbR = r.wb_r_used; wbB = r.wb_b_used;
        renderer = r.take_lightbox_renderer();
    } finally { r.free(); }
    try {
        const rgb = renderer.render_look({
            wbR, wbB, exposureEv: 0, contrast: 0, highlights: 0, shadows: 0,
            whites: 0, blacks: 0, saturation: 0, vibrance: 0, temp: 0, tint: 0,
            texture: 0, clarity: 0,
        });
        return { rgb, width: w, height: h };
    } finally { renderer.free(); }
}

async function _idSha256Hex(bytes) {
    if (!bytes || !crypto?.subtle) return '';
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

function _idDownload(bytes, filename, mime) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function identifyCurrentAsset() {
    const card = cards[lightboxIndex];
    if (!card) return;
    const st = getCardState(card);
    const file = st._file;
    const name = file?.name || 'asset';
    const [{ makeBrowserSources, buildSidecarForAsset, browserDecodeJpeg }, { resolveProxy }] =
        await Promise.all([import('./ai-id/browser-adapter.js'), import('./ai-id/proxy.mjs')]);

    const rawBytes = (file && isRawFilename(name) && typeof file.arrayBuffer === 'function')
        ? new Uint8Array(await file.arrayBuffer()) : null;

    const sources = makeBrowserSources({
        liveRgba: cleanSnapshot?.data ?? null,
        liveW: cleanSnapshot?.width ?? 0,
        liveH: cleanSnapshot?.height ?? 0,
        // This page has no OPFS JXL pyramid store (that's the pyramid-gallery
        // page); decoded RGBA already reaches the chain via the live buffer.
        getJxlPyramidBytes: async () => null,
        getRawBytes: async () => rawBytes,
        decodeJpegBytes: browserDecodeJpeg,
        getMasterBytes: async () => {
            const url = st._blobUrl;
            if (!url) return null;
            try { return new Uint8Array(await (await fetch(url)).arrayBuffer()); }
            catch { return null; }
        },
        decodeJxl: _idDecodeJxlBytes,
        decodeRaw: (nm) => _idDecodeRawPreview(rawBytes, nm),
        rgbToRgba: rgbToRgbaArr,
        assetPath: name,
    });

    const proxy = await resolveProxy(sources, {
        encodeJpeg: _idEncodeJpeg,
        downscaleRgba: _idDownscaleRgba,
    });

    // Sidecar: stable asset identity + the export panel's privacy policy.
    const policyEl = document.getElementById('export-metadata-policy');
    const metadataPolicy = (policyEl?.value === 'strip-gps' || policyEl?.value === 'strip-all')
        ? policyEl.value : 'keep';
    const exif = st._exif || {};
    const gps = exif.gps;
    const sidecar = buildSidecarForAsset({
        assetId: st._assetId || name,
        filename: name,
        sha256: await _idSha256Hex(rawBytes),
        bytes: rawBytes ? rawBytes.byteLength : (file?.size ?? 0),
        format: (name.toLowerCase().match(/\.([^.]+)$/) || [])[1] || '',
        width: proxy.w,
        height: proxy.h,
        orientationApplied: proxy.source !== 'raw', // raw preview is sensor-orient
        datetimeExif: exif.datetime || '',
        decoded: gps
            ? { has_gps: true, gps_lat: gps.lat, gps_lon: gps.lon, gps_alt: gps.alt ?? 0 }
            : { has_gps: false, gps_lat: 0, gps_lon: 0, gps_alt: 0 },
        metadataPolicy,
    });
    sidecar.proxy.source = proxy.source; // which chain source produced the proxy

    const stem = stripRawExtension(name);
    _idDownload(proxy.jpeg, stem + '.id-proxy.jpg', 'image/jpeg');
    _idDownload(new TextEncoder().encode(JSON.stringify(sidecar, null, 2)),
                stem + '.ai.json', 'application/json');
}
window.identifyCurrentAsset = identifyCurrentAsset;
if (lbIdentifyBtn) {
    lbIdentifyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (lightboxIndex < 0) return;
        lbIdentifyBtn.disabled = true;
        try {
            await identifyCurrentAsset();
        } catch (err) {
            console.error('identify failed:', err);
        } finally {
            lbIdentifyBtn.disabled = false;
        }
    });
}

// Straighten slider (Phase 2) — immediate visual feedback using the geometry + render path
if (lbStraighten) {
    lbStraighten.addEventListener('input', () => {
        const card = cards[lightboxIndex];
        if (!card) return;
        const angle = parseFloat(lbStraighten.value) || 0;
        if (lbStraightenVal) lbStraightenVal.textContent = angle.toFixed(1) + '°';

        // Create or update the crop descriptor with the angle
        const existing = getCardState(card)._crop || { x: 0.05, y: 0.05, w: 0.9, h: 0.9, ratio: 'free' };
        getCardState(card)._crop = {
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
        const currentAngle = getCardState(card)._crop?.angle || 0;
        const ratio = getCardState(card)._crop?.ratio || 'free';
        const newCrop = computeStraightenCrop(lightboxCanvas.width, lightboxCanvas.height, currentAngle, ratio);
        if (newCrop) {
            getCardState(card)._crop = newCrop;
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
            const sidecarPath = getCardState(card)?._tauriPath || getCardState(card)?._file?.name;
            // Finding 40/46: pass the target card explicitly (correct per-card state)
            // and surface the write error instead of leaving an uncaught rejection.
            if (sidecarPath && typeof saveSidecar === 'function') {
                saveSidecar(sidecarPath, card).catch(err => {
                    console.error('sidecar save failed for', sidecarPath, err);
                    if (statusText) {
                        statusBar.hidden = false;
                        statusText.textContent = 'save failed';
                    }
                });
            }
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
        if (cur && getCardState(cur)._focusedSubjectId) {
            getCardState(cur)._focusedSubjectId = undefined;
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

    toleranceEl?.addEventListener('input', async () => {
        colourSelect.tolerance = parseInt(toleranceEl.value, 10);
        if (colourSelect.seeds.length && colourSelect.labBuf) {
            const { selectByColour, unionMask } = await lazyPerceptual();
            const w = lightboxCanvas.width, h = lightboxCanvas.height;
            let mask = null;
            for (const seed of colourSelect.seeds) {
                const m = selectByColour(colourSelect.labBuf, w, h, seed, colourSelect.tolerance);
                mask = mask ? unionMask(mask, m) : m;
            }
            colourSelect.mask = mask;
            await refreshSelectionOverlay();
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
    const selected = cards.filter((c) => c.classList.contains('selected') && getCardState(c)._file);
    const targets = selected.length ? selected : cards.filter((c) => getCardState(c)._file);
    if (!targets.length) return;
    const ls = lookInputs
        .filter((el) => Number(el.value) !== 0)
        .map((el) => `${el.dataset.look}=${el.value}`)
        .join(' ');
    pushStat(`--- reprocess (${targets.length}) ${ls || '(all zero)'} ---`);
    for (const card of targets) startConvert(getCardState(card)._file, card);
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
    if (getCardState(card)._jxlThumbBmp) {
        try { getCardState(card)._jxlThumbBmp.close(); } catch {}
        getCardState(card)._jxlThumbBmp = null;
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
    getCardState(card)._tauriResult = result;

    // Tauri-only: ship dims now, fetch pixels lazily via get_lightbox(id) on
    // first lightbox open.  Cuts per-file IPC payload by ~30 MB JSON, which
    // benchmark showed is the dominant batch-queue gap.  getCardState(card)._lightbox stays
    // truthy so existing _lightbox checks (havePair, raw-mode gating) work.
    if (typeof result?.lightbox_width === 'number' && result?.id != null) {
        getCardState(card)._lightbox = {
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
        if (getCardState(card)._blobUrl) URL.revokeObjectURL(getCardState(card)._blobUrl);
        getCardState(card)._blobUrl = URL.createObjectURL(blob);
        // Findings 11, 29: invalidate the derived cache (Tauri JXL bytes changed).
        { const _taid = getCardState(card)._assetId; if (_taid) jxlDerivedCache.invalidate(_taid); else getCardState(card)['_jxlDecoded'] = null; }
        const dlBtn = card.querySelector('.thumb-dl-btn');
        if (dlBtn) dlBtn.hidden = false;
        refreshThumbToggleButton(card);
        updateToggleButtonState(card);
        // Repaint thumb from the JXL roundtrip so the grid shows JXL output.
        repaintThumbFromJxl(card);
        // Subject sibling cards: render their thumbs now that JXL is ready.
        if (getCardState(card)._subjects?.length && typeof window.renderSubjectThumb === 'function') {
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
        getCardState(card)._file = { name: filename };
        getCardState(card)._tauriPath = path;
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
            getCardState(card)._embeddedPreview = { bmp, w: bmp.width, h: bmp.height, orientation };
            getCardState(card)._sensorW = sensorW;
            getCardState(card)._sensorH = sensorH;
            refreshThumbToggleButton(card);
            if (lightboxIndex >= 0 && cards[lightboxIndex] === card && !getCardState(card)._lightbox) {
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

// ─── Finding 47 (P4 T8): benchmark harness + pixel-peep dev tools ──────────
// These ~1200 lines are IS_TAURI-gated dev tools that a browser user never
// invokes.  They are extracted to web/tools/benchmark.js and
// web/tools/pixel-peep.js and loaded lazily on first button click so they are
// NOT in main.js's static parse graph.
//
// Proxy stubs (pixelPeepActive, exitPixelPeep, etc.) keep the event handlers
// at lines ~3051/4393-4479 working before the first lazy init completes.
// ---------------------------------------------------------------------------

// Lazy: web/tools/benchmark.js — A/B harness + JXL decoder bench.
// Loaded on first click of any benchmark button.
const lazyBenchmark = makeLazyModule(() => import('./tools/benchmark.js'));

// Proxy state: event handlers registered before the lazy module loads read
// these.  They delegate to the handle once the module is alive.
// pixelPeepActive is kept in sync via the onActiveChange callback passed to initPixelPeep.
let _peepHandle = null;
let pixelPeepActive = false;

// Lazy: web/tools/pixel-peep.js — quality compare mode.
// Loaded on first "Pixel Peep" button click; initialised once with all deps.
const lazyPixelPeep = makeLazyModule(async () => {
    const { initPixelPeep } = await import('./tools/pixel-peep.js');
    const handle = initPixelPeep({
        invoke,
        IS_TAURI,
        pushStat,
        currentOptions,
        lookToSnake,
        lightbox,
        lightboxCanvas,
        lbSourceBanner,
        lbToggleJpegBtn,
        lbLoadingBadge,
        lbPreviewBadge,
        getLightboxIndex: () => lightboxIndex,
        clearLightboxIndex: () => { lightboxIndex = -1; },
        cards,
        getLbZoom: () => lbZoom,
        resetLbViewport: () => { lbZoom = 1.0; lbPanX = 0; lbPanY = 0; lbRotation = 0; applyLbTransform(); },
        applyLbTransform,
        captureCleanAndApplyLens,
        decodeJxlViaSession,
        AssetStore,
        // Keep main.js's pixelPeepActive proxy in sync whenever the module changes state.
        onActiveChange: (active) => { pixelPeepActive = active; },
    });
    _peepHandle = handle;
    return handle;
});

function exitPixelPeep()       { _peepHandle?.exitPixelPeep(); }
function peepNavPhoto(delta)    { _peepHandle?.peepNavPhoto(delta); }
function peepCycleQuality(delta){ _peepHandle?.peepCycleQuality(delta); }
function updatePeepBadges()     { _peepHandle?.updatePeepBadges(); }

// Wire benchmark buttons: on first click, lazy-load the module and call
// initBenchmark.  The module wires all buttons internally on init.
// Each button fires the lazy load exactly once (makeLazyModule memoises).
(function wireBenchmarkButtons() {
    const BENCH_BTN_IDS = [
        'run-benchmark', 'run-effort-sweep', 'run-variance-bench', 'run-quality-sweep',
        'run-jxl-bench', 'run-jxl-sweep', 'run-jxl-stress', 'run-jxl-thumb', 'run-jxl-disk',
    ];
    for (const id of BENCH_BTN_IDS) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        btn.addEventListener('click', async function onFirstClick() {
            // Remove this one-shot handler; the module will wire its own permanent handler.
            btn.removeEventListener('click', onFirstClick);
            try {
                const { initBenchmark } = await lazyBenchmark();
                initBenchmark({ invoke, listen, IS_TAURI, pushStat, updateStat, currentOptions, lookToSnake });
                // Re-dispatch so the now-wired permanent handler fires.
                btn.click();
            } catch (e) {
                pushStat(`[bench-init] failed to load benchmark module: ${e?.message || e}`);
            }
        }, { once: false });
    }
})();

// Wire the pixel-peep button: on first click, lazy-load + init the module.
// After init the module's own button handler takes over.
(function wirePixelPeepButton() {
    const peepBtn = document.getElementById('run-pixel-peep');
    if (!peepBtn) return;
    peepBtn.addEventListener('click', async function onFirstClick() {
        peepBtn.removeEventListener('click', onFirstClick);
        peepBtn.disabled = true;
        try {
            await lazyPixelPeep();
            // pixelPeepActive is now wired; re-dispatch so the module's handler fires.
            peepBtn.disabled = false;
            peepBtn.click();
        } catch (e) {
            pushStat(`[peep-init] failed to load pixel-peep module: ${e?.message || e}`);
            peepBtn.disabled = false;
        }
    }, { once: false });
})();

// Prefetch the benchmark + pixel-peep modules after the page is idle so that
// when a dev clicks a button the module is already resident.  Gated behind an
// idleness check (requestIdleCallback) to avoid contending with first-paint.
if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => {
        lazyBenchmark().catch(() => {});
        lazyPixelPeep().catch(() => {});
    }, { timeout: 5000 });
}

// ---------------------------------------------------------------------------
// Sentinel: BENCH_CONFIGS was the first top-level declaration of the benchmark
// harness.  Anything below this comment that used to be part of the benchmark
// harness or pixel-peep has been moved to web/tools/benchmark.js or
// web/tools/pixel-peep.js respectively.
// ---------------------------------------------------------------------------
// (previously: BENCH_CONFIGS through runQualitySweep + button wiring,
//  then pixel-peep section, then measurePaintTimings + JXL bench functions —
//  all removed from the static graph, now in the tool modules above)
// ---------------------------------------------------------------------------
//
// The next section is: Tauri live-look: invoked from triggerLiveUpdate
//
// ─── end of finding 47 (P4 T8) extraction ───────────────────────────────────
// Tauri live-look: invoked from triggerLiveUpdate when IS_TAURI
let tauriLiveInFlight = false;
let tauriLivePending = null;

async function triggerLiveUpdateTauri(look) {
    const card = cards[lightboxIndex];
    if (!card || !getCardState(card)._tauriResult) return;
    if (tauriLiveInFlight) { tauriLivePending = look; return; }
    tauriLiveInFlight = true;
    try {
        const buf = await invoke('apply_look', {
            id: getCardState(card)._tauriResult.id,
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
            if (!getCardState(card)._lightbox) getCardState(card)._lightbox = {};
            getCardState(card)._lightbox.w = w;
            getCardState(card)._lightbox.h = h;
        }
        const ctx = lightboxCanvas.getContext('2d');
        // TTFP-2 pattern: hand the ImageData we just painted straight to the
        // snapshot instead of reading the identical pixels back (the put fills
        // the whole canvas at (0,0) with opaque pixels, and the rgba buffer is
        // freshly allocated per call — no aliasing).
        const lookFrame = new ImageData(rgbToRgbaArr(rgb), w, h);
        ctx.putImageData(lookFrame, 0, 0);
        if (lightboxCanvas.width > 0) {
            captureCleanAndApplyLens(lookFrame);
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
    if (!card || !getCardState(card)._taskId) return false;
    try {
        // Stream the develop-slider deltas, then drive a progressive refinement
        // pass. Both are the real H29 exports detected above.
        h29.applyLookStream(getCardState(card)._taskId, lookToSnake(adjustments));
        h29.progressivePass(getCardState(card)._taskId);
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

// Finding 47 (P4 T8): tauri-parity-lightbox.js is loaded lazily on first lightbox
// open (first call to feedTauriParityBaseline, which fires when a frame paints).
// tauriParityLb is null until the lazy init completes; all callers already
// use optional chaining (tauriParityLb?.…) so null is safe before init.

let tauriParityLb = null;

// Lazy init: load the module and construct the lightbox instance once.
const _initTauriParityLb = makeLazyModule(async () => {
    const { createTauriParityLightbox } = await lazyTauriParity();
    const lb = createTauriParityLightbox({
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
    tauriParityLb = lb;
    window.tauriParityLb = lb;
    return lb;
});

// Feed the M2 FilterEngine a clean 8-bit baseline whenever a fresh frame lands
// on the lightbox canvas, so its sliders have pixels to transform.
// Fire-and-forget: lazy loads tauri-parity-lightbox.js on first call.
async function feedTauriParityBaseline(snapshot) {
    if (lightboxIndex < 0) return;
    const card = cards[lightboxIndex];
    if (!card) return;
    try {
        const lb = await _initTauriParityLb();
        let img = snapshot;
        if (!img) {
            if (!lightboxCanvas.width || !lightboxCanvas.height) return;
            const ctx = lightboxCanvas.getContext('2d');
            img = ctx.getImageData(0, 0, lightboxCanvas.width, lightboxCanvas.height);
        }
        lb.onBaseFramePainted(card, img.data, img.width, img.height);
    } catch { /* cross-tainted canvas, 0-size, or failed import: skip baseline feed */ }
}
window.feedTauriParityBaseline = feedTauriParityBaseline;

// ---------------------------------------------------------------------------
// Live perf debug hook — opt-in ONLY via ?debug=1.
// Exposes runtime stats to web/perf-dashboard/index.html (open in an iframe
// or adjacent tab). Never set in production — the query-param guard ensures
// zero overhead and zero globals on normal page loads.
// ---------------------------------------------------------------------------
if (new URLSearchParams(location.search).has('debug')) {
  // main.js uses its own internal WorkerPool (not the jxl-scheduler package).
  // Wrap it with a getStats() shim so the dashboard's Worker Pool + Scheduler
  // panels show live data from this page's actual worker pool.
  // Finding 3: jxl-session scheduler metrics replace the removed _jxl* queue fields.
  // The shared jxl-session context exposes scheduler metrics via getContext().
  const _schedulerAdapter = {
    getStats() {
      return {
        activeWorkers: pool.workers.length - pool.free.length,
        idleWorkers: pool.free.length,
        queueDepth: pool.queue.length + _jxlDecodeByUrl.size,
        dedupeSize: _jxlDecodeByUrl.size,
        draining: false, // concurrent with jxl-session — no single-lane busy flag
      };
    },
  };
  if (new URLSearchParams(location.search).has('debug')) {
    window.__perfDebug = {
      scheduler: _schedulerAdapter,
      assetStore: peepDecodedStore,
      // jxl-cache (JxlCacheBrowser) is not instantiated in main.js; null tells
      // the dashboard to show "—" for OPFS hit rate.
      jxlCache: null,
    };
  }
}
