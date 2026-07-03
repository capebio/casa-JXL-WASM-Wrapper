// web/jxl-progressive-gallery.js
// Progressive JXL gallery — local file picker, direct DecodeSession decode.
// Works entirely with local .jxl files; no HTTP server required.
// Feed each file in chunks with emitEveryPass=true to show dc → pass → full.

import { createBrowserContext } from '../packages/jxl-session/dist/index.js';
import { createDecoder, createEncoder, setForcedTier } from '@casabio/jxl-wasm';
import { initDebugConsole, dbgLog } from './jxl-debug-console.js';
import { createGalleryCoordinator } from './jxl-progressive-gallery-coordinator.js';
import { createGalleryLightbox } from './jxl-progressive-gallery-lightbox.js';
import { buildPushBatches } from './jxl-progressive-gallery-push.js';
import {
  createProgressiveWebPreset,
  createSneyersPreset,
  getPushBatchingOptions,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_WINDOW_SIZE,
} from './jxl-progressive-best-preset.js';
import { packFramePixels } from './jxl-progressive-gallery-frame.js';

// Console page header — always shows which page this console belongs to (dev productivity across many open lab/benchmark tabs)
console.log('%c[Progressive Gallery] jxl-progressive-gallery.js loaded — multi-frame progressive gallery + lightbox', 'color:#06b6d4;font-weight:600', { page: 'Progressive Gallery', url: location.href, t: new Date().toISOString(), ua: navigator.userAgent.slice(0, 120) });

// ── DOM refs ──────────────────────────────────────────────────────────────────

const sourceInput   = document.getElementById('source-input');
const pickerStatus  = document.getElementById('picker-status');
const concurrentEl  = document.getElementById('concurrent');
const concurrentVal = document.getElementById('concurrent-val');
const galleryRowsEl  = document.querySelector('[data-gallery-rows]');
const lightboxRoot   = document.querySelector('[data-lightbox-root]');
const logEl         = document.getElementById('log');
const dbgConsoleBtn = document.getElementById('dbg-console-btn');
const decodeBtn     = document.getElementById('decode-btn');
const decodePushedBtn = document.getElementById('decode-pushed-btn');
const wasmTierEl    = document.getElementById('wasm-tier');
const pushModeButtons = [...document.querySelectorAll('[data-push-mode]')];

// ── State ─────────────────────────────────────────────────────────────────────

let ctx = null;
let ctxReadyPromise = null;
let pushMode = 'all-chunks';
let pendingFiles = null;
let activeKeyHandler = null;  // cleaned up on each startGallery() call
let lastPushedPayload = null;
let currentGalleryAbort = null;
const consumedPushIds = new Map(); // id -> ts, bounded

const CHUNK_SIZE = 65536; // 64 KiB per chunk
// Keep this comfortably above the scheduler drain HWM so the worker can
// actually consume enough bytes to emit drain on large codestreams.
const WINDOW_SIZE = 32;
const MAX_LOG_ENTRIES = 200;

// ── Init ──────────────────────────────────────────────────────────────────────

ctxReadyPromise = (async () => {
  try {
    ctx = createBrowserContext();
    log('JXL context ready');
    dbgLog('JXL context ready');
  } catch (e) {
    log(`Init error: ${e.message}`, 'error');
    dbgLog('Init error', e.message, 'error');
  }
})();
// ctx used only for readiness/side-effect init of WASM bindings.
// Actual per-file progressive decodes use direct createDecoder + explicit chunk push
// (required for windowed/all-chunks feed + yield between batches for passes detail checkpoints).

if (dbgConsoleBtn) initDebugConsole(dbgConsoleBtn);
if (decodePushedBtn) {
  decodePushedBtn.addEventListener('click', async () => {
    if (!lastPushedPayload) return;
    try {
      await decodePushedGalleryPayload(lastPushedPayload);
    } catch (e) {
      log(`Pushed file decode error: ${e.message}`, 'error');
    }
  });
}
wirePushModeControls();
wireProgressivePaintHandoff();
wireDragAndDrop();

// ── Controls ──────────────────────────────────────────────────────────────────

concurrentEl.addEventListener('input', () => {
  concurrentVal.textContent = concurrentEl.value;
});

