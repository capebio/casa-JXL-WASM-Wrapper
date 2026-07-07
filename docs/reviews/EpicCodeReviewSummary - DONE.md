# EpicCodeReview Summary

This document provides an overview of the achievements and findings from the EpicCodeReview process completed on 2026-05-15.

## Overview
A total of **13 bugs** were identified and fixed across the Rust (WASM) and JavaScript (Web Workers/UI) codebases. Additionally, **7 items** were deferred for further investigation or user input.

## Serious Issues Found
There were **5 serious issues** (1 Critical, 4 High) identified and resolved:

### 1. GPS Hemisphere Data Loss (Critical)
- **File:** `src/tiff.rs`
- **Description:** GPS latitude/longitude reference tags ("N", "S", "E", "W") were consistently blank due to an error in decoding inline TIFF ASCII data (count ≤ 4). This resulted in all GPS coordinates being stored in the North/East hemisphere, incorrectly mirroring South/West locations.

### 2. WASM32 Arithmetic Overflow (High)
- **File:** `src/tiff.rs`
- **Description:** MakerNote parsing logic used `usize` for offset calculations. On the 32-bit WASM platform, large values could wrap around, causing silent reads from incorrect file positions. This was fixed by implementing saturating addition.

### 3. Unbounded MakerNote Entry Count (High)
- **File:** `src/tiff.rs`
- **Description:** Sub-IFD parsers lacked an upper bound on entry counts. A corrupt or malicious file could specify an extremely high count, causing the worker to hang or consume excessive resources. A cap of 512 entries was applied.

### 4. Invalid White Balance Handling (High)
- **File:** `src/lib.rs`
- **Description:** `apply_look()` lacked validation for white balance arguments. Passing `NaN` or `0.0` resulted in an all-black output without any error notification. Guards were added to ensure values are finite and positive.

### 5. JXL Worker OOM Recovery (High)
- **File:** `web/jxl-worker.js`
- **Description:** If a JPEG XL encoding task failed due to Out-Of-Memory (OOM) at the minimum effort level, the worker module was left in an aborted state, rendering it useless for all subsequent tasks. The fix ensures the module is reinitialized after such failures.

## Other Findings
- **Medium Severity (6):** Issues included coordinate mismatches between JS and Rust, memory leaks on pipeline errors, and missing error handling for `localStorage` quotas.
- **Low Severity (3):** Minor issues such as stale image loads during UI toggles and lack of clamping for saved profile values.
- **Deferred Items (7):** Currently tracked in `QUESTIONS.md`, including a High-priority investigation into OM SYSTEM MakerNote offsets.

## Summary of Changes
| Component | Files Modified | Fixes Applied |
|-----------|----------------|---------------|
| **Rust (WASM Core)** | `src/tiff.rs`, `src/lib.rs` | 6 |
| **JavaScript (Web)** | `web/jxl-worker.js`, `web/worker.js`, `web/panels.js` | 7 |

*Note: A fresh WASM build (`wasm-pack build --target web`) is required to apply the fixes in the core library.*
