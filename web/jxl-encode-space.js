import initRaw, * as rawWasm from './pkg/raw_converter_wasm.js';
import { createEncoder, createDecoder } from '@casabio/jxl-wasm';
import { createFilePicker } from './jxl-file-picker.js';

// web/jxl-encode-space.js

console.log('%c[Encode Space] jxl-encode-space.js loaded — distance × effort sweep', 'color:#818cf8;font-weight:600', { page: 'Encode Space', url: location.href, t: new Date().toISOString() });

// ── Constants ──────────────────────────────────────────────────────────────

const COARSE_DISTANCES = [0, 0.5, 1, 1.5, 2, 3, 5, 8];
const FINE_DISTANCES   = [0, 0.2, 0.4, 0.6, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7, 10];

// ── Pure utilities ─────────────────────────────────────────────────────────

function cellKey(effort, distance) {
    return `${effort}:${distance}`;
}

function calcBpp(sizeBytes, width, height) {
    return (sizeBytes * 8) / (width * height);
}

// Returns a CSS rgb() color string on a green→yellow→red scale (t=0 green, t=1 red).
function sizeColor(sizeKb, minKb, maxKb) {
    if (maxKb <= minKb) return 'var(--success)';
    const t = Math.max(0, Math.min(1, (sizeKb - minKb) / (maxKb - minKb)));
    const r = Math.round(34  + t * (239 - 34));
    const g = Math.round(197 + t * (68  - 197));
    const b = Math.round(94  + t * (68  - 94));
    return `rgb(${r},${g},${b})`;
}

function buildDistances(preset, customStr) {
    if (preset === 'fine') return FINE_DISTANCES.slice();
    if (preset === 'custom') {
        return customStr.split(',')
            .map(s => parseFloat(s.trim()))
            .filter(v => Number.isFinite(v) && v >= 0)
            .sort((a, b) => a - b);
    }
    return COARSE_DISTANCES.slice(); // default: coarse
}

function estimateMins(efforts, distances) {
    if (!efforts.length || !distances.length) return 0;
    const avgEffort = efforts.reduce((s, e) => s + e, 0) / efforts.length;
    const secs = efforts.length * distances.length * 8 * (avgEffort / 5);
    return Math.max(1, Math.ceil(secs / 60));
}

// ── State ──────────────────────────────────────────────────────────────────

let cellCache   = new Map(); // cellKey → { bitmap: ImageBitmap, sizeKb: number, bpp: number, encodeMs: number }
let sweepConfig = { efforts: [3, 5, 7, 9], distances: COARSE_DISTANCES.slice(), outputScale: 0.25 };
let currentCell = { effort: 5, distance: 1 };
let rgba        = null;  // Uint8Array — decoded ORF at output resolution
let imgW        = 0;
let imgH        = 0;
let running     = false;
let abortCtrl   = null;
let orfFile     = null;
let wasmReady   = false;

// ── DOM refs ───────────────────────────────────────────────────────────────

const orfFileInput      = document.getElementById('orf-file-input');
const btnRun            = document.getElementById('btn-run');
const btnConsole        = document.getElementById('btn-console');
const btnConsoleClear   = document.getElementById('btn-console-clear');
const btnConsoleCopy    = document.getElementById('btn-console-copy');
const wasmStatusEl      = document.getElementById('wasm-status');
const statusFile        = document.getElementById('status-file');
const statusProgress    = document.getElementById('status-progress');
const statusStage       = document.getElementById('status-stage');
const consolePanelEl    = document.getElementById('console-panel');
const consoleOutputEl   = document.getElementById('console-output');
const viewerCanvasEl    = document.getElementById('viewer-canvas');
const viewerSpinnerEl   = document.getElementById('viewer-spinner');
const effortSliderEl    = document.getElementById('effort-slider');
const distanceSliderEl  = document.getElementById('distance-slider');
const statSizeEl        = document.getElementById('stat-size');
const statBppEl         = document.getElementById('stat-bpp');
const statEncodeEl      = document.getElementById('stat-encode');
const statEffortEl      = document.getElementById('stat-effort');
const statDistanceEl    = document.getElementById('stat-distance');
const matrixEl          = document.getElementById('matrix-grid');
const copyMdBtn         = document.getElementById('btn-copy-md');
const exportJsonBtn     = document.getElementById('btn-export-json');
const estimateEl        = document.getElementById('estimate-label');
const distancePresetEl  = document.getElementById('distance-preset');
const customDistanceEl  = document.getElementById('custom-distance');
const outputScaleEl     = document.getElementById('output-scale');

