import { afterEach, expect, test, describe } from "bun:test";
import { __testing, disposeDefaultPool, PyramidWorkerPool } from "../src/tiled-decode-pool.js";
import { selectCarrier, OWNED_WHOLE_MAX_BYTES } from "../src/tiled-decode-pool.js";
import type { LevelSource } from "../src/level-source.js";
import { JXTC_MAGIC } from "../src/tiling.js";

// ---------------------------------------------------------------------------
// Fixtures: a real JXTC container so extractTileBitstream returns real ranges.
// Layout: 32B header, then numTiles*8 (offset u32, length u32), then tile data.
// ---------------------------------------------------------------------------

interface BuiltContainer {
  bytes: Uint8Array;
  width: number;
  height: number;
  tileSize: number;
  tilesX: number;
  tilesY: number;
  /** per-tile payload byte length */
  tilePayload: number;
}

function buildJxtc(opts: {
  width?: number;
  height?: number;
  tileSize?: number;
  tilePayload?: number;
  bitsPerSample?: 8 | 16;
} = {}): BuiltContainer {
  const width = opts.width ?? 128;
  const height = opts.height ?? 64;
  const tileSize = opts.tileSize ?? 32;
  const tilePayload = opts.tilePayload ?? 256;
  const bitsPerSample = opts.bitsPerSample ?? 8;
  const tilesX = Math.ceil(width / tileSize);
  const tilesY = Math.ceil(height / tileSize);
  const numTiles = tilesX * tilesY;
  const dataBase = 32 + numTiles * 8;
  const total = dataBase + numTiles * tilePayload;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, JXTC_MAGIC, true);
  view.setUint32(4, 1, true); // version
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  view.setUint32(16, tileSize, true);
  view.setUint32(20, tilesX, true);
  view.setUint32(24, tilesY, true);
  view.setUint32(28, bitsPerSample === 16 ? 2 : 0, true); // flags
  let cursor = dataBase;
  for (let i = 0; i < numTiles; i++) {
    view.setUint32(32 + i * 8, cursor, true);
    view.setUint32(32 + i * 8 + 4, tilePayload, true);
    // fill tile payload with a per-tile signature so we can verify range identity
    for (let b = 0; b < tilePayload; b++) bytes[cursor + b] = (i * 7 + b) & 0xff;
    cursor += tilePayload;
  }
  return { bytes, width, height, tileSize, tilesX, tilesY, tilePayload };
}

function tiledSource(c: BuiltContainer): Extract<LevelSource, { kind: "tiled" }> {
  return {
    kind: "tiled",
    bytes: c.bytes,
    width: c.width,
    height: c.height,
    tileSize: c.tileSize,
    bitsPerSample: 8,
    format: "rgba8",
    bpp: 4,
    version: 1,
    level: 0,
    tilesX: c.tilesX,
    tilesY: c.tilesY,
  };
}

/** Records every postMessage + its transfer list so tests can measure transferred bytes. */
class RecordingWorker {
  readonly messages: Array<{ msg: any; transfer: any[] }> = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(ev: { data?: any }) => void>>();

