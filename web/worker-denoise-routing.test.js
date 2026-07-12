// worker.js is a Web Worker script (not importable as an ES module without a DOM
// worker environment), so this suite exercises the DENOISE ROUTING CONTRACT the
// worker relies on: the shared normalize/needs-reprocess helpers, and the
// buildWasmOptions options-object shape passed to the *_with_options WASM APIs.
import { test, expect } from 'vitest';
import {
  normalizeDenoiseOptions,
  denoiseNeedsReprocess,
} from './raw-denoise-options.js';

// Mirror of worker.js buildWasmOptions — kept in the test so the contract shape
// (look + denoise sub-objects) is asserted independently of the worker module.
function buildWasmOptions(lookArgs, denoise) {
  return { look: lookArgs, denoise: denoise || { enabled: false } };
}

test('normalized denoise (normal sensitivity) yields noiseThreshold 1.5', () => {
  const d = normalizeDenoiseOptions({ enabled: true, sensitivity: 'normal' });
  expect(d.enabled).toBe(true);
  expect(d.noiseThreshold).toBe(1.5);
});

test('enabling denoise triggers a reprocess vs the default-off state', () => {
  const off = normalizeDenoiseOptions(undefined);
  const on = normalizeDenoiseOptions({ enabled: true });
  expect(denoiseNeedsReprocess(off, on)).toBe(true);
});

test('changing sensitivity while enabled triggers a reprocess', () => {
  const a = normalizeDenoiseOptions({ enabled: true, sensitivity: 'normal' });
  const b = normalizeDenoiseOptions({ enabled: true, sensitivity: 'high' });
  expect(denoiseNeedsReprocess(a, b)).toBe(true);
});

test('buildWasmOptions nests look + denoise sub-objects for the WASM options API', () => {
  const look = { exposureEv: 0, contrast: 0, wbR: NaN, wbB: NaN };
  const denoise = normalizeDenoiseOptions({ enabled: true, sensitivity: 'high' });
  const opts = buildWasmOptions(look, denoise);
  expect(opts.look).toBe(look);
  expect(opts.denoise).toBe(denoise);
  expect(opts.denoise.noiseThreshold).toBe(1.0);
});

test('buildWasmOptions defaults denoise to disabled when absent', () => {
  const opts = buildWasmOptions({}, undefined);
  expect(opts.denoise).toEqual({ enabled: false });
});

test('canSplit contract: split is only permitted for orf when denoise is disabled', () => {
  // Mirror of the exact worker.js gate:
  //   canSplit = nativeRaw && interactive && rawKind === 'orf' && !denoise.enabled
  const canSplit = (rawKind, interactive, denoise) =>
    true /* nativeRaw */ && interactive && rawKind === 'orf' && !denoise.enabled;

  expect(canSplit('orf', true, { enabled: false })).toBe(true);
  expect(canSplit('orf', true, { enabled: true })).toBe(false); // denoise disables the split
  expect(canSplit('dng', true, { enabled: false })).toBe(false);
  expect(canSplit('orf', false, { enabled: false })).toBe(false); // batch: no split
});
