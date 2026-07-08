# Scoping — Pure-Web RAW → CASV Video (no Tauri sidecar)

**Date:** 2026-07-08 · **Question:** what would it take to encode a RAW timelapse to `.casv`
entirely in the browser, with no native `casv_encode` sidecar?

**TL;DR:** A **lossless FableBraid** RAW→video encoder is *close* — every heavy brick already
exists and already compiles to (or is exported from) WASM; the only gap is a ~40-line GOP loop +
container write. The **JXL lossy tiers** are a much larger job (cross-WASM-module bridging).
Recommendation: ship the FableBraid-lossless MVP; defer the JXL tiers.

---

## Today's reality

- **Desktop (Tauri):** RAW→video already works. The browser UI (`web/timelapse-core.js`,
  `web/timelapse.js`) collects RAW files and drives the native **`casv_encode --raw-frames`
  sidecar**. That CLI path is already rayon-parallel (C1 only affected the in-process *library*
  entry, not the sidecar).
- **Pure web (no Tauri):** not possible today — there is no CASV *video encoder* in WASM. The
  native encoder (`casa_video` / `raw_video` / `jxl_casaencoder` / `jxl_casadecoder`) is gated
  `#[cfg(all(feature="jxl-codec", not(target_arch="wasm32")))]` because it FFIs the **native**
  libjxl (`jxl_ffi`).

## What already ships in WASM (the bricks)

| Brick | Where | Status |
|---|---|---|
| RAW decode → RGB8 (ORF/DNG/CR2) | `process_orf` / `process_dng` / `process_cr2` (wasm exports) | ✅ |
| Downscale RGB | `downscale_rgb` (wasm export) | ✅ |
| Per-frame FableBraid **encode** | `fable_encode_rgb8`, `fable_encode_rgb8_delta` (wasm exports, lib.rs:4615/4620) | ✅ |
| Per-frame FableBraid **decode** | `fable_decode_rgb8*` + browser playback session (lib.rs:4642) | ✅ |
| FableBraid codec core | `crate::fable_braid` — **un-gated, compiles to wasm, has simd128 kernels** | ✅ |
| CASV container format | `crate::casv_container` — **un-gated, compiles to wasm** (32-B header, 8-B index, `build_v1`, `CASV_HDR_FABLE_FLAG`) | ✅ |
| JXL still encode/decode | emscripten bridge `jxl-core.simd.wasm` (`_jxl_wasm_encode_rgb8_chunked/stream`, `_encode_animation`, decode/region) | ✅ (separate module) |

## MVP — FableBraid lossless RAW→video (NO libjxl)

The native encoder for this tier is **`casa_video::encode_casv_fable_streaming`** (casa_video.rs:1557).
Its entire body uses only `fable_braid::encode_rgb8` / `encode_rgb8_delta` (I-frame / P-frame delta,
GOP-keyed) + the container assembler — **zero libjxl**. It is native-gated *only* because it shares
the `casa_video` module with the JXL-FFI tiers.

**Gap = expose that ~40-line loop + container write to the browser.** Two ways:

- **Option A — JS assembly over existing exports (fastest prototype, no Rust rebuild).**
  In TS: for each RAW → `process_orf` → RGB → `idx % gop == 0 ? fable_encode_rgb8 : fable_encode_rgb8_delta`
  → collect payloads → write the v1 container (header + index + data, `CASV_HDR_FABLE_FLAG`,
  `CASV_PFRAME_FLAG`). ~a few hours.
  *Risk:* JS container bytes must match the Rust decoder. *Mitigation:* golden test — JS-encode →
  existing WASM fable decode → assert frames == source; and byte-diff vs a native
  `encode_casv_fable_streaming` golden of the same frames.

- **Option B — un-gate the Rust path + `#[wasm_bindgen]` wrapper (cleaner, needs pkg rebuild).**
  Move `encode_casv_fable_streaming` (and the container helpers it calls) into a wasm-visible spot,
  or add a stateful `#[wasm_bindgen]` encoder (`push_frame(rgb)` → `finish()` → `.casv` bytes) that
  reuses the exact Rust code. Single source of container truth → no JS-vs-Rust format drift. All
  deps already compile to wasm, so this is a refactor-and-wrap, not new algorithm work.

