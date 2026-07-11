import { chooseLevelForTarget, shouldUpgrade } from '../../packages/jxl-pyramid/dist/choose-level.js';
import { decodePyramidLevel } from './pyramid-decode.js';
import { createImageStore } from './image-store.js'; // S2; passed in or fallback

const PREFETCH_RING = 1;

/** @typedef {{ contenthash: string; w: number; h: number }} IndexL0 */
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
  // Packet 2 Task 1: hold the single decode runtime handed down by the gallery bootstrap.
  // Decode still flows through decodePyramidLevel today; Task 3 consolidates onto runtime.decodeLevel.
  void runtime;
  const dpr = devicePixelRatio ?? 1;
  const paintedRank = new Map();
  const inflight = new Map();
  // S2: manifests map + fetchManifest/fetchLevelBytes replaced by imageStore (S1)

  function targetLongEdge() {
    return Math.ceil(tileSizePx * dpr);
  }

  async function decodeForLevel(imageId, level, priority, signal) {
    const jobKey = `${imageId}:${level.contenthash}`;

    // Ref-counted cancellation: dedup joiners share one underlying decode, but
    // the shared decode is only aborted once EVERY joiner has aborted. The
    // shared controller's signal is what drives the decode.
    let job = inflight.get(jobKey);
    if (!job) {
      const shared = new AbortController();
      job = { shared, joiners: 0, promise: null };
      job.promise = (async () => {
        if (!store) throw new Error('grid-controller requires imageStore (or cache+galleryBase)');
        const bytes = await store.getLevelBytes(level.contenthash);
        const isTiled = level.tiled === true;
        return decodePyramidLevel(ctx, bytes, {
          contenthash: level.contenthash,
          priority,
          signal: shared.signal,
          tiled: isTiled,
          // Supply full region for tiled so decodeTiledPooled can parallel all tiles (grid targets stay <=2048 whole, but protects if large tileSize or full picked).
          region: isTiled ? { x: 0, y: 0, w: level.w, h: level.h } : undefined,
        });
      })().finally(() => inflight.delete(jobKey));
      inflight.set(jobKey, job);
    }

    // Register this caller as a joiner so its abort only contributes to, but
    // does not unilaterally trigger, cancellation of the shared decode.
    if (signal) {
      if (signal.aborted) {
        job.shared.abort();
      } else {
        job.joiners += 1;
        let counted = true;
        const onAbort = () => {
          if (!counted) return;
          counted = false;
          job.joiners -= 1;
          if (job.joiners <= 0) job.shared.abort();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        // Stop tracking once the decode settles so a late abort from this
        // joiner cannot over-decrement / abort an already-finished job.
        job.promise.catch(() => {}).finally(() => {
          counted = false;
          signal.removeEventListener('abort', onAbort);
        });
      }
    }

    return job.promise;
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

    const decoded = await decodeForLevel(imageId, level, priority, signal);
    // Don't advance painted state on abort: leave paintedRank untouched.
    if (signal?.aborted) return false;
    // Re-check against the (possibly advanced) rank after the await so a late
    // lower-level decode cannot overpaint a higher level painted meanwhile.
    if (!shouldUpgrade(paintedRank.get(rankKey) ?? null, level)) return false;

    paintCanvas(cellEl, decoded);
    paintedRank.set(rankKey, level);
    onTilePainted?.(cellEl, imageId, level, decoded);
    return true;
  }

  async function paintCell(cellEl, imageId, { priority = 'visible', signal = null } = {}) {
    const entry = indexByImageId?.get(imageId);
    if (entry?.l0 && !paintedRank.has(imageId)) {
      await paintLevel(cellEl, imageId, entry.l0, { priority, signal });
      if (signal?.aborted) return;
    }

    if (!store) throw new Error('grid-controller requires imageStore (or cache+galleryBase)');
    const manifest = await store.getManifest(imageId);
    const target = targetLongEdge();
    const level = chooseLevelForTarget(manifest.levels, target);
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