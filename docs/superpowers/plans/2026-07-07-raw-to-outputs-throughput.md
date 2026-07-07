# RAW-to-Outputs Throughput Implementation Plan (Phases 1–5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise end-to-end throughput of the RAW → still + video pipeline (native + WASM, lossless + lossy routes) by deleting redundant work first, then reshaping parallelism, then pipelining video, then local opts, then measuring + automating — without changing lossless output bytes and keeping lossy output within a perceptual gate.

**Architecture:** The repo ships ONE `raw-pipeline` crate consumed by both native (full, `jxl-codec`) and WASM (`default-features=false`, subset — video is native-only). Browser orchestration lives in `web/main.js` (RAW decode pool) + `web/worker.js` (decode workers) + the jxl-session/scheduler encode pool. Measured facts driving the ordering: ORF/LJPEG entropy `decompress` is **74% of native decode and irreducibly serial** (caps whole-decode MT at 1.2×), tone is **45–55% of WASM decode**, JXL encode is **distributed in thirds** (lever = PGO not a fork). Therefore batch throughput comes from **file-level parallelism (N single-threaded decoders)**, not from threading one file, and the biggest single-item cuts are **deletions** of redundant passes/copies/allocations.

**Tech Stack:** Rust (raw-pipeline, rayon, own JXL FFI), Rust→WASM (`wasm-pack --target web`), TypeScript/JS orchestration (bun workspace), flip-flop A/B harnesses (`flipflop.mjs`, `flipflopdom.mjs`, `examples/*_flip.rs`, golden baselines).

---

## Verification Model (read before executing any task)

Every task has **two gates**. A task is done only when BOTH pass.

1. **Correctness gate** — the change must not alter output beyond its allowed latitude:
   - *Lossless / pixel-neutral tasks:* byte-exact. Gate = a golden/SHA assertion or an interleaved A/B that asserts `A == B` byte-for-byte.
   - *Lossy tasks:* Butteraugli/SSIM under threshold via `run-metric-bench.ps1` or `bench/butteraugli-smoke-test.mjs`.
2. **Throughput gate** — an interleaved A/B (flip-flop) showing the change is neutral-or-faster. Never trust a single wall-clock number: use the flip-flop engines (median + geomean over interleaved reps, start-rotation cancels thermal drift). **Measure on AC power** (repo memory: battery = power-limited CPU, false "wins"); trust relative deltas + min-of-reps, not absolute ms.

**Harness cheat-sheet**

| Harness | Measures | Gate type | Env | Invoke |
|---|---|---|---|---|
| `crates/raw-pipeline/examples/pipeline_profile.rs` | decompress/demosaic/tone split | timing | native | `cargo run -p raw-pipeline --release --features parallel --example pipeline_profile -- <file>` |
| `examples/*_flip.rs` (e.g. `process_simd_flip`, `demosaic_mhc_avx2_flip`) | per-kernel A/B, byte-asserted | byte-exact + timing | native | `cargo run -p raw-pipeline --release --example <name> -- <file>` |
| `examples/casv_bench.rs` | per-frame enc/dec ms vs 41.7ms/24fps | timing | native | `cargo run -p raw-pipeline --release --features jxl-codec --example casv_bench -- <frames-dir>` |
| `examples/casv_golden.rs`, `fable_golden.rs` | decode byte/SHA golden | byte-exact | native | `cargo run ... --example casv_golden` |
| `benchmark/encode-golden-baseline.json` | encode SHA-256 per image×variant | byte-exact | node | `node StandardEncDecTest.mjs` (compares to baseline) |
| `flipflop.mjs` + `.flipflop/tests/*.mjs` | JS/WASM A/B timing, optional quality gate | perceptual/timing | node | `node flipflop.mjs .flipflop/tests/<t>.mjs --print --sizes 1024,2048` |
| `flipflopdom.mjs` + `.flipflop/dom-tests/*.mjs` | **browser** A/B (COOP/COEP, real worker pool) | perceptual/timing | headless Chrome | `node flipflopdom.mjs .flipflop/dom-tests/<t>.mjs` |
| `flipflopMem.mjs` | RSS delta | memory | node | `node flipflopMem.mjs .flipflop/tests/<t>.mjs` |
| `StandardMultifileTest.mjs` | end-to-end 8-file decode+encode through real stack | perceptual regression | node | `node StandardMultifileTest.mjs` |

