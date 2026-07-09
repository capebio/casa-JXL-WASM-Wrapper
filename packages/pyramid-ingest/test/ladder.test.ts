import { expect, test, afterEach } from "bun:test";
import { setJxlModuleFactoryForTesting } from "@casabio/jxl-wasm";
import { buildRawLadder, buildJpgLadder, buildProxyLadder } from "../src/ladder";
import { makeTestJxlBackend } from "./scalar.js";
import { createJxlBackend, type JxlBackend, type DecodedMaster } from "../src/backends";
import { loadScalarModule, scalarFactory } from "./scalar";

afterEach(() => setJxlModuleFactoryForTesting(null));

function gradientRgba(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      px[o] = (x * 31 + y * 17) & 0xff;
      px[o + 1] = (x * 7 + y * 53) & 0xff;
      px[o + 2] = (x * 13 + y * 29) & 0xff;
      px[o + 3] = 255;
    }
  }
  return px;
}

test("buildRawLadder keeps every encoded level, ascending, full last, all 8-bit baked", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  // use test jxl for ladder logic (real encode not required here)
  const jxl = makeTestJxlBackend();
  const W = 1280, H = 960;
  const decoded: DecodedMaster = { rgba: gradientRgba(W, H), width: W, height: H, orientation: "baked" };

  const ladder = await buildRawLadder(jxl, decoded, false, "tile-all");
  expect(ladder.orientation).toBe("baked");
  expect(ladder.width).toBe(W);
  expect(ladder.height).toBe(H);
  expect(ladder.levels.map((l) => l.width)).toEqual([256, 512, 1024, 1280]);
  // Phase 3: all levels are JXTC tiled
  for (const lvl of ladder.levels) {
    expect(lvl.tiled).toBe(true);
  }
});

test("buildRawLadder attaches qualityCurve + convergedByteEnd from profileConvergenceCurve on >=1024 levels", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const curve = [
    { bytes: 2, ssim: 0.97, butteraugli: 3.2 },
    { bytes: 6, ssim: 0.9996, butteraugli: 1.05 },
  ];
  const jxl: JxlBackend = {
    ...makeTestJxlBackend(),
    async profileConvergenceCurve(_jxl: Uint8Array, _w?: number, _h?: number) {
      return { curve, convergedByteEnd: 6 };
    },
  };
  const W = 1280, H = 960;
  const decoded: DecodedMaster = { rgba: gradientRgba(W, H), width: W, height: H, orientation: "baked" };
  const ladder = await buildRawLadder(jxl, decoded, true, "tile-all");
  for (const lvl of ladder.levels) {
    if (Math.max(lvl.width, lvl.height) >= 1024) {
      expect(lvl.qualityCurve).toEqual(curve);
      expect(lvl.convergedByteEnd).toBe(6);
    } else {
      expect(lvl.qualityCurve).toBeUndefined();
      expect(lvl.convergedByteEnd).toBeUndefined();
    }
  }
});

test("buildJpgLadder produces all levels (incl full) as tiled JXTC (no transcode substitution)", async () => {
  const transcodeBytes = new Uint8Array([0xff, 0x0a, 0x42, 0x13]);
  const fake: JxlBackend = {
    async transcodeJpeg() { return transcodeBytes; },
    async decodeToRgba8() { return { rgba: gradientRgba(1280, 960), width: 1280, height: 960 }; },
    async encodeTileContainer(_rgba, w, h, _opts) {
      return new Uint8Array([0xa0, w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff]);
    },
    async downscaleRgba8(_rgba, _sw, _sh, dw, dh) {
      return new Uint8Array(dw * dh * 4);
    },
    // encodePyramid no longer used by buildJpgLadder
    async encodePyramid() { return []; },
  };
  const ladder = await buildJpgLadder(fake, new Uint8Array([1, 2, 3]), false, "source", "tile-all");
  expect(ladder.orientation).toBe("source");
  // L9 signature accepts explicit orientation (default "source" for back-compat)
  const ladder2 = await buildJpgLadder(fake, new Uint8Array([1, 2, 3]), false, "source", "tile-all");
  expect(ladder2.orientation).toBe("source");
  expect(ladder.levels.map((l) => l.width)).toEqual([256, 512, 1024, 1280]);
  const full = ladder.levels[ladder.levels.length - 1]!;
  // full is now from encodeTileContainer (tiled), not raw transcode bytes
  expect(full.tiled).toBe(true);
  expect(full.data[0]).toBe(0xa0);
  for (const lvl of ladder.levels) {
    expect(lvl.tiled).toBe(true);
  }
});

