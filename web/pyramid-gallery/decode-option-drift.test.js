import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * Finding 78 (Packet 2, Task 3): the gallery tiled-decode path leaked options the accepted
 * decode interface never declared — `sourceKey`, `priority`, and `format` were passed straight
 * to `decodeTiledViewportPooled`, which silently ignored them (option drift). The consolidated
 * orchestration routes tiled decodes through the ONE injected runtime (which owns the pool and
 * rejects unknown option names), and the low-level pooled call carries only its accepted options.
 */

const decodeJs = readFileSync(new URL('./pyramid-decode.js', import.meta.url), 'utf8');
const gridJs = readFileSync(new URL('./grid-controller.js', import.meta.url), 'utf8');

test('pyramid-decode tiled branch does not pass drifted options to the pooled decoder (finding 78)', () => {
  // Isolate the tiled branch (from the `if (opts.tiled)` guard to the closing of that block).
  const start = decodeJs.indexOf('if (opts.tiled)');
  expect(start).toBeGreaterThanOrEqual(0);
  const sessionStart = decodeJs.indexOf('const session = ctx.decode(');
  expect(sessionStart).toBeGreaterThan(start);
  const tiledBranch = decodeJs.slice(start, sessionStart);

  // The pooled call must NOT forward options the pooled interface does not accept.
  expect(tiledBranch).not.toContain('sourceKey:');
  expect(tiledBranch).not.toContain('priority:');
  expect(tiledBranch).not.toContain('format:');
});

test('grid-controller routes tiled decode through the injected runtime, not a per-call engine (finding 78/77)', () => {
  // The runtime is the single orchestration surface that owns the pool. The grid must actually
  // use it for tiled levels instead of ignoring it (`void runtime;`) and calling the module engine.
  expect(gridJs).not.toContain('void runtime;');
  expect(gridJs).toContain('runtime.decodeLevel');
});

test('grid-controller no longer threads drifted priority/format/sourceKey into the tiled decode (finding 78)', () => {
  // The runtime demand allow-list rejects unknown keys; grid must not build a demand carrying them.
  // (priority is a scheduler concept for the whole/session path, not a tiled-pool demand.)
  const decodeForLevel = gridJs.slice(gridJs.indexOf('async function decodeForLevel'), gridJs.indexOf('function paintCanvas'));
  // The tiled runtime path must not pass sourceKey to the runtime (unknown demand key).
  expect(decodeForLevel).not.toContain('sourceKey:');
});

// Functional: drive decodeForLevel through a fake runtime + store, proving the tiled decode routes
// to runtime.decodeLevel with only accepted demand keys (finding 77/78), and the whole path does not.
test('tiled level decodes through the injected runtime with a clean demand; whole level does not', async () => {
  const { createGridController } = await import('./grid-controller.js');

  const runtimeCalls = [];
  const fakeRuntime = {
    capabilities: { workers: true, sharedMemory: false, rangeRequests: false, rgba16: false },
    pool: {},
    async decodeLevel(source, region, demand) {
      runtimeCalls.push({ source, region, demand });
      return { pixels: new Uint8Array(source.width * source.height * 4).fill(3), width: source.width, height: source.height, format: 'rgba8' };
    },
    async dispose() {},
  };

  // A minimal 32-byte JXTC container header so createLevelSource(tiled) accepts the bytes.
  const W = 64, H = 32, tileSize = 32;
  const container = new Uint8Array(32);
  const dv = new DataView(container.buffer);
  dv.setUint32(0, 0x4354584a, true); // 'JXTC'
  dv.setUint32(4, 1, true);
  dv.setUint32(8, W, true);
  dv.setUint32(12, H, true);
  dv.setUint32(16, tileSize, true);
  dv.setUint32(20, 2, true);
  dv.setUint32(24, 1, true);
  dv.setUint32(28, 0, true);

  const level = { contenthash: 'abc', w: W, h: H, bitsPerSample: 8, tiled: true };
  const fakeStore = {
    async getLevelBytes() { return container; },
    // Manifest chooses the SAME tiled level as the L0 seed, so shouldUpgrade() blocks a second
    // decode: exactly one runtime.decodeLevel call for the tiled path.
    async getManifest() { return { levels: [level] }; },
  };

  const grid = createGridController({
    ctx: { decode() { throw new Error('tiled level must not hit the session path'); } },
    imageStore: fakeStore,
    runtime: fakeRuntime,
    tileSizePx: 220,
    devicePixelRatio: 1,
    indexByImageId: new Map([['img1', { imageId: 'img1', aspect: W / H, l0: level }]]),
    onTilePainted() {},
  });

  // paintCell -> paintLevel -> decodeForLevel(tiled) -> runtime.decodeLevel. paintCanvas needs a
  // canvas-like object; stub the DOM surface it touches.
  const canvasStub = {
    width: 0, height: 0, dataset: {}, style: {},
    getContext: () => ({ putImageData() {} }),
    parentElement: {},
  };
  const cellStub = { querySelector: () => canvasStub, appendChild() {}, dataset: {} };
  globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());
  globalThis.ImageData = globalThis.ImageData || class { constructor(a, w, h) { this.data = a; this.width = w; this.height = h; } };

  await grid.paintCell(cellStub, 'img1', {});

  expect(runtimeCalls.length).toBe(1);
  const call = runtimeCalls[runtimeCalls.length - 1];
  expect(call.source.kind).toBe('tiled');
  expect(call.region).toEqual({ x: 0, y: 0, w: W, h: H });
  // Demand carries only accepted keys — no drifted sourceKey/priority/format.
  expect(Object.keys(call.demand).sort()).toEqual(['quality', 'signal']);
});
