# EpicCodeReview

**Target:** src/lib.rs (2842 lines, Rust/WASM)  **Mode:** workalone  **Sections:** 1/1 + global
**Branch:** `epiccodereview/20260619T093126Z`  **Status:** completed

## Summary

- 5 finder agents — per-file `correctness`, `hacker`, `structure`; whole-target `architecture`, `vision` — → dedupe → 4 parallel verifiers → plan → fix.
- **Confirmed:** 37 section (25 issues / 12 opportunities) + 25 global (2 issues / 23 ADR-worthy). 12 false positives dropped by the verifier.
- **Applied:** 4 safe overflow/panic guards (commit `a5a2c5d7`); verified with `cargo check --target wasm32-unknown-unknown` (clean — pre-existing dead-code warnings only).
- **Deferred:** 33 section + 25 global → `QUESTIONS.md` (perf needs measurement; flag-API + intent need a human; opportunities → ADR drafts).
- **CodeQL:** skipped — Rust is not covered by the no-build suites (expected).

## Headline

The single highest-signal finding — `OUT_FULL_16 == OUT_NO_ORIENT == 8`, a silent flag collision at `src/lib.rs:551,556` — was surfaced **independently by 4 of the 5 agents** (correctness, hacker, structure, architecture). It is **deferred, not auto-fixed**: changing a public flag value is an ABI change visible to JS callers, and intent is ambiguous (one verifier read the adjacent comment as load-bearing-by-design). See `QUESTIONS.md` run-section §A.1.

## Applied fixes (committed `a5a2c5d7`)

1. `PerceptualComparer::new` — `width*height` and `n*4` → `saturating_mul` (wasm32 overflow would yield an undersized scratch buffer → later OOB).
2. `PerceptualComparer::all_at` — clamp `len` to `buf.len()` before slicing (a mismatched/early `len` from JS would trap the module).
3. `fstats_copy` — `width*height` → `saturating_mul` (matches `frame_stats`).
4. `frame_stats` — `expected = px*4` → `saturating_mul(4)`.

## Per-bucket

| Bucket | Agents | Confirmed | Issues | Opportunities | Applied | Deferred |
|--------|--------|----------:|-------:|--------------:|--------:|---------:|
| section `src/lib.rs` | correctness, hacker, structure | 37 | 25 | 12 | 4 | 33 |
| global (whole-target) | architecture, vision | 25 | 2 | 23 | 0 | 25 |

## Deferred — see QUESTIONS.md (run 20260619T093126Z)

- **§A** human decision (4): flag collision, exposure sentinel, `color_matrix_from_mn`, ptr contracts.
- **§B** perf-sensitive (11): double demosaic, redundant packs/copies, scalar→SIMD scatters, downscale divides, render clone — each needs a flipflop/bench before landing.
- **§C** structural ADR (10): params struct, bench-export gating, decoded-struct unification, MAX_DIM, NR-on-preview, dispatch consistency, memory budget, test coverage.
- **§D** vision ADR (6): ML recognition entry, photogrammetry linear-16 + sensor pitch, AR preview/crop, gaming LOD handle, stacking, Perceptual Constancy Mode hook.

## Workspace

`.epiccodereview/20260619T093126Z/` — full findings per agent, deduped candidates, verifier output, plans, and a sample ADR draft (`global/adr_draft/0001-output-flag-gated-decode.md`). Add `.epiccodereview/` to `.gitignore`.

## Next

1. Decide `QUESTIONS.md` §A.1 (the flag collision) — a yes/no on whether the aliasing is intentional.
2. Perf items (§B) each need a flipflop or bench (≥5% + parity) before they can land.
3. This run validated the restructured 5-agent pipeline (3 per-file + 2 whole-target, security folded into correctness, dedupe-before-verify, perf gate) end-to-end on a real 2842-line file.
