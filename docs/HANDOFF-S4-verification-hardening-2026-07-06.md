# HANDOFF — S4: Verification & Hardening Architecture

**Date:** 2026-07-07 (overnight autonomous run) · **Branch:** `s4/wave2-overnight`
· **Worktree:** `C:\Foo\rcw-s4` · **Base:** `perf/casv-video-simd-v2-jul05`
· **Status:** landed + verified; tree clean; NOT pushed.

## Goal
Build the machine-checkable safety net S4 calls for (STRATEGIC-MAP §S4): fuzz the
untrusted-byte parsers, pin decoded-pixel digests against silent drift, formalize
the parity oracles, wire the FFI-ABI smoke into CI, and clean the repo — so that
S5 (output-visible colour work) and S1 (fork reconciliation) land on a net, not
bare rock. Everything additive/mechanical; land only what's verified; defer
decisions rather than block.

## Landed (7 commits)

| # | Commit | What |
|---|--------|------|
| 1 | `ba3dd626` | **Repo hygiene** — untrack 179 regenerable scratch files + close gitignore gaps |
| 2 | `847b649b` | **Golden SHA ledger** — pin decoded-pixel digests (RAW + checked-in fixtures) |
| 3 | `b2c24cfa` | **cargo-fuzz targets** per parser + stable `fuzz_smoke` verification |
| 4 | `7a68e445` | **Parity-oracle family** — single named home + index + deferred log |
| 5 | `b448b040` | **CI** — `verify.yml` wiring ledger + fuzz + oracles + K6.5 FFI-ABI |

(Commit 1 is one hygiene commit; 2–5 are the four verification legs.)

### 1. Repo hygiene (`ba3dd626`)
Removed **179 tracked files**, all regenerable build output or tool scratch that
predates an ignore rule (fully reversible via git):
- `undefined/` (86) — EpicCodeReview output written to a literal `undefined/` path
  when its out-dir var was unset (tool bug); real review artifacts live elsewhere.
- `target-codex/` (77) + `target-codex-<hash>/` (11) + `target-codexb8Jltm/` (1) —
  alternate Cargo target dirs from codex runs.
- `node-cdp-oL9ZjF/` (1) — CDP browser profile (already matches `node-cdp-*/`).
- `debug.log`, `build errors.run.log` (2) — stale logs (match `*.log`).
- `.flipflop-ds0-out.txt` (1) — flipflop journal output at repo root.

Added `.gitignore`: `target-codex*/`, `/undefined/`, `.flipflop-*-out.txt`.
**Not moved:** the ~33 loose root `*.mjs` benches — several are load-bearing
flipflop-skill infrastructure and the harnesses carry relative-path/cross-import
deps; relocation needs a dependency audit (DEFERRED — §S4 D1).
**Left as-is:** 27 tracked `external/libjxlJun26/bin/*.exe` — look like intentional
reference binaries, not scratch (DEFERRED — §S4 D5).

### 2. Golden SHA ledger (`847b649b`, extends `tests/parity_corpus.rs`)
Two tiers, hard `assert_eq!` on decoded-pixel digests:
- **RAW tier** (skips when the dev asset is absent): `orf_rgba8_sanity` pins
  `P1110226.ORF → 0x8806822277eac608`; `dng_rgb8_sanity` pins
  `PXL…dng → 0x3c3fb14139efec5c` (reused verbatim from `docs/S1-timings-report.md`).
- **Fixture tier** (`golden_fixture_ledger`, always-present → CI never all-skips):
  pins the mandelbrot `_u8.tiff` / `_u16.tiff` / `_f32.exr` decoded-pixel digests
  through the `image_formats` ingest + linear→sRGB8 display path.

Determinism proven: **all pins reproduce byte-for-byte across `-C target-cpu=native`
(AVX2) and scalar release builds, and in debug** → the digests are SIMD-vs-scalar
byte-exact AND opt-level/build-flag invariant. Digest = std `DefaultHasher`
(SipHash-1-3, fixed keys, stable within a Rust release; pinned on rustc 1.95.0).

### 3. cargo-fuzz targets (`b2c24cfa`, `crates/raw-pipeline/fuzz/`)
One libFuzzer target per untrusted-byte parser (9 total):
- **pure-Rust (libjxl-free):** `tiff_parse`, `cr2_decode`, `dng_decode`,
  `ljpeg_decode` (probe + bounded decode), `decompress` (dims bounded from input).
- **codec-gated (`--features codec` → raw-pipeline/jxl-codec → libjxl):**
  `casv_header`, `casv_footer`, `casv_audio_box`, `jxtc_header`. These compile to
  a no-op stub without the feature, so plain `cargo fuzz build` stays libjxl-free.

Seed corpora checked in under `fuzz/corpus/<target>/`: 16 KiB real ORF+DNG
prefixes, an 8 KiB CSAV header/footer(tail)/audio split, JXTC seeds from the
sink-ratebox/tile-v2 fixtures, a hand-built minimal SOF3 LJPEG stream, a synthetic
decompress seed. `fuzz/target` + `Cargo.lock` ignored; corpus tracked.

