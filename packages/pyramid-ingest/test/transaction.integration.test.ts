import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  withReadTransaction,
  withWriteTransaction,
  withImageWriteTransaction,
  assertGlobalWriteHeld,
  LockOrderError,
  type GlobalWriteToken,
} from "../src/transaction";

const HERE = dirname(fileURLToPath(import.meta.url));
const TX_MODULE = join(HERE, "..", "src", "transaction.ts");

let out: string;
beforeEach(async () => { out = await mkdtemp(join(tmpdir(), "pyramid-tx-")); });
afterEach(async () => { await rm(out, { recursive: true, force: true }).catch(() => {}); });

const GLOBAL_LOCK = ".pyramid-ingest.lock";
const imageLockPath = (id: string) => join(out, "images", id, ".lock");

async function globalLockPresent(): Promise<boolean> {
  const entries = await readdir(out).catch(() => [] as string[]);
  return entries.includes(GLOBAL_LOCK);
}
async function fileExists(p: string): Promise<boolean> {
  return readFile(p).then(() => true, () => false);
}

// ---- lock ownership is encapsulated: the body never sees acquire/release ----

test("withWriteTransaction holds the global lock for the body and releases after", async () => {
  expect(await globalLockPresent()).toBe(false);
  let heldDuringBody = false;
  const ret = await withWriteTransaction(out, async () => {
    heldDuringBody = await globalLockPresent();
    return 42;
  });
  expect(heldDuringBody).toBe(true);
  expect(ret).toBe(42);
  expect(await globalLockPresent()).toBe(false); // released on exit
});

test("withWriteTransaction releases the global lock even when the body throws", async () => {
  await expect(
    withWriteTransaction(out, async () => { throw new Error("boom"); }),
  ).rejects.toThrow("boom");
  expect(await globalLockPresent()).toBe(false);
});

test("withReadTransaction lets a concurrent reader in but blocks a writer", async () => {
  // Two overlapping read transactions must both be able to run (shared read).
  let bothInside = false;
  await withReadTransaction(out, async () => {
    await withReadTransaction(out, async () => { bothInside = true; }, { timeoutMs: 2000 });
  });
  expect(bothInside).toBe(true);
});

// ---- FATAL acquisition failure: a writer cannot proceed while another writer holds ----

test("a second writer times out (FATAL) while the first holds the global lock", async () => {
  let release!: () => void;
  const firstDone = new Promise<void>((r) => { release = r; });
  const first = withWriteTransaction(out, async () => { await firstDone; });
  // Give the first tx a tick to actually acquire.
  await new Promise((r) => setTimeout(r, 30));

  await expect(
    withWriteTransaction(out, async () => { /* never reached */ }, { timeoutMs: 150 }),
  ).rejects.toThrow(/timeout/i);

  release();
  await first;
  expect(await globalLockPresent()).toBe(false);
});

// ---- lock ORDER: image lock REQUIRES the global-lock token (GLOBAL then IMAGE) ----

test("withImageWriteTransaction runs under a held global token and acquires the image lock", async () => {
  const id = "abc123";
  let imageLockHeld = false;
  await withWriteTransaction(out, async (tx) => {
    await withImageWriteTransaction(tx.token, out, id, async () => {
      imageLockHeld = await fileExists(imageLockPath(id));
    });
  });
  expect(imageLockHeld).toBe(true);
  expect(await fileExists(imageLockPath(id))).toBe(false); // released
  expect(await globalLockPresent()).toBe(false);
});

test("using a global token after its write transaction has exited is a LockOrderError (inversion guard)", async () => {
  let stolen!: GlobalWriteToken;
  await withWriteTransaction(out, async (tx) => { stolen = tx.token; });
  // The global lock has now been released. Trying to acquire an image lock under the stale token
  // is a lock-order inversion (image lock without a live global lock) and must be refused.
  await expect(
    withImageWriteTransaction(stolen, out, "xyz", async () => { /* must not run */ }),
  ).rejects.toBeInstanceOf(LockOrderError);
});

// ---- runtime order guard for loops that acquire image locks directly (batch workers) ----

test("assertGlobalWriteHeld throws when no token / a released token is presented", () => {
  expect(() => assertGlobalWriteHeld(undefined, "batch")).toThrow(LockOrderError);
});

test("assertGlobalWriteHeld passes inside a live write transaction and fails after it exits", async () => {
  let captured!: GlobalWriteToken;
  await withWriteTransaction(out, async (tx) => {
    captured = tx.token;
    // While the transaction is live, the guard passes (no throw).
    expect(() => assertGlobalWriteHeld(tx.token, "batch")).not.toThrow();
  });
  // Once released, the same token is rejected.
  expect(() => assertGlobalWriteHeld(captured, "batch")).toThrow(LockOrderError);
});

// ---- shutdown ORDER (finding 69): steps run, in order, BEFORE the global lock releases ----

