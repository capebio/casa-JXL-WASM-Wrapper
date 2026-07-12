import {
  canUseParallelTileWorkers,
  canShareContainerBytes,
  parseJxtcHeader,
  type ImageRegion,
} from "./tiling.js";
import type { LevelSource } from "./level-source.js";
import {
  stitch,
  type RegionDecoder,
  type DecodedLevel,
  PyramidError,
  type DecodeOptions,
  type TileId,
  viewportCacheKey,
  type PixelFormat,
  bppOfFormat,
  ensureIccProfile,
  validateDecodedOutput,
  tileKey,
  tileIdOf,
  type TileProgress,
  buffersInFlight,
  raceWithAbort,
  cacheStore,
  assertFiniteRegion,
  snapRegionToIntegers,
  stitchCropped,
  type PyramidPoolLike,
} from "./decode-core.js";
import { getLevelId, makeTileCacheKey, type PyramidCache } from "./cache.js";
import { prepareDecodePlan } from "./plan.js";
import type { WorkerRequest, WorkerReply, WorkerErrorCode } from "./worker-protocol.js";
// CoreBudget shape (from jxl-scheduler) for opt-in cross-pool limiting (Agent6-1). Loose to avoid package dep in tsc.

// Grok 3 state enums
export enum PoolState {
  Created = 'created',
  Prewarming = 'prewarming',
  Active = 'active',
  Draining = 'draining',
  Destroyed = 'destroyed',
}

export enum HandleState {
  WarmFloor = 'warm-floor',
  WarmReapable = 'warm-reapable',
  Active = 'active',
  Bad = 'bad',
  Terminated = 'terminated',
}

const DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

// Grok3 #16 single transition fn with table. Invalid throws in dev.
const ALLOWED_TRANSITIONS: Record<HandleState, Record<HandleState, boolean>> = {
  [HandleState.WarmFloor]: { [HandleState.Active]: true, [HandleState.Bad]: true, [HandleState.Terminated]: true },
  [HandleState.WarmReapable]: { [HandleState.Active]: true, [HandleState.Bad]: true, [HandleState.Terminated]: true },
  [HandleState.Active]: { [HandleState.WarmReapable]: true, [HandleState.Bad]: true, [HandleState.Terminated]: true },
  [HandleState.Bad]: { [HandleState.Terminated]: true },
  [HandleState.Terminated]: {},
};

function setHandleState(h: WorkerHandle, next: HandleState, failureInfo?: { code: WorkerErrorCode; message: string; at: number; count: number }) {
  const cur = h.state;
  if (DEV && !ALLOWED_TRANSITIONS[cur]?.[next] && cur !== next) {
    throw new Error(`invalid handle state transition ${cur} -> ${next}`);
  }
  h.state = next;
  if (failureInfo) h.failure = { ...failureInfo, count: (h.failure?.count || 0) + 1 };
}

type WorkerLike = {
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (ev: { data?: any }) => void,
  ): void;
  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener: (ev: { data?: any }) => void,
  ): void;
  postMessage(data: WorkerRequest, transfer?: any[]): void;
  terminate(): void;
};

type ParallelRuntime = {
  Worker?: new (url: string | URL, options?: { type?: string }) => WorkerLike;
  navigator?: { hardwareConcurrency?: number };
  crossOriginIsolated?: boolean;
  SharedArrayBuffer?: typeof SharedArrayBuffer;
};

interface PendingJob {
  id: number;
  resolve: (d: DecodedLevel) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
  requestTimer: ReturnType<typeof globalThis.setTimeout> | null;
  abortSignal?: AbortSignal | undefined;
  abortListener?: (() => void) | null;
  expectedBytes?: number | undefined;
  bytesPerPixel?: 4 | 8 | undefined;
}

function decodeTileWithWorker(
  h: WorkerHandle,
  bytesId: number,
  region: ImageRegion,
  format: 'rgba8' | 'rgba16',
  deadlineMs?: number,
  signal?: AbortSignal,
  requestTimeoutMs?: number,
  progressiveStage?: 'dc' | 'final',
): Promise<DecodedLevel> {
  setHandleState(h, HandleState.Active);
  const id = ++h.nextId;
  return new Promise<DecodedLevel>((resolve, reject) => {
    let settled = false;
    const doResolve = (d: DecodedLevel) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(d);
    };
    const doReject = (e: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    };
    const job: PendingJob = {
      id,
      resolve: doResolve,
      reject: doReject,
      timer: null,
      requestTimer: null,
      abortSignal: signal,
      abortListener: null,
      expectedBytes: region.w * region.h * bppOfFormat(format),
      bytesPerPixel: bppOfFormat(format),
    };
    h.pending.set(id, job);

    // request timeout (Grok3 #23)
    if (requestTimeoutMs && requestTimeoutMs > 0) {
      job.requestTimer = globalThis.setTimeout(() => {
        if (h.pending.has(id)) {
          cleanup();
          setHandleState(h, HandleState.Bad, { code: 'TIMEOUT', message: 'request timeout', at: Date.now(), count: 1 });
          try { h.worker.terminate(); } catch {}
          doReject(new PyramidError('TIMEOUT', `worker request timeout for tile ${id}`));
        }
      }, requestTimeoutMs);
    }

    // watchdog + timeout (only arm if requestTimer does not exist)
    if (!job.requestTimer) {
      const watchdogMs = Math.max(10_000, (requestTimeoutMs ?? 0) * 1.5);
      job.timer = globalThis.setTimeout(() => {
        if (h.pending.has(id)) {
          cleanup();
          setHandleState(h, HandleState.Bad);
          try { h.worker.terminate(); } catch {}
          doReject(new PyramidError('TIMEOUT', `worker watchdog timeout for tile ${id}`));
        }
      }, watchdogMs);
    }

    if (signal) {
      if (signal.aborted) {
        cleanup();
        try { h.worker.postMessage({ v: 1, type: 'cancel', id }); } catch {}
        doReject(new PyramidError('ABORTED', 'decode aborted before start'));
        return;
      }
      job.abortListener = () => {
        if (h.pending.has(id)) {
          cleanup();
          try { h.worker.postMessage({ v: 1, type: 'cancel', id }); } catch {}
          doReject(new PyramidError('ABORTED', 'decode aborted'));
        }
      };
      signal.addEventListener("abort", job.abortListener, { once: true });
    }

    const req: WorkerRequest = {
      v: 1,
      type: 'decode',
      id,
      bytesId,
      region,
      format,
      ...(deadlineMs != null ? { deadlineMs } : {}),
      ...(progressiveStage ? { progressiveStage } : {}),
    } as WorkerRequest;
    try {
      h.worker.postMessage(req);
    } catch (postErr) {
      cleanup();
      setHandleState(h, HandleState.Bad);
      try { h.worker.terminate(); } catch {}
      doReject(postErr);
    }
  });

  function cleanup() {
    const j = h.pending.get(id);
    if (j?.abortSignal && j.abortListener) {
      j.abortSignal.removeEventListener('abort', j.abortListener);
      j.abortListener = null;
    }
    if (j && j.timer != null) {
      globalThis.clearTimeout(j.timer);
      j.timer = null;
    }
    if (j && j.requestTimer != null) {
      globalThis.clearTimeout(j.requestTimer);
      j.requestTimer = null;
    }
    h.pending.delete(id);
  }
}