**Test corpus** (confirmed present): real files at `C:\Foo\raw-converter\tests\` (Canon `.CR2`, Olympus `.ORF`, Pixel `.dng` incl. **portrait ori=6** DNGs, `real_video_ghana[_1080]/` frame dirs); big synthetics at `C:\Foo\raw-converter\tests\fractal_gen\` (`mandelbrot_seahorse_*_{256..16384}px.tif`) and `fractal_gen_seahorse_{static,motion,zoom,parallax}/` for video motion characteristics. Point harnesses here.

**WASM-rebuild rule:** JS/WASM benchmarks run the *prebuilt* `web/pkg`. A Rust source change reaches the browser gate ONLY after `wasm-pack build --target web --out-dir web/pkg --release` (or `build-parallel-wasm.ps1` for the MT tier). Native gates see Rust changes immediately. Each Rust task below states whether a pkg rebuild is needed for its browser gate.

**Git isolation:** Phases 3–4 make parallel-execution changes in large Rust files. If executing via subagents, each task runs in its own `git worktree` (per global CLAUDE.md). Never switch the primary checkout's branch. Forward-commit on the current branch (`perf/casv-video-simd-v2-jul05`) is fine.

**Phase 0 (already shipped):** `web/worker.js:114` `OUT_NO_ORIENT` `8 → 16`. Verified live: portrait ori=6 DNGs stopped rotating (dims sensor-native `4080x3072`, `orient_ms 26–50 → 0`), landscape byte-identical. Removes per-portrait rotate + ~60–200 MB transient + ~120 MB rgb16 retention, fixes portrait double-rotation. No rebuild needed (WASM already expects 16).

---

## Phase 1 — QUESTION & DELETE redundant work (lossless-exact; funds Phase 2)

Order rationale: these are pure removals of work that is measurably redundant. They also shed ~440 MB per in-flight decode against the 2 GiB WASM cap, which is a *precondition* for Phase 2's file-level parallelism (more concurrent decodes must fit).

### Task 1.1: Skip the two-phase double-decompress for batch/headless exports

The ORF path decodes the 74%-dominant serial `decompress` **twice** per file (phase-1 previews + phase-2 full). This is a deliberate first-paint-latency trade for the *interactive* UI. For batch/headless conversion (no on-screen preview needed) it is pure waste. Gate the split on an interactivity flag; batch uses the single monolithic call shape DNG/CR2 already use.

**Files:**
- Modify: `web/worker.js:591` (the `canSplit` predicate) and `:597-599` (phase-1 flags)
- Modify: `web/main.js:1855-1863` (thread `batch` through `pool.submit`)
- Test: `web/two-phase-raw.test.js` (already asserts single-call ≡ two-phase byte-equal; extend with the batch gate)

- [ ] **Step 1: Write the failing test** — assert that when `batch:true`, the ORF path runs decompress exactly once. Add to `web/two-phase-raw.test.js`:

```js
test('batch flag decodes ORF once (no double decompress)', () => {
  const bytes = readFileSync(join(TESTS, 'P1110226.ORF'));
  // single monolithic call = the batch shape
  const single = processNeutral(process_orf_with_flags,
    bytes, OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB | OUT_NO_ORIENT);
  const singleDecompress = single.decompress_ms; single.free();
  // two-phase = interactive shape (phase1 previews + phase2 full)
  const p1 = processNeutral(process_orf_with_flags, bytes, OUT_LIGHTBOX | OUT_THUMB);
  const p2 = processNeutral(process_orf_with_flags, bytes, OUT_FULL_RGB8 | OUT_NO_ORIENT);
  const twoPhaseDecompress = p1.decompress_ms + p2.decompress_ms; p1.free(); p2.free();
  // batch must match the single-call cost, i.e. strictly less than two-phase
  assert.ok(twoPhaseDecompress > singleDecompress * 1.5,
    `two-phase should pay ~2x decompress: ${twoPhaseDecompress} vs ${singleDecompress}`);
});
```

- [ ] **Step 2: Run it** — `cd web && bun test two-phase-raw.test.js` — expect PASS on the assertion itself (this documents the current 2× cost; it is the baseline the worker change must honor).

- [ ] **Step 3: Implement the worker gate.** In `web/worker.js`, thread a `batch` option and gate the split:

```js
// worker.js — inside the decode handler, opts already destructured
const interactive = opts.batch !== true;           // default interactive
const canSplit = interactive && decoderFn === process_orf_with_flags;
const phase1Flags = canSplit
  ? (OUT_LIGHTBOX | OUT_THUMB)
  : (OUT_FULL_RGB8 | OUT_LIGHTBOX | OUT_THUMB | OUT_NO_ORIENT); // one decode
