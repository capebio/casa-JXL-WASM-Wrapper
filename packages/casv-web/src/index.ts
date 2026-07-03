// @casabio/casv-web — browser playback for CASAVA (.casv) / JOLT streams.
//
// Mirrors crates/raw-pipeline/src/casa_video.rs (the format's reference
// implementation). Scope: the JOLT lossy profile — JXL intra frames +
// fresh-pixel REPLACE P-frames (bbox and tile, v1 sliver + v2 square atlas),
// header-indexed and footer-indexed (streamed) files, rate metadata.
// Out of scope (throws): the lossless residual tiers (need RGBA16 decode +
// add-compositing) and the Fable braided-rANS tier (native-only codec).
//
// The JXL frame decoder is injected (any (bytes) => rgba function works), so
// this package has zero hard dependencies; pair it with @casabio/jxl-wasm's
// createDecoder in the browser.

/** Little-endian magics, byte-identical to casa_video.rs. */
export const CASV_MAGIC = 0x5641_5343; // "CSAV" as LE u32 read of b"CASV"... (matches Rust constant)
export const CASV_VERSION = 1;
export const CASV_HEADER_BYTES = 32;
export const CASV_INDEX_ENTRY_BYTES = 8;
export const CASV_FOOTER_MAGIC = 0x4653_4143;
export const CASV_FOOTER_BYTES = 32;
export const CASV_RATE_BOX_MAGIC = 0x5253_4143;
export const CASV_AUDIO_BOX_MAGIC = 0x5541_5343;

/** An Ogg/Opus audio stream embedded in a footer-format .casv via the CSAU box. */
export interface CasvAudio {
  /** Raw Ogg/Opus bytes, ready for AudioContext.decodeAudioData(). */
  bytes: Uint8Array;
}

/** Index-entry flag bits (top nibble of the len field). */
export const CASV_PFRAME_FLAG = 0x8000_0000;
export const CASV_BBOX_FLAG = 0x4000_0000;
export const CASV_TILE_FLAG = 0x2000_0000;
export const CASV_REPLACE_FLAG = 0x1000_0000;
const CASV_FLAG_BITS = CASV_PFRAME_FLAG | CASV_BBOX_FLAG | CASV_TILE_FLAG | CASV_REPLACE_FLAG;

/** Header flags word. */
export const CASV_HDRFLAG_LOSSY = 1;
export const CASV_HDR_FABLE_FLAG = 2;

/** Tile payload: high bit of the leading tile-size u16 selects the v2 square atlas. */
export const CASV_TILE_V2_BIT = 0x8000;

export interface CasvHeader {
  width: number;
  height: number;
  frameCount: number;
  fpsNum: number;
  fpsDen: number;
  flags: number;
}

export interface CasvRate {
  lossy: boolean;
  fable: boolean;
  /** Butteraugli distance recorded by the encoder (0.1 steps), null if lossless/legacy. */
  distance: number | null;
  /** libjxl effort (1..10), 0 for lossless/legacy. */
  effort: number;
}

export function rateFromFlags(flags: number): CasvRate {
  const lossy = (flags & CASV_HDRFLAG_LOSSY) !== 0;
  return {
    lossy,
    fable: (flags & CASV_HDR_FABLE_FLAG) !== 0,
    distance: lossy ? ((flags >>> 8) & 0xff) / 10 : null,
    effort: (flags >>> 16) & 0xf,
  };
}

export interface CasvFrameEntry {
  /** Byte range of the frame payload within the file buffer. */
  offset: number;
  length: number;
  isPFrame: boolean;
  isBbox: boolean;
  isTile: boolean;
  isReplace: boolean;
}

/** Injected single-frame JXL decoder. Must return tightly-packed RGBA8. */
export type JxlFrameDecoder = (
  jxl: Uint8Array
) => Promise<{ rgba: Uint8Array; width: number; height: number }>;

function u32(dv: DataView, o: number): number {
  return dv.getUint32(o, true);
}

/** Parse the 32-byte leading header. Null on bad magic/version/dims. */
export function parseCasvHeader(bytes: Uint8Array): CasvHeader | null {
  if (bytes.byteLength < CASV_HEADER_BYTES) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (u32(dv, 0) !== CASV_MAGIC || u32(dv, 4) !== CASV_VERSION) return null;
  const h: CasvHeader = {
    width: u32(dv, 8),
    height: u32(dv, 12),
    frameCount: u32(dv, 16),
    fpsNum: u32(dv, 20),
    fpsDen: u32(dv, 24),
    flags: u32(dv, 28),
  };
  if (h.width === 0 || h.height === 0 || h.frameCount === 0 || h.fpsDen === 0) return null;
  return h;
}

