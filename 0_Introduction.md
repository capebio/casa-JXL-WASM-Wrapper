# CasaWASM — Integration Guide

**Role in CASABIO:** browser-side RAW image engine. Converts camera files (ORF/DNG/CR2/CR3/NRW/CRW/TIFF/JPEG) to JPEG XL for upload; decodes JXL for display; caches in BLISS format locally for instant repeat views.

Server never touches RAW files. All heavy lifting is client-side WASM.

---

## Architecture: Three-Format Model

```
                   NETWORK / CDN           CLIENT LOCAL           OPFS CACHE
                  ─────────────────        ────────────           ──────────
Upload:      RAW → [JXL effort-3, ~8MB] ──────────────────────────────────────▶ server
Display:     server ──[JXL]──▶ decode ──▶ canvas
Ingest:      RAW → [BLISS ~300KB/img] ──────────────────────────────────────▶ OPFS/bliss/
             next open: OPFS hit → decode (~20ms) → canvas  (before RAW re-decode)
Video:       RAW sequence → [CASV/JXL] ──────────────────────────────────────▶ server
```

| Format | Role | Where |
|--------|------|--------|
| **JXL** | archival + delivery | server → CDN → client |
| **BLISS** (bliss-core codec) | instant client preview cache | OPFS only, never sent |
| **CASV** | JXL-tiled video | server → CDN → client |
| **BLTV** | Bliss TV video (lossless reference, not for distribution) | local only |

---

## Repository Map

```
src/
  lib.rs              — WASM entry: all #[wasm_bindgen] RAW exports
  bliss_wasm.rs       — bliss_encode / bliss_decode exports
  bltv_wasm.rs        — BltvDecoder struct export
  denoise_session.rs  — DenoiseSession (noise-aware MHC denoise)
  crates/raw-pipeline/— native Rust RAW pipeline (shared with Tauri)

web/
  worker.js           — per-file RAW decode worker (pool of N)
  main.js             — WorkerPool, lightbox, card grid, BLISS OPFS
  worker-message-types.js — shared WorkerMsg enum
  bliss-worker.js     — single shared BLISS decode worker (OPFS → display)
  bltv-player.html    — standalone BLTV video player page
  bltv-worker.js      — BLTV decode worker for player
  pkg/                — built WASM (raw_converter_wasm.js + .wasm)

packages/
  jxl-scheduler/     — preemption, dedupe, adaptive HWM backpressure
  jxl-worker-browser/— decode-handler, session state machine
  jxl-wasm/          — WASM heap management, C++ bridge (facade.ts)
  jxl-session/       — public DecodeSession API
  jxl-stream/        — fromReadableStream / fromResponse
  jxl-cache/         — OPFS + LRU cache for JXL derived pixels
  jxl-pyramid/       — tiled progressive pyramid encode
  casv-web/          — CASV video encode/decode (TypeScript)
  asset-store/       — S3 asset admission + OPFS adapter

C:\Foo\bliss/        — Bliss codec workspace (sibling repo)
  bliss-core/        — core image codec (checkerboard-median, rANS)
  bltv/              — BLTV video container (I-frames + delta P-frames)
  bliss-bench/       — benchmarks + abflip A/B harness
  bliss-cli/         — CLI encoder/decoder
```

---

## WASM API (`web/pkg/raw_converter_wasm.js`)

### RAW Pipeline — Image Decode

All functions return `ProcessResult` (or throw on fatal error). Call `.take_lightbox_renderer()` / `.take_thumb_renderer()` to get `LookRenderer` for tone/look application, then `.take_rgb()` for pixel bytes.

| Function | Input | Output |
|----------|-------|--------|
| `process_orf(bytes)` | Olympus ORF | `ProcessResult` |
| `process_orf_with_options(bytes, opts)` | ORF + `ProcessOptions` | `ProcessResult` |
| `process_dng(bytes)` | DNG (Adobe/Pixel/Leica) | `ProcessResult` |
| `process_dng_with_options(bytes, opts)` | DNG + options | `ProcessResult` |
| `process_cr2(bytes)` | Canon CR2 | `ProcessResult` |
| `process_cr2_with_options(bytes, opts)` | CR2 + options | `ProcessResult` |
| `process_raw_mosaic_with_options(bytes, opts)` | Generic Bayer mosaic | `ProcessResult` |
| `orf_proxy_jpeg(bytes)` | ORF | embedded JPEG preview (fast path) |
| `downscale_rgb(bytes, w, h, tw, th)` | RGB8 | downscaled RGB8 |
| `downscale_rgba(bytes, w, h, tw, th)` | RGBA8 | downscaled RGBA8 |