  constructor() {
    this.listeners.set("message", new Set());
    this.listeners.set("error", new Set());
    this.listeners.set("messageerror", new Set());
    globalThis.setTimeout(() => {
      if (!this.terminated) this.emit("message", { v: 1, type: "ready" });
    }, 0);
  }
  addEventListener(type: string, l: (ev: { data?: any }) => void) {
    this.listeners.get(type)!.add(l);
  }
  removeEventListener(type: string, l: (ev: { data?: any }) => void) {
    this.listeners.get(type)!.delete(l);
  }
  postMessage(msg: any, transfer: any[] = []): void {
    if (this.terminated) throw new Error("terminated");
    this.messages.push({ msg, transfer });
    if (msg.type === "unload") {
      // acknowledge
      globalThis.setTimeout(() => this.emit("message", { v: 1, type: "unload-ack", bytesId: msg.bytesId }), 0);
    }
  }
  terminate() {
    this.terminated = true;
  }
  private emit(type: string, data: any) {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
  loadMessages() {
    return this.messages.filter((m) => m.msg.type === "load").map((m) => m.msg);
  }
  /** Total bytes handed to this worker across all load messages (owned copies only). */
  ownedBytesTransferred(): number {
    let n = 0;
    for (const { msg } of this.messages) {
      if (msg.type !== "load") continue;
      if (msg.sab !== undefined) continue; // shared, not transferred/copied per worker
      if (msg.bytes) n += msg.bytes.byteLength;
      if (Array.isArray(msg.ranges)) {
        for (const r of msg.ranges) n += (r.bytes?.byteLength ?? 0);
      }
    }
    return n;
  }
}

afterEach(async () => {
  await disposeDefaultPool();
});

// ---------------------------------------------------------------------------
// selectCarrier policy (pure function): SAB-view / owned-below-threshold / range
// ---------------------------------------------------------------------------

test("selectCarrier picks shared SAB view when SAB is available (no per-worker copy)", () => {
  const c = buildJxtc({ tilePayload: 4096 });
  const carrier = selectCarrier({ containerBytes: c.bytes, sabAvailable: true, requestedTileRanges: [{ offset: 0, length: 100 }] });
  expect(carrier.kind).toBe("sab-view");
});

test("selectCarrier picks owned-whole below the declared threshold when no SAB", () => {
  const small = new Uint8Array(OWNED_WHOLE_MAX_BYTES - 1);
  const carrier = selectCarrier({ containerBytes: small, sabAvailable: false, requestedTileRanges: [{ offset: 0, length: 100 }] });
  expect(carrier.kind).toBe("owned-whole");
});

test("selectCarrier picks range transport for a large container without SAB", () => {
  const big = new Uint8Array(OWNED_WHOLE_MAX_BYTES + 1);
  const carrier = selectCarrier({
    containerBytes: big,
    sabAvailable: false,
    requestedTileRanges: [{ offset: 100, length: 256 }, { offset: 400, length: 256 }],
  });
  expect(carrier.kind).toBe("range");
});

// ---------------------------------------------------------------------------
// Finding 79: non-SAB fanout must NOT be workers * containerSize
// ---------------------------------------------------------------------------

test("non-SAB large container: total transferred bytes bounded by requested tiles, not workers*containerSize", () => {
  const c = buildJxtc({ width: 256, height: 256, tileSize: 32, tilePayload: 16384 }); // 8x8=64 tiles, container ~1MB
  const containerSize = c.bytes.byteLength;
  expect(containerSize).toBeGreaterThan(OWNED_WHOLE_MAX_BYTES); // ensure range mode

  const workers = [new RecordingWorker(), new RecordingWorker(), new RecordingWorker()];
  const pool = new PyramidWorkerPool({
    factory: () => workers.shift()!,
    maxSize: 3,
    idleTimeoutMs: 0,
    minIdle: 0,
    prewarm: "on-demand",
  });
  const created = [...workers]; // snapshot before shift consumes
  const src = tiledSource(c);
  const bytesId = pool.allocateBytesId(src);

  // Requested tiles: only 2 of the 64.
  const requestedTiles = [
    { x: 0, y: 0, w: 32, h: 32 },
    { x: 32, y: 0, w: 32, h: 32 },
  ];

  // Spawn 3 handles manually (simulate acquire).
  const handles = (pool as any).all ? [...(pool as any).all] : [];
  // Use the public ensureLoadedForTiles range API.
  const usable = spawnHandles(pool, 3);
  pool.ensureLoadedForTiles(usable, bytesId, src, requestedTiles, false /* useSAB */);

  const totalOwned = usable.reduce((sum: number, h: any) => sum + h.worker.ownedBytesTransferred(), 0);
  // Bounded by requested tiles (2 * 4096) * workers-that-need-them + small protocol overhead,
  // NOT workers * containerSize.
  expect(totalOwned).toBeLessThan(workersTimesContainer(usable.length, containerSize));
  // Concretely: each worker only receives the 2 requested tile ranges.
  const perWorkerExpected = requestedTiles.length * c.tilePayload;
  for (const h of usable) {
    expect(h.worker.ownedBytesTransferred()).toBeLessThanOrEqual(perWorkerExpected + 64 /* overhead slack */);
  }
});

function workersTimesContainer(n: number, containerSize: number): number {
  return n * containerSize;
}

function spawnHandles(pool: any, n: number): any[] {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const h = pool.spawnForTest ? pool.spawnForTest() : (pool as any).spawnOne();
    out.push(h);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SAB path: shared immutable view, NO per-worker copy at the protocol layer
// ---------------------------------------------------------------------------

test("SAB carrier posts one shared SAB per worker with no owned bytes transferred", () => {
  const c = buildJxtc({ tilePayload: 4096 });
  const workers = [new RecordingWorker(), new RecordingWorker()];
  const pool = new PyramidWorkerPool({
    factory: () => workers.shift()!,
    maxSize: 2,
    idleTimeoutMs: 0,
    minIdle: 0,
    prewarm: "on-demand",
  });
  const src = tiledSource(c);
  const bytesId = pool.allocateBytesId(src);
  const usable = spawnHandles(pool, 2);
  pool.ensureLoadedForTiles(usable, bytesId, src, [{ x: 0, y: 0, w: 32, h: 32 }], true /* useSAB */);

  const sabs = new Set<SharedArrayBuffer>();
  for (const h of usable) {
    const loads = h.worker.loadMessages();
    expect(loads.length).toBe(1);
    expect(loads[0].sab).toBeInstanceOf(SharedArrayBuffer);
    sabs.add(loads[0].sab);
    expect(h.worker.ownedBytesTransferred()).toBe(0);
  }
  // Same SAB shared across all workers (single allocation, no per-worker copy).
  expect(sabs.size).toBe(1);
});

// ---------------------------------------------------------------------------
// Explicit unload with acknowledgement
// ---------------------------------------------------------------------------

test("unload posts an unload message per loaded worker and resolves on ack", async () => {
  const c = buildJxtc();
  const workers = [new RecordingWorker(), new RecordingWorker()];
  const pool = new PyramidWorkerPool({
    factory: () => workers.shift()!,
    maxSize: 2,
    idleTimeoutMs: 0,
    minIdle: 0,
    prewarm: "on-demand",
  });
  const src = tiledSource(c);
  const bytesId = pool.allocateBytesId(src);
  const usable = spawnHandles(pool, 2);
  pool.ensureLoadedForTiles(usable, bytesId, src, [{ x: 0, y: 0, w: 32, h: 32 }], false);

  await pool.unload(usable, bytesId);

  for (const h of usable) {
    const unloads = h.worker.messages.filter((m: any) => m.msg.type === "unload");
    expect(unloads.length).toBe(1);
    expect(unloads[0].msg.bytesId).toBe(bytesId);
  }
});

// ---------------------------------------------------------------------------
// Repeated source reuse: no re-transfer of ranges already loaded on a worker
// ---------------------------------------------------------------------------

test("repeated ensureLoadedForTiles does not re-transfer ranges already resident on a worker", () => {
  const c = buildJxtc({ width: 256, height: 256, tileSize: 32, tilePayload: 16384 });
  const workers = [new RecordingWorker()];
  const pool = new PyramidWorkerPool({
    factory: () => workers.shift()!,
    maxSize: 1,
    idleTimeoutMs: 0,
    minIdle: 0,
    prewarm: "on-demand",
  });
  const src = tiledSource(c);
  const bytesId = pool.allocateBytesId(src);
  const usable = spawnHandles(pool, 1);
  const tile = { x: 0, y: 0, w: 32, h: 32 };

  pool.ensureLoadedForTiles(usable, bytesId, src, [tile], false);
  const after1 = usable[0].worker.ownedBytesTransferred();
  pool.ensureLoadedForTiles(usable, bytesId, src, [tile], false); // same tile again
  const after2 = usable[0].worker.ownedBytesTransferred();

  expect(after2).toBe(after1); // no re-transfer of the already-resident tile range
});

// ---------------------------------------------------------------------------
// Behavioral tests added per spec checklist-1
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. Budget eviction (LRU): unit-tests createWorkerStore with a tiny budget so
//    we don't need real 256 MiB data.  Directly exercises the same code path
//    the worker uses (worker-store.js is now a shared module).
//
// Key design: loadMessage increments refs so freshly-loaded entries have refs≥1.
// evictToBudget skips entries with refs>0.  Eviction therefore only reclaims
// entries that have been unloaded (refs→0) but whose unloadMessage freed them
// immediately.  The meaningful eviction scenario is when entries are MANUALLY
// marked refs=0 (simulating a worker crash without explicit unload) so the
// next over-budget load can reclaim them LRU-first.
// ---------------------------------------------------------------------------
describe("worker byte-store: budget eviction (LRU)", async () => {
  // Dynamic import because worker-store.js is a plain JS ESM file outside
  // the TypeScript src tree; bun resolves it fine at runtime.
  const { createWorkerStore, DEFAULT_BYTE_BUDGET } = await import("../../../web/lightbox/worker-store.js");

  test("production default budget is 256 MiB (seam does not alter production behaviour)", () => {
    expect(DEFAULT_BYTE_BUDGET).toBe(256 * 1024 * 1024);
    // A store created with no argument uses the same budget.
    const ws = createWorkerStore();
    expect(ws.storeBytes).toBe(0);
  });

  test("evictToBudget evicts the LRU unreferenced entry when over budget", () => {
    // Budget = 100 bytes.
    // Load A (60 bytes) — initially refs=1 (the load pinned it).
    // Simulate a worker crash: manually set refs=0 on A (pool-side unload not sent).
    // Load B (60 bytes, refs=1) → total=120 > 100 → evictToBudget → A is LRU + refs=0 → evicted.
    const budget = 100;
    const ws = createWorkerStore(budget);

    ws.loadMessage({ v: 1, type: "load", bytesId: 10, bytes: new Uint8Array(60) });
    // Simulate the worker crash / unpin scenario: manually zero refs without freeing.
    const entryA = ws.store.get(10)!;
    entryA.refs = 0; // test-only: mark as evictable

    ws.loadMessage({ v: 1, type: "load", bytesId: 20, bytes: new Uint8Array(60) });
    // evictToBudget ran inside loadMessage for B; A was LRU+refs=0 → evicted.
    expect(ws.store.has(20)).toBe(true);
    expect(ws.store.has(10)).toBe(false);
    expect(ws.storeBytes).toBeLessThanOrEqual(budget);
  });

  test("touch() promotes an entry to MRU so a different LRU entry is evicted first", () => {
    // Budget = 100.  Load A (60 bytes, mark refs=0) → touch A → load B (60 bytes, mark refs=0)
    // → load C (60 bytes) → eviction runs, B is LRU → evicted; A is MRU → kept.
    const budget = 100;
    const ws = createWorkerStore(budget);

    ws.loadMessage({ v: 1, type: "load", bytesId: 10, bytes: new Uint8Array(30) });
    ws.loadMessage({ v: 1, type: "load", bytesId: 20, bytes: new Uint8Array(30) });
    // Mark both unreferenced (simulate unpin without unload).
    ws.store.get(10)!.refs = 0;
    ws.store.get(20)!.refs = 0;
    // Touch A (10) → moves to MRU.
    ws.touch(10);
    // Load C (60 bytes) → total=120 > 100 → evict LRU unreferenced, which is bytesId=20.
    ws.loadMessage({ v: 1, type: "load", bytesId: 30, bytes: new Uint8Array(60) });

    expect(ws.store.has(10)).toBe(true);  // touched → MRU → kept
    expect(ws.store.has(20)).toBe(false); // LRU → evicted
    expect(ws.store.has(30)).toBe(true);
  });

  test("referenced entry (refs > 0) is NOT evicted even when it is the LRU entry", () => {
    // Budget = 100.  Two entries both at 60 bytes = 120 total > budget.
    // A (10) is LRU but has refs=1 (still referenced); B (20) has refs=0.
    // Eviction must skip A and evict B.
    const budget = 100;
    const ws = createWorkerStore(budget);

    ws.loadMessage({ v: 1, type: "load", bytesId: 10, bytes: new Uint8Array(60) });
    // B loaded after A, so B is MRU; but we manually zero B's refs.
    ws.loadMessage({ v: 1, type: "load", bytesId: 20, bytes: new Uint8Array(60) });
    ws.store.get(20)!.refs = 0; // B unreferenced, but MRU
    // Force eviction manually (total=120 > 100).
    ws.evictToBudget();

    // A (LRU, refs=1) must NOT be evicted.
    expect(ws.store.has(10)).toBe(true);
    // B (MRU, refs=0) IS evicted because it's the only unreferenced entry.
    expect(ws.store.has(20)).toBe(false);
    expect(ws.storeBytes).toBeLessThanOrEqual(budget);
  });
});

// ---------------------------------------------------------------------------
// 2. Worker failure: simulate a worker erroring mid-load under the range/owned
//    carrier path.  Assert the error propagates (decode rejects), no hang, and
//    the pool's other state is not corrupted.
// ---------------------------------------------------------------------------

/** A RecordingWorker variant that fires an error event on the first 'decode' message. */
class ErrorOnDecodeWorker {
  readonly messages: Array<{ msg: any; transfer: any[] }> = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(ev: { data?: any }) => void>>();

  constructor() {
    this.listeners.set("message", new Set());
    this.listeners.set("error", new Set());
    this.listeners.set("messageerror", new Set());
    globalThis.setTimeout(() => {
      if (!this.terminated) this.emit("message", { v: 1, type: "ready" });
    }, 0);
  }
  addEventListener(type: string, l: (ev: { data?: any }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l);
  }
  removeEventListener(type: string, l: (ev: { data?: any }) => void) {
    this.listeners.get(type)?.delete(l);
  }
  postMessage(msg: any, _transfer?: any[]): void {
    if (this.terminated) return;
    this.messages.push({ msg, transfer: _transfer ?? [] });
    if (msg.type === "decode") {
      // Fire a worker-level error to simulate a crash/OOM during decode.
      globalThis.setTimeout(() => this.emit("error", new ErrorEvent("error", { message: "simulated worker crash" })), 0);
    }
    if (msg.type === "unload") {
      globalThis.setTimeout(() => this.emit("message", { v: 1, type: "unload-ack", bytesId: msg.bytesId }), 0);
    }
  }
  terminate() {
    this.terminated = true;
  }
  private emit(type: string, data: any) {
    for (const l of this.listeners.get(type) ?? []) l(type === "error" ? data : { data });
  }
}

test("worker failure: error event during decode propagates and does not hang", async () => {
  const workers = [new ErrorOnDecodeWorker()];
  const pool = new PyramidWorkerPool({
    factory: () => workers.shift()!,
    maxSize: 1,
    idleTimeoutMs: 0,
    minIdle: 0,
    prewarm: "on-demand",
  });

  const c = buildJxtc({ width: 64, height: 32, tileSize: 32, tilePayload: 256 });
  const src = tiledSource(c);
  const bytesId = pool.allocateBytesId(src);
  const handles = spawnHandles(pool, 1);
  pool.ensureLoadedForTiles(handles, bytesId, src, [{ x: 0, y: 0, w: 32, h: 32 }], false);

  const outBuffer = new Uint8Array(32 * 32 * 4);
  const tiles = [{ x: 0, y: 0, w: 32, h: 32 }];

  // decodeTilesParallel should reject (not hang) when the worker emits an error event.
  await expect(
    __testing.decodeTilesParallel(
      bytesId,
      "rgba8",
      tiles,
      handles,
      outBuffer,
      { x: 0, y: 0, w: 32, h: 32 },
      4,
      { requestTimeoutMs: 2000 },
    ),
  ).rejects.toBeDefined();

  // The pool itself is not corrupted — it can be destroyed cleanly.
  await pool.destroy(0);
});

// ---------------------------------------------------------------------------
// 3. Refcount→0 frees: load a bytesId (refcount up), unload it (refcount→0),
//    assert the store actually freed it — subsequent load is a cache-miss
//    (re-transfer required).
// ---------------------------------------------------------------------------

/** A worker double that exposes its internal store so tests can probe store.has(bytesId). */
class StoreTrackingWorker {
  /** Mirror of the worker's byte store: bytesId → true if resident. */
  readonly byteStore = new Map<number, Uint8Array>();
  terminated = false;
  private readonly listeners = new Map<string, Set<(ev: { data?: any }) => void>>();
  readonly messages: Array<{ msg: any }> = [];

  constructor() {
    this.listeners.set("message", new Set());
    this.listeners.set("error", new Set());
    this.listeners.set("messageerror", new Set());
    globalThis.setTimeout(() => {
      if (!this.terminated) this.emit("message", { v: 1, type: "ready" });
    }, 0);
  }
  addEventListener(type: string, l: (ev: { data?: any }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l);
  }
  removeEventListener(type: string, l: (ev: { data?: any }) => void) {
    this.listeners.get(type)?.delete(l);
  }
  postMessage(msg: any, _transfer?: any[]): void {
    if (this.terminated) return;
    this.messages.push({ msg });
    if (msg.type === "load") {
      if (msg.bytes) this.byteStore.set(msg.bytesId, msg.bytes);
      else if (msg.sab) this.byteStore.set(msg.bytesId, new Uint8Array(msg.sab, 0, msg.byteLength));
    }
    if (msg.type === "unload") {
      this.byteStore.delete(msg.bytesId);
      globalThis.setTimeout(() => this.emit("message", { v: 1, type: "unload-ack", bytesId: msg.bytesId }), 0);
    }
  }
  terminate() { this.terminated = true; }
  private emit(type: string, data: any) {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
  loadCount() { return this.messages.filter(m => m.msg.type === "load").length; }
}

test("refcount→0 frees: unload releases the entry so a subsequent load re-transfers bytes", async () => {
  const trackingWorker = new StoreTrackingWorker();
  const workerQueue = [trackingWorker];
  const pool = new PyramidWorkerPool({
    factory: () => workerQueue.shift()!,
    maxSize: 1,
    idleTimeoutMs: 0,
    minIdle: 0,
    prewarm: "on-demand",
  });

  const c = buildJxtc({ tilePayload: 256 });
  const src = tiledSource(c);
  const bytesId = pool.allocateBytesId(src);
  const handles = spawnHandles(pool, 1);

  // Load the bytes onto the worker.
  pool.ensureLoadedForTiles(handles, bytesId, src, [{ x: 0, y: 0, w: 32, h: 32 }], false);
  expect(trackingWorker.loadCount()).toBe(1);
  // The pool's internal resident set should know bytesId is loaded.
  const loadsBefore = trackingWorker.loadCount();

  // Unload: pool sends 'unload', worker acks, pool clears its resident tracking.
  await pool.unload(handles, bytesId);
  // The StoreTrackingWorker.byteStore mirrors the worker's store: after unload, entry is gone.
  expect(trackingWorker.byteStore.has(bytesId)).toBe(false);

  // After unload the pool's resident-tracking is cleared for bytesId.
  // Re-loading the same tiles must re-transfer (cache miss) — not a no-op.
  pool.ensureLoadedForTiles(handles, bytesId, src, [{ x: 0, y: 0, w: 32, h: 32 }], false);
  expect(trackingWorker.loadCount()).toBeGreaterThan(loadsBefore);
});
