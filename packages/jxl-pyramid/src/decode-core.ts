import { createDecoder, decodeTileContainerRegionRgba8, decodeTileContainerRegionRgba16 } from "@casabio/jxl-wasm";
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

export const buffersInFlight = new WeakSet<Uint8Array>();

export const formatFromBits = (bits: 8 | 16): PixelFormat => (bits === 16 ? 'rgba16' : 'rgba8');
export const bppOfFormat = (f: PixelFormat): 4 | 8 => (f === 'rgba16' ? 8 : 4);

export type RegionDecoder = (
  bytes: Uint8Array,
  region: ImageRegion,
) => Promise<DecodedLevel>;

// Module-level decoder constants (Grok1)
export const REGION_DECODER_RGBA8: RegionDecoder = async (b, r) => {
  const out = await decodeTileContainerRegionRgba8(b, r);
  return { pixels: out.pixels, width: out.width, height: out.height, format: 'rgba8' };
};
export const REGION_DECODER_RGBA16: RegionDecoder = async (b, r) => {
  const out = await decodeTileContainerRegionRgba16(b, r);
  return { pixels: out.pixels, width: out.width, height: out.height, format: 'rgba16' };
};

export const pickRegionDecoder = (bits: 8 | 16): RegionDecoder =>
  bits === 16 ? REGION_DECODER_RGBA16 : REGION_DECODER_RGBA8;

export const WHOLE_DECODE_OPTS = Object.freeze({
  progressionTarget: "final" as const,
  emitEveryPass: false,
  preserveIcc: false,
  preserveMetadata: false,
});

export function clampPositive(x: number, max: number): number {
  return x <= 0 ? 0 : (x >= max ? max : x);
}

/** longEdge helper (Grok4 micro-opt): ternary, no Math.max call. */
export function longEdge(w: number, h: number): number {
  return w > h ? w : h;
}

export function assertFiniteRegion(r: ImageRegion): void {
  // single-expression NaN/Infinity screen: any non-finite member poisons the sum
  if (!Number.isFinite(r.x + r.y + r.w + r.h)) {
    throw new PyramidError('BAD_REGION', `region must have finite x,y,w,h (got ${r.x},${r.y},${r.w},${r.h})`);
  }
}

/** Snap fractional regions to integers: floor the origin, ceil the far edge.
 *  Output always covers the requested rect. Identity (no alloc) for integer input. */
export function snapRegionToIntegers(r: ImageRegion): ImageRegion {
  if (Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h)) return r;
  const x = Math.floor(r.x), y = Math.floor(r.y);
  return { x, y, w: Math.ceil(r.x + r.w) - x, h: Math.ceil(r.y + r.h) - y };
}

/** Central clamp (replaces 3 inlined sites: decode-level, pool, tiling). */
export function clampRegion(region: ImageRegion, imageW: number, imageH: number): ImageRegion {
  assertFiniteRegion(region);
  if (!Number.isFinite(imageW) || !Number.isFinite(imageH) || imageW <= 0 || imageH <= 0) {
    throw new RangeError("imageW/H must be positive finite");
  }
  // Early out for common in-bounds case (Grok4).
  // Callers must not mutate the returned region; it may alias the input.
  if (region.x >= 0 && region.y >= 0 && region.x + region.w <= imageW && region.y + region.h <= imageH) {
    return region;
  }
  const rx = clampPositive(region.x, imageW);
  const ry = clampPositive(region.y, imageH);
  const rw = clampPositive(region.w, imageW - rx);
  const rh = clampPositive(region.h, imageH - ry);
  return { x: rx, y: ry, w: rw, h: rh };
}

/**
 * Write one decoded tile into outBuffer at its offset within viewport.
 * Replaces the parts[] "stitch all" signature (stream-stitch: on-arrival writes).
 * Fast-path stride-aligned kept; fallback row subarray. Indexed loops.
 */
