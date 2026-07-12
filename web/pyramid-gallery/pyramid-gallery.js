import { createBrowserContext } from '@casabio/jxl-session';
import { JxlCacheBrowser } from '@casabio/jxl-cache';
import { APPROVED_LIGHTBOX_PRESETS, ADJUSTMENT_PARAMS, createPyramidRuntime } from '@casabio/jxl-pyramid';
import { createGridController } from './grid-controller.js';
import { createPyramidLightbox } from '../lightbox/pyramid-lightbox.js';
import { createImageStore } from './image-store.js'; // S1 wired S2/S3
// finding 73: the gallery index is untrusted network input too. Validate it through the SAME shared
// schema parser the manifest uses (no divergent inline validator), and fetch it through the trusted
// boundary so a traversal/absolute/redirected/oversized index cannot flow into the grid.
import { parseGalleryIndex } from '../../packages/jxl-pyramid/dist/manifest-validate.js';
import { fetchVerifiedAsset } from './trusted-fetch.js';
// Task 7 (finding 76): activate EXISTING manifest/index fields the shared reader already validates
// but the gallery never consumed — thumbhash placeholder, group ordering, next-page pagination, and
// manifest metadata display. All pure + DOM-free; no new manifest dialect.
import {
  orderByGroup,
  mergeNextPage,
  thumbhashPlaceholderCss,
  decodeThumbhash,
  formatMetadata,
} from './gallery-features.js';

// A gallery index.json is a flat list of image seeds; even a large gallery page is well under this.
const INDEX_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB ceiling (DoS guard on the index body)

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
const metadataEl = document.getElementById('image-metadata');

const params = new URLSearchParams(location.search);
if (params.get('gallery')) urlInput.value = params.get('gallery');


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
  // Fetch index.json through the trusted boundary: `galleryBase` is the user-chosen trusted root, so
  // the index (and everything under it) must stay same-origin + root-contained, byte-capped, and
  // redirect-checked. Then validate through the SAME shared schema parser the manifest uses.
  const indexBuf = await fetchVerifiedAsset({
    root: galleryBase,
    relativePath: 'index.json',
    expectedBytes: INDEX_MAX_BYTES,
    exactBytes: false,
  });
  const index = parseGalleryIndex(JSON.parse(new TextDecoder().decode(new Uint8Array(indexBuf))));

  // finding 76: follow the `next` cursor for sharded (10k+) galleries. The shared reader already
  // returns `index.next`; fetch each shard through the SAME trusted boundary and merge (dedup by
  // imageId). Bounded so a self-referential cursor can't loop forever. `next` absent ⇒ single page.
  let images = index.images;
  let nextPath = index.next;
  const seenShards = new Set(['index.json']);
  let pageGuard = 0;
  while (nextPath && !seenShards.has(nextPath) && pageGuard < 64) {
    seenShards.add(nextPath);
    pageGuard += 1;
    const pageBuf = await fetchVerifiedAsset({
      root: galleryBase,
      relativePath: nextPath,
      expectedBytes: INDEX_MAX_BYTES,
      exactBytes: false,
    });
    const page = parseGalleryIndex(JSON.parse(new TextDecoder().decode(new Uint8Array(pageBuf))));
    images = mergeNextPage(images, page.images);
    nextPath = page.next;
  }

  // finding 76: keep multi-view specimen sets (index `group`) contiguous in the grid. No-op when no
  // entry carries a group (the common single-shot gallery).
  images = orderByGroup(images);

  gridEl.replaceChildren();
  for (const entry of images) {
    const cell = document.createElement('article');
    cell.className = 'pyramid-cell';
    cell.dataset.imageId = entry.imageId;
    if (entry.group) cell.dataset.group = entry.group;
    cell.style.setProperty('--aspect', String(entry.aspect));
    cell.title = entry.imageId;
    // finding 76: paint the L0 seed's thumbhash as an INSTANT colour placeholder BEFORE any JXL
    // bytes are fetched/decoded (the field's documented "instant gallery skeleton" purpose). The
    // grid canvas overwrites it once the first level lands. Absent/short thumbhash ⇒ neutral cell.
    if (entry.thumbhash) {
      const placeholder = thumbhashPlaceholderCss(decodeThumbhash(entry.thumbhash));
      if (placeholder) cell.style.backgroundColor = placeholder;
    }
    gridEl.appendChild(cell);
  }

  const indexByImageId = new Map(images.map((entry) => [entry.imageId, entry]));
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
        // finding 76: surface the manifest's EXISTING metadata (camera/exposure) as a caption. The
        // manifest comes from the shared image store; formatMetadata returns '' when metadata is
        // absent, so an image with no EXIF opens without a caption and never throws.
        void showMetadata(imageStore, imageId);
      } catch (err) {
        console.error('lightbox open', err);
      }
    });
  }

  statusEl.textContent = `${images.length} images`;
}

// finding 76: read the manifest's optional `metadata` dict and render a graceful one-line caption.
// Never rejects — metadata is optional; a missing manifest or empty metadata simply clears the caption.
async function showMetadata(imageStore, imageId) {
  if (!metadataEl) return;
  try {
    const manifest = await imageStore.getManifest(imageId);
    metadataEl.textContent = formatMetadata(manifest && manifest.metadata);
  } catch {
    metadataEl.textContent = '';
  }
}

loadBtn.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (!url) return;
  loadGallery(url).catch((err) => { statusEl.textContent = String(err); console.error(err); });
});

if (urlInput.value) void loadGallery(urlInput.value);