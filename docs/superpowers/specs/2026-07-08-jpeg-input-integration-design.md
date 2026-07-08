# JPEG as a First-Class Input Format — Design Spec

**Date:** 2026-07-08
**Status:** Approved (brainstorming) → ready for implementation plan
**Author:** David + Claude

## Goal

Make JPEG a fully integrated input format in the CasaWASM RAW→JXL converter,
on par with ORF/DNG/CR2, within the Casabio platform. A JPEG must be:

1. **Importable** through the same UI and pipeline as RAW.
2. **Preserved losslessly** as an immutable archival JXL (bit-exact original JPEG
   recoverable).
3. **Editable** in the lightbox, non-destructively.
4. **Exportable** via two first-class pathways: **archival (lossless)** and
   **developed (lossy)**.
5. **Exercised for real** in the test-suite (no `sharp` stub), measuring both
   pathways.

## Motivation

JPEG plumbing already exists but is scattered and half-wired:

- libjxl bridge has lossless JPEG→JXL transcode (`jxl_wasm_transcode_jpeg_to_jxl`,
  `bridge.cpp:3557`) via `JxlEncoderAddJPEGFrame` + `StoreJPEGMetadata`; a `_v2`
  variant with EXIF/XMP boxes exists but is **not exported to JS**.
- `facade.ts:766` exposes `transcodeJpegToJxl()`; `facade.ts:1018`
  `extractJpegReconstructionFromJxl()` recovers the original JPEG.
- `pyramid-ingest/ladder.ts:155` `buildJpgLadder()` builds a JPEG pyramid.
- `fast-jpeg` crate decodes JPEG→RGBA8.

But: **the web UI cannot load JPEG** (`index.html:101` `accept` excludes it;
`isOrf()` filter `main.js:2164` silently drops it), and **the test-suite fakes
JPEG** via `sharp().raw()` (`StandardMultifileTest.mjs:368`), bypassing the real
pipeline. There is no unified routing and no non-destructive edit story for JPEG.

## Key Decisions

### Semantics: lossless archival + non-destructive edit
JPEG is a developed image, not Bayer sensor data. It is not "developed" like RAW.
Instead:
- On import, it is **losslessly transcoded** to a JXL that embeds the original
  JPEG bitstream — the **immutable archival source of truth**.
- Editing is **non-destructive**: edits are a recipe of Look/adjustment params
  applied as a filter at view + export time. The archival JXL is never mutated.

This mirrors how RAW already works (source preserved, `LookRenderer` re-applied
each view), and how developed images (TIFF/EXR) already edit (`main.js:2162`).

### Edit storage: sidecar recipe (not embedded)
The edit recipe is stored in a **sidecar**, in the Casabio platform-managed store
(OPFS / AssetStore), keyed by sourceKey — **not** as user-visible loose files, and
**not** embedded in the archival JXL.

Rationale (preservation tool):
- Archival original stays **write-once** — no edit rewrites the bit-exact bytes,
  so no box-repack bug can corrupt the thing being preserved.
- Sidecar writes are tiny JSON; no container repack per slider drag.
- Recipe shape is already proven serializable — presets persist `currentLook()`
  (`main.js:583`).
- Sidecar's usual weakness (orphaning) is **moot inside the platform**, which owns
  both artifacts and their pairing.

An **embedded XMP/box export** (via the existing `_v2` bridge) is a deferred
follow-up for *leaving the platform* (external share/interop) — it solves
portability exactly when it matters without ever risking the working original.

### Approach: thin integration, reuse existing plumbing
Reuse the ~70% that exists (transcode bridge, `buildJpgLadder`, `LookRenderer`,
the developed-image edit path, the preset serialization shape). Do **not**
introduce a unified `ImageSource` abstraction now (opportunistic refactor with a
wide RAW-path blast radius — YAGNI until a second editable developed format
justifies it).

## Architecture

### Data flow

```
photo.jpg
  ├─(archival)  transcodeJpegToJxl()  ─► photo.jxl  [immutable, lossless, JPEG recoverable]
  └─(edit px)   decode_jpeg(bytes) ─► DecodedImage(RGB16)
                                        └─► LookRenderer::new_with_options   (existing dev-image path)

lightbox edit ─► currentLook() recipe ─► recipe-store (OPFS/AssetStore, keyed by sourceKey)

view          ─► decode → LookRenderer(recipe) → display
export archival ─► ship photo.jxl untouched  (extractJpegReconstructionFromJxl recovers original)
export developed ─► decode → LookRenderer(recipe) → encode lossy JXL  (existing RAW export encode)
```

