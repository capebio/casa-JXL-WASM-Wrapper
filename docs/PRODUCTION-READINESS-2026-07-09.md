# Production Readiness & Hand-Over — 2026-07-09

CasaWASM JXL & RAW converter. This is the single source of truth for the state of
the system at hand-over: what is production, what is gated, how to build/test, and
the exact open decisions.

---

## 1. Production branch

**`main` @ `3b6615a7`** is the production branch and is **verified green** against
the authoritative CI gate (`.github/workflows/verify.yml`):

| Gate | Command | Result |
|------|---------|--------|
| Rust parity/fuzz/oracles (libjxl-free) | `cargo test --no-default-features --features parallel,image-formats --lib --test parity_corpus --test fuzz_smoke --test parity_oracles --test image_formats_roundtrip -- --test-threads=1` | **312 pass, 12 ignored, 0 fail** |
| FFI-ABI contract (K6.5) | `bun test packages/jxl-wasm/test/ffi-abi-contract.test.ts` | **2 pass, 0 fail** |
| Full raw-pipeline suite (superset) | `cargo test --release` (in `crates/raw-pipeline`) | **480 pass, 21 ignored, 0 fail** |

Byte-exact RAW→RGBA parity holds (ORF `0x8806822277eac608`, DNG anchors in
`docs/golden-corpus.json`). The `verify.yml` gate is deliberately **libjxl-free**
(no emscripten toolchain needed) — that is the machine-checkable production bar.

## 2. What is on `main` (production)

`main` contains the full optimisation campaign (landed via integration + cherry-pick)
plus this session's fixes:

- RAW pipeline: ORF/CR2/DNG decode, `process_region` (ROI), `decode_jpeg` (JPEG input),
  pyramid ladder (`encodeRgba8Pyramid` + pure-JS `downscaleRgba8`), `--tiling` policy.
- `web/pkg` rebuilt from the current engine (`fb8a7d2d`) — ships the `decode_jpeg`
  export + build-manifest; `parallel-wasm` (no c-perceptual — x86-AVX2 native-only).
- **CR2 streaming CFA-phase fix** (`3b6615a7`): `cr2_row_source` now refines the phase
  like `decode_impl` (fixes `cr2_multi_slice_full_rgb_sha_parity`; multi-slice bodies
  no longer magenta/green-swap on the tiled ingest path).

**`main` is 47 commits ahead of `perf/casv` and only 8 behind.** Of those 8, six are
already on `main` via cherry-pick; the only two not on `main` are the LibRaw feature
(§4). So `main` is the fuller branch — **no large `perf/casv → main` merge is required
for production.**

## 3. Build & toolchain

**WASM `web/pkg`** (RAW converter, the browser artifact — separate from the emscripten
libjxl bridge):

```powershell
.\build-parallel-wasm.ps1 -Features parallel-wasm    # NOT c-perceptual on wasm
```

Gotchas verified this session (see also the global CLAUDE.md toolchain notes):
- Toolchain `nightly-2026-06-01` (+ `rust-src`, `wasm32-unknown-unknown`). GNU host is
  fine for wasm32 (uses rust-lld, not dlltool).
- The script's `--locked` **fails** here: `-Z build-std` friction + the committed
  `Cargo.lock` is missing transitive deps (itoa/serde_json). Build with **`--offline`**
  instead — a minimal update that keeps `wasm-bindgen 0.2.121` (the cached bindgen.exe).
  Do **not** run `generate-lockfile` (force-bumps everything to 0.2.125 → cache miss).
- `c-perceptual` is an x86-AVX2 native-only FFI (`perceptual_apply_full`,
  `pipeline.rs`); wasm uses the portable Rust tone path. Never pass it to a wasm build.

**JS / workspaces:** `bun run build` / `bun run test` / `bun run typecheck` (dispatch
per-package via `tools/run-workspaces.mjs`). `bun run build` for `jxl-wasm` is a **stub**
(the emscripten libjxl step needs Docker); the shipped `dist/` is committed.

## 4. GATED: LibRaw browser RAW ingest (needs colour-authority sign-off)

