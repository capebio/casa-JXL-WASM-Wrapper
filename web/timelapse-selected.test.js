// node --test  web/timelapse-selected.test.js
//
// Tests for Milestone 1 (finding 15): selected-asset timelapse with
// sequential reads, memory budget, cancellation, per-asset edits, and
// export-service integration.
//
// All functions under test live in timelapse-core.js (pure logic, no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterSelectedAssets,
  buildSequentialFrames,
  applyLookToDecodeArgs,
  makeTimelapseCancelToken,
  buildTimelapseExportRequest,
  decodeRawNeutralRgb,
} from './timelapse-core.js';

// The REAL WASM RAW decoder ABI (ground truth: src/lib.rs process_orf /
// process_dng / process_cr2; mirrored by web/worker.js RAW_NEUTRAL and by
// decodeRawNeutralRgb here). 14 positional f32 args, in THIS exact order:
//
//   0 exposure_ev  1 contrast   2 highlights  3 shadows  4 whites   5 blacks
//   6 saturation   7 vibrance   8 temp        9 tint     10 wb_r    11 wb_b
//   12 texture     13 clarity
//
// WB overrides default to NaN = use each file's embedded camera white balance.
const NEUTRAL_ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0];

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minimal asset card descriptors used across tests. */
function makeCards(overrides = []) {
  return [
    { assetId: 'a1', name: 'P001.ORF', selected: true,  file: {}, look: {} },
    { assetId: 'a2', name: 'P002.ORF', selected: false, file: {}, look: {} },
    { assetId: 'a3', name: 'P003.DNG', selected: true,  file: {}, look: { exposure: 0.5 } },
    ...overrides,
  ];
}

// ── filterSelectedAssets ─────────────────────────────────────────────────────

test('filterSelectedAssets returns only selected cards in sorted order', () => {
  const cards = makeCards();
  const sel = filterSelectedAssets(cards);
  assert.equal(sel.length, 2);
  assert.equal(sel[0].assetId, 'a1');
  assert.equal(sel[1].assetId, 'a3');
});

test('filterSelectedAssets returns empty array when nothing selected', () => {
  const cards = makeCards().map((c) => ({ ...c, selected: false }));
  assert.deepEqual(filterSelectedAssets(cards), []);
});

test('filterSelectedAssets preserves capture order (sort by name)', () => {
  // Out-of-order input must come out alphabetically-numerically sorted.
  const cards = [
    { assetId: 'z', name: 'P010.ORF', selected: true, file: {} },
    { assetId: 'a', name: 'P002.ORF', selected: true, file: {} },
    { assetId: 'm', name: 'P005.DNG', selected: true, file: {} },
  ];
  const names = filterSelectedAssets(cards).map((c) => c.name);
  assert.deepEqual(names, ['P002.ORF', 'P005.DNG', 'P010.ORF']);
});

// ── applyLookToDecodeArgs (BUG 1: real 14-slot decoder ABI) ───────────────────

test('applyLookToDecodeArgs emits EXACTLY 14 slots (the real decoder arity)', () => {
  // src/lib.rs process_orf/dng/cr2 take 14 positional f32 args — not 15.
  assert.equal(applyLookToDecodeArgs({}).length, 14);
});

test('applyLookToDecodeArgs neutral look == the neutral decode args', () => {
  assert.deepEqual(applyLookToDecodeArgs({}), NEUTRAL_ARGS);
  assert.deepEqual(applyLookToDecodeArgs(), NEUTRAL_ARGS);
});

test('applyLookToDecodeArgs mirrors decodeRawNeutralRgb positional args (RAW_NEUTRAL semantics)', () => {
  // Capture the exact args decodeRawNeutralRgb feeds the decoder, then assert the
  // neutral look mapping reproduces them slot-for-slot — the real ABI, checked
  // end-to-end against the one place that already gets it right.
  const captured = [];
  const fakeMod = {
    process_orf: (_bytes, ...rest) => {
      captured.push(...rest);
      return { take_rgb: () => new Uint8Array(0), width: 1, height: 1, free() {} };
    },
  };
  decodeRawNeutralRgb(fakeMod, new Uint8Array(0), 'x.orf');
  assert.equal(captured.length, 14, 'decoder called with 14 look args');
  assert.deepEqual(captured, NEUTRAL_ARGS);
  assert.deepEqual(applyLookToDecodeArgs({}), captured);
});

