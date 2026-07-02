// jxl-scheduler/src/index.ts

export { Scheduler } from "./scheduler.js";
export type { SchedulerOptions } from "./scheduler.js";
export { WorkerPool } from "./pool.js";
export { PriorityQueue } from "./queue.js";
export { DedupeRegistry } from "./dedupe.js";
export { CoreBudget, defaultCoreBudgetCapacity, globalCoreBudget } from "./budget.js";
export { MemoryWeightedAdmissionGate } from "./memory-admission-gate.js";
export type { MemoryWeightedAdmissionGateOptions } from "./memory-admission-gate.js";
export type { Priority, PoolWorker, WorkerHandle, WorkerFactory, AdmissionRelease, AdmissionGate } from "./types.js";
