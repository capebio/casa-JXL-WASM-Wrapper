import type { ContextOptions, DecodeOptions, DecodeSession, EncodeOptions, EncodeSession, Capabilities } from "@casabio/jxl-core";
import { type WorkerFactory, type Priority, type CoreBudget } from "@casabio/jxl-scheduler";
import { type PoolPressureMetrics } from "./tier-routing.js";
export interface JxlContext {
    decode(opts: DecodeOptions): DecodeSession;
    encode(opts: EncodeOptions): EncodeSession;
    capabilities(): Capabilities;
    shutdown(): Promise<void>;
}
export declare function validateWasmUrl(url: string): void;
export declare function hardwareConcurrency(): number;
export declare const DECODER_MT_WORKER_COST = 4;
export declare function computeWorkerCostForWasmUrl(url: string | undefined): number;
declare abstract class CapabilityAwareContext implements JxlContext {
    protected caps: Capabilities;
    protected shuttingDown: boolean;
    protected probeSettled: boolean;
    abstract decode(opts: DecodeOptions): DecodeSession;
    abstract encode(opts: EncodeOptions): EncodeSession;
    abstract shutdown(): Promise<void>;
    probeCapabilities(): void;
    capabilities(): Capabilities;
}
export interface SchedulerMetricsSource {
    getMetrics(): PoolPressureMetrics;
}
export declare function createTieredSchedulerRouter<TMt extends SchedulerMetricsSource, TSt>(params: {
    mtScheduler: TMt;
    stScheduler: TSt;
    mtCost: number;
    maxWorkers: number;
    coreBudget: CoreBudget;
    visibleGraceMs: number;
    sleep?: (ms: number) => Promise<void>;
}): {
    pick(priority: Priority): Promise<TMt | TSt>;
};
export declare class JxlContextImpl extends CapabilityAwareContext {
    private readonly scheduler;
    constructor(factory: WorkerFactory, opts: ContextOptions | undefined, maxWorkers: number);
    decode(opts: DecodeOptions): DecodeSession;
    encode(opts: EncodeOptions): EncodeSession;
    shutdown(): Promise<void>;
}
export declare class TieredJxlContextImpl extends CapabilityAwareContext {
    private readonly mtScheduler;
    private readonly stScheduler;
    private readonly router;
    constructor(params: {
        mtFactory: WorkerFactory;
        stFactory: WorkerFactory;
        opts: ContextOptions | undefined;
        maxWorkers: number;
        visibleGraceMs?: number;
    });
    decode(opts: DecodeOptions): DecodeSession;
    encode(opts: EncodeOptions): EncodeSession;
    shutdown(): Promise<void>;
}
export {};
//# sourceMappingURL=context-base.d.ts.map