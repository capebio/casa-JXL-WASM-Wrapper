import { afterEach, describe, expect, it, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createDecoder,
  createEncoder,
  ButteraugliComparator,
  CapabilityMissing,
  detectTier,
  decodeTileContainerRegionRgba16,
  encodeTileContainerRgba16,
  setJxlModuleFactoryForTesting,
  normalizedToPixelExtent,
  pixelToNormalizedExtent,
  getWrapperCapabilities,
  getDecodeGridInfo,
  decodeViewport,
  JxlFrameSetting,
} from "../src/index";

// Types under test for extra-channel Phase 2 live in the facade (not yet re-exported via index).
import type { ExtraChannel, EncoderOptions } from "../src/facade";
import { computeButteraugli, extractJpegReconstructionFromJxl, serializeExtraChannelsForWasm, EC_BYTES } from "../src/facade";

const decodeOptions = {
  format: "rgba8" as const,
  region: null,
  downsample: 1 as const,
  progressionTarget: "final" as const,
  emitEveryPass: false,
  preserveIcc: true,
  preserveMetadata: true,
};

const encodeOptions = {
  format: "rgba8" as const,
  width: 1,
  height: 1,
  hasAlpha: true,
  iccProfile: null,
  exif: null,
  xmp: null,
  distance: null,
  quality: null,
  effort: 7 as const,
  progressive: false,
  previewFirst: false,
  chunked: false,
};

