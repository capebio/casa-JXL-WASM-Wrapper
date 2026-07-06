// jxl-session/test/encode-session.test.ts
// Unit tests for EncodeSessionImpl — lifecycle, chunk emission, cancel,
// error normalization, quality/distance defaulting.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EncodeSessionImpl, encodeOptionsToStartMsg } from "../src/encode-session.js";
import type { EncodeOptions } from "@casabio/jxl-core";
import { JxlError } from "@casabio/jxl-core/errors";
import { makeScheduler, waitForWorker, tick } from "./helpers.js";

const baseOpts = { format: "rgba8" as const, width: 64, height: 48, hasAlpha: false };

describe("EncodeSessionImpl lifecycle", () => {
  it("sends encode_start with options mapped from EncodeOptions", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, {
      ...baseOpts, effort: 7, progressive: true, previewFirst: true, chunked: true, priority: "background",
    });
    const worker = await waitForWorker(workers);
    const start = worker.messages[0]!;
    assert.equal(start.type, "encode_start");
    if (start.type === "encode_start") {
      assert.equal(start.effort, 7);
      assert.equal(start.progressive, true);
      assert.equal(start.previewFirst, true);
      assert.equal(start.chunked, true);
      assert.equal(start.priority, "background");
    }
    await session.cancel();
    await scheduler.shutdown();
  });

  it("defaults effort to 4 and distance to 1.0 when none supplied", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts });
    const worker = await waitForWorker(workers);
    const start = worker.messages[0]!;
    if (start.type === "encode_start") {
      assert.equal(start.effort, 4);
      assert.equal(start.distance, 1.0);
      assert.equal(start.quality, null);
    }
    await session.cancel();
    await scheduler.shutdown();
  });

  it("passes quality through and leaves distance null when quality is given", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts, quality: 90 });
    const worker = await waitForWorker(workers);
    const start = worker.messages[0]!;
    if (start.type === "encode_start") {
      assert.equal(start.quality, 90);
      assert.equal(start.distance, null);
    }
    await session.cancel();
    await scheduler.shutdown();
  });

  it("done() resolves with total bytes on encode_done", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts });
    const worker = await waitForWorker(workers);
    worker.emit({ type: "encode_done", sessionId: session.id, totalBytes: 4096 });
    assert.equal(await session.done(), 4096);
    await scheduler.shutdown();
  });

  it("chunks() yields encode_chunk buffers in order", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts });
    const worker = await waitForWorker(workers);
    worker.emit({ type: "encode_chunk", sessionId: session.id, chunk: new ArrayBuffer(10) });
    worker.emit({ type: "encode_chunk", sessionId: session.id, chunk: new ArrayBuffer(20) });
    worker.emit({ type: "encode_done", sessionId: session.id, totalBytes: 30 });
    const sizes: number[] = [];
    for await (const c of session.chunks()) sizes.push(c.byteLength);
    assert.deepEqual(sizes, [10, 20]);
    await scheduler.shutdown();
  });

  it("pushPixels() forwards encode_pixels messages", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts, chunked: true });
    const worker = await waitForWorker(workers);
    await session.pushPixels(new ArrayBuffer(64));
    await session.finish();
    assert.ok(worker.messages.some((m) => m.type === "encode_pixels"));
    assert.ok(worker.messages.some((m) => m.type === "encode_finish"));
    await session.cancel();
    await scheduler.shutdown();
  });
});

