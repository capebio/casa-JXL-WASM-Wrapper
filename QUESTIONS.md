# EpicCodeReview — Deferred items & questions

Run: `epiccodereview/20260617T202430Z` (core decode chain, modelswitching)

> **2026-07-02 batch resolution** (see `docs/implemented improvements.md` §2026-07-02 and
> `docs/1 rejected optimizations.md` STALE-JUL02/NOWIN-JUL02 for full detail):
> - **LANDED:** facade metadata arg-shift + streaming-path metadata drop (WS4-B1);
>   progressive-decoder leak on expectedBytes OOM (WS4-B5); dng.rs read_ascii OOB guard.
> - **REJECTED (measured):** downsample_avx2 hadd rewrite (wash, DS-HADD).
> - **VERIFIED ALREADY RESOLVED — close on sight:** rgb8 progressive pixelStride (decode
>   never produces rgb8), facade B2 six encoder options (needsZ path), findValidJpegEnd,
>   tiled-decode-worker protocol, progressive-profile DC byteEnd, tick() dirty-flag,
>   manifest fetch dedup, pipeline.rs perf-4/5/19, f32_linear_to_srgb8 LUT,
>   LookRenderer clone (M8), SSIM channel_moments fusion.
>
> **2026-07-03 batch-2 resolution** (branch feat/deferred-batch2-jul03-m8x4; detail in
> `docs/implemented improvements.md` §2026-07-03 + `docs/1 rejected optimizations.md`
> AQ-RIDERS/ENT-D1-DEFER/STALE-JUL03):
> - **LANDED:** wasm128 downscale_rgba (+14.8..62.8%); MHC demosaic AVX2 (+51..54%,
>   bit-exact); decode-handler 4 test gaps closed.
> - **VIDEO MOONSHOTS LANDED:** JE-8 square atlas (enc −41..61%); JOLT rate control
>   (target-bytes/VBV, spec §3.5); `packages/casv-web` browser playback.
> - **REJECTED/DEFERRED:** enc_aq #9/#10 (dead/negligible, AQ-RIDERS); ENT-D1 filed
>   design wrong — deferred with corrected placement (ENT-D1-DEFER).
> - **VERIFIED ALREADY RESOLVED:** WS2 A1-A5 protocol wiring, frame_stats zero-pad,
>   WS4 C7 ref deep-copy, 012 node abort parity, GLUE-003 tiled-worker protocol,
>   scheduler earlyCompleteSession (completeSession correct — worker self-stops).

---

## Section 002 — jxl-core (contract package)

jxl-core itself is a clean, well-built contract package (matches its 5/5 score). One
safe local fix landed (`buffering` inline object deduped to `BufferingControls`). The
rest of the confirmed findings describe **cross-package contract debt whose fix lives in
jxl-session / jxl-worker-* , not in jxl-core** — adding/narrowing shared types from this
section would either break exhaustive consumer switches (tsc can't see them from here) or
add optional fields that nothing populates (a *worse* contract: caller passes a field that
is silently dropped). Per the fixer guardrails these are deferred to the jxl-session /
jxl-worker passes, where the producer/consumer can be wired atomically.

> Heads-up: MEMORY.md records that several of these consumer-side seams were recently fixed
> (jxl-scheduler S1/S2/S3, jxl-worker-node W-1/W-2 identity guard, decode-session). **Verify
> current consumer code before acting** — some items below may already be closed.

### A. Cross-package contract debt (fix in jxl-session / jxl-worker pass)

1. **MsgEncodeStart drops ~15 EncodeOptions fields** — `modular, brotliEffort, decodingSpeed,
   photonNoiseIso, buffering, advancedControls, jpegReconstruction, alreadyDownsampled,
   upsamplingMode, ecResampling, frameIndexing, allowExpertOptions` have no wire field, and
   `progressiveFlavor / progressiveAc / qProgressiveAc` exist on `MsgEncodeStart` but
   `encode-session.ts` never copies them → silently dropped before reaching the worker.
   Root cause + fix → ADR `encode-options-normalization-utility.md`. (Matches prior
   encode-session/types lens handoff: "~15 fields never forwarded".)

2. **Worker error codes are not in `JxlErrorCode`** — workers emit `DuplicateSession,
   UnhandledError, UnhandledRejection, WorkerError, MessageDeserializeError`; both sessions'
   `normalizeCode()` collapse anything unknown to `"Internal"`, losing the real cause. The
   wire `code` field is typed `string`, not `JxlErrorCode`, so TS never catches it
   (e.g. `spawn.ts` emits `code:"WorkerError"`). Fix = decide the canonical code set, then
   widen the union *and* the runtime `KNOWN_JXL_ERROR_CODES` Set together (cross-package).

3. **`MsgWorkerError` has no `sessionId`** (protocol.ts ~305) — a top-level worker crash
   mid-decode is not attributable to the owning session and isn't a terminal message, so
   `done()` can hang. Fix spans worker (set sessionId) + scheduler/session (route + treat as
   terminal). Check whether jxl-worker-node "crash-as-graceful-ack" fix already covers this.

4. **`DecodeFrameMeta` fields dropped by session `makeFrame`** — `sourceScale,
   progressiveSequence, passOrdinal, frameIndex, frameDuration, frameName,
   animTicksPerSecond, progressiveRegion, regionFallback` ride decode_progress/decode_final
   but never reach `DecodeFrameEvent` consumers. Fix in `decode-session.ts makeFrame`.

5. **`decode_budget_exceeded` metadata gaps** — carries no folded metrics; the node backend
   drops `region` (browser keeps it) → backend-divergent shape; it doesn't extend
   `DecodeFrameMeta` so the "best frame so far" loses progressive metadata. Fixes in
   worker(node) + decode-session.

6. **Unbounded / unsanitized error `message` strings** — only the decode path truncates;
   encode/worker paths do not. Truncation belongs in the worker handlers (out of section).

7. **`MsgDecodeError` partial-pixel fields independently optional** (protocol.ts ~142) —
   permits the invalid "pixels present but stride absent/0" state every consumer must defend
   against. A required-together union would fix it but narrows a shared type → needs a
   coordinated change with all producers/consumers.

### B. Needs product/intent decision

8. **`effort` typed `1..9` vs `allowExpertOptions` JSDoc claiming effort 10/11** (types.ts:160,
   MsgEncodeStart:185). Should expert effort 10/11 be representable? If yes, widen both the
   `EncodeOptions.effort` and `MsgEncodeStart.effort` types (+ guarded runtime check); if no,
   correct the JSDoc. Did not guess — needs intent. (Mechanism → ADR
   `numeric-invariant-checking-convention.md`.)

### C. ADR drafts written (awaiting ratification)

- `.epiccodereview/20260617T202430Z/sections/002/adr_draft/encode-options-normalization-utility.md`
  — extract a single typed `encodeOptionsToStartMsg()` mapper with an exhaustiveness guard.
- `.epiccodereview/20260617T202430Z/sections/002/adr_draft/protocol-version-handshake.md`
  — add `PROTOCOL_VERSION` constant + assert at `worker_ready` (keep fire-and-forget intact).
- `.epiccodereview/20260617T202430Z/sections/002/adr_draft/runtime-validation-at-worker-boundary.md`
  — lightweight hand guards for drift-detection (boundary is first-party, not untrusted input).
- `.epiccodereview/20260617T202430Z/sections/002/adr_draft/numeric-invariant-checking-convention.md`
  — dev-mode `assertInvariant` helper for the prose-only numeric contracts.

### D. Inspected and intentionally NOT changed (low value / speculative)

- **errors.ts `Object.setPrototypeOf` / redundant `cause` field** — no concrete failure at
  the package's `target: ES2022` (native classes; `instanceof` works; line 35 re-sets
  `cause`). Only matters if a consumer re-transpiles dist to ES5 — speculative for an ESM
  (`module: ES2022`) lib. Skipped as opportunistic.
- **protocol.ts JSDoc wording on `progressiveDc`/`groupOrder`** — cosmetic, not behavioral.
- **`src/schemas/*.json` (`additionalProperties:false` omits real fields)** — the schemas
  are currently **unconsumed** (no importer; verifier-confirmed). Fixing is low-value until
  wired; folded into the runtime-validation ADR.

### E. Verifier-uncertain (could not confirm from available code)

- `errors.ts:22` — `JxlError.partial` may hold a `DecodeFrameEvent` whose `pixels`
  ArrayBuffer was transferred/neutered; only producer uses a live buffer, no concrete detach.
- `protocol.ts:90-167` — worker→main pixel messages carry `pixelStride/outputBytes/region`
  with no bounds; OOB impact depends on consumer + a forged-message threat model.
- `protocol.ts:137-146` — free-form error `message`; info-leak depends on consumer.
- `types.ts:51-84` — `Region`/resize fields are unconstrained numbers; allocation/OOB impact
  depends on the pipeline, not the contract layer.

---

## Section 000 — crates/raw-pipeline/src/cr2.rs (RAW decode, hot path)

Applied 4 safe guard-only fixes (no valid-CR2 output change): shift-overflow guard on
precision>=16, checked arithmetic in read_ascii, checked offset derivation in MakerNote
WB extraction, and a decoded_width==stride guard (logic-21). The two items below change
valid-file output and need real CR2 files with CR2Slices interleaving to verify, so they
are deferred.

## DEFERRED 000-logic-22 — CR2 in-place crop addresses source by `stride` but bounds/centers by `decoded_width`
- File: crates/raw-pipeline/src/cr2.rs:495-518
- Why deferred: rewriting the crop to use one consistent width changes cropping geometry / output pixels and cannot be proven byte-identical without real sliced CR2 files; the new logic-21 guard now forces `decoded_width == stride` at the crop site, so the latent hazard is contained for now.
- Suggested patch: once `decoded_width == stride` is guaranteed (it now is), collapse the dual representation — use a single `row_width` variable for both source addressing (`src = (top+row)*row_width + left`) and the centering/bounds math, and add a regression fixture decoding a real CR2 (e.g. _MG_1744.CR2) asserting byte-identical raw output before/after.

## DEFERRED 000-contracts-15 — CR2 black/white levels inferred from precision magic table; white never overridden from file, larger legitimate black dropped
- File: crates/raw-pipeline/src/cr2.rs:481-488
- Why deferred: changing the (black,white) inference table, the `black_from_ifd < white` gate, or validating wb_r/wb_b ranges all directly alter rendered colour/levels for valid files and need per-camera ground truth to avoid a colour regression (user is strict on colour parity).
- Suggested patch: parse WhiteLevel IFD tag 0xC61D (DNG) / Canon-specific white from the raw IFD and prefer it over the precision-table guess; relax the black gate to `black_from_ifd < white_resolved`; clamp/validate wb_r,wb_b into a sane multiplier range (e.g. 0.25..8.0) before constructing Cr2Image. Verify against a known Canon body with stored levels.

## Section 000 — crates/raw-pipeline/src/tiff.rs (TIFF/ORF IFD parser)

Applied 8 safe guard-only fixes (no valid-ORF output change): all integer-overflow
hardening on file-controlled offsets — `parse_header` uses `data.get(0..4)` instead of a
panicking slice; `Reader::u16/u32` use `checked_add` for their span; IFD entry address
math `off + 2 + i*12` is checked in `read_ifd`, `parse_orientation`,
`parse_orientation_and_dims`, and all three Olympus sub-IFD parsers; the `abs` closure
saturates instead of wrapping; `as_rational`/`as_rational_triplet`, `extract_thumbnail_jpeg`
(`start + len`), and the MakerNote `base_off + val` / `ptr + N` offsets are all checked; and
`parse()` now validates `strip_offset + strip_byte_count <= data.len()` so callers can slice
the strip without panicking on a crafted ORF. For valid files no offset wraps and no strip is
OOB, so every byte of output is unchanged. The four items below alter output for valid files
or change a public/serde contract and are deferred.

## DEFERRED 000-contracts-4 — OrfInfo.black_level never populated from the file
- File: crates/raw-pipeline/src/tiff.rs:25-26, 236
- Why deferred: wiring `black_level` to a MakerNote/ImageProcessing tag changes the value of `OrfInfo.black_level` for valid ORFs (currently always 0); that is an output-semantics change and needs a decision on which tag is authoritative + ground-truth per-camera black levels (user is strict on colour/level parity).
- Suggested patch: read Olympus ImageProcessing BlackLevel (e.g. tag 0x0600 / per-channel) in `parse_image_processing_subifd`, store into `info.black_level`, and verify the rendered black point against a known body before relying on it; alternatively delete the dead field if no consumer needs it.

## DEFERRED 000-logic-19 — extract_largest_jpeg bounds EOI search at the next SOI
- File: crates/raw-pipeline/src/tiff.rs:66-86
- Why deferred: widening the EOI search window (or making it forward-scan past nested SOIs) can change which blob is selected as the "largest JPEG" for valid files with nested/overlapping previews, altering the emitted preview bytes — exactly the case flagged as must-not-change in the policy.
- Suggested patch: for each SOI, forward-scan for its matching EOI marker honouring nested SOI depth (or scan to `scan_end` and keep the longest SOI→EOI that is itself a well-formed JPEG), then pick the largest; add a fixture with a nested-thumbnail preview asserting the same blob is chosen for current non-nested ORFs.

## DEFERRED 000-contracts-12 — OrfMetadata flattens Option fields into sentinel scalars
- File: crates/raw-pipeline/src/tiff.rs:719-742, 749-775
- Why deferred: changing the serialized `OrfMetadata` fields to `Option<…>` (or adding presence flags) is a public-API + serde wire-format change that alters the deserialized output for every consumer and breaks round-trip with existing data; out of scope for a same-file guard-only pass.
- Suggested patch: make the ambiguous fields `Option<…>` (exposure/fnumber/focal_length tuples, focal_length_35, wb_mode) or add `has_exposure`/`has_focal35` bools mirroring `has_gps`, and update `parse_orf_metadata` to map directly from the `Option`s; coordinate with all `OrfMetadata` consumers.

## DEFERRED 000-contracts-22 — ColorMatrix 0x1011 read without an SSHORT dtype gate
- File: crates/raw-pipeline/src/tiff.rs:597-606
- Why deferred: adding a `dtype == 8` (SSHORT) / `dtype == 3` gate to the 0x1011 reader (to match the 0x0200 sibling) changes which valid ORFs populate `color_matrix`, directly affecting rendered colour — the "ColorMatrix dtype reinterpretation" case the policy says to defer.
- Suggested patch: gate 0x1011 on `cnt == 9 && (dtype == 3 || dtype == 8)` like the 0x0200 reader and decide signed-vs-unsigned interpretation per dtype; verify the colour matrix and rendered colour against a real Olympus body that stores 0x1011 before changing the gate.

## DEFERRED 000-contracts-7 — DNG BlackLevel/WhiteLevel collapsed to a single u16
- File: crates/raw-pipeline/src/dng.rs:87-88, 358-359, 483-489
- Why deferred: black_level/white_level are Option<u16> read via first_f32 (element 0 only); DNG BlackLevel can be per-CFA-channel, so honoring all channels changes subtracted black and therefore rendered colour on cameras with distinct R/G/B black — explicitly DEFER per policy.
- Suggested patch: widen RawIfd.black_level to [u16;4] (read BlackLevelRepeatDim 0xC619 + full 0xC61A array), apply per-CFA-position black in subtract_black_in_place, and verify against a real DNG that stores per-channel BlackLevel before changing output.

## DEFERRED 000-logic-11 / 000-contracts-5 — align_to_rggb never corrects column phase (Grbg/Bggr)
- File: crates/raw-pipeline/src/dng.rs:297-313
- Why deferred: fixing the col_off==1 arms changes the CFA→RGGB alignment (R<->G assignment) and thus demosaiced colour; needs real Grbg/Bggr DNGs to validate — explicitly DEFER per policy. (Currently dead code: no in-crate callers, so latent only.)
- Suggested patch: for col_off==1 crop one leading column (and row_off rows) so the returned buffer starts on the R site, adjusting width/height accordingly; validate demosaic output against real Grbg and Bggr sensors before enabling.

## DEFERRED 000-contracts-25 — AsShotNeutral not validated for finite non-zero components
- File: crates/raw-pipeline/src/dng.rs:80-85, 1052-1057 (and read_as_shot_neutral :627-661)
- Why deferred: rejecting/normalizing a degenerate neutral (0/NaN → wb≈1e6) changes the WB multipliers, which for any file the validation reclassifies alters rendered colour — DEFER since it can affect valid output.
- Suggested patch: in read_as_shot_neutral return None (not 0.0) when any of the 3 components is non-finite or <= 0, so decode_bytes falls back to neutral wb=1.0; confirm no currently-valid DNG relies on the present 0.0-then-clamp behaviour.

## DEFERRED 000-contracts-17 / 000-errors-8 — decode_bytes_demosaiced ignores rgb_write_row != height
- File: crates/raw-pipeline/src/dng.rs:1248-1251 (empty if body) and the &mut rgb[(rgb_write_row*width*3)..] slices :1303,:1319
- Why deferred: turning the silent "keep going" into a hard bail!/error could reject edge tile geometries that currently produce accepted output, and proving rgb_write_row == ah holds for every valid DNG geometry needs an output-correctness test the crate lacks — DEFER per "unsure whether valid-file output changes".
- Suggested patch: after the loop, `if rgb_write_row != ah { bail!("DNG: demosaic produced {rgb_write_row} of {ah} rows") }`, but only after validating against the real DNG corpus (incl. tiny/edge tile geometries) that valid files always reach rgb_write_row == ah.

## DEFERRED 000-performance-11 — band/ctx fully zero-filled before being overwritten
- File: crates/raw-pipeline/src/dng.rs:1220-1221 (band.fill(0)) and :1250-1251 (ctx.fill(0))
- Why deferred: cannot prove output-identical — when width % tw != 0 (and on partial edge tiles) the uncovered tail columns of band/ctx are NOT written by decode_tile, so the fill(0) supplies the values demosaic reads at the right edge; dropping/narrowing it would change edge-pixel output. Policy: apply trivial perf only if provably identical.
- Suggested patch: replace the blanket fill with clearing only the uncovered tail region (band[width*row_h .. ] is already handled by resize; clear per-row the columns >= coltiles*tw within each band row) after confirming via the real DNG corpus that right-edge pixels stay byte-identical.

## DEFERRED 000-performance-22 — per-tile output Vec allocated inside the parallel map
- File: crates/raw-pipeline/src/dng.rs:175-186 (decode_one) + collect at :189-194
- Why deferred: rated complex; eliminating the N simultaneous tile Vecs means blitting directly into disjoint `out` regions from parallel tasks (changes the threading/borrow model) and requires benchmark evidence — out of the safe trivial-perf class.
- Suggested patch: keep correctness as-is; if pursued, have each parallel task write its active rect straight into a disjoint &mut out region (split_at_mut / par chunks) instead of allocating buf then serial-blitting, and benchmark before/after on a tiled DNG.

## DEFERRED 000-contracts-11 — has_alpha detected on full-res but applied to downscaled preview/thumb buffers
- File: crates/raw-pipeline/src/casabio_encode.rs:128 (detect), 184/192/198/210/214/218 (apply)
- Why deferred: changing the channel-count decision per-buffer alters the (pixels, num_channels) contract handed to the encoder, which can change the encoded output (3ch vs 4ch) of preview/thumb. The current behavior (opaque RAW -> false -> 3ch) is the documented, intended fast path and a prior 4ch->3ch fix lives in main; re-measuring per buffer is an output-affecting change, so it is out of the SAFE scope.
- Suggested patch: compute `has_alpha` independently for each buffer that is actually encoded, e.g. in `encode_into`/`encode_variant` derive `let has_alpha = has_meaningful_alpha(pixels);` instead of threading the full-res flag in. Then drop the `has_alpha` parameter from `encode_into`/`encode_variant`/`encode_distance_into` and from the call sites (lines 184/192/198/210/214/218/523/531). VariantSet.has_alpha would report the full-res measurement (or the OR of all buffers). Needs a round-trip test that a partially-transparent source whose Lanczos3 resize introduces/loses alpha<255 still encodes the correct channel count per level. Note: opaque->opaque is already safe today, so this is a structural-coupling/drift hardening, not a live bug.

## DEFERRED 000-performance-16 — encode_variants_from_rgb16_with_progressive clones the whole RGB16 buffer when texture/clarity set
- File: crates/raw-pipeline/src/casabio_encode.rs:337-343
- Why deferred: `apply_unsharp_masks` requires `&mut [u16]` but the public fn receives `rgb16: &[u16]` (shared borrow). Avoiding the `rgb16.to_vec()` clone requires either changing the signature to take `&mut [u16]` / an owned `Vec<u16>` (caller/signature change, outside the single-file SAFE scope) or rerouting unsharp into the toned RGBA output path (changes where/how the mask is applied -> risks changing output). Per policy (clone avoidable only with a signature/caller change), defer.
- Suggested patch: add a sibling `encode_variants_from_rgb16_owned(rgb16: Vec<u16>, ...)` (or `&mut [u16]`) that applies unsharp in place with no clone, and have the Tauri ingest caller (which owns the buffer) use it; keep the `&[u16]` variant clone-on-write for borrow callers. Peak memory then drops from rgb16 + rgb16_copy + rgba to rgb16(owned, mutated) + rgba. Verify pixel parity against the current clone path.

## DEFERRED 000-contracts-14 — analyze() silently zero-pads short pixel buffer
- File: crates/raw-pipeline/src/frame_stats.rs:181-194 (zero-pad branch at :184-186)
- Why deferred: changing the short-buffer branch from zero-padding to `Err`/clamp changes behavior for truncated inputs that currently "succeed" (return stats over the declared full pixel_count). It is unconfirmed whether time-lapse callers rely on the current padded/full-count result. Changing pixel_count to the real count, or returning Result, alters the public contract and the values consumers compare across frames. Policy: DEFER unless callers are confirmed to never rely on padding.
- Suggested patch: change `analyze` to return `Result<FrameStats, _>` (or document+clamp pixel_count to pixels.len()/4) ONLY after auditing every `analyze()` caller (raw-pipeline + the wasm mirror in src/lib.rs) to confirm none feed deliberately-truncated buffers expecting full-frame stats.

## DEFERRED 000-performance-1 — truncated input forces full zero-padded heap copy
- File: crates/raw-pipeline/src/frame_stats.rs:182-186 (zero_padded alloc+memcpy at :196-201)
- Why deferred: the obvious fix (clamp px to pixels.len()/4 and skip the pad) changes the reported pixel_count and the padded-black-pixel contributions for short inputs — i.e. it changes stats OUTPUT for the truncated path (same semantics question as 000-contracts-14). The analyze_scalar bounds-clamp already applied here makes the pad unnecessary for OOB safety, but removing the pad from analyze() still alters output magnitude (no padded zero pixels) and pixel_count. Touches padding semantics → DEFER.
- Suggested patch: once the padding contract is resolved (see 000-contracts-14), drop the `zero_padded` copy and call `analyze_scalar(pixels, px)` directly (the kernel now self-clamps), OR keep full-count semantics by zero-accounting the partial tail without materializing the px*4 buffer. Requires the same caller audit before changing observable output.

## DEFERRED 000-logic-12 — luma_variance /65536 scale vs ~255^2 luma magnitude
- File: crates/raw-pipeline/src/frame_stats.rs:43-47 (constant at :46)
- Why deferred: luma weights 54/183/18 sum to 255 so l_max ~= 255*255 = 65025; variance is divided by 65536 = 256^2 (not 65025). Changing the divisor alters every reported luma_variance value — a direct OUTPUT/contract change for telemetry consumers comparing variance thresholds across frames. The /65536 is plausibly intentional fixed-point (power-of-two, cheap) scaling and is internally consistent (scalar and AVX2 use the same constant). Low severity, cosmetic-unit only. Policy: output change → DEFER.
- Suggested patch: if a clean per-channel 0..255 luma-variance unit is desired, divide by 65025.0 (255^2) instead of 65536.0, and document the unit; but only after confirming no consumer has a calibrated threshold against the current value (it would silently shift all stored/compared variances).

## DEFERRED 000-contracts-13 — frame_stats hash is endianness/lane-order dependent (DELIBERATE STABLE CONTRACT)
- File: crates/raw-pipeline/src/frame_stats.rs:19-25 (combine_lanes), per-pixel word u32::from_le_bytes at :64/:160, lane = p&7 at :65/:161
- Why deferred / DO NOT TOUCH: frameHash is a HARD consumer contract, kept stable on purpose (time-lapse batch change-detection / near-duplicate id). The little-endian word packing, 8-lane (p&7) assignment, and fixed combine_lanes fold order are exactly what makes the hash reproducible across the scalar and AVX2 paths (asserted bit-identical, test :219-229) and across producers. Adding a version field, changing endianness handling, lane count, or fold order would change the hash for identical pixels and break the documented cross-process contract. This is intentional, not a bug. Do not change the hash algorithm/representation.
- Suggested patch: none. If portability to big-endian hosts is ever required, that is a new versioned hash format (additive, opt-in) and must not alter the existing default hash for current consumers.

## DEFERRED 000-performance-2 — AVX2 luma accumulation drops to scalar f64 per-lane
- File: crates/raw-pipeline/src/frame_stats.rs:127-135 (per-chunk scalar f64 l_sum/l_sq loop)
- Why deferred: rated complex; vectorizing the per-pixel luma sum / sum-of-squares into f64x4 (or i64) lanes reduced once at the end is a SIMD micro-optimization that must not change the final l_sum/l_sq bits (scalar/AVX2 parity is asserted bit-identical at :219-229). f64 reassociation across a different accumulation order can change rounding → could break the parity test and shift mean_luma/luma_variance. The kernel is documented memory-bound, so payoff is limited. Needs benchmark evidence AND a proof of bit-identical (or accepted) results. Policy: perf/SIMD needing evidence → DEFER.
- Suggested patch: accumulate luma in i64 lanes (exact, no FP reassociation risk since inputs are integers <= 65025*8 per chunk and fit i64), reduce horizontally once at loop end, convert to f64 there; benchmark on the 2.46MP/1.05MP cases in native_bench and re-run scalar_avx2_parity before adopting.

## DEFERRED 000-performance-4 — Unsharp clarity pass is single-threaded under `parallel`
- File: crates/raw-pipeline/src/pipeline.rs:701-714
- Why deferred: adding a `#[cfg(feature="parallel")] par_chunks_mut().zip()` path is a parallelization change that needs benchmark evidence (CLAUDE.md: no tunables/perf changes without data) and must be proven bit-identical to the serial blend before adoption.
- Suggested patch: mirror the texture branch (lines 681-688) — `rgb16.par_chunks_mut(width*3).zip(blurred.par_chunks(width*3))` running the same per-element `4.0*v*(1-v)` clarity blend; keep the serial `while i < n` as the `not(parallel)` fallback; verify byte-equal output and benchmark on a 20MP frame.

## DEFERRED 000-performance-5 — apply_luminance_nr blend loop single-threaded under `parallel`
- File: crates/raw-pipeline/src/pipeline.rs:1393-1401
- Why deferred: parallelizing the lerp blend is a perf change requiring benchmark evidence; per-element `round()` ordering could differ — must be proven output-identical first.
- Suggested patch: add a `#[cfg(feature="parallel")]` `par_chunks_mut().zip(blurred.par_chunks())` variant of the lerp (round/clamp identical per-element, so output is invariant), serial fallback retained; benchmark on high-ISO 20MP frame before adopting.

## DEFERRED 000-performance-19 — rgb16 integer-factor downscale fast path not parallelized
- File: crates/raw-pipeline/src/pipeline.rs:1503-1518
- Why deferred: only the rgb16 integer fast path runs serial `for dy`; converting to `par_chunks_mut` is a parallelization change needing benchmark evidence (the per-sub-row base-index recompute is the same loop, so a no-op hoist there could be safe, but the value is the parallelism, which needs data).
- Suggested patch: route the integer-factor `for dy` loop through `out.par_chunks_mut(dw*3).enumerate()` like the rgb16 general path (line 1524) and rgb8 fast path (line 1573); prove byte-equal and benchmark the common 1800→360 (5×) thumbnail case.

## DEFERRED 000-logic-20 / 000-contracts-18 / 000-architecture-16 — apply_orientation passes through mirror/transpose 2/4/5/7
- File: crates/raw-pipeline/src/pipeline.rs:1701-1713 (and rotate helpers :1722-1814)
- Why deferred: implementing EXIF orientations 2/4/5/7 changes the emitted geometry for those valid inputs (currently silent no-op), so it is an output change for affected images — out of the SAFE bucket.
- Suggested patch: add a mirror_horizontal/mirror_vertical helper and compose 5/7 as transpose(+flip); extend the `match` to handle 2 (mirror H), 4 (mirror V), 5 (transpose), 7 (transverse), returning correctly-swapped dims; gate behind a test corpus with known-orientation files since Olympus ORF rarely uses these.

## DEFERRED 000-contracts-8 — color_matrix None collapses absent/identity/Olympus
- File: crates/raw-pipeline/src/pipeline.rs:1033-1038 (fallback repeats at :1159/:1235/:1284/:1410)
- Why deferred: changing the `unwrap_or(&CAM_TO_SRGB)` fallback semantics (e.g. None→identity, or splitting intents) changes colour output for any frame whose `color_matrix` is None — a colour-parity change the user is strict about.
- Suggested patch: distinguish the three intents at the type level (e.g. `enum ColorMatrix { Identity, Camera([[f32;3];3]), GenericOlympus }`) or require callers to pass an explicit matrix; needs cross-crate caller audit (cr2.rs/dng.rs/orf.rs set color_matrix) and user sign-off on the per-format default, since it shifts colour for DNG/Canon frames that currently get the Olympus matrix.

