# HANDOFF — Pipeline Restructure (RAW → Image / Video), 2026-07-06

Implementation handoff for the architectural restructure agreed 2026-07-06. Source analysis:
full read of `QUESTIONS.md` (2497 lines), video/pipeline sections of `Questions_deferred.md`,
and the live seams (`src/lib.rs`, `crates/raw-pipeline/src/{pipeline,stream_band,stream_export,
stream_preview,casabio_encode,casa_video,fable_braid,jxl_casaencoder,jxl_casadecoder,cr2,dng,
decompress,ljpeg,tiff}.rs`, `crates/raw-pipeline/src/bin/casv_encode.rs`, `packages/casv-web`).

## Mission

Unify three separately-built worlds — image ingest (batch, whole-frame), streaming export
(`stream_band`, O(band)), and video (`casa_video`: JOLT lossy / FableBraid + JXL-residual
lossless) — around one decode spine, one encode pass per image, and one buffer owner.
Targets: throughput (fewer encodes, fewer decodes), memory (O(band) / O(2 frames) peaks),
and integration (RAW can feed video; every video tier can stream; contracts single-sourced).

## Required reading before touching code

- `CLAUDE.md` (repo root) — layer invariants, reject-on-sight list, branch rules.
- `~/.claude/CLAUDE.md` — worktree isolation rules (one writer per tree; subagents/long runs
  work in their own `git worktree`).
- `QUESTIONS.md` — the ADR drafts referenced per keystone below.
- `docs/rejected optimizations.md` + `docs/1 rejected optimizations.md` — do-not-relitigate.
- `docs/superpowers/specs/2026-07-01-jxl-video-codec-design.md` — CASV/JOLT design decisions
  (Architecture A = independent codestreams; REPLACE semantics; additive lossy residual
  proven broken).

## Ground rules

- **Worktree per keystone.** `git worktree add ../rcw-<keystone> <branch>`. Never checkout /
  reset / rebase in the user's primary checkout. Branch from the freshest head — run
  `git log --oneline main..perf/casv-video-simd-v2-jul05` first; if the perf branch is ahead,
  branch from it, not `main` (see CLAUDE.md Branch Management).
- **Byte-exactness gates.** Any refactor of an existing output path must produce byte-identical
  bytes (encoded files, decoded pixels) unless the keystone explicitly changes the format —
  then it needs the stated quality gate + migration.
- **Perf claims need flipflop.** ≥5% geomean on the standard corpus (`flipflop.mjs`,
  browser paths via `flipflopdom.mjs`). Memory claims: `flipflopMem.mjs` / peak-RSS probe.
- **Builds.** Native: `.\build-msvc.ps1 check` / `.\build-msvc.ps1 test` (MSVC toolchain is
  default; GNU broken). MSVC builds of the sidecar must run from the crate dir, not `-p` from
  root. WASM: `wasm-pack build --target web --out-dir pkg --release` (raw WASM);
  `node packages/jxl-wasm/scripts/build.mjs` for the libjxl bridge (Emscripten, see CLAUDE.md).
- **Tests.** `cargo test -p raw-pipeline` (native, ~309 lib tests incl. 40 casa_video);
  `streaming_export_bytes_equal_whole` in `stream_export.rs` is the template for
  band-vs-whole parity tests.

## Current architecture (verified map)

```
IMAGE  RAW bytes ─ tiff/cr2/dng parse ─ decompress|ljpeg ─ demosaic ─ pipeline.rs tone ─┐
       │                                                                                ├─ casabio_encode::encode_variants — 3 INDEPENDENT JXL encodes (thumb e1 / preview e3 / full e3)
       │                                                                                ├─ encode_rgba8_pyramid — per-level resize+encode, all levels resident
       │                                                                                └─ stream_band → stream_export::encode_chunked — O(band), ORF+DNG ONLY
       └─ src/lib.rs WASM: process_{orf,dng,cr2}_with_flags → ProcessResult (thumb+lightbox+full+full16 simultaneously resident)

VIDEO  ffmpeg PNG stdout ─ PngChunker ─ image-crate PNG decode ─┐            (bin/casv_encode.rs)
                                                                ├─ JOLT lossy: encode_casv_video_streaming — 2-frame ping-pong, chunked I-frames,
                                                                │  REPLACE bbox/tile P-frames, VBV RateControl + tile admission. Footer format + CSAU audio.
                                                                ├─ JXL lossless residual tiers: BATCH ONLY (drain_all → whole video resident, header format, NO audio)
                                                                └─ FableBraid (encode_casv_fable_rgb8): BATCH ONLY, rayon, all frames resident. Browser playback THROWS (casv-web fable = native-only).
```

