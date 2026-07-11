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
    // Removing a package that has NO test script from the plan must not fire.
    const allTest = await discoverWorkspaces(REPO_ROOT, "test");
    // jxl-wasm has no test script → it is not in allTest.
    // Confirm: removing a synthetic entry that doesn't exist in test-space doesn't throw.
    const planWithExtra = [
      ...allTest,
      // Add a dummy build-only entry to simulate a build workspace being in the plan
      { name: "@casabio/jxl-wasm", directory: "packages/jxl-wasm", command: "build", dependencies: [] },
    ];
    // Then remove jxl-wasm from the plan — since it has no 'test' script,
    // assertAllTestWorkspaces must still pass.
    const planWithoutJxlWasm = allTest; // jxl-wasm was never in test plan anyway
    await assert.doesNotReject(async () => assertAllTestWorkspaces(planWithoutJxlWasm, REPO_ROOT));
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
