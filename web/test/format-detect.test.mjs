import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, acceptExtensions, isPipelineInput } from '../format-detect.js';

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

// Finding 14: single-source accept list
test('acceptExtensions includes JPEG extensions (jpg, jpeg, jfif)', () => {
  const acc = acceptExtensions();
  assert.ok(acc.includes('.jpg'), 'missing .jpg');
  assert.ok(acc.includes('.jpeg'), 'missing .jpeg');
  assert.ok(acc.includes('.jfif'), 'missing .jfif');
  assert.ok(acc.includes('.JPG'), 'missing .JPG');
  assert.ok(acc.includes('.JPEG'), 'missing .JPEG');
  assert.ok(acc.includes('.JFIF'), 'missing .JFIF');
});

test('acceptExtensions includes EXR and TIFF', () => {
  const acc = acceptExtensions();
  assert.ok(acc.includes('.exr'), 'missing .exr');
  assert.ok(acc.includes('.tif'), 'missing .tif');
  assert.ok(acc.includes('.tiff'), 'missing .tiff');
});

test('isPipelineInput accepts JPEG files', () => {
  assert.equal(isPipelineInput('photo.jpg'), true);
  assert.equal(isPipelineInput('photo.JPEG'), true);
  assert.equal(isPipelineInput('photo.jfif'), true);
});

test('isPipelineInput rejects JXL and PNG', () => {
  assert.equal(isPipelineInput('photo.jxl'), false);
  assert.equal(isPipelineInput('photo.png'), false);
});
