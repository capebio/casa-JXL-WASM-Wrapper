// Browser-only public entry. Package "browser" condition points here so browser
// bundlers do not parse createNodeContext or @casabio/jxl-worker-node.

import type { ContextOptions } from "@casabio/jxl-core";
import type { WorkerFactory } from "@casabio/jxl-scheduler";

import {
  hardwareConcurrency,
  JxlContextImpl,
  TieredJxlContextImpl,
  validateWasmUrl,
  type JxlContext,
} from "./context-base.js";
import { isMtRequestedTier, parseRequestedWorkerTier, withWorkerTier } from "./tier-routing.js";

export type { JxlContext } from "./context-base.js";
export { DecodeSessionImpl } from "./decode-session.js";
export { EncodeSessionImpl } from "./encode-session.js";
export { AsyncEventStream } from "./event-stream.js";
export { JxlError } from "@casabio/jxl-core/errors";

// Re-export the core contract types so callers import from one place.
export type {
  ContextOptions,
  DecodeOptions,
  DecodeSession,
  DecodeFrameEvent,
  EncodeOptions,
  EncodeSession,
  EncodeStats,
  ImageInfo,
  Capabilities,
  PixelFormat,
  Region,
  CodecMetric,
} from "@casabio/jxl-core";
export type { JxlErrorCode } from "@casabio/jxl-core/errors";

export function createBrowserContext(opts?: ContextOptions): JxlContext {
  const poolSize = opts?.poolSize ?? Math.max(1, Math.min(4, hardwareConcurrency() - 1));
  // TTFP-3: prewarm one worker by default so the first decode hits a spawned
  // worker (which also boot-loads its WASM — see jxl-worker-browser worker.ts)
  // instead of paying spawn + fetch + compile serially. Pass prewarmSize: 0 to
  // opt out; the pool's idle reap (idleTimeoutMs) covers never-used prewarms.
  const effectiveOpts: ContextOptions = { ...opts, prewarmSize: opts?.prewarmSize ?? 1 };

  if (opts?.wasmUrl !== undefined) {
    validateWasmUrl(opts.wasmUrl);
  }

  const factoryForUrl = (workerUrl: string | undefined): WorkerFactory => async () => {
    const mod = await import("@casabio/jxl-worker-browser");
    return mod.spawnWorker(workerUrl) as unknown as Awaited<ReturnType<WorkerFactory>>;
  };

  const requestedTier = parseRequestedWorkerTier(opts?.wasmUrl);
  const ctx = isMtRequestedTier(requestedTier)
    ? new TieredJxlContextImpl({
      mtFactory: factoryForUrl(withWorkerTier(opts?.wasmUrl, requestedTier)),
      stFactory: factoryForUrl(withWorkerTier(opts?.wasmUrl, "simd")),
      opts: effectiveOpts,
      maxWorkers: poolSize,
    })
    : new JxlContextImpl(factoryForUrl(opts?.wasmUrl), effectiveOpts, poolSize);
  ctx.probeCapabilities();
  return ctx;
}
