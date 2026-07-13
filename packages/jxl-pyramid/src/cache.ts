import type { LevelSource } from "./level-source.js";
import { tileKey, type TileId } from "./decode-core.js";

/**
 * By-reference in-memory L1 cache. Callers must `slice()` any WASM-heap view before
 * `set` — a `memory.grow` silently invalidates views into the old heap. Never transfer
 * a cached buffer's ArrayBuffer via postMessage. Cache IDs are realm-local: if tiles
 * decode in workers the cache must live on exactly one thread (main).
 */
export interface PyramidCache {
  get(key: string): Uint8Array | undefined;
  set(key: string, value: Uint8Array): void;
  has(key: string): boolean;
  delete(key: string): void;
  clear(): void;
  readonly capacityBytes?: number;
  readonly bytesUsed?: number;
  readonly entryCount?: number;
  stats?(): PyramidCacheStats;
  /** Resize capacity; evicts oldest entries immediately if over the new limit. */
  setMaxBytes?(maxBytes: number): void;
  /** Recency bump without a read. Returns false if the key is absent. */
  touch?(key: string): boolean;
}

export interface PyramidCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  bytesUsed: number;
  entryCount: number;
}

interface CacheEntry { v: Uint8Array; len: number }

const levelIdBySource = new WeakMap<LevelSource, string>();
const bufIdByBuffer = new WeakMap<ArrayBufferLike, string>();
const bytesIdCache = new WeakMap<Uint8Array, string>();
let idCounter = 0;

// Defensive check: cache module assumes single-realm execution (main thread only).
// If this is imported in a worker or shared across realms, idCounter and WeakMaps will be unsynchronized.
// Use makeLevelCacheKey(contenthash) for multi-realm scenarios.
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined") {
  console.warn(
    "cache.ts loaded in worker context; level IDs may conflict. Use contenthash-based cache keys instead.",
  );
}

/**
 * Key by underlying buffer + view window instead of view identity.
 * Ensures re-derived views or subarrays of the same buffer share the same ID.
 * Assumption: level bytes are immutable post-ingest.
 */
export function bytesId(view: Uint8Array): string {
  // Cache the full composite string to avoid template-literal construction on every call.
  let id = bytesIdCache.get(view);
  if (id != null) return id;

  let b = bufIdByBuffer.get(view.buffer);
  if (b == null) {
    b = `B${++idCounter}`;
    bufIdByBuffer.set(view.buffer, b);
  }
  id = `${b}:${view.byteOffset}:${view.byteLength}`;
  bytesIdCache.set(view, id);
  return id;
}

/**
 * Stable ID for a LevelSource or Uint8Array. Identity-based fallback for sources without
 * a contenthash — prefer `makeLevelCacheKey(contenthash)` when one is available.
 * `instanceof Uint8Array` is realm-local and will not match across worker boundaries.
 */
export function getLevelId(arg: Uint8Array | LevelSource): string {
  if (arg instanceof Uint8Array) {
    return bytesId(arg);
  }
  let id = levelIdBySource.get(arg);
  if (id == null) {
    id = (arg as any).bytes instanceof Uint8Array ? bytesId((arg as any).bytes) : `L${++idCounter}`;
    levelIdBySource.set(arg, id);
  }
  return id;
}

class InMemoryPyramidCache implements PyramidCache {
  private readonly map = new Map<string, CacheEntry>();
  private bytes = 0;
  private maxB: number;
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  constructor(
    maxBytes: number,
    private readonly onEvictCb?: (key: string, value: Uint8Array) => void,
  ) {
    this.maxB = maxBytes;
  }

  get capacityBytes(): number { return this.maxB; }
  get bytesUsed(): number { return this.bytes; }
  get entryCount(): number { return this.map.size; }

  stats(): PyramidCacheStats {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount,
      bytesUsed: this.bytes,
      entryCount: this.map.size,
    };
  }

  get(key: string): Uint8Array | undefined {
    const e = this.map.get(key);
    if (!e) { this.missCount++; return undefined; }
    if (e.v.length !== e.len) {
      // Buffer detached (transferred via postMessage) — fix accounting, treat as miss.
      this.bytes -= e.len;
      this.map.delete(key);
      this.missCount++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    this.hitCount++;
    return e.v;
  }

  set(key: string, value: Uint8Array): void {
    if (value.length > this.maxB) { this.delete(key); return; } // C1: oversized → reject, don't wipe cache
    const old = this.map.get(key);
    if (old) { this.bytes -= old.len; this.map.delete(key); }
    const entry: CacheEntry = { v: value, len: value.length };
    this.map.set(key, entry);
    this.bytes += entry.len;
    this._evictToFit();
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): void {
    const e = this.map.get(key);
    if (e) {
      this.bytes -= e.len;
      this.map.delete(key);
      // Intentionally no onEvict: explicit deletes are not capacity evictions.
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
    // Intentionally no onEvict: clear is not a capacity eviction.
  }

  setMaxBytes(maxBytes: number): void {
    this.maxB = Math.max(0, maxBytes);
    this._evictToFit();
  }

  touch(key: string): boolean {
    const e = this.map.get(key);
    if (!e) return false;
    this.map.delete(key);
    this.map.set(key, e);
    return true;
  }

  private _evictToFit(): void {
    while (this.bytes > this.maxB && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value as string;
      const oldest = this.map.get(oldestKey)!;
      this.bytes -= oldest.len;
      this.map.delete(oldestKey);
      this.evictionCount++;
      this.onEvictCb?.(oldestKey, oldest.v);
    }
  }
}

export function createInMemoryPyramidCache(opts: {
  maxBytes?: number;
  /** Fired for capacity evictions only — NOT for delete() or clear(). Enables L2 write-back to jxl-cache/OPFS at the call site. */
  onEvict?: (key: string, value: Uint8Array) => void;
} = {}): PyramidCache {
  const max = opts.maxBytes ?? 32 * 1024 * 1024;
  return new InMemoryPyramidCache(max, opts.onEvict);
}

/** Stable cache key from manifest contenthash. Preferred over identity-based getLevelId. */
export function makeLevelCacheKey(contenthash: string): string {
  return `ch:${contenthash}`;
}

/** Canonical key for per-tile cache entries using stable TileId (no ad-hoc coord strings). */
export function makeTileCacheKey(sourceId: string, tile: TileId): string {
  return `${sourceId}:${tileKey(tile)}`;
}

export type { TileId };
export { tileKey };
