# Dependabot Triage — 2026-07-13

10 open alerts (`gh api /repos/capebio/casa-JXL-WASM-Wrapper/dependabot/alerts?state=open`).
Classified by whether the vulnerable code actually **ships/runs in the product** vs. build/dev/tooling.

## Priority 1 — Runtime, product code (real exposure)

| Sev | Package | Where | Fixed | CVE |
|-----|---------|-------|-------|-----|
| **HIGH** | jxl-grid | crates/raw-pipeline (via jxl-oxide) | 0.6.2 | CVE-2026-52834 |
| med | jxl-modular | crates/raw-pipeline (via jxl-oxide) | 0.11.3 | — |
| med | jxl-oxide | crates/raw-pipeline (**direct**, `"0.11"`) | 0.12.6 | — |

**All three are one fix: bump `jxl-oxide = "0.11"` → `"0.12"`** in `crates/raw-pipeline/Cargo.toml`.
The fixed `jxl-grid`/`jxl-modular` versions exist only inside jxl-oxide 0.12's dependency tree — a
transitive `cargo update -p jxl-grid --precise 0.6.2` is **REJECTED** against the locked jxl-oxide
0.11.4 (verified 2026-07-13). A `0.x` minor bump is semver-breaking, so this needs a real migration:

1. `jxl-oxide = "0.12"` in Cargo.toml.
2. Adapt to any API changes — jxl-oxide is used in the **CASA JXL path**: `src/jxl_casadecoder.rs`,
   `src/jxl_casaencoder.rs`, `src/lib.rs` (JXL decode/encode for CASA/CASV).
3. Gate: `cargo test` (raw-pipeline) + `--test parity_corpus` + the JXL/CASA decode goldens.

→ Recommend a dedicated **`chore/bump-jxl-oxide-0.12`** PR. This is the only alert with genuine
user-facing product exposure (HIGH). NOT a lockfile-only fix.

## Priority 2 — Runtime scope, but non-product tooling

| Sev | Package | Where | Fixed | Note |
|-----|---------|-------|-------|------|
| med | xml2js | benchmark/package-lock.json | 0.5.0 | benchmark tooling; never shipped |
| med | pytest | tools/raw-denoise/uv.lock | 9.0.3 | python **test** dep (uv marks it runtime); dev tool |

Bump opportunistically; no user-facing exposure. `pytest`: `uv lock --upgrade-package pytest` in
`tools/raw-denoise`. `xml2js`: refresh `benchmark/` lockfile.

## Priority 3 — Development scope (build-time only, not shipped)

| Sev | Package | Fixed | Note |
|-----|---------|-------|------|
| **HIGH** | vite | 8.0.16 | bundler; build-env only, not in the shipped bundle |
| med | tar | 7.5.16 | transitive (build) |
| med + low | undici | 6.27.0 | transitive fetch (3 CVEs) |

All in `package-lock.json` (npm scope=development). **Note:** the repo's real package manager is
**bun** (`bun.lock`); `package-lock.json` is vestigial. Prefer bumping via bun and regenerating
`bun.lock` (which is drifted anyway — see the bun.lock re-pin follow-up). `vite` is HIGH but
development-scope, so the real risk is confined to the build environment.

## Recommended order

1. **`jxl-oxide` 0.12 migration** — only real product exposure (HIGH `jxl-grid`). Dedicated, tested PR.
2. **bun.lock re-pin** bundled with the npm dev-dep bumps (vite / tar / undici).
3. **xml2js + pytest** (tooling) — opportunistic.

## Actions taken this session

- Verified the transitive Rust bump is blocked (needs the jxl-oxide 0.12 migration above) — did **not**
  apply a risky breaking upgrade blind.
- No lockfiles changed by this triage (Cargo.lock/bun.lock untouched).
