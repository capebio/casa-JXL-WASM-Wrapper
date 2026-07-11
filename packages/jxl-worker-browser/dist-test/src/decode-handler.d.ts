import type { JxlModule } from "./wasm-loader.js";
import type { MsgDecodeStart } from "@casabio/jxl-core/protocol";
interface DecodeHandlerCallbacks {
    onSessionEnd: (sessionId: string) => void;
}
export declare class DecodeHandler {
    private readonly sessionId;
    private readonly opts;
    private readonly wasm;
    private readonly callbacks;
    private state;
    private chunkQueue;
    private cancelled;
    private ended;
    private inputClosed;
    private wakeResolve;
    private paused;
    private resumeResolve;
    private decoder;
    private disposePromise;
    private lastDrainPostedMs;
    private lastDrainAllowed;
    private pushLatencyEma;
    private copyLatencyEma;
    private readonly stageStartMs;
    private firstPixelMetricPosted;
    private readonly _metricInner;
    private readonly _metricMsg;
    private readonly _drainMsg;
    private _cachedHwm;
    private _hwmLastEma;
    constructor(opts: MsgDecodeStart, wasm: JxlModule, callbacks: DecodeHandlerCallbacks);
    onChunk(chunk: ArrayBuffer): void;
    onClose(): void;
    onCancel(reason?: string): Promise<void>;
    onPause(): void;
    onResume(): void;
    private run;
    private isTerminal;
    private finishSession;
    private clearInputQueue;
    private wake;
    private wakeResume;
    private disposeActiveDecoder;
    private waitForChunk;
    private waitForResume;
    private takeNextChunk;
    private feedDecoder;
    private maybePostDrain;
    private readDecoderEvents;
    private adaptiveHwm;
    private checkBudget;
    private failSession;
    private postBudgetExceeded;
    private postMetric;
}
export {};
//# sourceMappingURL=decode-handler.d.ts.map