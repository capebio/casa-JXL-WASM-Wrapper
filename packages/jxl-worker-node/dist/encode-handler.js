// jxl-worker-node/src/encode-handler.ts
// Encode session handler for node:worker_threads.
// Drives the selected native/WASM backend facade.
const CHUNK_HWM = 4;
const CHUNK_MAX_BUFFERED = 32;
const MAX_QUEUED_BYTES = 128 * 1024 * 1024;
const DRAIN_MIN_INTERVAL_MS = 8;
const HWM_EMA_ALPHA = 0.25;
export class EncodeHandler {
    sessionId;
    opts;
    backend;
    port;
    callbacks;
    state = "created";
    pixelQueue = [];
    pixelReadIndex = 0;
    queueDepth = 0;
    queuedBytes = 0;
    cancelled = false;
    finished = false;
    ended = false;
    firstByteEmitted = false;
    wakeResolve = null;
    lastDrainPostedMs = 0;
    lastDrainAllowed = false;
    encoder = null;
    disposePromise = null;
    stageStartMs = performance.now();
    pushLatencyEma = 0;
    constructor(opts, backend, callbacks) {
        this.sessionId = opts.sessionId;
        this.opts = opts;
        this.backend = backend;
        this.port = callbacks.port;
        this.callbacks = callbacks;
        this.run().catch((err) => this.failSession("Internal", String(err)));
    }
    onPixels(chunk, region) {
        if (this.finished ||
            this.cancelled ||
            this.state === "done" ||
            this.state === "error" ||
            this.state === "cancelled")
            return;
        if (this.queueDepth >= CHUNK_MAX_BUFFERED) {
            this.failSession("BackpressureOverflow", `Encode input queue exceeded ${CHUNK_MAX_BUFFERED} buffered chunks`);
            return;
        }
        if (this.queuedBytes + chunk.byteLength > MAX_QUEUED_BYTES) {
            this.failSession("QueueOverflow", `Encode input queue exceeded ${MAX_QUEUED_BYTES >> 20} MiB`);
            return;
        }
        const buf = Buffer.from(chunk instanceof ArrayBuffer ? chunk : chunk.buffer, chunk instanceof ArrayBuffer ? 0 : chunk.byteOffset, chunk instanceof ArrayBuffer ? chunk.byteLength : chunk.byteLength);
        const entry = { chunk: buf };
        if (region !== undefined)
            entry.region = region;
        this.pixelQueue.push(entry);
        this.queueDepth++;
        this.queuedBytes += buf.byteLength;
        this.wake();
    }
    onFinish() {
        if (this.finished ||
            this.cancelled ||
            this.state === "done" ||
            this.state === "error" ||
            this.state === "cancelled")
            return;
        this.finished = true;
        this.wake();
    }
    async onCancel(reason) {
        if (this.cancelled || this.state === "done" || this.state === "error")
            return;
        this.cancelled = true;
        this.state = "cancelled";
        this.wake();
        if (reason !== "release_state") {
            const msg = { type: "encode_cancelled", sessionId: this.sessionId };
            this.port.postMessage(msg);
        }
        this.endSessionOnce();
        void this.disposeActiveEncoder(reason, true);
    }
    async run() {
        const codec = this.backend.module;
        const encOpts = {
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
            previewFirst: this.opts.previewFirst,
            chunked: this.opts.chunked,
            ...(this.opts.progressiveDc != null ? { progressiveDc: this.opts.progressiveDc } : {}),
            ...(this.opts.progressiveAc != null ? { progressiveAc: this.opts.progressiveAc } : {}),
            ...(this.opts.qProgressiveAc != null ? { qProgressiveAc: this.opts.qProgressiveAc } : {}),
            ...(this.opts.groupOrder != null ? { groupOrder: this.opts.groupOrder } : {}),
        };
        const encoder = codec.createEncoder(encOpts);
        this.encoder = encoder;
        this.state = "configured";
        try {
            await Promise.all([this.feedEncoder(encoder), this.readEncoderChunks(encoder)]);
        }
        finally {
            await this.disposeActiveEncoder();
        }
    }
    wake() {
        const resolve = this.wakeResolve;
        if (resolve === null)
            return;
        this.wakeResolve = null;
        resolve();
    }
    endSessionOnce() {
        if (this.ended)
            return;
        this.ended = true;
        this.clearPixelQueue();
        this.callbacks.onSessionEnd(this.sessionId);
    }
    clearPixelQueue() {
        this.pixelQueue.length = 0;
        this.pixelReadIndex = 0;
        this.queueDepth = 0;
        this.queuedBytes = 0;
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
                catch {
                    // Best-effort cleanup.
                }
            }
            try {
                await encoder.dispose();
            }
            catch {
                // Best-effort cleanup.
            }
        })();
        return this.disposePromise;
    }
    waitForPixels() {
        if (this.pixelQueue.length > this.pixelReadIndex || this.finished || this.cancelled
            || this.state === "done" || this.isErrored()) {
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
        while (!this.cancelled && this.state !== "done" && !this.isErrored()) {
            const wait0 = performance.now();
            await this.waitForPixels();
            const waitMs = performance.now() - wait0;
            // simple accum for profile (node already has ema for push)
            // could postMetric("encode_wait_pixels_ms", waitMs) here if wanted per-wait
            while (this.pixelQueue.length > this.pixelReadIndex) {
                const entry = this.takeNextPixels();
                if (entry === null)
                    break;
                if (this.cancelled || this.isErrored())
                    return;
                const t0 = performance.now();
                await encoder.pushPixels(entry.chunk, entry.region);
                const pushMs = performance.now() - t0;
                this.pushLatencyEma = HWM_EMA_ALPHA * pushMs + (1 - HWM_EMA_ALPHA) * this.pushLatencyEma;
                if (this.cancelled || this.isErrored())
                    return;
                this.maybePostDrain();
            }
            if (this.finished) {
                if (this.cancelled || this.isErrored())
                    return;
                this.state = "finalising";
                const fin0 = performance.now();
                await encoder.finish();
                const finMs = performance.now() - fin0;
                this.postMetric("encode_finish_ms", finMs);
                return;
            }
        }
    }
    maybePostDrain() {
        const drainAllowed = this.queueDepth < CHUNK_HWM;
        const crossedIntoDrain = drainAllowed && !this.lastDrainAllowed;
        this.lastDrainAllowed = drainAllowed;
        if (!drainAllowed)
            return;
        const now = performance.now();
        const intervalElapsed = now - this.lastDrainPostedMs >= DRAIN_MIN_INTERVAL_MS;
        if (!crossedIntoDrain && !intervalElapsed)
            return;
        this.lastDrainPostedMs = now;
        this.port.postMessage({
            type: "worker_drain",
            sessionId: this.sessionId,
            latencyMs: Math.round(this.pushLatencyEma),
            queueDepth: this.queueDepth,
            queuedBytes: this.queuedBytes,
            adaptiveHwm: CHUNK_HWM,
        });
    }
    isErrored() {
        return this.state === "error";
    }
    postChunk(msg, chunk) {
        const ab = chunk.buffer;
        if (chunk.byteOffset === 0 && chunk.byteLength === ab.byteLength) {
            this.port.postMessage(msg, [ab]);
        }
        else {
            const exact = ab.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
            msg.chunk = exact;
            this.port.postMessage(msg, [exact]);
        }
    }
    postMetric(name, value) {
        this.port.postMessage({
            type: "metric",
            sessionId: this.sessionId,
            metric: { name, value },
        });
    }
    async readEncoderChunks(encoder) {
        let totalBytes = 0;
        let chunkIndex = 0;
        const sidecarCount = this.opts.sidecarSizes?.length ?? 0;
        const sidecarOffsets = [];
        for await (const chunk of encoder.chunks()) {
            if (this.cancelled || this.state === "done" || this.state === "error")
                return;
            const buffer = toBuffer(chunk);
            if (!this.firstByteEmitted) {
                this.firstByteEmitted = true;
                this.state = "streaming";
                this.postMetric("time_to_first_byte_ms", performance.now() - this.stageStartMs);
                const msg = {
                    type: "encode_first_byte_ready",
                    sessionId: this.sessionId,
                };
                this.port.postMessage(msg);
            }
            totalBytes += buffer.byteLength;
            if (chunkIndex < sidecarCount) {
                sidecarOffsets.push(totalBytes);
            }
            chunkIndex++;
            const msg = {
                type: "encode_chunk",
                sessionId: this.sessionId,
                chunk: buffer,
            };
            this.postChunk(msg, buffer);
        }
        if (this.cancelled || this.state === "done" || this.state === "error")
            return;
        this.state = "done";
        this.postMetric("output_bytes", totalBytes);
        this.postMetric("encode_total_ms", performance.now() - this.stageStartMs);
        const doneMsg = {
            type: "encode_done",
            sessionId: this.sessionId,
            totalBytes,
            ...(sidecarOffsets.length > 0 ? { sidecarOffsets } : {}),
        };
        this.port.postMessage(doneMsg);
        this.endSessionOnce();
    }
    failSession(code, message) {
        if (this.cancelled || this.state === "done" || this.state === "error")
            return;
        this.state = "error";
        // Unblock feedEncoder if it's sleeping in waitForPixels — mirrors browser handler.
        this.wake();
        const msg = { type: "encode_error", sessionId: this.sessionId, code, message };
        this.port.postMessage(msg);
        this.endSessionOnce();
        void this.disposeActiveEncoder();
    }
}
function toBuffer(value) {
    if (Buffer.isBuffer(value))
        return value;
    if (value instanceof ArrayBuffer)
        return Buffer.from(value);
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
//# sourceMappingURL=encode-handler.js.map