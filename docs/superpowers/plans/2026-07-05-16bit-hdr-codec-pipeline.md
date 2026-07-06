# 16-bit / HDR Codec Pipeline Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the static "16-bit/HDR" capability-matrix row of the codec-paper suite into a real 16-bit rate-distortion path (RAW-derived RGBA16 → JXL/AVIF/PNG-16 → 16-bit metrics → new RD figures).

**Architecture:** Five phases matching the design's layers. L1 wasm-exports the *existing* `pipeline::process_16bit` display render (Rust/wasm-pack rebuild). L3/L4 add RGBA16 adapters + pure-JS PSNR-16/SSIM-16 metrics — this alone produces a real figure. L2 adds a 16-bit Butteraugli C++ bridge (Emscripten rebuild) as an **additive** perceptual metric. L5 wires new `sweep16` arrays + `rd-*-16bit.svg` figures + a gallery section into `CodecPaperFullTest.mjs`. L6 documents the true-HDR follow-up.

**Tech Stack:** Rust (raw-pipeline crate + `#[wasm_bindgen]`), wasm-pack (`build-parallel-wasm.ps1`), C++/Emscripten (libjxl-012 fork bridge), Node ESM (`.mjs`), `node --test`, sharp (16-bit AVIF/PNG), our jxl-wasm facade.

**Spec:** `docs/superpowers/specs/2026-07-05-16bit-hdr-codec-pipeline-design.md`

**Working dir:** worktree `C:\Foo\rcw-codec-compare` on `feat/codec-compare-benchmark`. All commits are forward commits on this branch.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `crates/raw-pipeline/src/pipeline.rs` | 16-bit orientation helpers | Modify (add `apply_orientation_u16` + 7 u16 twins) |
| `src/lib.rs` | wasm export surface for display-referred RGBA16 | Modify (flag, fields, take, capture, downscale, rgba16 pack) |
| `crates/raw-pipeline/src/pipeline.rs` (tests) | u16 orientation unit tests | Modify (`#[cfg(test)]`) |
| `tools/probe-16bit-disp.mjs` | Node integration probe for the L1 export | Create |
| `benchmark/metrics16.mjs` | pure-JS PSNR-16 + SSIM-16 over Uint16Array | Create |
| `benchmark/test/metrics16.test.mjs` | metrics16 unit tests | Create |
| `benchmark/codec-compare-jxl.mjs` | `loadTarget16`, `makeJxlAdapter16`, `butteraugliDistance16` | Modify |
| `benchmark/codec-adapters.mjs` | `avif16` + `png16` adapters (exported as `ADAPTERS16`); round-trip identity is asserted inline in tests + the driver's PNG-16 lossless check | Modify |
| `benchmark/test/adapters16.test.mjs` | adapter round-trip identity tests | Create |
| `packages/jxl-wasm/src/bridge.cpp` | `jxl_wasm_butteraugli_compare16` | Modify |
| `packages/jxl-wasm/exports-enc.txt` | export the new symbol | Modify |
| `packages/jxl-wasm/src/facade.ts` | `computeButteraugli16` + module interface | Modify |
| `tools/probe-butteraugli16.mjs` | Node probe for the bridge | Create |
| `benchmark/codec-paper-figures-full.mjs` | `sweep16` param, `rd-*-16bit.svg`, gallery section | Modify |
| `benchmark/test/codec-paper-figures-full-16bit.test.mjs` | figure-emission test from synthetic sweep16 | Create |
| `CodecPaperFullTest.mjs` | 16-bit pass, `sweep16/fixed16/lossless16`, TOON, delivery | Modify |
| `docs/outputs/codec-paper-full/HDR-followup.md` | Part 3c follow-up note | Create |

---

# Phase 1 — L1: Rust display-referred 16-bit export

### Task 1: 16-bit orientation helpers

**Files:**
- Modify: `crates/raw-pipeline/src/pipeline.rs` (add after `apply_orientation`, which ends ~`:2545`)
- Test: `crates/raw-pipeline/src/pipeline.rs` (`#[cfg(test)]` module at end of file)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests { ... }` block at the end of `crates/raw-pipeline/src/pipeline.rs` (create the block if none exists, with `use super::*;`):

```rust
#[test]
fn apply_orientation_u16_rotate_90_cw() {
    // 2x1 image, pixels A=(1,2,3) B=(4,5,6) laid left-to-right.
    // EXIF orientation 6 = rotate 90 CW -> becomes 1x2, top pixel = A, bottom = B.
    let rgb: Vec<u16> = vec![1, 2, 3, 4, 5, 6];
    let (out, w, h) = apply_orientation_u16(rgb, 2, 1, 6);
    assert_eq!((w, h), (1, 2));
    assert_eq!(out, vec![1, 2, 3, 4, 5, 6]);
}

#[test]
fn apply_orientation_u16_identity() {
    let rgb: Vec<u16> = vec![10, 20, 30, 40, 50, 60];
    let (out, w, h) = apply_orientation_u16(rgb.clone(), 2, 1, 1);
    assert_eq!((w, h), (2, 1));
    assert_eq!(out, rgb);
}

#[test]
fn apply_orientation_u16_flip_h() {
    // orientation 2 = flip horizontal. 2x1: A B -> B A.
    let rgb: Vec<u16> = vec![1, 2, 3, 4, 5, 6];
    let (out, w, h) = apply_orientation_u16(rgb, 2, 1, 2);
    assert_eq!((w, h), (2, 1));
    assert_eq!(out, vec![4, 5, 6, 1, 2, 3]);
}
```

> Note: verify the exact top/bottom mapping of orientation 6 against the existing u8 `rotate_90_cw` (`pipeline.rs:2554`) — the assertion above must match the u8 helper's behavior on the same input, since the u16 twin is a byte-for-byte port. If the u8 helper maps differently, mirror it (the twin must be identical to u8, only the element type changes).

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p raw-pipeline apply_orientation_u16 2>&1 | tail -20`
Expected: FAIL — `cannot find function apply_orientation_u16 in this scope`.

- [ ] **Step 3: Implement `apply_orientation_u16` + 7 u16 twins**

Locate the u8 originals: `apply_orientation` (`pipeline.rs:2529-2545`) and helpers `rotate_90_cw` (`:2554`), `rotate_90_ccw` (`:2590`), `rotate_180` (`:2630`), `flip_horizontal` (`:2658`), `flip_vertical` (`:2675`), `transpose` (`:2690`), `anti_transpose` (`:2716`).

For each, create a `_u16` twin by copying the function verbatim and applying this **exact mechanical substitution** (the bodies index in `*3` *element* units already, so no stride math changes):
- `Vec<u8>` → `Vec<u16>`
- `&[u8]` → `&[u16]`
- rename `foo` → `foo_u16`
- inside `apply_orientation_u16`, call the `_u16` helper twins.

Concretely, `apply_orientation_u16` mirrors `apply_orientation`:

```rust
pub fn apply_orientation_u16(
    rgb: Vec<u16>,
    width: usize,
    height: usize,
    orientation: u16,
) -> (Vec<u16>, usize, usize) {
    match orientation {
        2 => (flip_horizontal_u16(&rgb, width, height), width, height),
        3 => (rotate_180_u16(&rgb, width, height), width, height),
        4 => (flip_vertical_u16(&rgb, width, height), width, height),
        5 => (transpose_u16(&rgb, width, height), height, width),
        6 => (rotate_90_cw_u16(&rgb, width, height), height, width),
        7 => (anti_transpose_u16(&rgb, width, height), height, width),
        8 => (rotate_90_ccw_u16(&rgb, width, height), height, width),
        _ => (rgb, width, height),
    }
}
```

> The match arms above must match the u8 `apply_orientation` arms exactly (same orientation→helper→dims mapping). If the u8 version differs, copy its arms verbatim and only append `_u16` to the helper names. Example twin for `rotate_90_cw`:

```rust
fn rotate_90_cw_u16(src: &[u16], w: usize, h: usize) -> Vec<u16> {
    // BODY IDENTICAL to rotate_90_cw (pipeline.rs:2554); only the element type is u16.
    let mut out = vec![0u16; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let si = (y * w + x) * 3;
            // dst is h wide; (x) becomes column, (h-1-y) becomes row... COPY the exact index
            // math from the u8 rotate_90_cw — do not re-derive it.
            let di = (x * h + (h - 1 - y)) * 3;
            out[di] = src[si];
            out[di + 1] = src[si + 1];
            out[di + 2] = src[si + 2];
        }
    }
    out
}
```

