# Rejected Optimizations

This document records optimizations proposed during pipeline reviews that were formally analyzed and rejected, along with the technical and empirical rationale.

---

## ANS-R1..R3: ans_common.cc / .h ChatGPT pass (2026-06-30)

Ground-truthed an external (ChatGPT) optimization pass for `lib/jxl/ans_common.{cc,h,_test.cc}` against the real libjxl-012 source and both call sites (`enc_ans.cc:706`, `dec_ans.cc:274`).

**ANS-R1 — "single_symbol path hard-wired to `ANS_TAB_SIZE` instead of `range` is a bug." — FALSE (not a live bug).**
Claim: `InitAliasTable` lines 68/82 use `ANS_TAB_SIZE` where `range` is meant, breaking tables when `log_range != ANS_LOG_TAB_SIZE`.
Reality: **Both and only callers pass `ANS_LOG_TAB_SIZE` as `log_range`** (`enc_ans.cc:706`, `dec_ans.cc:274`). `ANS_LOG_TAB_SIZE` is a fixed `#define` = 12 (`ans_params.h:18`). Therefore `range == ANS_TAB_SIZE == 4096` on every real call. The proposed `range` substitution is behaviorally a no-op. Defensive-only; no behavior change, no perf. Same false-bug pattern as prior ChatGPT "P0 inverted AllFalse" and "LLF-mask bug" rejections.

**ANS-R2 — "parameters can exceed `Entry` field widths; add bounds JXL_ENSUREs." — Defensive-only, unreachable.**
`log_alpha_size` ≤ 8 (table_size ≤ 256 = `ANS_MAX_ALPHABET_SIZE`), so `right_value`/index fit uint8; `entry_size = 4096 >> log_alpha_size` ∈ [16,128] for the live range (log_alpha_size 5..8), so `cutoff` < entry_size < 256 fits uint8. No reachable truncation/overflow given validated inputs (`dec_ans.cc:251` already rejects oversize alphabets; counts are normalized to sum==range upstream). Extra guards change nothing for valid input; pure robustness, out of scope for a perf pass.

**ANS-R3 — "force branchless mask-select in `Lookup` (GCC emits a branch otherwise)." — ALREADY IN TRUNK + wrong compiler target.**
The shipped `Lookup` (`ans_common.h:108-141`) **already** implements the branchless form: single 64-bit `memcpy` load, `conditional = greater ? entry : 0` (CMOV/AND), XOR freq selection, with an explicit `// WARNING: moving this code may interfere with CMOV heuristics` comment. ChatGPT's `0 - (uint64_t)greater` mask is the same code clang already generates. Its GCC-vs-CMOV microbenchmark is moot: the browser ships **WASM via emscripten/clang**, not GCC. No change. (Same "headline already in trunk" pattern as conv5 y-ring.)

Also concur with ChatGPT's own self-rejections: typed `uint64_t*` load over `memcpy` (alias/alignment risk, no gain), 4096-entry direct decode table (blows per-context cache footprint; Entry is deliberately 8 bytes, ~64×256 working set), `Entry` layout expansion, narrowing `Symbol` fields.

