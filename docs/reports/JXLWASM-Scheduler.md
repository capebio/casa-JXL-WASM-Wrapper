# JXLWASM-Scheduler Implementation Plan & Lifecycle Playbook

**Date:** Tuesday, 9 June 2026
**Path:** `JXLWASM-Scheduler.md` (Workspace Root)
**Status:** Under Active Execution
**Verification Baseline:** 100% Green Unit Tests (`packages/jxl-scheduler`)

---

## 🧭 Executive Summary & Overview

This document consolidates the complete implementation and verification strategy for **`packages/jxl-wasm`** (WASM Engine Hardening) and **`packages/jxl-scheduler`** (Scheduler Concurrency & Lifecycle Isolation). It bridges the gap between completed low-level optimizations and the high-performance execution runtime required for high-volume library processing and low-latency interactive rendering.

---

## 🏆 Part 1 — WASM Engine Hardening (Pillar 2)
All six major items from the WASM hardening scope have been fully implemented in source and structurally verified.

### 1. (A1) $O(n^2)$ Input Stream Accumulation — Landed & Verified
* **Symptom:** Exact-grow reallocation of `s->input_buf` on streaming pushes triggered a full `memmove` of accumulated bytes on every chunk, leading to quadratic time complexity.
* **Cure:** Integrated geometric growth (capacity doubling with a 64 KiB minimum base and strict integer overflow checks) within `jxl_wasm_dec_push` (`bridge.cpp:2067`).
* **Optimization Note:** Rejection of the consume-as-you-go ring buffer has been formally documented in `docs/rejected optimizations.md`. Ring-buffer strategies present high regression risks to exact progressive check-point invariants required by client-side streaming tests.

### 2. (A2) Errored Sidecar Buffer Chaining Prevention — Landed
* **Symptom:** `bridge.cpp` linked `MakeError` buffers (where `error != 0`) into the pyramid chain instead of discarding them, causing client-side JS pipelines to crash on the entire container.
* **Cure:** Enforced explicit `if (sidecar == nullptr || sidecar->error != 0) continue;` checks in `EncodeRgba8WithSidecars`. Errored `full` frames are symmetrically checked and cleanly rejected, preserving error codes and preventing corrupted pointers.

### 3. (A3) Fixed-Point Native Seam Blending — Landed & Verified
* **Symptom:** Boundary seams between neighboring JXTC tile region crops were visible because the pipeline relied on simple last-write-wins memcpy, leaving pixel boundaries un-blended. Furthermore, the source buffer initialization used `malloc` instead of `calloc`, risking raw memory propagation.
* **Cure:** In `DecodeRgba8TileContainerRegion` (`bridge.cpp:1722`), initialized buffers with `calloc`. Added a 1px seam-blending pass using fast, non-order-dependent Q8 fixed-point integer math:
  $$\text{Blended Pixel} = \frac{(l \times 179 + r \times 77 + 128)}{256}$$
  This avoids heavy floating-point operations and allows optimal SIMD hardware vectorization.

### 4. (A4) Zero-Copy `takeBufferView` Materialization — Landed & Verified
* **Symptom:** Hot paths like `enc_take_chunk` suffered from heavy memory-copying taxes due to `HEAPU8.slice` copies.
* **Cure:** Implemented `takeBufferView` inside `facade.ts`, returning a direct zero-copy `subarray` of `HEAPU8` with strict "same-tick read-only" lifetime assertions. Combined with the C++ side's use of `MakeBufferBorrowed`, this eliminates all intermediate JS copying operations.

### 5. (A5) Bilinear Resize Weight Hoisting — Landed & Verified
* **Symptom:** Weight math was redundantly recalculated inside inner pixel channel loops, paired with dead big-endian DataView logic.
* **Cure:** Hoisted weights (such as `w00 = (1 - xt) * (1 - yt)`) out of the inner loop in `bilinearResize`. Unreachable big-endian `DataView` branches were stripped, saving up to 12 multiplications per pixel. All bilinear stretch/contain test assertions are passing green.

### 6. (A6) WASM64 Structural Alignment — Landed
* **Symptom:** Interleaving native `size_t` with explicit `uint32` fields introduced extreme padding drift when shifting compilation flags toward `MEMORY64`.
* **Cure:** Explicitly hardcoded `uint32` fields in `JxlWasmBuffer` and injected compile-time static assertions (`static_assert(sizeof(size_t) == 4)`). Added the `jxl_wasm_pointer_size()` export paired with load-time runtime alignment assertions in `facade.ts` (`assertA6WordSize`).

---

## 🛡️ Part 2 — Landed Scheduler Concurrency Milestones

### 1. (sched-3) Dedupe Primary-Cancel Subscriber Orphans — Landed & Verified 100% Green
* **The Problem:** Cancelling a primary session left its deduplicated fan-out subscribers hanging in limbo. Terminal cancellation/error messages were sent under the primary's ID, which subscribers ignored.
* **The Cure:** 
  1. Updated `handleWorkerMessage` in `packages/jxl-scheduler/src/scheduler.ts` to clone and re-stamp incoming worker messages with each subscriber's unique session ID:
     ```typescript
     this.dedupe.forEachSubscriber(sessionId, (subId) => {
       if (subId === sessionId) return;
       const stampedMsg = { ...msg, sessionId: subId };
       for (const h of subHandlers) h(stampedMsg);
     });
     ```
  2. Verified that when a primary session is cancelled, all surviving subscribers receive their re-stamped terminal messages and complete or resubmit cleanly.