**Verification (either option):** round-trip (encode in browser → decode with the shipping WASM
fable playback → compare to source frames) + byte-parity vs the native `encode_casv_fable_streaming`
golden. Fully additive — no existing behaviour changes, no colour/format decision needed.

**Effort:** Small–Medium. **Recommend Option B** (no format-drift risk); Option A first if you want a
same-day proof-of-concept.

## Full-featured — JXL lossy tiers (bbox/tile, JXL-lossless) — LARGE

These tiers per-frame-encode via `jxl_casaencoder` (native FFI). The browser's JXL encoder is the
**separate** emscripten module (`jxl-core.simd.wasm`); the Rust raw-engine WASM can't FFI it directly
— it must bridge through JS (Rust-wasm → JS → emscripten-wasm → back), i.e. the cross-WASM-module
copies already noted as irreducible. Plus the intricate residual / bbox-tile / JE-8-atlas / rate-control
logic (much of `casa_video`'s 6195 lines) must run in wasm. Two builds (abstract the codec behind a
trait, wasm impl calls the bridge) or a TS reimplementation — both LARGE with real format-compat risk.

## Recommendation

1. **Ship the FableBraid-lossless MVP** (Option B). Delivers pure-web RAW→timelapse for the lossless
   use case by reusing proven bricks; the only new code is the GOP loop + container write, both with
   native goldens to test against. Autonomously implementable + verifiable.
2. **Defer the JXL lossy tiers** unless in-browser lossy is a hard requirement — that is a genuine
   project (cross-module bridge + port the tier engine), not an incremental win.

---

## Implemented — FableBraid MVP (Option B, 2026-07-08)

The MVP is **built and verified**. No native path was touched (`casa_video` unchanged).

**New Rust:**
- `crates/raw-pipeline/src/casv_container.rs` — `pub fn write_container_v1(...)` (the single
  wasm-portable v1 writer, byte-identical to `assemble_header_casv` per
  `write_container_v1_matches_native_layout`) + `pub const CASV_HDR_FABLE_FLAG` (pinned to
  `casv-format.json`).
- `crates/raw-pipeline/src/fable_video.rs` — `FableVideoEncoder` (`new` → `push_rgb8` → `finish`),
  uses only `fable_braid` + `casv_container` (no libjxl; compiles to wasm). Proven **byte-identical
  to `casa_video::encode_casv_fable_streaming`** (`parity_with_native_streaming`) and lossless
  round-trip (`round_trips_lossless`).

**New WASM export** (`src/lib.rs`): `#[wasm_bindgen] struct FableVideoEncoder`
(`new(width,height,fps_num,fps_den,gop_len)`, `push_rgb8(&[u8])`, `frame_count()`, `finish() → Vec<u8>`).

**Browser usage** (no sidecar):
```js
import init, { process_orf_with_flags, FableVideoEncoder, downscale_rgb } from "./pkg/raw_converter_wasm.js";
// … init(wasm) …
const enc = new FableVideoEncoder(w, h, fpsNum, 1, gopLen);
for (const rawBytes of files) {
  const r = process_orf_with_flags(rawBytes, OUT_FULL_RGB8 | OUT_NO_ORIENT, /*look…*/);
  enc.push_rgb8(r.take_rgb());          // optionally downscale_rgb(...) first
}
const casv = enc.finish();               // .casv bytes — play with casv-web playFable + FableDeltaSession
```

**Verification:** `FableVideoEncodeTest.mjs` (node --test) drives the real wasm boundary
`FableVideoEncoder → .casv → FableDeltaSession` and asserts a lossless round-trip — passes.

**To ship to the app:** rebuild the committed **threaded** `web/pkg` (the app's loaded build) via
`build-parallel-wasm.ps1` so `FableVideoEncoder` is present there too (the verification used a
throwaway `pkg-fable/` non-threaded build). The Rust + format + wasm-bindgen layers are done and
byte-parity-locked; that rebuild + a few lines of UI wiring (RAW picker → the loop above → download)
are all that remain.
