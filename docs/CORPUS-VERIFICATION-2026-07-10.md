# RAW corpus colour-fidelity verification — 2026-07-10

**For David (colour authority).** Overnight run. Every image below was decoded through the
**real shipped pipeline** in headless Chromium (crossOriginIsolated, camera WB, neutral
sliders, `OUT_FULL_RGB8`) — native `process_{orf,cr2,dng}_with_flags` for ORF/CR2/DNG,
LibRaw (`decodeWithLibRaw` → `process_raw_mosaic_with_flags`) for everything else — then its
channel ratios (R/G, B/G) were compared to **LibRaw's own sRGB render** (the camera-faithful
oracle; Δ = |rg−camRg| + |bg−camBg|, faithful if Δ < 0.30).

Harness: `tools/colour-verify-corpus.mjs` (reusable — `node tools/colour-verify-corpus.mjs`,
or `ONLY=<substr>` / `LIMIT=n` / `META=1`). Raw tables + JSON in this directory.

## Verdict: 26 faithful / 13 to review / 0 decode-failures (of 39). 1 fix applied.

Every image decoded successfully (0 failures) — including all 12 LibRaw formats
(CRW/CR3/NEF/NRW/RW2/RWL), confirming the browser LibRaw path works end-to-end.

## Correction applied + verified

**LibRaw white-balance fallback (`web/libraw-normalize.js` `extractWb`).** Old Canon CRW
bodies report `cam_mul = [0,1,0,0]` (invalid — R and B are zero), so we fell back to neutral
`[1,1]` → no WB → green cast. LibRaw's own `useCameraWb` render falls back to `pre_mul` (the
valid default multipliers) in this case; we now mirror that (`cam_mul → pre_mul → [1,1]`).
Verified by the harness, no regressions (the 10 LibRaw files with valid `cam_mul` are unchanged):

| Image | Before | After |
|-------|--------|-------|
| canon_a570is CRW | Δ 0.755 (green cast) | **Δ 0.219 — PASS** |
| canon_ixus900ti CRW | Δ 0.850 | Δ 0.394 (residual is matrix-side, below) |

`libraw-normalize` unit tests: 4/4 pass.

## To review (13) — grouped by likelihood of being a real bug

### A. Genuine LibRaw-path divergences — we use LibRaw's mosaic, so we *should* match its render (3)
These are Canon-specific: valid WB, but our render is red/blue-high vs LibRaw's neutral render
→ a **colour-matrix application** difference in `process_raw_mosaic` for Canon `rgb_cam`.
The 8 non-Canon LibRaw files (Leica/Nikon/Panasonic) match LibRaw well (Δ 0.02–0.20), so the
matrix path is correct in general — this is Canon-`rgb_cam`-specific. **Recommend: next fix.**

| Image | ours rg,bg | camera rg,bg | Δ |
|-------|-----------|--------------|---|
| canon_eos-m200 CR3 (2231) | 1.293, 1.240 | 0.968, 1.075 | 0.489 |
| canon_eos-m200 CR3 (2233) | 1.286, 1.197 | 0.983, 1.035 | 0.465 |
| canon_ixus900ti CRW | 1.179, 1.146 | 0.993, 0.938 | 0.394 |

### B. Native ORF/CR2/DNG — our own 07-08-verified decoders differ from LibRaw (10)
These are **our tuned decoders**, not LibRaw. A divergence from the LibRaw oracle here is a
**rendering-intent difference, not automatically a bug** — it's your tuned path vs LibRaw's
generic render. Flagged for your eye / an embedded-preview (camera-JPEG) cross-check.

**Pixel DNG (7)** — a consistent pattern: our render runs **warmer (blue-low)** than LibRaw's:

| Image | ours rg,bg | camera rg,bg | Δ |
|-------|-----------|--------------|---|
| PXL_180319603 | 1.376, 0.606 | 0.928, 1.067 | **0.909** |
| PXL_093507165 | 1.169, 0.539 | 0.993, 0.991 | 0.628 |
| PXL_100404049 | 0.643, 0.775 | 0.968, 0.973 | 0.523 |
| PXL_194503279.NIGHT | 0.920, 0.611 | 0.961, 1.010 | 0.441 |
| PXL_175312330 | 0.821, 0.767 | 1.001, 0.988 | 0.401 |
| PXL_095020990 | 0.990, 0.636 | 0.997, 1.009 | 0.380 |
| PXL_194439088 | 0.859, 0.802 | 0.991, 1.041 | 0.371 |

The consistent blue-low across 7/15 Pixel DNGs is worth a look — either an intentional warm
"look" in the DNG tone/WB path or a real WB/ColorMatrix drift vs the DNG's AsShotNeutral. The
other 8 Pixel DNGs match LibRaw closely (Δ 0.02–0.24). **Recommend: compare a couple against
the Pixel's own in-camera JPEG to decide bug vs look before touching the DNG path.**

**Canon CR2 (3)** — our render vs LibRaw:

| Image | ours rg,bg | camera rg,bg | Δ | note |
|-------|-----------|--------------|---|------|
| ADH 1570 | 1.455, 1.280 | 0.970, 0.627 | 1.138 | ours magenta on a scene LibRaw renders neutral |
| ADH 1234 | 1.464, 1.393 | 1.740, 0.918 | 0.751 | red scene (both agree) but our blue too high |
| _MG_1750 | 0.739, 1.106 | 0.865, 1.312 | 0.331 | marginal |

ADH 1234/1248/1455/1490/1514/1559 mostly pass — 1234 & 1570 stand out (blue too high). The
native CR2 path is your tuned decoder; recommend an embedded-preview cross-check.

## Why I stopped here (not blind-tuning the rest)
The CRW WB fix had an unambiguous root cause + a harness-verified improvement, so I applied it.
The remaining 13 are either (A) a Canon-`rgb_cam` matrix nuance or (B) our-tuned-decoder-vs-LibRaw
rendering-intent differences — both are colour-authority calls where blindly changing matrix/WB
math overnight risks making the corpus *worse* and regressing the 26 that pass. They're quantified
above with root-cause hypotheses so you can decide the approach.

## Suggested order for the morning
1. **Canon `rgb_cam` matrix** in `process_raw_mosaic` (group A) — clearest remaining real bug; the
   non-Canon LibRaw formats prove the general path is right, so it's Canon-matrix-specific.
2. **Pixel DNG blue-low** (group B) — decide look-vs-bug against an in-camera JPEG first.
3. **CR2 ADH 1234/1570** — same, embedded-preview cross-check.
4. Re-run `node tools/colour-verify-corpus.mjs` after each change — it's the gate (Δ must drop,
   the 26 PASS must stay green).
