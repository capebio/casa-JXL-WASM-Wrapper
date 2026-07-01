# Streaming Full-Res JXL Encode — Opportunity Map

- **Date:** 2026-07-01
- **Status:** investigation + strategy map (no build committed)
- **Context:** follow-on to the streaming preview pipeline (ORF+DNG) and the
  concurrency-evidence benchmarks. This maps the *last* untouched big buffer: the
  full-resolution JXL **encode**.

## 0. Why this thread

The streaming preview work made *preview-only* decodes ~6–19× lower peak. The JXL
concurrency benchmark then showed the remaining memory monster is **full-res
decode/encode** (~250 MB/worker, 6 GB @ 24 concurrent). Full-res exports are the one path
streaming never touched. If the encoder can take pixels incrementally, the *entire*
pipeline becomes compressed-in → compressed-out at O(band) memory.

## 1. Ground truth (verified by source audit)

### 1a. libjxl 0.12 supports streaming pixel INPUT — natively
`JxlEncoderAddChunkedFrame` + `JxlChunkedFrameInputSource` (`external/libjxl-012/lib/include/jxl/encode.h:981`, `:851`). Pull-based: the encoder calls back requesting aligned rectangles (`get_color_channel_data_at`, `:899`), `xpos/ypos` multiples of 8, `xsize/ysize` ≤ **2048**, internally one **256×256 group + 1-block border** at a time (`enc_frame.cc:1550`, `:1576`). Doc: *"encode a frame by providing pixel data in a chunked or streaming manner … especially useful when dealing with large images that may not fit entirely in memory."*

