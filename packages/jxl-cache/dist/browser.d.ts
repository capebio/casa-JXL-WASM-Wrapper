export interface CacheOptions {
    memoryLimit: number;
    persistentLimit: number;
    persistent?: boolean;
    basePath?: string;
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
export declare function safeCacheName(key: string): string;
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
export declare function cacheNameFor(key: string): string;
type CacheBuffer = ArrayBuffer | SharedArrayBuffer;
export declare class JxlCacheBrowser implements JxlCache {
    private readonly opts;
    private readonly memoryCache;
    private readonly persistentTracker;
    private readonly inflightGets;
    private readonly inflightSets;
    private readonly _encoder;
    private opfsRoot;
    private hitCount;
    private missCount;
    private evictionsCount;
    private quotaEvictionsCount;
    private manifestDirty;
    private manifestPendingWrite;
    private _generation;
    private initPromise;
    private persistentLimit;
    constructor(opts: CacheOptions);
    init(): Promise<void>;
    private doInit;
    get(key: string): Promise<CacheBuffer | undefined>;
    has(key: string): Promise<boolean>;
    set(key: string, buffer: ArrayBuffer): Promise<void>;
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
    stats(): {
        memory: {
            count: number;
            size: number;
            limit: number;
        };
        persistent: {
            count: number;
            size: number;
            limit: number;
            enabled: boolean;
            evictions: number;
            quotaEvictions: number;
        };
        inflight: {
            gets: number;
            sets: number;
        };
        hitRate: number | null;
    };
    /**
     * Lightweight dashboard-facing stats snapshot.
     * Read-only; no side effects; additive (no behavior change).
     */
    getStats(): {
        hits: number;
        misses: number;
        totalRequests: number;
        hitRate: number | null;
    };
    private getPersistent;
    private setPersistent;
    private writePersistentFile;
    private evictPersistentUntilFits;
    private evictPersistentFraction;
    private removePersistentEntry;
    private loadManifest;
    private reconcile;
    private scheduleManifestWrite;
    private drainManifest;
    private writeManifest;
}
export {};
