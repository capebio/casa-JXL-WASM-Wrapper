# Hardware-Adaptive Calibration — Design

**Date:** 2026-07-08
**Status:** Implemented (phases 1–7) on branch `feat/hw-adaptive-calibration-jul09` — see Implementation Status at end.
**Scope owner:** David (capebio)
**Topic:** One-time, per-machine calibration that discovers the accessible encode/decode pathways, measures them, and persists the throughput-optimal settings for this hardware.

---

## 1. Problem

The engine already contains many hardware-dependent code paths, but **which path runs is invisible** and is chosen purely by *feature-presence*, not by *measured performance*. On the primary deployment target — **servers on unknown/virtualised hardware** — feature-presence is a poor proxy for "fastest":

- **AVX-512 present ≠ AVX-512 fastest.** VM downclocking and gather-instruction latency vary by microcode/host. `pixels_to_xyb` uses `vgatherdps` on AVX-512, which is a win on some hosts and a loss on others.
- **rsqrt vs strict** (`Avx2Rsqrt`/`Avx512Rsqrt` vs `*Strict`) is a real speed/precision variant that CPUID cannot resolve — the code even exposes a `prefer_rsqrt` flip-flop with no principled selector.
- **`cgroup` CPU quota ≠ `available_parallelism()`.** Containers under-report or cap cores; rayon over-spawns past the quota and thrashes. In the browser the analogue is the known **144-thread oversubscription** (`min(HC,12)` workers × per-worker `HC` rayon threads).
- **Noisy neighbours** make single-shot timings unreliable on shared VMs.

**Goal:** run once when JPEG XL first runs on a machine — enumerate the pathways, confirm each is reachable, benchmark the accessible ones end-to-end, and persist a machine profile the runtime reads to pick the throughput-optimal path automatically.

---

## 2. Feasibility verdict

**Feasible.** Runtime selection already exists (`detect_native()`, `detectTier()`, thread-count sites); what is missing is a measurement layer feeding those selectors. Concretely:

- The **native x86 binary compiles all backends** (scalar/AVX2/AVX512) — so all are benchmarkable in-process via runtime CPUID.
- The **WASM tiers ship as separate artifacts** (`scalar/simd/simd-mt/relaxed-simd-mt`) — all are loadable and probeable.
- The Rust `Backend` already routes through `resolve_backend()` with a `prefer_rsqrt` flag — an override hook is a small addition, not a rewrite.

**Honest limits** (see §10): compile-time-gated paths are only testable if built in; browser calibration is weaker than native (no CPUID, coarser timers, sandbox); and throughput-only scope deliberately excludes content-dependent quality knobs.

---

## 3. Scope

**In scope (throughput-only, per approval):**
- SIMD backend variant selection (native x86; WASM tier).
- Thread/worker concurrency: native rayon thread counts, decode `parallel`, browser worker×rayon split.
- Accessibility verification of every enumerated pathway.
- One-time end-to-end calibration (1–3 min budget) → persisted, signature-keyed machine profile.

**Out of scope (explicitly NOT auto-tuned):**
- Quality/size knobs: `distance`, `effort`, `gop_len`, `skip`, `tile`, `resampling`, `progressive`. These are content/goal-driven and stay user-set. The tuner never silently changes output quality.
- Online/adaptive production tuning (rejected: nondeterministic, contaminates workloads).
- Static instance-type lookup as the primary mechanism (kept only as a fallback prior — §7).

---

## 4. Architecture

Eight components. The registry is the spine; the fractal corpus feeds the harness; the broadcast makes every choice visible.

```
   ┌────────────────────────┐        ┌────────────────────────┐
   │  Fractal Corpus Gen     │        │   Pathway Registry      │  declarative catalog ("routes")
   │  deterministic · sized  │        │   variants · selector   │
   │  seahorse/julia/…       │        │   accessibility pred.   │
   │  known output = oracle  │        │   benchmark method      │
   └───────────┬────────────┘        └───────────┬────────────┘
               │                 ┌────────────────┼─────────────────┐
               ▼                 ▼                ▼                  ▼
        ┌──────────────┐ ┌────────────────┐ ┌──────────────┐ ┌──────────────────┐
        │ (feeds)      │ │ Accessibility  │ │  Benchmark   │ │  Machine         │
        └──────┬───────┘ │ Prober         │ │  Harness     │ │  Profiler/Store  │
               └────────▶│ (+ CI test)    │ │ micro+macro  │ │ signature+JSON   │
                         └───────┬────────┘ │ +parity gate │ └────────┬─────────┘
                                 │          └──────┬───────┘          │
                                 └──────────┬──────┴──────────────────┘
                                            ▼
        ┌────────────────────┐     ┌────────────────────┐     ┌──────────────────────┐
        │  Live Broadcast    │◀────│   Orchestrator     │────▶│  Runtime Selector    │
        │  timings · winners │     │ calibrate + first- │ wr. │  Integration (hooks) │
        │  fractal previews  │     │ run auto-trigger   │prof │  reads profile       │
        └────────────────────┘     └────────────────────┘     └──────────────────────┘
```

### 4.1 Pathway Registry
A single declarative catalog — the explicit enumeration the request calls for ("make the routes obvious"). Each entry:

| field | meaning |
|-------|---------|
| `id` | stable key (e.g. `native.simd.xyb`) |
| `variants` | the mutually-exclusive implementations to choose among |
| `selector_site` | where the runtime currently chooses (file:line) |
| `accessible_if` | predicate: when is this pathway reachable on this build+machine |
| `bench` | how to measure it (micro kernel / macro e2e) |
| `axis` | throughput dimension it moves (SIMD lane throughput / concurrency) |

