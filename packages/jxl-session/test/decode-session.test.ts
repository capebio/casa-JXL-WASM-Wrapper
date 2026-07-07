// jxl-session/test/decode-session.test.ts
// Unit tests for DecodeSessionImpl — lifecycle, push ordering, cancel paths,
// error normalization, budget expiry. Driven by a real Scheduler + FakeWorker.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DecodeSessionImpl } from "../src/decode-session.js";
import { JxlError } from "@casabio/jxl-core/errors";
import type { DecodeFrameEvent } from "@casabio/jxl-core";
import { makeScheduler, waitForWorker, tick, imageInfo } from "./helpers.js";

async function collectFrames(session: DecodeSessionImpl): Promise<DecodeFrameEvent[]> {
  const out: DecodeFrameEvent[] = [];
  for await (const f of session.frames()) out.push(f);
  return out;
}

describe("DecodeSessionImpl lifecycle", () => {
  it("sends decode_start with options mapped from DecodeOptions", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, {
      format: "rgba16",
      progressionTarget: "dc",
      downsample: 4,
      priority: "near",
      suppressDuplicateProgress: true,
    });
    const worker = await waitForWorker(workers);
    const start = worker.messages[0];
    assert.equal(start?.type, "decode_start");
    assert.equal(start && "format" in start ? start.format : null, "rgba16");
    assert.equal(start && "progressionTarget" in start ? start.progressionTarget : null, "dc");
    assert.equal(start && "downsample" in start ? start.downsample : null, 4);
    assert.equal(start && "priority" in start ? start.priority : null, "near");
    assert.equal(start && "suppressDuplicateProgress" in start ? start.suppressDuplicateProgress : null, true);
    await session.cancel();
    await scheduler.shutdown();
  });

  it("applies spec defaults for omitted options", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8" });
    const worker = await waitForWorker(workers);
    const start = worker.messages[0]!;
    assert.equal(start.type, "decode_start");
    if (start.type === "decode_start") {
      assert.equal(start.progressionTarget, "final");
      assert.equal(start.emitEveryPass, true);
      assert.equal(start.preserveIcc, true);
      assert.equal(start.preserveMetadata, true);
      assert.equal(start.downsample, 1);
      assert.equal(start.priority, "visible");
      assert.equal(start.suppressDuplicateProgress, false);
      assert.equal(start.budgetMs, null);
      assert.equal(start.region, null);
    }
    await session.cancel();
    await scheduler.shutdown();
  });

  it("done() resolves with ImageInfo on decode_final", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8" });
    const worker = await waitForWorker(workers);
    const info = imageInfo({ width: 100, height: 80 });
    worker.emit({ type: "decode_header", sessionId: session.id, info });
    worker.emit({
      type: "decode_final", sessionId: session.id, info,
      pixels: new ArrayBuffer(16), format: "rgba8", pixelStride: 400,
    });
    const got = await session.done();
    assert.equal(got.width, 100);
    assert.equal(got.height, 80);
    await scheduler.shutdown();
  });

  it("frames() yields progress events then a final frame", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8" });
    const worker = await waitForWorker(workers);
    const info = imageInfo();
    worker.emit({ type: "decode_progress", sessionId: session.id, stage: "dc", info, pixels: new ArrayBuffer(8), format: "rgba8", pixelStride: 256 });
    worker.emit({ type: "decode_progress", sessionId: session.id, stage: "pass", info, pixels: new ArrayBuffer(8), format: "rgba8", pixelStride: 256 });
    worker.emit({ type: "decode_final", sessionId: session.id, info, pixels: new ArrayBuffer(8), format: "rgba8", pixelStride: 256 });
    const frames = await collectFrames(session);
    assert.deepEqual(frames.map((f) => f.stage), ["dc", "pass", "final"]);
    await scheduler.shutdown();
  });

  it("push() forwards decode_chunk messages in order", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8" });
    const worker = await waitForWorker(workers);
    await session.push(new Uint8Array([1, 2, 3]));
    await session.push(new Uint8Array([4, 5, 6]));
    await session.close();
    const chunkMsgs = worker.messages.filter((m) => m.type === "decode_chunk");
    assert.equal(chunkMsgs.length, 2);
    assert.ok(worker.messages.some((m) => m.type === "decode_close"));
    await session.cancel();
    await scheduler.shutdown();
  });
});

