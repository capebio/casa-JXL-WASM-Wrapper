// Shared JxlContext implementation. Environment-specific entry points live in
// context.ts and browser.ts so browser bundlers never see node worker imports.
import { Scheduler, globalCoreBudget, defaultCoreBudgetCapacity, } from "@casabio/jxl-scheduler";
import { DecodeSessionImpl } from "./decode-session.js";
import { EncodeSessionImpl } from "./encode-session.js";
import { shouldUseMtImmediately } from "./tier-routing.js";
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
// Allowed URL schemes for the caller-supplied wasmUrl (task 007-security-a1b2c3d4).
const ALLOWED_WASM_URL_PREFIXES = ["https://", "http://", "blob:", "/"];
export function validateWasmUrl(url) {
    if (!ALLOWED_WASM_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
        throw new Error(`[jxl-session] wasmUrl must start with https://, http://, blob:, or / (got: ${JSON.stringify(url.slice(0, 64))})`);
    }
}
// Validate that a probe result has the shape of a Capabilities object.
// Guards against supply-chain or service-worker tampering (task 007-security-e5f6g7h8 /
// 007-contracts-4j5k6l). Returns null when the result is not structurally valid.
function validateCapabilities(value) {
    if (value === null || typeof value !== "object")
        return null;
    const v = value;
    if (typeof v["wasm"] !== "boolean" ||
        typeof v["wasmSimd"] !== "boolean" ||
        typeof v["wasmRelaxedSimd"] !== "boolean" ||
        typeof v["wasmThreads"] !== "boolean" ||
        typeof v["crossOriginIsolated"] !== "boolean" ||
        typeof v["sharedArrayBuffer"] !== "boolean" ||
        typeof v["offscreenCanvas"] !== "boolean" ||
        typeof v["imageBitmap"] !== "boolean" ||
        typeof v["nativeJxlDecoder"] !== "boolean" ||
        typeof v["selectedWasmBuild"] !== "string" ||
        typeof v["libjxlVersion"] !== "string") {
        return null;
    }
    return value;
}
// navigator.hardwareConcurrency is available in browsers and Node >= 21.
export function hardwareConcurrency() {
    const nav = globalThis.navigator;
    return nav?.hardwareConcurrency ?? 4;
}
// Conservative capabilities used until the async probe resolves, and as the
// permanent value if the probe is unavailable.
function defaultCapabilities() {
    return {
        wasm: typeof WebAssembly !== "undefined",
        wasmSimd: false,
        wasmRelaxedSimd: false,
        wasmThreads: false,
        crossOriginIsolated: false,
        sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
        offscreenCanvas: false,
        imageBitmap: false,
        nativeJxlDecoder: false,
        selectedWasmBuild: "none",
        libjxlVersion: "unknown",
    };
}
export function computeWorkerCostForWasmUrl(url) {
    if (!url)
        return 1;
    try {
        const u = new URL(url, "https://dummy.invalid");
        const tier = u.searchParams.get("jxlWorkerTier");
        if (tier === "relaxed-simd-mt" || tier === "simd-mt") {
            return defaultCoreBudgetCapacity();
        }
    }
    catch {
        // malformed url -> conservative ST cost
    }
    return 1;
}
function createScheduler(factory, opts, maxWorkers, workerCost, prewarmSize) {
    return new Scheduler({
        factory,
        maxWorkers,
        idleTimeoutMs: opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
        ...(opts?.pushHwm !== undefined ? { pushHwm: opts.pushHwm } : {}),
        // TTFP-3: prewarmSize is an explicit parameter (not read from opts) so the
        // tiered context can prewarm only the scheduler its first pick will hit.
        ...(prewarmSize !== undefined && prewarmSize > 0 ? { prewarmSize } : {}),
        coreBudget: globalCoreBudget,
        workerCost,
    });
}
class CapabilityAwareContext {
    caps = defaultCapabilities();
    shuttingDown = false;
    probeSettled = false;
    probeCapabilities() {
        void (async () => {
            try {
                const mod = await import("@casabio/jxl-capabilities");
                const raw = await mod.getCapabilities();
                const validated = validateCapabilities(raw);
                if (validated !== null && !this.shuttingDown) {
                    this.caps = validated;
                }
            }
            catch (e) {
                // Probe unavailable - keep the conservative default.
                console.warn("[jxl-session] probeCapabilities failed (using defaults):", e);
            }
            finally {
                this.probeSettled = true;
            }
        })();
    }
    capabilities() {
        return this.caps;
    }
}
export function createTieredSchedulerRouter(params) {
    const sleep = params.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const canUseMtNow = () => shouldUseMtImmediately(params.mtScheduler.getMetrics(), params.maxWorkers, params.coreBudget.available, params.mtCost);
    return {
        async pick(priority) {
            if (priority === "visible") {
                if (canUseMtNow())
                    return params.mtScheduler;
                await sleep(params.visibleGraceMs);
                return canUseMtNow() ? params.mtScheduler : params.stScheduler;
            }
            return canUseMtNow() ? params.mtScheduler : params.stScheduler;
        },
    };
}
export class JxlContextImpl extends CapabilityAwareContext {
    scheduler;
    constructor(factory, opts, maxWorkers) {
        super();
        const workerCost = computeWorkerCostForWasmUrl(opts?.wasmUrl);
        this.scheduler = createScheduler(factory, opts, maxWorkers, workerCost, opts?.prewarmSize);
    }
    decode(opts) {
        if (this.shuttingDown) {
            throw new Error("[jxl-session] decode() called after shutdown()");
        }
        return new DecodeSessionImpl(this.scheduler, opts);
    }
    encode(opts) {
        if (this.shuttingDown) {
            throw new Error("[jxl-session] encode() called after shutdown()");
        }
        return new EncodeSessionImpl(this.scheduler, opts);
    }
    async shutdown() {
        this.shuttingDown = true;
        await this.scheduler.shutdown();
    }
}
export class TieredJxlContextImpl extends CapabilityAwareContext {
    mtScheduler;
    stScheduler;
    router;
    constructor(params) {
        super();
        const mtCost = computeWorkerCostForWasmUrl(params.opts?.wasmUrl);
        // TTFP-3: prewarm only the MT scheduler — with a fresh pool and untouched
        // core budget the router's first pick is MT, so an ST prewarm would spawn
        // a second speculative worker (+ a second ~MB-scale WASM fetch) for a
        // scheduler the first decode does not hit.
        this.mtScheduler = createScheduler(params.mtFactory, params.opts, params.maxWorkers, mtCost, params.opts?.prewarmSize);
        this.stScheduler = createScheduler(params.stFactory, params.opts, params.maxWorkers, 1);
        this.router = createTieredSchedulerRouter({
            mtScheduler: {
                getMetrics: () => {
                    const metrics = this.mtScheduler.getMetrics();
                    return {
                        poolIdle: metrics.poolIdle,
                        poolSize: metrics.poolSize,
                        poolSpawning: metrics.poolSpawning,
                    };
                },
            },
            stScheduler: this.stScheduler,
            mtCost,
            maxWorkers: params.maxWorkers,
            coreBudget: globalCoreBudget,
            visibleGraceMs: params.visibleGraceMs ?? 16,
        });
    }
    decode(opts) {
        if (this.shuttingDown) {
            throw new Error("[jxl-session] decode() called after shutdown()");
        }
        return new DecodeSessionImpl(this.router.pick(opts.priority ?? "visible"), opts);
    }
    encode(opts) {
        if (this.shuttingDown) {
            throw new Error("[jxl-session] encode() called after shutdown()");
        }
        return new EncodeSessionImpl(this.router.pick(opts.priority ?? "visible"), opts);
    }
    async shutdown() {
        this.shuttingDown = true;
        await Promise.all([this.mtScheduler.shutdown(), this.stScheduler.shutdown()]);
    }
}
//# sourceMappingURL=context-base.js.map