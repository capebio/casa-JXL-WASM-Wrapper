import { afterEach, describe, expect, test } from "bun:test";
import { createDecoder, setJxlModuleFactoryForTesting } from "../src/index";

// Regression: the expectedBytes pre-allocation used to run BEFORE the
// try/finally that frees the progressive decoder handle, so a malloc OOM
// leaked the native decoder. It now runs inside the try — an OOM must still
// call _jxl_wasm_dec_free.

function createOomFakeModule(oomSize: number) {
  const memory = new ArrayBuffer(65536);
  let nextPtr = 64;
  let decFreeCalls = 0;
  return {
    HEAPU8: new Uint8Array(memory),
    HEAP32: new Int32Array(memory),
    _malloc: (size: number) => {
      if (size === oomSize) return 0; // simulate OOM on the pre-allocation
      const ptr = nextPtr;
      nextPtr += size + 8;
      return ptr;
    },
    _free: () => {},
    _jxl_wasm_decode_rgba8: () => 0,
    _jxl_wasm_dec_create: () => 1,
    _jxl_wasm_dec_push: () => 1,
    _jxl_wasm_dec_close_input: () => {},
    _jxl_wasm_dec_width: () => 1,
    _jxl_wasm_dec_height: () => 1,
    _jxl_wasm_dec_error: () => 0,
    _jxl_wasm_dec_take_flushed: () => 0,
    _jxl_wasm_dec_take_final: () => 0,
    _jxl_wasm_dec_free: () => { decFreeCalls++; },
    _jxl_wasm_buffer_data: () => 0,
    _jxl_wasm_buffer_size: () => 0,
    _jxl_wasm_buffer_width: () => 0,
    _jxl_wasm_buffer_height: () => 0,
    _jxl_wasm_buffer_bits_per_sample: () => 8,
    _jxl_wasm_buffer_has_alpha: () => 1,
    _jxl_wasm_buffer_free: () => {},
    get __decFreeCalls() { return decFreeCalls; },
  };
}

describe("progressive decoder OOM leak", () => {
  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  test("expectedBytes pre-allocation OOM still frees the native decoder", async () => {
    const EXPECTED = 4096;
    const module = createOomFakeModule(EXPECTED);
    setJxlModuleFactoryForTesting(async () => module as any);

    const decoder = createDecoder({
      format: "rgba8",
      region: null,
      downsample: 1,
      progressionTarget: "final",
      emitEveryPass: false,
      preserveIcc: false,
      preserveMetadata: false,
      expectedBytes: EXPECTED,
    });
    decoder.push(new Uint8Array([1, 2, 3, 4]));
    decoder.close();

    const types: string[] = [];
    for await (const ev of decoder.events()) {
      types.push(ev.type);
    }
    expect(types).toContain("error");
    expect(module.__decFreeCalls).toBe(1);
  });
});
