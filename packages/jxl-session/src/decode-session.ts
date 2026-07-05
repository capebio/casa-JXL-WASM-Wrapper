// jxl-session/src/decode-session.ts
// DecodeSession implementation. Routes through jxl-scheduler to a worker.
// Spec: Sections 5, 10, 16.1.

import type {
  DecodeOptions,
  DecodeSession,
  DecodeFrameEvent,
  DecodeStage,
  ImageInfo,
  WorkerToMainMessage,
  MsgDecodeStart,
  CodecMetric,
  DecodeFrameMeta,
} from "@casabio/jxl-core";
import { JxlError, type JxlErrorCode } from "@casabio/jxl-core/errors";
import type { Scheduler } from "@casabio/jxl-scheduler";

import { AsyncEventStream } from "./event-stream.js";
import { deferred, newSessionId, toTransferableBuffer, type Deferred } from "./util.js";

const KNOWN_JXL_ERROR_CODES: ReadonlySet<JxlErrorCode> = new Set<JxlErrorCode>([
  "MalformedCodestream", "TruncatedStream", "UnsupportedFeature", "OutOfMemory",
  "BudgetExceeded", "Cancelled", "WorkerCrashed", "CapabilityMissing", "ConfigError",
  "QueueOverflow", "Internal",
  "DuplicateSession", "UnhandledError", "UnhandledRejection", "WorkerError", "MessageDeserializeError",
] as const);

// Typed literals for JxlError ctor sites (ensures assignability to JxlErrorCode param
// under all tsconfigs; also provides compile-time check if union removes a code).
const INTERNAL: JxlErrorCode = "Internal";
const CANCELLED: JxlErrorCode = "Cancelled";
const BUDGET_EXCEEDED: JxlErrorCode = "BudgetExceeded";
const CONFIG_ERROR: JxlErrorCode = "ConfigError";
function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === "function";
}

export function computeDecodeWeight(opts: {
  expectedOutputBytes?: number;
  targetWidth?: number | null;
  targetHeight?: number | null;
  format?: string;
}): number | undefined {
  const explicit = opts.expectedOutputBytes;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return explicit;
  const w = opts.targetWidth;
  const h = opts.targetHeight;
  if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) {
    // Use the requested output format's bytes-per-pixel; default to 4 (rgba8) for unknown.
    const bpp = opts.format === "rgba16" ? 8 : opts.format === "rgbaf32" ? 16 : opts.format === "rgb8" ? 3 : 4;
    const bytes = w * h * bpp;
    if (Number.isFinite(bytes) && bytes <= Number.MAX_SAFE_INTEGER) return bytes;
  }
  return undefined;
}

export class DecodeSessionImpl implements DecodeSession {
  readonly id: string;

  private scheduler: Scheduler | null = null;
  private readonly opts: DecodeOptions;
  private readonly frameStream = new AsyncEventStream<DecodeFrameEvent>();
  private readonly doneDeferred: Deferred<ImageInfo> = deferred<ImageInfo>();
  private readonly headerDeferred: Deferred<ImageInfo> = deferred<ImageInfo>();
  private readonly acquirePromise: Promise<unknown>;

  private readonly abortSignal: AbortSignal | null;
  private readonly abortHandler: (() => void) | null;

  private lastInfo: ImageInfo | null = null;
  private closed = false;
  private terminated = false;
  private terminalError: JxlError | null = null;

