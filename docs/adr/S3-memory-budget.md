# ADR S3-1 — RAW decode memory-budget model (`estimate_decode_peak`)

Status: Accepted (additive, behavior-neutral) — 2026-07-06
Scope: `crates/raw-pipeline/src/mem_budget.rs`, wasm export in `src/lib.rs`
Supersedes: nothing. Complements K1 streaming bands (which already lower the
peak for the preview-only path).

## Context

S3 (Wave-2 strategic map) calls out that RAW-decode memory is ad-hoc: "~360 MB
WASM heap at 24 MP all-flags (P7)", pass-pixel retention ~220 MB on long runs,
and `MAX_OUTPUT_BYTES_GUARD` an arbitrary 1 GiB. There was no way to *ask, before
starting a decode*, how much working set it would need. The browser admits
decodes blind and discovers OOM by crashing.

This ADR defines a pure, deterministic projection —
`estimate_decode_peak(width, height, output_flags) -> { pixels, retained_bytes,
peak_bytes }` — computed from dimensions and the output-flag bitset, with **no
effect on decode output**. It is the preflight the browser's admission control
and the `AssetStore` governor consult.

## Decision

Model the decode as a sequence of stages and count the *logical live bytes* at
each. Two byte quantities are reported:

* **`retained_bytes`** — the buffers that survive in the returned
  `ProcessResult` for the requested flags. This is the steady state a caller
  must budget for as long as it *holds* the result (before the `take_*` methods
  move ownership to JS).
* **`peak_bytes`** — the maximum, over the heavy stages, of the buffers that are
  simultaneously live *during* the decode. Always `>= retained_bytes`. This is
  the number relevant to the WASM linear-heap high-water mark.

### Buffer unit costs (per `n = width*height` pixels)

| Buffer | Bytes | Where |
|---|---|---|
| RAW mosaic (u16, 1 sample/px) | `2n` | decompress output |
| RGB16 interleaved (u16 × 3) | `6n` | MHC demosaic output; 16-bit master; display-referred |
| RGB8 interleaved (u8 × 3) | `3n` | tone output (the JXL-encode buffer) |
| Lightbox preview (packed LE, 6 B/px) | `6 · lb_px` | `target_dims(_,1800)` |
| Thumbnail preview (packed LE, 6 B/px) | `6 · thumb_px` | `target_dims(_,360)` |

Grounded in the code (2026-07-06): `demosaic_rggb_mhc` allocates exactly one
`n*3` u16 output and reads the RAW in place — no large scratch — so the decode
stage is `RAW + RGB16 = 8n`. `process_into_auto` writes into a preallocated
`3n` RGB8; `process_16bit` returns a fresh `6n`; `apply_orientation*` consumes
its input and returns a rotated copy (source + destination briefly coexist).

### `retained_bytes`

Sum of the present result buffers:
`[RGB8 3n if OUT_FULL_RGB8] + [RGB16 6n if OUT_FULL_16] + [RGB16 6n if
OUT_FULL_DISP16] + lightbox + thumbnail`.

(`OUT_FULL_16` is held as a `Vec<u16>` — `6n` bytes — and packed to bytes lazily
in `take_rgb16_full`; the retained footprint is the `6n` u16 vec.)

### `peak_bytes`

`max(stage_decode, stage_render) + retained_previews`, where:

* **stage_decode** = `8n` (`RAW 2n + RGB16 6n`) whenever any full-res output OR a
  preview is requested. (Preview-only decodes still decode the mosaic and build a
  planar preview of comparable size; the streaming ¼-res fast path, when eligible
  — halve-able dims **and** camera-WB tags present — uses far less, but WB
  presence is not knowable at preflight, so we take the conservative bound.)

* **stage_render** (only with a full-res flag):
  * `OUT_FULL_RGB8` set: RGB16 (`6n`) stays live through tone + disp16 while the
    RGB8 tone output (`3n`) exists; if `OUT_FULL_DISP16` is set, its
    `process_16bit` result plus the orientation rotate transiently doubles it
    (`12n` under rotate, `6n` without). After RGB16 is moved into the full-16
    master (or dropped) and disp16 is done, the RGB8 orientation rotate holds
    src+dst (`6n` under rotate) alongside the retained full16/disp16. The stage
    is the max of these two moments.
  * only `OUT_FULL_16` / `OUT_FULL_DISP16` (no RGB8): RGB16 (`6n`) plus the
    disp16 rotate transient.

* **Orientation assumption**: the file's true EXIF orientation is unknown at
  preflight, so a 90° rotate transient is **assumed** unless `OUT_NO_ORIENT` is
  set. This over-reserves for orientation-1 images — the safe direction for
  admission control.

### Worked numbers (24 MP, 6000×4000, `n = 24e6`)

| Flags | retained | peak |
|---|---|---|
| `RGB8│LB│THUMB` (shipping "7") | ~85 MB (`3n` + previews) | ~230 MB (`9n` + previews) |
| all flags, rotate | ~360 MB | ~517 MB (`21n` + previews) |
| all flags, `OUT_NO_ORIENT` | ~360 MB | ~432 MB (`18n` + previews) |
| `LB│THUMB` only | ~14 MB (previews) | ~206 MB (`8n` + previews) |

## Model vs observed

The model counts **logical live bytes**. Observed WASM RSS runs higher because:
(1) the linear heap never shrinks — the high-water of decode+demosaic+tone
compounds; (2) allocator fragmentation; (3) the input container bytes the caller
already holds (excluded here — the estimate signature is dims+flags only).
Empirically ~1.3–1.6× on this pipeline (e.g. P7's observed ~360 MB vs the ~230 MB
`flags=7` model). **Callers should apply an additional safety multiplier** to
`peak_bytes` for admission (a good default is 1.5×), rather than trust it as an
exact ceiling.

## Consequences

* Browser admission control can gate a decode against the heap *before* starting
  it, and pick an output-flag subset that fits (e.g. drop `OUT_FULL_DISP16`, or
  set `OUT_NO_ORIENT`, to shed the biggest transients).
* `AssetStore` can account a held `ProcessResult` by `retained_bytes`.
* The private `OUT_*` flag bits in `src/lib.rs` are pinned to the estimator's
  mirror by a compile-time `assert!`, so the model can never silently diverge
  from the real flag layout.

## Alternatives considered

* **Measure instead of model** — would require running the decode (defeats a
  *pre*flight) or elaborate instrumentation; a pure model is deterministic,
  cross-target, and free.
* **Return only a scalar peak** — kept as the `estimate_decode_peak_bytes`
  convenience, but the struct (pixels/retained/peak) is more useful to the
  governor.

## Follow-ups (deferred — see WAVE2-QUESTIONS-DEFERRED.md §S3)

* A `RawDecodeSession` demand-pull ADR (lazy `take_*`) is largely superseded by
  K1 bands; worth revisiting only for the flag combinations that still
  materialize whole buffers (`OUT_FULL_16` + `OUT_FULL_DISP16` together).
* An optional `input_bytes` parameter if callers want the estimate to include
  the container passthrough.
