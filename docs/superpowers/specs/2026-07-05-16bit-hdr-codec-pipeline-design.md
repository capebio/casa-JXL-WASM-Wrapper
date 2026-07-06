# 16-bit / HDR Codec Pipeline Path — Design

**Date:** 2026-07-05
**Branch:** `feat/codec-compare-benchmark` (worktree `C:\Foo\rcw-codec-compare`)
**Status:** Approved design → implementation plan next.

## Goal

The codec-paper suite (`CodecPaperFullTest.mjs`) currently proves format capabilities for 16-bit/HDR only via a **static capability-matrix row** (`CAPABILITY`, `CodecPaperFullTest.mjs:32-38`). Everything else in the harness is 8-bit RGBA end to end. This project builds a **real 16-bit rate-distortion path**: genuine high-bit-depth source pixels → 16-bit-capable encoders → 16-bit-capable decoders → 16-bit-aware distortion metrics → new RD figures + gallery section, all integrated into the existing `CodecPaperFullTest.mjs` run.

Scope decision (confirmed): build the **16-bit SDR** pipeline now using the project's own RAW-derived high-bit-depth content; leave **true HDR (PQ/HLG, Rec.2020)** as a documented follow-up (Part 3c). Rebuilds of both the Rust `pkg` (wasm-pack) and the jxl-wasm C++ bridge (Emscripten) are in scope.

## Constraints

- **One-writer rule.** All work happens in the `C:\Foo\rcw-codec-compare` worktree, which owns `feat/codec-compare-benchmark`. Never switch the primary checkout's branch. Forward commits on this branch only.
- **Additive, not destructive.** The 8-bit path and the working/delivered overnight suite must keep functioning. 16-bit is a parallel pass; the 8-bit figures are unchanged.
- **No fake precision.** Only genuinely >8-bit sources feed the 16-bit path. Kodak (8-bit PNG) is excluded from the 16-bit corpus; it stays in the 8-bit corpus.
- **Metric must resolve sub-8-bit differences.** A down-converted 8-bit Butteraugli would quantize away the >8-bit signal and make the 16-bit RD curve a mirror of the 8-bit one — forbidden. 16-bit metrics operate at 16-bit resolution.
- **The Emscripten bridge rebuild is the only high-risk step.** The 16-bit Butteraugli must be **additive**: the deliverable (a real 16-bit RD figure driven by PSNR-16/SSIM-16, pure JS) must not be blocked on the bridge rebuild.
- **Endianness.** WASM is little-endian; all 16-bit buffers crossing the FFI boundary are LE `uint16`.
- **libjxl fork.** The bridge builds against `external/libjxl-012` (fork). It must be checked out (`git submodule update --init external/libjxl-012`) or `LIBJXL_SRC_DIR` pointed at an existing checkout (`C:\Foo\raw-converter-wasm\external\libjxl-012`).

## Architecture: six layers

```
CodecPaperFullTest.mjs  (L5 data+figures: sweep16/fixed16/lossless16, rd-*-16bit.svg, gallery)
  └─ codec-compare-jxl.mjs / codec-adapters.mjs  (L3 adapters: JXL-rgba16, AVIF-10/12, PNG-16; L4 metrics)
       └─ jxl-wasm facade  (L2: computeButteraugli16 → bridge)
            └─ bridge.cpp   (L2: jxl_wasm_butteraugli_compare16)
       └─ raw_converter_wasm pkg  (L1: OUT_FULL_DISP16 → take_rgb16_disp → downscale_rgb16_pub → rgb16_to_rgba16)
            └─ pipeline::process_16bit  (EXISTS — display-referred RGB16 render)
```

### L1 — Rust pkg: export the display-referred 16-bit render

The display-referred 16-bit render **already exists** as `pipeline::process_16bit` (`crates/raw-pipeline/src/pipeline.rs:2148`): it reuses the exact `simd_block_kernel` + pre-LUT (black/WB/exposure) + tone math (matrix/sat/vibrance) as the 8-bit render, differing only in the final LUT (`build_post16_lut`, `pipeline.rs:686`), which emits full-range `[0,65535]`. So the 16-bit output is display-referred, color-correct, and ≤1-LUT-step consistent with the shipped 8-bit render. It is simply not wasm-exported.

Edits (`src/lib.rs` unless noted):

