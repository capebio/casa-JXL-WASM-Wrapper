// Decoder pool: reuse WASM JxlDecoder instances across sessions.
// Pools decoders by configuration hash to amortize init overhead (~10-50ms).
// Idle decoders are recycled after IDLE_TIMEOUT_MS.
const IDLE_TIMEOUT_MS = 5000; // 5 second idle threshold before pool eviction
const MAX_POOL_SIZE = 4; // Max decoders to keep alive simultaneously
export class DecoderPool {
    pool = new Map();
    module;
    cleanupTimer = null;
    constructor(module) {
        this.module = module;
    }
    /**
     * Hash decoder options for pool key matching.
     * Returns stable string for identical configurations.
     */
    hashConfig(opts) {
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
    acquire(opts) {
        const hash = this.hashConfig(opts);
        const pooled = this.pool.get(hash);
        if (pooled !== undefined) {
            this.pool.delete(hash);
            return pooled.decoder;
        }
        // Create fresh decoder (pass through full opts as-is, casting as needed)
        return this.module.createDecoder(opts);
    }
    /**
     * Return decoder to pool for potential reuse.
     * If pool is full or decoder is incompatible, it is disposed instead.
     */
    async release(decoder, opts) {
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
    async dispose() {
        if (this.cleanupTimer !== null) {
            clearTimeout(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        const disposed = [];
        for (const pooled of this.pool.values()) {
            const disposeResult = pooled.decoder.dispose();
            if (disposeResult instanceof Promise) {
                disposed.push(disposeResult.catch(() => { })); // Suppress errors during shutdown
            }
        }
        this.pool.clear();
        await Promise.all(disposed);
    }
    /**
     * Evict idle decoders from pool.
     * Called periodically to free memory.
     */
    evictIdle() {
        const now = Date.now();
        const toEvict = [];
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
                    disposeResult.catch(() => { }); // Suppress errors
                }
            }
        });
    }
    scheduleCleanup() {
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
    stats() {
        return {
            poolSize: this.pool.size,
            configHashes: Array.from(this.pool.keys()),
        };
    }
}
//# sourceMappingURL=decoder-pool.js.map