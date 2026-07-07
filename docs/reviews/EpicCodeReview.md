# EpicCodeReview — JXL core decode chain

**Run:** `epiccodereview/20260617T202430Z`  **Mode:** modelswitching  **Dates:** 2026-06-17 → 2026-06-18
**Scope:** the 6 packages of the live JXL decode/encode pipeline —
`jxl-core, jxl-scheduler, jxl-worker-browser, jxl-session, jxl-stream, jxl-wasm`.

> A separate concurrent EpicCodeReview run handled the Rust side (raw-pipeline / cr2.rs /
> perceptual) on the same branch — see its commits (`harden raw-pipeline parsers`,
> `harden perceptual SIMD metrics`) and the corresponding QUESTIONS.md sections (000 / cr2).

## Headline

**97 confirmed fixes applied across 6 packages, 0 regressions.** Every package with a runnable
suite stayed green (scheduler 40/40, worker-browser 29/29, session 45/45, stream 40/40); the two
no-behavioral-test packages (jxl-core, jxl-wasm) were typecheck-gated. 22 ADR drafts and a
structured backlog of cross-package / unbuildable-C++ work were written to QUESTIONS.md.

| Section | Files | Candidates | Confirmed → fixed | Tests | ADRs |
|---|---|---|---|---|---|
| jxl-core | 4 | 47 | 1 | tsc clean | 4 |
| jxl-scheduler | 15 | 68 | 23 | 40/40 | 4 |
| jxl-worker-browser | 11 | 50 | 24 | 29/29 | 4 |
| jxl-session | 17 | 41 | 21 | 45/45 | 3 |
| jxl-stream | 5 | 41 | 23 | 40/40 | 3 |
| jxl-wasm | facade.ts+bridge.cpp | 51 | 5 | tsc clean | 4 |
| **Total** | | **298** | **97** | **all green** | **22** |

## Most impactful fixes

- **jxl-stream — both long-standing P0s closed:** the HTTP-Range resume-start offset bug (wrong
  cursor on non-zero-based resume / past-EOF 416) and the **If-Range mixed-version data corruption**
  (a changed resource could splice new bytes onto the old prefix) — now version-pinned with a hard
  fail on any 200-during-resume.
- **jxl-scheduler — concurrency-brain hardening:** bounded 3 unbounded leak sets/maps, fixed a
  caller-hang when `cancelSession` hit `queue.remove()==false`, identity-based preempt-ack removal,
  O(n²)→O(n) budget drain — all behind the green preemption/dedupe/budget suite.
- **jxl-worker-browser — metric & lifecycle correctness:** post-terminal encode metrics now emitted
  before `encode_done` (scheduler was dropping them), WASM-load timeout (a hung import no longer
  stalls every start), and two HIGH stale-start races closed via per-start epoch tokens.
- **jxl-session — closes cross-package debt + a real leak:** forwards the 9 DecodeFrameMeta fields
  and the progressiveFlavor/Ac/qAc encode options (deferred from jxl-core), and fixes a worker-slot +
  handler leak on header-only / single-pass early-finish.
- **jxl-wasm — safety within the toolchain limit:** type-clean baseline (added `onMetric`) + 4 OOM
  malloc guards; the substantive ABI + C++ memory-safety findings are documented for a real build.

## What was deliberately NOT auto-fixed (see QUESTIONS.md)

- **Cross-package contract debt** (jxl-core ↔ session ↔ worker): the remaining ~12 EncodeOptions
  with no wire field, worker error codes not in `JxlErrorCode`, `MsgWorkerError` sessionId routing —
  these need atomic multi-package changes; the local halves were landed, the rest grouped for a
  coordinated change. Several have ADRs (encode-options mapper, protocol version, runtime validation).
- **jxl-wasm bridge.cpp (C++):** the WASM build is Docker/emsdk-gated and could not be compiled or
  tested here, so all C++ memory-safety findings — incl. a **HIGH JXTC-encode integer overflow
  (heap overflow)** and the facade↔bridge **ABI arg-shift** — are documented with file:line +
  severity for the user to apply with a real build. Auto-editing unverifiable FFI/heap code was
  judged too risky.
- **jxl-stream browser/node abort-contract divergence** (reject vs resolve) — a public-API decision.
- Low-severity / speculative items and verifier-uncertain findings, recorded for completeness.

## Process notes

- Each section: 6 finders → verify (CLAUDE.md-aware, rejected-claims filtered) → plan → fix → progress
  review → commit. False-positive rate was high and correctly filtered (the rejected-optimizations
  log and layer invariants caught many wrong-layer / already-rejected proposals).
- Build artifacts (`dist-test/`) in the raw collection were excluded; only real `src/` + `test/` reviewed.
- CodeQL was skipped (not invoked in this environment); findings rest on the Claude finders + verifiers.
- Full audit trail, per-section reports, fix logs, and ADR drafts: `.epiccodereview/20260617T202430Z/`.