describe("EncodeSessionImpl cancel and errors", () => {
  it("cancel() rejects done() with Cancelled", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts });
    await waitForWorker(workers);
    await session.cancel();
    await assert.rejects(session.done(), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "Cancelled");
      return true;
    });
    await scheduler.shutdown();
  });

  it("encode_error normalizes the code", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts });
    const worker = await waitForWorker(workers);
    worker.emit({ type: "encode_error", sessionId: session.id, code: "OutOfMemory", message: "oom" });
    await assert.rejects(session.done(), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "OutOfMemory");
      return true;
    });
    await scheduler.shutdown();
  });

  it("pushPixels() after finish throws ConfigError", async () => {
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts });
    await waitForWorker(workers);
    await session.finish();
    await assert.rejects(session.pushPixels(new ArrayBuffer(8)), (err: unknown) => {
      assert.ok(err instanceof JxlError);
      assert.equal(err.code, "ConfigError");
      return true;
    });
    await session.cancel();
    await scheduler.shutdown();
  });

  it("forwards metric messages to onMetric", async () => {
    const seen: Array<{ name: string; value: number }> = [];
    const { scheduler, workers } = makeScheduler();
    const session = new EncodeSessionImpl(scheduler, { ...baseOpts, onMetric: (m) => seen.push(m) });
    const worker = await waitForWorker(workers);
    worker.emit({ type: "metric", sessionId: session.id, metric: { name: "output_bytes", value: 2048 } });
    await tick();
    assert.equal(seen[0]?.name, "output_bytes");
    await session.cancel();
    await scheduler.shutdown();
  });
});

