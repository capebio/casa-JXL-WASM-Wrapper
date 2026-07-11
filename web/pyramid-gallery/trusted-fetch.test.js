import { expect, test, describe } from 'bun:test';
import { webcrypto } from 'node:crypto';
import { fetchVerifiedAsset, TrustedFetchError } from './trusted-fetch.js';

// ── Test scaffolding ─────────────────────────────────────────────────────────
//
// fetchVerifiedAsset is the single trusted boundary for gallery asset bytes. These
// tests drive it with a hostile fetch impl (injected via `fetchImpl`) so we can
// exercise every escape vector without a live server: cross-origin/absolute URLs,
// encoded path traversal, redirect escape, oversized Content-Length, streamed
// overrun, truncation, and SHA-256 digest mismatch. The subtle crypto is injected
// so the same file runs under bun/node (webcrypto) and the browser (crypto.subtle).

const ROOT = 'https://cdn.example.test/gallery/';
const subtle = webcrypto.subtle;

/** Compute the hex SHA-256 of bytes (Uint8Array) for building valid expectations. */
async function sha256Hex(bytes) {
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A Response-like object whose body streams `chunks` (each a Uint8Array). */
function streamingResponse(chunks, { url = ROOT, status = 200, headers = {}, redirected = false } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  let i = 0;
  const body = {
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
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    redirected,
    headers: { get: (k) => headerMap.get(String(k).toLowerCase()) ?? null },
    body,
    async arrayBuffer() {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out.buffer;
    },
  };
}

/** Build a fetchImpl that returns one canned response and records the request URL. */
function fetchReturning(response) {
  const calls = [];
  const impl = async (input, init) => {
    calls.push({ url: String(input), init });
    return response;
  };
  impl.calls = calls;
  return impl;
}

/** A valid 12-byte payload + its correct sha, wrapped for reuse. */
async function goodPayload() {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  return { bytes, sha256: await sha256Hex(bytes) };
}

// ── Happy path ───────────────────────────────────────────────────────────────

describe('fetchVerifiedAsset happy path', () => {
  test('resolves a same-origin, root-contained asset and returns its bytes', async () => {
    const { bytes, sha256 } = await goodPayload();
    const fetchImpl = fetchReturning(
      streamingResponse([bytes], { url: `${ROOT}levels/abc.jxl`, headers: { 'content-length': bytes.length } }),
    );
    const buf = await fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes: bytes.length, sha256, fetchImpl, subtle,
    });
    expect(new Uint8Array(buf)).toEqual(bytes);
    expect(fetchImpl.calls[0].url).toBe(`${ROOT}levels/abc.jxl`);
  });

  test('accepts a payload split across multiple stream chunks', async () => {
    const { bytes, sha256 } = await goodPayload();
    const chunks = [bytes.slice(0, 5), bytes.slice(5, 9), bytes.slice(9)];
    const fetchImpl = fetchReturning(streamingResponse(chunks, { url: `${ROOT}levels/abc.jxl` }));
    const buf = await fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes: bytes.length, sha256, fetchImpl, subtle,
    });
    expect(new Uint8Array(buf)).toEqual(bytes);
  });

  test('verification is not required when no sha256 is supplied (byte cap still enforced)', async () => {
    const { bytes } = await goodPayload();
    const fetchImpl = fetchReturning(streamingResponse([bytes], { url: `${ROOT}levels/abc.jxl` }));
    const buf = await fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes: bytes.length, fetchImpl, subtle,
    });
    expect(new Uint8Array(buf)).toEqual(bytes);
  });
});

// ── Path resolution / origin / containment ───────────────────────────────────