Key seam facts an implementer must know:

- `RawRowSource` trait: `decompress.rs:247`. Impls: `OrfRowDecoder` (`decompress.rs:257`,
  raster forward-only), `DngRowSource` (`dng.rs:240`, phased CFA, tile-row banding).
  **No CR2 impl** (see format matrix below).
- `StreamingBandSource` (`stream_band.rs`): rolling raw + rgb8 windows, 256-row sub-chunks,
  8-row spatial halo (NR 2 + clarity 6) + 2-row demosaic halo. Compiles for wasm32.
  Byte-identical to whole-frame (tested). `stream_export.rs` bridges it to
  `jxl_casaencoder::encode_chunked` (libjxl pulls ≤2048-row super-tiles monotonically).
- `casa_video.rs` streaming (`stream_ctx`) is **lossy-REPLACE only** — Lossless and
  `SkipMode::None` are rejected → `casv_encode` drains all frames for those tiers.
- `VideoFrameSource::next_frame_into` exists for ping-pong reuse but `FfmpegPngSource`
  does NOT override it (fresh `Vec` per frame from the image crate).
- `fable_braid.rs` compiles native + wasm32; `casv-web` has no fable decode (injected
  decoder is JXL-only) and hand-mirrors all CASV constants.
- casv index entry: `u32 offset | u32 (len | flags)` — top nibble of len = flags ⇒
  4 GiB file cap, 256 MiB/frame cap (relevant to follow-up P3, not this handoff).

## Format row-band support matrix (K1 constraint — READ THIS)

| Format | Bitstream order | Forward raster row-band? | K1 strategy |
|---|---|---|---|
| ORF | Raster rows, serial predictive Huffman | **Yes** — `OrfRowDecoder` shipped | True streaming; peak = raw halo window + band |
| DNG | Strips/tiles | **Yes** — `DngRowSource` shipped (tile-row granularity) | True streaming; peak = one tile-row + band |
| CR2 single-slice (`CR2Slices` all zero) | Raster rows (LJPEG SOF3) | **Yes** — feasible, not yet implemented | `Cr2RowSource` decoding LJPEG rows forward |
| CR2 multi-slice | **Stacked vertical slices**: slice 0's whole `nw×h` block, then slice 1's… (`cr2.rs:1156-1203`). Serial Huffman, **restart markers explicitly unsupported** (`ljpeg.rs:564`) | **No** — raster row r needs samples from every slice, spread across the whole serial bitstream; cannot seek | **Resident-mosaic row source**: decode the whole LJPEG into the stacked u16 buffer (2 B/px), then serve raster rows lazily using the `reassemble_slices_crop` row math (`cr2.rs:768` — already row-wise). Peak = mosaic (2 B/px) + band, vs today's mosaic + full rgb16 (6 B/px) + full rgb8 (3 B/px). At 24 MP: ~48 MB + band vs ~264 MB. |

The `RawRowSource` **interface is uniform** for all four cases; only the peak-memory class
differs. Expose it: add `fn peak_class(&self) -> PeakClass { Banded, ResidentMosaic }` (or a
doc contract) so callers/budgeting can reason about it. Do NOT attempt slice-parallel LJPEG
decode (no restart markers, serial predictor — invalid).

---

## K1 — One ingest spine: `decode_raw()` + row-bands everywhere

**Goal.** Single decode entry; `RawRowSource` becomes the canonical decode abstraction for
all formats; batch ingest routes through `StreamingBandSource` (batch = drain bands).

**Changes** (all in `crates/raw-pipeline/src` unless noted):

