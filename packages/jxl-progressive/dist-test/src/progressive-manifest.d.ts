export type TierName = "dc" | "preview" | "full";
import type { CameraPose, Relation, FrameSetMember, FrameSet, AssetChannel, ChannelDescriptor } from "./types.js";
export type { CameraPose, Relation, FrameSetMember, FrameSet, AssetChannel, ChannelDescriptor };
export type ScoreMetric = "ssim" | "psnr" | "butteraugli";
/**
 * S6 schema v2: the current manifest schema version. `validateManifest` accepts
 * versions 1..=PROGRESSIVE_MANIFEST_VERSION and rejects anything newer (following the
 * pyramid reader's "tolerate older, reject newer" pattern). v1 manifests parse unchanged
 * — every v2 field is optional and default-filled on read.
 */
export declare const PROGRESSIVE_MANIFEST_VERSION: 2;
/**
 * S6 schema v2 (additive): which LOD/ROI request axes an asset can serve. Lets the
 * unified `lod-resolver` decide, without probing bytes, whether a `{level|region|quality}`
 * request is answerable. All fields optional; absent = unknown (resolver falls back).
 *   quality    — byte-prefix quality tiers available (this is always true for progressive).
 *   resolution — distinct intrinsic resolutions available (per-tier pixel dims / pyramid).
 *   region     — spatial ROI addressable (tiled / JXTC).
 */
export interface AssetCapabilities {
    quality?: boolean;
    resolution?: boolean;
    region?: boolean;
}
export interface TierScore {
    metric: ScoreMetric;
    /** Metric value of this tier's partial reconstruction vs the reference. */
    value: number;
    /** What the score compares against: the file's own final frame, or the encoder source. */
    reference: "final" | "source";
}
export interface ManifestTier {
    name: TierName;
    byteStart: number;
    byteEnd: number;
    progressionIndex: number | "final";
    intendedUse: string;
    /** Optional measured perceptual score for this tier (Phase A). */
    score?: TierScore;
    /**
     * S6 schema v2 (additive): the intrinsic resolution this tier reconstructs, in pixels.
     * A DC prefix reconstructs at ~ceil(source/8); the `full` tier at source dims. Encoder
     * emits these so the resolver can match a `level` (target long-edge) request to the
     * smallest sufficient tier. Absent on v1 manifests → `tierPixelDims` default-fills with
     * the source dimensions.
     */
    pixelWidth?: number;
    pixelHeight?: number;
}
/**
 * K2: build progressive tiers directly from encoder-derived byte offsets — the
 * exact progressive-pass boundaries of a SINGLE codestream (raw-pipeline's
 * `progressive_tier_offsets` / `VariantSet.full_offsets`), instead of the old
 * 4 KiB-granular re-decode profiler. `offsets` is strictly ascending with
 * `offsets.at(-1) === jxlByteLength`. Always emits `dc` (offsets[0]) and `full`
 * (the last offset); emits `preview` only when a distinct pass boundary at or below
 * ~70% of the file exists strictly between them. Tiers are cumulative from byte 0
 * (consumers `Range`-fetch `bytes=0-{byteEnd-1}`), so `byteStart` is always 0.
 */
export declare function buildTiersFromOffsets(offsets: readonly number[]): ManifestTier[];
export interface ScaleFrontierEntry {
    /** Longest-edge display pixels this entry covers (inclusive upper bound). */
    maxDisplayPx: number;
    tier: TierName;
    /** Denormalized from tiers[tier].byteEnd so a consumer can Range-fetch directly. */
    byteEnd: number;
    score: TierScore;
}
export interface ProgressiveManifest {
    /** 1 = original schema; 2 = S6 (per-tier pixel dims + asset capabilities). Readers accept both. */
    version: 1 | 2;
    source: {
        width: number;
        height: number;
        hasAlpha: boolean;
        orientation: number;
    };
    jxl: {
        bytes: number;
        sha256: string;
    };
    encoder: {
        name: string;
        libjxlVersion: string;
        flags: string[];
    };
    saliency?: {
        enabled: boolean;
        centerX: number;
        centerY: number;
        confidence: number;
        method: string;
    };
    /** Optional passthrough for future perceptual / non-Riemannian color engine params
     *  (e.g. from advanced LookRenderer / LUT / geodesic). Transported via manifest to
     *  onManifest consumers for illumination-invariant adjustments etc. No cost here.
     */
    perceptual?: Record<string, unknown>;
    tiers: ManifestTier[];
    /** Optional display-scale → earliest-sufficient-tier frontier (Phase B). */
    scaleFrontier?: ScaleFrontierEntry[];
    /**
     * S6 schema v2 (additive): the LOD/ROI axes this asset can serve, for the unified
     * `lod-resolver`. Optional; absent on v1 manifests (resolver derives from the tiers).
     */
    capabilities?: AssetCapabilities;
    capture?: {
        pose?: CameraPose;
        intrinsics?: FrameSetMember["intrinsics"];
        extrinsics?: FrameSetMember["extrinsics"];
        depthLayer?: FrameSetMember["depthLayer"];
        featureSidecar?: FrameSetMember["featureSidecar"];
    };
    /** Concurrent loadable channels alongside rgb (PG4). */
    channels?: AssetChannel[];
    channelDescriptors?: ChannelDescriptor[];
}
export declare class ManifestValidationError extends Error {
    readonly field: string;
    constructor(message: string, field: string);
}
export declare class ManifestStaleError extends Error {
    constructor(message: string);
}
export declare function validateManifest(json: unknown): ProgressiveManifest;
/**
 * S6: the intrinsic pixel dims a tier reconstructs. Returns the tier's own v2
 * `pixelWidth`/`pixelHeight` when present, else default-fills with the source dims (a v1
 * manifest carries no per-tier resolution — the safe assumption is source resolution).
 */
export declare function tierPixelDims(manifest: ProgressiveManifest, tier: ManifestTier): {
    width: number;
    height: number;
};
export declare function lookupTier(manifest: ProgressiveManifest, name: TierName): ManifestTier | undefined;
export declare function checkHash(manifest: ProgressiveManifest, jxlBytes: ArrayBuffer): Promise<boolean>;
export declare function migrateManifest(json: unknown): ProgressiveManifest;
//# sourceMappingURL=progressive-manifest.d.ts.map