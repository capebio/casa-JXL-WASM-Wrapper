# MT-Activation Followups — Findings (2026-07-13)

Handoff: `C:\Tmp\claude-fable-mt-activation-handoff.md`
Branch: `claude/mt-activation-followups` off `main` @ `8e344e7d`
Author: Claude (Opus 4.8), unattended overnight run.

**Gate (from handoff):** keep a candidate only if it is (a) output-preserving vs current
production (exact pixel hash) **and** (b) ≥2% faster under a real flipflop. Below-gate or
output-changing candidates are logged, not landed.

**Net result: no candidate cleared the gate; nothing shippable was landed.** One material
new finding surfaced (a ±1-LSB divergence between the shipped `dec.<tier>` and `enc.<tier>`
WASM builds). See the correction below for what it actually means.

---

## CORRECTION (follow-up in the same session — supersedes the "enc may be buggy / unblock = rebuild" framing below)

A reference-oracle arbitration and a re-measurement changed three conclusions. Read this
first; the sections further down are the original notes and are partly superseded here.

1. **The shipping decoder (`enc.<tier>`) is CONFORMANT — there is no production decode bug.**
   Encoded a synthetic image losslessly with an *independent* reference (upstream libjxl via
   `@jsquash/jxl 1.3.0`), then decoded it through all builds:
   - our `enc.simd` vs original → **EXACT** (perfect lossless reconstruction)
   - our `dec.simd` vs original → **EXACT**
   - `@jsquash` reference vs original → **±1 on ~0.1% of channels** — i.e. the *reference*
     is the rounder, not us. The earlier "enc may be the buggy outlier" read was wrong.

2. **The ±1 divergence was `main`'s STALE `dec` artifact, not a "needs a rebuild" blocker —
   parity-clean `dec` already exists.** The `623abb8d` (2026-07-07) build compiled `enc` and
   `dec` from the *same* libjxl source; those decode **byte-identical** (verified on
   `bench-pyramid-toggle-apples`, all fixtures + the lossy photo). `main`'s `b8bfc5c2`
   (2026-07-12) rebuild of *only* `dec` from a different source is what introduced the ±1.
   So R1 below ("rebuild dec+enc from the same source") is mis-stated: same-source dec already
   exists; `main`'s newer dec is the regression. And since the role loader has no production
   caller, `main`'s divergent dec is **unwired → harmless** today.

3. **Even with a parity-clean `dec`, candidate 3 is net-negative for the primary workload —
   no win, throughput OR footprint.** Re-measured `enc.simd` vs the parity-clean `dec.simd`
   (cold instantiate + first-decode, interleaved, warmup-discard):

   | image | enc.simd | dec.simd | Δ | module bytes |
   |---|---|---|---|---|
   | small (thumbnail) | 15.9 ms | 7.8 ms | **−51%** (dec wins, instantiate-bound) | enc 3.07MB / dec 1.06MB (−65%) |
   | large (1.1MB q85) | 2131 ms | 2311 ms | **+8.5%** (dec loses) | — |

   The decode-only build's kernels decode **~8% slower on large images** (consistent across two
   independent dec builds). The app's main path is full-res/large → wiring decoder→dec would
   **regress it ~8%**. The MT "641 ms" win was threading (runner-width alignment), already in
   the `enc` path — the split adds no decode speed.

   The narrow gain (small-image cold-start + −65% module memory) **has no clean home**:
   - RAW thumbnails (the dominant many-small-images case) run on the **RAW pipeline WASM**
     (`raw_converter_wasm`), not libjxl — `dec.<tier>` is irrelevant to them.
   - Every JXL decode context (`web/jxl-decode-worker.js`, `web/lightbox/tiled-decode-worker.js`)
     is general-purpose (preview + full) and `preloadJxlModule()`s the `enc` superset at
     startup, so adding `dec` for previews loads **both** modules (+memory, no cold win);
     switching a whole worker to `dec` costs the −8% large-decode penalty (and ±1) on the full
     view.

   **Bottom line: no shippable win. Candidates 1 and 3 are genuinely dead for this codebase's
   decode paths as they stand.** The durable value is the knowledge above: conformant shipping
   decoder; stale-but-unwired `main` dec; dec-only decode ~8% slower on large images.

