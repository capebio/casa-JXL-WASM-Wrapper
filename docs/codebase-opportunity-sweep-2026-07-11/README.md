# Codebase Opportunity Sweep

This folder contains the second-pass verification and implementation strategy for
the 2026-07-11 codebase opportunity review.

Audit base: `origin/main` at `cdd9e6b2`.

## Read In This Order

1. [Verification ledger](2026-07-11-opportunity-verification-ledger.md)
2. [Baselines, test authority, and SLOs](2026-07-11-opportunity-07-baselines-slos.md)
3. [Security, reliability, and recovery](2026-07-11-opportunity-08-security-reliability-recovery.md)
4. [Product opportunities](2026-07-11-opportunity-09-product-opportunities.md)
5. [Release and compatibility](2026-07-11-opportunity-10-release-compatibility.md)
6. [Execution slicing](2026-07-11-opportunity-11-execution-slicing.md)

The first-pass roadmap and findings 1-82 remain in
[`docs/superpowers/plans/2026-07-11-codebase-opportunity-roadmap.md`](../superpowers/plans/2026-07-11-codebase-opportunity-roadmap.md).

## Scope

- Findings 1-82 are reconciled against current code.
- Findings 83-112 cover product, release, test authority, performance baselines,
  security, reliability, and recovery gaps.
- Every implementation task names an agent quality, effort, worktree, branch, and
  acceptance gate.
- Performance claims require the appropriate `flipflop.mjs`, `flipflopMem.mjs`, or
  `flipflopdom.mjs` test and retained result record.

