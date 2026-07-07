# K6#4 — FableBraid WASM Export: VERIFIED (2026-07-07)

Branch: `feat/k6-fablebraid-wasm-export-jul07`

## Summary

The FableBraid WASM decode export and the casv-web injection point that this
branch was scoped to add **already exist at the base commit** (`623abb8d`, merged
into `origin/main`). No re-implementation was needed — re-adding them would have
created duplicate/conflicting code. This branch's deliverable is the missing
**verification**: a build proof + a runnable Node smoke test.

## What already existed (audited, not changed)

- `src/lib.rs` (~L4193): `#[wasm_bindgen] pub struct FableDeltaSession` wrapping
  `raw_pipeline::fable_braid::DeltaDecodeSession`. No-arg `new()` constructor;
  `decode_intra(&[u8]) -> Result<Vec<u8>, JsError>`; `decode_delta(&[u8], &[u8], w, h)
  -> Result<Vec<u8>, JsError>`; `width`/`height` getters. Returns **interleaved
  RGB8** (`w*h*3`), not RGBA8.
  - NOTE: struct is named `FableDeltaSession`, not the handoff's guessed
    `FableDeltaSessionWasm`.
- `src/lib.rs` (~L4157): bench forwarders `fable_encode_rgb8`,
  `fable_encode_rgb8_delta`, `fable_decode_rgb8`, `fable_decode_rgb8_delta`.
- `packages/casv-web/src/index.ts`: `FableSession` interface
  (`decodeIntra`/`decodeDelta`), `FableSessionFactory = () => FableSession`,
  `PlayOptions.fableSession`, and `playFable()` dispatched from `playCasv` when
  `reader.rate.fable`. The factory is **no-arg** (matches `new FableDeltaSession()`),
  not the handoff's guessed `(w,h) => new FableDeltaSessionWasm(w,h)`.

## Build proof

```
wasm-pack build --target web --out-dir pkg --release
   Finished `release` profile [optimized] target(s) in 1m 52s
[INFO]: ✨   Done in 2m 07s   (exit 0; only pre-existing dead-code warnings)
```

`grep -nE "FableDeltaSession|fable_encode_rgb8|decode_intra|decode_delta" pkg/raw_converter_wasm.d.ts`:

```
75:export class FableDeltaSession {
82:    decode_delta(bytes: Uint8Array, prev: Uint8Array, w: number, h: number): Uint8Array;
87:    decode_intra(bytes: Uint8Array): Uint8Array;
88:    constructor();
89:    readonly height: number;
90:    readonly width: number;
445:export function fable_encode_rgb8(rgb: Uint8Array, width: number, height: number): Uint8Array;
447:export function fable_encode_rgb8_delta(cur: Uint8Array, prev: Uint8Array, width: number, height: number): Uint8Array;
```

(`pkg/` is gitignored and not committed.)

## Smoke test — `test-fable-wasm.mjs`

Self-contained + honest: the intra/delta bitstreams are **real** FableBraid frames
produced by the native encoder's own wasm forwarders (`fable_encode_rgb8` /
`fable_encode_rgb8_delta`), then decoded back through the stateful
`FableDeltaSession`. It is a genuine encode->decode roundtrip, not a fabricated blob.

```
$ node test-fable-wasm.mjs
PASS: FableDeltaSession wasm export
  intra:  1868 B bitstream -> 1152 B RGB8 (24x16x3), px0=[11,29,47]
  delta:  1796 B bitstream -> 1152 B RGB8, byte-exact roundtrip
  dims:   session reports 24x16
```

Assertions: `decode_intra` length == `w*h*3`; first pixel non-zero; byte-exact
lossless roundtrip to source; `width`/`height` getters correct; `decode_delta`
byte-exact roundtrip against the previous decoded frame.

## Reproduce

```powershell
wasm-pack build --target web --out-dir pkg --release
node test-fable-wasm.mjs
```
