import { contentHash16 } from "./hash.js";
import type { MasterFormat, Orientation, PyramidLevelBytes } from "./backends.js";
import { makeProducedBy, manifestSchema, manifestSchemaV1 } from "./schema.js";
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

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Encode manifest to tight binary format (−73% vs JSON). Record layout:
 * [u32 schema][u16 imageIdLen][imageId][u16 masterNameLen][masterName][f64 mtimeMs]
 * [u16 width][u16 height][f64 aspect][u8 orientation][u32 numLevels]
 * [foreach level: u16 w, u16 h, u32 bytes, u8 bps, u8(16) contenthash, u8 tiled,
 *                 u8 hasConverged, u32 convergedByteEnd?, u8 hasCurve, u8(n) curve]
 * [u8 proxy][u8 hasProducedBy][producedBy fields...]
 */
export function manifestToBinary(manifest: Manifest): Uint8Array {
  // Pre-allocate with slack for optional fields; JSON serialization as fallback for unknown fields.
  // V1 manifests leave geometry/levels optional; default to a well-formed empty layout.
  const levels = manifest.levels ?? [];
  const width = manifest.width ?? 0;
  const height = manifest.height ?? 0;
  const aspect = manifest.aspect ?? 0;
  let cap = 100;
  cap += 2 + (manifest.imageId?.length ?? 0) * 4;
  cap += 2 + (manifest.master?.name?.length ?? 0) * 4;
  cap += 4 * levels.length;
  for (const lv of levels) {
    cap += 2 + 2 + 4 + 1 + 16 + 1 + 1;
    if (lv.convergedByteEnd) cap += 4;
    if (lv.qualityCurve?.length) cap += 1 + lv.qualityCurve.length * (4 + 4 + 4);
  }
  cap += (manifest.producedBy?.version?.length ?? 0) * 4 + 100;

  const out = new Uint8Array(cap);
  const dv = new DataView(out.buffer);
  let p = 0;

  dv.setUint32(p, manifest.schema, true); p += 4;

  const idEnc = enc.encodeInto(manifest.imageId, out.subarray(p + 2));
  dv.setUint16(p, idEnc.written, true); p += 2 + idEnc.written;

  const nameEnc = enc.encodeInto(manifest.master.name, out.subarray(p + 2));
  dv.setUint16(p, nameEnc.written, true); p += 2 + nameEnc.written;

  // mtimeMs is ms-since-epoch (~1.75e12) which overflows u32; store as f64 (exact to 2^53).
  dv.setFloat64(p, manifest.master.mtimeMs, true); p += 8;
  dv.setUint16(p, width, true); p += 2;
  dv.setUint16(p, height, true); p += 2;
  dv.setFloat64(p, aspect, true); p += 8;
  dv.setUint8(p, manifest.orientation === "source" ? 1 : 0); p += 1;
  dv.setUint32(p, levels.length, true); p += 4;

  for (const lv of levels) {
    const sizeVal = lv.size === "full" ? 0xffff : (lv.size as number);
    dv.setUint16(p, sizeVal, true); p += 2;
    dv.setUint16(p, lv.w, true); p += 2;
    dv.setUint16(p, lv.h, true); p += 2;
    dv.setUint32(p, lv.bytes, true); p += 4;
    dv.setUint8(p, lv.bitsPerSample); p += 1;
    const chEnc = enc.encodeInto(lv.contenthash, out.subarray(p));
    p += 16;
    dv.setUint8(p, lv.tiled ? 1 : 0); p += 1;
    dv.setUint8(p, lv.convergedByteEnd != null ? 1 : 0); p += 1;
    if (lv.convergedByteEnd != null) {
      dv.setUint32(p, lv.convergedByteEnd, true); p += 4;
    }
    const hasCurve = lv.qualityCurve && lv.qualityCurve.length > 0 ? 1 : 0;
    dv.setUint8(p, hasCurve); p += 1;
    if (hasCurve) {
      dv.setUint8(p, lv.qualityCurve!.length); p += 1;
      for (const pt of lv.qualityCurve!) {
        dv.setUint32(p, pt.bytes, true); p += 4;
        dv.setFloat32(p, pt.ssim ?? -1, true); p += 4;
        dv.setFloat32(p, pt.butteraugli ?? -1, true); p += 4;
      }
    }
  }

  dv.setUint8(p, manifest.proxy === true ? 1 : 0); p += 1;
  dv.setUint8(p, manifest.producedBy ? 1 : 0); p += 1;
  if (manifest.producedBy) {
    const pb = manifest.producedBy;
    const verEnc = enc.encodeInto(pb.version, out.subarray(p + 2));
    dv.setUint16(p, verEnc.written, true); p += 2 + verEnc.written;
    dv.setUint8(p, pb.encoder?.effort ?? 5); p += 1;
    dv.setUint8(p, pb.encoder?.quality?.grid ?? 90); p += 1;
    dv.setUint8(p, pb.encoder?.quality?.big ?? 90); p += 1;
    dv.setUint8(p, pb.encoder?.quality?.proxy ?? 70); p += 1;
  }

  return out.subarray(0, p);
}

