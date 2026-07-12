import { PyramidError } from './decode-core.js';

/** Long-edge threshold for tiled top-level ingest (spec §4 / M4). */
export const MASSIVE_LONG_EDGE_THRESHOLD = 8000;

/** Pixel-count threshold for tiled top-level ingest (spec §4 / M4). */
export const MASSIVE_PIXEL_THRESHOLD = 40_000_000;

/** JXTC tile size for massive-scan top levels (rgba8 only in v1). */
export const JXTC_TILE_SIZE = 512;

export const JXTC_MAGIC = 0x4354_584a; // 'JXTC' little-endian

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
export function shouldTileTopLevel(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  const longEdge = Math.max(width, height);
  return longEdge > MASSIVE_LONG_EDGE_THRESHOLD || width * height > MASSIVE_PIXEL_THRESHOLD;
}

export function isJxtcContainer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === JXTC_MAGIC;
}

/** Parse the 32-byte JXTC container header (little-endian u32 fields). */
export function parseJxtcHeader(bytes: Uint8Array): JxtcHeader {
  if (bytes.byteLength < 32) throw new PyramidError("JXTC_PARSE", "JXTC container too small for header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== JXTC_MAGIC) throw new PyramidError("JXTC_PARSE", "not a JXTC container");
  const version = view.getUint32(4, true) as 1 | 2;
  if (version !== 1 && version !== 2) throw new PyramidError("JXTC_PARSE", "unsupported JXTC version");
  const imageW = view.getUint32(8, true);
  const imageH = view.getUint32(12, true);
  const tileSize = view.getUint32(16, true);
  const tilesX = view.getUint32(20, true);
  const tilesY = view.getUint32(24, true);
  const flags = view.getUint32(28, true);
  const hasAlpha = (flags & 1) !== 0;
  const bitsPerSample: 8 | 16 = (flags & 2) !== 0 ? 16 : 8;

  // G4-A: strict boundary validation for untrusted JXTC (adversarial dims/tileSize)
  if (imageW <= 0 || imageH <= 0 || tileSize <= 0) {
    throw new PyramidError("JXTC_PARSE", "JXTC header has non-positive imageW/H or tileSize");
  }
  if (bitsPerSample !== 8 && bitsPerSample !== 16) {
    throw new PyramidError("JXTC_PARSE", "JXTC bitsPerSample must be 8 or 16");
  }
  const bytesPerPixel = bitsPerSample === 16 ? 8 : 4;
  // safe total byte size cap ~1GB (2^30); prevent OOM on malicious header
  const totalBytes = imageW * imageH * bytesPerPixel;
  if (!Number.isFinite(totalBytes) || totalBytes > (1 << 30) || imageW > (1 << 24) || imageH > (1 << 24)) {
    throw new PyramidError("JXTC_PARSE", "JXTC dimensions exceed safety cap (w*h*bpp > 2^30 or non-finite)");
  }

  return { imageW, imageH, tileSize, tilesX, tilesY, hasAlpha, bitsPerSample, version };
}

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

const tileIndexMemo = new WeakMap<Uint8Array, JxtcTileIndex>();

/** Parse (or hit memo) the tile offset/length table after the 32B header.
 *  Called on first extract per container; subsequent extracts are array lookup + subarray.
 */
export function getOrParseJxtcTileIndex(bytes: Uint8Array, header: JxtcHeader): JxtcTileIndex {
  const hit = tileIndexMemo.get(bytes);
  if (hit) return hit;

  // Cap numTiles to prevent overflow and OOM on untrusted tilesX/tilesY
  const MAX_TILES = (1 << 24); // 16M tiles (128GB at 8B/tile)
  if (header.tilesX > MAX_TILES || header.tilesY > MAX_TILES) {
    throw new PyramidError('JXTC_PARSE', 'JXTC tilesX or tilesY exceeds safety cap');
  }
  const numTiles = header.tilesX * header.tilesY;
  if (numTiles > MAX_TILES) {
    throw new PyramidError('JXTC_PARSE', 'JXTC total tiles exceeds safety cap');
  }
  if (bytes.byteLength < 32 + numTiles * 8) {
    throw new PyramidError('JXTC_PARSE', 'JXTC container too small for index table');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsets = new Uint32Array(numTiles);
  const lengths = new Uint32Array(numTiles);
  let off = 32;
  for (let i = 0; i < numTiles; i++) {
    // Store the offset EXACTLY as written: an absolute byte offset from byte 0.
    // (Previously a separate `dataBase` was tracked and re-added on extract, which
    // double-added the header+index size — finding 60.)
    offsets[i] = view.getUint32(off, true);
    lengths[i] = view.getUint32(off + 4, true);
    off += 8;
  }
  const idx: JxtcTileIndex = { offsets, lengths };
  tileIndexMemo.set(bytes, idx);
  return idx;
}

export interface ImageRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Tile-aligned intersections between a viewport region and the JXTC grid. */
export function tilesOverlappingRegion(
  imageW: number,
  imageH: number,
  tileSize: number,
  region: ImageRegion,
): ImageRegion[] {
  // G4-A: validate region inputs as finite non-negative before any clamping/math (for decodeLevel region param too)
  if (
    !Number.isFinite(region.x) || region.x < 0 ||
    !Number.isFinite(region.y) || region.y < 0 ||
    !Number.isFinite(region.w) || region.w < 0 ||
    !Number.isFinite(region.h) || region.h < 0
  ) {
    throw new PyramidError("JXTC_PARSE", "region must have finite non-negative x, y, w, h");
  }
  if (tileSize <= 0) throw new PyramidError("JXTC_PARSE", "tileSize must be positive");
  const rx = Math.min(Math.max(0, region.x), imageW);
  const ry = Math.min(Math.max(0, region.y), imageH);
  const rw = Math.min(region.w, imageW - rx);
  const rh = Math.min(region.h, imageH - ry);
  if (rw <= 0 || rh <= 0) return [];

  const txMin = Math.floor(rx / tileSize);
  const txMax = Math.floor((rx + rw - 1) / tileSize);
  const tyMin = Math.floor(ry / tileSize);
  const tyMax = Math.floor((ry + rh - 1) / tileSize);

  const out: ImageRegion[] = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const tileX0 = tx * tileSize;
      const tileY0 = ty * tileSize;
      const tileW = Math.min(tileSize, imageW - tileX0);
      const tileH = Math.min(tileSize, imageH - tileY0);
      const ox0 = Math.max(tileX0, rx);
      const oy0 = Math.max(tileY0, ry);
      const ox1 = Math.min(tileX0 + tileW, rx + rw);
      const oy1 = Math.min(tileY0 + tileH, ry + rh);
      const ow = ox1 - ox0;
      const oh = oy1 - oy0;
      if (ow > 0 && oh > 0) out.push({ x: ox0, y: oy0, w: ow, h: oh });
    }
  }
  return out;
}