test('applyLookToDecodeArgs lands each look-edit field in its CORRECT decoder slot', () => {
  // Distinct value per slot so any transposition is caught. Field names mirror
  // panels.js LOOK_PARAMS (exposureEv, not "exposure").
  const look = {
    exposureEv: 1, contrast: 2, highlights: 3, shadows: 4, whites: 5, blacks: 6,
    saturation: 7, vibrance: 8, temp: 9, tint: 10, wbR: 11, wbB: 12,
    texture: 13, clarity: 14,
  };
  assert.deepEqual(
    applyLookToDecodeArgs(look),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  );
});

test('applyLookToDecodeArgs: WB overrides live in slots 10/11, not 2/3', () => {
  const args = applyLookToDecodeArgs({ wbR: 1.9, wbB: 2.3 });
  assert.equal(args[10], 1.9, 'wb_r_override slot');
  assert.equal(args[11], 2.3, 'wb_b_override slot');
  assert.equal(args[2], 0, 'highlights slot untouched by WB');
  assert.equal(args[3], 0, 'shadows slot untouched by WB');
});

test('applyLookToDecodeArgs: WB defaults to NaN (camera metadata) in the override slots', () => {
  const args = applyLookToDecodeArgs({ exposureEv: 0.5 });
  assert.ok(Number.isNaN(args[10]), 'wb_r default NaN');
  assert.ok(Number.isNaN(args[11]), 'wb_b default NaN');
  assert.equal(args[0], 0.5);
});

test('applyLookToDecodeArgs ignores non-numeric and unknown (invented) fields', () => {
  // '3' is a string → default; hue/sharpness/denoise/wbG are not decoder params.
  const args = applyLookToDecodeArgs({ exposureEv: '3', hue: 5, sharpness: 9, denoise: 1, wbG: 2 });
  assert.deepEqual(args, NEUTRAL_ARGS);
});

// ── makeTimelapseCancelToken ─────────────────────────────────────────────────

test('makeTimelapseCancelToken starts not cancelled', () => {
  const { isCancelled } = makeTimelapseCancelToken();
  assert.equal(isCancelled(), false);
});

test('makeTimelapseCancelToken cancel() sets isCancelled to true', () => {
  const { cancel, isCancelled } = makeTimelapseCancelToken();
  cancel();
  assert.equal(isCancelled(), true);
});

// ── buildSequentialFrames ─────────────────────────────────────────────────────
// buildSequentialFrames yields frames one at a time (not all-at-once),
// respects the memory budget (bytes in flight), and stops on cancel.
// Dependency-injected readBytes(card) keeps it DOM/node-free.

test('buildSequentialFrames yields each selected card with its bytes', async () => {
  const cards = [
    { assetId: 'a1', name: 'P001.ORF', selected: true, file: {} },
    { assetId: 'a2', name: 'P002.DNG', selected: true, file: {} },
  ];
  const byteMap = {
    a1: new Uint8Array([0x01]),
    a2: new Uint8Array([0x02]),
  };
  const readBytes = async (card) => byteMap[card.assetId];
  const { cancel, isCancelled } = makeTimelapseCancelToken();
  const results = [];
  for await (const frame of buildSequentialFrames(cards, readBytes, { isCancelled })) {
    results.push({ assetId: frame.assetId, name: frame.name, byteLen: frame.bytes.length });
  }
  assert.equal(results.length, 2);
  assert.equal(results[0].assetId, 'a1');
  assert.equal(results[1].assetId, 'a2');
});

test('buildSequentialFrames stops immediately on cancel', async () => {
  const cards = [
    { assetId: 'a1', name: 'P001.ORF' },
    { assetId: 'a2', name: 'P002.ORF' },
    { assetId: 'a3', name: 'P003.ORF' },
  ];
  const { cancel, isCancelled } = makeTimelapseCancelToken();
  let readCount = 0;
  const readBytes = async (card) => {
    readCount++;
    if (readCount === 1) cancel(); // cancel after first read
    return new Uint8Array([readCount]);
  };
  const results = [];
  for await (const frame of buildSequentialFrames(cards, readBytes, { isCancelled })) {
    results.push(frame);
  }
  // Only the first frame was yielded; generator stopped after cancel
  assert.equal(results.length, 1);
});

