import type { DecodeStage, ImageInfo, PixelFormat, Region } from "@casabio/jxl-core/types";
export type Tier = "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";
export declare function detectTier(): Tier;
export type BrowserDecodeEvent = {
    type: "header";
    info: ImageInfo;
} | {
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
} | {
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
} | {
    type: "budget_exceeded";
    stage: DecodeStage;
    info: ImageInfo;
    pixels: ArrayBuffer | Uint8Array;
    format: PixelFormat;
    region?: Region;
    pixelStride: number;
} | {
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
        intrinsicSize?: {
            width: number;
            height: number;
        };
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
export declare function loadWasmModule(wasmUrl: string, options?: WasmLoaderOptions): Promise<JxlModule>;
//# sourceMappingURL=wasm-loader.d.ts.map