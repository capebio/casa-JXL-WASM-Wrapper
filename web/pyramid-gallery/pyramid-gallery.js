import { createBrowserContext } from '@casabio/jxl-session';
import { JxlCacheBrowser } from '@casabio/jxl-cache';
import { APPROVED_LIGHTBOX_PRESETS, ADJUSTMENT_PARAMS, createPyramidRuntime } from '@casabio/jxl-pyramid';
import { createGridController } from './grid-controller.js';
import { createPyramidLightbox } from '../lightbox/pyramid-lightbox.js';
import { createImageStore } from './image-store.js'; // S1 wired S2/S3

// Packet 2, Task 1 (findings 74, 77, 78): this modular gallery is the CANONICAL engine of
// record. It constructs exactly ONE long-lived decode runtime at bootstrap and threads it
// through the grid + lightbox, so decode work is orchestrated by a single owned pool instead
// of each decode call spinning up its own (finding 78). The runtime pins the accepted decode
// contract; Task 3 folds the grid/lightbox decode paths onto runtime.decodeLevel.
function detectDecodeCapabilities() {
  const workers = typeof Worker !== 'undefined';
  const sharedMemory =
    globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
  return { workers, sharedMemory, rangeRequests: true, rgba16: true };
}

// One stable worker factory for the runtime's single pool (the same tiled-decode worker the
// pooled decode path uses). Defined once at module scope so the pool is not rebuilt per decode.
const tiledWorkerFactory = () =>
  new Worker(new URL('../lightbox/tiled-decode-worker.js', import.meta.url), { type: 'module' });

const decodeRuntime = createPyramidRuntime({
  workerFactory: tiledWorkerFactory,
  capabilities: detectDecodeCapabilities(),
});

const gridEl = document.getElementById('pyramid-grid');
const urlInput = document.getElementById('gallery-url');
const loadBtn = document.getElementById('load-gallery');
const statusEl = document.getElementById('gallery-status');
const lightboxRoot = document.getElementById('pyramid-lightbox');
const presetSelect = document.getElementById('preset-select');
const sliderPanel = document.getElementById('slider-panel');
const resetBtn = document.getElementById('reset-adjust');

const params = new URLSearchParams(location.search);
if (params.get('gallery')) urlInput.value = params.get('gallery');

/**
 * Lightweight zero-dep index.json validator. Mirrors image-store validateManifest:
 * throws on structural violation so bad/undefined l0/contenthash cannot flow into decode.
 * @param {any} idx
 */
function validateIndex(idx) {
  if (!idx || typeof idx !== 'object') throw new Error('index must be object');
  if (!Array.isArray(idx.images)) throw new Error('index.images must be array');
  for (const entry of idx.images) {
    if (!entry || typeof entry !== 'object') throw new Error('index entry must be object');
    if (typeof entry.imageId !== 'string' || entry.imageId.length === 0) throw new Error('index entry imageId required');
    if (typeof entry.aspect !== 'number' || !(entry.aspect > 0)) throw new Error('index entry aspect must be positive number');
    const l0 = entry.l0;
    if (!l0 || typeof l0 !== 'object') throw new Error('index entry l0 required');
    if (typeof l0.contenthash !== 'string' || l0.contenthash.length === 0) throw new Error('index entry l0 contenthash required');
    if (typeof l0.w !== 'number' || typeof l0.h !== 'number' || l0.w <= 0 || l0.h <= 0) throw new Error('index entry l0 w/h must be positive');
  }
}

const ctx = createBrowserContext();
const cache = new JxlCacheBrowser({ memoryLimit: 128 * 1024 * 1024, persistentLimit: 512 * 1024 * 1024, persistent: true });
await cache.init();

let grid = null;
let lightbox = null;

for (const preset of APPROVED_LIGHTBOX_PRESETS) {
  const opt = document.createElement('option');
  opt.value = preset;
  opt.textContent = preset;
  presetSelect.appendChild(opt);
}

function buildSliders(lb) {
  sliderPanel.replaceChildren();
  for (const key of ADJUSTMENT_PARAMS) {
    const label = document.createElement('label');
    label.textContent = key;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = key === 'shadows' || key === 'clarity' || key === 'dehaze' || key === 'sharpness' ? '0' : '-100';
    input.max = key === 'highlights' ? '0' : '100';
    input.value = '0';
    input.addEventListener('input', () => lb.setAdjustment(key, Number(input.value)));
    label.appendChild(input);
    sliderPanel.appendChild(label);
  }
}

async function loadGallery(baseUrl) {
  const galleryBase = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  statusEl.textContent = 'Loading index…';
  const indexRes = await fetch(new URL('index.json', galleryBase));
  if (!indexRes.ok) throw new Error(`index.json ${indexRes.status}`);
  const index = await indexRes.json();
  validateIndex(index);

  gridEl.replaceChildren();
  for (const entry of index.images) {
    const cell = document.createElement('article');
    cell.className = 'pyramid-cell';
    cell.dataset.imageId = entry.imageId;
    cell.style.setProperty('--aspect', String(entry.aspect));
    cell.title = entry.imageId;
    gridEl.appendChild(cell);
  }

  const indexByImageId = new Map(index.images.map((entry) => [entry.imageId, entry]));
  const imageStore = createImageStore({ cache, galleryBase });
  grid = createGridController({
    ctx,
    cache,
    galleryBase,
    imageStore,
    runtime: decodeRuntime,
    tileSizePx: 220,
    devicePixelRatio: window.devicePixelRatio || 1,
    indexByImageId,
  });
  grid.observeGrid(gridEl);

  lightbox = createPyramidLightbox({ ctx, cache, galleryBase, imageStore, runtime: decodeRuntime, rootEl: lightboxRoot });
  buildSliders(lightbox);
  presetSelect.onchange = () => lightbox.setPreset(presetSelect.value);
  resetBtn.onclick = () => {
    presetSelect.value = 'NONE';
    lightbox.setPreset('NONE');
    for (const input of sliderPanel.querySelectorAll('input')) input.value = '0';
  };

  for (const cell of gridEl.querySelectorAll('[data-image-id]')) {
    cell.addEventListener('click', () => {
      try {
        const imageId = cell.dataset.imageId;
        const entry = indexByImageId.get(imageId);
        if (!entry || !entry.l0) return;
        void lightbox.open(imageId, { contenthash: entry.l0.contenthash, w: entry.l0.w, h: entry.l0.h, tiled: false });
      } catch (err) {
        console.error('lightbox open', err);
      }
    });
  }

  statusEl.textContent = `${index.images.length} images`;
}

loadBtn.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (!url) return;
  loadGallery(url).catch((err) => { statusEl.textContent = String(err); console.error(err); });
});

if (urlInput.value) void loadGallery(urlInput.value);