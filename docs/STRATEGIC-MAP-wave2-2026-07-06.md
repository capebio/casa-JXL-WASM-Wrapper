# STRATEGIC MAP — Wave 2 (S1–S6), 2026-07-06

Successor to `docs/HANDOFF-pipeline-restructure-2026-07-06.md` (K1–K6, all decisions
resolved). K-wave restructured the produce side (RAW → JXL image / CASV video). S-wave
covers what K-wave deliberately left out: the repo fork, the browser consume side,
storage, verification, colour, and LOD addressing. Planning artifact — each S-item gets
its own implementation handoff when scheduled.

Riders from the P-list are assigned where they belong: P1 (ffmpeg rawvideo pipe) → rider
on K5. P2 (GOP-pipeline parallelism) → after K5. P3 (CASV v2 container) → rider on S6 or
standalone. P4 → subsumed by S2. P7 → subsumed by S2. Memory-budget items → S3.

---

## S1 — End the raw-pipeline fork (HIGHEST PRIORITY — active waste)

**Evidence (verified on disk 2026-07-06).** At least three live lineages of the same crate:

| Lineage | State |
|---|---|
| `C:\Foo\raw-converter-wasm\crates\raw-pipeline` (this repo) | Most advanced: pipeline.rs 182K, BSD-clean own-FFI codec (`jxl_casaencoder/decoder`), casa_video, fable_braid, perceptual, stream_band/export/preview |
| `C:\Foo\raw-converter-tauri\raw-pipeline` | Diverged old lineage: pipeline.rs 71K, cr2.rs 22K, decompress.rs 12K; still `jxl_lowlevel.rs` on **GPL jpegxl-rs**; no video/fable/perceptual/streaming |
| `C:\Foo\JXL_Tauri_with_WASM\raw-pipeline` | Desktop app's own copy (the shipping Tauri app) |

Plus ~10 sibling worktrees (`raw-converter-tauri-{decompress,pipeline,demosaic,ljpeg}-holo`,
`-tiffharden`, `-cr2slice`, `-rgba16-fix`, `rct-*`) holding **landed, measured wins on the
OLD lineage** that this repo does not have: decompress holo (table-free Huffman, branchless
adaptive width, `decompress_into`) **+17.9–19.2%**; pipeline holo (fused blur+apply
**+42%**, 16-bit LUT cache reuse, DC-gain/overflow fixes); jxl_lowlevel borrowed
progressive surface; demosaic/ljpeg holo passes; tiff hardening.

Meanwhile THIS repo ran its own campaigns on the same files (decompress trunc-fold jul01,
ljpeg passes, cr2 fused crop). **Two optimization programs on diverged copies of the same
code.** Every week this persists, effort is duplicated or stranded.

**Proposal.**
1. Declare `raw-converter-wasm/crates/raw-pipeline` the single source of truth (it is the
   superset: codec, video, streaming, perceptual, and the deeper parser hardening).
2. Tauri repos consume it by path dependency (same machine) or git dependency — delete
   their vendored copies. `casv_encode` sidecar precedent shows the desktop app can
   already consume this crate's binaries; the remaining Tauri-side uses (ingest,
   `encode_rgba16_jxl` command, pyramid client) move to the shared crate's API.
3. **Port-audit the holo wins** into the canonical crate. NOT mechanical — files diverged
   heavily (71K vs 182K pipeline.rs). Process per win: read the old-lineage diff, check
   whether the canonical crate already has an equivalent (it ran its own campaigns on the
   same files), re-derive on canonical code, gate with the original's proof method
   (byte-exact A/B + flipflop). Triage list: decompress-holo, pipeline-holo,
   demosaic-holo, ljpeg-holo, tiffharden, cr2slice, rgba16-fix, jxl_lowlevel-borrow.
4. Licensing rider: unification removes the GPL `jpegxl-rs` dependency from the Tauri
   lineage (canonical crate is BSD-clean own-FFI). Worth doing for this alone.
