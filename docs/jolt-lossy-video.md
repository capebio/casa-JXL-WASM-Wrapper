# JOLT — JXL-Optimized Lossy Transport

**JOLT** is the lossy streaming profile of **CASAVA** — *Casabio's Video
Apparatus* — the video container
(`crates/raw-pipeline/src/casa_video.rs`; on-disk tag `CASV`, `.casv`). It is built for *quick and
efficient* video streaming: JXL VarDCT intra frames encoded with the chunked
constant-peak encoder, plus fresh-pixel **REPLACE-skip** P-frames (bbox or
tile). Drift-freedom comes from REPLACE semantics plus source-frame change
detection: replaced regions are fresh decoder-side decodes, unchanged regions
stay at I-frame-level error, and errors never accumulate — the encoder never
decodes its own output (reconstruction is decoder-side only).

Additive lossy residual coding is proven **not** to work in JXL — the
perceptual model misjudges residual planes (see
`docs/superpowers/specs/2026-07-01-jxl-video-codec-design.md` §8). Coding real
pixels and replacing changed regions is the design that works.

## API (native, `jxl-codec` feature)

```rust
use raw_pipeline::casa_video::{jolt_encode, jolt_encode_stream_to, JoltPreset,
                               CasaVideoOptions, parse_casv_rate_box};

// Batch (all frames resident) -> header-format .casv
let casv = jolt_encode(&frames, w, h, 24, 1, JoltPreset::Balanced)?;

// Streaming to a sink (prev+current frame resident) -> footer format + rate box
jolt_encode_stream_to(&mut source, JoltPreset::Realtime, &mut file)?;

// Full knob set when presets don't fit:
let opts = CasaVideoOptions::jolt(JoltPreset::Quality); // then tweak fields
```

Presets:

| Preset | distance | effort | skip | use case |
|---|---|---|---|---|
| `Realtime` | 2.0 | 1 | tile 32 | live capture / screen share |
| `Balanced` | 1.0 | 3 | tile 32 | the measured default |
| `Quality`  | 0.5 | 4 | tile 32 | visually transparent |

All presets use GOP 24 and the auto change-detection threshold
(`default_thresh_for_distance`).

## Rate metadata

- **Header files** (`jolt_encode`, `encode_casv_video`, streaming-buffered):
  `CasvHeader.flags` — bit 0 = lossy, bits 8..15 = `round(distance*10)`,
  bits 16..19 = effort. Accessors: `CasvHeader::{is_lossy, lossy_distance,
  rate_effort}`. Lossless files keep `flags == 0` (legacy shape); decoders
  ignore the word entirely, so compatibility is unchanged in both directions.
- **Footer (streamed) files** (`jolt_encode_stream_to`): an 8-byte **CASR rate
  box** `[u32 'CASR'][u32 flags]` between the index and the footer. Legacy
  readers never look there; `parse_casv_rate_box` returns `None` for legacy
  files.

## Measured (2026-07-02, Ghana dashcam, 48 frames @ 1280×720, this machine)

`examples/jolt_bench.rs` (`build-msvc.ps1 run --release --example jolt_bench
--features jxl-codec`):

| tier | size | vs raw | enc ms/f | dec ms/f | dec fps | 24 fps? |
|---|---|---|---|---|---|---|
| JOLT Realtime | 4.04 MB | 3.0% | 60.1 | 18.1 | 55 | PASS |
| JOLT Balanced | 6.87 MB | 5.2% | 73.1 | 23.8 | 42 | PASS |
| JOLT Quality | 10.76 MB | 8.1% | 81.6 | 18.8 | 53 | PASS |
| lossless archive | 17.69 MB | 13.3% | 33.8 | 109.7 | 9 | over |

Every JOLT preset decodes 720p in real time single-threaded; the lossless tier
does not — that is exactly the gap JOLT exists to fill. (Encode is offline /
near-real-time; GOP-parallel encode multiplies throughput by core count.)

