// lod-resolver.ts
// Packet 2, Task 6 (findings 2, 26): ONE gallery-facing LOD resolver.
//
// Finding 26: the LOD selection ("smallest level whose long edge >= target") was duplicated
// across the grid controller and the lightbox (each wrapping `chooseLevelForTarget` with its
// own dpr/zoom arithmetic). This module is the single place that maps a demand descriptor to a
// concrete unit of delivery, so every consumer routes selection through it.
//
// It consumes the interfaces the runtime PINS (`LodRequest`, `DecodeCapabilities` from
// runtime.ts) plus the pyramid manifest, and produces a discriminated `LodResolution` naming
// one of THREE delivery kinds:
//   - "whole-level"        — download the whole level bitstream `[0, bytes)` and decode it.
//   - "jxtc-ranges"        — the level is a JXTC tile container and a spatial region was asked:
//                            deliver only the overlapping tiles by HTTP Range (one range/tile).
//   - "progressive-prefix" — the level carries an encode-time quality curve and a byte prefix
//                            meets the requested quality: deliver `[0, byteEnd)` by Range and
//                            decode the progressive prefix.
//
// The RESOLUTION axis reuses the shared `chooseLevelForTarget` (finding 26 — one selector). The
// byte-range mathematics for the region axis mirrors the JXTC absolute-offset contract
// (tiling.ts / getOrParseJxtcTileIndex, finding 60) and the S6 unified resolver in
// @casabio/jxl-progressive; the actual queue/fetch is NOT recreated here — the web consumers
// reuse jxl-progressive's `fetchTier`/`fromRangePrefix` for the progressive-prefix path and the
// pyramid runtime's tiled pool for the jxtc-ranges path (finding 2).
//
// Pure + dependency-free (structural interfaces only) so it runs under `bun test`.

import type { PyramidManifest, PyramidLevel } from "./manifest.js";
import { pickByteEndForQuality, type QualityTarget } from "./manifest.js";
import { chooseLevelForTarget } from "./choose-level.js";
import type { LodRequest, DecodeCapabilities } from "./runtime.js";

/** A half-open byte interval `[start, end)`; `end` is EXCLUSIVE (matches manifest `byteEnd`). */
export interface ByteRange {
  start: number;
  end: number;
}

/** Format a byte range as an HTTP `Range` header value (inclusive both ends). */
export function toHttpRange(range: ByteRange): string {
  return `bytes=${range.start}-${range.end - 1}`;
}

/** One image-space tile rectangle addressed by a jxtc range. */
export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The parsed JXTC tile index + grid for one tiled level. Offsets are ABSOLUTE byte offsets from
 * byte 0 of the file (finding 60 — no rebasing), exactly as produced by
 * `getOrParseJxtcTileIndex`. Callers supply this (they hold the container header/bytes); the
 * resolver stays pure and does not parse containers itself.
 */
export interface JxtcTileGrid {
  offsets: ArrayLike<number>;
  lengths: ArrayLike<number>;
  tileSize: number;
  tilesX: number;
  tilesY: number;
  imageW: number;
  imageH: number;
}

/** Extra data the resolver needs but cannot derive from the manifest alone. */
export interface ResolveExtras {
  /** Parsed JXTC tile grids, keyed by level contenthash. Required to emit `jxtc-ranges`. */
  tileIndex?: Record<string, JxtcTileGrid>;
  /** Quality thresholds for the progressive-prefix axis. Default: use the level's convergedByteEnd. */
  qualityTarget?: QualityTarget;
}

/** Deliver the whole level bitstream and decode it. */
export interface WholeLevelResolution {
  kind: "whole-level";
  level: PyramidLevel;
  contenthash: string;
  bytes: number;
  /** `[0, bytes)` — the full level. */
  range: ByteRange;
  width: number;
  height: number;
  /** True when the level is a JXTC tile container decoded as a whole (region unavailable/unsupported). */
  tiled: boolean;
}