function getGalleryProgressiveDetail() {
  const sel = document.getElementById('gallery-prog-detail');
  // Default to 'passes' so that when testing multi-layer encodes (Dc=2 + groupOrder from paint/gallery onfly)
  // the benchmark actually shows the earlier + more passes the user asked for.
  return sel ? sel.value : 'passes';
}

// getGalleryEncodeOptions removed (pass 2): preset (basePreset.encode) is now the single source.
// Logging in decodeBtn click hardcodes the DOM reads for the galleryStartLine instead.

function applyPushedGallerySettings(settings) {
  if (!settings) return;
  const detailEl = document.getElementById('gallery-prog-detail');
  if (detailEl && settings.progressiveDetail) {
    detailEl.value = settings.progressiveDetail;
  }
  const previewEl = document.getElementById('gallery-preview-first');
  if (previewEl && settings.previewFirst != null) {
    previewEl.checked = settings.previewFirst;
  }
  const dcEl = document.getElementById('gallery-prog-dc');
  if (dcEl && settings.progressiveDc != null) {
    dcEl.value = String(settings.progressiveDc);
  }
  const groupEl = document.getElementById('gallery-group-order');
  if (groupEl && settings.groupOrder != null) {
    groupEl.checked = settings.groupOrder === 1;
  }
}

async function ingestPushedGalleryPayload(payload) {
  if (!payload) return;
  // allow batch payloads (which have .items not top-level .bytes) for multi from paint
  if (!payload?.bytes && !(payload.batch && Array.isArray(payload.items))) return;
  if (payload.transferId && consumedPushIds.has(payload.transferId)) return;
  if (payload.transferId) {
    consumedPushIds.set(payload.transferId, Date.now());
    // bound size
    if (consumedPushIds.size > 128) {
      const oldest = [...consumedPushIds.entries()].sort((a,b)=>a[1]-b[1])[0]?.[0];
      if (oldest) consumedPushIds.delete(oldest);
    }
  }

  await decodePushedGalleryPayload(payload);
}

async function decodePushedGalleryPayload(payload) {
  if (!payload) return;
  lastPushedPayload = payload;
  syncPushedAction();

  if (payload.batch && Array.isArray(payload.items) && payload.items.length > 0) {
    applyPushedGallerySettings(payload.items[0]?.settings);
    const count = payload.items.length;
    pickerStatus.textContent = `Received ${count} file(s) from Progressive Paint. Decoding now...`;
    galleryRowsEl.innerHTML = '';
    log(`Auto-ingesting pushed batch of ${count} progressive JXL(s) from paint`);

    await ctxReadyPromise;
    if (!ctx) throw new Error('Context failed to initialize');
    const files = payload.items.map((it, i) => {
      const fname = it.name || it.filename || `pushed-from-paint-${i}.jxl`;
      return new File([it.bytes], fname, { type: 'image/jxl' });
    });
    const result = await startGallery(files, { encodeOnTheFly: false });
    if (result.totalFrames > 0) {
      pickerStatus.textContent = `Decoded pushed batch of ${files.length} file(s). Click thumbnails to inspect progressive frames per image.`;
    } else {
      pickerStatus.textContent = `Pushed batch received, but no frames rendered. Use "Decode pushed file" to retry.`;
    }
    return;
  }

  if (!payload?.bytes) return;
  applyPushedGallerySettings(payload.settings);

  const filename = payload.name || payload.filename || 'pushed-from-paint.jxl';

  pickerStatus.textContent = `Received from Progressive Paint: ${filename}. Decoding now...`;
  galleryRowsEl.innerHTML = '';
  log(`Auto-ingesting pushed progressive JXL: ${filename}`);

  await ctxReadyPromise;
  if (!ctx) throw new Error('Context failed to initialize');
  const result = await startGallery([new File([payload.bytes], filename, { type: 'image/jxl' })], { encodeOnTheFly: false });
  if (result.totalFrames > 0) {
    pickerStatus.textContent = `Decoded pushed file: ${filename}. Click any thumbnail to inspect progressive frames.`;
  } else {
    pickerStatus.textContent = `Pushed file received, but no frames rendered. Use Decode pushed file to retry, or send a fresh file from Progressive Paint.`;
  }
}

