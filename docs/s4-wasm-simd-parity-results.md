# S4-D2 — WASM simd128 Parity Oracle: Results

Generated: 2026-07-07T15:20:22.841Z

Comparison mode: **two-build (pkg-simd +simd128 vs pkg-scalar -simd128)**

| Kernel | Verdict | Diff | Contract | Input |
|--------|---------|------|----------|-------|
| `box_blur` | BYTE-EXACT | elems=49987 bitMismatch=0 maxAbs=0.000e+0 maxRel=0.000e+0 | per-pixel map (v128 V-pass, shared scalar H) | 259x193 r=4 |
| `pixels_to_xyb` | BYTE-EXACT | elems=150000 bitMismatch=0 maxAbs=0.000e+0 maxRel=0.000e+0 | per-pixel LUT map | n=50000 |
| `ssd (psnr)` | BYTE-EXACT | maxAbs=0.000e+0 maxRel=0.000e+0 | integer sum-of-squares | len=262144 |
| `ssim_moments` | BYTE-EXACT | elems=9 bitMismatch=0 maxAbs=0.000e+0 maxRel=0.000e+0 | integer moments (9 sums) | np=65536 |
| `scale_err` | FLOAT-ORDER-OK | maxAbs=1.907e-6 maxRel=2.490e-7 | p=3 norm reduction (lane-parallel f64 drain) | n=20000 |
| `downsample[258x194]` | FLOAT-ORDER-OK | elems=12513 bitMismatch=2547 maxAbs=5.960e-8 maxRel=1.833e-7 | 2x box (add-association) | -> 129x97 |
| `downsample[257x195]` | FLOAT-ORDER-OK | elems=12416 bitMismatch=2458 maxAbs=5.960e-8 maxRel=1.684e-7 | 2x box (add-association) | -> 128x97 |

## Verdict legend
- **BYTE-EXACT**: every output bit-identical between the v128 kernel and the scalar oracle. Expected for the integer kernels (`ssd`, `ssim_moments`) and the pure per-pixel maps (`box_blur`, `pixels_to_xyb`).
- **FLOAT-ORDER-OK**: results differ only by IEEE-754 reassociation, within tolerance (1e-4 abs/rel). This is expected and correct for the reduction / add-association kernels:
  - `scale_err`: the v128 path accumulates four f32 lanes in parallel and drains to f64 periodically, whereas the scalar oracle sums sequentially in f64 — a different (equally valid) summation order for the p=3 norm.
  - `downsample`: the v128 path forms `(a+b)+(c+d)` per 2x2 box; the scalar oracle forms `((a+b)+c)+d`. Pure f32 add-association (matches the in-crate note "maxdiff 5.96e-8").
- **FAIL**: a byte-exact kernel diverged, or a float-order kernel exceeded tolerance — a real regression.

## Coverage
All five perceptual kernels that have a wasm32 v128 (simd128) path are covered:
`box_blur` (mask blur), `pixels_to_xyb`, `ssd` (PSNR), `ssim_moments` (SSIM), `scale_err` (butteraugli),
plus `downsample` (2× box, tested at even and odd dimensions to exercise the clamp tail).
Each is exercised via thin `#[wasm_bindgen]` forwarders (`perc_*_simd` / `perc_*_scalar`) over
`raw_pipeline::perceptual::parity`, added for this oracle. No SIMD implementation was modified.

## Reproduce
```powershell
# from the worktree root
$env:RUSTFLAGS="-C target-feature=+simd128"; wasm-pack build --target web --out-dir pkg-simd   --release
$env:RUSTFLAGS="-C target-feature=-simd128"; wasm-pack build --target web --out-dir pkg-scalar --release
$env:RUSTFLAGS=""
node test-wasm-simd-parity.mjs   # exit 0 = all kernels within contract
```
If only `pkg-simd` is present the harness falls back to a single-build A/B (v128 `*_simd` vs the
same build's scalar `*_scalar` arm); with both builds it performs the full two-build cross-check
(v128 from +simd128 vs true non-autovectorized scalar from -simd128), which is what the table above reflects.

Result: **PASS** (0 violations).
