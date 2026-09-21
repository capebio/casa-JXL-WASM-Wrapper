import { afterEach, expect, test, mock } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setJxlModuleFactoryForTesting } from "@casabio/jxl-wasm";
import type { Backends } from "../src/ingest";
import type { DecodedMaster, JxlBackend, RawBackend, RawFormat } from "../src/backends";

// Install an overridable fs mock *before* importing the SUT so ingest.ts's static "node:fs/promises"
// binding resolves to our wrapper. By default readFile is the real one; the read-stage test swaps in a
// slow hook for a specific master path to make the deadline expire *during* the read. All other tests
// (and the test helpers above, which import the real fns directly) are unaffected.
const realFs = await import("node:fs/promises");
// Capture the REAL readFile before mock.module mutates the live namespace — the hook's fallback must
// call the original, or it re-enters itself (infinite recursion). (Bun replaces realFs.readFile too.)
const REAL_READ_FILE = realFs.readFile;
let readFileHook: ((path: string, ...rest: any[]) => Promise<any>) | null = null;
mock.module("node:fs/promises", () => ({
  ...realFs,
  readFile: async (path: any, ...rest: any[]) => {
    if (readFileHook) return readFileHook(String(path), ...rest);
    return (REAL_READ_FILE as any)(path, ...rest);
  },
}));

// Pull the SUT after the mock is registered so its static fs import sees the wrapper.
const { ingestBatch, ingestImage } = await import("../src/ingest");
const { imageIdForPath } = await import("../src/hash");

afterEach(() => { readFileHook = null; setJxlModuleFactoryForTesting(null); });

// A promise that resolves as soon as an AbortSignal fires (or immediately if already aborted).
// Used by the blocking test backends so a stage settles *after* the deadline rather than hanging.
function whenAborted(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise(() => {}); // never resolves — should not happen once the signal is threaded
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((res) => signal.addEventListener("abort", () => res(), { once: true }));
}

function gradientRgba(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = i & 0xff; px[i + 1] = (i >> 3) & 0xff; px[i + 2] = (i >> 6) & 0xff; px[i + 3] = 255; }
  return px;
}

async function tmpOut(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pyramid-deadline-"));
}

async function writeMaster(dir: string, name: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, new Uint8Array([0, 1, 2, 3]));
  return p;
}

// Asserts nothing was published for this image and no temporaries linger.
async function assertNoPublish(out: string, imageId: string): Promise<void> {
  const manifestPath = join(out, "images", imageId, "manifest.json");
  await expect(readFile(manifestPath)).rejects.toThrow();
  const levelFiles = await readdir(join(out, "levels")).catch(() => [] as string[]);
  expect(levelFiles.filter((f) => f.endsWith(".jxl")).length).toBe(0);
  expect(levelFiles.filter((f) => f.includes(".tmp")).length).toBe(0);
  const imgFiles = await readdir(join(out, "images", imageId)).catch(() => [] as string[]);
  expect(imgFiles.filter((f) => f.includes(".tmp")).length).toBe(0);
}

// Builds a backends object whose stages block on the per-image combined signal. The SUT threads the
// combined signal (caller-cancel + deadline) into the backend methods as the trailing `signal`
// argument (RawBackend.decode / JxlBackend.encodeTileContainer). The blocking stage awaits that
// signal, then throws — proving the deadline reaches the backend and the work is joined.
function blockingBackends(blockAt: "decode" | "encode", callerSignal?: AbortSignal): {
  backends: Backends; settled: () => boolean;
} {
  let settledFlag = false;

  const raw: RawBackend = {
    async decode(_bytes: Uint8Array, _format: RawFormat, signal?: AbortSignal): Promise<DecodedMaster> {
      if (blockAt === "decode") {
        await whenAborted(signal);
        settledFlag = true;
        const err: any = new Error("aborted during decode");
        err.code = "ABORT_ERR";
        throw err;
      }
      return { rgba: gradientRgba(300, 200), width: 300, height: 200, orientation: "baked" };
    },
  };
  const jxl: JxlBackend = {
    async encodePyramid() { return []; },
    async encodeTileContainer(_rgba, w, h, _opts, signal) {
      if (blockAt === "encode") {
        await whenAborted(signal);
        settledFlag = true;
        const err: any = new Error("aborted during encode");
        err.code = "ABORT_ERR";
        throw err;
      }
      return new Uint8Array([0xA0, w & 0xff, h & 0xff]);
    },
    async downscaleRgba8(_rgba, _sw, _sh, dw, dh) { return new Uint8Array(dw * dh * 4); },
    async transcodeJpeg(b) { return b; },
    async decodeToRgba8(b) { return { rgba: b, width: 4, height: 3 }; },
  } as any;

  const backends: Backends = { raw, jxl, __testInProcess: true, ...(callerSignal ? { signal: callerSignal } : {}) } as any;
  return { backends, settled: () => settledFlag };
}

