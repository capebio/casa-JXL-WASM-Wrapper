# Handoff — ORF baseline fix follow-ups (2026-07-29)

> **STATUS UPDATE (2026-07-29, later session): items 1–6 done, item 7 not done.**
> - **Item 2 landed**: `ORF_BASELINE_EXP_EV = 1.6` for native-ISO ORF via new
>   `pipeline::orf_baseline_ev(iso)` (LOW < 200 → 0.40, native → 1.6, unknown →
>   legacy 1.40), wired at all 5 ORF ingest sites. Corpus census: mean |Δ luma|
>   vs embedded 6.2 → **2.0**, mean Δ +0.5, worst +6.7 (P2200717, dark frame).
>   CR2/DNG proven untouched (highlight_tune rows identical, DNG parity hash
>   unchanged). HIGHLIGHT_KNEE kept at 0.68 — %clip already runs above embedded
>   on P2200637 (1.37 vs 0.21); moving the knee toward 0.80 would raise it.
> - **Item 1 landed**: `pipeline::apply_chroma_nr` (5-tap gaussian on chroma,
>   per-pixel linear luma restored exactly) at `ORF_BASE_ISO_CHROMA_NR = 0.3`,
>   applied in `finish_from_raw` + `decode_orf_rgba8` + `green_probe` for
>   iso < 1600. Swept 0/0.3/0.5/0.7/1.0 on lin16 dumps (sim validated 0.25/255):
>   0.3 is the optimum before blur starts spreading railed glints. Real-render
>   census: corpus sparkle/MP 238 → **183**, P2200592 89 → **75** (acceptance
>   ≤ 114 = 2× libraw ref ✓), P2200610 2101 → 1631 (remaining = real droplet
>   speculars, eyeball-confirmed), flat-patch chroma σ 1.25 → 1.03 at 1:1.
>   Camera still smoother at matched scale (1.23 vs 0.52) — upgrade path is
>   edge-aware/median chroma suppression, marked in the code.
> - **Item 3 landed**: trailing `Option<f32> baseline_ev` on
>   `process_raw_mosaic_with_flags/_with_options/create_raw_mosaic_denoise_session`;
>   `worker.js mosaicBaselineEv()` passes 0.4 for Olympus ISO<200 LibRaw payloads.
> - **Item 4 landed**: `decode_orf_rgba8` now app-representative (black=256,
>   camera WB + gray-world fallback, 0x1011 matrix, WB-scaled MHC gains, chroma
>   NR). parity_corpus ORF pin re-recorded (see lineage in S1-timings-report.md);
>   highlight_tune P1110226 row went 143 (misleading) → 91 (real).
> - **Item 5 landed**: 23 `required-features = ["jxl-codec"]` stanzas
>   (raw-pipeline tests/examples) + root-crate `raw_decode_bench` gate +
>   bit-rotted `dng_mhc_interior_flip` fixed (MhcGains arg). Both
>   `cargo check --tests --examples --no-default-features --features parallel`
>   and `cargo check --target wasm32-unknown-unknown` are green.
> - **Item 6 closed as far as locally possible**: new `examples/orf_iso_scan.rs`
>   swept all 284 library ORFs — every one is E-M1MarkIII (43 LOW / 241 native);
>   no ISO-64 files, no other bodies to validate against.
> - **Item 7 not done** (viewer toggles — untouched).
> - web/pkg NOT rebuilt; run wasm-pack to ship the new exports/params.

## Context (done, committed)

`d8579328` on main fixed the green-sparkle / blown-highlight complaint: Olympus
extended-LOW ISO (< 200) ORFs are exposed ~+1 EV hot and the camera pulls them
back in its JPEG engine; our fixed `+1.40 EV` baseline skipped the pull.
Landed: `PipelineParams.baseline_ev` (default 1.40, CR2/DNG + native-ISO ORF
byte-identical), `ORF_LOW_ISO_BASELINE_EXP_EV = 0.40` gated on `info.iso < 200`
at every ORF ingest, threading through `ProcessResult.baseline_ev_used` /
`LookRenderer` / `apply_look` (trailing `Option<f32>`, `undefined` = legacy),
plus the prior session's WB-scaled MHC gains. `16de7c16` parked unrelated WIP.
Nothing pushed.

Result on the Gobabeb corpus vs embedded JPEG: mean |Δ luma| 31.4 → 6.2;
ISO-100 frames within −0.4..−2.8 (P2200592: 129.8 vs 130.2, near-white 0.137%
vs 0.136%). 476 raw-pipeline tests pass.

Memory file with full causal chain:
`~\.claude\projects\C--foo-bliss\memory\raw-converter-green-sparkle-root-cause.md`

## Tooling (all preserved)

- `crates/raw-pipeline/examples/green_probe.rs` — mirrors the app's default ORF
  render; dumps `<stem>.mosaic`, `<stem>.lin16`, `<stem>-render.png`,
  `<stem>-meta.txt` (per-CFA-class raw histogram tail = true saturation).
  `cargo run --release --no-default-features --features parallel --manifest-path
  crates/raw-pipeline/Cargo.toml --example green_probe -- <orf> <out_dir>`