describe("DecodeSessionImpl cancel paths", () => {
  it("cancel() rejects done() with JxlError code Cancelled", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8" });
    await waitForWorker(workers);
    await session.cancel("user closed tab");
    await assert.rejects(session.done(), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "Cancelled");
      return true;
    });
    await scheduler.shutdown();
  });

  it("AbortSignal rejects done() with Cancelled", async () => {
    const { scheduler, workers } = makeScheduler();
    const ac = new AbortController();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8", signal: ac.signal });
    await waitForWorker(workers);
    ac.abort();
    await assert.rejects(session.done(), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "Cancelled");
      return true;
    });
    await scheduler.shutdown();
  });

  it("already-aborted signal rejects done() with Cancelled immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    const { scheduler } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8", signal: ac.signal });
    await assert.rejects(session.done(), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "Cancelled");
      return true;
    });
    await scheduler.shutdown();
  });

  it("does not send decode_chunk after session is cancelled while push waits on drain", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8" });
    const worker = await waitForWorker(workers);

    // Default adaptive HWM ≈ 4. Push 3 chunks (non-blocking: queueDepth 1-3 < 4).
    // No worker_drain emitted, so queueDepth keeps growing.
    for (let i = 0; i < 3; i++) {
      await session.push(new Uint8Array([i]));
    }

    // 4th push increments queueDepth to 4 (>= HWM), blocks at waitForDrain.
    const pushPromise = session.push(new Uint8Array([99]));

    await tick(); // let the 4th push reach and block inside waitForDrain

    const chunksBefore = worker.messages.filter((m) => m.type === "decode_chunk").length;
    assert.equal(chunksBefore, 3);

    // cancel() unblocks the drain waiter, then sets terminated = true before
    // the resumed push() coroutine can run.
    await session.cancel();
    await pushPromise;

    const chunksAfter = worker.messages.filter((m) => m.type === "decode_chunk").length;
    assert.equal(chunksAfter, 3, "4th chunk must not be sent after cancellation");

    await scheduler.shutdown();
  });

  it("custom pushHwm allows five pre-first-paint decode chunks before drain", async () => {
    const { scheduler, workers } = makeScheduler(2, 64);
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8" });
    const worker = await waitForWorker(workers);

    for (let i = 0; i < 5; i++) {
      await session.push(new Uint8Array([i]));
    }

    const chunkCount = worker.messages.filter((m) => m.type === "decode_chunk").length;
    assert.equal(chunkCount, 5);

    await session.cancel();
    await scheduler.shutdown();
  });

  it("push() after close throws ConfigError", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8" });
    await waitForWorker(workers);
    await session.close();
    await assert.rejects(session.push(new Uint8Array([1])), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "ConfigError");
      return true;
    });
    await session.cancel();
    await scheduler.shutdown();
  });
});

describe("DecodeSessionImpl error normalization", () => {
  it("decode_error with a known code surfaces that code", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8" });
    const worker = await waitForWorker(workers);
    worker.emit({ type: "decode_error", sessionId: session.id, code: "MalformedCodestream", message: "bad" });
    await assert.rejects(session.done(), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "MalformedCodestream");
      return true;
    });
    await scheduler.shutdown();
  });

  it("decode_error with an unknown code normalizes to Internal", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8" });
    const worker = await waitForWorker(workers);
    worker.emit({ type: "decode_error", sessionId: session.id, code: "WeirdUnlistedCode", message: "?" });
    await assert.rejects(session.done(), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "Internal");
      return true;
    });
    await scheduler.shutdown();
  });

  it("TruncatedStream error carries the partial frame", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8" });
    const worker = await waitForWorker(workers);
    worker.emit({
      type: "decode_error", sessionId: session.id,
      code: "TruncatedStream", message: "cut short",
      partialPixels: new ArrayBuffer(32), partialInfo: imageInfo(), partialPixelStride: 4,
    });
    await assert.rejects(session.done(), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "TruncatedStream");
      assert.ok(err.partial !== undefined, "partial frame attached");
      return true;
    });
    await scheduler.shutdown();
  });
});

