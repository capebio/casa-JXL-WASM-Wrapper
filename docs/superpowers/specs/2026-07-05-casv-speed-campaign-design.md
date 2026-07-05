# CASV Speed Campaign — Design

Date: 2026-07-05
Branch: `perf/casv-speed-campaign-jul05` (worktree `C:\Foo\rcw-casv-speed`), cut from `perf/casv-video-simd-v2-jul05`.

## Goal
Speed up the CASAVA video codec at the between-files / architecture level, add lossy quality↔time
tradeoff controls to the encode path + lightbox, and mine the decode path. Every cohesive change is
flipflop-gated (interleaved A/B, per rejection-log methodology) and byte-exact unless it is an
explicit, quality-gated lossy tradeoff.

## Constraints (from `docs/1 rejected optimizations.md` + design specs)
Do NOT re-propose (rejected/blocked): additive lossy residual, `JXL_BLEND_ADD` as prediction,
per-block motion comp, multi-reference/background modelling, persistent cross-frame atlas,
cross-frame encoder-state plumbing for memory-bound counts, by-value-drop memory schemes on WASM.
Already landed (not open): encoder-handle + per-frame scratch reuse (JOLT stream), frame-parallel
batch, JE-8 square atlas, fresh-pixel REPLACE-skip, per-GOP rate control.
Invariants: every frame is an independent JXL codestream (Architecture A); single-reference;
drift-free spine; decode is the only real-time budget (~41.6ms/frame @24fps).

## Phase 1 — CV-E6: MT libjxl runner for per-frame encode
JE-8 square-atlas removed the 32px-sliver blocker that starved threads. Re-enable a multi-threaded
libjxl ParallelRunner on the dominant P-frame atlas encode and the I-frame chunked encode.
- Files: `jxl_casaencoder.rs` (runner plumbing), `casa_video.rs` streaming/batch call sites.
- Gate: byte-exact (determinism proven for JE-8) + flipflop wall-clock, idle HW, interleaved.
- Expectation: helps the STREAMING path (one frame at a time → cores idle); batch already rayon
  frame-parallel so likely a wash there. Flipflop decides scope.

## Phase 2 — Lossy tradeoff controls (4 knobs + lightbox)
- 2a Chroma subsampling: new `EncodeOptions` field → libjxl cparam (4:4:4/4:2:2/4:2:0). Per-frame.
  Plumb `CasaVideoOptions` + `casv_encode.rs` CLI + lightbox.
- 2b Speed slider (0–100): `casv-lightbox-core.js` maps one knob → {effort, distance, thresh, subsample}.
- 2c 'Fast' preset: new `JoltPreset` variant (low effort + high thresh + 4:2:0 + coarse distance).
- 2d Low-res preview/proxy tier: fast downscaled encode for scrub/edit (doubles as real-time
  video-editor preview); full-res on export. New CLI mode + lightbox "preview quality" toggle. Last.
- Gate: per knob, flipflop the tradeoff — encode-time delta vs Butteraugli/SSIM delta; report
  "worth it?". No silent quality edits (golden-gated).

## Phase 3 — Decode-path speedups
Mine the un-mined per-frame djxl + reconstruct seams across `jxl_casadecoder.rs` + `casa_video.rs`
decode. Meta/cross-file. Flipflop-gated, byte-exact.

## Success criteria
- 40/40 casa_video tests green each phase.
- Each landed change has a flipflop journal showing the win (or the tradeoff table for lossy knobs).
- Nothing pushed without user approval; commit per cohesive change.