// ── Console intercept ──────────────────────────────────────────────────────

let consolePanelOpen = false;
const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);

function logToPanel(level, args) {
    const line = document.createElement('div');
    line.className = 'console-line console-line--' + level;
    line.textContent = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    consoleOutputEl.appendChild(line);
    consoleOutputEl.scrollTop = consoleOutputEl.scrollHeight;
}

// Only mirror console output into the in-page panel when this tool's console
// output element is actually present, and only install the override once.
// This keeps the override scoped to the encode-space page rather than
// unconditionally clobbering the global console on import.
if (consoleOutputEl && !console.__encodeSpacePatched) {
    console.__encodeSpacePatched = true;
    console.log   = (...a) => { _log(...a);   logToPanel('log',   a); };
    console.warn  = (...a) => { _warn(...a);  logToPanel('warn',  a); };
    console.error = (...a) => { _error(...a); logToPanel('error', a); };
}

btnConsole.addEventListener('click', () => {
    consolePanelOpen = !consolePanelOpen;
    consolePanelEl.hidden = !consolePanelOpen;
    btnConsole.classList.toggle('is-active', consolePanelOpen);
});
btnConsoleClear.addEventListener('click', () => { consoleOutputEl.textContent = ''; });
btnConsoleCopy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(consoleOutputEl.textContent);
    btnConsoleCopy.textContent = 'Copied!';
    setTimeout(() => { btnConsoleCopy.textContent = 'Copy all'; }, 1600);
});

// ── WASM init ──────────────────────────────────────────────────────────────

function setWasmStatus(t) { wasmStatusEl.textContent = t; }

function updateRunBtn() {
    const cfg = readConfig();
    const valid = cfg.efforts.length > 0 && cfg.distances.length > 0;
    btnRun.disabled = !wasmReady || !orfFile || !valid;
    btnRun.title = !wasmReady ? 'Waiting for WASM…'
        : !orfFile ? 'Pick an ORF file first'
        : !valid   ? 'Select at least one effort and one distance'
        : 'Run sweep';
}

(async () => {
    setWasmStatus('Initialising WASM…');
    try {
        await initRaw();
        if (typeof rawWasm.initThreadPool === 'function') {
            await rawWasm.initThreadPool(navigator.hardwareConcurrency);
        }
        wasmReady = true;
        setWasmStatus('Ready');
    } catch (err) {
        setWasmStatus('WASM error');
        console.error('[encode-space] WASM init error:', err);
    }
    updateRunBtn();
})();

// ── Config reading ─────────────────────────────────────────────────────────

function readConfig() {
    const efforts = Array.from(document.querySelectorAll('input[name="effort-cb"]:checked'))
        .map(cb => Number(cb.value))
        .sort((a, b) => a - b);
    const distances = buildDistances(distancePresetEl.value, customDistanceEl.value);
    const outputScale = parseFloat(outputScaleEl.value) || 0.25;
    return { efforts, distances, outputScale };
}

function updateEstimate() {
    const { efforts, distances } = readConfig();
    estimateEl.textContent = (efforts.length && distances.length)
        ? `~${estimateMins(efforts, distances)} min estimated`
        : '';
    updateRunBtn();
}

document.querySelectorAll('input[name="effort-cb"]').forEach(cb =>
    cb.addEventListener('change', updateEstimate));

distancePresetEl.addEventListener('change', () => {
    customDistanceEl.hidden = distancePresetEl.value !== 'custom';
    updateEstimate();
});
customDistanceEl.addEventListener('input', updateEstimate);
outputScaleEl.addEventListener('change', updateEstimate);

updateEstimate(); // run once on load

// ── File picker ────────────────────────────────────────────────────────────

