# EpicCodeReview — 2026-05-15

Branch: `epiccodereview/20260513T054007Z`
Scope: `src/` (Rust WASM) + `web/` (JS workers + UI panels)
Mode: workalone (manual multi-agent dispatch)

---

## Summary

13 confirmed bugs fixed across 4 files in 3 commits. 7 items deferred to
`QUESTIONS.md` (require user input or involve in-progress stash). No regressions
introduced; all changes verified against test suite where applicable.

---

## Fixes Applied

### Fix 1 — GPS hemisphere always blank (`src/tiff.rs`) · CRITICAL

**Root cause:** `IfdEntry::as_ascii()` for TIFF inline ASCII (count ≤ 4) returned
an empty string. TIFF stores the ASCII bytes directly in the 4-byte `value_off`
field when `count ≤ 4`; the code was jumping to the pointer path and reading from
a near-zero file offset, returning garbage or empty.

**Impact:** Every GPS latitude/longitude reference ("N", "S", "E", "W") tag was
blank. All GPS coordinates were stored as positive floats regardless of hemisphere,
placing South/West shots in the North/East hemisphere mirror position.

**Fix:** Decode inline ASCII from `value_off.to_le_bytes()` / `to_be_bytes()` when
`count ≤ 4`, with NUL / whitespace trim.

---

### Fix 2 — wasm32 arithmetic overflow in MakerNote parsing (`src/tiff.rs`) · HIGH

**Root cause:** Several places in `parse_olympus_makernote`,
`parse_equipment_subifd`, `parse_camera_settings_subifd`, and
`parse_image_processing_subifd` used `base_off + val as usize`. On wasm32,
`usize` is 32-bit; a large `val` wraps the addition into a plausible small address,
causing silent reads from wrong file positions.

**Fix:** Replaced all such additions with `base_off.saturating_add(val as usize)`.
Saturated overflow returns `usize::MAX`, which the downstream `Reader::slice()`
rejects with an error rather than silently misreading.

---

### Fix 3 — Unbounded MakerNote sub-IFD entry count (`src/tiff.rs`) · HIGH

**Root cause:** `parse_olympus_makernote` and the three sub-IFD parsers read an
entry count directly from the file with no upper bound. A corrupt or crafted ORF
could declare 65 535 entries, causing the worker to spin allocating and reading for
hundreds of milliseconds before the file bounds check eventually fires.

**Fix:** Added `.min(512)` cap on all four sub-IFD entry count reads, consistent
with the existing `read_ifd` limit.

---

### Fix 4 — `apply_look` silently zeroes output on invalid WB (`src/lib.rs`) · HIGH

**Root cause:** `apply_look()` unconditionally assigned `wb_r` and `wb_b` from JS
arguments with no validation. A `NaN` or `0.0` from a buggy caller produced
all-black output with no error signal.

**Fix:** Added `is_finite() && > 0.0` guards matching the guards already present in
`process_orf()`.

---

### Fix 5 — WB override upper bound missing (`src/lib.rs`) · MEDIUM

**Root cause:** `process_orf()` validated that WB overrides are finite and > 0, but
did not cap the upper bound. An extreme value (e.g. `wb_r = 1000`) passed from a
buggy slider would blow out the red channel completely.

**Fix:** Added `.min(8.0)` clamp on both `wb_r_override` and `wb_b_override` before
assignment to `params`.

---

### Fix 6 — `downscale_rgb` panics on zero-dimension src (`src/lib.rs`) · MEDIUM

**Root cause:** No guard against `src_w == 0 || src_h == 0`. The subsequent integer
division `h / src_h` would panic (division by zero) in debug builds and produce
undefined results in release builds.

**Fix:** Added explicit early return with `JsError` when either source dimension is
zero.

---

### Fix 7 — JXL OOM at minimum effort leaves worker dead (`web/jxl-worker.js`) · HIGH

**Root cause:** The OOM cascade stepped effort 7→6→5 and reinitialised the module
between retries. But if effort 5 also aborted (image truly too large), the module
was left in the aborted state without reinitialisation. All subsequent encodes on
that worker silently produced `encode_error` forever.

**Fix:** Added an `else if (isAbortError(encErr))` branch that reinitialises the
module before throwing a human-readable error, ensuring the worker is operational
for the next task.