**`ProcessOptions` key fields** (JS object):
```js
{
  lossless: bool,        // export lossless JXL
  quality: number,       // 0-100, used when lossless=false
  effort: number,        // JXL effort 1-9 (default 3)
  userRotation: number,  // additional CCW rotation in degrees (0/90/180/270)
  output_flags: number,  // bitmask: OUT_NO_ORIENT=1, OUT_FULL_DISP16=2, OUT_SPLIT=8…
}
```

### Memory Budget

```js
estimate_decode_peak(width, height, output_flags)  → DecodePeakEstimate
estimate_decode_peak_mb(width, height, output_flags) → number  // MB
```

Use before admitting a file to avoid OOM. Budget: `WASM_HEAP_BUDGET_MB = 1800` (WASM heap cap ≈ 2GiB; 24MP decode peak ≈ 362MB).

### Look / Tone Rendering

```js
const renderer = result.take_lightbox_renderer();
renderer.set_wb(wbR, wbB);
renderer.set_look(lookBits);  // bitmask controls tone curve, saturation, etc.
const rgb = renderer.apply_look();  // → Uint8Array RGB8
renderer.free();
```

### BLISS (Instant Preview Cache)

```js
// Encode RGB8 → BLISS bytes. w must be even.
// q_y=1, q_c=1 = lossless. q_y=2, q_c=2 = near-lossless (~60% size, good for display cache).
bliss_encode(rgb: Uint8Array, w: u32, h: u32, q_y: u8, q_c: u8) → Uint8Array

// Decode BLISS bytes → [w u32 LE][h u32 LE][RGB8 bytes…]
bliss_decode(data: Uint8Array) → Uint8Array
```

**BLISS format facts:**
- ~300KB for 1800×1200 at q=2 (vs ~8MB JXL, ~6.5MB raw RGB)
- Decode: ~10ms at 1800px (vs ~200–500ms for JXL)
- Encode: ~10–30ms at 1800px
- Not for network use — always larger than JXL effort-3 at equal size
- Magic bytes: `BLSR` (v1 header)

### BLTV (Bliss TV — Lossless Video Reference)

```js
const dec = new BltvDecoder(data: Uint8Array);   // full .bltv file
dec.width()        → u32
dec.height()       → u32
dec.frame_count()  → u32
dec.fps_num()      → u32   // fps = fps_num / fps_den
dec.fps_den()      → u32
dec.is_lossless()  → bool
dec.decode_next_frame()  → Uint8Array | null   // RGB24, null at end
dec.seek(idx: u32)       → void
dec.free()
```

Player: `web/bltv-player.html`. Decode worker: `web/bltv-worker.js`.

**BLTV is not used for CASABIO server delivery** — CASV/JXL handles video distribution. BLTV is for local lossless masters and format research.

### Perceptual Quality

```js
compute_butteraugli(rgba_a, rgba_b, w, h)  → number   // perceptual distance
compute_ssim(rgba_a, rgba_b, w, h)         → number
```

### Denoise

```js
const session = new DenoiseSession(bytes, width, height);
session.push_frame(rgb: Uint8Array);
const denoised = session.flush();  // → Uint8Array RGB8
session.free();
```

---

## Worker Protocol (`web/worker-message-types.js`)

### Main → Worker

| Message | Purpose |
|---------|---------|
| `preload` | Prewarm WASM + rayon pool (sent to first 2 workers at startup) |
| `release_state` | Free retained `rgb16` live-edit state for a completed task |
| `reprocess_live` | Re-apply look to retained state, return `lightbox_live` |
| `reprocess_thumb_live` | Re-apply look, return `thumb_live` |
| `cancel` | Abort in-flight task |

### Worker → Main