Registry is data, not scattered `if`s. It lives in **one Rust module** (native) and **one TS module** (browser), each generating both the human-readable "routes" report and the machine-driven calibration plan.

### 4.2 Accessibility Prober
For each registry entry, confirm reachable **now, here**:
- x86 feature via `is_x86_feature_detected!` for AVX2/AVX512.
- WASM tier: attempt load of the artifact; confirm factory export.
- Threads: read effective core budget = `min(available_parallelism, cgroup_quota)`; confirm rayon can build a pool of size N. Browser: `crossOriginIsolated` + `SharedArrayBuffer` + `Worker`.
- Native symbol/bridge presence where relevant.

Outputs an **accessibility report** (what's reachable, what's gated out and why) and backs a **CI test** asserting no registry entry is unreachable through a *build mistake* (e.g. a backend accidentally `cfg`-excluded). This is the "double-check they are all accessible" deliverable.

### 4.3 Fractal Corpus Generator
Procedural, deterministic image source — no shipped assets, few lines, tailorable to any size. Same escape-time math in Rust (native) and TS (browser) so buffers are byte-identical cross-environment.

- **Datasets (named, fixed params):**
  - `mandelbrot-seahorse` — seahorse valley (center ≈ `-0.743643887037`, `0.131825904205`, deep zoom): dense high-frequency swirl → stresses VarDCT/entropy. The headline visual.
  - `mandelbrot-full` — whole set: mixed flat + detail (compressibility range).
  - `julia-a` / `julia-b` — e.g. `c = -0.8 + 0.156i`, `c = 0.285 + 0.01i`: colourful, different edge statistics.
  - `burning-ship` — sharp anisotropic edges (different frequency signature).
  - `*.dithered` — optional seeded-hash dither overlay to raise entropy toward photographic statistics for the macro **encode** bench (self-similar fractals under-noise vs real sensors).
- **Colouring:** smooth (continuous) iteration count → palette → RGBA8/16. Deterministic; pure function of `(id, center, zoom, w, h, max_iter, palette)`. No RNG (dither uses a seeded integer hash).
- **Sizing:** width×height is a parameter → the harness emits exactly the sizes it needs (tiny for micro warmup; ~24 MP for memory-bandwidth stress; a resolution ladder for the macro grid).
- **Cost excluded from timing:** generate once → cache buffer → time only encode/decode/kernel. Generation itself is not measured.

### 4.4 Benchmark Harness
Two tiers, fed by the fractal corpus:
- **Micro** — fixed fractal buffers through the hot kernels (`pixels_to_xyb`, `box_blur`, `ssim_moments`, `downsample`, `scale_err`). Settles backend-variant questions (rsqrt-vs-strict, AVX512-gather-vs-AVX2) cheaply and deterministically.
- **Macro** — end-to-end encode/decode across a thread/worker grid. Settles concurrency (rayon thread count; browser worker×thread split; decode `parallel` on/off) under realistic memory-bandwidth pressure.

