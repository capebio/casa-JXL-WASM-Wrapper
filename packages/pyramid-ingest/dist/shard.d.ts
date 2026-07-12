/**
 * Compute safe concurrency bounded by cores, explicit request, and mem budget.
 * PER_IMAGE_BYTES guard prevents OOM on high-MP masters.
 */
export declare function boundedConcurrency(avail: number, requested: number | undefined, memBudgetBytes: number, perImageBytes: number): number;
/**
 * 0-based shard split for --shard i/N deterministic partition.
 * Used for fan-out across machines / processes without overlap.
 * n<=0 => all (no sharding); i<0 or i>=n => [] (empty for this worker).
 */
export declare function planShard<T>(items: readonly T[], i: number, n: number): T[];
//# sourceMappingURL=shard.d.ts.map