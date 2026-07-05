import type { PixelFormat, DecodeStage, ImageInfo, Region, CodecMetric, BufferingControls, AdvancedEncoderControls, EncodeOptions } from "./types.js";
import type { JxlErrorCode } from "./errors.js";
export interface MsgDecodeStart {
    type: "decode_start";
    sessionId: string;
    format: PixelFormat;
    region: Region | null;
    downsample: 1 | 2 | 4 | 8;
    progressionTarget: "header" | "dc" | "pass" | "final";
    emitEveryPass: boolean;
    progressiveDetail: "dc" | "lastPasses" | "passes" | "dcProgressive" | null;
    suppressDuplicateProgress: boolean;
    preserveIcc: boolean;
    preserveMetadata: boolean;
    priority: "visible" | "near" | "background";
    budgetMs: number | null;
    targetWidth: number | null;
    targetHeight: number | null;
    fitMode: "contain" | "cover" | "stretch" | null;
}
export interface MsgDecodeChunk {
    type: "decode_chunk";
    sessionId: string;
    chunk: ArrayBuffer;
}
export interface MsgDecodeClose {
    type: "decode_close";
    sessionId: string;
}
export interface MsgDecodeCancel {
    type: "decode_cancel";
    sessionId: string;
    reason?: string;
}
export interface MsgDecodePause {
    type: "decode_pause";
    sessionId: string;
}
export interface MsgDecodeResume {
    type: "decode_resume";
    sessionId: string;
}
export interface MsgDecodeHeader {
    type: "decode_header";
    sessionId: string;
    info: ImageInfo;
}
/**
 * Visual / frame metadata shared by decode_progress and decode_final frames.
 * Single source of truth so the two frame messages cannot drift (the handler mirrors
 * this with assignFrameMeta()).
 */
