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

## How We Keep Ourselves Honest

Everything above rests on one method, applied the same way every time:

- **Byte-exact means byte-exact.** For the compression engine, "faster" is only allowed to change *when* the bytes arrive, never *which* bytes. Every pass is gated by a SHA-256 check that the output is identical to the baseline. If the bytes move, it isn't this kind of win and it doesn't ship as one.
- **Timing is interleaved, not sequential.** Speed is measured with flip-flop A/B: old and new variants alternate with start-rotation, so a machine warming up or throttling mid-run biases both equally and cancels. A single before/after pair on a warm laptop is not evidence — and we have the [`~15% decode regression`](#4-decode-and-viewer-pipeline) that turned out to be pure thermal noise to prove it.
- **Both targets or neither.** Native AVX2 and WASM SIMD128 are different machines. A kernel that wins on one can lose or fail to link on the other — as the Butteraugli hot-path did. Wins that matter for the browser are verified in the browser.
- **We reject our own optimizations.** W1 `WriteTokens` precompute measured 20% *slower*; the DCT4×8 sink, −10%; the X-zero dequant regressed. All were plausible, all were built, all were thrown away. The [rejections table](#5-the-compression-engine) is not an apology — it's the receipt that the gate works.
- **We drop what we can't verify.** Numbers that couldn't be traced to a commit or a delivered figure were left out, not hedged into the prose. A shorter true list beats a longer impressive one.

The full rejection log lives in `docs/rejected optimizations.md`. The flip-flop harness that produced most of these numbers is the `flipflop` / `flipflopdom` skill.
