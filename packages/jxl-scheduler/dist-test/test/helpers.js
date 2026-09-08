// jxl-scheduler/test/helpers.ts
// Test doubles for scheduler integration tests.
// A controllable fake worker for scheduler tests.
export class FakeWorker {
    messages = [];
    handlers = [];
    _terminated = false;
    get terminated() {
        return this._terminated;
    }
    send(msg, _transfer = []) {
        this.messages.push(msg);
    }
    onMessage(handler) {
        this.handlers.push(handler);
    }
    // Emit a message "from the worker" to all registered handlers.
    emit(msg) {
        for (const h of this.handlers)
            h(msg);
    }
    async shutdown(_timeoutMs = 5000) {
        this._terminated = true;
    }
}
// Factory that creates a FakeWorker and keeps a reference so tests can
// drive it.
export function fakeWorkerFactory(store) {
    return async () => {
        const w = new FakeWorker();
        store.push(w);
        return w;
    };
}
export function makeDecodeStart(sessionId, priority = "visible") {
    return {
        type: "decode_start",
        sessionId,
        format: "rgba8",
        region: null,
        downsample: 1,
        progressionTarget: "final",
        emitEveryPass: true,
        suppressDuplicateProgress: false,
        preserveIcc: true,
        preserveMetadata: true,
        priority,
        budgetMs: null,
        progressiveDetail: null,
        targetWidth: null,
        targetHeight: null,
        fitMode: null,
    };
}
//# sourceMappingURL=helpers.js.map