/**
 * Persistent warmed worker pool for pyramid tile decodes (Grok2 protocol).
 * Uses load/decode split + bytesId to eliminate structured-clone amplification.
 * Supports readiness, best-effort cancel, 16-bit via format, parse validation.
 */
type WorkerHandle = {
  worker: WorkerLike;
  idleTimer: ReturnType<typeof globalThis.setTimeout> | null;
  state: HandleState;
  pending: Map<number, PendingJob>;
  nextId: number;
  ready: Promise<void>;
  /** resolved when first 'ready' arrives */
  _readyResolve?: (v?: unknown) => void;
  readySettled?: boolean;
  failure?: { code: WorkerErrorCode; message: string; at: number; count: number };
  budgetCharged?: boolean;
  inIdle?: boolean; // tracks if in idle list (Grok3 #38)
};

export class PyramidWorkerPool {
  private readonly factory: () => WorkerLike;
  private readonly maxSize: number;
  private readonly idleTimeoutMs: number;
  private readonly minIdle: number;
  private readonly requestTimeoutMs: number | undefined;
  private readonly lifecycle: { hookVisibility?: boolean; hookFreeze?: boolean };
  /** Optional CoreBudget for cross-pool core limiting (with scheduler). Acquire around handle batch (Agent6-1). */
  private readonly coreBudget: { acquire(cost?: number): Promise<void>; release(cost?: number): void; tryAcquire(cost?: number): boolean; } | null = null;
  private readonly workerCost: number = 1;

  private state: PoolState = PoolState.Created;
  private readonly all = new Set<WorkerHandle>();
  private readonly idle: WorkerHandle[] = []; // LIFO for hottest caches (Grok3 #18)
  private readonly active = new Set<WorkerHandle>();
  private readonly handleByWorker = new WeakMap<WorkerLike, WorkerHandle>();

  // bytesId tracking per worker (for load-once)
  private readonly bytesIdByWorker = new WeakMap<WorkerLike, Set<number>>();
  private readonly bytesIdBySource = new WeakMap<Extract<LevelSource, { kind: "tiled" }>, number>();
  private readonly sabByBytesId = new Map<number, SharedArrayBuffer>();

  // instance-scoped (not module) per Grok2/3
  private nextBytesId = 0;

  // waiter queue for over-cap (Grok3 #26-29)
  private readonly waiters: Array<{ want: number; resolve: (handles: WorkerHandle[]) => void; expiresAt?: number; timer?: ReturnType<typeof globalThis.setTimeout> }> = [];
  private visibilityDocument: { addEventListener?: (type: string, listener: () => void) => void; removeEventListener?: (type: string, listener: () => void) => void; visibilityState?: string } | null = null;
  private visibilityListener: (() => void) | null = null;

  // module consts evaluated once (Grok3 #38-39)
  // (HWC / CAN_PARALLEL live at module scope below)

  constructor(opts: {
    factory: () => WorkerLike;
    maxSize: number;
    idleTimeoutMs: number;
    minIdle?: number;
    requestTimeoutMs?: number;
    lifecycle?: { hookVisibility?: boolean; hookFreeze?: boolean };
    prewarm?: 'eager' | 'lazy' | 'on-demand';
    /** Opt-in CoreBudget (e.g. globalCoreBudget) to bound total WASM workers across scheduler + pyramid. */
    coreBudget?: { acquire(cost?: number): Promise<void>; release(cost?: number): void; tryAcquire(cost?: number): boolean; } | undefined;
    /** Tokens per worker handle (default 1; tile work lighter than full MT session). */
    workerCost?: number;
  }) {
    this.factory = opts.factory;
    this.maxSize = Math.max(1, opts.maxSize);
    this.idleTimeoutMs = Math.max(0, opts.idleTimeoutMs);
    this.minIdle = Math.max(0, Math.min(opts.minIdle ?? 1, this.maxSize));
    this.requestTimeoutMs = opts.requestTimeoutMs;
    this.lifecycle = { hookVisibility: true, hookFreeze: true, ...(opts.lifecycle || {}) };
    this.prewarmMode = opts.prewarm || 'eager';
    this.coreBudget = opts.coreBudget ?? null;
    this.workerCost = Math.max(1, opts.workerCost ?? 1);

    // browser cooperation hooks (Grok3 #30-33)
    const doc = (globalThis as any).document;
    if (doc && this.lifecycle.hookVisibility) {
      this.visibilityDocument = doc;
      this.visibilityListener = () => {
        if (doc.visibilityState === 'hidden') this.reapAllIdle();
        else this.prewarm(this.minIdle);
      };
      doc.addEventListener?.('visibilitychange', this.visibilityListener);
    }
    // Note: 'freeze'/'resume' Page Lifecycle would be added similarly if document has the events.

    if (this.prewarmMode === 'eager') {
      void this.prewarmAsync(this.minIdle).catch(e => {
        if (DEV) console.warn('[pyramid] eager prewarm failed:', e);
      });
    }
  }

  private prewarmMode: 'eager' | 'lazy' | 'on-demand' = 'eager';

  get destroyed(): boolean {
    return this.state === PoolState.Destroyed;
  }

  get poolState(): PoolState {
    return this.state;
  }

  get size(): number {
    return this.all.size;
  }

  get activeCount(): number {
    return this.active.size;
  }

  get requestTimeout(): number | undefined {
    return this.requestTimeoutMs;
  }

  /** Allocate a bytesId for a LevelSource (lazily attached). */
  allocateBytesId(source: Extract<LevelSource, { kind: "tiled" }>): number {
    const existing = this.bytesIdBySource.get(source);
    if (existing != null) return existing;
    const id = this.nextBytesId++;
    this.bytesIdBySource.set(source, id);
    return id;
  }

  /** prewarm becomes async, resolves when spawned workers are ready (Grok3 #34). */
  async prewarmAsync(count: number): Promise<void> {
    if (this.state === PoolState.Destroyed || this.state === PoolState.Draining) return;
    if (this.state === PoolState.Prewarming || this.state === PoolState.Active) return;
    this.state = PoolState.Prewarming;
    const n = Math.min(count, this.maxSize - this.all.size);
    const spawned: WorkerHandle[] = [];
    for (let i = 0; i < n; i++) {
      const h = this.spawnOne();
      h.inIdle = true;
      this.idle.push(h);
      this.armIdleTimer(h);
      spawned.push(h);
    }
    if (spawned.length === 0) { this.state = PoolState.Active; return; }
    await Promise.all(spawned.map(h => h.ready.catch(() => {})));
    this.state = PoolState.Active;
  }

