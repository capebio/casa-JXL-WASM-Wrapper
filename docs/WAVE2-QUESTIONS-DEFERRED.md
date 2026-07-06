# Wave-2 — Deferred Questions (for David)

User-only judgment calls surfaced during autonomous Wave-2 implementation. Each
has options + a recommended default so nothing blocked overnight; revert/redecide
in the morning.

---

## S3 — Memory-governed asset store

### S3-Q1 — peepCache LRU: keep count-cap or switch to a real byte budget?
The decoded-RGBA LRU was migrated to `AssetStore` **behavior-preservingly**:
`size = 1` per entry + `maxBytes = 24` reproduces the exact old count cap. A real
byte budget (e.g. 512 MB) would be a strict improvement (a 24 MP variant is
~96 MB, so 24 full-res variants is theoretically ~2.3 GB) but changes eviction
timing → possible extra re-decodes I could not measure in-browser.
- **Options**: (a) keep count-cap 24 [current]; (b) switch to a byte budget —
  one-line `maxBytes` change once a target is chosen; (c) hybrid (byte budget +
  a min-entry floor so at least the current photo's ladder stays hot).
- **Recommended default**: (a) now; move to (b) with `maxBytes ≈ 384 MB` after a
  scripted peep session under `performance.memory` / flipflopMem confirms the
  re-decode rate stays acceptable.

### S3-Q2 — Should the file-picker + peep imports point at `src/` or a built `dist/`?
`@casabio/asset-store` is plain ESM (no build), so `web/` imports
`../packages/asset-store/src/index.js`. Every other web/ package import targets
`dist/`. Functionally identical here (source *is* the distributable), but it's a
convention wrinkle.
- **Options**: (a) keep `src/` [current, zero build]; (b) add a trivial
  `tsc`/copy build so it ships a `dist/` like its siblings; (c) rename `src/` →
  `dist/` to match by convention.
- **Recommended default**: (a). Revisit if/when asset-store gains TS-checked
  internals.

### S3-Q3 — Wire `estimate_decode_peak` into a real admission gate now?
The WASM export exists and is verified, but nothing calls it yet. Wiring it into
the worker/scheduler decode-admission path (and replacing the arbitrary 1 GiB
`MAX_OUTPUT_BYTES_GUARD` with `peak_bytes × safety`) is output-visible policy
(could start *refusing* decodes it used to accept).
- **Options**: (a) land the export only, wire later [current]; (b) wire it as a
  soft signal (log-only, no refusal) to gather traces first; (c) wire it as a
  hard gate with a generous multiplier (≥1.5×).
- **Recommended default**: (b) — instrument first, then (c) once the model-vs-RSS
  multiplier is measured on this machine.

### S3-Q4 — Per-session decode-memory governor: which layer owns it?
Designed in the handoff, **not implemented** (touches the sensitive
scheduler/worker backpressure boundary; CLAUDE.md forbids drain/backpressure in
facade/session). Capping *concurrent retained decoded frames* is a new axis
alongside the scheduler's existing in-flight-**bytes** HWM.
- **Options**: (a) extend the scheduler's HWM to also count retained decoded
  pixels (one governor, right layer); (b) a standalone `RetainedFrameGovernor`
  the scheduler consults; (c) leave to `AssetStore` on the main thread governing
  decoded outputs after they cross back from workers.
- **Recommended default**: (a) — it is the same layer the byte-HWM already lives
  in; (c) is the cheapest first step (no worker-protocol change) and is a good
  interim. Do **not** put it in facade/session.

### S3-Q5 — Should `AssetStore` drive `jxl-cache` as its OPFS L2 now?
`AssetStore.PersistentBackend` is structurally satisfied by `JxlCacheBrowser`
(`get`/`set`/`delete`/`has`), so an adapter is ~10 lines. Not wired — jxl-cache
is currently constructed and used directly by the session/scheduler layers, and
routing it under AssetStore is a larger, verify-in-browser change.
- **Options**: (a) leave jxl-cache as-is, AssetStore governs only the in-memory
  clients [current]; (b) add the adapter and let AssetStore write-through to
  jxl-cache for content-addressed assets; (c) full unification (all OPFS traffic
  through AssetStore).
- **Recommended default**: (a) now; (b) when the pyramid-level byte cache is
  migrated (that's the natural first OPFS-backed client).

---
*(S1/S2/S4/S5/S6 sections appended by their respective overnight runs.)*