describe("DecodeSessionImpl budget expiry", () => {
  it("decode_budget_exceeded yields a partial frame and rejects done()", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8", budgetMs: 50 });
    const worker = await waitForWorker(workers);
    const info = imageInfo();
    worker.emit({
      type: "decode_budget_exceeded", sessionId: session.id, stage: "dc",
      pixels: new ArrayBuffer(8), info, format: "rgba8", pixelStride: 256,
    });
    const frames = await collectFrames(session);
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.stage, "dc");
    await assert.rejects(session.done(), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "BudgetExceeded");
      assert.ok(err.partial !== undefined, "best frame attached to error");
      return true;
    });
    await scheduler.shutdown();
  });

  it("decode_budget_exceeded: frame event carries all DecodeFrameMeta fields", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8", budgetMs: 50 });
    const worker = await waitForWorker(workers);
    const info = imageInfo();
    worker.emit({
      type: "decode_budget_exceeded", sessionId: session.id, stage: "dc",
      pixels: new ArrayBuffer(8), info, format: "rgba8", pixelStride: 256,
      region: { x: 10, y: 20, w: 30, h: 40 },
      sourceScale: 2,
      progressiveRegion: true,
      regionFallback: "full-frame-then-crop" as const,
      progressiveSequence: 3,
      passOrdinal: 1,
      frameIndex: 5,
      frameDuration: 100,
      frameName: "hero",
      animTicksPerSecond: 24,
    });
    const frames = await collectFrames(session);
    assert.equal(frames.length, 1);
    const f = frames[0]!;
    assert.deepEqual(f.region, { x: 10, y: 20, w: 30, h: 40 });
    assert.equal(f.sourceScale, 2);
    assert.equal(f.progressiveRegion, true);
    assert.equal(f.regionFallback, "full-frame-then-crop");
    assert.equal(f.progressiveSequence, 3);
    assert.equal(f.passOrdinal, 1);
    assert.equal(f.frameIndex, 5);
    assert.equal(f.frameDuration, 100);
    assert.equal(f.frameName, "hero");
    assert.equal(f.animTicksPerSecond, 24);
    await session.done().catch(() => undefined);
    await scheduler.shutdown();
  });

  it("decode_progress → frame event carries all DecodeFrameMeta fields", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8" });
    const worker = await waitForWorker(workers);
    const info = imageInfo();
    worker.emit({
      type: "decode_progress", sessionId: session.id, stage: "dc",
      pixels: new ArrayBuffer(8), info, format: "rgba8", pixelStride: 256,
      region: { x: 0, y: 0, w: 4, h: 4 },
      sourceScale: 4,
      progressiveRegion: false,
      regionFallback: "full-frame-then-crop" as const,
      progressiveSequence: 1,
      passOrdinal: 0,
      frameIndex: 2,
      frameDuration: 33,
      frameName: "dc-frame",
      animTicksPerSecond: 30,
    });
    worker.emit({ type: "decode_final", sessionId: session.id, info, pixels: new ArrayBuffer(8), format: "rgba8", pixelStride: 256 });
    const frames = await collectFrames(session);
    const progress = frames.find((f) => f.stage === "dc");
    assert.ok(progress !== undefined, "expected a dc progress frame");
    assert.deepEqual(progress.region, { x: 0, y: 0, w: 4, h: 4 });
    assert.equal(progress.sourceScale, 4);
    assert.equal(progress.progressiveRegion, false);
    assert.equal(progress.regionFallback, "full-frame-then-crop");
    assert.equal(progress.progressiveSequence, 1);
    assert.equal(progress.passOrdinal, 0);
    assert.equal(progress.frameIndex, 2);
    assert.equal(progress.frameDuration, 33);
    assert.equal(progress.frameName, "dc-frame");
    assert.equal(progress.animTicksPerSecond, 30);
    await scheduler.shutdown();
  });

  it("decode_final → frame event carries all DecodeFrameMeta fields", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8" });
    const worker = await waitForWorker(workers);
    const info = imageInfo();
    worker.emit({ type: "decode_header", sessionId: session.id, info });
    worker.emit({
      type: "decode_final", sessionId: session.id, info,
      pixels: new ArrayBuffer(8), format: "rgba8", pixelStride: 256,
      region: { x: 1, y: 2, w: 3, h: 4 },
      sourceScale: 8,
      progressiveRegion: false,
      regionFallback: "full-frame-then-crop" as const,
      progressiveSequence: 0,
      passOrdinal: 2,
      frameIndex: 7,
      frameDuration: 50,
      frameName: "final-frame",
      animTicksPerSecond: 60,
    });
    const frames = await collectFrames(session);
    const final = frames.find((f) => f.stage === "final");
    assert.ok(final !== undefined, "expected a final frame");
    assert.deepEqual(final.region, { x: 1, y: 2, w: 3, h: 4 });
    assert.equal(final.sourceScale, 8);
    assert.equal(final.progressiveRegion, false);
    assert.equal(final.regionFallback, "full-frame-then-crop");
    assert.equal(final.progressiveSequence, 0);
    assert.equal(final.passOrdinal, 2);
    assert.equal(final.frameIndex, 7);
    assert.equal(final.frameDuration, 50);
    assert.equal(final.frameName, "final-frame");
    assert.equal(final.animTicksPerSecond, 60);
    await scheduler.shutdown();
  });
});

