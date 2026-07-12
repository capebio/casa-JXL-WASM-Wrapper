// "rgb8" is encode-only (3-channel, no alpha — bridge fmt=3). Decode never produces it,
// but EncoderOptions.format and the encode paths use it, so it belongs in the shared union.
export type PixelFormat = "rgba8" | "rgba16" | "rgbaf32" | "rgb8";
export type DecodeStage = "header" | "dc" | "pass" | "final";
export type Region = { x: number; y: number; w: number; h: number };
export type ProgressiveDetail = "dc" | "lastPasses" | "passes" | "dcProgressive";
const DEC_FLAG_SUPPRESS_DUPLICATE_PROGRESS = 1;
const DEC_FLAG_ALLOW_ALPHA_PROGRESSIVE = 2;
const TEXT_ENCODER = new TextEncoder();
export type CachePolicy = "onFirst" | "onFinal" | "onProgress" | "disabled";

export const DOWNSAMPLE_THUMBNAILS = 2;
export const DOWNSAMPLE_GRID = 4;

export interface ImageInfo {
  width: number;
  height: number;
  bitsPerSample: 8 | 16 | 32;
  hasAlpha: boolean;
  hasAnimation: boolean;
  jpegReconstructionAvailable: boolean;
}

export type DecodeEvent =
  | { type: "header"; info: ImageInfo }
  | {
      type: "progress";
      stage: DecodeStage;
      info: ImageInfo;
      pixels: ArrayBuffer | Uint8Array;
      format: PixelFormat;
      region?: Region;
      pixelStride: number;
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
  | {
      type: "final";
      info: ImageInfo;
      pixels: ArrayBuffer | Uint8Array;
      format: PixelFormat;
      region?: Region;
      pixelStride: number;
      sourceScale?: number;
      progressiveRegion?: boolean;
      regionFallback?: "full-frame-then-crop";
      progressiveSequence?: number;
      passOrdinal?: number;
      frameIndex?: number;
      frameDuration?: number;
      frameName?: string;
      isLastFrame?: boolean;
      animTicksPerSecond?: number;
      animLoopCount?: number;
    }
  | {
      type: "budget_exceeded";
      stage: DecodeStage;
      info: ImageInfo;
      pixels: ArrayBuffer | Uint8Array;
      format: PixelFormat;
      pixelStride: number;
    }
  | {
      type: "error";
      code: string;
      message: string;
      partialPixels?: ArrayBuffer | Uint8Array;
      partialInfo?: ImageInfo;
    }
  | {
      type: "preview";
      info: ImageInfo;
      pixels: ArrayBuffer | Uint8Array;
      format: PixelFormat;
      pixelStride: number;
      isFinal?: boolean;
    };

export interface DecoderOptions {
  format: PixelFormat;
  region?: Region | null;
  downsample?: 1 | 2 | 4 | 8;
  progressionTarget: "header" | "dc" | "pass" | "final";
  emitEveryPass: boolean;
  progressiveDetail?: ProgressiveDetail;
  /**
   * Target number of progressive AC paints (including the final image) when
   * `progressiveDetail` resolves to `"passes"`. Undefined/0 keeps libjxl's
   * per-pass pausing. A value in [2, num_passes) makes the decoder emit ~N
   * evenly spaced ::JXL_DEC_FRAME_PROGRESSION events instead of one per encoded
   * pass, trading refinement granularity against per-paint flush cost.
   * @note Requires a WASM rebuild exposing `_jxl_wasm_dec_set_paint_target`;
   * silently ignored on older modules.
   */
  progressivePaintTarget?: number;
  /**
   * Maximum progressive pixel frames to materialize, including the final frame.
   * When set on a final-target decode, extra non-final flushes are still
   * consumed from the bridge but skipped before JS copy/resize/transfer work.
   * Undefined keeps existing behavior.
   */
  maxProgressiveFrames?: number;
  /**
   * Allow progressive pausing for VarDCT images with alpha (or other extra
   * channels). libjxl disables progressive pausing whenever an extra channel is
   * present; this opt-in lifts that — intermediate flushes are valid and the
   * final image is byte-exact. No effect on modular images.
   * @note Requires a WASM rebuild from the patched libjxl; ignored otherwise.
   */
  allowAlphaProgressive?: boolean;
  /**
   * Strip ICC profile from decoded output.
   * @note **WASM no-op.** `_jxl_wasm_dec_create` has no ICC-strip parameter.
   * ICC is always preserved in the WASM decoder path. Honoured by jxl-native.
   */
  preserveIcc: boolean;
  /**
   * Extract and emit EXIF/XMP metadata alongside decoded frames.
   * @note **WASM no-op.** `_jxl_wasm_dec_create` has no metadata parameter.
   * Metadata is never extracted in the WASM decoder path. Honoured by jxl-native.
   */
  preserveMetadata: boolean;
  /**
   * Zero-based frame index for multi-frame JXL animations. Default 0 (first frame).
   * @note **WASM no-op.** The WASM decoder always decodes the full stream; frame
   * selection is not supported. Honoured by jxl-native.
   */
  frameIndex?: number;
  /**
   * Emit early DC-only preview before full progressive decode.
   * @note **WASM no-op** in the decoder path — preview emission is controlled by
   * `progressiveDetail` and the encode-side `previewFirst` option. This field is
   * read by higher-level layers only.
   */
  previewFirst?: boolean;
  /** Experimental: suppress duplicate progressive snapshots by sampled hash. Default false. */
  suppressDuplicateProgress?: boolean;
  /**
   * Cache policy: when to store decoded frames. Default "onFinal".
   * @note Handled at the jxl-cache / jxl-session layer. The WASM facade ignores it.
   */
  cachePolicy?: CachePolicy;
  /** When false, skip the defensive .slice() copy on push() — caller must not mutate the buffer after push returns. Default true. */
  copyInput?: boolean;
  targetWidth?: number | null;
  targetHeight?: number | null;
  fitMode?: "contain" | "cover" | "stretch" | null;
  onMetric?: (name: string, value: number) => void;
  /** Optional: pre-allocate chunk buffer at session start if file size is known upfront. Improves first-batch latency. */
  expectedBytes?: number;
  /** When true, emit pixel buffers without transferring ownership (decoder reuses buffer across frames). Default false. */
  deferredRelease?: boolean;
}

export interface EncoderOptions {
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
  progressiveAc?: 0 | 1 | 2;
  qProgressiveAc?: 0 | 1 | 2;
  groupOrder?: 0 | 1;
  /** Encoder-side downsampling factor. -1/1 = no downsampling; 2/4/8 = halve/quarter/eighth the frame before entropy coding. */
  resampling?: -1 | 1 | 2 | 4 | 8;
  /** Number of DC layers to include (0 = none, 1 = one DC layer, 2 = two). Only meaningful when progressive=true. */
  progressiveDc?: 0 | 1 | 2;
  /** Modular encoding mode. -1=auto, 0=VarDCT, 1=Modular. */
  modular?: -1 | 0 | 1;
  /** Brotli compression effort for entropy coding (0–11). -1 = encoder default. */
  brotliEffort?: -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  /** Trade encode work for faster decode (0–4). Higher = faster decode, larger file. */
  decodingSpeed?: 0 | 1 | 2 | 3 | 4;
  /** Simulate photon noise at this ISO equivalent. 0 = disabled. */
  photonNoiseIso?: number;
  /** Edge-preserving filter strength (0=off, 1–3=increasing). -1=encoder default. */
  epf?: -1 | 0 | 1 | 2 | 3;
  /** Gabor-like unsharpening pre-pass (0=off, 1=on). -1=encoder default. */
  gaborish?: -1 | 0 | 1;
  /** Dots/grain detection and preservation (0=off, 1=on). -1=encoder default. */
  dots?: -1 | 0 | 1;
  /** Color transform (0=XYB, 1=None, 2=YCbCr). -1=encoder default. */
  colorTransform?: -1 | 0 | 1 | 2;
  previewFirst: boolean;
  chunked: boolean;
  /** Max dimensions (px) of sidecar thumbnails to yield before the full image. Sorted ascending. */
  sidecarSizes?: readonly number[];
  /** When false, skip the defensive .slice() copy on pushPixels() — caller must not mutate the buffer after push returns. Default true. */
  copyInput?: boolean;

  /**
   * Escape hatch for advanced/experimental libjxl frame settings (patches, future tools, etc.).
   *
   * Use the named constants in `JxlFrameSetting`.
   *
   * @note **P3-T2 (finding 18): now REAL in the WASM streaming path.** Each entry is forwarded
   * verbatim to ONE generic, libjxl-validated bridge call (`_jxl_wasm_enc_set_frame_setting` →
   * `JxlEncoderFrameSettingsSetOption`). An unknown/unsupported id is NOT silently ignored:
   * libjxl rejects it at `enc_finish` and the encoder throws a deterministic error. A build
   * lacking the setter fails loudly (no silent drop). Not supported together with inline
   * ICC/EXIF/XMP metadata (the buffered one-shot encode has no encoder state to attach to —
   * that combination throws). Also honoured by jxl-native.
   *
   * @example
   * createEncoder({
   *   ...baseOptions,
   *   advancedFrameSettings: [
   *     { id: JxlFrameSetting.PATCHES, value: 1 }   // enable dictionary patches
   *   ]
   * });
   */
  advancedFrameSettings?: Array<{ id: number; value: number }>;

  /**
   * Extra channels to encode alongside the main image (Phase 2 full support).
   * Each descriptor's pixel data is supplied out-of-band for the low-level path
   * (or future high-level Encoder extension). The 20-byte packed descriptor form
   * (matching WasmExtraChannel in bridge.cpp) is used for the WASM FFI.
   * (serializeExtraChannelsForWasm + post-malloc plane_ptr writes by caller.)
   */
  extraChannels?: ExtraChannel[];

  /** Optional structured telemetry sink; mirrors DecoderOptions.onMetric. Read by LibjxlEncoder. */
  onMetric?: (name: string, value: number) => void;

  /**
   * EXIF orientation tag (1..8). 1 = identity (default), 3 = 180°, 6 = 90° CW, 8 = 90° CCW.
   * Stored in JXL basic info — pixels stay sensor-native, no CPU rotation on encode.
   * Requires the _z WASM variant (streamingInputZ capability).
   */
  orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

  /**
   * CasaSneyers_Parity (Ch3): display width in pixels when it differs from encoded pixel width
   * (e.g. Retina @2×). Stored as JxlBasicInfo.intrinsic_xsize. 0 / omit = same as encoded width.
   * Must be paired with intrinsicHeight. Requires streamingInputZ capability.
   */
  intrinsicWidth?: number;

  /**
   * CasaSneyers_Parity (Ch3): display height in pixels when it differs from encoded pixel height.
   * Stored as JxlBasicInfo.intrinsic_ysize. 0 / omit = same as encoded height.
   * Must be paired with intrinsicWidth. Requires streamingInputZ capability.
   */
  intrinsicHeight?: number;

  /**
   * CasaSneyers_Parity: disable psychovisual (butteraugli/XYB) heuristics for fair codec
   * benchmarking. -1 = encoder default (heuristics enabled), 1 = disable.
   * Maps to JXL_ENC_FRAME_SETTING_DISABLE_PERCEPTUAL_HEURISTICS (ID 39).
   * Requires streamingInputZ capability.
   */
  disablePerceptualHeuristics?: -1 | 1;

  /**
   * Force a specific JXL codestream level. -1 = libjxl automatic (default), 5 = level 5,
   * 10 = level 10. Values other than 5 and 10 are ignored (libjxl rejects them).
   * Requires streamingInputZ capability.
   */
  codestreamLevel?: -1 | 5 | 10;

  /**
   * Horizontal center offset (pixels, signed) for center-out group ordering.
   * Only meaningful when groupOrder === 1. 0 = image center (default).
   * Currently a bridge passthrough; libjxl does not yet expose a public API for this.
   */
  centerX?: number;

  /**
   * Vertical center offset (pixels, signed) for center-out group ordering.
   * Only meaningful when groupOrder === 1. 0 = image center (default).
   * Currently a bridge passthrough; libjxl does not yet expose a public API for this.
   */
  centerY?: number;
}

/**
 * Named constants for common JXL_ENC_FRAME_SETTING_* values.
 * Use with the `advancedFrameSettings` escape hatch for experimental/advanced features
 * (patches, future spline controls, etc.).
 *
 * These are intentionally minimal — the escape hatch exists precisely so we do not
 * need to expose every possible libjxl knob as a first-class option.
 */
export const JxlFrameSetting = {
  /** Enables or disables patches generation. -1 default, 0 disable, 1 enable. */
  PATCHES: 8,
  // Add more known values here as needed (EPF, GABORISH, etc.)
} as const;

/**
 * Supported extra channel types per the JXL Extra Channel extension.
 * 'spot' may carry SpotColorInfo. 'reservedN' and 'unknown' exist for forward compat and
 * custom/legacy payloads.
 */
export type ExtraChannelType =
  | 'alpha'
  | 'depth'
  | 'selection'
  | 'spot'
  | 'thermal'
  | 'reserved0' | 'reserved1' | 'reserved2' | 'reserved3' | 'reserved4' | 'reserved5' | 'reserved6' | 'reserved7'
  | 'unknown';

/** ICC-relative or display-referred spot color for a spot extra channel (0..1 range). */
export interface SpotColorInfo {
  red: number;
  green: number;
  blue: number;
  solidity: number;   // 0.0–1.0
}

/**
 * Descriptor for an extra channel to be encoded with the main image.
 * Only a subset of fields are meaningful for any given `type`.
 */
export interface ExtraChannel {
  type: ExtraChannelType;
  bitsPerSample: number;
  /** Optional. Used for certain channel types (e.g. subsampling control). */
  dimShift?: number;
  /** Human-readable or ICC-aware name. Recommended for all non-alpha channels. */
  name?: string;

  /** Per-channel distance (Phase 1 / encode). 0 = lossless for the channel. */
  distance?: number;

  /** Only used when type === 'spot'. */
  spotColor?: SpotColorInfo;

  /** Optional custom resampling factor for this channel. */
  resampling?: 1 | 2 | 4 | 8;

  /**
   * Single-channel pixel plane for this extra channel, tightly packed at
   * `width * height * ceil(bitsPerSample/8)` bytes. Supplied to
   * {@link encodeWithExtraChannels}; validated with checked byte math before the FFI call.
   * Omit for header-only descriptors (encoder will emit an implicit plane where allowed).
   */
  plane?: Uint8Array | Uint16Array | ArrayBuffer;
}

/**
 * Metadata for an extra channel present after decoding (symmetric to ExtraChannel).
 * Encode-only hints (distance, resampling) are omitted; the type is readonly.
 */
export type DecodedExtraChannel = Readonly<Omit<ExtraChannel, 'distance' | 'resampling'>>;

export interface JxlDecoder {
  push(chunk: ArrayBuffer | Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
  events(): AsyncIterable<DecodeEvent>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface EncodeStats {
  /** Raw pixel bytes: width × height × 4 × bytesPerChannel. */
  originalBytes: number;
  /** Total JXL bytes yielded across all chunks and sidecars. */
  compressedBytes: number;
  /** compressedBytes / originalBytes. Values below 1.0 indicate net compression. */
  ratio: number;
}

export interface JxlEncoder {
  pushPixels(chunk: ArrayBuffer | Uint8Array, region?: Region): void | Promise<void>;
  finish(): void | Promise<void>;
  chunks(): AsyncIterable<ArrayBuffer | Uint8Array>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
  /** Populated after chunks() completes normally. Null before or on error. */
  getStats(): EncodeStats | null;
}
// Layer 3: support ByteIntervalCursor buffers from benchmark-core for client-side chunked push (positive: allows using the same discrete math cursor for encode quanta in byte-bench and other, reduces copy at boundary). Push accepts the views/ABs from cursor.nextFor without extra exact. Also hook for pc post JXL using raw pipeline apply_perceptual_constancy for progressive paints.

interface LibjxlBuffer {
  handle: number;
  data: Uint8Array;
  width: number;
  height: number;
  bitsPerSample: 8 | 16 | 32;
  hasAlpha: boolean;
}

interface RetainedBufferView extends LibjxlBuffer {
  release(): void;
}

interface ResizeAxis {
  i0: Int32Array;
  i1: Int32Array;
  t: Float32Array;
  // Lazily-cached 8.8 fixed-point weights for the rgba8 resize kernel. Computed
  // once per axis (a ResizePlan axis is reused across every progressive paint).
  fixed256?: Int16Array;
}

interface ResizePlan {
  srcW: number;
  srcH: number;
  dstW: number;
  dstH: number;
  fitMode: "contain" | "cover" | "stretch";
  bpc: 1 | 2 | 4;
  xAxis?: ResizeAxis;
  yAxis?: ResizeAxis;
}

interface LibjxlWasmModule {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPU32?: Uint32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _jxl_wasm_decode_rgba8(inputPtr: number, inputSize: number, downsample: number): number;
  _jxl_wasm_decode_rgba16?(inputPtr: number, inputSize: number, downsample: number): number;
  _jxl_wasm_decode_rgbaf32?(inputPtr: number, inputSize: number, downsample: number): number;
  _jxl_wasm_encode_rgba8(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number): number;
  _jxl_wasm_encode_rgba16?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number): number;
  _jxl_wasm_encode_rgb16_planar?(rPtr: number, gPtr: number, bPtr: number, width: number, height: number, distance: number, effort: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number): number;
  _jxl_wasm_encode_rgbaf32?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number): number;
  _jxl_wasm_encode_rgba8_with_metadata?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number): number;
  _jxl_wasm_encode_rgba8_with_metadata_adv?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number, iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number, idsPtr: number, valuesPtr: number, count: number): number;
  _jxl_wasm_buffer_data(handle: number): number;
  _jxl_wasm_buffer_size(handle: number): number;
  _jxl_wasm_buffer_width(handle: number): number;
  _jxl_wasm_buffer_height(handle: number): number;
  _jxl_wasm_buffer_bits_per_sample(handle: number): number;
  _jxl_wasm_buffer_has_alpha(handle: number): number;
  _jxl_wasm_buffer_error?(handle: number): number;
  _jxl_wasm_buffer_free(handle: number): void;
  // Stateful progressive decoder (present after WASM rebuild with new bridge)
  _jxl_wasm_dec_create?(format: number, progressiveDetail: number): number;
  _jxl_wasm_dec_create_x?(format: number, progressiveDetail: number, flags: number): number;
  _jxl_wasm_dec_set_paint_target?(state: number, paints: number): void;
  // Progressive ROI crop + nearest downsample in C++ (byte-exact with applyRegionAndDownsample).
  // Present after a WASM rebuild with the ROI bridge; absent => JS full-frame-then-crop fallback.
  _jxl_wasm_dec_set_region?(state: number, x: number, y: number, w: number, h: number, downsample: number): void;
  _jxl_wasm_dec_push?(state: number, dataPtr: number, size: number): number;
  _jxl_wasm_dec_close_input?(state: number): void;
  _jxl_wasm_dec_width?(state: number): number;
  _jxl_wasm_dec_height?(state: number): number;
  _jxl_wasm_dec_error?(state: number): number;
  _jxl_wasm_dec_take_flushed?(state: number): number;
  _jxl_wasm_dec_take_final?(state: number): number;
  _jxl_wasm_dec_free?(state: number): void;
  _jxl_wasm_dec_flush_attempts?(state: number): number;
  _jxl_wasm_dec_flush_successes?(state: number): number;
  _jxl_wasm_dec_flush_zero_skips?(state: number): number;
  _jxl_wasm_dec_flush_duplicate_skips?(state: number): number;
  _jxl_wasm_dec_flush_image_ms?(state: number): number;
  // Sidecar thumbnail encode (present after WASM rebuild with sidecar bridge)
  _jxl_wasm_encode_rgba8_with_sidecars?(pixelsPtr: number, width: number, height: number, distance: number, effort: number, hasAlpha: number, sidecarDimsPtr: number, numSidecars: number, resampling: number): number;
  _jxl_wasm_buffer_next?(handle: number): number;
  // #10: C++ region crop decode — avoids shipping full-image pixels to JS
  _jxl_wasm_decode_rgba8_region?(inputPtr: number, inputSize: number, cx: number, cy: number, cw: number, ch: number, downsample: number): number;
  _jxl_wasm_decode_rgba16_region?(inputPtr: number, inputSize: number, cx: number, cy: number, cw: number, ch: number, downsample: number): number;
  _jxl_wasm_decode_rgbaf32_region?(inputPtr: number, inputSize: number, cx: number, cy: number, cw: number, ch: number, downsample: number): number;
  // #11: Streaming encoder — yields 64 KB chunks
  _jxl_wasm_enc_create?(): number;
  _jxl_wasm_enc_push_pixels?(state: number, pixelsPtr: number, width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number): number;
  _jxl_wasm_enc_take_chunk?(state: number): number;
  _jxl_wasm_enc_error?(state: number): number;
  _jxl_wasm_enc_free?(state: number): void;
  // #15: Lossless JPEG → JXL transcode
  _jxl_wasm_transcode_jpeg_to_jxl?(jpegPtr: number, jpegSize: number): number;
  // #16: Streaming input encoder — pre-allocate pixel buffer in WASM, push chunks, finish
  _jxl_wasm_enc_create_image?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, resampling: number): number;
  // _x: adds modular, brotliEffort, decodingSpeed, photonNoiseIso
  _jxl_wasm_enc_create_image_x?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, jpegKeepExif: number, jpegKeepXmp: number, jpegKeepJumbf: number, alreadyDownsampled: number, upsamplingMode: number, ecResampling: number): number;
  // _y: adds epf, gaborish, dots, colorTransform
  _jxl_wasm_enc_create_image_y?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, epf: number, gaborish: number, dots: number, patches: number, colorTransform: number, centerX: number, centerY: number, jpegKeepExif: number, jpegKeepXmp: number, jpegKeepJumbf: number, alreadyDownsampled: number, upsamplingMode: number, ecResampling: number): number;
  // _z: adds orientation (EXIF 1..8); also threads centerX/centerY through to _y
  _jxl_wasm_enc_create_image_z?(width: number, height: number, distance: number, effort: number, fmt: number, hasAlpha: number, progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number, modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number, epf: number, gaborish: number, dots: number, patches: number, colorTransform: number, orientation: number, centerX: number, centerY: number, jpegKeepExif: number, jpegKeepXmp: number, jpegKeepJumbf: number, alreadyDownsampled: number, upsamplingMode: number, ecResampling: number): number;
  // Post-creation state setters (call before enc_finish; require streamingInputZ path to have run)
  _jxl_wasm_enc_set_intrinsic_size?(state: number, w: number, h: number): void;
  _jxl_wasm_enc_set_frame_flags?(state: number, disablePerceptual: number): void;
  _jxl_wasm_enc_set_codestream_level?(state: number, level: number): void;
  // P3-T2 (finding 18): ONE generic libjxl-validated frame setting. id + value forwarded verbatim
  // to JxlEncoderFrameSettingsSetOption at enc_finish; libjxl rejects unknown/unsupported ids
  // (surfaced as a non-zero enc_finish rc). Returns 0 on success, negative on bad state / OOM.
  _jxl_wasm_enc_set_frame_setting?(state: number, id: number, value: number): number;
  _jxl_wasm_enc_pixels_ptr?(state: number, size: number): number;
  _jxl_wasm_enc_advance_written?(state: number, size: number): number;
  _jxl_wasm_enc_push_chunk?(state: number, dataPtr: number, size: number): number;
  _jxl_wasm_enc_finish?(state: number): number;
  // Tiled multi-frame ROI: encode an image as N JXL frames each carrying
  // layer_info.have_crop = JXL_TRUE. Pair with decode_region_tiled_rgba8 to
  // decode only the tiles overlapping a target region (true partial decode
  // via SkipFrames + SetCoalescing(false)).
  _jxl_wasm_encode_tiled_rgba8?(pixelsPtr: number, width: number, height: number, tileSize: number, distance: number, effort: number, hasAlpha: number): number;
  _jxl_wasm_decode_region_tiled_rgba8?(inputPtr: number, inputSize: number, tileSize: number, regionX: number, regionY: number, regionW: number, regionH: number): number;
  // JXTC tile container: per-tile independent JXL bitstreams + byte-offset index.
  // Avoids libjxl frame-walk overhead entirely — fresh decoder per tile.
  _jxl_wasm_encode_tile_container_rgba8?(pixelsPtr: number, width: number, height: number, tileSize: number, distance: number, effort: number, hasAlpha: number): number;
  _jxl_wasm_encode_tile_container_rgba16?(pixelsPtr: number, width: number, height: number, tileSize: number, distance: number, effort: number, hasAlpha: number): number;
  _jxl_wasm_decode_tile_container_region_rgba8?(inputPtr: number, inputSize: number, regionX: number, regionY: number, regionW: number, regionH: number): number;
  _jxl_wasm_decode_tile_container_region_rgba16?(inputPtr: number, inputSize: number, regionX: number, regionY: number, regionW: number, regionH: number): number;
  // P3-T2 (finding 19): extra-channel encode. Takes the full metadata-encode arg list plus a
  // packed WasmExtraChannel[] (EC_BYTES stride, plane_ptr/name_ptr filled by the caller).
  // alpha_distance < 0 = libjxl default; ec_resampling < 0 = inherit. Returns a buffer handle.
  _jxl_wasm_encode_rgba8_with_metadata_ec?(
    pixelsPtr: number, width: number, height: number,
    distance: number, effort: number, fmt: number, hasAlpha: number,
    progressiveDc: number, progressiveAc: number, qProgressiveAc: number, buffering: number, groupOrder: number,
    modular: number, brotliEffort: number, decodingSpeed: number, photonNoiseIso: number, resampling: number,
    iccPtr: number, iccSize: number, exifPtr: number, exifSize: number, xmpPtr: number, xmpSize: number,
    alphaDistance: number, ecDescPtr: number, numEc: number, ecResampling: number,
  ): number;
  // Decode helper (round-trip verification): returns a packed WasmExtraChannel[] (EC_BYTES stride)
  // read back from the codestream header; buffer .width = channel count. name bytes are appended
  // after the descriptor array with name_ptr pointing at their absolute heap address.
  _jxl_wasm_get_extra_channels?(inputPtr: number, inputSize: number): number;
  // Butteraugli perceptual distance between two RGBA8 images (same dimensions).
  // Returns bit-cast float as int32 (>=0 = valid distance; -1 = error).
  _jxl_wasm_butteraugli_compare?(ptr1: number, ptr2: number, width: number, height: number): number;
  // Butteraugli perceptual distance between two RGBA16 images (same dimensions).
  // Returns bit-cast float as int32 (>=0 = valid distance; -1 = error).
  _jxl_wasm_butteraugli_compare16?(ptr1: number, ptr2: number, width: number, height: number): number;
}

