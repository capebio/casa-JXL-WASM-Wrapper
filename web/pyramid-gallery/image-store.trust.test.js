import { expect, test, describe, afterEach } from 'bun:test';
import { webcrypto } from 'node:crypto';
import { createImageStore } from './image-store.js';

// image-store is the gallery's acquisition layer. Task 8 routes its manifest + level
// fetches through the trusted boundary (fetchVerifiedAsset), so a hostile manifest or
// level response cannot escape the gallery origin/root, exceed the declared byte cap,
// or bypass SHA-256 verification. These tests exercise the store end-to-end with a
// mocked global fetch.

const GALLERY = 'https://cdn.example.test/gallery/';
const subtle = webcrypto.subtle;

async function sha256Hex(bytes) {
  const d = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function jxlStreamResponse(bytes, { url, headers = {}, status = 200, redirected = false } = {}) {
  const hm = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    redirected,
    headers: { get: (k) => hm.get(String(k).toLowerCase()) ?? null },
    body: {
      getReader() {
        return {
          async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; },
          cancel() {}, releaseLock() {},
        };
      },
    },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    async json() { throw new Error('not json'); },
  };
}

function jsonResponse(obj, { url, status = 200, redirected = false, bodyBytesOverride } = {}) {
  const text = JSON.stringify(obj);
  const bytes = bodyBytesOverride ?? new TextEncoder().encode(text);
  const hm = new Map([['content-length', String(bytes.length)]]);
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    redirected,
    headers: { get: (k) => hm.get(String(k).toLowerCase()) ?? null },
    body: {
      getReader() {
        return {
          async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; },
          cancel() {}, releaseLock() {},
        };
      },
    },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    async json() { return obj; },
  };
}

const memCache = () => {
  const m = new Map();
  return { async get(k) { return m.get(k) ?? null; }, set(k, v) { m.set(k, v); } };
};

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

function validV5Manifest() {
  return {
    schema: 5,
    imageId: 'deadbeefcafef00d',
    master: { name: 'P1000001.RW2', sourceFormat: 'rw2', format: 'rw2', mtimeMs: 1717900000000 },
    orientation: { exif: 6, pixels: 'baked-upright' },
    width: 5184, height: 3888, aspect: 5184 / 3888,
    levels: [
      { size: 512, w: 512, h: 384, bytes: 15000, bitsPerSample: 8, contenthash: 'abcdef', tiled: false },
      { size: 'full', w: 5184, h: 3888, bytes: 2400000, bitsPerSample: 8, contenthash: 'fedcba', tiled: false },
    ],
  };
}

// ── getLevelBytes: trusted boundary ──────────────────────────────────────────

describe('getLevelBytes trusted boundary', () => {
  test('fetches, byte-caps, sha-verifies, and caches a valid level', async () => {
    const bytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
    const sha = await sha256Hex(bytes);
    const cache = memCache();
    globalThis.fetch = async (url) => {
      expect(String(url)).toBe(`${GALLERY}levels/abcdef.jxl`);
      return jxlStreamResponse(bytes, { url: `${GALLERY}levels/abcdef.jxl` });
    };
    const store = createImageStore({ cache, galleryBase: GALLERY });
    const out = await store.getLevelBytes('abcdef', { expectedBytes: bytes.length, sha256: sha });
    expect(new Uint8Array(out)).toEqual(bytes);
    // cached under level:<hash>
    expect(await cache.get('level:abcdef')).not.toBeNull();
  });

  test('rejects a level whose SHA-256 does not match', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const cache = memCache();
    globalThis.fetch = async () => jxlStreamResponse(bytes, { url: `${GALLERY}levels/abcdef.jxl` });
    const store = createImageStore({ cache, galleryBase: GALLERY });
    await expect(
      store.getLevelBytes('abcdef', { expectedBytes: bytes.length, sha256: 'a'.repeat(64) }),
    ).rejects.toThrow();
    // nothing cached on rejection
    expect(await cache.get('level:abcdef')).toBeNull();
  });

  test('rejects a level body that overruns the declared byte cap', async () => {
    const oversized = new Uint8Array(500).fill(3);
    const cache = memCache();
    globalThis.fetch = async () => jxlStreamResponse(oversized, { url: `${GALLERY}levels/abcdef.jxl` });
    const store = createImageStore({ cache, galleryBase: GALLERY });
    await expect(store.getLevelBytes('abcdef', { expectedBytes: 8 })).rejects.toThrow();
    expect(await cache.get('level:abcdef')).toBeNull();
  });

  test('rejects a level that redirects cross-origin', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const cache = memCache();
    globalThis.fetch = async () => jxlStreamResponse(bytes, { url: 'https://evil.example/pwn.jxl', redirected: true });
    const store = createImageStore({ cache, galleryBase: GALLERY });
    await expect(store.getLevelBytes('abcdef', { expectedBytes: bytes.length })).rejects.toThrow();
  });

  test('rejects a contenthash that encodes path traversal', async () => {
    const cache = memCache();
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return jxlStreamResponse(new Uint8Array([0]), { url: `${GALLERY}x` }); };
    const store = createImageStore({ cache, galleryBase: GALLERY });
    await expect(store.getLevelBytes('..%2f..%2fsecret', { expectedBytes: 8 })).rejects.toThrow();
    expect(fetched).toBe(false);
  });
});

// ── getManifest: trusted boundary ────────────────────────────────────────────

describe('getManifest trusted boundary', () => {
  test('fetches and validates a same-origin manifest', async () => {
    const cache = memCache();
    globalThis.fetch = async (url) => {
      expect(String(url)).toBe(`${GALLERY}images/deadbeefcafef00d/manifest.json`);
      return jsonResponse(validV5Manifest(), { url: `${GALLERY}images/deadbeefcafef00d/manifest.json` });
    };
    const store = createImageStore({ cache, galleryBase: GALLERY });
    const m = await store.getManifest('deadbeefcafef00d');
    expect(m.schema).toBe(5);
  });

  test('rejects a manifest that redirects cross-origin', async () => {
    const cache = memCache();
    globalThis.fetch = async () =>
      jsonResponse(validV5Manifest(), { url: 'https://evil.example/manifest.json', redirected: true });
    const store = createImageStore({ cache, galleryBase: GALLERY });
    await expect(store.getManifest('deadbeefcafef00d')).rejects.toThrow();
  });

  test('rejects an over-large manifest body (byte cap DoS guard)', async () => {
    const cache = memCache();
    // A manifest.json far larger than any legitimate manifest.
    const huge = new Uint8Array(20 * 1024 * 1024).fill(0x20); // 20 MiB of spaces
    globalThis.fetch = async () =>
      jsonResponse({}, { url: `${GALLERY}images/x/manifest.json`, bodyBytesOverride: huge });
    const store = createImageStore({ cache, galleryBase: GALLERY });
    await expect(store.getManifest('x')).rejects.toThrow();
  });

  test('rejects an imageId that encodes path traversal', async () => {
    const cache = memCache();
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return jsonResponse({}, { url: `${GALLERY}x` }); };
    const store = createImageStore({ cache, galleryBase: GALLERY });
    await expect(store.getManifest('..%2f..%2fetc%2fpasswd')).rejects.toThrow();
    expect(fetched).toBe(false);
  });
});
