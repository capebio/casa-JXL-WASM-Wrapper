# Design: Populate `docs/1 Headline Features.md` — Comprehensive Themed Rewrite

**Date:** 2026-07-06
**Author:** David (with Claude)
**Target file:** `docs/1 Headline Features.md`

## Goal

Turn `1 Headline Features.md` into a comprehensive, themed catalogue of the project's
notable landed wins. Every claim grounded in git commits / `-DONE.md` handoff docs
(verified during a 6-agent read-only mining pass, 2026-07-06). Existing entries are
preserved verbatim and reorganized under theme headers; ~40 new entries are added.

## Constraints

- **Grounding:** every number/file list is verified-git or verified-doc. Anything the
  mining could not confirm is dropped (see "Dropped/unverifiable" below), not hedged.
- **No duplication:** each win appears once. ORF two-phase decode (`683e4b85`) surfaced
  under both RAW and Decode themes — it lands once, under RAW.
- **Existing text unchanged:** the current entries (16-bit/HDR, preview proxy, lightbox
  fix, CR2 hardening, range windows, megatexture, worker pools, etc.) keep their exact
  prose; only their position changes (slotted under theme headers).
- **Depth policy (chosen):** *full lyrical prose* for headliners (correctness fixes,
  user-visible video/RAW features, the −45% tonemap, the codec paper, the campaign
  overview); *crisp 2–3 sentences* for byte-exact perf micro-wins.
- **Audience:** primarily the product/field-scientist story; developer-facing items are
  included (comprehensive scope) but clustered in the Infrastructure section and labelled.
- **Honesty flags carried into prose:** opt-in/default-off features; native-only tiers;
  audio-drop caveats; research-output-not-app-UI; roadmap-not-shipped.

## Structure

Six themed sections, newest-first within each. Existing entries fold into their theme.

### § 1 — CASAVA Video

New entries (newest-first):

1. **Confidence-scheduled tile admission — bounded bitrate** (`2026-07-06`, `9dad323d`,
   wired `ec998756`/`48b3b9ef`, harness `520ca7b9`). Files: `crates/raw-pipeline/src/casa_video.rs`,
   `bin/casv_encode.rs`, `examples/tile_admission_ab.rs`. Distance-only RC overshoots worst
   1s window 2.5–3.2× of target; tile admission holds it to 1.03–1.06× and encodes ~1.5–1.75×
   faster. **Opt-in** (`RateControl::tile_admission`, default off); SAD-ranked budget admission,
   deferred tiles self-heal against last-*sent* state. Bitstream format unchanged.
2. **Lossless / "no-skip" video now encodes + streaming ffmpeg source** (`2026-07-05`, `9e3e49c2`).
   File: `bin/casv_encode.rs`. Lossless/skip=none previously failed opaquely (streaming path is
   lossy-REPLACE only) → now routed to batch `encode_casv_video`. New `FfmpegPngSource` streams
   ffmpeg stdout via `PngChunker` (proven byte-identical to `split_png_frames`) → ~2 frames
   resident, not the whole clip. **Caveat:** batch/lossless header has no CSAU footer → audio
   dropped with a clear message.
3. **Lazy frame decode — GB → ~2 frames peak memory** (`2026-07-05`, `7c0f124e`). Files:
   `bin/casv_encode.rs`, `casa_video.rs`, `web/casv-lightbox/casv-lightbox.js`. `VideoFrameSource`
   decodes each PNG on demand + drops it (was `frames: Vec<Vec<u8>>` holding all). New streaming
   encode proven byte-identical to slice path. Plus PID-suffixed audio temp (concurrent-encode
   fix) and `probe_frame_count()` → determinate extract progress.
4. **Video-codec SIMD + square residual atlas (byte-exact)** (`2026-07-05`, `ece7dc48`). File:
   `casa_video.rs`. `any_exceeds()` AVX2 change-detection **6.55× low-motion / 1.12× high @720p**;
   `add_residual16_run()` decode residual-add **2.59×**; v2 square atlas extended to lossless tier
   (real motion −2.4% size + 1.22× enc). First SIMD in the codec; scalar fallback bit-identical;
   browser unaffected (native-only decode).
