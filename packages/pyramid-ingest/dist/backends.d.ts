export type MasterFormat = "orf" | "dng" | "cr2" | "jpg";
export type RawFormat = "orf" | "dng" | "cr2";
export type Orientation = "baked" | "source";
export interface DecodedMaster {
    rgba: Uint8Array;
    /** M3: packed LE RGB u16 (6 bytes/pixel) from ProcessResult.take_rgb16_full. */
    rgb16?: Uint8Array;
    width: number;
    height: number;
    orientation: Orientation;
}
/** One measured point on a level's progressive quality curve (encode-time metrics; clients read these from the manifest instead of measuring at download time). */
export interface QualityCurvePoint {
    /** Compressed byte offset (bytes pushed) at which this progressive pass became decodable. */
    bytes: number;
    /** SSIM vs the level's own final pixels (1 = identical). Rounded to 6dp for manifest size. */
    ssim?: number;
    /** Butteraugli distance vs the level's own final pixels (0 = identical, ~1.0 imperceptible). Rounded to 4dp. */
    butteraugli?: number;
}
/** Result of profileConvergenceCurve: full per-pass curve + derived legacy cutoff. */
export interface ConvergenceProfile {
    /** Ascending by bytes; one point per progressive pass that could be measured. */
    curve: QualityCurvePoint[];
    /** First byte offset meeting ssim>=0.9995 || butteraugli<=1.1 (same semantics as profileConvergence). */
    convergedByteEnd?: number;
}
export interface PyramidLevelBytes {
    data: Uint8Array;
    width: number;
    height: number;
    bitsPerSample?: 8 | 16;
    tiled?: boolean;
    /** JXTC tile edge (px) when `tiled` — threaded to the v5 manifest TilingDescriptor.tileSize. */
    tileSize?: number;
    /** JXTC container version when `tiled` (defaults to 1). */
    tileVersion?: 1 | 2;
    /** populated by profileConvergence when --profile-convergence and saturation met on a pass */
    convergedByteEnd?: number;
    /** full per-pass quality curve measured at ingest (--profile-convergence); persisted to manifest so clients pick any byte/quality tradeoff without download-time metrics */
    qualityCurve?: QualityCurvePoint[];
    /** unlocked instrumentation (via O/runlog from WU-6+phase2): pixel bytes of the level buffer passed to encoder (downscale output size = JS/WASM materialization + staging copy size per level for current batch JXTC path). */
    stagedBytes?: number;
}
export interface TileContainerEncodeOptions {
    tileSize: number;
    distance: number;
    effort: number;
}
export interface PyramidEncodeOptions {
    fullDistance: number;
    sidecars: ReadonlyArray<{
        size: number;
        distance: number;
    }>;
    effort: number;
}
export interface RawBackend {
    decode(bytes: Uint8Array, format: RawFormat): Promise<DecodedMaster>;
}
export interface JxlBackend {
    encodePyramid(rgba: Uint8Array, width: number, height: number, opts: PyramidEncodeOptions): Promise<PyramidLevelBytes[]>;
    encodeTileContainer(rgba: Uint8Array, width: number, height: number, opts: TileContainerEncodeOptions): Promise<Uint8Array>;
    /** 16-bit JXTC path (available after JXTC-16 WASM rebuild; v1 tiled top uses 8-bit). */
    encodeTileContainer16?(rgba16: Uint8Array, width: number, height: number, opts: TileContainerEncodeOptions): Promise<Uint8Array>;
    /** Downscale helpers for per-level tiled encoding (Phase 3 all-levels JXTC). */
    downscaleRgba8(rgba: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number): Promise<Uint8Array>;
    downscaleRgba16?(rgba16: Uint16Array | Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number): Promise<Uint16Array | Uint8Array>;
    transcodeJpeg(jpeg: Uint8Array): Promise<Uint8Array>;
    decodeToRgba8(jxl: Uint8Array): Promise<{
        rgba: Uint8Array;
        width: number;
        height: number;
    }>;
    /** incremental progressive decode + SSIM (or butter) to find first visual saturation byte offset for the level's own final. returns undef if single-pass or below threshold or small level. */
    profileConvergence?(jxl: Uint8Array, w?: number, h?: number): Promise<number | undefined>;
    /** full-curve variant of profileConvergence: per-pass ssim/butteraugli vs the level's own final + derived convergedByteEnd. Measured once at encode; clients read the curve from the manifest. */
    profileConvergenceCurve?(jxl: Uint8Array, w?: number, h?: number): Promise<ConvergenceProfile | undefined>;
}
export interface Telemetry {
    stage(name: string, fields?: Record<string, unknown>): void;
    progress(done: number, total: number, currentItem?: string): void;
    event?(type: string, data?: Record<string, unknown>): void;
}
export interface Clock {
    now(): number;
}
export declare function createJxlBackend(telemetry?: Telemetry): JxlBackend;
//# sourceMappingURL=backends.d.ts.map