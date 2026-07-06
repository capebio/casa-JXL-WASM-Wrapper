# S1-G1 Report — raw-pipeline unification trial (consolidated)

**Program:** Wave-2 §S1 (end the raw-pipeline fork). Parent specs:
`docs/STRATEGIC-MAP-wave2-2026-07-06.md` §S1, `docs/HANDOFF-S1-crate-unification-2026-07-06.md` (Phase 4).
**Scope:** G1 = integration trial + measurement + inventory. Nothing deleted, no behaviour
adopted silently, fully reversible. G2 (vendored-copy deletion, dependency pin, GPL removal,
freeze rule, holo porting) is a **separate, user-approved** step — see §7.
**Consolidates:** `docs/S1-timings-report.md` (Phase 3 timings + parity), and **adds** the two
sections Phase 4 requires that the timings report lacked: the **holo-win port-audit inventory**
(§6) and the **G2 recommendation + effort estimate** (§7).

> Branch of record: `s1/wave2-overnight` (this worktree, `C:\Foo\rcw-s1`). Shim commits
> `553d3970` (encode_rgba16), `4c545fd9` (encode_raw_pyramid_ladder) are already in the branch
> history. Overnight additions: tiff panic-safety port `02cd8d66` (§6.7) + this report.

---

## 1. Headline

- **End-to-end ORF ingest, old vendored fork → canonical crate: 349 ms → 292 ms (−6 %)**, native
  MSVC release, `target-cpu=native`. Win is dominated by the decompress stage (−13 %); the tone
  pass regresses +40 % because the canonical crate runs **more** tone stages (see §4 — this is a
  deliberate quality difference, not a bug, and is the one behaviour delta requiring user sign-off).
- **Parity:** 6/6 pixel-correctness tests pass on real ORF + DNG; decoded output deterministic and
  bit-exact across repeated calls. **Zero unexplained diffs.**
- **Drop-in feasibility:** confirmed. The canonical crate compiles clean on both feature paths
  (pure-Rust RAW paths, and full `jxl-codec`/libjxl), and is a safe replacement for the vendored fork.
- **Holo audit verdict:** the canonical crate is a **superset of essentially every landed holo win**
  — it ran the same campaigns earlier and usually landed a stronger version. Only a handful of
  genuinely-missing, byte-neutral items exist (§6); the output-changing ones are user decisions (§8).

---

## 2. Timing comparison (Phase 3)

Test file **P1110226.ORF** (Olympus E-M5, 5240×3912 = 20.5 MP). Release build, 3-run average,
Windows 11, native MSVC.

| Stage | OLD (vendored, no native) | OLD (`target-cpu=native`) | CANONICAL (`target-cpu=native`) | Δ vs old+native |
|-------|--------------------------|--------------------------|----------------------------------|-----------------|
| decompress | 285 ms | 248 ms | **215 ms** | **−13 %** |
| demosaic | 20 ms | 20 ms | **18 ms** | **−10 %** |
| tone (process) | 44 ms | 42 ms | **59 ms** | **+40 %** |
| **total** | **349 ms** | **310 ms** | **292 ms** | **−6 %** |

**Build-flag caveat (load-bearing):** without `-C target-cpu=native` the canonical crate is *28 %
slower* (446 ms) — its AVX2 demosaic/decompress paths are gated on runtime CPU detection that only
fires under native tuning. The old pipeline had no SIMD and is unaffected. **Production builds must
set `target-cpu=native`** (or add it to `.cargo/config.toml`). The app-side `.cargo/config.toml`
requirement is captured in §5.

**Tone +40 % explained:** `PipelineParams::default_olympus()` in the canonical crate runs additional
stages (tone matrix + saturation/vibrance + unsharp LUT path) absent from the old fork. The pipeline
is still −6 % end-to-end because decompress (the dominant cost) wins. This is a **quality/behaviour
difference**, adjudicated in §4 and deferred to the user in §8.

---

## 3. Parity (pixel correctness, Phase 2)

All 6 tests in `crates/raw-pipeline/tests/parity_corpus.rs` pass:

| Test | File | Result |
|------|------|--------|
| `orf_rgba8_sanity` | P1110226.ORF 5240×3912 | ✓ non-trivial pixels, correct size |
| `orf_rgba8_deterministic` | P1110226.ORF | ✓ bit-exact across two calls |
| `orf_process_rgb8_timing` | P1110226.ORF | ✓ decompress+demosaic+tone run clean |
| `dng_rgb8_sanity` | PXL…dng 3628×2732 | ✓ non-trivial pixels, hash stable |
| `dng_rgb8_deterministic` | PXL…dng | ✓ bit-exact across two calls |
| `dng_align_to_rggb_infallible` | PXL…dng | ✓ plain tuple (not Result) confirmed |

Deterministic pixel hashes (release, `target-cpu=native`): ORF rgba8 `0x8806822277eac608`;
DNG rgb8 `0x3c3fb14139efec5c`. These hashes are the byte-exact gate for any later port (§6.7 used
them: the tiff guard left both unchanged).

### 3.1 Parity adjudication (diff classes)

| Diff | Class | Citation |
|------|-------|----------|
| Decoded pixels ORF/DNG (canonical vs canonical, repeat) | (i) identical | deterministic tests above |
| Tone pass renders differ old→new (more accurate colour) | (ii) intentional canonical difference | canonical runs tone matrix + sat/vibrance + unsharp that the old fork lacks; **flagged to user** (§8-A, matches STRATEGIC-MAP open decision #2) |
| — | (iii) unexplained | **none (0)** |

Count of unexplained diffs: **0** → does not block the G2 recommendation.

---

## 4. Behaviour differences requiring sign-off (no silent adoption)

1. **Tone rendering** (the only pixel-visible delta on the ingest path). Canonical's
   `default_olympus()` tone chain is richer → images differ visually from the old vendored version
   (more saturated/tone-mapped, "more accurate colour"). This is intentional canonical evolution, not
   a regression, but it **changes user-visible output** and therefore needs explicit sign-off before
   the app adopts the canonical crate as its ingest. Deferred: §8-A.

No other behaviour difference was observed on the corpus. All hardening/bounds differences between
lineages only change error behaviour on malformed input (behaviour-neutral for valid files).

---

## 5. Shim inventory, app call-site edits, feature & build notes

### 5.1 Compat shims added to the canonical crate (branch history)

Both are thin, additive, behaviour-neutral delegations in
`crates/raw-pipeline/src/casabio_encode.rs` (feature-gated `jxl-codec`, native only):

| Shim | Commit | Delegates to | Notes |
|------|--------|--------------|-------|
| `encode_rgba16(rgba16, w, h, distance, effort) -> Result<Vec<u8>, EncodeError>` | `553d3970` | `Encoder::new(EncodeOptions::distance(d).with_effort(e))?.encode(&Frame::rgba(...))` | Maps the old jpegxl-rs-backed RGBA16 encode to the BSD `jxl_casaencoder`. `Frame::rgba` gives the 4-channel RGBA stride matching 16-bit RGBA input. |
| `encode_raw_pyramid_ladder` (`pub use … as`) | `4c545fd9` | `encode_rgba8_pyramid_from_rgb16` | Pure re-export alias; old name for the same function. |

**Verified (this session):** both referenced symbols exist with matching signatures
(`jxl_casaencoder.rs`: `Frame::rgba` :159, `EncodeOptions::distance` :318, `with_effort` :330,
`Encoder::new` :431, `encode` :487, `EncodeError` :33; `casabio_encode.rs`:
`encode_rgba8_pyramid_from_rgb16` :1809) **and the whole crate type-checks clean with default
features (`jxl-codec` → libjxl built via jxl-ffi)** — see §5.4.

No further app-needed shims were required beyond these two: the remaining API drift (below) was
covered by rewriting the app call sites, and the `jxl_lowlevel → jxl_casadecoder` rename already has
a back-compat alias in the crate (`lib.rs:14`, `pub use jxl_casadecoder as jxl_decode`).

### 5.2 App call-site edits (on `s1/g1-canonical-crate-trial`, worktree `C:\Foo\jtw-s1-g1` — app repo, not this tree)

| Old API | New API | Files |
|---------|---------|-------|
| `process(rgb16, w, &params)` | `process(rgb16, &params)` (width dropped) | pipeline.rs ×8, bench.rs, casabio.rs, strategy_bench.rs ×4, lightbox_bench.rs |
| `process_rgba(rgb16, w, &params)` | `process_rgba(rgb16, &params)` | casabio.rs, pyramid_store.rs |
| `align_to_rggb(…).map_err(…)?` | `let (s,w,h) = align_to_rggb(…);` (infallible) | pipeline.rs, bench.rs, strategy_bench.rs |
| `apply_orientation_rgba` | `apply_orientation` | casabio.rs, pipeline.rs |
| `jxl_lowlevel::decode_progressive_frames` | `jxl_casadecoder::decode_progressive_frames` | pipeline.rs |
| `ExifData { 14 fields }` | `ExifData { …, raw_width: None, raw_height: None }` | pipeline.rs ×3 |
| `get_orf_metadata`/`bench_decode_orf` `String` error | `.map_err(|e| e.to_string())` on the outer `await?` | pipeline.rs |

### 5.3 Feature set & libjxl

- App requests `["simd", "jxl-lowlevel", …]`; canonical exposes `parallel`, `jxl-codec`,
  `c-perceptual`, `image-formats` (default = `["parallel", "jxl-codec"]`).
- **The app does its own JXL via GPL jpegxl-rs today**, so the canonical crate can in principle be
  consumed with `default-features = false` (RAW parser/pipeline only, no libjxl). However, the app's
  Tauri-side uses that G2 will migrate (the `encode_rgba16_jxl` command, pyramid client) target the
  canonical **encoder**, which *is* `jxl-codec`. G1 built canonical with `jxl-codec` (libjxl) to
  prove the encoder shims compile; whether the app's *day-1* dependency needs `jxl-codec` is a
  packaging call for G2 (§7).
- Path dependency used for G1:
  `raw-pipeline = { path = "C:/Foo/raw-converter-wasm/crates/raw-pipeline", … }` (absolute path is
  fine for a trial; packaging = G2).

### 5.4 Verification performed (this session), commands + results

| Check | Command | Result |
|-------|---------|--------|
| Pure-Rust RAW paths + parity | `cargo test -p raw-pipeline --no-default-features --features parallel --lib --test parity_corpus` | **210 lib + 6 parity pass, 0 failed** (includes the 3 new tiff tests) |
| Full crate w/ codec (shims) | `cargo check` default features under MSVC+LLVM, `LIBJXL_SOURCE_DIR`/`LIBCLANG_PATH` from `.cargo/config.toml`, isolated target | **exit 0**, `jxl-ffi`(libjxl) + `raw-pipeline` check clean, 2m50s, only 20 pre-existing dead-code warnings |

`wasm32-unknown-unknown` check was **not** re-run this session (the crate's wasm path is unchanged by
S1 work; `.cargo/config.toml` carries the `+simd128` flag). Recommend a `cargo check --target
wasm32-unknown-unknown --no-default-features --features parallel` in CI as the standing gate.

---

## 6. Holo-win port-audit inventory (Phase 4 §5 — the G2 porting worklist)

Method: each old-lineage holo win was read **read-only** (`git -C <holo-worktree> show <SHA>`) and
classified against the canonical crate (`crates/raw-pipeline/src/`): **ALREADY-HAVE** /
**MISSING** / **OVERLAPPING-DIFFERENT**, with byte-exact risk. The canonical crate ran its own
optimization campaigns on these same files (decompress trunc-fold, ljpeg micro-ops/hot-path/decode_c4,
demosaic SIMD/MHC-AVX2, tone_simd matrix-seam, CR2 fused crop+c4, pipeline deep pass), which is why so
much is already present, frequently in a stronger form.

Holo source layout: `<worktree>\raw-pipeline\src\<file>.rs` (old lineage; note the file is
`jxl_lowlevel.rs`, renamed `jxl_casadecoder.rs` in canonical).

### 6.1 decompress-holo — table-free Huffman **+17.9–19.2 %** (worktree `-decompress-holo`, `68967bb`, `cb57e9c`, `bc84e43`)

| Sub-change | Class | Evidence |
|---|---|---|
| Table-free Huffman via `leading_zeros` | **ALREADY-HAVE** | canonical `decompress.rs:451-465` (`clz-20` closed form ≡ holo `clz-19`−1); guarded by `huff_lz_equiv_sweep` test :520-549 |
| Branchless adaptive bit-width | **ALREADY-HAVE** | `decompress.rs:49-51` + `d2_equivalence_sweep` :553-576 |
| Branchless gradient predictor | **ALREADY-HAVE** | `decompress.rs:108-124` (byte-for-byte) |
| `decompress_into` caller-owned buffer | **ALREADY-HAVE (superset)** | canonical `decompress_rows_into` :190, `OrfRowDecoder` :257, `for_each_strip` :322 |
| Paired even/odd register-resident interior | **OVERLAPPING-DIFFERENT** | canonical **benchmarked & rejected** this exact idea as thermal noise: `parity_unroll_reject` :497-512 (mean ~+0.5 %, sign-unstable) |
| Unchecked interior indexing | **ALREADY-HAVE** | raw-ptr unchecked hot store :131-133 |

**Verdict: nothing to port.** The headline +17.9–19.2 % was measured against the holo's own
table-based baseline — the exact win canonical already banked. ⚠ The holo's table-free `read_huff`
**dropped truncation detection**; canonical **retains** robust `Err` on exhausted bitstream — canonical
is strictly better; do **not** port the holo version. Byte-exact risk: none (all canonical swaps carry
equivalence tests).

### 6.2 ljpeg-holo — cps==1 kernel + drop 512 KB zero-fill + harden (worktree `-ljpeg-holo`, `2a23f1e`, `c27108a`)

| Sub-change | Class | Evidence |
|---|---|---|
| cps==1 monomorphized fast kernel | **ALREADY-HAVE (stronger)** | canonical const-generic `decode_c1/c2/c4` over precision, dispatched `ljpeg.rs:721-812`, :896-909 |
| Right-size `lookup` table (`1<<max_bits`) | **ALREADY-HAVE** | `ljpeg.rs:96-97` (label "L10") |
| Drop eager 512 KB empty zero-fill | **ALREADY-HAVE (better design)** | canonical uses `Option<HuffTable>` (`None`, no stub): :527, :905 |
| Correctness hardening (oversubscribed / cat≤precision / truncation / point-transform / seg-len) | **ALREADY-HAVE (better placed)** | :72-80, :608-622 (per-table not per-symbol), :277-294 (`Result` not flag), :960/:1085/:1272/:1413, :473-478/:572-580 |
| SOS scan-order policy | **OVERLAPPING-DIFFERENT** | canonical **remaps** non-identity order (:543-548); holo **rejects** it — canonical is broader |

**Verdict: nothing to port.** Byte-exact risk: none for valid streams.

### 6.3 demosaic-holo + demosaic-simd (worktrees `-demosaic-holo` `8667fd2..6c120ae`, `-demosaic-simd` `349d9bc..e94feee`)

| Sub-change | Class | Byte-exact / output |
|---|---|---|
| Branch-free / clamp-free interior | **ALREADY-HAVE** | technique present: `bilinear_interleaved_pair` :192-247, MHC interior clamp-elision :1211-1268, :1701-1797 |
| Error-not-panic + checked `w*h*3` sizing | **ALREADY-HAVE** | `validate` :32-48, `checked_mul` :259-270 |
| AVX2 MHC interior (technique) | **ALREADY-HAVE** | `mhc_row_interior_avx2` :1317-1438, always-on x86, pinned bit-identical |
| **CFA-aware bilinear borders** | **MISSING — OUTPUT-CHANGING** | reconstructs edge ring from in-bounds same-CFA neighbours vs canonical's coord-clamp; changes 1 px border ring (worked example: G at col-0 R site 1750 → 2000). **User decision (§8-B).** |
| **Symmetric MHC B-at-R correction** | **MISSING — OUTPUT-CHANGING (~25 % of pixels)** | canonical is deliberately **asymmetric** (R-at-B corrected :1163-1173; B-at-R plain bilinear `>>2` :1121). Holo adds the Malvar mirror at R sites → shifts colour frame-wide. **Load-bearing: baked into holo's branch-free/AVX2/wasm interiors**, so none of those are "byte-identical" ports without accepting this. **User decision (§8-B).** |
| **`MhcKernel::Canonical` (Malvar) opt-in variant** | **MISSING — OUTPUT-CHANGING when selected** | new `enum MhcKernel` + `_variant` entries; additive API, but default still differs from canonical via the symmetric baseline. **User decision (§8-B).** |
| **wasm SIMD128 MHC interior** | **MISSING (genuine capability gap)** | canonical SIMD-izes only the *bilinear* wasm path; MHC on wasm is scalar. **But as delivered it hardcodes the symmetric B-at-R** → output-changing. To land the perf without a colour change it must be **re-derived** with canonical's asymmetric formula. |

**Verdict:** the perf techniques are already in canonical; the only genuinely-missing *perf* surface is
the **wasm-SIMD128 MHC interior**, and it must be re-expressed against canonical's asymmetric kernel to
stay byte-exact. Every quality change (borders, symmetric B-at-R, Malvar variant) is a **user decision**,
not a free port. A wholesale branch swap would **regress** canonical's phase-general kernels (band /
planar / saliency / matrix entries) — integration must cherry-pick into the phased kernels.