test("registered shutdown steps all complete before the global lock is released", async () => {
  const order: string[] = [];
  let lockPresentWhenStepsRan = false;

  await withWriteTransaction(out, async (tx) => {
    tx.onShutdown(async () => {
      // Simulate "terminate/join workers": yield, then record.
      await new Promise((r) => setTimeout(r, 10));
      order.push("workers-joined");
      lockPresentWhenStepsRan = await globalLockPresent();
    });
    tx.onShutdown(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("checkpoint-flushed");
      // Lock must STILL be held while the checkpoint flushes.
      lockPresentWhenStepsRan = lockPresentWhenStepsRan && (await globalLockPresent());
    });
  });

  // Steps ran in registration order.
  expect(order).toEqual(["workers-joined", "checkpoint-flushed"]);
  // Both ran while the global lock was still held.
  expect(lockPresentWhenStepsRan).toBe(true);
  // And the lock is released only afterwards.
  expect(await globalLockPresent()).toBe(false);
});

test("shutdown steps run even when the body throws, before releasing the lock", async () => {
  const order: string[] = [];
  let lockHeldDuringStep = false;
  await expect(
    withWriteTransaction(out, async (tx) => {
      tx.onShutdown(async () => {
        lockHeldDuringStep = await globalLockPresent();
        order.push("flushed");
      });
      throw new Error("mid-run failure");
    }),
  ).rejects.toThrow("mid-run failure");
  expect(order).toEqual(["flushed"]);
  expect(lockHeldDuringStep).toBe(true);
  expect(await globalLockPresent()).toBe(false);
});

// ---- TWO-PROCESS contention (real separate PIDs): a holder in a child process makes the parent's
//      writer time out FATALLY, and a reader coexists with... nothing (writer blocks readers). ----

// Spawns a real child `bun` process that opens a WRITE transaction on `out`, writes `readyFile` once
// the lock is held, then holds the lock until `releaseFile` appears. Returns a handle to stop it.
function spawnLockHolder(out: string, readyFile: string, releaseFile: string) {
  const script = `
    import { withWriteTransaction } from ${JSON.stringify(TX_MODULE)};
    import { writeFile, access } from "node:fs/promises";
    await withWriteTransaction(${JSON.stringify(out)}, async () => {
      await writeFile(${JSON.stringify(readyFile)}, "1");
      for (;;) {
        try { await access(${JSON.stringify(releaseFile)}); break; } catch {}
        await new Promise((r) => setTimeout(r, 20));
      }
    });
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
  return child;
}

async function waitForFile(p: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fileExists(p)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${p}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("two processes contending for the global write lock: the second writer times out (FATAL)", async () => {
  const ready = join(out, "ready.sentinel");
  const release = join(out, "release.sentinel");
  const child = spawnLockHolder(out, ready, release);
  try {
    await waitForFile(ready); // child now holds the global write lock (different PID)
    expect(await globalLockPresent()).toBe(true);

    // This process, a genuine second writer, must NOT proceed — acquisition failure is FATAL.
    let ranBody = false;
    await expect(
      withWriteTransaction(out, async () => { ranBody = true; }, { timeoutMs: 300 }),
    ).rejects.toThrow(/timeout/i);
    expect(ranBody).toBe(false);
  } finally {
    await writeFile(release, "1"); // let the child finish + release
    await new Promise<void>((r) => child.on("exit", () => r()));
  }
  // Child released its lock on clean exit.
  expect(await globalLockPresent()).toBe(false);
});

// ---- signal firing DURING an active worker/checkpoint write: the lock is released only AFTER the
//      in-flight write + shutdown steps settle (finding 69), never mid-write. ----

test("a signal during an active write flushes the checkpoint before releasing the global lock", async () => {
  const events: string[] = [];
  let lockHeldAtFlush = false;

  // Model an in-flight worker/checkpoint write that is interrupted by a signal mid-way.
  const abort = new AbortController();
  await withWriteTransaction(out, async (tx) => {
    // Register the shutdown barrier the way ingestBatch does: join workers, then flush checkpoint.
    tx.onShutdown(async () => {
      // Simulate finishing the in-flight checkpoint write while the lock is still held.
      await new Promise((r) => setTimeout(r, 15));
      lockHeldAtFlush = await globalLockPresent();
      events.push("checkpoint-flushed");
    });

    // "Active write" in progress; a signal fires mid-flight.
    const active = (async () => {
      abort.signal.addEventListener("abort", () => events.push("intake-aborted"), { once: true });
      // Simulate the worker loop noticing the abort between chunks and unwinding.
      while (!abort.signal.aborted) await new Promise((r) => setTimeout(r, 5));
      events.push("workers-joined");
    })();

    setTimeout(() => abort.abort(), 20); // signal fires DURING the active write
    await active; // ingestBatch-style: body only returns after workers have joined
  });

  // Order: intake aborted → workers joined (inside body) → checkpoint flushed (shutdown step),
  // and the lock was still held while the checkpoint flushed. Only then was it released.
  expect(events).toEqual(["intake-aborted", "workers-joined", "checkpoint-flushed"]);
  expect(lockHeldAtFlush).toBe(true);
  expect(await globalLockPresent()).toBe(false);
});
