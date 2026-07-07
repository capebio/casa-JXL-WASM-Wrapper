# EpicCodeReview — 20260619T124908Z

**Target:** 5 named files (selected from memory).
**Mode:** workalone. **Branch:** `epiccodereview/ssim-boundary-20260619`.
Files: `packages/jxl-wasm/src/facade.ts`, `packages/jxl-wasm/src/bridge.cpp`,
`packages/pyramid-ingest/src/backends.ts`, `.flipflop/tests/jxtc-vs-full-decode.mjs`,
`.flipflop/lib/raw-corpus.mjs`. (`packages/pyramid-ingest/package.json` collected but not reviewable source.)

## Pipeline
5 finders (correctness, hacker, structure + whole-target architecture, vision) → 47 candidates →
dedupe → 46 → 3 verifiers → **22 confirmed / 15 false-positive / 9 uncertain** → 1 fix applied + committed.

## Fixed this run (1)

### ✅ EC descriptor stride drift — HIGH (committed `f6821bb1`)
`serializeExtraChannelsForWasm` (facade.ts) wrote **72-byte** extra-channel records; the only consumer,
C++ `struct WasmExtraChannel` (bridge.cpp:298), is **20 bytes**. Every C++ site indexes a 20-byte stride,
so for `num_ec ≥ 2` channel *i* was read from offset `i*20` while written at `i*72` → wrong
type/bits/distance and a garbage `plane_ptr` into `JxlEncoderSetExtraChannelBuffer` (heap corruption on
multi-extra-channel encode). Aligned the TS serializer to the shipped 20-byte ABI; dropped
dimShift/spotColor/name writes (past byte 20 — never read by C++; a separate unwired-feature gap).
**No WASM rebuild needed.** The prior "72B bridge" test was a silent no-op (its
`_jxl_wasm_get_extra_channels` symbol does not exist → early return) — replaced with one that proves
channels 1..N land at `i*20`. `tsc` clean; EC test 1 pass / 20 asserts. (1 unrelated pre-existing
facade.test failure: an OOM error-string mismatch at line 846, untouched.)

## Confirmed, deferred → `QUESTIONS.md`

**Rebuild-gated (bridge.cpp — need a WASM rebuild to verify; the approved Phase-6 work):**
- Butteraugli ref **deep-copy per compare** (bridge.cpp:3509-3519) — HIGH perf. `ButteraugliInterfaceInPlace`
  consumes its args, forcing a full 3-plane `memcpy` of the reference every progressive pass. Non-consuming
  `ButteraugliInterface(const Image3F&, …)` exists (butteraugli.h:80). *(Matches the decode-resident
  Butteraugli plan in `docs/SSIM-buffer-engine-flipflop-spec-2026-06-19.md`.)*
- JXTC `tile_count` **32-bit overflow** at a trust boundary (bridge.cpp:1724) — MED/security. Attacker-controlled
  header `tiles_x * tiles_y` in `uint32`; the *encode* path already guards in `uint64` and rejects. Mirror it.
- `ssim_block_luma` **two-pass** per block (bridge.cpp:3571) — MED perf. Fusible to one-pass mean+variance.

**Perf, TS (flipflop-gated; low expected value — the buffer-copy axis already measured as noise):**
- `ButteraugliComparator.compare` mallocs/frees a candidate buffer every call (facade.ts:748); dims are
  constant across passes → a grow-only retained slot removes the churn.
- `computeButteraugli/Psnr/Ssim` re-malloc+copy the fixed reference every pass (facade.ts:689) — no
  `SsimComparator` analogue to the cached `ButteraugliComparator`.
- backends.ts redundant JS copy + `ssim.js`-fallback `Uint8ClampedArray.from` (backends.ts:332/343).

