import { afterEach, expect, test } from "bun:test";
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