/** Compat wrapper used by prepareDecodePlan (plan.ts). Delegates to tilesOverlappingRegion. */
export function tilesForClampedRegion(
  imageW: number,
  imageH: number,
  tileSize: number,
  x: number,
  y: number,
  w: number,
  h: number,
): ImageRegion[] {
  return tilesOverlappingRegion(imageW, imageH, tileSize, { x, y, w, h });
}

type ParallelRuntime = {
  Worker?: unknown;
  crossOriginIsolated?: boolean;
};

/**
 * Worker availability — parallel tile workers are viable.
 *
 * Finding 82: Worker availability is INDEPENDENT of cross-origin isolation. Per-tile parallel
 * decode works in any environment that exposes `Worker`; it does not require COOP/COEP. Cross-origin
 * isolation only unlocks the zero-copy SharedArrayBuffer carrier (see `canShareContainerBytes`),
 * which the pool uses opt-in — without it, container bytes are transferred/copied to each worker,
 * still fully parallel. Gating the whole parallel path on `crossOriginIsolated` silently downgraded
 * every non-isolated browser to single-threaded decode.
 */
export function canUseParallelTileWorkers(): boolean {
  const rt = globalThis as ParallelRuntime;
  return typeof rt.Worker !== "undefined";
}

/** Whether SharedArrayBuffer + crossOriginIsolated allows SAB-backed container bytes for zero-copy fanout to workers (Grok2 SAB opt-in). Split from canUseParallelTileWorkers. */
export function canShareContainerBytes(): boolean {
  try {
    const rt = globalThis as any;
    return rt.crossOriginIsolated === true && typeof rt.SharedArrayBuffer === 'function';
  } catch {
    return false;
  }
}

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
export function extractTileBitstream(
  container: Uint8Array,
  tile: ImageRegion,
  header: JxtcHeader,
): Uint8Array {
  if (container.byteLength < 32) throw new PyramidError('JXTC_PARSE', 'JXTC container too small');
  // Re-validate magic for untrusted input (safety, cheap).
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  if (view.getUint32(0, true) !== JXTC_MAGIC) throw new PyramidError('JXTC_PARSE', 'not a JXTC container');
  const tilesX = header.tilesX;
  const tilesY = header.tilesY;
  const tileSize = header.tileSize;
  if (tilesX <= 0 || tilesY <= 0 || tileSize <= 0) throw new PyramidError('JXTC_PARSE', 'bad JXTC header dims');

  const tx = Math.floor(tile.x / tileSize);
  const ty = Math.floor(tile.y / tileSize);
  if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) throw new PyramidError('JXTC_PARSE', 'tile out of JXTC grid');

  const tileIdx = ty * tilesX + tx;

  // Fast path via pre-parsed table (populated on first extract for this container bytes).
  const table = getOrParseJxtcTileIndex(container, header);
  const off = table.offsets[tileIdx]!; // ABSOLUTE offset from byte 0 — no rebasing.
  const len = table.lengths[tileIdx]!;

  // Trust-boundary + bounds checks (JXTC v1/v2 invariant):
  //  1. A tile must live PAST the header+index region — an offset inside it could
  //     feed index/header bytes to the JXL decoder. First tile data == 32 + N*8.
  //  2. offset must be within the file, and offset+length must not run past EOF.
  //     Use the OVERFLOW-SAFE form `len > byteLength - off` — never add `off + len`,
  //     which wraps in fixed-width integer readers (wasm32 size_t): 0xFFFFFFF0 + 24
  //     → 0x8. The explicit `off > byteLength` guard first makes `byteLength - off`
  //     safe from underflow (mirrored in C++/Rust; see cross-language-jxtc.test.ts).
  const indexEnd = 32 + header.tilesX * header.tilesY * 8;
  if (off < indexEnd) throw new PyramidError('JXTC_PARSE', 'tile offset inside header/index');
  if (len === 0 || off > container.byteLength || len > container.byteLength - off) {
    throw new PyramidError('JXTC_PARSE', 'tile data OOB or empty');
  }

  return container.subarray(off, off + len);
}
