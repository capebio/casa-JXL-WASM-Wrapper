# EpicCodeReview 20260619T194416Z

## Target

`src/lib.rs`, `packages/jxl-wasm/src/facade.ts`, `crates/jxl-ffi/build.rs`, `external/libjxl`

---

## Section 000 — src/lib.rs + packages/jxl-wasm/src/facade.ts (COMMITTED 960f0692 + 8de70845)

20 fixes applied and committed. 10 perf-sensitive tasks deferred (no harness path; see QUESTIONS.md).

**src/lib.rs — correctness:**
1. **CR2 Bayer phase retry missing RGGB (0,0)** — `ALT_PHASES` now covers all 4 Bayer origins; RGGB cameras no longer fail phase recovery.
2. **PerceptualComparer::new length validation** — `assert!` on `ref_rgba.len() == width*height*4`; surfaces `JsError` on mismatch.
3. **DNG/CR2 rational absent-field denominator** — absent `exposure_time`/`fnumber`/`focal_length` use `den=0` (same as ORF); JS callers no longer see `"0 sec"` / `"f/0"`.
4. **`fs_to_js` lumaVariance divisor** — divides by 65025 (255²), not 65536; matches `frame_stats.rs` native path.

**src/lib.rs — structure:**
5. **`process_orf` flag docs** — `OUT_FULL_16=8` and `OUT_NO_ORIENT=16` (with collision-history note) added to WASM API doc comment.
6. **`ProcessResult.wb_mode` sentinel** — 0xFFFF sentinel documented as `///` JSDoc on the field.
7. **`impl From<Cr2Decoded> for DngDecoded`** — replaces field-by-field struct copy in `process_cr2_impl`; compiler now enforces field completeness.

**packages/jxl-wasm/src/facade.ts — correctness:**
8. **Metadata pointer OOM** — OOM during ICC/EXIF/XMP malloc now throws instead of silently dropping user-provided metadata.
9. **`prepareAdvancedSettings` OOM** — OOM now throws instead of silently returning `count=0`.
10. **`_a6Checked` reset on reload** — flag reset in `setForcedTier` and `setJxlModuleFactoryForTesting`; prevents stale pointer-size assertion on module hot-reload.
11. **`perceptualConstancyApplyBulk` fallback** — scalar no-op now emits `console.warn`; was silently identity-mapping.
12. **`pendingPushError` propagation** — error from failed push now re-thrown in `cancel()`.

**packages/jxl-wasm/src/facade.ts — structure/API:**
13. **`setForcedTier` clears `_cachedDetectedTier`** — stale auto-detected tier no longer persists after forced-tier override.
14. **`JxlCapabilities` and `getCapabilities` exported** — callers can now introspect bridge capability without accessing internals.
15. **Console.log removed from tile decode hot path** — `decodeTiledRegionRgba8` and `decodeTileContainerRegion` no longer emit per-call logs; data available via `onMetric`.
16. **Console.log removed from `LibjxlEncoder`** — two unconditional per-encode logs removed (profile summary + module-setup timing).
17. **`deferredRelease` buffer sized dynamically** — was fixed at 1920×1080×4 (throws on 4K+); now grows lazily to `pixData.byteLength` on first use or when frame exceeds capacity.

**Deferred — perf-unverified (10 tasks):**
Hacker tasks for `fs_core_simd` SIMD re-read, `fs_core_simd_exact` FNV loop, `downscale_rgb16_planar` SIMD, `downscale_rgba` SIMD, `decode_orf_raw` double-demosaic gate, `bilinearResize` rgba16 weight hoisting, `eventsProgressive` copy elimination, `eventsOneShot` streaming, `readBufferView` view promotion, DNG lb/thumb downscale restructure — all deferred; no flipflop/bench path for these kernels in-session. See QUESTIONS.md.

---

## Section 001 — crates/jxl-ffi/build.rs (COMMITTED af78ecb1)

12 fixes applied across `crates/jxl-ffi/build.rs` and `.cargo/config.toml`:

