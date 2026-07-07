// colour-wizard.js — Colour Calibration Wizard (main thread logic).
//
// Sections:
//   1. Neutral patch picker  — click canvas → WB suggestion → apply preview
//   2. Two-up comparison     — before / after + butteraugli heatmap
//   3. WB scatter visualizer — 2D (R/G, B/G) scatter on canvas
//   4. Sign-off checklist    — golden corpus PASS/REVIEW badges
//
// Zero Rust pixel-output changes. Advisory WB only. Browser-only.

import {
    createButteraugliComparer,
    pixelsToXyb,
} from './jxl-butteraugli.js';

// ── WASM Worker ──────────────────────────────────────────────────────────────
const worker = new Worker(new URL('./colour-wizard-worker.js', import.meta.url), { type: 'module' });
let nextMsgId = 1;
const pendingMsgs = new Map(); // id → {resolve, reject}

worker.addEventListener('message', (e) => {
    const { type, id, error } = e.data;
    if (!id) return; // no-id internal messages
    const pending = pendingMsgs.get(id);
    if (!pending) return;
    pendingMsgs.delete(id);
    if (type === 'error') pending.reject(new Error(error));
    else pending.resolve(e.data);
});

function workerCall(msg, transfer = []) {
    const id = nextMsgId++;
    return new Promise((resolve, reject) => {
        pendingMsgs.set(id, { resolve, reject });
        worker.postMessage({ ...msg, id }, transfer);
    });
}

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
    fileName: '',
    rawBytes: null,
    beforeRgba: null,   // Uint8ClampedArray, RGBA8 at lightbox size
    afterRgba: null,    // Uint8ClampedArray, RGBA8 (re-rendered with adjusted WB)
    imageW: 0,
    imageH: 0,
    meta: null,         // {wbR, wbB, colorMatrix, orientation, black, make, model, …}
    currentWbR: 1.0,
    currentWbB: 1.0,
    sampledPoints: [],  // [{x, y, r, g, b}]  (lightbox-coords)
    loadingDecoder: false,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dropZone   = document.getElementById('wiz-drop');
const fileInput  = document.getElementById('wiz-file-input');
const pickBtn    = document.getElementById('wiz-pick-btn');
const loadStatus = document.getElementById('wiz-load-status');

const previewCanvas  = document.getElementById('preview-canvas');
const previewCtx     = previewCanvas.getContext('2d');
const pixelInfo      = document.getElementById('pixel-info');
const wbSuggestion   = document.getElementById('wb-suggestion');
const sampledList    = document.getElementById('sampled-list');
const applyWbBtn     = document.getElementById('apply-wb-btn');
const resetWbBtn     = document.getElementById('reset-wb-btn');
const clearSamplesBtn= document.getElementById('clear-samples-btn');

const beforeCanvas  = document.getElementById('before-canvas');
const afterCanvas   = document.getElementById('after-canvas');
const diffCanvas    = document.getElementById('diff-canvas');
const butterScore   = document.getElementById('butter-score');
const beforeCtx     = beforeCanvas.getContext('2d');
const afterCtx      = afterCanvas.getContext('2d');
const diffCtx       = diffCanvas.getContext('2d');

const sliderExpEl   = document.getElementById('sl-exposure');
const sliderConEl   = document.getElementById('sl-contrast');
const sliderSatEl   = document.getElementById('sl-saturation');
const sliderWbREl   = document.getElementById('sl-wb-r');
const sliderWbBEl   = document.getElementById('sl-wb-b');

const wbScatterCanvas = document.getElementById('wb-scatter');
const wbScatterCtx    = wbScatterCanvas.getContext('2d');
const wbScatterInfo   = document.getElementById('wb-scatter-info');

const corpusListEl  = document.getElementById('corpus-list');
const approveAllBtn = document.getElementById('approve-all-btn');
const signoffStatus = document.getElementById('signoff-status');

// ── Utility ───────────────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
    loadStatus.textContent = msg;
    loadStatus.style.color = isError ? '#f87171' : '#86efac';
}

function clampCanvas(canvas, w, h) {
    canvas.width  = w;
    canvas.height = h;
}

function paintRgba(ctx, rgba, w, h) {
    const id = new ImageData(new Uint8ClampedArray(rgba.buffer ?? rgba), w, h);
    ctx.putImageData(id, 0, 0);
}

