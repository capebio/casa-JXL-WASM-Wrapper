// jxl-worker-browser/src/decode-handler.ts
// Decode session handler. Owns one libjxl decoder instance per session.
// Spec: Sections 10, 8, 9, 16.1.
//
// Drives the WASM codec facade; generated libjxl adapter lands with T-WASM-BUILD.

/// <reference lib="webworker" />

import type { BrowserDecoder, JxlModule } from "./wasm-loader.js";
import type {
  MsgDecodeStart,
  MsgDecodeHeader,
  MsgDecodeProgress,
  MsgDecodeFinal,
  MsgDecodeError,
  MsgDecodeCancelled,
  MsgDecodePaused,
  MsgDecodeBudgetExceeded,
} from "@casabio/jxl-core/protocol";
import type { ImageInfo, DecodeStage, PixelFormat, Region } from "@casabio/jxl-core/types";

type DecodeState =
  | "created"
  | "headers"
  | "progressive"
  | "final"
  | "cancelled"
  | "error"
  | "budget_exceeded";

interface DecodeHandlerCallbacks {
  onSessionEnd: (sessionId: string) => void;
}

// Adaptive high-water mark: EMA of decoder.push() latency scales the drain threshold.
// Fast workers → higher HWM (buffer more) → fewer drain round-trips.
// Slow workers → lower HWM → earlier drain signal → less queued memory.
const HWM_BASE = 6;
const HWM_EMA_ALPHA = 0.25;
// Safety cap on total queued bytes. Scheduler's adaptive HWM keeps queued bytes well
// below this (~2 MiB) in normal use; cap only fires for scheduler-free or buggy callers.
const MAX_QUEUED_BYTES = 128 * 1024 * 1024; // 128 MiB
// Sanity ceiling on uncompressed output size. Rejects absurd/crafted dimensions before
// the WASM heap grows to match them. This is an overflow/DoS guard, NOT a policy limit
// on maximum decode resolution — raise via session opts if needed for legitimate huge files.
// At 4 bytes/pixel (rgba8): 1 GiB = 256 million pixels (≈ 16384×16384).
const MAX_OUTPUT_BYTES_GUARD = 1024 * 1024 * 1024; // 1 GiB
const DRAIN_MIN_INTERVAL_MS = 8;
const BYTE_DRAIN_HWM = 2 * 1024 * 1024; // 2 MiB — byte-level secondary drain gate

class ChunkRing {
  private items: Array<ArrayBuffer | undefined>;
  private head = 0;
  private tail = 0;
  private length = 0;
  private totalBytes = 0;
  private mask: number;

  // Invariant: capacity is always a power of two (default 16, grow() doubles),
  // so cursor wrap can use `& mask` instead of `%`.
  constructor(initialCapacity = 16) {
    this.items = new Array(initialCapacity);
    this.mask = initialCapacity - 1;
  }

  get size(): number {
    return this.length;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  push(chunk: ArrayBuffer): void {
    if (this.length === this.items.length) this.grow();
    this.items[this.tail] = chunk;
    this.tail = (this.tail + 1) & this.mask;
    this.length++;
    this.totalBytes += chunk.byteLength;
  }

  shift(): ArrayBuffer | null {
    if (this.length === 0) return null;
    const chunk = this.items[this.head];
    this.items[this.head] = undefined;
    this.head = (this.head + 1) & this.mask;
    this.length--;
    if (chunk !== undefined) {
      this.totalBytes -= chunk.byteLength;
      return chunk;
    }
    return null;
  }

  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.tail = 0;
    this.length = 0;
    this.totalBytes = 0;
  }

  private grow(): void {
    const cap = this.items.length * 2;
    const next = new Array<ArrayBuffer | undefined>(cap);
    for (let i = 0; i < this.length; i++) {
      next[i] = this.items[(this.head + i) & this.mask];
    }
    this.items = next;
    this.head = 0;
    this.tail = this.length;
    this.mask = cap - 1;
  }
}

