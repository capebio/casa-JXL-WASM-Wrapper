import type { ImageRegion } from "./tiling.js";
import type { PyramidCache } from "./cache.js";
export type PixelFormat = 'rgba8' | 'rgba16';
export interface DecodedLevel {
    pixels: Uint8Array;
    width: number;
    height: number;
    format: PixelFormat;
    /**
     * When errorPolicy='skip-tile' and tile decodes failed, lists the grid tiles that were zero-filled (L20-1).
     * See DecodeOptions.errorPolicy for the viewport cache contract: do not cache a DecodedLevel with failedTiles
     * under a 'final' viewportCacheKey — later hits would return zero-filled holes as complete final pixels.
     */
    failedTiles?: TileId[];
    /** ICC profile bytes from the container (pass-through; no transform applied). Populated when DecodeOptions.preserveMetadata (Agent 6 item 4). */
    iccProfile?: Uint8Array;
}
export declare const buffersInFlight: WeakSet<Uint8Array>;
export declare const formatFromBits: (bits: 8 | 16) => PixelFormat;
export declare const bppOfFormat: (f: PixelFormat) => 4 | 8;
export type RegionDecoder = (bytes: Uint8Array, region: ImageRegion) => Promise<DecodedLevel>;
export declare const REGION_DECODER_RGBA8: RegionDecoder;
export declare const REGION_DECODER_RGBA16: RegionDecoder;
export declare const pickRegionDecoder: (bits: 8 | 16) => RegionDecoder;
export declare const WHOLE_DECODE_OPTS: Readonly<{
    progressionTarget: "final";
    emitEveryPass: false;
    preserveIcc: false;
    preserveMetadata: false;
}>;
export declare function clampPositive(x: number, max: number): number;
/** longEdge helper (Grok4 micro-opt): ternary, no Math.max call. */
export declare function longEdge(w: number, h: number): number;
export declare function assertFiniteRegion(r: ImageRegion): void;
/** Snap fractional regions to integers: floor the origin, ceil the far edge.
 *  Output always covers the requested rect. Identity (no alloc) for integer input. */
export declare function snapRegionToIntegers(r: ImageRegion): ImageRegion;
/** Central clamp (replaces 3 inlined sites: decode-level, pool, tiling). */
export declare function clampRegion(region: ImageRegion, imageW: number, imageH: number): ImageRegion;
/**
 * Write one decoded tile into outBuffer at its offset within viewport.
 * Replaces the parts[] "stitch all" signature (stream-stitch: on-arrival writes).
 * Fast-path stride-aligned kept; fallback row subarray. Indexed loops.
 */
export declare function stitch(outBuffer: Uint8Array, viewport: ImageRegion, tile: ImageRegion, decoded: DecodedLevel, bytesPerPixel: 4 | 8): void;
/**
 * Stitch a sub-rectangle of a decoded full tile into the viewport buffer.
 * srcRect is in image coordinates and must lie within the decoded tile; the decoded tile's
 * top-left in image coordinates is (srcOriginX, srcOriginY) with row stride decodedW·bpp.
 */
export declare function stitchCropped(outBuffer: Uint8Array, viewport: ImageRegion, srcRect: ImageRegion, decodedPixels: Uint8Array, decodedW: number, decodedH: number, srcOriginX: number, srcOriginY: number, bytesPerPixel: 4 | 8): void;
/** L10-R4: reverse-trust validation that decoder delivered the exact region/size/bpp requested.
 * Throws DECODER_OUTPUT_MISMATCH on dim or byteLength mismatch.
 */
export declare function validateDecodedOutput(decoded: DecodedLevel, expectedRegion: ImageRegion, bpp: 4 | 8): void;
export type PyramidErrorCode = 'ABORTED' | 'POOL_DESTROYED' | 'FACTORY_CONFLICT' | 'TIMEOUT' | 'INVALID_REPLY' | 'EMPTY_LEVELS' | 'BAD_REGION' | 'JXTC_PARSE' | 'OOM' | 'INTERNAL' | 'INVALID_BUFFER_SIZE' | 'BUFFER_IN_USE' | 'BAD_MANIFEST' | 'INVALID_BUFFER_ALIGNMENT' | 'DECODER_OUTPUT_MISMATCH' | 'DIM_MISMATCH' | (string & {});
export declare class PyramidError extends Error {
    code: PyramidErrorCode;
    cause?: unknown;
    constructor(code: PyramidErrorCode, message: string, cause?: unknown);
}
/**
 * Race a promise against an AbortSignal.
 * - Cleans up listeners on either settlement.
 * - If abort wins, swallows rejection from p to prevent orphaned unhandled rejection.
 * - Pre-aborted signal: swallows p and rejects immediately.
 */