**Gates** (`CanDoStreamingEncoding`, `enc_frame.cc:1820`): fast speed tier + higher
butteraugli distance (not slow/low-distance), ≥ **8 groups** (> 2048 px), VarDCT or
lossless-modular, no noise/patches/progressive-DC/resampling, XYB/modular color. Engages
only when an **output processor** is also set (`encode.cc:2552`). Cost: streaming
*approximates* global heuristics (e.g. the X-quant multiplier is normally "computed based
on the full image", `encode.h:382`) → **"potentially at a cost in compression density."**

Whole-frame `JxlEncoderAddImageFrame` (`:723`) forces `streaming=false` (`encode.cc:2533`).
The Rust wrapper (`jxl_casaencoder.rs`) and the C++ WASM bridge both use **only** the
whole-frame path today. Getting native streaming = a **new wrapper path** around
`AddChunkedFrame` + `SetOutputProcessor` + a source that pulls demosaiced bands.

### 1b. The app already encodes independent tiles (JXTC)
`EncodeRgba8TileContainer` (`packages/jxl-wasm/src/bridge.cpp:1627`) loops tiles, each a
**fresh** `JxlEncoderCreate` with hardcoded sRGB + per-call distance/effort
(`EncodeStandaloneJxlTileRgba8`, `bridge.cpp:1492`). **No cross-tile global state** — a
JXTC file is independent codestreams + a byte-offset index (`jxl_casadecoder.rs:1128`).
Tiles are independently **decodable** → true ROI (`decode_jxtc_region`). Tile size 256
(ladder) / 512 (massive-scan). Blocker to streaming: it takes one whole-image `pixels`
pointer and memcpys tile rects out (`bridge.cpp:1662`); JXTC index precedes payload (needs
buffered-compressed-tiles or seek-back). Cost: 1 px seam blend + slight per-tile overhead
(no shared context). JXTC encode currently exists **only in the C++ WASM bridge**.

### 1c. Current encode peak memory (24 MP)
Two non-overlapping peaks: **tone** (`rgb16` 144 MB + `rgb8` 72 MB ≈ 216 MB; +`raw` 48 MB
native) and **encode** (`rgb8` 72 MB + libjxl's internal copy expanded to **~288 MB
float** VarDCT working set). Dominant allocation overall = `rgb16` (144 MB); at the encode
instant = libjxl's float working set. Irreducible: the **compressed output** must
accumulate (can't discard mid-encode). `demosaic_rggb_mhc_band` (halo-padded band demosaic,
`demosaic.rs:1232`) already exists; `dng::decode_bytes_demosaiced` chains it per-band but
still writes a full-frame buffer (test-only, half-streaming).

## 2. The core unlock

**End-to-end streaming, compressed-to-compressed:**
`decode band → demosaic band (halo) → tone band → encode band (pull) → discard`.
No full-res buffer at *any* stage. Peak = O(band) + the compressed output. Closes the last
big buffer. Combined with the decode streaming already shipped, the *whole* RAW→JXL
pipeline becomes bounded-memory.

## 3. Two routes (real tradeoff)

| | Route A — libjxl chunked frame | Route B — JXTC tile-stream |
|---|---|---|
| Output | **Standard single JXL** (any decoder) | JXTC container (app decoder only) |
| Reuse | New wrapper (`AddChunkedFrame`+output proc) | Existing independent-tile machinery |
| Peak | O(256² group + border) | O(one tile row) |
| Bonus | — | **True ROI decode** falls out |
| Cost | slight density loss; gated to fast tier/higher distance/VarDCT/>2048 px | 1 px seams + per-tile overhead; non-standard format |
| Best for | universal export, gigapixel single-file | ROI editing, tiled viewers |

Not mutually exclusive — Route A for the deliverable JXL, Route B where ROI matters.

## 4. Implications (concrete)
1. **Full-res exports become low-peak** — 24 MP export drops from ~288–450 MB to tens of MB.
2. **Full-res batch concurrency** — the memory monster (6 GB @ 24 in the bench) goes flat;
   the memory-weighted scheduler budget now packs many concurrent *full* exports, not just
   previews. The `orf_jxl_batch_concurrent` "~N× memory" warning is defused for the full path.
3. **wasm32 unblocks large images** — an image too big to hold decoded+demosaiced+encoded in
   the 2–4 GB heap becomes encodable (never materialized). Category unlock.
4. **Fusion may also be faster** — one band pass has better cache locality than three
   full-frame passes (decode/demosaic/tone/encode each streaming a huge buffer).

## 5. Moonshots
1. **Gigapixel-in-browser.** Streaming decode + streaming encode = process arbitrarily large
   images (astro, microscopy, gigapixel panoramas) in a fixed ~100 MB budget. Today
   impossible — the frame doesn't fit. Handle images 10–100× larger than RAM.
2. **Constant-memory transcode farm.** Server-side RAW→JXL at O(band)/worker → pack 10–50×
   more concurrent transcodes per box. Memory-bound service → core-bound service.
3. **Live capture → JXL.** Encode a sensor stream band-by-band *as it arrives* — first
   compressed bytes out before the last sensor row is in. Line-scan/push-broom/scanning-back
   capture pipelines; sub-frame latency.
4. **Video codec (already in flight, `docs/jxl-video-codec-jul01`).** Per-frame JXL encoded
   band-by-band at bounded memory → many frames in flight → RAW-burst→video / timelapse at
   constant memory. Streaming encode is the missing piece that makes per-frame-JXL video
   memory-viable.
5. **ROI-native gigapixel editor** (Route B). Independent tiles + streaming = decode/re-encode
   only edited tiles, never the whole image. Browser editing of gigapixel images.
6. **Encode-side progressive.** Streaming encode + group-order/progressive-DC plumbing
   (`jxl_casaencoder.rs:616`) → emit a usable low-res preview from the first bands while the
   full encode continues.

## 6. Risks / honest costs
- Route A: measurable compression-density loss (approximated global heuristics); gated to
  fast tiers, higher distance, VarDCT, > 2048 px. **Benchmark the density delta** before
  committing — it may be unacceptable for archival/lossless.
- Route B: non-standard container, seam artifacts, per-tile overhead; only wins where ROI
  or extreme size matters.
- Small images (≤ 8 groups) don't benefit and don't need to.
- Real implementation: a new `AddChunkedFrame` wrapper + a pull-source driving a fused
  decode→demosaic-band→tone-band loop, plus WASM-bridge parity. Non-trivial.

## 7. Recommended sequence
1. **Density-cost benchmark first** (cheap, decisive): encode a corpus whole-frame vs
   `AddChunkedFrame`-streaming at matched fast-tier/distance; measure size delta + peak RSS
   + Butteraugli. If density loss is small at the app's export settings (e3, d1.0), Route A
   is green. (Same evidence-first discipline as the concurrency benches.)
2. If green → **brainstorm the streaming export** (Route A) as a spec: the chunked-frame
   wrapper + the fused band pipeline (reuse `demosaic_rggb_mhc_band` + per-band tone).
3. Route B (JXTC streaming + ROI) as a separate follow-on where ROI/gigapixel is the goal.
4. Feed the finding into the video-codec branch (streaming encode = its bounded-memory
   per-frame path).
