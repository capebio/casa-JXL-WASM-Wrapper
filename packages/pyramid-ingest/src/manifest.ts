import { contentHash16 } from "./hash.js";
import type { MasterFormat, Orientation, PyramidLevelBytes } from "./backends.js";
import { makeProducedBy, manifestSchema } from "./schema.js";
import type {
  Manifest,
  IndexEntry,
  GalleryIndex,
  LevelEntry,
  LevelSize,
  MasterInfo,
} from "./schema.js";

export type {
  Manifest,
  IndexEntry,
  GalleryIndex,
  LevelEntry,
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

export function toEntry(level: PyramidLevelBytes, masterW: number, masterH: number): LevelEntry {
  return {
    size: levelSize(level.width, level.height, masterW, masterH),
    w: level.width,
    h: level.height,
    bytes: level.data.length,
    bitsPerSample: level.bitsPerSample ?? 8,
    contenthash: contentHash16(level.data),
    tiled: level.tiled === true,
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
  levels: LevelEntry[];
  proxy?: boolean;
}): Manifest {
  const levels = [...args.levels].sort((a, b) => a.w * a.h - b.w * b.h);
  const base = {
    schema: 2 as const,  // V3 Phase2 (discrim + compat; v1 still readable)
    imageId: args.imageId,
    master: args.master,
    orientation: args.orientation,
    width: args.width,
    height: args.height,
    aspect: round4(args.width / args.height),
    levels,
    producedBy: makeProducedBy(),
    ...(args.proxy ? { proxy: true as const } : {}),
  };
  return manifestSchema.parse(base) as any;  // V3 union (accepts 1 or 2); emitted schema:2 now
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