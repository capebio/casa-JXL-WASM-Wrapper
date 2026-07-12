import { expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';

const galleryJs = readFileSync(new URL('./pyramid-gallery.js', import.meta.url), 'utf8');
const gridJs = readFileSync(new URL('./grid-controller.js', import.meta.url), 'utf8');
const decodeJs = readFileSync(new URL('./pyramid-decode.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./pyramid-gallery.html', import.meta.url), 'utf8');
const lightboxJs = readFileSync(new URL('../lightbox/pyramid-lightbox.js', import.meta.url), 'utf8');
const storeJs = readFileSync(new URL('./image-store.js', import.meta.url), 'utf8');
const legacyRedirectHtml = readFileSync(new URL('../pyramid-gallery.html', import.meta.url), 'utf8');

test('gallery fetches index.json before level bytes and lays out by aspect', () => {
  // The index is fetched through the trusted boundary (Task 8) with galleryBase as the trusted root.
  expect(galleryJs).toContain('fetchVerifiedAsset');
  expect(galleryJs).toContain("relativePath: 'index.json'");
  expect(galleryJs).toContain('--aspect');
  expect(html).toContain('data-pyramid-grid');
});

test('gallery validates the index through the shared schema parser and the trusted fetch boundary (finding 73)', () => {
  // No divergent inline validator: the index flows through the SAME reader the manifest uses.
  expect(galleryJs).toContain('parseGalleryIndex');
  expect(galleryJs).not.toContain('function validateIndex');
  // index + manifest + level fetches all route through fetchVerifiedAsset.
  expect(galleryJs).toContain('fetchVerifiedAsset');
  expect(storeJs).toContain('fetchVerifiedAsset');
});

test('grid uses scheduler one-shot decode with contenthash sourceKey', () => {
  expect(decodeJs).toContain('progressionTarget: \'final\'');
  expect(decodeJs).toContain('emitEveryPass: false');
  expect(decodeJs).toContain('sourceKey: opts.contenthash');
  // finding 26: the grid routes level selection through the ONE resolver, not a local
  // chooseLevelForTarget copy. The resolver internally owns that selection.
  expect(gridJs).toContain('resolveLod');
  expect(gridJs).not.toContain('chooseLevelForTarget(');
  expect(gridJs).toContain('shouldUpgrade');
});

test('grid owns shared decode via the refcounted lease registry, not a bespoke joiner counter (finding 49)', () => {
  // The shared-decode ownership is delegated to createInflightDecodes so a
  // no-signal caller cannot be made invisible by an aborting joiner.
  expect(gridJs).toContain('createInflightDecodes');
  expect(gridJs).toContain('inflight.decode(');
  // Every caller owns ONE lease and releases it in a finally.
  expect(gridJs).toContain('lease.release()');
  expect(gridJs).toMatch(/finally\s*\{[\s\S]*lease\.release\(\)/);
  // The old ad-hoc joiner-counting scheme must be gone.
  expect(gridJs).not.toContain('job.joiners');
});

test('grid implements L0 seed from index then monotonic upgrade', () => {
  expect(gridJs).toContain('indexByImageId');
  expect(gridJs).toContain('entry?.l0');
  expect(gridJs).toContain('shouldUpgrade');
  expect(gridJs).toContain("canvas.style.transition = 'opacity 180ms ease'");
});

test('tiled decode wires parallel worker factory', () => {
  expect(decodeJs).toContain('workerFactory');
  expect(decodeJs).toContain('tiled-decode-worker.js');
});

test('lightbox wires FilterEngine presets, zoom readout, and tiled ROI', () => {
  expect(lightboxJs).toContain('buildColorMatrix');
  expect(lightboxJs).toContain('data-zoom-pct');
  expect(lightboxJs).toContain('level.tiled');
  expect(lightboxJs).toContain('computeHistogram');
  expect(lightboxJs).toContain('shouldUpgrade');
  expect(lightboxJs).toContain('crossfade');
  expect(lightboxJs).toContain('renderRgba16AdjustedToCanvas');
  expect(lightboxJs).toContain('decodePyramidRegion');
  expect(lightboxJs).toContain('exportRoi');
  expect(lightboxJs).toContain('encodeRgba16');
  expect(lightboxJs).toContain("format: use16 ? 'rgba16' : 'rgba8'");
});

test('S1->S3->S2 image-store handoff: store centralizes manifest/level fetch; grid+lightbox delegate; no dupe', () => {
  expect(storeJs).toContain('createImageStore');
  expect(storeJs).toContain('getManifest');
  expect(storeJs).toContain('getLevelBytes');
  expect(storeJs).toContain('level:');
  expect(galleryJs).toContain('createImageStore');
  expect(galleryJs).toContain('imageStore');
  expect(gridJs).toContain('imageStore');
  expect(gridJs).toContain('getManifest');
  expect(gridJs).toContain('getLevelBytes');
  expect(lightboxJs).toContain('imageStore');
  expect(lightboxJs).toContain('getManifest');
  expect(lightboxJs).toContain('getLevelBytes');
  // index fetch stays in gallery root (per design); level/manifest now via store. Task 8 routes the
  // index through the trusted boundary while the fetch still originates in the gallery root.
  expect(galleryJs).toContain("relativePath: 'index.json'");
});

test('image-store consumes the shared jxl-pyramid validator, not a schema-1-only duplicate (finding 72)', () => {
  // The old duplicate hard-coded `m.schema !== 1` — it rejected every real (schema 2/4/5) manifest.
  expect(storeJs).not.toContain('manifest schema must be 1');
  expect(storeJs).not.toContain('m.schema !== 1');
  // It now consumes the canonical reader exported from the jxl-pyramid package build.
  expect(storeJs).toContain('parsePyramidManifest');
  expect(storeJs).toContain('jxl-pyramid');
});

test('image-store validates a real schema-5 manifest via the shared reader', async () => {
  const { createImageStore } = await import('./image-store.js');
  const v5 = {
    schema: 5,
    imageId: 'deadbeefcafef00d',
    master: { name: 'P1000001.RW2', sourceFormat: 'rw2', format: 'rw2', mtimeMs: 1717900000000 },
    orientation: { exif: 6, pixels: 'baked-upright' },
    width: 5184,
    height: 3888,
    aspect: 5184 / 3888,
    levels: [
      { size: 512, w: 512, h: 384, bytes: 15000, bitsPerSample: 8, contenthash: 'abcdef', tiled: false },
      { size: 'full', w: 5184, h: 3888, bytes: 2400000, bitsPerSample: 8, contenthash: 'fedcba', tiled: true,
        tiling: { container: 'jxtc', version: 1, tileSize: 512, bitsPerSample: 8, offsetBase: 'file' } },
    ],
  };
  const fakeCache = { async get() { return null; }, set() {} };
  const origFetch = globalThis.fetch;
  // The manifest fetch now flows through the trusted boundary (Task 8): the mock must present a
  // same-origin final URL and a streamable body, not just a `.json()` accessor.
  const gallery = 'https://example.test/gallery/';
  const bytes = new TextEncoder().encode(JSON.stringify(v5));
  globalThis.fetch = async (url) => {
    let sent = false;
    return {
      ok: true, status: 200, url: `${gallery}images/deadbeefcafef00d/manifest.json`, redirected: false,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(bytes.length) : null) },
      body: { getReader() { return {
        async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; },
        cancel() {}, releaseLock() {},
      }; } },
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    };
  };
  try {
    const store = createImageStore({ cache: fakeCache, galleryBase: gallery });
    const m = await store.getManifest('deadbeefcafef00d');
    expect(m.schema).toBe(5);
    expect(m.orientation).toEqual({ exif: 6, pixels: 'baked-upright' });
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── Task 7: activate existing manifest/index fields (finding 76) ──────────────

test('gallery consumes the shared feature module for placeholder/group/next/metadata (finding 76)', () => {
  // The gallery activates EXISTING fields via one shared, pure module — not a new manifest dialect.
  expect(galleryJs).toContain("from './gallery-features.js'");
  expect(galleryJs).toContain('orderByGroup');
  expect(galleryJs).toContain('mergeNextPage');
  expect(galleryJs).toContain('formatMetadata');
});

test('gallery paints a thumbhash placeholder BEFORE any JXL bytes arrive (finding 76)', () => {
  // The L0 seed's thumbhash paints an instant colour skeleton at cell-build time (before the grid
  // observer triggers any level decode), then the canvas overwrites it once bytes land.
  expect(galleryJs).toContain('thumbhashPlaceholderCss');
  expect(galleryJs).toContain('decodeThumbhash');
  expect(galleryJs).toContain('entry.thumbhash');
  // placeholder is applied to the cell background before the grid is observed for decodes.
  expect(galleryJs).toMatch(/backgroundColor|background-color|dataset\.thumbhash/);
});

test('gallery groups cells by the index `group` field before layout (finding 76)', () => {
  // Grouping is applied to the (possibly multi-page-merged) image list before cells are built, and
  // each grouped cell records its group so the DOM reflects the specimen set.
  expect(galleryJs).toContain('orderByGroup(images)');
  expect(galleryJs).toContain('cell.dataset.group = entry.group');
});

test('gallery follows the index `next` cursor to fetch and merge the next page (finding 76)', () => {
  // The shared reader returns `index.next`; the gallery fetches that shard through the SAME trusted
  // boundary and merges it (dedup by imageId) — no new fetch path, no new dialect.
  expect(galleryJs).toContain('index.next');
  expect(galleryJs).toContain('mergeNextPage');
  // the next-page shard is fetched through the trusted boundary, not a bare fetch.
  expect(galleryJs).toMatch(/fetchVerifiedAsset[\s\S]*relativePath: index\.next|relativePath: nextPath/);
});

test('gallery shows manifest metadata on open and stays graceful when it is absent (finding 76)', () => {
  // metadata comes from the manifest via the image store; formatMetadata returns '' when absent so
  // an image with no EXIF never breaks the lightbox open path.
  expect(galleryJs).toContain('getManifest');
  expect(galleryJs).toContain('formatMetadata');
  expect(galleryJs).toContain('.metadata');
});

// ── Task 7: retire the legacy M1 gallery (finding 74) ─────────────────────────

test('legacy pyramid-gallery.html is a redirect to the modular page preserving query + hash', () => {
  // Deep links (?gallery=…#img=…) must survive the hop to the canonical modular page.
  expect(legacyRedirectHtml).toContain('pyramid-gallery/pyramid-gallery.html');
  expect(legacyRedirectHtml).toContain('location.search');
  expect(legacyRedirectHtml).toContain('location.hash');
  expect(legacyRedirectHtml).toContain('location.replace');
  // the legacy M1 grid script must be gone (no 648-line forked lightbox loaded here).
  expect(legacyRedirectHtml).not.toContain('src="./pyramid-gallery.js"');
  expect(legacyRedirectHtml).not.toContain('createFilterEngine');
});

test('the legacy M1 gallery script is deleted (single canonical gallery implementation)', () => {
  const legacyPath = new URL('../pyramid-gallery.js', import.meta.url);
  expect(existsSync(legacyPath)).toBe(false);
});