const filePicker = createFilePicker({
    input: orfFileInput,
    dropZone: document.querySelector('label[for="orf-file-input"]'),
    multiple: false,
    accept: '.orf,.ORF',
    persistKey: 'jxl-encode-space-last-file',
    onFiles: (files) => {
        orfFile = files.find(f => /\.orf$/i.test(f.name)) ?? null;
        statusFile.textContent = orfFile ? orfFile.name : '—';
        updateRunBtn();
    },
});

filePicker?.loadLastPersisted?.().then(f => {
    if (f?.length) {
        orfFile = f.find(x => /\.orf$/i.test(x.name)) ?? null;
        if (orfFile) {
            statusFile.textContent = orfFile.name;
            updateRunBtn();
        }
    }
}).catch(() => {});

// ── ORF decode ─────────────────────────────────────────────────────────────

async function decodeOrf(file, outputScale) {
    const ab = await file.arrayBuffer();
    // output_flags=1: full RGB8 only; skip lightbox (2) and thumbnail (4) RGB16 buffers
    // TODO: migrate to process_orf_with_look (K6#1) — pass {wbR:NaN, wbB:NaN} neutral look
    const result = rawWasm.process_orf_with_flags(
        new Uint8Array(ab), 1,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0
    );
    let outRgba, w, h;
    try {
        const fullW = result.width;
        const fullH = result.height;
        const fullRgba = result.take_rgba(); // WASM-side RGB→RGBA, avoids JS allocation
        if (outputScale >= 1.0) {
            outRgba = fullRgba;
            w = fullW;
            h = fullH;
        } else {
            const dstW = Math.max(1, Math.round(fullW * outputScale));
            const dstH = Math.max(1, Math.round(fullH * outputScale));
            outRgba = rawWasm.downscale_rgba(fullRgba, fullW, fullH, dstW, dstH);
            w = dstW;
            h = dstH;
        }
    } finally {
        result.free();
    }
    return { rgba: outRgba, w, h };
}

// ── Cell encode/decode ─────────────────────────────────────────────────────

function concatChunks(chunks) {
    const views = chunks.map(c => c instanceof Uint8Array ? c : new Uint8Array(c));
    if (views.length === 1) return views[0];
    const total = views.reduce((s, v) => s + v.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const v of views) { out.set(v, off); off += v.byteLength; }
    return out;
}

async function encodeCell(rgbaPixels, w, h, effort, distance) {
    const t0 = performance.now();
    const encoder = createEncoder({
        format: 'rgba8', width: w, height: h, hasAlpha: true,
        iccProfile: null, exif: null, xmp: null,
        distance, quality: null, effort,
        progressive: false, previewFirst: false, chunked: false,
    });
    const chunks = [];
    const chunkTask = (async () => {
        for await (const chunk of encoder.chunks()) chunks.push(chunk);
    })();
    const buf = rgbaPixels.buffer.byteLength === rgbaPixels.byteLength
        ? rgbaPixels.buffer
        : rgbaPixels.buffer.slice(rgbaPixels.byteOffset, rgbaPixels.byteOffset + rgbaPixels.byteLength);
    await encoder.pushPixels(buf);
    await encoder.finish();
    await chunkTask;
    await encoder.dispose();
    return { jxlBytes: concatChunks(chunks), encodeMs: performance.now() - t0 };
}

async function decodeToImageBitmap(jxlBytes, w, h) {
    const decoder = createDecoder({
        format: 'rgba8',
        progressionTarget: 'final',
        emitEveryPass: false,
        preserveIcc: false,
        preserveMetadata: false,
    });
    await decoder.push(jxlBytes);
    await decoder.close();
    let pixels = null;
    let decW = w, decH = h;
    for await (const event of decoder.events()) {
        if (event.type === 'final') {
            pixels = event.pixels;
            decW = event.info.width;
            decH = event.info.height;
            break;
        }
        if (event.type === 'error') {
            await decoder.dispose();
            throw new Error(event.message);
        }
    }
    await decoder.dispose();
    if (!pixels) throw new Error('decoder emitted no final frame');
    const raw = pixels instanceof ArrayBuffer
        ? new Uint8Array(pixels)
        : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    return createImageBitmap(
        new ImageData(new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength), decW, decH)
    );
}