1. **`tiff_io` shared module.** Extract endian-aware bounds-checked readers + typed IFD
   walker; route the Olympus sub-IFD parsers and cr2/dng hand-rolled IFD loops through
   `tiff.rs::visit_ifd`. ADR: `.epiccodereview/20260623T013020Z/global/adr_draft/`
   `duplicated-tiff-endian-ifd-readers.md`. This kills the bounds-drift bug class that has
   been hand-patched three times.
2. **One `Cfa` phase type** populated by every front-end (ORF explicit RGGB instead of
   silent assumption). ADR: `cfa-pattern-three-representations.md`. Kernels are already
   phase-aware; the gap is type ownership.
3. **`decode_raw(&[u8]) -> Result<RawSession, RawError>`** dispatcher. Magic sniff:
   `II*\0`+`CR`@8 → CR2; `IIR` → ORF; TIFF-like `II*\0`/`MM\0*` → DNG; else typed error
   (no silent ORF fallback — this is the same misroute `web/worker.js` has; fix the WASM
   side to consume the same verdicts, see K6). `RawSession` = parsed metadata (dims, WB,
   black/white, `Cfa`, EXIF) + `fn row_source(&self) -> Box<dyn RawRowSource + '_>`.
   ADR: `no-unified-raw-decode-entry-point.md`.
4. **`Cr2RowSource`** per the matrix above: single-slice = forward LJPEG row decode;
   multi-slice = whole-LJPEG stacked decode + lazy row reassembly (reuse the
   `reassemble_slices_crop` per-row source math verbatim — it is already the row-wise
   form). Respect the `decoded_width == stride` guard (QUESTIONS `000-logic-22`) — bail,
   don't guess, when they disagree.
5. **Batch = drained bands.** Route the batch ingest path (native Tauri ingest; the
   `process_*_impl` full-res outputs in `src/lib.rs` where flags request them) through
   `StreamingBandSource` for all three formats. Whole-frame `demosaic → process` stays
   only as the parity oracle in tests.
6. `stream_export.rs`: add `export_cr2_jxl_streaming` (generic over the new source — the
   existing generic entry may only need the impl + a thin wrapper).

**Gates.** Byte-identical decoded output + encoded bytes vs current path on real
ORF/DNG/CR2 corpus (extend the `streaming_export_bytes_equal_whole` pattern; CR2 needs a
real multi-slice file, e.g. 5D-era `CR2Slices=[2,1728,1888]`). No perf gate required
(structural + memory win) but flipflop throughput to catch regressions.

**Risks.** CR2 crop geometry (000-logic-22 dual-width hazard — contained by the equality
guard); DNG phased-CFA band path already exists, don't fork it.

## K2 — One encode per image: progressive tier derivation

**Goal.** Stop encoding the same pixels three times. Tiers become byte ranges of one
progressive codestream.

**Base ADR.** `.epiccodereview/20260619T130329Z/global/adr_draft/single-pass-progressive-encode.md`
(one progressive encode: ProgressiveDc + GroupOrder + encoder-emitted byte offsets; retire
the `profileJxl` post-encode re-decode). Expected ≈2/3 ingest encode-CPU + storage cut.

**Recommended shape (differs from ADR in one point — thumb):** keep the physical ≤300 px
thumb as a separate tiny e1 encode (decoding a DC prefix of a full-res stream is slower
than decoding a 300 px image — gallery latency must not regress), and collapse
**preview+full**: preview = progressive prefix (DC / first AC pass) of the full-res
codestream. Net: 3 encodes → 2, and the expensive full-res one is single. A/B the
alternative (pure single-stream, thumb from DC) — adopt only if thumb decode latency holds.

**Changes.** `casabio_encode.rs` (`VariantSet` grows `full_offsets: Vec<u32>` / tier byte
ranges; `encode_variants*` gains the fused path behind an option, old path kept for A/B +
migration), `jxl_casaencoder.rs` (emit per-pass/TOC byte offsets — libjxl frame-index /
codestream TOC), `packages/jxl-progressive` manifest (`byteEnd` per tier from encoder, not
from re-decode profiling; note `byteStart` is a dead field — resolve it here), Tauri ingest
caller. Fold in the **pyramid downscale→encode fusion** ADR
(`pyramid-downscale-encode-fusion.md`): stream per-level downscale+encode, release each
level before computing the next.

