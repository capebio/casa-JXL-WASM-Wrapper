import { contentHash16 } from "./hash.js";
import type { MasterFormat, Orientation, PyramidLevelBytes } from "./backends.js";
import { makeProducedBy, manifestSchema } from "./schema.js";
import type {
  Manifest,
  IndexEntry,
  GalleryIndex,
  LevelEntry,
  LevelEntryV5,
  LevelSize,
  MasterInfo,
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
  master: MasterInfo;
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
  return {
    imageId: manifest.imageId,
    aspect: manifest.aspect,
    l0: { contenthash: l0.contenthash, w: l0.w, h: l0.h },
  };
}

export function isUpToDate(existing: Manifest, mtimeMs: number, proxy = false): boolean {
  // mtime exact match (low-mtime-rounding): drop rounding for determinism; fs mtimes are comparable at ms.
  // P7: proxy flag match for skip (when caller requests proxy, only proxy manifests count as uptodate)
  const proxyOk = proxy ? existing.proxy === true : existing.proxy !== true;
  return proxyOk && existing.master.mtimeMs === mtimeMs;
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
import {
  manifestToBinaryObject,
  binaryToManifestObject,
  indexToBinaryObject,
  binaryToGalleryIndexObject,
} from "./manifest-codec.js";

/** Encode a manifest to the legacy tight binary format. Lossy for v5/metadata/unknown fields —
 *  prefer `manifestToJson` for canonical persistence. */
export function manifestToBinary(manifest: Manifest): Uint8Array {
  return manifestToBinaryObject(manifest as any);
}

/** Decode a legacy binary manifest and validate it. */
export function binaryToManifest(data: Uint8Array): Manifest {
  return manifestSchema.parse(binaryToManifestObject(data)) as Manifest;
}

/** Encode a gallery index to the legacy tight binary format. */
export function indexToBinary(index: GalleryIndex): Uint8Array {
  return indexToBinaryObject(index);
}

/** Decode a legacy binary gallery index. */
export function binaryToGalleryIndex(data: Uint8Array): GalleryIndex {
  return binaryToGalleryIndexObject(data);
}