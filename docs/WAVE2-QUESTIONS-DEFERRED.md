# Wave-2 — Deferred questions (user judgment calls)

Autonomous overnight runs park user-only decisions here with a recommended
default and proceed with the safest option. David can revert/redecide in the
morning.

## S2 — One browser delivery engine (2026-07-07 overnight, worktree rcw-s2)

Most of the S2 SAFE-SUBSET was **already landed on `main`** before this branch
was cut (the QUESTIONS §002/§003 evidence is stale). Audit + the small
remaining fixes are in `docs/HANDOFF-S2-browser-delivery-2026-07-06.md`. The
items below are the genuine judgment calls left open.

### S2-Q1 — WebGL 16-bit path: fix-vs-drop is now MOOT, but liveness is browser-UNVERIFIED
- **State found:** the "two dead GL pipelines" of QUESTIONS §003.A/C1 are already
  resolved. `webgl-pipeline.js` loads (its `buildColorMatrix`/`clampAdjustments`
  imports now resolve — filter-engine restored them as a 20-element 4×5 matrix
  matching `matrixUniforms`). `pyramid-lightbox.js` has a single `redraw()` and
  delegates 16-bit rendering to `renderRgba16AdjustedToCanvas` via
  `reapplyToOffscreen` (L467-484), with a CPU fallback. So GL is consolidated
  onto ONE engine of record — there is nothing to rip out.
- **Open call:** confirm in a real browser that the 16-bit GL display actually
  renders correctly (open a 16-bit pyramid level, drag sliders). Could not run
  headless GL / flipflopdom in this worktree.
- **Recommended default:** keep the consolidated GL path (no regression risk —
  it is the only 16-bit path and is wired). Do NOT drop GL. Revisit only if a
  browser test shows it broken.

### S2-Q2 — Tone-math divergence across the 16-bit/GL seam (QUESTIONS §003.C3)
- **State:** `filter-engine.js` `applyToneMapInPlace` (8-bit preview) uses a
  luma-masked lift/compress with thresholds 128/192; `webgl-pipeline.js` shaders
  use band-limited `max(0, 0.35-luma)` / `max(0, luma-0.65)`. Same sliders can
  render subtly differently across 8-bit preview vs 16-bit GL.
- **Open call:** which tone formula is canonical? Unifying changes user-visible
  rendering and needs same-slider visual parity across 8-bit / JS-float / GL in a
  real browser — not safely doable unattended.
- **Recommended default:** leave as-is tonight (both paths are live and internally
  consistent). Single-source the tone op in `filter-engine.js` and have the GL
  shaders reference it in a dedicated, browser-verified change.

### S2-Q3 — Route lightbox `loadLevel` through the pooled tiled path (QUESTIONS §003.C2 / §006)
- **State:** the tiled-decode worker now speaks the pool's v1 protocol (rewrite
  already landed; contract test added — see handoff). But `pyramid-lightbox.js`
  `loadLevel` still full-decodes every level and never inspects `entry.tiled`; the
  grid path (`pyramid-decode.js decodePyramidLevel`) is the one that uses
  `decodeTiledViewportPooled`.
- **Open call:** wiring `loadLevel` to region-decode tiled levels changes the
  offscreen/crossfade model (whole-level → viewport region) and needs a real
  browser + real WASM tiled decode to verify. Also unclear whether tiled levels
  ever actually reach the lightbox.
- **Recommended default:** leave the lightbox on full-decode for now (the only
  proven-working path); do the region-routing as a measured, browser-verified
  change on top of the now-correct worker protocol.

### S2-Q4 — main.js CardState refactor (WeakMap + `_lightbox` discriminated union)
- **State:** the ~30-field `_`-prefixed card expando state-bag and the untagged
  `card._lightbox` union remain. This is the large ADR-level refactor the task
  explicitly deferred; the cheap wins (WorkerPool `cancelTask` on card-delete,
  peepCache LRU, closeLightbox live-flag reset) are done.
- **Open call / recommended default:** stage it as: (1) introduce
  `WeakMap<HTMLElement, CardState>` (auto-GC on element removal, also closes the
  index-map leak class), (2) migrate fields behind accessors in batches, (3)
  verify each batch in-browser across gallery + lightbox + Tauri paths. Do NOT do
  it in one shot without a real browser. Staged plan is in the handoff.

### S2-Q5 — Stale `dist/worker-protocol.js` (compiled artifact lags source)
- **State:** `packages/jxl-pyramid/src/worker-protocol.ts` defines
  `validateWorkerRequest`, but the checked-in `dist/worker-protocol.js` is stale
  (`export {}` only). Nothing in the app imports the runtime validator (the pool
  uses type-only imports), so it is harmless today; the new contract test imports
  the `.ts` directly via bun.
- **Open call / recommended default:** rebuild `dist` (`tsc` in
  `packages/jxl-pyramid`) so the compiled artifact matches source, or wire
  `validateWorkerRequest` into the pool's `postMessage` in dev. Left untouched
  tonight to avoid a package-wide `tsc` rebuild I could not fully verify.