> IMPORTANT: for each of the 7 twins, do **not** re-derive the index math — open the u8 original at the line listed above and copy its body character-for-character, changing only `u8`→`u16` and the fn name. The test in Step 1 guards `rotate_90_cw_u16`, `flip_horizontal_u16`, and identity; a mistake in the copied index math will fail it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p raw-pipeline apply_orientation_u16 2>&1 | tail -20`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd C:/Foo/rcw-codec-compare
git add crates/raw-pipeline/src/pipeline.rs
git commit -m "feat(raw-pipeline): 16-bit orientation helpers (apply_orientation_u16 + twins)"
```

---

### Task 2: wasm export surface for the display-referred RGBA16 render

**Files:**
- Modify: `src/lib.rs` — flag `:711-724`; `ProcessResult` `:228`; take method `:344` block; `process_orf_impl` `:1007`; `process_dng_impl` `:2619`; new `downscale_rgb16_pub` (near `downscale_rgb` `:1431`); new `rgb16_to_rgba16` (near `rgb_to_rgba` `:1833`).

This task has no unit test (it is a wasm-bindgen surface); it is verified end-to-end by the Node probe in Task 3 after the rebuild. Compilation is the gate here.

- [ ] **Step 1: Add the flag**

Beside `OUT_FULL_16` / `OUT_NO_ORIENT` (`src/lib.rs:711-724`), add:

```rust
/// Full-resolution display-referred RGB16 (post WB/matrix/tone, oriented, full-range [0,65535]).
const OUT_FULL_DISP16: u32 = 32;
```

- [ ] **Step 2: Add `ProcessResult` fields**

In `ProcessResult` (`src/lib.rs:228`), beside `rgb16_full`/`full16_w`/`full16_h` (`:279-283`), add:

```rust
    rgb16_disp: Vec<u16>,
    #[wasm_bindgen(readonly)]
    pub disp16_w: u32,
    #[wasm_bindgen(readonly)]
    pub disp16_h: u32,
```

Initialize these to `Vec::new()` / `0` in every place `ProcessResult { ... }` is constructed (find each literal; the ORF/DNG builders and any default). Search: `rg "ProcessResult\s*\{" src/lib.rs`.

- [ ] **Step 3: Add the take method**

In the `impl ProcessResult` take block (`:344`), mirror `take_rgb16_full` (`:377`) but return native `Vec<u16>` (no LE packing — wasm-bindgen maps `Vec<u16>` → `Uint16Array`):

```rust
    /// Display-referred, oriented, full-res RGB16 (interleaved, [0,65535]). Empty after first call
    /// or if OUT_FULL_DISP16 was not requested.
    pub fn take_rgb16_disp(&mut self) -> Vec<u16> {
        std::mem::take(&mut self.rgb16_disp)
    }
```

- [ ] **Step 4: Add `downscale_rgb16_pub`**

Near `downscale_rgb` (`:1431`), add a public 16-bit long-edge downscale mirroring its guards, delegating to the existing `pipeline::downscale_rgb16` (`pipeline.rs:2281`):

```rust
#[wasm_bindgen]
pub fn downscale_rgb16_pub(
    src: &[u16],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Result<Vec<u16>, JsError> {
    let (sw, sh, dw, dh) = (src_w as usize, src_h as usize, dst_w as usize, dst_h as usize);
    if src.len() != sw * sh * 3 {
        return Err(JsError::new("downscale_rgb16_pub: src len != src_w*src_h*3"));
    }
    if dw == 0 || dh == 0 || dw > sw || dh > sh {
        return Err(JsError::new("downscale_rgb16_pub: invalid target dims"));
    }
    Ok(pipeline::downscale_rgb16(src, sw, sh, dw, dh))
}
```

> Confirm `pipeline::downscale_rgb16`'s exact signature at `pipeline.rs:2281` and match arg order/types. If it takes `usize`, pass `sw,sh,dw,dh`; adjust if it differs.

- [ ] **Step 5: Add `rgb16_to_rgba16`**

Near `rgb_to_rgba` (`:1833`), add:

```rust
#[wasm_bindgen]
pub fn rgb16_to_rgba16(rgb: &[u16]) -> Vec<u16> {
    let n = rgb.len() / 3;
    let mut out = vec![0u16; n * 4];
    for i in 0..n {
        out[i * 4] = rgb[i * 3];
        out[i * 4 + 1] = rgb[i * 3 + 1];
        out[i * 4 + 2] = rgb[i * 3 + 2];
        out[i * 4 + 3] = 0xFFFF;
    }
    out
}
```

- [ ] **Step 6: Capture the display render in `process_orf_impl`**

In `process_orf_impl` (`src/lib.rs:1007`), following the map from the design (mirror the `OUT_FULL_RGB8` tone/orient block, `:1081-1123`):

1. Near the flag reads (~`:1040`): `let want_disp16 = output_flags & OUT_FULL_DISP16 != 0;`
2. OR `OUT_FULL_DISP16` into the `need_full_rgb` computation (so the full `rgb16` master is materialized — sites `:821`, `:958`). Example: `let need_full_rgb = output_flags & (OUT_FULL_RGB8 | OUT_FULL_16 | OUT_FULL_DISP16) != 0;` (match the existing expression form).
3. Widen the tone-stage gate (`:1082`) from `OUT_FULL_RGB8 != 0` to `(OUT_FULL_RGB8 | OUT_FULL_DISP16) != 0`.
4. **Before** `rgb16` is moved into `rgb16_full` (`:1104`), while it is still borrowable, add:

```rust
    let (rgb16_disp, disp16_w, disp16_h) = if want_disp16 {
        let disp = pipeline::process_16bit(&rgb16, &params);
        if skip_orient || info.orientation == 1 {
            (disp, w as u32, h as u32)
        } else {
            let (d, dw, dh) = pipeline::apply_orientation_u16(disp, w, h, info.orientation);
            (d, dw as u32, dh as u32)
        }
    } else {
        (Vec::new(), 0u32, 0u32)
    };
```

> Match the local variable names actually in scope (`rgb16`, `params`, `w`, `h`, `info.orientation`, and the `skip_orient` predicate — the 8-bit path computes an equivalent; reuse it). `pipeline::process_16bit` signature is `(rgb16: &[u16], params: &LookParams) -> Vec<u16>` (verify at `pipeline.rs:2148`).

5. Thread `rgb16_disp`, `disp16_w`, `disp16_h` through the function's return tuple and into the `ProcessResult { ... }` builder (alongside `rgb16_full`/`full16_w`/`full16_h`).

- [ ] **Step 7: Mirror the capture in `process_dng_impl`**

Apply the identical edits to `process_dng_impl` (`src/lib.rs:2619`) at the mirror sites: flag read near `:2647`, `need_full_rgb` at `:2493`, tone gate `:2706`, `rgb16` move `:2723`, orientation `:2730`, return tuple `:2736`, builder `:2742+`. This also covers CR2 (via `process_cr2_impl → process_dng_impl`, `:3076`).

- [ ] **Step 8: Compile (native check)**

