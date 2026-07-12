// jxl-worker-browser/src/worker.ts
// DedicatedWorker host for WASM codec sessions.
// Spec: Section 26 T-WORKER-BROWSER brief, Sections 10/11/16.
//
// This file is the worker entry point. It owns the WASM module lifecycle and
// routes messages by sessionId to decode or encode handlers.
// The WASM codec (jxl-wasm) is imported dynamically; stubs are used until
// T-WASM-BUILD lands and provides real artifacts.
import { DecodeHandler } from "./decode-handler.js";
import { EncodeHandler } from "./encode-handler.js";
import { loadWasmModule, detectTier } from "./wasm-loader.js";
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const decodeSessions = new Map();
const encodeSessions = new Map();
const pendingDecodeStarts = new Map();
const pendingEncodeStarts = new Map();
const queuedDecodeMessages = new Map();
const queuedEncodeMessages = new Map();
const queuedDecodeBytes = new Map();
const queuedEncodeBytes = new Map();
const abortedStarts = new Set();
// Per-start ownership tokens — keyed by sessionId, value is the epoch counter
// at the time the start IIFE was launched. Only the IIFE whose epoch matches
// the current entry may delete/resolve its pending slot, preventing a stale
// IIFE from clobbering a newer start for the same reused sessionId.
const decodeStartEpoch = new Map();
const encodeStartEpoch = new Map();
let _nextStartEpoch = 0;
let wasmModule = null;
let wasmLoadPromise = null;
let shuttingDown = false;
let shutdownPromise = null;
// Cap per session to avoid unbounded cold-start buffering.
const MAX_QUEUED_MESSAGES_PER_SESSION = 256;
const MAX_QUEUED_BYTES_PER_SESSION = 128 * 1024 * 1024;
// Match spawn.ts S-3 watchdog default (opts.startupTimeoutMs ?? 30_000).
const WASM_LOAD_TIMEOUT_MS = 30_000;
// ---------------------------------------------------------------------------
// WASM acquisition (lazy, singleton; resets on failure to allow retry)
// Wraps loadWasmModule in a per-call timeout so that a hung dynamic import
// does not stall every decode/encode start indefinitely after worker_ready.
// ---------------------------------------------------------------------------
async function getWasm() {
    if (wasmModule !== null)
        return wasmModule;
    if (wasmLoadPromise === null) {
        let timeoutHandle;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                reject(new Error(`[jxl-worker-browser] WASM load timed out after ${WASM_LOAD_TIMEOUT_MS}ms`));
            }, WASM_LOAD_TIMEOUT_MS);
        });
        wasmLoadPromise = Promise.race([
            loadWasmModule(resolvedWasmUrl()),
            timeoutPromise,
        ])
            .then((m) => {
            clearTimeout(timeoutHandle);
            wasmModule = m;
            return m;
        })
            .catch((err) => {
            clearTimeout(timeoutHandle);
            wasmLoadPromise = null;
            throw err;
        });
    }
    return wasmLoadPromise;
}
let _wasmUrl = null;
function resolvedWasmUrl() {
    if (_wasmUrl !== null)
        return _wasmUrl;
    _wasmUrl = new URL("./jxl-core.wasm", self.location.href).href;
    return _wasmUrl;
}
// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------
function hasAnySession(sessionId) {
    return (decodeSessions.has(sessionId) ||
        encodeSessions.has(sessionId) ||
        pendingDecodeStarts.has(sessionId) ||
        pendingEncodeStarts.has(sessionId));
}
function clearQueuedDecode(sessionId) {
    queuedDecodeMessages.delete(sessionId);
    queuedDecodeBytes.delete(sessionId);
}
function clearQueuedEncode(sessionId) {
    queuedEncodeMessages.delete(sessionId);
    queuedEncodeBytes.delete(sessionId);
}
function failPendingDecode(sessionId, code, message) {
    abortedStarts.add(sessionId);
    pendingDecodeStarts.delete(sessionId);
    clearQueuedDecode(sessionId);
    self.postMessage({ type: "decode_error", sessionId, code, message });
}
function failPendingEncode(sessionId, code, message) {
    abortedStarts.add(sessionId);
    pendingEncodeStarts.delete(sessionId);
    clearQueuedEncode(sessionId);
    self.postMessage({ type: "encode_error", sessionId, code, message });
}
function queueDecodeMessage(sessionId, msg) {
    let queue = queuedDecodeMessages.get(sessionId);
    if (queue === undefined) {
        queue = [];
        queuedDecodeMessages.set(sessionId, queue);
    }
    if (queue.length >= MAX_QUEUED_MESSAGES_PER_SESSION) {
        failPendingDecode(sessionId, "QueueOverflow", `Cold-start message queue exceeded ${MAX_QUEUED_MESSAGES_PER_SESSION} messages for session ${sessionId}`);
        return;
    }
    if (msg.type === "decode_chunk") {
        const nextBytes = (queuedDecodeBytes.get(sessionId) ?? 0) + msg.chunk.byteLength;
        if (nextBytes > MAX_QUEUED_BYTES_PER_SESSION) {
            failPendingDecode(sessionId, "QueueOverflow", `Cold-start decode queue exceeded ${MAX_QUEUED_BYTES_PER_SESSION >> 20} MiB for session ${sessionId}`);
            return;
        }
        queuedDecodeBytes.set(sessionId, nextBytes);
    }
    queue.push(msg);
}
function queueEncodeMessage(sessionId, msg) {
    let queue = queuedEncodeMessages.get(sessionId);
    if (queue === undefined) {
        queue = [];
        queuedEncodeMessages.set(sessionId, queue);
    }
    if (queue.length >= MAX_QUEUED_MESSAGES_PER_SESSION) {
        failPendingEncode(sessionId, "QueueOverflow", `Cold-start message queue exceeded ${MAX_QUEUED_MESSAGES_PER_SESSION} messages for session ${sessionId}`);
        return;
    }
    if (msg.type === "encode_pixels") {
        const nextBytes = (queuedEncodeBytes.get(sessionId) ?? 0) + msg.chunk.byteLength;
        if (nextBytes > MAX_QUEUED_BYTES_PER_SESSION) {
            failPendingEncode(sessionId, "QueueOverflow", `Cold-start encode queue exceeded ${MAX_QUEUED_BYTES_PER_SESSION >> 20} MiB for session ${sessionId}`);
            return;
        }
        queuedEncodeBytes.set(sessionId, nextBytes);
    }
    queue.push(msg);
}
function flushQueuedDecodeMessages(sessionId, handler) {
    const queue = queuedDecodeMessages.get(sessionId);
    if (queue === undefined)
        return;
    clearQueuedDecode(sessionId);
    for (const msg of queue) {
        routeToDecodeHandler(handler, msg);
    }
}
function flushQueuedEncodeMessages(sessionId, handler) {
    const queue = queuedEncodeMessages.get(sessionId);
    if (queue === undefined)
        return;
    clearQueuedEncode(sessionId);
    for (const msg of queue) {
        routeToEncodeHandler(handler, msg);
    }
}
// ---------------------------------------------------------------------------
// Per-type dispatch and lookup-or-queue routing
// ---------------------------------------------------------------------------
function routeToDecodeHandler(handler, msg) {
    switch (msg.type) {
        case "decode_chunk":
            handler.onChunk(msg.chunk);
            break;
        case "decode_close":
            handler.onClose();
            break;
        case "decode_cancel":
            void handler.onCancel(msg.reason);
            break;
        case "decode_pause":
            handler.onPause();
            break;
        case "decode_resume":
            handler.onResume();
            break;
    }
}
function routeToEncodeHandler(handler, msg) {
    switch (msg.type) {
        case "encode_pixels":
            handler.onPixels(msg.chunk, msg.region);
            break;
        case "encode_finish":
            handler.onFinish();
            break;
        case "encode_cancel":
            void handler.onCancel(msg.reason);
            break;
    }
}
function routeDecodeMessage(msg) {
    const handler = decodeSessions.get(msg.sessionId);
    if (handler !== undefined) {
        routeToDecodeHandler(handler, msg);
    }
    else if (pendingDecodeStarts.has(msg.sessionId)) {
        queueDecodeMessage(msg.sessionId, msg);
    }
}
function routeEncodeMessage(msg) {
    const handler = encodeSessions.get(msg.sessionId);
    if (handler !== undefined) {
        routeToEncodeHandler(handler, msg);
    }
    else if (pendingEncodeStarts.has(msg.sessionId)) {
        queueEncodeMessage(msg.sessionId, msg);
    }
}
function handleReleaseState(sessionId) {
    if (pendingDecodeStarts.has(sessionId) || pendingEncodeStarts.has(sessionId)) {
        abortedStarts.add(sessionId);
    }
    else {
        abortedStarts.delete(sessionId);
    }
    const decode = decodeSessions.get(sessionId);
    if (decode !== undefined) {
        void decode.onCancel("release_state").catch(() => undefined);
        decodeSessions.delete(sessionId);
    }
    const encode = encodeSessions.get(sessionId);
    if (encode !== undefined) {
        void encode.onCancel("release_state").catch(() => undefined);
        encodeSessions.delete(sessionId);
    }
    pendingDecodeStarts.delete(sessionId);
    pendingEncodeStarts.delete(sessionId);
    // Invalidate ownership tokens so any in-flight start IIFEs for this sessionId
    // will see a mismatched epoch and skip their pending-slot delete.
    decodeStartEpoch.delete(sessionId);
    encodeStartEpoch.delete(sessionId);
    clearQueuedDecode(sessionId);
    clearQueuedEncode(sessionId);
}
// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
self.onmessage = (ev) => {
    const msg = ev.data;
    if (shuttingDown && msg.type !== "worker_shutdown") {
        return;
    }
    switch (msg.type) {
        case "decode_start":
            void handleDecodeStart(msg);
            break;
        case "decode_chunk":
        case "decode_close":
        case "decode_cancel":
        case "decode_pause":
        case "decode_resume":
            routeDecodeMessage(msg);
            break;
        case "encode_start":
            void handleEncodeStart(msg);
            break;
        case "encode_pixels":
        case "encode_finish":
        case "encode_cancel":
            routeEncodeMessage(msg);
            break;
        case "release_state":
            handleReleaseState(msg.sessionId);
            break;
        case "worker_shutdown":
            void handleShutdown();
            break;
        default:
            break;
    }
};
// ---------------------------------------------------------------------------
// Decode session start
// ---------------------------------------------------------------------------
async function handleDecodeStart(msg) {
    if (hasAnySession(msg.sessionId)) {
        self.postMessage({
            type: "decode_error",
            sessionId: msg.sessionId,
            code: "DuplicateSession",
            message: `Session already exists: ${msg.sessionId}`,
        });
        return;
    }
    // Register in pendingDecodeStarts BEFORE awaiting getWasm() so that any
    // messages arriving while WASM is loading are correctly queued by
    // routeDecodeMessage. If the set() came after the async IIFE, a synchronous
    // (warm-cache) resolution of getWasm() would finish the entire body before
    // the map entry existed, causing those in-flight messages to be silently dropped.
    let resolveStartPromise;
    const startPromise = new Promise((resolve) => { resolveStartPromise = resolve; });
    pendingDecodeStarts.set(msg.sessionId, startPromise);
    // Ownership token: captured at start time, checked before clearing the pending
    // slot. If the sessionId is reused (release_state → new decode_start) before
    // this IIFE resumes, the epoch will have advanced and the stale IIFE's delete
    // will be a no-op, leaving the new start's entry intact.
    const myEpoch = _nextStartEpoch++;
    decodeStartEpoch.set(msg.sessionId, myEpoch);
    (async () => {
        let wasm;
        try {
            wasm = await getWasm();
        }
        catch (err) {
            // Only clear our own pending slot; a newer start may have replaced it.
            if (decodeStartEpoch.get(msg.sessionId) === myEpoch) {
                decodeStartEpoch.delete(msg.sessionId);
                pendingDecodeStarts.delete(msg.sessionId);
                clearQueuedDecode(msg.sessionId);
                resolveStartPromise();
                if (!abortedStarts.delete(msg.sessionId)) {
                    self.postMessage({
                        type: "decode_error",
                        sessionId: msg.sessionId,
                        code: "CapabilityMissing",
                        message: `WASM module failed to load: ${String(err)}`,
                    });
                }
            }
            return;
        }
        // Bail if a newer start has taken ownership of this sessionId.
        if (decodeStartEpoch.get(msg.sessionId) !== myEpoch)
            return;
        decodeStartEpoch.delete(msg.sessionId);
        pendingDecodeStarts.delete(msg.sessionId);
        if (abortedStarts.delete(msg.sessionId) || shuttingDown) {
            clearQueuedDecode(msg.sessionId);
            resolveStartPromise();
            return;
        }
        const handler = new DecodeHandler(msg, wasm, {
            // Identity guard: only clear the map slot if it still points at THIS handler.
            // A late onSessionEnd from a superseded handler must not evict a newer session
            // that reused the same sessionId (recycle / rapid re-decode).
            onSessionEnd: (sessionId) => {
                if (decodeSessions.get(sessionId) === handler)
                    decodeSessions.delete(sessionId);
            },
        });
        decodeSessions.set(msg.sessionId, handler);
        flushQueuedDecodeMessages(msg.sessionId, handler);
        resolveStartPromise();
    })().catch((err) => {
        if (decodeStartEpoch.get(msg.sessionId) === myEpoch) {
            decodeStartEpoch.delete(msg.sessionId);
            pendingDecodeStarts.delete(msg.sessionId);
            clearQueuedDecode(msg.sessionId);
            resolveStartPromise();
            if (!abortedStarts.delete(msg.sessionId)) {
                self.postMessage({
                    type: "decode_error",
                    sessionId: msg.sessionId,
                    code: "Internal",
                    message: `Unexpected error starting decode session: ${String(err)}`,
                });
            }
        }
    });
}
// ---------------------------------------------------------------------------
// Encode session start
// ---------------------------------------------------------------------------
async function handleEncodeStart(msg) {
    if (hasAnySession(msg.sessionId)) {
        self.postMessage({
            type: "encode_error",
            sessionId: msg.sessionId,
            code: "DuplicateSession",
            message: `Session already exists: ${msg.sessionId}`,
        });
        return;
    }
    // Register in pendingEncodeStarts BEFORE awaiting getWasm() — same race as
    // handleDecodeStart: a warm-cache synchronous resolution would complete the
    // entire IIFE before a trailing set(), silently dropping in-flight messages.
    let resolveStartPromise;
    const startPromise = new Promise((resolve) => { resolveStartPromise = resolve; });
    pendingEncodeStarts.set(msg.sessionId, startPromise);
    // Ownership token — same stale-start guard as handleDecodeStart.
    const myEpoch = _nextStartEpoch++;
    encodeStartEpoch.set(msg.sessionId, myEpoch);
    (async () => {
        let wasm;
        try {
            wasm = await getWasm();
        }
        catch (err) {
            if (encodeStartEpoch.get(msg.sessionId) === myEpoch) {
                encodeStartEpoch.delete(msg.sessionId);
                pendingEncodeStarts.delete(msg.sessionId);
                clearQueuedEncode(msg.sessionId);
                resolveStartPromise();
                if (!abortedStarts.delete(msg.sessionId)) {
                    self.postMessage({
                        type: "encode_error",
                        sessionId: msg.sessionId,
                        code: "CapabilityMissing",
                        message: `WASM module failed to load: ${String(err)}`,
                    });
                }
            }
            return;
        }
        if (encodeStartEpoch.get(msg.sessionId) !== myEpoch)
            return;
        encodeStartEpoch.delete(msg.sessionId);
        pendingEncodeStarts.delete(msg.sessionId);
        if (abortedStarts.delete(msg.sessionId) || shuttingDown) {
            clearQueuedEncode(msg.sessionId);
            resolveStartPromise();
            return;
        }
        const handler = new EncodeHandler(msg, wasm, {
            // Identity guard (see decode path): don't let a superseded handler evict a
            // newer session that reused the same sessionId.
            onSessionEnd: (sessionId) => {
                if (encodeSessions.get(sessionId) === handler)
                    encodeSessions.delete(sessionId);
            },
        });
        encodeSessions.set(msg.sessionId, handler);
        flushQueuedEncodeMessages(msg.sessionId, handler);
        resolveStartPromise();
    })().catch((err) => {
        if (encodeStartEpoch.get(msg.sessionId) === myEpoch) {
            encodeStartEpoch.delete(msg.sessionId);
            pendingEncodeStarts.delete(msg.sessionId);
            clearQueuedEncode(msg.sessionId);
            resolveStartPromise();
            if (!abortedStarts.delete(msg.sessionId)) {
                self.postMessage({
                    type: "encode_error",
                    sessionId: msg.sessionId,
                    code: "Internal",
                    message: `Unexpected error starting encode session: ${String(err)}`,
                });
            }
        }
    });
}
// ---------------------------------------------------------------------------
// Graceful shutdown (idempotent)
// ---------------------------------------------------------------------------
function handleShutdown() {
    if (shutdownPromise !== null)
        return shutdownPromise;
    shutdownPromise = doShutdown();
    return shutdownPromise;
}
async function doShutdown() {
    shuttingDown = true;
    // Wait for any in-flight session starts before cancelling their handlers.
    await Promise.allSettled([
        ...pendingDecodeStarts.values(),
        ...pendingEncodeStarts.values(),
    ]);
    const cancelPromises = [];
    for (const handler of decodeSessions.values()) {
        cancelPromises.push(handler.onCancel("worker_shutdown").catch(() => undefined));
    }
    for (const handler of encodeSessions.values()) {
        cancelPromises.push(handler.onCancel("worker_shutdown").catch(() => undefined));
    }
    await Promise.allSettled(cancelPromises);
    decodeSessions.clear();
    encodeSessions.clear();
    pendingDecodeStarts.clear();
    pendingEncodeStarts.clear();
    decodeStartEpoch.clear();
    encodeStartEpoch.clear();
    queuedDecodeMessages.clear();
    queuedEncodeMessages.clear();
    queuedDecodeBytes.clear();
    queuedEncodeBytes.clear();
    abortedStarts.clear();
    wasmModule = null;
    wasmLoadPromise = null;
    const ack = { type: "worker_shutdown_ack" };
    self.postMessage(ack);
    self.close();
}
// ---------------------------------------------------------------------------
// Uncaught error reporting
// ---------------------------------------------------------------------------
/** Returns the sessionId of the single active session on this worker, if any. */
function activeSessionId() {
    // Workers run at most one decode and one encode session concurrently (pool
    // assigns one session per worker). Prefer the decode session as crashes mid-
    // decode are the primary use-case, then fall back to encode.
    for (const id of decodeSessions.keys())
        return id;
    for (const id of encodeSessions.keys())
        return id;
    return undefined;
}
self.addEventListener("error", (event) => {
    const sid = activeSessionId();
    self.postMessage({
        type: "worker_error",
        code: "UnhandledError",
        message: event.message ?? "Unknown worker error",
        ...(sid !== undefined ? { sessionId: sid } : {}),
    });
});
self.addEventListener("unhandledrejection", (event) => {
    const sid = activeSessionId();
    self.postMessage({
        type: "worker_error",
        code: "UnhandledRejection",
        message: event.reason instanceof Error ? event.reason.message : String(event.reason),
        ...(sid !== undefined ? { sessionId: sid } : {}),
    });
});
self.addEventListener("messageerror", () => {
    const sid = activeSessionId();
    self.postMessage({
        type: "worker_error",
        code: "MessageDeserializeError",
        message: "Failed to deserialize incoming message",
        ...(sid !== undefined ? { sessionId: sid } : {}),
    });
});
// ---------------------------------------------------------------------------
// Dashboard stats (read-only, additive — no behavior change)
// ---------------------------------------------------------------------------
/**
 * Lightweight snapshot of this worker's in-flight session counts.
 * Read-only; no side effects. Exported for test inspection and future
 * message-based pollers; not callable from the main thread directly.
 */
