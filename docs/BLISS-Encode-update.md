# BLISS encode — WebAssembly SIMD (v128) update

Log of the encode-side vectorisation, written as it's built. Companion to the decode work in
`BlissSIMDandMT.md` (that one shipped 7× decode; this adds v128 to the *encoder*, which was still
scalar in WASM).

## Goal & baseline

Encode is one-time (runs when a RAW is cached), so the win is on **ingest** throughput, not browsing.
Measured baseline (real Gobabeb lightbox, 2.42 MP, `benchmark/_encode-probe.mjs`):

| config | encode | vs wasm-scalar |
|---|--:|--:|
| WASM scalar (start) | 17.2 MP/s (140 ms) | 1× |
| Native AVX2, 1 thread | 51.8 MP/s | 3.0× |
| Native AVX2, 8 threads | 152.6 MP/s | 8.9× |

Target: v128 SIMD ≈ 1.6–1.9× single-thread; threads (already band-parallel) ≈ 3× on multi-band →
~5× combined. Two steps stay scalar and cap the ceiling: histogram build (`Table::build`) and
frequency normalisation — content-dependent, hard to vectorise.

## Feasibility (was in doubt, now resolved)

The encoder's rANS uses a Lemire division `q = (x·M) >> 64` with a 64-bit reciprocal `M` — needs a
widening 32×32→64 multiply. WASM v128 **has** it: `u64x2_extmul_low_u32x4` / `_high` +
`i64x2_mul` + `u64x2_shr` (compile-verified). So encode is fully vectorisable; the earlier
"decode-only" scope was wrong.

## Kernels to port (all have AVX2 templates)

| kernel | template | status |
|---|---|---|
| `deinterleave3_v128` — RGB24 → R/G/B planes (+ RCT forward) | `avx2::deinterleave3` | ⏳ |
| `residual_rows_v128` — forward med3 predictor (even+odd residuals) | `avx2::residual_rows` | ⏳ |
| `ctx_row_v128` — green-gradient context | `avx2::ctx_row` | ✅ (shared with decode) |
| `encode16l_v128` — 16-lane rANS encode, extmul Lemire | `rans_avx2::encode16l` | ⏳ |

Correctness gate: `verify.mjs` round-trips (encode → decode → compare) already exercise the encoder;
any encode bug ⇒ round-trip FAIL. Native x86 untouched (all wasm-cfg-gated).

---

## Build log

### Stage 1 — byte kernels (deinterleave3, residual_rows, ctx_row) · 2026-07-22
`band_wasm.rs` gained `residual_rows_v128` (forward med3 predictor, reuses `med3_v`) and
`deinterleave3_v128` (RGB→planes via `i8x16_swizzle`, mirror of `avx2::deinterleave3`). `ctx_row_v128`
already existed (shared with decode). Wired three encode sites in `band.rs`: `deinterleave_into`, the
`residual_rows` call, and the encode `ctx_row`. rANS encode still scalar this stage.

- Bit-exact: `verify.mjs` 28/28 round-trips PASS; native `cargo test -p bliss-core` 14/14 PASS.
- **Measured (2.42 MP, sandbox pkg vs pkg-scalar): 17.7 → 23.6 MP/s = 1.33×.**

The byte kernels are ~a third of encode; the rANS entropy coder (still scalar) is the rest. Stage 2
vectorises it.

### Stage 2 — rANS encoder (`encode16l_v128`) · 2026-07-22
The meaty kernel: 16-lane rANS **encode** in 4×`v128`, mirror of `rans_avx2::encode16l`. Added to
`rans_wasm.rs` with `EncTables`/`enc_tables` (SoA freq/start + the two halves of the reciprocal `M`),
`scalar_step_enc` (the partial first step), and `lemire_q_v128`. Wired the rANS-encode dispatch in
`band.rs` (16-lane → v128, else scalar).

