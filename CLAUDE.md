# CLAUDE.md — CasaWASM JXL & RAW Converter

## Architecture: Layer Map

```
UI / main.js
  └─ jxl-stream        (ingestion: ReadableStream / fetch → push interface)
  └─ jxl-session       (API: hides workers/scheduler; emits AsyncEventStream of frames)
       └─ jxl-scheduler    (intelligence: preemption, dedup, backpressure, pool)
            └─ jxl-worker-browser / jxl-worker-node
                 └─ decode-handler / encode-handler
                      └─ jxl-wasm/facade.ts   (FFI: WASM heap management)
                           └─ bridge.cpp / libjxl
jxl-cache              (persistence: OPFS/fs; sits beside the pipeline, not in it)
src/lib.rs             (RAW pipeline: ORF/DNG → RGB8/16 pixel buffer)
```

## Key Files

| File | Role |
|------|------|
| `src/lib.rs` | WASM entry: `process_orf`, `process_dng`, `LookRenderer`, `downscale_rgba` |
| `packages/jxl-scheduler/src/scheduler.ts` | Preemption, fan-out dedupe, adaptive HWM backpressure |
| `packages/jxl-scheduler/src/pool.ts` | Worker lifecycle, prewarm, idle reap |
| `packages/jxl-worker-browser/src/decode-handler.ts` | libjxl session state machine, EMA drain, budget |
| `packages/jxl-worker-browser/src/worker.ts` | Message routing, cold-start buffering, shutdown |
| `packages/jxl-wasm/src/facade.ts` | WASM heap alloc, zero-copy writes, capability cache |
| `packages/jxl-wasm/src/bridge.cpp` | C++ FFI; grow-only realloc buffers |
| `packages/jxl-session/src/decode-session.ts` | Public DecodeSession: acquire slot, push chunks, emit frames |
| `packages/jxl-stream/src/browser.ts` | fromReadableStream / fromResponse; one-ahead I/O prefetch |
| `packages/jxl-cache/src/browser.ts` | OPFS + LRU; content-agnostic |

Optimization scores: scheduler/decode-handler/facade/cache/stream/lib.rs/protocol = **5/5**; decode-session = **4/5**; web/main.js + web/jxl-progressive-\*.js = **5/5**.

## Layer Invariants — What Belongs Where

**Backpressure** lives at the scheduler/worker boundary (`waitForDrain`, adaptive HWM in decode-handler). Never add drain callbacks or backpressure inside the facade or session.

**Deduplication** lives in `scheduler.ts` (`DedupeRegistry`). The cache must never duplicate entries by sourceKey — it is content-agnostic.

**Budget** is session-level elapsed time from construction (`stageStartMs` in constructor). It is not per-stage. Do not add per-stage resets.

**Preemption** is scheduler-only. Workers use pause/resume (`decode_pause` → `decode_paused` ack → `decode_resume`). There is no soft-yield protocol — `decoder.push()` runs WASM synchronously to completion and cannot be interrupted mid-push. Hard cancel is already "soft" between chunks.

**Format validation** belongs to libjxl (via the `"error"` decode event). The cache and stream layers must not add magic-byte checks.

**Session protocol** knowledge (event types, handler lifecycle) must not leak into jxl-cache or jxl-stream.

## Critical Behavioral Contracts