**Correctness, TS (testable, not done this run):**
- **JPEG-end scanner rejects real JPEGs** — `findValidJpegEnd` (facade.ts:2740) bails at the SOS marker
  (0xDA), so `extractJpegReconstructionFromJxl` returns `null` for essentially all genuine embedded JPEGs,
  defeating the advertised jbrd extraction. No crash; silent feature defeat. **Good next fix.**

**Structure (confirmed):**
- `deferredRelease` reusable buffer hard-capped at 1920×1080×4, throws (no grow) on the targeted 24MP RAW
  workloads (facade.ts:1411). Opt-in; no current production caller enables it.
- Unconditional per-call `console.log` of timing in the FFI facade (facade.ts:972/1175/1986/2306/3164) —
  no debug flag; duplicates the `onMetric` sink; harnesses must monkey-patch `console`. Easy gate.
- `DecodeEvent` union duplicates ~12 pixel/region/frame fields (facade.ts:23) — info; shared base refactor.

**Architecture ADR-drafts (opportunities; human ratification — no unilateral edit):**
- **Per-pass metric pixels round-trip heap→JS→heap twice** (SSIM + Butteraugli). Decoder copies pixels out
  of the WASM heap; the metric paths malloc+copy them straight back in. A decode-resident metric (compute
  on the decoder's own heap buffer) is zero-copy. *(Already the headline of the SSIM spec.)*
- Measurement pipeline rides the render/transfer decode path, inheriting its copy cost (P2 separation).
- `convergedByteEnd` / `SSIM_CONVERGED` is **build-dependent policy** — the threshold (0.9995) was calibrated
  to `ssim.js` but the loaded build may use WASM SSIM (~1-2% different). *(Logged in the SSIM commit.)*
- Profiler creates two fresh decoders per level and pools none; the reference could come from the
  progressive `final` event instead of a second full decode.
- flipflop corpus measures only the cheap JXTC ROI path — the expensive metric round-trip is unmeasured.

**Vision ADR-drafts (opportunities):**
- No interleaved-RGBA perceptual-constancy entry on decoder output (the bulk kernel is planar SoA).
  *(Note: the engine IS exposed — `perceptualConstancyApplyBulk`/`getPerceptualConstancySupport` exist at
  facade.ts:3120/3136. The finder's "completely unexposed" claim was a **false positive**.)*
- `DecodedExtraChannel` declared but never produced by any decode path (depth/selection twin data).
- `getDecodeGridInfo()` returns `{}` (facade.ts:1206) — an unpopulated LOD/streaming seam.
- `qualityCurve` pixels are decoded then dropped — a near-zero-cost hook to emit perceptual-hash /
  ML-recognition features for organism ID.

## Notable false positives (15 total; highlights)
- "PC-mode engine completely unexposed" — wrong; bulk wrappers already shipped (above).
- `readBufferView`/`readBufferFields` heap-detach-after-grow — reads `HEAPU8` fresh; no intervening malloc.
- raw-corpus 15 positional FFI args — wasm-bindgen is inherently positional; documented convention.
- PSNR fixed 3-iter inner loop — `/O2` unrolls it.
- `makeBuffer` error-null conflation — both failure states are handled.

## Uncertain (9) → `QUESTIONS.md`
deferredRelease transfer-detach footgun (opt-in, no prod caller); `take_flushed` borrowed-view lifetime
(sole caller copies before yield); decoder cancel/dispose frees WASM state only in the generator `finally`
(leak only if a consumer abandons the iterator); whether the SSIM engine-scale delta flips a real
convergence decision (unmeasured); jxtc `prep()` caches a rejected promise permanently; encoder
pending-push error lost on cancel; SSIM length-guard silently skips a pass's metric.

## Notes
- Branch churn from a concurrent process moved the worktree across branches mid-run; an unrelated
  `crates/raw-pipeline/src/tiff.rs` edit sits unstaged in the tree (not from this review, not committed).
- Workspace: `.epiccodereview/20260619T124908Z/`. Add `.epiccodereview/` to `.gitignore`.
