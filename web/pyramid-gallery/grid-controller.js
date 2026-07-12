import { shouldUpgrade } from '../../packages/jxl-pyramid/dist/choose-level.js';
// finding 26: ONE resolver across consumers. The grid no longer calls chooseLevelForTarget
// directly — it routes demand through resolveLod, which owns the (shared) level selection and
// tells us the delivery kind. The grid's targets stay <=2048 whole, so the resolution axis is the
// one it exercises; the resolver's region/quality axes are used by the lightbox.
import { resolveLod } from '../../packages/jxl-pyramid/dist/lod-resolver.js';
import { createLevelSource } from '../../packages/jxl-pyramid/dist/level-source.js';
import { decodePyramidLevel } from './pyramid-decode.js';
import { createImageStore } from './image-store.js'; // S2; passed in or fallback
import { createInflightDecodes } from './decode-lease.js';

const PREFETCH_RING = 1;

/**
 * finding 81: the L0 seed declares precision (bitsPerSample) and transport (tiled + tiling) so this
 * controller decodes it through a VALID path. A bare seed (no tiled/bitsPerSample) is a monolithic
 * 8-bit level — the default. A tiled seed is decoded through the tile-container path with a region.
 * @typedef {{ contenthash: string; w: number; h: number; bytes?: number; bitsPerSample?: 8|16; tiled?: boolean; tiling?: object }} IndexL0
 */
/** @typedef {{ imageId: string; aspect: number; l0: IndexL0 }} IndexEntry */

/**
 * @param {object} opts
 * @param {import('@casabio/jxl-session').JxlContext} opts.ctx
 * @param {import('@casabio/jxl-cache').JxlCacheBrowser} [opts.cache]
 * @param {URL} [opts.galleryBase]
 * @param {object} [opts.imageStore] // preferred; from createImageStore S1
 * @param {import('@casabio/jxl-pyramid').PyramidRuntime} [opts.runtime] // Packet 2 Task 1: single owned decode runtime (engine of record); Task 3 routes decode through it
 * @param {number} opts.tileSizePx
 * @param {number} [opts.devicePixelRatio]
 * @param {Map<string, IndexEntry>} [opts.indexByImageId]
 * @param {(cellEl: HTMLElement, imageId: string, level: object, decoded: object) => void} [opts.onTilePainted]
 */
