import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as C from "../src/index";

// K6#3 — CASV constants single source of truth.
//
// casv-format.json (repo root) is the shared contract for the CASAVA (.casv)
// container constants. The raw-pipeline Rust test pins the Rust consts to it;
// this test pins the casv-web TS consts to it. A drift on either side (or in the
// JSON itself) fails one of the two parity tests, so the two language ports can
// never silently diverge (the header-comment "Mirrors casa_video.rs" is now
// enforced, not aspirational).

const fmt = JSON.parse(
  readFileSync(new URL("../../../casv-format.json", import.meta.url), "utf8")
) as Record<string, number>;

describe("casv-format.json single-source parity", () => {
  test("every casv-web CASV constant matches the shared JSON", () => {
    const pairs: [string, number][] = [
      ["CASV_MAGIC", C.CASV_MAGIC],
      ["CASV_VERSION", C.CASV_VERSION],
      ["CASV_HEADER_BYTES", C.CASV_HEADER_BYTES],
      ["CASV_INDEX_ENTRY_BYTES", C.CASV_INDEX_ENTRY_BYTES],
      ["CASV_PFRAME_FLAG", C.CASV_PFRAME_FLAG],
      ["CASV_BBOX_FLAG", C.CASV_BBOX_FLAG],
      ["CASV_TILE_FLAG", C.CASV_TILE_FLAG],
      ["CASV_REPLACE_FLAG", C.CASV_REPLACE_FLAG],
      ["CASV_HDR_FABLE_FLAG", C.CASV_HDR_FABLE_FLAG],
      ["CASV_TILE_V2_BIT", C.CASV_TILE_V2_BIT],
      ["CASV_HDRFLAG_LOSSY", C.CASV_HDRFLAG_LOSSY],
      ["CASV_FOOTER_MAGIC", C.CASV_FOOTER_MAGIC],
      ["CASV_FOOTER_BYTES", C.CASV_FOOTER_BYTES],
      ["CASV_AUDIO_BOX_MAGIC", C.CASV_AUDIO_BOX_MAGIC],
      ["CASV_RATE_BOX_MAGIC", C.CASV_RATE_BOX_MAGIC],
    ];
    for (const [name, val] of pairs) {
      expect(fmt[name], `${name} drift vs casv-format.json`).toBe(val);
    }
    // Exactly these 15 CASV_ keys in the shared file — catches a key added,
    // renamed, or removed on either side of the contract.
    const keys = Object.keys(fmt).filter((k) => k.startsWith("CASV_"));
    expect(keys.length).toBe(15);
  });
});