describe("@casabio/jxl-wasm facade", () => {
  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  test("package facade does not depend on temporary icodec or jsquash bridges", () => {
    const source = readFileSync(new URL("../src/facade.ts", import.meta.url), "utf8");
    const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");

    expect(source).not.toContain("icodec");
    expect(source).not.toContain("jsquash");
    expect(manifest).not.toContain("icodec");
    expect(manifest).not.toContain("jsquash");
  });

  test("drops JS-side staging queues after bytes move into WASM", () => {
    const source = readFileSync(new URL("../src/facade.ts", import.meta.url), "utf8");

    expect(source).toContain("this.pixelChunks = []");
    expect(source).toContain("allChunks.length = 0");
  });

  test("viewport helper chooses power-of-two downsample from region and target size", () => {
    const source = readFileSync(new URL("../src/facade.ts", import.meta.url), "utf8");

    expect(source).toContain("function pickDownsample(");
    expect(source).toContain("sourceWidth?: number | null;");
    expect(source).toContain("sourceHeight?: number | null;");
    expect(source).toContain("Math.ceil(sourceLongEdge / factor) >= targetLongEdge");
  });

  test("forwards progressive encode settings into the WASM bridge instead of rejecting them", () => {
    const source = readFileSync(new URL("../src/facade.ts", import.meta.url), "utf8");

    expect(source).toContain("function resolveEncoderBridgeSettings");
    expect(source).toContain("progressiveFlavor?: \"dc\" | \"ac\";");
    expect(source).not.toContain("Progressive JXL encode requires a rebuilt WASM with a progressive bridge flag");
  });

  test("chunks waits for in-flight streaming pixel pushes", async () => {
    setJxlModuleFactoryForTesting(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return createFakeStreamingInputLibjxlModule();
    });

    const encoder = createEncoder({ ...encodeOptions, quality: 90 });
    void encoder.pushPixels(new Uint8Array([255, 0, 0, 255]));
    encoder.finish();

    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();
    expect(encoded.done).toBe(false);
    expect(Array.from(new Uint8Array(encoded.value))).toEqual([255, 0, 0, 255]);
    await encoder.dispose();
  });

  test("streaming input path writes directly into WASM pixels when bridge exposes direct-write hooks", async () => {
    const module = createFakeStreamingInputLibjxlModule();
    setJxlModuleFactoryForTesting(async () => module);

    const encoder = createEncoder({ ...encodeOptions, quality: 90 });
    const beforePushMallocs = module.__mallocCalls;
    await encoder.pushPixels(new Uint8Array([255, 0, 0, 255]));
    expect(module.__mallocCalls).toBe(beforePushMallocs);

    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();
    expect(encoded.done).toBe(false);
    expect(Array.from(new Uint8Array(encoded.value))).toEqual([255, 0, 0, 255]);
    await encoder.dispose();
  });

  test("streaming rgba16 encode does not require legacy rgba16 encode export", async () => {
    const module = createFakeStreamingInputLibjxlModule() as any;
    delete module._jxl_wasm_encode_rgba16;
    setJxlModuleFactoryForTesting(async () => module);

    const encoder = createEncoder({ ...encodeOptions, format: "rgba16", quality: 90 });
    await encoder.pushPixels(new Uint8Array([255, 0, 0, 0, 0, 0, 255, 255]));
    encoder.finish();

    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();
    expect(encoded.done).toBe(false);
    expect(Array.from(new Uint8Array(encoded.value))).toEqual([255, 0, 0, 0, 0, 0, 255, 255]);
    await encoder.dispose();
  });

  test("buffered rgba16 encode still requires legacy rgba16 encode export", async () => {
    const module = createFakeLibjxlModule() as any;
    delete module._jxl_wasm_encode_rgba16;
    setJxlModuleFactoryForTesting(async () => module);

    const encoder = createEncoder({
      ...encodeOptions,
      format: "rgba16",
      quality: 90,
      iccProfile: null,
      sidecarSizes: [1],
    });
    await encoder.pushPixels(new Uint8Array([255, 0, 0, 0, 0, 0, 255, 255]));
    encoder.finish();

    await expect(async () => {
      for await (const _chunk of encoder.chunks()) {}
    }).toThrow(CapabilityMissing);
    await encoder.dispose();
  });

  test("ButteraugliComparator uploads reference once and frees it on dispose", async () => {
    const module = createFakeLibjxlModule() as any;
    const uploads: number[] = [];
    const originalSet = module.HEAPU8.set.bind(module.HEAPU8);
    module.HEAPU8.set = (source: ArrayLike<number>, offset?: number) => {
      uploads.push(source.length);
      originalSet(source, offset);
    };
    module._jxl_wasm_butteraugli_compare = () => {
      const f = new ArrayBuffer(4);
      new Float32Array(f)[0] = 1.5;
      return new Int32Array(f)[0]!;
    };
    setJxlModuleFactoryForTesting(async () => module);

    const comparator = await ButteraugliComparator.create(new Uint8Array([1, 2, 3, 4]), 1, 1);
    expect(comparator.compare(new Uint8Array([5, 6, 7, 8]))).toBe(1.5);
    expect(comparator.compare(new Uint8Array([9, 10, 11, 12]))).toBe(1.5);
    comparator.dispose();

    expect(uploads).toEqual([4, 4, 4]);
    expect(module.__allocations.size).toBe(0);
  });

  test("computeButteraugli still frees both temporary image buffers", async () => {
    const module = createFakeLibjxlModule() as any;
    module._jxl_wasm_butteraugli_compare = () => 0;
    setJxlModuleFactoryForTesting(async () => module);

    await computeButteraugli(new Uint8Array(4), new Uint8Array(4), 1, 1);

    expect(module.__allocations.size).toBe(0);
  });

  test("JXTC JPEG extraction ignores SOI and EOI markers inside tile payloads", () => {
    const tilePayload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    const jxtc = new Uint8Array(32 + 8 + tilePayload.byteLength);
    const dv = new DataView(jxtc.buffer);
    dv.setUint32(0, 0x4354584a, true);
    dv.setUint32(4, 1, true);
    dv.setUint32(8, 1, true);
    dv.setUint32(12, 1, true);
    dv.setUint32(16, 1, true);
    dv.setUint32(20, 1, true);
    dv.setUint32(24, 1, true);
    dv.setUint32(32, 40, true);
    dv.setUint32(36, tilePayload.byteLength, true);
    jxtc.set(tilePayload, 40);

    expect(extractJpegReconstructionFromJxl(jxtc)).toBeNull();
  });

  test("JPEG extraction returns a copied view when a valid JPEG exists outside tile payloads", () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xdb, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xd9,
    ]);
    const jxtc = new Uint8Array(32 + 8 + jpeg.byteLength + 4);
    const dv = new DataView(jxtc.buffer);
    dv.setUint32(0, 0x4354584a, true);
    dv.setUint32(4, 1, true);
    dv.setUint32(8, 1, true);
    dv.setUint32(12, 1, true);
    dv.setUint32(16, 1, true);
    dv.setUint32(20, 1, true);
    dv.setUint32(24, 1, true);
    dv.setUint32(32, jxtc.byteLength - 4, true);
    dv.setUint32(36, 4, true);
    jxtc.set(jpeg, 40);

    const extracted = extractJpegReconstructionFromJxl(jxtc);
    expect(Array.from(extracted ?? [])).toEqual(Array.from(jpeg));
    jxtc[40] = 0;
    expect(extracted?.[0]).toBe(0xff);
  });

  test("JPEG extraction handles SOS (Start of Scan) marker with entropy data correctly", () => {
    // Build a realistic JPEG with SOS marker and entropy-encoded data.
    // Structure: SOI + APP0 + DQT + SOF + DHT + SOS + entropy + EOI
    const jpeg = new Uint8Array([
      // SOI (Start of Image)
      0xff, 0xd8,
      // APP0 (JFIF)
      0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      // DQT (Quantization Table)
      0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32,
      // SOF0 (Start of Frame, Baseline DCT)
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
      // DHT (Huffman Table)
      0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
      // SOS (Start of Scan) — this is the marker being tested
      0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
      // Entropy-encoded data (compressed image data)
      // This includes 0xFF bytes that are part of the data, not markers.
      // A real JPEG entropy has MCU-encoded data. We simulate with data containing 0xFF escapes.
      0x7f, 0xff, 0x00, 0x7f, 0xff, 0x00, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xff, 0x00, 0xf0,
      // EOI (End of Image)
      0xff, 0xd9,
    ]);

    const jxtc = new Uint8Array(32 + 8 + jpeg.byteLength + 4);
    const dv = new DataView(jxtc.buffer);
    dv.setUint32(0, 0x4354584a, true); // JXTC magic
    dv.setUint32(4, 1, true); // version
    dv.setUint32(8, 1, true); // tileSize
    dv.setUint32(12, 1, true); // tilesX
    dv.setUint32(16, 1, true); // tilesY
    dv.setUint32(20, 1, true); // tileWidth
    dv.setUint32(24, 1, true); // tileHeight
    // Tile index: one tile
    dv.setUint32(32, jxtc.byteLength - 4, true); // offset to JPEG
    dv.setUint32(36, 4, true); // length (dummy, JPEG starts at offset)
    jxtc.set(jpeg, 40);

    const extracted = extractJpegReconstructionFromJxl(jxtc);
    expect(extracted).not.toBeNull();
    expect(Array.from(extracted ?? [])).toEqual(Array.from(jpeg));
  });

  test("streaming advanced settings allocate only when create_image_adv consumes them", async () => {
    const module = createFakeStreamingInputLibjxlModule() as any;
    let mallocsBeforeCreate = 0;
    let createAdvCalled = false;
    module._jxl_wasm_enc_create_image_adv = (
      width: number,
      height: number,
      _distance: number,
      _effort: number,
      _fmt: number,
      _hasAlpha: number,
      _progressiveDc: number,
      _progressiveAc: number,
      _qProgressiveAc: number,
      _buffering: number,
      idsPtr: number,
      valuesPtr: number,
      count: number,
    ) => {
      mallocsBeforeCreate = module.__mallocCalls;
      createAdvCalled = true;
      expect(idsPtr).not.toBe(0);
      expect(valuesPtr).not.toBe(0);
      expect(count).toBe(1);
      return module._jxl_wasm_enc_create_image(width, height);
    };
    setJxlModuleFactoryForTesting(async () => module);

    const encoder = createEncoder({
      ...encodeOptions,
      advancedFrameSettings: [{ id: JxlFrameSetting.PATCHES, value: 1 }],
      quality: 90,
    });
    await encoder.pushPixels(new Uint8Array([255, 0, 0, 255]));
    encoder.finish();
    for await (const _chunk of encoder.chunks()) {}

    expect(createAdvCalled).toBe(true);
    expect(mallocsBeforeCreate).toBe(2);
    expect(module.__allocations.size).toBe(0);
  });

  test("streaming Y settings do not allocate unused advanced setting arrays", async () => {
    const module = createFakeStreamingInputLibjxlModule() as any;
    module._jxl_wasm_enc_create_image_y = module._jxl_wasm_enc_create_image;
    setJxlModuleFactoryForTesting(async () => module);

    const encoder = createEncoder({
      ...encodeOptions,
      advancedFrameSettings: [{ id: JxlFrameSetting.PATCHES, value: 1 }],
      epf: 1,
      quality: 90,
    });
    await encoder.pushPixels(new Uint8Array([255, 0, 0, 255]));

    expect(module.__mallocCalls).toBe(0);
    encoder.cancel();
  });

  test("extra channel serialization reuses one TextEncoder instance", () => {
    const source = readFileSync(new URL("../src/facade.ts", import.meta.url), "utf8");

    expect(source).toContain("const TEXT_ENCODER = new TextEncoder();");
    expect(source).not.toContain("new TextEncoder().encode");
  });

  test("encodes and decodes rgba8 pixels through the WASM codec facade", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const rgba = new Uint8Array([255, 0, 0, 255]);
    const encoder = createEncoder({ ...encodeOptions, quality: 90 });
    encoder.pushPixels(rgba);
    encoder.finish();

    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();
    expect(encoded.done).toBe(false);
    expect(encoded.value.byteLength).toBeGreaterThan(0);
    await encoder.dispose();

    const decoder = createDecoder(decodeOptions);
    decoder.push(encoded.value);
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({
      type: "header",
      info: { width: 1, height: 1, bitsPerSample: 8, hasAlpha: true },
    });
    expect(events[1]).toMatchObject({
      type: "final",
      info: { width: 1, height: 1 },
      format: "rgba8",
      pixelStride: 4,
    });
    expect(events[1]?.type === "final" ? events[1].pixels.byteLength : 0).toBe(4);
    await decoder.dispose();
  });

  test("encodes and decodes rgba16 tile containers with byte-oriented buffers", async () => {
    const module = createFakeLibjxlModule();
    setJxlModuleFactoryForTesting(async () => module);

    const input = new Uint8Array([
      0x34, 0x12, 0x78, 0x56, 0xbc, 0x9a, 0xff, 0x7f,
      0xaa, 0x55, 0x11, 0x22, 0x44, 0x33, 0x88, 0x66,
    ]);

    const container = await encodeTileContainerRgba16(input, 2, 1, { tileSize: 1, distance: 0 });
    expect(container).toEqual(input);

    const { pixels, width, height } = await decodeTileContainerRegionRgba16(container, { x: 0, y: 0, w: 2, h: 1 });
    expect(width).toBe(2);
    expect(height).toBe(1);
    expect(Array.from(pixels)).toEqual(Array.from(input));
  });

  test("honors header-only decode target", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const rgba = new Uint8Array([0, 255, 0, 255]);
    const encoder = createEncoder(encodeOptions);
    encoder.pushPixels(rgba);
    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();

    const decoder = createDecoder({ ...decodeOptions, progressionTarget: "header" });
    decoder.push(encoded.value);
    decoder.close();
    const events = [];
    for await (const event of decoder.events()) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "header", info: { width: 1, height: 1 } });
    await encoder.dispose();
    await decoder.dispose();
  });

  test("emits a dc progress event when the decode target stops early", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const encoder = createEncoder(encodeOptions);
    encoder.pushPixels(new Uint8Array([255, 255, 255, 255]));
    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();

    const decoder = createDecoder({ ...decodeOptions, progressionTarget: "dc" });
    decoder.push(encoded.value);
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["header", "progress"]);
    expect(events[1]).toMatchObject({ type: "progress", stage: "dc", format: "rgba8", pixelStride: 4 });
    await encoder.dispose();
    await decoder.dispose();
  });

  test("emits a progress event when emitEveryPass is enabled", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const encoder = createEncoder(encodeOptions);
    encoder.pushPixels(new Uint8Array([255, 0, 255, 255]));
    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();

    const decoder = createDecoder({ ...decodeOptions, emitEveryPass: true });
    decoder.push(encoded.value);
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["header", "progress", "final"]);
    expect(events[1]).toMatchObject({ type: "progress", stage: "pass", format: "rgba8", pixelStride: 4 });
    await encoder.dispose();
    await decoder.dispose();
  });

  test("advancedFrameSettings escape hatch (PATCHES) is accepted without throwing", () => {
    const encoder = createEncoder({
      ...encodeOptions,
      advancedFrameSettings: [
        { id: JxlFrameSetting.PATCHES, value: 1 }
      ]
    });
    expect(encoder).toBeDefined();
    void encoder.dispose();
  });

  test("advancedFrameSettings + PATCHES on synthetic repeating content (smoke + size check)", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);

    // Very friendly content for patches: large flat regions + repeating patterns
    const size = 64;
    const rgba = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const on = ((x >> 3) + (y >> 3)) & 1;
        const v = on ? 200 : 50;
        rgba[i] = v; rgba[i+1] = v; rgba[i+2] = v; rgba[i+3] = 255;
      }
    }

    const base = await (async () => {
      const enc = createEncoder({ ...encodeOptions, width: size, height: size, quality: 85, effort: 5 });
      enc.pushPixels(rgba);
      enc.finish();
      const chunks: Uint8Array[] = [];
      for await (const c of enc.chunks()) chunks.push(new Uint8Array(c));
      await enc.dispose();
      return chunks.reduce((a, b) => a + b.byteLength, 0);
    })();

    const withPatches = await (async () => {
      const enc = createEncoder({
        ...encodeOptions,
        width: size,
        height: size,
        quality: 85,
        effort: 5,
        advancedFrameSettings: [{ id: JxlFrameSetting.PATCHES, value: 1 }]
      });
      enc.pushPixels(rgba);
      enc.finish();
      const chunks: Uint8Array[] = [];
      for await (const c of enc.chunks()) chunks.push(new Uint8Array(c));
      await enc.dispose();
      return chunks.reduce((a, b) => a + b.byteLength, 0);
    })();

    expect(withPatches).toBeGreaterThan(0);
    console.log(`[patches smoke] base=${base}B  withPatches=${withPatches}B`);
  });

  test("progressive decoder emits a flush before input is closed", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeProgressiveLibjxlModule());

    const decoder = createDecoder({ ...decodeOptions, emitEveryPass: true });
    const iterator = decoder.events()[Symbol.asyncIterator]();

    decoder.push(new Uint8Array([1, 2, 3, 4]).buffer);

    const header = await nextWithin(iterator, 100);
    const progress = await nextWithin(iterator, 100);

    expect(header.value).toMatchObject({ type: "header", info: { width: 1, height: 1 } });
    expect(progress.value).toMatchObject({ type: "progress", stage: "dc", format: "rgba8", pixelStride: 4 });

    decoder.close();
    const final = await nextWithin(iterator, 100);
    expect(final.value).toMatchObject({ type: "final", info: { width: 1, height: 1 }, format: "rgba8" });
    await decoder.dispose();
  });

  test("progressive decoder drains multiple passes from one pushed chunk", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeDrainingProgressiveLibjxlModule());

    const decoder = createDecoder({ ...decodeOptions, emitEveryPass: true });
    const iterator = decoder.events()[Symbol.asyncIterator]();

    decoder.push(new Uint8Array([1, 2, 3, 4]).buffer);

    const header = await nextWithin(iterator, 100);
    const progressA = await nextWithin(iterator, 100);
    const progressB = await nextWithin(iterator, 100);

    expect(header.value).toMatchObject({ type: "header", info: { width: 1, height: 1 } });
    expect(progressA.value).toMatchObject({ type: "progress", stage: "dc" });
    expect(progressB.value).toMatchObject({ type: "progress", stage: "pass" });

    decoder.close();
    const final = await nextWithin(iterator, 100);
    expect(final.value).toMatchObject({ type: "final", info: { width: 1, height: 1 }, format: "rgba8" });
    await decoder.dispose();
  });

  test("progressive decoder copies flushed pixels before freeing WASM handle", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeFreedViewProgressiveLibjxlModule());

    const decoder = createDecoder({ ...decodeOptions, emitEveryPass: true });
    const iterator = decoder.events()[Symbol.asyncIterator]();

    decoder.push(new Uint8Array([1, 2, 3, 4]).buffer);

    await nextWithin(iterator, 100); // header
    const progress = await nextWithin(iterator, 100);

    expect(progress.value).toMatchObject({ type: "progress", stage: "dc", format: "rgba8" });
    expect(Array.from(new Uint8Array((progress.value as any).pixels))).toEqual([9, 8, 7, 6]);

    decoder.close();
    await decoder.dispose();
  });

  test("full-frame target sizing auto-selects downsample once progressive header dimensions are known", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeMeasuredProgressiveLibjxlModule());

    const decoder = createDecoder({
      ...decodeOptions,
      emitEveryPass: true,
      targetWidth: 16,
      targetHeight: 16,
      downsample: undefined,
    });
    const events = [];
    decoder.push(new Uint8Array([1, 2, 3, 4]).buffer);
    decoder.close();
    for await (const event of decoder.events()) {
      events.push(event);
    }

    const progress = events.find((event) => event.type === "progress") as any;
    expect(progress?.sourceScale).toBe(8);
    await decoder.dispose();
  });

  test("progressive decoder keeps draining after close when final bytes first yield progress", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeCloseDrainProgressiveLibjxlModule());

    const decoder = createDecoder({ ...decodeOptions, emitEveryPass: true });
    const iterator = decoder.events()[Symbol.asyncIterator]();

    decoder.push(new Uint8Array([1, 2, 3, 4]).buffer);

    const header = await nextWithin(iterator, 100);
    const progress = await nextWithin(iterator, 100);
    expect(header.value).toMatchObject({ type: "header", info: { width: 1, height: 1 } });
    expect(progress.value).toMatchObject({ type: "progress", stage: "dc" });

    decoder.close();
    const closeProgress = await nextWithin(iterator, 100);
    const final = await nextWithin(iterator, 100);

    expect(closeProgress.value).toMatchObject({ type: "progress", stage: "pass" });
    expect(final.value).toMatchObject({ type: "final", info: { width: 1, height: 1 }, format: "rgba8" });
    await decoder.dispose();
  });

  test("progressive rgba16 reports 16 bits and works without legacy rgba16 decode export", async () => {
    setJxlModuleFactoryForTesting(async () => {
      const module = createFakeProgressiveLibjxlModule() as any;
      delete module._jxl_wasm_decode_rgba16;
      module._jxl_wasm_dec_create = (_fmt: number) => 1;
      module._jxl_wasm_dec_take_flushed = () => module.__makeHandle(new Uint8Array(8), 1, 1, 16);
      module._jxl_wasm_dec_take_final = () => module.__makeHandle(new Uint8Array(8), 1, 1, 16);
      return module;
    });

    const decoder = createDecoder({ ...decodeOptions, format: "rgba16", emitEveryPass: true });
    decoder.push(new Uint8Array([1, 2, 3, 4]));
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) events.push(event);

    expect(events.map((event) => event.type)).not.toContain("error");
    expect(events.find((event) => event.type === "header")).toMatchObject({ info: { bitsPerSample: 16 } });
    expect(events.find((event) => event.type === "progress")).toMatchObject({ info: { bitsPerSample: 16 }, pixelStride: 8 });
    expect(events.find((event) => event.type === "final")).toMatchObject({ info: { bitsPerSample: 16 }, pixelStride: 8 });
    await decoder.dispose();
  });

  test("progressive transform reads decoded buffers without full-frame slice copy", async () => {
    const module = createFakeProgressiveLibjxlModule() as any;
    let sliceCalls = 0;
    module.HEAPU8 = new Proxy(module.HEAPU8, {
      get(target, prop, receiver) {
        if (prop === "slice") {
          return (...args: [number?, number?]) => {
            sliceCalls++;
            return Uint8Array.prototype.slice.apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    module._jxl_wasm_dec_width = () => 2;
    module._jxl_wasm_dec_height = () => 1;
    module._jxl_wasm_dec_take_flushed = () => module.__makeHandle(new Uint8Array(8), 2, 1);
    module._jxl_wasm_dec_take_final = () => module.__makeHandle(new Uint8Array(8), 2, 1);
    setJxlModuleFactoryForTesting(async () => module);

    const decoder = createDecoder({ ...decodeOptions, region: { x: 0, y: 0, w: 1, h: 1 }, emitEveryPass: true });
    decoder.push(new Uint8Array([1, 2, 3, 4]));
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) events.push(event);

    expect(events.map((event) => event.type)).not.toContain("error");
    expect(events.map((event) => event.type)).toContain("final");
    expect(sliceCalls).toBe(0);
    await decoder.dispose();
  });

  test("push after decoder events complete is ignored", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeProgressiveLibjxlModule());

    const decoder = createDecoder({ ...decodeOptions, progressionTarget: "header" });
    decoder.push(new Uint8Array([1, 2, 3, 4]));

    const events = [];
    for await (const event of decoder.events()) events.push(event);
    decoder.push(new Uint8Array([5, 6, 7, 8]));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "header" });
    expect((decoder as any).chunkQueue).toHaveLength(0);
    expect((decoder as any).queuedBytes).toBe(0);
    await decoder.dispose();
  });

  test("decoder cancel prevents event generation", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeProgressiveLibjxlModule());
    const decoder = createDecoder(decodeOptions);

    decoder.cancel("prevent generation");
    const iterator = decoder.events()[Symbol.asyncIterator]();
    const result = await nextWithin(iterator, 100);
    expect(result.done).toBe(true);

    await decoder.dispose();
  });

  test("encoder cancel prevents chunk generation", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const encoder = createEncoder({ ...encodeOptions, quality: 90 });

    encoder.cancel("prevent generation");
    const chunksIter = encoder.chunks()[Symbol.asyncIterator]();
    const result = await nextWithin(chunksIter, 100);
    expect(result.done).toBe(true);

    await encoder.dispose();
  });

  test("decoder fallback to oneshot when progressive unavailable", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeLibjxlModule());
    const rgba = new Uint8Array([0, 255, 0, 255]);
    const encoder = createEncoder(encodeOptions);
    encoder.pushPixels(rgba);
    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();

    const decoder = createDecoder(decodeOptions);
    decoder.push(encoded.value);
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) {
      events.push(event);
    }

    expect(events.map((e) => e.type)).toContain("final");
    expect(events.map((e) => e.type)).not.toContain("error");
    await encoder.dispose();
    await decoder.dispose();
  });

  test("decoder defaults region to null and downsample to 1 when omitted", async () => {
    setJxlModuleFactoryForTesting(async () => createFakeLibjxlModule());
    const decoder = createDecoder({
      format: "rgba8",
      progressionTarget: "final",
      emitEveryPass: false,
      preserveIcc: true,
      preserveMetadata: true,
    });

    decoder.push(new Uint8Array([1, 2, 3, 4]));
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain("final");
    expect(events.map((event) => event.type)).not.toContain("error");
    await decoder.dispose();
  });

  test("encodes with ICC profile, EXIF, and XMP metadata", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const rgba = new Uint8Array([255, 128, 64, 255]);
    // Real profile required: since the metadata arg-shift fix the ICC bytes
    // actually reach JxlEncoderSetICCProfile, which rejects garbage. (The old
    // 4-byte dummy only "worked" because the shifted call dropped it.)
    let iccProfile: Uint8Array | null = null;
    try {
      iccProfile = new Uint8Array(
        readFileSync(new URL("../../../external/libjxl/third_party/skcms/profiles/color.org/sRGB2014.icc", import.meta.url))
      );
    } catch {
      iccProfile = null; // fixture unavailable — still exercises EXIF/XMP path
    }
    const exif = new Uint8Array([5, 6, 7, 8]); // dummy EXIF
    const xmp = new Uint8Array([9, 10, 11, 12]); // dummy XMP

    const encoder = createEncoder({
      ...encodeOptions,
      quality: 90,
      iccProfile,
      exif,
      xmp,
    });
    encoder.pushPixels(rgba);
    encoder.finish();

    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();
    expect(encoded.done).toBe(false);
    expect(encoded.value.byteLength).toBeGreaterThan(0);
    await encoder.dispose();
  });

  test("simulated metadata _malloc===0 fallback completes encode with missing metadata (no crash)", async () => {
    // Use enhanced createFake (64k heap) + spy _malloc for aux OOM (exif 64B).
    // This exercises the guard in facade (see prepare/encode path) that detects 0 for
    // optional metadata, frees, warns, zeros sizes, and proceeds with pixels-only encode.
    const base = createFakeLibjxlModule() as any;
    const oomFor = new Set<number>([64]); // exif size triggers aux OOM
    const origMalloc = base._malloc.bind(base);
    base._malloc = (size: number) => {
      if (oomFor.has(size)) return 0;
      return origMalloc(size);
    };

    let sawMetadataFallback = false;
    base._jxl_wasm_encode_rgba8_with_metadata = (
      pixelsPtr: number, w: number, h: number,
      _d: number, _e: number, _f: number, _a: number,
      _pdc: number, _pac: number, _qp: number, _buf: number,
      _iccPtr: number, _iccSz: number,
      _exifPtr: number, exifSz: number,
      _xmpPtr: number, _xmpSz: number
    ) => {
      if (exifSz === 0) sawMetadataFallback = true;
      // Delegate to base rgba8 path (reuses its makeHandle + spied malloc for output handle data).
      // Simulates: caller guard passed 0 sizes for OOMed aux; we still produce valid output.
      return base._jxl_wasm_encode_rgba8(pixelsPtr, w, h, 0, 7);
    };
    base._jxl_wasm_buffer_error = (_h: number) => 0;

    setJxlModuleFactoryForTesting(async () => base);

    const rgba = new Uint8Array([9, 9, 9, 255]);
    const exif = new Uint8Array(64).fill(7); // triggers the OOM size in spied malloc
    const encoder = createEncoder({
      ...encodeOptions,
      width: 1,
      height: 1,
      quality: 90,
      exif,
    });
    encoder.pushPixels(rgba);
    encoder.finish();

    // Explicit: aux OOM must not hard-fail the encode; fallback must be taken; output valid.
    let thrown: unknown;
    const chunks: ArrayBuffer[] = [];
    try {
      for await (const c of encoder.chunks()) chunks.push(c);
      await encoder.dispose();
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeUndefined();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].byteLength).toBeGreaterThan(0);
    expect(sawMetadataFallback).toBe(true);
  });

  test("simulated core pixels _malloc===0 (main encode buffered path) causes fail-fast (no success with bad pointer)", async () => {
    // Spy returns 0 for core pixels size. The facade guards the buffered-pixels
    // malloc directly (if (ptr === 0) throw "WASM malloc failed for buffered
    // encode pixels"), so it fail-fasts before ever calling the encoder. The
    // fake encode also rejects 0-ptr as a backstop in case the guard is removed.
    // This verifies critical OOM on core pixels _malloc=0 leads to a hard error
    // (aux metadata paths gracefully fall back; core pixels must not).
    const base = createFakeLibjxlModule() as any;
    const pixelCoreSize = 4; // 1x1 rgba8
    const origMalloc = base._malloc.bind(base);
    base._malloc = (size: number) => {
      if (size === pixelCoreSize) return 0;
      return origMalloc(size);
    };

    const origEncode = base._jxl_wasm_encode_rgba8.bind(base);
    base._jxl_wasm_encode_rgba8 = (pixelsPtr: number, w: number, h: number, d: number, e: number) => {
      if (pixelsPtr === 0) throw new Error("WASM Memory Allocation OOM");
      return origEncode(pixelsPtr, w, h, d, e);
    };

    setJxlModuleFactoryForTesting(async () => base);

    const rgba = new Uint8Array([9, 9, 9, 255]);
    const encoder = createEncoder({ ...encodeOptions, width: 1, height: 1, quality: 90 });
    encoder.pushPixels(rgba);
    encoder.finish();

    let thrown: unknown;
    const chunks: ArrayBuffer[] = [];
    try {
      for await (const c of encoder.chunks()) chunks.push(c);
      await encoder.dispose();
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    const msg = String((thrown as any)?.message ?? thrown);
    // Facade fail-fasts at the buffered-pixels malloc guard, before the encoder
    // is invoked; assert that hard-error (not the encoder's backstop message).
    expect(msg).toContain("WASM malloc failed for buffered encode pixels");
  });
});

