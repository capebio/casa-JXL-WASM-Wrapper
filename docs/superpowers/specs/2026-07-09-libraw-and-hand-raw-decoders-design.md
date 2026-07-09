# LibRaw And Hand RAW Decoders Design

## Goal

Add browser-WASM RAW decode support beyond ORF/CR2/DNG, using LibRaw as the compatibility oracle and fallback while adding hand-rolled decoders for NEF, CRW, and RW2.

## Self-Critique And Scope Refinement

Full hand-written support for every RAW family is too large for one overnight pass. RAW support is format- and camera-mode-specific: Nikon NEF varies by compression and bit depth, Canon CRW is CIFF rather than TIFF, Panasonic RW2 uses Panasonic-specific TIFF tags and compression, and CR3 is ISO-BMFF. A broad "all manufacturers" hand implementation would likely ship silent corruption.

Refined scope:

- Browser path ships first.
- LibRaw is the standard decoder path for non-native RAW formats and the comparison oracle for hand decoders.
- Existing ORF/CR2/DNG paths remain preferred.
- Hand decoders for NEF, CRW, and RW2 target the downloaded corpus submodes first.
- If a hand decoder rejects a submode, worker falls back to LibRaw and reports the fallback path in debug metadata.
- CR3 uses LibRaw only in this pass. Hand CR3 is deferred because parsing ISO-BMFF plus Canon C-RAW is a separate codec project.
- NRW and RWL use the LibRaw path first; NRW may share later NEF logic, RWL may share later RW2 logic if corpus proves compatible.

## Architecture

Introduce one normalized browser-side raw payload:

```ts
type RawMosaicPayload = {
  raw: Uint16Array;
  width: number;
  height: number;
  cfaPhase: number;
  black: number;
  white: number;
  wbR: number;
  wbB: number;
  orientation: number;
  colorMatrix: number[];
  make: string;
  model: string;
  decoder: string;
};
```

`cfaPhase` encodes the existing Rust phase `(rowParity << 1) | colParity`. `0` means RGGB top-left.

Add Rust WASM entry:

```rust
pub fn process_raw_mosaic_with_flags(
    raw: &[u16],
    width: u32,
    height: u32,
    cfa_phase: u32,
    black: u32,
    white: u32,
    wb_r: f32,
    wb_b: f32,
    orientation: u32,
    color_matrix_flat: &[f32],
    output_flags: u32,
    exposure_ev: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    saturation: f32,
    vibrance: f32,
    temp: f32,
    tint: f32,
    texture: f32,
    clarity: f32,
) -> Result<ProcessResult, JsValue>
```

This reuses the existing demosaic, tone, thumbnail, lightbox, `LookRenderer`, and `ProcessResult` machinery.

## Decode Routing

`web/format-detect.js` expands RAW extensions:

- Existing native: `orf`, `cr2`, `dng`
- LibRaw/hand path: `nef`, `nrw`, `crw`, `cr3`, `rw2`, `rwl`, `arw`, `srf`, `sr2`, `arq`, `raf`, `pef`, `srw`, `x3f`, `3fr`, `fff`, `iiq`

`web/worker.js` routing:

- `orf/cr2/dng` -> current `process_*_with_flags`
- `nef/crw/rw2` -> try hand decoder -> on `UnsupportedRawModeError`, use LibRaw
- all other new RAW formats -> LibRaw

## LibRaw Browser Standard

Use npm package `libraw-wasm@1.6.0`. It exposes:

- `open(bytes, settings)`
- `metadata(fullOutput)`
- `rawImageData()`
- `imageData()`

Primary path uses `rawImageData()` for Bayer mosaic and metadata. If CFA cannot be mapped to Bayer, use `imageData()` as a developed RGB fallback or fail loudly for X-Trans until a separate X-Trans path exists.

## Hand Decoder Scope

NEF:

- Parse TIFF IFDs.
- Support uncompressed and lossless-JPEG submodes found in downloaded fixtures.
- Extract width, height, strip/tile offsets, CFA phase, black, white, WB, orientation, and color matrix where available.
- Compare raw dimensions and render output against LibRaw.

CRW:

- Parse CIFF container.
- Support the downloaded fixture mode only at first.
- Extract Canon metadata where possible.
- If pixel packing is not implemented for that mode, reject and use LibRaw.

RW2:

- Parse Panasonic TIFF-like header.
- Support downloaded fixture mode only at first.
- Reject unknown Panasonic compression.
- Compare against LibRaw output.

## Test Corpus

Download public-domain raw.pixls.us samples into `C:\Foo\raw-converter\tests`:

- NEF
- NRW
- CR3
- CRW
- RW2
- RWL

Also write `raw-thirdparty-samples.json` in that corpus with source URLs, SHA-256, size, and license note.

## Testing

TDD gates:

- `web/format-detect.test.js` fails first for new extensions.
- `web/libraw-normalize.test.js` fails first for LibRaw metadata-to-payload mapping.
- Rust unit test fails first for `process_raw_mosaic_with_flags`.
- JS hand decoder tests fail first for NEF/CRW/RW2 fixture dispatch and fallback semantics.
- Corpus comparison script checks hand decoder vs LibRaw and records metrics.

Verification commands:

```powershell
rtk proxy bun test web/format-detect.test.js
rtk proxy bun test web/libraw-normalize.test.js
rtk proxy bun test web/hand-raw-decoders.test.js
rtk proxy cargo test --lib process_raw_mosaic
rtk proxy bun run build
```

## Approval

User delegated critique, refinement, and approval. This spec is self-approved for implementation.