  prewarm(count: number): void {
    // sync fire-and-forget for back compat; use prewarmAsync for readiness
    void this.prewarmAsync(count);
  }

  /** whenReady for UI "warming" (Grok3 #36) */
  whenReady(): Promise<void> {
    const have = () => this.idle.length + this.active.size;
    if (have() >= this.minIdle) return Promise.resolve();
    const pending = [...this.all]
      .filter((h) => !h.readySettled)
      .map((h) => h.ready.catch(() => {}));
    return Promise.all(pending).then(() => {});
  }

  /** Full destroy per Grok3 #9. */
  async destroy(graceMs = 5000): Promise<void> {
    if (this.state === PoolState.Destroyed) return;
    this.state = PoolState.Draining;
    for (const waiter of this.waiters.splice(0)) waiter.resolve([]);

    // reject all inflight with POOL_DESTROYED
    for (const h of this.all) {
      for (const job of h.pending.values()) {
        try { job.reject(new PyramidError('POOL_DESTROYED', 'pool destroyed')); } catch {}
      }
    }

    // destroy idles (ignore minIdle floor)
    for (const h of [...this.idle]) {
      this.destroyHandle(h, 'pool destroy');
    }
    this.idle.length = 0;

    // wait for active to drain or grace
    let iv: ReturnType<typeof globalThis.setInterval> | null = null;
    const drained = new Promise<void>(r => {
      iv = globalThis.setInterval(() => {
        if (this.active.size === 0) { if (iv) globalThis.clearInterval(iv); r(); }
      }, 10);
    });
    await Promise.race([drained, new Promise(r => globalThis.setTimeout(r, graceMs))]);
    if (iv) globalThis.clearInterval(iv);

    // force remaining
    for (const h of [...this.active]) {
      this.destroyHandle(h, 'pool destroy grace');
    }

    this.state = PoolState.Destroyed;
    this.sabByBytesId.clear();
    if (this.visibilityDocument && this.visibilityListener) {
      this.visibilityDocument.removeEventListener?.('visibilitychange', this.visibilityListener);
    }
    this.visibilityDocument = null;
    this.visibilityListener = null;
  }

  private releaseBudget(h: WorkerHandle) {
    if (h.budgetCharged && this.coreBudget) {
      this.coreBudget.release(this.workerCost);
      h.budgetCharged = false;
    }
  }

  private destroyHandle(h: WorkerHandle, reason: string) {
    if (h.state === HandleState.Terminated) return;
    this.releaseBudget(h);
    if (!h.readySettled) {
      h.readySettled = true;
      h._readyResolve?.();
    }
    for (const job of Array.from(h.pending.values())) {
      this.cleanupPendingJob(h, job);
      try { job.reject(new PyramidError('POOL_DESTROYED', reason)); } catch {}
    }
    setHandleState(h, HandleState.Terminated);
    this.clearIdleTimer(h);
    this.active.delete(h);
    if (h.inIdle) {
      const ii = this.idle.indexOf(h);
      if (ii >= 0) this.idle.splice(ii, 1);
      h.inIdle = false;
    }
    this.all.delete(h);
    this.bytesIdByWorker.delete(h.worker);
    try { h.worker.terminate(); } catch {}
  }

  /** reap all idle (for visibility hidden etc) */
  private reapAllIdle() {
    for (const h of [...this.idle]) {
      h.inIdle = false;
      this.destroyHandle(h, 'reap all');
    }
    this.idle.length = 0;
  }

  /**
   * Acquire (with waiter queue for over cap, LIFO idle, ready filter, state checks).
   */
  async acquire(count: number, opts?: { maxWaitMs?: number }): Promise<WorkerHandle[]> {
    if (this.state === PoolState.Destroyed || this.state === PoolState.Draining || count <= 0) {
      if (this.state === PoolState.Destroyed) throw new PyramidError('POOL_DESTROYED', 'pool destroyed');
      return [];
    }

    const maxWait = opts?.maxWaitMs ?? 60;
    const got: WorkerHandle[] = [];

    let activeLimit = count;
    if (this.coreBudget) {
      const c = this.workerCost;
      let granted = 0;
      for (let i = 0; i < count; i++) {
        if (this.coreBudget.tryAcquire(c)) {
          granted++;
        } else {
          break;
        }
      }
      if (granted === 0 && (this.idle.length > 0 || this.all.size < this.maxSize)) {
        await this.coreBudget.acquire(c);
        granted = 1;
      }
      activeLimit = granted;
    }

    // LIFO drain (pop hottest) (Grok3 #18)
    while (got.length < activeLimit && this.idle.length > 0) {
      const h = this.idle.pop()!;
      h.inIdle = false;
      this.clearIdleTimer(h);
      if (h.state !== HandleState.WarmReapable && h.state !== HandleState.WarmFloor) {
        this.destroyHandle(h, 'stale on acquire');
        continue;
      }
      setHandleState(h, HandleState.Active);
      this.active.add(h);
      if (this.coreBudget) {
        h.budgetCharged = true;
      }
      got.push(h);
    }

    // spawn under cap
    while (got.length < activeLimit && this.all.size < this.maxSize) {
      try {
        const h = this.spawnOne();
        setHandleState(h, HandleState.Active);
        this.active.add(h);
        if (this.coreBudget) {
          h.budgetCharged = true;
        }
        got.push(h);
      } catch (e) {
        if (DEV) console.warn('[pyramid] spawnOne failed during acquire:', e);
        break;
      }
    }

    // waiter queue if still short (Grok3 #26-29)
    if (got.length < count) {
      const need = count - got.length;
      if (this.all.size >= this.maxSize) {
        return new Promise<WorkerHandle[]>((resolve) => {
          const waiter: any = {
            want: need,
            resolve: (hs: WorkerHandle[]) => {
              if (waiter.timer) globalThis.clearTimeout(waiter.timer);
              resolve([...got, ...hs]);
            },
          };
          waiter.timer = globalThis.setTimeout(() => {
            const idx = this.waiters.indexOf(waiter);
            if (idx >= 0) {
              this.waiters.splice(idx, 1);
              waiter.timer = undefined;
              if (DEV && got.length < count) {
                console.warn(`[pyramid] acquire timeout: requested ${count}, got ${got.length}, pool at max ${this.maxSize}`);
              }
              resolve(got);
            }
          }, maxWait);
          this.waiters.push(waiter);
        });
      }
    }

    await Promise.race([
      Promise.all(got.map((h) => h.ready.catch(() => {}))),
      new Promise((resolve) => globalThis.setTimeout(resolve, maxWait)),
    ]);

    return got;
  }