5. **Multi-threaded streaming I-frame encode** (`2026-07-05`, `ac19b268`). Files: `casa_video.rs`,
   `examples/casv_mt_flip.rs`. All-intra GOP1 **1.49×**, low-motion GOP24 1.12×, 4K low-motion 1.21×;
   byte-identical across thread counts. Threading attached only to the reliably-large I-frame;
   changed-tile P-frame left single-threaded (CV-E6 blanket-MT loss re-confirmed).
6. **Instant first-frame lightbox playback** (`2026-07-05`, `8f2181e1`). Files:
   `web/casv-lightbox/casv-lightbox.js`, `casv-platform.js`. Paint frame 0 as soon as `playCasv`
   yields → startup O(frame_count) → O(1 I-frame decode). Prewarm JXL WASM at `mount()`; audio
   decode moved off first-paint path.
7. **Desktop encode UX pass** (`2026-07-05`, `a01fdc27`/`c52bbedd`/`25878bd4`/`6b095784`). Files:
   `bin/casv_encode.rs`, `web/casv-lightbox/*`, `TAURI_WIRING.md`. `CASVENC <stage> <done> <total>`
   stderr progress protocol → determinate bar; live PNG-count during extract (no more "hung"
   look); in-panel debug Console + 3s heartbeat (no devtools in Tauri); MOV end-to-end; default
   output name `holiday.mp4 → holiday.mp4.casv`.
8. **CSAU audio track — end-to-end** (`2026-07-03`, `72bbcf6c`/`51bb2d37`/`74dd4d38`/`c71729ac`).
   Files: `casa_video.rs`, `bin/casv_encode.rs`, `packages/casv-web/src/index.ts`,
   `web/casv-lightbox/casv-lightbox.js`. New `CSAU` box carries Ogg/Opus, spliced between CASR box
   and 32-byte footer (legacy readers unaffected). Sidecar `--video` extracts + embeds; casv-web
   `parseCasvAudioBox` + `CasvReader.audio`; lightbox WebAudio A/V-synced playback + volume.
9. **JOLT rate control — bitrate-targeted streaming (VBV)** (`2026-07-03`, `49011f04`; branded
   `05adabaa`). Files: `casa_video.rs`, `examples/jolt_rc_demo.rs`, `docs/jolt-lossy-video.md`.
   Leaky-bucket VBV + damped multiplicative distance update per GOP; 0.5× target walks
   3245k→1392k B/s, 2× target hits 94% by GOP 4. Presets: Realtime 3.0% of raw @ 55fps, Balanced
   5.2% @ 42fps, Quality 8.1% @ 53fps — all decode real-time. Fixed-distance default bit-identical.
10. **Browser playback for CASAVA / JOLT `.casv`** (`2026-07-03`, `21067c30`). Files:
    `packages/casv-web/src/index.ts`, `examples/casv_web_fixtures.rs`. `@casabio/casv-web` decodes
    `.casv` in-browser via any injected single-frame JXL decoder (zero hard deps). 8 bun tests vs
    native: RGB within max 3 / mean 1.0. Lossless-residual + Fable tiers guarded out (native-only).
11. **CASAVA lightbox + native `casv_encode` sidecar** (`2026-07-03`, `7eb9b526`/`aa948fc2`). Files:
    `web/casv-lightbox/*`, `bin/casv_encode.rs`. File-picker viewer (play/step/scrub/speed/loop/export)
    + encode panel wired to Tauri; DOM-free core 11/11 tests. Sidecar exists because the Tauri app's
    `raw-pipeline` is a diverged same-named crate.
12. **JE-8 square-atlas (v2) layout for lossy tile P-frames** (`2026-07-03`, `a7edc207`). Files:
    `casa_video.rs`, `examples/atlas_v2_flip.rs`. 48 real 720p frames, t=16: size **−6.5%**, encode
    **−61.1%**, decode −41.8%. Packs changed tiles ~square (`ceil(sqrt(n))` cols) instead of a
    t-wide sliver that starved libjxl's group parallelism. v1 payloads still decode.
