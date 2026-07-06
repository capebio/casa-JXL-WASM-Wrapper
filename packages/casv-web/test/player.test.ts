import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CasvReader,
  decodeCasvAll,
  parseCasvRateBox,
  playCasv,
  rateFromFlags,
  CASV_HDR_FABLE_FLAG,
  CASV_REPLACE_FLAG,
  type JxlFrameDecoder,
} from "../src/index";
import { createDecoder, setJxlModuleFactoryForTesting } from "../../jxl-wasm/src/index";

// Real-wasm JXL decoder (scalar dist), shared across tests.
async function loadRealModule(): Promise<any | null> {
  try {
    const imported = await import("../../jxl-wasm/dist/jxl-core.scalar.js");
    if (typeof imported.default !== "function") return null;
    const baseUrl = new URL("../../jxl-wasm/dist/", import.meta.url);
    const module = await imported.default({
      locateFile: (path: string) => new URL(path, baseUrl).href,
    });
    if (module && typeof module._malloc === "function") return module;
  } catch {}
  return null;
}

const modulePromise = loadRealModule();

const decodeJxl: JxlFrameDecoder = async (jxl) => {
  const module = await modulePromise;
  if (!module) throw new Error("jxl-wasm scalar dist unavailable");
  setJxlModuleFactoryForTesting(async () => module);
  const decoder = createDecoder({
    format: "rgba8",
    region: null,
    downsample: 1,
    progressionTarget: "final",
    emitEveryPass: false,
    preserveIcc: false,
    preserveMetadata: false,
  });
  decoder.push(jxl.slice()); // defensive copy: facade may transfer
  decoder.close();
  for await (const ev of decoder.events()) {
    if (ev.type === "error") throw new Error(ev.message);
    if (ev.type === "final") {
      const px = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
      return { rgba: px.slice(), width: ev.info.width, height: ev.info.height };
    }
  }
  throw new Error("decoder produced no final frame");
};

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

const manifest: Record<string, { width: number; height: number; frames: number }> = JSON.parse(
  readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8")
);

/** Compare decoded RGBA frames against the native RGB dump. Lossy JXL decode is
 * not bit-specified across implementations (wasm scalar vs native AVX2), so a
 * small tolerance applies to RGB; alpha must be exactly 255. */
function compareAgainstNative(
  frames: { rgba: Uint8Array; width: number; height: number }[],
  expectedRgb: Uint8Array,
  w: number,
  h: number
): { maxDiff: number; meanDiff: number } {
  const frameRgb = w * h * 3;
  let maxDiff = 0;
  let sum = 0;
  let count = 0;
  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f]!;
    expect(frame.width).toBe(w);
    expect(frame.height).toBe(h);
    for (let p = 0; p < w * h; p++) {
      for (let c = 0; c < 3; c++) {
        const a = frame.rgba[p * 4 + c]!;
        const b = expectedRgb[f * frameRgb + p * 3 + c]!;
        const d = Math.abs(a - b);
        if (d > maxDiff) maxDiff = d;
        sum += d;
        count++;
      }
      expect(frame.rgba[p * 4 + 3]).toBe(255);
    }
  }
  return { maxDiff, meanDiff: sum / count };
}

