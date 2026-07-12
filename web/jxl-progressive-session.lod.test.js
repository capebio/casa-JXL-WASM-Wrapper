import { expect, test } from 'bun:test';
import { createProgressiveSession } from './jxl-progressive-session.js';

// Task 6 (finding 2): the progressive session carries an OPTIONAL resolved-LOD demand so the
// progressive-prefix path can reuse this session (its cached source + backend switching) rather
// than recreating a session. The addition is additive: source loading control flow is unchanged.

test('carries an optional lodRequest and exposes it via getter/setter without touching source flow', async () => {
    let loads = 0;
    const session = createProgressiveSession({
        initialBackend: 'libjxl',
        lodRequest: { targetLongEdge: 1280, dpr: 2 },
        loadSource: async () => { loads += 1; return { name: 's.orf', bytes: new Uint8Array([1, 2, 3]) }; },
    });

    // The resolved demand is available to consumers driving the fetch.
    expect(session.lodRequest).toEqual({ targetLongEdge: 1280, dpr: 2 });

    // Source loading is unchanged: ensureSource still loads exactly once and caches.
    const a = await session.ensureSource();
    const b = await session.ensureSource();
    expect(loads).toBe(1);
    expect(a.bytes).toBe(b.bytes);

    // A consumer can update the demand (e.g. zoom changed) without reloading the source.
    session.setLodRequest({ targetLongEdge: 4000, dpr: 1 });
    expect(session.lodRequest).toEqual({ targetLongEdge: 4000, dpr: 1 });
    expect(loads).toBe(1);
});

test('lodRequest defaults to null and does not affect the existing session contract', async () => {
    const session = createProgressiveSession({
        initialBackend: 'jsquash',
        loadSource: async () => ({ name: 's.orf', bytes: new Uint8Array([9]) }),
    });
    expect(session.lodRequest).toBeNull();
    expect(session.backend).toBe('jsquash');
    const src = await session.ensureSource();
    expect(Array.from(src.bytes)).toEqual([9]);
});
