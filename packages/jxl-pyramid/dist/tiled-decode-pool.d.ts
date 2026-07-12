import { type ImageRegion } from "./tiling.js";
import type { LevelSource } from "./level-source.js";
import { type DecodedLevel, type DecodeOptions, type TileProgress, type PyramidPoolLike } from "./decode-core.js";
import { type PyramidCache } from "./cache.js";
import type { WorkerRequest, WorkerErrorCode } from "./worker-protocol.js";
export declare enum PoolState {
    Created = "created",
    Prewarming = "prewarming",
    Active = "active",
    Draining = "draining",
    Destroyed = "destroyed"
}
export declare enum HandleState {
    WarmFloor = "warm-floor",
    WarmReapable = "warm-reapable",
    Active = "active",
    Bad = "bad",
    Terminated = "terminated"
}
type WorkerLike = {
    addEventListener(type: "message" | "error" | "messageerror", listener: (ev: {
        data?: any;
    }) => void): void;
    removeEventListener(type: "message" | "error" | "messageerror", listener: (ev: {
        data?: any;
    }) => void): void;
    postMessage(data: WorkerRequest, transfer?: any[]): void;
    terminate(): void;
};
interface PendingJob {
    id: number;
    resolve: (d: DecodedLevel) => void;
    reject: (e: unknown) => void;
    timer: ReturnType<typeof globalThis.setTimeout> | null;
    requestTimer: ReturnType<typeof globalThis.setTimeout> | null;
    abortSignal?: AbortSignal | undefined;
    abortListener?: (() => void) | null;
    expectedBytes?: number | undefined;
    bytesPerPixel?: 4 | 8 | undefined;
}
/**
 * Persistent warmed worker pool for pyramid tile decodes (Grok2 protocol).
 * Uses load/decode split + bytesId to eliminate structured-clone amplification.
 * Supports readiness, best-effort cancel, 16-bit via format, parse validation.
 */
