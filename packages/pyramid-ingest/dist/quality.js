/** libjxl quality->distance: distance = 0.1 + (100 - q) * 0.09, with q=100 lossless (0).
 * low-quality-discontinuity: we clamp to int; 99.5+ becomes 100 (lossless). Pixel det holds; byte may differ vs float path.
 */
export function qualityToDistance(quality) {
    if (quality > 100) {
        throw new Error(`quality ${quality} out of range: >100 not supported`);
    }
    quality = Math.round(quality);
    if (quality >= 100)
        return 0;
    if (quality < 30) {
        throw new Error(`quality ${quality} out of range: libjxl distance mapping requires q >= 30`);
    }
    return 0.1 + (100 - quality) * 0.09;
}
// RATIFIED: effort=3 measured best speed+filesize (do not raise without new benchmark data)
export const EFFORT = 3;
export const GRID_QUALITY = 85;
export const BIG_QUALITY = 95;
export const PROXY_QUALITY = 85;
/** D1/F9: Byte-determinism guaranteed only with --encoder-threads 1 (forces non-MT tier).
 * Production default multi-threaded (mt tiers) for speed. Pixel-determinism (PSNR > 60 dB vs ref) holds either way.
 * libjxl internal thread sched affects bitstream at effort>=3 in MT.
 */
// RATIFIED Q8: 256 is the smallest level
export const LEVEL_SIZES = [256, 512, 1024, 2048];
export const NEAR_FULL_RATIO = 1.15; // sidecar within 15% of full → redundant ~2x storage of the largest level
export const GRID_MAX_LONG = 1024;
export const BIG_MIN_LONG = 2048;
// Module-load exhaustiveness guard (Q2). Prevents silent drop of future LEVEL_SIZES entries in ladder buckets.
for (const s of LEVEL_SIZES) {
    if (s > GRID_MAX_LONG && s < BIG_MIN_LONG) {
        throw new Error(`LEVEL_SIZES ${s} falls in no ladder bucket (grid<=${GRID_MAX_LONG}, big>=${BIG_MIN_LONG})`);
    }
}
// Q3: precompute distances at module load (removes repeated call overhead + throw paths from hot plan).
export const GRID_DISTANCE = qualityToDistance(GRID_QUALITY);
export const BIG_DISTANCE = qualityToDistance(BIG_QUALITY);
export const PROXY_DISTANCE = qualityToDistance(PROXY_QUALITY);
export function planLadder(masterLong) {
    // Q1: master-aware; filters to only meaningful targets (avoids callers re-filtering + the "one forgot" bug).
    let sizes = LEVEL_SIZES;
    if (masterLong !== undefined) {
        sizes = LEVEL_SIZES.filter((s) => s < masterLong && masterLong / s >= NEAR_FULL_RATIO);
    }
    const sidecars = sizes.map((s) => ({
        size: s,
        distance: s >= BIG_MIN_LONG ? BIG_DISTANCE : GRID_DISTANCE, // Q5: predicate wins (matches exported BIG_MIN_LONG from Q2)
    }));
    return {
        sidecars,
        fullDistance: BIG_DISTANCE,
        effort: EFFORT,
    };
}
export function planProxy(size) {
    return { sidecars: [{ size, distance: PROXY_DISTANCE }], fullDistance: PROXY_DISTANCE, effort: EFFORT };
}
//# sourceMappingURL=quality.js.map