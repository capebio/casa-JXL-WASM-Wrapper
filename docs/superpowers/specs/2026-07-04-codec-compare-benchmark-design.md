# Codec-Compare Benchmark — Design Spec

**Date:** 2026-07-04
**Status:** Approved (brainstorming) → pending implementation plan
**Author:** David + Claude

## 1. Goal

At the perceptual quality we actually ship (our JXL at distance 1.0 / q85), quantify where our WASM JXL sits versus the ubiquitous codecs (JPEG, WebP, AVIF, PNG) on the **size ↔ time** Pareto, using the same 8 standard files. Answers: *"For the image quality we ship, how do our bytes and encode/decode/first-paint times compare to everything a browser or CDN already does?"*

## 2. Constraints

- **Must NOT modify** `StandardMultifileTest.mjs` or the standardized `standard-multifile` graph family.
- New family `codec-compare` graphs separately (needs its own `deriveFamilyIdFromArtifactName` branch in `benchmark/benchmark-history-registry.mjs` — without it the resolver falls through to the timestamped stem and spawns a new family per run; lesson from the previewFirst A/B work).
- Native (sharp / libvips, multi-threaded + SIMD) vs WASM (@jsquash + our JXL) means **encode/decode ms are NOT directly comparable across runtimes**. Size and quality ARE. This caveat must be loud in the output.
- Reuse existing infra: RGBA loader pattern from `StandardMultifileTest.mjs:377-405`, `PerceptualComparer` (`src/lib.rs:3208`, `pkg/raw_converter_wasm.js`), flip-flop interleaved timing pattern, quality-search precedent `benchmark/quality-search-heuristic-ab.mjs`.

## 3. New file

`CodecCompareTest.mjs` at repo root (sibling of `StandardMultifileTest.mjs`). Self-running node script, same launch style (`node ./CodecCompareTest.mjs [batchName]`).

## 4. Codec matrix

Each codec has a unique **codec key** (`format_runtime`) so same-format/different-runtime rows and aggregates never collide.

| Codec key | Runtime | Lib | Quality knob | Role |
|---|---|---|---|---|
| `jxl` | WASM | facade `createEncoder` | distance 1.0 | **anchor** — not searched |
| `jpeg_wasm` | WASM | @jsquash/jpeg (mozjpeg) | quality 1–100 | searched |
| `webp_wasm` | WASM | @jsquash/webp | quality 1–100 | searched |
| `avif_wasm` | WASM | @jsquash/avif | quality (cq) | searched |
| `jpeg_native` | native | sharp `.jpeg()` | quality 1–100 | searched |
| `webp_native` | native | sharp `.webp()` | quality 1–100 | searched |
| `avif_native` | native | sharp `.avif()` | quality 1–100 | searched |
| `png_native` | native | sharp `.png()` | lossless | size/time reference only (not butter-matched) |

**New dev deps** (install during implementation): `@jsquash/jpeg`, `@jsquash/webp`, `@jsquash/avif` (`@jsquash/jxl` already present but unused — we test OUR jxl, not the reference one).

## 5. Pipeline (per file)

1. **Load RGBA @1920:** lift the loader — `process_{orf,cr2,dng}_with_flags` → `rgb` → long-edge scale to 1920 via `downscale_rgb` → `rgb_to_rgba`. Factor into a small local `loadTargetRgba(path)` helper.
2. **Anchor:** encode our JXL @ distance 1.0 → decode-back to RGBA → `PerceptualComparer(source).butteraugli(decoded)` = **per-file target `T`**.
3. **Search (each searched codec):** binary-search the quality knob over its range to hit `T` within **tolerance ±0.15** butteraugli, **max 8 iterations**, keep the closest-achieved if not converged. Each trial: encode → decode-back to RGBA → butteraugli. Log the found quality + achieved butteraugli + whether it converged.
4. **Timed measurement:** at the found quality, run **flip-flop interleaved timing, N=5 rounds** (median) for `enc_ms`, `dec_ms`, `ttfp_ms`. Record `bytes`, `bpp`, `achieved_butter`, `ssim`, derived `enc_fps`/`dec_fps` (= 1000 / ms).

## 6. Quality instrument

