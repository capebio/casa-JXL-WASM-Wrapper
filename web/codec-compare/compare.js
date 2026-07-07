// compare.js — Interactive codec comparison orchestration.
//
// Drop a JPEG/PNG/RAW file → decode to RGBA → encode with JXL/JPEG/AVIF/WebP →
// show thumbnails + sizes + enc-times → butteraugli heatmap → BD-rate row.

import initRaw, * as rawWasm from '../pkg/raw_converter_wasm.js';
import { codecs } from './codecs.js';
import { renderHeatmap, getButteraugliScore } from './heatmap.js';
import { exportReport } from './report.js';

// ── BD-rate (inline, no deps) ────────────────────────────────────────────────

function sortByDist(curve) {
    return [...curve]
        .filter(p => p.bpp > 0 && Number.isFinite(p.butteraugli))
        .sort((a, b) => a.butteraugli - b.butteraugli)
        .map(p => ({ d: p.butteraugli, r: Math.log10(p.bpp) }));
}
function interpRate(pts, d) {
    if (d <= pts[0].d) return pts[0].r;
    if (d >= pts[pts.length - 1].d) return pts[pts.length - 1].r;
    for (let i = 1; i < pts.length; i++) {
        if (d <= pts[i].d) {
            const t = (d - pts[i - 1].d) / (pts[i].d - pts[i - 1].d);
            return pts[i - 1].r + t * (pts[i].r - pts[i - 1].r);
        }
    }
    return pts[pts.length - 1].r;
}
function bdRate(ref, test) {
    const R = sortByDist(ref), T = sortByDist(test);
    if (R.length < 2 || T.length < 2) return null;
    const lo = Math.max(R[0].d, T[0].d);
    const hi = Math.min(R[R.length - 1].d, T[T.length - 1].d);
    if (!(hi > lo)) return null;
    const N = 100;
    let acc = 0;
    for (let i = 0; i < N; i++) {
        const d0 = lo + (hi - lo) * (i / N);
        const d1 = lo + (hi - lo) * ((i + 1) / N);
        const f0 = interpRate(T, d0) - interpRate(R, d0);
        const f1 = interpRate(T, d1) - interpRate(R, d1);
        acc += 0.5 * (f0 + f1) * (d1 - d0);
    }
    return (Math.pow(10, acc / (hi - lo)) - 1) * 100;
}

// ── Format helpers ───────────────────────────────────────────────────────────

function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let v = n, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtMs(ms) { return `${ms.toFixed(1)} ms`; }
function fmtBd(pct) {
    if (pct == null || !Number.isFinite(pct)) return '—';
    return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
}
function fmtScore(s) { return Number.isFinite(s) ? s.toFixed(3) : '—'; }

// ── RAW detection ────────────────────────────────────────────────────────────

const RAW_EXTS = new Set(['.orf', '.cr2', '.dng', '.raw', '.nef', '.arw']);
function isRaw(name) { return RAW_EXTS.has(name.slice(name.lastIndexOf('.')).toLowerCase()); }

// ── RAW decode to RGBA8 ──────────────────────────────────────────────────────

const DEFAULT_TARGET = 1920;
const PROCESS_FLAGS = 1; // full RGB8 only
const PROCESS_DEFAULTS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0];

async function decodeRaw(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    let result;
    if (ext === '.orf' || ext === '.raw') result = rawWasm.process_orf_with_flags(bytes, PROCESS_FLAGS, ...PROCESS_DEFAULTS);
    else if (ext === '.cr2')              result = rawWasm.process_cr2_with_flags(bytes, PROCESS_FLAGS, ...PROCESS_DEFAULTS);
    else if (ext === '.dng')             result = rawWasm.process_dng_with_flags(bytes, PROCESS_FLAGS, ...PROCESS_DEFAULTS);
    else throw new Error(`Unsupported RAW extension: ${ext}`);
    let rgba, w, h;
    try {
        const fullW = result.width, fullH = result.height;
        const longEdge = Math.max(fullW, fullH);
        if (longEdge > DEFAULT_TARGET) {
            const scale = DEFAULT_TARGET / longEdge;
            const dstW = Math.max(1, Math.round(fullW * scale));
            const dstH = Math.max(1, Math.round(fullH * scale));
            const fullRgba = result.take_rgba();
            rgba = new Uint8Array(rawWasm.downscale_rgba(fullRgba, fullW, fullH, dstW, dstH));
            w = dstW; h = dstH;
        } else {
            rgba = new Uint8Array(result.take_rgba());
            w = fullW; h = fullH;
        }
    } finally {
        result.free();
    }
    return { rgba, w, h };
}

// ── Standard image (JPEG/PNG/WebP) decode via createImageBitmap ──────────────