  /** Return to idle (LIFO), drain waiters, arm all excess (Grok3 #19, #28). */
  release(handles: WorkerHandle[]): void {
    for (const h of handles) {
      this.active.delete(h);
      if (this.state === PoolState.Draining || this.state === PoolState.Destroyed || h.state === HandleState.Terminated || h.state === HandleState.Bad || !this.all.has(h) || h.pending.size > 0) {
        this.destroyHandle(h, 'release of dead/inflight');
        continue;
      }
      this.releaseBudget(h);
      setHandleState(h, HandleState.WarmReapable);
      h.inIdle = true;
      this.idle.push(h); // LIFO push
    }

    // drain waiters before re-arm (Grok3)
    while (this.waiters.length > 0 && this.idle.length > 0) {
      const w = this.waiters.shift()!;
      if (w.timer) globalThis.clearTimeout(w.timer);
      const give: WorkerHandle[] = [];
      while (give.length < w.want && this.idle.length > 0) {
        const h = this.idle.pop()!;
        h.inIdle = false;
        this.clearIdleTimer(h);

        if (this.coreBudget) {
          if (this.coreBudget.tryAcquire(this.workerCost)) {
            h.budgetCharged = true;
          } else {
            this.idle.push(h);
            h.inIdle = true;
            break;
          }
        }

        setHandleState(h, HandleState.Active);
        this.active.add(h);
        give.push(h);
      }
      w.resolve(give);
    }

    // arm ALL excess (walk) not just last (Grok3 #19)
    this.armAllExcessIdle();
  }

  private armAllExcessIdle() {
    if (this.idleTimeoutMs <= 0) {
      while (this.idle.length > this.minIdle) {
        const h = this.idle.pop()!;
        h.inIdle = false;
        this.destroyHandle(h, 'excess idle');
      }
      return;
    }
    if (this.idle.length <= this.minIdle) return;
    const excessEnd = this.idle.length - this.minIdle;
    for (let i = 0; i < excessEnd; i++) {
      const h = this.idle[i];
      if (h) this.armIdleTimerFor(h);
    }
  }

  // --- private ---

  private spawnOne(): WorkerHandle {
    if (this.state === PoolState.Destroyed || this.state === PoolState.Draining) throw new PyramidError('POOL_DESTROYED', 'pool destroyed');
    const worker = this.factory();

    let readyResolve: ((v?: unknown) => void) | undefined;
    const ready = new Promise<void>((resolve) => { readyResolve = (v?: unknown) => resolve(); });

    // create handle but register to all/handleByWorker AFTER wiring (Grok3 #22)
    const h: WorkerHandle = {
      worker,
      idleTimer: null,
      state: HandleState.WarmFloor,
      pending: new Map(),
      nextId: 0,
      ready,
      _readyResolve: readyResolve,
      readySettled: false,
    } as WorkerHandle;

    // Permanent lifecycle listeners - wire first
    const onDeath = () => this.destroyHandle(h, "worker error");
    let wiringOk = true;
    try {
      worker.addEventListener("error", onDeath);
      worker.addEventListener("messageerror", onDeath);
    } catch (e) {
      if (DEV) console.warn('[pyramid] addEventListener failed:', e);
      wiringOk = false; /* test doubles */
    }

    // onMessage ...
    const onMessage = (ev: { data?: any }) => {
      if (h.state === HandleState.Terminated || h.state === HandleState.Bad) return;
      const data = ev.data;
      const reply = parseWorkerReply(data);
      if (!reply) return;
      if (reply.type === 'ready') {
        if (!h.readySettled) {
          h.readySettled = true;
          h._readyResolve?.();
        }
        return;
      }
      if (reply.type !== 'decode-reply') return;

      const job = h.pending.get(reply.id);
      if (!job) return;

      if (!reply.ok) {
        this.cleanupPendingJob(h, job);
        const e = new PyramidError(reply.error?.code || 'INTERNAL', reply.error?.message || 'worker error');
        job.reject(e);
        if (reply.error?.code === 'OOM' || reply.error?.code === 'INTERNAL') {
          setHandleState(h, HandleState.Bad, { code: reply.error.code as any, message: reply.error.message || '', at: Date.now(), count: 1 });
          this.destroyHandle(h, `worker error ${reply.error?.code || ''}`);
        }
        return;
      }
      let pixels: Uint8Array;
      const p = (reply as any).pixels;
      if (p instanceof Uint8Array) pixels = p;
      else if (p instanceof ArrayBuffer) pixels = new Uint8Array(p);
      else pixels = new Uint8Array(p);
      const minBytes = reply.w * reply.h * (job.bytesPerPixel ?? 0);
      if (!Number.isFinite(minBytes) || pixels.byteLength < minBytes) {
        this.cleanupPendingJob(h, job);
        job.reject(new PyramidError('INVALID_REPLY', `worker pixels too short (${pixels.byteLength} < ${minBytes})`));
        return;
      }
      this.cleanupPendingJob(h, job);
      const format: PixelFormat = job.bytesPerPixel === 8 ? 'rgba16' : 'rgba8';
      job.resolve({ pixels, width: reply.w, height: reply.h, format });
    };
    try {
      worker.addEventListener("message", onMessage);
    } catch { wiringOk = false; }

    if (!wiringOk) {
      try { worker.terminate(); } catch {}
      throw new Error('lifecycle wiring failed');
    }

    // register AFTER wiring succeeds (Grok3 #22)
    this.all.add(h);
    this.handleByWorker.set(worker, h);
    this.bytesIdByWorker.set(worker, new Set());

    return h;
  }
  // Pre-bound for setTimeout( fn, ms, arg ) passthrough (Grok4).
  private readonly _reapBound = (h: WorkerHandle) => {
    if (h.inIdle && this.idle.length > this.minIdle) {
      this.destroyHandle(h, 'idle reaped');
    }
  };

  private armIdleTimer(h: WorkerHandle): void {
    this.clearIdleTimer(h);
    if (this.idleTimeoutMs <= 0) {
      if (this.idle.length > this.minIdle) this.destroyHandle(this.idle.pop()!, 'excess');
      return;
    }
    if (this.idle.length <= this.minIdle) return;
    h.idleTimer = globalThis.setTimeout(this._reapBound, this.idleTimeoutMs, h);
  }

  private armIdleTimerFor(h: WorkerHandle) { this.armIdleTimer(h); }

  private clearIdleTimer(h: WorkerHandle): void {
    if (h.idleTimer !== null) {
      globalThis.clearTimeout(h.idleTimer);
      h.idleTimer = null;
    }
  }

  private cleanupPendingJob(h: WorkerHandle, job: PendingJob): void {
    if (job.abortSignal && job.abortListener) {
      job.abortSignal.removeEventListener('abort', job.abortListener);
      job.abortListener = null;
    }
    if (job.timer != null) {
      globalThis.clearTimeout(job.timer);
      job.timer = null;
    }
    if (job.requestTimer != null) {
      globalThis.clearTimeout(job.requestTimer);
      job.requestTimer = null;
    }
    h.pending.delete(job.id);
  }

