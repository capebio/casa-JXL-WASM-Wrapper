// Type declarations for @casabio/asset-store (plain-ESM implementation in src/index.js).

/** Optional L2 persistent backend AssetStore can drive (e.g. jxl-cache OPFS). */
export interface PersistentBackend {
  get(key: string): Promise<ArrayBufferLike | ArrayBufferView | undefined | null>;
  set(key: string, value: ArrayBufferLike | ArrayBufferView): Promise<void>;
  delete(key: string): Promise<void>;
  has?(key: string): Promise<boolean>;
}

export type EvictReason = "lru" | "delete" | "clear";

export interface AssetStoreOptions {
  /** In-memory byte budget (RAM tier). Required. */
  maxBytes: number;
  /** Fraction of `navigator.storage` remaining quota to allow the persistent tier (0..1, default 0.5). */
  quotaFraction?: number;
  /** Optional L2 backend (jxl-cache OPFS or an IDB adapter). */
  persistent?: PersistentBackend | null;
  /** Injectable storage estimator (defaults to navigator.storage.estimate). */
  estimateStorage?: () => Promise<{ quota?: number; usage?: number } | null>;
  /** Called when an entry leaves the store so a client can drop its own reference. */
  onEvict?: ((key: string, sizeBytes: number, reason: EvictReason) => void) | null;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Label for stats(). */
  name?: string;
}

export interface AssetStoreStats {
  name: string;
  entries: number;
  bytes: number;
  maxBytes: number;
  persistentLimit: number;
  quota?: number;
  usage?: number;
  hits: number;
  misses: number;
  sets: number;
  evictions: number;
  quotaHits: number;
  oversized: number;
  persistentReads: number;
  persistentWrites: number;
}

export interface NamespaceHandle {
  key(k: string): string;
  set(k: string, v: unknown, sizeBytes?: number): AssetStore;
  get(k: string): unknown | undefined;
  peek(k: string): unknown | undefined;
  has(k: string): boolean;
  delete(k: string): boolean;
  load(k: string): Promise<unknown | undefined>;
  store(k: string, v: ArrayBufferLike | ArrayBufferView, sizeBytes?: number): Promise<void>;
  remove(k: string): Promise<void>;
  keys(): IterableIterator<string>;
}

export declare class AssetStore {
  constructor(opts: AssetStoreOptions);
  readonly maxBytes: number;
  readonly bytes: number;
  readonly size: number;
  readonly persistentLimit: number;
  name: string;
  setMaxBytes(maxBytes: number): void;
  set(key: string, value: unknown, sizeBytes?: number): this;
  get(key: string): unknown | undefined;
  peek(key: string): unknown | undefined;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  keys(): IterableIterator<string>;
  refreshQuota(): Promise<{
    quota?: number;
    usage?: number;
    remaining: number;
    persistentLimit: number;
  }>;
  load(key: string): Promise<unknown | undefined>;
  store(key: string, value: ArrayBufferLike | ArrayBufferView, sizeBytes?: number): Promise<void>;
  remove(key: string): Promise<void>;
  stats(): AssetStoreStats;
  namespace(ns: string): NamespaceHandle;
}

export declare function measureBytes(value: unknown): number;
export declare function contentHash(data: ArrayBuffer | ArrayBufferView | string): string;
export declare function fitWithinBudget<T>(
  items: Iterable<T>,
  budgetBytes: number,
  sizeOf: (item: T) => number,
): { admitted: T[]; skipped: T[]; usedBytes: number };
export declare function isQuotaExceeded(err: unknown): boolean;

export default AssetStore;