// Backends whose decode + encode both succeed instantly. Used by the read-stage test: if the deadline
// did NOT gate the read, ingest would sail through decode/encode and publish — the assertion that
// nothing is published is what fails before the fix.
function fastBackends(): Backends {
  const raw: RawBackend = {
    async decode(): Promise<DecodedMaster> {
      return { rgba: gradientRgba(64, 48), width: 64, height: 48, orientation: "baked" };
    },
  };
  const jxl: JxlBackend = {
    async encodePyramid() { return []; },
    async encodeTileContainer(_rgba, w, h) { return new Uint8Array([0xA0, w & 0xff, h & 0xff]); },
    async downscaleRgba8(_rgba, _sw, _sh, dw, dh) { return new Uint8Array(dw * dh * 4); },
    async transcodeJpeg(b) { return b; },
    async decodeToRgba8(b) { return { rgba: b, width: 4, height: 3 }; },
  } as any;
  return { raw, jxl, __testInProcess: true } as any;
}

// Deadline expiring while the master READ is in flight: the read is the first expensive step on the
// timed path. A slow read hook makes the deadline fire *during* the read; the read-stage checkpoint
// must abort with stage="read" and publish nothing. Before the fix the combined signal did not exist
// until after the read (and there was no read gate), so decode/encode ran and the image published.
test("deadline during read: aborts at the read stage and publishes nothing", async () => {
  const out = await tmpOut();
  const master = await writeMaster(out, "READ_BLOCK.orf");
  const imageId = await imageIdForPath(master);

  // Slow ONLY the master read; every other read (e.g. the ENOENT manifest probe) stays real+fast.
  // 120ms read vs a 30ms deadline → the deadline fires while the read await is pending.
  readFileHook = async (path, ...rest) => {
    if (path.endsWith("READ_BLOCK.orf")) {
      await new Promise((r) => setTimeout(r, 120));
      return (REAL_READ_FILE as any)(path, ...rest);
    }
    return (REAL_READ_FILE as any)(path, ...rest);
  };

  const err = await ingestImage(master, fastBackends(), { outDir: out, timeoutMs: 30 }).then(() => null, (e) => e);

  expect(err).toBeTruthy();
  expect((err as any).code).toBe("ABORT_ERR");
  expect((err as any).stage).toBe("read");
  await assertNoPublish(out, imageId);
});

// Deadline expiring while DECODE is blocked: the decode is joined (settled) before ingestImage
// returns, the error is ABORT_ERR carrying stage="decode", and nothing is published.
test("deadline during decode: joins work, aborts with stage metadata, publishes nothing", async () => {
  const out = await tmpOut();
  const master = await writeMaster(out, "DECODE_BLOCK.orf");
  const imageId = await imageIdForPath(master);
  const { backends, settled } = blockingBackends("decode");

  const err = await ingestImage(master, backends, { outDir: out, timeoutMs: 40 }).then(() => null, (e) => e);

  expect(err).toBeTruthy();
  expect((err as any).code).toBe("ABORT_ERR");
  expect((err as any).stage).toBe("decode");
  expect(settled()).toBe(true); // the blocked decode was joined before ingestImage returned
  await assertNoPublish(out, imageId);
});

// Deadline expiring while ENCODE is blocked: no level file and no manifest leak past the deadline.
test("deadline during encode: no level or manifest leaks past the deadline", async () => {
  const out = await tmpOut();
  const master = await writeMaster(out, "ENCODE_BLOCK.orf");
  const imageId = await imageIdForPath(master);
  const { backends, settled } = blockingBackends("encode");

  // tile-all routes every level through encodeTileContainer (the stage the fake blocks on).
  const err = await ingestImage(master, backends, { outDir: out, timeoutMs: 40, tiling: "tile-all" }).then(() => null, (e) => e);

  expect(err).toBeTruthy();
  expect((err as any).code).toBe("ABORT_ERR");
  expect(settled()).toBe(true);
  await assertNoPublish(out, imageId);
});

// Caller cancellation composes into the same per-image signal: aborting the caller signal mid-decode
// cancels the work end to end with ABORT_ERR and no publish, even with no deadline set.
test("caller cancel composes with deadline: aborting caller signal cancels the image", async () => {
  const out = await tmpOut();
  const master = await writeMaster(out, "CALLER_CANCEL.orf");
  const imageId = await imageIdForPath(master);
  const callerAc = new AbortController();
  const { backends, settled } = blockingBackends("decode", callerAc.signal);

  setTimeout(() => callerAc.abort(), 30);
  const err = await ingestImage(master, backends, { outDir: out }).then(() => null, (e) => e);

  expect(err).toBeTruthy();
  expect((err as any).code).toBe("ABORT_ERR");
  expect(settled()).toBe(true);
  await assertNoPublish(out, imageId);
});