type JxlModuleFactory = () => Promise<LibjxlWasmModule>;

function normalizeDecoderOptions(options: DecoderOptions): DecoderOptions {
  const downsample = options.downsample ?? (options.region != null ? pickDownsample(options) : undefined);
  return {
    ...options,
    region: options.region ?? null,
    // Omit the key entirely when undefined (exactOptionalPropertyTypes forbids `downsample: undefined`).
    ...(downsample !== undefined ? { downsample } : {}),
    ...(options.progressiveDetail !== undefined ? { progressiveDetail: options.progressiveDetail } : {}),
    targetWidth: options.targetWidth ?? null,
    targetHeight: options.targetHeight ?? null,
    fitMode: options.fitMode ?? null,
  };
}

function resolveDecoderProgressiveDetail(options: DecoderOptions): 0 | 1 | 2 | 3 | 4 {
  if (options.progressionTarget === "header") return 0;
  // Disable progressive only when the caller did not request a detail level and wants
  // a plain final decode (progressionTarget=final, emitEveryPass=false). An explicit
  // progressiveDetail such as lastPasses must still subscribe to libjxl progressive
  // events even when emitEveryPass is false (Single Progressive default).
  if (options.progressiveDetail === undefined && !(options.progressionTarget !== "final" || options.emitEveryPass)) return 0;
  const detail = options.progressiveDetail
    ?? (options.emitEveryPass || options.progressionTarget === "pass" ? "passes" : "dc");
  switch (detail) {
    case "dc":
      return 1;
    case "lastPasses":
      return 2;
    case "passes":
      return 3;
    case "dcProgressive":
      return 4;
    default:
      return 1;
  }
}

function resolveProgressFrameBudget(options: DecoderOptions): number {
  const maxFrames = options.maxProgressiveFrames;
  if (maxFrames == null) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(maxFrames)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.trunc(maxFrames) - 1);
}

function emitDecoderBridgeMetrics(module: LibjxlWasmModule, dec: number, options: DecoderOptions): void {
  const onMetric = options.onMetric;
  if (!onMetric || dec === 0) return;
  const metrics: Array<[string, ((state: number) => number) | undefined]> = [
    ["bridge_flush_attempts", module._jxl_wasm_dec_flush_attempts],
    ["bridge_flush_successes", module._jxl_wasm_dec_flush_successes],
    ["bridge_flush_zero_skips", module._jxl_wasm_dec_flush_zero_skips],
    ["bridge_flush_duplicate_skips", module._jxl_wasm_dec_flush_duplicate_skips],
    ["bridge_flush_image_ms", module._jxl_wasm_dec_flush_image_ms],
  ];
  for (const [name, fn] of metrics) {
    if (typeof fn === "function") onMetric(name, fn(dec));
  }
}

function resolveEncoderBridgeSettings(options: EncoderOptions) {
  const groupOrder = options.groupOrder ?? 0;
  if (!options.progressive) {
    return { progressiveDc: 0, progressiveAc: 0, qProgressiveAc: 0, buffering: options.chunked ? 2 : 0, groupOrder };
  }
  const acEnabled = options.progressiveFlavor === "ac" || (options.progressiveFlavor !== "dc" && options.previewFirst);
  return {
    progressiveDc: options.progressiveDc ?? 1,
    progressiveAc: options.progressiveAc != null ? options.progressiveAc : (acEnabled ? 1 : 0),
    qProgressiveAc: options.qProgressiveAc != null ? options.qProgressiveAc : (acEnabled ? 1 : 0),
    buffering: 2,
    groupOrder,
  };
}

export class CapabilityMissing extends Error {
  readonly code = "CapabilityMissing";
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CapabilityMissing";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export type Tier = "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";

export interface WrapperCapabilities {
  regionDecode: boolean;
  exactSizeDecode: boolean;
  progressiveRegionDecode: boolean;
  tileAlignedRegionDecode: boolean;
  arbitraryRegionDecode: boolean;
  availableDownsampleFactors: readonly number[];
}

export interface DecodeGridInfo {
  tileWidth?: number;
  tileHeight?: number;
  preferredRegionAlign?: number;
  lodLevels?: readonly number[];
}

export function detectTier(): Tier {
  if (_cachedDetectedTier !== undefined) return _cachedDetectedTier;
  let tier: Tier;
  if (typeof WebAssembly === "undefined") {
    tier = "scalar";
  } else {
    const hasSimd = probeSimd();
    if (!hasSimd) {
      tier = "scalar";
    } else {
      // Threaded WASM needs BOTH: (1) SharedArrayBuffer for shared memory — browsers gate it
      // behind cross-origin isolation (COOP/COEP), else `new WebAssembly.Memory({shared:true})`
      // throws at instantiation; and (2) the web `Worker` constructor to spawn pthreads, since the
      // modules are built `-sENVIRONMENT=web,worker`. Plain Node has SharedArrayBuffer but NO web
      // `Worker`, so the *-mt modules throw "Worker is not defined" at init there — demote to simd.
      const hasSab = typeof SharedArrayBuffer !== "undefined" &&
        (typeof crossOriginIsolated === "undefined" || crossOriginIsolated === true);
      const hasWorker = typeof Worker !== "undefined";
      const hasThreads = hasSab && hasWorker;
      // relaxed-simd-mt is built with HWY_WANT_WASM2 (8-lane EMU256), NOT relaxed-SIMD opcodes.
      // The build gate (assert-no-relaxed-simd.mjs) enforces 0 relaxed opcodes; enc SHA is
      // byte-identical to simd-mt (A/B confirmed 2026-07-03). Safe on all browsers with SAB+Worker.
      if (hasThreads) tier = "relaxed-simd-mt";
      else tier = "simd";
    }
  }
  _cachedDetectedTier = tier;
  return tier;
}

/**
 * Returns a sensible default effort level for the current WASM tier.
 * Scalar workers get a lower effort to avoid blocking the thread; SIMD-MT
 * workers get full effort since they can use parallel libjxl codepaths.
 */
export function recommendedEffort(): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  const tier = detectTier();
  if (tier === "scalar") return 4;
  if (tier === "simd") return 6;
  return 7; // simd-mt, relaxed-simd-mt
}

function probeSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x08, 0x01, 0x06, 0x00,
      0x41, 0x00, 0xfd, 0x0f, 0x0b,
    ]));
  } catch {
    return false;
  }
}

function probeRelaxedSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x07, 0x01, 0x60, 0x02, 0x7b, 0x7b, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x0b, 0x01, 0x09, 0x00,
      0x20, 0x00, 0x20, 0x01, 0xfd, 0x80, 0x02, 0x0b,
    ]));
  } catch {
    return false;
  }
}

let modulePromise: Promise<LibjxlWasmModule> | undefined;
let testModuleFactory: JxlModuleFactory | null = null;
let _forcedTier: Tier | null = null;
let _cachedDetectedTier: Tier | undefined;

export function setJxlModuleFactoryForTesting(factory: JxlModuleFactory | null): void {
  testModuleFactory = factory;
  modulePromise = undefined;
  _a6Checked = false;
}

/**
 * Override the WASM tier used on the next module load.
 * Pass null to restore auto-detection via detectTier().
 * Resets the cached module so the next encode/decode reloads with the new tier.
 */
export function setForcedTier(tier: Tier | null): void {
  _forcedTier = tier;
  _cachedDetectedTier = undefined;
  modulePromise = undefined;
  _a6Checked = false;
}

export function getForcedTier(): Tier | null {
  return _forcedTier;
}

export function createDecoder(options: DecoderOptions): JxlDecoder {
  return new LibjxlDecoder(normalizeDecoderOptions(options));
}

// P3-T2 (finding 19): 48-byte packed descriptor for the WASM extra-channel FFI. Grown from the
// old 20-byte form so descriptor metadata (dim_shift, per-channel name, spot colour) actually
// reaches libjxl instead of being silently dropped. Layout MUST match `struct WasmExtraChannel`
// in bridge.cpp exactly (the only consumer/producer):
//   0:type(u32)  4:bits(u32)  8:distance(f32)  12:plane_ptr(u32)  16:plane_size(u32)
//   20:dim_shift(u32)  24:name_ptr(u32)  28:name_len(u32)
//   32:spot_r(f32)  36:spot_g(f32)  40:spot_b(f32)  44:spot_solidity(f32)
// plane_ptr/plane_size and name_ptr are left 0 by serialize; the caller fills them after the
// per-plane / per-name _malloc. name_len IS set here (UTF-8 byte length) so the caller knows
// how many bytes to allocate + copy for name_ptr.
export const EC_BYTES = 48;

const EXTRA_TYPE_TO_JXL: Record<ExtraChannelType, number> = {
  alpha: 0, depth: 1, selection: 3, spot: 2, thermal: 6,
  reserved0: 7, reserved1: 8, reserved2: 9, reserved3: 10, reserved4: 11, reserved5: 12, reserved6: 13, reserved7: 14,
  unknown: 15,
};

const JXL_TO_EXTRA_TYPE: Record<number, ExtraChannelType> = Object.fromEntries(
  Object.entries(EXTRA_TYPE_TO_JXL).map(([k, v]) => [v, k as ExtraChannelType]),
) as Record<number, ExtraChannelType>;

// Reuse the module-level TEXT_ENCODER (declared near the top of the file) for name bytes.
const TEXT_DECODER = new TextDecoder();

// int32 bounds for the C `int`-typed frame-setting FFI (finding 18). Values outside this range
// truncate silently at the WASM boundary, so applyAdvancedFrameSettings rejects them loudly.
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/**
 * Serializes ExtraChannel[] to an EC_BYTES*N ArrayBuffer for the EC encode FFI.
 * Layout matches `struct WasmExtraChannel` in bridge.cpp exactly (the ONLY consumer).
 * plane_ptr/plane_size (12/16) and name_ptr (24) are left 0 for the caller to fill after
 * per-plane / per-name malloc; name_len (28), dim_shift (20), and spot colour (32..44) ARE
 * serialized here so the descriptor metadata reaches the encoder.
 * Returns { buffer, view } for direct DataView writes of pointers/sizes by the caller.
 */
export function serializeExtraChannelsForWasm(channels: ExtraChannel[]): { buffer: ArrayBuffer; view: DataView } {
  const n = channels.length;
  const buf = new ArrayBuffer(EC_BYTES * n);
  const dv = new DataView(buf);
  let off = 0;
  for (const ch of channels) {
    const t = EXTRA_TYPE_TO_JXL[ch.type] ?? 15;
    dv.setUint32(off + 0, t, true);
    dv.setUint32(off + 4, ch.bitsPerSample >>> 0, true);
    dv.setFloat32(off + 8, ch.distance ?? 0, true);
    // plane_ptr (12) and plane_size (16) filled by caller post-malloc
    dv.setUint32(off + 20, (ch.dimShift ?? 0) >>> 0, true);
    // name_ptr (24) filled by caller post-malloc; name_len (28) set here.
    const nameLen = ch.name ? TEXT_ENCODER.encode(ch.name).byteLength : 0;
    dv.setUint32(off + 28, nameLen >>> 0, true);
    if (ch.type === 'spot' && ch.spotColor) {
      dv.setFloat32(off + 32, ch.spotColor.red, true);
      dv.setFloat32(off + 36, ch.spotColor.green, true);
      dv.setFloat32(off + 40, ch.spotColor.blue, true);
      dv.setFloat32(off + 44, ch.spotColor.solidity, true);
    }
    off += EC_BYTES;
  }
  return { buffer: buf, view: dv };
}

/** Options for {@link encodeWithExtraChannels}. */
export interface EncodeWithExtraChannelsOptions {
  distance?: number;
  effort?: number;
  hasAlpha?: boolean;
  /** Per-channel bytes for the interleaved main image. rgba8 only for now (bytesPerSample=1). */
  bytesPerSample?: 1;
}

function bytesPerSampleForBits(bits: number): number {
  return bits > 16 ? 4 : bits > 8 ? 2 : 1;
}

/**
 * P3-T2 (finding 19): encode an RGBA8 image with typed extra channels whose descriptor metadata
 * (dim_shift, name, spot colour) AND pixel planes are honoured by libjxl. Descriptor buffer and
 * every per-plane / per-name allocation use CHECKED byte math and are freed on EVERY path
 * (success, validation error, or WASM error) — no leak. Calls the existing `_ec` bridge.
 *
 * @param module a loaded libjxl WASM module (encoder superset).
 * @param pixels interleaved RGBA8 main image, width*height*4 bytes.
 * @param channels extra-channel descriptors; each `plane` (if present) must be exactly
 *   `width * height * ceil(bitsPerSample/8)` bytes.
 */
