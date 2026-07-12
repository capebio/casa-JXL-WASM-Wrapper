import { createDecoder } from "@casabio/jxl-wasm";
import type { ImageRegion, JxtcHeader as TilingJxtcHeader } from "./tiling.js";
import { extractTileBitstream, canUseParallelTileWorkers } from "./tiling.js";
import type { LevelSource } from "./level-source.js";
import {
  WHOLE_DECODE_OPTS,
  stitch,
  type RegionDecoder,
  type DecodedLevel,
  PyramidError,
  type DecodeOptions,
  stitchCropped,
  assertFiniteRegion,
  snapRegionToIntegers,
  type DecoderInit,
  type PixelFormat,
  formatFromBits,
  bppOfFormat,
  viewportCacheKey,
  tileIdOf,
  tileKey,
  tileKeyPacked,
  type TileProgress,
  validateDecodedOutput,
  type TileId,
  raceWithAbort,
  ensureIccProfile,
  buffersInFlight,
  cacheStore,
  clampRegion,
  selectTileDecodeStrategy,
} from "./decode-core.js";
import { prepareDecodePlan } from "./plan.js";
import { getLevelId, makeTileCacheKey, type PyramidCache } from "./cache.js";
import { decodeTiledViewportPooled } from "./tiled-decode-pool.js";

export type { DecodedLevel, RegionDecoder, DecodeOptions, ProgressiveMode, WorkerLike, DecoderInit, PixelFormat, TileProgress } from "./decode-core.js";
export { PyramidError, formatFromBits, bppOfFormat, viewportCacheKey, tileIdOf, tileKey, tileKeyPacked } from "./decode-core.js";

function stitchTileIntoViewport(
  outBuffer: Uint8Array,
  viewport: ImageRegion,
  tile: ImageRegion,
  decodedPixels: Uint8Array,
  source: Extract<LevelSource, { kind: "tiled" }>,
  bpp: 4 | 8,
): void {
  const tileSize = source.tileSize;
  const tx = Math.floor(tile.x / tileSize);
  const ty = Math.floor(tile.y / tileSize);
  const srcOriginX = tx * tileSize;
  const srcOriginY = ty * tileSize;
  const decodedW = Math.min(tileSize, source.width - srcOriginX);
  const decodedH = Math.min(tileSize, source.height - srcOriginY);

  stitchCropped(
    outBuffer,
    viewport,
    tile,
    decodedPixels,
    decodedW,
    decodedH,
    srcOriginX,
    srcOriginY,
    bpp,
  );
}

/** Zero a rectangular sub-region inside the viewport outBuffer (used for skip-tile error policy). */
function zeroFillRect(
  outBuffer: Uint8Array,
  viewport: ImageRegion,
  rect: ImageRegion,
  bpp: 4 | 8,
): void {
  const dx = rect.x - viewport.x;
  const dy = rect.y - viewport.y;
  if (dx < 0 || dy < 0 || dx + rect.w > viewport.w || dy + rect.h > viewport.h) return; // defensive
  const stride = viewport.w * bpp;
  const rowBytes = rect.w * bpp;
  let off = (dy * viewport.w + dx) * bpp;
  for (let r = 0; r < rect.h; r++) {
    outBuffer.fill(0, off, off + rowBytes);
    off += stride;
  }
}

/** Bounded concurrency utility for fallback paths */
async function runWithBoundedConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const currIndex = index++;
      await fn(items[currIndex]!, currIndex);
    }
  });
  await Promise.all(workers);
}

/**
 * Decode a rectangular viewport from a tiled JXTC level.
 * Uses per-tile parallel decode when workers + COOP/COEP are available; otherwise one WASM call.
 */
