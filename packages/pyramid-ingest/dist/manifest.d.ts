import type { Orientation, PyramidLevelBytes } from "./backends.js";
import type { Manifest, IndexEntry, GalleryIndex, LevelEntryV5, LevelSize, MasterInfo } from "./schema.js";
export type { Manifest, IndexEntry, GalleryIndex, LevelEntry, LevelEntryV5, LevelSize, MasterInfo, } from "./schema.js";
export declare function levelSize(w: number, h: number, masterW: number, masterH: number): LevelSize;
export declare function toEntry(level: PyramidLevelBytes, masterW: number, masterH: number): LevelEntryV5;
export declare function buildManifest(args: {
    imageId: string;
    master: MasterInfo;
    orientation: Orientation;
    width: number;
    height: number;
    levels: LevelEntryV5[];
    proxy?: boolean;
}): Manifest;
export declare function buildIndexEntry(manifest: Manifest): IndexEntry;
export declare function isUpToDate(existing: Manifest, mtimeMs: number, proxy?: boolean): boolean;
/** Decode a legacy binary manifest and validate it. */
export declare function binaryToManifest(data: Uint8Array): Manifest;
/** Decode a legacy binary gallery index. */
export declare function binaryToGalleryIndex(data: Uint8Array): GalleryIndex;
//# sourceMappingURL=manifest.d.ts.map