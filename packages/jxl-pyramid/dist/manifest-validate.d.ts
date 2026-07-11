import type { PyramidManifest, GalleryIndex } from "./manifest.js";
export declare const MANIFEST_SCHEMA_VERSION = 5;
export declare const READABLE_MANIFEST_SCHEMAS: readonly number[];
export declare const INDEX_SCHEMA_VERSION = 1;
export declare class ManifestValidationError extends Error {
    readonly path: string;
    constructor(message: string, path: string);
}
/**
 * Reads schema 1|2|4|5 (3 was skipped). Normalizes schema 1 → 2 (stub=false, proxy=false); keeps
 * 4 and 5. On v5, `orientation` is an OrientationDescriptor; on v1–v4 it is the legacy string.
 * Unknown top-level fields are preserved. Throws ManifestValidationError on schema 3, schema > 5,
 * or any invalid field.
 */
export declare function parsePyramidManifest(json: unknown): PyramidManifest;
export declare function parseGalleryIndex(json: unknown): GalleryIndex;
//# sourceMappingURL=manifest-validate.d.ts.map