export declare function raceWithAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T>;
/** F7: stable, immutable tile coordinate for cache keys, telemetry, multi-pass coordination. */
export interface TileId {
    level: number;
    col: number;
    row: number;
}
/** High-perf stable string key for a tile (used for LRU cache keys and logs). */
export declare function tileKey(tile: TileId): string;
/** F7: canonical TileId for a (clipped) tile rect — col/row from grid origin. */
export declare function tileIdOf(rect: ImageRegion, tileSize: number, level: number): TileId;
export declare const DEV: boolean;
/** Packed numeric tile key for hot maps: level ≤ 8190, col/row < 2^20 — keeps value < 2^53 (exact in IEEE double). */
export declare function tileKeyPacked(tile: TileId): number;
/** L1-3: stable viewport cache key (quality distinguishes dc/final for progressive). */
export declare function viewportCacheKey(levelId: string, vp: ImageRegion, format: PixelFormat, quality: 'dc' | 'final'): string;
export interface TileProgress {
    id: TileId;
    key: string;
    stage: 'dc' | 'final';
    completed: number;
    total: number;
    /**
     * decodeMs: wall time (in milliseconds) of the tile's decode stage as observed by the dispatching thread (e.g., from performance.now() round-trip).
     * bytesDecoded: exact compressed input bytes consumed for this tile when known (from bitstream extraction), else undefined.
     */
    decodeMs?: number;
    bytesDecoded?: number;
}
export interface DecodeOptions {
    parallel?: boolean;
    decodeRegion?: RegionDecoder;
    signal?: AbortSignal;
    workerFactory?: () => WorkerLike;
    /** Explicit pool for parallel tiled decode (duck-typed; see PyramidPoolLike). */
    pool?: PyramidPoolLike;
    /** Opt-in decoded viewport cache (keyed by level+region+format; no auto persistence). */
    cache?: PyramidCache;
    /** Caller-owned recyclable buffer for stitched result (must be >= w*h*bpp). Returned .pixels will be this buffer on use. */
    outBuffer?: Uint8Array;
    /** If true, cache hits may return the cached Uint8Array directly (zero-copy). Default false (copies for safety). */
    zeroCopyCacheHits?: boolean;
    /** Called after each tile write (parallel) or once for direct (completedCount = tiles done).
     *  Third arg (TileProgress) supplied on new calls for F7 telemetry/identity; two-arg callers remain compatible. */
    onTile?: (region: ImageRegion, completedCount: number, progress?: TileProgress) => void;
    /**
     * L20-1: when 'skip-tile', per-tile errors in progressive direct path zero the tile rect and continue; failedTiles populated on result.
     * Cache contract: results carrying failedTiles?.length > 0 represent partial viewports (zero-filled holes). Callers and
     * any cache layer using viewportCacheKey(..., 'final') must not store such results as complete final pixels; doing so
     * would serve zeroed tiles as authoritative on subsequent hits (cache poisoning). The progressive direct path in
     * decodeTiledViewport already elides the cache.set when failedTiles is non-empty. Pooled paths do not implement
     * skip-tile (they fail-fast the batch). This field documents the invariant for all consumers of DecodeOptions + DecodedLevel.
     */
    errorPolicy?: 'fail-fast' | 'skip-tile';
    /** L20-2: wall-clock budget for the decodeLevel call (checked in progressive per-tile loops for direct path). */
    budgetMs?: number;
    /** L4-4: resume-after-abort support; skip these tile keys (tileKey format) during progressive per-tile decode. */
    skipTiles?: ReadonlySet<string>;
    /** When true (opt-in for Agent6-4), attaches iccProfile (pass-through from container) to results. Uses once-per-LevelSource lazy capture. Default false keeps prior perf for common sRGB paths. */
    preserveMetadata?: boolean;
    /** Opt-in CoreBudget (e.g. global from jxl-scheduler) to bound concurrent WASM workers with the main scheduler pool (Agent6-1). Passed to internal PyramidWorkerPool if workerFactory used. */
    coreBudget?: {
        acquire(cost?: number): Promise<void>;
        release(cost?: number): void;
        tryAcquire(cost?: number): boolean;
    } | null;
    /**
     * Progressive DC-then-final first-paint (F1, cites L3m-2 L21m-2 L8pm-3).
     * When set, per-tile (or viewport) uses createDecoder({ progressionTarget: 'dc' }) for fast coarse paint,
     * then a second pass to final at the same level/region. Caller's onTile fires twice per tile.
     * Wired to stream-stitch (Grok 4): caller paints DC tiles first, then refines.
     * Undefined (default) = existing one-shot final behavior (no behavior change for happy path).
     */
    progressive?: Exclude<ProgressiveMode, undefined>;
    cacheDcTiles?: boolean;
}
export type ProgressiveMode = 'dc-then-final' | 'dc-only' | undefined;
export declare function ensureIccProfile(source: {
    bytes: Uint8Array;
}, opts?: {
    preserveMetadata?: boolean;
}): Promise<Uint8Array | null>;
/**
 * Scheduler boundary documentation (P3, Lens 1/19).
 * decode-core's WorkerLike + PyramidPoolLike (and the tiled worker pool in tiled-decode-pool.ts) are for the
 * JXTC *synchronous region/tile decode* path: small fixed grids of tiles, direct libjxl ROI or per-tile worker
 * calls, stream-stitch writes, optional dc-then-final progressive. This is intentionally separate from the
 * jxl-scheduler / jxl-session streaming protocol (chunked progressive full-codestream sessions with preemption,
 * DedupeRegistry fan-out, adaptive HWM backpressure, and pause/resume). Both may create WASM-backed workers,
 * but they are different workloads (random viewport tiles vs sequential byte-stream decode).
 *
 * Cross-pool CPU/core oversubscription (Agent 6 item 1): Pyramid pool now supports optional CoreBudget
 * (from @casabio/jxl-scheduler) for opt-in bounding alongside scheduler. Pools remain distinct by design
 * (dumb tile ROI vs full session state). Acquire/release tokens around the batch handle window (not per-tile).
 */