- `tools/green-probe-scripts/` — the python analysis set (needs numpy+PIL):
  `extract_embedded.py` (largest valid embedded JPEG), `census_corpus.py`
  (renders vs embedded: luma / %≥240 / sparkle-per-MP), `stage_sim.py`
  (exact numpy replica of the tone chain, validated 0.25/255 vs the renderer —
  use for stage ablations), `ev_sweep.py`, `smoothness_probe.py` (noise σ),
  `build_viewer_imgs.py` (viewer assets), `final_compare.py`, `analyze.py`
  (sparkle classification vs raw mosaic). Paths near the top of each are the
  old session scratchpad — pass dirs as args / adjust before use.
- Comparison viewer: `C:\foo\bliss\evfix-comparison\index.html` + `img/`
  (synced 4-way pan/zoom, all 11 corpus files; q92 4:4:4 assets).
- Corpus: `C:\Foo\raw-converter\tests\Gobabeb 10\*.ORF` (10 files) +
  `C:\995\2026-02-20 Gobabeb To Windhoek\P2200592.ORF`.
- highlight_tune harness prints get eaten by the RTK cargo proxy — run the
  built test exe directly:
  `crates/raw-pipeline/target/debug/deps/highlight_tune-*.exe --nocapture`.

## Follow-ups, priority order

### 1. Base-ISO chroma NR (closes the "camera looks smoother" gap + residual sparkles)
Camera JPEG chroma noise σ 0.52 vs our render 1.25 (flat-patch, P2200592) —
in-camera NR, not decode quality. Residual green speckle lives in chroma too:
matched-scale sparkles 89/MP (P2200592) and 2371/MP (P2200610 flower glints)
vs camera ~0.5. Add a mild chroma-only NR at base ISO behind the existing
`iso_nr_strength` machinery (`src/lib.rs`, currently 0 below ISO 1600); do NOT
touch luma (eats real detail). Acceptance: corpus sparkle/MP within ~2× of the
libraw reference (57/MP on P2200592) with no visible luma softening at 1:1;
re-run `census_corpus.py` + eyeball the viewer.

### 2. Native-ISO ORF baseline retune (1.40 → ~1.55–1.6)
All ISO 200/400 Gobabeb frames sit −8..−12 luma vs embedded at legacy 1.40;
measured optimum on P2200500: 1.4 → 123.8, **1.6 → 134.7 vs embedded 134.1**.
One constant (`BASELINE_EXP_EV` stays for CR2/DNG — introduce an ORF-native
value instead, e.g. `ORF_BASELINE_EXP_EV = 1.6`, keeping the LOW-ISO 0.40).
CAUTION: verify CR2/DNG stay byte-identical (highlight_tune before/after) and
check `HIGHLIGHT_KNEE = 0.68` interplay (it was tuned against the 1.4 push —
comment above it in pipeline.rs; consider re-tuning toward its old 0.80 for
ORF-native if near-white %clip allows). Full corpus census as gate.

### 3. Thread baseline through the generic mosaic + raw-video paths
`process_raw_mosaic_*` wasm exports and ORF timelapse frames still render at
legacy 1.40 regardless of ISO (`src/lib.rs` ~5074/5237/5704 build params from
scratch). Add trailing `Option<f32> baseline_ev` mirroring `apply_look`, and
pass it from the JS callers for ORF sources. Only matters if raw-video /
LibRaw-fallback tone fidelity matters.

### 4. Fix `decode_orf_rgba8` to be app-representative
`crates/raw-pipeline/src/tiff.rs`: it never sets black=256, camera WB, or the
0x1011 matrix — so the highlight_tune ORF row renders with defaults and its
absolute numbers are misleading (P1110226 shows 143 there but is fine in-app).
Set the same fields `decode_orf_raw` sets (it already gates baseline on ISO).

### 5. Repair `--no-default-features` test/example builds (pre-existing)
`tests/cr2_stream.rs`, `tests/dng_stream.rs` and examples `fable_golden`,
`pipeline_section_bench` (+ possibly more) import jxl-gated modules
(`stream_export`, `casa_video`, `jxl_casadecoder/encoder`) without
`required-features` entries, so plain `cargo test --tests` aborts before
running anything. Add `[[test]]/[[example]] required-features = ["jxl-codec"]`
stanzas in `crates/raw-pipeline/Cargo.toml`.

### 6. Validate the ISO < 200 gate on other bodies
Assumption validated on E-M1 III only (base ISO 200, LOW = 100). If ISO-64 LOW
files or other Olympus bodies exist in the library, run green_probe + census on
a couple. `iso: None` falls back to legacy 1.40 (safe direction).

### 7. Optional viewer niceties
"Match camera scale" toggle (downscale our panels to 3200w for apples-to-apples
noise comparison), A/B flicker between two chosen panels. The camera panel is
sharpened+NR'd 3200w — current viewer note explains this but a toggle shows it.

## Open decisions for David

- Push the two commits?
- The 78 untracked files in raw-converter-wasm (benchmark scripts, fixtures,
  `jpegxl-src-patched/`, `tools/green-probe-scripts/`, `tests/`) — add any?
- Item 2 changes the look of every native-ISO ORF render (brighter, closer to
  camera) — want that, or is current darker rendering preferred as a base look?
