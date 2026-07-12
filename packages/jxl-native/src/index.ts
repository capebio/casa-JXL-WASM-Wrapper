import { createRequire } from "node:module";
import { accessSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class CapabilityMissing extends Error {
  readonly code = "CapabilityMissing";

  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "CapabilityMissing";
  }
}

export interface NativeBinding {
  version(): string;
  probe(): {
    loaded: boolean;
    path: string;
  };
  createDecoder?: (options: DecoderOptions) => NativeDecoder;
  createEncoder?: (options: EncoderOptions) => NativeEncoder;
}

export interface NativeLoaderOptions {
  prebuiltPath?: string;
  sourcePath?: string;
}

export type PixelFormat = "rgba8" | "rgba16" | "rgbaf32";
export type DecodeStage = "header" | "dc" | "pass" | "final";
export type Region = { x: number; y: number; w: number; h: number };

/**
 * Supported extra channel types (mirrors WASM facade exactly for @casabio/jxl-wasm / @casabio/jxl-native API parity).
 * 'thermal' + reservedN + unknown for forward compat (Task 5 full native parity).
 */
export type ExtraChannelType =
  | 'alpha'
  | 'depth'
  | 'selection'
  | 'spot'
  | 'thermal'
  | 'reserved0' | 'reserved1' | 'reserved2' | 'reserved3' | 'reserved4' | 'reserved5' | 'reserved6' | 'reserved7'
  | 'unknown';

export interface SpotColorInfo {
  red: number;
  green: number;
  blue: number;
  solidity: number;   // 0.0–1.0
}

export interface ExtraChannel {
  type: ExtraChannelType;
  bitsPerSample: number;
  /** Optional. Used for certain channel types (e.g. subsampling control). */
  dimShift?: number;
  /** Human-readable or ICC-aware name. Recommended for all non-alpha channels. */
  name?: string;

  /** Per-channel distance (encode). 0 = lossless for the channel. */
  distance?: number;

  /** Only used when type === 'spot'. */
  spotColor?: SpotColorInfo;

  /** Optional custom resampling factor for this channel (future). */
  resampling?: 1 | 2 | 4 | 8;
}

export type DecodedExtraChannel = Readonly<Omit<ExtraChannel, 'distance' | 'resampling'>>;

export interface ImageInfo {
  width: number;
  height: number;
  bitsPerSample: 8 | 16 | 32;
  hasAlpha: boolean;
  hasAnimation: boolean;
  jpegReconstructionAvailable: boolean;
  /** Decoder-side extra channel descriptors (Task 5 native parity). Present iff codestream declared 1+ extra channels. */
  extraChannels?: readonly DecodedExtraChannel[];
}

export type DecodeEvent =
  | { type: "header"; info: ImageInfo; extraChannels?: readonly DecodedExtraChannel[] }
  | { 
      type: "progress"; 
      stage: DecodeStage; 
      info: ImageInfo; 
      pixels: ArrayBuffer | Uint8Array; 
      format: PixelFormat; 
      region?: Region; 
      pixelStride: number; 
      extraChannels?: readonly DecodedExtraChannel[]; 
      extraPlanes?: ArrayBuffer[];
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
      extraChannels?: readonly DecodedExtraChannel[]; 
      extraPlanes?: ArrayBuffer[];
      frameIndex?: number;
      frameDuration?: number;
      frameName?: string;
      animTicksPerSecond?: number;
    }
  | { type: "budget_exceeded"; stage: DecodeStage; info: ImageInfo; pixels: ArrayBuffer | Uint8Array; format: PixelFormat; pixelStride: number; extraChannels?: readonly DecodedExtraChannel[] }
  | { type: "error"; code: string; message: string };

export interface DecoderOptions {
  format: PixelFormat;
  region: Region | null;
  downsample: 1 | 2 | 4 | 8;
  progressionTarget: "header" | "dc" | "pass" | "final";
  emitEveryPass: boolean;
  progressiveDetail?: "dc" | "lastPasses" | "passes" | "dcProgressive";
  preserveIcc: boolean;
  preserveMetadata: boolean;
  /** reserved; ignored by native */
  extraChannels?: readonly DecodedExtraChannel[];
  // decodeExtraChannels is native-only (opt-in for N-20 extra plane extraction); not part of core DecoderOptions.
  decodeExtraChannels?: boolean;
  maxPixels?: number;
}

