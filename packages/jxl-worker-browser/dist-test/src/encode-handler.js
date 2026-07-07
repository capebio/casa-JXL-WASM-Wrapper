// jxl-worker-browser/src/encode-handler.ts
// Encode session handler. Owns one libjxl encoder instance per session.
// Spec: Sections 11, 16.2.
//
// Drives the WASM codec facade; generated libjxl adapter lands with T-WASM-BUILD.
const CHUNK_HWM = 4;
const DRAIN_MIN_INTERVAL_MS = 8;
const FINISH_TIMEOUT_MS = 30_000;
const MAX_QUEUED_BYTES = 128 * 1024 * 1024;
// EMA smoothing for push-latency (mirrors decode-handler HWM_EMA_ALPHA).
const PUSH_EMA_ALPHA = 0.25;
// Byte-level secondary drain gate — mirrors decode-handler BYTE_DRAIN_HWM so
// multi-MB pixel chunks apply byte backpressure even when queueDepth is low.
const BYTE_DRAIN_HWM = 2 * 1024 * 1024; // 2 MiB
export class EncodeHandler {
    sessionId;
    opts;
    wasm;
    callbacks;
    state = "created";
    pixelQueue = [];
    pixelReadIndex = 0;
    queueDepth = 0;
    queuedBytes = 0;
    cancelled = false;
    finished = false;
    sessionEnded = false;
    firstByteEmitted = false;
    wakeResolve = null;
    lastDrainPostedMs = 0;
    lastDrainAllowed = false;
    // EMA of encoder.pushPixels() latency (ms); reported as worker_drain.latencyMs.
    pushLatencyEma = 0;
    // Set true once summary metrics have been posted (just before the terminal
    // message) so the run() finally never double-posts droppable metrics.
    finalMetricsPosted = false;
    encoder = null;
    disposePromise = null;
    // Profiling hooks (accumulated, posted as metrics at key points + end)
    stageStartMs = performance.now();
    createEncoderMs = 0;
    totalWaitForPixelsMs = 0;
    totalPushPixelsMs = 0;
    finishMs = 0;
    totalChunkYieldMs = 0;
    firstByteMs = 0;
    lastPushStart = 0;
    // Pre-allocated message objects — mutated in-place before postMessage (safe: structured clone is synchronous).
    _drainMsg = {
        type: "worker_drain",
        sessionId: "",
        latencyMs: 0,
        queueDepth: 0,
        queuedBytes: 0,
        adaptiveHwm: CHUNK_HWM,
    };
    _chunkMsg = {
        type: "encode_chunk",
        sessionId: "",
        chunk: new ArrayBuffer(0),
    };
    constructor(opts, wasm, callbacks) {
        this.sessionId = opts.sessionId;
        this.opts = opts;
        this.wasm = wasm;
        this.callbacks = callbacks;
        this._drainMsg.sessionId = this.sessionId;
        this._chunkMsg.sessionId = this.sessionId;
        this.run().catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            this.failSession("Internal", message);
        });
    }
    // ---------------------------------------------------------------------------
    // Incoming message handlers
    // ---------------------------------------------------------------------------
    onPixels(chunk, region) {
        if (this.isTerminal() || this.finished)
            return;
        if (this.queuedBytes + chunk.byteLength > MAX_QUEUED_BYTES) {
            this.failSession("QueueOverflow", `Encode input queue exceeded ${MAX_QUEUED_BYTES >> 20} MiB`);
            return;
        }
        const entry = region !== undefined ? { chunk, region } : { chunk };
        this.pixelQueue.push(entry);
        this.queueDepth++;
        this.queuedBytes += chunk.byteLength;
        this.wake();
    }
    onFinish() {
        if (this.isTerminal() || this.finished)
            return;
        this.finished = true;
        this.wake();
    }
    async onCancel(reason) {
        if (this.sessionEnded || this.cancelled)
            return;
        this.cancelled = true;
        if (reason !== "release_state") {
            const msg = {
                type: "encode_cancelled",
                sessionId: this.sessionId,
            };
            self.postMessage(msg);
        }
        this.finishSession("cancelled");
        void this.disposeActiveEncoder(reason, true);
    }
    // ---------------------------------------------------------------------------
    // Main encode loop
    // ---------------------------------------------------------------------------
    async run() {
        // Cast to unknown first to allow passing progressiveFlavor which is not yet
        // declared in the JxlModule.createEncoder interface in wasm-loader.ts.
        const encoderOpts = {
            format: this.opts.format,
            width: this.opts.width,
            height: this.opts.height,
            hasAlpha: this.opts.hasAlpha,
            iccProfile: this.opts.iccProfile,
            exif: this.opts.exif,
            xmp: this.opts.xmp,
            distance: this.opts.distance,
            quality: this.opts.quality,
            effort: this.opts.effort,
            progressive: this.opts.progressive,
            // progressiveFlavor is present in protocol.ts but missing from the stale
            // node_modules copy of jxl-core — cast to access it safely.
            progressiveFlavor: this.opts.progressiveFlavor,
            previewFirst: this.opts.previewFirst,
            // progressiveDc + groupOrder (predator progressive layers + Tauri parity): forwarded so high-level session.encode
            // can produce files with >1 DC layer and center-out for the gallery/paint benchmarks and Tauri parity.
            progressiveDc: this.opts.progressiveDc,
            progressiveAc: this.opts.progressiveAc,
            qProgressiveAc: this.opts.qProgressiveAc,
            groupOrder: this.opts.groupOrder,
            chunked: this.opts.chunked,
            sidecarSizes: this.opts.sidecarSizes,
            // EXIF orientation (1..8). When set, JXL records rotation as metadata instead of rotating pixels.
            orientation: this.opts.orientation,
            centerX: this.opts.centerX,
            centerY: this.opts.centerY,
            intrinsicSize: this.opts.intrinsicSize,
            disablePerceptualHeuristics: this.opts.disablePerceptualHeuristics,
            codestreamLevel: this.opts.codestreamLevel,
            // Advanced density knobs the facade EncoderOptions honors directly (K6#2).
            // Previously dropped at this boundary despite being on the wire. The other
            // advanced wire fields (buffering, alreadyDownsampled, upsamplingMode,
            // ecResampling, frameIndexing, allowExpertOptions, advancedControls,
            // jpegReconstruction) need lower-level create_image_* plumbing not exposed by
            // the high-level facade encoder — carried on the wire for future consumers.
            modular: this.opts.modular,
            brotliEffort: this.opts.brotliEffort,
            decodingSpeed: this.opts.decodingSpeed,
            photonNoiseIso: this.opts.photonNoiseIso,
            copyInput: false,
        };
        const tCreate0 = performance.now();
        const encoder = this.wasm.createEncoder(encoderOpts);
        this.createEncoderMs = performance.now() - tCreate0;
        // encode_create_ms is posted once via postFinalMetrics() before the terminal
        // message (was previously double-posted here and in the final summary).
        this.encoder = encoder;
        this.state = "configured";
        try {
            await Promise.all([this.feedEncoder(encoder), this.readEncoderChunks(encoder)]);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.failSession("Internal", message);
        }
        finally {
            await this.disposeActiveEncoder();
            this.finishSession(this.state);
            // Cleanup only. Summary metrics are posted by postFinalMetrics() BEFORE the
            // terminal message (encode_done / encode_error). The scheduler deletes the
            // session on the terminal message, so anything posted here would be dropped.
            // Skip on the cancel path (encode_cancelled already terminated the session);
            // otherwise post idempotently to cover the rare throw-before-any-terminal edge
            // (finalMetricsPosted makes the normal done/error paths a no-op here).
            if (!this.cancelled)
                this.postFinalMetrics();
        }
    }
    // Posts the accumulated summary metrics exactly once. Must be called BEFORE the
    // terminal message (encode_done / encode_error) — the scheduler treats those as
    // terminal and drops any metric that arrives afterwards.
    postFinalMetrics() {
        if (this.finalMetricsPosted)
            return;
        this.finalMetricsPosted = true;
        const total = performance.now() - this.stageStartMs;
        this.postMetric("encode_total_ms", total);
        this.postMetric("encode_create_ms", this.createEncoderMs);
        this.postMetric("encode_push_pixels_ms", this.totalPushPixelsMs);
        this.postMetric("encode_wait_pixels_ms", this.totalWaitForPixelsMs);
        this.postMetric("encode_finish_ms", this.finishMs);
        this.postMetric("encode_chunk_yield_ms", this.totalChunkYieldMs);
        // encode_time_to_first_byte_ms is posted live (once) when the first chunk is
        // emitted in readEncoderChunks; not re-posted here to avoid a duplicate.
    }
    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------
    finishSession(state) {
        if (this.sessionEnded)
            return false;
        this.state = state;
        this.sessionEnded = true;
        this.clearPixelQueue();
        this.wake();
        this.callbacks.onSessionEnd(this.sessionId);
        return true;
    }
    isTerminal() {
        return this.sessionEnded;
    }
    clearPixelQueue() {
        this.pixelQueue.length = 0;
        this.pixelReadIndex = 0;
        this.queueDepth = 0;
        this.queuedBytes = 0;
    }
    wake() {
        const resolve = this.wakeResolve;
        if (resolve !== null) {
            this.wakeResolve = null;
            resolve();
        }
    }
    disposeActiveEncoder(reason, cancelFirst = false) {
        if (this.disposePromise !== null)
            return this.disposePromise;
        const encoder = this.encoder;
        if (encoder === null)
            return Promise.resolve();
        this.encoder = null;
        this.disposePromise = (async () => {
            if (cancelFirst) {
                try {
                    await encoder.cancel(reason);
                }
                catch (e) {
                    console.error("[jxl-worker] encoder.cancel failed:", e);
                }
            }
            try {
                await encoder.dispose();
            }
            catch (e) {
                console.error("[jxl-worker] encoder.dispose failed:", e);
            }
        })();
        return this.disposePromise;
    }
    waitForPixels() {
        if (this.pixelQueue.length > this.pixelReadIndex || this.finished || this.isTerminal()) {
            return Promise.resolve();
        }
        return new Promise((resolve) => { this.wakeResolve = resolve; });
    }
    takeNextPixels() {
        const entry = this.pixelQueue[this.pixelReadIndex];
        this.pixelQueue[this.pixelReadIndex++] = undefined;
        if (entry === undefined) {
            this.compactQueue();
            return null;
        }
        this.queueDepth--;
        this.queuedBytes -= entry.chunk.byteLength;
        this.compactQueue();
        return entry;
    }
    compactQueue() {
        if (this.pixelReadIndex >= this.pixelQueue.length) {
            this.pixelQueue.length = 0;
            this.pixelReadIndex = 0;
        }
        else if (this.pixelReadIndex > 64 && this.pixelReadIndex * 2 > this.pixelQueue.length) {
            this.pixelQueue.copyWithin(0, this.pixelReadIndex);
            this.pixelQueue.length -= this.pixelReadIndex;
            this.pixelReadIndex = 0;
        }
    }
    async feedEncoder(encoder) {
        while (!this.isTerminal()) {
            const waitStart = performance.now();
            await this.waitForPixels();
            this.totalWaitForPixelsMs += performance.now() - waitStart;
            while (this.pixelQueue.length > this.pixelReadIndex) {
                const entry = this.takeNextPixels();
                if (entry === null)
                    break;
                const pushStart = performance.now();
                await encoder.pushPixels(entry.chunk, entry.region);
                const pushMs = performance.now() - pushStart;
                this.totalPushPixelsMs += pushMs;
                // EMA of push latency feeds worker_drain.latencyMs (mirrors decode handler).
                this.pushLatencyEma = PUSH_EMA_ALPHA * pushMs + (1 - PUSH_EMA_ALPHA) * this.pushLatencyEma;
                // Re-check state after async pushPixels — cancellation or error may have arrived.
                // Cast through string to defeat TypeScript's pre-await control-flow narrowing.
                if (this.isTerminal())
                    return;
                this.maybePostDrain();
            }
            if (this.finished) {
                // Re-check state before calling finish — guard against race with onCancel.
                if (this.isTerminal())
                    return;
                this.state = "finalising";
                const finStart = performance.now();
                // Race finish() against a 30 s timeout. On timeout: (a) cancel the still-
                // running native encoder so it stops working (mirrors onCancel's cancelFirst),
                // and (b) attach a no-op .catch to the losing finish() promise so a later
                // rejection does not surface as a spurious global worker_error. Clear the
                // timer on the winning path to avoid a dangling timeout.
                let finishTimer;
                // finish() may return void or Promise<void>; normalise so we can attach a
                // no-op .catch to the losing promise on the timeout path.
                const finishPromise = Promise.resolve(encoder.finish());
                try {
                    await Promise.race([
                        finishPromise,
                        new Promise((_, reject) => {
                            finishTimer = setTimeout(() => reject(new Error("encoder.finish() timed out after 30 s")), FINISH_TIMEOUT_MS);
                        }),
                    ]);
                }
                catch (err) {
                    // The timeout (or finish itself) rejected. Cancel + dispose the encoder so
                    // the native side stops, and swallow the orphaned finish() rejection.
                    finishPromise.catch(() => { });
                    void this.disposeActiveEncoder(undefined, true);
                    throw err;
                }
                finally {
                    if (finishTimer !== undefined)
                        clearTimeout(finishTimer);
                }
                this.finishMs = performance.now() - finStart;
                // encode_finish_ms is posted once via postFinalMetrics() before the terminal
                // message (was previously double-posted here and in the final summary).
                return;
            }
        }
    }
    maybePostDrain() {
        const now = performance.now();
        // Byte-level secondary gate (mirrors decode-handler): multi-MB pixel chunks
        // apply byte backpressure even when the chunk count is below CHUNK_HWM.
        const drainAllowed = this.queueDepth < CHUNK_HWM && this.queuedBytes < BYTE_DRAIN_HWM;
        const crossedIntoDrain = drainAllowed && !this.lastDrainAllowed;
        const intervalElapsed = now - this.lastDrainPostedMs >= DRAIN_MIN_INTERVAL_MS;
        this.lastDrainAllowed = drainAllowed;
        if (!drainAllowed)
            return;
        if (!crossedIntoDrain && !intervalElapsed)
            return;
        this.lastDrainPostedMs = now;
        this._drainMsg.latencyMs = Math.round(this.pushLatencyEma);
        this._drainMsg.queueDepth = this.queueDepth;
        this._drainMsg.queuedBytes = this.queuedBytes;
        self.postMessage(this._drainMsg);
    }
    postMetric(name, value) {
        self.postMessage({
            type: "metric",
            sessionId: this.sessionId,
            metric: { name, value },
        });
    }
    async readEncoderChunks(encoder) {
        let totalBytes = 0;
        const sidecarCount = this.opts.sidecarSizes?.length ?? 0;
        const sidecarOffsets = [];
        let chunkIndex = 0;
        for await (const chunk of encoder.chunks()) {
            if (this.isTerminal())
                return;
            const tChunk0 = performance.now();
            const buffer = toArrayBuffer(chunk);
            const chunkYieldMs = performance.now() - tChunk0;
            this.totalChunkYieldMs += chunkYieldMs;
            if (!this.firstByteEmitted) {
                this.firstByteEmitted = true;
                this.firstByteMs = performance.now() - this.stageStartMs;
                this.postMetric("encode_time_to_first_byte_ms", this.firstByteMs);
                const firstByteMsg = {
                    type: "encode_first_byte_ready",
                    sessionId: this.sessionId,
                };
                self.postMessage(firstByteMsg);
            }
            totalBytes += buffer.byteLength;
            // Track cumulative byte position at each sidecar boundary.
            // Sidecar chunks are yielded first (one per sidecar), before the main image.
            if (chunkIndex < sidecarCount) {
                sidecarOffsets.push(totalBytes);
            }
            chunkIndex++;
            this._chunkMsg.chunk = buffer;
            this.state = "streaming";
            self.postMessage(this._chunkMsg, [buffer]);
        }
        if (this.isTerminal())
            return;
        this.state = "done";
        this.postMetric("encode_chunk_yield_total_ms", this.totalChunkYieldMs);
        this.postMetric("encode_output_bytes", totalBytes);
        // Post the summary metrics BEFORE the terminal encode_done. The scheduler
        // treats encode_done as terminal and deletes the session, dropping any metric
        // that arrives afterwards (this is why postFinalMetrics() used to be a no-op
        // when invoked from run()'s finally). Mirrors the decode handler folding its
        // final metrics onto / just before decode_final.
        this.postFinalMetrics();
        // Validate the chunk↔sidecar mapping. Protocol contract (types.ts): the leading
        // sidecarSizes.length chunks are the thumbnails — exactly one chunk per sidecar.
        // If the codec yielded a different number of pre-image chunks the recorded
        // boundaries would be wrong, so drop sidecarOffsets rather than emit bad offsets.
        const sidecarOffsetsValid = sidecarOffsets.length === sidecarCount;
        if (!sidecarOffsetsValid && sidecarCount > 0) {
            console.warn(`[jxl-worker] sidecar offset count ${sidecarOffsets.length} != sidecarSizes ${sidecarCount}; dropping sidecarOffsets`);
        }
        const doneMsg = {
            type: "encode_done",
            sessionId: this.sessionId,
            totalBytes,
            ...(sidecarOffsetsValid && sidecarOffsets.length > 0 ? { sidecarOffsets } : {}),
        };
        self.postMessage(doneMsg);
        this.finishSession("done");
    }
    failSession(code, message) {
        if (this.isTerminal())
            return;
        // Post the accumulated summary metrics before the terminal encode_error — the
        // scheduler drops metrics arriving after a terminal message (idempotent: a no-op
        // if already posted before encode_done).
        this.postFinalMetrics();
        const msg = {
            type: "encode_error",
            sessionId: this.sessionId,
            code,
            message,
        };
        self.postMessage(msg);
        this.finishSession("error");
        void this.disposeActiveEncoder();
    }
}
function toArrayBuffer(value) {
    if (value instanceof ArrayBuffer)
        return value;
    return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
        ? value.buffer
        : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}
//# sourceMappingURL=encode-handler.js.map