**Parity gate (correctness oracle — enabled by known/deterministic output):**
Before timing, every candidate SIMD backend runs the fractal through the documented byte-exact kernels (e.g. `pixels_to_xyb`) and must match the scalar reference bit-for-bit (or within the kernel's stated epsilon). A backend that fails parity is **disqualified**, not benchmarked — catching a miscompiled/mis-`cfg`'d backend before it can win on speed. This is a free, strong correctness check the fractal corpus makes possible.

**Noise controls (mandatory for VMs):**
- Warmup iterations discarded.
- Median-of-N (not mean); report N and spread.
- **Coefficient-of-variation gate**: if CoV over the sample exceeds a threshold, re-run that measurement up to a cap; if still noisy, mark the result low-confidence and fall back to the safe prior.
- Record power/thermal hints where available (note: many VMs expose none — treated as unknown, not assumed-good). Cross-refs the known "battery/turbo" measurement pitfall.

### 4.5 Machine Profiler / Profile Store
- **Hardware signature**: CPU vendor+model+feature flags, effective core budget (incl. cgroup quota), page size; browser: tier + `hardwareConcurrency` + COI state. Hash → signature key.
- **Profile**: versioned JSON — `{schema_version, signature, generated_at, selections{...}, measurements{...}, confidence{...}}`.
- **Invalidation**: on startup, recompute signature; if mismatch (fleet clone landed on different vCPU, microcode update, cgroup change), the profile is stale → ignore and re-calibrate. Prevents a golden-image profile from being trusted on the wrong host.
- **Location**: native — OS config dir (or explicit `--profile-path`); browser — persistent storage keyed by signature.

### 4.6 Runtime Selector Integration
Add a **profile-override hook** at each existing selection site; profile wins over raw feature-presence, else fall back to current behaviour:
- `detect_native()` / `resolve_backend()` — accept an override backend (incl. rsqrt vs strict). *(crates/raw-pipeline perceptual `simd/mod.rs`)*
- `detectTier()` — accept a forced tier from profile. *(packages/jxl-wasm `facade.ts`; `setForcedTier` already exists)*
- Native thread counts — `Decoder::with_threads` / `Encoder::with_threads` / `CASV_ENC_THREADS` read the profile's chosen count. *(jxl_casadecoder.rs, jxl_casaencoder.rs, casa_video.rs)*
- Browser worker×thread — profile supplies worker pool size and per-worker rayon count, replacing `min(HC,12)` × `HC`. *(web/main.js, web/worker.js)*

No selection logic is *deleted*; the profile is an *override input*. Missing/stale profile = today's behaviour.

### 4.7 Orchestrator
- **Native:** a `calibrate` subcommand (headless, server-friendly): run prober → harness → write profile → log summary. Plus an **auto-trigger**: on first encode/decode when no valid profile exists, run calibration inline (respecting the 1–3 min budget) then proceed. Idempotent; concurrent-safe (lockfile so two processes don't calibrate at once).
- **Browser:** a calibration module that runs on first session, persists to storage, and yields to the UI (non-blocking; uses current defaults until the profile lands).

### 4.8 Live Broadcast / Report
Calibration is **shown, not hidden** — outputs, timings, and every chosen winner are broadcast. Same event stream, three sinks:
- **Server / headless:** structured log lines — one per pathway: `id · variant · median ns/op · CoV · ✔chosen | ✗rejected(reason)`. Plus a final table. Optionally writes fractal sample PNGs (`calibration-samples/seahorse.png`, …) so the operator can see what was tested.
- **TTY / native interactive:** a live progress view — the fractal datasets rendered as they generate, per-pathway bars filling with timings, the winner highlighted as each contest resolves.
- **Browser:** a visible "calibrating your machine" panel — the seahorse and Julia sets painted live, a race chart of backend/tier timings, and the final explicit choices ("this machine → AVX512-rsqrt · 8 encode threads · simd-mt tier"). Non-blocking; dismissible.

The broadcast emits from the same measurement events the profiler consumes, so what the user sees **is** what gets persisted — no divergence between the show and the decision. Verbosity is a flag (`--quiet` for pure-headless fleets; default verbose so first-run is legible).

---

## 5. The pathways (concrete registry — v1)

Throughput-relevant routes found in the codebase. `file:line` are current selection sites.

### Native (x86 server — PRIMARY)

| id | variants | selector site | accessible_if | bench |
|----|----------|---------------|---------------|-------|
| `native.backend.xyb` | scalar / AVX2 / AVX512 (+gather) | `perceptual/simd/mod.rs` `detect_native`, `resolve_backend` | CPUID AVX2 / AVX512F+BW | micro (xyb kernel) |
| `native.backend.rsqrt` | Strict vs Rsqrt (AVX2 & AVX512) | `simd/mod.rs` `prefer_rsqrt` | backend ≥ AVX2 | micro (scale_err) |
| `native.backend.blur` | scalar / AVX2 / (AVX512 reuse) | `perceptual/mod.rs` blur dispatch | CPUID AVX2 | micro (box_blur) |
| `native.backend.ssim/ssd` | scalar / AVX2 / AVX512 | `perceptual/mod.rs` | CPUID | micro |
| `native.telemetry.analyze` | scalar / AVX2 | `telemetry.rs` `analyze_fused` (~:314-334) | `is_x86_feature_detected!("avx2")` | micro |
| `native.tone.bulk` | scalar / AVX2+FMA | `tone_simd.rs` (~:95-123) | AVX2+FMA | micro |
| `native.decode.threads` | ST vs rayon-N | `jxl_casadecoder.rs` `with_threads` (~:321) | cores > 1 within cgroup quota | macro (djxl e2e) |
| `native.encode.threads` | ST vs rayon-N | `jxl_casaencoder.rs` `with_threads` (~:453) | cores > 1 within quota | macro (cjxl e2e) |
| `native.casv.enc.threads` | N via `CASV_ENC_THREADS` | `casa_video.rs` (~:833-842) | cores > 1 within quota | macro (video e2e) |
| `native.casv.stream.serial` | overlap vs serial | `casa_video.rs` `CASV_STREAM_SERIAL` (~:1319) | always | macro |

### Browser / WASM (secondary)

| id | variants | selector site | accessible_if | bench |
|----|----------|---------------|---------------|-------|
| `wasm.tier` | scalar / simd / simd-mt / relaxed-simd-mt | `facade.ts` `detectTier` (~:622-650) | WASM+SIMD probe; MT needs SAB+COI+Worker | macro (load+e2e) |
| `wasm.worker.pool` | pool size (replaces `min(HC,12)`) | `web/main.js` (~:64) | Worker available | macro grid |
| `wasm.worker.rayon` | per-worker thread count (replaces `HC`) | `web/worker.js` (~:182) | COI + `initThreadPool` | macro grid (joint with pool → fixes 144 oversubscription) |
| `wasm.corebudget` | global concurrent MT cap | `jxl-scheduler/budget.ts` (~:134) | — | derived from grid winner |

> The browser worker×rayon entries are calibrated **jointly** (a 2-D grid), because the pathological case is their product, not either alone.

---

## 6. First-run flow

```
start encode/decode
   └─ profile exists & signature matches & schema current?
        ├─ yes → apply overrides → run
        └─ no  → acquire calibrate lock
                   ├─ Accessibility Prober  → accessible pathway set
                   ├─ Micro bench           → backend-variant winners
                   ├─ Macro bench (grid)    → concurrency winners
                   ├─ CoV gate / re-run     → confidence per selection
                   ├─ write machine-profile.json (signature-keyed)
                   └─ release lock → apply overrides → run
```

Server: headless, logs a one-line summary per pathway (`chosen / measured / confidence`). Budget 1–3 min; if a measurement can't stabilise, that pathway keeps the safe prior and is flagged low-confidence.

---

## 7. Fallback prior (Approach C, demoted)

When calibration cannot run (locked, budget-starved, sandbox forbids timing) the selector falls back to:
1. any partial/low-confidence profile value, else
2. a small static prior table keyed by coarse signature (e.g. "AVX512 + ≥16 cores"), else
3. today's feature-presence default.

Never blocks the actual encode.

---

## 8. Server / VM specifics (primary target)

- **cgroup quota** is the effective core budget; read it (`/sys/fs/cgroup/...` cpu.max / quota) and clamp all thread counts to it. This is the single most important server correctness item.
- **Downclocking / gather cost** → AVX512 must earn its place by measurement, not presence. Micro-bench is decisive here.
- **Noisy neighbours** → median + CoV gate + bounded re-run; low-confidence flag rather than a confident wrong pick.
- **Fleet cloning / autoscaling** → signature-keyed profile with auto-invalidation; optionally `calibrate` at image-build **and** re-validate signature at boot.
- **No display / headless** → native path is CLI-first; no UI dependency.

---

## 9. Implementation phases (for the follow-up plan)

1. **Registry + Accessibility Prober + CI test** (native first). Delivers the "explicit routes" report and the accessibility guarantee with zero behaviour change.
2. **Fractal Corpus Generator + parity gate** (Rust). Deterministic datasets at arbitrary size; cross-backend byte-exact assertion doubles as a SIMD correctness oracle.
3. **Micro-bench harness + Live Broadcast** + backend-variant selection (rsqrt/AVX512) → profile write + `resolve_backend` override hook. Native. Broadcast shows every contest.
4. **Macro-bench grid** + native thread-count selection (encode/decode/CASV), cgroup-clamped.
5. **Profile store + signature + invalidation + Orchestrator** (`calibrate` subcommand + first-run auto-trigger + lock).
6. **Browser port**: fractal gen in TS (byte-matched to Rust) + tier confirm + worker×rayon joint grid (fixes 144 oversubscription) + live visual panel + persisted profile.
7. **Fallback prior table** + docs (the generated "routes" report checked into `docs/`).

Each phase is independently shippable and leaves the system correct if later phases never land.

---

## 10. Risks & limits

- **Compile-time-gated paths** only testable if built in. Mitigation: native compiles all x86 backends; WASM ships all tiers; CI accessibility test catches accidental exclusion.
- **Measurement noise on shared VMs** could mis-rank close variants. Mitigation: CoV gate; when winners are within noise, prefer the *safer* variant (strict over rsqrt; fewer threads over more) and flag low-confidence.
- **Browser timing is coarse/sandboxed** (`performance.now()` clamping, no CPUID). Browser profile is best-effort; its highest-value output is the concurrency fix, which is robust to coarse timers.
- **Profile drift** if hardware changes silently. Mitigation: signature recompute on every startup.
- **Scope creep into quality knobs.** Explicitly forbidden here; a future, separate design can address content-adaptive quality with golden-image gating.

---

## 11. Success criteria

1. A single command prints the full, explicit list of pathways and, per pathway, whether it is accessible on this machine and why. *(routes made obvious + accessibility proven)*
2. CI fails if any registry pathway becomes unreachable through a build mistake.
3. The fractal corpus generates byte-identical buffers in Rust and TS; the parity gate disqualifies any backend that fails bit-exact kernel output.
4. Calibration broadcasts per-pathway timings and the explicit chosen winner (log/TTY/browser), and what is shown equals what is persisted.
5. On a cold machine, first run produces a signature-keyed `machine-profile.json` within the 1–3 min budget, headless.
6. Runtime selectors demonstrably honour the profile (e.g. forcing a suboptimal backend via profile changes measured throughput).
7. On a container with a cgroup CPU limit, chosen thread counts never exceed the quota.
8. Browser worker×rayon product no longer oversubscribes (no 144-thread case); measured throughput ≥ current default on the test box.
9. Missing/stale/low-confidence profile never blocks or breaks an encode — clean fallback to today's behaviour.

---

## 12. Open questions (for implementation planning)

- Exact CoV threshold and re-run cap (tune against a real noisy VM).
- Corpus resolved: **procedural fractals** (seahorse/julia/burning-ship, optional dithered-entropy variant). Open sub-question: exact `max_iter`/zoom/palette per dataset, and whether the dithered variant is needed for the encode bench or fractals already stress entropy enough.
- Profile file location convention on the server fleet (per-node vs baked-at-image + revalidate).
- Whether `calibrate` should also emit a machine-readable capability report for fleet telemetry.

---

## 13. Implementation Status (2026-07-09)

All eight components landed on branch `feat/hw-adaptive-calibration-jul09` (native +
browser), additive and fallback-safe: every shipped-selector hook is a **no-op until a
profile is written**, so an uncalibrated process behaves exactly as before.

**Native (`crates/raw-pipeline/src/calibration/`):**

| Component | File | Notes |
|-----------|------|-------|
| Pathway registry (§4.1) | `registry.rs` | 6 native routes; declarative catalog |
| Accessibility prober (§4.2) | `prober.rs` | cgroup-aware `effective_core_budget()` |
| Fractal corpus (§4.3) | `fractal.rs` | seahorse/full/julia-a/b/burning-ship + dither |
| Parity gate (§4.4) | `parity.rs` | strict tol 1e-4 / rsqrt 5e-3 (fmadd not bit-exact) |
| Bench harness (§4.4) | `bench.rs` | warmup + median-of-N + CoV; backend + thread scaling |
| Profile store (§4.5) | `profile.rs` | signature-keyed, self-invalidating, serde_json |
| Runtime hook (§4.6) | `perceptual/mod.rs` `resolve_backend` + `casa_video.rs` `resolve_enc_threads` | backend + encode-thread overrides |
| Orchestrator (§4.7) | `orchestrator.rs` | `run_calibration` / `ensure_calibrated` + lockfile |
| Broadcast (§4.8) | via `emit` sink | shown == persisted (`measurements`) |
| Fallback prior (§7) | `prior.rs` | conservative; AVX2 even when AVX-512 present |

Run: `cargo run -p raw-pipeline --example calibrate --no-default-features --features parallel --release`
(add `--fresh` to force recalibration; first positional arg overrides the profile path).
Inspect routes: `cargo run -p raw-pipeline --example routes --no-default-features --features parallel`.
Tests: `cargo test -p raw-pipeline --lib --no-default-features --features parallel calibration` (33 pass).

**Browser (`web/calibration/`, phase 6):** `fractal.mjs` (Rust-matched generator),
`grid.mjs` (joint worker×thread split, product ≤ HC — fixes the 144-thread
oversubscription), `profile.mjs` (localStorage + signature match), `calibrate.mjs`
(`ensureCalibrated`, injected measurer, safe default). Wired into `web/main.js`
(`POOL_SIZE` reads a persisted, HC-gated profile) and `web/worker.js`
(`initThreadPool` honours `self.__calibratedThreads`). Tests:
`node --test web/calibration/calibration.test.mjs` (10 pass).

**Deltas from design (honest notes):**
- **Parity is not bit-exact vs scalar** — the butteraugli *score* carries fmadd-vs-mul-add
  rounding (~2e-7 rel); the gate uses tight documented tolerances, not bit-equality.
- **Macro thread bench uses a perceptual-kernel proxy**, not real JXL encode. It runs the
  real XYB/blur/downsample/butteraugli kernels under memory-bandwidth pressure (faithful
  to the hot path) and needs no `jxl-codec`. A real end-to-end encode variant is a gated
  follow-up.
- **Browser per-worker thread cap is a hook** (`self.__calibratedThreads`): the worker
  side honours it, but posting it from the main thread to each worker is a small plumbing
  follow-up. `POOL_SIZE` (worker count) is fully wired.
- **Cross-language fractal byte-parity** is best-effort (f64 transcendental last-ULP); the
  algorithm matches and structural tests pass on both sides. Pinning a shared golden
  vector is a follow-up.
- **First-run auto-trigger** is provided as `ensure_calibrated()` (library) + the
  `calibrate` example, not force-injected into every encode entry (a surprising 1–3 min
  pause inside a library call is worse than an explicit call). Wire it where the app
  wants it.
# Hardware-Adaptive Calibration — Design

**Date:** 2026-07-08
**Status:** Design approved; ready for implementation planning
**Scope owner:** David (capebio)
**Topic:** One-time, per-machine calibration that discovers the accessible encode/decode pathways, measures them, and persists the throughput-optimal settings for this hardware.

---

## 1. Problem

The engine already contains many hardware-dependent code paths, but **which path runs is invisible** and is chosen purely by *feature-presence*, not by *measured performance*. On the primary deployment target — **servers on unknown/virtualised hardware** — feature-presence is a poor proxy for "fastest":

- **AVX-512 present ≠ AVX-512 fastest.** VM downclocking and gather-instruction latency vary by microcode/host. `pixels_to_xyb` uses `vgatherdps` on AVX-512, which is a win on some hosts and a loss on others.
- **rsqrt vs strict** (`Avx2Rsqrt`/`Avx512Rsqrt` vs `*Strict`) is a real speed/precision variant that CPUID cannot resolve — the code even exposes a `prefer_rsqrt` flip-flop with no principled selector.
- **`cgroup` CPU quota ≠ `available_parallelism()`.** Containers under-report or cap cores; rayon over-spawns past the quota and thrashes. In the browser the analogue is the known **144-thread oversubscription** (`min(HC,12)` workers × per-worker `HC` rayon threads).
- **Noisy neighbours** make single-shot timings unreliable on shared VMs.

**Goal:** run once when JPEG XL first runs on a machine — enumerate the pathways, confirm each is reachable, benchmark the accessible ones end-to-end, and persist a machine profile the runtime reads to pick the throughput-optimal path automatically.

---

## 2. Feasibility verdict

**Feasible.** Runtime selection already exists (`detect_native()`, `detectTier()`, thread-count sites); what is missing is a measurement layer feeding those selectors. Concretely:

- The **native x86 binary compiles all backends** (scalar/AVX2/AVX512) — so all are benchmarkable in-process via runtime CPUID.
- The **WASM tiers ship as separate artifacts** (`scalar/simd/simd-mt/relaxed-simd-mt`) — all are loadable and probeable.
- The Rust `Backend` already routes through `resolve_backend()` with a `prefer_rsqrt` flag — an override hook is a small addition, not a rewrite.

**Honest limits** (see §10): compile-time-gated paths are only testable if built in; browser calibration is weaker than native (no CPUID, coarser timers, sandbox); and throughput-only scope deliberately excludes content-dependent quality knobs.

---

## 3. Scope

**In scope (throughput-only, per approval):**
- SIMD backend variant selection (native x86; WASM tier).
- Thread/worker concurrency: native rayon thread counts, decode `parallel`, browser worker×rayon split.
- Accessibility verification of every enumerated pathway.
- One-time end-to-end calibration (1–3 min budget) → persisted, signature-keyed machine profile.

**Out of scope (explicitly NOT auto-tuned):**
- Quality/size knobs: `distance`, `effort`, `gop_len`, `skip`, `tile`, `resampling`, `progressive`. These are content/goal-driven and stay user-set. The tuner never silently changes output quality.
- Online/adaptive production tuning (rejected: nondeterministic, contaminates workloads).
- Static instance-type lookup as the primary mechanism (kept only as a fallback prior — §7).

---

## 4. Architecture

Eight components. The registry is the spine; the fractal corpus feeds the harness; the broadcast makes every choice visible.

```
   ┌────────────────────────┐        ┌────────────────────────┐
   │  Fractal Corpus Gen     │        │   Pathway Registry      │  declarative catalog ("routes")
   │  deterministic · sized  │        │   variants · selector   │
   │  seahorse/julia/…       │        │   accessibility pred.   │
   │  known output = oracle  │        │   benchmark method      │
   └───────────┬────────────┘        └───────────┬────────────┘
               │                 ┌────────────────┼─────────────────┐
               ▼                 ▼                ▼                  ▼
        ┌──────────────┐ ┌────────────────┐ ┌──────────────┐ ┌──────────────────┐
        │ (feeds)      │ │ Accessibility  │ │  Benchmark   │ │  Machine         │
        └──────┬───────┘ │ Prober         │ │  Harness     │ │  Profiler/Store  │
               └────────▶│ (+ CI test)    │ │ micro+macro  │ │ signature+JSON   │
                         └───────┬────────┘ │ +parity gate │ └────────┬─────────┘
                                 │          └──────┬───────┘          │
                                 └──────────┬──────┴──────────────────┘
                                            ▼
        ┌────────────────────┐     ┌────────────────────┐     ┌──────────────────────┐
        │  Live Broadcast    │◀────│   Orchestrator     │────▶│  Runtime Selector    │
        │  timings · winners │     │ calibrate + first- │ wr. │  Integration (hooks) │
        │  fractal previews  │     │ run auto-trigger   │prof │  reads profile       │
        └────────────────────┘     └────────────────────┘     └──────────────────────┘
```

### 4.1 Pathway Registry
A single declarative catalog — the explicit enumeration the request calls for ("make the routes obvious"). Each entry:

| field | meaning |
|-------|---------|
| `id` | stable key (e.g. `native.simd.xyb`) |
| `variants` | the mutually-exclusive implementations to choose among |
| `selector_site` | where the runtime currently chooses (file:line) |
| `accessible_if` | predicate: when is this pathway reachable on this build+machine |
| `bench` | how to measure it (micro kernel / macro e2e) |
| `axis` | throughput dimension it moves (SIMD lane throughput / concurrency) |

Registry is data, not scattered `if`s. It lives in **one Rust module** (native) and **one TS module** (browser), each generating both the human-readable "routes" report and the machine-driven calibration plan.

### 4.2 Accessibility Prober
For each registry entry, confirm reachable **now, here**:
- x86 feature via `is_x86_feature_detected!` for AVX2/AVX512.
- WASM tier: attempt load of the artifact; confirm factory export.
- Threads: read effective core budget = `min(available_parallelism, cgroup_quota)`; confirm rayon can build a pool of size N. Browser: `crossOriginIsolated` + `SharedArrayBuffer` + `Worker`.
- Native symbol/bridge presence where relevant.

Outputs an **accessibility report** (what's reachable, what's gated out and why) and backs a **CI test** asserting no registry entry is unreachable through a *build mistake* (e.g. a backend accidentally `cfg`-excluded). This is the "double-check they are all accessible" deliverable.

### 4.3 Fractal Corpus Generator
Procedural, deterministic image source — no shipped assets, few lines, tailorable to any size. Same escape-time math in Rust (native) and TS (browser) so buffers are byte-identical cross-environment.

- **Datasets (named, fixed params):**
  - `mandelbrot-seahorse` — seahorse valley (center ≈ `-0.743643887037`, `0.131825904205`, deep zoom): dense high-frequency swirl → stresses VarDCT/entropy. The headline visual.
  - `mandelbrot-full` — whole set: mixed flat + detail (compressibility range).
  - `julia-a` / `julia-b` — e.g. `c = -0.8 + 0.156i`, `c = 0.285 + 0.01i`: colourful, different edge statistics.
  - `burning-ship` — sharp anisotropic edges (different frequency signature).
  - `*.dithered` — optional seeded-hash dither overlay to raise entropy toward photographic statistics for the macro **encode** bench (self-similar fractals under-noise vs real sensors).
- **Colouring:** smooth (continuous) iteration count → palette → RGBA8/16. Deterministic; pure function of `(id, center, zoom, w, h, max_iter, palette)`. No RNG (dither uses a seeded integer hash).
- **Sizing:** width×height is a parameter → the harness emits exactly the sizes it needs (tiny for micro warmup; ~24 MP for memory-bandwidth stress; a resolution ladder for the macro grid).
- **Cost excluded from timing:** generate once → cache buffer → time only encode/decode/kernel. Generation itself is not measured.

### 4.4 Benchmark Harness
Two tiers, fed by the fractal corpus:
- **Micro** — fixed fractal buffers through the hot kernels (`pixels_to_xyb`, `box_blur`, `ssim_moments`, `downsample`, `scale_err`). Settles backend-variant questions (rsqrt-vs-strict, AVX512-gather-vs-AVX2) cheaply and deterministically.
- **Macro** — end-to-end encode/decode across a thread/worker grid. Settles concurrency (rayon thread count; browser worker×thread split; decode `parallel` on/off) under realistic memory-bandwidth pressure.

**Parity gate (correctness oracle — enabled by known/deterministic output):**
Before timing, every candidate SIMD backend runs the fractal through the documented byte-exact kernels (e.g. `pixels_to_xyb`) and must match the scalar reference bit-for-bit (or within the kernel's stated epsilon). A backend that fails parity is **disqualified**, not benchmarked — catching a miscompiled/mis-`cfg`'d backend before it can win on speed. This is a free, strong correctness check the fractal corpus makes possible.

**Noise controls (mandatory for VMs):**
- Warmup iterations discarded.
- Median-of-N (not mean); report N and spread.
- **Coefficient-of-variation gate**: if CoV over the sample exceeds a threshold, re-run that measurement up to a cap; if still noisy, mark the result low-confidence and fall back to the safe prior.
- Record power/thermal hints where available (note: many VMs expose none — treated as unknown, not assumed-good). Cross-refs the known "battery/turbo" measurement pitfall.

### 4.5 Machine Profiler / Profile Store
- **Hardware signature**: CPU vendor+model+feature flags, effective core budget (incl. cgroup quota), page size; browser: tier + `hardwareConcurrency` + COI state. Hash → signature key.
- **Profile**: versioned JSON — `{schema_version, signature, generated_at, selections{...}, measurements{...}, confidence{...}}`.
- **Invalidation**: on startup, recompute signature; if mismatch (fleet clone landed on different vCPU, microcode update, cgroup change), the profile is stale → ignore and re-calibrate. Prevents a golden-image profile from being trusted on the wrong host.
- **Location**: native — OS config dir (or explicit `--profile-path`); browser — persistent storage keyed by signature.

### 4.6 Runtime Selector Integration
Add a **profile-override hook** at each existing selection site; profile wins over raw feature-presence, else fall back to current behaviour:
- `detect_native()` / `resolve_backend()` — accept an override backend (incl. rsqrt vs strict). *(crates/raw-pipeline perceptual `simd/mod.rs`)*
- `detectTier()` — accept a forced tier from profile. *(packages/jxl-wasm `facade.ts`; `setForcedTier` already exists)*
- Native thread counts — `Decoder::with_threads` / `Encoder::with_threads` / `CASV_ENC_THREADS` read the profile's chosen count. *(jxl_casadecoder.rs, jxl_casaencoder.rs, casa_video.rs)*
- Browser worker×thread — profile supplies worker pool size and per-worker rayon count, replacing `min(HC,12)` × `HC`. *(web/main.js, web/worker.js)*

No selection logic is *deleted*; the profile is an *override input*. Missing/stale profile = today's behaviour.

### 4.7 Orchestrator
- **Native:** a `calibrate` subcommand (headless, server-friendly): run prober → harness → write profile → log summary. Plus an **auto-trigger**: on first encode/decode when no valid profile exists, run calibration inline (respecting the 1–3 min budget) then proceed. Idempotent; concurrent-safe (lockfile so two processes don't calibrate at once).
- **Browser:** a calibration module that runs on first session, persists to storage, and yields to the UI (non-blocking; uses current defaults until the profile lands).

### 4.8 Live Broadcast / Report
Calibration is **shown, not hidden** — outputs, timings, and every chosen winner are broadcast. Same event stream, three sinks:
- **Server / headless:** structured log lines — one per pathway: `id · variant · median ns/op · CoV · ✔chosen | ✗rejected(reason)`. Plus a final table. Optionally writes fractal sample PNGs (`calibration-samples/seahorse.png`, …) so the operator can see what was tested.
- **TTY / native interactive:** a live progress view — the fractal datasets rendered as they generate, per-pathway bars filling with timings, the winner highlighted as each contest resolves.
- **Browser:** a visible "calibrating your machine" panel — the seahorse and Julia sets painted live, a race chart of backend/tier timings, and the final explicit choices ("this machine → AVX512-rsqrt · 8 encode threads · simd-mt tier"). Non-blocking; dismissible.

The broadcast emits from the same measurement events the profiler consumes, so what the user sees **is** what gets persisted — no divergence between the show and the decision. Verbosity is a flag (`--quiet` for pure-headless fleets; default verbose so first-run is legible).

---

## 5. The pathways (concrete registry — v1)

Throughput-relevant routes found in the codebase. `file:line` are current selection sites.

### Native (x86 server — PRIMARY)

| id | variants | selector site | accessible_if | bench |
|----|----------|---------------|---------------|-------|
| `native.backend.xyb` | scalar / AVX2 / AVX512 (+gather) | `perceptual/simd/mod.rs` `detect_native`, `resolve_backend` | CPUID AVX2 / AVX512F+BW | micro (xyb kernel) |
| `native.backend.rsqrt` | Strict vs Rsqrt (AVX2 & AVX512) | `simd/mod.rs` `prefer_rsqrt` | backend ≥ AVX2 | micro (scale_err) |
| `native.backend.blur` | scalar / AVX2 / (AVX512 reuse) | `perceptual/mod.rs` blur dispatch | CPUID AVX2 | micro (box_blur) |
| `native.backend.ssim/ssd` | scalar / AVX2 / AVX512 | `perceptual/mod.rs` | CPUID | micro |
| `native.telemetry.analyze` | scalar / AVX2 | `telemetry.rs` `analyze_fused` (~:314-334) | `is_x86_feature_detected!("avx2")` | micro |
| `native.tone.bulk` | scalar / AVX2+FMA | `tone_simd.rs` (~:95-123) | AVX2+FMA | micro |
| `native.decode.threads` | ST vs rayon-N | `jxl_casadecoder.rs` `with_threads` (~:321) | cores > 1 within cgroup quota | macro (djxl e2e) |
| `native.encode.threads` | ST vs rayon-N | `jxl_casaencoder.rs` `with_threads` (~:453) | cores > 1 within quota | macro (cjxl e2e) |
| `native.casv.enc.threads` | N via `CASV_ENC_THREADS` | `casa_video.rs` (~:833-842) | cores > 1 within quota | macro (video e2e) |
| `native.casv.stream.serial` | overlap vs serial | `casa_video.rs` `CASV_STREAM_SERIAL` (~:1319) | always | macro |

### Browser / WASM (secondary)

| id | variants | selector site | accessible_if | bench |
|----|----------|---------------|---------------|-------|
| `wasm.tier` | scalar / simd / simd-mt / relaxed-simd-mt | `facade.ts` `detectTier` (~:622-650) | WASM+SIMD probe; MT needs SAB+COI+Worker | macro (load+e2e) |
| `wasm.worker.pool` | pool size (replaces `min(HC,12)`) | `web/main.js` (~:64) | Worker available | macro grid |
| `wasm.worker.rayon` | per-worker thread count (replaces `HC`) | `web/worker.js` (~:182) | COI + `initThreadPool` | macro grid (joint with pool → fixes 144 oversubscription) |
| `wasm.corebudget` | global concurrent MT cap | `jxl-scheduler/budget.ts` (~:134) | — | derived from grid winner |

> The browser worker×rayon entries are calibrated **jointly** (a 2-D grid), because the pathological case is their product, not either alone.

---

## 6. First-run flow

```
start encode/decode
   └─ profile exists & signature matches & schema current?
        ├─ yes → apply overrides → run
        └─ no  → acquire calibrate lock
                   ├─ Accessibility Prober  → accessible pathway set
                   ├─ Micro bench           → backend-variant winners
                   ├─ Macro bench (grid)    → concurrency winners
                   ├─ CoV gate / re-run     → confidence per selection
                   ├─ write machine-profile.json (signature-keyed)
                   └─ release lock → apply overrides → run
```

Server: headless, logs a one-line summary per pathway (`chosen / measured / confidence`). Budget 1–3 min; if a measurement can't stabilise, that pathway keeps the safe prior and is flagged low-confidence.

---

## 7. Fallback prior (Approach C, demoted)

When calibration cannot run (locked, budget-starved, sandbox forbids timing) the selector falls back to:
1. any partial/low-confidence profile value, else
2. a small static prior table keyed by coarse signature (e.g. "AVX512 + ≥16 cores"), else
3. today's feature-presence default.

Never blocks the actual encode.

---

## 8. Server / VM specifics (primary target)

- **cgroup quota** is the effective core budget; read it (`/sys/fs/cgroup/...` cpu.max / quota) and clamp all thread counts to it. This is the single most important server correctness item.
- **Downclocking / gather cost** → AVX512 must earn its place by measurement, not presence. Micro-bench is decisive here.
- **Noisy neighbours** → median + CoV gate + bounded re-run; low-confidence flag rather than a confident wrong pick.
- **Fleet cloning / autoscaling** → signature-keyed profile with auto-invalidation; optionally `calibrate` at image-build **and** re-validate signature at boot.
- **No display / headless** → native path is CLI-first; no UI dependency.

---

## 9. Implementation phases (for the follow-up plan)

1. **Registry + Accessibility Prober + CI test** (native first). Delivers the "explicit routes" report and the accessibility guarantee with zero behaviour change.
2. **Fractal Corpus Generator + parity gate** (Rust). Deterministic datasets at arbitrary size; cross-backend byte-exact assertion doubles as a SIMD correctness oracle.
3. **Micro-bench harness + Live Broadcast** + backend-variant selection (rsqrt/AVX512) → profile write + `resolve_backend` override hook. Native. Broadcast shows every contest.
4. **Macro-bench grid** + native thread-count selection (encode/decode/CASV), cgroup-clamped.
5. **Profile store + signature + invalidation + Orchestrator** (`calibrate` subcommand + first-run auto-trigger + lock).
6. **Browser port**: fractal gen in TS (byte-matched to Rust) + tier confirm + worker×rayon joint grid (fixes 144 oversubscription) + live visual panel + persisted profile.
7. **Fallback prior table** + docs (the generated "routes" report checked into `docs/`).

Each phase is independently shippable and leaves the system correct if later phases never land.

---

## 10. Risks & limits

- **Compile-time-gated paths** only testable if built in. Mitigation: native compiles all x86 backends; WASM ships all tiers; CI accessibility test catches accidental exclusion.
- **Measurement noise on shared VMs** could mis-rank close variants. Mitigation: CoV gate; when winners are within noise, prefer the *safer* variant (strict over rsqrt; fewer threads over more) and flag low-confidence.
- **Browser timing is coarse/sandboxed** (`performance.now()` clamping, no CPUID). Browser profile is best-effort; its highest-value output is the concurrency fix, which is robust to coarse timers.
- **Profile drift** if hardware changes silently. Mitigation: signature recompute on every startup.
- **Scope creep into quality knobs.** Explicitly forbidden here; a future, separate design can address content-adaptive quality with golden-image gating.

---

## 11. Success criteria

1. A single command prints the full, explicit list of pathways and, per pathway, whether it is accessible on this machine and why. *(routes made obvious + accessibility proven)*
2. CI fails if any registry pathway becomes unreachable through a build mistake.
3. The fractal corpus generates byte-identical buffers in Rust and TS; the parity gate disqualifies any backend that fails bit-exact kernel output.
4. Calibration broadcasts per-pathway timings and the explicit chosen winner (log/TTY/browser), and what is shown equals what is persisted.
5. On a cold machine, first run produces a signature-keyed `machine-profile.json` within the 1–3 min budget, headless.
6. Runtime selectors demonstrably honour the profile (e.g. forcing a suboptimal backend via profile changes measured throughput).
7. On a container with a cgroup CPU limit, chosen thread counts never exceed the quota.
8. Browser worker×rayon product no longer oversubscribes (no 144-thread case); measured throughput ≥ current default on the test box.
9. Missing/stale/low-confidence profile never blocks or breaks an encode — clean fallback to today's behaviour.

---

## 12. Open questions (for implementation planning)

- Exact CoV threshold and re-run cap (tune against a real noisy VM).
- Corpus resolved: **procedural fractals** (seahorse/julia/burning-ship, optional dithered-entropy variant). Open sub-question: exact `max_iter`/zoom/palette per dataset, and whether the dithered variant is needed for the encode bench or fractals already stress entropy enough.
- Profile file location convention on the server fleet (per-node vs baked-at-image + revalidate).
- Whether `calibrate` should also emit a machine-readable capability report for fleet telemetry.