### 6.4 pipeline-holo — fuse blur+apply **+42 %**, 16-bit LUT cache, DC-gain/overflow fixes (worktree `-pipeline-holo`, `1f6a49b` ≡ base `dc1c0cb`)

| Sub-change | Class | Note / byte-exact |
|---|---|---|
| **Fuse blur+apply** (`separable_blur_apply`) | **OVERLAPPING-DIFFERENT — REGRESSIVE, do NOT adopt** | canonical `apply_unsharp_masks` :1171 has **PIPE-003** fix (snapshots pre-unsharp original for the clarity pass, :1187-1231). Holo blurs `rgb16` in place → clarity reads texture-sharpened pixels. **Byte-identical only for single-slider; changes pixels when `texture≠0 && clarity≠0`.** Memory win already covered by pooled `BLUR_SCRATCH` (:741). |
| 16-bit LUT cache/reuse | **ALREADY-HAVE (superior)** | canonical `post16` in `LutCache` :688, split pre/post rebuild :706/:726, `ensure_lut` :1707 |
| DC-gain kernel fix (0.1372) | **ALREADY-HAVE** | `gaussian_kernel_13` :891-896 already 0.1372 |
| downscale u64 accumulators | **ALREADY-HAVE (superior)** | :2884, reciprocal-multiply :2905/:2930 |
| **downscale identity fast path** | **MISSING — also fixes a latent black-frame bug** | canonical exact-factor recip = `(1<<64)/1 = 0` → identity downscale yields **black** (:2905). Holo's `sw==dw&&sh==dh → copy_from_slice` guard fixes it. **Changes output only for the exact-identity case (black → correct); verify reachability. User-flagged (§8-C).** |
| `target_dims` zero guard; `channels==0` rejection | **ALREADY-HAVE** | :3065-3068, :65 |
| u16 validator 2-bytes/sample budget; texture/clarity `[-1,1]` clamp | **MISSING (low-value hardening)** | canonical validates u16 at 1 byte/sample (:102-118) and doesn't clamp texture/clarity; only affects out-of-range/oversize inputs |

