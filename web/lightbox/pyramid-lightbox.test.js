import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./pyramid-lightbox.js', import.meta.url), 'utf8');

// pyramid-lightbox decode path (post-refactor).
//
// The earlier "Task 8" tests asserted on JXTC timing instrumentation
// (t0Decode / jxtcDecodeMs / via:'jxtc' / decodeTileContainerRegionRgba8) that
// was removed when loadLevel was refactored to decode through the shared
// scheduler context (ctx.decode session). These tests now assert on the
// CURRENT decode reality so they reflect what the code actually does.

test('loadLevel decodes through the shared scheduler context (ctx.decode), not an ad-hoc JXTC region call', () => {
  expect(source).toContain('ctx.decode(');
  // The removed JXTC region-decode helper must not have crept back in.
  expect(source).not.toContain('decodeTileContainerRegionRgba8');
});

test('decode is deduped/monotonic via sourceKey = contenthash', () => {
  // The decode request passes the level contenthash as sourceKey so the
  // scheduler can dedupe and keep monotonic ordering.
  expect(source).toMatch(/sourceKey:\s*entry\.contenthash/);
});

test('decode picks format from the 8/16-bit mode toggle', () => {
  // rgba8 for the 8-bit path, rgbaf32 for the 16-bit (HDR) path.
  expect(source).toMatch(/const format = use16 \? 'rgbaf32' : 'rgba8'/);
  expect(source).toMatch(/format,/); // passed into ctx.decode opts
});

test('frames are drained from the session and pixels packed/kept', () => {
  // Refactored loop: iterate session.frames(), keep the last frame with pixels.
  expect(source).toContain('session.frames()');
  expect(source).toMatch(/for await \(const f of session\.frames\(\)\)/);
  // 8-bit packs via packFramePixels; 16-bit keeps the rgbaf32 Float32Array.
  expect(source).toContain('packFramePixels(last)');
});

test('levelInfo literal records contenthash, dimensions, size and bitsPerSample', () => {
  const levelInfoBlock = source.match(/levelInfo\s*=\s*\{[^}]+\}/s)?.[0] ?? '';
  expect(levelInfoBlock).toContain('contenthash:');
  expect(levelInfoBlock).toContain('bitsPerSample:');
  // bits is 16 on the use16 path, 8 otherwise.
  expect(source).toMatch(/bits = 16/);
});

test('loadLevel guards against stale-load overwrite: capture token before await, recheck before commit (finding 42)', () => {
  // A per-open generation + monotonic-rank guard.
  expect(source).toContain('createLoadGuard');
  // A new generation is opened on every open/navigate.
  expect(source).toContain('loadGuard.newGeneration(item.id)');
  // The token is captured (begin) BEFORE the fetch/decode awaits.
  expect(source).toMatch(/const token = loadGuard\.begin\(/);
  // Both decode branches recheck canCommit BEFORE committing decoded pixels.
  const canCommitCount = (source.match(/loadGuard\.canCommit\(token\)/g) || []).length;
  expect(canCommitCount).toBeGreaterThanOrEqual(2);
  // begin() must appear before the first await in loadLevel (capture-before-await).
  const loadStart = source.indexOf('async function loadLevel');
  const beginIdx = source.indexOf('loadGuard.begin(', loadStart);
  const firstAwaitIdx = source.indexOf('await getLevelBytes', loadStart);
  expect(beginIdx).toBeGreaterThan(loadStart);
  expect(beginIdx).toBeLessThan(firstAwaitIdx);
});

test('the guard commits only monotonically-better levels for the same generation', () => {
  // canCommit is rank-gated and commit advances the floor.
  expect(source).toContain('loadGuard.commit(token)');
});