13. **FableBraid — braided-rANS lossless codec + CASV Fable tier** (`2026-07-02`, `434237c7`). File:
    `casa_video.rs` (+ `fable_braid`). Whole-clip lossless decode vs JXL bbox e3: BBB **15.7×**
    (+5.8% bytes), Sintel 13.6× (−29.4%), ToS 7.3× (−5.4%). 8-lane braided rANS (ILP-bound, not
    chain-bound) replaces the bit-serial modular loop for lossless tiers. Native-only decode.

Existing entry folded here: **preview proxy + 5× encoder slowdown fixed** (already written).

### § 2 — Codec Comparison & the Format Paper

Preface line: these are **research outputs** (SVG figures + HTML galleries + TOON/JSON),
auto-delivered to `C:\Foo\Jose\Submissions\JXL\...`, not app UI.

1. **The comprehensive unattended full suite (Part 3)** (`2026-07-05`, `826dc020` + 16-bit
   `397a254b`/`67792dca`/`b7baa0e5`, summary `608dfe45`). Files: `CodecPaperFullTest.mjs`,
   `benchmark/codec-paper-figures-full.mjs`, `rd-sweep.mjs`, `bd-rate.mjs`, `metrics16.mjs`.
   Corpus 24 Kodak + 6 RAW-derived, 9 codecs, **18 SVG figures**. **BD-rate (butteraugli) vs JPEG:
   jxl −44.0%, avif −47.5%, webp −33.9%.** Per-file JXL saving 21–50% Kodak, **49–72% RAW-derived**.
   PSNR BD-rate confirms ranking. Crash-safe: checkpoints + re-delivers after every image; `LIMIT`
   smoke; `data.json` full dump.
2. **JXL bitstream conformance / interop proof** (`2026-07-05`, `5b341ae2`). File:
   `CodecConformanceTest.mjs`. Cross-decode ours↔reference-libjxl, declared CONFORMANT within
   0.3 butteraugli of same-impl decode; run verdict: all conformant. Proves our speed-optimized
   fork still emits *standard* JXL any decoder reads.
3. **RD paper suite (Part 2) — ours vs original libjxl headline** (`2026-07-04`→`07-05`,
   `db283f2c`/`cd095f59`/`8479e951`/`93b1540b`). Files: `CodecPaperTest.mjs`, `rd-sweep.mjs`,
   `bd-rate.mjs`, `svg-figures.mjs`. At matched effort 3, butteraugli ≈1.5: **our WASM JXL vs stock
   `@jsquash/jxl` = 2.1× faster encode, 2.6× faster decode, 105% size (+4.6%).** New pure modules:
   trapezoidal Bjøntegaard BD-rate, RD-sweep, SVG figures.
4. **Matched-quality comparison foundation (Part 1 / PR #11)** (`2026-07-04`, design +
   `068504a8`/`3f95bebb`/`9af0e335`/`376b0421`, merged `55e06413`). Files: `CodecCompareTest.mjs`,
   `codec-adapters.mjs`, `butteraugli-search.mjs`. JXL anchored at distance 1.0; every other codec
   binary-searched to match per-file butteraugli (±0.15), then flip-flop timed. Finding: JXL
   smallest; AVIF the only size rival (BD-rate jxl-vs-avif +9.5%).
5. **Fair-comparison integrity (gotchas → features)** (`2026-07-04`→`05`, `3d74f361`/`71308410`/
   `068504a8`/`826dc020`/`608dfe45`). Files: `codec-adapters.mjs`, `codec-compare-jxl.mjs`,
   `CodecPaperFullTest.mjs`. JPEG forced 4:4:4 (no unfair 4:2:0 penalty); quality ruler =
   standard-scale butteraugli (not the ~10×-compressed `PerceptualComparer`); verified-lossless
   gate (butteraugli <0.05, PNG-16 MAE=0); ±σ error bars (N=3); PSNR BD-rate matrix added.

Existing entry folded here: **16-bit / HDR full-bit-depth comparison** (already written).

### § 3 — RAW Decode Pipeline

Headliner + correctness first; byte-exact micro-wins get tight prose.

