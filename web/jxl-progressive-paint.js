import initRaw, * as rawWasm from './pkg/raw_converter_wasm.js';
import { createDecoder, createEncoder, detectTier, preloadJxlModule } from '@casabio/jxl-wasm';
import { initDebugConsole, dbgLog } from './jxl-debug-console.js';
import { createFilePicker } from './jxl-file-picker.js';
import { buildByteCutoffPlan, formatByteCutoffLabel } from './jxl-byte-cutoff-probe.js';
import { createSneyersPreset } from './jxl-progressive-best-preset.js';
import { computePsnrVsFinal } from './jxl-progressive-quality.js';
import { classifyByteCutoffFrame, summarizeByteCutoffResults, buildSeriesAsync } from './jxl-progressive-byte-metrics.js';
import { ButteraugliComparator } from '@casabio/jxl-wasm';
import { analyzeProgressiveFrame, formatFrameStatsCompact, formatFrameStatsLog } from './jxl-progressive-frame-stats.js';

const { process_orf, rgb_to_rgba } = rawWasm;

let selectedSources = [];
let selectedSource = null;
let wasmReady = false;

// Last successful progressive run artifacts (for export)
let lastJxlBytes = null;
let lastJxlFileName = null;
let lastPassCount = 0;
let lastSettings = null; // {quality, passes, detail, size, previewFirst, ...}
// Collected JXLs + metadata from the *most recent* "Run Progressive Paint" (supports batch of N sources)
let lastExportedJxls = []; // [{name, bytes: Uint8Array, settings}]

// Structured measurement history (one entry per "Run Progressive Paint")
const MAX_MEASUREMENTS = 200;
let runMeasurements = [];

// rAF coalescing state — one-slot pending frame queue; newer replaces older
let pendingFrame = null;   // { pixels, info, t, passIdx, isFinal, _passes } — one-slot queue; newer replaces older
let rafPending = false;

// Wheel zoom rAF coalescing
let _wheelDeltaAccum = 0;
let _wheelRafPending = false;

// Source preview canvas cache — avoids recreating a full-res canvas on every paintSourcePreview call
let _sourcePreviewCache = null; // { source, srcCanvas }

// WASM ButteraugliComparator — pre-inited once per ref image; reused across probe calls
let _butterComparator = null;      // ButteraugliComparator | null
let _butterComparatorKey = null;   // Uint8Array identity of ref pixels used to build comparator

// No-op: this page has no workflow state UI (unlike wrapper-lab / crop-benchmark)
function updateWorkflowState() {}

// Console page header — always shows which page this console belongs to (dev productivity across many open lab/benchmark tabs)
console.log('%c[Progressive Paint] jxl-progressive-paint.js loaded — progressive paint / live decode UI', 'color:#ec4899;font-weight:600', { page: 'Progressive Paint', url: location.href, t: new Date().toISOString(), ua: navigator.userAgent.slice(0, 120) });

try {
    preloadJxlModule();
} catch (err) {
    console.warn('[Progressive Paint] JXL preload failed', err);
}

function logBrowserDecodeTier() {
    let tier = 'unknown';
    try {
        tier = detectTier();
    } catch (err) {
        console.warn('[Progressive Paint] detectTier failed', err);
    }
    console.log('[Progressive Paint] decode tier', { tier, crossOriginIsolated });
}
logBrowserDecodeTier();

// A4: gate O(W×H) frame analysis behind ?stats=1
const statsEnabled = new URLSearchParams(location.search).get('stats') === '1';
// A3: persistent thumb canvases (80×50) keyed by passIdx; cleared on timeline reset
let thumbCanvases = new Map();
// A3: persistent full-res source canvases keyed by slot index; reused across passes
const slotSrcCanvases = new Map();

// ─── WASM init ────────────────────────────────────────────────────────────────

initRaw().then(() => {
    wasmReady = true;
    dbgLog('WASM module initialized');
    updateWorkflowState?.();
}).catch(err => {
    dbgLog('Failed to init WASM: ' + err.message, '', 'error');
});

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const sourceInput = document.getElementById('source-input');
const sourceDrop = document.getElementById('source-drop');
const loadRandomBtn = document.getElementById('load-random');
const runProgressiveBtn = document.getElementById('run-progressive');
const dbgConsoleBtn = document.getElementById('dbg-console-btn');
const pickFileBtn = document.getElementById('pick-file-btn');
const currentSourceEl = document.getElementById('current-source');
const exportGalleryBtn = document.getElementById('export-gallery-btn');
const exportFolderBtn = document.getElementById('export-folder-btn');
const exportCsvBtn = document.getElementById('export-csv-btn');
const exportJsonBtn = document.getElementById('export-json-btn');
const exportToonBtn = document.getElementById('export-toon-btn');
const clearMeasurementsBtn = document.getElementById('clear-measurements-btn');
const copyMeasurementsMdBtn = document.getElementById('copy-measurements-md');
const randomCountInput = document.getElementById('random-count');

if (dbgConsoleBtn) initDebugConsole(dbgConsoleBtn);
if (pickFileBtn) pickFileBtn.addEventListener('click', () => sourceInput?.click());

const compareSlots = [
    {
        slotName: 'A',
        labelEl: document.getElementById('vp-overview-label'),
        canvas: document.getElementById('vp-overview'),
        infoEl: document.getElementById('vp-overview-info'),
    },
    {
        slotName: 'B',
        labelEl: document.getElementById('vp-pixel-label'),
        canvas: document.getElementById('vp-pixel'),
        infoEl: document.getElementById('vp-pixel-info'),
    },
    {
        slotName: 'C',
        labelEl: document.getElementById('vp-zoom-label'),
        canvas: document.getElementById('vp-zoom'),
        infoEl: document.getElementById('vp-zoom-info'),
    },
];

let compareSlotCursor = 0;

// ─── Synced zoom + identical reticule across Compare A/B/C ────────────────────
let zoomLevel = 1;
let panX = 0;   // source-pixel offset from center (positive = image moves left under reticule)
let panY = 0;
let zoomArmed = false;
let viewPreset = 'fit'; // 'fit' | '100' | '400' — drives the 3-way toggle button

function updateZoomReadout() {
    const el = document.getElementById('zoom-readout');
    if (el) el.textContent = `${zoomLevel.toFixed(2)}×`;
}

function resetZoom(silent = false) {
    zoomLevel = 1;
    panX = 0;
    panY = 0;
    zoomArmed = false;
    viewPreset = 'fit';
    updateZoomReadout();
    updatePresetButton();
    const btn = document.getElementById('zoom-btn');
    if (btn) btn.classList.remove('is-armed');
    if (!silent) renderAllZoomedViews();
}

function cycleViewPreset() {
    if (viewPreset === 'fit') {
        viewPreset = '100';
        zoomLevel = 1;
        panX = 0;
        panY = 0;
    } else if (viewPreset === '100') {
        viewPreset = '400';
        zoomLevel = 4;
        panX = 0;
        panY = 0;
    } else {
        viewPreset = 'fit';
        zoomLevel = 1;
        panX = 0;
        panY = 0;
    }
    updatePresetButton();
    renderAllZoomedViews();
}

function updatePresetButton() {
    const btn = document.getElementById('zoom-reset');
    if (!btn) return;
    if (viewPreset === 'fit') btn.textContent = 'Fit';
    else if (viewPreset === '100') btn.textContent = '100%';
    else btn.textContent = '400%';
    btn.title = `View preset: ${btn.textContent} (click to cycle Fit → 100% actual pixels → 400%)`;
}

function getZoomViewRect(srcW, srcH) {
    if (zoomLevel <= 1.0001) {
        return { sx: 0, sy: 0, sw: srcW, sh: srcH };
    }
    const viewW = srcW / zoomLevel;
    const viewH = srcH / zoomLevel;
    const cx = srcW / 2 + panX;
    const cy = srcH / 2 + panY;
    const sx = Math.max(0, Math.min(srcW - viewW, cx - viewW / 2));
    const sy = Math.max(0, Math.min(srcH - viewH, cy - viewH / 2));
    return { sx, sy, sw: viewW, sh: viewH };
}

function drawReticule(ctx, w, h) {
    const cx = w / 2, cy = h / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.25;
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 2;

    // Center cross (identical on all three viewers)
    const arm = Math.min(w, h) * 0.13;
    ctx.beginPath();
    ctx.moveTo(cx - arm, cy); ctx.lineTo(cx + arm, cy);
    ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy + arm);
    ctx.stroke();

    // Small centering box
    const box = 6;
    ctx.fillRect(cx - box / 2, cy - box / 2, box, box);
    ctx.strokeRect(cx - box / 2, cy - box / 2, box, box);

    ctx.restore();
}

function renderAllZoomedViews() {
    for (const slot of compareSlots) {
        if (slot.currentSrc && slot.canvas) {
            paintCanvasIntoSlot(slot.currentSrc, slot.canvas, true);
        }
    }
    updateZoomReadout();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function resizeRgba(rgba, width, height, targetWidth) {
    if (targetWidth === 'fullsize') return { rgba, width, height };
    const scale = targetWidth / width;
    const targetHeight = Math.round(height * scale);
    const resizeRgbaImpl = rawWasm.downscale_rgba ?? downscaleRgbaCanvas;
    return { rgba: resizeRgbaImpl(rgba, width, height, targetWidth, targetHeight), width: targetWidth, height: targetHeight };
}

function downscaleRgbaCanvas(rgba, width, height, targetWidth, targetHeight) {
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = width;
    srcCanvas.height = height;
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
    const srcClamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    srcCtx.putImageData(new ImageData(srcClamped, width, height), 0, 0);
    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = targetWidth;
    dstCanvas.height = targetHeight;
    const dstCtx = dstCanvas.getContext('2d', { willReadFrequently: true });
    dstCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);
    const dstData = dstCtx.getImageData(0, 0, targetWidth, targetHeight).data;
    return new Uint8Array(dstData.buffer, dstData.byteOffset, dstData.byteLength);
}

