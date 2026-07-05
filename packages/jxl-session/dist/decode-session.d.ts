import type { DecodeOptions, DecodeSession, DecodeFrameEvent, ImageInfo } from "@casabio/jxl-core";
import type { Scheduler } from "@casabio/jxl-scheduler";
export declare function computeDecodeWeight(opts: {
    expectedOutputBytes?: number;
    targetWidth?: number | null;
    targetHeight?: number | null;
    format?: string;
}): number | undefined;
export declare class DecodeSessionImpl implements DecodeSession {
    readonly id: string;
    private scheduler;
    private readonly opts;
    private readonly frameStream;
    private readonly doneDeferred;
    private readonly headerDeferred;
    private readonly acquirePromise;
    private readonly abortSignal;
    private readonly abortHandler;
    private lastInfo;
    private closed;
    private terminated;
    private terminalError;
    constructor(schedulerOrPromise: Scheduler | Promise<Scheduler>, opts: DecodeOptions);
    push(chunk: ArrayBuffer | Uint8Array): Promise<void>;
    close(): Promise<void>;
    /**
     * Returns the frame stream.
     * Contract (DS-2): call frames() BEFORE awaiting done() if you want to
     * observe progressive or final frames. If only done() is awaited (or frames()
     * called after done resolves), buffered frames may have been cleared and
     * will not be replayed.
     */
    frames(): AsyncIterable<DecodeFrameEvent>;
    /**
     * Awaits final ImageInfo (success) or rejects with JxlError.
     * See frames() contract: consume frames before done() to receive them.
     */
    done(): Promise<ImageInfo>;
    get info(): ImageInfo | null;
    header(): Promise<ImageInfo>;
    cancel(reason?: string): Promise<void>;
    private makeFrame;
    private emitFoldedMetrics;
    private handleMessage;
    private cleanup;
    /**
     * @param localEarlyFinish - true when the session completes locally without a terminal
     *   worker message (progressionTarget="header" or emitEveryPass=false non-final target).
     *   In those cases no decode_final/decode_cancelled ack arrives, so the scheduler slot
     *   and onMessage handler are never released by the normal terminal path — we must
     *   release them here via completeSession().
     *   False/absent on the normal decode_final path where the scheduler cleans up itself.
     *
     *   completeSession() (not cancelSession()) is deliberate
     *   (DS-SINGLEPASS-SLOT-01 verified stale): the WORKER also self-stops on
     *   these targets (decode-handler finishSession at the "header" /
     *   non-final-target branches), so the slot being freed belongs to an idle
     *   worker — nothing keeps decoding. cancelSession() here would send
     *   decode_cancel for a session the worker already ended, which the worker
     *   drops without an ack (routeDecodeMessage: no handler, not pending) and
     *   the scheduler record would hang in "cancelling" forever.
     */
    private finish;
    private finishWithError;
    private fail;
    private normalizeCode;
}
export declare function firstFrame(session: Pick<DecodeSession, "frames" | "cancel">, opts?: {
    minStage?: "dc" | "pass" | "final";
}): Promise<DecodeFrameEvent>;
//# sourceMappingURL=decode-session.d.ts.map