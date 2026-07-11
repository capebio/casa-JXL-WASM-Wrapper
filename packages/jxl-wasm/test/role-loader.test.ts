import { afterEach, describe, expect, test } from "bun:test";
import {
  loadJxlModule,
  resetJxlRoleLoaderForTesting,
  setJxlArtifactLoaderForTesting,
  type JxlArtifactLoader,
} from "../src/index";

// A fake LibjxlWasmModule carrying only the symbols getCapabilities() probes,
// tagged so tests can assert which artifact the loader requested.
function fakeWasmModule(tag: string): any {
  return {
    __tag: tag,
    HEAPU8: new Uint8Array(0),
    HEAP32: new Int32Array(0),
    HEAPU32: new Uint32Array(0),
    _malloc: () => 0,
    _free: () => {},
    // decode symbol
    _jxl_wasm_decode_rgba8: () => 0,
    _jxl_wasm_dec_create: () => 1,
    // encode symbols
    _jxl_wasm_enc_create_image: () => 1,
    _jxl_wasm_enc_push_chunk: () => 1,
    _jxl_wasm_enc_finish: () => 1,
    _jxl_wasm_enc_take_chunk: () => 0,
    _jxl_wasm_enc_free: () => {},
    // perceptual symbol
    _jxl_wasm_butteraugli_compare: () => 0,
  };
}

// Records every artifact name the loader asks for, then returns a fake module.
function spyLoader(): { loader: JxlArtifactLoader; requested: string[] } {
  const requested: string[] = [];
  const loader: JxlArtifactLoader = async (artifact: string) => {
    requested.push(artifact);
    return fakeWasmModule(artifact);
  };
  return { loader, requested };
}

describe("loadJxlModule role-aware loading", () => {
  afterEach(() => {
    resetJxlRoleLoaderForTesting();
  });

  test("decode role does NOT request any encoder artifact", async () => {
    const { loader, requested } = spyLoader();
    setJxlArtifactLoaderForTesting(loader);

    await loadJxlModule({ role: "decode", tier: "simd-st" });

    expect(requested.length).toBe(1);
    expect(requested[0]).toContain("dec.");
    expect(requested.some((a) => a.includes("enc."))).toBe(false);
  });

  test("encode role does NOT request any decoder-only artifact", async () => {
    const { loader, requested } = spyLoader();
    setJxlArtifactLoaderForTesting(loader);

    await loadJxlModule({ role: "encode", tier: "simd-st" });

    expect(requested.length).toBe(1);
    expect(requested[0]).toContain("enc.");
    expect(requested.some((a) => a.includes("dec."))).toBe(false);
  });
});