export function getWorkerStats() {
    return {
        decodeSessions: decodeSessions.size,
        encodeSessions: encodeSessions.size,
        pendingDecodeStarts: pendingDecodeStarts.size,
        pendingEncodeStarts: pendingEncodeStarts.size,
        wasmLoaded: wasmModule !== null,
        shuttingDown,
    };
}
// ---------------------------------------------------------------------------
// Startup announcement
// ---------------------------------------------------------------------------
// Report the ACTUAL effective tier: if a ?jxlWorkerTier= override is present
// on the worker's URL (as injected by forceWorkerSafeTier in loadWasmModule),
// use it; otherwise fall back to detectTier() from the environment probes.
// This keeps the scheduler's MT-cost accounting correct when a tier override
// has been forced (e.g. forceWorkerSafeTier / ?jxlWorkerTier=simd).
function resolvedWasmBuild() {
    try {
        const globalSelf = globalThis;
        const rawSearch = globalSelf.self?.location?.search;
        const search = typeof rawSearch === "string" ? rawSearch : "";
        if (search !== "") {
            const tier = new URLSearchParams(search).get("jxlWorkerTier");
            if (tier === "relaxed-simd-mt" ||
                tier === "simd-mt" ||
                tier === "simd" ||
                tier === "scalar") {
                return tier;
            }
        }
    }
    catch {
        // URL parsing failed; fall through to detectTier().
    }
    return detectTier();
}
const ready = { type: "worker_ready", backend: "wasm", wasmBuild: resolvedWasmBuild() };
self.postMessage(ready);
// TTFP-3: kick the WASM fetch+compile at boot, AFTER worker_ready is posted
// (spawn watchdog ordering preserved). Workers spawn only on demand, so a
// spawned worker is about to decode/encode — starting the memoized getWasm()
// here overlaps the multi-MB fetch+compile with scheduler dispatch instead of
// serializing it behind the first decode_start. Cold-start chunk buffering is
// unaffected: decode_start still awaits the same memoized promise. Must stay
// on the dynamic loadWasmModule path (no static jxl-wasm import — see the
// wasm-loader comment and the "no top-level bare jxl-wasm" guard).
void getWasm().catch(() => {
    // Best-effort: getWasm() resets wasmLoadPromise on failure, so the first
    // real decode/encode start retries the load and surfaces the error to its
    // own session instead of an orphan boot-time rejection.
});
//# sourceMappingURL=worker.js.map