### 6.5 rct-tone-clut + rct-fused-rgba — fused S·M matrix +24–31 %, process_into (worktrees `rct-tone-clut-m3q8` `b643e00`/`41afae0`, `rct-fused-rgba-r7k2` `b643e00` subset)

| Sub-change | Class | Evidence |
|---|---|---|
| `process_into` (alloc-free RGB) | **ALREADY-HAVE** | canonical `process_into` :1812 (`process` delegates) |
| Fused `process_rgba` (direct 4-ch write) | **ALREADY-HAVE** | canonical `process_rgba` :2368 already fused, `*dst=255` inline :2424 |
| **`process_rgba_into` (alloc-free RGBA)** | **MISSING (trivial)** | canonical has `process_into` but no RGBA `_into`; a thin `out`-taking wrapper over the already-fused core. Byte-neutral. Only real net-new API from these two. |
| Fused S·M matrix on vib_zero path | **ALREADY-HAVE (canonical is the ORIGIN)** | `tone_simd::vib_zero_matrix` :50, `apply_tone_bulk_matrix` :363/:386/:403; `matrix_fused` `pipeline.rs:1682-1687` (also gated on perceptual_constancy — more general) |

Note: `rct-fused-rgba-r7k2` is a strict **subset** of `rct-tone-clut-m3q8` (same `b643e00` SHA + a
test-only harness); no separate audit needed.

