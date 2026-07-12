import { expect, test } from 'bun:test';
import { createInflightDecodes } from './decode-lease.js';

// A controllable underlying decode keyed for inspection.
function makeDecode() {
  let resolveFn;
  let rejectFn;
  const state = { started: 0, aborted: false };
  const start = (sharedSignal) => {
    state.started += 1;
    const onAbort = () => {
      state.aborted = true;
      rejectFn?.(new DOMException('aborted', 'AbortError'));
    };
    if (sharedSignal.aborted) onAbort();
    else sharedSignal.addEventListener('abort', onAbort, { once: true });
    const p = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
    p.catch(() => {});
    return p;
  };
  return { start, state, finish: (v) => resolveFn?.(v) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('two callers for the same key share ONE underlying decode (dedupe)', async () => {
  const reg = createInflightDecodes();
  const d = makeDecode();
  const l1 = reg.decode('k', d.start);
  const l2 = reg.decode('k', d.start);
  expect(d.state.started).toBe(1); // started once, not twice
  d.finish('px');
  const [a, b] = await Promise.all([l1.promise, l2.promise]);
  expect(a).toBe('px');
  expect(b).toBe('px');
});

test('different keys start independent decodes', () => {
  const reg = createInflightDecodes();
  const d1 = makeDecode();
  const d2 = makeDecode();
  reg.decode('a', d1.start);
  reg.decode('b', d2.start);
  expect(d1.state.started).toBe(1);
  expect(d2.state.started).toBe(1);
});

test('a no-signal caller keeps the shared decode alive when a joiner aborts', async () => {
  const reg = createInflightDecodes();
  const d = makeDecode();
  const keep = reg.decode('k', d.start); // no signal
  const ac = new AbortController();
  reg.decode('k', d.start, ac.signal);   // joiner
  ac.abort();
  await tick();
  expect(d.state.aborted).toBe(false);   // keep still holds
  d.finish('px');
  await expect(keep.promise).resolves.toBe('px');
});

test('the shared decode cancels only after ALL callers for the key release', async () => {
  const reg = createInflightDecodes();
  const d = makeDecode();
  const a1 = new AbortController();
  const a2 = new AbortController();
  reg.decode('k', d.start, a1.signal);
  reg.decode('k', d.start, a2.signal);
  a1.abort();
  await tick();
  expect(d.state.aborted).toBe(false);
  a2.abort();
  await tick();
  expect(d.state.aborted).toBe(true);
});

test('after a decode settles the registry frees the key so a later call restarts fresh', async () => {
  const reg = createInflightDecodes();
  const d1 = makeDecode();
  const first = reg.decode('k', d1.start);
  d1.finish('one');
  await first.promise;
  await tick();

  // Same key again: the settled entry must have been evicted -> a fresh decode.
  const d2 = makeDecode();
  const second = reg.decode('k', d2.start);
  expect(d2.state.started).toBe(1);
  d2.finish('two');
  await expect(second.promise).resolves.toBe('two');
});

test('an explicit release() (no signal) contributes to the refcount too', async () => {
  const reg = createInflightDecodes();
  const d = makeDecode();
  const a = reg.decode('k', d.start); // no signal
  const b = reg.decode('k', d.start); // no signal
  a.release();
  expect(d.state.aborted).toBe(false); // b holds
  b.release();
  expect(d.state.aborted).toBe(true);  // now cancelled
});
