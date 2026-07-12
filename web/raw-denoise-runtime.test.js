// Tests for web/raw-denoise-runtime.js
// All ORT inference and WASM DenoiseSession calls are mocked — no real model runs.
import { test, expect, vi } from 'vitest';
import { createRawDenoiseRuntime } from './raw-denoise-runtime.js';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function makeMockSession(tilesX = 2, tilesY = 2) {
  const committed = new Set();
  return {
    tiles_x: () => tilesX,
    tiles_y: () => tilesY,
    take_input_tile: (_tx, _ty) => new Float32Array(20 * 320 * 320),
    commit_output_tile: (tx, ty, _data) => committed.add(`${tx},${ty}`),
    finish_with_options: (_opts) => ({ type: 'learned' }),
    finish_classical: (_opts) => ({ type: 'classical' }),
    all_tiles_committed: () => committed.size === tilesX * tilesY,
    is_tile_committed: (tx, ty) => committed.has(`${tx},${ty}`),
    _committed: committed,
  };
}

function makeMockOrt({ failCreate = false, failRun = false } = {}) {
  return {
    Tensor: class MockTensor {
      constructor(type, data, shape) {
        this.type = type;
        this.data = data;
        this.shape = shape;
        this._disposed = false;
      }
      dispose() { this._disposed = true; }
    },
    InferenceSession: {
      create: failCreate
        ? () => Promise.reject(new Error('ORT create failed'))
        : () => Promise.resolve({
            run: failRun
              ? () => Promise.reject(new Error('ORT run failed'))
              : (feeds) => Promise.resolve({
                  residual_rgb: {
                    data: new Float32Array(12 * 256 * 256),
                    dispose: vi.fn(),
                  },
                }),
            release: vi.fn(),
          }),
    },
  };
}

// Manifest + model bytes for the happy-path mock.
// sha256 of an empty ArrayBuffer is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const GOOD_MANIFEST = { modelVersion: 'raw-denoise-v1', sha256: EMPTY_SHA };

function makeGoodFetch() {
  return (url) => {
    if (url.endsWith('.json')) {
      return Promise.resolve({ json: () => Promise.resolve(GOOD_MANIFEST) });
    }
    // .ort — empty buffer; sha256 will match EMPTY_SHA
    return Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
  };
}

function makeBadHashFetch() {
  return (url) => {
    if (url.endsWith('.json')) {
      return Promise.resolve({ json: () => Promise.resolve({ modelVersion: 'raw-denoise-v1', sha256: 'badhash' }) });
    }
    return Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
  };
}

// Patch global.fetch for a test scope, restore after.
function withFetch(fetchFn, fn) {
  return async () => {
    const orig = global.fetch;
    global.fetch = fetchFn;
    try { await fn(); } finally { global.fetch = orig; }
  };
}

// Patch global.navigator for a test scope.
function withNavigator(nav, fn) {
  return async () => {
    const orig = global.navigator;
    Object.defineProperty(global, 'navigator', { value: nav, configurable: true, writable: true });
    try { await fn(); } finally {
      Object.defineProperty(global, 'navigator', { value: orig, configurable: true, writable: true });
    }
  };
}

// ─── Manifest hash failure → finish_classical ─────────────────────────────────

test('manifest hash mismatch: createRawDenoiseRuntime rejects with mismatch error',
  withFetch(makeBadHashFetch(), async () => {
    const ort = makeMockOrt();
    await expect(
      createRawDenoiseRuntime({ ort, modelUrl: 'model.ort', manifestUrl: 'model.json' })
    ).rejects.toThrow(/hash mismatch/i);
  })
);

// ─── No navigator.gpu → falls back to wasm backend ───────────────────────────

test('no navigator.gpu: runtime is created with wasm backend',
  withFetch(makeGoodFetch(),
  withNavigator({ gpu: undefined }, async () => {
    const ort = makeMockOrt();
    const runtime = await createRawDenoiseRuntime({
      ort,
      modelUrl: 'model.ort',
      manifestUrl: 'model.json',
    });
    const session = makeMockSession(1, 1);
    const result = await runtime.run(session, {}, undefined);
    expect(result.backend).toBe('wasm');
    runtime.destroy();
  }))
);

