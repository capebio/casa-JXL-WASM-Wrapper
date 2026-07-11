// Focused, self-contained binary manifest/index codec (finding 61).
//
// This module has NO dependency on schema.ts (and therefore no import cycle): it decodes bytes into
// a PLAIN object and lets the caller (parseManifest / parseGalleryIndex in schema.ts) validate. That
// keeps the ESM dependency graph static and acyclic (schema.ts → manifest-codec.ts, one direction),
// so schema.ts no longer needs the runtime `require("./manifest.js")` CommonJS-in-ESM shim.
//
// LOSSY BY DESIGN — READ-ONLY LEGACY PATH. The binary format encodes only the known v1–v4 scalar
// fields; it cannot carry the v5 OrientationDescriptor, TilingDescriptor, master.sourceFormat,
// metadata, layout, stub, or unknown extension fields. It is therefore NOT the canonical persisted
// representation. The canonical write path is JSON (manifestToJson), which is lossless for the
// complete schema including unknown fields. These decoders exist only to READ manifests/indexes that
// were already persisted in the binary format by older writers (a read/migrate decision — never a
// silent reinterpretation: the decoded object is re-validated by parseManifest before use).

import type { LevelEntry } from "./schema.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Plain (unvalidated) decoded manifest shape produced by binaryToManifestObject. */
export type DecodedBinaryManifest = {
  schema: number;
  imageId: string;
  master: { name: string; format: "unknown"; mtimeMs: number };
  orientation: "baked" | "source";
  width: number;
  height: number;
  aspect: number;
  levels: LevelEntry[];
  proxy?: true;
  producedBy?: {
    tool: "pyramid-ingest";
    version: string;
    encoder: { effort: number; quality: { grid: number; big: number; proxy: number } };
  };
};

/** Plain (unvalidated) decoded gallery-index shape. */
export type DecodedBinaryGalleryIndex = {
  schema: 1;
  images: Array<{ imageId: string; aspect: number; l0: { contenthash: string; w: number; h: number } }>;
};

/** Encode a v1–v4 manifest to the tight binary format (−73% vs JSON). Record layout:
 * [u32 schema][u16 imageIdLen][imageId][u16 masterNameLen][masterName][f64 mtimeMs]
 * [u16 width][u16 height][f64 aspect][u8 orientation][u32 numLevels]
 * [foreach level: u16 size, u16 w, u16 h, u32 bytes, u8 bps, u8(16) contenthash, u8 tiled,
 *                 u8 hasConverged, u32 convergedByteEnd?, u8 hasCurve, u8 n, curve...]
 * [u8 proxy][u8 hasProducedBy][producedBy fields...]
 *
 * Only lossless for the scalar subset it knows; callers must not use it for v5 or manifests with
 * metadata / unknown fields (those go via JSON). Retained for compatibility with existing on-disk
 * binary manifests only.
 */
export function manifestToBinaryObject(manifest: {
  schema: number;
  imageId: string;
  master: { name: string; mtimeMs: number };
  orientation?: unknown;
  width?: number;
  height?: number;
  aspect?: number;
  levels?: LevelEntry[];
  proxy?: unknown;
  producedBy?: { version: string; encoder?: { effort?: number; quality?: { grid?: number; big?: number; proxy?: number } } };
}): Uint8Array {
  const levels = manifest.levels ?? [];
  const width = manifest.width ?? 0;
  const height = manifest.height ?? 0;
  const aspect = manifest.aspect ?? 0;
  let cap = 100;
  cap += 2 + (manifest.imageId?.length ?? 0) * 4;
  cap += 2 + (manifest.master?.name?.length ?? 0) * 4;
  cap += 4 * levels.length;
  for (const lv of levels) {
    cap += 2 + 2 + 2 + 4 + 1 + 16 + 1 + 1;
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
    enc.encodeInto(lv.contenthash, out.subarray(p));
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

/** Decode a binary manifest into a PLAIN object. Inverse of manifestToBinaryObject.
 *  Does NOT validate — the caller (parseManifest) runs the object through zod. */
export function binaryToManifestObject(data: Uint8Array): DecodedBinaryManifest {
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  let p = 0;

  const schema = dv.getUint32(p, true); p += 4;
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
        const ptBytes = dv.getUint32(p, true); p += 4;
        const ssim = dv.getFloat32(p, true); p += 4;
        const butteraugli = dv.getFloat32(p, true); p += 4;
        qualityCurve.push({
          bytes: ptBytes,
          ...(ssim >= 0 ? { ssim } : {}),
          ...(butteraugli >= 0 ? { butteraugli } : {}),
        });
      }
    }

    const size: LevelEntry["size"] = sizeVal === 0xffff ? "full" : sizeVal;
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
  let producedBy: DecodedBinaryManifest["producedBy"];
  if (hasProducedBy) {
    const verLen = dv.getUint16(p, true); p += 2;
    const version = dec.decode(data.subarray(p, p + verLen)); p += verLen;
    const effort = dv.getUint8(p); p += 1;
    const grid = dv.getUint8(p); p += 1;
    const big = dv.getUint8(p); p += 1;
    const proxyQual = dv.getUint8(p); p += 1;
    producedBy = {
      tool: "pyramid-ingest",
      version,
      encoder: {
        effort,
        quality: { grid, big, proxy: proxyQual },
      },
    };
  }

  return {
    schema,
    imageId,
    master: { name: masterName, format: "unknown", mtimeMs },
    orientation: orientation as "baked" | "source",
    width,
    height,
    aspect,
    levels,
    ...(proxy ? { proxy: true } : {}),
    ...(producedBy ? { producedBy } : {}),
  };
}

/** Encode gallery index to tight binary format (−71% vs JSON). Record layout:
 * [u32 schema][u32 numImages]
 * [foreach image: u8(16) imageId, f64 aspect, u8(16) l0.contenthash, u16 l0.w, u16 l0.h]
 */
export function indexToBinaryObject(index: DecodedBinaryGalleryIndex): Uint8Array {
  let cap = 8;
  cap += index.images.length * (16 + 8 + 16 + 2 + 2);

  const out = new Uint8Array(cap);
  const dv = new DataView(out.buffer);
  let p = 0;

  dv.setUint32(p, index.schema, true); p += 4;
  dv.setUint32(p, index.images.length, true); p += 4;

  for (const img of index.images) {
    enc.encodeInto(img.imageId, out.subarray(p));
    p += 16;
    dv.setFloat64(p, img.aspect, true); p += 8;
    enc.encodeInto(img.l0.contenthash, out.subarray(p));
    p += 16;
    dv.setUint16(p, img.l0.w, true); p += 2;
    dv.setUint16(p, img.l0.h, true); p += 2;
  }

  return out;
}

/** Decode a binary gallery index into a PLAIN object. Inverse of indexToBinaryObject. */
export function binaryToGalleryIndexObject(data: Uint8Array): DecodedBinaryGalleryIndex {
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  let p = 0;

  p += 4; // u32 schema discriminant (galleryIndex is always schema 1)
  const numImages = dv.getUint32(p, true); p += 4;

  const images: DecodedBinaryGalleryIndex["images"] = [];
  for (let i = 0; i < numImages; i++) {
    const imageId = dec.decode(data.subarray(p, p + 16)); p += 16;
    const aspect = dv.getFloat64(p, true); p += 8;
    const contenthash = dec.decode(data.subarray(p, p + 16)); p += 16;
    const w = dv.getUint16(p, true); p += 2;
    const h = dv.getUint16(p, true); p += 2;

    images.push({ imageId, aspect, l0: { contenthash, w, h } });
  }

  return { schema: 1, images };
}