1. **★ wasm tonemap SIMD — −45% RAW decode** (`~2026-06-16`, `8c2754f2`/`0eb74e40`). Files:
   `crates/raw-pipeline/src/tone_simd.rs`, `pipeline.rs`, `src/lib.rs`. 8-file test: **AvgRawMs
   1815→992 (−45%)**, tonemap 942→429 (−54%). Tonemapping was ~45–55% of RAW decode and ran fully
   scalar in-browser; a ~60-line f32x4 SIMD128 body + routing halves it. Same path backs editor
   sliders → every lightbox tweak cheaper. Largest RAW-decode speedup on record. (full prose)
2. **Canon CR2 crop rectangle fixed** (`2026-07-02`, `368200e4`/`df885435`, shipped `c6816e0e`).
   File: `crates/raw-pipeline/src/cr2.rs`. **All 11 fixtures were center-cropped wrong** — origin
   off by 72/132 columns; output included optical-black masked pixels and dropped equal live width.
   Now parses Canon MakerNote SensorInfo (0x00E0). Also sets true CFA phase (avoids up to 3 demosaic
   retries). User-visible framing/color fix. (full prose)
3. **pipeline black-frame bug fixed** (`2026-06-30`, `4b62215f`/`bd0f5b3f`). File: `pipeline.rs`.
   Identity-resize (`n_px==1`) made `(1<<64)/1` wrap to 0 → whole frame black. Fixed with
   remainder-correction + 2 regression tests. Plus process-wide `OnceLock` PerceptualGrid. (full prose)
4. **MHC AVX2 quality demosaic 2×** (`2026-07-03`, `edad188b`). File: `demosaic.rs`. Gradient-corrected
   MHC demosaic **+54.2% (2.18×) @24MP**, bit-identical across 7 sizes × 4 CFA phases. Native only;
   overturns an earlier "MHC SIMD memory-bound" rejection. (tight)
5. **Thumbnail/preview downscaling SIMD** (`2026-07-01`/`07-03`, `f02cd76b`/`08b3e496`/`406269a6`).
   Files: `src/lib.rs`, benches. RGB box-sum wasm128 **1.56–2.07× in-browser**; RGBA fast path up to
   **+62.8% (8×)**; byte-exact. Speeds every RAW's preview/thumbnail paint. (tight)
6. **ORF two-phase decode — previews first** (`2026-07-02`, `683e4b85`). Files: `web/worker.js`,
   `web/main.js`, `web/two-phase-raw.test.js`, `src/lib.rs`. Phase-1 previews-only (ORF strip-streamed
   superpixel) posts immediately; phase-2 full-res. Byte-exact (render SHAs identical). DNG/CR2
   excluded by design. (full prose — user-visible first-paint)
7. **CR2 fused reassembly+crop + monomorphized `decode_c4`** (`2026-07-02`,
   `e43cd578`/`18751f04`/`848a2e77`). Files: `cr2.rs`, `ljpeg.rs`. Fused reassemble+crop **−6.3% owned
   / −11.3% warm scratch**; `decode_c4` **−8.5%** on cps=4 strip. Byte-exact, 11/11 fixtures. (tight)
8. **ORF decompress — u64 wide refill + north-load hoist** (`2026-07-01`, `31bf5ad9`/`873e6d5b`).
   File: `decompress.rs`. Native wide refill **−6.0…−8.9%**, north-hoist −4.4…−4.6%, byte-exact;
   wasm keeps byte loop. Plus malformed-payload guards. (tight)
9. **`jxl_casadecoder` — dead-work removed on 5 seams** (`2026-07-01`, `f0fceb84`). File:
   `jxl_casadecoder.rs`. Drops discarded clones/extra-channel decodes/whole-frame re-alloc; honors
   `num_threads`; byte-exact 23/23. Also clears caller buffer on error (no uninitialized bytes). (tight)
10. **CR2 LJPEG — fast 8-bit table + bulk refill** (`2026-06-30`, `73e100b1`/`cad79525`/`eee8564f`).
    File: `ljpeg.rs`. **AvgLJPEG −9.1% (386→351ms)**; LJPEG is ~96% of CR2 decode. 256-entry
    branchless table + 4-byte bulk fill; byte-exact. (tight)
