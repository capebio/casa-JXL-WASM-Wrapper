# BLISS WASM decode acceleration — handoff to the remote build

**Purpose.** Replicate the BLISS browser-decode speedups on the remote build and reproduce the
paper numbers. Two goals: (1) **proper numbers** for the paper, (2) the **exact methodology that
gives BLISS its quickest decode**.

**Status at handoff (measured locally, 2026-07-22):**
- **v128 SIMD decode kernels — DONE, bit-exact.** Real-content speedup **1.85–1.92×** single-thread.
- **Threads (band-parallel) — analyzed + natively proven ~4×.** Not yet built for WASM (needs the
  MT toolchain below). This is the remaining number the remote build must collect in-browser.

The quickest BLISS decode = **v128 SIMD × band-parallel threads**. Projected lightbox path:
**25.7 (scalar) → 49 (v128) → ~150 MP/s (v128 × 4 bands)**, i.e. **86 ms → ~14 ms**.

---

## 1. What changed (all in the `bliss-core` crate)

Apply `bliss-core-wasm-simd.patch` to the **bliss** repo (the codec crate, path-dep'd by the app):

```
cd <bliss-repo-root>          # the repo containing bliss-core/
git apply --stat  path/to/bliss-core-wasm-simd.patch   # preview
git apply --check path/to/bliss-core-wasm-simd.patch   # verify it applies
git apply         path/to/bliss-core-wasm-simd.patch
```

Four files (decode side only; **native x86 paths untouched — 14 native tests still green**):

| file | what |
|---|---|
| `bliss-core/src/rans_wasm.rs` (new) | `decode16l_v128` — 16-lane rANS in 4×`v128`; emulated gather (no WASM gather); register-resident renorm. `packed_lut` (wasm copy). |
| `bliss-core/src/band_wasm.rs` (new) | `recon_even_row_v128`, `recon_odd_row_inplace_v128`, `ctx_row_v128`, `interleave3_v128` — byte-wise `u8x16`, 16/iter; med3 via min/max; ctx via sub+add_sat+eq; RCT-interleave via `i8x16_swizzle`. |
| `bliss-core/src/lib.rs` (mod) | `#[cfg(target_arch="wasm32")] pub mod rans_wasm; pub(crate) mod band_wasm;` |
| `bliss-core/src/band.rs` (mod) | `decode_stream_fallback` routes 16-lane→v128 on wasm32+simd128; recon + `ctx_row` + `interleave3` gain wasm+simd128 arms (edges scalar, interior SIMD). |

Design constraints (why decode-only): WASM SIMD has **no gather** (emulated; LUT is 16 KB, L1-resident)
and **no 32×32→64 multiply** — the latter only blocks the *encoder's* Lemire division, so the
encoder stays scalar (it's a one-time cache write). The decoder is pure 32-bit → ports cleanly.

---

## 2. Build recipes

### 2a. Default (SIMD) build — ships to all tiers
The repo's `.cargo/config.toml` already sets `-C target-feature=+simd128` for `wasm32-unknown-unknown`
(so the `v128` intrinsics compile with no extra flag). Build the app's wasm pkg as usual, e.g.:

```
wasm-pack build --target web --out-dir pkg --release
```

For the app (`raw-converter-wasm`), rebuild the root `pkg/` — this also **fixes the `LT2R`→`BLSR`
stream-magic skew** (the shipped pkg predates the codec rename, so native tools currently can't read
its `.bliss`; the rebuild aligns them).

### 2b. MT (threads) build — the quickest tier
Decode is band-parallel (`lib.rs` `decode` → `metas.par_iter()`, `#[cfg(feature="parallel")]`).
Enable it in the wasm build and provide a thread pool:

1. Turn on `bliss-core/parallel` in the wasm build (forward it through the app's `parallel-wasm`
   feature, alongside the existing `raw-pipeline/parallel`).
2. Use the project's existing threaded-wasm recipe — `tools/build-mt-wasm.sh` → `pkg-mt/`:
   - nightly Rust + `-Z build-std=std,panic_abort`
   - `-C target-feature=+atomics,+bulk-memory,+mutable-globals`
   - `--shared-memory --import-memory` (wasm-bindgen), `wasm-bindgen-rayon`
   - export + call `initThreadPool(navigator.hardwareConcurrency)` before decoding
   - serve with COOP/COEP (already required by the libjxl MT tier) for `SharedArrayBuffer`.

Threads ship **only** in this MT tier. SIMD (2a) ships everywhere. **No bliss-core code change** is
needed for threads — just enable the feature + build recipe + a thread pool. Exact sandbox recipe used
(reproducible on the remote), from `bliss-wasm-sandbox/`:
```
# 1) sandbox Cargo.toml: wasm-bindgen = "=0.2.121" (match CLI), wasm-bindgen-rayon = {version="1",optional},
#    [features] parallel = ["dep:wasm-bindgen-rayon", "bliss-core/parallel"]
# 2) src/lib.rs: #[cfg(feature="parallel")] pub use wasm_bindgen_rayon::init_thread_pool;
# 3) build (nightly + build-std; RUSTFLAGS REPLACES .cargo/config so re-add +simd128):
MAXMEM=$((2048*1024*1024))
RUSTFLAGS="-C target-feature=+simd128,+atomics,+bulk-memory,+mutable-globals \
 -C link-arg=--shared-memory -C link-arg=--max-memory=$MAXMEM -C link-arg=--import-memory \
 -C link-arg=--export=__heap_base -C link-arg=--export=__tls_base -C link-arg=--export=__tls_size \
 -C link-arg=--export=__tls_align -C link-arg=--export=__wasm_init_tls" \
 cargo +nightly build --target wasm32-unknown-unknown --release -Z build-std=panic_abort,std --features parallel --lib
wasm-bindgen target/wasm32-unknown-unknown/release/bliss_wasm_sandbox.wasm --out-dir pkg-mt --target web
```
Measure in headless Chromium (COOP/COEP → SAB + rayon pool): `gen-mt-data.mjs` pre-encodes real
Gobabeb `.bliss`, `mt-bench.mjs` decodes at `?threads=1` vs `?threads=cores` and reports MP/s + parity.
(Node resolves `playwright` via a `node_modules` junction to the app.)

### 2c. Band count = decode parallelism (a tuning knob)
Bands are **baked at encode**: `default_bands = (h/256).clamp(1, cap)` where `cap = num_threads`
(parallel) or 8 (scalar). Override with env `LT2_BANDS` (1..64). Decode parallelism ≤ band count:
- thumbnail 512px (h≈384) → 1 band → threads give nothing (already ~3 ms; fine).
- lightbox 1800px (h=1200) → 4 bands → up to ~3–4×.
- full 20 MP preview (h≈3600) → ~14 bands → strong scaling.

For the **quickest decode of a given image**, encode it with enough bands to saturate the target
thread count (more bands = slightly more header overhead per band; measure the size/speed trade).

---

## 3. Verify (must pass after applying the patch)

`sandbox/` is a standalone crate (path-dep to `bliss-core`) that mirrors the app's `bliss_wasm.rs`.
It's the fastest way to prove correctness on the remote build without the full app.

```
cd sandbox
wasm-pack build --target web --out-dir pkg --release
node verify.mjs      # A) 28 lossless roundtrips bit-exact (noise/flat/gradient/sparse × 7 sizes,
                     #    incl. non-16-multiple + tiny → tail & renorm edges)
                     # B) stream magic == BLSR
                     # C) native bliss.exe decode == WASM v128 decode (needs a native bliss build)
```
All three must be **PASS**. This is the correctness oracle — the v128 output is bit-identical to the
scalar decoder on every case.

Native regression check (the shared crate must not regress x86): `cargo test -p bliss-core --release`
→ 14 passed (the AVX2 rANS/recon parity tests).

---

## 4. Benchmark methodology (reproduce the paper numbers)

**SIMD speedup, real content (`sandbox/bench-real.mjs`).** Decodes real Gobabeb ORFs → RGBA →
downscales → BLISS q2 (near-lossless cache tier) → times decode on **two builds of the same crate**:
`pkg` (v128) vs `pkg-scalar` (built with `RUSTFLAGS="" wasm-pack build --out-dir pkg-scalar` → no
simd128 → scalar fallback). Same bytes, byte-identical output asserted, median of N real files.

```
cd sandbox
wasm-pack build --target web --out-dir pkg --release
RUSTFLAGS="" wasm-pack build --target web --out-dir pkg-scalar --release
node bench-real.mjs   # prints: scalar MP/s → v128 MP/s = speedup  [byte-identical: yes]
```
(Corpus path in the script: `c:\Foo\raw-converter\tests\Gobabeb 10`. `_bench-util.mjs` is imported
from the app's `benchmark/` for the ORF decode + downscale — adjust the relative import on the remote.)

**Threads scaling, real content (`sandbox/native-sweep-real.mjs`).** Decodes a full-res ORF, encodes
natively (many bands), sweeps `RAYON_NUM_THREADS` and parses the CLI's internal decode MP/s. Proves
the band-parallel scaling that WASM threads inherit per-band. Needs a native `bliss.exe` release build
(`cargo build --release -p bliss-cli`).

**Timing rigor:** internal MP/s (spawn-free — parsed from the CLI's own decode timer, which wraps
`decode()` only, before the PPM write); warm-up reps; median of many; content-matched before/after.

---

## 5. Proper numbers (measured locally, 2026-07-22)

**v128 SIMD decode — real Gobabeb ORFs, WASM, single-thread (byte-identical to scalar):**
| workload | scalar WASM | v128 WASM | speedup |
|---|--:|--:|--:|
| thumbnail 512px | 25.8 MP/s | 47.7 MP/s | **1.85×** |
| lightbox 1800px | 25.7 MP/s | 49.2 MP/s | **1.92×** |

(The scalar 25.7 MP/s matches the main benchmark's independent 26 MP/s — grounded. Lightbox 2.16 MP:
84 ms → 44 ms from SIMD alone.)

**Band-parallel scaling — real 11.9 MP ORF, 11 bands, native AVX2 (the multiplier WASM threads inherit):**
| threads | 1 | 2 | 4 | 8 |
|---|--:|--:|--:|--:|
| MP/s | 73.7 | 131.5 | 227.8 | 308.0 |
| scaling | 1.0× | 1.78× | 3.09× | **4.18×** |

**Definitive full-stack decode — one grounded run** (`fullstack-bench.mjs`: scalar / v128 / v128+8-thread
all in ONE headless-Chromium harness, identical real-Gobabeb `.bliss`, decode **bit-identical across all
three**, median of 15, `crossOriginIsolated: true`, 2026-07-22). This is the canonical source for the
report's `bliss-decode-accel.json`:

| image | bands | scalar | v128 (SIMD) | v128 × 8 threads | total |
|---|--:|--:|--:|--:|--:|
| thumbnail 0.2 MP | 1 | 23.8 | 45.3 (1.9×) | 52.0 MP/s | 2.2× (1 band → threads barely help) |
| lightbox 2.42 MP | 5 | 25.1 | 45.3 (1.8×) | **176.3 MP/s** | **7.0×** |
| large 8.63 MP | 8 | 25.4 | 46.1 (1.8×) | **190.7 MP/s** | **7.5×** |

**Full stack, lightbox: 25.1 → 45.3 → 176.3 MP/s = 7.0×, i.e. 96 → 53 → 14 ms.** The v128 single-thread
figure (45 MP/s) cross-checks the independent Node runs (cold-open 52 ms, codec-race 45 MP/s, lossless
44 MP/s). This is the "blisteringly fast" browser decode. (`mt-bench.mjs`/`bench-real.mjs`/
`native-sweep-real.mjs` are earlier single-axis benches, superseded by `fullstack-bench.mjs`.)

---

## 6. The "quickest BLISS decode" recipe (summary)

1. **v128 SIMD** decode kernels (this patch) — 1.85–1.92× single-thread, bit-exact. Ships everywhere.
2. **Band-parallel threads** (MT build 2b) — up to ~4× on multi-band images. Ships in the MT tier.
3. **Band count tuned to thread count** at encode (`LT2_BANDS` / `default_bands`) so decode can
   saturate available threads on the target image size.
4. Encoder stays scalar (one-time cache write; 64-bit-mul blocker in WASM). Decode is the hot path.

Native desktop remains fastest overall (AVX2/AVX-512 rANS + AVX2 recon + rayon); the above is the
**browser-quickest** path, closing most of the native gap.

---

## 7. Files in this handoff

- `bliss-core-wasm-simd.patch` — the code (apply to the bliss repo).
- `sandbox/` — standalone verify/bench crate + harnesses:
  `Cargo.toml`, `.cargo/config.toml`, `src/lib.rs`, `verify.mjs`, `bench.mjs`, `bench-real.mjs`,
  `native-sweep-real.mjs`.
- Full analysis: `../bliss-wasm-simd-scope.md` (kernel breakdown, per-phase measured deltas, risks).