| Message | Payload | Timing |
|---------|---------|--------|
| `thumb` | `{rgb, w, h, nativeW, nativeH, orientation, wbR, wbB, make, model, exif, pipelineMs}` | After demosaic+tone, ~500ms |
| `bliss_ready` | `{bliss: ArrayBuffer, width, height}` | After lightbox encode (~10ms after `lightbox`) |
| `lightbox` | `{rgb, w, h, nativeW, nativeH, orientation}` | Immediately after `bliss_ready` |
| `encode_request` | `{pixels: ArrayBuffer, format, width, height, quality, effort, lossless, orientation}` | After lightbox; pixels transferred (detached) |
| `done` | `{jxl: ArrayBuffer, jxlMs, w, h, effortUsed, pipelineMs, phaseMs}` | After JXL encode completes |
| `error` | `{message}` | On any fatal failure |
| `lightbox_live` | `{rgb, w, h}` | On `reprocess_live` response |
| `thumb_live` | `{rgb, w, h}` | On `reprocess_thumb_live` response |
| `error_live` | `{message}` | On live-edit failure |

**Critical ordering:** `bliss_ready` → `lightbox` → `encode_request` → `done`. The `encode_request` ArrayBuffer is transferred (detached on worker side). BLISS encode uses a view of the lightbox buffer before it is transferred.

---

## BLISS OPFS Integration (main.js)

### Write Path (ingest, automatic)

1. Worker encodes BLISS from 1800px lightbox RGB (~10ms)
2. Posts `bliss_ready` — main thread stores in `blissCache` (keyed by task id)
3. Main thread reads `cardByTaskId` to find `_assetId` (stable per file: FNV1a hash of path+size+mtime)
4. `blissOpfsWrite(assetId, bytes)` writes to `OPFS/bliss/<hash>` — fire-and-forget, non-fatal

### Read Path (new session or reprocess gap)

Triggered in `drawLightboxForCard` when `_lightbox` is null (card not yet decoded):
1. `blissOpfsRead(assetId)` — OPFS read, ~5ms
2. `blissDecodeViaWorker(bytes)` — sends to `bliss-worker.js`, ~10ms
3. Guards: skip if card changed or `_lightbox` populated by now
4. Paint → badge = "BLISS (cached)"

When the full RAW decode completes and `lightbox` arrives, `drawLightboxForCard` repaints with the full-quality RAW pixels automatically.

### Asset ID

```js
// stable across sessions for same file
const assetId = makeAssetId({ path, name, size, lastModified });
// returns: "fnv1a_hex:filename.ext"
```

---

## CASABIO Server Integration

### Upload Flow

The browser submits `encode_request` pixels to the JXL encode pool. The `done` message returns `jxl: ArrayBuffer`. Upload this to the server as `Content-Type: image/jxl`.

```js
// In pool onDone handler (main.js):
handlers.onDone = ({ jxl, w, h, effortUsed }) => {
    uploadToServer(jxl, { width: w, height: h, effort: effortUsed });
};
```

**Server must NOT expect RAW files.** The browser always sends JXL.

### JXL Decode for Display

Server serves JXL. Client decodes via `DecodeSession` (jxl-session package):

```js
import { DecodeSession } from 'packages/jxl-session/src/decode-session.js';
const session = new DecodeSession(scheduler);
session.push(chunk);
for await (const frame of session.frames()) {
    // frame.rgba: Uint8ClampedArray, frame.width, frame.height
}
```

Progressive decode with `cachePolicy: 'onFirstProgress'` is default for lightbox.

### CASV Video (server-side delivery)

Encode: `casv_encode` native binary (Rust, from `crates/casv/`). Called server-side.

Decode/play: `packages/casv-web/` — TypeScript, browser-only.

```js
import { CasvPlayer } from 'packages/casv-web/src/player.js';
const player = new CasvPlayer(container);
player.load(casvUrl);
player.play();
```

### Required HTTP Headers (COOP/COEP)

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Required for SharedArrayBuffer (WASM multithreading). Without these, rayon pool falls back to single-thread.

### Asset Identity

Use `makeAssetId({ path, name, size, lastModified })` client-side to derive a stable cache key. The server should use its own content-hash (SHA-256 of JXL bytes) as the canonical ID. The client `assetId` is for OPFS keying only.

