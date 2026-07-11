/**
 * Authoritative workspace + benchmark runner.
 *
 * Exports (for testing and CI integration):
 *   discoverWorkspaces(repoRoot, task)  → Promise<WorkspaceTask[]>
 *   buildDag(tasks)                     → Record<string, string[]>
 *   topoSort(tasks, dag)                → WorkspaceTask[]
 *   assertAllTestWorkspaces(plan, root) → Promise<void>   throws if omission detected
 *   CONCURRENCY_DEFAULT                 → number
 *
 * CLI entry point (default export / direct execution):
 *   node tools/run-workspaces.mjs <build|typecheck|test>
 *
 * Scheduling rules:
 *   - Tasks are ordered topologically (dependency-first).
 *   - Independent tasks that are ready run concurrently up to CONCURRENCY_DEFAULT.
 *   - Output per workspace is buffered and printed in stable task order.
 *   - If any task fails, no further tasks are started (fail-fast).
 *
 * @typedef {{ name: string; directory: string; command: string; dependencies: string[] }} WorkspaceTask
 */

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONCURRENCY_DEFAULT = 4;

/** Tasks allowed as the <task> argument. */
const VALID_TASKS = ["build", "typecheck", "test"];

// ---------------------------------------------------------------------------
// Workspace discovery
// ---------------------------------------------------------------------------

/**
 * Read the root package.json "workspaces" globs and discover all packages.
 * Returns only those packages that declare a script for `task`.
 *
 * @param {string} repoRoot
 * @param {string} task  one of "build" | "typecheck" | "test"
 * @returns {Promise<WorkspaceTask[]>}
 */
export async function discoverWorkspaces(repoRoot, task) {
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

  // Resolve workspace globs → package directories.
  // We support simple "packages/*" style globs (no negation needed for this repo).
  const packageDirs = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    // Split on "*" — take the prefix as the parent dir, list it.
    const parts = pattern.split("*");
    if (parts.length >= 2) {
      const parentDir = join(repoRoot, parts[0]);
      let entries;
      try {
        entries = readdirSync(parentDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(parentDir, entry);
        try {
          if (statSync(full).isDirectory()) {
            packageDirs.push(full);
          }
        } catch {
          // ignore
        }
      }
    } else {
      // Literal directory reference
      packageDirs.push(join(repoRoot, pattern));
    }
  }

  // Build WorkspaceTask list: only include packages that have the requested script.
  const tasks = [];
  for (const dir of packageDirs) {
    const pkgPath = join(dir, "package.json");
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue;
    }
    const scripts = pkg.scripts ?? {};
    if (!Object.prototype.hasOwnProperty.call(scripts, task)) {
      continue; // skip — script absent; --if-present semantics
    }

    // Collect all @casabio/* dependencies across all dep fields.
    const allDeps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ];
    const casaDeps = allDeps.filter((d) => d.startsWith("@casabio/"));

    tasks.push({
      name: pkg.name,
      directory: dir,
      command: task,
      dependencies: casaDeps,
    });
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// DAG construction
// ---------------------------------------------------------------------------

/**
 * Build an adjacency map: for each node, which nodes *depend on* it
 * (i.e. must run after it).  Only edges between tasks in the plan are included.
 *
 * @param {WorkspaceTask[]} tasks
 * @returns {Record<string, string[]>}  name → successors[]
 */
export function buildDag(tasks) {
  const nameSet = new Set(tasks.map((t) => t.name));
  const dag = {};
  for (const t of tasks) {
    dag[t.name] = dag[t.name] ?? [];
    for (const dep of t.dependencies) {
      if (!nameSet.has(dep)) continue; // dependency not in plan — skip
      dag[dep] = dag[dep] ?? [];
      dag[dep].push(t.name);
    }
  }
  return dag;
}

// ---------------------------------------------------------------------------
// Topological sort (Kahn's algorithm, stable: tie-break alphabetically)
// ---------------------------------------------------------------------------