describe("detectTier", () => {
  test("returns a valid tier string", () => {
    const tier = detectTier();
    expect(["relaxed-simd-mt", "simd-mt", "simd", "scalar"]).toContain(tier);
  });

  test("caches the detected tier", () => {
    const tier = detectTier();
    expect(detectTier()).toBe(tier);
  });
});

describe("bilinear resize via targetWidth/targetHeight", () => {
  afterEach(() => {
    setJxlModuleFactoryForTesting(null);
  });

  test("stretch 2x1 image to 1x1 produces 1x1 output", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]); // 2x1
    const encoder = createEncoder({ ...encodeOptions, width: 2, height: 1 });
    encoder.pushPixels(rgba);
    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();

    const decoder = createDecoder({
      ...decodeOptions,
      targetWidth: 1,
      targetHeight: 1,
      fitMode: "stretch",
    });
    decoder.push(encoded.value);
    decoder.close();

    const events = [];
    for await (const event of decoder.events()) events.push(event);

    const final = events.find((e) => e.type === "final");
    expect(final).toBeDefined();
    if (final?.type === "final") {
      expect(final.info.width).toBe(1);
      expect(final.info.height).toBe(1);
      expect(final.pixels.byteLength).toBe(4); // 1x1 rgba8
    }
    await decoder.dispose();
    await encoder.dispose();
  });

  test("no resize when targetWidth/targetHeight absent", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]); // 2x2
    const encoder = createEncoder({ ...encodeOptions, width: 2, height: 2 });
    encoder.pushPixels(rgba);
    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();

    const decoder = createDecoder(decodeOptions);
    decoder.push(encoded.value);
    decoder.close();
    const events = [];
    for await (const event of decoder.events()) events.push(event);
    const final = events.find((e) => e.type === "final");
    expect(final).toBeDefined();
    if (final?.type === "final") {
      expect(final.info.width).toBe(2);
      expect(final.info.height).toBe(2);
    }
    await decoder.dispose();
    await encoder.dispose();
  });

  test("contain fit: 4x1 image to targetWidth:2 targetHeight:2 returns 2x1", async () => {
    setJxlModuleFactoryForTesting(loadPreferredLibjxlModule);
    const rgba = new Uint8Array(4 * 1 * 4).fill(128);
    const encoder = createEncoder({ ...encodeOptions, width: 4, height: 1 });
    encoder.pushPixels(rgba);
    encoder.finish();
    const encoded = await encoder.chunks()[Symbol.asyncIterator]().next();

    const decoder = createDecoder({
      ...decodeOptions,
      targetWidth: 2,
      targetHeight: 2,
      fitMode: "contain",
    });
    decoder.push(encoded.value);
    decoder.close();
    const events = [];
    for await (const event of decoder.events()) events.push(event);
    const final = events.find((e) => e.type === "final");
    expect(final).toBeDefined();
    if (final?.type === "final") {
      expect(final.info.width).toBe(2);
      expect(final.info.height).toBe(1);
    }
    await decoder.dispose();
    await encoder.dispose();
  });

  test("decodeViewport returns a JxlDecoder", () => {
    const decoder = decodeViewport({ format: "rgba8", targetWidth: 640, targetHeight: 480 });
    expect(decoder).toBeDefined();
    expect(typeof decoder.push).toBe("function");
    expect(typeof decoder.events).toBe("function");
    decoder.cancel();
  });
});

