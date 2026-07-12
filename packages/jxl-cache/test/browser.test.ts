import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JxlCacheBrowser } from "../src/browser.js";

class NotFoundError extends Error {
  name = "NotFoundError";
}

class MemoryWritable {
  private chunks: Uint8Array[] = [];
  private closed = false;

  constructor(private readonly onClose: (data: Uint8Array) => void) {}

  async write(buffer: ArrayBuffer | Uint8Array): Promise<void> {
    const chunk = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.chunks.push(new Uint8Array(chunk));
  }

  async close(): Promise<void> {
    this.closed = true;
    const size = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.onClose(merged);
  }

  async abort(): Promise<void> {
    this.closed = true;
    this.chunks = [];
  }

  get wasClosed(): boolean {
    return this.closed;
  }
}

function makeStorage(estimateQuota: number | undefined) {
  const files = new Map<string, Uint8Array>();

  const root = {
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!files.has(name) && !opts?.create) {
        throw new NotFoundError();
      }

      return {
        async getFile() {
          const data = files.get(name);
          if (!data) throw new NotFoundError();
          return {
            size: data.byteLength,
            async arrayBuffer() {
              return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            },
            async text() {
              return new TextDecoder().decode(data);
            },
          };
        },
        async createWritable() {
          return new MemoryWritable((data) => files.set(name, data));
        },
      };
    },
    async removeEntry(name: string) {
      files.delete(name);
    },
    async *keys() {
      for (const name of files.keys()) yield name;
    },
  };

  return {
    files,
    root,
    storage: {
      async getDirectory() {
        return root;
      },
      async estimate() {
        return estimateQuota === undefined ? {} : { quota: estimateQuota };
      },
    },
  };
}

describe("JxlCacheBrowser SharedArrayBuffer memory cache", () => {
  it("get() returns a SharedArrayBuffer with correct data", async () => {
    const cache = new JxlCacheBrowser({ memoryLimit: 1024 * 1024, persistentLimit: 0 });
    await cache.init();

    const data = new Uint8Array([10, 20, 30, 40]);
    await cache.set("buf", data.buffer);

    const result = await cache.get("buf");
    assert.ok(result instanceof SharedArrayBuffer, "should return SharedArrayBuffer");
    assert.deepEqual(Array.from(new Uint8Array(result)), [10, 20, 30, 40]);
  });

  it("repeated gets return the same SAB instance (zero-copy)", async () => {
    const cache = new JxlCacheBrowser({ memoryLimit: 1024 * 1024, persistentLimit: 0 });
    await cache.init();

    await cache.set("tile", new Uint8Array([1, 2, 3]).buffer);

    const a = await cache.get("tile");
    const b = await cache.get("tile");
    assert.ok(a !== undefined && b !== undefined);
    assert.strictEqual(a, b, "same SAB reference on both gets");
  });
});

describe("JxlCacheBrowser does not force SharedArrayBuffer (finding 33)", () => {
  it("set/get work when SharedArrayBuffer is unavailable (no forced SAB, no crash)", async () => {
    const saved = (globalThis as any).SharedArrayBuffer;
    // Simulate a non-cross-origin-isolated environment: no SharedArrayBuffer.
    delete (globalThis as any).SharedArrayBuffer;
    try {
      const cache = new JxlCacheBrowser({ memoryLimit: 1024 * 1024, persistentLimit: 0 });
      await cache.init();

      const data = new Uint8Array([5, 6, 7, 8]);
      await cache.set("no-sab", data.buffer);

      const result = await cache.get("no-sab");
      assert.ok(result !== undefined, "get returns a buffer without SAB");
      assert.ok(!(saved && result instanceof saved), "must NOT be a SharedArrayBuffer when SAB unavailable");
      assert.deepEqual(Array.from(new Uint8Array(result as ArrayBuffer)), [5, 6, 7, 8]);
    } finally {
      (globalThis as any).SharedArrayBuffer = saved;
    }
  });

  it("get returns the same buffer reference on repeated reads without SAB (no per-get copy)", async () => {
    const saved = (globalThis as any).SharedArrayBuffer;
    delete (globalThis as any).SharedArrayBuffer;
    try {
      const cache = new JxlCacheBrowser({ memoryLimit: 1024 * 1024, persistentLimit: 0 });
      await cache.init();
      await cache.set("k", new Uint8Array([1, 2, 3]).buffer);
      const a = await cache.get("k");
      const b = await cache.get("k");
      assert.strictEqual(a, b, "same buffer reference on both gets (no extra copy)");
    } finally {
      (globalThis as any).SharedArrayBuffer = saved;
    }
  });
});

describe("JxlCacheBrowser quota sizing", () => {
  beforeEach(() => {
    delete (globalThis as { navigator?: Navigator }).navigator;
  });

  it("does not write files larger than effective quota-clamped limit", async () => {
    const { files, storage } = makeStorage(100);
    const locks = { async request(_name: string, cb: () => Promise<void>) { await cb(); } };
    (globalThis as { navigator?: Navigator }).navigator = { storage, locks } as Navigator;

    const cache = new JxlCacheBrowser({
      memoryLimit: 1024,
      persistent: true,
      persistentLimit: 80,
    });

    await cache.init();
    await cache.set("too-big-for-safe-limit", new Uint8Array(60).buffer);

    assert.equal(cache.stats().persistent.limit, 50);
    assert.equal(cache.stats().persistent.count, 0);
    assert.deepEqual([...files.keys()], []);
  });
});

describe("JxlCacheBrowser manifest lock", () => {
  beforeEach(() => {
    delete (globalThis as { navigator?: Navigator }).navigator;
  });

  it("routes manifest writes through navigator.locks when available", async () => {
    const { files, storage } = makeStorage(undefined);
    const calls: string[] = [];
    const locks = {
      async request(name: string, cb: () => Promise<void>) {
        calls.push(name);
        await cb();
      },
    };
    (globalThis as { navigator?: Navigator }).navigator = { storage, locks } as Navigator;

    const cache = new JxlCacheBrowser({
      memoryLimit: 1024,
      persistent: true,
      persistentLimit: 1024,
    });

    await cache.init();
    await cache.set("manifest-key", new Uint8Array([1, 2, 3]).buffer);
    await (cache as any).writeManifest();

    assert.deepEqual(calls, ["jxl-cache-manifest"]);
    assert.ok(files.has("__jxl_cache_manifest.json"));
  });
});
