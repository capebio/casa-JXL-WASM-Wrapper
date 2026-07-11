import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PRODUCTION-PATH ordered-shutdown evidence (Task 7, finding 69).
//
// The unit test (transaction.integration.test.ts) proves onShutdown runs steps in order before the lock
// releases. THIS test proves the REAL batch path — the same withWriteTransaction(out, tx => ingestBatch(
// ..., { globalLock: tx.token })) that cli.ts's batch command runs — observes the mandated shutdown ORDER
// on a signal: intake aborted -> workers joined -> checkpoint flushed -> global lock released LAST. In the
// production batch, that order is enforced by ingestBatch's internal join+flush (it aborts intake, joins
// its dispatchers, then force-flushes the checkpoint before it RETURNS) followed by withWriteTransaction
// releasing the global lock only after the body returns (lock-release-last). See cli.ts's batch body and
// the comment there.
//
// We instrument node:fs/promises to observe the checkpoint flush, and drive a real abort mid-batch through
// backends.signal — exactly as cli.ts's SIGINT handler (onSig -> ac.abort()) does — so nothing here fakes
// the ordering; it is the real ingestBatch teardown under a real transaction.

const realFs = await import("node:fs/promises");
// Capture the ORIGINAL writeFile reference now, before mock.module rebinds the namespace — otherwise the
// wrapper would call itself (mock.module makes realFs.writeFile point back at our wrapper → recursion).
const originalWriteFile = realFs.writeFile;
// Recorded lifecycle events, in the order the production path emits them.
const events: string[] = [];

// bun mock.module: intercept the checkpoint file writes so we can see the flush relative to abort/join.
const { mock } = await import("bun:test");
const CHECKPOINT_FILE = ".pyramid-ingest.checkpoint.json";
mock.module("node:fs/promises", () => ({
  ...realFs,
  writeFile: async (p: any, ...rest: any[]) => {
    const s = String(p);
    // Checkpoint writes go to a tmp file "<...>.checkpoint.json.<pid>.<rand>.tmp" then rename. ingestBatch
    // persists the checkpoint EARLY too (in-flight claim, before decode); we only care about the SHUTDOWN
    // flush — the force-flush that happens during teardown, AFTER intake was aborted. Record only that one.
    if (
      s.includes(CHECKPOINT_FILE) &&
      events.includes("intake-aborted") &&
      !events.includes("checkpoint-flushed")
    ) {
      events.push("checkpoint-flushed");
    }
    return (originalWriteFile as any)(p, ...rest);
  },
}));

// SUT pulled AFTER the mock is registered so ingest.ts's static fs bindings see the wrappers.
const { ingestBatch } = await import("../src/ingest");
const { withWriteTransaction } = await import("../src/transaction");
import type { Backends } from "../src/ingest";

const GLOBAL_LOCK = ".pyramid-ingest.lock";

let out: string;
let src: string;
afterEach(async () => {
  await rm(out, { recursive: true, force: true }).catch(() => {});
  await rm(src, { recursive: true, force: true }).catch(() => {});
  events.length = 0;
});

async function globalLockPresent(dir: string): Promise<boolean> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.includes(GLOBAL_LOCK);
}

test("the real batch path releases the global lock LAST: intake-aborted -> workers-joined -> checkpoint-flushed -> lock-released", async () => {
  out = await mkdtemp(join(tmpdir(), "pyr-tx-prod-out-"));
  src = await mkdtemp(join(tmpdir(), "pyr-tx-prod-src-"));
  const f1 = join(src, "a.orf");
  const f2 = join(src, "b.orf");
  await writeFile(f1, new Uint8Array([1]));
  await writeFile(f2, new Uint8Array([2]));

  // The abort controller stands in for cli.ts's `ac`; firing it is exactly what onSig (SIGINT/SIGTERM)
  // does in production — it ONLY aborts intake. The lock is owned by the enclosing transaction.
  const ac = new AbortController();

  // A gate the test opens once the first decode is in flight and the global lock is confirmed held.
  let firstDecodeInFlight!: () => void;
  const firstDecodeStarted = new Promise<void>((r) => { firstDecodeInFlight = r; });

  const backends: Backends = {
    raw: {
      async decode() {
        // First image is "actively writing" when the signal fires. Announce, then block until aborted.
        firstDecodeInFlight();
        while (!ac.signal.aborted) await new Promise((r) => setTimeout(r, 5));
        // Intake noticed the abort mid-write (between chunks). Record and unwind like the real worker.
        if (!events.includes("intake-aborted")) events.push("intake-aborted");
        const e: any = new Error("aborted by signal");
        e.code = "ABORT_ERR";
        throw e;
      },
    },
    jxl: {
      async encodePyramid() { return []; },
      async encodeTileContainer() { return new Uint8Array(1); },
      async transcodeJpeg(b: Uint8Array) { return b; },
      async decodeToRgba8(b: Uint8Array) { return { rgba: b, width: 1, height: 1 }; },
    },
    signal: ac.signal,
    __testInProcess: true,
  } as any;

  // === EXACT reproduction of cli.ts's batch body: mutation runs inside the write transaction, which
  // owns lock acquire/release; ingestBatch joins workers + flushes the checkpoint before returning. ===
  const runBatch = withWriteTransaction(out, async (tx) => {
    const result = await ingestBatch([f1, f2], backends, {
      outDir: out,
      concurrency: 1,
      globalLock: tx.token, // finding 68: prove GLOBAL held so per-image locks assert GLOBAL-then-IMAGE
    });
    // ingestBatch has now returned: dispatchers joined + checkpoint force-flushed. Record the join
    // relative to the (already-recorded) intake-abort and the (fs-observed) checkpoint flush.
    if (!events.includes("workers-joined")) events.push("workers-joined");
    return result;
  });

  // Wait until the first decode is genuinely in flight AND the global lock is held, THEN fire the signal.
  await firstDecodeStarted;
  expect(await globalLockPresent(out)).toBe(true); // lock is held while the batch actively writes
  ac.abort(); // signal fires DURING the active write (models SIGINT mid-batch)

  await runBatch; // resolves only after the transaction released the global lock

  // The global lock is released only AFTER ingestBatch returned (workers joined + checkpoint flushed).
  expect(await globalLockPresent(out)).toBe(false);
  events.push("lock-released");

  // Mandated order (finding 69): intake aborted -> workers joined -> checkpoint flushed -> lock released.
  // (checkpoint-flushed and workers-joined both precede lock-released; intake-aborted precedes both.)
  expect(events[0]).toBe("intake-aborted");
  expect(events).toContain("workers-joined");
  expect(events).toContain("checkpoint-flushed");
  expect(events[events.length - 1]).toBe("lock-released");
  expect(events.indexOf("intake-aborted")).toBeLessThan(events.indexOf("workers-joined"));
  expect(events.indexOf("checkpoint-flushed")).toBeLessThan(events.indexOf("lock-released"));
  expect(events.indexOf("workers-joined")).toBeLessThan(events.indexOf("lock-released"));
});
