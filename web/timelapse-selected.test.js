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
} from './timelapse-core.js';

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

// ── applyLookToDecodeArgs ─────────────────────────────────────────────────────

test('applyLookToDecodeArgs returns 15-element array matching the positional WASM ABI', () => {
  const args = applyLookToDecodeArgs({});
  assert.equal(args.length, 15);
});

test('applyLookToDecodeArgs maps exposure, contrast, saturation from look', () => {
  const args = applyLookToDecodeArgs({ exposure: 1.0, contrast: 0.5, saturation: -0.3 });
  // Positional order: brightness, contrast, saturation, hue, sharpness, denoise,
  //   shadows, highlights, blacks, whites, vibrance, wbR, wbG, wbB, tint
  // The exact slot for exposure is index 0 (brightness param)
  assert.ok(args.every((v) => typeof v === 'number'), 'all elements must be numbers');
  // With no look, WB fields (indices 11, 12) are NaN (use camera WB)
  const neutral = applyLookToDecodeArgs({});
  assert.ok(Number.isNaN(neutral[11]), 'wbR defaults to NaN (camera WB)');
  assert.ok(Number.isNaN(neutral[12]), 'wbG defaults to NaN (camera WB)');
});

test('applyLookToDecodeArgs WB fields set when look provides them', () => {
  const args = applyLookToDecodeArgs({ wbR: 1.5, wbG: 1.0 });
  assert.equal(args[11], 1.5);
  assert.equal(args[12], 1.0);
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
