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

// ---------------------------------------------------------------------------
// Finding 23 (P0): build provenance wiring
// ---------------------------------------------------------------------------

test("provenance module is imported from provenance.mjs", () => {
  // All three consumers must be imported: computeInputDigest (stamp), canMergePartialTier
  // (merge guard), validateProvenance (release-dirty rejection).
  expect(source).toContain('import { computeInputDigest, canMergePartialTier, validateProvenance } from "./provenance.mjs"');
});

test("getSourceInfo reads git HEAD + dirty status of the package tree", () => {
  // Must resolve the package root's git HEAD (sourceCommit) and run git status --porcelain
  // (sourceDirty). Falls back without throwing when git is unavailable.
  expect(source).toContain("async function getSourceInfo()");
  expect(source).toMatch(/git.*rev-parse.*HEAD/);
  expect(source).toMatch(/git.*status.*--porcelain/);
  expect(source).toMatch(/commit.*dirty|dirty.*commit/);
});

test("hashFile helper computes SHA-256 of file contents", () => {
  expect(source).toContain("async function hashFile(");
  expect(source).toMatch(/createHash.*sha256.*update.*digest.*hex/);
});

test("provenance inputs are computed per kind before the build matrix", () => {
  // bridgeSourceHash and buildScriptHash are hashed once; exportsHash is per-kind.
  expect(source).toContain("const bridgeSourceHash = await hashFile(");
  expect(source).toContain("const buildScriptHash = await hashFile(");
  expect(source).toContain("const exportsHashByKind = {}");
  expect(source).toMatch(/exportsHashByKind\[kind\] = await hashFile\(/);
});

test("each tier entry is stamped with a complete provenance object", () => {
  // The tier entry written to manifest.tiers[tierKey] must include a provenance field
  // containing inputDigest (computed via computeInputDigest), sourceCommit, sourceDirty,
  // libjxlCommit, libjxlDirty, toolchain, role, tier, and flags.
  expect(source).toContain("const provenance = {");
  expect(source).toContain("inputDigest: computeInputDigest(provenanceInputs)");
  expect(source).toContain("sourceCommit: sourceInfo.commit");
  expect(source).toContain("sourceDirty: sourceInfo.dirty");
  expect(source).toContain("provenance");
});

test("validateProvenance is called per tier and rejects release builds with dirty source", () => {
  // validateProvenance must be called after building provenance, before writing the manifest entry.
  // The --release flag must be forwarded so release builds reject dirty source/libjxl.
  expect(source).toMatch(/validateProvenance\(provenance,/);
  expect(source).toMatch(/releaseMode.*process\.argv\.includes\(["']--release["']\)/);
});

test("partial-tier manifest merge uses canMergePartialTier to guard stale entries", () => {
  // The writeManifest merge must NOT blindly spread existing tiers into the new manifest.
  // It must check canMergePartialTier for each existing entry before keeping it.
  // Legacy entries (no provenance) must be rejected by the guard.
  expect(source).toContain("canMergePartialTier(existingEntry, incomingEntry)");
  // A mismatch must warn (not silently keep the stale entry).
  // The warn message may span lines (template literal + string concat), so search for the
  // key phrase independently of the console.warn call site.
  expect(source).toMatch(/stale tier entry/);
});

test("role→artifact naming is a single documented contract the facade loader mirrors", () => {
  // The facade's role loader requests `jxl-core.<rolePrefix>.<tier>.js` where
  // rolePrefix is `dec` for the decode role and `enc` for encode/perceptual.
  // build.mjs must emit exactly those prefixes so the two stay in lockstep.
  expect(source).toContain("ARTIFACT_PREFIX_BY_ROLE");
  expect(source).toMatch(/decode:\s*"dec"/);
  expect(source).toMatch(/encode:\s*"enc"/);
  expect(source).toMatch(/perceptual:\s*"enc"/);
  // Emitted artifact base name still keys on module kind × tier.
  expect(source).toContain("jxl-core.${kind}.${tier.name}");
});