export class DecodeHandler {
  private readonly sessionId: string;
  private readonly opts: MsgDecodeStart;
  private readonly wasm: JxlModule;
  private readonly callbacks: DecodeHandlerCallbacks;

  private state: DecodeState = "created";
  // ChunkRing is the single source of truth for queue depth (.size) and bytes (.bytes).
  private chunkQueue = new ChunkRing();
  private cancelled = false;
  private ended = false;
  private inputClosed = false;
  private wakeResolve: (() => void) | null = null;
  private paused = false;
  private resumeResolve: (() => void) | null = null;
  
  // Active decoder instance; shared disposal promise makes every awaiter join the same operation.
  private decoder: BrowserDecoder | null = null;
  private disposePromise: Promise<void> | null = null;

  // Drain coalescing state.
  private lastDrainPostedMs = 0;
  private lastDrainAllowed = false;

  // Adaptive drain HWM: EMA of decoder.push() duration (ms).
  private pushLatencyEma = 0;
  private copyLatencyEma = 0;
  // Elapsed from session creation; used for both budget and timing metrics.
  private readonly stageStartMs: number = performance.now();

  private firstPixelMetricPosted = false;

  // Pre-allocated message objects — avoids per-call allocation in hot paths.
  // postMessage() performs a synchronous structured clone before returning, so mutating these
  // fields after the call is safe (JS worker is single-threaded; no interleaving possible).
  private readonly _metricInner = { name: "", value: 0 };
  private readonly _metricMsg = {
    type: "metric" as const,
    sessionId: "" as string,
    metric: this._metricInner,
  };
  private readonly _drainMsg = {
    type: "worker_drain" as const,
    sessionId: "" as string,
    latencyMs: 0,
    queueDepth: 0,
    queuedBytes: 0,
    adaptiveHwm: 0,
  };

  // Cached adaptiveHwm result; invalidated when EMA drifts by ≥1 ms.
  private _cachedHwm = HWM_BASE;
  private _hwmLastEma = -1;

  constructor(
    opts: MsgDecodeStart,
    wasm: JxlModule,
    callbacks: DecodeHandlerCallbacks,
  ) {
    this.sessionId = opts.sessionId;
    this.opts = opts;
    this.wasm = wasm;
    this.callbacks = callbacks;

    this._metricMsg.sessionId = this.sessionId;
    this._drainMsg.sessionId = this.sessionId;

    this.run().catch((err: unknown) => this.failSession("Internal", String(err)));
  }

  // ---------------------------------------------------------------------------
  // Incoming message handlers (called by worker.ts router)
  // ---------------------------------------------------------------------------

  onChunk(chunk: ArrayBuffer): void {
    if (this.isTerminal() || this.inputClosed) return;
    if (chunk.byteLength === 0) return;
    if (this.chunkQueue.bytes + chunk.byteLength > MAX_QUEUED_BYTES) {
      this.failSession("QueueOverflow", `Input queue exceeded ${MAX_QUEUED_BYTES >> 20} MiB`);
      return;
    }
    this.chunkQueue.push(chunk);
    this.wake();
  }

  onClose(): void {
    if (this.isTerminal() || this.inputClosed) return;
    this.inputClosed = true;
    this.wake();
  }

  async onCancel(reason?: string): Promise<void> {
    if (this.ended || this.cancelled) return;
    this.cancelled = true;
    this.paused = false;
    this.postMetric("dropped_due_to_cancel", 1);
    if (reason !== "release_state") {
      const msg: MsgDecodeCancelled = {
        type: "decode_cancelled",
        sessionId: this.sessionId,
      };
      self.postMessage(msg);
    }
    this.finishSession("cancelled");

    // Best-effort: dispose the active decoder so any blocked event iterator is unblocked.
    void this.disposeActiveDecoder();
  }