**Encode-side pass (2026-07-02, byte-exact except the effort fix):** the
encoder no longer decodes its own output (the in-loop `recon` was write-only —
detection runs on source frames; one full FFI decode per frame removed), the
batch lossy encoders are frame-parallel (`into_par_iter`, 4.3–5.6× measured on
this corpus) and honor `opts.effort` (batch Realtime/Quality bitstreams changed
deliberately; batch now equals streaming byte-for-byte per preset), and the
streaming loop reuses one `Encoder` handle + all per-frame scratch. Interleaved
binary flipflop (8 arms, agent-contended box, untouched-archive control ±7%):
streaming enc ms/f min-of-arms Realtime 57.8→42.6, Balanced 75.6→53.9, Quality
79.6→66.2. A default multi-threaded libjxl runner for streaming was measured a
regression/wash and rejected — see `docs/1 rejected optimizations.md` (CV-E6).

## Rate control (2026-07-03, landed)

JOLT can now target a **byte rate** instead of a fixed distance —
`CasaVideoOptions::streaming_bitrate(start_distance, target_bytes_per_sec)`
(or set `rate_control: Some(RateControl { .. })`). Streaming encoders only;
batch stays fixed-distance and the `None` default is bit-identical to before.

Implementation vs the spec §3.5 (which describes a per-GOP 1-D distance
*search* with probe encodes): the controller uses **closed-loop feedback**
instead — the finished GOP's measured bytes steer the next GOP's distance
(`d *= sqrt(actual/target)`, scaled by a leaky-bucket VBV term, clamped to
`[min_distance, max_distance]`), at **zero extra encode cost**. Converges
within a few GOPs. `StreamCtx::set_distance` rebuilds the reused encoder and
re-derives the auto change threshold at each GOP boundary.

Real 720p dashcam (`examples/jolt_rc_demo.rs`, GOP 12): a 1× target lands
+0.5%; a 0.5× target walks per-GOP rate 3245k→2211k→1850k→1392k B/s; a 2×
target walks 3245k→6226k B/s (94% of target by GOP 4).

## Square-atlas tile P-frames (JE-8, 2026-07-03, landed)

Lossy tile REPLACE payloads pack changed tiles into a ~square
`ceil(sqrt(n))`-column atlas (v2) instead of the old `t`-wide sliver (v1),
signalled by the high bit of the payload's leading `tile_size` u16
(`CASV_TILE_V2_BIT`). v1 payloads and the lossless residual tier stay v1
(fully back-compatible). Ghana 720p A/B (`examples/atlas_v2_flip.rs`):
t=16 size −6.5% / enc −61.1% / dec −41.8%; t=32 size −4.6% / enc −40.9% /
dec −24.7%; reconstruction unchanged. This also removes the CV-E6 blocker
(the sliver shape starved libjxl group parallelism).

## Browser playback (2026-07-03, landed)

`packages/casv-web` (`@casabio/casv-web`) decodes `.casv` in the browser
via any injected single-frame JXL decoder (pairs with `@casabio/jxl-wasm`
`createDecoder`): parses header/footer/index/rate-box, decodes I-frames,
and composites REPLACE bbox + tile (v1 sliver + v2 square) P-frames into a
running RGBA buffer. Lossless-residual and Fable tiers are guarded with
clear errors. See `packages/casv-web/src/index.ts` (`playCasv`,
`decodeCasvAll`, `CasvReader`).

## Not in scope yet

- **Motion models / temporal prediction** beyond replace-skip — block-MC
  measured worse on real content; parked.
- **Browser playback of the lossless residual + Fable tiers** — the JOLT
  lossy profile plays in the browser (above); residual tiers need RGBA16
  add-compositing and Fable needs a wasm braided-rANS decode.
- **Mux** (audio, seek tables beyond the frame index, MP4/WebM wrapping).