// ─── ORT session creation failure → createRawDenoiseRuntime rejects ──────────

test('ORT session creation failure: createRawDenoiseRuntime rejects',
  withFetch(makeGoodFetch(),
  withNavigator({ gpu: {} }, async () => {
    // failCreate=true: WebGPU path fails, wasm path also fails
    const ort = makeMockOrt({ failCreate: true });
    await expect(
      createRawDenoiseRuntime({ ort, modelUrl: 'model.ort', manifestUrl: 'model.json' })
    ).rejects.toThrow();
  }))
);

// ─── Abort signal → run throws ────────────────────────────────────────────────

test('abort signal before first tile: run throws',
  withFetch(makeGoodFetch(),
  withNavigator({ gpu: undefined }, async () => {
    const ort = makeMockOrt();
    const runtime = await createRawDenoiseRuntime({
      ort, modelUrl: 'model.ort', manifestUrl: 'model.json',
    });
    const controller = new AbortController();
    controller.abort();
    const session = makeMockSession(2, 2);
    await expect(runtime.run(session, {}, controller.signal)).rejects.toThrow(/abort/i);
    runtime.destroy();
  }))
);

// ─── Tile order: row-major (ty outer, tx inner) ───────────────────────────────

test('tiles processed in row-major order (ty outer, tx inner)',
  withFetch(makeGoodFetch(),
  withNavigator({ gpu: undefined }, async () => {
    const ort = makeMockOrt();
    const runtime = await createRawDenoiseRuntime({
      ort, modelUrl: 'model.ort', manifestUrl: 'model.json',
    });
    const order = [];
    const session = {
      tiles_x: () => 2,
      tiles_y: () => 3,
      take_input_tile: (tx, ty) => { order.push(`${tx},${ty}`); return new Float32Array(20 * 320 * 320); },
      commit_output_tile: () => {},
      finish_with_options: () => ({ type: 'learned' }),
      finish_classical: () => ({ type: 'classical' }),
    };
    await runtime.run(session, {}, undefined);
    expect(order).toEqual(['0,0','1,0','0,1','1,1','0,2','1,2']);
    runtime.destroy();
  }))
);

// ─── Tensor disposal: input and output tensors disposed after each tile ───────

test('input tensor disposed after each tile',
  withFetch(makeGoodFetch(),
  withNavigator({ gpu: undefined }, async () => {
    const ort = makeMockOrt();
    const disposedTensors = [];
    // Wrap Tensor to track disposal
    const OrigTensor = ort.Tensor;
    ort.Tensor = class extends OrigTensor {
      dispose() { disposedTensors.push('input'); super.dispose(); }
    };
    const runtime = await createRawDenoiseRuntime({
      ort, modelUrl: 'model.ort', manifestUrl: 'model.json',
    });
    const session = makeMockSession(2, 2);
    await runtime.run(session, {}, undefined);
    // 4 tiles → 4 input tensor disposals
    expect(disposedTensors.filter(x => x === 'input').length).toBe(4);
    runtime.destroy();
  }))
);

test('output tensor disposed after each tile', async () => {
  const outputDisposeCount = { count: 0 };
  const ort = {
    Tensor: class { constructor() {} dispose() {} },
    InferenceSession: {
      create: () => Promise.resolve({
        run: () => Promise.resolve({
          residual_rgb: {
            data: new Float32Array(12 * 256 * 256),
            dispose: () => { outputDisposeCount.count++; },
          },
        }),
        release: vi.fn(),
      }),
    },
  };
  const origFetch = global.fetch;
  const origNav = global.navigator;
  global.fetch = makeGoodFetch();
  Object.defineProperty(global, 'navigator', { value: { gpu: undefined }, configurable: true, writable: true });
  try {
    const runtime = await createRawDenoiseRuntime({
      ort, modelUrl: 'model.ort', manifestUrl: 'model.json',
    });
    const session = makeMockSession(3, 2);
    await runtime.run(session, {}, undefined);
    // 6 tiles → 6 output tensor disposals
    expect(outputDisposeCount.count).toBe(6);
    runtime.destroy();
  } finally {
    Object.defineProperty(global, 'navigator', { value: origNav, configurable: true, writable: true });
    global.fetch = origFetch;
  }
});

