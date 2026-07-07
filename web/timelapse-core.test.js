// node --test  web/timelapse-core.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RAW_EXTS, extOf, isRawName, sortRawPaths, suggestTimelapseName,
  DIM_CHOICES, buildRawEncodeRequest, rawFramesSidecarArgs, rawFramesCliString,
} from './timelapse-core.js';

test('isRawName recognises ORF/DNG/CR2 (case-insensitive), rejects others', () => {
  assert.ok(isRawName('P2200474.ORF'));
  assert.ok(isRawName('shot.orf'));
  assert.ok(isRawName('IMG_0001.DNG'));
  assert.ok(isRawName('a.dng'));
  assert.ok(isRawName('IMG.CR2'));
  assert.ok(!isRawName('clip.mp4'));
  assert.ok(!isRawName('frame.png'));
  assert.ok(!isRawName('noext'));
  assert.equal(extOf('C:/x/y/A.ORF'), 'orf');
  assert.deepEqual([...RAW_EXTS].sort(), ['cr2', 'dng', 'orf']);
});

test('sortRawPaths orders by basename, numeric-aware, without mutating input', () => {
  const input = [
    'C:/995/P2200475 Kissenia.ORF',
    'C:/995/P2200474.ORF',
    'C:/995/P2200480.ORF',
    // numeric-aware: the whole digit run is one number, so 2200480 < 22004749
    'C:/995/P22004749.ORF',
  ];
  const frozen = input.slice();
  const out = sortRawPaths(input);
  assert.deepEqual(input, frozen, 'input not mutated');
  assert.deepEqual(out.map((p) => p.split('/').pop()), [
    'P2200474.ORF',
    'P2200475 Kissenia.ORF',
    'P2200480.ORF',
    'P22004749.ORF',
  ]);
});

test('sortRawPaths drops falsy entries and coerces to string', () => {
  assert.deepEqual(sortRawPaths(['b.orf', null, 'a.orf', undefined, '']), ['a.orf', 'b.orf']);
  assert.deepEqual(sortRawPaths(null), []);
});

test('suggestTimelapseName derives a stem from the first sorted file', () => {
  assert.equal(suggestTimelapseName(['C:/995/P2200474.ORF']), 'P2200474-timelapse.casv');
  assert.equal(suggestTimelapseName([]), 'timelapse-timelapse.casv');
});

test('buildRawEncodeRequest requires input', () => {
  assert.throws(() => buildRawEncodeRequest({ inputPaths: [] }), /at least one/i);
  try {
    buildRawEncodeRequest({ inputPaths: [] });
  } catch (e) {
    assert.equal(e.code, 'NO_INPUT');
  }
});

test('buildRawEncodeRequest sorts paths and defaults lossy·tile', () => {
  const req = buildRawEncodeRequest({ inputPaths: ['z.orf', 'a.orf'] });
  assert.deepEqual(req.inputPaths, ['a.orf', 'z.orf']); // sorted
  assert.equal(req.sourceKind, 'raw');
  assert.equal(req.rate, 'lossy');
  assert.equal(req.skip, 'tile');
  assert.equal(req.distance, 1.0);
  assert.equal(req.effort, 3);
  assert.equal(req.gop, 24);
  assert.equal(req.tile, 32);
  assert.equal(req.fpsNum, 24);
  assert.equal(req.fpsDen, 1);
  assert.equal(req.dim, 'exact');
  assert.equal(req.thresh, null); // → auto
  assert.equal(req.outputName, 'a-timelapse.casv');
});

test('buildRawEncodeRequest lossless forces distance 0 and keeps a valid skip', () => {
  const req = buildRawEncodeRequest({ inputPaths: ['a.dng'], rate: 'lossless', skip: 'none', effort: 7 });
  assert.equal(req.rate, 'lossless');
  assert.equal(req.distance, 0);
  assert.equal(req.skip, 'none'); // lossless batch accepts none
  assert.equal(req.effort, 7);
});

test('buildRawEncodeRequest rejects lossy skip=none by forcing tile', () => {
  const req = buildRawEncodeRequest({ inputPaths: ['a.orf'], rate: 'lossy', skip: 'none' });
  assert.equal(req.skip, 'tile'); // never emits an invalid lossy skip=none
});

test('buildRawEncodeRequest clamps out-of-range knobs', () => {
  const req = buildRawEncodeRequest({
    inputPaths: ['a.orf'], distance: 999, effort: 42, gop: 0, tile: 1, fpsNum: 9999, thresh: 500,
  });
  assert.equal(req.distance, 15);
  assert.equal(req.effort, 10);
  assert.equal(req.gop, 1);
  assert.equal(req.tile, 8);
  assert.equal(req.fpsNum, 240);
  assert.equal(req.thresh, 255);
  assert.ok(DIM_CHOICES.includes(req.dim));
});

test('rawFramesSidecarArgs matches the casv_encode --raw-frames positional order', () => {
  const req = buildRawEncodeRequest({
    inputPaths: ['C:/995/b.orf', 'C:/995/a.orf'],
    rate: 'lossy', distance: 1.5, effort: 3, gop: 12, skip: 'tile', tile: 32,
    fpsNum: 30, fpsDen: 1, dim: '1080', thresh: 8,
  });
  const argv = rawFramesSidecarArgs(req, 'C:/out/clip.casv');
  assert.deepEqual(argv, [
    '--raw-frames', 'C:/out/clip.casv',
    '30', '1',            // fps_num fps_den
    'lossy', '1.5', '3',  // rate distance effort
    '12', 'tile', '32',   // gop skip tile
    '8', '1080',          // thresh dim
    'C:/995/a.orf', 'C:/995/b.orf', // sorted files
  ]);
});

test('rawFramesSidecarArgs emits "auto" when thresh is null', () => {
  const req = buildRawEncodeRequest({ inputPaths: ['a.orf'] });
  const argv = rawFramesSidecarArgs(req, 'o.casv');
  assert.equal(argv[10], 'auto');
});

test('rawFramesCliString quotes paths containing spaces', () => {
  const req = buildRawEncodeRequest({ inputPaths: ['C:/995/P2200475 Kissenia capensis.ORF'] });
  const cli = rawFramesCliString(req, 'out.casv');
  assert.ok(cli.startsWith('casv_encode --raw-frames out.casv '));
  assert.ok(cli.includes('"C:/995/P2200475 Kissenia capensis.ORF"'));
});