export async function encodeWithExtraChannels(
  module: LibjxlWasmModule,
  pixels: Uint8Array | ArrayBuffer,
  width: number,
  height: number,
  channels: ExtraChannel[],
  options: EncodeWithExtraChannelsOptions = {},
): Promise<Uint8Array> {
  if (typeof module._jxl_wasm_encode_rgba8_with_metadata_ec !== "function") {
    throw new CapabilityMissing(
      "encodeWithExtraChannels requires a rebuilt WASM with the extra-channel bridge (_jxl_wasm_encode_rgba8_with_metadata_ec)",
    );
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodeWithExtraChannels: invalid dimensions ${width}×${height}`);
  }
  const nPixelBytes = width * height * 4;
  if (!Number.isSafeInteger(nPixelBytes) || nPixelBytes <= 0) {
    throw new Error(`encodeWithExtraChannels: pixel byte overflow for ${width}×${height}`);
  }
  const pixelView = copyOrBorrowInput(pixels, false);
  if (pixelView.byteLength < nPixelBytes) {
    throw new Error(
      `encodeWithExtraChannels: main image buffer too small — expected ${nPixelBytes} bytes, got ${pixelView.byteLength}`,
    );
  }

  const distance = options.distance ?? 1;
  const effort = options.effort ?? 3;
  const hasAlpha = options.hasAlpha ? 1 : 0;

  // Validate every plane's byte math BEFORE any allocation so we never partially allocate.
  const planeViews: Array<Uint8Array | null> = channels.map((ch) => {
    if (ch.plane == null) return null;
    const bps = bytesPerSampleForBits(ch.bitsPerSample);
    const expected = width * height * bps;
    const view =
      ch.plane instanceof Uint16Array
        ? new Uint8Array(ch.plane.buffer, ch.plane.byteOffset, ch.plane.byteLength)
        : copyOrBorrowInput(ch.plane, false);
    if (view.byteLength !== expected) {
      throw new Error(
        `encodeWithExtraChannels: extra-channel '${ch.type}' plane byte size ${view.byteLength} ` +
          `does not match width*height*bytesPerSample (${expected})`,
      );
    }
    return view;
  });

  // Build the packed descriptor buffer (name_len set; plane_ptr/name_ptr filled below).
  const { buffer: descBuf, view: descView } = serializeExtraChannelsForWasm(channels);
  const numEc = channels.length;

  // Track every WASM allocation for guaranteed free-on-all-paths.
  const allocs: number[] = [];
  const alloc = (size: number, label: string): number => {
    const p = mallocOrThrow(module, size, label);
    allocs.push(p);
    return p;
  };

  let pixelsPtr = 0;
  let descPtr = 0;
  let handle = 0;
  try {
    pixelsPtr = alloc(nPixelBytes, "encodeWithExtraChannels pixels");
    module.HEAPU8.set(pixelView.subarray(0, nPixelBytes), pixelsPtr);

    descPtr = numEc > 0 ? alloc(descBuf.byteLength, "encodeWithExtraChannels descriptors") : 0;

    // Per-channel plane + name allocations, writing plane_ptr/plane_size + name_ptr into descBuf.
    for (let i = 0; i < numEc; i++) {
      const off = i * EC_BYTES;
      const planeView = planeViews[i];
      if (planeView && planeView.byteLength > 0) {
        const planePtr = alloc(planeView.byteLength, `extra-channel[${i}] plane`);
        module.HEAPU8.set(planeView, planePtr);
        descView.setUint32(off + 12, planePtr, true);
        descView.setUint32(off + 16, planeView.byteLength, true);
      }
      const ch = channels[i]!;
      if (ch.name) {
        const nameBytes = TEXT_ENCODER.encode(ch.name);
        if (nameBytes.byteLength > 0) {
          const namePtr = alloc(nameBytes.byteLength, `extra-channel[${i}] name`);
          module.HEAPU8.set(nameBytes, namePtr);
          descView.setUint32(off + 24, namePtr, true);
          descView.setUint32(off + 28, nameBytes.byteLength, true);
        }
      }
    }

    // Copy the finalized descriptor buffer into the WASM heap.
    if (descPtr !== 0) module.HEAPU8.set(new Uint8Array(descBuf), descPtr);

    handle = module._jxl_wasm_encode_rgba8_with_metadata_ec(
      pixelsPtr, width, height,
      distance, effort, /*fmt=*/0, hasAlpha,
      /*progressive_dc=*/0, /*progressive_ac=*/0, /*qprogressive_ac=*/0, /*buffering=*/0, /*group_order=*/0,
      /*modular=*/-1, /*brotli_effort=*/-1, /*decoding_speed=*/-1, /*photon_noise_iso=*/0, /*resampling=*/1,
      /*icc=*/0, /*icc_size=*/0, /*exif=*/0, /*exif_size=*/0, /*xmp=*/0, /*xmp_size=*/0,
      /*alpha_distance=*/-1, descPtr, numEc, /*ec_resampling=*/-1,
    );
    // takeBuffer reads the error field and throws on a nonzero .error; frees the handle either way.
    const out = takeBuffer(module, handle, "encodeWithExtraChannels");
    handle = 0; // takeBuffer freed it
    return out.data;
  } finally {
    if (handle !== 0) module._jxl_wasm_buffer_free(handle);
    for (const p of allocs) module._free(p);
  }
}

/**
 * P3-T2 (finding 19): read back the extra-channel descriptors (incl. dim_shift, spot colour, and
 * name) from an encoded JXL codestream, for round-trip verification. Consumes the
 * `_jxl_wasm_get_extra_channels` bridge; returns one {@link DecodedExtraChannel}-like descriptor
 * per channel (the main alpha channel included, if present).
 */
export function getExtraChannelsFromJxl(
  module: LibjxlWasmModule,
  input: Uint8Array | ArrayBuffer,
): Array<DecodedExtraChannel & { spotColor?: SpotColorInfo; dimShift?: number }> {
  if (typeof module._jxl_wasm_get_extra_channels !== "function") {
    throw new CapabilityMissing(
      "getExtraChannelsFromJxl requires a rebuilt WASM with the extra-channel decode helper (_jxl_wasm_get_extra_channels)",
    );
  }
  const view = copyOrBorrowInput(input, false);
  const inPtr = mallocOrThrow(module, view.byteLength, "getExtraChannelsFromJxl input");
  let handle = 0;
  try {
    module.HEAPU8.set(view, inPtr);
    handle = module._jxl_wasm_get_extra_channels(inPtr, view.byteLength)!;
    // Retain (do NOT free yet): the packed descriptors AND the appended name bytes live in this
    // owned buffer, and both name_ptr and buf.data point into it. Freeing before we finish reading
    // would be a use-after-free. Release explicitly once every field + name string is copied out.
    const buf = retainBufferView(module, handle, "getExtraChannelsFromJxl");
    handle = 0; // ownership transferred to `buf`; released below
    const out: Array<DecodedExtraChannel & { spotColor?: SpotColorInfo; dimShift?: number }> = [];
    try {
      const count = buf.width; // channel count packed into the width field
      const dv = new DataView(buf.data.buffer, buf.data.byteOffset, buf.data.byteLength);
      for (let i = 0; i < count; i++) {
        const off = i * EC_BYTES;
        const jxlType = dv.getUint32(off + 0, true);
        const bits = dv.getUint32(off + 4, true);
        const dimShift = dv.getUint32(off + 20, true);
        const namePtr = dv.getUint32(off + 24, true);
        const nameLen = dv.getUint32(off + 28, true);
        const spotR = dv.getFloat32(off + 32, true);
        const spotG = dv.getFloat32(off + 36, true);
        const spotB = dv.getFloat32(off + 40, true);
        const spotS = dv.getFloat32(off + 44, true);
        const type = JXL_TO_EXTRA_TYPE[jxlType] ?? "unknown";
        let name: string | undefined;
        if (namePtr !== 0 && nameLen > 0) {
          // name_ptr is an absolute heap address into the still-live buffer; TextDecoder copies.
          name = TEXT_DECODER.decode(module.HEAPU8.subarray(namePtr, namePtr + nameLen));
        }
        const entry: DecodedExtraChannel & { spotColor?: SpotColorInfo; dimShift?: number } = {
          type,
          bitsPerSample: bits,
          dimShift,
          ...(name != null ? { name } : {}),
        };
        if (type === "spot") {
          entry.spotColor = { red: spotR, green: spotG, blue: spotB, solidity: spotS };
        }
        out.push(entry);
      }
    } finally {
      buf.release();
    }
    return out;
  } finally {
    if (handle !== 0) module._jxl_wasm_buffer_free(handle);
    module._free(inPtr);
  }
}

export function createEncoder(options: EncoderOptions): JxlEncoder {
  return new LibjxlEncoder(options);
}

/**
 * Losslessly transcode a JPEG file to JXL without pixel expansion.
 * The resulting JXL embeds the original JPEG bitstream for round-trip fidelity.
 * Requires a WASM build that includes the #15 bridge (jxl_wasm_transcode_jpeg_to_jxl).
 */
export async function transcodeJpegToJxl(jpeg: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const module = await loadLibjxlModule();
  if (!getCapabilities(module).jpegTranscode) {
    throw new CapabilityMissing("JPEG→JXL transcode requires a rebuilt WASM with transcode bridge");
  }
  const view = copyOrBorrowInput(jpeg, false);
  const ptr = module._malloc(view.byteLength);
  if (ptr === 0) throw new Error("WASM malloc failed for JPEG transcode input");
  try {
    module.HEAPU8.set(view, ptr);
    const handle = module._jxl_wasm_transcode_jpeg_to_jxl!(ptr, view.byteLength);
    return takeBuffer(module, handle, "transcode").data;
  } finally {
    module._free(ptr);
  }
}

/**
 * Compute Butteraugli perceptual distance between two RGBA8 images.
 * Both pixel buffers must represent the same width×height image in RGBA8 format.
 * Returns the p3 Butteraugli distance (0 = identical, ~1.0 = imperceptible, >2.0 = noticeable).
 * Requires a WASM build with the butteraugli bridge (jxl_wasm_butteraugli_compare).
 */
export async function computeButteraugli(
  pixels1: ArrayBuffer | Uint8Array,
  pixels2: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
): Promise<number> {
  const module = await loadLibjxlModule();
  if (!module._jxl_wasm_butteraugli_compare) {
    throw new CapabilityMissing("Butteraugli requires a rebuilt WASM with butteraugli bridge");
  }
  const pixelSize = width * height * 4;
  const view1 = copyOrBorrowInput(pixels1, false);
  const view2 = copyOrBorrowInput(pixels2, false);
  if (view1.byteLength < pixelSize || view2.byteLength < pixelSize) {
    throw new Error(`computeButteraugli: expected ${pixelSize} bytes for ${width}×${height} RGBA8, got ${view1.byteLength}/${view2.byteLength}`);
  }
  const ptr1 = mallocOrThrow(module, pixelSize, "Butteraugli image A");
  let ptr2 = 0;
  try {
    ptr2 = mallocOrThrow(module, pixelSize, "Butteraugli image B");
    module.HEAPU8.set(view1.subarray(0, pixelSize), ptr1);
    module.HEAPU8.set(view2.subarray(0, pixelSize), ptr2);
    const bits = module._jxl_wasm_butteraugli_compare(ptr1, ptr2, width, height);
    if (bits < 0) throw new Error("Butteraugli WASM compare failed");
    return floatFromI32Bits(bits);
  } finally {
    module._free(ptr1);
    if (ptr2 !== 0) module._free(ptr2);
  }
}

/**
 * Compute Butteraugli perceptual distance between two RGBA16 images.
 * Both pixel buffers must represent the same width×height image in RGBA16 format (8 bytes/px).
 * Returns the p3 Butteraugli distance (0 = identical, ~1.0 = imperceptible, >2.0 = noticeable).
 * Requires a WASM build with the 16-bit butteraugli bridge (jxl_wasm_butteraugli_compare16).
 */
export async function computeButteraugli16(
  pixels1: ArrayBuffer | Uint8Array,
  pixels2: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
): Promise<number> {
  const module = await loadLibjxlModule();
  if (!module._jxl_wasm_butteraugli_compare16) {
    throw new CapabilityMissing("Butteraugli16 requires a rebuilt WASM with 16-bit butteraugli bridge");
  }
  const pixelSize = width * height * 4 * 2;
  const view1 = copyOrBorrowInput(pixels1, false);
  const view2 = copyOrBorrowInput(pixels2, false);
  if (view1.byteLength < pixelSize || view2.byteLength < pixelSize) {
    throw new Error(`computeButteraugli16: expected ${pixelSize} bytes for ${width}×${height} RGBA16, got ${view1.byteLength}/${view2.byteLength}`);
  }
  const ptr1 = mallocOrThrow(module, pixelSize, "Butteraugli16 image A");
  let ptr2 = 0;
  try {
    ptr2 = mallocOrThrow(module, pixelSize, "Butteraugli16 image B");
    module.HEAPU8.set(view1.subarray(0, pixelSize), ptr1);
    module.HEAPU8.set(view2.subarray(0, pixelSize), ptr2);
    const bits = module._jxl_wasm_butteraugli_compare16(ptr1, ptr2, width, height);
    if (bits < 0) throw new Error("Butteraugli16 WASM compare failed");
    return floatFromI32Bits(bits);
  } finally {
    module._free(ptr1);
    if (ptr2 !== 0) module._free(ptr2);
  }
}

export class ButteraugliComparator {
  private refPtr = 0;       // raw pixels in WASM heap (legacy single-shot path)
  private refStatePtr = 0;  // JxlWasmButterRef* (ref-cached path — only test Image3F built per compare)
  private candidatePtr = 0; // reused candidate staging buffer (grow-only across compares)
  private candidateCap = 0; // capacity in bytes of candidatePtr

  private constructor(
    private readonly module: LibjxlWasmModule,
    private readonly width: number,
    private readonly height: number,
  ) {}

  static async create(reference: ArrayBuffer | Uint8Array, width: number, height: number): Promise<ButteraugliComparator> {
    const module = await loadLibjxlModule();
    const m = module as any;
    if (!module._jxl_wasm_butteraugli_compare && typeof m._jxl_wasm_butteraugli_ref_create !== "function") {
      throw new CapabilityMissing("Butteraugli comparator requires a rebuilt WASM with butteraugli bridge");
    }
    const pixelSize = butteraugliPixelSize(reference, width, height, "ButteraugliComparator.create");
    const view = copyOrBorrowInput(reference, false);
    const comparator = new ButteraugliComparator(module, width, height);

    if (typeof m._jxl_wasm_butteraugli_ref_create === "function") {
      // Ref-cached path (B2): build Image3F for ref once in C++; compare() only builds test.
      // Temp pixel ptr freed immediately after ref state created.
      const ptr = mallocOrThrow(module, pixelSize, "Butteraugli ref pixels temp");
      try {
        module.HEAPU8.set(view.subarray(0, pixelSize), ptr);
        comparator.refStatePtr = m._jxl_wasm_butteraugli_ref_create(ptr, width, height);
        if (comparator.refStatePtr === 0) throw new Error("jxl_wasm_butteraugli_ref_create failed (OOM)");
      } finally {
        module._free(ptr);
      }
    } else {
      // Legacy path: keep ref raw pixels in WASM heap; both ref+test gamma-decoded per call.
      comparator.refPtr = mallocOrThrow(module, pixelSize, "Butteraugli reference");
      try {
        module.HEAPU8.set(view.subarray(0, pixelSize), comparator.refPtr);
      } catch (error) {
        comparator.dispose();
        throw error;
      }
    }
    return comparator;
  }

  compare(candidate: ArrayBuffer | Uint8Array): number {
    if (this.refStatePtr === 0 && this.refPtr === 0) {
      throw new Error("ButteraugliComparator has been disposed");
    }
    const pixelSize = butteraugliPixelSize(candidate, this.width, this.height, "ButteraugliComparator.compare");
    // Reuse one candidate staging buffer across compares (width×height are fixed at
    // construction, so pixelSize is constant; grow-only handles oversized inputs).
    // Removes a malloc/free pair per compare — meaningful for progressive paints and
    // parameter sweeps that compare many candidates against one reference.
    if (this.candidatePtr === 0 || pixelSize > this.candidateCap) {
      if (this.candidatePtr !== 0) this.module._free(this.candidatePtr);
      this.candidatePtr = mallocOrThrow(this.module, pixelSize, "Butteraugli candidate");
      this.candidateCap = pixelSize;
    }
    const ptr = this.candidatePtr;
    const view = copyOrBorrowInput(candidate, false);
    this.module.HEAPU8.set(view.subarray(0, pixelSize), ptr);
    if (this.refStatePtr !== 0) {
      const bits = (this.module as any)._jxl_wasm_butteraugli_ref_compare(this.refStatePtr, ptr);
      if (bits < 0) throw new Error("Butteraugli WASM compare failed");
      return floatFromI32Bits(bits);
    } else {
      const bits = this.module._jxl_wasm_butteraugli_compare!(this.refPtr, ptr, this.width, this.height);
      if (bits < 0) throw new Error("Butteraugli WASM compare failed");
      return floatFromI32Bits(bits);
    }
  }

  dispose(): void {
    if (this.refStatePtr !== 0) {
      (this.module as any)._jxl_wasm_butteraugli_ref_free(this.refStatePtr);
      this.refStatePtr = 0;
    }
    if (this.refPtr !== 0) {
      this.module._free(this.refPtr);
      this.refPtr = 0;
    }
    if (this.candidatePtr !== 0) {
      this.module._free(this.candidatePtr);
      this.candidatePtr = 0;
      this.candidateCap = 0;
    }
  }
}

/**
 * WASM PSNR between two RGBA8 images. Returns dB (Infinity = identical).
 * Requires rebuilt WASM with jxl_wasm_psnr_compare (Task B3). Returns null if unavailable.
 */
export async function computePsnrWasm(
  pixels1: ArrayBuffer | Uint8Array,
  pixels2: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
): Promise<number | null> {
  const module = await loadLibjxlModule();
  const fn = (module as any)._jxl_wasm_psnr_compare;
  if (typeof fn !== "function") return null;
  const pixelSize = width * height * 4;
  const v1 = copyOrBorrowInput(pixels1, false);
  const v2 = copyOrBorrowInput(pixels2, false);
  const ptr1 = mallocOrThrow(module, pixelSize, "PSNR image A");
  let ptr2 = 0;
  try {
    ptr2 = mallocOrThrow(module, pixelSize, "PSNR image B");
    module.HEAPU8.set(v1.subarray(0, pixelSize), ptr1);
    module.HEAPU8.set(v2.subarray(0, pixelSize), ptr2);
    return floatFromI32Bits(fn(ptr1, ptr2, width, height));
  } finally {
    module._free(ptr1);
    if (ptr2 !== 0) module._free(ptr2);
  }
}

/**
 * WASM SSIM between two RGBA8 images. Returns [0,1] (1 = identical).
 * Requires rebuilt WASM with jxl_wasm_ssim_compare (Task B4). Returns null if unavailable.
 */
export async function computeSsimWasm(
  pixels1: ArrayBuffer | Uint8Array,
  pixels2: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
): Promise<number | null> {
  const module = await loadLibjxlModule();
  const fn = (module as any)._jxl_wasm_ssim_compare;
  if (typeof fn !== "function") return null;
  const pixelSize = width * height * 4;
  const v1 = copyOrBorrowInput(pixels1, false);
  const v2 = copyOrBorrowInput(pixels2, false);
  const ptr1 = mallocOrThrow(module, pixelSize, "SSIM image A");
  let ptr2 = 0;
  try {
    ptr2 = mallocOrThrow(module, pixelSize, "SSIM image B");
    module.HEAPU8.set(v1.subarray(0, pixelSize), ptr1);
    module.HEAPU8.set(v2.subarray(0, pixelSize), ptr2);
    return floatFromI32Bits(fn(ptr1, ptr2, width, height));
  } finally {
    module._free(ptr1);
    if (ptr2 !== 0) module._free(ptr2);
  }
}

/**
 * Extract embedded JPEG reconstruction from JXL container (if present).
 * Container JXLs (created with encodeTileContainerRgba8/JXTC) may embed
 * the original JPEG bitstream for fast native preview. Scans container
 * header for jbrd (JPEG Reconstruction) box.
 * Returns a copied Uint8Array, or null if no embedded JPEG or not a container JXL.
 */
export function extractJpegReconstructionFromJxl(jxlData: ArrayBuffer | Uint8Array): Uint8Array | null {
  const view = jxlData instanceof Uint8Array ? jxlData : new Uint8Array(jxlData);
  // JXTC magic: 0x4354584A ('JXTC' little-endian at offset 0)
  const isJxtc = view.byteLength >= 4 &&
    view[0] === 0x4A && view[1] === 0x58 && view[2] === 0x54 && view[3] === 0x43;

  if (!isJxtc) return null;

  const scanRanges = jxtcNonTileRanges(view);
  if (scanRanges.length === 0) return null;
  for (const [start, end] of scanRanges) {
    const jpeg = scanForValidJpeg(view, start, end);
    if (jpeg !== null) return jpeg;
  }
  return null;
}

/**
 * Legacy tiled multi-frame JXL encode.
 * Each tile becomes one JXL frame with layer_info.have_crop = JXL_TRUE.
 * Keep this only for compatibility with older callers. Prefer the JXTC tile
 * container path (`encodeTileContainerRgba8` / `decodeTileContainerRegionRgba8`)
 * for new work; it avoids the frame-walk overhead in libjxl and is much faster
 * for crop/ROI benchmarks.
 *
 * Requires a WASM build that includes the tile bridge
 * (jxl_wasm_encode_tiled_rgba8).
 *
 * @param tileSize must match the value passed to decodeTiledRegionRgba8.
 */
export async function encodeTiledRgba8(
  pixels: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
  options: { tileSize: number; distance?: number; effort?: number; hasAlpha?: boolean },
): Promise<Uint8Array> {
  const module = await loadLibjxlModule();
  if (!module._jxl_wasm_encode_tiled_rgba8) {
    throw new CapabilityMissing("Tiled encode requires a rebuilt WASM with tile bridge");
  }
  const tileSize = options.tileSize;
  if (!Number.isInteger(tileSize) || tileSize < 16) {
    throw new Error(`tileSize must be an integer ≥ 16, got ${tileSize}`);
  }
  const distance = options.distance ?? 1.0;
  const effort   = options.effort ?? 3;
  const hasAlpha = options.hasAlpha !== false;

  const view = copyOrBorrowInput(pixels, false);
  const expectedBytes = width * height * 4;
  if (view.byteLength < expectedBytes) {
    throw new Error(`Pixel buffer too small: ${view.byteLength} < ${expectedBytes}`);
  }

  const ptr = module._malloc(view.byteLength);
  if (ptr === 0) throw new Error("WASM malloc failed for tiled encode input");
  try {
    module.HEAPU8.set(view, ptr);
    const handle = module._jxl_wasm_encode_tiled_rgba8(
      ptr, width, height, tileSize, distance, effort, hasAlpha ? 1 : 0,
    );
    return takeBuffer(module, handle, "tiled encode").data;
  } finally {
    module._free(ptr);
  }
}

/**
 * Legacy ROI decode for tiled multi-frame JXL produced by encodeTiledRgba8.
 * Prefer decodeTileContainerRegionRgba8 for new code; the JXTC container
 * avoids the frame-header walk that makes the tiled path significantly slower.
 * Only the JXL frames whose layer bounds overlap the region are decompressed;
 * other frames are skipped via JxlDecoderSkipFrames (header-only walk).
 *
 * Returns clamped region dimensions — caller should pre-clamp if exact size
 * is required.
 */
export async function decodeTiledRegionRgba8(
  jxlBytes: ArrayBuffer | Uint8Array,
  options: { tileSize: number; x: number; y: number; w: number; h: number; onMetric?: (name: string, value: number) => void },
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const module = await loadLibjxlModule();
  if (!module._jxl_wasm_decode_region_tiled_rgba8) {
    throw new CapabilityMissing("Tiled region decode requires a rebuilt WASM with tile bridge");
  }
  const { tileSize, x, y, w, h, onMetric } = options;
  if (!Number.isInteger(tileSize) || tileSize < 16) {
    throw new Error(`tileSize must be an integer ≥ 16, got ${tileSize}`);
  }

  const tStart = performance.now();
  const view = copyOrBorrowInput(jxlBytes, false);
  const t1 = performance.now();
  onMetric?.("tiled_region_input_prep", t1 - tStart);

  const t2 = performance.now();
  const ptr = module._malloc(view.byteLength);
  if (ptr === 0) throw new Error("WASM malloc failed for tiled decode input");
  const tMalloc = performance.now() - t2;
  onMetric?.("tiled_region_malloc", tMalloc);

  try {
    const t3 = performance.now();
    module.HEAPU8.set(view, ptr);
    const tHeapSet = performance.now() - t3;
    onMetric?.("tiled_region_heap_set", tHeapSet);

    const t4 = performance.now();
    const handle = module._jxl_wasm_decode_region_tiled_rgba8(
      ptr, view.byteLength, tileSize, x, y, w, h,
    );
    const tWasmDecode = performance.now() - t4;
    onMetric?.("tiled_region_wasm_decode", tWasmDecode);

    const t5 = performance.now();
    const buf = takeBuffer(module, handle, "tiled region decode");
    const tBufferRead = performance.now() - t5;
    onMetric?.("tiled_region_buffer_read", tBufferRead);

    const tTotal = performance.now() - tStart;
    const estTilesX = Math.ceil((x + w) / tileSize) - Math.floor(x / tileSize);
    const estTilesY = Math.ceil((y + h) / tileSize) - Math.floor(y / tileSize);
    const estTilesNeeded = estTilesX * estTilesY;

    onMetric?.("tiled_region_total", tTotal);

    return { pixels: buf.data, width: buf.width, height: buf.height };
  } finally {
    module._free(ptr);
  }
}

/**
 * Encode RGBA8 as a JXTC tile container — N independent standalone JXL bitstreams
 * plus a byte-offset index. Decode with decodeTileContainerRegionRgba8 to retrieve
 * any rectangular region with zero frame-walk overhead.
 *
 * Compared to encodeTiledRgba8 (multi-frame JXL):
 *   - Same tile granularity
 *   - Slightly larger output (~5-10% overhead from per-tile JXL headers)
 *   - Vastly faster ROI decode in libjxl ≤0.11.x where SkipFrames doesn't skip work
 *
 * Output is NOT a standard JXL — it's a custom container format. Magic 'JXTC'.
 */
export async function encodeTileContainerRgba8(
  pixels: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
  options: { tileSize: number; distance?: number; effort?: number; hasAlpha?: boolean; onMetric?: (name: string, value: number) => void },
): Promise<Uint8Array> {
  return encodeTileContainer(pixels, width, height, options, "rgba8");
}

/**
 * Encode RGBA16 as a JXTC tile container — N independent standalone JXL bitstreams
 * plus a byte-offset index. Decode with decodeTileContainerRegionRgba16 to retrieve
 * any rectangular region with zero frame-walk overhead.
 */
export async function encodeTileContainerRgba16(
  pixels: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
  options: { tileSize: number; distance?: number; effort?: number; hasAlpha?: boolean; onMetric?: (name: string, value: number) => void },
): Promise<Uint8Array> {
  return encodeTileContainer(pixels, width, height, options, "rgba16");
}

// Zero/lower-copy planar RGB16 encode support.
// Accepts three separate Uint16Arrays (or WASM heap pointers) for R/G/B planes.
// Useful after planar demosaic + planar downscale or SoA tone to avoid allocating/copying a full interleaved buffer on the JS side.
// The bridge interleaves in C++ then encodes.
export async function encodeRgb16Planar(
  r: Uint16Array | number,
  g: Uint16Array | number,
  b: Uint16Array | number,
  width: number,
  height: number,
  distance = 1.0,
  effort = 7,
  progressiveDc = 0,
  progressiveAc = 0,
  qProgressiveAc = 0,
  buffering = 0,
  groupOrder = 0,
  resampling = 1
): Promise<Uint8Array> {
  const module = await loadLibjxlModule();
  const m = module as any;
  const rPtr = (typeof r === 'number') ? r : ensureU16Heap(m, r);
  const gPtr = (typeof g === 'number') ? g : ensureU16Heap(m, g);
  const bPtr = (typeof b === 'number') ? b : ensureU16Heap(m, b);
  if (typeof m._jxl_wasm_encode_rgb16_planar !== 'function') {
    if (typeof r !== 'number') m._free(rPtr);
    if (typeof g !== 'number') m._free(gPtr);
    if (typeof b !== 'number') m._free(bPtr);
    throw new CapabilityMissing('encodeRgb16Planar requires jxl-wasm bridge rebuilt with planar support');
  }
  const handle = m._jxl_wasm_encode_rgb16_planar(rPtr, gPtr, bPtr, width, height, distance, effort, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
  if (typeof r !== 'number') m._free(rPtr);
  if (typeof g !== 'number') m._free(gPtr);
  if (typeof b !== 'number') m._free(bPtr);
  return takeBuffer(module, handle, "encodeRgb16Planar").data;
}

// Copy a Uint16Array R/G/B plane into the WASM heap and return its pointer.
// Used by encodeRgb16Planar when callers pass arrays rather than pre-allocated heap pointers.
function ensureU16Heap(module: LibjxlWasmModule, arr: Uint16Array): number {
  const bytes = arr.byteLength;
  const ptr = mallocOrThrow(module, bytes, "RGB16 plane");
  module.HEAPU8.set(new Uint8Array(arr.buffer, arr.byteOffset, bytes), ptr);
  return ptr;
}

/**
 * Encode a packed interleaved RGBA16 image to a standard JXL bitstream.
 * Pixels must be 4 channels × 2 bytes per channel (little-endian uint16) = 8 bytes/pixel.
 *
 * Falls back to CapabilityMissing when the shipped WASM lacks the rgba16 encode
 * entry point. Use JxlEncoder({ format: "rgba16" }) for the streaming-capable path
 * which can fall through to the buffered encode path using the same WASM symbol.
 *
 * @param pixels  Packed RGBA16 data — Uint16Array, Uint8Array, or ArrayBuffer.
 * @param width   Image width in pixels.
 * @param height  Image height in pixels.
 * @param quality JXL quality 0–100 (default 90). Maps to Butteraugli distance.
 */
export async function encodeRgba16(
  pixels: Uint16Array | ArrayBuffer | Uint8Array,
  width: number,
  height: number,
  quality = 90,
): Promise<Uint8Array> {
  const module = await loadLibjxlModule();
  if (typeof module._jxl_wasm_encode_rgba16 !== "function") {
    throw new CapabilityMissing(
      "encodeRgba16 requires a WASM build with multi-format bridge (_jxl_wasm_encode_rgba16)"
    );
  }
  const distance = distanceFromQuality(quality);
  const byteLen = width * height * 4 * 2; // 4 channels × 2 bytes/channel
  const view =
    pixels instanceof Uint16Array
      ? new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)
      : copyOrBorrowInput(pixels, false);
  if (view.byteLength < byteLen) {
    throw new Error(
      `encodeRgba16: buffer too small — expected ${byteLen} bytes for ${width}×${height} RGBA16, got ${view.byteLength}`
    );
  }
  const ptr = mallocOrThrow(module, byteLen, "encodeRgba16 pixels");
  try {
    module.HEAPU8.set(view.subarray(0, byteLen), ptr);
    const handle = module._jxl_wasm_encode_rgba16(
      ptr, width, height,
      distance, /*effort=*/7, /*has_alpha=*/1,
      /*progressive_dc=*/0, /*progressive_ac=*/0, /*qprogressive_ac=*/0,
      /*buffering=*/0, /*group_order=*/0, /*resampling=*/1,
    );
    return takeBuffer(module, handle, "encodeRgba16").data;
  } finally {
    module._free(ptr);
  }
}

async function encodeTileContainer(
  pixels: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
  options: { tileSize: number; distance?: number; effort?: number; hasAlpha?: boolean; onMetric?: (name: string, value: number) => void },
  format: "rgba8" | "rgba16",
): Promise<Uint8Array> {
  const module = await loadLibjxlModule();
  const encodeFn = format === "rgba16"
    ? module._jxl_wasm_encode_tile_container_rgba16
    : module._jxl_wasm_encode_tile_container_rgba8;
  if (!encodeFn) {
    throw new CapabilityMissing("Tile container encode requires a rebuilt WASM with JXTC bridge");
  }
  const tileSize = options.tileSize;
  if (!Number.isInteger(tileSize) || tileSize < 1) {
    throw new Error(`tileSize must be a positive integer, got ${tileSize}`);
  }
  const distance = options.distance ?? 1.0;
  const effort   = options.effort ?? 3;
  const hasAlpha = options.hasAlpha !== false;
  const onMetric = options.onMetric;

  // Per-phase encode sub-timers (marshal vs libjxl core-compress). Mirrors the
  // decodeTileContainerRegion split so the benchmark TOON Enc*Ms fields get real
  // numbers without a WASM rebuild — enc_wasm_encode is the full synchronous FFI
  // call into libjxl, i.e. the EncCoreCompressMs the ~90% claim is about.
  const tStart = performance.now();
  const view = copyOrBorrowInput(pixels, false);
  const expectedBytes = width * height * 4 * bytesPerChannelForFormat(format);
  if (view.byteLength < expectedBytes) {
    throw new Error(`Pixel buffer too small: ${view.byteLength} < ${expectedBytes}`);
  }
  onMetric?.("enc_input_prep", performance.now() - tStart);

  const t2 = performance.now();
  const ptr = module._malloc(view.byteLength);
  if (ptr === 0) throw new Error("WASM malloc failed for tile container encode");
  onMetric?.("enc_malloc", performance.now() - t2);
  try {
    const t3 = performance.now();
    module.HEAPU8.set(view, ptr);
    onMetric?.("enc_heap_set", performance.now() - t3);

    const t4 = performance.now();
    const handle = encodeFn(ptr, width, height, tileSize, distance, effort, hasAlpha ? 1 : 0);
    onMetric?.("enc_wasm_encode", performance.now() - t4);

    const t5 = performance.now();
    const out = takeBuffer(module, handle, "tile container encode").data;
    onMetric?.("enc_buffer_read", performance.now() - t5);
    return out;
  } finally {
    const tFree = performance.now();
    module._free(ptr);
    onMetric?.("enc_free", performance.now() - tFree);
  }
}

/**
 * Decode a rectangular region from a JXTC tile container produced by
 * encodeTileContainerRgba8. Each overlapping tile is decoded as a standalone
 * JXL bitstream — zero frame-walk overhead. Performance is linear in number
 * of overlapping tiles, regardless of total image size.
 */
export async function decodeTileContainerRegionRgba8(
  containerBytes: ArrayBuffer | Uint8Array,
  options: { x: number; y: number; w: number; h: number; onMetric?: (name: string, value: number) => void },
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  return decodeTileContainerRegion(containerBytes, options, "rgba8");
}

/**
 * Decode a rectangular region from a JXTC tile container produced by
 * encodeTileContainerRgba16. Each overlapping tile is decoded as a standalone
 * JXL bitstream — zero frame-walk overhead. Performance is linear in number
 * of overlapping tiles, regardless of total image size.
 */
export async function decodeTileContainerRegionRgba16(
  containerBytes: ArrayBuffer | Uint8Array,
  options: { x: number; y: number; w: number; h: number; onMetric?: (name: string, value: number) => void },
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  return decodeTileContainerRegion(containerBytes, options, "rgba16");
}

async function decodeTileContainerRegion(
  containerBytes: ArrayBuffer | Uint8Array,
  options: { x: number; y: number; w: number; h: number; onMetric?: (name: string, value: number) => void },
  format: "rgba8" | "rgba16",
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const module = await loadLibjxlModule();
  const decodeFn = format === "rgba16"
    ? module._jxl_wasm_decode_tile_container_region_rgba16
    : module._jxl_wasm_decode_tile_container_region_rgba8;
  if (!decodeFn) {
    throw new CapabilityMissing("Tile container decode requires a rebuilt WASM with JXTC bridge");
  }
  const { x, y, w, h, onMetric } = options;

  const tStart = performance.now();
  const view = copyOrBorrowInput(containerBytes, false);
  const t1 = performance.now();
  onMetric?.("jxtc_input_prep", t1 - tStart);

  const t2 = performance.now();
  const ptr = module._malloc(view.byteLength);
  if (ptr === 0) throw new Error("WASM malloc failed for tile container decode");
  const tMalloc = performance.now() - t2;
  onMetric?.("jxtc_malloc", tMalloc);

  try {
    const t3 = performance.now();
    module.HEAPU8.set(view, ptr);
    const tHeapSet = performance.now() - t3;
    onMetric?.("jxtc_heap_set", tHeapSet);

    const t4 = performance.now();
    const handle = decodeFn(ptr, view.byteLength, x, y, w, h);
    const tWasmDecode = performance.now() - t4;
    onMetric?.("jxtc_wasm_decode", tWasmDecode);

    const t5 = performance.now();
    const buf = takeBuffer(module, handle, "tile container region decode");
    const tBufferRead = performance.now() - t5;
    onMetric?.("jxtc_buffer_read", tBufferRead);

    const tTotal = performance.now() - tStart;
    onMetric?.("jxtc_total", tTotal);

    return { pixels: buf.data, width: buf.width, height: buf.height };
  } finally {
    module._free(ptr);
  }
}

/** Start loading the WASM module immediately. Call during app startup to hide cold-start latency. */
export function preloadJxlModule(): void {
  void loadLibjxlModule();
}

export function getWrapperCapabilities(): WrapperCapabilities {
  return {
    regionDecode: true,
    exactSizeDecode: true,
    progressiveRegionDecode: false,
    tileAlignedRegionDecode: false,
    arbitraryRegionDecode: true,
    availableDownsampleFactors: [1, 2, 4, 8],
  };
}

export function getDecodeGridInfo(): DecodeGridInfo {
  return {};
}

export interface DecodeViewportOptions {
  format: PixelFormat;
  region?: Region | null;
  targetWidth?: number;
  targetHeight?: number;
  fitMode?: "contain" | "cover" | "stretch";
  preserveIcc?: boolean;
  preserveMetadata?: boolean;
  progressionTarget?: "header" | "dc" | "pass" | "final";
  emitEveryPass?: boolean;
  progressiveDetail?: ProgressiveDetail;
  progressivePaintTarget?: number;
  maxProgressiveFrames?: number;
}

export function decodeViewport(options: DecodeViewportOptions): JxlDecoder {
  return createDecoder({
    format: options.format,
    region: options.region ?? null,
    downsample: pickDownsample(options),
    progressionTarget: options.progressionTarget ?? "final",
    emitEveryPass: options.emitEveryPass ?? false,
    preserveIcc: options.preserveIcc ?? true,
    preserveMetadata: options.preserveMetadata ?? false,
    targetWidth: options.targetWidth ?? null,
    targetHeight: options.targetHeight ?? null,
    fitMode: options.fitMode ?? null,
    ...(options.progressiveDetail !== undefined ? { progressiveDetail: options.progressiveDetail } : {}),
    ...(options.progressivePaintTarget !== undefined ? { progressivePaintTarget: options.progressivePaintTarget } : {}),
    ...(options.maxProgressiveFrames !== undefined ? { maxProgressiveFrames: options.maxProgressiveFrames } : {}),
  });
}

export interface DecodeRegionLodOptions {
  format: PixelFormat;
  region?: Region | null;
  targetLongEdge: number;
}

export function decodeRegionLod(options: DecodeRegionLodOptions): JxlDecoder {
  return createDecoder({
    format: options.format,
    region: options.region ?? null,
    downsample: 1,
    progressionTarget: "final",
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
    targetWidth: options.targetLongEdge,
    targetHeight: options.targetLongEdge,
    fitMode: "contain",
  });
}

export function normalizedToPixelExtent(
  norm: { x: number; y: number; w: number; h: number },
  imageWidth: number,
  imageHeight: number,
): Region {
  return {
    x: Math.round(norm.x * imageWidth),
    y: Math.round(norm.y * imageHeight),
    w: Math.max(1, Math.round(norm.w * imageWidth)),
    h: Math.max(1, Math.round(norm.h * imageHeight)),
  };
}

export function pixelToNormalizedExtent(
  region: Region,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: region.x / imageWidth,
    y: region.y / imageHeight,
    w: region.w / imageWidth,
    h: region.h / imageHeight,
  };
}

// Shared zero-length sentinel used to null out pixelChunks slots during progressive WASM copy.
const EMPTY_U8 = new Uint8Array(0);

class LibjxlDecoder implements JxlDecoder {
  // null sentinel = input closed
  private chunkQueue: Array<Uint8Array | null> = [];
  private readIndex = 0;
  private queuedBytes = 0;
  private wakeResolve: (() => void) | null = null;
  private cancelled = false;
  private closed = false;
  private eventsStarted = false;

  constructor(private readonly options: DecoderOptions) {}

  push(chunk: ArrayBuffer | Uint8Array): void {
    if (this.cancelled || this.closed) return;
    // ArrayBuffer callers (primary path: worker receives transferred chunks via postMessage)
    // are always zero-copy — new Uint8Array(ab) is a view, not a copy. Uint8Array callers
    // may reuse the underlying buffer, so we copy unless copyInput=false.
    const view = copyOrBorrowInput(chunk, this.options.copyInput !== false);
    this.queuedBytes += view.byteLength;
    this.chunkQueue.push(view);
    this.wake();
  }

  close(): void {
    if (this.cancelled || this.closed) return;
    this.closed = true;
    this.chunkQueue.push(null);
    this.wake();
  }

  private wake(): void {
    const resolve = this.wakeResolve;
    if (resolve !== null) {
      this.wakeResolve = null;
      resolve();
    }
  }

  private waitForQueueItem(): Promise<void> {
    if (this.chunkQueue.length > this.readIndex) return Promise.resolve();
    return new Promise<void>((resolve) => { this.wakeResolve = resolve; });
  }

  private compactQueue(): void {
    if (this.readIndex >= this.chunkQueue.length) {
      this.chunkQueue.length = 0;
      this.readIndex = 0;
    } else if (this.readIndex > 64 && this.readIndex * 2 > this.chunkQueue.length) {
      this.chunkQueue.copyWithin(0, this.readIndex);
      this.chunkQueue.length -= this.readIndex;
      this.readIndex = 0;
    }
  }

  async *events(): AsyncIterable<DecodeEvent> {
    if (this.eventsStarted) {
      yield { type: "error", code: "InvalidState", message: "Decoder events() may only be consumed once." };
      return;
    }
    this.eventsStarted = true;
    try {
      if (this.cancelled) return;
      const module = await loadLibjxlModule();
      const caps = getCapabilities(module);
      if (this.options.format !== "rgba8" && !caps.progressiveDecode) {
        const decFn = this.options.format === "rgba16" ? "_jxl_wasm_decode_rgba16" : "_jxl_wasm_decode_rgbaf32";
        if (typeof module[decFn] !== "function") {
          throw new CapabilityMissing(`${this.options.format} decode requires a rebuilt WASM with multi-format bridge`);
        }
      }
      if (caps.progressiveDecode) {
        yield* this.eventsProgressive(module);
      } else {
        yield* this.eventsOneShot(module);
      }
    } catch (error) {
      yield {
        type: "error",
        code: error instanceof CapabilityMissing ? error.code : "DecodeFailed",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.chunkQueue = [];
      this.readIndex = 0;
      this.queuedBytes = 0;
      this.cancelled = true;
    }
  }

  private async *eventsProgressive(module: LibjxlWasmModule): AsyncIterable<DecodeEvent> {
    const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : 0;
    const progressiveDetail = resolveDecoderProgressiveDetail(this.options);
    const decFlags = (this.options.suppressDuplicateProgress ? DEC_FLAG_SUPPRESS_DUPLICATE_PROGRESS : 0)
      | (this.options.allowAlphaProgressive ? DEC_FLAG_ALLOW_ALPHA_PROGRESSIVE : 0);
    const dec = module._jxl_wasm_dec_create_x
      ? module._jxl_wasm_dec_create_x(fmtIndex, progressiveDetail, decFlags)
      : module._jxl_wasm_dec_create!(fmtIndex, progressiveDetail);
    if (dec === 0) throw new Error("JXL progressive decoder creation failed");
    // Paint-cadence control: when set, ask libjxl for ~N evenly spaced AC paints
    // instead of one per encoded pass (kPasses detail). Requires the rebuilt
    // bridge; older modules without the symbol silently keep per-pass pausing.
    const paintTarget = this.options.progressivePaintTarget;
    if (paintTarget != null && paintTarget > 0 &&
        typeof module._jxl_wasm_dec_set_paint_target === "function") {
      module._jxl_wasm_dec_set_paint_target(dec, paintTarget);
    }
    // Cache bridge fn refs once — avoids repeated property lookup on module per iteration.
    const decPush         = module._jxl_wasm_dec_push!;
    const decWidth        = module._jxl_wasm_dec_width!;
    const decHeight       = module._jxl_wasm_dec_height!;
    const decError        = module._jxl_wasm_dec_error!;
    const decTakeFlushed  = module._jxl_wasm_dec_take_flushed!;
    const decTakeFinal    = module._jxl_wasm_dec_take_final!;
    const decCloseInput   = module._jxl_wasm_dec_close_input!;
    const decFree         = module._jxl_wasm_dec_free!;
    let chunkBufPtr = 0;
    let chunkBufCap = 0;
    // Rank #2: Deferred-release buffer reuse (zero-copy pixel emission).
    let reusablePixelBuf: ArrayBuffer | null = null;
    let reusablePixelCap = 0; // capacity in bytes
    // Rank #2: Defer pixel buffer allocation until actual image dimensions are known.
    // A fixed 1920×1080×4 pre-allocation would throw for images larger than HD (e.g. 4K = 33 MB).
    // Instead, allocate (or grow) lazily on first use inside preparePixelsForEmit.
    try {
      // Rank #6: Pre-allocate chunk buffer upfront if expectedBytes provided.
      // Inside the try so an OOM here still frees the decoder in the finally
      // (it used to run before the try and leak `dec` on throw).
      if (this.options.expectedBytes != null && this.options.expectedBytes > 0) {
        const tMalloc0 = performance.now();
        chunkBufPtr = module._malloc(this.options.expectedBytes);
        if (chunkBufPtr === 0) {
          throw new Error("WASM Memory Allocation OOM during pre-allocation for progressive stream");
        }
        chunkBufCap = this.options.expectedBytes;
        this.options.onMetric?.("malloc_prealloc_ms", performance.now() - tMalloc0);
      }
      let headerEmitted = false;
      let info: ImageInfo | undefined;
      let gotRealFlush = false;
      let done = false;
      // Count flushed intermediate frames: first flush is the DC pass,
      // subsequent flushes are AC refinement passes.
      let flushCount = 0;

      const buildInfo = (w: number, h: number, bitsPerSample: 8 | 16 | 32 = normalizeBitsPerSample(bpc * 8), hasAlpha = true): ImageInfo => {
        info ??= { width: w, height: h, bitsPerSample, hasAlpha, hasAnimation: false, jpegReconstructionAvailable: false };
        return info;
      };

      const bpc = fmtIndex === 2 ? 4 : fmtIndex === 1 ? 2 : 1;
      const pixelStride = 4 * bpc;
      const fmt = this.options.format;
      let resolvedDownsample: 1 | 2 | 4 | 8 = this.options.downsample ?? 1;
      // Set once the header is known: true when the rebuilt bridge will crop+downsample this
      // decode in C++ (dec_set_region called), so takeAndWrap must NOT re-crop in JS.
      let cppRoi = false;
      let resizePlan: ResizePlan | null = null;
      let progressiveSequence = 0;
      let progFramePrepMs = 0;
      let progFrameCount = 0;
      const progressFrameBudget = resolveProgressFrameBudget(this.options);
      let emittedProgressFrames = 0;
      // P0 probe (docs/Boundaries and Pipelines/traversal-report.md #2): isolate the
      // region-crop + downsample cost (a subset of take_frame_ms) and the resize cost
      // out of the aggregate prog_frame_prep_ms. Sizes the "move progressive crop to C++"
      // migration decision — region_crop_ms is exactly the JS work that move would replace.
      let regionCropMs = 0;
      let progResizeMs = 0;

      // Helper: emit with deferred-release or normal transfer
      // Modifies pixData in-place: when deferredRelease=true, copies into reusablePixelBuf.
      // Returns the pixels to emit (shared ref if deferredRelease, otherwise original array).
      const preparePixelsForEmit = (pixData: Uint8Array): ArrayBuffer | Uint8Array => {
        if (this.options.deferredRelease) {
          // Grow the reusable buffer if needed (first use or image larger than previous frame).
          if (reusablePixelBuf === null || pixData.byteLength > reusablePixelCap) {
            reusablePixelBuf = new ArrayBuffer(pixData.byteLength);
            reusablePixelCap = pixData.byteLength;
            this.options.onMetric?.("deferred_release_alloc_bytes", pixData.byteLength);
          }
          // Copy from source array into reusable buffer.
          // Caller will copy again if needed; transparent to session layer.
          const dstView = new Uint8Array(reusablePixelBuf, 0, pixData.byteLength);
          dstView.set(pixData);
          return reusablePixelBuf; // shared reference, not transferred
        }
        return pixData; // standard transfer (will be detached by postMessage if used)
      };

      const takeAndWrap = (handle: number): { pixels: { data: Uint8Array; width: number; height: number; region?: Region }; evInfo: ImageInfo } | null => {
        if (handle === 0) return null;
        const buf = retainBufferView(module, handle, "decode");
        try {
          let pixels: { data: Uint8Array; width: number; height: number; region?: Region };
          if (cppRoi) {
            // C++ already cropped + nearest-downsampled to output dims (byte-exact with the JS
            // path). Copy out of the borrowed WASM view — roi_buf is reused across paints.
            pixels = { data: new Uint8Array(buf.data), width: buf.width, height: buf.height };
            if (this.options.region != null) pixels.region = { x: 0, y: 0, w: buf.width, h: buf.height };
          } else {
            const tCrop0 = performance.now();
            pixels = applyRegionAndDownsample(buf.data, buf.width, buf.height, this.options.region ?? null, resolvedDownsample, bpc);
            regionCropMs += performance.now() - tCrop0;
            if (pixels.data === buf.data) {
              pixels = { ...pixels, data: new Uint8Array(buf.data) };
            }
          }
          // evInfo: full image dims live in the memoized `info` (set at header). buildInfo
          // memoizes on first call, so it always returns the full-dim object; when the output
          // is cropped/downsampled, override width/height with the actual pixel dims.
          const baseInfo = buildInfo(buf.width, buf.height, buf.bitsPerSample, buf.hasAlpha);
          const fullW = info ? info.width : buf.width;
          const fullH = info ? info.height : buf.height;
          const evInfo: ImageInfo = (pixels.width !== fullW || pixels.height !== fullH)
            ? { ...baseInfo, width: pixels.width, height: pixels.height }
            : baseInfo;
          return { pixels, evInfo };
        } finally {
          buf.release();
        }
      };

      const hasRegion = this.options.region != null;
      const onMetric = this.options.onMetric;
      let fallbackMetricEmitted = false;
      let drainPending = false;
      let inputClosed = false;

      // IMPROVEMENT-7: Batch all queued data chunks into one WASM write per tick.
      // IMPROVEMENT-9: Guard dec_width/dec_height calls behind !headerEmitted — skip 2 WASM
      // FFI calls per chunk once the header has been emitted.
      while (!done && !this.cancelled) {
        if (!drainPending && this.chunkQueue.length <= this.readIndex) {
          await this.waitForQueueItem();
          if (this.cancelled) return;
        }

        let result = 0;

        if (drainPending) {
          result = decPush(dec, 0, 0);
          if (result < 0) throw new Error(`JXL decode error: ${decError(dec)}`);
        } else if (this.chunkQueue.length > this.readIndex && this.chunkQueue[this.readIndex] === null) {
          // Close sentinel — flush remaining decoder state, then keep draining until done.
          this.readIndex++;
          this.compactQueue();
          decCloseInput(dec);
          inputClosed = true;
          result = decPush(dec, 0, 0);
          if (result < 0) throw new Error(`JXL decode error: ${decError(dec)}`);
        } else {
          // Pending byte count maintained incrementally — no scan needed.
          const batchBytes = this.queuedBytes;
          if (batchBytes <= 0) continue;
          if (batchBytes > chunkBufCap) {
            const tMalloc0 = performance.now();
            if (chunkBufPtr !== 0) module._free(chunkBufPtr);
            chunkBufPtr = module._malloc(batchBytes);
            if (chunkBufPtr === 0) {
              throw new Error("WASM Memory Allocation OOM during progressive stream push");
            }
            chunkBufCap = batchBytes;
            this.options.onMetric?.("malloc_grow_ms", performance.now() - tMalloc0);
          }
          let woff = 0;
          const tHeapSet0 = performance.now();
          while (this.chunkQueue.length > this.readIndex && this.chunkQueue[this.readIndex] !== null) {
            const chunk = this.chunkQueue[this.readIndex] as Uint8Array;
            // Null slot immediately so GC can reclaim the Uint8Array after the HEAPU8.set copy.
            this.chunkQueue[this.readIndex++] = null;
            this.queuedBytes -= chunk.byteLength;
            module.HEAPU8.set(chunk, chunkBufPtr + woff);
            woff += chunk.byteLength;
          }
          this.options.onMetric?.("heap_set_ms", performance.now() - tHeapSet0);
          this.compactQueue();
          result = decPush(dec, chunkBufPtr, batchBytes);
          if (result < 0) throw new Error(`JXL decode error: ${decError(dec)}`);
        }

        if (!headerEmitted) {
          const w = decWidth(dec);
          const h = decHeight(dec);
          if (w > 0 && h > 0) {
            headerEmitted = true;
            if (this.options.downsample == null) {
              resolvedDownsample = pickDownsample({
                region: this.options.region ?? null,
                targetWidth: this.options.targetWidth ?? null,
                targetHeight: this.options.targetHeight ?? null,
                sourceWidth: w,
                sourceHeight: h,
              });
            }
            const targetW = this.options.targetWidth;
            const targetH = this.options.targetHeight;
            const fitMode = this.options.fitMode ?? "contain";
            if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
              const scaledW = Math.max(1, Math.ceil(w / resolvedDownsample));
              const scaledH = Math.max(1, Math.ceil(h / resolvedDownsample));
              resizePlan = buildResizePlan(scaledW, scaledH, targetW, targetH, fitMode, bpc as 1 | 2 | 4);
            }
            // C++-side progressive ROI crop: when the rebuilt bridge exposes dec_set_region and
            // there is real crop/downsample work, do it in C++ (byte-exact with the JS
            // applyRegionAndDownsample fallback) so the per-paint JS crop loop is skipped and
            // only the cropped pixels cross to JS. Absent symbol => JS fallback unchanged.
            const needsCrop = this.options.region != null || resolvedDownsample > 1;
            if (needsCrop && typeof module._jxl_wasm_dec_set_region === "function") {
              const r = this.options.region;
              const rx = r ? Math.max(0, Math.trunc(r.x)) : 0;
              const ry = r ? Math.max(0, Math.trunc(r.y)) : 0;
              const rw = r ? Math.max(1, Math.trunc(r.w)) : w;
              const rh = r ? Math.max(1, Math.trunc(r.h)) : h;
              module._jxl_wasm_dec_set_region(dec, rx, ry, rw, rh, resolvedDownsample);
              cppRoi = true;
            }
            yield { type: "header", info: buildInfo(w, h) };
            if (this.options.progressionTarget === "header") return;
          }
        }

        if (result === 1) {
          drainPending = true;
          gotRealFlush = true;
          flushCount++;
          const stage: DecodeStage = flushCount === 1 ? "dc" : "pass";
          // Skip intermediate frame processing when consumer only wants the final frame.
          // Must still consume the WASM buffer handle to unblock the decoder.
          if (!this.options.emitEveryPass && this.options.progressionTarget === "final") {
            const h = decTakeFlushed(dec);
            if (h !== 0) module._jxl_wasm_buffer_free(h);
            continue;
          }
          if (this.options.progressionTarget === "final" && emittedProgressFrames >= progressFrameBudget) {
            const h = decTakeFlushed(dec);
            if (h !== 0) module._jxl_wasm_buffer_free(h);
            continue;
          }
          const tFramePrep0 = performance.now();
          const tTake0 = performance.now();
          const wrapped = takeAndWrap(decTakeFlushed(dec));
          this.options.onMetric?.("take_frame_ms", performance.now() - tTake0);
          if (wrapped !== null) {
            const { pixels: rawPixels, evInfo } = wrapped;

            // P4: emit region_fallback_full_frame metric once when progressive + region active.
            if (hasRegion && !fallbackMetricEmitted && onMetric) {
              onMetric("region_fallback_full_frame", 1);
              fallbackMetricEmitted = true;
            }

            // P1: apply bilinear resize if target dims set.
            const targetW = this.options.targetWidth;
            const targetH = this.options.targetHeight;
            const fitMode = this.options.fitMode ?? "contain";
            let outPixels = rawPixels;
            if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
              const tResize0 = performance.now();
              const resized = applyTargetResize(rawPixels.data, rawPixels.width, rawPixels.height, targetW, targetH, fitMode, bpc as 1 | 2 | 4, resizePlan);
              progResizeMs += performance.now() - tResize0;
              outPixels = { data: resized.data, width: resized.width, height: resized.height, ...(rawPixels.region !== undefined ? { region: rawPixels.region } : {}) };
            }
            progFramePrepMs += performance.now() - tFramePrep0;
            progFrameCount++;

            const outInfo: ImageInfo = (outPixels.width !== evInfo.width || outPixels.height !== evInfo.height)
              ? { ...evInfo, width: outPixels.width, height: outPixels.height }
              : evInfo;

            const ev: Extract<DecodeEvent, { type: "progress" }> = {
              type: "progress",
              stage,
              info: outInfo,
              pixels: preparePixelsForEmit(outPixels.data),
              format: fmt,
              pixelStride,
              sourceScale: resolvedDownsample,
              progressiveRegion: false,
              progressiveSequence: ++progressiveSequence,
              passOrdinal: flushCount - 1,
            };
            if (hasRegion) ev.regionFallback = "full-frame-then-crop";
            if (outPixels.region !== undefined) ev.region = outPixels.region;
            emittedProgressFrames++;
            yield ev;
            if (this.options.progressionTarget !== "final" && !this.options.emitEveryPass) return;
          }
          continue;
        }

        drainPending = false;
        if (result === 2) {
          done = true;
        } else if (inputClosed) {
          throw new Error(`JXL decode error: ${decError(dec)}`);
        }
      }

      if (done) {
        const tFinalPrep0 = performance.now();
        const wrapped = takeAndWrap(decTakeFinal(dec));
        if (wrapped !== null) {
          const { pixels: rawPixels, evInfo } = wrapped;

          // P5: emit decode metrics on final frame.
          if (onMetric) {
            onMetric("decode_scale_used", resolvedDownsample);
            // info is memoized full-frame dims from buildInfo; fall back to rawPixels if header not yet seen.
            const fullW = info?.width ?? rawPixels.width;
            const fullH = info?.height ?? rawPixels.height;
            onMetric("source_pixels_decoded", fullW * fullH);
            if (hasRegion && this.options.region != null) {
              onMetric("decode_region_area", this.options.region.w * this.options.region.h);
            }
          }

          // P1: apply bilinear resize if target dims set.
          const targetW = this.options.targetWidth;
          const targetH = this.options.targetHeight;
          const fitMode = this.options.fitMode ?? "contain";
          let outPixels = rawPixels;
          if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
            const tResize0 = performance.now();
            const resized = applyTargetResize(rawPixels.data, rawPixels.width, rawPixels.height, targetW, targetH, fitMode, bpc as 1 | 2 | 4, resizePlan);
            progResizeMs += performance.now() - tResize0;
            outPixels = { data: resized.data, width: resized.width, height: resized.height, ...(rawPixels.region !== undefined ? { region: rawPixels.region } : {}) };
          }

          progFramePrepMs += performance.now() - tFinalPrep0;
          progFrameCount++;
          if (onMetric) {
            onMetric("prog_frame_prep_ms", progFramePrepMs);
            onMetric("prog_frame_count", progFrameCount);
            // P0 breakdown: region_crop_ms ⊆ take_frame_ms; resize is the remainder of prep.
            onMetric("region_crop_ms", regionCropMs);
            onMetric("prog_frame_resize_ms", progResizeMs);
          }

          const outInfo: ImageInfo = (outPixels.width !== evInfo.width || outPixels.height !== evInfo.height)
            ? { ...evInfo, width: outPixels.width, height: outPixels.height }
            : evInfo;

          if (!gotRealFlush && (this.options.emitEveryPass || this.options.progressionTarget === "dc" || this.options.progressionTarget === "pass")) {
            const stage: DecodeStage = this.options.progressionTarget === "dc" ? "dc" : "pass";
            const ev: Extract<DecodeEvent, { type: "progress" }> = {
              type: "progress",
              stage,
              info: outInfo,
              pixels: preparePixelsForEmit(outPixels.data),
              format: fmt,
              pixelStride,
              sourceScale: resolvedDownsample,
              progressiveRegion: false,
              progressiveSequence: ++progressiveSequence,
              passOrdinal: flushCount,
            };
            if (hasRegion) ev.regionFallback = "full-frame-then-crop";
            if (outPixels.region !== undefined) ev.region = outPixels.region;
            yield ev;
            if (this.options.progressionTarget !== "final") return;
          }

          const ev: Extract<DecodeEvent, { type: "final" }> = {
            type: "final",
            info: outInfo,
            pixels: preparePixelsForEmit(outPixels.data),
            format: fmt,
            pixelStride,
            sourceScale: resolvedDownsample,
            progressiveRegion: false,
            progressiveSequence: ++progressiveSequence,
            passOrdinal: flushCount,
          };
          if (hasRegion) ev.regionFallback = "full-frame-then-crop";
          if (outPixels.region !== undefined) ev.region = outPixels.region;
          yield ev;
        }
      }
    } finally {
      if (chunkBufPtr !== 0) module._free(chunkBufPtr);
      emitDecoderBridgeMetrics(module, dec, this.options);
      decFree(dec);
    }
  }

  private async *eventsOneShot(module: LibjxlWasmModule): AsyncIterable<DecodeEvent> {
    // Drain all chunks until input closed
    const allChunks: Uint8Array[] = [];
    while (!this.cancelled) {
      await this.waitForQueueItem();
      if (this.cancelled) return;
      const item = this.chunkQueue[this.readIndex++];
      this.compactQueue();
      if (item === null || item === undefined) break;
      this.queuedBytes -= item.byteLength;
      allChunks.push(item);
    }
    if (this.cancelled) return;

    const fmt = this.options.format;
    const bpc = fmt === "rgbaf32" ? 4 : fmt === "rgba16" ? 2 : 1;
    const pixelStride = 4 * bpc;
    // Rank #2: Reusable pixel buffer for deferredRelease mode (symmetric with eventsProgressive).
    // Allocated lazily on first use so the exact image size drives the allocation; a fixed
    // 1920×1080×4 pre-allocation would throw for any image larger than HD (e.g. 4K = 33 MB).
    let reusablePixelBuf: ArrayBuffer | null = null;
    let reusablePixelCap = 0; // capacity in bytes
    // Helper: emit with deferred-release or normal transfer
    const preparePixelsForEmit = (pixData: Uint8Array): ArrayBuffer | Uint8Array => {
      if (this.options.deferredRelease) {
        // Grow the reusable buffer if needed (first use or image larger than previous frame).
        if (reusablePixelBuf === null || pixData.byteLength > reusablePixelCap) {
          reusablePixelBuf = new ArrayBuffer(pixData.byteLength);
          reusablePixelCap = pixData.byteLength;
          this.options.onMetric?.("deferred_release_alloc_bytes_oneshot", pixData.byteLength);
        }
        // Copy from source array into reusable buffer.
        const dstView = new Uint8Array(reusablePixelBuf, 0, pixData.byteLength);
        dstView.set(pixData);
        return reusablePixelBuf; // shared reference, not transferred
      }
      return pixData; // standard transfer (will be detached by postMessage if used)
    };
    // Write all chunks directly into a single WASM heap buffer — no intermediate JS allocation.
    const totalSize = allChunks.reduce((s, c) => s + c.byteLength, 0);
    const inputPtr = module._malloc(totalSize);
    if (inputPtr === 0 && totalSize > 0) {
      throw new Error("WASM malloc failed for one-shot decode input");
    }
    let decodedHandle = 0;
    try {
      let woff = 0;
      for (const chunk of allChunks) {
        module.HEAPU8.set(chunk, inputPtr + woff);
        woff += chunk.byteLength;
      }
      allChunks.length = 0;
      // #10: pass region to callDecodeFromPtr — if C++ region bridge present it crops in WASM,
      // avoiding shipping full-image pixels to JS. JS fallback still works via applyRegionAndDownsample.
      const regionForDecode = this.options.region;
      const cppDidCrop = regionForDecode !== null && (
        (fmt === "rgba8" && !!module._jxl_wasm_decode_rgba8_region) ||
        (fmt === "rgba16" && !!module._jxl_wasm_decode_rgba16_region) ||
        (fmt === "rgbaf32" && !!module._jxl_wasm_decode_rgbaf32_region)
      );
      const tWasmDec0 = performance.now();
      const decoded = callDecodeFromPtr(module, inputPtr, totalSize, this.options.downsample ?? 1, fmt, cppDidCrop ? regionForDecode : null);
      decodedHandle = decoded.handle;
      this.options.onMetric?.("shot_wasm_ms", performance.now() - tWasmDec0);
      // If C++ did the crop, decoded.width/height already reflect the region; no further JS crop.
      // Otherwise, scale region into downsampled coords and apply in JS.
      const ds = this.options.downsample ?? 1;
      const tTransform0 = performance.now();
      const scaledRegion = (!cppDidCrop && regionForDecode != null) ? {
        x: Math.trunc(regionForDecode.x / ds),
        y: Math.trunc(regionForDecode.y / ds),
        w: Math.ceil(regionForDecode.w / ds),
        h: Math.ceil(regionForDecode.h / ds),
      } : null;
      const pixels = applyRegionAndDownsample(
        decoded.data,
        decoded.width,
        decoded.height,
        scaledRegion,
        1,
        bpc,
      );
      // C++ crop path skips applyRegionAndDownsample's region-setter; restore it to match JS path.
      if (cppDidCrop) pixels.region = { x: 0, y: 0, w: pixels.width, h: pixels.height };
      // P1: apply bilinear resize to exact target size if requested.
      const targetW = this.options.targetWidth;
      const targetH = this.options.targetHeight;
      const fitMode = this.options.fitMode ?? "contain";
      let outPixels = pixels;
      if (targetW != null && targetH != null && targetW > 0 && targetH > 0) {
        const resized = applyTargetResize(pixels.data, pixels.width, pixels.height, targetW, targetH, fitMode, bpc);
        outPixels = { data: resized.data, width: resized.width, height: resized.height, ...(pixels.region !== undefined ? { region: pixels.region } : {}) };
      }

      const info: ImageInfo = {
        width: outPixels.width,
        height: outPixels.height,
        bitsPerSample: decoded.bitsPerSample,
        hasAlpha: decoded.hasAlpha,
        hasAnimation: false,
        jpegReconstructionAvailable: false,
      };

      // P5: emit decode metrics via onMetric callback.
      const actualScale = this.options.downsample ?? 1;
      const onMetric = this.options.onMetric;
      if (onMetric) {
        onMetric("shot_transform_ms", performance.now() - tTransform0);
        onMetric("decode_scale_used", actualScale);
        onMetric("source_pixels_decoded", decoded.width * decoded.height);
        if (this.options.region != null) {
          onMetric("decode_region_area", this.options.region.w * this.options.region.h);
        }
      }

      yield { type: "header", info };
      if (this.options.progressionTarget === "header") return;
      if (this.options.emitEveryPass || this.options.progressionTarget === "dc" || this.options.progressionTarget === "pass") {
        const ev: Extract<DecodeEvent, { type: "progress" }> = {
          type: "progress",
          stage: this.options.progressionTarget === "dc" ? "dc" : "pass",
          info,
          pixels: preparePixelsForEmit(outPixels.data),
          format: fmt,
          pixelStride,
          sourceScale: actualScale,
          progressiveRegion: false,
        };
        if (outPixels.region !== undefined) ev.region = outPixels.region;
        yield ev;
        if (this.options.progressionTarget !== "final") return;
      }
      const ev: Extract<DecodeEvent, { type: "final" }> = {
        type: "final",
        info,
        pixels: preparePixelsForEmit(outPixels.data),
        format: fmt,
        pixelStride,
        sourceScale: actualScale,
        progressiveRegion: false,
      };
      if (outPixels.region !== undefined) ev.region = outPixels.region;
      yield ev;
    } finally {
      module._free(inputPtr);
      if (decodedHandle !== 0) module._jxl_wasm_buffer_free(decodedHandle);
    }
  }

  cancel(_reason?: string): void {
    this.cancelled = true;
    this.wake();
  }

  dispose(): void {
    this.chunkQueue = [];
    this.readIndex = 0;
    this.queuedBytes = 0;
    this.cancelled = true;
    this.wake();
  }
}

class LibjxlEncoder implements JxlEncoder {
  // Buffered path fallback (used when streaming input not available or sidecars active)
  private pixelChunks: Uint8Array[] = [];
  private finished = false;
  private cancelled = false;
  private finishResolve: (() => void) | null = null;
  private readonly sortedSidecarSizes: readonly number[];
  private encodeStats: EncodeStats | null = null;
  private chunksStarted = false;
  private queuedPixelBytes = 0;
  private readonly pixelByteTotal: number;
  // #16: Streaming input — module loaded on first pushPixels, state allocated immediately.
  // JS never accumulates pixelChunks[] when this path is active.
  private wasmModule: LibjxlWasmModule | null = null;
  private wasmEncState = 0;
  private streamingInputActive = false;
  private moduleInitPromise: Promise<LibjxlWasmModule> | null = null;
  private pendingPushPromise: Promise<void> = Promise.resolve();
  private pendingPushError: unknown = null;

  // Profiling accumulators (for console summary + optional onMetric if wired)
  private tCreateStart = 0;
  private tPushTotal = 0;
  private tFinishStart = 0;
  private tTakeTotal = 0;
  private tMallocCopy = 0;

  constructor(private readonly options: EncoderOptions) {
    this.sortedSidecarSizes = options.sidecarSizes ? [...options.sidecarSizes].sort((a, b) => a - b) : [];
    this.pixelByteTotal = expectedPixelBytes(options.width, options.height, options.format);
  }

  async pushPixels(chunk: ArrayBuffer | Uint8Array, region?: Region): Promise<void> {
    if (this.cancelled || this.finished) return;
    if (region !== undefined) {
      throw new CapabilityMissing("libjxl WASM facade does not support chunked region encode yet");
    }
    const view = copyOrBorrowInput(chunk, this.options.copyInput !== false);
    if (this.queuedPixelBytes + view.byteLength > this.pixelByteTotal) {
      throw new Error(`JXL encode received too many pixel bytes: expected ${this.pixelByteTotal}, got at least ${this.queuedPixelBytes + view.byteLength}`);
    }
    this.queuedPixelBytes += view.byteLength;
    const pushTask = this.pendingPushPromise.then(async () => {
      const tPush0 = performance.now();
      const module = await this.ensureModule();
      if (this.cancelled) return;

      if (this.streamingInputActive) {
        if (module._jxl_wasm_enc_pixels_ptr && module._jxl_wasm_enc_advance_written) {
          const t0 = performance.now();
          const ptr = module._jxl_wasm_enc_pixels_ptr(this.wasmEncState, view.byteLength);
          if (ptr === 0) throw new Error("JXL streaming pixel push failed (0)");
          const tEncHeapSet0 = performance.now();
          module.HEAPU8.set(view, ptr);
          this.options.onMetric?.("enc_heap_set_ms", performance.now() - tEncHeapSet0);
          const rc = module._jxl_wasm_enc_advance_written(this.wasmEncState, view.byteLength);
          if (rc !== 0) throw new Error(`JXL streaming pixel push failed (${rc})`);
          this.tMallocCopy += performance.now() - t0;
        } else {
          // Back-compat with older WASM bridge: temp copy into WASM, then bridge memcpy.
          const t0 = performance.now();
          const ptr = module._malloc(view.byteLength);
          if (ptr === 0) throw new Error("WASM malloc failed for streaming pixel push");
          try {
            module.HEAPU8.set(view, ptr);
            const rc = module._jxl_wasm_enc_push_chunk!(this.wasmEncState, ptr, view.byteLength);
            if (rc !== 0) throw new Error(`JXL streaming pixel push failed (${rc})`);
            this.tMallocCopy += performance.now() - t0;
          } finally {
            module._free(ptr);
          }
        }
      } else {
        this.pixelChunks.push(view);
      }
      this.tPushTotal += performance.now() - tPush0;
    });
    this.pendingPushPromise = pushTask.catch((error) => {
      this.pendingPushError = error;
    });
    await pushTask;
  }

  private ensureModule(): Promise<LibjxlWasmModule> {
    this.moduleInitPromise ??= this.initModule();
    return this.moduleInitPromise;
  }

  private async initModule(): Promise<LibjxlWasmModule> {
    const t0 = performance.now();
    const module = await loadLibjxlModule();
    this.wasmModule = module;
    if (this.cancelled) return module;
    this.tCreateStart = performance.now() - t0; // includes first load if cold

    const caps = getCapabilities(module);
    // Use streaming input only when sidecars are not requested — sidecar path takes
    // a complete RGBA8 pixel pointer and cannot be fed incrementally.
    // Also skip streaming input when metadata (ICC/EXIF/XMP) is present: the
    // streaming input path calls enc_finish → EncodeRgba which has no metadata
    // parameter. Fall back to the buffered path which routes through
    // encode_rgba8_with_metadata so metadata is preserved for all pixel formats.
    const wantSidecars = this.sortedSidecarSizes.length > 0 && caps.sidecars;
    const hasMetadataOpts = this.options.iccProfile !== null || this.options.exif !== null || this.options.xmp !== null;
    if (!wantSidecars && !hasMetadataOpts && caps.streamingInput) {
      const distance = this.options.distance ?? distanceFromQuality(this.options.quality);
      const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : this.options.format === "rgb8" ? 3 : 0;
      const { progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder } = resolveEncoderBridgeSettings(this.options);

      const o = this.options;
      const resampling = o.resampling ?? 1;
      // Photon-noise progressive path: the JXL Noise frame feature is a VarDCT-only
      // tool (it has no representation in the Modular sub-codec). When photonNoiseIso>0
      // the encoder can only emit VarDCT, so pin modular=0 explicitly instead of leaving
      // it at -1 (auto). This removes the rejected-Modular auto-trial the encoder would
      // otherwise evaluate per decision point, and guarantees bridge.cpp:644
      // JXL_ENC_FRAME_SETTING_PHOTON_NOISE is actually honored (Modular ignores it).
      const photonActive = (o.photonNoiseIso ?? 0) > 0;
      const modularDefault = photonActive ? 0 : -1;
      const needsZ = caps.streamingInputZ && (o.orientation != null || o.intrinsicWidth != null || o.intrinsicHeight != null || o.disablePerceptualHeuristics != null || o.codestreamLevel != null || o.centerX != null || o.centerY != null);
      const needsY = !needsZ && caps.streamingInputY && (o.epf != null || o.gaborish != null || o.dots != null || o.colorTransform != null);
      const needsX = !needsZ && !needsY && caps.streamingInputX && (o.modular != null || o.brotliEffort != null || o.decodingSpeed != null || o.photonNoiseIso != null);

      if (needsZ) {
        this.wasmEncState = module._jxl_wasm_enc_create_image_z!(
          o.width, o.height, distance, o.effort,
          fmtIndex, o.hasAlpha ? 1 : 0,
          progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder,
          o.modular ?? modularDefault, o.brotliEffort ?? -1, o.decodingSpeed ?? -1, o.photonNoiseIso ?? 0, resampling,
          o.epf ?? -1, o.gaborish ?? -1, o.dots ?? -1, 0, o.colorTransform ?? -1,
          o.orientation ?? 1,
          o.centerX ?? 0, o.centerY ?? 0,
          0, 0, 0, 0, 0, -1
        );
        if (this.wasmEncState !== 0) {
          if ((o.intrinsicWidth ?? 0) > 0 && (o.intrinsicHeight ?? 0) > 0) {
            module._jxl_wasm_enc_set_intrinsic_size?.(this.wasmEncState, o.intrinsicWidth!, o.intrinsicHeight!);
          }
          if (o.disablePerceptualHeuristics != null) {
            module._jxl_wasm_enc_set_frame_flags?.(this.wasmEncState, o.disablePerceptualHeuristics);
          }
          if (o.codestreamLevel != null && o.codestreamLevel !== -1) {
            module._jxl_wasm_enc_set_codestream_level?.(this.wasmEncState, o.codestreamLevel);
          }
        }
      } else if (needsY) {
        this.wasmEncState = module._jxl_wasm_enc_create_image_y!(
          o.width, o.height, distance, o.effort,
          fmtIndex, o.hasAlpha ? 1 : 0,
          progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder,
          o.modular ?? modularDefault, o.brotliEffort ?? -1, o.decodingSpeed ?? -1, o.photonNoiseIso ?? 0, resampling,
          o.epf ?? -1, o.gaborish ?? -1, o.dots ?? -1, 0, o.colorTransform ?? -1,
          0, 0, 0, 0, 0, 0, 0, -1
        );
      } else if (needsX) {
        this.wasmEncState = module._jxl_wasm_enc_create_image_x!(
          o.width, o.height, distance, o.effort,
          fmtIndex, o.hasAlpha ? 1 : 0,
          progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder,
          o.modular ?? modularDefault, o.brotliEffort ?? -1, o.decodingSpeed ?? -1, o.photonNoiseIso ?? 0, resampling,
          0, 0, 0, 0, 0, -1
        );
      } else {
        this.wasmEncState = module._jxl_wasm_enc_create_image!(
          o.width, o.height, distance, o.effort,
          fmtIndex, o.hasAlpha ? 1 : 0,
          progressiveDc, progressiveAc, qProgressiveAc, buffering,
          groupOrder, resampling
        );
      }

      if (this.wasmEncState === 0) throw new Error("JXL streaming encoder: pixel buffer allocation failed");
      this.streamingInputActive = true;
    }
    return module;
  }

  /**
   * P3-T2 (finding 18): apply advancedFrameSettings via the ONE generic libjxl-validated setter.
   * Called from the streaming chunks() path immediately before enc_finish so errors surface
   * cleanly through the generator. These are NEVER silently dropped: a build lacking the setter
   * fails loudly here, and libjxl rejects an unknown/unsupported id at enc_finish (nonzero rc).
   */
  private applyAdvancedFrameSettings(module: LibjxlWasmModule): void {
    const adv = this.options.advancedFrameSettings;
    if (!adv?.length) return;
    if (typeof module._jxl_wasm_enc_set_frame_setting !== "function") {
      throw new CapabilityMissing(
        "advancedFrameSettings requires a rebuilt WASM with the generic frame setting bridge (_jxl_wasm_enc_set_frame_setting)",
      );
    }
    for (const s of adv) {
      // The FFI carries id + value as C `int` (int32). A value outside int32 would truncate
      // via wraparound at the WASM boundary and reach libjxl as a silently-wrong number — the
      // exact "silently ignored" failure this task forbids. Reject out-of-range LOUDLY instead.
      // (Every integer JxlEncoderFrameSettingId in libjxl 0.11.x is a small bounded int; float
      // settings are a separate API this integer escape hatch intentionally does not cover.)
      if (!Number.isInteger(s.id) || s.id < INT32_MIN || s.id > INT32_MAX) {
        throw new Error(`JXL frame setting id ${s.id} is not a valid int32`);
      }
      if (!Number.isInteger(s.value) || s.value < INT32_MIN || s.value > INT32_MAX) {
        throw new Error(
          `JXL frame setting ${s.id} value ${s.value} is out of int32 range; the integer frame-setting ` +
            `bridge cannot represent it (float-valued settings are not supported via advancedFrameSettings)`,
        );
      }
      const rc = module._jxl_wasm_enc_set_frame_setting(this.wasmEncState, s.id, s.value);
      if (rc !== 0) throw new Error(`JXL frame setting ${s.id} rejected at queue time (${rc})`);
    }
  }

  finish(): void {
    this.finished = true;
    this.finishResolve?.();
    this.finishResolve = null;
  }

  async *chunks(): AsyncIterable<ArrayBuffer | Uint8Array> {
    if (this.chunksStarted) {
      throw new Error("Encoder chunks() may only be consumed once.");
    }
    this.chunksStarted = true;

    await this.waitUntilFinished();
    if (this.cancelled) return;
    await this.pendingPushPromise;
    if (this.pendingPushError !== null) throw this.pendingPushError;

    // Module may not be loaded yet if no pixels were pushed (zero-byte edge case).
    const module = this.wasmModule ?? await loadLibjxlModule();
    if (this.queuedPixelBytes !== this.pixelByteTotal) {
      throw new Error(`JXL encode expected ${this.pixelByteTotal} bytes for ${this.options.format}, got ${this.queuedPixelBytes}`);
    }

    let compressedBytes = 0;

    if (this.streamingInputActive && this.wasmEncState !== 0) {
      // #16: Streaming input path — pixels already in WASM pixel buffer.
      // enc_finish runs the encode; enc_take_chunk drains the output.
      try {
        // Apply generic frame settings (finding 18) before finish — errors surface via this try.
        this.applyAdvancedFrameSettings(module);
        const tFin0 = performance.now();
        const rc = module._jxl_wasm_enc_finish!(this.wasmEncState);
        if (rc !== 0) throw new Error(`JXL streaming encode finish failed (${rc})`);
        this.tFinishStart = performance.now() - tFin0;

        let chunkHandle: number;
        while ((chunkHandle = module._jxl_wasm_enc_take_chunk!(this.wasmEncState)) !== 0) {
          const tTake0 = performance.now();
          const chunk = takeBuffer(module, chunkHandle, "encode");
          this.tTakeTotal += performance.now() - tTake0;
          compressedBytes += chunk.data.byteLength;
          yield chunk.data;
        }
        // C++ uses MakeBufferBorrowed (zero-copy into outbuf), but the chunks() consumer accumulates
        // chunks and the `finally` below runs enc_free (frees outbuf) once the generator completes —
        // so a borrowed subarray would dangle. takeBuffer copies each chunk (HEAPU8.slice) so the
        // yielded bytes outlive enc_free. (Multi-chunk outputs >256 KB corrupted with the old borrow.)
      } finally {
        this.freeWasmState(); // handles advanced pointers + enc_free
      }
    } else {
      // Buffered path — accumulate pixelChunks in JS, copy to WASM, then encode.
      // Write pixel chunks directly into WASM heap — no concatBytes allocation.
      // Release each JS chunk reference immediately after copying to reduce peak JS heap overlap.
      if (this.options.format === "rgba16" || this.options.format === "rgbaf32") {
        const encFn = this.options.format === "rgba16" ? "_jxl_wasm_encode_rgba16" : "_jxl_wasm_encode_rgbaf32";
        if (typeof module[encFn] !== "function") {
          throw new CapabilityMissing(`${this.options.format} encode requires a rebuilt WASM with multi-format bridge`);
        }
      }
      const ptr = module._malloc(this.pixelByteTotal);
      if (ptr === 0) throw new Error("WASM malloc failed for buffered encode pixels");
      try {
        let offset = 0;
        for (let i = 0; i < this.pixelChunks.length; i++) {
          const ch = this.pixelChunks[i]!;
          module.HEAPU8.set(ch, ptr + offset);
          offset += ch.byteLength;
          this.pixelChunks[i] = EMPTY_U8;
        }
        this.pixelChunks = [];
        this.queuedPixelBytes = 0;

        const distance = this.options.distance ?? distanceFromQuality(this.options.quality);
        const hasAlpha = this.options.hasAlpha ? 1 : 0;
        const caps = getCapabilities(module);
        const { progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder } = resolveEncoderBridgeSettings(this.options);
        const resampling = this.options.resampling ?? 1;
        // ICC/EXIF/XMP can only ride the buffered encode_rgba8_with_metadata
        // path — enc_push_pixels (streaming encode) has no metadata parameters
        // and would silently drop the boxes.
        const hasMetadata = this.options.iccProfile !== null || this.options.exif !== null || this.options.xmp !== null;

        // Sidecar thumbnails — yield smallest first for faster first-paint.
        if (this.sortedSidecarSizes.length > 0 && caps.sidecars) {
          const sortedSizes = this.sortedSidecarSizes;
          const dimsPtr = module._malloc(sortedSizes.length * 4);
          if (dimsPtr === 0) throw new Error("WASM malloc failed for sidecar dims");
          try {
            // Write uint32[] into WASM heap (HEAPU32 if available, byte-by-byte otherwise)
            if (module.HEAPU32) {
              const base32 = dimsPtr >>> 2;
              for (let i = 0; i < sortedSizes.length; i++) module.HEAPU32[base32 + i] = (sortedSizes[i] ?? 0) >>> 0;
            } else {
              for (let i = 0; i < sortedSizes.length; i++) {
                const v = (sortedSizes[i] ?? 0) >>> 0;
                module.HEAPU8[dimsPtr + i * 4]     =  v         & 0xff;
                module.HEAPU8[dimsPtr + i * 4 + 1] = (v >>>  8) & 0xff;
                module.HEAPU8[dimsPtr + i * 4 + 2] = (v >>> 16) & 0xff;
                module.HEAPU8[dimsPtr + i * 4 + 3] = (v >>> 24) & 0xff;
              }
            }
            let handle = module._jxl_wasm_encode_rgba8_with_sidecars!(
              ptr, this.options.width, this.options.height,
              distance, this.options.effort, hasAlpha,
              dimsPtr, sortedSizes.length, resampling,
            );
            while (handle !== 0) {
              // Capture next pointer before takeBuffer frees handle.
              const next = module._jxl_wasm_buffer_next!(handle);
              try {
                const buf = takeBuffer(module, handle, "encode");
                compressedBytes += buf.data.byteLength;
                yield buf.data;
              } catch (err) {
                // takeBuffer already freed handle; free remaining chain, then rethrow.
                let cur = next;
                while (cur !== 0) {
                  const nxt = module._jxl_wasm_buffer_next!(cur);
                  module._jxl_wasm_buffer_free(cur);
                  cur = nxt;
                }
                throw err;
              }
              handle = next;
            }
          } finally {
            module._free(dimsPtr);
          }
        } else if (caps.streamingEncode && !hasMetadata) {
          // #11: streaming encoder — yields 256 KB chunks, reducing peak JS heap usage.
          const fmtIndex = this.options.format === "rgbaf32" ? 2 : this.options.format === "rgba16" ? 1 : this.options.format === "rgb8" ? 3 : 0;
            const encState = module._jxl_wasm_enc_create!();
            try {
            const rc = module._jxl_wasm_enc_push_pixels!(encState, ptr, this.options.width, this.options.height, distance, this.options.effort, fmtIndex, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
            if (rc !== 0) throw new Error(`JXL streaming encode failed (${rc})`);
            let chunkHandle: number;
            while ((chunkHandle = module._jxl_wasm_enc_take_chunk!(encState)) !== 0) {
              const chunk = takeBuffer(module, chunkHandle, "encode");
              compressedBytes += chunk.data.byteLength;
              yield chunk.data;
            }
          } finally {
            module._jxl_wasm_enc_free!(encState);
          }
        } else {
          // Standard single-image encode path
          let handle: number;

          // Use metadata path if any metadata is present.
          // fmt: 0=rgba8, 1=rgba16, 2=rgbaf32, 3=rgb8 — matches bridge parameter order.
          const fmt = this.options.format === "rgba16" ? 1 : this.options.format === "rgbaf32" ? 2 : this.options.format === "rgb8" ? 3 : 0;
          if (hasMetadata && module._jxl_wasm_encode_rgba8_with_metadata) {
            const iccView = this.options.iccProfile ? copyOrBorrowInput(this.options.iccProfile, false) : new Uint8Array(0);
            const exifView = this.options.exif ? copyOrBorrowInput(this.options.exif, false) : new Uint8Array(0);
            const xmpView = this.options.xmp ? copyOrBorrowInput(this.options.xmp, false) : new Uint8Array(0);

            let iccPtr = iccView.byteLength > 0 ? module._malloc(iccView.byteLength) : 0;
            let exifPtr = exifView.byteLength > 0 ? module._malloc(exifView.byteLength) : 0;
            let xmpPtr = xmpView.byteLength > 0 ? module._malloc(xmpView.byteLength) : 0;

            let iccSize = iccView.byteLength;
            let exifSize = exifView.byteLength;
            let xmpSize = xmpView.byteLength;

            // Optional metadata is best-effort: if a buffer can't be allocated,
            // drop just that metadatum (zero its size; the ptr stays 0 so the
            // HEAPU8.set below is skipped and the encoder receives size 0) and
            // still encode the image. Core pixels are mandatory and are guarded
            // separately at the buffered-pixels malloc above.
            if (iccSize > 0 && iccPtr === 0) {
              console.warn("jxl-wasm: dropping ICC profile from encode — WASM malloc failed");
              iccSize = 0;
            }
            if (exifSize > 0 && exifPtr === 0) {
              console.warn("jxl-wasm: dropping EXIF from encode — WASM malloc failed");
              exifSize = 0;
            }
            if (xmpSize > 0 && xmpPtr === 0) {
              console.warn("jxl-wasm: dropping XMP from encode — WASM malloc failed");
              xmpSize = 0;
            }

            // P3-T2 (finding 18): advancedFrameSettings must never be silently dropped. The
            // buffered metadata (ICC/EXIF/XMP) one-shot encode has no encoder state to attach the
            // generic frame setting to, so reject loudly and steer callers to the streaming path
            // (which carries the generic libjxl-validated setter).
            if (this.options.advancedFrameSettings?.length) {
              if (iccPtr !== 0) module._free(iccPtr);
              if (exifPtr !== 0) module._free(exifPtr);
              if (xmpPtr !== 0) module._free(xmpPtr);
              throw new Error(
                "advancedFrameSettings are not supported together with ICC/EXIF/XMP metadata on the buffered encode path; " +
                  "encode without inline metadata (streaming path) to apply generic frame settings",
              );
            }

            try {
              if (iccPtr !== 0) module.HEAPU8.set(iccView, iccPtr);
              if (exifPtr !== 0) module.HEAPU8.set(exifView, exifPtr);
              if (xmpPtr !== 0) module.HEAPU8.set(xmpView, xmpPtr);

              handle = module._jxl_wasm_encode_rgba8_with_metadata(
                ptr, this.options.width, this.options.height,
                distance, this.options.effort, fmt, hasAlpha,
                progressiveDc, progressiveAc, qProgressiveAc, buffering,
                groupOrder, resampling,
                iccPtr, iccSize,
                exifPtr, exifSize,
                xmpPtr, xmpSize
              );
            } finally {
              if (iccPtr !== 0) module._free(iccPtr);
              if (exifPtr !== 0) module._free(exifPtr);
              if (xmpPtr !== 0) module._free(xmpPtr);
            }
          } else {
            // Fallback: plain encode (no metadata) used when bridge fn absent
            // or when no metadata was provided.
            if (this.options.format === "rgba16" && module._jxl_wasm_encode_rgba16) {
              handle = module._jxl_wasm_encode_rgba16(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
            } else if (this.options.format === "rgbaf32" && module._jxl_wasm_encode_rgbaf32) {
              handle = module._jxl_wasm_encode_rgbaf32(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
            } else {
              handle = module._jxl_wasm_encode_rgba8(ptr, this.options.width, this.options.height, distance, this.options.effort, hasAlpha, progressiveDc, progressiveAc, qProgressiveAc, buffering, groupOrder, resampling);
            }
          }
          const encoded = takeBuffer(module, handle, "encode");
          compressedBytes += encoded.data.byteLength;
          yield encoded.data;
        }
      } finally {
        module._free(ptr);
        this.pixelChunks = [];
        this.queuedPixelBytes = 0;
      }
    }

    this.encodeStats = { originalBytes: this.pixelByteTotal, compressedBytes, ratio: this.pixelByteTotal > 0 ? compressedBytes / this.pixelByteTotal : 0 };

  }

  getStats(): EncodeStats | null { return this.encodeStats; }

  cancel(_reason?: string): void {
    this.cancelled = true;
    this.freeWasmState();
    this.finishResolve?.();
    this.finishResolve = null;
    if (this.pendingPushError !== null) throw this.pendingPushError;
  }

  dispose(): void {
    this.pixelChunks = [];
    this.queuedPixelBytes = 0;
    this.cancelled = true;
    this.freeWasmState();
    this.finishResolve?.();
    this.finishResolve = null;
  }

  private freeWasmState(): void {
    if (this.wasmEncState !== 0 && this.wasmModule !== null) {
      this.wasmModule._jxl_wasm_enc_free!(this.wasmEncState);
      this.wasmEncState = 0;
    }
  }

  private waitUntilFinished(): Promise<void> {
    if (this.finished || this.cancelled) return Promise.resolve();
    return new Promise<void>((resolve) => { this.finishResolve = resolve; });
  }
}

async function loadLibjxlModule(): Promise<LibjxlWasmModule> {
  if (modulePromise === undefined) {
    const p = (testModuleFactory ?? loadGeneratedLibjxlModule)();
    modulePromise = p;
    // A rejected module promise must not poison every future call. Clear the cache on
    // failure (identity-guarded so a newer attempt isn't clobbered) so a transient cold-load
    // error — e.g. a failed .wasm fetch — can be retried by the next decode/encode.
    p.catch(() => { if (modulePromise === p) modulePromise = undefined; });
  }
  return modulePromise;
}

async function loadGeneratedLibjxlModule(): Promise<LibjxlWasmModule> {
  const tier = _forcedTier ?? detectTier();
  // Prefer the split full-feature `enc` module emitted by scripts/build.mjs (it is a superset:
  // decode + encode + planar + perceptual). Fall back to the legacy monolithic artifact when the
  // split isn't present for this tier, so the facade works across the monolithic→split migration.
  return instantiateFromArtifactCandidates([`enc.${tier}`, `${tier}`]);
}

/**
 * Load + instantiate the first available generated Emscripten artifact from an
 * ordered candidate list (each entry is the artifact suffix, e.g. `dec.simd`,
 * `enc.simd-mt`, or the monolithic `simd`). The first candidate whose
 * `./jxl-core.<name>.js` module exposes a default factory wins; earlier misses
 * are non-fatal (the split artifacts may be absent on some tiers).
 */
async function instantiateFromArtifactCandidates(candidates: readonly string[]): Promise<LibjxlWasmModule> {
  const baseUrl = new URL("./", import.meta.url);
  let factory: unknown;
  let chosen: string | undefined;
  let lastErr: unknown;
  for (const name of candidates) {
    try {
      const imported = await import(`./jxl-core.${name}.js`) as { default?: unknown };
      if (typeof imported.default === "function") { factory = imported.default; chosen = name; break; }
    } catch (error) {
      lastErr = error;
    }
  }
  if (typeof factory !== "function" || chosen === undefined) {
    throw new CapabilityMissing("Generated libjxl WASM module is missing default Emscripten factory", lastErr);
  }
  const options: Record<string, unknown> = {
    locateFile: (path: string) => new URL(path, baseUrl).href,
  };
  // Emscripten web output can fetch the .wasm in the browser. Pre-read the
  // binary only in Node/Bun so the same bundle works in both environments.
  if (typeof process !== "undefined" && !!process.versions?.node) {
    try {
      const fsMod = await import("node:fs/promises") as { readFile: (p: URL | string) => Promise<Uint8Array> };
      const urlMod = await import("node:url") as { fileURLToPath: (u: URL | string) => string };
      options["wasmBinary"] = await fsMod.readFile(urlMod.fileURLToPath(new URL(`jxl-core.${chosen}.wasm`, baseUrl)));
    } catch {
      // Node/Bun but binary unavailable; let Emscripten resolve it another way.
    }
  }
  return await (factory as (options: Record<string, unknown>) => Promise<LibjxlWasmModule>)(options);
}

// ---------------------------------------------------------------------------
// Role-aware module loading (Packet 3 Task 1 — findings 17, 31)
//
// A JXL "role" narrows which generated artifact to load: `decode` pulls the
// decode-only `dec.<tier>` module (viewer, ~half the size), while `encode` and
// `perceptual` pull the encoder superset `enc.<tier>` (encode + butteraugli/
// psnr/ssim). This lets a decode-only worker avoid instantiating the encoder
// call trees — the concrete win behind finding 17.
//
// Loaded modules are cached and de-duplicated per {role, tier} so simultaneous
// callers share a single in-flight instantiation. Unknown roles/tiers fail with
// a deterministic error rather than being silently coerced to a default.
// ---------------------------------------------------------------------------

export type JxlRole = "decode" | "encode" | "perceptual";
export type JxlTier = "scalar-st" | "simd-st" | "scalar-mt" | "simd-mt";

/**
 * The concrete module a role loader resolves to: the instantiated libjxl WASM
 * module plus the resolved role/tier and its detected capability flags. The
 * `module` handle is the same `LibjxlWasmModule` the low-level facade paths use.
 */
export interface JxlModule {
  readonly role: JxlRole;
  readonly tier: JxlTier;
  readonly module: LibjxlWasmModule;
  readonly capabilities: JxlCapabilities;
}

export interface LoadJxlModuleRequest {
  role: JxlRole;
  /** Defaults to the auto-detected tier for this environment when omitted. */
  tier?: JxlTier;
  /** Abort the load; if already aborted, the returned promise rejects immediately. */
  signal?: AbortSignal;
}

const VALID_ROLES: ReadonlySet<string> = new Set<JxlRole>(["decode", "encode", "perceptual"]);
const VALID_TIERS: ReadonlySet<string> = new Set<JxlTier>(["scalar-st", "simd-st", "scalar-mt", "simd-mt"]);

/**
 * Test seam: loads the raw Emscripten module for an artifact suffix
 * (e.g. `dec.simd`). Production uses `instantiateFromArtifactCandidates`;
 * tests inject a spy to assert which artifacts a role requests without a
 * real WASM build. Receives the ordered candidate list actually tried.
 */
export type JxlArtifactLoader = (artifact: string, candidates: readonly string[]) => Promise<LibjxlWasmModule>;

let _artifactLoaderForTesting: JxlArtifactLoader | null = null;
const _roleModuleCache = new Map<string, Promise<JxlModule>>();

/** Inject a fake artifact loader (tests only). Resets the role-module cache. */
export function setJxlArtifactLoaderForTesting(loader: JxlArtifactLoader | null): void {
  _artifactLoaderForTesting = loader;
  _roleModuleCache.clear();
}

/** Clear the role-module cache and any injected loader (tests only). */
export function resetJxlRoleLoaderForTesting(): void {
  _artifactLoaderForTesting = null;
  _roleModuleCache.clear();
}

/** Map a public {@link JxlTier} onto the generated artifact's internal tier suffix. */
function artifactTierForJxlTier(tier: JxlTier): Tier {
  switch (tier) {
    case "scalar-st":
    case "scalar-mt":
      // No SIMD/threaded scalar split is emitted; both map to the monolithic scalar artifact.
      return "scalar";
    case "simd-st":
      return "simd";
    case "simd-mt":
      // Prefer the relaxed-SIMD MT artifact when the environment probes support it;
      // it is byte-identical to simd-mt for encode and strictly a superset otherwise.
      return probeRelaxedSimd() ? "relaxed-simd-mt" : "simd-mt";
    default:
      // Exhaustiveness guard — VALID_TIERS gates callers, this is defence in depth.
      throw new CapabilityMissing(`Unknown JXL tier: ${String(tier)}`);
  }
}

/** Default public tier from the auto-detected internal tier. */
function defaultJxlTier(): JxlTier {
  switch (detectTier()) {
    case "relaxed-simd-mt":
    case "simd-mt":
      return "simd-mt";
    case "simd":
      return "simd-st";
    case "scalar":
    default:
      return "scalar-st";
  }
}

/**
 * Ordered artifact candidates for a {role, artifactTier}. The role-specific
 * artifact is tried first; the monolithic artifact is the fallback so the loader
 * still works on tiers (e.g. scalar) that have no role split.
 */
function roleArtifactCandidates(role: JxlRole, artifactTier: Tier): string[] {
  const rolePrefix = role === "decode" ? "dec" : "enc";
  const roleSpecific = `${rolePrefix}.${artifactTier}`;
  // scalar has no role split — the role-specific candidate simply won't resolve,
  // and the monolithic fallback (which is decode+encode) is used.
  return [roleSpecific, `${artifactTier}`];
}

/**
 * Load a role-specific libjxl WASM module.
 *
 * - `decode` loads the decode-only `dec.<tier>` artifact (falls back to the
 *   monolithic artifact when no split exists for that tier).
 * - `encode` / `perceptual` load the encoder superset `enc.<tier>`.
 *
 * Concurrent calls with the same {role, tier} share one in-flight instantiation.
 * Unknown roles or tiers reject with a {@link CapabilityMissing} error — settings
 * are never silently ignored.
 */
export async function loadJxlModule(request: LoadJxlModuleRequest): Promise<JxlModule> {
  const { role, signal } = request;
  if (!VALID_ROLES.has(role)) {
    throw new CapabilityMissing(`Unknown JXL role: ${String(role)}`);
  }
  if (request.tier !== undefined && !VALID_TIERS.has(request.tier)) {
    throw new CapabilityMissing(`Unknown JXL tier: ${String(request.tier)}`);
  }
  if (signal?.aborted) {
    throw signalAbortError(signal);
  }

  const tier: JxlTier = request.tier ?? defaultJxlTier();
  const key = `${role} ${tier}`;

  let entry = _roleModuleCache.get(key);
  if (entry === undefined) {
    entry = loadRoleModuleUncached(role, tier);
    _roleModuleCache.set(key, entry);
    // Evict a rejected load so a transient failure (bad fetch) can be retried,
    // guarded on identity so a newer attempt isn't clobbered.
    entry.catch(() => {
      if (_roleModuleCache.get(key) === entry) _roleModuleCache.delete(key);
    });
  }

  if (signal === undefined) return entry;
  // Honour late aborts without discarding the shared cached load for other callers.
  return raceWithAbort(entry, signal);
}

/**
 * Fire-and-forget role-aware warm-up. Kicks off (and caches) the module load for
 * a role during app/worker startup so the first real decode/encode/perceptual op
 * finds a hot module. Rejections are swallowed (the cold path retries and surfaces
 * the error to its own caller); invalid roles/tiers never throw synchronously.
 */
export function preloadJxlRole(role: JxlRole, tier?: JxlTier): void {
  void loadJxlModule(tier === undefined ? { role } : { role, tier }).catch(() => {});
}

async function loadRoleModuleUncached(role: JxlRole, tier: JxlTier): Promise<JxlModule> {
  const artifactTier = artifactTierForJxlTier(tier);
  const candidates = roleArtifactCandidates(role, artifactTier);
  const load = _artifactLoaderForTesting
    ? _artifactLoaderForTesting(candidates[0]!, candidates)
    : instantiateFromArtifactCandidates(candidates);
  const module = await load;
  return { role, tier, module, capabilities: getCapabilities(module) };
}

function signalAbortError(signal: AbortSignal): Error {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  const err = new Error("The JXL module load was aborted");
  err.name = "AbortError";
  return err;
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signalAbortError(signal));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

export interface JxlCapabilities {
  progressiveDecode: boolean;
  streamingEncode: boolean;
  streamingInput: boolean;
  streamingInputX: boolean;
  streamingInputY: boolean;
  streamingInputZ: boolean;
  sidecars: boolean;
  jpegTranscode: boolean;
}

const capabilityCache = new WeakMap<LibjxlWasmModule, JxlCapabilities>();

export function getCapabilities(module: LibjxlWasmModule): JxlCapabilities {
  let caps = capabilityCache.get(module);
  if (caps !== undefined) return caps;
  caps = {
    progressiveDecode: typeof module._jxl_wasm_dec_create === "function",
    streamingEncode:
      typeof module._jxl_wasm_enc_create === "function" &&
      typeof module._jxl_wasm_enc_push_pixels === "function" &&
      typeof module._jxl_wasm_enc_take_chunk === "function" &&
      typeof module._jxl_wasm_enc_free === "function",
    streamingInput:
      typeof module._jxl_wasm_enc_create_image === "function" &&
      typeof module._jxl_wasm_enc_push_chunk === "function" &&
      typeof module._jxl_wasm_enc_finish === "function" &&
      typeof module._jxl_wasm_enc_take_chunk === "function" &&
      typeof module._jxl_wasm_enc_free === "function",
    streamingInputX: typeof module._jxl_wasm_enc_create_image_x === "function",
    streamingInputY: typeof module._jxl_wasm_enc_create_image_y === "function",
    streamingInputZ: typeof module._jxl_wasm_enc_create_image_z === "function",
    sidecars:
      typeof module._jxl_wasm_encode_rgba8_with_sidecars === "function" &&
      typeof module._jxl_wasm_buffer_next === "function",
    jpegTranscode: typeof module._jxl_wasm_transcode_jpeg_to_jxl === "function",
  };
  capabilityCache.set(module, caps);
  return caps;
}

function callDecodeFromPtr(module: LibjxlWasmModule, ptr: number, size: number, downsample: number, format: PixelFormat, region?: Region | null): LibjxlBuffer {
  let handle = 0;
  try {
    // #10: use C++ region crop when available — avoids shipping full-image pixels to JS.
    if (region != null) {
      if (format === "rgba16" && module._jxl_wasm_decode_rgba16_region) {
        handle = module._jxl_wasm_decode_rgba16_region(ptr, size, region.x, region.y, region.w, region.h, downsample);
      } else if (format === "rgbaf32" && module._jxl_wasm_decode_rgbaf32_region) {
        handle = module._jxl_wasm_decode_rgbaf32_region(ptr, size, region.x, region.y, region.w, region.h, downsample);
      } else if (module._jxl_wasm_decode_rgba8_region) {
        handle = module._jxl_wasm_decode_rgba8_region(ptr, size, region.x, region.y, region.w, region.h, downsample);
      } else {
        handle = callDecodeNoRegion(module, ptr, size, downsample, format);
      }
    } else {
      handle = callDecodeNoRegion(module, ptr, size, downsample, format);
    }
    return readBufferView(module, handle, "decode");
  } catch (err) {
    // readBufferView does not free on error — we own handle here.
    if (handle !== 0) module._jxl_wasm_buffer_free(handle);
    throw err;
  }
}

function callDecodeNoRegion(module: LibjxlWasmModule, ptr: number, size: number, downsample: number, format: PixelFormat): number {
  if (format === "rgba16" && module._jxl_wasm_decode_rgba16) {
    return module._jxl_wasm_decode_rgba16(ptr, size, downsample);
  } else if (format === "rgbaf32" && module._jxl_wasm_decode_rgbaf32) {
    return module._jxl_wasm_decode_rgbaf32(ptr, size, downsample);
  }
  return module._jxl_wasm_decode_rgba8(ptr, size, downsample);
}

function readBufferFields(module: LibjxlWasmModule, handle: number, operation: string): {
  dataPtr: number;
  size: number;
  width: number;
  height: number;
  bitsVal: number;
  alphaVal: number;
} {
  if (handle === 0) throw new Error(`JXL ${operation} failed`);

  assertA6WordSize(module);

  // JxlWasmBuffer: data* (ptr), size (uint32 A6, not size_t), width, height, bits, has_alpha, error.
  // Read first 7 fields via contiguous HEAPU32 (WASM32 layout). Pointer fields are 4B on supported builds.
  let dataPtr: number, size: number, width: number, height: number, bitsVal: number, alphaVal: number, errorCode: number;
  const h32 = module.HEAPU32;
  // Only use the HEAPU32 direct-read fast path when `handle` looks like a real WASM heap
  // address: 4-byte aligned and above the minimum reserved region. Test fake modules use
  // sequential integers (1, 2, 3…) that would read garbage at the wrong HEAPU32 index.
  if (h32 && (handle & 3) === 0 && handle >= 16) {
    const b = handle >>> 2;
    dataPtr   = h32[b] ?? 0;
    size      = h32[b + 1] ?? 0;
    width     = h32[b + 2] ?? 0;
    height    = h32[b + 3] ?? 0;
    bitsVal   = h32[b + 4] ?? 0;
    alphaVal  = h32[b + 5] ?? 0;
    errorCode = h32[b + 6] ?? 0;
  } else {
    dataPtr   = module._jxl_wasm_buffer_data(handle);
    size      = module._jxl_wasm_buffer_size(handle);
    width     = module._jxl_wasm_buffer_width(handle);
    height    = module._jxl_wasm_buffer_height(handle);
    bitsVal   = module._jxl_wasm_buffer_bits_per_sample(handle);
    alphaVal  = module._jxl_wasm_buffer_has_alpha(handle);
    errorCode = module._jxl_wasm_buffer_error?.(handle) ?? 0;
  }

  if (dataPtr === 0 || size === 0) {
    throw new Error(`JXL ${operation} failed${errorCode === 0 ? "" : ` (${errorCode})`}`);
  }

  return { dataPtr, size, width, height, bitsVal, alphaVal };
}

// Read buffer metadata without freeing handle. Caller is responsible for freeing.
function readBufferView(module: LibjxlWasmModule, handle: number, operation: string): LibjxlBuffer {
  const { dataPtr, size, width, height, bitsVal, alphaVal } = readBufferFields(module, handle, operation);
  return {
    handle,
    data: module.HEAPU8.slice(dataPtr, dataPtr + size),
    width,
    height,
    bitsPerSample: normalizeBitsPerSample(bitsVal),
    hasAlpha: alphaVal !== 0,
  };
}

// A6: called from buffer view paths to assert 32-bit pointers at first use (after module load).
let _a6Checked = false;
function assertA6WordSize(module: LibjxlWasmModule) {
  if (_a6Checked) return;
  _a6Checked = true;
  const fn = (module as any)._jxl_wasm_pointer_size;
  if (typeof fn === 'function') {
    const ps = fn();
    if (ps !== 4) {
      throw new Error(`JxlWasm A6: pointer size ${ps} != 4 — WASM64 drift for JxlWasmBuffer FFI`);
    }
  }
}

// Read buffer and always free handle (in finally), whether success or failure.
function takeBuffer(module: LibjxlWasmModule, handle: number, operation: string): LibjxlBuffer {
  try {
    return readBufferView(module, handle, operation);
  } finally {
    if (handle !== 0) module._jxl_wasm_buffer_free(handle);
  }
}

function retainBufferView(module: LibjxlWasmModule, handle: number, operation: string): RetainedBufferView {
  const { dataPtr, size, width, height, bitsVal, alphaVal } = readBufferFields(module, handle, operation);
  let released = false;
  return {
    handle,
    data: module.HEAPU8.subarray(dataPtr, dataPtr + size),
    width,
    height,
    bitsPerSample: normalizeBitsPerSample(bitsVal),
    hasAlpha: alphaVal !== 0,
    release() {
      if (!released && handle !== 0) {
        released = true;
        module._jxl_wasm_buffer_free(handle);
      }
    },
  };
}

// Same-tick zero-copy take (A4). Uses HEAPU8.subarray (no copy) instead of .slice.
// Returned .data view is only valid for synchronous use in the same tick before any
// further WASM malloc/grow/realloc (which can invalidate subarray views into the heap).
// Callers must not retain the view across awaits, yields, or additional bridge calls.
// Intended for enc chunk drains (small, immediate yield) and progress snapshots where
// consumer draws/hashes/posts immediately. Long-lived pixel retention should copy.
function takeBufferView(module: LibjxlWasmModule, handle: number, operation: string): LibjxlBuffer {
  try {
    const { dataPtr, size, width, height, bitsVal, alphaVal } = readBufferFields(module, handle, operation);
    return {
      handle,
      data: module.HEAPU8.subarray(dataPtr, dataPtr + size),
      width,
      height,
      bitsPerSample: normalizeBitsPerSample(bitsVal),
      hasAlpha: alphaVal !== 0,
    };
  } finally {
    if (handle !== 0) module._jxl_wasm_buffer_free(handle);
  }
}

function normalizeBitsPerSample(value: number): 8 | 16 | 32 {
  if (value === 16 || value === 32) return value;
  return 8;
}

function bytesPerChannelForFormat(format: PixelFormat): 1 | 2 | 4 {
  return format === "rgbaf32" ? 4 : format === "rgba16" ? 2 : 1;
}

const MAX_PIXEL_BYTES = 1024 * 1024 * 1024; // 1 GiB hard limit before WASM malloc

function expectedPixelBytes(width: number, height: number, format: PixelFormat, maxBytes = MAX_PIXEL_BYTES): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid image dimensions: ${width} × ${height}`);
  }
  const bpc = bytesPerChannelForFormat(format);
  const channels = format === "rgb8" ? 3 : 4;
  const bytes = width * height * channels * bpc;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`Pixel byte size overflow for ${width} × ${height} ${format}`);
  }
  if (bytes > maxBytes) {
    throw new Error(`Image too large for WASM encode: ${bytes} bytes exceeds limit ${maxBytes}`);
  }
  return bytes;
}

