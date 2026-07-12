import { expect, test, describe, afterEach } from 'bun:test';
import { webcrypto } from 'node:crypto';
import { createImageStore } from './image-store.js';

// Task 6: the image-store gains a range-aware level fetch so the gallery can deliver a resolved
// LOD (progressive-prefix / jxtc tile ranges) by HTTP Range through the SAME trusted boundary as
// whole-level fetches. These tests drive it with a mocked global fetch that honors Range.

const GALLERY = 'https://cdn.example.test/gallery/';
const subtle = webcrypto.subtle;

const FULL = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));

function rangeResponse({ url = `${GALLERY}levels/abc.jxl` } = {}) {
  const impl = async (input, init) => {
    const headers = new Headers(init?.headers || {});
    const range = headers.get('Range');
    let status = 200, body = FULL, hm = new Map();
    if (range) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(range);
      const s = Number(m[1]), e = Number(m[2]);
      body = FULL.slice(s, e + 1);
      status = 206;
      hm.set('content-range', `bytes ${s}-${e}/${FULL.length}`);
    }
    hm.set('content-length', String(body.length));
    let sent = false;
    return {
      ok: status >= 200 && status < 300, status, url, redirected: false,
      headers: { get: (k) => hm.get(String(k).toLowerCase()) ?? null },
      body: { getReader() { return { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: body }; }, cancel() {}, releaseLock() {} }; } },
      async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength); },
    };
  };
  impl.calls = [];
  const wrapped = async (i, init) => { wrapped.calls.push({ range: new Headers(init?.headers || {}).get('Range') }); return impl(i, init); };
  wrapped.calls = [];
  return wrapped;
}

const memCache = () => {
  const m = new Map();
  return { async get(k) { return m.get(k) ?? null; }, set(k, v) { m.set(k, v); } };
};

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

describe('imageStore.getLevelRange', () => {
  test('fetches a single prefix window by Range and returns exactly those bytes', async () => {
    const fetchImpl = rangeResponse();
    globalThis.fetch = fetchImpl;
    const store = createImageStore({ cache: memCache(), galleryBase: GALLERY, subtle });
    const out = await store.getLevelRange('abc', { start: 0, end: 40 });
    expect(fetchImpl.calls[0].range).toBe('bytes=0-39');
    expect(new Uint8Array(out)).toEqual(FULL.slice(0, 40));
  });
});

describe('imageStore.getTileRanges', () => {
  test('fetches one Range per tile and returns aligned buffers', async () => {
    const fetchImpl = rangeResponse();
    globalThis.fetch = fetchImpl;
    const store = createImageStore({ cache: memCache(), galleryBase: GALLERY, subtle });
    const parts = await store.getTileRanges('abc', [{ start: 10, end: 20 }, { start: 50, end: 60 }]);
    expect(fetchImpl.calls.map((c) => c.range)).toEqual(['bytes=10-19', 'bytes=50-59']);
    expect(new Uint8Array(parts[0])).toEqual(FULL.slice(10, 20));
    expect(new Uint8Array(parts[1])).toEqual(FULL.slice(50, 60));
  });
});