1. **DEP_JXL_PATH → LIBJXL_SOURCE_DIR rename** — `DEP_*` naming implied a Cargo propagation variable; renamed to the conventional `LIBJXL_SOURCE_DIR` pattern; updated in `build.rs` and `.cargo/config.toml`.
2. **CARGO_CFG_TARGET_OS replaces cfg!(windows)** — `cfg!(windows)` evaluates against the host, not the target; replaced with `env::var("CARGO_CFG_TARGET_OS")` for correct cross-compilation semantics throughout the cmake configuration block.
3. **CARGO_CFG_TARGET_OS/VENDOR in stdlib link block** — same fix for `cfg!(target_os)` / `cfg!(target_vendor)` in the C++ stdlib link block.
4. **`.cxxflag("/Zl")` added alongside `.cflag("/Zl")`** — `/Zl` was applied to C TUs but not C++ TUs, leaving CRT defaultlib directives in `.obj` files from `.cpp` sources.
5. **lib_dir sentinel file probe** — lib_dir selection now checks for `jxl.lib` / `libjxl.a` inside `lib/` and `lib64/` before falling back to directory existence, handling multilib Linux correctly.
6. **assert!(lib_dir.exists(), …)** — fires at build-script time with an actionable message pointing to the cmake install prefix rather than producing an opaque linker failure.
7. **NUM_JOBS fallback for cmake parallelism** — `available_parallelism()` replaced by two-level lookup: `NUM_JOBS` first (set by Cargo `-j N`), then `available_parallelism()` — honours explicit parallelism flags.
8. **rerun-if-changed for submodule .git** — `git submodule update` now triggers a cargo rebuild + bindgen re-run via the submodule's `.git` file mtime.
9. **rerun-if-changed for source subtrees** — `CMakeLists.txt`, `lib/include`, `lib/jxl`, `lib/threads` registered individually; cmake no longer runs on every build when sources haven't changed.
10. **rerun-if-changed per-header** — each `include/jxl/*.h` now registered individually (directory-level tracking misses file content changes).
11. **rerun-if-env-changed updated** — `DEP_JXL_PATH` → `LIBJXL_SOURCE_DIR` in the `rerun-if-env-changed` directive.
12. **bindgen .expect() message** — improved to hint at `LIBCLANG_PATH` (LLVM bin dir) and `.cargo/config.toml` configuration for faster developer debugging.

Deferred (build-unverified):
- **CRT mismatch verdict** (001-correctness-e5f6) — `CMAKE_EXE_LINKER_FLAGS=MSVCRTD.lib` vs `MultiThreaded` runtime; uncertain without toolchain probe; deferred to QUESTIONS.md.
- **skcms/lcms2 link list** (001-correctness-o5p6) — depends on cmake config merging skcms into `jxl_cms`; deferred to QUESTIONS.md.

---

## Section 002 — external/libjxl (build-unverified C++)

All 19 findings deferred to QUESTIONS.md — cannot verify without a cmake rebuild.

