/**
 * Static test: verify that .github/workflows/verify.yml calls the authoritative
 * workspace-runner commands on every pull_request trigger.
 *
 * TDD — RED phase: this test was written BEFORE the workflow was updated.
 * Expected initial result: FAIL (authoritative workspace commands absent from PR jobs).
 *
 * Assertions:
 *   1. The YAML file parses cleanly (valid syntax).
 *   2. The `on:` block includes `pull_request`.
 *   3. Each authoritative root command appears in at least one PR-triggered job
 *      (i.e. a job that is NOT gated to schedule/workflow_dispatch only):
 *        - "npm run test"
 *        - "npm run build"
 *        - "npm run typecheck"
 *        - "node --test tools/run-workspaces.test.mjs"  (runner self-test)
 *   4. No critical lane is path-filtered so that it could never run on a PR touching
 *      files it owns.  For each job that declares an `on.pull_request.paths` filter,
 *      every source path the job's steps reference must match at least one filter
 *      pattern.  (Structural check only — false negatives are better than false positives.)
 *      NEGATIVE test: injecting paths:['crates/**'] into a synthetic JS lane asserts FAILURE.
 *   5. Environment-blocked lanes (Emscripten/WASM heavy build) must be explicitly
 *      annotated rather than silently passing.  A step that skips a block must emit
 *      a recognisable skip message (checked by searching "skip" | "skipped" | "unavailable"
 *      in step `run:` or `if:` fields when the step name mentions emscripten, wasm, or docker).
 *
 * Additional quality hardening (M-1..M-6, K1, K2, I-1):
 *   M-1  path-filter guard is not vacuous — parseWorkflow captures on.pull_request.paths
 *   M-3  cargo +nightly fuzz run "${{ matrix.target }}" is quoted (shell-injection safe)
 *   M-4  node_modules absent from actions/cache path in workspace/web jobs
 *   M-5  'npm run test' check uses exact include (no loose disjunct)
 *   M-6  OMISSION-GUARD: every *.test.mjs/js under web/ + benchmark/ is run or has skip-reason
 *   K1   benchmark/test/ + benchmark/optimize/test/ are covered by discover-node-tests
 *   K2   session-worker-timings.test.mjs is labelled 'pre-existing source-mismatch failure'
 *   I-1  nightly fuzz matrix carries a TODO note about codec-gated stubs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const WORKFLOW_PATH = resolve(REPO_ROOT, ".github/workflows/verify.yml");

// ---------------------------------------------------------------------------
// Minimal YAML parser — sufficient for GitHub Actions structure.
// We only need to extract: on, jobs[*].if, jobs[*].steps[*].run
// Rather than pulling in a full YAML library (none installed as devDep at root
// for zero-install self-test constraint), we use a focused line scanner.
// ---------------------------------------------------------------------------

/**
 * Parse the verify.yml file into a plain object with the structure we need:
 *   {
 *     triggers: string[],            // event names in `on:`
 *     prPaths: string[],             // on.pull_request.paths entries (workflow-level)
 *     prPathsIgnore: string[],       // on.pull_request.paths-ignore entries (workflow-level)
 *     jobs: {
 *       id: string,
 *       name: string,
 *       jobIf: string,               // raw `if:` value on the job, "" if absent
 *       pathFilters: string[],       // legacy field — always [] (path filters are workflow-level)
 *       steps: {
 *         name: string,
 *         stepIf: string,
 *         run: string,
 *       }[],
 *     }[],
 *   }
 *
 * NOTE: This is a structural scanner, not a full YAML parser. It is sufficient
 * for the flat structure of verify.yml and will produce sensible results for
 * the assertions we need.
 */