/** Convert RGB8 (3 bytes/px) to RGBA8 (4 bytes/px, alpha=255). */
function rgb8ToRgba8(rgb, n) {
    const rgba = new Uint8ClampedArray(n * 4);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
        rgba[i * 4    ] = rgb[j    ];
        rgba[i * 4 + 1] = rgb[j + 1];
        rgba[i * 4 + 2] = rgb[j + 2];
        rgba[i * 4 + 3] = 255;
    }
    return rgba;
}

/** Sample pixel at (x, y) from RGBA8 buffer. */
function samplePixel(rgba, x, y, w) {
    const i = (y * w + x) * 4;
    return { r: rgba[i], g: rgba[i + 1], b: rgba[i + 2] };
}

/**
 * Compute white balance suggestion.
 * If sampled pixel is a neutral grey: we need R*wbR_adj = G, B*wbB_adj = G
 * relative to the current WB multipliers applied by the pipeline.
 * Returns new absolute WB multipliers.
 */
function computeNeutralWb(pixel, currentWbR, currentWbB) {
    const { r, g, b } = pixel;
    const eps = 1;  // avoid /0
    const adjR = currentWbR * (g / Math.max(r, eps));
    const adjB = currentWbB * (g / Math.max(b, eps));
    return { wbR: adjR, wbB: adjB };
}

/** XYB from a single RGBA8 pixel (index i). Uses the sqrt-linear approximation from jxl-butteraugli. */
function pixelXybFromRgba(rgba, i) {
    const _sqrtLin = (v255) => {
        const v = v255 / 255;
        const lin = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        return Math.sqrt(lin);
    };
    const r = _sqrtLin(rgba[i * 4    ]);
    const g = _sqrtLin(rgba[i * 4 + 1]);
    const b = _sqrtLin(rgba[i * 4 + 2]);
    return {
        X: (r - b) * 0.5,
        Y: (r + b) * 0.5 + g,
        B: b,
    };
}

// ── Butteraugli heatmap ───────────────────────────────────────────────────────

/**
 * Compute a per-pixel error heatmap between two RGBA8 images.
 * Returns Uint8ClampedArray (RGBA8) heatmap.
 * Error is measured in XYB space; hot=high-error (red), cold=low-error (blue).
 */
function computeHeatmap(refRgba, testRgba, w, h) {
    const n = w * h;
    const [rX, rY, rB] = pixelsToXyb(refRgba, n);
    const [tX, tY, tB] = pixelsToXyb(testRgba, n);

    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
        // Weighted XYB error (same weights as butteraugli core)
        const err = Math.sqrt(
            24 * (rX[i] - tX[i]) ** 2 +
            12 * (rY[i] - tY[i]) ** 2 +
             4 * (rB[i] - tB[i]) ** 2,
        );
        // Map err → heatmap colour: 0=blue → 0.5=green → 1=red
        const t = Math.min(1, err * 4); // scale: err~0.25 → saturated red
        out[i * 4    ] = Math.round(255 * t);
        out[i * 4 + 1] = Math.round(255 * (1 - Math.abs(t * 2 - 1)));
        out[i * 4 + 2] = Math.round(255 * (1 - t));
        out[i * 4 + 3] = 200;
    }
    return out;
}

// ── Sections ──────────────────────────────────────────────────────────────────

// ─── 1. Patch Picker ──────────────────────────────────────────────────────────

function displayBeforeOnPreviewCanvas() {
    if (!state.beforeRgba) return;
    clampCanvas(previewCanvas, state.imageW, state.imageH);
    paintRgba(previewCtx, state.beforeRgba, state.imageW, state.imageH);
}

function displayAfterOnPreviewCanvas() {
    if (!state.afterRgba) return;
    clampCanvas(previewCanvas, state.imageW, state.imageH);
    paintRgba(previewCtx, state.afterRgba, state.imageW, state.imageH);
}