export interface DecodeFrameMeta {
    region?: Region;
    sourceScale?: number;
    progressiveRegion?: boolean;
    regionFallback?: "full-frame-then-crop";
    progressiveSequence?: number;
    passOrdinal?: number;
    frameIndex?: number;
    frameDuration?: number;
    frameName?: string;
    animTicksPerSecond?: number;
}
export interface MsgDecodeProgress extends DecodeFrameMeta {
    type: "decode_progress";
    sessionId: string;
    stage: DecodeStage;
    info: ImageInfo;
    pixels: ArrayBuffer;
    format: PixelFormat;
    pixelStride: number;
    /**
     * Folded per-frame metrics — carried on the frame to avoid separate metric IPCs.
     * The session re-emits each present field as the corresponding CodecMetric via onMetric:
     *   copyMs → "copy_to_transfer_ms", copiedBytes → "copied_bytes",
     *   timeToFirstPixelMs → "time_to_first_pixel_ms".
     * copyMs/copiedBytes are present only when the pixel view had to be copied to become
     * transferable; timeToFirstPixelMs is present on the first progress frame only.
     */
    copyMs?: number;
    copiedBytes?: number;
    timeToFirstPixelMs?: number;
}
export interface MsgDecodeFinal extends DecodeFrameMeta {
    type: "decode_final";
    sessionId: string;
    info: ImageInfo;
    pixels: ArrayBuffer;
    format: PixelFormat;
    pixelStride: number;
    /**
     * Folded metrics — carried on the frame to avoid separate metric IPCs. The session
     * re-emits each present field as the corresponding CodecMetric via onMetric:
     *   outputBytes → "output_bytes", timeToFirstPixelMs → "time_to_first_pixel_ms",
     *   timeToFinalMs → "time_to_final_ms", copyMs → "copy_to_transfer_ms",
     *   copiedBytes → "copied_bytes".
     */
    /** Byte length of the transferred pixel buffer. */
    outputBytes?: number;
    /** Elapsed ms from session start to first pixel (set here if no progress event fired). */
    timeToFirstPixelMs?: number;
    /** Elapsed ms from session start to final frame. */
    timeToFinalMs?: number;
    /** Copy-to-transfer duration ms; present only when the pixel view was copied. */
    copyMs?: number;
    /** Bytes copied to make pixels transferable; present only when copied. */
    copiedBytes?: number;
}
export interface MsgDecodeError {
    type: "decode_error";
    sessionId: string;
    code: string;
    message: string;
    partialPixels?: ArrayBuffer;
    partialInfo?: ImageInfo;
    partialPixelStride?: number;
    partialStage?: DecodeStage;
}
export interface MsgDecodeCancelled {
    type: "decode_cancelled";
    sessionId: string;
}
export interface MsgDecodePaused {
    type: "decode_paused";
    sessionId: string;
}
export interface MsgDecodeBudgetExceeded extends DecodeFrameMeta {
    type: "decode_budget_exceeded";
    sessionId: string;
    stage: DecodeStage;
    pixels: ArrayBuffer;
    info: ImageInfo;
    format: PixelFormat;
    pixelStride: number;
}
export interface MsgEncodeStart {
    type: "encode_start";
    sessionId: string;
    format: PixelFormat;
    width: number;
    height: number;
    hasAlpha: boolean;
    iccProfile: ArrayBuffer | null;
    exif: ArrayBuffer | null;
    xmp: ArrayBuffer | null;
    distance: number | null;
    quality: number | null;
    effort: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
    progressive: boolean;
    progressiveFlavor?: "dc" | "ac";
    previewFirst: boolean;
    /** progressiveDc (0/1/2) and groupOrder (0/1) for multi-layer/center-out progressive encodes (predator focus). */
    progressiveDc?: 0 | 1 | 2;
    progressiveAc?: 0 | 1 | 2;
    qProgressiveAc?: 0 | 1 | 2;
    groupOrder?: 0 | 1;
    chunked: boolean;
    sidecarSizes?: readonly number[];
    priority: "visible" | "near" | "background";
    /**
     * EXIF orientation tag (1..8) recorded in JXL basic info — pixels stay in
     * sensor orientation, decoders apply the rotation as metadata. Default 1.
     * Requires WASM with _z / _v3 bridge; older builds ignore this field.
     */
    orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
    /**
     * Center X (pixels) for center-first group order. -1 or omit = auto middle.
     * Only effective with groupOrder=1. Matches cjxl --center_x (ID 14).
     */
    centerX?: number;
    /**
     * Center Y (pixels) for center-first group order. -1 or omit = auto middle.
     * Only effective with groupOrder=1. Matches cjxl --center_y (ID 15).
     */
    centerY?: number;
    /**
     * Intrinsic (display) size override. Signals a different display resolution
     * from encoded pixels — useful for HiDPI/Retina (@2×) assets.
     * Maps to JxlBasicInfo.have_intrinsic_size. Requires enc_set_intrinsic_size bridge.
     */
    intrinsicSize?: {
        width: number;
        height: number;
    };
    /**
     * Disable libjxl perceptual quality heuristics (butteraugli/XYB psychovisual model).
     * Useful for fair benchmarking. Maps to JXL_ENC_FRAME_SETTING_DISABLE_PERCEPTUAL_HEURISTICS (ID 39).
     */
    disablePerceptualHeuristics?: boolean;
    /**
     * Force codestream level. -1/omit = auto, 5 = Level 5, 10 = Level 10 (CMYK/black-channel).
     * Requires enc_set_codestream_level bridge.
     */
    codestreamLevel?: -1 | 5 | 10;
    /** -1 = auto, 0 = VarDCT, 1 = Modular. Maps to JXL_ENC_FRAME_SETTING_MODULAR. */
    modular?: EncodeOptions["modular"];
    /** -1 = libjxl default, 0-11 explicit brotli effort for Modular entropy coding. */
    brotliEffort?: number;
    /** 0-4 encode-time decode speed tier hint (lower = faster to decode, larger file). */
    decodingSpeed?: number;
    /** 0 = off, or target ISO for synthetic photon noise injection. */
    photonNoiseIso?: number;
    /**
     * Buffering / streaming strategy. Maps to cjxl --buffering + --streaming_input /
     * --streaming_output. strategy -1..3 per libjxl semantics.
     */
    buffering?: BufferingControls;
    /** Advanced filter + group-order controls. Overlaps groupOrder/centerX/centerY fields
     *  (those remain for back-compat); this object is the canonical surface for new callers. */
    advancedControls?: AdvancedEncoderControls;
    /**
     * JPEG lossless reconstruction controls (cjxl row 12 audit).
     * Present only when re-encoding from a JPEG source on the lossless transcode path.
     */
    jpegReconstruction?: EncodeOptions["jpegReconstruction"];
    /**
     * The input has already been downsampled; decoder will upsample.
     * Maps to cjxl --already_downsampled.
     */
    alreadyDownsampled?: boolean;
    /**
     * Decoder upsampling mode (useful with alreadyDownsampled).
     * -1 = default non-separable, 0 = nearest. Maps to JxlEncoderSetUpsamplingMode.
     */
    upsamplingMode?: EncodeOptions["upsamplingMode"];
    /**
     * Separate resampling factor for extra channels.
     * -1 = match main, 1/2/4/8. Maps to cjxl --ec_resampling (ID 3).
     */
    ecResampling?: EncodeOptions["ecResampling"];
    /**
     * Frame indexing string for JXL_ENC_FRAME_INDEX_BOX (ID 31).
     * String matching ^(0*|1[01]*)$ per cjxl validation.
     */
    frameIndexing?: string;
    /**
     * Gate for effort=11 (expert mode). Maps to cjxl --allow_expert_options.
     * Required when effort > 9 is passed.
     */
    allowExpertOptions?: boolean;
}
export interface MsgEncodePixels {
    type: "encode_pixels";
    sessionId: string;
    chunk: ArrayBuffer;
    region?: Region;
}
export interface MsgEncodeFinish {
    type: "encode_finish";
    sessionId: string;
}
export interface MsgEncodeCancel {
    type: "encode_cancel";
    sessionId: string;
    reason?: string;
}
export interface MsgEncodeChunk {
    type: "encode_chunk";
    sessionId: string;
    chunk: ArrayBuffer;
}
export interface MsgEncodeFirstByteReady {
    type: "encode_first_byte_ready";
    sessionId: string;
}
export interface MsgEncodeDone {
    type: "encode_done";
    sessionId: string;
    totalBytes: number;
    /**
     * Cumulative byte offsets at sidecar boundaries. Length === sidecarSizes.length
     * when sidecars were emitted; omitted otherwise. See EncodeStats.sidecarOffsets.
     */
    sidecarOffsets?: readonly number[];
}
export interface MsgEncodeError {
    type: "encode_error";
    sessionId: string;
    code: string;
    message: string;
}
export interface MsgEncodeCancelled {
    type: "encode_cancelled";
    sessionId: string;
}
export interface MsgWorkerReady {
    type: "worker_ready";
    backend: "wasm" | "native";
    wasmBuild?: "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";
}
export interface MsgWorkerShutdown {
    type: "worker_shutdown";
}
export interface MsgWorkerShutdownAck {
    type: "worker_shutdown_ack";
}
export interface MsgWorkerError {
    type: "worker_error";
    /** Typed to JxlErrorCode; worker codes (DuplicateSession, UnhandledError, etc.) are included in the union. */
    code: JxlErrorCode;
    message: string;
    /** Session active at the time of the crash, if known. Allows the scheduler to route to session + mark terminal. */
    sessionId?: string;
}
export interface MsgWorkerDrain {
    type: "worker_drain";
    sessionId: string;
    latencyMs?: number;
    queueDepth?: number;
    queuedBytes?: number;
    adaptiveHwm?: number;
}
export interface MsgMetric {
    type: "metric";
    sessionId: string;
    metric: CodecMetric;
}
export interface MsgReleaseState {
    type: "release_state";
    sessionId: string;
}
export type MainToWorkerMessage = MsgDecodeStart | MsgDecodeChunk | MsgDecodeClose | MsgDecodeCancel | MsgDecodePause | MsgDecodeResume | MsgEncodeStart | MsgEncodePixels | MsgEncodeFinish | MsgEncodeCancel | MsgWorkerShutdown | MsgReleaseState;
export type WorkerToMainMessage = MsgDecodeHeader | MsgDecodeProgress | MsgDecodeFinal | MsgDecodeError | MsgDecodeCancelled | MsgDecodePaused | MsgDecodeBudgetExceeded | MsgEncodeChunk | MsgEncodeFirstByteReady | MsgEncodeDone | MsgEncodeError | MsgEncodeCancelled | MsgWorkerReady | MsgWorkerShutdownAck | MsgWorkerError | MsgWorkerDrain | MsgMetric;
//# sourceMappingURL=protocol.d.ts.map