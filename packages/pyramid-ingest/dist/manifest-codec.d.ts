import type { LevelEntry } from "./schema.js";
/** Plain (unvalidated) decoded manifest shape produced by binaryToManifestObject. */
export type DecodedBinaryManifest = {
    schema: number;
    imageId: string;
    master: {
        name: string;
        format: "unknown";
        mtimeMs: number;
    };
    orientation: "baked" | "source";
    width: number;
    height: number;
    aspect: number;
    levels: LevelEntry[];
    proxy?: true;
    producedBy?: {
        tool: "pyramid-ingest";
        version: string;
        encoder: {
            effort: number;
            quality: {
                grid: number;
                big: number;
                proxy: number;
            };
        };
    };
};
/** Plain (unvalidated) decoded gallery-index shape. */
export type DecodedBinaryGalleryIndex = {
    schema: 1;
    images: Array<{
        imageId: string;
        aspect: number;
        l0: {
            contenthash: string;
            w: number;
            h: number;
        };
    }>;
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
export declare function manifestToBinaryObject(manifest: {
    schema: number;
    imageId: string;
    master: {
        name: string;
        mtimeMs: number;
    };
    orientation?: unknown;
    width?: number;
    height?: number;
    aspect?: number;
    levels?: LevelEntry[];
    proxy?: unknown;
    producedBy?: {
        version: string;
        encoder?: {
            effort?: number;
            quality?: {
                grid?: number;
                big?: number;
                proxy?: number;
            };
        };
    };
}): Uint8Array;
/** Decode a binary manifest into a PLAIN object. Inverse of manifestToBinaryObject.
 *  Does NOT validate — the caller (parseManifest) runs the object through zod. */
export declare function binaryToManifestObject(data: Uint8Array): DecodedBinaryManifest;
/** Encode gallery index to tight binary format (−71% vs JSON). Record layout:
 * [u32 schema][u32 numImages]
 * [foreach image: u8(16) imageId, f64 aspect, u8(16) l0.contenthash, u16 l0.w, u16 l0.h]
 */
export declare function indexToBinaryObject(index: DecodedBinaryGalleryIndex): Uint8Array;
/** Decode a binary gallery index into a PLAIN object. Inverse of indexToBinaryObject. */
export declare function binaryToGalleryIndexObject(data: Uint8Array): DecodedBinaryGalleryIndex;
//# sourceMappingURL=manifest-codec.d.ts.map