// ── Sweep loop ─────────────────────────────────────────────────────────────

async function runSweep() {
    const cfg = readConfig();
    if (!cfg.efforts.length || !cfg.distances.length) return;

    sweepConfig = cfg;
    cellCache   = new Map();
    running     = true;
    abortCtrl   = new AbortController();
    const { signal } = abortCtrl;

    btnRun.textContent  = 'Stop';
    copyMdBtn.disabled  = true;
    exportJsonBtn.disabled = true;
    statusProgress.textContent = 'Starting…';

    buildMatrixDOM();

    // Decode ORF once at the chosen output scale
    statusStage.textContent = 'Decoding ORF…';
    try {
        const decoded = await decodeOrf(orfFile, cfg.outputScale);
        rgba = decoded.rgba;
        imgW = decoded.w;
        imgH = decoded.h;
        console.log(`[encode-space] ORF decoded: ${imgW}×${imgH} at scale ${cfg.outputScale}`);
    } catch (err) {
        console.error('[encode-space] ORF decode failed:', err);
        statusStage.textContent = `ORF error: ${err.message}`;
        endSweep();
        return;
    }

    const total = cfg.efforts.length * cfg.distances.length;
    let done = 0;
    let firstCell = true;

    for (const effort of cfg.efforts) {
        for (const distance of cfg.distances) {
            if (signal.aborted) break;

            statusStage.textContent    = `Encoding e${effort} d${distance}…`;
            statusProgress.textContent = `${done + 1} / ${total}`;
            console.log(`[encode-space] cell e${effort} d${distance} (${done + 1}/${total})`);

            try {
                const { jxlBytes, encodeMs } = await encodeCell(rgba, imgW, imgH, effort, distance);
                const sizeKb = jxlBytes.byteLength / 1024;
                const bpp    = calcBpp(jxlBytes.byteLength, imgW, imgH);
                const bitmap = await decodeToImageBitmap(jxlBytes, imgW, imgH);
                // The encode/decode above cannot be interrupted; if Stop was
                // pressed while they ran, discard this stale cell rather than
                // mutating the cache/matrix after abort.
                if (signal.aborted) break;
                const result = { bitmap, sizeKb, bpp, encodeMs };
                cellCache.set(cellKey(effort, distance), result);
                updateMatrixCell(effort, distance, result);
                if (firstCell) {
                    currentCell = { effort, distance };
                    refreshViewer();
                    refreshSliders();
                    firstCell = false;
                }
            } catch (err) {
                console.error(`[encode-space] cell e${effort} d${distance} failed:`, err);
                markMatrixCellError(effort, distance);
            }

            done++;
            await new Promise(r => setTimeout(r, 0)); // yield to browser event loop
        }
        if (signal.aborted) break;
    }

    statusStage.textContent    = signal.aborted ? 'Stopped' : 'Done';
    statusProgress.textContent = `${done} / ${total}`;
    if (cellCache.size) {
        copyMdBtn.disabled    = false;
        exportJsonBtn.disabled = false;
    }
    endSweep();
}

function endSweep() {
    running  = false;
    abortCtrl = null;
    btnRun.textContent = 'Run';
    updateRunBtn();
}

btnRun.addEventListener('click', () => {
    if (running) {
        abortCtrl?.abort();
    } else {
        runSweep();
    }
});

// ── Interactive viewer ─────────────────────────────────────────────────────

function refreshViewer() {
    const key    = cellKey(currentCell.effort, currentCell.distance);
    const result = cellCache.get(key);

    statEffortEl.textContent   = `e${currentCell.effort}`;
    statDistanceEl.textContent = `d${currentCell.distance}`;

    if (!result) {
        viewerSpinnerEl.hidden = false;
        viewerCanvasEl.hidden  = true;
        statSizeEl.textContent   = '—';
        statBppEl.textContent    = '—';
        statEncodeEl.textContent = '—';
        return;
    }

    viewerSpinnerEl.hidden = true;
    viewerCanvasEl.hidden  = false;

    viewerCanvasEl.width  = result.bitmap.width;
    viewerCanvasEl.height = result.bitmap.height;
    viewerCanvasEl.getContext('2d').drawImage(result.bitmap, 0, 0);

    statSizeEl.textContent   = `${result.sizeKb.toFixed(1)} KB`;
    statBppEl.textContent    = result.bpp.toFixed(3);
    statEncodeEl.textContent = `${result.encodeMs.toFixed(0)} ms`;

    highlightMatrixCell(currentCell.effort, currentCell.distance);
}