---

## Tests

### Run All

```powershell
bun run test           # all packages (Jest + bun:test)
bun run typecheck      # TypeScript across all packages
```

### Key Test Files

| File | What it tests |
|------|--------------|
| `web/format-detect.test.js` | Magic-byte format routing (never let unknowns reach workers) |
| `web/asset-state-store.test.js` | `makeAssetId` stability, generation bumps, stale-result gating |
| `web/jxl-decode-cache-policy.test.js` | `onFirstProgress` / `onFinal` / `never` cache write policies |
| `web/export-service.test.js` | JXL export, sidecar writes, format-detect integration |
| `web/jxl-orientation.test.js` | EXIF orientation round-trip |
| `packages/jxl-scheduler/test/` | Preemption, dedupe, adaptive HWM backpressure |
| `packages/jxl-worker-browser/test/` | Decode budget, cancel-while-paused, drain coalescing |
| `packages/jxl-cache/test/` | LRU eviction, OPFS manifest, quota handling |
| `packages/casv-web/test/` | CASV format parity, CSAU audio, player state machine |
| `packages/asset-store/test/` | S3 admission, preflight budget, OPFS adapter |
| `C:\Foo\bliss\bliss-core/` (Rust) | `cargo test -p bliss-core` — roundtrip, lossy, 16-bit |
| `C:\Foo\bliss\bltv/tests/roundtrip.rs` | `cargo test -p bltv` — lossless, lossy, GOP, seek |

### Rust Tests (native)

```powershell
cd C:\Foo\raw-converter-wasm
.\build-msvc.ps1 test --lib          # root WASM crate (native target)
cargo test -p raw-pipeline           # RAW pipeline: ORF/DNG/CR2/colour
cd C:\Foo\bliss
cargo test                           # bliss-core + bltv roundtrips
```

### WASM Smoke Check

```powershell
cargo check --target wasm32-unknown-unknown --lib
```

### Benchmarks (Node)

```powershell
node StandardMultifileTest.mjs       # encode throughput on real RAW files
node benchmark/colour-pipeline-test.mjs  # colour fidelity (butteraugli vs reference)
```

---

## PR Readiness — Current Branch

**Branch:** `bench-pyramid-toggle-apples` (0 commits ahead of main — all BLISS work is uncommitted)

**Uncommitted in this session:**
- `src/bliss_wasm.rs`, `src/bltv_wasm.rs` — new WASM exports
- `src/lib.rs` — `mod bliss_wasm`, `mod bltv_wasm`
- `web/bliss-worker.js` — OPFS decode worker
- `web/bltv-player.html`, `web/bltv-worker.js` — BLTV player
- `web/worker.js` — BLISS encode at lightbox phase
- `web/main.js` — BLISS OPFS write/read, `blissOpfsLoad`, badge label
- `web/worker-message-types.js` — `BLISS_READY`
- `Cargo.toml` — `bliss-core`, `bltv` deps
- `web/pkg/` — rebuilt WASM

**Before PRing:** commit to a clean branch off main (or the current active dev branch), confirm `bun run test` passes, rebuild `web/pkg/` from that branch's source.

**Not yet wired:** OPFS BLISS eviction policy (no size cap on `OPFS/bliss/`); BLTV decode not exercised by automated tests; `bliss_decode` not tested in browser (only WASM check passes).

---

## Quick Reference: Which Tool?

| Need | Tool |
|------|------|
| Decode RAW for display | `process_orf/dng/cr2_with_options` → `LookRenderer` → `apply_look` |
| Upload archival JXL | pool `done` message → `jxl` ArrayBuffer |
| Fast preview cache | automatic via `bliss_ready` → OPFS; reads via `blissOpfsLoad` |
| Video delivery | CASV encode (server) → `CasvPlayer` (browser) |
| Video lossless master | BLTV (`BltvDecoder`) — local only |
| Perceptual quality check | `compute_butteraugli` |
| Denoise RAW sequence | `DenoiseSession` |
| Debug OPFS BLISS cache | `OPFS/bliss/<fnv1a_hex>` — one file per assetId |
| Add new format | Add `mod` in `src/lib.rs`, route in `web/format-detect.js`, add worker dispatch in `worker.js` |