function syncPushedAction() {
  if (!decodePushedBtn) return;
  if (lastPushedPayload) {
    const isBatch = !!(lastPushedPayload.batch && Array.isArray(lastPushedPayload.items) && lastPushedPayload.items.length > 1);
    const n = isBatch ? lastPushedPayload.items.length : 1;
    decodePushedBtn.textContent = isBatch ? `Decode pushed batch (${n})` : 'Decode pushed file';
  } else {
    decodePushedBtn.textContent = 'Decode pushed file';
  }
  decodePushedBtn.hidden = !lastPushedPayload;
}

function wireProgressivePaintHandoff() {
  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin) return;
    // Hardening: only accept pushes from our opener (the Progressive Paint window
    // that launched us). Symmetric with the sender's ev.source !== targetWindow
    // guard in jxl-progressive-paint.js. Tolerate a missing opener (e.g. direct
    // open / autopush) so non-opener flows are not broken.
    if (window.opener && ev.source && ev.source !== window.opener) return;
    if (ev.data?.type === 'progressive-gallery-push') {
      const payload = ev.data.payload;
      ingestPushedGalleryPayload(payload)
        .catch(e => log(`Auto-push gallery error: ${e.message}`, 'error'));
    }
  });

  if (window.opener) {
    window.opener.postMessage({ type: 'progressive-gallery-ready' }, location.origin);
  }
}

sourceInput.addEventListener('change', () => {
  const allFiles = [...sourceInput.files];
  const jxlFiles = allFiles.filter(f => /\.jxl$/i.test(f.name));
  const rawFiles = allFiles.filter(f => /\.(png|jpe?g|webp)$/i.test(f.name));
  const filesToUse = jxlFiles.length > 0 ? jxlFiles : rawFiles;

  if (filesToUse.length === 0) {
    pickerStatus.textContent = 'Pick .jxl files (or PNG/JPG for on-the-fly encode demo)';
    pendingFiles = null;
    if (decodeBtn) decodeBtn.hidden = true;
    return;
  }

  pendingFiles = { files: filesToUse, encodeOnTheFly: rawFiles.length > 0 && jxlFiles.length === 0 };
  pickerStatus.textContent = `${filesToUse.length} file${filesToUse.length > 1 ? 's' : ''} ready${pendingFiles.encodeOnTheFly ? ' (will encode)' : ''} — click Decode`;
  if (decodeBtn) decodeBtn.hidden = false;
});

if (decodeBtn) {
  decodeBtn.addEventListener('click', () => {
    if (!pendingFiles) return;
    const { files, encodeOnTheFly } = pendingFiles;
    galleryRowsEl.innerHTML = '';
    const _tier   = wasmTierEl?.value ?? 'auto';
    const _push   = pushMode;
    const _decode = getGalleryProgressiveDetail();
    const _prev   = document.getElementById('gallery-preview-first')?.checked ? 'on' : 'off';
    const _dc     = document.getElementById('gallery-prog-dc')?.value ?? '?';
    const _center = document.getElementById('gallery-group-order')?.checked ? 'on' : 'off';
    const galleryStartLine = `Gallery start · ${files.length} file${files.length > 1 ? 's' : ''} · tier=${_tier} · push=${_push} · decode=${_decode} · preview=${_prev} · dc=${_dc} · center-out=${_center}`;
    log(galleryStartLine);
    dbgLog(galleryStartLine);
    startGallery(files, { encodeOnTheFly }).catch(e => log(`Gallery error: ${e.message}`, 'error'));
  });
}

if (wasmTierEl) {
  wasmTierEl.addEventListener('change', () => {
    const val = wasmTierEl.value;
    setForcedTier(val === 'auto' ? null : val);
    log(`WASM tier → ${val}`);
  });
}

