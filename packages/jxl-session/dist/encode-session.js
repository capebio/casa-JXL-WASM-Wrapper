// jxl-session/src/encode-session.ts
// EncodeSession implementation. Routes through jxl-scheduler to a worker.
// Spec: Sections 5, 11, 16.2.
import { JxlError } from "@casabio/jxl-core/errors";
import { AsyncEventStream } from "./event-stream.js";
import { deferred, newSessionId, toTransferableBuffer } from "./util.js";
/**
 * Forwards all user-provided EncodeOptions to worker. See encodeOptionsToStartMsg for field mapping.
 *
 * Intentionally omitted from MsgEncodeStart (session-level or caller-side only):
 *   signal, onMetric, modular, brotliEffort, decodingSpeed, photonNoiseIso,
 *   buffering, advancedControls, jpegReconstruction
 *
 * distance/quality defaulting is resolved by the caller before invoking this
 * function (distance defaults to 1.0 when neither is supplied; distance wins
 * when both are supplied).
 */
export function encodeOptionsToStartMsg(sessionId, opts, distance, quality) {
    const msg = {
        type: "encode_start",
        sessionId,
        format: opts.format,
        width: opts.width,
        height: opts.height,
        hasAlpha: opts.hasAlpha,
        iccProfile: opts.iccProfile != null ? toTransferableBuffer(opts.iccProfile) : null,
        exif: opts.exif != null ? toTransferableBuffer(opts.exif) : null,
        xmp: opts.xmp != null ? toTransferableBuffer(opts.xmp) : null,
        distance,
        quality,
        effort: opts.effort ?? 4,
        progressive: opts.progressive ?? false,
        previewFirst: opts.previewFirst ?? false,
        chunked: opts.chunked ?? false,
        priority: opts.priority ?? "visible",
    };
    // Optional fields: assign conditionally to satisfy exactOptionalPropertyTypes
    // (explicit undefined in an object literal is rejected by strict mode).
    if (opts.progressiveDc != null)
        msg.progressiveDc = opts.progressiveDc;
    if (opts.groupOrder != null)
        msg.groupOrder = opts.groupOrder;
    if (opts.progressiveFlavor != null)
        msg.progressiveFlavor = opts.progressiveFlavor;
    if (opts.progressiveAc != null)
        msg.progressiveAc = opts.progressiveAc;
    if (opts.qProgressiveAc != null)
        msg.qProgressiveAc = opts.qProgressiveAc;
    if (opts.sidecarSizes !== undefined)
        msg.sidecarSizes = opts.sidecarSizes;
    if (opts.orientation != null)
        msg.orientation = opts.orientation;
    if (opts.centerX != null)
        msg.centerX = opts.centerX;
    if (opts.centerY != null)
        msg.centerY = opts.centerY;
    if (opts.intrinsicSize != null)
        msg.intrinsicSize = opts.intrinsicSize;
    if (opts.disablePerceptualHeuristics === true)
        msg.disablePerceptualHeuristics = true;
    if (opts.codestreamLevel != null)
        msg.codestreamLevel = opts.codestreamLevel;
    return msg;
}
const KNOWN_JXL_ERROR_CODES = new Set([
    "MalformedCodestream",
    "TruncatedStream",
    "UnsupportedFeature",
    "OutOfMemory",
    "BudgetExceeded",
    "Cancelled",
    "WorkerCrashed",
    "CapabilityMissing",
    "ConfigError",
    "QueueOverflow", // task 007-contracts-2d3e4f: was missing, decode side already had it
    "Internal",
    "DuplicateSession", "UnhandledError", "UnhandledRejection", "WorkerError", "MessageDeserializeError",
]);
function isPromiseLike(value) {
    return typeof value?.then === "function";
}
/** Estimated encode input footprint (width*height*bpp) used as the scheduler admission
 *  weight. Returns undefined for hostile/overflowing dims so the gate applies its default. */
