# JPEG XL as a Video Codec — Design Contemplation

**Date:** 2026-07-01
**Status:** Design / feasibility contemplation (pre-plan)
**Worktree:** `C:\Foo\rcw-video-codec` on branch `docs/jxl-video-codec-jul01`
**Probe:** `tools/video-probe/probe.mjs` (+ generated frames under `C:\Foo\raw-converter\tests\fractal_gen_seahorse_*`)

---

## 1. Problem, scope, driving use-cases, non-goals

We already ship a highly-optimised JPEG XL fork (libjxl 0.12, `capebio/casa-0.12-dev-o2`) with a full
still-image encode/decode stack (WASM-in-browser + native Rust/N-API). The **animation container is
already present and exposed** (`bridge.cpp:1839` `EncodeAnimation`; per-frame `duration`/`tps`/`is_last`;
five blend modes; forward frame-skip decode) — but **every frame today is an independent still**
(`JXL_BLEND_REPLACE`, `save_as_reference = 0`). That is **Motion-JXL**: an all-intra codec. It is "too
heavy to stream at 24fps" and, more fundamentally, cannot beat real video codecs on compression, because
real video codecs (H.264/HEVC/AV1/VVC) get most of their ratio from **temporal prediction** (motion
compensation, P/B frames) — a tool Motion-JXL does not use.

**Goal:** a streamable, JXL-based video format for **ShareNat citizen-science video**, tunable per device
for quality/fps, that is *better than existing codecs on the content and axes that matter to that domain* —
not universally better on arbitrary motion.

**Driving use-cases (the content class defines the winnable game):**

1. **Low-motion nature observation** — trail cams, feeders, static/slow handheld. Background nearly
   static; small moving subject. *Temporal delta with little/no motion.*
2. **Train side-look landscape survey** — camera perpendicular to a fast train, high shutter, a few fps.
   **Structured motion parallax:** pure horizontal shift whose velocity is a function of depth
   (`v(Z) = f·V_train / Z`) — sky ≈ 0, trackside foreground whips past; a vertical strip of new scenery
   enters the leading edge each frame (disocclusion). *Depth-layered horizontal shift.*
3. **General citizen-science streaming** to browsers/phones — the distribution envelope both of the above
   ride on; must decode on modest devices.

**Scope of this document:** contemplate the full design space (three architectures A/B/C), recommend a
build target, ground the compression/compute claims with a real JXL probe, and produce a phased plan.

**Non-goals (stated honestly):**
- Beating VVC/AV1 on **high-motion general content** (Hollywood pans, sports). That needs a full motion
  engine we are not going to out-engineer, and JXL gives no leverage on the expensive part (motion search).
- **Hardware decode.** No silicon anywhere decodes JXL (AV1/HEVC/H.264 do). This is the single biggest
  risk for phone distribution and is treated as a first-class constraint, not wished away.
- Real-time **encode** at 24fps. For streaming, encode is **offline** (once, on the capture device or a
  server). The only hard real-time budget is **decode** on the viewer's device (~41.6 ms/frame @ 24fps).

---

## 2. Thesis

> **A JXL transform + entropy *backend* with a pluggable, domain-tunable *prediction front-end*.**

JXL's frame codec (XYB colour, VarDCT, adaptive quantization, ANS context modelling, Gaborish/EPF) is a
genuinely competitive transform+entropy stage — for intra it already beats AVIF/HEVC-intra/JPEG, and it is
heavily optimised in our fork. The thing it lacks for video is *prediction*. So we do **not** rebuild the
transform stage; we put a **prediction front-end** in front of it that produces a residual (or selects a
reference), and feed that residual to the existing, fast JXL frame codec.

The prediction model is **negotiated per stream and per device** — the capability HW-frozen codecs cannot
offer. This is the direct expression of "we own the format":

| Prediction model | Use-case | Cost |
|---|---|---|
| **None** (GOP=1, all-I) | mezzanine / lossless archive (= Architecture A, the MVP) | trivial |
| **Zero-motion ADD-residual** | low-motion nature observation | low |
| **Layered horizontal shift + disocclusion-intra** | train parallax survey | low–medium (1-D search) |
| General block motion estimation/compensation | escalation only if ever needed (= Architecture C) | high, deferred |

Per-device tunability rides on top of any model: decode effort / resolution / fps are negotiated to the
viewer's silicon against **the same bitstream** (progressive + resolution ladder), so a workstation gets
4K and a phone gets a downscaled/skipped stream from the same file.

---

## 3. Architecture B (recommended build target), in detail