/**
 * @param {WorkspaceTask[]} tasks
 * @param {Record<string, string[]>} dag  adjacency map (node → successors)
 * @returns {WorkspaceTask[]}  topologically ordered
 * @throws if a cycle is detected
 */
export function topoSort(tasks, dag) {
  const nameToTask = new Map(tasks.map((t) => [t.name, t]));
  const nameSet = new Set(tasks.map((t) => t.name));

  // in-degree: how many predecessors does each task have (within the plan)?
  const inDegree = new Map(tasks.map((t) => [t.name, 0]));
  for (const [, successors] of Object.entries(dag)) {
    for (const s of successors) {
      if (nameSet.has(s)) {
        inDegree.set(s, (inDegree.get(s) ?? 0) + 1);
      }
    }
  }

  // Seed queue with tasks that have no unmet deps; sort alphabetically for stability.
  const ready = tasks
    .filter((t) => inDegree.get(t.name) === 0)
    .map((t) => t.name)
    .sort();

  const result = [];
  while (ready.length > 0) {
    ready.sort(); // maintain stability
    const name = ready.shift();
    result.push(nameToTask.get(name));
    for (const successor of (dag[name] ?? []).sort()) {
      if (!nameSet.has(successor)) continue;
      const newDeg = inDegree.get(successor) - 1;
      inDegree.set(successor, newDeg);
      if (newDeg === 0) {
        ready.push(successor);
      }
    }
  }

  if (result.length !== tasks.length) {
    const remaining = tasks.filter((t) => !result.includes(t)).map((t) => t.name);
    throw new Error(`Cycle detected in workspace dependency graph. Remaining: ${remaining.join(", ")}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Omission guard
// ---------------------------------------------------------------------------

/**
 * Assert that every package in the repo that declares a "test" script is
 * represented in `plan`.  Throws with a descriptive message if any are missing.
 *
 * This check only applies to the "test" domain — packages without a "test"
 * script are not checked regardless of what task `plan` was built for.
 *
 * @param {WorkspaceTask[]} plan   the task list being validated
 * @param {string} repoRoot
 * @returns {Promise<void>}
 */
export async function assertAllTestWorkspaces(plan, repoRoot) {
  const allTestWorkspaces = await discoverWorkspaces(repoRoot, "test");
  const planNames = new Set(plan.map((t) => t.name));
  const missing = allTestWorkspaces
    .filter((t) => !planNames.has(t.name))
    .map((t) => t.name);

  if (missing.length > 0) {
    throw new Error(
      `The following test-bearing workspaces are absent from the run plan (omission is an error):\n` +
        missing.map((n) => `  - ${n}`).join("\n")
    );
  }
}

// ---------------------------------------------------------------------------
// Task execution engine
// ---------------------------------------------------------------------------

/**
 * Run a single npm script in the given package directory.
 * Returns a Promise that resolves with { name, code, stdout, stderr }.
 *
 * @param {WorkspaceTask} task
 * @returns {Promise<{name:string, code:number, stdout:string, stderr:string}>}
 */
function spawnTask(task) {
  return new Promise((resolve) => {
    // Determine whether to use npm or the npm_execpath script.
    const npmCli = process.env.npm_execpath;
    let child;
    if (npmCli && /\.[cm]?js$/i.test(npmCli)) {
      child = spawn(process.execPath, [npmCli, "run", task.command], {
        cwd: task.directory,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
    } else {
      child = spawn("cmd.exe", ["/d", "/s", "/c", "npm", "run", task.command], {
        cwd: task.directory,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      resolve({ name: task.name, code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ name: task.name, code: 1, stdout, stderr: stderr + err.message });
    });
  });
}

/**
 * Execute tasks with bounded concurrency, respecting the dependency DAG.
 * Buffers per-task output; prints in stable task-completion order.
 * Fail-fast: once any task fails, no new tasks are started.
 *
 * @param {WorkspaceTask[]} ordered  topologically sorted tasks
 * @param {Record<string, string[]>} dag
 * @param {{ concurrency?: number, quiet?: boolean }} [opts]
 * @returns {Promise<boolean>}  true = all passed
 */
export async function runTasks(ordered, dag, opts = {}) {
  const concurrency = opts.concurrency ?? CONCURRENCY_DEFAULT;
  const nameSet = new Set(ordered.map((t) => t.name));

  // Track which tasks are done and their results.
  const done = new Set();       // completed (pass or fail)
  const failed = new Set();     // failed task names
  const results = new Map();    // name → {name,code,stdout,stderr}
  const running = new Map();    // name → Promise

  // We'll process in topo order; tasks become "ready" when all deps are done.
  const remaining = [...ordered];

  /**
   * A task is ready when:
   *  - it hasn't started yet
   *  - all its declared dependencies (within this plan) are done AND passed
   */
  function getReady() {
    return remaining.filter((t) => {
      const inPlanDeps = t.dependencies.filter((d) => nameSet.has(d));
      return (
        !running.has(t.name) &&
        !done.has(t.name) &&
        inPlanDeps.every((d) => done.has(d) && !failed.has(d))
      );
    });
  }

  /**
   * Print buffered result for a task.
   */
  function printResult(r) {
    const status = r.code === 0 ? "PASS" : "FAIL";
    const label = `[${status}] ${r.name}`;
    console.log(`\n>> ${label}`);
    if (r.stdout.trim()) process.stdout.write(r.stdout);
    if (r.stderr.trim()) process.stderr.write(r.stderr);
  }

  let hasFailure = false;

  async function tick() {
    // Drain the ready set up to concurrency limit.
    while (!hasFailure && running.size < concurrency) {
      const ready = getReady();
      if (ready.length === 0) break;
      // Pick by topo order: earliest in `ordered` that is ready.
      const task = ready[0];
      remaining.splice(remaining.indexOf(task), 1);
      const p = spawnTask(task).then((r) => {
        done.add(r.name);
        running.delete(r.name);
        results.set(r.name, r);
        if (r.code !== 0) {
          failed.add(r.name);
          hasFailure = true;
        }
        printResult(r);
        return r;
      });
      running.set(task.name, p);
    }

    if (running.size === 0) return; // nothing running — we're done

    // Wait for the next task to finish, then recurse.
    await Promise.race([...running.values()]);
    await tick();
  }

  // Seed initial tick.
  await tick();

  if (hasFailure) {
    // Print which dependents were skipped.
    const skipped = remaining.map((t) => t.name);
    if (skipped.length > 0) {
      console.error(`\n[SKIP] Not started (dependency failed): ${skipped.join(", ")}`);
    }
  }

  return !hasFailure;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url).replace(/\\/g, "/") ===
    process.argv[1].replace(/\\/g, "/");

if (isMain) {
  const task = process.argv[2];
  if (!task || !VALID_TASKS.includes(task)) {
    console.error(
      `usage: node tools/run-workspaces.mjs <${VALID_TASKS.join("|")}>`
    );
    process.exit(1);
  }

  const repoRoot = resolve(fileURLToPath(import.meta.url), "../../");

  (async () => {
    const tasks = await discoverWorkspaces(repoRoot, task);

    if (task === "test") {
      // Omission guard: every test-bearing workspace must be in the plan.
      await assertAllTestWorkspaces(tasks, repoRoot);
    }

    const dag = buildDag(tasks);
    const ordered = topoSort(tasks, dag);

    console.log(
      `\nRunning "${task}" for ${ordered.length} workspace(s) [concurrency=${CONCURRENCY_DEFAULT}]:`
    );
    for (const t of ordered) {
      console.log(`  ${t.name}`);
    }
    console.log("");

    const passed = await runTasks(ordered, dag);
    process.exit(passed ? 0 : 1);
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
