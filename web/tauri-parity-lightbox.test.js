import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { M2_RANGES } from './tauri-parity-lightbox.js';

const mainJs = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('M2 slider ranges match pyramid checklist', () => {
  expect(M2_RANGES.shadows).toEqual([0, 100]);
  expect(M2_RANGES.highlights).toEqual([-100, 0]);
  expect(M2_RANGES.brightness).toEqual([-100, 100]);
});

test('main.js wires Tauri parity lightbox + H29 channel path', () => {
  // Lazy since finding 47 (7ab100bf): loaded on first lightbox open, never statically.
  expect(mainJs).toContain("makeLazyModule(() => import('./tauri-parity-lightbox.js'))");
  expect(mainJs).toContain('const { createTauriParityLightbox } = await lazyTauriParity();');
  expect(mainJs).toContain('apply_look_stream');
  expect(mainJs).toContain('jxl_progressive_pass');
  expect(mainJs).toContain('tauriParityLb');
});

test('index.html exposes M2 panel and 16-bit HDR toggle for Tauri', () => {
  expect(indexHtml).toContain('data-tauri-m2-panel');
  expect(indexHtml).toContain('data-toggle-16bit');
  expect(indexHtml).toContain('data-m2-preset');
  expect(indexHtml).toContain('data-m2="shadows"');
});