previewCanvas.addEventListener('click', (e) => {
    if (!state.beforeRgba) return;
    const rect = previewCanvas.getBoundingClientRect();
    const scaleX = state.imageW / rect.width;
    const scaleY = state.imageH / rect.height;
    const x = Math.floor((e.clientX - rect.left) * scaleX);
    const y = Math.floor((e.clientY - rect.top)  * scaleY);
    if (x < 0 || x >= state.imageW || y < 0 || y >= state.imageH) return;

    // Use currently displayed image (beforeRgba or afterRgba)
    const source = state.afterRgba || state.beforeRgba;
    const px = samplePixel(source, x, y, state.imageW);
    const xyb = pixelXybFromRgba(source, y * state.imageW + x);
    const wb  = computeNeutralWb(px, state.currentWbR, state.currentWbB);

    // Store sample
    state.sampledPoints.push({ x, y, ...px, wbR: wb.wbR, wbB: wb.wbB });
    updateSampledList();

    // Update pixel info
    pixelInfo.innerHTML = `
        <strong>Pixel (${x}, ${y})</strong><br>
        sRGB: R=${px.r} G=${px.g} B=${px.b}<br>
        XYB: X=${xyb.X.toFixed(4)} Y=${xyb.Y.toFixed(4)} B=${xyb.B.toFixed(4)}
    `;

    // WB suggestion
    wbSuggestion.innerHTML = `
        <strong>WB suggestion</strong> (if this is a neutral grey):<br>
        wb_r = <code>${wb.wbR.toFixed(4)}</code>
        wb_b = <code>${wb.wbB.toFixed(4)}</code>
        <br><small>Advisory only — does not change the stored pipeline.</small>
    `;

    // Draw crosshair marker
    const displayX = (x / state.imageW) * rect.width;
    const displayY = (y / state.imageH) * rect.height;
    drawCrosshair(previewCtx, x, y, scaleX, scaleY);

    // Update WB sliders
    sliderWbREl.value = String(wb.wbR.toFixed(3));
    sliderWbBEl.value = String(wb.wbB.toFixed(3));
    updateSliderLabels();

    // Update scatter
    updateWbScatter();
});

