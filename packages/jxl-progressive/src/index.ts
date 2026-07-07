// packages/jxl-progressive/src/index.ts

// Manifest
export {
  validateManifest,
  lookupTier,
  checkHash,
  migrateManifest,
  tierPixelDims,
  buildTiersFromOffsets,
  PROGRESSIVE_MANIFEST_VERSION,
  ManifestValidationError,
  ManifestStaleError,
} from "./progressive-manifest.js";
export type {
  TierName,
  ManifestTier,
  ProgressiveManifest,
  AssetCapabilities,
} from "./progressive-manifest.js";

// S6: unified LOD/ROI resolver (one request language across progressive | pyramid | jxtc)
export {
  resolveLod,
  toHttpRange,
  fromProgressiveManifest,
  fromPyramidLevels,
  fromJxtcContainer,
  LodResolveError,
} from "./lod-resolver.js";
export type {
  LodRequest,
  LodAsset,
  ByteRange,
  ByteSource,
  LodMechanism,
  QualityTier,
  ResolutionLevel,
  JxtcGrid,
} from "./lod-resolver.js";

// Saliency policy
export {
  shouldUseSaliency,
  normaliseCenter,
  selectBestCenter,
} from "./saliency-policy.js";
export type { ImageType, ShouldUseSaliencyOpts } from "./saliency-policy.js";

// Profiler
export {
  profileJxl,
  profileJxlFile,
} from "./progressive-profile.js";
export type { ProfileOptions } from "./progressive-profile.js";

// Stream
export {
  fetchTier,
  fetchFull,
  streamTierFrames,
} from "./progressive-stream.js";
export type { TierFetchOptions } from "./progressive-stream.js";

// Cache
export { ProgressiveCache } from "./progressive-cache.js";
export type { ProgressiveCacheOptions } from "./progressive-cache.js";

// Scheduler
export {
  ProgressiveGallery,
  tierRank,
  fairnessScore,
} from "./progressive-scheduler.js";
export type {
  Tier,
  ProgressiveImageJob,
  GalleryOptions,
} from "./progressive-scheduler.js";

// Shared types
export type { SessionFactory } from "./types.js";

// Perceptual metrics + scale frontier + tiered serving (Phase A/B)
export { psnrVsRef, ssimVsRef, meetsThreshold } from "./progressive-metrics.js";
export type { MetricName, MetricScorer } from "./progressive-metrics.js";
export { selectTierForDisplay, selectFrontierTier } from "./progressive-scale.js";
export type { TierSelection } from "./progressive-scale.js";
export { selectTiersByScore, buildScaleFrontier } from "./progressive-profile.js";
export type { Downscaler, ScoredEvent, ScoredPass, ScoreThresholds, BuildFrontierArgs } from "./progressive-profile.js";
export { makeButteraugliScorer, makeWasmDownscaler } from "./progressive-adapters.js";
export type { ScaleFrontierEntry, TierScore, ScoreMetric } from "./progressive-manifest.js";

// Tiered serving: lazy manifest service + authoritative edge resolver (Phase 4)
export { getOrBuildManifest } from "./progressive-service.js";
export type { ManifestServiceDeps, ManifestRequest } from "./progressive-service.js";
export { resolveTierRequest } from "./progressive-edge.js";
export type { EdgeDeps, EdgeRequest, EdgeResolution, TierPolicy } from "./progressive-edge.js";
