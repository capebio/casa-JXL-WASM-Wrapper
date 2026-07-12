/**
 * gallery-features.js — pure, DOM-free consumers of EXISTING gallery manifest/index fields
 * (finding 76). The shared jxl-pyramid reader (manifest-validate.ts) already VALIDATES and returns
 * these fields; the ingest already emits `metadata`. This module turns them into behaviour the
 * gallery UI wires up:
 *
 *   - `group`     (GalleryIndexEntry.group)  → contiguous grouping of multi-view specimen sets.
 *   - `next`      (GalleryIndex.next)         → next-page pagination merge (dedupe by imageId).
 *   - `thumbhash` (GalleryIndexEntry.thumbhash) → an instant colour placeholder painted BEFORE any
 *                  JXL bytes arrive (the field's documented purpose: "instant gallery skeleton").
 *   - `metadata`  (PyramidManifest.metadata)  → a graceful camera/exposure caption; absent ⇒ empty.
 *
 * These do NOT introduce a new manifest dialect — every field consumed here is already in the shared
 * schema (packages/jxl-pyramid/src/manifest.ts) and validated by the shared reader.
 */

/**
 * Order gallery entries so members of the same `group` are contiguous, anchored at the group's
 * FIRST appearance, and everything ungrouped keeps its original relative position. Stable and a
 * no-op when no entry carries a group (the common single-shot gallery). Pure; returns a new array.
 * @template {{ imageId: string, group?: string }} T
 * @param {T[]} images
 * @returns {T[]}
 */
export function orderByGroup(images) {
  if (!Array.isArray(images) || images.length === 0) return images ?? [];
  const anyGrouped = images.some((e) => typeof e?.group === 'string' && e.group.length > 0);
  if (!anyGrouped) return images.slice();
  // Bucket in first-seen order. Ungrouped entries each get their own singleton bucket keyed by a
  // unique symbol so they never coalesce with each other or with a real group.
  const order = [];
  const buckets = new Map();
  for (const entry of images) {
    const key =
      typeof entry?.group === 'string' && entry.group.length > 0
        ? `g:${entry.group}`
        : `u:${order.length}:${entry?.imageId ?? ''}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(entry);
  }
  const out = [];
  for (const key of order) out.push(...buckets.get(key));
  return out;
}

/**
 * Merge a fetched next-page shard onto the current image list for `next`-cursor pagination.
 * Appends in order and dedupes by imageId so an overlapping shard boundary cannot double a cell.
 * Pure; returns a new array.
 * @template {{ imageId: string }} T
 * @param {T[]} base
 * @param {T[]} page
 * @returns {T[]}
 */
export function mergeNextPage(base, page) {
  const out = Array.isArray(base) ? base.slice() : [];
  const seen = new Set(out.map((e) => e.imageId));
  for (const entry of page ?? []) {
    if (entry && !seen.has(entry.imageId)) {
      seen.add(entry.imageId);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Decode the AVERAGE colour of a ThumbHash without running the full DCT. The ThumbHash header packs
 * the DC (average) L/P/Q terms in its first bytes; this is exactly enough to paint an instant
 * background placeholder before any JXL bytes decode. Returns [r, g, b, a] (0..255, opaque).
 *
 * Layout (thumbhash spec): the first 3 bytes hold a 24-bit little-endian value whose fields are
 *   L (6 bits) | P (6 bits) | Q (6 bits) | hasAlpha (1 bit) | ...  — we only need L/P/Q here.
 * @param {Uint8Array} hash
 * @returns {[number, number, number, number]}
 */
export function thumbhashToAverageRgba(hash) {
  const header = hash[0] | (hash[1] << 8) | (hash[2] << 16);
  const l = (header & 63) / 63;
  const p = ((header >> 6) & 63) / 31.5 - 1;
  const q = ((header >> 12) & 63) / 31.5 - 1;
  // Inverse of the thumbhash L/P/Q → RGB transform.
  const b = l - (2 / 3) * p;
  const r = (3 * l - b + q) / 2;
  const g = r - q;
  const clamp = (x) => Math.max(0, Math.min(1, x));
  return [
    Math.round(255 * clamp(r)),
    Math.round(255 * clamp(g)),
    Math.round(255 * clamp(b)),
    255,
  ];
}

/**
 * Produce a CSS `rgb(...)` background from a thumbhash for an instant placeholder, or null when no
 * usable hash is present (the gallery then shows its neutral skeleton). A valid thumbhash is at least
 * 5 bytes; anything shorter cannot carry the header.
 * @param {Uint8Array | undefined | null} hash
 * @returns {string | null}
 */
export function thumbhashPlaceholderCss(hash) {
  if (!hash || hash.length < 5) return null;
  const [r, g, b] = thumbhashToAverageRgba(hash);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Decode a base64 thumbhash string (as it appears in index.json) to bytes, or null if invalid. */
export function decodeThumbhash(b64) {
  if (typeof b64 !== 'string' || b64.length === 0) return null;
  try {
    const bin =
      typeof atob === 'function'
        ? atob(b64)
        : Buffer.from(b64, 'base64').toString('binary');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Format a one-line human caption from a manifest's `metadata` dict (make/model/iso/exposure/etc.).
 * Graceful: absent, null, or `{}` metadata yields an empty string, and unknown/opaque keys are
 * ignored. Never throws — metadata is optional untrusted content.
 * @param {Record<string, unknown> | null | undefined} metadata
 * @returns {string}
 */
export function formatMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return '';
  const parts = [];
  const camera = [metadata.make, metadata.model].filter((v) => typeof v === 'string' && v).join(' ');
  if (camera) parts.push(camera);
  if (metadata.focal != null && typeof metadata.focal !== 'object') parts.push(`${metadata.focal}mm`);
  if (metadata.fnumber != null && typeof metadata.fnumber !== 'object') parts.push(`f/${metadata.fnumber}`);
  if (metadata.exposure != null && typeof metadata.exposure !== 'object') parts.push(formatExposure(metadata.exposure));
  if (metadata.iso != null && typeof metadata.iso !== 'object') parts.push(`ISO ${metadata.iso}`);
  return parts.filter(Boolean).join(' · ');
}

/** Canonical modular gallery page, relative to the retired legacy `web/pyramid-gallery.html`. */
export const MODULAR_GALLERY_PAGE = './pyramid-gallery/pyramid-gallery.html';

/**
 * Compute the redirect target from the retired legacy gallery page to the canonical modular page,
 * preserving the deep-link query string and hash so old bookmarks (e.g. `?gallery=…#img=…`) keep
 * working. Pure so the redirect behaviour is unit-testable without a browser.
 * @param {string} search  location.search (leading "?", or "")
 * @param {string} hash    location.hash (leading "#", or "")
 * @returns {string}
 */
export function legacyRedirectTarget(search = '', hash = '') {
  return `${MODULAR_GALLERY_PAGE}${search || ''}${hash || ''}`;
}

/** Render an exposure time as a shutter fraction (e.g. 0.004 → "1/250s"); pass through otherwise. */
function formatExposure(exposure) {
  const n = Number(exposure);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1) return `${n}s`;
  return `1/${Math.round(1 / n)}s`;
}
