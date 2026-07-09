import { describe, expect, test } from 'bun:test';
import { tryDecodeHandRaw } from './hand-raw-decoders.js';

function putAscii(bytes, offset, text) {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  bytes[offset + text.length] = 0;
}

function makeSyntheticTiffRaw({ magic = 42, name = 'NIKON', model = 'SYNTH', compression = 1, bits = 16 } = {}) {
  const width = 4;
  const height = 4;
  const bytes = new Uint8Array(768);
  const dv = new DataView(bytes.buffer);
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  dv.setUint16(2, magic, true);
  dv.setUint32(4, 8, true);

  const makeOff = 220;
  const modelOff = 240;
  const rawOff = 512;
  putAscii(bytes, makeOff, name);
  putAscii(bytes, modelOff, model);
  for (let i = 0; i < width * height; i++) dv.setUint16(rawOff + i * 2, 1000 + i, true);

  const entries = [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 1, bits],
    [259, 3, 1, compression],
    [262, 3, 1, 32803],
    [271, 2, name.length + 1, makeOff],
    [272, 2, model.length + 1, modelOff],
    [273, 4, 1, rawOff],
    [274, 3, 1, 1],
    [277, 3, 1, 1],
    [278, 4, 1, height],
    [279, 4, 1, width * height * 2],
    [33421, 3, 2, 0x00020002],
    [33422, 1, 4, 0x02010100],
  ];
  dv.setUint16(8, entries.length, true);
  let p = 10;
  for (const [tag, type, count, value] of entries) {
    dv.setUint16(p, tag, true);
    dv.setUint16(p + 2, type, true);
    dv.setUint32(p + 4, count, true);
    if (type === 3 && count === 1) dv.setUint16(p + 8, value, true);
    else dv.setUint32(p + 8, value, true);
    p += 12;
  }
  dv.setUint32(p, 0, true);
  return bytes;
}

describe('hand RAW decoders', () => {
  test('decodes uncompressed 16-bit NEF-like Bayer TIFF', () => {
    const result = tryDecodeHandRaw(makeSyntheticTiffRaw(), 'sample.NEF');
    expect(result.ok).toBe(true);
    expect(result.payload.decoder).toBe('hand:nef');
    expect(result.payload.width).toBe(4);
    expect(result.payload.height).toBe(4);
    expect(result.payload.cfaPhase).toBe(0);
    expect(result.payload.raw[0]).toBe(1000);
    expect(result.payload.raw[15]).toBe(1015);
    expect(result.payload.make).toBe('NIKON');
  });

  test('decodes uncompressed 16-bit RW2-like TIFF variant', () => {
    const result = tryDecodeHandRaw(makeSyntheticTiffRaw({ magic: 85, name: 'Panasonic', model: 'RW2' }), 'sample.RW2');
    expect(result.ok).toBe(true);
    expect(result.payload.decoder).toBe('hand:rw2');
    expect(result.payload.make).toBe('Panasonic');
  });

  test('falls back for compressed NEF data', () => {
    const result = tryDecodeHandRaw(makeSyntheticTiffRaw({ compression: 34713 }), 'compressed.NEF');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('LibRaw');
  });

  test('identifies CRW CIFF as LibRaw fallback', () => {
    const result = tryDecodeHandRaw(new Uint8Array([0x49, 0x49, 0x1a, 0x00, 0, 0, 0, 0]), 'canon.CRW');
    expect(result.ok).toBe(false);
    expect(result.format).toBe('crw');
    expect(result.reason).toContain('LibRaw');
  });
});
