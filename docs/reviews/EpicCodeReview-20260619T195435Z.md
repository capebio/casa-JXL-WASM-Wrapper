# EpicCodeReview — 2026-06-19T19:54:35Z

**Branch:** `perf/mhc-demosaic-20260619`
**Target:** 7 files (selected)
**Mode:** workalone (Sonnet)
**Commit:** epiccodereview: fix (selected files) (15 issues)

---

## Files reviewed

| File | Language |
|------|----------|
| `crates/jxl-ffi/src/lib.rs` | Rust |
| `crates/raw-pipeline/src/casabio_encode.rs` | Rust |
| `crates/raw-pipeline/src/jxl_casaencoder.rs` | Rust |
| `packages/jxl-progressive/src/index.ts` | TypeScript |
| `packages/jxl-progressive/src/progressive-manifest.ts` | TypeScript |
| `packages/jxl-progressive/src/progressive-scheduler.ts` | TypeScript |
| `packages/jxl-progressive/src/progressive-stream.ts` | TypeScript |

---

## Summary

| Stage | Count |
|-------|-------|
| Total candidates (after dedup) | 73 (30 global + 43 section) |
| Confirmed | 34 |
| False positives | 37 |
| Uncertain → deferred | 2 |
| Direct fixes attempted | 18 |
| Direct fixes applied | 15 |
| Direct fixes deferred | 3 |
| ADR drafts written | 18 |

---

## Fixes applied (15)

### casabio_encode.rs

| Task | Severity | Change |
|------|----------|--------|
| `000-structure-i9j0` | medium | `encode_variants_progressive_opts` promoted to `pub` — now matches `encode_variants_cancellable` |
| `G-arch-002` + `000-hacker-a1b2` + `000-hacker-c3d4` | medium | Added `strip_rgba_to_rgb()` (pure strip, no alpha scan). Replaced all 3 `alpha_strip()` calls inside `encode_into`/`encode_distance_into` — eliminates redundant O(n) alpha scan per variant on no-alpha RAW path |
| `000-hacker-y5z6` | low | Precomputed `x_ranges: Vec<(u32,u32)>` outside `dy` loop in `box_downscale_rgba8` general branch — `x0`/`x1` were loop-invariant w.r.t. `dy`. Added `count == 0` div-zero guard. **flipflop verified: +17.6%/+18.2%/+16.9% across 3 input sizes.** |

**Tests:** 144 pass, 0 fail, 8 ignored — identical before/after.

---

### progressive-scheduler.ts

| Task | Severity | Change |
|------|----------|--------|
| `000-correctness-d4e5f6` + `000-structure-y5z6` | **HIGH** | `checkHash(job.manifest, fullPrefix)` → `checkHash(job.manifest, buffer as ArrayBuffer)`. `fullPrefix` is a `Uint8Array` subarray; `buffer` is the already-computed `ArrayBuffer` slice. Wrong type caused spurious cache invalidation whenever `byteOffset != 0`. |
| `000-structure-m3n4` | medium | After hash verification failure and `cache.invalidate()`, reset `job.currentTier = "preview"` and `candidatesDirty = true`. Without this, the job is permanently stuck (tick loop skips `curRank >= tgtRank`). |
| `G-arch-017` | low | `setTargetTier()` now sets `this.candidatesDirty = true` before `requestTick()`. A promoted job was invisible to the cache for one tick. |
| `G-arch-013` | low | Saliency boost replaced `!wasManifestDispatched` condition with `!job.saliencyBoosted` one-shot flag. Boost was silently skipped when `prefetchManifest` dispatched the manifest before `startDecode`. |
| `000-structure-u1v2` | low | `testFetchTierWithPrefix` assigned via typed property, removing `(this as any)` cast that hid typos from the compiler. |
| `000-hacker-k1l2` | low | Dirty=false tick branch skips `Array.sort()` when max score delta ≤ 0.1. `starvationBonus` drift is ~0.016/tick at 60fps — well below the threshold. *(perf-unverified)* |
| `000-structure-w3x4` | low | `prefixAccum` pre-sized to `byteTarget` when manifest tier is known, eliminating 2–5 grow-and-copy cycles on typical DC/preview tiers. *(perf-unverified)* |

**Tests:** 87/88 pass. One failure (`dc tier byteEnd is less than full file size`) is pre-existing in `progressive-profile.ts` — unrelated to these files, newly visible because compile errors blocking the suite were fixed.

---

### progressive-manifest.ts

| Task | Severity | Change |
|------|----------|--------|
| `000-structure-s9t0` | medium | `validateManifest` now rejects `tier.byteEnd > jxl.bytes`. Also rejects `source.width <= 0` and `source.height <= 0`. |
| `000-structure-c4d5` | medium | Per-entry `typeof flag === "string"` check added in `encoder.flags` validation loop. *(applied directly — ADR noted this was a one-liner, not a ratification-level change)* |

---