### 3.1 Bitstream / GOP structure
- **GOP** = one **I-frame** (full JXL still) followed by K **P-frames** (prediction + residual). GOP length
  is a rate/latency/error-resilience knob (short GOP = better seek + loss recovery, larger size).
- Each P-frame carries: a **prediction descriptor** (which model, parameters — e.g. per-band `dx`), and a
  **residual** coded by the JXL frame codec against the reconstructed reference.
- The **reference** uses JXL's existing machinery: `save_as_reference` (IDs 0–3) to retain the previous
  reconstructed frame; `JXL_BLEND_ADD` to add the decoded residual to a (possibly shifted) reference; and
  **patches** (`kPatches`, reference-frame rectangle copies) for the horizontal-shift block copies.
- **Container/mux** (§3.6): frames wrapped in a CMAF/WebM-like box with timing + a keyframe index; audio
  (Opus) muxed alongside for a real streaming format.

### 3.2 Drift-free reconstruct loop (the correctness spine)
A predictive codec must predict from **exactly what the decoder will reconstruct**, not the original —
otherwise error accumulates ("drift"). So the encoder runs an **in-loop decode**:
```
ref = decode(I-frame)                       # bit-exact reconstruction
for each P-frame:
    pred      = predict(ref, model, params) # shift / patch-copy / identity
    residual  = current − pred
    bits      = JXL_encode(residual, distance)
    ref       = pred + JXL_decode(bits)      # reconstruct EXACTLY as the decoder will
```
Our repo's byte-exact roundtrip culture (the whole `docs/` history of FNV/SHA A/B gates) is precisely the
discipline this needs. Lossless residuals (`-d 0`) are drift-free by construction; lossy residuals require
the reconstruct-in-loop above.

### 3.3 Prediction model 1 — zero-motion ADD-residual (nature)
`pred = ref` (identity). `residual = current − ref`. For a static background with a small moving subject,
the residual is near-zero except the subject region → the JXL codec compresses it to a small fraction of an
intra frame. **Probe result: 88% smaller than intra on the static sequence** (§7). This is the cheapest
possible temporal model and already a large win for use-case 1.

### 3.4 Prediction model 2 — layered horizontal shift (train parallax)
The train geometry gives a *structured* motion field, so we skip general 2-D block search entirely:
- Partition the frame into a few **horizontal-velocity bands** (by image region where depth correlates
  with vertical position — foreground low, sky high — or by a cheap per-column 1-D horizontal MV estimate).
- For each band, predict from the reference by an **integer horizontal shift** `dx_band` (a `kPatches`
  rectangle copy with offset). Sub-pel + parallax mismatch is mopped up by the JXL residual.
- The **disocclusion strip** at the leading edge is genuinely new content → coded as a small intra region
  (residual-from-zero, which the JXL codec handles as ordinary image content).
- Motion search is **1-D** (a handful of horizontal velocities), orders of magnitude cheaper than 2-D ME —
  the "we customise per use-case" advantage made concrete.
- **Probe result:** naive zero-motion delta is *worse than intra* on a pan (−68%), but single/-layered
  horizontal-shift delta is **~93% smaller than intra** (§7). Layered beats single-shift on true parallax.

**Two analysis bonuses a straight image processor cannot give:**
1. The codec's own per-band motion field **is a coarse depth/parallax map** — free foreground/background
   segmentation and object-distance cue, emitted as sidecar metadata.
2. The shift model naturally supports building a **pushbroom/slit-scan strip mosaic** — stitch the corridor
   into one continuous georeferenced panorama instead of N frames (a known mobile-mapping technique).

### 3.5 Rate control
JXL is **quality-targeted** (Butteraugli distance), not bitrate-targeted; streaming needs bitrate/VBV
control. Add a thin outer loop: per-GOP target-bytes → choose per-frame distance (and I/P cadence) via a
1-D search using the existing fast encode, with a leaky-bucket VBV model. Foreground/ROI can be given lower
distance (more bits) — which, for the train case, is exactly where the largest residuals already fall.

### 3.6 Container, seek, error resilience
- **Mux:** a fragmented box format (CMAF-ish / WebM-ish): JXL frames as samples + timing + Opus audio + a
  **keyframe (GOP-start) index** for seeking. Forward frame-skip already exists (`jxl_wasm_dec_seek_frame`).
- **Seek** = decode from nearest preceding I-frame.
- **Error resilience:** I-frame cadence bounds loss propagation; optional **intra-refresh** (a moving intra
  column per frame) gives graceful recovery without frequent full I-frames — and note the train
  disocclusion strip is *already* a moving intra column, so intra-refresh is nearly free there.

---