function refreshSliders() {
    const { efforts, distances } = sweepConfig;

    effortSliderEl.min      = 0;
    effortSliderEl.max      = efforts.length - 1;
    effortSliderEl.value    = Math.max(0, efforts.indexOf(currentCell.effort));
    effortSliderEl.disabled = false;

    distanceSliderEl.min      = 0;
    distanceSliderEl.max      = distances.length - 1;
    distanceSliderEl.value    = Math.max(0, distances.indexOf(currentCell.distance));
    distanceSliderEl.disabled = false;

    // Effort labels (vertical slider, top = highest effort)
    const effortLabelsEl = document.getElementById('effort-slider-labels');
    effortLabelsEl.innerHTML = '';
    for (const e of [...efforts].reverse()) {
        const span = document.createElement('span');
        span.textContent = e;
        effortLabelsEl.appendChild(span);
    }

    // Distance labels (horizontal slider)
    const distLabelsEl = document.getElementById('distance-slider-labels');
    distLabelsEl.innerHTML = '';
    for (const d of distances) {
        const span = document.createElement('span');
        span.textContent = d % 1 === 0 ? d : d.toFixed(1);
        distLabelsEl.appendChild(span);
    }
}

function syncSliders() {
    const { efforts, distances } = sweepConfig;
    const ei = efforts.indexOf(currentCell.effort);
    const di = distances.indexOf(currentCell.distance);
    if (ei >= 0) effortSliderEl.value   = ei;
    if (di >= 0) distanceSliderEl.value = di;
}

effortSliderEl.addEventListener('input', () => {
    const idx = parseInt(effortSliderEl.value, 10);
    currentCell = { ...currentCell, effort: sweepConfig.efforts[idx] };
    refreshViewer();
});

distanceSliderEl.addEventListener('input', () => {
    const idx = parseInt(distanceSliderEl.value, 10);
    currentCell = { ...currentCell, distance: sweepConfig.distances[idx] };
    refreshViewer();
});

// ── Matrix grid ────────────────────────────────────────────────────────────

function buildMatrixDOM() {
    matrixEl.innerHTML = '';
    const { efforts, distances } = sweepConfig;

    // Header row: corner + effort column headers
    const headerRow = document.createElement('div');
    headerRow.className = 'es-matrix-row';
    const corner = document.createElement('div');
    corner.className = 'es-matrix-corner';
    corner.textContent = 'd \\ e';
    headerRow.appendChild(corner);
    for (const e of efforts) {
        const th = document.createElement('div');
        th.className = 'es-matrix-col-header';
        th.textContent = `e${e}`;
        headerRow.appendChild(th);
    }
    matrixEl.appendChild(headerRow);

    // One row per distance value
    for (const d of distances) {
        const row = document.createElement('div');
        row.className = 'es-matrix-row';

        const rowHdr = document.createElement('div');
        rowHdr.className = 'es-matrix-row-header';
        rowHdr.textContent = d % 1 === 0 ? d : d.toFixed(1);
        row.appendChild(rowHdr);

        for (const e of efforts) {
            const cell = document.createElement('div');
            cell.className = 'es-matrix-data-cell';
            cell.dataset.effort   = String(e);
            cell.dataset.distance = String(d);
            cell.innerHTML = '<div class="es-cell-spinner">…</div>';
            cell.addEventListener('click', () => {
                currentCell = { effort: e, distance: d };
                refreshViewer();
                syncSliders();
            });
            row.appendChild(cell);
        }
        matrixEl.appendChild(row);
    }
}