### Components

| Component | Change | Location |
|-----------|--------|----------|
| `decode_jpeg(bytes) -> DecodedImage` | **NEW** small wasm export; decodes JPEG→RGB16 via `fast-jpeg` crate, mirrors `decode_tiff`/`decode_exr` | `src/lib.rs` (beside `:4596`) |
| recipe-store | **NEW** small module beside `jxl-cache`; persists `currentLook()` JSON keyed by sourceKey in platform store. Cache stays content-agnostic (layer invariant). | new package/module |
| Ingest routing | Sniff `.jpg/.jpeg/.jfif` + `FFD8…FFD9`; produce archival JXL + edit pixels | `main.js:startConvert` (`:1827`), worker |
| `transcodeJpegToJxl` | Reuse as-is | `facade.ts:766` |
| `extractJpegReconstructionFromJxl` | Reuse for archival recovery + reversibility test | `facade.ts:1018` |
| `LookRenderer` live-edit | Reuse unchanged (JPEG = developed-image path) | `src/lib.rs:2707` |
| Recipe vocabulary | Reuse `currentLook()` / `applyLookValues()` | `main.js:381` / `:553` |
| Web `accept` | Add `.jpg,.jpeg,.jfif` | `web/index.html:101` |
| `isOrf()` filter | Add `jpg\|jpeg\|jfif` (already accepts exr/tif/tiff) | `main.js:2164` |
| Export UI | Archival/Developed choice for JPEG cards | lightbox |
| Test-suite | Replace `sharp` stub; real transcode + round-trip rows, both pathways | `StandardMultifileTest.mjs:368` |

### Export modes

- **Archival (lossless):** ship the retained transcode JXL untouched. Recipe stays
  in the sidecar. Original JPEG bit-exact recoverable.
- **Developed (lossy):** decode → apply recipe via `LookRenderer` → encode lossy
  JXL through the existing RAW-export encode path.

## Test-Suite Integration (`StandardMultifileTest.mjs`)

Replace the `sharp().raw()` branch. Add rows measuring **both** pathways with the
**real** production code (no external image-decode dependency):

- **Lossless row:** `transcodeJpegToJxl` → transcode ms, out/in byte ratio, and a
  **reversibility assert** (`extractJpegReconstructionFromJxl(jxl) === original`).
- **Lossy row:** `decode_jpeg` → `LookRenderer(sample recipe)` → lossy JXL →
  encode ms, output size.
- Drop the `sharp` dependency from the JPEG path.

## Error Handling & Edge Cases

- **Corrupt/truncated JPEG:** transcode returns a bridge error code; surface as a
  card error (same as RAW decode failure). `fast-jpeg` decode already enforces a
  400 MP pixel budget.
- **Non-baseline / progressive / CMYK / 12-bit JPEG:** `JxlEncoderAddJPEGFrame`
  handles standard baseline + progressive; verify CMYK/exotic subsampling behavior
  and fall back to a decode→re-encode (lossy) path with a warning if transcode
  rejects. (Resolve concrete fallback in the plan.)
- **Missing recipe sidecar:** treat as unedited → archival export is a no-op ship;
  developed export bakes the identity recipe.
- **Capability missing (old WASM):** `getCapabilities().jpegTranscode` false →
  gate the archival pathway, fall back to developed-only with a notice.
- **Reversibility:** archival export must round-trip bit-exact; guarded by the
  test-suite reversibility assert.

## Success Criteria

1. Drag/drop or pick a `.jpg` in the web UI → card appears, lightbox opens, edits
   apply live (no silent drop).
2. Import produces an immutable lossless JXL; `extractJpegReconstructionFromJxl`
   returns bytes identical to the source JPEG.
3. Edits persist to the platform sidecar and re-apply on reopen; archival JXL is
   never rewritten by editing.
4. Archival export = bit-exact-recoverable JXL; developed export = lossy JXL with
   the recipe baked in.
5. `StandardMultifileTest.mjs` runs JPEG through real transcode + round-trip,
   measures both pathways, and no longer depends on `sharp` for JPEG.
6. All existing RAW paths unchanged (no regression).

## Non-Goals / Follow-ups

- **Embedded XMP/box recipe export** (via `_v2` bridge) for external portability —
  deferred; solves external orphaning/interop, not needed for in-platform MVP.
- **No RAW-pipeline `process_jpeg`** — JPEG is not Bayer; correctly omitted.
- **`fast-jpeg` DCT-domain downscale** for faster thumbnails — optional perf,
  later.
- Unified `ImageSource` abstraction — deferred until a second editable developed
  format justifies it.
