import { describe, expect, test } from "bun:test";
import {
  CasvReader,
  parseCasvAudioBox,
  CASV_AUDIO_BOX_MAGIC,
  CASV_RATE_BOX_MAGIC,
  CASV_FOOTER_BYTES,
  CASV_INDEX_ENTRY_BYTES,
} from "../src/index";

/**
 * Build a minimal valid footer-format .casv binary with an optional CSAU box.
 * Layout: [1-byte fake payload][8-byte index entry][8-byte CASR][8+N CSAU?][32-byte footer]
 */
function makeTestCasv(audio?: Uint8Array): Uint8Array {
  const CASV_FOOTER_MAGIC = 0x4653_4143;
  const FAKE_PAYLOAD = new Uint8Array([0xff]);

  // Index entry: payload at offset 0, len = 1
  const INDEX = new Uint8Array(CASV_INDEX_ENTRY_BYTES);
  const idv = new DataView(INDEX.buffer);
  idv.setUint32(0, 0, true); // payload offset = 0
  idv.setUint32(4, 1, true); // length = 1

  // CASR box: [magic][flags=0]
  const CASR = new Uint8Array(8);
  const cdv = new DataView(CASR.buffer);
  cdv.setUint32(0, CASV_RATE_BOX_MAGIC, true);
  cdv.setUint32(4, 0, true);

  // CSAU box (optional)
  const CSAU = audio
    ? (() => {
        const b = new Uint8Array(8 + audio.length);
        const dv = new DataView(b.buffer);
        dv.setUint32(0, CASV_AUDIO_BOX_MAGIC, true);
        dv.setUint32(4, audio.length, true);
        b.set(audio, 8);
        return b;
      })()
    : new Uint8Array(0);

  // Footer: index_offset = 1 (after 1-byte fake payload)
  const FOOTER = new Uint8Array(CASV_FOOTER_BYTES);
  const fdv = new DataView(FOOTER.buffer);
  fdv.setBigUint64(0, BigInt(FAKE_PAYLOAD.length), true); // index_offset = 1
  fdv.setUint32(8, 1, true);   // width
  fdv.setUint32(12, 1, true);  // height
  fdv.setUint32(16, 1, true);  // frame_count
  fdv.setUint32(20, 30, true); // fps_num
  fdv.setUint32(24, 1, true);  // fps_den
  fdv.setUint32(28, CASV_FOOTER_MAGIC, true);

  const parts = [FAKE_PAYLOAD, INDEX, CASR, CSAU, FOOTER];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

describe("parseCasvAudioBox", () => {
  test("returns audio bytes when CSAU present", () => {
    const fakeAudio = new Uint8Array([1, 2, 3, 4, 5]);
    const casv = makeTestCasv(fakeAudio);
    const result = parseCasvAudioBox(casv);
    expect(result).not.toBeNull();
    expect(result).toEqual(fakeAudio);
  });

  test("returns null when no CSAU box", () => {
    const casv = makeTestCasv();
    expect(parseCasvAudioBox(casv)).toBeNull();
  });

  test("returns null on empty buffer", () => {
    expect(parseCasvAudioBox(new Uint8Array(0))).toBeNull();
  });
});

describe("CasvReader.audio", () => {
  test("is populated when CSAU box present", () => {
    const fakeAudio = new Uint8Array([0x4f, 0x53, 0x00]);
    const casv = makeTestCasv(fakeAudio);
    const reader = CasvReader.parse(casv);
    expect(reader.audio).not.toBeNull();
    expect(reader.audio!.bytes).toEqual(fakeAudio);
  });

  test("is null when no CSAU box", () => {
    const casv = makeTestCasv();
    const reader = CasvReader.parse(casv);
    expect(reader.audio).toBeNull();
  });
});