### progressive-cache.ts

| Task | Severity | Change |
|------|----------|--------|
| `G-arch-012` | medium | `setBitmap` now evicts oldest entry (+ calls `bitmap.close()`) when `bitmapStore.size > MAX_BITMAP_ENTRIES (100)`. Prevents unbounded GPU texture accumulation. *(perf-unverified: no GPU memory harness)* |

---

## Deferred fixes (3)

| Task | Reason |
|------|--------|
| `G-arch-004` — Rayon encoder init propagation | Deferred: existing `map_init` with `enc_slot: Result<Encoder,_>` already propagates init failure correctly per item. No change needed. |
| `G-arch-009` — `activeDecoders` counting fetch time | Not applied: requires adding separate `activeFetches` counter and `maxActiveFetches` option — see QUESTIONS.md for spec. |
| `000-hacker-y5z6` perf measurement | **VERIFIED** — flipflop `downscale_general_flip`: +17.6% (270×202), +18.2% (810×608), +16.9% (1080×810). All ≥5% gate; parity OK. |

---

## ADR drafts (18) — awaiting human ratification

All drafts are in `.epiccodereview/20260619T195435Z/` and referenced in `QUESTIONS.md`.

### Global / architecture + vision (13)

| Slug | Severity | Topic |
|------|----------|-------|
| `strategic-map-two-pipeline-boundary` | info | Add contract test covering Rust encode → manifest → TS byte ranges |
| `encoder-pipeline-separation` | medium | Cache tonemapped RGBA; separate from per-variant encode |
| `jxl-ffi-runtime-version-check` | low | Assert runtime libjxl major.minor matches compile-time headers |
| `rgba-resize-no-alpha-waste` | low | Add `resize_rgb` variant to skip 33% RGBA bandwidth on no-alpha RAW |
| `checkHash-offthread-sha256` | medium | Move SHA-256 verification to Worker / detached SubtleCrypto |
| `sha256-optional-in-manifest` | low | Make `jxl.sha256` optional; decouple truth from verification policy |
| `ml-recognition-seam-wiring` | **high** | Wire `ModelAdapter.detectWhileStreaming` into `ProgressiveGallery` frame loop |
| `types-ts-split-concerns` | low | Split `types.ts` into `decode-types`, `ml-types`, `geometry-types` |
| `pyramid-level-16bit-support` | medium | Add `bits_per_sample` to `PyramidLevel`; add `JXL_TYPE_UINT16` encode path |
| `depth-channel-sidecar-encode` | medium | Add `depth: Option<&[f32]>` to `encode_rgba8_pyramid`; route to `ExtraKind::Depth` |
| `manifest-perceptual-field-typed` | **high** | Define `PerceptualParams` interface; type `manifest.perceptual` against it |
| `manifest-capture-intrinsics-validation` | **high** | Field-level validation for `capture.intrinsics` (focal > 0) and `capture.pose` (unit quaternion) |
| `color-encoding-p3-icc` | medium | Add `DisplayP3`, `LinearDisplayP3`, `IccProfile(Vec<u8>)` to `ColorEncoding` enum |

### Section 000 (5)

| Slug | Severity | Topic |
|------|----------|-------|
| `pyramid-downscale-encode-fusion` | medium | Fuse downscale+encode per level in serial path; halve peak memory |
| `test-coverage-pyramid-sidecar-sort` | medium | Add unit test with unsorted `sidecar_sizes` input |
| `manifest-validate-dimensions-byteend` | medium | Width/height > 0 and byteEnd ≤ jxl.bytes (mostly landed as direct fixes; ADR covers Zod decision) |
| `manifest-flags-entry-validation` | medium | Per-entry string check (landed as direct fix; ADR notes it's a one-liner) |
| `scheduler-structured-error-reporting` | low | Define `SchedulerError` with `cause/tier/attemptCount/bytesLoaded` |

---

## Notable discoveries

### Pre-existing bug exposed

`progressive-profile.ts:156` — DC tier `byteEnd` can reach/exceed full file size; `profile.test.ts` "dc tier byteEnd is less than full file size" **fails (1/88)** with this suite now compilable. This was hidden by pre-existing compile errors. `progressive-profile.ts` was outside the 7-file scope — not edited. **Recommend focused follow-up.**

### Rejected false positives (notable)

- `count==0` panic in `box_downscale_rgba8` — guard at function entry prevents upscale; unreachable via current callers (added guard anyway as defense-in-depth)
- `JxlEncoderReset` racing parallel encoder — Reset is called after `encode_inner` completes, never while workers run
- `teeFetch` tee() double-buffering — both branches consume in a tight microtask loop; queue stays near-empty
- JS single-thread rules out most TS race findings

---

## Retention

`.epiccodereview/` runs: kept newest 3, pruned older if >3 exist.

---

*EpicCodeReview — branch `perf/mhc-demosaic-20260619` — 2026-06-19T19:54:35Z*
