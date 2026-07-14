# Opportunity Program Execution Slicing

**Purpose:** Convert first- and second-sweep findings into dependency-ordered agent
sessions small enough to implement, review, measure, and land without reloading the
entire repository into every context.

**Document owner:** Sonnet / M  
**Documentation worktree:** `C:\Foo\rcw-execution-slicing-sonnet-20260711`  
**Documentation branch:** `docs/execution-slicing-sonnet-20260711`

## Worktree Rule

One agent owns one worktree and one appropriately named branch. A worktree is never
shared concurrently. Packet leads integrate reviewed task branches into their packet
branch; the program integrator alone lands packet branches.

**Integrator worktree:** `C:\Foo\rcw-opportunity-integration-sonnet-20260711`  
**Integrator branch:** `integration/codebase-opportunities-wave2-20260711`

Branch prefixes communicate intent: `fix/`, `test/`, `perf/`, `feat/`, `refactor/`,
`ci/`, `chore/`, `docs/`, or `experiment/`. Every branch includes finding/task slug, agent
quality, and date.

## Packet Order

| Order | Document | Lead | Effort | Start condition | Completion condition |
|---:|---|---|---|---|---|
| 0 | Verification ledger | Sonnet | S | Audit base pinned | Findings 1-112 reconciled and links published |
| 1 | Packet 7: baselines/SLOs | Opus | XL | Immediate | Clean-clone truth, real-codec lane, current flipflop baseline |
| 2 | Packet 8: security/recovery | Opus | XL | Packet 7 fixtures may run in parallel | Identity, loader trust, deadline, lock, privacy, recovery gates pass |
| 3 | First-wave packet 1 residuals | Opus | XL sliced | Packet 8 contracts approved | 63-69 and 73 residuals land; do not redo closed 60-62/72 |
| 4 | First-wave packets 2/3 runtime | Opus | XL sliced | Identity, memory, CI, distribution contracts stable | Delivery/runtime owners converge; branch-ready work reviewed |
| 5 | Packet 9: product opportunities | Opus | XL program | Durable identity/commands and authoritative tests stable | Vertical slices 83-98 pass behavior/accessibility/perf gates |
| 6 | Packet 10: release/compatibility | Opus | XL program | May start host contract early; final gate waits for target slices | Hosted/browser/provenance/schema/Tauri rollback gate passes |
| R | Experimental packet 6 | Fable | XL research | Baselines and production contracts stable | Measured go/no-go; no production merge without product value |

Packet 7 CI and packet 10 host-contract work can start immediately in parallel.
Packet 8 identity/lock design can also start, but its measurement harness consumes
packet 7 conventions.

## Critical Path

```text
root quality truth (8, 28, 101-106)
  -> memory/trust/ownership contracts (66-69, 73, 107, 109-110)
  -> delivery runtime (17, 31-33, 63-65, 70-82)
  -> durable project/edit/catalog (83-93)
  -> HDR/motion/AI and responsive UX (94-98)
  -> hosted compatibility and rollback (99-100)
```

Do not wait for research findings 27 and 36 before shipping production work.

## Residual XL Decomposition

### Contracts And Reliability

| Unit | Agent / effort | Worktree | Branch | Depends |
|---|---|---|---|---|
| 64 writer provenance propagation | Opus / S | `C:\Foo\rcw-f64-source-provenance-opus-20260711` | `fix/f64-source-provenance-opus-20260711` | Current v5 fixtures |
| 65 shared version policy | Opus / M | `C:\Foo\rcw-f65-schema-policy-opus-20260711` | `fix/f65-schema-policy-opus-20260711` | 64 |
| 63 tile-size strictness/interoperability | Opus / M | `C:\Foo\rcw-f63-tilesize-contract-opus-20260711` | `fix/f63-tilesize-contract-opus-20260711` | 65 |
| 73 remote trust hardening | Opus / L | `C:\Foo\rcw-f73-gallery-trust-opus-20260711` | `fix/f73-gallery-trust-opus-20260711` | 63-66, packet 8 trust model |
| 66 identity ADR/fixtures | Opus / M | `C:\Foo\rcw-f66-identity-contract-opus-20260711` | `test/f66-identity-contract-opus-20260711` | None |
| 66 fingerprint primitives/integration | Opus / L | `C:\Foo\rcw-f66-fingerprint-opus-20260711` | `feat/f66-fingerprint-opus-20260711` | Identity ADR |
| 66 relink/migration | Opus / L | `C:\Foo\rcw-f66-relink-migration-opus-20260711` | `feat/f66-relink-migration-opus-20260711` | Fingerprint, 100a |
| 67 deadline scope | Opus / L | `C:\Foo\rcw-f67-deadline-scope-opus-20260711` | `fix/f67-deadline-scope-opus-20260711` | Failure fixtures |
| 68/69 owner-token lock primitive | Opus / M | `C:\Foo\rcw-f69-lock-owner-opus-20260711` | `fix/f69-lock-owner-opus-20260711` | None |
| 68 transaction adoption | Opus / L | `C:\Foo\rcw-f68-transactions-opus-20260711` | `fix/f68-transactions-opus-20260711` | Lock primitive, 67 |
| 69 ordered shutdown/fault matrix | Opus / M | `C:\Foo\rcw-f69-shutdown-opus-20260711` | `test/f69-shutdown-opus-20260711` | Transactions |

Closed 60-62 and 72 get compatibility hardening only. Do not reopen their migrations
unless a new failing fixture proves a behavioral gap.

### Pyramid Delivery

