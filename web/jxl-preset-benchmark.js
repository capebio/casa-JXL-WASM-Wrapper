import initRaw, * as rawWasm from './pkg/raw_converter_wasm.js';
import { createEncoder, createDecoder } from '@casabio/jxl-wasm';
import { initDebugConsole, dbgLog } from './jxl-debug-console.js';
import { ensureJxlTileDecoder } from './dng-jxl-libjxl.js';
import {
    buildRawMeasurementKey,
    createBenchmarkRow,
    findRawIsolationMatch,
    getCachedResizeVariant,
    joinCsvRow,
    pickScenarioWinner,
    shouldPublishSweepArtifacts,
} from './jxl-preset-benchmark-core.js';

console.log('%c[Preset Benchmark] jxl-preset-benchmark.js loaded — preset/scenario sweep across tiers + sizes', 'color:#f97316;font-weight:600', { page: 'Preset Benchmark', url: location.href, t: new Date().toISOString(), ua: navigator.userAgent.slice(0, 120) });

// === IDB ===

const IDB_NAME = 'jxl-preset-bench';
const IDB_STORE = 'sources';
let idbAvailable = true;
let _db = null;

async function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

async function getDb() {
    if (_db) return _db;
    _db = await openDb();
    return _db;
}

async function idbPut(slot, record) {
    if (!idbAvailable) return;
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(record, slot);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
    });
}

async function idbGet(slot) {
    if (!idbAvailable) return null;
    const db = await getDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(slot);
        req.onsuccess = (e) => resolve(e.target.result ?? null);
        req.onerror = (e) => reject(e.target.error);
    });
}

// === File intake ===

const SLOTS = [
    { id: 'orf',   label: 'ORF',   accept: '.orf,.ORF',         colorClass: 'slot-orf'  },
    { id: 'dng',   label: 'DNG',   accept: '.dng,.DNG',         colorClass: 'slot-dng'  },
    { id: 'cr2',   label: 'CR2',   accept: '.cr2,.CR2',         colorClass: 'slot-cr2'  },
    { id: 'jpeg',  label: 'JPEG',  accept: '.jpg,.jpeg,.png',   colorClass: 'slot-jpeg' },
    { id: 'other', label: 'OTHER', accept: '*',                 colorClass: 'slot-other'},
];

// Exported: consumed by Task 6 sweep engine and Task 9 UI
export const loadedSources = {};

// DOM refs keyed by slot.id
const slotFilenameEls = {};
const slotCardEls = {};

function buildFileIntake() {
    const container = document.getElementById('file-slots');
    if (!container) return;

    for (const slot of SLOTS) {
        const card = document.createElement('div');
        card.className = `slot-card ${slot.colorClass}`;
        card.dataset.slotId = slot.id;

        const label = document.createElement('div');
        label.className = 'slot-label';
        label.textContent = slot.label;

        const filenameBadge = document.createElement('div');
        filenameBadge.className = 'slot-name';
        filenameBadge.textContent = 'drop or click';

        const metaBadge = document.createElement('div');
        metaBadge.className = 'slot-meta';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = slot.accept;
        fileInput.style.display = 'none';
        fileInput.setAttribute('aria-label', `Pick ${slot.label} file`);

        card.appendChild(label);
        card.appendChild(filenameBadge);
        card.appendChild(metaBadge);
        card.appendChild(fileInput);
        container.appendChild(card);

        slotFilenameEls[slot.id] = filenameBadge;
        slotCardEls[slot.id] = card;

        // Click → open file picker
        card.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('click', (e) => e.stopPropagation());

        // Drag-and-drop
        card.addEventListener('dragover', (e) => {
            e.preventDefault();
            card.style.background = 'rgba(255,255,255,0.08)';
        });
        card.addEventListener('dragleave', () => {
            card.style.background = '';
        });
        card.addEventListener('drop', async (e) => {
            e.preventDefault();
            card.style.background = '';
            const file = e.dataTransfer?.files?.[0];
            if (file) await handleFile(slot, file);
        });

        // File picker selection
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (file) {
                await handleFile(slot, file);
                fileInput.value = '';
            }
        });
    }
}

function setSlotFilename(slotId, name) {
    const el = slotFilenameEls[slotId];
    if (el) el.textContent = name;
}

function setSlotError(slotId, msg) {
    const card = slotCardEls[slotId];
    if (card) card.style.borderColor = 'var(--danger)';
    const el = slotFilenameEls[slotId];
    if (el) el.textContent = msg ?? 'decode error';
}

function clearSlotError(slotId) {
    const card = slotCardEls[slotId];
    if (card) card.style.borderColor = '';
}

async function handleFile(slot, file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    sessionBytes.set(slot.id, bytes); // keep for RAW isolation this session
    const ext = file.name.split('.').pop() ?? '';
    clearSlotError(slot.id);
    try {
        const result = await decodeSource(bytes, ext);
        loadedSources[slot.id] = {
            name: file.name,
            byteLength: bytes.byteLength,
            lastModified: file.lastModified || 0,
            ...result,
        };
        if (idbAvailable) {
            try {
                await idbPut(slot.id, { name: file.name, bytes, ext, byteLength: bytes.byteLength, lastModified: file.lastModified || 0 });
            } catch (err) {
                console.warn('[preset-bench] IDB write failed:', err);
            }
        }
        setSlotFilename(slot.id, file.name);
        updateButtonStates(); // Enable RAW / Run buttons now that we have files
    } catch (err) {
        console.error(`[preset-bench] Decode failed for slot ${slot.id}:`, err);
        loadedSources[slot.id] = null;
        setSlotError(slot.id, 'decode error');
    }
}

// === Decode ===

