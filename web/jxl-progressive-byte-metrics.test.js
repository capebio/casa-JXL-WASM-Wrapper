import { expect, test } from 'bun:test';
import {
  classifyByteCutoffFrame,
  summarizeByteCutoffResults,
  RECOGNIZABLE_DB,
  PREVIEW_DB,
  GOOD_BUTTER,
  buildSeries,
} from './jxl-progressive-byte-metrics.js';

test('summarizeByteCutoffResults reports first paint, preview, final and counts', () => {
  const summary = summarizeByteCutoffResults([
    { bytes: 1024, painted: false, isFinal: false, frameCount: 0 },
    { bytes: 10_240, painted: true, isFinal: false, frameCount: 1 },
    { bytes: 50_000, painted: true, isFinal: false, frameCount: 2 },
    { bytes: 80_000, painted: true, isFinal: true, frameCount: 3 },
  ], 80_000);

  expect(summary).toEqual({
    totalBytes: 80_000,
    firstPaintBytes: 10_240,
    firstPaintPercent: 12.8,
    firstRecognizableBytes: null,
    firstRecognizablePercent: null,
    previewBytes: 50_000,
    previewPercent: 62.5,
    finalBytes: 80_000,
    finalPercent: 100,
    finalPsnr: null,
    paintedCutoffs: 3,
    maxFrameCount: 3,
    usefulEarlyPaint: true,
    monotone: null,
    regressions: [],
    firstPerceptuallyGoodBytes: null,
    firstPerceptuallyGoodPercent: null,
    firstPerceptuallyGoodConfidence: null,
    finalButter: null,
    butterMonotone: null,
    butterRegressions: [],
    firstGoodSsimBytes: null,
    finalSsim: null,
    ssimMonotone: null,
    ssimRegressions: [],
  });
});

test('summarizeByteCutoffResults handles no prefix paint honestly', () => {
  const summary = summarizeByteCutoffResults([
    { bytes: 1024, painted: false, isFinal: false, frameCount: 0 },
    { bytes: 2048, painted: false, isFinal: false, frameCount: 0 },
  ], 2048);

  expect(summary.firstPaintBytes).toBeNull();
  expect(summary.previewBytes).toBeNull();
  expect(summary.usefulEarlyPaint).toBe(false);
});

test('classifyByteCutoffFrame captures painted/final state from decoder event list', () => {
  expect(classifyByteCutoffFrame({ bytes: 50_000, events: [] })).toMatchObject({
    bytes: 50_000,
    painted: false,
    frameCount: 0,
    isFinal: false,
  });
  expect(classifyByteCutoffFrame({
    bytes: 50_000,
    events: [{ type: 'progress' }, { type: 'final' }],
  })).toMatchObject({
    bytes: 50_000,
    painted: true,
    frameCount: 2,
    isFinal: true,
  });
});

test('summarizeByteCutoffResults exposes quality fields when qualitySeries supplied', () => {
  const results = [
    { bytes: 1000, painted: false, frameCount: 0, isFinal: false },
    { bytes: 5000, painted: true, frameCount: 1, isFinal: false, stage: 'dc' },
    { bytes: 20000, painted: true, frameCount: 2, isFinal: false, stage: 'pass' },
    { bytes: 50000, painted: true, frameCount: 3, isFinal: true, stage: 'final' },
  ];
  const qualitySeries = [
    { bytes: 5000, psnr: 18 },
    { bytes: 20000, psnr: 28 },
    { bytes: 50000, psnr: 42 },
  ];
  const summary = summarizeByteCutoffResults(results, 50000, { qualitySeries });
  expect(summary.firstRecognizableBytes).toBe(20000);
  expect(summary.previewBytes).toBe(50000);
  expect(summary.finalPsnr).toBe(42);
  expect(summary.monotone).toBe(true);
  expect(summary.regressions).toEqual([]);
});

test('summarizeByteCutoffResults without qualitySeries keeps backwards-compatible shape', () => {
  const results = [
    { bytes: 1000, painted: true, frameCount: 1, isFinal: false, stage: 'dc' },
    { bytes: 5000, painted: true, frameCount: 1, isFinal: true, stage: 'final' },
  ];
  const summary = summarizeByteCutoffResults(results, 5000);
  expect(summary.firstPaintBytes).toBe(1000);
  expect(summary.firstRecognizableBytes).toBeNull();
  expect(summary.finalPsnr).toBeNull();
  expect(summary.monotone).toBeNull();
});

test('summarize accepts butterSeries, computes firstGoodButter + monotone', () => {
  const results = [
    { bytes: 1000, painted: true, frameCount: 1, isFinal: false },
    { bytes: 5000, painted: true, frameCount: 1, isFinal: true },
  ];
  const butterSeries = [
    { bytes: 1000, butter: 1.8 },
    { bytes: 5000, butter: 0.3 },
  ];
  const s = summarizeByteCutoffResults(results, 5000, { butterSeries });
  expect(s.firstPerceptuallyGoodBytes).toBe(5000);
  expect(s.finalButter).toBe(0.3);
  expect(s.butterMonotone).toBe(true);
  expect(s.butterRegressions).toEqual([]);
});

test('summarize sort guard + unsorted input still yields correct firsts', () => {
  const unsorted = [
    { bytes: 50000, painted: true, frameCount: 3, isFinal: true },
    { bytes: 1000, painted: true, frameCount: 1, isFinal: false },
  ];
  const s = summarizeByteCutoffResults(unsorted, 50000);
  expect(s.firstPaintBytes).toBe(1000);
});

