// Contract test for the tiled-decode worker protocol (S2 / QUESTIONS §003.B).
//
// The web worker (web/lightbox/tiled-decode-worker.js) and the pool
// (tiled-decode-pool.ts) must agree on a single versioned message shape, or the
// pool watchdog marks the worker Bad and every tiled decode silently
// full-decodes. This test pins BOTH directions of that contract WITHOUT a real
// Worker/WASM (which the fresh worktree can't resolve): it exercises the
// shared `validateWorkerRequest` guard against the exact request shapes the pool
// emits, and statically asserts the worker source speaks the matching reply
// protocol (ready / decode-reply with w,h / v:1 / format-keyed 16-bit).
//
// The real-Worker end-to-end path is covered by
// decode-pool.worker.integration.test.ts (needs the @casabio/jxl-wasm workspace
// linked), which is not runnable in this worktree — see the S2 handoff.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateWorkerRequest } from "../src/worker-protocol.js";

// worker-protocol.ts has only type-only imports, so it loads with no runtime deps.

test("validateWorkerRequest accepts every request shape the pool emits", () => {
  // load (structured-clone bytes)
  expect(() => validateWorkerRequest({ v: 1, type: "load", bytesId: 1, bytes: new Uint8Array(8) })).not.toThrow();
  // decode rgba8 + rgba16
  expect(() => validateWorkerRequest({ v: 1, type: "decode", id: 3, bytesId: 1, region: { x: 0, y: 0, w: 16, h: 16 }, format: "rgba8" })).not.toThrow();
  expect(() => validateWorkerRequest({ v: 1, type: "decode", id: 4, bytesId: 1, region: { x: 8, y: 8, w: 4, h: 4 }, format: "rgba16" })).not.toThrow();
  // cancel
  expect(() => validateWorkerRequest({ v: 1, type: "cancel", id: 3 })).not.toThrow();
});

test("validateWorkerRequest rejects malformed / legacy shapes", () => {
  // wrong protocol version
  expect(() => validateWorkerRequest({ v: 2, type: "load", bytesId: 1, bytes: new Uint8Array(1) })).toThrow();
  // missing bytesId on load
  expect(() => validateWorkerRequest({ v: 1, type: "load", bytes: new Uint8Array(1) })).toThrow();
  // decode without a numeric region
  expect(() => validateWorkerRequest({ v: 1, type: "decode", id: 1, bytesId: 1, region: { x: 0, y: 0 }, format: "rgba8" })).toThrow();
  // unknown format (the pre-rewrite worker keyed off `bpp`, never `format`)
  expect(() => validateWorkerRequest({ v: 1, type: "decode", id: 1, bytesId: 1, region: { x: 0, y: 0, w: 1, h: 1 }, format: "rgba32" })).toThrow();
  // unknown message type
  expect(() => validateWorkerRequest({ v: 1, type: "frobnicate" })).toThrow();
  // not an object
  expect(() => validateWorkerRequest(null)).toThrow();
});

test("web worker source conforms to the v:1 reply protocol", () => {
  const src = readFileSync(new URL("../../../web/lightbox/tiled-decode-worker.js", import.meta.url), "utf8");

  // Announces readiness with the versioned ready message (pool's whenReady).
  expect(src).toMatch(/postMessage\(\s*\{\s*v:\s*1,\s*type:\s*['"]ready['"]/);
  // Handles all three inbound request types.
  expect(src).toMatch(/type\s*===\s*['"]load['"]/);
  expect(src).toMatch(/type\s*===\s*['"]decode['"]/);
  expect(src).toMatch(/type\s*===\s*['"]cancel['"]/);
  // Replies with decode-reply carrying w/h (NOT width/height) and v:1.
  expect(src).toMatch(/type:\s*['"]decode-reply['"]/);
  expect(src).toMatch(/\bw:\s*out\.width\b/);
  expect(src).toMatch(/\bh:\s*out\.height\b/);
  // Bit depth is keyed off the pool's `format` field, not the legacy `bpp`.
  expect(src).toMatch(/format\s*===\s*['"]rgba16['"]/);
  expect(src).not.toMatch(/\bconst\s+use16\s*=\s*bpp\b/);
  // Load-once cache keyed by bytesId (the structured-clone amplification fix).
  expect(src).toMatch(/byteStore/);
  expect(src).toMatch(/\.get\(\s*bytesId\s*\)/);
  // Guards the protocol version on inbound messages.
  expect(src).toMatch(/msg\.v\s*!==\s*1/);
});