Run: `cargo check -p raw-converter-wasm --lib 2>&1 | tail -30`
Expected: no errors. (If `wasm32` feature-gating hides these fns from native `check`, run `.\build-msvc.ps1 check` per CLAUDE.md, or proceed to Task 3's wasm build which is the real gate.)

- [ ] **Step 9: Commit**

```bash
cd C:/Foo/rcw-codec-compare
git add src/lib.rs
git commit -m "feat(wasm): export display-referred RGBA16 render (OUT_FULL_DISP16 + take_rgb16_disp + downscale_rgb16_pub + rgb16_to_rgba16)"
```

---

### Task 3: Rebuild pkg + Node integration probe

**Files:**
- Create: `tools/probe-16bit-disp.mjs`
- Rebuild artifact: `pkg/` + `web/pkg/` (via `build-parallel-wasm.ps1`)

- [ ] **Step 1: Write the probe (the "test")**

Create `tools/probe-16bit-disp.mjs`:

```js
// Verifies the L1 display-referred RGBA16 export end-to-end against a real RAW file.
// Asserts: buffer sizing, full-range usage, and 8-bit consistency (disp16>>8 ~= 8-bit render).
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const raw = require("../pkg/raw_converter_wasm.js");

const OUT_FULL_RGB8 = 1, OUT_FULL_DISP16 = 32;
const PROCESS_ARGS = [0,0,0,0,0,0,0,0,0,0, NaN, NaN, 0,0];
const TARGET = 1920;
const ORF = String.raw`C:\Foo\raw-converter\tests\P1110226.ORF`;

function longEdge(w, h, t) { return w >= h ? [t, Math.max(1, Math.round(h * t / w))] : [Math.max(1, Math.round(w * t / h)), t]; }

async function main() {
  if (!existsSync(ORF)) { console.log("SKIP: test ORF missing", ORF); return; }
  await raw.default({ module_or_path: readFileSync(require.resolve("../pkg/raw_converter_wasm_bg.wasm")) });
  const bytes = new Uint8Array(readFileSync(ORF));

  // 8-bit reference
  const d8 = raw.process_orf_with_flags(bytes, OUT_FULL_RGB8, ...PROCESS_ARGS);
  const rgb8 = d8.take_rgb(); const w8 = d8.width, h8 = d8.height; d8.free();

  // 16-bit display render
  const d16 = raw.process_orf_with_flags(bytes, OUT_FULL_DISP16, ...PROCESS_ARGS);
  const rgb16 = d16.take_rgb16_disp(); const w16 = d16.disp16_w, h16 = d16.disp16_h; d16.free();

  if (!(rgb16 instanceof Uint16Array)) throw new Error("take_rgb16_disp did not return Uint16Array");
  if (rgb16.length !== w16 * h16 * 3) throw new Error(`bad disp16 len ${rgb16.length} != ${w16*h16*3}`);
  if (w16 !== w8 || h16 !== h8) throw new Error(`dims mismatch 8bit ${w8}x${h8} vs 16bit ${w16}x${h16}`);

  // full-range usage: max sample should be well above 8-bit-shifted ceiling (i.e. > 255<<8)
  let mx = 0; for (let i = 0; i < rgb16.length; i++) if (rgb16[i] > mx) mx = rgb16[i];
  if (mx <= 255 << 8) throw new Error(`disp16 not full-range, max=${mx}`);

  // 8-bit consistency: disp16>>8 within +/-1 of rgb8 for the vast majority of samples
  let bad = 0; const n = rgb8.length;
  for (let i = 0; i < n; i++) { if (Math.abs((rgb16[i] >> 8) - rgb8[i]) > 1) bad++; }
  const frac = bad / n;
  if (frac > 0.02) throw new Error(`disp16>>8 vs rgb8 mismatch frac=${frac.toFixed(4)} (>2%)`);

  // downscale + rgba16 pack
  const [tw, th] = longEdge(w16, h16, TARGET);
  const rgb16s = raw.downscale_rgb16_pub(rgb16, w16, h16, tw, th);
  if (rgb16s.length !== tw * th * 3) throw new Error(`bad downscaled len`);
  const rgba16 = raw.rgb16_to_rgba16(rgb16s);
  if (rgba16.length !== tw * th * 4) throw new Error(`bad rgba16 len`);
  if (rgba16[3] !== 0xFFFF) throw new Error(`alpha not 0xFFFF`);

  console.log(`OK 16-bit disp: ${w16}x${h16} -> ${tw}x${th}, max=${mx}, consistency bad-frac=${frac.toFixed(5)}`);
}
main().catch(e => { console.error("PROBE FAIL", e); process.exit(1); });
```

> Confirm the pkg init signature and `_bg.wasm` filename against the current `pkg/raw_converter_wasm.js` (the `--target web` init used by `codec-compare-jxl.mjs:8` is `raw.default({ module_or_path })`). Adjust the ORF path if that fixture is absent — use any file from `RAW_FILES` (`CodecPaperFullTest.mjs:26-30`) that exists.

- [ ] **Step 2: Run the probe to verify it fails (pre-rebuild)**

Run: `node tools/probe-16bit-disp.mjs`
Expected: FAIL — `take_rgb16_disp is not a function` (the shipped pkg predates Task 2).

- [ ] **Step 3: Rebuild the pkg**

Run: `powershell -File .\build-parallel-wasm.ps1`
Expected: build completes; `pkg/raw_converter_wasm.js` + `pkg/raw_converter_wasm_bg.wasm` + `web/pkg/` regenerated. (Nightly toolchain per the script; see CLAUDE.md Rust/WASM notes.)

- [ ] **Step 4: Run the probe to verify it passes**

Run: `node tools/probe-16bit-disp.mjs`
Expected: PASS — `OK 16-bit disp: ...`.

- [ ] **Step 5: Commit**

```bash
cd C:/Foo/rcw-codec-compare
git add tools/probe-16bit-disp.mjs pkg web/pkg
git commit -m "test(wasm): 16-bit display-render probe; rebuild pkg with OUT_FULL_DISP16"
```

> If `pkg/`/`web/pkg/` are gitignored, commit only the probe and note the rebuild in the message.

---

# Phase 2 — L3/L4: 16-bit adapters + JS metrics (real figure without the bridge)

### Task 4: `metrics16.mjs` — PSNR-16 + SSIM-16

**Files:**
- Create: `benchmark/metrics16.mjs`
- Test: `benchmark/test/metrics16.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `benchmark/test/metrics16.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { psnr16, ssim16 } from "../metrics16.mjs";

// 2x2 RGBA16 opaque
function img(vals) { // vals = 4 pixels x [r,g,b]; alpha auto 0xFFFF
  const out = new Uint16Array(4 * 4);
  for (let p = 0; p < 4; p++) { out[p*4]=vals[p][0]; out[p*4+1]=vals[p][1]; out[p*4+2]=vals[p][2]; out[p*4+3]=0xFFFF; }
  return out;
}
const A = img([[100,100,100],[200,200,200],[300,300,300],[400,400,400]]);

test("psnr16 identical -> Infinity", () => {
  assert.equal(psnr16(A, A, 2, 2), Infinity);
});

test("psnr16 resolves sub-8-bit diffs", () => {
  const B = img([[101,100,100],[200,200,200],[300,300,300],[400,400,400]]); // +1 in 16-bit
  const p = psnr16(A, B, 2, 2);
  assert.ok(Number.isFinite(p) && p > 90 && p < 130, `psnr16=${p}`); // tiny diff => very high but finite
});

test("ssim16 identical -> ~1", () => {
  const s = ssim16(A, A, 2, 2);
  assert.ok(Math.abs(s - 1) < 1e-9, `ssim16=${s}`);
});

test("ssim16 degrades with noise", () => {
  const B = img([[100,100,100],[200,200,200],[300,300,300],[40000,40000,40000]]);
  const s = ssim16(A, B, 2, 2);
  assert.ok(s < 0.999, `ssim16=${s}`);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test benchmark/test/metrics16.test.mjs`
Expected: FAIL — cannot find module `../metrics16.mjs`.

- [ ] **Step 3: Implement `metrics16.mjs`**

Create `benchmark/metrics16.mjs`:

```js
// Pure-JS 16-bit distortion metrics over interleaved RGBA16 (Uint16Array, alpha ignored).
// PSNR peak = 65535. SSIM on 16-bit luma, 8x8 non-overlapping windows (edge windows clipped).
const PEAK = 65535;
const L2 = PEAK * PEAK;
const C1 = (0.01 * PEAK) ** 2;
const C2 = (0.03 * PEAK) ** 2;

function assertShape(ref, test, w, h) {
  if (ref.length !== w * h * 4 || test.length !== w * h * 4)
    throw new Error(`metrics16: expected ${w * h * 4} samples, got ref=${ref.length} test=${test.length}`);
}

export function psnr16(ref, test, w, h) {
  assertShape(ref, test, w, h);
  let sse = 0;
  const n = w * h;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    for (let c = 0; c < 3; c++) { const d = ref[i + c] - test[i + c]; sse += d * d; }
  }
  if (sse === 0) return Infinity;
  const mse = sse / (n * 3);
  return 10 * Math.log10(L2 / mse);
}

function luma16(buf, w, h) {
  const out = new Float64Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    out[p] = 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
  }
  return out;
}

export function ssim16(ref, test, w, h) {
  assertShape(ref, test, w, h);
  const a = luma16(ref, w, h), b = luma16(test, w, h);
  let sum = 0, wins = 0;
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      const x1 = Math.min(bx + 8, w), y1 = Math.min(by + 8, h);
      let ma = 0, mb = 0, cnt = 0;
      for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) { const k = y * w + x; ma += a[k]; mb += b[k]; cnt++; }
      ma /= cnt; mb /= cnt;
      let va = 0, vb = 0, cov = 0;
      for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) { const k = y * w + x; const da = a[k] - ma, db = b[k] - mb; va += da * da; vb += db * db; cov += da * db; }
      va /= cnt; vb /= cnt; cov /= cnt;
      const s = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      sum += s; wins++;
    }
  }
  return wins ? sum / wins : 1;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test benchmark/test/metrics16.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd C:/Foo/rcw-codec-compare
