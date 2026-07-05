import { describe, test } from "node:test";
import type { MsgDecodeStart, MsgEncodeStart, WorkerToMainMessage } from "@casabio/jxl-core/protocol";
import { DecodeHandler } from "../src/decode-handler.js";
import { EncodeHandler } from "../src/encode-handler.js";
import type { Backend } from "../src/backend-selector.js";
import { expect } from "./expect.js";

const baseDecodeStart: MsgDecodeStart = {
  type: "decode_start",
  sessionId: "decode-node-1",
  format: "rgba8",
  region: null,
  downsample: 1,
  progressionTarget: "final",
  emitEveryPass: true,
  suppressDuplicateProgress: false,
  preserveIcc: true,
  preserveMetadata: true,
  priority: "visible",
  budgetMs: null,
  progressiveDetail: null,
  targetWidth: null,
  targetHeight: null,
  fitMode: null,
};

const baseEncodeStart: MsgEncodeStart = {
  type: "encode_start",
  sessionId: "encode-node-1",
  format: "rgba8",
  width: 1,
  height: 1,
  hasAlpha: true,
  iccProfile: null,
  exif: null,
  xmp: null,
  distance: null,
  quality: 90,
  effort: 7,
  progressive: false,
  previewFirst: false,
  chunked: false,
  priority: "visible",
};