  ensureLoaded(handles: WorkerHandle[], bytesId: number, bytes: Uint8Array, useSAB: boolean): void {
    for (const h of handles) {
      let set = this.bytesIdByWorker.get(h.worker);
      if (!set) {
        set = new Set<number>();
        this.bytesIdByWorker.set(h.worker, set);
      }
      if (set.has(bytesId)) continue;
      try {
        if (useSAB && typeof SharedArrayBuffer !== 'undefined') {
          let sab = this.sabByBytesId.get(bytesId);
          if (!sab) {
            sab = new SharedArrayBuffer(bytes.byteLength);
            new Uint8Array(sab).set(bytes);
            if (this.sabByBytesId.size >= 8) {
              const oldestBytesId = this.sabByBytesId.keys().next().value as number;
              this.sabByBytesId.delete(oldestBytesId);
              for (const wh of this.all) {
                const wSet = this.bytesIdByWorker.get(wh.worker);
                if (wSet) {
                  wSet.delete(oldestBytesId);
                }
              }
            }
            this.sabByBytesId.set(bytesId, sab);
          }
          h.worker.postMessage({ v: 1, type: 'load', bytesId, sab, byteLength: bytes.byteLength });
        } else {
          h.worker.postMessage({ v: 1, type: 'load', bytesId, bytes });
        }
        set.add(bytesId);
      } catch (e) {
        if (DEV) console.warn(`[pyramid] ensureLoaded postMessage failed for bytesId ${bytesId}:`, e);
      }
    }
  }
}

// Grok3 #38-39 module-level consts (evaluated once)
const HWC = (globalThis as any).navigator?.hardwareConcurrency ?? 4;
// NOTE: parallel-worker viability (canUseParallelTileWorkers) is queried at the decision site
// rather than cached at module load — it depends only on `Worker` presence (finding 82) which a
// test harness (or an SSR→hydration transition) may install after this module is first imported.

/** Hoisted predicate (Grok4). */
export function shouldUseParallel(
  opts: { parallel?: boolean; workerFactory?: any; pool?: any } | undefined,
  numTiles: number,
  envCanParallel: boolean,
): boolean {
  return (opts?.parallel !== false) && envCanParallel && numTiles > 1 && !!(opts?.workerFactory || opts?.pool);
}

let pool: PyramidWorkerPool | null = null;
let poolFactory: (() => WorkerLike) | null = null;

function getOrCreatePool(factory: () => WorkerLike, coreBudget?: { acquire(cost?: number): Promise<void>; release(cost?: number): void; tryAcquire(cost?: number): boolean; }): PyramidWorkerPool {
  if (pool && (pool.poolState === PoolState.Active || pool.poolState === PoolState.Prewarming || pool.poolState === PoolState.Created)) {
    if (poolFactory && poolFactory !== factory) {
      if (pool.activeCount > 0) {
        throw new PyramidError('FACTORY_CONFLICT', 'cannot swap workerFactory while pool has active decodes');
      }
      void pool.destroy(0).catch(e => {
        if (DEV) console.warn('[pyramid] pool.destroy during factory swap failed:', e);
      });
      pool = null;
      poolFactory = null;
    }
  }
  if (pool && poolFactory === factory) {
    return pool;
  }
  const maxSize = Math.min(HWC, 8);
  const p = new PyramidWorkerPool({
    factory,
    maxSize,
    idleTimeoutMs: 5000,
    minIdle: 2,
    coreBudget,
  });
  void p.prewarmAsync(2).catch(e => {
    if (DEV) console.warn('[pyramid] getOrCreatePool prewarm failed:', e);
  });
  pool = p;
  poolFactory = factory;
  return p;
}

export async function disposeDefaultPool(): Promise<void> {
  if (pool) {
    await pool.destroy();
    pool = null;
    poolFactory = null;
  }
}

export const __testing = {
  decodeTilesParallel,
  getOrCreatePool,
};

/** Runtime validation for worker replies (Grok2). Returns null on mismatch -> caller logs + INVALID_REPLY. */
function parseWorkerReply(data: unknown): WorkerReply | null {
  if (!data || typeof data !== 'object') return null;
  const d: any = data;
  if (d.v !== 1) return null;
  if (d.type === 'ready') {
    return { v: 1, type: 'ready' };
  }
  if (d.type === 'decode-reply' && typeof d.id === 'number') {
    if (d.ok === true) {
      if ((d.pixels instanceof Uint8Array || d.pixels instanceof ArrayBuffer) &&
          typeof d.w === 'number' && typeof d.h === 'number' &&
          d.w > 0 && d.w <= 1000000 && d.h > 0 && d.h <= 1000000) {
        return { v: 1, type: 'decode-reply', id: d.id, ok: true, pixels: d.pixels as any, w: d.w, h: d.h };
      }
      return null;
    }
    if (d.ok === false && d.error && typeof d.error.code === 'string') {
      return {
        v: 1, type: 'decode-reply', id: d.id, ok: false,
        error: { code: d.error.code as WorkerErrorCode, message: String(d.error.message || ''), stack: d.error.stack }
      };
    }
  }
  return null;
}

function finalizeDirectDecode(
  direct: DecodedLevel,
  vp: ImageRegion,
  bpp: 4 | 8,
  outBuffer: Uint8Array,
  need: number,
  format: PixelFormat,
  cache: DecodeOptions["cache"] | undefined,
  cacheKeyFinal: string | undefined,
  tileSize: number,
  tileLevel: number,
  onTile?: DecodeOptions["onTile"],
): DecodedLevel {
  validateDecodedOutput(direct, vp, bpp);
  outBuffer.set(direct.pixels);
  const pixels = outBuffer.byteLength === need ? outBuffer : outBuffer.subarray(0, need);
  const result: DecodedLevel = { pixels, width: vp.w, height: vp.h, format };
  cacheStore(cache, cacheKeyFinal, pixels, need);
  if (onTile) {
    const id = tileIdOf(vp, tileSize, tileLevel);
    const prog: TileProgress = { id, key: tileKey(id), stage: 'final', completed: 1, total: 1 };
    onTile(vp, 1, prog);
  }
  return result;
}