export interface CasvFooter {
  indexOffset: number;
  width: number;
  height: number;
  frameCount: number;
  fpsNum: number;
  fpsDen: number;
}

/** Parse the trailing 32-byte footer of a streamed (footer-indexed) file. */
export function parseCasvFooter(bytes: Uint8Array): CasvFooter | null {
  if (bytes.byteLength < CASV_FOOTER_BYTES) return null;
  const o = bytes.byteLength - CASV_FOOTER_BYTES;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (u32(dv, o + 28) !== CASV_FOOTER_MAGIC) return null;
  const indexOffset = Number(dv.getBigUint64(o, true));
  const f: CasvFooter = {
    indexOffset,
    width: u32(dv, o + 8),
    height: u32(dv, o + 12),
    frameCount: u32(dv, o + 16),
    fpsNum: u32(dv, o + 20),
    fpsDen: u32(dv, o + 24),
  };
  if (f.width === 0 || f.height === 0 || f.frameCount === 0 || f.fpsDen === 0) return null;
  const idxEnd = f.indexOffset + f.frameCount * CASV_INDEX_ENTRY_BYTES;
  if (idxEnd + CASV_FOOTER_BYTES > bytes.byteLength) return null;
  return f;
}

/** Rate flags of a streamed file's optional CASR box; null for legacy files. */
export function parseCasvRateBox(bytes: Uint8Array): number | null {
  const f = parseCasvFooter(bytes);
  if (f === null) return null;
  const idxEnd = f.indexOffset + f.frameCount * CASV_INDEX_ENTRY_BYTES;
  if (idxEnd + 8 + CASV_FOOTER_BYTES > bytes.byteLength) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (u32(dv, idxEnd) !== CASV_RATE_BOX_MAGIC) return null;
  return u32(dv, idxEnd + 4);
}

/**
 * Extract the Ogg/Opus payload from a footer-format .casv that contains a CSAU box.
 * Returns null if absent, file too short, or magic mismatch.
 */
export function parseCasvAudioBox(bytes: Uint8Array): Uint8Array | null {
  const f = parseCasvFooter(bytes);
  if (f === null) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idxEnd = f.indexOffset + f.frameCount * CASV_INDEX_ENTRY_BYTES;
  const footerStart = bytes.byteLength - CASV_FOOTER_BYTES;
  let pos = idxEnd;
  // Skip optional CASR box.
  if (pos + 8 <= footerStart && u32(dv, pos) === CASV_RATE_BOX_MAGIC) {
    pos += 8;
  }
  // Check for CSAU.
  if (pos + 8 > footerStart) return null;
  if (u32(dv, pos) !== CASV_AUDIO_BOX_MAGIC) return null;
  const len = u32(dv, pos + 4);
  const start = pos + 8;
  if (start + len > footerStart) return null;
  return bytes.slice(start, start + len);
}

/**
 * A parsed .casv: header info + frame index, over either container shape.
 * Header-format files use absolute payload offsets; footer-format files use
 * offsets relative to byte 0 of the file (payloads come first) — both resolve
 * to absolute ranges here.
 */
export class CasvReader {
  readonly header: CasvHeader;
  readonly rate: CasvRate;
  readonly audio: CasvAudio | null;
  private readonly entries: CasvFrameEntry[];

  private constructor(header: CasvHeader, rate: CasvRate, entries: CasvFrameEntry[], audio: CasvAudio | null) {
    this.header = header;
    this.rate = rate;
    this.entries = entries;
    this.audio = audio;
  }

  get frameCount(): number {
    return this.header.frameCount;
  }

  entry(i: number): CasvFrameEntry {
    const e = this.entries[i];
    if (e === undefined) throw new RangeError(`frame ${i} out of range 0..${this.entries.length}`);
    return e;
  }

