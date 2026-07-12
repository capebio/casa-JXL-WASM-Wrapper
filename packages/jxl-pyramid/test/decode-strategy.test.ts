import { expect, test } from "bun:test";
import { selectTileDecodeStrategy, type DecodeOptions } from "../src/decode-core.js";

/**
 * The single planner (decode-level.ts) dispatches on ONE named strategy decision instead of
 * re-deriving overlapping booleans (finding 77). selectTileDecodeStrategy is that decision — a
 * pure pool-strategy hook in decode-core: given tile count, environment worker-availability, and
 * the caller options, it returns exactly one of the accepted strategies.
 *
 *   'worker-pool'       — parallel per-tile decode across the injected/owned pool
 *   'progressive-direct'— inline dc-then-final / dc-only / skip-tile per-tile loop (no pool)
 *   'direct'            — single libjxl ROI decode (whole viewport in one WASM call)
 */

function opts(o: Partial<DecodeOptions> = {}): DecodeOptions {
  return o as DecodeOptions;
}

test("worker-pool when parallel-eligible: >1 tile, workers available, pool/factory present", () => {
  const s = selectTileDecodeStrategy({ numTiles: 4, envCanParallel: true, options: opts({ workerFactory: (() => ({})) as any }) });
  expect(s).toBe("worker-pool");
});

test("worker-pool honoured with an explicit pool even without a factory", () => {
  const s = selectTileDecodeStrategy({ numTiles: 4, envCanParallel: true, options: opts({ pool: {} as any }) });
  expect(s).toBe("worker-pool");
});

test("direct when only one tile (parallel fan-out has nothing to parallelise)", () => {
  const s = selectTileDecodeStrategy({ numTiles: 1, envCanParallel: true, options: opts({ workerFactory: (() => ({})) as any }) });
  expect(s).toBe("direct");
});

test("direct when the environment has no workers, even for many tiles", () => {
  const s = selectTileDecodeStrategy({ numTiles: 8, envCanParallel: false, options: opts({ workerFactory: (() => ({})) as any }) });
  expect(s).toBe("direct");
});

test("direct when parallel is explicitly disabled", () => {
  const s = selectTileDecodeStrategy({ numTiles: 8, envCanParallel: true, options: opts({ parallel: false, workerFactory: (() => ({})) as any }) });
  expect(s).toBe("direct");
});

test("progressive-direct for dc-then-final only when NOT worker-pool eligible (no pool/factory)", () => {
  const s = selectTileDecodeStrategy({ numTiles: 4, envCanParallel: true, options: opts({ progressive: "dc-then-final" }) });
  expect(s).toBe("progressive-direct");
});

test("progressive-direct for dc-only (pool path does not implement dc-only)", () => {
  const s = selectTileDecodeStrategy({ numTiles: 4, envCanParallel: true, options: opts({ progressive: "dc-only", workerFactory: (() => ({})) as any }) });
  expect(s).toBe("progressive-direct");
});

test("skip-tile with a progressive mode uses progressive-direct even though a factory is present (pool fails the batch)", () => {
  // skip-tile / skipTiles are only honoured inside the inline progressive loop, so they must divert
  // a would-be worker-pool decode to progressive-direct.
  const s = selectTileDecodeStrategy({ numTiles: 4, envCanParallel: true, options: opts({ progressive: "dc-then-final", errorPolicy: "skip-tile", workerFactory: (() => ({})) as any }) });
  expect(s).toBe("progressive-direct");
});

test("skipTiles resume-set with a progressive mode uses progressive-direct (not the pool)", () => {
  const s = selectTileDecodeStrategy({ numTiles: 4, envCanParallel: true, options: opts({ progressive: "dc-then-final", skipTiles: new Set(["L0-C0-R0"]), workerFactory: (() => ({})) as any }) });
  expect(s).toBe("progressive-direct");
});

test("skip-tile WITHOUT a progressive mode falls to direct (the inline skip-tile path requires progressive)", () => {
  // Matches the current planner: errorPolicy/skipTiles are only wired inside the progressive block.
  const s = selectTileDecodeStrategy({ numTiles: 4, envCanParallel: true, options: opts({ errorPolicy: "skip-tile", workerFactory: (() => ({})) as any }) });
  expect(s).toBe("direct");
});

test("direct when a custom decodeRegion is supplied (tests/mocks own the one-shot path)", () => {
  const s = selectTileDecodeStrategy({ numTiles: 4, envCanParallel: true, options: opts({ decodeRegion: (async () => ({ pixels: new Uint8Array(0), width: 0, height: 0, format: "rgba8" })), workerFactory: (() => ({})) as any }) });
  expect(s).toBe("direct");
});

test("dc-then-final with a pool prefers worker-pool (the pool implements dc-then-final)", () => {
  const s = selectTileDecodeStrategy({ numTiles: 4, envCanParallel: true, options: opts({ progressive: "dc-then-final", workerFactory: (() => ({})) as any }) });
  expect(s).toBe("worker-pool");
});