async function decodeTilesParallel(
  bytesId: number,
  format: 'rgba8' | 'rgba16',
  tiles: ImageRegion[],
  handles: WorkerHandle[],
  outBuffer: Uint8Array,
  viewport: ImageRegion,
  bpp: 4 | 8,
  opts: {
    signal?: AbortSignal;
    onTile?: (region: ImageRegion, completedCount: number, progress?: TileProgress) => void;
    progressiveStage?: 'dc' | 'final';
    progressBase?: number;
    progressTotal?: number;
    deadlineMs?: number;
    requestTimeoutMs?: number;
    tileSize?: number;
    tileLevel?: number;
    tileCache?: PyramidCache;
    sourceLevelId?: string;
    sourceW?: number;
    sourceH?: number;
    cacheDcTiles?: boolean;
  } = {},
  // Keep trailing params as fully backward-compatible fallbacks for tests or older callers:
  deadlineMsFallback?: number,
  requestTimeoutMsFallback?: number,
  tileSizeFallback?: number,
  tileLevelFallback?: number,
): Promise<void> {
  if (handles.length === 0) return;
  if (opts.signal?.aborted) {
    throw new PyramidError('ABORTED', 'decode aborted before start');
  }

  const deadlineMs = opts.deadlineMs ?? deadlineMsFallback;
  const requestTimeoutMs = opts.requestTimeoutMs ?? requestTimeoutMsFallback;
  const tileSize = opts.tileSize ?? tileSizeFallback;
  const tileLevel = opts.tileLevel ?? tileLevelFallback ?? 0;

  const controller = new AbortController();
  const effectiveSignal = opts.signal || controller.signal;
  let outerAbortListener: (() => void) | null = null;
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    outerAbortListener = () => controller.abort();
    opts.signal.addEventListener('abort', outerAbortListener, { once: true });
  }

  // Stream-stitch: no results[] retention. Write on arrival, drop decoded ref immediately.
  let next = 0;
  let failed = false;
  let firstErr: unknown = null;
  let completedCount = 0;
  const total = opts.progressTotal ?? (tiles.length * (opts.progressiveStage ? 2 : 1));
  const base = opts.progressBase ?? 0;

  const decodeOne = async (handle: WorkerHandle, gridTile: ImageRegion): Promise<DecodedLevel> => {
    try {
      return await decodeTileWithWorker(handle, bytesId, gridTile, format, deadlineMs, effectiveSignal, requestTimeoutMs, opts.progressiveStage);
    } catch (error) {
      if (controller.signal.aborted || (opts.signal?.aborted ?? false)) throw error;
      const retryHandle = handles.find((candidate) =>
        candidate !== handle &&
        candidate.state !== HandleState.Terminated &&
        candidate.state !== HandleState.Bad,
      );
      if (!retryHandle) throw error;
      return decodeTileWithWorker(retryHandle, bytesId, gridTile, format, deadlineMs, effectiveSignal, requestTimeoutMs, opts.progressiveStage);
    }
  };

  const coros = handles.map(async (h) => {
    while (true) {
      if (failed || controller.signal.aborted) break;
      if (h.state === HandleState.Terminated || h.state === HandleState.Bad) {
        if (!failed) { failed = true; firstErr = new PyramidError('INTERNAL', 'worker dead mid-batch'); }
        break;
      }
      const idx = next++;
      if (idx >= tiles.length) break;
      if (failed || controller.signal.aborted) break;
      const region = tiles[idx]!;
      const gridTile = (tileSize != null && opts.sourceW != null && opts.sourceH != null)
        ? {
            x: Math.floor(region.x / tileSize) * tileSize,
            y: Math.floor(region.y / tileSize) * tileSize,
            w: Math.min(tileSize, opts.sourceW - Math.floor(region.x / tileSize) * tileSize),
            h: Math.min(tileSize, opts.sourceH - Math.floor(region.y / tileSize) * tileSize),
          }
        : region;
      try {
        const decoded = await decodeOne(h, gridTile);
        if (!failed) {
          if (gridTile === region) {
            validateDecodedOutput(decoded, region, bpp);
            stitch(outBuffer, viewport, region, decoded, bpp);
          } else {
            validateDecodedOutput(decoded, gridTile, bpp);
            stitchCropped(outBuffer, viewport, region, decoded.pixels, gridTile.w, gridTile.h, gridTile.x, gridTile.y, bpp);
          }
          completedCount += 1;
          const absoluteCompleted = base + completedCount;
          const tId: TileId | undefined = tileSize != null ? tileIdOf(region, tileSize, tileLevel) : undefined;
          
          if (opts.tileCache && tId && opts.sourceLevelId) {
            const cap = opts.tileCache.capacityBytes;
            if (opts.progressiveStage === 'dc') {
              if (opts.cacheDcTiles) {
                const dcKey = `${makeTileCacheKey(opts.sourceLevelId, tId)}:${format}:dc`;
                if (cap === undefined || decoded.pixels.byteLength <= cap) {
                  opts.tileCache.set(dcKey, decoded.pixels);
                }
              }
            } else if (opts.progressiveStage === 'final' || opts.progressiveStage === undefined) {
              const finalKey = `${makeTileCacheKey(opts.sourceLevelId, tId)}:${format}:final`;
              if (cap === undefined || decoded.pixels.byteLength <= cap) {
                opts.tileCache.set(finalKey, decoded.pixels);
              }
            }
          }

          if (!opts.tileCache) {
            // Drop ref after write (stream-stitch; aids GC of per-tile buffers).
            (decoded as any).pixels = null as any;
          }

          if (opts.onTile) {
            const prog: TileProgress | undefined = tId ? {
              id: tId,
              key: tileKey(tId),
              stage: opts.progressiveStage ?? 'final',
              completed: absoluteCompleted,
              total,
            } : undefined;
            opts.onTile(region, absoluteCompleted, prog);
          }
        }
      } catch (e) {
        if (!failed) { failed = true; firstErr = e; controller.abort(); }
        for (const hh of handles) {
          if (hh.state === HandleState.Terminated || hh.state === HandleState.Bad) continue;
          for (const [iid, job] of Array.from(hh.pending.entries())) {
            hh.pending.delete(iid);
            if (job.timer != null) { globalThis.clearTimeout(job.timer); job.timer = null; }
            if (job.requestTimer != null) { globalThis.clearTimeout(job.requestTimer); job.requestTimer = null; }
            if (job.abortSignal && job.abortListener) {
              job.abortSignal.removeEventListener('abort', job.abortListener);
              job.abortListener = null;
            }
            try { job.reject(new PyramidError('ABORTED', `batch tile failure`)); } catch {}
            try { hh.worker.postMessage({ v: 1, type: 'cancel', id: iid }); } catch {}
          }
        }
        break;
      }
    }
  });

  try {
    await Promise.all(coros);
    if (failed) {
      if ((opts.signal && opts.signal.aborted) && firstErr instanceof PyramidError && firstErr.code === 'ABORTED') {
        throw firstErr;
      }
      if ((opts.signal && opts.signal.aborted) || (controller.signal.aborted && firstErr instanceof PyramidError && firstErr.code === 'ABORTED')) {
        throw new PyramidError('ABORTED', 'decode aborted');
      }
      throw firstErr instanceof Error ? firstErr : new PyramidError('INTERNAL', String(firstErr));
    }
  } finally {
    if (opts.signal && outerAbortListener) {
      opts.signal.removeEventListener('abort', outerAbortListener);
    }
  }
}

/**
 * The worker-pool strategy options: the full DecodeOptions surface plus the two pool-only knobs
 * (`useSAB` zero-copy carrier, explicit `pool`). Declared once so the public overloads and the
 * implementation agree exactly under `exactOptionalPropertyTypes` — the single orchestrator in
 * decode-level.ts and the runtime pass full DecodeOptions here (Task 3 boundary tightening).
 */
export type PooledDecodeOptions = DecodeOptions & {
  /** Opt-in SAB zero-copy for the load message when crossOriginIsolated (see canShareContainerBytes). */
  useSAB?: boolean;
  /**
   * Explicit long-lived pool (owned by the runtime). Preferred over the module default singleton.
   * Typed as the structural PyramidPoolLike so this matches DecodeOptions.pool exactly — the concrete
   * PyramidWorkerPool satisfies it. The implementation dereferences only the PyramidPoolLike surface.
   */
  pool?: PyramidPoolLike;
};