1. New flag beside `lib.rs:711-724`: `const OUT_FULL_DISP16: u32 = 32;`
2. `ProcessResult` (`lib.rs:228`): add `rgb16_disp: Vec<u16>`, `#[wasm_bindgen(readonly)] pub disp16_w: u32`, `pub disp16_h: u32` (mirror `rgb16_full`/`full16_w`/`full16_h`).
3. New take method (mirror `take_rgb16_full`, `lib.rs:377`): `pub fn take_rgb16_disp(&mut self) -> Vec<u16>` returning native `Vec<u16>` (→ `Uint16Array`; no LE-packing).
4. `process_orf_impl` (`lib.rs:1007`) and `process_dng_impl` (`lib.rs:2619`): add `want_disp16 = output_flags & OUT_FULL_DISP16 != 0`; OR `OUT_FULL_DISP16` into `need_full_rgb` (so full `rgb16` materializes, `lib.rs:821/958/2493`); widen the tone-stage gate to `(OUT_FULL_RGB8 | OUT_FULL_DISP16)`; when `want_disp16`, borrow `&rgb16` **before** it is moved into `rgb16_full`, call `pipeline::process_16bit(&rgb16, &params)`, then apply 16-bit orientation; thread `rgb16_disp`/`disp16_w`/`disp16_h` through the return tuple + `ProcessResult` builder. CR2 is covered free via `process_cr2_impl → process_dng_impl`.
5. 16-bit orientation (`crates/raw-pipeline/src/pipeline.rs`): `pub fn apply_orientation_u16(rgb: Vec<u16>, w, h, orientation) -> (Vec<u16>, usize, usize)` + u16 twins of the 7 helpers (`rotate_90_cw/ccw`, `rotate_180`, `flip_horizontal/vertical`, `transpose`, `anti_transpose`, `pipeline.rs:2529-2740`) — mechanical u8→u16, `*3` strides in element units.
6. Public 16-bit long-edge downscale (mirror `downscale_rgb`, `lib.rs:1431`): `#[wasm_bindgen] pub fn downscale_rgb16_pub(src: &[u16], src_w,src_h,dst_w,dst_h: u32) -> Result<Vec<u16>, JsError>` → delegates to `pipeline::downscale_rgb16` (`pipeline.rs:2281`).
7. RGB16→RGBA16 (mirror `rgb_to_rgba`, `lib.rs:1833`): `#[wasm_bindgen] pub fn rgb16_to_rgba16(rgb: &[u16]) -> Vec<u16>` with alpha `0xFFFF`.

The three `_with_flags` wasm entries need **no signature change** — new behavior is driven by the flag bit. Rebuild: `.\build-parallel-wasm.ps1` (regenerates `pkg/` + `web/pkg/`). **No white-level getter needed** — `process_16bit` is already full-range.

Benchmark call shape:
```js
const d = raw.process_orf_with_flags(bytes, 32 /*OUT_FULL_DISP16*/, ...PROCESS_ARGS);
const rgb16 = d.take_rgb16_disp();                      // oriented, full-res RGB16 [0,65535]
const [srcW, srcH] = [d.disp16_w, d.disp16_h]; d.free();
const rgb16s = raw.downscale_rgb16_pub(rgb16, srcW, srcH, tgtW, tgtH); // 1920 long-edge
const rgba16 = raw.rgb16_to_rgba16(rgb16s);             // Uint16Array RGBA16
```

### L2 — jxl-wasm C++ bridge: 16-bit Butteraugli

Clone `jxl_wasm_butteraugli_compare` (`packages/jxl-wasm/src/bridge.cpp:3707-3763`) as a new standalone `extern "C"` fn inserted after `jxl_wasm_butteraugli_ref_free` (`bridge.cpp:3859`):

```cpp
extern "C" int32_t jxl_wasm_butteraugli_compare16(
    const uint16_t* img1, const uint16_t* img2, uint32_t width, uint32_t height);
```

Differences from the 8-bit fn: input stride is 4 `uint16`/pixel (RGBA16); the u8 `SrgbGamma22Lut()` cannot be indexed, so linearize each channel via **gamma 2.2 on `v/65535`** (same transfer the 8-bit path uses, at 16-bit resolution) — this keeps `butteraugli16` scores directly comparable to the 8-bit `butteraugli`. Reuse `jxl::Image3F::Create` + `jxl::ButteraugliInterfaceInPlace`; return the packed int32 bits (decoded by `floatFromI32Bits` on the JS side). No new runtime heap views (`HEAPU8` byte-copy convention).