// Predator push support: if paint page "pushed" a JXL via localStorage (or ?autopush), auto-ingest it as a .jxl
// so you can immediately see multi-layer progressive decode without manual pick. Clears after use.
function consumePendingProgressivePush() {
  try {
    const raw = localStorage.getItem('__progGalleryPush');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    localStorage.removeItem('__progGalleryPush');
    const items = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    const now = Date.now();
    const valid = items.filter(it => it && it.b64 && (now - (it.ts || 0) < 5 * 60 * 1000));
    if (!valid.length) return null;
    const decoded = valid.map(({ name, b64, settings }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { filename: name || 'pushed-from-paint.jxl', bytes, settings };
    });
    if (decoded.length === 1) {
      return decoded[0];
    }
    return {
      batch: true,
      items: decoded.map(d => ({ name: d.filename, bytes: d.bytes, settings: d.settings }))
    };
  } catch (e) {
    console.warn('[gallery] consume push failed', e);
    localStorage.removeItem('__progGalleryPush');
    return null;
  }
}

(function autoIngestPushIfPresent() {
  const urlHasAuto = /[?&]autopush=1/.test(location.search);
  const pending = consumePendingProgressivePush();
  if (pending) {
    decodePushedGalleryPayload(pending)
      .catch(e => log(`Auto-push gallery error: ${e.message}`, 'error'));
  } else if (urlHasAuto) {
    pickerStatus.textContent = 'Opened for autopush — generate in paint page and click "Send to Progressive Gallery" to push a test file here.';
  }
})();

function wireDragAndDrop() {
  let dragDepth = 0;

  document.addEventListener('dragenter', (ev) => {
    if ([...ev.dataTransfer.types].includes('Files')) {
      dragDepth++;
      document.body.classList.add('drag-over');
    }
  });

  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('drag-over');
  });

  document.addEventListener('dragover', (ev) => {
    if ([...ev.dataTransfer.types].includes('Files')) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    }
  });

  document.addEventListener('drop', (ev) => {
    dragDepth = 0;
    document.body.classList.remove('drag-over');
    if (![...ev.dataTransfer.types].includes('Files')) return;
    ev.preventDefault();

    const all = [...ev.dataTransfer.files];
    const jxlFiles = all.filter(f => /\.jxl$/i.test(f.name));
    const rawFiles = all.filter(f => /\.(png|jpe?g|webp)$/i.test(f.name));
    const files = jxlFiles.length > 0 ? jxlFiles : rawFiles;
    if (files.length === 0) {
      log(`Drop ignored — no .jxl / image files in ${all.length} dropped item(s)`, 'warn');
      return;
    }

    const encodeOnTheFly = rawFiles.length > 0 && jxlFiles.length === 0;
    galleryRowsEl.innerHTML = '';
    log(`Drop: ${files.length} file${files.length > 1 ? 's' : ''} → starting gallery`);
    startGallery(files, { encodeOnTheFly }).catch(e => log(`Gallery error: ${e.message}`, 'error'));
  });
}

function wirePushModeControls() {
  for (const button of pushModeButtons) {
    button.addEventListener('click', () => {
      const next = button.dataset.pushMode;
      if (!next || next === pushMode) return;
      pushMode = next;
      syncPushModeButtons();
      dbgLog(`Push mode → ${next}`);
    });
  }
  syncPushModeButtons();
}

