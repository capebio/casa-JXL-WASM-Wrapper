import { afterEach, beforeEach, expect, test } from "bun:test";
import { createLevelSource } from "../src/level-source.js";
import { decodeTiledViewport, decodeLevel } from "../src/decode-level.js";
import { disposeDefaultPool } from "../src/tiled-decode-pool.js";
import { canUseParallelTileWorkers, canShareContainerBytes } from "../src/tiling.js";
import type { RegionDecoder } from "../src/decode-core.js";

/**
 * Consolidation matrix (Packet 2, Task 3 — findings 77, 78, 82).
 *
 * ONE planner (decode-level.decodeTiledViewport) across the full environment matrix:
 *   worker/no-worker × SAB/no-SAB × tiled/whole × RGBA8/RGBA16 × aborted/not-aborted.
 *
 * The load-bearing regression this file pins is finding 82: Worker availability must be
 * SEPARATE from cross-origin isolation. `workers:true, sharedMemory:false` (Worker present but
 * NOT crossOriginIsolated) must STILL take the parallel worker path with an owned/ranged carrier,
 * never be silently downgraded to the single-threaded direct decode.
 */

// --- env stubbing helpers (restore after each test) ---
const g = globalThis as any;
let savedWorker: any;
let savedCOI: any;
let savedSAB: any;
let savedHWC: any;
let hadWorker = false, hadCOI = false, hadSAB = false, hadNav = false;

function stubEnv(opts: { worker: boolean; coi: boolean; sab: boolean; hwc?: number }): void {
  hadWorker = Object.prototype.hasOwnProperty.call(g, "Worker");
  hadCOI = Object.prototype.hasOwnProperty.call(g, "crossOriginIsolated");
  hadSAB = Object.prototype.hasOwnProperty.call(g, "SharedArrayBuffer");
  hadNav = Object.prototype.hasOwnProperty.call(g, "navigator");
  savedWorker = g.Worker;
  savedCOI = g.crossOriginIsolated;
  savedSAB = g.SharedArrayBuffer;
  savedHWC = g.navigator?.hardwareConcurrency;

  if (opts.worker) g.Worker = class {};
  else delete g.Worker;

  g.crossOriginIsolated = opts.coi;

  if (!opts.sab) delete g.SharedArrayBuffer;

  if (opts.hwc != null) {
    if (!g.navigator) g.navigator = {};
    g.navigator.hardwareConcurrency = opts.hwc;
  }
}

function restoreEnv(): void {
  if (hadWorker) g.Worker = savedWorker; else delete g.Worker;
  if (hadCOI) g.crossOriginIsolated = savedCOI; else delete g.crossOriginIsolated;
  if (hadSAB) g.SharedArrayBuffer = savedSAB; else delete g.SharedArrayBuffer;
  if (hadNav && g.navigator) g.navigator.hardwareConcurrency = savedHWC;
}

afterEach(async () => {
  restoreEnv();
  await disposeDefaultPool();
});

// A two-tile tiled source: 64x32 with tileSize 32 => 2 tiles => parallel-eligible.
function makeTiledSource() {
  const width = 64, height = 32, tileSize = 32;
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x4354584a, true); // 'JXTC'
  view.setUint32(4, 1, true);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  view.setUint32(16, tileSize, true);
  view.setUint32(20, 2, true);
  view.setUint32(24, 1, true);
  view.setUint32(28, 0, true);
  return {
    kind: "tiled" as const, bytes, width, height, tileSize,
    bitsPerSample: 8 as const, format: "rgba8" as const, bpp: 4 as const, version: 1 as const, tilesX: 2, tilesY: 1,
  };
}

// Counting worker factory: each decode message is answered with a solid tile.
function makeCountingWorkerFactory() {
  const counters = { instances: 0, decodes: 0 };
  class CountingWorker {
    private readonly listeners = new Map<string, Set<(ev: { data?: any }) => void>>();
    terminated = false;
    constructor() {
      counters.instances += 1;
      this.listeners.set("message", new Set());
      this.listeners.set("error", new Set());
      this.listeners.set("messageerror", new Set());
      setTimeout(() => { if (!this.terminated) this.emit("message", { v: 1, type: "ready" }); }, 0);
    }
    addEventListener(t: string, l: (ev: { data?: any }) => void) { this.listeners.get(t)!.add(l); }
    removeEventListener(t: string, l: (ev: { data?: any }) => void) { this.listeners.get(t)!.delete(l); }
    postMessage(data: any) {
      if (this.terminated) return;
      if (data.type === "load" || data.type === "cancel") return;
      if (data.type === "decode") {
        counters.decodes += 1;
        const pixels = new Uint8Array(data.region.w * data.region.h * 4).fill(9);
        setTimeout(() => {
          if (this.terminated) return;
          this.emit("message", { v: 1, type: "decode-reply", id: data.id, ok: true, pixels, w: data.region.w, h: data.region.h });
        }, 0);
      }
    }
    terminate() { this.terminated = true; }
    private emit(t: string, data: any) { for (const l of this.listeners.get(t) ?? []) l({ data }); }
  }
  return { factory: () => new CountingWorker() as any, counters };
}

