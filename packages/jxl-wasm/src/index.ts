// The facade owns the role-aware `loadJxlModule({ role, tier, signal })` contract
// (Packet 3 Task 1). The low-level manifest/IDB compile helper in ./loader.ts is
// also historically named `loadJxlModule`; re-export it under an explicit alias so
// both remain reachable without an ambiguous `export *` collision.
export {
  loadJxlModule as compileJxlWasmModule,
  type JxlWasmManifest,
  type LoaderOptions,
} from "./loader.js";
export * from "./facade.js";