/**
 * Live / incremental streaming (Packet-3 Task 4, finding 20).
 *
 * The native decoder now processes libjxl input on each push() rather than
 * deferring everything to close(). Events (header first, then progression /
 * frame / final) are queued into a bounded FIFO and drained by a *live* async
 * iterator, so a consumer awaiting events() observes header/progress events
 * BEFORE close() when libjxl can already produce them. push() returns a Promise
 * that resolves immediately unless the bounded queue is full and no consumer is
 * draining, in which case it parks (backpressure) until the consumer catches up
 * — bounding retained memory to (queue HWM events) + (one active frame buffer).
 *
 * Memory note for emitEveryPass + progressiveDetail:"passes": each queued
 * "progress" event still holds a full-frame ArrayBuffer until it is drained past
 * the head cursor / .dispose(). Backpressure caps how many undrained progress
 * events can accumulate.
 */

export interface AnimationOptions { ticksPerSecond: number; loopCount?: number; }
export interface AnimationFrame {
  data: ArrayBuffer | Uint8Array;
  width: number; height: number;
  duration: number;           // in ticks
  name?: string;
}
export interface CustomBox { type: string; data: ArrayBuffer | Uint8Array; compress?: boolean; }

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
  previewFirst: boolean;
  chunked: boolean;

  /**
   * Escape hatch for advanced/experimental libjxl frame settings (patches, future tools, etc.).
   *
   * Use the named constants in `JxlFrameSetting`.
   *
   * @example
   * createEncoder({
   *   ...baseOptions,
   *   advancedFrameSettings: [
   *     { id: JxlFrameSetting.PATCHES, value: 1 }
   *   ]
   * });
   */
  advancedFrameSettings?: Array<{ id: number; value: number }>;
  extraChannels?: readonly ExtraChannel[];

  /** Per-alpha-channel distance; 0 = lossless alpha. Forwarded natively (Agent 3). */
  alphaDistance?: number;
  /** Brotli effort for modular/metadata streams (0-11). -> JXL_ENC_FRAME_SETTING_BROTLI_EFFORT (id 32). */
  brotliEffort?: number;
  /** Top-level progressiveDc convenience. -> id 19 (PROGRESSIVE_DC). */
  progressiveDc?: 0 | 1 | 2;
  /** -> id 13 (GROUP_ORDER). */
  groupOrder?: 0 | 1;
  /** Force modular (1) / VarDCT (0). -> id 11. */
  modular?: -1 | 0 | 1;
  /** -> id 27 (MODULAR_PREDICTOR), id 26 (MODULAR_GROUP_SIZE). */
  modularOptions?: { predictor?: number; groupSize?: number };
  /** Plane data, index-aligned with extraChannels. Merged into per-EC `pixels` for native. */
  extraChannelPlanes?: readonly (ArrayBuffer | Uint8Array)[];
  animation?: AnimationOptions;
  frames?: readonly AnimationFrame[];
  customBoxes?: readonly CustomBox[];
}

/**
 * Named constants for common JXL_ENC_FRAME_SETTING_* values.
 * Use with the `advancedFrameSettings` escape hatch for experimental/advanced features
 * (patches, future spline controls, etc.).
 */
export const JxlFrameSetting = {
  /** Enables or disables patches generation. -1 default, 0 disable, 1 enable. */
  PATCHES: 8,
  /** Force modular (1) vs VarDCT (0 default). Useful via escape hatch for modular experiments. */
  MODULAR: 11,
  /** Progressive AC (spectral) layers. */
  PROGRESSIVE_AC: 17,
  /** Quantized progressive AC. */
  QPROGRESSIVE_AC: 18,
  /** Progressive DC levels (0-2). */
  PROGRESSIVE_DC: 19,
  /** Responsive/squeeze progressive for modular. */
  RESPONSIVE: 16,
  /** Edge-preserving filter strength (-1..3). */
  EPF: 9,
  /** Gaborish filter enable/disable (0/1). */
  GABORISH: 10,
  /** Decode speed tier (0-4); trades density for faster decode (Lens 15 lever). */
  DECODING_SPEED: 1,
  /** Photon noise ISO simulation amount. */
  PHOTON_NOISE: 5,
  /** Group order (0 or 1). */
  GROUP_ORDER: 13,
  /** Brotli effort for modular/metadata streams (0-11). */
  BROTLI_EFFORT: 32,
  /** Modular group size. */
  MODULAR_GROUP_SIZE: 26,
  /** Modular predictor. */
  MODULAR_PREDICTOR: 27,
} as const;

/**
 * Generic live-stream contract (Packet-3 Task 4, finding 20).
 *
 * A NativeStream processes incrementally: push() feeds bytes and runs codec work
 * eagerly; events()/chunks() are *live* async iterables that surface output as it
 * is produced (at least one event/chunk before finish() when the codec can
 * produce it); push() applies bounded backpressure — its Promise does not resolve
 * while the internal queue is full and no consumer is draining. finish()/cancel()/
 * dispose() release all native references on every exit path.
 *
 * NativeDecoder is NativeStream<DecodeEvent, never> with push/close naming;
 * NativeEncoder is NativeStream<never, chunk> with pushPixels/finish naming.
 * The generic shape is exported for consumers that want to treat either uniformly.
 */
