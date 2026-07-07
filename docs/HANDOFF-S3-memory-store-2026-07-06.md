# HANDOFF — S3: Memory-governed asset store (2026-07-06)

Branch: `s3/wave2-overnight` (worktree `C:\Foo\rcw-s3`). Not pushed.
Predecessor: `docs/STRATEGIC-MAP-wave2-2026-07-06.md` §S3.
Deferred user decisions: `docs/WAVE2-QUESTIONS-DEFERRED.md` §S3.

## Goal

Replace the repo's five half-policies for memory (ad-hoc peepCache growth,
file-picker's bespoke 32 MB loop, unbounded `prefixAccum`, pyramid/manifest
caches, an arbitrary 1 GiB output guard) with:

1. a **WASM preflight** that projects a decode's peak/retained working set from
   dims + flags (so the browser can admit decodes instead of OOM-ing blind), and
2. **one `AssetStore` governor** — content-addressed, byte-budgeted, single LRU +
   single `QuotaExceededError` policy, `navigator.storage.estimate()`-aware —
   that existing caches become *clients* of, without replacing jxl-cache's OPFS
   backend.

All changes are **additive and behavior-neutral** (Rust) or
**behavior-preserving** (the two browser migrations). Nothing changes decode
output or existing test results.

## Landed (with SHAs on `s3/wave2-overnight`)

| SHA | What |
|---|---|
| `4b3d19f9` | Rust: `estimate_decode_peak` preflight (crate module + 11 native tests) + wasm-bindgen exports + compile-time flag-parity assert |
| `381f70a7` | `packages/asset-store/` — the governor (plain ESM) + 23 node:test cases + `index.d.ts` |
| `ce21bb9b` | Migrate peepCache decoded-LRU + file-picker byte cap to AssetStore clients |
| (this doc) | Handoff + ADR (`docs/adr/S3-memory-budget.md`) + deferred questions |

### 1. WASM preflight — `estimate_decode_peak` (VERIFIED)
- `crates/raw-pipeline/src/mem_budget.rs`: pure `estimate_decode_peak(width,
  height, output_flags) -> DecodePeakEstimate { pixels, retained_bytes,
  peak_bytes }` + `estimate_decode_peak_bytes(...) -> u64`. No alloc/IO; native +
  wasm identical. Model derivation in the ADR.
- `src/lib.rs`: `#[wasm_bindgen]` exports `estimate_decode_peak` (struct with
  `pixels`/`retained_bytes`/`peak_bytes` as `f64`) and the scalar
  `estimate_decode_peak_bytes`. A `const _: () = { assert!(...) }` pins the
  private `OUT_*` bits to the crate mirror — any drift is a compile error.
- Covers ORF, DNG, and CR2 (all share the same buffer shapes via
  `process_*_impl`; `width`/`height` are the active-area pre-orientation dims).

### 2. `@casabio/asset-store` (VERIFIED)
Plain-ESM package (`packages/asset-store/`), importable directly by the un-built
`web/` layer (dev server serves repo root; the `../packages/...` pattern is
already used by `web/tauri-parity-lightbox.js` et al.). API below.

### 3. Two cache migrations (logic VERIFIED, browser wiring UNVERIFIED)
- **file-picker** (`web/jxl-file-picker.js`): the 32 MB per-key persistence
  budget now calls `AssetStore.fitWithinBudget` for admission. **Byte-identical**
  to the old `f.size <= remaining` loop (`used + size <= cap`, same order).
- **peepCache** (`web/main.js`): the decoded-RGBA LRU (bespoke insertion-ordered
  Map + manual eviction) is now an `AssetStore` governor. `size = 1`/entry +
  `maxBytes = 24` **exactly reproduces** the old count-capped LRU; `onEvict`
  frees the evicted variant from its `peepCache` entry. Both `clear()` sites
  clear `peepCache` first → `onEvict('clear')` is a safe no-op.

