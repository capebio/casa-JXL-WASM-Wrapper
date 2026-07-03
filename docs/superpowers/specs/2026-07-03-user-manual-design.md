# User Manual — Design Spec

**Date:** 2026-07-03  
**Status:** Approved  
**Output:** `docs/user-manual.html` (single self-contained file)  
**Audience:** Internal developers onboarding to the CasaWASM / raw-converter-wasm codebase

---

## 1. Goal

A self-contained HTML reference manual for the JPEGXL implementation covering:
- Module architecture and layer map
- CASAVA video container (JOLT lossy + FableBraid lossless)
- Perceptual metrics kernel (Rust SIMD replacement for JS Butteraugli)
- Benchmark framework and timing test results

No external dependencies. No build step. Open in any browser.

## 2. Constraints

- Single HTML file — all CSS, JS, content inline
- Tabbed layout (4 tabs, switchable with zero page reload)
- Internal-dev focus — technical depth, exact module names, file paths, measured numbers
- Self-contained — key facts embedded; does not link to `.md` docs

## 3. Structure

### Tab 1 · Architecture

**Stack diagram (SVG, interactive hover):**
```
UI / main.js
  └─ jxl-stream        ingestion: ReadableStream / fetch → push interface
  └─ jxl-session       API: hides workers/scheduler; emits AsyncEventStream of frames
       └─ jxl-scheduler    intelligence: preemption, dedup, backpressure, pool
            └─ jxl-worker-browser / jxl-worker-node
                 └─ decode-handler / encode-handler
                      └─ jxl-wasm/facade.ts   FFI: WASM heap management
                           └─ bridge.cpp / libjxl-012
jxl-cache              persistence: OPFS/fs; sits beside the pipeline, not in it
src/lib.rs             RAW pipeline: ORF/DNG/CR2 → RGB8/16 pixel buffer
```

**Module map table:** all 16 `packages/`, 3 `crates/`, key `web/` files with role and optimization score.

**Layer invariants:** what belongs where (backpressure / dedup / budget / preemption / format validation / session protocol).

**Build overview:** wasm-pack → `web/pkg/`, Emscripten → `packages/jxl-wasm/dist/jxl-core.*.js`, `build-msvc.ps1` for native cjxl.

---

### Tab 2 · CASAVA

**What it is:** `.casv` container, on-disk magic `CASV`, public name "Casabio's Video Apparatus". Built on JXL VarDCT intra-frames + REPLACE-skip P-frames. Two codec tiers:

**JOLT (lossy streaming):**
- REPLACE-skip P-frames with source-frame change detection; drift-free (encoder never decodes own output)
- Presets table: Realtime (d=2.0, e=1, 55fps), Balanced (d=1.0, e=3, 42fps), Quality (d=0.5, e=4, 53fps)
- Rate control: closed-loop VBV feedback (`d *= sqrt(actual/target)`), converges in a few GOPs, zero extra encode cost
- Rate metadata: `CasvHeader.flags` (header files) / `CASR` rate box (streamed files)
- Measured results: 720p dashcam, 48 frames — Realtime 3.0% of raw / Balanced 5.2% / Quality 8.1% / lossless 13.3%

**FableBraid (lossless):**
- 8-way braided rANS, mod-256 row predictors, no libjxl dependency
- Format: `FBR1` header, per-plane blob with predictor/row-modes/rANS/raw sections
- Decode speed: 3–16× faster than fjxl-e1 on BBB keyframes; size −29..+6% vs JXL-e3
- Use case: lossless CASAVA tier, casv temporal-delta P-frames

**casv-web package:** `packages/casv-web` — browser decode/showcase/export, 8 tests.

**Rust API:** `jolt_encode`, `jolt_encode_stream_to`, `JoltPreset`, `CasaVideoOptions::streaming_bitrate(start_distance, target_bytes_per_sec)`.

---

### Tab 3 · Perceptual Metrics

**Purpose:** replaces `web/jxl-butteraugli.js` (JS approximation) with a shared Rust SIMD kernel for throughput at scale (millions of progressive-pass comparisons).

**Module layout:** `crates/raw-pipeline/src/perceptual/`
- `butteraugli.rs` — XYB + box-blur + 3-scale p-norm (p=3) approx
- `ssim.rs` — global moment SSIM + channel moments
- `psnr.rs` — MSE → dB
- `xyb.rs` — RGBA u8 → planar X/Y/B f32 (sqrt-linear LUT)
- `blur.rs` — separable box blur, clamp-to-edge
- `simd/scalar.rs` — parity oracle (portable Rust, universal fallback)
- `simd/avx2.rs` — AVX2 + FMA (x86_64)
- `simd/wasm.rs` — v128 SIMD (wasm32)
- `simd/avx512.rs` — optional f32×16 path, cfg + runtime-gated

