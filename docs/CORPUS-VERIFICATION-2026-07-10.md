# RAW corpus colour-fidelity verification — 2026-07-10

**For David (colour authority).** Reference of record = **each RAW's own embedded JPEG** (the
colour the camera actually produced). Every image is decoded through the real shipped pipeline
in headless Chromium (native `process_{orf,cr2,dng}_with_flags`, or LibRaw →
`process_raw_mosaic_with_flags`), and **both our render and LibRaw's own sRGB render** are scored
against the camera JPEG on channel ratios (Δ = |Δrg| + |Δbg|). Harness:
`tools/colour-verify-corpus.mjs` (`node tools/colour-verify-corpus.mjs`; `ONLY=<substr>` /
`LIMIT=n` / `META=1`). Raw tables + JSON in `docs/outputs/corpus-colour-verify/`.

## Verdict: 32 faithful / 7 diverge / 0 decode-failures (of 39)

**Closer to the camera JPEG: ours on 21 images, LibRaw on 16.** Our decoders are *good* — on
most images we track the camera at least as well as LibRaw.

### Headline correction to the first pass
The earlier "DNG blue-low" flags were an **artifact of using LibRaw as the reference**. Against
the **camera JPEG**, our Pixel-DNG renders are faithful and usually **closer than LibRaw** (LibRaw
renders those DNGs too neutral). Example: PXL_175945329 — Δours 0.389 vs **Δlib 0.521** (ours
closer). **No DNG action needed.**

## Applied + verified: LibRaw white-balance fallback
`web/libraw-normalize.js` `extractWb`: old Canon CRW report `cam_mul=[0,1,0,0]` (invalid) → we
rendered a green cast. Now `cam_mul → pre_mul → neutral` (mirrors LibRaw's own `useCameraWb`).
Verified: canon_a570is CRW went from a green cast to matching the camera; `libraw-normalize`
tests 4/4.

## The real divergences — all Canon colour-matrix (our render wrong; camera JPEG + LibRaw agree)

| Image | Path | ours rg,bg | LibRaw rg,bg | **camera JPEG** | Δours | Δlib |
|-------|------|-----------|--------------|-----------------|-------|------|
| ADH 1570 CR2 | native | 1.455, 1.280 | 0.970, 0.627 | **0.967, 0.691** | **1.078** | 0.067 |
| ADH 1234 CR2 | native | 1.464, 1.393 | 1.740, 0.918 | **1.637, 0.939** | **0.627** | 0.124 |
| m200 CR3 (2231) | LibRaw | 1.293, 1.240 | 0.968, 1.075 | **0.986, 1.023** | **0.524** | 0.070 |
| m200 CR3 (2233) | LibRaw | 1.286, 1.197 | 0.983, 1.035 | **1.000, 0.996** | **0.488** | 0.056 |

**Root cause (native CR2):** `canon_color_matrix()` has a hard `return None` at the top —
> *"Per-model matrices are temporarily disabled… All bodies fall through to the generic
> `CANON_CAM_TO_SRGB` fallback."*

So every Canon body (incl. EOS M5) gets one generic matrix. For ADH 1234/1570 that under-corrects
→ excess blue / magenta. LibRaw uses the M5-specific matrix (from the camera `cam_xyz`) and lands
on the camera JPEG. The infra exists — `canon_cam_xyz(model)` — but is dead-coded behind that
`return None`. **Fix: re-enable per-model matrices (derive the sRGB matrix from `canon_cam_xyz`).**
The other ADH/`_MG` CR2 files pass (several with ours *closer* than LibRaw), so the generic matrix
is only wrong where the M5 profile diverges most — the M5 matrix should help those or be neutral.

**Root cause (LibRaw CR3):** we pass LibRaw's `rgb_cam` into `process_raw_mosaic`, yet our render
still diverges from LibRaw's own (Δ 0.49 vs 0.06) — a **matrix-application** difference in the
mosaic path, Canon-specific (non-Canon LibRaw formats — Leica/Nikon/Panasonic — all track the
camera JPEG within Δ 0.02–0.2). Separate fix from the native CR2 one.

## Minor / can't-verify (3)
- **nikon_1-aw1 NEF**: Δours 0.357 vs Δlib 0.222 — both a touch off, LibRaw closer. Low priority.
- **canon_ixus900ti CRW**: no embedded JPEG in the file → can't score against the camera.
- (The CRW WB fix already covers the a570is green cast.)

## Recommended next fixes (both camera-JPEG-justified, harness-gated)

### 1. Native CR2 per-model matrix (fixes ADH 1234/1570) — ready to apply, but your call
`canon_cam_xyz(model)` is **empty-stubbed** (`return None` for every model) → `canon_color_matrix`
always falls through to the generic `CANON_CAM_TO_SRGB`. The *matrix method itself* is sound —
`canon_color_matrix` mirrors the DNG path (`cam_xyz` → invert → `XYZ_D50_TO_SRGB`), and our DNG
renders are faithful — so it should just work once fed data.

**To enable EOS M5** (both ADH and `_MG` fixtures are M5), populate `canon_cam_xyz`:
```rust
"Canon EOS M5" => Some([8532, -701, -1167, -4095, 11879, 2508, -797, 2424, 7010]),
```
(LibRaw's `cam_xyz` for the M5 ×10000, read from the files themselves.) Then rebuild `web/pkg` +
re-run the harness — ADH 1234/1570 Δ should drop toward LibRaw's ~0.07/0.12; the passing ADH/`_MG`
must stay faithful.

**⚠ Two guards before you do:** (a) a test — `canon_color_matrix_disabled_until_neutral_correction_implemented`
— *asserts* `canon_color_matrix` returns `None` for M5, citing **"channel collapse" from
"direct adobe_coeff use in CasaWASM's WB-first pipeline"**; that test must be updated, and the
caveat verified stale (it likely predates the current DNG-mirrored method). (b) I did **not**
re-enable it — you disabled per-model matrices deliberately, and channel-collapse is a real
failure mode, so this is your colour-authority call. The harness makes it a 2-minute verify:
enable → rebuild → `node tools/colour-verify-corpus.mjs` → confirm Δ drops with no dark/collapsed CR2.

### 2. LibRaw Canon `rgb_cam` application in `process_raw_mosaic` (CR3/CRW residual)
Non-Canon LibRaw formats track the camera JPEG (Δ 0.02–0.2), so the mosaic matrix path is right in
general — Canon-`rgb_cam`-specific. Separate from #1.

The embedded-JPEG comparison (`node tools/colour-verify-corpus.mjs`) is the gate for both — Δours
must drop and the 32 faithful must stay green.