function updateMatrixCell(effort, distance, result) {
    const cell = matrixEl.querySelector(
        `[data-effort="${effort}"][data-distance="${distance}"]`
    );
    if (!cell) return;

    cell.innerHTML = '';

    // Thumbnail canvas
    const canvas = document.createElement('canvas');
    canvas.width  = 72;
    canvas.height = 54;
    canvas.getContext('2d').drawImage(result.bitmap, 0, 0, 72, 54);
    cell.appendChild(canvas);

    // Size badge
    const badge = document.createElement('div');
    badge.className = 'es-cell-badge';
    badge.textContent = result.sizeKb < 1024
        ? `${result.sizeKb.toFixed(0)}KB`
        : `${(result.sizeKb / 1024).toFixed(1)}MB`;
    cell.appendChild(badge);

    recolorMatrixCells(); // update all borders now that min/max may have changed
}

function recolorMatrixCells() {
    const allSizes = [...cellCache.values()].map(r => r.sizeKb);
    if (!allSizes.length) return;
    const minKb = Math.min(...allSizes);
    const maxKb = Math.max(...allSizes);

    for (const [key, result] of cellCache) {
        const [effortStr, distStr] = key.split(':');
        const cell = matrixEl.querySelector(
            `[data-effort="${effortStr}"][data-distance="${distStr}"]`
        );
        if (!cell) continue;
        const color = sizeColor(result.sizeKb, minKb, maxKb);
        cell.style.borderColor = color;
        const badge = cell.querySelector('.es-cell-badge');
        if (badge) badge.style.color = color;
    }
    highlightMatrixCell(currentCell.effort, currentCell.distance);
}

function highlightMatrixCell(effort, distance) {
    matrixEl.querySelectorAll('.es-matrix-data-cell').forEach(c =>
        c.classList.toggle('is-selected',
            c.dataset.effort   === String(effort) &&
            c.dataset.distance === String(distance)
        )
    );
}

function markMatrixCellError(effort, distance) {
    const cell = matrixEl.querySelector(
        `[data-effort="${effort}"][data-distance="${distance}"]`
    );
    if (cell) cell.innerHTML = '<div class="es-cell-error">err</div>';
}

// ── Export ─────────────────────────────────────────────────────────────────

function copyMd() {
    if (!cellCache.size) return;
    const { efforts, distances } = sweepConfig;
    const lines = [];
    lines.push(`# JXL Encode Space — ${new Date().toISOString()}`);
    lines.push('');
    lines.push(`**ORF:** ${orfFile?.name ?? '—'}  ·  **Scale:** ${sweepConfig.outputScale}  ·  **Dims:** ${imgW}×${imgH}`);
    lines.push('');
    lines.push('| Distance | ' + efforts.map(e => `e${e}`).join(' | ') + ' |');
    lines.push('|' + '---------|'.repeat(efforts.length + 1));
    for (const d of distances) {
        const label = d % 1 === 0 ? String(d) : d.toFixed(1);
        const cells = efforts.map(e => {
            const r = cellCache.get(cellKey(e, d));
            return r ? `${r.sizeKb.toFixed(0)}KB / ${r.encodeMs.toFixed(0)}ms` : '—';
        });
        lines.push(`| ${label} | ${cells.join(' | ')} |`);
    }
    lines.push('');
    lines.push('_Generated by jxl-encode-space.html_');
    const md = lines.join('\n');
    navigator.clipboard.writeText(md).catch(() => {
        console.log('[encode-space] MD (clipboard blocked):\n' + md);
    });
    const orig = copyMdBtn.textContent;
    copyMdBtn.textContent = 'Copied!';
    setTimeout(() => { copyMdBtn.textContent = orig; }, 1600);
}

function exportJson() {
    if (!cellCache.size) return;
    const cells = [];
    for (const [key, result] of cellCache) {
        const [effortStr, distStr] = key.split(':');
        cells.push({
            effort:   Number(effortStr),
            distance: Number(distStr),
            sizeKb:   result.sizeKb,
            bpp:      result.bpp,
            encodeMs: result.encodeMs,
        });
    }
    const payload = {
        exportedAt: new Date().toISOString(),
        orf:        orfFile?.name ?? '—',
        config:     { ...sweepConfig, imgW, imgH },
        cells,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `jxl-encode-space-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log('[encode-space] Exported JSON with', cells.length, 'cells');
}

copyMdBtn.addEventListener('click', copyMd);
exportJsonBtn.addEventListener('click', exportJson);


