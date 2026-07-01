// P2c — streaming full-res RAW → JXL export (Approach A).
//
// Pull RGB8 bands from a producer and feed them into the jxl-wasm bridge's chunked encoder
// band-by-band (JxlEncoderAddChunkedFrame), so only one super-tile band is materialized at a time
// — O(band) memory, byte-identical to a whole-frame encode. The bridge's chunked input source
// reenters `produceBand` synchronously via EM_JS (globalThis.__jxlP2cPull), so this bridges the
// two separate wasm modules (RAW pipeline ↔ JXL encoder) in JS with a single band copy per pull.

/** The jxl-wasm encoder module surface this helper needs (a subset of the emscripten module). */
export interface JxlStreamBridge {
  _malloc(n: number): number;
  _free(p: number): void;
  readonly HEAPU8: Uint8Array;
  _jxl_wasm_encode_rgb8_stream(w: number, h: number, distance: number, effort: number): number;
  _jxl_wasm_buffer_error(buf: number): number;
  _jxl_wasm_buffer_size(buf: number): number;
  _jxl_wasm_buffer_data(buf: number): number;
  _jxl_wasm_buffer_free(buf: number): void;
}

/**
 * Produce the RGB8 band `[ypos, ypos+ysize)` of the image, FULL WIDTH and tightly packed
 * (length = ysize * width * 3). Bands are requested top-to-bottom with monotonically increasing
 * `ypos` (a RAW `RawStreamExporter.band(ypos, ysize)` satisfies this directly).
 */
export type ProduceBand = (ypos: number, ysize: number) => Uint8Array;

/**
 * Stream-encode an image to JXL, pulling each band on demand from `produceBand`. `distance <= 0`
 * selects lossless. Returns the JXL codestream bytes (a JS-owned copy). Byte-identical to encoding
 * the whole frame at once.
 *
 * Not re-entrant / not concurrent: it installs the process-global `__jxlP2cPull` / `__jxlP2cRelease`
 * slots the bridge's EM_JS callbacks read, and restores the previous values on exit. Run one
 * streaming encode at a time per JS realm.
 */
export function streamEncodeRgb8(
  bridge: JxlStreamBridge,
  produceBand: ProduceBand,
  width: number,
  height: number,
  distance: number,
  effort: number,
): Uint8Array {
  const stride = width * 3;
  const bases = new Map<number, number>(); // returned rect ptr -> malloc base (for release)
  const g = globalThis as unknown as {
    __jxlP2cPull?: unknown;
    __jxlP2cRelease?: unknown;
  };
  const prevPull = g.__jxlP2cPull;
  const prevRelease = g.__jxlP2cRelease;

  g.__jxlP2cPull = (xpos: number, ypos: number, _xsize: number, ysize: number) => {
    const band = produceBand(ypos, ysize);
    const base = bridge._malloc(band.length);
    bridge.HEAPU8.set(band, base); // re-read HEAPU8 after malloc (memory-growth safe)
    const ptr = base + xpos * 3;
    bases.set(ptr, base);
    return { ptr, stride };
  };
  g.__jxlP2cRelease = (ptr: number) => {
    const base = bases.get(ptr);
    if (base !== undefined) {
      bridge._free(base);
      bases.delete(ptr);
    }
  };

  try {
    const buf = bridge._jxl_wasm_encode_rgb8_stream(width, height, distance, effort);
    const err = bridge._jxl_wasm_buffer_error(buf);
    if (err) {
      bridge._jxl_wasm_buffer_free(buf);
      throw new Error(`jxl streaming encode failed (code ${err})`);
    }
    const size = bridge._jxl_wasm_buffer_size(buf);
    const dptr = bridge._jxl_wasm_buffer_data(buf);
    const out = bridge.HEAPU8.slice(dptr, dptr + size);
    bridge._jxl_wasm_buffer_free(buf);
    return out;
  } finally {
    for (const base of bases.values()) bridge._free(base); // defensive: none should remain on success
    bases.clear();
    g.__jxlP2cPull = prevPull;
    g.__jxlP2cRelease = prevRelease;
  }
}