describe("casv-web player vs native decode", () => {
  for (const name of ["tile_v2", "bbox", "sink_ratebox", "intra"]) {
    test(`${name}.casv decodes to the native reconstruction`, async () => {
      if (!(await modulePromise)) return; // dist unavailable — skip
      const meta = manifest[name]!;
      const bytes = fixture(`${name}.casv`);
      const frames = await decodeCasvAll(bytes, decodeJxl);
      expect(frames.length).toBe(meta.frames);
      const expected = fixture(`${name}.expected.rgb`);
      const { maxDiff, meanDiff } = compareAgainstNative(frames, expected, meta.width, meta.height);
      // wasm-scalar vs native-SIMD decode drift bound.
      expect(maxDiff).toBeLessThanOrEqual(3);
      expect(meanDiff).toBeLessThanOrEqual(1.0);
    });
  }

  test("reader exposes rate metadata (header flags + CASR box)", () => {
    const tile = CasvReader.parse(fixture("tile_v2.casv"));
    expect(tile.rate.lossy).toBe(true);
    expect(tile.rate.distance).toBe(1.0);
    expect(tile.rate.effort).toBe(3);
    expect(tile.rate.fable).toBe(false);
    // P-frames flagged tile+replace.
    expect(tile.entry(0).isPFrame).toBe(false);
    expect(tile.entry(1).isPFrame).toBe(true);
    expect(tile.entry(1).isTile).toBe(true);
    expect(tile.entry(1).isReplace).toBe(true);

    const sink = fixture("sink_ratebox.casv");
    const flags = parseCasvRateBox(sink);
    expect(flags).not.toBeNull();
    const rate = rateFromFlags(flags!);
    expect(rate.lossy).toBe(true);
    expect(rate.distance).toBe(1.0);
    // Footer-shape parse works through the same reader.
    const reader = CasvReader.parse(sink);
    expect(reader.frameCount).toBe(manifest["sink_ratebox"]!.frames);
    expect(reader.rate.distance).toBe(1.0);
  });

  test("reuseBuffer playback yields the same pixels as copying playback", async () => {
    if (!(await modulePromise)) return;
    const bytes = fixture("tile_v2.casv");
    const copied = await decodeCasvAll(bytes, decodeJxl);
    const reusedLast: Uint8Array[] = [];
    for await (const f of playCasv(bytes, decodeJxl, { reuseBuffer: true })) {
      reusedLast.push(f.rgba.slice()); // snapshot: the buffer is reused
    }
    expect(reusedLast.length).toBe(copied.length);
    for (let i = 0; i < copied.length; i++) {
      expect(Buffer.compare(reusedLast[i]!, copied[i]!.rgba)).toBe(0);
    }
  });

  test("fable-flagged files without a session are rejected", async () => {
    const bytes = fixture("tile_v2.casv").slice();
    // Set the Fable bit in the header flags word (bytes 28..32 LE).
    bytes[28] = bytes[28]! | CASV_HDR_FABLE_FLAG;
    // No fableSession provided → clear error (not a silent JXL-decode attempt).
    await expect(decodeCasvAll(bytes, decodeJxl)).rejects.toThrow(/fableSession/);
  });

  test("fable-flagged files play through an injected FableSession (K6#4)", async () => {
    const bytes = fixture("tile_v2.casv").slice();
    bytes[28] = bytes[28]! | CASV_HDR_FABLE_FLAG;
    const reader = CasvReader.parse(bytes);
    const { width, height } = reader.header;
    const rgbBytes = width * height * 3;
    let intra = 0;
    let delta = 0;
    // Mock session: verifies playFable routes intra→frame 0, delta→P-frames with
    // the previous RGB8 as `prev`. Payload content is irrelevant to the routing.
    const factory = () => ({
      decodeIntra(_b: Uint8Array): Uint8Array {
        intra++;
        return new Uint8Array(rgbBytes).fill(7);
      },
      decodeDelta(_b: Uint8Array, prev: Uint8Array, w: number, h: number): Uint8Array {
        delta++;
        expect(prev.length).toBe(rgbBytes); // prev = session's previous RGB8
        expect(w).toBe(width);
        expect(h).toBe(height);
        return new Uint8Array(rgbBytes).fill(9);
      },
    });
    // Expected routing is per-entry: I-frames (isPFrame=false) → decodeIntra,
    // P-frames → decodeDelta. The fixture may carry periodic keyframes.
    let expIntra = 0;
    let expDelta = 0;
    for (let i = 0; i < reader.frameCount; i++) {
      if (reader.entry(i).isPFrame) expDelta++;
      else expIntra++;
    }
    const indices: number[] = [];
    let firstPixel = -1;
    for await (const f of playCasv(bytes, decodeJxl, { fableSession: factory })) {
      expect(f.rgba.length).toBe(width * height * 4);
      expect(f.rgba[3]).toBe(255); // alpha filled by rgb8ToRgba
      if (f.index === 0) firstPixel = f.rgba[0]!;
      indices.push(f.index);
    }
    expect(indices).toEqual(Array.from({ length: reader.frameCount }, (_, i) => i));
    expect(intra).toBe(expIntra);
    expect(delta).toBe(expDelta);
    expect(intra).toBeGreaterThanOrEqual(1); // at least frame 0
    expect(firstPixel).toBe(7); // frame 0 is an I-frame → decodeIntra (7)
  });

  test("residual (non-REPLACE) P-frames are rejected with a clear error", async () => {
    if (!(await modulePromise)) return;
    const bytes = fixture("bbox.casv").slice();
    // Clear the REPLACE bit of frame 1's index entry (header at 32, entry 1 at
    // 32 + 8; len|flags field at +4; REPLACE is bit 28 → byte 3 of the field).
    const flagByte = 32 + 8 + 4 + 3;
    expect(bytes[flagByte]! & (CASV_REPLACE_FLAG >>> 24)).not.toBe(0);
    bytes[flagByte] = bytes[flagByte]! & ~(CASV_REPLACE_FLAG >>> 24);
    await expect(decodeCasvAll(bytes, decodeJxl)).rejects.toThrow(/residual/);
  });
});