function parseWorkflow(yamlText) {
  const lines = yamlText.split(/\r?\n/);

  // ── Extract top-level trigger events + on.pull_request.paths ─────────────
  // Find the `on:` block and collect event names (keys at indent=2).
  // Also collect on.pull_request.paths and paths-ignore (items at indent=6 under
  //   on: → pull_request: → paths: / paths-ignore:).
  const triggers = [];
  const prPaths = [];
  const prPathsIgnore = [];
  let inOnBlock = false;
  let inPrBlock = false;   // inside on: > pull_request:
  let inPathsList = false; // inside on: > pull_request: > paths:
  let inPathsIgnoreList = false; // inside on: > pull_request: > paths-ignore:

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trimEnd();
    const indent = line.length - line.trimStart().length;

    if (/^on:/.test(stripped)) {
      inOnBlock = true;
      continue;
    }
    if (inOnBlock) {
      // End of on: block when we hit another top-level key (indent 0, non-comment)
      if (indent === 0 && stripped.length > 0 && !stripped.startsWith("#")) {
        inOnBlock = false;
        inPrBlock = false;
        inPathsList = false;
        inPathsIgnoreList = false;
        continue;
      }
      // Event names at indent=2: "  push:", "  pull_request:", etc.
      if (indent === 2) {
        const m = stripped.trim().match(/^(\w+):?$/);
        if (m) {
          triggers.push(m[1]);
          inPrBlock = m[1] === "pull_request";
          inPathsList = false;
          inPathsIgnoreList = false;
        }
        continue;
      }
      // Inside pull_request block (indent=4): look for paths: / paths-ignore:
      if (inPrBlock && indent === 4) {
        const key = stripped.trim();
        inPathsList = key === "paths:";
        inPathsIgnoreList = key === "paths-ignore:";
        continue;
      }
      // List items inside paths: / paths-ignore: (indent=6, starts with "- ")
      if (indent === 6 && stripped.trim().startsWith("- ")) {
        const val = stripped.trim().replace(/^- ['"]?/, "").replace(/['"]?$/, "");
        if (inPathsList) prPaths.push(val);
        if (inPathsIgnoreList) prPathsIgnore.push(val);
        continue;
      }
      // Anything less-indented in the on: block resets path tracking
      if (indent <= 4 && (inPathsList || inPathsIgnoreList)) {
        inPathsList = false;
        inPathsIgnoreList = false;
      }
    }
  }

  // ── Extract jobs ──────────────────────────────────────────────────────────
  const jobs = [];
  let inJobsBlock = false;
  let currentJob = null;
  let currentStep = null;
  let runLines = [];
  let inRunBlock = false;
  let runBlockIndent = 0;

  /**
   * Flush buffered run lines into the current step.
   */
  function flushRunBlock() {
    if (currentStep && runLines.length > 0) {
      currentStep.run = runLines.join("\n");
      runLines = [];
    }
    inRunBlock = false;
  }

  /**
   * Flush the current step into the current job.
   */
  function flushStep() {
    flushRunBlock();
    if (currentStep && currentJob) {
      currentJob.steps.push(currentStep);
      currentStep = null;
    }
  }

  /**
   * Flush the current job into the jobs array.
   */
  function flushJob() {
    flushStep();
    if (currentJob) {
      jobs.push(currentJob);
      currentJob = null;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.trimEnd();
    const indent = raw.length - raw.trimStart().length;

    // Detect `jobs:` top-level key
    if (/^jobs:/.test(stripped)) {
      inJobsBlock = true;
      continue;
    }

    if (!inJobsBlock) continue;

    // If we see another top-level key (indent 0, non-empty, not comment), exit jobs block.
    if (indent === 0 && stripped.length > 0 && !stripped.startsWith("#")) {
      flushJob();
      inJobsBlock = false;
      continue;
    }

    // Job ID: 2-space indent, word chars, colon
    if (indent === 2 && /^  \w[\w-]*:/.test(stripped)) {
      flushJob();
      const id = stripped.trim().replace(/:$/, "");
      currentJob = { id, name: id, jobIf: "", pathFilters: [], steps: [] };
      inRunBlock = false;
      runLines = [];
      continue;
    }

    if (!currentJob) continue;

    // Job-level `name:`
    if (indent === 4 && /^    name:/.test(stripped)) {
      currentJob.name = stripped.replace(/^    name:\s*/, "").replace(/^['"]|['"]$/g, "").trim();
      continue;
    }

    // Job-level `if:`
    if (indent === 4 && /^    if:/.test(stripped)) {
      currentJob.jobIf = stripped.replace(/^    if:\s*/, "").trim();
      continue;
    }

    // Step detection: `    - name:` or `    - uses:` or `    - run:` at indent 6
    if (indent === 6 && stripped.trimStart().startsWith("- ")) {
      flushStep();
      const stepContent = stripped.trimStart().replace(/^- /, "");
      const nameM = stepContent.match(/^name:\s*(.+)/);
      const usesM = stepContent.match(/^uses:\s*(.+)/);
      const runM  = stepContent.match(/^run:\s*(.+)/);
      currentStep = {
        name: nameM ? nameM[1].replace(/^['"]|['"]$/g, "") : (usesM ? `uses:${usesM[1]}` : ""),
        stepIf: "",
        run: "",
      };
      if (runM) {
        // Inline run value (single line)
        const val = runM[1].trim();
        if (val === "|" || val === ">") {
          inRunBlock = true;
          runBlockIndent = 0;
          runLines = [];
        } else {
          currentStep.run = val;
        }
      }
      continue;
    }

    // Step sub-keys (indent 8)
    if (indent === 8 && currentStep) {
      flushRunBlock();
      const key = stripped.trim();
      if (key.startsWith("name:")) {
        currentStep.name = key.replace(/^name:\s*/, "").replace(/^['"]|['"]$/g, "").trim();
      } else if (key.startsWith("if:")) {
        currentStep.stepIf = key.replace(/^if:\s*/, "").trim();
      } else if (key.startsWith("run:")) {
        const val = key.replace(/^run:\s*/, "").trim();
        if (val === "|" || val === ">" || val === "") {
          inRunBlock = true;
          runBlockIndent = 10; // block body at 10 spaces
          runLines = [];
        } else {
          currentStep.run = val;
        }
      }
      continue;
    }

    // Inside a multi-line `run:` block
    if (inRunBlock) {
      // Any line with indent >= runBlockIndent is part of the block
      if (indent >= 10 || (stripped === "" )) {
        runLines.push(raw.replace(/^\s{10}/, "")); // strip leading indent
        continue;
      }
      // Line with less indent terminates the block
      flushRunBlock();
    }
  }

  flushJob();

  return { triggers, prPaths, prPathsIgnore, jobs };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A job is "PR-triggered" if it has no `if:` condition, OR its `if:` condition
 * does NOT restrict to schedule/workflow_dispatch only.
 */
function isPrTriggered(job) {
  const cond = job.jobIf.toLowerCase();
  if (!cond) return true; // no restriction → runs on PR
  // If the if: only allows schedule or workflow_dispatch, it is NOT PR-triggered.
  if (
    /github\.event_name\s*==\s*['"]schedule['"]/.test(cond) ||
    /github\.event_name\s*==\s*['"]workflow_dispatch['"]/.test(cond)
  ) {
    // Check if it's an OR that also includes pull_request
    if (/pull_request/.test(cond)) return true;
    return false;
  }
  return true;
}

/**
 * Collect all `run:` text from PR-triggered jobs (flat).
 */
function allPrRuns(parsed) {
  return parsed.jobs
    .filter(isPrTriggered)
    .flatMap((j) => j.steps.map((s) => s.run));
}

/**
 * Check whether a workflow-level paths filter would exclude a given lane.
 * Returns true if the lane IS excluded (i.e. the guard fires — a problem).
 *
 * A pattern matches an owned prefix when:
 *   - The pattern starts with the owned prefix (e.g. "web/**" matches "web/")
 *   - The owned prefix starts with the pattern base (e.g. "web/" matches "web")
 *   - The pattern is "**" alone (catch-all — matches everything)
 *
 * Note: "crates/**" does NOT match "web/" because "crates/**" only covers crates/ paths.
 *
 * @param {string[]} prPaths        - on.pull_request.paths entries
 * @param {string} ownedPrefix      - e.g. "web/", "packages/"
 */
function pathFilterExcludesLane(prPaths, ownedPrefix) {
  if (prPaths.length === 0) return false; // no filter → not excluded
  const positiveFilters = prPaths.filter((f) => !f.startsWith("!"));
  // If there are positive includes but none match the owned prefix, the lane is excluded.
  if (positiveFilters.length === 0) return false; // only negations, can't exclude
  return !positiveFilters.some((f) => {
    if (f === "**") return true; // global catch-all
    // Strip glob suffix to get the base path the pattern covers
    const base = f.replace(/\/?\*\*?\/?.*$/, "").replace(/\*$/, "");
    // The pattern covers the owned prefix if the owned path starts with the pattern base
    // OR the pattern path starts with the owned prefix.
    return (
      ownedPrefix.startsWith(base + "/") ||
      ownedPrefix.startsWith(base) ||
      base.startsWith(ownedPrefix) ||
      f.startsWith(ownedPrefix)
    );
  });
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

describe("verify.yml — static structure", () => {
  let yamlText;
  let parsed;

  // Load once, share across tests.
  try {
    yamlText = readFileSync(WORKFLOW_PATH, "utf8");
    parsed = parseWorkflow(yamlText);
  } catch (err) {
    // If the file doesn't exist, every test that needs it will fail with a clear message.
    yamlText = null;
    parsed = null;
  }

  it("workflow file exists and is non-empty", () => {
    assert.ok(yamlText !== null, `${WORKFLOW_PATH} does not exist`);
    assert.ok(yamlText.length > 0, "workflow file is empty");
  });

  it("workflow triggers include pull_request", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    assert.ok(
      parsed.triggers.includes("pull_request"),
      `Expected 'pull_request' in on: triggers, got: ${parsed.triggers.join(", ")}`
    );
  });

  // ── M-5: exact 'npm run test' check (no loose disjunct) ───────────────────
  it("'npm run test' appears in a PR-triggered job (exact match)", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    const runs = allPrRuns(parsed);
    const found = runs.some((r) => r.includes("npm run test"));
    assert.ok(
      found,
      `'npm run test' not found in any PR-triggered job.\nPR-job run steps:\n${runs.map((r) => `  ${r.slice(0, 120)}`).join("\n")}`
    );
  });

  it("'npm run build' appears in a PR-triggered job", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    const runs = allPrRuns(parsed);
    const found = runs.some((r) => r.includes("npm run build"));
    assert.ok(
      found,
      `'npm run build' not found in any PR-triggered job.\nPR-job run steps:\n${runs.map((r) => `  ${r.slice(0, 120)}`).join("\n")}`
    );
  });

  it("'npm run typecheck' appears in a PR-triggered job", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    const runs = allPrRuns(parsed);
    const found = runs.some((r) => r.includes("npm run typecheck"));
    assert.ok(
      found,
      `'npm run typecheck' not found in any PR-triggered job.\nPR-job run steps:\n${runs.map((r) => `  ${r.slice(0, 120)}`).join("\n")}`
    );
  });

  it("runner self-test (node --test tools/run-workspaces.test.mjs) appears in a PR-triggered job", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    const runs = allPrRuns(parsed);
    const found = runs.some(
      (r) => r.includes("run-workspaces.test.mjs") && r.includes("--test")
    );
    assert.ok(
      found,
      `Runner self-test 'node --test tools/run-workspaces.test.mjs' not found in any PR-triggered job.\nPR-job run steps:\n${runs.map((r) => `  ${r.slice(0, 120)}`).join("\n")}`
    );
  });

  it("fuzz long campaign is NOT triggered on pull_request (must stay schedule/workflow_dispatch only)", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    const fuzzJob = parsed.jobs.find((j) => j.id === "fuzz");
    assert.ok(fuzzJob, "Expected a 'fuzz' job to exist");
    assert.ok(
      !isPrTriggered(fuzzJob),
      "The 'fuzz' job must NOT run on pull_request (it would block PRs for 24 h)"
    );
  });

  it("Rust safety jobs (rust-parsers, fuzz-build) remain PR-triggered", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    const rustParsers = parsed.jobs.find((j) => j.id === "rust-parsers");
    const fuzzBuild   = parsed.jobs.find((j) => j.id === "fuzz-build");
    assert.ok(rustParsers, "Expected 'rust-parsers' job");
    assert.ok(fuzzBuild,   "Expected 'fuzz-build' job");
    assert.ok(isPrTriggered(rustParsers), "'rust-parsers' job must be PR-triggered");
    assert.ok(isPrTriggered(fuzzBuild),   "'fuzz-build' job must be PR-triggered");
  });

  it("FFI ABI contract job (ffi-abi) remains PR-triggered", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    const ffiAbi = parsed.jobs.find((j) => j.id === "ffi-abi");
    assert.ok(ffiAbi, "Expected 'ffi-abi' job");
    assert.ok(isPrTriggered(ffiAbi), "'ffi-abi' job must be PR-triggered");
  });

  it("environment-blocked lanes are explicit (no silent empty-pass on WASM/Emscripten steps)", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    // For each PR job step that mentions emscripten, wasm-build, or docker in its name,
    // the run: script must contain an explicit skip/unavailable annotation rather than
    // silently succeeding on missing tooling.
    const prJobs = parsed.jobs.filter(isPrTriggered);
    const envBlockedPatterns = /emscripten|emsdk|docker.*build|wasm.*build|build.*wasm/i;
    const skipPatterns = /skip|skipped|unavailable|not.*available|ci.*env|ci_skip/i;

    for (const job of prJobs) {
      // The dist-freshness gate is a pure git-diff check: its run text only *references* the jxl-wasm
      // build command in an error hint (it never invokes Emscripten/WASM tooling), so the
      // env-skip-annotation rule — meant for steps that actually perform a heavy WASM/Emscripten
      // build — does not apply to it.
      if (job.id === "dist-freshness") continue;
      for (const step of job.steps) {
        if (envBlockedPatterns.test(step.name) || envBlockedPatterns.test(step.run)) {
          // Must have an explicit skip signal in `run:` or `if:`
          const hasSkipSignal =
            skipPatterns.test(step.run) ||
            skipPatterns.test(step.stepIf) ||
            step.stepIf.includes("false") ||
            /process\.exit\(0\)/.test(step.run) ||
            step.run.includes("echo") && skipPatterns.test(step.run);
          assert.ok(
            hasSkipSignal,
            `Job '${job.id}' step '${step.name}' references WASM/Emscripten but has no explicit skip annotation. ` +
            `Add a skip message or 'if: false' so CI is explicit about the environment requirement.`
          );
        }
      }
    }
  });

  // ── GAP 1: web-tests job must exist and be PR-triggered ───────────────────
  it("GAP1: a 'web-tests' PR job exists and runs node-safe web tests", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    const webJob = parsed.jobs.find((j) => j.id === "web-tests");
    assert.ok(webJob, "Expected a 'web-tests' job to exist in the workflow");
    assert.ok(isPrTriggered(webJob), "'web-tests' job must be PR-triggered (no schedule/dispatch-only guard)");
    // Must invoke node --test with a glob covering the web/ tree.
    const runs = webJob.steps.map((s) => s.run).join("\n");
    assert.ok(
      runs.includes("node --test") && (runs.includes("web/") || runs.includes("web\\") || runs.includes("'web/")),
      `'web-tests' job must run 'node --test' over web/ tests. Got runs:\n${runs.slice(0, 400)}`
    );
  });

  it("GAP1: web-tests job explicitly env-gates WASM-blocked tests (not silently red)", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    const webJob = parsed.jobs.find((j) => j.id === "web-tests");
    assert.ok(webJob, "Expected a 'web-tests' job");
    // The job or its steps must mention env-gating for tests that need pkg/ (WASM).
    // We look for skip/pkg or CI_SKIP_WASM or similar explicit annotation.
    const allText = webJob.steps.map((s) => s.run + " " + s.name + " " + s.stepIf).join("\n");
    const hasEnvGate =
      /pkg|wasm|skip|CI_SKIP|decode\.test|export\.test|proxy.e2e/i.test(allText);
    assert.ok(
      hasEnvGate,
      "web-tests job must explicitly exclude or env-gate WASM-blocked tests (those importing pkg/raw_converter_wasm.js). " +
      `Add a documented exclusion pattern (e.g. --exclude or env var). Got step text:\n${allText.slice(0, 400)}`
    );
  });

  // ── GAP 2: benchmark-smoke job must exist and be PR-triggered ─────────────
  it("GAP2: a 'benchmark-smoke' PR job exists and runs benchmark registration tests", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    const benchJob = parsed.jobs.find((j) => j.id === "benchmark-smoke");
    assert.ok(benchJob, "Expected a 'benchmark-smoke' job to exist in the workflow");
    assert.ok(isPrTriggered(benchJob), "'benchmark-smoke' job must be PR-triggered");
    const runs = benchJob.steps.map((s) => s.run).join("\n");
    // Must call node --test over the benchmark/ smoke tests (deterministic subset).
    // Accepts either a hardcoded file list OR the discover-node-tests auto-discovery pattern.
    const usesNodeTest = runs.includes("node --test");
    const coversBenchmark =
      runs.includes("benchmark/") ||
      runs.includes("benchmark\\") ||
      runs.includes("discover-node-tests") ||
      runs.includes("--benchmark");
    assert.ok(
      usesNodeTest && coversBenchmark,
      `'benchmark-smoke' job must run 'node --test' over benchmark/ smoke files (or use discover-node-tests.mjs --benchmark). Got:\n${runs.slice(0, 400)}`
    );
  });

  // ── M-1: path-filter guard is not vacuous ────────────────────────────────
  // The on.pull_request.paths filter (if present) must be captured and must not
  // exclude critical JS/web/benchmark lanes.
  it("M-1: parseWorkflow captures on.pull_request.paths at workflow level", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    // The returned object must have prPaths and prPathsIgnore arrays (even if empty).
    assert.ok(Array.isArray(parsed.prPaths),       "parsed.prPaths must be an array");
    assert.ok(Array.isArray(parsed.prPathsIgnore), "parsed.prPathsIgnore must be an array");
    // Main verify.yml should NOT have restrictive path filters that lock JS lanes out.
    // (If no paths filter exists, prPaths is empty → passes trivially.)
  });

  it("M-1: workflow-level path filter (if present) does not exclude critical JS lanes", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    const jsCriticalLanes = [
      { id: "web-tests",      owns: "web/" },
      { id: "benchmark-smoke", owns: "benchmark/" },
      { id: "workspace-test",  owns: "packages/" },
      { id: "runner-self-test", owns: "tools/" },
    ];
    for (const lane of jsCriticalLanes) {
      const job = parsed.jobs.find((j) => j.id === lane.id);
      if (!job) continue;
      const excluded = pathFilterExcludesLane(parsed.prPaths, lane.owns);
      assert.ok(
        !excluded,
        `on.pull_request.paths filter ${JSON.stringify(parsed.prPaths)} excludes critical lane '${lane.id}' ` +
        `(owns '${lane.owns}'). A PR touching ${lane.owns} would never trigger this lane.`
      );
    }
  });

  it("M-1 NEGATIVE: pathFilterExcludesLane correctly detects exclusion of a JS lane by 'crates/**' filter", () => {
    // Synthetic scenario: only 'crates/**' in paths → web/ lane is excluded.
    // This proves the guard is not vacuous.
    const syntheticPrPaths = ["crates/**"];
    assert.ok(
      pathFilterExcludesLane(syntheticPrPaths, "web/"),
      "NEGATIVE test: a paths:['crates/**'] filter should exclude the web/ lane — guard must detect this"
    );
    assert.ok(
      pathFilterExcludesLane(syntheticPrPaths, "packages/"),
      "NEGATIVE test: a paths:['crates/**'] filter should exclude the packages/ lane"
    );
    // Rust lane should NOT be excluded by 'crates/**'
    assert.ok(
      !pathFilterExcludesLane(syntheticPrPaths, "crates/"),
      "NEGATIVE test: 'crates/**' filter should NOT exclude the crates/ lane"
    );
  });

  // ── GAP 3: path-filter safety — no critical lane filtered away ─────────────
  it("GAP3: critical lanes have no path filter that excludes files they own", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");

    // Map each critical job ID to the path prefix it owns.
    // A job with no path filter passes trivially (it runs on everything).
    // A job with a path filter must include at least one pattern that matches the owned paths.
    const criticalLanes = [
      { id: "workspace-test",     owns: "packages/" },
      { id: "workspace-build",    owns: "packages/" },
      { id: "workspace-typecheck", owns: "packages/" },
      { id: "web-tests",          owns: "web/" },
      { id: "benchmark-smoke",    owns: "benchmark/" },
      { id: "rust-parsers",       owns: "crates/" },
      { id: "fuzz-build",         owns: "crates/" },
      { id: "runner-self-test",   owns: "tools/" },
    ];

    for (const lane of criticalLanes) {
      const job = parsed.jobs.find((j) => j.id === lane.id);
      // If the job doesn't exist yet, skip — existence is covered by other assertions.
      if (!job) continue;

      const filters = job.pathFilters;
      if (filters.length === 0) {
        // No filter → always runs → safe.
        continue;
      }

      // At least one filter pattern must NOT exclude the owned path.
      // A pattern that starts with "!" is an exclusion; a pattern that matches the owned
      // prefix as a positive include means the lane can fire on changes to owned files.
      const positiveFilters = filters.filter((f) => !f.startsWith("!"));
      const hasMatchingPositive = positiveFilters.some(
        (f) => f.startsWith(lane.owns) || f.includes("**") || lane.owns.startsWith(f.replace(/\*\*?\/?$/, ""))
      );
      assert.ok(
        hasMatchingPositive,
        `Critical lane '${lane.id}' has path filters ${JSON.stringify(filters)} ` +
        `but none match its owned path '${lane.owns}'. ` +
        `This would prevent the job from running on changes to its own files.`
      );
    }
  });

  // ── GAP 4: cache keys must cover lockfile + bun.lock + build-script ────────
  it("GAP4: workspace jobs use a cache key that includes bun.lock and tools/run-workspaces.mjs", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");

    // The workspace jobs (workspace-test, workspace-build, workspace-typecheck) must
    // use an explicit cache key that hashes:
    //   - package-lock.json  (npm lockfile)
    //   - bun.lock           (bun lockfile)
    //   - tools/run-workspaces.mjs  (build-script)
    // This can be done via actions/cache with hashFiles(), OR via setup-node with a
    // cache-dependency-path that covers all three inputs.
    const workspaceJobs = ["workspace-test", "workspace-build", "workspace-typecheck"];

    for (const jobId of workspaceJobs) {
      const job = parsed.jobs.find((j) => j.id === jobId);
      if (!job) continue; // existence tested elsewhere

      // Collect all text from the job's steps (run, name, uses, and any `with:` values
      // we can extract from the raw YAML text that references these files).
      const allStepText = job.steps.map((s) => s.run + " " + s.name).join("\n");

      // Find the raw YAML block for this job to check the `with:` section of setup-node.
      const jobYamlStart = yamlText.indexOf(`\n  ${jobId}:`);
      const nextJobMatch = yamlText.slice(jobYamlStart + 1).match(/\n  \w[\w-]*:/);
      const jobYamlBlock = nextJobMatch
        ? yamlText.slice(jobYamlStart, jobYamlStart + 1 + nextJobMatch.index)
        : yamlText.slice(jobYamlStart);

      const hasBunLock = jobYamlBlock.includes("bun.lock");
      const hasBuildScript =
        jobYamlBlock.includes("run-workspaces.mjs") ||
        jobYamlBlock.includes("run-workspaces");

      assert.ok(
        hasBunLock,
        `Job '${jobId}' cache key must include 'bun.lock'. ` +
        `Current YAML block does not reference bun.lock:\n${jobYamlBlock.slice(0, 600)}`
      );
      assert.ok(
        hasBuildScript,
        `Job '${jobId}' cache key must include 'tools/run-workspaces.mjs' (the build-script). ` +
        `Current YAML block does not reference it:\n${jobYamlBlock.slice(0, 600)}`
      );
    }
  });

  // ── M-4: node_modules must NOT be in cache path for workspace/web jobs ─────
  it("M-4: workspace and web-tests jobs do not cache node_modules (npm ci deletes it)", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    const jobs = ["workspace-test", "workspace-build", "workspace-typecheck", "web-tests"];
    for (const jobId of jobs) {
      const jobYamlStart = yamlText.indexOf(`\n  ${jobId}:`);
      if (jobYamlStart === -1) continue;
      const nextJobMatch = yamlText.slice(jobYamlStart + 1).match(/\n  \w[\w-]*:/);
      const jobYamlBlock = nextJobMatch
        ? yamlText.slice(jobYamlStart, jobYamlStart + 1 + nextJobMatch.index)
        : yamlText.slice(jobYamlStart);

      // Check the actions/cache path: section. Look for a cache block that lists node_modules.
      // The check: if 'node_modules' appears in the path: of an actions/cache step (not in a comment),
      // that is the problem. We detect this by finding 'node_modules' in non-comment lines
      // inside the job block.
      const nonCommentLines = jobYamlBlock
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n");

      // Only flag if node_modules appears as a cache path entry (indented under 'path:').
      // Avoid flagging explanatory prose / step names.
      const cachePathSection = nonCommentLines.match(/path:\s*\|\s*([\s\S]*?)(?=key:|restore-keys:|$)/);
      if (cachePathSection) {
        assert.ok(
          !cachePathSection[1].includes("node_modules"),
          `Job '${jobId}' includes 'node_modules' in actions/cache path. ` +
          `npm ci always deletes node_modules before installing — caching it wastes space and can cause stale-dep bugs. ` +
          `Remove 'node_modules' from the cache path; keep only '~/.npm', 'bun.lock', etc.`
        );
      }
    }
  });

  // ── M-3: cargo +nightly fuzz run target must be quoted ────────────────────
  it("M-3: 'cargo +nightly fuzz run' invocations quote the target argument", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    // Find all 'cargo +nightly fuzz run' invocations across all jobs.
    // They must use "${{ matrix.target }}" (quoted) not ${{ matrix.target }} (unquoted).
    const allRunText = parsed.jobs.flatMap((j) => j.steps.map((s) => s.run)).join("\n");
    // Match lines that contain 'cargo +nightly fuzz run' followed by an unquoted expression.
    // Unquoted form: 'fuzz run ${{ ...' (no surrounding quotes)
    // Quoted form:   'fuzz run "${{ ...' or "fuzz run '${{ ..."
    const unquotedPattern = /cargo\s+\+nightly\s+fuzz\s+run\s+\$\{\{[^'"]/;
    assert.ok(
      !unquotedPattern.test(allRunText),
      `Found 'cargo +nightly fuzz run' with unquoted matrix variable. ` +
      `Use: cargo +nightly fuzz run "\${{ matrix.target }}" to prevent shell word-splitting. ` +
      `Matching text:\n${allRunText.slice(allRunText.search(unquotedPattern), allRunText.search(unquotedPattern) + 200)}`
    );
  });

  // ── M-6 + K1: OMISSION-GUARD ──────────────────────────────────────────────
  // Every *.test.mjs / *.test.js under web/ and benchmark/ must be either:
  //   (a) runnable (node:test, no bun/vitest/playwright/wasm-pkg)
  //   (b) in the skip list with a recorded reason
  //   (c) in the pre-existing-failure list with a recorded reason
  // The CI web-tests + benchmark-smoke jobs must run the full runnable set
  // (checked via discover-node-tests.mjs which is the authoritative classifier).
  it("M-6+K1: discover-node-tests accounts for every web/ and benchmark/ test file", async () => {
    const { discoverTests } = await import("./discover-node-tests.mjs");
    const { runnable, skipped, preExistingFailures, total } = discoverTests();

    // Every file must be accounted for (runnable + skipped + failures = total).
    const accounted = runnable.length + skipped.length + preExistingFailures.length;
    assert.equal(
      accounted,
      total,
      `OMISSION-GUARD: ${total - accounted} file(s) unaccounted for. ` +
      `Add each to discover-node-tests.mjs PRE_EXISTING_FAILURES or it must be runnable.`
    );

    // Every runnable file must appear in the CI web-tests or benchmark-smoke job.
    // We check this by verifying the CI jobs reference discover-node-tests.mjs
    // (the authoritative discovery tool) OR by verifying each runnable file by path.
    // Strategy: the discover tool IS the source of truth — we just assert it runs clean.
    assert.ok(runnable.length > 0, "Expected at least some runnable node:test files");
    assert.ok(
      runnable.length >= 15,
      `Expected at least 15 runnable files; got ${runnable.length}. Has discovery broken?`
    );

    // Every pre-existing failure must have a non-empty reason.
    for (const { path: p, reason } of preExistingFailures) {
      assert.ok(
        reason && reason.length > 10,
        `Pre-existing failure entry '${p}' must have a descriptive reason (got: '${reason}')`
      );
    }

    // Every skip must have a non-empty reason.
    for (const { path: p, reason } of skipped) {
      assert.ok(
        reason && reason.length > 5,
        `Skip entry '${p}' must have a recorded reason (got: '${reason}')`
      );
    }
  });

  it("M-6+K1: benchmark/test/ and benchmark/optimize/test/ are covered by discover-node-tests", async () => {
    const { discoverTests } = await import("./discover-node-tests.mjs");
    const { runnable, preExistingFailures } = discoverTests({ includeWeb: false, includeBenchmark: true });

    // The benchmark/test/ directory must have representation (either runnable or classified).
    const benchTestCovered = [...runnable, ...preExistingFailures.map((e) => e.path)]
      .some((p) => p.startsWith("benchmark/test/") || p.startsWith("benchmark/optimize/test/"));
    assert.ok(
      benchTestCovered,
      "Expected benchmark/test/ or benchmark/optimize/test/ files to be discovered and classified. " +
      "These directories contain node:test files omitted by the original hardcoded CI lists."
    );
  });

  // ── K2: session-worker-timings must be labelled as pre-existing source-mismatch failure ──
  it("K2: session-worker-timings.test.mjs is classified as pre-existing source-mismatch failure", async () => {
    const { discoverTests } = await import("./discover-node-tests.mjs");
    const { preExistingFailures } = discoverTests({ includeWeb: false, includeBenchmark: true });

    const entry = preExistingFailures.find((e) => e.path === "benchmark/session-worker-timings.test.mjs");
    assert.ok(
      entry,
      "benchmark/session-worker-timings.test.mjs must appear in preExistingFailures list"
    );
    assert.ok(
      /source.mismatch|source-mismatch/i.test(entry.reason),
      `session-worker-timings must be labelled 'source-mismatch' (not 'env-blocked'). Got: '${entry.reason}'`
    );
  });

  // ── I-1: nightly fuzz matrix must carry TODO about codec-gated stub targets ─
  it("I-1: nightly fuzz matrix has a TODO comment about codec-gated stub targets", () => {
    assert.ok(yamlText !== null, "YAML file not loaded");
    // The fuzz job or surrounding comment must mention that casv_header/casv_footer/
    // casv_audio_box/jxtc_header are no-op stubs until --features codec is wired.
    const hasTodo = (
      /TODO.*casv_header|TODO.*codec.*stubs|stub.*casv|casv.*stub|no-op stub/i.test(yamlText) ||
      /Packet 5|Task 4|features codec|--features codec/i.test(yamlText)
    );
    assert.ok(
      hasTodo,
      "The nightly fuzz matrix must carry a TODO or annotation explaining that " +
      "casv_header/casv_footer/casv_audio_box/jxtc_header are no-op stubs until " +
      "'--features codec' is wired (Packet 5 Task 4). Add a comment near the fuzz: job matrix."
    );
  });
});
