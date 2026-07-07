# S5 Golden Approval Workflow

**Colour authority:** David (capebio@gmail.com)
**Threshold:** butteraugli < 0.05 = automatic pass; ≥ 0.05 = requires human sign-off.

This workflow is **advisory** — it is not a required CI gate until David explicitly approves it.
It exists to make colour-output changes visible and reviewable, not to block mechanical work.

---

## Purpose

S5 stages 2–4 (headroom-aware clamp, calibrated colour, EXR HDR) all produce intentional
pixel-output changes. This workflow gates those changes so they cannot land silently:

1. A numeric tripwire (`golden-check.mjs`) catches any accidental drift.
2. A visual viewer (`web/golden-review.html`) gives David a clear two-up diff.
3. An explicit `--update` step, performed only after sign-off, adopts the new output.

---

## Files

| File | Role |
|------|------|
| `docs/golden-corpus.json` | Machine-readable corpus list with pinned SHA256s |
| `docs/golden-corpus.md` | Human-readable corpus table |
| `scripts/golden-check.mjs` | CLI tripwire script |
| `web/golden-review.html` | Browser two-up viewer |
| `docs/golden-buffers/<id>.rgba` | Binary RGBA8 pixel buffers — **gitignored**, regenerated locally |

---

## When to run the check

Run `bun --smol scripts/golden-check.mjs` before any PR that:

- Modifies `src/lib.rs`, `crates/raw-pipeline/src/`, or any WASM-compiled Rust code.
- Changes colour-math, demosaic, tone, or white-balance logic.
- Bumps the shipped `web/pkg/` WASM binary.

It is **not** required for:
- Pure JS/TS changes that don't touch pixel output.
- Infrastructure-only changes (this branch is one such case).
- Changes to files outside the raw-pipeline crate.

---

## Running the check

```sh
# Normal check (advisory):
bun --smol scripts/golden-check.mjs

# Exit codes:
# 0 — all corpus files pass (or were skipped due to machine-gated paths)
# 1 — one or more files exceeded the threshold
```

### What the check does

1. Loads `docs/golden-corpus.json` (pinned SHA256s).
2. Decodes each corpus file via the shipped WASM pipeline at fixed neutral sliders
   (exposure=0, contrast=0, all tone adjustments=0, camera WB — no user overrides).
3. Computes SHA256 of the decoded RGBA8 buffer.
4. **If SHA256 matches** → score 0.0, instant pass (no buffer load needed).
5. **If SHA256 differs** and the golden buffer exists → runs butteraugli comparison.
6. **If SHA256 differs** and no golden buffer → FAIL with a message to run `--update`.

### Threshold override

```sh
GOLDEN_THRESHOLD=0.1 bun --smol scripts/golden-check.mjs
```

Default is 0.05. Changing the threshold is not a substitute for sign-off on visible changes.

---

## How to request sign-off

When `golden-check.mjs` exits 1 for a PR with intentional colour changes:

1. **Open `web/golden-review.html`** in a browser (serve the repo root with a local web server
   that sets COOP/COEP headers, e.g. `npx serve --cors`).
2. Load the RAW file from the corpus into the **LIVE** panel.
3. Load the corresponding `docs/golden-buffers/<id>.rgba` into the **GOLDEN** panel.
4. Screenshot the two-up view and the butteraugli heatmap.
5. Email or DM the screenshot to David (capebio@gmail.com) with:
   - Which S5 stage the change belongs to.
   - The butteraugli score.
   - A brief description of the intended colour difference.
6. David replies with sign-off (or requests adjustments).

---

## How to update goldens after sign-off

Once David has explicitly approved the colour change:

```sh
# Regenerate SHA256s and pixel buffers:
bun --smol scripts/golden-check.mjs --update

# Verify the check now passes:
bun --smol scripts/golden-check.mjs

# Commit only the JSON — the .rgba buffers are gitignored:
git add docs/golden-corpus.json docs/golden-corpus.md
git commit -m "chore(golden): update goldens after David sign-off — <brief description>"
```

The commit message must reference the sign-off. Include the butteraugli score and
a one-line summary of what changed (e.g. "headroom clamp +0.5 EV, butteraugli 0.012").

---

## Corpus files

See `docs/golden-corpus.md` for the full list. Current entries:

| ID | Format | Dimensions | Notes |
|----|--------|-----------|-------|
| P1110226-ORF | ORF | 5240×3912 | S4 parity anchor |
| PXL-20260527-DNG | DNG | 3628×2732 | S4 parity anchor (in git) |
| P2200407-ORF | ORF | 5240×3912 | Gobabeb herbarium, outdoor scene |

Files marked "machine-gated" (external to the repo) produce a SKIP warning on CI
and on other developers' machines. This is expected behaviour — the check is advisory
and the DNG entry is sufficient for CI.

---

## Machine setup (first use)

```sh
# Generate initial golden buffers (first run on a new machine):
bun --smol scripts/golden-check.mjs --update

# Verify:
bun --smol scripts/golden-check.mjs
# Should show: Results: 3 pass, 0 fail, 0 skip (or skip for machine-gated files)
```

The golden buffers (`docs/golden-buffers/*.rgba`) are large raw RGBA8 files
(~40–82 MB each) and are gitignored. They are only needed locally on the developer's
machine. Regenerating them takes ~3 seconds per file on a modern CPU.

---

## Design notes

- **Butteraugli**, not SSIM or PSNR: butteraugli models human perception more accurately
  for RAW output where the perceptual significance of a change matters more than
  its numeric magnitude.
- **SHA256 fast path**: if the pipeline is unchanged (most runs), the SHA256 matches
  instantly and butteraugli is not computed. This keeps the check fast.
- **Golden buffers are gitignored** to avoid committing ~200 MB of binary data.
  The JSON (with SHA256s) is the committed artefact; the buffers are generated locally.
- **Sliders are fixed at neutral**: comparing at neutral sliders ensures the check
  measures only pipeline changes, not user-adjustment semantics.
- **Colour authority**: David holds the final sign-off authority. No colour-output
  change should land on the main branch without his explicit approval.