  onPause(): void {
    if (this.isTerminal() || this.paused) return;
    this.paused = true;
    this.wake(); // wake feedDecoder so it reaches the pause check immediately
    const msg: MsgDecodePaused = { type: "decode_paused", sessionId: this.sessionId };
    self.postMessage(msg);
  }

  onResume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.wakeResume();
  }

  // ---------------------------------------------------------------------------
  // Main decode loop
  // ---------------------------------------------------------------------------

  private async run(): Promise<void> {
    // One libjxl decoder per session. Workers are stateless between sessions
    // (see CLAUDE.md: caching decoder state across session lifetimes would break
    // recycle()), and libjxl exposes no reset ABI — so there is no decoder pool.
    const decoder = this.wasm.createDecoder({
      format: this.opts.format,
      region: this.opts.region,
      downsample: this.opts.downsample,
      progressionTarget: this.opts.progressionTarget,
      emitEveryPass: this.opts.emitEveryPass,
      ...(this.opts.progressiveDetail !== null ? { progressiveDetail: this.opts.progressiveDetail } : {}),
      suppressDuplicateProgress: this.opts.suppressDuplicateProgress,
      preserveIcc: this.opts.preserveIcc,
      preserveMetadata: this.opts.preserveMetadata,
      targetWidth: this.opts.targetWidth,
      targetHeight: this.opts.targetHeight,
      fitMode: this.opts.fitMode,
      onMetric: (name: string, value: number) => this.postMetric(name, value),
    });

    // Store decoder reference so terminal paths can actively dispose it.
    this.decoder = decoder;

    try {
      await Promise.all([this.feedDecoder(decoder), this.readDecoderEvents(decoder)]);
    } catch (err: unknown) {
      this.failSession("Internal", err instanceof Error ? err.message : String(err));
    } finally {
      // Ensure session finish and best-effort disposal of decoder to unblock
      // any pending async iterators inside the decoder implementation.
      this.finishSession(this.state);
      await this.disposeActiveDecoder();
    }
  }

  // ---------------------------------------------------------------------------
  // Terminal-state helpers
  // ---------------------------------------------------------------------------

  private isTerminal(): boolean {
    // finishSession() is the single path that sets ended=true for all terminal
    // states; this.ended is always true when any individual state flag is set.
    return this.ended;
  }

  // Single path for all session endings. Sets state, clears the input queue,
  // and wakes both sleeping loops so Promise.all resolves and decoder.dispose runs.
  private finishSession(state: DecodeState): boolean {
    if (this.ended) return false;
    this.ended = true;
    this.state = state;
    this.clearInputQueue();
    this.wake();       // unblock feedDecoder sleeping in waitForChunk
    this.wakeResume(); // unblock feedDecoder sleeping in waitForResume
    this.callbacks.onSessionEnd(this.sessionId);
    return true;
  }

  private clearInputQueue(): void {
    this.chunkQueue.clear();
  }

  private wake(): void {
    const resolve = this.wakeResolve;
    if (resolve !== null) {
      this.wakeResolve = null;
      resolve();
    }
  }

  private wakeResume(): void {
    const resolve = this.resumeResolve;
    if (resolve !== null) {
      this.resumeResolve = null;
      resolve();
    }
  }

  private disposeActiveDecoder(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    const decoder = this.decoder;
    if (decoder === null) return Promise.resolve();
    this.decoder = null;
    // Facade decoders are one-shot: events() may only be consumed once and state is not resettable.
    this.disposePromise = Promise.resolve(decoder.dispose()).catch((e: unknown) => {
      console.error('[jxl-worker] disposeActiveDecoder failed:', e);
    });
    return this.disposePromise;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private waitForChunk(): Promise<void> {
    if (this.chunkQueue.size > 0 || this.inputClosed || this.isTerminal()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => { this.wakeResolve = resolve; });
  }

  private waitForResume(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve) => { this.resumeResolve = resolve; });
  }

  private takeNextChunk(): ArrayBuffer | null {
    return this.chunkQueue.shift();
  }

  private async feedDecoder(decoder: BrowserDecoder): Promise<void> {
    while (!this.ended) {
      if (this.paused) {
        await this.waitForResume();
        continue;
      }

      // Skip the await when chunks are already queued — avoids a microtask
      // yield on every outer iteration during active streaming.
      if (this.chunkQueue.size === 0 && !this.inputClosed) {
        await this.waitForChunk();
        if (this.ended || this.paused) continue;
      }

      while (!this.ended && this.chunkQueue.size > 0) {
        if (this.paused) break;
        const chunk = this.takeNextChunk();
        if (chunk === null) break;

        const t0 = performance.now();
        const pushed = decoder.push(chunk);
        if (pushed !== undefined) await pushed;
        // Reuse the post-push timestamp for drain coalescing — avoids a
        // redundant performance.now() call in maybePostDrain.
        const now = performance.now();
        const pushMs = now - t0;
        this.pushLatencyEma = HWM_EMA_ALPHA * pushMs + (1 - HWM_EMA_ALPHA) * this.pushLatencyEma;

        this.maybePostDrain(now);
      }

      if (this.inputClosed && !this.ended) {
        const closed = decoder.close();
        if (closed !== undefined) await closed;
        return;
      }
    }
  }

  private maybePostDrain(now: number): void {
    const hwm = this.adaptiveHwm();

    const drainAllowed =
      this.chunkQueue.size < hwm && this.chunkQueue.bytes < BYTE_DRAIN_HWM;

    const crossedIntoDrain = drainAllowed && !this.lastDrainAllowed;
    const intervalElapsed = now - this.lastDrainPostedMs >= DRAIN_MIN_INTERVAL_MS;

    this.lastDrainAllowed = drainAllowed;

    if (!drainAllowed) return;
    if (!crossedIntoDrain && !intervalElapsed) return;

    this.lastDrainPostedMs = now;

    this._drainMsg.latencyMs = Math.round(this.pushLatencyEma);
    this._drainMsg.queueDepth = this.chunkQueue.size;
    this._drainMsg.queuedBytes = this.chunkQueue.bytes;
    this._drainMsg.adaptiveHwm = hwm;
    self.postMessage(this._drainMsg);
  }

  private async readDecoderEvents(decoder: BrowserDecoder): Promise<void> {
    for await (const event of decoder.events()) {
      if (this.isTerminal()) return;
      switch (event.type) {
        case "header": {
          this.state = "headers";
          // Overflow / absurd-size guard: reject before the WASM heap ever needs to hold
          // the pixel buffer. width*height*bytesPerPixel can overflow to Infinity for a
          // crafted codestream; MAX_OUTPUT_BYTES_GUARD is a conservative ceiling.
          // Do NOT gate on format-specific calculations alone — use the conservative
          // minimum (1 byte/px) so any format that would exceed the cap is caught.
          const { width, height } = event.info;
          const minOutputBytes = width * height; // minimum 1 byte/pixel (most restrictive)
          if (!Number.isFinite(minOutputBytes) || minOutputBytes > MAX_OUTPUT_BYTES_GUARD) {
            this.failSession(
              "InvalidInput",
              `Output dimensions too large: ${width}×${height} exceeds sanity limit`,
            );
            return;
          }
          const msg: MsgDecodeHeader = { type: "decode_header", sessionId: this.sessionId, info: event.info };
          self.postMessage(msg);
          this.postMetric("time_to_header_ms", performance.now() - this.stageStartMs);
          if (this.opts.progressionTarget === "header") {
            this.finishSession("final");
            return;
          }
          break;
        }
        case "progress": {
          this.state = "progressive";
          // Budget check 1 (before touching pixels): if budget is already exceeded when this
          // progress arrives, exit cheaply WITHOUT materializing event.pixels — the getter /
          // copy can be costly. The consumer keeps its last in-budget frame; the empty buffer
          // marks the stop.
          if (this.checkBudget()) {
            this.postMetric("dropped_due_to_budget", 1);
            this.postBudgetExceeded(event.stage, event.info, new ArrayBuffer(0), event.format, event.pixelStride, event);
            return;
          }
          const t0 = performance.now();
          const transfer = toTransferablePixels(event.pixels);
          const tToArray = performance.now() - t0;
          this.copyLatencyEma = HWM_EMA_ALPHA * tToArray + (1 - HWM_EMA_ALPHA) * this.copyLatencyEma;

          // Budget check 2 (after the copy): if budget crossed during the copy we just did,
          // send the already-copied pixels (don't waste the copy). postMessage detaches the
          // buffer, so this is terminal. Copy metrics posted directly here — no frame to fold.
          if (this.checkBudget()) {
            if (transfer.copied) {
              this.postMetric("copy_to_transfer_ms", tToArray);
              this.postMetric("copied_bytes", transfer.buffer.byteLength);
            }
            this.postMetric("dropped_due_to_budget", 1);
            this.postBudgetExceeded(event.stage, event.info, transfer.buffer, event.format, event.pixelStride, event);
            return;
          }
          const msg: MsgDecodeProgress = {
            type: "decode_progress",
            sessionId: this.sessionId,
            stage: event.stage,
            info: event.info,
            pixels: transfer.buffer,
            format: event.format,
            pixelStride: event.pixelStride,
          };
          assignFrameMeta(msg, event);
          // Fold per-frame metrics onto the frame (session re-emits as CodecMetric) —
          // avoids separate metric IPCs on the hot progress path.
          if (transfer.copied) {
            msg.copyMs = tToArray;
            msg.copiedBytes = transfer.buffer.byteLength;
          }
          if (!this.firstPixelMetricPosted) {
            this.firstPixelMetricPosted = true;
            msg.timeToFirstPixelMs = performance.now() - this.stageStartMs;
          }
          self.postMessage(msg, transferList(transfer.buffer));
          if (this.opts.progressionTarget !== "final" && !this.opts.emitEveryPass) {
            this.finishSession("final");
            return;
          }
          break;
        }
        case "final": {
          // Budget check 1 (before touching pixels): exit cheaply without materializing
          // event.pixels if budget is already exceeded. (Same lazy pattern as "progress".)
          if (this.checkBudget()) {
            this.postMetric("dropped_due_to_budget", 1);
            this.postBudgetExceeded("final", event.info, new ArrayBuffer(0), event.format, event.pixelStride, event);
            return;
          }
          const t0 = performance.now();
          const transfer = toTransferablePixels(event.pixels);
          const tToArray = performance.now() - t0;
          this.copyLatencyEma = HWM_EMA_ALPHA * tToArray + (1 - HWM_EMA_ALPHA) * this.copyLatencyEma;

          // Budget check 2 (after the copy): send the already-copied pixels if budget crossed
          // during the copy. postMessage detaches the buffer so this is terminal.
          if (this.checkBudget()) {
            if (transfer.copied) {
              this.postMetric("copy_to_transfer_ms", tToArray);
              this.postMetric("copied_bytes", transfer.buffer.byteLength);
            }
            this.postMetric("dropped_due_to_budget", 1);
            this.postBudgetExceeded("final", event.info, transfer.buffer, event.format, event.pixelStride, event);
            return;
          }
          const now = performance.now();
          const msg: MsgDecodeFinal = {
            type: "decode_final",
            sessionId: this.sessionId,
            info: event.info,
            pixels: transfer.buffer,
            format: event.format,
            pixelStride: event.pixelStride,
            outputBytes: transfer.buffer.byteLength,
            timeToFinalMs: now - this.stageStartMs,
          };
          assignFrameMeta(msg, event);
          // Fold per-frame metrics onto the frame (session re-emits as CodecMetric).
          if (transfer.copied) {
            msg.copyMs = tToArray;
            msg.copiedBytes = transfer.buffer.byteLength;
          }
          // Embed first-pixel timing if it hasn't been reported via a progress event.
          if (!this.firstPixelMetricPosted) {
            this.firstPixelMetricPosted = true;
            msg.timeToFirstPixelMs = now - this.stageStartMs;
          }
          self.postMessage(msg, transferList(transfer.buffer));
          this.finishSession("final");
          return;
        }
        case "budget_exceeded": {
          // Measure copy time the same way the progress/final budget arms do.
          // postBudgetExceeded posts output_bytes for ALL paths; do NOT also post
          // copied_bytes here — that would double-count the same buffer under two names.
          const t0 = performance.now();
          const transfer = toTransferablePixels(event.pixels);
          if (transfer.copied) {
            this.postMetric("copy_to_transfer_ms", performance.now() - t0);
          }
          this.postMetric("dropped_due_to_budget", 1);
          this.postBudgetExceeded(event.stage, event.info, transfer.buffer, event.format, event.pixelStride, event);
          return;
        }
        case "error": {
          this.failSession(
            event.code,
            event.message,
            event.partialPixels !== undefined ? toArrayBuffer(event.partialPixels) : undefined,
            event.partialInfo,
            event.partialPixelStride ?? (event.partialPixels !== undefined ? pixelStrideForFormat(this.opts.format) : undefined),
            event.partialStage,
          );
          return;
        }
      }
    }
  }

  private adaptiveHwm(): number {
    const ema = Math.max(this.pushLatencyEma, this.copyLatencyEma);
    if (Math.abs(ema - this._hwmLastEma) < 1.0) return this._cachedHwm;
    this._hwmLastEma = ema;
    const factor = Math.max(0.6, Math.min(2.0, 120 / (ema + 10)));
    this._cachedHwm = Math.floor(HWM_BASE * factor);
    return this._cachedHwm;
  }

  private checkBudget(): boolean {
    if (this.opts.budgetMs == null) return false;
    return performance.now() - this.stageStartMs > this.opts.budgetMs;
  }

  private failSession(
    code: string,
    message: string,
    partialPixels?: ArrayBuffer,
    partialInfo?: ImageInfo,
    partialPixelStride?: number,
    partialStage?: DecodeStage,
  ): void {
    if (this.ended) return;
    const msg: MsgDecodeError = {
      type: "decode_error",
      sessionId: this.sessionId,
      code,
      message,
    };
    const transfers: ArrayBuffer[] = [];
    if (partialPixels !== undefined && partialInfo !== undefined) {
      msg.partialPixels = partialPixels;
      msg.partialInfo = partialInfo;
      if (partialPixelStride !== undefined) msg.partialPixelStride = partialPixelStride;
      if (partialStage !== undefined) msg.partialStage = partialStage;
      transfers.push(...transferList(partialPixels));
    }
    self.postMessage(msg, transfers);
    this.finishSession("error");
    // Best-effort unblock of decoder.events().
    void this.disposeActiveDecoder();
  }

  private postBudgetExceeded(
    stage: DecodeStage,
    info: ImageInfo,
    pixels: ArrayBuffer,
    format: MsgDecodeBudgetExceeded["format"],
    pixelStride: number,
    meta: FrameMetaSource,
  ): void {
    if (this.ended) return;
    const msg: MsgDecodeBudgetExceeded = {
      type: "decode_budget_exceeded",
      sessionId: this.sessionId,
      stage,
      pixels,
      info,
      format,
      pixelStride,
    };
    assignFrameMeta(msg, meta);
    this.postMetric("output_bytes", pixels.byteLength);
    self.postMessage(msg, transferList(pixels));
    this.finishSession("budget_exceeded");
    // Best-effort unblock of decoder.events().
    void this.disposeActiveDecoder();
  }

  private postMetric(name: string, value: number): void {
    this._metricInner.name = name;
    this._metricInner.value = value;
    self.postMessage(this._metricMsg);
  }
}