function distanceFromQuality(quality: number | null): number {
  if (quality === null) return 1;
  if (!Number.isFinite(quality)) throw new Error(`Invalid JXL quality: ${quality}`);
  const q = Math.max(0, Math.min(100, quality));
  return ((100 - q) * 15) / 100;
}

// Borrow or copy input depending on caller's ownership. ArrayBuffer is always zero-copy (view only).
function copyOrBorrowInput(value: ArrayBuffer | Uint8Array, copy: boolean): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return copy ? value.slice() : value;
}

function mallocOrThrow(module: LibjxlWasmModule, size: number, label: string): number {
  const ptr = module._malloc(size);
  if (ptr === 0) throw new Error(`WASM malloc failed for ${label}`);
  return ptr;
}

// Reused scratch for int32-bits→float reinterpret. JS workers are single-threaded, so a
// shared 4-byte view is safe and avoids 3 allocations (ArrayBuffer + 2 typed arrays) per call.
const _f32ScratchBuf = new ArrayBuffer(4);
const _f32ScratchI32 = new Int32Array(_f32ScratchBuf);
const _f32ScratchF32 = new Float32Array(_f32ScratchBuf);

function floatFromI32Bits(bits: number): number {
  _f32ScratchI32[0] = bits;
  return _f32ScratchF32[0] as number;
}

