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

## Outcomes (2026-07-05)

**Phase 1 — LANDED @ac19b268.** Thread the streaming I-frame encode only
(`encode_chunked_threaded`, auto = available_parallelism, `CASV_ENC_THREADS`
override). Byte-identical across thread counts. Flip (casv_mt_flip): all-intra
1.49×, low-motion GOP24 1.12×, high-motion 1.08×, 4K 1.21×. Blanket per-frame MT
(CV-E6) re-confirmed as a loss on the sub-group P-atlas — JE-8 fixed the sliver
shape, not the sub-group size; only the reliably-large I-frame is threaded. Batch
encoders left alone (already rayon frame-parallel).

**Phase 2a — LANDED @2fbce0da.** `EncodeOptions.resampling`/`.decoding_speed`
(applied only when `Some`, default output byte-identical). No public
chroma-subsampling knob exists in libjxl 0.12; RESAMPLING is the superset but
factor 2 is a size-not-speed lever (measured ~5× slower — libjxl runs an
upsample-aware encode), only factor 4 is faster. Reaches the Encoder path
(image/all-intra/P-atlas); the streaming I-frame + video resolution stay on the
existing `dim` downscale (avoids the 7-caller chunked signature ripple).

**Phase 2b–d — LANDED @add65bec.** Lightbox encode-speed slider + preview-proxy
button, both driving existing request fields (no new Tauri args). `speedToSettings`
spans the existing Quality↔Realtime preset range (monotone; the wider range was
measured non-monotone and pushed default quality below Balanced — rejected).
`PROXY_PRESET` = 720p via `dim` = the real-time scrub/edit proxy. Tradeoff table
(casv_speed_flip): speed 0→100 = 1.53× faster, −49% size, −5.6 dB PSNR, monotone.
20/20 JS unit tests.

**Phase 3 — NO CHANGE (negative result, evidence in casv_decvid_flip).** The
decode path is already at its floor: in-place P-frame reconstruct (`apply_pframe`,
`prev:&mut[u8]`), per-frame buffer reuse, SIMD residual-add, and a threaded
variant for large frames. Threading the *sequential* decode by default regresses
the common case — 720p 0.50×, 1080p ~0.68×, only 4K wins (1.79×) — because djxl
decode is light + bandwidth-bound and a sub-4K frame is too small for the
per-frame runner. The single-threaded default is correct; not changed.