async function decodeViaWasm(bytes, wasmFn) {
    const result = wasmFn(bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
    try {
        // Legacy WASM-side RGBA path removed per Boundary Cost Audit (browser prefers JS conversion)
        const rgbaBytes = rawWasm.rgb_to_rgba(result.take_rgb());
        const rgba = new Uint8ClampedArray(rgbaBytes.buffer, rgbaBytes.byteOffset, rgbaBytes.byteLength);
        return { rgba, width: result.width, height: result.height };
    } finally {
        result.free();
    }
}

async function decodeViaImageBitmap(bytes, ext) {
    const blob = new Blob([bytes]);
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const imgData = ctx.getImageData(0, 0, width, height);
    bitmap.close();
    return { rgba: imgData.data, width, height };
}

async function decodeSource(bytes, ext) {
    const ext_lower = ext.toLowerCase();
    if (ext_lower === 'orf')  return decodeViaWasm(bytes, rawWasm.process_orf);
    if (ext_lower === 'dng')  return decodeViaWasm(bytes, rawWasm.process_dng);
    if (ext_lower === 'cr2')  return decodeViaWasm(bytes, rawWasm.process_cr2);
    // jpeg/png/other
    return decodeViaImageBitmap(bytes, ext);
}

// === Init ===

try {
    const db = await getDb();
    void db; // ensure open succeeds
} catch (err) {
    console.warn('[preset-bench] IndexedDB unavailable, running memory-only:', err);
    idbAvailable = false;
}

await initRaw();
if (typeof rawWasm.initThreadPool === 'function') {
    await rawWasm.initThreadPool(navigator.hardwareConcurrency);
}

buildFileIntake();
buildSweepSettings();
buildPhaseProgress();

// Initialize debug console with the hero button and the settings container
const debugConsoleBtn = document.getElementById('dbg-console-btn');
const settingsConsoleContainer = document.getElementById('settings-console-container');
if (debugConsoleBtn) initDebugConsole(debugConsoleBtn, settingsConsoleContainer);

wireButtons();

// Restore previously stored files from IDB
for (const slot of SLOTS) {
    let record = null;
    try {
        record = await idbGet(slot.id);
    } catch (err) {
        console.warn(`[preset-bench] IDB read failed for slot ${slot.id}:`, err);
    }
    if (!record) continue;
    try {
        const result = await decodeSource(record.bytes, record.ext);
        loadedSources[slot.id] = {
            name: record.name,
            byteLength: record.byteLength ?? record.bytes?.byteLength ?? 0,
            lastModified: record.lastModified || 0,
            ...result,
        };
        setSlotFilename(slot.id, record.name);
    } catch (err) {
        console.error(`[preset-bench] Restore decode failed for slot ${slot.id}:`, err);
        loadedSources[slot.id] = null;
        setSlotError(slot.id, 'decode error');
    }
}

// =============================================================================
// Sweep engine — Task 6
// =============================================================================

// --- Constants ---------------------------------------------------------------

const TIERS = [
    { id: 'low',      label: 'Low',      quality: 72,  lossless: false },
    { id: 'medium',   label: 'Medium',   quality: 85,  lossless: false },
    { id: 'high',     label: 'High',     quality: 92,  lossless: false },
    { id: 'lossless', label: 'Lossless', quality: 100, lossless: true  },
];
const SIZES    = [128, 512, 1920, 'full'];
const EFFORTS  = [1, 2, 3, 4, 5, 6];
const DEC_SPEEDS  = [0, 1, 2, 3, 4];
const MODULAR_VALS = [-1, 0, 1];
const BROTLI_VALS  = [-1, 0, 4, 9];
const RESAMP_VALS  = [1, 2, 4];

// Use-case scenario profiles (user-specified situations).
// Each defines: preferred sizes, metric weights for scoring (higher = more important),
// extra diagnostic behaviors, and human label.
const SCENARIO_PROFILES = {
    thumb: {
        label: 'Thumbnails (rapid gallery)',
        sizes: [128, 512],
        weights: { decSpeed: 0.40, size: 0.25, encSpeed: 0.15, rawCost: 0.20 }, // added rawCost weight
        diagnostics: ['p95', 'sustained', 'raw'],
        description: 'Grid / many visible at once. Low latency per thumb, small file size critical. RAW ingest cost now factored.'
    },
    medium: {
        label: 'Medium preview (1080)',
        sizes: [512, 1920],
        weights: { decSpeed: 0.45, size: 0.25, encSpeed: 0.30 },
        diagnostics: ['firstPixel'],
        description: 'Lightbox warm preview or medium detail view.'
    },
    fullpage: {
        label: 'Full page / lightbox warm',
        sizes: [1920, 'full'],
        weights: { decSpeed: 0.40, size: 0.20, encSpeed: 0.40 },
        diagnostics: ['progressive'],
        description: 'Typical screen-filling image. Balance quality, decode, encode cost.'
    },
    fullres: {
        label: 'Full resolution archival',
        sizes: ['full'],
        weights: { size: 0.60, decSpeed: 0.25, encSpeed: 0.15 },
        diagnostics: ['size', 'fidelity'],
        description: 'Master copy. Size efficiency at high fidelity dominates.'
    },
    massive: {
        label: '80MP+ lightbox exploration (ROI + lowMem)',
        sizes: ['full'],
        weights: { regionTile: 0.35, lowMem: 0.20, decSpeed: 0.15, size: 0.10, rawCost: 0.20 }, // RAW cost very relevant for huge files
        diagnostics: ['region', 'memory', 'lowMemoryMode', 'raw'],
        description: 'Huge scientific/landscape files. Region decode tiles + lowMemoryMode + JXTC critical. RAW ingest now heavily weighted.'
    },
    gallery: {
        label: 'Rapid gallery scroll (sustained throughput)',
        sizes: [128, 512, 1920],
        weights: { decSpeed: 0.40, sustained: 0.25, size: 0.15, rawCost: 0.20 },
        diagnostics: ['p95', 'sustained', 'backpressure', 'raw'],
        description: 'Scrolling large folders. p95 decode latency + worker pool behavior under load. RAW cost now included.'
    }
};

// --- Result storage ----------------------------------------------------------

export const sweepRows   = [];
export let sweepAborted  = false;
export let sweepRunning  = false;

let selectedGraphFormat = 'all'; // 'all' | slotId like 'orf'

// --- UI (wired in Task 9) ----------------------------------------------------

export function updatePhaseStatus(phaseNum, status, progress = 0) {
    // status: 'pending' | 'active' | 'done' | null
    console.log(`[sweep] phase ${phaseNum} → ${status}`);
    if (phaseNum == null) return;
    const card = document.getElementById(`phase-card-${phaseNum}`);
    if (!card) return;
    card.dataset.status = status ?? 'pending';
    const icon = card.querySelector('.phase-icon');
    const bar  = card.querySelector('.phase-bar-fill');
    if (status === 'active') {
        if (icon) icon.textContent = '↻';
        if (bar)  bar.style.width = `${Math.round(progress * 100)}%`;
    } else if (status === 'done') {
        if (icon) icon.textContent = '✓';
        if (bar)  bar.style.width = '100%';
    } else {
        if (icon) icon.textContent = '⋯';
        if (bar)  bar.style.width = '0%';
    }
}

export function updateLiveStatus(msg) {
    console.log(`[sweep] ${msg}`);
    const el = document.getElementById('live-current');
    if (el) el.textContent = msg;
}

// --- Helpers -----------------------------------------------------------------

function _exactBuf(view) {
    if (view instanceof ArrayBuffer) return view;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function _concatChunks(chunks) {
    const views = chunks.map(c => c instanceof Uint8Array ? c : new Uint8Array(c));
    if (views.length === 1) return views[0];
    const total = views.reduce((s, v) => s + v.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const v of views) { out.set(v, offset); offset += v.byteLength; }
    return out;
}

function resizeRgba(source, targetPx) {
    return getCachedResizeVariant(source, targetPx, () => {
        if (targetPx === 'full') return { rgba: source.rgba, width: source.width, height: source.height };
        const scale = targetPx / Math.max(source.width, source.height);
        if (scale >= 1) return { rgba: source.rgba, width: source.width, height: source.height };
        const w = Math.round(source.width * scale);
        const h = Math.round(source.height * scale);
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        const srcCanvas = new OffscreenCanvas(source.width, source.height);
        const srcCtx = srcCanvas.getContext('2d');
        const srcView = source.rgba instanceof Uint8Array ? source.rgba : new Uint8Array(source.rgba);
        srcCtx.putImageData(new ImageData(new Uint8ClampedArray(srcView.buffer, srcView.byteOffset, srcView.byteLength), source.width, source.height), 0, 0);
        ctx.drawImage(srcCanvas, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        return { rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: w, height: h };
    });
}

async function encodeOnce(rgbaResized, width, height, opts) {
    // opts: { quality, lossless, effort, decodingSpeed, modular, brotliEffort, resampling }
    const t0 = performance.now();
    const encOpts = {
        format: 'rgba8',
        width,
        height,
        hasAlpha: true,
        quality: opts.lossless ? null : opts.quality,
        distance: opts.lossless ? 0 : null,
        effort: opts.effort,
        progressive: false,
        previewFirst: false,
        chunked: false,
        decodingSpeed: opts.decodingSpeed > 0 ? opts.decodingSpeed : undefined,
        resampling: opts.resampling !== 1 ? opts.resampling : undefined,
        modular: opts.modular !== -1 ? opts.modular : undefined,
        brotliEffort: opts.brotliEffort >= 0 ? opts.brotliEffort : undefined,
    };
    const encoder = createEncoder(encOpts);
    const chunks = [];
    try {
        const chunkTask = (async () => {
            for await (const chunk of encoder.chunks()) chunks.push(chunk);
        })();
        await encoder.pushPixels(_exactBuf(rgbaResized));
        await encoder.finish();
        await chunkTask;
        const jxlBytes = _concatChunks(chunks);
        return { jxlBytes, encMs: performance.now() - t0 };
    } finally {
        await encoder.dispose();
    }
}

async function decodeOnce(jxlBytes) {
    const t0 = performance.now();
    const decoder = createDecoder({
        format: 'rgba8',
        region: null,
        downsample: 1,
        progressionTarget: 'final',
        emitEveryPass: false,
        preserveIcc: false,
        preserveMetadata: false,
    });
    try {
        await decoder.push(_exactBuf(jxlBytes));
        await decoder.close();
        let info = null;
        for await (const ev of decoder.events()) {
            if (ev.type === 'final') { info = ev.info; break; }
        }
        return { decMs: performance.now() - t0, width: info?.width ?? 0, height: info?.height ?? 0 };
    } finally {
        await decoder.dispose();
    }
}

// === RAW Isolation Surface ===================================================

const RAW_FLAGS = {
    full: 1,      // OUT_FULL_RGB8
    lightbox: 2,  // OUT_LIGHTBOX (1800px RGB16)
    thumb: 4,     // OUT_THUMB (360px RGB16)
    lb_thumb: 6,  // lightbox + thumb
    all: 7,       // full + lb + thumb (matches old process_orf)
};

let rawIsolationData = null;
const sessionBytes = new Map(); // slotId -> Uint8Array (in-memory for current tab session)
let lastRawMeasurementKey = null; // simple cache key to avoid re-work on repeated clicks

async function runRawIsolation() {
    const status = document.getElementById('raw-isolation-status');
    const resultsEl = document.getElementById('raw-isolation-results');
    if (!status || !resultsEl) return;

    const loaded = Object.entries(loadedSources).filter(([_, v]) => v);
    if (!loaded.length) {
        status.textContent = 'Load files first. Original bytes are cached in-memory for this session + IDB.';
        return;
    }

    // Cheap session cache: if the set of loaded files hasn't changed, reuse last measurement
    const currentKey = buildRawMeasurementKey(loaded.map(([slotId, src]) => ({
        slotId,
        sourceName: src.name,
        byteLength: src.byteLength,
        lastModified: src.lastModified,
    })));
    if (lastRawMeasurementKey === currentKey && rawIsolationData && Object.keys(rawIsolationData).length > 0) {
        status.textContent = 'Using cached RAW isolation results (files unchanged)';
        renderRawIsolationResults();
        return;
    }

    status.textContent = 'Measuring RAW isolation (bench_decode_orf + selective modes)...';
    resultsEl.innerHTML = '';

    rawIsolationData = {};

    for (const [slotId, src] of loaded) {
        const bytes = await getBytesForSlot(slotId);
        if (!bytes) {
            rawIsolationData[slotId] = { error: 'no original bytes (re-load the file)', name: src.name };
            continue;
        }

        const ext = (src.name || '').split('.').pop()?.toLowerCase() || '';
        const fn = ext === 'orf' ? rawWasm.process_orf_with_flags
                 : ext === 'dng' ? rawWasm.process_dng_with_flags
                 : ext === 'cr2' ? rawWasm.process_cr2_with_flags : null;
        // Before any timing, so the one-off libjxl load stays out of the numbers.
        if (fn === rawWasm.process_dng_with_flags) await ensureJxlTileDecoder(rawWasm, bytes);

        let bench = null;
        if (typeof rawWasm?.bench_decode_orf === 'function') {
            try {
                // 5 runs + median to reduce measurement noise (was 3 runs).
                // This is the only place bench_decode_orf is called from the browser.
                for (let i = 0; i < 1; i++) rawWasm.bench_decode_orf(bytes); // warm-up
                const runs = [];
                for (let i = 0; i < 5; i++) {
                    const b = rawWasm.bench_decode_orf(bytes);
                    runs.push(b);
                }
                runs.sort((a, b) => (a.decompress_ms + a.demosaic_ms) - (b.decompress_ms + b.demosaic_ms));
                bench = runs[2]; // median of 5
                // (flip-flop harness removed; was temporary for old-vs-new measurement of pointer/SIMD scalar opts in raw hot path)
            } catch (e) {
                console.warn('[raw-isolation] bench_decode_orf failed', slotId, e);
                bench = { error: 'bench_decode_orf threw' };
            }
        } else {
            bench = { error: 'bench_decode_orf not available in this WASM build' };
        }

        const modes = {};

        // Full multi-flag selective sweep + LookRenderer timing
        const flagEntries = [
            ['full', 1],
            ['lightbox', 2],
            ['thumb', 4],
            ['lb+thumb', 6],
            ['all', 7],
        ];

        for (const [name, flag] of flagEntries) {
            if (!fn) continue;
            try {
                const t0 = performance.now();
                const res = fn(bytes, flag, 0,0,0,0,0,0,0,0,0,0, NaN,NaN,0,0);
                const total = performance.now() - t0;

                const modeData = {
                    decompress: res.decompress_ms || 0,
                    demosaic: res.demosaic_ms || 0,
                    tonemap: res.tonemap_ms || 0,
                    orient: res.orient_ms || 0,
                    total,
                };

                // LookRenderer construction + timed render() for modes that produce lb or thumb buffers
                if ((flag & 2) || (flag & 4)) {
                    try {
                        const lbBytes = (flag & 2) ? res.take_rgb16_lb() : null;
                        const thBytes = (flag & 4) ? res.take_rgb16_thumb() : null;
                        const useLb = lbBytes && lbBytes.length > 0;
                        const useTh = thBytes && thBytes.length > 0;

                        if (useLb || useTh) {
                            const renderStart = performance.now();
                            if (useLb) {
                                const renderer = new rawWasm.LookRenderer(lbBytes, res.lb_w || 0, res.lb_h || 0, src.orientation || 1, res.color_matrix_used ? res.color_matrix_used() : []);
                                // representative render (neutral look)
                                renderer.render(1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
                                renderer.free();
                            }
                            if (useTh) {
                                const renderer = new rawWasm.LookRenderer(thBytes, res.thumb_w || 0, res.thumb_h || 0, src.orientation || 1, res.color_matrix_used ? res.color_matrix_used() : []);
                                renderer.render(1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
                                renderer.free();
                            }
                            modeData.lookRenderMs = performance.now() - renderStart;
                        }
                    } catch (e) { /* non-fatal for benchmark */ }
                }

                modes[name] = modeData;
                res.free?.();
            } catch (e) {
                console.warn('[raw-isolation] selective flag failed', name, e);
            }
        }

        // Compute simple per-use-case RAW cost summary for scoring
        const rawCostForScoring = {
            thumb: modes['thumb']?.total || modes['lb+thumb']?.total || modes['all']?.total || 0,
            lightbox: modes['lightbox']?.total || modes['lb+thumb']?.total || modes['all']?.total || 0,
            full: modes['full']?.total || modes['all']?.total || 0,
        };

        rawIsolationData[slotId] = {
            slotId,
            sourceName: src.name,
            bench,
            modes,
            rawCostForScoring,
            width: src.width,
            height: src.height,
            name: src.name,
            ext,
        };
    }

    status.textContent = `RAW isolation (full selective + Look) measured for ${Object.keys(rawIsolationData).length} files`;
    lastRawMeasurementKey = currentKey;
    renderRawIsolationResults();
}

function renderRawIsolationResults() {
    const el = document.getElementById('raw-isolation-results');
    if (!el || !rawIsolationData) return;

    let html = '<table style="width:100%; font-size:11px; border-collapse:collapse;"><thead><tr>' +
        '<th>File</th><th>bench dec+dem</th><th>full</th><th>lightbox</th><th>thumb</th><th>lb+thumb</th><th>all</th><th>Look render</th></tr></thead><tbody>';

    for (const [slot, data] of Object.entries(rawIsolationData)) {
        if (data.error) {
            html += `<tr><td colspan="8" style="color:#f66;">${data.name}: ${data.error}</td></tr>`;
            continue;
        }
        const b = data.bench;
        const benchStr = b ? `${(b.decompress_ms + b.demosaic_ms).toFixed(1)} ms` : '—';

        const m = data.modes || {};
        const cell = (name) => {
            const d = m[name];
            if (!d) return '—';
            let s = `${d.total.toFixed(1)}`;
            if (d.lookRenderMs) s += `+L${d.lookRenderMs.toFixed(1)}`;
            return s;
        };

        const lookMs = Object.values(m).reduce((max, d) => Math.max(max, d.lookRenderMs || 0), 0);

        html += `<tr>
            <td>${data.name}</td>
            <td>${benchStr}</td>
            <td>${cell('full')}</td>
            <td>${cell('lightbox')}</td>
            <td>${cell('thumb')}</td>
            <td>${cell('lb+thumb')}</td>
            <td>${cell('all')}</td>
            <td>${lookMs ? lookMs.toFixed(1) + ' ms' : '—'}</td>
        </tr>`;
    }

    html += '</tbody></table>';
    html += '<div style="font-size:10px;opacity:0.65;margin-top:4px;">' +
        'bench = pure decompress+demosaic. Columns = wall time for process_*_with_flags(flag). +L = LookRenderer construction + one render() for lb/thumb buffers. ' +
        'Re-load originals if bytes missing from IDB.</div>';

    el.innerHTML = html;
    const copyBtn = document.getElementById('btn-raw-isolation-copy');
    if (copyBtn) copyBtn.disabled = false;
}

async function getBytesForSlot(slotId) {
    // Fast path: in-memory session cache (populated on every file load this tab)
    if (sessionBytes.has(slotId)) return sessionBytes.get(slotId);

    try {
        const db = await getDb();
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const record = await new Promise((resolve) => {
            const req = store.get(slotId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
        if (record?.bytes) {
            const u8 = new Uint8Array(record.bytes);
            sessionBytes.set(slotId, u8); // promote to fast cache
            return u8;
        }
    } catch (e) {
        console.warn('[raw-isolation] IDB byte lookup failed', e);
    }
    return null;
}

document.getElementById('btn-raw-isolation')?.addEventListener('click', () => {
    runRawIsolation().catch(console.error);
});
document.getElementById('btn-raw-isolation-clear')?.addEventListener('click', () => {
    rawIsolationData = null;
    lastRawMeasurementKey = null;
    const el = document.getElementById('raw-isolation-results');
    if (el) el.innerHTML = '';
    const st = document.getElementById('raw-isolation-status');
    if (st) st.textContent = '';
    const copyBtn = document.getElementById('btn-raw-isolation-copy');
    if (copyBtn) copyBtn.disabled = true;
});

document.getElementById('btn-raw-isolation-copy')?.addEventListener('click', () => {
    if (!rawIsolationData) return;
    const meta = {
        exportedAt: new Date().toISOString(),
        generator: 'jxl-preset-benchmark/raw-isolation',
        files: Object.keys(rawIsolationData).length,
        hasBench: Object.values(rawIsolationData).some(d => d.bench),
    };
    const text = `RAW ISOLATION MEASUREMENTS\n` +
        `meta: ${JSON.stringify(meta, null, 2)}\n\n` +
        JSON.stringify(rawIsolationData, null, 2);
    navigator.clipboard.writeText(text).then(() => {
        const st = document.getElementById('raw-isolation-status');
        if (st) { const old = st.textContent; st.textContent = 'Copied measurements + header to clipboard'; setTimeout(() => { if (st.textContent.includes('Copied')) st.textContent = old || ''; }, 1400); }
    }).catch(() => alert('Clipboard copy failed'));
});

// Reactive button state management (called after relevant changes)
function updateButtonStates() {
    const hasFiles = Object.values(loadedSources || {}).some(Boolean);

    // RAW Isolation button
    const rawBtn = document.getElementById('btn-raw-isolation');
    if (rawBtn) {
        rawBtn.disabled = !hasFiles;
        rawBtn.title = hasFiles 
            ? "Measure RAW pipeline costs (bench_decode_orf + selective modes). Results will feed into scenario scoring."
            : "Load at least one file first to enable RAW isolation measurement.";
    }
    const rawCopyBtn = document.getElementById('btn-raw-isolation-copy');
    if (rawCopyBtn) {
        rawCopyBtn.disabled = !rawIsolationData || Object.keys(rawIsolationData).length === 0;
    }

    // Run Sweep button
    const runBtn = document.getElementById('btn-run-sweep');
    if (runBtn) {
        const sizesSelected = document.querySelectorAll('input[name="sweep-size"]:checked').length > 0;
        const tiersSelected = document.querySelectorAll('input[name="sweep-tier"]:checked').length > 0;
        const canRun = hasFiles && sizesSelected && tiersSelected;

        runBtn.disabled = !canRun;

        if (!hasFiles) {
            runBtn.title = "Load files first before running a sweep.";
        } else if (!sizesSelected || !tiersSelected) {
            runBtn.title = "Select at least one Size and one Tier to enable Run Sweep.";
        } else {
            runBtn.title = "Run the multi-phase sweep with current settings. RAW costs (if measured) will influence scenario recommendations.";
        }
    }

    // Export (unified explicit buttons per progressive-paint pattern)
    const hasResults = (typeof sweepRows !== 'undefined') && sweepRows.length > 0;
    const csvBtn = document.getElementById('export-csv-btn');
    if (csvBtn) csvBtn.disabled = !hasResults;
    const jsonBtn = document.getElementById('export-json-btn');
    if (jsonBtn) jsonBtn.disabled = !hasResults;
    const toonBtn = document.getElementById('export-toon-btn');
    if (toonBtn) toonBtn.disabled = !hasResults;
    const clearBtn = document.getElementById('clear-measurements-btn');
    if (clearBtn) clearBtn.disabled = !hasResults;
    const recsBtn = document.getElementById('export-recs-btn');
    if (recsBtn) recsBtn.disabled = !hasResults;
}

// _medianOf is the active median helper (used by sweep aggregation).
// The previous async median(fn, n) helper was unused and has been removed (P4 hygiene).

function _medianOf(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

// --- Score computation -------------------------------------------------------

function computeScores(rows) {
    if (!rows.length) return;
    const minSize = Math.min(...rows.map(r => r.sizeBytes));
    const minEnc  = Math.min(...rows.map(r => r.encMs));
    const minDec  = Math.min(...rows.map(r => r.decMs));
    for (const r of rows) {
        const sizeEff  = minSize / r.sizeBytes;
        const encSpeed = minEnc  / r.encMs;
        const decSpeed = minDec  / r.decMs;
        r.score = Math.round((sizeEff * 0.4 + encSpeed * 0.4 + decSpeed * 0.2) * 100);
    }
}

// --- Knee-point algorithm ----------------------------------------------------

function kneePoint(efforts, sizes, times) {
    for (let i = 1; i < efforts.length; i++) {
        const sizeReduction = (sizes[i - 1] - sizes[i]) / sizes[i - 1];
        const timeCost      = (times[i] - times[i - 1]) / times[i - 1];
        if (timeCost > 3 * sizeReduction) return efforts[i - 1];
    }
    // No knee: return effort with minimum size
    let minIdx = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] < sizes[minIdx]) minIdx = i;
    return efforts[minIdx];
}

// --- Phase-2 best decode speed selector -------------------------------------

function bestDecSpeedFor(rows, baselineEncMs) {
    const valid = rows.filter(r => r.encMs <= 2 * baselineEncMs);
    if (!valid.length) return 0;
    return valid.reduce((best, r) => r.decMs < best.decMs ? r : best).decSpeed;
}

// --- Abort / yield -----------------------------------------------------------

async function nextFrame() {
    return new Promise(r => requestAnimationFrame(r));
}

let lastYield = 0;
let yC = 0;
async function maybeYield() {
  const n = performance.now();
  if (++yC % 4 === 0 || n - lastYield > 16) {
    lastYield = n;
    await nextFrame();
  }
}

// --- Main sweep orchestrator -------------------------------------------------

export async function runSweep(options = {}) {
    const {
        tiers: tierFilter   = TIERS.map(t => t.id),
        sizes: sizeFilter   = SIZES,
        efforts: effortFilter = EFFORTS,
        scenarios: scenarioFilter = Object.keys(SCENARIO_PROFILES),
        runsPerConfig       = 3,
    } = options;

    sweepRunning = true;
    sweepAborted = false;
    sweepRows.length = 0;

    // Reset all phase cards and live status for the new run
    for (let i = 1; i <= 4; i++) updatePhaseStatus(i, 'pending');
    const liveCurrentEl = document.getElementById('live-current');
    if (liveCurrentEl) liveCurrentEl.textContent = 'Starting…';

    const activeTiers = TIERS.filter(t => tierFilter.includes(t.id));
    const activeScenarios = scenarioFilter.filter(s => SCENARIO_PROFILES[s]);

    const activeFiles = SLOTS.filter(s => loadedSources[s.id]);

    // Union of sizes required by the chosen scenarios (plus any explicit size filter)
    let scenarioSizes = [];
    for (const s of activeScenarios) {
        scenarioSizes.push(...(SCENARIO_PROFILES[s]?.sizes || []));
    }
    const effectiveSizeFilter = sizeFilter.length ? sizeFilter : [...new Set(scenarioSizes)];
    const activeSizes = SIZES.filter(s => effectiveSizeFilter.includes(s));

    console.log('%c[Preset Benchmark] run start', 'color:#f97316;font-weight:600', { t: new Date().toISOString(), tiers: activeTiers.map(t => t.id), scenarios: activeScenarios, sizes: activeSizes, runsPerConfig });
    dbgLog('Sweep starting', `files=${activeFiles.map(f=>f.label).join('+')||'none'} efforts=${(effortFilter||[]).join(',')||'1-6'} sizes=${activeSizes.join(',')}`);

    // Store for post-processing (diagnostics use the chosen scenarios + their weights)
    window.__lastSweepScenarios = activeScenarios;

    const bestEffort   = {}; // [tier.id][file][sizePx]
    const bestDecSpeed = {}; // [tier.id][file][sizePx]
    const bestModular  = {}; // [tier.id]
    const bestBrotli   = {}; // [tier.id]
    const bestResamp   = {}; // [tier.id][file][sizePx]

    try {
        // =====================================================================
        // Phase 1: Effort sweep
        // =====================================================================
        updatePhaseStatus(1, 'active');
        const phase1Rows = [];

        for (const tier of activeTiers) {
            bestEffort[tier.id] ??= {};
            for (const fileSlot of activeFiles) {
                bestEffort[tier.id][fileSlot.id] ??= {};
                const src = loadedSources[fileSlot.id];
                for (const sizePx of activeSizes) {
                    const { rgba, width, height } = resizeRgba(src, sizePx);
                    const effortRows = [];
                    const activeEfforts = (effortFilter && effortFilter.length) ? effortFilter : EFFORTS;

                    for (const effort of activeEfforts) {
                        if (sweepAborted) return;
                        updateLiveStatus(`P1 ${tier.label} · ${fileSlot.label} · ${sizePx}px · effort ${effort}`);

                        // warm
                        await encodeOnce(rgba, width, height, { quality: tier.quality, lossless: tier.lossless, effort, decodingSpeed: 0, modular: -1, brotliEffort: -1, resampling: 1 });
                        await decodeOnce((await encodeOnce(rgba, width, height, { quality: tier.quality, lossless: tier.lossless, effort, decodingSpeed: 0, modular: -1, brotliEffort: -1, resampling: 1 })).jxlBytes);

                        const encMsVals = [], decMsVals = [], sizeVals = [];
                        for (let run = 0; run < runsPerConfig; run++) {
                            const enc = await encodeOnce(rgba, width, height, {
                                quality: tier.quality,
                                lossless: tier.lossless,
                                effort,
                                decodingSpeed: 0,
                                modular: -1,
                                brotliEffort: -1,
                                resampling: 1,
                            });
                            const dec = await decodeOnce(enc.jxlBytes);
                            encMsVals.push(enc.encMs);
                            decMsVals.push(dec.decMs);
                            sizeVals.push(enc.jxlBytes.byteLength);
                        }

                        const row = createBenchmarkRow({
                            fileSlot,
                            source: src,
                            sizePx,
                            tier: tier.id,
                            phase: 1,
                            effort,
                            decSpeed: 0,
                            modular: -1,
                            brotli: -1,
                            resamp: 1,
                            encMs: _medianOf(encMsVals),
                            decMs: _medianOf(decMsVals),
                            sizeBytes: _medianOf(sizeVals),
                            score: 0,
                            measuredCapabilities: { phase3ValidatedSizes: [] },
                        });
                        effortRows.push(row);
                        sweepRows.push(row);
                        phase1Rows.push(row);

                        await maybeYield();
                        if (sweepAborted) return;
                    }

                    // Knee-point to pick best effort
                    const efforts = effortRows.map(r => r.effort);
                    const sizes   = effortRows.map(r => r.sizeBytes);
                    const times   = effortRows.map(r => r.encMs);
                    bestEffort[tier.id][fileSlot.id][sizePx] = kneePoint(efforts, sizes, times);
                }
            }
        }

        for (const tier of activeTiers) {
            computeScores(phase1Rows.filter(r => r.tier === tier.id));
        }
        updatePhaseStatus(1, 'done');
        if (sweepAborted) return;

        // =====================================================================
        // Phase 2: Decode speed sweep
        // =====================================================================
        updatePhaseStatus(2, 'active');
        const phase2Rows = [];

        for (const tier of activeTiers) {
            bestDecSpeed[tier.id] ??= {};
            for (const fileSlot of activeFiles) {
                bestDecSpeed[tier.id][fileSlot.id] ??= {};
                const src = loadedSources[fileSlot.id];
                for (const sizePx of activeSizes) {
                    const { rgba, width, height } = resizeRgba(src, sizePx);
                    const effort = bestEffort[tier.id]?.[fileSlot.id]?.[sizePx] ?? 4;
                    const decRows = [];

                    // Baseline: decodingSpeed=0
                    let baselineEncMs = null;

                    for (const decSpeed of DEC_SPEEDS) {
                        if (sweepAborted) return;
                        updateLiveStatus(`P2 ${tier.label} · ${fileSlot.label} · ${sizePx}px · decSpeed ${decSpeed}`);

                        const encMsVals = [], decMsVals = [], sizeVals = [];
                        for (let run = 0; run < runsPerConfig; run++) {
                            const enc = await encodeOnce(rgba, width, height, {
                                quality: tier.quality,
                                lossless: tier.lossless,
                                effort,
                                decodingSpeed: decSpeed,
                                modular: -1,
                                brotliEffort: -1,
                                resampling: 1,
                            });
                            const dec = await decodeOnce(enc.jxlBytes);
                            encMsVals.push(enc.encMs);
                            decMsVals.push(dec.decMs);
                            sizeVals.push(enc.jxlBytes.byteLength);
                        }

                        const row = createBenchmarkRow({
                            fileSlot,
                            source: src,
                            sizePx,
                            tier: tier.id,
                            phase: 2,
                            effort,
                            decSpeed,
                            modular: -1,
                            brotli: -1,
                            resamp: 1,
                            encMs: _medianOf(encMsVals),
                            decMs: _medianOf(decMsVals),
                            sizeBytes: _medianOf(sizeVals),
                            score: 0,
                            measuredCapabilities: { phase3ValidatedSizes: [] },
                        });

                        if (decSpeed === 0) baselineEncMs = row.encMs;
                        decRows.push(row);
                        sweepRows.push(row);
                        phase2Rows.push(row);

                        await maybeYield();
                        if (sweepAborted) return;
                    }

                    bestDecSpeed[tier.id][fileSlot.id][sizePx] =
                        bestDecSpeedFor(decRows, baselineEncMs ?? decRows[0].encMs);
                }
            }
        }

        for (const tier of activeTiers) {
            computeScores(phase2Rows.filter(r => r.tier === tier.id));
        }
        updatePhaseStatus(2, 'done');
        if (sweepAborted) return;

        // =====================================================================
        // Phase 3: Modular × Brotli (512px only)
        // =====================================================================
        updatePhaseStatus(3, 'active');
        const phase3Rows = [];

        for (const tier of activeTiers) {
            const comboRows = [];

            for (const fileSlot of activeFiles) {
                const src = loadedSources[fileSlot.id];
                const sizePx = 512;
                const { rgba, width, height } = resizeRgba(src, sizePx);
                const effort   = bestEffort[tier.id]?.[fileSlot.id]?.[sizePx] ??
                                 bestEffort[tier.id]?.[fileSlot.id]?.[activeSizes[0]] ?? 4;
                const decSpeed = bestDecSpeed[tier.id]?.[fileSlot.id]?.[sizePx] ??
                                 bestDecSpeed[tier.id]?.[fileSlot.id]?.[activeSizes[0]] ?? 0;

                for (const modular of MODULAR_VALS) {
                    for (const brotli of BROTLI_VALS) {
                        if (sweepAborted) return;
                        updateLiveStatus(`P3 ${tier.label} · ${fileSlot.label} · mod ${modular} brotli ${brotli}`);

                        const encMsVals = [], decMsVals = [], sizeVals = [];
                        for (let run = 0; run < runsPerConfig; run++) {
                            const enc = await encodeOnce(rgba, width, height, {
                                quality: tier.quality,
                                lossless: tier.lossless,
                                effort,
                                decodingSpeed: decSpeed,
                                modular,
                                brotliEffort: brotli,
                                resampling: 1,
                            });
                            const dec = await decodeOnce(enc.jxlBytes);
                            encMsVals.push(enc.encMs);
                            decMsVals.push(dec.decMs);
                            sizeVals.push(enc.jxlBytes.byteLength);
                        }

                        const row = createBenchmarkRow({
                            fileSlot,
                            source: src,
                            sizePx,
                            tier: tier.id,
                            phase: 3,
                            effort,
                            decSpeed,
                            modular,
                            brotli,
                            resamp: 1,
                            encMs: _medianOf(encMsVals),
                            decMs: _medianOf(decMsVals),
                            sizeBytes: _medianOf(sizeVals),
                            score: 0,
                            measuredCapabilities: { phase3ValidatedSizes: [512] },
                        });
                        comboRows.push(row);
                        sweepRows.push(row);
                        phase3Rows.push(row);

                        await maybeYield();
                        if (sweepAborted) return;
                    }
                }
            }

            // Best modular+brotli: minimise encMs (primary), sizeBytes (secondary)
            if (comboRows.length) {
                const best = comboRows.reduce((b, r) => {
                    if (r.encMs < b.encMs) return r;
                    if (r.encMs === b.encMs && r.sizeBytes < b.sizeBytes) return r;
                    return b;
                });
                bestModular[tier.id] = best.modular;
                bestBrotli[tier.id]  = best.brotli;
            }
        }

        for (const tier of activeTiers) {
            computeScores(phase3Rows.filter(r => r.tier === tier.id));
        }
        updatePhaseStatus(3, 'done');
        if (sweepAborted) return;

        // =====================================================================
        // Phase 4: Resampling sweep
        // =====================================================================
        updatePhaseStatus(4, 'active');
        const phase4Rows = [];

        for (const tier of activeTiers) {
            bestResamp[tier.id] ??= {};
            for (const fileSlot of activeFiles) {
                bestResamp[tier.id][fileSlot.id] ??= {};
                const src = loadedSources[fileSlot.id];
                for (const sizePx of activeSizes) {
                    const { rgba, width, height } = resizeRgba(src, sizePx);
                    const effort   = bestEffort[tier.id]?.[fileSlot.id]?.[sizePx] ?? 4;
                    const decSpeed = bestDecSpeed[tier.id]?.[fileSlot.id]?.[sizePx] ?? 0;
                    const modular  = bestModular[tier.id] ?? -1;
                    const brotli   = bestBrotli[tier.id]  ?? -1;
                    const resampRows = [];

                    for (const resamp of RESAMP_VALS) {
                        if (sweepAborted) return;
                        updateLiveStatus(`P4 ${tier.label} · ${fileSlot.label} · ${sizePx}px · resamp ${resamp}`);

                        const encMsVals = [], decMsVals = [], sizeVals = [];
                        for (let run = 0; run < runsPerConfig; run++) {
                            const enc = await encodeOnce(rgba, width, height, {
                                quality: tier.quality,
                                lossless: tier.lossless,
                                effort,
                                decodingSpeed: decSpeed,
                                modular,
                                brotliEffort: brotli,
                                resampling: resamp,
                            });
                            const dec = await decodeOnce(enc.jxlBytes);
                            encMsVals.push(enc.encMs);
                            decMsVals.push(dec.decMs);
                            sizeVals.push(enc.jxlBytes.byteLength);
                        }

                        const row = createBenchmarkRow({
                            fileSlot,
                            source: src,
                            sizePx,
                            tier: tier.id,
                            phase: 4,
                            effort,
                            decSpeed,
                            modular,
                            brotli,
                            resamp,
                            encMs: _medianOf(encMsVals),
                            decMs: _medianOf(decMsVals),
                            sizeBytes: _medianOf(sizeVals),
                            score: 0,
                            measuredCapabilities: { phase3ValidatedSizes: [] },
                        });
                        resampRows.push(row);
                        sweepRows.push(row);
                        phase4Rows.push(row);

                        await maybeYield();
                        if (sweepAborted) return;
                    }

                    // Best resampling: minimum sizeBytes
                    if (resampRows.length) {
                        bestResamp[tier.id][fileSlot.id][sizePx] =
                            resampRows.reduce((b, r) => r.sizeBytes < b.sizeBytes ? r : b).resamp;
                    }
                }
            }
        }

        for (const tier of activeTiers) {
            computeScores(phase4Rows.filter(r => r.tier === tier.id));
        }
        updatePhaseStatus(4, 'done');

    } finally {
        sweepRunning = false;
        if (!sweepAborted) updatePhaseStatus(null, null); // all phases done
    }
    return { aborted: sweepAborted, rows: [...sweepRows] };
}

export function abortSweep() {
    if (sweepRunning) sweepAborted = true;
}

// =============================================================================
// Chart.js graphs — Task 7
// =============================================================================

const SIZE_COLORS = ['#4ade80', '#60a5fa', '#f97316', '#a78bfa'];

// { p1a, p1b, p2, p3 } — Chart instances
let charts = {};

/**
 * Average rows matching sizePx and a single parameter value, returning the
 * given metric. Returns null when no matching rows exist.
 * @param {object[]} rows
 * @param {number|string} sizePx
 * @param {number|string} paramVal  value of paramKey to filter on
 * @param {string} paramKey         row property name (e.g. 'effort', 'decSpeed')
 * @param {string} metric           row property to average ('encMs'|'decMs'|'sizeBytes')
 * @returns {number|null}
 */
function avgFor(rows, sizePx, paramVal, paramKey, metric) {
    const matching = rows.filter(r => r.sizePx === sizePx && r[paramKey] === paramVal);
    if (!matching.length) return null;
    return matching.reduce((s, r) => s + r[metric], 0) / matching.length;
}

/**
 * Find the knee-point effort for a given sizePx within phase-1 rows.
 * Returns the effort value, or null if there are no rows.
 */
function kneeEffortFor(rows, sizePx) {
    const effortRows = EFFORTS
        .map(e => {
            const matching = rows.filter(r => r.sizePx === sizePx && r.effort === e);
            if (!matching.length) return null;
            const avgSize = matching.reduce((s, r) => s + r.sizeBytes, 0) / matching.length;
            const avgTime = matching.reduce((s, r) => s + r.encMs,    0) / matching.length;
            return { effort: e, avgSize, avgTime };
        })
        .filter(Boolean);

    if (!effortRows.length) return null;

    for (let i = 1; i < effortRows.length; i++) {
        const sizeReduction = (effortRows[i - 1].avgSize - effortRows[i].avgSize) / effortRows[i - 1].avgSize;
        const timeCost      = (effortRows[i].avgTime - effortRows[i - 1].avgTime) / effortRows[i - 1].avgTime;
        if (timeCost > 3 * sizeReduction) return effortRows[i - 1].effort;
    }
    // No knee — return effort with minimum size
    return effortRows.reduce((best, r) => r.avgSize < best.avgSize ? r : best).effort;
}

/** Inject the four canvas cards into #phase-graphs-body (idempotent). */
function buildGraphsSection() {
    const body = document.getElementById('phase-graphs-body');
    if (!body) return;
    body.innerHTML = `
        <div id="graph-format-bar" style="margin-bottom:6px;font-size:8px;display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
            <span style="opacity:0.6;">Formats:</span>
            <button type="button" class="fmt-btn" data-fmt="all" style="padding:0 4px;font-size:8px;">All</button>
        </div>
        <div class="graph-grid">
            <div class="graph-card">
                <h3>Phase 1a — Encode time vs Effort</h3>
                <canvas id="chart-p1a"></canvas>
            </div>
            <div class="graph-card">
                <h3>Phase 1b — File size vs Effort</h3>
                <canvas id="chart-p1b"></canvas>
            </div>
            <div class="graph-card">
                <h3>Phase 2 — Decode time vs Decode speed tier</h3>
                <canvas id="chart-p2"></canvas>
            </div>
            <div class="graph-card">
                <h3>Phase 3 — Modular × Brotli</h3>
                <canvas id="chart-p3"></canvas>
            </div>
        </div>
    `;
    // Wire format buttons (dynamic ones added in refreshGraphFormatBar)
    const bar = body.querySelector('#graph-format-bar');
    if (bar) {
        bar.addEventListener('click', (e) => {
            const btn = e.target.closest('.fmt-btn');
            if (!btn) return;
            selectedGraphFormat = btn.dataset.fmt || 'all';
            refreshGraphFormatBar();
            refreshGraphsWithFilter();
        });
    }
}

/** Render (or re-render) Phase 1a and 1b charts from phase-1 sweep rows. */
export function renderPhase1Charts(rows) {
    // Apply current format filter (so graphs differentiate / switch on file formats)
    let filtered = rows;
    if (selectedGraphFormat && selectedGraphFormat !== 'all') {
        filtered = rows.filter(r => r.file === selectedGraphFormat);
    }
    const sizes = SIZES;
    const presentEfforts = [...new Set(filtered.map(r => r.effort))].sort((a,b)=>a-b);
    const xLabels = presentEfforts.length ? presentEfforts : EFFORTS;

    // --- Phase 1a: Encode ms vs Effort ---
    if (charts.p1a) { charts.p1a.destroy(); charts.p1a = null; }
    const canvas1a = document.getElementById('chart-p1a');
    if (canvas1a) {
        charts.p1a = new Chart(canvas1a, {
            type: 'line',
            data: {
                labels: xLabels,
                datasets: sizes.map((sz, i) => ({
                    label: sz === 'full' ? 'Full' : `${sz}px`,
                    data: xLabels.map(e => avgFor(filtered, sz, e, 'effort', 'encMs')),
                    borderColor: SIZE_COLORS[i],
                    backgroundColor: SIZE_COLORS[i] + '22',
                    tension: 0.3,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                })),
            },
            options: {
                responsive: true,
                plugins: { legend: { position: 'bottom' } },
                scales: {
                    x: { title: { display: true, text: 'Effort' } },
                    y: { title: { display: true, text: 'Encode ms' }, beginAtZero: true },
                },
            },
        });
    }

    // --- Phase 1b: File size (KB) vs Effort, with knee-point scatter ---
    if (charts.p1b) { charts.p1b.destroy(); charts.p1b = null; }
    const canvas1b = document.getElementById('chart-p1b');
    if (canvas1b) {
        const lineDatasets = sizes.map((sz, i) => ({
            label: sz === 'full' ? 'Full' : `${sz}px`,
            data: xLabels.map(e => {
                const bytes = avgFor(filtered, sz, e, 'effort', 'sizeBytes');
                return bytes !== null ? bytes / 1024 : null;
            }),
            borderColor: SIZE_COLORS[i],
            backgroundColor: SIZE_COLORS[i] + '22',
            tension: 0.3,
            pointRadius: 4,
            pointHoverRadius: 6,
            type: 'line',
        }));

        // One scatter dataset per size to mark the knee effort
        const kneeDatasets = sizes.map((sz, i) => {
            const kneeEffort = kneeEffortFor(filtered, sz);
            if (kneeEffort === null) return null;
            const bytes = avgFor(filtered, sz, kneeEffort, 'effort', 'sizeBytes');
            const sizeKB = bytes !== null ? bytes / 1024 : null;
            return {
                label: `Knee ${sz === 'full' ? 'Full' : sz + 'px'}`,
                data: sizeKB !== null ? [{ x: kneeEffort, y: sizeKB }] : [],
                type: 'scatter',
                borderColor: SIZE_COLORS[i],
                backgroundColor: SIZE_COLORS[i],
                pointStyle: 'rectRot',
                pointRadius: 8,
                showLine: false,
            };
        }).filter(Boolean);

        charts.p1b = new Chart(canvas1b, {
            type: 'line',
            data: {
                labels: xLabels,
                datasets: [...lineDatasets, ...kneeDatasets],
            },
            options: {
                responsive: true,
                plugins: { legend: { position: 'bottom' } },
                scales: {
                    x: { title: { display: true, text: 'Effort' } },
                    y: { title: { display: true, text: 'Size KB' }, beginAtZero: true },
                },
            },
        });
    }
}

/** Render (or re-render) Phase 2 chart from phase-2 sweep rows. */
export function renderPhase2Chart(rows) {
    let filtered = rows;
    if (selectedGraphFormat && selectedGraphFormat !== 'all') {
        filtered = rows.filter(r => r.file === selectedGraphFormat);
    }
    if (charts.p2) { charts.p2.destroy(); charts.p2 = null; }
    const canvas = document.getElementById('chart-p2');
    if (!canvas) return;

    const sizes = SIZES;
    charts.p2 = new Chart(canvas, {
        type: 'line',
        data: {
            labels: DEC_SPEEDS,
            datasets: sizes.map((sz, i) => ({
                label: sz === 'full' ? 'Full' : `${sz}px`,
                data: DEC_SPEEDS.map(ds => avgFor(filtered, sz, ds, 'decSpeed', 'decMs')),
                borderColor: SIZE_COLORS[i],
                backgroundColor: SIZE_COLORS[i] + '22',
                tension: 0.3,
                pointRadius: 4,
                pointHoverRadius: 6,
            })),
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'bottom' } },
            scales: {
                x: { title: { display: true, text: 'Decode speed tier' } },
                y: { title: { display: true, text: 'Decode ms' }, beginAtZero: true },
            },
        },
    });
}

/** Render (or re-render) Phase 3 chart from phase-3 sweep rows. */
export function renderPhase3Chart(rows) {
    let filtered = rows;
    if (selectedGraphFormat && selectedGraphFormat !== 'all') {
        filtered = rows.filter(r => r.file === selectedGraphFormat);
    }
    if (charts.p3) { charts.p3.destroy(); charts.p3 = null; }
    const canvas = document.getElementById('chart-p3');
    if (!canvas) return;

    const modularLabels = { '-1': 'Auto', '0': 'VarDCT', '1': 'Modular' };

    // Build combo labels and one dataset per modular mode
    const combos = [];
    for (const modular of MODULAR_VALS) {
        for (const brotli of BROTLI_VALS) {
            combos.push({ modular, brotli, label: `${modularLabels[modular]}/${brotli}` });
        }
    }
    const comboLabels = combos.map(c => c.label);

    const datasets = MODULAR_VALS.map((modular, i) => {
        const data = BROTLI_VALS.map(brotli => {
            const matching = filtered.filter(r => r.modular === modular && r.brotli === brotli);
            if (!matching.length) return null;
            return matching.reduce((s, r) => s + r.encMs, 0) / matching.length;
        });
        return {
            label: modularLabels[modular],
            data,
            backgroundColor: SIZE_COLORS[i] + 'aa',
            borderColor: SIZE_COLORS[i],
            borderWidth: 1,
        };
    });

    // X axis labels are brotli values; group by modular using separate datasets
    charts.p3 = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: comboLabels,
            datasets,
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'bottom' } },
            scales: {
                x: { title: { display: true, text: 'Modular mode / Brotli effort' } },
                y: { title: { display: true, text: 'Encode ms' }, beginAtZero: true },
            },
        },
    });
}

