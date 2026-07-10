// Node WASM decode wrapper: RAW file → oriented RGB8 + dims + metadata getters.
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const ARGS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Number.NaN, Number.NaN, 0, 0];
let raw;

export async function initWasm() {
  if (raw) return raw;
  raw = await import("../../pkg/raw_converter_wasm.js");
  await raw.default({ module_or_path: readFileSync(new URL("../../pkg/raw_converter_wasm_bg.wasm", import.meta.url)) });
  return raw;
}

export function getRaw() {
  if (!raw) throw new Error("initWasm() not called");
  return raw;
}

export const SUPPORTED_RAW = new Set([".cr2", ".dng", ".orf", ".raw"]);

/** Decode a RAW file to oriented RGB8 + dims; `result` exposes the metadata getters. */
export async function decodeRaw(path) {
  await initWasm();
  const ext = extname(path).toLowerCase();
  const bytes = new Uint8Array(readFileSync(path));
  let result;
  if (ext === ".cr2") result = raw.process_cr2_with_flags(bytes, 1, ...ARGS);
  else if (ext === ".dng") result = raw.process_dng_with_flags(bytes, 1, ...ARGS);
  else if (ext === ".orf" || ext === ".raw") result = raw.process_orf_with_flags(bytes, 1, ...ARGS);
  else throw new Error(`decodeRaw: unsupported extension ${ext}`);
  const width = result.width, height = result.height;
  const rgb = result.take_rgb();
  return { result, rgb, width, height };
}
