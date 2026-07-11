import type { MasterFormat, Orientation } from "./manifest.js";
/** Resolution level ladder target sizes (long-edge in pixels) */
export declare const PYRAMID_LEVEL_SIZES: readonly [256, 512, 1024, 2048];
export { MASSIVE_LONG_EDGE_THRESHOLD, MASSIVE_PIXEL_THRESHOLD, JXTC_TILE_SIZE, } from "./tiling.js";
/** Allowed proxy target sizes (long-edge in pixels) */
export declare const PROXY_SIZES: readonly [256, 512, 1024];
/** Default proxy target size when none is specified */
export declare const DEFAULT_PROXY_SIZE: 512;
/** Allowed master image file formats */
export declare const ALLOWED_FORMATS: readonly MasterFormat[];
/** Allowed orientation strategies (v1–v4 legacy string form). */
export declare const ORIENTATION_VALUES: readonly Orientation[];
/** v5 OrientationDescriptor.pixels values (whether stored level pixels are already upright). */
export declare const ORIENTATION_PIXELS_VALUES: readonly ["source", "baked-upright"];
/** v5 EXIF orientation is an integer in this inclusive range. */
export declare const EXIF_ORIENTATION_MIN: 1;
export declare const EXIF_ORIENTATION_MAX: 8;
/** Quality-to-Distance mappings for the libjxl encoder */
export declare const QUALITY_DISTANCES: {
    /** Grid levels {256, 512, 1024} and proxy mode */
    readonly GRID_PRESET_Q85: 1.45;
    /** Big level {2048} and full RAW re-encodes */
    readonly BIG_PRESET_Q95: 0.55;
    /** Lossless transcode / JPG full level */
    readonly LOSSLESS_D0: 0;
};
/** Quality levels mapped to target distances */
export declare const QUALITY_TO_DISTANCE_MAP: {
    readonly 85: 1.45;
    readonly 95: 0.55;
    readonly 100: 0;
};
/** Lightbox adjustment parameters */
export declare const ADJUSTMENT_PARAMS: readonly ["brightness", "contrast", "saturation", "shadows", "highlights", "clarity", "dehaze", "sharpness"];
export type AdjustmentParam = (typeof ADJUSTMENT_PARAMS)[number];
/** Approved lightbox preset names from the CasaBio FilterEngine model */
export declare enum LightboxPreset {
    BW = "BW",
    BW_HIGH = "BW_HIGH",
    BW_SOFT = "BW_SOFT",
    SEPIA = "SEPIA",
    INVERT = "INVERT",
    BOTANICAL = "BOTANICAL",
    WARM = "WARM",
    COOL = "COOL",
    DEHAZE = "DEHAZE",
    BLUEPRINT = "BLUEPRINT",
    CHLOROPHYLL = "CHLOROPHYLL",
    NONE = "NONE"
}
/** Array of approved lightbox preset names for runtime checking */
export declare const APPROVED_LIGHTBOX_PRESETS: readonly LightboxPreset[];
//# sourceMappingURL=constants.d.ts.map