## 4. Architecture A (MVP) and C (escalation)

**A — Motion-JXL (all-intra), compute-optimised + per-device adaptive.** This is Architecture B with
GOP = 1 (no prediction). It is the **MVP milestone**: reuse the existing animation container, add a
video-tuned low-effort profile, amortise per-frame setup (context models, quant tables, XYB LUTs — our
Arc-shared-LUT / thread-local-scratch work already makes this cheap) across the sequence, and add the
container + per-device decode ladder. Ships value immediately as a **visually-lossless / lossless mezzanine
and archive** format (beats ProRes ratio; competitive with/better than Motion-JPEG2000; HDR + progressive).
It does *not* win distribution bandwidth. **What it takes:** weeks — mostly a low-effort encode profile,
setup amortisation, and streaming glue.

**C — Full hybrid (block ME/MC + JXL backend).** Real variable-block motion estimation/compensation, sub-pel
interpolation, in-loop filters; residual → JXL VarDCT+ANS. Could approach AV1/HEVC on general content, but
motion search is the expensive, research-grade part JXL gives no leverage on, and decode gets heavier.
**Escalation triggers:** only if a use-case appears with sustained high 2-D motion that layered-shift cannot
model *and* bandwidth is critical. Kept documented, not built. **What it takes:** 6–18 months; unlikely to
beat VVC.

**Recommendation: build B, with A as the first shippable milestone inside it; keep C as a documented
escalation.**

---

## 5. Compute envelope & per-device tunability

**The real-time constraint is decode, and delta/shift frames are cheap.** Encode is offline.

- **Resolution reality:** the "18 MP encode ≈ 626–1197 ms" figure in `docs/wasm-mt-and-encode-under-1s-findings.md`
  is *photo*-size. Video is far smaller: 1080p = 2 MP, 4K = 8.3 MP. Decode cost scales roughly with
  megapixels and (for P-frames) with residual density.
- **Measured compute envelope** (`examples/casv_bench.rs`, release, native, **single-thread**, all-intra, on
  48 real dashcam frames; decode = the real-time constraint):

  | tier | 720p (0.92 MP) dec ms/f | 1080p (2.07 MP) dec ms/f | 24fps @ 720p | 24fps @ 1080p |
  |---|---|---|---|---|
  | **lossy d1 e3** (distribution) | **22.4** (45 fps) | **48.0** (21 fps) | ✅ single-thread | ⚠️ needs ~2 threads |
  | lossless e3 (science tier) | 109.6 | 239.7 | ❌ | ❌ |
  | lossless e7 | 171.7 | 341.1 | ❌ | ❌ |

  This **corrects the earlier spawn-dominated djxl estimate**: the *lossy distribution* tier is far cheaper
  than first measured. Reads:
  - **720p lossy decodes at 24fps single-threaded today** (22 ms/f). Motion-JXL is already streamable at 720p.
  - **1080p lossy needs ~2 threads** (48→<42 ms; decode scales *sub*-linearly, 2.14× for 2.25× pixels). 4K
    lossy ≈ ~200 ms/f single-thread → ~5 threads *or* the static-skip lever.
  - **Compute is a lossless / high-resolution problem, not a lossy-720p one.** The science/near-lossless tier
    (110–341 ms/f) needs skip + threads for real-time — but that tier is usually analysis/scrub, not live.
  - **Encode is offline and cheap enough for near-real-time capture**: lossy-e3 encode = 37 ms/f @720p (27
    fps single-thread; GOP-parallel → real-time). Lossless-e7 = ~1–2 s/f (offline transcode only).
  - **Bandwidth, not decode-speed, is the gap at 720p lossy:** all-intra ≈ 28 Mbps vs HEVC ~3.7 Mbps —
    **temporal delta's primary job is bandwidth**, and the speed levers (skip/threads) are for 4K, WASM, and
    the lossless tier.
  - **Browser WASM (128-bit SIMD, no AVX2, SAB threads):** ~3–5× slower → 720p lossy ≈ 66–112 ms/f
    single-thread; needs threads + static-skip. **The binding constraint**; the per-device ladder lives here.
  - **Future GPU/WebGPU:** not today; a possible C-lite lane for the transform stage.
- **Per-device ladder (the tunability the format buys us):** negotiate, against one bitstream —
  resolution (decode a lower pyramid level / DC-only for weak devices), fps (skip to I-frames or every-Nth
  P), and decode effort. Progressive + our JXTC region decode + the DC-first path (`decode_progressive`)
  are the mechanisms; they already exist.
