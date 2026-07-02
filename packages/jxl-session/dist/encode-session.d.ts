import type { EncodeOptions, EncodeSession, EncodeStats, Region, MsgEncodeStart } from "@casabio/jxl-core";
import type { Scheduler } from "@casabio/jxl-scheduler";
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
export declare function encodeOptionsToStartMsg(sessionId: string, opts: EncodeOptions, distance: number | null, quality: number | null): MsgEncodeStart;
/** Estimated encode input footprint (width*height*bpp) used as the scheduler admission
 *  weight. Returns undefined for hostile/overflowing dims so the gate applies its default. */
export declare function computeEncodeWeight(opts: {
    width: number;
    height: number;
    format: string;
}): number | undefined;
export declare class EncodeSessionImpl implements EncodeSession {
    readonly id: string;
    private scheduler;
    private readonly opts;
    private readonly chunkStream;
    private readonly doneDeferred;
    private readonly acquirePromise;
    private readonly abortSignal;
    private readonly abortHandler;
    private finished;
    private terminated;
    private totalBytesWritten;
    private sidecarOffsets;
    constructor(schedulerOrPromise: Scheduler | Promise<Scheduler>, opts: EncodeOptions);
    pushPixels(chunk: ArrayBuffer, region?: Region): Promise<void>;
    finish(): Promise<void>;
    chunks(): AsyncIterable<ArrayBuffer>;
    done(): Promise<number>;
    getStats(): EncodeStats | null;
    cancel(reason?: string): Promise<void>;
    private handleMessage;
    private cleanup;
    private complete;
    private terminate;
    private normalizeCode;
}
//# sourceMappingURL=encode-session.d.ts.map