  /** Parse either container shape. Throws on malformed input. */
  static parse(bytes: Uint8Array): CasvReader {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = parseCasvHeader(bytes);
    if (header !== null) {
      const entries = CasvReader.readIndex(
        dv,
        bytes.byteLength,
        CASV_HEADER_BYTES,
        header.frameCount,
        0
      );
      return new CasvReader(header, rateFromFlags(header.flags), entries, null);
    }
    const footer = parseCasvFooter(bytes);
    if (footer !== null) {
      const entries = CasvReader.readIndex(
        dv,
        bytes.byteLength,
        footer.indexOffset,
        footer.frameCount,
        0 // footer-format offsets are relative to byte 0 (payloads first)
      );
      const flags = parseCasvRateBox(bytes) ?? 0;
      const h: CasvHeader = {
        width: footer.width,
        height: footer.height,
        frameCount: footer.frameCount,
        fpsNum: footer.fpsNum,
        fpsDen: footer.fpsDen,
        flags,
      };
      const audioBytes = parseCasvAudioBox(bytes);
      const audio: CasvAudio | null = audioBytes ? { bytes: audioBytes } : null;
      return new CasvReader(h, rateFromFlags(flags), entries, audio);
    }
    throw new Error("not a .casv file (no valid header or footer)");
  }

  private static readIndex(
    dv: DataView,
    total: number,
    indexStart: number,
    count: number,
    offsetBase: number
  ): CasvFrameEntry[] {
    const entries: CasvFrameEntry[] = [];
    for (let i = 0; i < count; i++) {
      const e = indexStart + i * CASV_INDEX_ENTRY_BYTES;
      if (e + 8 > total) throw new Error(`index entry ${i} out of file bounds`);
      const offset = offsetBase + u32(dv, e);
      const lenField = u32(dv, e + 4);
      const length = (lenField & ~CASV_FLAG_BITS) >>> 0;
      if (offset + length > total) throw new Error(`frame ${i} payload out of file bounds`);
      entries.push({
        offset,
        length,
        isPFrame: (lenField & CASV_PFRAME_FLAG) !== 0,
        isBbox: (lenField & CASV_BBOX_FLAG) !== 0,
        isTile: (lenField & CASV_TILE_FLAG) !== 0,
        isReplace: (lenField & CASV_REPLACE_FLAG) !== 0,
      });
    }
    return entries;
  }
}

export interface CasvDecodedFrame {
  /** Tightly-packed RGBA8, width*height*4 bytes. */
  rgba: Uint8Array;
  width: number;
  height: number;
  index: number;
}

export interface PlayOptions {
  /**
   * Reuse one RGBA buffer across frames (zero-copy playback: paint each frame
   * before pulling the next). Default false: every frame is an independent copy.
   */
  reuseBuffer?: boolean;
}

/** Blit an RGBA rect into the running frame. */
function blitRgba(
  dst: Uint8Array,
  dstW: number,
  x: number,
  y: number,
  w: number,
  h: number,
  src: Uint8Array,
  srcW: number,
  srcX: number,
  srcY: number
): void {
  for (let row = 0; row < h; row++) {
    const d = ((y + row) * dstW + x) * 4;
    const s = ((srcY + row) * srcW + srcX) * 4;
    dst.set(src.subarray(s, s + w * 4), d);
  }
}

/**
 * Sequential CASAVA/JOLT playback: yields every frame in order, compositing
 * REPLACE P-frames onto the running reconstruction. Supports bbox and tile
 * (v1 sliver + v2 square atlas) payloads.
 */
export async function* playCasv(
  bytes: Uint8Array,
  decodeJxl: JxlFrameDecoder,
  options: PlayOptions = {}
): AsyncGenerator<CasvDecodedFrame> {
  const reader = CasvReader.parse(bytes);
  if (reader.rate.fable) {
    throw new Error("Fable-tier .casv is native-only (braided-rANS codec has no wasm decode yet)");
  }
  const { width, height } = reader.header;
  const frameBytes = width * height * 4;
  let current: Uint8Array | null = null;

  for (let i = 0; i < reader.frameCount; i++) {
    const e = reader.entry(i);
    const payload = bytes.subarray(e.offset, e.offset + e.length);

    if (!e.isPFrame) {
      const dec = await decodeJxl(payload);
      if (dec.width !== width || dec.height !== height || dec.rgba.byteLength !== frameBytes) {
        throw new Error(`frame ${i}: I-frame dims ${dec.width}x${dec.height} != ${width}x${height}`);
      }
      if (current === null || !options.reuseBuffer) current = new Uint8Array(frameBytes);
      current.set(dec.rgba);
    } else {
      if (current === null) throw new Error(`frame ${i}: P-frame before any I-frame`);
      if (!e.isReplace) {
        throw new Error(
          `frame ${i}: residual (lossless-tier) P-frames are not supported in the browser yet`
        );
      }
      if (!options.reuseBuffer) {
        const copy = new Uint8Array(frameBytes);
        copy.set(current);
        current = copy;
      }
      if (e.isTile) {
        await applyTileReplace(current, width, height, payload, decodeJxl, i);
      } else if (e.isBbox) {
        await applyBboxReplace(current, width, payload, decodeJxl, i);
      } else {
        throw new Error(`frame ${i}: unknown P-frame kind (neither bbox nor tile)`);
      }
    }
    yield { rgba: current, width, height, index: i };
  }
}

