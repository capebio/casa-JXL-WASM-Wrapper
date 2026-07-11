/**
 * ImageStore — centralized acquisition for pyramid gallery image handling.
 * Manifests + level bytes. Uses JxlCacheBrowser for level content (keyed by contenthash).
 * In-mem cache for manifests (per imageId). Thin layer; no decode, no scheduler policy.
 * S1 of image-store-image-handling-handoff.
 */

/** @typedef {import('../../packages/jxl-pyramid/dist/manifest.js').PyramidManifest} PyramidManifest */

// finding 72: consume the ONE canonical reader exported from @casabio/jxl-pyramid instead of a
// divergent browser duplicate. The previous inline validator only accepted the earliest schema, so
// it rejected every real (schema 2/4/5) manifest. parsePyramidManifest accepts schemas 1|2|4|5,
// validates the v5 OrientationDescriptor / TilingDescriptor / sourceFormat, and preserves unknown
// fields. It is pure (no zod), so the browser stays zero-dep.
import { parsePyramidManifest } from "../../packages/jxl-pyramid/dist/manifest-validate.js";

/**
 * Validate a fetched manifest through the shared jxl-pyramid reader. Throws on structural violation
 * (ManifestValidationError). Returns the normalized manifest.
 * @param {any} m
 * @returns {PyramidManifest}
 */
function validateManifest(m) {
  return parsePyramidManifest(m);
}

/**
 * @param {{ cache: import('@casabio/jxl-cache').JxlCacheBrowser; galleryBase: URL | string }} opts
 */
const MANIFEST_CACHE_MAX = 64;

export function createImageStore({ cache, galleryBase }) {
  // Normalize galleryBase: accept a URL, an absolute URL string, or a relative path string.
  // `new URL(string)` throws on a relative input, so resolve relatives against the document
  // location (falling back to a neutral base in non-browser/test environments).
  const base = galleryBase instanceof URL
    ? galleryBase
    : (() => {
        const withSlash = galleryBase.endsWith('/') ? galleryBase : `${galleryBase}/`;
        const docBase = (typeof document !== 'undefined' && document.baseURI)
          || (typeof location !== 'undefined' && location.href)
          || undefined;
        return new URL(withSlash, docBase);
      })();
  // Bounded LRU (insertion-order Map) so a long gallery session can't grow the manifest
  // cache without limit, consistent with the size-bounded level-byte cache.
  const manifestCache = new Map();
  // In-flight fetch promises so concurrent first-callers don't double-fetch/double-validate.
  const manifestInflight = new Map();
  const levelInflight = new Map();

  /** Insert into the bounded manifest cache, evicting the least-recently-used entry. */
  function manifestCacheSet(imageId, manifest) {
    manifestCache.delete(imageId);
    manifestCache.set(imageId, manifest);
    if (manifestCache.size > MANIFEST_CACHE_MAX) {
      const oldest = manifestCache.keys().next().value;
      if (oldest !== undefined) manifestCache.delete(oldest);
    }
  }

  /**
   * @param {string} imageId
   * @returns {Promise<PyramidManifest>}
   */
  async function getManifest(imageId) {
    if (manifestCache.has(imageId)) {
      // LRU touch: move to most-recently-used position.
      const m = manifestCache.get(imageId);
      manifestCache.delete(imageId);
      manifestCache.set(imageId, m);
      return m;
    }
    // In-flight dedup: concurrent first-callers share one fetch+validate.
    const pending = manifestInflight.get(imageId);
    if (pending) return pending;
    const p = (async () => {
      const url = new URL(`images/${imageId}/manifest.json`, base).href;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`manifest ${imageId}: ${res.status}`);
      const raw = await res.json();
      // Validate + normalize through the shared jxl-pyramid reader (zero-dep) before cache/return.
      const manifest = validateManifest(raw);
      manifestCacheSet(imageId, manifest);
      return manifest;
    })();
    manifestInflight.set(imageId, p);
    try {
      return await p;
    } finally {
      manifestInflight.delete(imageId);
    }
  }

  /**
   * @param {string} contenthash
   * @returns {Promise<Uint8Array>}
   */
  async function getLevelBytes(contenthash) {
    const key = `level:${contenthash}`;
    const cached = await cache.get(key);
    if (cached) return new Uint8Array(cached);
    // In-flight dedup: concurrent callers share one fetch (and one cache.set) for the
    // same contenthash; each caller still gets its own Uint8Array wrapper over the buffer.
    let p = levelInflight.get(key);
    if (!p) {
      p = (async () => {
        const url = new URL(`levels/${contenthash}.jxl`, base).href;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`level ${contenthash}: ${res.status}`);
        const buf = await res.arrayBuffer();
        void cache.set(key, buf);
        return buf;
      })();
      levelInflight.set(key, p);
    }
    try {
      const buf = await p;
      return new Uint8Array(buf);
    } finally {
      levelInflight.delete(key);
    }
  }

  function clearManifest(imageId) {
    manifestCache.delete(imageId);
  }

  function clearAll() {
    manifestCache.clear();
  }

  return {
    getManifest,
    getLevelBytes,
    clearManifest,
    clearAll,
    get base() { return base; },
  };
}
