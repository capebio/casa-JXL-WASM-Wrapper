# HANDOFF — S1 Gate 1: raw-pipeline unification trial + measurement (2026-07-06)

Parent: `docs/STRATEGIC-MAP-wave2-2026-07-06.md` §S1. Approved by user 2026-07-06 as a
**two-gate** plan. This handoff is **G1 ONLY**.

- **G1 (this work):** integration branch pointing the desktop app at the canonical
  crate + parity corpus + end-to-end timings → a measured report. Nothing deleted,
  no behavior adopted silently. Fully reversible.
- **G2 (NOT this work):** delete vendored copies, pin dependency, freeze rule, GPL
  removal, holo-win porting. Happens only after the user reads G1's report and
  approves. Do not start G2 tasks.

The user explicitly wants **timings** — Phase 3 is a first-class deliverable, not a
checkbox. Sloppy numbers here poison a major architecture decision.

## Verified repo map (recon 2026-07-06 — trust this over older notes)

**Two lineages, not three.** `C:\Foo\raw-converter-tauri` and `C:\Foo\JXL_Tauri_with_WASM`
are checkouts of the **same repo** (`https://github.com/capebio/JXL_Tauri_with_WASM.git`):

| Path | Branch (at recon) | Role |
|---|---|---|
| `C:\Foo\raw-converter-wasm` | `perf/casv-video-simd-v2-jul05` | **Canonical lineage.** `crates/raw-pipeline` = superset: pipeline.rs 182K, BSD-clean own-FFI codec (`jxl_casaencoder/decoder`), casa_video, fable_braid, perceptual, stream_band/export/preview |
| `C:\Foo\JXL_Tauri_with_WASM` | `feat/save-name-from-source` | Desktop app, **user's primary checkout — do not touch** |
| `C:\Foo\raw-converter-tauri` | `handoff/phase0-slice-20260706` | Same repo, **ACTIVE parallel workstream (commits today)** — do not touch |
| `C:\Foo\raw-converter-tauri-*-holo`, `rct-*` | various | Same repo's optimization worktrees — **read-only reference** |

App lineage facts:

- Workspace = `["raw-pipeline", "src-tauri"]`; `src-tauri/Cargo.toml:41`:
  `raw-pipeline = { path = "../raw-pipeline", features = ["simd", "jxl-lowlevel", …] }`
  (read the full feature list — recon output was truncated).
- `src-tauri` ALSO depends directly on `jpegxl-rs = 0.10 (vendored)` + `jpegxl-sys`
  (GPL). **These stay untouched in G1** — GPL removal is G2.
- `src-tauri/src` has ~105 `raw_pipeline::` references across `pipeline.rs` (152.8K,
  app-level), `bench.rs` (82.3K — an existing bench harness, use it in Phase 3),
  `casabio.rs`, `casv.rs`, `jxl_native.rs`, `pyramid_store.rs`, …
- App's vendored `raw-pipeline`: pipeline.rs 71.2K, still has `jxl_lowlevel.rs`
  (canonical renamed/refactored it to `jxl_casadecoder` in the BSD-clean pass).
- **Holo wins are already merged into app branches** (e.g. `20807a4` fuse blur+apply +
  16-bit LUT cache; `2cc0d53` jxl_lowlevel borrowed surface) — both lineages received
  optimization work THIS WEEK. That parallel spend is what S1 ends.

## Working-tree rules (non-negotiable)

- Create a **fresh worktree** of the app repo for all G1 work:
  `git -C C:\Foo\JXL_Tauri_with_WASM worktree add C:\Foo\jtw-s1-g1 -b s1/g1-canonical-crate-trial`
  (branch from the app repo's freshest head — check `feat/save-name-from-source` vs
  `handoff/phase0-slice-20260706` vs origin/main; if the handoff/phase0 branch is
  mid-flight, branch from the user's branch and note the divergence in the report).
- Canonical-repo changes (compat shims, see Phase 1) go in a **worktree of
  raw-converter-wasm** on branch `s1/g1-compat-shims` — never edit its primary checkout.
- Never run tree-rewriting git commands in any existing checkout. The holo worktrees
  are read-only reference material.

## Phase 0 — Inventory (read-only, no edits)

1. **API surface list.** Enumerate every `raw_pipeline::` use in the app's `src-tauri/src`
   (~105 refs): module + item + call-site file. Output a table.
2. **API diff.** For each used item, locate the canonical-crate equivalent:
   same / renamed (e.g. `jxl_lowlevel` → `jxl_casadecoder`, note canonical's
   `pub use jxl_casadecoder as jxl_decode` back-compat alias) / signature-drifted /
   missing. Output: shim plan (Phase 1 input).
3. **Feature map.** App requests features `["simd", "jxl-lowlevel", …]`; canonical
   exposes different features (`parallel`, `jxl-codec`, …). Decide the minimal
   canonical feature set the app's usage actually needs. **Critical:** if the app's
   raw-pipeline usage does NOT need canonical's `jxl-codec` feature (app does its own
   JXL via jpegxl-rs today), build canonical with `default-features = false` + only
   what's needed → **no libjxl build required** → G1 much simpler. Only if `jxl-codec`
   is unavoidable, follow the static-libjxl recipe (junction third_party submodules,
   STATIC not DLL, vcvars + clang-cl + ninja; see memory notes / `docs/` build notes;
   `LIBJXL_SRC_DIR` per CLAUDE.md — ship against `external/libjxl-012`).
4. **Holo-win inventory** (feeds the G2 section of the report, no porting now):
   `git log` the app repo's raw-pipeline paths for perf commits; classify each vs
   canonical: already-equivalent (e.g. borrowed progressive surface ≈ canonical
   `decode_progressive_frames_borrowed`) / missing in canonical (e.g. fused
   blur+apply — canonical still defers texture+clarity fusion) / overlapping-different
   (e.g. decompress table-free-Huffman vs canonical trunc-fold — stackability unknown).