export function stitch(
  outBuffer: Uint8Array,
  viewport: ImageRegion,
  tile: ImageRegion,
  decoded: DecodedLevel,
  bytesPerPixel: 4 | 8,
): void {
  // Bounds + exact byte length checks (as implemented for the crop case in stitchCropped).
  const expected = decoded.width * decoded.height * bytesPerPixel;
  if (decoded.pixels.byteLength !== expected) {
    throw new PyramidError('DECODER_OUTPUT_MISMATCH',
      `decoded tile bytes ${decoded.pixels.byteLength} != ${decoded.width}x${decoded.height}x${bytesPerPixel}`);
  }

  // Hoist (Grok4).
  const vw = viewport.w;
  const vx = viewport.x;
  const vy = viewport.y;
  const dx = tile.x - vx;
  const dy = tile.y - vy;

  if (dx < 0 || dy < 0 || dx + decoded.width > viewport.w || dy + decoded.height > viewport.h) {
    throw new PyramidError('STITCH_OOB',
      `dst ${decoded.width}x${decoded.height}@(${dx},${dy}) outside viewport ${viewport.w}x${viewport.h}`);
  }

  const dstStride = vw * bytesPerPixel;
  const srcStride = decoded.width * bytesPerPixel;
  if (decoded.width === vw && dx === 0 /* decoded.height + dy <= viewport.h guaranteed by STITCH_OOB guard above */) {
    // Fast path: stride-aligned full-width tile block at this y. The height bound is already enforced by the
    // STITCH_OOB throw immediately prior; omitting the redundant test here removes one branch per aligned tile write.
    outBuffer.set(decoded.pixels, dy * dstStride);
  } else {
    let srcOff = 0;
    let dstOff = (dy * vw + dx) * bytesPerPixel;
    for (let row = 0; row < decoded.height; row++) {
      outBuffer.set(decoded.pixels.subarray(srcOff, srcOff + srcStride), dstOff);
      srcOff += srcStride;
      dstOff += dstStride;
    }
  }
}

/**
 * Stitch a sub-rectangle of a decoded full tile into the viewport buffer.
 * srcRect is in image coordinates and must lie within the decoded tile; the decoded tile's
 * top-left in image coordinates is (srcOriginX, srcOriginY) with row stride decodedW·bpp.
 */
export function stitchCropped(
  outBuffer: Uint8Array,
  viewport: ImageRegion,
  srcRect: ImageRegion,
  decodedPixels: Uint8Array,
  decodedW: number,
  decodedH: number,
  srcOriginX: number,
  srcOriginY: number,
  bytesPerPixel: 4 | 8,
): void {
  const cropX = srcRect.x - srcOriginX, cropY = srcRect.y - srcOriginY;
  if (cropX < 0 || cropY < 0 || cropX + srcRect.w > decodedW || cropY + srcRect.h > decodedH) {
    throw new PyramidError('STITCH_OOB',
      `crop ${srcRect.w}x${srcRect.h}@(${cropX},${cropY}) outside decoded ${decodedW}x${decodedH}`);
  }
  const expected = decodedW * decodedH * bytesPerPixel;
  if (decodedPixels.byteLength !== expected) {
    throw new PyramidError('DECODER_OUTPUT_MISMATCH',
      `decoded tile bytes ${decodedPixels.byteLength} != ${decodedW}x${decodedH}x${bytesPerPixel}`);
  }
  const dx = srcRect.x - viewport.x, dy = srcRect.y - viewport.y;
  if (dx < 0 || dy < 0 || dx + srcRect.w > viewport.w || dy + srcRect.h > viewport.h) {
    throw new PyramidError('STITCH_OOB',
      `dst ${srcRect.w}x${srcRect.h}@(${dx},${dy}) outside viewport ${viewport.w}x${viewport.h}`);
  }
  const srcStride = decodedW * bytesPerPixel;
  const dstStride = viewport.w * bytesPerPixel;
  const rowBytes = srcRect.w * bytesPerPixel;
  let srcOff = (cropY * decodedW + cropX) * bytesPerPixel;
  let dstOff = (dy * viewport.w + dx) * bytesPerPixel;
  if (rowBytes === srcStride && rowBytes === dstStride) {        // full-width, both aligned
    outBuffer.set(decodedPixels.subarray(srcOff, srcOff + rowBytes * srcRect.h), dstOff);
    return;
  }
  for (let row = 0; row < srcRect.h; row++) {
    outBuffer.set(decodedPixels.subarray(srcOff, srcOff + rowBytes), dstOff);
    srcOff += srcStride;
    dstOff += dstStride;
  }
}