/** Deliver only the JXTC tiles overlapping the requested region, by HTTP Range. */
export interface JxtcRangesResolution {
  kind: "jxtc-ranges";
  level: PyramidLevel;
  contenthash: string;
  /** One byte range per overlapping tile (absolute file offsets). */
  ranges: ByteRange[];
  /** The image-space rectangle covered by each range (same order as `ranges`). */
  tiles: TileRect[];
  /** The clamped region in level pixel coordinates. */
  region: TileRect;
  width: number;
  height: number;
}

/** Deliver a progressive byte prefix `[0, byteEnd)` of the level, by HTTP Range. */
export interface ProgressivePrefixResolution {
  kind: "progressive-prefix";
  level: PyramidLevel;
  contenthash: string;
  /** Exclusive end of the prefix; the full level is `level.bytes`. */
  byteEnd: number;
  /** `[0, byteEnd)`. */
  range: ByteRange;
  width: number;
  height: number;
}

export type LodResolution =
  | WholeLevelResolution
  | JxtcRangesResolution
  | ProgressivePrefixResolution;

export class LodResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LodResolveError";
  }
}

/** Effective display long edge for the request (target scaled by device pixel ratio). */
function effectiveTargetLongEdge(req: LodRequest): number {
  const dpr = Number.isFinite(req.dpr) && req.dpr > 0 ? req.dpr : 1;
  const target = req.targetLongEdge * dpr;
  if (!Number.isFinite(target) || target <= 0) {
    throw new LodResolveError(`invalid targetLongEdge*dpr (got ${req.targetLongEdge} * ${req.dpr})`);
  }
  return target;
}

function wholeLevel(level: PyramidLevel): WholeLevelResolution {
  return {
    kind: "whole-level",
    level,
    contenthash: level.contenthash,
    bytes: level.bytes,
    range: { start: 0, end: level.bytes },
    width: level.w,
    height: level.h,
    tiled: level.tiled === true,
  };
}

/**
 * Region → the JXTC tiles overlapping the clamped rect + their byte ranges. Mirrors
 * `tilesOverlappingRegion` (tiling.ts) but also emits the per-tile byte range from the tile
 * index. Absolute offsets, no rebasing (finding 60).
 */
function jxtcRanges(
  level: PyramidLevel,
  grid: JxtcTileGrid,
  region: NonNullable<LodRequest["region"]>,
): JxtcRangesResolution {
  const { imageW, imageH, tileSize, tilesX, tilesY, offsets, lengths } = grid;
  if (
    !Number.isFinite(region.x) || region.x < 0 ||
    !Number.isFinite(region.y) || region.y < 0 ||
    !Number.isFinite(region.width) || region.width < 0 ||
    !Number.isFinite(region.height) || region.height < 0
  ) {
    throw new LodResolveError("region must have finite non-negative x, y, width, height");
  }
  const rx = Math.min(Math.max(0, region.x), imageW);
  const ry = Math.min(Math.max(0, region.y), imageH);
  const rw = Math.min(region.width, imageW - rx);
  const rh = Math.min(region.height, imageH - ry);
  const ranges: ByteRange[] = [];
  const tiles: TileRect[] = [];
  const clamped: TileRect = { x: rx, y: ry, w: Math.max(0, rw), h: Math.max(0, rh) };
  if (rw <= 0 || rh <= 0) {
    return { kind: "jxtc-ranges", level, contenthash: level.contenthash, ranges, tiles, region: clamped, width: 0, height: 0 };
  }
  const txMin = Math.floor(rx / tileSize);
  const txMax = Math.floor((rx + rw - 1) / tileSize);
  const tyMin = Math.floor(ry / tileSize);
  const tyMax = Math.floor((ry + rh - 1) / tileSize);
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) continue;
      const tileIdx = ty * tilesX + tx;
      const start = offsets[tileIdx]!; // ABSOLUTE offset from byte 0 — no rebasing (finding 60).
      const len = lengths[tileIdx]!;
      ranges.push({ start, end: start + len });
      const tileX0 = tx * tileSize;
      const tileY0 = ty * tileSize;
      const ox0 = Math.max(tileX0, rx);
      const oy0 = Math.max(tileY0, ry);
      const ox1 = Math.min(tileX0 + Math.min(tileSize, imageW - tileX0), rx + rw);
      const oy1 = Math.min(tileY0 + Math.min(tileSize, imageH - tileY0), ry + rh);
      tiles.push({ x: ox0, y: oy0, w: ox1 - ox0, h: oy1 - oy0 });
    }
  }
  return { kind: "jxtc-ranges", level, contenthash: level.contenthash, ranges, tiles, region: clamped, width: rw, height: rh };
}

