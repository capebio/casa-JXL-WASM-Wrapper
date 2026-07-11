/**
 * Lightweight snapshot of this worker's in-flight session counts.
 * Read-only; no side effects. Exported for test inspection and future
 * message-based pollers; not callable from the main thread directly.
 */
export declare function getWorkerStats(): {
    decodeSessions: number;
    encodeSessions: number;
    pendingDecodeStarts: number;
    pendingEncodeStarts: number;
    wasmLoaded: boolean;
    shuttingDown: boolean;
};
//# sourceMappingURL=worker.d.ts.map