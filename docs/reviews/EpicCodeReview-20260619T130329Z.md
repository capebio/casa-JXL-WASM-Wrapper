# EpicCodeReview — ProgressiveJXLEncodeBunch

**Target:** 7-file progressive-JXL encode bunch
**Branch:** `ProgressiveJXLEncodeBunch` (cut from `epiccodereview/ssim-boundary-20260619` HEAD, which is ahead of `main`)
**Mode:** workalone (all Sonnet) · **Languages:** Rust, TypeScript · **Generated:** 2026-06-19
**Workspace:** `.epiccodereview/20260619T130329Z/`

Files reviewed:
`crates/raw-pipeline/src/jxl_casaencoder.rs`, `crates/raw-pipeline/src/casabio_encode.rs`,
`crates/jxl-ffi/src/lib.rs`, `packages/jxl-progressive/src/{index,progressive-manifest,progressive-stream,progressive-scheduler}.ts`

---

## ⏱ Timing improvements (flipflop) — the headline

Measured with the repo's native A/B convention (interleaved, start-rotated, median ms), via the new harness `crates/raw-pipeline/examples/casabio_encode_flip.rs`. Numbers below are **my own reproduction** (`cargo run --release --example casabio_encode_flip --no-default-features`), not the subagent's. Every kept change is **pixel-parity exact**.

| Optimization | Size | Before → After | Speedup |
|---|---|---|---|
| **Fuse alpha-scan + RGB-strip** (one RGBA pass instead of two; no unconditional copy on the dominant no-alpha/RAW path) | 2.46 MP | 5.013 → 4.086 ms | **+18.5%** |
| | 9.83 MP | 20.592 → 16.489 ms | **+19.9%** |
| | 24.16 MP | 75.685 → 60.097 ms | **+20.6%** |
| **Pyramid cascade: clone → move** (drop `thumb.clone()` + per-scaled-buffer clones) | 4096px, 3-level | 133.053 → 108.167 ms | **+18.7%** |

Both clear the ≥5% gate at every size with exact parity.

**Below-gate (not claimed as a win):** the `box_downscale` exact-ratio `count` hoist measured only +1.4–3.4% (< 5%). It was **kept** because it removes a provably-redundant per-pixel write (the exact-ratio branch always sums `xstep*ystep` pixels) — a correctness-neutral simplification, not a perf claim.

**Bogus measurement, disregarded:** the alpha-present microbench baseline optimized to 0.000 ms, making its ratio meaningless; both arms are < 0.03 ms (the early-abort path is irrelevant to the win).

> The single **largest** timing lever is *not* in this list — see the flagship ADR below. It is architectural (one progressive encode instead of three passes ≈ −2/3 encode CPU) and was deliberately **not** auto-applied.

---

## What landed (commit `414c8ec2`)

### Rust encode core
- **`casabio_encode.rs`** — fused `has_meaningful_alpha` + `rgba_to_rgb` into one `alpha_strip` pass (+18.5–20.6%); removed pyramid cascade clones (+18.7%); `box_downscale` count hoist (simplification); narrowed `encode_variants_progressive_opts` `pub → pub(crate)` (no external callers).
- **`jxl_casaencoder.rs`** — `check()` now surfaces the libjxl error detail (operation + status) instead of a generic message.
- Added **`examples/casabio_encode_flip.rs`** as the A/B measurement + regression harness (matches the existing 18 `*_flip.rs`/`*_bench.rs` examples).

### Progressive TypeScript
- **`progressive-manifest.ts`** — `validateManifest` now rejects non-positive/non-integer `jxl.bytes`, duplicate tier names, and non-ascending cross-tier `byteEnd` (consumer-confirmed against `progressive-stream.ts`'s cumulative `Range: bytes=0-…` reads).
- **`progressive-scheduler.ts`** — fixed **pre-existing TypeScript compile errors** (`delete` vs `= undefined` under `exactOptionalPropertyTypes`) that had blocked the *entire* test suite from running; fixed a TOCTOU on `job.manifest`; made the saliency priority boost idempotent; reported honest cache-hit progress; dropped a `session as any` cast; removed dead `scheduleTick`; awaited the orphaned `tee` pump on the `RangeNotSupported` fallback.

---

## Verification

- **raw-pipeline:** `cargo test --no-default-features --lib` → **135/135 pass** (before and after).
- **jxl-progressive:** `npm test` → **85/86 pass**. The suite was previously **uncompilable** (0 tests ran) due to the scheduler TS errors above; fixing them unblocked it. The 1 remaining failure (`profile.test.ts`: "dc tier byteEnd is less than full size") is a **pre-existing bug in `progressive-profile.ts`**, which is *out of the requested 7-file scope* and was **not** edited — the compile fix merely *exposed* it. Confirmed not caused by the in-scope edits (`profileJxl` does not call `validateManifest`).

---

## Flagship recommendation (ADR draft — not applied)

**Derive all three delivery tiers from ONE progressive JXL encode** instead of three independent libjxl passes.
`encode_variants` currently runs the full libjxl pipeline three times (thumb/preview/full), while the delivery layer (`progressive-manifest`/`-stream`/`-scheduler`) already assumes a *single* Range-fetchable progressive file with byte-offset tiers. A single progressive encode (`ProgressiveDc` + `GroupOrder`) with encoder-emitted offsets would eliminate ~2/3 of encode CPU and storage at ingest, and retire the `profileJxl` post-encode re-decode.

- **Risk / gate:** progressive stages quantise differently from independent encodes → each tier's Butteraugli/ΔE must be verified (use `.flipflop/tests/photon-qprogac.mjs` + the `.verify-quality` sibling). Storage-format change → needs a migration; ship behind an ingest flag.
- Draft: `.epiccodereview/20260619T130329Z/global/adr_draft/single-pass-progressive-encode.md`.

---

## Findings summary

| Bucket | Candidates | Confirmed | False positive | Uncertain |
|---|---:|---:|---:|---:|
| Section (correctness / hacker / structure) | 54 | 31 | 22 | 1 |
| Global (architecture / vision) | 26 → 20 clusters | 20 | 0 | 0 |

CodeQL: **skipped** (not installed on PATH; TypeScript would otherwise be eligible).

Deferred items (perf below gate, architectural ADRs, vision opportunities, and the high-priority out-of-scope `progressive-profile.ts` byteEnd bug) are logged in `QUESTIONS.md` under the `20260619T130329Z` section.

---

## Notes
- Your uncommitted `web/worker.js` tweak (`__disableThreadPool`) was **stashed** before branching — recover with `git stash list` / `git stash pop` on the original branch.
- The full audit trail (per-detector findings, verifier output, plans, fix logs, ADR draft) is in `.epiccodereview/20260619T130329Z/` (git-ignored).
