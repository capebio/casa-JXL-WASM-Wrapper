# BLISS browser decode — SIMD + Multithreading implementation guide

**Audience:** whoever implements this on another build/machine (the "remote build").
**Goal:** make BLISS decode in the browser go **7× faster** — hand-written WebAssembly SIMD (`v128`)
plus band-parallel threads — with **bit-identical output** at every step.

This is a complete, self-contained recipe. Follow it top to bottom. Every code block is the exact
final source; every command is the exact command that produced the measured numbers below.

---

## 0. Results this delivers (measured, real Gobabeb, one grounded run)

Decode of one `.bliss` cache image, headless Chromium, median of 15, **bit-identical across all three configs**:

| image | bands | scalar | + v128 SIMD | + 8 threads | total |
|---|--:|--:|--:|--:|--:|
| thumbnail 0.2 MP | 1 | 23.8 | 45.3 MP/s (1.9×) | 52.0 MP/s | 2.2× (1 band → threads can't help) |
| lightbox 2.42 MP | 5 | 25.1 | 45.3 MP/s (1.8×) | **176.3 MP/s** | **7.0×** |
| large 8.63 MP | 8 | 25.4 | 46.1 MP/s (1.8×) | **190.7 MP/s** | **7.5×** |

Lightbox in wall-clock: **96 ms → 53 ms → 14 ms.** SIMD ≈ 1.8× everywhere; threads add ≈ 3.9× on a
multi-band frame (near the native 4.2× ceiling). This guide covers **decode**; the **encoder is also
vectorised** (~1.8× SIMD, ~6× with threads, byte-identical) — see the companion `BLISS-Encode-update.md`.
(An earlier draft of this doc claimed encode was impossible in WASM SIMD; that was wrong — v128 has the
widening multiply via `u64x2_extmul_*`.)

---

## 1. How it works (so you can debug it)

`bliss_core::decode` → per band `decode_band_ctx` does two things, both scalar in a stock WASM build:

1. **rANS entropy decode** (16 interleaved lanes, 32-bit states, 12-bit probabilities).
2. **Predictor-inverse reconstruction** — rebuild pixels from residuals: a green-gradient *context*
   row, a *checkerboard-median* recon (even phase then odd phase), and a planar→RGB *interleave*
   with fused reversible-colour-transform (RCT) inverse.

Native x86 already has AVX2 kernels for all of this (`rans_avx2.rs`, `avx2.rs`), gated
`#[cfg(target_arch = "x86_64")]`. **This guide adds the `wasm32` `v128` siblings** — same algorithms,
16 lanes = 4×`v128` for rANS, 16 bytes/iteration for the byte kernels. Then it turns on the
**already-existing band parallelism** (`lib.rs` decode uses rayon `par_iter` over bands behind the
`parallel` feature) via a WASM thread pool.

Two WASM-SIMD limits shaped the design — know them before you touch the code:
- **No gather.** `plut[c]` (the packed LUT lookup) is emulated: extract lane → scalar L1 load →
  rebuild the vector. The LUT is 4096×u32 = 16 KB, L1-resident, so it's still a net win.
- The decoder's state update `freq*(x>>12)` fits u32 exactly (`i32x4_mul` low 32). The *encoder's*
  Lemire division needs a widening 32×32→64 multiply — which v128 also has (`u64x2_extmul_low/high_u32x4`),
  so the encoder is vectorised too (companion doc `BLISS-Encode-update.md`).

---

## 2. Prerequisites (remote build)

| tool | why | note |
|---|---|---|
| Rust stable + `wasm32-unknown-unknown` target | SIMD build | `rustup target add wasm32-unknown-unknown` |
| Rust **nightly** + `rust-src` | MT build needs `-Z build-std` | `rustup toolchain install nightly && rustup component add rust-src --toolchain nightly` |
| `wasm-pack` | SIMD build | any recent version |
| `wasm-bindgen` CLI | MT build (manual bindgen) | **version MUST equal the `wasm-bindgen` crate version** (here `0.2.121`); install with `cargo install wasm-bindgen-cli --version <X>` on Windows use the MSVC toolchain — GNU host lacks `dlltool` |
| `clang`/`lld` | native tests (optional) | for `cargo test -p bliss-core` cross-check |
| Playwright + Chromium | MT measurement only | `npm i -D playwright && npx playwright install chromium` |

Notes: WASM SIMD (`simd128`) is **baseline in all current browsers** (2021+) — no runtime feature
detection needed. On Windows, a **nightly-GNU** toolchain builds the `wasm32` target fine (the
missing `dlltool` only blocks *native* GNU linking, not WASM cross-compiles).

---

## PART A — SIMD (v128). Ships to every tier.

All changes are in the **`bliss-core` crate** (the codec crate the app path-deps). Native x86 paths
are untouched — every addition is `#[cfg(target_arch = "wasm32", ...)]`-gated.

> Fast path: apply `docs/bliss-wasm-simd-handoff/bliss-core-wasm-simd.patch` with `git apply` and skip
> to A.5. The full source is inlined below so this doc stands alone.

### A.1 New file — `bliss-core/src/rans_wasm.rs`

```rust
//! WASM `v128` (128-bit SIMD) rANS decode — the browser sibling of `rans_avx2`.
//! 16-lane stream, 4×`v128` (4 u32 lanes each), bit-identical to the scalar decoder in `rans.rs`
//! (asserted by roundtrip tests). Same packed LUT [sym:8 | freq-1:12 | start:12] per 12-bit slot.
//!
//! WASM SIMD has no gather → `plut[c]` is emulated per lane (extract → scalar L1 load → build).
//! Renorm reads are sequential/lane-ascending (must match `rans::decode_lanes` word order exactly),
//! so they run as a scalar per-lane pass over the ≤16 active lanes — simple and provably correct.
//! Decode needs only 32-bit math (`i32x4_mul` low 32 = exact here); no 64-bit mul, so no encoder.
#![allow(unsafe_op_in_unsafe_fn)]
use crate::rans::{Table, PROB_BITS};
use core::arch::wasm32::*;

const RANS_L: u32 = 1 << 16;

/// Packed LUT: one u32 per 12-bit slot = [sym:8 | (freq-1):12 | start:12]. Same layout as
/// `rans_avx2::packed_lut` (that one is x86-gated; this is the wasm-visible copy).
pub fn packed_lut(t: &Table) -> Vec<u32> {
    let mut lut = vec![0u32; 1 << PROB_BITS];
    for s in 0..256 {
        let f = t.freq[s] as u32;
        if f == 0 {
            continue;
        }
        let v = ((s as u32) << 24) | ((f - 1) << 12) | t.start[s];
        for slot in t.start[s]..t.start[s + 1] {
            lut[slot as usize] = v;
        }
    }
    lut
}

/// Decode `n` symbols from a 16-lane stream. `words` must have >= 16 u16 of readable padding at the
/// end (renorm look-ahead). Bit-identical to `rans::decode_lanes(words, n, t, lut, 16)`.
#[target_feature(enable = "simd128")]
pub unsafe fn decode16l_v128(words: &[u16], n: usize, plut: &[u32], out: &mut [u8]) {
    let mut pos = 0usize;
    let mut x = [0u32; 16];
    for lane in &mut x {
        *lane = ((words[pos] as u32) << 16) | words[pos + 1] as u32;
        pos += 2;
    }
    let full_steps = n / 16;
    let mut xr = [
        v128_load(x.as_ptr() as *const v128),
        v128_load(x.as_ptr().add(4) as *const v128),
        v128_load(x.as_ptr().add(8) as *const v128),
        v128_load(x.as_ptr().add(12) as *const v128),
    ];
    let mask12 = u32x4_splat(0xFFF);
    let one = u32x4_splat(1);
    let plutp = plut.as_ptr();
    let outp = out.as_mut_ptr();

    for step in 0..full_steps {
        for r in 0..4 {
            let xv = xr[r];
            let c = v128_and(xv, mask12);
            // emulate gather plut[c] for the 4 lanes (LUT is 16 KB, L1-resident)
            let c0 = u32x4_extract_lane::<0>(c) as usize;
            let c1 = u32x4_extract_lane::<1>(c) as usize;
            let c2 = u32x4_extract_lane::<2>(c) as usize;
            let c3 = u32x4_extract_lane::<3>(c) as usize;
            let lv = u32x4(
                *plutp.add(c0),
                *plutp.add(c1),
                *plutp.add(c2),
                *plutp.add(c3),
            );
            // symbols = lv >> 24, one byte per lane
            let base = step * 16 + r * 4;
            *outp.add(base) = (u32x4_extract_lane::<0>(lv) >> 24) as u8;
            *outp.add(base + 1) = (u32x4_extract_lane::<1>(lv) >> 24) as u8;
            *outp.add(base + 2) = (u32x4_extract_lane::<2>(lv) >> 24) as u8;
            *outp.add(base + 3) = (u32x4_extract_lane::<3>(lv) >> 24) as u8;
            // x = freq*(x>>12) + c - start ; freq = ((lv>>12)&0xFFF)+1 ; start = lv&0xFFF
            let freq = u32x4_add(v128_and(u32x4_shr(lv, 12), mask12), one);
            let start = v128_and(lv, mask12);
            let xq = u32x4_shr(xv, PROB_BITS);
            xr[r] = u32x4_sub(u32x4_add(i32x4_mul(freq, xq), c), start);
        }
        // renorm: lane-ascending (matches scalar word order). Register-resident — extract/merge/
        // replace only the lanes that fire, no per-step memory round-trip. Skip regs with no active
        // lane via the i32x4 need-mask (bitmask).
        macro_rules! renorm_reg {
            ($r:expr) => {{
                let xv = xr[$r];
                // need = (x >> 16) == 0  (unsigned x < 2^16)
                let need = u32x4_eq(u32x4_shr(xv, 16), u32x4_splat(0));
                if u32x4_bitmask(need) != 0 {
                    let mut l0 = u32x4_extract_lane::<0>(xv);
                    let mut l1 = u32x4_extract_lane::<1>(xv);
                    let mut l2 = u32x4_extract_lane::<2>(xv);
                    let mut l3 = u32x4_extract_lane::<3>(xv);
                    if l0 < RANS_L { l0 = (l0 << 16) | words[pos] as u32; pos += 1; }
                    if l1 < RANS_L { l1 = (l1 << 16) | words[pos] as u32; pos += 1; }
                    if l2 < RANS_L { l2 = (l2 << 16) | words[pos] as u32; pos += 1; }
                    if l3 < RANS_L { l3 = (l3 << 16) | words[pos] as u32; pos += 1; }
                    xr[$r] = u32x4(l0, l1, l2, l3);
                }
            }};
        }
        renorm_reg!(0);
        renorm_reg!(1);
        renorm_reg!(2);
        renorm_reg!(3);
    }

    // recover scalar state for the tail
    v128_store(x.as_mut_ptr() as *mut v128, xr[0]);
    v128_store(x.as_mut_ptr().add(4) as *mut v128, xr[1]);
    v128_store(x.as_mut_ptr().add(8) as *mut v128, xr[2]);
    v128_store(x.as_mut_ptr().add(12) as *mut v128, xr[3]);
    for idx in full_steps * 16..n {
        let j = idx % 16;
        let c = x[j] & ((1 << PROB_BITS) - 1);
        let v = plut[c as usize];
        out[idx] = (v >> 24) as u8;
        let f = ((v >> 12) & 0xFFF) + 1;
        let st = v & 0xFFF;
        x[j] = f * (x[j] >> PROB_BITS) + c - st;
        if x[j] < RANS_L {
            x[j] = (x[j] << 16) | words[pos] as u32;
            pos += 1;
        }
    }
}
```

### A.2 New file — `bliss-core/src/band_wasm.rs`

```rust
//! WASM `v128` reconstruction kernels — the browser sibling of `avx2.rs` (decode side only).
//! 16 bytes/iteration; bit-identical to the scalar recon in `band.rs` (edges scalar, interior SIMD).
//! Covers the near-lossless cache-tier decode path: `ctx_row` + checkerboard-median recon + RCT
//! interleave. No serial bias loop on that path, so these are the whole remaining scalar cost.
#![allow(unsafe_op_in_unsafe_fn)]
use core::arch::wasm32::*;

#[inline]
fn med3s(a: u8, b: u8, c: u8) -> u8 {
    a.min(b).max(a.max(b).min(c))
}
#[inline]
fn med3_v(a: v128, b: v128, c: v128) -> v128 {
    let mn = u8x16_min(a, b);
    let mx = u8x16_max(a, b);
    u8x16_max(mn, u8x16_min(mx, c))
}

/// out[j] = med3(prev[j], prev[j-1], prev[j+1]) + res[j]  (whole row; caller uses even j).
#[target_feature(enable = "simd128")]
pub unsafe fn recon_even_row_v128(prev: &[u8], res: &[u8], out: &mut [u8]) {
    let w = prev.len();
    out[0] = med3s(prev[0], prev[0], prev[1.min(w - 1)]).wrapping_add(res[0]);
    out[w - 1] = med3s(prev[w - 1], prev[w - 2], prev[w - 1]).wrapping_add(res[w - 1]);
    let mut j = 1usize;
    while j + 16 <= w - 1 {
        let p = v128_load(prev.as_ptr().add(j) as *const v128);
        let pl = v128_load(prev.as_ptr().add(j - 1) as *const v128);
        let pr = v128_load(prev.as_ptr().add(j + 1) as *const v128);
        let r = v128_load(res.as_ptr().add(j) as *const v128);
        v128_store(out.as_mut_ptr().add(j) as *mut v128, i8x16_add(med3_v(p, pl, pr), r));
        j += 16;
    }
    while j < w - 1 {
        out[j] = med3s(prev[j], prev[j - 1], prev[j + 1]).wrapping_add(res[j]);
        j += 1;
    }
}

/// In-place odd phase: curr[j] = med3(curr[j-1], curr[j+1], prev[j]) + res[j] for odd j.
/// curr already holds reconstructed even columns; the vector computes all lanes and blends only the
/// odd-absolute ones (vector-even lanes, since the loop starts at j=1).
#[target_feature(enable = "simd128")]
pub unsafe fn recon_odd_row_inplace_v128(curr: &mut [u8], prev: &[u8], res: &[u8]) {
    let w = curr.len();
    // mask bytes [0xFF,0x00,0xFF,0x00,…] → bitselect picks new_vals at vector-even lanes (odd abs pos)
    let mask = u16x8_splat(0x00FF);
    let mut j = 1usize;
    while j + 16 <= w - 1 {
        let existing = v128_load(curr.as_ptr().add(j) as *const v128);
        let cl = v128_load(curr.as_ptr().add(j - 1) as *const v128);
        let cr = v128_load(curr.as_ptr().add(j + 1) as *const v128);
        let p = v128_load(prev.as_ptr().add(j) as *const v128);
        let r = v128_load(res.as_ptr().add(j) as *const v128);
        let new_vals = i8x16_add(med3_v(cl, cr, p), r);
        v128_store(curr.as_mut_ptr().add(j) as *mut v128, v128_bitselect(new_vals, existing, mask));
        j += 16;
    }
    while j < w - 1 {
        curr[j] = med3s(curr[j - 1], curr[j + 1], prev[j]).wrapping_add(res[j]);
        j += 2;
    }
    if w >= 2 && (w - 1) & 1 == 1 {
        curr[w - 1] = med3s(curr[w - 2], curr[w - 2], prev[w - 1]).wrapping_add(res[w - 1]);
    }
}

/// ctx[j] = classify(|g[j]-g[j-1]| +sat |g[j]-g[j+1]|), bins at [1,4,16).
#[target_feature(enable = "simd128")]
pub unsafe fn ctx_row_v128(g: &[u8], out: &mut [u8]) {
    let w = g.len();
    let ad = |a: u8, b: u8| a.max(b) - a.min(b);
    let cls = |s: u8| (s >= 1) as u8 + (s >= 4) as u8 + (s >= 16) as u8;
    out[0] = cls(ad(g[0], g[1.min(w - 1)]));
    out[w - 1] = cls(ad(g[w - 1], g[w - 2]));
    let one = u8x16_splat(1);
    let (t1, t4, t16) = (u8x16_splat(1), u8x16_splat(4), u8x16_splat(16));
    let mut j = 1usize;
    while j + 16 <= w - 1 {
        let x = v128_load(g.as_ptr().add(j) as *const v128);
        let xl = v128_load(g.as_ptr().add(j - 1) as *const v128);
        let xr = v128_load(g.as_ptr().add(j + 1) as *const v128);
        let d1 = i8x16_sub(u8x16_max(x, xl), u8x16_min(x, xl)); // exact |diff| (max>=min)
        let d2 = i8x16_sub(u8x16_max(x, xr), u8x16_min(x, xr));
        let s = u8x16_add_sat(d1, d2); // unsigned saturating
        // unsigned s >= t  <=>  max(s,t) == s
        let ge1 = u8x16_eq(u8x16_max(s, t1), s);
        let ge4 = u8x16_eq(u8x16_max(s, t4), s);
        let ge16 = u8x16_eq(u8x16_max(s, t16), s);
        let c = i8x16_add(
            i8x16_add(v128_and(ge1, one), v128_and(ge4, one)),
            v128_and(ge16, one),
        );
        v128_store(out.as_mut_ptr().add(j) as *mut v128, c);
        j += 16;
    }
    while j < w - 1 {
        let s = ad(g[j], g[j - 1]).saturating_add(ad(g[j], g[j + 1]));
        out[j] = cls(s);
        j += 1;
    }
}

/// Planar → RGB24 with fused RCT inverse (add G back to R,B when rct). 16 px / iteration via swizzle.
#[target_feature(enable = "simd128")]
pub unsafe fn interleave3_v128(r: &[u8], g: &[u8], b: &[u8], rgb: &mut [u8], rct: bool) {
    let n = r.len();
    const X: u8 = 0xFF; // swizzle: index >= 16 → 0
    let ra = u8x16(0, X, X, 1, X, X, 2, X, X, 3, X, X, 4, X, X, 5);
    let ga = u8x16(X, 0, X, X, 1, X, X, 2, X, X, 3, X, X, 4, X, X);
    let ba = u8x16(X, X, 0, X, X, 1, X, X, 2, X, X, 3, X, X, 4, X);
    let rb = u8x16(X, X, 6, X, X, 7, X, X, 8, X, X, 9, X, X, 10, X);
    let gb = u8x16(5, X, X, 6, X, X, 7, X, X, 8, X, X, 9, X, X, 10);
    let bb = u8x16(X, 5, X, X, 6, X, X, 7, X, X, 8, X, X, 9, X, X);
    let rc = u8x16(X, 11, X, X, 12, X, X, 13, X, X, 14, X, X, 15, X, X);
    let gc = u8x16(X, X, 11, X, X, 12, X, X, 13, X, X, 14, X, X, 15, X);
    let bc = u8x16(10, X, X, 11, X, X, 12, X, X, 13, X, X, 14, X, X, 15);
    let mut i = 0usize;
    while i + 16 <= n {
        let mut rv = v128_load(r.as_ptr().add(i) as *const v128);
        let gv = v128_load(g.as_ptr().add(i) as *const v128);
        let mut bv = v128_load(b.as_ptr().add(i) as *const v128);
        if rct {
            rv = i8x16_add(rv, gv);
            bv = i8x16_add(bv, gv);
        }
        let a = v128_or(v128_or(i8x16_swizzle(rv, ra), i8x16_swizzle(gv, ga)), i8x16_swizzle(bv, ba));
        let bo = v128_or(v128_or(i8x16_swizzle(rv, rb), i8x16_swizzle(gv, gb)), i8x16_swizzle(bv, bb));
        let co = v128_or(v128_or(i8x16_swizzle(rv, rc), i8x16_swizzle(gv, gc)), i8x16_swizzle(bv, bc));
        v128_store(rgb.as_mut_ptr().add(i * 3) as *mut v128, a);
        v128_store(rgb.as_mut_ptr().add(i * 3 + 16) as *mut v128, bo);
        v128_store(rgb.as_mut_ptr().add(i * 3 + 32) as *mut v128, co);
        i += 16;
    }
    while i < n {
        let gi = g[i];
        rgb[i * 3] = if rct { r[i].wrapping_add(gi) } else { r[i] };
        rgb[i * 3 + 1] = gi;
        rgb[i * 3 + 2] = if rct { b[i].wrapping_add(gi) } else { b[i] };
        i += 1;
    }
}
```

### A.3 `bliss-core/src/lib.rs` — declare the modules

Immediately after `#[cfg(target_arch = "x86_64")] pub mod rans_avx2;` add:

```rust
#[cfg(target_arch = "wasm32")]
pub mod rans_wasm;
#[cfg(target_arch = "wasm32")]
pub(crate) mod band_wasm;
```

### A.4 `bliss-core/src/band.rs` — five wiring edits (decode side only)

**(a)** Add this helper just above `pub(crate) fn decode_band_ctx(...)`:

```rust
/// Non-x86 rANS stream decode. On wasm32 with simd128 the 16-lane stream uses the `v128` kernel;
/// everything else (other lane counts, non-simd targets) falls to the scalar decoder.
#[cfg(not(target_arch = "x86_64"))]
fn decode_stream_fallback(words: &[u16], nw: usize, n: usize, t: &Table, lanes: usize) -> Vec<u8> {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        if lanes == 16 {
            let plut = crate::rans_wasm::packed_lut(t);
            let mut out = vec![0u8; n];
            unsafe { crate::rans_wasm::decode16l_v128(words, n, &plut, &mut out) };
            return out;
        }
    }
    let lut = t.lut();
    rans::decode_lanes(&words[..nw], n, t, &lut, lanes)
}
```

**(b)** In `decode_band_ctx`, the `#[cfg(not(target_arch = "x86_64"))]` stream-decode arm — replace
the scalar body with the helper:

```rust
                #[cfg(not(target_arch = "x86_64"))]
                {
                    streams.push(decode_stream_fallback(&words, nw, n, &t, lanes));
                }
```

**(c)** The `ctx_row` site (inside the `else` that isn't `ctx2`) — add the wasm arm and narrow the
scalar fallback so it doesn't fire on wasm+simd128:

```rust
                #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
                unsafe { crate::band_wasm::ctx_row_v128(g, &mut crow) };
                #[cfg(all(not(target_arch = "x86_64"), not(all(target_arch = "wasm32", target_feature = "simd128"))))]
                ctx_row_planar(g, &mut crow);
```
(keep the existing `#[cfg(target_arch = "x86_64")] if use_avx2() { avx2::ctx_row } else { ctx_row_planar }`.)

**(d)** The checkerboard-recon site — add a wasm arm, and wrap the existing x86/scalar `if fast {…}`
block so it's compiled only when NOT wasm+simd128:

```rust
            // wasm32+simd128: v128 checkerboard-median recon (even phase writes all w; odd blends
            // in-place — same contract as the AVX2 pair).
            #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
            unsafe {
                crate::band_wasm::recon_even_row_v128(prev, &res, curr);
                crate::band_wasm::recon_odd_row_inplace_v128(curr, prev, &res);
            }
            #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
            {
                // ... the ORIGINAL `let fast = use_avx2(); if fast { avx2::recon_* } else { med_row_* }` block ...
            }
```

**(e)** The final `interleave3` site (before the scalar RGB interleave loop that writes `dst`) — add:

```rust
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        unsafe { crate::band_wasm::interleave3_v128(&planes[0], &planes[1], &planes[2], dst, rct) };
        return Ok(());
    }
    #[allow(unreachable_code)]
    for i in 0..w * rows { /* ... existing scalar interleave ... */ }
```

> The `#[allow(unreachable_code)]` is needed because the x86 arm above may early-`return`.

### A.5 Build the SIMD pkg + confirm native is untouched

The app's WASM build must enable `simd128`. Put this in the crate's `.cargo/config.toml` (or pass via
`RUSTFLAGS`):
```toml
[target.wasm32-unknown-unknown]
rustflags = ["-C", "target-feature=+simd128"]
```
Then the normal app build picks up the kernels:
```
wasm-pack build --target web --out-dir pkg --release
```
Native must still pass (all wasm arms are cfg-gated — 14 tests, includes the AVX2 parity tests):
```
cargo test -p bliss-core --release      # expect: all pass
```

---

## PART B — Multithreading. Ships only in the COOP/COEP MT tier.

Decode is **already band-parallel**: `bliss_core::decode` does `metas.par_iter()` under
`#[cfg(feature = "parallel")]`. You only need to (1) enable that feature in the WASM build,
(2) provide a WASM thread pool, (3) build with the threaded ABI, (4) init the pool from JS.
**No bliss-core code change** — this is all build + integration.

### B.1 Enable the feature + export the pool initialiser

In the **wasm crate** that wraps `bliss_core` (the one with `#[wasm_bindgen] pub fn bliss_decode`):

`Cargo.toml`:
```toml
[dependencies]
wasm-bindgen = "=0.2.121"                                  # MUST equal the wasm-bindgen CLI version
bliss-core = { path = "...", default-features = false }    # add "parallel" via the feature below
wasm-bindgen-rayon = { version = "1", optional = true }

[features]
parallel = ["dep:wasm-bindgen-rayon", "bliss-core/parallel"]
```

`src/lib.rs`:
```rust
// MT tier: re-export the rayon web-worker pool initialiser. JS calls initThreadPool(N) before decode.
#[cfg(feature = "parallel")]
pub use wasm_bindgen_rayon::init_thread_pool;
```

### B.2 Build the threaded pkg (`-Z build-std`, shared memory)

`wasm-pack` cannot pass `-Z`, so build with nightly cargo then run `wasm-bindgen` manually. Every flag
below is load-bearing. **`RUSTFLAGS` replaces `.cargo/config` rustflags, so re-add `+simd128` here:**

```bash
MAXMEM=$((2048*1024*1024))   # 2 GiB shared-memory ceiling
RUSTFLAGS="-C target-feature=+simd128,+atomics,+bulk-memory,+mutable-globals \
 -C link-arg=--shared-memory -C link-arg=--max-memory=$MAXMEM -C link-arg=--import-memory \
 -C link-arg=--export=__heap_base -C link-arg=--export=__tls_base -C link-arg=--export=__tls_size \
 -C link-arg=--export=__tls_align -C link-arg=--export=__wasm_init_tls" \
 cargo +nightly build --target wasm32-unknown-unknown --release \
   -Z build-std=panic_abort,std --features parallel --lib

wasm-bindgen target/wasm32-unknown-unknown/release/<crate_name>.wasm --out-dir pkg-mt --target web
```
Why each flag: `+atomics,+bulk-memory,+mutable-globals` = threads ABI; `--shared-memory
--max-memory` = a `SharedArrayBuffer` heap workers share (atomics alone gives *non-shared* memory);
`--import-memory` = wasm-bindgen's thread transform asserts the memory is imported (the main thread
creates the shared `Memory` and hands it to workers); the `__tls_*`/`__heap_base` exports = the
release profile strips the name section, so export them explicitly; `-Z build-std` = std must be
rebuilt with atomics. Output `pkg-mt/` contains `snippets/wasm-bindgen-rayon-*/workerHelpers.js` and
exports both `bliss_decode` and `initThreadPool`.

### B.3 JS/serving integration

1. **Serve with cross-origin isolation** (required for `SharedArrayBuffer`):
   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```
   (The app already sets these for the libjxl MT tier — reuse them.)
2. **Init the pool once, before decoding:**
   ```js
   import initBliss, { bliss_decode, initThreadPool } from '/pkg-mt/<crate>.js';
   await initBliss();
   if (!self.crossOriginIsolated) throw new Error('need COOP/COEP for SharedArrayBuffer');
   await initThreadPool(navigator.hardwareConcurrency);   // once per page/worker context
   // ... bliss_decode(bytes) now runs band-parallel ...
   ```
3. **Worker-helper import quirk:** wasm-bindgen-rayon's `workerHelpers.js` does `import('../../..')`,
   which resolves to the *pkg directory URL* (e.g. `/pkg-mt/`). Your static server must map a bare
   `/pkg-mt` or `/pkg-mt/` request to `/pkg-mt/<crate>.js`. (See `fullstack-bench.mjs` for a 3-line
   example.)

### B.4 Band count = the thread ceiling (a tuning knob)

Decode parallelism ≤ number of bands, and **bands are baked at encode time**:
`default_bands = (height / 256).clamp(1, cap)` (`cap` = thread count when encoding with `parallel`,
else 8; override with env `LT2_BANDS`, 1..64). Consequences:
- thumbnail (h≈384) → **1 band → threads do nothing** (already ~4 ms, fine).
- lightbox (h≈1344) → 5 bands → ~4× available.
- full 20 MP preview (h≈3600) → ~14 bands → strong scaling.

For the quickest decode of a target image, encode it with enough bands to saturate the thread count
(more bands = slightly more per-band header overhead; measure the size/speed trade).

---

## 3. Verify + benchmark (do not skip)

Copies of these harnesses are in `docs/bliss-wasm-simd-handoff/sandbox/`. They assume a small
standalone crate that wraps `bliss_core` and exports `bliss_encode`/`bliss_decode` (+ `initThreadPool`
for MT) — the same shape as the app's `bliss_wasm.rs`.

- **`verify.mjs` — correctness gate. MUST pass before shipping.** 28 lossless round-trips
  (noise/flat/gradient/sparse-rares × 7 sizes incl. non-16-multiple + tiny → exercises the rANS tail
  and every renorm edge), bit-exact; stream magic == `BLSR`; and a native `bliss` CLI decodes the
  same bytes bit-identically. Any FAIL = a real bug (rANS is unforgiving — one wrong renorm ⇒ garbage).
- **`fullstack-bench.mjs` — the grounded numbers.** Loads three builds (`pkg-scalar` = no simd;
  `pkg` = v128; `pkg-mt` = v128+threads) in one headless-Chromium harness, decodes identical real
  `.bliss`, checks output bit-identical across all three, reports scalar/v128/MT MP/s + speedups, and
  writes the report's `bliss-decode-accel.json`. This is the canonical source for any published number.
  (`gen-mt-data.mjs` pre-encodes the real `.bliss` test files it fetches.)

Build all three for the bench:
```
wasm-pack build --target web --out-dir pkg --release                       # v128 (SIMD)
RUSTFLAGS="" wasm-pack build --target web --out-dir pkg-scalar --release    # scalar (RUSTFLAGS="" drops simd128)
# pkg-mt via the Part B recipe
```

---

## 4. Gotchas (every one of these bit us — read before building)

1. **Stream magic skew.** An old shipped WASM pkg may emit magic `LT2R` (pre-rename); current
   `bliss-core` uses `BLSR`. They are incompatible: native tools can't read `LT2R` WASM bytes, and a
   stale pkg won't have the v128 kernels. **Rebuild the pkg** — that both ships the kernels and fixes
   the magic. Verify: first 4 bytes of any `.bliss` == `BLSR`.
2. **wasm-bindgen CLI must equal the crate version.** Mismatch = cryptic bindgen errors. Pin the
   crate (`wasm-bindgen = "=0.2.121"`) and install the exact CLI. On Windows install the CLI under the
   **MSVC** toolchain (GNU host lacks `dlltool`).
3. **`RUSTFLAGS` env replaces `.cargo/config` rustflags** — it does not merge. The MT `RUSTFLAGS`
   MUST re-include `+simd128` or you lose the SIMD kernels in the threaded build.
4. **No `v128` gather** — emulated per lane (fine; the LUT is L1-resident). Note WASM v128 *does*
   have the widening 32×32→64 multiply (`u64x2_extmul_*`), so the **encoder is vectorised too** — see
   `BLISS-Encode-update.md` (this decode guide predates the encode work).
5. **Only the 16-lane stream gets v128.** `decode_stream_fallback` routes `lanes == 16` to the
   kernel; any other lane count falls to scalar. Current encoder emits 16-lane (`V2_LANES`).
6. **Word padding.** `decode16l_v128` reads up to 16 u16 past `nw` for renorm look-ahead;
   `decode_band_ctx` already appends 16 zero words — keep that.
7. **nightly-GNU builds wasm fine** on Windows; the `dlltool` breakage is native-GNU-only.
8. **`--import-memory` means there is no memory *section*** in the wasm (it's an *import*). A "find
   the shared memory section" check will print nothing — that's correct, not a failure.
9. **Node can't easily run the wasm-bindgen-rayon pool.** Measure MT in **headless Chromium**
   (Playwright) with COOP/COEP. If your bench script lives outside the app dir, symlink/junction its
   `node_modules` to the app's so `playwright` resolves.
10. **PPM parsing** (if you use the native `bliss` CLI as an oracle): P6 has **four** whitespace-
    separated tokens (`P6 w h maxval`) then one whitespace, then binary. Skipping three trips you up.
11. **Fair comparison.** The single-thread cold-open figure compares codecs at 1 thread; the
    threaded number is a *separate* measurement. Don't put an 8-thread BLISS bar next to 1-thread
    peers. `fullstack-bench.mjs` keeps them straight.

---

## 5. Definition of done (checklist)

- [ ] `rans_wasm.rs` + `band_wasm.rs` added; `lib.rs` declares both (wasm32-gated).
- [ ] `band.rs` five wiring edits applied; decode-only; native paths unchanged.
- [ ] `cargo test -p bliss-core --release` → all pass (native untouched).
- [ ] `.cargo/config.toml` has `+simd128`; `wasm-pack build` produces `pkg/`.
- [ ] `verify.mjs` → 28/28 bit-exact, magic `BLSR`, native cross-parity PASS.
- [ ] app wasm crate: `parallel` feature + `wasm-bindgen-rayon` + `pub use init_thread_pool`.
- [ ] MT build recipe (nightly, `-Z build-std`, the exact `RUSTFLAGS`) produces `pkg-mt/` with
      `initThreadPool` exported and `snippets/`.
- [ ] serving sets COOP/COEP; JS calls `initThreadPool(hardwareConcurrency)` before decode.
- [ ] `fullstack-bench.mjs` → scalar/v128/MT bit-identical, ≈1.8× SIMD and ≈7× total on a multi-band
      frame. Numbers within noise of §0.

Reference bundle (exact code + harnesses + patch): `docs/bliss-wasm-simd-handoff/`.