function exactBuffer(view) {
    if (view instanceof ArrayBuffer) return view;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function concatChunks(chunks) {
    const views = chunks.map(c => c instanceof Uint8Array ? c : new Uint8Array(c));
    if (views.length === 1) return views[0];
    const total = views.reduce((sum, c) => sum + c.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of views) { out.set(c, offset); offset += c.byteLength; }
    return out;
}

// ─── File loading ─────────────────────────────────────────────────────────────

async function processImageFile(file, arrayBuffer) {
    const name = file.name.toLowerCase();
    const type = file.type;
    try {
        if (name.match(/\.(orf|raw)$/i)) {
            if (!wasmReady) { dbgLog('WASM not ready'); return null; }
            // Use mild "nice preview" look params (unlike the strict neutral 0/NaN used in raw fidelity benches/tests).
            // This makes Gobabeb .orf etc look representative in paint viewers/timeline/gallery without affecting JXL encode fidelity testing.
            const result = process_orf(new Uint8Array(arrayBuffer), 0.3, 0.1, 0, 0, 0, 0, 0.15, 0.1, 0, 0, NaN, NaN, 0, 0);
            try {
                // Legacy WASM-side RGBA path removed per Boundary Cost Audit
                const rgba = rgb_to_rgba(result.take_rgb());
                return { rgba, width: result.width, height: result.height };
            } finally {
                result.free();
            }
        } else if (type.startsWith('image/') || name.match(/\.(jpg|jpeg|png|webp|jxl)$/i)) {
            const blob = new Blob([arrayBuffer], { type: type || 'application/octet-stream' });
            const bitmap = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            const d = imageData.data;
            return { rgba: new Uint8Array(d.buffer, d.byteOffset, d.byteLength), width: bitmap.width, height: bitmap.height };
        } else {
            dbgLog(`Unknown file type: ${name} (${type})`, '', 'warn');
        }
    } catch (err) {
        dbgLog(`Process error: ${err.message}`, '', 'error');
    }
    return null;
}

async function loadFiles(files) {
    const list = Array.isArray(files) ? files : (files ? [files] : []);
    if (!list.length) return;

    // New selection — clear previous run's viewers + timeline + export so results don't mix across files
    clearCompareSlots();
    clearPassTimeline();
    updateTimelineVisibility(0);
    const rsLine = document.getElementById('run-status-line');
    if (rsLine) rsLine.hidden = true;
    clearLastExport();
    hideSourcePreview();

    selectedSources = [];
    selectedSource = null;
    _sourcePreviewCache = null;
    if (_butterComparator) { _butterComparator.dispose(); _butterComparator = null; }
    _butterComparatorKey = null;
    setProgStatus(`Loading ${list.length} file${list.length > 1 ? 's' : ''}…`);

    for (const file of list) {
        try {
            const arrayBuffer = await file.arrayBuffer();
            const result = await processImageFile(file, arrayBuffer);
            if (result) {
                const entry = { file: file.name, ...result };
                selectedSources.push(entry);
                dbgLog(`✓ ${file.name}`, `${result.width}×${result.height}`);
                paintSourcePreview();
            } else {
                dbgLog(`✗ Failed to process: ${file.name}`);
            }
        } catch (err) {
            dbgLog(`✗ Error loading ${file.name}: ${err.message}`);
        }
    }

    if (selectedSources.length > 0) {
        selectedSource = selectedSources[selectedSources.length - 1];
        const more = selectedSources.length > 1 ? ` (+${selectedSources.length - 1} more)` : '';
        setProgStatus(`${selectedSource.file}${more} (${selectedSource.width}×${selectedSource.height}) — click Run progressive paint.`);
    } else {
        setProgStatus('No supported files loaded.');
    }
    updateUI();
}

// keep thin wrapper in case any external call (none expected)
async function loadFile(file) {
    return loadFiles(file ? [file] : []);
}

async function loadRandomImages() {
    if (!wasmReady) { setProgStatus('WASM not ready — wait a moment.'); return; }
    const count = Math.max(1, Math.min(50, parseInt(randomCountInput?.value, 10) || 5));

    loadRandomBtn.disabled = true;
    loadRandomBtn.textContent = 'Loading…';

    // New batch load — clear viewers + timeline + export so results don't mix
    clearCompareSlots();
    clearPassTimeline();
    updateTimelineVisibility(0);
    const rsLine = document.getElementById('run-status-line');
    if (rsLine) rsLine.hidden = true;
    clearLastExport();
    hideSourcePreview();

    selectedSources = [];
    selectedSource = null;
    _sourcePreviewCache = null;
    if (_butterComparator) { _butterComparator.dispose(); _butterComparator = null; }
    _butterComparatorKey = null;
    setProgStatus(`Loading ${count} random Gobabeb image${count > 1 ? 's' : ''}…`);

    let loaded = 0;
    try {
        for (let i = 0; i < count; i++) {
            const tentativeName = `random-${i + 1}.orf`;
            try {
                const resp = await fetch('/api/random-gobabeb');
                if (!resp.ok) throw new Error(`API error ${resp.status}`);
                const arrayBuffer = await resp.arrayBuffer();
                const fileName = resp.headers.get('X-File-Name') || tentativeName;
                const file = { name: fileName, type: 'application/octet-stream' };
                const result = await processImageFile(file, arrayBuffer);
                if (result) {
                    const entry = { file: fileName, ...result };
                    selectedSources.push(entry);
                    loaded++;
                    if (currentSourceEl) currentSourceEl.textContent = `${loaded}/${count} loaded`;
                    dbgLog(`✓ ${fileName}`, `${result.width}×${result.height}`);
                    paintSourcePreview();
                } else {
                    dbgLog(`✗ Failed to process random image: ${fileName}`);
                }
            } catch (err) {
                dbgLog(`✗ Random load ${i + 1}: ${err.message}`, '', 'error');
            }
        }
    } finally {
        loadRandomBtn.disabled = false;
        loadRandomBtn.textContent = 'Random Gobabeb';
    }

    if (selectedSources.length > 0) {
        selectedSource = selectedSources[selectedSources.length - 1];
        setProgStatus(`${selectedSources.length} random Gobabeb file(s) loaded (last: ${selectedSource.file}) — click Run progressive paint.`);
    } else {
        setProgStatus('No random images loaded.');
    }
    updateUI();
}

function updateUI() {
    const ready = !!(selectedSource || selectedSources.length);
    runProgressiveBtn.disabled = !ready;
    updateWorkflowState?.();
    runProgressiveBtn.title = ready ? '' : 'Load file(s) first';

    if (currentSourceEl) {
        if (selectedSources.length > 1) {
            currentSourceEl.textContent = `${selectedSources.length} files (last: ${selectedSource ? selectedSource.file : ''})`;
        } else {
            currentSourceEl.textContent = selectedSource ? selectedSource.file : '';
        }
    }
    // Exports only make sense after a successful run that produced a JXL (supports last batch)
    const hasExport = !!lastJxlBytes || lastExportedJxls.length > 0;
    if (exportGalleryBtn) exportGalleryBtn.disabled = !hasExport;
    if (exportFolderBtn) exportFolderBtn.disabled = !hasExport;

    // Measurement exports (CSV/JSON) are enabled once we have any structured runs
    const hasMeasurements = runMeasurements.length > 0;
    if (exportCsvBtn) exportCsvBtn.disabled = !hasMeasurements;
    if (exportJsonBtn) exportJsonBtn.disabled = !hasMeasurements;
    if (exportToonBtn) exportToonBtn.disabled = !hasMeasurements;
    if (copyMeasurementsMdBtn) copyMeasurementsMdBtn.disabled = !hasMeasurements;
    if (clearMeasurementsBtn) clearMeasurementsBtn.disabled = !hasMeasurements;
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

// Unified picker with memory (dropZone omitted — we use explicit Pick button + the hidden input)
const filePicker = createFilePicker({
    input: sourceInput,
    dropZone: null,
    multiple: true,
    accept: '.orf,.ORF,.jpg,.jpeg,.png,.tif,.tiff,.jxl,image/*',
    persistKey: 'jxl-progressive-paint-last-file',
    onFiles: (files) => {
        loadFiles(files);
        updateWorkflowState();
    }
});

filePicker?.loadLastPersisted?.().then(f => { if (f?.length) loadFiles(f); });

if (loadRandomBtn) {
    loadRandomBtn.addEventListener('click', () => loadRandomImages());
}

if (runProgressiveBtn) {
    runProgressiveBtn.addEventListener('click', () => runProgressivePaintTest());
}

// ─── Synced zoom controls wiring ──────────────────────────────────────────────
const zoomBtn = document.getElementById('zoom-btn');
const zoomResetBtn = document.getElementById('zoom-reset');
const viewportTrio = document.getElementById('viewport-trio');

if (zoomBtn) {
    zoomBtn.addEventListener('click', () => {
        zoomArmed = !zoomArmed;
        zoomBtn.classList.toggle('is-armed', zoomArmed);
        if (zoomArmed && zoomLevel <= 1.0001) {
            // Give the user something immediate to scroll
            zoomLevel = 2.0;
            updateZoomReadout();
            renderAllZoomedViews();
        }
    });
}
if (zoomResetBtn) {
    zoomResetBtn.addEventListener('click', () => cycleViewPreset());
    // Initialize label
    updatePresetButton();
}

// Wheel zoom + drag pan. Only interferes with page scroll when armed or already zoomed in.
if (viewportTrio) {
    // Coalesce wheel events into one rAF render — wheel fires 60-120×/s without this.
    viewportTrio.addEventListener('wheel', (e) => {
        if (!zoomArmed && zoomLevel <= 1.0001) return;
        e.preventDefault();
        _wheelDeltaAccum += e.deltaY;
        if (_wheelRafPending) return;
        _wheelRafPending = true;
        requestAnimationFrame(() => {
            _wheelRafPending = false;
            const delta = _wheelDeltaAccum;
            _wheelDeltaAccum = 0;
            const factor = delta < 0 ? 1.13 : (1 / 1.13);
            zoomLevel = Math.max(0.4, Math.min(10, zoomLevel * factor));
            updateZoomReadout();
            renderAllZoomedViews();
        });
    }, { passive: false });

    // Drag to pan (only meaningful when zoomed)
    let dragStart = null;
    viewportTrio.addEventListener('mousedown', (e) => {
        if (zoomLevel <= 1.0001) return;
        // Cache pan scale at drag start — constant for entire gesture, avoid per-mousemove division.
        dragStart = { x: e.clientX, y: e.clientY, panX, panY, scale: 1.8 / zoomLevel };
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragStart) return;
        panX = dragStart.panX - (e.clientX - dragStart.x) * dragStart.scale;
        panY = dragStart.panY - (e.clientY - dragStart.y) * dragStart.scale;
        renderAllZoomedViews();
    });
    window.addEventListener('mouseup', () => { dragStart = null; });

    // Double-click the viewer area resets zoom (convenient)
    viewportTrio.addEventListener('dblclick', () => {
        if (zoomLevel > 1) resetZoom();
    });
}

// ─── Progressive paint ────────────────────────────────────────────────────────

function getProgSize() {
    const radio = document.querySelector('input[name="prog-size"]:checked');
    if (!radio) return 1080;
    return radio.value === 'fullsize' ? 'fullsize' : Number(radio.value);
}

function getProgQuality() {
    const radio = document.querySelector('input[name="prog-quality"]:checked');
    return radio ? Number(radio.value) : 85;
}

function getRequestedPassCount() {
    const radio = document.querySelector('input[name="prog-passes"]:checked');
    const count = radio ? Number(radio.value) : 2;
    return Number.isFinite(count) ? Math.max(2, Math.min(8, count)) : 2;
}

function getRequestedProgressiveDetail(stepCount) {
    if (stepCount >= 6) return 'passes';
    if (stepCount >= 4) return 'lastPasses';
    return 'dc';
}

function getRequestedProgressiveFlavor(stepCount, previewFirst) {
    return stepCount > 2 || previewFirst ? 'ac' : 'dc';
}

// Sync the group-order checkbox default per handoff: checked for requested >=4 or when previewFirst.
// Allows user override (uncheck for scanline A/B). We set on init and on passes/preview changes
// only if the user has not yet manually toggled it in this session (tracked via data-user-toggled).
function syncGroupOrderDefault(forceRespectUser = false) {
    const cb = document.getElementById('prog-group-order');
    if (!cb) return;
    const passes = getRequestedPassCount();
    const preview = !!(document.getElementById('prog-preview-first')?.checked);
    const recommended = passes >= 4 || preview;
    if (cb.dataset.userToggled === '1' && !forceRespectUser) {
        return; // leave user's explicit choice
    }
    cb.checked = recommended;
}

function setProgStatus(text) {
    const el = document.getElementById('prog-status');
    if (el) el.textContent = text;

    // Also mirror into the results-area live status (so "current status and progress"
    // lives to the right of the Done summary line as requested).
    const live = document.getElementById('run-live-status');
    if (live) live.textContent = text;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function nextPaint() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function readPresetName() {
    return document.getElementById('preset-name')?.value ?? 'sneyers';
}

function readThrottleKbPerSec() {
    const raw = document.getElementById('throttle-rate')?.value;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function shouldRunOneShotComparison() {
    return document.getElementById('run-one-shot-comparison')?.checked === true;
}

function shouldRunByteCutoffProbe() {
    return document.getElementById('run-byte-cutoff-probe')?.checked === true;
}

async function feedThrottled(decoder, bytes, kbPerSec) {
    const chunkBytes = 16 * 1024;
    const msPerChunk = kbPerSec > 0 ? (chunkBytes / 1024) * (1000 / kbPerSec) : 0;
    let offset = 0;
    while (offset < bytes.byteLength) {
        const end = Math.min(offset + chunkBytes, bytes.byteLength);
        await decoder.push(exactBuffer(bytes.subarray(offset, end)));
        offset = end;
        if (msPerChunk > 0) await sleep(msPerChunk);
    }
    await decoder.close();
}

function clearCompareSlots() {
    compareSlotCursor = 0;
    for (const slot of compareSlots) {
        if (!slot.canvas) continue;
        const ctx = slot.canvas.getContext('2d');
        ctx.clearRect(0, 0, slot.canvas.width, slot.canvas.height);
        ctx.fillStyle = 'rgba(0,0,0,0.04)';
        ctx.fillRect(0, 0, slot.canvas.width, slot.canvas.height);
        if (slot.labelEl) slot.labelEl.textContent = `Pass ${compareSlots.indexOf(slot) + 1}`;
        if (slot.infoEl) slot.infoEl.textContent = 'Waiting for pass.';
        slot.currentPass = null;
        slot.currentSrc = null;
    }
    slotSrcCanvases.clear();
}

function clearPassTimeline() {
    const el = document.getElementById('pass-timeline');
    if (el) el.innerHTML = '';
    thumbCanvases.clear();
}

function clearByteCutoffLadder() {
    const el = document.getElementById('byte-cutoff-ladder');
    if (el) el.innerHTML = '';
    const status = document.getElementById('byte-cutoff-status');
    if (status) status.textContent = 'Run Progressive Paint to decode fixed byte prefixes.';
}

function updateTimelineVisibility(passCount) {
    const timeline = document.getElementById('pass-timeline');
    if (!timeline) return;
    timeline.style.display = (passCount > 1) ? '' : 'none';
}

function clearLastExport() {
    lastJxlBytes = null;
    lastJxlFileName = null;
    lastPassCount = 0;
    lastSettings = null;
    lastExportedJxls = [];
}

function hideSourcePreview() {
    const wrap = document.getElementById('source-preview-wrap');
    if (wrap) wrap.style.display = 'none';
}

function paintSourcePreview() {
    const wrap = document.getElementById('source-preview-wrap');
    const c = document.getElementById('source-preview');
    if (!c || !selectedSource || !wrap) { hideSourcePreview(); return; }
    wrap.style.display = 'inline-block';
    // Cache source canvas — avoids allocating a full-res canvas + putImageData on every preview repaint.
    if (!_sourcePreviewCache || _sourcePreviewCache.source !== selectedSource) {
        const srcC = document.createElement('canvas');
        srcC.width = selectedSource.width;
        srcC.height = selectedSource.height;
        const srcView = selectedSource.rgba;
        const clamped = new Uint8ClampedArray(srcView.buffer, srcView.byteOffset, srcView.byteLength);
        srcC.getContext('2d', { willReadFrequently: false }).putImageData(
            new ImageData(clamped, selectedSource.width, selectedSource.height), 0, 0);
        _sourcePreviewCache = { source: selectedSource, srcCanvas: srcC };
    }
    const srcC = _sourcePreviewCache.srcCanvas;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    const scale = Math.min(c.width / selectedSource.width, c.height / selectedSource.height);
    const dw = Math.max(1, Math.round(selectedSource.width * scale));
    const dh = Math.max(1, Math.round(selectedSource.height * scale));
    ctx.drawImage(srcC, Math.round((c.width - dw) / 2), Math.round((c.height - dh) / 2), dw, dh);
}

async function runByteCutoffProbe(jxlBytes, progressiveDetail) {
    const ladder = document.getElementById('byte-cutoff-ladder');
    const status = document.getElementById('byte-cutoff-status');
    if (!ladder) return;

    const plan = buildByteCutoffPlan(jxlBytes.byteLength);
    ladder.innerHTML = '';
    if (status) status.textContent = `${plan.length} byte cutoffs queued`;

    const classifiedResults = [];
    const cutoffPixels = [];   // Uint8Array per entry with decoded frame
    const cutoffBytes = [];    // byte size parallel to cutoffPixels
    let probeWidth = 0, probeHeight = 0;
    for (const entry of plan) {
        if (status) status.textContent = `Decoding ${formatByteCutoffLabel(entry)}...`;
        const result = await decodeByteCutoff(jxlBytes, entry, progressiveDetail);
        renderByteCutoffTile(ladder, result);
        const events = result.frame ? [result.frame] : [];
        classifiedResults.push(classifyByteCutoffFrame({ bytes: entry.bytes, events, error: result.error ?? null }));
        if (result.frame?.pixels) {
            const px = result.frame.pixels instanceof Uint8Array ? result.frame.pixels : new Uint8Array(result.frame.pixels);
            cutoffPixels.push(px);
            cutoffBytes.push(entry.bytes);
            if (!probeWidth && result.frame.info) { probeWidth = result.frame.info.width; probeHeight = result.frame.info.height; }
        }
        await nextPaint();
    }

    // Build quality/butter/ssim series. Ref = final cutoff (highest byte count).
    let summary;
    const refPixels = cutoffPixels.length > 0 ? cutoffPixels[cutoffPixels.length - 1] : null;
    if (refPixels && probeWidth > 0 && probeHeight > 0 && cutoffPixels.length >= 2) {
        const testPixels = cutoffPixels.slice(0, -1);
        const testBytes = cutoffBytes.slice(0, -1);
        // Lazy-init WASM ButteraugliComparator for this ref image (identity-keyed).
        if (_butterComparatorKey !== refPixels) {
            if (_butterComparator) { _butterComparator.dispose(); _butterComparator = null; }
            _butterComparatorKey = refPixels;
            const w = probeWidth, h = probeHeight, key = refPixels;
            ButteraugliComparator.create(refPixels, w, h)
                .then(cmp => { if (_butterComparatorKey === key) _butterComparator = cmp; })
                .catch(() => {/* WASM butter unavailable — JS fallback active */});
        }
        const { qualitySeries, butterSeries, ssimSeries, timing } = await buildSeriesAsync(
            refPixels, testPixels, testBytes, probeWidth, probeHeight,
            { comparator: _butterComparator ?? undefined }
        );
        summary = summarizeByteCutoffResults(classifiedResults, jxlBytes.byteLength, { qualitySeries, butterSeries, ssimSeries });
        if (timing.totalMs > 5) console.log(`[ByteCutoff] buildSeries: psnr=${timing.psnrMs.toFixed(1)}ms butter=${timing.butterMs.toFixed(1)}ms ssim=${timing.ssimMs.toFixed(1)}ms total=${timing.totalMs.toFixed(1)}ms`);
        cutoffPixels.length = 0; // allow GC of pixel buffers
    } else {
        summary = summarizeByteCutoffResults(classifiedResults, jxlBytes.byteLength);
    }

    if (status) {
        const parts = [`${summary.paintedCutoffs}/${plan.length} painted`];
        if (summary.firstPaintBytes != null) parts.push(`first paint ${(summary.firstPaintBytes/1024).toFixed(1)} KB (${summary.firstPaintPercent}%)`);
        if (summary.previewBytes != null) parts.push(`preview ${(summary.previewBytes/1024).toFixed(1)} KB (${summary.previewPercent}%)`);
        if (summary.firstRecognizableBytes != null) parts.push(`recognizable ${(summary.firstRecognizableBytes/1024).toFixed(1)} KB (${summary.firstRecognizablePercent}%)`);
        if (summary.finalPsnr != null) parts.push(`PSNR ${summary.finalPsnr.toFixed(1)} dB`);
        status.textContent = parts.join(' · ');
    }
}

async function decodeByteCutoff(jxlBytes, entry, progressiveDetail) {
    const decoder = createDecoder({
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: true,
        progressiveDetail,
        preserveIcc: false,
        preserveMetadata: false,
    });

    const t0 = performance.now();
    let lastFrame = null;
    let error = null;
    try {
        const eventsTask = (async () => {
            for await (const ev of decoder.events()) {
                if (ev.type === 'progress' || ev.type === 'final') {
                    lastFrame = ev;
                } else if (ev.type === 'error') {
                    throw new Error(`${ev.code}: ${ev.message}`);
                }
            }
        })();
        await decoder.push(exactBuffer(jxlBytes.subarray(0, entry.bytes)));
        await decoder.close();
        await eventsTask;
    } catch (e) {
        error = e instanceof Error ? e.message : String(e);
    } finally {
        await decoder.dispose();
    }

    return {
        entry,
        frame: lastFrame,
        elapsedMs: performance.now() - t0,
        error,
    };
}

function renderByteCutoffTile(ladder, result) {
    const tile = document.createElement('div');
    tile.className = 'byte-cutoff-tile' + (result.entry.kind === 'final' ? ' is-final' : '');

    if (result.frame) {
        const rArr = result.frame.pixels instanceof Uint8Array ? result.frame.pixels : new Uint8Array(result.frame.pixels);
        const rW = result.frame.info.width, rH = result.frame.info.height;
        const rImgData = new ImageData(new Uint8ClampedArray(rArr.buffer, rArr.byteOffset, rArr.byteLength), rW, rH);
        const canvas = document.createElement('canvas');
        canvas.width = rW;
        canvas.height = rH;
        canvas.getContext('2d').putImageData(rImgData, 0, 0);
        const meta = document.createElement('div');
        meta.className = 'byte-cutoff-meta';
        meta.textContent = `${formatByteCutoffLabel(result.entry)} | ${result.frame.type} | ${result.elapsedMs.toFixed(1)} ms`;
        tile.append(canvas, meta);
    } else {
        tile.classList.add('is-empty');
        const label = document.createElement('div');
        label.className = 'byte-cutoff-meta';
        label.textContent = `${formatByteCutoffLabel(result.entry)} | no paint${result.error ? ` | ${result.error}` : ''}`;
        tile.append(label);
    }

    ladder.appendChild(tile);
}

function paintCanvasIntoSlot(srcCanvas, slotCanvas, forceZoom = false) {
    if (!slotCanvas || !srcCanvas) return;
    const ctx = slotCanvas.getContext('2d');
    ctx.clearRect(0, 0, slotCanvas.width, slotCanvas.height);

    const sw = srcCanvas.width, sh = srcCanvas.height;
    const cw = slotCanvas.width, ch = slotCanvas.height;
    const useZoom = (viewPreset !== 'fit') || forceZoom || zoomLevel > 1.0001;

    if (!useZoom) {
        // Original letterbox-fit behavior (no reticule)
        const scale = Math.min(cw / sw, ch / sh);
        const dw = Math.max(1, Math.round(sw * scale));
        const dh = Math.max(1, Math.round(sh * scale));
        ctx.drawImage(srcCanvas, Math.round((cw - dw) / 2), Math.round((ch - dh) / 2), dw, dh);
        return;
    }

    // Zoomed / pixel mode: sample a sub-rect of the source and draw it magnified to fill the slot
    const view = getZoomViewRect(sw, sh);
    const isPixelMode = (viewPreset === '100' || viewPreset === '400');
    ctx.imageSmoothingEnabled = !isPixelMode;
    ctx.drawImage(
        srcCanvas,
        view.sx, view.sy, view.sw, view.sh,
        0, 0, cw, ch
    );
    ctx.imageSmoothingEnabled = true; // restore
    drawReticule(ctx, cw, ch);
}

function formatPassLabel(passRecord) {
    const stage = passRecord.isFinal ? 'final' : 'partial';
    return `Pass ${passRecord.passIdx + 1} · ${passRecord.t.toFixed(1)} ms · ${stage}`;
}

function assignPassToCompareSlot(passRecord, slotIndex = compareSlotCursor) {
    const slot = compareSlots[slotIndex];
    if (!slot || !slot.canvas) return;
    paintCanvasIntoSlot(passRecord.srcCanvas, slot.canvas);
    if (slot.labelEl) {
        const n = passRecord.passIdx + 1;
        const stage = passRecord.isFinal ? ' (final)' : '';
        slot.labelEl.textContent = `Pass ${n}${stage}`;
    }
    if (slot.infoEl) slot.infoEl.textContent = formatPassLabel(passRecord);
    if (passRecord.button) passRecord.button.dataset.slot = slot.slotName;
    slot.currentPass = passRecord;
    slot.currentSrc = passRecord.srcCanvas;
}

function advanceCompareSlotCursor(slotIndex = compareSlotCursor) {
    compareSlotCursor = (slotIndex + 1) % compareSlots.length;
}

function autoAssignPass(passRecord) {
    const slotIndex = Math.min(passRecord.passIdx, compareSlots.length - 1);
    assignPassToCompareSlot(passRecord, slotIndex);
    advanceCompareSlotCursor(slotIndex);
}

function addPassToTimeline(passRecord) {
    const timeline = document.getElementById('pass-timeline');
    if (!timeline) return;
    const TW = 80, TH = 50;
    let thumb = thumbCanvases.get(passRecord.passIdx);
    if (!thumb) {
        thumb = document.createElement('canvas');
        thumb.width = TW;
        thumb.height = TH;
        thumbCanvases.set(passRecord.passIdx, thumb);
    }
    const ctx = thumb.getContext('2d');
    ctx.clearRect(0, 0, TW, TH);
    if (passRecord.srcCanvas) {
        const scale = Math.min(TW / passRecord.srcCanvas.width, TH / passRecord.srcCanvas.height);
        const dw = Math.round(passRecord.srcCanvas.width * scale), dh = Math.round(passRecord.srcCanvas.height * scale);
        ctx.drawImage(passRecord.srcCanvas, Math.round((TW - dw) / 2), Math.round((TH - dh) / 2), dw, dh);
    }
    const wrap = document.createElement('button');
    wrap.type = 'button';
    wrap.className = 'pass-thumb' + (passRecord.isFinal ? ' is-final' : '');
    wrap.title = `${formatPassLabel(passRecord)} · click to pin into compare slots`;
    const label = document.createElement('div');
    label.className = 'pass-thumb-label';
    label.textContent = passRecord.isFinal ? `${passRecord.t.toFixed(0)}ms ✓` : `${passRecord.t.toFixed(0)}ms`;
    wrap.appendChild(thumb);
    wrap.appendChild(label);
    wrap.addEventListener('click', () => {
        // Choose a target slot that doesn't already show this exact pass.
        // Start at the current cursor and scan forward to avoid obvious duplicates.
        let target = compareSlotCursor;
        for (let i = 0; i < compareSlots.length; i++) {
            const s = compareSlots[target];
            if (!s || !s.currentPass || s.currentPass !== passRecord) {
                break;
            }
            target = (target + 1) % compareSlots.length;
        }
        assignPassToCompareSlot(passRecord, target);
        advanceCompareSlotCursor(target);
    });
    passRecord.button = wrap;
    timeline.appendChild(wrap);
}

// paintPass — extracts canvas + timeline work for a single frame.
// Intermediate frames coalesced by rAF will be dropped (never reach here).
// Dropped frames do not appear in passes[] and skip all canvas/analysis work.
function paintPass(ev) {
    const passPixels = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
    const frameStats = statsEnabled
        ? analyzeProgressiveFrame(passPixels, ev.info.width, ev.info.height)
        : null;
    const { width, height } = ev.info;
    const want = width * height * 4;
    if (passPixels.length !== want) {
        dbgLog(`[fidelity] pass pixels len ${passPixels.length} != 4*${width}*${height} (ImageData will fail or corrupt)`, '', 'error');
    }
    const imgData = new ImageData(new Uint8ClampedArray(passPixels.buffer, passPixels.byteOffset, passPixels.byteLength), width, height);
    const slotIndex = Math.min(ev.passIdx, compareSlots.length - 1);
    let srcCanvas = slotSrcCanvases.get(slotIndex);
    if (!srcCanvas || srcCanvas.width !== width || srcCanvas.height !== height) {
        srcCanvas = document.createElement('canvas');
        srcCanvas.width = width;
        srcCanvas.height = height;
        slotSrcCanvases.set(slotIndex, srcCanvas);
    }
    srcCanvas.getContext('2d').putImageData(imgData, 0, 0);
    const passRecord = {
        passIdx: ev.passIdx,
        t: ev.t,
        isFinal: ev.isFinal,
        stats: frameStats,
        srcCanvas,
        pixels: passPixels,
    };
    addPassToTimeline(passRecord);
    ev._passes.push(passRecord);
    autoAssignPass(passRecord);
    if (statsEnabled) {
        const statsLine = formatFrameStatsLog(frameStats);
        dbgLog(`  pass ${ev.passIdx + 1}${ev.isFinal ? ' (final)' : ''}`, `${ev.t.toFixed(1)} ms | ${statsLine}`, 'info');
        console.log('[Progressive Paint] frame stats', {
            pass: ev.passIdx + 1,
            isFinal: ev.isFinal,
            t_ms: Number(ev.t.toFixed(2)),
            ...frameStats,
        });
    } else {
        const stage = ev.isFinal ? 'final' : 'partial';
        dbgLog(`  pass ${ev.passIdx + 1} · ${stage}`, `${ev.t.toFixed(1)} ms`, 'info');
    }
}

// schedulePaint — rAF coalescing. Final events bypass coalescing and paint immediately.
// Intermediate frames arriving faster than display refresh are dropped; only the most-recent
// pending frame survives to paint per display tick. Coalescing reduces redundant canvas work and GC pressure.
function schedulePaint(frame) {
    if (frame.isFinal) {
        if (rafPending && pendingFrame) {
            paintPass(pendingFrame);
            pendingFrame = null;
        }
        rafPending = false;
        paintPass(frame);
        return;
    }
    pendingFrame = frame;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
        rafPending = false;
        const pending = pendingFrame;
        pendingFrame = null;
        if (!pending) return;
        paintPass(pending);
    });
}

async function collectProgressivePaintEvents(decoder, decStart, passes, passIndexState) {
    dbgLog('Event loop started', 'Awaiting decoder.events()…', 'info');
    try {
        for await (const ev of decoder.events()) {
            dbgLog(`Event: ${ev.type}`, ev.type, 'info');
            if (ev.type === 'header') {
                setProgStatus(`Decoder ready for ${ev.info.width}×${ev.info.height} progressive paints…`);
            } else if (ev.type === 'progress' || ev.type === 'final') {
                const t = performance.now() - decStart;
                const isFinal = ev.type === 'final';
                const passIdx = passIndexState.value;
                passIndexState.value++;
                schedulePaint({ pixels: ev.pixels, info: ev.info, t, passIdx, isFinal, _passes: passes });
            } else if (ev.type === 'error') {
                dbgLog('Decoder error event', `code=${ev.code}, msg=${ev.message}`, 'error');
                throw new Error(`Decoder error (${ev.code}): ${ev.message}`);
            }
        }
    } catch (evErr) {
        dbgLog('Event loop error', evErr instanceof Error ? evErr.message : String(evErr), 'error');
        throw evErr;
    }
}

function splitEncodedBytesIntoSteps(bytes, stepCount) {
    if (stepCount <= 1 || bytes.byteLength <= 1) return [bytes];
    const steps = [];
    let offset = 0;
    for (let i = 0; i < stepCount; i++) {
        const remaining = bytes.byteLength - offset;
        const remainingSteps = stepCount - i;
        const size = i === stepCount - 1 ? remaining : Math.max(1, Math.ceil(remaining / remainingSteps));
        const end = Math.min(bytes.byteLength, offset + size);
        steps.push(bytes.subarray(offset, end));
        offset = end;
    }
    return steps.filter(step => step.byteLength > 0);
}

async function streamIntoDecoder(decoder, jxlBytes, stepCount) {
    const steps = splitEncodedBytesIntoSteps(jxlBytes, stepCount);
    dbgLog('  local stream', `${(jxlBytes.byteLength / 1024).toFixed(1)} KB in ${steps.length} step(s) (requested=${stepCount})`, 'info');
    for (const step of steps) {
        await decoder.push(exactBuffer(step));
    }
    await decoder.close();
    return steps.length;
}

function renderProgressiveComparison({ requestedPassCount, passCount, progressiveFirstMs, progressiveFinalMs, oneShotFinalMs, fileSizeKB, encodeMs, previewFirst, progressiveDetail, progressiveDc, groupOrder }) {
    const body = document.getElementById('prog-comparison-body');
    if (!body) return;
    const speedup = (oneShotFinalMs && progressiveFirstMs)
        ? `${(oneShotFinalMs / progressiveFirstMs).toFixed(1)}×`
        : '—';
    const actualPaintWarning = passCount < requestedPassCount
        ? ` - actual paints ${passCount}/${requestedPassCount}; requested steps are byte-feed steps, not guaranteed JXL display layers`
        : '';
    body.innerHTML = `
        <tr>
            <td><strong>Progressive stream (${requestedPassCount} steps)</strong></td>
            <td>${passCount}</td>
            <td><strong>${progressiveFirstMs != null ? progressiveFirstMs.toFixed(1) + ' ms' : '—'}</strong></td>
            <td>${progressiveFinalMs != null ? progressiveFinalMs.toFixed(1) + ' ms' : '—'}</td>
            <td>${speedup} faster 1st frame</td>
        </tr>
        <tr>
            <td>One-shot (final only)</td>
            <td>1</td>
            <td>—</td>
            <td>${oneShotFinalMs != null ? oneShotFinalMs.toFixed(1) + ' ms' : '—'}</td>
            <td>baseline</td>
        </tr>
        <tr>
            <td colspan="5" style="font-size:11px;color:var(--muted);padding:6px 12px;">
                Encoded ${fileSizeKB.toFixed(1)} KB in ${encodeMs.toFixed(1)} ms · progressive=true previewFirst=${previewFirst} dc=${progressiveDc ?? '?'} group=${groupOrder ?? '?'} · detail=${progressiveDetail}${actualPaintWarning}${ (groupOrder===1 && progressiveDc>=1 ? ' [predator center-out]' : '') }
            </td>
        </tr>
    `;
}

async function runProgressivePaintTest() {
    let sourcesToRun = selectedSources.length ? [...selectedSources] : (selectedSource ? [selectedSource] : []);
    if (sourcesToRun.length === 0) { setProgStatus('Load a file first.'); return; }
    if (!wasmReady) { setProgStatus('WASM not ready.'); return; }

    runProgressiveBtn.disabled = true;
    runProgressiveBtn.textContent = 'Running…';
    resetZoom(true); // silent reset so every run starts at 1×
    clearCompareSlots();
    clearPassTimeline();
    clearByteCutoffLadder();

    // Reset bottom results status line for the new run (once for the batch)
    const lineEl = document.getElementById('run-status-line');
    if (lineEl) lineEl.hidden = true;
    const doneEl = document.getElementById('run-done-summary');
    if (doneEl) doneEl.textContent = '';
    const liveEl = document.getElementById('run-live-status');
    if (liveEl) liveEl.textContent = '';

    lastExportedJxls = [];
    const num = sourcesToRun.length;

    // Reset the results comparison table for a fresh run (batch or single); last source will render final content
    const compBody = document.getElementById('prog-comparison-body');
    if (compBody) compBody.innerHTML = `<tr><td colspan="5" class="empty-state">Running${num > 1 ? ' batch…' : '…'}</td></tr>`;

    try {
        const presetName = readPresetName();
        const throttleKbPerSec = readThrottleKbPerSec();
        const size = getProgSize();
        const quality = getProgQuality();
        const requestedPassCount = getRequestedPassCount();
        console.log('%c[Progressive Paint] run start', 'color:#ec4899;font-weight:600', { t: new Date().toISOString(), sources: sourcesToRun.map(s => s.file), size, quality, passCount: requestedPassCount, preset: presetName, throttleKbPerSec, batch: num });
        const detailChoice = document.querySelector('input[name="prog-detail"]:checked')?.value ?? 'auto';
        let progressiveDetail = detailChoice === 'auto'
            ? getRequestedProgressiveDetail(requestedPassCount)
            : detailChoice;
        const previewFirst = presetName === 'sneyers' ? true : !!(document.getElementById('prog-preview-first')?.checked);
        const progressiveFlavor = presetName === 'sneyers' ? 'ac'
            : (detailChoice !== 'auto' && detailChoice !== 'dc')
            ? 'ac'
            : getRequestedProgressiveFlavor(requestedPassCount, previewFirst);
        // Predator progressive: for higher requested passes, request more DC layers + center-out group order
        // so the encoded JXL actually contains structure for >2 distinct early passes that look different.
        const progressiveDc = presetName === 'sneyers' ? 2 : (requestedPassCount >= 6 ? 2 : (requestedPassCount >= 4 ? 1 : 1));
        const groupOrder = presetName === 'sneyers' ? 1 : (!!(document.getElementById('prog-group-order')?.checked) ? 1 : 0);

        for (let i = 0; i < num; i++) {
            const src = sourcesToRun[i];
            selectedSource = src;
            const isLast = (i === num - 1);

            if (num > 1) {
                setProgStatus(`Resizing ${i + 1}/${num}: ${src.file}…`);
            } else {
                setProgStatus(`Resizing to ${size === 'fullsize' ? 'full' : size + 'px'}…`);
            }
            const resized = resizeRgba(selectedSource.rgba, selectedSource.width, selectedSource.height, size);
            const expectedLen = resized.width * resized.height * 4;
            if (resized.rgba.length !== expectedLen) {
                dbgLog(`[fidelity] rgba length ${resized.rgba.length} !== 4*${resized.width}*${resized.height} (would cause garbage/encoder mismatch)`, '', 'error');
            }

            const statusPrefix = num > 1 ? `[${i + 1}/${num}] ` : '';
            if (num > 1) {
                // For batch runs, give each source a clean slate for its (temporary) pass visuals;
                // only the final source's viewers + timeline are left on screen at the end.
                clearCompareSlots();
                clearPassTimeline();
            }
            setProgStatus(`${statusPrefix}Encoding ${resized.width}×${resized.height} Q${quality} progressive with ${requestedPassCount} stream steps…`);
            const bufferingStrategyForLog = presetName === 'sneyers' ? 0 : 'auto';
            dbgLog('Encoder config', `progressive=true, progressiveFlavor=${progressiveFlavor}, previewFirst=${previewFirst}, progressiveDc=${progressiveDc}, groupOrder=${groupOrder}, quality=${quality}, effort=3, buffering=${bufferingStrategyForLog}`, 'info');

            let encoderOptions = {
                format: 'rgba8',
                width: resized.width,
                height: resized.height,
                hasAlpha: true,
                quality,
                effort: 3,
                progressive: true,
                progressiveFlavor,
                previewFirst,
                progressiveDc,
                progressiveAc: presetName === 'sneyers' ? 1 : undefined,
                qProgressiveAc: presetName === 'sneyers' ? 1 : undefined,
                decodingSpeed: presetName === 'sneyers' ? 0 : undefined,
                // buffering=0: non-streamed encode path. libjxl 0.11.2 encode.h states 2/3 are
                // streaming mode and "might not be progressively decodeable". Progressive paint
                // requires non-streaming buffering.
                buffering: presetName === 'sneyers' ? { strategy: 0 } : undefined,
                groupOrder,
                chunked: false,
            };
            if (presetName === 'sneyers') {
                // Use canonical SNEYERS_PRESET via createSneyersPreset to prevent flag drift
                // (e.g. buffering strategy, responsive via C side, ac/qac, decodingSpeed=0, groupOrder=1).
                // Pass targetLongEdge:'full' + explicit dims so the already-resized paint target is used as-is.
                const sney = createSneyersPreset({
                    width: resized.width,
                    height: resized.height,
                    targetLongEdge: 'full',
                    quality,
                    hasAlpha: true,
                });
                encoderOptions = {
                    ...sney.encode,
                    width: resized.width,
                    height: resized.height,
                    quality, // UI choice wins
                    progressiveFlavor, // passed for logging/consistency; sneyers resolve path uses previewFirst
                    chunked: false,
                };
            }
            const encoder = createEncoder(encoderOptions);
            const encChunks = [];
            const chunkTask = (async () => {
                for await (const chunk of encoder.chunks()) {
                    encChunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
                }
            })();
            const encStart = performance.now();
            await encoder.pushPixels(exactBuffer(resized.rgba));
            await encoder.finish();
            await chunkTask;
            const encodeMs = performance.now() - encStart;
            await encoder.dispose();
            const jxlBytes = concatChunks(encChunks);

            // Capture for export buttons (Progressive gallery / Folder) — collect full batch so "Send to Gallery"/Folder can export all from the run
            const exportName = `${(selectedSource?.file || 'source').replace(/\.[^.]+$/, '')}-prog-p${requestedPassCount}-q${quality}.jxl`;
            const exportEntry = {
                name: exportName,
                bytes: jxlBytes,
                settings: { size, quality, requestedPassCount, progressiveDetail, previewFirst, progressiveDc, groupOrder, presetName, throttleKbPerSec }
            };
            lastExportedJxls.push(exportEntry);
            lastJxlBytes = jxlBytes;
            lastJxlFileName = exportName;
            lastSettings = exportEntry.settings;

            setProgStatus(`${statusPrefix}Encoded ${(jxlBytes.length / 1024).toFixed(1)} KB in ${encodeMs.toFixed(1)} ms · streaming into decoder…`);
            dbgLog('Encoded', `${(jxlBytes.length / 1024).toFixed(1)} KB in ${encodeMs.toFixed(1)} ms`, 'info');

            dbgLog('Creating decoder…', `format=rgba8, progressionTarget=final, emitEveryPass=true, progressiveDetail=${progressiveDetail}`, 'info');
            const decoder = createDecoder({
                format: 'rgba8',
                region: null,
                downsample: 1,
                progressionTarget: 'final',
                emitEveryPass: true,
                progressiveDetail,
                preserveIcc: false,
                preserveMetadata: false,
            });
            dbgLog('Decoder created', 'Starting event iteration…', 'info');

            const decStart = performance.now();
            const passes = [];
            const passIndexState = { value: 0 };
            pendingFrame = null;
            rafPending = false;
            const eventTask = collectProgressivePaintEvents(decoder, decStart, passes, passIndexState);
            dbgLog('Streaming bytes…', `${jxlBytes.length} bytes total · throttle=${throttleKbPerSec > 0 ? throttleKbPerSec + ' KB/s' : 'off'} · steps=${requestedPassCount}`, 'info');
            let streamError = null;
            try {
                if (throttleKbPerSec > 0) {
                    await feedThrottled(decoder, jxlBytes, throttleKbPerSec);
                    dbgLog('Stream closed', `throttled feed done · waiting for event task…`, 'info');
                } else {
                    const streamStepCount = await streamIntoDecoder(decoder, jxlBytes, requestedPassCount);
                    dbgLog('Stream closed', `${streamStepCount} steps pushed · waiting for event task…`, 'info');
                }
                await eventTask;
            } catch (err) {
                streamError = err;
            }
            if (streamError) {
                const msg = streamError instanceof Error ? streamError.message : String(streamError);
                dbgLog('Streaming decode failed', `${msg} · falling back to full-buffer decode; rebuild jxl-wasm to enable true chunk streaming.`, 'error');
                await decoder.dispose();
                clearCompareSlots();
                clearPassTimeline();
                passes.length = 0;
                passIndexState.value = 0;
                pendingFrame = null;
                rafPending = false;

                const fallbackDecoder = createDecoder({
                    format: 'rgba8',
                    region: null,
                    downsample: 1,
                    progressionTarget: 'final',
                    emitEveryPass: true,
                    progressiveDetail,
                    preserveIcc: false,
                    preserveMetadata: false,
                });
                const fallbackStart = performance.now();
                const fallbackTask = collectProgressivePaintEvents(fallbackDecoder, fallbackStart, passes, passIndexState);
                await fallbackDecoder.push(exactBuffer(jxlBytes));
                await fallbackDecoder.close();
                await fallbackTask;
                await fallbackDecoder.dispose();
            } else {
                await decoder.dispose();
            }
            dbgLog('Event task complete', `${passes.length} passes received`, 'info');

            const progressiveFirstMs = passes.length ? passes[0].t : null;
            const progressiveFinalMs = passes.length ? passes[passes.length - 1].t : null;

            let finalPsnrVsSource = null;
            if (isLast && resized && passes.length) {
                const finalRec = passes.find(p => p.isFinal) || passes[passes.length - 1];
                if (finalRec && finalRec.pixels && resized.rgba && finalRec.pixels.length === resized.rgba.length) {
                    try {
                        finalPsnrVsSource = computePsnrVsFinal(resized.rgba, finalRec.pixels);
                    } catch (e) {
                        dbgLog('PSNR vs source failed', e?.message || e, 'warn');
                    }
                }
            }
            // Release pixel buffers — canvas holds the visual state; pixels no longer needed after PSNR.
            for (const p of passes) p.pixels = null;

            let oneShotFinalMs = null;
            if (isLast) {
                if (shouldRunOneShotComparison()) {
                    setProgStatus(`${statusPrefix}Running one-shot decode for comparison…`);
                    const decoder2 = createDecoder({
                        format: 'rgba8',
                        region: null,
                        downsample: 1,
                        progressionTarget: 'final',
                        emitEveryPass: false,
                        preserveIcc: false,
                        preserveMetadata: false,
                    });
                    const oneShotStart = performance.now();
                    await decoder2.push(jxlBytes);
                    await decoder2.close();
                    for await (const ev of decoder2.events()) {
                        if (ev.type === 'final') oneShotFinalMs = performance.now() - oneShotStart;
                        else if (ev.type === 'error') throw new Error(ev.message);
                    }
                    decoder2.dispose();
                }
            }

            // Capture structured measurement for CSV/JSON export (now that oneShotFinalMs is known)
            const measurement = {
                ts: new Date().toISOString(),
                source: selectedSource?.file || 'unknown',
                settings: lastSettings ? { ...lastSettings } : null,
                streamStepsRequested: requestedPassCount,
                paintsReceived: passes.length,
                passesRequested: requestedPassCount,
                passesReceived: passes.length,
                perPass: passes.map(p => ({
                    pass: p.passIdx + 1,
                    t_ms: Number(p.t.toFixed(2)),
                    isFinal: !!p.isFinal,
                    stats: p.stats && normalizeFrameStatsForExport(p.stats)
                })),
                first_ms: progressiveFirstMs != null ? Number(progressiveFirstMs.toFixed(2)) : null,
                final_ms: progressiveFinalMs != null ? Number(progressiveFinalMs.toFixed(2)) : null,
                oneShot_ms: oneShotFinalMs != null ? Number(oneShotFinalMs.toFixed(2)) : null,
                encode_ms: Number(encodeMs.toFixed(2)),
                fileSizeKB: Number((jxlBytes.length / 1024).toFixed(1)),
                speedup: (oneShotFinalMs && progressiveFirstMs)
                    ? Number((oneShotFinalMs / progressiveFirstMs).toFixed(2))
                    : null,
                final_psnr_vs_source: finalPsnrVsSource != null ? Number(finalPsnrVsSource.toFixed(2)) : null,
            };
            runMeasurements.push(measurement);
            if (runMeasurements.length > MAX_MEASUREMENTS) runMeasurements = runMeasurements.slice(-MAX_MEASUREMENTS);

            if (isLast) {
                renderProgressiveComparison({
                    requestedPassCount,
                    passCount: passes.length,
                    progressiveFirstMs,
                    progressiveFinalMs,
                    oneShotFinalMs,
                    fileSizeKB: jxlBytes.length / 1024,
                    encodeMs,
                    previewFirst,
                    progressiveDetail,
                    progressiveDc,
                    groupOrder,
                });

                const oneShotSummary = oneShotFinalMs != null ? ` · one-shot ${oneShotFinalMs.toFixed(1)} ms` : '';
                const summary = `${passes.length} paints · first ${progressiveFirstMs?.toFixed(1)} ms · final ${progressiveFinalMs?.toFixed(1)} ms${oneShotSummary}${finalPsnrVsSource != null ? ` · final PSNR ${finalPsnrVsSource.toFixed(1)} dB vs source` : ''}`;
                const doneText = `Done. ${summary}`;

                // Put the prominent "Done..." summary in the results area (left side of the new status line).
                const doneEl2 = document.getElementById('run-done-summary');
                const lineEl2 = document.getElementById('run-status-line');
                if (doneEl2) doneEl2.textContent = doneText;
                if (lineEl2) lineEl2.hidden = false;

                // This also feeds the .run-live-status to the right of it via the updated setProgStatus.
                setProgStatus(doneText);
                dbgLog('Progressive paint done', summary, 'success');

                if (shouldRunByteCutoffProbe()) await runByteCutoffProbe(jxlBytes, progressiveDetail);

                // Only show the strip of small thumbnails if we actually got >1 pass for this photo
                updateTimelineVisibility(passes.length);
                lastPassCount = passes.length;
                updateUI(); // enable export buttons now that we have lastJxlBytes
            } else {
                dbgLog('Batch item complete', `${src.file}: ${passes.length} paints · first ${progressiveFirstMs?.toFixed(1)} ms`, 'info');
            }
        } // end for sourcesToRun

    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error ? err.stack : '';
        setProgStatus(`Error: ${errMsg}`);
        dbgLog('Progressive paint error', errMsg, 'error');
        dbgLog('Error stack', errStack, 'error');
        console.error('Full error:', err);
        clearLastExport(); // prevent partial last* from a failed batch run from being exported later
    } finally {
        runProgressiveBtn.textContent = 'Run progressive paint';
        runProgressiveBtn.disabled = !(selectedSource || selectedSources.length);
    }
}

// ─── Export handlers (Progressive gallery + Folder) ───────────────────────────

function triggerJxlDownload(bytes, filename) {
    const blob = new Blob([bytes], { type: 'image/jxl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function exportToGallery() {
    const toExport = lastExportedJxls.length > 0 ? lastExportedJxls :
        (lastJxlBytes ? [{ name: lastJxlFileName || 'progressive-paint.jxl', bytes: lastJxlBytes, settings: lastSettings }] : []);
    if (toExport.length === 0) return;

    const sent = await postProgressiveGalleryPayload(toExport);
    if (sent) {
        dbgLog(`Sent ${toExport.length} JXL(s) to Progressive Gallery`, '', 'success');
        return;
    }

    // Fallback only: localStorage/download can fail for large files, so normal handoff uses postMessage above.
    try {
        const storageItems = toExport.map(e => {
            try {
                const b64 = uint8ToBase64(new Uint8Array(e.bytes));
                return {
                    name: e.name,
                    b64,
                    settings: e.settings ? { ...e.settings } : null,
                    ts: Date.now()
                };
            } catch { return null; }
        }).filter(Boolean);
        const toStore = storageItems.length === 1 ? storageItems[0] : storageItems;
        localStorage.setItem('__progGalleryPush', JSON.stringify(toStore));
        dbgLog(`Pushed ${storageItems.length} JXL(s) to localStorage for gallery auto-load`, '', 'info');
    } catch (e) {
        dbgLog('localStorage push failed (too large?) — will just download', e?.message || e, 'warn');
    }
    // Download all in fallback (single or batch)
    toExport.forEach(e => triggerJxlDownload(e.bytes, e.name));
    dbgLog(`Exported ${toExport.length} JXL(s) for gallery`, '', 'success');
    window.open('./jxl-progressive-gallery.html?autopush=1', '_blank');
    dbgLog('Progressive gallery opened — it should auto-load the pushed progressive JXL(s). Use its controls to vary progressiveDc/groupOrder.', '', 'info');
}

function postProgressiveGalleryPayload(exportItems) {
    return new Promise((resolve) => {
        let items = Array.isArray(exportItems) ? exportItems : [];
        if (exportItems && exportItems.bytes && !Array.isArray(exportItems)) items = [exportItems];
        items = items.filter(it => it && it.bytes);
        if (!items.length) { resolve(false); return; }

        const targetWindow = window.open('./jxl-progressive-gallery.html?autopush=1', '_blank');
        if (!targetWindow) { resolve(false); return; }

        const transferId = `progressive-paint-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let sent = false;
        let done = false;

        const cleanup = () => {
            window.removeEventListener('message', onReady);
        };
        const finish = (ok) => {
            if (done) return;
            done = true;
            cleanup();
            resolve(ok);
        };
        const send = () => {
            if (sent || targetWindow.closed) {
                finish(sent);
                return;
            }
            const isBatch = items.length > 1;
            const transfers = [];
            let payload;
            if (isBatch) {
                const batchItems = items.map(it => {
                    const b = new Uint8Array(it.bytes);
                    transfers.push(b.buffer);
                    return {
                        name: it.name,
                        bytes: b,
                        settings: it.settings ? { ...it.settings } : null,
                    };
                });
                payload = { batch: true, items: batchItems, transferId };
            } else {
                const b = new Uint8Array(items[0].bytes);
                transfers.push(b.buffer);
                payload = {
                    name: items[0].name,
                    bytes: b,
                    settings: items[0].settings ? { ...items[0].settings } : null,
                    transferId
                };
            }
            const message = { type: 'progressive-gallery-push', payload };
            try {
                targetWindow.postMessage(message, location.origin, transfers);
                sent = true;
                finish(true);
            } catch (e) {
                dbgLog('Direct gallery send failed', e?.message || e, 'warn');
                finish(false);
            }
        };
        function onReady(ev) {
            if (ev.source !== targetWindow) return;
            if (ev.origin !== location.origin) return;
            if (ev.data?.type !== 'progressive-gallery-ready') return;
            send();
        }

        window.addEventListener('message', onReady);
        setTimeout(send, 800);
        setTimeout(() => finish(sent), 2000);
    });
}

async function exportToFolder() {
    const entries = lastExportedJxls.length > 0
        ? lastExportedJxls.map(e => ({ filename: e.name, bytes: e.bytes }))
        : (lastJxlBytes ? [{ filename: lastJxlFileName, bytes: lastJxlBytes }] : []);
    if (!entries.length) return;

    if (typeof showDirectoryPicker === 'function') {
        let dirHandle;
        try {
            dirHandle = await showDirectoryPicker({ mode: 'readwrite' });
        } catch (e) {
            if (e.name === 'AbortError') return;
            dbgLog(`Folder picker failed: ${e.message}`, '', 'error');
            return;
        }
        let saved = 0;
        for (const { filename, bytes } of entries) {
            try {
                const fh = await dirHandle.getFileHandle(filename, { create: true });
                const writable = await fh.createWritable();
                await writable.write(bytes);
                await writable.close();
                saved++;
            } catch (e) {
                dbgLog(`Failed to write ${filename}: ${e.message}`, '', 'error');
            }
        }
        dbgLog(`Saved ${saved}/${entries.length} JXL(s) to folder`, '', 'success');
    } else {
        dbgLog('showDirectoryPicker not available — falling back to download', '', 'warn');
        entries.forEach(e => triggerJxlDownload(e.bytes, e.filename));
    }
}

// Wire export buttons (already got refs earlier)
if (exportGalleryBtn) exportGalleryBtn.addEventListener('click', exportToGallery);
if (exportFolderBtn) exportFolderBtn.addEventListener('click', exportToFolder);

// ─── Structured measurements export (CSV + JSON) ──────────────────────────────

// Chunked base64 encode — avoids call-stack overflow for large Uint8Arrays via Function.apply.
function uint8ToBase64(uint8) {
    let str = '';
    const CHUNK = 0x8000; // 32 KB — safe for apply on all engines
    for (let i = 0; i < uint8.length; i += CHUNK) {
        str += String.fromCharCode.apply(null, uint8.subarray(i, i + CHUNK));
    }
    return btoa(str);
}

function downloadText(filename, text, mime = 'text/plain') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function normalizeFrameStatsForExport(stats) {
    if (!stats) return null;
    return {
        alphaMin: stats.alphaMin,
        alphaMax: stats.alphaMax,
        alphaZeroPct: Number(stats.alphaZeroPct.toFixed(2)),
        rgbNonzeroCount: stats.rgbNonzeroCount,
        lumaVariance: Number(stats.lumaVariance.toFixed(2)),
        frameHash: stats.frameHash,
        pixelCount: stats.pixelCount,
        byteLength: stats.byteLength,
    };
}

function csvCell(value) {
    const str = String(value ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function exportMeasurementsCSV() {
    if (!runMeasurements.length) return;

    const headers = [
        'ts', 'source', 'size', 'quality', 'stream_steps_requested', 'actual_paints',
        'first_ms', 'final_ms', 'oneShot_ms', 'speedup_x', 'encode_ms', 'file_kb',
        'pass_timings', 'pass_stats'
    ];

    const rows = runMeasurements.map(m => {
        const s = m.settings || {};
        const passTimings = (m.perPass || [])
            .map(p => `${p.pass}:${p.t_ms}${p.isFinal ? 'f' : ''}`)
            .join(';');
        const perPassStats = (m.perPass || [])
            .map(p => `${p.pass}:${p.stats ? formatFrameStatsCompact(p.stats) : ''}`)
            .join(';');

        return [
            m.ts,
            m.source,
            s.size ?? '',
            s.quality ?? '',
            m.streamStepsRequested ?? m.passesRequested ?? '',
            m.paintsReceived ?? m.passesReceived ?? '',
            m.first_ms ?? '',
            m.final_ms ?? '',
            m.oneShot_ms ?? '',
            m.speedup ?? '',
            m.encode_ms ?? '',
            m.fileSizeKB ?? '',
            passTimings,
            perPassStats
        ].map(csvCell).join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    downloadText(`progressive-paint-measurements-${ts}.csv`, csv, 'text/csv');
    dbgLog('Exported measurements', `${runMeasurements.length} runs → CSV`, 'success');
}

function exportMeasurementsJSON() {
    if (!runMeasurements.length) return;
    const json = JSON.stringify(runMeasurements, null, 2);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    downloadText(`progressive-paint-measurements-${ts}.json`, json, 'application/json');
    dbgLog('Exported measurements', `${runMeasurements.length} runs → JSON`, 'success');
}

async function exportMeasurementsTOON() {
    if (!runMeasurements.length) return;

    const now = new Date().toISOString();
    // Use array + join to avoid O(n²) string reallocation from repeated string concat.
    const lines = [];
    const dict = {
        'ti': 'tiny',
        'sm': 'small',
        'me': 'medium',
        'la': 'large',
        'di': 'display',
        'vl': 'very-large',
        'or': 'original',
        'co': 'center-out',
        'tb': 'top-bottom'
    };
    const reverseDict = Object.fromEntries(Object.entries(dict).map(([k,v]) => [v,k]));
    const mapVal = (v) => reverseDict[v] || v;

    lines.push(`Dict: ${Object.entries(dict).map(([k,v]) => `${k}=${v}`).join(', ')}\n`);
    lines.push(`meta:\n`);
    lines.push(`  exportedAt: ${now}\n`);
    lines.push(`  generator: jxl-progressive-paint\n`);
    lines.push(`  count: ${runMeasurements.length}\n`);
    lines.push(`  format: progressive-paint-measurements-v1\n`);

    let rowCount = 0;
    for (const m of runMeasurements) {
        if (m.perPass && m.perPass.length) rowCount += m.perPass.length;
        else rowCount += 1;
    }

    lines.push(`\n---\n`);
    lines.push(`runs[${rowCount}]{source|size|qual|streamReq|detail|paintsRcv|firstMs|finalMs|oneshotMs|speedup|encMs|sizeKB|pass|t_ms|isFinal|aMin|aMax|aZeroPct|rgbNz|lumaVar|hash}:\n`);

    let lastSource = '';
    let lastSize = '';
    let lastQual = '';
    let lastStreamReq = '';
    let lastDetail = '';
    let lastPaintsRcv = '';
    let lastFirstMs = '';
    let lastFinalMs = '';
    let lastOneshot = '';
    let lastSpeedup = '';
    let lastEncMs = '';
    let lastSizeKB = '';

    for (const m of runMeasurements) {
        const s = m.settings || {};
        const source = quoteIfNeeded(m.source);
        const size = mapVal(s.size ?? '');
        const qual = s.quality ?? '';
        const streamReq = m.streamStepsRequested ?? m.passesRequested ?? '';
        const detail = quoteIfNeeded(s.progressiveDetail ?? '');
        const paintsRcv = m.paintsReceived ?? m.passesReceived ?? '';
        const firstMs = m.first_ms != null ? m.first_ms.toFixed(1) : '';
        const finalMs = m.final_ms != null ? m.final_ms.toFixed(1) : '';
        const oneshotMs = m.oneShot_ms != null ? m.oneShot_ms.toFixed(1) : '';
        const speedup = m.speedup != null ? m.speedup.toFixed(2) : '';
        const encMs = m.encode_ms != null ? m.encode_ms.toFixed(1) : '';
        const sizeKB = m.fileSizeKB != null ? m.fileSizeKB.toFixed(1) : '';

        if (!m.perPass || !m.perPass.length) {
            const outSource = source === lastSource ? '~' : source;
            const outSize = size === lastSize ? '~' : size;
            const outQual = String(qual) === String(lastQual) ? '~' : qual;
            const outStream = String(streamReq) === String(lastStreamReq) ? '~' : streamReq;
            const outDetail = detail === lastDetail ? '~' : detail;
            const outPaints = String(paintsRcv) === String(lastPaintsRcv) ? '~' : paintsRcv;
            const outFirst = firstMs === lastFirstMs ? '~' : firstMs;
            const outFinal = finalMs === lastFinalMs ? '~' : finalMs;
            const outOneshot = oneshotMs === lastOneshot ? '~' : oneshotMs;
            const outSpeedup = speedup === lastSpeedup ? '~' : speedup;
            const outEnc = encMs === lastEncMs ? '~' : encMs;
            const outKB = sizeKB === lastSizeKB ? '~' : sizeKB;

            lines.push(`  ${outSource} | ${outSize} | ${outQual} | ${outStream} | ${outDetail} | ${outPaints} | ${outFirst} | ${outFinal} | ${outOneshot} | ${outSpeedup} | ${outEnc} | ${outKB}KB | - | - | - | - | - | - | - | - | -\n`);

            lastSource = source; lastSize = size; lastQual = qual; lastStreamReq = streamReq;
            lastDetail = detail; lastPaintsRcv = paintsRcv; lastFirstMs = firstMs; lastFinalMs = finalMs;
            lastOneshot = oneshotMs; lastSpeedup = speedup; lastEncMs = encMs; lastSizeKB = sizeKB;
        } else {
            for (const p of m.perPass) {
                const pass = p.pass;
                const t_ms = p.t_ms != null ? p.t_ms.toFixed(1) : '';
                const isFinal = p.isFinal ? 'T' : 'F';
                const st = p.stats || {};
                const aMin = st.alphaMin ?? '';
                const aMax = st.alphaMax ?? '';
                const aZero = st.alphaZeroPct != null ? st.alphaZeroPct.toFixed(1) : '';
                const rgbNz = st.rgbNonzeroCount ?? '';
                const lumaVar = st.lumaVariance != null ? st.lumaVariance.toFixed(1) : '';
                const hash = st.frameHash ?? '';

                const outSource = source === lastSource ? '~' : source;
                const outSize = size === lastSize ? '~' : size;
                const outQual = String(qual) === String(lastQual) ? '~' : qual;
                const outStream = String(streamReq) === String(lastStreamReq) ? '~' : streamReq;
                const outDetail = detail === lastDetail ? '~' : detail;
                const outPaints = String(paintsRcv) === String(lastPaintsRcv) ? '~' : paintsRcv;
                const outFirst = firstMs === lastFirstMs ? '~' : firstMs;
                const outFinal = finalMs === lastFinalMs ? '~' : finalMs;
                const outOneshot = oneshotMs === lastOneshot ? '~' : oneshotMs;
                const outSpeedup = speedup === lastSpeedup ? '~' : speedup;
                const outEnc = encMs === lastEncMs ? '~' : encMs;
                const outKB = sizeKB === lastSizeKB ? '~' : sizeKB;

                lines.push(`  ${outSource} | ${outSize} | ${outQual} | ${outStream} | ${outDetail} | ${outPaints} | ${outFirst} | ${outFinal} | ${outOneshot} | ${outSpeedup} | ${outEnc} | ${outKB}KB | ${pass} | ${t_ms} | ${isFinal} | ${aMin} | ${aMax} | ${aZero} | ${rgbNz} | ${lumaVar} | ${hash}\n`);

                lastSource = source; lastSize = size; lastQual = qual; lastStreamReq = streamReq;
                lastDetail = detail; lastPaintsRcv = paintsRcv; lastFirstMs = firstMs; lastFinalMs = finalMs;
                lastOneshot = oneshotMs; lastSpeedup = speedup; lastEncMs = encMs; lastSizeKB = sizeKB;
            }
        }
    }

    const out = lines.join('');
    let userChoice = prompt("Type 'C' to Copy Only, 'S' to Copy & Save, or hit Cancel.", "S");
    
    if (userChoice !== null) {
        userChoice = userChoice.toUpperCase().trim();
        if (userChoice === 'C' || userChoice === 'S') {
            try {
                await navigator.clipboard.writeText(out);
                dbgLog('Copied TOON to clipboard', `${runMeasurements.length} runs`);
            } catch (err) {
                dbgLog('Clipboard blocked', String(err), 'warn');
            }
        }
        if (userChoice === 'S') {
            const ts = now.replace(/[:.]/g, '-');
            downloadText(`progressive-paint-measurements-${ts}.toon`, out, 'text/toon');
            dbgLog('Exported measurements', `${runMeasurements.length} runs → TOON`, 'success');
        }
    }
}

function markdownCell(value) {
    return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function buildMeasurementsMarkdown() {
    const parts = ['# Progressive Paint Measurements\n\n'];
    parts.push('| Source | Paints | First ms | Final ms | One-shot ms | Encode ms | File KB | Final PSNR |\n');
    parts.push('|---|---:|---:|---:|---:|---:|---:|---:|\n');
    for (const m of runMeasurements) {
        parts.push([
            markdownCell(m.source),
            m.paintsReceived ?? m.passesReceived ?? '',
            m.first_ms ?? '',
            m.final_ms ?? '',
            m.oneShot_ms ?? '',
            m.encode_ms ?? '',
            m.fileSizeKB ?? '',
            m.final_psnr_vs_source ?? ''
        ].join(' | '));
        parts.push('\n');
    }

    for (const m of runMeasurements) {
        parts.push(`\n## ${markdownCell(m.source)}\n\n`);
        parts.push('| Pass | t ms | Final | alphaMin | alphaMax | alphaZeroPct | rgbNonzeroCount | lumaVariance | frameHash |\n');
        parts.push('|---:|---:|---|---:|---:|---:|---:|---:|---|\n');
        for (const p of m.perPass || []) {
            const stats = p.stats || {};
            parts.push([
                p.pass,
                p.t_ms,
                p.isFinal ? 'true' : 'false',
                stats.alphaMin ?? '',
                stats.alphaMax ?? '',
                stats.alphaZeroPct ?? '',
                stats.rgbNonzeroCount ?? '',
                stats.lumaVariance ?? '',
                markdownCell(stats.frameHash ?? '')
            ].join(' | '));
            parts.push('\n');
        }
    }
    return parts.join('');
}

async function copyMeasurementsMarkdown() {
    if (!runMeasurements.length) return;
    const markdown = buildMeasurementsMarkdown();
    try {
        await navigator.clipboard.writeText(markdown);
        dbgLog('Copied measurements', `${runMeasurements.length} runs -> Markdown`, 'success');
    } catch (err) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        downloadText(`progressive-paint-measurements-${ts}.md`, markdown, 'text/markdown');
        dbgLog('Clipboard blocked; downloaded Markdown', err instanceof Error ? err.message : String(err), 'warn');
    }
}

function quoteIfNeeded(str) {
    if (!str) return '';
    const needsQuotes = /[\s,:[\]{}"\\]/.test(str) || str === 'true' || str === 'false' || str === 'null';
    if (needsQuotes) {
        return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }
    return str;
}

function clearMeasurements() {
    runMeasurements.length = 0;
    dbgLog('Measurement history cleared', '', 'warn');
    updateUI();
}

if (exportCsvBtn) exportCsvBtn.addEventListener('click', exportMeasurementsCSV);
if (exportJsonBtn) exportJsonBtn.addEventListener('click', exportMeasurementsJSON);
if (exportToonBtn) exportToonBtn.addEventListener('click', exportMeasurementsTOON);
if (copyMeasurementsMdBtn) copyMeasurementsMdBtn.addEventListener('click', copyMeasurementsMarkdown);
if (clearMeasurementsBtn) clearMeasurementsBtn.addEventListener('click', clearMeasurements);

// Wire progressive group-order checkbox + smart defaults (handoff step: UI polish so no more hacks for A/B).
// Default checked when passes>=4 or previewFirst (as recommended for early-recognizable layers).
// User toggle is respected on subsequent passes/preview changes via data-userToggled marker.
const passesRadios = document.querySelectorAll('input[name="prog-passes"]');
passesRadios.forEach(r => r.addEventListener('change', () => syncGroupOrderDefault()));
const previewCb = document.getElementById('prog-preview-first');
if (previewCb) previewCb.addEventListener('change', () => syncGroupOrderDefault());
const groupCb = document.getElementById('prog-group-order');
if (groupCb) {
    groupCb.addEventListener('change', () => { groupCb.dataset.userToggled = '1'; });
}
syncGroupOrderDefault(); // run once at init (corrects html 'checked' for the initial 2-pass case)

// Sync Detail + steps when Sneyers preset selected (needs 'passes' + >=4-6 steps for visible multi-layer refinement).
// Mirrors syncGroupOrderDefault pattern; forces on preset change/init (user can tweak radios after if desired).
const presetEl = document.getElementById('preset-name');
function syncSneyersDefaults() {
    if (!presetEl || presetEl.value !== 'sneyers') return;
    // Prefer 6 steps for good demo of truly-progressive layers (DC=2 + groupOrder gives several early paints)
    const steps6 = document.querySelector('input[name="prog-passes"][value="6"]');
    if (steps6) steps6.checked = true;
}
if (presetEl) {
    presetEl.addEventListener('change', syncSneyersDefaults);
}
syncSneyersDefaults(); // init (html default is sneyers + auto/2, this corrects)

dbgLog('Progressive paint initialized');