**Surviving REAL (byte-exact, setup-cost only) items** — not rejected, tracked separately: (a) allocation-free construction (3 heap `std::vector` → 2 `std::array<uint8_t,256>` stacks + reuse `Entry::freq1_xor_freq0` as transient cutoff scratch); (b) trailing-zero trim without mutating/copying the by-value `distribution` (dec already `std::move`s it, so this only helps the enc caller's `Counts()` copy); (c) `CreateFlatHistogram` write `min(rem, len-rem)` entries. All are setup/table-build cost, NOT decoder-hot; `Lookup` stays byte-identical. Marginal for the app's RAW→JXL O1 workload (table build ≪ pixel work). See Questions_deferred.md.

---

## BW-R1: enc_bit_writer.cc `Write()` widen single-byte load to 64-bit `memcpy` — FALSE (bug) (2026-06-30)

**Target:** `BitWriter::Write` (`enc_bit_writer.cc:191`), little-endian branch.
**Proposed (external pass):** replace `uint64_t v = *p;` with `uint64_t v; memcpy(&v, p, sizeof(v));` "for a portable unaligned 64-bit load."
**Rejected — would corrupt the stream.** `*p` is a **single** `uint8_t` zero-extended into `v`; it is deliberately *not* a 64-bit load. The algorithm relies on the high 7 bytes of `v` being zero so that `v |= (bits << in_first)` followed by the 8-byte store **zero-initializes the bytes ahead** (the zero-tail invariant; see the in-code comment and `JXL_DASSERT(v >> bits_in_first_byte == 0)`). PaddedBytes only guarantees the *first* new byte is zero, not the next 7. Widening the load reads uninitialized/garbage trailing storage, the store no longer zeroes ahead, and the assertion fires (debug) / the stream is corrupted (release). `Write()` left byte-for-byte unchanged on branch `perf/enc-bit-writer-append-jun30-w8k4`. Same "plausible portability fix that is actually a correctness regression" class as prior ChatGPT false bugs (inverted AllFalse, LLF-mask).

*(The same external pass's genuinely-good items — bulk/56-bit `AppendUnaligned`, templated `WithMaxBits`, append-grow-to-endpoint, logical `ZeroPadToByte` — WERE implemented on that branch; only the `Write()` load-widening was rejected.)*

---

## CR2-R1: SIMD for crop compaction (2026-06-15)

**Target:** `cr2.rs` in-place crop loop (`copy_within` per row).  
**Proposed:** Vectorize the row-copy loop with SIMD (wasm128 / AVX2) for faster crop.  
**Rejected:** Crop is 1.0% of total CR2 decode time. LJPEG decode is 97%. Maximum achievable gain from a 10× speedup of the crop loop is 0.9% end-to-end. Thermal noise in benchmarks exceeds this by 50×. **Evidence:** benchmark run 2026-06-15, AvgCrop = 4.18 ms, AvgTotal = 398 ms.

## CR2-R2: Concurrency inside CR2 decode (2026-06-15)

**Target:** `cr2.rs` LJPEG decode stage.  
**Proposed:** Split the LJPEG strip into segments for parallel Huffman decode.  
**Rejected:** Canon CR2 LJPEG is a single-strip stream with a continuous Huffman state. There are no restart markers (`0xFFD0`–`0xFFD7`) in Canon CR2 to define independent restart intervals. Parallel Huffman decode requires known restart boundaries. Without them, any split point is arbitrary and the dependencies between predictor states cross boundaries.  
**Deferred:** A future pass could analyse whether Canon CR2 files consistently use restart intervals; if so, Rayon parallelism over intervals becomes feasible. Estimate: 3–4× on a 4-core machine, bringing FileA to ~90 ms.

## CR2-R3: Per-stage budget resets (2026-06-15)

**Target:** `cr2.rs` decode phases.  
**Proposed:** Add per-stage budget (timeout) to abort decode partway through.  
**Rejected:** CR2 has no partial-decode use case in the current stack. The JXL pipeline uses budgets because JXL has a native progressive structure (passes). LJPEG has no such structure; a partial decode yields no usable pixel data.

## CR2-R4: Pre-allocate IFD entry Vec with `Vec::with_capacity` (2026-06-15)

**Target:** Old `walk_ifd` → `Vec<(...)>`.  
**Proposed:** Pre-size the Vec to the IFD entry count to avoid realloc.  
**Not needed:** The IFD walker was replaced entirely with a zero-allocation visitor pattern (`visit_ifd`). There is no Vec to pre-size.

## D-5: JS-Side Speculative Chunk Coalescing

### Proposed Optimization
Coalesce multiple incoming small chunks using `Buffer.concat` before calling `decoder.push()` when the worker queue depth is high and the total size is under 1 MiB.

### Technical Rationale for Rejection
1. **Speculative Memory & GC Overhead:** Performing `Buffer.concat` in JS-land introduces an additional heap allocation and an explicit memory-copy pass. For smaller chunk frequencies, the garbage collection pressure and intermediate buffer allocations can easily outweigh the savings of reducing JS-to-native FFI boundary crossings.
2. **First-Paint Progression Latency:** Coalescing introduces speculative buffering delays, which directly conflicts with progressive JXL stream decoding goals. By delaying the execution of early chunks, we defer first-pixel metrics and progression events, which degrades progressive rendering performance on lossy or slow networks.
3. **No Empirical Benchmark Support:** In alignment with `CLAUDE.md` foundational directives, heuristic or adaptive performance changes cannot be integrated without rigorous, isolated benchmark evidence proving a clear, net-positive improvement on standard test corpora under realistic constraints.

---

## E-1: Cumulative Byte-Boundary Tracking using `sidecarSizes`

### Proposed Optimization
Track sidecar cumulative byte offsets in the node worker's `readEncoderChunks` loop by comparing cumulative bytes against `sidecarSizes` boundaries rather than assuming one chunk maps to one sidecar.

### Technical Rationale for Rejection
1. **Conceptual Type/Domain Mismatch:** The proposed fix incorrectly treats `this.opts.sidecarSizes` as an array of *byte sizes*. In our system architecture, `sidecarSizes` represents the *pixel dimensions* (long-edge max pixel size, e.g., `[256, 512, 1024, 2048]`) of the requested thumbnails, not their compressed byte sizes.
2. **Severe Data Corruption Hazard:** Comparing cumulative output bytes to pixel dimensions (e.g., checking if `totalBytes >= 256` or `512` bytes) would trigger false completions of sidecar offsets at extremely early stages of encoding. This would emit incorrect `sidecarOffsets` (e.g. 256 bytes instead of the actual compressed JXL size of several kilobytes), resulting in truncated/corrupted thumbnail image fetches when clients perform range-prefix requests.
3. **Architecture Guarantee:** In both our WASM and native bindings, the encoding engine is guaranteed to yield each sidecar thumbnail as a single, discrete, complete JXL container chunk before the main codestream. Thus, tracking the end-of-chunk boundaries of the first `sidecarSizes.length` chunks is the mathematically correct and byte-accurate representation of cumulative sidecar boundaries.

---

## RP-2026-06-12: Raw Pipeline Handback Rejections / Deferrals

### Proposed Optimization
`decompress.rs`: add per-row callback / ROI-downsample hook during Olympus raw decompression.

### Technical Rationale for Rejection
1. **Public API surface too early:** Current callers only need full-frame rows or row-prefix decode. A callback API would freeze semantics around row parity, ownership, and cancellation before there is a proven cross-stage preview contract.
2. **Pipeline boundary mismatch:** Useful ROI/downsample needs agreement across decompress, demosaic, and DNG metadata. Landing it in `decompress.rs` alone would create a one-off hook instead of a stable pipeline seam.

### Proposed Optimization
`demosaic.rs`: fuse matrix math into MHC hot kernels, add SIMD path, add planar / `_into` output APIs, expose saliency as stable public contract, and add half-res crop-policy metadata.

### Technical Rationale for Rejection
1. **Correctness bug fixed first:** This pass prioritized phase-correct MHC because that fixes real misrendering. Kernel fusion/SIMD/public output-shape expansion are performance and API changes without benchmark evidence in this session.
2. **API freeze risk:** Planar output, `_into` surfaces, and saliency contract would become long-lived public interfaces. They need explicit downstream consumers and naming decisions, not opportunistic introduction during a correctness pass.
3. **Half-res policy needs product choice:** `floor`, `ceil`, or explicit crop metadata changes caller-visible behavior. No product decision was provided, so silent policy change would be riskier than deferral.

### Proposed Optimization
`dng.rs` / `ljpeg.rs`: parsed `LjpegPlan`, shared decode plan across tiles, bounded tile queue / row-band sink, and structured `DngDecodePlan` provenance object.

### Technical Rationale for Rejection
1. **Larger architectural refactor:** These changes cross multiple files and would rework tile decode ownership, cache lifetime, and DNG staging together. They are valid directions, but materially larger than the verified correctness fixes completed here.
2. **Needs dedicated measurement pass:** The existing implementation now has safer truncation handling, strip support, endian correctness, phase-correct demosaic fallback, and scratch reuse. Further decode-plan work should be benchmarked against this new baseline.
3. **Provenance object incomplete without callers:** `DngDecodePlan { wb_source, matrix_source, crop }` is useful only if surfaced through native/WASM boundary types and consumed by product code. That integration was not in scope here.

### Proposed Optimization
`exif.rs`: add broad provenance/capture geometry fields (`wb_source`, `crop_origin`, pose-ish tags, serials) and string-pooling optimizations.

### Technical Rationale for Rejection
1. **Upstream data not consistently available:** `OrfInfo` does not currently provide enough trustworthy source data for all of those fields.
2. **No hot-path evidence:** String pooling / `Cow<'a, str>` would complicate serde-facing types without evidence that EXIF serialization is a real bottleneck.

### Proposed Optimization
`ljpeg.rs`: replace current thread-local DHT cache, add planar decode API, and add restart-marker future hook now.

### Technical Rationale for Rejection
1. **Current cache no longer critical path:** This pass did not introduce parsed plans, so replacing the cache alone would be isolated churn with unclear gain.
2. **Planar decode API premature:** No current caller requires a separate planar LJPEG layout after the completed fixes.
3. **Restart markers remain corpus-driven:** Existing assets do not require restart-marker support. Carrying speculative parser complexity now would not improve current pipeline behavior.

---

## 2026-06 RawPipeline Lenses Review (DecompressDemosaicDngExifLjpeg)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### Rejected from decompress.rs
- Expose/document a "linearize" / black subtract post step in decompress (or pre in its callers).
  Rationale: Black subtract is intentionally post-demosaic in pipeline::build_pre_lut (applied to demosaiced rgb16, with highlight shoulder and per-channel WB/gain). Pre-sub on bayer in decompress would require coordinated changes to all ORF paths (wasm src/lib.rs, crate compile tests) to pass black=0, else double-sub dark output. The ingest deliberately hands off "as captured" + metadata for consistency with DNG bayer path. Better as opt-in utility in demosaic (implemented) for advanced consumers. No behavior change here.

- Any fill/alloc micro-opts (D3 one-fill, D6 skip zeroinit via MaybeUninit).
  Rationale: Already explicitly rejected in the file's own tests (D3/D6 benches showed <1-3% or negative, plus WASM/unsafe/audit risk per project policy in CLAUDE.md). Current batch-fill + vec![0] is sound and sufficient.

### Rejected from ljpeg.rs
- Specialize inner decode loop for cps==1 (CFA DNG common case) to elide comp loop/arrays.
  Rationale: Marginal win (1-iteration loop, tiny fixed MAX=4 arrays; LLVM already specializes well). Would require near-dupe of the predictor/left/prev_row_first/ store logic for general cps<=4 support. Current hot path (peek/table/get_bits/extend) dominates; no benchmark evidence this is worth the maintenance surface. Rejected per "no speculative without evidence" and simplicity.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

---

## F-1: Remove SSIMULACRA2 placeholder field from progressive byte benchmark

### Proposed Optimization
Remove the SSIMULACRA2 input/output surface from `web/jxl-progressive-byte-benchmark.js` until a real metric runner exists, or compute an asynchronous sidecar quality score immediately after every target encode.

### Technical Rationale for Rejection
1. **Capability Signaling Matters:** The current UI already labels the metric as unavailable. Keeping the field preserves forward compatibility with the preset benchmark and export schema without falsely claiming a measured result.
2. **No In-Loop Metric Runner Exists:** Computing a real score here would require introducing a new quality pipeline into a benchmark whose primary purpose is byte/timeline instrumentation. That would mix orthogonal concerns and inflate runtime variance.
3. **Better Future Landing Point:** When a metric runner is added, it should be shared across benchmark surfaces and gated to finalist/post-pass analysis, not bolted onto this page alone.

---

## F-2: Move entire preset sweep engine into a Worker immediately

### Proposed Optimization
Move `web/jxl-preset-benchmark.js` sweep execution, resize, encode, decode, IDB restore, and RAW isolation wholesale into a Worker so timings are isolated from UI interference.

### Technical Rationale for Rejection
1. **Large Architectural Surface Area:** The current module mixes DOM wiring, IDB restoration, canvas resizing, WASM calls, and chart updates. A correct Worker migration is not a local optimization; it is a subsystem split with non-trivial message protocol design.
2. **Browser Primitive Gaps:** Several code paths rely on main-thread-only or environment-sensitive primitives (`createImageBitmap`, `OffscreenCanvas`, file picker flows, chart refresh cadence, debug console integration). A rushed move would risk silent feature regressions.
3. **Need Measured Baseline First:** Before paying migration cost, we need profiler evidence that main-thread interference is dominating current benchmark noise. The changes landed in this pass already remove avoidable cache misses and stale-result errors with much lower risk.

---

## P-1: Perceptual color model (non-Riemannian / HPCS / Molchanov) field in producedBySchema + makeProducedBy (pyramid-ingest schema.ts / manifest.ts)

### Proposed Optimization
Extend producedBy.encoder with optional `perceptual: { model: string, version: string }` (additive to the zod object) and emit it from makeProducedBy so manifests can record the advanced color science engine version. Intended to prep for the upcoming Schrödinger-geodesic / Los Alamos diminishing-returns / Molchanov tensor flat-space LookRenderer.

### Technical Rationale for Rejection (in context of the JPegXL pipeline)
1. **Wrong layer / creation vs. paint time:** The JPegXL pipeline (jxl-stream/session/scheduler/worker/decode-handler/facade/bridge.cpp + progressive single-pass checkpoints) consumes the pyramids *produced* by this ingest cluster. The described engine (sensor-sharpen B + log transform for flat Euclidean, Molchanov parallelogram residuals + A_tensor, hybrid Riemannian spring + Los Alamos f(c) curves) is explicitly specified to live in `LookRenderer` under the *hot per-pixel apply_tone_math loop* in raw-pipeline for *runtime* illumination-invariant adjustments "during progressive JXL paints" in the lightbox. It is a decode/paint-time concern, not an ingest-time encoder configuration.

2. **producedBy mis-semantics:** producedBy (and its encoder.effort/quality.grid/big/proxy) describes *how the JXL asset bytes were created* at pyramid build time (the ladder + jxl encode settings). Recording a runtime perceptual model here would be factually incorrect for current (and intended) neutral ingest path (ZERO_LOOK for raw, direct transcode for jpg). Current design correctly keeps the base pyramids look-neutral so that the flat-space engine can do correct math at view time without double-applying.

3. **Speculative / premature per project rules:** The lens states "we intend to implement", "for the upcoming phase", "design a highly optimized SIMD or LUT". No implementation exists yet in the Rust/WASM LookRenderer. Adding schema surface, producedBy emission, and (to be useful) wiring through buildManifest now is exactly the class of "speculative abstraction" and "no opportunistic refactors" that the CLAUDE.md / AGENTS.md / rejected-optimizations history repeatedly reject. Surface would need to be maintained forever even if the integration story changes (e.g. the model lives only in JXL metadata or a separate render-intent sidecar).

4. **Additive but still cost:** Although the discriminated manifest schema tolerates extra keys and the field can be omitted today, updating the authoritative producedBySchema + parse paths + makeProducedBy still expands the contract that every manifest reader (rebuild, gc, index, CLI, potentially external tools) must understand. The flexible `metadata?: Record<unknown>` already on Manifest is the correct escape hatch for any per-image render notes until the engine lands and a deliberate ingest-vs-runtime decision is made.

5. **Cross-file and future integration risk:** Realizing the proposal would also require edits in manifest.ts (buildManifest/makeProducedBy call) and potentially callers in ingest.ts. Even within the 5-file rule the change is not self-contained and anticipates an architecture that has not been reviewed against the progressive decode invariants, budget, or LookRenderer hot loop.

Decision: rejected. Do not extend producedBy or the encoder schema for this. When the Rust engine lands and the exact versioning + whether any ingest-time recording/baking is desired is decided, a fresh proposal with benchmarks and layer analysis can be made.

---

## G5-S1: Rename createProgressiveSession / add progressiveContext / full abort+error surface (web/jxl-progressive-session.js)

### Proposed Optimization
Rename the session factory (name implies progressive but is generic backend/source cache). Add setProgressiveOptions / progressiveContext passthrough, abort support on loadSource, onError hook, make ensureSource resolve to {error?} record instead of reject, and carry AR/ perceptual hints.

### Technical Rationale for Rejection (in context of the pipeline)
1. **Cosmetic rename + opportunistic churn:** Current name is accurate for its actual role (a thin source+backend holder used by jxl-progressive.js bench variants and thumb encoding). Gallery path uses direct file load + decoder, not this session. Renaming touches creation sites, 3+ test files, docs, and provides zero efficiency/speed/perf/bugfix. Violates "surgical changes; match existing style; no opportunistic refactors".
2. **Abort / error surface changes contract for callers:** loadSource is supplied by the page (loadRandomSource etc). Adding abort token or forcing {error} record would require edits in jxl-progressive.js + all tests + any future loadSource providers. No observed bug report or race repro in current ensure/reload usage (single session for bench). Per CLAUDE: "no speculative abstractions", "weak verification" if added without failing case.
3. **Per-file / AR context / perceptual passthrough premature:** This session is not per-file (gallery has N files, one shared for encode policy in bench). The advanced color (Lens17) + AR/LLM surfaces belong on the *display* side (lightbox + pack + draw in gallery) or in Rust LookRenderer, not a source loader for bench encoding. Adding here would be wrong layer. Future when the Rust engine and lightbox usage exist, a deliberate extension can be proposed with the actual call sites.
4. **Policy integration was the only +ve delta:** We implemented the narrow, high-cohesion piece (optional policy + chooseEncodeBackend used by the single caller in progressive.js). The rest were rejected as scope creep without evidence.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

---

## G5-C1: Full hole-safe next/prev rewrite + onVisibleChange + manifest/tile descriptors + error/partial tracking (web/jxl-progressive-gallery-coordinator.js)

### Proposed Optimization
Rewrite next/prev to skip holes using maxIndex tracking; accept onVisibleChange callback; add manifest/tile support; track error/partial frames in series entries; unify with lightbox framesByFile.

### Technical Rationale for Rejection (in context of the pipeline)
1. **next/prev not on hot path + tests assume sequential:** Gallery uses coordinator only for visibleFrames (synced min-count for thumbs) + register/markClosed. next/prev only exercised in its own unit test with sequential 0/1/2 registration (frameIndex++ in push). visibleFrames already does .filter(Boolean). Changing % logic risks test deltas and adds complexity for a non-used API in the actual gallery pipeline (lightbox does its own wrap math on framesByFile arrays).
2. **onVisibleChange / manifest / tile / error state:** No current consumer (reRenderAll is explicit in gallery.js). Adding would be speculative API. Tile descriptors / manifests are mentioned in charter but belong with decode events or jxl-session layer, not this post-arrival sync counter. Error/partial already surfaced via the decoder 'error' / 'final' paths and logged in gallery; duplicating into coordinator violates "session protocol knowledge must not leak".
3. **Duplication with lightbox:** framesByFile is intentionally the *full history* (for lightbox full nav), coordinator is the *synced visible count* view. They serve different consumers (thumbs vs modal). Unifying would be larger refactor, not surgical, and not required for the visible sync correctness.
4. **Cache + priorityTargets delivered the value:** We added the alloc reduction (dirty cache on register/close) and getPriorityTargets() + accessors. These are the efficiency + "manage priority" surfaces without overbuilding.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

---

## G5-F1: Always forceCopy in pack + broad format/16-bit/float/YUV support now (web/jxl-progressive-gallery-frame.js)

### Proposed Optimization
Default to forceCopy for safety on 0-copy view path (detached buffer hazard); expand pack immediately to support rgb8/16/float/YUV output formats for ML/CV; add tests.

### Technical Rationale for Rejection (in context of the pipeline)
1. **0-copy view is the documented win (Lens 20 "pointer move"):** The fast path (when stride matches) reuses the buffer view exactly to avoid 60 MiB+ copies on high-res progressive frames. Forcing copy by default would regress perf for the common tight case and for gallery thumbs. We added *optional* forceCopy (and used the view path in wired draw) — the correct balance.
2. **Format expansion speculative:** Current decoder events + gallery enriched frames are rgba8 (or with stride). No ML/CV consumer, no 16-bit path active in this gallery (see perceptual-color.mjs for other). Adding branches now bloats the hot row loop without callers or benchmarks. pack test only exercises rgba8 stride. Per rules: "adaptive/heuristic... require benchmark data. Do not add tunables without evidence."
3. **Wiring + ROI + constancy stub landed instead:** We integrated pack into drawFrameToCanvas (fixing latent stride bug in gallery thumbs + lightbox paints, deduping manual view code) and added the options bag + roi + constancy hook. That delivers immediate pipeline correctness + future surface with zero risk.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

---

## G5-L1: Zoom/pan state machine + full cancel/boost emission + reactivity on framesByFile (web/jxl-progressive-gallery-lightbox.js)

### Proposed Optimization
Add zoom/pan fields + listeners; on open/handle emit cancel/deeper requests or priority to scheduler; make framesByFile reactive so lightbox auto-updates when new frames pushed.

### Technical Rationale for Rejection (in context of the pipeline)
1. **This gallery/lightbox has no zoom/pan:** Current UI is thumb strips + modal full-frame lightbox with arrow/ctrl-arrow nav only. No canvas pan/scale, no wheel zoom. Adding state/listeners would be dead code + DOM assumptions. The "priority shifts when zooming/panning" in the Group 5 charter is aspirational; actual priority lives in packages/jxl-scheduler (preemption/dedup). Emitting from here would be cross-layer violation without a defined protocol.
2. **Cancel/boost belongs at scheduler/worker boundary:** Per CLAUDE invariants: "Preemption is scheduler-only", "Backpressure lives at the scheduler/worker boundary". Lightbox open/nav already drives which frames are "attended" (we added getAttended + focusRegion + constancy). Gallery starts all decodes concurrently via the push; there is no "deeper frame request" API exposed from the decoder in use here. Adding would require touching jxl-progressive-decode + decoder, outside the allowed cohesion for this item.
3. **Reactivity unnecessary:** framesByFile is mutated by the event loop in gallery (push then register + reRender). Lightbox queries on key / open. The max visited fix + perFile map delivers the progressive guarantee. Observers or proxies would add GC/alloc without measured win.
4. **Core delivered:** The wrap-bug fix (real correctness), constancy/attended/focus surfaces (for Lens 17/12/16), and the return value are in. When a zoom/pan lightbox or priority-aware decode path exists, the attended hook is the attachment point.

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

## Group 2 (jxl-session tiered contexts) rejections from 2026-06-13 plan implementation pass

### G2-F3: Abortable / wakeable grace window for visible MT/ST fallback (BrowserContextTierEvent.md Agent 1/3 + finding 3)

**Proposed Optimization**  
Make the visible grace sleep in createTieredSchedulerRouter abortable (tie to session AbortSignal) and/or wake early on pool metric / budget release so visible work does not pay full 16ms when capacity frees during the wait. Pass shutdown signal too.

**Technical Rationale for Rejection (in context of the pipeline)**  
1. The grace is intentionally tiny (16ms default). Benefit is marginal compared to full decode budgets (seconds) and the cost of visible work starving.  
2. Making the router.pick() promise respect abort requires non-local changes: modify createTieredSchedulerRouter signature or context to accept signal, make the injected sleep cancellable (AbortController race), update TieredJxlContextImpl, and ensure Decode/EncodeSessionImpl ctor + acquirePromise chain correctly short-circuits before scheduler assignment. This risks new races in the admission/acquire path (see scheduler abortAcquisition, cancelledDuringAcquisition sets).  
3. Current abort handling in decode-session is deliberately pre-acquire for already-aborted (DS-3) and post for handler. Injecting into the pick grace adds complexity across session/context-base layers without touching the core preemption/budget invariants.  
4. Reassessed as low-ROI vs risk; 16ms pay is acceptable for the contention fallback feature. If grace is ever raised significantly, revisit. Touches more than Group 2 files for full cohesion.

### G2-F4: Runtime enforcement + bounded buffer for AsyncEventStream single-consumer (finding 4, Layer 3)

**Proposed Optimization**  
Add active iterator guard (throw on second [Symbol.asyncIterator] while one live) and/or max buffer size with drop-oldest or error on overflow for frames/metrics.

**Technical Rationale for Rejection (in context of the pipeline)**  
1. Contract is already explicit and strong in comments (single-consumer, return() clears). Existing guards (returned flag, clear on return, single waiter slot) + compaction hygiene are in place and tested.  
2. Runtime second-iterator detection is fragile in async (return() timing, multiple microtask iterators). Adding would be new public error mode for misuse.  
3. Bounding buffer or drop policy is adjacent to previously rejected ideas around pixel buffer pools, compactQueue thresholds <64, and pre-alloc (see R1-2, DH-4, R12-5 in CLAUDE.md and this file). Buffer growth is consumer-driven (UI must drain or cancel); the layer is not the right place for global memory pressure.  
4. Reassessed: document + contract is sufficient. Changes would be non-surgical and risk perf/compat for legitimate single-consumer progressive use.

### G2-F5: Centralized capability probe + readiness surface (finding 5, Layer 2)

**Proposed Optimization**  
Move probe out of CapabilityAwareContext per-instance fire-and-forget into shared/cache, expose JxlContext.ready() or probeSettled or capabilities promise so callers (and the tier router) can wait for real SIMD/threads/SAB data before first decode.

**Technical Rationale for Rejection (in context of the pipeline)**  
1. Explicit design decision D-002: capabilities() is sync per spec/contract; async probe is side-effect update. Conservative default is the floor.  
2. Adding readiness would be additive public API on JxlContext (affects all callers, browser + node), require coordination with @casabio/jxl-capabilities, and change when MT decision in Tiered can prefer real caps vs default.  
3. Current probe is cheap (one-time dynamic import) and "good enough" for the use (caps used for telemetry/diagnostics more than hard routing). Race is documented.  
4. Reassessed: not a bug fix, would be feature/API change. Not surgical.

### G2-F6: Smarter (hysteresis/age/saliency) MT routing policy (finding 6, Layer 2)

**Proposed Optimization**  
Extend shouldUseMtImmediately + router.pick with hysteresis, queued age, work-class hints from DecodeOptions, or saliency to avoid thrashing between MT/ST under varying load.

**Technical Rationale for Rejection (in context of the pipeline)**  
1. The policy is intentionally minimal and delegates real contention to CoreBudget + scheduler pool metrics / preemption (which already do sophisticated victim selection).  
2. Adding state (hysteresis counters) or work-class would either live in context-base (dupe across schedulers) or require new fields on ContextOptions/DecodeOptions flowing to router — cross-layer and changes contract.  
3. "Too binary" was noted as future in the original design doc; any heuristic requires benchmark data per CLAUDE rules ("Do not add tunables without evidence").  
4. Reassessed: belongs in scheduler or at T-INT caller level once saliency/priority signals are richer. Not positive surgical edit here.

(Grace, stream, probe, and policy rejections recorded after reassessment against full pipeline position and CLAUDE invariants. The two contract items (URL + node) were the only ones passing the "positive change" bar for immediate surgical application.)

---

## 2026-06-15T01:35Z — facade.ts / decode-handler.ts (multi-lens review)

**REJECTED: Wire partial-frame-on-error from facade `events()` to decode-handler.**
decode-handler already reads `event.partialPixels`/`partialInfo`/`partialPixelStride`/`partialStage`
on the `error` arm, but facade emits only `{code,message}`, so a truncated progressive decode
discards all already-flushed passes. Wiring it was rejected:
1. Safe capture of the last good pass requires a per-pass full-frame **copy** on the hot progressive
   path (the emitted frame is transferred/detached by the consumer, so it cannot be re-read at error
   time) — this regresses the deliberate zero-extra-copy design.
2. The alternative, calling `dec_take_flushed` at error time, runs against a libjxl decoder already
   in an error state: post-error flush output is undefined and may be corrupt — fails the
   output-fidelity gate (lens 24). Cannot prove the salvaged pixels are valid.
   Verdict: genuine latent feature, but blocked on a bridge-level `dec_take_partial` that guarantees
   a clean last-rendered frame. Documented as a recommendation in `docs/FacadeDecodeHandler - DONE.md`,
   not shipped.

**REJECTED: Defensive-copy the `takeBufferView` subarray (encode chunk drain) to remove the
"valid same-tick only" footgun.** By design (documented at the function). Adding a copy regresses
the encode drain that the zero-copy view exists to optimise; the sole consumer (encode-handler)
already uses it synchronously before the next bridge call. No change.

**ACCEPTED (for the record, applied this pass):** detectTier crossOriginIsolated gate; module-promise
poison clear-on-reject; eventsOneShot OOM guard; ptr1 leak fix in computeButteraugli/Psnr/Ssim;
floatFromI32Bits shared scratch.

---

## 2026-06-15T02:35Z — facade.ts / bridge.cpp (final-optimization multi-lens review)

**REJECTED: Box-filter decode-time downsampling (replace nearest-neighbour in DownsampleRgba +
applyRegionAndDownsample).** A genuine *quality* improvement (less aliasing on shrunk field images,
relevant to the biodiversity platform), but it changes pixel output and trades decode speed. Per the
output-fidelity lens it must be gated on golden-image/SSIM diffs AND the user's own viewer (see
feedback: RGB-mean parity != user's viewer). Not a silent in-pass edit. Documented as a
fidelity-gated recommendation in docs/FacadeBridge - DONE.md.

**REJECTED: Fixed-point (8.8) rewrite of bilinearResize rgba16/rgbaf32 branches.** The rgba8 branch
uses 8.8 fixed-point; extending it to 16-bit/float would change rounding and thus pixel values for
high-bit-depth output — fidelity risk on exactly the high-bit-depth path the platform cares about,
for a marginal ALU saving. The float path is correct; left unchanged. (rgba8 got only a pure,
output-identical weight hoist — F-1.)

**REJECTED: Per-call alloc of x-weight array in bilinearResize as a cross-frame cache.** Considered
storing the hoisted xtIs[] on the ResizePlan for reuse across frames. Rejected: ResizePlan already
caches the resize axes; adding a third parallel array widens the plan contract for a sub-percent
gain and risks staleness if dstW changes. The per-call Int32Array(dstW) is cheap relative to the
dstW×dstH truncations it removes.

**ACCEPTED (applied this pass):** B-1 Butteraugli sRGB→linear 256-entry LUT (bit-identical, ~9.3×
on the gamma-decode stage; flip-flop benchmark/butteraugli-gamma-lut.mjs, 0/6.22M mismatches);
B-2 planar RGB16 direct u16 stores; F-1 bilinearResize rgba8 column-weight hoist.

---

## 2026-06-15T02:54Z — encodeRgb16Planar / jxl_wasm_encode_rgb16_planar (planar seam)

**DEFERRED (recommend, not done): fmt==4 "rgb16 passthrough" in EncodeRgba.** The planar encode
now interleaves a 4-channel RGBA16 buffer (opaque alpha) so EncodeRgba(fmt=1, has_alpha=0)'s
StripAlphaToRgb reads the correct 4-channel stride. The zero-extra-copy ideal would be a 3-channel
RGB16 buffer fed through a no-strip passthrough (like the existing fmt==3 rgb8 path but 16-bit).
NOT done now: it edits the shared central encoder's channel math (FormatToDataType / FormatToBits /
bytes_per_channel ternaries repeated across EncodeRgbaWithMetadata, incl. the initial_size calc) and
there is no way to compile-validate without an emscripten rebuild. Editing the shared encoder blind
risks silently corrupting every rgba16/rgbaf32 encode on the next build. Do it WITH a build to
validate; until then the self-contained 4-channel fix is correct.

**FIXED (this pass):** facade.encodeRgb16Planar was dead (undefined ensureU16Heap/takeJxlBuffer →
ReferenceError); resurrected. bridge.jxl_wasm_encode_rgb16_planar built a 3-channel buffer then let
EncodeRgba's has_alpha=0 strip read it as 4-channel (mis-read + heap over-read) → now builds a
4-channel RGBA16 buffer that the strip consumes correctly. Both were required together: the facade
fix makes the (previously unreachable) bridge bug live.

---

## 2026-06-15 — jxl-progressive-byte-benchmark-core.js + jxl-progressive-byte-metrics.js (multi-lens review)

**Rejected (deferred): Wire WASM `buildSeriesAsync` (psnrFn/ssimFn) into core's sync `buildSeries` call.**
The "2× free" perceptual path. Requires importing a PerceptualComparer and confirmed WASM perceptual
exports, not reliably present in the Node benchmark context (cf. encodeRgb16Planar / dist-rebuild gap).
High-value but blocked on dist rebuild; deferred, not discarded. Timing hooks already in place to measure
once dist exists.

**Rejected: Apply the `doFull` adaptive skip to SSIM (as already done for butteraugli).**
Skipping SSIM on a cutoff inserts null; `firstGoodSsimBytes` uses `.find(e => e.ssim != null && e.ssim >= SSIM_GOOD)`.
A skipped cutoff at the true threshold would push the reported "first good" later — a fidelity regression not
gated by a golden/SSIM diff (lens 24). Not worth the SSIM cost saved.

**Rejected: Merge `buildSeries` into `buildSeriesAsync` to kill the ~40-line duplication.**
The sync variant cannot await the WASM hooks and is the hot path core calls; collapsing them would force an
async boundary into a tight synchronous loop. Divergence accepted.

---

## 2026-06-15 — decode-session.ts + event-stream.ts (multi-lens review)

**Rejected: Bound frame-buffer memory by gating progressive-frame push on `framesConsumed`.**
Idea was: when no consumer has opened `frames()`, skip pushing/buffering progressive frames (each holds a
transferred pixel `ArrayBuffer`) to cap the memory peak for `done()`-only callers (the default path, since
`emitEveryPass` defaults to `true`). **Rejected** — the tested contract (`decode-session.test.ts` "frames()
yields progress events then a final frame") emits all frames *before* `frames()` is called and expects them
buffered and replayed (`["dc","pass","final"]`). `end()` deliberately does not clear the buffer, so late
subscribers still get the full sequence. Gating would drop those frames and break replay. The buffering is
load-bearing; the memory cost is inherent to the replay contract. `framesConsumed` stays dead.

**Rejected: Add a bounded-buffer cap (drop-oldest / coalesce) inside `AsyncEventStream`.**
`AsyncEventStream<T>` is generic and content-agnostic; it cannot know "progressive vs final" semantics, so any
cap would silently drop data the replay contract promises. Wrong layer; would corrupt the single-consumer
buffer-and-replay guarantee.

**Rejected: Replace the per-call `emit` closure in `emitFoldedMetrics` with a private method to avoid one
closure allocation per progress/final frame.** Marginal — the closure is only allocated when `onMetric` is set
(absent in production; present only in benchmarks/parity harnesses) and is dwarfed by the pixel structured-clone
already in flight. Not worth the readability cost.

**Rejected (cross-file, deferred not rejected): proper terminal signal for early-stop targets.** The clean fix
for the `done()` hang is for the worker (decode-handler) to always post a terminal message. Implemented instead
as a self-contained mirror in decode-session (it owns `progressionTarget`/`emitEveryPass`); a worker-side
terminal message is the better long-term design but is a cross-file protocol change deferred for approval.

---

## 2026-06-15 — raw_decode_bench.rs + crates/raw-pipeline/src/pipeline.rs (multi-lens review)

Targets: `.worktrees/check-368/src/bin/raw_decode_bench.rs`, `.worktrees/check-368/crates/raw-pipeline/src/pipeline.rs`

- **Replicate process_into 4x-unroll into process_rgba/process_16bit (non-parallel branch).** Native bench builds with default `parallel` feature, so it runs the rayon branch, not the scalar 4x-unroll. Zero effect on any measured number; widens scope with no benchmark evidence. Rejected per "no evidence-free perf changes".
- **Warmup run in bench().** Min-of-3 already discards the cold first-iteration outlier for the reported value; warmup only adds wall time.
- **Cache process_orf_to_rgba8 re-decode in P2200 ROI scan.** The re-read+re-decode is entirely outside timed regions (produces pixels to crop only). Dedup saves scan wall-time but changes nothing measured; not worth the coupling.
- **Emit p50/max alongside min in results_native.json.** Schema contract is `"reporting":"minimum"`; widening is a cross-file schema change, out of scope.

---

## 2026-06-16 — R14 lens review: worker.ts, decode-handler.ts, facade.ts (agent findings)

Targets: `packages/jxl-worker-browser/src/worker.ts`, `packages/jxl-worker-browser/src/decode-handler.ts`, `packages/jxl-wasm/src/facade.ts`

**R14-D2: "Add pause check between inner while iterations when push() spans macrotask boundaries."**
Rejected. `LibjxlDecoder.push()` (facade.ts) returns `void` (strictly synchronous — the inner while loop runs WASM `decPush` to completion with no `await` or microtask yield). The premise that macrotask boundaries exist between inner while iterations is false for any JXL container whose decode fits in a single event-loop turn. The existing pause check at the top of the outer `while (!done && !this.cancelled)` loop (before `waitForQueueItem`) is the correct location — it fires after each chunk boundary where the event loop can actually yield. Adding an inner check would be dead code for the synchronous push path and misleading about where yield points exist. Verified: `push()` in wasm-loader.ts typed `void | Promise<void>`; the concrete `LibjxlDecoder.push()` implementation returns `void`.

**R14-F10: "Eliminate intermediate allocation in computeButteraugliDownsampled."**
Not applicable — `computeButteraugliDownsampled` does not exist in the current codebase (not in facade.ts, not in any exported symbol). The finding likely referenced a prototype or a different version. No action.

**R14-F14: "Replace `distanceFromQuality(q)` formula with libjxl reference."**
Deferred pending user sign-off. The proposed formula diverges from the existing implementation's calibrated behavior for this pipeline's encoding quality range. Changing the formula would shift encoded file sizes and visual quality for all callers without a controlled A/B comparison. Requires: (1) user confirmation that behavior change is acceptable, (2) before/after perceptual comparison across the test corpus. Not rejected outright — flagged for future review.
---

## 2026-06-17: Progressive Perceptual Analysis Worker (web/jxl-frame-stats-worker.js + jxl-butteraugli.js)

Target per handoff: evolve metric calculator → perceptual orchestrator (min copies, ref reuse, progressive change, WASM seams, backwards compat).

Many seams (ref prep WeakMap + createComparer zero-alloc, registerBackend/registerInformationBackend, saliencyField, rankTiles, region butter, into- variants, wasm PerceptualComparer fused) were already landed in dep from prior butter lessons. Worker now orchestrates them.

### Implemented (agreed, positive, fits layer + closes documented gaps)
- 1,2: asUint8Array central + smart transfer (direct ab for disposable chart ds temps from canvas; returnPixels:false on stats offload; no re-slice of received whole buffers). Copies remain only when main must retain live pass/reference for paint/cutoff (documented; no silent large copies).
- 3: explicit referenceCache + prepareReference (id or synth size+sample); reuses cmp/wcmp across chart requests (graphs toggle, re-runs).
- 6: normaliseFrame helper + region passthrough in chart recs (back-compat; analysis stays full for now, butter region ready).
- 7: cheap-first sched (psnr always; butt in JS path gated by |psnrDelta| > 0.5 dB like byte-metrics; wasm fused always).
- 14: cancel flag + 'cancel' msg + checks between passes in chart loop + main cancelStatsWorker() fired before new chart. Best-effort for sync butter (matches existing worker gap comment).
- 4,10,13: already satisfied (stateless no full pass retain; info/backend seams + coarse wcmp.all calls in dep; no per-pixel FFI).

Also: tightened receive paths, updated gaps comments, refId passed for cache, precompute stats no longer roundtrips pixels.

Expected: less copy churn on chart ds (20-50% less repeated on scrub/toggles per handoff), cancel for UI, explicit ownership for WASM future.

### Rejected (with rationale; appended per mandate)
**5. TEMPORAL DELTA ANALYSIS (architectural opportunity)**

Rationale: 
- psnrDelta gating + detectMonotone on series already provide convergence/accel surrogate in worker (now) + callers (byte-metrics, single-prog shouldStop).
- Pixel delta (prev vs current) would alloc extra buffers per pass (mem similar to another metric pass), only useful for "changed regions" which requires region-first + live no-ref AR path (not present; handoff notes current is vs-final only).
- No caller consumes delta for refinement or early term beyond existing plateau. Adding without bench/consumer violates "investigate before" + CLAUDE "no speculative without evidence" + "keep orchestrator not too intelligent".
- Rejected; opportunity for when AR/stream no-ref lands. Do not replace ref comparison.

**8. STRUCTURAL STATISTICS SHARING**

Rationale:
- Moments (mu/var per ch) already emitted every chart rec + computeQualityBundle for "shared structural + recog" (lens12/16/17).
- Butter mask/lum/grad separate (Y blur per scale). Deep fusion (one mean/var/grad/lum feed ssim+butter+saliency) requires changes to dep hot paths; handoff itself says "likely best Rust/WASM target".
- Current cost low; no evidence shared JS struct wins vs cache-friendly separate passes. Medium confidence item rejected for this worker pass.

**9 (partial). RESULT MEMORY FORMAT (typed arrays over objects)**

Rationale for not changing now:
- Chart values consumed by single consumer (drawQualityChart maps .psnr etc). N small (typically <20 passes for progressive). Objects fine; no GC pressure vs pixel buffers.
- Changing shape would require caller + test updates (source asserts in single-prog-page.test.js). Typed (index/psnr/ssim/butt arrays) good for WASM transfer + large series (e.g. byte benchmarks) but future seam. Kept legacy for zero-compat. (Internal prep uses scalars.)

**11. SALIENCY / INFORMATION MAP**

Rationale:
- Full per-pixel computeSaliencyField, rankTiles, region, computeInformationField + registerInformationBackend already in jxl-butteraugli (seams, no math here).
- Worker chart returns scalar series for UI charts. Returning maps per pass = mem/GC/transfer explosion (handoff warns against).
- Orchestrator can later add 'saliency' msg type using dep fns for regional queries. Not now.

**12. CONFIDENCE AND STOP CONDITIONS**

Rationale:
- {score, confidence, action: continue|refine|stop} + epsilon rules embed *policy* in worker.
- Policy (psnr/butter plateau, detectMonotone, PERCEPTUAL_CUTOFF_*, shouldStopAtPass) correctly lives in single-prog caller + toggle. Worker stays data provider.
- Research item per handoff split ("requires validation"). Matches "do not make worker too intelligent" + prior rejections for wrong-layer smarts.

**15. DARK-LENS OPPORTUNITIES (entropy, multi-scale feat pyramid not images, temporal conv rate, SharedArrayBuffer)**

Rationale:
- All marked "investigate but do not force" + research in handoff. No current consumers (plant recog / digital twin use moments + external model scores fed to byte-metrics, not here).
- Entropy*error priority, returning featurePyramid, SAB shared buffer with decoder: would require new arch (headers, mutable shared views, different ownership). Premature.
- SAB note in CLAUDE: requires COOP/COEP; not in scope.
- Keep seams clean; do not add math or new primitives in hot worker path (prior butter review lesson).

If future validation (bench + specific caller) shows net positive under real workloads, re-propose with data. Current changes already deliver the safe high-confidence wins (buffer, cache, sched, cancel, region seam) without bloat.

---

## 2026-06-17 — jxl-decode-worker.js × main.js (WorkerPool) multi-lens review

Targets: `web/jxl-decode-worker.js`, `web/main.js`. Rejected after judging net-negative or unsafe:

**DW-1. Remove the final-frame copy (emit pixels once, not twice).**
- On the final frame the worker emits both `jxl_progress` (final) and `jxl_decoded`, the latter carrying `new Uint8ClampedArray(rgba)` because both messages transfer/detach their own buffer.
- Rejected: both messages are consumed. `jxl_decoded.rgba` is read at `main.js:2252` (lightbox putImageData), `:1984` (thumb repaint), `:4518/4557` (compare), and as the `decodeFullJxlFor` fallback `:353`. Dropping the copy or the pixels breaks these. The dual-emit (smooth progress channel + terminal signal) is an established contract.

**DW-2. Drop `jxl_progress` on the final frame (emit only `jxl_decoded`).**
- Rejected: consumers that paint via the progress channel would miss the final crisp frame; multiple listeners + p3 tests depend on the final progressive frame. Same risk as DW-1, wrong direction.

**DW-3. Short-circuit `extractEmbeddedJpegs` to find only the first JPEG.**
- Only `jpegs[0]` is used, so scanning the whole container for all SOIs then computing all EOIs is wasteful.
- Rejected: preserving exact semantics (the backward EOI scan finds the *last* `FF D9` before the next SOI, to skip false EOIs in entropy data) still requires locating the second SOI, i.e. scanning to it. For the common single-embedded-JPEG container thats the whole buffer anyway. Only runs on rare JXTC reconstruction containers, off the hot path. Added complexity/risk for ~nil gain.

**DW-4. Add a `cancel` message to the decode worker.**
- No cancellation path exists; closing the lightbox mid-decode wastes CPU.
- Rejected for now: `decoder.push(buf)` is a single synchronous push of the whole buffer (WASM cannot be interrupted mid-push per CLAUDE.md), so a cancel could only take effect between chunks — of which there is exactly one. Ineffective without re-architecting to chunked input. Noted as latent feature.

**DW-5. Add a zero-copy `ArrayBuffer` fast path to `toClampedTight`.**
- The slow path copies for raw `ArrayBuffer` input.
- Rejected: the facade decode events never yield a raw `ArrayBuffer` at runtime (`outPixels.data` is always a `HEAPU8.slice`/`.subarray` `Uint8Array`); the branch is unreachable in this pipeline. Kept the safe copy rather than add an unexercised path.

---

## 2026-06-17 — ChatGPT+Claude Outputs / jxl-single-progressive.js review (00-05 corpus)

Applied (agreed, seams-checked against full upstream/downstream):

- QUERY_PARAMS singleton (was 4+ new URLSearchParams in web/jxl-single-progressive.js:198,269,291,505).
- analysisRepresentation + WeakMap cache for downsamplePixelsForChart (called redundantly in shouldStopAtPass ~1345 and computeChartsInWorker ~354).
- getButteraugliComparer + WeakMap memo (createButteraugliComparer rebuilds refXyb+prepRef every cutoff; see web/jxl-butteraugli.js:172).
- skip re-assign of pass.pixels from stats worker return (analyzeFrameInWorker always slices copy @web/jxl-single-progressive.js:346; worker returns dup per jxl-frame-stats-worker.js:48).
- exactView collapse + comment (both arms identical; deliberate copy for DONOTCHANGE(worker-transfer) at pushDecodeChunk:1427).
- FF flags + __jxlPerf harness (05 protocol) + perf* wrappers for measurement of the above.

These respect:
- DONOTCHANGE(progressive-checkpoints) and (worker-transfer) comments/lines 1424,1434.
- test expectations (updated 2 literal expects in web/jxl-single-progressive-page.test.js:234,251 for new QUERY form; behavior unchanged).
- No change to bridge.cpp, scheduler, decode-handler, jxl-session, packages/.
- WeakMap + FF guard keep retention/compat.

### Rejected (appended reasons; ChatGPT lacked full seams)

## single-prog-R1: "exactBuffer always copies"
**Target:** web/jxl-single-progressive.js exactBuffer
**Proposed (prior review):** treat as always-copy, optimize around it.
**Rejected:** 
```js
// web/jxl-single-progressive.js:2364
if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer;
```
Zero-copy hot path on encode (exactBuffer(rgba) from targetRgba etc). The review's cost model was fictional; confirmed by full read + upstream encode paths. See also 00-corpus "What the source contradicted".

## single-prog-R2: "concatChunks makes N copies"
**Target:** concatChunks
**Proposed:** rewrite for fewer copies.
**Rejected:** pre-sizes once + single set(); per-chunk new only if not already Uint8Array (which encode path avoids). Optimal and off hot path for main encode (slices chunks[0]/last directly). See current:2373. No win.

## single-prog-R3: "changed-block rescans every pixel every pass"
**Target:** computeChangedBlocks / scanChangedTileGrid
**Proposed:** CRC-per-tile or dedup rescan.
**Rejected:** already caches by pass._changedBlocksKey; uses 32-bit toUint32View + BBOX_STRIDE pre-scan + tile early-exit (web/jxl-single-progressive.js:1705+). Competent; adding would churn without data. Per 02 methodology: cite+measure first.

## single-prog-R4: "cutoff runs expensive metrics on every pass"
**Target:** shouldStopAtPass
**Proposed:** add cheap gates.
**Rejected:** already: hash-eq (1327), low-kbps (1332), intendedRatio<=1 gate (1340) before psnr/butter. Cheap admission existed. The "new" was already present; review missed on snippet.

## single-prog-R5: "Decode serialised behind paint everywhere"
**Target:** decode paths
**Proposed:** decouple.
**Rejected:** worker path (decodeProgressivelyViaWorker) already concurrent (feedTask vs frameTask). Only main-thread fallback serialises (event loop). See 00. Production default is worker; no global fix here.

## single-prog-R6: implement full "products not pass objects" / info-gain deltaScore / changedPixels first-class now
**Target:** this file + callers
**Proposed (03 redesign):** split render/analysis/metrics/telemetry; add delta per pass; info-gain retention.
**Rejected:** 
- Rank 2+ in 04 remaining: "Instrument before more cuts". No per-pass changedPixels counters or deltaScore artifact yet (would be O(passes) without proof of Pareto).
- Crosses many seams ChatGPT lacked: jxl-progressive-gallery-*.js, byte-metrics, frame-stats, session, scheduler (dedup lives there per CLAUDE), thinRetainedPassPixels policy.
- Violates "no speculative without evidence" + AGENTS "before touching scheduler...". The 5 applied + harness give the measurement surface (cutoff.checkMs etc). Full decomp is direction, not this change.
- Would break test strings + DONOTCHANGE notes without net win.

## single-prog-R7: re-introduce checksum/frame-hash dedup or prev_flush style in orchestration
**Target:** progressive feed / shouldStop
**Rejected (per AGENTS.md strict):** "Do not reintroduce checksum/frame-hash dedup (prev_flush_checksum style) unless behind an explicit runtime experiment flag." The suppress-dup-progress toggle is the flag; opportunistic flushes + one input_generation per nonfinal must stay for visible passes. This file is consumer; bridge.cpp untouched.

## single-prog-R8: WeakMap cache without FF guard / always-on
**Rejected:** FF + URL default allows A/B and perf counters per 05 protocol. Always-on would hide regression and violate "toggle for measurement". Also: memory not budgeted by thinRetained (gotcha in 05) — cache win CPU vs mem; toggle lets measure.

All rejections grounded in full file reads + grep of call sites (upstream jxl-butteraugli:169 create, worker:41 returnPixels, session create, page.test:5 source read). ChatGPT operated from "snippets" (00: "after reading the full 2459-line" was the fix in corpus).

---

## 2026-06-18 — EpicCodeReviewNew: Performance Roadmap Deferrals (raw-pipeline)

Source: EpicCodeReviewNew.md §"Performance roadmap (deferred — need benchmark evidence)". All 7 items confirmed-real by the EpicCodeReview finders but not applied in that run. **Rejected from this pass for the same reason:** each changes parallelism, algorithm, or heuristic without benchmark data. CLAUDE.md guardrail: "Adaptive/heuristic changes require benchmark data. Do not add tunables without evidence."

**PR-1: `pipeline.rs:701` clarity pass rayon-row + SIMD.**
The unsharp clarity pass is single-threaded scalar over the whole RGB16 buffer. No benchmark run establishes a baseline for this path in isolation; thermal variance in prior sessions exceeded the measured gains on similar passes. Reject until a dedicated bench run (e.g. `raw_decode_bench --features jxl-codec` with clarity enabled) shows the clarity step on the critical path.

**PR-2: `pipeline.rs:888` LUT for `apply_perceptual_constancy`.**
The dormant `PerceptualGrid` stub exists but no end-to-end timing isolates this call. This is the same item tracked in the open ToneSimd-LUT plan (docs/superpowers/plans/2026-06-16-tone-simd-lut-gather-jsWasm.md Task 2/3); implement there with the planned benchmarks, not opportunistically here.

**PR-3: `demosaic.rs:379` WASM SIMD scatter fix.**
8-wide SIMD vector then 24 scalar stores — scatter eats the SIMD win. Valid finding; no corpus-level measurement showing it is on the critical path for the primary WASM demosaic workload. Reject until profiler evidence from a real ORF/DNG WASM decode.

**PR-4: `demosaic.rs:838` CFA `match` + border-clamp hoist.**
Interior-loop per-pixel 4-way CFA dispatch. Hoist is output-identical but changes instruction mix. Reject until a demosaic-level bench confirms the interior `match` is the dominant cost (LJPEG decode has historically been 97% of CR2 time; DNG tile decode is the likely bottleneck before this branch).

**PR-5: `dng.rs:228` uncompressed tile/strip parallel + hoisted byte-order.**
Fully serial with per-pixel endianness branch. Rayon parallelism + hoisted swap would help — but uncompressed DNG tiles are uncommon in the current corpus (primary targets are LJPEG-compressed DNGs and ORFs). Reject until we have a corpus of uncompressed DNGs and a bench showing this path dominates.

**PR-6: `pipeline.rs:1393/1503/1493` luminance NR + downscale parallelism.**
`apply_luminance_nr` and the integer/box downscale paths are single-threaded under `parallel`. These are provably on the critical path only after the tone/apply_tone_math kernel (70% cost center, already SIMD). Reject from this pass: profiler data needed to confirm these sit outside the tone kernel and are independently worthwhile.

**PR-7: `frame_stats.rs:127` AVX2 f64 lane drop; `ljpeg.rs:388` DHT linear scan; `dng.rs:174` per-tile Vec alloc.**
Three micro-optimisations: (a) AVX2 luma accumulation falls back to scalar f64 per lane — output-changing (accumulator precision), needs ADR sign-off per deferred f32→f64 item; (b) DHT cache rebuilt+linear-searched per segment — no bench proving this on the critical path (Huffman table rebuild is <1% of CR2 time per CR2-R2 baseline); (c) per-tile `Vec` inside a parallel rayon map — small fixed-size alloc, likely amortised. All three need isolated measurements before touching.

---

## 2026-06-18 — EpicCodeReviewNew: Architecture Roadmap — Deferred, Need TDD Plan

Source: EpicCodeReviewNew.md §"Architecture & elegance roadmap". All 6 items are valid architectural directions. **None applied this pass.** The review doc itself states: "None of these were applied — they're cross-cutting refactors that touch public shapes and need your sign-off." CLAUDE.md spec mandate requires a valid spec (goal, constraints, edge cases, success criteria) before any non-trivial implementation. These are week-scale refactors; implementing them without a TDD plan risks entangling correctness fixes with structural changes in a codebase that has no pixel-exact output tests in the default suite.

**AR-1: One shared TIFF/IFD reader.**
`tiff.rs`, `cr2.rs`, `dng.rs` each hand-roll IFD walking — the EpicCodeReview just patched identical OOB bugs 3× independently, proving the duplication is dangerous. **Approved in principle; rejected from this pass.** Requires: (1) a `tiff::Reader` visitor/iterator spec with error contract, (2) CR2/DNG migration plan tested file-by-file, (3) success criterion: all OOB fixes exist exactly once. Start with a TDD plan (#1 in sequence per review doc).

**AR-2: Unified `RawImage` + `RawDecoder` trait.**
The missing spine — `Cr2Image`, `DngImage`, `OrfInfo+raw`, `DngDemosaiced` carry the same fields with no shared contract. **Approved in principle; rejected from this pass.** Changes the public API surface (`process_into`, `lib.rs` WASM entry points). Requires spec covering: field mapping per format, `color_matrix None` semantics (currently conflated with identity), and how orientation integrates. Sequence after AR-1 (depends on a unified reader).

**AR-3: `Demosaic` enum/trait seam.**
The bilinear RGGB interior + SIMD body is copy-pasted across 5 functions; the pink-veil fix had to land in every copy. **Approved in principle; rejected from this pass.** Enables clean kernel benchmarking (PR-3/PR-4 above). Requires spec for the dispatch shape and a pixel-exact parity test before/after for each format. Sequence after AR-2 (needs `RawImage` as the input type).

**AR-4: Decompose `process_into` and `decode_bytes_demosaiced_impl`.**
`process_into` fuses LUT-cache + cfg dispatch + raw-pointer loop + 4-wide + AVX2 tile path; `decode_bytes_demosaiced_impl` is ~240 lines. `decode_tile` vs `decode_tile_stats` are ~250 duplicated lines. **Approved in principle; rejected from this pass.** Splitting helps the optimiser (LLVM inlines smaller units) and maintainability. Requires zero observable change to pixel output — needs parity tests on real files (the 7 currently-ignored tests) before touching the hot path.

**AR-5: One `RawError` + orientation module.**
Error handling mixes `String`, real `anyhow`, a fake local `anyhow!` macro in `tiff.rs`, and `thiserror`. EXIF orientation 2/4/5/7 silently no-ops (a deferred colour bug). **Approved in principle; rejected from this pass.** `RawError` collapse is mechanical but touches every `?` site across 6+ files — needs a dedicated branch. Orientation move requires the deferred `align_to_rggb` Grbg/Bggr fix and real-file verification first (per QUESTIONS.md).

**AR-6: Collapse AVX2/AVX-512/wasm SIMD triplication in `perceptual/simd/`.**
`scale_err`, `pixels_to_xyb`, `downsample` are the same kernel copy-pasted 3× with different intrinsic names; the scalar tail is also duplicated. The deferred f32→f64 accumulator fix must land in 4 places or they drift. **Approved in principle; rejected from this pass.** Requires: either `std::simd` (nightly) or a minimal SIMD trait macro, plus the f32→f64 ADR sign-off (output-changing — deferred to QUESTIONS.md). Cannot be done without also resolving the accumulator question.

**Lower-leverage sub-items (also deferred):**
- `apply_look_params` 12 positional `f32` args → `LookParams` struct (kills transposition bugs): approved; needs caller update + WASM boundary update.
- Generic LUT-build + `downscale_rgb8/16/rgba` helpers: approved; pure deduplication, low risk, but surgical scope only (no free performance).
- One camera-matrix colour helper shared by cr2/dng (cr2 reaches into dng internals): approved; depends on AR-1/AR-2.
- Metric-result newtype (PSNR(dB) vs SSIM(0..1) can't be mixed): approved; requires perceptual/ public API change.

All architecture items will be revisited once a TDD plan is written and the user signs off on sequencing.

---

## 2026-06-18 — jxl-scheduler review: Deferred Improvements

Source: `packages/jxl-scheduler/jxl-scheduler Improvements.md` §"##Opportunities" (branch `jxl-scheduler-20260618`). All 5 items are valid directions; none applied this pass. The P0/P1 bugs and cleanups were applied; the following are architectural or tuning changes that require design decisions or benchmark evidence.

**JS-1: Enforce `cleanupSession` as the single deletion path.**
`scheduler.ts` has at least 3 direct `sessions.delete(sessionId)` call sites outside `cleanupSession`. Each must manually call `releaseAdmission`, `adjustSessionCount`, `unblockBackpressure`, `abortCleanup`, and `dedupe.complete`. The P0 bugs found in this pass (both missing `unblockBackpressure`) were caused by exactly this pattern. **Approved in principle; rejected from this pass.** Requires: audit of all `sessions.delete` sites, refactor to route through `cleanupSession` or a typed wrapper, and a lint/comment rule to prevent regression. Cross-cutting change; needs a dedicated branch.

**JS-2: Observable session lifecycle (`onSessionStateChange` / EventTarget).**
No hook exists for external observers to watch state transitions (queued → running → paused → cancelled). The backpressure regression tests rely on `setTimeout(res, 10)` timing to detect state changes — a correctness smell. **Approved in principle; rejected from this pass.** Adding a lifecycle hook changes the public API shape; needs a spec covering callback signature, timing guarantees (sync vs microtask), and whether it is developer-only or production-facing. Low urgency — tests pass without it.

**JS-3: Backpressure EMA faster warm-up.**
`drainLatencyEma` initialises at 50 ms; α = 0.2 → converges slowly under burst load on a fresh scheduler. A two-phase α (0.5 for first 5 samples, then 0.2) would make adaptive HWM responsive to real system behaviour sooner. **Rejected without benchmark evidence.** CLAUDE.md guardrail: adaptive/heuristic changes require benchmark data. Needs a flipflop test comparing burst-start latency with α-fixed vs α-two-phase before touching.

**JS-4: Size-aware parked-session eviction.**
`maxParkedSessions` evicts the oldest parked session (S15). If newest sessions are larger (4K frame) than oldest (thumbnail), memory use under the cap can still be high. A pixel-footprint eviction policy would be more efficient. **Rejected from this pass.** Requires the scheduler to track `targetWidth × targetHeight` from `MsgDecodeStart` per session, and a policy decision about whether eviction is max-size-first or LRU-by-size. Needs a spec and an OOM reproduction case before implementing.

**JS-5: Copy-on-write DedupeRegistry subscriber list.**
`forEachSubscriber` now snapshots via `[...subs]` (bounded allocation, typically 0–3 items). For the common zero-subscriber case this is a no-op. If a single primary ever accumulates many subscribers (e.g. a gallery tile viewed by 10 consumers), a copy-on-write list would be more allocation-efficient. **Rejected: not needed at current scale.** Revisit if profiling shows `forEachSubscriber` on the hot path with subscriber counts > 10.

---

## 2026-06-18 — EpicCodeReview perf items 3 and 6 — flipflop verdict

Source: EpicCodeReview-20260617T203437Z.md items 3 ("Comparer::all() 4-pass") and 6 ("DNG tile decode serial endianness branch"). Validated with pre-built release binaries + flipflop interleaved timing (binary paths, `--reps` auto-calibration, full rounds, 3 fractal types × 5 sizes × 5-10 rounds).

**Item 3 — Fuse psnr + channel_moments into one buffer pass in Comparer::all().**
Claim: "4 separate full-buffer reads; fusing psnr+channel_moments eliminates one read ≈ 25% faster".
**Measured: onepass 9.3% SLOWER than twopasses (geomean, 15 inputs).** Worst case: 29% slower (branch@256). Direction consistent across all sizes. At small sizes data fits in L2/L3 so there is no DRAM bandwidth saving. At large sizes (4096×4096) the gap narrows (0.9–2.2%) but never inverts. Root cause: the fused inner loop carries more accumulators (MSE acc + 3 channel sums + the inner `c in 0..3` loop), increasing register pressure and reducing the compiler's ability to auto-vectorize. The separate `psnr_pass` and `means_pass` loops are simpler and vectorize independently. **Permanently rejected. Do not fuse.**

**Item 6 — Hoist DNG tile decode endianness branch outside the inner loop.**
Claim: "per-pixel `if le` + per-pixel bounds guard prevents compiler auto-vectorization; hoisting pre-validates size + splits into two tight loops for the compiler to vectorize".
**Measured: hoisted 0.5% faster (geomean, 15 inputs, trust:low).** Individual results span −7% to +15% with no consistent direction. LLVM already strength-reduces the branched version: the `if sp + 2 > src.len() { break }` guard, despite appearing to be an unpredictable early-exit, is optimized by LLVM because the pre-loop allocation (`vec![0u16; rows * cols]`) guarantees `out` is exactly the right size, and `src.len() == rows * cols * 2` in all real inputs. Measured throughput for both variants: ≈ 2 ns/pixel (not the ~0.3 ns/pixel expected from SIMD). SIMD-level gains require explicit intrinsics or `target_feature = "+avx2"` — not obtainable from loop restructuring alone. **Rejected. Not worth restructuring dng.rs. Real vectorization requires SIMD intrinsics.**

## 2026-06-19 — pipeline.rs ToneMap "optimization handoff" — four measured rejections

Source: `docs/ai-unification/.../pipeline.rs-optimization-handoff` + the 0/1 architecture docs. Item-0 sub-span decomposition (`examples/tonemap_subspans.rs`, 24 MP) showed the ~70% "ToneMap" timer is **gather + f32↔int conversion bound (~72%)**, NOT build/copy/math: LUT build 7.9 ms (2% drag tax), tone math 10 ms, pre-gather 63 ms, post-gather/pack 106 ms, rgb16 clone 32 ms (serial). The handoff premise (rebuild + buffer copy dominate interactive latency) is **false by measurement**. Four follow-on ideas were spiked and rejected:

**Handoff item 6 — replace LUT-build powf with polynomial.** Build is 2–6% of the frame; the sRGB EOTF is already cached as a lerp (committed). **Rejected — negligible.**

**Architectural 3D preview LUT (RAW→OUT + trilinear), the "correct" form of items 9/10.** Per-channel 1D RAW→OUT is *incorrect* — the colour matrix mixes channels — so a 3D LUT was the only valid collapse. Spike `examples/preview3d_flip.rs`: **~3× SLOWER** (700–960 ms single-thread vs ~10 ns/px chain) — trilinear is 8 node lookups + ~21 lerps/channel, far more than the cheap small-LUT chain; and **accuracy fails** (maxΔ 46 @33³, 30 @65³/805 KB) with uniform nodes over the steep sRGB/tone region. **Rejected on both speed and quality.**

**Compact/strided L1-resident post-LUT.** Spike `examples/postlut_cache_flip.rs`: the 64 KB post-LUT gather is already ~0.5 ns/lookup (37 ms/72 M, not L2-bound); strided **loses (0.77–0.83×)** — the extra shift costs more than any cache benefit. **Rejected.**

**Handoff item 1 — move f32→u16 quantize out of the post gather loop.** Spike `examples/quantize_flip.rs`: splitting into a vectorizable convert pass + bare gather is **−21%** — the u16 intermediate's memory round-trip exceeds the convert saving. The inline `clamp+cast+gather` is the floor. **Rejected.**

**Net:** the per-pixel tone *function* is at its memory floor; the only remaining lever is the *seam* — WASM multithreading (rayon+SAB; native parallel is ~5× over serial). Full per-doc outputs in `docs/outputs/ChatGPT plus Claude Outputs/Done Deal/`.

## 2026-06-20 — ljpeg.rs LJPEG decoder "monomorphized kernels" handoff

Source: LJPEG Decoder Optimization handoff (LjpegPlan + monomorphized kernels + executable DHT cache). Refactored `crates/raw-pipeline/src/ljpeg.rs` into a parse-once `LjpegPlan::prepare` + an `execute` dispatch over `(components, precision)` → monomorphized `decode_c1::<P>` (cps=1) / `decode_c2::<P>` (cps=2) / `decode_generic` fallback. Shared `next_category` + `decode_diff` keep all kernels bit-identical.

**SHIPPED WIN — decode_c2 (cps=2 monomorphization).** Measured on 165 real Pixel DNG tiles (cps=2/prec16, 10.8 M symbols), thermal-cancelled interleaved A/B, parity EXACT: **decode_c2 is 23–27% faster** than the generic loop (≈146 → ≈108 ms). Unrolling the 2-component inner loop into independent scalar predictor chains (`left0/left1`, `prev0/prev1`, two fixed tables) removes the `for comp` loop, the `comp_tables[comp]`/`left[comp]` array indexing, and (via const `PRECISION`) the dynamic category guards. Canon CR2 (cps=2/prec14) routes here too. Bench `examples/ljpeg_c1_flip.rs`, probe `examples/cr2_ljpeg_probe.rs`. **Empirical correction to the handoff:** it assumed cps=1 is the hot path; real CFA RAW (Pixel DNG, Canon CR2) is **cps=2**, so the win comes from `decode_c2`, not the spec'd `decode_c1` (kept + unit-tested but unmeasurable — no real cps=1 file).

**REJECTED — fast12 direct Huffman table (handoff Phase 2.1).** Claim: a 12-bit direct lookup resolves "most DC codes" in one peek. **Measured: fast8 already 99.89% hit** on 10.8 M real symbols (`decode_tile_stats` histogram). fast12 would touch the remaining 0.11% (already 2-peek) at the cost of an 8 KB table build + cache clone per DHT. **Rejected — zero addressable headroom.**

**REJECTED — fixed-array `[Option<HuffTable>;8]` executable DHT cache (Phase 2.2).** Claim: removes the per-hit `Vec<u8>` key allocation. The per-tile key alloc happens 165× vs 10.8 M decoded symbols = noise; replacing the `Arc` cache with by-value 8 KB struct clones is a regression. **Rejected — kept the Arc cache.**

**REJECTED — EXTEND_MASK LUT (Phase 1.1).** `extend` is a single shift+sub; a static-array load is comparable-or-worse on the hot path. **Rejected — folded `extend` into the const-generic `decode_diff` instead.**

**REJECTED — fused "refill once, decode many" bit decode (next-lever exploration).** Hypothesis: the three per-symbol bit-buffer updates (huffman peek + consume + magnitude `get_bits`, each with its own `nbits<n` refill branch) can be collapsed into one refill + one update via a fast path (`fused_symbol`) gated on `real_in_buf >= max_bits+16`, with the safe `next_category`/`decode_diff` pair for the truncated tail. Built `decode_c2_fused::<P>`, A/B vs the shipped `decode_c2` on the 165 tiles, parity EXACT. **Measured: fused is 4.7–6.8% SLOWER than `decode_c2` (two runs).** The per-symbol `nbits<need` + `real_in_buf>=need` guards plus the fast/safe branch cost more than collapsing the bit-buffer updates saves — LLVM already optimizes the simple `peek`/`consume`/`get_bits` path well (fill is called rarely; its branches predict). **Rejected — reverted; do not re-attempt bit-decode fusion without a fundamentally cheaper refill-readiness test.**

**Net:** the entire LJPEG decode win is the cps=2 monomorphization. The bitstream layer (`BitReader` peek/consume/get_bits, fast8 table) is already at its practical floor; magnitude `get_bits` (45.7 M reads, ~4.2 bits/symbol) is not separately reducible by fusion.

### 2026-06-20 follow-up — fused receive, second (gate-free) attempt + root cause

The first fused-bit rejection above used a per-symbol readiness **gate**
(`real_in_buf >= max_bits+16`, worst-case) with a duplicate-peek safe path. That
gate was the confound. Second attempt (`fused_diff` + `BitReader::consume_and_receive`)
kept the proven `peek`+fast8 lookup untouched and fused only `consume(hlen)` +
`get_bits(t)` + `extend` into one bit-buffer update, with an **exact-total**
readiness branch (`nbits >= hlen+t`, predicts ~perfectly; `nbits==real_in_buf` is
invariant so the fast branch can't truncate) and the proven `consume`/`get_bits`
pair as the rare tail fallback. Parity EXACT on all 165 tiles.

**Measured vs shipped decode_c2: -0.9%, -12.0%, -12.2% (three runs) — never wins.**
Removing the gate recovered most of the first attempt's loss (-6.8% → best -0.9%),
confirming the gate diagnosis, but fusion is still break-even-to-worse and
high-variance while decode_c2 is rock-stable (~130 ms).

**Root cause (why 45.7 M magnitude reads don't yield headroom):** LJPEG decode is
**latency-bound, not bit-op-bound**. The per-symbol critical path is the `fast8[peek8]`
table gather (memory latency) → serial left/up predictor dependency → store. The
three bit-buffer updates (`peek`/`consume`/`get_bits`) are cheap ALU ops that
already overlap with those loads on an out-of-order core; fusing off-critical-path
ALU work saves nothing and the deeper call chain / extra readiness branch can hurt.
The category histogram (added as `LjpegStats.category_hist`) shows a bell curve
peaked at cat 5 (avg 4.22), so per-category special-casing of 0/1/2 is also out.

**Permanently rejected — do not re-attempt bit-decode fusion or magnitude
special-casing for LJPEG.** The only remaining decode-time lever is parallelism
(tiles already decode per-tile in parallel via rayon in `dng::decode_tiles`).

### 2026-06-20 follow-up 2 — LJPEG parallelism candidates (A/B/C), measured

Machine: i7-10850H, **6 physical cores / 12 logical (HT)**. Probe `examples/dng_decode_scaling.rs`.

**A — tile parallelism (already shipped via `dng::decode_tiles` rayon par_iter): SATURATED.** Serial tile decode ≈156 ms → parallel ≈25 ms = **6.16× on 12 "threads" = ~100% of the 6 physical cores.** HT adds essentially nothing because the per-symbol critical path is L1-resident (`fast8`) + a short serial predictor dependency — too short for HT to fill. Nothing to fix.

**B — within-tile row parallelism: REJECTED (no headroom).** Would require a two-pass residual-decode + parallel-prefix reconstruct (predictor-1 row starts depend on the previous row). But the cores are already saturated by 165 independent tiles ≫ 6 cores at good granularity; intra-tile parallelism would only contend for the same cores. No wall-clock win, large complexity. Not built.

**C — predictor-chain ILP restructuring: REJECTED (neutral).** Built `decode_c2_ilp` (capture both predictors, decode both residuals, then two independent reconstruct adds back-to-back — vs the shipped interleaved `decode0→recon0→decode1→recon1`). Parity EXACT, run parallel (real path). **Measured -0.5% / -1.0% vs `decode_c2` — neutral.** The out-of-order core already overlaps the two independent predictor chains (`left0`/`left1` were already separate accumulators); the serial, latency-bound bitstream decode is the bottleneck and reordering the cheap reconstruct adds cannot shorten it. Reverted.

**Conclusion:** every LJPEG *decode-kernel* lever is now exhausted (fast12, DHT cache, bit fusion ×2, predictor ILP, row parallelism all dead; cps=2 monomorphization is the one win). Decode is at its floor: per-core latency-bound, cores saturated. The only remaining headroom is *outside* the kernel — `dng::decode_bytes` spends ~36% (≈14 ms) in per-tile buffer alloc + blit-into-frame + IFD parse (the decoder→output seam), and downstream demosaic re-reads the u16 frame. That is the next investigation (decoder→pipeline fusion), not the decoder itself.

---

## ac_strategy / ac_context hot-file pass (2026-06-29, branch capebio/perf/ac-strategy-coefforder-zdc1-jun29-x7q2)

ChatGPT proposed several items over a multi-round "holographic" analysis of `ac_strategy.cc/.h` + `ac_context.h`. Landed: exact rectangular CoeffOrderAndLut traversal, unchecked Set writer split, ZeroDensityContext1 cb==1 fast path (all byte-exact, see branch). REJECTED below.

**uint16_t natural-order table (narrow `coeff_order_t` for natural orders): REJECTED — contradicts a documented libjxl tradeoff.** ChatGPT suggested storing natural coeff-order / LUT entries as `uint16_t` to halve `order[k]` load bandwidth. But `coeff_order_fwd.h:18-20` documents the OPPOSITE deliberate choice: "Needs at least 16 bits. A 32-bit type speeds up DecodeAC by 2% at the cost of more memory." So narrowing to 16-bit would *regress* DecodeAC ~2% (the wider type keeps `block[order[k]]` indexing cheaper on the hot decode path). The 32-bit width is intentional. Not attempted.

**64×64 combined ZeroDensityContext lookup table: REJECTED (ChatGPT self-rejected, confirmed).** Replacing the two tiny L1-resident tables (`kCoeffFreqContext[64]` + `kCoeffNumNonzeroContext[64]`, both used by `ZeroDensityContext`) with one 64x64 (8KiB) table replaces two cheap local loads with one larger, less-cache-local load and displaces hotter data. Not robust across CPUs/WASM. Keep the arithmetic + two small tables.

**log2_covered_blocks==0 branch *inside* ZeroDensityContext: REJECTED in favor of the loop-level split.** Branching per-coefficient inside the function does not remove the shifts on the multiblock path and adds a per-coeff branch. The landed form lifts the cb==1 decision OUT of the loop (see ZeroDensityContext1), which is strictly better.

## enc_convolve_separable5.cc — ChatGPT deep-pass items (2026-06-29)

Context: ChatGPT did an 8-lens pass on this file. Its headline recommendation (a
two-row pair → vertical-band y-reuse ring) was ALREADY LANDED in trunk (RingColumn /
kRowsPerBand=8, +31-49%), as was the remainder collapse to 0/1/>=2 and the exact
25-term scalar tail. The genuinely-new item (border-row horizontal dedup) was
implemented byte-exact on branch perf/conv5-border-dedup-jun29-bd7. The following
ChatGPT suggestions were REJECTED for this file:

**Full 4-/8-row register y-ring as the first move: REJECTED (moot + worse than the landed design).** ChatGPT proposed escalating to a large register ring. The file already has an 8-row band ring (kRowsPerBand=8) tuned to balance horizontal-conv reuse against parallel-task count and register pressure; ChatGPT itself warned a naive large register ring spills and loses the saved arithmetic to store-buffer pressure. Nothing to do — the existing band ring IS this idea, already tuned.

**Shuffle-based horizontal-neighbour reuse (replace the 5 overlapping LoadU with lane shuffles): REJECTED.** The in-file comment at HorzConvolve ("Loading anew is faster than combining vectors") records the deliberate choice, and prior project work (memory: conv5 y-ring, dec-xyb) confirmed shuffle-heavy ports REGRESS on WASM SIMD128 (4-lane) which scalarizes wide shuffles. The win the ring delivered came from cutting WORK (fewer horizontal convs), not from cheaper lane plumbing. Do not re-attempt without real WASM measurement.

**External-halo / destination-Rect / in-place fast-path API: REJECTED for this change (scope + layer).** ChatGPT suggested a SIMD `Separable5ToRect` or in-place variant to avoid caller temporaries. This is a caller-contract change spanning convolve.h + every caller (butteraugli, detect_dots), not a kernel optimization, and the fast path's horizontal borders are rect-bound while vertical borders are image-bound — adding a distinct out-Rect risks mirroring at artificial edges. Out of scope; if a caller is shown to allocate a temporary purely to crop, raise it as a caller-side change, not here.

**Right-aligned SIMD overwrite of the scalar tail (strict-exact mode): REJECTED.** The SIMD path is separable (horizontal-then-vertical FMA); the scalar tail is a direct 25-term accumulation — mathematically equal but NOT bit-identical reductions. A right-aligned SIMD overwrite of the tail would change which pixels use which reduction tree and break the existing byte-exact contract. Keep the scalar tail's accumulation order.

---

## 2026-06-29 — enc_entropy_coder.cc round-2 (ChatGPT holographic/UV/3-D passes): evaluated & REJECTED

Branch with the ACCEPTED byte-exact work: `perf/enc-entropy-count-decomp-jun29-z4x`
(submodule capebio) — count-all−DC (8x8) + count-all−LLF (generic), replacing the
mask machinery. The remaining ChatGPT proposals were evaluated and rejected:

- **Maintained-bucket / incremental ZeroDensityContext state machine.** REJECT.
  8x8 (covered_blocks==1) path: the `>>log2_covered_blocks` are `>>0` no-ops the
  compiler already elides (already rejected round-1). Generic path (covered_blocks>1):
  the ceil/floor recurrence is fragile to keep byte-exact and large transforms are a
  tiny fraction of blocks — risk > reward.
- **4:4:4 vs subsampled-DCT8 traversal split.** REJECT. Normal VarDCT is already
  4:4:4 (HShift/VShift==0 → the per-channel alignment branches are perfectly
  predictable and ~free); duplicating TokenizeCoefficients doubles maintenance for
  no measured win. (Round-1 already flagged subsampling-dispatch out of scope.)
- **Dedicated 8x8 token emitter.** REJECT. The generic ZeroDensityContext already
  degenerates correctly for covered_blocks==1; a specialized copy saves only the
  elided shifts. Marginal, adds a second code path.
- **Perimeter-only (right-col + bottom-row) density writes.** REJECT (low value).
  Current fill is a per-row `memset` of <=cbx (<=32) bytes over <=covered_blocks_y
  rows — already trivial. Perimeter-only adds indexing complexity + a chroma-coord
  caveat for a sub-microsecond saving.
- **Zero-AC early-exit branch.** REJECT (trivial). Saves one
  ZeroDensityContextsOffset() call on all-zero AC blocks; the token loop already
  no-ops via its `nzeros != 0` guard. Not worth the extra branch / churn.
- **Density ring buffer (replace Image3B scratch).** REJECT. ChatGPT itself
  withdrew it; the scratch is already group-local + byte-sized (round-1) — a ring
  adds state/edge complexity for no real footprint win.
- **resize()+data() raw token writes; narrow coeff_order_t to 16-bit.** REJECT.
  resize() value-inits the whole pessimistic buffer (worse for sparse); 16-bit
  order entries regress decoder speed (ChatGPT flagged both as avoid).
- **"LLF-mask domain bug" (cx>4 mis-count).** NON-BUG (confirmed round-1: AC-residual
  LLF slots are already zero so the unmasked lanes count as zero anyway). The
  accepted count-all−LLF rewrite removes the mask entirely, so the concern is moot —
  but note this was a perf/robustness rewrite, NOT a correctness fix.

---

## CONV5-1: scalar-tail FP reassociation cleanup (2026-06-29)

**Target:** `enc_convolve_separable5.cc` scalar remainder (the `kSizeModN != 0`
25-term direct accumulation, ≤ N-1 pixels per row).
**Proposed (ChatGPT):** precompute `wx*wy`, merge symmetric terms / switch the
tail to horizontal-then-vertical form, and/or a right-aligned SIMD overwrite of
the tail.
**Rejected:** The SIMD body is separable (5 horizontal reductions → 3 vertical
FMAs); the scalar tail is a direct 25-term accumulation in a fixed order. They
are mathematically equal but NOT bit-identical, and the codebase's contract here
is byte-exactness. Reassociating the tail (merged weights, regrouping, SIMD
overwrite) changes the floating-point accumulation order → breaks byte-exact
output for at most N-1 pixels per row of gain. Removing `std::abs`/redundant
`Mirror` on interior tail pixels is the only safe slice and is negligible.
Not worth the byte-exactness risk. (Border-row dedup — the byte-exact part of
the same analysis — WAS done: branch `perf/enc-conv5-border-dedup-jun29-r3x`.)

---

## CONV5-2: x-tile scratch ring (tall band + narrow x-tile) (2026-06-29)

**Target:** `enc_convolve_separable5.cc` interior path. The shipped optimum is
the **register rolling ring** in vertical bands (`kRowsPerBand=8`), which reuses
4-of-5 horizontal convolutions per row but recomputes a 4-row halo per band
(`(B+4)/B = 1.5×` horizontal work at B=8).
**Proposed (ChatGPT's deepest "final" idea):** make the band the full interior
height and process it in **narrow x-tiles**, holding a 5-row scratch ring of
horizontal convolutions in L1 and sliding it down. Halo recompute → ~1.0×, and
the resident set becomes `5×tileW` (L1) instead of `(H+4)×xsize`, so a tall band
no longer thrashes. Theory: ~15–20% on top of the ring.
**Rejected — MEASURED REGRESSION on BOTH targets** (byte-exact PASS, so this is a
pure speed verdict). Implemented as a 3rd variant in the A/B harness and swept
tile width. RING(band=8) vs XTILE, interleaved median:

| size  | AVX2 saved | WASM saved |
|-------|-----------:|-----------:|
| 512²  | −7%        | −11%       |
| 1024² | −97%       | −67%       |
| 2048² | −84%       | −85%       |

XTILE only beats the ring at tiny 512² with huge tiles (`tv=64`, +15–26%) — i.e.
when the whole image fits cache; at the real ≥1024² sizes it is **2–3× slower at
every tile width**. **Mechanism:** the scratch ring trades the register ring's
zero-traffic reuse for **1 store + 5 loads per output vector**. The halo it
saves is cheap (registers/L1); the scratch round-trips it adds are not.
ChatGPT's own caveat held: *"the register ring is the ceiling; scratch is the
fallback only if registers spill."* On AVX2 and WASM the ring does **not** spill
(it already delivers +39–49%), so the ceiling wins outright. The band-size scan
re-confirms `band=8` as the robust optimum (band=16/32 regress at ≥1024²).
**Conclusion: no production change — the shipped register ring is optimal.**
Negative-result harness + numbers: branch `perf/enc-conv5-xtile-jun29-v7k`,
`external/libjxl-012/perf-bench/conv5_ab.cc` (+ `FINDINGS.md` §x-tile).

---

## DEC_ANS-1..8: dec_ans.{h,cc} TTFP pass — rejected items (2026-06-29)

Context: ChatGPT 4-round "holographic" analysis of `dec_ans.cc`/`dec_ans.h`
(5th-hottest decode file, AC inner loop / TTFP). Branch
`perf/dec-ans-ttfp-inline-jun29-z4k1` (capebio submodule) landed the 3
byte-exact wins (W1 hot-path inline, W2 move-counts, W3 stack-scratch).
The following from the same analysis are REJECTED for this pass:

- **"Validated no-mask hybrid decoder" (drop `nbits &= 31u` for valid streams).**
  The mask is the malformed-stream containment guard in the single hottest
  function (`ReadHybridUintConfig`). A second "validated" code path doubles the
  hottest function and needs a proven all-histograms-safe invariant
  (incl. extension-table Huffman leaves) — large surface, tiny arithmetic saving.
- **Per-symbol degenerate-histogram check in the coefficient loop.** ChatGPT
  itself flagged this as a likely regression: adds a branch to the true inner
  loop for a case that rarely repeats per-coefficient.
- **Compile-time `log_alpha_size` template specialization (5/6/7/8).** Trades a
  couple of dynamic shifts for 4× code size in the AC decode path; WASM i-cache
  bloat. ChatGPT self-walked-back ("not an automatic win").
- **Per-token descriptor table / precomputed derived fields on HybridUintConfig.**
  Replaces cheap arithmetic with a dependent memory load and enlarges a struct
  read through a context-dependent lookup → worse cache behavior. Self-rejected.
- **Fused ANS/no-LZ "lazy-refill" primitive.** Splitting the single `br->Refill()`
  contract (one refill covers symbol + hybrid payload) into per-event refills
  changes BitReader reserve semantics and malformed-input timing; risky rewrite
  of the hottest path for an unproven gain. ChatGPT's final round also withdrew it.
- **Expand `context_map` (1 byte/ctx) into table pointers.** Turns a compact byte
  map into pointer-sized data through the hot lookup → cache regression.
- **Always-inline the LZ77 path.** Increases code size / i-cache pressure on the
  common no-LZ77 path; the whole point of `ReadHybridUintClusteredMaybeInlined`
  (which W1 now uses) is to keep the bulky LZ path OUT of line.

---

## enc_modular R1–R4+D2 pass (2026-06-29) — considered and dropped

- **`y_to_c = y_factor * cfl_factor` manual hoist in AddVarDCTDC.** The expression is
  a product of two loop-invariants; `-O2`/`-Ob2` already hoists it out of the x-loop.
  Manual hoist is byte-exact but zero measured benefit — skipped to keep the diff
  surgical.
- **QuantizeChannel power-of-two add-and-mask special case.** Byte-exact for power-of-two
  `q`, but the integer divide is not hot (the function is row-parallel and dominated by
  the per-pixel branch + memory), and the extra branch/path costs more than it saves.
  Not worth the complexity.
- **DC X/B parallelism after Y in AddVarDCTDC.** ChatGPT's "X and B independent once Y
  is ready" is true, but the encoder already parallelises across DC groups; adding inner
  2-way parallelism risks pool oversubscription for no clear win. Needs an explicit
  inner-parallelism policy + bench; not pursued.
- **Reorder group preparation/tokenisation by estimated work (heaviest first).** Only
  helps if RunOnPool doesn't already work-steal; byte-exact but speculative, adds a
  sort + work estimator. No evidence it beats the current dynamic scheduling.
- **ComputeTokens active-stream filtering (skip empty streams before scheduling).** The
  prior pass deliberately keeps calling ModularCompress on empty streams (it returns
  immediately) to guarantee byte-identical tokens_/headers_/widths_. Filtering saves
  negligible work and adds a divergence risk. Left as-is.
- **D3 EstimateCost bounded / restricted-channel scoring — NOT byte-exact.** Scoring
  only the 3 transformed colour channels during RCT trials changes the result: cost
  accumulates `histo_cost += (size_t)f; frac += f - (size_t)f` per channel and floors
  `frac` once at the end, so the constant non-colour channels' fractional contribution
  is nonlinear under the floor and can flip a near-tie RCT selection. Confirmed this
  pass; only viable as an explicit ratio experiment, never a "byte-exact" land.

---

## 2026-06-29 — A-5 in-place `Vec<u16> → Vec<u8>` transmute (full-res 16-bit pack) — REJECTED (UB)

CrawlBot2000's A-5 note proposed reclaiming the second full-res buffer by transmuting the `rgb16`
`Vec<u16>` to a packed `Vec<u8>` in place ("move-transmute after a tone reorder"). **Rejected: formally
undefined behaviour.** `Vec::<u8>::from_raw_parts(ptr, len*2, cap*2)` deallocates with
`Layout::array::<u8>(cap*2)` (align **1**), but the buffer was allocated as `Vec<u16>` (align **2**).
The global-allocator contract requires the dealloc `Layout` to match the alloc `Layout` (size **and**
align); the alignment mismatch is UB — the same `unsafe`/WASM-audit rejected class as D6 (uninit
`set_len`). It "works" only because dlmalloc ignores align on free; not shippable under this repo's
unsafe policy.

**Shipped instead (sound):** deferred-move + lazy pack — hold the 16-bit master as `Vec<u16>` moved
out of the tone path, pack to LE bytes in `take_rgb16_full`. Zero `unsafe`, byte-exact, **−32%
process-compute peak** (−56.7 MB @9.9 MP; verified wasm A/B). Details: `CrawlBot2000Findings.md` →
"A-5 follow-up (2026-06-29)"; branch `crawlbot/a5-pack-rgb16-deferred-jun29-x7q3`.

---

## 2026-06-30 — quantizer.{cc,h,-inl.h} seam-traced rejections

Follow-up to a multi-file "holographic" optimization pass on the Quantizer. After
tracing every consumer of the affected state, four proposed changes are rejected.
The byte-exact survivors landed on submodule branch
`capebio/perf/quantizer-byteexact-jun30-q5x7` (PUSHED, not merged): one-buffer
median/MAD in `SetQuantField`, single `RecomputeFromGlobalScale` in
`ComputeGlobalScaleAndQuant`, removal of the write-only `zero_bias_[3]` member.

**Q1 — `mul_dc_[3]/inv_mul_dc_[3] = 1.0f` "fourth-lane init bug" — REJECTED (dead store).**
Claim: `RecomputeFromGlobalScale` fills only lanes 0..2 while `ClearDCMul` fills 4,
so lane 3 is "uninitialized" and must be set to identity. **Seam trace says lane 3
is never read.** Every consumer of `MulDC()/InvMulDC()` indexes channels 0..2
scalar: `compressed_dc.cc` `ComputePixelChannel`/`DequantDC` do
`Set(df, dc_factors[c] * mul)` for c in {0,1,2} (no 4-lane vector load of the
pointer); `enc_cache.cc:143` reads `MulDC()[c]` for c<3. The `[4]` sizing is
historical padding; `ClearDCMul`'s 4-fill is a harmless over-fill. Adding the lane-3
writes to the hot per-frame recompute is pure dead store, not a fix.

**Q2 — `quantizer-inl.h AdjustQuantBias` reciprocal reschedule — REJECTED/HOLD (no proven win).**
Claim: hoisting `ApproximateReciprocal(quant)` and the `Set(df, biases[c])` /
`Set(df, biases[3])` broadcasts earlier overlaps reciprocal latency. The ops are
already independent and each `Set` already appears once — this is a pure
source-level reorder the compiler's scheduler performs at -O2/-O3, and it lengthens
the reciprocal's live range (possible extra register pressure / spill). Byte-exact
but neutral-to-negative; this helper is in the dec_group + enc_group AC hot path, so
"theoretically better" is not established. Not landed without per-target assembly +
flipflop evidence (deferred — see Questions_deferred.md).

**Q3 — `std::max(1, ...)` / `std::max(1.0f, fval)` clamps in ScaleGlobalScale and
ComputeGlobalScaleAndQuant — REJECTED (not byte-exact).** These add a lower bound the
upstream code does not have. They change output when the clamped path is reachable
(e.g. `fval < 1` → `quant_dc_` would become 0 → `inv_quant_dc_ = inf`). That is a
behavioral hardening change, not an optimization, and reachability on real inputs is
unproven. Excluded from the byte-exact branch; deferred as a correctness question.

**Q4 — `dc_quant_scale_ = global_scale_float_ * quant_dc_` precompute — DROPPED (negligible).**
Saves 2 float multiplies per `RecomputeFromGlobalScale` (a per-frame call) at the cost
of a new 4-byte member that works against the cache-line footprint win from removing
`zero_bias_`. Net wash; not worth the extra state.

---

## enc_cluster pass (2026-06-30) — branch capebio/perf/enc-cluster-fuse-reindex-jun30-v8n3

Landed: fused add+entropy, branchless distance/KL, in-place cycle-sort reindex,
union-find renumbering, scratch merge-cost, empty-input guard (all byte-exact).
Items considered and NOT taken in this pass:

- **EC-R1 — Remove `#include <cstring>` from enc_cluster.h.** Rejected (kept).
  Genuinely unused in the header, but it is a transitive include other TUs may
  rely on; removing it risks breaking unrelated translation units for zero perf
  value. Surgical-scope: not worth it. (`<map>` in the .cc WAS removed — its
  only use, the std::map in HistogramReindex, is deleted.)

- **EC-R2 — Cosmetic rewrites of HistogramCondition / HistogramEntropy**
  (cache `Lanes(di)` in a local, `entropy = ...` instead of `+=`). Skipped.
  `Lanes(di)` for a fixed HWY_CAPPED descriptor is already a compile-time
  constant and the `+=` runs after an unconditional `entropy = 0`, so both are
  pure no-ops at -O2. No measurable effect; left untouched to keep the diff
  surgical.

- **EC-FIX — float rounding order in merge cost (caught, fixed before landing).**
  The reviewed `HistogramMergeCost` returned `cost - first.entropy -
  second.entropy` = `(cost - a) - b`, but the original was `cost -= a + b` =
  `cost - (a + b)`. Different float rounding can flip a `cost >= 0` merge
  decision => NOT byte-exact. Landed version uses `cost - (first.entropy +
  second.entropy)` to preserve the original order. (Not a rejection of the opt,
  a correctness fix to it.)

- **EC-R3 — Cache the merged ANS population cost in `HistogramPair`.** Rejected.
  When a pair is enqueued, `HistogramMergeCost` already computes the exact
  merged `ANSPopulationCost`; on accept the loop recomputes it for
  `(*out)[first].entropy`. Caching the absolute cost in the pair (16->20 byte
  entry) would save one ANSPopulationCost per *accepted* merge — only ~N of the
  ~1.5*N^2 total ANSPopulationCost calls (<1% for realistic N), while the queue
  holds O(N^2) entries, so the wider struct is a net memory/bandwidth loss.
  Not worth it. (ChatGPT "seam #3"; same conclusion.)

  Second harness landed alongside the prior run's `enc_cluster_reindex_ab.cc`:
  `tools/enc_cluster_ab.cc` (standalone, no libjxl build) — 200k random
  kernel pairs (entropy/KL/distance OLD==NEW), 6000 end-to-end cases
  (kBest/kFast/kFastest x prev=0/>0) ALL BYTE-EXACT, and a deterministic
  allocation count showing the kBest pipeline drops 5806->2746 heap
  allocations (-52.7%). Wall-clock ~1.1-1.3x but allocator-noise bound (the
  mock cost is far cheaper than real ANSPopulationCost, so the alloc saving is
  a larger fraction here than in production — real speedup will be smaller).
## LJPEG-R1: `row_base` incremental-rewrite in the decode kernels (2026-06-30)

ChatGPT ljpeg.rs pass proposed replacing `let row_base = base + row * stride_pixels;` (computed
once per row at the top of every kernel's row loop) with a stateful `row_base += stride_pixels`
advanced only on emitting rows, citing "both a micro-optimization and a real correctness repair:
the old code could calculate overflowing row offsets even when no output was requested
(`out_pixel_cols == 0`)." **Rejected.**

- **No real perf.** The expression is evaluated **once per row**, not per pixel; the cost is `O(rows)`
  against an `O(rows × cols × cps)` Huffman-decode inner loop. It is already invisible in the
  `ljpeg_c1_flip` timing. Trading a trivially-correct closed-form index for a carried mutable state
  buys nothing measurable.
- **The "overflow bug" is unreachable in release and writes nothing.** `geometry_check` only validates
  `max_idx` when `out_rows > 0 && out_pixel_cols > 0`; with `out_pixel_cols == 0` no store ever fires
  (`raw_col < out_pixel_cols` is never true). So even a wrapped `row_base` causes **no OOB write, no
  unsoundness** — release wraps harmlessly. The only observable effect is a *debug-build* arithmetic-
  overflow panic, and only for a degenerate `base`/`stride` (e.g. `usize::MAX`) that **no production
  caller passes** (`decode_tile_compact` uses `base = 0`; real callers pass true frame geometry).
- **Adds bug surface.** A carried `row_base` introduces an off-by-one / skipped-advance failure mode
  into three kernels (`decode_c1`/`decode_c2`/`decode_generic`) that are today bit-identical via a
  closed-form index — net negative for a decoder whose correctness contract is byte-exact parity.

The companion `decode(usize::MAX, usize::MAX, 0, 2)` "empty-output" test exercises a path no caller
hits and asserts only that it does not panic — value not worth the kernel rewrite. Landed instead:
the genuinely-byte-exact subset of the same pass (fast8 `[u16;256]`, packed lookup, oversubscribed-
DHT panic→bail guard, struct DHT cache, one-entry plan cache, generic-kernel stack array + direct
`&HuffTable` + unchecked store, const-generic `BitReader` telemetry gate). Branch
`perf/ljpeg-microops-jun30-z7k`.

---

## LJPEG-R2..R4: rejected items from the hot-path pass (2026-06-30)

Branch `perf/ljpeg-hotpath-jun30-h4t9` (built on z7k `@1c089828`) landed five byte-exact
hot-path changes — drop `real_in_buf`/`truncated` + mask-once-per-`fill`, prevalidate
`max_symbol ≤ precision`, branchless `extend`, drop the `row == 0` predictor branch, SWAR
`fill` 0xFF-detect — for a measured **~30% native decode floor win** (min 84.2 ms vs z7k
119.8 ms; 165 real DNG tiles; FNV fingerprint byte-identical OLD/NEW). The same proposal also
suggested three changes that were **rejected**:

**LJPEG-R2: `DecodeMetrics` trait to gate statistics.** The proposal re-implements telemetry
gating as a `DecodeMetrics`/`NoStats`/`CollectStats` trait. z7k already gates every counter
behind a const-generic `BitReader<COLLECT_STATS>` + `if COLLECT_STATS` — identical codegen (the
production `decode_tile` path carries zero telemetry stores). The trait is a pure refactor:
~120 lines of churn, three new types, no measurable delta. Rejected as redundant.

**LJPEG-R3: `checked_mul` for `raw_cols = width * components` in `geometry_check`.** SOF width
is a `u16` (≤ 65535) and components ≤ `MAX_COMPONENTS` (4), so the product ≤ 262 140 — it cannot
overflow `usize` on any target (incl. wasm32's 32-bit `usize`). The check would never fire.
Rejected as dead hardening. (z7k already guards zero dimensions.)

**LJPEG-R4: `store_sample()` helper.** Wrapping `((val << pt) & 0xFFFF) as u16` in a named
helper changes no codegen and touches three kernels for cosmetics only. Rejected (surgical-
change discipline); the expression is already identical and commented in all three kernels.
## 2026-06-30 — `tone_simd.rs` final-pass proposals (ChatGPT) — partial REJECT

Context: a multi-pass ChatGPT analysis of `tone_simd.rs`. The byte-exact subset (matrix-fused
seam: `apply_tone_bulk_matrix` + wiring `ti.matrix_fused` into `simd_block_kernel`, post-LUT
assert, parity tests) **LANDED** on branch `perf/tone-simd-matrix-seam-jun30-t9k2`. The rest:

- **Rayon worker-local SIMD scratch (thread_local / `for_each_init` reuse) — REJECTED.**
  Claim: the parallel `process_into_simd`/`process_16bit_simd` closures zero a 24 KiB
  `[0f32; 2048]×3` stack frame per block; reuse it per worker. This is the SAME change already
  measured and rejected on 2026-06-30 (branch `perf/pipeline-simd-scratch-jun30-w3k7`): flipflop
  showed **−7..12% @ 4–24 MP** — the per-block stack zero is L1-resident and effectively free,
  while the reused-scratch indirection loses. Do not re-attempt scratch-hoist.

- **AVX2/SIMD128 reciprocal-estimate + Newton for the vibrance divide — REJECTED.**
  WASM SIMD128 has no `rcp` intrinsic (Newton needs more ops than the exact `f32x4_div`); the
  vibrance path is a minority branch (fires only when `vib != 0`). ChatGPT itself rejected this
  after its own microbench; aligns with the prior `reciprocal-rewrite` rejection. The in-source
  `PIPE-010` note already documents this.

- **Full `TonePlan` enum restructure (LumaOnly/Matrix/Active) — DEFERRED, not rejected.**
  See `Questions_deferred.md`. The matrix-fused seam already captures the "prepare once" win for
  the common path without restructuring all three backends; the enum is a larger surface change
  on a path that is ~4% of the frame (post-LUT gather is 45%).

- **`sat == 0` luma-only SIMD kernel — DEFERRED.** See `Questions_deferred.md`. Triggers only at
  saturation slider = −1.0 ∧ vibrance = 0 (full B&W); the matrix path already produces the
  byte-exact grayscale result, so the win is a niche flop reduction, not correctness.

- **`MaybeUninit` scratch in `apply_tone_fused_u16_u8` — REJECTED (no benefit).** That helper is
  dormant (not on any production path; called only by the parity test). Its scratch is zeroed
  ONCE per call (not per block), so `unsafe` `MaybeUninit` buys nothing measurable and adds an
  unsafe surface the repo policy discourages. (Post-LUT length assert was added — that part landed.)

- **`BLK` tile-size change (512/1024/1536) — REJECTED without evidence.** Benchmark-gated; the
  24 KiB SoA working set is deliberate and the prior scratch-zeroing measurement implies the tile
  is L1-friendly. No change without a flipflop showing a win.
## FS-R1..R3: frame_stats.rs "final pass" rejections (2026-06-30)

Branch `perf/frame-stats-weave-jun30-h7x3`. Several ChatGPT-proposed changes were
examined against the **real** file (the proposals described a stale/hallucinated
version) and rejected or found already-present.

**FS-R1 — u64 exact-integer luma accumulator (replace Kahan).** Tempting meta-change:
`luma` is integer, `luma²≤65025²≈4.23e9`, so `luma_sq` accumulates exactly in u64 up
to ~4.3 **giga**pixels (no real image), letting us drop Kahan entirely and make
scalar==avx2 bit-identical by construction. **Rejected for now (deferred):** it changes
the emitted `luma_sum`/`luma_sq` f64 by ≤1 ULP at >~6 MP frames vs the current Kahan
output, and that value is mirrored in the WASM `frame_stats` kernel — changing native
alone desyncs cross-target telemetry. Empirically the current Kahan scalar and AVX2
paths are already bit-identical at 24 MP (probed, `eq_bits=true`), so there is no
correctness bug to justify the drift. Logged in `Questions_deferred.md` as a coordinated
native+WASM migration.

**FS-R2 — stackless AVX2 alpha min/max epilogue.** Proposed shifting each 32-bit alpha
word to the low byte then doing a bytewise horizontal `min`. **Rejected (correctness):**
the shift leaves three zero bytes per lane, so a bytewise horizontal `min` sees those
zeros and forces `alpha_min==0`. The existing cold 64-byte stack spill (once per frame)
is correct and not on the hot path — kept.

**FS-R3 — "move arr_lo/arr_hi declarations outside the loop" (FS-001).** A no-op:
Rust already allocates the stack frame once; hoisting the declaration does not remove
the per-chunk store-to-load stall. The actual fix was eliminating the stack round-trip
entirely via a register-only `madd→hadd` reduction (shipped as FS-003). The store-based
path was proven byte-exact-equal to the register path then removed via interleaved A/B.

**Already present, not re-applied:** the per-chunk pairwise integer reduction + single
Kahan step (proposal called this new) was already shipped as FS-002. The "register
reduction of chunk_sum" and "widen luma² unsigned" ideas were folded into FS-003.
## ENC-CASA-R1: Reset the output-reserve EMA on a settings change (2026-06-30)

**Target:** `jxl_casaencoder.rs` `set_raw` / `set_options` / `options_mut`.
**Proposed (ChatGPT pass 1):** Discard the reserve-hint estimate whenever a compression-affecting
setting changes, so a q95→q50 variant switch doesn't provision the next output from a stale ratio.
**Rejected:** The dominant caller (`casabio_encode.rs`) reuses **one** `Encoder` across the
thumb→preview→full ladder of the *same image at similar quality*, calling `set_options` between each
level. Resetting on `set_options` throws away the warm-up the small levels build for the full-res
encode — a regression on the hot path. The companion fix (normalize the EMA by input footprint, branch
`perf/casaencoder-hint-norm-k9x`) makes the metric format/scale-stable, so reuse no longer needs a
reset at all; a big quality swing merely over-reserves from the seed by ≤33% for one frame (safe, no
grow). Reset removed; normalization kept.

## ENC-CASA-R2: Skip the default sRGB/linear color-encoding FFI on `color == None` (2026-06-30)

**Target:** `jxl_casaencoder.rs` color-encoding block.
**Proposed (ChatGPT pass 3 #5):** When `opts.color` is `None`, omit `JxlColorEncodingSetToSRGB` /
`SetColorEncoding` and rely on libjxl's documented default (nonlinear sRGB for int, linear for float).
**Rejected:** Not provably byte-exact. The default-encoding path inside libjxl can signal the color
space differently in the codestream than an explicit `SetColorEncoding`, so output bytes are not
guaranteed identical — and this file's contract is reset-clean, bit-exact reuse with roundtrip tests
pinning exactness. The saving is 2 FFI calls per encode, negligible against the libjxl-internal encode
that dominates wall time. Not worth the exactness risk for an unmeasurable gain.

## ENC-CASA-R3: `align: 0` → `align_of::<S>()` on `JxlPixelFormat` (2026-06-30)

**Target:** `jxl_casaencoder.rs` color + extra `JxlPixelFormat`.
**Proposed (ChatGPT pass 3 #6):** Advertise the natural sample alignment of the tightly-packed typed
slices so libjxl may use aligned-scanline assumptions.
**Rejected (no evidence):** Self-described as "benchmark-gated"; no benchmark shows libjxl reads this
field on the `AddImageFrame` copy path, and the encode is libjxl-internal-bound. Adding an unverified
micro-tweak to the hottest encode file without measurement violates the "no tunables without evidence"
rule. Left at `align: 0` (no requirement) until a measurement justifies it.

## ENC-CASA-R4: `num_extra` u32-overflow guard (2026-06-30)

**Target:** `jxl_casaencoder.rs` `num_extra = alpha_extra + frame.extra.len() as u32`.
**Proposed (ChatGPT pass 1 #5):** Guard `frame.extra.len()` against `u32::MAX` truncation.
**Rejected (theater):** Each extra channel is `width*height` borrowed samples; reaching `u32::MAX`
(~4.3 billion) extra channels would exhaust memory by ~18 orders of magnitude first. The guard protects
against a physically unreachable state and adds branch + error-variant noise to the validation path.

---

## FS-R4: hash-free metrics fast path in frame_stats (2026-06-30)

**Proposed (deferred FS-D2):** split a metrics-only entry point (alpha/luma/counts, no
8-lane FNV hash) to escape the hash's serial recurrence — the kernel's true throughput
ceiling.

**Rejected — dead code, no caller.** Caller audit (`analyze(`/`frame_stats(` across the
repo): the only production consumer is the WASM `frame_stats` export (`src/lib.rs:3316`),
which emits `frameHashInt` **and** the luma stats — it needs the hash. The only native
callers are `examples/frame_stats_flipflop.rs` and `examples/traversal_fusion_flipflop.rs`,
both of which discard the result. A hash-free native entry point would therefore be
unreachable. Adding it now is a speculative abstraction with zero offsetting benefit.
Revisit only when a real caller wants metrics without the change-id.

Note FS-R1 (deferred u64 accumulator) was the opposite outcome: it shipped as FS-D1
(branch `perf/frame-stats-u64accum-jun30-m4k2`, scalar −35%, byte-identical on corpus)
once the audit showed native has no cross-target/exact-equality consumer and the WASM
kernel is a separate f64-tracks-JS contract.

---

## CASA-ENC-R1: serial-variant `serial_encode_threads` (2026-06-30)

**Target:** `casabio_encode.rs`, the `#[cfg(not(feature = "parallel"))]` branch of
`encode_variants_cancellable` — `Encoder::new(EncodeOptions::default())`.
**Proposed (ChatGPT pass #2):** build it as `Encoder::with_threads(.., serial_encode_threads(rgba.len()/4))`
so the serial full-res encode uses libjxl-internal threads, mirroring the pyramid path.

**Rejected — cfg-dead on the only target that hits it, and not "never worse" elsewhere.**
`parallel` is a *default* feature (`default = ["parallel", "jxl-encode"]`), so this branch
is compiled out of every native build — the only consumer is the WASM
(`wasm32-unknown-unknown`, no rayon) build, where `available_parallelism()` returns `Err`
→ `serial_encode_threads` → 1 → `with_threads(.., 1)` is exactly `Encoder::new`. Zero
effect where it actually runs. On a hypothetical native-without-rayon build it would also
be *worse* for two of the three encodes: the single held `Encoder` is constructed once and
sized by the **full** pixel count, so the tiny thumb (≤300 px) and preview (≤1080 px)
encodes would run multithreaded too and pay runner overhead on images far below the
512×512 break-even — and you can't resize the runner per-encode without dropping the
encoder reuse that this branch exists to provide. Fails rule-10's "provably never worse".
The pyramid path already banks this win correctly because its full-res encode is a
*separate, post-barrier* `Encoder` distinct from the per-level fan-out.
## XYB-GATHER-R1 — 16-px gather unroll (avx2 `pixels_to_xyb_avx2`) — REJECTED (flip)

Branch `perf/xyb-gather-scalarlut-jun30-g3w7`. While exploring the XYB gather seam,
a control candidate `pixels_to_xyb_avx2_gather16` kept the three `vgatherdps` but
unrolled to 16 px/iter with two independent gather chains to expose gather-level ILP.

3-way flip (`examples/xyb_gather_flip.rs`, i7-10850H Comet Lake, 1/6/24 MP, bit-exact):
- gather16 vs gather baseline: only **+8–14%** (`1.08–1.16×`).
- scalar-LUT assembly vs same baseline: **+61–66%** (`2.6–2.9×`).

The gather unroll barely moves the needle because the bottleneck is `vgatherdps`
*throughput* on the gather execution port, not latency that ILP could hide — so adding
parallel gather chains still competes for the same port. The scalar-LUT route removes
the gathers entirely and wins decisively, so gather16 was dropped (code removed; result
kept here so the unroll is not re-attempted). The scalar-LUT kernel
(`pixels_to_xyb_avx2_scalar_lut`) is now the wired AVX2 path; the gather baseline is
retained only as the flip's A-arm + the bit-exact reference oracle.

---

## enc_group.cc — RoundtripY loop fusion (2026-07-01)

Branch `perf/enc-group-fuse-cfl-loopbound-jul01-e7g3` (libjxl-012 submodule).
Candidate from `lib/jxl/enc_group_gbench.cc` (`BM_RoundtripY_Old/New`): fuse the two
loops in `QuantizeRoundtripYBlockAC` — the `QuantizeBlockAC` quantize pass and the
separate reload-quantized + `AdjustQuantBias` + dequant reconstruct pass — into one
loop that reconstructs from the live `v` register instead of storing to `quantized+size`
and reloading it.

Byte-exact (the quantized store is still required for `SplitACCoefficients`; only the
reload is elided; verified 0 diff on both `quantized` and `coeff_recon`). But the
interleaved standalone A/B (native AVX2, clang 22) measured **new/old = 1.24–1.26 →
~25% REGRESSION**, consistent across runs. Fusing the reconstruct into the
`kBlockDim`-wide quantize loop breaks the two clean, separately-vectorized passes and
raises register pressure (`AdjustQuantBias` pulls in extra float ops + the dequant
matrix load per quantize chunk). The two-loop form lets the compiler keep each pass
tight; the reload is L1-cache-hot and cheap. **Kept the two-loop production code.** Do
not re-attempt fusion without measuring — it is a real regression, not a wash.

## enc_group.cc — AdjustQuantBlockAC DC-region loop-bound rewrite (2026-07-01)

Same branch. Candidate `BM_AdjustDCT16_Old/New`: replace the per-coefficient DC-region
skip `if (x < xsize && y < ysize) continue;` in the `AdjustQuantBlockAC` accumulation
loop with a per-row loop bound `x_begin = (y < ysize) ? xsize : 0`.

Byte-exact (identical iterations, same accumulation order → identical float sums;
verified 0 diff on `sum_of_error`/`sum_of_vals`). But the standalone A/B measured
**new/old = 1.05–1.08 → ~6% REGRESSION**, consistent across runs. The skipped region is
only `xsize*ysize` of the block (e.g. 4/256 for DCT16X16) and the branch `x < xsize` is
trivially predicted not-taken; the variable inner-loop start defeats the fixed-trip-count
codegen the compiler applies to the original loop. In production the accumulation body is
even heavier (`hfNonZeros`/`hfMaxError`/corner logic), making the branch cost even more
negligible. **Kept the per-coeff branch.** Not a win.

---

## enc_ans / dec_ans entropy-path sweep — 2026-07-01 (branch perf/enc-ans-encodetoken-writesplit-jul01-a4x7)

Reviewed the full ANS entropy pipeline (dec_ans.{h,cc}, enc_ans.{h,cc}) against a large
ChatGPT-style analysis (byte-exact wins vs video-codec/genetics speculation). Landed 4
byte-exact changes (see memory). Rejected:

- **`reverse_map_pool.assign(ANS_TAB_SIZE,0)` → `resize(ANS_TAB_SIZE)`** (enc_ans.cc:710).
  FALSE win. The pool is a *fresh* (empty) `std::vector<uint16_t>` per clustered histogram,
  so `resize(N)` value-initializes (zero-fills) N elements exactly as `assign(N,0)` — zero
  work removed. Removing the fill needs an uninitialized-resize (C++23 `resize_default_init`,
  unavailable) or a raw-buffer refactor; the pool must stay owned+movable so pointers survive
  `RemoveUnusedHistograms`. Deferred as a buffer-refactor, not a one-liner.
- **RebalanceHistogram priority-queue / heap rewrite** (replace the per-step
  `std::max_element`/`std::min_element` full scans). NOT byte-exact: `*_element` return the
  FIRST extremum; a heap changes tie-breaking → a different bin is grown on ties → different
  normalized histogram → different bitstream. The O(steps·log bins) speedup is real but
  output-changing; out of a byte-exact pass.
- **Re-cluster after HybridUint selection / exact-duplicate histogram merge / codebook
  reorder-by-temperature / near-merge.** All change the number and ordering of signalled
  histograms → different context map + bitstream. Not byte-exact. Architectural.
- **Temporal entropy-model inheritance across frames / "JXL-as-video-codec" / genetics
  (epigenetics/selection) reframing.** No JXL video/inter-frame entropy-reference profile
  exists; encoder-only warm-start is a large architectural change with no byte-exact
  guarantee. Belongs in a design doc, not this file.
- **Decoder `context_map->resize`→`assign` and `degenerate_symbols.resize`→`assign`
  stale-reuse "fix".** Not a proven bug: `ANSCode` and the `context_map` are constructed
  fresh per decode, so the single-context entry is always zero-initialized. Speculative
  defensive churn with no perf value — skipped per surgical-change policy.

---

## enc_context_map.cc — eliminate the 3rd BuildAndEncodeHistograms build (2026-07-01, branch perf/enc-ctxmap-candidate-plan-jul01-c3k7)

Proposed (ChatGPT "biggest immediate win"): `EncodeContextMap` currently builds the
raw and MTF candidates as dry runs (`writer=nullptr`) to get `ans_cost`/`mtf_cost`,
picks a winner, then calls `BuildAndEncodeHistograms` a **third** time (with a real
writer) to emit the winner — reconstructing the winner's histograms from scratch.
Proposal: build each candidate once into its own temp `BitWriter`, decide from those
costs, and emit the winner's already-serialized header via `writer->AppendUnaligned(...)`
(which does exist and is bit-continuous — enc_bit_writer.cc:127), saving one full
histogram construction.

**REJECTED — not byte-exact.** `BuildAndEncodeHistograms` returns a **writer-dependent
cost**. In writer mode several terms are written-but-uncounted, so `writer_cost <
no_writer_cost`:
- LZ77 bundle bits: `enc_ans.cc:1125-1131` — writer branch does `Bundle::Write` and
  does NOT add to `cost`; nullptr branch does `cost += CanEncode(...)`.
- `use_prefix_code` alphabet-size varlen bits: `enc_ans.cc:1003-1013` — counted via
  `size_writer` only in nullptr mode. Context maps are small (`total_tokens<100` ⇒
  `use_prefix_code` usually true), so this fires for typical context maps.
- (multi-context only) context-map bits: `enc_ans.cc:975-978` — encoded only when
  `writer!=nullptr`. N/A here (num_contexts=1) but confirms the pattern.

The OLD code decides `use_mtf` and simple-vs-entropy from **no-writer** costs. Deciding
from temp-writer costs uses a different basis: the omitted terms differ between the raw
and MTF candidates (different alphabet sizes) so they don't cancel in `mtf_cost <
ans_cost`, and they shift the `simple_cost < ans_cost` / `simple_cost < mtf_cost`
thresholds. On boundary cases this **flips the chosen representation → different (valid)
output**. Reconstructing the no-writer cost as `writer_cost + CanEncode(lz77).bits +
prefix_varlen_bits` is fragile (multiple conditional terms across the ANS/prefix split,
version-dependent) and was not pursued. A truly byte-exact version needs a plan/emit
split inside `BuildAndEncodeHistograms`/`BuildAndStoreEntropyCodes` that retains the
serialized header from the cost pass — invasive to a hot function shared across the whole
encoder (DC/AC/modular/context maps); deferred (Questions_deferred.md).

LANDED from the same file instead: byte-exact `reserve()` on the two token vectors
(capacity-only; contents/order unchanged). Single-TU compile clean (clang-cl, jxl_enc-obj
flags). enc_cluster.cc and ans_common.cc from the same ChatGPT analysis were already
implemented byte-exact on parked branches perf/enc-cluster-fuse-reindex-jun30-v8n3 and
perf/ans-common-allocfree-jun30-z7k (scratch merge-cost, no-copy/move reindex, union-find,
const-ref distribution, stack scratch, `range` not `ANS_TAB_SIZE`) — not redone.
## jxl_casadecoder.rs final-audit rejections — 2026-07-01 (branch perf/casadecoder-jxtc-runraw-jul01-d4k8)

Rejected during the "last lens" pass on `jxl_casadecoder.rs` (ChatGPT analysis was
against a STALE upload — several of its headline findings were already fixed in tree:
`Decoder::new` already reconciles `opts.parallel` with runner state; the output buffer
already skips the zero-fill on the non-partial path; the 16-bit JXTC path already uses a
zero-copy byte view, not an intermediate `Vec<u8>`).

- **Rayon `with_min_len` job-grain cap on the JXTC fan-out.** Proposed to bound
  `map_init` decoder construction to ~`current_num_threads()`. This adds a granularity
  *tunable* with no benchmark backing it; the repo rule is "no tunables without evidence",
  and the default work-splitting already reuses one `Decoder` per rayon job. The genuine
  win in that block (skip dead extra-plane decode) was captured by switching `decode` →
  `run_raw`; the `Vec<Option<_>>` intermediate was removed via `flatten()`. Not adding
  the grain knob.

- **`MaybeUninit` destination to skip the JXTC `vec![0; n]` zero-fill in strict mode.**
  Only valid if every destination byte is provably overwritten (all overlapping tiles
  succeed and the grid covers the viewport exactly once). It buys one memset on a
  bandwidth path, but needs unsafe + a coverage proof + strict-mode plumbing that doesn't
  exist. Cost/risk not justified; the current preview-shaped `vec![0; n]` is correct and
  clear.

- **Sealing the `Sample` trait.** Suggested for raw-output soundness. `Sample` is defined
  in `jxl_casaencoder.rs` (a different file, shared per spec §6), so this is a cross-file
  API change out of scope for a `jxl_casadecoder.rs` pass and is not a performance change.
  No action.

- **`Decoder::new` exact-thread refactor that changes `new()` semantics.** ChatGPT's
  `new_with_thread_count` would have made `new(parallel:true)` on a 1-core host go
  single-threaded (its `&& threads > 1` gate). To preserve `new()`'s exact behaviour the
  honest-thread-count path was added as a *separate* additive `with_threads(opts, n)`
  constructor instead; `new()` is untouched.
## DECOMPRESS-D9 — fold 4 per-pixel truncation checks into 1 — REJECTED (flip, +13%)

Branch `perf/decompress-trunc-fold-jul01-q8z`, `crates/raw-pipeline/src/decompress.rs`.
ChatGPT "basket lens" headline: the inner pixel loop checks `br.truncated` four times
per pixel (after read_bits(3), read_huff, the escape read_bits, and the literal
read_bits). Since every read is bounded (<=16 bits) and pad-safe (read_bits/read_huff
never panic/OOB on a truncated stream — they zero-pad and latch `truncated`), it is
byte-exact to run all four reads and reject ONCE before mutating carry state / emitting
the pixel. Confirmed byte-exact (golden + `decompress_old_vs_new_byteexact` on
128x96/255x64/64x255/3x257 + truncation parity).

But the 5-way `dec_variant<FOLD,HOIST>` bisect (decompress_ab_timing, 1024x1024 synthetic
xorshift stream, MSVC release, i7-10850H, rotated-start interleave, 120 iters x3) is
unambiguous and sign-stable:

  base (4 checks)          : baseline
  FOLD only (1 check)      : +11.4 .. +12.6 %  <-- REGRESSION
  HOIST only (D10)         : -1.6 .. -2.2 %
  FOLD+HOIST (the ChatGPT both-change combo): +5.4 .. +6.7 %

The four checks are LOAD-BEARING, not redundant overhead. Each `if br.truncated`
immediately after a read breaks the serial BitReader state-dependency chain
(`buf`/`nbits`/`real_in_buf`, each read consumes the previous read's `nbits -= n`),
letting the truncation bookkeeping resolve off the inter-pixel critical path. Folding
serializes all four reads back-to-back before any branch, lengthening the binding chain
on this latency-bound loop. Do not re-fold. (The pad-safety analysis is correct and is
why the fold is *byte-exact* — it is just *slower*.) Kept production at 4 checks, now
routed through the `#[cold] bitstream_exhausted()` helper (the cold attribute's
branch-layout hint is itself worth ~-2.5%, so PROD = HOIST + cold = -4.5% vs base).

Also evaluated and NOT taken from the same analysis:
- "Replace `unsafe *cur_row_ptr.add(col)` with safe `cur_row[col]`": reverting the
  existing Lens-23 raw-ptr store risks a bounds-check regression for zero upside; the
  raw-ptr write is also WHY D10's north hoist pays (it defeats CSE of north_row[col]).
- Parity / carry-state-local unroll: already rejected in-file (`parity_unroll_reject`,
  sign-unstable noise; OoO hides the [parity] spill). The D9 bisect reconfirms the loop
  is latency-bound, not branch/spill-bound.
## dec_group decode subsystem (2026-07-01, branch perf/dec-group-border-atomic-jul01-b3k9)

Context: reviewing `dec_group.cc/.h` + `dec_group_border.cc/.h` for a JXL-as-video
throughput pass. LANDED: `dec_group_border.cc` corner-atomic coalescing (byte-exact,
−44% atomic RMW ops, harness `tools/dec_group_border_ab.cc`). The proposals below,
mostly from the accompanying ChatGPT analysis, were **rejected**:

- **Rebuild the AC-occupancy sidecar from entropy `nzeros` instead of scanning the
  decoded coefficients.** The analysis's own headline ("emit the AC mask at
  `DecodeACVarBlock` time") is **wrong for the mode where the sidecar exists**:
  `ac_occupancy` is populated only in *accumulate* mode, where `DecodeACVarBlock` writes
  coefficients with `+=` across passes. A single pass's `nzeros` is therefore not the final
  occupancy (a later pass can cancel a coefficient back to zero), and the mask must be the
  *accumulated* result — which is exactly what the current post-`LoadBlock` scan of the
  real `qblock` reads. Deriving the mask from per-pass `nzeros` would be *conservative*
  (over-flags non-zero AC), changing sidecar semantics for no benefit. Rejected; keep the
  coefficient scan.

- **Consume `ac_occupancy` in `DecodeGroupFromStoredCoefficients` as it exists today.**
  Tempting (it would replace the redraw's `scan_ac_zero` loops with a mask lookup, and it
  is byte-exact *where the mask is populated*), but **unsafe as-is**: `DecodeGroupNoDraw`
  loads coefficients on hidden passes **without** populating the sidecar. A redraw that
  follows a no-draw pass would read a zero/stale mask, conclude "DC-only", and DC-fill a
  block that actually has accumulated AC → wrong pixels. Consuming the mask is only safe
  after `DecodeGroupNoDraw` also populates it (moved to Questions_deferred.md, not landed).

- **Supergroup/clustered scheduling and multi-frame pipelining as the default decode
  path.** Proposed to cut border-atomic contention by giving one worker a 2×2 group cluster
  and interleaving frame N render with frame N+1 decode. Rejected as a *default*: both
  trade load balance and cache locality for reduced handoffs and can regress on large
  frames or skewed group cost; per CLAUDE.md "adaptive/heuristic changes require benchmark
  data — do not add tunables without evidence." Legitimate only as an *adaptive* mode with
  a multi-frame benchmark behind it (recorded as deferred, not rejected outright as an
  idea — rejected only as an unconditional change).

- **Padding the border counter array to cache lines to kill false sharing.** Speculative:
  the analysis itself says "test three layouts, use profiling not intuition." Packed
  8-corner words give better locality on small CPUs; padding may help only at high core
  counts. No evidence either way here, and the atomic *count* (not layout) was the
  addressable cost — which the landed coalescing already halves. Not changed.

## enc_patch_dictionary.cc pass — 2026-07-01 (branch perf/enc-patch-subtractfrom-jul01-p4d7)

- **Connected-component "mark-on-discovery" (mark visited when pushed, not when popped).**
  ChatGPT proposed this as a byte-exact stack-churn reduction. **REJECTED — it is NOT byte-exact.**
  In the CC walk the patch's background reference (`reference`, line ~474/505) is the *first*
  background neighbor encountered during traversal, and it is subtracted from every pixel of the
  patch (`fval = opsin[c] - ref[c]`, line ~551). Mark-on-push vs mark-on-pop changes which
  duplicates exist on the stack and therefore the LIFO pop order → changes which border pixel wins
  `found_border`/`reference` → changes `ref[c]` → changes every quantized patch pixel AND the
  too_big/too_small accept/reject decision → different codestream. The set of visited pixels is
  order-independent (so bounding boxes are fine), but `reference` selection is not. Any span/CC
  rewrite must preserve first-border-neighbor selection to stay byte-exact.
- **"Fix" the int8_t narrowing before range-check (`int8_t qval = static_cast<int8_t>(val)`,
  line ~554).** ChatGPT called the out-of-range cast implementation-defined and wanted a range test
  first. **REJECTED — works as intended and changing it is a behavior risk.** The code deliberately
  casts then detects overflow via `too_big |= (val != static_cast<int>(qval))` and rejects the
  patch; wrap-around is fine because the value is thrown away. Reordering to "range-check first" is
  a semantic rewrite of a correct guard, not a perf win. (Two's-complement narrowing is also
  well-defined since C++20.)
- **Note on atlas-width crop and the `ph-2 → ph-1` seed-scan "P0 fix":** both are real observations
  but were moved to Questions_deferred.md, not rejected — they are legitimate ideas that simply are
  NOT byte-exact (they change the encoded codestream) and need an A/B size gate + a decision on
  diverging from upstream libjxl, so they don't belong in a byte-exact perf pass.

## enc_fast_lossless.cc — fast-lossless "seams" pass (jul01, branch perf/enc-fast-lossless-seams-jul01-f7k3)

- **Skip `sample_rows` when `num_rows == 0 || x_max == 0`** (proposed to avoid a
  pointless input get/release round-trip at effort 0 and for tiny/narrow groups).
  **REJECTED — NOT byte-exact.** The reference analysis claimed "the old path
  contributed no samples," but the baseline `num_rows==0` path still runs the
  predictor-warmup pass over the tiny group and its `CollectSamples` DOES feed the
  histograms. Skipping it shifts the sampled distribution → different prefix codes →
  different bitstream, and it can *worsen* ratio. **Verified by standalone fjxl A/B:**
  9/10 cases were byte-identical but `rgba8 300x257 e2` grew **49200 → 49247 bytes**
  (and the fnv hash changed). The same-geometry `rgb8 300x257 e7` stayed identical,
  which is exactly why the skip is a silent, content-dependent codestream change
  rather than a safe no-op. Reverted; the rest of the pass (align/alloc, residual
  dead-store, palette lazy-alloc, TOC-copy elision) is byte-exact.
- **CPU-detect OSXSAVE/XCR0 gate hardening** (require CPUID.1:ECX.OSXSAVE before
  trusting leaf-7 AVX2/AVX-512 bits). Real latent correctness nit, but **out of
  scope here:** it is not a perf change, it is shared upstream libjxl code
  (divergence risk), and it is effectively unreachable on any modern OS (OSXSAVE is
  always set when AVX is usable). Left untouched.
- **Free `frame_state` on the standalone `*output` allocation-failure path.** A real
  small leak, but it is in the `FJXL_STANDALONE` error path only — not the app's
  integrated build — and is a correctness/leak fix, not a perf optimization. Not
  taken in this byte-exact perf pass.

---

## enc_lz77.cc byte-exact perf pass — 2026-07-01 (branch perf/enc-lz77-byteexact-jul01-lz9k, capebio sub, off e4fbf789)

`lib/jxl/enc_lz77.cc` is the **encoder** LZ77 planner. Gate = cjxl OLD/NEW SHA-identical
(the emitted token stream must not change). The large ChatGPT/genetic analysis proposed
many changes; the ones below alter the bitstream or the cost model and were **rejected for
this pass** (they are compression/architecture changes needing their own quality gate, not
perf-neutral byte-exact wins). Landed byte-exact set is in the commit message.

- **Range-relaxed / cost-plateau optimal DP** (replace dense `dist_symbols` length expansion
  with segment-tree range-chmin over length/distance cost plateaus). Attractive against the
  Θ(n²) periodic-data case, but it explicitly recommends **fixed-point costs** and a different
  relaxation order — both change float rounding and therefore which parse wins → **NOT
  byte-exact**. The existing per-length loop + RLE-run skip (`skip_lz77`) already bounds the
  common long-run case. Deferred, not rejected outright (see Questions_deferred.md).
- **Pareto match frontier** (retain (length, distance-cost) non-dominated candidates instead of
  the `len + 2 >= best_len` filter). Changes the candidate set fed to the parser → different
  matches → **different bytes**. It is a compression-ratio change, not a perf change.
- **SymbolCostEstimator "unseen symbol = 0 cost" repair** (ragged per-context rows / pseudocount
  prior instead of the zero-filled `num_contexts * max_alphabet_size_` matrix). Even if the
  current behavior is arguably a modelling weakness, changing any cost flips parser decisions →
  **different bitstream**. Correctness/compression change, gated by cjxl ratio A/B, not this pass.
- **Remove `sym_cost` prefix array in RLE and greedy LZ77** (as done in Optimal). Rejected there:
  those two paths index `sym_cost[i + num_to_copy] - sym_cost[i]` and `sym_cost[i + len] - sym_cost[i]`
  with **non-consecutive** indices, so the prefix array is load-bearing (random access). Only the
  Optimal path uses strictly consecutive `[i+1] - [i]`, which is why the running-scalar fold is
  byte-exact there and only there.
- **Compute Optimal literal cost directly as `Bits + nbits`** (drop the running accumulator too).
  **NOT byte-exact**: `(Bits+nbits+S) - S != Bits+nbits` in float once S is large. The subtraction
  of two rounded cumulative values is exactly what must be preserved; hence the running-scalar
  keeps both `next_sym_cost` and `running_sym_cost` and subtracts them.
- **Move the stale-hash check (`val[hashpos] != hashval`) to the top of the FindMatches loop.**
  The current code inspects the first chain candidate (`chain[wpos]`) without a val check and only
  validates when advancing. Moving the check adds a guard on the first candidate → can terminate a
  chain walk one step earlier → **different matches → different bytes**. The analysis itself flags
  this as semantics-changing; left as-is.
- **Sparse hash insertion inside matched spans; conditional/detached zero-run accelerator; hash
  mixer; special-distance probe lane; co-evolution (re-price parse under its own histogram); video
  policy/temporal regulation.** All change match selection or dictionary state → **different
  bitstream**. Architecture/compression scope, deferred (Questions_deferred.md).
- **`val` int→uint16_t (15-bit hash storage, 0xFFFF sentinel).** Byte-exact and saves ~64KB per
  chain, but transient per-stream memory of marginal value; deferred to avoid touching the stale-hash
  comparison path in a pass whose main wins are elsewhere.

---

## REJECTED: decoder degenerate-histogram fast path (dec_ans) — 2026-07-02

Implemented + measured deferred item #1 (wire `ANSCode::degenerate_symbols` into
`ANSSymbolReader::ReadSymbolANSWithoutRefill` as an early-return, + `IsSingleValueAndAdvance`
via `fill_n`). **Byte-exact** (native djxl 10/10 + WASM 15/15 SHA-identical). **Dropped on
timing evidence** (branch perf/dec-ans-degenerate-fastpath-jul01-d5p2 deleted local+remote).

**Verdict: measured WASH — no win anywhere, best case included.** Definitive numbers from
**flipflopdom** (interleaved in-browser A/B with start-rotation → cancels thermal drift; the
node/native harnesses did OLD-block-then-NEW-block per file and were drift-biased):
- Video-residual corpus (degenerate-context-dense = the designed best case): geomean
  **−0.3%** (per-file −3.5%..+2.0%, no consistent direction).
- Large real photos: geomean −4.9% median but noise-inflated (stdev ±15-20%, trust:low);
  `min_ms` ~equal → floor-neutral.
- Smoking gun: `frame_000` measured **−0.1%** interleaved vs a bogus **+15%** "win" from the
  sequential node harness — every apparent win was thermal-drift bias, not the code.

Why 0%: the fast path skips real work (alias lookup + state math + renorm + prefetch) on
degenerate reads, but that saving is offset by the per-symbol `degenerate_symbols_[histo]`
load + branch added to EVERY ANS read. On WASM (the ship target) it nets to zero even where
degenerate contexts are densest; on mostly-non-degenerate real-photo decode it's a hair slower
at the median. Net: adds a hot-loop check for no benefit → not worth carrying.

★ Methodology lesson: sequential per-arm timing (time all OLD, then all NEW) is drift-biased and
manufactured a phantom 15% win here. For sub-10% deltas use INTERLEAVED A/B (flipflop/flipflopdom
with start-rotation). Test kept at .flipflop/dom-tests/dec-degenerate.mjs; journal in
docs/outputs/timing tests/flipflop/flipflopdom-journal.toon.

---

## DS-HADD: downsample_avx2 shuffle-network → hadd rewrite — measured WASH (2026-07-02)

**Target:** `crates/raw-pipeline/src/perceptual/simd/avx2.rs` `downsample_avx2` (2× box downsample, per-pyramid-level in the butteraugli comparer).
**Proposed (Questions_deferred):** replace the 8× `permutevar8x32` + 4× `permute2f128` even/odd deinterleave with 2× `hadd_ps` + 1× `permute4x64(0xD8)` per 8 output px (~12 shuffle uops → ~5).
**Implemented + verified bit-exact** (same adds, same association; 11 shapes incl. odd widths/heights, degenerate 1–2 px planes) — then **rejected on the interleaved flipflop**: +2.8% / +0.7% / **−3.6%** / +4.4% / −0.1% across 0.4–24 MP planes. The kernel is memory-bound (2 rows in, 1 row out per output row), so shuffle-port pressure is not the limiter, and the largest (24 MP) case regresses. Production keeps the shuffle network.
**Harness:** `crates/raw-pipeline/examples/downsample_hadd_flip.rs` (carries both variants + verdict).

---

## DC-XZERO: compressed_dc DequantDC 4:4:4 X-CfL-zero specialization — measured REGRESSION (2026-07-02)

**Target:** `external/libjxl-012/lib/jxl/compressed_dc.cc` `DequantDC`, 4:4:4 branch (X store `MulAdd(in_y, cfl_fac_x, in_x)`).
**Proposed (Questions_deferred, "CfL X-zero family #1"):** branch on `cfl_factors[0] == 0.0f` (the XYB default) and store `in_x` directly, dropping one FMA per X vector — sibling of the LANDED dec_group X-zero dequant.
**Implemented + proven bit-identical** (0/3.1M mismatches across cfl_x = +0 / −0 / 0.254, zero-heavy X quants; `in_x` is an int32 quant × positive factor so never −0.0) — then **rejected**: consistently −1.8% / −4.9% / −6.8% / −7.4% across interleaved runs. The DC loop is load/store-bound (3 int loads + 3 float stores per vector); the saved FMA buys nothing and the duplicated loop body costs code layout. The dec_group sibling won because the AC path is compute-denser per byte — that reasoning does NOT transfer to the DC loop.
**Record:** submodule branch `perf/compressed-dc-xzero-jul02-d8q3` (capebio) carries only `tools/dc_dequant_xzero_ab.cc` + verdict; `compressed_dc.cc` unchanged.

---

## STALE-JUL02: deferred items verified already-resolved in trunk (2026-07-02)

Closed while working the 2026-07-02 deferred batch — each was re-verified against live code and found already landed / not a bug. Future passes: skip these.

- **facade rgb8 progressive `pixelStride` (WS4-B6)** — NOT a bug: decode never produces rgb8 (`facade.ts:1` — rgb8 is encode-only, bridge fmt=3); `4*bpc` is correct on every decode path.
- **SSIM `channel_moments` fusion (perceptual perf-2)** — already landed: `Comparer::all()` derives mus/vars from the SSIM sums bit-identically (`perceptual/mod.rs:366-371`, parity test at `:629-633`).
- **LookRenderer::render per-slider-tick clone (hacker-010)** — already landed as M8: thread-local `RENDER_SCRATCH` reuse (`src/lib.rs:2256-2263`); remaining `rgb16.clone()`s are documented rare-path snapshots (full16 + unsharp only).
- **facade 6 dropped encoder options (WS4-B2)** — already wired via the `enc_create_image_z` needsZ path (`facade.ts:2150-2176`: orientation, intrinsic size, disablePerceptualHeuristics, codestreamLevel, centerX/Y).
- **Progressive manifest double-fetch race / DC byteEnd cap / tick() dirty-flag (WS5 B2/B3, C1)** — all landed (`inFlightManifestFetches` + `manifestChecked`; byteEnd from real progression events; `candidatesDirty`).
- Additional already-landed items verified by the same audit: `findValidJpegEnd` SOS walk, encode-session progressive settings forwarding, tiled-decode-worker v1 protocol, `MsgDecodeBudgetExceeded extends DecodeFrameMeta`, pipeline.rs perf-4/5/19 (clarity/NR/downscale parallelization), `f32_linear_to_srgb8` LUT, perceptual downsample ping-pong swap, `estimateSceneWhiteLms` quickselect.

---

## NOWIN-JUL02: deferred items rejected without implementation (obviously negative-EV) (2026-07-02)

Per the deferred docs' own analysis these cannot pay for their risk/effort; moved here so they stop resurfacing:

- **`ans_common` CreateFlatHistogram write-count tweak** — the doc's own verdict: "truly negligible", off every hot path; a branch + second construction path to save ≤ len/2 integer increments.
- **quantizer-inl `AdjustQuantBias` source-level reschedule** — compiler already reorders independent ops at -O2/-O3; chasing it is negative-EV; the only meaningful gate is a per-target assembly diff.
- **chroma_from_luma micro-cleanups (transactional DecodeDC, u32 GetColorFactor)** — header-decode cold path, not ms-level.
- **dec_group `RatioJPEG` hoist + compressed_dc #6 vertical chroma reuse** — JPEG-reconstruction / subsampled paths only; the RAW→XYB app pipeline is 4:4:4 and never executes them.
- **enc_modular subsampled `AddVarDCTDC` exact allocation** — 4:2:0/4:2:2 only; the app path is 4:4:4, the branch never runs.
## CR2 pass (perf/cr2-fused-crop-jul02-c2f8, 2026-07-02) — rejected items

### Eliminate the "double SOF3 parse" (cr2::parse_ljpeg_sof + ljpeg plan prepare)
Proposed (ChatGPT deep-analysis): expose an LjpegPlan handle so cr2.rs does not scan SOF3
and then have decode_tile re-parse the same headers. **Rejected — no measurable gain.**
`parse_ljpeg_sof` is a linear scan of a few marker segments (~100 bytes) before SOS;
ljpeg.rs already carries a 1-entry plan cache (jun30 z7k) so the second parse hits warm
state. Wiring a plan handle across the module boundary adds API surface for µs-scale work
in a ~150 ms decode. Timing evidence: parse_ms ≈ 0.0–0.1 ms in cr2_parity_sweep.

### In-place slice permutation (reassemble multi-slice without any second buffer)
Idea: permute the stacked slice buffer into raster order in place (cycle-walking) to reach
"zero extra buffers". **Rejected — cache-hostile and strictly worse than the shipped fused
path.** Cycle-walking a large non-contiguous permutation does irregular single-element
accesses with div/mod per step, destroys the contiguous-run copies (rows are 1728/1888 px
runs), and complicates correctness for the remainder slice. The shipped alternative
(fused reassemble+crop straight into the output Vec, branch c2f8) removes the full-raster
temp AND the separate crop pass while keeping contiguous row-run copies; measured −6.3%
whole-decode (owned) / −11.3% (warm scratch) on _MG_1750 with byte-exact parity.
### G2-F6 follow-up (2026-07-02): memory-weighted admission gate IMPLEMENTED
The concurrency-shape concern is now benchmark-justified (project-preview-concurrency-evidence:
pyramid decode ~80MB-flat scales past core count; full-res decode ~250MB/worker, flat cap of ~4
justified there but starves the cheap/thumbnail path ~2×). Shipped opt-in
`MemoryWeightedAdmissionGate` (jxl-scheduler): admission weight ∝ output bytes (decode:
expectedOutputBytes hint or targetW*targetH*4; encode: width*height*bpp), a shared byte-budget
weighted semaphore replaces the flat count cap as the concurrency limiter, and the worker
ceiling is raised (2*HWC) when the gate is on so the budget is the effective limiter. Opt-in via
`ContextOptions.memoryGate` (+ `memoryCapBytes` budget); default off = unchanged behavior.
This is DISTINCT from the still-rejected MT-routing work-class hint in G2-F6 (that concerned
`router.pick`/`shouldUseMtImmediately`, not admission). Spec:
docs/superpowers/specs/2026-07-02-memory-admission-gate-design.md; plan:
docs/superpowers/plans/2026-07-02-memory-admission-gate.md.
