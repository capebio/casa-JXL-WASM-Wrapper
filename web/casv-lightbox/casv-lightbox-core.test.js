// node --test  web/casv-lightbox/casv-lightbox-core.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, defaultThreshForDistance, frameKindLabel, formatRate,
  fpsOf, timecode, suggestExportName, buildEncodeRequest,
  classifyDroppedEncodePaths, shouldHandleEncodeDrop,
} from './casv-lightbox-core.js';

test('presets carry the documented distance/effort', () => {
  assert.equal(PRESETS.realtime.distance, 2.0);
  assert.equal(PRESETS.realtime.effort, 1);
  assert.equal(PRESETS.balanced.distance, 1.0);
  assert.equal(PRESETS.balanced.effort, 3);
  assert.equal(PRESETS.quality.distance, 0.5);
  assert.equal(PRESETS.quality.effort, 4);
  assert.equal(PRESETS.archive.rate, 'lossless');
});

test('defaultThreshForDistance = distance*4 clamped to 16', () => {
  assert.equal(defaultThreshForDistance(1.0), 4);
  assert.equal(defaultThreshForDistance(0.5), 2);
  assert.equal(defaultThreshForDistance(2.0), 8);
  assert.equal(defaultThreshForDistance(10), 16); // clamp
  assert.equal(defaultThreshForDistance(0), 0);
});

test('frameKindLabel classifies I / P variants', () => {
  assert.equal(frameKindLabel({ isPFrame: false }), 'I');
  assert.equal(frameKindLabel(null), 'I');
  assert.equal(frameKindLabel({ isPFrame: true, isBbox: true, isReplace: true }), 'P·bbox·replace');
  assert.equal(frameKindLabel({ isPFrame: true, isTile: true }), 'P·tile');
  assert.equal(frameKindLabel({ isPFrame: true }), 'P·full');
});

test('formatRate summarizes tiers', () => {
  assert.match(formatRate({ fable: true }), /FableBraid/);
  assert.equal(formatRate({ lossy: false }), 'lossless');
  assert.equal(formatRate({ lossy: true, distance: 1.0, effort: 3 }), 'lossy · d=1.0 · effort 3');
});

test('fpsOf guards zero denominator', () => {
  assert.equal(fpsOf({ fpsNum: 24, fpsDen: 1 }), 24);
  assert.equal(fpsOf({ fpsNum: 24000, fpsDen: 1001 }).toFixed(2), '23.98');
  assert.equal(fpsOf({ fpsNum: 24, fpsDen: 0 }), 0);
  assert.equal(fpsOf(null), 0);
});

test('timecode formats mm:ss.mmm', () => {
  assert.equal(timecode(0, 24), '00:00.000');
  assert.equal(timecode(24, 24), '00:01.000');
  assert.equal(timecode(36, 24), '00:01.500');
  assert.equal(timecode(5, 0), '#5'); // no fps → frame index
});

test('suggestExportName swaps extension to .casv', () => {
  assert.equal(suggestExportName('clip.casv'), 'clip.casv');
  assert.equal(suggestExportName('shoot_01.mp4'), 'shoot_01.casv');
  assert.equal(suggestExportName(null), 'casava-export.casv');
});

test('buildEncodeRequest validates and normalizes', () => {
  const req = buildEncodeRequest({
    inputPaths: ['/a/1.png', '/a/2.png'],
    rate: 'lossy', distance: 1.0, effort: 3, gop: 24, skip: 'tile', tile: 64,
    fpsNum: 24, fpsDen: 1,
  });
  assert.equal(req.rate, 'lossy');
  assert.equal(req.sourceKind, 'images');
  assert.equal(req.distance, 1.0);
  assert.equal(req.effort, 3);
  assert.equal(req.skip, 'tile');
  assert.equal(req.thresh, 4); // auto = distance*4
  assert.equal(req.inputPaths.length, 2);
  assert.equal(req.outputPath, null);
});