---

## Candidate 3 — Route the JXL decoder to the decode-only `dec.<tier>` module — REJECTED (blocked)

**Rationale (handoff §3):** `createDecoder()` flows through `loadLibjxlModule()` →
`loadGeneratedLibjxlModule()`, whose candidate list is `[enc.<tier>, <tier>]`, so every
decode instantiates the **encoder superset** (`enc.simd` = 3.07 MB) even though a decode-only
`dec.<tier>` artifact (`dec.simd` = 0.89 MB) exists. The role-aware loader
(`loadJxlModule({role:"decode"})`) already resolves `dec.<tier>` first — but **has no
production caller**. The web decode workers (`web/jxl-decode-worker.js`,
`packages/jxl-worker-browser`) all import the facade `createDecoder`, i.e. the `enc` path.
So the decode-only artifacts shipped 2026-07-12/13 ("ship dec:simd… for decode-speed wins",
"align decoder runner with wasm thread pool") are **shipped but unwired**. Candidate 3 is the
missing wiring.

**Change implemented (then reverted):** added a cached `loadDecoderModule()` in `facade.ts`
that loads `[dec.<tier>, <tier>]`, honoring `testModuleFactory` (so the 30+ existing decode
tests that inject via `setJxlModuleFactoryForTesting` keep working) and `_forcedTier`, in its
own singleton distinct from the encoder's shared `modulePromise` (so encode still gets its
superset). Pointed `LibjxlDecoder.events()` at it. Fully reverted after measurement — the
facade is byte-for-byte back to `main`.

**Measurement — cold-start A/B** (Node, standalone artifact instantiation; interleaved,
start-rotated, warmup-discarded, n=24; repro: `dec-role-coldstart-flipflop.mjs`):

| metric | A = `enc.simd` (current) | B = `dec.simd` (candidate) | Δ |
|---|---|---|---|
| cold instantiate (median) | 15.667 ms | 5.620 ms | **−10.05 ms / −64.1%** |
| WASM bytes | 3,072,372 | 886,655 | −71.1% |
| cold first-decode incl. instantiate (median) | 3141.4 ms | 3332.2 ms | **+190.8 ms / +6.07%** |

The instantiate win is real but **~10 ms absolute** — immaterial against a ~3.1 s decode of a
20.5 MP image, and in this Node/single-thread comparison the candidate's end-to-end
first-decode was actually **6% slower**. (The prior agent's cited decode-speed win —
1938.98 → 641.01 ms — came from `dec.simd-**mt**` + libjxl-runner-width alignment, i.e. from
**multithreading**, not from decode-only-ness. That MT win lives in the `-mt` artifacts and
is orthogonal to which superset the module carries.)

**Measurement — output parity (the blocker).** Decoding the same input through `enc.simd` vs
`dec.simd` gives **different pixels** on every fixture, including lossless:

```
srgb-8bit.jxl          enc=0cbdd2dd dec=a7bb46ca mono=a7bb46ca   3-way DIFF
srgb-alpha-8bit.jxl    enc=7c29f209 dec=7e6267b7 mono=7e6267b7   3-way DIFF
lossless-16bit.jxl     enc=4aa9eb97 dec=10b17123 mono=10b17123   3-way DIFF
multiview-a.jxl        enc=4d9fc54d dec=71e12cb3 mono=71e12cb3   3-way DIFF
adobe-rgb-16bit.jxl    enc=154e8898 dec=1f2ee9e1 mono=1f2ee9e1   3-way DIFF
gray-ramp-16bit.jxl    enc=aa9cf344 dec=0457fb1b mono=0457fb1b   3-way DIFF
```

`dec.simd` is **byte-identical to the monolithic `simd`**; `enc.simd` is the outlier.
Magnitude (repro: `dec-vs-enc-parity-repro.mjs`): **maxΔ = 1 LSB, ~24% of channels differ by
exactly 1** — uniform across all fixtures and the 1.1 MB lossy photo (20.8% of channels ±1).
This is the classic signature of two libjxl builds compiled from different source/rounding
(fma contraction / SIMD rounding / libjxl commit), **not** content-dependent.