function syncPushModeButtons() {
  for (const button of pushModeButtons) {
    const active = button.dataset.pushMode === pushMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

// ── Slot management ───────────────────────────────────────────────────────────

function slotId(file) {
  return `slot-${file.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

// ── Gallery pipeline (round-robin reveal + lightbox) ──────────────────────────

async function startGallery(selectedFiles, { encodeOnTheFly = false } = {}) {
  if (!ctx) {
    log('Context not ready', 'warn');
    return { totalFrames: 0 };
  }

  // Abort prior (prevents decoder leaks, overlapping pushes, pixel buffer accumulation on rapid multi-asset switches/pushes)
  if (currentGalleryAbort) currentGalleryAbort.abort();
  currentGalleryAbort = new AbortController();
  const signal = currentGalleryAbort.signal;

  // Derive from preset (single source of truth, Sneyers baseline, cutoffs for adaptive push)
  const progDetail = getGalleryProgressiveDetail();
  const basePreset = createProgressiveWebPreset({
    width: 1, height: 1, targetLongEdge: 'full',
    progressiveDetail: progDetail === 'auto' ? null : progDetail,
  });
  const encodeOpts = encodeOnTheFly ? {
    previewFirst: basePreset.encode.previewFirst,
    progressiveDc: basePreset.encode.progressiveDc,
    groupOrder: basePreset.encode.groupOrder,
  } : null;

  // Remove any previous keyboard handler from prior gallery load
  if (activeKeyHandler) {
    document.removeEventListener('keydown', activeKeyHandler);
    activeKeyHandler = null;
  }

  // Build per-file row elements
  const stripEls = new Map(); // fileId → <div class="thumb-strip">
  const cellMaps = new Map(); // fileId → Map<frameIndex, HTMLElement>
  for (const file of selectedFiles) {
    const fileId = slotId(file);
    const rowEl = document.createElement('div');
    rowEl.className = 'gallery-row';
    rowEl.dataset.fileId = fileId;

    const labelEl = document.createElement('div');
    labelEl.className = 'gallery-row-label';
    labelEl.textContent = file.name;

    const stripEl = document.createElement('div');
    stripEl.className = 'thumb-strip';

    rowEl.append(labelEl, stripEl);
    galleryRowsEl.appendChild(rowEl);
    stripEls.set(fileId, stripEl);
    cellMaps.set(fileId, new Map());
  }

  // round-robin coordinator controls when each frame becomes visible
  const coordinator = createGalleryCoordinator({
    files: selectedFiles.map(file => ({
      fileId: slotId(file),
      name: file.name,
      byteLength: file.size,
    })),
  });
  // Wire priority oracle (connected exploration): exposes per-file visible frontier for AR/focus/photogram boost.
  // Not yet used to modulate runLimited/push (future delivery intelligence), but now explicitly surfaced.
  const _priorities = coordinator.getPriorityTargets();

  // framesByFile is a live Map used by the lightbox
  const framesByFile = new Map(selectedFiles.map(f => [slotId(f), []]));

  const lightbox = createGalleryLightbox({ framesByFile });
  // Baseline constancy (Lens17 prep / Perceptual Constancy Mode path). Gallery already forwards params
  // in renderLightboxState -> draw -> pack. UI/preset can call set later.
  lightbox.setConstancyParams({ mode: 'off', exposure: 0, saturation: 0, whiteBalance: [1, 1, 1] });

  // Keyboard handler for lightbox navigation
  function onKey(ev) {
    if (!lightboxRoot || lightboxRoot.hidden) return;  // lightbox not visible
    const cur = lightbox.current();
    if (!cur) return;
    if (ev.key === 'Escape') {
      closeLightbox();
      return;
    }
    lightbox.handleKey(ev);
    const next = lightbox.current();
    if (next) renderLightboxState(next);
  }
  activeKeyHandler = onKey;
  document.addEventListener('keydown', onKey);

  // Re-render all file strips based on current coordinator visibility
  const dirtyStrips = new Set();
  let rafId = 0;
  function requestRender(fileId) {
    dirtyStrips.add(fileId);
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      for (const fid of dirtyStrips) {
        const stripEl = stripEls.get(fid);
        if (stripEl) {
          const visible = coordinator.visibleFrames(fid);
          syncStrip(stripEl, fid, visible);
        }
      }
      dirtyStrips.clear();
    });
  }
  function reRenderAll() {
    dirtyStrips.clear();
    for (const [fileId, stripEl] of stripEls) {
      const visible = coordinator.visibleFrames(fileId);
      syncStrip(stripEl, fileId, visible);
    }
  }

  function syncStrip(stripEl, fileId, frames) {
    if (!cellMaps.has(fileId)) {
      cellMaps.set(fileId, new Map());
    }
    const cellMap = cellMaps.get(fileId);

    const wantedIndices = new Set(frames.map(f => f.frameIndex));

    // Remove cells no longer visible
    for (const [idx, el] of cellMap) {
      if (!wantedIndices.has(idx)) {
        el.remove();
        cellMap.delete(idx);
      }
    }

    // Add or update cells
    for (const frame of frames) {
      if (cellMap.has(frame.frameIndex)) {
        updateThumbCell(cellMap.get(frame.frameIndex), frame);
      } else {
        const cell = createThumbCell(fileId, frame);
        stripEl.appendChild(cell);
        cellMap.set(frame.frameIndex, cell);
      }
    }
  }

  function createThumbCell(fileId, frame) {
    const cell = document.createElement('div');
    cell.className = 'thumb-cell';
    cell.dataset.fileId = fileId;
    cell.dataset.frameIndex = frame.frameIndex;
    cell.setAttribute('tabindex', '0');
    cell.setAttribute('role', 'button');
    cell.setAttribute('aria-label', `Open ${frame.stage} frame in lightbox`);

    const canvas = document.createElement('canvas');
    drawFrameToCanvas(canvas, frame);

    const metaEl = document.createElement('div');
    metaEl.className = 'thumb-meta';
    metaEl.textContent = formatFrameMeta(frame);

    cell.append(canvas, metaEl);

    const open = () => {
      lightbox.open(fileId, frame.frameIndex);
      renderLightboxState({ fileId, frameIndex: frame.frameIndex });
    };
    cell.addEventListener('click', open);
    cell.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        open();
      }
    });

    return cell;
  }

  function updateThumbCell(cell, frame) {
    const canvas = cell.querySelector('canvas');
    if (canvas) drawFrameToCanvas(canvas, frame);
    const metaEl = cell.querySelector('.thumb-meta');
    if (metaEl) metaEl.textContent = formatFrameMeta(frame);
  }

  function formatFrameMeta(frame) {
    const pct = typeof frame.percentFed === 'number' ? frame.percentFed.toFixed(1) : '?';
    const bytes = typeof frame.bytesFed === 'number' ? frame.bytesFed.toLocaleString() : '?';
    const total = typeof frame.totalBytes === 'number' ? frame.totalBytes.toLocaleString() : '?';
    const ms = typeof frame.elapsedMs === 'number' ? frame.elapsedMs.toFixed(1) : '?';
    return `${frame.stage} · ${ms} ms · ${bytes} / ${total} bytes · ${pct}%`;
  }

  function renderLightboxState({ fileId, frameIndex }) {
    const frames = framesByFile.get(fileId) ?? [];
    const frame = frames[frameIndex];
    if (!frame) return;

    const canvas = document.getElementById('lightbox-canvas');
    if (canvas) {
      const params = (lightbox && typeof lightbox.getConstancyParams === 'function')
        ? lightbox.getConstancyParams()
        : undefined;
      drawFrameToCanvas(canvas, frame, params);
    }

    const metaEl = document.getElementById('lightbox-meta');
    if (metaEl) metaEl.textContent = `${fileId.replace(/^slot-/, '')} — frame ${frameIndex} — ${formatFrameMeta(frame)}`;

    openLightboxOverlay();
  }

  function openLightboxOverlay() {
    if (!lightboxRoot) return;
    lightboxRoot.hidden = false;
    lightboxRoot.classList.add('is-open');
    if (lightboxRoot.requestFullscreen) {
      lightboxRoot.requestFullscreen().catch(() => {/* overlay fallback already works */});
    }
  }

  function closeLightbox() {
    if (!lightboxRoot) return;
    lightboxRoot.hidden = true;
    lightboxRoot.classList.remove('is-open');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  async function loadImageToRgba(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx2d = c.getContext('2d');
      ctx2d.drawImage(img, 0, 0);
      const data = ctx2d.getImageData(0, 0, c.width, c.height);
      const d = data.data;
      return { rgba: new Uint8Array(d.buffer, d.byteOffset, d.byteLength), width: c.width, height: c.height };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function encodeToProgressiveJxl(rgbaData, encodeOptions) {
    const { width, height, rgba } = rgbaData;
    const enc = createEncoder({
      format: 'rgba8',
      width,
      height,
      hasAlpha: true,
      quality: encodeOptions?.quality ?? 82,
      effort: encodeOptions?.effort ?? 4,
      progressive: true,
      previewFirst: encodeOptions.previewFirst,
      progressiveDc: encodeOptions.progressiveDc,
      groupOrder: encodeOptions.groupOrder,
      chunked: false,
    });

    const chunks = [];
    const pushTask = (async () => {
      for await (const ch of enc.chunks()) {
        chunks.push(ch instanceof Uint8Array ? ch : new Uint8Array(ch));
      }
    })();

    await enc.pushPixels(rgba);
    await enc.finish();
    await pushTask;
    await enc.dispose();

    // Concatenate
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  }

  // Concurrency limiter from the (previously unused) slider. Default 4 to protect worker pool / scheduler under multi-asset gallery.
  const maxConc = Math.max(1, parseInt(concurrentEl?.value || '4', 10));
  const limiter = (max) => {
    let active = 0;
    const waiters = [];
    return (fn) => new Promise((resolve, reject) => {
      const run = async () => {
        active++;
        try { resolve(await fn()); }
        catch (e) { reject(e); }
        finally {
          active--;
          if (waiters.length) waiters.shift()();
        }
      };
      if (active < max) run();
      else waiters.push(run);
    });
  };
  const runLimited = limiter(maxConc);

  // Decode all files (now limited + abort-aware), register frames with coordinator
  const filePromises = selectedFiles.map(file => runLimited(async () => {
    const fileId = slotId(file);
    if (signal.aborted) return 0;

    let buffer;
    const loadStart = Date.now();
    try {
      if (encodeOnTheFly) {
        log(`${file.name}: encoding on the fly with progressiveDc=${encodeOpts.progressiveDc}, groupOrder=${encodeOpts.groupOrder}, previewFirst=${encodeOpts.previewFirst}...`);
        const raw = await loadImageToRgba(file);
        if (signal.aborted) return 0;
        buffer = await encodeToProgressiveJxl(raw, basePreset.encode);
        const encodeMs = Date.now() - loadStart;
        log(`${file.name}: encoded to ${(buffer.byteLength / 1024).toFixed(1)} KB progressive JXL in ${encodeMs.toFixed(1)} ms`);
        dbgLog(`${file.name}: encoded to ${(buffer.byteLength / 1024).toFixed(1)} KB progressive JXL in ${encodeMs.toFixed(1)} ms`);
      } else {
        buffer = await file.arrayBuffer();
        if (signal.aborted) return 0;
        const loadMs = Date.now() - loadStart;
        log(`${file.name}: loaded ${(buffer.byteLength / 1024).toFixed(1)} KB in ${loadMs.toFixed(1)} ms`);
        dbgLog(`${file.name}: loaded ${(buffer.byteLength / 1024).toFixed(1)} KB in ${loadMs.toFixed(1)} ms`);
      }
    } catch (e) {
      log(`${file.name}: ${encodeOnTheFly ? 'encode' : 'read'} error — ${e.message}`, 'error');
      return 0;
    }

    const decodeStartMs = Date.now();
    const decodingLine = `Decoding ${file.name} · ${buffer.byteLength} bytes · mode=${pushMode} (after load)`;
    log(decodingLine);
    dbgLog(decodingLine);

    // Use preset.decode (unified, includes defaults + any future preserve from pushed/photogram/AR)
    const decoder = createDecoder({
      ...basePreset.decode,
      // gallery forces false only for pure lab memory viz; callers that pass preserve* via preset win for color fidelity
      preserveIcc: basePreset.decode.preserveIcc ?? false,
      preserveMetadata: basePreset.decode.preserveMetadata ?? false,
    });

    const pushState = { bytesFed: 0 };
    const pushOpts = getPushBatchingOptions(buffer.byteLength, {
      chunkSize: CHUNK_SIZE,
      windowSize: WINDOW_SIZE,
      byteCutoffs: basePreset.byteCutoffs,
    });
    const pushBatches = buildPushBatches(buffer, { mode: pushMode, ...pushOpts });
    const pushPromise = (async () => {
      for (const batch of pushBatches) {
        if (signal.aborted) break;
        await Promise.all(batch.map(chunk => {
          if (signal.aborted) return;
          pushState.bytesFed += chunk.byteLength;
          return decoder.push(chunk);
        }));
      }
      if (!signal.aborted) await decoder.close();
    })();

    let frameIndex = 0;
    const framesPromise = (async () => {
      for await (const ev of decoder.events()) {
        if (signal.aborted) break;
        if (ev.type === 'header') {
          const hMs = Date.now() - decodeStartMs;
          const headerLine = `${file.name}: header ${ev.info.width}×${ev.info.height} @ ${hMs.toFixed(1)} ms`;
          log(headerLine);
          dbgLog(headerLine);
          continue;
        }
        if (ev.type === 'error') {
          throw new Error(`Decoder error (${ev.code}): ${ev.message}`);
        }
        if (!(ev.type === 'progress' || ev.type === 'final')) continue;

        const elapsedMs = Date.now() - decodeStartMs;
        const bytesFed = Math.min(buffer.byteLength, pushState.bytesFed);
        const percentFed = buffer.byteLength ? (bytesFed / buffer.byteLength) * 100 : 100;

        const enriched = {
          info: ev.info,
          pixels: ev.pixels,
          format: ev.format,
          pixelStride: ev.pixelStride,
          ...(ev.region !== undefined ? { region: ev.region } : {}),
          frameIndex: frameIndex++,
          elapsedMs,
          bytesFed,
          percentFed,
          totalBytes: buffer.byteLength,
          stage: ev.type === 'final' ? 'final' : ev.stage,
        };
        // Invariant: framesByFile (arrival-order push, read by the lightbox as
        // frames[frameIndex]) and the coordinator (sparse frames[frameIndex]=)
        // stay consistent only because frameIndex is a per-file monotone counter
        // pushed in lockstep. Guard it so a gap/reorder desyncs loudly instead of
        // silently mis-indexing the lightbox.
        const fileFrames = framesByFile.get(fileId);
        if (fileFrames.length !== enriched.frameIndex) {
          console.error('[gallery] frame-store desync', { fileId, pushIndex: fileFrames.length, frameIndex: enriched.frameIndex });
        }
        fileFrames.push(enriched);
        coordinator.registerFrame(fileId, enriched);
        requestRender(fileId);
        const frameLine = `${file.name}: [${enriched.stage}] ${elapsedMs.toFixed(1)} ms · ${bytesFed.toLocaleString()} / ${buffer.byteLength.toLocaleString()} B · ${percentFed.toFixed(1)}%`;
        log(frameLine);
        dbgLog(frameLine);
      }
      if (!signal.aborted) {
        coordinator.markFileClosed(fileId);
        requestRender(fileId);
        const doneLine = `${file.name}: done (${frameIndex} frame${frameIndex !== 1 ? 's' : ''})`;
        log(doneLine);
        dbgLog(doneLine, '', 'success');
      }
    })();

    try {
      await Promise.all([pushPromise, framesPromise]);
      return frameIndex;
    } catch (e) {
      const errLine = `${file.name}: ${e.message}`;
      log(errLine, 'error');
      dbgLog(errLine, e.stack ?? '', 'error');
      return frameIndex;
    } finally {
      await decoder.dispose();
    }
  }));

  const frameCounts = await Promise.all(filePromises);
  // cleanup this controller if still ours (supports cancel while running)
  if (currentGalleryAbort && currentGalleryAbort.signal === signal) currentGalleryAbort = null;
  return {
    totalFrames: frameCounts.reduce((sum, count) => sum + (count || 0), 0),
  };
}

function drawFrameToCanvas(canvas, frame, constancyParams) {
  const { width, height } = frame.info;
  canvas.width = width;
  canvas.height = height;
  const ctx2d = canvas.getContext('2d');
  let pixelsForImage;
  if (typeof frame.getImageData === 'function') {
    const gid = frame.getImageData();
    pixelsForImage = gid && gid.data ? gid.data : gid;
  } else {
    pixelsForImage = packFramePixels(frame, { constancyParams });
  }
  const imageData = (pixelsForImage instanceof ImageData)
    ? pixelsForImage
    : new ImageData(pixelsForImage, width, height);
  ctx2d.putImageData(imageData, 0, 0);
}

// ── Log ───────────────────────────────────────────────────────────────────────

function log(msg, level = 'info') {
  const line = document.createElement('div');
  const ts = new Date().toISOString().slice(11, 23);
  line.textContent = `${ts} ${msg}`;
  if (level === 'error') line.style.color = '#f66';
  if (level === 'warn')  line.style.color = '#fa0';
  logEl.appendChild(line);
  while (logEl.childElementCount > MAX_LOG_ENTRIES) {
    logEl.firstElementChild.remove();
  }
  logEl.scrollTop = logEl.scrollHeight;
}
