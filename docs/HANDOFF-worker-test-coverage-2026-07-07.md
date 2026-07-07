# HANDOFF — Worker Decode-Handler: budgetMs null test (2026-07-07)

**Worktree:** `C:\Foo\raw-converter-wasm\Foorcw-worker-tests`
**Branch:** `test/worker-decode-handler-coverage-jul07`
**Scope:** `packages/jxl-worker-browser/test/handlers.test.ts` only.

## Context

`CLAUDE.md §Test Gaps (decode-handler)` lists 6 missing tests. Of these, 5 are already covered
in `handlers.test.ts`. The one remaining gap is:

> **`budgetMs == null` → no crash**

There is already a `baseDecodeStart` config at line 19 with `budgetMs: null`, but no test
specifically isolates the null-budget contract: a decode session with `budgetMs: null` must
complete normally without throwing or producing a BudgetExceeded event.

## Task

In `packages/jxl-worker-browser/test/handlers.test.ts`, add one focused test:

```ts
test("budgetMs-null: decode completes without crash", async () => {
  // Use the existing test scaffold (spawn handler, send decode_start with budgetMs: null)
  // Send a small valid JXL payload.
  // Assert: terminal message is 'decode_done' (not 'decode_budget_exceeded', not an Error).
  // Assert: no uncaught exception / rejection.
});
```

**How to find the right scaffold:**
- Read the existing `"budget-pre-progress"` test (around line 189) — it uses `budgetMs: 0`.
- Copy the same structure but with `budgetMs: null`.
- The expected outcome is the normal happy path: `decode_done` terminal message.

**Runner:** `node --test` (not bun — see CLAUDE.md decode-session gotcha).

## Success criteria

- New test named something like `"budgetMs: null — completes normally"` passes with `node --test`.
- No other tests broken.
- Update `CLAUDE.md §Test Gaps` to remove `budgetMs == null` from the list.
- Commit: `test(decode-handler): add isolated budgetMs=null no-crash contract`

## Do NOT

- Do not add the other 5 CLAUDE.md gap tests — they are out of scope for this handoff.
- Do not change handler source code — test-only change.
- Do not run `bun test` for this package — use `node --test`.
