// jxl-core/src/types.ts
// Contract: Section 5 of casabio-jxl-wrapper-construction-spec-v2.md
// Do not add fields not present in the spec.

export type PixelFormat =
  | "rgba8"     // 4 channels, 8-bit, premultiplied alpha = false
  | "rgba16"    // 4 channels, 16-bit
  | "rgbaf32"   // 4 channels, 32-bit float (linear)
  | "rgb8";     // encode input only: 3 channels, 8-bit, no alpha (skips RGBA round-trip)

export interface ImageInfo {
  width: number;
  height: number;
  bitsPerSample: 8 | 16 | 32;
  hasAlpha: boolean;
  hasAnimation: boolean;
  iccProfile?: Uint8Array;          // present when the file carries one
  colorSpace?: ColorSpaceHint;      // hint derived when no ICC is present
  exif?: Uint8Array;                // raw EXIF box
  xmp?: Uint8Array;                 // raw XMP box
  jpegReconstructionAvailable: boolean;
}

export type ColorSpaceHint =
  | "srgb" | "display-p3" | "rec2020-pq" | "rec2020-hlg" | "linear-srgb" | "unknown";

export type DecodeStage =
  | "header"       // ImageInfo available
  | "dc"           // first useful low-frequency preview
  | "pass"         // intermediate progressive refinement
  | "final";       // full image complete