/** Decode every frame up front (tests / small clips). */
export async function decodeCasvAll(
  bytes: Uint8Array,
  decodeJxl: JxlFrameDecoder
): Promise<CasvDecodedFrame[]> {
  const out: CasvDecodedFrame[] = [];
  for await (const f of playCasv(bytes, decodeJxl)) out.push(f);
  return out;
}

async function applyBboxReplace(
  current: Uint8Array,
  width: number,
  payload: Uint8Array,
  decodeJxl: JxlFrameDecoder,
  frameIdx: number
): Promise<void> {
  if (payload.byteLength < 8) throw new Error(`frame ${frameIdx}: short bbox payload`);
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const x = dv.getUint16(0, true);
  const y = dv.getUint16(2, true);
  const bw = dv.getUint16(4, true);
  const bh = dv.getUint16(6, true);
  if (bw === 0 || bh === 0) return; // all-zero rect = no change this frame
  const dec = await decodeJxl(payload.subarray(8));
  if (dec.width !== bw || dec.height !== bh) {
    throw new Error(`frame ${frameIdx}: bbox decode ${dec.width}x${dec.height} != ${bw}x${bh}`);
  }
  blitRgba(current, width, x, y, bw, bh, dec.rgba, bw, 0, 0);
}

async function applyTileReplace(
  current: Uint8Array,
  width: number,
  height: number,
  payload: Uint8Array,
  decodeJxl: JxlFrameDecoder,
  frameIdx: number
): Promise<void> {
  if (payload.byteLength < 2) throw new Error(`frame ${frameIdx}: short tile payload`);
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const tField = dv.getUint16(0, true);
  const v2 = (tField & CASV_TILE_V2_BIT) !== 0;
  const t = tField & ~CASV_TILE_V2_BIT;
  if (t === 0) throw new Error(`frame ${frameIdx}: zero tile size`);
  const txn = Math.ceil(width / t);
  const tyn = Math.ceil(height / t);
  const n = txn * tyn;
  const bitmapLen = Math.ceil(n / 8);
  if (payload.byteLength < 2 + bitmapLen) {
    throw new Error(`frame ${frameIdx}: tile bitmap out of payload bounds`);
  }
  const bitmap = payload.subarray(2, 2 + bitmapLen);
  const changed: number[] = [];
  for (let i = 0; i < n; i++) {
    if ((bitmap[i >> 3]! & (1 << (i & 7))) !== 0) changed.push(i);
  }
  if (changed.length === 0) return;

  const cols = v2 ? Math.ceil(Math.sqrt(changed.length)) : 1;
  const rows = Math.ceil(changed.length / cols);
  const dec = await decodeJxl(payload.subarray(2 + bitmapLen));
  if (dec.width !== cols * t || dec.height !== rows * t) {
    throw new Error(
      `frame ${frameIdx}: atlas ${dec.width}x${dec.height} != ${cols * t}x${rows * t} (v${v2 ? 2 : 1})`
    );
  }
  for (let slot = 0; slot < changed.length; slot++) {
    const i = changed[slot]!;
    const tx = i % txn;
    const ty = Math.floor(i / txn);
    const bw = Math.min(t, width - tx * t);
    const bh = Math.min(t, height - ty * t);
    const sx = (slot % cols) * t;
    const sy = Math.floor(slot / cols) * t;
    blitRgba(current, width, tx * t, ty * t, bw, bh, dec.rgba, dec.width, sx, sy);
  }
}