- **Reused foundation — strip/banded decode:** the in-flight **Streaming ORF Preview Decode** work
  (banded row-decode → half-demosaic → box-downscale in strips; `decode_orf_raw` gate) is the *same
  memory-bounded, strip-at-a-time pattern* a real-time video decode loop needs. Treat it as a building
  block, not something to reinvent. (Isolated in worktree `rcw-dng-stream` — do not disturb.)

---

## 6. Scientific-value differentiators (why "better" holds for this domain)

Even where raw bandwidth ties AV1, JXL-video wins on axes citizen science actually scores:

- **True lossless / near-lossless / HDR / >8-bit** — fidelity is the product (species ID, behaviour,
  vegetation/infrastructure survey). Distribution AV1/HEVC profiles are perceptual-lossy 8–10 bit.
- **ROI / foveated bitrate** — spend bits on the subject; starve the background. JXL spatial tiling (JXTC)
  + per-region distance. For the train case, bit allocation already tracks the fast (high-value) foreground.
- **Progressive browse** — DC-first instant preview, refine on demand; ideal for scrubbing large archives.
- **Provenance / no generational loss** — re-analysis re-encodes don't degrade.
- **Free structured metadata** — the parallax motion field → coarse depth/segmentation; the shift model →
  corridor pushbroom mosaic.
- **Per-device adaptivity** — one file serves a workstation and a phone at negotiated quality/fps.

---

## 7. Proof-of-concept probe — methodology & results

**Purpose:** ground the compression claims with real JXL bytes before committing to a plan.

**Corpus:** 4 sequences × 48 frames (2 s @ 24fps), 1280×720, rendered from the Mandelbrot **seahorse
valley**, each isolating one motion regime (`tools/video-probe/probe.mjs`, frames under
`C:\Foo\raw-converter\tests\fractal_gen_seahorse_{static,motion,parallax,zoom}`):
- **static** — fixed base + small orbiting element + faint global light flicker (nature/trail-cam).
- **motion** — uniform horizontal pan of a mirror-tiled rich strip (canonical translation / train single layer).
- **parallax** — three depth bands panned at different horizontal speeds (train side-look).
- **zoom** — continuous Mandelbrot zoom (honesty case: shift/delta predictors should fail).

**Coding strategies measured** (all **lossless**, `cjxl v0.12.0 -e7 -d0`, so numbers are a clean
information signal with zero drift; residuals stored as 16-bit offset images):
- **INTRA** — every frame independent (today's Motion-JXL).
- **DELTA_NONE** — I-frame + zero-motion residuals (`current − previous`).
- **DELTA_SHIFT** — I-frame + single global horizontal-shift-compensated residuals.
- **DELTA_LAYERED** — per-depth-band horizontal-shift residuals.

### Results (final — lossless, `cjxl v0.12.0 -e7 -d0`; % = size vs INTRA, negative = smaller = win)

| sequence | regime | INTRA KB/frame | DELTA_NONE | DELTA_SHIFT (global) | DELTA_LAYERED | **best vs intra** |
|---|---|---:|---:|---:|---:|---|
| **static** | nature / trail-cam | 277.8 | **−87.9%** | — | — | **−87.9%** (zero-motion) |
| **motion** | pan / single layer | 254.3 | +57.5% *(worse)* | **−95.0%** | −95.0% | **−95.0%** (h-shift) |
| **parallax** | train side-look | 256.6 | +53.1% *(worse)* | +7.0% *(worse)* | **−95.4%** | **−95.4%** (layered) |
| **zoom** | continuous zoom | 314.7 | +36.4% *(worse)* | — | — | INTRA wins (no simple predictor) |

*(Totals & raw bytes in `tools/video-probe/results.json`; run log in `measure.log`.)*

**Interpretation — the front-end model choice is decisive and content-dependent:**
- **static (nature):** zero-motion delta is **87.9% smaller** than intra. The cheapest temporal model is a
  large win for low-motion observation. → prediction model 1.
- **motion (pan):** naive zero-motion delta is **57.5% *worse*** than intra (residual noise everywhere), but
  horizontal-shift compensation is **95.0% smaller**. The front-end *must* be motion-aware. → model 2.
- **parallax (train):** the sharpest result. A **single** global shift is **still 7% worse than intra** —
  one motion vector cannot fit three band velocities — yet **per-depth-band** layered shift is **95.4%
  smaller**. This is the empirical case for a *pluggable, per-band, domain-tunable* predictor rather than one
  fixed model. → model 2 (layered), and the whole thesis.
- **zoom (honesty case):** every simple predictor is *worse* than intra (DELTA_NONE +36.4%). Continuous
  scaling defeats shift/delta; INTRA wins. This is the honest boundary where Architecture C (general ME/MC)
  would be required — and a signal to fall back to all-intra for such content rather than force a bad model.

**Bottom line (synthetic ceiling):** on *clean, structured* content matching the two ShareNat regimes
(low-motion nature, train parallax) a JXL backend with the right cheap prediction front-end is **~19–22×
smaller than Motion-JXL** at identical (lossless) fidelity, using only zero-motion or 1-D horizontal-shift
prediction — no 2-D motion search. The predictor is content-specific, which is exactly what owning the
format buys. *(But see the real-video floor below: on noisy general footage the gain collapses to ~34% and
motion comp stops helping — the win is real but content-gated.)*

### Real-video validation — Ghana dashcam clip (HEVC source)

The synthetic sequences give a *clean-content ceiling*. To find the *floor*, the same measurement was run on
48 real frames extracted (ffmpeg) from a **1080p25 HEVC dashcam clip** (`c:\995\Videos Ghana\…MP4`, 8388 kb/s
source), scaled to 720p. Content: vehicle interior + a moving street through the windshield + a static
timestamp overlay — mixed motion, real sensor noise, and source compression artifacts.

| strategy | KB | vs intra |
|---|---:|---|
| INTRA (Motion-JXL, lossless) | 21 833 | — |
| DELTA_NONE (zero-motion) | 14 355 | **−34.3%** |
| DELTA_GMC (global MV, estimated) | 14 355 | −34.3% *(MV estimated to 0)* |
| DELTA_BLOCK (per-32px-block MC, ±12) | 14 608 | −33.1% *(worse — MV overhead + block-edge residual)* |

**What the real clip actually shows (and what it does NOT):**
- **Temporal delta on real noisy footage yields ~34%, not 88–95%.** Sensor noise, real motion, and source
  artifacts don't delta cleanly. Synthetic = clean-content ceiling; noisy handheld/vehicle content ≈ floor.
- **Motion compensation didn't pay *on this clip*.** Global MV estimated to zero (static interior + overlay
  dominate) and per-block MC was *slightly worse* than plain delta. **But this is a narrow result** —
  lossless residual coding, small inter-frame motion, and (see diagnostic) a *noise-dominated residual that
  no motion model can predict*. It is **not** proof that motion comp never pays; on clean structured motion
  (synthetic parallax) layered shift won 95%. Downgrade Architecture C from "dead" to **"unproven here."**
