import { test, expect } from 'vitest';
import { decodeWithLibRaw } from './libraw-decode.js';

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

test('decodeWithLibRaw opens bytes, reads full metadata and raw mosaic, then disposes', async () => {
  const calls = [];
  const raw = new Uint16Array([100, 200, 300, 400]);
  class FakeLibRaw {
    async open(bytes, settings) {
      calls.push(['open', bytes, settings]);
    }
    async metadata(full) {
      calls.push(['metadata', full]);
      return {
        camera_make: 'NIKON',
        camera_model: 'D850',
        flip: 0,
        filters: filtersFor('RGGB'),
        cdesc: 'RGBG',
        color_data: {
          black: 256,
          maximum: 16383,
          cam_mul: [2, 1, 1.25, 1],
          rgb_cam: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
        },
      };
    }
    async rawImageData() {
      calls.push(['rawImageData']);
      return { width: 2, height: 2, raw_width: 2, raw_height: 2, left_margin: 0, top_margin: 0, data: raw };
    }
    dispose() {
      calls.push(['dispose']);
    }
  }

  const bytes = new Uint8Array([1, 2, 3]);
  const payload = await decodeWithLibRaw(bytes, 'sample.NEF', { LibRawClass: FakeLibRaw });

  expect(calls[0][0]).toBe('open');
  expect(calls[0][1]).toBe(bytes);
  expect(calls[0][2]).toMatchObject({ noInterpolation: true, outputBps: 16, noAutoBright: true });
  expect(calls.map((c) => c[0])).toEqual(['open', 'metadata', 'rawImageData', 'dispose']);
  expect(calls[1][1]).toBe(true);
  expect(payload.raw).toBe(raw);
  expect(payload.decoder).toBe('libraw:nef');
  expect(payload.make).toBe('NIKON');
  expect(payload.model).toBe('D850');
  // iso should be null when not present in metadata
  expect(payload.iso).toBeNull();
  // blackLevels and whiteLevels should be present
  expect(payload.blackLevels).toEqual([256, 256, 256, 256]);
  expect(payload.whiteLevels).toEqual([16383, 16383, 16383, 16383]);
});

test('decodeWithLibRaw passes iso from metadata when present', async () => {
  const raw = new Uint16Array([100, 200, 300, 400]);
  class FakeLibRawWithIso {
    async open() {}
    async metadata() {
      const code = { R: 0, G: 1, B: 2 };
      let filters = 0;
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 2; col++) {
          const ch = 'RGGB'[(row & 1) * 2 + (col & 1)];
          filters |= code[ch] << ((((row << 1) & 14) + (col & 1)) << 1);
        }
      }
      return {
        camera_make: 'Canon', camera_model: 'EOS R5',
        flip: 0, filters: filters >>> 0, cdesc: 'RGBG',
        iso_speed: 1600,
        color_data: {
          black: 512, maximum: 16383,
          cam_mul: [2, 1, 1.5, 1],
          rgb_cam: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
        },
      };
    }
    async rawImageData() {
      return { width: 2, height: 2, raw_width: 2, raw_height: 2, left_margin: 0, top_margin: 0, data: raw };
    }
    dispose() {}
  }

  const payload = await decodeWithLibRaw(new Uint8Array([1]), 'sample.CR3', { LibRawClass: FakeLibRawWithIso });
  expect(payload.iso).toBe(1600);
  expect(payload.decoder).toBe('libraw:cr3');
});