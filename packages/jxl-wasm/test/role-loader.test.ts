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

  test("perceptual role loads the encoder superset (butteraugli lives there)", async () => {
    const { loader, requested } = spyLoader();
    setJxlArtifactLoaderForTesting(loader);

    await loadJxlModule({ role: "perceptual", tier: "simd-st" });

    expect(requested[0]).toContain("enc.");
  });

  test("returned JxlModule reports its resolved role, tier, and capabilities", async () => {
    const { loader } = spyLoader();
    setJxlArtifactLoaderForTesting(loader);

    const loaded = await loadJxlModule({ role: "decode", tier: "simd-st" });

    expect(loaded.role).toBe("decode");
    expect(loaded.tier).toBe("simd-st");
    expect(loaded.capabilities.progressiveDecode).toBe(true);
    expect(typeof loaded.module).toBe("object");
  });

  test("tier maps to the matching artifact suffix (simd-st → simd)", async () => {
    const seen: string[][] = [];
    setJxlArtifactLoaderForTesting(async (_artifact, candidates) => {
      seen.push([...candidates]);
      return fakeWasmModule(candidates[0]);
    });

    await loadJxlModule({ role: "decode", tier: "simd-st" });

    // Role-specific candidate first, monolithic fallback second.
    expect(seen[0][0]).toBe("dec.simd");
    expect(seen[0][1]).toBe("simd");
  });

  test("scalar tier has no role split — candidates fall back to the monolithic artifact", async () => {
    const seen: string[][] = [];
    setJxlArtifactLoaderForTesting(async (_artifact, candidates) => {
      seen.push([...candidates]);
      return fakeWasmModule(candidates[0]);
    });

    await loadJxlModule({ role: "decode", tier: "scalar-st" });

    expect(seen[0]).toContain("scalar");
  });

  test("unknown role rejects deterministically (never silently coerced)", async () => {
    const { loader } = spyLoader();
    setJxlArtifactLoaderForTesting(loader);

    await expect(
      loadJxlModule({ role: "transcode" as any, tier: "simd-st" }),
    ).rejects.toThrow(/Unknown JXL role/);
  });

  test("unknown tier rejects deterministically", async () => {
    const { loader } = spyLoader();
    setJxlArtifactLoaderForTesting(loader);

    await expect(
      loadJxlModule({ role: "decode", tier: "avx512" as any }),
    ).rejects.toThrow(/Unknown JXL tier/);
  });

  test("simultaneous callers for the same {role,tier} share one in-flight load", async () => {
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setJxlArtifactLoaderForTesting(async (_artifact, candidates) => {
      loads++;
      await gate;
      return fakeWasmModule(candidates[0]);
    });

    const a = loadJxlModule({ role: "decode", tier: "simd-st" });
    const b = loadJxlModule({ role: "decode", tier: "simd-st" });
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(loads).toBe(1);
    expect(ra).toBe(rb); // same cached JxlModule instance
  });

  test("different roles do NOT share a cached module", async () => {
    let loads = 0;
    setJxlArtifactLoaderForTesting(async (_artifact, candidates) => {
      loads++;
      return fakeWasmModule(candidates[0]);
    });

    await Promise.all([
      loadJxlModule({ role: "decode", tier: "simd-st" }),
      loadJxlModule({ role: "encode", tier: "simd-st" }),
    ]);

    expect(loads).toBe(2);
  });

  test("an already-aborted signal rejects without loading anything", async () => {
    let loads = 0;
    setJxlArtifactLoaderForTesting(async (_artifact, candidates) => {
      loads++;
      return fakeWasmModule(candidates[0]);
    });
    const ac = new AbortController();
    ac.abort();

    await expect(
      loadJxlModule({ role: "decode", tier: "simd-st", signal: ac.signal }),
    ).rejects.toThrow();
    expect(loads).toBe(0);
  });
});