function butteraugliPixelSize(pixels: ArrayBuffer | Uint8Array, width: number, height: number, operation: string): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`${operation}: invalid dimensions ${width}×${height}`);
  }
  const pixelSize = width * height * 4;
  const view = copyOrBorrowInput(pixels, false);
  if (!Number.isSafeInteger(pixelSize) || pixelSize <= 0) {
    throw new Error(`${operation}: pixel byte size overflow for ${width}×${height}`);
  }
  if (view.byteLength < pixelSize) {
    throw new Error(`${operation}: expected ${pixelSize} bytes for ${width}×${height} RGBA8, got ${view.byteLength}`);
  }
  return pixelSize;
}

function jxtcNonTileRanges(view: Uint8Array): Array<[number, number]> {
  if (view.byteLength < 40) return [];
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const version = dv.getUint32(4, true);
  const tilesX = dv.getUint32(20, true);
  const tilesY = dv.getUint32(24, true);
  if (version !== 1 || tilesX === 0 || tilesY === 0) return [];
  const tileCount = tilesX * tilesY;
  if (!Number.isSafeInteger(tileCount) || tileCount <= 0) return [];
  const indexEnd = 32 + tileCount * 8;
  if (indexEnd > view.byteLength) return [];

  const intervals: Array<[number, number]> = [];
  for (let i = 0; i < tileCount; i++) {
    const offset = dv.getUint32(32 + i * 8, true);
    const length = dv.getUint32(32 + i * 8 + 4, true);
    const end = offset + length;
    if (length === 0 || offset < indexEnd || end > view.byteLength || end < offset) return [];
    intervals.push([offset, end]);
  }
  intervals.sort((a, b) => a[0] - b[0]);

  const ranges: Array<[number, number]> = [];
  let cursor = indexEnd;
  for (const [start, end] of intervals) {
    if (start > cursor) ranges.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < view.byteLength) ranges.push([cursor, view.byteLength]);
  return ranges;
}