**Three metrics table:** cost / shape / use case for each.

**SIMD dispatch:** `BackendChoice::Auto` picks fastest at runtime. Parity chain: scalar ↔ SIMD ≤1e-4 relative; Rust scalar ↔ JS ≤1e-3 port-fidelity gate.

**Calibration results:**
- Butteraugli ≤1.5 → only at 100% bytes (full decode)
- Butteraugli ≤5.0 → first AC pass complete (~50% bytes) ← recommended threshold
- SSIM ≥0.9 → DC-pass only (blocky, Butteraugli ~62 — misleadingly optimistic)

**JS fallback:** `web/jxl-butteraugli.js` remains in browser convergence loop; `_jxl_wasm_ssim_compare` shipped but engine choice pending flipflop result.

---

### Tab 4 · Benchmarks

**Flipflop framework:**
- Interleaved N-way A/B timing; start-rotation cancels thermal drift
- TOON ledger: `.toon` files in `docs/benchmarks/`, one row per flip with time + memory + temperature + quality
- Invoked via `node flipflop.mjs <test-file> --print`

**Section bench** (`crates/raw-pipeline/examples/pipeline_section_bench.rs`):
- 8 sections: `raw_parse` / `demosaic` / `tone` / `encode` / `decode_full` / `ttfp` / `load_e2e` / `ttfp_e2e`
- Two modes: `relative` (vs last run, regression detector) / `absolute` (vs libjxl 0.11.2 anchor, interleaved A/B)
- Output: console table + inline-SVG bar chart + JSON

**Timing tests 1–22 summary table** (name / what swept / key finding):

| Test | Sweep | Key finding |
|------|-------|-------------|
| 1 · Progressive vs one-shot | Encode strategy | Progressive: +200ms encode, −60ms first paint → use progressive |
| 2 · Thumbnail generation | 400px encode+decode | effort=3, quality=80; downsample=2 saves ~1–2.4× (minimal abs) |
| 3 · Lightbox detail | 1600px, ROI | ROI center-50% ~245–415ms; use effort=3, quality=85, progressive |
| 3.1 · Effort sweep | effort 3→5→7 | 808ms→1829ms→3513ms; lock effort=3 for real-time |
| 5 · Streaming first-paint | Byte cutoffs | 25% → PSNR ~21.8; 50% → PSNR ~28.6 + first AC pass complete |
| 6 · Policy matrix | effort/quality/modular/resampling | VarDCT > forced modular; resampling negligible |
| 7 · P3.1 features | previewFirst / region+ds | previewFirst SLOWER than first AC pass; don't use |
| 13 · Quality ladder | q70→q95 at 1600px | q85 = 465KB best web balance; q95 = 1042KB |
| 14 · Modular mode | modular vs VarDCT | Forced modular 2.2MB+slow; VarDCT always wins for photo |

**Locked settings (authoritative):**
- `effort = 3`
- `quality = 85` (full) / `80` (thumbnail)
- `progressive = true`, `progressiveFlavor = 'ac'`
- `previewFirst = false`
- Modular: default (VarDCT, do not force)

**JOLT performance (720p, 48 frames, i7-10850H single-thread):**

| Tier | Size | vs raw | enc ms/f | dec ms/f | dec fps | 24fps? |
|------|------|--------|----------|----------|---------|--------|
| JOLT Realtime | 4.04 MB | 3.0% | 60.1 | 18.1 | 55 | PASS |
| JOLT Balanced | 6.87 MB | 5.2% | 73.1 | 23.8 | 42 | PASS |
| JOLT Quality | 10.76 MB | 8.1% | 81.6 | 18.8 | 53 | PASS |
| Lossless archive | 17.69 MB | 13.3% | 33.8 | 109.7 | 9 | FAIL |

---

## 4. HTML implementation details

- Pure HTML/CSS/JS, no framework
- Tab switching: JS class toggle on `.tab-content`, `.tab-btn`
- Color scheme: dark (`#0b0e14` bg, `#e7ecf4` ink) matching existing `docs/ecosystem-map.html`
- SVG stack diagram: layered rectangles with hover tooltips showing file paths
- Tables: styled with alternating row shading, monospace file paths
- Code blocks: dark background, syntax-hinted with `<span class="kw/fn/str">`
- Locked-settings box: visually distinct callout (green border)

## 5. Success criteria

1. Opens in browser with no network requests
2. All 4 tabs switch correctly
3. Module map matches CLAUDE.md layer map exactly
4. JOLT perf numbers match `docs/jolt-lossy-video.md` exactly
5. Locked settings match `docs/Timing Test Summary.md` exactly
6. Perceptual module paths match `crates/raw-pipeline/src/perceptual/` exactly