**Provenance** (last commit to touch each dist `.wasm`):

| artifact | commit date | commit |
|---|---|---|
| `jxl-core.enc.simd.wasm` (facade decoder uses this) | 2026-07-07 | `623abb8d` "rebuild dist from fork libjxl-012 443ced3e" |
| `jxl-core.dec.simd.wasm` | 2026-07-12 | `b8bfc5c2` "ship dec:simd + parallel-wasm artifacts for decode-speed wins" |
| `jxl-core.dec.simd-mt.wasm` | 2026-07-13 | `be678133` "align decoder runner with wasm thread pool" |
| `jxl-core.simd.wasm` (monolithic) | 2026-06-08 | `d3d28fa5` |

So the freshly-shipped `dec` build decodes like the *old* monolithic but ±1 LSB off from the
`enc` build the facade decoder actually runs.

**Decision:** REJECT. Wiring the decoder to `dec.<tier>` would shift decoded output ±1 LSB
across the whole app vs current production — a violation of the non-negotiable "no output
changes" gate — and delivers no end-to-end latency win in the single-thread case. It is
**blocked on build reconciliation**, not on JS. See recommendation R1.

---

## Notable finding — `dec.<tier>` and `enc.<tier>` are not the same decoder (±1 LSB)

Independent of candidate 3: the shipped WASM tiers **do not agree on decode output**.
`enc.<tier>` (built 07-07 from the libjxl-012 fork) differs from `dec.<tier>`/monolithic
(which agree with each other) by a uniform ±1 LSB on ~24% of channels, on lossless inputs too.

- Production decode today is **consistent** (facade, `jxl-decode-worker`, `jxl-worker-browser`
  all use the `enc` path), so no user sees a *within-session* split right now.
- But any activation of the role loader for decode (candidate 3, or a future decode-only
  worker) would silently change decoded pixels app-wide, and would make the same image render
  ±1 LSB differently depending on which path decoded it.
- Which build is *canonically correct* is undetermined here — it needs an independent
  reference (upstream `djxl`) to arbitrate. The majority (dec == monolithic) and the fact that
  lossless decode must be bit-exact both point at `enc` being the drifted one, but that is not
  proven.

Repro: `docs/mt-activation-followups-2026-07-13/dec-vs-enc-parity-repro.mjs`
(standalone, no node_modules: `node docs/mt-activation-followups-2026-07-13/dec-vs-enc-parity-repro.mjs`).

---

## Candidate 1 — Safe first-run RAW-pool split (`min(HC,4)×1` vs `HC×HC`) — REJECTED (measured regression, prior)

**Premise (handoff §1):** with no persisted calibration profile, `web/main.js` sets
`POOL_SIZE = min(HC,12)` workers and posts no `set_calibration`, so each `web/worker.js`
calls `initThreadPool(HC)`. On this 12-core box that is **12 workers × 12 threads = 144**
Rayon threads. Handoff proposes falling back to `safeDefaultSplit()` = `min(HC,4)` workers ×
1 thread (= 4 threads) when uncalibrated.

**Why not landed:** this repo has already measured this exact class and rejected it. A hybrid
budget fix (fewer effective threads for the RAW batch pool) was measured by `flipflopdom`
on **2026-07-09, same 12-core hardware**: **25–58% slower for batch DNG decode (geomean
44%)**, branch `perf/raw-pool-thread-budget-jul08`, REJECTED. Conclusion recorded there:
"144 is **optimal** for batch DNG decode; single-image unaffected." Candidate 1's `4×1` is an
even more aggressive reduction than that rejected hybrid, so it is expected to regress batch
throughput further. The RAW decode is decompress-serial-bound (Olympus VLC ~74% serial;
demosaic mem-bandwidth-bound), so the batch throughput comes from running many files' serial
decompress concurrently across the 144-wide pool — exactly what `4×1` removes.

The cold-start worry (144 threads at first load) is also muted in practice: `WorkerPool.init`
prewarms only 2 workers, and workers instantiate WASM + Rayon lazily on first task, so the
144 threads only materialize under a ≥12-file concurrent batch — the case that measured as
optimal.