test('exports RECOGNIZABLE_DB / PREVIEW_DB', () => {
  expect(RECOGNIZABLE_DB).toBe(20);
  expect(PREVIEW_DB).toBe(30);
});

test('butterSeries with regression flags via lowerIsBetter in detect', () => {
  const results = [{ bytes: 1000, painted: true, frameCount: 1, isFinal: false }, { bytes: 2000, painted: true, frameCount: 1, isFinal: true }];
  const bs = [{ bytes: 1000, butter: 0.5 }, { bytes: 2000, butter: 0.9 }];
  const s = summarizeByteCutoffResults(results, 2000, { butterSeries: bs });
  expect(s.butterMonotone).toBe(false);
  expect(s.butterRegressions.length).toBe(1);
});

test('exports GOOD_BUTTER and buildSeries shape', () => {
  expect(GOOD_BUTTER).toBe(1.0);
  const ref = new Uint8Array(16).fill(128);
  const cuts = [new Uint8Array(16).fill(128), new Uint8Array(16).fill(100)];
  const bytes = [1000, 5000];
  const built = buildSeries(ref, cuts, bytes, 2, 2);
  expect(built.butterSeries.length).toBe(2);
  expect(built.qualitySeries[0].psnr).toBe(Infinity);
});

test('preview uses butter when no qualitySeries', () => {
  const results = [{ bytes: 1000, painted: true, frameCount: 1, isFinal: true }];
  const bs = [{ bytes: 1000, butter: 0.4 }];
  const s = summarizeByteCutoffResults(results, 1000, { butterSeries: bs });
  expect(s.previewBytes).toBe(1000);
});

test('classifyByteCutoffFrame handles null error default', () => {
  const r = classifyByteCutoffFrame({ bytes: 1000, events: [] });
  expect(r.error).toBeNull();
  expect(r.painted).toBe(false);
});

test('percent precision uses integer arithmetic without string artifacts', () => {
  // 10240 / 81920 = 12.5 exactly
  const s = summarizeByteCutoffResults(
    [{ bytes: 10240, painted: true, frameCount: 1, isFinal: false }],
    81920
  );
  expect(s.firstPaintPercent).toBe(12.5);
});

test('buildSeries applies postDecodeTransform before quality computation', () => {
  const ref = new Uint8Array(16).fill(200);
  const cuts = [new Uint8Array(16).fill(100)];
  let transformCalled = false;
  const transform = (pixels, ctx) => {
    transformCalled = true;
    expect(ctx.index).toBe(0);
    expect(ctx.layer).toBe(0);
    return pixels;
  };
  const built = buildSeries(ref, cuts, [1000], 2, 2, transform);
  expect(transformCalled).toBe(true);
  expect(built.qualitySeries.length).toBe(1);
});

test('buildSeries postDecodeTransform returning null/undefined falls back to original pixels', () => {
  const ref = new Uint8Array(16).fill(128);
  const cuts = [new Uint8Array(16).fill(128)];
  const transform = () => null; // signal: keep original
  const built = buildSeries(ref, cuts, [1000], 2, 2, transform);
  // identical pixels → PSNR = Infinity
  expect(built.qualitySeries[0].psnr).toBe(Infinity);
});

test('buildSeriesAsync accepts prebuilt comparator and produces same shape as buildSeries', async () => {
  const ref = new Uint8Array(16).fill(128);
  const cuts = [new Uint8Array(16).fill(128), new Uint8Array(16).fill(100)];
  const bytes = [1000, 5000];
  const fakeComparator = { compare: (_p) => 0.42 };
  const { buildSeriesAsync } = await import('./jxl-progressive-byte-metrics.js');
  const built = await buildSeriesAsync(ref, cuts, bytes, 2, 2, { comparator: fakeComparator });
  expect(built.butterSeries.length).toBe(2);
  expect(built.butterSeries[0].butter).toBe(0.42);
  expect(built.qualitySeries[0].psnr).toBe(Infinity);
});

test('summarize handles null butter entries from adaptive skip without throwing', () => {
  const results = [
    { bytes: 1000, painted: true, frameCount: 1, isFinal: false },
    { bytes: 2000, painted: true, frameCount: 2, isFinal: false },
    { bytes: 3000, painted: true, frameCount: 3, isFinal: true },
  ];
  const butterSeries = [
    { bytes: 1000, butter: 1.5 },
    { bytes: 2000, butter: null }, // skipped by adaptive doFull logic
    { bytes: 3000, butter: 0.4 },
  ];
  const s = summarizeByteCutoffResults(results, 3000, { butterSeries });
  expect(s.firstPerceptuallyGoodBytes).toBe(3000);
  expect(() => s.butterMonotone).not.toThrow();
});

test('buildSeries always creates a measure entry (no orphan marks)', () => {
  if (typeof performance?.getEntriesByType !== 'function') {
    return; // skip if performance API not available
  }
  const before = performance.getEntriesByType('measure').filter(e => e.name === 'buildSeries').length;
  // Mismatched arrays trigger early return before the loop — mark+measure still fire
  buildSeries(new Uint8Array(4), [], [], 1, 1);
  const after = performance.getEntriesByType('measure').filter(e => e.name === 'buildSeries').length;
  expect(after).toBe(before + 1);
});