Export + facade:
- Append `_jxl_wasm_butteraugli_compare16` to `packages/jxl-wasm/exports-enc.txt` (**required** — the Node benchmark loads the `enc:simd` tier). Optionally `exports-dec.txt` / `exports.txt`.
- `facade.ts`: add `_jxl_wasm_butteraugli_compare16?` to the `LibjxlWasmModule` interface (`facade.ts:502-505`); add `computeButteraugli16(pixels1, pixels2, w, h)` after `computeButteraugli` (`facade.ts:771-800`) with `pixelSize = w*h*4*2`, a `CapabilityMissing` guard (so callers/tests fall back when the symbol is absent), heap byte-copy, and `floatFromI32Bits` decode.
- Recompile facade TS → dist: `npx tsc -p packages/jxl-wasm/tsconfig.json`.

Rebuild the exact tier the benchmark uses:
```
cmd /c "call C:\Users\User\emsdk\emsdk_env.bat >nul && set EMSDK_QUIET=1 && set JXL_WASM_ONLY_KIND=enc && set LIBJXL_SRC_DIR=C:\Foo\rcw-codec-compare\external\libjxl-012 && cd /d C:\Foo\rcw-codec-compare && node packages\jxl-wasm\scripts\build.mjs --host-toolchain"
```
Budget: `enc:simd` = 3.1 MB, current 3.056 MB (~44 KB headroom). If `Size budgets exceeded` throws, the `.wasm` is still emitted; bump `build.mjs:52` if needed.

### L3 — Benchmark 16-bit adapters

Uniform interface, RGBA16 (`Uint16Array`) buffers. New adapters (subset that supports >8-bit):

- **JXL (ours)** — `facade.createEncoder({ format:'rgba16', ... })` / `createDecoder({ format:'rgba16' })`. Same chunked/progressive API; pass the `Uint16Array` bytes to `pushPixels`.
- **AVIF 10/12-bit** — primary via `sharp.avif({ bitdepth: 10 })` (libvips scales from the `rgb16` colourspace internally); decode via `sharp(buf).toColourspace('rgb16').raw({ depth:'ushort' }).toBuffer()`. Fallback: `@jsquash/avif` `encode(imageData16, { bitDepth: 10 })` / `decode(buf, { bitDepth: 10 })` (needs right-justified scaling to `[0,1023]`).
- **PNG-16** — `sharp.toColourspace('rgb16').png()`; lossless anchor only (single point, like the 8-bit `png_native`).

Corpus for 16-bit = **RAW-derived only** (the 6 ORF/CR2/DNG in `RAW_FILES`, `CodecPaperFullTest.mjs:26-30`). `jxl_orig` (@jsquash/jxl) is 8-bit-only → **excluded** from the 16-bit RD figure; jpeg/webp are 8-bit-only → excluded.

### L4 — 16-bit metrics

- **`butteraugli16`** (L2 bridge) — primary perceptual; used only when `facade.computeButteraugli16` capability is present.
- **`psnr16` + `ssim16`** — **pure JS** over `Uint16Array`, peak 65535. Always available (no rebuild). New small module (e.g. `benchmark/metrics16.mjs`) or inline helpers.
- **`searchQuality`** fixed-point anchor: target `butteraugli16` 1.5 when available; else a PSNR-16 target. (`butteraugli-search.mjs` is metric-agnostic — it just needs a monotone `measure(q)`.)
- **Normalization + guard.** Every decoded output is normalized to `[0,65535]` before comparison (codec-dependent: verify whether libvips upscales 10/12-bit AVIF to full 16-bit). Each codec gets a **round-trip identity guard** (near-lossless encode → decode → assert small error), mirroring the existing lossless-verify gate (`CodecPaperFullTest.mjs:152`), to catch scaling/endianness mistakes before charting.

### L5 — Data + figures

- New driver arrays `sweep16 / fixed16 / lossless16` (parallel to `sweep/fixed/lossless`, `CodecPaperFullTest.mjs:112`), populated in a **16-bit pass** that runs only for RAW images: load RGBA16 via L1, run the L3 adapter subset with L4 metrics, push rows `{ image, class, codec, runtime, quality, bytes, bpp, butteraugli16?, psnr16, ssim16 }`.
- `codec-paper-figures-full.mjs`: add `sweep16` (etc.) to the `writeFiguresFull` signature (`:25`); emit `rd-butteraugli-16bit.svg`, `rd-psnr-16bit.svg`, `rd-ssim-16bit.svg` via `seriesBy` + `rdCurve` (JXL vs AVIF curves; PNG-16 + JXL-lossless as lossless anchors on the size/lossless figures). Add `CAPTIONS` entries; add a `<h2>16-bit / HDR RD</h2>` gallery section in `writeGalleryFull` (`:109`). Add new codec keys to `PALETTE`/`CODEC_ORDER` (`:5-8`). Butteraugli-16 curve emitted only if `sweep16` rows carry `butteraugli16`.
- TOON summary: add `sweep16_rows` etc. (`CodecPaperFullTest.mjs:89`).
- Capability matrix note: participation footnote (JXL/AVIF/PNG only; jpeg/webp/jxl_orig 8-bit). The `sixteenbit` column already exists — no schema change.
- The SVG/plot layer (`svg-figures.mjs`) and aggregation (`seriesBy`, `bdMatrix`, `bpp`) are bit-depth-agnostic — unchanged.