11. **`frame_stats` — exact u64 luma + AVX2 register reduction** (`2026-06-30`, `0012d7a8`/`d82fe6e8`).
    File: frame-stats kernel. u64 sums (drop Kahan) **scalar −34…−36%**, now bit-identical for every
    input by construction; madd→hadd removes a store-to-load stall. (tight)
12. **Planar RGB16 demosaic SIMD (3-store)** (`2026-06-13`, `DemosaicSimdPlanarShuffleStore-DONE`).
    File: `demosaic.rs`. Planar bilinear **1.58–1.69×** (thumb/lightbox/20MP), bit-exact; interleaved
    variant B rejected at ~0.98×. (tight)

Existing entries folded here: **CR2 decoder hardened** (BlackLevel + memory 70→36MB + 4 crash
guards), **trustworthy RAW benchmark**, **resumable byte-range fetch** (already written).

### § 4 — Decode & Viewer Pipeline

1. **Warm-start the decode stack — prewarm WASM (TTFP)** (`2026-07-02`, `635f4bbe`/`4c1cebdb`).
   Files: `web/main.js`, `web/worker.js`, `context-base.ts`, `scheduler.ts`, `jxl-worker-browser/worker.ts`.
   Module import + `init()` + `initThreadPool` moved out of the first file task into a fire-and-forget
   `PRELOAD`; `prewarmSize` wired (was dead). First click paints sooner; self-healing retry. (full prose)
2. **Zero-copy progressive paints — drop per-pass readback** (`2026-07-02`, `5d1e9c5f`). File:
   `web/main.js`. Each progressive pass did `getImageData(full canvas)` = GPU→CPU sync + fresh
   **~80MB alloc @20MP**; the put covers the whole canvas so the readback was redundant — now reuse
   held `ImageData`. Smoother refinement, far less churn. (full prose)
3. **Prefetch-cache fusion** (`2026-07-02`, `351c27a7`). File: `web/main.js`. Post-encode thumb decode
   (previously discarded) now also fills the lightbox prefetch cache when the card is in-neighbourhood
   → one full-res decode saved; out-of-neighbourhood cards keep no-cache. (tight)
4. **Responsive gallery / progressive-paint under big batches** (`2026-07-02`, merge `c071f793`).
   Files: `web/main.js`, `jxl-progressive-*.js`, `web/lightbox/*`. O(N²)→O(N) measurement build; ring
   `slice` not `splice`; cached cell map per rAF; DOM log bounded to 200; debounced statsLog; Welford
   online variance (fixes float64 loss >2MP). Batch UI stays flat + stats accurate. (tight)
5. **Progressive-paint page speedup (A1–A4)** (`2026-06-06`,
   `HANDOFF-progressive-paint-speedup-A3-A4-DONE`). File: `web/jxl-progressive-paint.js`. Removed
   artificial sleeps; rAF-coalesced paints; persistent canvas + thumb `Map` (no per-pass alloc);
   gated per-pass stats behind `?stats=1`. (tight)
6. **FINDING — the "~15% WASM decode regression" was measurement artifact** (`2026-06-30`). Evidence:
   `packages/jxl-wasm/test/dec-baseline-flipflop.mts`, `dec-suspect-bisect.mts`. The scare came from a
   throttled machine (times ~2× inflated); re-measured quiet, NEW ≤ OLD on a real 5240×3912 photo
   (+1.2% then −4.3%, straddles zero). The dec_ans inline is a tiny-image-only tradeoff. Lesson: gate
   decode opts on interleaved, real-photo-sized flipflop runs. (full prose — notable finding)

Existing entries folded here: lightbox progressive-decode format fix / two-photos-collide; megatexture
streaming engine; live viewport `setPriority` steering; self-healing bounded-memory worker pools;
symmetric non-owning view transfers (jxl-worker-node); "just give me size freezes"; image-engine
5 repairs; 9× lookup-table quality scoring; broken quality alarm; deterministic procedural fixtures +
SHA-256 corpus; zero-copy local range windows (already written).

### § 5 — The Compression Engine: A Byte-Exact Speed Campaign