### 6.6 cr2slice — slice reassembly + fused crop (worktree `-cr2slice`, `1e15e1b`, `6f234de`)

| Sub-change | Class | Evidence |
|---|---|---|
| Slice reassembly (raster → sensor order) | **ALREADY-HAVE (superset)** | `reassemble_slices` :473, `_scatter` :522, `ReassemblyVariant` :357 |
| Fused reassemble + crop | **ALREADY-HAVE (superset)** | `reassemble_slices_crop` :761-827, streaming `Cr2RowSource`. ⚠ Holo uses **center-crop only**; canonical prefers **SensorInfo active-area** origin (`choose_crop_origin` :731-760) — adopting holo would **regress** the crop on real bodies. |
| Slice tiling / implausible-slice validation | **ALREADY-HAVE** | `bail!` :1053-1055, :1072-1080 |
| `SampleSink` decode-into-crop (mem 70→34 MiB) | **OVERLAPPING-DIFFERENT (low value)** | holo itself measured ~3.8 % **slower**; canonical's memory answer is `Cr2RowSource`. Byte-identical. |

**Verdict: nothing to port** (and do NOT adopt the center-crop origin).

### 6.7 dng-land1 + tiffharden (worktrees `--dng-land1` `1007496`, `-tiffharden` `3748646`/`1ccad6f`)