export async function decodeTiledViewport(
  source: Extract<LevelSource, { kind: "tiled" }>,
  region: ImageRegion,
  options?: DecodeOptions,
): Promise<DecodedLevel> {
  const signal = options?.signal;
  if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted before start');
  // L18-2: hand-built tiled sources (bypassing createLevelSource/parseJxtcHeader) must still be sane.
  if (!Number.isInteger(source.tileSize) || source.tileSize <= 0 ||
      !Number.isInteger(source.width) || source.width <= 0 ||
      !Number.isInteger(source.height) || source.height <= 0) {
    throw new PyramidError('BAD_MANIFEST', 'tiled source tileSize/width/height must be positive integers');
  }
  assertFiniteRegion(region);
  const snappedRegion = snapRegionToIntegers(region);
  let plan: ReturnType<typeof prepareDecodePlan>;
  try {
    plan = prepareDecodePlan(source, snappedRegion);
  } catch (e) {
    if (e instanceof PyramidError) throw e;
    throw new PyramidError('BAD_REGION', 'degenerate region after prepare', e);
  }
  const decodeRegion = options?.decodeRegion ?? plan.decodeRegion;
  const vp = plan.viewport;
  const bpp = plan.bpp;
  const need = vp.w * vp.h * bpp;

  // ONE named strategy decision drives dispatch (finding 77): the single planner picks
  // worker-pool / progressive-direct / direct up front, above outBuffer registration (P1-A fix),
  // instead of re-deriving overlapping booleans. The 'worker-pool' strategy is the injected pool
  // primitive; the other two run on this thread below.
  const progressive = options?.progressive;
  const strategy = selectTileDecodeStrategy({
    numTiles: plan.tiles.length,
    envCanParallel: canUseParallelTileWorkers(),
    options,
  });
  if (strategy === 'worker-pool') {
    return decodeTiledViewportPooled(source, snappedRegion, options);
  }

  // Cache + outBuffer + onTile for direct (non-pooled) path.
  const cache = options?.cache;
  const outBuf = options?.outBuffer;
  const zeroCopyHits = !!options?.zeroCopyCacheHits;

  if (outBuf) {
    if (outBuf.byteLength < need) throw new PyramidError('INVALID_BUFFER_SIZE', `outBuffer too small (${outBuf.byteLength} < ${need})`);
    if (buffersInFlight.has(outBuf)) throw new PyramidError('BUFFER_IN_USE', 'outBuffer is already in use by another decode');
    buffersInFlight.add(outBuf);
    // L5-2: 16-bit (bpp=8) requires even offset for safe Uint16Array(underlying, byteOffset) views downstream.
    if (plan.bpp === 8 && (outBuf.byteOffset % 2) !== 0) {
      throw new PyramidError('INVALID_BUFFER_ALIGNMENT', 'outBuffer.byteOffset must be even for 16-bit (bpp=8) pixels');
    }
  }

  try {
    const cacheQuality = progressive === 'dc-only' ? 'dc' : 'final';
    const cacheKey = cache ? viewportCacheKey(getLevelId(source), vp, plan.format, cacheQuality) : undefined;
    if (cache && cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached) {
        if (outBuf) {
          if (cached.length >= need) {
            outBuf.set(cached.subarray(0, need));
            return { pixels: outBuf.byteLength === need ? outBuf : outBuf.subarray(0, need), width: vp.w, height: vp.h, format: plan.format };
          }
        } else {
          const pixels = zeroCopyHits ? cached : new Uint8Array(cached);
          return { pixels, width: vp.w, height: vp.h, format: plan.format };
        }
      }
    }

    const onTile = options?.onTile;

    // L20-1/L20-2/L4-4: policy, budget, resume support (scoped to progressive per-tile direct path).
    const errorPolicy = options?.errorPolicy ?? 'fail-fast';
    const budgetMs = options?.budgetMs;
    const skipTiles = options?.skipTiles;
    const startMs = budgetMs != null ? performance.now() : 0;
    const deadline = budgetMs != null ? startMs + budgetMs : null;

    let target: Uint8Array | undefined;
    // Progressive DC-then-final (F1 + L3-1): Phase 1 all DC, Phase 2 all final.
    // Delivers onTile twice per tile (DC first for full coarse paint, then final). Stream-stitch friendly.
    // Selected as 'progressive-direct' by the single strategy decision (dc-then-final / dc-only /
    // skip-tile / resume, without a custom decodeRegion).
    if (strategy === 'progressive-direct') {
      target = outBuf ? outBuf : new Uint8Array(need);
      let completed = 0;
      const tilesX = Math.ceil(source.width / source.tileSize);
      const tilesY = Math.ceil(source.height / source.tileSize);
      const exHeader: TilingJxtcHeader = {
        imageW: source.width,
        imageH: source.height,
        tileSize: source.tileSize,
        tilesX,
        tilesY,
        hasAlpha: true, // Provably insensitive: extractTileBitstream does not utilize hasAlpha
        bitsPerSample: source.bitsPerSample,
        version: (source as any).version ?? 1,
      };
      const n = plan.tiles.length;
      const total = progressive === 'dc-only' ? n : n * 2;
      const tileSize = source.tileSize;
      const cx = vp.x + vp.w / 2;
      const cy = vp.y + vp.h / 2;
      const levelId = getLevelId(source);
      const tilesWithBytes = plan.tiles.map((t, idx) => {
        const tx = Math.floor(t.x / tileSize);
        const ty = Math.floor(t.y / tileSize);
        const dist = (t.x + t.w / 2 - cx) ** 2 + (t.y + t.h / 2 - cy) ** 2;
        const id = tileIdOf(t, source.tileSize, source.level ?? 0);
        return {
          tile: t,
          bytes: extractTileBitstream(source.bytes, t, exHeader),
          idx,
          tileGeom: { tx, ty, srcOriginX: tx * tileSize, srcOriginY: ty * tileSize },
          dist,
          id,
          dcKey: `${makeTileCacheKey(levelId, id)}:${plan.format}:dc`,
          finalKey: `${makeTileCacheKey(levelId, id)}:${plan.format}:final`
        };
      });

      // DL-8 (UX/AR/gaming, medium): center-out tile ordering.
      const ordered = tilesWithBytes.slice().sort((a, b) => a.dist - b.dist);

      let deadlineHit = false;
      const stitchedFinal = new Set<string>();
      const failedTileKeys = new Set<string>();

      // Phase 1: all DC (coarse first paint for entire viewport) with bounded fallback concurrency DL-7(b)
      await runWithBoundedConcurrency(ordered, 3, async (item) => {
        if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted');
        if (deadlineHit) return;
        if (deadline != null && performance.now() > deadline) {
          if (errorPolicy === 'skip-tile') {
            deadlineHit = true;
            return;
          }
          throw new PyramidError('TIMEOUT', 'budgetMs deadline exceeded during progressive decode');
        }
        const t = item.tile;
        const { id, dcKey, finalKey } = item;
        const key = tileKey(id);
        if (skipTiles?.has(key)) {
          completed += 1;
          const prog: TileProgress = { id, key, stage: 'dc', completed, total };
          onTile?.(t, completed, prog);
          return;
        }

        const { srcOriginX, srcOriginY } = item.tileGeom;
        const decodedW = Math.min(tileSize, source.width - srcOriginX);
        const decodedH = Math.min(tileSize, source.height - srcOriginY);
        const expectedLen = decodedW * decodedH * plan.bpp;

        // Check for final cache hit first to skip DC phase
        const finalHit = cache?.get(finalKey);
        if (finalHit && finalHit.byteLength === expectedLen) {
          stitchTileIntoViewport(target!, vp, t, finalHit, source, plan.bpp);
          stitchedFinal.add(key);
          completed += 1;
          const prog: TileProgress = { id, key, stage: 'dc', completed, total };
          onTile?.(t, completed, prog);
          return;
        }

        // Check for DC cache hit
        if (options?.cacheDcTiles) {
          const dcHit = cache?.get(dcKey);
          if (dcHit && dcHit.byteLength === expectedLen) {
            stitchTileIntoViewport(target!, vp, t, dcHit, source, plan.bpp);
            completed += 1;
            const prog: TileProgress = { id, key, stage: 'dc', completed, total };
            onTile?.(t, completed, prog);
            return;
          }
        }

        try {
          const t0 = performance.now();
          const dcPixels = await decodeTileBytesProgressive(item.bytes, plan.format, 'dc');
          const decodeMs = performance.now() - t0;
          if (options?.cacheDcTiles && cache) {
            const cap = cache.capacityBytes;
            if (cap === undefined || dcPixels.byteLength <= cap) {
              cache.set(dcKey, dcPixels);
            }
          }
          stitchTileIntoViewport(target!, vp, t, dcPixels, source, plan.bpp);
          completed += 1;
          const prog: TileProgress = { id, key, stage: 'dc', completed, total, decodeMs, bytesDecoded: item.bytes.byteLength };
          onTile?.(t, completed, prog);
        } catch (e) {
          if (errorPolicy === 'skip-tile') {
            zeroFillRect(target!, vp, t, plan.bpp);
            failedTileKeys.add(key);
            completed += 1;
            const prog: TileProgress = { id, key, stage: 'dc', completed, total };
            onTile?.(t, completed, prog);
            return;
          }
          if (e instanceof PyramidError) throw e;
          throw new PyramidError('JXTC_PARSE', `tile progressive dc: ${e instanceof Error ? e.message : String(e)}`, e);
        }
      });

      if (progressive !== 'dc-only') {
        // Phase 2: all final (refine) with bounded fallback concurrency DL-7(b)
        await runWithBoundedConcurrency(ordered, 3, async (item) => {
          if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted');
          if (deadlineHit) return;
          if (deadline != null && performance.now() > deadline) {
            if (errorPolicy === 'skip-tile') {
              deadlineHit = true;
              return;
            }
            throw new PyramidError('TIMEOUT', 'budgetMs deadline exceeded during progressive decode');
          }
          const t = item.tile;
          const { id, finalKey } = item;
          const key = tileKey(id);
          if (skipTiles?.has(key)) {
            completed += 1;
            const prog: TileProgress = { id, key, stage: 'final', completed, total };
            onTile?.(t, completed, prog);
            return;
          }

          if (stitchedFinal.has(key)) {
            completed += 1;
            const prog: TileProgress = { id, key, stage: 'final', completed, total };
            onTile?.(t, completed, prog);
            return;
          }

          const { srcOriginX, srcOriginY } = item.tileGeom;
          const decodedW = Math.min(tileSize, source.width - srcOriginX);
          const decodedH = Math.min(tileSize, source.height - srcOriginY);
          const expectedLen = decodedW * decodedH * plan.bpp;

          // Check for final cache hit
          const finalHit = cache?.get(finalKey);
          if (finalHit && finalHit.byteLength === expectedLen) {
            stitchTileIntoViewport(target!, vp, t, finalHit, source, plan.bpp);
            stitchedFinal.add(key);
            completed += 1;
            const prog: TileProgress = { id, key, stage: 'final', completed, total };
            onTile?.(t, completed, prog);
            return;
          }

          try {
            const t0 = performance.now();
            const finalPixels = await decodeTileBytesProgressive(item.bytes, plan.format, 'final');
            const decodeMs = performance.now() - t0;
            if (cache) {
              const cap = cache.capacityBytes;
              if (cap === undefined || finalPixels.byteLength <= cap) {
                cache.set(finalKey, finalPixels);
              }
            }
            stitchTileIntoViewport(target!, vp, t, finalPixels, source, plan.bpp);
            stitchedFinal.add(key);
            completed += 1;
            const prog: TileProgress = { id, key, stage: 'final', completed, total, decodeMs, bytesDecoded: item.bytes.byteLength };
            onTile?.(t, completed, prog);
          } catch (e) {
            if (errorPolicy === 'skip-tile') {
              zeroFillRect(target!, vp, t, plan.bpp);
              failedTileKeys.add(key);
              completed += 1;
              const prog: TileProgress = { id, key, stage: 'final', completed, total };
              onTile?.(t, completed, prog);
              return;
            }
            if (e instanceof PyramidError) throw e;
            throw new PyramidError('JXTC_PARSE', `tile progressive final: ${e instanceof Error ? e.message : String(e)}`, e);
          }
        });
      }

      // DL-1 (bug, high): budget-break / skipTiles can cache an incomplete viewport as 'final'.
      if (deadlineHit) {
        for (let i = 0; i < n; i++) {
          const t = plan.tiles[i]!;
          const id = tileIdOf(t, source.tileSize, source.level ?? 0);
          const k = tileKey(id);
          if (!stitchedFinal.has(k)) {
            failedTileKeys.add(k);
          }
        }
      }

      const pixels = target!.byteLength === need ? target! : target!.subarray(0, need);
      const result: DecodedLevel = { pixels, width: vp.w, height: vp.h, format: plan.format };
      if (failedTileKeys.size > 0) {
        const failedIds: TileId[] = [];
        for (const item of tilesWithBytes) {
          if (failedTileKeys.has(tileKey(item.id))) {
            failedIds.push(item.id);
          }
        }
        result.failedTiles = failedIds;
      }

      const complete = !deadlineHit && failedTileKeys.size === 0 && !(skipTiles && skipTiles.size > 0);
      if (complete) {
        cacheStore(cache, cacheKey, target!, need);
      }

      // Agent6-4: attach ICC (shared ref) if requested. ensure is lazy + cached on source.
      if (options?.preserveMetadata) {
        const icc = await ensureIccProfile(source, options);
        if (icc) result.iccProfile = icc;
      }
      return result;
    }

    // Non-pooled direct (libjxl ROI handles tiles internally). L3-3 zero-copy when no outBuffer.
    // Signal checked at entry; in-flight best-effort (WASM not cancellable mid-call).
    // For fanout coroutine pattern see pooled path (decodeTilesParallel).
    const p = decodeRegion(source.bytes, vp);
    const direct: DecodedLevel = signal
      ? await raceWithAbort(p, signal)
      : await p;

    // L10-R4: reverse trust — decoder must have returned exactly the requested viewport region.
    validateDecodedOutput(direct, vp, bpp);
    let pixels: Uint8Array;
    if (outBuf) {
      outBuf.set(direct.pixels);
      pixels = outBuf.byteLength === need ? outBuf : outBuf.subarray(0, need);
    } else {
      pixels = direct.pixels; // zero-copy handoff (L3-3)
    }
    const result: DecodedLevel = { pixels, width: vp.w, height: vp.h, format: plan.format };
    
    // DL-9 / DL-5: Uses extracted local cacheStore helper
    cacheStore(cache, cacheKey, pixels, need);

    const dirId = tileIdOf(vp, source.tileSize, 0);
    const dirKey = tileKey(dirId);
    const dirProg: TileProgress = { id: dirId, key: dirKey, stage: 'final', completed: 1, total: 1 };
    onTile?.(vp, 1, dirProg);
    // Agent6-4
    if (options?.preserveMetadata) {
      const icc = await ensureIccProfile(source, options);
      if (icc) result.iccProfile = icc;
    }
    return result;
  } finally {
    if (outBuf) buffersInFlight.delete(outBuf);
  }
}