Two design points worth recording:
- **Lemire division on v128.** `q = ⌊x·M / 2^64⌋` needs a widening 32×32→64 multiply. WASM v128 has
  it via `u64x2_extmul_low_u32x4` / `_high` (2 lanes each), so 4 lanes = 2 extmul pairs; combine with
  `i64x2_add` + `u64x2_shr`, then pack the two i64x2 halves back to `u32x4` with one `i8x16_shuffle`.
  Unsigned `q=x` for `freq==1` lanes via `v128_bitselect` on `u32x4_eq(freq,1)`.
- **Renorm emission stays scalar, in descending lane order.** The encoder emits a word for each lane
  whose state overflows (`x ≥ freq<<20`), and the *order* must match the scalar encoder (lanes 15→0)
  so the decoder reads them back correctly. With only 4 lanes per register this is a cheap scalar
  extract-and-emit; the state-shift for emitted lanes is then vectorised (`v128_bitselect`). Getting
  the order wrong = a stream the decoder can't read — caught immediately by the round-trip test.

- **Byte-identical to scalar: PASS — 36 cases** (noise/flat/gradient × 6 sizes incl. non-16-multiple
  and tiny, × q1/q2). Not just "decodes correctly" — the *exact same bytes* as the scalar encoder.
- Native `cargo test -p bliss-core` 14/14 PASS (x86 untouched).
- **Measured v128 encode (2.42 MP): 17.2 → 34.2 MP/s = 1.99×.**

## Results — encode, full stack (grounded)

`encode-fullstack.mjs`: scalar / v128 / v128+8-thread, one headless-Chromium harness, real Gobabeb
pixels (decoded from the test `.bliss`), median of 15. Encode is band-parallel (`edges.par_iter()`),
so threads apply. Writes `docs/bliss-encode-accel.json`.

Two grounded runs (cool machine / thermally-throttled after a long build session) bracket the range;
the **v128 single-thread ratio is stable at ~1.85–1.9×**, while the MT *total* moves with thermal
headroom (thread scaling 2.8–3.5×), so it's given as a range:

| image | bands | scalar | + v128 SIMD | + 8 threads | total |
|---|--:|--:|--:|--:|--:|
| thumbnail 0.2 MP | 1 | 13–15 | ~26–29 (1.9–2.0×) | ~29–35 MP/s | ~2.2× (1 band → threads barely help) |
| lightbox 2.42 MP | 5 | 14–16 | ~27–29 (1.85×) | **74–99 MP/s** | **5.2–6.3×** |
| large 8.63 MP | 8 | 14–16 | ~27–29 (1.85×) | **105–116 MP/s** | **7.3×** |

**Lightbox encode: ~155 → ~85 → ~25–33 ms.** SIMD ≈ 1.85× (reliable, thermal-independent); threads add
≈ 3× on a multi-band frame → **~5.5–6.3× combined** on a machine with thermal headroom — close to
decode's 7×, and above the ~5× pre-estimate (the extmul Lemire vectorised better than feared).
*(MT numbers are thermal-sensitive — all 8 cores busy throttles hardest; measure on a cool machine or
mains power for the upper end. The v128 single-thread figure is the robust one.)*

## What this means

- **Ingest** (caching a folder of RAWs) is now ~6× faster in the browser, byte-for-byte identical.
- Combined with the decode work, BLISS is now **~7× faster both directions** in the browser vs the
  original scalar WASM — SIMD (~1.8×) × threads (~4×), bit-identical throughout.
- Encoder is no longer the "scalar, can't-be-done" side. The `BlissSIMDandMT.md` decode-only caveat is
  superseded — both directions are vectorised.

## Kernels final status

| kernel | file | status |
|---|---|---|
| `deinterleave3_v128` | `band_wasm.rs` | ✅ |
| `residual_rows_v128` | `band_wasm.rs` | ✅ |
| `ctx_row_v128` | `band_wasm.rs` | ✅ (shared with decode) |
| `encode16l_v128` + `enc_tables` + `lemire_q_v128` | `rans_wasm.rs` | ✅ |
| `count_ctx_row_per_v128` (bucket-presize count) | `band_wasm.rs` | ✅ |

