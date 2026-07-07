import type { BrowserDecoder, JxlModule } from "./wasm-loader.js";
interface PoolableDecoderOpts {
    format: string;
    region?: {
        x: number;
        y: number;
        w: number;
        h: number;
    } | null;
    downsample?: number;
    progressionTarget?: string;
    emitEveryPass?: boolean;
    progressiveDetail?: string | null | undefined;
    suppressDuplicateProgress?: boolean;
    preserveIcc?: boolean;
    preserveMetadata?: boolean;
    targetWidth?: number | null;
    targetHeight?: number | null;
    fitMode?: "contain" | "cover" | "stretch" | null | undefined;
    onMetric?: (name: string, value: number) => void;
}
export declare class DecoderPool {
    private pool;
    private module;
    private cleanupTimer;
    constructor(module: JxlModule);
    /**
     * Hash decoder options for pool key matching.
     * Returns stable string for identical configurations.
     */
    private hashConfig;
    /**
     * Acquire a decoder from pool if available, else create new.
     * Removes decoder from pool (caller takes ownership).
     */
    acquire(opts: PoolableDecoderOpts): BrowserDecoder;
    /**
     * Return decoder to pool for potential reuse.
     * If pool is full or decoder is incompatible, it is disposed instead.
     */
    release(decoder: BrowserDecoder, opts: PoolableDecoderOpts): Promise<void>;
    /**
     * Dispose all pooled decoders and clear pool.
     * Called on worker shutdown.
     */
    dispose(): Promise<void>;
    /**
     * Evict idle decoders from pool.
     * Called periodically to free memory.
     */
    private evictIdle;
    private scheduleCleanup;
    /**
     * Return pool statistics for monitoring.
     */
    stats(): {
        poolSize: number;
        configHashes: string[];
    };
}
export {};
//# sourceMappingURL=decoder-pool.d.ts.map