`cargo fuzz build/run` cannot run on this box (see recipe below), so
**`tests/fuzz_smoke.rs`** is the executable stand-in: it drives each target's exact
harness body over the seed corpus **plus deterministic mutations** (truncations,
bit-flips, byte-sets, xorshift PRNG) in the **debug** profile (overflow-panic
sensitive), asserting no parser panics.

### 4. Parity-oracle family (`7a68e445`, `tests/parity_oracles.rs`)
Single discoverable home + an INDEX table mapping every oracle to its canonical
inline location (band-vs-whole ×5, `scale_err`/`pixels_to_xyb` AVX2+AVX512-vs-scalar,
fable roundtrip, whole-pipeline SIMD-vs-scalar via the ledger). Adds two public-API
oracles that lacked an integration home: `oracle_fable_lossless_roundtrip`
(byte-exact across flat/gradient/noise/1×1/row) and
`oracle_demosaic_rggb_deterministic`. WASM simd128 gap documented + deferred (D2).

### 5. CI (`b448b040`, `.github/workflows/verify.yml`)
Repo had no CI. Three libjxl-free jobs: `rust-parsers` (the verified test command),
`fuzz-build` (`cargo +nightly fuzz build` + 20s capped smoke per pure target —
libFuzzer runs natively on Linux), `ffi-abi` (`bun test` the K6.5 contract). YAML
validated; unrun on Actions (D4).

## Fuzz-run recipe
This box has **no** working fuzz toolchain: `cargo-fuzz` isn't installed and the
only nightly is `nightly-*-windows-gnu` (GNU broken — no `dlltool`); no nightly-MSVC
sanitizer runtime. Real fuzzing runs on Linux CI or a nightly-MSVC install:

```bash
cargo install cargo-fuzz
cd crates/raw-pipeline

# pure-Rust parser targets (no libjxl):
cargo +nightly fuzz build
cargo +nightly fuzz run tiff_parse    -- -max_total_time=20     # smoke
cargo +nightly fuzz run ljpeg_decode  -- -max_total_time=86400  # 24h campaign

# CASV/JXTC targets (need libjxl):
#   set LIBJXL_SOURCE_DIR + LIBCLANG_PATH (see docs/S1-timings-report.md)
cargo +nightly fuzz build --features codec
cargo +nightly fuzz run casv_header --features codec -- -max_total_time=20
```
Local substitute (any stable toolchain): `cargo test --no-default-features
--features image-formats --test fuzz_smoke` (mutation sweep, no libFuzzer).

## Found-bugs
**None.** The `fuzz_smoke` mutation sweep (seed corpus + truncations + bit-flips +
byte-sets + PRNG, debug profile) found no panics in `tiff::parse`,
`cr2::decode_bytes`, `dng::decode_bytes`, `ljpeg`, or `decompress`. The existing
hand-patched overflow guards held on this corpus. This is a smoke bound, not a
24h campaign — the real fuzz run (recipe above) is where a genuine campaign lives.

## Verification (exactly what ran)
All from `C:\Foo\rcw-s4` (MSVC default toolchain, rustc 1.95.0):

| Command | Result |
|---------|--------|
| `cargo test --no-default-features --features parallel,image-formats --lib --test parity_corpus --test fuzz_smoke --test parity_oracles --test image_formats_roundtrip -- --test-threads=1` (in `crates/raw-pipeline`) | **224 passed, 0 failed, 12 ignored** (207 lib + 7 ledger + 5 fuzz-smoke + 2 oracles + 3 roundtrip) |
| parity_corpus @ release, `-C target-cpu=native`, ST | 7 passed; ORF `0x8806822277eac608`, DNG `0x3c3fb14139efec5c` (match pins) |
| parity_corpus @ release, **scalar** (no native) | identical digests → SIMD-vs-scalar byte-exact |
| `cargo check` in `crates/raw-pipeline/fuzz` | exit 0 — all 9 fuzz target sources compile |
| `bun test packages/jxl-wasm/test/ffi-abi-contract.test.ts` | 2 pass, 0 fail (K6.5) |
| `python yaml.safe_load .github/workflows/verify.yml` | YAML OK |
| `git status` | clean after every commit |

Not run: `cargo fuzz build` (toolchain gap — recipe above); full `--features codec`
build (libjxl, per task); GitHub Actions (can't execute locally). Codec fuzz
targets verified by inspection against confirmed `&[u8] -> Option<_>` signatures.

## Deferred (see `docs/WAVE2-QUESTIONS-DEFERRED.md` §S4)
D1 bench-script relocation (needs dependency audit) · D2 wasm simd128 parity oracle
(needs node+wasm harness) · D3 cargo-fuzz tooling / where long runs live · D4 CI
first green run + runner decision · D5 tracked libjxl reference exes keep/untrack.

## Remaining / next
- Run the CI workflow once on Actions; fix runner/action-version drift (D4).
- Launch the real 24h fuzz campaign per parser on Linux CI (D3); fix any find.
- Build the wasm bench harness to close the simd128 parity gap (D2).
- Extend the RAW ledger with CR2 single+multi-slice + EXR + a `.casv` fixture once
  small checked-in assets are chosen (strategic map §S4.2 mentions these).
- `--features codec` fuzz build in an env with libjxl to exercise CASV/JXTC for real.
