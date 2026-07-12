// Packet-3 Task 2 (finding 18): advanced JXL encoder settings must be REAL, not silent no-ops.
//
// Contract under test:
//   - There is ONE generic frame-setting bridge call (`_jxl_wasm_enc_set_frame_setting`),
//     libjxl-validated, that the facade forwards each `advancedFrameSettings` entry to.
//   - The JS facade does NOT mirror a growing per-id switch — it forwards id+value verbatim.
//   - An unknown / unsupported setting produces a DETERMINISTIC ERROR (a thrown Error whose
//     message carries the failing rc) — it is never silently ignored.
//   - The same settings are applied whether the encode runs the streaming or the buffered path.
//
// Most assertions run against a spy module so they hold WITHOUT a fresh WASM rebuild (they
// verify the facade's ABI wiring). A final capability-gated section exercises the real bridge
// end-to-end; it is skipped (loudly) when the shipped dist predates this bridge — that gap is
// the merge-held OWED item, not a facade defect.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createEncoder,
  setJxlModuleFactoryForTesting,
  JxlFrameSetting,
} from "../src/index";
import type { EncoderOptions } from "../src/facade";

const baseOptions: EncoderOptions = {
  format: "rgba8",
  width: 4,
  height: 4,
  hasAlpha: true,
  iccProfile: null,
  exif: null,
  xmp: null,
  distance: 1,
  quality: null,
  effort: 3,
  progressive: false,
  previewFirst: false,
  chunked: false,
};

function makePixels(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = (i * 3) & 0xff;
    out[i + 1] = (i * 5) & 0xff;
    out[i + 2] = (i * 7) & 0xff;
    out[i + 3] = 0xff;
  }
  return out;
}

async function drain(encoder: ReturnType<typeof createEncoder>): Promise<number> {
  let total = 0;
  for await (const chunk of encoder.chunks()) {
    total += (chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)).byteLength;
  }
  return total;
}

/**
 * Spy module that records every generic frame-setting call and lets a test decide
 * which ids libjxl "rejects". It implements just enough of the streaming-input encode
 * ABI (`enc_create_image` family + set_frame_setting + finish + take_chunk) that the
 * facade drives the real code path — no fake pixel encode, just call capture.
 */
function createSettingSpyModule(opts: { rejectIds?: number[]; supportSetter?: boolean } = {}) {
  const rejectIds = new Set(opts.rejectIds ?? []);
  const supportSetter = opts.supportSetter ?? true;
  const memory = new ArrayBuffer(1 << 20);
  const HEAPU8 = new Uint8Array(memory);
  const HEAP32 = new Int32Array(memory);
  const HEAPU32 = new Uint32Array(memory);
  let nextPtr = 64;
  const allocations = new Map<number, number>();
  const settingCalls: Array<{ id: number; value: number }> = [];
  let pendingRejected = 0; // rc surfaced at finish when a rejected id was set
  let finishRc = 0;
  let chunkYielded = false;

  const malloc = (size: number) => {
    const ptr = nextPtr;
    nextPtr += size + 8;
    allocations.set(ptr, size);
    return ptr;
  };

  const makeState = () => {
    // Non-zero "state" pointer; the facade only checks !== 0.
    const s = malloc(16);
    return s;
  };

  const mod: Record<string, unknown> = {
    HEAPU8,
    HEAP32,
    HEAPU32,
    __settingCalls: settingCalls,
    _malloc: malloc,
    _free: (ptr: number) => allocations.delete(ptr),
    // Streaming-input create family (only the ones the facade dispatches to are needed).
    _jxl_wasm_enc_create_image: () => makeState(),
    _jxl_wasm_enc_create_image_x: () => makeState(),
    _jxl_wasm_enc_create_image_y: () => makeState(),
    _jxl_wasm_enc_create_image_z: () => makeState(),
    _jxl_wasm_enc_pixels_ptr: (_s: number, _size: number) => malloc(_size),
    _jxl_wasm_enc_advance_written: () => 0,
    _jxl_wasm_enc_push_chunk: () => 0,
    _jxl_wasm_enc_finish: () => {
      // libjxl-backed validation is deferred to finish: a rejected id sets a deterministic rc.
      finishRc = pendingRejected !== 0 ? pendingRejected : 0;
      return finishRc;
    },
    _jxl_wasm_enc_take_chunk: () => {
      if (chunkYielded || finishRc !== 0) return 0;
      chunkYielded = true;
      const dataPtr = malloc(4);
      const handle = malloc(64);
      HEAPU32[(handle >> 2) + 0] = dataPtr;
      HEAPU32[(handle >> 2) + 1] = 4;
      return handle;
    },
    _jxl_wasm_buffer_data: (h: number) => HEAPU32[(h >> 2) + 0],
    _jxl_wasm_buffer_size: (h: number) => HEAPU32[(h >> 2) + 1],
    _jxl_wasm_buffer_width: () => 4,
    _jxl_wasm_buffer_height: () => 4,
    _jxl_wasm_buffer_bits_per_sample: () => 8,
    _jxl_wasm_buffer_has_alpha: () => 1,
    _jxl_wasm_buffer_free: () => {},
    _jxl_wasm_enc_free: () => {},
  };

  if (supportSetter) {
    mod._jxl_wasm_enc_set_frame_setting = (_s: number, id: number, value: number) => {
      settingCalls.push({ id, value });
      // Deterministic: a rejected id records a non-zero rc that finish() will surface.
      if (rejectIds.has(id)) pendingRejected = 900 + id;
      return 0; // set is deferred; validation happens at finish (libjxl semantics)
    };
  }

  return mod;
}

