# Wave-2 — Deferred questions / user-only calls

Items an overnight autonomous run cannot decide or safely land. Each is a
decision or an environment/tooling dependency, not a blocker for the work that
did land. Revert any landed commit freely if a decision goes the other way.

## S4 — verification & hardening (2026-07-07, overnight)

### D1. Loose root bench-script relocation — NOT done (needs a dependency audit)
Strategic map §S4.5 asks to move loose root `*.mjs`/`*.js` benches into `bench/`
or `tools/`. Not landed: the ~33 root scripts are **not** all inert scratch —
`flipflop.mjs`, `flipflop-corpus.mjs`, `flipflop-journal.mjs`, `flipflopMem.mjs`,
`flipflopdom.mjs`, `flipflop-metrics.mjs`, `flipflop-byte-cutoff.mjs`,
`flipflop.test.mjs` are the **flipflop skill vehicle** (the skill invokes them by
path); the `*Test.mjs` harnesses carry relative-path reads (`./web/pkg`,
`./packages/...`) and cross-`import` each other. A blind `git mv` breaks the
skill and every relative path. **Decision needed:** (a) which scripts are keep-at-
root skill infrastructure vs relocatable, and (b) approval to update the
references (skill config + docs + inter-script imports) in the same PR. Mechanical
once that list exists; unsafe to guess overnight.

### D2. WASM simd128 parity oracle — deferred (needs a node+wasm harness)
Native AVX2/AVX512-vs-scalar oracles exist for `scale_err` and `pixels_to_xyb`
(see `tests/parity_oracles.rs` index), and the whole-pipeline SIMD-vs-scalar
identity is proven by the golden ledger (ORF/DNG digests reproduce byte-for-byte
under `-C target-cpu=native` and scalar builds). The **wasm** backend
(`perceptual/simd/wasm.rs`) has no scalar-parity oracle because wasm SIMD can't
run under native `cargo test`. Closing it needs a node harness that loads the
wasm export and pins its `scale_err`/`pixels_to_xyb` output against the scalar
reference. Not "quick"; deferred. **No decision needed** — just scheduling.

### D3. cargo-fuzz real runs — tooling gap on this box
`cargo fuzz build/run` cannot execute here: `cargo-fuzz` is not installed, and the
only nightly toolchain is `nightly-*-windows-gnu` (GNU is broken — no `dlltool`);
there is no nightly-MSVC with a libFuzzer/ASAN runtime. The targets + seed corpora
are scaffolded and the harness logic is verified via `tests/fuzz_smoke.rs`
(mutation sweep, no panic) and `cargo check` (all 9 targets compile). To run real
fuzzing: install cargo-fuzz + a nightly-MSVC sanitizer toolchain (or run on Linux
CI), then `cargo +nightly fuzz run <target> -- -max_total_time=...`. The four
CASV/JXTC targets additionally need `--features codec` (libjxl:
`LIBJXL_SOURCE_DIR` + `LIBCLANG_PATH`). **Decision:** where do long fuzz runs live
— Linux CI nightly, or a local nightly-MSVC install?

### D4. CI workflow — added but not runnable/verifiable locally
The repo had **no** `.github/workflows/`. This pass adds `verify.yml` wiring the
S4 verification surface (parser tests + golden ledger + fuzz-smoke + parity
oracles + `cargo fuzz build` + the bun FFI-ABI contract test). Every step's
command is verified locally, but GitHub Actions itself cannot be executed here, so
the YAML is unverified end-to-end (runner image, toolchain install, action
versions). **Decision:** confirm the runner (ubuntu vs windows), whether to build
libjxl in CI for the codec/ffi-abi legs, and whether this should gate merges.

### D5. Tracked reference binaries `external/libjxlJun26/bin/*.exe` (27 exes) — left as-is
`.gitignore` ignores `*.exe`, but these 27 were committed before that rule and
are **not** removed here — they look like intentional prebuilt libjxl reference
tools (cjxl/djxl/benchmark_xl/…), not scratch, and the global rule is "don't
delete tracked meaningful files." **Decision:** keep tracked, or untrack (they're
~large) and document a rebuild path?