## AssetStore API

```
new AssetStore({ maxBytes, quotaFraction=0.5, persistent=null,
                 estimateStorage?, onEvict?, now?, name? })

// in-memory tier (synchronous — matches the Map caches it replaces)
set(key, value, sizeBytes?) -> this   // auto-measures byte-carriers; explicit size for opaque objects
get(key) -> value | undefined         // promotes to MRU
peek(key)                             // no LRU touch
has(key) / delete(key) / clear() / keys()
get bytes / get size / get maxBytes / get persistentLimit
setMaxBytes(n)                        // evicts LRU to fit
stats() -> { entries, bytes, maxBytes, hits, misses, evictions, quotaHits, ... }

// namespacing — many clients share ONE budget without key collisions
namespace(ns) -> { key,set,get,peek,has,delete,load,store,remove,keys }

// quota awareness
await refreshQuota() -> { quota, usage, remaining, persistentLimit }  // clamps L2 ceiling to quotaFraction*remaining

// persistent (async) tier — only if a `persistent` backend is supplied
await load(key)                       // memory → else backend → promote to memory
await store(key, value, sizeBytes?)   // set memory + write-through; SINGLE quota policy here
await remove(key)

// statics / helpers
AssetStore  (default export too)
measureBytes(value) -> bytes | NaN
contentHash(ArrayBuffer|View|string) -> 16-hex (FNV-1a 64-bit, sync, dedupe key)
fitWithinBudget(items, budgetBytes, sizeOf) -> { admitted, skipped, usedBytes }
isQuotaExceeded(err) -> bool          // cross-engine (name/code 22/1014)
```

### Design decisions worth knowing
- **Governor, not replacement.** AssetStore owns the *policy* (budget + LRU +
  quota); clients may hold their own bytes and register only sizes via the
  `onEvict` callback (peepCache model), or hand bytes to the store (get/set
  model). Either works.
- **jxl-cache stays the OPFS backend.** `JxlCacheBrowser` structurally satisfies
  `PersistentBackend` (`get/set/delete/has`); AssetStore *drives* it as an
  optional L2, it keeps its own OPFS quota handling. Not wired yet (S3-Q5).
- **Single quota policy, correct lever.** A persistent-tier `QuotaExceededError`
  means *disk/OPFS* is full, so AssetStore does **not** evict its RAM tier for
  it (that frees nothing on disk). It records the event, refreshes the ceiling,
  retries once (giving a self-evicting backend room), then keeps the L1 copy.
  RAM budget pressure is handled separately, proactively, on every `set`.
- **Content-agnostic.** Keys are opaque strings, values opaque byte-carriers. No
  session/scheduler/dedupe/backpressure knowledge — respects the CLAUDE.md layer
  invariants.

## Memory-budget ADR summary
Full: `docs/adr/S3-memory-budget.md`. Model counts *logical live bytes* over two
stages — decode (`RAW 2n + RGB16 6n = 8n`) and render (RGB16 `6n` + RGB8 `3n` +
disp16 orientation transient) — assuming a rotate unless `OUT_NO_ORIENT`.
`retained_bytes` = the buffers surviving in `ProcessResult`. Observed WASM RSS is
~1.3–1.6× the model (heap never shrinks, fragmentation, input bytes), so admission
callers should apply a ~1.5× safety multiplier. 24 MP worked numbers: `flags=7`
→ retained ~85 MB / peak ~230 MB; all-flags+rotate → retained ~360 MB / peak
~517 MB.

## Per-session decode-memory governor (DESIGNED — not implemented; S3-Q4)

**Problem.** The scheduler already backpressures on *in-flight bytes* (adaptive
HWM), but nothing caps *concurrent retained decoded frames*. A gallery that
decodes many large frames and keeps them alive climbs to OOM independent of
in-flight pressure.

