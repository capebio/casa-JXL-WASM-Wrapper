import type { PyramidEncodeOptions } from "./backends.js";
/** libjxl quality->distance: distance = 0.1 + (100 - q) * 0.09, with q=100 lossless (0).
 * low-quality-discontinuity: we clamp to int; 99.5+ becomes 100 (lossless). Pixel det holds; byte may differ vs float path.
 */
export declare function qualityToDistance(quality: number): number;
export declare const EFFORT = 3;
export declare const GRID_QUALITY = 85;
export declare const BIG_QUALITY = 95;
export declare const PROXY_QUALITY = 85;
/** D1/F9: Byte-determinism guaranteed only with --encoder-threads 1 (forces non-MT tier).
 * Production default multi-threaded (mt tiers) for speed. Pixel-determinism (PSNR > 60 dB vs ref) holds either way.
 * libjxl internal thread sched affects bitstream at effort>=3 in MT.
 */
export declare const LEVEL_SIZES: readonly [256, 512, 1024, 2048];
export declare const NEAR_FULL_RATIO = 1.15;
export declare const GRID_MAX_LONG = 1024;
export declare const BIG_MIN_LONG = 2048;
export declare const GRID_DISTANCE: number;
export declare const BIG_DISTANCE: number;
export declare const PROXY_DISTANCE: number;
export declare function planLadder(masterLong?: number): PyramidEncodeOptions;
export declare function planProxy(size: number): PyramidEncodeOptions;
//# sourceMappingURL=quality.d.ts.map