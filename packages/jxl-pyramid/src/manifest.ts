// manifest.ts
// Interfaces for the Pyramid Gallery manifest and index schemas (M0-M7).
// Conforms strictly to the 2026-06-07-pyramid-gallery-design.md specification.

/** Supported master image file formats. */
export type MasterFormat = "orf" | "dng" | "cr2" | "jpg";

/** Image orientation handling strategy (v1–v4 string form). Retained for back-compat with older
 *  manifests; v5 uses OrientationDescriptor. */
export type Orientation = "baked" | "source";

/** v5 OrientationDescriptor: the exact EXIF orientation value (1..8) plus whether the stored pixels
 *  are already upright. Decouples "what EXIF said" from "what we baked into the pixels".
 *  Mirrors @casabio/pyramid-ingest's canonical OrientationDescriptor (finding 72 — one contract). */
export interface OrientationDescriptor {
  /** EXIF Orientation tag value, 1..8. */
  exif: number;
  /** Whether the persisted level pixels are already upright, or still in source orientation. */
  pixels: "source" | "baked-upright";
}

/** v5 TilingDescriptor persisted on a tiled level. `offsetBase: "file"` records that JXTC index
 *  offsets are ABSOLUTE from byte zero of the file. Mirrors the canonical pyramid-ingest shape. */
export interface TilingDescriptor {
  container: "jxtc";
  version: 1 | 2;
  tileSize: number;
  bitsPerSample: 8 | 16;
  offsetBase: "file";
}

/** v4 tiling grid (legacy): derivable tile grid without a container/version tag. */
export interface TilingGrid {
  tileSize: number;
  cols: number;
  rows: number;
}

/** Target size for a pyramid level, either a long-edge target size (number) or the string "full". */
export type LevelSize = number | "full";

/** Supported bit depths per sample in the JXL stream. */
export type BitsPerSample = 8 | 16;

/** Metadata of the original master image. */
export interface MasterMetadata {
  name: string;
  format: MasterFormat;
  mtimeMs: number;
  /**
   * v5 (finding 64): detected provenance, decoupled from `format` (decoder capability). Rejecting an
   * unsupported decode never erases this. Optional/additive so v1–v4 masters validate unchanged.
   */
  sourceFormat?: string;
  /** Pair with mtimeMs for stronger staleness checks. */
  sizeBytes?: number;
}

/** Tool that produced this manifest. */
export interface ProducedBy {
  tool: string;
  version: string;
  params?: Record<string, unknown>;
}

/**
 * S6 (additive): which LOD/ROI request axes a level or the whole asset can serve, for the
 * unified `lod-resolver`. All fields optional; absent = derive from shape (a `tiled` level
 * implies `region`, multiple levels imply `resolution`, a `qualityCurve` implies `quality`).
 * Additive on schema 2 — manifests without it parse unchanged.
 *   quality    — byte-prefix quality tiers available (qualityCurve / convergedByteEnd).
 *   resolution — multiple resolution levels available (pyramid).
 *   region     — spatial ROI addressable (tiled / JXTC).
 */
export interface LodCapabilities {
  quality?: boolean;
  resolution?: boolean;
  region?: boolean;
}

/** Content-addressed color sidecars for Perceptual Constancy Mode (LUT blobs cacheable in PyramidCache as opaque bytes). */
export interface ColorInfo {
  space?: "srgb" | "display-p3" | (string & {});
  iccHash?: string;
  lutHash?: string;
}

/** ML sidecars: embeddings and taxon labels (Darwin-Core-friendly). */
export interface RecognitionInfo {
  embeddings?: Array<{ model: string; dim: number; hash: string }>;
  labels?: Array<{ taxon: string; confidence: number; source: string }>;
}

/** One encode-time quality measurement for a progressive pass of a level.
 *  Produced once at ingest (pyramid-ingest --profile-convergence); clients read these
 *  instead of computing ssim/butteraugli at download time. */
export interface QualityCurvePoint {
  /** Compressed byte offset at which this progressive pass became decodable. */
  bytes: number;
  /** SSIM vs the level's own final pixels (1 = identical). */
  ssim?: number;
  /** Butteraugli distance vs the level's own final pixels (0 = identical, ~1.0 imperceptible). */
  butteraugli?: number;
}

/** Information about a single pyramid level. */
export interface PyramidLevel {
  size: LevelSize;
  w: number;
  h: number;
  bytes: number;
  bitsPerSample: BitsPerSample;
  contenthash: string;
  tiled: boolean;
  /**
   * Required when tiled. On v1–v4 manifests this is a TilingGrid { tileSize, cols, rows }; on v5 it
   * is a TilingDescriptor { container, version, tileSize, bitsPerSample, offsetBase }. Either lets a
   * client address tiles without decoding.
   */
  tiling?: TilingGrid | TilingDescriptor;
  /**
   * Byte offset of visual saturation for this level (precomputed butteraugli cutoff).
   * Viewer-only download optimization: progressive viewers may abort the fetch here.
   * Photogrammetry, archival, and ML consumers MUST ignore it and fetch all `bytes` —
   * a reconstruction from visually-saturated truncation silently degrades geometry.
   */
  convergedByteEnd?: number;
  /**
   * Full encode-time quality curve, ascending by bytes (additive; absent on older manifests).
   * Sampled at ingest so clients pick their own bytes↔quality cutoff without re-running butteraugli.
   */
  qualityCurve?: QualityCurvePoint[];
  /**
   * S6 (additive): the LOD/ROI axes this level can serve (see LodCapabilities). Optional;
   * absent → derive from shape (`tiled` ⇒ region, `qualityCurve` ⇒ quality).
   */
  capabilities?: LodCapabilities;
}

