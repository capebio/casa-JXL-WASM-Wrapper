import { contentHash16 } from "./hash.js";
import type { MasterFormat, Orientation, PyramidLevelBytes } from "./backends.js";
import { makeProducedBy, manifestSchema } from "./schema.js";
import { isFresh, type SourceFingerprint } from "./source-identity.js";
import type {
  Manifest,
  IndexEntry,
  GalleryIndex,
  LevelEntry,
  LevelEntryV5,
  LevelSize,
  MasterInfo,
  MasterFingerprint,
} from "./schema.js";

export type {
  Manifest,
  IndexEntry,
  GalleryIndex,
  LevelEntry,
  LevelEntryV5,
  LevelSize,
  MasterInfo,
} from "./schema.js";

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export function levelSize(w: number, h: number, masterW: number, masterH: number): LevelSize {
  if (w === masterW && h === masterH) return "full";
  return Math.max(w, h);
}

export function toEntry(level: PyramidLevelBytes, masterW: number, masterH: number): LevelEntryV5 {
  const tiled = level.tiled === true;
  const bitsPerSample = level.bitsPerSample ?? 8;
  return {
    size: levelSize(level.width, level.height, masterW, masterH),
    w: level.width,
    h: level.height,
    bytes: level.data.length,
    bitsPerSample,
    contenthash: contentHash16(level.data),
    tiled,
    // v5: a tiled level persists an explicit TilingDescriptor so clients can address tiles without
    // decoding. JXTC index offsets are absolute from byte zero of the file (offsetBase: "file").
    ...(tiled
      ? {
          tiling: {
            container: "jxtc" as const,
            version: (level.tileVersion ?? 1) as 1 | 2,
            tileSize: level.tileSize ?? 512,
            bitsPerSample,
            offsetBase: "file" as const,
          },
        }
      : {}),
    ...(level.convergedByteEnd != null ? { convergedByteEnd: level.convergedByteEnd } : {}),
    ...(level.qualityCurve && level.qualityCurve.length > 0 ? { qualityCurve: level.qualityCurve } : {}),
  };
}

export function buildManifest(args: {
  imageId: string;
  /** finding 66: persistent content-derived identity, stable across moves (NOT the per-level hash). */
  catalogId?: string;
  master: MasterInfo & { fingerprint?: MasterFingerprint };
  orientation: Orientation;
  width: number;
  height: number;
  levels: LevelEntryV5[];
  proxy?: boolean;
}): Manifest {
  const levels = [...args.levels].sort((a, b) => a.w * a.h - b.w * b.h);
  // v5: emit the current schema. The runtime orientation string is lifted into an
  // OrientationDescriptor; exif defaults to 1 because ingest bakes the EXIF rotation into the pixels
  // and does not (yet) thread the raw EXIF value through — pixels: "baked-upright" vs "source" carries
  // the meaningful signal. A future ingest change can thread the real exif value here.
  const orientation = {
    exif: 1 as const,
    pixels: args.orientation === "source" ? ("source" as const) : ("baked-upright" as const),
  };
  const base = {
    schema: 5 as const,
    imageId: args.imageId,
    ...(args.catalogId ? { catalogId: args.catalogId } : {}),
    master: args.master,
    orientation,
    width: args.width,
    height: args.height,
    aspect: round4(args.width / args.height),
    levels,
    producedBy: makeProducedBy(),
    ...(args.proxy ? { proxy: true as const } : {}),
  };
  return manifestSchema.parse(base) as any;  // v5 (current); v1/v2/v4 still readable on parse
}

export function buildIndexEntry(manifest: Manifest): IndexEntry {
  const l0 = manifest.levels?.[0];
  if (!l0) throw new Error(`manifest ${manifest.imageId} has no levels`);
  // aspect is optional on v1 manifests; the index schema requires it, so fail loudly here
  // (previously undefined would flow through and fail galleryIndexSchema.parse later).
  if (manifest.aspect == null) throw new Error(`manifest ${manifest.imageId} has no aspect`);
  // finding 81: make the L0 seed's precision + transport EXPLICIT so a seed decoder chooses a valid
  // path. Monolithic 8-bit is the DEFAULT: a bare { contenthash, w, h } seed is decodable as a whole
  // RGBA8 bitstream, so those fields are emitted only when they DIFFER from that default (tiled seed,
  // 16-bit seed). This keeps the common seed minimal while letting a tiled/16-bit L0 be decoded.
  const bits = (l0 as { bitsPerSample?: 8 | 16 }).bitsPerSample ?? 8;
  const tiled = (l0 as { tiled?: boolean }).tiled === true;
  const tiling = (l0 as { tiling?: unknown }).tiling;
  return {
    imageId: manifest.imageId,
    aspect: manifest.aspect,
    l0: {
      contenthash: l0.contenthash,
      w: l0.w,
      h: l0.h,
      // Emit precision explicitly when the seed is non-default (16-bit) OR tiled, so the seed decoder
      // never has to peek into the tiling descriptor to learn precision. A bare monolithic 8-bit seed
      // omits it (default). This keeps the common seed minimal while a tiled/16-bit L0 stays explicit.
      ...(bits === 16 || tiled ? { bitsPerSample: bits } : {}),
      // A tiled seed MUST carry both the flag and (when present) the descriptor so the seed decoder
      // routes to the tile-container path; permit a tiled L0 only when it declares its transport.
      ...(tiled ? { tiled: true } : {}),
      ...(tiled && tiling ? { tiling: tiling as IndexEntry["l0"]["tiling"] } : {}),
    },
  };
}