function scanForValidJpeg(view: Uint8Array, start: number, end: number): Uint8Array | null {
  for (let offset = start; offset < end - 3; offset++) {
    if (view[offset] !== 0xff || view[offset + 1] !== 0xd8) continue;
    const jpegEnd = findValidJpegEnd(view, offset, end);
    if (jpegEnd !== 0) return view.slice(offset, jpegEnd);
  }
  return null;
}

function findValidJpegEnd(view: Uint8Array, soi: number, limit: number): number {
  let offset = soi + 2;
  let segments = 0;
  while (offset + 1 < limit) {
    if (view[offset] !== 0xff) return 0;
    while (offset < limit && view[offset] === 0xff) offset++;
    if (offset >= limit) return 0;
    const marker = view[offset++]!;
    if (marker === 0xd9) return segments >= 2 ? offset : 0;

    // SOS (0xDA) marks the Start of Scan, followed by entropy-encoded data.
    // Skip SOS header, then scan entropy data for the next marker.
    if (marker === 0xda) {
      if (offset + 2 > limit) return 0;
      const sosLength = (view[offset]! << 8) | view[offset + 1]!;
      if (sosLength < 2 || offset + sosLength > limit) return 0;
      offset += sosLength;
      segments++;

      // Scan entropy data: 0xFF followed by non-zero, non-RST marker stops entropy.
      while (offset < limit) {
        if (view[offset] === 0xff) {
          if (offset + 1 >= limit) return 0;
          const nextByte = view[offset + 1]!;
          // 0x00 is an escaped 0xFF in entropy data, 0xD0-0xD7 are RST markers (allowed in entropy).
          if (nextByte !== 0x00 && (nextByte < 0xd0 || nextByte > 0xd7)) {
            // Found next marker (0xFF nextByte). We'll reprocess the 0xFF in the next loop.
            break;
          }
          offset += 2;
        } else {
          offset++;
        }
      }
      continue;
    }

    if (!isValidJpegHeaderMarker(marker) || offset + 2 > limit) return 0;
    const length = (view[offset]! << 8) | view[offset + 1]!;
    if (length < 2 || offset + length > limit) return 0;
    offset += length;
    segments++;
  }
  return 0;
}

