// JPEG XL DNG tiles (compression 52546, e.g. iOS 17+ ProRAW) through the app's
// own libjxl decode-only build. The RAW wasm carries no JXL decoder, so the
// worker loads this only for a DNG whose `dng_uses_jxl` is true and hands the
// tile decoder to `set_jxl_tile_decoder`. Every other file never fetches it.

// `m` = an instantiated jxl-core.dec module. Returns `(tile, cps) -> { w, h,
// samples }`: libjxl's UINT16 RGBA output, cut to `cps` channels per pixel
// (a grey Bayer tile comes back replicated; channel 0 is it).
export function libjxlTileDecoder(m) {
  return (tile, cps) => {
    const at = m._malloc(tile.length);
    m.HEAPU8.set(tile, at);
    const buf = m._jxl_wasm_decode_rgba16(at, tile.length, 1);
    m._free(at);
    try {
      const err = m._jxl_wasm_buffer_error(buf);
      if (err) throw new Error('libjxl error ' + err);
      const w = m._jxl_wasm_buffer_width(buf), h = m._jxl_wasm_buffer_height(buf);
      const rgba = new Uint16Array(m.HEAPU8.buffer, m._jxl_wasm_buffer_data(buf), w * h * 4);
      const samples = new Uint16Array(w * h * cps);
      for (let i = 0, o = 0; i < w * h; i++) for (let c = 0; c < cps; c++) samples[o++] = rgba[i * 4 + c];
      return { w, h, samples };
    } finally { m._jxl_wasm_buffer_free(buf); }
  };
}

// Import by the served URL, never a blob: the Emscripten loader resolves its
// .wasm against its own import.meta.url (a blob URL throws "Invalid URL").
export async function loadLibjxlTileDecoder(opts = {}) {
  const { default: create } = await import('../packages/jxl-wasm/dist/jxl-core.dec.simd.js');
  return libjxlTileDecoder(await create(opts));
}