test("buildProxyLadder returns exactly one level", async () => {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  // use test jxl for ladder logic (real encode not required here)
  const jxl = makeTestJxlBackend();
  const W = 2000, H = 1500;
  const ladder = await buildProxyLadder(jxl, gradientRgba(W, H), W, H, 512, "baked");
  expect(ladder.levels).toHaveLength(1);
  expect(Math.max(ladder.levels[0]!.width, ladder.levels[0]!.height)).toBe(512);
});

test("L1/L2 regression: descending cascade (never upscales), grid bounded by master, dedup exact/near, final ascending", async () => {
  // Spy downscales to assert L1: no call with dst > src (would have been upscales from 256 in old ascending)
  const downscaleCalls: Array<{ srcW: number; dstW: number }> = [];
  const fake: JxlBackend = {
    async transcodeJpeg() { return new Uint8Array([1]); },
    async decodeToRgba8() { return { rgba: gradientRgba(800, 600), width: 800, height: 600 }; },
    async encodeTileContainer(_rgba, w, h, _opts) {
      return new Uint8Array([0xa0, w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff]);
    },
    async downscaleRgba8(_rgba, sw, sh, dw, dh) {
      downscaleCalls.push({ srcW: sw, dstW: dw });
      return new Uint8Array(dw * dh * 4);
    },
    async encodePyramid() { return []; },
  };
  // 800px master: grid filter must drop 1024 ( > master and would dup full); 8bit path also
  const ladder = await buildJpgLadder(fake, new Uint8Array([1, 2, 3]), false, "source", "tile-all");
  const widths = ladder.levels.map((l) => l.width);
  expect(widths).toEqual([256, 512, 800]); // 1024 excluded by <masterLong; full (800) always emitted; ascending L7
  // L1: every downscale src >= dst (cascade down only)
  for (const c of downscaleCalls) {
    expect(c.dstW).toBeLessThanOrEqual(c.srcW);
  }
  expect(downscaleCalls.length).toBeGreaterThan(0);

  // raw 8bit-only path with near-full ratio: master 2100 should drop 2048 (ratio<1.15)
  const down2: Array<{ srcW: number; dstW: number }> = [];
  const fakeRaw: JxlBackend = {
    async encodeTileContainer(_r, w, h) { return new Uint8Array([0xb0, w & 0xff, (w >> 8) & 0xff]); },
    async downscaleRgba8(_r, sw, _sh, dw, _dh) { down2.push({ srcW: sw, dstW: dw }); return new Uint8Array(dw * 4); },
    async encodePyramid() { return []; },
  };
  const decoded: DecodedMaster = { rgba: gradientRgba(2100, 1500), width: 2100, height: 1500, orientation: "baked" };
  const ladderRaw = await buildRawLadder(fakeRaw, decoded, false, "tile-all");
  const ws = ladderRaw.levels.map((l) => l.width);
  // 256,512,1024,2100 (2048 skipped by ratio; no 2048)
  expect(ws).toEqual([256, 512, 1024, 2100]);
  for (const c of down2) expect(c.dstW).toBeLessThanOrEqual(c.srcW);
});

test("L1 rgb16 branch + L7 order: grid ascending + big ascending after combined sort", async () => {
  const downCalls: Array<{ src: number; dst: number }> = [];
  const fake: JxlBackend = {
    async encodeTileContainer(_r, w, h) { return new Uint8Array([0xc0, w & 0xff]); },
    async encodeTileContainer16(_r, w, h) { return new Uint8Array([0xd0, w & 0xff]); },
    async downscaleRgba8(_r, sw, _sh, dw, _dh) { downCalls.push({ src: sw, dst: dw }); return new Uint8Array(dw * 4); },
    async downscaleRgba16(_r, sw, _sh, dw, _dh) { downCalls.push({ src: sw, dst: dw }); return new Uint16Array(dw * 4); },
  };
  // provide rgb16 to hit the branch; master 3000 -> grid 256/512/1024 + big 2048 + full
  const rgb16 = new Uint8Array(3000 * 2000 * 6); // dummy packed
  const decoded: DecodedMaster = { rgba: gradientRgba(3000, 2000), rgb16, width: 3000, height: 2000, orientation: "baked" };
  const ladder = await buildRawLadder(fake, decoded, false, "tile-all");
  const longs = ladder.levels.map((l) => Math.max(l.width, l.height));
  expect(longs).toEqual([256, 512, 1024, 2048, 3000]); // L7 ascending
  for (const c of downCalls) expect(c.dst).toBeLessThanOrEqual(c.src);
});