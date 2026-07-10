# AI Identification Bake-off

Empirical test: which plant/animal ID service responds, responds **best**, and
responds **fastest** for our RAW photos. The result drives the design of the
eventual "AI-optimized export" foundation in the JXL converter.

**Pathway proven here:** RAW (CR2/DNG) → extract embedded preview JPEG → POST to
each ID service. No full pipeline decode; the camera's embedded preview is a
realistic, instant proxy (exactly the derivative concept the export will emit).

## Services

| Service | Scope | Auth | Notes |
|---|---|---|---|
| Pl@ntNet | plants only | free API key (`PLANTNET_KEY`) | clean REST, 500/day |
| iNaturalist | plants + animals | OAuth JWT (`INAT_TOKEN`, ~24h) | CV `score_image`; optional GPS prior |
| Google Lens | everything | none | headful Playwright, **best-effort/brittle** |

## Setup

```
cp .env.example .env      # fill PLANTNET_KEY + INAT_TOKEN
```

- Pl@ntNet key: https://my.plantnet.org/
- iNat token: https://www.inaturalist.org/users/api_token (copy `api_token`)

## Run

```
node run-bakeoff.mjs                 # all services with available creds
node run-bakeoff.mjs --only plantnet,inat
node run-bakeoff.mjs --no-lens       # skip the headful browser
node run-bakeoff.mjs --dry           # extract previews only, call nothing
node run-bakeoff.mjs <file1> <file2> # override the test corpus
```

Outputs (gitignored) land in `work/`:
- `*.preview.jpg` — extracted previews
- `results.json` — full structured results
- `bakeoff-report.md` — per-image comparison table + summary
- `lens-*.png` — Lens screenshots (debug)

## Files

- `extract-preview.mjs` — pure-Node embedded-JPEG extractor (picks largest
  *viewable* baseline/progressive stream; skips lossless raw). Also a CLI.
- `services/*.mjs` — one client per service, uniform `identify()` interface.
- `run-bakeoff.mjs` — orchestrator: extract → call → time → report.

## Known limits

- Pixel DNGs embed only a ~1280px preview (full-res is tiled lossless); fine for
  ID (models downsize). Canon CR2 embeds a full 6000×4000 preview.
- CR2 previews are ~6–7 MB; if a service rejects large uploads, add a resize step.
- Lens automation is undocumented and may break, hit consent walls, or CAPTCHA.
