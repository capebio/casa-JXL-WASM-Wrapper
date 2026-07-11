// index.ts
// Entry point for the @casabio/jxl-pyramid workspace package.
// Re-exports all schemas, constants, and test fixtures for the Pyramid Gallery Pipeline.
// Group 7: Megatexture Viewport Selection surface (choose-level + grid-layout + plan) for pan/zoom/dpr -> level + tile grids.
export * from "./manifest.js";
export * from "./manifest-validate.js";
export * from "./constants.js";
export * from "./fixtures.js";
export * from "./tiling.js";
export * from "./level-source.js";
export * from "./decode-level.js";
export * from "./choose-level.js";
export * from "./grid-layout.js";
export * from "./tiled-decode-pool.js";
export * from "./decode-core.js";
export * from "./cache.js";
export * from "./worker-protocol.js";
export { prepareDecodePlan, expandRegionByTiles } from "./plan.js";
export { PoolState, HandleState } from "./tiled-decode-pool.js";
// plan.ts: core viewport->tiles + header plan for megatexture (Group 7). Exported for direct use + pool. DecodeOptions/PyramidError from decode-core for Grok3 signal/lifecycle.
// Packet 2, Task 1 (findings 74, 77, 78): the canonical decode runtime. `createPyramidRuntime`
// is the single public decode entry point; it owns exactly one tiled worker pool for its
// lifetime so gallery code never creates a pool inside a decode call. Runtime members are
// re-exported explicitly to avoid the `LevelSource` name collision: the accepted byte-carrier
// contract from runtime.ts is surfaced here as `LevelByteSource`, while the established
// decoded-geometry union keeps the `LevelSource` name (line 11 above). Task 3 consolidates the
// two orchestration engines behind this runtime.
export { createPyramidRuntime, } from "./runtime.js";
//# sourceMappingURL=index.js.map