// constants.ts
// Constants for the Pyramid Gallery Pipeline (M0-M4).
// Conforms strictly to the 2026-06-07-pyramid-gallery-design.md specification.

import type { MasterFormat, Orientation } from "./manifest.js";

/** Resolution level ladder target sizes (long-edge in pixels) */
export const PYRAMID_LEVEL_SIZES = [256, 512, 1024, 2048] as const;

export {
  MASSIVE_LONG_EDGE_THRESHOLD,
  MASSIVE_PIXEL_THRESHOLD,
  JXTC_TILE_SIZE,
} from "./tiling.js";

/** Allowed proxy target sizes (long-edge in pixels) */
export const PROXY_SIZES = [256, 512, 1024] as const;

/** Default proxy target size when none is specified */
export const DEFAULT_PROXY_SIZE = 512 as const;

/** Allowed master image file formats */
export const ALLOWED_FORMATS: readonly MasterFormat[] = ["orf", "dng", "cr2", "jpg"] as const;

/** Allowed orientation strategies (v1–v4 legacy string form). */
export const ORIENTATION_VALUES: readonly Orientation[] = ["baked", "source"] as const;

/** v5 OrientationDescriptor.pixels values (whether stored level pixels are already upright). */
export const ORIENTATION_PIXELS_VALUES = ["source", "baked-upright"] as const;

/** v5 EXIF orientation is an integer in this inclusive range. */
export const EXIF_ORIENTATION_MIN = 1 as const;
export const EXIF_ORIENTATION_MAX = 8 as const;

/** Quality-to-Distance mappings for the libjxl encoder */
export const QUALITY_DISTANCES = {
  /** Grid levels {256, 512, 1024} and proxy mode */
  GRID_PRESET_Q85: 1.45,
  /** Big level {2048} and full RAW re-encodes */
  BIG_PRESET_Q95: 0.55,
  /** Lossless transcode / JPG full level */
  LOSSLESS_D0: 0.0,
} as const;

/** Quality levels mapped to target distances */
export const QUALITY_TO_DISTANCE_MAP = {
  85: QUALITY_DISTANCES.GRID_PRESET_Q85,
  95: QUALITY_DISTANCES.BIG_PRESET_Q95,
  100: QUALITY_DISTANCES.LOSSLESS_D0,
} as const;

/** Lightbox adjustment parameters */
export const ADJUSTMENT_PARAMS = [
  "brightness",
  "contrast",
  "saturation",
  "shadows",
  "highlights",
  "clarity",
  "dehaze",
  "sharpness",
] as const;

export type AdjustmentParam = (typeof ADJUSTMENT_PARAMS)[number];

/** Approved lightbox preset names from the CasaBio FilterEngine model */
export enum LightboxPreset {
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
  NONE = "NONE",
}

/** Array of approved lightbox preset names for runtime checking */
export const APPROVED_LIGHTBOX_PRESETS: readonly LightboxPreset[] = [
  LightboxPreset.BW,
  LightboxPreset.BW_HIGH,
  LightboxPreset.BW_SOFT,
  LightboxPreset.SEPIA,
  LightboxPreset.INVERT,
  LightboxPreset.BOTANICAL,
  LightboxPreset.WARM,
  LightboxPreset.COOL,
  LightboxPreset.DEHAZE,
  LightboxPreset.BLUEPRINT,
  LightboxPreset.CHLOROPHYLL,
  LightboxPreset.NONE,
] as const;