test('buildEncodeRequest supports video defaults', () => {
  const req = buildEncodeRequest({
    sourceKind: 'video',
    inputPaths: ['C:/video/sintel.webm'],
    rate: 'lossy', distance: 1.0, effort: 3, gop: 24, skip: 'tile', tile: 32,
    dim: 'exact', autoFps: true,
  });
  assert.equal(req.sourceKind, 'video');
  assert.equal(req.inputPaths.length, 1);
  assert.equal(req.fpsNum, 0);
  assert.equal(req.fpsDen, 1);
  assert.equal(req.dim, 'exact');
  assert.equal(req.tile, 32);
});

test('buildEncodeRequest validates video input count and dim', () => {
  assert.throws(() => buildEncodeRequest({
    sourceKind: 'video',
    inputPaths: ['a.mp4', 'b.mp4'],
  }), /exactly one video/);
  const req = buildEncodeRequest({
    sourceKind: 'video',
    inputPaths: ['a.mp4'],
    dim: 'weird',
    autoFps: false,
    fpsNum: 30000,
    fpsDen: 1001,
  });
  assert.equal(req.dim, 'exact');
  assert.equal(req.fpsNum, 30000);
  assert.equal(req.fpsDen, 1001);
});

test('buildEncodeRequest rejects empty input', () => {
  assert.throws(() => buildEncodeRequest({ inputPaths: [] }), /Pick at least one/);
});

test('buildEncodeRequest clamps out-of-range and honors lossless', () => {
  const req = buildEncodeRequest({
    inputPaths: ['x.png'], rate: 'lossless',
    distance: 99, effort: 50, gop: -3, skip: 'weird', tile: 3, fpsNum: 0, fpsDen: 0,
  });
  assert.equal(req.rate, 'lossless');
  assert.equal(req.distance, 0);      // lossless forces 0
  assert.equal(req.effort, 10);       // clamp hi
  assert.equal(req.gop, 1);           // clamp lo
  assert.equal(req.skip, 'none');     // invalid → none
  assert.equal(req.tile, 8);          // clamp lo
  assert.equal(req.fpsNum, 1);        // clamp lo
  assert.equal(req.fpsDen, 1);
});

test('explicit threshold overrides auto', () => {
  const req = buildEncodeRequest({
    inputPaths: ['x.png'], rate: 'lossy', distance: 1.0, thresh: 12,
  });
  assert.equal(req.thresh, 12);
});

test('classifyDroppedEncodePaths selects video drops for native encode', () => {
  const picked = classifyDroppedEncodePaths([
    'C:/clips/readme.txt',
    'C:/clips/sintel.webm',
    'C:/clips/poster.png',
  ], 'images');
  assert.equal(picked.sourceKind, 'video');
  assert.deepEqual(picked.inputPaths, ['C:/clips/sintel.webm']);
  assert.equal(picked.label, 'sintel.webm');
});

test('classifyDroppedEncodePaths keeps image sequences when no video is dropped', () => {
  const picked = classifyDroppedEncodePaths([
    'C:/frames/0001.png',
    'C:/frames/0002.jpg',
  ], 'video');
  assert.equal(picked.sourceKind, 'images');
  assert.deepEqual(picked.inputPaths, ['C:/frames/0001.png', 'C:/frames/0002.jpg']);
  assert.equal(picked.label, '2 images selected');
});

test('shouldHandleEncodeDrop detects local video/image drops by filename', () => {
  assert.equal(shouldHandleEncodeDrop(['bigbuckbunny.mp4']), true);
  assert.equal(shouldHandleEncodeDrop(['0001.png', '0002.jpg']), true);
  assert.equal(shouldHandleEncodeDrop(['notes.txt']), false);
});

test('mov videos (incl. uppercase .MOV) are handled as video sources', () => {
  const path = 'C:/Videography/Julian Bayliss/Camera 2/P3190006.MOV';
  assert.equal(shouldHandleEncodeDrop([path]), true);
  const picked = classifyDroppedEncodePaths([path], 'images');
  assert.equal(picked.sourceKind, 'video');
  assert.deepEqual(picked.inputPaths, [path]);
  assert.equal(picked.label, 'P3190006.MOV');
  const req = buildEncodeRequest({
    sourceKind: 'video', inputPaths: [path], rate: 'lossy', autoFps: true,
  });
  assert.equal(req.sourceKind, 'video');
  assert.deepEqual(req.inputPaths, [path]);
});