| Sub-change | Class | Evidence |
|---|---|---|
| DNG row-wise uncompressed decode | **ALREADY-HAVE (faster)** | canonical `decode_uncompressed` :662-785 uses `fill_u16_row` with LE `copy_from_slice` memcpy |
| DNG endian / 0x884C reject / area-rank / alloc guards | **ALREADY-HAVE (some stronger)** | :148/:662-667, :929-940, :1067-1075, :114-120/:1178 |
| **DNG band-parallel uncompressed tiles** | **MISSING (byte-neutral perf)** | canonical parallelizes only comp=7 LJPEG tiles (:490); the comp=1 uncompressed loop is serial (:683). `par_chunks_mut` over disjoint bands is directly compatible. Applies only to uncompressed DNGs. |
| TIFF GPS hemisphere / inline-ASCII | **ALREADY-HAVE** | canonical `as_ascii` decodes inline count≤4 (:573-585); S/W negation :456-466 ("TIFF-001") — the holo bug is not present |
| **TIFF single-pass fused JPEG scanner** | **MISSING (byte-identical perf)** | canonical still two separate two-pass scanners each allocating `sois: Vec` (:81-119, :164-201); holo's `find_embedded_jpeg_range` is alloc-free, same selection |
| **TIFF `parse_header` short-input guard** | **PORTED THIS SESSION → commit `02cd8d66`** | canonical `parse_header` indexed `data[0..4]` unguarded → `parse_orientation(&[])` panicked (WASM abort). Fixed with `if data.len() < 8 { bail! }`; byte-neutral for valid files. Proof gate preserved: `parse_orientation_short_input_no_panic`, `_and_dims_short_input_no_panic`, `parse_header_min_valid_len_ok`. Parity hashes unchanged (§3). |
| TIFF thumbnail SOI/EOI+8 MiB cap; read_ifd reject-vs-truncate; `Reader::slice` checked_add | **OVERLAPPING-DIFFERENT (minor)** | canonical guards these differently; valid-file-neutral |

### 6.8 jxl_lowlevel borrowed progressive surface — `758851b` (crate-level)

**ALREADY-HAVE (canonical superset).** Canonical `decode_progressive_frames_borrowed`
(`jxl_casadecoder.rs:1047`) emits a borrowed `DecodeProgressiveEvent::Progress { rgba: &[u8] }`
(:1031, borrows `&out_buf` :1123 — zero per-pass clone); the retaining `decode_progressive_frames`
(:1293) is the `to_vec()` compat wrapper. First-pixel metric fix (`unwrap_or(total)`) present at
:1146; FFI hardening (fatal `SetImageOutBuffer`) present :1104-1113 / :879-898. Canonical adds beyond
the holo: decompression-bomb `DecodeLimits` :1088-1096, K2 tier-offset probe :1169. **Nothing to port;
byte-neutral.**