describe("DecodeSessionImpl telemetry", () => {
  it("forwards metric messages to onMetric", async () => {
    const seen: Array<{ name: string; value: number }> = [];
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, {
      format: "rgba8",
      onMetric: (m) => seen.push(m),
    });
    const worker = await waitForWorker(workers);
    worker.emit({ type: "metric", sessionId: session.id, metric: { name: "time_to_header_ms", value: 12 } });
    await tick();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.name, "time_to_header_ms");
    assert.equal(seen[0]?.value, 12);
    await session.cancel();
    await scheduler.shutdown();
  });

  it("re-emits folded per-frame metrics through onMetric (mapped names, absent fields skipped)", async () => {
    const seen: Array<{ name: string; value: number }> = [];
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, {
      format: "rgba8",
      onMetric: (m) => seen.push(m),
    });
    const worker = await waitForWorker(workers);
    const info = imageInfo();
    // decode_final carrying folded metrics; timeToFinalMs omitted → must NOT emit.
    worker.emit({
      type: "decode_final", sessionId: session.id, info,
      pixels: new ArrayBuffer(8), format: "rgba8", pixelStride: 256,
      copyMs: 0.5, copiedBytes: 1024, timeToFirstPixelMs: 12, outputBytes: 2048,
    });
    await session.done();
    // Order + name mapping is the folding contract (emitFoldedMetrics).
    assert.deepEqual(seen, [
      { name: "copy_to_transfer_ms", value: 0.5 },
      { name: "copied_bytes", value: 1024 },
      { name: "time_to_first_pixel_ms", value: 12 },
      { name: "output_bytes", value: 2048 },
    ]);
    await scheduler.shutdown();
  });

  it("a throwing onMetric on one folded field does not suppress the remaining fields", async () => {
    const seen: string[] = [];
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, {
      format: "rgba8",
      onMetric: (m) => {
        seen.push(m.name);
        if (m.name === "copied_bytes") throw new Error("consumer boom");
      },
    });
    const worker = await waitForWorker(workers);
    const info = imageInfo();
    worker.emit({
      type: "decode_final", sessionId: session.id, info,
      pixels: new ArrayBuffer(8), format: "rgba8", pixelStride: 256,
      copyMs: 1, copiedBytes: 2, timeToFirstPixelMs: 3, outputBytes: 4, timeToFinalMs: 5,
    });
    await session.done();
    // The throw on copied_bytes is caught per-metric; the other 4 still emit.
    assert.deepEqual(seen, [
      "copy_to_transfer_ms", "copied_bytes", "time_to_first_pixel_ms", "output_bytes", "time_to_final_ms",
    ]);
    await scheduler.shutdown();
  });
});

describe("DecodeSessionImpl missing coverage", () => {
  // Task 007-errors-f2a3b4c5: AbortSignal abort while push() is blocked at waitForDrain.
  it("AbortSignal fires while push() is waiting on drain — push resolves and done() rejects", async () => {
    const { scheduler, workers } = makeScheduler();
    const ac = new AbortController();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8", signal: ac.signal });
    await waitForWorker(workers);

    // Fill the scheduler drain queue (push 3 non-blocking, 4th blocks at waitForDrain).
    for (let i = 0; i < 3; i++) {
      await session.push(new Uint8Array([i]));
    }
    const pushPromise = session.push(new Uint8Array([99]));
    await tick(); // let 4th push reach waitForDrain

    // Abort while the 4th push is suspended.
    ac.abort();
    // push() should resolve (not hang) after the abort unblocks the drain.
    await pushPromise;

    await assert.rejects(session.done(), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "Cancelled");
      return true;
    });
    await scheduler.shutdown();
  });

  // Task 007-errors-a3b4c5d6: concurrent cancel() calls — idempotency.
  it("concurrent cancel() calls do not double-invoke cancelSession or throw", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8" });
    await waitForWorker(workers);

    // Fire two cancel() calls simultaneously; both must resolve without error.
    await Promise.all([session.cancel("race-1"), session.cancel("race-2")]);

    await assert.rejects(session.done(), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "Cancelled");
      return true;
    });
    await scheduler.shutdown();
  });

  // Task 007-errors-e1f2a3b4: decode_budget_exceeded with a concurrent frames()+done() consumer.
  it("budget_exceeded: frames() consumer sees partial frame while done() rejects concurrently", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new DecodeSessionImpl(scheduler, { format: "rgba8", budgetMs: 50 });
    const worker = await waitForWorker(workers);
    const info = imageInfo();

    // Start both consumers before emitting the budget message.
    const framesPromise = collectFrames(session);
    const donePromise = session.done().catch((e: unknown) => e);

    worker.emit({
      type: "decode_budget_exceeded", sessionId: session.id, stage: "dc",
      pixels: new ArrayBuffer(8), info, format: "rgba8", pixelStride: 256,
    });

    const [frames, doneResult] = await Promise.all([framesPromise, donePromise]);

    assert.equal(frames.length, 1, "frames() consumer sees the partial frame");
    assert.equal(frames[0]?.stage, "dc");
    assert.ok(doneResult instanceof JxlError, "done() rejects with JxlError");
    assert.equal((doneResult as JxlError).code, "BudgetExceeded");
    await scheduler.shutdown();
  });
});