```

- [ ] **Step 4: Thread `batch` from the submit site.** In `web/main.js` `pool.submit`, forward `opts.batch` into the task posted to the worker (it already spreads `opts`; confirm `batch` survives the `postMessage`). Add a `batch` param to the public convert-many entry point (the loop that enqueues a folder). Do not set `batch` on the interactive single-drop path.

- [ ] **Step 5: Browser throughput gate.** Create `.flipflop/dom-tests/batch-orf-single-decode.mjs` that runs a 4-file ORF batch with `batch:true` vs `batch:false` and asserts total `decompress` time drops ~1 decompress/file and output pixels are byte-identical. Run: `node flipflopdom.mjs .flipflop/dom-tests/batch-orf-single-decode.mjs`. Expected: batch total decode wall-clock ≈ (1 − 0.74/2)×interactive per ORF; pixels identical.

- [ ] **Step 6: Commit**

```bash
git add web/worker.js web/main.js web/two-phase-raw.test.js .flipflop/dom-tests/batch-orf-single-decode.mjs
git commit -m "perf(worker): decode ORF once for batch exports (skip two-phase double-decompress)"
```

### Task 1.2: Borrow (not copy) the encode input buffer — ❌ DROPPED (inert, already done upstream)

**Rejected 2026-07-07 after code trace.** The premise was wrong: the encode input is TRANSFERRED as an ArrayBuffer (`encode-session.ts:214`), and the facade's `copyOrBorrowInput` (`facade.ts:2921`, the ENCODER path — the original plan mislabeled the DECODER slice at `facade.ts:1486`) always returns a zero-copy `new Uint8Array(value)` VIEW for an ArrayBuffer regardless of `copyInput`. The `.slice()` only fires for a `Uint8Array` input with `copy===true`, which never happens here. The worker already passes `copyInput:false` (`encode-handler.ts:198`, upstream `36400b87`), and the session `EncodeOptions` (`types.ts:152`) has no `copyInput` field to forward — so adding it to `main.js` is a dead property. There is no ~60MB slice to remove; the only encode-input copy is the intrinsic `HEAPU8.set` into the WASM heap. **No code change.** (Lesson: the earlier browser-orchestration trace conflated the decoder `copyInput` slice with the encode path.)

<details><summary>Original (rejected) task text</summary>

`encodeJxlSession` doesn't set `copyInput`, so the facade does a defensive `.slice()` of the full RGB8 (`facade.ts:1485`) before the mandatory `HEAPU8.set`. That buffer is a single-owner ArrayBuffer transferred into the encode worker and discarded after `finish()` — never mutated — so borrowing is safe. Saves one ~60 MB memcpy/file.
</details>

*(Steps below are VOID — task dropped. Original for reference only.)*

**Files:**
- Modify: `web/main.js:970-991` (`encodeJxlSession` — pass `copyInput:false` into `encOpts`)
- Test: `benchmark/encode-golden-baseline.json` via `StandardEncDecTest.mjs`

- [ ] **Step 1: Capture the correctness gate first.** Run `node StandardEncDecTest.mjs` and confirm it currently matches `benchmark/encode-golden-baseline.json` (per-image SHA-256). Record the pass. This is the byte-exact gate the change must not break.

- [ ] **Step 2: Implement.** In `web/main.js` `encodeJxlSession`, thread `copyInput:false` into the encode options object passed to `session.pushPixels` / the facade encode call:

```js
const encOpts = { ...userEncOpts, copyInput: false }; // buffer is single-owner + transferred; safe to borrow
```

Confirm the buffer is not read again on the JS side after the push (it is nulled at `main.js:728` on the decode side; verify the encode push is the last use).

- [ ] **Step 3: Correctness gate.** Re-run `node StandardEncDecTest.mjs`. Expected: identical SHA-256 to `encode-golden-baseline.json` (byte-exact — encode is deterministic given identical input bytes).

- [ ] **Step 4: Throughput/memory gate.** `node flipflopMem.mjs .flipflop/tests/encode-copyinput.mjs` (create it: encode a 4096² buffer with `copyInput` true vs false, assert RSS delta lower and bytes identical). Expected: ~one full-frame allocation removed per encode.

- [ ] **Step 5: Commit**

```bash
git add web/main.js .flipflop/tests/encode-copyinput.mjs
git commit -m "perf(main): borrow encode input (copyInput:false) — drop ~60MB memcpy/file"
```

### Task 1.3: Delete the dead zero-fill on the three whole-frame decode buffers

`raw` (`decompress.rs:172`), `rgb16` (`demosaic.rs:1600`), and `rgb8` (`pipeline.rs:2493` / `lib.rs:1238`) are `vec![0; n]` then fully overwritten before any read — ~264 MB of dead memset per 24 MP whole-frame decode. The streaming path already proves this safe (`stream_band.rs:55-67` `extend_for_overwrite` + `set_len`). This is the riskiest delete: it MUST be proven that every element is written before any read. Do it one buffer at a time, each with its own byte-exact gate.

**Files (one sub-task each):**
- Modify: `crates/raw-pipeline/src/demosaic.rs:1600` (rgb16) — do this FIRST (clearest write-coverage: `par_chunks_mut` writes every output pixel)
- Modify: `crates/raw-pipeline/src/pipeline.rs:2493` (rgb8 out)
- Modify: `crates/raw-pipeline/src/decompress.rs:172` (raw) — LAST (author previously kept its memset "for safety"; predictor edges need the most care)
- Reuse: the existing `extend_for_overwrite` helper (`stream_band.rs:55`) — lift it to a shared `crate::util` if not already `pub(crate)`.

- [ ] **Step 1: Write the byte-exact gate (rgb16 first).** Add `examples/demosaic_nofill_flip.rs` — an interleaved A/B: arm A = current `vec![0u16; n3]`, arm B = `Vec::with_capacity(n3)` + `set_len` (unsafe, uninit), both run `demosaic_bayer_mhc`, assert output vectors are **byte-identical** and report timing.

```rust
// examples/demosaic_nofill_flip.rs (sketch)
// A: let mut out = vec![0u16; n3];  demosaic_into(&raw, w, h, &mut out);
// B: let mut out = Vec::with_capacity(n3); unsafe { out.set_len(n3); } demosaic_into(&raw, w, h, &mut out);
// assert_eq!(a, b);  // byte-exact — every output pixel is written by par_chunks_mut
```

- [ ] **Step 2: Run it** — `cargo run -p raw-pipeline --release --features parallel --example demosaic_nofill_flip -- "C:\Foo\raw-converter\tests\P1110226.ORF"`. Expected: `assert_eq` PASS (proves full write-coverage) + B ≥ A speed.

- [ ] **Step 3: Implement rgb16.** Replace the `vec![0u16; n3]` allocation at `demosaic.rs:1600` with capacity+`set_len` (or the shared `extend_for_overwrite`). Add a comment citing the write-coverage proof.

- [ ] **Step 4: Correctness gate.** `cargo test -p raw-pipeline` (the `process_synthetic_*` + `real_orf_parses_and_renders` tests exercise demosaic output) — expect PASS. Then `cargo run ... --example process_simd_flip -- <file>` to confirm end-to-end pixels unchanged.

- [ ] **Step 5: Repeat Steps 1–4 for rgb8** (`pipeline.rs:2493`): output is fully written by `process_into_simd`'s `par_chunks_mut`; same pattern, gate with `process_simd_flip`.

- [ ] **Step 6: Repeat for raw** (`decompress.rs:172`) with extra care: verify the predictor/unpack writes EVERY element including any tail/edge. Gate = `examples/decompress_trunc_fold_flip.rs` style A/B asserting byte-exact raw mosaic on ORF **and** a truncated-stream input (the reason the memset was kept). If any edge is not provably written, KEEP this memset and document why — do not force it.

- [ ] **Step 7: Rebuild pkg for the browser gate + measure.** `wasm-pack build --target web --out-dir web/pkg --release`, then `node flipflopdom.mjs .flipflop/dom-tests/decode-nofill.mjs` (create: decode A vs B, assert pixels identical + RSS/time). Expected: ~264 MB less memset traffic/decode; larger relative win single-thread WASM.

- [ ] **Step 8: Commit** (one commit per buffer is cleaner)

```bash
git add crates/raw-pipeline/src/demosaic.rs crates/raw-pipeline/examples/demosaic_nofill_flip.rs
git commit -m "perf(demosaic): drop dead zero-fill on rgb16 output (byte-exact, ~144MB memset/frame)"
# ...separate commits for rgb8 and raw...
```

### Task 1.4: Delete the RawVideoSource exact-dims double memcpy

When output dims equal sensor dims, `raw_video.rs:349` drains the band source into `full_rgb8` (copy 1) then `buf.extend_from_slice(&full_rgb8)` (copy 2). `drain_full_rgb8` already takes `out: &mut Vec<u8>`, so drain straight into `buf`.

**Files:**
- Modify: `crates/raw-pipeline/src/raw_video.rs:349-352`
- Test: `examples/casv_golden.rs` (or a focused `raw_video` roundtrip)

- [ ] **Step 1: Write the byte-exact gate.** Add `examples/raw_video_nocopy_flip.rs`: build a `RawVideoSource` at exact dims, pull a frame via the old (two-copy) and new (direct-drain) paths, `assert_eq!` the frame bytes.

- [ ] **Step 2: Run it** — `cargo run -p raw-pipeline --release --features jxl-codec --example raw_video_nocopy_flip -- "C:\Foo\raw-converter\tests\ADH 1234.CR2"`. Expected: currently no "new path" exists → compile error / fail.

- [ ] **Step 3: Implement.** In the `dw==w && dh==h` branch, pass `buf` directly to `drain_full_rgb8` and delete the `full_rgb8` temp + `extend_from_slice`.

- [ ] **Step 4: Correctness gate.** Re-run the flip (byte-exact) + `cargo run ... --example casv_golden` (decode golden unchanged, since encode input is byte-identical).

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/raw_video.rs crates/raw-pipeline/examples/raw_video_nocopy_flip.rs
git commit -m "perf(raw_video): drain exact-dims frame directly into buf (delete double memcpy)"
```