// Shared frame-metadata copy for progress/final frames — mirrors protocol DecodeFrameMeta
// so the two emit paths cannot drift (the duplication this removes is what forced the
// budget two-check fix to be applied in both arms). Fields are `| undefined` to accept the
// decoder event (present-but-undefined optionals) under exactOptionalPropertyTypes.
type FrameMetaSource = {
  region?: Region | undefined;
  sourceScale?: number | undefined;
  progressiveRegion?: boolean | undefined;
  regionFallback?: "full-frame-then-crop" | undefined;
  progressiveSequence?: number | undefined;
  passOrdinal?: number | undefined;
  frameIndex?: number | undefined;
  frameDuration?: number | undefined;
  frameName?: string | undefined;
  animTicksPerSecond?: number | undefined;
};

function assignFrameMeta(msg: MsgDecodeProgress | MsgDecodeFinal | MsgDecodeBudgetExceeded, src: FrameMetaSource): void {
  if (src.region !== undefined) msg.region = src.region;
  if (src.sourceScale !== undefined) msg.sourceScale = src.sourceScale;
  if (src.progressiveRegion !== undefined) msg.progressiveRegion = src.progressiveRegion;
  if (src.regionFallback !== undefined) msg.regionFallback = src.regionFallback;
  if (src.progressiveSequence !== undefined) msg.progressiveSequence = src.progressiveSequence;
  if (src.passOrdinal !== undefined) msg.passOrdinal = src.passOrdinal;
  if (src.frameIndex !== undefined) msg.frameIndex = src.frameIndex;
  if (src.frameDuration !== undefined) msg.frameDuration = src.frameDuration;
  if (src.frameName !== undefined) msg.frameName = src.frameName;
  if (src.animTicksPerSecond !== undefined) msg.animTicksPerSecond = src.animTicksPerSecond;
}