| Unit | Agent / effort | Worktree | Branch | Depends |
|---|---|---|---|---|
| 70 RGB16 tiling policy | Opus / L | `C:\Foo\rcw-f70-rgb16-policy-opus-20260711` | `fix/f70-rgb16-policy-opus-20260711` | 63, 107 |
| 71 bounded convergence | Opus / M | `C:\Foo\rcw-f71-convergence-opus-20260711` | `perf/f71-convergence-opus-20260711` | Packet 7 baseline |
| 74 canonical modular gallery | Sonnet / L | `C:\Foo\rcw-f74-canonical-gallery-sonnet-20260711` | `refactor/f74-canonical-gallery-sonnet-20260711` | 72-73 |
| 77 orchestration contract | Opus / XL | `C:\Foo\rcw-f77-tiled-orchestration-opus-20260711` | `refactor/f77-tiled-orchestration-opus-20260711` | 63, 70-74 |
| 78 pool/source identity | Opus / L | `C:\Foo\rcw-f78-pool-identity-opus-20260711` | `fix/f78-pool-identity-opus-20260711` | 66, 77 |
| 79/80 byte carrier and unload | Opus / L | `C:\Foo\rcw-f79-worker-bytes-opus-20260711` | `perf/f79-worker-bytes-opus-20260711` | 77, 107 |
| 81 precision-aware seed | Opus / M | `C:\Foo\rcw-f81-seed-precision-opus-20260711` | `fix/f81-seed-precision-opus-20260711` | 63, 70 |
| 82 worker/SAB capability split | Opus / S | `C:\Foo\rcw-f82-worker-capability-opus-20260711` | `fix/f82-worker-capability-opus-20260711` | 32, 79/80 |

### Native And WASM Runtime

| Unit | Agent / effort | Worktree | Branch | Gate |
|---|---|---|---|---|
| Review/land role loader and dead-pool removal (17/31) | Opus / M | `C:\Foo\rcw-f17-role-loader-review-opus-20260711` | `review/f17-role-loader-opus-20260711` | Rebase `feat/jxl-role-loader`; run build/types/tests/provenance; no blind merge |
| ST RAW/JXL distribution (32) | Opus / L | `C:\Foo\rcw-f32-st-fallback-opus-20260711` | `feat/f32-st-fallback-opus-20260711` | Non-COI browser E2E; ST/MT output parity; flipflopdom |
| Advanced setter contract (19) | Opus / M | `C:\Foo\rcw-f19-settings-contract-opus-20260711` | `fix/f19-settings-contract-opus-20260711` | Capability truth; every accepted option changes encoder or rejects |
| Incremental native streams (20) | Opus / XL | `C:\Foo\rcw-f20-native-streams-opus-20260711` | `feat/f20-native-streams-opus-20260711` | Bounded memory, first-byte proof, cancellation, flipflop/flipflopMem |
| SIMD MHC (21) | Opus / L | `C:\Foo\rcw-f21-simd-mhc-opus-20260711` | `perf/f21-simd-mhc-opus-20260711` | Scalar equality/corpus quality plus flipflop |
| JPEG v2/JUMBF facade (22) | Opus / L | `C:\Foo\rcw-f22-jpeg-v2-opus-20260711` | `feat/f22-jpeg-v2-opus-20260711` | Metadata/JUMBF round trip and capability matrix |

Large RAW pipeline findings 34-35 and 50-58 form a separate Opus campaign after
DecodeLimits, memory authority, clean codec fixtures, and authoritative benchmarks
land. Do not combine them into one unreviewable branch. Split by format and retain
pixel/color/metadata goldens at every step.

## Quality Allocation

| Quality | Assign | Avoid |
|---|---|---|
| Haiku | Generated-file checks, deterministic fixture lists, registration, small labels after contract approval | Concurrency, schema decisions, memory conclusions, performance conclusions |
| Sonnet | CI/build plumbing, established UI wiring, accessibility, responsive states, canonical-module cleanup | Ambiguous ownership, codec algorithms, cross-language migrations |
| Opus | Identity, schemas, cancellation, locks, ABI, memory, color/HDR, delivery consolidation, migration/rollback | Mechanical tails with a clean independent boundary |
| Fable | Saliency/CASV/ML or codec research needing discovery and measured go/no-go | Production wiring whose interface already exists |

Once Opus or Fable has loaded a packet, keep it for adjacent tasks. Delegate only a
leaf whose inputs, outputs, tests, and review boundary are already fixed.

## Performance Proof Assignment

| Claim | Required tool | Examples in this program |
|---|---|---|
| Encode/decode/ingest/scheduler throughput | `flipflop.mjs` | 1, 21, 25, 66, 71, 83, 89, 93 |
| RSS/heap/WASM/retained memory | `flipflopMem.mjs` | 11, 20, 33, 39, 55, 59, 79/80, 92, 107 |
| First paint/interaction/browser startup | `flipflopdom.mjs` | 2, 12, 30, 32, 43, 47, 86, 92, 94-95, 98-99 |

Every performance branch must preserve runnable base/candidate artifacts, use
identical inputs/settings, interleave and rotate start order, enforce equality or
declared quality, report warm/cold distributions and thermal trust, and retain its
TOON record. Default acceptance remains at least 5% geomean `median_warm` improvement
with no fixture regression unless a stricter product SLO applies.

## Integration Checklist

- [ ] Rebase task branch on the integrator-pinned base before review.
- [ ] Confirm worktree and branch names match assignment.
- [ ] Run focused tests, authoritative root gates, and protected progressive tests
  whenever bridge/progressive behavior is touched.
- [ ] Review generated artifacts and provenance; do not accept unexplained dist churn.
- [ ] Attach flipflop journal for every performance/memory/paint claim.
- [ ] Update verification ledger with commit, gate result, and final status.
- [ ] Land in dependency order; rollback a packet independently when its gate fails.