test('buildSequentialFrames respects maxBytesInFlight memory budget', async () => {
  // Simulate 3 frames of 1000 bytes each; budget = 1500 bytes.
  // Generator should read one-at-a-time (never exceeds 1000 bytes at a time
  // since we yield before reading the next). This test verifies the generator
  // pauses when outstanding bytes would exceed the budget.
  const FRAME_SIZE = 1000;
  const cards = [1, 2, 3].map((i) => ({ assetId: `a${i}`, name: `P00${i}.ORF` }));
  const { isCancelled } = makeTimelapseCancelToken();
  const concurrentBytesHistory = [];
  let outstanding = 0;
  const readBytes = async (card) => {
    outstanding += FRAME_SIZE;
    concurrentBytesHistory.push(outstanding);
    return new Uint8Array(FRAME_SIZE);
  };
  for await (const frame of buildSequentialFrames(cards, readBytes, {
    isCancelled, maxBytesInFlight: 1500,
  })) {
    outstanding -= frame.bytes.length;
  }
  // Peak concurrent bytes must never exceed maxBytesInFlight (1500)
  // but we always decode at least 1 frame's worth (1000) in-flight
  assert.ok(
    concurrentBytesHistory.every((b) => b <= 1500),
    `outstanding bytes exceeded budget: ${JSON.stringify(concurrentBytesHistory)}`,
  );
});

test('buildSequentialFrames does NOT silently drop a frame larger than the budget', async () => {
  // Reads are sequential (outstanding == 0 at the loop top), so a per-frame
  // budget must never cause a valid frame to be dropped. A frame bigger than
  // maxBytesInFlight must STILL be yielded, not skipped with `continue`.
  const cards = [
    { assetId: 'small', name: 's.orf' },
    { assetId: 'big',   name: 'b.orf' },
    { assetId: 'small2', name: 't.orf' },
  ];
  const readBytes = async (c) => new Uint8Array(c.assetId === 'big' ? 1000 : 10);
  const results = [];
  for await (const frame of buildSequentialFrames(cards, readBytes, { maxBytesInFlight: 100 })) {
    results.push(frame.assetId);
  }
  assert.deepEqual(results, ['small', 'big', 'small2'],
    'the over-budget frame must be yielded, and later frames must not be lost');
});

test('buildSequentialFrames skips cards where readBytes returns null/undefined', async () => {
  const cards = [
    { assetId: 'a1', name: 'P001.ORF' },
    { assetId: 'a2', name: 'P002.ORF' }, // will return null
    { assetId: 'a3', name: 'P003.ORF' },
  ];
  const { isCancelled } = makeTimelapseCancelToken();
  const readBytes = async (card) => card.assetId === 'a2' ? null : new Uint8Array([1]);
  const results = [];
  for await (const frame of buildSequentialFrames(cards, readBytes, { isCancelled })) {
    results.push(frame.assetId);
  }
  assert.deepEqual(results, ['a1', 'a3']);
});

// ── buildTimelapseExportRequest ───────────────────────────────────────────────
// Builds the ExportService request from a set of selected timelapse assets.

test('buildTimelapseExportRequest produces a valid ExportService request', () => {
  const cards = [
    { assetId: 'a1', name: 'P001.ORF' },
    { assetId: 'a3', name: 'P003.DNG' },
  ];
  const req = buildTimelapseExportRequest(cards, { output: 'jxl', metadata: 'strip-gps' });
  assert.deepEqual(req.assetIds, ['a1', 'a3']);
  assert.equal(req.output, 'jxl');
  assert.equal(req.metadata, 'strip-gps');
  assert.equal(req.resolution, 'full');
});

test('buildTimelapseExportRequest defaults to keep metadata', () => {
  const cards = [{ assetId: 'a1', name: 'P001.ORF' }];
  const req = buildTimelapseExportRequest(cards, {});
  assert.equal(req.metadata, 'keep');
});
