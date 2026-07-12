// RAW Denoise Runtime — ORT WebGPU inference for the RAW denoise pipeline.
//
// createRawDenoiseRuntime({ ort, modelUrl, manifestUrl }) → Runtime
//   Downloads and SHA-256-verifies the model, creates an ORT InferenceSession
//   (WebGPU if available, wasm otherwise), and returns a Runtime object.
//
// runtime.run(session, options, signal) → { backend, modelVersion, inferenceMs }
//   Iterates all tiles of a WASM DenoiseSession in row-major order (ty outer,
//   tx inner), runs ORT inference on each tile, and commits the residuals.
//   Any failure (tensor error, device loss, abort) throws — the caller is
//   responsible for calling session.finish_classical() on the catch path.
//
// runtime.destroy()
//   Releases the ORT InferenceSession. Call when the worker is torn down or on
//   device-loss recovery.
//
// Invariants (per spec):
//   - Every ORT tensor (input + output) is disposed after each tile.
//   - The model input shape is always [1, 20, 320, 320].
//   - On any failure the Runtime marks itself destroyed and re-throws.
//   - One Runtime is created per worker (lazy singleton — see worker.js).

/**
 * Fetch the model bytes and manifest, then verify the SHA-256 hash.
 * @param {string} modelUrl
 * @param {string} manifestUrl
 * @returns {Promise<{modelBytes: ArrayBuffer, manifest: object}>}
 */
async function fetchAndVerify(modelUrl, manifestUrl) {
  const [modelBytes, manifest] = await Promise.all([
    fetch(modelUrl).then((r) => r.arrayBuffer()),
    fetch(manifestUrl).then((r) => r.json()),
  ]);
  const hashBuffer = await crypto.subtle.digest('SHA-256', modelBytes);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  if (hashHex !== manifest.sha256) {
    throw new Error(
      `[denoise-runtime] Model hash mismatch: expected ${manifest.sha256}, got ${hashHex}`,
    );
  }
  return { modelBytes, manifest };
}

/**
 * Create an ORT InferenceSession. Tries WebGPU first, falls back to wasm.
 * @param {object} ort  onnxruntime-web module
 * @param {ArrayBuffer} modelBytes
 * @returns {Promise<{session: object, backend: string}>}
 */
async function createOrtSession(ort, modelBytes) {
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: ['webgpu'],
        enableGraphCapture: true,
        graphOptimizationLevel: 'all',
      });
      return { session, backend: 'webgpu' };
    } catch (e) {
      console.warn('[denoise-runtime] WebGPU init failed, falling back to wasm:', e.message);
    }
  }
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
  });
  return { session, backend: 'wasm' };
}

class Runtime {
  // Private fields
  #inference;
  #backend;
  #manifest;
  #ort;
  _destroyed = false;

  constructor(ort, inferenceSession, backend, manifest) {
    this.#ort = ort;
    this.#inference = inferenceSession;
    this.#backend = backend;
    this.#manifest = manifest;
  }

  /**
   * Run full denoise inference on a WASM DenoiseSession.
   * Processes all tiles in row-major order (ty outer, tx inner).
   * @param {object} session - WASM DenoiseSession
   * @param {object} _options - parsed denoise options (unused here; caller uses them for finish calls)
   * @param {AbortSignal} [signal] - optional abort
   * @returns {Promise<{backend: string, modelVersion: string, inferenceMs: number}>}
   */
  async run(session, _options, signal) {
    const tilesX = session.tiles_x();
    const tilesY = session.tiles_y();
    const perf = typeof performance !== 'undefined' ? performance : { now: () => Date.now() };
    const t0 = perf.now();

    try {
      for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
          if (signal?.aborted) {
            throw new Error('aborted');
          }

          // Take the packed float32 tile from WASM: [20, 320, 320]
          const inputData = session.take_input_tile(tx, ty);

          // Create ORT tensor with static shape [1, 20, 320, 320]
          const inputTensor = new this.#ort.Tensor('float32', inputData, [1, 20, 320, 320]);
          let outputTensor;
          try {
            const results = await this.#inference.run({ input: inputTensor });
            outputTensor = results.residual_rgb;
            const residuals = outputTensor.data; // Float32Array [1*12*256*256]

            // Commit to session — convert to plain Array as the WASM binding expects
            session.commit_output_tile(tx, ty, Array.from(residuals));
          } finally {
            // Always dispose both tensors, even on error
            inputTensor.dispose?.();
            outputTensor?.dispose?.();
          }
        }
      }

      return {
        backend: this.#backend,
        modelVersion: this.#manifest.modelVersion,
        inferenceMs: perf.now() - t0,
      };
    } catch (err) {
      // Any failure → mark destroyed so the caller knows state is invalid
      this._destroyed = true;
      throw err;
    }
  }

  /**
   * Release the ORT InferenceSession. Safe to call multiple times.
   */
  destroy() {
    if (this.#inference) {
      this.#inference.release?.();
      this.#inference = null;
    }
    this._destroyed = true;
  }
}

/**
 * Create a RAW denoise runtime backed by ORT WebGPU (or wasm fallback).
 *
 * @param {object} opts
 * @param {object} opts.ort           onnxruntime-web module (injected for testability)
 * @param {string} opts.modelUrl      URL to .ort model file
 * @param {string} opts.manifestUrl   URL to .json manifest file
 * @returns {Promise<Runtime>}
 */
export async function createRawDenoiseRuntime({ ort, modelUrl, manifestUrl }) {
  const { modelBytes, manifest } = await fetchAndVerify(modelUrl, manifestUrl);
  const { session, backend } = await createOrtSession(ort, modelBytes);
  return new Runtime(ort, session, backend, manifest);
}