async function decodeStandard(file) {
    const bitmap = await createImageBitmap(file);
    const w = bitmap.width, h = bitmap.height;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const id = ctx.getImageData(0, 0, w, h);
    return { rgba: new Uint8Array(id.data.buffer), w, h };
}

// ── Encode one codec and return result ───────────────────────────────────────

async function runCodec(key, rgba, w, h, quality) {
    const codec = codecs[key];
    const t0 = performance.now();
    const encoded = await codec.encode(rgba, w, h, quality);
    const encMs = performance.now() - t0;
    const decoded = await codec.decode(encoded);
    return { key, name: codec.name, encoded, decoded, encMs, bytes: encoded.length };
}

// ── State ─────────────────────────────────────────────────────────────────────

let state = {
    file: null,
    rgba: null, w: 0, h: 0,
    quality: 80,
    results: null,       // Map<codecKey, {encoded, decoded, encMs, bytes}>
    sweepData: null,     // {jxl, jpeg, avif, webp} each = [{quality, bytes, butteraugli, bpp}]
    activeHeatmap: 'jxl',
    rawReady: false,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────

const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const qualitySlider = document.getElementById('quality-slider');
const qualityVal    = document.getElementById('quality-value');
const codecGrid     = document.getElementById('codec-grid');
const heatmapCanvas = document.getElementById('heatmap-canvas');
const bdRateRow     = document.getElementById('bd-rate-row');
const exportBtn     = document.getElementById('export-btn');
const statusEl      = document.getElementById('status');
const originalCanvas = document.getElementById('original-canvas');

// ── Status ────────────────────────────────────────────────────────────────────

function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.className = isError ? 'status error' : 'status';
}

// ── Original preview ──────────────────────────────────────────────────────────

function drawOriginal(rgba, w, h) {
    originalCanvas.width = w;
    originalCanvas.height = h;
    const ctx = originalCanvas.getContext('2d');
    ctx.putImageData(
        new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h),
        0, 0
    );
}

// ── Codec result cards ────────────────────────────────────────────────────────