| Task | File | Sev | Description |
|------|------|-----|-------------|
| 002-correctness-a1b2 | `encode_internal.h:662` | High | `friend class ProcessFrameTest` must be qualified as `jxl::ProcessFrameTest` |
| 002-correctness-c3d4 | `encode.cc:1089` | Med | Remove duplicate `SetFinalizedPosition` call in `ProcessOneEnqueuedInput` |
| 002-correctness-g7h8 | `encode_process_frame_test.cc:47` | Crit | `CreateEncoder()` uses uninitialized `cms` + `memory_manager` — UB if tests compile |
| 002-correctness-m3n4 | `encode_process_frame_test.cc:1` | High | Test file not registered in `jxl_lists.cmake` — never compiled or run |
| 002-correctness-u1v2 | `encode_process_frame_test.cc:79` | High | Replace `raw new` + `MemoryManagerUniquePtr` with `MemoryManagerAlloc`-based allocation |
| 002-hacker-a1b2 | `encode.cc:1019` | Med | Replace `std::vector<uint8_t> box_header` with stack array on hot path |
| 002-hacker-c3d4 | `encode.cc:989` | Low | `std::move` for `frame_info.name` — avoid string copy |
| 002-hacker-g7h8 | `encode.cc:924` | Low | Cache `MustUseContainer()` result in local bool |
| 002-hacker-i9j0 | `lib/CMakeLists.txt:28` | High | Add `/O2 /Ob2` to `JPEGXL_INTERNAL_FLAGS` for ClangCL (fixes known ~30x slowdown) |
| 002-hacker-k1l2 | `CMakeLists.txt:171` | Med | ADR: document AVX512 opt-in build flags for capable targets |
| 002-hacker-m3n4 | `CMakeLists.txt:1` | Med | ADR: investigate LTO/IPO — verify Highway HWY_EXPORT dispatch survives |
| 002-hacker-o5p6 | `encode_process_frame_test.cc:79` | Crit | Fix compile errors: `JxlEncoderQueuedFrame` constructor args + `SetFromBuffer` signature |
| 002-hacker-u1v2 | `encode_internal.h:82` | Low | `StoreFrameIndexBox` loop → `const auto&` to avoid per-entry copy |
| 002-structure-a1b2 | `encode_internal.h:662` | High | Duplicate of 002-correctness-a1b2 |
| 002-structure-c3d4 | `encode_process_frame_test.cc:1` | High | Duplicate of 002-correctness-m3n4 |
| 002-structure-e5f6 | `encode_process_frame_test.cc:79` | Med | Duplicate of 002-correctness-u1v2 |
| 002-structure-g7h8 | `encode_process_frame_test.cc:151` | Low | Remove redundant `frames_closed=true` + add non-last-frame test case |
| 002-structure-i9j0 | `encode_process_frame_test.cc:1` | Med | Add tests for `PrepareHeaders` + `ProcessBox` — two of three extracted methods uncovered |
| 002-structure-k1l2 | `encode_process_frame_test.cc:102` | Med | Rewrite tests to call through real `PrepareHeaders` path (not `wrote_bytes=true` bypass) |

Additional deferred items carried forward:
- **Stale bindgen tracking** (now resolved by Section 001 fix #9/#10 above — per-header `rerun-if-changed` added).
- **jxl-ffi runtime version assertion** — no startup check that compiled-in libjxl major.minor matches linked binary. ADR draft: `.epiccodereview/20260619T194416Z/global/adr_draft/jxl-ffi-runtime-version-check.md`.

---

## Global Pass

ADR drafts produced (all recorded in QUESTIONS.md, files in `.epiccodereview/20260619T194416Z/global/adr_draft/`):

1. `memory-budget-policy.md` — define a typed memory budget policy for the RAW→JXL pipeline
2. `unified-butteraugli-interface.md` — unify the ButteraugliComparator vs ButteraugliInterface call sites
3. `dng-cr2-lookrenderer-factory.md` — extract a LookRenderer factory to avoid per-call reconfiguration
4. `processresult-lazy-buffers.md` — lazy-allocate ProcessResult pixel buffers (skip alloc when caller only wants metadata)
5. `dng-cr2-planar-downscale.md` — pre-demosaic planar downscale for preview-only DNG/CR2 (10–20× throughput gain for gallery ingest)
6. `ar-thumb-first-preview.md` — `process_orf_thumb_fast()` 2×2 bayer-quad average for sub-30ms AR thumbnails
7. `processresult-metadata-only.md` — `parse_dng_metadata()` / `parse_cr2_metadata()` WASM exports for header-only metadata scans
8. `bindgen-rerun-tracking.md` — emit `rerun-if-changed` per libjxl header to prevent stale bindings

Section 000 ADR drafts (`.epiccodereview/20260619T194416Z/sections/000/adr_draft/`):

9. `simd-downscale-rgb16-planar.md` — wasm32 SIMD fast path for `downscale_rgb16_planar` (4–8× throughput; pixel-identical)
10. `simd-downscale-rgba.md` — wasm32 SIMD fast path for `downscale_rgba` using `v128` 4-pixel loads (4× wider; pixel-identical)
11. `look-renderer-tests.md` — unit tests for LookRenderer clarity-clone guard, black pedestal subtraction, orientation dim invariant, and demosaic_rggb_shuffle_simd parity

---

## Open Questions

See `QUESTIONS.md` for the full deferred backlog. Key items from this session:

- All `external/libjxl` C++ source findings require cmake verification before action.
- ADR drafts 1–11 above are awaiting ratification before implementation.
- `perceptual-comparer-validation.md` (section 000 ADR) was partially addressed by fix #2 above; the remaining method-level guards are still open.

Reference: `QUESTIONS.md` lines ~990–1107 (session 20260619T194416Z ADR block).