type WorkerHandle = {
    worker: WorkerLike;
    idleTimer: ReturnType<typeof globalThis.setTimeout> | null;
    state: HandleState;
    pending: Map<number, PendingJob>;
    nextId: number;
    ready: Promise<void>;
    /** resolved when first 'ready' arrives */
    _readyResolve?: (v?: unknown) => void;
    readySettled?: boolean;
    failure?: {
        code: WorkerErrorCode;
        message: string;
        at: number;
        count: number;
    };
    budgetCharged?: boolean;
    inIdle?: boolean;
};
export declare class PyramidWorkerPool {
    private readonly factory;
    private readonly maxSize;
    private readonly idleTimeoutMs;
    private readonly minIdle;
    private readonly requestTimeoutMs;
    private readonly lifecycle;
    /** Optional CoreBudget for cross-pool core limiting (with scheduler). Acquire around handle batch (Agent6-1). */
    private readonly coreBudget;
    private readonly workerCost;
    private state;
    private readonly all;
    private readonly idle;
    private readonly active;
    private readonly handleByWorker;
    private readonly bytesIdByWorker;
    private readonly bytesIdBySource;
    private readonly sabByBytesId;
    private nextBytesId;
    private readonly waiters;
    private visibilityDocument;
    private visibilityListener;
    constructor(opts: {
        factory: () => WorkerLike;
        maxSize: number;
        idleTimeoutMs: number;
        minIdle?: number;
        requestTimeoutMs?: number;
        lifecycle?: {
            hookVisibility?: boolean;
            hookFreeze?: boolean;
        };
        prewarm?: 'eager' | 'lazy' | 'on-demand';
        /** Opt-in CoreBudget (e.g. globalCoreBudget) to bound total WASM workers across scheduler + pyramid. */
        coreBudget?: {
            acquire(cost?: number): Promise<void>;
            release(cost?: number): void;
            tryAcquire(cost?: number): boolean;
        } | undefined;
        /** Tokens per worker handle (default 1; tile work lighter than full MT session). */
        workerCost?: number;
    });
    private prewarmMode;
    get destroyed(): boolean;
    get poolState(): PoolState;
    get size(): number;
    get activeCount(): number;
    get requestTimeout(): number | undefined;
    /** Allocate a bytesId for a LevelSource (lazily attached). */
    allocateBytesId(source: Extract<LevelSource, {
        kind: "tiled";
    }>): number;
    /** prewarm becomes async, resolves when spawned workers are ready (Grok3 #34). */
    prewarmAsync(count: number): Promise<void>;
    prewarm(count: number): void;
    /** whenReady for UI "warming" (Grok3 #36) */
    whenReady(): Promise<void>;
    /** Full destroy per Grok3 #9. */
    destroy(graceMs?: number): Promise<void>;
    private releaseBudget;
    private destroyHandle;
    /** reap all idle (for visibility hidden etc) */
    private reapAllIdle;
    /**
     * Acquire (with waiter queue for over cap, LIFO idle, ready filter, state checks).
     */
    acquire(count: number, opts?: {
        maxWaitMs?: number;
    }): Promise<WorkerHandle[]>;
    /** Return to idle (LIFO), drain waiters, arm all excess (Grok3 #19, #28). */
    release(handles: WorkerHandle[]): void;
    private armAllExcessIdle;
    private spawnOne;
    private readonly _reapBound;
    private armIdleTimer;
    private armIdleTimerFor;
    private clearIdleTimer;
    private cleanupPendingJob;
    ensureLoaded(handles: WorkerHandle[], bytesId: number, bytes: Uint8Array, useSAB: boolean): void;
}
/** Hoisted predicate (Grok4). */
export declare function shouldUseParallel(opts: {
    parallel?: boolean;
    workerFactory?: any;
    pool?: any;
} | undefined, numTiles: number, envCanParallel: boolean): boolean;
declare function getOrCreatePool(factory: () => WorkerLike, coreBudget?: {
    acquire(cost?: number): Promise<void>;
    release(cost?: number): void;
    tryAcquire(cost?: number): boolean;
}): PyramidWorkerPool;
export declare function disposeDefaultPool(): Promise<void>;
export declare const __testing: {
    decodeTilesParallel: typeof decodeTilesParallel;
    getOrCreatePool: typeof getOrCreatePool;
};
declare function decodeTilesParallel(bytesId: number, format: 'rgba8' | 'rgba16', tiles: ImageRegion[], handles: WorkerHandle[], outBuffer: Uint8Array, viewport: ImageRegion, bpp: 4 | 8, opts?: {
    signal?: AbortSignal;
    onTile?: (region: ImageRegion, completedCount: number, progress?: TileProgress) => void;
    progressiveStage?: 'dc' | 'final';
    progressBase?: number;
    progressTotal?: number;
    deadlineMs?: number;
    requestTimeoutMs?: number;
    tileSize?: number;
    tileLevel?: number;
    tileCache?: PyramidCache;
    sourceLevelId?: string;
    sourceW?: number;
    sourceH?: number;
    cacheDcTiles?: boolean;
}, deadlineMsFallback?: number, requestTimeoutMsFallback?: number, tileSizeFallback?: number, tileLevelFallback?: number): Promise<void>;
/**
 * The worker-pool strategy options: the full DecodeOptions surface plus the two pool-only knobs
 * (`useSAB` zero-copy carrier, explicit `pool`). Declared once so the public overloads and the
 * implementation agree exactly under `exactOptionalPropertyTypes` — the single orchestrator in
 * decode-level.ts and the runtime pass full DecodeOptions here (Task 3 boundary tightening).
 */
export type PooledDecodeOptions = DecodeOptions & {
    /** Opt-in SAB zero-copy for the load message when crossOriginIsolated (see canShareContainerBytes). */
    useSAB?: boolean;
    /**
     * Explicit long-lived pool (owned by the runtime). Preferred over the module default singleton.
     * Typed as the structural PyramidPoolLike so this matches DecodeOptions.pool exactly — the concrete
     * PyramidWorkerPool satisfies it. The implementation dereferences only the PyramidPoolLike surface.
     */
    pool?: PyramidPoolLike;
};
/**
 * Decode a tiled viewport with optional parallel per-tile workers (Grok2 protocol).
 * Uses bytesId + load/decode split. 16-bit now wired at root via format.
 */
export declare function decodeTiledViewportPooled(containerBytes: Uint8Array, region: ImageRegion, options?: PooledDecodeOptions): Promise<DecodedLevel>;
export declare function decodeTiledViewportPooled(source: Extract<LevelSource, {
    kind: "tiled";
}>, region: ImageRegion, options?: PooledDecodeOptions): Promise<DecodedLevel>;
export {};
//# sourceMappingURL=tiled-decode-pool.d.ts.map