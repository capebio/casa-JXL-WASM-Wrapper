// Shared JxlContext implementation. Environment-specific entry points live in
// context.ts and browser.ts so browser bundlers never see node worker imports.

import type {
  ContextOptions,
  DecodeOptions,
  DecodeSession,
  EncodeOptions,
  EncodeSession,
  Capabilities,
} from "@casabio/jxl-core";
import {
  Scheduler,
  type WorkerFactory,
  globalCoreBudget,
  defaultCoreBudgetCapacity,
  MemoryWeightedAdmissionGate,
  type AdmissionGate,
  type Priority,
  type CoreBudget,
} from "@casabio/jxl-scheduler";

import { DecodeSessionImpl } from "./decode-session.js";
import { EncodeSessionImpl } from "./encode-session.js";
import { shouldUseMtImmediately, type PoolPressureMetrics } from "./tier-routing.js";

// JxlContext is the jxl-session surface (spec Section 5). It is defined here,
// not in jxl-core, because jxl-core carries no runtime and no facade types.
export interface JxlContext {
  decode(opts: DecodeOptions): DecodeSession;
  encode(opts: EncodeOptions): EncodeSession;
  capabilities(): Capabilities;
  shutdown(): Promise<void>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

// Allowed URL schemes for the caller-supplied wasmUrl (task 007-security-a1b2c3d4).
const ALLOWED_WASM_URL_PREFIXES = ["https://", "http://", "blob:", "/"];

export function validateWasmUrl(url: string): void {
  if (!ALLOWED_WASM_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    throw new Error(
      `[jxl-session] wasmUrl must start with https://, http://, blob:, or / (got: ${JSON.stringify(url.slice(0, 64))})`,
    );
  }
}

// Validate that a probe result has the shape of a Capabilities object.
// Guards against supply-chain or service-worker tampering (task 007-security-e5f6g7h8 /
// 007-contracts-4j5k6l). Returns null when the result is not structurally valid.
function validateCapabilities(value: unknown): Capabilities | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v["wasm"] !== "boolean" ||
    typeof v["wasmSimd"] !== "boolean" ||
    typeof v["wasmRelaxedSimd"] !== "boolean" ||
    typeof v["wasmThreads"] !== "boolean" ||
    typeof v["crossOriginIsolated"] !== "boolean" ||
    typeof v["sharedArrayBuffer"] !== "boolean" ||
    typeof v["offscreenCanvas"] !== "boolean" ||
    typeof v["imageBitmap"] !== "boolean" ||
    typeof v["nativeJxlDecoder"] !== "boolean" ||
    typeof v["selectedWasmBuild"] !== "string" ||
    typeof v["libjxlVersion"] !== "string"
  ) {
    return null;
  }
  return value as Capabilities;
}

// navigator.hardwareConcurrency is available in browsers and Node >= 21.
export function hardwareConcurrency(): number {
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
  return nav?.hardwareConcurrency ?? 4;
}

