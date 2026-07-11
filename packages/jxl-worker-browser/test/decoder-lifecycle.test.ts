import { describe, test } from "node:test";
import type { MsgDecodeStart } from "@casabio/jxl-core/protocol";
import { DecodeHandler } from "../src/decode-handler.js";
import { expect } from "./expect.js";

const baseDecodeStart: MsgDecodeStart = {
  type: "decode_start",
  sessionId: "decode-1",
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

const info = {
  width: 1,
  height: 1,
  bitsPerSample: 8 as const,
  hasAlpha: true,
  hasAnimation: false,
  jpegReconstructionAvailable: false,
};

// A JxlModule whose decoders track create/dispose counts so a test can prove a
// decoder is not retained (pooled) after its session ends.
function trackingModule() {
  const created: Array<{ disposed: number }> = [];
  const codec = {
    createDecoder() {
      const rec = { disposed: 0 };
      created.push(rec);
      const pixels = new Uint8Array([1, 2, 3, 4]).buffer;
      return {
        push() {},
        close() {},
        cancel() {},
        dispose() {
          rec.disposed++;
        },
        async *events() {
          yield { type: "header", info };
          yield { type: "final", info, pixels, format: "rgba8", pixelStride: 4 };
        },
      };
    },
    createEncoder() {
      throw new Error("not used");
    },
  };
  return { codec, created };
}

function installNoopPostMessage(): void {
  (globalThis as any).self = { postMessage() {} };
}

async function runOneSession(codec: unknown, sessionId: string): Promise<void> {
  const ended: string[] = [];
  const handler = new DecodeHandler(
    { ...baseDecodeStart, sessionId },
    codec as never,
    { onSessionEnd: (id) => ended.push(id) },
  );
  handler.onChunk(new Uint8Array([0xff]).buffer);
  handler.onClose();
  const deadline = Date.now() + 2000;
  while (ended.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(ended).toEqual([sessionId]);
}

describe("decoder lifetime (finding 31 — no unused pool retention)", () => {
  test("each decode session disposes its decoder — none is retained for reuse", async () => {
    installNoopPostMessage();
    const { codec, created } = trackingModule();

    await runOneSession(codec, "decode-a");

    expect(created).toHaveLength(1);
    expect(created[0]!.disposed).toBe(1);
  });

  test("a second session constructs a fresh decoder (stateless between sessions)", async () => {
    installNoopPostMessage();
    const { codec, created } = trackingModule();

    await runOneSession(codec, "decode-a");
    await runOneSession(codec, "decode-b");

    // Two sessions → two distinct decoders, each disposed. No cross-session reuse.
    expect(created).toHaveLength(2);
    expect(created[0]!.disposed).toBe(1);
    expect(created[1]!.disposed).toBe(1);
  });

  test("DecodeHandler no longer accepts a decoderPool callback (pool removed)", () => {
    const src = readDecodeHandlerSource();
    expect(src.includes("decoderPool")).toBe(false);
    expect(src.includes("decoder-pool")).toBe(false);
  });
});

import { readFileSync } from "node:fs";
// Resolved relative to the COMPILED location (dist-test/test/) under the canonical
// `tsc -p tsconfig.test.json && node --test dist-test/test/*.js` runner — two levels
// up reaches the package root, matching worker-source.test.ts.
function readDecodeHandlerSource(): string {
  return readFileSync(new URL("../../src/decode-handler.ts", import.meta.url), "utf8");
}