One consolidated headline entry (full prose overview) + 4 bucket paragraphs (tight).

Overview: **~103 `perf(...)` commits across ~40 codec files, Jun 22 – Jul 3 2026**, in the
`capebio/libjxl` fork (`external/libjxl-012`). *Every pass bitstream-identical* — same file out,
same quality, only faster. Safety proven, not asserted: flipflop interleaved A/B (start-rotation
cancels thermal drift) + SHA256 old-t0==new-t0 gates, verified on **native AVX2 *and* WASM SIMD128**.

- **Bucket A — entropy-coding & clustering (+ MT).** enc_ans (×6), ans_common, enc_cluster,
  enc_context_map, enc_huffman, dec_ans, ChooseUintConfigs, ANS reverse-map, entropy-MT serial-tail.
  Headline: **EncodeGroups 57.3→46.8 ms = 1.22×** (8 threads) by parallelizing the histogram-build
  tail while keeping every ordering decision serial. ~22 passes.
- **Bucket B — quantization & adaptive-quant.** enc_aq, quant_weights, quantizer, compressed_dc,
  enc_ac_strategy, ac_strategy coeff-order. enc_aq FuzzyErosion 36→16 loads (byte-exact on 8 RAW);
  acs scratch 1.5MiB→96KiB; coeff-order exact-rect traversal 2–4×. ~11 passes.
- **Bucket C — perceptual & color kernels.** butteraugli SIMD **native −48..53% / WASM −33..48%**
  (diffmap FNV + score bits match 25/25 native + 63/63 WASM); conv5 +31–49%; cms interleave ~22%;
  enc_xyb copy-elim. Honesty: butteraugli hotpath was reverted for WASM incompat, then re-landed
  scalarized for EMU256 — "verify on both targets or don't ship." ~11 passes.
- **Bucket D — lossless, transforms & decode/render.** enc_lz77 (~1.42×, 0/160680 mismatch),
  enc_fast_lossless, enc_patch, enc_modular (~+5.7%), enc_group, dct/enc_transforms, and the
  dec_group/dec_ans/dec_ext/dec_cache/render_pipeline decode sub-campaign. ~30 passes.

One-offs worth a callout: **enc_patch lossless decode-skip** — for a losslessly-coded patch atlas,
skip the encode→decode round-trip; proven with full native cjxl/djxl A/B (bitstream SHA-identical,
decoded OLD==NEW==original, DecodeFrame branch probe = 0). And the **honesty gems**: several plausible
opts were *rejected for measuring slower* — W1 SIMD-precompute WriteTokens = **0.84× (20% slower)**,
compressed_dc X-zero regression, enc_transforms DCT4X8 sink −10% — all documented, shipped nothing.
Proof the byte-exact + flipflop gate had teeth.

### § 6 — Reliability, Memory & Build Infrastructure

Developer-facing; clustered and labelled. Shipped first, then a clearly-marked roadmap, then
design artifacts.

Shipped:

1. **Weekly multi-branch integration discipline** (`2026-07-06` latest; prior 07-01/02/02b/03).
   Dozens of parked perf branches folded onto two clean heads (super + libjxl submodule),
   conflicts resolved + documented. Jul06: `origin/main=09df2547`. (tight)
2. **Build-pipeline hardening — the build stopped lying** (`2026-06-11`→landed,
   `HANDOFF-build-mjs-...-DONE`). `build.mjs` couldn't execute at all (stray TS in a `.mjs`); manifest
   advertised stale tiers + fake `pgo.enabled`. Fixed: parse/export verification, size budgets with
   teeth, sha256+SRI+Brotli stamping, per-role wasm-opt, Docker layer-baking, real two-pass PGO gated
   ≥2%. Provenance-stamped, hermetic. (full prose — "build provenance is data provenance")
3. **Node worker lifecycle correctness + crash detection** (`2026-06-12`→landed,
   `HANDOFF-jxl-worker-node-...-DONE`). Fixes: session-id poisoning, generation race clobbering a
   successor's chunks, worker crash masquerading as graceful shutdown (now `WorkerCrashed`), honest
   pause. (tight)
