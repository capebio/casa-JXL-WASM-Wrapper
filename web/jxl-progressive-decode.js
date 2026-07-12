export function createProgressiveDecodeRequest({
    worker,
    sessionId,
    onProgress,
    onFinal,
    onHeader,
    onError,
    onFrame,
    signal,
    progressionTarget = 'final',
    emitEveryPass = true,
    preserveIcc = true,
    preserveMetadata = true,
    priority = 'visible',
    budgetMs = null,
    format = 'rgba8',
    region = null,
    downsample = 1,
    // Task 6 (finding 2): an OPTIONAL descriptor recording which resolved LOD this request
    // represents (e.g. { kind: 'progressive-prefix', byteEnd }). It is purely informational —
    // surfaced on the returned request for telemetry / cache keys — and is NOT sent to the worker,
    // so the decode_start message (and the opportunistic-flush / chunk-feeding contract) is
    // unchanged. The progressive-prefix bytes are fed through the EXISTING push(), reusing this
    // request's queue rather than recreating it.
    lod = null,
} = {}) {
    if (!worker) {
        throw new TypeError('createProgressiveDecodeRequest requires a worker');
    }
    if (!sessionId) {
        throw new TypeError('createProgressiveDecodeRequest requires a sessionId');
    }
    if (signal?.aborted) {
        throw new DOMException('Decode already aborted', 'AbortError');
    }

    const wantsProgressFrames = !!(onProgress || onFrame);

    let started = false;
    let closed = false;
    let settled = false;
    let lastInfo = null;
    let currentStage = 'pending';
    let resolveDone;
    let rejectDone;

    const done = new Promise((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
    });

    const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveDone(value);
    };

    const fail = (message, code = 'DecodeFailed') => {
        if (settled) return;
        settled = true;
        cleanup();
        const error = new Error(message);
        error.code = code;
        rejectDone(error);
    };

    const cancelDecode = (reason = 'cancelled') => {
        if (settled) return;
        closed = true;
        worker.postMessage({ type: 'decode_cancel', sessionId, reason });
        fail(reason, 'DecodeCancelled');
    };

    const callUser = (fn, value, code) => {
        if (!fn) return true;
        try {
            fn(value);
            return true;
        } catch (error) {
            fail(error?.message || 'Decode callback failed', code);
            return false;
        }
    };

    let abortHandler = null;
    if (signal) {
        abortHandler = () => cancelDecode('aborted by signal');
        signal.addEventListener('abort', abortHandler, { once: true });
    }

    const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        if (abortHandler) signal.removeEventListener('abort', abortHandler);
    };

    const onMessage = ({ data }) => {
        if (!data || getMessageSessionId(data) !== sessionId) return;

        if (data.type === 'decode_header') {
            callUser(onHeader, normalizeHeader(data), 'DecodeHeaderCallbackFailed');
            return;
        }

        if (data.type === 'decode_progress') {
            if (data.info) lastInfo = data.info;
            if (data.stage) currentStage = data.stage;
            if (!wantsProgressFrames) return;
            const frame = normalizeFrame(data);
            if (onProgress && !callUser(onProgress, frame, 'DecodeProgressCallbackFailed')) return;
            if (onFrame) callUser(onFrame, frame, 'DecodeFrameCallbackFailed');
            return;
        }

        if (data.type === 'decode_final') {
            const frame = normalizeFrame(data);
            if (data.info) lastInfo = data.info;
            currentStage = 'final';
            // The final frame is already produced — its terminal lifecycle (onFinal/finish)
            // must run even if a consumer's onFrame throws. A throwing onFrame still records
            // the failure via callUser, but we do not skip onFinal/finish for it.
            try {
                if (onFrame) callUser(onFrame, frame, 'DecodeFrameCallbackFailed');
            } finally {
                if (onFinal) callUser(onFinal, frame, 'DecodeFinalCallbackFailed');
                finish(frame);
            }
            return;
        }

        if (data.type === 'decode_error') {
            try {
                onError?.(data);
            } finally {
                fail(data.message || data.error || 'Decode failed', data.code || 'DecodeFailed');
            }
            return;
        }

        if (data.type === 'decode_cancelled' || data.type === 'jxl_decoded') {
            const frame = data.type === 'jxl_decoded'
                ? normalizeLegacyFrame(data)
                : null;
            if (frame !== null) {
                if (onFrame && !callUser(onFrame, frame, 'DecodeFrameCallbackFailed')) return;
                if (onFinal && !callUser(onFinal, frame, 'DecodeFinalCallbackFailed')) return;
                finish(frame);
                return;
            }
            fail('Decode cancelled', 'DecodeCancelled');
        }
    };

    worker.addEventListener('message', onMessage);

    return {
        done,
        get lastInfo() { return lastInfo; },
        get currentStage() { return currentStage; },
        // The resolved LOD this request represents (or null). Informational only — see the `lod`
        // param note above; it never enters a worker message.
        get lod() { return lod; },
        start() {
            if (started) return;
            started = true;
            worker.postMessage({
                type: 'decode_start',
                sessionId,
                format,
                region,
                downsample,
                progressionTarget,
                emitEveryPass,
                preserveIcc,
                preserveMetadata,
                priority,
                budgetMs,
            });
        },
        push(chunk) {
            if (settled || closed) return;
            const buffer = toTransferableArrayBuffer(chunk);
            worker.postMessage({ type: 'decode_chunk', sessionId, chunk: buffer }, [buffer]);
        },
        close() {
            if (settled || closed) return;
            closed = true;
            worker.postMessage({ type: 'decode_close', sessionId });
        },
        cancel(reason = 'cancelled') {
            cancelDecode(reason);
        },
        dispose(reason = 'disposed') {
            fail(reason, 'DecodeDisposed');
        },
    };
}

const getMessageSessionId = (data) => data?.sessionId ?? data?.decodeId;

function normalizeHeader(data) {
    return {
        sessionId: data.sessionId,
        w: data.info?.width ?? data.w ?? 0,
        h: data.info?.height ?? data.h ?? 0,
        info: data.info ?? null,
        stage: data.stage ?? 'header',
        format: data.format ?? null,
        pixelStride: data.pixelStride ?? null,
        region: data.region ?? null,
    };
}

function normalizeFrame(data) {
    const rgba = toUint8Array(data.pixels);
    const w = data.info?.width ?? data.w ?? 0;
    const h = data.info?.height ?? data.h ?? 0;
    return {
        sessionId: data.sessionId,
        w,
        h,
        rgba,
        getImageData() {
            return new ImageData(
                new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
                w,
                h,
            );
        },
        info: data.info ?? null,
        stage: data.stage ?? 'final',
        format: data.format ?? 'rgba8',
        pixelStride: data.pixelStride ?? 4,
        region: data.region ?? null,
    };
}

function normalizeLegacyFrame(data) {
    const rgba = toUint8Array(data.rgba);
    const w = data.w ?? 0;
    const h = data.h ?? 0;
    return {
        sessionId: data.decodeId ?? data.sessionId,
        w,
        h,
        rgba,
        getImageData() {
            return new ImageData(
                new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
                w,
                h,
            );
        },
        info: { width: w, height: h },
        stage: 'final',
        format: 'rgba8',
        pixelStride: 4,
        region: null,
    };
}

function toTransferableArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
        return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
            ? value.buffer
            : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    throw new TypeError('decode chunk must be an ArrayBuffer or ArrayBufferView');
}

function toUint8Array(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return new Uint8Array(toTransferableArrayBuffer(value));
}