describe("node codec handlers", () => {
  test("decode handler forwards native codec events and emits Buffer pixels", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    const backend: Backend = {
      type: "native",
      module: {
        createDecoder() {
          return {
            push() {},
            close() {},
            cancel() {},
            dispose() {},
            async *events() {
              yield {
                type: "header",
                info: {
                  width: 1,
                  height: 1,
                  bitsPerSample: 8,
                  hasAlpha: true,
                  hasAnimation: false,
                  jpegReconstructionAvailable: false,
                },
              };
              yield {
                type: "final",
                info: {
                  width: 1,
                  height: 1,
                  bitsPerSample: 8,
                  hasAlpha: true,
                  hasAnimation: false,
                  jpegReconstructionAvailable: false,
                },
                pixels: new Uint8Array([1, 2, 3, 4]),
                format: "rgba8",
                pixelStride: 4,
              };
            },
          };
        },
        createEncoder() {
          return {
            pushPixels() {},
            finish() {},
            cancel() {},
            dispose() {},
            async *chunks() {},
          };
        },
      },
    };

    const handler = new DecodeHandler(baseDecodeStart, backend, {
      port: fakePort(messages),
      onSessionEnd: (sessionId) => ended.push(sessionId),
    });
    handler.onChunk(Buffer.from([0xff]));
    handler.onClose();

    await waitFor(() => ended.length === 1);

    expect(messages.filter((msg) => msg.type.startsWith("decode_")).map((msg) => msg.type)).toEqual([
      "decode_header",
      "decode_final",
    ]);
    const final = messages.find((msg) => msg.type === "decode_final");
    expect(Buffer.isBuffer(final && "pixels" in final ? final.pixels : null)).toBe(true);
  });

  test("encode handler streams native codec Buffer chunks and done", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    const backend: Backend = {
      type: "native",
      module: {
        createEncoder() {
          return {
            pushPixels() {},
            finish() {},
            cancel() {},
            dispose() {},
            async *chunks() {
              yield Buffer.from([0, 1, 2]);
              yield new Uint8Array([3, 4]);
            },
          };
        },
        createDecoder() {
          return {
            push() {},
            close() {},
            cancel() {},
            dispose() {},
            async *events() {},
          };
        },
      },
    };

    const handler = new EncodeHandler(baseEncodeStart, backend, {
      port: fakePort(messages),
      onSessionEnd: (sessionId) => ended.push(sessionId),
    });
    handler.onPixels(Buffer.from([255, 0, 0, 255]));
    handler.onFinish();

    await waitFor(() => ended.length === 1);

    expect(messages.filter((msg) => msg.type.startsWith("encode_")).map((msg) => msg.type)).toEqual([
      "encode_first_byte_ready",
      "encode_chunk",
      "encode_chunk",
      "encode_done",
    ]);
    expect(messages.filter((msg) => msg.type.startsWith("encode_")).at(-1)).toEqual({ type: "encode_done", sessionId: "encode-node-1", totalBytes: 5 });
  });

  test("encode handler suppresses release_state cancellation message", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    const backend: Backend = {
      type: "native",
      module: {
        createEncoder() {
          return {
            pushPixels() {},
            finish() {},
            cancel() {},
            dispose() {},
            async *chunks() {
              await new Promise(() => undefined);
            },
          };
        },
        createDecoder() {
          return {
            push() {},
            close() {},
            cancel() {},
            dispose() {},
            async *events() {},
          };
        },
      },
    };

    const handler = new EncodeHandler(
      { ...baseEncodeStart, sessionId: "encode-node-release-state" },
      backend,
      {
        port: fakePort(messages),
        onSessionEnd: (sessionId) => ended.push(sessionId),
      },
    );

    await handler.onCancel("release_state");

    expect(messages.some((msg) => msg.type === "encode_cancelled")).toBe(false);
    expect(ended).toEqual(["encode-node-release-state"]);
  });

  test("decode handler suppresses release_state cancellation message", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    const backend: Backend = {
      type: "native",
      module: {
        createDecoder() {
          return {
            push() {},
            close() {},
            cancel() {},
            dispose() {},
            async *events() {
              await new Promise(() => undefined);
            },
          };
        },
        createEncoder() {
          return {
            pushPixels() {},
            finish() {},
            cancel() {},
            dispose() {},
            async *chunks() {},
          };
        },
      },
    };

    const handler = new DecodeHandler(
      { ...baseDecodeStart, sessionId: "decode-node-release-state" },
      backend,
      {
        port: fakePort(messages),
        onSessionEnd: (sessionId) => ended.push(sessionId),
      },
    );

    await handler.onCancel("release_state");

    expect(messages.some((msg) => msg.type === "decode_cancelled")).toBe(false);
    expect(ended).toEqual(["decode-node-release-state"]);
  });

  test("encode handler emits correct telemetry metrics", async () => {
    const messages: WorkerToMainMessage[] = [];
    const ended: string[] = [];
    const backend: Backend = {
      type: "native",
      module: {
        createEncoder() {
          return {
            pushPixels() {},
            finish() {},
            cancel() {},
            dispose() {},
            async *chunks() {
              yield Buffer.from([1, 2, 3]);
            },
          };
        },
        createDecoder() {
          return {
            push() {},
            close() {},
            cancel() {},
            dispose() {},
            async *events() {},
          };
        },
      },
    };

    const handler = new EncodeHandler(baseEncodeStart, backend, {
      port: fakePort(messages),
      onSessionEnd: (sessionId) => ended.push(sessionId),
    });
    handler.onPixels(Buffer.from([0, 0, 0, 0]));
    handler.onFinish();

    await waitFor(() => ended.length === 1);

    const metrics = messages.filter((msg) => msg.type === "metric") as Array<{ type: "metric"; metric: { name: string; value: number } }>;
    expect(metrics.length).toBe(4);

    const firstByteMetric = metrics.find((m) => m.metric.name === "time_to_first_byte_ms");
    expect(firstByteMetric).toBeDefined();
    expect(firstByteMetric!.metric.value >= 0).toBe(true);

    const outputBytesMetric = metrics.find((m) => m.metric.name === "output_bytes");
    expect(outputBytesMetric).toBeDefined();
    expect(outputBytesMetric!.metric.value).toBe(3);

    const totalTimeMetric = metrics.find((m) => m.metric.name === "encode_total_ms");
    expect(totalTimeMetric).toBeDefined();
    expect(totalTimeMetric!.metric.value >= 0).toBe(true);

    const finishMetric = metrics.find((m) => m.metric.name === "encode_finish_ms");
    expect(finishMetric).toBeDefined();
    expect(finishMetric!.metric.value >= 0).toBe(true);
  });
});

function fakePort(messages: WorkerToMainMessage[]) {
  return {
    postMessage(message: WorkerToMainMessage) {
      messages.push(message);
    },
  } as never;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 500) {
      throw new Error("timed out waiting for handler");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