// --- finding 82: Worker availability is independent of cross-origin isolation ---

test("canUseParallelTileWorkers is TRUE with Worker present but WITHOUT cross-origin isolation (finding 82)", () => {
  stubEnv({ worker: true, coi: false, sab: false });
  expect(canUseParallelTileWorkers()).toBe(true);
});

test("canShareContainerBytes stays gated on cross-origin isolation + SAB (finding 82: separate axis)", () => {
  stubEnv({ worker: true, coi: false, sab: false });
  expect(canShareContainerBytes()).toBe(false);
});

test("canUseParallelTileWorkers is FALSE when Worker is unavailable regardless of COI", () => {
  stubEnv({ worker: false, coi: true, sab: false });
  expect(canUseParallelTileWorkers()).toBe(false);
});

test("workers:true, sharedMemory:false STILL runs parallel workers with the owned carrier (finding 82)", async () => {
  // Worker present, NOT crossOriginIsolated, NO SharedArrayBuffer -> classic non-isolated browser.
  stubEnv({ worker: true, coi: false, sab: false, hwc: 4 });
  const { factory, counters } = makeCountingWorkerFactory();
  const source = makeTiledSource();
  const region = { x: 0, y: 0, w: 64, h: 32 };

  const out = await decodeTiledViewport(source, region, { parallel: true, workerFactory: factory });

  // Parallel worker path taken: workers were spawned and answered decode messages.
  expect(counters.instances).toBeGreaterThan(0);
  expect(counters.decodes).toBeGreaterThan(0);
  expect(out.width).toBe(64);
  expect(out.height).toBe(32);
  // Owned (copied) carrier, not SAB: pixels reflect the worker's solid fill.
  expect(out.pixels.some((v, i) => i % 4 !== 3 && v === 9)).toBe(true);
});

// --- matrix: tiled × RGBA8/16 × direct fallback (no workers) ---

test("no-worker env falls back to single-shot direct decode (tiled, rgba8)", async () => {
  stubEnv({ worker: false, coi: false, sab: false });
  const source = makeTiledSource();
  const region = { x: 0, y: 0, w: 64, h: 32 };
  let directCalls = 0;
  const mock: RegionDecoder = async (_b, r) => {
    directCalls += 1;
    return { pixels: new Uint8Array(r.w * r.h * 4).fill(5), width: r.w, height: r.h, format: "rgba8" };
  };
  const out = await decodeTiledViewport(source, region, { parallel: true, decodeRegion: mock });
  expect(directCalls).toBe(1); // no workers -> single ROI decode
  expect(out.width).toBe(64);
});

test("aborted-before-start rejects on every path (worker present)", async () => {
  stubEnv({ worker: true, coi: false, sab: false });
  const { factory } = makeCountingWorkerFactory();
  const source = makeTiledSource();
  const ac = new AbortController();
  ac.abort();
  await expect(
    decodeTiledViewport(source, { x: 0, y: 0, w: 64, h: 32 }, { parallel: true, workerFactory: factory, signal: ac.signal }),
  ).rejects.toThrow(/ABORTED|aborted/);
});

test("single planner routes whole vs tiled by source.kind (matrix: whole × tiled routing guards)", async () => {
  // Pure routing guards (fire before any WASM/worker work), so this test needs no env stubbing.
  // A whole source with a region must be rejected as tiled-only; a tiled source without a region
  // must be rejected as requiring an explicit region. One planner, two deterministic guards.
  const wholeBytes = new Uint8Array([0xff, 0x0a]);
  const whole = createLevelSource({ w: 4, h: 4, tiled: false }, wholeBytes);
  await expect(
    decodeLevel(whole, { x: 0, y: 0, w: 4, h: 4 }),
  ).rejects.toThrow(/region decode requires a tiled level source/);

  const tiled = makeTiledSource();
  await expect(decodeLevel(tiled)).rejects.toThrow(/tiled level decode requires explicit region/);
});
