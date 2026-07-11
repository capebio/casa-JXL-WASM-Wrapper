/** Long-edge threshold for tiled top-level ingest (spec §4 / M4). */
export declare const MASSIVE_LONG_EDGE_THRESHOLD = 8000;
/** Pixel-count threshold for tiled top-level ingest (spec §4 / M4). */
export declare const MASSIVE_PIXEL_THRESHOLD = 40000000;
/** JXTC tile size for massive-scan top levels (rgba8 only in v1). */
export declare const JXTC_TILE_SIZE = 512;
export declare const JXTC_MAGIC = 1129601098;
export interface JxtcHeader {
    imageW: number;
    imageH: number;
    tileSize: number;
    tilesX: number;
    tilesY: number;
    hasAlpha: boolean;
    /** 8 or 16. Flag in header (v1 and v2). */
    bitsPerSample: 8 | 16;
    /** 1 or 2. v2 support added for future table/layout extensions (see level-table reader). */
    version: 1 | 2;
}
/** True when ingest should replace the whole-frame top level with a JXTC container. */
export declare function shouldTileTopLevel(width: number, height: number): boolean;
export declare function isJxtcContainer(bytes: Uint8Array): boolean;
/** Parse the 32-byte JXTC container header (little-endian u32 fields). */
export declare function parseJxtcHeader(bytes: Uint8Array): JxtcHeader;
/** Pre-parsed tile index table for fast O(1) extract (no per-tile DataView).
 *  Parsed once per container bytes (WeakMap). Major win for dc-then-final progressive
 *  (decode-level.ts calls extract N times per viewport per pass) and any per-tile paths.
 *  v2 table reader extension point (different stride/fields can be handled here).
 */
export interface JxtcTileIndex {
    /**
     * ABSOLUTE byte offsets from byte 0 of the complete JXTC file — one per tile.
     * This mirrors the canonical writers exactly (bridge.cpp:1925-1931 and the Rust
     * `build_jxtc`/`build_jxtc_rgba8` helpers), which store `cursor = 32 + tileCount*8`
     * as the first offset and the running absolute cursor thereafter. Readers must NOT
     * re-add any data base — the stored value is already file-relative (finding 60).
     */
    offsets: Uint32Array;
    lengths: Uint32Array;
}
/** Parse (or hit memo) the tile offset/length table after the 32B header.
 *  Called on first extract per container; subsequent extracts are array lookup + subarray.
 */
export declare function getOrParseJxtcTileIndex(bytes: Uint8Array, header: JxtcHeader): JxtcTileIndex;
export interface ImageRegion {
    x: number;
    y: number;
    w: number;
    h: number;
}
/** Tile-aligned intersections between a viewport region and the JXTC grid. */
export declare function tilesOverlappingRegion(imageW: number, imageH: number, tileSize: number, region: ImageRegion): ImageRegion[];
/** Compat wrapper used by prepareDecodePlan (plan.ts). Delegates to tilesOverlappingRegion. */
export declare function tilesForClampedRegion(imageW: number, imageH: number, tileSize: number, x: number, y: number, w: number, h: number): ImageRegion[];
/** COOP/COEP + Worker availability — parallel tile workers are viable. */
export declare function canUseParallelTileWorkers(): boolean;
/** Whether SharedArrayBuffer + crossOriginIsolated allows SAB-backed container bytes for zero-copy fanout to workers (Grok2 SAB opt-in). Split from canUseParallelTileWorkers. */
export declare function canShareContainerBytes(): boolean;
/**
 * Extract the standalone JXL bitstream bytes for one tile from a JXTC container.
 * Pure TS (no WASM). Zero-copy subarray view. Used for progressive DC-then-final (F1)
 * and future per-tile createDecoder paths.
 *
 * Fast path: uses pre-parsed JxtcTileIndex (Uint32Arrays) from getOrParseJxtcTileIndex.
 * First call per container parses the table once; subsequent are O(1) array + subarray.
 * This eliminates per-tile DataView cost in hot paths (e.g. dc-then-final viewport pans).
 * v2: table reader here is the extension point for layout changes.
 */
export declare function extractTileBitstream(container: Uint8Array, tile: ImageRegion, header: JxtcHeader): Uint8Array;
//# sourceMappingURL=tiling.d.ts.map