// =============================================================================
// Sweep settings UI — Task 9
// =============================================================================

function buildSweepSettings() {
    const body = document.getElementById('sweep-settings-body');
    if (!body) return;
    body.innerHTML = `
        <div class="sweep-controls">
            <div class="control-group">
                <span>Sizes:</span>
                <div class="chip-group">
                    ${[128, 512, 1920, 'full'].map(sz => `
                        <label class="chip-label"><input type="checkbox" name="sweep-size" value="${sz}" checked /> <span>${sz === 'full' ? 'Full' : sz}</span></label>`).join('')}
                </div>
            </div>
            <div class="control-group">
                <span>Effort:</span>
                <div class="chip-group">
                    ${[1,2,3,4,5,6].map(e => `
                        <label class="chip-label"><input type="checkbox" name="sweep-effort" value="${e}" checked /> <span>${e}</span></label>`).join('')}
                </div>
            </div>
            <div class="control-group">
                <span>Tiers:</span>
                <div class="chip-group">
                    ${['low','medium','high','lossless'].map(t => `
                        <label class="chip-label"><input type="checkbox" name="sweep-tier" value="${t}" checked /> <span>${t}</span></label>`).join('')}
                </div>
            </div>
            <div class="control-group">
                <span>Scenarios:</span>
                <div class="chip-group" id="scenario-chips">
                    <label class="chip-label"><input type="checkbox" name="scenario" value="thumb" checked /> <span>Thumb</span></label>
                    <label class="chip-label"><input type="checkbox" name="scenario" value="medium" checked /> <span>Med</span></label>
                    <label class="chip-label"><input type="checkbox" name="scenario" value="fullpage" checked /> <span>FullPg</span></label>
                    <label class="chip-label"><input type="checkbox" name="scenario" value="fullres" /> <span>FullRes</span></label>
                    <label class="chip-label"><input type="checkbox" name="scenario" value="massive" /> <span>80M</span></label>
                    <label class="chip-label"><input type="checkbox" name="scenario" value="gallery" checked /> <span>Gallery</span></label>
                </div>
            </div>
            <div class="control-group">
                <span>Runs:</span>
                <div class="spinpicker">
                    <button class="spin-btn" type="button" id="runs-dec">−</button>
                    <input id="input-runs" type="number" min="1" max="5" step="1" value="3" style="width:36px;text-align:center;" />
                    <button class="spin-btn" type="button" id="runs-inc">+</button>
                </div>
            </div>
            <div class="control-group actions-row" style="margin-top:8px; display:flex;gap:4px;align-items:center;flex-wrap:wrap">
                <button id="btn-run-sweep" class="btn-primary" type="button">Run</button>
                <button id="btn-stop" class="btn-danger" type="button" disabled>Stop</button>
                <button id="btn-load-saved" class="btn-secondary" type="button">Load IDB</button>
                <label class="btn-secondary" style="cursor:pointer;" title="Load exported preset-benchmark JSON (portable historical run)">Load file
                    <input id="load-export-json" type="file" accept=".json" hidden />
                </label>
                <span style="color:#94a3b8; margin:0 4px; font-size:12px;">Export:</span>
                <button id="export-csv-btn" class="btn-secondary" type="button" disabled title="Export sweep + rich meta/RAW flag as CSV (includes # meta block)">CSV</button>
                <button id="export-json-btn" class="btn-secondary" type="button" disabled title="Export sweep results + rich meta (files, selected, rawIsolation) as JSON">JSON</button>
                <button id="export-toon-btn" class="btn-secondary" type="button" disabled title="Export as TOON (compact human-readable tables + meta)">TOON</button>
                <button id="clear-measurements-btn" class="dbg-bar-action" type="button" disabled title="Clear sweep results, preset cards, and graphs (files + RAW isolation preserved)">Clear</button>
                <button id="export-recs-btn" class="btn-secondary" type="button" disabled title="Persist citable preset recommendations JSON (best-per-tier + scenario scores + RAW costs + provenance) for docs/outputs + Tauri cross-link">Recs</button>
                <button id="btn-log" class="btn-secondary" type="button">Log</button>
                <button id="btn-console-bar" class="btn-secondary" type="button">Console</button>
            </div>
        </div>
        <div id="settings-console-container" style="margin-top:12px; border-top: 1px solid var(--border); padding-top: 8px;"></div>
    `;
    document.getElementById('runs-dec').addEventListener('click', () => {
        const inp = document.getElementById('input-runs');
        inp.value = Math.max(1, Number(inp.value) - 1);
    });
    document.getElementById('runs-inc').addEventListener('click', () => {
        const inp = document.getElementById('input-runs');
        inp.value = Math.min(5, Number(inp.value) + 1);
    });

    // Make Run button state reactive to checkbox changes
    const settingsBody = document.getElementById('sweep-settings-body');
    if (settingsBody) {
        settingsBody.addEventListener('change', (e) => {
            if (e.target.name === 'sweep-size' || e.target.name === 'sweep-tier' || e.target.name === 'scenario' || e.target.name === 'sweep-effort') {
                updateButtonStates();
                // Live preview of effort x size in phase card (reflects selection immediately)
                if (e.target.name === 'sweep-size' || e.target.name === 'sweep-effort') {
                    const szs = [...document.querySelectorAll('input[name="sweep-size"]:checked')].map(el => el.value);
                    const efs = [...document.querySelectorAll('input[name="sweep-effort"]:checked')].map(el => el.value);
                    const p1 = document.getElementById('phase-card-1');
                    const sub = p1 && p1.querySelector('.phase-sub');
                    if (sub) sub.textContent = `Effort (${efs.length || 6} vals) × ${szs.length} sizes`;
                }
            }
        });
    }
}

