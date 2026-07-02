import { afterEach, describe, expect, test } from "bun:test";
import { createDecoder, createEncoder, setJxlModuleFactoryForTesting } from "../src/index";

// Regression tests for the encode_rgba8_with_metadata argument shift:
// the bridge signature is (..., buffering, group_order, resampling, icc, ...)
// but the facade used to omit group_order/resampling, shifting every
// metadata pointer two slots left (ICC landed in group_order, XMP dropped).
// These tests run against the real shipped scalar dist.

async function loadRealModule(): Promise<any | null> {
  try {
    const imported = await import("../dist/jxl-core.scalar.js");
    if (typeof imported.default !== "function") return null;
    const baseUrl = new URL("../dist/", import.meta.url);
    const module = await imported.default({
      locateFile: (path: string) => new URL(path, baseUrl).href,
    });
    if (module && typeof module._malloc === "function") return module;
  } catch {}
  return null;
}

const baseEncodeOptions = {
  format: "rgba8" as const,
  width: 8,
  height: 8,
  hasAlpha: false,
  iccProfile: null,
  exif: null,
  xmp: null,
  distance: null,
  quality: 90,
  effort: 3 as const,
  progressive: false,
  previewFirst: false,
  chunked: false,
};

function makePixels(): Uint8Array {
  const px = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < 64; i++) {
    px[i * 4] = (i * 3) & 0xff;
    px[i * 4 + 1] = (i * 7) & 0xff;
    px[i * 4 + 2] = (i * 11) & 0xff;
    px[i * 4 + 3] = 255;
  }
  return px;
}

async function collect(encoder: ReturnType<typeof createEncoder>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of encoder.chunks()) {
    parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

describe("encode metadata arg alignment (shipped dist)", () => {
  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  test("bridge exports match the facade call arity", async () => {
    const module = await loadRealModule();
    if (!module) return; // dist unavailable in this environment
    // 19 params: pixels,w,h,distance,effort,fmt,hasAlpha,pdc,pac,qpac,buffering,groupOrder,resampling,icc,iccSize,exif,exifSize,xmp,xmpSize
    expect(module._jxl_wasm_encode_rgba8_with_metadata.length).toBe(19);
    // 12 params: pixels,w,h,distance,effort,hasAlpha,pdc,pac,qpac,buffering,groupOrder,resampling
    expect(module._jxl_wasm_encode_rgba8.length).toBe(12);
  });

  test("XMP survives a buffered metadata encode and stream stays decodable", async () => {
    const module = await loadRealModule();
    if (!module) return;
    setJxlModuleFactoryForTesting(async () => module);

    const marker = `JXLWASM-ARGSHIFT-MARKER-${"x".repeat(16)}`;
    const xmp = new TextEncoder().encode(
      `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/">${marker}</x:xmpmeta>`
    );

    const encoder = createEncoder({ ...baseEncodeOptions, xmp });
    await encoder.pushPixels(makePixels());
    encoder.finish();
    const encoded = await collect(encoder);
    await encoder.dispose();

    expect(encoded.byteLength).toBeGreaterThan(0);
    // "xml " box is added uncompressed (compress_boxes defaults off), so the
    // marker must appear verbatim. Before the fix the xmp pointer/size slots
    // received 0/0 and the box was silently dropped.
    expect(contains(encoded, new TextEncoder().encode(marker))).toBe(true);

    // The stream must decode to the original dimensions (a shifted ICC pointer
    // used to land in group_order/resampling and could corrupt the encode).
    const decoder = createDecoder({
      format: "rgba8",
      region: null,
      downsample: 1,
      progressionTarget: "final",
      emitEveryPass: false,
      preserveIcc: false,
      preserveMetadata: false,
    });
    decoder.push(encoded);
    decoder.close();
    let sawFinal = false;
    for await (const ev of decoder.events()) {
      if (ev.type === "error") throw new Error(ev.message);
      if (ev.type === "final") {
        sawFinal = true;
        expect(ev.info.width).toBe(8);
        expect(ev.info.height).toBe(8);
      }
    }
    expect(sawFinal).toBe(true);
  });

  test("control: encode without metadata does not emit the marker", async () => {
    const module = await loadRealModule();
    if (!module) return;
    setJxlModuleFactoryForTesting(async () => module);

    const encoder = createEncoder({ ...baseEncodeOptions });
    await encoder.pushPixels(makePixels());
    encoder.finish();
    const encoded = await collect(encoder);
    await encoder.dispose();

    expect(encoded.byteLength).toBeGreaterThan(0);
    expect(contains(encoded, new TextEncoder().encode("ARGSHIFT-MARKER"))).toBe(false);
  });
});