// Conservative capabilities used until the async probe resolves, and as the
// permanent value if the probe is unavailable.
function defaultCapabilities(): Capabilities {
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

export function computeWorkerCostForWasmUrl(url: string | undefined): number {
  if (!url) return 1;
  try {
    const u = new URL(url, "https://dummy.invalid");
    const tier = u.searchParams.get("jxlWorkerTier");
    if (tier === "relaxed-simd-mt" || tier === "simd-mt") {
      return defaultCoreBudgetCapacity();
    }
  } catch {
    // malformed url -> conservative ST cost
  }
  return 1;
}

// Shared across every scheduler/context (like globalCoreBudget) so the byte budget bounds
// total concurrent decode/encode memory, not per-scheduler memory. Lazily created on first
// opt-in; the first budget wins (subsequent budgets are ignored, mirroring globalCoreBudget).
const DEFAULT_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;
let globalMemoryGate: MemoryWeightedAdmissionGate | undefined;
function getGlobalMemoryGate(budgetBytes: number | undefined): AdmissionGate {
  if (globalMemoryGate === undefined) {
    globalMemoryGate = new MemoryWeightedAdmissionGate({
      budgetBytes: budgetBytes ?? DEFAULT_MEMORY_BUDGET_BYTES,
    });
  }
  return globalMemoryGate;
}

function createScheduler(factory: WorkerFactory, opts: ContextOptions | undefined, maxWorkers: number, workerCost: number): Scheduler {
  const useMemoryGate = opts?.memoryGate === true;
  // With the memory gate, the byte budget is the concurrency limiter, so raise the worker
  // ceiling past the flat default; without it, keep the caller's maxWorkers unchanged.
  const effectiveMaxWorkers = useMemoryGate
    ? Math.max(maxWorkers, 2 * hardwareConcurrency())
    : maxWorkers;
  return new Scheduler({
    factory,
    maxWorkers: effectiveMaxWorkers,
    idleTimeoutMs: opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    ...(opts?.pushHwm !== undefined ? { pushHwm: opts.pushHwm } : {}),
    coreBudget: globalCoreBudget,
    workerCost,
    ...(useMemoryGate ? { admissionGate: getGlobalMemoryGate(opts?.memoryCapBytes) } : {}),
  });
}

abstract class CapabilityAwareContext implements JxlContext {
  protected caps: Capabilities = defaultCapabilities();
  protected shuttingDown = false;
  protected probeSettled = false;

  abstract decode(opts: DecodeOptions): DecodeSession;
  abstract encode(opts: EncodeOptions): EncodeSession;
  abstract shutdown(): Promise<void>;

  probeCapabilities(): void {
    void (async () => {
      try {
        const mod = await import("@casabio/jxl-capabilities");
        const raw: unknown = await mod.getCapabilities();
        const validated = validateCapabilities(raw);
        if (validated !== null && !this.shuttingDown) {
          this.caps = validated;
        }
      } catch (e) {
        // Probe unavailable - keep the conservative default.
        console.warn("[jxl-session] probeCapabilities failed (using defaults):", e);
      } finally {
        this.probeSettled = true;
      }
    })();
  }

  capabilities(): Capabilities {
    return this.caps;
  }
}

export interface SchedulerMetricsSource {
  getMetrics(): PoolPressureMetrics;
}

export function createTieredSchedulerRouter<TMt extends SchedulerMetricsSource, TSt>(params: {
  mtScheduler: TMt;
  stScheduler: TSt;
  mtCost: number;
  maxWorkers: number;
  coreBudget: CoreBudget;
  visibleGraceMs: number;
  sleep?: (ms: number) => Promise<void>;
}): { pick(priority: Priority): Promise<TMt | TSt> } {
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const canUseMtNow = (): boolean => shouldUseMtImmediately(
    params.mtScheduler.getMetrics(),
    params.maxWorkers,
    params.coreBudget.available,
    params.mtCost,
  );

  return {
    async pick(priority: Priority): Promise<TMt | TSt> {
      if (priority === "visible") {
        if (canUseMtNow()) return params.mtScheduler;
        await sleep(params.visibleGraceMs);
        return canUseMtNow() ? params.mtScheduler : params.stScheduler;
      }
      return canUseMtNow() ? params.mtScheduler : params.stScheduler;
    },
  };
}

export class JxlContextImpl extends CapabilityAwareContext {
  private readonly scheduler: Scheduler;

  constructor(factory: WorkerFactory, opts: ContextOptions | undefined, maxWorkers: number) {
    super();
    const workerCost = computeWorkerCostForWasmUrl(opts?.wasmUrl);
    this.scheduler = createScheduler(factory, opts, maxWorkers, workerCost);
  }

  decode(opts: DecodeOptions): DecodeSession {
    if (this.shuttingDown) {
      throw new Error("[jxl-session] decode() called after shutdown()");
    }
    return new DecodeSessionImpl(this.scheduler, opts);
  }

  encode(opts: EncodeOptions): EncodeSession {
    if (this.shuttingDown) {
      throw new Error("[jxl-session] encode() called after shutdown()");
    }
    return new EncodeSessionImpl(this.scheduler, opts);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.scheduler.shutdown();
  }
}

export class TieredJxlContextImpl extends CapabilityAwareContext {
  private readonly mtScheduler: Scheduler;
  private readonly stScheduler: Scheduler;
  private readonly router: { pick(priority: Priority): Promise<Scheduler> };

  constructor(params: {
    mtFactory: WorkerFactory;
    stFactory: WorkerFactory;
    opts: ContextOptions | undefined;
    maxWorkers: number;
    visibleGraceMs?: number;
  }) {
    super();
    const mtCost = computeWorkerCostForWasmUrl(params.opts?.wasmUrl);
    this.mtScheduler = createScheduler(params.mtFactory, params.opts, params.maxWorkers, mtCost);
    this.stScheduler = createScheduler(params.stFactory, params.opts, params.maxWorkers, 1);
    this.router = createTieredSchedulerRouter({
      mtScheduler: {
        getMetrics: (): PoolPressureMetrics => {
          const metrics = this.mtScheduler.getMetrics() as any;
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
    }) as { pick(priority: Priority): Promise<Scheduler> };
  }

  decode(opts: DecodeOptions): DecodeSession {
    if (this.shuttingDown) {
      throw new Error("[jxl-session] decode() called after shutdown()");
    }
    return new DecodeSessionImpl(this.router.pick(opts.priority ?? "visible"), opts);
  }

  encode(opts: EncodeOptions): EncodeSession {
    if (this.shuttingDown) {
      throw new Error("[jxl-session] encode() called after shutdown()");
    }
    return new EncodeSessionImpl(this.router.pick(opts.priority ?? "visible"), opts);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all([this.mtScheduler.shutdown(), this.stScheduler.shutdown()]);
  }
}