**Gates.** Per-tier Butteraugli/ΔE vs current tier files (use `.flipflop/tests/photon-qprogac.mjs`
+ its `.verify-quality` sibling); prefix-decode latency A/B for preview/thumb
(flipflopdom); stored-format migration plan (old VariantSet consumers).

## K3 — `FramePipeline` owner (buffer pool + compiled look)

**Goal.** One struct owns every reusable buffer + the compiled LUTs; frames/files stop
allocating 40–150 MB per item. This is the "sequence-state owner above this file" that
three separate deferred logs independently request (decompress `_into` adoption,
pipeline-holo worker-owned RenderState, enc_fast_lossless lifecycle).

**Changes.** New `crates/raw-pipeline/src/frame_pipeline.rs`:

```rust
pub struct FramePipeline {
    raw: Vec<u16>,        // pooled mosaic buffer (decompress_into / ljpeg into)
    band16: Vec<u16>,     // demosaic band scratch
    band8: Vec<u8>,       // toned output band
    payload: Vec<u8>,     // encode payload scratch
    look: CompiledLook,   // pre-LUTs + post-LUT, split cache keys
}
```

- `_into` variants: `decompress_into` exists on the sibling-repo branch only — add it here
  if absent (same shape: caller buffer, full overwrite). `demosaic_*_into`, `process_into`
  already exist; `encode_variants_from_rgb16_owned` (`casabio_encode.rs:953`) already
  avoids the unsharp clone — use it.
- `CompiledLook`: split the LUT-cache key into pre-LUT (black/WB/exposure) vs post-LUT
  (tone/contrast) so a contrast-only edit doesn't rebuild pre-LUTs. Replaces reliance on
  the global `Mutex<HashMap>` 8-entry cache for sequential consumers.
- Adopt in: batch ingest loop (per-file reuse) and K4's `RawVideoSource` (per-frame reuse).
- **Scope guard:** reuse wins on SEQUENTIAL paths only. Do NOT thread this into the
  rayon-parallel batch tile encoders — measured 0.88–0.95× regression (see memory:
  "CASV video: reuse REJECTED"; rejected ledger).

**Gates.** Byte-identical outputs; peak-RSS before/after (flipflopMem / OS probe) on a
20-file batch and a 500-frame video encode.

## K4 — RAW→video bridge: `RawVideoSource`

**Goal.** RAW sequences (time-lapse) feed CASV directly; no PNG/ffmpeg detour.

**Changes.**

- New `RawVideoSource` implementing `VideoFrameSource` (`casa_video.rs:729`): input = list
  of RAW file paths (or byte buffers); per frame: `decode_raw` (K1) → `FramePipeline`
  (K3) band drain → RGB8 into the ping-pong buffer via **`next_frame_into` override**
  (this is the whole point — no per-frame alloc). Fixed `LookParams` per sequence →
  `CompiledLook` built once.
- **No temporal smoothing in this keystone (decided 2026-07-06).** Fixed LookParams per
  sequence already yields flicker-free, maximally-similar frames. Adaptive-exposure
  smoothing (day-to-night time-lapse) is a future feature needing its own spec + A/B
  (flicker metric, size win) per the no-evidence-free-tunables rule. Do NOT add a
  speculative `LookSource` seam — look derivation stays one function.
  Separate standalone bugfix (not gated on any of this): `auto_wb_rggb` doc/stride
  mismatch (says 4×4 sampling, strides 8) — see `Questions_deferred.md` 2026-07-05
  pipeline audit.
- `frame_stats` frameHash (stable contract — do NOT alter the hash) as the cheap
  scene-cut trigger: hash delta above threshold → force I-frame (feed into GOP logic).
- `bin/casv_encode.rs`: new `--raw-frames <out> <fps...> <opts...> <files...>` mode wired
  to `RawVideoSource` + the streaming encoder.
- Resolution: RAW full-res is huge for video — reuse the existing dim handling (`dim`
  arg → StreamingBoxDownscale from `stream_preview.rs`, or the band-level downscale) to
  target e.g. 4K before encode.

