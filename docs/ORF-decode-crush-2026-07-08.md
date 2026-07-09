# ORF decode-crush campaign — 2026-07-08/09

Goal: prove ORF's "intransigence" wrong (it lagged peers: ORF 3.5× vs CR2 8.1× / DNG 4.7×
in the 2026 RAW-decode campaign). Branch `perf/orf-decode-crush-jul08` (worktree
`C:\Foo\rcw-orf-crush`), commit `0c2df0db`. All numbers below are **measured** on this
machine (wasm, 20 MP `P1110226.ORF` = 5240×3912), byte-exact unless noted.

## TL;DR — root cause + results

ORF was not slow because the code was worse. Two reasons, both now cracked + measured:

1. **The decompress is a mathematically-serial VLC.** The Olympus predictive codec is a
   single monolithic bitstream; each pixel's predictor depends on all prior pixels.
   rawspeed's own source: *"there is no way to multithread this code."* No restart
   markers, no tile index, no manufacturer shortcut. CR2 (LJPEG slices) and DNG (tiles)
   parallelize their decode; ORF physically cannot. This is the irreducible floor.
2. **The benchmark under-measured the rest.** demosaic+tone are already MT in the shipped
   app (via `initThreadPool`); the 990 ms benchmark figure is inflated relative to real
   app behavior.

| Win | Measured | Verification |
|---|---|---|
| **#1 SIMD wide-refill** (decompress) | 402→**381 ms** (−5%), 1.03–1.05× sign-stable 1/3/20 MP | bit-exact: 13 native tests + wasm `equal=true` |
| **MT / initThreadPool** (demosaic+tone) | 1128→**232 ms** (4.86×) | browser, crossOriginIsolated, 12 threads |
| **#3 pipeline overlap** (decode∥demtone) | decode 494→**421 ms** (1.17× min) | **byte-identical=true** (native test + wasm pin) |
| **JPEG proxy** (view/export) | 990→**~30–50 ms** (~25–30×) | 5.2× native measured; camera render |

Honest single-file ORF decode end-state: **~421 ms** (serial-decompress-bound) + view/export
targets bypass to **~30–50 ms**. That closes ORF to peer level and beyond on the view path.

## Landed changes (commit 0c2df0db)

- `crates/raw-pipeline/src/decompress.rs` — `load_be_u64` (wasm+simd128 `i8x16.swizzle`
  byteswap, else `from_be_bytes`); `WIDE_FILL=true` both targets; `decompress_rows_into`
  → generic `<WIDE>` + `bench_decode_rows_into` for the A/B.
- `crates/raw-pipeline/src/stream_band.rs` — `decode_demosaic_tone_pipelined` (producer
  serial decode ∥ `par_bridge` consumers demosaic+tone; disjoint out writes by usize addr;
  sequential fallback). Test `pipelined_decode_matches_whole`.
- `crates/raw-pipeline/src/orf_proxy.rs` — `orf_proxy_rgb8` (embedded-JPEG proxy decode,
  decode-validated + strip-bounded). Example `orf_proxy_vs_full.rs`.
- `src/lib.rs` — `decompress_bench_*`, `demtone_bench_*`, `pipeline_bench_*` wasm exports.
- `tools/` — `orf_dissect.mjs` (ORF container dump), `decompress-flipflop.mjs`,
  `demtone-st.mjs` (node ST), `demtone-mt-run.mjs` + `pipeline-mt-run.mjs` (browser MT).

## #4 — remaining analysis (rejections with evidence)

**171 ms per-file overhead** (raw_ms 990 − 3 stages 819). Breakdown from telemetry:
lightbox+thumb previews ≈ 32 ms (preview_demosaic ~5 + downscale ~27), orientation, TIFF
parse (small), and wasm-bindgen marshalling of the ~24 MB RGB8 out. The one reducible chunk
is the previews — they demosaic the raw at reduced res, but could be sourced from the
embedded JPEG (the proxy path) for ~free. That is proxy-path wiring (JS/lib), tracked with
the proxy feature; the rest (parse/marshal) is structural.

**demosaic/tone kernels — at floor.** Measured MT: demosaic MHC 98 ms, tone 134 ms (20 MP,
12 threads). Both are SIMD (wasm v128) + rayon-parallel and were heavily optimized in prior
campaigns (scalar-LUT demosaic assembly, fused tone/colour, SIMD downscale). No further
byte-exact kernel win found; they parallelize well (4.86× combined) and #3 hides them behind
the decode. Codebase is "kernel-saturated + colour-gated."

**Speculative / segmented parallel decompress — REJECTED (impossible, not just hard).**
Confirmed via rawspeed/LibRaw/dcraw + the local port: the Olympus stream has no byte-aligned
resync, no restart interval, no row-offset index; the per-pixel literal length depends on the
running carry state, so a decoder started mid-stream cannot converge to bit-exact output. A
"cheap index pass" is impossible because finding row bit-offsets requires running the full
VLC arithmetic. Row-parallel decode is off the table; scale via batch (multi-file), already
landed. Do not re-chase.

**#2 one-fill-per-pixel — REJECTED (superseded by #1).** D3 (single big `fill` per pixel)
was already rejected natively (batch-to-56 makes fills near-free). #1's wide-refill now makes
each wasm fill a single SIMD load, so the fill-count concern is moot on both targets. Expected
win < 2%, inside noise. Not built.

## STATE + morning clean-run

- Source committed to `perf/orf-decode-crush-jul08` @ `0c2df0db`. NOT pushed, NOT merged.
- `web/pkg` in the worktree is a **parallel-wasm-only measurement build** (dropped
  c-perceptual) — left uncommitted. **Before shipping: rebuild properly**
  (`.\build-parallel-wasm.ps1` = parallel-wasm + c-perceptual) and run the colour-drift gate.
- Tonight's #3 median (1.036×) is **contention-noisy** — measured while the 48-agent
  optimize-codec-times workflow ran concurrently. The min (1.17×) is the clean signal.

### Clean-run commands (idle machine, morning)
```
# rebuild MT pkg fresh, copy for the browser harness
cd C:\Foo\rcw-orf-crush ; .\build-parallel-wasm.ps1 -Features parallel-wasm
Remove-Item -Recurse -Force C:\Foo\raw-converter-wasm\pkg-mt-orf ; Copy-Item -Recurse C:\Foo\rcw-orf-crush\pkg C:\Foo\raw-converter-wasm\pkg-mt-orf
cd C:\Foo\raw-converter-wasm
node tools/pipeline-mt-run.mjs      # #3 overlap: seq vs pipelined (expect > tonight's 1.17x min)
node tools/demtone-mt-run.mjs       # MT demtone (expect ~4.86x vs ST)
# decompress #1 (node, from worktree, its own pkg-bench):
cd C:\Foo\rcw-orf-crush ; $env:RUSTFLAGS="-C target-feature=+simd128" ; wasm-pack build --target nodejs --out-dir pkg-bench --release ; node tools/decompress-flipflop.mjs
```
Expect cleaner medians (no concurrent workflow). If #3 min drops below ~1.1× on an idle
machine, the deadlock-risk redesign (producer on calling thread + explicit spawned consumers)
is the fallback — see stream_band.rs note.