describe('path resolution rejects escapes', () => {
  const shouldNeverFetch = fetchReturning(streamingResponse([new Uint8Array([0])]));

  test('rejects an absolute cross-origin URL as relativePath', async () => {
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: 'https://evil.example/steal.jxl', expectedBytes: 10, fetchImpl: shouldNeverFetch, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });

  test('rejects a protocol-relative cross-origin URL', async () => {
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: '//evil.example/steal.jxl', expectedBytes: 10, fetchImpl: shouldNeverFetch, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });

  test('rejects raw ../ path traversal that escapes the gallery root', async () => {
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: '../../etc/secrets.jxl', expectedBytes: 10, fetchImpl: shouldNeverFetch, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });

  test('rejects percent-encoded traversal ..%2F', async () => {
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: '..%2F..%2Fetc%2Fsecrets.jxl', expectedBytes: 10, fetchImpl: shouldNeverFetch, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });

  test('rejects percent-encoded traversal %2e%2e/', async () => {
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: '%2e%2e/%2e%2e/etc/secrets.jxl', expectedBytes: 10, fetchImpl: shouldNeverFetch, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });

  test('rejects a root-absolute path that escapes the gallery subtree', async () => {
    // Resolves to https://cdn.example.test/etc/secrets.jxl — same origin, but OUTSIDE /gallery/.
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: '/etc/secrets.jxl', expectedBytes: 10, fetchImpl: shouldNeverFetch, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });

  test('never calls fetch when the path is rejected', async () => {
    const fetchImpl = fetchReturning(streamingResponse([new Uint8Array([0])]));
    await fetchVerifiedAsset({
      root: ROOT, relativePath: '../escape.jxl', expectedBytes: 10, fetchImpl, subtle,
    }).catch(() => {});
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

// ── Redirect escape (final URL differs from requested) ───────────────────────

describe('redirect escape', () => {
  test('rejects when the response redirected to a cross-origin URL', async () => {
    const { bytes, sha256 } = await goodPayload();
    const fetchImpl = fetchReturning(streamingResponse([bytes], {
      url: 'https://evil.example/pwn.jxl', redirected: true,
    }));
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes: bytes.length, sha256, fetchImpl, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });

  test('rejects when redirected out of the root subtree (same origin)', async () => {
    const { bytes, sha256 } = await goodPayload();
    const fetchImpl = fetchReturning(streamingResponse([bytes], {
      url: `https://cdn.example.test/other/pwn.jxl`, redirected: true,
    }));
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes: bytes.length, sha256, fetchImpl, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });

  test('passes redirect:error to the underlying fetch', async () => {
    const { bytes, sha256 } = await goodPayload();
    const fetchImpl = fetchReturning(streamingResponse([bytes], { url: `${ROOT}levels/abc.jxl` }));
    await fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes: bytes.length, sha256, fetchImpl, subtle,
    });
    expect(fetchImpl.calls[0].init?.redirect).toBe('error');
  });
});

// ── Byte cap (Content-Length + streamed overrun) ─────────────────────────────

describe('byte cap enforcement', () => {
  test('rejects an oversized Content-Length before streaming the body', async () => {
    const { bytes } = await goodPayload();
    let readerOpened = false;
    const resp = streamingResponse([bytes], {
      url: `${ROOT}levels/abc.jxl`, headers: { 'content-length': String(bytes.length * 100) },
    });
    const origGetReader = resp.body.getReader;
    resp.body.getReader = (...a) => { readerOpened = true; return origGetReader.apply(resp.body, a); };
    const fetchImpl = fetchReturning(resp);
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes: bytes.length, fetchImpl, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
    expect(readerOpened).toBe(false);
  });

  test('aborts a body that overruns the declared cap during streaming', async () => {
    // Content-Length lies (or is absent); the actual stream is far larger than expectedBytes.
    const expectedBytes = 12;
    const oversized = new Uint8Array(1000).fill(7);
    const fetchImpl = fetchReturning(streamingResponse([oversized], { url: `${ROOT}levels/abc.jxl` }));
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes, fetchImpl, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });

  test('aborts mid-stream as soon as accumulated bytes exceed the cap (does not read the whole body)', async () => {
    const expectedBytes = 12;
    const chunks = [new Uint8Array(8).fill(1), new Uint8Array(8).fill(2), new Uint8Array(8).fill(3)];
    let chunksRead = 0;
    const resp = streamingResponse(chunks, { url: `${ROOT}levels/abc.jxl` });
    const realReader = resp.body.getReader();
    resp.body.getReader = () => ({
      async read() { const r = await realReader.read(); if (!r.done) chunksRead++; return r; },
      cancel() {}, releaseLock() {},
    });
    const fetchImpl = fetchReturning(resp);
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes, fetchImpl, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
    // Cap (12) is exceeded after the 2nd chunk (16 bytes); the 3rd must never be read.
    expect(chunksRead).toBeLessThan(3);
  });
});

// ── SHA-256 verification / truncation ────────────────────────────────────────

describe('sha-256 verification', () => {
  test('rejects a body whose SHA-256 does not match the expected digest', async () => {
    const { bytes } = await goodPayload();
    const wrongSha = 'f'.repeat(64);
    const fetchImpl = fetchReturning(streamingResponse([bytes], { url: `${ROOT}levels/abc.jxl` }));
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes: bytes.length, sha256: wrongSha, fetchImpl, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });

  test('rejects a truncated body (fewer bytes than declared) even if sha is omitted', async () => {
    const expectedBytes = 12;
    const truncated = new Uint8Array([1, 2, 3, 4]); // only 4 of 12
    const fetchImpl = fetchReturning(streamingResponse([truncated], { url: `${ROOT}levels/abc.jxl` }));
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes, fetchImpl, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });

  test('rejects a truncated body when a sha is supplied (byte count short of expected)', async () => {
    const { bytes, sha256 } = await goodPayload();
    const truncated = bytes.slice(0, 6);
    const fetchImpl = fetchReturning(streamingResponse([truncated], { url: `${ROOT}levels/abc.jxl` }));
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes: bytes.length, sha256, fetchImpl, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });

  test('accepts a case-insensitive sha256 match', async () => {
    const { bytes, sha256 } = await goodPayload();
    const fetchImpl = fetchReturning(streamingResponse([bytes], { url: `${ROOT}levels/abc.jxl` }));
    const buf = await fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes: bytes.length, sha256: sha256.toUpperCase(), fetchImpl, subtle,
    });
    expect(new Uint8Array(buf)).toEqual(bytes);
  });
});

// ── HTTP failures ────────────────────────────────────────────────────────────

describe('http failures', () => {
  test('rejects a non-ok status', async () => {
    const fetchImpl = fetchReturning(streamingResponse([new Uint8Array(0)], { url: `${ROOT}levels/abc.jxl`, status: 404 }));
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes: 10, fetchImpl, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });
});

// ── Bounds on the arguments themselves ───────────────────────────────────────

describe('argument bounds', () => {
  test('rejects a NaN expectedBytes', async () => {
    const fetchImpl = fetchReturning(streamingResponse([new Uint8Array(0)]));
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes: NaN, fetchImpl, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });

  test('rejects an Infinity expectedBytes', async () => {
    const fetchImpl = fetchReturning(streamingResponse([new Uint8Array(0)]));
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes: Infinity, fetchImpl, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });

  test('rejects a non-positive expectedBytes', async () => {
    const fetchImpl = fetchReturning(streamingResponse([new Uint8Array(0)]));
    await expect(fetchVerifiedAsset({
      root: ROOT, relativePath: 'levels/abc.jxl', expectedBytes: 0, fetchImpl, subtle,
    })).rejects.toBeInstanceOf(TrustedFetchError);
  });
});