/** Small helper: drive createDecoder on a standalone tile bitstream (from JXTC extract) for one stage. */
async function decodeTileBytesProgressive(
  tileBytes: Uint8Array,
  format: PixelFormat,
  stage: 'dc' | 'final',
): Promise<Uint8Array> {
  const decoder = createDecoder({
    format,
    progressionTarget: stage === 'dc' ? 'dc' : 'final',
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
  } as DecoderInit);
  const drainOutcome = (async (): Promise<{ ok: true; px: Uint8Array } | { ok: false; err: unknown }> => {
    for await (const ev of decoder.events()) {
      if (ev.type === 'final' || ev.type === 'progress' || (ev as any).type === 'preview') {
        const p = (ev as any).pixels;
        if (p) {
          const px = p instanceof Uint8Array ? p : new Uint8Array(p);
          // For dc target we accept first progress with pixels; for final the final event.
          if (stage === 'final' && ev.type === 'final') return { ok: true, px };
          if (stage === 'dc') return { ok: true, px };
        }
      }
      if (ev.type === 'error') {
        return { ok: false, err: new PyramidError('JXTC_PARSE', `tile progressive ${stage}: ${ev.message}`) };
      }
    }
    return { ok: false, err: new PyramidError('INTERNAL', `tile progressive ${stage} produced no pixels`) };
  })();
  try {
    await decoder.push(tileBytes);
    await decoder.close();
    const out = await drainOutcome;
    if (!out.ok) throw out.err;
    return out.px;
  } finally {
    await drainOutcome.catch(() => {});
    await Promise.resolve(decoder.dispose()).catch(() => {});
  }
}

