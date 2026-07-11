/**
 * Tests for the authoritative workspace + benchmark runner.
 *
 * TDD — RED phase: write failing tests first, then implement.
 *
 * Test contract:
 *  - discoverWorkspaces()     → reads package.json workspace globs, returns WorkspaceTask[]
 *  - buildDag()               → derives dependency edges from package.json "dependencies"
 *  - topoSort()               → stable topological order respecting declared deps
 *  - runTasks()               → executes with bounded concurrency, buffered output, fail-fast
 *  - assertAllTestWorkspaces()→ throws if a workspace with a "test" script is absent from the plan
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Import the module under test.  We import specific named exports that the
// implementation must provide; the default CLI entry point is separate.
// ---------------------------------------------------------------------------
import {
  discoverWorkspaces,
  buildDag,
  topoSort,
  runTasks,
  assertAllTestWorkspaces,
  CONCURRENCY_DEFAULT,
} from "./run-workspaces.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal WorkspaceTask for unit tests. */
function ws(name, { dir = `packages/${name}`, command = "test", deps = [] } = {}) {
  return { name, directory: dir, command, dependencies: deps };
}

// ---------------------------------------------------------------------------
// 1. discoverWorkspaces — reads the real repo
// ---------------------------------------------------------------------------

describe("discoverWorkspaces", () => {
  it("returns at least one workspace per packages/* entry", async () => {
    const workspaces = await discoverWorkspaces(REPO_ROOT, "test");
    assert.ok(workspaces.length >= 1, "expected at least one workspace");
  });

  it("every returned task has name, directory, command, dependencies", async () => {
    const workspaces = await discoverWorkspaces(REPO_ROOT, "test");
    for (const ws of workspaces) {
      assert.ok(typeof ws.name === "string" && ws.name.length > 0, `name missing on ${JSON.stringify(ws)}`);
      assert.ok(typeof ws.directory === "string" && ws.directory.length > 0, `directory missing on ${ws.name}`);
      assert.ok(typeof ws.command === "string", `command missing on ${ws.name}`);
      assert.ok(Array.isArray(ws.dependencies), `dependencies missing on ${ws.name}`);
    }
  });

  it("includes all test-bearing workspaces from the repo", async () => {
    const workspaces = await discoverWorkspaces(REPO_ROOT, "test");
    const names = new Set(workspaces.map((w) => w.name));

    // These packages have 'test' scripts and must be present
    const required = [
      "@casabio/asset-store",
      "@casabio/fast-jpeg",
      "@casabio/jxl-cache",
      "@casabio/jxl-policy",
      "@casabio/jxl-progressive",
      "@casabio/jxl-pyramid",
      "@casabio/jxl-scheduler",
      "@casabio/jxl-session",
      "@casabio/jxl-stream",
      "@casabio/jxl-worker-browser",
      "@casabio/jxl-worker-node",
      "@casabio/pyramid-ingest",
    ];

    const missing = required.filter((n) => !names.has(n));
    assert.deepEqual(
      missing,
      [],
      `test-bearing workspaces missing from plan: ${missing.join(", ")}`
    );
  });

  it("does NOT include workspaces that have no test script when task=test", async () => {
    const workspaces = await discoverWorkspaces(REPO_ROOT, "test");
    const names = workspaces.map((w) => w.name);

    // jxl-wasm has no test script
    assert.ok(
      !names.includes("@casabio/jxl-wasm"),
      "@casabio/jxl-wasm has no test script and must not appear"
    );
  });

  it("includes build workspaces for task=build", async () => {
    const workspaces = await discoverWorkspaces(REPO_ROOT, "build");
    const names = new Set(workspaces.map((w) => w.name));
    // jxl-wasm HAS a build script (even though it is a no-op), so it must appear
    assert.ok(names.has("@casabio/jxl-wasm"), "jxl-wasm must appear in build task");
    // casv-web also has a build
    assert.ok(names.has("@casabio/casv-web"), "casv-web must appear in build task");
  });
});

// ---------------------------------------------------------------------------
// 2. buildDag — derives edges from declared @casabio/* deps
// ---------------------------------------------------------------------------

describe("buildDag", () => {
  it("returns empty adjacency map for empty input", () => {
    const dag = buildDag([]);
    assert.deepEqual(dag, {});
  });

  it("independent tasks have no edges", () => {
    const tasks = [ws("A"), ws("B"), ws("C")];
    const dag = buildDag(tasks);
    // No dependencies declared → each node has empty successors list
    for (const t of tasks) {
      assert.deepEqual(dag[t.name] ?? [], []);
    }
  });

  it("records a dependency edge when one package depends on another", () => {
    const a = ws("@casabio/jxl-core");
    const b = ws("@casabio/jxl-cache", { deps: ["@casabio/jxl-core"] });
    const dag = buildDag([a, b]);
    // jxl-core must be scheduled before jxl-cache
    assert.ok(
      (dag["@casabio/jxl-core"] ?? []).includes("@casabio/jxl-cache"),
      "jxl-core → jxl-cache edge expected"
    );
  });
});