**Decision:** REJECT (not implemented). Do not reduce the uncalibrated RAW-pool topology.
This rests on recent same-hardware measured evidence plus the serial-decompress analysis; to
overturn it, re-run a fresh `flipflopdom` RAW-pool topology sweep (§R2) — I did **not**
re-run it unattended (fragile browser+COI+web/pkg setup; strong recent prior data).

The genuinely open, benchmark-gated idea in this area is **not** a fixed safe default but
*invoking `ensureCalibrated()` on first load* so the app measures and persists this box's
optimal split for the next session (`calibrate.mjs` already exists; `web/main.js` only
*applies* a persisted profile, it never *runs* calibration). That is additive but browser-only
and unmeasured, so it is left as a follow-up (§R3), not landed (project rule: adaptive
changes require benchmark data).

---

## Candidate 2 — Aux pages call `initThreadPool(HC)` directly — REJECTED as a class

Same topology class as candidate 1 (timelapse / preset-benchmark / encode-space / crop-benchmark
/ colour-wizard-worker / codec-compare / jxl-benchmark all init full-HC pools). Single-worker
benchmark pages using full HC are not oversubscribed and changing them would only make their
numbers *diverge* from production without a throughput win. Multi-worker pages are the
candidate-1 case, already rejected. Not pursued.

## Candidates 4, 5, 6 — not pursued this run

- **4 (direct decoders bypass scheduler):** architectural; output-preserving but no clear
  measurable throughput win, high blast radius. Needs a design pass, not an overnight edit.
- **5 (CASV serial patch decode → one-frame lookahead):** the most promising *new* win
  (output-preserving: same decodes, same frame order), but requires a browser playback harness
  + `.casv` fixtures to measure honestly. Worth a dedicated session.
- **6 (native Rust nested MT):** handoff itself flags "be careful"; RAW decode is
  decompress-serial/mem-bw bound, Rayon already owns outer tile parallelism.

---

## Recommendations

- **R1 (superseded by the correction — candidate 3 is dead, not just blocked):** wiring the
  facade decoder to `dec.<tier>` is **not** worth pursuing even with parity-clean artifacts.
  Parity is achievable (the `623abb8d` same-source `dec` byte-matches `enc`; it's `main`'s
  `b8bfc5c2` dec rebuild that diverges ±1), but the decode-only build is **~8% slower on
  large-image decode** — the app's primary path — and its cold-start/memory win has no clean
  home (RAW thumbnails don't use libjxl; JXL workers already preload the `enc` superset). Keep
  the decoder on `enc.<tier>`. The one hygiene action worth taking: either revert `main`'s
  `dec.<tier>` to the same-source `623abb8d` build or rebuild it from `enc`'s source, so the
  shipped-but-unwired `dec` artifacts stop being a ±1 trap for any future caller.
- **R2:** if you want to revisit candidate 1, run a fresh `flipflopdom` RAW-pool sweep on the
  current corpus at topologies {12×12=144 (current), 12×2, 12×1, 4×1 (proposed)}, batch and
  single-image separately, output-checksum-gated. Expect 144 to win batch.
- **R3:** consider invoking `ensureCalibrated()` (async, non-blocking) on first load so this
  box's optimal split is measured+persisted for the next session — benchmark-gated.

## Repro / artifacts in this folder

- `dec-vs-enc-parity-repro.mjs` — standalone parity + magnitude probe (no node_modules).
- `dec-role-coldstart-flipflop.mjs` — cold instantiate + first-decode A/B (enc vs dec).

## Verification notes

- `git diff` on tracked source is empty — no source/perf change landed (candidate 3 reverted).
- Measurements ran in Node against the checked-in `packages/jxl-wasm/dist/*` artifacts, which
  instantiate standalone (no facade build / no node_modules needed). The pthread `-mt`
  artifacts cannot instantiate under plain Node ("Worker is not defined"); the ±1 LSB
  divergence is confirmed on the `-st` pair across 6 fixtures and is a build-level property
  (so it holds for `-mt` too, but was not directly re-run in-browser this session).