export interface NativeStream<TEvent, TChunk> {
  push(bytes: Uint8Array): Promise<void>;
  events(): AsyncIterable<TEvent>;
  chunks(): AsyncIterable<TChunk>;
  finish(): Promise<void>;
  cancel(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface NativeDecoder {
  /** Feed encoded bytes; processed incrementally. Resolves under backpressure. */
  push(chunk: ArrayBuffer | Uint8Array): void | Promise<void>;
  /** Signal end of input and finalize decode. */
  close(): void | Promise<void>;
  /** Live async iterable: yields events as they are produced (before close()). */
  events(): AsyncIterable<DecodeEvent>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface NativeEncoder {
  pushPixels(chunk: ArrayBuffer | Uint8Array, region?: Region): void | Promise<void>;
  finish(): void | Promise<void>;
  /** Live async iterable: yields encoded chunks as they are produced. */
  chunks(): AsyncIterable<ArrayBuffer | Uint8Array>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface NativeCodecFacade {
  createDecoder(options: DecoderOptions): NativeDecoder;
  createEncoder(options: EncoderOptions): NativeEncoder;
}

const require = createRequire(import.meta.url);
const packageRoot = dirname(fileURLToPath(import.meta.url));

let cachedBinding: NativeBinding | null = null;

export function loadNativeBinding(options: NativeLoaderOptions = {}): NativeBinding {
  const custom = options.prebuiltPath !== undefined || options.sourcePath !== undefined;
  if (!custom && cachedBinding) return cachedBinding;

  const candidates = [
    options.prebuiltPath ?? resolvePrebuiltBinary(),
    options.sourcePath ?? resolveSourceBinary()
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const rawBinding = require(candidate) as NativeBinding;
      ensureBindingLoaded(rawBinding, candidate);
      // N-16: make probe.path report the actual resolved module path (prebuilt/built .node)
      // rather than a short identifier from native.cc. Wrap without mutating the required module.
      if (typeof rawBinding.probe === "function") {
        const orig = rawBinding.probe;
        (rawBinding as any).probe = () => {
          const base = orig();
          return { loaded: base.loaded, path: candidate };
        };
      }
      const adapted = adaptBindingCreators(rawBinding);
      if (!custom) cachedBinding = adapted;
      return adapted;
    } catch (error) {
      lastError = error;
    }
  }

  throw new CapabilityMissing("jxl-native addon unavailable; falling back to WASM is required", lastError);
}

function normalizeEncoderOptions(opts: EncoderOptions): EncoderOptions {
  const adv = [...(opts.advancedFrameSettings ?? [])];
  const map: Array<[number | undefined, number]> = [
    [opts.progressiveDc, 19], // id: 19
    [opts.groupOrder, 13],    // id: 13
    [opts.modular, 11],
    [opts.modularOptions?.predictor, 27], [opts.modularOptions?.groupSize, 26],
    [opts.brotliEffort, 32],
  ];
  for (const [v, id] of map) {
    if (v !== undefined) {
      if (!adv.some(x => x.id === id)) {
        adv.push({ id, value: v });
      }
    }
  }
  let extraChannels = opts.extraChannels;
  if (opts.extraChannelPlanes && extraChannels) {
    extraChannels = extraChannels.map((ec, i) =>
      opts.extraChannelPlanes![i] ? { ...ec, pixels: opts.extraChannelPlanes![i] } as any : ec);
  }
  const res: EncoderOptions = { ...opts };
  if (adv.length) {
    res.advancedFrameSettings = adv;
  } else {
    delete res.advancedFrameSettings;
  }
  if (extraChannels !== undefined) {
    res.extraChannels = extraChannels;
  } else {
    delete res.extraChannels;
  }
  return res;
}

export function createNativeCodecFacade(binding: NativeBinding): NativeCodecFacade {
  if (typeof binding.createDecoder !== "function" || typeof binding.createEncoder !== "function") {
    throw new CapabilityMissing("jxl-native addon does not expose createDecoder/createEncoder");
  }
  ensureBindingLoaded(binding, "native binding");
  return {
    createDecoder(options) {
      const merged = { maxPixels: 1 << 28, decodeExtraChannels: false, ...options };
      guardDecoderOptions(merged);
      const raw = binding.createDecoder!(merged);
      return wrapDecoder(raw);
    },
    createEncoder(options) {
      const normalized = normalizeEncoderOptions(options);
      guardEncoderOptions(normalized);
      return binding.createEncoder!(normalized);
    },
  };
}

export function createDecoder(options: DecoderOptions): NativeDecoder {
  return createNativeCodecFacade(loadNativeBinding()).createDecoder(options);
}

export function createEncoder(options: EncoderOptions): NativeEncoder {
  return createNativeCodecFacade(loadNativeBinding()).createEncoder(options);
}

function guardDecoderOptions(opts: DecoderOptions): void {
  if (opts.region != null) {
    const { x, y, w, h } = opts.region;
    if (w <= 0 || h <= 0 || x < 0 || y < 0) {
      throw new CapabilityMissing("region must have positive w/h and non-negative x/y");
    }
  }
  // downsample 1|2|4|8 is enforced by the type; native clamps invalid values to 1.
}

function guardEncoderOptions(_opts: EncoderOptions): void {
  // iccProfile/exif/xmp are implemented natively (N-17). No capability guards remain.
}

function wrapDecoder(raw: NativeDecoder): NativeDecoder {
  if ((raw as any).__jxlWrappedEvents) return raw;
  // Packet-3 Task 4: events() is now a LIVE iterator. The native side queues
  // events as push()/close() produce them and resolves the iterator's next()
  // against that growing queue, so consumers can drain events *concurrently*
  // with pushing (observing header/progress before close()). We therefore no
  // longer gate events() behind an "input done" promise.
  //
  // We keep a settled marker only for the seek* shims (which are software
  // re-scans that only make sense once all input has been decoded).
  let release!: () => void;
  const inputDone = new Promise<void>((r) => (release = r));
  const w: any = {
    push: (chunk: ArrayBuffer | Uint8Array) => raw.push(chunk),
    close: async () => {
      try { await raw.close(); } finally { release(); }
    },
    cancel: async (reason?: string) => {
      try { await raw.cancel(reason); } finally { release(); }
    },
    dispose: async () => {
      try { await raw.dispose(); } finally { release(); }
    },
    // Live pass-through: yield directly from the native live iterator.
    events: () => (raw.events ? raw.events() : (async function* () {})()),
  };
  // software seek shims for parity with WASM facade and existing .d.ts / tests.
  // These remain "await all input then re-scan" since a seek is only meaningful
  // over a fully-decoded stream.
  w.seekToFrame = typeof (raw as any).seekToFrame === "function"
    ? (frameIndex: number) => (raw as any).seekToFrame(frameIndex)
    : async function* (_frameIndex: number) {
        await inputDone;
        yield* (raw as any).events ? (raw as any).events() : [];
      };
  w.seekToTime = typeof (raw as any).seekToTime === "function"
    ? (timeMs: number) => (raw as any).seekToTime(timeMs)
    : async function* (_timeMs: number) {
        await inputDone;
        yield* (raw as any).events ? (raw as any).events() : [];
      };
  (w as any).__jxlWrappedEvents = true;
  return w as NativeDecoder;
}

function adaptBindingCreators(raw: NativeBinding): NativeBinding {
  const adapted: any = {
    version: raw.version ? raw.version.bind(raw) : undefined,
    probe: raw.probe ? raw.probe.bind(raw) : undefined,
  };
  if (raw.createDecoder) {
    adapted.createDecoder = (options: DecoderOptions) => {
      const merged = { maxPixels: 1 << 28, decodeExtraChannels: false, ...options };
      guardDecoderOptions(merged);
      const rawDec = raw.createDecoder!(merged);
      return wrapDecoder(rawDec);
    };
  }
  if (raw.createEncoder) {
    adapted.createEncoder = (options: EncoderOptions) => {
      const normalized = normalizeEncoderOptions(options);
      guardEncoderOptions(normalized);
      return raw.createEncoder!(normalized);
    };
  }
  return adapted as NativeBinding;
}

function resolvePrebuiltBinary(): string {
  const platform = process?.platform ?? "unknown";
  const arch = process?.arch ?? "unknown";
  const base = join(packageRoot, "..", "prebuilds");
  const candidate = resolve(base, `${platform}-${arch}`, "jxl-native.node");
  return candidate;
}

function resolveSourceBinary(): string {
  const release = resolve(packageRoot, "..", "build", "Release", "jxl_native.node");
  const debug = resolve(packageRoot, "..", "build", "Debug", "jxl_native.node");
  return fileExists(release) ? release : fileExists(debug) ? debug : release;
}

function fileExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

function ensureBindingLoaded(binding: NativeBinding, label: string): void {
  if (typeof binding.version === "function" && binding.version().includes("scaffold")) {
    throw new CapabilityMissing(`jxl-native addon at ${label} is still the scaffold stub`);
  }
  if (typeof binding.probe !== "function") return;
  const probe = binding.probe();
  if (typeof probe.path === "string" && probe.path.toLowerCase().includes("stub")) {
    throw new CapabilityMissing(`jxl-native addon at ${label} is still the scaffold stub`, probe);
  }
  if (probe.loaded !== true) {
    throw new CapabilityMissing(`jxl-native addon at ${label} is present but not loaded`, probe);
  }
}