// =============================================================================
// Phase progress UI — Task 9
// =============================================================================

function buildPhaseProgress() {
    const cards = document.getElementById('phase-cards');
    if (!cards) return;
    const phases = [
        'Effort (selected) × N sizes',
        'Decode speed 0–4 × 4 sizes',
        'Modular + Brotli',
        'Resampling × 4 sizes',
    ];
    cards.innerHTML = '';
    for (let i = 0; i < phases.length; i++) {
        const card = document.createElement('div');
        card.className = 'phase-card';
        card.id = `phase-card-${i + 1}`;
        card.dataset.status = 'pending';
        card.innerHTML = `
            <div class="phase-label">PHASE ${i + 1} <span class="phase-icon">⋯</span></div>
            <div class="phase-sub">${phases[i]}</div>
            <div class="phase-bar"><div class="phase-bar-fill" style="width:0%"></div></div>
        `;
        cards.appendChild(card);
    }

    const ticker = document.getElementById('live-status');
    if (ticker) {
        ticker.innerHTML = `
            <div class="live-status-header">
                <span>Live status</span>
                <span id="elapsed-label">—</span>
            </div>
            <div id="live-current" class="live-line live-active">Idle</div>
        `;
    }
}

// =============================================================================
// Button wiring — Task 9
// =============================================================================