* **Test Verification:** `primary cancel with 2 surviving subscribers: subs complete without hanging` is now passing 100% green.

### 2. (P2a/P2b) Parked Worker Lifecycle State Isolation — Landed & Verified
* **The Problem:** Workers holding paused decoders were returned directly to the shared `idle` pool. This exposed them to being hijacked by concurrent `acquire()` calls or reaped by the 5-second `reapIdle` garbage collector, destroying dormant heap states.
* **The Cure:** 
  1. Formulated an explicit, decoupled `parked` state within the `WorkerPool`.
  2. Removed parked workers from the `this.idle` set, guaranteeing they cannot be selected by `tryAcquireIdle()` or killed by `reapIdle()`.
  3. Integrated verification invariants inside `assertInvariants()` to guarantee parked workers never pollute active or idle lists.

---

## 🚀 Part 3 — Pending Scheduler Concurrency Tasks (The Path to Phase 5)

The remaining items to fully satisfy Scheduler Concurrency are focused on **Core Oversubscription Control (`sched-1`)** and **CLI Worker Pool integration**.

```
                       ┌─────────────────────────┐
                       │   Scheduler Interface   │
                       └────────────┬────────────┘
                                    │ Acquire Slot
                                    ▼
                      ┌───────────────────────────┐
                      │   CoreBudget Semaphore    │
                      │ (hwConcurrency Tokens)    │
                      └─────────────┬─────────────┘
                                    │
                         Budget     │     Sufficient
                       Exceeded     ▼       Tokens
                      ┌─────────────┴─────────────┐
                      │ Single-Thread SIMD Tier   │◄─── (CLI Batch Ingest /
                      │                           │     High-Concurrency)
                      └─────────────┬─────────────┘
                                    │
                                    ▼
                      ┌───────────────────────────┐
                      │  Multi-Thread SIMD-MT     │◄─── (UI Lightbox / Low-
                      │                           │     Latency Focus)
                      └───────────────────────────┘
```

### 1. Implementation Plan: Core Oversubscription Control (`sched-1`)
* **Objective:** Prevent CPU thrashing when multiple worker threads execute multi-threaded WASM (`relaxed-simd-mt`) simultaneously.
* **Mechanism:**
  1. **Global Core Semaphore:** Implement a `CoreBudget` class in `packages/jxl-scheduler/src/budget.ts` initialized with `navigator.hardwareConcurrency`.
  2. **Token Allocation Rule:** 
     * A worker running single-threaded (`simd` or `scalar`) consumes exactly **1 token**.
     * A worker running multi-threaded (`relaxed-simd-mt` or `simd-mt`) consumes up to **$N$ tokens** (where $N = \text{hardwareConcurrency}$).
  3. **Thread Limitation:** If the available tokens are less than $N$, incoming multi-threaded jobs must either wait for sufficient token release or **fall back dynamically to single-threaded executions** (e.g., set the encoder thread parameter to 1 via start messages).

### 2. Implementation Plan: CLI Worker Pool Safe Threading (`WU-8`)
* **Rule:** CLI background ingest pools (`packages/pyramid-ingest`) must force **single-threaded `simd` workers** (or invoke `--encoder-threads 1`).
* **Verification:** Ensure that if $W$ ingest workers are active, the system load is exactly $W$ cores, achieving linear scaling with 0% context-switching overhead.

---

## 🧪 Part 4 — Verification Matrix & Test Strategy

| Target Feature | Test Path | Verification Criteria | Status |
| :--- | :--- | :--- | :--- |
| **Input Accumulation (A1)** | `test/progressive-detail.test.ts` | Releases previous input, zero extra allocations | **PASS** |
| **Error Chaining (A2)** | `test/sidecars.test.ts` | Discards errored sidecars, keeps full pipeline green | **PASS** |
| **Seam Blending (A3)** | `test/seams.test.ts` | Pixel-perfect edge matching at tile boundaries | **PASS** |
| **Zero-Copy subarray (A4)** | `test/facade.test.ts` | `takeBufferView` returns subarray, original memory stable | **PASS** |
| **Subscriber Promotion (sched-3)** | `test/scheduler.dedupe.test.ts` | Surviving subscribers complete without hanging on cancel | **PASS** |
| **State Isolation (P2a/P2b)** | `test/scheduler.preemption.test.ts` | Reaper does not evict or destroy parked/paused decoders | **PASS** |
| **Budget Enforcement (sched-1)**| `test/scheduler.budget.test.ts` | Active worker thread counts remain bounded to CPU count | **Pending** |

---

## 🏁 Execution Directives for Agents

When implementing the final `sched-1` and `WU-8` pieces, adhere strictly to these constraints:
1. **No TS Hacks:** Do not suppress compiler type warnings. Keep strict typing intact.
2. **Deterministic Locking:** Keep the global budget semaphore non-blocking for visible tasks—use FIFO queueing to ensure predictable task scheduling.
3. **No Code regression:** The Sneyers progressive-streaming multi-pass tests must remain 100% green. Preserve the C++ comments marked `DONOTCHANGE`.
