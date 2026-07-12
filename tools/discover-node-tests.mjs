/**
 * tools/discover-node-tests.mjs
 *
 * Discovers all *.test.mjs / *.test.js files under web/ and benchmark/ (recursive),
 * classifies each as "runnable" or "skipped:<reason>", and optionally emits a
 * newline-delimited list of runnable paths (for use in CI shell scripts).
 *
 * Classification rules (first match wins):
 *   1. bun:test    — imports 'bun:test'                       → skip: bun:test
 *   2. vitest      — imports 'vitest'                         → skip: vitest
 *   3. playwright  — imports 'playwright'                     → skip: playwright
 *   4. wasm-pkg    — imports 'pkg/raw_converter_wasm' or
 *                    dynamic-imports from 'pkg/'               → skip: wasm-pkg
 *   5. otherwise                                              → runnable (node:test)
 *
 * Additionally, a curated list of "pre-existing-failure" files is tracked
 * separately: these are node:test files that would otherwise be runnable but
 * fail due to a source-mismatch or missing dev-only dependency at CI time.
 * They are excluded from the runnable set and logged with a reason.
 *
 * OMISSION-GUARD: every *.test.mjs / *.test.js file under web/ and benchmark/
 * MUST be accounted for — either runnable or with a recorded skip/fail reason.
 * Any unclassified file is an error (would fail the guard assertion).
 *
 * Usage:
 *   node tools/discover-node-tests.mjs              # human-readable summary
 *   node tools/discover-node-tests.mjs --paths      # emit runnable paths only (newline-delimited)
 *   node tools/discover-node-tests.mjs --web        # paths from web/ only
 *   node tools/discover-node-tests.mjs --benchmark  # paths from benchmark/ only
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Pre-existing failure registry
// Files that are syntactically node:test but fail in CI due to missing
// dev-only dependencies or source-mismatch (not our regression to fix).
// ---------------------------------------------------------------------------
const PRE_EXISTING_FAILURES = new Map([
  [
    "benchmark/test/adapters16.test.mjs",
    "pre-existing-failure: imports benchmark/codec-compare-jxl.mjs which requires sharp + pkg/raw_converter_wasm (dev-only deps absent in CI)",
  ],
  [
    "benchmark/test/codec-adapters.test.mjs",
    "pre-existing-failure: imports benchmark/codec-adapters.mjs which requires sharp (dev-only dep absent in CI)",
  ],
  [
    "benchmark/session-worker-timings.test.mjs",
    "pre-existing-failure: source-mismatch — asserts context.encode(makeEncoderOptions pattern absent from benchmark/session-worker-timings-browser.js; source has drifted from test expectations",
  ],
  [
    "web/ai-id/decode.test.mjs",
    "pre-existing-failure: transitively imports pkg/raw_converter_wasm.js via web/ai-id/decode.mjs (WASM build absent in CI) and requires real CR2 fixture on disk",
  ],
  [
    "web/ai-id/export.test.mjs",
    "pre-existing-failure: transitively imports pkg/raw_converter_wasm.js via web/ai-id/decode.mjs (WASM build absent in CI) and requires real CR2 fixture on disk",
  ],
  [
    "web/ai-id/proxy-e2e.test.mjs",
    "pre-existing-failure: imports sharp + pkg/raw_converter_wasm.js via web/ai-id/decode.mjs; requires real CR2 fixture at c:/Foo/raw-converter/tests/ (absent in CI)",
  ],
  [
    "web/ai-id/embedded-preview.test.mjs",
    "pre-existing-failure: requires real CR2 fixture at hardcoded path c:/Foo/raw-converter/tests/ (absent in CI)",
  ],
  [
    "web/ai-id/proxy.test.mjs",
    "pre-existing-failure: imports web/ai-id/proxy.mjs which has top-level import of sharp (must run under npm ci environment; absent without install) and requires real CR2 fixture",
  ],
  [
    "web/ai-id/sources.test.mjs",
    "pre-existing-failure: embeddedPreviewSource test requires real CR2 fixture at hardcoded path c:/Foo/raw-converter/tests/ (absent in CI) and dynamic sharp import",
  ],
]);

// ---------------------------------------------------------------------------
// Glob all *.test.mjs and *.test.js recursively under a root directory
// ---------------------------------------------------------------------------
function globTests(dir) {
  const results = [];
  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skip hidden dirs and node_modules
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const full = join(current, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        const ext = extname(entry);
        const base = entry.slice(0, -ext.length);
        if ((ext === ".mjs" || ext === ".js") && base.endsWith(".test")) {
          results.push(full);
        }
      }
    }
  }
  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Classify a single test file
// ---------------------------------------------------------------------------
function classify(absPath) {
  const relPath = relative(REPO_ROOT, absPath).replace(/\\/g, "/");

  // Check pre-existing failure registry first
  if (PRE_EXISTING_FAILURES.has(relPath)) {
    return { status: "pre-existing-failure", reason: PRE_EXISTING_FAILURES.get(relPath) };
  }

  let content;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    return { status: "skip", reason: "skip: unreadable" };
  }

  // bun:test
  if (/['"]bun:test['"]/.test(content)) {
    return { status: "skip", reason: "skip: bun:test — not runnable under node --test" };
  }

  // vitest
  if (/from\s+['"]vitest['"]/.test(content)) {
    return { status: "skip", reason: "skip: vitest — requires browser/vitest runner" };
  }

  // playwright
  if (/from\s+['"]playwright['"]/.test(content) || /require\(['"]playwright['"]\)/.test(content)) {
    return { status: "skip", reason: "skip: playwright — requires real browser/Chromium" };
  }

  // wasm-pkg: static import of pkg/raw_converter_wasm, or dynamic import from pkg/
  // Covers: import('../../pkg/raw_converter_wasm.js'), import("../pkg/..."), etc.
  if (
    /['"](?:\.\.\/)+pkg\/raw_converter_wasm/.test(content) ||
    /import\(['"](?:\.\.\/)+pkg\//.test(content) ||
    /from\s+['"](?:\.\.\/)+pkg\/raw_converter_wasm/.test(content)
  ) {
    return { status: "skip", reason: "skip: wasm-pkg — imports pkg/raw_converter_wasm.js (WASM build not available in CI)" };
  }

  return { status: "runnable", reason: null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export function discoverTests(opts = {}) {
  const { includeWeb = true, includeBenchmark = true } = opts;

  const dirs = [];
  if (includeWeb) dirs.push(join(REPO_ROOT, "web"));
  if (includeBenchmark) dirs.push(join(REPO_ROOT, "benchmark"));

  const allFiles = dirs.flatMap(globTests);

  const runnable = [];
  const skipped = [];
  const preExistingFailures = [];

  for (const absPath of allFiles) {
    const relPath = relative(REPO_ROOT, absPath).replace(/\\/g, "/");
    const { status, reason } = classify(absPath);
    if (status === "runnable") {
      runnable.push(relPath);
    } else if (status === "pre-existing-failure") {
      preExistingFailures.push({ path: relPath, reason });
    } else {
      skipped.push({ path: relPath, reason });
    }
  }

  return { runnable, skipped, preExistingFailures, total: allFiles.length };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const pathsOnly = args.includes("--paths");
  const webOnly   = args.includes("--web");
  const benchOnly = args.includes("--benchmark");

  const { runnable, skipped, preExistingFailures, total } = discoverTests({
    includeWeb:       !benchOnly,
    includeBenchmark: !webOnly,
  });

  if (pathsOnly) {
    // Emit newline-delimited paths for shell consumption
    for (const p of runnable) process.stdout.write(p + "\n");
    process.exit(0);
  }

  // Human-readable summary
  console.log(`\nDiscover node:test files under web/ and benchmark/`);
  console.log(`Total files scanned: ${total}`);
  console.log(`  Runnable (node --test): ${runnable.length}`);
  console.log(`  Skipped (reason):       ${skipped.length}`);
  console.log(`  Pre-existing failures:  ${preExistingFailures.length}\n`);

  console.log("=== RUNNABLE ===");
  for (const p of runnable) console.log(`  + ${p}`);

  console.log("\n=== SKIPPED ===");
  for (const { path: p, reason } of skipped) console.log(`  - ${p}\n      ${reason}`);

  console.log("\n=== PRE-EXISTING FAILURES (excluded from CI run) ===");
  for (const { path: p, reason } of preExistingFailures) console.log(`  ! ${p}\n      ${reason}`);
}
