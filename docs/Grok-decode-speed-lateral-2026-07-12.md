# Grok decode-speed lateral pass — 2026-07-12

Branch: `grok/decode-speed-lateral` (worktree `.worktrees/grok-decode-speed`, off `main`)

## Premise

Three "bottom reached" files still had **boundary / policy** waste, not kernel waste:

| Layer | File | Waste found |
|---|---|---|
| Worker | `decode-handler.ts` | Always-sliced full frames even when facade already handed an owned buffer (encode-handler already avoided this) |
| Bridge | `bridge.cpp` | Final-only decode still ran `JxlDecoderFlushImage` opportunistically + 80+ MB `memset` of the out buffer |
| Bridge | `bridge.cpp` | Every push `memcpy`'d the stream into `input_buf` after facade already `HEAPU8.set` it |
| RAW WASM | `src/lib.rs` | `vec![0u8; w*h*3]` zeroed ~60 MB before `process_into_auto` rewrote every byte |

## Changes (outcome-preserving)

### 1. `toTransferablePixels` — owned TypedArray transfer (decode-handler)

- If `byteOffset === 0 && byteLength === buffer.byteLength` → transfer the buffer **without** `.slice()`.
- Sub-views still slice (handler test with offset view still expects `copiedBytes`).
- Progressive contract unchanged: facade still copies WASM views before emit; we only drop the *second* copy.

### 2. Final-only progressive gate (bridge)

- Store `progressive_detail` on `JxlWasmDecState`.
- Opportunistic `TryFlushProgressiveImage` only when `progressive_detail != 0`.
- Out-buffer `memset` only when `progressive_detail != 0`.
- **DONOTCHANGE** progressive checkpoints preserved for Single Progressive / `lastPasses` / `passes` (detail ≠ 0).

### 3. Zero-copy input when remaining == 0 (bridge)

- First push / fully-consumed input: `JxlDecoderSetInput` points at caller's WASM heap region.
- Before return to JS (`NEED_MORE` / `PROGRESS`): `DecPromoteExternalInput` copies any unconsumed tail into owned `input_buf` so the next `HEAPU8.set` cannot corrupt it.

### 4. Skip RGB8 zero-init (lib.rs)

- `finish_from_raw`: `Vec::with_capacity` + `set_len` instead of `vec![0u8; n]`.
- Safe: `process_into_auto` asserts size and writes every output byte.

## Flipflop evidence

```text
node --expose-gc flipflop.mjs .flipflop/tests/decode-transfer-owned.mjs --print --no-metrics
node --expose-gc flipflop.mjs .flipflop/tests/decode-final-only-memset.mjs --print --no-metrics
node --expose-gc flipflop.mjs .flipflop/tests/decode-input-zerocopy.mjs --print --no-metrics
node --expose-gc flipflop.mjs .flipflop/tests/lib-rgb8-uninit.mjs --print --no-metrics
```

| Test | Headline geomean saved | Notes |
|---|---:|---|
| `decode-transfer-owned` | **~74%** on owned path | 16 MP: 45.8 → 6.2 ms; subview path wash (−6%, still slices) |
| `decode-final-only-memset` | **~86%** on that stage | 20.5 MP: 7.6 → 1.0 ms |
| `decode-input-zerocopy` | **~98%** on that stage | P2200619 JXL: 0.086 → 0.002 ms |
| `lib-rgb8-uninit` | **~1–5%** (write-dominated) | Absolute zero-init savings real in Rust; JS model understates |

Journal: `docs/outputs/timing tests/flipflop/flipflopjournal.toon`

## Unit tests

- `packages/jxl-worker-browser`: `bun test test/handlers.test.ts` → **22 pass**
- Progressive string contracts for new gates pass; unrelated ENOENT failures on this main-cut worktree (missing `web/jxl-correlation-matrix.js`, `external/libjxl-012`) are pre-existing vs active branches.

## Ship notes

- **JS path (decode-handler)** takes effect after `tsc` in `jxl-worker-browser` (dist rebuilt).
- **Bridge path** needs a jxl-wasm rebuild (`node scripts/build.mjs --host-toolchain` or Docker) before browser WASM sees flush/memset/input wins. Source is ready; dist WASM not rebuilt in this pass.
- **lib.rs** needs `wasm-pack` / package rebuild for RAW path.

## What this is *not*

- Not another demosaic/tone/LJPEG kernel micro-opt (those floors are real).
- Not progressive-UI degradation: detail≠0 keeps opportunistic flush + memset.
- Not speculative coalescing (still rejected for progressive first-paint).