function isValidJpegHeaderMarker(marker: number): boolean {
  return (
    (marker >= 0xe0 && marker <= 0xef) ||
    marker === 0xdb ||
    marker === 0xc4 ||
    marker === 0xdd ||
    marker === 0xfe ||
    (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8 && marker !== 0xcc)
  );
}

export function applyRegionAndDownsample(
  data: Uint8Array,
  width: number,
  height: number,
  region: Region | null,
  downsample: 1 | 2 | 4 | 8,
  bytesPerChannel = 1,
): { data: Uint8Array; width: number; height: number; region?: Region } {
  // IMPROVEMENT-8: Hottest path — no crop, no downsample — skip normalizeRegion entirely.
  if (downsample === 1 && region === null) return { data, width, height };

  const stride = 4 * bytesPerChannel;
  const sourceRegion = normalizeRegion(region, width, height);

  // Secondary fast path: region present but maps to full image after clamping
  if (downsample === 1 && sourceRegion.x === 0 && sourceRegion.y === 0 && sourceRegion.w === width && sourceRegion.h === height) {
    const result: { data: Uint8Array; width: number; height: number; region?: Region } = { data, width, height };
    if (region !== null) result.region = { x: 0, y: 0, w: width, h: height };
    return result;
  }

  const outWidth = Math.max(1, Math.ceil(sourceRegion.w / downsample));
  const outHeight = Math.max(1, Math.ceil(sourceRegion.h / downsample));
  const out = new Uint8Array(outWidth * outHeight * stride);

  if (downsample === 1) {
    // Crop-only: copy whole rows at once — much faster than per-pixel copy.
    for (let y = 0; y < outHeight; y++) {
      const srcStart = ((sourceRegion.y + y) * width + sourceRegion.x) * stride;
      out.set(data.subarray(srcStart, srcStart + outWidth * stride), y * outWidth * stride);
    }
  } else {
    // Downsample (nearest): walk source by a fixed pixel/row step with linear pointer
    // advancement. The per-pixel Math.min clamps the old path carried are mathematically
    // unreachable — outWidth = ceil(w/ds) ⇒ (outWidth-1)*ds ≤ w-1 (same for height) — so
    // x*ds / y*ds never exceed the region, and the bounds checks are dropped.
    const sourceOffset = (sourceRegion.y * width + sourceRegion.x) * stride;
    const rowStepBytes = width * stride * downsample;
    const pixelStepBytes = stride * downsample;

    if ((data.byteOffset & 3) === 0) {
      // Aligned fast path: copy whole RGBA pixels as 32-bit words (1/2/4 words per pixel
      // for rgba8/rgba16/rgbaf32). Little-endian word copy is byte-identical to the
      // element-by-element copy it replaces, and removes the per-pixel subarray() alloc.
      const wordsPerPixel = stride >>> 2;
      const sourceWords = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2);
      const outputWords = new Uint32Array(out.buffer);
      const rowStep = rowStepBytes >>> 2;
      const pixelStep = pixelStepBytes >>> 2;
      let sourceRow = sourceOffset >>> 2;
      let outputRow = 0;
      if (wordsPerPixel === 1) {
        for (let y = 0; y < outHeight; y++, sourceRow += rowStep, outputRow += outWidth) {
          let src = sourceRow;
          let dst = outputRow;
          for (let x = 0; x < outWidth; x++, src += pixelStep, dst++) {
            outputWords[dst] = sourceWords[src]!;
          }
        }
      } else if (wordsPerPixel === 2) {
        for (let y = 0; y < outHeight; y++, sourceRow += rowStep, outputRow += outWidth * 2) {
          let src = sourceRow;
          let dst = outputRow;
          for (let x = 0; x < outWidth; x++, src += pixelStep, dst += 2) {
            outputWords[dst] = sourceWords[src]!;
            outputWords[dst + 1] = sourceWords[src + 1]!;
          }
        }
      } else {
        for (let y = 0; y < outHeight; y++, sourceRow += rowStep, outputRow += outWidth * 4) {
          let src = sourceRow;
          let dst = outputRow;
          for (let x = 0; x < outWidth; x++, src += pixelStep, dst += 4) {
            outputWords[dst] = sourceWords[src]!;
            outputWords[dst + 1] = sourceWords[src + 1]!;
            outputWords[dst + 2] = sourceWords[src + 2]!;
            outputWords[dst + 3] = sourceWords[src + 3]!;
          }
        }
      }
    } else {
      // Unaligned fallback (source not 4-byte aligned): per-byte copy with linear advance.
      let sourceRow = sourceOffset;
      let outputRow = 0;
      for (let y = 0; y < outHeight; y++, sourceRow += rowStepBytes, outputRow += outWidth * stride) {
        let src = sourceRow;
        let dst = outputRow;
        for (let x = 0; x < outWidth; x++, src += pixelStepBytes, dst += stride) {
          for (let b = 0; b < stride; b++) out[dst + b] = data[src + b]!;
        }
      }
    }
  }

  const result: { data: Uint8Array; width: number; height: number; region?: Region } = {
    data: out,
    width: outWidth,
    height: outHeight,
  };
  if (region !== null) {
    result.region = { x: 0, y: 0, w: outWidth, h: outHeight };
  }
  return result;
}

export function buildResizeAxis(srcSize: number, dstSize: number, srcStart = 0, srcSpan = srcSize): ResizeAxis {
  const i0 = new Int32Array(dstSize);
  const i1 = new Int32Array(dstSize);
  const t = new Float32Array(dstSize);
  const scale = srcSpan / dstSize;
  for (let d = 0; d < dstSize; d++) {
    const f = srcStart + (d + 0.5) * scale - 0.5;
    const base = Math.max(0, Math.floor(f));
    i0[d] = base;
    i1[d] = Math.min(srcSize - 1, base + 1);
    t[d] = f - base;
  }
  return { i0, i1, t };
}

// 8.8 fixed-point interpolation weights ((t*256)|0), cached on the axis so a plan
// reused across every progressive paint truncates the float weights only once.
// Identical values to the per-call computation it replaces, hence byte-exact.
function fixedResizeWeights256(axis: ResizeAxis): Int16Array {
  let fixed = axis.fixed256;
  if (fixed !== undefined) return fixed;
  const t = axis.t;
  fixed = new Int16Array(t.length);
  for (let i = 0; i < fixed.length; i++) fixed[i] = (t[i]! * 256) | 0;
  axis.fixed256 = fixed;
  return fixed;
}

