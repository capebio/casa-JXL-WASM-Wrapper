import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat } from '../format-detect.js';

test('JPEG magic routes to the jpeg pipeline, not sdr', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
  assert.equal(detectFormat(jpeg, 'photo.jpg'), 'jpeg');
});

test('PNG still routes to sdr (browser-native)', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  assert.equal(detectFormat(png, 'x.png'), 'sdr');
});

test('GIF still routes to sdr', () => {
  const gif = new Uint8Array([0x47, 0x49, 0x46]);
  assert.equal(detectFormat(gif, 'x.gif'), 'sdr');
});