git add benchmark/metrics16.mjs benchmark/test/metrics16.test.mjs
git commit -m "feat(benchmark): pure-JS PSNR-16 + SSIM-16 metrics over RGBA16"
```

---

### Task 5: `loadTarget16` + JXL rgba16 adapter + `butteraugliDistance16`

**Files:**
- Modify: `benchmark/codec-compare-jxl.mjs` (add exports `loadTarget16`, `makeJxlAdapter16`, `butteraugliDistance16`)
- Test: `benchmark/test/adapters16.test.mjs` (created here; extended in Task 6)

- [ ] **Step 1: Write the failing test (JXL rgba16 round-trip)**

Create `benchmark/test/adapters16.test.mjs`:

```js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { initCodecCompareJxl, makeJxlAdapter16, roundtripRgba16 } from "../codec-compare-jxl.mjs";

// synthetic 16x16 RGBA16 gradient
function grad(w, h) {
  const out = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    out[i] = (x * 65535 / (w - 1)) | 0; out[i+1] = (y * 65535 / (h - 1)) | 0;
    out[i+2] = ((x + y) * 65535 / (w + h - 2)) | 0; out[i+3] = 0xFFFF;
  }
  return out;
}

before(async () => { await initCodecCompareJxl(); });

test("jxl16 adapter round-trips RGBA16 near-lossless", async () => {
  const w = 16, h = 16, src = grad(w, h);
  const a = makeJxlAdapter16();
  const bytes = await a.encode(src, w, h, 98);
  assert.ok(bytes.length > 0);
  const dec = await a.decode(bytes);
  assert.equal(dec.width, w); assert.equal(dec.height, h);
  assert.ok(dec.data instanceof Uint16Array, "decoded data must be Uint16Array");
  assert.equal(dec.data.length, w * h * 4);
  // high-quality: mean abs error small relative to 16-bit range
  let e = 0; for (let i = 0; i < src.length; i++) e += Math.abs(src[i] - dec.data[i]);
  const mae = e / src.length;
  assert.ok(mae < 2000, `jxl16 mae=${mae}`);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test benchmark/test/adapters16.test.mjs`
Expected: FAIL — `makeJxlAdapter16` / `roundtripRgba16` not exported.

- [ ] **Step 3: Implement in `codec-compare-jxl.mjs`**

At the top of `benchmark/codec-compare-jxl.mjs`, ensure the module-level `raw` and `facade` handles are reachable (they are set in `initCodecCompareJxl`). Add these exports (mirror `loadTargetRgba` `:19` and `makeJxlAdapter` `:52`):

```js
// --- 16-bit source: display-referred RGBA16 @ TARGET long-edge from a RAW file ---
const OUT_FULL_DISP16 = 32;
export async function loadTarget16(path) {
  const { readFileSync } = await import("node:fs");
  const ext = path.toLowerCase().split(".").pop();
  const bytes = new Uint8Array(readFileSync(path));
  let dec;
  if (ext === "orf" || ext === "raw") dec = raw.process_orf_with_flags(bytes, OUT_FULL_DISP16, ...PROCESS_ARGS);
  else if (ext === "cr2") dec = raw.process_cr2_with_flags(bytes, OUT_FULL_DISP16, ...PROCESS_ARGS);
  else if (ext === "dng") dec = raw.process_dng_with_flags(bytes, OUT_FULL_DISP16, ...PROCESS_ARGS);
  else throw new Error(`loadTarget16: unsupported ext ${ext}`);
  const rgb16 = dec.take_rgb16_disp(); const sw = dec.disp16_w, sh = dec.disp16_h; dec.free();
  const [tw, th] = sw >= sh ? [TARGET, Math.max(1, Math.round(sh * TARGET / sw))]
                            : [Math.max(1, Math.round(sw * TARGET / sh)), TARGET];
  const rgb16s = raw.downscale_rgb16_pub(rgb16, sw, sh, tw, th);
  const rgba16 = raw.rgb16_to_rgba16(rgb16s);
  return { rgba16: rgba16 instanceof Uint16Array ? rgba16 : new Uint16Array(rgba16), tgtW: tw, tgtH: th, file: path.split(/[\\/]/).pop() };
}

// exactBuffer for 16-bit: hand the tight LE byte view to the facade
function exact16Bytes(u16) {
  return new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength);
}

// --- our JXL encoder/decoder in rgba16 mode ---
export function makeJxlAdapter16() {
  return {
    key: "jxl", runtime: "wasm", lossless: false,
    async encode(rgba16, w, h, quality) {
      const enc = facade.createEncoder({
        format: "rgba16", width: w, height: h, hasAlpha: true,
        iccProfile: null, exif: null, xmp: null,
        quality, effort: 3, progressive: true, progressiveFlavor: "ac",
        previewFirst: false, chunked: true,
      });
      const chunks = [];
      enc.onChunk?.((c) => chunks.push(c)); // match the 8-bit adapter's chunk collection pattern
      await enc.pushPixels(exact16Bytes(rgba16));
      const out = await enc.finish();
      return out instanceof Uint8Array ? out : concatChunks(chunks, out);
    },
    async decode(bytes) {
      const dec = facade.createDecoder({
        format: "rgba16", progressionTarget: "final", emitEveryPass: true,
        progressiveDetail: "passes", preserveIcc: false, preserveMetadata: false,
      });
      const r = await dec.decode(bytes);
      const data = r.pixels instanceof Uint16Array ? r.pixels : new Uint16Array(r.pixels.buffer ?? r.pixels);
      return { data, width: r.width, height: r.height, firstFrameMs: r.firstFrameMs };
    },
  };
}
```

> CRITICAL: mirror the **exact** encode/decode call shape of the working 8-bit `makeJxlAdapter` (`codec-compare-jxl.mjs:52-129`) — the chunk-collection, `finish()`, and decoder result-field names (`pixels` vs `data`) must match what that adapter uses. Copy its structure and change only `format:'rgba8'`→`'rgba16'` and the pixel buffer to the 16-bit LE byte view. The pseudo-helpers `enc.onChunk`/`concatChunks` above are placeholders for whatever the 8-bit adapter actually does — replace with the real pattern.

Also add a shared round-trip guard used by tests + the driver:

```js
export function roundtripRgba16(adapter) {
  // returns an async fn(w,h) that encodes a gradient near-lossless, decodes, returns mean-abs-error
  return async (w = 32, h = 32) => {
    const src = new Uint16Array(w * h * 4);
    for (let p = 0; p < w * h; p++) { const v = (p * 65535 / (w * h - 1)) | 0; src[p*4]=v; src[p*4+1]=65535-v; src[p*4+2]=(v*3)&0xFFFF; src[p*4+3]=0xFFFF; }
    const b = await adapter.encode(src, w, h, 98);
    const d = await adapter.decode(b);
    let e = 0; const n = Math.min(src.length, d.data.length);
    for (let i = 0; i < n; i++) e += Math.abs(src[i] - d.data[i]);
    return e / n;
  };
}
```

Add the capability-guarded 16-bit Butteraugli wrapper (used in Phase 3/4; harmless now — it throws/returns null until the bridge exists):

```js
export async function butteraugliDistance16(refRgba16, testRgba16, w, h) {
  if (typeof facade.computeButteraugli16 !== "function") return null; // capability absent
  try {
    return await facade.computeButteraugli16(
      new Uint8Array(refRgba16.buffer, refRgba16.byteOffset, refRgba16.byteLength),
      new Uint8Array(testRgba16.buffer, testRgba16.byteOffset, testRgba16.byteLength),
      w, h);
  } catch (e) {
    if (/CapabilityMissing/.test(String(e))) return null;
    throw e;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test benchmark/test/adapters16.test.mjs`
Expected: PASS (1 test). If the JXL rgba16 round-trip MAE is unexpectedly large, the `format:'rgba16'` chunk/finish plumbing does not match the 8-bit adapter — fix per the CRITICAL note before proceeding.

- [ ] **Step 5: Commit**

```bash
cd C:/Foo/rcw-codec-compare
git add benchmark/codec-compare-jxl.mjs benchmark/test/adapters16.test.mjs
git commit -m "feat(benchmark): loadTarget16 + JXL rgba16 adapter + butteraugliDistance16 (capability-guarded)"
```

---

### Task 6: AVIF-10/12 + PNG-16 adapters + round-trip guard

**Files:**
- Modify: `benchmark/codec-adapters.mjs` (add `avif16`, `png16`, and a `roundtripGuard16` helper; export a `ADAPTERS16` array)
- Test: `benchmark/test/adapters16.test.mjs` (extend)

- [ ] **Step 1: Write the failing test (extend)**

Append to `benchmark/test/adapters16.test.mjs`:

```js
import { ADAPTERS16 } from "../codec-adapters.mjs";

function grad16(w, h) {
  const out = new Uint16Array(w * h * 4);
  for (let p = 0; p < w * h; p++) { const v = (p * 65535 / (w*h-1)) | 0; out[p*4]=v; out[p*4+1]=65535-v; out[p*4+2]=(v*7)&0xFFFF; out[p*4+3]=0xFFFF; }
  return out;
}

for (const spec of [{ key: "avif16", q: 90, maeMax: 4000 }, { key: "png16", q: 100, maeMax: 1 }]) {
  test(`${spec.key} round-trips RGBA16 to full-range and near-source`, async () => {
    const a = ADAPTERS16.find(x => x.key === spec.key);
    if (!a) { console.log(`SKIP ${spec.key} (adapter absent)`); return; }
    const w = 32, h = 32, src = grad16(w, h);
    let bytes;
    try { bytes = await a.encode(src, w, h, spec.q); }
    catch (e) { console.log(`SKIP ${spec.key} (encode unsupported at runtime): ${e.message}`); return; }
    const dec = await a.decode(bytes);
    assert.ok(dec.data instanceof Uint16Array, `${spec.key} decode must yield Uint16Array`);
    assert.equal(dec.data.length, w * h * 4, `${spec.key} decode length`);
    // full-range: decoded max must exceed 8-bit ceiling (proves not silently 8-bit)
    let mx = 0; for (let i = 0; i < dec.data.length; i += 4) { if (dec.data[i] > mx) mx = dec.data[i]; }
    assert.ok(mx > (255 << 8), `${spec.key} decoded not full-range max=${mx}`);
    let e = 0; for (let i = 0; i < src.length; i++) e += Math.abs(src[i] - dec.data[i]);
    assert.ok(e / src.length < spec.maeMax, `${spec.key} mae=${e / src.length}`);
  });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test benchmark/test/adapters16.test.mjs`
Expected: FAIL — `ADAPTERS16` not exported.

- [ ] **Step 3: Implement in `codec-adapters.mjs`**

Add to `benchmark/codec-adapters.mjs`:

```js
// --- 16-bit adapters (RGBA16 Uint16Array in/out). sharp handles 16-bit natively. ---
// sharp raw input depth is inferred from the TypedArray (Uint16Array -> 'ushort').
// 16-bit raw OUTPUT requires .raw({depth:'ushort'}); default is 8-bit and would truncate.
const sharpRaw16 = (rgba16, w, h) =>
  sharp(Buffer.from(rgba16.buffer, rgba16.byteOffset, rgba16.byteLength), { raw: { width: w, height: h, channels: 4 } });

async function decodeSharp16(bytes) {
  const { data, info } = await sharp(Buffer.from(bytes))
    .ensureAlpha()
    .toColourspace("rgb16")
    .raw({ depth: "ushort" })
    .toBuffer({ resolveWithObject: true });
  // libvips gives LE uint16; wrap without copy
  const u16 = new Uint16Array(data.buffer, data.byteOffset, data.byteLength >> 1);
  return { data: u16, width: info.width, height: info.height };
}

export const ADAPTERS16 = [
  {
    key: "avif16", runtime: "native", lossless: false,
    async encode(rgba16, w, h, quality) {
      const bitdepth = 12; // libaom AV1 high-bit-depth; 10 also valid
      return toU8(await sharpRaw16(rgba16, w, h).toColourspace("rgb16").avif({ quality, bitdepth, chromaSubsampling: "4:4:4" }).toBuffer());
    },
    decode: decodeSharp16,
  },
  {
    key: "png16", runtime: "native", lossless: true,
    async encode(rgba16, w, h) {
      return toU8(await sharpRaw16(rgba16, w, h).toColourspace("rgb16").png().toBuffer());
    },
    decode: decodeSharp16,
  },
];
```

> `toU8` and `sharp` are already imported at the top of `codec-adapters.mjs` (`:7`, `:18`). If `sharpRaw16(...).toColourspace('rgb16')` on a raw 8-bit-typed input path errors, the input is already 16-bit (ushort) so `.toColourspace('rgb16')` is a no-op flag — keep it for output correctness. If the installed sharp/libheif rejects `avif({bitdepth:12})` at runtime, the test's try/catch turns it into a SKIP; fall back to `@jsquash/avif` (`encode(imageData16, {bitDepth:10})` with the source right-shifted to `[0,1023]` and `decode(buf,{bitDepth:10})` upshifted back) — implement that fallback only if the sharp path is unavailable.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test benchmark/test/adapters16.test.mjs`
Expected: PASS (jxl16 + avif16 + png16; SKIP lines acceptable if AVIF-hi-depth is unsupported at runtime — png16 and jxl16 must pass).

- [ ] **Step 5: Commit**

```bash
cd C:/Foo/rcw-codec-compare
git add benchmark/codec-adapters.mjs benchmark/test/adapters16.test.mjs
git commit -m "feat(benchmark): AVIF-10/12 + PNG-16 adapters (sharp) with full-range round-trip guard"
```

---

# Phase 3 — L2: 16-bit Butteraugli bridge (additive perceptual metric)

### Task 7: `jxl_wasm_butteraugli_compare16` + export + facade wrapper

**Files:**
- Modify: `packages/jxl-wasm/src/bridge.cpp` (new fn after `jxl_wasm_butteraugli_ref_free`, ~`:3859`)
- Modify: `packages/jxl-wasm/exports-enc.txt` (append symbol)
- Modify: `packages/jxl-wasm/src/facade.ts` (interface `:502-505`; `computeButteraugli16` after `:800`)

- [ ] **Step 1: Add the C entry point**

Read the 8-bit reference `jxl_wasm_butteraugli_compare` (`bridge.cpp:3707-3763`). Copy it verbatim into a new function immediately after `jxl_wasm_butteraugli_ref_free` (`:3859`), renamed and with **only** the pixel-ingestion changed:

```cpp
// 16-bit sibling of jxl_wasm_butteraugli_compare. Input = interleaved RGBA16 (LE uint16, stride 4).
// Linearizes via gamma 2.2 on v/65535 — the SAME transfer as the 8-bit SrgbGamma22Lut, at 16-bit
// resolution — so scores are directly comparable to the 8-bit path.
extern "C" int32_t jxl_wasm_butteraugli_compare16(
    const uint16_t* img1, const uint16_t* img2, uint32_t width, uint32_t height) {
  // --- BEGIN: copy the Image3F setup + ButteraugliInterfaceInPlace call + score->int32 packing
  //     verbatim from jxl_wasm_butteraugli_compare (bridge.cpp:3707-3763). The ONLY change is the
  //     two pixel-read loops below (uint16 stride-4 + pow-2.2 linearize instead of the u8 LUT). ---
  jxl::Image3F rgb1 = jxl::Image3F::Create(width, height); // match exact Create call in the 8-bit fn
  jxl::Image3F rgb2 = jxl::Image3F::Create(width, height);
  auto lin = [](uint16_t v) -> float { return std::pow(static_cast<float>(v) * (1.0f / 65535.0f), 2.2f); };
  for (uint32_t y = 0; y < height; ++y) {
    float* r1 = rgb1.PlaneRow(0, y); float* g1 = rgb1.PlaneRow(1, y); float* b1 = rgb1.PlaneRow(2, y);
    float* r2 = rgb2.PlaneRow(0, y); float* g2 = rgb2.PlaneRow(1, y); float* b2 = rgb2.PlaneRow(2, y);
    for (uint32_t x = 0; x < width; ++x) {
      const uint32_t i = (y * width + x) * 4;
      r1[x] = lin(img1[i]);   g1[x] = lin(img1[i + 1]);   b1[x] = lin(img1[i + 2]);
      r2[x] = lin(img2[i]);   g2[x] = lin(img2[i + 1]);   b2[x] = lin(img2[i + 2]);
    }
  }
  // --- Butteraugli params + comparator call + score packing: COPY VERBATIM from the 8-bit fn.
  //     (The fork uses ButteraugliComparator::Make / .value_() and packs the float score to int32
  //     bits; reuse whatever the 8-bit fn does so the two are numerically identical apart from input.)
  // return <packed int32 score>;
}
```

> The header for `std::pow` (`<cmath>`) and butteraugli are already included (`bridge.cpp:13`). Use the SAME `Image3F` plane-access API the 8-bit fn uses (`PlaneRow` vs `Row(c,y)` — match it exactly). Reuse the 8-bit fn's exact butteraugli parameters (intensity target, hf asymmetry) and its float→int32 packing so parity holds. This function lives inside the same `extern "C"` region as the sibling metric fns (`jxl_wasm_psnr_compare` `:3865`, `jxl_wasm_ssim_compare` `:3920`).

- [ ] **Step 2: Export the symbol**

Append a line to `packages/jxl-wasm/exports-enc.txt` (the file the Node benchmark's `enc:simd` tier links; the 8-bit symbol is at `:61`):

```
_jxl_wasm_butteraugli_compare16
```

(Optionally also append to `exports-dec.txt` and `exports.txt` for browser/monolithic tiers — not required for the benchmark.)

- [ ] **Step 3: Add the facade wrapper**

In `packages/jxl-wasm/src/facade.ts`, add to the `LibjxlWasmModule` interface after `_jxl_wasm_butteraugli_compare?` (`:502-505`):

```ts
  _jxl_wasm_butteraugli_compare16?(ptr1: number, ptr2: number, width: number, height: number): number;
```

Add `computeButteraugli16` after `computeButteraugli` (`:800`), mirroring it but with RGBA16 sizing (`w*h*4*2` bytes) and a capability guard:

```ts
export async function computeButteraugli16(
  pixels1: ArrayBuffer | Uint8Array,
  pixels2: ArrayBuffer | Uint8Array,
  width: number,
  height: number,
): Promise<number> {
  const module = await loadLibjxlModule();
  if (!module._jxl_wasm_butteraugli_compare16) {
    throw new CapabilityMissing("jxl_wasm_butteraugli_compare16 not in this core");
  }
  const pixelSize = width * height * 4 * 2; // RGBA16
  const v1 = pixels1 instanceof Uint8Array ? pixels1 : new Uint8Array(pixels1);
  const v2 = pixels2 instanceof Uint8Array ? pixels2 : new Uint8Array(pixels2);
  if (v1.byteLength < pixelSize || v2.byteLength < pixelSize) {
    throw new Error(`computeButteraugli16: expected ${pixelSize} bytes for ${width}x${height} RGBA16`);
  }
  const ptr1 = module._malloc(pixelSize);
  const ptr2 = module._malloc(pixelSize);
  try {
    module.HEAPU8.set(v1.subarray(0, pixelSize), ptr1);
    module.HEAPU8.set(v2.subarray(0, pixelSize), ptr2);
    const bits = module._jxl_wasm_butteraugli_compare16(ptr1, ptr2, width, height);
    return floatFromI32Bits(bits);
  } finally {
    module._free(ptr1);
    module._free(ptr2);
  }
}
```

> Match the EXACT malloc/HEAPU8/free/`floatFromI32Bits` idiom of the 8-bit `computeButteraugli` (`:771-800`) — copy its body and change the sizing + the called symbol. Confirm `CapabilityMissing`, `loadLibjxlModule`, `floatFromI32Bits` are the same identifiers used there.

- [ ] **Step 4: Recompile facade TS → dist**

Run: `npx tsc -p packages/jxl-wasm/tsconfig.json`
Expected: emits updated `packages/jxl-wasm/dist/facade.js`, `dist/index.js`, `.d.ts`. No type errors.

- [ ] **Step 5: Commit source (pre-wasm-rebuild)**

```bash
cd C:/Foo/rcw-codec-compare
git add packages/jxl-wasm/src/bridge.cpp packages/jxl-wasm/exports-enc.txt packages/jxl-wasm/src/facade.ts packages/jxl-wasm/dist
git commit -m "feat(jxl-wasm): 16-bit Butteraugli bridge + facade.computeButteraugli16 (source)"
```

---

### Task 8: Emscripten rebuild + bridge probe

**Files:**
- Create: `tools/probe-butteraugli16.mjs`
- Rebuild artifact: `packages/jxl-wasm/dist/jxl-core.enc.simd.{js,wasm}`

- [ ] **Step 1: Write the probe (the "test")**

Create `tools/probe-butteraugli16.mjs`:

```js
// Verifies computeButteraugli16 exists and matches the 8-bit path on promoted input.
import * as facade from "../packages/jxl-wasm/dist/index.js";

function rgba8(w, h, f) { const o = new Uint8Array(w*h*4); for (let p=0;p<w*h;p++){ const [r,g,b]=f(p); o[p*4]=r;o[p*4+1]=g;o[p*4+2]=b;o[p*4+3]=255; } return o; }
function promote(u8) { const o = new Uint16Array(u8.length); for (let i=0;i<u8.length;i++) o[i]=u8[i]*257; return o; } // b*257: 0..255 -> 0..65535 exactly

async function main() {
  const w = 64, h = 64;
  const A8 = rgba8(w, h, p => [p & 255, (p*3) & 255, (p*7) & 255]);
  const B8 = rgba8(w, h, p => [(p + 5) & 255, (p*3) & 255, (p*7) & 255]); // shifted red
  const A16 = promote(A8), B16 = promote(B8);

  if (typeof facade.computeButteraugli16 !== "function") throw new Error("computeButteraugli16 not exported from facade");

  const self = await facade.computeButteraugli16(A16.buffer, A16.buffer, w, h);
  if (self !== 0) throw new Error(`compare16(x,x) = ${self}, expected 0`);

  const b16 = await facade.computeButteraugli16(A16.buffer, B16.buffer, w, h);
  const b8 = await facade.computeButteraugli(A8.buffer, B8.buffer, w, h);
  const rel = Math.abs(b16 - b8) / Math.max(b8, 1e-6);
  if (!(rel < 0.02)) throw new Error(`parity fail: b16=${b16} b8=${b8} rel=${rel}`);
  console.log(`OK butteraugli16: self=0, b16=${b16.toFixed(4)} b8=${b8.toFixed(4)} rel=${rel.toFixed(4)}`);
}
main().catch(e => { console.error("PROBE FAIL", e); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails (pre-wasm-rebuild)**

Run: `node tools/probe-butteraugli16.mjs`
Expected: FAIL — `computeButteraugli16 not exported` OR `CapabilityMissing` (the shipped `enc.simd` core lacks the symbol until rebuilt).

- [ ] **Step 3: Ensure the libjxl fork source is present**

Run: `git -C C:/Foo/rcw-codec-compare submodule update --init external/libjxl-012`
Expected: `external/libjxl-012/` populated. (Or set `LIBJXL_SRC_DIR=C:\Foo\raw-converter-wasm\external\libjxl-012` in Step 4.)

- [ ] **Step 4: Rebuild the enc:simd tier**

Run:
```
cmd /c "call C:\Users\User\emsdk\emsdk_env.bat >nul && set EMSDK_QUIET=1 && set JXL_WASM_ONLY_KIND=enc && set LIBJXL_SRC_DIR=C:\Foo\rcw-codec-compare\external\libjxl-012 && cd /d C:\Foo\rcw-codec-compare && node packages\jxl-wasm\scripts\build.mjs --host-toolchain"
```
Expected: emits `packages/jxl-wasm/dist/jxl-core.enc.simd.{js,wasm}`. If it throws `Size budgets exceeded` at the end, confirm the `.wasm` was still written, then bump the `enc:simd` budget at `packages/jxl-wasm/scripts/build.mjs:52` and re-run.

- [ ] **Step 5: Run the probe to verify it passes**

Run: `node tools/probe-butteraugli16.mjs`
Expected: PASS — `OK butteraugli16: self=0, ...`. If parity `rel` fails, the gamma/param setup diverges from the 8-bit fn — reconcile the copied param block (Task 7 Step 1).

- [ ] **Step 6: Commit**

```bash
cd C:/Foo/rcw-codec-compare
git add tools/probe-butteraugli16.mjs packages/jxl-wasm/dist/jxl-core.enc.simd.js packages/jxl-wasm/dist/jxl-core.enc.simd.wasm packages/jxl-wasm/scripts/build.mjs
git commit -m "test(jxl-wasm): butteraugli16 parity probe; rebuild enc:simd core with the symbol"
```

---

# Phase 4 — L5: figures + gallery + integration

### Task 9: 16-bit RD figures in `codec-paper-figures-full.mjs`

**Files:**
- Modify: `benchmark/codec-paper-figures-full.mjs` (`writeFiguresFull` `:25`; `CAPTIONS` `:90-104`; `writeGalleryFull` `:109`; `PALETTE`/`CODEC_ORDER` `:5-8`)
- Test: `benchmark/test/codec-paper-figures-full-16bit.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `benchmark/test/codec-paper-figures-full-16bit.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFiguresFull } from "../codec-paper-figures-full.mjs";

function sweep16Rows() {
  const rows = [];
  for (const codec of ["jxl", "avif16"]) for (const q of [40, 70, 95]) {
    rows.push({ image: "P1.ORF", class: "raw", codec, runtime: codec === "jxl" ? "wasm" : "native",
      quality: q, bytes: 1000 * (100 - q), bpp: (100 - q) / 10, butteraugli16: (100 - q) / 40, psnr16: 20 + q / 3, ssim16: 0.8 + q / 500 });
  }
  return rows;
}

test("writeFiguresFull emits 16-bit RD figures from sweep16", () => {
  const dir = mkdtempSync(join(tmpdir(), "fig16-"));
  const { files } = writeFiguresFull({
    outDir: dir, sweep: [], timed: [], fixed: [], lossless: [],
    sweep16: sweep16Rows(), corpus: [{ id: "P1.ORF", class: "raw" }],
  });
  for (const f of ["rd-butteraugli-16bit.svg", "rd-psnr-16bit.svg", "rd-ssim-16bit.svg"]) {
    assert.ok(files.includes(f), `missing ${f}`);
    assert.ok(existsSync(join(dir, "figures", f)), `${f} not written`);
    assert.ok(readFileSync(join(dir, "figures", f), "utf8").includes("<svg"), `${f} not svg`);
  }
});

test("writeFiguresFull omits butteraugli-16 figure when metric absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "fig16b-"));
  const rows = sweep16Rows().map(r => { const { butteraugli16, ...rest } = r; return rest; });
  const { files } = writeFiguresFull({ outDir: dir, sweep: [], timed: [], fixed: [], lossless: [], sweep16: rows, corpus: [] });
  assert.ok(!files.includes("rd-butteraugli-16bit.svg"), "butteraugli-16 should be omitted");
  assert.ok(files.includes("rd-psnr-16bit.svg"), "psnr-16 should still render");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test benchmark/test/codec-paper-figures-full-16bit.test.mjs`
Expected: FAIL — `writeFiguresFull` ignores `sweep16`; figures not emitted.

- [ ] **Step 3: Implement the 16-bit figure block**

In `benchmark/codec-paper-figures-full.mjs`:

1. Add `sweep16 = []` to the `writeFiguresFull` destructured params (`:25`).
2. Add the new codec key to `PALETTE`/`CODEC_ORDER` (`:5-8`) so `avif16` and 16-bit `jxl` series get colors (reuse `jxl`/`avif_native` colors; `avif16` distinct).
3. After the class-split block (`:54-57`), add:

```js
  if (sweep16.length) {
    files["rd-psnr-16bit.svg"] = rdCurve({ series: seriesBy(sweep16, "bpp", "psnr16"), xLabel: "bpp", yLabel: "PSNR (dB)", title: "16-bit RD — PSNR (RAW-derived)" });
    files["rd-ssim-16bit.svg"] = rdCurve({ series: seriesBy(sweep16, "bpp", "ssim16", toDb), xLabel: "bpp", yLabel: "SSIM (dB)", title: "16-bit RD — SSIM (RAW-derived)" });
    if (sweep16.some(r => r.butteraugli16 != null)) {
      const bt = sweep16.filter(r => r.butteraugli16 != null);
      files["rd-butteraugli-16bit.svg"] = rdCurve({ series: seriesBy(bt, "bpp", "butteraugli16"), xLabel: "bpp", yLabel: "Butteraugli (lower=better)", title: "16-bit RD — Butteraugli (RAW-derived)" });
    }
  }
```

> Match the EXACT calling convention of the existing `rdCurve`/`seriesBy`/`toDb` usage in this file (`:32-34`) — param names (`series`, `xLabel`, etc.), the `files[...] = ...` accumulation pattern, and how `files` is later turned into the returned `{ files }` array. Copy the 8-bit RD block and adapt keys/metrics.

4. Add `CAPTIONS` entries (`:90-104`) for the three new filenames, e.g.:

```js
  "rd-butteraugli-16bit.svg": "16-bit rate-distortion on RAW-derived high-bit-depth content. Only JXL and AVIF (10/12-bit) participate; JPEG/WebP are 8-bit-only.",
  "rd-psnr-16bit.svg": "16-bit PSNR vs bitrate. Distortion measured at full 16-bit resolution (peak 65535).",
  "rd-ssim-16bit.svg": "16-bit SSIM (dB) vs bitrate on 16-bit luma.",
```

5. In `writeGalleryFull` (`:109`), add a section after the Rate-distortion block (`:122`):

```js
  const rd16 = ["rd-butteraugli-16bit.svg", "rd-psnr-16bit.svg", "rd-ssim-16bit.svg"].filter(f => files.includes(f));
  const rd16Html = rd16.length ? `<h2>16-bit / HDR Rate-Distortion</h2>` + rd16.map(f => figBlock(f)).join("") : "";
```

> Use the same `figBlock`/section helper the existing RD section uses (`:122`). Insert `rd16Html` into the assembled HTML body in section order. If `writeGalleryFull` receives `files` as an array (not object), adapt membership checks accordingly.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test benchmark/test/codec-paper-figures-full-16bit.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the existing figures test to confirm no regression**

Run: `node --test benchmark/test/codec-paper-family.test.mjs benchmark/test/codec-paper-serialize.test.mjs`
Expected: PASS (unchanged).

- [ ] **Step 6: Commit**

```bash
cd C:/Foo/rcw-codec-compare
git add benchmark/codec-paper-figures-full.mjs benchmark/test/codec-paper-figures-full-16bit.test.mjs
git commit -m "feat(codec-paper): 16-bit RD figures (psnr/ssim/butteraugli) + gallery section, butteraugli-16 conditional"
```

---

### Task 10: 16-bit pass in `CodecPaperFullTest.mjs`

**Files:**
- Modify: `CodecPaperFullTest.mjs` (imports `:8-13`; `data` init `:112`; codec loop region `:114-161`; `emitAndDeliver` `:66-99`; TOON `:89`; `CAPABILITY` note `:32-38`)

- [ ] **Step 1: Add imports + data arrays**

In `CodecPaperFullTest.mjs`, extend the imports (`:8-11`):

```js
import { initCodecCompareJxl, loadTargetRgba, loadTarget16, perceptualComparer, butteraugliDistance, butteraugliDistance16, makeJxlAdapter, makeJxlAdapter16 } from "./benchmark/codec-compare-jxl.mjs";
import { ADAPTERS, ADAPTERS16, jxlOrigLossless, jxlOrigDecode } from "./benchmark/codec-adapters.mjs";
import { psnr16, ssim16 } from "./benchmark/metrics16.mjs";
```

Extend `data` (`:112`): `const data = { sweep: [], timed: [], fixed: [], lossless: [], sweep16: [], lossless16: [] };`

- [ ] **Step 2: Run the 16-bit pass per RAW image**

Inside the per-image loop (`:114-161`), **after** the 8-bit lossless pass and **before** `pc.free()` (`:157`), add a RAW-only 16-bit block:

```js
    // ---- 16-bit RD pass (RAW-derived only; genuine >8-bit source) ----
    if (img.class === "raw" && img.srcPath) {
      try {
        const { rgba16, tgtW, tgtH } = await loadTarget16(img.srcPath);
        const npx16 = tgtW * tgtH;
        const jxl16 = makeJxlAdapter16();
        const codecs16 = [{ key: "jxl", runtime: "wasm", ...jxl16 }, ...ADAPTERS16.filter(a => a.key !== "png16")];
        for (const c of codecs16) {
          try {
            for (const q of [40, 60, 80, 95]) {
              const b = await c.encode(rgba16, tgtW, tgtH, q);
              const d = await c.decode(b);
              const bt16 = await butteraugliDistance16(rgba16, d.data, tgtW, tgtH); // null if bridge absent
              data.sweep16.push({ image: img.id, class: "raw", codec: c.key === "jxl" ? "jxl" : c.key, runtime: c.runtime,
                quality: q, bytes: b.length, bpp: b.length * 8 / npx16,
                psnr16: psnr16(rgba16, d.data, tgtW, tgtH), ssim16: ssim16(rgba16, d.data, tgtW, tgtH),
                ...(bt16 != null ? { butteraugli16: bt16 } : {}) });
            }
          } catch (e) { log("codec16 fail", img.id, c.key, e.message); }
        }
        // PNG-16 lossless anchor
        const png16 = ADAPTERS16.find(a => a.key === "png16");
        if (png16) { try {
          const b = await png16.encode(rgba16, tgtW, tgtH);
          const d = await png16.decode(b);
          let e = 0; for (let i = 0; i < rgba16.length; i++) e += Math.abs(rgba16[i] - d.data[i]);
          if (e / rgba16.length < 1) data.lossless16.push({ image: img.id, class: "raw", codec: "png16", runtime: "native", bytes: b.length, bpp: b.length * 8 / npx16 });
          else log("png16 not lossless", img.id, e / rgba16.length);
        } catch (e) { log("png16 fail", img.id, e.message); } }
      } catch (e) { log("16-bit pass fail", img.id, e.message); }
    }
```

> `img.srcPath` must carry the RAW file path. In `loadCorpus` (`:48-51`), add `srcPath: p` to the pushed RAW corpus object so this block can re-decode at 16-bit. (The 8-bit path already loaded `loadTargetRgba(p)`; store `p`.) Confirm the codec-loop var names (`img.id`, `log`) match the file.

- [ ] **Step 3: Thread `sweep16`/`lossless16` into emit + TOON**

In `emitAndDeliver` (`:66-99`): destructure `sweep16, lossless16` (`:67`); pass `sweep16` (and `lossless16` if a lossless-16 bar is added) into `writeFiguresFull` (`:70`). Add TOON counts (`:89`): append `sweep16_rows: ${sweep16.length}\nlossless16_rows: ${lossless16.length}\n`.

- [ ] **Step 4: Add the capability-matrix participation note**

Update the `CAPABILITY` array note or add a caption in the gallery (via `writeGalleryFull`) clarifying that the 16-bit RD figures include JXL + AVIF (+ PNG-16 lossless anchor) only; JPEG/WebP/`jxl_orig` (@jsquash) are 8-bit-only. Minimal: extend the `corpusInfo` string passed to `writeGalleryFull` (`:86`) with `; 16-bit RD: RAW-derived only, JXL+AVIF+PNG-16`.

- [ ] **Step 5: Smoke-run (LIMIT=1)**

Run: `powershell -Command "$env:LIMIT=1; node CodecPaperFullTest.mjs"`
Expected: completes one image; console shows the 16-bit pass; `docs/outputs/codec-paper-full/figures/rd-psnr-16bit.svg` + `rd-ssim-16bit.svg` exist (and `rd-butteraugli-16bit.svg` if the bridge is present); gallery has the "16-bit / HDR Rate-Distortion" section; delivery to Jose logs success. (Use a corpus with at least one RAW file; if `LIMIT=1` selects a Kodak image, bump to `LIMIT` covering a RAW file or temporarily reorder `loadCorpus` to load RAW first.)

- [ ] **Step 6: Verify the additive-fallback criterion**

Temporarily rename the rebuilt core so the bridge symbol is absent (simulates a slipped rebuild):
Run: `powershell -Command "Rename-Item packages/jxl-wasm/dist/jxl-core.enc.simd.wasm _bak.wasm; $env:LIMIT=1; node CodecPaperFullTest.mjs; Rename-Item packages/jxl-wasm/dist/_bak.wasm jxl-core.enc.simd.wasm"`
Expected: run still completes; `rd-psnr-16bit.svg` + `rd-ssim-16bit.svg` still emitted; `rd-butteraugli-16bit.svg` absent; a "16-bit butteraugli capability absent" log line. (This proves the deliverable is not blocked on the bridge. If renaming the wasm breaks the whole facade load, instead force the capability off by temporarily stubbing `facade.computeButteraugli16` — the point is only to exercise the null-metric path.)

- [ ] **Step 7: Commit**

```bash
cd C:/Foo/rcw-codec-compare
git add CodecPaperFullTest.mjs
git commit -m "feat(codec-paper): 16-bit RD pass in full suite (sweep16/lossless16, additive butteraugli16, PNG-16 anchor)"
```

---

# Phase 5 — L6: HDR follow-up documentation

### Task 11: Document the true-HDR follow-up (Part 3c)

**Files:**
- Create: `docs/outputs/codec-paper-full/HDR-followup.md`

- [ ] **Step 1: Write the follow-up note**

Create `docs/outputs/codec-paper-full/HDR-followup.md`:

```markdown
# Part 3c — True HDR (PQ/HLG, Rec.2020) follow-up

The 16-bit path (2026-07-05) covers **16-bit SDR** from RAW-derived content. True HDR is deferred
pending three pieces, none of which the current harness has:

1. **HDR corpus.** Need PQ or HLG, Rec.2020, >SDR-dynamic-range source frames. RAW gives bit depth
   but the display render is SDR-referred. Options: capture/curate an HDR test set, or add an
   HDR-referred tone path (`process_16bit` variant that targets PQ/HLG instead of the SDR tone curve).

2. **Float substrate (already present).** The facade supports `rgbaf32` encode+decode; the RAW
   pipeline can emit f32 (`decode_exr` / a `process_f32` variant). So the *plumbing* for HDR pixels
   exists — only the source content and metric are missing.

3. **HDR-aware metric.** Butteraugli assumes an SDR display transfer. For HDR, either PU21-encode
   before Butteraugli, or tone-map to SDR first, or add an `rgbaf32` Butteraugli bridge with a PQ/HLG
   linearize. PSNR/SSIM must move to the PQ/HLG-encoded (or PU) domain to be meaningful.

When a corpus exists, mirror the 16-bit pass: `loadTargetHdr` (f32 RGBA) → `rgbaf32` JXL/AVIF-10/12
adapters → PU21/PQ metric → `sweepHdr` array → `rd-*-hdr.svg` + a gallery section. The 16-bit path
(`sweep16`, `metrics16.mjs`, the figure block) is the template.
```

- [ ] **Step 2: Commit**

```bash
cd C:/Foo/rcw-codec-compare
git add docs/outputs/codec-paper-full/HDR-followup.md
git commit -m "docs(codec-paper): true-HDR (PQ/HLG) follow-up note (Part 3c)"
```

---

## Final verification

- [ ] Run the full 16-bit test suite: `node --test benchmark/test/metrics16.test.mjs benchmark/test/adapters16.test.mjs benchmark/test/codec-paper-figures-full-16bit.test.mjs` → all PASS.
- [ ] Run both probes: `node tools/probe-16bit-disp.mjs` and `node tools/probe-butteraugli16.mjs` → both OK.
- [ ] Run the RAW-pipeline tests: `cargo test -p raw-pipeline 2>&1 | tail -20` → PASS.
- [ ] `LIMIT` smoke of the full suite delivers the 16-bit figures to Jose (`C:\Foo\Jose\Submissions\JXL\Comparison with other formats\full\figures\`).
- [ ] Confirm the 8-bit figures are byte-identical to a pre-change run (the 16-bit pass is additive) — spot-check `rd-butteraugli.svg` still generated and unchanged in structure.

## Success criteria mapping (from spec)

| Criterion | Task |
|-----------|------|
| 1. RGBA16 export reachable from Node | Task 2 + Task 3 (probe) |
| 2. `process_16bit>>8 ≈ 8-bit` | Task 3 (probe consistency assert) |
| 3. JXL rgba16 round-trip | Task 5 (test) |
| 4. AVIF-10/12 + PNG-16 round-trip (identity guard) | Task 6 (test) |
| 5. `compare16(x,x)==0`, promoted ≈ 8-bit | Task 8 (probe) |
| 6. PSNR-16/SSIM-16 resolve >8-bit diffs | Task 4 (test) |
| 7. Full run emits 16-bit figures + delivers; PSNR/SSIM survive bridge absence | Task 10 (smoke + additive-fallback) |
| 8. 8-bit figures + suite unchanged | Task 9 Step 5 + Final verification |