export interface DecodeFrameEvent {
  stage: DecodeStage;
  info: ImageInfo;
  pixels: ArrayBuffer;              // transferred
  format: PixelFormat;
  region?: Region;                  // present for tile/region decodes
  pixelStride: number;              // bytes per row (may exceed width * channels * bpc/8)
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

export interface Region {
  x: number; y: number; w: number; h: number;
}

export interface DecodeOptions {
  // What the caller wants out
  format: PixelFormat;              // requested output format
  preserveIcc?: boolean;            // default true
  preserveMetadata?: boolean;       // default true (EXIF + XMP)
  region?: Region;                  // crop decode
  downsample?: 1 | 2 | 4 | 8;       // request power-of-two downsample; combined with targetWidth/targetHeight — downsample first, then JS bilinear resize
  targetWidth?: number;               // desired output width; facade applies bilinear resize post-decode
  targetHeight?: number;              // desired output height; facade applies bilinear resize post-decode
  fitMode?: "contain" | "cover" | "stretch"; // default "contain"; only applied when targetWidth/targetHeight set
  // Progression
  progressionTarget?: "header" | "dc" | "pass" | "final"; // earliest stage to stop
  emitEveryPass?: boolean;          // default true for viewer, false for thumbnail
  /**
   * libjxl progressive detail level. Mapped to JxlProgressiveDetail in the WASM bridge:
   *   "dc"            → kDC: single DC-only preview
   *   "lastPasses"    → kLastPasses: emit only the final refinement passes (skip early noise)
   *   "passes"        → kPasses: emit every refinement pass (default when emitEveryPass)
   *   "dcProgressive" → kDCProgressive: DC followed by progressive AC passes
   * When unset, the facade picks "passes" if emitEveryPass is true or progressionTarget is "pass",
   * otherwise "dc". Ignored when progressionTarget="final" and emitEveryPass=false (no subscription).
   */
  progressiveDetail?: "dc" | "lastPasses" | "passes" | "dcProgressive";
  // Scheduling
  priority?: "visible" | "near" | "background";
  budgetMs?: number;
  signal?: AbortSignal;
  // Telemetry
  onMetric?: (m: CodecMetric) => void;
}

export interface DecodeSession {
  readonly id: string;
  // Stream the bytes in; resolves when worker has accepted the chunk
  push(chunk: ArrayBuffer | Uint8Array): Promise<void>;
  // Signal end of input
  close(): Promise<void>;
  // Iterate frames as they emit
  frames(): AsyncIterable<DecodeFrameEvent>;
  // Await final completion; rejects on error or abort
  done(): Promise<ImageInfo>;
  // Cancel and release codec resources
  cancel(reason?: string): Promise<void>;
}

export interface EncodeStats {
  /** Raw pixel bytes: width × height × channels × bytesPerChannel. */
  originalBytes: number;
  /** Total JXL bytes written across all chunks (including sidecars). */
  compressedBytes: number;
  /** compressedBytes / originalBytes. Values below 1.0 indicate net compression. */
  ratio: number;
  /**
   * Cumulative byte offsets at sidecar boundaries. Length === sidecarSizes.length.
   * Entry i = number of bytes emitted after the i-th sidecar chunk; equivalently
   * the byte offset where the (i+1)-th chunk begins. The final main-image
   * codestream starts at sidecarOffsets[sidecarOffsets.length - 1] and ends at
   * compressedBytes. Omitted when no sidecars were requested or produced.
   *
   * Use with jxl-stream `fromRangePrefix` to fetch only the smallest sidecar:
   *   const firstSidecar = sidecarOffsets[0];
   *   stream.fromRangePrefix(url, { byteCount: firstSidecar });
   */
  sidecarOffsets?: readonly number[];
}

export interface AdvancedEncoderControls {
  filters?: FiltersControls;
  groupOrder?: GroupOrderControls;
  buffering?: BufferingControls;
}

export interface FiltersControls {
  dots?: boolean;
  patches?: boolean;
  epf?: -1 | 0 | 1 | 2 | 3;
  gaborish?: boolean;
}

export interface GroupOrderControls {
  mode: "scanline" | "center";
  centerX?: number;
  centerY?: number;
}

export interface BufferingControls {
  strategy?: -1 | 0 | 1 | 2 | 3;
  streamingInput?: boolean;
  streamingOutput?: boolean;
  lowMemoryMode?: boolean;
  preferChunkedAPI?: boolean;
}

export interface EncodeOptions {
  format: PixelFormat;
  width: number;
  height: number;
  hasAlpha: boolean;
  // Color and metadata
  iccProfile?: Uint8Array;          // attach to output
  exif?: Uint8Array;
  xmp?: Uint8Array;
  // Quality knobs
  distance?: number;                // libjxl distance; 0 = lossless
  quality?: number;                 // 0-100, mapped via JxlEncoderDistanceFromQuality
  effort?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  modular?: -1 | 0 | 1;             // -1 = auto, 0 = VarDCT, 1 = Modular
  brotliEffort?: number;            // -1 = libjxl default, 0-11 explicit
  decodingSpeed?: number;           // 0-4 encode-time decode speed tier hint
  photonNoiseIso?: number;          // 0/off or target ISO for synthetic photon noise
  // Progressive / streaming
  progressive?: boolean;            // enable progressive frames
  progressiveFlavor?: "dc" | "ac";  // DC-only or DC+AC refinement progression
  previewFirst?: boolean;           // bias for early bytes over compression
  /**
   * Progressive DC layers (0/1/2). 2 gives more granular early DC stages for visibly distinct passes.
   * Works with groupOrder and progressive decode detail='passes'.
   */
  progressiveDc?: 0 | 1 | 2;
  /** Explicit VarDCT spectral AC progression override. Omit to use progressiveFlavor/previewFirst defaults. */
  progressiveAc?: 0 | 1 | 2;
  /** Explicit VarDCT quantized AC progression override. Omit to use progressiveFlavor/previewFirst defaults. */
  qProgressiveAc?: 0 | 1 | 2;
  /**
   * 0=scanline, 1=center-out group order. Strongly recommended for useful early progressive bytes.
   * Matches cjxl --group_order.
   */
  groupOrder?: 0 | 1;
  /**
   * Center X coordinate (in pixels) for center-first group ordering (groupOrder=1).
   * -1 (or omitted) = automatic (middle of image). Only honored when groupOrder=1.
   * Matches cjxl --center_x with mutual-exclusion validation (error/warn if set without groupOrder=1).
   */
  centerX?: number;
  /**
   * Center Y coordinate (in pixels) for center-first group ordering (groupOrder=1).
   * -1 (or omitted) = automatic (middle of image). Only honored when groupOrder=1.
   * Matches cjxl --center_y.
   */
  centerY?: number;

  /**
   * Buffering / streaming strategy (cjxl --buffering + --streaming_input / --streaming_output).
   * Full first-class surface with documented memory/density/compression tradeoffs.
   * strategy -1..3 per cjxl (see JSDoc or cjxl --help for exact semantics).
   * lowMemoryMode / preferChunkedAPI promote to strategy=3 (least memory) when no explicit strategy (smart wiring, Phase 3).
   */
  buffering?: BufferingControls;