**Gates.** E2E: ORF sequence → `.casv` → plays in `casv-web` and decodes natively
byte-consistent; encode peak ≈ 2 frames + band (measure); per-frame RGB8 output
byte-identical to the still-image path given the same LookParams (cheap, strong
correctness check — fixed-look design makes this exact).

## K5 — Streaming becomes the only video engine

**Goal.** Every tier streams; audio works everywhere; container writing exists once.

**Changes** (`casa_video.rs`, `bin/casv_encode.rs`):

1. **FableBraid streaming encoder.** Trivially streamable (`encode_rgb8_delta` needs only
   prev frame). Add fable arm to the streaming loop (or a sibling `stream_ctx` variant);
   footer format + CSAU audio then work for fable. Batch `encode_casv_fable_rgb8` stays
   for the rayon-parallel resident case (it's faster when frames are resident — keep both,
   share the container writer).
2. **JXL lossless residual tiers streaming.** Residuals are computed vs the previous
   SOURCE frame (lossless ⇒ decoder reconstruction == source, drift-free), so only prev
   frame need be resident. Extend `stream_ctx`/`encode_stream_frame` to accept
   `VideoRate::Lossless` with bbox/tile/none skip. Keep byte-parity with the batch tier
   where frame processing order is identical (it is — serial).
3. **`FrameSink` extraction.** One writer owning header-vs-footer format, index building,
   CASR rate box, CSAU audio box. Today this logic is written ~4× (batch assembler,
   streaming in-memory, streaming-to-sink, fable assembler). Refactor gate: existing
   encoders' bitstreams byte-identical.
4. **`RateControl` generalization.** Lift out of `stream_ctx` into a per-frame
   `on_frame(bytes)` feedback wrapper usable by any tier (enables bitrate shaping for
   lossless via tile admission scheduling).
5. `casv_encode`: `drain_all` remains only for `proxy*` (genuinely frame-parallel).

**Gates (decided 2026-07-06 — two classes, do not conflate):**
- FrameSink refactor of EXISTING encoders (pure container-writer move): whole-file
  byte-identical, SHA compare on a fixture corpus. Non-negotiable.
- NEW streaming-lossless writer: whole-file byte-parity with batch is impossible by
  design (footer format + CSAU audio vs header format silent). Contract is the lossless
  one: (1) decoded frames == SOURCE frames, byte-exact, every frame; (2) size sanity
  ≤ ~+2% vs batch tier; (3) container parses in native decode + casv-web; (4) per-frame
  payload parity vs batch as a non-contractual canary test only (sequential encoder
  reuse is proven byte-identical, so it should hold initially — but libjxl has
  documented run-to-run MT nondeterminism, and a parity CONTRACT would forbid future
  streaming-side improvements like GOP parallelism). Audio present on lossless tiers
  post-change.

## K6 — Single-source the cross-language contracts

1. **`LookParams` across the FFI (shape decided 2026-07-06).** Replace the 13–17
   positional f32s on `process_*_with_flags` / `apply_look` / `LookRenderer` with a
   **plain JS named-field object** parsed by a hand-written
   `LookParams::from_js(&JsValue) -> Result<LookParams, JsError>` (js_sys
   `Object::keys` walk): **unknown key → JsError** (kills the silent-typo class),
   missing key → default (forward-compatible when params grow). Zero new deps — the
   WASM crate has no serde and should not gain one for this (verified: Cargo.toml has
   no serde; binary size matters). Rejected alternatives: Float32Array layout
   (recreates the positional-index hazard), `#[wasm_bindgen]` class setters (typo'd
   setter = silent expando + `.free()` footgun). serde-wasm-bindgen with
   `deny_unknown_fields` is the acceptable drop-in later if hand-parsing annoys —
   same JS-visible contract, so swappable without touching callers. Keep old
   positional exports as thin deprecated wrappers (JS callers in `web/worker.js`,
   `web/main.js` migrate). QUESTIONS: "17 positional args" worker.js question +
   `000-structure-h8i9j0`.
