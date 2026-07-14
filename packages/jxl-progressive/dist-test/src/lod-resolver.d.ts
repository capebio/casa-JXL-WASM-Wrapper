import type { ProgressiveManifest } from "./progressive-manifest.js";
/** A half-open byte interval `[start, end)`. `end` is EXCLUSIVE, matching the manifest's
 *  `byteEnd` convention. Length = end - start. */
export interface ByteRange {
    start: number;
    end: number;
}
/** Format a single range as an HTTP `Range` header value (inclusive both ends). */
export declare function toHttpRange(range: ByteRange): string;
export type LodMechanism = "progressive" | "pyramid" | "jxtc";
/** The resolver's answer: which container to read, which byte ranges, and the effective
 *  decoded dimensions of the result. */
export interface ByteSource {
    mechanism: LodMechanism;
    /** URL / content-hash / container id the ranges index into. */
    source: string;
    ranges: ByteRange[];
    /** Effective decoded width/height of the reconstruction these bytes yield. */
    width?: number;
    height?: number;
    /** For `jxtc`: the image-space cells the ranges correspond to (one per range). */
    tiles?: {
        x: number;
        y: number;
        w: number;
        h: number;
    }[];
}
/** The unified request language. Any subset of axes may be set. */
export interface LodRequest {
    /** Resolution axis: target long-edge in display pixels. */
    level?: number;
    /** Region axis: spatial ROI in full-resolution image coordinates. */
    region?: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
    /** Quality axis: a tier name (`"dc"|"preview"|"full"`), the literal `"full"`, or a
     *  fraction in (0,1] of the full byte budget (0.5 = at least half the bytes). */
    quality?: string | number;
}
/** One progressive quality tier — a cumulative byte prefix `[0, byteEnd)` of one codestream. */
export interface QualityTier {
    name: string;
    /** Exclusive end offset of this tier's prefix. */
    byteEnd: number;
    /** Intrinsic reconstruction dims (schema v2). Absent → resolver falls back to source dims. */
    pixelWidth?: number;
    pixelHeight?: number;
}
/** Progressive codestream: quality tiers over a single blob. */
export interface ProgressiveSource {
    source: string;
    bytes: number;
    width: number;
    height: number;
    /** Ascending by `byteEnd`; the last tier's `byteEnd === bytes` (full). */
    tiers: QualityTier[];
}
/** One pyramid resolution level — an opaque per-level blob addressed by `source`. */
export interface ResolutionLevel {
    source: string;
    w: number;
    h: number;
    bytes: number;
    tiled?: boolean;
    tiling?: {
        tileSize: number;
        cols: number;
        rows: number;
    };
}
export interface PyramidSource {
    /** Any order; the resolver sorts by long edge. */
    levels: ResolutionLevel[];
}
/** A JXTC tiled container: header grid + parsed tile offset/length index. */
export interface JxtcGrid {
    source: string;
    imageW: number;
    imageH: number;
    tileSize: number;
    tilesX: number;
    tilesY: number;
    /**
     * Tile offsets are ABSOLUTE byte offsets from byte 0 of the JXTC file, exactly as
     * produced by getOrParseJxtcTileIndex (JXTC absolute-offset contract, finding 60).
     * No `dataBase` rebasing — the stored value is already file-relative.
     */
    index: {
        offsets: ArrayLike<number>;
        lengths: ArrayLike<number>;
    };
}
/** What one stored asset supports. Any combination of the three mechanisms may be present. */
export interface LodAsset {
    width: number;
    height: number;
    progressive?: ProgressiveSource;
    pyramid?: PyramidSource;
    jxtc?: JxtcGrid;
}
export declare class LodResolveError extends Error {
    constructor(message: string);
}
/**
 * Map a `{ level?, region?, quality? }` request to a concrete `ByteSource`.
 *
 * Precedence when several axes are set and the asset offers several mechanisms:
 *   1. `region`  → JXTC tiles (spatial is the most specific). If the asset is not tiled,
 *                  the region axis is dropped and resolution/quality/default apply.
 *   2. `level`   → pyramid level; if there is no pyramid but a progressive codestream, the
 *                  smallest tier whose intrinsic resolution meets the target.
 *   3. `quality` → progressive prefix; if there is no progressive stream but a pyramid,
 *                  the largest level (opaque levels have no quality sub-selection).
 *   4. default   → progressive full → pyramid largest → whole JXTC grid.
 *
 * Throws `LodResolveError` only when the asset supports NO mechanism at all.
 */
export declare function resolveLod(asset: LodAsset, req: LodRequest): ByteSource;
/** Build a progressive `LodAsset` from a `ProgressiveManifest` (K2 tier offsets). */
export declare function fromProgressiveManifest(manifest: ProgressiveManifest, source: string): LodAsset;
/** Build a pyramid `LodAsset` from pyramid levels. `sourceFor` maps a level to its blob id
 *  (default: the level's `contenthash`). */
export declare function fromPyramidLevels(levels: readonly {
    w: number;
    h: number;
    bytes: number;
    contenthash: string;
    tiled?: boolean;
    tiling?: {
        tileSize: number;
        cols: number;
        rows: number;
    };
}[], sourceFor?: (level: {
    contenthash: string;
}) => string): LodAsset;
/** Build a JXTC `LodAsset` from a parsed JXTC header + tile index. */
export declare function fromJxtcContainer(header: {
    imageW: number;
    imageH: number;
    tileSize: number;
    tilesX: number;
    tilesY: number;
}, index: {
    offsets: ArrayLike<number>;
    lengths: ArrayLike<number>;
}, source: string): LodAsset;
//# sourceMappingURL=lod-resolver.d.ts.map