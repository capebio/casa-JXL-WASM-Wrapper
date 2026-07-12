import { test, expect } from 'vitest';
import {
  normalizeDenoiseOptions,
  denoiseNeedsReprocess,
  readDenoiseOptions,
} from './raw-denoise-options.js';

// ─── Defaults ─────────────────────────────────────────────────────────────────

test('normalizeDenoiseOptions(undefined) returns the canonical default (denoise off)', () => {
  expect(normalizeDenoiseOptions(undefined)).toEqual({
    enabled: false,
    activation: 'auto',
    isoThreshold: 1600,
    noiseThreshold: 1.5,
    strength: 1.0,
  });
});

test('normalizeDenoiseOptions(null) and ({}) return the canonical default', () => {
  const def = {
    enabled: false, activation: 'auto', isoThreshold: 1600, noiseThreshold: 1.5, strength: 1.0,
  };
  expect(normalizeDenoiseOptions(null)).toEqual(def);
  expect(normalizeDenoiseOptions({})).toEqual(def);
});

// ─── Activation modes ─────────────────────────────────────────────────────────

test('all three activation modes are accepted', () => {
  for (const activation of ['auto', 'iso', 'always']) {
    expect(normalizeDenoiseOptions({ activation }).activation).toBe(activation);
  }
});

test('invalid activation string throws', () => {
  expect(() => normalizeDenoiseOptions({ activation: 'sometimes' })).toThrow();
  expect(() => normalizeDenoiseOptions({ activation: 42 })).toThrow();
});

// ─── ISO presets ──────────────────────────────────────────────────────────────

test('all ISO presets are accepted', () => {
  for (const iso of [200, 400, 800, 1600, 3200, 6400]) {
    expect(normalizeDenoiseOptions({ isoThreshold: iso }).isoThreshold).toBe(iso);
  }
});

test('a numeric-string ISO preset is coerced to a number', () => {
  expect(normalizeDenoiseOptions({ isoThreshold: '3200' }).isoThreshold).toBe(3200);
});

test('an unknown ISO preset throws', () => {
  expect(() => normalizeDenoiseOptions({ isoThreshold: 100 })).toThrow();
  expect(() => normalizeDenoiseOptions({ isoThreshold: 12800 })).toThrow();
});

// ─── Sensitivity → noiseThreshold ─────────────────────────────────────────────

test('sensitivity presets map to noiseThreshold (high=1.0, normal=1.5, low=2.0)', () => {
  expect(normalizeDenoiseOptions({ sensitivity: 'high' }).noiseThreshold).toBe(1.0);
  expect(normalizeDenoiseOptions({ sensitivity: 'normal' }).noiseThreshold).toBe(1.5);
  expect(normalizeDenoiseOptions({ sensitivity: 'low' }).noiseThreshold).toBe(2.0);
});

test('an explicit noiseThreshold is accepted as-is', () => {
  expect(normalizeDenoiseOptions({ noiseThreshold: 1.0 }).noiseThreshold).toBe(1.0);
});

test('an unknown sensitivity string throws', () => {
  expect(() => normalizeDenoiseOptions({ sensitivity: 'medium' })).toThrow();
});

// ─── Strict validation ────────────────────────────────────────────────────────

test('an unknown key throws', () => {
  expect(() => normalizeDenoiseOptions({ bogus: true })).toThrow();
});

test('enabled is coerced to a boolean', () => {
  expect(normalizeDenoiseOptions({ enabled: true }).enabled).toBe(true);
  expect(normalizeDenoiseOptions({ enabled: false }).enabled).toBe(false);
});

// ─── denoiseNeedsReprocess ────────────────────────────────────────────────────

test('denoiseNeedsReprocess: enabled flip returns true', () => {
  expect(denoiseNeedsReprocess({ enabled: true }, { enabled: false })).toBe(true);
});

test('denoiseNeedsReprocess: both disabled returns false', () => {
  expect(denoiseNeedsReprocess({ enabled: false }, { enabled: false })).toBe(false);
});

test('denoiseNeedsReprocess: null/null compares as the default → false', () => {
  expect(denoiseNeedsReprocess(null, null)).toBe(false);
});

test('denoiseNeedsReprocess: null vs enabled default is false (both off)', () => {
  expect(denoiseNeedsReprocess(null, undefined)).toBe(false);
});

test('denoiseNeedsReprocess: differing activation while enabled returns true', () => {
  expect(denoiseNeedsReprocess(
    { enabled: true, activation: 'auto' },
    { enabled: true, activation: 'iso' },
  )).toBe(true);
});

test('denoiseNeedsReprocess: differing isoThreshold while enabled returns true', () => {
  expect(denoiseNeedsReprocess(
    { enabled: true, isoThreshold: 800 },
    { enabled: true, isoThreshold: 1600 },
  )).toBe(true);
});

test('denoiseNeedsReprocess: differing sensitivity (noiseThreshold) while enabled returns true', () => {
  expect(denoiseNeedsReprocess(
    { enabled: true, sensitivity: 'high' },
    { enabled: true, sensitivity: 'low' },
  )).toBe(true);
});

test('denoiseNeedsReprocess: identical enabled options returns false', () => {
  const a = { enabled: true, activation: 'iso', isoThreshold: 3200, sensitivity: 'low' };
  expect(denoiseNeedsReprocess(a, { ...a })).toBe(false);
});

// ─── readDenoiseOptions (DOM) ─────────────────────────────────────────────────

function fakeRoot(fields) {
  return {
    querySelector(sel) {
      const id = sel.replace(/^#/, '');
      if (!(id in fields)) return null;
      const v = fields[id];
      // checkbox → {checked}; select/input → {value}
      return typeof v === 'boolean' ? { checked: v } : { value: v };
    },
  };
}

test('readDenoiseOptions reads the four denoise controls into normalized options', () => {
  const root = fakeRoot({
    'denoise-enabled': true,
    'denoise-activation': 'iso',
    'denoise-iso-threshold': '3200',
    'denoise-sensitivity': 'low',
  });
  expect(readDenoiseOptions(root)).toEqual({
    enabled: true,
    activation: 'iso',
    isoThreshold: 3200,
    noiseThreshold: 2.0,
    strength: 1.0,
  });
});

test('readDenoiseOptions falls back to defaults when controls are absent', () => {
  expect(readDenoiseOptions(fakeRoot({}))).toEqual({
    enabled: false,
    activation: 'auto',
    isoThreshold: 1600,
    noiseThreshold: 1.5,
    strength: 1.0,
  });
});
