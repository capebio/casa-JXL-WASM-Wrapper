import { expect, test } from 'bun:test';
import { timingEnabled } from './timing-gate.js';
import { computePsnrVsFinal, computeSsimVsFinal, computePsnrSsimFused, detectMonotone, MONOTONE_TOLERANCE_DB, computeChannelMoments, computeQualityBundle, isQualityPlateau } from './jxl-progressive-quality.js';
import { pixelsToXyb, computeButteraugliVsFinal, createButteraugliComparer, computeButteraugliApproxVsFinal } from './jxl-butteraugli.js';

test('PSNR of identical buffers is +Infinity', () => {
  const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(computePsnrVsFinal(a, b)).toBe(Infinity);
});

test('PSNR of all-zero vs all-max is finite and near 0 dB', () => {
  const a = new Uint8Array([0, 0, 0, 0]);
  const b = new Uint8Array([255, 255, 255, 255]);
  const psnr = computePsnrVsFinal(a, b);
  expect(Number.isFinite(psnr)).toBe(true);
  expect(psnr).toBeLessThan(1);
});

test('PSNR rejects mismatched lengths with error', () => {
  expect(() => computePsnrVsFinal(new Uint8Array(4), new Uint8Array(8))).toThrow();
});

test('SSIM of identical buffers is 1', () => {
  const w = 4, h = 4;
  const a = new Uint8Array(w * h * 4).fill(128);
  const b = new Uint8Array(w * h * 4).fill(128);
  expect(computeSsimVsFinal(a, b, w, h)).toBe(1);
});

test('SSIM of constant 0 vs constant 255 is less than 0.5', () => {
  const w = 4, h = 4;
  const a = new Uint8Array(w * h * 4).fill(0);
  const b = new Uint8Array(w * h * 4).fill(255);
  const ssim = computeSsimVsFinal(a, b, w, h);
  expect(ssim).toBeLessThan(0.5);
});

test('SSIM accepts 3ch rgb packed', () => {
  const w = 4, h = 4;
  const a = new Uint8Array(w * h * 3).fill(128);
  const b = new Uint8Array(w * h * 3).fill(128);
  expect(computeSsimVsFinal(a, b, w, h)).toBe(1);
});

test('monotone series returns { monotone: true, regressions: [] }', () => {
  const series = [
    { bytes: 1000, psnr: 15 },
    { bytes: 5000, psnr: 22 },
    { bytes: 20000, psnr: 30 },
    { bytes: 50000, psnr: 38 },
  ];
  const result = detectMonotone(series);
  expect(result.monotone).toBe(true);
  expect(result.regressions).toEqual([]);
});

test('series with 1 dB regression is flagged', () => {
  const series = [
    { bytes: 1000, psnr: 22 },
    { bytes: 5000, psnr: 30 },
    { bytes: 20000, psnr: 28.5 },
    { bytes: 50000, psnr: 38 },
  ];
  const result = detectMonotone(series);
  expect(result.monotone).toBe(false);
  expect(result.regressions.length).toBe(1);
  expect(result.regressions[0].bytes).toBe(20000);
  expect(result.regressions[0].dropDb).toBeGreaterThan(0.5);
});

test('0.4 dB regression is within tolerance', () => {
  const series = [
    { bytes: 1000, psnr: 30 },
    { bytes: 5000, psnr: 29.6 },
    { bytes: 20000, psnr: 35 },
  ];
  const result = detectMonotone(series);
  expect(result.monotone).toBe(true);
  expect(result.regressions.length).toBe(0);
});

test('detectMonotone supports lowerIsBetter for butter-like series', () => {
  const series = [
    { bytes: 1000, butter: 2.1 },
    { bytes: 5000, butter: 0.9 },
    { bytes: 20000, butter: 0.4 },
  ];
  const result = detectMonotone(series, 0.1, { valueKey: 'butter', lowerIsBetter: true });
  expect(result.monotone).toBe(true);
  const bad = detectMonotone([
    { bytes: 1000, butter: 0.4 },
    { bytes: 5000, butter: 0.9 },
  ], 0.1, { valueKey: 'butter', lowerIsBetter: true });
  expect(bad.monotone).toBe(false);
});