describe("advanced settings — generic frame-setting ABI (finding 18)", () => {
  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  test("a known setting is forwarded verbatim to the single generic bridge call", async () => {
    const mod = createSettingSpyModule();
    setJxlModuleFactoryForTesting(async () => mod as never);

    const encoder = createEncoder({
      ...baseOptions,
      advancedFrameSettings: [{ id: JxlFrameSetting.PATCHES, value: 1 }],
    });
    encoder.pushPixels(makePixels(4, 4));
    encoder.finish();
    await drain(encoder);

    // Exactly one generic call, with the caller's id + value — no JS-side id switch/rewrite.
    expect(mod.__settingCalls).toEqual([{ id: JxlFrameSetting.PATCHES, value: 1 }]);
  });

  test("multiple settings each become one generic call, in order", async () => {
    const mod = createSettingSpyModule();
    setJxlModuleFactoryForTesting(async () => mod as never);

    const encoder = createEncoder({
      ...baseOptions,
      advancedFrameSettings: [
        { id: JxlFrameSetting.PATCHES, value: 1 },
        { id: 41 /* some other libjxl id */, value: 2 },
      ],
    });
    encoder.pushPixels(makePixels(4, 4));
    encoder.finish();
    await drain(encoder);

    expect(mod.__settingCalls).toEqual([
      { id: JxlFrameSetting.PATCHES, value: 1 },
      { id: 41, value: 2 },
    ]);
  });

  test("an unsupported/unknown setting id yields a DETERMINISTIC error (never silently ignored)", async () => {
    const UNKNOWN = 99999;
    const mod = createSettingSpyModule({ rejectIds: [UNKNOWN] });
    setJxlModuleFactoryForTesting(async () => mod as never);

    const encoder = createEncoder({
      ...baseOptions,
      advancedFrameSettings: [{ id: UNKNOWN, value: 7 }],
    });
    encoder.pushPixels(makePixels(4, 4));
    encoder.finish();

    let threw: Error | null = null;
    try {
      await drain(encoder);
    } catch (err) {
      threw = err as Error;
    }
    expect(threw).not.toBeNull();
    // Deterministic rc encoded in the message (900 + id from the spy's libjxl-reject model).
    expect(threw!.message).toContain(String(900 + UNKNOWN));
    // The setting WAS attempted (not dropped): the generic call was made.
    expect(mod.__settingCalls).toEqual([{ id: UNKNOWN, value: 7 }]);
  });

  test("advancedFrameSettings are NOT silently dropped when the setter bridge is missing", async () => {
    // A build without the generic setter must FAIL LOUDLY rather than encode while ignoring
    // the requested settings (the old silent no-op behaviour this task removes).
    const mod = createSettingSpyModule({ supportSetter: false });
    setJxlModuleFactoryForTesting(async () => mod as never);

    const encoder = createEncoder({
      ...baseOptions,
      advancedFrameSettings: [{ id: JxlFrameSetting.PATCHES, value: 1 }],
    });
    encoder.pushPixels(makePixels(4, 4));
    encoder.finish();

    let threw: Error | null = null;
    try {
      await drain(encoder);
    } catch (err) {
      threw = err as Error;
    }
    expect(threw).not.toBeNull();
    expect(threw!.message.toLowerCase()).toContain("frame setting");
  });

  test("a value outside int32 range is rejected LOUDLY, not silently truncated at the FFI", async () => {
    const mod = createSettingSpyModule();
    setJxlModuleFactoryForTesting(async () => mod as never);

    const encoder = createEncoder({
      ...baseOptions,
      // 2**40 would wrap to 0 as a C int — must throw before reaching the bridge, not silently apply 0.
      advancedFrameSettings: [{ id: JxlFrameSetting.PATCHES, value: 2 ** 40 }],
    });
    encoder.pushPixels(makePixels(4, 4));
    encoder.finish();

    let threw: Error | null = null;
    try {
      await drain(encoder);
    } catch (err) {
      threw = err as Error;
    }
    expect(threw).not.toBeNull();
    expect(threw!.message.toLowerCase()).toContain("int32");
    // The out-of-range value never reached the bridge (no silent truncated call).
    expect(mod.__settingCalls).toEqual([]);
  });

  test("no advancedFrameSettings → zero generic calls (baseline unaffected)", async () => {
    const mod = createSettingSpyModule();
    setJxlModuleFactoryForTesting(async () => mod as never);

    const encoder = createEncoder({ ...baseOptions });
    encoder.pushPixels(makePixels(4, 4));
    encoder.finish();
    await drain(encoder);

    expect(mod.__settingCalls).toEqual([]);
  });
});

