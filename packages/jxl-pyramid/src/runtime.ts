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

import type { ImageRegion } from "./tiling.js";
import type { LevelSource as DecodedLevelSource } from "./level-source.js";
import {
  PyramidError,
  type DecodedLevel,
  type DecodeOptions,
} from "./decode-core.js";
import { decodeLevel } from "./decode-level.js";
import { PyramidWorkerPool, disposeDefaultPool, decodeTiledViewportPooled } from "./tiled-decode-pool.js";

// ---------------------------------------------------------------------------
// Accepted target interfaces (later Packet-2 tasks MUST use these signatures).
// ---------------------------------------------------------------------------

/** Demand descriptor: what LOD/precision/region the caller wants for a decode. */
export type LodRequest = {
  targetLongEdge: number;
  dpr: number;
  region?: { x: number; y: number; width: number; height: number };
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
  read(range?: { start: number; endExclusive: number }, signal?: AbortSignal): Promise<Uint8Array>;
}

/** A leased decode result whose underlying resources are released explicitly (finding 76, Task 5). */
export interface DecodeLease<T> {
  readonly promise: Promise<T>;
  release(): void;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

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

/**
 * The set of demand option names the runtime understands. Any other key is rejected at the
 * caller boundary (finding 77: legacy code leaked `sourceKey`/`priority`/`format` that were
 * silently ignored by the underlying decoders). Deterministic failure > silent drift.
 */
const ALLOWED_DEMAND_KEYS: ReadonlySet<string> = new Set<keyof DecodeDemand>([
  "quality",
  "signal",
  "cache",
  "outBuffer",
  "onTile",
  "budgetMs",
]);

function assertKnownDemand(demand: Readonly<Record<string, unknown>> | undefined): void {
  if (!demand) return;
  for (const key of Object.keys(demand)) {
    if (!ALLOWED_DEMAND_KEYS.has(key)) {
      throw new PyramidError(
        "UNSUPPORTED_OPTION",
        `unsupported decode option "${key}" (unknown option name rejected at runtime boundary; allowed: ${[...ALLOWED_DEMAND_KEYS].join(", ")})`,
      );
    }
  }
}

function progressiveFor(quality: DecodeDemand["quality"]): DecodeOptions["progressive"] {
  // preview/interactive want fast coarse-first paint; final is one-shot.
  return quality === "preview" || quality === "interactive" ? "dc-then-final" : undefined;
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

const HWC = (globalThis as any).navigator?.hardwareConcurrency ?? 4;

export function createPyramidRuntime(options: PyramidRuntimeOptions): PyramidRuntime {
  const { workerFactory, capabilities, coreBudget, poolMaxSize, idleTimeoutMs, minIdle } = options;

  // Build the single pool eagerly when workers are available. One pool, one factory, for the
  // runtime's whole lifetime — this is the invariant Packet 2 pins (findings 77, 78).
  let pool: PyramidWorkerPool | undefined;
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

  async function decodeLevelImpl(
    source: DecodedLevelSource,
    region?: ImageRegion,
    demand?: DecodeDemand,
  ): Promise<DecodedLevel> {
    if (disposed) throw new PyramidError("POOL_DESTROYED", "runtime disposed");
    assertKnownDemand(demand as Record<string, unknown> | undefined);

    const opts: DecodeOptions = {};
    if (demand?.signal) opts.signal = demand.signal;
    if (demand?.cache) opts.cache = demand.cache;
    if (demand?.outBuffer) opts.outBuffer = demand.outBuffer;
    if (demand?.onTile) opts.onTile = demand.onTile;
    if (demand?.budgetMs != null) opts.budgetMs = demand.budgetMs;
    const progressive = progressiveFor(demand?.quality);
    if (progressive) opts.progressive = progressive;

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
      if (disposed) return;
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