**Layer rule (CLAUDE.md).** Backpressure/preemption live at the scheduler/worker
boundary. This governor therefore must **not** go in facade/session. Two safe
homes:

1. **Scheduler HWM extension (recommended, larger).** Add a *retained-pixels*
   counter beside the existing in-flight-bytes HWM. On each completed decode,
   `retained += estimate_decode_peak(w,h,flags).retained_bytes` (the WASM
   preflight is exactly the input); on frame release, subtract. When
   `retained > retainedHwm`, apply the same `waitForDrain` gate the byte HWM uses
   before admitting the next decode. One governor, one layer, reuses the S3
   preflight as its cost function. Needs a "frame released" signal from consumers
   (lightbox close / card delete / LRU drop) — the S2 work adds exactly these
   cancel/close hooks, so this should land *after* S2.

2. **Main-thread `AssetStore` over decoded outputs (cheapest interim).** When a
   decoded frame crosses back from a worker, register it in an `AssetStore`
   (`maxBytes = retained budget`, value = the pixel buffer or a marker + size).
   Its LRU eviction + `onEvict` drop the oldest retained frames past the budget.
   No worker-protocol change; purely main-thread. This is the recommended first
   step; graduate to (1) when the scheduler gains the release signal.

**Do not**: add a per-decode drain callback into facade/session; retain WASM
decoder state across sessions (breaks `recycle()`); pool transferred
ArrayBuffers (they detach) — all three are in the CLAUDE.md rejected list.

## Verification

Run from the worktree.

| Command (cwd) | Result |
|---|---|
| `cargo test --no-default-features --features parallel --lib mem_budget` (`crates/raw-pipeline`) | **11/11 pass**, no libjxl built |
| `cargo check --target wasm32-unknown-unknown --lib` (repo root) | clean (pre-existing dead-code warnings only) — const-asserts + wasm export compile |
| `node --test --test-force-exit test/*.test.js` (`packages/asset-store`) | **23/23 pass** (also via `npm test`) |
| `node --check web/main.js`, `node --check web/jxl-file-picker.js` | syntax OK |

**UNVERIFIED (browser-only):** peepCache + file-picker runtime behavior (no
headless run this session). The *logic* of both migrations is covered — file-picker
admission by the byte-identical `fitWithinBudget` argument + a node test asserting
the 32 MB-cap case; peepCache LRU by the AssetStore suite (LRU eviction,
get-promotes-MRU, onEvict, clear). Import resolution follows the established
`../packages/...` pattern (main.js already depends on it via tauri-parity-lightbox).

## Remaining / follow-ups
- Wire `estimate_decode_peak` into a real admission gate; replace the arbitrary
  1 GiB `MAX_OUTPUT_BYTES_GUARD` with `peak_bytes × safety` (S3-Q3).
- Implement the per-session retained-frame governor (S3-Q4), after S2 adds the
  frame-release hooks.
- Migrate the remaining owners to AssetStore clients (write-ups only this run):
  - **pyramid level bytes** — `packages/jxl-pyramid/src/cache.ts`
    `InMemoryPyramidCache` (32 MiB LRU). Natural first *OPFS-backed* client → the
    place to wire jxl-cache as AssetStore's L2 (S3-Q5).
  - **manifest cache** — `web/pyramid-gallery/image-store.js` `MANIFEST_CACHE_MAX`
    (64-entry LRU). Trivial `namespace('manifest')` client.
  - **prefixAccum** — `packages/jxl-progressive/src/progressive-scheduler.ts`
    (unbounded per-tier accumulation, doubling `oldCap*2`). Not a byte-cache
    (it's a single growing buffer per active fetch) — govern by capping the
    number of *concurrent* accumulating tiers, not by an LRU. Different shape;
    keep out of AssetStore.
- Optional: `AssetStore` → jxl-cache OPFS adapter (~10 lines; S3-Q5).
- Consider an `input_bytes` param on the estimate if callers want the container
  passthrough included.