export function isUpToDate(existing: Manifest, mtimeMs: number, proxy = false): boolean {
  // mtime exact match (low-mtime-rounding): drop rounding for determinism; fs mtimes are comparable at ms.
  // P7: proxy flag match for skip (when caller requests proxy, only proxy manifests count as uptodate)
  const proxyOk = proxy ? existing.proxy === true : existing.proxy !== true;
  return proxyOk && existing.master.mtimeMs === mtimeMs;
}

/**
 * finding 66 (Task 5): fingerprint-aware freshness. Supersedes the mtime-only `isUpToDate` when the
 * existing manifest recorded a source `fingerprint`. mtime ALONE never certifies freshness:
 *
 *  - replaced bytes with a PRESERVED mtime → STALE (size/quickHash differ),
 *  - a pure `touch` (bumped mtime, same size+quickHash) → FRESH.
 *
 * `existing`  : the persisted manifest (its `master.fingerprint`, if any, is the last-ingest sample).
 * `observed`  : the file as seen now (SourceFingerprint incl. mtimeMs — mtime is ignored for the
 *               freshness verdict, matching source-identity `isFresh`).
 * `proxy`     : caller wants a proxy manifest → only proxy manifests are ever fresh (mirrors isUpToDate).
 *
 * Legacy manifests (no recorded fingerprint) fall back to mtime-only freshness so pre-Task-5 catalogs
 * still skip correctly. The persisted fingerprint has no mtimeMs of its own; the manifest's
 * `master.mtimeMs` supplies it for the SourceFingerprint shape (mtime is not used in the comparison).
 */
export function isSourceFresh(existing: Manifest, observed: SourceFingerprint, proxy = false): boolean {
  const proxyOk = proxy ? existing.proxy === true : existing.proxy !== true;
  if (!proxyOk) return false;
  const fp = (existing.master as MasterInfo & { fingerprint?: MasterFingerprint }).fingerprint;
  if (fp === undefined) {
    // Pre-Task-5 manifest: no content sample recorded → fall back to mtime equality.
    return existing.master.mtimeMs === observed.mtimeMs;
  }
  const existingFp: SourceFingerprint = {
    byteLength: fp.byteLength,
    mtimeMs: existing.master.mtimeMs,
    quickHash: fp.quickHash,
    ...(fp.contentHash !== undefined ? { contentHash: fp.contentHash } : {}),
  };
  return isFresh(existingFp, observed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy binary manifest/index codec (compatibility read/write; NOT canonical).
// ─────────────────────────────────────────────────────────────────────────────
// The tight binary format is LOSSY for the full schema (it cannot carry v5 descriptors,
// metadata, layout, stub, or unknown fields). It is retained only to read/write on-disk
// manifests already in that format. The canonical persisted representation is JSON via
// schema.ts `manifestToJson` (lossless for the complete schema, unknown fields preserved).
//
// finding 61: the binary implementation lives in the focused, cycle-free `manifest-codec.ts`
// module (statically imported — no CommonJS `require`). These thin wrappers validate the decoded
// object through zod so callers get a fully-typed Manifest/GalleryIndex.
//
// M-3: the binary WRITE API (manifestToBinary / indexToBinary) was dead (zero callers) and lossy for
// the v5 schema — removed. The canonical persisted form is JSON (`manifestToJson`). Only the
// read-only DECODERS remain, so on-disk manifests already in the legacy binary format still parse.
import {
  binaryToManifestObject,
  binaryToGalleryIndexObject,
} from "./manifest-codec.js";

/** Decode a legacy binary manifest and validate it. */
export function binaryToManifest(data: Uint8Array): Manifest {
  return manifestSchema.parse(binaryToManifestObject(data)) as Manifest;
}

/** Decode a legacy binary gallery index. */
export function binaryToGalleryIndex(data: Uint8Array): GalleryIndex {
  return binaryToGalleryIndexObject(data);
}