/** L10-R4: reverse-trust validation that decoder delivered the exact region/size/bpp requested.
 * Throws DECODER_OUTPUT_MISMATCH on dim or byteLength mismatch.
 */
export function validateDecodedOutput(decoded: DecodedLevel, expectedRegion: ImageRegion, bpp: 4 | 8): void {
  if (decoded.width !== expectedRegion.w || decoded.height !== expectedRegion.h) {
    throw new PyramidError('DECODER_OUTPUT_MISMATCH',
      `decoded size ${decoded.width}x${decoded.height} != expected ${expectedRegion.w}x${expectedRegion.h}`);
  }
  const expectedBytes = expectedRegion.w * expectedRegion.h * bpp;
  if (decoded.pixels.byteLength !== expectedBytes) {
    throw new PyramidError('DECODER_OUTPUT_MISMATCH',
      `decoded bytes ${decoded.pixels.byteLength} != ${expectedBytes} for region ${expectedRegion.w}x${expectedRegion.h}x${bpp}`);
  }
}

// Grok 3: minimal error taxonomy (full in Grok 5 errors.ts). Extended here per spec for lifecycle/cancellation.
export type PyramidErrorCode =
  | 'ABORTED'
  | 'POOL_DESTROYED'
  | 'FACTORY_CONFLICT'
  | 'TIMEOUT'
  | 'INVALID_REPLY'
  | 'EMPTY_LEVELS'
  | 'BAD_REGION'
  | 'JXTC_PARSE'
  | 'OOM'
  | 'INTERNAL'
  | 'INVALID_BUFFER_SIZE'
  | 'BUFFER_IN_USE'
  | 'BAD_MANIFEST'
  | 'INVALID_BUFFER_ALIGNMENT'
  | 'DECODER_OUTPUT_MISMATCH'
  | 'DIM_MISMATCH'
  | (string & {});

export class PyramidError extends Error {
  constructor(public code: PyramidErrorCode, message: string, public cause?: unknown) {
    super(message, { cause });
    this.name = 'PyramidError';
  }
}

/**
 * Race a promise against an AbortSignal.
 * - Cleans up listeners on either settlement.
 * - If abort wins, swallows rejection from p to prevent orphaned unhandled rejection.
 * - Pre-aborted signal: swallows p and rejects immediately.
 */
