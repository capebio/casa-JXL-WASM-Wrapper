import { expect, test, describe } from 'bun:test';
import { webcrypto } from 'node:crypto';
import { fetchLevelRange, fetchTileRanges } from './range-fetch.js';

// Mocked-HTTP proof for Task 6 range delivery. Drives the range-aware trusted fetch with an
// injected fetch impl so we can assert the EXACT Range headers sent, the EXACT bytes delivered,
// graceful fallback when the server ignores Range (200), cancellation, and multi-tile ranges.
//
// The subtle crypto is injected so this runs under bun/node (webcrypto) and the browser.

const ROOT = 'https://cdn.example.test/gallery/';
const subtle = webcrypto.subtle;

/** A Response-like object for a Range request. When `honorRange` and a Range header is present,
 *  reply 206 with Content-Range and only the requested slice of `full`; else 200 with all of `full`. */
function rangeAwareFetch(full, { honorRange = true, url = `${ROOT}levels/abc.jxl` } = {}) {
  const calls = [];
  const impl = async (input, init) => {
    const headers = new Headers(init?.headers || {});
    const rangeHeader = headers.get('Range');
    calls.push({ url: String(input), range: rangeHeader, signal: init?.signal });
    if (init?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    let status = 200;
    let bodyBytes = full;
    const respHeaders = new Map();
    if (rangeHeader && honorRange) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
      const start = Number(m[1]);
      const endIncl = Number(m[2]);
      bodyBytes = full.slice(start, endIncl + 1);
      status = 206;
      respHeaders.set('content-range', `bytes ${start}-${endIncl}/${full.length}`);
      respHeaders.set('content-length', String(bodyBytes.length));
    } else {
      respHeaders.set('content-length', String(full.length));
    }
    let i = 0;
    const chunks = [bodyBytes];
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      redirected: false,
      headers: { get: (k) => respHeaders.get(String(k).toLowerCase()) ?? null },
      body: {
        getReader() {
          return {
            async read() {
              if (i >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: chunks[i++] };
            },
            cancel() {},
            releaseLock() {},
          };
        },
      },
      async arrayBuffer() { return bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength); },
    };
  };
  impl.calls = calls;
  return impl;
}

const FULL = new Uint8Array(Array.from({ length: 64 }, (_, i) => i));

describe('fetchLevelRange — progressive-prefix delivery', () => {
  test('sends Range: bytes=0-(byteEnd-1) and returns exactly those bytes', async () => {
    const fetchImpl = rangeAwareFetch(FULL);
    const out = await fetchLevelRange({
      root: ROOT, relativePath: 'levels/abc.jxl',
      range: { start: 0, endExclusive: 20 },
      fetchImpl, subtle,
    });
    expect(fetchImpl.calls[0].range).toBe('bytes=0-19');
    expect(new Uint8Array(out)).toEqual(FULL.slice(0, 20));
  });

  test('a mid-file range delivers exactly the requested slice', async () => {
    const fetchImpl = rangeAwareFetch(FULL);
    const out = await fetchLevelRange({
      root: ROOT, relativePath: 'levels/abc.jxl',
      range: { start: 16, endExclusive: 48 },
      fetchImpl, subtle,
    });
    expect(fetchImpl.calls[0].range).toBe('bytes=16-47');
    expect(new Uint8Array(out)).toEqual(FULL.slice(16, 48));
  });

  test('server that ignores Range (200) falls back to slicing the requested window from the full body', async () => {
    const fetchImpl = rangeAwareFetch(FULL, { honorRange: false });
    const out = await fetchLevelRange({
      root: ROOT, relativePath: 'levels/abc.jxl',
      range: { start: 0, endExclusive: 20 },
      fetchImpl, subtle,
    });
    // Still exactly the requested prefix bytes, even though the server sent everything.
    expect(new Uint8Array(out)).toEqual(FULL.slice(0, 20));
  });

  test('propagates cancellation via AbortSignal', async () => {
    const fetchImpl = rangeAwareFetch(FULL);
    const ac = new AbortController();
    ac.abort();
    await expect(fetchLevelRange({
      root: ROOT, relativePath: 'levels/abc.jxl',
      range: { start: 0, endExclusive: 20 },
      fetchImpl, subtle, signal: ac.signal,
    })).rejects.toThrow(/abort/i);
  });

  test('rejects a cross-origin / traversal path (trusted boundary preserved)', async () => {
    const fetchImpl = rangeAwareFetch(FULL);
    await expect(fetchLevelRange({
      root: ROOT, relativePath: '../secrets/key.jxl',
      range: { start: 0, endExclusive: 8 },
      fetchImpl, subtle,
    })).rejects.toThrow();
  });
});

describe('fetchTileRanges — jxtc multi-tile delivery', () => {
  test('issues one Range request per tile and concatenates the delivered tile bytes', async () => {
    const fetchImpl = rangeAwareFetch(FULL);
    const ranges = [
      { start: 4, end: 12 },   // 8 bytes
      { start: 20, end: 28 },  // 8 bytes
      { start: 40, end: 44 },  // 4 bytes
    ];
    const parts = await fetchTileRanges({
      root: ROOT, relativePath: 'levels/tiled.jxl', ranges, fetchImpl, subtle,
    });
    expect(fetchImpl.calls.map((c) => c.range)).toEqual(['bytes=4-11', 'bytes=20-27', 'bytes=40-43']);
    expect(parts.length).toBe(3);
    expect(new Uint8Array(parts[0])).toEqual(FULL.slice(4, 12));
    expect(new Uint8Array(parts[1])).toEqual(FULL.slice(20, 28));
    expect(new Uint8Array(parts[2])).toEqual(FULL.slice(40, 44));
  });

  test('aborts remaining tile fetches on cancellation', async () => {
    const fetchImpl = rangeAwareFetch(FULL);
    const ac = new AbortController();
    ac.abort();
    await expect(fetchTileRanges({
      root: ROOT, relativePath: 'levels/tiled.jxl',
      ranges: [{ start: 4, end: 12 }], fetchImpl, subtle, signal: ac.signal,
    })).rejects.toThrow(/abort/i);
  });
});
