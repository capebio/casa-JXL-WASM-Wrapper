# Wave-2 — Deferred questions (user judgment calls)

Autonomous overnight runs park user-only decisions here instead of blocking.
Each item: context → options → **recommended default**. David can override any.

---

## S5 — Scene-referred colour core

Stage 1 (typed `ColorMatrix` + `ColourPolicy` owner + `wb_from_camera`) landed
byte-neutral on `s5/wave2-overnight` (commits `7cad3600`, `404de84c`, `5a37869d`;
proof in `docs/HANDOFF-S5-colour-core-2026-07-06.md`). The questions below gate the
*output-changing* stages 2–4.

### S5-Q1 — Golden-approval workflow (BLOCKS stage 3)
Strategic-map open decision #4. Intentional colour shifts need a sign-off process.
- **Options:** (a) checked-in golden PNG corpus + per-image human diff review on a
  named viewer; (b) numeric gate (ΔE/butteraugli threshold) auto-approved under a
  bound, human review above; (c) both — numeric gate as tripwire, human on trips.
- **Recommended default:** (c). Viewer = the shipping web lightbox at fixed slider
  defaults (matches what users see). Define the corpus from the S4 golden set.
- **Owner to name:** who is the colour authority (David?) for sign-off.

### S5-Q2 — Re-enable CR2 per-model matrices (stage 2)
`cr2::canon_cam_xyz` returns `None` on purpose: the WB-first pipeline applies WB
gain *before* the matrix, so raw XYZ→cam matrices channel-collapse (e.g. G→0 on the
550D). Proper fix needs scene-relative WB from the matrix's implied D65 neutral
(cr2.rs:300 note).
- **Options:** (a) ship linear-16 mode first (additive, opt-in), leave CR2 matrices
  disabled until the WB-normalization is designed; (b) do the WB-normalization
  rework and re-enable CR2 matrices together in stage 2.
- **Recommended default:** (a). Linear-16 is additive and unblocks photogrammetry/ML
  without touching default CR2 colour. Re-enable is a separate, golden-gated PR.
- Hook ready: `ColourPolicy::resolve(embedded, per_make)` — pass the Canon table as
  `per_make` when re-enabling.

### S5-Q3 — Consume `wb_from_camera` (output-changing)
The flag is surfaced but unread. Most valuable use: when `false` on CR2 (2.0/1.7
fallback fired), fall back to gray-world instead of the magic constants.
- **Options:** (a) leave unread (metadata only); (b) gray-world when
  `!wb_from_camera`; (c) expose in the WASM `*_meta` result so the UI can warn.
- **Recommended default:** (a) tonight (done). (c) is low-risk next (informational).
  (b) is output-changing → stage-2/golden-gated.

### S5-Q4 — Headroom-aware clamp deferral (stage 3)
Moving the pre-LUT [0,1] clamp past matrix+highlight stages changes highlight
rendering on *every* image (the most visible stage-4 item).
- **Options:** (a) keep current clamp until S5-Q1 workflow exists; (b) prototype
  behind a default-OFF flag and A/B on the golden corpus; (c) adopt as the new
  reference pipeline after sign-off.
- **Recommended default:** (a) now → (b) once the workflow lands → (c) on approval.

### S5-Q5 — Home for the colour types
`ColorMatrix` / `ColourPolicy` currently live in `pipeline.rs` (next to
`CAM_TO_SRGB`, cohesive, lowest-churn). Strategic map frames S5 as a "colour core".
- **Options:** (a) keep in `pipeline.rs`; (b) extract a `colour.rs` module owning
  `ColorMatrix`, `ColourPolicy`, `CAM_TO_SRGB`, `IDENTITY_3X3`, and (stage 2) the
  `RawImageMeta` colour/level fields.
- **Recommended default:** (a) for now; do (b) when stage 2 adds linear-mode +
  black/white/iso/bits types (natural moment to carve out the module).