describe("encodeOptionsToStartMsg mapper exhaustiveness", () => {
  // These EncodeOptions keys are intentionally NOT forwarded to MsgEncodeStart:
  // they are session-level (signal, onMetric) or encode-handler-side controls
  // (modular, brotliEffort, decodingSpeed, photonNoiseIso, buffering,
  //  advancedControls, jpegReconstruction) that are not part of the wire protocol.
  // Only session-level / caller-side fields are omitted from the wire (K6#2: the
  // advanced codec fields are now forwarded).
  const INTENTIONALLY_OMITTED: ReadonlySet<keyof EncodeOptions> = new Set([
    "signal",
    "onMetric",
  ] as const satisfies (keyof EncodeOptions)[]);

  // All EncodeOptions keys that ARE forwarded (must appear as keys in the
  // returned MsgEncodeStart, keyed by their EncodeOptions name).
  // distance/quality are derived by the caller so they map via the extra params.
  const MAPPED_OPT_KEYS: ReadonlySet<keyof EncodeOptions> = new Set([
    "format",
    "width",
    "height",
    "hasAlpha",
    "iccProfile",
    "exif",
    "xmp",
    "distance",
    "quality",
    "effort",
    "progressive",
    "progressiveFlavor",
    "previewFirst",
    "progressiveDc",
    "progressiveAc",
    "qProgressiveAc",
    "groupOrder",
    "chunked",
    "sidecarSizes",
    "priority",
    "orientation",
    "centerX",
    "centerY",
    "intrinsicSize",
    "disablePerceptualHeuristics",
    "codestreamLevel",
    // Advanced codec fields (K6#2) — forwarded on the wire.
    "modular",
    "brotliEffort",
    "decodingSpeed",
    "photonNoiseIso",
    "buffering",
    "advancedControls",
    "jpegReconstruction",
    "alreadyDownsampled",
    "upsamplingMode",
    "ecResampling",
    "frameIndexing",
    "allowExpertOptions",
  ] as const satisfies (keyof EncodeOptions)[]);

  // Compile-time exhaustive key set: TypeScript ERRORS here if a field is added to
  // EncodeOptions and not listed, forcing MAPPED/OMITTED to be updated — the real
  // drift guard (the `satisfies` on the sets above only checks listed keys valid,
  // not that ALL keys are listed).
  const ALL_ENCODE_OPTION_KEYS: Record<keyof EncodeOptions, true> = {
    format: true, width: true, height: true, hasAlpha: true,
    iccProfile: true, exif: true, xmp: true,
    distance: true, quality: true, effort: true,
    modular: true, brotliEffort: true, decodingSpeed: true, photonNoiseIso: true,
    progressive: true, progressiveFlavor: true, previewFirst: true,
    progressiveDc: true, progressiveAc: true, qProgressiveAc: true, groupOrder: true,
    centerX: true, centerY: true, buffering: true, advancedControls: true,
    chunked: true, sidecarSizes: true, priority: true, signal: true, onMetric: true,
    orientation: true, intrinsicSize: true, disablePerceptualHeuristics: true,
    codestreamLevel: true, jpegReconstruction: true, alreadyDownsampled: true,
    upsamplingMode: true, ecResampling: true, frameIndexing: true, allowExpertOptions: true,
  };

  it("MAPPED + OMITTED covers every EncodeOptions key (drift guard)", () => {
    // Every EncodeOptions key must be classified as either mapped or omitted.
    for (const k of Object.keys(ALL_ENCODE_OPTION_KEYS) as (keyof EncodeOptions)[]) {
      assert.ok(
        MAPPED_OPT_KEYS.has(k) || INTENTIONALLY_OMITTED.has(k),
        `EncodeOptions key "${k}" is neither mapped nor intentionally omitted`
      );
    }
    // Build a full EncodeOptions object with every field set so TypeScript
    // exhaustiveness catches new keys at compile time via the satisfies below.
    const allKeys: (keyof EncodeOptions)[] = [
      ...MAPPED_OPT_KEYS,
      ...INTENTIONALLY_OMITTED,
    ];
    // Detect if a new key was added to EncodeOptions but not listed above.
    // We verify by creating a minimal EncodeOptions and checking via the type:
    // if the union of both sets equals the full keyset, nothing drifts.
    // Runtime check: no key appears in both sets.
    for (const k of MAPPED_OPT_KEYS) {
      assert.ok(!INTENTIONALLY_OMITTED.has(k), `Key "${k}" appears in both MAPPED and OMITTED sets`);
    }
    // Verify the mapper returns an object with all mapped fields populated
    // (uses distance=1.0 / quality=null as the resolved defaults).
    const opts: EncodeOptions = {
      format: "rgba8",
      width: 4,
      height: 4,
      hasAlpha: false,
      effort: 3,
      distance: 1.5,
      progressive: true,
      progressiveFlavor: "dc",
      previewFirst: false,
      progressiveDc: 1,
      progressiveAc: 1,
      qProgressiveAc: 0,
      groupOrder: 1,
      chunked: false,
      sidecarSizes: [64],
      priority: "visible",
      orientation: 1,
      centerX: -1,
      centerY: -1,
      intrinsicSize: { width: 4, height: 4 },
      disablePerceptualHeuristics: true,
      codestreamLevel: 5,
      // Advanced fields (K6#2) with distinct sentinels — incl. an explicit `false`
      // to confirm boolean falses are forwarded (`!= null`), not dropped.
      modular: 1,
      brotliEffort: 7,
      decodingSpeed: 2,
      photonNoiseIso: 400,
      buffering: { strategy: 3 },
      advancedControls: { filters: { epf: 2 } },
      jpegReconstruction: { cfl: true },
      alreadyDownsampled: false,
      upsamplingMode: 0,
      ecResampling: 2,
      frameIndexing: "1",
      allowExpertOptions: true,
    };
    const msg = encodeOptionsToStartMsg("test-id", opts, opts.distance ?? null, null);
    assert.equal(msg.type, "encode_start");
    assert.equal(msg.sessionId, "test-id");
    assert.equal(msg.format, "rgba8");
    assert.equal(msg.effort, 3);
    assert.equal(msg.distance, 1.5);
    assert.equal(msg.progressive, true);
    assert.equal(msg.progressiveDc, 1);
    assert.equal(msg.sidecarSizes?.[0], 64);
    assert.equal(msg.codestreamLevel, 5);
    // Advanced fields forwarded (the K6#2 gap).
    assert.equal(msg.modular, 1);
    assert.equal(msg.brotliEffort, 7);
    assert.equal(msg.decodingSpeed, 2);
    assert.equal(msg.photonNoiseIso, 400);
    assert.deepEqual(msg.buffering, { strategy: 3 });
    assert.deepEqual(msg.advancedControls, { filters: { epf: 2 } });
    assert.deepEqual(msg.jpegReconstruction, { cfl: true });
    assert.equal(msg.alreadyDownsampled, false); // explicit false survives
    assert.equal(msg.upsamplingMode, 0);
    assert.equal(msg.ecResampling, 2);
    assert.equal(msg.frameIndexing, "1");
    assert.equal(msg.allowExpertOptions, true);
    // Confirm the combined key list has no duplicates.
    const seen = new Set<string>();
    for (const k of allKeys) {
      assert.ok(!seen.has(k), `Duplicate key "${k}" in exhaustiveness lists`);
      seen.add(k);
    }
  });
});