`PerceptualComparer` — one source-anchored instance per file; `.butteraugli(decodedRgba)` and `.ssim(decodedRgba)` for every codec. Identical ruler across all codecs → fair quality comparison. (libjxl's `_jxl_wasm_butteraugli_compare` is an available cross-check but not used by default; PerceptualComparer is simpler and already in `pkg`.)

## 7. Decode-back per codec (for quality + decode timing)

- **sharp:** `sharp(buf).ensureAlpha().raw().toBuffer()` → RGBA.
- **@jsquash:** each package's `decode()` → `ImageData` → RGBA (Uint8, 4ch).
- **our JXL:** facade `createDecoder` (reuse the `decodeJxl` shape; `firstFrameMs` = real progressive TTFP).

## 8. TTFP semantics

- Non-progressive (JPEG baseline, WebP, AVIF, PNG, mozjpeg): `ttfp_ms = full decode ms`, `ttfp_kind = "full"` (single-pass; first paint = full image).
- Our progressive JXL: `ttfp_ms = firstFrameMs`, `ttfp_kind = "progressive"`.
- Column `ttfp_kind` disambiguates so the graph never implies a partial paint where none exists.

## 9. Native-vs-WASM handling

- Every row tagged `runtime: native | wasm`.
- Toon header line: `# CAVEAT: native (sharp; libvips MT+SIMD) vs wasm (@jsquash, our JXL) — ENCODE/DECODE MS + FPS NOT COMPARABLE ACROSS RUNTIMES. SIZE + QUALITY ARE.`
- Interpretation rule: cross-runtime comparisons valid only for `bytes` / `bpp` / `achieved_butter` / `ssim`. Time/FPS comparisons stay within a runtime.

## 10. Output schema

`docs/outputs/timing tests/<stamp>-CodecCompare-<batch>.toon`, family `codec-compare`.

Per-file × per-codec rows:
```
rows[N]{file|codec|runtime|quality|target_butter|achieved_butter|converged|ssim|enc_ms|dec_ms|ttfp_ms|ttfp_kind|bytes|bpp|enc_fps|dec_fps}
```

Aggregates (per codec key, emitted as `Avg_<codecKey>_<Metric>` — e.g. `Avg_webp_native_Bytes`, `Avg_jpeg_wasm_EncMs` — so the history graph auto-namespaces them into the `codec-compare` family overlay without cross-runtime collisions):
- `Avg_<key>_Bytes`, `Avg_<key>_Bpp`, `Avg_<key>_EncMs`, `Avg_<key>_DecMs`, `Avg_<key>_AchievedButter`, `Avg_<key>_Ssim`
- `Avg_<key>_SizeVsJxlRatio` (codec bytes ÷ our-`jxl` bytes; the headline metric)
- **FPS overlay (optional):** `Avg_<key>_EncFps`, `Avg_<key>_DecFps` — emitted as family overlay series with `defaultOn: false` (toggle-on in the graph). Same cross-runtime caveat as raw ms.

## 11. Registry changes (additive, low-risk)

`benchmark/benchmark-history-registry.mjs`:
- `deriveFamilyIdFromArtifactName`: add branch `if (candidates.some(v => v.includes("codeccompare"))) return "codec-compare";`
- `FAMILY_LABEL_OVERRIDES`: `["codec-compare", "Codec Compare"]`
- `FAMILY_COLOR_OVERRIDES`: `["codec-compare", "#e879f9"]` (distinct fuchsia)

## 12. Cost / budget

8 files × 6 searched codecs × ≤8 iters × (encode + decode + butteraugli), plus N=5 timed rounds. Native encodes ~ms; WASM slower. Estimate 3–6 min wall. Iteration cap prevents runaway; non-converged codecs logged explicitly (no silent truncation).

## 13. Success criteria

- Runs to completion on all 8 standard files, writes one valid `codec-compare` toon.
- Every searched codec reports a quality that hits target butteraugli within ±0.15 (or a logged closest-miss).
- Family resolves stably to `codec-compare` across timestamps; does NOT collide with `standard-multifile`; standard family + graph unaffected.
- Output carries the native-vs-wasm caveat; each row runtime-tagged; TTFP kind labelled.
- Headline readable: per-codec size-vs-JXL ratio + enc/dec ms (within-runtime) + optional FPS overlay.

## 14. Excluded (YAGNI)

- No quality ladder (single anchored target per file).
- No progressive JPEG / progressive WebP.
- PNG not butteraugli-matched (lossless reference only).
- No modification to `StandardMultifileTest.mjs` or the `standard-multifile` family.
- libjxl butteraugli cross-check not wired by default.