### L6 — HDR follow-up (documented, not built)

True PQ/HLG Rec.2020 needs: an HDR corpus (none available yet), a float source path (`process_16bit` → f32 variant or `rgbaf32` facade already exists), and an HDR-aware metric (PU21 encode or tone-map before Butteraugli, or an `rgbaf32` bridge). Documented as Part 3c. Not implemented here.

## Edge cases

- **Bridge symbol absent** (not yet rebuilt / wrong tier): `computeButteraugli16` throws `CapabilityMissing`; the 16-bit pass catches it, logs once, and omits the butteraugli-16 curve — PSNR-16/SSIM-16 curves still render.
- **AVIF 10/12-bit unsupported at runtime** (libheif/aom build lacks it): per-codec try/catch drops AVIF from the 16-bit figure with a logged note; JXL + PNG-16 still chart.
- **Scaling mismatch** (10/12-bit not upscaled to full 16-bit): caught by the round-trip identity guard before charting; normalize on decode.
- **RAW file missing / decode failure**: existing per-image try/catch (`CodecPaperFullTest.mjs:121-144`) already isolates failures; the 16-bit pass is inside the same guard.
- **Checkpoint crash-safety**: the 16-bit arrays are regenerated in `emitAndDeliver` after every image, like the 8-bit ones, so a crash still leaves complete 16-bit figures.
- **Memory**: full-res RGB16 is ~2× the 8-bit master; downscale to 1920 immediately (as the 8-bit path does) and `free()` the `ProcessResult` promptly.

## Success criteria

1. `raw.process_orf_with_flags(bytes, 32, ...)` + `take_rgb16_disp` + `downscale_rgb16_pub` + `rgb16_to_rgba16` yield a valid oriented RGBA16 `[0,65535]` buffer at 1920 long-edge for ORF/CR2/DNG, reachable from Node.
2. `process_16bit(x) >> 8` matches the 8-bit render of `x` within ≤1 LUT step (byte-consistency test).
3. Our JXL facade encodes and decodes that RGBA16 buffer round-trip through `format:'rgba16'`.
4. AVIF-10/12 and PNG-16 adapters round-trip the RGBA16 buffer (identity guard passes).
5. `computeButteraugli16(x, x) == 0`, and on **bit-replication-promoted** input (each 8-bit `b → b*257`, mapping `0..255 → 0..65535` exactly so `v/65535 == b/255`) the score ≈ the 8-bit `computeButteraugli` on the same pair (within tolerance — confirms the gamma-2.2 linearize matches the 8-bit `SrgbGamma22Lut`).
6. `psnr16`/`ssim16` produce finite, monotone-with-quality values distinct from their 8-bit counterparts (i.e. they resolve >8-bit differences).
7. A full `LIMIT=1` run emits `rd-butteraugli-16bit.svg` (when the bridge is present) + `rd-psnr-16bit.svg` + `rd-ssim-16bit.svg`, a "16-bit / HDR RD" gallery section, and delivers to Jose — **with the bridge rebuild reverted, the PSNR/SSIM figures still render** (additive-butteraugli proven).
8. The 8-bit figures and the existing overnight suite are unchanged.

## Phasing (critical path first, each independently testable)

1. **L1** Rust render + `.\build-parallel-wasm.ps1` → verify criteria 1-2.
2. **L3/L4** adapters + JS PSNR-16/SSIM-16 → produces a real 16-bit RD figure **without** the bridge (criteria 3-4, 6).
3. **L2** bridge + Emscripten rebuild + facade → adds the perceptual curve (criterion 5).
4. **L5** figures + gallery + TOON + capability note → criterion 7.
5. **L6** HDR follow-up doc.

The two rebuilds (wasm-pack in step 1, Emscripten in step 3) are the critical-path risks; step 2 is designed to deliver value even if step 3 slips.