## Phase 1 — Integration branch (minimum diff)

1. In the app worktree, change `src-tauri/Cargo.toml`:
   `raw-pipeline = { path = "C:/Foo/raw-converter-wasm/crates/raw-pipeline", default-features = false, features = [<from Phase 0.3>] }`
   (absolute path dep is fine for G1; packaging = G2 decision). Remove `raw-pipeline`
   from the app workspace `members` or leave the vendored dir in place unused —
   **do not delete it; Phase 2/3 A/B needs it buildable** (easiest: keep a second
   binary/feature `vendored-pipeline` toggling the old path dep, or build the A side
   from the untouched parent branch).
2. **Shim policy:** prefer thin, additive `pub use` aliases / wrapper fns **in the
   canonical crate** (branch `s1/g1-compat-shims`) over rewriting 105 app call sites.
   Shims must be behavior-neutral (delegation only). Canonical crate's own suite must
   stay green: `cargo test -p raw-pipeline` native + `wasm32-unknown-unknown` check
   (`.\build-msvc.ps1` wrapper for native builds).
3. Adapt the residual app call sites that shims can't cover (signature drift).
   Every call-site change gets a one-line justification in the report.
4. Build the app: `cargo check` / `cargo build --release` in the worktree
   (MSVC; from crate dir, not `-p` from root — known gotcha). Smoke: `cargo test`
   in src-tauri if tests exist; `cargo tauri dev` launch is a user-assisted check —
   flag it in the report rather than blocking on it.

## Phase 2 — Parity corpus (old vs new decode, no silent adoption)

1. Corpus: real files — ORF (e.g. `C:\995\2026-01-09 Birthday at Cederberg\P1100079.ORF`
   per the canonical repo's integration test), at least one DNG, one single-slice CR2,
   one **multi-slice** CR2 (5D-era, `CR2Slices=[2,1728,1888]` class). More if available.
2. For each file, run the SAME ingest entry with identical params through (A) vendored
   pipeline (parent branch build) and (B) canonical (integration branch). Prefer the
   app's own ingest path (`src-tauri/pipeline.rs` / `bench.rs` hooks) so the comparison
   covers what the app actually calls.
3. Compare: SHA of decoded pixel buffers + key metadata (dims, WB, orientation,
   black/white levels). Classify every diff:
   - **(i) identical** — done;
   - **(ii) intentional canonical fix** — cite the canonical commit / QUESTIONS item
     (expected: bounds hardening, black-level, WB validation, orientation fixes);
   - **(iii) unexplained** — investigate to root cause; if unresolved, it BLOCKS the
     G2 recommendation and says so in the report.
   No diff may be waved through without a class and a citation.

## Phase 3 — Timings (first-class deliverable)

Discipline (numbers feed a major decision — treat like a flipflop run):

- **Interleaved A/B** (alternate old/new per rep, rotate start side) to cancel thermal
  drift — this machine has a documented throttling history that has ruined absolute
  timings before. Cool machine, no concurrent builds.
- N ≥ 5 reps per (file × stage); report **medians + min/max spread**; note warm/cold.
- Use the app's existing `bench.rs` harness where it fits; extend minimally otherwise.

Measure, per corpus file:

1. **Per-stage:** decompress/ljpeg decode; demosaic; tone/process; (encode-variants if
   the app path reaches it with the same encoder on both sides — it won't for JXL
   encode since the app encodes via jpegxl-rs on both sides in G1; measure it anyway
   as "unchanged control").
2. **End-to-end ingest** per file (the number the user will actually read).
3. Peak memory per run if cheaply available (working-set probe) — canonical crate's
   parallel paths may trade memory for speed; surface it.

Deliverable: one table, old vs new, per stage per file, with spread. Plus one headline
end-to-end row per format.

## Phase 4 — Report → STOP

Write `docs/S1-G1-report.md` in the canonical repo:

1. Timing tables (Phase 3) + one-paragraph headline (e.g. "end-to-end ORF ingest
   old→new: X ms → Y ms, −Z%").
2. Parity adjudication list (Phase 2) with classes and citations; count of (iii)
   unexplained (target: zero).
3. Shim inventory: every alias/wrapper added to canonical, every app call-site edit.
4. Feature/build notes: final feature set, whether libjxl build was needed, workspace
   changes.
5. Holo-win inventory (Phase 0.4) as the G2 porting worklist with per-item
   already-have / missing / overlapping verdicts.
6. G2 recommendation + effort estimate (packaging: path dep vs git dep + tag pinning;
   vendored-copy deletion; GPL removal since src-tauri's direct jpegxl-rs usage must
   move to canonical's encoder; freeze-rule enactment).

**Then stop.** G2 is a separate, user-approved handoff.

## Gates summary

- App builds + basic runtime smoke on the integration branch.
- Canonical crate: additive shims only, behavior-neutral, full suite green (native +
  wasm32 check).
- Zero unexplained parity diffs, or each one root-caused and flagged as a G2 blocker.
- Timings interleaved, ≥5 reps, spread reported.
- Nothing deleted anywhere; both A and B sides remain buildable at handback.

## Do NOT

- Do not delete or edit the vendored raw-pipeline (A/B needs it).
- Do not touch `C:\Foo\JXL_Tauri_with_WASM` (user's checkout) or
  `C:\Foo\raw-converter-tauri` (active parallel workstream) or the holo worktrees.
- Do not adopt behavior differences silently (every diff classified + cited).
- Do not port holo wins in G1 (inventory only).
- Do not remove jpegxl-rs/jpegxl-sys from src-tauri (G2).
- Do not start G2 in any form.