export function bilinearResize(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  stride: number, // 4=rgba8, 8=rgba16, 16=rgbaf32
  xAxisIn?: ResizeAxis,
  yAxisIn?: ResizeAxis,
): Uint8Array {
  if (srcW === dstW && srcH === dstH) return src;
  const dst = new Uint8Array(dstW * dstH * stride);
  const xAxis = xAxisIn ?? buildResizeAxis(srcW, dstW);
  const yAxis = yAxisIn ?? buildResizeAxis(srcH, dstH);
  if (stride === 4) {
    // 8.8 fixed-point weights: eliminates float↔int traffic per channel.
    // Weights sum to exactly 256; +128 before >>8 gives unbiased rounding.
    // Both axes' fixed-point weights are now cached on the axis (column-/row-invariant),
    // so repeated paints over one plan never re-truncate. The 4-channel inner loop is
    // unrolled — same arithmetic per channel, fewer loop-overhead instructions.
    const xtIs = fixedResizeWeights256(xAxis);
    const ytIs = fixedResizeWeights256(yAxis);
    const i0x = xAxis.i0;
    const i1x = xAxis.i1;
    for (let dy = 0; dy < dstH; dy++) {
      const y0 = yAxis.i0[dy]!;
      const y1 = yAxis.i1[dy]!;
      const ytI = ytIs[dy]!;
      const row00 = y0 * srcW * 4;
      const row10 = y1 * srcW * 4;
      const dstRow = dy * dstW * 4;
      for (let dx = 0; dx < dstW; dx++) {
        const x0 = i0x[dx]!;
        const x1 = i1x[dx]!;
        const xtI = xtIs[dx]!;
        const w11 = (xtI * ytI) >> 8;
        const w10 = ytI - w11;
        const w01 = xtI - w11;
        const w00 = 256 - xtI - ytI + w11;
        const topLeft    = row00 + x0 * 4;
        const topRight   = row00 + x1 * 4;
        const bottomLeft = row10 + x0 * 4;
        const bottomRight = row10 + x1 * 4;
        const dstOff = dstRow + dx * 4;
        dst[dstOff]     = (src[topLeft]!     * w00 + src[topRight]!     * w01 + src[bottomLeft]!     * w10 + src[bottomRight]!     * w11 + 128) >> 8;
        dst[dstOff + 1] = (src[topLeft + 1]! * w00 + src[topRight + 1]! * w01 + src[bottomLeft + 1]! * w10 + src[bottomRight + 1]! * w11 + 128) >> 8;
        dst[dstOff + 2] = (src[topLeft + 2]! * w00 + src[topRight + 2]! * w01 + src[bottomLeft + 2]! * w10 + src[bottomRight + 2]! * w11 + 128) >> 8;
        dst[dstOff + 3] = (src[topLeft + 3]! * w00 + src[topRight + 3]! * w01 + src[bottomLeft + 3]! * w10 + src[bottomRight + 3]! * w11 + 128) >> 8;
      }
    }
  } else if (stride === 8) {
    const srcView = new Uint16Array(src.buffer, src.byteOffset, src.byteLength >> 1);
    const dstView = new Uint16Array(dst.buffer);
    const i0x = xAxis.i0;
    const i1x = xAxis.i1;
    const tx = xAxis.t;
    for (let dy = 0; dy < dstH; dy++) {
      const y0 = yAxis.i0[dy]!;
      const y1 = yAxis.i1[dy]!;
      const yt = yAxis.t[dy]!;
      const invYt = 1 - yt;
      const row00 = y0 * srcW * 4;
      const row10 = y1 * srcW * 4;
      const dstRow = dy * dstW * 4;
      for (let dx = 0; dx < dstW; dx++) {
        const x0 = i0x[dx]!;
        const x1 = i1x[dx]!;
        const xt = tx[dx]!;
        const invXt = 1 - xt;
        const w00 = invXt * invYt;
        const w01 = xt * invYt;
        const w10 = invXt * yt;
        const w11 = xt * yt;
        const topLeft    = row00 + x0 * 4;
        const topRight   = row00 + x1 * 4;
        const bottomLeft = row10 + x0 * 4;
        const bottomRight = row10 + x1 * 4;
        const dstOff = dstRow + dx * 4;
        dstView[dstOff]     = Math.max(0, Math.min(65535, Math.round(srcView[topLeft]!     * w00 + srcView[topRight]!     * w01 + srcView[bottomLeft]!     * w10 + srcView[bottomRight]!     * w11)));
        dstView[dstOff + 1] = Math.max(0, Math.min(65535, Math.round(srcView[topLeft + 1]! * w00 + srcView[topRight + 1]! * w01 + srcView[bottomLeft + 1]! * w10 + srcView[bottomRight + 1]! * w11)));
        dstView[dstOff + 2] = Math.max(0, Math.min(65535, Math.round(srcView[topLeft + 2]! * w00 + srcView[topRight + 2]! * w01 + srcView[bottomLeft + 2]! * w10 + srcView[bottomRight + 2]! * w11)));
        dstView[dstOff + 3] = Math.max(0, Math.min(65535, Math.round(srcView[topLeft + 3]! * w00 + srcView[topRight + 3]! * w01 + srcView[bottomLeft + 3]! * w10 + srcView[bottomRight + 3]! * w11)));
      }
    }
  } else {
    const srcView = new Float32Array(src.buffer, src.byteOffset, src.byteLength >> 2);
    const dstView = new Float32Array(dst.buffer);
    const i0x = xAxis.i0;
    const i1x = xAxis.i1;
    const tx = xAxis.t;
    for (let dy = 0; dy < dstH; dy++) {
      const y0 = yAxis.i0[dy]!;
      const y1 = yAxis.i1[dy]!;
      const yt = yAxis.t[dy]!;
      const invYt = 1 - yt;
      const row00 = y0 * srcW * 4;
      const row10 = y1 * srcW * 4;
      const dstRow = dy * dstW * 4;
      for (let dx = 0; dx < dstW; dx++) {
        const x0 = i0x[dx]!;
        const x1 = i1x[dx]!;
        const xt = tx[dx]!;
        const invXt = 1 - xt;
        const w00 = invXt * invYt;
        const w01 = xt * invYt;
        const w10 = invXt * yt;
        const w11 = xt * yt;
        const topLeft    = row00 + x0 * 4;
        const topRight   = row00 + x1 * 4;
        const bottomLeft = row10 + x0 * 4;
        const bottomRight = row10 + x1 * 4;
        const dstOff = dstRow + dx * 4;
        dstView[dstOff]     = srcView[topLeft]!     * w00 + srcView[topRight]!     * w01 + srcView[bottomLeft]!     * w10 + srcView[bottomRight]!     * w11;
        dstView[dstOff + 1] = srcView[topLeft + 1]! * w00 + srcView[topRight + 1]! * w01 + srcView[bottomLeft + 1]! * w10 + srcView[bottomRight + 1]! * w11;
        dstView[dstOff + 2] = srcView[topLeft + 2]! * w00 + srcView[topRight + 2]! * w01 + srcView[bottomLeft + 2]! * w10 + srcView[bottomRight + 2]! * w11;
        dstView[dstOff + 3] = srcView[topLeft + 3]! * w00 + srcView[topRight + 3]! * w01 + srcView[bottomLeft + 3]! * w10 + srcView[bottomRight + 3]! * w11;
      }
    }
  }
  return dst;
}

function buildResizePlan(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
  fitMode: "contain" | "cover" | "stretch",
  bpc: 1 | 2 | 4,
): ResizePlan {
  const plan: ResizePlan = { srcW, srcH, dstW: targetW, dstH: targetH, fitMode, bpc };
  if (fitMode === "stretch") return plan;
  if (fitMode === "contain") {
    const scale = Math.min(targetW / srcW, targetH / srcH);
    plan.dstW = Math.max(1, Math.round(srcW * scale));
    plan.dstH = Math.max(1, Math.round(srcH * scale));
    if (plan.dstW !== srcW || plan.dstH !== srcH) {
      plan.xAxis = buildResizeAxis(srcW, plan.dstW);
      plan.yAxis = buildResizeAxis(srcH, plan.dstH);
    }
    return plan;
  }
  const scale = Math.max(targetW / srcW, targetH / srcH);
  const scaledW = Math.max(targetW, Math.round(srcW * scale));
  const scaledH = Math.max(targetH, Math.round(srcH * scale));
  if (scaledW !== srcW || scaledH !== srcH) {
    const cropX = Math.floor((scaledW - targetW) / 2);
    const cropY = Math.floor((scaledH - targetH) / 2);
    const srcSpanW = targetW * srcW / scaledW;
    const srcSpanH = targetH * srcH / scaledH;
    const srcStartX = cropX * srcW / scaledW;
    const srcStartY = cropY * srcH / scaledH;
    plan.xAxis = buildResizeAxis(srcW, targetW, srcStartX, srcSpanW);
    plan.yAxis = buildResizeAxis(srcH, targetH, srcStartY, srcSpanH);
  }
  return plan;
}

function applyTargetResize(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
  fitMode: "contain" | "cover" | "stretch",
  bpc: 1 | 2 | 4,
  plan?: ResizePlan | null,
): { data: Uint8Array; width: number; height: number } {
  if (srcW === targetW && srcH === targetH) {
    return { data: src, width: srcW, height: srcH };
  }
  const stride = 4 * bpc;
  const activePlan = plan
    && plan.srcW === srcW
    && plan.srcH === srcH
    && plan.dstW === targetW
    && plan.dstH === targetH
    && plan.fitMode === fitMode
    && plan.bpc === bpc
      ? plan
      : null;
  if (fitMode === "stretch") {
    return {
      data: bilinearResize(src, srcW, srcH, targetW, targetH, stride, activePlan?.xAxis, activePlan?.yAxis),
      width: targetW,
      height: targetH,
    };
  }
  if (fitMode === "contain") {
    const dstW = activePlan?.dstW ?? Math.max(1, Math.round(srcW * Math.min(targetW / srcW, targetH / srcH)));
    const dstH = activePlan?.dstH ?? Math.max(1, Math.round(srcH * Math.min(targetW / srcW, targetH / srcH)));
    if (dstW === srcW && dstH === srcH) return { data: src, width: srcW, height: srcH };
    return {
      data: bilinearResize(src, srcW, srcH, dstW, dstH, stride, activePlan?.xAxis, activePlan?.yAxis),
      width: dstW,
      height: dstH,
    };
  }
  // cover: map target pixels directly to cropped source span via windowed axes —
  // no intermediate scaled buffer. cropX/Y computed in scaled coords then converted
  // to source coords using scale factor srcW/scaledW so sub-pixel positions are
  // bit-exact with the old two-pass path (scaledW = round(srcW*scale)).
  const scale = Math.max(targetW / srcW, targetH / srcH);
  const scaledW = Math.max(targetW, Math.round(srcW * scale));
  const scaledH = Math.max(targetH, Math.round(srcH * scale));
  const cropX = Math.floor((scaledW - targetW) / 2);
  const cropY = Math.floor((scaledH - targetH) / 2);
  if (scaledW === srcW && scaledH === srcH) {
    const cropped = applyRegionAndDownsample(src, srcW, srcH, { x: cropX, y: cropY, w: targetW, h: targetH }, 1, bpc);
    return { data: cropped.data, width: targetW, height: targetH };
  }
  const srcSpanW = targetW * srcW / scaledW;
  const srcSpanH = targetH * srcH / scaledH;
  const srcStartX = cropX * srcW / scaledW;
  const srcStartY = cropY * srcH / scaledH;
  const xa = activePlan?.xAxis ?? buildResizeAxis(srcW, targetW, srcStartX, srcSpanW);
  const ya = activePlan?.yAxis ?? buildResizeAxis(srcH, targetH, srcStartY, srcSpanH);
  return { data: bilinearResize(src, srcW, srcH, targetW, targetH, stride, xa, ya), width: targetW, height: targetH };
}

function pickDownsample(
  options: {
    region?: Region | null;
    targetWidth?: number | null;
    targetHeight?: number | null;
    sourceWidth?: number | null;
    sourceHeight?: number | null;
  },
): 1 | 2 | 4 | 8 {
  const region = options.region ?? null;
  const targetWidth = options.targetWidth ?? null;
  const targetHeight = options.targetHeight ?? null;
  if (targetWidth == null || targetHeight == null || targetWidth <= 0 || targetHeight <= 0) {
    return 1;
  }
  const sourceWidth = options.sourceWidth ?? null;
  const sourceHeight = options.sourceHeight ?? null;
  const sourceLongEdge = region !== null
    ? Math.max(region.w, region.h)
    : sourceWidth != null && sourceHeight != null && sourceWidth > 0 && sourceHeight > 0
      ? Math.max(sourceWidth, sourceHeight)
      : 1;
  const targetLongEdge = Math.max(targetWidth, targetHeight);
  for (const factor of [8, 4, 2] as const) {
    if (Math.ceil(sourceLongEdge / factor) >= targetLongEdge) return factor;
  }
  return 1;
}

function normalizeRegion(region: Region | null, width: number, height: number): Region {
  if (region === null) return { x: 0, y: 0, w: width, h: height };
  const x = Math.max(0, Math.min(width - 1, Math.trunc(region.x)));
  const y = Math.max(0, Math.min(height - 1, Math.trunc(region.y)));
  const maxW = width - x;
  const maxH = height - y;
  return {
    x,
    y,
    w: Math.max(1, Math.min(maxW, Math.trunc(region.w))),
    h: Math.max(1, Math.min(maxH, Math.trunc(region.h))),
  };
}

// ===== Perceptual Constancy (Lens17) C++ intrinsics wiring (for lightbox/JXL progressive paints) =====
// After `node packages/jxl-wasm/scripts/build.mjs` (the bridge.cpp with avx2 is included),
// the WASM module exports the plain extern "C" symbols:
//   _perceptual_apply_full          (scalar, always)
//   _perceptual_apply_full_avx2     (8-wide SoA bulk when __AVX2__ or emcc SIMD path produced it)
// These are the "remaining C++ tasks" entry points for direct fast path from JS (bypassing full Rust raw-pipeline
// for pure JXL frames in gallery/lightbox when setConstancyParams({mode:'constancy'}) is active).
// Call with SoA Float32Arrays (or views into WASM HEAPF32) of same length = width*height.
// The bulk is what makes the full math beat (or acceptable vs) old baseline in the graphed C++ bench.

export interface PerceptualConstancySupport {
  hasScalar: boolean;
  hasAvx2Bulk: boolean;
}

export async function getPerceptualConstancySupport(): Promise<PerceptualConstancySupport> {
  const module = await loadLibjxlModule();
  const m = module as unknown as Record<string, unknown>;
  return {
    hasScalar: typeof m._perceptual_apply_full === "function",
    hasAvx2Bulk: typeof m._perceptual_apply_full_avx2 === "function",
  };
}

/**
 * Apply the full perceptual constancy transform (B + log geodesic + Molchanov + hybrid spring + f(c))
 * using the fastest available C++ path from the bridge (AVX2 bulk preferred).
 * Expects separate channel SoA buffers (length = numPixels). Mutates outputs in place if provided,
 * otherwise writes to the input arrays.
 * This is the direct JS hook for the lightbox progressive paint path (toggleable, runtime only).
 */
export async function perceptualConstancyApplyBulk(
  r: Float32Array,
  g: Float32Array,
  b: Float32Array,
  sat: number,
  vib: number,
  vibZero: boolean,
  outR?: Float32Array,
  outG?: Float32Array,
  outB?: Float32Array,
): Promise<void> {
  const module = await loadLibjxlModule();
  const m = module as unknown as Record<string, any>;
  const n = r.length | 0;
  if ((g.length | 0) !== n || (b.length | 0) !== n) {
    throw new Error("perceptualConstancyApplyBulk: r/g/b must have identical length");
  }
  const targetR = outR ?? r;
  const targetG = outG ?? g;
  const targetB = outB ?? b;

  const fn = m._perceptual_apply_full_avx2;
  if (typeof fn === "function") {
    fn(r, g, b, targetR, targetG, targetB, n, sat, vib, vibZero ? 1 : 0);
    return;
  }
  const fns = m._perceptual_apply_full;
  if (typeof fns === "function") {
    // _perceptual_apply_full_avx2 is absent — scalar JS path not implemented.
    // The transform is skipped (identity copy). Rebuild with AVX2 for real output.
    console.warn("[jxl-wasm] perceptualConstancyApplyBulk: AVX2 bulk fn absent; perceptual transform not applied (identity). Rebuild WASM with AVX2 support.");
    if (targetR !== r) targetR.set(r);
    if (targetG !== g) targetG.set(g);
    if (targetB !== b) targetB.set(b);
    return;
  }
  // No support compiled in: identity
  if (targetR !== r) targetR.set(r);
  if (targetG !== g) targetG.set(g);
  if (targetB !== b) targetB.set(b);
}

// ===== RAW pipeline: process_region wrapper =====
// Wraps the wasm-bindgen `process_region` export from the RAW converter WASM
// (web/pkg/raw_converter_wasm.js). That function is ORF-only: it decodes to
// full-resolution pre-tonemapped RGB16 (sensor orientation) then crops and
// tonemaps only the requested rect, returning interleaved RGB8 (w*h*3 bytes).
//
// Layer note: this is facade-only FFI. No scheduler/session/cache involvement.

interface RawWasmModule {
  /** S6 ORF region decode: returns RGB8 bytes (w*h*3), throws on error. */
  process_region(bytes: Uint8Array, x: number, y: number, w: number, h: number): Uint8Array;
}

let _rawWasmPromise: Promise<RawWasmModule> | undefined;
let _rawWasmTestFactory: (() => Promise<RawWasmModule>) | null = null;

/** Override the raw WASM loader for testing. Pass null to restore auto-load. */
export function setRawWasmModuleForTesting(factory: (() => Promise<RawWasmModule>) | null): void {
  _rawWasmTestFactory = factory;
  _rawWasmPromise = undefined;
}

async function loadRawWasmModule(): Promise<RawWasmModule> {
  if (_rawWasmPromise === undefined) {
    const p = (_rawWasmTestFactory ?? _loadRawWasmFromPkg)();
    _rawWasmPromise = p;
    p.catch(() => { if (_rawWasmPromise === p) _rawWasmPromise = undefined; });
  }
  return _rawWasmPromise;
}

async function _loadRawWasmFromPkg(): Promise<RawWasmModule> {
  // Resolve relative to this source file so it works both from dist/ and from
  // source (bun resolves TS directly). The RAW converter WASM lives at
  // web/pkg/raw_converter_wasm.js three directories above packages/jxl-wasm/src/.
  // In the primary repo the same content lives at pkg/raw_converter_wasm.js
  // (two directories above packages/jxl-wasm/src/), so we try both.
  const candidates = [
    new URL("../../../web/pkg/raw_converter_wasm.js", import.meta.url),
    new URL("../../../pkg/raw_converter_wasm.js", import.meta.url),
  ];
  let lastErr: unknown;
  for (const url of candidates) {
    try {
      const mod = await import(url.href) as {
        default?: (opts?: { module_or_path?: Uint8Array | BufferSource | string }) => Promise<unknown>;
        process_region?: RawWasmModule["process_region"];
      };
      // wasm-bindgen modules export `default` as the init function.
      if (typeof mod.default === "function") {
        // In Node/Bun: pre-read the .wasm binary so init doesn't attempt a fetch.
        if (typeof process !== "undefined" && !!process.versions?.node) {
          try {
            const fsPromises = await import("node:fs/promises") as { readFile(p: URL | string): Promise<Uint8Array> };
            const urlMod = await import("node:url") as { fileURLToPath(u: URL | string): string };
            const wasmUrl = new URL(url.href.replace(/\.js$/, "_bg.wasm"));
            const wasmBytes = await fsPromises.readFile(urlMod.fileURLToPath(wasmUrl));
            await mod.default({ module_or_path: wasmBytes });
          } catch {
            // Fallback: let the module resolve the WASM on its own.
            await mod.default();
          }
        } else {
          await mod.default();
        }
      }
      if (typeof mod.process_region !== "function") {
        throw new Error("[jxl-wasm] raw_converter_wasm.js does not export process_region");
      }
      return mod as RawWasmModule;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new CapabilityMissing(
    "RAW converter WASM (raw_converter_wasm.js) could not be loaded — run wasm-pack build first",
    lastErr,
  );
}

/**
 * Decode a rectangular sub-region of an Olympus ORF RAW file.
 *
 * Internally: parses + decompresses + MHC-demosaics the ORF to full-resolution
 * pre-tonemapped RGB16 (sensor orientation), then runs the per-pixel tone/colour
 * pipeline over only `[x, x+w) × [y, y+h)`. This is byte-for-byte identical to
 * the same crop of a full `process_orf_with_flags(..., OUT_FULL_RGB8 | OUT_NO_ORIENT)`
 * decode at neutral look.
 *
 * Output pixels are **RGB8** (3 bytes per pixel, no alpha). To get RGBA8, expand
 * with alpha=255 after the call.
 *
 * @throws {Error} if `bytes` is not a valid ORF, or `x+w > imageWidth` / `y+h > imageHeight`.
 * @throws {CapabilityMissing} if the RAW converter WASM is not available.
 */
export async function processRegion(
  rawBytes: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const wasm = await loadRawWasmModule();
  if (typeof wasm.process_region !== "function") {
    throw new CapabilityMissing(
      "raw_converter_wasm.js does not export process_region — rebuild the RAW converter WASM",
    );
  }
  // process_region returns RGB8 bytes (w*h*3) or throws a JS error from the Rust JsValue.
  const pixels = wasm.process_region(rawBytes, x >>> 0, y >>> 0, width >>> 0, height >>> 0);
  return { pixels, width, height };
}

// ---------------------------------------------------------------------------
// Pyramid helpers: pure-JS area downscale + monolithic RGBA8 pyramid encode.
//
// downscale is memory-bandwidth-bound (a trivial box average). A flipflop A/B
// (docs/outputs/timing tests/flipflop/flipflopjournal.toon, "downscale-js-vs-wasm")
// measured pure-JS ~2x faster than the WASM downscale_rgba bridge across all
// sizes, because the wasm-bindgen copy in/out dominates for a JS-resident buffer.
// So downscale stays in JS; the JXL encode (compute-bound) stays in WASM.
// ---------------------------------------------------------------------------

/**
 * Area-average ("box") downscale of an RGBA8 buffer from src dims to dst dims.
 * Pure JS — no WASM round-trip (faster than a bridge for this memory-bound op).
 * dst must be <= src on each axis; equal dims returns a copy.
 */
export function downscaleRgba8(
  rgba: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8Array {
  if (dstW <= 0 || dstH <= 0) throw new Error(`downscaleRgba8: dst dims must be positive, got ${dstW}x${dstH}`);
  if (dstW > srcW || dstH > srcH) throw new Error(`downscaleRgba8: dst ${dstW}x${dstH} exceeds src ${srcW}x${srcH}`);
  const need = srcW * srcH * 4;
  if (rgba.length < need) throw new Error(`downscaleRgba8: buffer too small: ${rgba.length} < ${need}`);
  if (dstW === srcW && dstH === srcH) return rgba.slice();
  const out = new Uint8Array(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = Math.floor(dy * yRatio);
    const sy1 = Math.min(srcH, Math.max(sy0 + 1, Math.ceil((dy + 1) * yRatio)));
    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = Math.floor(dx * xRatio);
      const sx1 = Math.min(srcW, Math.max(sx0 + 1, Math.ceil((dx + 1) * xRatio)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let i = (sy * srcW + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          r += rgba[i]!; g += rgba[i + 1]!; b += rgba[i + 2]!; a += rgba[i + 3]!;
          i += 4; n++;
        }
      }
      const o = (dy * dstW + dx) * 4;
      out[o] = (r / n + 0.5) | 0;
      out[o + 1] = (g / n + 0.5) | 0;
      out[o + 2] = (b / n + 0.5) | 0;
      out[o + 3] = (a / n + 0.5) | 0;
    }
  }
  return out;
}

/** Options for {@link encodeRgba8Pyramid}. Mirrors the pyramid-ingest backend contract. */
export interface Rgba8PyramidOptions {
  fullDistance: number;
  sidecarSizes: readonly number[];
  sidecarDistances: readonly number[];
  effort: number;
  hasAlpha?: boolean;
  resampling?: number;
}

/** One produced pyramid level: a whole-frame JXL plus its pixel dimensions. */
export interface Rgba8PyramidLevel {
  data: Uint8Array;
  width: number;
  height: number;
}

async function encodePlainRgba8(
  rgba: Uint8Array,
  width: number,
  height: number,
  distance: number,
  effort: number,
  hasAlpha: boolean,
): Promise<Uint8Array> {
  const eff = Math.min(9, Math.max(1, Math.round(effort))) as EncoderOptions["effort"];
  const encoder = createEncoder({
    format: "rgba8",
    width,
    height,
    hasAlpha,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance,
    quality: null,
    effort: eff,
    progressive: false,
    previewFirst: false,
    chunked: false,
  });
  const chunks: Uint8Array[] = [];
  const drain = (async () => {
    for await (const c of encoder.chunks()) {
      chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c));
    }
  })();
  await encoder.pushPixels(rgba);
  await encoder.finish();
  await drain;
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Encode an RGBA8 image into a monolithic pyramid: one whole-frame JXL per sidecar
 * size (area-downscaled + encoded at its distance) followed by the full level. Levels
 * are plain JXL (not JXTC tiles) — used by the proxy ladder. The compute-bound encode
 * runs in WASM; the downscale step is pure-JS ({@link downscaleRgba8}). Sidecars whose
 * requested long edge is >= the master's are skipped (mirrors the ingest contract).
 */
export async function encodeRgba8Pyramid(
  rgba: Uint8Array,
  width: number,
  height: number,
  opts: Rgba8PyramidOptions,
): Promise<Rgba8PyramidLevel[]> {
  const hasAlpha = opts.hasAlpha === true;
  const effort = opts.effort ?? 3;
  const longEdge = Math.max(width, height);
  const levels: Rgba8PyramidLevel[] = [];
  for (let i = 0; i < opts.sidecarSizes.length; i++) {
    const target = opts.sidecarSizes[i]!;
    if (target >= longEdge) continue; // sidecar must be strictly smaller than the master
    const scale = target / longEdge;
    const dw = Math.max(1, Math.round(width * scale));
    const dh = Math.max(1, Math.round(height * scale));
    const px = downscaleRgba8(rgba, width, height, dw, dh);
    const dist = opts.sidecarDistances[i] ?? opts.fullDistance;
    levels.push({ data: await encodePlainRgba8(px, dw, dh, dist, effort, hasAlpha), width: dw, height: dh });
  }
  levels.push({ data: await encodePlainRgba8(rgba, width, height, opts.fullDistance, effort, hasAlpha), width, height });
  return levels;
}