/**
 * Decode a tiled viewport with optional parallel per-tile workers (Grok2 protocol).
 * Uses bytesId + load/decode split. 16-bit now wired at root via format.
 */
export async function decodeTiledViewportPooled(
  containerBytes: Uint8Array,
  region: ImageRegion,
  options?: PooledDecodeOptions,
): Promise<DecodedLevel>;

export async function decodeTiledViewportPooled(
  source: Extract<LevelSource, { kind: "tiled" }>,
  region: ImageRegion,
  options?: PooledDecodeOptions,
): Promise<DecodedLevel>;

export async function decodeTiledViewportPooled(
  arg1: Uint8Array | Extract<LevelSource, { kind: "tiled" }>,
  region: ImageRegion,
  options?: PooledDecodeOptions,
): Promise<DecodedLevel> {
  const signal = options?.signal;
  if (signal?.aborted) throw new PyramidError('ABORTED', 'decode aborted before start');

  let source: Extract<LevelSource, { kind: "tiled" }>;
  if (arg1 instanceof Uint8Array) {
    const header = parseJxtcHeader(arg1);
    const fmt: PixelFormat = header.bitsPerSample === 16 ? 'rgba16' : 'rgba8';
    source = {
      kind: "tiled",
      bytes: arg1,
      width: header.imageW,
      height: header.imageH,
      tileSize: header.tileSize,
      bitsPerSample: header.bitsPerSample,
      format: fmt,
      bpp: bppOfFormat(fmt),
      version: header.version,
      tilesX: header.tilesX,
      tilesY: header.tilesY,
    };
  } else {
    source = arg1;
  }

  assertFiniteRegion(region);
  region = snapRegionToIntegers(region);

  const plan = prepareDecodePlan(source, region);
  const decodeRegion = options?.decodeRegion ?? plan.decodeRegion;
  const vp = plan.viewport;
  const bpp = plan.bpp;
  const need = vp.w * vp.h * bpp;
  const deadlineMs = options?.budgetMs != null ? performance.now() + options.budgetMs : undefined;
  const zeroCopyHits = !!options?.zeroCopyCacheHits;

  // Cache check at decode entry (viewport rect granularity for this levelId).
  const cache = options?.cache;
  const cacheKeyFinal = cache ? viewportCacheKey(getLevelId(source.bytes), vp, plan.format as PixelFormat, 'final') : undefined;
  if (cache && cacheKeyFinal) {
    const cached = cache.get(cacheKeyFinal);
    if (cached) {
      if (options?.outBuffer) {
        const ob = options.outBuffer;
        if (ob.byteLength < need) throw new PyramidError('INVALID_BUFFER_SIZE', `outBuffer too small (${ob.byteLength} < ${need})`);
        if (cached.length >= need && cached.length <= ob.byteLength) {
          ob.set(cached.subarray(0, need));
          return { pixels: ob.byteLength === need ? ob : ob.subarray(0, need), width: vp.w, height: vp.h, format: plan.format as PixelFormat };
        }
      } else if (cached.length >= need) {
        return { pixels: zeroCopyHits ? cached : new Uint8Array(cached), width: vp.w, height: vp.h, format: plan.format as PixelFormat };
      }
    }
  }

  // Allocate or validate caller outBuffer once (stream-stitch / direct paths reuse it).
  let outBuffer: Uint8Array;
  if (options?.outBuffer) {
    if (options.outBuffer.byteLength < need) {
      throw new PyramidError('INVALID_BUFFER_SIZE', `outBuffer too small (${options.outBuffer.byteLength} < ${need})`);
    }
    if (buffersInFlight.has(options.outBuffer)) {
      throw new PyramidError('BUFFER_IN_USE', 'outBuffer is already in use by another decode');
    }
    if (bpp === 8 && (options.outBuffer.byteOffset % 2) !== 0) {
      throw new PyramidError('INVALID_BUFFER_ALIGNMENT', 'outBuffer.byteOffset must be even for 16-bit (bpp=8) pixels');
    }
    outBuffer = options.outBuffer;
  } else {
    outBuffer = new Uint8Array(need);
  }
  const onTile = options?.onTile;
  if (options?.outBuffer) buffersInFlight.add(options.outBuffer);

  try {
    const wantParallel = (options?.pool != null)
      ? (options?.parallel !== false) && plan.tiles.length > 1
      : shouldUseParallel(options, plan.tiles.length, canUseParallelTileWorkers());

    if (!wantParallel) {
      const direct = signal ? await raceWithAbort(decodeRegion(source.bytes, vp), signal) : await decodeRegion(source.bytes, vp);
      return finalizeDirectDecode(direct, vp, bpp, outBuffer, need, plan.format as PixelFormat, cache, cacheKeyFinal, source.tileSize, source.level ?? 0, onTile);
    }

    const levelId = getLevelId(source);
    const misses: ImageRegion[] = [];
    const hits: Array<{ region: ImageRegion; pixels: Uint8Array; id: TileId; gridTileW: number; gridTileH: number; gridTileX: number; gridTileY: number }> = [];

    if (cache) {
      for (const tile of plan.tiles) {
        const id = tileIdOf(tile, source.tileSize, source.level ?? 0);
        const finalKey = `${makeTileCacheKey(levelId, id)}:${plan.format}:final`;

        const col = Math.floor(tile.x / source.tileSize);
        const row = Math.floor(tile.y / source.tileSize);
        const gridTileX = col * source.tileSize;
        const gridTileY = row * source.tileSize;
        const gridTileW = Math.min(source.tileSize, source.width - gridTileX);
        const gridTileH = Math.min(source.tileSize, source.height - gridTileY);
        const expectedLen = gridTileW * gridTileH * bpp;

        const hit = cache.get(finalKey);
        if (hit && hit.byteLength === expectedLen) {
          hits.push({ region: tile, pixels: hit, id, gridTileW, gridTileH, gridTileX, gridTileY });
        } else {
          misses.push(tile);
        }
      }
    } else {
      misses.push(...plan.tiles);
    }

    const prog = options?.progressive;
    const total = plan.tiles.length * (prog === 'dc-then-final' ? 2 : 1);

    if (cache && misses.length === 0) {
      let completed = 0;
      for (const item of hits) {
        stitchCropped(outBuffer, vp, item.region, item.pixels, item.gridTileW, item.gridTileH, item.gridTileX, item.gridTileY, bpp);

        if (prog === 'dc-then-final') {
          completed += 1;
          onTile?.(item.region, completed, { id: item.id, key: tileKey(item.id), stage: 'dc', completed, total });
        } else {
          completed += 1;
          onTile?.(item.region, completed, { id: item.id, key: tileKey(item.id), stage: 'final', completed, total });
        }
      }

      if (prog === 'dc-then-final') {
        for (const item of hits) {
          completed += 1;
          onTile?.(item.region, completed, { id: item.id, key: tileKey(item.id), stage: 'final', completed, total });
        }
      }
      
      const pixels = outBuffer.byteLength === need ? outBuffer : outBuffer.subarray(0, need);
      const result: DecodedLevel = { pixels, width: vp.w, height: vp.h, format: plan.format as PixelFormat };
      cacheStore(cache, cacheKeyFinal, pixels, need);
      if (options?.preserveMetadata) {
        const icc = await ensureIccProfile(source as any, options as any);
        if (icc) result.iccProfile = icc;
      }
      return result;
    }

    // #41: pool from caller opts.pool (preferred) or module singleton (created once outside hot path via getOrCreate when factory provided)
    // PyramidPoolLike is the structural surface both an injected pool and the module singleton satisfy;
    // the impl below dereferences only that surface (allocateBytesId/acquire/ensureLoaded/release/requestTimeout).
    let p: PyramidPoolLike;
    if (options?.pool) {
      p = options.pool;
    } else if (options?.workerFactory) {
      p = getOrCreatePool(options.workerFactory, (options as any).coreBudget);
    } else {
      const direct = signal ? await raceWithAbort(decodeRegion(source.bytes, vp), signal) : await decodeRegion(source.bytes, vp);
      return finalizeDirectDecode(direct, vp, bpp, outBuffer, need, plan.format as PixelFormat, cache, cacheKeyFinal, source.tileSize, source.level ?? 0, onTile);
    }

    const bytesId = p.allocateBytesId(source as any);

    const useSAB = options?.useSAB === true && typeof SharedArrayBuffer !== 'undefined';

    const desired = Math.min(HWC, misses.length);
    const liveHandles = await p.acquire(desired);

    if (liveHandles.length === 0) {
      const direct = signal ? await raceWithAbort(decodeRegion(source.bytes, vp), signal) : await decodeRegion(source.bytes, vp);
      return finalizeDirectDecode(direct, vp, bpp, outBuffer, need, plan.format as PixelFormat, cache, cacheKeyFinal, source.tileSize, source.level ?? 0, onTile);
    }

    await Promise.all(liveHandles.map((h) => h.ready));
    const usable = liveHandles.filter(h => h.state !== HandleState.Terminated && h.state !== HandleState.Bad);
    if (usable.length === 0) {
      p.release(liveHandles);
      const direct = signal ? await raceWithAbort(decodeRegion(source.bytes, vp), signal) : await decodeRegion(source.bytes, vp);
      return finalizeDirectDecode(direct, vp, bpp, outBuffer, need, plan.format as PixelFormat, cache, cacheKeyFinal, source.tileSize, source.level ?? 0, onTile);
    }
    p.ensureLoaded(usable, bytesId, source.bytes, useSAB);

    try {
      const baseTileOpts: {
        signal?: AbortSignal;
        onTile?: (region: ImageRegion, completedCount: number, progress?: TileProgress) => void;
        progressiveStage?: 'dc' | 'final';
        progressBase?: number;
        progressTotal?: number;
      } = {};
      if (signal != null) baseTileOpts.signal = signal;
      if (onTile) baseTileOpts.onTile = onTile;

      let prewarmCompleted = 0;
      if (hits.length > 0) {
        for (const item of hits) {
          stitchCropped(outBuffer, vp, item.region, item.pixels, item.gridTileW, item.gridTileH, item.gridTileX, item.gridTileY, bpp);

          if (prog === 'dc-then-final') {
            prewarmCompleted += 1;
            onTile?.(item.region, prewarmCompleted, { id: item.id, key: tileKey(item.id), stage: 'dc', completed: prewarmCompleted, total });
          } else {
            prewarmCompleted += 1;
            onTile?.(item.region, prewarmCompleted, { id: item.id, key: tileKey(item.id), stage: 'final', completed: prewarmCompleted, total });
          }
        }
      }

      const cx = vp.x + vp.w / 2;
      const cy = vp.y + vp.h / 2;
      const orderedMisses = misses.map((tile, idx) => ({
        tile,
        dist: (tile.x + tile.w / 2 - cx) ** 2 + (tile.y + tile.h / 2 - cy) ** 2,
      })).sort((a, b) => a.dist - b.dist).map(item => item.tile);

      if (prog === 'dc-then-final') {
        const dcOpts: any = {
          ...baseTileOpts,
          progressiveStage: 'dc' as const,
          progressBase: prewarmCompleted,
          progressTotal: total,
          sourceW: source.width,
          sourceH: source.height,
        };
        if (cache) {
          dcOpts.tileCache = cache;
          dcOpts.sourceLevelId = levelId;
        }
        if (options?.cacheDcTiles !== undefined) {
          dcOpts.cacheDcTiles = options.cacheDcTiles;
        }
        await decodeTilesParallel(bytesId, plan.format, orderedMisses, usable, outBuffer, vp, bpp, dcOpts, deadlineMs, p.requestTimeout, source.tileSize, source.level ?? 0);

        const finBase = orderedMisses.length + prewarmCompleted;
        const finOpts: any = {
          ...baseTileOpts,
          progressiveStage: 'final' as const,
          progressBase: finBase,
          progressTotal: total,
          sourceW: source.width,
          sourceH: source.height,
        };
        if (cache) {
          finOpts.tileCache = cache;
          finOpts.sourceLevelId = levelId;
        }
        await decodeTilesParallel(bytesId, plan.format, orderedMisses, usable, outBuffer, vp, bpp, finOpts, deadlineMs, p.requestTimeout, source.tileSize, source.level ?? 0);

        let finalCompleted = finBase + orderedMisses.length;
        for (const item of hits) {
          finalCompleted += 1;
          onTile?.(item.region, finalCompleted, { id: item.id, key: tileKey(item.id), stage: 'final', completed: finalCompleted, total });
        }
      } else {
        const tileOpts: any = {
          ...baseTileOpts,
          progressBase: prewarmCompleted,
          progressTotal: total,
          sourceW: source.width,
          sourceH: source.height,
        };
        if (cache) {
          tileOpts.tileCache = cache;
          tileOpts.sourceLevelId = levelId;
        }
        await decodeTilesParallel(
          bytesId,
          plan.format,
          orderedMisses,
          usable,
          outBuffer,
          vp,
          bpp,
          tileOpts,
          deadlineMs,
          p.requestTimeout,
          source.tileSize,
          source.level ?? 0,
        );
      }
      const pixels = outBuffer.byteLength === need ? outBuffer : outBuffer.subarray(0, need);
      const result: DecodedLevel = { pixels, width: vp.w, height: vp.h, format: plan.format as PixelFormat };
      cacheStore(cache, cacheKeyFinal, pixels, need);
      if (options?.preserveMetadata) {
        const icc = await ensureIccProfile(source as any, options as any);
        if (icc) result.iccProfile = icc;
      }
      return result;
    } finally {
      p.release(liveHandles);
    }
  } finally {
    if (options?.outBuffer) buffersInFlight.delete(options.outBuffer);
  }
}
