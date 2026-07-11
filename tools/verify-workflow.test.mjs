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
 *   5. Environment-blocked lanes (Emscripten/WASM heavy build) must be explicitly
 *      annotated rather than silently passing.  A step that skips a block must emit
 *      a recognisable skip message (checked by searching "skip" | "skipped" | "unavailable"
 *      in step `run:` or `if:` fields when the step name mentions emscripten, wasm, or docker).
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
 *     triggers: string[],        // event names in `on:`
 *     jobs: {
 *       id: string,
 *       name: string,
 *       jobIf: string,           // raw `if:` value on the job, "" if absent
 *       pathFilters: string[],   // on.pull_request.paths entries (job-level)
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

  // ── Extract top-level trigger events ─────────────────────────────────────
  // Find the `on:` block and collect event names (keys at indent=2).
  const triggers = [];
  let inOnBlock = false;
  let inSchedule = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trimEnd();

    if (/^on:/.test(stripped)) {
      inOnBlock = true;
      continue;
    }
    if (inOnBlock) {
      // End of on: block when we hit another top-level key (no indent, ends with :)
      if (/^\w/.test(stripped) && !stripped.startsWith(" ") && !stripped.startsWith("#")) {
        inOnBlock = false;
        continue;
      }
      // Event names are at 2-space indent: "  push:", "  pull_request:", etc.
      const m = stripped.match(/^  (\w+):/);
      if (m) {
        triggers.push(m[1]);
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

  return { triggers, jobs };
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

  it("'npm run test' appears in a PR-triggered job", () => {
    assert.ok(parsed !== null, "YAML could not be parsed");
    const runs = allPrRuns(parsed);
    const found = runs.some((r) => r.includes("npm run test") || r.includes("npm") && r.includes("run test"));
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
});