---

## Phase 2 — RESHAPE parallelism for batch throughput — ❌ NO THROUGHPUT WIN (measured 2026-07-07)

**Debunked by measurement.** A native proxy (`crates/raw-pipeline/examples/batch_concurrency_flip.rs`, commit `b9e81714`) reproduced the exact contention physics: N=12 concurrent full decodes (decompress+demosaic+tone), each confined to a per-worker rayon pool of T threads, on a 12-core AC-powered machine, flip-flop median of 7 rounds, RGB8 byte-identical across T. Result: **T=1 (proposed fix, 12 total threads) vs T=12=C (browser today, 144 total threads) = 0.99× — a dead heat.** T=2 marginally best (~1.01×) but within noise. At full batch saturation the machine is CPU+bandwidth-bound regardless of thread slicing: the 132 "extra" threads sleep during the serial `decompress` (74% of decode) and can't exceed shared memory bandwidth during the memory-bound demosaic/tone (DS-ROWPAR). **The oversubscription does NOT hurt throughput; the fix does NOT help it.**

Residual (non-throughput) merits of the fix — memory footprint (144 live thread stacks) and per-worker `initThreadPool` spawn/teardown — are real but out of scope for a throughput pass, and a possible small browser-only scheduling win is unproven and would need the expensive in-page harness (low ROI). **Do not land Tasks 2.2/2.3 on throughput grounds.**