## DEFERRED 000-concurrency-4 — process_into_auto SIMD vs scalar tolerance boundary undocumented at parity layer
- File: crates/raw-pipeline/src/pipeline.rs:1154-1219
- Why deferred: process_into_auto routes the plain path to process_into_simd (tone_simd::apply_tone_bulk), whose output is only tolerance-equal (≤0.05 abs / <1e-3 rel) to byte-exact process_into; adding/altering the routing or tightening tolerance changes output for valid inputs and needs an end-to-end parity test + decision.
- Suggested patch: add a test asserting process_into_auto vs process_into stay within 1 LUT step end-to-end (pre-LUT→tone→post-LUT) on a representative frame, and document the tolerance contract at the dispatch site; do NOT change the routing without that guard.

## DEFERRED 000-architecture-10 — apply_look_params 12 positional f32 args
- File: crates/raw-pipeline/src/pipeline.rs:1643-1694
- Why deferred: replacing the 12 positional args with a `LookParams`/`LookDelta` struct is a public-signature/architectural refactor touching every call site (out of single-file SAFE scope).
- Suggested patch: introduce a `LookDelta { exposure_ev: Option<f32>, ... }` (or named-field struct) folded by `apply`, deprecate the positional fn, and migrate callers in lib.rs / look renderer in a dedicated change.

## DEFERRED 000-errors-24 — demosaic single-row degenerate output vs error
- File: crates/raw-pipeline/src/demosaic.rs (demosaic_bayer / demosaic_rggb; demosaic_rggb_half already errors at :796-798)
- Why deferred: demosaic_rggb_half already returns Err on degenerate (hw==0||hh==0). The finding's actual gap is that the quality/bilinear paths (demosaic_bayer, demosaic_rggb, validate() only checks zero dims) accept 1xN/Nx1 and clamp edge neighbours, yielding a degenerate-but-non-erroring image. Adding a min-dimension Err to those paths changes behavior for currently-valid 1xN inputs (the m10c test exercises 1x1/1xN/Nx1 without panic) — a valid-output/behavior change, outside SAFE scope.
- Suggested patch: introduce an opt-in `validate_min_dims(raw, w, h, min)` (or a separate strict entry point) so callers that treat sub-2 dims as invalid can request an Err, without changing the default clamping contract or breaking the m10c test.

## DEFERRED 000-contracts-24 — demosaic_rggb native-vs-wasm internal path drift
- File: crates/raw-pipeline/src/demosaic.rs:152-158
- Why deferred: on wasm32 demosaic_rggb early-returns demosaic_rggb_simd (the production SIMD kernel, fresh alloc); on native it routes through demosaic_rggb_into. This is not pure dedup: removing the wasm early-return would swap the production wasm SIMD kernel for the scalar `_into` path (perf regression / different production kernel) and the `_into` reuse contract is a separate public fn. Output is documented bit-identical; impact is low. Resolving it is an architectural decision, not a SAFE in-place fix.
- Suggested patch: if unifying is desired, make demosaic_rggb_simd write into a caller buffer (demosaic_rggb_simd_into) and have demosaic_rggb call the `_into` variant on both targets, with a documented note that wasm still uses the SIMD kernel — verify byte-identity via the existing flip-flop harness before landing.

## DEFERRED 000-contracts-23 — decode_jxl_rgba8/rgba16 return Vec<u8> with no 4-vs-8 byte type distinction
- File: crates/raw-pipeline/src/jxl_decode.rs:489-503 (was jxl_lowlevel.rs:434-495; file renamed in BSD-clean own-FFI refactor)
- Why deferred: both decoders return Option<(Vec<u8>,u32,u32)> with the bytes-per-pixel contract (4 vs 8) living only in the function name. decode_jxtc_region recomputes bpp separately from header.bits_per_sample, so a wrong-decoder / mismatched-bpp call mis-strides rows with no type error. Fixing this means a type-level signature change (e.g. distinct return types or a tagged buffer carrying bpp) touching all callers — architectural, outside single-file SAFE scope.
- Suggested patch: introduce a small `RgbaBuffer { bytes: Vec<u8>, bpp: u8, w: u32, h: u32 }` (or separate Rgba8/Rgba16 newtypes) returned by the decoders and consumed by decode_jxtc_region so bpp is carried with the buffer instead of re-derived; migrate callers in a dedicated change.

---

### Section 008 — jxl-scheduler (deferred)

**`contracts-0f5c3a02` — No runtime assertion of the one-primary-per-sourceKey invariant**
- File: `packages/jxl-scheduler/src/dedupe.ts`, lines 26–47
- Finding: `register()` silently overwrites an existing `keyToSession` entry if called twice
  for the same `sourceKey`. There is no `DEBUG` assertion or invariant-throw to catch callers
  that double-register, so a missed `complete()` / lifecycle bug in the scheduler silently
  replaces the live primary reference and orphans the original session's worker.
- Why deferred: this is an ADR opportunity (add a dev-mode `assertInvariant` guard), not a
  mechanical fix. Implementing it here would require deciding the assertion strategy
  (throw/log/no-op in production vs. dev-only) and coordinating with the broader
  numeric-invariant-checking convention (see Section 002 ADR). Out of scope for the
  single-bug direct_fix pass.
- Suggested approach: in `register()`, add `if (this.keyToSession.has(sourceKey)) { /* assert */ }`
  gated behind a `DEBUG` flag or a package-level `strictMode` option (same pattern as the
  Section 002 `assertInvariant` ADR); log or throw in dev, no-op in prod. Verify the scheduler
  never legitimately double-registers by auditing all `this.dedupe.register()` call sites in
  `scheduler.ts` (should only be called after `findPrimary` returned null).

#### dedupe.ts (continued)

#### budget.ts — Unbounded waiter queue: should acquire() have a hard cap?

**Task IDs:** `008-errors-a1f3c2d0-0016-4b11-9e21-100000000016`,
             `008-security-8f6d3e51-acbb-4e8d-9f2a-6b7c4d1e5a08`

`CoreBudget.acquire()` enqueues waiters with no upper bound. In practice the waiter count
is bounded by `sum(pool.maxSize)` across all pools sharing the budget (each live pool worker
calls acquire exactly once, and pool.maxSize is a construction-time constant). However, if
multiple JxlContext instances share `globalCoreBudget` at runtime their combined pool sizes
could grow unbounded.

**Question for design review:** Is `globalCoreBudget` intended to be shared across an
open-ended number of JxlContext/pool instances, or is the total number of pools sharing it
a fixed constant (e.g. 2-3 pools per JxlContext, 1 context per page)? If unbounded sharing
is possible, the right fix is a configurable `maxWaiters` cap on `acquire()` that rejects
(throws) when exceeded — but the value needs to come from the design (e.g. `capacity * 4`
as a reasonable sentinel). Changing it to reject without a documented cap risks breaking
legitimate MT-pool queuing under load.

**Suggested approach:** Document the intended sharing model in a JSDoc comment on
`globalCoreBudget`. If the answer is "bounded by construction," close this as won't-fix.
If unbounded, add `maxWaiters?: number` to the constructor and reject in `acquire()` when
`this.pendingCount >= maxWaiters`.

#### scheduler.ts deferrals

- `packages/jxl-scheduler/src/scheduler.ts:686,695` — signalDrain double-decrements queueDepth (covers tasks `008-concurrency-c3e8f402-9d63-4f4c-be33-50219ab3d403`, `008-logic-a1c3e7d2-0001-...`, `008-errors-a1f3c2d0-0007-...`). DEFERRED per fixer guardrail: verifiers disagreed — one confirmed an over-decrement, two could not prove a defect because the worker coalesces `worker_drain` (decode-handler.ts:152, one drain covers multiple chunks), so the strict 1:1 push↔drain invariant the finding assumes does not hold, and the per-waiter decrement at L695 is defensible under a "depth = pushes still counted toward HWM" model. Direction: do NOT change the arithmetic without a runtime trace establishing the intended invariant; if confirmed, the fix is to drop the second `bp.queueDepth = Math.max(0, bp.queueDepth - 1)` inside the resolve loop (a resolved waiter is proceeding, not drained). Needs benchmark/trace evidence before touching adaptive HWM accounting.

- `packages/jxl-scheduler/src/scheduler.ts:556-562` — promotion subscriber→primary counter assumes promotedRecord.state is final (task `008-errors-a1f3c2d0-0020-...`). DEFERRED: verifier verdict is "currently-correct-but-fragile" — the worker-transfer branch never sets `promotedRecord.state='running'` but subscribers are always created with `state:'running'`, so the L560-562 dispatch coincidentally lands correct. Not a live bug. Direction: an explicit invariant assertion (DEV-only) or normalising `promotedRecord.state` in the transfer branches before the counter dispatch — but this is hardening, not a confirmed defect, and overlaps the broader counter-reconciliation ADR (`008-logic-a1c3e7d2-0010`).

- `packages/jxl-scheduler/src/scheduler.ts:417-421` (send) / 465-466 (bufferedChunks) — per-session bufferedChunks queue is unbounded for a queued session under worker starvation (task `008-security-2e8a6f44-5c77-4b1d-9e3a-6f4b2c1d8e04`). DEFERRED: a hard cap is a behavioral policy decision, not a mechanical fix — when the cap is hit the scheduler must either drop chunks (silent data loss) or fail/error the queued session, both of which change the queued-`send()` contract that jxl-session relies on. Backpressure for queued (pre-assignment) sessions is a genuine gap but the correct layer/semantics (e.g. surface a `decode_error`/queue-overflow event vs. apply waitForDrain-style blocking to queued sessions) needs a contract decision. Direction: decide the overflow policy with the jxl-session owner, then enforce at the scheduler layer (not facade/session).

---

## Section perceptual — crates/raw-pipeline/src/perceptual/simd/avx512.rs

### DEFERRED 001-security-7 — downsample_avx512 OOB-write on unvalidated w/h/dw/dh
- File: crates/raw-pipeline/src/perceptual/simd/avx512.rs (downsample_avx512, ~L118-149)
- Why: Out of fixer scope for this file's task allotment (only pixels_to_xyb_avx512
  and scale_err_avx512 were assigned as SAFE). Same class of fix as the two applied
  (an entry debug_assert on src.len()>=w*h && dst.len()>=dw*dh && dw==(w+1)/2 && dh==(h+1)/2),
  but the dw/dh halving relation is a real precondition worth confirming against the
  caller (dn2 / dispatcher) before asserting, to avoid a false trap. Defer to a pass
  that can see the caller. Sibling downsample_avx2 has the same unenforced invariant.
- Suggested patch: at fn entry,
  `debug_assert!(src.len() >= w * h && dst.len() >= dw * dh, "downsample_avx512: src/dst shorter than dims");`
  (omit the dw/dh==halved assertion unless the caller contract is confirmed).

### DEFERRED 001-logic-2 — scale_err_avx512 f32-accumulator precision divergence vs scalar f64 oracle
- File: crates/raw-pipeline/src/perceptual/simd/avx512.rs (scale_err_avx512, ~L32/L60/L63)
- Why: This is a metric-value concern (could change reference numbers) and tail-math
  cleanup — explicitly DEFER per fixer policy. The 16-wide f32 accumulator +
  _mm512_reduce_add_ps tree reduction rounds differently from the scalar f64 sum and
  from the AVX2 path, so the three backends can disagree on large images. Any change
  here alters output values and needs ADR sign-off + AVX-512 hardware to verify (dev
  machine lacks AVX-512; parity test is skipped, only n=1000).
- Suggested patch (for review, not applied): widen accumulation to f64 (e.g. accumulate
  e2*root per-lane into an f64 running sum, or split-add the reduced f32 partials less
  often), matching the scalar oracle — but this is a deliberate accuracy/perf tradeoff,
  not a no-op, so it must not land as a "safe" fix.

---

## DEFERRED 001-logic-1 — SIMD scale_err f32 accumulator vs scalar f64 oracle
- File: crates/raw-pipeline/src/perceptual/simd/avx2.rs:38,71,86 (scale_err_avx2 `acc`)
- Why: The scalar oracle (butteraugli.rs) sums each `e2*sqrt(e2+eps)` term in f64; the AVX2 path accumulates in an f32 `_mm256` register and only widens at `hsum256`. Promoting the lane accumulator to f64 (e.g. two f64x4 accumulators or periodic reduce) CHANGES the valid-input metric value — the parity test (n=1000, rel<1e-4) passes today, and the magnitude of drift at full resolution is unverified. Out of FIXER SAFE policy (must not change valid-input metric values). Also mirrored in avx512.rs / wasm.rs — a uniform change is an architecture decision.
- Suggested patch: replace single f32 `acc` with two f64x4 accumulators (`_mm256_cvtps_pd` the term, add into f64 lanes) or periodically reduce the f32 acc into an f64 running sum; apply consistently across avx2/avx512/wasm and re-tighten the parity tolerance with a full-resolution validation.

## Section perceptual — crates/raw-pipeline/src/perceptual/simd/wasm.rs

Applied 2 safe guard-only fixes (no valid-input value change), mirroring the
established `scale_err_avx512` debug_assert pattern:
- 001-security-9: entry `debug_assert!` on `scale_err_wasm` tying the seven f32
  slices' lengths to `n` (v128_load OOB guard, debug-only, release no-op).
- 001-security-8: entry `debug_assert!` on `pixels_to_xyb_wasm` requiring
  `px.len() >= n*4` and each output plane `>= n` (get_unchecked / v128_store OOB
  guard; matters most on wasm32 where usize is 32-bit and width*height can wrap).
Verified: wasm32-unknown-unknown +simd128 build compiles clean; native
`cargo test --no-default-features --lib` stays green (104 passed, 7 ignored).
wasm intrinsics are not exercised under cargo test (module is cfg(wasm32)).

## DEFERRED 001-logic-3 — scale_err_wasm f32 v128 accumulator vs scalar f64 oracle
- File: crates/raw-pipeline/src/perceptual/simd/wasm.rs:35,51,55 (scale_err_wasm `acc`)
- Why: Same precision-divergence class as 001-logic-1 (avx2) and 001-logic-2 (avx512).
  The wasm path accumulates `e2*root` into an f32x4 v128 lane accumulator and only
  widens at `hsum` before the f64 tail. Promoting to an f64 accumulation CHANGES the
  valid-input metric value and would diverge from the avx2/avx512 siblings (which keep
  the f32 accumulator). Per fixer policy the overflow/precision change is only SAFE if
  it RESTORES scalar parity — here it would instead become a new numeric path that the
  in-tree tests cannot verify (wasm intrinsics can't run under `cargo test`; the module
  is verified only against the JS reference in Node). A uniform f32→f64 change across
  avx2/avx512/wasm is an ADR-level architecture decision, not a no-op. DEFER.
- Suggested patch: apply the same fix proposed in 001-logic-1 (two f64 lane
  accumulators, or periodic reduce of the f32 acc into an f64 running sum) consistently
  across avx2/avx512/wasm, then re-tighten the parity tolerance with a full-resolution
  validation in Node for the wasm path.

## DEFERRED 001-contracts-9 — pixels_to_xyb LUT raw `*const f32` leaks the 256-entry invariant
- File: crates/raw-pipeline/src/perceptual/simd/avx2.rs:150-188 (and avx512.rs:80-102)
- Why: `pixels_to_xyb_avx2`/`_avx512` take `lut: *const f32`, gather with u8-derived indices 0..255, and reconstruct `from_raw_parts(lut, 256)` in the tail. The 256-entry requirement is documented only in a comment. Encoding it as `&[f32; 256]` (as wasm.rs:65 already does) is a SIGNATURE CHANGE that also touches the avx512 mirror and the `sqrt_lin_lut_ptr()` caller — outside the single-file SAFE scope.
- Suggested patch: change both x86 signatures to `lut: &[f32; 256]`, drop the `from_raw_parts`, and update `xyb::sqrt_lin_lut_ptr()`/callers to pass the array reference.

## DEFERRED 001-architecture-11 — ssim_moments_avx2 is scalar; name + target_feature mislead
- File: crates/raw-pipeline/src/perceptual/simd/avx2.rs:130-148
- Why: `ssim_moments_avx2` contains no AVX2 intrinsics (a tight scalar u64 loop) yet carries `#[target_feature(enable="avx2")]` "purely for call-site uniformity". Renaming/moving it beside the scalar SSIM in ssim.rs and repointing the dispatcher is a multi-file refactor (touches mod.rs dispatch + ssim.rs) — outside single-file scope and not a correctness change.
- Suggested patch: move to ssim.rs as `ssim_moments` (drop the feature gate), and have the x86 dispatch arm call the shared scalar fn directly.

## DEFERRED 001-performance-10 — AVX2 XYB gather built from a scalar 8-iteration byte loop
- File: crates/raw-pipeline/src/perceptual/simd/avx2.rs:165-177
- Why: `pixels_to_xyb_avx2` scalar-loads 24 bytes into ri/gi/bi then issues three `_mm256_i32gather_ps`. Replacing the gather with shuffle-deinterleave + arithmetic sRGB decode (or a cache-resident LUT) is a complex perf rework that risks changing valid-input float values; flagged low-priority given documented memory-bound profiling.
- Suggested patch: benchmark a shuffle-based deinterleave that decodes sRGB arithmetically (no gather); only adopt if it both wins on the bench AND holds the <1e-6 parity tolerance.