// Pre-rename checkpoint: the plan is fully built (decode + encode succeed), then the signal fires
// right before the atomic manifest rename. applyIngestPlan's publish gate must refuse to publish —
// no manifest appears (the sole "visible" artifact), and no manifest .tmp lingers.
test("deadline at the pre-rename publish boundary: manifest is never renamed in", async () => {
  const out = await tmpOut();
  const master = await writeMaster(out, "PUBLISH_BLOCK.orf");
  const imageId = await imageIdForPath(master);

  // Decode + encode succeed; the abort is deferred to a macrotask so it lands *after* every
  // synchronous encode checkpoint has passed (plan fully built) and fires while applyIngestPlan is
  // awaiting its first fs op — i.e. exactly at the pre-rename publish boundary, not during encode.
  const callerAc = new AbortController();
  const raw: RawBackend = {
    async decode(): Promise<DecodedMaster> {
      return { rgba: gradientRgba(300, 200), width: 300, height: 200, orientation: "baked" };
    },
  };
  const jxl: JxlBackend = {
    async encodePyramid() { return []; },
    async encodeTileContainer(_rgba, w, h) { return new Uint8Array([0xA0, w & 0xff, h & 0xff]); },
    async downscaleRgba8(_rgba, _sw, _sh, dw, dh) { return new Uint8Array(dw * dh * 4); },
    async transcodeJpeg(b) { return b; },
    async decodeToRgba8(b) { return { rgba: b, width: 4, height: 3 }; },
  } as any;
  // Deterministic pre-publish abort: fire on the "manifest-built" telemetry stage — the last stage
  // before the publish gate (ingest.ts: throwIfAborted(sig, "publish")). This replaces a setTimeout(0)
  // race that was platform-dependent: it passed on Windows but failed on Linux CI, where the
  // all-microtask mock pipeline drained to completion before the macrotask fired, so the abort landed
  // after publish and never triggered the gate (err was null).
  const backends: Backends = {
    raw, jxl, signal: callerAc.signal, __testInProcess: true,
    telemetry: { stage(name: string) { if (name === "manifest-built") callerAc.abort(); } },
  } as any;

  const err = await ingestImage(master, backends, { outDir: out, tiling: "tile-all" }).then(() => null, (e) => e);

  expect(err).toBeTruthy();
  expect((err as any).code).toBe("ABORT_ERR");
  expect((err as any).stage).toBe("publish");
  // The manifest — the only artifact that makes an image visible — must not exist. (Level blobs may
  // have been written before the abort; those are unreferenced orphans GC reclaims, but never a
  // manifest, and never a lingering manifest .tmp.)
  const manifestPath = join(out, "images", imageId, "manifest.json");
  await expect(readFile(manifestPath)).rejects.toThrow();
  const imgFiles = await readdir(join(out, "images", imageId)).catch(() => [] as string[]);
  expect(imgFiles.filter((f) => f.includes(".tmp")).length).toBe(0);
});

// Batch/worker path: a caller signal that aborts mid-batch settles cleanly (the batch promise
// resolves, does not hang) and publishes nothing for the images that were still in flight.
//
// NOTE (follow-up): this exercises the in-process batch path (__testInProcess). The in-process path
// mirrors the real worker_threads protocol — each dispatcher awaits one image at a time and, on
// abort, the pool terminates its workers and rejects their pending jobs with ABORT_ERR (ingest.ts
// ingestBatch, onAbort handler), the same settle-not-hang contract asserted here. A dedicated test
// that drives the REAL worker pool (dist/ingest-worker.js + real WASM backends, no __testInProcess)
// to prove the worker settles and the stage propagates over postMessage is deferred: it needs a
// compiled worker + real libjxl WASM in the harness and does not change the abort protocol this test
// already covers.
test("ingestBatch with caller cancel settles without hanging and publishes nothing", async () => {
  const out = await tmpOut();
  const m1 = await writeMaster(out, "B1.orf");
  const m2 = await writeMaster(out, "B2.orf");
  const callerAc = new AbortController();

  // Blocking decode so both images are still in flight when the caller cancels.
  const raw: RawBackend = {
    async decode(_bytes: Uint8Array, _format: RawFormat, signal?: AbortSignal): Promise<DecodedMaster> {
      await whenAborted(signal ?? callerAc.signal);
      const err: any = new Error("aborted during decode");
      err.code = "ABORT_ERR";
      throw err;
    },
  };
  const jxl: JxlBackend = {
    async encodePyramid() { return []; },
    async encodeTileContainer(_rgba, w, h) { return new Uint8Array([0xA0, w & 0xff, h & 0xff]); },
    async downscaleRgba8(_rgba, _sw, _sh, dw, dh) { return new Uint8Array(dw * dh * 4); },
    async transcodeJpeg(b) { return b; },
    async decodeToRgba8(b) { return { rgba: b, width: 4, height: 3 }; },
  } as any;
  const backends: Backends = { raw, jxl, signal: callerAc.signal, __testInProcess: true } as any;

  setTimeout(() => callerAc.abort(), 40);
  // The batch must SETTLE (resolve) — a hang here fails the test via bun's per-test timeout.
  const result = await ingestBatch([m1, m2], backends, { outDir: out, concurrency: 2 });

  expect(result.written).toBe(0);
  // Nothing published for either in-flight image.
  for (const id of [await imageIdForPath(m1), await imageIdForPath(m2)]) {
    await expect(readFile(join(out, "images", id, "manifest.json"))).rejects.toThrow();
  }
});