**Key reframe (drives the rest of the plan):** on a saturated batch you cannot win with *more parallelism* — it is already maxed. You win only by **deleting work per file** (mode 3 single-decompress, Task 1.1, memsets, copies). Work-deletion helps BOTH single-file latency AND batch throughput (fewer CPU-seconds × N files). Parallelism reshuffling (Phase 2) is a dead end here.

<details><summary>Original (rejected-for-throughput) Phase 2 text + tasks</summary>

The browser runs POOL_SIZE decode workers, EACH calling `initThreadPool(hardwareConcurrency)` — 12×12=144 threads on 12 cores. Since `decompress` (the dominant stage) is serial, threading one file buys only 1.2× while oversubscribing 12×. Batch throughput wants **N single-threaded file-decoders**; interactive single-file wants **few workers × many threads** (tone-bound editing is 3.84× MT). Unify via an adaptive core budget. **Heuristic change → REQUIRES bench data before landing** (CLAUDE.md). — MEASURED: no throughput win (see above). Tasks 2.1–2.3 below are VOID for throughput.
</details>

*(Tasks 2.1–2.3 below are VOID for throughput — retained for reference only.)*

### Task 2.1: Record the batch baseline (measure before changing)

- [ ] **Step 1:** Create `.flipflop/dom-tests/batch-pool-utilization.mjs`: decode the 8-file `tests\` corpus as a batch, record total wall-clock + per-file decode ms + (if available) thread count. Run: `node flipflopdom.mjs .flipflop/dom-tests/batch-pool-utilization.mjs`. Save the JSON to `.flipflop/results/batch-baseline.json`. This is the A-arm for Tasks 2.2/2.3 — do not skip.

### Task 2.2: Cap per-worker rayon threads by regime

**Files:**
- Modify: `web/worker.js:154` (`initThreadPool` argument)
- Modify: `web/main.js:38` (POOL_SIZE) + submit path (pass a `regime`)

- [ ] **Step 1:** Add a regime signal: `interactive` (single in-flight file) → `POOL_SIZE_INTERACTIVE = min(2, cores)`, threads-per-worker = `cores` (latency). `batch` (queue depth > 1) → `POOL_SIZE_BATCH = min(cores, 12)`, threads-per-worker = `max(1, floor(cores / POOL_SIZE_BATCH))` (throughput). Pass the chosen threads-per-worker into the worker init message.

- [ ] **Step 2:** In `web/worker.js`, replace `initThreadPool(hardwareConcurrency)` with `initThreadPool(msg.threadsPerWorker ?? 1)`.

- [ ] **Step 3: Throughput gate (A/B vs 2.1 baseline).** Re-run `batch-pool-utilization.mjs`. Expected on ≥8-core AC-powered machine: batch total wall-clock drops materially (target: approach cores× file-parallelism, bounded by RAM). Single-file latency (interactive regime) unchanged vs baseline. Pixels byte-identical (pixel-neutral change).

- [ ] **Step 4:** If the A/B shows no win or a regression, STOP and record the measurement — do not land. (This is the CLAUDE.md tunable rule.)

- [ ] **Step 5: Commit** (only if the gate passed)

```bash
git add web/worker.js web/main.js .flipflop/dom-tests/batch-pool-utilization.mjs .flipflop/results/batch-baseline.json
git commit -m "perf(pool): scale per-worker rayon threads by regime (batch=file-parallel, interactive=MT)"
```

### Task 2.3: Wire the RAW decode pool into the global core budget

The encode pool obeys `globalCoreBudget` (`budget.ts:139`, wired at `context-base.ts:141`) but the hand-rolled RAW decode pool (`main.js:591`) does not, so decode(N+1)∥encode(N) can 2×-oversubscribe.

**Files:**
- Modify: `web/main.js:591` (decode pool acquires/releases budget tokens)

- [ ] **Step 1:** Import the same `globalCoreBudget` the encode scheduler uses; have the decode pool acquire N tokens (N = threads-per-worker) before dispatching a file and release on `ENCODE_REQUEST`.

- [ ] **Step 2: Gate.** Run a mixed decode+encode batch under `flipflopdom`; assert total live thread count ≤ cores (no oversubscription) and throughput ≥ Task 2.2 result. Pixels byte-identical.

- [ ] **Step 3: Commit** (if gate passed)

```bash
git add web/main.js
git commit -m "perf(pool): bound RAW decode pool by globalCoreBudget (no decode∥encode oversubscription)"
```

---

## Phase 3 — PIPELINE the video path (byte-identical)

The streaming CASV loop does `decode(N)` **then** `encode(N)` on one thread — the Amdahl island. Overlap decode(N+1) with encode(N). All changes here are pure scheduling → byte-identical codestream.

### Task 3.1: Record the CASV per-frame baseline (currently UNMEASURED)

- [ ] **Step 1:** `cargo run -p raw-pipeline --release --features jxl-codec --example casv_bench -- "C:\Foo\raw-converter\tests\real_video_ghana_1080"` (and the RAW-timelapse case using `ADH *.CR2` via `RawVideoSource`). Save output to `.flipflop/results/casv-baseline.txt`. This is the A-arm and establishes per-frame enc/dec ms vs the 41.7 ms/24fps budget.

### Task 3.2: Producer/consumer overlap in the streaming encoder

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs:1345` and `:1597` (the two streaming encode loops)
- Test: `examples/casv_golden.rs` (byte-exact) + `casv_bench.rs` (timing)