  advancedControls?: AdvancedEncoderControls;
  chunked?: boolean;                // use JxlEncoderAddChunkedFrame for large inputs (legacy alias for buffering.strategy=2-ish)
  /**
   * Max dimension (px, long edge) of sidecar thumbnail(s) to yield BEFORE the
   * main image chunks. Sorted ascending so the smallest preview arrives first.
   * Requires a WASM build with the sidecar bridge (_jxl_wasm_encode_rgba8_with_sidecars).
   * Falls back to plain encode when the bridge is absent.
   * The leading `sidecarSizes.length` chunks from `chunks()` are the thumbnails.
   */
  sidecarSizes?: readonly number[];
  // Scheduling
  priority?: "visible" | "near" | "background";
  signal?: AbortSignal;
  onMetric?: (m: CodecMetric) => void;
  /**
   * EXIF orientation tag (1..8) recorded in JXL basic info. When set to >1,
   * pixels remain in sensor orientation and decoders apply the rotation as
   * metadata — no CPU rotation at encode time. Default: 1 (identity).
   * Requires a WASM build with the `_z` / `_v3` orientation bridge; ignored
   * silently when absent (caller must rotate pixels themselves in that case).
   */
  orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /**
   * Intrinsic (display) size override. When set, the JXL codestream signals a
   * different display resolution from the encoded pixel dimensions — useful for
   * Retina/@2× assets (intrinsicSize 512×512, encoded 1024×1024).
   * Maps to JxlBasicInfo.have_intrinsic_size.
   * Requires WASM build with enc_set_intrinsic_size bridge.
   */
  intrinsicSize?: { width: number; height: number };
  /**
   * Disable libjxl perceptual quality heuristics (butteraugli/XYB psychovisual model).
   * Useful for fair codec benchmarking without perceptual optimisation.
   * Maps to JXL_ENC_FRAME_SETTING_DISABLE_PERCEPTUAL_HEURISTICS (ID 39).
   * Requires WASM build with enc_set_frame_flags bridge.
   */
  disablePerceptualHeuristics?: boolean;
  /**
   * Force JPEG XL codestream level. -1/omitted = libjxl automatic, 5 = Level 5,
   * 10 = Level 10 for CMYK/black extra-channel and other Level 10 workflows.
   */
  codestreamLevel?: -1 | 5 | 10;

  /**
   * JPEG reconstruction controls for when source is JPEG (lossless transcode path).
   * Full dec-hints (color_space, icc_pathname, strip=*) per cjxl row 12 audit.
   * Strip (keep*) + warnings from row 7. cfl/store etc from jpeg-recompression-polish.
   * colorSpace / icc for raw format color override or JPEG recon color hints.
   */
  jpegReconstruction?: {
    cfl?: boolean;
    compressBoxes?: boolean;
    emitWarnings?: boolean;
    storeJPEGMetadata?: boolean;
    /** 0=strip EXIF from source JPEG recon, 1=keep (default). Maps to ID 35. Per-cjxl: stripping exif/xmp requires store=false to allow exact recon. */
    keepExif?: 0 | 1;
    /** 0=strip XMP, 1=keep (default). ID 36. */
    keepXmp?: 0 | 1;
    /** 0=strip JUMBF, 1=keep (default). ID 37. */
    keepJumbf?: 0 | 1;
    /** color_space from -x dec-hints (e.g. "sRGB", "RGB_D65_SRG_Per_SRG", shorthands). For raw input color or recon override. */
    colorSpace?: string;
    /** icc_pathname equivalent: ICC profile bytes for the hint. */
    icc?: Uint8Array;
  };

  /**
   * Row 8 (cjxl): The input image has already been downsampled by the resampling factor.
   * Decoder will upsample. Matches --already_downsampled + sets already_downsampled in params.
   */
  alreadyDownsampled?: boolean;

  /**
   * Row 8 (cjxl): Decoder upsampling mode (useful with alreadyDownsampled).
   * -1 = default non-separable, 0 = nearest (pixel art). Matches --upsampling_mode.
   * Applied via JxlEncoderSetUpsamplingMode(enc, factor, mode).
   */
  upsamplingMode?: -1 | 0 | 1;

  /**
   * Row 8 (cjxl): Separate resampling factor for extra channels (ID 3).
   * -1 = match main or default, 1/2/4/8. Matches --ec_resampling.
   */
  ecResampling?: -1 | 1 | 2 | 4 | 8;

  /**
   * Row 9 (cjxl): frame indexing for JXL_ENC_FRAME_INDEX_BOX (ID 31).
   * String matching ^(0*|1[01]*)$ strict (cjxl validation in ProcessFlags); if starts with '0' all must '0'; to index later frames first must be indexed.
   * '1' at pos i for frame i.
   */
  frameIndexing?: string;

