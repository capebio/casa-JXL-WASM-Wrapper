// jxl-session/src/util.ts
// Small shared helpers for the session facade.
export function deferred() {
    let resolve;
    let reject;
    const d = { settled: false };
    d.promise = new Promise((res, rej) => {
        resolve = (v) => { d.settled = true; res(v); };
        reject = (e) => { d.settled = true; rej(e); };
    });
    d.resolve = resolve;
    d.reject = reject;
    return d;
}
// Normalize a chunk to a standalone ArrayBuffer suitable for transfer.
// An exact-span Uint8Array transfers its buffer directly; a partial view
// is copied so the transfer does not detach memory the caller still holds.
// JxlCache.get() (browser/node) now returns independent ArrayBuffers; callers
// may transfer the result without invalidating the cache master copy.
export function toTransferableBuffer(chunk) {
    if (chunk instanceof ArrayBuffer)
        return chunk;
    // chunk.buffer is ArrayBufferLike (ArrayBuffer | SharedArrayBuffer) under TS 5.5 +
    // @types/node 22. These helpers normalize a chunk for postMessage transfer; the SAB
    // case is handled by callers (omitted from the transfer list, shared by reference), so
    // the cast is safe. Mirrors toTransferablePixels() in jxl-worker-browser/decode-handler.
    if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
        return chunk.buffer;
    }
    return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
}
// Generate a session id. crypto.randomUUID is available in browsers and Node >= 19.
export function newSessionId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return `jxl-${crypto.randomUUID()}`;
        }
    }
    catch {
        // fall through
    }
    return `jxl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
//# sourceMappingURL=util.js.map