## DEFERRED 001-contracts-5 — PSNR includes alpha channel while SSIM/butteraugli ignore it
- File: crates/raw-pipeline/src/perceptual/psnr.rs (and mod.rs:242-247 SIMD ssd_avx2)
- Why: The doc comment documents an explicit contract — "alpha included, to match the legacy JS `computePsnrVsFinal`". Dropping alpha from the MSE would change the PSNR value for every valid non-identical RGBA input (e.g. constant-alpha buffers shift ~25%). That is a MAX-value / cross-metric-contract change, which policy says to DEFER. Also requires a matching change in the SIMD path (mod.rs ssd_avx2, outside this file's scope) to keep scalar/SIMD parity.
- Suggested patch (if the cross-metric 3-channel contract is desired): iterate only the RGB bytes (skip every 4th byte) and divide sum_sq by `3 * (a.len()/4)` in BOTH psnr::psnr and the SIMD ssd path; update the doc comment and the `known_mse_matches_formula` test. Confirm with the user whether legacy-JS parity must be preserved before changing.

## DEFERRED 001-errors-8 — psnr returns +inf for two empty buffers (conflates "identical" with "no data")
- File: crates/raw-pipeline/src/perceptual/psnr.rs:12-13 (and mod.rs:243 SIMD branch)
- Why: For `a.len()==0` the loop never runs, sum_sq stays 0, and the `sum_sq==0` branch returns f32::INFINITY. Changing the empty-buffer return (e.g. to NaN) is a sentinel-contract change: the `sum_sq==0 -> INFINITY` branch is the documented "identical inputs" contract (test `identical_is_infinite`), and distinguishing empty from identical would require either a separate `a.is_empty()` check returning a different sentinel or reworking the contract. Policy classifies sentinel-contract changes as DEFER; in practice n==0 is only reachable via a zero-extent image (Comparer has no width/height>0 check).
- Suggested patch: add `if a.is_empty() { return f32::NAN; }` before the `sum_sq==0` check in psnr::psnr, and the equivalent guard in mod.rs::psnr before the SIMD `sum_sq==0` branch; OR add a `width>0 && height>0` check in `Comparer::new`. Confirm desired empty-buffer semantics (NaN vs error vs current +inf) with the user.

## DEFERRED 001-performance-2 — channel_moments recomputes per-channel sum/sum-of-squares already produced by the SSIM moment pass
- File: crates/raw-pipeline/src/perceptual/ssim.rs:94-113 (channel_moments) + mod.rs:287-293 (all)
- Why: The reuse cannot be done within ssim.rs without value-neutral fusion across two metric paths and a signature change. The SSIM sums sa[c]/saa[c] are accumulated inside ssim_with_ref (scalar) / ssim_moments_avx2 (SIMD) and consumed by finalize_ssim, then discarded — they are never returned to `all()`. Deriving mus=sa/np and vars=saa/np-mu*mu would require: (a) returning sa/saa from the ssim path (signature change), and (b) rewiring `all()` in mod.rs (out-of-target file). FIXER policy classifies signature changes and fusion-across-metrics (architecture) as DEFER. The math is provably identical (both use f64 sum/np - mu*mu), so this is a safe perf win once the plumbing is approved.
- Suggested patch: Have `ssim()`/`ssim_moments_avx2` optionally surface (sa, saa) for channels 0..3, and in `Comparer::all()` derive ChannelMoments from those instead of calling channel_moments — eliminating one full-image read. Keep channel_moments as the standalone fallback. Verify `all_matches_individual_calls` still passes within 1e-6.

## DEFERRED 001-contracts-8 — ssim_with_ref returns 0.0 for np==0 while psnr returns +inf and butteraugli returns NaN (divergent empty-input contract)
- File: crates/raw-pipeline/src/perceptual/ssim.rs:35-37 (np==0 -> 0.0)
- Why: Changing the np==0 return value is a value-changing edge-case + cross-metric contract decision. The current `0.0` guard already prevents div-by-zero/panic for empty input; it just disagrees with psnr (+inf) and butteraugli (NaN) on what "empty" means. Harmonising the three is an architecture/contract call (which sentinel: NaN, error, or current per-metric values), not a localised safety fix. Policy: value-changing + cross-metric → DEFER.
- Suggested patch: Decide a single empty-input contract (recommend NaN = "no data", reserving the existing best/worst values for genuine identical/degenerate non-empty input) and apply consistently across ssim/psnr/butteraugli; OR reject zero-extent images in Comparer::new. Confirm desired semantics with the user.

## DEFERRED 001-contracts-13 — SSIM correctness depends on an unenforced call-order pairing between ref_moments and ssim_with_ref/finalize_ssim
- File: crates/raw-pipeline/src/perceptual/ssim.rs:9-23 (ref_moments), :27-54 (ssim_with_ref), :58-83 (finalize_ssim)
- Why: Marked `complex`. The contract that ref_moments(b, np, ch) must be paired with ssim_with_ref/finalize_ssim using the same np, the same reference buffer, and a compatible ch (the AVX2 path deliberately precomputes ch=4 then finalizes wch=3, valid only because 0..3 is a prefix) is implicit and unenforced. Enforcing it requires a type/contract change (e.g. a RefMoments newtype carrying np/ch, or finalize taking np/ch from the precompute) — a signature/architecture change beyond the SAFE-task scope.
- Suggested patch: Introduce a `struct RefMoments { sb, sbb, np, ch }` returned by ref_moments and consumed by ssim_with_ref/finalize_ssim, with a debug_assert that the finalize np/wch match the precompute. Wire through Comparer fields. Verify ssim parity tests + scalar_avx2_parity remain green.

---

### Section 015 — jxl-worker-browser (deferred)

**D-015-1 — MAX_OUTPUT_BYTES_GUARD ceiling is a conservative default, not a validated policy limit**
- File: `packages/jxl-worker-browser/src/decode-handler.ts`, new constant `MAX_OUTPUT_BYTES_GUARD`
- The 1 GiB ceiling (at 1 byte/pixel minimum = ~1 billion pixels) was chosen as a clearly-generous overflow guard, not a policy resolution. If the platform legitimately needs to decode images larger than ~32K×32K, this constant must be raised. A future policy decision should align the ceiling with the actual maximum supported canvas size (which may vary by platform/browser and is not currently documented in CLAUDE.md).
- Suggested action: Document the intended maximum decode resolution in CLAUDE.md or a capabilities doc, and set `MAX_OUTPUT_BYTES_GUARD` to `maxWidth * maxHeight * maxBytesPerPixel` rather than the current conservative 1 GiB floor.

**D-015-2 — output_bytes vs copied_bytes metric semantics are inconsistent across budget paths**
- File: `packages/jxl-worker-browser/src/decode-handler.ts`, budget arms
- The progress/final budget-check-2 arms post `copied_bytes` (only when `transfer.copied`) AND let `postBudgetExceeded` post `output_bytes` (always). The codec-emitted `budget_exceeded` arm (after this fix) only posts `output_bytes` via `postBudgetExceeded`. A consumer cannot tell whether `copied_bytes` or `output_bytes` is the canonical metric for buffer size on the budget path — two names, sometimes one present, sometimes both. Consider unifying to a single `output_bytes` metric posted by `postBudgetExceeded` for all paths, and removing `copied_bytes` from the check-2 arms as well, or documenting the semantics difference explicitly.

**D-015-3 — pre-existing typecheck failures in encode-handler.ts and worker.ts**
- `encode-handler.ts:365` — `finishPromise.catch()` called on `void | Promise<void>` (introduced by another section's fix to the finish-timeout/unhandled-rejection bugs)
- `worker.ts:588` — `Location` type not found (from the worker_ready tier-handshake fix)
- These must be resolved in their respective section fix passes, not here. They do not affect decode-handler.ts typecheck correctness.

### Section 015 — jxl-worker-browser (deferred)

Single-file fixer scope: packages/jxl-worker-browser/src/encode-handler.ts. The
following pending tasks were deferred (perf/info nicety, not mirrorable without
behavior risk). All confirmed-bug tasks for this file were fixed.

## DEFERRED 015-performance-...006fa2b6c406 — onPixels allocates a wrapper object per inbound pixel chunk
- File: packages/jxl-worker-browser/src/encode-handler.ts:113-118 (onPixels)
- Why: severity=info. The encode input queue is a plain `Array<{chunk, region?} | undefined>`
  with a read index + compactQueue, NOT the decode handler's pre-allocated power-of-two
  ChunkRing. Each chunk must carry an optional `region`, so a flat `ArrayBuffer` ring (as in
  decode) cannot represent the pair without a parallel region ring or an object wrapper. The
  guardrail says fix only if mirrorable WITHOUT behavior change; converting to a paired ring is
  a structural refactor of the queue (region pairing, compaction, takeNextPixels/drain math) with
  real behavior risk and no benchmark evidence. Deferred per "else DEFER (perf nicety, not worth risk)".

## DEFERRED 015-performance-...003fa2b6c403 — takeNextPixels calls compactQueue on every drained chunk
- File: packages/jxl-worker-browser/src/encode-handler.ts:271-293 (takeNextPixels / compactQueue)
- Why: severity=low. Same root cause as above — the array+read-index queue compacts per drained
  chunk where decode's ChunkRing is O(1) shift with no compaction. Eliminating the per-chunk
  compaction means replacing the queue data structure with a ring (paired with region), the same
  structural refactor deferred above. compactQueue already uses no-alloc copyWithin and only
  compacts past index 64, so the hot-loop cost is bounded. Deferred to avoid behavior risk.

## DEFERRED 015-performance-...004fa2b6c404 — feedEncoder takes two performance.now() per loop for wait-timing
- File: packages/jxl-worker-browser/src/encode-handler.ts:295-328 (feedEncoder)
- Why: severity=info. The decode handler reuses one post-push timestamp for both push-latency and
  drain coalescing because its drain gate is driven from inside the push loop with `now` passed in.
  The encode handler's maybePostDrain() reads its own `performance.now()` (it is called without a
  timestamp argument, also from onPixels-adjacent paths). Threading a single timestamp through
  maybePostDrain would change its signature/call sites and the drain interval semantics slightly;
  micro-optimization with no benchmark evidence. Deferred per "else DEFER".

Note: 015-errors-...2c4e6a8b0c13 (feedEncoder maybePostDrain after await / drain-after-terminal)
was NOT deferred — it is already adequately guarded: feedEncoder returns early via
`if (this.isTerminal()) return;` immediately before maybePostDrain(), and maybePostDrain only
emits an advisory worker_drain (no state mutation, no terminal interaction). No change needed.

## Section perceptual — crates/raw-pipeline/src/perceptual/mod.rs

Applied 3 safe guard-only fixes (no valid-input metric-value change): 001-security-1/001-errors-3
(checked_mul overflow guard on width*height and *4 in Comparer::new), 001-concurrency-1 +
001-concurrency-2 (runtime is_x86_feature_detected! gate on BackendChoice::Force(id) via a new
resolve_forced_backend free fn, falling back avx512->avx2->scalar; the AVX-512 backends additionally
require avx2+fma since their SSIM/PSNR reuse the avx2 kernels), and 001-errors-6 (length guard in
all() so a short test buffer no longer panics OOB in channel_moments after the three metrics already
degraded to NaN). For a supported CPU on valid input, backend selection and every metric value are
unchanged. cargo test --no-default-features --lib green: 104 passed, 7 ignored incl scalar_avx2_parity.

## DEFERRED 001-contracts-1 — Comparer assumes 8-bit (0..255) RGBA, no range contract
- File: crates/raw-pipeline/src/perceptual/mod.rs:88-93
- Why: Fixing needs an API/doc contract decision. The 0..255 domain is baked into three independent constants (256-entry LUT in xyb.rs, PSNR 255.0, SSIM C1/C2). Feeding 16-bit-derived bytes yields silently meaningless scores. No runtime check can distinguish valid 8-bit from packed 16-bit without changing the signature/contract.
- Suggested: ADR — document the 0..255 invariant on Comparer::new/metric methods, or add a bit-depth parameter and parameterize the LUT/PSNR-max/SSIM-C constants.

## DEFERRED 001-contracts-3 — Metrics return bare f32 with NaN/Inf as undocumented sentinels
- File: crates/raw-pipeline/src/perceptual/mod.rs:202-251 (butteraugli/ssim/psnr/all)
- Why: f32::NAN overloads "size-mismatch error"; psnr also returns f32::INFINITY for a legitimate perfect score. Forcing callers to handle both needs a Result/Option (or newtype) return — a public API/signature change.
- Suggested: ADR — return Result<f32, MetricError> / Option<f32>, or at minimum document the sentinel semantics on each pub method.

## DEFERRED 001-contracts-2 — SSIM SIMD path hardcodes RGBA stride 4 / 3 channels vs scalar ch param
- File: crates/raw-pipeline/src/perceptual/mod.rs:221-233
- Why: ssim_moments_avx2 unconditionally uses stride 4 / channels 0..3 while scalar ssim_with_ref honors an explicit ch. Masked today: Comparer is always constructed RGBA, so no value divergence on valid input. A structural fix (plumb ch into the AVX2 entry point) is an API change; no guard applied since the divergence is unreachable under the RGBA-only construction.
- Suggested: ADR — restrict the AVX2 entry point contract to RGBA explicitly, or add a ch parameter to match the scalar contract before SSIM is wired for grayscale/RGB stride.

## DEFERRED 001-performance-1 — Comparer::all() walks the test buffer ~4 times
- File: crates/raw-pipeline/src/perceptual/mod.rs:283-289
- Why: Perf restructure (fuse XYB/SSIM/PSNR/channel-moments into one deinterleave pass). Needs benchmark data per CLAUDE.md; the doc comment already notes the fused SIMD override is deferred to a later task.
- Suggested: fused single-read kernel computing SSD + 5 SSIM moments + channel mus/vars off one test+ref read; gate on benchmark.

## DEFERRED 001-performance-3 — downsample_dispatch copies planes back into tx/ty/tb each scale
- File: crates/raw-pipeline/src/perceptual/mod.rs:196-198
- Why: Pure memory-traffic perf change (mem::swap the (tx,dx)/(ty,dy)/(tb,db) roles instead of copy_from_slice). No value change, but it restructures the downsample dataflow + scale_err read source; needs benchmark and care that scale_err_dispatch reads the right buffer.
- Suggested: ping-pong buffers (index toggle or mem::swap); benchmark before/after.

## DEFERRED 001-performance-6 — Reference pyramid clones 3 planes per level + fresh dn2 allocs
- File: crates/raw-pipeline/src/perceptual/mod.rs:97-107
- Why: One-time reference-side allocation cost (low severity). Removing the clone-into-Level / preallocating dn2 outputs is a perf restructure of the pyramid build.
- Suggested: move buffers into Level when no longer needed for the next downsample; have dn2 write into preallocated level storage.

## DEFERRED 001-performance-12 — ssim() and psnr() each stream test+ref independently
- File: crates/raw-pipeline/src/perceptual/mod.rs:221-251
- Why: Perf fusion (SSD + SSIM moments in one paired pass), compounds with perf-1. Needs benchmark.
- Suggested: single fused pass over paired RGBA bytes for both metrics in all().

## DEFERRED 001-errors-2 — Comparer::new panics (assert_eq!) on bad ref buffer instead of Result
- File: crates/raw-pipeline/src/perceptual/mod.rs:88-90
- Why: Constructor hard-panics on caller data while metric methods return NaN — inconsistent. Making it recoverable requires changing new to return Result, a public API/signature change. (The overflow root cause IS fixed via checked_mul under 001-security-1; an oversized-dims input now gets a clear panic message rather than a wrapped length.)
- Suggested: ADR — Comparer::new(...) -> Result<Self, ComparerError>; unify the bad-length convention with the metric methods.

## DEFERRED 001-architecture-8 — Comparer::new is a god-method (XYB+pyramid+blur+ssim+backend)
- File: crates/raw-pipeline/src/perceptual/mod.rs:88-142
- Why: Refactor — extract build_reference_pyramid and resolve_backend. Partially started (resolve_forced_backend extracted under 001-concurrency-1), but the full pyramid decomposition is an architecture change with no behavior delta.
- Suggested: ADR — extract build_reference_pyramid(rgba,w,h,scales) -> Vec<Level>; constructor reads as compose(pyramid, ref_moments, backend).

## DEFERRED 001-architecture-5 — AVX-512 SSIM/PSNR route through avx2 module (misplaced coupling)
- File: crates/raw-pipeline/src/perceptual/mod.rs:225-251
- Why: ssim/psnr fold Avx512 backends into the avx2 arm calling simd::avx2::ssd_avx2 / ssim_moments_avx2 (no avx512 impl exists). Results correct; relocating the byte-reduction kernels to a backend-neutral reduce submodule is an architecture change touching other files. (The runtime-safety side — avx2 must be present when an AVX-512 backend is selected — IS now guarded via resolve_forced_backend, see 001-concurrency-2.)
- Suggested: ADR — move ssd/ssim_moments into a backend-neutral module; stop naming the SSE2-width kernel "avx2".

## DEFERRED 001-contracts-6 — butteraugli() mutates tx/ty/tb scratch; call-order invariant only in a doc line
- File: crates/raw-pipeline/src/perceptual/mod.rs:202-233
- Why: Latent leaky invariant — no current bug (ssim/psnr read raw bytes + ref, not the XYB scratch). Enforcing it structurally is a design change with no value impact today.
- Suggested: ADR — give butteraugli its own scratch, or encode the call-order ordering.

## DEFERRED 001-logic-8 — butteraugli divides by hard-coded 7.0, ignoring Opts.weights
- File: crates/raw-pipeline/src/perceptual/mod.rs:210-218
- Why: 7.0 == sum of default weights [4,2,1]; the divisor is not derived from weights. Changing it to weights.iter().sum() WOULD change valid metric values for any caller supplying non-default weights — a valid-input output change. DEFER per policy (when unsure whether valid metric values change -> DEFER), even though it is arguably a normalization bug. Low real-world reach (WASM/example only pass Opts::default()).
- Suggested: divisor = self.opts.weights.iter().sum() (fallback to 7.0 when sum==0). Confirm no downstream baseline depends on the literal 7.0 before applying.

## DEFERRED 001-contracts-7 — Avx512 SSIM/PSNR contract is "whatever AVX2 does", asymmetric dispatch
- File: crates/raw-pipeline/src/perceptual/mod.rs:226-251
- Why: butteraugli has distinct avx512 arms; ssim/psnr group avx512 into the avx2 arm. Results equal by construction — no value change. Fixing the asymmetry is structural (overlaps 001-architecture-5).
- Suggested: ADR — same as architecture-5; or add a doc note that SSIM/PSNR intentionally share the 256-wide reduction across AVX2/AVX-512.

## DEFERRED 001-contracts-12 — Force(id) silently maps unknown/WasmSimd ids to Scalar
- File: crates/raw-pipeline/src/perceptual/mod.rs:109-117 (now resolve_forced_backend)
- Why: The unguarded-feature UB aspect IS fixed (001-concurrency-1). What remains is the "silent fallback is invisible" reporting — surfacing an error/warning on an invalid forced id requires the constructor to return an error/log (an API change, ties into 001-errors-2 Result return).
- Suggested: ADR — return Result or log a warning on unknown/unsupported forced ids so a typo'd bench id is visible.

## DEFERRED 001-logic-10 — reference XYB always scalar while test XYB uses SIMD backend
- File: crates/raw-pipeline/src/perceptual/mod.rs:144-167 (test) vs :93 (ref)
- Why: Reference built with scalar pixels_to_xyb; test routed through SIMD (FMA Y-channel) — injects a tiny (<tolerance) nonzero butteraugli on an identical image under a SIMD backend. Building the reference with the same backend changes valid metric values (the identical-image score shifts toward exact 0) -> valid-input output change. Also a structural change to Comparer::new.
- Suggested: ADR — route ref XYB through the same fill_*_xyb backend, or document the scalar/SIMD reference asymmetry as intentional within tolerance.

## DEFERRED 001-performance-8 — dn2 allocates a fresh output Vec on every call
- File: crates/raw-pipeline/src/perceptual/butteraugli.rs:40-43 (caller: mod.rs:102-110 Comparer::new)
- Why: Eliminating the per-call `vec![0f32; dw*dh]` requires an in-place / caller-owned-scratch variant — a signature change to the pub(crate) `dn2` plus a matching edit in Comparer::new (outside this single-file safe scope). No correctness impact (one-time reference-pyramid cost: 3 planes × 2 levels = 6 allocs per reference). Policy: DEFER signature changes / restructure.
- Suggested: add `dn2_into(src, w, h, dst: &mut Vec<f32>) -> (usize, usize)` (mirroring the existing downsample_inplace at mod.rs:293) that resizes `dst` to dw*dh and writes box-averaged samples; have Comparer::new reuse a preallocated level buffer instead of the clone-and-reassign move. Keep the 0-extent guard from 001-errors-5.

## DEFERRED 001-performance-4 — box_blur vertical pass column-walks a row-major buffer (cache anti-pattern)
- File: crates/raw-pipeline/src/perceptual/blur.rs:26-37
- Why: The vertical pass has x outer / y inner, touching tmp[y*w+x] and dst[y*w+x] with stride w (one cache line miss per step for w beyond a line). A tiled/transposed or column-block sliding-window rewrite restructures memory access and is a parallelization/perf change needing benchmark evidence; it also risks subtly changing float accumulation/output. Policy: DEFER restructure-needing-benchmark / when-unsure-output-changes. Impact is reference-build-only (3 scales, Comparer::new mod.rs:104), so one-time, not a per-test hot loop.
- Suggested: transpose tmp→a column-major scratch, run the horizontal sliding-window kernel on it, transpose back into dst; OR process columns in cache-friendly blocks (e.g. 8/16-wide column tiles) so each sliding-window step touches contiguous lines. Must prove bit-identical against scalar reference (the sliding-window add/sub order per output pixel is unchanged, only iteration order differs) and benchmark before landing.

## DEFERRED 001-performance-5 — box_blur heap-allocates tmp + dst per call with no reuse
- File: crates/raw-pipeline/src/perceptual/blur.rs:4-8
- Why: Removing the two per-call w*h f32 Vecs requires either a caller-owned scratch arena or an `_into` variant — a signature change plus a matching edit in Comparer::new (mod.rs:104), outside the single-file safe scope. No correctness impact (one-time reference-side cost: 3 separate tmp+dst allocations per reference, masks recomputed per reference not per test). Policy: DEFER signature changes.
- Suggested: add `box_blur_into(src, w, h, r, tmp: &mut Vec<f32>, dst: &mut Vec<f32>)` that resizes both scratch buffers to w*h (or early-returns when n==0) and writes the blurred plane into dst; keep the existing `box_blur` as a thin wrapper. Have Comparer::new (or the future fused per-test pass, if blur ever moves there) reuse a single tmp scratch across scales. Keep the n==0 guard already added for 001-errors-4.

### Section 010 — jxl-session (deferred)

#### DEFERRED 010-contracts-7a1c0e22-0002 + 010-logic-7a1c9e02-0003 — ~12 EncodeOptions knobs with no MsgEncodeStart wire field (cross-package)
- File: `packages/jxl-session/src/encode-session.ts` (field copy site), `packages/jxl-core/src/protocol.ts` (MsgEncodeStart), worker encode-handler(s)
- Fields missing wire representation: `modular`, `brotliEffort`, `decodingSpeed`, `photonNoiseIso`, `buffering`, `advancedControls`, `jpegReconstruction`, `alreadyDownsampled`, `upsamplingMode`, `ecResampling`, `frameIndexing`, `allowExpertOptions` (EncodeOptions types.ts:161–300).
- Why deferred: cannot forward from encode-session.ts alone — requires (1) new optional fields on MsgEncodeStart in `jxl-core/protocol.ts`, (2) copy in encode-session.ts constructor, (3) consumption in the worker encode-handler(s). Three-package coordinated change; adding wire fields to protocol.ts changes the contract surface for all encode-handler implementations.
- Suggested approach: add the fields as optional on MsgEncodeStart; encode-session copies them with the same `if (opts.x != null) (startMsg as any).x = opts.x` pattern; worker encode-handler reads and passes through to libjxl encoder options.

#### DEFERRED 010-logic-7a1c9e02-0005 + 010-errors-c9d0e1f2-0009 — abort-order asymmetry (acquire before pre-aborted check)
- File: `packages/jxl-session/src/encode-session.ts:111–136`
- Issue: On the synchronous (non-Promise) scheduler path, `initAcquire` (and thus `acquireSlot`) runs before the pre-aborted check at line 135. DecodeSessionImpl checks `abortSignal.aborted` FIRST and bails before any acquire. The `if (this.terminated) return` guard added in Fix 2 covers the async (Promise) scheduler path; the synchronous path still races.
- Why deferred: Reordering requires restructuring the constructor so the abort check runs before the `isPromiseLike` branch, and `acquirePromise` is assigned to `Promise.resolve()` in the pre-aborted case — functionally equivalent to what decode-session.ts:87–92 does. Low severity (cancelSession is expected to release the just-acquired slot), but the fix requires moving the `abortHandler` setup above the `acquirePromise` assignment block, crossing the `acquirePromise` field initialisation. Scope requires careful ordering to avoid a regression on the `acquirePromise` no-op catch (line 100).

#### DEFERRED 010-contracts-7a1c0e22-0006 — No shared EncodeOptions→MsgEncodeStart mapper (adr_draft)
- File: `packages/jxl-session/src/encode-session.ts:65–96`
- Issue: The projection is open-coded with mixed literal and ad-hoc conditional assigns and no exhaustiveness check. Finding 0001 (dropped progressive AC fields) was a direct consequence of this pattern.
- Suggested: Extract a `buildEncodeStart(id, opts): MsgEncodeStart` function (or mapper object) with a field-coverage unit test that enumerates every forwarded key. Coordinate with the 12-field wire gap above.

#### DEFERRED DS-SPREAD-01 — makeFrame conditional-spread allocates a temporary object per meta field per frame
- File: `packages/jxl-session/src/decode-session.ts` — `makeFrame()` (lines ~222–238 after section 010 fix)
- Issue: each `...(field !== undefined ? { field } : {})` spread creates a short-lived object literal (~9 per frame). The frame rate for JXL progressive is low (<30fps), so this is negligible in profiling. Collapsing to a single-result-object mutation loop over a `FRAME_META_KEYS` array would be allocation-free but changes code structure and needs a benchmark before adoption.
- Why deferred: performance micro-optimization with no benchmark evidence; current pattern is idiomatic TS.
- Suggested: build base result object, iterate `const FRAME_META_KEYS: ReadonlyArray<keyof DecodeFrameMeta> = [...]`, assign each key to result only when defined.

#### DEFERRED DS-BUDGETEXCEEDED-META-01 — MsgDecodeBudgetExceeded missing 8 of 9 DecodeFrameMeta fields
- File: `packages/jxl-core/src/protocol.ts` — `MsgDecodeBudgetExceeded` (and `decode-handler.ts` emit site)
- Issue: `MsgDecodeBudgetExceeded` only carries `region?` from `DecodeFrameMeta`; the other 8 fields (`sourceScale`, `progressiveSequence`, `passOrdinal`, `frameIndex`, `frameDuration`, `frameName`, `animTicksPerSecond`, `progressiveRegion`, `regionFallback`) are absent. After the makeFrame fix, decode-session.ts will correctly pass those fields through IF the wire message carries them — but it never will until the protocol is extended.
- Why deferred: protocol change in jxl-core (extend MsgDecodeBudgetExceeded with `extends DecodeFrameMeta`) + decode-handler.ts change to call `assignFrameMeta()` on the budget-exceeded emission. Cross-package change → defer.
- Suggested: change `MsgDecodeBudgetExceeded` to extend `DecodeFrameMeta` in protocol.ts; update decode-handler `postBudgetExceeded()` to call `assignFrameMeta(msg, state)` before posting (same pattern as `decode_progress`/`decode_final`).

#### DEFERRED DS-SINGLEPASS-SLOT-01 — worker continues decoding after local early-finish (header/single-pass mode)
- File: `packages/jxl-session/src/decode-session.ts` — `finish(info, localEarlyFinish=true)` paths
- Issue: After `completeSession()` removes the scheduler record, the worker hosting the session is still alive and continues decoding. It never receives a `decode_cancel` message. Late messages from it are discarded by the scheduler's stale-session guard (discard set), so no correctness issue, but the worker burns CPU on work nobody wants until it naturally completes.
- Constraint: `scheduler.send()` is fire-and-forget and safe to call after `completeSession()` even though the session record is removed — it will be a no-op (CLAUDE.md contract). But `completeSession()` may have already re-assigned the worker to another session; sending `decode_cancel` to a recycled worker slot would cancel the new session. The right fix is a scheduler-side "retire this worker slot without waiting for a terminal ack" path that also dispatches `decode_cancel` before re-assigning — scheduler-side change → defer.
- Suggested: Add a `Scheduler.earlyCompleteSession(sessionId)` method that (1) sends `decode_cancel` to the worker before removing the record, (2) registers the sessionId in `discardSessions` so the late terminal ack is dropped, (3) then calls `cleanupSession()`. The session would call this instead of `completeSession()` on the `localEarlyFinish` path.

---

### Section 012 — jxl-stream (deferred)

**012-contracts-abort — `fromNodeReadable` abort contract diverges from `fromReadableStream`**

- File: `packages/jxl-stream/src/node.ts` (L38–74) vs `packages/jxl-stream/src/browser.ts` (L115–121)
- Finding: On mid-stream abort, `fromNodeReadable` exits the loop via `break`, then falls through
  to `if (signal?.aborted) { await session.cancel(...); }` and **returns** `delivered` (the byte
  count up to the abort point). By contrast, `fromReadableStream` (browser) **throws** a
  `DOMException('Aborted', 'AbortError')` from `if (signal?.aborted) throw …` at the top of its
  loop, which causes the `catch` block to run `cancelBoth()` and rethrow, so callers receive a
  rejection.
- Why deferred: aligning them changes a public-API behavior — callers that `await fromNodeReadable`
  and handle a normal return on abort would break if it starts rejecting, and browser callers that
  currently catch the AbortError would break if it starts resolving with a count. Which is
  canonical (reject-on-abort, matching the Fetch/ReadableStream web convention, or resolve-with-count
  as a Node-friendly "partial delivery" model) is a product decision that needs explicit sign-off.
  The mechanical teardown bugs (racy onAbort, unhandled stream error, inconsistent abort-check
  position) are fixed in Section 012 independently of this contract question.
- Question: **Which behavior is canonical for abort mid-stream?**
  1. **Reject with AbortError** (matches browser `fromReadableStream` and web conventions) — callers
     must catch on abort to read partial `delivered`; partial byte count is lost unless surfaced
     another way (e.g. via a separate callback or error property).
  2. **Resolve with partial count** (current Node behavior) — callers can distinguish abort from
     error by checking `signal.aborted` after the await; partial bytes are visible in the return
     value without a try/catch.
  Choose one and apply it to both `fromNodeReadable` (node.ts) and verify `fromReadableStream`
  (browser.ts) matches. Update CLAUDE.md stream-layer contract docs accordingly.

### Section 012 — jxl-stream (deferred)

Fixer scope was ONE file: `packages/jxl-stream/src/browser.ts`. The following
section-012 tasks are deferred because they require editing other files (node.ts,
test files) or are test/ADR drafts. All confirmed; none masked.

#### DEFERRED 012-contracts-7d3f1a02 (high) + 012-contracts-3a91c5e7 (med) + 012-concurrency-4c8b2d88 (low) + 012-concurrency-7f1d3e99 (low) + 012-errors-a91f5e73 (low) — node.ts abort parity & teardown
- File: `packages/jxl-stream/src/node.ts` (out of scope — fixer limited to browser.ts).
- Issues: (a) `fromNodeReadable` RESOLVES on mid-stream abort while browser `fromReadableStream` REJECTS (public-surface divergence); (b) node abort check happens AFTER awaiting the chunk but BEFORE pushing (ordering differs from browser pump); (c) `onAbort` destroys readable + cancels session concurrently with pending `it.next()`/push, then the aborted-break path cancels again (double-cancel — same shape now fixed in browser via the idempotent `cancelBoth` guard); (d) `toNodeReadable` generator `finally` and the `'close'` handler can both fire `session.cancel()` (the `finally` never sets `finished=true`); (e) `readable.destroy(new Error('Aborted'))` can surface as an unhandled `'error'` event for consumers with no error handler.
- Why deferred: all in node.ts. Recommended: mirror the browser fixes — idempotent single-cancel flag shared by `onAbort` + post-loop + the generator `finally`/`'close'`; decide the abort contract (resolve vs reject) and align both pumps (this is the *browser-node-parity* root — pick one and pin it with the parity test below); use `readable.destroy()` with no error on abort (matching the maxBytes cutoff) or attach a no-op error handler.

#### DEFERRED 012-contracts-c4517f9a (med, adr_draft) — no cross-impl parity test
- File: `packages/jxl-stream/test/node.test.ts`.
- A parity table asserting identical (delivered, pushes[], closed, cancelled, resolve-vs-reject) outcomes across `fromNodeReadable` and `fromReadableStream`. This is exactly the gap that let the resolve/reject abort divergence above go unnoticed. Deferred: test-file edit + depends on first picking the unified abort contract.

#### DEFERRED 012-performance-3c1a9d42 (low, adr_draft) — no prefetch-overlap regression test
- File: `packages/jxl-stream/test/node.test.ts`.
- A test using a session whose `push()` blocks on a deferred while a flag records whether the next `reader.read()`/`it.next()` was already dispatched, locking the one-ahead overlap contract. Deferred: test-file edit. (Note: the browser-side `inflight` mirror added in this fix keeps the one-ahead prefetch intact; a regression test would guard it.)

#### DEFERRED 012-contracts-9f2a1b6d (low, adr_draft) — no 200-fallback-short-resource test
- File: `packages/jxl-stream/test/range.test.ts`.
- Test for a 200 response whose body ends DURING the skip phase (resource shorter than `start`). The browser fix now flags this via `RangeNegotiation.underDelivered`; a test should assert `underDelivered === true` and `delivered === 0`. Deferred: test-file edit.

#### DEFERRED 012-logic-e81b3f57 (info, adr_draft) — no round-trip resume-window invariant test
- File: `packages/jxl-stream/test/range.test.ts`.
- Property/round-trip test asserting `createByteRangeResumeState` + resume reconstructs exactly `[start+delivered, endExclusive)` with no gap/overlap, including the DEFAULT path (originalStart omitted, `absoluteStart` threaded). The browser fix now threads `absoluteStart` and bounds the end by `fullSize`; a generative test would lock the inclusive-range math. Deferred: test-file edit.

#### DEFERRED 012-logic-4a7d2c81 (info, adr_draft) — no resume-200-no-ETag test
- File: `packages/jxl-stream/test/range.test.ts`.
- Negative test: resume + 200 fallback + NO ETag header must fail (the version-skew guard hole). The browser fix now fails ANY 200 fallback while resuming (the `resuming` flag), regardless of ETag presence; a test should assert this rejects with `/resource changed/`. Deferred: test-file edit.

#### NOTED (already deferred by the verifier, recorded for completeness)
- 012-errors-3f1a8c20 (missing fetch timeout) — verdict UNCERTAIN; deliberate design (caller owns cancellation via signal). Not implemented.
- 012-security-1d7b3e64 (SSRF surface) — verdict UNCERTAIN; exploitability depends on untrusted-URL callers outside this layer. Not implemented.

---

## Section 014 — jxl-wasm (facade.ts + bridge.cpp)

**Environment limit:** the WASM build is Docker/emsdk-gated and CANNOT be compiled or
behaviorally tested in this environment (only `tsc` type-checks facade.ts). Therefore only
*type-checkable, additive, can't-make-worse* facade.ts fixes were applied this pass; every
ABI-coupled change and ALL bridge.cpp (C++) fixes are deferred for the user to apply **with a
real WASM build + the facade.test/vitest suite** — an un-built FFI/heap change can silently
corrupt encodes or the WASM heap.

### Applied this pass (facade.ts, tsc-gated — baseline 1 error → 0)
- Added `onMetric` to `EncoderOptions` (fixes the pre-existing `facade.ts:1942` TS error;
  `LibjxlEncoder` already reads it).
- Added `if (ptr === 0) throw` OOM guards to 4 unchecked `_malloc` sites (transcodeJpegToJxl,
  back-compat streaming push, buffered-encode pixels, sidecar dims) — matching the file's
  existing guarded pattern (L902/944/1095/1152).

### A. facade.ts ABI/contract bugs — fix surface is TS but UNTESTABLE here (apply + rebuild + test)
1. **HIGH — `encode_rgba8_with_metadata` arg-shift** (facade.ts:~340 call vs bridge.cpp:2456):
   the bridge inserts `group_order`+`resampling` after `buffering`; the facade TS call omits both,
   shifting ALL ICC/EXIF/XMP pointer args by 2 on the buffered-metadata encode path → metadata
   corruption. Fix = add the 2 args in the correct ABI position; rebuild + round-trip ICC+EXIF.
2. **HIGH — 6 encoder options dropped by the facade** (`orientation, intrinsicSize,
   disablePerceptualHeuristics, codestreamLevel, centerX, centerY`): callers forward them and the
   bridge supports them (`enc_create_image_z`:3019 + setters), but `EncoderOptions` (facade.ts:137)
   declares none and never calls the setters → silent no-ops.
3. **MED (latent) — ExtraChannel struct stride mismatch**: TS serializer 72-byte stride vs 20-byte
   C++ `WasmExtraChannel`. No call site yet (latent) — corrupts `num_ec >= 2` encodes once wired.
4. **MED — `perceptualConstancyApplyBulk` scalar fallback returns identity** (facade.ts:~3152):
   copies input→output, reports success, never applies the transform; also passes JS Float32Arrays
   where the C symbol wants `float*`. NOTE: `_perceptual_apply_full` is not linked in the default
   WASM build (MEMORY: "c-perceptual link-fails wasm") — fix the link first.
5. **MED — leaks on throw**: progressive decoder handle (facade.ts:1377) + `wasmEncState`
   (facade.ts:2074) leak if a malloc/alloc throws before the owning try/finally. Hoist into scope.
6. **MED — rgb8 progressive pixelStride**: `eventsProgressive` uses a 4-byte stride for rgb8
   (3-channel) (facade.ts:~1435) → byte-total mismatch (the long-rumored "rgb8 stats" issue,
   located here → ADR adr-shared-channel-stride-helper).
7. **LOW — hot-path `console.log` spam** (facade.ts:968/1171/2289) — redundant with `onMetric`.

### B. bridge.cpp — C++, CANNOT build here, ALL deferred (by severity)
1. **HIGH/security — JXTC encode integer overflow** (bridge.cpp:1611/1618): `tile_count =
   tiles_x*tiles_y` 32-bit multiply can wrap; the loop writes `tile_bytes[idx]` at the un-wrapped
   index → heap overflow. (The JXTC *decode* counterpart at 1713 was a verified FALSE POSITIVE —
   its `idx >= tile_count` guard + `input_size < header+index_bytes` check bound every index read.)
   **→ PATCHED IN SOURCE (commit on this branch):** compute `tiles_x*tiles_y` in 64-bit, reject when
   0 or `> JXTC_MAX_TILES` (2^24) before allocating, narrow to uint32 only once safe. **NOT yet
   build-verified** — bridge.cpp can't be compiled here; rebuild WASM + run the jxl-wasm suite to
   confirm (the guard is additive and rejects only the overflow case, so valid encodes are unaffected).
2. **MED/security — unvalidated FFI lengths**: extra-channel `plane_ptr/size` (1022), custom-box
   `data_ptr/size` (356), rgb16_planar planes (2404), butteraugli/PSNR/SSIM direct pointers (3377),
   `EncodeAnimation` `wf.width*wf.height` with no `pixels_size` check (1884) + unbounded `name_size`
   memcpy (1906).
3. **MED — gain-map `gm_capacity*2u`** doubling has no overflow guard (2311); sibling `input_buf` IS guarded.
4. **LOW — tiled-decode signed `crop_x0/y0` cast to uint32** (1403) → crafted-JXL OOB read.
5. **LOW — unhandled `JxlDecoderStatus`** (no default branch, 2143) → spin; `BOX_NEED_MORE_OUTPUT` bare continue (2311).
6. **LOW/perf — `EM_ASM console.log`** per encode chunk (2918) / per `enc_finish` (3102).

### C. ADR drafts (sections/014/adr_draft/) — awaiting ratification
- adr-ffi-abi-contract-test.md — CI smoke test: every facade-called symbol exists w/ right arity +
  single source of truth for the FFI layout (root cause of A1/A2/A3).
- adr-overflow-checked-size-helpers.md — `checked_size_mul` (bridge.cpp) + `assertHeapWrite` (facade.ts) (B1/B2/B3).
- adr-structured-libjxl-error-mapping-raii.md — status→typed-error map + RAII C++ cleanup + missing `default:`.
- adr-shared-channel-stride-helper.md — single `pixelLayout(format)` helper (fixes A6).

---

# EpicCodeReview run 20260619T093126Z — src/lib.rs

Target: src/lib.rs (2842 lines, Rust/WASM). Mode: workalone. Branch: epiccodereview/20260619T093126Z.
Confirmed findings: 37 (section) + 25 (global). Applied: 4 safe guards (commit a5a2c5d7). Rest deferred below.
Full detail: .epiccodereview/20260619T093126Z/{sections/000,global}/verified.json

## A. Needs a human decision (public-API / output-contract / intent — no-go for auto-fix)

1. FLAG COLLISION — `OUT_FULL_16 == OUT_NO_ORIENT == 8` (src/lib.rs:551,556). Independently flagged by 4 agents. Any caller setting bit 8 gets full-res-16 AND orientation suppressed; cannot request one independently. One verifier read the adjacent comment as "load-bearing by design (undocumented)"; others rate it critical. DECISION: intentional? If not, move OUT_NO_ORIENT to a free bit (e.g. 16) — but that changes a JS-visible flag value (ABI) and needs your sign-off + a JS-side update.
2. DNG/CR2 exposure-time absent sentinel `den=1` vs ORF `den=0` (JS checks `den==0`). Visible to JS. Confirm desired sentinel.
3. `color_matrix_from_mn` is always true for DNG (dng.rs supplies a default ColorMatrix) — misleads JS vs ORF. Confirm intended semantics / rename.
4. `input_ptr` / `take_*` ownership + invalidation contract undocumented (structure-015). Doc-only, but it is a public contract.

## B. Perf-sensitive — MEASURE before applying (gate: >=5% + output parity)
Repo flipflop benchmarks kernels in isolation, not these WASM export paths; each needs a kernel flipflop or a new bench first:
- ORF double demosaic (planar + MHC always; MHC dropped on preview-only) — hacker-001 / architecture-004,006 / structure-003,010
- pack_rgb16_full redundant full-res pass; fuse or LE-transmute — hacker-002 / architecture-011
- unpack_rgb16_le 12MB copy per LookRenderer ctor; LE-transmute — hacker-003 / architecture-003
- rgb_to_rgba scalar 3->4 scatter; wasm128 shuffle — hacker-004 / architecture-013
- ORF thumb from full planar vs cascade from lightbox (DNG already cascades) — hacker-005 / architecture-005
- integer downscale: 3 divides/pixel -> reciprocal-multiply — hacker-006
- float downscale recomputes x-bounds per (dy,dx) -> hoist — hacker-007
- downscale_rgb16_planar SoA SIMD horizontal-add — hacker-008
- LookRenderer::render clones ~13MB per slider tick -> reusable scratch — hacker-010 / architecture-007
- fs_core_simd re-reads 16 bytes already in v128 -> extract_lane — hacker-012
- fs_core_trunc_word per-pixel checks -> fast/tail split — hacker-013

## C. Structural opportunities (ADR-worthy; not auto-edited)
- 14-16 positional f32 params per export -> params struct (structure-011)
- bench exports (fstats_*) ship ungated in production WASM -> feature-gate (structure-013)
- DngDecoded == Cr2Decoded; unify (structure-019)
- MAX_DIM 16384 (ORF) vs 8192 (DNG/CR2) inconsistent (structure-002)
- NR not applied to planar preview; previews noisier at high ISO (structure-023)
- tonemap dispatch: ORF process_into_auto vs DNG process_auto (structure-005)
- duplicated integer box-filter impls (structure-006)
- ~360MB WASM heap at 24MP all-flags; no memory budget (architecture-014, P7)
- ProcessResult couples pixels+telemetry; rgb()/rgba() double-copy (architecture-007,009)
- only 2 tests for 2842 lines; no flag/downscaler/LookRenderer/PerceptualComparer coverage (structure-020)

## D. Vision (long-horizon ADR drafts)
ML recognition entry (thumb+GPS already present); photogrammetry linear-16 contract + sensor-pitch for COLMAP; AR <15ms preview + crop-render ROI; gaming LOD via OpaqueDecodeHandle; multi-frame stacking; non-Riemannian Perceptual Constancy Mode hook (pipeline.rs already has perceptual_constancy + log-euclidean; LookOverrides lacks the field — vision-nonriemannian01). Sample draft: .epiccodereview/20260619T093126Z/global/adr_draft/0001-output-flag-gated-decode.md

### RESOLVED — run 20260619T093126Z §A.1 (flag collision)
OUT_FULL_16 vs OUT_NO_ORIENT (both =8): determined ACCIDENTAL via git (b2cb8dc9 2026-06-03 vs 1674aa11 2026-06-08, independent additions) + no caller sets bit 8 (raw-backend uses process_orf=7; OUT_FULL_16 is v1 test/synthetic only). Fixed: OUT_NO_ORIENT -> 16. Private consts, no ABI change. Commit follows on branch epiccodereview/20260619T093126Z.

---

# EpicCodeReview 20260619T124908Z (facade.ts, bridge.cpp, backends.ts, 2× .flipflop)

FIXED this run: EC descriptor stride drift (72B writer vs 20B C++ struct → multi-extra-channel heap corruption). Commit f6821bb1. See EpicCodeReview-20260619T124908Z.md.

## Needs WASM rebuild to verify (bridge.cpp) — Phase-6 territory
1. Butteraugli ref deep-copy per compare (bridge.cpp:3509-3519, HIGH perf). `...InPlace` consumes args → full 3-plane memcpy of ref every pass; use non-consuming `ButteraugliInterface(const Image3F&,…)` (butteraugli.h:80). Flipflop after rebuild. **Bundle into Phase-6 decode-resident rebuild?**
2. JXTC `tile_count` 32-bit overflow (bridge.cpp:1724, MED/security). `tiles_x*tiles_y` uint32 on attacker-controlled header; encode path guards uint64 (1624-1630). Mirror the guard.
3. `ssim_block_luma` two-pass per block (bridge.cpp:3571, MED perf). Fuse mean+variance to one pass.

## Flipflop-gated TS perf (low expected value — buffer-copy axis measured = noise)
4. `ButteraugliComparator.compare` per-call malloc/free of constant-size candidate (facade.ts:748) → grow-only slot.
5. No `SsimComparator`; `computeSsimWasm`/PSNR re-malloc+copy the fixed ref every pass (facade.ts:689,816).

## Correctness, testable — not yet fixed
6. **JPEG-end scanner rejects real JPEGs** (facade.ts:2740). `findValidJpegEnd` bails at SOS (0xDA) → `extractJpegReconstructionFromJxl` returns null for all genuine embedded JPEGs. Fix marker walk (SOS→entropy→EOI) + unit test. **Recommended next fix** (no rebuild).

## Policy / calibration (human)
7. `SSIM_CONVERGED=0.9995` build-dependent (backends.ts:216): calibrated to ssim.js, loaded build may use WASM SSIM (~1-2% off) → `convergedByteEnd` shifts. Recalibrate to WASM scale, or keep ssim.js for the gate? Needs your intent.
8. `deferredRelease` 1080p hard cap + transfer-detach footgun (facade.ts:1411-1447). Opt-in, no prod caller. Grow + document no-transfer, or leave until a caller needs it?

## Architecture ADR-drafts (ratify before building)
9. Decode-resident metric (zero-copy SSIM/Butteraugli on the decoder heap buffer) — see docs/SSIM-buffer-engine-flipflop-spec-2026-06-19.md.
10. Separate measurement pipeline from render/transfer decode path (P2).
11. Pool decoders in profiler / source ref from progressive `final` event (drop 2nd full decode).

## Vision ADR-drafts (aspirational)
12. Interleaved-RGBA perceptual-constancy entry on decoder output (engine exposed via `perceptualConstancyApplyBulk`, but planar-SoA only).
13. Emit perceptual-hash/recognition features from already-decoded qualityCurve pixels (organism ID).
14. Populate `getDecodeGridInfo()` ({} today) for LOD/streaming; produce `DecodedExtraChannel` (depth/selection).

## Uncertain — could not resolve from in-scope code
- `take_flushed` borrowed-view lifetime (bridge.cpp:2361): caller copies before yield — safe today, contract comment-only.
- Decoder cancel()/dispose() free WASM state only in generator `finally` (facade.ts:1876): leak only if a consumer abandons the iterator undrained — does any?
- jxtc `prep()` caches a rejected promise permanently (.flipflop/tests/jxtc-vs-full-decode.mjs:70) — transient first-file failure poisons the run. Intended?
- Encoder pending-push error lost on cancel; SSIM length-guard silently skips a pass's metric — gated on out-of-scope session/decoder behavior.

### FALSE POSITIVE worth recording
"Perceptual-Constancy engine completely unexposed" — WRONG. `perceptualConstancyApplyBulk` + `getPerceptualConstancySupport` already exist (facade.ts:3120/3136, also in dist). Engine IS exposed; only the interleaved-RGBA convenience entry is missing (#12).

---

## EpicCodeReview 20260619T130214Z — raw-pipeline parsers/decoders

Target: `tiff.rs cr2.rs dng.rs ljpeg.rs decompress.rs demosaic.rs`. 61 findings → 56 confirmed / 5 false-positive / 0 uncertain. 13 correctness issues fixed + committed (782a28b8). Remaining = opportunities deferred for ratification (no-go: public-signature/cross-file/platform). Full proposals: `.epiccodereview/20260619T130214Z/global/adr_draft/ADR-drafts.md`.

**Deferred ADR drafts (need owner decision):**
1. **ADR-1** Shared bounded TIFF/IFD value reader — consolidate the read_u16/u32/ascii/IFD-walk triplication across tiff/cr2/dng (root cause of the bounds-drift we hand-patched). Proceed?
2. **ADR-2** Unified `RawError` enum replacing anyhow/String/bail mix at the decode seam.
3. **ADR-3 (HIGH, platform)** Calibrated scene-referred `RawImageMeta` — currently drops black/white/iso/bits and collapses camera→XYZ to sRGB at decode (dng.rs:113-123); add a "linear, not-tone-mapped" mode + re-enable CR2 per-model colour matrix (cr2.rs:228-240). Public struct change → needs sign-off. See [[project-non-riemannian-colour-plan]], [[project-cr2-colordata-matrix-todo]].
4. **ADR-4 (MEASURED +22%)** Demosaic phased-MHC split + MHC SIMD + Laplacian CSE. flipflop demosaic-mhc: RGGB-specialized is ~22% faster than the generic per-pixel CFA-dispatch path (16–28%/size, trust:high). Approve the refactor?
5. **ADR-6** Fast embedded-preview/LOD tier for CR2+DNG (ORF-only today) + wire `demosaic_rggb_half` AR tier.
6. **ADR-7** Collapse 3× SOF3 parsers + 2× BitReaders.
7. **ADR-8** Wire "Perceptual Constancy Mode" (depends on ADR-3).

**Measured & REJECTED (do not pursue without cleaner box):**
- **ADR-5** DNG tile-decode endianness-branch hoist — flipflop dng-tile-decode: geomean **3.8% slower**, −25%…+19% swing, trust:low 11/12 rows. Below 5% gate; path is cold + bandwidth-bound. Branched code left as-is.

**Trivial deferrals (need owner confirm):**
- `align_to_rggb` (dng.rs) is dead in production — doc/naming fixed; full removal pending confirm it stays dead.
- DNG `CFAPattern != 4-entry` → silent RGGB fallback (dng.rs:569-573): hard-error vs warn is a product call.

---

## QUESTIONS from EpicCodeReview progressive-scheduler.ts (2026-06-19)

### Q1 — tick() sort dirty-flag optimization (hacker-m3n4)
**Deferred** from progressive-scheduler.ts correctness fix pass.  
**Measured speedup:** 73-80% at 200-500 jobs (38 µs → 10 µs median per tick at 200 jobs).  
**Why deferred:** Requires careful dirty-state tracking across all state-change methods (observe, unobserve, select, deselect, handleIntersection, startDecode completion). The `decoderAbort` filter is the key risk: if a job transitions to `decoderAbort !== null` inside a tick() call and the cached candidate list isn't updated, the next RAF tick with dirty=false would attempt to start a second decode for the same job.  
**Implementation sketch:** Add `private candidatesDirty = true` field. Set it to `true` in observe, unobserve, select, deselect, handleIntersection, and at the end of startDecode's finally block. In tick(), if `!candidatesDirty`, recompute scores in-place (still need to update starvationBonus which is time-dependent) and re-sort the existing array without rebuilding. When dirty, rebuild from scratch and set `candidatesDirty = false`.  
**Gate:** ≥5% faster at 200 jobs AND test suite green. Current tests exercise tick() at lines 503, 545, 602 of scheduler.test.ts.

### Q2 — armEarliestRetryTimer incremental tracking (structure-x6y7z8)
**Deferred** from progressive-scheduler.ts correctness fix pass.  
**Measured speedup:** 97% at 200-500 jobs (3.4 µs → 0.1 µs). Absolute cost is tiny (3.4 µs) and the existing guard (`if (armedRetryAt === earliest && retryTimerId !== null) return`) already makes the re-arm path O(1) when nothing changed.  
**Why deferred:** Maintaining a `minNextRetryAt` field incrementally requires updating it in every place that mutates `job.nextRetryAt` (observe, select, deselect, setTargetTier, startDecode catch block) and recomputing on unobserve (O(n) scan unavoidable when the removed job was the minimum). Net gain in the real-world case (job removal drives a scan anyway) is marginal.  
**Recommendation:** Not worth implementing — the guard already handles the fast path. Close.

### Q3 — teeFetch tee() double-buffering (hacker-w3x4)
**Deferred** from progressive-scheduler.ts correctness fix pass.  
**Confirmed:** `ReadableStream.tee()` buffers up to 1 full tier in memory when the JXL decoder stalls (slow consumer). For a 10 MB tier this means 20 MB peak.  
**Fix approach:** Replace `resp.body.tee()` with a `TransformStream` that writes each chunk to both `onChunk()` (synchronously) and passes it through to the decoder. Zero extra buffering because the intercept is in-line with the consumer.  
**Why deferred:** The `teeFetch` return type (`{ fetchImpl: typeof fetch; settled: () => Promise<void> }`) wraps a full `fetch` implementation. Replacing tee with a TransformStream changes how the response body is wrapped and requires verifying that `fromResponse`/`fromReadableStream` still sees a correctly-formed readable stream. This is an architectural change to the fetch abstraction.  
**Gate before implementing:** Measure actual tier sizes in production; if P95 tier < 2 MB, 2× is only 4 MB peak and not worth the complexity. If P95 is 10+ MB, this is worth doing.

### Q4 — profile.test.ts failure: "dc tier byteEnd is less than full file size"
**Status:** Pre-existing test failure in `progressive-profile.ts` (not touched in this pass).  
**Symptom:** The test was unreachable before this fix pass because the TS compile errors at lines 260/384 blocked compilation. After fixing those errors, the test now runs and fails.  
**Location:** `packages/jxl-progressive/test/profile.test.ts` line 86.  
**The test asserts:** `dcEvent.byteOffset < totalBytes` — i.e. dc tier should not span the full file.  
**Likely cause:** The synthetic JXL test data used in `profileJxl` tests may not produce a real DC progression event, causing `selectTiers` to fall back to a heuristic that picks the full file size as the dc byteEnd. Needs investigation in `progressive-profile.ts`.

### Q5 — testFetchTierWithPrefix TS exactOptionalPropertyTypes workaround
**Status:** The `(this as any).testFetchTierWithPrefix = (opts as any).testFetchTierWithPrefix` cast in the constructor (line 175) remains as-is.  
**Why:** `private readonly testFetchTierWithPrefix?: typeof fetchTierWithPrefix` declares an optional field. With `exactOptionalPropertyTypes: true`, you cannot assign `T | undefined` to a target typed as `T`. The direct assignment `this.testFetchTierWithPrefix = opts.testFetchTierWithPrefix` causes TS2412.  
**Clean fix:** Change the field declaration to `private testFetchTierWithPrefix: typeof fetchTierWithPrefix | undefined = undefined` (not optional, but explicitly union with undefined). Then the assignment in the constructor is valid without a cast.

---

## Run `epiccodereview/20260619T130329Z` — ProgressiveJXLEncodeBunch (global architecture & vision pass)

Target: the 7-file progressive-JXL encode bunch (casaencoder, casabio_encode, jxl-ffi, jxl-progressive index/manifest/stream/scheduler), workalone. Section direct fixes already landed in commit `414c8ec2`. The items below are the whole-target opportunities (mostly ADR-level) and the cross-file issues deferred for human ratification.

### FLAGSHIP ADR (highest leverage — directly cuts encode time)
- **Derive all three delivery tiers from ONE progressive JXL encode** instead of three independent libjxl passes. Draft: `.epiccodereview/20260619T130329Z/global/adr_draft/single-pass-progressive-encode.md`. Recommends: one progressive encode (ProgressiveDc + GroupOrder) + encoder-emitted byte offsets, retiring the `profileJxl` post-encode re-decode. Expected ~2/3 encode-CPU + storage reduction at ingest. Reversible: partial (stored-format change needs migration). GATE: per-tier Butteraugli/ΔE must hold — measure with the existing `.flipflop/tests/photon-qprogac.mjs` + `.verify-quality` sibling before flipping any default. **This is the big timing win; it was NOT auto-applied (architectural + storage-format = no-go without sign-off).**

### Architecture opportunities (deferred — ADR/design decisions)
- `casabio_encode.rs` parallel path runs 3 single-threaded libjxl `Encoder`s concurrently under rayon — subsumed by the flagship (one encode removes the need for 3-way fan-out).
- `crates/jxl-ffi/src/lib.rs` is effectively empty on `wasm32` — there is no in-scope WASM-side progressive-encode bridge; the browser path can't produce progressive JXL today. Design decision: where does WASM progressive encode live.
- `progressive-scheduler.ts:605` `prefixAccum` grow buffer has no upper bound — a full JXL accumulates unbounded in memory; needs a designed memory budget (P7).
- `progressive-profile.ts:191` `computeSha256` is a second full sequential scan of `jxlBytes` after profiling — fuse with the profiling pass or move off the hot path (also see Q-perf below).

### Vision opportunities (deferred — aspirational, ADR)
- `ManifestTier` carries no per-tier pixel `width`/`height` (LOD metadata) — ML input sizing / AR / pyramid LOD must decode the header or guess. Small schema addition + encoder emit.
- `TierFetchOptions` has no `timeoutMs` — an AR recognition pass can't enforce a hard DC-tier deadline without coupling into the scheduler's AbortController. Trivial: add `timeoutMs` backed by `AbortSignal.timeout()`.
- `perceptual` passthrough on the manifest is `Record<string,unknown>` — no typed contract for the planned LookRenderer / Perceptual Constancy Mode metadata.
- `onManifest` is the natural ML-dispatch point but carries no tier-resolution info; `ProgressiveImageJob` has no predicted-arrival-time and `fairnessScore` no render-budget signal (game-engine-style streaming/LOD scheduling); `streamTierFrames` discards per-frame byte offsets; encoder declares depth/spectral extra channels that are never populated.

### Cross-file ISSUES deferred (confirmed, not auto-fixed)
- **byteStart dead field** (`progressive-manifest.ts` ManifestTier): `byteStart` is always written 0 and never read (consumer uses cumulative `bytes=0-byteEnd`). Removing it is a public schema change → defer (no-go for unilateral edit). Decide alongside the flagship offset rework.
- **manifest double-fetch race** (`progressive-scheduler.ts:428`): `prefetchManifest` and `startDecode` can both fetch the manifest for the same job. PARTIALLY mitigated by the landed TOCTOU local-capture fix, but the duplicate-fetch dedup itself is unaddressed — track the in-flight manifest promise per job and share it.

### Perf items measured-but-deferred (from section pass)
- Q1 `progressive-scheduler.ts:484` tick() re-sorts candidates every RAF — dirty-flag gives 73-80% on the sort, but absolute cost is small vs test-suite risk; deferred.
- Q2 `progressive-scheduler.ts:400/247` full linear scan for earliest retry — 97% faster incrementally but absolute ~3.4µs; deferred.
- Q3 `progressive-scheduler.ts:454` teeFetch tee() double-buffering + Q `:700` synchronous full-bytes SHA-256 — both architectural/threading changes; deferred (don't half-do crypto/threading).

### HIGH-PRIORITY follow-up (out of requested scope but exposed by this run)
- `progressive-profile.ts:156` — DC tier `byteEnd` is set to `bytesPushed` at the frame event and can reach/exceed the full file size; `profile.test.ts` "dc tier byteEnd is less than full file size" now FAILS (1/86). The suite was previously uncompilable (scheduler TS errors), so this pre-existing bug was hidden; fixing the compile block exposed it. `progressive-profile.ts` was NOT in the requested 7-file scope so it was not edited — recommend a focused follow-up (it is the same byte-offset-contract bug the flagship ADR addresses).

---

## ADR DRAFTS from section 000 review (2026-06-19)

- Topic: Pyramid downscale→encode fusion (halve peak memory)
  File: .epiccodereview/20260619T195435Z/sections/000/adr_draft/pyramid-downscale-encode-fusion.md
  Recommends: Stream per-level downscale+encode, release each buffer before computing next
  Reversible: yes

- Topic: Test coverage for pyramid sidecar sort guard
  File: .epiccodereview/20260619T195435Z/sections/000/adr_draft/test-coverage-pyramid-sidecar-sort.md
  Recommends: Add pyramid_sidecar_sizes_unsorted_produces_correct_level_order unit test
  Reversible: yes

- Topic: validateManifest dimension + byteEnd guards
  File: .epiccodereview/20260619T195435Z/sections/000/adr_draft/manifest-validate-dimensions-byteend.md
  Recommends: Add width/height > 0 and byteEnd <= jxl.bytes checks; Zod rejected (no benefit, +15KB)
  Reversible: yes

- Topic: encoder.flags per-entry string validation
  File: .epiccodereview/20260619T195435Z/sections/000/adr_draft/manifest-flags-entry-validation.md
  Recommends: Validate each flag entry is a string in validateManifest; flagged as direct_fix candidate
  Reversible: yes

- Topic: Structured error reporting in startDecode
  File: .epiccodereview/20260619T195435Z/sections/000/adr_draft/scheduler-structured-error-reporting.md
  Recommends: Define SchedulerError class with cause/tier/attemptCount/bytesLoaded; update onError type
  Reversible: partial

---

## ADR DRAFTs from EpicCodeReview run 20260619T194416Z (global + section 000)

## ADR DRAFT from task G-arch-o7p8
- Topic: Memory Budget Policy
- File: .epiccodereview/20260619T194416Z/global/adr_draft/memory-budget-policy.md
- Recommends: Define RAW_DECODE_PEAK_BYTES, add pre-flight dimension check before large allocs, expose estimate_decode_peak_bytes() wasm_bindgen export
- Reversible: partial

## ADR DRAFT from task G-arch-u3v4
- Topic: Unified Butteraugli Interface
- File: .epiccodereview/20260619T194416Z/global/adr_draft/unified-butteraugli-interface.md
- Recommends: Designate PerceptualComparer (src/lib.rs) as canonical; delegate facade.ts ButteraugliComparator to it via thin TS adapter to enable zero-copy test-image staging
- Reversible: partial

## ADR DRAFT from task G-arch-a9b0
- Topic: DNG/CR2 LookRenderer Factory
- File: .epiccodereview/20260619T194416Z/global/adr_draft/dng-cr2-lookrenderer-factory.md
- Recommends: Add process_dng_to_renderer / process_cr2_to_renderer wasm_bindgen entry points that keep rgb16_lb in WASM and construct LookRenderer without a JS round-trip
- Reversible: yes

## ADR DRAFT from task G-arch-b3c4
- Topic: ProcessResult Lazy Pixel Buffer Materialization
- File: .epiccodereview/20260619T194416Z/global/adr_draft/processresult-lazy-buffers.md
- Recommends: Introduce RawDecodeSession wasm_bindgen struct with demand-pull take_lb/take_thumb/take_rgb8/take_full16 methods to reduce simultaneous peak WASM heap
- Reversible: partial

## ADR DRAFT from task G-arch-g9h0
- Topic: DNG/CR2 Pre-Demosaic Planar Downscale (Hypercar Parity)
- File: .epiccodereview/20260619T194416Z/global/adr_draft/dng-cr2-planar-downscale.md
- Recommends: For preview-only DNG/CR2 requests, replace full-resolution MHC demosaic + downscale with direct bayer-subsampled bilinear demosaic at target dims (10–20× throughput gain for gallery ingest)
- Reversible: yes

## ADR DRAFT from task G-vision-g3h4i5
- Topic: AR Thumb-First Preview Path
- File: .epiccodereview/20260619T194416Z/global/adr_draft/ar-thumb-first-preview.md
- Recommends: Add process_orf_thumb_fast() using 2×2 bayer quad average at target dims to achieve sub-30ms thumbnail latency for AR plant-ID use case
- Reversible: yes

## ADR DRAFT from task G-arch-i1j2
- Topic: ProcessResult Metadata-Only Decode Path
- File: .epiccodereview/20260619T194416Z/global/adr_draft/processresult-metadata-only.md
- Recommends: Add parse_dng_metadata() and parse_cr2_metadata() wasm_bindgen exports that parse TIFF/EXIF headers only, enabling gallery ingest metadata scan without bayer decompress
- Reversible: yes

## ADR DRAFT from task G-arch-g5h6
- Topic: bindgen rerun-if-changed Tracking
- File: .epiccodereview/20260619T194416Z/global/adr_draft/bindgen-rerun-tracking.md
- Recommends: Emit cargo:rerun-if-changed for each libjxl header under include/jxl/ in crates/jxl-ffi/build.rs to prevent stale bindings after header upgrades
- Reversible: yes

## ADR DRAFT from task 000-hacker-d0e1f2a3
- Topic: SIMD u16x8 Accumulation for downscale_rgb16_planar
- File: .epiccodereview/20260619T194416Z/sections/000/adr_draft/simd-downscale-rgb16-planar.md
- Recommends: Implement wasm32 SIMD fast path for downscale_rgb16_planar using u16x8 horizontal accumulation (4–8× throughput; pixel-identical to scalar)
- Reversible: yes

## ADR DRAFT from task 000-hacker-c5d6e7f8
- Topic: SIMD v128 Accumulation for downscale_rgba
- File: .epiccodereview/20260619T194416Z/sections/000/adr_draft/simd-downscale-rgba.md
- Recommends: Implement wasm32 SIMD fast path for downscale_rgba using v128 4-pixel loads and u16x8 widening accumulation (4× wider than scalar; pixel-identical output)
- Reversible: yes

## ADR DRAFT from task 000-structure-v2w3x4
- Topic: Unit Tests for LookRenderer and ORF Bench Paths
- File: .epiccodereview/20260619T194416Z/sections/000/adr_draft/look-renderer-tests.md
- Recommends: Add unit tests for LookRenderer clarity-clone guard, black pedestal subtraction, orientation dim invariant, and demosaic_rggb_shuffle_simd parity
- Reversible: yes

## ADR DRAFT from task 000-correctness-s6t7u8v9
- Topic: PerceptualComparer Input Buffer Validation
- File: .epiccodereview/20260619T194416Z/sections/000/adr_draft/perceptual-comparer-validation.md
- Recommends: Add validate_rgba_len() check in PerceptualComparer::new() and all metric methods to surface buffer-length mismatches as JsError instead of silent OOB reads
- Reversible: yes

---

## ADR DRAFTS from global architecture+vision pass (2026-06-19)

- Topic: Strategic map / end-to-end contract test
  File: .epiccodereview/20260619T195435Z/global/adr_draft/strategic-map-two-pipeline-boundary.md
  Recommends: Add a contract test covering Rust encode -> manifest -> TS byte ranges
  Reversible: yes

- Topic: Encoder pipeline separation
  File: .epiccodereview/20260619T195435Z/global/adr_draft/encoder-pipeline-separation.md
  Recommends: Cache tonemapped RGBA, call encode variants only
  Reversible: yes

- Topic: jxl-ffi runtime version assertion
  File: .epiccodereview/20260619T195435Z/global/adr_draft/jxl-ffi-runtime-version-check.md
  Recommends: Add startup version assertion for major.minor match
  Reversible: yes

- Topic: RGBA resize on no-alpha path
  File: .epiccodereview/20260619T195435Z/global/adr_draft/rgba-resize-no-alpha-waste.md
  Recommends: Add resize_rgb variant or pass has_alpha hint
  Reversible: yes

- Topic: SHA-256 verification off main thread
  File: .epiccodereview/20260619T195435Z/global/adr_draft/checkHash-offthread-sha256.md
  Recommends: Move SHA-256 to a Worker or detached SubtleCrypto task
  Reversible: yes

- Topic: sha256 optional in manifest
  File: .epiccodereview/20260619T195435Z/global/adr_draft/sha256-optional-in-manifest.md
  Recommends: Make sha256 optional, default verifyHash=false
  Reversible: yes

- Topic: ML recognition seam wiring
  File: .epiccodereview/20260619T195435Z/global/adr_draft/ml-recognition-seam-wiring.md
  Recommends: Wire ModelAdapter into ProgressiveGallery frame loop
  Reversible: yes

- Topic: types.ts scope creep split
  File: .epiccodereview/20260619T195435Z/global/adr_draft/types-ts-split-concerns.md
  Recommends: Split into decode/ml/geometry type modules
  Reversible: yes

- Topic: 16-bit pyramid level support
  File: .epiccodereview/20260619T195435Z/global/adr_draft/pyramid-level-16bit-support.md
  Recommends: Add bits_per_sample to PyramidLevel and uint16 encode path
  Reversible: yes

- Topic: Depth channel sidecar encode
  File: .epiccodereview/20260619T195435Z/global/adr_draft/depth-channel-sidecar-encode.md
  Recommends: Add depth: Option<&[f32]> to encode_rgba8_pyramid
  Reversible: partial

- Topic: perceptual field typed (PerceptualParams interface)
  File: .epiccodereview/20260619T195435Z/global/adr_draft/manifest-perceptual-field-typed.md
  Recommends: Define PerceptualParams interface and type manifest.perceptual
  Reversible: yes

- Topic: Camera intrinsics validation
  File: .epiccodereview/20260619T195435Z/global/adr_draft/manifest-capture-intrinsics-validation.md
  Recommends: Add field-level validation for capture.intrinsics and capture.pose
  Reversible: yes

- Topic: ColorEncoding P3/ICC variants
  File: .epiccodereview/20260619T195435Z/global/adr_draft/color-encoding-p3-icc.md
  Recommends: Add DisplayP3 and IccProfile variants to ColorEncoding enum
  Reversible: partial

---

## QUESTION from task G-arch-009-activeDecoders-count-no-fetch-limit
- Section: (selected files)
- File: packages/jxl-progressive/src/progressive-scheduler.ts
- Finding: activeDecoders slot consumed during manifest fetch, starving WASM decode slots on slow network
- Line range: 520-526
- What we tried: Scheduler fixer reviewed the code but task not applied (not in fix log)
- What we need: Add separate `activeFetches` counter incremented at startDecode entry, decremented when fetch settles; gate `activeFetches < maxActiveFetches` separately from `activeDecoders < maxActiveDecoders`
- Suggested direction: `maxActiveFetches` could default to `maxActiveDecoders * 2` so slow fetches never starve fast WASM decoders

---

## QUESTION from task 000-hacker-f6a7b8c9
- Section: (selected files)
- File: packages/jxl-wasm/src/facade.ts
- Finding: eventsProgressive pixel copy optimization (preparePixelsForEmit)
- Line range: ~1505-1519
- What we tried: `.flipflop/tests/events-progressive-copy.mjs` — synthetic SAB-backed test shows copy ≈ transfer (both do one memcpy from non-transferable SAB). Real WASM heap IS transferable; synthetic test can't capture the zero-copy win.
- A/B result: copy and transfer are equal on the SAB surrogate path (WASM heap path not exercised). Transfer wins only when WASM heap ArrayBuffer is transferred directly (saves one memcpy, ~33ms for 4K RGBA8).
- Verdict: NEEDS BROWSER RUN. Write a full decode-session variant that measures real preparePixelsForEmit with a live WASM decoder. Synthetic test closes without verdict.
- What we need: flipflopdom A/B with real JXL WASM decode at 4K; confirm >5% end-to-end gain before changing deferredRelease logic

## QUESTION from task 000-structure-i9j0k1
- Section: (selected files)
- File: packages/jxl-wasm/src/facade.ts
- Finding: readBufferView vs retainBufferView inconsistency (perf claim)
- Line range: various (all retainBufferView call sites in facade.ts)
- What we tried: `.flipflop/tests/read-buffer-view-vs-retain.mjs` — both variants create `new Uint8Array(heap, ptr, len)` then `out.set(view)`. Interleaved A/B at fractal sizes 256–4096.
- A/B result: geomean ≈0% (-1.9% to +2.9%), well within noise. Confirmed structural-only — zero timing difference.
- Verdict: FALSE POSITIVE (perf claim). Change is a clarity fix only. No code edit needed. Ownership semantics improve readability; rename opportunistically during future refactors, not for perf.

## QUESTION from task 000-hacker-e5f6a7b8
- Section: (selected files)
- File: packages/jxl-wasm/src/facade.ts
- Finding: bilinearResize rgba16 x-axis weight hoisting (inner loop)
- Line range: bilinearResize function (~line 800-900 area)
- What we tried: `.flipflop/tests/bilinear-rgba16-hoist.mjs` — two variants: baseline reads `xAxis.i0[dx]` per dy-iteration; hoisted precomputes `xi0[]`, `xi1[]`, `xts[]` arrays before the dy loop. Fractal corpus 256–4096.
- A/B result: geomean -5.8% (hoisted SLOWER). V8 JIT already hoists property access for typed arrays via inline cache. Explicit hoisting adds allocation overhead.
- Verdict: FALSE POSITIVE. V8 handles this. No code change.

## QUESTION from task 000-structure-x4y5z6
- Section: (selected files)
- File: packages/jxl-wasm/src/facade.ts
- Finding: eventsOneShot accumulates all chunks before decode (perf claim)
- Line range: eventsOneShot body (~line 1800-1850)
- What we tried: `.flipflop/tests/events-oneshot-streaming.mjs` — batch variant allocates `new Uint8Array(2MB)` + copies 64×32KB chunks; streaming variant calls stub decoder per chunk.
- A/B result: streaming "99.6% faster" — MISLEADING. The 0.5ms batch cost is the concatenation allocation, not JXL decode cost. libjxl one-shot mode requires full contiguous bytestream; streaming semantics would buffer the same bytes inside the decoder (equal total allocation).
- Verdict: INTENTIONAL (IMPROVEMENT-7). The 0.5ms concatenation is real overhead but unavoidable for one-shot decode. Architectural boundary: eventsProgressive handles streaming; eventsOneShot must batch. No code change.

## QUESTION from task 000-hacker-c3d4e5f6
- Section: (selected files)
- File: src/lib.rs
- Finding: decode_orf_raw MHC demosaic runs unconditionally — wasted when only OUT_LIGHTBOX|OUT_THUMB are requested
- Line range: src/lib.rs lines 731–745 (decode_orf_raw)
- What we tried: Code audit + bench — confirmed `rgb16` (MHC result) is immediately `drop()`ed in `process_orf_impl` when neither `OUT_FULL_RGB8` nor `OUT_FULL_16` is set. MHC demosaic cost measured via `demosaic-bench --variant rggb-specific` on synthetic 24MP Bayer (4898×4898, MSVC release): **556ms per call** (2778ms / 5 reps).
- A/B result: Gate applied — `need_full_rgb = output_flags & (OUT_FULL_RGB8 | OUT_FULL_16) != 0`. Skips MHC + NR when preview-only. Saving: 556ms native (estimate ~1–1.5s in WASM). 146/0 lib tests pass. WASM lib check clean.
- Verdict: FIXED. Committed. Preview-only callers (`process_orf_with_flags` with flags=6) save the full MHC demosaic cost. Full-path callers unchanged.

## QUESTION from task 000-hacker-a1b2c3d4
- Section: (selected files)
- File: src/lib.rs or crates/raw-pipeline (WASM SIMD frame_stats, fs_core_simd)
- Finding: fs_core_simd v128 re-read
- Line range: fs_core_simd kernel
- What we tried: `.flipflop/tests/fstats-simd-vload-fix.mjs` — loaded two WASM binaries (before/after `u32x4_extract_lane` fix) into the same Node.js process; timed `fstats_simd()` interleaved. Tested at sizes 1024 and 2048/4096.
- A/B result: +5.8% at 1024 (trust:low — JIT warmup dependent); -0.7% geomean at 2048/4096. Inconsistent across runs.
- Verdict: BELOW GATE. JIT-warmup artifact masks any real register-reuse win at WASM SIMD tier. WASM engine may already hoist the load via its own optimizer. Reverted to `u32::from_le_bytes` baseline. No code change.

## QUESTION from task 000-hacker-a7b8c9d0
- Section: (selected files)
- File: crates/raw-pipeline/src (downscale path)
- Finding: downscale division precompute reciprocal
- Line range: downscale_rgba / downscale_rgb16 inner loops
- What we tried: Analysis — `downscale_rgba` integer fast path: 4 u32 divisions per output pixel after `xstep×ystep` accumulation iterations. For large boxes (xstep=30, ystep=30, pixel_count=900), inner loop is 3600 load+add ops vs 4 divides — divisions are <0.2% of ops; path is memory-bound. `downscale_rgb16_into` already has reciprocal (u64 fixed-point) because u16 accumulations are larger. For u8 output the divisor fits in a single u32 instruction and the compiler may already special-case powers of 2.
- A/B result: Not measured — analysis shows gain well below 5% gate for any realistic box size. Memory bandwidth dominates.
- Verdict: NOT WORTH MEASURING. No code change.

## QUESTION from task 000-structure-d4e5f6
- Section: (selected files)
- File: src/lib.rs
- Finding: DNG lightbox/thumb downscale path (complex restructure)
- Line range: process_dng_impl output branches (~line 2023-2263)
- What we tried: deferred — complex + needs WASM rebuild
- What we need: Add integration tests covering all eight output_flags combinations (M3, lightbox, thumb, full RGB8, combinations) before restructuring the downscale branches; then measure if the refactor reduces binary size or improves decode latency

## QUESTION from task 000-hacker-b2c3d4e5
- Section: (selected files)
- File: crates/raw-pipeline/src/frame_stats.rs
- Finding: fs_core_simd_exact FNV loop
- Line range: fs_core_simd_exact function
- What we tried: Not measured — same WASM JIT-warmup uncertainty as fs_core_simd (task 000-hacker-a1b2c3d4). Would need two WASM builds + interleaved Node.js test. Prior `fs_core_simd` A/B showed inconsistent results (+5.8% warm / -0.7% cold); `fs_core_simd_exact` operates on same register-reuse pattern.
- Verdict: DEFER pending wasm-opt -O3 inspection. If `wasm-opt --print-after-all` shows the load already eliminated, close as false positive. If load persists, re-measure after wasm-opt pass.
- What we need: `wasm-opt -O3 pkg/raw_converter_wasm_bg.wasm --print-after-all | grep -A10 fs_core_simd_exact` to verify if compiler already eliminates the re-read before re-attempting the manual fix

## QUESTION from task 000-structure-h8i9j0
- Section: (selected files)
- File: src/lib.rs
- Finding: LookOverrides 14-arg API (public wasm_bindgen API)
- Line range: LookOverrides struct + all process_* wasm_bindgen exports (~line 1923+)
- What we tried: deferred — public API change requires ADR
- What we need: ADR decision on the preferred JS-side API shape (flat args vs options object via JsValue/serde) before any implementation; the change breaks all existing JS callers and requires a migration path

---

## ECR Section 002 — external/libjxl deferred (20260619T194416Z)

Target: `external/libjxl/CMakeLists.txt`. All items below require a full C++/cmake rebuild
to verify and are deployment-policy decisions that affect binary size, ABI compatibility, and
fleet-wide performance. No direct fixes were deferred this section (direct_fix list was empty).
Both items are ADR-level opportunities.

### ADR-002-1 — Document AVX-512 opt-in build flags for capable deployment targets

- **Finding ID:** hacker-k1l2
- **File:** `external/libjxl/CMakeLists.txt`, lines 171–215
- **Category:** build flags / SIMD coverage
- **Severity:** medium
- **What to do:** The CMakeLists currently enables Highway's default SIMD targets. AVX-512 (via
  `-DJXL_ENABLE_AVX512=ON` or equivalent Highway flag) is left off by default because it widens
  the binary and may regress throughput on some microarchitectures (AVX-512 port contention on
  Skylake-server). For deployment targets known to be Icelake/Zen4+ (server ingest workers,
  dedicated encode boxes), enabling AVX-512 can yield another measurable throughput gain on the
  libjxl encode path.
- **Why deferred:** Enabling AVX-512 is a project-wide deployment decision, not a single-file
  mechanical edit. It affects: (1) binary size (wider code paths), (2) compatibility (must not
  ship AVX-512 binaries to hosts that lack the feature), (3) potential throughput regression on
  some SKUs. Requires an ADR covering target fleet capabilities, dispatch strategy (runtime
  HWY_DYNAMIC_DISPATCH vs compile-time), and a flipflop benchmark on the actual encode
  workload before adoption.
- **ADR draft:** `.epiccodereview/20260619T194416Z/sections/002/adr_draft/avx512-opt-in-build-flags.md`
- **Suggested approach:** Add a CMake option `CASAWASM_ENABLE_AVX512` (default OFF). When ON,
  pass `-DHWY_COMPILE_ALL_ATTAINABLE=1` (or the Highway equivalent) so libjxl compiles and
  registers AVX-512 dispatch targets. Gate behind a CI matrix job targeting a Zen4/Icelake host
  and flipflop-verify that encode throughput improves by ≥5% before enabling in any default build.
  Keep the default OFF so developer builds remain portable.

### ADR-002-2 — Investigate LTO/IPO for release builds — verify Highway HWY_EXPORT dispatch survives

- **Finding ID:** hacker-m3n4
- **File:** `external/libjxl/CMakeLists.txt`, lines 1–547
- **Category:** build flags / link-time optimization
- **Severity:** medium
- **What to do:** The current cmake build does not enable LTO/IPO (`-flto` / CMake
  `INTERPROCEDURAL_OPTIMIZATION`). LTO can inline small hot helpers across the libjxl encode/decode
  boundary and trim dead-code, but Highway's `HWY_EXPORT` dispatch table relies on weak-symbol
  linkage and per-target function attributes that some LTO implementations merge or discard,
  silently falling back to scalar.
- **Why deferred:** The interaction between LTO and Highway's dynamic dispatch is uncertain and
  has historically caused silent correctness regressions (wrong SIMD tier selected at runtime).
  Verifying correctness requires: building with LTO, running the full libjxl test suite, and
  confirming via `HWY_PRINT_RUNTIME_INFO` that all expected dispatch tiers are still reachable.
  This is a benchmarking+risk analysis exercise that cannot be done without a full cmake+libjxl
  rebuild and is therefore an ADR-level decision, not a one-line change.
- **ADR draft:** `.epiccodereview/20260619T194416Z/sections/002/adr_draft/lto-ipo-release-build.md`
- **Suggested approach:** (1) Add a CMake option `CASAWASM_ENABLE_LTO` (default OFF). (2) When ON,
  set `set_property(TARGET jxl PROPERTY INTERPROCEDURAL_OPTIMIZATION TRUE)` and add
  `-fno-lto-odr-type-merging` (or equivalent) to preserve weak-symbol dispatch. (3) Build and run
  `cargo test -p jxl-ffi` + the libjxl unit suite. (4) Run a flipflop encode/decode bench against
  the non-LTO baseline; require ≥3% geomean gain before enabling in CI. (5) Document the risk in
  CLAUDE.md build notes.

---

## SpeedCodeReview deferral — jxl_casadecoder.rs (2026-06-20, opus-4.8[1m]) — RESOLVED

All three deferrals from this file's review were closed (peer-review follow-up).

**[RESOLVED → GREEN] JXTC 16-bit tile decode double-copy.**
~~`u16_samples_to_ne_bytes(&img.data)` allocated + copied a full-tile byte Vec, then
row-copied again into `dest`.~~ Reframed from a perf gamble to a *correct-by-construction*
copy-elimination: tiles are now held in native width (`TilePixels::U16(Vec<u16>)`) and the
compositor takes a sound byte **view** (`as_bytes`, native-endian, align 2≥1) at copy time.
No intermediate alloc/copy on the 16-bit path; provably identical bytes (covered by
`decode_jxtc_region_16bit_byteview_matches_ground_truth`). Did not need the ≥5% perf gate
because it's a structural simplification, not a measured speedup claim.

**[RESOLVED → RED] decode_region true ROI decode.** Impossible: libjxl 0.11 stable
`JxlDecoder` exposes no spatial crop/region setter (verified the full `JxlDecoderSet*`
surface — only whole-frame `SetImageOutBuffer`, embedded `SetPreviewOutBuffer`, and
*temporal* `SkipFrames`). JXTC is the sanctioned ROI path. Documented on `decode_region`.

**[RESOLVED → RED] Parallel JXTC composite / "memory cliff".** The composite is row
`memcpy` into disjoint dest rects — bandwidth-bound, so threads add no throughput (same
memory bus). The `decoded_tiles` transient only holds the *overlapping* tiles (a handful for
a normal viewport); its peak matters only when the viewport ≈ whole image, the anti-pattern
this API avoids. Decode-into-dest would drop the transient but needs unsafe disjoint-rect
writes — unjustified for the small-viewport norm. Documented on `decode_jxtc_region`.

---

## EpicCodeReview — jxl-scheduler (2026-06-21, branch EpicCodeReviewJxl-Scheduler)

Deferred items from the review of `packages/jxl-scheduler/src/`. 2 issues fixed + committed
(`eb51ff6b`: kind-aware abort terminal, forEachSubscriber fast path). Below = uncertain or
out-of-this-package, left for a human decision.

### Q1 (uncertain, medium) — Subscriber record / `_subscriberCount` cleanup on NORMAL primary terminal
`scheduler.ts:~1245` (handleWorkerMessage terminal branch). On normal primary completion,
`cleanupSession(primaryId)` deletes only the primary and calls `dedupe.complete()` (strips the
dedupe maps). The deduped-subscriber `SessionRecord`s (`isSubscriber:true`, created in
`acquireSlot`) are NOT removed from `this.sessions`, and `_subscriberCount` is NOT decremented.
The terminal message IS fanned out to the subscriber handlers (line ~1217), so cleanup likely
relies on the consumer (jxl-session) calling `completeSession(subId)` per subscriber — the same
way primaries are torn down externally elsewhere. The ABORT path (`abortAcquisition`) cleans
subscribers explicitly; the normal-terminal path is asymmetric.
**Decision needed:** Is per-subscriber `completeSession` a guaranteed contract from jxl-session?
- If YES: no bug; add a one-line contract comment at the terminal fan-out and a test that the
  consumer-driven cleanup zeroes `getMetrics().subscribers`.
- If NO: defensive cleanup is needed, but must avoid double-decrement when the consumer also
  calls `completeSession` (counters are `Math.max(0, …)`-guarded, so under-count, not negative).
Cannot resolve inside this package — needs the jxl-session subscriber lifecycle.

### Q2 (low) — `setPriority` has no `paused` branch + duplicates dedupe-escalation logic
`scheduler.ts:465`. `setPriority` handles `queued` and running (`worker`) states but not
`paused`; a paused session only updates `record.priority`, relying on `resumePausedSession`
(line ~1082) to re-derive `backgroundWorkers` membership on resume. Works by invariant today,
undocumented. The queued-reprioritization block also duplicates the dedupe-escalation code in
`acquireSlot`. Low risk; extract a shared `requeueWithPriority()` helper + document the paused
behavior if touched.

### Q3 (low, API change — deferred per no-go list) — `acquireSlot` returns `workerId: -1` sentinel
For subscribers / still-queued sessions the resolved `{ workerId: number }` uses `-1`,
indistinguishable from a real id. Prefer `workerId: number | null`. Public return-type change →
not done unilaterally; needs caller (jxl-session) audit.

### Q4 (opportunity, low) — No input validation at public boundaries
`acquireSlot` / `setPriority` accept `Priority` / `sessionId` without validation; a bad priority
string (arriving via an `as` cast) reaches `queue.lane()`, which has no `default` case and throws
deep inside `enqueue`. `CoreBudget` validates its inputs — inconsistent. Consider a cheap guard +
explicit error at the boundary.

### Q5 (low, doc) — Reentrant `cancelSession` during `maxParkedSessions` eviction
`scheduler.ts:~977`. The S15 eviction calls `this.cancelSession(oldestRecord.sessionId)` from
inside `tryPreempt`, firing arbitrary caller handlers against half-updated scheduler state.
Default `maxParkedSessions = Infinity`, so this rarely runs. Document the reentrancy contract (or
defer the eviction to a microtask) if this path is ever enabled in production.

### Not pursued (deliberately)
- `signalDrain` per-waiter `queueDepth` decrement — CLAUDE.md records this as the intentional
  coalesced-drain gauge ("Scheduler A3 FALSIFIED, not a bug").
- Pool/Queue "dead" public APIs (`healthSnapshot`, `idleWorkers`, `peek`, `backgroundIds`, …) —
  test-support / observability surface, `@internal`-tagged; removing them is an API change.
- `as`-casts to reach `sessionId`/`metric`/`stage` on the protocol union — pervasive and
  deliberate for discriminated-union narrowing on the hot path.
- `dist-test/` was NOT review-scoped (generated TS output of `src/`).

---

# EpicCodeReview 20260623T013020Z — crates/raw-pipeline/src — global ADR drafts

17 confirmed architecture+vision opportunities, all awaiting human ratification (no code edited). Drafts in `.epiccodereview/20260623T013020Z/global/adr_draft/`.

## ADR DRAFT (global): CFA pattern is represented three incompatible ways across the RAW front-ends
- File: .epiccodereview/20260623T013020Z/global/adr_draft/cfa-pattern-three-representations.md
- Recommends: Promote one shared `Cfa` phase type that every front-end populates; ORF must carry explicit CFA phase instead of silently assuming RGGB (kernels are already phase-aware — gap is type ownership).
- Reversible: partial

## ADR DRAFT (global): Tone-matrix math has two independent scalar implementations kept byte-identical by hand
- File: .epiccodereview/20260623T013020Z/global/adr_draft/tone-matrix-two-scalar-implementations.md
- Recommends: Extract per-pixel tone kernel into one `#[inline]` fn consumed by both the LUT-builder tail (pipeline.rs) and the SIMD scalar tail (tone_simd.rs).
- Reversible: yes

## ADR DRAFT (global): No unified RAW decode entry point — every caller sniffs format and picks a different function
- File: .epiccodereview/20260623T013020Z/global/adr_draft/no-unified-raw-decode-entry-point.md
- Recommends: Introduce a single `decode_raw(&[u8]) -> RawFrame` dispatcher absorbing the hand-assembled ORF glue.
- Reversible: partial

## ADR DRAFT (global): Endian readers and IFD tag-value extractors are reimplemented in all three TIFF-family parsers
- File: .epiccodereview/20260623T013020Z/global/adr_draft/duplicated-tiff-endian-ifd-readers.md
- Recommends: Extract a shared `tiff_io` module (endian-aware bounds-checked readers + typed tag accessor) for tiff.rs/cr2.rs/dng.rs.
- Reversible: yes

## ADR DRAFT (global): The fused decode→black-subtract→demosaic band path exists only for DNG
- File: .epiccodereview/20260623T013020Z/global/adr_draft/fused-decode-demosaic-only-dng.md
- Recommends: Extend the fused band decode+demosaic peak-memory path to CR2 and ORF behind the unified `decode_raw` entry.
- Reversible: yes

## ADR DRAFT (global): Rich capture provenance is parsed but never embedded into the encoded JXL
- File: .epiccodereview/20260623T013020Z/global/adr_draft/capture-provenance-not-embedded-in-jxl.md
- Recommends: Add structured metadata input to EncoderOpts and embed EXIF/XMP boxes.
- Reversible: yes

## ADR DRAFT (global): Perceptual kernels are hand-written four times with only pairwise parity tests
- File: .epiccodereview/20260623T013020Z/global/adr_draft/simd-kernels-four-way-parity-contract.md
- Recommends: Add tolerance-parameterised cross-backend parity harness; real gap is wasm (avx512 already tested) — pin wasm scale_err/pixels_to_xyb/ssim_moments against oracle.
- Reversible: yes

## ADR DRAFT (global): XYB transform and Butteraugli pyramid are crate-private
- File: .epiccodereview/20260623T013020Z/global/adr_draft/xyb-engine-not-exposed.md
- Recommends: Expose minimal public `pixels_to_xyb` + pyramid accessor for downstream ML/recognition.
- Reversible: yes

## ADR DRAFT (global): Sensor-sharpening matrix B is a fixed constant with no illuminant input
- File: .epiccodereview/20260623T013020Z/global/adr_draft/sensor-sharpen-matrix-fixed-no-illuminant.md
- Recommends: Thread optional per-camera `sensor_b` + WB-derived illuminant into constancy path (const as default).
- Reversible: yes

## ADR DRAFT (global): PerceptualGrid is hardcoded to scale=1.0 and silently drops saturation/vibrance
- File: .epiccodereview/20260623T013020Z/global/adr_draft/perceptualgrid-hardcoded-scale-drops-saturation.md
- Recommends: Give the grid a sat/vib dimension (thread-local rebuild keyed on sat/vib bits, like LutCache) or 4D LUT.
- Reversible: partial

## ADR DRAFT (global): Camera-to-sRGB colour policy is scattered with no single owner
- File: .epiccodereview/20260623T013020Z/global/adr_draft/camera-to-srgb-colour-policy-scattered.md
- Recommends: Introduce a `ColourPolicy` resolver with explicit precedence (embedded matrix → per-make table → CAM_TO_SRGB).
- Reversible: yes

## ADR DRAFT (global): FrameStats content-hash is exact; a perceptual/LSH hash would enable change detection
- File: .epiccodereview/20260623T013020Z/global/adr_draft/framehash-perceptual-lod-change-detection.md
- Recommends: Add coarse perceptual/LSH hash (downsampled XYB sign bits) alongside exact hash for time-lapse change triage.
- Reversible: yes

## ADR DRAFT (global): EXR scene-referred HDR is clamped at ingest before the constancy engine
- File: .epiccodereview/20260623T013020Z/global/adr_draft/exr-hdr-clamped-before-constancy-engine.md
- Recommends: Carry scene-referred HDR f32 through log-Euclidean constancy/tone engine, tone-map last, gated on HDR input.
- Reversible: partial

## ADR DRAFT (global): apply_perceptual_constancy supports layer-aware blending but has no bulk/SIMD entry
- File: .epiccodereview/20260623T013020Z/global/adr_draft/perceptual-constancy-no-bulk-simd-entry.md
- Recommends: Add `apply_perceptual_constancy_bulk` over SoA planes (mirroring perceptual_apply_bulk).
- Reversible: yes

## ADR DRAFT (global): The 4-wide tone path delegates the constancy branch to 4 scalar calls
- File: .epiccodereview/20260623T013020Z/global/adr_draft/perceptual-grid-not-simd-in-tone-math4.md
- Recommends: Implement wasm v128 / AVX trilinear grid gather for the constancy branch of apply_tone_math4.
- Reversible: yes

## ADR DRAFT (global): The RAW pipeline processes whole frames; a tile/region + LOD entry point is missing
- File: .epiccodereview/20260623T013020Z/global/adr_draft/no-region-decode-lod-entry-point.md
- Recommends: Add `process_region(rgb16, stride, rect, lod)` over the already-pure per-pixel pipeline.
- Reversible: yes

## ADR DRAFT (global): Strategic map — RAW ingest → demosaic → tone/LUT → JXL codec
- File: .epiccodereview/20260623T013020Z/global/adr_draft/strategic-map-raw-ingest-to-jxl.md
- Recommends: Adopt the verified system map as canonical (drift-checked via ecosystem-map-gen); sequence dependent ADRs behind the `decode_raw` keystone.
## EpicCodeReview 20260622T113415Z — deferred direct fixes (global/architecture)

### Q (high, forked-pipeline, cross-file + build-gated) — multi-format detector not wired into the live worker
**Finding:** `architecture-multiformat-not-wired-live` (`G-architecture-multiformat-not-wired-live`).
**File:** `web/format-detect.js` (target) + `web/worker.js` (the real fix site).
`web/format-detect.js` exports `detectFormat(bytes, name)` -> `'raw'|'jxl'|'sdr'|'tiff'|'exr'|'unknown'` and is imported only by `web/jxl-benchmark.js`. The live app worker (`web/worker.js:41-51`, `pickRawDecoderWithFlags`) re-implements its own magic-byte-only RAW sniffer (ORF/CR2/DNG, ORF fallback) and never imports the detector. They diverge on `.arw/.nef/.rw2/.raw` (extension-only in `format-detect.js`) and on EXR/TIFF/SDR.
**Why deferred:** Wiring requires editing `web/worker.js` (out of single-file task scope) AND WASM multi-format support — `detectFormat` routes `tiff -> decode_tiff` / `exr -> decode_exr`, entry points the shipped raw-WASM does not export, so the routes would dead-end at runtime. Behavioral + cross-file + build-gated.
**Recommended fix:** Make `format-detect.js` the single source of truth (add `pickRawDecoder(bytes,name)` reproducing the worker's magic verdicts), wire `worker.js` to call it behind a parity test, decide the unrecognized-RAW fallback policy, and enable `tiff/exr` only once the WASM exports them. See ADR draft `raw-magic-byte-classification-...` and `strategic-map-...`.

### Q (high, missing-route, build-unverified) — lightbox full-decodes large tiled pyramid levels instead of pooled tiled decode
**Finding:** `architecture-lightbox-no-tiled-decode` (`G-architecture-lightbox-no-tiled-decode`).
**File:** `web/lightbox/pyramid-lightbox.js` `loadLevel` (L491-556).
`loadLevel` always runs a single-pass scheduler decode (`ctx.decode({format, sourceKey, priority:'visible', emitEveryPass:false, progressionTarget:'final'})`, L500-508) and never inspects `entry.tiled`. Large tiled levels therefore fully decode rather than decoding only the viewport. The grid path routes correctly: `web/pyramid-gallery/pyramid-decode.js` `decodePyramidLevel(ctx, bytes, {tiled, region})` (L12-16) branches on `opts.tiled` and calls the pooled **`decodeTiledViewportPooled`** (dynamic import from `packages/jxl-pyramid/dist/tiled-decode-pool.js`), using the worker at `web/lightbox/tiled-decode-worker.js`.
**Why deferred (build-unverified):** Behavioral fix exercised only by real WASM tiled decode in a real browser (worker/OPFS/canvas) — not unit-testable here (skill 5b). Also, the lightbox currently assumes `levelPixels` covers the whole level (`offscreen.width = levelInfo.w`, crossfade/pan/`reapplyToOffscreen` all full-level); switching to viewport-region pixels changes the offscreen/crossfade model and risks regressing the non-tiled path — beyond a minimal local edit.
**Recommended fix:** When `entry.tiled`, compute the current viewport region from `zoom`/pan against `entry.w`/`entry.h` and route through `decodePyramidLevel(ctx, bytes, {tiled:true, region, format, priority:'visible'})` (i.e. the pooled `decodeTiledViewportPooled`), adapting the offscreen/crossfade to region-sized pixels; fall back to the existing single-pass decode when not tiled. Verify visually on a large tiled pyramid level. See ADR/strategic-map context.

---

## Run `epiccodereview/20260622T113415Z` — web worker fixers (deferred)

### `web/jxl-correlation-worker.js` (c) — prefix-probe O(steps²) re-feed (PERF, DEFER)
**File:** `web/jxl-correlation-worker.js` `probeMinBytesToFirstProgress` (L32-80).
For each of up to 50 cut points the probe builds a fresh `'passes'` decoder and re-feeds `full.subarray(0, cut)` from byte 0. Because each `decoder.push` decodes the whole prefix, total work is O(steps²) in bytes decoded (~50 full re-decodes of growing prefixes). For ref-sized images this is tolerable, but it dominates the post-encode metrics pass for larger streams.
**Why deferred:** Pure perf; correctness is fine. A correct rewrite (single incremental decoder fed once, sampling fed-bytes at each progress event — like the natural-chunk loop already does) changes the probe's semantics (natural-chunk boundaries vs uniform % cut points) and needs measurement to confirm the win and that it still reports the *minimum* prefix. Runtime-only; not unit-testable in this harness (skill 5b).
**Measurement command a human should run (browser/worker):** wire `probeMinBytesToFirstProgress` into `flipflopdom` against a real progressive JXL codestream and compare decoded-bytes + wall-time for (A) current per-cut re-feed vs (B) single incremental decoder; e.g. `flipflopdom` test feeding a 200KB–2MB progressive stream at the 50-step grid.

### `web/jxl-decode-worker.js` (a) — extractEmbeddedJpegs per-byte JS scan (PERF, DEFER)
**File:** `web/jxl-decode-worker.js` `extractEmbeddedJpegs` (L43-62).
Two nested per-byte JS loops scan the whole container for SOI/EOI markers. Only runs for JXTC reconstruction containers, but is O(n) byte-at-a-time JS over potentially multi-MB buffers.
**Why deferred:** Low-value perf; not trivial to speed up correctly (marker scan must stay byte-exact for FFD8FF / FFD9). Runtime-only (skill 5b).
**Measurement command:** `flipflopdom` A/B the scan (current byte loop vs e.g. `indexOf`-on-typed-array marker search) over a real JXTC container in a worker.

### `web/jxl-decode-worker.js` (b) — progressive header+partial but never 'final' (NO CHANGE)
**File:** `web/jxl-decode-worker.js` `decodeProgressive` events loop (L196-219).
The "never reaches final" case is **already guarded**: the events drain throws `new Error('No final JXL frame decoded')` when `!sawFinal` (L218), which propagates out of `decodeProgressive` and triggers the jsquash fallback in `onmessage` (L244-248). No additional safe local guard adds value without changing the fallback contract.
**Disposition:** No change; existing guard is correct.

### `web/jxl-byte-cutoff-probe.js` (a) — TRANSPORT_PROFILES fork vs jxl-byte-utils.js (DEFER, cross-file)
**File:** `web/jxl-byte-cutoff-probe.js` L15-20 / `resolveTransportProfile` L127-139, vs `web/jxl-byte-utils.js` L3-23.
The two `TRANSPORT_PROFILES` maps have **divergent shapes**: byte-utils adds a `name` field and renames the diagnostic preset key `'diagnostic'` → `'diagnostic-passes'`. The probe's own test (`jxl-byte-cutoff-probe.test.js` L107-110) asserts `Object.keys(TRANSPORT_PROFILES).sort() === ['3g','diagnostic','lte','wifi']` — i.e. it requires the key `'diagnostic'`, which byte-utils does NOT export. Importing byte-utils' map would break this test.
**Why deferred:** Reconciling cannot be done within this file alone — it requires editing `jxl-byte-utils.js` (restoring a `'diagnostic'` alias / aligning shapes) and/or updating the test, both cross-file. Out of scope per fixer rules (cross-file → DEFER).
**Recommended fix:** Decide the canonical shape (likely byte-utils with `name`), add a `'diagnostic'` alias key there, then have the probe `import { TRANSPORT_PROFILES, resolveTransportProfile } from './jxl-byte-utils.js'` and update the probe test's diagnostic expectation. Single-owner module reconciliation.

---

## 000-structure-crop-sidecar-save-swallow (residual) — web/crop.js
**Section:** 000  **File:** `web/crop.js` `triggerSidecarSave` (L312-320)  **Finding:** `structure-crop-sidecar-save-swallow`.
**Applied (local/safe):** Replaced the empty `.catch(() => {})` with `console.error('[crop] sidecar save failed', ...)` so a failed persist after Apply is no longer entirely invisible.
**Deferred (runtime/cross-file):** A genuine *user-visible* signal (toast/inline error / re-enable of the Apply affordance) requires a UI notification facility that lives outside crop.js (e.g. a shared toast helper / panels.js). Surfacing it would mean editing another file — deferred per one-writer/own-files rule.
**Recommended:** On save rejection, route through the app's existing notification mechanism (whatever panels.js/main.js use) to tell the user the crop/subject edits were NOT persisted, and optionally keep the editor open.

## 000-structure-crop-subjectthumb-async-unmount (residual) — web/crop.js
**Section:** 000  **File:** `web/crop.js` `renderSubjectThumb` (L730-775) + call site (L687-692).  **Finding:** `structure-crop-subjectthumb-async-unmount`.
**Applied (local/safe):** (a) Added `if (!parentCard.isConnected) return;` after the unabortable `await window.decodeFullJxlFor(parentCard)` so we don't paint into a torn-down card. (b) Replaced the call-site `.catch(() => {})` with `console.error(...)` so a decode rejection no longer silently yields a blank thumbnail.
**Deferred (runtime, browser-gated):** The rapid re-entry race — a decode resolving against a *freshly rebuilt* sibling set with the same `cardId` — is only observable against real WASM JXL decode + DOM teardown timing (skill 5b). A robust fix needs a per-render generation token / AbortController threaded through `decodeFullJxlFor`, which is owned elsewhere (main.js exposes `window.decodeFullJxlFor`). Cross-file + browser-verifiable → deferred.
**Recommended:** Stamp `parentCard._subjectRenderToken = Symbol()` at rebuild, capture it before the await, and bail if it changed after the await; and/or make `decodeFullJxlFor` cancellable.

## 000-structure-filepicker-bytes-in-idb (residual) — web/jxl-file-picker.js
**Section:** 000  **File:** `web/jxl-file-picker.js` `saveLastFiles` (L51-78) / `loadLastFiles`.  **Finding:** `structure-filepicker-bytes-in-idb`.
**Applied (local/safe):** Added a `MAX_PERSIST_BYTES` (32 MB) per-selection budget: files within budget persist `bytes`, the rest store metadata only; `loadLastFiles` filters out byte-less records. This bounds per-key growth (the unbounded multi-MB-RAW accumulation in the finding).
**Deferred (runtime, browser-gated):** True *eviction* across keys / global IDB quota management (LRU over the whole store, `QuotaExceededError` recovery, reacting to `navigator.storage.estimate()`) needs real IndexedDB + storage-quota behavior to verify (skill 5b), and the 32 MB threshold is a heuristic without measurement. Left as a single-selection cap only.
**Recommended:** Add cross-key LRU eviction keyed by `lastUsed`, handle `QuotaExceededError` on `store.put` by dropping oldest keys, and consider a configurable budget.

---

## 000-structure-compare-race-cancel-inflight (residual) — web/jxl-compare.js
**Section:** 000  **File:** `web/jxl-compare.js` `runFormatRaceAtSize` (L193-262).  **Finding:** `structure-compare-race-cancel-inflight`.
**Applied (local/safe):** Added two within-file `thisRunId !== runId` stale-run guards — one at function entry (before the heavy downscale) and one after the downscale (before the first encode) — so a superseded run bails before starting heavy work. The post-await checks after each codec already existed.
**Deferred (cross-file):** Truly *aborting* the in-flight `encodeAsJxl` / `decodeJxl` / `encodeViaToBlob` / `decodeNative` calls needs an `AbortSignal` threaded into those helpers (and into the session decode path / `toBlob` / `createImageBitmap`, which live in other modules). Per the one-file rule this is deferred. The same unabortable-codec posture remains for the in-flight cell in `web/jxl-encode-space.js` (`runSweep`) and the in-flight region/full decodes in `web/jxl-crop-benchmark.js` (`decodeTileRegion` / `decodeContainerRegion` / `decodeFullThenCrop`); both got within-file post-await `signal.aborted` re-checks that discard the stale result, but the running op itself cannot be interrupted without signal-threading into the decode helpers.
**Recommended:** Thread a shared `AbortSignal` from the run/sweep controller through the encode/decode helpers; for browser codecs (`toBlob`/`createImageBitmap`) wrap in a cancellable promise that rejects on abort.

## ADR DRAFT from task 000-structure-benchmark-results-map-per-metric
- Topic: benchmarkResults is six parallel per-metric Maps all keyed by one shared composite string (AoS→SoA layout)
- File: web/jxl-benchmark.js:327-334
- ADR: .epiccodereview/20260622T113415Z/sections/000/adr_draft/benchmark-results-aos-to-soa.md
- Recommends: Collapse the six per-metric Maps into one Map<compositeKey, ResultRecord> so each tuple is addressed/keyed once instead of six times (flipflop-gated if claimed as perf).
- Reversible: yes

## ADR DRAFT from task 000-structure-benchmark-downscale-rgb-double-alloc
- Topic: downscaleRgbCanvas fallback allocates a full RGBA expansion in and an RGB contraction out around the canvas (two full-frame copies)
- File: web/jxl-benchmark.js:905-924
- ADR: .epiccodereview/20260622T113415Z/sections/000/adr_draft/benchmark-downscale-rgb-double-alloc.md
- Recommends: Reuse scratch buffers or use createImageBitmap resize to drop the RGB↔RGBA bridge copies on the WASM-absent fallback path (flipflopdom-gated, output parity).
- Reversible: partial

## ADR DRAFT from task 000-hacker-xyb-sqrt-recompute
- Topic: computeButteraugliRegion recomputes the s=0 reference-Y mask box-blur twice per call (max-error pass + multi-scale s=0)
- File: web/jxl-butteraugli.js:334-390 (dup blur at :369 vs :309)
- ADR: .epiccodereview/20260622T113415Z/sections/000/adr_draft/butteraugli-region-redundant-mask-blur.md
- Recommends: Pass the precomputed full-scale mask into _multiScaleScore's s=0 branch to remove one separable box-blur (flipflop-gated, score/maxError/location parity).
- Reversible: yes

## ADR DRAFT from task 000-hacker-probefullbuf
- Topic: probeMinBytesToFirstProgress re-creates a fresh decoder and re-decodes a growing prefix from byte 0 per cut point (O(steps²) decode work)
- File: web/jxl-correlation-worker.js:32-80 (related re-feed at :171-231)
- ADR: .epiccodereview/20260622T113415Z/sections/000/adr_draft/correlation-worker-probe-quadratic-redecode.md
- Recommends: Fold the probe into a single incremental decode (reuse the existing first-event byte count) instead of re-decoding from 0 per cut (flipflopdom-gated, minBytes parity; verify decoder continuation semantics).
- Reversible: partial

## ADR DRAFT from task 000-hacker-jpegscan
- Topic: extractEmbeddedJpegs does a per-byte JS scan over the whole container to find SOI/EOI markers on the decode hot path
- File: web/jxl-decode-worker.js:43-62
- ADR: .epiccodereview/20260622T113415Z/sections/000/adr_draft/decodeworker-jpegscan-perbyte.md
- Recommends: Replace hand loops with indexOf/lastIndexOf (memchr) marker search, preserving exact blob output (flipflop-gated, byte-identical blobs over a JXTC corpus).
- Reversible: yes

## ADR DRAFT from task 000-structure-decodeworker-finalcopy
- Topic: final progressive frame is fully copied so jxl_progress and jxl_decoded each transfer (detach) their own buffer
- File: web/jxl-decode-worker.js:187-193
- ADR: .epiccodereview/20260622T113415Z/sections/000/adr_draft/decodeworker-final-frame-double-buffer.md
- Recommends: Determine whether both consumers truly transfer; if not, send one transferred + one structured-cloned to drop the explicit copy — else document the copy as the intentional minimum for two detaching consumers (flipflopdom-gated, event+pixel parity). May be intentional.
- Reversible: partial

## ADR DRAFT from task 000-hacker-recolor-querysel
- Topic: recolorMatrixCells re-scans the whole cache and does an attribute querySelector per cell on every cell completion (O(N²) DOM lookups)
- File: web/jxl-encode-space.js:575-592
- ADR: .epiccodereview/20260622T113415Z/sections/000/adr_draft/encodespace-recolor-quadratic-dom.md
- Recommends: Cache cell element refs + maintain min/max incrementally so the common completion is O(1) and full recolor (cached refs, no querySelector) runs only on a new extreme (flipflopdom-gated, final color parity).
- Reversible: yes

## ADR DRAFT from task 000-hacker-presetdummybuf
- Topic: createProgressiveWebPreset allocates two 1MB dummy buffers + a cursor loop to reproduce a static power-of-2 cutoff sequence
- File: web/jxl-progressive-best-preset.js:97-119
- ADR: .epiccodereview/20260622T113415Z/sections/000/adr_draft/bestpreset-dummy-buffer-simulation.md
- Recommends: Replace the simulation with the closed-form `for (t=1024; t<500K; t*=2) push(t)` and drop the 2MB throwaway allocations (cutoffs element-identical). Note: a sibling direct_fix may already remove this; ADR captures the why-closed-form-is-correct rationale.
- Reversible: yes

## ADR DRAFT from task 001-structure-coordinator-double-filter
- Topic: getVisibleCount materializes the Map then filters twice and spreads Math.min/max over arrays (3 intermediate arrays per dirty recompute)
- File: web/jxl-progressive-gallery-coordinator.js:15-46
- ADR: .epiccodereview/20260622T113415Z/sections/001/adr_draft/coordinator-getvisiblecount-double-filter.md
- Recommends: Replace with a single-pass accumulator (openCount/minOpen/maxClosed), preserving the exact output branches and dirty cache (flipflopdom-gated, >=5% with count parity).
- Reversible: yes

## ADR DRAFT from task 001-structure-session-encode-decode-decoupled
- Topic: setBackend/setEncodeBackend/setDecodeBackend allow silently divergent encode vs decode backends; `backend` getter silently aliases the encode side
- File: web/jxl-progressive-session.js:38-47
- ADR: .epiccodereview/20260622T113415Z/sections/001/adr_draft/session-encode-decode-backend-invariant.md
- Recommends: Make the encode/decode coupling explicit — document the split + clarify/rename the `backend` getter (no runtime "compatibility guard": JXL bytes are backend-agnostic, so no real incompatible pairing exists).
- Reversible: partial

## ADR DRAFT from task 001-structure-prog-card-mixed-concerns
- Topic: card object conflates immutable DOM bindings with ~16 dynamically-attached per-run mutable fields; resetCard clears them manually (with redundant double-clears)
- File: web/jxl-progressive.js:63-78 (reset 247-280)
- ADR: .epiccodereview/20260622T113415Z/sections/001/adr_draft/progressive-card-state-separation.md
- Recommends: Move transient fields into one RunState sub-object (freshRunState() factory) or a WeakMap keyed by card.el so reset is a single reassignment and "forgot to reset field X" is structurally impossible.
- Reversible: yes

## ADR DRAFT from task 001-structure-single-pass-pixels-retention
- Topic: all pass RGBA buffers retained until post-decode thinning (64MB budget); ~220MB transient peak on long high-res runs (P7 memory budget)
- File: web/jxl-single-progressive.js:1514-1532
- ADR: .epiccodereview/20260622T113415Z/sections/001/adr_draft/single-progressive-pass-pixel-retention.md
- Recommends: Stream stats-then-release per pass to cap peak live bytes, preserving the retained-pass set + per-pass frameHash/stats + all CSV/JSON/TOON/MD exports (flipflop/flipflopdom-gated, memory win with full export parity). Diagnostic-only path.
- Reversible: partial

## ADR DRAFT from task 001-hacker-dsnearest-colhoist
- Topic: downsampleRgbaNearest recomputes the row-invariant source-X (div/floor/min) map for every output row
- File: web/jxl-single-progressive.js:1792-1809
- ADR: .epiccodereview/20260622T113415Z/sections/001/adr_draft/downsamplergbanearest-column-lut-hoist.md
- Recommends: Precompute an Int32Array sxOff[targetWidth] (sx*4) once before the y loop; inner loop becomes table read + 4 copies (flipflopdom-gated, >=5%, MUST be byte-identical).
- Reversible: yes

## ADR DRAFT from task 001-structure-wrapper-buffer-helper-naming
- Topic: exactBuffer and transferableBuffer are identical contiguous-copy helpers; neither transfers, so the "transferable" name is a false boundary signal
- File: web/jxl-wrapper-lab.js:714-723
- ADR: .epiccodereview/20260622T113415Z/sections/001/adr_draft/wrapper-buffer-helper-naming.md
- Recommends: Collapse to one honestly-named helper (e.g. contiguousBuffer) keeping the ArrayBuffer fast-path; reserve "transferable" for sites that actually add the buffer to a postMessage transfer list.
- Reversible: yes

---

# EpicCodeReview 20260623T013020Z — crates/raw-pipeline/src — section (root)

19 confirmed findings. 9 fixed in-place (commit follows). Deferrals below.

## DEFERRED (uncertain — verifier could not resolve from in-crate code)
- jxl_casadecoder.rs:~440 — Non-partial decode path `set_len`s the output buffer to `elems` and trusts libjxl to fully fill it; if libjxl returns S_FULL with a partially-written bound buffer, uninitialised memory ships as pixels. Hinges on libjxl's internal fill contract (out of crate). Need: confirm libjxl guarantees full fill on S_FULL, or zero-init the buffer before SetImageOutBuffer.
- pipeline.rs:~1032 — Texture + clarity unsharp run as two full read-modify-write passes; fusing into one traversal needs a 4th BLUR_SCRATCH buffer and only helps the both-sliders-active path. perf_sensitive — needs a flipflop A/B before commit (gate ≥5%).

## DEFERRED (direct-fix attempted → cross-file / contract / FFI)
- cr2.rs:478-496 — CR2 WB silently defaults to magic 2.0/1.7 on missing/garbled MakerNote, no caller signal. Fix needs a `wb_from_camera: bool` on `Cr2Image` + a colour-fallback policy decision in src/lib.rs (use auto_wb_rggb? warn? bail?) — colour intent, author's call. Suggested: add the bool, decide fallback in lib.rs.
- casabio_encode.rs:188-216 — `encode_variants_cancellable` polls cancel only between variants, never inside the dominant EFFORT_FULL libjxl encode. A cooperative mid-encode cancel hook requires an FFI/libjxl callback change (build-gated, cross-boundary). Defer to ADR.
- decompress.rs / demosaic.rs:12-28 — public APIs return `Result<_, String>` while parsers use anyhow and codecs use thiserror; one decode chain crosses three error idioms (substring-matched, lost categories). Fix is a cross-file signature refactor touching all callers. Defer; see also the global ColourPolicy/error-taxonomy theme.
- jxl_casadecoder.rs:572/724/951 — three hand-rolled libjxl driver loops (run_full_into / run_progressive_into / decode_progressive_frames_borrowed) with LOAD-BEARING divergence (free-fn uses DecodeLimits::default() not self.opts.limits, saturating_mul vs checked_mul, resize vs reserve+set_len, raw handle vs Decoder). Safe extraction requires deliberately unifying the limits source (a behavior change for the free-fn). Structural debt, not a live bug — defer to intentional-unification ADR.

## DEFERRED ADR-draft opportunities (section-level)
- image_formats.rs:63-74 — `f32_linear_to_srgb8` does per-channel `powf(1/2.4)` per pixel; pipeline.rs already proves a clamp+gather+lerp over the cached SRGB_ENCODE LUT is byte-identical on u8 output. Wire the existing LUT into this EXR/HDR→display kernel. perf_sensitive (flipflop-gate). Strongest perf opportunity in the section.
- image_formats.rs:13-22 — `DecodedRgba` is an untagged union (three always-allocated Vec<u8/u16/f32> + bit_depth tag); "exactly one set" lives only in a doc comment. Replace with a 3-variant enum (Rgba8|Rgba16|RgbaF32) to make the invariant compile-enforced.
- ljpeg.rs / cr2.rs / dng.rs / tiff.rs — no fuzz/property harness over the untrusted-byte parsers despite many hand-added overflow guards; a per-parser cargo-fuzz target (decode_bytes, decompress, ljpeg::decode_tile, tiff::parse) would cheaply catch this bug class. (Live example of the class: dng::read_ascii inline `cnt<=4` branch indexes without bounds check — see global tiff_io ADR.)
- tiff.rs:559-592 — `visit_ifd` is a shared zero-alloc walker, but the Olympus sub-IFD parsers + cr2.rs/dng.rs hand-roll their own IFD loops with divergent bounds policies (dng inline read_ascii unchecked). Route them through visit_ifd. Overlaps the global `duplicated-tiff-endian-ifd-readers` ADR.
- pipeline.rs:1060-1073 — parallel clarity branches recompute `orig/65535.0` (f32 div, not auto-reciprocated) + `4*v*(1-v)` per element while the serial branch hoists norm_4/clarity_factor; copy the hoisted form into the parallel closures (native throughput path). perf_sensitive (flipflop-gate).

---

# EpicCodeReview 20260623T013020Z — crates/raw-pipeline/src — sections bin + perceptual

Section bin (gen_fractal.rs): io-panic-on-save fixed (main → Result, `?` on save()). Aspect-ratio squash (256² grid over 3.5×2.5 window) is cosmetic — WONTFIX. Section perceptual: 27 confirmed; butteraugli() OOB panic on 1×N images FIXED (+regression test). Remaining deferred below.

## DEFERRED (build-gated — need the node bench-wasm / wasm harness; wasm intrinsics can't run under `cargo test` on x86)
- perceptual/wasm.rs — HIGH: `scale_err_wasm` and `pixels_to_xyb_wasm` have NO scalar-parity assertion anywhere (in-crate or bench-wasm); only `downsample_wasm` is pinned in-crate and `ssd_wasm`/`ssim_moments_wasm` in bench-wasm. These are the f32-reassociation-prone kernels most likely to drift. ACTION: add `scale_err`/`pixels_to_xyb` parity cases to the bench-wasm node harness (the only place wasm intrinsics execute), assert vs scalar oracle within ΔE/tolerance. Overlaps global `simd-kernels-four-way-parity-contract` ADR.
- perceptual/wasm.rs — `scale_err_wasm` drains its f32 accumulator on a different cadence (16384) than avx2/avx512 (32768/65536); f64 partials are not bit-identical to the oracle (acknowledged in-source, untested). Verify within tolerance via the harness; align cadence if it drifts.
- perceptual/wasm.rs — `ssim_moments_wasm` has no SIMD-tail loop; correctness relies on FLUSH never firing before `np` and on lane order; untested vs scalar. Needs harness parity over non-multiple-of-lane sizes.
- perceptual/wasm.rs — `ssim_moments_wasm` uses `v128_load32_zero` on a `*const u32` cast from a `u8` pointer (unaligned); confirm wasm unaligned-load semantics hold (likely fine — wasm allows unaligned), low.

## DEFERRED ADR-draft / structural (perceptual)
- perceptual/simd/mod.rs — backend dispatch is five independent hand-written `match self.backend` blocks (fill_test_xyb/ssim/psnr/scale_err_dispatch/downsample_one); four backends kept in lockstep by reviewer diligence only, signatures not even uniform (scale_err takes `rsqrt_path: bool` on x86, wasm collapses it). No dispatch table / kernel-set trait. ADR: introduce a Kernel trait or dispatch table to enforce signature lockstep. Overlaps global SIMD-parity ADR.
- perceptual/telemetry.rs — runs a SECOND, disjoint dispatch scheme (inline feature-detect, own avx2 kernel, no wasm/avx512 path) ignoring the `Backend` enum. Unify with the primary dispatch.
- perceptual/simd/mod.rs — `resolve_forced_backend` hard-codes Backend discriminant integers (id==4 == WasmSimd) instead of deriving from the enum; brittle. Low.
- perceptual — three/four near-identical scalar 2× box-downsample bodies (downsample_inplace, butteraugli::dn2, test-side) with inconsistent edge-clamp idiom (`.min(h-1)` vs `if sy0+1<h`) — silent-drift surface. Dedup behind one helper.
- perceptual/simd/mod.rs — blur (mask) stage has no SIMD backend (always scalar box_blur); rsqrt SIMD paths never reached (auto selection passes prefer_rsqrt=false); AVX-512 PSNR + rsqrt distinction collapse to other kernels at dispatch (enum carries more states than kernels honour). perf/structural, low — measure before acting.
- perceptual/simd/avx2.rs — scalar SSIM oracle `ssim_moments_avx2` lives in the avx2 module wearing an unneeded `#[target_feature]`; third copy of the moment loop. Move to scalar module.
- perceptual — opportunity: NO unified cross-backend parity harness pinning all kernels × all 4 backends to the scalar oracle + property tests on metric invariants (identical images → score 0). Umbrella for the wasm gaps above; overlaps global SIMD-parity ADR.

## DEFERRED (low correctness — deferred to avoid changing established metric output)
- perceptual/ssim.rs `finalize_ssim` — denominator/variance not clamped non-negative; pathological inputs could underflow. Deferred: a clamp could shift existing SSIM values and risk the parity contract — needs a parity check before landing.
- perceptual/simd/mod.rs `Metrics::all()` — returns f32::NAN for butteraugli/ssim/psnr on a short buffer but zeroed Comparer moments; mixed sentinel inconsistency. Low; pick one sentinel convention.
- perceptual/psnr.rs — PSNR averages MSE over the full RGBA byte buffer INCLUDING alpha, inflating dB on opaque images. Verifier confirmed this is a DOCUMENTED legacy-JS-parity choice — changing it breaks JS parity. Leave unless JS parity is dropped.
## Section 001 — fixer deferrals (run 20260622T113415Z)

### Frame-store unification (web/jxl-progressive-gallery.js)
- Finding: 001-structure-coordinator-frames-sparse-vs-push
- Two parallel frame stores: `framesByFile` (arrival-order push, read by lightbox as `frames[frameIndex]`) vs coordinator `entry.frames[frameIndex] =` (sparse). Consistent only by the per-file monotone `frameIndex` counter pushed in lockstep.
- LANDED: a local defensive guard at the register site that logs a `[gallery] frame-store desync` error if push-position !== frameIndex (documents + enforces the invariant; no happy-path behavior change).
- DEFERRED: collapsing to a single store. A real fix removes one of the two stores and routes the lightbox through the coordinator (or vice versa) — cross-file restructuring of jxl-progressive-gallery.js + jxl-progressive-gallery-coordinator.js + lightbox. Out of single-file fixer scope.

### Pre-existing unrelated test failure (web/jxl-progressive-gallery.test.js)
- `bun test web/jxl-progressive-gallery.test.js` reports 9 pass / 1 fail on a CLEAN baseline (verified via git stash) — NOT introduced by this run's edits.
- The failing test asserts stale source strings the current file no longer contains: `progressionTarget: 'final'`, `emitEveryPass: true`, `const chosenDetail = getGalleryProgressiveDetail();`, `progressiveDetail: chosenDetail === 'auto' ? null : chosenDetail`. The file now derives decode opts from `basePreset.decode` + `getGalleryProgressiveDetail()`.
- Action: update the test to match the current preset-based source (or remove the brittle source-string assertions). Not a code bug.

---

## Section 002 — web/main.js (run `epiccodereview/20260622T113415Z`)

Two correct-by-construction fixes were applied directly (varianceBench div-by-zero
guard; `.time` querySelector null-guard). The items below are architectural /
cross-cutting and per the no-go list (do not restructure public state/APIs) are
deferred as design questions rather than unilateral edits.

### QUESTION: startBatchTauri fires loadSidecar() without awaiting before queueing encodes
- `web/main.js` ~3697-3787. The card-creation loop kicks off `loadSidecar(path).then(...)`
  fire-and-forget, then a separate `Promise.allSettled` encode loop runs independently.
  Crop/subject/look sidecar metadata can land **after** `onFileDoneTauri`, so any
  done-time consumer that assumes `card._crop/_subjects`/look is present can race.
- Why deferred: a correct fix must gate encode dispatch on sidecar load+apply, which
  re-sequences batch timing (first-pixel latency, progress UI) — a behavioral change
  needing in-browser verification, not a local correct-by-construction edit.
- Decision needed: should sidecar load block the per-file encode, or should
  `onFileDoneTauri` defensively re-read/merge sidecar state when it arrives late?

### QUESTION: WorkerPool task lifecycle is ad-hoc mutable flags with no cancellation
- `web/main.js` ~668-778. `submit`/`_releaseWorker`/`_release` manage tasks via mutable
  fields (`t.released`, `workerForTask` map, `worker._taskIds` Set) with no state enum,
  no `cancel()` path, and no propagation of UI-level cancel (lightbox close / card delete)
  into the worker. Re-submitting a card does not first clear its prior taskId; ordering of
  `workerForTask` delete vs `_releaseWorker` is fragile under late `done`/`error_live`.
- Why deferred: redesigning the task lifecycle into an explicit FSM + cancel propagation
  changes the public WorkerPool API and shared state shape — out of scope for a local fix.
- Decision needed: introduce an explicit task-state enum + `cancel(id)` that tears down
  worker assignment and propagates from lightbox-close / card-delete?

### QUESTION: _jxlDecodeCallbacks listener arrays grow without per-listener removal
- `web/main.js` ~561-626, ~814-829. `_jxlDecodeCallbacks: Map<decodeId,{url,listeners:[]}>`;
  dedupe pushes a new listener onto an existing entry and the entry is dropped only on the
  terminal message. There is no API to remove a single listener when its card unloads or
  its lightbox closes, so a `guard()`-rejected listener lingers for the entry's lifetime.
- Why deferred: adding an unsubscribe path touches the decode dedupe protocol / public
  listener contract — cross-cutting, not a local guard.
- Decision needed: add a per-listener unsubscribe (returned from the register call) tied to
  card/lightbox teardown?

### QUESTION: Lightbox live-update in-flight flag + pending decodes not cancelled on close
- `web/main.js` ~911-967, `closeLightbox` ~2757. `closeLightbox` sets `lightboxIndex=-1`
  but does not reset `liveInFlight`/`livePendingLook` nor cancel queued JXL decodes; pending
  callbacks only `guard()`-filter at the consumer, so the worker still does (wasted) work and
  a stale `liveInFlight` can defeat debounce on the next open.
- Why deferred: correct cancellation must propagate into the scheduler (not filter at the
  consumer) — a state-machine/protocol change requiring browser verification.
- Decision needed: have `closeLightbox` reset live-update state and cancel in-flight/queued
  live decodes at the scheduler?

### QUESTION: Per-file state stored as ~30 dynamically-added _-prefixed fields on the card DOM element
- `web/main.js` ~1013-1091, ~1666-1672, plus writes from `tauri-pyramid-client.js`,
  `tauri-parity-lightbox.js`, reads from `panels.js`. The card `HTMLElement` doubles as the
  untyped per-file model (`_file`, `_taskId`, `_lightbox`, `_thumb*`, `_wb`, `_crop`,
  `_subjects`, `_tauriResult`, `_sensorW/H`, …) with no schema and DOM lifetime == model lifetime.
- Why deferred: extracting a typed per-file model and migrating all cross-file readers is a
  large refactor that changes the shared data contract.
- Decision needed: introduce a `FileState` record keyed off the card (e.g. a WeakMap or a
  single `card._state` object) as the single source of truth?

### QUESTION: card._lightbox is an untagged union across WASM / Tauri / embedded-JPEG modes
- `web/main.js` ~1666-1672 (WASM `{rgb,w,h,nativeW,nativeH,orientation}`) vs ~3620-3626
  (Tauri `{rgb:null,w,h,id,fetching}`). Consumers branch on `_lightbox.rgb` truthiness
  (e.g. ~2313, ~2667) rather than a variant tag, so the Tauri lazy-fetch path is
  distinguished only by a null-pixel check and is easy to mis-branch.
- Why deferred: adding a discriminant and gating every consumer on it is a state-shape change
  across the lightbox paint paths (`sourceMode` exists separately and could seed it).
- Decision needed: add a `kind` discriminant to `_lightbox` and switch consumers to it?

### QUESTION: cardByFilename keyed on basename-only collides across folders
- `web/main.js` ~3536-3541 (used ~3698/3702/3717/3734/3788). Tauri-mode card index keys on
  `path.split(/[\\/]/).pop()` (basename), so same-named files in different directories collide
  and overwrite. It is a second, mode-specific index alongside `cardByTaskId` (~974); neither
  is cleaned when a card is removed from the DOM (stale-entry leak).
- Why deferred: switching the key to the full path (and unifying with `cardByTaskId`) changes
  the lookup contract used by multiple Tauri handlers — cross-cutting, not a local guard.
- Decision needed: key `cardByFilename` on the full path, and add removal on card teardown for
  both indices?

### QUESTION: peepCache stores decoded RGBA + JXL bytes per photo × per quality tier with no eviction
- `web/main.js` ~4391-4410, fills at ~4407/4481-4487, cleared only on exit (~4620). Over a
  session of N photos × ~11 PEEP_PRIORITY tiers the retained decoded-RGBA can reach hundreds
  of MB. No LRU/size bound (Tauri-only benchmark/diagnostic feature, so session-bounded).
- Why deferred: adding eviction requires choosing a bound/policy and threading it through the
  pixel-peep flow — a design choice, not a correct-by-construction edit.
- Decision needed: add an LRU or byte-budget cap to `peepCache` (and drop decoded frames once
  their tier is no longer on screen)?

## EpicCodeReview 20260622T113415Z — section 002 (web/pyramid-gallery*.js) deferrals

### QUESTION: web/pyramid-gallery-grid.js is dead/broken — delete or revive?
- `web/pyramid-gallery-grid.js` is loaded as the SOLE `<script type="module">` on
  `web/pyramid-gallery-grid.html:25`. It **throws ReferenceError at module-evaluation time**:
  line 333 `const origLoadLb = loadIndexAndSeed;` reads an undeclared/unimported binding
  (`loadIndexAndSeed` is neither imported nor declared in the file), so the whole module fails
  to load before any interaction. Its body (lines 22-330: changeZoom/clampPan/
  maybeAutoUpgradeLevel/loadLightboxLevel/openLightbox/prefetchNeighbors/closeLightbox) is the
  OLD inline M2 lightbox already extracted into `web/lightbox/pyramid-lightbox.js` (header note
  line 20: "old duplicate M2 lightbox code removed - see extracted pyramid-lightbox.js"). It
  references ~14 never-declared symbols (`ctx`, `lbZoom`, `lbPanX/Y`, `lbViewW/H`, `lbLevelInfo`,
  `lightboxItem`, `getManifest`, `getLevelBytes`, `lbLRUGet/Set`, `items`, `orderedIds`,
  `getPyramidLightbox`, `log`, `chooseLevelForTarget`, `loadIndexAndSeed`).
- On the "3-arg chooseLevelForTarget" sub-finding: the 3-arg signature `(levels, currentSize,
  targetLong)` is the **intended** one (matches `pyramid-gallery-grid.test.js:6-17` and the live
  `web/lightbox/pyramid-lightbox.js` injected helper used at lines 432/485/657/734). The 2-arg
  `packages/jxl-pyramid/dist/choose-level.js` is a *different* function used by other modules.
  So there is no "fix to 2 args"; the only real defect is the dead/broken module itself.
- The working grid + lightbox today are `web/pyramid-gallery/grid-controller.js` +
  `web/pyramid-gallery/pyramid-gallery.js` + `web/lightbox/pyramid-lightbox.js`.
- Why deferred: a clean local fix is not possible — either **delete** the file (deletion is on
  the no-go list, so a human must approve) or **revive** it (import/declare ~14 symbols and
  reconcile against the already-extracted lightbox = cross-file architectural revival).
- Decision needed: delete `web/pyramid-gallery-grid.js` (+ its `.html` + test if the demo page is
  retired), or revive it by wiring the extracted `createPyramidLightbox` and removing the dead
  inline body?

### QUESTION (ADR): web/pyramid-gallery.js is a third forked lightbox + window-coupled wiring
- `web/pyramid-gallery.js:296-649` embeds a self-contained M2 lightbox on
  `./pyramid-filter-engine.js` (`createFilterEngine`), duplicating `tauri-parity-lightbox.js`
  which implements the same feature set on a DIFFERENT engine (`./lightbox/filter-engine.js`:
  `buildColorMatrix`/`applyColorMatrixInPlace`/`applyToneMapInPlace`). `pyramid-filter-engine.js`
  (lines 51-53) admits its matrices are "photographic approximations ... Real CasaBio matrices
  would be bit-identical port", so the two engines render the same preset/slider differently.
  (A third look vocabulary also lives in `panels.js`.) The grid->lightbox wiring is via window
  globals + `setTimeout(800)` + basename-string id recovery (`~631-648`).
- Why deferred: design fork — unifying onto one filter engine / one lightbox and one color-math
  source of truth is an architecture decision spanning multiple files, not a safe unilateral edit.
- Decision needed (ADR): which engine/lightbox is canonical (tauri-parity vs pyramid-gallery), and
  collapse the other? Resolve the panels.js look vocabulary into the same model.
- UPDATE 2026-06-23 (run 20260622T113415Z, filter-engine fork investigation): CONFIRMED LIVE —
  `pyramid-filter-engine.js` is reachable from the home page (`web/index.html:56` → top-level
  `./pyramid-gallery.html:54` → `pyramid-gallery.js:300` `import createFilterEngine`). So it is NOT
  dead and was NOT deleted (deletion forbidden for a live, colour-behaviour-bearing fork). The
  canonical engine is `web/lightbox/filter-engine.js` (engine of record, actively developed, wired
  into the *modular* gallery `web/pyramid-gallery/` + `lightbox/pyramid-lightbox.js`; git 2026-06-22
  vs legacy 2026-06-08). NOTE: the modular gallery's HTML is NOT linked from index.html — the home
  nav still points at the legacy top-level page. Full migration + colour-parity risk written up in
  `.epiccodereview/20260622T113415Z/sections/002/adr_draft/consolidate-filter-engines.md`.

### QUESTION (ADR/perf): renderLightboxAdjusted re-filters full image + allocs temp canvas per frame
- `web/pyramid-gallery.js:409-440` (`renderLightboxAdjusted`) re-runs the full-image filter and
  allocates a temp canvas on every pan/zoom/slider tick instead of caching the adjusted full-res
  buffer and only re-filtering when the look changes (pan/zoom should just re-blit).
- Why deferred: perf change requiring benchmark evidence (CLAUDE.md). Cost is real-canvas
  paint/alloc — must be measured with **flipflopdom** (browser harness), not Node.
- Decision needed: cache the adjusted full-res canvas; re-filter only on look change; pan/zoom
  re-draw from cache. Validate the win with flipflopdom before applying.

## EpicCodeReview 20260622T113415Z — section 002 (web/worker.js) deferrals

These worker.js findings were intentionally deferred by the fixer (cross-file /
WASM-runtime / branch-intent — not safe unilateral local edits). The local
`002-correctness-worker-options-undefined` null-guard WAS applied.

### QUESTION: pickRawDecoderWithFlags misroutes non-ORF/CR2/DNG buffers to the ORF decoder
- `web/worker.js` ~41-51. Recognizes only Olympus ORF (`IIR`), Canon CR2 (`II*\0`+`CR`@8),
  and TIFF-like (`II*\0`/`MM..*` → DNG); the final `return process_orf_with_flags` fallback
  feeds every other input (Sony ARW / Nikon NEF / Panasonic RW2 land on DNG; non-TIFF, EXR,
  JPEG land on ORF) to the Olympus decoder → garbage/throw. No allowlist/reject.
- Why deferred: this is the open work of the `feat/multi-format-ingest` branch — a correct fix
  needs WASM multi-format decode support + a real format-detect/dispatch layer wired in. Cannot
  be fixed correctly inside worker.js alone.
- Decision needed: which formats does the WASM build actually support now, and should unknown
  magic bytes hard-error rather than silently route to ORF?

### QUESTION: worker inbound/outbound protocol is untyped string tags with silent fall-through
- `web/worker.js` ~148-213. Dispatch on `ev.data.type` string tags; unknown types ignored
  silently; `ev.data` is not validated as an object before dereference.
- Why deferred: introducing a typed/validated message protocol is a cross-file contract change
  shared with main.js — not a local guard.
- Decision needed: adopt a discriminated message schema (and validate `ev.data` shape) across
  the worker ↔ main boundary?

### QUESTION: RAW decode FFI invoked with 17 positional args (13 interchangeable look floats)
- `web/worker.js` ~223-240. `pickRawDecoderWithFlags(bytes)(bytes, flags, exposureEv, contrast,
  highlights, …, clarity)` — 13 same-typed float look params passed positionally; one
  reordering silently corrupts the look with no diagnostic.
- Why deferred: changing the ABI means editing the Rust/WASM export signature too — cross-file.
- Decision needed: pass the look as a single struct/object (or a typed Float32Array with a
  documented layout) across the FFI boundary?

### QUESTION: take_rgb16_lb/thumb/take_rgb hand out views into WASM memory with implicit lifetime
- `web/worker.js` ~281-321. Views aliased into WASM linear memory; their validity vs subsequent
  WASM calls (which may grow/realloc the heap) is undocumented.
- Why deferred: ownership/lifetime semantics are defined by the WASM module, not worker.js;
  verifying/altering them is a WASM-runtime concern.
- Decision needed: document (or copy-out) the ownership contract for take_* return views.

### NOTE (info): thumbStateMap set-then-get is redundant but correct
- `web/worker.js` ~285-291. `thumbStateMap.set(id, …)` immediately followed by
  `thumbStateMap.get(id)`. Harmless; left as-is (info-severity, no behaviour change warranted).

### QUESTION: exportRoi marshals 16-bit ROI via Array.from(adjusted) across the Tauri IPC boundary (perf → ADR)
- `web/tauri-parity-lightbox.js` ~348-354 (post-fix line numbers). `encode_rgba16_jxl` is invoked
  with `pixels: Array.from(adjusted)` where `adjusted` is a packed rgba16 `Uint8Array` of
  `w*h*8` bytes. `Array.from` boxes every byte into a JS number[] and the IPC bridge then
  serializes that array — a large transient alloc + slow serialize for multi-MP ROIs, where the
  rest of the file passes ArrayBuffers/typed arrays directly.
- Why deferred (this section): perf change requiring a measured ADR, and likely a coordinated
  change to the Rust `encode_rgba16_jxl` command's argument type (cross-file). Not a local fix.
- Decision needed: accept the typed array / ArrayBuffer directly on the Rust side and drop the
  `Array.from` boxing; benchmark before/after.

### QUESTION: packed [u16 w][u16 h][body] Tauri framing re-parsed in 4+ sites with no shared decoder
- `web/tauri-parity-lightbox.js` (`parsePackedResponse`, `fetchRgb16`), `web/tauri-pyramid-client.js`
  (`parseRgbResponse`), and `web/main.js` apply_look path all hand-decode the same positional
  little-endian `[u16 w][u16 h][body]` framing. Length guards were added locally in the two tauri-*
  files in this pass; `main.js` and the absence of a single shared decoder / magic+version byte
  remain.
- Why deferred: a true consolidation spans multiple files (incl. main.js) and would change a shared
  helper signature — outside the local, single-file fix mandate for this section.
- Decision needed: extract one `decodePackedRgb(buf)` decoder (with length validation + optional
  version byte) and route all sites through it.

### QUESTION: panels.js ↔ main.js contract is a large untyped window.* handshake
- `web/panels.js` ~246-263. panels.js (plain script after main.js) talks to main.js exclusively via
  `window.*` globals in both directions (reads `window.currentLook/lightboxCard/levelsState/...`,
  exports `window.saveSidecar/loadSidecar/mergedLook/...`), each call defensively wrapped in
  `typeof window.X === 'function'` so a renamed/absent global silently no-ops instead of erroring.
- Why deferred (architectural → ADR): the seam spans panels.js and main.js and concerns module
  boundary design, not a local correctness fix.
- Decision needed: formalize the contract (ES module export/import, or a single typed namespace
  object) so missing/renamed members fail loudly.

### QUESTION: panels.js defines a third look/preset model disjoint from the two FilterEngines
- `web/panels.js` ~442-470. `BUILTIN_PROFILES` + `PIPELINE_FILTERS` are `LOOK_PARAMS` deltas merged
  additively in `window.mergedLook`, feeding the WASM LookRenderer slider pipeline — a third
  adjustment vocabulary alongside `pyramid-filter-engine.js` (LightboxPreset matrices) and
  `./lightbox/filter-engine.js` (buildColorMatrix), with no shared source of truth.
- Why deferred (architectural → ADR): reconciling three look models is a cross-file design decision.
- Decision needed: choose a single canonical look/preset representation and adapt the others to it.
- DOWNGRADE 2026-06-23 (run 20260622T113415Z): this is NOT a true third colour-math fork.
  `BUILTIN_PROFILES`/`PIPELINE_FILTERS` are plain additive `LOOK_PARAMS` deltas; `mergedLook()`
  (`panels.js:475-483`) only does `clamp(base + profileDelta + filterDelta)` and returns a `look`
  object — NO matrices, NO pixel transform. `main.js:919,922` feeds that merged look into the same
  real WASM LookRenderer/`process` pipeline the main UI sliders drive. So panels.js is a UI-layer
  preset *vocabulary* feeding the real engine, not a competing math implementation. Residual (minor):
  align preset names/values with the canonical lightbox preset list for a shared vocabulary —
  cosmetic, not a correctness fork. Demoted from "third engine" to vocabulary-alignment nicety.

---

## ADR DRAFTs — Section 002 (run 20260622T113415Z, adr_draft fixer)

All paths relative to repo root. All are perf/structure opportunities; each requires the mandatory flipflop (node, CPU) or flipflopdom (browser/canvas/WASM) measurement — ≥5% gate plus output parity (bit-identical where a pure repacking) — before implementation.

## ADR DRAFT from task 002-structure-orientation-transform-fivefold
- Topic: EXIF orientation→canvas transform implemented 5× across two conventions in web/main.js (drawSensorWithOrientation/drawRotatedCanvas/drawOrientedThumb/drawBitmapOriented/drawJpegToTargetDims)
- File: .epiccodereview/20260622T113415Z/sections/002/adr_draft/orientation-transform-shared-helper.md
- Recommends: Extract one pure orientationTransform(ori,w,h)->{outW,outH,apply(ctx)} helper and route all five call sites through it; parity-gate all 8 orientations (incl. mirrors 2/4/5/7).
- Reversible: yes

## ADR DRAFT from task 002-hacker-rgbtorgbaarr-bytewise
- Topic: rgbToRgbaArr (web/main.js:3528) writes RGBA byte-by-byte while sibling rgbToRgba (:1163) already uses 4×-fewer Uint32 stores
- File: .epiccodereview/20260622T113415Z/sections/002/adr_draft/rgbtorgbaarr-uint32-packing.md
- Recommends: Rewrite rgbToRgbaArr to the Uint32-packing idiom (one store/pixel); bit-identical, ≥5% on the paint path; make it the fast form the dedup ADR consolidates to.
- Reversible: yes

## ADR DRAFT from task 002-hacker-base64-fromcharcode
- Topic: JXL→base64 build via per-byte += String.fromCharCode over the whole buffer (web/main.js:1075-1076)
- File: .epiccodereview/20260622T113415Z/sections/002/adr_draft/jxl-base64-chunked-encode.md
- Recommends: Chunked String.fromCharCode.apply (or TextDecoder('latin1')) then btoa; byte-identical base64, ≥5%, removes the large-encode UI stall.
- Reversible: yes

## ADR DRAFT from task 002-structure-rgb-to-rgba-triplicated
- Topic: RGB→RGBA packing reimplemented 3× with divergent idioms (web/main.js:1163 rgbToRgba, :3528 rgbToRgbaArr, web/tauri-pyramid-client.js:34 rgbToRgbaArr)
- File: .epiccodereview/20260622T113415Z/sections/002/adr_draft/rgb-to-rgba-shared-helper.md
- Recommends: Collapse to one shared Uint32 helper (optional w/h) in a shared module; route all three sites through it; bit-identical, dedup after the bytewise perf rewrite lands.
- Reversible: yes

## ADR DRAFT from task 002-hacker-overlay-uint32-pack
- Topic: Selection-overlay loop writes 4 bytes/pixel via imgData.data and recomputes i*4 (web/main.js:2078-2091)
- File: .epiccodereview/20260622T113415Z/sections/002/adr_draft/selection-overlay-uint32-pack.md
- Recommends: Hoist imgData.data + Uint32 view, precompute the two packed RGBA32 constants, single u32 store per set pixel; bit-identical imgData, ≥5% on each mask update.
- Reversible: yes

## ADR DRAFT from task 002-hacker-applylens-alloc
- Topic: applyLens per-pixel transform chain allocates ~8 short-lived arrays/objects per pixel (web/perceptual-color.mjs:154-165)
- File: .epiccodereview/20260622T113415Z/sections/002/adr_draft/applylens-inline-scalar-pixel-loop.md
- Recommends: Inline the matrix chain to scalar locals (no array literals), hoist loop-invariant sceneWhite/Lstats/sigma; math-preserving, bit-exact target (≤1 LSB if reassociated), ≥5%.
- Reversible: yes

## ADR DRAFT from task 002-hacker-normlab-alloc-fuse
- Topic: normalizedLabBuffer per-pixel alloc chain; sigma=1 makes von Kries factors loop-invariant (web/perceptual-color.mjs:170-178)
- File: .epiccodereview/20260622T113415Z/sections/002/adr_draft/normlab-fuse-vonkries-matrix.md
- Recommends: Precompute one fused 3×3 (diag(gains)·xyzToLms·linToXyz), inline lmsToXyz/xyzToLab to scalars; bit-exact target (≤1 LSB), ≥5%.
- Reversible: yes

## ADR DRAFT from task 002-structure-perceptual-aos-and-sort
- Topic: estimateSceneWhiteLms builds a per-pixel boxed index Array; module-wide AoS [r,g,b]/xyz/lms/lab arrays in hot loops (web/perceptual-color.mjs:76-105)
- File: .epiccodereview/20260622T113415Z/sections/002/adr_draft/perceptual-soa-and-index-array.md
- Recommends: Drop the boxed index Array (threshold + SoA single-pass mean) and keep color in Float32 lanes through the hot loop; parity-gated, ≥5%. Pairs with scenewhite-fullsort (same loop).
- Reversible: yes

## ADR DRAFT from task 002-hacker-scenewhite-fullsort
- Topic: estimateSceneWhiteLms does a full O(n log n) sort of all pixels to find the top 2% brightest (web/perceptual-color.mjs:91-97)
- File: .epiccodereview/20260622T113415Z/sections/002/adr_draft/scenewhite-selection-not-fullsort.md
- Recommends: Replace the sort with O(n) selection (quickselect threshold + single-pass mean), reuse the already-computed clipped mask; identical scene-white (≤1 LSB), ≥5% (grows with size).
- Reversible: yes

## ADR DRAFT from task 002-hacker-selectbycolour-phi
- Topic: selectByColour allocates a lab array per pixel and computes phi(log) per pixel against a fixed tolerance (web/perceptual-color.mjs:181-188)
- File: .epiccodereview/20260622T113415Z/sections/002/adr_draft/selectbycolour-precompute-threshold.md
- Recommends: Precompute dThresh=cKnee*(exp(tol/cKnee)-1) once (phi is monotonic), compare squared distance on scalar locals; drops per-pixel log+sqrt+alloc; mask identical (≤1-px boundary), ≥5%.
- Reversible: yes

## ADR DRAFT from task 002-hacker-lightnessstats-copy-sort
- Topic: estimateLightnessStats copies the whole Float32Array via Array.from before sorting for two percentiles (web/perceptual-color.mjs:142-144)
- File: .epiccodereview/20260622T113415Z/sections/002/adr_draft/lightnessstats-typedarray-sort.md
- Recommends: Sort Ls in place with Float32Array.sort() (numeric, no comparator); drops the boxed copy + comparator; bit-identical percentiles, ≥5%.
- Reversible: yes

## ADR DRAFT from task 002-hacker-export-arrayfrom-typedarray
- Topic: exportRoi passes Array.from(adjusted) (boxed JS array) across the Tauri invoke boundary (web/tauri-parity-lightbox.js:348-354)
- File: .epiccodereview/20260622T113415Z/sections/002/adr_draft/exportroi-typedarray-ipc.md
- Recommends: Pass the typed array (or its ArrayBuffer) directly + add a ROI size guard; identical JXL output, ≥5% marshalling/memory. Blocking unknown: confirm the Rust encode_rgba16_jxl command accepts a byte buffer.
- Reversible: partial

---

# Section 003 — Lightbox M3 WebGL/tiled pipeline unfinished

EpicCodeReview section 003 (`web/lightbox/`) found that the M3 16-bit **WebGL-HDR
display path** and the **tiled-decode-pool path** are half-built / broken in ways
that are **not safely fixable in-loop**: they are browser-verified-only, and the
"fix" is feature completion plus a design decision about whether these paths are
meant to be live. The 14 `direct_fix` tasks below are therefore **deferred** (no
source edits, no commits this pass). All findings are verifier-confirmed
(`sections/003/verified.json`) unless noted; the two CRITICALs were also
re-confirmed by direct read of source.

Root cause, in one line: **two M3 features were wired into the lightbox but never
finished** — `webgl-pipeline.js` can't even load (broken import), the inline GL
display path is dead (shadowed `redraw()`), and `tiled-decode-worker.js` speaks a
different protocol than the pool that drives it (so the tiled path silently
falls back to direct decode). Everything else in this section is downstream of
those three.

Dependency note for whoever picks this up: fix order is **(1) wiring/protocol →
(2) correctness → (3) the perf ADRs**. The perf ADRs that target the WebGL path
are *moot until the WIP cluster is wired* (called out per-ADR).

---

## 003.A — web/lightbox/webgl-pipeline.js (M3 WebGL-HDR module is unloadable)

The whole module is **unreachable**: a load-time ES linkage failure means none of
its exports (`createHdrRenderer`, `renderRgba16AdjustedToCanvas`,
`adjustedRgba16ForExport`, `canUseWebGL16`, …) can be used. Findings (b)/(c)
below don't matter until (a) is fixed and the module is rewritten against
filter-engine's real API.

### Q-003.A1 [CRITICAL] Broken import → module linkage failure
- Task id: `003-correctness-wgl-import` (deferred)
- File: web/lightbox/webgl-pipeline.js:3
- Finding: `import { buildColorMatrix, clampAdjustments } from './filter-engine.js'`
  imports two symbols that **filter-engine.js does not export** (and that exist
  nowhere in the repo).
- What we found: filter-engine.js exports exactly `ADJUSTMENT_PARAMS`,
  `LightboxPreset`, `APPROVED_LIGHTBOX_PRESETS`, `createFilterEngine`,
  `applyFilter`. A static named import of a binding the target doesn't export is a
  hard load-time error → the entire `webgl-pipeline.js` module fails to
  instantiate. `webgl-pipeline.test.js` does not catch this because it only
  `readFileSync` + string-greps the source (fake-green) and never imports/executes
  the module. (Also imported, equally broken, by `tauri-parity-lightbox.js:11-12 / :19`.)
- What's needed: rewrite the module against filter-engine's actual API. The
  intended supplier of the colour matrix is `createFilterEngine(...).getMatrix()`
  (12-element 3×4 row-major). Replace `buildColorMatrix(preset, adj)` with an
  engine built from the preset+adjustments and its `getMatrix()`; replace
  `clampAdjustments(adjustments)` with whatever clamping `ADJUSTMENT_PARAMS`
  implies (filter-engine already clamps internally in `createFilterEngine`).
- Suggested direction: do **not** add `buildColorMatrix`/`clampAdjustments` to
  filter-engine to satisfy the import — that re-creates the matrix path twice.
  Consume the existing engine API instead. Pairs with Q-003.A2 (the matrix layout
  must then match getMatrix's 12-element output).
- Verify: `node -e "import('./web/lightbox/webgl-pipeline.js').then(m=>console.log(Object.keys(m)))"`
  currently throws a SyntaxError/linkage error; after the fix it must list the
  exports. Then a browser smoke (flipflopdom or a headless page) to confirm a
  render.

### Q-003.A2 [HIGH] matrixUniforms reads a 4×4/16-element layout; filter-engine emits 3×4/12-element
- Task id: `003-correctness-wgl-matrix-layout` (deferred)
- File: web/lightbox/webgl-pipeline.js:107-114
- Finding: `matrixUniforms()` reads `m1=[matrix[5],[6],[7]]`, `m2=[matrix[10],[11],[12]]`,
  `off=[matrix[4]/255, matrix[9]/255, matrix[14]/255]` — a 16-element 4×4 layout
  with `/255` integer-scaled offsets.
- What we found: every matrix in this lightbox is **12-element 3×4 row-major**
  (`filter-engine` PRESET_BASE :30-43, compose :47-57): row r = `[r*4+0..r*4+2]`,
  offset at `r*4+3`, offsets already in 0..1. Against a length-12 array, indices
  `matrix[12]` and `matrix[14]` are **out of bounds (undefined)**, rows 1/2 read
  the wrong cells (m1 should be `[4,5,6]`+offset `[7]`, not `[5,6,7]`+`[9]`), and
  the `/255` is wrong because offsets are already normalized. Latent only because
  its supplier (`buildColorMatrix`) is missing; once Q-003.A1 feeds real
  getMatrix output, the transform would be wrong/NaN.
- What's needed: rewrite `matrixUniforms` for the 12-element 3×4 layout:
  `m0=[m[0],m[1],m[2]]`, `m1=[m[4],m[5],m[6]]`, `m2=[m[8],m[9],m[10]]`,
  `off=[m[3],m[7],m[11]]` (no `/255`).
- Suggested direction: do this **together with** Q-003.A1 (the layout fix is
  meaningless until a real 12-element matrix is supplied). Add a unit test that
  feeds a known getMatrix output and asserts the uniform vectors.

### Q-003.A3 [LOW] No webglcontextlost handling on the shared renderer
- Task id: `003-correctness-wgl-no-context-loss` (deferred)
- File: web/lightbox/webgl-pipeline.js:119-241
- Finding: `getRenderer()` (:238-241) memoizes a module-level `sharedRenderer`
  for the process lifetime with no `isContextLost()` check and no
  `webglcontextlost`/`restored` listener.
- What we found: on context loss (GPU reset, tab backgrounding, driver hiccup)
  `getRenderer()` keeps returning the dead renderer; `texImage2D`/`drawArrays`/
  `readPixels` become no-ops, `readPixels` returns zeros → silent black/garbage
  with no error and no fallback to `adjustRgba16Cpu`. `dispose()` exists but is
  never wired to loss.
- What's needed: `isContextLost()` guard + `webglcontextlost`/`restored`
  listeners that invalidate `sharedRenderer`, with CPU fallback. (Captured in
  more detail in the lifecycle ADR — `003-structure-wgl-deadcode`.)
- Suggested direction: defer until the module is live (blocked by Q-003.A1 and
  the engine-of-record decision in 003.C). Verify with the
  `WEBGL_lose_context` extension in a browser test.

---

## 003.B — web/lightbox/tiled-decode-worker.js (protocol mismatch → tiled pool is dead)

The worker is instantiated as the decode worker for `PyramidWorkerPool`
(`web/pyramid-gallery/pyramid-decode.js:18-21` passes
`new Worker('../lightbox/tiled-decode-worker.js')` as `workerFactory`), but it
speaks a **different protocol** than the pool. Net effect: the readiness
handshake never resolves, every reply is dropped, the watchdog times out, the
handle is marked Bad, and the pool **silently falls back to direct decode**. The
parallel tiled-decode path is effectively dead. Fix = rewrite the worker to speak
the pool's v1 protocol (`load`/`ready`/`decode-reply`, `bytesId` caching,
`format`→`use16`).

### Q-003.B1 [CRITICAL] Message protocol does not match PyramidWorkerPool
- Task id: `003-structure-twkr-proto` (deferred)
- File: web/lightbox/tiled-decode-worker.js:5-16
- Finding: the worker destructures `{id, bytes, region, bpp}` from each message
  and replies `{id, ok, pixels, width, height}` (no `v`, no `type`, `width/height`
  not `w/h`).
- What we found: the pool (`packages/jxl-pyramid/src/tiled-decode-pool.ts`) sends
  versioned `{v:1, type:'load', bytesId, bytes|sab}` (ensureLoaded :786/:788) and
  `{v:1, type:'decode', id, bytesId, region, format}` (decodeTileWithWorker
  :185-194). `parseWorkerReply` (:860-884) **only** accepts `{v:1, type:'ready'}`
  and `{v:1, type:'decode-reply', id, ok, pixels, w, h}`, and hard-rejects on
  `d.v !== 1` (:863) → every worker reply returns null and is dropped (:664). The
  worker never emits `ready` (so `acquire`/`whenReady` hang on `h.ready`), never
  handles `type:'load'`, and treats every message as a decode. The watchdog
  (:158-165) then marks the handle Bad → direct-decode fallback (:1288-1291).
- What's needed: rewrite the worker to (1) handle `type:'load'` and post
  `{v:1, type:'ready'}`, (2) handle `type:'decode'` and reply
  `{v:1, type:'decode-reply', id, ok, pixels, w, h}` (note `w`/`h`, and `v:1`).
- Suggested direction: mirror the message shapes in `tiled-decode-pool.ts`
  exactly; treat that file as the protocol contract. Pairs with Q-003.B2 and
  Q-003.B3 (same rewrite).
- Verify: browser-only. Run the pyramid grid in a headless page (flipflopdom),
  confirm `decodeTiledViewportPooled` resolves via the worker (not the direct
  fallback) — e.g. instrument/log the pool's `handle.ready` resolution and the
  `decode-reply` path, and assert the direct-decode fallback at :1288-1291 is not
  hit.

### Q-003.B2 [HIGH] No bytesId/load state machine (defeats the load-once amplification fix)
- Task id: `003-structure-twkr-noload` (deferred)
- File: web/lightbox/tiled-decode-worker.js:1-16
- Finding: the worker keeps no bytes cache and reads full `bytes` inline off
  every decode message.
- What we found: the pool's central design (`tiled-decode-pool.ts` header
  :223-227 "Uses load/decode split + bytesId to eliminate structured-clone
  amplification"; `ensureLoaded` :760-795) posts the container bytes **once per
  worker** via `type:'load'` keyed by `bytesId` (optionally a SharedArrayBuffer),
  and every subsequent decode references `bytesId` only — `bytes` is never sent on
  decode. So against the real pool `ev.data.bytes` is **always undefined** and
  decodes throw; and even if shapes were patched naively the worker would re-clone
  the whole container per tile, exactly the amplification the protocol exists to
  avoid.
- What's needed: add a `Map<bytesId, Uint8Array|SAB-view>` populated on
  `type:'load'`; on `type:'decode'` resolve `bytesId` → cached bytes (handle the
  SAB case without copying).
- Suggested direction: same rewrite as Q-003.B1. Keep the SAB fast-path
  (no copy) to preserve the amplification fix.

### Q-003.B3 [HIGH] Bit-depth keyed off `bpp` the pool never sends → 16-bit decodes as rgba8
- Task id: `003-structure-twkr-bpp` (deferred)
- File: web/lightbox/tiled-decode-worker.js:6-11
- Finding: `const use16 = bpp === 8; const fn = use16 ? decodeTileContainerRegionRgba16 : decodeTileContainerRegionRgba8;`
- What we found: the pool transmits `format:'rgba8'|'rgba16'`
  (`decodeTileWithWorker` :191), **never** a `bpp` field. So `ev.data.bpp` is
  always undefined → `use16 = (undefined === 8)` is always false → 16-bit
  container regions are silently decoded as rgba8. (The `bpp===8 ⇒ rgba16`
  mapping happens to align with `bppOfFormat` in `decode-core.ts:25` only by
  coincidence; the load-bearing defect is the missing field.)
- What's needed: branch on the pool's `format` field:
  `const use16 = (region/msg).format === 'rgba16'`.
- Suggested direction: fold into the Q-003.B1 rewrite.

---

## 003.C — web/lightbox/pyramid-lightbox.js (dead GL redraw, tiled bypass, tone drift)

### Q-003.C1 [HIGH] Duplicate redraw() + clampPan() — last-declaration-wins kills the WebGL path (DESIGN DECISION)
- Task ids: `003-correctness-plb-dup-redraw`, `003-structure-plb-redraw-dup` (both deferred)
- File: web/lightbox/pyramid-lightbox.js:583 and :791 (redraw), :438 and :643 (clampPan)
- Finding: `function redraw()` is declared **twice** in the same
  `createPyramidLightbox` closure — :583 is GL-preferring
  (`if (gl && levelInfo && levelPixels) { if (renderGL()) return; }`), :791 is
  2D-only. `clampPan()` is also declared twice (:438, :643).
- What we found: JS function-declaration hoisting makes the **last** declaration
  win, so the live `redraw()` is the 2D-only :791 version, and `renderGL`
  (:227-279, the inline 16-bit WebGL display path) is **dead code** (only refs:
  def :227 and the dead :583 redraw). `reapplyToOffscreen` (:560-563)
  deliberately skips CPU rendering for 16-bit *expecting* the GL redraw — so
  16-bit GL display is dead end-to-end. The duplicate `clampPan` bodies are
  near-identical (harmless, but same copy/paste hazard; one is dead).
  (One verifier nit: the second detector said "three" redraws — grep confirms
  exactly **two**; the dead-GL conclusion stands.)
- What's needed: this is **not a mechanical de-dup** — resolving it requires a
  DESIGN decision: *is the WebGL-HDR display path meant to be live?* If yes,
  delete the 2D-only :791 redraw and make the GL path reachable (and pick the
  engine of record — see the `003-structure-two-gl-pipelines` ADR). If no, delete
  `renderGL`/the inline GL block and keep the 2D path.
- Suggested direction: tie to the engine-of-record ADR
  (`lightbox-two-webgl-pipelines-one-engine-of-record.md`). Do not silently pick
  one — it changes user-visible 16-bit rendering. Verify in a real browser
  (16-bit level open + slider drag) once decided.

### Q-003.C2 [MEDIUM] loadLevel always full-decodes; never the pooled tiled path
- Task id: `003-structure-plb-ignores-tiled` (deferred)
- File: web/lightbox/pyramid-lightbox.js:491-556
- Finding: `loadLevel` decodes via `ctx.decode({format, sourceKey, …})` +
  `session.frames()` to materialize the whole level into `levelPixels`,
  regardless of any tiling metadata — there is **no reference to `entry.tiled` /
  region** anywhere in the file.
- What we found: the sibling pooled API `decodePyramidLevel`
  (`web/pyramid-gallery/pyramid-decode.js:12-23`) routes `opts.tiled` levels to
  `decodeTiledViewportPooled` (region + worker pool). The lightbox full-decodes
  tiled levels that the grid decodes tile-by-tile, duplicating decode work and
  bypassing the tiled worker/pool on the lightbox seam.
- What's needed: route `loadLevel` through the tiled path when the level
  descriptor is tiled — **but this is blocked by 003.B** (the tiled worker/pool is
  dead until the protocol is fixed). Until then, full-decode is the only working
  path.
- Suggested direction: fix 003.B first; then add an `entry.tiled` branch in
  `loadLevel` that calls `decodeTiledViewportPooled` for the visible region.
  Whether tiled levels actually reach the lightbox is itself an architectural
  question — confirm before wiring. Win is real but unmeasured (needs flipflopdom).

### Q-003.C3 [MEDIUM] Three divergent shadow/highlight tone formulas break FilterEngine parity
- Task id: `003-structure-plb-tone-divergence` (deferred)
- File: web/lightbox/pyramid-lightbox.js:127-142 (plus the four sites below)
- Finding: the shadows/highlights tone op is implemented four times with two
  different formulas.
- What we found: (a) `filter-engine.js` `applyToImageData`/`applyFloat` use
  unbounded `lift = sh*(1-l)`, `comp = hi*l` (:154,:160 and :196,:200); (b) the
  inline `pyramid-lightbox` GL FS uses the same unbounded form (:129,:133); (c)
  `webgl-pipeline.js` FS_300/FS_100 use **band-limited** `lift*max(0,0.35-luma)` /
  `compress*max(0,luma-0.65)` (:34-35,:67-68); (d) `webgl-pipeline.js`
  `adjustRgba16Cpu` repeats (c) (:320-329). The GL/CPU webgl-pipeline math
  diverges from the filter-engine/inline-shader math → the "FilterEngine parity"
  contract (`pyramid-lightbox.js:4`) is broken across the bit-depth/GL seam.
- What's needed: single-source the tone function. Decide the canonical formula
  (unbounded `(1-l)` vs band-limited `max(0,0.35-luma)`) and make all four sites
  use it.
- Suggested direction: tie to the engine-of-record ADR; the canonical tone math
  should live in filter-engine and be referenced by the GL shaders. Parity-verify
  in browser (same slider values → matching output across 8-bit / JS-float / GL).

### Q-003.C4 [LOW] open() reuses LRU/grid-seed pixels as 8-bit even in 16-bit mode
- Task id: `003-correctness-plb-lru-float-stored` (deferred)
- File: web/lightbox/pyramid-lightbox.js:742-767
- Finding: `loadLevel` only writes the LRU for 8-bit (`if (!use16) lruSet(...)`
  :553); on `open()`, the LRU-hit and grid-card-seed branches (:744-766)
  unconditionally wrap cached pixels in `new Uint8ClampedArray(hit.pixels)` and
  set `levelInfo` **without `bitsPerSample`**.
- What we found: (1) if `is16bitMode` is true on re-open, the seed path produces
  an 8-bit-treated buffer with no `bitsPerSample` marker → `reapplyToOffscreen`
  takes the 8-bit branch and the 16-bit toggle silently shows an 8-bit render
  until `reloadCurrentLevelForMode`/`loadLevel` runs. (2) The grid-seed branch
  sets `levelInfo = init` (chosen-level dims) while `levelPixels`/`offscreen`
  come from `srcC` (grid canvas dims) → a w/h vs buffer-size mismatch feeding
  `clampPan` and the shader `levelSize`.
- What's needed: carry `bitsPerSample`/`use16` through the seed paths (don't
  treat seeded pixels as 8-bit when 16-bit mode is active), and reconcile
  `levelInfo.w/h` with the actual seeded buffer dimensions.
- Suggested direction: low severity (a mode toggle re-runs `loadLevel`), but fix
  the dimension contract while in the file. Depends on the redraw/engine decision
  (003.C1) since the 16-bit display path itself is currently dead.

### Q-003.C5 [LOW] Empty `_internal` debug stub + near-dead ditherFloatToU8
- Task id: `003-structure-plb-internal-stub` (deferred)
- File: web/lightbox/pyramid-lightbox.js:837-843
- Finding: `createPyramidLightbox` returns `{ open, close, _internal: { /* for
  debug only */ } }` — `_internal` is an empty object (documented debug surface
  is non-existent). Separately `ditherFloatToU8` (:451-460) is reachable only via
  the no-WebGL2 JS-16bit fallback (:564-570); on WebGL-capable machines that
  branch is short-circuited (:560-563) and on no-WebGL machines the dead :583
  redraw governs — so it is near-dead alongside the dead GL redraw.
- What's needed: tidy the API surface (populate or remove `_internal`) and
  resolve which 16-bit path is live (depends on 003.C1).
- Suggested direction: defer until the redraw/engine decision; the dead-vs-live
  status of `ditherFloatToU8` follows directly from it.

---

## 003.D — web/lightbox/pyramid-lightbox.test.js (asserts on absent JXTC/16-bit symbols)

### Q-003.D1 [MEDIUM] Test asserts on instrumentation strings that no longer exist (RED or divergent)
- Task id: `003-correctness-plb-test-stale` (deferred)
- File: web/lightbox/pyramid-lightbox.test.js:9-32 (and webgl-pipeline.test.js:16-21)
- Finding: all five tests in `pyramid-lightbox.test.js` `readFileSync` + string-
  grep the source for `const t0Decode = performance.now()`,
  `jxtcDecodeMs = performance.now() - t0Decode`, `jxtcDecodeMs` in the `levelInfo`
  literal, a log referencing `jxtcDecodeMs`, and `via: 'jxtc'`. The second test in
  `webgl-pipeline.test.js` (:16-21) asserts the source contains `encodeRgba16`,
  `adjustedRgba16ForExport`, `decodePyramidRegion`, `-roi.jxl`.
- What we found: **none** of `jxtcDecodeMs`, `t0Decode`,
  `decodeTileContainerRegionRgba8`, `via: 'jxtc'`, `encodeRgba16`,
  `adjustedRgba16ForExport`, `decodePyramidRegion`, or `-roi.jxl` appear in the
  current `pyramid-lightbox.js` (grep-confirmed). The current `loadLevel` uses
  `ctx.decode()`/`session.frames()` with no JXTC region decode and no timing
  instrumentation. So these tests are **RED against this source** (string-grep
  tests → assertions on absent strings fail). It indicates the JXTC/16-bit region
  decode + timing instrumentation was removed from the source but the tests were
  not updated.
- What's needed: a HUMAN decision — confirm red/green by running the suite, then
  either (a) **restore the instrumentation** (if the JXTC region-decode path and
  its timing are meant to exist — this is lost functionality), or (b) **update the
  test to current reality**. Do **not** silently edit the test to pass, which
  would mask the lost functionality.
- Current status (string-grep evidence): the asserted strings are absent from
  source ⇒ the tests must currently **fail (red)**. Confirm by actually running.
- Verify / confirm red:
  `cd web && npx vitest run lightbox/pyramid-lightbox.test.js lightbox/webgl-pipeline.test.js`
  (or the repo's test runner) and read the pass/fail. If red, the choice is
  restore-instrumentation vs update-test; if unexpectedly green, the test file
  under run does not match this source (a test/source divergence to resolve).
- Suggested direction: this is entangled with 003.C (the tiled/JXTC region-decode
  the tests expect is exactly the path that 003.B/003.C2 show is dead/bypassed).
  Treat "restore JXTC region decode + timing" as part of finishing the tiled
  feature, not a test edit.

---

## Section 003 — ADR drafts (perf + architecture, deferred_adr)

The 7 `adr_draft` tasks are written to
`.epiccodereview/20260622T113415Z/sections/003/adr_draft/`. The WebGL-path perf
ADRs are **moot until the WIP cluster (003.A/003.B/003.C1) is wired** — each says
so.

## ADR DRAFT from task 003-hacker-getmatrix-allocs
- Topic: filter-engine getMatrix() allocates ~6 short-lived 12-element arrays per call (web/lightbox/filter-engine.js:104-127)
- File: .epiccodereview/20260622T113415Z/sections/003/adr_draft/filter-engine-getmatrix-single-buffer.md
- Recommends: Fold the chain into one reused Float32Array(12) updated in place; output-identical (≤1 LSB), ≥5% via flipflopdom. Must land after the saturation correctness fix (003-correctness-fe-sat-bias-doublecount).
- Reversible: yes

## ADR DRAFT from task 003-hacker-computehistogram-luma
- Topic: computeHistogram fills r/g/b/l per pixel but only luma is consumed (web/lightbox/filter-engine.js:172-181)
- File: .epiccodereview/20260622T113415Z/sections/003/adr_draft/filter-engine-computehistogram-luma-only.md
- Recommends: Drop the dead r/g/b stores (or gate behind a default-off flag); ~quarters per-pixel store work; hist.l bin-exact, ≥5% via flipflopdom on the redraw path.
- Reversible: yes

## ADR DRAFT from task 003-structure-two-gl-pipelines
- Topic: Two independent WebGL 16-bit pipelines coexist — inline pyramid-lightbox.js GL vs webgl-pipeline.js (architecture)
- File: .epiccodereview/20260622T113415Z/sections/003/adr_draft/lightbox-two-webgl-pipelines-one-engine-of-record.md
- Recommends: Pick one engine of record (lean webgl-pipeline.js once its import/matrix are fixed) or drop WebGL for the JS-float path; single-source tone math. DESIGN decision gating 003.C1/C3. Both pipelines currently broken/dead.
- Reversible: per-step yes; architectural choice sticky

## ADR DRAFT from task 003-hacker-16bit-fallback-twopass
- Topic: 16-bit JS fallback in reapplyToOffscreen runs 3 full-image passes + 2 Float32 allocs (web/lightbox/pyramid-lightbox.js:564-570)
- File: .epiccodereview/20260622T113415Z/sections/003/adr_draft/lightbox-16bit-fallback-fuse-passes.md
- Recommends: Fuse normalize into applyFloat (drop one alloc+pass), optionally fuse dither; ≤1 LSB parity, ≥5% via flipflopdom (force gl=null). Only meaningful once a live JS-float fallback path is confirmed (003-structure-two-gl-pipelines).
- Reversible: yes

## ADR DRAFT from task 003-hacker-ensurefbo-reupload
- Topic: ensureFbo re-creates the RGBA32F FBO texture every runShader even when size is unchanged (web/lightbox/webgl-pipeline.js:153-167)
- File: .epiccodereview/20260622T113415Z/sections/003/adr_draft/webgl-ensurefbo-cache-attachment.md
- Recommends: Cache fboW/fboH, realloc only on size change; output-identical, ≥5% via flipflopdom (GL). MOOT until webgl-pipeline.js loads + is wired (003-correctness-wgl-import / 003-structure-two-gl-pipelines).
- Reversible: yes

## ADR DRAFT from task 003-hacker-uploadsource-realloc
- Topic: uploadSource allocates a fresh w*h*4 Float32Array every call (web/lightbox/webgl-pipeline.js:169-190)
- File: .epiccodereview/20260622T113415Z/sections/003/adr_draft/webgl-uploadsource-scratch-buffer.md
- Recommends: Reuse a renderer-closure scratch Float32Array, realloc on size change; output-identical, ≥5%/GC-reduction via flipflopdom. MOOT until the module loads + is wired.
- Reversible: yes

## ADR DRAFT from task 003-structure-wgl-deadcode
- Topic: Deprecated uploadRgba16ToGl + single shared undisposed renderer + leaking canUseWebGL16 probe (web/lightbox/webgl-pipeline.js:74-80, 238-241, 359-370)
- File: .epiccodereview/20260622T113415Z/sections/003/adr_draft/webgl-deprecated-api-and-renderer-lifecycle.md
- Recommends: Delete the deprecated export (cleanup safe now), dispose/cache the probe, add isContextLost + context-loss listeners with CPU fallback (lifecycle parts gated on the module being live).
- Reversible: per-change yes

## DEFERRED from task 003-structure-plb-internal-stub
- Finding: createPyramidLightbox returns `_internal: { /* for debug only */ }` — an empty debug stub (web/lightbox/pyramid-lightbox.js:842). The companion `ditherFloatToU8` path is near-dead (only reachable via the no-WebGL2 16-bit JS fallback, which the dead :583 GL redraw governs).
- Reason for deferral: No clear/trivial local fix. Repo-wide grep confirms `_internal` has NO consumer anywhere (no test, no other module reads it) — the empty stub breaks nothing, so there is no test-gated reason to populate it. Deciding what to expose (and resolving the dead ditherFloatToU8 / dead-redraw question it points at) is entangled with the deferred WIP cluster: duplicate redraw()/clampPan() declarations, the dead inline WebGL render path, and the loadLevel/tiled-decode bypass. Populating _internal in isolation would be guesswork and could mask the real structural issue.
- Suggested resolution: handle together with the redraw/clampPan-dup + dead-GL-path writeup (003-correctness-plb-dup-redraw, 003-structure-plb-redraw-dup, 003-structure-plb-ignores-tiled, 003-structure-two-gl-pipelines) so the live 16-bit path is settled first; then expose the genuinely-live internals (or drop _internal entirely).
- Reversible: yes

## ADR DRAFT from task 006-hacker-paint-clamped-copy
- Topic: paintCanvas copies the whole rgba8 buffer into a fresh Uint8ClampedArray per painted/upgraded tile (web/pyramid-gallery/grid-controller.js:69) on the scroll/IO paint hot path; grid path is always rgba8 + putImageData consumes synchronously, so the buffer can be wrapped zero-copy
- File: .epiccodereview/20260622T113415Z/sections/006/adr_draft/grid-paintcanvas-zerocopy-imagedata.md
- Recommends: `new Uint8ClampedArray(decoded.pixels.buffer, byteOffset, w*h*4)` zero-copy view behind a `byteLength === w*h*4` guard (falls back to copy for non-rgba8/rgba16 stride-8); removes one full-frame alloc+memcpy per paint. PERF → gated on flipflopdom (browser/canvas): ≥5% speed + byte-identical read-back pixel parity. Pairs with the rgba16-tiled bpp guard (006-correctness-tiled-region-bpp-mismatch).
- Reversible: yes

## ADR DRAFT from task 006-correctness-manifest-cache-poisoning-validate-order
- Topic: getManifest caches only the resolved manifest (set after fetch+json+validate), not the in-flight fetch promise, so concurrent first-callers for the same imageId double-fetch and double-validate (web/pyramid-gallery/image-store.js:46-56)
- File: .epiccodereview/20260622T113415Z/sections/006/adr_draft/image-store-getmanifest-inflight-dedup.md
- Recommends: cache the in-flight promise (set before the first await) with evict-on-reject (`p.catch(() => manifestCache.delete(imageId))`) to preserve retry-after-failure; small low-risk dedup-cache addition, info-severity. Pairs with 006-correctness-getlevelbytes-cache-set-unawaited (same gap for level bytes) and 006-structure-manifestcache-unbounded.
- Reversible: yes
- UPDATE (006 fixer pass, 2026-06-22): IMPLEMENTED in image-store.js. getManifest now caches the in-flight promise (`manifestInflight` Map, evicted in `finally`) so concurrent first-callers share one fetch+validate; getLevelBytes got the mirrored `levelInflight` dedup. Done-result cache is now a bounded LRU (`MANIFEST_CACHE_MAX = 64`, evict-oldest in `manifestCacheSet`). ADR closed by the direct fix.

## DEFERRED from task 006-correctness-worker-protocol-mismatch (pyramid-decode.js, CRITICAL)
- Finding: the pooled tiled path in `decodePyramidLevel` (web/pyramid-gallery/pyramid-decode.js:13-23) wires `decodeTiledViewportPooled(... workerFactory: () => new Worker('../lightbox/tiled-decode-worker.js'))`, but the worker speaks a different message protocol than the pool that drives it — so the tiled viewport path is effectively dead / falls back.
- Reason for deferral: this is the **pool-side confirmation of the already-documented tiled-decode-worker protocol mismatch** in Section 003 (see "## 003.B — web/lightbox/tiled-decode-worker.js (protocol mismatch → tiled pool is dead)", QUESTIONS.md ~L1944, and the root-cause summary at ~L1854). The actual fix lives in `web/lightbox/tiled-decode-worker.js` + the pool contract in `packages/jxl-pyramid/dist/tiled-decode-pool.js` — a cross-file feature-completion + browser-verified change, outside this fixer's two-file (pyramid-decode.js / image-store.js) local-fix scope. Section 006's local dropped-options defects (signal/format/priority/contenthash forwarding, return-shape alignment) were fixed in this pass; the protocol wiring itself is deferred to the Section 003 cluster.
- Suggested resolution: complete it together with the Section 003 tiled cluster (003.B) — settle the worker↔pool message protocol there, then re-verify the now-options-forwarding tiled branch in pyramid-decode.js end-to-end in-browser (flipflopdom).
- Reversible: yes

## DEFERRED from task 006-structure-worker-contract (pyramid-decode.js)
- Finding: the tiled decode delegates to an external worker pool whose message protocol/contract is unspecified at the `decodePyramidLevel` seam (web/pyramid-gallery/pyramid-decode.js:13-23).
- Reason for deferral: same root cause as 006-correctness-worker-protocol-mismatch above and the Section 003 entry — the unspecified contract is the documented tiled-decode-worker↔pool mismatch (003.B, QUESTIONS.md ~L1944). Specifying/aligning the contract is a cross-file change in tiled-decode-worker.js + tiled-decode-pool.js, outside this two-file local scope. The local seam now at least forwards the same fields as the session branch (signal/format/priority/sourceKey) and returns the matching `{pixels,width,height}` shape.
- Suggested resolution: as part of the Section 003 003.B fix, document the worker message protocol at the pool boundary; no further edit needed in pyramid-decode.js once the contract is settled.
- Reversible: yes

## Multi-format (EXR/TIFF) ingest — colour-fidelity note (2026-06-22, feature landed)

Full EXR/TIFF ingest now lands in the live app: `web/worker.js` routes by
`detectFormat()`, decodes via `decode_exr`/`decode_tiff` to a `DecodedImage`, and
emits the same thumb / lightbox / live-edit / `encode_request` messages as RAW.
Live slider editing IS wired (not build-gated) — `LookRenderer.new_with_options`
is fully JS-constructible from an arbitrary packed RGB16-LE buffer, so EXR/TIFF
reuse the identical RAW live-edit engine. sdr/jxl/unknown are rejected with a
clear error instead of being misrouted to the Olympus decoder.

- **Colour-fidelity caveat (not build-gated, no fix required to ship):** the
  shared `LookRenderer.render()` runs the RAW tone pipeline, which expects
  *linear* RGB16 input and applies a baseline picture-mode S-curve + sRGB OETF.
  EXR (linear f32) maps cleanly. For TIFF (already-display-referred sRGB u8/u16)
  the worker linearizes via an sRGB→linear EOTF (`decodedToLinearRgb16` in
  worker.js) before feeding the renderer, so look=0 ≈ the clean
  `to_display_rgba8` preview. The remaining gap: the baseline S-curve is tuned
  for RAW scene-linear data, so a developed TIFF/EXR at look=0 gets a mild
  RAW-style contrast curve rather than a strict 1:1 passthrough. This is
  visually acceptable and consistent with "behaves like RAW", but is not a
  colour-managed identity transform.
- **Optional future WASM improvement (would remove the caveat):** add a
  wasm_bindgen entry that constructs a `LookRenderer` (or a sibling
  `ImageLookRenderer`) which skips black-subtraction + the baseline S-curve and
  treats the input as already display-referred — e.g.
  `LookRenderer::from_display_rgb16(rgb16_le, w, h)` with a `passthrough_tone:
  bool` flag on `new_with_options`. Build: `wasm-pack build --target web
  --out-dir web/pkg --release` (threaded build needs the manual
  cargo+nightly+wasm-bindgen recipe per CLAUDE.md). Until then the JS-side
  linearization is the correct-enough path and requires no rebuild.
- **Live verification gap:** `web/multi-format-roundtrip.test.mjs` (the
  designated browser proof) needs Playwright, which is not installed in this
  worktree's junctioned `node_modules` (no-new-deps constraint) — so the
  in-browser decode+render path was not executed here. The routing contract is
  covered by new vitest cases in `web/format-detect.test.js` (12 pass). RAW
  routing is unchanged (worker RAW branch is byte-identical; only `opts`/`look`
  were hoisted above the new route switch).

- **16-bit ROI export from the lightbox (unimplemented).** Scoped in commit c108c22c
  ("M3 ... + 16-bit ROI export") but never wired into `web/lightbox/pyramid-lightbox.js`.
  Building blocks exist (`adjustedRgba16ForExport` in `webgl-pipeline.js`,
  `decodePyramidRegion` in `pyramid-gallery/pyramid-decode.js`) but the lightbox-side glue
  + `encodeRgba16` + `-roi.jxl` download do not. The corresponding test in
  `web/lightbox/webgl-pipeline.test.js` is `test.skip` (TODO(16-bit-ROI-export)); needs a
  browser/WASM round-trip to implement and verify.

---

## Section — web/main.js card state-bag (ADR-level refactor, deferred)

These two refactors were explicitly deferred from the 2026-06-23 main.js/worker.js
architectural fix pass (peepCache LRU, listener/cardBy* cleanup, WorkerPool cancel
propagation, named `process_*_with_flags` wrapper, shared worker-message-types module).
They are too large to do safely without runtime/browser verification, which is not
available in this junctioned, headless worktree.

- **Untyped ~30-field card state-bag.** Each gallery card element carries ~30
  ad-hoc `_`-prefixed expando fields (`_taskId`, `_file`, `_tauriPath`, `_blobUrl`,
  `_lightbox`, `_jxlDecoded`, `_jxlThumbBmp`, `_thumbRgb`/`_thumbW`/`_thumbH`,
  `_thumbNativeW`/`_thumbNativeH`/`_thumbOrientation`, `_sensorW`/`_sensorH`,
  `_embeddedPreview`, `_subjects`, `_crop`, `_focusedSubjectId`, `_sourceMode`,
  `_tauriResult`, `_pipelineMs`, ...). They are read/written across hundreds of sites
  in main.js plus several sibling modules (`window.renderSubjectThumb`,
  `applyCropAndSubjectsToCard`, the lightbox draw path). Moving them into one typed
  `card._state` sub-object (or a parallel `WeakMap<HTMLElement, CardState>`) is an
  ADR-level change: the reference surface is too large to restructure correct-by-
  construction without a real browser to exercise the gallery + lightbox + Tauri
  batch paths. **Recommendation:** write an ADR proposing a `WeakMap`-backed
  `CardState` (auto-GC when the element is removed, also fixes the map-leak class),
  migrate field-by-field behind accessors, verify each batch in-browser.

- **`card._lightbox` untagged union.** `card._lightbox` is sometimes a fully-decoded
  `{ rgb, w, h }`, sometimes a lazy Tauri stub `{ rgb: null, w, h, id, fetching }`,
  and sometimes absent — consumers disambiguate by ad-hoc truthiness/`rgb == null`
  checks (`havePair`, raw-mode gating, the lazy `get_lightbox(id)` fetch). Same
  deferral reason: typing it as a discriminated union (`{ kind: 'decoded' | 'lazy' }`)
  touches every `_lightbox` read and needs in-browser verification of the lazy-fetch
  state machine. Fold into the same CardState ADR above.