/** Worker-like handle accepted by the pyramid pool (duck-typed; matches browser Worker + test doubles). See module comment above for scheduler boundary. */
export interface WorkerLike {
    addEventListener(type: "message" | "error" | "messageerror", listener: (ev: {
        data?: any;
    }) => void): void;
    removeEventListener(type: "message" | "error" | "messageerror", listener: (ev: {
        data?: any;
    }) => void): void;
    postMessage(data: any, transfer?: any[]): void;
    terminate(): void;
}
/**
 * Minimal structural (duck) type for DecodeOptions.pool.
 * Captures the exact members dereferenced by decodeTiledViewportPooled and shouldUseParallel
 * when an explicit pool is supplied (preferred over the module default singleton).
 * The concrete PyramidWorkerPool implementation lives in tiled-decode-pool.ts; this interface
 * lives here so decode-core (the types root) does not create a circular dependency.
 * Used only for the JXTC tiled/region fast path — intentionally separate from jxl-scheduler pools.
 */
export interface PyramidPoolLike {
    allocateBytesId(source: any): number;
    acquire(count: number, opts?: {
        maxWaitMs?: number;
    }): Promise<any[]>;
    release(handles: any[]): void;
    readonly requestTimeout?: number;
    destroy?(graceMs?: number): Promise<void> | void;
    readonly destroyed?: boolean;
    readonly poolState?: string;
    prewarm?(count: number): void;
}
/** Init/options bag passed to jxl-wasm createDecoder (local name for cast sites; structural). */
export interface DecoderInit {
    format: PixelFormat;
    progressionTarget: 'header' | 'dc' | 'pass' | 'final';
    emitEveryPass: boolean;
    preserveIcc: boolean;
    preserveMetadata: boolean;
}
export declare function cacheStore(cache: PyramidCache | undefined, key: string | undefined, pixels: Uint8Array, need: number): void;
export declare function sortCenterOut<T>(items: T[], viewport: ImageRegion, getRect: (item: T) => ImageRegion): T[];
//# sourceMappingURL=decode-core.d.ts.map