- **The HEVC bitrate comparison was not apples-to-apples — retracted as a verdict.** It measured JXL at its
  *weakest* point (low-bitrate, losslessly re-encoding already-lossy 4:2:0 HEVC output, a downscaled
  estimate) and HEVC at its *strongest* (its distribution sweet spot). At the regime scientific use requires
  — **near-lossless / lossless / 4:4:4 / >8-bit** — HEVC/AV1 are inefficient by design and JXL is
  state-of-the-art; a fair *matched-fidelity* comparison (not yet run — needs a real x265/AV1 build) is the
  only meaningful head-to-head. **Honest statement:** JXL won't win *low-bitrate distribution* (HEVC's turf);
  at *high-fidelity scientific quality* the comparison favours JXL, and the maturity gap (3 weeks of tuning
  vs decades) means today's pipeline is a *rising floor, not a ceiling*.
- **Decode is marginal, not free.** Spawn-corrected native decode of the lossless 720p streams was **63
  ms/frame (intra) / 46 ms/frame (delta)** — over the 41.7 ms 24fps budget. Lossless is the heaviest path;
  lossy + threads + resolution scaling is the real 24fps route, and it is improvable with the ongoing
  pipeline work (not a fixed ceiling).

### Bit-sink diagnostic — where the real-video bits actually go (the improvement compass)

The higher-value use of the footage: not a pass/fail benchmark but a **map of where JXL leaves bits on the
table**, so pipeline work can target it. On sampled real frames (lossless), residual cost decomposed
(`node probe.mjs diag`, `results-diag.json`):

| bit sink | measurement | codec-improvement lever | recoverable |
|---|---|---|---|
| **noise floor** | 80% of residual samples are \|Δ\|≤1; deadzoning = −18.5%. \|Δ\|≤2 → −35.8%; \|Δ\|≤3 → −47.9% | **temporal grain/noise model or residual deadzone** (AV1 has film-grain synthesis; JXL lacks a temporal one) | **~18–48%** of delta bits |
| **static regions** | 51.6% of 16px blocks near-static (max\|Δ\|≤3); forcing skip = −14.4% | **block-skip flag** (HEVC "skip" mode) | **~14%** |
| **chroma** | Cb+Cr = 22% of delta bits (Y 78%) | **temporal chroma-from-luma / chroma-sub-in-time** | portion of 22% |