// ---------------------------------------------------------------------------
// 3. topoSort — stable topo order
// ---------------------------------------------------------------------------

describe("topoSort", () => {
  it("returns a valid topological order", () => {
    const tasks = [
      ws("@casabio/jxl-cache", { deps: ["@casabio/jxl-core"] }),
      ws("@casabio/jxl-core"),
    ];
    const dag = buildDag(tasks);
    const order = topoSort(tasks, dag);

    const idxCore = order.findIndex((t) => t.name === "@casabio/jxl-core");
    const idxCache = order.findIndex((t) => t.name === "@casabio/jxl-cache");
    assert.ok(idxCore < idxCache, "jxl-core must come before jxl-cache");
  });

  it("two independent tasks appear in deterministic (alphabetical) order", () => {
    const tasks = [ws("@casabio/jxl-stream"), ws("@casabio/jxl-cache")];
    const dag = buildDag(tasks);
    const order = topoSort(tasks, dag);
    assert.equal(order[0].name, "@casabio/jxl-cache");
    assert.equal(order[1].name, "@casabio/jxl-stream");
  });

  it("throws on a cycle", () => {
    const tasks = [
      ws("@casabio/A", { deps: ["@casabio/B"] }),
      ws("@casabio/B", { deps: ["@casabio/A"] }),
    ];
    const dag = buildDag(tasks);
    assert.throws(() => topoSort(tasks, dag), /cycle/i);
  });

  it("handles a chain: A→B→C", () => {
    const tasks = [
      ws("@casabio/C", { deps: ["@casabio/B"] }),
      ws("@casabio/A"),
      ws("@casabio/B", { deps: ["@casabio/A"] }),
    ];
    const dag = buildDag(tasks);
    const order = topoSort(tasks, dag);
    const names = order.map((t) => t.name);
    assert.ok(names.indexOf("@casabio/A") < names.indexOf("@casabio/B"), "A before B");
    assert.ok(names.indexOf("@casabio/B") < names.indexOf("@casabio/C"), "B before C");
  });

  it("all input tasks appear exactly once in output", () => {
    const tasks = [
      ws("@casabio/jxl-core"),
      ws("@casabio/jxl-cache", { deps: ["@casabio/jxl-core"] }),
      ws("@casabio/jxl-policy", { deps: ["@casabio/jxl-core"] }),
    ];
    const dag = buildDag(tasks);
    const order = topoSort(tasks, dag);
    assert.equal(order.length, tasks.length);
    const names = order.map((t) => t.name);
    assert.ok(names.includes("@casabio/jxl-core"));
    assert.ok(names.includes("@casabio/jxl-cache"));
    assert.ok(names.includes("@casabio/jxl-policy"));
  });
});

// ---------------------------------------------------------------------------
// 4. assertAllTestWorkspaces — omission is an error
// ---------------------------------------------------------------------------

describe("assertAllTestWorkspaces", () => {
  it("passes when every test-bearing workspace is scheduled", async () => {
    const workspaces = await discoverWorkspaces(REPO_ROOT, "test");
    // Should not throw
    await assert.doesNotReject(async () => assertAllTestWorkspaces(workspaces, REPO_ROOT));
  });

  it("throws when a test-bearing workspace is omitted from the plan", async () => {
    const workspaces = await discoverWorkspaces(REPO_ROOT, "test");
    // Remove one test-bearing workspace from the plan
    const subset = workspaces.filter((w) => w.name !== "@casabio/jxl-scheduler");
    await assert.rejects(
      async () => assertAllTestWorkspaces(subset, REPO_ROOT),
      /jxl-scheduler/i,
      "must mention the omitted workspace by name"
    );
  });

  it("does not throw when a build-only workspace (no test script) is absent from plan", async () => {
    // assertAllTestWorkspaces only guards test-script-bearing workspaces.
    // A workspace that has NO "test" script (e.g. @casabio/jxl-wasm) is NOT in the test
    // space, so omitting it from a plan must NOT trigger the guard — even if the plan
    // was built for "build" tasks and jxl-wasm is present there.

    // Case A: plan = full test workspace list, MINUS a known build-only entry.
    // Since the build-only entry was never in the test space, the guard must not fire.
    const allTest = await discoverWorkspaces(REPO_ROOT, "test");
    // Confirm jxl-wasm is truly build-only (not in allTest).
    const jxlWasmInTestSpace = allTest.some((w) => w.name === "@casabio/jxl-wasm");
    assert.ok(!jxlWasmInTestSpace, "@casabio/jxl-wasm must not have a test script");

    // A build plan that includes jxl-wasm — omitting it from test guard must still pass.
    await assert.doesNotReject(
      async () => assertAllTestWorkspaces(allTest, REPO_ROOT),
      "full test plan should pass guard even though build-only workspaces are absent"
    );

    // Case B: plan = all test workspaces PLUS the build-only entry added as a stub.
    // The guard cares only about test-space membership; extra entries are fine.
    const planWithBuildOnlyExtra = [
      ...allTest,
      { name: "@casabio/jxl-wasm", directory: "packages/jxl-wasm", command: "build", dependencies: [] },
    ];
    await assert.doesNotReject(
      async () => assertAllTestWorkspaces(planWithBuildOnlyExtra, REPO_ROOT),
      "plan with extra build-only entry should also pass guard"
    );
  });
});