Non-native RAW support (ARW/NEF/RW2/CR3/…) via vendored LibRaw-WASM + hand decoders.
**Deliberately not on `main`** — pending David's colour gate.

| Piece | Location |
|-------|----------|
| Rust engine `process_raw_mosaic_with_flags` + JS decoders + vendored `libraw-wasm` | `origin/perf/casv-video-simd-v2-jul05 @ 36ee48aa` |
| LibRaw-enabled `web/pkg` (build artifact) | `origin/feat/libraw-webpkg-jul09 @ ad827d5a` |
| Web extension filters (Codex#1) | `perf/casv @ 654d0ce9` (**held** — routes ARW/NEF/RW2 to raw before the decoder+web/pkg are live; violates the `web/format-detect.test.js` safety contract until then) |

Verified: native + wasm32 compile; 13 Rust + 37 JS tests pass; the wasm export binding
generates. **NOT verified:** byte-exact ORF/DNG + LibRaw **browser** colour — the
`golden-check.mjs` gate is host-blocked here (`mprotect failed: 487` under bun; node
`fetch(file://)` unimplemented). Only raw-pipeline `parity_corpus` (the lower decode
layer) is native-gateable, not the root look-pipeline output.

**To land LibRaw (the sequence):**
1. Colour-gate `feat/libraw-webpkg-jul09`'s `web/pkg` with the headless-Chromium
   `colour-verify.mjs` (see `docs/COLOUR-VERIFICATION-2026-07-08.md`) — colour-authority sign-off.
2. Ship that `web/pkg` → `main`; merge the engine `36ee48aa` → `main`.
3. Merge the Codex#1 filter `654d0ce9` → `main` **and** update the 3 `format-detect`
   tests in the same commit (they encode the "no decoder → unsupported" contract).

## 5. Known issues / caveats (not production blockers)

- **Full JS test suite ≠ production gate.** A broad `bun test packages/**` shows ~28
  failures, but these are **dev/env artifacts, not regressions**: (a) 13 × bun's
  "`describe()` inside `test()`" limitation (those suites are written for node --test /
  vitest — run via `bun run test`, not `bun test <dir>`); (b) missing vendored
  `external/libjxl-012` source; (c) missing dev web files; (d) `pyramid-bridge.test.ts`
  asserts the **archived** WASM downscale approach (`downscaleRgba16`/`sidecars_v2`) —
  superseded by the deliberate pure-JS `downscaleRgba8` (measured 2× faster); pre-existing
  red, safe to update-or-retire.
- **Threaded-wasm host gate:** golden-check / any bun/node harness that instantiates the
  shared-memory wasm hits `mprotect 487` (bun) or `fetch(file://)` (node) on this box.
  Browser colour verification uses **headless Chromium** for exactly this reason.
- Battery/thermal skews JS benchmark numbers (prebuilt `web/pkg` — Rust edits need a rebuild).

## 6. Cleanup done this session

- Pruned 6 merged local branches; ~8 legitimate branches remain (all checked-out or real WIP).
- Removed cruft: `libraw-engine.patch`, the empty `rcw-hw-calibration` leftover.
- Worktrees down to **3**: `raw-converter-wasm` (perf/casv, primary), `rcw-main-integ`
  (main), `rcw-orf-crush` (perf/orf-decode-crush + the scheduled bench).
- Left intentionally: `rcw-noise-sep-A/B` (22M bazel lib checkouts, unclear provenance),
  `rcw-worktree-backups-*`, and `C:\Foo\*.log` (a **different** project's — botany — logs).

## 7. Open decisions for the owner

1. **LibRaw colour gate + land** (§4) — colour-authority; the sequence is spelled out.
2. **Primary working tree** (`raw-converter-wasm`, on perf/casv) has **~145 uncommitted
   files** — 107 are rebuilt `dist/` artifacts, the rest are debug dumps
   (`err_modrgb*.txt`, `*-dump.json`), benchmark WIP, and design docs. Decide: commit the
   valuable bits, or `git clean`/checkout the build-noise. Not touched this session
   (preserve-uncommitted-work rule).
3. **`perf/casv` retirement:** since `main` supersets it (bar gated LibRaw), `perf/casv`
   can be retired once LibRaw lands. No merge needed otherwise.
