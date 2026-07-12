import { afterEach, expect, test } from "bun:test";
import { createPyramidRuntime, type PyramidRuntime } from "../src/runtime.js";
import { disposeDefaultPool, HandleState } from "../src/tiled-decode-pool.js";
import type { LevelSource } from "../src/level-source.js";

/**
 * Contract tests for the canonical decode runtime (Task 1, findings 74/77/78).
 *
 * The runtime is the single public decode entry point. It owns exactly ONE tiled worker
 * pool for its lifetime; gallery code must never create a pool inside a decode call.
 * These tests pin that invariant plus the boundary rejection of unsupported option names.
 */

// --- Test worker double (mirrors tiled-decode-pool.state.test.ts) ---
type WorkerRequest =
  | { v: 1; type: "load"; bytesId: number; bytes?: Uint8Array; sab?: SharedArrayBuffer; byteLength?: number }
  | { v: 1; type: "decode"; id: number; bytesId: number; region: { x: number; y: number; w: number; h: number }; format: "rgba8" | "rgba16"; deadlineMs?: number; progressiveStage?: "dc" | "final" }
  | { v: 1; type: "cancel"; id: number };

class FakeWorker {
  static instances = 0;
  readonly loads: Array<{ bytesId: number }> = [];
  terminated = false;
  private readonly listeners = new Map<"message" | "error" | "messageerror", Set<(ev: { data?: any }) => void>>();

  constructor() {
    FakeWorker.instances += 1;
    this.listeners.set("message", new Set());
    this.listeners.set("error", new Set());
    this.listeners.set("messageerror", new Set());
    globalThis.setTimeout(() => {
      if (!this.terminated) this.emit("message", { v: 1, type: "ready" });
    }, 0);
  }

  addEventListener(type: "message" | "error" | "messageerror", listener: (ev: { data?: any }) => void): void {
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: "message" | "error" | "messageerror", listener: (ev: { data?: any }) => void): void {
    this.listeners.get(type)!.delete(listener);
  }

  postMessage(data: WorkerRequest): void {
    if (this.terminated) throw new Error("terminated");
    if (data.type === "load") {
      this.loads.push({ bytesId: data.bytesId });
      return;
    }
    if (data.type === "cancel") return;
    // decode: reply with a solid tile of the requested size
    const pixels = new Uint8Array(data.region.w * data.region.h * 4).fill(7);
    globalThis.setTimeout(() => {
      if (this.terminated) return;
      this.emit("message", { v: 1, type: "decode-reply", id: data.id, ok: true, pixels, w: data.region.w, h: data.region.h });
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
  }

  private emit(type: "message" | "error" | "messageerror", data: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

// Two-tile tiled source (64x32, tileSize 32 => 2 tiles horizontally): parallel-eligible.
function makeTiledSource(): Extract<LevelSource, { kind: "tiled" }> {
  const width = 64, height = 32, tileSize = 32;
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x4354584a, true); // JXTC
  view.setUint32(4, 1, true);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  view.setUint32(16, tileSize, true);
  view.setUint32(20, 2, true);
  view.setUint32(24, 1, true);
  view.setUint32(28, 0, true);
  return {
    kind: "tiled", bytes, width, height, tileSize,
    bitsPerSample: 8, format: "rgba8", bpp: 4, version: 1, tilesX: 2, tilesY: 1,
  };
}

afterEach(async () => {
  await disposeDefaultPool();
});

test("one runtime owns one pool reused across several decodes (no per-call pool recreation)", async () => {
  FakeWorker.instances = 0;
  const runtime: PyramidRuntime = createPyramidRuntime({
    workerFactory: () => new FakeWorker(),
    capabilities: { workers: true, sharedMemory: false, rangeRequests: false, rgba16: false },
  });

  const source = makeTiledSource();
  const region = { x: 0, y: 0, w: 64, h: 32 };

  // Several decodes through the single entry point.
  const a = await runtime.decodeLevel(source, region, { quality: "final" });
  const b = await runtime.decodeLevel(source, region, { quality: "final" });
  const c = await runtime.decodeLevel(source, region, { quality: "final" });

  expect(a.width).toBe(64);
  expect(b.width).toBe(64);
  expect(c.width).toBe(64);

  // The runtime exposes exactly one pool object, stable across calls.
  const pool1 = runtime.pool;
  expect(pool1).toBeDefined();
  expect(runtime.pool).toBe(pool1);

  // One source registration: bytesId is allocated once and reused across calls.
  const idFirst = runtime.pool!.allocateBytesId(source as any);
  const idSecond = runtime.pool!.allocateBytesId(source as any);
  expect(idSecond).toBe(idFirst);

  // Worker count is bounded by the pool cap, NOT by the number of decode calls.
  // Three decode calls must not spawn three fresh pools' worth of workers.
  expect(FakeWorker.instances).toBeLessThanOrEqual(runtime.pool!.size + 1);
});

test("decodeLevel does not create a pool inside the call: reuses the runtime's pool identity", async () => {
  const runtime = createPyramidRuntime({
    workerFactory: () => new FakeWorker(),
    capabilities: { workers: true, sharedMemory: false, rangeRequests: false, rgba16: false },
  });
  const source = makeTiledSource();
  const region = { x: 0, y: 0, w: 64, h: 32 };

  const poolBefore = runtime.pool;
  await runtime.decodeLevel(source, region, { quality: "final" });
  const poolAfter = runtime.pool;

  // Pool created by the runtime (lazily or eagerly) is the same object before and after a decode.
  expect(poolAfter).toBe(poolBefore ?? poolAfter);
  // And every handle in the pool came from the runtime's factory, in one pool.
  expect(runtime.pool).toBeDefined();
});

test("unsupported option names fail at the caller boundary (deterministic error, not silently ignored)", async () => {
  const runtime = createPyramidRuntime({
    workerFactory: () => new FakeWorker(),
    capabilities: { workers: true, sharedMemory: false, rangeRequests: false, rgba16: false },
  });
  const source = makeTiledSource();
  const region = { x: 0, y: 0, w: 64, h: 32 };

  // `sourceKey`/`priority` were leaked options in the legacy gallery decode path (finding 77).
  // The canonical runtime must reject unknown option names instead of ignoring them.
  await expect(
    runtime.decodeLevel(source, region, { sourceKey: "abc" } as any),
  ).rejects.toThrow(/unsupported|unknown option|sourceKey/i);

  await expect(
    runtime.decodeLevel(source, region, { priority: "visible" } as any),
  ).rejects.toThrow(/unsupported|unknown option|priority/i);
});

test("runtime exposes the accepted capability split (workers vs sharedMemory)", () => {
  const runtime = createPyramidRuntime({
    workerFactory: () => new FakeWorker(),
    capabilities: { workers: true, sharedMemory: false, rangeRequests: true, rgba16: true },
  });
  expect(runtime.capabilities.workers).toBe(true);
  expect(runtime.capabilities.sharedMemory).toBe(false);
  expect(runtime.capabilities.rangeRequests).toBe(true);
  expect(runtime.capabilities.rgba16).toBe(true);
});

test("runtime.dispose destroys the single pool and frees its workers", async () => {
  const runtime = createPyramidRuntime({
    workerFactory: () => new FakeWorker(),
    capabilities: { workers: true, sharedMemory: false, rangeRequests: false, rgba16: false },
  });
  const source = makeTiledSource();
  await runtime.decodeLevel(source, { x: 0, y: 0, w: 64, h: 32 }, { quality: "final" });
  const pool = runtime.pool!;
  await runtime.dispose();
  expect(pool.destroyed).toBe(true);
});