2. **`encodeOptionsToStartMsg()` mapper** in `packages/jxl-session` + the ~15 missing
   wire fields on `MsgEncodeStart` in `packages/jxl-core/protocol.ts` + consumption in
   both workers. Three-package atomic change. ADR:
   `.epiccodereview/20260617T202430Z/sections/002/adr_draft/encode-options-normalization-utility.md`
   + field-coverage unit test.
3. **CASV constants single source.** Emit `casv-format.json` from the Rust crate (build
   script or checked-in generated file) and generate/validate `packages/casv-web`
   constants from it; minimum bar: a parity test that fails when either side drifts.
4. **FableBraid wasm export + browser playback.** `fable_braid` already compiles wasm32.
   Export stateful decode (`FableDeltaSession` handle: `decode_intra` / `decode_delta`
   mirroring `DeltaDecodeSession`, `fable_braid.rs:1263`) via wasm_bindgen in `src/lib.rs`;
   add the fable arm to `casv-web` using the injected-decoder pattern (needs a session,
   not a pure function — extend `JxlFrameDecoder` injection to an optional
   `FableSessionFactory`).
5. **FFI ABI smoke test.** Assert every facade-called symbol exists with the right arity
   at build/test time (root cause of the metadata arg-shift HIGH bug). ADR:
   `adr-ffi-abi-contract-test.md` (sections/014).

## Sequencing

1. **K2** — self-contained, biggest measured win, ADR drafted. Can start immediately.
2. **K1 + K3 together** — one refactor seen from two sides (spine + owner).
3. **K4** — after K1/K3 land (needs band engine + pool).
4. **K5** — independent of 1–3; parallel-safe in its own worktree (casa_video internal).
5. **K6** — incremental; do #5 (ABI test) and #1 (LookParams) early, they're insurance.

Keystones in separate worktrees; each lands via its own branch + PR; merge order per above.

## DO NOT (measured/proven dead — reject on sight)

- Encoder-owned reconstruction to skip DecodeFrame in lossy patch roundtrip — encoder has
  no decoder-exact floats; only the lossless skip was valid and is ALREADY LANDED.
- Persistent cross-frame JXL patch-atlas / reference slots — CASV is Architecture-A
  independent codestreams; design doc parks it.
- Additive lossy residual through VarDCT — proven broken; REPLACE semantics is the design.
- Encoder/scratch reuse inside rayon-parallel batch tile encoders — measured slower.
- Changing `frame_stats` frameHash algorithm/lane-order/endianness — hard stable contract.
- Everything in CLAUDE.md "Recurring False Claims" (pixel pools on transferred
  ArrayBuffers, facade drain callbacks, per-stage budget resets, soft preemption, …).

## Open decisions for the user (ask before implementing that part)

1. ~~K2 thumb shape~~ **DECIDED 2026-07-06: physical thumb kept** (separate ≤300px e1
   encode; preview+full collapse to one progressive stream; 3→2 encodes). Rationale:
   thumb is an index-card artifact class (grid/ML/AR) — DC prefix of a full-res stream
   is 5-15× the bytes and a full-frame-scale decode per grid card; encode/storage saved
   by dropping the physical thumb ≈ zero. Tiers-as-byte-ranges machinery unchanged, so
   collapsing further later is a one-line writer change if an A/B ever justifies it.
2. ~~K4 temporal smoothing~~ **DECIDED 2026-07-06: deferred entirely** (not even a
   default-off flag). Fixed look per sequence is flicker-free by construction; adaptive
   smoothing = future spec with its own A/B. See K4 section.
3. ~~K5 parity~~ **DECIDED 2026-07-06: decode-equality is the contract for the new
   streaming-lossless writer** (decoded frames == source byte-exact + size sanity +
   parse tests; per-frame payload parity = canary only). Whole-file byte-parity with
   batch is impossible by design (audio + footer format). FrameSink refactor of
   existing paths stays byte-identical, non-negotiable. See K5 gates.
4. ~~K6 LookParams shape~~ **DECIDED 2026-07-06: plain JS named-field object + manual
   `from_js` validation (unknown key → error, missing → default), zero new deps.**
   See K6.1.

All four open decisions are now resolved — no user input required to begin
implementation. Remaining judgment calls inside keystones are marked inline with
their gates.