---

### Fix 8 — axisSwap mismatch between JS and Rust (`web/worker.js`) · MEDIUM

**Root cause:** `makeLiveState()` computed `axisSwap = orientation >= 5 && <= 8`,
but `apply_orientation` in `pipeline.rs` only swaps width/height for orientations
6 (90° CW) and 8 (90° CCW). Orientations 5 and 7 are pass-through in Rust.
This caused the lightbox canvas to be sized with swapped dimensions for
orientations 5 and 7, producing a squashed display.

**Fix:** Changed to `orientation === 6 || orientation === 8`.

---

### Fix 9 — liveState memory leak on pipeline error (`web/worker.js`) · MEDIUM

**Root cause:** If `process_orf()` succeeded but a later step (e.g. `rgb_to_rgba`,
`rotate_rgb8`) threw, the `catch` block posted `type:'error'` but did not clean up
`liveStateMap` / `thumbStateMap`. The large rgb16 buffers (~8 MB each) stayed
resident for the lifetime of the worker.

**Fix:** Added `liveStateMap.delete(id)` and `thumbStateMap.delete(id)` in the
catch block.

---

### Fix 10 — Grain toggle leaves stale pending image load (`web/panels.js`) · LOW

**Root cause:** `toggleGrain(off)` hid the canvas but did not cancel an in-flight
`_grainImgPending` image load. When that load completed, it drew to the now-hidden
canvas and left `_grainImgPending` non-null, causing the next toggle-on to
immediately nullify the new load without drawing.

**Fix:** Added `_grainImgPending.onload = null; _grainImgPending = null;` in the
toggle-off branch (mirrors the identical guard already in `drawGrain`).

---

### Fix 11 — localStorage key unbounded length (`web/panels.js`) · LOW

**Root cause:** `getSidecarKey(filename)` used the full filename as the key suffix.
Extremely long paths could produce keys that exceed browser localStorage limits.

**Fix:** `filename.slice(0, 255)` cap on the key portion.

---

### Fix 12 — localStorage writes throw on quota exceeded (`web/panels.js`) · MEDIUM

**Root cause:** `saveSidecar` and `saveUserProfiles` called `localStorage.setItem`
without try/catch. `setItem` throws `QuotaExceededError` when storage is full;
the unhandled exception surfaced as an opaque error in the UI with no recovery.

**Fix:** Wrapped both calls in try/catch with `console.error` logging.

---

### Fix 13 — Profile look values not clamped on save (`web/panels.js`) · LOW

**Root cause:** `saveCurrentAsProfile` stored raw `currentLook()` values without
validation. Out-of-range values (e.g. `exposureEv: 99`) would persist in profiles
and drive pipeline parameters far beyond their intended range on reload.

**Fix:** Applied `clampLook(k, v)` (already defined in panels.js) to all
`LOOK_PARAMS` fields before writing the profile entry.

---

## Deferred Items

See `QUESTIONS.md` for 7 items requiring user input:

| # | Topic | Severity |
|---|-------|----------|
| Q1 | OM SYSTEM MakerNote offset (+14 vs +16) | HIGH |
| Q2 | wasm-bindgen Vec<u8> slice guarantee | LOW |
| Q3 | Vertical-pass blur cache thrash refactor | MEDIUM |
| Q4 | Pre-LUT size (65536 vs 4096) | LOW |
| Q5 | Histogram compute throttle/downsample | MEDIUM |
| Q6 | liveStateMap orphan leak (requires main.js) | MEDIUM |
| Q7 | strip_offset bounds validation | MEDIUM |

---

## Files Changed

| File | Fixes |
|------|-------|
| `src/tiff.rs` | 1, 2, 3 |
| `src/lib.rs` | 4, 5, 6 |
| `web/jxl-worker.js` | 7 |
| `web/worker.js` | 8, 9 |
| `web/panels.js` | 10, 11, 12, 13 |

---

## Build Note

`src/tiff.rs` and `src/lib.rs` were modified. Regenerate the WASM package before
deploying:

```
wasm-pack build --target web
```

The `pkg/` directory currently contains the pre-review build and is stale.

---

*Generated by EpicCodeReview — 2026-05-15*