function drawCrosshair(ctx, x, y, scaleX, scaleY) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 0, 0.9)';
    ctx.lineWidth   = Math.max(1, 1 / Math.min(scaleX, scaleY));
    const sz = Math.max(6, 12 / Math.min(scaleX, scaleY));
    ctx.beginPath();
    ctx.moveTo(x - sz, y); ctx.lineTo(x + sz, y);
    ctx.moveTo(x, y - sz); ctx.lineTo(x, y + sz);
    ctx.stroke();
    // circle
    ctx.beginPath();
    ctx.arc(x, y, sz * 0.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

function updateSampledList() {
    if (state.sampledPoints.length === 0) {
        sampledList.innerHTML = '<em style="opacity:.5">No samples yet — click the image above.</em>';
        return;
    }
    sampledList.innerHTML = state.sampledPoints.map((p, i) => `
        <div class="sample-row">
            <span class="sample-swatch" style="background:rgb(${p.r},${p.g},${p.b})"></span>
            <span>#${i + 1} (${p.x},${p.y})  R=${p.r} G=${p.g} B=${p.b}</span>
            <span class="sample-wb">→ wb_r=${p.wbR.toFixed(3)} wb_b=${p.wbB.toFixed(3)}</span>
        </div>
    `).join('');
}

applyWbBtn.addEventListener('click', async () => {
    if (!state.meta) return;
    await rerender({ wbR: state.currentWbR, wbB: state.currentWbB });
});

resetWbBtn.addEventListener('click', async () => {
    if (!state.meta) return;
    state.currentWbR = state.meta.wbR;
    state.currentWbB = state.meta.wbB;
    sliderWbREl.value = String(state.meta.wbR.toFixed(3));
    sliderWbBEl.value = String(state.meta.wbB.toFixed(3));
    updateSliderLabels();
    state.afterRgba = null;
    displayBeforeOnPreviewCanvas();
    updateComparisonPanels();
});

clearSamplesBtn.addEventListener('click', () => {
    state.sampledPoints = [];
    updateSampledList();
    pixelInfo.textContent = '';
    wbSuggestion.textContent = '';
    displayBeforeOnPreviewCanvas();  // redraw without crosshairs
    updateWbScatter();
});

// ─── 2. Two-up Comparison ─────────────────────────────────────────────────────

function updateSliderLabels() {
    document.getElementById('sl-exposure-val').textContent = sliderExpEl.value;
    document.getElementById('sl-contrast-val').textContent = sliderConEl.value;
    document.getElementById('sl-saturation-val').textContent = sliderSatEl.value;
    document.getElementById('sl-wb-r-val').textContent  = sliderWbREl.value;
    document.getElementById('sl-wb-b-val').textContent  = sliderWbBEl.value;
}

[sliderExpEl, sliderConEl, sliderSatEl, sliderWbREl, sliderWbBEl].forEach(el => {
    el.addEventListener('input', updateSliderLabels);
});

async function rerender(overrideParams = {}) {
    if (!state.meta || state.loadingDecoder) return;
    const params = {
        wbR: state.currentWbR,
        wbB: state.currentWbB,
        exposureEv:  parseFloat(sliderExpEl.value),
        contrast:    parseFloat(sliderConEl.value) / 100,
        saturation:  parseFloat(sliderSatEl.value) / 100,
        highlights: 0, shadows: 0, whites: 0, blacks: 0,
        vibrance: 0, temp: 0, tint: 0, texture: 0, clarity: 0,
        ...overrideParams,
    };
    state.currentWbR = params.wbR;
    state.currentWbB = params.wbB;
    setStatus('Re-rendering…');
    try {
        const res = await workerCall({ type: 'render', params });
        state.afterRgba = new Uint8ClampedArray(res.rgba);
        displayAfterOnPreviewCanvas();
        updateComparisonPanels();
        setStatus('Ready');
    } catch (err) {
        setStatus('Render error: ' + err.message, true);
    }
}

document.getElementById('render-btn').addEventListener('click', () => rerender());

function updateComparisonPanels() {
    const w = state.imageW, h = state.imageH;
    if (!state.beforeRgba || w === 0) return;

    clampCanvas(beforeCanvas, w, h);
    clampCanvas(afterCanvas,  w, h);

    paintRgba(beforeCtx, state.beforeRgba, w, h);

    if (state.afterRgba) {
        paintRgba(afterCtx, state.afterRgba, w, h);
        updateHeatmap();
    } else {
        afterCtx.clearRect(0, 0, w, h);
        diffCtx.clearRect(0, 0, diffCanvas.width, diffCanvas.height);
        butterScore.textContent = '—';
    }
}

function updateHeatmap() {
    const w = state.imageW, h = state.imageH;
    if (!state.beforeRgba || !state.afterRgba) return;

    const hm = computeHeatmap(state.beforeRgba, state.afterRgba, w, h);
    clampCanvas(diffCanvas, w, h);
    diffCtx.putImageData(new ImageData(hm, w, h), 0, 0);

    // Butteraugli score
    const comparer = createButteraugliComparer(state.beforeRgba, w, h);
    const score    = comparer(state.afterRgba);
    const badge    = score < 0.05 ? 'PASS' : score < 1.0 ? 'REVIEW' : 'FAIL';
    const colour   = score < 0.05 ? '#86efac' : score < 1.0 ? '#fde68a' : '#f87171';
    butterScore.innerHTML = `
        Butteraugli: <strong style="color:${colour}">${isNaN(score) ? '—' : score.toFixed(4)}</strong>
        <span class="badge badge-${badge.toLowerCase()}">${badge}</span>
    `;
}

// ─── 3. WB Scatter Visualizer ─────────────────────────────────────────────────

const SCATTER_W = 380, SCATTER_H = 380;
const SCATTER_MARGIN = 40;

function updateWbScatter() {
    const ctx = wbScatterCtx;
    const cw = SCATTER_W, ch = SCATTER_H;
    ctx.clearRect(0, 0, cw, ch);

    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, cw, ch);

    const mx = SCATTER_MARGIN, plotW = cw - mx * 2, plotH = ch - mx * 2;

    // Axis
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mx, mx); ctx.lineTo(mx, ch - mx);
    ctx.lineTo(cw - mx, ch - mx);
    ctx.stroke();

    // Axis labels
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('R/G', cw / 2, ch - 6);
    ctx.save();
    ctx.translate(14, ch / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('B/G', 0, 0);
    ctx.restore();

    const toCanvasX = (v) => mx + (v / 3.0) * plotW;   // R/G range 0..3
    const toCanvasY = (v) => ch - mx - (v / 3.0) * plotH;  // B/G range 0..3

    // Grey locus line: R/G = B/G = 1 (neutral, no WB shift)
    ctx.strokeStyle = '#64748b';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(toCanvasX(0),   toCanvasY(0));
    ctx.lineTo(toCanvasX(3),   toCanvasY(3));
    ctx.stroke();
    ctx.setLineDash([]);

    // Sampled points
    const source = state.afterRgba || state.beforeRgba;
    if (!source) {
        ctx.fillStyle = '#475569';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Click the image to sample pixels', cw / 2, ch / 2);
        return;
    }

    // Auto-sample a grid of points from the current image for context
    const auto = autoSample(source, state.imageW, state.imageH, 20);
    ctx.globalAlpha = 0.35;
    for (const p of auto) {
        const rg = p.g > 2 ? p.r / p.g : 1;
        const bg = p.g > 2 ? p.b / p.g : 1;
        ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
        ctx.beginPath();
        ctx.arc(toCanvasX(rg), toCanvasY(bg), 3, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;

    // User-sampled points
    for (const p of state.sampledPoints) {
        const rg = p.g > 2 ? p.r / p.g : 1;
        const bg = p.g > 2 ? p.b / p.g : 1;
        ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(toCanvasX(rg), toCanvasY(bg), 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }

    // White point (current WB)
    if (state.meta) {
        const wpX = 1.0;  // with WB applied, neutral should sit near R/G=1, B/G=1
        const wpY = 1.0;
        ctx.strokeStyle = '#f59e0b';
        ctx.fillStyle   = 'rgba(245, 158, 11, 0.2)';
        ctx.lineWidth   = 2;
        ctx.beginPath();
        ctx.arc(toCanvasX(wpX), toCanvasY(wpY), 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle   = '#f59e0b';
        ctx.font        = '10px monospace';
        ctx.textAlign   = 'left';
        ctx.fillText('White point', toCanvasX(wpX) + 13, toCanvasY(wpY) + 4);
    }

    // Update info
    if (state.meta) {
        wbScatterInfo.innerHTML = `
            Camera WB: wb_r=${state.meta.wbR.toFixed(4)}, wb_b=${state.meta.wbB.toFixed(4)}<br>
            Current:   wb_r=${state.currentWbR.toFixed(4)}, wb_b=${state.currentWbB.toFixed(4)}<br>
            <small>Orange circle = white point (unity after WB correction). Grey dashes = neutral locus.</small>
        `;
    }
}

/**
 * Sample N uniformly distributed pixels from RGBA8 buffer.
 */
function autoSample(rgba, w, h, N) {
    const pts = [];
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / N)));
    for (let y = step / 2; y < h; y += step) {
        for (let x = step / 2; x < w; x += step) {
            const px = samplePixel(rgba, Math.floor(x), Math.floor(y), w);
            pts.push(px);
        }
    }
    return pts;
}

// ─── 4. Sign-off Checklist ────────────────────────────────────────────────────

// Golden corpus entries can be provided via query param ?corpus=JSON_URL
// or are loaded from docs/golden-corpus.json if available.
// Each entry: { name, beforeUrl?, afterUrl?, butterThreshold? }

const PASS_THRESHOLD = 0.05;

async function loadCorpus() {
    const params  = new URLSearchParams(location.search);
    const variant = params.get('variant') || '';
    const corpusUrl = params.get('corpus') || null;

    if (corpusUrl) {
        const res = await fetch(corpusUrl);
        return res.json();
    }

    // Inline demo corpus (no network required)
    return [
        { name: 'demo-entry-1', label: 'Example: no image loaded', threshold: PASS_THRESHOLD },
    ];
}

async function initSignoff() {
    let corpus;
    try {
        corpus = await loadCorpus();
    } catch (_) {
        corpus = [];
    }

    if (corpus.length === 0) {
        corpusListEl.innerHTML = `
            <p class="faint">No golden corpus loaded.
            Add <code>?corpus=./docs/golden-corpus.json</code> to load entries,
            or drop RAW files above to compare manually.</p>
        `;
        return;
    }

    corpusListEl.innerHTML = '';
    for (const entry of corpus) {
        const row = document.createElement('div');
        row.className = 'signoff-row';
        row.dataset.name = entry.name;

        const thresh = entry.threshold ?? PASS_THRESHOLD;
        // Status: if we have an after image for this entry, compute score
        let badge = 'PENDING';
        let score = null;

        // If current file matches entry name, compute butteraugli
        if (state.beforeRgba && state.afterRgba && entry.name === state.fileName) {
            const comparer = createButteraugliComparer(state.beforeRgba, state.imageW, state.imageH);
            score = comparer(state.afterRgba);
            badge = isNaN(score) ? 'PENDING' : score < thresh ? 'PASS' : 'REVIEW';
        }

        const badgeColour = badge === 'PASS' ? '#86efac' : badge === 'REVIEW' ? '#fde68a' : '#94a3b8';
        row.innerHTML = `
            <span class="signoff-name">${entry.label || entry.name}</span>
            <span class="badge" style="background:${badgeColour};color:#0f172a;">${badge}</span>
            ${score !== null ? `<span class="signoff-score">butteraugli=${score.toFixed(4)}</span>` : ''}
        `;
        corpusListEl.appendChild(row);
    }
}

approveAllBtn.addEventListener('click', () => {
    signoffStatus.innerHTML = `
        <strong>Manual approval step:</strong><br>
        Run: <code>node scripts/golden-check.mjs --update</code><br>
        This updates the golden corpus checksums.<br>
        (Or use the Tauri <code>invoke('golden_check', {update: true})</code> IPC call.)
    `;
    // Mark all PASS rows as visually approved
    document.querySelectorAll('.signoff-row').forEach(row => {
        const badge = row.querySelector('.badge');
        if (badge && badge.textContent === 'PASS') {
            badge.style.outlineOffset = '2px';
            badge.style.outline = '2px solid #86efac';
        }
    });
});

// ── File loading ──────────────────────────────────────────────────────────────

async function loadFile(file) {
    if (state.loadingDecoder) return;
    state.loadingDecoder = true;
    setStatus(`Loading ${file.name}…`);
    pixelInfo.textContent = '';
    wbSuggestion.textContent = '';
    state.sampledPoints = [];
    updateSampledList();

    try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        state.fileName = file.name;
        state.rawBytes = bytes;

        const res = await workerCall(
            { type: 'decode', bytes, name: file.name },
            [bytes.buffer],
        );

        state.beforeRgba = new Uint8ClampedArray(res.rgba);
        state.afterRgba  = null;
        state.imageW     = res.width;
        state.imageH     = res.height;
        state.meta       = res.meta;
        state.currentWbR = res.meta.wbR;
        state.currentWbB = res.meta.wbB;

        // Set slider defaults to camera values
        sliderWbREl.value = String(res.meta.wbR.toFixed(3));
        sliderWbBEl.value = String(res.meta.wbB.toFixed(3));
        sliderExpEl.value = '0';
        sliderConEl.value = '0';
        sliderSatEl.value = '0';
        updateSliderLabels();

        displayBeforeOnPreviewCanvas();
        updateComparisonPanels();
        updateWbScatter();

        setStatus(
            `${file.name} — ${res.meta.make} ${res.meta.model} ` +
            `ISO ${res.meta.iso} — ` +
            `${res.width}×${res.height} px — ` +
            `WB: R=${res.meta.wbR.toFixed(3)} B=${res.meta.wbB.toFixed(3)}` +
            (res.meta.wbFromCamera ? ' (camera WB)' : ' (manual WB)'),
        );

        // Refresh sign-off
        await initSignoff();

    } catch (err) {
        setStatus('Error: ' + err.message, true);
    } finally {
        state.loadingDecoder = false;
    }
}

// ── Drop + pick handlers ──────────────────────────────────────────────────────

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave',() => { dropZone.classList.remove('drag-over'); });
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files[0];
    if (file) loadFile(file);
});

pickBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
    fileInput.value = '';
});

// ── Init ──────────────────────────────────────────────────────────────────────

wbScatterCanvas.width  = SCATTER_W;
wbScatterCanvas.height = SCATTER_H;
updateSampledList();
updateSliderLabels();
initSignoff().catch(() => {});
updateWbScatter();

// Pre-warm: show COOP/COEP hint if SAB unavailable
if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) {
    setStatus(
        'Warning: page is not cross-origin-isolated. ' +
        'The threaded RAW WASM requires COOP/COEP headers. ' +
        'Open via a local server with proper headers.',
        true,
    );
}