function wireButtons() {
    // Debug console button is now initialized via initDebugConsole() above.
    // The click handler is automatically wired by initDebugConsole.

    document.getElementById('btn-run-sweep')?.addEventListener('click', async () => {
        const sizes = [...document.querySelectorAll('input[name="sweep-size"]:checked')].map(el => {
            const v = el.value; return v === 'full' ? 'full' : Number(v);
        });
        const tiers = [...document.querySelectorAll('input[name="sweep-tier"]:checked')].map(el => el.value);
        const efforts = [...document.querySelectorAll('input[name="sweep-effort"]:checked')].map(el => Number(el.value));
        const scenarios = [...document.querySelectorAll('input[name="scenario"]:checked')].map(el => el.value);
        const runsPerConfig = Math.max(1, Number(document.getElementById('input-runs')?.value ?? 3));
        if (!sizes.length || !tiers.length) {
            alert('Select at least one size and one tier.');
            return;
        }
        if (!scenarios.length) {
            // default to all if none explicitly checked (back-compat)
            scenarios.push(...Object.keys(SCENARIO_PROFILES));
        }

        // Reflect actual selection in phase card (fixes "1-6 x 4 sizes" when subset chosen)
        const phase1Card = document.getElementById('phase-card-1');
        if (phase1Card) {
            const sub = phase1Card.querySelector('.phase-sub');
            if (sub) sub.textContent = `Effort (${efforts.length || 6} vals) × ${sizes.length} sizes`;
        }

        const btnRun  = document.getElementById('btn-run-sweep');
        const btnStop = document.getElementById('btn-stop');
        btnRun.disabled  = true;
        btnStop.disabled = false;

        try {
            const result = await runSweep({ tiers, sizes, efforts, scenarios, runsPerConfig });
            if (!shouldPublishSweepArtifacts(result)) {
                dbgLog('Sweep aborted', 'partial rows kept in memory; skipping tables/recommendations/export');
                updateButtonStates();
                return;
            }
        } finally {
            btnRun.disabled  = false;
            btnStop.disabled = true;
        }

        buildResultsTable(sweepRows);
        const presets = derivePresets(sweepRows);
        buildPresetCards(presets);
        saveResults(sweepRows, presets);
        // New: scenario-driven recommendations + diagnostics (core deliverable)
        buildScenarioRecommendations(sweepRows, scenarios);
        updateButtonStates(); // Enable Export CSV etc.

        // Graphs with format differentiation (also populates format buttons so file formats are recognised)
        selectedGraphFormat = 'all';
        refreshGraphFormatBar();
        refreshGraphsWithFilter();
    });

    // Console button in the controls bar delegates to the hero panel toggle
    document.getElementById('btn-console-bar')?.addEventListener('click', () => {
        document.getElementById('dbg-console-btn')?.click();
    });

    document.getElementById('btn-stop')?.addEventListener('click', () => {
        abortSweep();
        const stopBtn = document.getElementById('btn-stop');
        const runBtn = document.getElementById('btn-run-sweep');
        if (stopBtn) stopBtn.disabled = true;
        if (runBtn) runBtn.disabled = false;
    });

    document.getElementById('btn-load-saved')?.addEventListener('click', () => {
        const saved = loadSavedResults();
        if (!saved) { alert('No saved results found in localStorage.'); return; }
        sweepRows.length = 0;
        sweepRows.push(...saved.rows);
        buildResultsTable(sweepRows);
        buildPresetCards(saved.presets ?? derivePresets(sweepRows));
        selectedGraphFormat = 'all';
        refreshGraphFormatBar();
        refreshGraphsWithFilter();
        updateButtonStates();
    });

    // New: load any exported {meta, rows} JSON file (portable across sessions/machines)
    const loadJsonInput = document.getElementById('load-export-json');
    if (loadJsonInput) {
        loadJsonInput.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                const rows = Array.isArray(data?.rows) ? data.rows : (Array.isArray(data) ? data : null);
                if (!rows || !rows.length) {
                    alert('JSON did not contain a usable "rows" array (expected exported preset-benchmark shape).');
                    return;
                }
                sweepRows.length = 0;
                sweepRows.push(...rows);
                buildResultsTable(sweepRows);
                // Try to derive presets from loaded rows (best effort)
                const presets = (typeof derivePresets === 'function') ? derivePresets(sweepRows) : null;
                buildPresetCards(presets || []);
                selectedGraphFormat = 'all';
                if (typeof refreshGraphFormatBar === 'function') refreshGraphFormatBar();
                if (typeof refreshGraphsWithFilter === 'function') refreshGraphsWithFilter();
                updateButtonStates();
                dbgLog('Loaded external JSON run', `${rows.length} rows from ${file.name}`);
            } catch (err) {
                console.error(err);
                alert('Failed to load/parse JSON: ' + err.message);
            } finally {
                e.target.value = ''; // allow re-select same file
            }
        });
    }

    // Unified explicit export buttons (CSV uses rich exportCsv with per-row RAW; JSON/TOON wire the improved buildExportText+Meta with provenance)
    document.getElementById('export-csv-btn')?.addEventListener('click', () => {
        if (!sweepRows.length) { alert('No results to export. Run a sweep first.'); return; }
        exportCsv(sweepRows);
        dbgLog('Exported CSV', `${sweepRows.length} rows (rich RAW columns)`);
    });

    document.getElementById('export-json-btn')?.addEventListener('click', () => {
        if (!sweepRows.length) return;
        const text = buildExportText(sweepRows, 'json');
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `preset-benchmark-${ts}.json`; a.click();
        URL.revokeObjectURL(url);
        dbgLog('Exported JSON', `${sweepRows.length} rows + rich meta (buildExportMeta)`);
    });

    document.getElementById('export-toon-btn')?.addEventListener('click', () => {
        if (!sweepRows.length) return;
        const text = buildExportText(sweepRows, 'toon');
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `preset-benchmark-${ts}.toon`; a.click();
        URL.revokeObjectURL(url);
        dbgLog('Exported TOON', `${sweepRows.length} rows + rich meta (buildExportMeta)`);
    });

    document.getElementById('clear-measurements-btn')?.addEventListener('click', () => {
        clearSweepResults();
    });

    // P2: minimal citable artifact emission (addresses Owl gap + IA principle #4)
    document.getElementById('export-recs-btn')?.addEventListener('click', async () => {
        if (!sweepRows.length) return;
        const artifact = buildPresetRecommendationsArtifact();
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const fname = `preset-recommendations-${ts}.json`;
        await saveTextWithPicker(fname, JSON.stringify(artifact, null, 2), 'application/json');
        dbgLog('Persisted preset recommendations artifact', `for cross-suite use (Tauri thumb-pyramid / docs/outputs/preset-benchmark/)`);
    });
}

