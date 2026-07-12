import { expect, test } from 'bun:test';
import { createSharedDecode } from './decode-lease.js';

// Small helpers -------------------------------------------------------------

// A controllable "underlying decode": resolves when we tell it to, rejects when
// its shared signal aborts, and records whether it was aborted.
function makeDecode() {
  let resolveFn;
  let rejectFn;
  const state = { started: false, aborted: false };
  const start = (sharedSignal) => {
    state.started = true;
    const onAbort = () => {
      state.aborted = true;
      rejectFn?.(new DOMException('aborted', 'AbortError'));
    };
    if (sharedSignal.aborted) onAbort();
    else sharedSignal.addEventListener('abort', onAbort, { once: true });
    const p = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
    // Underlying rejection is always handled so an aborted decode a test does not
    // explicitly await never surfaces as an unhandled rejection (which would keep
    // the runner alive).
    p.catch(() => {});
    return p;
  };
  return {
    start,
    state,
    finish: (v) => resolveFn?.(v),
  };
}

// Await one macrotask so abort events / microtasks settle.
const tick = () => new Promise((r) => setTimeout(r, 0));

// -------------------------------------------------------------------------
// Ownership: one lease per consumer, refcount, cancel only at zero.
// -------------------------------------------------------------------------

test('a single consumer that never aborts keeps the decode alive and resolves', async () => {
  const d = makeDecode();
  const shared = createSharedDecode(d.start);
  const lease = shared.acquire();
  expect(d.state.started).toBe(true);
  d.finish('pixels');
  await expect(lease.promise).resolves.toBe('pixels');
  expect(d.state.aborted).toBe(false);
});

test('a no-signal FIRST caller is NOT invisible: an aborting joiner cannot cancel it', async () => {
  const d = makeDecode();
  const shared = createSharedDecode(d.start);

  // First consumer has NO AbortSignal — it still owns a lease.
  const noSignalLease = shared.acquire();

  // Second consumer joins with an AbortSignal and then aborts.
  const ac = new AbortController();
  shared.acquire(ac.signal);
  ac.abort();
  await tick();

  // The underlying decode must still be alive because the no-signal caller
  // still holds its lease.
  expect(d.state.aborted).toBe(false);
  expect(shared.leaseCount).toBe(1);

  d.finish('pixels');
  await expect(noSignalLease.promise).resolves.toBe('pixels');
});

test('the underlying decode cancels only when the LAST lease is released', async () => {
  const d = makeDecode();
  const shared = createSharedDecode(d.start);

  const a = shared.acquire();
  const b = shared.acquire();
  const c = shared.acquire();

  a.release();
  expect(d.state.aborted).toBe(false);
  b.release();
  expect(d.state.aborted).toBe(false);
  c.release(); // last one out
  expect(d.state.aborted).toBe(true);
});

test('an aborting joiner only releases its OWN lease (refcount--), not everyone', async () => {
  const d = makeDecode();
  const shared = createSharedDecode(d.start);

  const keep = shared.acquire();          // no signal, stays
  const ac = new AbortController();
  shared.acquire(ac.signal);

  ac.abort();                              // fires the lease's abort -> release
  await tick();
  expect(d.state.aborted).toBe(false);     // keep is still holding
  expect(shared.leaseCount).toBe(1);

  keep.release();
  expect(d.state.aborted).toBe(true);      // now everyone gone
});

test('an already-aborted signal still takes and immediately releases a lease (no early global cancel while others hold)', async () => {
  const d = makeDecode();
  const shared = createSharedDecode(d.start);

  const keep = shared.acquire(); // holds

  const ac = new AbortController();
  ac.abort(); // pre-aborted
  shared.acquire(ac.signal);

  // The pre-aborted consumer must not have cancelled the shared decode: keep holds.
  expect(d.state.aborted).toBe(false);
  expect(shared.leaseCount).toBe(1);

  keep.release();
  expect(d.state.aborted).toBe(true);
});

test('all callers aborting cancels the underlying decode exactly once', async () => {
  const d = makeDecode();
  const shared = createSharedDecode(d.start);

  const a1 = new AbortController();
  const a2 = new AbortController();
  shared.acquire(a1.signal);
  shared.acquire(a2.signal);

  a1.abort();
  await tick();
  expect(d.state.aborted).toBe(false); // a2 still wants it
  a2.abort();
  await tick();
  expect(d.state.aborted).toBe(true);  // now all gone
  expect(shared.leaseCount).toBe(0);
});

// -------------------------------------------------------------------------
// Double release must be harmless AND observable.
// -------------------------------------------------------------------------

test('double release of the same lease is harmless and does not over-decrement', async () => {
  const d = makeDecode();
  const shared = createSharedDecode(d.start);

  const a = shared.acquire();
  const b = shared.acquire();

  const firstResult = a.release();
  const secondResult = a.release(); // double release

  // First release is observable as "did something"; the second as a no-op.
  expect(firstResult).toBe(true);
  expect(secondResult).toBe(false);

  // b is still holding, so the decode must be alive despite a's double-release.
  expect(d.state.aborted).toBe(false);
  expect(shared.leaseCount).toBe(1);

  b.release();
  expect(d.state.aborted).toBe(true);
});

test('releasing via abort THEN calling release() again is a harmless no-op', async () => {
  const d = makeDecode();
  const shared = createSharedDecode(d.start);

  const keep = shared.acquire();
  const ac = new AbortController();
  const lease = shared.acquire(ac.signal);

  ac.abort();               // auto-releases the lease
  await tick();
  const again = lease.release(); // explicit double-release
  expect(again).toBe(false);

  expect(d.state.aborted).toBe(false); // keep still holds
  keep.release();
  expect(d.state.aborted).toBe(true);
});

test('every lease shares the SAME underlying promise result', async () => {
  const d = makeDecode();
  const shared = createSharedDecode(d.start);
  const a = shared.acquire();
  const b = shared.acquire();
  d.finish({ pixels: 1 });
  const [ra, rb] = await Promise.all([a.promise, b.promise]);
  expect(ra).toBe(rb); // identical object -> shared decode, not re-run
});

test('start() runs exactly once no matter how many leases are acquired', () => {
  let starts = 0;
  let resolveFn;
  const shared = createSharedDecode(() => {
    starts += 1;
    return new Promise((r) => { resolveFn = r; });
  });
  const a = shared.acquire();
  const b = shared.acquire();
  shared.acquire();
  expect(starts).toBe(1);
  // Conclude so the runner's loop drains.
  resolveFn('done');
  return Promise.all([a.promise, b.promise]);
});
