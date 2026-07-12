import type { PyramidManifest, PyramidLevel } from "./manifest.js";
import { type QualityTarget } from "./manifest.js";
import type { LodRequest, DecodeCapabilities } from "./runtime.js";
/** A half-open byte interval `[start, end)`; `end` is EXCLUSIVE (matches manifest `byteEnd`). */
export interface ByteRange {
    start: number;
    end: number;
}
/** Format a byte range as an HTTP `Range` header value (inclusive both ends). */
export declare function toHttpRange(range: ByteRange): string;
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
export type LodResolution = WholeLevelResolution | JxtcRangesResolution | ProgressivePrefixResolution;
export declare class LodResolveError extends Error {
    constructor(message: string);
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
export declare function resolveLod(manifest: Pick<PyramidManifest, "levels">, request: LodRequest, capabilities: DecodeCapabilities, extras?: ResolveExtras): LodResolution;
//# sourceMappingURL=lod-resolver.d.ts.map