function drawCodecCard(result, butteraugliScore) {
    const existing = document.getElementById(`card-${result.key}`);
    const card = existing || document.createElement('div');
    card.id = `card-${result.key}`;
    card.className = 'codec-card';

    // Thumbnail canvas.
    let thumbCanvas = card.querySelector('canvas.thumb');
    if (!thumbCanvas) {
        thumbCanvas = document.createElement('canvas');
        thumbCanvas.className = 'thumb';
    }
    const { data, width, height } = result.decoded;
    const maxThumb = 320;
    const scale = Math.min(1, maxThumb / Math.max(width, height));
    const tw = Math.round(width * scale), th = Math.round(height * scale);
    thumbCanvas.width = tw; thumbCanvas.height = th;
    const thumbCtx = thumbCanvas.getContext('2d');
    // Draw decoded RGBA into a temp canvas at full res, then scale.
    const tmp = new OffscreenCanvas(width, height);
    const tmpCtx = tmp.getContext('2d');
    tmpCtx.putImageData(
        new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height),
        0, 0
    );
    thumbCtx.imageSmoothingEnabled = true;
    thumbCtx.imageSmoothingQuality = 'high';
    thumbCtx.drawImage(tmp, 0, 0, tw, th);

    card.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = result.name;
    card.appendChild(title);
    card.appendChild(thumbCanvas);

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.innerHTML = `
        <span class="size">${fmtBytes(result.bytes)}</span>
        <span class="enc-time">${fmtMs(result.encMs)} enc</span>
        <span class="score">BA: ${fmtScore(butteraugliScore)}</span>
    `;
    card.appendChild(meta);

    // Heatmap button.
    const btn = document.createElement('button');
    btn.className = 'heatmap-btn' + (state.activeHeatmap === result.key ? ' active' : '');
    btn.textContent = 'Show heatmap';
    btn.addEventListener('click', () => {
        state.activeHeatmap = result.key;
        updateHeatmap();
        document.querySelectorAll('.heatmap-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
    card.appendChild(btn);

    if (!existing) codecGrid.appendChild(card);
}

// ── Heatmap update ────────────────────────────────────────────────────────────

function updateHeatmap() {
    if (!state.results || !state.rgba) return;
    const result = state.results.get(state.activeHeatmap);
    if (!result) return;
    renderHeatmap(heatmapCanvas, state.rgba, result.decoded.data, state.w, state.h);
    heatmapCanvas.title = `Butteraugli heatmap: ${result.name} vs original (blue=similar, red=different)`;
}

// ── BD-rate row ───────────────────────────────────────────────────────────────

function updateBdRateRow(sweepData) {
    if (!sweepData) { bdRateRow.textContent = 'BD-rate: (run more quality levels for sweep)'; return; }
    const ref = sweepData.jpeg;
    if (!ref || ref.length < 2) { bdRateRow.textContent = 'BD-rate: insufficient JPEG data points'; return; }
    const parts = [];
    for (const [key, name] of [['jxl','JXL'], ['avif','AVIF'], ['webp','WebP']]) {
        const pts = sweepData[key];
        if (!pts || pts.length < 2) { parts.push(`${name}: —`); continue; }
        const bd = bdRate(ref, pts);
        parts.push(`${name}: ${fmtBd(bd)}`);
    }
    bdRateRow.textContent = 'BD-Rate vs JPEG:  ' + parts.join('   ');
}

// ── Main comparison run ───────────────────────────────────────────────────────

async function runComparison() {
    if (!state.rgba) return;
    const quality = state.quality;
    setStatus(`Encoding with all 4 codecs at quality ${quality}…`);
    codecGrid.innerHTML = '';

    const keys = ['jxl', 'jpeg', 'avif', 'webp'];
    let results;
    try {
        const promises = keys.map(k => runCodec(k, state.rgba, state.w, state.h, quality));
        results = await Promise.all(promises);
    } catch (err) {
        setStatus(`Encode error: ${err.message}`, true);
        return;
    }

    state.results = new Map(results.map(r => [r.key, r]));

    // Compute butteraugli scores (JS approximation).
    for (const r of results) {
        r.butteraugliScore = getButteraugliScore(state.rgba, r.decoded.data, state.w, state.h);
        drawCodecCard(r, r.butteraugliScore);
    }

    updateHeatmap();
    setStatus(`Done. Image: ${state.w}×${state.h}`);
    exportBtn.disabled = false;

    // Run BD-rate sweep in the background.
    runSweep();
}

// ── BD-rate sweep (5 quality levels, background) ─────────────────────────────

const BD_QUALITIES = [60, 70, 80, 90, 95];

async function runSweep() {
    const npx = state.w * state.h;
    const sweepData = { jxl: [], jpeg: [], avif: [], webp: [] };
    const rgba = state.rgba;
    const w = state.w, h = state.h;

    for (const q of BD_QUALITIES) {
        for (const key of ['jxl', 'jpeg', 'avif', 'webp']) {
            try {
                const codec = codecs[key];
                const encoded = await codec.encode(rgba, w, h, q);
                const decoded = await codec.decode(encoded);
                const butteraugli = getButteraugliScore(rgba, decoded.data, w, h);
                const bpp = (encoded.length * 8) / npx;
                sweepData[key].push({ quality: q, bytes: encoded.length, bpp, butteraugli });
            } catch (_) {
                // Skip failing codec/quality combos (e.g. AVIF not supported in this browser).
            }
        }
    }

    state.sweepData = sweepData;
    updateBdRateRow(sweepData);
}

// ── Image load handler ────────────────────────────────────────────────────────

async function handleFile(file) {
    if (!file) return;
    state.file = file;
    state.results = null;
    state.sweepData = null;
    exportBtn.disabled = true;
    setStatus(`Loading ${file.name}…`);

    try {
        let decoded;
        if (isRaw(file.name)) {
            if (!state.rawReady) {
                setStatus('Initializing RAW decoder…');
                await initRaw();
                if (typeof rawWasm.initThreadPool === 'function') {
                    await rawWasm.initThreadPool(navigator.hardwareConcurrency);
                }
                state.rawReady = true;
            }
            decoded = await decodeRaw(file);
        } else {
            decoded = await decodeStandard(file);
        }
        state.rgba = decoded.rgba;
        state.w    = decoded.w;
        state.h    = decoded.h;
        drawOriginal(state.rgba, state.w, state.h);
        await runComparison();
    } catch (err) {
        setStatus(`Error: ${err.message}`, true);
        console.error(err);
    }
}

// ── Quality slider ────────────────────────────────────────────────────────────

qualitySlider.addEventListener('input', () => {
    state.quality = parseInt(qualitySlider.value, 10);
    qualityVal.textContent = state.quality;
});
qualitySlider.addEventListener('change', async () => {
    if (state.rgba) await runComparison();
});

// ── Drop zone ─────────────────────────────────────────────────────────────────

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) handleFile(f);
});

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
});

// ── Export button ──────────────────────────────────────────────────────────────

exportBtn.addEventListener('click', async () => {
    if (!state.rgba || !state.results) return;
    exportBtn.disabled = true;
    setStatus('Generating report…');
    try {
        await exportReport(state);
        setStatus('Report downloaded.');
    } catch (err) {
        setStatus(`Export error: ${err.message}`, true);
    } finally {
        exportBtn.disabled = false;
    }
});
