import type { JxlModuleFactory } from "@casabio/jxl-wasm";
import type { JxlBackend, DecodedMaster, PyramidLevelBytes } from "../src/backends.js";

// Loads a real WASM module handle for tests. Real encode/transcode tests (tiling, jpg, backends)
// inject this via scalarFactory, so we prefer the `enc` module (decoderOnly:false) which carries
// the encode + JPEG-transcode + tile-container bridges. Falls back to dec/mono, then a stub.
export async function loadScalarModule() {
  // Post P3 split: artifacts are jxl-core.{dec,enc}.*.js. Prefer enc (has the encode bridges);
  // dec is decoder-only, mono is the pre-split shipped artifact. A stub keeps import from
  // hard-failing the suite when no real module is present.
  // Fallback order: enc split -> dec split -> monolithic simd -> stub.
  for (const artifact of ["jxl-core.enc.simd.js", "jxl-core.dec.simd.js", "jxl-core.simd.js"]) {
    try {
      const imported = await import(`../../jxl-wasm/dist/${artifact}`);
      if (typeof imported.default === "function") {
        const baseUrl = new URL("../../jxl-wasm/dist/", import.meta.url);
        const module = await imported.default({ locateFile: (p: string) => new URL(p, baseUrl).href });
        if (module && typeof module._malloc === "function") return module;
      }
    } catch {}
  }
  // Fallback stub (sufficient because callers replace the encode surface).
  return {
    _malloc: (n: number) => 0,
    _free: (_p: number) => {},
    _jxl_wasm_encode_tile_container_rgba8: () => 0,
    _jxl_wasm_encode_tile_container_rgba16: () => 0,
  } as any;
}

/** A factory that always returns the loaded baseline module (for setJxlModuleFactoryForTesting). */
export function scalarFactory(module: Awaited<ReturnType<typeof loadScalarModule>>): JxlModuleFactory {
  return (async () => module) as unknown as JxlModuleFactory;
}

/** A robust mock JxlBackend that returns expected shapes for pyramid-ingest unit and integration tests. */
export function makeTestJxlBackend(): JxlBackend {
  return {
    async encodePyramid(rgba: Uint8Array, width: number, height: number, opts: any): Promise<PyramidLevelBytes[]> {
      const levels: PyramidLevelBytes[] = [];
      // Filter out sidecars larger than or equal to the master's long edge to match real WASM expectations
      const sidecars = (opts.sidecars || []).filter((sc: any) => sc.size < Math.max(width, height));
      for (const sc of sidecars) {
        const scale = sc.size / Math.max(width, height);
        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(height * scale));
        // Append width & height to data to make hashes unique for deduplication tests,
        // and keep total length > 4 to satisfy file size expectations.
        const data = new Uint8Array([1, 2, 3, 4, w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff]);
        levels.push({
          data,
          width: w,
          height: h,
          bitsPerSample: 8,
          tiled: false,
        });
      }
      // Add the full level with a unique buffer as well
      const fullData = new Uint8Array([5, 6, 7, 8, width & 0xff, (width >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff]);
      levels.push({
        data: fullData,
        width,
        height,
        bitsPerSample: 8,
        tiled: false,
      });
      return levels;
    },
    async encodeTileContainer(rgba: Uint8Array, width: number, height: number, opts: any): Promise<Uint8Array> {
      return new Uint8Array([9, 10, 11, 12, width & 0xff, (width >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff]);
    },
    async downscaleRgba8(_rgba: Uint8Array, _srcW: number, _srcH: number, dstW: number, dstH: number): Promise<Uint8Array> {
      // content ignored by ladder tests; size must be correct for encodeTileContainer marker
      return new Uint8Array(dstW * dstH * 4);
    },
    async transcodeJpeg(jpeg: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array([13, 14, 15, 16, jpeg.length & 0xff, (jpeg.length >> 8) & 0xff]);
    },
    async decodeToRgba8(jxl: Uint8Array): Promise<{ rgba: Uint8Array; width: number; height: number }> {
      return {
        rgba: new Uint8Array(640 * 480 * 4),
        width: 640,
        height: 480,
      };
    },
    async profileConvergence(jxl: Uint8Array, w?: number, h?: number): Promise<number | undefined> {
      return undefined;
    }
  };
}
