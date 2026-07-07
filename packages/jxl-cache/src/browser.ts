import { LRUCache } from './lru.js';

export interface CacheOptions {
  memoryLimit: number;     // e.g. 128 * 1024 * 1024 (128 MiB)
  persistentLimit: number; // e.g. 1024 * 1024 * 1024 (1 GiB)
  persistent?: boolean;
  basePath?: string;       // for Node.js
}

export interface JxlCache {
  init(): Promise<void>;
  get(key: string): Promise<ArrayBuffer | SharedArrayBuffer | undefined>;
  set(key: string, buffer: ArrayBuffer): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  clear(): Promise<void>;
  stats(): any;
}

interface PersistentEntry {
  name: string;
}

type WritableFileHandle = FileSystemFileHandle & {
  createWritable(): Promise<FileSystemWritableFileStream>;
};

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  keys(): AsyncIterable<string>;
};

const MANIFEST_NAME = '__jxl_cache_manifest.json';

const MAX_NAME = 200;
const NS_RAW = 'raw-';   // short keys (encodeURIComponent passthrough)
const NS_HASH = 'hash-'; // long keys (64-bit hash)

export function safeCacheName(key: string): string {
  return encodeURIComponent(key).replace(/[!'()*]/g, c =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Synchronous cache filename. No crypto, no await.
 *
 * Was `async` over `crypto.subtle.digest('SHA-256', …)`: native C++, but ASYNC,
 * which infected every persistent call site (get/set/delete/remove) with an
 * await and a per-key digest. You don't need crypto strength to *name* a cache
 * file. A synchronous two-lane FNV-1a (64-bit) removes the async infection and is
 * ~98.7% faster on the hashing itself (flipflop: `cache-name-hash`, 286ms→3.4ms
 * over 4096 keys). Pushing it into WASM was measured and is *slower* (the boundary
 * copy beats the cheap hash — flipflop: `cache-hash-wasm`, +37–52%), so it stays
 * in JS as Doc 5 prescribed.
 *
 * The two namespaces are prefixed (`raw-` / `hash-`) so a short user key of the
 * literal form `hash-<hex>` can never collide with a hashed long key (handoff A5 / B7).
 */
export function cacheNameFor(key: string): string {
  const enc = safeCacheName(key);
  if (enc.length + NS_RAW.length <= MAX_NAME) return NS_RAW + enc;
  // two-lane FNV-1a over UTF-8 bytes → 64-bit space (collision-safe to ~4e9 keys).
  const bytes = new TextEncoder().encode(key);
  let h1 = 0x811c9dc5, h2 = 0xc2b2ae35;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca77) >>> 0;
  }
  return NS_HASH + (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export class JxlCacheBrowser implements JxlCache {
  private readonly memoryCache: LRUCache<SharedArrayBuffer>;
  private readonly persistentTracker: LRUCache<PersistentEntry>;
  private readonly inflightGets = new Map<string, Promise<SharedArrayBuffer | undefined>>();
  private readonly inflightSets = new Map<string, Promise<void>>();
  private readonly _encoder = new TextEncoder();

  private opfsRoot: FileSystemDirectoryHandle | null = null;
  private hitCount = 0;
  private missCount = 0;
  private evictionsCount = 0;
  private quotaEvictionsCount = 0;
  private manifestDirty = false;
  private manifestPendingWrite: Promise<void> | null = null;
  // Incremented on every clear(). Guards async operations that straddle a clear boundary.
  private _generation = 0;
  private initPromise: Promise<void> | null = null;
  private persistentLimit: number;

  constructor(private readonly opts: CacheOptions) {
    this.memoryCache = new LRUCache(opts.memoryLimit);
    this.persistentTracker = new LRUCache(opts.persistentLimit);
    this.persistentLimit = opts.persistentLimit;
  }

  init(): Promise<void> {
    return this.initPromise ??= this.doInit();
  }

  private async doInit(): Promise<void> {
    if (!this.opts.persistent || typeof navigator === 'undefined' || !navigator.storage) {
      return;
    }

    try {
      this.opfsRoot = await navigator.storage.getDirectory();
      const estimate = await navigator.storage.estimate().catch(() => null);
      if (estimate && typeof estimate.quota === 'number') {
        const remaining = typeof estimate.usage === 'number'
          ? Math.max(0, estimate.quota - estimate.usage)
          : estimate.quota;
        this.persistentLimit = Math.min(this.opts.persistentLimit, Math.floor(remaining * 0.5));
        this.persistentTracker.setMaxSize(this.persistentLimit);
      }
      await this.loadManifest();
    } catch (e) {
      console.warn('OPFS initialization failed', e);
      this.opfsRoot = null;
    }
  }

  async get(key: string): Promise<SharedArrayBuffer | undefined> {
    if (this.initPromise) await this.initPromise.catch(() => undefined);

    const mem = this.memoryCache.get(key);
    if (mem !== undefined) {
      this.persistentTracker.get(key);
      this.hitCount++;
      return mem;   // SAB: shared reference, never detaches on postMessage
    }

    if (!this.opfsRoot) {
      this.missCount++;
      return undefined;
    }

    const ps = this.inflightSets.get(key);
    if (ps) await ps.catch(() => undefined);

    const existing = this.inflightGets.get(key);
    if (existing !== undefined) {
      const result = await existing;
      if (result !== undefined) this.hitCount++; else this.missCount++;
      return result;
    }

    const pending = this.getPersistent(key);
    this.inflightGets.set(key, pending);

    try {
      const result = await pending;
      if (result !== undefined) this.hitCount++; else this.missCount++;
      return result;
    } finally {
      this.inflightGets.delete(key);
    }
  }

  async has(key: string): Promise<boolean> {
    if (this.initPromise) await this.initPromise.catch(() => undefined);
    if (this.memoryCache.has(key)) return true;
    if (this.persistentTracker.has(key)) return true;
    return false;
  }

  async set(key: string, buffer: ArrayBuffer): Promise<void> {
    if (this.initPromise) await this.initPromise.catch(() => undefined);
    const size = buffer.byteLength;
    const sab = new SharedArrayBuffer(size);
    new Uint8Array(sab).set(new Uint8Array(buffer));
    this.memoryCache.set(key, sab, size);

    if (!this.opfsRoot || size > this.persistentLimit) {
      if (this.opfsRoot) {
        const previous = this.inflightSets.get(key) ?? Promise.resolve();
        const pending = (async () => {
          try { await previous; } catch { /* proceed */ }
          await this.removePersistentEntry(key);
          this.scheduleManifestWrite();
        })();
        this.inflightSets.set(key, pending);
        try { await pending; } finally {
          if (this.inflightSets.get(key) === pending) this.inflightSets.delete(key);
        }
      }
      return;
    }

    const gen = this._generation;
    const previous = this.inflightSets.get(key) ?? Promise.resolve();

    const pending = (async () => {
      try { await previous; } catch { /* proceed */ }
      if (this._generation !== gen) return;
      // Pass a Uint8Array view of the SAB to OPFS — avoids a second copy and is safe
      // because SAB cannot be transferred/detached, so the async write always reads valid data.
      await this.setPersistent(key, new Uint8Array(sab));
    })();

    this.inflightSets.set(key, pending);

    try {
      await pending;
    } finally {
      if (this.inflightSets.get(key) === pending) {
        this.inflightSets.delete(key);
      }
    }
  }

  async delete(key: string): Promise<void> {
    if (this.initPromise) await this.initPromise.catch(() => undefined);
    this.memoryCache.delete(key);
    const ps = this.inflightSets.get(key);
    if (ps) await ps.catch(() => undefined);
    await this.removePersistentEntry(key);
    this.scheduleManifestWrite();
  }

  async clear(): Promise<void> {
    if (this.initPromise) await this.initPromise.catch(() => undefined);
    this._generation++;
    this.memoryCache.clear();
    this.persistentTracker.clear();
    this.inflightGets.clear();
    this.inflightSets.clear();
    this.manifestDirty = false;

    if (!this.opfsRoot) return;

    try {
      const names: string[] = [];
      for await (const name of (this.opfsRoot as IterableDirectoryHandle).keys()) {
        names.push(name);
      }
      await Promise.allSettled(
        names.map((name) => this.opfsRoot!.removeEntry(name).catch(() => undefined)),
      );
    } catch (e) {
      console.warn('[JxlCacheBrowser] Partial clear failure — OPFS directory iteration failed', e);
    }
  }

  stats() {
    const total = this.hitCount + this.missCount;
    return {
      memory: {
        count: this.memoryCache.count,
        size: this.memoryCache.size,
        limit: this.opts.memoryLimit,
      },
      persistent: {
        count: this.persistentTracker.count,
        size: this.persistentTracker.size,
        limit: this.persistentLimit,
        enabled: this.opfsRoot !== null,
        evictions: this.evictionsCount,
        quotaEvictions: this.quotaEvictionsCount,
      },
      inflight: {
        gets: this.inflightGets.size,
        sets: this.inflightSets.size,
      },
      hitRate: total > 0 ? this.hitCount / total : null,
    };
  }

  /**
   * Lightweight dashboard-facing stats snapshot.
   * Read-only; no side effects; additive (no behavior change).
   */
  getStats(): { hits: number; misses: number; totalRequests: number; hitRate: number | null } {
    const total = this.hitCount + this.missCount;
    return {
      hits: this.hitCount,
      misses: this.missCount,
      totalRequests: total,
      hitRate: total > 0 ? this.hitCount / total : null,
    };
  }

  private async getPersistent(key: string): Promise<SharedArrayBuffer | undefined> {
    if (!this.opfsRoot) return undefined;

    const gen = this._generation;

    try {
      const entry = this.persistentTracker.get(key);
      const name = entry?.name ?? cacheNameFor(key);

      const fileHandle = await this.opfsRoot.getFileHandle(name);
      const file = await fileHandle.getFile();

      if (file.size === 0) {
        this.persistentTracker.delete(key);
        this.opfsRoot.removeEntry(name).catch(() => undefined);
        return undefined;
      }

      const raw = await file.arrayBuffer();

      if (this._generation !== gen) return undefined;

      const sab = new SharedArrayBuffer(raw.byteLength);
      new Uint8Array(sab).set(new Uint8Array(raw));
      this.memoryCache.set(key, sab, sab.byteLength);

      if (entry === undefined) {
        this.persistentTracker.set(key, { name }, sab.byteLength);
      }

      return sab;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') {
        this.persistentTracker.delete(key);
      } else if (e instanceof DOMException) {
        console.warn(`[JxlCacheBrowser] Failed to read persistent entry for "${key}"`, e);
      }
      return undefined;
    }
  }

  private async setPersistent(key: string, buffer: ArrayBuffer | Uint8Array): Promise<void> {
    if (!this.opfsRoot) return;

    const gen = this._generation;
    const size = buffer.byteLength;
    const name = cacheNameFor(key);

    await this.evictPersistentUntilFits(size);

    if (this._generation !== gen) return;

    try {
      await this.writePersistentFile(name, buffer);
      if (this._generation !== gen) return;
      this.persistentTracker.set(key, { name }, size);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        this.quotaEvictionsCount++;
        console.info(`[JxlCacheBrowser] Quota exceeded for "${key}", evicting aggressively`);
        await this.evictPersistentFraction(0.75);
        if (this._generation !== gen) return;
        try {
          await this.writePersistentFile(name, buffer);
          if (this._generation !== gen) return;
          this.persistentTracker.set(key, { name }, size);
        } catch (retryErr) {
          console.warn(`[JxlCacheBrowser] Persistent store still full after eviction, skipping persist for "${key}"`, retryErr);
          return;
        }
      } else {
        console.error(`[JxlCacheBrowser] Failed to persist "${key}"`, e);
        throw e;
      }
    }

    this.scheduleManifestWrite();
  }

  private async writePersistentFile(name: string, buffer: ArrayBuffer | Uint8Array): Promise<void> {
    if (!this.opfsRoot) return;

    // OPFS FileSystemWritableFileStream.write() rejects SharedArrayBuffer-backed
    // views ("The provided ArrayBuffer value must not be shared"). The memory
    // cache is SAB-backed and setPersistent forwards a SAB view, so copy into a
    // non-shared buffer before writing. (A bare ArrayBuffer / non-shared view
    // passes through untouched.)
    let data: ArrayBuffer | Uint8Array = buffer;
    const underlying = buffer instanceof Uint8Array ? buffer.buffer : buffer;
    if (typeof SharedArrayBuffer !== 'undefined' && underlying instanceof SharedArrayBuffer) {
      data = buffer instanceof Uint8Array ? new Uint8Array(buffer) : new Uint8Array(new Uint8Array(buffer));
    }

    const fileHandle = await this.opfsRoot.getFileHandle(name, { create: true });
    const writable = await (fileHandle as WritableFileHandle).createWritable();

    try {
      await writable.write(data);
      await writable.close();
    } catch (writeErr) {
      try { await writable.abort(); } catch { /* intentionally ignored */ }
      throw writeErr;
    }
  }

  private async evictPersistentUntilFits(incomingSize: number): Promise<void> {
    while (
      this.persistentTracker.size + incomingSize > this.persistentLimit &&
      this.persistentTracker.count > 0
    ) {
      const oldest = this.persistentTracker.getOldestKey();
      if (oldest === undefined) break;
      await this.removePersistentEntry(oldest);
    }
  }

  private async evictPersistentFraction(fraction: number): Promise<void> {
    const target = Math.max(1, Math.ceil(this.persistentTracker.count * fraction));

    for (let i = 0; i < target && this.persistentTracker.count > 0; i++) {
      const oldest = this.persistentTracker.getOldestKey();
      if (oldest === undefined) break;
      await this.removePersistentEntry(oldest);
    }
  }

  private async removePersistentEntry(key: string): Promise<void> {
    if (!this.opfsRoot) return;

    const entry = this.persistentTracker.peek(key);
    const name = entry?.name ?? cacheNameFor(key);

    try {
      await this.opfsRoot.removeEntry(name);
    } catch {
      // Stale tracker or already removed.
    } finally {
      this.persistentTracker.delete(key);
      this.evictionsCount++;
    }
  }

  private async loadManifest(): Promise<void> {
    if (!this.opfsRoot) return;

    try {
      const handle = await this.opfsRoot.getFileHandle(MANIFEST_NAME);
      const file = await handle.getFile();
      const manifest = JSON.parse(await file.text()) as {
        version: 1;
        entries: Array<{ key: string; name: string; size: number }>;
      };

      if (manifest.version !== 1) return;

      for (const entry of manifest.entries) {
        if (typeof entry.key === 'string' && typeof entry.name === 'string' && Number.isFinite(entry.size) && entry.size >= 0) {
          this.persistentTracker.set(entry.key, { name: entry.name }, entry.size);
        }
      }
    } catch {
      // No manifest yet.
    }

    await this.reconcile();
  }

  private async reconcile(): Promise<void> {
    if (!this.opfsRoot) return;
    const onDisk = new Set<string>();
    for await (const name of (this.opfsRoot as IterableDirectoryHandle).keys()) onDisk.add(name);
    onDisk.delete(MANIFEST_NAME);
    this.persistentTracker.forEachOldestFirst((key, entry, size) => {
      if (!onDisk.has(entry.name)) this.persistentTracker.delete(key);
      else onDisk.delete(entry.name);
    });
    await Promise.allSettled([...onDisk].map(n => this.opfsRoot!.removeEntry(n).catch(() => undefined)));
  }

  private scheduleManifestWrite(): void {
    this.manifestDirty = true;

    if (this.manifestPendingWrite !== null) return;

    this.manifestPendingWrite = new Promise(resolve => setTimeout(resolve, 250))
      .then(() => this.drainManifest())
      .finally(() => { this.manifestPendingWrite = null; });
  }

  private async drainManifest(): Promise<void> {
    while (this.manifestDirty) {
      this.manifestDirty = false;
      await this.writeManifest();
    }
  }

  private async writeManifest(): Promise<void> {
    if (!this.opfsRoot) return;
    const performWrite = async () => {
      const gen = this._generation;
      const root = this.opfsRoot;
      if (!root) return;

      try {
        const entries: Array<{ key: string; name: string; size: number }> = [];

        this.persistentTracker.forEachOldestFirst((key, entry, size) => {
          entries.push({ key, name: entry.name, size });
        });

        const manifest = { version: 1 as const, entries };
        const encoded = this._encoder.encode(JSON.stringify(manifest));

        if (this._generation !== gen) return;
        await this.writePersistentFile(MANIFEST_NAME, encoded);

        if (this._generation !== gen) {
          await root.removeEntry(MANIFEST_NAME).catch(() => undefined);
        }
      } catch (e) {
        console.warn('[JxlCacheBrowser] Failed to write manifest (non-fatal)', e);
      }
    };

    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request('jxl-cache-manifest', async () => performWrite());
    } else {
      await performWrite();
    }
  }
}
