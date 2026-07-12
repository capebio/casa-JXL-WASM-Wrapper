import type { ImageRegion } from "./tiling.js";
import type { LevelSource as DecodedLevelSource } from "./level-source.js";
import { type DecodedLevel, type DecodeOptions } from "./decode-core.js";
import { PyramidWorkerPool } from "./tiled-decode-pool.js";
/** Demand descriptor: what LOD/precision/region the caller wants for a decode. */
export type LodRequest = {
    targetLongEdge: number;
    dpr: number;
    region?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    quality?: "preview" | "interactive" | "final";
};
/** Runtime environment capabilities, split so Worker availability is independent of SAB (finding 82). */
export type DecodeCapabilities = {
    workers: boolean;
    sharedMemory: boolean;
    rangeRequests: boolean;
    rgba16: boolean;
};
/**
 * Stable byte-carrier for a single pyramid level's bitstream (finding 74).
 *
 * This is the transport abstraction: an identity (`sourceKey`) plus lazy, optionally-ranged
 * byte access. It is intentionally distinct from the decoded-format descriptor union exported
 * by `./level-source.js` (which describes whole/tiled pixel geometry). Task 6 (range LOD
 * resolver) consumes this; Task 3 wires it into orchestration. Named per the accepted signature.
 */
export interface LevelSource {
    readonly sourceKey: string;
    size(): Promise<number>;
    read(range?: {
        start: number;
        endExclusive: number;
    }, signal?: AbortSignal): Promise<Uint8Array>;
}
/** A leased decode result whose underlying resources are released explicitly (finding 76, Task 5). */
export interface DecodeLease<T> {
    readonly promise: Promise<T>;
    release(): void;
}
/** CoreBudget shape (from @casabio/jxl-scheduler) for opt-in cross-pool core limiting. */
type CoreBudget = {
    acquire(cost?: number): Promise<void>;
    release(cost?: number): void;
    tryAcquire(cost?: number): boolean;
};
/** Options accepted by `PyramidRuntime.decodeLevel`. This is the caller boundary. */
export interface DecodeDemand {
    /** Requested output quality; maps to progressive strategy (preview/interactive -> dc-then-final, final -> one-shot). */
    quality?: "preview" | "interactive" | "final";
    /** Abort the in-flight decode. */
    signal?: AbortSignal;
    /** Opt-in decoded-viewport cache (level+region+format keyed). */
    cache?: DecodeOptions["cache"];
    /** Caller-owned recyclable output buffer (>= w*h*bpp). */
    outBuffer?: Uint8Array;
    /** Per-tile progress callback (telemetry / paint-on-arrival). */
    onTile?: DecodeOptions["onTile"];
    /** Wall-clock budget for the decode call. */
    budgetMs?: number;
}
export interface PyramidRuntimeOptions {
    /** Stable worker factory. The runtime owns ONE pool built from this factory for its lifetime. */
    workerFactory?: () => any;
    /** Environment capabilities (workers/SAB/range/rgba16). */
    capabilities: DecodeCapabilities;
    /** Optional CoreBudget to bound WASM workers alongside the main scheduler. */
    coreBudget?: CoreBudget;
    /** Pool cap (defaults to min(hardwareConcurrency, 8)). */
    poolMaxSize?: number;
    /** Idle worker reap timeout (ms). */
    idleTimeoutMs?: number;
    /** Warm-floor worker count kept alive. */
    minIdle?: number;
}
/**
 * The canonical decode runtime. One runtime = one pool = one orchestration surface.
 *
 * `decodeLevel` is the single public entry point. It validates option names, then delegates to
 * the existing `decodeLevel` planner injecting THIS runtime's pool — so no pool is ever created
 * inside a decode call.
 */
export interface PyramidRuntime {
    readonly capabilities: DecodeCapabilities;
    /** The single tiled worker pool owned by this runtime (undefined only if workers unavailable). */
    readonly pool: PyramidWorkerPool | undefined;
    /** Single public decode entry point. Rejects unknown option names deterministically. */
    decodeLevel(source: DecodedLevelSource, region?: ImageRegion, demand?: DecodeDemand): Promise<DecodedLevel>;
    /** Destroy the owned pool and release its workers. Idempotent. */
    dispose(): Promise<void>;
}
export declare function createPyramidRuntime(options: PyramidRuntimeOptions): PyramidRuntime;
export {};
//# sourceMappingURL=runtime.d.ts.map