export function computeEncodeWeight(opts) {
    const bpp = opts.format === "rgba8" ? 4 : opts.format === "rgba16" ? 8 : opts.format === "rgb8" ? 3 : 16;
    const bytes = opts.width * opts.height * bpp;
    return Number.isFinite(bytes) && bytes > 0 && bytes <= Number.MAX_SAFE_INTEGER ? bytes : undefined;
}
export class EncodeSessionImpl {
    id;
    scheduler = null;
    opts;
    chunkStream = new AsyncEventStream();
    doneDeferred = deferred();
    acquirePromise;
    abortSignal;
    abortHandler;
    finished = false;
    terminated = false;
    totalBytesWritten = null;
    sidecarOffsets = undefined;
    constructor(schedulerOrPromise, opts) {
        this.opts = opts;
        this.id = newSessionId();
        // Quality/distance: if the caller gave neither, default distance to 1.0.
        // When both are provided, distance takes precedence and quality is ignored
        // (task 007-logic-k7l8m9n0: make the precedence rule explicit).
        const hasDistance = opts.distance !== undefined;
        const hasQuality = opts.quality !== undefined;
        const distance = hasDistance ? opts.distance : hasQuality ? null : 1.0;
        const quality = !hasDistance && hasQuality ? opts.quality : null;
        const startMsg = encodeOptionsToStartMsg(this.id, opts, distance, quality);
        // No-op catch so a rejected done() promise with no caller handler (caller
        // used only chunks()) does not surface as an unhandledRejection.
        void this.doneDeferred.promise.catch(() => undefined);
        const initAcquire = (scheduler) => {
            // Mirror decode-session: abort may fire before the async scheduler promise resolved;
            // terminated is already set — do not acquire a slot that will never be released.
            if (this.terminated)
                return Promise.resolve();
            this.scheduler = scheduler;
            scheduler.onMessage(this.id, (msg) => this.handleMessage(msg));
            const weight = computeEncodeWeight(opts);
            return scheduler.acquireSlot({
                sessionId: this.id,
                priority: startMsg.priority,
                startMsg,
                sourceKey: null,
                signal: opts.signal ?? null,
                ...(weight !== undefined ? { weight } : {}),
            });
        };
        this.acquirePromise = (isPromiseLike(schedulerOrPromise)
            ? schedulerOrPromise.then((scheduler) => initAcquire(scheduler))
            : initAcquire(schedulerOrPromise))
            .catch((err) => {
            this.terminate(new JxlError("Internal", `Failed to acquire worker: ${String(err)}`, { sessionId: this.id, cause: err }));
        });
        // Set up abort signal handling. Check aborted immediately to handle signals
        // that were already triggered before this session was constructed.
        this.abortSignal = opts.signal ?? null;
        if (this.abortSignal !== null) {
            this.abortHandler = () => {
                // Cancel the scheduler slot before terminating so the worker receives
                // encode_cancel and releases its pool slot immediately
                // (task 007-concurrency-a3b4c5d6).
                this.scheduler?.cancelSession(this.id);
                this.terminate(new JxlError("Cancelled", "Encode aborted by signal", { sessionId: this.id }));
            };
            if (this.abortSignal.aborted) {
                this.abortHandler();
            }
            else {
                this.abortSignal.addEventListener("abort", this.abortHandler, { once: true });
            }
        }
        else {
            this.abortHandler = null;
        }
    }
    // ---------------------------------------------------------------------------
    // Public API (EncodeSession)
    // ---------------------------------------------------------------------------
    async pushPixels(chunk, region) {
        if (this.terminated || this.finished) {
            throw new JxlError("ConfigError", "pushPixels() after finish/cancel/error", { sessionId: this.id });
        }
        await this.acquirePromise;
        if (this.terminated || this.finished)
            return;
        const scheduler = this.scheduler;
        if (scheduler === null)
            return;
        await scheduler.waitForDrain(this.id);
        if (this.terminated || this.finished)
            return;
        const ab = toTransferableBuffer(chunk);
        // Use conditional spread so the object always has the same shape (single
        // hidden class), avoiding a polymorphic scheduler.send() call site
        // (task 007-performance-g3h4i5j6).
        scheduler.send(this.id, {
            type: "encode_pixels",
            sessionId: this.id,
            chunk: ab,
            ...(region !== undefined ? { region } : {}),
        }, [ab]);
    }
    async finish() {
        if (this.terminated || this.finished)
            return;
        // Do not set this.finished until after acquirePromise resolves so that a
        // failed acquire doesn't leave the session with finished=true, which would
        // cause subsequent pushPixels() to throw ConfigError rather than a more
        // accurate error (task 007-contracts-5m6n7o).
        await this.acquirePromise;
        if (this.terminated || this.finished)
            return;
        this.finished = true;
        this.scheduler?.send(this.id, { type: "encode_finish", sessionId: this.id });
    }
    chunks() {
        return this.chunkStream;
    }
    done() {
        return this.doneDeferred.promise;
    }
    getStats() {
        if (this.totalBytesWritten === null)
            return null;
        const bpp = this.opts.format === "rgba8" ? 4 : this.opts.format === "rgba16" ? 8 : this.opts.format === "rgb8" ? 3 : 16;
        const rawProduct = this.opts.width * this.opts.height * bpp;
        // Guard against non-finite or unsafe-integer result from hostile/huge dims
        // (width*height*bpp can exceed Number.MAX_SAFE_INTEGER for very large images).
        const originalBytes = Number.isFinite(rawProduct) && rawProduct <= Number.MAX_SAFE_INTEGER ? rawProduct : 0;
        const compressedBytes = this.totalBytesWritten;
        return {
            originalBytes,
            compressedBytes,
            ratio: compressedBytes / originalBytes,
            // Include sidecarOffsets when the worker produced them
            // (task 007-contracts-1a2b3c).
            ...(this.sidecarOffsets !== undefined ? { sidecarOffsets: this.sidecarOffsets } : {}),
        };
    }
    async cancel(reason) {
        // Guard finished: cancel() after finish() but before encode_done would
        // discard already-received encode_chunk buffers (task 007-logic-e5f6a7b8).
        if (this.terminated || this.finished)
            return;
        await this.acquirePromise.catch(() => undefined);
        // Re-check after the await: abort handler or encode completion may have
        // run during the suspend, preventing double-cancel (task 007-errors-d4e5f6a7).
        if (this.terminated || this.finished)
            return;
        this.scheduler?.cancelSession(this.id);
        this.terminate(new JxlError("Cancelled", reason ?? "Encode cancelled", { sessionId: this.id }));
    }
    // ---------------------------------------------------------------------------
    // Worker message handling
    // ---------------------------------------------------------------------------
    handleMessage(msg) {
        if (this.terminated)
            return;
        // Top-level sessionId guard (mirrors decode-session DS-6 pattern) so any
        // future message type added without an inline check is safe by default.
        if (msg.sessionId !== this.id)
            return;
        switch (msg.type) {
            case "encode_chunk":
                if (msg.chunk == null)
                    break; // defensive: malformed worker message
                this.chunkStream.push(msg.chunk);
                break;
            case "encode_first_byte_ready":
                // Informational only; time_to_first_byte_ms arrives via a metric message.
                break;
            case "encode_done":
                // Capture sidecarOffsets before calling complete() so getStats() can
                // return them (task 007-contracts-1a2b3c).
                this.sidecarOffsets = msg.sidecarOffsets;
                this.complete(msg.totalBytes);
                break;
            case "encode_error": {
                this.terminate(new JxlError(this.normalizeCode(msg.code), String(msg.message).slice(0, 512), { sessionId: this.id }));
                break;
            }
            case "encode_cancelled":
                this.terminate(new JxlError("Cancelled", "Encode cancelled by worker", { sessionId: this.id }));
                break;
            case "metric":
                if (this.opts.onMetric !== undefined) {
                    try {
                        this.opts.onMetric(msg.metric);
                    }
                    catch {
                        // Consumer callback must not break this session's message pump.
                    }
                }
                break;
            default:
                break;
        }
    }
    // ---------------------------------------------------------------------------
    // Terminal helpers
    // ---------------------------------------------------------------------------
    cleanup() {
        if (this.abortSignal !== null && this.abortHandler !== null) {
            this.abortSignal.removeEventListener("abort", this.abortHandler);
        }
    }
    // Normal completion: chunk stream ends gracefully, done() resolves.
    complete(totalBytes) {
        if (this.terminated)
            return;
        this.terminated = true;
        this.totalBytesWritten = totalBytes;
        this.cleanup();
        this.chunkStream.end();
        if (!this.doneDeferred.settled) {
            this.doneDeferred.resolve(totalBytes);
        }
    }
    terminate(err) {
        if (this.terminated)
            return;
        this.terminated = true;
        this.cleanup();
        this.chunkStream.fail(err);
        if (!this.doneDeferred.settled) {
            this.doneDeferred.reject(err);
        }
    }
    normalizeCode(code) {
        // Cast to any for the has() call: Set<JxlErrorCode> rejects a plain string
        // parameter under strict typing, but we deliberately receive an untyped wire
        // string here and want the compile-time check on the Set's element type only.
        return KNOWN_JXL_ERROR_CODES.has(code) ? code : "Internal";
    }
}
//# sourceMappingURL=encode-session.js.map