- `decode_budget_exceeded`: frame stream ends **gracefully** (`frameStream.end()`) so consumers receive the partial frame; `done()` rejects with `BudgetExceeded`. This is `finishWithError()`, distinct from `fail()` which fails the stream immediately.
- `scheduler.onMessage(sessionId, handler)` returns **`void`** — no unsubscribe function.
- `scheduler.send()` is **fire-and-forget** — does not throw on dead sessions.
- `decoder.push()` (WASM) is **synchronous** — cannot yield mid-push.
- `postMessage(msg, [pixels])` **detaches** the ArrayBuffer — it cannot be recycled into a pool.
- Workers are **stateless** between sessions — caching WASM decoder state across session lifetimes would break `recycle()`.
- `SharedArrayBuffer` requires COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`).

## Recurring False Claims — Reject on Sight

These have been proposed and rejected multiple times:

| Claim | Reason |
|-------|--------|
| "Add pixel buffer pool for output" | Transferred ArrayBuffers detach. No safe `release()` lifecycle. (R1-2, R2-2, DH-2) |
| "Add drain callback / onDrain on JxlDecoder" | Wrong layer. Backpressure is scheduler/worker boundary. (R1-1, R2-3) |
| "Add batch logic in session/facade" | Wrong layer. Batching belongs in scheduler. (R1-4) |
| "Dedupe-aware caching / store under sourceKey" | Wrong layer. Doubles storage accounting. (G2-1) |
| "Cache-aware DecodeSession wrapper" | Event-driven sessions cannot be faked from a static buffer. (G2-7) |
| "Soft preemption via yield message" | WASM is synchronous mid-push; hard cancel is already soft between chunks. |
| "Global memory pressure eviction" | `performance.memorypressure` is not a standard Web API. (G2-2) |
| "Per-stage budget reset" | Silently changes semantics to `budgetMs × N_stages`. (DH-5, DH6-5) |
| "Worker-side createImageBitmap" | Invalid MIME `image/x-rgba8`; breaks 16-bit/float; DOM in worker. (R4-2) |
| "Retry loop in writePersistentFile" | Duplicates existing QuotaExceededError handling. (G2-6) |
| "compactQueue threshold < 64" | Increases array churn. `copyWithin` no-alloc compaction already used. (DH-4) |
| "Pre-allocate chunk queue with new Array(N)" | Creates sparse array — length guard fires on empty queue. (R12-5) |

Full rejection log: `docs/rejected optimizations.md` and `docs/rejected optimizations_backup.md`.

## Build Notes

Rebuilding WASM (`libjxl` bridge) requires:
- `clang`, `lld`, `cmake`, `build-essential`, `pkg-config`
- `rustup target add wasm32-unknown-unknown`
- `wasm-bindgen-cli` in PATH
- Emscripten (`emsdk`) — use `docker.io/emscripten/emsdk` (not `ghcr.io/emscripten-core/emsdk` — auth issues)
- Build command: `node scripts/build.mjs` from `packages/jxl-wasm`

Use shipped `web/pkg` when possible. The old `jxl_wasm_transcode_jpeg_to_jxl` forward-declaration blocker is resolved (declared at `bridge.cpp:1992`, defined at `:3144`; symbol exported in shipped `dist/jxl-core.simd.js` — verified 2026-06-12). Note: the P3 dec/enc split artifacts (`jxl-core.dec.*.js`) are not built yet; test helpers must fall back to monolithic `jxl-core.simd.js` (see `packages/pyramid-ingest/test/scalar.ts`).

## Test Gaps (decode-handler)

Add under `packages/jxl-worker-browser/test/`:

- Cancel while paused → decoder disposed, `decode_cancelled` posted
- Cancel during active `push()` → `disposeActiveDecoder()` called safely
- Budget exceeded before first progress → `postBudgetExceeded()` with live (non-detached) pixels
- Many small chunks → `worker_drain` coalesced, queued bytes stay below `BYTE_DRAIN_HWM`
- `DRAIN_MIN_INTERVAL_MS` prevents drain spam during bursts

## Before Touching Scheduler / Pool / Protocol

1. Confirm which layer the change belongs to.
2. Check `docs/rejected optimizations.md` — the change may already be documented as rejected.
3. Adaptive/heuristic changes require benchmark data. Do not add tunables without evidence.

## Branch Management

**Never create a branch from `main` when `main` is behind active development.**

Active work happens on named branches (e.g. `AfternoonWork15Jun`). Creating a new branch from `main` silently misses all commits on those branches.

Before `git branch <name>` or `git checkout -b <name>`:
1. Run `git log --oneline main..AfternoonWork15Jun` (or the active branch) — if it shows commits, branch from the active branch, not `main`.
2. Or: `git branch <name> <active-branch>` to branch from the right point.

If a branch was accidentally cut from stale `main`, merge the active branch in before continuing work (`git merge <active-branch> --no-commit`, resolve conflicts, commit).