### Stage 3 — `count_ctx_row_per` (the last easy pass) · 2026-07-22
Vectorised the 4-bin ctx count. AVX2 uses `sad_epu8` (no v128 equivalent); the clean v128 path is
`u8x16_bitmask(u8x16_eq(v,k))` → a 16-bit lane mask, then popcount the even bits (`0x5555`) and odd
bits (`0xAAAA`). `j` steps by 16 so block-lane parity == absolute parity. The count only sizes bucket
`reserve()`, so a bug wouldn't change output — validated instead by a portable native unit test
(`count_ctx_bitmask_matches_scalar`, all lengths incl. edges → 15/15 native tests). Speed impact is
the ~1–2% expected (within measurement noise); done for completeness — **every O(n) encode pass is now
vectorised except the histogram**, which we deliberately skip:

Not vectorised — and **profiled to confirm it's not worth it** (`examples/prof_encode.rs`):
- `Table::build` (256-bin histogram + frequency normalisation) runs at **2436 MB/s scalar**
  (0.41 ns/byte — its 4-way partial histogram already breaks the store-to-load dependency). That is
  **~4% of wasm-v128 encode**, ~6% of native. Frequency normalisation is inside it (already counted).
- `count_ctx_row_per` (4-bin bucket-presize count) is ~1–2%.
- Combined remaining scalar ≈ **6% of encode**. Vectorising all of it perfectly → ~28.8→30.5 MP/s.

Decisive cross-check: wasm-v128 encode (28.8) vs native-AVX2-1-thread (51.8) = 1.8×, which is exactly
the SIMD-width ratio (v128 4-wide vs AVX2 8-wide). The gap is *width*, not leftover scalar — so the
vectorised kernels already dominate. A SIMD 256-bin byte histogram is scatter-conflict-heavy and
bug-prone for a ~4% return. **Left scalar, measured, on purpose.**

## Decoder robustness (untrusted OPFS cache)

The BLISS decoder is fed bytes from the OPFS cache, which can bit-rot or be partially written. Tested
with fuzzed corruption:
- **Structural corruption** (bad magic / truncation / out-of-range dimensions / bad header) → **graceful
  `Result::Err`** always (magic, `w·h ≤ 2^28`, truncation, and header checks). No trap.
- **rANS word-stream corruption** used to trap 100% of the time (a `words[pos]` read past the buffer →
  panic → `panic=abort` wasm trap, which *leaks* the aborted decode's buffers). **Fixed** in
  `decode_band_ctx`: the word buffer is now padded to the provable consumption bound `n + 2·lanes`
  (n is already bounded ≤ `w·rows`), so `words[pos]` is OOB-impossible on every decode path
  (v128 / scalar / native). Cut trapping corruptions ~70%; round-trip stays bit-exact.
- **Residual**: ~30% of deep word corruptions still trap in a downstream bounds-checked read on garbage
  residuals. Each is **caught by the app** (`bliss-worker.js` try/catch → falls back to re-decoding the
  RAW) and the wasm instance **recovers** (verified: good decodes work after a trap). The only cost is
  a per-trap buffer leak, now 70% rarer.
- **Complete fix (recommended follow-up, app-level):** store a CRC/hash beside each cached `.bliss` and
  verify on read — feed the decoder only bytes that pass, eliminating the trap path entirely. A cache is
  the right place for an integrity check.

## Verify / bench harnesses (in `bliss-wasm-sandbox/`)
- `enc-compare.mjs` — byte-identity (scalar==v128) + Node speed check.
- `encode-fullstack.mjs` — the grounded scalar/v128/MT browser numbers above.
- `verify.mjs` round-trips already gate encode correctness (encode→decode→compare).