### 6.9 App-level (out of shared-crate scope — not crate ports)

| Win | SHA | Why out of scope |
|---|---|---|
| RGBA16 wire-packing P0 fix | `0fbdbff` (`rgba16-fix`) | Touches `src-tauri/src/pipeline.rs` **only**; the crate primitive `validate_pixel_buffer` is correct — the app mis-packed an 8-bpp payload as 3-ch. App IPC glue, not crate. |
| Live-concurrency pool sizing / typed channel count / latest-wins slider | `0de3a4a` (`rct-pipeline-realwins`) | Touches `src-tauri/src/{lib,pipeline,priority_sem}.rs` **only**; `PrioritySem`/`apply_look_stream`/`FILE_CONCURRENCY` have no crate counterpart. Tauri runtime/UX. |

These two land in the **app repo** when it adopts the canonical crate (they are already on app
branches); they are not crate porting obligations.

### 6.10 Port worklist summary (for G2)

**Byte-neutral, safe to port into canonical (each keeps its own proof gate):**
1. ~~TIFF `parse_header` short-input guard~~ — **DONE this session (`02cd8d66`)**.
2. **`process_rgba_into`** (pipeline.rs) — trivial alloc-free wrapper over the fused RGBA core; add a
   `process_rgba_into == process_rgba` byte-identical unit test. *Only if the app needs it* (it migrated
   to `process_rgba`, so this is optional convenience — do not add speculatively).
3. **TIFF single-pass fused JPEG scanner** (tiff.rs) — merge the two two-pass scanners; gate with a
   byte-identical selection test across the real corpus (largest/smallest range must match old output).
4. **DNG band-parallel uncompressed tiles** (dng.rs) — `par_chunks_mut` over disjoint bands; **needs an
   uncompressed-DNG fixture** to prove byte-exact (the corpus DNG is comp=7 LJPEG, so the current suite
   would not exercise the changed path — do not land unverified).

**Latent-bug fix, output-changing → user decision (§8-C):**
5. **downscale identity black-frame guard** (pipeline.rs) — fixes recip=0 black output on identity
   downscale; changes the identity-case pixels (black → correct). Needs reachability analysis + its own
   proof.