**This explains the earlier floor and points the way:** ~half the temporal residual on real footage is
*noise* and ~half the frame is *static* — exactly why plain delta only reached 34% and motion comp couldn't
help (you cannot motion-predict noise). The concrete, evidence-backed levers are **(1) a temporal
noise/grain model, (2) a static block-skip flag, (3) temporal chroma coding** — each a *targeted addition*
to the existing pipeline, not a rebuild, and each measurable with this harness. **Nuance for science:** at
true *lossless* the noise is signal and must be kept (the grain lever applies to the near-lossless/
distribution tier); block-skip and chroma levers apply at every tier. This "use the video to improve the
codec" win stands **independent of any codec race**.

**Deepened analysis** (`node probe.mjs diag2`, `results-diag2.json`, `heatmap-<seq>.png`) across real dashcam
+ synthetic nature + synthetic train:

| sequence | noise \|Δ\|≤1 | residual energy low/high-freq | top-10% tiles hold | best reference |
|---|---|---|---|---|
| real dashcam | 78.8% | 25% / **75%** | 43% | **prev** (2-avg worse, bg-mean +76% worse) |
| synth nature | 99.8% | 20% / 80% | **63%** | prev |
| synth train (parallax) | 81.1% | 32% / 68% | 26% | prev |

Three further decisions confirmed:
- **Single previous frame is the best reference on every content type.** 2-frame-average and running-
  background references were *worse everywhere* (they blur moving content; the static synthetic gains nothing
  because `prev` already predicts a static background perfectly). → **single-reference prediction is
  sufficient; multi-reference/background modelling is not a lever here** (would help only a locked-off static
  camera, and even then marginally). Simplifies the codec.
- **Residual energy is high-frequency dominated (68–80%).** Bits live in noise, texture and edges, not
  smooth structure → global illumination/DC prediction has little to gain; the two real levers remain the
  **noise model** (high-freq noise) and **motion** (edges).
- **Bit-cost concentration is content-dependent** (heatmaps confirm: the dashcam map is hot on the moving
  exterior, cold on the static interior/overlay). Localized-motion content (nature 63%, dashcam 43% of energy
  in 10% of tiles) makes **ROI / region-adaptive quant** a real lever; distributed-motion content (parallax
  26%) makes **motion compensation** the lever instead. → the codec should carry *both* and pick per content
  — reinforcing the pluggable/adaptive thesis.

**Probe caveats:** lossless residuals isolate information content but a shipping codec would use lossy
residuals + in-loop reconstruct (§3.2); byte-offset residual images are a compressibility proxy, not the
final residual transform; separate-plane and DC/AC encodes double-count coding overhead so shares are
indicative of *energy distribution*, not exact bit allocation; the HEVC bitrate figures are a *wrong-regime*
comparison (see above), retained only to illustrate JXL's *distribution* weakness — not as a verdict.
Reproduce: `node probe.mjs {gen,measure,video,videoblock,diag,diag2}`.

---

## 7b. Encoder comparison — real end-to-end (the four built stages)

`examples/casv_bench.rs` encodes+decodes the four implemented stages (lossless e3, GOP=24, tile=32) on 48
real frames; decode = sequential playback (`decode_casv_all_rgb8`), single-thread native.

Results below use the **16-bit-offset residual** (`cur − prev + 32768`), which *replaced* the initial
wrapping-8bit residual — see the finding note.

**Low-motion (seahorse-static, target-content proxy):**

| stage | size MB | vs intra | enc ms/f | dec ms/f | dec fps |
|---|---:|---:|---:|---:|---:|
| intra | 16.71 | +0.0% | 149.8 | 129.7 | 7.7 |
| delta g24 | 3.19 | −80.9% | 129.8 | 134.1 | 7.5 |
| bbox g24 | 3.15 | −81.2% | 88.7 | 72.7 | 13.8 |
| **tile g24 t32** | 3.40 | −79.7% | **87.5** | **52.0** | **19.2** |

**Noisy general (Ghana dashcam):**

| stage | size MB | vs intra |
|---|---:|---:|
| intra | 26.70 | +0.0% |
| delta g24 | 16.86 | **−36.9%** |
| bbox g24 | 16.87 | −36.8% |
| tile g24 t32 | 17.50 | −34.5% |

