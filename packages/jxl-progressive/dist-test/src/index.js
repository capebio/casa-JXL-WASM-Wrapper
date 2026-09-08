// packages/jxl-progressive/src/index.ts
// Manifest
export { validateManifest, lookupTier, checkHash, migrateManifest, tierPixelDims, buildTiersFromOffsets, PROGRESSIVE_MANIFEST_VERSION, ManifestValidationError, ManifestStaleError, } from "./progressive-manifest.js";
// S6: unified LOD/ROI resolver (one request language across progressive | pyramid | jxtc)
export { resolveLod, toHttpRange, fromProgressiveManifest, fromPyramidLevels, fromJxtcContainer, LodResolveError, } from "./lod-resolver.js";
// Saliency policy
export { shouldUseSaliency, normaliseCenter, selectBestCenter, } from "./saliency-policy.js";
// Profiler
export { profileJxl, profileJxlFile, } from "./progressive-profile.js";
// Stream
export { fetchTier, fetchFull, streamTierFrames, } from "./progressive-stream.js";
// Cache
export { ProgressiveCache } from "./progressive-cache.js";
// Scheduler
export { ProgressiveGallery, tierRank, fairnessScore, } from "./progressive-scheduler.js";
// Perceptual metrics + scale frontier + tiered serving (Phase A/B)
export { psnrVsRef, ssimVsRef, meetsThreshold } from "./progressive-metrics.js";
export { selectTierForDisplay, selectFrontierTier } from "./progressive-scale.js";
export { selectTiersByScore, buildScaleFrontier } from "./progressive-profile.js";
export { makeButteraugliScorer, makeWasmDownscaler } from "./progressive-adapters.js";
// Tiered serving: lazy manifest service + authoritative edge resolver (Phase 4)
export { getOrBuildManifest } from "./progressive-service.js";
export { resolveTierRequest } from "./progressive-edge.js";
//# sourceMappingURL=index.js.map