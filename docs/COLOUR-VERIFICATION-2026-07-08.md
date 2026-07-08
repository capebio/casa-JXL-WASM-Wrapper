# Colour Verification — 2026-07-08 (post Tauri⇄WASM reconciliation)

**Engine:** `perf/casv-video-simd-v2-jul05` @ `c365a42a` (tag `tauri-consume-2026-07-08`).
**Verdict:** ✅ **Engine is colour-correct across all tested formats; drift vs last-good is perceptually negligible.**
**Colour authority:** David (capebio@gmail.com). This document is evidence for the golden re-pin decision — goldens were **NOT** auto-adopted.

## What was tested
A **fresh threaded `web/pkg`** was rebuilt from the current engine (the shipped one was a stale 2026-07-03 build that no longer loads). Each corpus file was decoded at **neutral sliders** (all zero, camera WB) through the real WASM pipeline; SHA256 of the RGBA8 output was compared to the committed golden pin, and on any change a **butteraugli** delta was measured against the last-good build. Separately, `tools/colour-verify.mjs` decoded each file through the **real headless-Chromium lightbox** (crossOriginIsolated, threadpool=12) and checked channel order / magenta veil / white-balance sanity.

## butteraugli drift (threshold 0.05)
| File | Format | Dims | SHA vs committed pin | butteraugli(last-good, current) |
|---|---|---|---|---|
| P1110226-ORF | ORF | 5240×3912 | changed | **0.0007** |
| PXL-20260527-DNG | DNG | 3628×2732 | changed | **0.0078** |
| P2200407-ORF | ORF | 5240×3912 | **identical** | **0.0000** |

All ≤ 0.0078 — **~6× under the 0.05 threshold**. The two changed files reflect the **intentional** tone/WB fixes (HIGHLIGHT_KNEE, per-format white point, Olympus E-M5 WB); one file is pixel-identical. "last-good" = the 2026-07-05 threaded build (the 07-03 shipped build is unloadable and could not anchor the delta).

## colour-verify (absolute correctness, headless Chromium)
| File | Format | Dims | Channels | Magenta veil | WB | Verdict |
|---|---|---|---|---|---|---|
| P1110226.ORF (vs `P1110226 windows.jpg`) | ORF | 5240×3912 | aligned (R/G 0.746 vs ref 0.743, B/G 1.128 vs 1.157) | none | sane | **PASS** |
| PXL-20260527.DNG | DNG | 3628×2732 | ref-less | none | sane (warm) | **PASS** |
| P2200407.ORF | ORF | 5240×3912 | ref-less | none | sane (near-neutral) | **PASS** |
| _MG_1744.CR2 | CR2 | 5184×3456 | ref-less | none | sane (warm; green not deficient) | **PASS** |

CR2 passed with **no green-deficiency** despite the `color_matrix=None` fallback noted in CLAUDE.md.

## Recommendation (David decides)
The engine output is correct and the drift is imperceptible. **Recommended: adopt the new goldens** — `bun --smol scripts/golden-check.mjs --update` (regenerates `docs/golden-buffers/*.rgba` + repins `docs/golden-corpus.json`). This is a colour-authority action; it was deliberately **not** performed here.

## Follow-ups surfaced (not colour regressions)
- The tracked `web/pkg` was stale (07-03) and unloadable in bun **and** browser (wasm-bindgen memory-import skew) — a **fresh current-engine build now sits in the working tree; commit it** to refresh the shipped browser build.
- `tools/colour-verify.mjs` loads WASM from a **gitignored repo-root `pkg/`**, not `web/pkg` (footgun — tests a stale engine unless that dir is refreshed), and has two bugs: `writeHead(200)` before `readFileSync` (crashes on any 404 instead of 404), and no directory index (the wasm-bindgen-rayon worker bootstrap `GET /pkg/` 404s → thread pool silently fails). Both worked around during this run; the tracked file was left untouched.
- No CR2 in `docs/golden-corpus.json` and no same-scene reference for DNG/P2200407/CR2 (channel-swap check needs one). Consider adding a CR2 corpus entry + refs (colour-authority sign-off).

## Reproduce
```
# fresh threaded build (note: env-form build-std, not `-- -Z`)
$env:RUSTUP_TOOLCHAIN="nightly-2026-06-01-x86_64-pc-windows-gnu"
$env:RUSTFLAGS="-C target-feature=+simd128,+atomics,+bulk-memory,+mutable-globals -C link-arg=--shared-memory -C link-arg=--max-memory=2147483648 -C link-arg=--import-memory -C link-arg=--export=__heap_base -C link-arg=--export=__tls_base -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__wasm_init_tls"
$env:CARGO_UNSTABLE_BUILD_STD="std,panic_abort"
wasm-pack build --target web --out-dir web/pkg --release --features parallel-wasm

bun --smol scripts/golden-check.mjs      # SHA + butteraugli
node tools/colour-verify.mjs             # channel/veil/WB (see footgun above)
```