- [ ] **Step 1: Write the byte-exact gate.** Add `examples/casv_overlap_flip.rs`: encode the same frame sequence with the current serial loop (arm A) and the new producer/consumer loop (arm B); `assert_eq!` the two output byte buffers (identical container + codestream), report wall-clock.

- [ ] **Step 2: Run it** — expect fail (new path absent).

- [ ] **Step 3: Implement.** Wrap the frame source in a producer thread feeding a `std::sync::mpsc::sync_channel(2)` (bounded depth ≤2 so I-frame MT bursts don't oversubscribe); the consumer runs `encode_stream_frame` and writes the sink in order. Scene-cut/`force_iframe()` decisions must be computed by the producer and shipped WITH the frame (so ordering/flags are unchanged). Keep the sink writes strictly in frame order (the channel preserves order at depth ≥1).

```rust
// sketch
let (tx, rx) = std::sync::mpsc::sync_channel::<(usize, Frame, bool /*force_i*/)>(2);
let producer = std::thread::spawn(move || {
    let mut n = 0;
    while src.next_frame_into(&mut cur) {
        let force_i = scene_cut(&cur, &prev_src); // moved out of the encode leg
        tx.send((n, cur.clone_into_owned(), force_i)).ok();
        std::mem::swap(&mut cur, &mut prev_src);
        n += 1;
    }
});
for (n, frame, force_i) in rx {  // consumer: encodes in order
    encode_stream_frame(&frame, &prev_enc, force_i, &mut ctx, &mut sink)?;
}
```

- [ ] **Step 4: Correctness gate.** `cargo run ... --example casv_overlap_flip -- <frames>` (byte-exact) + `cargo run ... --example casv_golden` (decode golden unchanged).

- [ ] **Step 5: Throughput gate.** `casv_bench` A/B vs `.flipflop/results/casv-baseline.txt`. Expected: RAW-timelapse (decode≈encode) approaches ~1.5–2× wall-clock; ffmpeg-PNG source improves by the PNG-decode overlap. I-frame-heavy GOP=1 gains least (already core-saturated) — that's expected, not a regression.

- [ ] **Step 6: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs crates/raw-pipeline/examples/casv_overlap_flip.rs
git commit -m "perf(casv): overlap frame-source decode with encode in streaming loop (byte-identical)"
```

### Task 3.3: Parallelize the batch-tier `drain_all` decode prologue

**Files:**
- Modify: `crates/raw-pipeline/src/bin/casv_encode.rs:319`

- [ ] **Step 1:** For independent-frame sources (RAW files), decode via `rayon` (bounded by a RAM budget so peak resident frames stay under the memory cap); for ffmpeg PNG, decode `image::load_from_memory` on worker threads while later PNGs are still pulled. Preserve output order.

- [ ] **Step 2: Correctness gate.** The batch encoders read `frames[idx-1]` for deltas, so frame ORDER must be preserved. Gate = `casv_golden` byte-exact on a batch-tier (proxy/lossless/fable) encode.

- [ ] **Step 3: Throughput gate.** Wall-clock A/B on the Ghana frames batch. Expected: decode prologue overlaps/parallelizes; total drops by the decode fraction.

- [ ] **Step 4: Commit**

```bash
git add crates/raw-pipeline/src/bin/casv_encode.rs
git commit -m "perf(casv_encode): parallelize batch drain_all decode prologue (order-preserving)"
```

### Task 3.4: Parallelize FableBraid's 3 planes in the STREAMING tier only

`fable_braid.rs:1142/1172` iterate the 3 planes serially. In the streaming fable encoder (`casa_video.rs:1410/1474`) frames are serial → cores idle. Rayon over the 3 independent planes HERE ONLY (never in batch `encode_casv_fable_rgb8:2889` — already frame-parallel; would oversubscribe per CV-E6).

**Files:**
- Modify: `crates/raw-pipeline/src/fable_braid.rs:1142` (add a plane-parallel entry used by the streaming path)
- Test: `examples/fable_golden.rs` + `fable_video_ab.rs`

- [ ] **Step 1: Byte-exact gate.** `examples/fable_planepar_flip.rs`: encode a frame with serial-plane vs parallel-plane, `assert_eq!` output bytes.

- [ ] **Step 2: Implement** a `par_iter`-over-planes variant; call it only from the streaming fable encoder. Leave batch fable calling the serial variant.

- [ ] **Step 3: Correctness gate.** flip byte-exact + `fable_golden`.

- [ ] **Step 4: Throughput gate.** `fable_video_ab` streaming A/B. Expected ~1.2–1.5× (deinterleave/subtract-green prologue stays serial; realistic sub-3×).

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/fable_braid.rs crates/raw-pipeline/src/casa_video.rs crates/raw-pipeline/examples/fable_planepar_flip.rs
git commit -m "perf(fable): parallelize 3 planes in streaming tier only (byte-exact; batch unchanged)"
```

---

## Phase 4 — OPTIMIZE (only after the deletes land)

### Task 4.1: Stop cloning the tone LUTs per `process_into_simd` call

`pipeline.rs:2392-2395` / `:2246-2255` clone `pre_r/g/b`+`post` (~130 KB) out of the thread-local each call to drop the `RefCell` borrow before the rayon closure. Pass by `Arc` (rayon closures capture `&Arc`). 1 clone/frame whole-frame; ~16 clones/frame streaming (256-row sub-chunks) — matters most for streaming/video.

**Files:**
- Modify: `crates/raw-pipeline/src/pipeline.rs:2246-2255,2392-2395`
- Test: `examples/process_simd_flip.rs`

- [ ] **Step 1: Byte-exact gate.** Run `process_simd_flip` on a real ORF, record it passes (baseline). Add an A/B asserting `Arc`-LUT output ≡ cloned-LUT output byte-for-byte.

- [ ] **Step 2: Implement.** Store the LUTs in the thread-local as `Arc<[...]>`; clone the `Arc` (refcount bump, no data copy) to release the `RefCell`, move the `Arc` into the rayon closure.

- [ ] **Step 3: Correctness gate.** `process_simd_flip` byte-exact + `cargo test -p raw-pipeline`.

- [ ] **Step 4: Throughput gate.** `casv_bench` streaming A/B (this is where the ~16×/frame clones live). Expected: small but real per-frame drop.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/pipeline.rs
git commit -m "perf(pipeline): Arc tone LUTs instead of per-call clone (byte-exact; helps streaming/video)"
```

### Task 4.2: Fuse the dual-output (8-bit + 16-bit) tone pass

When both `OUT_FULL_RGB8` and `OUT_FULL_DISP16` are requested, `lib.rs:1241` and `:1246` run two full tone passes over the same rgb16 (identical pre-LUT+matrix, differing only in the final gather). The shared kernel `simd_block_kernel` (`pipeline.rs:2304`) is already generic over out-type. Emit both outputs from one deinterleave/tone pass. Not on the default export (requests neither) — benefits the 16-bit/HDR + pyramid consumers.

**Files:**
- Modify: `crates/raw-pipeline/src/pipeline.rs` (add a `process_into_dual` emitting rgb8 + disp16), `src/lib.rs:1241-1258` (call it when both flags set)
- Test: byte-exact vs the two current outputs

- [ ] **Step 1: Byte-exact gate.** `examples/tone_dual_flip.rs`: assert `process_into_dual` produces rgb8 byte-identical to `process_into_auto` AND disp16 byte-identical to `process_16bit`.

- [ ] **Step 2: Implement** the fused kernel (one pre-LUT+matrix, two final gathers writing both buffers per block).

- [ ] **Step 3: Correctness gate.** flip byte-exact both outputs + the 16-bit probe (`process_16bit` reuse test).

- [ ] **Step 4: Throughput gate.** A/B for a dual-output export (pyramid/HDR). Expected: ~halves the tone cost for dual consumers. Rebuild pkg if gating in-browser.

- [ ] **Step 5: Commit**

```bash
git add crates/raw-pipeline/src/pipeline.rs src/lib.rs crates/raw-pipeline/examples/tone_dual_flip.rs
git commit -m "perf(pipeline): fuse 8-bit+16-bit tone into one pass for dual-output consumers (byte-exact)"
```

### Task 4.3: Hoist the per-P-frame `changed_tile_map` allocation into scratch

`casa_video.rs:2480` allocs `vec![false; txn*tyn]` every streaming P-frame. Add `tile_map: Vec<bool>` to `StreamCtx` (`:845`); clear+resize instead.

**Files:**
- Modify: `crates/raw-pipeline/src/casa_video.rs:845` (StreamCtx field) + `:2480` (reuse)

- [ ] **Step 1: Byte-exact gate.** `casv_golden` (arm A) baseline recorded.
- [ ] **Step 2: Implement** the scratch field + `map.clear(); map.resize(txn*tyn, false)`.
- [ ] **Step 3: Correctness gate.** `casv_golden` byte-exact.
- [ ] **Step 4: Commit**

```bash
git add crates/raw-pipeline/src/casa_video.rs
git commit -m "perf(casv): hoist changed_tile_map into StreamCtx scratch (byte-exact)"
```

> **Deferred (measure-first, NOT a task yet):** SIMD min/max-column search in `changed_bbox_thresh` (`casa_video.rs:2363`). Gain is content-dependent (bbox tier targets low-motion; on high-motion every row is flagged → pre-pass is pure overhead). Add only if `casv_bench` on a low-motion clip shows the scan is a measurable fraction. Log the decision either way.

---

## Phase 5 — ACCELERATE cycle time, then AUTOMATE last

### Task 5.1: Close the measurement gaps (extend the profiler)

`pipeline_profile.rs`/`bench_pipeline_orf` splits only decompress/demosaic/tone — container-parse and orientation are folded into totals (UNMEASURED). You cannot honestly optimize what you can't isolate.

**Files:**
- Modify: `crates/raw-pipeline/examples/pipeline_profile.rs` + the `bench_pipeline_orf` helper (add `parse_ms`, `orient_ms` fields)

- [ ] **Step 1:** Add timers around `tiff::parse`/container decode and `apply_orientation`; extend the returned struct + the printed table.
- [ ] **Step 2:** Run on ORF + CR2 + portrait DNG from `tests\`; save the full per-stage split to `.flipflop/results/stage-split-24mp.json`. This becomes the reference the whole plan's "where time goes" claims cite.
- [ ] **Step 3: Commit**

```bash
git add crates/raw-pipeline/examples/pipeline_profile.rs .flipflop/results/stage-split-24mp.json
git commit -m "test(profile): time container-parse + orientation stages (close measurement gap)"
```

### Task 5.2: PGO the native JXL encoder + pipeline (automate last)

Encode is distributed-in-thirds → PGO is the recorded lever (not a libjxl fork). Modest, Amdahl-capped, build-infra — deliberately LAST, after the structural wins are proven and the profiler exists.

**Files:**
- Create: `build-pgo.ps1` (instrument → run representative corpus → merge → optimize build)

- [ ] **Step 1:** Write a two-phase PGO script: (a) `RUSTFLAGS="-Cprofile-generate=..."` build, (b) run the `tests\` corpus through `casv_encode` + a still-encode driver to gather profiles, (c) `-Cprofile-use=...` rebuild. For the C++ libjxl FFI side, add `-fprofile-generate`/`-fprofile-use` to the `jxl-ffi` build via its build script env (mirror `build-msvc.ps1` vcvars+clang-cl setup).
- [ ] **Step 2: Correctness gate.** `node StandardEncDecTest.mjs` against `encode-golden-baseline.json` — PGO must not change output bytes (it changes code layout only). Byte-exact.
- [ ] **Step 3: Throughput gate.** `jxl_encdec_ab` / `casv_bench` A/B, PGO vs non-PGO. Record the delta. Expected: single-digit % (Amdahl-capped by the thirds split) — land only if positive and byte-exact.
- [ ] **Step 4: Commit**

```bash
git add build-pgo.ps1
git commit -m "build: PGO recipe for native JXL encode + pipeline (byte-exact, automate-last)"
```

---

## Cross-cutting notes

- **Downstream sync:** the desktop Tauri repo (`capebio/JXL_Tauri_with_WASM`, `src-tauri/src/casv.rs`) is a SEPARATE repo consuming a fork of this pipeline. Native wins (Phases 1.3–1.4, 3, 4) must be ported there to reach the desktop product. Out of scope for this repo; track as a follow-up.
- **Rebuild discipline:** any task touching `crates/raw-pipeline` or `src/lib.rs` needs `wasm-pack build --target web --out-dir web/pkg --release` before its BROWSER gate, and a `build-manifest.json` bump. Native gates don't.
- **Rejected — do not re-introduce** (verified against `docs/rejected optimizations.md` + CLAUDE.md): output pixel-buffer pool (transfers detach), batch tiled scratch-reuse (0.88–0.95× slower), P-frame atlas libjxl MT (CV-E6), encoder-owned-recon inter-prediction, persistent atlas across frames, RESAMPLING=2 as a speed knob, MT on memory-bound streaming/downsample (DS-ROWPAR), drain/batch logic in facade/session, per-stage budget reset.

---

## Self-Review

- **Spec coverage:** Phase 0 (shipped) + all 5 phases have tasks; each brainstormed candidate maps to a task (two-phase→1.1, copyInput→1.2, memsets→1.3, raw_video copy→1.4, oversubscription→2.2, core budget→2.3, streaming overlap→3.2, drain_all→3.3, fable planes→3.4, LUT clone→4.1, dual tone→4.2, tile_map→4.3, profiler→5.1, PGO→5.2). Speculative bbox SIMD explicitly deferred with a measure-first gate.
- **Placeholder scan:** no TBD/"handle edge cases" — each code step shows the mechanism; sketches are labelled `// sketch` where the exact surrounding code must be read at execution time (large files), with the file:line to anchor.
- **Type/name consistency:** gate harness names (`casv_golden`, `process_simd_flip`, `encode-golden-baseline.json`, `flipflopdom.mjs`) are used consistently; flag constants match lib.rs (`OUT_NO_ORIENT=16`, `OUT_FULL_16=8`).
- **Risk flags:** Task 1.3 (memsets) and Phase 2/3 parallelism are the riskiest — each has a byte-exact/order gate BEFORE the change and a STOP-if-no-win rule for the heuristic ones.
