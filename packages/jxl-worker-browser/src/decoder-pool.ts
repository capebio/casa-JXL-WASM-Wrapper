// Decoder pool: reuse WASM JxlDecoder instances across sessions.
// Pools decoders by configuration hash to amortize init overhead (~10-50ms).
// Idle decoders are recycled after IDLE_TIMEOUT_MS.

import type { BrowserDecoder, JxlModule } from "./wasm-loader.js";

// Pool-compatible subset of decoder options for key matching
interface PoolableDecoderOpts {
  format: string;
  region?: { x: number; y: number; w: number; h: number } | null;
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

const IDLE_TIMEOUT_MS = 5000; // 5 second idle threshold before pool eviction
const MAX_POOL_SIZE = 4; // Max decoders to keep alive simultaneously

interface PooledDecoder {
  decoder: BrowserDecoder;
  configHash: string;
  lastUsedMs: number;
}

export class DecoderPool {
  private pool: Map<string, PooledDecoder> = new Map();
  private module: JxlModule;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(module: JxlModule) {
    this.module = module;
  }

  /**
   * Hash decoder options for pool key matching.
   * Returns stable string for identical configurations.
   */
  private hashConfig(opts: PoolableDecoderOpts): string {
    const key = {
      format: opts.format,
      downsample: opts.downsample ?? 1,
      progressionTarget: opts.progressionTarget ?? "final",
      emitEveryPass: opts.emitEveryPass ?? true,
      progressiveDetail: opts.progressiveDetail ?? null,
      suppressDuplicateProgress: opts.suppressDuplicateProgress ?? false,
      preserveIcc: opts.preserveIcc ?? true,
      preserveMetadata: opts.preserveMetadata ?? true,
      fitMode: opts.fitMode ?? null,
      // region, targetWidth/Height excluded — too specific, don't pool on them
    };
    return JSON.stringify(key);
  }

  /**
   * Acquire a decoder from pool if available, else create new.
   * Removes decoder from pool (caller takes ownership).
   */
  acquire(opts: PoolableDecoderOpts): BrowserDecoder {
    const hash = this.hashConfig(opts);
    const pooled = this.pool.get(hash);

    if (pooled !== undefined) {
      this.pool.delete(hash);
      return pooled.decoder;
    }

    // Create fresh decoder (pass through full opts as-is, casting as needed)
    return this.module.createDecoder(opts as any);
  }

  /**
   * Return decoder to pool for potential reuse.
   * If pool is full or decoder is incompatible, it is disposed instead.
   */
  async release(decoder: BrowserDecoder, opts: PoolableDecoderOpts): Promise<void> {
    const hash = this.hashConfig(opts);

    // Pool full: dispose instead of storing
    if (this.pool.size >= MAX_POOL_SIZE) {
      const disposeResult = decoder.dispose();
      if (disposeResult instanceof Promise) {
        await disposeResult;
      }
      return;
    }

    // Store in pool
    this.pool.set(hash, {
      decoder,
      configHash: hash,
      lastUsedMs: Date.now(),
    });

    // Arm cleanup timer if not already running
    this.scheduleCleanup();
  }

  /**
   * Dispose all pooled decoders and clear pool.
   * Called on worker shutdown.
   */
  async dispose(): Promise<void> {
    if (this.cleanupTimer !== null) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const disposed: Promise<void>[] = [];
    for (const pooled of this.pool.values()) {
      const disposeResult = pooled.decoder.dispose();
      if (disposeResult instanceof Promise) {
        disposed.push(disposeResult.catch(() => {})); // Suppress errors during shutdown
      }
    }
    this.pool.clear();
    await Promise.all(disposed);
  }

  /**
   * Evict idle decoders from pool.
   * Called periodically to free memory.
   */
  private evictIdle(): void {
    const now = Date.now();
    const toEvict: string[] = [];

    for (const [hash, pooled] of this.pool.entries()) {
      if (now - pooled.lastUsedMs > IDLE_TIMEOUT_MS) {
        toEvict.push(hash);
      }
    }

    toEvict.forEach((hash) => {
      const pooled = this.pool.get(hash);
      if (pooled !== undefined) {
        this.pool.delete(hash);
        const disposeResult = pooled.decoder.dispose();
        if (disposeResult instanceof Promise) {
          disposeResult.catch(() => {}); // Suppress errors
        }
      }
    });
  }

  private scheduleCleanup(): void {
    // Only schedule if not already running
    if (this.cleanupTimer === null) {
      this.cleanupTimer = setTimeout(() => {
        this.cleanupTimer = null;
        this.evictIdle();
        // Re-schedule if pool still has items
        if (this.pool.size > 0) {
          this.scheduleCleanup();
        }
      }, IDLE_TIMEOUT_MS);
    }
  }

  /**
   * Return pool statistics for monitoring.
   */
  stats(): { poolSize: number; configHashes: string[] } {
    return {
      poolSize: this.pool.size,
      configHashes: Array.from(this.pool.keys()),
    };
  }
}
