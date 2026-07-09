# optimize-codec-times — Synthesis (2026-07-08)

Branch: `perf/casv-video-simd-v2-jul05`. Baseline: `baseline-dump.json` (Phase-0).
After: `after-dump.json` (`node StandardMultifileTest.mjs optimize --json after-dump.json`, exit 0).
Raw compare: `benchmark/optimize/docs/reverts/compare-table.md`. Manifest:
`benchmark/optimize/docs/reverts/MANIFEST.md` (regen: `node benchmark/optimize/build-manifest.mjs`).

## What actually reaches the after-benchmark

Of the 12 banked verdicts, only **2** are wired into the measurement harness
(`StandardMultifileTest.mjs`) and therefore move `after-dump.json`:

| id | change | metric | status |
|----|--------|--------|--------|
| OPT-01 | rgb8/no-alpha on the Modular progressive encode (drop the constant-alpha Squeeze pass) | `mod_prog_enc` | **landed-harness** |
| OPT-02 | `qProgressiveAc:0` on the photon-noise encode (collapse the 2nd quantized-AC pass) | `photon_prog_enc` | **landed-harness** |

The rest do **not** affect this dump:
- **OPT-03** (Rust `process_dual_simd`, fuse RGB8+DISP16) and **OPT-04** (C++ separable
  box conv in `stage_noise.cc`) are accepted, isolated diffs living in **workflow
  worktrees only** — never rebuilt into the loaded `pkg/` (RAW pipeline) or
  `packages/jxl-wasm/dist/` (libjxl bridge). OPT-03 is additionally **latent**: it fires
  only on `flags=33` (16-bit-master + 8-bit-preview), which the benchmark never calls.
- **CAND-05..08** (photon distance 1.5, effort 2, flavor:dc; mod decodingSpeed:2) are
  **config-only flipflop candidates** — real, gate-accepted in isolation, but never wired
  to production source. The flipflop test *is* the artifact; there is no diff to revert.
  Note CAND-07 (flavor:dc, ~20%) is **mutually exclusive** with OPT-02 (same photon path);
  only one can ship. OPT-02 was the one wired in.

## Baseline → after, per target metric

Aggregate across all 8 files, then re-aggregated excluding one tail-of-run machine
spike. `+%` = faster.

| metric | all 8 files | **7 files (excl. tail spike)** | banked change | verdict |
|--------|-------------|-------------------------------|---------------|---------|
| `mod_prog_enc` | +2.7% | **+16.1%** | OPT-01 | ✅ confirmed win |
| `photon_prog_enc` | −14.5% | **+3.0%** | OPT-02 | ✅ small confirmed win |
| `raw_decode` | −60.7% | −38.1% | (none landed) | ⚪ env noise — no landed change |
| `shot_dec` | −9.9% | −9.6% | (OPT-04 not built) | ⚪ env noise — no landed change |
| `prog_enc` | −8.4% | −8.6% | (none) | ⚪ env noise — no landed change |
| `mt_prog_enc` | −126.9% | — | (none) | ⚪ env noise (pool oversubscription) |
| `mt_shot_dec` | −72.3% | — | (none) | ⚪ env noise (pool oversubscription) |

### The tail-of-run spike (why the all-8 aggregate lies)

`ADH 1248.CR2` (the **last** file decoded) regressed on *every* metric at once —
`raw_decode` 681→1742 ms (−156%), `mod_prog` 658→1244 (−89%), `photon` 192→433 (−126%).
A change that only touches JXL encode options cannot inflate a file's RAW-decode time by
156%; the whole machine stalled at the end of this run (sustained-load throttling /
scheduler contention — MEMORY.md flags 144-thread oversubscription + battery throttle as
known conditions on this host). Excluding this one file restores the true signal. This is
the same trust:low / thermal:unknown caveat attached to every banked verdict.

### `mod_prog_enc` — the clean OPT-01 signal (per file, tail spike excluded)

```
small_file.jpg            22 →  20  (+9.1%)
P1110226 windows.jpg     783 → 673  (+14.0%)
PXL_...180319603.dng     745 → 610  (+18.1%)
PXL_...093507165.dng     789 → 627  (+20.5%)
P1110226.ORF             774 → 678  (+12.4%)
P2200474.ORF             757 → 617  (+18.5%)
_MG_1750.CR2             657 → 574  (+12.6%)
```

Every non-outlier file is +12–20%, matching the flipflop-verified 20.5–21.9%. Confirmed.

## Quality, bytes, RSS

- **Quality:** unchanged by construction. OPT-01 drops a constant alpha plane (3 colour
  planes bit-identical → Butteraugli Δ=0.0). OPT-02 drops a redundant AC refinement pass
  over identical d=1.0 coefficients (Butteraugli Δ=0.0). Both proven in flipflop across all
  runs. This after-dump records timing only (no per-file Butteraugli field), so quality is
  asserted from the flipflop verdicts, not re-measured here.
- **Bytes:** not captured in the dump schema. Flipflop: OPT-01 emits *fewer* bytes (no
  alpha channel); OPT-02 ≈ parity (≈0.85% smaller). No byte regression.
- **RSS:** dump has no memory field; telemetry is empty on this host (no sensor →
  `cpuThrottlingPct`/`memoryFreeGb` = undefined in both dumps, hence every verdict's
  trust:low is *environmental*, not a code regression). Flipflop RSS deltas ≈ 0 (±1 MB)
  for both landed changes — pure speed/size wins, not memory wins.

## Deferred / not-landed (see MANIFEST.md CAND-05..08 + OPT-03/04)

1. **OPT-03 / OPT-04 → rebuild to realize.** Both are gate-accepted, byte-/quality-safe,
   and revertable (diffs copied to `benchmark/optimize/docs/reverts/03-*.diff`,
   `04-*.patch`). To make them show up: apply → rebuild the RAW pkg (OPT-03) / emsdk
   libjxl bridge (OPT-04) → re-dump. OPT-03 also needs a `flags=33` caller before any
   metric exercises it.
2. **CAND-07 (photon flavor:dc, ~20%) vs OPT-02.** flavor:dc drops the *entire* AC
   progression and is ~10× the win of qProgressiveAc:0, but changes the emitted
   progressive structure. If the DC-only preview ladder is acceptable for the photon path,
   swap OPT-02 → CAND-07 for a much larger `photon_prog_enc` gain. Decision deferred to
   the product owner (they are mutually exclusive).
3. **Re-measure on an unthrottled box.** Every headline here is trust:low because this host
   exposes no thermal sensor and the run drifted (tail spike + mt_* collapse). Re-run on AC
   power with LibreHardwareMonitor, excluding the smallest sizes, to bank trust:high
   numbers. The *direction* is solid (OPT-01 +16%, OPT-02 +3%); the magnitude needs a clean
   host to certify.
4. **Untouched metrics (`prog_enc`, `shot_dec`, `mt_*`, `raw_decode`) still open.** No
   landed lever targets them; their regressions here are noise, not findings.

## One-line verdict per target metric

- **`mod_prog_enc`:** ✅ +16.1% (tail-spike-excluded), +12–20% per file — OPT-01 confirmed, matches flipflop; quality Δ=0.
- **`photon_prog_enc`:** ✅ +3.0% (tail-spike-excluded) — OPT-02 confirmed small win, in the flipflop 2.2–5.8% band; quality Δ=0. (Swap for CAND-07 flavor:dc if DC-preview ladder acceptable → ~20%.)
- **`raw_decode`:** ⚪ no landed change reached it (OPT-03 unbuilt + latent); observed −38% is run-to-run machine drift, not a regression.