export function createGridController({
  ctx,
  cache,
  galleryBase,
  imageStore,
  runtime,
  tileSizePx,
  devicePixelRatio,
  indexByImageId,
  onTilePainted,
}) {
  const store = imageStore || (cache && galleryBase ? createImageStore({ cache, galleryBase }) : null);
  // Packet 2 Task 3: the single decode runtime handed down by the gallery bootstrap is the ONE
  // orchestration surface that owns the tiled worker pool. Tiled levels decode through
  // runtime.decodeLevel (no per-call pool, no drifted options); whole levels stay on the shared
  // scheduler/session path via decodePyramidLevel.
  const dpr = devicePixelRatio ?? 1;
  const paintedRank = new Map();
  // Ref-counted shared-decode ownership (findings 49, 76). Callers that share a
  // job key dedupe onto one underlying decode; the decode is cancelled only when
  // EVERY caller — including a caller WITHOUT an AbortSignal — has released its
  // lease. A no-signal caller is therefore never invisible.
  const inflight = createInflightDecodes();
  // S2: manifests map + fetchManifest/fetchLevelBytes replaced by imageStore (S1)

  function targetLongEdge() {
    return Math.ceil(tileSizePx * dpr);
  }

  // Capabilities for the resolver. The grid decodes whole levels (targets <=2048), so it does not
  // request Range delivery here — it reports rangeRequests:false so the resolver always yields a
  // whole-level for the grid. (The lightbox, which owns zoom/ROI, is the range-capable consumer.)
  function gridCapabilities() {
    return {
      workers: runtime?.capabilities?.workers ?? true,
      sharedMemory: runtime?.capabilities?.sharedMemory ?? false,
      rangeRequests: false,
      rgba16: runtime?.capabilities?.rgba16 ?? false,
    };
  }

  // Runs the actual decode under the shared signal handed down by the lease
  // registry. The shared signal aborts only once all leases for this job key
  // are released — so this decode observes cancellation, but never a premature
  // one driven by a single joiner.
  function startDecode(imageId, level, priority, sharedSignal) {
    return (async () => {
      if (!store) throw new Error('grid-controller requires imageStore (or cache+galleryBase)');
      // Pass the level's declared byte size so the trusted boundary caps the fetch precisely
      // (finding 73). `level.bytes` comes from the validated manifest; undefined for a bare l0
      // seed falls back to the store's generous ceiling.
      const bytes = await store.getLevelBytes(level.contenthash, { expectedBytes: level.bytes });
      // finding 81: honor the level's DECLARED transport + precision. A level (or L0 seed) is
      // decoded as tiled only when it explicitly declares `tiled` — an L0 seed without it defaults
      // to a monolithic whole-frame decode (never assumed tiled). Precision follows bitsPerSample.
      const isTiled = level.tiled === true;
      if (isTiled && runtime) {
        // finding 77/78: tiled decode goes through the ONE injected runtime. It owns the pool
        // (no per-call pool creation) and accepts only the declared demand keys — the runtime
        // derives format from the JXTC header, so no `format`/`priority`/`sourceKey` drift here.
        const source = createLevelSource({ w: level.w, h: level.h, tiled: true, bitsPerSample: level.bitsPerSample }, bytes);
        // Full-region decode so the pool can fan every tile out in parallel (grid targets stay
        // <=2048 whole, but this protects if a large tileSize or the full level is picked).
        const region = { x: 0, y: 0, w: level.w, h: level.h };
        return runtime.decodeLevel(source, region, { quality: 'final', signal: sharedSignal });
      }
      // Whole-frame levels use the shared scheduler/session path (dedupe/priority/backpressure).
      const format = level.bitsPerSample === 16 ? 'rgba16' : 'rgba8';
      return decodePyramidLevel(ctx, bytes, {
        contenthash: level.contenthash,
        priority,
        signal: sharedSignal,
        tiled: false,
        format,
      });
    })();
  }

  /**
   * Acquire a lease on the (possibly shared) decode for this level. EVERY caller
   * — with or without a signal — owns exactly one lease and must release() it in
   * a `finally`. Returns `{ promise, release }`.
   */
  function decodeForLevel(imageId, level, priority, signal) {
    const jobKey = `${imageId}:${level.contenthash}`;
    return inflight.decode(
      jobKey,
      (sharedSignal) => startDecode(imageId, level, priority, sharedSignal),
      signal,
    );
  }

  function paintCanvas(cellEl, decoded) {
    const canvas = cellEl.querySelector('canvas') ?? document.createElement('canvas');
    if (!canvas.parentElement) cellEl.appendChild(canvas);
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return canvas;
    // Grid tiles are tight rgba8 (byteLength === w*h*4): wrap the decoded
    // buffer zero-copy instead of allocating + memcpying it. putImageData
    // consumes synchronously and does not transfer the buffer, so aliasing the
    // source is safe. The byteLength guard keeps a future rgba16/strided caller
    // from feeding a mis-sized buffer through the view path — falls back to copy.
    const tightLen = decoded.width * decoded.height * 4;
    const src =
      decoded.pixels.byteLength === tightLen
        ? new Uint8ClampedArray(decoded.pixels.buffer, decoded.pixels.byteOffset, tightLen)
        : new Uint8ClampedArray(decoded.pixels);
    const imgData = new ImageData(src, decoded.width, decoded.height);
    ctx2d.putImageData(imgData, 0, 0);
    const hadPaint = canvas.dataset.painted === '1';
    canvas.style.opacity = hadPaint ? '0' : '1';
    canvas.dataset.painted = '1';
    requestAnimationFrame(() => {
      canvas.style.transition = 'opacity 180ms ease';
      canvas.style.opacity = '1';
    });
    return canvas;
  }

  async function paintLevel(cellEl, imageId, level, { priority = 'visible', signal = null } = {}) {
    const rankKey = imageId;
    const current = paintedRank.get(rankKey) ?? null;
    if (!shouldUpgrade(current, level)) return false;

    // Own exactly one lease on the shared decode and release it once (finding 49).
    // Releasing in `finally` guarantees the underlying decode is not kept alive by
    // this caller past its own interest, while a concurrent no-signal/other-signal
    // caller still holds it.
    const lease = decodeForLevel(imageId, level, priority, signal);
    try {
      const decoded = await lease.promise;
      // Don't advance painted state on abort: leave paintedRank untouched.
      if (signal?.aborted) return false;
      // Re-check against the (possibly advanced) rank after the await so a late
      // lower-level decode cannot overpaint a higher level painted meanwhile.
      if (!shouldUpgrade(paintedRank.get(rankKey) ?? null, level)) return false;

      paintCanvas(cellEl, decoded);
      paintedRank.set(rankKey, level);
      onTilePainted?.(cellEl, imageId, level, decoded);
      return true;
    } finally {
      lease.release();
    }
  }

  async function paintCell(cellEl, imageId, { priority = 'visible', signal = null } = {}) {
    const entry = indexByImageId?.get(imageId);
    if (entry?.l0 && !paintedRank.has(imageId)) {
      await paintLevel(cellEl, imageId, entry.l0, { priority, signal });
      if (signal?.aborted) return;
    }

    if (!store) throw new Error('grid-controller requires imageStore (or cache+galleryBase)');
    const manifest = await store.getManifest(imageId);
    // finding 26: route selection through the ONE resolver. For the grid this yields a whole-level
    // (rangeRequests:false), and its `.level` is the same level the shared chooseLevelForTarget
    // would pick — the resolver simply owns that selection now.
    const resolution = resolveLod(manifest, { targetLongEdge: targetLongEdge(), dpr }, gridCapabilities());
    const level = resolution?.level;
    if (!level) return;

    await paintLevel(cellEl, imageId, level, { priority, signal });
  }

  function observeGrid(rootEl) {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const cell = entry.target;
        const imageId = cell.dataset.imageId;
        if (!imageId) continue;
        if (!entry.isIntersecting) {
          // Leaving the viewport: cancel the cell's in-flight decode/paint.
          cell._pyramidAbort?.abort();
          cell._pyramidAbort = null;
          continue;
        }
        // Still intersecting: leave any in-flight decode for this cell alone.
        // Only start a fresh decode when the cell has no live controller (first
        // intersect, or a previous one was aborted on leave / settled).
        if (cell._pyramidAbort && !cell._pyramidAbort.signal.aborted) continue;
        const ac = new AbortController();
        cell._pyramidAbort = ac;
        const ring = Number(cell.dataset.prefetchRing ?? '0');
        const priority = ring === 0 ? 'visible' : 'near';
        void paintCell(cell, imageId, { priority, signal: ac.signal })
          .catch((err) => {
            if (!ac.signal.aborted) console.warn('grid tile', imageId, err);
          })
          .finally(() => {
            // Release the resting controller only if it is still ours, so a
            // later re-intersect can launch a fresh decode (e.g. to upgrade).
            if (cell._pyramidAbort === ac) cell._pyramidAbort = null;
          });
      }
    }, { root: rootEl, rootMargin: `${tileSizePx * PREFETCH_RING}px` });

    for (const cell of rootEl.querySelectorAll('[data-image-id]')) io.observe(cell);
    return () => io.disconnect();
  }

  return {
    fetchManifest: (id) => store ? store.getManifest(id) : Promise.reject(new Error('no store')),
    paintCell,
    observeGrid,
    targetLongEdge,
  };
}