import { expect, test } from "bun:test";
import { makeAbortError } from "../src/abort";

// T6 follow-up: makeAbortError must CLONE a shared coded reason, not mutate it. In a batch that shares
// one caller-supplied ABORT_ERR reason, two images aborting at different stages must each report their
// OWN stage — mutating the shared reason's .stage in place makes later images report the wrong stage.
test("two aborts off a shared coded reason keep independent stages", () => {
  // A single caller reason object shared across the batch (e.g. one AbortSignal.reason).
  const sharedReason = Object.assign(new Error("caller cancelled"), { code: "ABORT_ERR" as const });

  const first = makeAbortError("decode", sharedReason);
  const second = makeAbortError("publish", sharedReason);

  expect(first.stage).toBe("decode");
  expect(second.stage).toBe("publish");
  // The shared reason itself must be untouched (no in-place stage graffiti).
  expect((sharedReason as any).stage).toBeUndefined();
  // Each returned error is a distinct object, not the shared reason.
  expect(first).not.toBe(sharedReason);
  expect(second).not.toBe(sharedReason);
  expect(first).not.toBe(second);
});

// When the shared reason already carries a stage, that stage is preserved (not overwritten) and still
// cloned so the original is not aliased.
test("a coded reason with an existing stage is preserved and cloned", () => {
  const sharedReason = Object.assign(new Error("cancelled at read"), {
    code: "ABORT_ERR" as const,
    stage: "read" as const,
  });

  const cloned = makeAbortError("encode", sharedReason);

  expect(cloned.stage).toBe("read"); // existing stage wins over the fallback
  expect(cloned).not.toBe(sharedReason);
  expect(cloned.code).toBe("ABORT_ERR");
});
