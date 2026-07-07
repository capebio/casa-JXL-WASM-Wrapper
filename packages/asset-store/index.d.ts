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
  admissionRejections: number;
}

export interface AdmitOptions {
  /**
   * Memory headroom to check against (default: the store's remaining
   * `maxBytes - bytes`). Still clamped by the global `BUDGET_BYTES` ceiling.
   */
  budgetBytes?: number;
  /** Safety headroom applied to the estimate (default `PEAK_MULTIPLIER`, 1.7). */
  multiplier?: number;
  /** Identifier included in the rejection message (e.g. filename). */
  label?: string;
}

/** Returned by `admit()` when the decode fits — it throws otherwise. */
export interface AdmitResult {
  /** Always `true` on return; a rejected decode throws `AdmissionRejected`. */
  admitted: true;
  estimatedPeakBytes: number;
  budgetBytes: number;
  projectedBytes: number;
  wouldExceed: false;
}

/** Safety multiplier applied to the projected decode peak (browser-measured). */
export declare const PEAK_MULTIPLIER: number;
/** Global RAW-decode memory ceiling in bytes (~1.8 GiB of the 2 GiB WASM heap). */
export declare const BUDGET_BYTES: number;

/** Thrown by `AssetStore#admit` when a decode's projected peak exceeds the budget. */
export declare class AdmissionRejected extends Error {
  readonly name: "AdmissionRejected";
  readonly estimatedPeakBytes: number;
  readonly budgetBytes: number;
  readonly projectedBytes: number;
  readonly multiplier: number;
  readonly label?: string;
  constructor(
    estimatedPeakBytes: number,
    budgetBytes: number,
    projectedBytes: number,
    multiplier: number,
    label?: string,
  );
}

/** RAW-decode peak/retained memory projection (JS mirror of the Rust model). */
export interface DecodePeakEstimate {
  width: number;
  height: number;
  outputFlags: number;
  pixels: number;
  retainedBytes: number;
  peakBytes: number;
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
  /** @throws {AdmissionRejected} when `peak × multiplier` exceeds the budget. */
  admit(estimatedPeakBytes: number, opts?: AdmitOptions): AdmitResult;
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

/** A jxl-cache-shaped L2 cache (duck-typed; not imported from jxl-cache). */
export interface CacheLike {
  get(key: string): Promise<ArrayBufferLike | ArrayBufferView | undefined | null>;
  set(key: string, buffer: ArrayBuffer): Promise<void>;
  delete(key: string): Promise<void>;
  has?(key: string): Promise<boolean>;
  init?(): Promise<void>;
}

/** Adapt a jxl-cache-shaped cache into an injectable AssetStore PersistentBackend (S3-Q5). */
export declare function persistentBackendFromCache(cache: CacheLike): PersistentBackend;

// ---- RAW-decode memory preflight (mirror of Rust estimate_decode_peak) ----
export declare const OUT_FULL_RGB8: number;
export declare const OUT_LIGHTBOX: number;
export declare const OUT_THUMB: number;
export declare const OUT_FULL_16: number;
export declare const OUT_NO_ORIENT: number;
export declare const OUT_FULL_DISP16: number;
export declare const OUT_BATCH_DEFAULT: number;
export declare function estimateDecodePeak(
  width: number,
  height: number,
  outputFlags: number,
): DecodePeakEstimate;
export declare function estimateDecodePeakBytes(
  width: number,
  height: number,
  outputFlags: number,
): number;

export default AssetStore;
