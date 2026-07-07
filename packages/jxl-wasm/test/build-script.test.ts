import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const scriptPath = new URL("../scripts/build.mjs", import.meta.url);
const source = readFileSync(scriptPath, "utf8");

test("build script uses plain JavaScript syntax", () => {
  expect(source).not.toContain(' as const;');
  expect(source).not.toContain("type ModuleKind");
  expect(source).not.toContain("kind: ModuleKind");
  expect(source).not.toContain("exportsFile: string");
  expect(source).not.toContain("initialMem: number");
});

test("skipped MT tiers are qualified by module kind", () => {
  expect(source).toContain(".flatMap((tier) => moduleKinds.map((kind) => `${kind}:${tier.name}`))");
});

test("parallelism defaults to host CPU count", () => {
  expect(source).toContain("os.availableParallelism?.() ?? os.cpus().length");
});

test("docker build forwards CLI flags", () => {
  expect(source).toMatch(/const passthrough = process\.argv\.slice\(2\)\.filter\(\(arg\) => arg !== "--inside-docker"\)/);
  expect(source).toMatch(/"--inside-docker"/);
  expect(source).toMatch(/\.\.\.passthrough/);
});

test("docker path fails closed when LIBJXL_SRC_DIR (the fork) is set", () => {
  // The docker path builds STOCK UPSTREAM libjxl and ignores LIBJXL_SRC_DIR, so a caller who
  // set the fork (external/libjxl-012) would otherwise silently ship an upstream bridge. The
  // guard must throw before any docker work. (Asserted at source level, on stable tokens
  // rather than exact prose: running the real build needs docker+emsdk and is not hermetic —
  // the PGO auto-stage would write into dist/.)
  expect(source).toMatch(/if \(!insideDocker && !hostToolchain\)/);              // guard is docker-branch only
  expect(source).toMatch(/useLocalSource && !process\.argv\.includes\("--allow-upstream-docker"\)/); // fork set + no override
  expect(source).toMatch(/throw new Error\([\s\S]*?builds STOCK[\s\S]*?UPSTREAM libjxl[\s\S]*?--host-toolchain/); // fail closed, points at the fix
});

test("size budget violations fail the build after manifest write", () => {
  expect(source).toMatch(/const budgetViolations = \[\]/);
  expect(source).toMatch(/budgetViolations\.push\(/);
  // Oversized artifacts ARE fatal (unlike missing exports) — assert it still throws.
  expect(source).toMatch(/throw new Error\([^\n]*Size budgets exceeded/);
});

test("build workdirs are removed after success unless keep-work is set", () => {
  expect(source).toContain('const keepWork = process.argv.includes("--keep-work");');
  expect(source).toContain("if (!keepWork) {");
  expect(source).toContain("await rmDir(buildDir);");
});

test("bridge exports are preflighted before the build matrix runs", () => {
  expect(source).toContain("await validateBridgeExports();");
  expect(source).toContain("function findBridgeExportMismatches(");
});

test("incoming Module API is trimmed to handwritten loader hooks", () => {
  expect(source).toContain('return "-sINCOMING_MODULE_JS_API=locateFile,wasmBinary";');
});

test("artifact metadata records wire bytes and SRI hashes", () => {
  expect(source).toContain("jsBrotliBytes");
  expect(source).toContain("wasmBrotliBytes");
  expect(source).toContain("jsIntegrity");
  expect(source).toContain("wasmIntegrity");
  expect(source).toContain('sha384-${createHash("sha384").update(data).digest("base64")}');
});

test("wasm artifacts are validated against their exports files", () => {
  // Structural (token match, not exact statement — survives reformatting): validation is
  // wired into the matrix and reads the real wasm exports.
  expect(source).toMatch(/validateWasmArtifact\(outWasm, exportsFile, tierKey/);
  expect(source).toMatch(/WebAssembly\.Module\.exports\(module\)/);
  // A missing export is a WARNING, not fatal: -O3 minifies export names, so the JS glue
  // maps the public _ API and a name mismatch is expected — failing the build here would
  // break every -O3 tier. Assert it warns and does NOT regress back to a throw.
  expect(source).toMatch(/console\.error\([^\n]*exports missing from wasm/);
  expect(source).not.toMatch(/throw new Error\([^\n]*exports missing from wasm/);
});

test("size report can request symbol maps and prints real rebuild command", () => {
  expect(source).toContain('const sizeReportRequested = process.argv.includes("--size-report");');
  expect(source).toContain('"--emit-symbol-map"');
  expect(source).toContain('formatBuildCommand(["--size-report"])');
});