/**
 * Map the quality request onto a byte-prefix cutoff for the chosen level. Returns a byteEnd when
 * a real prefix (< full bytes) meets the quality target; `undefined` otherwise (deliver whole).
 *
 * The named qualities map onto the level's encode-time quality curve:
 *   - "final"       → no prefix (full level).
 *   - "preview"     → the visually-loose butteraugli target (~3.0), i.e. fastest first paint.
 *   - "interactive" → the visually-good butteraugli target (~1.5).
 * A caller-supplied `qualityTarget` (butteraugli/ssim thresholds) overrides the named default.
 */
function progressivePrefixByteEnd(level: PyramidLevel, req: LodRequest, extras: ResolveExtras): number | undefined {
  const q = req.quality;
  if (q == null || q === "final") return undefined;
  const target: QualityTarget = extras.qualityTarget ?? (
    q === "preview" ? { maxButteraugli: 3.0 } : { maxButteraugli: 1.5 }
  );
  return pickByteEndForQuality(level, target);
}

/**
 * Resolve gallery demand to one delivery kind.
 *
 * Precedence (findings 2, 26):
 *   1. RESOLUTION — always pick the level first via the shared selector (`chooseLevelForTarget`).
 *   2. REGION     — if a `region` is set, the chosen level is a JXTC tile container, range
 *                   requests are supported, and a tile index is supplied → `jxtc-ranges`.
 *   3. QUALITY    — else if a `quality` is set, the chosen level carries a quality prefix that
 *                   meets the target, and range requests are supported → `progressive-prefix`.
 *   4. DEFAULT    — `whole-level`.
 *
 * When range requests are unsupported (`capabilities.rangeRequests === false`) both the region
 * and quality axes fall back to `whole-level` — the delivery mechanism gracefully degrades to a
 * full download of the correctly-selected level.
 *
 * @throws LodResolveError on empty levels or a non-finite target.
 */
export function resolveLod(
  manifest: Pick<PyramidManifest, "levels">,
  request: LodRequest,
  capabilities: DecodeCapabilities,
  extras: ResolveExtras = {},
): LodResolution {
  const levels = manifest.levels;
  if (!levels || levels.length === 0) {
    throw new LodResolveError("resolveLod requires a manifest with at least one level");
  }
  const target = effectiveTargetLongEdge(request);

  // (1) RESOLUTION — the one shared selector (finding 26).
  let level: PyramidLevel;
  try {
    level = chooseLevelForTarget(levels, target);
  } catch (e) {
    throw new LodResolveError(e instanceof Error ? e.message : String(e));
  }

  // (2) REGION → jxtc-ranges (spatial is the most specific).
  if (request.region && level.tiled === true && capabilities.rangeRequests) {
    const grid = extras.tileIndex?.[level.contenthash];
    if (grid) {
      return jxtcRanges(level, grid, request.region);
    }
    // Tiled + range-capable but no tile index supplied: cannot address tiles → whole level.
  }

  // (3) QUALITY → progressive-prefix.
  if (request.quality != null && capabilities.rangeRequests) {
    const byteEnd = progressivePrefixByteEnd(level, request, extras);
    if (byteEnd !== undefined && byteEnd > 0 && byteEnd < level.bytes) {
      return {
        kind: "progressive-prefix",
        level,
        contenthash: level.contenthash,
        byteEnd,
        range: { start: 0, end: byteEnd },
        width: level.w,
        height: level.h,
      };
    }
  }

  // (4) DEFAULT → whole-level.
  return wholeLevel(level);
}