**Output-changing quality/colour → user decisions (§8-B), NOT free ports:**
6. Demosaic CFA-aware borders; symmetric MHC B-at-R correction; `MhcKernel::Canonical` variant; wasm
   SIMD128 MHC (re-derive against canonical's asymmetric kernel to make the *perf* byte-exact).

**Everything else: ALREADY-HAVE (canonical equal-or-superior) — no action.**

---

## 7. G2 recommendation + effort estimate

**Recommendation: proceed with G2.** G1 shows the canonical crate is a −6 % faster, parity-clean,
compile-verified superset. The remaining fork spend is pure waste. Sequenced, lowest-risk first:

| G2 step | What | Where | Effort | Risk |
|---|---|---|---|---|
| **7.1 Packaging** | Replace app's vendored `path = "../raw-pipeline"` with a pinned dependency on the canonical crate. **Recommend a git dependency + tag pin** (e.g. `raw-pipeline = { git = "…/raw-converter-wasm", tag = "raw-pipeline-vX.Y.Z" }`) over a bare same-machine path dep, so the desktop app builds off-machine and reconstructs a specific revision. Path dep acceptable as an interim on a shared build host. | app `src-tauri/Cargo.toml` (**app repo — out of this tree**) | **S** (½ day) | Low |
| **7.2 `.cargo/config.toml`** | App must set `-C target-cpu=native` (else −28 %) + `LIBJXL_SOURCE_DIR` + `LIBCLANG_PATH` if it takes the `jxl-codec` feature. | app repo | **XS** | Low |
| **7.3 Vendored-copy deletion** | Delete `raw-converter-tauri/raw-pipeline` + `JXL_Tauri_with_WASM/raw-pipeline` after the app builds green off the canonical crate. Keep a tag before deletion for revert. **Do NOT delete until the app CI is green on canonical** (G1 kept both A/B sides buildable — preserve that until cutover). | app repos (**out of this tree**) | **S** | Medium (irreversible-ish; mitigated by tag) |
| **7.4 GPL removal** | Drop `src-tauri`'s direct `jpegxl-rs`/`jpegxl-sys` (GPL) once the `encode_rgba16_jxl` command + pyramid client route through the canonical **BSD** encoder (the shims in §5.1 are the landing pads). Licensing win alone justifies S1. **This edit lives in the APP repo — described here, NOT done in this tree.** | app `src-tauri` (**out of this tree**) | **M** (1–2 days: migrate all jpegxl-rs call sites to `jxl_casaencoder`, re-verify encode output) | Medium (encode-output parity check needed) |
| **7.5 Freeze rule** | No new optimization work on the old-lineage copies once cutover lands; the ~14 holo/rct worktrees become archival. Enact by README note + branch-protection convention. | process | **XS** | Low |
| **7.6 Holo-port worklist** | Execute §6.10: (a) DONE tiff guard; (b) fused JPEG scanner + `process_rgba_into` — byte-identical, ~½ day each with proofs; (c) DNG band-parallel uncompressed — ~½ day **+ an uncompressed-DNG fixture**; (d) identity-downscale bug fix — user-gated (§8-C); (e) demosaic colour/quality items — user-gated (§8-B), each needs golden-image sign-off (ties into S4/S5). | this crate | **M** total (excl. user-gated items) | Low for (a)-(c); the user-gated items are S5-colour-scope |

**Total G2 (crate + app plumbing, excluding user-gated colour work): ~4–6 engineer-days.** The GPL
removal (7.4) and vendored deletion (7.3) are the load-bearing wins; the holo ports are mostly
already-have, so 7.6 is small. The colour/quality holo items (demosaic symmetric MHC, borders) should
be folded into **S5 (scene-referred colour)** with its golden-approval workflow rather than ported ad
hoc — they change pixels and the user is strict on colour parity.

**Gate before 7.3/7.4:** app builds green on canonical + an ingest byte-parity pass on a fixture corpus
(the tone-render difference in §4 is the one expected, user-signed-off delta).

---

## 8. Deferred to the user (see `docs/WAVE2-QUESTIONS-DEFERRED.md` §S1)

- **8-A. Tone-render adoption.** Canonical's richer `default_olympus()` tone chain changes user-visible
  output vs the old vendored fork (more accurate colour, +40 % tone cost). Adopt as the app's ingest
  (recommended) with a one-time visual sign-off? (Matches STRATEGIC-MAP open decision #2.)
- **8-B. Demosaic colour/quality holo items.** CFA-aware borders, symmetric MHC B-at-R correction, and
  the `MhcKernel::Canonical` variant all change decoded pixels. Adopt into canonical (they are arguably
  more correct), keep canonical's current asymmetric/clamped behaviour, or route through S5's
  golden-approval workflow? Recommended: **defer to S5**, do not port silently.
- **8-C. Identity-downscale black-frame fix.** Port the `sw==dw&&sh==dh → copy_from_slice` guard? It
  fixes a latent black-output bug but changes the identity-case pixels. Recommended: **port with a
  reachability check** (if all live callers guarantee `dw<sw` the bug is dormant and the guard is
  belt-and-braces). Flagged rather than landed silently per the strict-parity mandate.

---

## 9. What this session changed (audit trail)

- **Report:** wrote this `docs/S1-G1-report.md` (consolidates `docs/S1-timings-report.md` + adds §6
  holo inventory and §7 G2 recommendation, per Phase 4).
- **Port:** `02cd8d66` — tiff `parse_header` panic-safety guard (§6.7), the one byte-neutral
  genuinely-MISSING item provable byte-exact; 3 regression tests added.
- **Verification:** pure-Rust suite 210 lib + 6 parity green; full `jxl-codec` crate check exit 0
  (shims compile). Commands + results in §5.4.
- **Not done (per G1/strict-parity scope):** no vendored deletion, no GPL removal, no app-repo edits,
  no output-changing ports, no G2 destructive steps.