5. Freeze rule until done: no new optimization work on the old-lineage copies.

**Win.** Ends duplicated optimization spend; Tauri app inherits video/fable/streaming/
16-bit for free; GPL removed; K1–K6 automatically reach the desktop app.
**Gates.** Tauri app builds + ingest byte-parity vs its old copy on a fixture corpus
(where behavior intentionally differs — deeper hardening, colour fixes — enumerate and
sign off each). Each ported holo win keeps its original proof gate.
**Risk.** The two lineages' outputs may already differ subtly (old fork lacks 6 months of
fixes); the parity corpus will surface this — budget for a reconciliation pass, and treat
"which behavior is correct" as per-item user decisions, not silent adoption.

## S2 — One browser delivery engine (finish-or-delete the forks)

**Evidence.** QUESTIONS §003 + §002: tiled-decode-worker speaks a different protocol than
`PyramidWorkerPool` → pool watchdog marks workers Bad → **every tiled decode silently
full-decodes** (the parallel tiled path is dead); two WebGL 16-bit pipelines, both
broken/dead (webgl-pipeline.js can't even load — imports nonexistent symbols; inline GL
path shadowed by duplicate `redraw()` declaration); three lightbox implementations, two
filter engines with different tone math (band-limited vs unbounded shadows/highlights);
`format-detect.js` exists but the live worker re-implements its own sniffer (ARW/NEF/RW2
misroute to wrong decoders); main.js: ~30-field card expando state-bag, WorkerPool with
no cancel path, listener arrays that never shrink, `closeLightbox` leaving decodes running.

**Proposal.** One decision then mechanical consolidation:
1. **Engine of record decision** (already recommended in QUESTIONS: canonical =
   `web/lightbox/filter-engine.js` + modular `web/pyramid-gallery/` + `lightbox/pyramid-lightbox.js`).
   Delete `pyramid-gallery-grid.js` (dead, throws at module load), retire
   `pyramid-filter-engine.js` page after colour-parity check, single-source tone math.
2. Rewrite `tiled-decode-worker.js` to the pool's v1 protocol (load/ready/decode-reply,
   bytesId cache, format field) — the pool file is the contract; then route lightbox
   `loadLevel` through the tiled path for tiled levels.
3. WebGL: pick ONE 16-bit display path (fix webgl-pipeline.js against filter-engine's real
   `getMatrix()` 12-element layout, delete the shadowed inline GL) or drop GL for the
   JS-float path — decide by measuring; both currently dead so there is no regression risk.
