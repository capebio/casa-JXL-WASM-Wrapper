# Streaming JXL Export — P2: WASM-bridge parity (gigapixel-in-browser)

> Follow-on to P1 (native ORF/DNG streaming export, DONE + byte-exact) and the spatial
> band-halo pass (DONE + byte-exact). This plan ports the **proven** native streaming encode
> to the browser so full-res / gigapixel RAW→JXL export runs at O(band) memory in WASM.

**Status:** PLAN ONLY (first P2 commit). Multi-session. Needs the emscripten toolchain
(~34 min build/verify cycle) — see CLAUDE.md build notes.

---

## Ground truth (verified 2026-07-01, worktree m2r7)

**Native side is done and proven byte-exact — it is the reference contract for P2:**
- `crates/raw-pipeline/src/jxl_casaencoder.rs`: `encode_chunked(&mut dyn ChunkedColorSource, out)`
  via `JxlEncoderSetOutputProcessor` + `JxlChunkedFrameInputSource` pull. Byte-identical to
  whole-frame at every effort × distance, lossy AND lossless (density +0.00%), −60 MB peak.
- `crates/raw-pipeline/src/stream_export.rs`: `StreamingExportSource<S: RawRowSource>` —
  rolling raw window (forward-only) + demosaic band + (tone) or (NR→unsharp→tone) + rolling
  rgb8 window. Constant-peak (O band, height-independent). **`#![cfg(not(target_arch =
  "wasm32"))]` — native only** (it depends on `jxl-ffi`, native-only).

**Browser side today (`packages/jxl-wasm/src/bridge.cpp`):**
- Encode = `EncodeRgbaWithMetadata` → **whole-frame** `JxlEncoderAddImageFrame` over a single
  rgb buffer on the WASM heap. No `JxlEncoderAddChunkedFrame`, no `JxlChunkedFrameInputSource`,
  no `JxlEncoderSetOutputProcessor`. The `JXL_ENC_FRAME_SETTING_BUFFERING` knob already exists.
- RAW pipeline (`src/lib.rs` WASM crate) produces rgb8 whole-frame; demosaic / tone / NR /
  unsharp are all available in WASM (they are not native-gated). Only the *streaming glue*
  (`StreamingExportSource`, `encode_chunked`) is native-only.

**Encode knobs that make streaming byte-exact (from native + libjxl encode_test.cc):**
buffering = 2, `OUTPUT_MODE` = 0, `USE_FULL_IMAGE_HEURISTICS` = 0, drive via
`AddChunkedFrame(is_last)` (NOT CloseInput/FlushInput), input-source `release_buffer` MUST be
non-null (null → access violation), pull = ≤2048-row super-tiles, monotonic ypos, border overlap.

---

## Target architecture (three cuts, each independently committable + verifiable)

### P2a — bridge.cpp chunked encode (C++), whole-buffer input first
Add a streaming *output* path while still handing libjxl a whole pixel buffer, to isolate the
output-processor wiring from row production. New FFI (EMSCRIPTEN_KEEPALIVE):
- `EncodeRgbaChunked(rgb, w, h, ch, distance, effort, <knobs>) -> JxlWasmBuffer*` that uses
  `JxlEncoderSetOutputProcessor` + a `JxlChunkedFrameInputSource` reading from the passed
  buffer (mirror native `encode_chunked` / `WholeImageSource`), buffering=2, OUTPUT_MODE=0,
  USE_FULL_IMAGE_HEURISTICS=0, non-null release_buffer.
- **Verify:** emscripten build; node/browser parity — `EncodeRgbaChunked` bytes == existing
  `EncodeRgbaWithMetadata` bytes for the same pixels/effort/distance (this is the WASM analogue
  of the native `streaming_export_bytes_equal_whole`). Gate = byte-identical.

### P2b — WASM band producer (Rust, `src/lib.rs` WASM crate)
The RAW→rgb8 band pipeline without the native jxl-ffi dependency. Options (pick in build):
1. Factor the row-source + band demosaic/tone/NR/unsharp of `StreamingExportSource` into a
   codec-independent core usable from WASM (the JXL encode stays in bridge.cpp, so no jxl-ffi
   needed on the Rust side). Re-gate the *pixel* half away from `not(wasm32)`.
2. Or a thin WASM `export_band(ypos, ysize) -> rgb8` API over the existing OrfRowDecoder /
   DngRowSource + the band demosaic/spatial functions already compiled to WASM.
- **Verify:** WASM `export_band` rows == whole-frame `demosaic→(NR→unsharp)→tone` rows
  (byte-exact, same contract as native `streaming_export_spatial_source_matches_whole`).

### P2c — JS fusion (encode-handler.ts / facade.ts / worker)
Pull rgb8 bands from P2b → feed P2a's chunked encoder → collect JXL output. Respect layer
invariants (CLAUDE.md): backpressure stays at the scheduler/worker boundary; the encoder facade
does not grow drain callbacks. Likely a direct pull loop inside a dedicated export worker (the
export flow is one-shot, not the interactive decode session).
- **Verify:** end-to-end browser streamed JXL bytes == whole-frame browser JXL bytes for a real
  ORF and DNG; peak heap ≈ O(band), not O(height). `StandardMultifileTest` clean.

---

## Risks / watch-items
- **Collision:** another agent is active in encode-strategy/WASM territory (spatial strategy
  table). De-conflict on bridge.cpp + encode-handler before editing; keep P2 work on its own
  branch off m2r7; do not touch main/submodule gitlink.
- **Emscripten cost:** every bridge.cpp change = ~34 min build. Batch C++ edits; smoke-test the
  encode FFI in isolation before wiring JS.
- **WASM heap:** chunked encode must actually lower peak; measure heap, not just correctness.
- **Native-only cfg:** P2b must lift the *pixel* streaming core out of `not(wasm32)` WITHOUT
  pulling jxl-ffi into WASM (encode is bridge.cpp's job, not jxl-ffi's).
- **6-tier .wasm/.js:** the 0.12 fork ships 6 tiers; build/test all, and never mix tier
  artifacts across builds (past false-alarm source).

## Definition of done
Browser streams a full-res RAW→JXL export at O(band) peak, byte-identical to the whole-frame
browser encode (lossy + lossless), on a real ORF and a real DNG, with `StandardMultifileTest`
green. Parked on a P2 branch for the integrator; nothing merged to main.
