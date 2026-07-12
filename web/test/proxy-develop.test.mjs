/**
 * TDD tests for proxy-first intake mode + "Develop Selected" command.
 * Finding 10: expose proxy/develop mode + selected-only develop via scheduler.
 *
 * These test the pure logic in web/proxy-develop.js (no DOM required).
 * Run with: node --test web/test/proxy-develop.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeIntakeMode,
  selectCardsForDevelop,
  buildDevelopTask,
} from '../proxy-develop.js';

// ---------------------------------------------------------------------------
// makeIntakeMode — intake mode state machine
// ---------------------------------------------------------------------------

test('makeIntakeMode defaults to proxy-first when arg is true', () => {
  const m = makeIntakeMode(true);
  assert.equal(m.isProxy(), true);
  assert.equal(m.isFull(), false);
});

test('makeIntakeMode defaults to full-develop when arg is false', () => {
  const m = makeIntakeMode(false);
  assert.equal(m.isProxy(), false);
  assert.equal(m.isFull(), true);
});

test('makeIntakeMode.toggle switches mode', () => {
  const m = makeIntakeMode(false);
  m.toggle();
  assert.equal(m.isProxy(), true);
  m.toggle();
  assert.equal(m.isProxy(), false);
});

test('makeIntakeMode.set accepts boolean', () => {
  const m = makeIntakeMode(false);
  m.set(true);
  assert.equal(m.isProxy(), true);
  m.set(false);
  assert.equal(m.isProxy(), false);
});

// ---------------------------------------------------------------------------
// selectCardsForDevelop — identifies cards eligible for "Develop Selected"
// ---------------------------------------------------------------------------

test('selectCardsForDevelop returns only proxy-completed, selected cards', () => {
  // Simulated card state objects (plain objects, no DOM required)
  const cards = [
    { selected: true,  state: { _proxyView: true,  _file: 'a.orf', _taskId: null } },
    { selected: true,  state: { _proxyView: false, _file: 'b.dng', _taskId: 42   } },
    { selected: false, state: { _proxyView: true,  _file: 'c.cr2', _taskId: null } },
    { selected: true,  state: { _proxyView: true,  _file: 'd.arw', _taskId: null } },
  ];
  const result = selectCardsForDevelop(cards);
  // Only proxy-completed + selected cards (a and d); b is not proxy, c is not selected
  assert.equal(result.length, 2);
  assert.ok(result.includes(cards[0]));
  assert.ok(result.includes(cards[3]));
});

test('selectCardsForDevelop returns empty array when no cards match', () => {
  const cards = [
    { selected: false, state: { _proxyView: true,  _file: 'a.orf' } },
    { selected: true,  state: { _proxyView: false, _file: 'b.dng' } },
  ];
  assert.deepEqual(selectCardsForDevelop(cards), []);
});

test('selectCardsForDevelop ignores cards with no _file', () => {
  const cards = [
    { selected: true, state: { _proxyView: true, _file: null } },
    { selected: true, state: { _proxyView: true, _file: 'x.orf' } },
  ];
  const result = selectCardsForDevelop(cards);
  assert.equal(result.length, 1);
  assert.ok(result.includes(cards[1]));
});

// ---------------------------------------------------------------------------
// buildDevelopTask — builds the task descriptor for pool.submit
// ---------------------------------------------------------------------------

test('buildDevelopTask produces a descriptor with the file and priority', () => {
  const card = { selected: true, state: { _proxyView: true, _file: 'a.orf', _pendingPriority: null } };
  const task = buildDevelopTask(card, { quality: 90, effort: 3, lossless: false });
  assert.equal(task.file, 'a.orf');
  assert.equal(task.priority, 'high');  // Develop Selected always submits at high priority
  assert.equal(task.options.quality, 90);
  assert.equal(task.options.effort, 3);
});

test('buildDevelopTask includes card reference for state updates', () => {
  const card = { selected: true, state: { _proxyView: true, _file: 'b.dng' } };
  const task = buildDevelopTask(card, {});
  assert.strictEqual(task.card, card);
});

// ---------------------------------------------------------------------------
// Cancellation + failure preservation — state must survive a cancelled develop
// ---------------------------------------------------------------------------

test('selectCardsForDevelop cards that had _taskId (in-flight) are excluded', () => {
  // If a card already has an active task ID, it is already being processed —
  // do not re-submit it (would be a duplicate).
  const cards = [
    { selected: true, state: { _proxyView: true, _file: 'a.orf', _taskId: 99 } },
    { selected: true, state: { _proxyView: true, _file: 'b.dng', _taskId: null } },
  ];
  const result = selectCardsForDevelop(cards);
  assert.equal(result.length, 1);
  assert.ok(result.includes(cards[1]));
});