function toTransferablePixels(value: ArrayBuffer | Uint8Array): { buffer: ArrayBuffer; copied: boolean } {
  if (value instanceof ArrayBuffer) return { buffer: value, copied: false };
  const buf = value.buffer;
  // SharedArrayBuffer (threaded / SIMD-MT WASM builds) cannot appear in a postMessage
  // transfer list — return the SAB reference directly (zero-copy). Callers must use
  // transferList() so the SAB is omitted from the transfer list (shared, not transferred).
  if (typeof SharedArrayBuffer !== "undefined" && buf instanceof SharedArrayBuffer) {
    return { buffer: buf as unknown as ArrayBuffer, copied: false };
  }
  // Owned TypedArray (offset 0, covers the whole buffer): transfer without a second
  // full-frame memcpy. Facade always hands a fresh copy for progressive frames and an
  // ownership-transferred buffer for final — never a live WASM heap view — so detaching
  // is safe. Sub-views (byteOffset > 0 or partial length) still must slice so we do not
  // transfer a larger shared backing buffer.
  if (value.byteOffset === 0 && value.byteLength === buf.byteLength) {
    return { buffer: buf as ArrayBuffer, copied: false };
  }
  return {
    buffer: buf.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer,
    copied: true,
  };
}

// SAB cannot be in a transfer list — postMessage shares it by reference instead.
function transferList(buf: ArrayBuffer): ArrayBuffer[] {
  if (typeof SharedArrayBuffer !== "undefined" && (buf as unknown) instanceof SharedArrayBuffer) return [];
  return [buf];
}

function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  return toTransferablePixels(value).buffer;
}

function pixelStrideForFormat(format: PixelFormat): number {
  if (format === "rgb8") return 3;
  return format === "rgbaf32" ? 16 : format === "rgba16" ? 8 : 4;
}
