// Task 7 (findings 68, 69) — COMPILE-TIME evidence for the GLOBAL-then-IMAGE lock capability.
//
// The runtime tests (transaction.integration.test.ts) prove that a stale/forged token is REJECTED at
// runtime with a LockOrderError. This file proves the *other half* of the guarantee that the spec
// requires: that omitting or forging the GlobalWriteToken is a COMPILE error, not merely a runtime one.
//
// Each `@ts-expect-error` below asserts that the line beneath it does NOT typecheck. If the type-level
// guarantee ever regresses (e.g. the token stops being required, or the brand becomes forgeable), the
// error on that line disappears, the `@ts-expect-error` becomes UNUSED, and `tsc` fails with
// TS2578 ("Unused '@ts-expect-error' directive"). So this file only compiles clean while the guarantee
// holds — that is the evidence.
//
// This file is TYPE-ONLY: it is never executed. Everything lives behind a `false` guard and no lock is
// ever acquired. It is compiled by tsconfig.typecheck.json (see that config's `include`).

import {
  withImageWriteTransaction,
  withWriteTransaction,
  type GlobalWriteToken,
} from "../src/transaction";

// A never-run harness: purely for the type checker. The body is unreachable at runtime.
export async function __compileTimeLockEvidence(): Promise<void> {
  if (Math.random() < -1) {
    await withWriteTransaction("out", async (tx) => {
      const token: GlobalWriteToken = tx.token;

      // (a) POSITIVE control — calling WITH the real token typechecks (no @ts-expect-error here).
      // If this line ever fails to compile, the API shape regressed the other way.
      await withImageWriteTransaction(token, "out", "img", async () => {});

      // (b) OMITTING the token is an arity error (the global token is a MANDATORY first argument).
      //     If the token stops being required, this call compiles and the directive goes unused.
      // @ts-expect-error — GlobalWriteToken argument omitted: GLOBAL-then-IMAGE order not proven.
      await withImageWriteTransaction("out", "img", async () => {});

      // (c) FORGING the token with an empty object must not typecheck — the brand is a module-private
      //     unique symbol, so `{}` is not assignable to GlobalWriteToken.
      // @ts-expect-error — forged token ({}): not branded with the module-private GlobalWriteToken symbol.
      await withImageWriteTransaction({}, "out", "img", async () => {});

      // (d) FORGING the token with a plain string must not typecheck either.
      // @ts-expect-error — forged token ("nope"): a string is not a GlobalWriteToken.
      await withImageWriteTransaction("nope", "out", "img", async () => {});
    });
  }
}
