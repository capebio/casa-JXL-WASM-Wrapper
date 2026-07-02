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
export declare function streamEncodeRgb8(bridge: JxlStreamBridge, produceBand: ProduceBand, width: number, height: number, distance: number, effort: number): Uint8Array;
//# sourceMappingURL=stream-fusion.d.ts.map