4. **Branch-consolidation audit (29-agent, read-only)** (`2026-07-01`). Merge-order plan for ~27
   parked branches; notably *debunked* a phantom `jxl_casaencoder` "corruption on realloc" via a TDD
   characterization test that passes on unmodified main. (tight; grounding: memory-only — ledger is
   an external worktree)
5. **Toolchain + fork notes (compact).** MSVC default (GNU broken — `dlltool` missing); hard rule to
   ship the bridge against `external/libjxl-012`, not the 0.11.2 test clone (manifest now records the
   real source HEAD); c-perceptual WASM link break root-caused (AVX2-only symbol, correct build is
   `-Features parallel-wasm`). (tight)

On the Roadmap (design written 2026-07-06, **not yet shipped**):

6. **Pipeline restructure K1–K6** (`HANDOFF-pipeline-restructure-2026-07-06.md`). One decode spine
   (`decode_raw()` + `RawRowSource` row-bands; CR2 resident-mosaic ~48MB+band vs ~264MB), one
   progressive encode → tiers as byte ranges (3→2 encodes), `FramePipeline` buffer owner,
   `RawVideoSource` (RAW time-lapse → CASV), streaming-only video, single-source FFI/CASV contracts.
7. **Crate unification S1** (`HANDOFF-S1-crate-unification-2026-07-06.md`). Three diverged copies of
   `raw-pipeline`; ~10 holo worktrees with wins stranded on the old lineage. G1 = reversible measured
   parity trial via additive `pub use` shims → report, then stop.
8. **Wave-2 strategic map S1–S6** (`STRATEGIC-MAP-wave2-2026-07-06.md`). Consume side: fork
   unification, one browser delivery engine, memory-governed `AssetStore` (~360MB @24MP → one
   LRU/quota owner), fuzz+golden-SHA hardening, scene-referred colour, LOD/ROI unification.

Design / research artifacts:

9. **CASAVA "JXL as a video codec" design doc** (`docs/superpowers/specs/2026-07-01-jxl-video-codec-design.md`).
   JXL transform+entropy backend + pluggable prediction front-end. Doc is the roadmap; the codec
   itself is largely shipped (see § 1). Honest non-goals: no HW decode; won't beat VVC/AV1 on
   high-motion.
10. **"The CasaWASM Media Engine" — JOSE wins paper** (`C:\Foo\Jose\Features and Wins\`, HTML+LaTeX+PDF).
    20 perf / 10 memory / 10 feature wins; Opus audio presented as designed-not-coded. (grounding:
    memory-only — artifact outside this repo)

Existing entries folded here where they fit (worker pools, view transfers, corpus already listed
under § 4 — keep them in § 4; § 6 does not duplicate).

## Dropped / unverifiable (deliberately excluded)

- **Part-1 "AVIF 8–12× slower encode"** — mining could not confirm from source or delivered figures;
  the "AVIF only size rival" claim is kept (verified via BD-rate +9.5%).
- **Alpha-progressive / paint-target progressive schedule** — committed on a branch, not merged, and
  a no-op for this app (RAW→JXL is RGB16 no-alpha; viewer uses multi-tier blobs). Excluded from
  headlines.
- Pure demo/evidence harnesses (`yt-testbed.mjs`, `tile_admission_ab` demo page) — not product
  features; may appear as a one-line "how we validate" aside at most.

## Success criteria

1. File opens with a short orienting header, then the 6 themed sections in the order above.
2. Every existing entry present, text unchanged, under the correct theme.
3. ~40 new entries added, each with its date and (where the existing style uses it) a *Files:* line.
4. Every number traceable to a commit sha or `-DONE.md` doc named in this spec.
5. Honesty flags present: opt-in, native-only, audio-drop, research-output, roadmap-not-shipped.
6. No win appears twice (ORF two-phase once, under RAW).
7. Depth policy honoured: full prose for headliners, 2–3 sentences for byte-exact micro-wins.

## Out of scope

- Rebuilding/re-running any benchmark (numbers are quoted from committed A/B runs).
- Touching any code, build, or the libjxl submodule.
- Editing other docs.