/** The schema definition of `manifest.json` per image.
 *  Readable schemas are 1|2|4|5 (3 was skipped). v1 is normalized to 2 by the reader; v4/v5 keep
 *  their number. On v5, `orientation` is an OrientationDescriptor; on v1–v4 it is the legacy string.
 *  Unknown fields are preserved by the reader so the contract is additive/lossless. */
export interface PyramidManifest {
  schema: 1 | 2 | 4 | 5;
  imageId: string;
  master: MasterMetadata;
  orientation: Orientation | OrientationDescriptor;
  width: number;
  height: number;
  aspect: number;
  levels: PyramidLevel[];
  proxy?: boolean;
  producedBy?: ProducedBy;
  stub?: boolean;
  metadata?: Record<string, unknown>;
  /**
   * Whole-file fallback for convergedByteEnd when per-level values are absent.
   * Viewer-only: photogrammetry/archival/ML consumers must ignore this and fetch all bytes.
   */
  convergedByteEnd?: number;
  /** Content-addressed color sidecars for Perceptual Constancy Mode. */
  color?: ColorInfo;
  /** ML sidecars: embeddings and taxon labels for species recognition. */
  recognition?: RecognitionInfo;
  /**
   * S6 (additive): the LOD/ROI axes this asset can serve at the manifest level (see
   * LodCapabilities). Optional; a pyramid with >1 level implies `resolution`.
   */
  capabilities?: LodCapabilities;
}

/** Quality target for pickByteEndForQuality. Provide at least one threshold. */
export interface QualityTarget {
  /** Accept the first pass whose butteraugli distance is <= this (e.g. 2.0 for "good enough", 1.1 for visually saturated). */
  maxButteraugli?: number;
  /** Accept the first pass whose ssim is >= this (e.g. 0.999). */
  minSsim?: number;
}

/**
 * Pick a download cutoff (bytes) for a level from its encode-time quality curve.
 * Feed the result to the stream layer's maxBytes (same mechanism as convergedByteEnd).
 *
 * - With thresholds: returns the first curve point meeting EVERY provided threshold
 *   (points missing a thresholded metric do not qualify), or undefined if none does
 *   (caller downloads the full level).
 * - With an empty target ({}): falls back to the level's convergedByteEnd.
 * - No curve and no convergedByteEnd: undefined.
 */
export function pickByteEndForQuality(
  level: Pick<PyramidLevel, "qualityCurve" | "convergedByteEnd" | "bytes">,
  target: QualityTarget = {},
): number | undefined {
  const { maxButteraugli, minSsim } = target;
  const hasThreshold = maxButteraugli !== undefined || minSsim !== undefined;
  const curve = level.qualityCurve;
  if (hasThreshold && curve && curve.length > 0) {
    for (const pt of curve) {
      if (maxButteraugli !== undefined && !(pt.butteraugli !== undefined && pt.butteraugli <= maxButteraugli)) continue;
      if (minSsim !== undefined && !(pt.ssim !== undefined && pt.ssim >= minSsim)) continue;
      if (pt.bytes > 0 && pt.bytes < level.bytes) return pt.bytes;
      return undefined;
    }
    return undefined;
  }
  if (!hasThreshold && level.convergedByteEnd != null && level.convergedByteEnd > 0 && level.convergedByteEnd < level.bytes) {
    return level.convergedByteEnd;
  }
  return undefined;
}

/** Information about the smallest level (L0 seed) inlined in the gallery index. */
export interface LevelZeroSeed {
  contenthash: string;
  w: number;
  h: number;
  /** Total compressed bytes for the level; used for prefetch sizing and progress reporting. */
  bytes?: number;
}

/** A single image entry within `index.json`. */
export interface GalleryIndexEntry {
  imageId: string;
  aspect: number;
  l0: LevelZeroSeed;
  /** ~28-byte placeholder hash for instant gallery skeleton and AR overlay anchoring before any JXL bytes arrive. */
  thumbhash?: string;
  /** Specimen or occurrence ID for grouping multi-view photogrammetry sets. */
  group?: string;
}

/** The schema definition of `index.json` per gallery. */
export interface GalleryIndex {
  schema: 1;
  images: GalleryIndexEntry[];
  /** Pagination cursor for sharded indexes (10k+ image galleries). */
  next?: string;
}