// Build the graph section DOM immediately on module init so canvases exist.
buildGraphsSection();

// Initial button state check (in case of restored state or fast loads)
setTimeout(updateButtonStates, 300);

// =============================================================================
// Results table — Task 8
// =============================================================================

let sortCol = 'score';
let sortDir = 'desc';

const MODULAR_LABELS = { '-1': 'Auto', '0': 'VarDCT', '1': 'Modular' };

const TABLE_COLS = [
    { key: 'file',      label: 'File'    },
    { key: 'sizePx',    label: 'Size'    },
    { key: 'tier',      label: 'Tier'    },
    { key: 'phase',     label: 'Phase'   },
    { key: 'effort',    label: 'Effort'  },
    { key: 'decSpeed',  label: 'DecSpd'  },
    { key: 'modular',   label: 'Modular' },
    { key: 'brotli',    label: 'Brotli'  },
    { key: 'resamp',    label: 'Resamp'  },
    { key: 'encMs',     label: 'Enc ms'  },
    { key: 'decMs',     label: 'Dec ms'  },
    { key: 'sizeBytes', label: 'KB'      },
    { key: 'score',     label: 'Score'   },
];

/** Compute best-row set: for each (file, tier, sizePx) group, the row with the highest score. */
function computeBestRows(rows) {
    const best = new Map();
    for (const r of rows) {
        const k = `${r.file}|${r.tier}|${r.sizePx}`;
        const prev = best.get(k);
        if (!prev || r.score > prev.score) best.set(k, r);
    }
    return new Set(best.values());
}