Findings:
- **Delta is net-positive on *both* content classes:** low-motion **−81%**, noisy dashcam **−37%** (matching
  the diagnostic's −34% prediction). The first result on wrapping-8bit was *+45% worse* on noisy content; the
  v0 residual mapped small negative diffs to large values (−1 → 255), a high-entropy bimodal signal JXL
  compresses terribly. **Switching to 16-bit-offset (−1 → 32767, tight/unimodal) was an ~82-point swing on
  noisy content (+45% → −37%) and −55% → −81% on low-motion.** First improvement target — **landed.**
- **Static-skip is a real *speed* lever:** on low-motion, tile-skip decodes **2.5× faster** (52 vs 130 ms/f,
  19.2 vs 7.7 fps) and encodes ~1.7× faster — the direct answer to "too heavy at 24fps" (do less work per
  frame). (All rows over budget here only because this is the heavy *lossless* tier; relative speedups
  compound with the ~5× cheaper lossy tier.)
- With 16-bit residuals unchanged regions are ~free, so **tile-vs-bbox is now a decode-compute distinction**
  (tile decodes fewer pixels), not a byte one.
- **Frame-parallel encode (rayon) — landed.** Frames encode independently (lossless residuals need only the
  previous *source*), so encode is embarrassingly parallel: **~3.5–4.4× faster** on 6 cores (720p lossless
  intra 182 → 41 ms/f ≈ **24fps encode single-machine**, near-real-time capture), byte-identical output.
  Decode is still sequential per GOP — **GOP-parallel decode** (independent GOPs across cores) is the
  follow-on for multi-GOP streams.

---

## 8. Hard problems, risks & mitigations; phased plan

### Risks
| Risk | Severity | Mitigation |
|---|---|---|
| **No HW decode** → CPU/battery on phones | High | Cheap P-frames lower *average* decode; per-device res/fps ladder; DC-only tier for weak devices; native app where possible |
| **Drift** in predictive coding | High if wrong | In-loop reconstruct (§3.2); lean on existing byte-exact A/B culture |
| **Rate control** (JXL is quality- not bitrate-targeted) | Medium | Outer per-GOP target-bytes loop + VBV (§3.5) |
| **Muxing + audio + seek** | Medium | CMAF/WebM-like container + Opus + keyframe index (§3.6) |
| **Error resilience** for streaming loss | Medium | I-frame cadence + intra-refresh (free on train disocclusion strip) |
| **Ecosystem/interop** (nobody else decodes it) | Medium | Ship a WASM decoder as the portable runtime; it is our own player anyway |

### Phased build plan (each phase independently shippable / measurable)
1. **P0 — Probe & decide (this document).** ✔ Done for compression on synthetic + a real HEVC clip. **Still
   to measure before P2 commits:** lossy (rate-controlled) temporal gain via the real reference-frame/ADD
   API, and **WASM/mobile lossy decode fps** (the binding constraint — native lossless was already over budget).
2. **P1 — Architecture A MVP.** Video-tuned low-effort encode profile + setup amortisation across a GOP;
   container + timing + per-device decode ladder; all-intra. Ship as mezzanine/archive. *Weeks.*
3. **P2 — Prediction model 1 (zero-motion delta).** GOP + reference + ADD-residual + in-loop reconstruct +
   rate control. Target: low-motion nature bandwidth beating Motion-JXL by the §7 margin. *Weeks–months.*
4. **P3 — Prediction model 2 (layered horizontal shift).** 1-D per-band motion estimate + patch copy +
   disocclusion-intra + parallax-depth sidecar. Target: train survey. *Months.*
5. **P4 — Streaming hardening.** Mux/seek/error-resilience/audio; WebCodecs-style player integration.
6. **Parallel track — diagnostic-driven codec levers ("improve the codec" wins).** Independent of phase order
   and of any codec race. **(0) ✔ DONE — 16-bit-offset residual** (replaced wrapping-8bit): flipped noisy
   dashcam delta +45%→−37% and low-motion −55%→−81% (§7b). Then land the bit-sink levers the diagnostic
   ranked (§7): **(a) temporal noise/grain
   model** (~18–48% of delta bits; distribution tier only) — **~80% already built**: JXL's noise-synthesis
   feature (`noise.h` `NoiseParams` 8-pt LUT; `enc_frame.cc:700` estimate/`--photon_noise_iso`/manual →
   `kNoise` flag; `dec_cache.cc:220` `GetAddNoiseStage` synthesises; verified live via `cjxl
   --photon_noise_iso`; the `dec_noise.h:9` "disabled" comment is stale). Video work = **predict/delta in the
   *denoised* domain** (reuse RAW-pipeline `nr_ms`) + carry one ISO-based model per clip (camera-aware — ideal
   for known citizen-science capture) + decoder re-grains per frame. Auto-estimate only ramps in at distance
   ≥1 (`enc_frame.cc:716`), so *lossless/near-lossless keeps real noise* (science tier); synthesis is
   plausible-not-original (distribution tier). **(b) static
   block-skip flag** (~14%; all tiers), **(c) temporal chroma coding** (22% chroma share), **(d) ROI /
   region-adaptive quant** (localized-motion content packs 43–63% of residual energy into 10% of tiles). The
   deepened diagnostic also *simplifies* the design: **single-reference (previous frame) is sufficient — skip
   multi-reference/background modelling.** Each lever is a targeted pipeline addition, flipflop/A-B measurable
   with this harness.
7. **(Deferred — unproven here) C.** General block ME/MC. Per-block MC was *worse* than plain delta on the
   real clip (§7), but that was a noise-dominated, small-motion, *lossless* case — build only if a clean,
   structured, high-motion use-case appears (synthetic-parallax dynamics, not dashcam).

### Lossy streaming tier — landed (after two negative results)

Two approaches that **do not work**, then the one that does:
1. **Residual-image through lossy VarDCT** — the +32768 offset wastes lossy precision, the perceptual model
   *smooths* the residual, and error **accumulates** across the GOP (frame 1 ≈ 21 → frame 4 ≈ 44: prior-frame
   error is re-fed as a residual the codec cannot re-code). Removed.
2. **`JXL_BLEND_ADD`** — verified in `blending.cc:120` to be a *compositing* add (`out = bg + fg` in float):
   the encoder still codes the delta perceptually (same problem), and unsigned pixels can only *brighten*. It
   is **not** inter-frame prediction. JXL has no native motion-compensated residual coding — it is an image
   codec with compositing (blend) + copy (patches), not a hybrid video codec.
3. ✔ **Fresh-pixel REPLACE skip (landed):** `encode_casv_delta_lossy_bbox_rgb8` codes each changed rectangle's
   *actual pixels* (lossy at `distance`); the decoder **overwrites** that region on the reference and copies
   the rest. Coding *real pixels* keeps JXL's perceptual model correct → error is small (~visually-lossless at
   distance 1.0, **vs ~20 for the residual**) and does **not** accumulate; decode is deterministic. Changed
   regions are detected vs the previous *source* frame (comparing to the lossy reference would flag everything
   via quant noise). Beats lossy all-intra by skipping unchanged regions; on noisy content it degrades to
   all-intra (no skip), never worse. This is the streaming tier — lossy decode is ~5× cheaper than lossless
   (~22 ms/f @720p, under the 24fps budget). A **threshold** on change detection skips *near*-static regions
   (tolerate ≤`thresh` difference), which is the enabler on content with any small global flicker/noise.

