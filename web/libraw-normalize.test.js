import { test, expect } from 'vitest';
import {
  cfaPhaseFromLibRawFilters,
  metadataToRawMosaicPayload,
  orientationFromLibRawFlip,
} from './libraw-normalize.js';

const code = { R: 0, G: 1, B: 2 };
function filtersFor(pattern) {
  let filters = 0;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 2; col++) {
      const ch = pattern[(row & 1) * 2 + (col & 1)];
      filters |= code[ch] << ((((row << 1) & 14) + (col & 1)) << 1);
    }
  }
  return filters >>> 0;
}

test('cfaPhaseFromLibRawFilters maps Bayer top-left patterns to existing phase code', () => {
  expect(cfaPhaseFromLibRawFilters(filtersFor('RGGB'), 'RGBG')).toBe(0);
  expect(cfaPhaseFromLibRawFilters(filtersFor('GRBG'), 'RGBG')).toBe(1);
  expect(cfaPhaseFromLibRawFilters(filtersFor('GBRG'), 'RGBG')).toBe(2);
  expect(cfaPhaseFromLibRawFilters(filtersFor('BGGR'), 'RGBG')).toBe(3);
});

test('cfaPhaseFromLibRawFilters rejects non-Bayer or missing filters', () => {
  expect(cfaPhaseFromLibRawFilters(0, 'RGBG')).toBe(null);
  expect(cfaPhaseFromLibRawFilters(filtersFor('RGGB'), 'RGEG')).toBe(null);
});

test('orientationFromLibRawFlip maps dcraw flip to EXIF orientation tags', () => {
  expect(orientationFromLibRawFlip(0)).toBe(1);
  expect(orientationFromLibRawFlip(3)).toBe(3);
  expect(orientationFromLibRawFlip(5)).toBe(8);
  expect(orientationFromLibRawFlip(6)).toBe(6);
  expect(orientationFromLibRawFlip(99)).toBe(1);
});

test('metadataToRawMosaicPayload extracts render params for Rust raw mosaic processor', () => {
  const raw = new Uint16Array([10, 20, 30, 40]);
  const payload = metadataToRawMosaicPayload({
    camera_make: 'NIKON',
    camera_model: 'D850',
    flip: 6,
    filters: filtersFor('BGGR'),
    cdesc: 'RGBG',
    color_data: {
      black: 512,
      maximum: 16383,
      data_maximum: 15000,
      cam_mul: [2, 1, 1.5, 1],
      rgb_cam: [
        [1.1, -0.1, 0.0, 0.0],
        [-0.2, 1.3, -0.1, 0.0],
        [0.0, -0.3, 1.4, 0.0],
      ],
    },
  }, {
    width: 2,
    height: 2,
    raw_width: 2,
    raw_height: 2,
    left_margin: 0,
    top_margin: 0,
    data: raw,
  }, 'libraw');

  expect(payload.raw).toBe(raw);
  expect(payload.width).toBe(2);
  expect(payload.height).toBe(2);
  expect(payload.cfaPhase).toBe(3);
  expect(payload.black).toBe(512);
  expect(payload.white).toBe(16383);
  expect(payload.wbR).toBe(2);
  expect(payload.wbB).toBe(1.5);
  expect(payload.orientation).toBe(6);
  expect(payload.colorMatrix).toEqual([
    1.1, -0.1, 0.0,
    -0.2, 1.3, -0.1,
    0.0, -0.3, 1.4,
  ]);
  expect(payload.make).toBe('NIKON');
  expect(payload.model).toBe('D850');
  expect(payload.decoder).toBe('libraw');
});

test('black is recovered from the masked margin when LibRaw reports 0 (M200/CRW case)', () => {
  // 6x6 raw: top 2 rows masked (pedestal 8), left 2 cols contaminated bright (90),
  // rest active (100). Visible crop is the inner 4x4. reported black = 0.
  const rw = 6, rh = 6;
  const raw = new Uint16Array(rw * rh).fill(100);
  for (let y = 0; y < 2; y++) for (let x = 0; x < rw; x++) raw[y * rw + x] = 8; // masked top
  for (let y = 2; y < rh; y++) for (let x = 0; x < 2; x++) raw[y * rw + x] = 90; // bright left
  const meta = {
    camera_make: 'Canon', camera_model: 'EOS M200', flip: 0,
    filters: filtersFor('RGGB'), cdesc: 'RGBG',
    color_data: { black: 0, maximum: 16383, cam_mul: [2, 1, 1.5, 1], rgb_cam: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] },
  };
  const ri = { width: 4, height: 4, raw_width: rw, raw_height: rh, left_margin: 2, top_margin: 2, data: raw };
  const payload = metadataToRawMosaicPayload(meta, ri, 'libraw');
  // MIN of the margin means picks the genuinely-masked (darkest) region, not the bright left.
  expect(payload.black).toBe(8);
});

test('a genuine reported black (>0) is preferred over margin recovery', () => {
  const rw = 6, rh = 6;
  const raw = new Uint16Array(rw * rh).fill(100);
  for (let y = 0; y < 2; y++) for (let x = 0; x < rw; x++) raw[y * rw + x] = 8;
  const meta = {
    camera_make: 'Canon', camera_model: 'X', flip: 0, filters: filtersFor('RGGB'), cdesc: 'RGBG',
    color_data: { black: 256, maximum: 16383, cam_mul: [2, 1, 1.5, 1], rgb_cam: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] },
  };
  const ri = { width: 4, height: 4, raw_width: rw, raw_height: rh, left_margin: 2, top_margin: 2, data: raw };
  expect(metadataToRawMosaicPayload(meta, ri, 'libraw').black).toBe(256);
});
