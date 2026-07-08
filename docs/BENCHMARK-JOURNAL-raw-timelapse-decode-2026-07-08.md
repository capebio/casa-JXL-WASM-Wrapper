# Benchmark Journal — RAW-Timelapse Batch Decode Parallelism

**Date:** 2026-07-08 · **Branch:** `perf/casv-video-simd-v2-jul05` · **Machine:** 12 rayon threads

This journal records the measurable result of wiring rayon frame-level parallelism into
the **library** RAW→CASV timelapse batch-decode path, plus the correctness gates and the
integration-health snapshot taken during the same pre-handoff pass.

---

## 1. Headline

`raw_pipeline::raw_video::encode_casv_from_raws` — the programmatic (in-process) entry for
encoding a sequence of RAW stills (ORF/DNG/CR2) into a `.casv` — drained its **batch tier**
(lossless / lossy `skip=none`) one frame at a time. The `casv_encode --raw-frames` CLI batch
path was already parallel; the library entry was leftover drift from before that upgrade.

**Fix:** replace the serial `next_frame_into` drain with `decode_all_parallel` (rayon
`par_iter`, order-preserving). Independent per-file decodes → **byte-identical** to the serial
drain, and the decode prefix now scales with cores instead of running single-threaded ahead of
the already-parallel batch encoder.

Diff (net **−7 lines**): the 8-line serial drain + `take_error` dance collapses to one call.

```rust
-        let mut frames: Vec<Vec<u8>> = Vec::new();
-        let mut buf = Vec::new();
-        while src.next_frame_into(&mut buf) { frames.push(std::mem::take(&mut buf)); }
-        if let Some(err) = src.take_error() { return Err(VideoError::Raw(err)); }
+        let frames = src.decode_all_parallel(&|_done| {})?;
```

---

## 2. Benchmark — decode scaling (serial drain vs `decode_all_parallel`)

Interleaved A/B (flipflop discipline): two variants of the same op run `A,B,A,B…` with
per-round **start-rotation** so thermal/turbo drift hits both arms equally; round 0 is a
discarded warmup; headline is the **warm median**; `trust` is `high` when the coefficient of
variation (stdev/median) < 0.10. Byte-identity of the two arms is asserted once per row before
timing. Corpus: 2 real Olympus ORF stills repeated to N frames (each decode is an independent
full-res demosaic + tone; the 1600px downscale is a cheap post-step, so decode cost ≈ full).

```
=== RAW-timelapse batch decode: serial drain vs decode_all_parallel (12 rayon threads) ===
  all frame-counts byte-identical serial==parallel ✓  (downscale target Some(1600))
    N        dims  serial ms   stdev     par ms   stdev  speedup  saved  trust
    4  1600x1195      1764.7    31.5      655.4    20.2    2.69x    +63%  high
    8  1600x1195      4013.4   235.7     1156.5    86.3    3.47x    +71%  high
   16  1600x1195      7761.6   307.3     2200.9   186.2    3.53x    +72%  high
```

| Frames | Serial (ms) | Parallel (ms) | Speedup | Saved | Trust |
|-------:|------------:|--------------:|--------:|------:|:-----:|
| 4      | 1764.7      | 655.4         | **2.69×** | +63% | high |
| 8      | 4013.4      | 1156.5        | **3.47×** | +71% | high |
| 16     | 7761.6      | 2200.9        | **3.53×** | +72% | high |

**Reading it:** speedup rises from 2.69× (N=4) and **saturates near 3.5×** — *not* 12×. That is
the honest, expected result: each individual RAW decode already uses rayon internally for its
demosaic/tone kernels, so frame-level parallelism stacks on top of an already-busy thread pool.
The saturation point sits well below the raw thread count because the pool is shared between the
two levels of parallelism. A ~3.5× wall-clock reduction on the decode prefix of a lossless
timelapse encode is nonetheless a real, repeatable win.

---

## 3. Correctness gate

- **Byte-identity (in-bench):** every sweep row asserts `serial(...) == decode_all_parallel(...)`
  over the full decoded RGB8 frame set before timing. `par_iter().collect()` preserves file
  order and each RAW is an independent decode, so equality holds by construction.
- **Final-bytes identity (pre-existing gate):** `examples/raw_timelapse_decode_ab.rs` additionally
  proves the *encoded `.casv`* is byte-identical between serial and parallel decode, and
  `examples/raw_video_exact_sha.rs` SHA-gates `encode_casv_from_raws` at the lossless tier.
- **Full engine suite green:** `cargo test --lib` (raw-pipeline) = **392 passed, 15 ignored, 0
  failed** (the 15 ignored are perf-A/B benches and byte-exact gates, run manually). Root WASM
  crate = **9 passed**. `@casabio/asset-store` node tests = **43 passed**.

---

## 4. Scope (what this does and does not move)

| Path | Affected? | Why |
|---|:--:|---|
| Library `encode_casv_from_raws`, **batch** tier (lossless / skip=none) | ✅ 2.7–3.5× decode | The change |
| `casv_encode --raw-frames` CLI | ➖ no change | Was already parallel |
| Streaming tier (lossy bbox/tile) | ➖ no change | Decode∥encode overlap, constant-peak; unchanged |
| Non-RAW video input (PNG / synthetic frames) | ➖ n/a | Doesn't decode RAW |
| Browser / still-image JXL (`StandardMultifileTest.mjs`) | ➖ no change | Native-only, video path, disjoint |

Existing CASV **throughput** benches (`casv_bench`, `casv_speed_flip`, `casv_mt_flip`, `tier_bench`)
feed in-memory/synthetic frames through the streaming tier and will read identical numbers — they
never exercise RAW batch decode. The bench that *does* show this win is the decode A/B here.

---

## 5. Companion cleanup (same pass)

- **Dead-code removed** (`pipeline.rs`): `build_post_lut_strided` + `COMPACT_POST_LUT_LEN/SHIFT` —
  zero callers, an abandoned "compact post-LUT" experiment whose doc promised interpolation the code
  never did (straight `>>4` access would band). Behavior-neutral; green on native + wasm.
- **Cross-module correctness verified (no change needed):** every `OUT_*` flag bit is consistent
  across all JS and Rust definitions (the class that once caused double-rotated portraits is clean);
  the JS `estimateDecodePeak` admission mirror is line-by-line identical to Rust
  `mem_budget::estimate_decode_peak`; `process_region` does a single demosaic (no double-work).

---

## 6. Reproduce

```powershell
cd crates\raw-pipeline

# Decode-scaling sweep (default N = 4 8 16; pass your own counts as args):
cargo run --release --example raw_video_decode_par_flip
cargo run --release --example raw_video_decode_par_flip -- 8 24 48

# Byte-identity of the final .casv (serial vs parallel), on a directory of CR2:
cargo run --release --example raw_timelapse_decode_ab -- <dir-of-CR2> 1920

# Full engine suite:
cargo test --lib
```

*(The sweep is path-gated to the local ORF corpus and exits 0 as a no-op where absent, e.g. CI.)*
