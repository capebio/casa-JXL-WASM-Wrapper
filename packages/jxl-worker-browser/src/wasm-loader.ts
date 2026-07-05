// jxl-worker-browser/src/wasm-loader.ts
// Loads the WASM codec facade. T-WASM-BUILD supplies the generated libjxl
// adapter behind this facade.

import type { DecodeStage, ImageInfo, PixelFormat, Region } from "@casabio/jxl-core/types";

export type Tier = "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";
type WorkerTierOverride = Tier | "auto";

// keep in sync with @casabio/jxl-capabilities/src/index.ts detectTier + _probes
// (includes crossOriginIsolated check for canDoMT; local copy required — static
// bare import from worker graph would not resolve reliably, see defaultImportWasm
// comment, "no top-level bare jxl-wasm" test guard, and git history removing the dep).
let cachedDetectedTier: Tier | undefined;

export function detectTier(): Tier {
  if (cachedDetectedTier !== undefined) return cachedDetectedTier;
  let tier: Tier;
  if (typeof WebAssembly === "undefined") {
    tier = "scalar";
  } else {
    const hasSimd = _probeSimd();
    if (!hasSimd) {
      tier = "scalar";
    } else {
      const hasSab = typeof SharedArrayBuffer !== "undefined";
      const crossOriginIsolated = typeof self !== "undefined" && !!(self as any).crossOriginIsolated;
      // Match jxl-wasm / worker tier pick: COI + SAB enable threaded builds; do not
      // require the wasm-threads validate probe (false on some Chrome builds that still run MT WASM).
      const canDoMT = hasSab && crossOriginIsolated;
      const hasRelaxedSimd = _probeRelaxedSimd();
      if (canDoMT && hasRelaxedSimd) tier = "relaxed-simd-mt";
      else if (canDoMT) tier = "simd-mt";
      else tier = "simd";
    }
  }
  cachedDetectedTier = tier;
  return tier;
}

function _probeSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x08, 0x01, 0x06, 0x00,
      0x41, 0x00, 0xfd, 0x0f, 0x0b,
    ]));
  } catch { return false; }
}

function _probeRelaxedSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x07, 0x01, 0x60, 0x02, 0x7b, 0x7b, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x0b, 0x01, 0x09, 0x00,
      0x20, 0x00, 0x20, 0x01, 0xfd, 0x80, 0x02, 0x0b,
    ]));
  } catch { return false; }
}

export type BrowserDecodeEvent =
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
      animTicksPerSecond?: number;
    }
  | {
      type: "budget_exceeded";
      stage: DecodeStage;
      info: ImageInfo;
      pixels: ArrayBuffer | Uint8Array;
      format: PixelFormat;
      region?: Region;
      pixelStride: number;
    }
  | {
      type: "error";
      code: string;
      message: string;
      partialPixels?: ArrayBuffer | Uint8Array;
      partialInfo?: ImageInfo;
      partialPixelStride?: number;
      partialStage?: DecodeStage;
    };