export function raceWithAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => {});
    const msg = typeof signal.reason === 'string' ? `decode aborted before start: ${signal.reason}` : 'decode aborted before start';
    return Promise.reject(new PyramidError('ABORTED', msg, signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      p.catch(() => {}); // prevent orphaned rejection from the raced promise
      const msg = typeof signal.reason === 'string' ? `decode aborted: ${signal.reason}` : 'decode aborted';
      reject(new PyramidError('ABORTED', msg, signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (val) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
}

/** F7: stable, immutable tile coordinate for cache keys, telemetry, multi-pass coordination. */
export interface TileId {
  level: number;
  col: number;
  row: number;
}

/** High-perf stable string key for a tile (used for LRU cache keys and logs). */
export function tileKey(tile: TileId): string {
  return `L${tile.level}-C${tile.col}-R${tile.row}`;
}

/** F7: canonical TileId for a (clipped) tile rect — col/row from grid origin. */
export function tileIdOf(rect: ImageRegion, tileSize: number, level: number): TileId {
  return { level, col: Math.floor(rect.x / tileSize), row: Math.floor(rect.y / tileSize) };
}

export const DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

/** Packed numeric tile key for hot maps: level ≤ 8190, col/row < 2^20 — keeps value < 2^53 (exact in IEEE double). */
export function tileKeyPacked(tile: TileId): number {
  // level ≤ 8190, col/row < 2^20 — documented bound tightened from <8192 because
  // 8191 * 2^40 + (2^20-1)*2^20 + (2^20-1) exceeds 2^53-1. Real pyramids use << 32 levels.
  // Dev guard (no prod cost) to catch contract violations early.
  if (DEV) {
    if (
      !Number.isInteger(tile.level) || tile.level > 8190 || tile.level < 0 ||
      !Number.isInteger(tile.col) || tile.col < 0 || tile.col >= (1 << 20) ||
      !Number.isInteger(tile.row) || tile.row < 0 || tile.row >= (1 << 20)
    ) {
      throw new PyramidError('BAD_REGION', `tileKeyPacked bounds violation: level=${tile.level} col=${tile.col} row=${tile.row} (level≤8190, col/row<2^20)`);
    }
  }
  return tile.level * 0x10000000000 + tile.row * 0x100000 + tile.col;
}

/** L1-3: stable viewport cache key (quality distinguishes dc/final for progressive). */
export function viewportCacheKey(
  levelId: string,
  vp: ImageRegion,
  format: PixelFormat,
  quality: 'dc' | 'final',
): string {
  return `${levelId}:${vp.x},${vp.y},${vp.w},${vp.h}:${format}:q${quality}`;
}

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
  // F2 note: outBuffer + onTile together enable Grok 4 stream-stitch (on-arrival writes into caller buffer,
  // no results[] retention, paint as tiles land, reuse buffer across pans for 60fps). See decodeTiledViewport + decodeTilesParallel.
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
  coreBudget?: { acquire(cost?: number): Promise<void>; release(cost?: number): void; tryAcquire(cost?: number): boolean; } | null;
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

/** Agent6-4: once-per-LevelSource lazy capture of ICC (and future metadata) using minimal header decoder + facade.getIccProfile.
 *  Caches on the source object (like bytesId). Shared reference stamped to results (no per-tile copies).
 *  Only runs if options.preserveMetadata. For JXTC the profile lives in the codestream(s); header target is cheap.
 */
const _iccCache = new WeakMap<object, Promise<Uint8Array | null>>();

export function ensureIccProfile(
  source: { bytes: Uint8Array },
  opts?: { preserveMetadata?: boolean },
): Promise<Uint8Array | null> {
  if (!opts?.preserveMetadata) return Promise.resolve(null);
  const cached = _iccCache.get(source);
  if (cached !== undefined) return cached;
  const p = (async () => {
    try {
      // Dynamic import avoids any potential cycle; facade has the getIccProfile (added for decode states).
      const wasm = await import("@casabio/jxl-wasm");
      const dec = wasm.createDecoder({
        format: 'rgba8',
        progressionTarget: 'header',
        emitEveryPass: false,
        preserveIcc: true,
        preserveMetadata: false,
      } as any);
      // Prefix is sufficient for header + color profile (libjxl emits early).
      const prefixLen = Math.min(256 * 1024, source.bytes.length);
      await dec.push(source.bytes.subarray(0, prefixLen));
      await dec.close();
      let icc = (dec as any).getIccProfile ? (dec as any).getIccProfile() : null;
      if (icc) icc = new Uint8Array(icc); // own the bytes
      await Promise.resolve((dec as any).dispose()).catch(() => {});
      return icc || null;
    } catch (err) {
      console.error('ensureIccProfile failed:', err);
      return null;
    }
  })();
  _iccCache.set(source, p);
  return p;
}

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
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (ev: { data?: any }) => void,
  ): void;
  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener: (ev: { data?: any }) => void,
  ): void;
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
  acquire(count: number, opts?: { maxWaitMs?: number }): Promise<any[]>;
  release(handles: any[]): void;
  /** Load container bytes into the acquired handles once per bytesId (SAB carrier when useSAB). */
  ensureLoaded(handles: any[], bytesId: number, bytes: Uint8Array, useSAB: boolean): void;
  // `| undefined` is explicit so a concrete pool whose getter returns `number | undefined`
  // (PyramidWorkerPool.requestTimeout) satisfies this under exactOptionalPropertyTypes.
  readonly requestTimeout?: number | undefined;
  // Lifecycle surface for holders that manage the pool outside a single decode call.
  destroy?(graceMs?: number): Promise<void> | void;
  readonly destroyed?: boolean | undefined;
  readonly poolState?: string | undefined;
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

export function cacheStore(cache: PyramidCache | undefined, key: string | undefined, pixels: Uint8Array, need: number): void {
  if (!cache || !key) return;
  const cap = cache.capacityBytes;
  if (cap !== undefined && need > cap) return;
  cache.set(key, pixels.byteLength === need ? pixels : pixels.slice(0, need));
}

/**
 * The one named tiled-decode strategy the single planner (decode-level.ts) dispatches on.
 *
 *   'worker-pool'        — parallel per-tile decode across the injected/owned pool
 *                          (decodeTiledViewportPooled); handles dc-then-final + one-shot final.
 *   'progressive-direct' — inline dc-then-final / dc-only / skip-tile / resume per-tile loop on the
 *                          main thread (no pool); the only path that implements dc-only, skip-tile,
 *                          and skipTiles resume.
 *   'direct'             — single libjxl ROI decode of the whole viewport in one WASM call.
 */
export type TileDecodeStrategy = 'worker-pool' | 'progressive-direct' | 'direct';

/**
 * Pure pool-strategy hook: pick exactly one tiled-decode strategy from tile count, environment
 * worker-availability, and caller options. This centralises the dispatch that was previously three
 * overlapping booleans in decode-level.ts (finding 77) — decode-level now dispatches on the single
 * value this returns. Kept in decode-core (the primitives/types root) so both the planner and tests
 * consume the same decision without a cycle.
 *
 * Behaviour is identical to the prior inline logic:
 *  - worker-pool requires >1 tile, a worker environment, a pool/factory, parallel !== false, and a
 *    progressive mode the pool implements (undefined | 'dc-then-final'); never with a custom
 *    decodeRegion, skip-tile policy, or a skipTiles resume-set (the pool fails the batch on those).
 *  - progressive-direct covers 'dc-then-final' / 'dc-only' (and skip-tile / skipTiles, which force the
 *    inline loop) whenever worker-pool was not selected, provided no custom decodeRegion is supplied.
 *  - direct otherwise (single ROI decode, incl. the mock/decodeRegion path).
 */
export function selectTileDecodeStrategy(args: {
  numTiles: number;
  envCanParallel: boolean;
  options: DecodeOptions | undefined;
}): TileDecodeStrategy {
  const { numTiles, envCanParallel, options } = args;
  const progressive = options?.progressive;
  const hasCustomDecodeRegion = !!options?.decodeRegion;
  const wantsInlineOnly = options?.errorPolicy === 'skip-tile' || !!options?.skipTiles;

  const parallelEligible =
    !hasCustomDecodeRegion &&
    shouldUseParallel(options, numTiles, envCanParallel) &&
    !wantsInlineOnly;

  if (parallelEligible && (progressive === 'dc-then-final' || progressive === undefined)) {
    return 'worker-pool';
  }
  if ((progressive === 'dc-then-final' || progressive === 'dc-only') && !hasCustomDecodeRegion) {
    return 'progressive-direct';
  }
  return 'direct';
}

/**
 * Local mirror of tiled-decode-pool's shouldUseParallel so the strategy hook stays in decode-core
 * (the types root) without importing tiled-decode-pool (which imports decode-core — a cycle).
 * The concrete pool exports its own identical predicate for its internal decision.
 */
function shouldUseParallel(
  opts: { parallel?: boolean; workerFactory?: unknown; pool?: unknown } | undefined,
  numTiles: number,
  envCanParallel: boolean,
): boolean {
  return (opts?.parallel !== false) && envCanParallel && numTiles > 1 && !!(opts?.workerFactory || opts?.pool);
}

export function sortCenterOut<T>(
  items: T[],
  viewport: ImageRegion,
  getRect: (item: T) => ImageRegion,
): T[] {
  const cx = viewport.x + viewport.w / 2;
  const cy = viewport.y + viewport.h / 2;
  return items.slice().sort((a, b) => {
    const ra = getRect(a), rb = getRect(b);
    const da = (ra.x + ra.w / 2 - cx) ** 2 + (ra.y + ra.h / 2 - cy) ** 2;
    const db = (rb.x + rb.w / 2 - cx) ** 2 + (rb.y + rb.h / 2 - cy) ** 2;
    return da - db;
  });
}
