# HANDOFF — K6 Cross-Language Contracts (2026-07-07)

**Worktree:** `C:\Foo\raw-converter-wasm\Foorcw-k6-contracts`
**Branch:** `feat/k6-cross-lang-contracts-jul07`
**Scope:** Two tasks. K6#4 (FableDeltaSessionWasm) is done on a sister branch — skip it.

## Working-tree rules

- Work only in `C:\Foo\raw-converter-wasm\Foorcw-k6-contracts`. Never touch the primary checkout.
- No WASM rebuild unless the Rust changes require it (K6#1 likely does).

---

## Task A — K6#1: LookParams named-field JS interface

**Problem:** `process_orf_with_flags`, `apply_look`, `LookRenderer` etc. take 13–17 positional
`f32` arguments. Positional index hazard — a transposed arg silently produces wrong pixels.

**Solution (already spec'd in ADR `docs/HANDOFF-pipeline-restructure-2026-07-06.md` K6#1):**

1. In `src/lib.rs` (or a new `src/look_params.rs`), add a Rust struct:
   ```rust
   #[wasm_bindgen]
   pub struct LookParams { /* existing fields */ }
   ```
   Add a `from_js(val: &JsValue) -> Result<LookParams, JsError>` factory that walks
   `js_sys::Object::keys(&obj)`, assigns known fields, defaults unknowns, rejects
   unknown keys with `JsError`. Zero serde — hand-parse only.

2. Add a new `#[wasm_bindgen]` entry point that accepts `LookParams` instead of 17 floats.
   Keep the old positional exports as thin deprecated wrappers (don't break existing callers
   yet, just add the new path).

3. Run `wasm-pack build --target web --out-dir pkg --release` to regenerate bindings.
   If build fails on WASM, check `CLAUDE.md §Build Notes` — libjxl must be built via
   `build-msvc.ps1`.

4. In `web/worker.js` and/or `web/main.js`, find calls to the old positional API and
   migrate at least one call site to the named-field form (as proof-of-concept). Leave
   the rest with a `// TODO: migrate to LookParams` comment.

5. Write a parity test: construct LookParams via positional old path and via named-field
   new path, verify outputs are identical (same pixel buffer or same WASM call result).

**Key constraint:** Do NOT add `serde` to `Cargo.toml` for the WASM crate. Binary size matters.

---

## Task B — K6#3: CASV constants single source of truth

**Problem:** CASV format constants (tile size, frame header magic, tier IDs, etc.) are
defined in Rust (`crates/raw-pipeline/src/` or `src/lib.rs`) and separately hardcoded
in JS (`packages/casv-web/src/`). If they drift, silent corruption.

**Solution:**
1. Identify the canonical CASV constants in Rust. Look for:
   - `const CASV_MAGIC`, tile dimensions, tier IDs, version bytes.
   - In `crates/raw-pipeline/src/casa_video/` or `src/lib.rs`.

2. Add a Rust build script (`build.rs` in the relevant crate) or a checked-in generator
   (`scripts/gen-casv-format.mjs`) that emits `packages/casv-web/src/casv-format.json`:
   ```json
   {
     "TILE_W": 256,
     "TILE_H": 256,
     "MAGIC": [0x43, 0x41, 0x53, 0x56],
     "VERSION": 1
   }
   ```

3. In `packages/casv-web/src/index.ts`, import from `./casv-format.json` instead of
   hardcoding the values.

4. Write a parity test that reads the JSON and asserts each constant matches the Rust
   compiled constant (via `wasm-bindgen` exported const or a test utility).
   Simplest: a Node test that imports the JSON and compares to known-good values from
   a checked-in reference — fails when either side drifts.

---

## Success criteria

- A → New `from_js` entry point exists, at least one JS call site migrated, parity test green.
- B → `casv-format.json` generated/committed, `casv-web` imports from it, parity test green.
- `bun test` passes in affected packages.
- Commit message: `feat(k6): LookParams named-field JS interface + CASV constants SSoT`

## Do NOT

- Do not add serde to the WASM crate.
- Do not remove the old positional exports (just add new path, keep old as deprecated).
- Do not rebuild libjxl from source unless needed — check if existing `web/pkg` is sufficient.
