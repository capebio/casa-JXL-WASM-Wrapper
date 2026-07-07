# EpicCodeReview — web/ (RAW→JXL browser layer)

- **Run:** 20260622T113415Z
- **Target:** `web/` (117 source files, JavaScript)
- **Mode:** workalone (Sonnet)
- **Worktree:** `C:/Foo/WebWork` — branch `epiccodereview/webwork` (off `feat/multi-format-ingest`)
- **Sections:** 7 — root JS ×3 (sec 0/1/2), `lightbox/` (3), `pyramid-gallery/` (6); `pkg/` (4) + `pkg-fastjpeg/` (5) **skipped** (generated wasm-bindgen artifacts)

## Result

| Section | Commit | Fixes landed | ADR drafts | Deferred |
|---|---|---|---|---|
| Global (architecture + vision) | `f90b0e44` | 1 | 8 | 2 |
| 0 — web/ root (benchmark/crop/workers) | `956a4afb` | 27 | 8 | 3 |
| 1 — progressive-decode family | `ee7244f1` | 13 | 6 | 3 |
| 2 — main.js / worker.js / tauri / panels | `75dabb6e` | 12 | 12 | 29 (mostly architectural) |
| 3 — lightbox | `20232480` | 1 | 7 | 14 (WIP/broken cluster) |
| 6 — pyramid-gallery | `32a7ddb4` | 15 | 2 | 5 |
| **Total** | | **~69** | **43** | **~56** |

All fixes verified: `node --check` clean on every edited file; unit tests run where present (vitest / `bun test`); behavioral/cross-file/WASM-only changes deferred per the build-gated rule. No regressions introduced (pre-existing lightbox stale-test failures confirmed independent of these edits).

## Highest-signal findings

### Fixed
- **Inverted perceptual-cutoff plateau trigger** (`jxl-single-progressive.js`, HIGH) — the progressive decode "plateau" cutoff fired on *normal improving* frames (it OR'd in `detectMonotone`'s "no regression" instead of "stopped improving"). Now triggers on `|Δbutteraugli| < ε`. Likely caused premature progressive cutoffs.
- **Saturation applied twice** (`lightbox/filter-engine.js`, MEDIUM) — `adjustSaturation` re-added the brightness/contrast/preset offset through the saturation matrix, drifting bias as the slider moved. Now applied once (DEHAZE offset 0.04→0.02; NONE stays identity).
- **Deep-link token trust boundary** (`casabio.js`, MEDIUM/security) — `casabio-handoff` persisted an auth token from an untrusted URL with no scheme/origin validation. Now https-validated before any persist.
- **Cancellation correctness** (`pyramid-gallery/grid-controller.js`, `pyramid-decode.js`, HIGH) — IntersectionObserver cancelled in-flight paints for cells that never left the viewport; dedup shared the first caller's AbortSignal (one cell's abort killed a still-visible cell's shared decode); tiled decode never forwarded `signal`/`format`. All fixed (ref-counted cancellation, leave-only abort, option forwarding).
- **Resource/handle hygiene** — `frame-stats-worker` WASM `PerceptualComparer` leaked on reference change (free-before-replace); `decodePyramidRegion` leaked a decoder handle on error (try/finally dispose); `image-store` manifest cache unbounded (now LRU) + double-fetch (in-flight dedup).
- ~50 more: degenerate `buf ? buf : buf` IPC ternary, dead 1MB-buffer preset simulation (+ restored dropped 512KB tier), WEBP fourCC check, sidecar bounds invariant, file-picker accept matching, byte-cutoff snap/dedup ordering, etc.

### Deferred (need a human decision or out-of-loop verification)
- **Lightbox M3 WebGL-HDR + tiled-decode are half-built/broken** (sec 3, CRITICAL) — `webgl-pipeline.js` can't load (imports `buildColorMatrix`/`clampAdjustments` that don't exist); `tiled-decode-worker.js` speaks a protocol the `PyramidWorkerPool` doesn't recognize → pool watchdog times out → silent fallback to direct decode (tiled path is dead); the inline `renderGL` is shadowed dead code. Full diagnosis + the wiring work in `QUESTIONS.md` §003. These are feature-completion + a design decision (is WebGL-HDR meant to be live?), not safe in-loop edits.
- **Multi-format ingest not wired into the live worker** (sec 0/2, HIGH) — the new `format-detect.js` is imported only by the benchmark; `worker.js` still sniffs ORF/CR2/DNG only and routes everything else (EXR/TIFF/SDR/foreign RAW like `.arw`/`.nef`/`.rw2`) to the Olympus decoder. Wiring needs WASM multi-format support — the open work of the `feat/multi-format-ingest` branch.
- **`pyramid-gallery-grid.js` is dead/broken-as-loaded** — ReferenceError at module-eval (references ~14 never-imported globals); it's the old inline lightbox already extracted to `lightbox/pyramid-lightbox.js`. Recommend deletion (a human call — deletion is on the no-go list).
- **Architectural** (sec 2, ADR drafts): three forked lightbox/look pipelines, `WorkerPool` task-lifecycle with no cancel propagation, ~30-field untyped card state bag, untyped string-tag worker protocol, 16-arg positional `process_orf` FFI. See `QUESTIONS.md` + `.epiccodereview/20260622T113415Z/**/adr_draft/`.

## Artifacts
- ADR drafts: `.epiccodereview/20260622T113415Z/{global,sections/*}/adr_draft/*.md` (43 total) — perf items each carry the mandatory flipflop/flipflopdom measurement gate (≥5% + parity).
- Deferred items + ADR pointers: `QUESTIONS.md` (repo root, appended).
- Per-finding audit trail: `.epiccodereview/20260622T113415Z/` (findings → candidates → verified → plan → fix_log → progress per section).

## Teardown
Branch `epiccodereview/webwork` holds 6 commits. After merge/abandon:
```
git worktree remove C:/Foo/WebWork
```
Do not remove while commits are unmerged. Add `.epiccodereview/` to `.gitignore`.