/** Decode binary manifest format back to Manifest object. Inverse of manifestToBinary. */
export function binaryToManifest(data: Uint8Array): Manifest {
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  let p = 0;

  const schema = dv.getUint32(p, true) as 1 | 2 | 4; p += 4;
  const idLen = dv.getUint16(p, true); p += 2;
  const imageId = dec.decode(data.subarray(p, p + idLen)); p += idLen;
  const nameLen = dv.getUint16(p, true); p += 2;
  const masterName = dec.decode(data.subarray(p, p + nameLen)); p += nameLen;
  const mtimeMs = dv.getFloat64(p, true); p += 8;
  const width = dv.getUint16(p, true); p += 2;
  const height = dv.getUint16(p, true); p += 2;
  const aspect = dv.getFloat64(p, true); p += 8;
  const orientationByte = dv.getUint8(p); p += 1;
  const orientation = orientationByte === 1 ? "source" : "baked";
  const numLevels = dv.getUint32(p, true); p += 4;

  const levels: LevelEntry[] = [];
  for (let i = 0; i < numLevels; i++) {
    const sizeVal = dv.getUint16(p, true); p += 2;
    const w = dv.getUint16(p, true); p += 2;
    const h = dv.getUint16(p, true); p += 2;
    const bytes = dv.getUint32(p, true); p += 4;
    const bitsPerSample = dv.getUint8(p) as 8 | 16; p += 1;
    const contenthash = dec.decode(data.subarray(p, p + 16)); p += 16;
    const tiled = dv.getUint8(p) === 1; p += 1;
    const hasConverged = dv.getUint8(p) === 1; p += 1;
    let convergedByteEnd: number | undefined;
    if (hasConverged) {
      convergedByteEnd = dv.getUint32(p, true); p += 4;
    }
    const hasCurve = dv.getUint8(p) === 1; p += 1;
    let qualityCurve: NonNullable<LevelEntry["qualityCurve"]> | undefined;
    if (hasCurve) {
      const curveLen = dv.getUint8(p); p += 1;
      qualityCurve = [];
      for (let j = 0; j < curveLen; j++) {
        const bytes = dv.getUint32(p, true); p += 4;
        const ssim = dv.getFloat32(p, true); p += 4;
        const butteraugli = dv.getFloat32(p, true); p += 4;
        qualityCurve.push({
          bytes,
          ...(ssim >= 0 ? { ssim } : {}),
          ...(butteraugli >= 0 ? { butteraugli } : {}),
        });
      }
    }

    const size = sizeVal === 0xffff ? "full" : sizeVal;
    levels.push({
      size,
      w,
      h,
      bytes,
      bitsPerSample,
      contenthash,
      tiled,
      ...(convergedByteEnd ? { convergedByteEnd } : {}),
      ...(qualityCurve ? { qualityCurve } : {}),
    });
  }

  const proxy = dv.getUint8(p) === 1; p += 1;
  const hasProducedBy = dv.getUint8(p) === 1; p += 1;
  let producedBy;
  if (hasProducedBy) {
    const verLen = dv.getUint16(p, true); p += 2;
    const version = dec.decode(data.subarray(p, p + verLen)); p += verLen;
    const effort = dv.getUint8(p); p += 1;
    const grid = dv.getUint8(p); p += 1;
    const big = dv.getUint8(p); p += 1;
    const proxyQual = dv.getUint8(p); p += 1;
    producedBy = {
      tool: "pyramid-ingest" as const,
      version,
      encoder: {
        effort,
        quality: { grid, big, proxy: proxyQual },
      },
    };
  }

  const base = {
    schema,
    imageId,
    master: { name: masterName, format: "unknown" as const, mtimeMs },
    orientation: orientation as "baked" | "source",
    width,
    height,
    aspect,
    levels,
    ...(proxy ? { proxy: true as const } : {}),
    ...(producedBy ? { producedBy } : {}),
  };

  return manifestSchema.parse(base) as any;
}

/** Encode gallery index to tight binary format (−71% vs JSON). Record layout:
 * [u32 schema][u32 numImages]
 * [foreach image: u8(16) imageId, f64 aspect, u8(16) l0.contenthash, u16 l0.w, u16 l0.h]
 */
export function indexToBinary(index: GalleryIndex): Uint8Array {
  let cap = 8; // version + count
  cap += index.images.length * (16 + 8 + 16 + 2 + 2);

  const out = new Uint8Array(cap);
  const dv = new DataView(out.buffer);
  let p = 0;

  dv.setUint32(p, index.schema, true); p += 4;
  dv.setUint32(p, index.images.length, true); p += 4;

  for (const img of index.images) {
    const idEnc = enc.encodeInto(img.imageId, out.subarray(p));
    p += 16;
    dv.setFloat64(p, img.aspect, true); p += 8;
    const chEnc = enc.encodeInto(img.l0.contenthash, out.subarray(p));
    p += 16;
    dv.setUint16(p, img.l0.w, true); p += 2;
    dv.setUint16(p, img.l0.h, true); p += 2;
  }

  return out;
}

/** Decode binary gallery index format back to GalleryIndex. Inverse of indexToBinary. */
export function binaryToGalleryIndex(data: Uint8Array): GalleryIndex {
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  let p = 0;

  p += 4; // u32 schema discriminant (galleryIndex is always schema 1)
  const numImages = dv.getUint32(p, true); p += 4;

  const images: IndexEntry[] = [];
  for (let i = 0; i < numImages; i++) {
    const imageId = dec.decode(data.subarray(p, p + 16)); p += 16;
    const aspect = dv.getFloat64(p, true); p += 8;
    const contenthash = dec.decode(data.subarray(p, p + 16)); p += 16;
    const w = dv.getUint16(p, true); p += 2;
    const h = dv.getUint16(p, true); p += 2;

    images.push({
      imageId,
      aspect,
      l0: { contenthash, w, h },
    });
  }

  return { schema: 1, images };
}