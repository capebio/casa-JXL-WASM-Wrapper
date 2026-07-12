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
// finding 73: every network asset (manifest + level bytes) is untrusted input. Route all fetches
// through the single trusted boundary so paths are origin/root-contained (after normalization AND
// redirects), byte-capped before + during streaming, and SHA-256-verified before cache/decode.
import { fetchVerifiedAsset } from "./trusted-fetch.js";
// Task 6: range-aware delivery of a resolved LOD (progressive-prefix / jxtc tile ranges) through
// the SAME trusted boundary. These compose fetchVerifiedAsset's `range` option — no new fetch path.
import { fetchLevelRange, fetchTileRanges } from "./range-fetch.js";

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
 * @param {{ cache: import('@casabio/jxl-cache').JxlCacheBrowser; galleryBase: URL | string;
 *   fetchImpl?: typeof fetch; subtle?: SubtleCrypto }} opts
 */
const MANIFEST_CACHE_MAX = 64;
// A manifest.json is small (a few KB even with many levels); cap it generously so a hostile server
// cannot stream an unbounded "manifest" body into JSON.parse as a DoS.
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB
// Absolute ceiling for a single level's bytes when the caller does not supply an expected size. The
// per-level manifest `bytes` is the precise cap; this is only the fallback for legacy callers.
const LEVEL_MAX_BYTES = 512 * 1024 * 1024; // 512 MiB (matches the persistent cache limit ceiling)

export function createImageStore({ cache, galleryBase, fetchImpl, subtle }) {
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
      // Route through the trusted boundary: `images/<imageId>/manifest.json` is resolved + origin/
      // root-contained (rejecting a traversal/absolute imageId), byte-capped so an unbounded body
      // can't DoS JSON.parse, and its final URL re-checked after any redirect. No sha256 is available
      // for manifests (the index carries no manifest digest), so the cap + containment are the guard.
      const buf = await fetchVerifiedAsset({
        root: base,
        relativePath: `images/${imageId}/manifest.json`,
        expectedBytes: MANIFEST_MAX_BYTES,
        exactBytes: false, // the 4 MiB is a ceiling; a real manifest is a few KB.
        fetchImpl,
        subtle,
      });
      const raw = JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
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
   * @param {{ expectedBytes?: number; sha256?: string }} [opts]
   *   expectedBytes: the level's declared `bytes` from the manifest — the precise byte cap. Callers
   *   that hold the level object SHOULD pass it; legacy callers fall back to LEVEL_MAX_BYTES.
   *   sha256: an optional strong integrity digest (the on-disk `contenthash` is a non-crypto FNV
   *   storage key, so verification rides on this separately-supplied digest when present).
   * @returns {Promise<Uint8Array>}
   */
  async function getLevelBytes(contenthash, opts = {}) {
    const key = `level:${contenthash}`;
    const cached = await cache.get(key);
    if (cached) return new Uint8Array(cached);
    // In-flight dedup: concurrent callers share one fetch (and one cache.set) for the
    // same contenthash; each caller still gets its own Uint8Array wrapper over the buffer.
    let p = levelInflight.get(key);
    if (!p) {
      p = (async () => {
        // Trusted boundary: `levels/<contenthash>.jxl` is resolved + origin/root-contained (rejecting
        // a traversal/absolute contenthash), byte-capped before + during streaming, and — when the
        // caller supplies a digest — SHA-256-verified BEFORE it is published to the cache.
        // With a precise declared size we enforce it exactly (a short body = truncation). Without
        // one we fall back to a generous ceiling and only guard against overrun.
        const hasExact = Number.isFinite(opts.expectedBytes) && opts.expectedBytes > 0;
        const buf = await fetchVerifiedAsset({
          root: base,
          relativePath: `levels/${contenthash}.jxl`,
          expectedBytes: hasExact ? opts.expectedBytes : LEVEL_MAX_BYTES,
          exactBytes: hasExact,
          sha256: opts.sha256,
          fetchImpl,
          subtle,
        });
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

  /**
   * Range delivery of the `progressive-prefix` LOD kind: fetch `[range.start, range.end)` of a
   * level via HTTP Range through the trusted boundary. Not cached under the whole-level key (a
   * prefix is not the whole level); callers own the decoded result. Returns the exact window bytes.
   * @param {string} contenthash
   * @param {{ start: number, end: number }} range   Half-open `[start, end)` (resolver ByteRange).
   * @param {{ sha256?: string; signal?: AbortSignal }} [opts]
   * @returns {Promise<ArrayBuffer>}
   */
  async function getLevelRange(contenthash, range, opts = {}) {
    return fetchLevelRange({
      root: base,
      relativePath: `levels/${contenthash}.jxl`,
      range: { start: range.start, endExclusive: range.end },
      sha256: opts.sha256,
      signal: opts.signal,
      fetchImpl,
      subtle,
    });
  }

  /**
   * Range delivery of the `jxtc-ranges` LOD kind: one HTTP Range per overlapping tile, in order.
   * @param {string} contenthash
   * @param {{ start: number, end: number }[]} ranges
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<ArrayBuffer[]>}
   */
  async function getTileRanges(contenthash, ranges, opts = {}) {
    return fetchTileRanges({
      root: base,
      relativePath: `levels/${contenthash}.jxl`,
      ranges,
      signal: opts.signal,
      fetchImpl,
      subtle,
    });
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
    getLevelRange,
    getTileRanges,
    clearManifest,
    clearAll,
    get base() { return base; },
  };
}
