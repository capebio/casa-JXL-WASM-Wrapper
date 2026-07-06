# Codec Paper Comparison Suite — Design Spec

**Date:** 2026-07-05
**Status:** Approved (brainstorming) → pending implementation plan
**Author:** David + Claude
**Builds on:** Part 1 codec-compare (PR #11, branch `feat/codec-compare-benchmark`)

## 1. Goal

Generate publication-quality figures comparing **our WASM JXL** (facade, libjxl-012 fork) against **original/reference libjxl** (`@jsquash/jxl`) and JPEG/WebP/AVIF/PNG (native `sharp` + WASM `@jsquash`), on a hybrid real-file corpus. Deliver rate-distortion curves, Pareto fronts, an ours-vs-original-JXL delta, and a BD-rate table — as static SVG suitable for a paper.

## 2. Constraints

- **Must NOT modify** `StandardMultifileTest.mjs` or the `standard-multifile` / `codec-compare` families.
- Reuse Part-1 infra verbatim: `benchmark/codec-adapters.mjs`, `butteraugli-search.mjs`, `codec-compare-jxl.mjs` (facade `computeButteraugli` standard-scale for quality; `PerceptualComparer` for SSIM), `codec-compare-serialize.mjs` patterns.
- Native (`sharp`, libvips MT+SIMD) vs WASM (`@jsquash`, ours) ms are NOT comparable across runtimes. Size + quality ARE. Time figures split by runtime; RD/size figures pool.
- New graph/data family `codec-paper` needs its own `deriveFamilyIdFromArtifactName` branch in `benchmark/benchmark-history-registry.mjs` (label/color overrides alone insufficient — resolver falls to timestamped stem otherwise; lesson from prior families).

## 3. Corpus (hybrid, ~32 images)

| Class | Source | How |
|---|---|---|
| `standard` | Kodak 24 (768×512 PNG) | `scripts/fetch-kodak.mjs` downloads `https://r0k.us/graphics/kodak/kodak/kodim{01..24}.png` to `docs/outputs/codec-paper/corpus/kodak/`. Idempotent (skip existing). Citable + reproducible. |
| `raw` | Our 8 standard files | Existing `loadTargetRgba` (`process_*_with_flags` → 1920 long-edge). Shows the RAW→JXL workflow. |

Each corpus entry: `{ id, class, rgba, width, height }`. If Kodak fetch fails (offline), log and continue with `raw` only (no silent corpus truncation).

## 4. Codecs (9)

Reuse Part-1 `ADAPTERS` + our `jxl` adapter, and ADD one:

| Codec key | Runtime | Lib | Role |
|---|---|---|---|
| `jxl` | WASM | facade (libjxl-012 fork) | ours |
| `jxl_orig` | WASM | `@jsquash/jxl` (upstream libjxl) | **headline comparator** |
| `jpeg_native` / `jpeg_wasm` | native / WASM | sharp / mozjpeg (4:4:4) | |
| `webp_native` / `webp_wasm` | native / WASM | sharp / libwebp (lossy 4:2:0 inherent) | |
| `avif_native` / `avif_wasm` | native / WASM | sharp / libaom | |
| `png_native` | native | sharp | lossless reference |

- **`jxl_orig` adapter:** same Node-WASM-init pattern as other @jsquash codecs (compile `codec/enc/jxl_enc.wasm` + `codec/dec/jxl_dec.wasm`, `init(module)`). Encode opts `{ quality, effort }`. Decode → RGBA.
- **Ours-vs-original fairness:** both run at **matched effort 3** (our shipping tier) so the delta isolates our fork's changes; both WASM → time comparison is fair.

## 5. Method — RD sweep (key difference from Part 1)

Part 1 matched a single butteraugli anchor. The paper needs **curves**, so sweep the quality knob:

1. **Sweep (size + quality):** for each (corpus image × codec), encode at a **quality ladder** (default 8 points spanning the codec's useful range, e.g. jpeg/webp/avif quality ∈ {30,45,55,65,75,85,92,98}; `jxl` and `jxl_orig` swept by their quality knob 0–100 — the facade and @jsquash/jxl both accept `quality`). At each point record `{quality, bpp, butteraugli, ssim}` — **single-shot encode/decode** (the RD curve is size-vs-quality; timing is not its axis). This keeps the sweep fast.
2. **Fixed-quality point (timing):** additionally, per image × codec, binary-search (reuse `searchQuality`) to butteraugli ≈ 1.5 (±0.15), then measure `enc_ms`/`dec_ms` as the **median of N=3 rounds** at that quality. This is the reliable timing used by the Pareto plot, size/time bars, and the ours-vs-original delta.
3. PNG is lossless: single point (no sweep), plotted as a reference marker only.

Quality instrument = facade `computeButteraugli` (standard p3 scale). SSIM = `PerceptualComparer`.

## 6. Figures (static SVG, hand-rolled per repo pattern)

All emitted to `docs/outputs/codec-paper/figures/*.svg` with axis labels, legend, gridlines, print-friendly palette.

1. **`rd-butteraugli.svg`** — x=bpp, y=butteraugli (log-y optional, lower=better), one line/codec, corpus-averaged (interpolated to common bpp grid). Headline.
2. **`rd-ssim.svg`** — x=bpp, y=SSIM (higher=better). Second distortion view.
3. **`ours-vs-orig-jxl.svg`** — grouped bars: size %, enc-ms %, dec-ms % of `jxl` relative to `jxl_orig` at the fixed-quality point (per class + overall). The differentiator.
4. **`pareto-enc-time.svg`** — x=encode ms, y=bpp at butteraugli≈1.5; markers per codec; **split into two panels** (native / WASM) to respect the runtime caveat.
5. **`bars-size-time.svg`** + **BD-rate table** — bar chart of bytes + enc-ms per codec at the fixed point; BD-rate (Bjøntegaard delta-rate) table vs `jpeg_native` baseline, computed from the RD sweep.

Also an index **`figures.html`** embedding all SVGs with captions.

## 7. Module structure (small, focused, testable)

| File | Responsibility | Tested |
|---|---|---|
| `benchmark/codec-adapters.mjs` | ADD `jxl_orig` adapter | round-trip (extend Part-1 test) |
| `benchmark/rd-sweep.mjs` | quality-ladder sweep over (image × codec); pure, codec injected | unit (fake codec) |
| `benchmark/bd-rate.mjs` | Bjøntegaard delta-rate from two RD point sets (PCHIP/cubic over log-rate) | unit (known curves) |
| `benchmark/svg-figures.mjs` | `rdCurve()`, `paretoPlot()`, `barChart()`, `deltaChart()` → SVG strings; pure geometry | unit (viewbox, path monotonic, point mapping) |
| `benchmark/codec-paper-serialize.mjs` | data toon (per-point rows + fixed-point aggregates) | unit |
| `scripts/fetch-kodak.mjs` | idempotent Kodak download | manual smoke |
| `CodecPaperTest.mjs` | orchestrator: corpus → sweep → fixed point → figures + toon + html | e2e run |

## 8. Output layout

```
docs/outputs/codec-paper/
  corpus/kodak/kodim01.png ...          (fetched, gitignored)
  figures/rd-butteraugli.svg
  figures/rd-ssim.svg
  figures/ours-vs-orig-jxl.svg
  figures/pareto-enc-time.svg
  figures/bars-size-time.svg
  figures.html                           (gallery + captions + BD-rate table)
  <stamp>-CodecPaper-<batch>.toon        (data; family codec-paper)
```

## 9. Registry changes (additive)

`benchmark/benchmark-history-registry.mjs`:
- `deriveFamilyIdFromArtifactName`: add `if (candidates.some(v => v.includes("codecpaper"))) return "codec-paper";`
- `FAMILY_LABEL_OVERRIDES`: `["codec-paper", "Codec Paper"]`
- `FAMILY_COLOR_OVERRIDES`: `["codec-paper", "#14b8a6"]` (teal; not used by any existing family override)

## 10. Cost / budget

~32 images × 9 codecs × (8 sweep points + ≤8 search iters + N=3 timing). AVIF encode is slow (seconds); Kodak images are small (768×512) so cheap. Est 10–25 min wall. Log per-image progress; cap search iters; log non-converged/failed encodes (no silent drops).

## 11. Success criteria

- `scripts/fetch-kodak.mjs` populates 24 Kodak PNGs (idempotent); orchestrator runs full corpus and writes all 5 SVGs + `figures.html` + one `codec-paper` toon.
- RD curves show monotonic non-increasing butteraugli as bpp rises per codec; `jxl`/`jxl_orig`/`avif` dominate JPEG at low bpp (sanity).
- Ours-vs-original-JXL figure reports finite size/time deltas at matched effort 3.
- Family resolves stably to `codec-paper`, no collision with `standard-multifile`/`codec-compare`.
- Every time figure carries the native-vs-wasm caveat; PNG shown as lossless reference only.
- All `benchmark/test/*.test.mjs` pass (Part-1 + new unit tests).

## 12. Excluded (YAGNI)

- No interactive/animated graphs (static SVG for print).
- No video codecs.
- No new perceptual metric beyond butteraugli + SSIM (PSNR available via PerceptualComparer if trivially free, but not plotted).
- No modification to `StandardMultifileTest.mjs` or existing families.
- Does not auto-insert figures into the JOSE paper (`C:\Foo\Jose`) — figures are standalone SVGs the user drops in.