/** Format a cell value for display. */
function fmtCell(col, row) {
    switch (col.key) {
        case 'sizePx':    return row.sizePx === 'full' ? 'Full' : row.sizePx + 'px';
        case 'sizeBytes': return (row.sizeBytes / 1024).toFixed(1);
        case 'encMs':     return row.encMs.toFixed(1);
        case 'decMs':     return row.decMs.toFixed(1);
        case 'modular':   return MODULAR_LABELS[String(row.modular)] ?? row.modular;
        default:          return row[col.key];
    }
}

/** Inject or update the results table inside #results-table. */
export function buildResultsTable(rows) {
    const section = document.getElementById('results-table');
    if (!section) return;

    // Persist to localStorage whenever called
    try {
        localStorage.setItem(LS_KEY, JSON.stringify({
            timestamp: Date.now(),
            rows,
            presets: null, // presets written separately by saveResults
        }));
    } catch (e) {
        console.warn('[preset-bench] localStorage write failed in buildResultsTable:', e);
    }

    const bestSet = computeBestRows(rows);

    // Sort rows
    const sorted = [...rows].sort((a, b) => {
        const av = a[sortCol];
        const bv = b[sortCol];
        if (av < bv) return sortDir === 'asc' ? -1 : 1;
        if (av > bv) return sortDir === 'asc' ? 1 : -1;
        return 0;
    });

    // Build or reuse table element
    let table = section.querySelector('table.results-table');
    if (!table) {
        table = document.createElement('table');
        table.className = 'results-table';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        for (const col of TABLE_COLS) {
            const th = document.createElement('th');
            th.dataset.col = col.key;
            th.textContent = col.label + (col.key === sortCol ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
            th.style.cursor = 'pointer';
            th.addEventListener('click', () => {
                if (sortCol === col.key) {
                    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    sortCol = col.key;
                    sortDir = 'asc';
                }
                buildResultsTable(rows);
            });
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);
        table.appendChild(document.createElement('tbody'));
        section.innerHTML = '';
        section.appendChild(table);
    } else {
        // Update header sort indicators
        for (const th of table.querySelectorAll('thead th')) {
            const col = TABLE_COLS.find(c => c.key === th.dataset.col);
            if (!col) continue;
            th.textContent = col.label + (col.key === sortCol ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
        }
    }

    // Rebuild tbody
    const tbody = table.querySelector('tbody');
    tbody.innerHTML = '';
    for (const row of sorted) {
        const tr = document.createElement('tr');
        const isBest = bestSet.has(row);
        if (isBest) tr.classList.add('best-row');

        for (const col of TABLE_COLS) {
            const td = document.createElement('td');
            let text = fmtCell(col, row);
            if (col.key === 'score' && isBest) text = '★ ' + text;
            td.textContent = text;
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
}

// =============================================================================
// Preset derivation — Task 8
// =============================================================================

function mode(arr) {
    if (!arr.length) return undefined;
    const counts = {};
    for (const v of arr) counts[v] = (counts[v] || 0) + 1;
    return Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
}

function avg(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export function derivePresets(rows) {
    return TIERS.map(tier => {
        const tierRows = rows.filter(r => r.tier === tier.id);
        if (!tierRows.length) return null;

        const effort = mode(tierRows.filter(r => r.phase === 1).map(r => r.effort));
        const decodingSpeed = mode(tierRows.filter(r => r.phase === 2).map(r => r.decSpeed));
        const p3Best = tierRows
            .filter(r => r.phase === 3)
            .sort((a, b) => b.score - a.score)[0];
        const modular = p3Best?.modular ?? -1;
        const brotliEffort = p3Best?.brotli ?? -1;
        const resampling = mode(tierRows.filter(r => r.phase === 4).map(r => r.resamp));

        const benchStats = {};
        for (const sz of SIZES) {
            const szRows = tierRows.filter(r => r.sizePx === sz);
            if (!szRows.length) continue;
            const key = sz === 'full' ? 'full' : `${sz}px`;
            benchStats[key] = {
                avgEncMs: Math.round(avg(szRows.map(r => r.encMs))),
                avgDecMs: Math.round(avg(szRows.map(r => r.decMs))),
                avgSizeKb: Math.round(avg(szRows.map(r => r.sizeBytes)) / 1024),
            };
        }

        return {
            tier: tier.id,
            quality: tier.quality,
            lossless: tier.lossless,
            effort,
            decodingSpeed,
            modular,
            brotliEffort,
            resampling,
            benchStats,
        };
    }).filter(Boolean);
}

// =============================================================================
// Preset cards UI — Task 8
// =============================================================================

const TIER_COLORS = { low: '#f87171', medium: '#fbbf24', high: '#4ade80', lossless: '#818cf8' };

function buildPresetCard(preset) {
    const color = TIER_COLORS[preset.tier] || '#94a3b8';
    const card = document.createElement('div');
    card.className = 'preset-card';
    card.style.setProperty('--preset-color', color);

    const params = [
        `quality: ${preset.quality}`,
        `lossless: ${preset.lossless}`,
        `effort: ${preset.effort}`,
        `decodingSpeed: ${preset.decodingSpeed}`,
        `modular: ${preset.modular}`,
        `brotliEffort: ${preset.brotliEffort}`,
        `resampling: ${preset.resampling}`,
    ].join('<br>');

    const s128  = preset.benchStats['128px'];
    const s1920 = preset.benchStats['1920px'];
    const timingHtml = [
        s128  ? `128px  enc ${s128.avgEncMs}ms / dec ${s128.avgDecMs}ms`  : '',
        s1920 ? `1920px enc ${s1920.avgEncMs}ms / dec ${s1920.avgDecMs}ms` : '',
    ].filter(Boolean).join('<br>');

    card.innerHTML = `
        <div class="preset-card-title">${preset.tier.toUpperCase()}</div>
        <div class="preset-card-params">${params}</div>
        <div class="preset-card-timing">${timingHtml}</div>
        <button class="copy-json-btn" type="button">Copy JSON</button>
    `;

    card.querySelector('.copy-json-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(JSON.stringify(preset, null, 2));
    });

    return card;
}

export function buildPresetCards(presets) {
    const section = document.getElementById('preset-cards');
    if (!section) return;
    const grid = document.createElement('div');
    grid.className = 'preset-cards-grid';
    for (const preset of presets) {
        grid.appendChild(buildPresetCard(preset));
    }
    section.innerHTML = '';
    section.appendChild(grid);
}

// =============================================================================
// Scenario Recommendations + Diagnostic Suite (NEW core feature)
// =============================================================================

function scoreRowForScenario(row, scenario) {
    const prof = SCENARIO_PROFILES[scenario];
    if (!prof) return row.score || 0;
    const w = prof.weights;

    const relevant = sweepRows.filter(r => prof.sizes.some(sz => (sz === 'full' ? r.sizePx === 'full' : r.sizePx === sz)));
    if (!relevant.length) return row.score || 0;

    const minSize = Math.min(...relevant.map(r => r.sizeBytes));
    const minEnc  = Math.min(...relevant.map(r => r.encMs));
    const minDec  = Math.min(...relevant.map(r => r.decMs));

    const sizeEff  = minSize / Math.max(1, row.sizeBytes);
    const encSpeed = minEnc  / Math.max(1, row.encMs);
    const decSpeed = minDec  / Math.max(1, row.decMs);

    let composite = (sizeEff * (w.size || 0)) + (encSpeed * (w.encSpeed || 0)) + (decSpeed * (w.decSpeed || 0));

    // RAW cost integration (from the new isolation surface)
    if (w.rawCost && rawIsolationData) {
        // Improved matching: try exact name match first, then contains
        const match = findRawIsolationMatch(rawIsolationData, row);
        const rawCost = match ? (match.rawCostForScoring?.thumb || match.rawCostForScoring?.full || 0) : 0;
        if (rawCost > 0) {
            const maxRaw = Math.max(...Object.values(rawIsolationData).map(d => d.rawCostForScoring?.full || d.rawCostForScoring?.thumb || 1));
            const rawEff = maxRaw / Math.max(1, rawCost);
            composite += rawEff * (w.rawCost || 0);
        }
    }

    // Special bonuses
    if (scenario === 'massive' && (row.lowMemoryMode || row.resamp > 1)) composite += 15;
    if (scenario === 'gallery' && row.decSpeed >= 2) composite += 10;

    return Math.round(composite * 100);
}

export function buildScenarioRecommendations(rows, selectedScenarios) {
    const container = document.getElementById('preset-cards'); // reuse area or we could add a new section
    if (!container) return;

    // Create or replace a dedicated scenario recommendations block
    let diag = document.getElementById('scenario-diagnostics');
    if (!diag) {
        diag = document.createElement('section');
        diag.id = 'scenario-diagnostics';
        diag.style.marginTop = '24px';
        container.parentNode.insertBefore(diag, container.nextSibling);
    }

    const scenariosToShow = selectedScenarios.length ? selectedScenarios : Object.keys(SCENARIO_PROFILES);

    let html = `<div style="font-size:8px;opacity:0.55;margin:1px 0 4px;">Scores include RAW cost where relevant. JSON = copy preset.</div>
        <div class="scenario-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:3px;">`;

    for (const scenId of scenariosToShow) {
        const prof = SCENARIO_PROFILES[scenId];
        if (!prof) continue;

        const candidates = rows.filter(r => prof.sizes.some(s => (s === 'full' ? r.sizePx === 'full' : r.sizePx === s)));
        if (!candidates.length) continue;

        const scored = candidates.map(r => ({ r, s: scoreRowForScenario(r, scenId) }));
        scored.sort((a, b) => b.s - a.s);
        const best = pickScenarioWinner(scored);

        let rawInfo = '';
        if (rawIsolationData) {
            const rawVals = Object.values(rawIsolationData).map(d => d.rawCostForScoring).filter(Boolean);
            if (rawVals.length) {
                const avgFull = rawVals.reduce((s, r) => s + (r.full || 0), 0) / rawVals.length;
                rawInfo = ` RAW:${avgFull.toFixed(0)}`;
            }
        }

        html += `
            <div style="border:1px solid #333; border-radius:1px; padding:1px 3px; background:#111; font-size:7.5px; line-height:1.05;">
                <strong style="color:#fde047;">${prof.label}</strong> e=${best.effort} ds=${best.decSpeed} m=${best.modular} b=${best.brotli} r=${best.resamp} | ${best.tier}@${best.sizePx} sc=${scored[0].s}${rawInfo}
                <button class="copy-scenario-btn" data-scenario='${scenId}' style="font-size:6.5px;padding:0 1px;margin-left:2px;">JSON</button>
            </div>`;
    }

    html += `</div>
        <div style="margin-top:8px;font-size:10px;opacity:0.6;">
            Tip: Combine with jxl-crop-benchmark.html for real 80MP ROI numbers and jxl-wrapper-lab.html for the full advanced filter / HDR / granular-EC controls not yet in the sweep matrix.
        </div>`;

    diag.innerHTML = html;

    // Wire copy buttons
    diag.querySelectorAll('.copy-scenario-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const scen = btn.dataset.scenario;
            const prof = SCENARIO_PROFILES[scen];
            const scoredRows = rows
                .filter(r => prof.sizes.some(s => r.sizePx === s))
                .map(r => ({ row: r, score: scoreRowForScenario(r, scen) }));
            const bestForScen = pickScenarioWinner(scoredRows) || {};
            const payload = { scenario: scen, profile: prof, bestRow: bestForScen, generatedAt: new Date().toISOString() };
            navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
            btn.textContent = 'Copied!';
            setTimeout(() => { if (btn) btn.textContent = 'Copy profile JSON'; }, 1200);
        });
    });
}

// =============================================================================
// localStorage persistence — Task 8
// =============================================================================

const LS_KEY = 'jxl-preset-bench-results';

export function saveResults(rows, presets) {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify({
            timestamp: Date.now(),
            rows,
            presets,
        }));
    } catch (e) {
        console.warn('Could not save results to localStorage:', e);
    }
}