/** Decode a pyramid level: whole-frame in one shot, or a viewport slice from JXTC. */
export async function decodeLevel(
  source: LevelSource,
  region?: ImageRegion,
  options?: DecodeOptions,
): Promise<DecodedLevel> {
  const signal = options?.signal;
  if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted before start');
  if (source.kind === "whole") {
    if (region !== undefined) {
      throw new PyramidError('BAD_REGION', 'region decode requires a tiled level source');
    }
    return decodeWhole(source.bytes, source.format, options, source);
  }
  if (region === undefined) {
    throw new PyramidError('BAD_REGION', 'tiled level decode requires explicit region (use decodeLevel(source, region) or full viewport region)');
  }
  return decodeTiledViewport(source, region, options);
}

async function decodeWhole(
  bytes: Uint8Array,
  format: PixelFormat,
  options?: DecodeOptions,
  nominalSource?: LevelSource & { width: number; height: number },
): Promise<DecodedLevel> {
  const signal = options?.signal;
  if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted before start');

  const cache = options?.cache;
  const outBuf = options?.outBuffer;
  const bpp = bppOfFormat(format);

  // For whole we use nominal dims (from LevelSource) for cache key / outBuffer sizing / validation when available.
  const nomW = (nominalSource as any)?.width as number | undefined;
  const nomH = (nominalSource as any)?.height as number | undefined;
  const haveNominal = Number.isFinite(nomW) && Number.isFinite(nomH) && (nomW as number) > 0 && (nomH as number) > 0;

  if (outBuf) {
    if (haveNominal) {
      const need = (nomW as number) * (nomH as number) * bpp;
      if (outBuf.byteLength < need) throw new PyramidError('INVALID_BUFFER_SIZE', `outBuffer too small (${outBuf.byteLength} < ${need})`);
    }
    if (buffersInFlight.has(outBuf)) {
      throw new PyramidError('BUFFER_IN_USE', 'outBuffer is already in use by another decode');
    }
    if (bpp === 8 && (outBuf.byteOffset % 2) !== 0) {
      throw new PyramidError('INVALID_BUFFER_ALIGNMENT', 'outBuffer.byteOffset must be even for 16-bit (bpp=8) pixels');
    }
    buffersInFlight.add(outBuf);
  }

  try {
    // DL-2 (bug, high): decodeWhole cache hit returns the cache-owned buffer zero-copy, unconditionally.
    // DL-2 outBuf hit path: treat cached.length < need as a cache miss.
    if (cache && haveNominal) {
      const key = `${getLevelId(bytes)}-${nomW}x${nomH}-${format}-whole`;
      const cached = cache.get(key);
      if (cached) {
        const need = (nomW as number) * (nomH as number) * bpp;
        if (outBuf) {
          if (cached.length >= need) {
            outBuf.set(cached.subarray(0, need));
            return { pixels: outBuf.byteLength === need ? outBuf : outBuf.subarray(0, need), width: nomW as number, height: nomH as number, format };
          }
        } else {
          const pixels = options?.zeroCopyCacheHits ? cached : new Uint8Array(cached);
          return { pixels, width: nomW as number, height: nomH as number, format };
        }
      }
    }

    const decoder = createDecoder({ ...WHOLE_DECODE_OPTS, format } as DecoderInit);
    const drainOutcome = (async (): Promise<
      { ok: true; res: DecodedLevel } | { ok: false; err: unknown }
    > => {
      for await (const ev of decoder.events()) {
        if (ev.type === "final") {
          const px = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
          return { ok: true, res: { pixels: px, width: ev.info.width, height: ev.info.height, format } };
        } else if (ev.type === "error") {
          return { ok: false, err: new PyramidError('JXTC_PARSE', `decode ${ev.code}: ${ev.message}`) };
        }
      }
      return { ok: false, err: new PyramidError('INTERNAL', 'whole-frame decode produced no final frame') };
    })();
    try {
      await decoder.push(bytes);
      await decoder.close();
      // DL-6 (robustness, low): decodeWhole ignores signal after start. Wrap the drain with raceWithAbort helper.
      const out = signal ? await raceWithAbort(drainOutcome, signal) : await drainOutcome;
      if (!out.ok) throw out.err;
      let res = out.res;

      // L10-R4: validate decoder output against nominal (if known) or self-reported size.
      if (haveNominal) {
        validateDecodedOutput(res, { x: 0, y: 0, w: nomW as number, h: nomH as number }, bpp);
      } else {
        const expectedBytes = res.width * res.height * bpp;
        if (res.pixels.byteLength !== expectedBytes) {
          throw new PyramidError('DECODER_OUTPUT_MISMATCH', `whole decoded bytes ${res.pixels.byteLength} != ${expectedBytes}`);
        }
      }

      // DL-3 (bug, medium): decodeWhole outBuf path returns the whole outBuf, not subarray(0, need).
      if (outBuf) {
        const need = res.width * res.height * bpp;
        if (outBuf.byteLength < need) throw new PyramidError('INVALID_BUFFER_SIZE', `outBuffer too small (${outBuf.byteLength} < ${need})`);
        outBuf.set(res.pixels);
        res = { pixels: outBuf.byteLength === need ? outBuf : outBuf.subarray(0, need), width: res.width, height: res.height, format };
      }

      // DL-9 / DL-5: Uses extracted local cacheStore helper
      if (cache) {
        const w = haveNominal ? (nomW as number) : res.width;
        const h = haveNominal ? (nomH as number) : res.height;
        const key = `${getLevelId(bytes)}-${w}x${h}-${format}-whole`;
        const sz = w * h * bpp;
        cacheStore(cache, key, res.pixels, sz);
      }

      // Agent6-4
      if (options?.preserveMetadata) {
        const icc = await ensureIccProfile(nominalSource || { kind: 'whole', bytes, width: res.width, height: res.height, bitsPerSample: format === 'rgba16' ? 16 : 8, format, bpp } as any, options);
        if (icc) (res as any).iccProfile = icc;
      }

      return res;
    } finally {
      await Promise.resolve(decoder.dispose()).catch(() => {});
    }
  } finally {
    if (outBuf) {
      buffersInFlight.delete(outBuf);
    }
  }
}

/** Pure helper: extrapolate the viewport along its velocity. leadMs ~ one decode round-trip. */
export function predictRegion(vp: ImageRegion, velXPxPerMs: number, velYPxPerMs: number, leadMs: number): ImageRegion {
  return { x: vp.x + velXPxPerMs * leadMs, y: vp.y + velYPxPerMs * leadMs, w: vp.w, h: vp.h };
}

/** Warm the tile cache for a (predicted) region. Never throws; resolves when done or aborted. */
export async function prefetchViewport(
  source: Extract<LevelSource, { kind: "tiled" }>,
  region: ImageRegion,
  options: Pick<DecodeOptions, 'cache' | 'signal' | 'workerFactory' | 'pool' | 'parallel' | 'coreBudget' | 'cacheDcTiles'>,
): Promise<void> {
  if (!options.cache) return;
  try {
    const clamped = clampRegion(region, source.width, source.height);
    const { progressive, ...rest } = options as any;
    await decodeTiledViewport(source, clamped, { ...rest, errorPolicy: 'skip-tile' });
  } catch {
    // prefetch is best-effort by definition
  }
}