**Measured (`casv_bench`, distance 1.0, GOP=24, vs lossy all-intra):**

| content | encoder | size | vs lossy-intra | dec ms/f | dec fps |
|---|---|---:|---:|---:|---:|
| low-motion (static seahorse) | lossy-intra | 6.34 MB | — | 20.5 | 48.9 |
| low-motion | replace t0 | 6.20 MB | −2.2% | 15.7 | 63.7 |
| **low-motion** | **replace t6** | **0.38 MB** | **−94.1%** | **1.9** | **533** |
| noisy (dashcam) | replace t6 | 7.07 MB | −1.0% | 20.9 | 47.9 |

**On target (low-motion) content the lossy tier is −94% size AND ~27× faster decode (533 fps).** The
threshold is decisive: exact detection (t0) flags a small global flicker as "all changed" (−2%), while t6
skips it and codes only the moving subject. On noisy content it degrades to ~all-intra (−1%) but still
decodes at 46 fps — never worse. Threshold near-static skip and the real-content lossy bench are **done**.

Remaining: tile-grid form of replace-skip (scattered multi-region change); auto-tuning `thresh` from
`distance`/content; the C++ **native reference-frame** path only matters if true motion-compensated residual
coding is ever needed (JXL has none — §8 findings above).

### Open questions
- Real target resolutions/fps per ShareNat device tier? (sets the WASM feasibility line)
- Live vs on-demand: is any *encode* real-time, or always offline? (affects latency/GOP design)
- Audio required in v1, or video-only first?
- Interop: is a bespoke container acceptable, or must it wrap in standard MP4/WebM for existing players?
- **Fair benchmark:** fetch a real x265/SVT-AV1 build to run the matched-fidelity (near-lossless, 4:4:4)
  comparison — the only meaningful head-to-head — instead of the wrong-regime figures in §7?