test('butter identical yields 0', () => {
  const p = new Uint8Array(16).fill(128); // 2x2 rgba
  const xyb = pixelsToXyb(p, 4);
  expect(computeButteraugliVsFinal(xyb, p, 2, 2)).toBe(0);
});

test('butter comparer reuses and matches direct', () => {
  const p = new Uint8Array(64).fill(100);
  const cmp = createButteraugliComparer(p, 4, 4);
  const direct = computeButteraugliVsFinal(pixelsToXyb(p, 16), p, 4, 4);
  expect(cmp(p)).toBeCloseTo(direct, 10);
});

test('butter approx defined and non-nan', () => {
  const p = new Uint8Array(16).fill(80);
  const x = pixelsToXyb(p, 4);
  const sc = computeButteraugliApproxVsFinal(x, p, 2, 2);
  expect(Number.isFinite(sc)).toBe(true);
});

test('psnr/ssim handle 0-len gracefully', () => {
  const z = new Uint8Array(0);
  expect(computePsnrVsFinal(z, z)).toBe(Infinity);
  expect(computeSsimVsFinal(z, z, 0, 0)).toBe(0);
});

test('computeChannelMoments basic for features surrogate (lens12)', () => {
  const p = new Uint8Array(16).fill(128);
  const m = computeChannelMoments(p, 2, 2);
  expect(m.ch).toBeGreaterThan(0);
  expect(m.mus.length).toBe(m.ch);
});

test('SSIM ch=4 RGBA uses 3ch (alpha dropped)', () => {
  const w = 2, h = 2;
  const a = new Uint8Array(w * h * 4).fill(128);
  const b = new Uint8Array(w * h * 4).fill(128);
  expect(computeSsimVsFinal(a, b, w, h)).toBe(1);
});

test('SSIM ch=1 ok', () => {
  const w = 2, h = 2;
  const a = new Uint8Array(w * h * 1).fill(128);
  const b = new Uint8Array(w * h * 1).fill(128);
  expect(computeSsimVsFinal(a, b, w, h)).toBe(1);
});

test('moments throws on non-integer ch (parity with ssim)', () => {
  const p = new Uint8Array(5); // 5 % (1*1) !=0 ? np=1*1=1, 5/1=5 int; use bad
  expect(() => computeChannelMoments(new Uint8Array(5), 1, 2)).toThrow(); // 5 / 2 =2.5
});

test('moments outs path reuses arrays no extra alloc shape', () => {
  const p = new Uint8Array(16).fill(64);
  const o = { mus: [], vars: [] };
  const m = computeChannelMoments(p, 2, 2, 3, o);
  expect(m).toBe(o);
  expect(o.mus.length).toBe(3);
  expect(o.ch).toBe(3);
});

test('bundle returns all three', () => {
  const w=2,h=2; const p=new Uint8Array(w*h*4).fill(90); const f=new Uint8Array(w*h*4).fill(90);
  const b = computeQualityBundle(p, f, w, h);
  expect(b.psnr).toBe(Infinity); // identical pixels → Infinity (correct; Number.isFinite(Infinity) is false)
  expect(b.ssim).toBe(1);
  expect(b.moments.ch).toBeGreaterThan(0);
});

test('plateau helper delegates to detectMonotone', () => {
  const s = [{bytes:1,psnr:20},{bytes:2,psnr:30}];
  expect(isQualityPlateau(s)).toBe(true);
});

test('detectMonotone multi regression', () => {
  const series = [{bytes:1,psnr:30},{bytes:2,psnr:25},{bytes:3,psnr:35},{bytes:4,psnr:20}];
  const r = detectMonotone(series);
  expect(r.monotone).toBe(false);
  expect(r.regressions.length).toBeGreaterThan(1);
});