export function loadSavedResults() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

// =============================================================================
// CSV export — Task 8
// =============================================================================

export function exportCsv(rows) {
    const header = ['file','sizePx','tier','phase','effort','decSpeed','modular','brotli','resamp','encMs','decMs','sizeKB','score','rawBenchMs','rawFullMs','rawLightboxMs','rawThumbMs'];
    const csvRows = [header.join(',')];
    for (const r of rows) {
        // Try to attach latest RAW data if present for this file
        let rawBench = '', rawFull = '', rawLb = '', rawTh = '';
        if (rawIsolationData) {
            const match = findRawIsolationMatch(rawIsolationData, r);
            if (match) {
                if (match.bench) rawBench = (match.bench.decompress_ms + match.bench.demosaic_ms).toFixed(1);
                if (match.rawCostForScoring) {
                    rawFull = (match.rawCostForScoring.full || 0).toFixed(1);
                    rawLb   = (match.rawCostForScoring.lightbox || 0).toFixed(1);
                    rawTh   = (match.rawCostForScoring.thumb || 0).toFixed(1);
                }
            }
        }
        csvRows.push(joinCsvRow([
            r.file, r.sizePx, r.tier, r.phase, r.effort, r.decSpeed,
            r.modular, r.brotli, r.resamp,
            r.encMs.toFixed(1), r.decMs.toFixed(1),
            (r.sizeBytes / 1024).toFixed(1), r.score,
            rawBench, rawFull, rawLb, rawTh
        ]));
    }
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'preset-benchmark.csv';
    a.click();
    URL.revokeObjectURL(url);
}

function refreshGraphFormatBar() {
    const bar = document.getElementById('graph-format-bar');
    if (!bar) return;
    bar.querySelectorAll('.fmt-btn').forEach(b => b.remove());
    const makeBtn = (fmt, label, active) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'fmt-btn';
        b.dataset.fmt = fmt;
        b.style.cssText = 'padding:0 4px;font-size:8px;';
        if (active) b.style.fontWeight = '700';
        b.textContent = label;
        return b;
    };
    const allActive = selectedGraphFormat === 'all';
    bar.appendChild(makeBtn('all', 'All', allActive));
    const used = [...new Set(sweepRows.map(r => r.file))];
    for (const f of used) {
        const slot = SLOTS.find(s => s.id === f);
        const label = slot ? slot.label : f.toUpperCase();
        bar.appendChild(makeBtn(f, label, selectedGraphFormat === f));
    }
}

function refreshGraphsWithFilter() {
    if (!sweepRows.length) return;
    renderPhase1Charts(sweepRows.filter(r => r.phase === 1));
    renderPhase2Chart(sweepRows.filter(r => r.phase === 2));
    renderPhase3Chart(sweepRows.filter(r => r.phase === 3));
}

// === Export helpers (CSV/JSON/TOON + rich header + file picker) ===

function quoteIfNeeded(str) {
    if (!str && str !== 0) return '';
    const s = String(str);
    const needs = /[\s,:[\]{}"\\]/.test(s) || s === 'true' || s === 'false' || s === 'null' || /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(s);
    if (needs) return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    return s;
}

function buildExportMeta(rows) {
    const ts = new Date().toISOString();
    const activeFiles = Object.entries(loadedSources || {}).filter(([,v]) => v).map(([id, src]) => ({
        slot: id, name: src.name, width: src.width, height: src.height, ext: src.ext || id
    }));
    const effortsUsed = [...new Set(rows.map(r => r.effort))].sort((a,b)=>a-b);
    const sizesUsed = [...new Set(rows.map(r => r.sizePx))];
    return {
        exportedAt: ts,
        generator: 'jxl-preset-benchmark',
        version: 'preset-v1',
        browser: navigator.userAgent.slice(0, 120),
        loadedFiles: activeFiles,
        selected: {
            efforts: effortsUsed,
            sizes: sizesUsed,
            tiers: [...new Set(rows.map(r => r.tier))],
            phases: [...new Set(rows.map(r => r.phase))],
            scenarios: (window.__lastSweepScenarios || []),
            runsPerConfig: 3,
        },
        rawIsolation: !!rawIsolationData && Object.keys(rawIsolationData).length > 0,
        rowCount: rows.length,
    };
}

function buildExportText(rows, format = 'json') {
    const meta = buildExportMeta(rows);
    // augment rows snapshot with format label for recognition
    const enriched = rows.map(r => {
        const slot = SLOTS.find(s => s.id === r.file);
        return { ...r, format: slot ? slot.label : r.file };
    });
    if (format === 'json') {
        return JSON.stringify({ meta, rows: enriched }, null, 2);
    }
    if (format === 'csv') {
        const header = ['file','format','sizePx','tier','phase','effort','decSpeed','modular','brotli','resamp','encMs','decMs','sizeKB','score'];
        const lines = [header.join(',')];
        for (const r of enriched) {
            lines.push(joinCsvRow([
                r.file, r.format, r.sizePx, r.tier, r.phase, r.effort, r.decSpeed,
                r.modular, r.brotli, r.resamp,
                r.encMs.toFixed(1), r.decMs.toFixed(1),
                (r.sizeBytes/1024).toFixed(1), r.score
            ]));
        }
        // meta as comment block (non-standard but useful when pasted)
        const metaLines = Object.entries(meta).map(([k,v]) => `# ${k}: ${typeof v==='object'?JSON.stringify(v):v}`);
        return metaLines.join('\n') + '\n' + lines.join('\n');
    }
    if (format === 'toon') {
        const dict = {
            'ti': 'tiny',
            'sm': 'small',
            'me': 'medium',
            'la': 'large',
            'di': 'display',
            'vl': 'very-large',
            'or': 'original',
            'co': 'center-out',
            'tb': 'top-bottom',
            'T': 'true',
            'F': 'false'
        };
        const reverseDict = Object.fromEntries(Object.entries(dict).map(([k,v]) => [v,k]));
        const mapVal = (v) => reverseDict[v] || v;

        let out = `Dict: ${Object.entries(dict).map(([k,v]) => `${k}=${v}`).join(', ')}\n`;
        out += `meta:\n`;
        out += `  exportedAt: ${meta.exportedAt}\n`;
        out += `  generator: ${quoteIfNeeded(meta.generator)}\n`;
        out += `  rowCount: ${meta.rowCount}\n`;
        out += `  rawIsolation: ${meta.rawIsolation}\n`;
        out += `  files[${meta.loadedFiles.length}]:\n`;
        for (const f of meta.loadedFiles) {
            out += `    - slot: ${f.slot}\n`;
            out += `      name: ${quoteIfNeeded(f.name)}\n`;
            out += `      ext: ${f.ext}\n`;
        }
        out += `  selectedEfforts: ${meta.selected.efforts.join(',')}\n`;
        out += `  selectedSizes: ${meta.selected.sizes.map(mapVal).join(',')}\n`;
        const n = enriched.length;
        
        out += `\n---\n`;
        out += `rows[${n}]{file|format|sizePx|tier|phase|effort|encMs|decMs|sizeKB|score}:\n`;
        
        let lastFile = '';
        let lastFormat = '';
        let lastSize = '';
        let lastTier = '';
        let lastPhase = '';
        
        for (const r of enriched) {
            const file = r.file;
            const format = r.format;
            const size = mapVal(r.sizePx);
            const tier = r.tier;
            const phase = r.phase;
            const effort = r.effort;
            const encMs = r.encMs.toFixed(1);
            const decMs = r.decMs.toFixed(1);
            const sizeKB = (r.sizeBytes/1024).toFixed(1);
            const score = r.score;
            
            const fileOut = file === lastFile ? '~' : file;
            const formatOut = format === lastFormat ? '~' : format;
            const sizeOut = size === lastSize ? '~' : size;
            const tierOut = tier === lastTier ? '~' : tier;
            const phaseOut = phase === lastPhase ? '~' : phase;
            
            out += `  ${fileOut} | ${formatOut} | ${sizeOut} | ${tierOut} | ${phaseOut} | ${effort} | ${encMs} | ${decMs} | ${sizeKB}KB | ${score}\n`;
            
            lastFile = file;
            lastFormat = format;
            lastSize = size;
            lastTier = tier;
            lastPhase = phase;
        }
        return out;
    }
    return JSON.stringify({ meta, rows: enriched }, null, 2);
}

async function saveTextWithPicker(filename, text, mime = 'text/plain') {
    if (window.showSaveFilePicker) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: filename,
                types: [{ description: 'Benchmark data', accept: { [mime]: ['.' + filename.split('.').pop()] } }]
            });
            const writable = await handle.createWritable();
            await writable.write(text);
            await writable.close();
            return;
        } catch (e) {
            if (e.name === 'AbortError') return;
            // fallthrough to download
        }
    }
    // fallback
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
}

// Clear current sweep outputs (results table, preset recs, graphs) while preserving loaded files and RAW isolation data.
// Called by the new unified Clear button (P1 export UI unification).
function clearSweepResults() {
    if (typeof sweepRows !== 'undefined' && Array.isArray(sweepRows)) {
        sweepRows.length = 0;
    }
    const resBody = document.getElementById('results-table-body');
    if (resBody) resBody.innerHTML = '<div style="font-size:9px;opacity:0.6;padding:4px;">Results cleared. Run a new sweep to populate table + graphs.</div>';
    const presetGrid = document.getElementById('preset-cards-grid');
    if (presetGrid) presetGrid.innerHTML = '<div style="font-size:9px;opacity:0.6;padding:4px;">Preset + scenario recommendations cleared.</div>';
    const graphsBody = document.getElementById('phase-graphs-body');
    if (graphsBody) graphsBody.innerHTML = '<div style="font-size:9px;opacity:0.6;padding:4px;">Graphs cleared (next sweep rebuilds canvases + charts).</div>';
    if (typeof selectedGraphFormat !== 'undefined') {
        selectedGraphFormat = 'all';
    }
    updateButtonStates();
    dbgLog('Sweep results cleared', 'results/presets/graphs reset; files + RAW isolation preserved');
}

// P2 minimal artifact (citable recommendations for cross-suite / Tauri thumb-pyramid linking).
// Produces a self-contained JSON with the derived best presets per tier + scenario context + full provenance.
// Emitted via the "Recs" button; user places the file in docs/outputs/preset-benchmark/ for the project record.
export function buildPresetRecommendationsArtifact() {
    const presets = (typeof derivePresets === 'function') ? derivePresets(sweepRows) : [];
    const meta = (typeof buildExportMeta === 'function') ? buildExportMeta(sweepRows) : {};
    const scenarios = window.__lastSweepScenarios || [];

    // Lightweight RAW cost summary (if the isolation panel was used)
    let rawSummary = null;
    if (rawIsolationData && Object.keys(rawIsolationData).length > 0) {
        const vals = Object.values(rawIsolationData).map(d => d.rawCostForScoring).filter(Boolean);
        if (vals.length) {
            rawSummary = {
                files: Object.keys(rawIsolationData).length,
                avgFullMs: Math.round(vals.reduce((s, v) => s + (v.full || 0), 0) / vals.length),
                avgThumbMs: Math.round(vals.reduce((s, v) => s + (v.thumb || 0), 0) / vals.length),
            };
        }
    }

    return {
        meta: {
            ...meta,
            generator: 'jxl-preset-benchmark/p2-artifact',
            scenarios,
        },
        recommendedPresets: presets,
        rawIsolation: rawSummary,
        generatedAt: new Date().toISOString(),
        note: 'Commit this (and optional short .md) to docs/outputs/preset-benchmark/ to cross-link with Tauri thumb-pyramid rules. See BENCHMARK_AND_TESTING_HANDOFF.md:68/89 and the Owl handoff.',
    };
}
