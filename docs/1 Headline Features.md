# CasaWASM — Headline Features

> A JPEG XL & RAW converter for the field: camera RAW in, perceptually-tuned JXL out, decoded live in the browser — and a video codec built on the same engine.

This is the catalogue of what shipped and why it matters. It is written to one rule: **every number is traceable.** Each claim points to a commit, a file, or a `-DONE.md` handoff. Where we couldn't verify a figure, we dropped it rather than dress it up. Where we tried an optimization and it measured *slower*, we say so and we shipped nothing. That discipline is the point — a features list you can audit is worth more than one you have to trust.

## Contents

- [At a Glance](#at-a-glance) — the marquee numbers
- [How to Read This](#how-to-read-this) — flags, method, provenance
- [1. CASAVA Video](#1-casava-video) — the JXL-backed video codec, encoder, and lightbox
- [2. Codec Comparison and the Format Paper](#2-codec-comparison-and-the-format-paper) — how JXL measures up
- [3. RAW Decode Pipeline](#3-raw-decode-pipeline) — ORF / CR2 / DNG → pixels
- [4. Decode and Viewer Pipeline](#4-decode-and-viewer-pipeline) — the browser decode stack and gallery
- [5. The Compression Engine](#5-the-compression-engine) — the byte-exact speed campaign
- [6. Reliability, Memory and Build Infrastructure](#6-reliability-memory-and-build-infrastructure) — the parts that hold it together
- [7. BLISS: Instant Local Preview Cache](#7-bliss-instant-local-preview-cache) — the OPFS instant-preview codec and three-format model
- [8. The Web Application](#8-the-web-application) — the gallery, editor, export, timelapse and ID product layer
- [How We Keep Ourselves Honest](#how-we-keep-ourselves-honest) — the method, in full

## At a Glance

| Result | What moved | Where |
|---|---|---|
| **−45%** | in-browser RAW decode, whole-file (tonemap SIMD) | [§ 3](#3-raw-decode-pipeline) |
| **−48…53%** | perceptual Butteraugli kernel, native (−33…48% WASM) | [§ 5](#5-the-compression-engine) |
| **1.22×** | JXL entropy encode — `EncodeGroups`, 8 threads, byte-exact | [§ 5](#5-the-compression-engine) |
| **2.1× / 2.6×** | our JXL encode / decode vs. stock `libjxl`, matched quality | [§ 2](#2-codec-comparison-and-the-format-paper) |
| **−44%** | JXL bytes vs. JPEG at equal quality (BD-rate, Butteraugli) | [§ 2](#2-codec-comparison-and-the-format-paper) |
| **4.09×** | video preview-proxy encode — and 76% smaller | [§ 1](#1-casava-video) |
| **15.7×** | FableBraid lossless video decode vs. JXL-e3 | [§ 1](#1-casava-video) |
| **9×** | image-quality scoring, exact same numbers (lookup table) | [§ 4](#4-decode-and-viewer-pipeline) |
| **70 → 36 MB** | Canon CR2 peak decode memory (crop in place) | [§ 3](#3-raw-decode-pipeline) |
| **~103** | byte-exact compression-engine passes — same bytes out, only faster | [§ 5](#5-the-compression-engine) |
| **~10×** | BLISS cached-preview decode vs cold RAW re-decode (codec time, scalar WASM) | [§ 7](#7-bliss-instant-local-preview-cache) |
| **multi-GB** | gigapixel scans panned as 512-px JXL tiles — viewport-only decode, never the whole frame | [§ 4](#4-decode-and-viewer-pipeline) |
| **−74…98%** | browser-decode boundary waste removed (owned-copy / final flush / input memcpy) | [§ 4](#4-decode-and-viewer-pipeline) |
| **opt-in** | noise-aware RAW denoise from a measured sensor model, never an ISO guess | [§ 3](#3-raw-decode-pipeline) |
| **8 formats** | browser ingest beyond RAW+JXL — PNG/JPEG/GIF/WebP/AVIF/TIFF/EXR, bit-depth aware | [§ 3](#3-raw-decode-pipeline) |

## How to Read This

**Flags** appear inline on entries that carry a caveat:

- **opt-in** — off by default; you turn it on.
- **native-only** — runs in the native desktop path, not the browser WASM build.
- **research output** — figures and data files (for the format paper), not app UI.
- **roadmap** — designed and written up, not yet shipped.

**How the numbers were taken.** Every speed claim in the compression engine (§ 5) and most in the RAW and video paths was gated by an *interleaved flip-flop* A/B run — old and new variants alternate with start-rotation so thermal drift cancels — plus a SHA-256 check proving the output bytes are identical. Perf that isn't byte-exact is proven by a quality metric (PSNR / SSIM / Butteraugli) with a stated tolerance. Where it mattered, the same change was verified on **both** native AVX2 and WASM SIMD128, because a win on one target is not a win on the other.

**Provenance note.** A handful of established viewer, scheduler, and infrastructure capabilities — range windows, megatexture streaming, priority steering, worker pools, node transfers, the test corpus — predate the July 2026 grounding pass. Their *mechanisms* are described from current source (files are cited); their headline *figures* are as originally reported by the work that shipped them, not re-measured here. They are called out where they appear.

Within each section, entries run newest-first, except where a section leads with its single biggest win.

---

## 1. CASAVA Video

CASAVA is the project's JPEG-XL-backed video codec — lossless and lossy tiers, encoded by a native Rust sidecar, decoded in the browser by `@casabio/casv-web`. This section covers the codec, the encode toolchain, and the browser lightbox.

### Confidence-Scheduled Tile Admission — Bounded Bitrate (2026-07-06)

*Files: `crates/raw-pipeline/src/casa_video.rs`, `bin/casv_encode.rs`, `examples/tile_admission_ab.rs`*

**opt-in** (`RateControl::tile_admission`, default off). Distance-only rate control lets the worst one-second window overshoot the target by 2.5–3.2×; tile admission holds it to **1.03–1.06×** and encodes **~1.5–1.75× faster** by declining to spend bits on low-value tiles. A SAD ranking picks the tiles most worth encoding within each GOP's budget; tiles deferred by the budget self-heal against the last *sent* reference frame, so they always predict from what the decoder actually has — even after several skips. The bitstream format is unchanged; existing decoders read tile-admitted `.casv` files as-is.

### Lossless / "No-Skip" Video + Streaming ffmpeg Source (2026-07-05)

*Files: `bin/casv_encode.rs`, `casa_video.rs`*

Lossless and `skip=none` video previously failed opaquely — the streaming path is REPLACE-only and can't express those modes. The encoder now detects the combination and routes it to the batch `encode_casv_video` path. A new `FfmpegPngSource` replaces the old whole-clip-in-RAM buffer: it streams ffmpeg's stdout through a `PngChunker` (proven byte-identical to `split_png_frames`), so ~2 frames are resident at once regardless of clip length. **Caveat:** the batch/lossless header has no CSAU footer, so audio is dropped — with a clear message rather than a silent loss.

### Lazy Frame Decode — Gigabytes → ~2 Frames Peak Memory (2026-07-05)

*Files: `bin/casv_encode.rs`, `casa_video.rs`, `web/casv-lightbox/casv-lightbox.js`*

`VideoFrameSource` used to decode the entire clip into a `Vec<Vec<u8>>` before encoding began — a long clip meant several gigabytes resident. It now decodes each PNG on demand and drops it immediately after use; the streaming encode is proven byte-identical to the prior slice-at-a-time path. Two fixes rode along: PID-suffixed audio temp files (fixes concurrent-encode collisions) and `probe_frame_count()` for a determinate extract progress bar.

### A Fast, Full-Size "Preview Proxy" for Video Editing — and a 5× Encoder Slowdown Fixed Underneath (2026-07-05)

*Files: `crates/raw-pipeline/src/jxl_casaencoder.rs`, `crates/raw-pipeline/src/casa_video.rs`, `crates/raw-pipeline/src/bin/casv_encode.rs`, `web/casv-lightbox/*`*

Editing a CASAVA video wants a lightweight stand-in you can scrub through instantly — without paying to encode the full-quality file every time you nudge something. The new **preview proxy** is exactly that: a version of the clip that stores a half- or quarter-resolution picture inside, but still declares the *full* frame size, so it decodes back to full size and lines up pixel-for-pixel with the finished video. Because every frame stands entirely on its own, you can jump to any point in the timeline with zero wait. And because the encoder only ever touches a quarter (or a sixteenth) of the pixels, the proxy is far quicker to make. On a 1280×720, 48-frame clip: the half-size proxy encodes **2.18× faster and is 51% smaller**; the quarter-size proxy is **4.09× faster and 76% smaller** — and both decode back to the full 1280×720 through the exact same viewer path as a normal file, so nothing downstream has to change.

Getting there meant fixing a genuinely backwards result underneath. The obvious way to make a smaller file is to ask the JPEG XL library to downsample the picture for you — but measured head-to-head, that built-in path was about **five times *slower* than encoding the picture at full size**, which is absurd for coding a quarter of the pixels. The library, handed a full-resolution image, was running an expensive full-resolution "fitting" pass before shrinking. We now do it the other way around: shrink the picture ourselves with a cheap pixel average, hand the library the already-small image, and mark it "already downsampled" so the decoder upsamples it back on the way out. Same file size, same quality — but the encoder never sees the big picture, so a **0.2× slowdown became a 2.4× speedup**, with the output matching the slow path to a fraction of a decibel.

A fair question is why not just use the "free" low-resolution preview that JPEG XL already produces — the so-called DC image, a one-eighth-size thumbnail that falls out of a normal encode at no extra cost. The answer is that the DC image is only free *if you are already encoding the full-quality file*, and during editing that full encode is precisely the slow thing you are trying to avoid. It is also very coarse (one-eighth size, and blocky) — fine for a tiny thumbnail, too rough to scrub against. The proxy wins in the exact situation editing puts you in: you are skipping the full encode, and you want a crisp half-size working copy you can navigate frame-accurately. The two are complements, not rivals — the DC thumbnail for a free preview at final export, the proxy for the working copy while you edit.

The change is deliberately safe: asked for a downsample factor of 1 it produces byte-for-byte the same file as before, so it cannot alter existing output; each proxy frame was verified to decode to the full declared size and to be independently seekable. Forty-one video-codec tests and twenty-one lightbox tests pass, and the speed figures above come from interleaved back-to-back timing runs recorded alongside the code. It is wired end to end — through the desktop encoder (a `proxy2` / `proxy4` mode) and the lightbox's one-click **Preview proxy** button.

### Video-Codec SIMD + Square Residual Atlas, Byte-Exact (2026-07-05)

*Files: `crates/raw-pipeline/src/casa_video.rs`, `examples/atlas_v2_flip.rs`*

**native-only decode.** The first SIMD in the CASAVA codec. `any_exceeds()` AVX2 change-detection: **6.55× faster on low-motion content, 1.12× on high-motion @ 720p**. `add_residual16_run()` decode residual-add: **2.59×**. The v2 square-atlas layout was extended from the lossy tier to the lossless tier — on real structured motion, **−2.4% size and 1.22× encode**; on random-noise content, +0.8% / 1.19×. The scalar fallback is bit-identical; browser playback is unaffected.

### Multi-Threaded Streaming I-Frame Encode (2026-07-05)

*Files: `casa_video.rs`, `examples/casv_mt_flip.rs`*

All-intra (GOP=1) streaming encode: **1.49×**; low-motion GOP=24, 1.12×; 4K low-motion, 1.21×. Output is byte-identical across thread counts. Threading is attached only to the reliably-large I-frame — the changed-tile P-frame stays single-threaded, after CV-E6 blanket-MT testing re-confirmed a loss on the small sub-group atlases.

### Instant First-Frame Lightbox Playback (2026-07-05)

*Files: `web/casv-lightbox/casv-lightbox.js`, `casv-platform.js`*

Playback used to decode every frame before painting anything. It now paints frame 0 the moment the first decode yields, turning startup latency from O(frame count) into O(1 I-frame decode). JXL WASM is prewarmed at `mount()` instead of on first play, and audio decode is moved off the first-paint path.

### Desktop Encode UX Pass (2026-07-05)

*Files: `bin/casv_encode.rs`, `web/casv-lightbox/*`, `TAURI_WIRING.md`*

The sidecar emits `CASVENC <stage> <done> <total>` on a stable stderr protocol, wired to a determinate progress bar. A live PNG count during extraction ends the "hung at 0%" look; an in-panel debug Console with a 3-second heartbeat replaces devtools (which Tauri's embedded WebView doesn't offer). MOV encodes end to end, and the default output name derives from the input (`holiday.mp4 → holiday.mp4.casv`).

### CSAU Audio Track — End to End (2026-07-03)

*Files: `casa_video.rs`, `bin/casv_encode.rs`, `packages/casv-web/src/index.ts`, `web/casv-lightbox/casv-lightbox.js`*

A new `CSAU` container box carries an Ogg/Opus stream, spliced between the CASR box and the 32-byte footer so legacy `.casv` readers skip it cleanly. The `casv_encode --video` mode extracts the input's audio and embeds it; on decode, `casv-web` exposes `parseCasvAudioBox` and `CasvReader.audio`, and the lightbox drives WebAudio for A/V-synced playback with a volume control. This closes the format's last gap: CASAVA clips now carry sound from desktop encode all the way to browser playback.

### JOLT Rate Control — Bitrate-Targeted Streaming (VBV) (2026-07-03)

*Files: `casa_video.rs`, `examples/jolt_rc_demo.rs`, `docs/jolt-lossy-video.md`*

JOLT adds a leaky-bucket VBV with a damped multiplicative distance update per GOP. At 0.5× target the encoder walks 3245 → 1392 kB/s over four GOPs; at 2× target it reaches 94% of target by GOP 4. Measured presets: **Realtime 3.0% of raw @ 55 fps, Balanced 5.2% @ 42 fps, Quality 8.1% @ 53 fps** — all decode in real time. The fixed-distance default is bit-identical to before.

### Browser Playback for CASAVA / JOLT `.casv` (2026-07-03)

*Files: `packages/casv-web/src/index.ts`, `examples/casv_web_fixtures.rs`*

`@casabio/casv-web` decodes `.casv` in-browser by accepting *any* injected single-frame JXL decoder — no hard dependency on a specific WASM build. Eight bun tests check frame RGB against native output (max delta 3, mean 1.0). The lossless-residual and Fable tiers are guarded out with a clear error (**native-only** decode).

### CASAVA Lightbox + Native `casv_encode` Sidecar (2026-07-03)

*Files: `web/casv-lightbox/*`, `bin/casv_encode.rs`*

A browser lightbox with play / step / scrub / speed / loop / export over a `.casv` file, on a DOM-free core (11/11 tests). The native `casv_encode` sidecar is a separate binary because the Tauri app bundles a diverged copy of `raw-pipeline`; keeping it separate avoids forcing the two trees to move in lockstep.

### JE-8 v2 Square-Atlas Layout for Lossy Tile P-Frames (2026-07-03)

*Files: `casa_video.rs`, `examples/atlas_v2_flip.rs`*

Changed tiles were packed into a `t`-wide sliver that starved libjxl's group-level parallelism. The v2 layout packs them into a near-square grid (`ceil(sqrt(n))` columns). Over 48 real 720p frames at t=16: **size −6.5%, encode −61.1%, decode −41.8%**. v1 payloads still decode unchanged.

### FableBraid — Braided-rANS Lossless Codec + CASV Fable Tier (2026-07-02)

*Files: `casa_video.rs`, `fable_braid` crate*

**native-only decode.** The bit-serial modular loop for lossless tiers is replaced by an 8-lane braided rANS codec (ILP-bound, not chain-bound). Whole-clip lossless decode vs. JXL-e3 at the same bounding box: Big Buck Bunny **15.7×** (+5.8% bytes), Sintel 13.6× (−29.4%), Tears of Steel 7.3× (−5.4%).

---

## 2. Codec Comparison and the Format Paper

**research outputs** — SVG figures, HTML galleries, and TOON/JSON data auto-delivered to `C:\Foo\Jose\Submissions\JXL\...`. Not app UI, but the evidence base behind every "JXL is smaller / faster" claim in this document.

### The Comprehensive Unattended Full Suite — Part 3 (2026-07-05)

*Files: `CodecPaperFullTest.mjs`, `benchmark/codec-paper-figures-full.mjs`, `rd-sweep.mjs`, `bd-rate.mjs`, `metrics16.mjs`*

Corpus: 24 Kodak + 6 RAW-derived images, 9 codecs, **18 SVG figures**. BD-rate (Butteraugli) vs. JPEG: **jxl −44.0%, avif −47.5%, webp −33.9%**. Per-file JXL saving: 21–50% on Kodak, **49–72% on RAW-derived**. The PSNR BD-rate matrix confirms the ranking independently. The harness is crash-safe: it checkpoints and re-delivers after every image, honours a `LIMIT` smoke mode, and dumps everything to `data.json`. This is the reference output the format paper is built on.

### JXL Bitstream Conformance / Interop Proof (2026-07-05)

*Files: `CodecConformanceTest.mjs`*

Cross-decodes our `libjxl` fork against reference `@jsquash/jxl` on the same corpus. Verdict: **CONFORMANT** — every file decodes within 0.3 Butteraugli of a same-implementation re-decode. This is the proof that our speed-optimized fork still emits *standard* JXL that any conforming decoder can read — the thing a "we made it faster" story most needs to guarantee.

### RD Paper Suite — Part 2 — Ours vs. Original libjxl (2026-07-04 → 07-05)

*Files: `CodecPaperTest.mjs`, `rd-sweep.mjs`, `bd-rate.mjs`, `svg-figures.mjs`*

At matched effort 3, Butteraugli ≈ 1.5: **our WASM JXL vs. stock `@jsquash/jxl` = 2.1× faster encode, 2.6× faster decode, 105% size (+4.6%)**. New pure modules landed here and are reused by Part 3: a trapezoidal Bjøntegaard BD-rate, an RD-sweep, and an SVG-figure generator.

### Matched-Quality Comparison Foundation — Part 1 / PR #11 (2026-07-04)

*Files: `CodecCompareTest.mjs`, `codec-adapters.mjs`, `butteraugli-search.mjs`*

JXL is anchored at distance 1.0; every other codec is binary-searched to match per-file Butteraugli (±0.15), then flip-flop timed on equal-quality output. The finding: JXL is smallest, and AVIF is the only size rival (BD-rate jxl-vs-avif +9.5%). This is the methodologically sound floor the later figures stand on — comparing codecs at *equal quality*, not equal settings.

### Fair-Comparison Integrity — Gotchas Turned Into Features (2026-07-04 → 07-05)

*Files: `codec-adapters.mjs`, `codec-compare-jxl.mjs`, `CodecPaperFullTest.mjs`*

Each of these fixes a real measured artifact, not a hypothetical: JPEG is forced to 4:4:4 (its 4:2:0 default would be an unfair penalty); the quality ruler is standard-scale Butteraugli, not the internal `PerceptualComparer` (which runs on a ~10×-compressed scale); a verified-lossless gate checks Butteraugli < 0.05 and PNG-16 MAE = 0; error bars are ±σ over N = 3; and a PSNR BD-rate matrix sits alongside the perceptual one. Fair comparison is a feature here, deliberately built.

### 16-bit / HDR, Measured Honestly: the Codec Comparison Now Runs at Full Bit Depth (2026-07-05)

*Files: `src/lib.rs`, `crates/raw-pipeline/src/pipeline.rs`, `packages/jxl-wasm/src/bridge.cpp`, `benchmark/metrics16.mjs`, `benchmark/codec-adapters.mjs`, `CodecPaperFullTest.mjs`*

Until now, the tool that compares image formats — JPEG XL against JPEG, WebP, AVIF and PNG — only ever looked at ordinary 8-bit pictures. "16-bit / HDR" was a single tick in a capability table: a claim that the formats *can* carry high-bit-depth imagery, with no actual measurement behind it. That gap matters for exactly the images this project exists to serve — RAW camera captures, whose sensors record far more tonal gradation than an 8-bit screen can show, and where the subtle shading in a petal or a sky is the part you least want to throw away.

The obstacle was subtle. You cannot judge 16-bit quality with an 8-bit ruler: a score that only understands 256 brightness levels quantises the extra detail away before it measures anything, so a "16-bit" comparison built on 8-bit tools would just be the 8-bit comparison wearing a hat — the same numbers, no new information. The whole path had to learn to work at full depth, from the source picture to the final score.

It now does, end to end. The source is the converter's own RAW render, which already computes in high precision internally and only rounds to 8 bits at the very last step — so producing a true 16-bit picture was a matter of *not* discarding those low bits. We checked this the strict way: reduce the new 16-bit render back to 8 bits and it matches the shipped 8-bit output for **99.9999%** of colour values (the remainder off by a single unit of rounding). The high-bit-depth picture is then encoded four ways — our JPEG XL in 16-bit mode, AVIF at 10- and 12-bit, and PNG-16 as a **bit-exact lossless** floor — and scored by three full-depth metrics: 16-bit PSNR, 16-bit SSIM, and a 16-bit version of the perceptual "Butteraugli" distance.

That last metric is the delicate one. Rather than re-derive it, we cloned the existing, trusted 8-bit scorer and changed exactly one thing — the step that reads a pixel's colour — leaving every downstream calculation untouched. The proof that the clone is faithful: feed both versions the *same* picture (an 8-bit image promoted to 16-bit without adding or losing any information) and they return **byte-identical scores** — a relative difference of **0.0000**. A picture compared against itself scores exactly zero, as it must.

The build was designed so the risky part can never sink the ship. The 16-bit perceptual scorer needs a full rebuild of the compression engine — the step most likely to go wrong on a given machine. It was made *additive*: if that rebuilt engine isn't present, the perceptual score is simply left out and the comparison carries on with 16-bit PSNR and SSIM, which need no rebuild at all. There is no single point of failure, and the result — real rate-distortion curves for high-bit-depth imagery, with a lossless PNG-16 floor beneath them — comes out either way. True HDR (the wide-gamut, extreme-brightness kind with PQ/HLG signalling) is the next step and is written up as a follow-up; the floating-point plumbing it needs is already in place.

---

## 3. RAW Decode Pipeline

This is the core: Olympus ORF, Canon CR2, and phone DNG turned into finished pixels. The lead entry is the single biggest win; correctness fixes follow; byte-exact micro-optimizations come last.

### ★ Tonemap SIMD — −45% RAW Decode (2026-06-16)

*Files: `crates/raw-pipeline/src/tone_simd.rs`, `pipeline.rs`, `src/lib.rs`*

Tonemapping was 45–55% of in-browser RAW decode and ran fully scalar on the WASM SIMD128 path. A ~60-line `f32x4` body with fallback routing halves it. Measured on 8 real RAW files: **average decode 1815 → 992 ms (−45%)**, tonemap kernel 942 → 429 ms (−54%). Because the same path backs every editor slider, every lightbox exposure or white-balance tweak got cheaper too. The largest RAW-decode speedup on record.

### Noise-Aware RAW Denoise — Measured Sensor Model, Not an ISO Guess (2026-07-10 → 07-13)

*Files: `crates/raw-pipeline/src/denoise/{mod,estimate,calibrate,vst,bm3d,classical,policy,profiles,score,dng_tags}.rs`, `src/denoise_session.rs`, `src/denoise_options.rs`, `tools/denoise-benchmark.mjs`, `docs/denoise/validation.md`*

**opt-in** (`denoise.enabled`, default off). Older sensors are noisy even at ISO 200–400, and the old pipeline reached for a crude implicit ISO-to-Gaussian blur that had no idea what the sensor actually did. The replacement resolves a *heteroscedastic* per-CFA noise model — `Var[n_c | x] = S_c·x + O_c` — from the best source available, tried in order: the DNG `NoiseProfile` tag, a measured per-camera profile, a robust single-image fit, and only then an ISO fallback. That model plus the image histogram becomes one display-referred noise score, and a strict policy gate decides whether to act. **Camera release year is deliberately never a trigger** — the coefficients decide, not the calendar. When it fires, a noise-conditioned learned joint denoise/demosaic residual model runs on WebGPU (≤ 8 MiB FP16 artifact, 320×320 tiles with a 32-px halo committing a 256×256 core), with a deterministic variance-stabilized BM3D fallback in Rust/WASM. Tone, colour, texture, clarity and sharpening all remain strictly downstream. The disabled and below-threshold paths run **no** kernel and are byte-identical to the no-denoise oracle — so turning the feature off costs exactly nothing.

### RAW Metadata and Colour Truth Preserved (findings 50–52) (2026-07-11)

*Files: `crates/raw-pipeline/src/{cr2,dng}.rs`, `src/lib.rs`, `crates/raw-pipeline/tests/raw_metadata_colour.rs`, `examples/drift_report.rs`*

Three honesty fixes to what a decode reports about itself. **(50)** The DNG streaming-preview carrier used to drop `datetime` and GPS; it now matches the full-decode struct field-for-field, so a Pixel capture keeps its date and coordinates through the fast path. **(51)** `wb_from_camera` was hardcoded `true` even when white balance had silently fallen back to a grey default — it now truthfully reports whether WB came from camera metadata (Canon MakerNote `0x4001` / DNG `AsShotNeutral`) or a fallback. **(52)** CR2 preview and final render used *two different* colour matrices (Olympus-generic vs. Canon-generic), which produced a visible colour jump the instant you touched a slider; both now resolve through one `cr2::resolved_color_matrix`. The colour change was measured and owner-approved via a native drift harness (`examples/drift_report.rs`), not waved through. *(Commit `dbfd3e1c`, merge `982b9d48`.)*

### DNG Deferred Final Development — Decode the Container Once (finding 34) (2026-07-13)

*Files: `src/lib.rs` (`finish_dng_from_raw`), `crates/raw-pipeline/tests/dng_deferred_finish.rs`*

DNG now mirrors the proven two-phase ORF flow: walk the TIFF and un-decompress the LJPEG mosaic **once**, show a preview, then finish the full-resolution demosaic + tone from the *retained* raw mosaic, CFA phase and `BaselineExposure` — with no second container decode. The regression gate asserts `decode_count() == 1` and byte-parity against the naive decode-twice path on real Pixel DNGs (including a GPS/`BaselineExposure` night fixture); the retained working set is **18.9 MiB** for a 3628×2732 u16 mosaic. *(Commits `f37df827`, `41d7c510`, merge `db68ca8e`.)*

### Multi-Format Ingestion — TIFF / EXR + Browser SDR, Bit-Depth Aware (PR #8) (2026-06-23)

*Files: `crates/raw-pipeline/src/image_formats.rs` (`decode_exr`, `decode_tiff`, `f32_linear_to_srgb8`), `crates/raw-pipeline/tests/image_formats_roundtrip.rs`, `web/format-detect.js`, `web/multi-format-roundtrip.test.mjs`*

**browser-only.** A field user can now drop far more than RAW and JXL: **PNG, JPEG, GIF, WebP, AVIF, TIFF and EXR**, each handled at its true bit depth. Ordinary SDR formats route through the browser's own `createImageBitmap` (no new dependencies; AVIF follows native browser support). High-bit-depth formats get pure-Rust decoders over the `image` crate already in the tree — `decode_exr` preserves **f32** linear HDR (values above 1.0 survive), `decode_tiff` handles general u8/u16 RGB TIFF (distinct from the Bayer `tiff.rs`). `exr` was verified to cross-compile to `wasm32`; `avif`/dav1d was dropped from the crate precisely because it won't (and the browser decodes AVIF natively anyway). A magic-byte `detectFormat` dispatcher routes each upload, disambiguating RAW TIFF-containers (ORF/DNG/CR2) by extension. Verified in-browser end to end via Playwright under COOP/COEP on a synthetic HDR EXR.

### Canon CR2 Crop Rectangle Fixed (2026-07-02)

*Files: `crates/raw-pipeline/src/cr2.rs`*

All 11 CR2 fixtures were silently center-cropped from the wrong origin — off by 72 or 132 columns depending on model — because the decoder never parsed Canon's MakerNote `SensorInfo` tag (0x00E0). The output kept optical-black masked pixels on one side and dropped an equal width of live image on the other. It now parses the true crop origin, and reads the correct CFA phase from the same tag (avoiding up to three demosaic retries). A user-visible framing and colour fix on every Canon RAW the app has ever opened.

### Pipeline Black-Frame Bug Fixed (2026-06-30)

*Files: `pipeline.rs`*

An identity resize (`n_px == 1`) computed `(1 << 64) / 1`, which wraps to 0 in u64 and produced a zero reciprocal — the whole output frame went black. Fixed with a remainder-correction branch plus two regression tests, and a process-wide `OnceLock` for the `PerceptualGrid` while we were there.

### MHC AVX2 Quality Demosaic 2× (2026-07-03)

*Files: `crates/raw-pipeline/src/demosaic.rs`*

**native-only.** Gradient-corrected MHC demosaic: **+54.2% (2.18×) @ 24MP**, bit-identical across 7 sizes × 4 CFA phases. It overturns an earlier "MHC SIMD is memory-bound" rejection — that verdict was measured at 8MP, where the win is smaller and hid.

### Thumbnail / Preview Downscaling SIMD (2026-07-01 → 07-03)

*Files: `src/lib.rs`, bench targets*

RGB box-sum `wasm128`: **1.56–2.07× in-browser**. RGBA fast path: up to **+62.8% (8×)**. Byte-exact. This speeds the most frequent per-image operation in the whole app — the preview and thumbnail paint that happens for every card in the gallery.

### ORF Two-Phase Decode — Previews First (2026-07-02)

*Files: `web/worker.js`, `web/main.js`, `web/two-phase-raw.test.js`, `src/lib.rs`*

Opening an Olympus RAW used to block on a full-resolution decode before a single pixel appeared. The new two-phase path decodes a strip-streamed superpixel preview (phase 1) and posts it immediately; the full render follows as phase 2. Both phases are byte-identical, verified by render-SHA. DNG and CR2 are excluded by design — their formats don't expose a cheap preview strip. For ORF, this is the dominant first-paint improvement.

### CR2 Fused Reassembly + Crop + Monomorphized `decode_c4` (2026-07-02)

*Files: `cr2.rs`, `ljpeg.rs`*

Fusing reassemble+crop: **−6.3% owned-alloc, −11.3% warm-scratch**. A const-generic `decode_c4` monomorphized on channel count: **−8.5%** on cps=4 strips. Byte-exact, 11/11 fixtures.

### ORF Decompress — u64 Wide Refill + North-Load Hoist (2026-07-01)

*Files: `decompress.rs`*

Native 8-byte wide refill vs. the byte loop: **−6.0…−8.9%**; north-load hoist: **−4.4…−4.6%**. Byte-exact. WASM keeps the byte loop, which is correct for its bit-reader contract. Malformed-payload guards turn panics into graceful errors.

### `jxl_casadecoder` — Dead Work Removed on 5 Seams (2026-07-01)

*Files: `jxl_casadecoder.rs`*

Drops discarded clones, unneeded extra-channel decodes, and a whole-frame re-allocation before return; honours `num_threads`. Byte-exact, 23/23. It also clears the caller's output buffer on error — no uninitialized bytes on the failure path.

### CR2 LJPEG — Fast 8-Bit Table + Bulk Refill (2026-06-30)

*Files: `ljpeg.rs`*

**AvgLJPEG −9.1% (386 → 351 ms)**, and LJPEG is ~96% of CR2 decode. A 256-entry branchless Huffman table replaces the tree walk; a 4-byte bulk fill replaces byte-at-a-time feeding. Byte-exact.

### `frame_stats` — Exact u64 Luma + AVX2 Register Reduction (2026-06-30)

*Files: frame-stats kernel*

Kahan-compensated f64 sums become u64 integer sums: **scalar −34…−36%**, now bit-identical for every input *by construction*. A madd→hadd substitution removes a store-to-load stall on the reduction.

### Planar RGB16 Demosaic SIMD (3-Store) (2026-06-13)

*Files: `demosaic.rs`*

Planar bilinear demosaic: **1.58–1.69×** across thumbnail, lightbox, and 20MP paths; bit-exact. An interleaved variant measured ~0.98× and was rejected — the store pattern worked against the cache.

### CR2 Decoder Hardened: BlackLevel Fixed, Peak Memory Halved, Malformed-File Safety Added (2026-06-15)

The Canon CR2 raw decoder has been overhauled with correctness fixes, security hardening, and memory efficiency improvements that matter for batch specimen ingest. The most important fix: every CR2 file was silently using an incorrect black point—the camera's calibrated value was read from the file but thrown away due to a dead stub. It is now applied, improving colour fidelity for all Canon RAW captures. Peak working memory per decode drops from roughly 70 MB to 36 MB by eliminating a full second copy of the raw image (the crop now happens in-place). Four corrupt-file crash paths have been closed: an attacker-controlled IFD claiming 65,000 entries would have caused a massive allocation; a fabricated SOF marker could send the parser out of bounds; nonsensical slice geometry passed unchecked; and a 65,535×65,535 JPEG header would have attempted a 17 GB allocation. New benchmarking APIs expose per-phase timing (parse / LJPEG / crop) and a batch-mode scratch buffer that eliminates the large allocation on repeated decodes. Total decode time is unchanged because the LJPEG step (97% of runtime) is untouched—this pass is about correctness and safety, not throughput.

Resumable byte-range fetching is a new feature that allows a field-scientist to resume downloading large specimen images (CR2, ORF, DNG) from the exact byte offset after a satellite or cellular connection drops, without re-transferring data already received. It builds on fromByteRange by exposing a tiny serializable ByteRangeResumeState (URL + start offset + ETag) that can be persisted across app restarts or offline periods, then passed to resumeFromByteRange which automatically adds the If-Range header for safe continuation. On real field-collected RAW files, a 50% partial fetch followed by a reconnect now pulls only the remaining tail instead of the full file again, delivering clear bandwidth and time savings with almost no overhead on the initial request.

This directly supports pyramid and sidecar workflows so that preview or DC layers can be fetched first and the rest of a high-resolution capture resumed later when signal returns.

### Trustworthy RAW Benchmark: Same Files Every Run, No More Crashes on a Bad Photo (2026-06-15)

The native speed-test tool that times how fast the program turns camera RAW photos (from Olympus, Canon, and phone DNG files) into finished pictures has been made dependable. Two problems were fixed. First, when you asked it to test a batch of, say, 30 photos from a folder, it used to grab whichever 30 the computer's file system happened to hand over first — and that order can change from one run to the next. That meant two "identical" test runs could secretly be timing two different sets of photos, so the numbers could not be honestly compared. Now it always sorts the folder and takes the same first 30 by name, so every run measures exactly the same photos. Second, a single damaged or corrupted photo file used to crash the entire test partway through, throwing away all the results gathered so far. Now a bad file is simply skipped with a short note, and the test finishes the rest.

A small housekeeping cleanup was also made in the colour-and-tone engine these tests measure, removing leftover unused code so the program builds cleanly. None of this changes how fast the program runs or how the final pictures look — it makes the measuring stick honest, which matters because those native numbers are compared directly against the in-browser version to decide where to spend future speed work.

---

## 4. Decode and Viewer Pipeline

The browser decode stack — worker pool, scheduler, progressive paint, and the gallery that sits on top.

### ★ Gigapixel Tiling — Pan a Multi-Gigabyte Scan Without Decoding It (JXTC)

*Files: `packages/jxl-pyramid/src/tiling.ts`, `plan.ts`, `tiled-decode-pool.ts`, `decode-level.ts`; writers at `packages/jxl-wasm/src/bridge.cpp` and the Rust `build_jxtc` helpers*

A whole-frame JXL is the wrong shape for a specimen scan that is tens of thousands of pixels on a side — decoding it means holding the entire image in memory just to look at one corner. When ingest sees a *massive* top level — **long edge > 8000 px or > 40 megapixels** — it replaces the whole-frame encode with a **JXTC container**: the image sliced into independent **512×512** JXL tiles behind a 32-byte header and an offset/length index table. From then on the viewer only ever touches the tiles that intersect the current viewport. `tilesOverlappingRegion` computes the tile-aligned intersection of a pan/zoom rectangle with the grid; `extractTileBitstream` returns a **zero-copy `subarray`** view of exactly one tile's standalone JXL bytes (the tile index table is parsed once per container and memoised in a `WeakMap`, so every subsequent extract is an array lookup, not a fresh `DataView` walk). The result: panning and zooming across a multi-gigabyte image costs a handful of small tile decodes per frame instead of one enormous one, and peak memory tracks the viewport, not the file.

Two properties make it safe and fast in the field. **Parallelism doesn't need special headers** (finding 82): per-tile decode fans out across workers in *any* browser that exposes `Worker` — cross-origin isolation is not required, and gating the whole parallel path on `crossOriginIsolated` (as an earlier version did) silently downgraded every non-isolated browser to single-threaded. Isolation only unlocks the opt-in `SharedArrayBuffer` zero-copy carrier for the container bytes; without it the bytes are transferred or copied per worker, still fully parallel. And the parser treats the container as **untrusted**: adversarial dimensions, tile counts and offsets are all bounds-checked (a tile offset landing inside the header/index region, or `off + len` running past EOF, is rejected with overflow-safe arithmetic — never `off + len`, which wraps in a wasm32 `size_t`; see finding 60 on the absolute-offset convention that an earlier reader double-counted).

### Decode-Throughput Lateral Wins — Boundary Waste, Not Kernel Work (2026-07-12)

*Files: `packages/jxl-worker-browser/src/decode-handler.ts`, `packages/jxl-wasm/src/bridge.cpp`, `src/lib.rs`; design + evidence in `docs/Grok-decode-speed-lateral-2026-07-12.md`*

A sweep that left the decode kernel completely untouched and only removed waste at the seams — each change gated by an interleaved flip-flop on a real photo. **(1)** When the facade hands back an *owned* typed array (`byteOffset === 0`, full buffer), the worker now transfers it instead of `.slice()`-copying it — **~74% off** that step at 16 MP (45.8 → 6.2 ms); sub-views still slice, so progressive is unchanged. **(2)** The opportunistic `JxlDecoderFlushImage` + output-buffer `memset` are now gated on `progressive_detail != 0`, so a final-only decode skips work it never used — **~86% off** that stage at 20.5 MP (7.6 → 1.0 ms); every progressive checkpoint contract is preserved. **(3)** `JxlDecoderSetInput` now points straight at the caller's WASM-heap bytes (with promote-on-return for any unconsumed tail) instead of a defensive `memcpy` — **~98% off** input handling on a real JXL. **(4)** The RGB8 output vec is `with_capacity` + `set_len` rather than zero-filled. All four are outcome-preserving; the aligned decoder-runner rebuild also shrank the `simd-mt` WASM artifact by ~50 KB. *(Commits `7453e9e9`, `a94e846a`, `be678133`, `f99b0010`, baselines `172ee86c`.)*

### Advanced JXL Encoder Settings + Real Extra Channels (findings 18–19) (2026-07)

*Files: `packages/jxl-wasm/src/bridge.cpp`, `packages/jxl-wasm/src/facade.ts`, `exports-enc.txt`*

Two encoder capabilities that were quietly no-ops became real. **(18)** `advancedFrameSettings` used to be silently dropped; there is now a generic `jxl_wasm_enc_set_frame_setting(id, value)` ABI that queues each `(id, value)` and applies it verbatim through `JxlEncoderFrameSettingsSetOption` at finish. There is deliberately **no id switch** in C++ or JS — libjxl is the single validator, and an unknown or unsupported id is rejected with a nonzero code that surfaces as a deterministic thrown error rather than a silent drop. **(19)** Extra channels became real: the descriptor grew 20 → 48 bytes to carry `dim_shift`, channel name and spot colour, `encodeWithExtraChannels()` applies them (names included), and a decode helper reads the descriptors back for round-trip verification. *(Commit `9037409d`; dist rebuild `50f747c5`.)*

### Perceptual + Scale-Aware Progressive Manifest (PR #9) (2026-06-26)

*Files: `packages/jxl-progressive/*`*

The progressive manifest now carries a **measured perceptual score per tier** and a **display-scale frontier**: a small render fetches and decodes fewer bytes because a pass that is insufficient at native resolution can be sufficient downscaled. An offline profiler captures per-pass pixels and does threshold-driven tier selection; the metric is consume-time selectable (SSIM eager, Butteraugli lazy), served through a lazy cache-or-build service that dedups concurrent builds, with an authoritative edge resolver because a client Range request is only a hint and premium gating must be enforced server-side. A `capBytesForDisplay` gallery helper caps decode bytes by display size. 117 package tests green. *(Found-and-fixed along the way: an identical-pass `psnr = Infinity` that had to be clamped to finite JSON.)*

### Warm-Start the Decode Stack — Prewarm WASM (TTFP) (2026-07-02)

*Files: `web/main.js`, `web/worker.js`, `context-base.ts`, `scheduler.ts`, `jxl-worker-browser/worker.ts`*

The WASM import, `init()`, and `initThreadPool` used to run *inside* the first file task — so the first click paid for all of it before any decode began. They're now fire-and-forget `PRELOAD` work kicked off at page load, so the first click finds warm workers waiting. `prewarmSize` got wired (it was dead), with a self-healing retry so a cold-start stumble doesn't strand the session.

### Zero-Copy Progressive Paints — Drop Per-Pass Readback (2026-07-02)

*Files: `web/main.js`*

Each progressive pass called `getImageData(full canvas)` — a GPU→CPU sync stall plus a fresh **~80 MB allocation at 20MP** — before painting the next. But `putImageData` covers the whole canvas anyway, so the readback was pure waste: the held `ImageData` can just be reused. Removing it drops the stall and the allocation, so refinement is smoother and far less GC-heavy.

### Prefetch-Cache Fusion (2026-07-02)

*Files: `web/main.js`*

The thumbnail's post-encode decode (previously thrown away after painting the card) now also fills the lightbox prefetch cache when the card is in-neighbourhood — saving a whole full-resolution decode when you open it. Out-of-neighbourhood cards correctly skip the fill.

### Responsive Gallery / Progressive Paint Under Big Batches (2026-07-02)

*Files: `web/main.js`, `jxl-progressive-*.js`, `web/lightbox/*`*

The batch-statistics build was O(N²), rebuilt from scratch every rAF under a large gallery. Now O(N): ring `slice` not `splice`, a cached cell map per rAF, DOM log bounded to 200, debounced `statsLog`, and Welford online variance (which fixes float64 catastrophic cancellation above 2MP). The gallery stays flat under arbitrarily large batches and the stats stay accurate.

### Finding — "The ~15% WASM Decode Regression" Was a Measurement Artifact (2026-06-30)

*Files: `packages/jxl-wasm/test/dec-baseline-flipflop.mts`, `dec-suspect-bisect.mts`*

An alarming-looking decode regression turned out to be noise from a thermally throttled machine (absolute times ~2× inflated). Re-measured quiet, in the correct interleaved-flipflop harness, on a real 5240×3912 photo: new ≤ old (+1.2% then −4.3%, straddling zero). The `dec_ans` inline is a tiny-image tradeoff only. **The lesson, recorded so we don't relearn it: gate decode work on interleaved, real-photo-sized flip-flop runs — a single warm-machine timing is not a measurement.**

### Lightbox Photos Fixed: Progressive Decode No Longer Throws, and Two Photos Can't Collide Anymore (2026-06-17)

*Files: `web/jxl-decode-worker.js`, `web/main.js`*

When you open a photo in the big viewer, the program decodes it in the background and hands the finished pixels to the screen. Those pixels have to be in one specific format the browser's drawing function will accept — and the background decoder was handing over the *wrong* format. The browser's "paint this image" call flatly refuses that format and raises an error. The viewer's smooth, sharpens-as-it-loads path was hitting that error every time; it only ever looked like it worked because a slower backup decoder happened to produce the right format by accident. We changed the decoder to always produce the format the screen wants, and to do it without making an extra copy of the picture wherever that copy can be avoided. A photo is large — tens of millions of pixels — so not copying it needlessly matters.

The second fix is subtler but more important. The program decodes photos one at a time through a single helper, and keeps a waiting line for the rest. The helper was telling the waiting line "I'm free, send the next one" too early — the moment it sent out an *early* progress signal (like the image's width and height, or a quick low-res preview), not when it had actually *finished*. So if you were flipping through a gallery, or the program was quietly pre-loading the next and previous pictures, a second decode could start on top of the one still running. Two photos sharing the same worker means wasted effort, frames arriving in the wrong order, and memory piling up. Now the helper only says "I'm free" when a photo is genuinely done. We also taught it to recover if that background worker ever crashes — previously a crash would freeze the waiting line forever and leave loading spinners turning with no way out.

None of this changes how a finished photo looks, and it does not slow down the heavy decoding work — measured copy-for-copy, the new pixel handling does exactly as much work as before, just in the correct format. What it buys is a viewer that paints reliably on its fast path and a gallery that can't trip over its own feet. A small flip-flop speed test was written and recorded to prove the new pixel handling adds no slowdown.

### The Image Engine Stops Quietly Breaking Itself — Five Repairs (2026-06-15)

*Files: `packages/jxl-wasm/src/facade.ts`, `packages/jxl-worker-browser/src/decode-handler.ts`*

The part of casabio that turns camera files into pictures got five repairs that stop it from quietly dying.

Two of them are the big ones. First: on some web pages — the ones not set up with a special pair of security headers — the engine used to pick a "many-helpers-at-once" speed mode that those pages simply cannot run. The moment it tried, the whole picture engine fell over and nothing loaded. It now checks first and calmly steps down to a mode the page can actually use, so pictures appear instead of a blank. Second: if the engine's core failed to load once — say the network hiccupped while fetching it — the old code remembered that one failure forever and refused to ever try again for the rest of your visit. Now a stumble is just a stumble: the next picture you open makes it try afresh.

The other three close small leaks and a corruption risk that only bite when the computer is running low on memory — exactly the worst moment to have a hidden fault. One path could scribble into the wrong place in memory when an allocation failed; another quietly wasted a little memory every time a picture-quality comparison ran out of room; a third did three pointless throwaway allocations on every quality score. All tidied.

None of this changes how a photo looks or how fast a normal conversion runs — measured timings are unchanged. It is pure sturdiness: the engine now bends instead of snapping. The companion piece that *receives* the decoded pictures was examined just as hard and needed nothing — it was already solid. One worthwhile future feature was identified (rescuing a half-finished preview when a download is cut short) but deliberately shelved, because doing it today would either slow the fast path or risk showing a garbled image — and a wrong picture is worse than none.

### A Lookup Table Makes Image-Quality Scoring ~9× Cheaper (2026-06-15)

*Files: `packages/jxl-wasm/src/bridge.cpp`, `packages/jxl-wasm/src/facade.ts`*

The engine has a part that scores how close two pictures look to the human eye (used to check that a compressed photo still looks right). Before it can do that, it has to convert every pixel from the form screens use into a form that matches how we perceive brightness. That conversion ran a slow mathematical "power" calculation on every single colour value of every pixel — millions of them, on both pictures, every time it compared.

But those colour values are whole numbers from 0 to 255. There are only 256 possible answers. So we now work all 256 out once, write them in a little table, and just look up the answer for each pixel. A measured side-by-side test (ten rounds, two-megapixel images) shows the table version is about **nine times faster** at this step — and produces **exactly** the same numbers, down to the last digit, over six million checks. No quality is lost; only waiting time.

Two smaller tidies went in alongside: the 16-bit photo encoder now writes colour values straight into memory instead of copying them one tiny piece at a time, and the picture-resizing routine stops recalculating a value it could work out once per column instead of once per pixel.

These changes live in the source code and switch on the next time the engine is rebuilt; the shipped build was re-run to confirm nothing got slower in the meantime (it didn't — this run was in fact the fastest of the recent batch). The one bigger prize left — making the actual compression itself faster — lives inside the third-party JPEG XL library, not in our glue code.

### A Broken 16-bit Save Path, Quietly Fixed at Both Ends (2026-06-15)

*Files: `packages/jxl-wasm/src/facade.ts`, `packages/jxl-wasm/src/bridge.cpp`*

The engine has a fast way to save high-quality 16-bit-per-colour images that takes the three colour layers (red, green, blue) separately instead of bundling them first. Looking closely at how the JavaScript side and the C++ side hand this data to each other turned up that the path was broken at *both* ends — and in a way that hid itself.

On the JavaScript side, the function called two helpers that did not exist, so it crashed the instant anything tried to use it. Because it always crashed, nobody ever reached the C++ side — which had its own hidden flaw: it packed the three colours into a three-slot layout but then told the next stage to read four slots per pixel, so it would have read the wrong colours and run off the end of its memory. The crash on the first side was accidentally shielding the broken second side.

Both are now fixed together — the missing helpers were written, and the C++ side now lays the data out the way the next stage actually expects. This is exactly the kind of fault that only shows up when you study the *handoff* between two pieces rather than each piece on its own: each looked plausible alone; together their agreement was wrong. The fixes are in the source code and take effect on the next rebuild; the shipped build was re-run to confirm nothing else changed.

### A Broken Quality Alarm, Fixed and Made Faster (2026-06-15)

*Files: `web/jxl-progressive-byte-metrics.js`, `web/jxl-progressive-byte-benchmark-core.js`*

Imagine a smoke alarm that was wired so it could never go off — it always showed a green "all clear" light no matter how much smoke filled the room. That is what we found in one of our image-quality checks.

When the app loads a photo a little at a time (so a blurry version appears fast, then sharpens), we watch a quality score called SSIM to make sure each step looks BETTER than the last, never worse. The code that was supposed to raise a flag when quality went backwards was looking at the wrong number every single time, so it silently reported "quality is always improving" even when it wasn't. We fixed the wiring so the alarm now actually watches the SSIM score. We proved it with a tiny test: feed it a sequence that clearly gets worse in the middle, and the old code shrugged ("fine"), while the fixed code correctly says "that got worse."

The same cleanup also made the check almost twice as fast (1.92x) and used about half the computer power, because the old code was making and throwing away little scratch lists of numbers it didn't need. Removing that waste is what exposed the broken alarm in the first place — the unnecessary copy was hiding the bug.

No downside, no slowdown anywhere else: this only touches the bookkeeping that runs after an image is decoded, not the heavy lifting of decoding itself.

### "Just Give Me the Photo's Size" No Longer Freezes Forever (2026-06-15)

*Files: `packages/jxl-session/src/decode-session.ts`, `packages/jxl-session/src/event-stream.ts`*

When the app opens a picture it can ask the decoder for different amounts of work: sometimes the whole finished image, sometimes only a quick blurry preview, and sometimes just the photo's basic facts — its width and height — without decoding any pixels at all. That last "facts only" mode is exactly what a fast gallery or a phone pointing at a plant wants first, so it can lay out the screen before the real picture arrives. A bug meant that when you asked for "facts only" (or for a single quick preview frame and nothing more), the part of the program waiting for the job to *finish* was never told it had finished — so it waited, and waited, forever. The screen could hang. This review found and fixed that: the decoder's front desk now recognises these "stop early" requests and reports completion itself the moment the requested information arrives, instead of waiting for a final signal that, by design, was never going to come. Everyday "give me the whole picture" decoding was never affected and behaves exactly as before.

The review also looked hard at the program's memory use, where every preview frame of a photo is kept in a list so that a viewer can replay them. A tempting change to throw those frames away sooner — to save memory — was deliberately *rejected*, because the program's own automated tests prove that some callers rely on replaying that list later; quietly dropping the frames would have broken them. Catching that trap is itself the win: the safe, correct behaviour was kept, the real hang was fixed, and the reasoning for not "optimising" was written down so no one re-introduces the bug. All 45 active session tests pass, and the unrelated RAW-speed benchmark showed no slowdown.

### Progressive-Paint Page Speedup (A1–A4) (2026-06-06)

*Files: `web/jxl-progressive-paint.js`*

Removed the artificial `sleep` calls between passes; coalesced paints to rAF; made the canvas and thumb map persistent across passes (no per-pass re-allocation); gated per-pass stats behind `?stats=1`. Together these make the progressive path feel smooth rather than staccato.

---

*The entries below are established viewer, scheduler, and infrastructure capabilities. Their mechanisms are described from current source (files cited); their headline figures are as originally reported by the work that shipped them, not re-measured in the July 2026 grounding pass.*

### Zero-Copy Local Range Windows for Offline Progressive Paint

*Files: `packages/jxl-stream/src/browser.ts`*

The `fromBlobRange` API brings full range-window parity to locally cached imagery. Advanced progressive-paint and high-resolution tile-window rendering used to require a live server that could answer HTTP Range requests. With `fromBlobRange`, raw image pyramids in the local file system or OPFS cache are sliced with constant-time, zero-copy `Blob.slice()` — the local analogue of a network byte-range query — so a researcher can zoom and pan across a multi-gigabyte specimen in complete airplane-mode isolation.

It shares its call signature and contract with the network-facing `fromByteRange`, so the offline workflow matches the online one exactly: the scheduler streams precise per-level and per-tile offsets straight from the local pyramid with no intermediate copies. That removes the memory overhead and CPU cost of decoding entire large-format files on constrained devices — the mobile/field case this project is built for.

### Megatexture Streaming for JPEG XL Pyramids

*Files: `packages/jxl-pyramid/src/cache.ts`, `tiled-decode-pool.ts`, `plan.ts`, `decode-level.ts`, `packages/jxl-progressive/src/progressive-scheduler.ts`*

A game-engine-style megatexture streaming layer over the JXL pyramid decoder. Previously the pyramid cached decodes at the exact viewport level, so any pan — even a one-pixel drag — was a total cache miss that re-decoded every overlapping tile. A tile-granular LRU cache keyed by stable string identity fixes this: a pan-back or overlapping gesture now costs zero workers and zero decodes, reusing adjacent tile buffers and removing the "white grid lines" that used to flash during navigation.

Alongside the cache sit a velocity-aware neighbourhood prefetch and a coarse-quality DC-reuse tier. The prefetch predicts viewport trajectory and warms tiles just ahead of the gesture, so content is decoded and waiting before it crosses the screen edge; the DC tier repaints a pan-back frame instantly from upsampled DC content and refines it to full quality in the background. Together they turn the pyramid from a reactive decoder into a predictive one, targeting sustained smooth panning even on large giga-pixel specimens.

### Live Viewport Priority Steering

*Files: `packages/jxl-scheduler/src/scheduler.ts`*

A real-time `setPriority` API for the scheduler. A tile's decode priority used to be locked at submission, so scrolling fast past half-decoded images left those off-screen tiles occupying the queue and stalling the fresh, in-viewport ones. Priority steering lets the UI thread promote near-viewport tiles and demote off-screen ones on the fly, without the cost of cancelling and restarting their WASM decoders.

It re-sorts the active priority queues in constant time and adjusts the background-worker preemption set in step: when a thumbnail or pyramid level enters the viewport it is promoted immediately, and if the pool is saturated the preemption engine suspends a background worker to run it. In concurrency benchmarks simulating continuous scrolling across large galleries, this materially cut visible first-paint latency — a responsive feel even on heavily throttled mobile connections.

### Self-Healing, Bounded-Memory Worker Pools

*Files: `packages/jxl-scheduler/src/pool.ts`, `packages/jxl-scheduler/src/types.ts`*

Hardening for the execution layer on constrained devices. On low-memory phones the OS reaps idle or active Web Workers without warning, which used to crash active sessions or throw unhandled rejections. Typed `onError` / `onExit` recovery hooks in the pool contract, plus guards that keep a resumed decoder away from a terminated handler, let the scheduler detect the termination and boot a healthy replacement in the background without interrupting the user.

A bounded-memory mechanism caps parked decoders: parked sessions pin a dormant WASM heap for zero-cost resumption, so a configurable `maxParkedSessions` ceiling evicts and cleanly cancels the oldest when the limit is hit. Restructuring the worker-factory races to intercept and shut down late-spawning orphan workers on timeout gives a strict thread-pool bound. The result is a pool that stays stable and leak-free under adversarial preemption.

### Symmetric Non-Owning View Transfers (jxl-worker-node)

*Files: `packages/jxl-worker-node/src/spawn.ts`, `decode-handler.ts`, `encode-handler.ts`*

A thread-safety and memory-transfer overhaul of the server-side `@casabio/jxl-worker-node`. Concurrent session creation, unexpected process termination, and backpressure pauses could previously race into silent chunk loss or hung threads. Generation-aware identity guards on session start and symmetric lifecycle cancellation close those boundary hazards: a stale successor can't clobber a live start, and a crashed worker broadcasts a structured error to the main loop before shutdown instead of masquerading as a clean exit.

The transfer path avoids accidental cloning across the worker boundary. Under Node's structured-clone rules, sending a non-owning typed view (a small window into a larger shared native pool) deep-copies the *entire* backing buffer — silent multi-megabyte amplification. The exact-slice pipeline transfers only the requested byte range instead. With an EMA-driven latency model that honours soft-preemption pause requests between chunk streams, the node worker reaches preemption-contract parity with the browser runtime.

### Deterministic Procedural Fixtures + WebCrypto SHA-256 Corpus

*Files: `packages/jxl-test-corpus/src/loader.ts`, `manifest.ts`, `scripts/generate-fixtures.mjs`*

`@casabio/jxl-test-corpus` replaced checked-in binary `.jxl` / `.png` blobs — which bloat the repo and freeze the calibration set — with a procedural fixture framework. It renders pixel patterns (sRGB linear gradients, alpha ramps, 16-bit wide-gamut Adobe RGB structures, neutral-gray axes, multi-view photogrammetry pairs) in memory at build time, then compresses them with the project's own WASM JPEG XL encoder — deterministic, infinitely extensible test assets generated on the fly.

To keep those generated binaries metrically exact against generation drift or compiler regression, the loader pins each fixture's SHA-256 in the corpus manifest and verifies retrieved bytes against it via WebCrypto on both the Node and browser paths, failing with an actionable warning on any drift. The corpus becomes an active calibration bench — catching subtle decoder bugs, colour-transform shifts, and stride regressions for the cost of one hash comparison.

---

## 5. The Compression Engine

*A byte-exact speed campaign — same bytes out, same quality, only faster.*

**~103 `perf(...)` commits across ~40 codec files, Jun 22 – Jul 3 2026**, in the `capebio/libjxl` fork (`external/libjxl-012`). Every pass is bitstream-identical: the file it produces is unchanged, so it cannot alter quality — it can only change how fast the answer arrives. Safety is proven, not asserted: each change was gated by an interleaved flip-flop A/B run (start-rotation cancels thermal drift) plus a SHA-256 old-t0 == new-t0 identity check, verified on **native AVX2 and WASM SIMD128**.

The work falls into four natural domains.

**Bucket A — Entropy coding & clustering (+ MT).** `enc_ans` (×6), `ans_common`, `enc_cluster`, `enc_context_map`, `enc_huffman`, `dec_ans`, `ChooseUintConfigs`, ANS reverse-map direct-expansion, entropy-MT serial-tail. Headline: **`EncodeGroups` 57.3 → 46.8 ms = 1.22×** on 8 threads, by parallelizing the histogram-build and table-build tail while keeping every ordering decision serial (byte-exact by construction). `ans_common` init drops three heap vectors to two stack arrays; `ChooseUintConfigs` hoists one scratch `Histogram` above the ~30-config loop. ~22 passes.

**Bucket B — Quantization & adaptive quant.** `enc_aq`, `quant_weights`, `quantizer`, `compressed_dc`, `enc_ac_strategy`, `ac_strategy` coeff-order. `enc_aq` `FuzzyErosion` 36 → 16 loads (byte-exact on 8 RAW); the ACS scratch arena 1.5 MiB → 96 KiB; coeff-order exact-rect traversal 2–4× by skipping discarded-`xs` entries. ~11 passes.

**Bucket C — Perceptual & colour kernels.** Butteraugli SIMD: **native −48…53% / WASM −33…48%** (diffmap FNV and score bits match 25/25 native + 63/63 WASM); `conv5` edge-coverage +31–49%; `cms` interleave ~22% via `StoreInterleaved3/4` + `LoadInterleaved3/4`; `enc_xyb` copy-elim. Honesty note: the Butteraugli AVX2 hot-path was reverted once for WASM incompatibility, then re-landed scalarized for the EMU256 path — *verify on both targets before shipping* is the lesson. ~11 passes.

**Bucket D — Lossless, transforms & decode/render.** `enc_lz77` (~1.42×, 0 / 160,680 byte mismatch); `enc_fast_lossless` seams; `enc_patch`; `enc_modular` (~+5.7%); `enc_group`; DCT / `enc_transforms`; and the decode sub-campaign across `dec_group`, `dec_ans`, `dec_ext`, `dec_cache`, `render_pipeline`. ~30 passes.

Two callouts. **enc_patch lossless decode-skip** — for a losslessly-coded patch atlas, skip the encode→decode round-trip entirely; proven with a full native `cjxl` / `djxl` A/B (bitstream SHA-identical; decoded OLD == NEW == original; `DecodeFrame` branch-probe count = 0 new calls). And the **rejections we're proud of**: several plausible optimizations measured *slower* and shipped nothing —

| Proposed optimization | Measured result | Verdict |
|---|---|---|
| W1 SIMD-precompute `WriteTokens` | **0.84× (20% slower)** — rANS emission is latency-bound; hoisting precompute only adds traffic | rejected |
| `compressed_dc` X-zero dequant | regressed on typical images | rejected |
| `enc_transforms` DCT4×8 "sink" | −10% | rejected |

That the byte-exact + flip-flop gate *rejected* real work is the evidence it has teeth.

---

## 6. Reliability, Memory and Build Infrastructure

*Developer-facing. Shipped items first; roadmap and design artifacts flagged at the end.*

### Weekly Multi-Branch Integration Discipline (2026-07-06, recurring)

The rolling campaign's parked perf branches are folded onto two clean heads — the super repo's `origin/main` and the libjxl submodule — on roughly a weekly cadence, with conflicts resolved along documented patterns. Jul 06 state: `origin/main = 09df2547`. This is what lets the campaign live on focused single-topic branches instead of piling onto one long-running branch that no one can review.

### Build Pipeline Hardening — The Build Stopped Lying (2026-06-11 → landed)

*Files: `packages/jxl-wasm/scripts/build.mjs`, manifest*

`build.mjs` could not execute at all — stray TypeScript in a `.mjs` file failed to parse before the first line ran — and the manifest advertised tiers and capabilities the output didn't contain, with PGO listed as enabled when it was silently skipped. That is not cosmetic: a benchmark number from an unverified build is not a number. Fixed: parse-and-export verification, size budgets that fail CI, SHA-256 + SRI + Brotli stamping of every artifact, per-role `wasm-opt`, Docker layer-baking for hermeticity, and real two-pass PGO gated at ≥ 2% measured gain. The build now produces a signed, verified artifact or fails loudly — *build provenance is data provenance.*

### Node Worker Lifecycle Correctness + Crash Detection (2026-06-12 → landed)

Closed a set of silent failures that only surfaced under concurrency: session-id poisoning by a stale successor; a generation race clobbering a new session's chunks with old data; a worker crash masquerading as a graceful `exit(0)` (now surfaced as `WorkerCrashed`); and a `pause` that actually waits for the worker rather than fire-and-forgetting.

### jxl-native — Genuinely Incremental N-API Streaming (finding 20) (2026-07)

*Files: `packages/jxl-native/native.cc`*

The Node-native decoder used to materialize everything at `close()`; it now streams. A persistent `LiveDecodeState` runs `JxlDecoderProcessInput` as far as the accumulated bytes allow, queueing header / progress / frame / final events into a bounded FIFO as they are produced — so a consumer sees the header and progress events *before* the stream is closed. Backpressure is real: `push()` returns a promise that parks when undrained depth hits the high-water mark (8) and resolves once the consumer drains below it, so the producer stops accepting work and retained memory is bounded by (HWM events) + one active frame buffer. N-API refs pin the image-out and held animation-frame buffers across native calls. *(Commits `cae24c8a`, test `9d883db6`, merge `1b223413`.)*

### Dependency Security Hygiene — Dependabot, Kept Honest (ongoing)

The tree is watched by Dependabot and the alerts are triaged, not rubber-stamped. The `jxl-oxide` bump `0.11 → 0.12` clears three advisories including **`jxl-grid` HIGH (CVE-2026-52834)** — and the PR states the honest scope: `jxl-oxide` is a `[dev-dependency]` used by exactly one `#[cfg(feature = "jxl-codec")]` test that decodes what our own encoder just produced, so it is **not in shipped code and has no untrusted-input path** — dependency hygiene, not a live-vulnerability patch. A parallel effort greened the trunk: strict-TS `typecheck` fixes took the workspace from failing at package #8 to **15 of 16 packages clean**, with `jxl-pyramid` at 209/0 tests. *(PRs #19, #21; earlier `#10` superseded by #21.)*

### Branch-Consolidation Audit — 29-Agent Read-Only Pass (2026-07-01)

A 29-agent read-only workflow audited 27 parked perf branches into a merge-order plan — and *debunked* a phantom `jxl_casaencoder` "corruption on realloc" concern with a TDD characterization test that passes cleanly on unmodified `main`. (Grounding: memory-only — the ledger lives in an external worktree.)

### Toolchain + Fork Notes

**MSVC is the default** — the GNU toolchain ships a broken `dlltool.exe`. **Hard rule:** build the WASM bridge against `external/libjxl-012`, not the 0.11.2 test clone; the manifest now records the real source HEAD. **c-perceptual WASM link break, root-caused:** `undefined symbol: perceptual_apply_full` is an AVX2-only symbol pulled into a non-AVX2 build — the correct build carries `features = ["parallel-wasm"]`.

### On the Roadmap

**roadmap** — designed and written up as of 2026-07-06, not yet shipped.

- **Pipeline restructure K1–K6** (`docs/HANDOFF-pipeline-restructure-2026-07-06.md`). One decode spine (`decode_raw()` + `RawRowSource` row-bands; CR2 resident-mosaic ~48 MB + band vs. ~264 MB today), one progressive encode → tiers as byte ranges (3 → 2 encodes), a `FramePipeline` buffer owner, a `RawVideoSource` (RAW time-lapse → CASV), streaming-only video, and single-source FFI/CASV contracts.
- **Crate unification S1** (`docs/HANDOFF-S1-crate-unification-2026-07-06.md`). Three diverged copies of `raw-pipeline` exist; ~10 holo worktrees carry wins stranded on the old lineage. G1 is a reversible, measured parity trial via additive `pub use` shims → report, then stop.
- **Wave-2 strategic map S1–S6** (`docs/STRATEGIC-MAP-wave2-2026-07-06.md`). On the consume side: fork unification, one browser delivery engine, a memory-governed `AssetStore` (~360 MB @ 24MP → one LRU/quota owner), fuzz + golden-SHA hardening, scene-referred colour, and LOD/ROI unification.

### Design / Research Artifacts

- **CASAVA "JXL as a video codec" design doc** (`docs/superpowers/specs/2026-07-01-jxl-video-codec-design.md`). A JXL transform + entropy backend with a pluggable prediction front-end. The codec is largely shipped (see § 1); this doc is the rationale and forward roadmap. Honest non-goals: no hardware decode; won't beat VVC/AV1 on high-motion.
- **"The CasaWASM Media Engine" — JOSE wins paper** (`C:\Foo\Jose\Features and Wins\`, HTML + LaTeX + PDF). 20 performance / 10 memory / 10 feature wins. Opus audio is presented there as designed-not-yet-coded. (Grounding: memory-only — the artifact lives outside this repo.)

---

## 7. BLISS: Instant Local Preview Cache

CasaWASM runs on a deliberate **three-format model**, and BLISS is the piece that lets a re-opened gallery paint from cache instead of stalling. JXL is the archival and delivery format (effort-3, ~8 MB, server → CDN → client). CASV/BLTV are the video formats. **BLISS** is the odd one out: a codec that never touches the network and exists only to *decode* a preview from the local OPFS cache far faster than the RAW file could be re-decoded.

*Files: `src/bliss_wasm.rs`, `src/bltv_wasm.rs`, `web/bliss-worker.js`, `web/main.js`, `web/bltv-player.html`, `web/bltv-worker.js`; codec in the sibling `C:\Foo\bliss` workspace (`bliss-core`, `bltv`). Integration merged as PR #22.*

### The Instant-Preview Cache (BLISS)

On ingest, the worker encodes the 1800-px lightbox RGB to BLISS the moment the lightbox frame exists and writes it fire-and-forget to `OPFS/bliss/<assetId>` — the `assetId` an FNV-1a hash of path + size + mtime, stable across sessions. On the next open, `drawLightboxForCard` finds the card not yet decoded, reads the BLISS bytes back from OPFS, decodes them on a dedicated `bliss-worker.js`, and paints a **"BLISS (cached)"** frame before the full RAW re-decode arrives at full quality. What is actually *measured* (not estimated): the BLISS decode step takes **~86 ms** for a detailed 20 MP-derived 1800-px foliage frame on the scalar WASM decoder in Node, median of eight (`benchmark/cold-open-latency.mjs`) — about **10× cheaper than re-decoding the RAW** (~840 ms) and ~2.7× cheaper than decoding the archival JXL. The end-to-end on-device **time-to-first-pixel** — OPFS read + decode + canvas paint, on a real browser's SIMD/threaded decoder rather than this scalar path — has **not** been benchmarked and would differ (the browser decoder may be faster than the scalar figure, while OPFS I/O and paint add to it). File size is content-dependent: these detailed specimens land at **2–4 MB** at near-lossless `q=2`; a smoother `1800×1200` frame is far smaller. BLISS is honest about what it is *not*: at equal quality it is always larger than JXL effort-3, so it is never sent over the wire — it earns its place purely as a local decode-latency cache. `bliss_encode` takes `q_y=1, q_c=1` for lossless or `q_y=2, q_c=2` for the near-lossless display cache; magic bytes `BLSR`.

The codec itself (in the sibling `bliss-core` crate) is a checkerboard-median predictor over an adaptive RCT feeding a context-modelled rANS entropy stage. On the native server / Tauri path it carries an **AVX-512F rANS decode** — 16 lanes in one `__m512i`, using `_mm512_mask_expand_epi32` for renormalization with no rank lookup table, runtime-detected via `is_x86_feature_detected!` and gated behind an `avx512` feature; WASM and non-x86 fall back to scalar. 15/15 decode tests pass on AVX-512 hardware.

### BLTV — Lossless Video Reference

*Files: `src/bltv_wasm.rs` (`BltvDecoder`), `web/bltv-player.html`, `web/bltv-worker.js`*

BLTV ("Bliss TV") is the video sibling: I-frames plus delta P-frames, a lossless master format for local use and codec research. It has a standalone browser player and decode worker (`BltvDecoder` exposes `width/height/frame_count/fps/is_lossless/decode_next_frame/seek`). It is explicitly **not** used for CASABIO delivery — CASV/JXL owns video distribution; BLTV is for lossless masters and format work. The v-decode is not yet exercised by automated tests in this repo, and the `OPFS/bliss/` cache has no eviction cap yet — both noted as open items, not claimed as done.

**BLTV inherits the BLISS acceleration — measured, not assumed.** Because every BLTV frame is encoded/decoded through `bliss-core` (I-frames are bliss RGB; P-frames are bliss over a centred inter-frame delta), the July-2026 BLISS v128-SIMD and band-parallel work speeds BLTV up *for free* — but until now that had never been benchmarked. Two grounded runs (`docs/bltv-accel.json`; harnesses `bltv/examples/bltv_bench.rs` + `bliss-wasm-sandbox/bltv-accel-bench.mjs`):

- **Browser decode (the shipped `BltvDecoder` path), v128 vs scalar, single-thread.** Same `.bltv` bytes decoded by both builds, **byte-identical** output (full FNV checksum), interleaved A/B with start-rotation to cancel thermal drift, median of 21. BLTV whole-video decode runs at **40–47 MP/s on v128 vs 18–22 MP/s scalar — a 2.1–2.2× speedup** across 720p/1080p, all-intra and GOP, lossless and near-lossless. The v128 figure (43–45 MP/s on intra) cross-checks the standalone BLISS decode (~45), confirming the video codec inherits the kernel win intact.
- **Native encode + decode, band-parallel MT on vs off (AVX2 always on).** With the `parallel` feature (12 threads) the encoder hits **~95–115 MP/s (2.8–3.4× over single-thread)** and the decoder **~120–186 MP/s (2.1–2.9×)** at 1080p/4K. The speedup is bounded by band count (`default_bands` = 4 at 1080p, 8 at 4K), exactly like BLISS — threads past the band count don't help, which is why the app keeps single-thread v128 for the instant-preview path and reserves MT for standalone/batch tools.

---

## 8. The Web Application

The sections above are mostly engine and codec. This one is the product a field scientist actually touches: the gallery, the editor, export, timelapse, and plant/animal ID. A single July-2026 pass (findings 3–48, TDD red→green throughout) rebuilt this layer around per-asset state isolation and bounded memory, so a large batch of edits can't leak or collide. Files live in `web/*.js` and `web/lightbox/*`.

### Per-Asset State Isolation (findings 40, 41, 46, 48)

*Files: `web/asset-state-store.js`, `web/jxl-decode-cache-policy.js`*

Every asset carries its own crop, look and sidecar state keyed on a stable `assetId` (full path + size + mtime → FNV-1a, so two files with the same basename can't collide), instead of edits reading and writing ambient globals. Crop edits are transactional (`beginCropEdit` / `applyCropEdit` / `cancelCropEdit`, angle and original-space flag preserved). A `sourceGeneration` counter bumps on every reprocess and `isStale(tag, state)` rejects a late-arriving decode for a superseded source — so flipping quickly through a gallery can no longer paint a stale image onto the wrong card. Durable-persistence failures surface rather than vanishing.

### Full-Resolution Export with a Privacy Policy (findings 13, 44, 45)

*Files: `web/export-service.js`, `web/exif-serialize.js`*

One `ExportService` entry point for every export path, sourcing from the developed full-resolution JXL — **never** the 1800-px preview. Output is JXL or PNG (the two formats with real encoders; JPEG/TIFF are gated with a clear error rather than a broken file). A metadata policy of **keep / strip-gps / strip-all** is serialized into the EXIF bytes, and the tests prove GPS is genuinely absent under the strip policies by decoding the exported file back. A companion fix prefixes the JXL Exif box with the required TIFF-offset header so the EXIF is actually readable downstream, and the info-panel format label is derived from the EXIF object instead of a hardcoded "ORF (Olympus 12-bit)" string.

### Proxy Intake, "Develop Selected", and One Format Source (findings 10, 14)

*Files: `web/proxy-develop.js`, `web/format-detect.js`*

A proxy-first intake mode renders a fast JPEG-preview pass so a big folder becomes browsable immediately; **"Develop Selected"** then submits only the cards you picked at high priority, jumping the queue ahead of background auto-processing. The upload `accept` filter and the drag-drop filter both draw from a single canonical `format-detect.js` (`acceptExtensions` / `isPipelineInput`), so there is exactly one list of what the pipeline can ingest — and JPEG, previously missing from it, is now included.

### Selected-Asset Timelapse — RAW Stills → CASV (finding 15)

*Files: `web/timelapse-core.js`, `web/timelapse.js`*

Build a time-lapse straight from selected RAW stills (ORF/DNG/CR2), each frame carrying its own look edits, output at a chosen preset (`exact / 2160 / 1440 / 1080 / 720 / 512`). Frames are read through an async generator gated to a **160 MB in-flight budget** (≈ two 20-MP frames), so an arbitrarily long sequence never materializes at once; the run is cancellable, and it hands off to the same `ExportService` contract as everything else. The per-frame look is applied through the 14-slot positional decoder ABI (exposure, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r, wb_b, texture, clarity).

### AI Plant / Animal ID — Browser and Node, Cleanly Split (finding 16)

*Files: `web/ai-id/{browser-adapter.js,node-adapter.mjs,sources.mjs,sidecar.mjs}`*

The image-source chain that feeds identification is split so the browser adapter uses **zero Node built-ins** (source order: live-buffer → pyramid → master → raw) while the Node adapter keeps `sharp` and the embedded-preview extractor to itself (live-buffer → pyramid → embedded-preview → master → raw, embedded preview gated to a 768-px minimum long edge). `buildSidecarForAsset` wires a stable `assetId` and the same keep/strip-gps/strip-all privacy policy into the export contract, so an identification request and an export agree on identity and on what metadata leaves the device. This is the *foundation* pathway — ordered sources and sidecars — not a bundled classifier.

### Bounded Render / Decode / Derived-Asset Lifetime (findings 11, 12, 29, 43)

*Files: `web/jxl-derived-cache.js`, `web/lightbox/webgl-pipeline.js`*

Decoded full-resolution RGBA buffers no longer accumulate in an unbounded per-card `WeakMap`; they live in an AssetStore-backed **~288 MB LRU** (three 20-MP frames), invalidated explicitly on generation change or card delete. The WebGL pipeline skips `texImage2D` when the framebuffer dimensions are unchanged, and thumbnails are decoded at **1/4 resolution** (`downsample: 4`) instead of decoded full and downscaled on the canvas. Source-text assertions guard against anyone re-introducing a direct `_jxlDecoded` assignment that would bypass the cache.

### Lazy-Load Startup + a Shared, Byte-Admitted Scheduler (findings 47, 3, 9, 39)

*Files: `web/lazy-module.js`, `web/jxl-read-lane.js`, `web/jxl-browser-context.js`, `web/jxl-calibration-propagation.js`*

The page loads lighter: heavy optional modules (perceptual colour, export service, Tauri-parity lightbox, PNG encode) are dynamically imported at their first command boundary via a memoised `makeLazyModule()` (concurrent callers share one promise; a failed load is *not* memoised, so a transient error retries), then advisory-prefetched on idle. Underneath, the private per-file JXL queue was replaced with the shared `jxl-session` scheduler, and file reads pass through a **byte-admission semaphore** (`createReadLane`, capacity = half of the ~1.8 GiB RAW-decode budget) that only calls `file.arrayBuffer()` *after* admission — so a backlog of pending tasks no longer pins every file's bytes in memory at once. Hardware calibration propagates to the pool size and per-worker limits before the first decode. 28/28 scheduler tests green.

---

## How We Keep Ourselves Honest

Everything above rests on one method, applied the same way every time:

- **Byte-exact means byte-exact.** For the compression engine, "faster" is only allowed to change *when* the bytes arrive, never *which* bytes. Every pass is gated by a SHA-256 check that the output is identical to the baseline. If the bytes move, it isn't this kind of win and it doesn't ship as one.
- **Timing is interleaved, not sequential.** Speed is measured with flip-flop A/B: old and new variants alternate with start-rotation, so a machine warming up or throttling mid-run biases both equally and cancels. A single before/after pair on a warm laptop is not evidence — and we have the [`~15% decode regression`](#4-decode-and-viewer-pipeline) that turned out to be pure thermal noise to prove it.
- **Both targets or neither.** Native AVX2 and WASM SIMD128 are different machines. A kernel that wins on one can lose or fail to link on the other — as the Butteraugli hot-path did. Wins that matter for the browser are verified in the browser.
- **We reject our own optimizations.** W1 `WriteTokens` precompute measured 20% *slower*; the DCT4×8 sink, −10%; the X-zero dequant regressed. All were plausible, all were built, all were thrown away. The [rejections table](#5-the-compression-engine) is not an apology — it's the receipt that the gate works.
- **We drop what we can't verify.** Numbers that couldn't be traced to a commit or a delivered figure were left out, not hedged into the prose. A shorter true list beats a longer impressive one.

The full rejection log lives in `docs/rejected optimizations.md`. The flip-flop harness that produced most of these numbers is the `flipflop` / `flipflopdom` skill.