test('psnr peak param', () => {
  const a = new Uint8Array([0]); const b = new Uint8Array([255]);
  expect(computePsnrVsFinal(a, b, 255)).toBeLessThan(1);
  // peak=1 would be different scale but default keeps 255 compat
});

// computePsnrSsimFused: parity tests vs separate calls + edge cases.
test('fused identical pixels → psnr Infinity, ssim 1', () => {
  const w = 4, h = 4;
  const a = new Uint8Array(w * h * 4).fill(128);
  const { psnr, ssim } = computePsnrSsimFused(a, a, w, h);
  expect(psnr).toBe(Infinity);
  expect(ssim).toBe(1);
});

test('fused PSNR matches computePsnrVsFinal', () => {
  const w = 8, h = 8;
  const a = new Uint8Array(w * h * 4).map((_, i) => i % 256);
  const b = new Uint8Array(w * h * 4).map((_, i) => (i * 3 + 7) % 256);
  expect(computePsnrSsimFused(a, b, w, h).psnr).toBeCloseTo(computePsnrVsFinal(a, b), 10);
});

test('fused SSIM matches computeSsimVsFinal', () => {
  const w = 8, h = 8;
  const a = new Uint8Array(w * h * 4).map((_, i) => i % 256);
  const b = new Uint8Array(w * h * 4).map((_, i) => (i * 3 + 7) % 256);
  expect(computePsnrSsimFused(a, b, w, h).ssim).toBeCloseTo(computeSsimVsFinal(a, b, w, h), 10);
});

test('fused mismatched lengths throws', () => {
  expect(() => computePsnrSsimFused(new Uint8Array(4), new Uint8Array(8), 1, 1)).toThrow();
});

test('fused 0x0 → { psnr: Infinity, ssim: 0 }', () => {
  const r = computePsnrSsimFused(new Uint8Array(0), new Uint8Array(0), 0, 0);
  expect(r.psnr).toBe(Infinity);
  expect(r.ssim).toBe(0);
});

test('fused 3ch parity with separate calls', () => {
  const w = 4, h = 4;
  const a = new Uint8Array(w * h * 3).fill(80);
  const b = new Uint8Array(w * h * 3).fill(160);
  const fused = computePsnrSsimFused(a, b, w, h);
  expect(fused.psnr).toBeCloseTo(computePsnrVsFinal(a, b), 10);
  expect(fused.ssim).toBeCloseTo(computeSsimVsFinal(a, b, w, h), 10);
});

// flipFlop harness (layer5, advanced Q): alternate A/B 10x on same op, medians for targeted speedup/regression guard on hot kernels.
// Use when landing future scalar/SIMD/C++ changes to these loops (psnr/ssim/moments). Here exercises current post-edit.
function flipFlop(name, aFn, bFn, dataArgs, runs = 10) {
  const times = { a: [], b: [] };
  for (let i = 0; i < runs; i++) {
    let t0 = performance.now(); aFn(...dataArgs); times.a.push(performance.now() - t0);
    t0 = performance.now(); bFn(...dataArgs); times.b.push(performance.now() - t0);
  }
  const med = (arr) => { const s = arr.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  return { name, medA: med(times.a), medB: med(times.b) };
}

// Wall-clock median ratio on a sub-ms kernel: opt-in only (web/timing-gate.js).
(timingEnabled() ? test : test.skip)('timing (RCW_TIMING=1): flipflop harness on moments (changed kernel)', () => {
  const p = new Uint8Array(1024 * 4).fill(77); // ~1k px
  const r = flipFlop('moments', computeChannelMoments, computeChannelMoments, [p, 32, 32, 3]);
  expect(r.medB).toBeLessThanOrEqual(r.medA * 1.2); // guard, same fn here; real use swaps old/new
  // console.log for manual: console.log(r);
});
