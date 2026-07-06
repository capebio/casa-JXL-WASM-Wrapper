# Wave-2 — Deferred questions (user judgment calls)

Items an autonomous session flagged rather than deciding. Each has options + a recommended default;
where a reversible default was taken, it is marked. Challenge/revert freely.

## S1 — raw-pipeline fork unification

Context: `docs/S1-G1-report.md` (G1 trial complete; canonical crate is a −6 %, parity-clean,
compile-verified superset of the vendored fork and of nearly every holo win). These are the
per-item decisions that block G2 or that change user-visible output.

### S1-Q1 — Adopt canonical's tone rendering as the app ingest? (report §4 / §8-A)
- **Fact:** canonical `PipelineParams::default_olympus()` runs a richer tone chain (tone matrix +
  saturation/vibrance + unsharp LUT) absent from the old fork → images differ visually (more accurate
  colour), tone stage +40 % (pipeline still −6 % end-to-end).
- **Options:** (a) adopt canonical tone as ingest after a one-time visual sign-off *(recommended)*;
  (b) keep old-fork tone semantics behind a flag for a transition period; (c) block cutover until a
  per-camera golden set is approved.
- **Default taken:** none applied — this is the one behaviour delta that must not be adopted silently.
  Matches STRATEGIC-MAP open decision #2 (behaviour-reconciliation policy).

### S1-Q2 — Demosaic colour/quality holo items (report §6.3 / §8-B)
- **Fact:** three MISSING holo changes alter decoded pixels: CFA-aware bilinear borders (1 px ring);
  **symmetric MHC B-at-R correction (~25 % of pixels, frame-wide colour shift)**; `MhcKernel::Canonical`
  (Malvar) opt-in variant. Canonical is deliberately asymmetric/clamped today. The wasm-SIMD128 MHC
  perf win is baked onto the symmetric formula, so it cannot be adopted byte-exact without either the
  colour change or a re-derivation against canonical's asymmetric kernel.
- **Options:** (a) route all three through **S5 (scene-referred colour)** with golden-image sign-off
  *(recommended — the user is strict on colour parity)*; (b) adopt as canonical behaviour now (they are
  arguably more correct); (c) keep canonical as-is and only re-derive the wasm-MHC perf against the
  asymmetric kernel (perf without colour change).
- **Default taken:** none — not ported. Deferred to S5.

### S1-Q3 — Identity-downscale black-frame fix (report §6.4 / §8-C)
- **Fact:** canonical's exact-factor downscale computes reciprocal `(1<<64)/1 = 0` for an identity
  resize → **black output**. The holo `sw==dw && sh==dh → copy_from_slice` guard fixes it but changes
  the identity-case pixels (black → correct).
- **Options:** (a) port the guard after confirming reachability from live call sites *(recommended — if
  callers guarantee `dw<sw` the bug is dormant and the guard is harmless belt-and-braces)*; (b) leave as
  a documented latent bug; (c) fix by special-casing `n_px==1` in the reciprocal path instead.
- **Default taken:** none — not ported (output-changing; strict-parity mandate). Written up as a G2 task.

### S1-Q4 — G2 destructive steps (report §7)
- **Fact:** vendored-copy deletion, GPL `jpegxl-rs`/`jpegxl-sys` removal, and dependency packaging are
  all G2 and mostly live in the **app repo** (out of this worktree).
- **Options / recommendation:** proceed with G2 in the report's order — packaging (git-dep + tag pin) →
  `.cargo/config.toml` (`target-cpu=native`) → app builds green → vendored deletion (keep a revert tag)
  → GPL removal (migrate `encode_rgba16_jxl` + pyramid client to the BSD `jxl_casaencoder` shims) →
  freeze rule. ~4–6 engineer-days excluding user-gated colour work.
- **Default taken:** none — G2 is a separate user-approved handoff; not started.