describe("normalizedToPixelExtent / pixelToNormalizedExtent", () => {
  test("full image normalized → full pixel rect", () => {
    const r = normalizedToPixelExtent({ x: 0, y: 0, w: 1, h: 1 }, 1920, 1080);
    expect(r).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  test("half image", () => {
    const r = normalizedToPixelExtent({ x: 0.25, y: 0, w: 0.5, h: 1 }, 1000, 500);
    expect(r).toEqual({ x: 250, y: 0, w: 500, h: 500 });
  });

  test("round-trip", () => {
    const region = { x: 100, y: 50, w: 200, h: 150 };
    const norm = pixelToNormalizedExtent(region, 1000, 500);
    const back = normalizedToPixelExtent(norm, 1000, 500);
    expect(back).toEqual(region);
  });

  test("w/h minimum is 1", () => {
    const r = normalizedToPixelExtent({ x: 0, y: 0, w: 0.0001, h: 0.0001 }, 10, 10);
    expect(r.w).toBeGreaterThanOrEqual(1);
    expect(r.h).toBeGreaterThanOrEqual(1);
  });
});

describe("getWrapperCapabilities", () => {
  test("returns synchronously with expected shape", () => {
    const caps = getWrapperCapabilities();
    expect(caps.regionDecode).toBe(true);
    expect(caps.exactSizeDecode).toBe(true);
    expect(caps.progressiveRegionDecode).toBe(false);
    expect(caps.tileAlignedRegionDecode).toBe(false);
    expect(caps.arbitraryRegionDecode).toBe(true);
    expect(caps.availableDownsampleFactors).toEqual([1, 2, 4, 8]);
  });
});

describe("getDecodeGridInfo", () => {
  test("returns empty object", () => {
    const info = getDecodeGridInfo();
    expect(info).toEqual({});
  });
});

function createFakeLibjxlModule() {
  // 65536 (was 4096) to prevent RangeError (offset out of limits / double size) on
  // HEAPU8.set/slice when structural tests allocate past tiny fixed heap under
  // monotonic nextPtr (pixels + output handles + sidecars + temps). Matches the
  // size already used in the aux OOM test. _malloc here never returns 0 by default;
  // tests that need OOM simulation wrap/spy it explicitly (aux metadata/adv vs critical).
  const memory = new ArrayBuffer(65536);
  const HEAPU8 = new Uint8Array(memory);
  const HEAP32 = new Int32Array(memory);
  const HEAPU32 = new Uint32Array(memory);
  let nextPtr = 64;
  const allocations = new Map<number, number>();
  const handles = new Map<number, { dataPtr: number; size: number; width: number; height: number; bits: number; alpha: number }>();
  let nextHandle = 1;

  const malloc = (size: number) => {
    const ptr = nextPtr;
    nextPtr += size + 8;
    allocations.set(ptr, size);
    return ptr;
  };

  const makeHandle = (bytes: Uint8Array, width: number, height: number, bits = 8) => {
    const dataPtr = malloc(bytes.byteLength);
    HEAPU8.set(bytes, dataPtr);
    const handle = nextHandle++;
    handles.set(handle, { dataPtr, size: bytes.byteLength, width, height, bits, alpha: 1 });
    return handle;
  };

  return {
    HEAPU8,
    HEAP32,
    HEAPU32,
    __allocations: allocations,
    _malloc: malloc,
    _free: (ptr: number) => allocations.delete(ptr),
    _jxl_wasm_encode_rgba8: (pixelsPtr: number, width: number, height: number, _distance: number, _effort: number) => {
      return makeHandle(HEAPU8.slice(pixelsPtr, pixelsPtr + width * height * 4), width, height);
    },
    _jxl_wasm_decode_rgba8: (inputPtr: number, inputSize: number, _downsample: number) => {
      return makeHandle(HEAPU8.slice(inputPtr, inputPtr + inputSize), 1, 1);
    },
    __makeHandle: makeHandle,
    _jxl_wasm_buffer_data: (handle: number) => handles.get(handle)?.dataPtr ?? 0,
    _jxl_wasm_buffer_size: (handle: number) => handles.get(handle)?.size ?? 0,
    _jxl_wasm_buffer_width: (handle: number) => handles.get(handle)?.width ?? 0,
    _jxl_wasm_buffer_height: (handle: number) => handles.get(handle)?.height ?? 0,
    _jxl_wasm_buffer_bits_per_sample: (handle: number) => handles.get(handle)?.bits ?? 8,
    _jxl_wasm_buffer_has_alpha: (handle: number) => handles.get(handle)?.alpha ?? 1,
    _jxl_wasm_buffer_free: (handle: number) => {
      const entry = handles.get(handle);
      if (entry) allocations.delete(entry.dataPtr);
      handles.delete(handle);
    },
    _jxl_wasm_encode_tile_container_rgba8: (pixelsPtr: number, width: number, height: number) => {
      return makeHandle(HEAPU8.slice(pixelsPtr, pixelsPtr + width * height * 4), width, height);
    },
    _jxl_wasm_encode_tile_container_rgba16: (pixelsPtr: number, width: number, height: number) => {
      const byteLength = width * height * 8;
      const handle = nextHandle++;
      const dataPtr = malloc(byteLength);
      HEAPU8.set(HEAPU8.slice(pixelsPtr, pixelsPtr + byteLength), dataPtr);
      handles.set(handle, { dataPtr, size: byteLength, width, height, bits: 16, alpha: 1 });
      return handle;
    },
    _jxl_wasm_decode_tile_container_region_rgba8: (inputPtr: number, inputSize: number, _x: number, _y: number, w: number, h: number) => {
      return makeHandle(HEAPU8.slice(inputPtr, inputPtr + inputSize), w, h);
    },
    _jxl_wasm_decode_tile_container_region_rgba16: (inputPtr: number, inputSize: number, _x: number, _y: number, w: number, h: number) => {
      const handle = nextHandle++;
      const dataPtr = malloc(inputSize);
      HEAPU8.set(HEAPU8.slice(inputPtr, inputPtr + inputSize), dataPtr);
      handles.set(handle, { dataPtr, size: inputSize, width: w, height: h, bits: 16, alpha: 1 });
      return handle;
    },
  };
}

function createFakeProgressiveLibjxlModule() {
  const module = createFakeLibjxlModule() as ReturnType<typeof createFakeLibjxlModule> & {
    _jxl_wasm_dec_create: () => number;
    _jxl_wasm_dec_push: (state: number, dataPtr: number, size: number) => number;
    _jxl_wasm_dec_close_input: (state: number) => void;
    _jxl_wasm_dec_width: (state: number) => number;
    _jxl_wasm_dec_height: (state: number) => number;
    _jxl_wasm_dec_error: (state: number) => number;
    _jxl_wasm_dec_take_flushed: (state: number) => number;
    _jxl_wasm_dec_take_final: (state: number) => number;
    _jxl_wasm_dec_free: (state: number) => void;
  };

  let closed = false;
  let flushed = false;

  module._jxl_wasm_dec_create = () => 1;
  module._jxl_wasm_dec_push = (_state: number, _dataPtr: number, size: number) => {
    if (closed || size === 0) return 2;
    flushed = true;
    return 1;
  };
  module._jxl_wasm_dec_close_input = () => {
    closed = true;
  };
  module._jxl_wasm_dec_width = () => 1;
  module._jxl_wasm_dec_height = () => 1;
  module._jxl_wasm_dec_error = () => 0;
  module._jxl_wasm_dec_take_flushed = () => {
    if (!flushed) return 0;
    flushed = false;
    return module._jxl_wasm_decode_rgba8(0, 4, 1);
  };
  module._jxl_wasm_dec_take_final = () => module._jxl_wasm_decode_rgba8(0, 4, 1);
  module._jxl_wasm_dec_free = () => {};

  return module;
}

function createFakeDrainingProgressiveLibjxlModule() {
  const module = createFakeLibjxlModule() as ReturnType<typeof createFakeLibjxlModule> & {
    _jxl_wasm_dec_create: () => number;
    _jxl_wasm_dec_push: (state: number, dataPtr: number, size: number) => number;
    _jxl_wasm_dec_close_input: (state: number) => void;
    _jxl_wasm_dec_width: (state: number) => number;
    _jxl_wasm_dec_height: (state: number) => number;
    _jxl_wasm_dec_error: (state: number) => number;
    _jxl_wasm_dec_take_flushed: (state: number) => number;
    _jxl_wasm_dec_take_final: (state: number) => number;
    _jxl_wasm_dec_free: (state: number) => void;
  };

  let closed = false;
  let pendingFlushes = 0;

  module._jxl_wasm_dec_create = () => 1;
  module._jxl_wasm_dec_push = (_state: number, _dataPtr: number, size: number) => {
    if (!closed && size > 0) {
      pendingFlushes = 2;
    }
    if (pendingFlushes > 0) {
      pendingFlushes--;
      return 1;
    }
    return closed ? 2 : 0;
  };
  module._jxl_wasm_dec_close_input = () => {
    closed = true;
  };
  module._jxl_wasm_dec_width = () => 1;
  module._jxl_wasm_dec_height = () => 1;
  module._jxl_wasm_dec_error = () => 0;
  module._jxl_wasm_dec_take_flushed = () => module._jxl_wasm_decode_rgba8(0, 4, 1);
  module._jxl_wasm_dec_take_final = () => module._jxl_wasm_decode_rgba8(0, 4, 1);
  module._jxl_wasm_dec_free = () => {};

  return module;
}

function createFakeCloseDrainProgressiveLibjxlModule() {
  const module = createFakeLibjxlModule() as ReturnType<typeof createFakeLibjxlModule> & {
    _jxl_wasm_dec_create: () => number;
    _jxl_wasm_dec_push: (state: number, dataPtr: number, size: number) => number;
    _jxl_wasm_dec_close_input: (state: number) => void;
    _jxl_wasm_dec_width: (state: number) => number;
    _jxl_wasm_dec_height: (state: number) => number;
    _jxl_wasm_dec_error: (state: number) => number;
    _jxl_wasm_dec_take_flushed: (state: number) => number;
    _jxl_wasm_dec_take_final: (state: number) => number;
    _jxl_wasm_dec_free: (state: number) => void;
  };

  let closed = false;
  let pendingFlushes = 0;
  let closeFlushQueued = false;

  module._jxl_wasm_dec_create = () => 1;
  module._jxl_wasm_dec_push = (_state: number, _dataPtr: number, size: number) => {
    if (!closed && size > 0) {
      pendingFlushes = 1;
    } else if (closed && pendingFlushes === 0 && !closeFlushQueued) {
      pendingFlushes = 1;
      closeFlushQueued = true;
    }
    if (pendingFlushes > 0) {
      pendingFlushes--;
      return 1;
    }
    return closed ? 2 : 0;
  };
  module._jxl_wasm_dec_close_input = () => {
    closed = true;
  };
  module._jxl_wasm_dec_width = () => 1;
  module._jxl_wasm_dec_height = () => 1;
  module._jxl_wasm_dec_error = () => 0;
  module._jxl_wasm_dec_take_flushed = () => module._jxl_wasm_decode_rgba8(0, 4, 1);
  module._jxl_wasm_dec_take_final = () => module._jxl_wasm_decode_rgba8(0, 4, 1);
  module._jxl_wasm_dec_free = () => {};

  return module;
}

function createFakeStreamingInputLibjxlModule() {
  const module = createFakeLibjxlModule() as ReturnType<typeof createFakeLibjxlModule> & {
    __mallocCalls: number;
    _jxl_wasm_enc_create_image: (width: number, height: number) => number;
    _jxl_wasm_enc_pixels_ptr: (state: number, size: number) => number;
    _jxl_wasm_enc_advance_written: (state: number, size: number) => number;
    _jxl_wasm_enc_push_chunk: (state: number, dataPtr: number, size: number) => number;
    _jxl_wasm_enc_finish: (state: number) => number;
    _jxl_wasm_enc_take_chunk: (state: number) => number;
    _jxl_wasm_enc_free: (state: number) => void;
  };

  const baseMalloc = module._malloc.bind(module);
  module.__mallocCalls = 0;
  module._malloc = (size: number) => {
    module.__mallocCalls++;
    return baseMalloc(size);
  };

  let nextState = 1;
  const states = new Map<number, { width: number; height: number; pixelsPtr: number; pixelsSize: number; pixelsWritten: number; nextHandle: number }>();

  module._jxl_wasm_enc_create_image = (width: number, height: number, _distance?: number, _effort?: number, fmt?: number) => {
    const state = nextState++;
    const bytesPerPixel = fmt === 2 ? 16 : fmt === 1 ? 8 : 4;
    const pixelsSize = width * height * bytesPerPixel;
    const pixelsPtr = baseMalloc(pixelsSize);
    states.set(state, { width, height, pixelsPtr, pixelsSize, pixelsWritten: 0, nextHandle: 0 });
    return state;
  };
  module._jxl_wasm_enc_pixels_ptr = (state: number, size: number) => {
    const entry = states.get(state);
    if (!entry || entry.pixelsWritten + size > entry.pixelsSize) return 0;
    return entry.pixelsPtr + entry.pixelsWritten;
  };
  module._jxl_wasm_enc_advance_written = (state: number, size: number) => {
    const entry = states.get(state);
    if (!entry || entry.pixelsWritten + size > entry.pixelsSize) return 1;
    entry.pixelsWritten += size;
    return 0;
  };
  module._jxl_wasm_enc_push_chunk = (state: number, dataPtr: number, size: number) => {
    const entry = states.get(state);
    if (!entry) return 1;
    if (entry.pixelsWritten + size > entry.pixelsSize) return 1;
    module.HEAPU8.copyWithin(entry.pixelsPtr + entry.pixelsWritten, dataPtr, dataPtr + size);
    entry.pixelsWritten += size;
    return 0;
  };
  module._jxl_wasm_enc_finish = (state: number) => {
    const entry = states.get(state);
    if (!entry) return 1;
    entry.nextHandle = module.__makeHandle(module.HEAPU8.subarray(entry.pixelsPtr, entry.pixelsPtr + entry.pixelsWritten), entry.width, entry.height);
    const handle = entry.nextHandle;
    const dataPtr = module._jxl_wasm_buffer_data(handle);
    module.HEAPU8.set(module.HEAPU8.subarray(entry.pixelsPtr, entry.pixelsPtr + entry.pixelsWritten), dataPtr);
    return 0;
  };
  module._jxl_wasm_enc_take_chunk = (state: number) => {
    const entry = states.get(state);
    if (!entry) return 0;
    const handle = entry.nextHandle;
    entry.nextHandle = 0;
    return handle;
  };
  module._jxl_wasm_enc_free = (state: number) => {
    const entry = states.get(state);
    if (entry) module._free(entry.pixelsPtr);
    states.delete(state);
  };

  return module;
}

function createFakeFreedViewProgressiveLibjxlModule() {
  const module = createFakeProgressiveLibjxlModule() as ReturnType<typeof createFakeProgressiveLibjxlModule> & {
    __progressHandle?: number;
  };

  const baseDecode = module._jxl_wasm_decode_rgba8;
  module._jxl_wasm_dec_take_flushed = () => {
    module.__progressHandle = baseDecode(0, 4, 1);
    const ptr = module._jxl_wasm_buffer_data(module.__progressHandle);
    module.HEAPU8.set(new Uint8Array([9, 8, 7, 6]), ptr);
    return module.__progressHandle;
  };
  const originalFree = module._jxl_wasm_buffer_free;
  module._jxl_wasm_buffer_free = (handle: number) => {
    const ptr = module._jxl_wasm_buffer_data(handle);
    const size = module._jxl_wasm_buffer_size(handle);
    if (ptr !== 0 && size > 0) {
      module.HEAPU8.fill(0, ptr, ptr + size);
    }
    originalFree(handle);
  };

  return module;
}

function createFakeMeasuredProgressiveLibjxlModule() {
  const module = createFakeProgressiveLibjxlModule() as ReturnType<typeof createFakeProgressiveLibjxlModule>;
  module._jxl_wasm_dec_width = () => 128;
  module._jxl_wasm_dec_height = () => 128;
  return module;
}

async function nextWithin<T>(iterator: AsyncIterator<T>, ms: number): Promise<IteratorResult<T>> {
  return await Promise.race([
    iterator.next(),
    new Promise<IteratorResult<T>>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
  ]);
}

async function loadPreferredLibjxlModule() {
  try {
    const imported = await import("../dist/jxl-core.scalar.js");
    if (typeof imported.default === "function") {
      const baseUrl = new URL("../dist/", import.meta.url);
      const module = await imported.default({
        locateFile: (path: string) => new URL(path, baseUrl).href,
      });
      if (module && typeof module._malloc === "function" && typeof module._jxl_wasm_encode_rgba8 === "function") {
        return module;
      }
    }
  } catch {}
  return createFakeLibjxlModule();
}

describe('ExtraChannel full infrastructure (Phase 2)', () => {
  it('accepts full ExtraChannel descriptors including spotColor, dimShift, thermal, reserved', () => {
    const ch: ExtraChannel = {
      type: 'spot',
      bitsPerSample: 8,
      dimShift: 0,
      name: 'MySpot',
      distance: 0.5,
      spotColor: { red: 0.9, green: 0.1, blue: 0.2, solidity: 0.8 }
    };
    // Minimal valid EncoderOptions shape + extraChannels (cast to defer EncoderOptions field wiring).
    // Construction only; actual encode path ignores new fields until later tasks.
    const opts = {
      format: "rgba8" as const,
      width: 1,
      height: 1,
      hasAlpha: true,
      iccProfile: null,
      exif: null,
      xmp: null,
      distance: null,
      quality: null,
      effort: 7 as const,
      progressive: false,
      previewFirst: false,
      chunked: false,
      extraChannels: [ch]
    };
    expect(() => createEncoder(opts as any)).not.toThrow();
  });

  it('rejects invalid type at type level (unknown)', () => {
    // The @ts-expect-error below enforces that 'foo' is not a valid ExtraChannelType at compile time.
    // Runtime check is a no-op here (validation comes in encode impl later).
    // @ts-expect-error
    const bad: ExtraChannel = { type: 'foo' as any, bitsPerSample: 8 };
    expect(bad).toBeDefined();
  });

  it('serializes ExtraChannel descriptors at the 20-byte WasmExtraChannel stride (channels 1..N land at i*20)', () => {
    // EC_BYTES must match `struct WasmExtraChannel` in bridge.cpp (20 bytes), the only consumer.
    // The previous 72-byte stride misaligned every channel after #0 (writer i*72 vs reader i*20).
    expect(EC_BYTES).toBe(20);

    const channels: ExtraChannel[] = [
      { type: 'spot', bitsPerSample: 8, name: 'RedSpot', distance: 0.1, spotColor: { red: 0.95, green: 0.05, blue: 0.1, solidity: 0.85 } },
      { type: 'depth', bitsPerSample: 16, dimShift: 0, name: 'Depth16', distance: 0.5 },
      { type: 'thermal', bitsPerSample: 8, name: 'ThermalCam' },
    ];

    const { buffer, view } = serializeExtraChannelsForWasm(channels);

    // Buffer is exactly 20*N — no oversized stride.
    expect(buffer.byteLength).toBe(channels.length * 20);
    expect(view.byteLength).toBe(channels.length * 20);

    const EC = EC_BYTES; // 20

    // Channel 0: spot, 8-bit, distance 0.1 — at offset 0.
    expect(view.getUint32(0 * EC + 0, true)).toBe(2); // SPOT_COLOR
    expect(view.getUint32(0 * EC + 4, true)).toBe(8); // bits
    expect(view.getFloat32(0 * EC + 8, true)).toBeCloseTo(0.1, 5); // distance
    expect(view.getUint32(0 * EC + 12, true)).toBe(0); // plane_ptr (filled by caller post-malloc)
    expect(view.getUint32(0 * EC + 16, true)).toBe(0); // plane_size

    // Channel 1: depth, 16-bit, distance 0.5 — MUST be at offset 20 (the bug put it at 72).
    expect(view.getUint32(1 * EC + 0, true)).toBe(1); // DEPTH
    expect(view.getUint32(1 * EC + 4, true)).toBe(16); // bits
    expect(view.getFloat32(1 * EC + 8, true)).toBeCloseTo(0.5, 5); // distance
    expect(view.getUint32(1 * EC + 12, true)).toBe(0);
    expect(view.getUint32(1 * EC + 16, true)).toBe(0);

    // Channel 2: thermal, 8-bit, default distance 0 — at offset 40.
    expect(view.getUint32(2 * EC + 0, true)).toBe(6); // THERMAL
    expect(view.getUint32(2 * EC + 4, true)).toBe(8); // bits
    expect(view.getFloat32(2 * EC + 8, true)).toBeCloseTo(0, 5); // distance default

    // Caller post-malloc writes of plane_ptr/plane_size at +12/+16 land in the right slot per channel.
    view.setUint32(1 * EC + 12, 0xCAFE, true);
    view.setUint32(1 * EC + 16, 64, true);
    expect(view.getUint32(1 * EC + 12, true)).toBe(0xCAFE);
    expect(view.getUint32(1 * EC + 16, true)).toBe(64);
    // ...and do NOT clobber neighbouring channels (proves stride correctness).
    expect(view.getUint32(0 * EC + 0, true)).toBe(2);
    expect(view.getUint32(2 * EC + 0, true)).toBe(6);
  });
});