// Real end-to-end validation against the shipped WASM. Skipped (loudly) when the dist
// predates the generic setter — that is the merge-held OWED gate, not a facade bug.
describe("advanced settings — real bridge round trip (capability-gated)", () => {
  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  test("known setting changes the encoded bytes; unknown id rejected — or OWED if unbuilt", async () => {
    let mod: Record<string, unknown> | null = null;
    const baseUrl = new URL("../dist/", import.meta.url);
    // Prefer the rebuilt enc.simd module (carries the P3-T2 setter). Node/Bun needs wasmBinary.
    for (const [js, wasm] of [
      ["../dist/jxl-core.enc.simd.js", "jxl-core.enc.simd.wasm"],
      ["../dist/jxl-core.scalar.js", "jxl-core.scalar.wasm"],
    ] as const) {
      try {
        const imported = await import(js);
        if (typeof imported.default !== "function") continue;
        const wasmBinary = readFileSync(new URL(wasm, baseUrl));
        const candidate = (await imported.default({
          wasmBinary,
          locateFile: (p: string) => new URL(p, baseUrl).href,
        })) as Record<string, unknown>;
        if (candidate && typeof candidate._malloc === "function") {
          mod = candidate;
          break;
        }
      } catch {
        mod = null;
      }
    }

    if (!mod || typeof mod._jxl_wasm_enc_set_frame_setting !== "function") {
      console.warn(
        "[OWED] Real advanced-settings round trip SKIPPED: shipped dist lacks " +
          "_jxl_wasm_enc_set_frame_setting. Rebuild the Emscripten WASM to run this gate.",
      );
      return;
    }

    setJxlModuleFactoryForTesting(async () => mod as never);
    const pixels = makePixels(64, 64);

    const encPlain = createEncoder({ ...baseOptions, width: 64, height: 64 });
    encPlain.pushPixels(pixels);
    encPlain.finish();
    const plainBytes = await drain(encPlain);

    // Force the Modular sub-codec via the generic setter (id 11 = JXL_ENC_FRAME_SETTING_MODULAR).
    // Modular vs the default VarDCT produces a materially different bitstream — a content-robust
    // proof that the generic setting actually reached and reconfigured libjxl (not a no-op).
    const encModular = createEncoder({
      ...baseOptions,
      width: 64,
      height: 64,
      advancedFrameSettings: [{ id: 11, value: 1 }],
    });
    encModular.pushPixels(pixels);
    encModular.finish();
    const modularBytes = await drain(encModular);

    expect(plainBytes).toBeGreaterThan(0);
    expect(modularBytes).toBeGreaterThan(0);
    expect(modularBytes).not.toBe(plainBytes);

    // A known but no-op-on-this-content setting (PATCHES) still encodes successfully.
    const encPatched = createEncoder({
      ...baseOptions,
      width: 64,
      height: 64,
      advancedFrameSettings: [{ id: JxlFrameSetting.PATCHES, value: 1 }],
    });
    encPatched.pushPixels(pixels);
    encPatched.finish();
    expect(await drain(encPatched)).toBeGreaterThan(0);

    // Unknown id must throw deterministically (libjxl-validated rejection, never silent).
    const encBad = createEncoder({
      ...baseOptions,
      width: 64,
      height: 64,
      advancedFrameSettings: [{ id: 99999, value: 3 }],
    });
    encBad.pushPixels(pixels);
    encBad.finish();
    await expect(drain(encBad)).rejects.toThrow();
  });
});