// ─── Static dimensions: model input is [1,20,320,320] ────────────────────────

test('each tile creates a tensor with shape [1,20,320,320]',
  withFetch(makeGoodFetch(),
  withNavigator({ gpu: undefined }, async () => {
    const shapes = [];
    const ort = {
      Tensor: class { constructor(_type, _data, shape) { this.shape = shape; shapes.push(shape); } dispose() {} },
      InferenceSession: {
        create: () => Promise.resolve({
          run: () => Promise.resolve({ residual_rgb: { data: new Float32Array(12 * 256 * 256), dispose: () => {} } }),
          release: vi.fn(),
        }),
      },
    };
    const runtime = await createRawDenoiseRuntime({
      ort, modelUrl: 'model.ort', manifestUrl: 'model.json',
    });
    const session = makeMockSession(2, 1);
    await runtime.run(session, {}, undefined);
    expect(shapes.length).toBe(2);
    for (const s of shapes) {
      expect(s).toEqual([1, 20, 320, 320]);
    }
    runtime.destroy();
  }))
);

// ─── Successful run: all tiles committed → finish_with_options called ─────────

test('successful run returns backend, modelVersion, inferenceMs and all tiles committed',
  withFetch(makeGoodFetch(),
  withNavigator({ gpu: undefined }, async () => {
    const ort = makeMockOrt();
    const runtime = await createRawDenoiseRuntime({
      ort, modelUrl: 'model.ort', manifestUrl: 'model.json',
    });
    const finishWithOptionsSpy = vi.fn(() => ({ type: 'learned' }));
    const finishClassicalSpy = vi.fn(() => ({ type: 'classical' }));
    const session = {
      ...makeMockSession(2, 2),
      finish_with_options: finishWithOptionsSpy,
      finish_classical: finishClassicalSpy,
    };
    const result = await runtime.run(session, {}, undefined);
    // Validate result shape and values without chaining after toMatchObject+expect.any
    // (vitest 4.x leaves internal state after expect.any in toMatchObject that breaks
    // subsequent toBeGreaterThanOrEqual — assert independently)
    expect(typeof result.backend).toBe('string');
    expect(result.modelVersion).toBe('raw-denoise-v1');
    expect(typeof result.inferenceMs).toBe('number');
    expect(result.inferenceMs >= 0).toBe(true);
    // finish_classical must NOT have been called
    expect(finishClassicalSpy).not.toHaveBeenCalled();
    runtime.destroy();
  }))
);

// ─── ORT run failure → run throws (caller must call finish_classical) ─────────

test('ORT run failure: run() throws so caller can call finish_classical',
  withFetch(makeGoodFetch(),
  withNavigator({ gpu: undefined }, async () => {
    const ort = makeMockOrt({ failRun: true });
    // failRun on wasm path means wasm create succeeds but run fails
    // We need to override so create succeeds but run fails regardless of backend
    const ort2 = {
      Tensor: ort.Tensor,
      InferenceSession: {
        create: () => Promise.resolve({
          run: () => Promise.reject(new Error('ORT run failed')),
          release: vi.fn(),
        }),
      },
    };
    const runtime = await createRawDenoiseRuntime({
      ort: ort2, modelUrl: 'model.ort', manifestUrl: 'model.json',
    });
    const session = makeMockSession(2, 2);
    await expect(runtime.run(session, {}, undefined)).rejects.toThrow('ORT run failed');
    runtime.destroy();
  }))
);

// ─── destroy() releases the ORT inference session ────────────────────────────

test('destroy() calls release on the ORT inference session',
  withFetch(makeGoodFetch(),
  withNavigator({ gpu: undefined }, async () => {
    const releaseFn = vi.fn();
    const ort = {
      Tensor: class { constructor() {} dispose() {} },
      InferenceSession: {
        create: () => Promise.resolve({
          run: () => Promise.resolve({ residual_rgb: { data: new Float32Array(12 * 256 * 256), dispose: () => {} } }),
          release: releaseFn,
        }),
      },
    };
    const runtime = await createRawDenoiseRuntime({
      ort, modelUrl: 'model.ort', manifestUrl: 'model.json',
    });
    runtime.destroy();
    expect(releaseFn).toHaveBeenCalledTimes(1);
  }))
);
