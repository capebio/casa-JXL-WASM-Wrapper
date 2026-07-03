import { expect, test } from 'bun:test';
import { analyzeProgressiveFrame, formatFrameStatsCompact, formatFrameStatsLog } from './jxl-progressive-frame-stats.js';

test('analyzeProgressiveFrame reports alpha, rgb, luma variance, and stable hash', () => {
    const pixels = new Uint8Array([
        0, 0, 0, 0,
        10, 20, 30, 255,
        10, 20, 30, 0,
        250, 250, 250, 128,
    ]);

    const stats = analyzeProgressiveFrame(pixels, 2, 2);

    expect(stats.alphaMin).toBe(0);
    expect(stats.alphaMax).toBe(255);
    expect(stats.alphaZeroPct).toBe(50);
    expect(stats.rgbNonzeroCount).toBe(9);
    expect(stats.lumaVariance).toBeGreaterThan(8000);
    expect(stats.frameHash).toMatch(/^[0-9a-f]{8}$/);
    expect(stats.pixelCount).toBe(4);
});

test('frame stats formatting includes measurement field names', () => {
    const stats = analyzeProgressiveFrame(new Uint8Array([1, 2, 3, 0]), 1, 1);

    expect(formatFrameStatsLog(stats)).toContain('alphaMin=0');
    expect(formatFrameStatsLog(stats)).toContain('alphaZeroPct=100.00');
    expect(formatFrameStatsCompact(stats)).toContain('hash=');
    expect(formatFrameStatsCompact(stats)).toContain('rgbNonzero=');
});

test('analyzeProgressiveFrame handles zero dims + empty buffer', () => {
    const s = analyzeProgressiveFrame(new Uint8Array(0), 0, 0);
    expect(s.pixelCount).toBe(0);
    expect(s.alphaMin).toBe(0);
    expect(s.alphaZeroPct).toBe(0);
    expect(s.frameHash).toMatch(/^[0-9a-f]{8}$/);
});

test('analyzeProgressiveFrame handles truncated buffer (partial pixels)', () => {
    const buf = new Uint8Array([10,20,30,255, 40,50,60]); // 1 full + partial
    const s = analyzeProgressiveFrame(buf, 2, 2);
    expect(s.pixelCount).toBe(4);
    expect(s.alphaMax).toBe(255);
    expect(s.rgbNonzeroCount).toBeGreaterThanOrEqual(3);
});

test('analyzeProgressiveFrame hash differs on content, stable on same', () => {
    const a = analyzeProgressiveFrame(new Uint8Array([1,2,3,4]), 1, 1).frameHash;
    const b = analyzeProgressiveFrame(new Uint8Array([1,2,3,5]), 1, 1).frameHash;
    expect(a).not.toBe(b);
    expect(analyzeProgressiveFrame(new Uint8Array([1,2,3,4]), 1, 1).frameHash).toBe(a);
});

test('lumaVariance is exactly zero for a constant-colour image', () => {
    // 500×500 = 250 000 pixels all white. Zero variance by definition.
    const N = 250_000;
    const data = new Uint8Array(N * 4).fill(255);
    const stats = analyzeProgressiveFrame(data, 500, 500);
    expect(stats.lumaVariance).toBe(0);
});

test('lumaVariance matches analytic value for two-value distribution', () => {
    // Alternating black (lumaInt=0) / white (lumaInt=65025) pixels, even count.
    // Population variance = (65025/2)² = 1 057 066 890.0625; normalised /65536 ≈ 16128.117
    const N = 2000;
    const data = new Uint8Array(N * 4);
    for (let i = 0; i < N; i++) {
        const v = (i % 2 === 0) ? 255 : 0;
        data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
    }
    const stats = analyzeProgressiveFrame(data, 40, 50); // 40×50 = 2000 px
    const expected = (65025 * 65025 / 4) / 65536; // ≈ 16128.117
    expect(Math.abs(stats.lumaVariance - expected)).toBeLessThan(0.01);
});