  /**
   * Row 10 (cjxl): gate for effort=11 (expert mode, extreme compute for denser lossless).
   * Per cjxl --allow_expert_options + guarded effort validation (1-11 only when true).
   */
  allowExpertOptions?: boolean;
}

export interface EncodeSession {
  readonly id: string;
  // Push pixels (one or many chunks for chunked encodes)
  pushPixels(chunk: ArrayBuffer, region?: Region): Promise<void>;
  // Signal end of pixel input
  finish(): Promise<void>;
  // Iterate output byte chunks as they emit.
  // If sidecarSizes was specified, the first sidecarSizes.length chunks are thumbnail JXLs.
  chunks(): AsyncIterable<ArrayBuffer>;
  // Await completion; resolves with total bytes written
  done(): Promise<number>;
  // Available after done() resolves. Null before completion or on error.
  getStats(): EncodeStats | null;
  cancel(reason?: string): Promise<void>;
}

export type CodecMetric =
  | { name: "time_to_header_ms"; value: number }
  | { name: "time_to_first_pixel_ms"; value: number }
  | { name: "time_to_final_ms"; value: number }
  | { name: "time_to_first_byte_ms"; value: number }
  | { name: "input_bytes"; value: number }
  | { name: "output_bytes"; value: number }
  | { name: "encode_total_ms"; value: number }
  | { name: "peak_memory_bytes"; value: number }
  | { name: "format_downcast"; value: number }      // emitted when output bpc < source bpc
  | { name: "region_fallback_full_frame"; value: 1 } // emitted when region decode falls back
  | { name: "decode_scale_used"; value: number }
  | { name: "decode_region_area"; value: number }
  | { name: "source_pixels_decoded"; value: number }
  | { name: "copy_to_transfer_ms"; value: number }
  | { name: "copied_bytes"; value: number }
  | { name: "dropped_due_to_budget"; value: 1 }
  | { name: "dropped_due_to_cancel"; value: 1 }
  // Scheduler-level wait (populated by jxl-scheduler when a job had to queue for a worker slot).
  // Emitted via the normal metric path so onMetric consumers (benchmarks, parity harnesses)
  // receive it uniformly with time_to_*_ms. 0 or absent for immediate-acquire / preemption paths.
  // Parity with Tauri ProcessResult.queue_wait_ms and synthetic lightbox_bench qwait.
  | { name: "scheduler_queue_wait_ms"; value: number };

// Capabilities shape (spec Section 17)
export interface Capabilities {
  wasm: boolean;
  wasmSimd: boolean;
  wasmRelaxedSimd: boolean;    // requires wasmSimd
  wasmThreads: boolean;        // requires SAB + crossOriginIsolated
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  offscreenCanvas: boolean;
  imageBitmap: boolean;
  nativeJxlDecoder: boolean;
  selectedWasmBuild: "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar" | "none";
  libjxlVersion: string;
}

// Context options (spec Section 5 prose)
export interface ContextOptions {
  poolSize?: number;
  memoryCapBytes?: number;
  idleTimeoutMs?: number;
  pushHwm?: number;
  wasmUrl?: string;
  cache?: CacheOptions;
  // Workers to spawn eagerly at context creation so the first decode/encode
  // hits a booted (and, in the browser worker, WASM-warm) worker instead of
  // paying spawn + fetch + compile serially. 0 disables. Browser contexts
  // default to 1; idle reap (idleTimeoutMs) covers abandonment.
  prewarmSize?: number;
}

export interface CacheOptions {
  persistent?: boolean;
  hotMaxBytes?: number;           // in-memory LRU cap; default 128 MiB browser
  persistentMaxBytes?: number;    // OPFS/fs cap; default 1 GiB
  persistentPath?: string;        // node: filesystem path
}

export interface ViewportResult {
  pixels: ArrayBuffer;
  width: number;
  height: number;
  sourceRegion: Region;
  sourceScale: number;
}

export interface DecodeGridInfo {
  tileWidth?: number;
  tileHeight?: number;
  preferredRegionAlign?: number;
  lodLevels?: readonly number[];
}

export interface WrapperCapabilities {
  regionDecode: boolean;
  exactSizeDecode: boolean;
  progressiveRegionDecode: boolean;
  tileAlignedRegionDecode: boolean;
  arbitraryRegionDecode: boolean;
  availableDownsampleFactors: readonly number[];
}
