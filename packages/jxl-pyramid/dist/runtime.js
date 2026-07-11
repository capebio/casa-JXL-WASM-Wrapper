// runtime.ts
// Canonical decode runtime for the Pyramid Gallery (Packet 2, Task 1 — findings 74, 77, 78).
//
// Purpose: give the modular gallery ONE public decode entry point that owns exactly ONE
// tiled worker pool for its lifetime. Gallery code must never create a pool inside a decode
// call (finding 78) and there must be a single, unambiguous orchestration surface (finding 77).
//
// This module PINS the accepted target interfaces (LodRequest, DecodeCapabilities, LevelSource
// byte-carrier, DecodeLease) that later Packet-2 tasks must consume. Task 3 will fold the two
// existing engines (decode-level.ts and tiled-decode-pool.ts) behind this runtime; Task 1
// deliberately keeps those entry points intact and delegates to them.
import { PyramidError, } from "./decode-core.js";
import { decodeLevel } from "./decode-level.js";
import { PyramidWorkerPool, disposeDefaultPool, decodeTiledViewportPooled } from "./tiled-decode-pool.js";
/**
 * The set of demand option names the runtime understands. Any other key is rejected at the
 * caller boundary (finding 77: legacy code leaked `sourceKey`/`priority`/`format` that were
 * silently ignored by the underlying decoders). Deterministic failure > silent drift.
 */
const ALLOWED_DEMAND_KEYS = new Set([
    "quality",
    "signal",
    "cache",
    "outBuffer",
    "onTile",
    "budgetMs",
]);
function assertKnownDemand(demand) {
    if (!demand)
        return;
    for (const key of Object.keys(demand)) {
        if (!ALLOWED_DEMAND_KEYS.has(key)) {
            throw new PyramidError("UNSUPPORTED_OPTION", `unsupported decode option "${key}" (unknown option name rejected at runtime boundary; allowed: ${[...ALLOWED_DEMAND_KEYS].join(", ")})`);
        }
    }
}
function progressiveFor(quality) {
    // preview/interactive want fast coarse-first paint; final is one-shot.
    return quality === "preview" || quality === "interactive" ? "dc-then-final" : undefined;
}
const HWC = globalThis.navigator?.hardwareConcurrency ?? 4;
export function createPyramidRuntime(options) {
    const { workerFactory, capabilities, coreBudget, poolMaxSize, idleTimeoutMs, minIdle } = options;
    // Build the single pool eagerly when workers are available. One pool, one factory, for the
    // runtime's whole lifetime — this is the invariant Packet 2 pins (findings 77, 78).
    let pool;
    if (capabilities.workers && workerFactory) {
        pool = new PyramidWorkerPool({
            factory: workerFactory,
            maxSize: Math.max(1, poolMaxSize ?? Math.min(HWC, 8)),
            idleTimeoutMs: idleTimeoutMs ?? 5000,
            minIdle: minIdle ?? 2,
            coreBudget: coreBudget ?? undefined,
            prewarm: "lazy",
        });
    }
    let disposed = false;
    async function decodeLevelImpl(source, region, demand) {
        if (disposed)
            throw new PyramidError("POOL_DESTROYED", "runtime disposed");
        assertKnownDemand(demand);
        const opts = {};
        if (demand?.signal)
            opts.signal = demand.signal;
        if (demand?.cache)
            opts.cache = demand.cache;
        if (demand?.outBuffer)
            opts.outBuffer = demand.outBuffer;
        if (demand?.onTile)
            opts.onTile = demand.onTile;
        if (demand?.budgetMs != null)
            opts.budgetMs = demand.budgetMs;
        const progressive = progressiveFor(demand?.quality);
        if (progressive)
            opts.progressive = progressive;
        // Dispatch: a tiled level with the runtime's owned pool goes straight to the pooled
        // orchestrator, which honours the injected pool independently of the ambient
        // crossOriginIsolated gate that decode-level.ts consults. This is the whole point of the
        // runtime: it KNOWS it owns a pool, so it never spins one up inside the call (finding 78),
        // and it is the single unambiguous orchestration surface (finding 77).
        if (source.kind === "tiled" && pool) {
            if (region === undefined) {
                throw new PyramidError("BAD_REGION", "tiled level decode requires an explicit region");
            }
            // Inject THIS runtime's pool. (The DecodeOptions.pool field is the structural
            // PyramidPoolLike; PyramidWorkerPool satisfies it — the same call shape decode-level.ts
            // uses. Task 3 will tighten this boundary when it consolidates orchestration.)
            opts.pool = pool;
            opts.parallel = true;
            return decodeTiledViewportPooled(source, region, opts);
        }
        // Whole levels (or worker-less environments) use the shared planner. No pool is created here.
        opts.parallel = false;
        return decodeLevel(source, region, opts);
    }
    return {
        capabilities,
        get pool() {
            return pool;
        },
        decodeLevel: decodeLevelImpl,
        async dispose() {
            if (disposed)
                return;
            disposed = true;
            if (pool) {
                await pool.destroy();
                pool = undefined;
            }
            // Belt-and-braces: also drop any process-wide default singleton the legacy path may have made.
            await disposeDefaultPool();
        },
    };
}
//# sourceMappingURL=runtime.js.map