export interface BrowserDecoder {
  push(chunk: ArrayBuffer): void | Promise<void>;
  close(): void | Promise<void>;
  events(): AsyncIterable<BrowserDecodeEvent>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface BrowserEncoder {
  pushPixels(chunk: ArrayBuffer, region?: Region): void | Promise<void>;
  finish(): void | Promise<void>;
  chunks(): AsyncIterable<ArrayBuffer | Uint8Array>;
  cancel(reason?: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

// Stable facade consumed by worker handlers. T-WASM-BUILD adapts generated libjxl
// exports into this shape.
export interface JxlModule {
  createDecoder(options: {
    format: PixelFormat;
    region: Region | null;
    downsample: 1 | 2 | 4 | 8;
    progressionTarget: "header" | "dc" | "pass" | "final";
    emitEveryPass: boolean;
    progressiveDetail?: "dc" | "lastPasses" | "passes" | "dcProgressive";
    suppressDuplicateProgress?: boolean;
    preserveIcc: boolean;
    preserveMetadata: boolean;
    targetWidth?: number | null;
    targetHeight?: number | null;
    fitMode?: "contain" | "cover" | "stretch" | null;
    onMetric?: (name: string, value: number) => void;
  }): BrowserDecoder;
  createEncoder(options: {
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
    progressiveDc?: 0 | 1 | 2;
    progressiveAc?: 0 | 1 | 2;
    qProgressiveAc?: 0 | 1 | 2;
    groupOrder?: 0 | 1;
    previewFirst: boolean;
    chunked: boolean;
    sidecarSizes?: readonly number[];
    orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
    centerX?: number;
    centerY?: number;
    intrinsicSize?: { width: number; height: number };
    disablePerceptualHeuristics?: boolean;
    codestreamLevel?: -1 | 5 | 10;
    copyInput?: boolean;
  }): BrowserEncoder;
}

export interface WasmLoaderOptions {
  fetchImpl?: typeof fetch;
  importWasm?: () => Promise<unknown>;
}

/**
 * Loads the codec facade from the sibling jxl-wasm package (via importWasm or
 * defaultImportWasm URL-relative + bare fallback).
 * `wasmUrl` is used only for failure diagnostics; the module itself is resolved via `importWasm`/sibling-package import.
 *
 * Note (W-7): loadWasmModule is invoked exactly once per worker under normal operation
 * (see getWasm singleton + wasmLoadPromise in worker.ts; only reset on error for retry).
 * Memoization deliberately omitted here.
 */
export async function loadWasmModule(wasmUrl: string, options: WasmLoaderOptions = {}): Promise<JxlModule> {
  const imported = await (options.importWasm ?? defaultImportWasm)();
  forceWorkerSafeTier(imported);
  const facade = resolveJxlModule(imported);
  if (facade !== null) return facade;

  // The dynamic import returned null or a module without the expected exports.
  // Probe the WASM URL to give a more actionable diagnostic (missing build
  // artifact vs. module that loaded but lacks createDecoder/createEncoder).
  // Only attempt the probe when a custom fetchImpl is provided or fetch is
  // available in this context; the result is used for the error message only.
  let probeStatus: number | null = null;
  try {
    const fetchImpl = options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : null);
    if (fetchImpl !== null) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5_000);
      try {
        let resp = await fetchImpl(wasmUrl, { method: "HEAD", signal: ac.signal });
        if (resp.status === 405) { resp = await fetchImpl(wasmUrl, { signal: ac.signal }); await resp.body?.cancel(); }
        probeStatus = resp.status;
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    // Probe failure is non-fatal; we still throw the primary error below.
  }

  if (probeStatus !== null && probeStatus !== 200) {
    throw new Error(
      `[jxl-worker-browser] WASM not available at ${wasmUrl} (${probeStatus}). ` +
        "T-WASM-BUILD artifact required.",
    );
  }

  throw new Error(
    "[jxl-worker-browser] @casabio/jxl-wasm does not expose a codec facade. " +
      "T-WASM-BUILD must export createDecoder/createEncoder.",
  );
}

async function defaultImportWasm(): Promise<unknown> {
  // Workers do not reliably inherit the page import map, so resolve the sibling
  // package by URL before falling back to the package specifier for bundled use.
  const packageUrl = new URL("../../jxl-wasm/dist/index.js", import.meta.url).href;
  return await import(packageUrl).catch(async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - module may be absent until local packages are installed
    return await import("@casabio/jxl-wasm").catch(() => null) as unknown;
  }) as unknown;
}

function resolveJxlModule(value: unknown): JxlModule | null {
  if (isJxlModule(value)) return value;
  if (isRecord(value) && isJxlModule(value["default"])) return value["default"];
  return null;
}

function forceWorkerSafeTier(value: unknown): void {
  const tier = readWorkerTierOverride();
  if (tier === "auto") return;
  const target = isRecord(value) && isRecord(value["default"]) ? value["default"] : value;
  if (!isRecord(target)) return;
  const setForcedTier = target["setForcedTier"];
  if (typeof setForcedTier === "function") {
    setForcedTier(tier);
  } else {
    console.warn("[jxl-worker-browser] facade lacks setForcedTier; tier override ignored");
  }
}

function readWorkerTierOverride(): WorkerTierOverride {
  const search = readWorkerLocationSearch();
  // Default "auto" (not "simd"): investigation of worker.ts (getWasm singleton + detectTier only for ready),
  // pool.ts (MT cost accounting + ST fallback via budget), git log ( "simd" default introduced in
  // progressive commit with force logic; no documented MT-in-worker instability or pthread-nesting
  // reason for pinning default; prior history used re-exports allowing MT when SAB+COI present).
  // Spawn callers that want MT pass ?jxlWorkerTier=... ; absent query now honors the worker's
  // detected tier instead of hard-pinning every default worker to ST simd.
  if (search === "") return "auto";
  const tier = new URLSearchParams(search).get("jxlWorkerTier");
  if (tier === "auto" || tier === "relaxed-simd-mt" || tier === "simd-mt" || tier === "simd" || tier === "scalar") {
    return tier;
  }
  return "auto";
}

function readWorkerLocationSearch(): string {
  const globalSelf = globalThis as typeof globalThis & { self?: { location?: { search?: unknown } } };
  const search = globalSelf.self?.location?.search;
  return typeof search === "string" ? search : "";
}

function isJxlModule(value: unknown): value is JxlModule {
  return isRecord(value) && typeof value["createDecoder"] === "function" && typeof value["createEncoder"] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