  constructor(schedulerOrPromise: Scheduler | Promise<Scheduler>, opts: DecodeOptions) {
    this.opts = opts;
    this.id = newSessionId();

    const startMsg: MsgDecodeStart = {
      type: "decode_start",
      sessionId: this.id,
      format: opts.format,
      region: opts.region ?? null,
      downsample: opts.downsample ?? 1,
      progressionTarget: opts.progressionTarget ?? "final",
      emitEveryPass: opts.emitEveryPass ?? true,
      progressiveDetail: opts.progressiveDetail ?? null,
      suppressDuplicateProgress: opts.suppressDuplicateProgress ?? false,
      preserveIcc: opts.preserveIcc ?? true,
      preserveMetadata: opts.preserveMetadata ?? true,
      priority: opts.priority ?? "visible",
      budgetMs: opts.budgetMs ?? null,
      targetWidth: opts.targetWidth ?? null,
      targetHeight: opts.targetHeight ?? null,
      fitMode: opts.fitMode ?? null,
    };

    // A caller may use only frames() and never call done(). Attach a no-op
    // catch so a rejected done() promise with no caller handler does not
    // surface as an unhandledRejection. Callers that do call done() attach
    // their own handler independently.
    void this.doneDeferred.promise.catch(() => undefined);
    void this.headerDeferred.promise.catch(() => undefined);

    // DS-3: check aborted BEFORE any scheduler interaction (acquireSlot, onMessage).
    // Never request slot for an already-aborted decode; no cancelSession on unknown id.
    this.abortSignal = opts.signal ?? null;
    if (this.abortSignal !== null && this.abortSignal.aborted) {
      this.acquirePromise = Promise.resolve();
      this.abortHandler = null;
      this.fail(new JxlError(CANCELLED, "Decode aborted by signal", { sessionId: this.id }));
      return; // ctor done; no listener, no acquire, no cancel for unrequested slot
    }

    const initAcquire = (scheduler: Scheduler): Promise<unknown> => {
      // R1-1: abort may have fired before the async scheduler promise resolved;
      // terminated is already set — do not acquire a slot that will never be released.
      if (this.terminated) return Promise.resolve();
      this.scheduler = scheduler;
      // Register the message handler BEFORE acquireSlot sends decode_start,
      // so decode_header is never missed.
      scheduler.onMessage(this.id, (msg) => this.handleMessage(msg));
      const weight = computeDecodeWeight(opts);
      return scheduler.acquireSlot({
        sessionId: this.id,
        priority: startMsg.priority,
        startMsg,
        sourceKey: null,
        signal: opts.signal ?? null,
        ...(weight !== undefined ? { weight } : {}),
      });
    };

    this.acquirePromise = (isPromiseLike(schedulerOrPromise)
      ? schedulerOrPromise.then((scheduler) => initAcquire(scheduler))
      : initAcquire(schedulerOrPromise))
      .catch((err: unknown) => {
        this.fail(new JxlError(INTERNAL, `Failed to acquire worker: ${String(err)}`, { sessionId: this.id, cause: err }));
      });

    // Set up abort signal handling (only reached for non-pre-aborted signals).
    if (this.abortSignal !== null) {
      this.abortHandler = () => {
        // Cancel the scheduler slot before failing so the worker is told to stop
        // and the pool slot is released immediately (task 007-concurrency-e7f8a9b0).
        this.scheduler?.cancelSession(this.id);
        this.fail(new JxlError(CANCELLED, "Decode aborted by signal", { sessionId: this.id }));
      };
      this.abortSignal.addEventListener("abort", this.abortHandler, { once: true });
    } else {
      this.abortHandler = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API (DecodeSession)
  // ---------------------------------------------------------------------------

  async push(chunk: ArrayBuffer | Uint8Array): Promise<void> {
    if (this.terminated || this.closed) {
      // DS-7: surface real terminal error (e.g. Cancelled, BudgetExceeded, decode_error)
      // instead of generic ConfigError. Semantics change: callers see actual cause.
      // DS-1: concurrent push() ordering depends on scheduler.waitForDrain FIFO
      // resolution for waiters of one session (scheduler.ts: pendingPushes array +
      // signalDrain head consumption). Documented dep; no local pushChain needed.
      throw this.terminalError ?? new JxlError(CONFIG_ERROR, "push() after close/cancel/error", { sessionId: this.id });
    }
    // Layer 4: ByteIntervalCursor (from benchmark) can generate the chunk passed here for byte-cutoff driven real progressive decode. Same math as synthetic path for fidelity. Positive for unified chunking in tests and prod. Use cursor to decide cutoff snapshots in real path for byte-bench integration.
    await this.acquirePromise;
    // Re-check closed: close() may have set it while we awaited acquirePromise
    // (task 007-concurrency-e5f6a7b8 / 007-errors-f6a7b8c9).
    if (this.terminated || this.closed) return;
    // Backpressure: resolves when the worker queue is below the high-water mark.
    const scheduler = this.scheduler;
    if (scheduler === null) return;
    await scheduler.waitForDrain(this.id);
    // Re-check: cancellation or worker error may have arrived during drain wait.
    if (this.terminated || this.closed) return;
    const ab = toTransferableBuffer(chunk);
    scheduler.send(this.id, { type: "decode_chunk", sessionId: this.id, chunk: ab }, [ab]);
  }

  async close(): Promise<void> {
    if (this.terminated || this.closed) return;
    this.closed = true;
    await this.acquirePromise;
    if (this.terminated) return;
    this.scheduler?.send(this.id, { type: "decode_close", sessionId: this.id });
  }

  /**
   * Returns the frame stream.
   * Contract (DS-2): call frames() BEFORE awaiting done() if you want to
   * observe progressive or final frames. If only done() is awaited (or frames()
   * called after done resolves), buffered frames may have been cleared and
   * will not be replayed.
   */
  frames(): AsyncIterable<DecodeFrameEvent> {
    return this.frameStream;
  }

  /**
   * Awaits final ImageInfo (success) or rejects with JxlError.
   * See frames() contract: consume frames before done() to receive them.
   */
  done(): Promise<ImageInfo> {
    return this.doneDeferred.promise;
  }

  get info(): ImageInfo | null {
    return this.lastInfo;
  }

  header(): Promise<ImageInfo> {
    return this.headerDeferred.promise;
  }

  async cancel(reason?: string): Promise<void> {
    // Guard against closed (task 007-logic-a1b2c3d4): cancel after close() but
    // before decode_final must not call fail() and corrupt the completion path.
    // Guard terminated to prevent concurrent callers from racing past the await
    // and invoking cancelSession()+fail() twice (tasks 007-concurrency-c9d0e1f2,
    // 007-errors-c3d4e5f6). JS is single-threaded so both flags are read atomically
    // before the first await point.
    if (this.terminated || this.closed) return;
    await this.acquirePromise.catch(() => undefined);
    // Re-check: abort handler or error may have terminated us during the await.
    if (this.terminated) return;
    this.scheduler?.cancelSession(this.id);
    this.fail(new JxlError(CANCELLED, reason ?? "Decode cancelled", { sessionId: this.id }));
  }

  // ---------------------------------------------------------------------------
  // Worker message handling
  // ---------------------------------------------------------------------------

  // Re-emit metrics folded onto decode_progress / decode_final frames as CodecMetric.
  // Each field is optional; absent fields (e.g. a Node worker that posts metrics the
  // old way, or a zero-copy frame) emit nothing — additive, never double-counts.
  private makeFrame(
    stage: DecodeFrameEvent["stage"],
    msg: { info: ImageInfo; pixels: DecodeFrameEvent["pixels"]; format: DecodeFrameEvent["format"]; pixelStride: number } & DecodeFrameMeta,
  ): DecodeFrameEvent {
    // Guard-assign onto one result object rather than conditional-spreading. Each
    // `...(cond ? { X } : {})` allocated a throwaway intermediate object (or {}) that was
    // immediately copied and garbaged — up to 11 per frame, on the per-pass/per-animation-
    // frame path. Direct assignment under exactOptionalPropertyTypes is byte-identical (only
    // present fields are set) and mirrors toFrameMeta() in jxl-worker-browser/decode-handler.
    const ev: DecodeFrameEvent = {
      stage,
      info: msg.info,
      pixels: msg.pixels,
      format: msg.format,
      pixelStride: msg.pixelStride,
    };
    if (msg.region !== undefined) ev.region = msg.region;
    if (msg.sourceScale !== undefined) ev.sourceScale = msg.sourceScale;
    if (msg.progressiveRegion !== undefined) ev.progressiveRegion = msg.progressiveRegion;
    if (msg.regionFallback !== undefined) ev.regionFallback = msg.regionFallback;
    if (msg.progressiveSequence !== undefined) ev.progressiveSequence = msg.progressiveSequence;
    if (msg.passOrdinal !== undefined) ev.passOrdinal = msg.passOrdinal;
    if (msg.frameIndex !== undefined) ev.frameIndex = msg.frameIndex;
    if (msg.frameDuration !== undefined) ev.frameDuration = msg.frameDuration;
    if (msg.frameName !== undefined) ev.frameName = msg.frameName;
    if (msg.animTicksPerSecond !== undefined) ev.animTicksPerSecond = msg.animTicksPerSecond;
    return ev;
  }

  private emitFoldedMetrics(m: {
    copyMs?: number;
    copiedBytes?: number;
    timeToFirstPixelMs?: number;
    outputBytes?: number;
    timeToFinalMs?: number;
  }): void {
    const cb = this.opts.onMetric;
    if (cb === undefined) return;
    const emit = (name: CodecMetric["name"], value: number | undefined): void => {
      if (value === undefined) return;
      try {
        cb({ name, value } as CodecMetric);
      } catch (e) {
        if (typeof process !== "undefined" && process.env?.["NODE_ENV"] === "development") {
          console.warn(`[jxl-session] onMetric threw`, e);
        }
      }
    };
    emit("copy_to_transfer_ms", m.copyMs);
    emit("copied_bytes", m.copiedBytes);
    emit("time_to_first_pixel_ms", m.timeToFirstPixelMs);
    emit("output_bytes", m.outputBytes);
    emit("time_to_final_ms", m.timeToFinalMs);
  }

  private handleMessage(msg: WorkerToMainMessage): void {
    if (this.terminated) return;
    // All session-routed WorkerToMainMessage variants carry sessionId (worker_* lifecycle
    // msgs are handled in scheduler/worker, never dispatched to per-session onMessage).
    // DS-6: single guard; per-case checks removed.
    if ((msg as { sessionId?: string }).sessionId !== this.id) return;

    switch (msg.type) {
      case "decode_header":
        this.lastInfo = msg.info;
        if (!this.headerDeferred.settled) {
          this.headerDeferred.resolve(msg.info);
        }
        // progressionTarget "header" stops the worker right after the header — it
        // sends no decode_final — so complete here, otherwise done() hangs forever.
        // localEarlyFinish=true: no terminal ack arrives, release the scheduler slot now.
        if ((this.opts.progressionTarget ?? "final") === "header") {
          this.finish(msg.info, true);
        }
        break;

      case "decode_progress": {
        this.lastInfo = msg.info;
        const ev = this.makeFrame(msg.stage, msg);
        this.frameStream.push(ev);
        // Folded per-frame metrics ride on the frame to avoid separate metric IPCs;
        // re-emit them through onMetric so telemetry consumers see them uniformly.
        this.emitFoldedMetrics(msg);
        // Mirror the worker's early-finish: for a non-"final" target with
        // emitEveryPass disabled, the worker stops after the first progress and
        // sends no decode_final, so complete here or done() would hang.
        // localEarlyFinish=true: no terminal ack arrives, release the scheduler slot now.
        if (
          (this.opts.progressionTarget ?? "final") !== "final" &&
          (this.opts.emitEveryPass ?? true) === false
        ) {
          this.finish(msg.info, true);
        }
        break;
      }

      case "decode_final": {
        this.lastInfo = msg.info;
        const ev = this.makeFrame("final", msg);
        this.frameStream.push(ev);
        this.emitFoldedMetrics(msg);
        this.finish(msg.info);
        break;
      }

      case "decode_budget_exceeded": {
        this.lastInfo = msg.info;
        const ev = this.makeFrame(msg.stage, msg);
        this.frameStream.push(ev);
        this.finishWithError(
          new JxlError(BUDGET_EXCEEDED, "Session budget exceeded", {
            sessionId: this.id,
            partial: ev,
          }),
        );
        break;
      }

      case "decode_error": {
        const { code, originalCode } = this.normalizeCode(msg.code);
        let partial: DecodeFrameEvent | undefined;
        if (code === "TruncatedStream" && msg.partialPixels !== undefined && msg.partialInfo !== undefined) {
          // partialPixelStride is required whenever partialPixels is present; a
          // stride of 0 would produce a malformed frame (task 007-errors-a7b8c9d0).
          if (msg.partialPixelStride === undefined || msg.partialPixelStride === 0) {
            this.fail(new JxlError(INTERNAL, "TruncatedStream: worker sent partialPixels without a valid partialPixelStride", { sessionId: this.id }));
            return;
          }
          partial = {
            stage: msg.partialStage ?? "pass",
            info: msg.partialInfo,
            pixels: msg.partialPixels,
            format: this.opts.format,
            pixelStride: msg.partialPixelStride,
          };
        }
        // Truncate worker-supplied message to prevent unbounded strings in
        // error objects (task 007-security-i9j0k1l2).
        // Guard String() coercion — msg.message may be an odd object whose toString() throws.
        let safeMessage: string;
        try {
          safeMessage = String(msg.message).slice(0, 512);
        } catch {
          safeMessage = "(non-stringifiable message)";
        }
        // When the wire code was unrecognised, append it so the real cause isn't lost.
        if (originalCode !== undefined) {
          safeMessage = `[wire code: ${originalCode}] ${safeMessage}`.slice(0, 512);
        }
        const err = new JxlError(code, safeMessage, {
          sessionId: this.id,
          ...(partial !== undefined ? { partial } : {}),
        });
        this.fail(err);
        break;
      }

      case "decode_cancelled":
        this.fail(new JxlError(CANCELLED, "Decode cancelled by worker", { sessionId: this.id }));
        break;

      case "metric":
        if (this.opts.onMetric !== undefined) {
          try {
            this.opts.onMetric(msg.metric);
          } catch (e) {
            if (typeof process !== "undefined" && process.env?.["NODE_ENV"] === "development") {
              console.warn(`[jxl-session] onMetric threw`, e);
            }
          }
        }
        break;

      default:
        // Unrecognized message type — log in dev mode so missing handlers are
        // caught early when the protocol gains new message types
        // (task 007-contracts-0b1c2d).
        if (typeof process !== "undefined" && process.env?.["NODE_ENV"] === "development") {
          console.warn(`[jxl-session] decode: unhandled message type '${(msg as { type: string }).type}'`);
        }
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Terminal helpers — all terminal paths funnel through finish() or fail()
  // ---------------------------------------------------------------------------

  private cleanup(): void {
    if (this.abortSignal !== null && this.abortHandler !== null) {
      this.abortSignal.removeEventListener("abort", this.abortHandler);
    }
  }

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
  private finish(info: ImageInfo, localEarlyFinish = false): void {
    if (this.terminated) return;
    this.terminated = true;
    this.cleanup();
    // Release the scheduler slot when we finished locally (no worker terminal ack coming).
    // completeSession() is idempotent on unknown sessionIds — safe to call once here.
    if (localEarlyFinish) {
      this.scheduler?.completeSession(this.id);
    }
    this.frameStream.end();
    if (!this.doneDeferred.settled) {
      this.doneDeferred.resolve(info);
    }
    if (!this.headerDeferred.settled && this.lastInfo) {
      this.headerDeferred.resolve(this.lastInfo);
    }
  }

  // Frame stream ends gracefully (consumers see all buffered frames), but
  // done() rejects. Used for budget_exceeded where the partial frame was
  // already pushed before this is called.
  private finishWithError(err: JxlError): void {
    if (this.terminated) return;
    this.terminated = true;
    this.cleanup();
    this.terminalError = err;  // DS-7
    this.frameStream.end();
    if (!this.doneDeferred.settled) {
      this.doneDeferred.reject(err);
    }
    if (!this.headerDeferred.settled) {
      this.headerDeferred.reject(err);
    }
  }

  private fail(err: JxlError): void {
    if (this.terminated) return;
    this.terminated = true;
    this.cleanup();
    this.terminalError = err;  // DS-7
    this.frameStream.fail(err);
    if (!this.doneDeferred.settled) {
      this.doneDeferred.reject(err);
    }
    if (!this.headerDeferred.settled) {
      this.headerDeferred.reject(err);
    }
  }

  private normalizeCode(code: string): { code: JxlErrorCode; originalCode: string | undefined } {
    if (KNOWN_JXL_ERROR_CODES.has(code as JxlErrorCode)) return { code: code as JxlErrorCode, originalCode: undefined };
    // Unknown wire code: map to Internal but preserve original so it isn't silently lost.
    return { code: "Internal", originalCode: code };
  }
}

// stage union verified in jxl-core/src/types.ts: DecodeStage = "header" | "dc" | "pass" | "final"
// (DS-9)
const STAGE_RANK: Record<DecodeStage, number> = { header: 0, dc: 1, pass: 2, final: 3 };

function stageRank(s: DecodeStage): number {
  return STAGE_RANK[s];
}

export async function firstFrame(
  session: Pick<DecodeSession, "frames" | "cancel">,
  opts?: { minStage?: "dc" | "pass" | "final" },
): Promise<DecodeFrameEvent> {
  for await (const f of session.frames()) {
    if (opts?.minStage === undefined || stageRank(f.stage) >= stageRank(opts.minStage)) {
      void session.cancel("first frame satisfied");
      return f;
    }
  }
  throw new JxlError(INTERNAL, "stream ended before requested stage", {});
}
