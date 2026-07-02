# JOLT — JXL-Optimized Lossy Transport

**JOLT** is the lossy streaming profile of **CASAVA** — *Casabio's Video
Apparatus* — the video container
(`crates/raw-pipeline/src/casa_video.rs`; on-disk tag `CASV`, `.casv`). It is built for *quick and
efficient* video streaming: JXL VarDCT intra frames encoded with the chunked
constant-peak encoder, plus fresh-pixel **REPLACE-skip** P-frames (bbox or
tile) with in-loop reconstruction so encoder and decoder never drift.

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

## Not in scope yet

- **Rate control** (target-bytes/VBV → distance search) — designed in the
  video-codec spec §3.5, not built. JOLT is quality-targeted (distance).
- **Motion models / temporal prediction** beyond replace-skip — block-MC
  measured worse on real content; parked.
- **Browser playback** — CASAVA/JOLT is native-only (`not(target_arch =
  "wasm32")`); the browser side has Motion-JXL `EncodeAnimation` only.
- **Mux** (audio, seek tables beyond the frame index, MP4/WebM wrapping).