// ---------------------------------------------------------------------------
// 5. CONCURRENCY_DEFAULT — exported constant
// ---------------------------------------------------------------------------

describe("CONCURRENCY_DEFAULT", () => {
  it("is a positive integer", () => {
    assert.ok(Number.isInteger(CONCURRENCY_DEFAULT), "must be integer");
    assert.ok(CONCURRENCY_DEFAULT >= 1, "must be >= 1");
    assert.ok(CONCURRENCY_DEFAULT <= 16, "sanity: must not exceed 16");
  });
});

// ---------------------------------------------------------------------------
// 6. Benchmark registration is a DISTINCT task
// ---------------------------------------------------------------------------

describe("benchmark task registration", () => {
  it("discoverWorkspaces does not include benchmark:pgo in a test task", async () => {
    const workspaces = await discoverWorkspaces(REPO_ROOT, "test");
    // Benchmark scripts must not be mixed into the test task schedule
    const hasBenchmark = workspaces.some((w) =>
      w.command.includes("benchmark")
    );
    assert.ok(!hasBenchmark, "benchmark scripts must not appear in the test task plan");
  });
});

// ---------------------------------------------------------------------------
// 7. runTasks executor — injectable fake runner (no subprocess)
// ---------------------------------------------------------------------------

describe("runTasks executor", () => {
  /**
   * Build a fake runner that resolves tasks after a simulated async delay.
   * `timings` maps task name → { delayMs, code }.
   * Tasks not listed default to { delayMs: 0, code: 0 }.
   */
  function makeFakeRunner(timings = {}) {
    const startOrder = [];
    const runner = (task) => {
      startOrder.push(task.name);
      const { delayMs = 0, code = 0 } = timings[task.name] ?? {};
      return new Promise((resolve) =>
        setTimeout(
          () => resolve({ name: task.name, code, stdout: `out:${task.name}`, stderr: "" }),
          delayMs
        )
      );
    };
    runner.startOrder = startOrder;
    return runner;
  }

  it("C1: output is emitted in stable topo order even when tasks complete out of order", async () => {
    // A and B are independent; A finishes slowly, B finishes fast.
    // Topo sort puts @casabio/A before @casabio/B (alphabetical tie-break).
    // With the old code, B's printResult would fire first.
    // With the C1 fix, A must always appear before B in collected output.
    const taskA = ws("@casabio/A");
    const taskB = ws("@casabio/B");
    const ordered = [taskA, taskB]; // topo order: A, B

    const printedOrder = [];
    const origLog = console.log;
    console.log = (...args) => {
      // Capture the ">> [PASS] ..." header lines
      const line = args.join(" ");
      if (line.includes("@casabio/A") || line.includes("@casabio/B")) {
        printedOrder.push(line.includes("@casabio/A") ? "@casabio/A" : "@casabio/B");
      }
    };

    const runner = makeFakeRunner({
      "@casabio/A": { delayMs: 30, code: 0 }, // slow
      "@casabio/B": { delayMs: 0,  code: 0 }, // fast — would print first without C1 fix
    });

    try {
      const passed = await runTasks(ordered, { concurrency: 2, runner });
      assert.ok(passed, "both tasks should pass");
    } finally {
      console.log = origLog;
    }

    assert.deepEqual(
      printedOrder,
      ["@casabio/A", "@casabio/B"],
      "output must appear in topo order (A before B), not completion order"
    );
  });

  it("fail-fast: a failed task prevents its dependents from starting", async () => {
    // Chain: A → B (B depends on A). A fails.
    const taskA = ws("@casabio/A");
    const taskB = ws("@casabio/B", { deps: ["@casabio/A"] });
    const ordered = [taskA, taskB];

    const runner = makeFakeRunner({
      "@casabio/A": { delayMs: 0, code: 1 }, // A fails
      "@casabio/B": { delayMs: 0, code: 0 }, // B would pass but must not start
    });

    const passed = await runTasks(ordered, { concurrency: 4, runner });

    assert.ok(!passed, "runTasks must return false when a task fails");
    assert.ok(runner.startOrder.includes("@casabio/A"), "A must have been started");
    assert.ok(!runner.startOrder.includes("@casabio/B"), "B must NOT start after A fails (fail-fast)");
  });
});
