import type { AdmissionGate, AdmissionRelease, Priority } from "./types.js";
export interface MemoryWeightedAdmissionGateOptions {
    /** Byte capacity the running decode set must fit under. Default 512 MB (fits wasm32). */
    budgetBytes?: number;
    /** Weight applied when admit() is called without a weight. Default 256 MB (≈ one full decode). */
    defaultWeightBytes?: number;
}
export declare class MemoryWeightedAdmissionGate implements AdmissionGate {
    private readonly budgetBytes;
    private readonly defaultWeightBytes;
    private _runningBytes;
    private readonly waiters;
    constructor(opts?: MemoryWeightedAdmissionGateOptions);
    /** Bytes currently reserved by admitted-but-not-released tasks. */
    get runningBytes(): number;
    /** Number of tasks waiting for budget. */
    get pendingCount(): number;
    admit(sessionId: string, priority: Priority, weight?: number): Promise<AdmissionRelease>;
    private normalizeWeight;
    private insertWaiter;
    private fits;
    private makeRelease;
    private drain;
}
//# sourceMappingURL=memory-admission-gate.d.ts.map