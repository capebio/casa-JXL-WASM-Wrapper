import { expect, test } from 'bun:test';
import {
  orderByGroup,
  mergeNextPage,
  thumbhashToAverageRgba,
  thumbhashPlaceholderCss,
  formatMetadata,
  legacyRedirectTarget,
} from './gallery-features.js';

// ── Feature: group ordering (index field `group`, finding 76) ─────────────────

test('orderByGroup keeps same-group entries contiguous in first-seen order', () => {
  const images = [
    { imageId: 'a', group: 'specimen-2' },
    { imageId: 'b', group: 'specimen-1' },
    { imageId: 'c', group: 'specimen-2' },
    { imageId: 'd', group: 'specimen-1' },
  ];
  const ordered = orderByGroup(images).map((e) => e.imageId);
  // specimen-2 seen first (a), so its members (a, c) come first, then specimen-1 (b, d).
  expect(ordered).toEqual(['a', 'c', 'b', 'd']);
});

test('orderByGroup leaves ungrouped entries in place and stable', () => {
  const images = [
    { imageId: 'a' },
    { imageId: 'b', group: 'g1' },
    { imageId: 'c' },
    { imageId: 'd', group: 'g1' },
  ];
  // Ungrouped entries preserve their original relative order; the first grouped
  // member anchors the group's position.
  const ordered = orderByGroup(images).map((e) => e.imageId);
  expect(ordered).toEqual(['a', 'b', 'd', 'c']);
});

test('orderByGroup is a no-op when no entry carries a group', () => {
  const images = [{ imageId: 'a' }, { imageId: 'b' }, { imageId: 'c' }];
  expect(orderByGroup(images).map((e) => e.imageId)).toEqual(['a', 'b', 'c']);
});

// ── Feature: next-page pagination (index field `next`, finding 76) ────────────

test('mergeNextPage appends the next page images after the current ones', () => {
  const base = [{ imageId: 'a' }, { imageId: 'b' }];
  const page = [{ imageId: 'c' }, { imageId: 'd' }];
  expect(mergeNextPage(base, page).map((e) => e.imageId)).toEqual(['a', 'b', 'c', 'd']);
});

test('mergeNextPage dedupes by imageId so an overlapping shard cannot double a cell', () => {
  const base = [{ imageId: 'a' }, { imageId: 'b' }];
  const page = [{ imageId: 'b' }, { imageId: 'c' }];
  expect(mergeNextPage(base, page).map((e) => e.imageId)).toEqual(['a', 'b', 'c']);
});

// ── Feature: thumbhash placeholder BEFORE bytes arrive (finding 76) ───────────

test('thumbhashToAverageRgba decodes the average colour from the packed DC header', () => {
  // A synthetic thumbhash whose L/P/Q header fields (32/63/45) invert to a warm amber average.
  // The first 3 bytes carry the DC terms; the remaining bytes are AC coefficients we don't need
  // for the average-colour placeholder. Padded to a realistic length.
  const bytes = makeThumbhash(40, 63, 45);
  const rgba = thumbhashToAverageRgba(bytes);
  expect(rgba).toEqual([255, 192, 0, 255]);
  // Warm: red channel dominates blue.
  expect(rgba[0]).toBeGreaterThan(rgba[2]);
});

test('thumbhashPlaceholderCss yields an rgb() background usable before any JXL bytes', () => {
  const bytes = makeThumbhash(40, 63, 45);
  const css = thumbhashPlaceholderCss(bytes);
  expect(css).toBe('rgb(255, 192, 0)');
});

test('thumbhashPlaceholderCss returns null for a missing/short hash (graceful skeleton)', () => {
  expect(thumbhashPlaceholderCss(undefined)).toBeNull();
  expect(thumbhashPlaceholderCss(new Uint8Array(2))).toBeNull();
});

// ── Feature: metadata display, graceful when absent (manifest field `metadata`)

test('formatMetadata renders camera/exposure fields present in manifest.metadata', () => {
  const md = formatMetadata({ make: 'Canon', model: 'EOS R5', iso: 400, fnumber: 2.8, focal: 85 });
  expect(md).toContain('Canon');
  expect(md).toContain('EOS R5');
  expect(md).toContain('ISO 400');
  expect(md).toContain('85');
});

test('formatMetadata is empty (never throws) when metadata is absent or empty', () => {
  expect(formatMetadata(undefined)).toBe('');
  expect(formatMetadata(null)).toBe('');
  expect(formatMetadata({})).toBe('');
});

test('formatMetadata ignores unknown/opaque keys without crashing', () => {
  const md = formatMetadata({ make: 'Nikon', someFutureField: { nested: true }, gps: { latitude: 1, longitude: 2 } });
  expect(md).toContain('Nikon');
  // does not throw on the opaque nested object
});

// ── Feature: legacy deep-link redirect preserves query + hash (finding 74) ────

test('legacyRedirectTarget points at the modular page and preserves query + hash', () => {
  expect(legacyRedirectTarget('?gallery=https://host/g/', '#img=abc')).toBe(
    './pyramid-gallery/pyramid-gallery.html?gallery=https://host/g/#img=abc',
  );
});

test('legacyRedirectTarget works with an empty query and hash (bare bookmark)', () => {
  expect(legacyRedirectTarget('', '')).toBe('./pyramid-gallery/pyramid-gallery.html');
});

test('legacyRedirectTarget preserves a query-only deep link', () => {
  expect(legacyRedirectTarget('?base=pyramid-out&autostart=1', '')).toBe(
    './pyramid-gallery/pyramid-gallery.html?base=pyramid-out&autostart=1',
  );
});

// Build a thumbhash whose first 3 bytes pack the 6-bit L/P/Q DC header fields, padded to a
// realistic length so the header-only average decode is exercised on a plausible hash.
function makeThumbhash(lField, pField, qField) {
  const header = (lField & 63) | ((pField & 63) << 6) | ((qField & 63) << 12);
  return new Uint8Array([header & 255, (header >> 8) & 255, (header >> 16) & 255, 0x40, 0x80, 0x11]);
}