4. `format-detect.js` becomes the only sniffer; worker.js consumes it; unknown magic =
   loud error (aligns with K1's decode_raw verdicts).
5. main.js state: WeakMap-backed `CardState`, `_lightbox` discriminated union, WorkerPool
   FSM with `cancel(id)` propagated from lightbox-close/card-delete, peepCache LRU.

**Win.** Tiled decode actually works (today it's paid for and dead); 16-bit display path
live; one colour math; leak class closed; wasted decodes on closed views stop.
**Gates.** flipflopdom for every perf-claimed piece; visual parity across
8-bit/JS-float/GL at same slider values; decode-count instrumentation proving the pooled
path is hit (QUESTIONS gives the exact assertion points).

## S3 — Memory-governed asset store

**Evidence.** Budgets are ad-hoc or absent: ~360 MB WASM heap at 24 MP all-flags (P7);
`prefixAccum` grows unbounded per full JXL; peepCache unbounded (hundreds of MB/session);
pass-pixel retention ~220 MB on long runs; file-picker persists bytes to IDB with a local
32 MB cap but no cross-key eviction; jxl-cache (OPFS) has quota handling but is the only
layer that does; `MAX_OUTPUT_BYTES_GUARD` is an arbitrary 1 GiB.

**Proposal.**
1. WASM side: `estimate_decode_peak_bytes()` preflight export + documented
   `RAW_DECODE_PEAK_BYTES` policy (memory-budget ADR); ProcessResult lazy `take_*`
   (RawDecodeSession demand-pull ADR) — largely superseded by K1 bands, keep for the
   flag combinations that still materialize whole buffers.
2. Browser side: one `AssetStore` abstraction over OPFS + IDB + in-memory caches:
   content-addressed, byte-budget with LRU eviction, `QuotaExceededError` policy in ONE
   place, `navigator.storage.estimate()`-aware. peepCache / file-picker bytes /
   pyramid level bytes / manifest cache become clients instead of owners.
3. Per-session decode-memory governor: cap concurrent live decoded frames (the
   scheduler already has HWM backpressure for in-flight bytes; this extends to retained
   pixels).

**Win.** Deterministic memory ceilings; long sessions stop climbing to OOM; one eviction
policy instead of five half-policies.
**Gates.** flipflopMem / performance.memory traces on scripted long sessions; no
functional regression on cache-hit paths (existing jxl-cache tests).

## S4 — Verification & hardening architecture (do BEFORE S5)

**Evidence.** Parsers (tiff/cr2/dng/ljpeg/decompress + casv/jxtc headers) process
untrusted bytes and have accumulated dozens of hand-patched overflow guards — evidence of
a live bug class with no fuzzing; `bridge.cpp` JXTC overflow patched but never
build-verified; only 2 tests for 2842-line src/lib.rs; repo root littered with ~15 loose
exes (4 MB each), 100+ ad-hoc .mjs/.ts bench scripts, logs — no CI gate distinguishes
"the suite" from scratch files.

**Proposal.**
1. **cargo-fuzz targets** per parser: `tiff::parse`, `cr2::decode_bytes`,
   `dng::decode_bytes`, `ljpeg::decode`, `decompress::decompress`,
   `parse_casv_header/footer/audio_box`, `parse_jxtc_header`. Seed with real-file
   prefixes. Run in CI (short) + nightly (long).
2. **Golden corpus + SHA ledger**: small checked-in real-file corpus (ORF/DNG/CR2
   single+multi-slice/EXR/TIFF + casv fixtures); CI asserts decoded-pixel SHAs and
   encoded-output SHAs (where deterministic — note libjxl MT nondeterminism, pin
   single-thread for the ledger).
3. **Parity oracle suite** formalized as one test family: band-vs-whole (exists),
   SIMD-vs-scalar per backend (fill the wasm gaps: scale_err/pixels_to_xyb pinned in the
   node bench-wasm harness), streaming-vs-batch video tiers (K5), lossless
   roundtrip == source.
4. **FFI ABI smoke test** (K6.5) wired into CI, not just local.
5. **Repo hygiene**: move loose benches to `bench/` or `tools/`, gitignore
   exes/logs/scratch, delete the stale `undefined/` dir and `node-cdp-*` temp dirs.
   Mechanical, one PR.

**Win.** The safety net that makes S5 (output-changing colour work) and S1 (fork
reconciliation) safe; converts the hand-patched-guard bug class into machine-found.
**Gates.** Fuzz targets run clean 24 h on current code (any find = fix first); ledger
green on both MSVC native + wasm32.

## S5 — Scene-referred colour core (AFTER S4 — every change is output-visible)

**Evidence.** Colour policy scattered with no owner: camera→sRGB collapsed at decode
(dng.rs drops black/white/iso/bits); CR2 per-model matrices disabled; `color_matrix` None
conflates absent/identity/Olympus; WB fallback magic constants (2.0/1.7) with no caller
signal; pre-LUT clamp discards highlight headroom; EXR HDR clamped before the constancy
engine; perceptual-constancy engine exists but unwired (LookOverrides lacks the field);
Comparer assumes 8-bit with no range contract. ~10 deferred ADRs all hang off this.

**Proposal** (staged, each stage golden-image-gated):
1. **`ColourPolicy` resolver** — one owner with explicit precedence: embedded matrix →
   per-make table → `CAM_TO_SRGB`; typed `ColorMatrix { Identity | Camera | GenericOlympus }`;
   WB fallback surfaced (`wb_from_camera: bool` + policy decision), validated
   AsShotNeutral.
2. **Calibrated scene-referred mode** (ADR-3): `RawImageMeta` carries black/white/iso/
   bits; "linear, not tone-mapped" decode mode; re-enable CR2 per-model matrices.
   Unlocks photogrammetry/ML linear-16 contract.
3. **Headroom-aware clamp deferral**: move the pre-LUT [0,1] clamp past matrix +
   highlight stages (deliberate reference-pipeline evolution; changes highlight
   rendering — golden approval workflow required).
4. **Perceptual Constancy wiring** (ADR-8) + EXR HDR through the engine, tone-map last.

**Win.** Colour correctness stops being folklore; new product surfaces (photogrammetry,
ML, HDR) get a real contract.
**Gates.** S4 golden corpus with a human-approval workflow for intentional shifts
(user is strict on colour parity — every stage needs explicit sign-off); per-camera
ground truth for level/matrix changes.

## S6 — LOD/ROI unification (AFTER K2)

**Evidence.** Three overlapping level-of-detail mechanisms, each with its own manifest
shape and decode path: progressive passes (quality LOD, jxl-progressive manifests),
pyramid levels (resolution LOD, pyramid manifests + choose-level logic ×2), JXTC tiles
(spatial ROI, native + facade). Consumers stitch them ad hoc (lightbox picks levels, grid
picks tiles, scheduler picks byte ranges); manifest lacks per-tier width/height; no
region entry point into the RAW pipeline.

**Proposal.**
1. One addressing model: request = `{level?, region?, quality?}`; one resolver maps it to
   bytes (progressive prefix | pyramid level | JXTC tile set) per what the stored asset
   supports. Manifest schema v2 carries per-tier pixel dims + capabilities; K2's
   encoder-emitted offsets are the quality axis.
2. `process_region(rect, lod)` entry over the already-pure per-pixel RAW pipeline
   (existing ADR) for editor ROI export.
3. Rider P3: CASV container v2 (u64 offsets — 4 GiB cap today; I-frame seek table) —
   video's face of the same addressing story.

**Win.** Lightbox/grid/AR/ML all speak one request language; new consumers stop
hand-stitching three manifest dialects.
**Gates.** Contract test: request → byte ranges → decoded pixels across all three
mechanisms; existing viewers unchanged behind the resolver.

---

## Sequencing

```
S1 (fork)  ──────────────►  everything else lands once, not three times
S4 (verify) ─────────────►  gates S5, hardens S1 reconciliation
S2 (delivery) ─ parallel with S3 (memory) — different files, both browser-side
S5 (colour) — after S4
S6 (LOD)   — after K2 (needs tier byte-range machinery)
K-wave unaffected: K2 → K1+K3 → K4; K5 parallel (+P1 rider); K6 incremental.
```

S1 first is non-negotiable strategically: every optimization landed anywhere else is
currently at risk of being landed on the wrong lineage or needing a second landing.

## Open decisions for the user

1. **S1 direction confirm**: canonical = raw-converter-wasm crate, Tauri repos consume by
   path dep, old copies deleted after parity. Any reason the desktop app must keep its
   own lineage (release cadence, stability freeze)?
2. **S1 behavior reconciliation policy**: where old/new lineages differ (colour fixes,
   hardening), default to canonical-repo behavior with a per-item exception list?
3. **S2 engine of record**: confirm `lightbox/filter-engine.js` + modular gallery as
   canonical (QUESTIONS evidence says yes); WebGL 16-bit path — fix or drop?
4. **S5 golden-approval workflow**: who signs off intentional colour shifts, and on what
   viewer (needs defining before stage 3 clamp-deferral work).
