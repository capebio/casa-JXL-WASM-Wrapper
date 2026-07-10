# AI Identification Foundation — Design

Date: 2026-07-10
Status: Draft for review

## Goal

Make the RAW→JXL converter **facilitate** external AI plant/animal identification —
without implementing any classifier. The pipeline should:

1. Preserve and expose the signals an ID system needs (geolocation, capture metadata,
   colour space) as a stable, machine-readable **sidecar** beside each archival JXL.
2. Generate an **ID-ready JPEG proxy on demand** (never stored per-image) from the
   cheapest available source, so any external service or user pipeline can identify
   an image with best accuracy and minimal cost.

Identification itself (calling iNaturalist / Gemini / Pl@ntNet, or a local model) is
done by *other* code outside the JXL wrapper. The reference client already exists in
`ai-id-bakeoff/` and is the empirical basis for this design.

## Constraints

- **No classifier, no bundled model, no required network** in the core pipeline.
- Reuse existing machinery: RAW decode (`pkg/`), `downscale_rgb`, the libjxl facade,
  the JXL pyramid (`pyramid-ingest`), and `ExifData` (`crates/raw-pipeline/src/exif.rs`).
- **Additive** — must not change existing export behaviour.
- Metadata schema is **versioned and additive-only** so a future "embed metadata inside
  the JXL" step can reuse the same field set without breaking consumers.
- **Never persist a per-image proxy.** Identification is a rare one-off; standing proxy
  storage (~115 KB × N) is wasted ROI. Persist only the tiny metadata sidecar.

## Empirical basis (bake-offs, 2026-07-10 — see `ai-id-bakeoff/work/`)

| Decision | Result | Evidence |
|---|---|---|
| Archival master | **JXL** (our encoder) | ~2.7× smaller than PNG lossless |
| AI proxy format | **JPEG** | iNat/Gemini/Pl@ntNet accept JPG/PNG only, not JXL |
| Proxy size | **768 px long-edge** | iNat flat ≥512; Gemini needs ~768 for species-level |
| Proxy quality | **q80** | ID flat across q50→q95 |
| Chroma | **4:2:0** | equals 4:4:4 for ID, ~25 % smaller |
| Downscale | **direct** (`downscale_rgb`) | cascaded pyramid blur lowers ID confidence / misfires |
| Metadata | **GPS + capture** | iNat accepts `lat`/`lng` → accuracy lever |

**Canonical proxy: 768 px long-edge · JPEG q80 · 4:2:0 · ~115 KB.**

Google Lens is not usable (reCAPTCHA bot-block, confirmed). Services covering both
plants and animals: **iNaturalist** (primary, GPS-aware) and **Gemini** (`gemini-2.5-flash`);
Pl@ntNet is a plants-only second opinion.

## Components

### 1. Metadata sidecar — `<name>.ai.json` (schema `casava-ai/1`)

**Lean and ID-focused.** The sidecar carries only what identification needs *and* what is
not trivially already in the source EXIF. Photographic/archival EXIF (camera, lens, ISO,
exposure, f-number, focal length) is **deliberately excluded** — it is not an ID signal,
it stays in the master RAW, and it is the job of the (reserved) "embed EXIF into the JXL"
follow-up to preserve it on the output side. The sidecar is a *consumption projection*,
not an EXIF copy.

Assembled in JS from the decoded WASM result (which exposes `gps_lat/lon/alt`,
`orientation`, dims via `ExifData`).

```jsonc
{
  "schema": "casava-ai/1",
  "source":  { "filename": "ADH 1248.CR2", "sha256": "…", "bytes": 39416383, "format": "cr2" },
  "image":   { "width": 6000, "height": 4000, "orientation_applied": true },
  "colour":  { "space": "sRGB", "icc_embedded": false },
  "datetime": "2026-05-27T17:53:12",          // ISO 8601; season/phenology prior. null if absent
  "geo": { "lat": -25.85235, "lon": 28.19112, "accuracy_m": null, "elevation_m": 1300.4 },  // standardized; null if no fix
  "proxy": { "spec": "768px/q80/4:2:0", "stored": false },  // generated on demand
  "generator": { "name": "casava-ai", "version": 1 }
}
```

Why each field is here and not just read from EXIF:
- **`geo`** — standardized by `gps.mjs` when a fix exists: signed decimal `lat`/`lon`
  (5 dp ≈ 1.1 m; N/E +, S/W −), `accuracy_m` and `elevation_m` in metres (1 dp, null when
  unknown). Ready for iNat `lat`/`lng` (EXIF stores rational dms + refs). `accuracy_m` stays
  null until a decode path exposes GPSHPositioningError.
- **`datetime`** — the one capture field with ID value (season/phenology); normalized to ISO 8601.
- **`image` dims / `colour`** — *output-side* facts: processed dims (post-orientation, ≠ EXIF
  raw sensor dims) and the **output** colour space sRGB (the RAW is not sRGB). Not in EXIF.
- **`source.sha256` / `bytes` / `format`, `proxy`, `generator`** — provenance + generation
  metadata, not in EXIF.
- **Machine-readability** — the archival JXL currently carries no EXIF, so this JSON is the
  only output-side metadata; ML tools read it without a RAW/JXL EXIF parser.

`geo` and `datetime` are `null` when absent. Fields are additive-only — new keys may be
added; existing keys never repurposed. Full photographic EXIF preservation is tracked
separately (see Out of scope → JXL-embedded metadata).

### 2. Folder manifest — `manifest.json` (schema `casava-ai-manifest/1`)

One per output folder; lets a batch ingest enumerate without re-parsing each sidecar.

```jsonc
{
  "schema": "casava-ai-manifest/1",
  "count": 128,
  "items": [
    { "name": "ADH 1248.CR2", "sidecar": "ADH 1248.ai.json", "sha256": "…",
      "has_geo": true, "width": 6000, "height": 4000 }
  ]
}
```

### 3. On-demand proxy generator (source-priority chain)

`makeAiProxy(sourceRef, opts?) → { jpeg: Uint8Array, width, height, source: string }`

Produces the canonical **768 px · q80 · 4:2:0** JPEG (via `downscale_rgb` + sharp). Picks
the first available source; `source` records which was used (telemetry / tests).

1. **Live lightbox buffer** — the image is already decoded to RGB on screen → downscale →
   encode. Instant, any format. (Interactive path.)
2. **JXL pyramid 1024 level** — if the image was ingested (`pyramid-ingest`). Decode that
   small JXTC level (fast, not a full RAW decode), colour-managed through our pipeline,
   present **regardless of source format** → downscale 1024→768 → encode. *Covers RAWs
   with no embedded preview.*
3. **Embedded RAW preview** — if present and ≥768 px (e.g. Canon CR2 6000×4000 preview).
   Zero decode. Skipped for formats/files lacking a usable preview (e.g. some phone DNGs
   embed only ~1280 px — still usable; sub-768 previews are rejected in favour of 4/5).
4. **Decode the archival JXL master** → downscale → encode. Always works if the master exists.
5. **Full RAW re-decode** (`process_*`) → downscale → encode. Last resort.

First available wins. A standalone single-image convert (no gallery ingest) simply skips
step 2. If every source fails, `makeAiProxy` throws.

Current pyramid ladder (authoritative, `packages/pyramid-ingest/src/quality.ts:30`):
`LEVEL_SIZES = [256, 512, 1024, 2048]` long-edge + full master; grid levels ≤1024 at q85,
≥2048 at q95. The **1024** level is the ID source; 512 is a fallback if 1024 is absent
(small master).

## Where each piece lives

| Piece | Location | Notes |
|---|---|---|
| Sidecar schema builder | new `web/ai-id/ai-sidecar.mjs` (or `packages/…`) | maps decoded result → `casava-ai/1` |
| Manifest builder | new `ai-manifest.mjs` | aggregates sidecars in a folder |
| Proxy generator + chain | new `ai-proxy.mjs` | uses `pkg` decode/`downscale_rgb`, facade JXL-level decode, sharp JPEG |
| Export integration | existing export/batch path | writes `.ai.json` + updates `manifest.json` beside the `.jxl`; **no** proxy write |
| Lightbox hook | existing lightbox | "prepare ID proxy" → `makeAiProxy` on the live buffer |
| Data source | `ExifData` (`crates/raw-pipeline/src/exif.rs`) | already extracted + exposed; unchanged |

`ExifData` stays the single source of truth. No Rust changes required for v1 (JSON is
shaped in JS from already-exposed getters); a future `to_ai_sidecar()` in Rust and a
JXL-embedded-metadata path can adopt the identical `casava-ai/1` field set.

## Data flow

**Export (per image):** RAW → our decode (`ExifData` + RGB) → JXL master *(existing)* +
write `<name>.ai.json` + append to `manifest.json`. No proxy generated or stored.

**Identify (on demand, elsewhere):** caller requests a proxy for an image →
`makeAiProxy` walks the source-priority chain → returns a 768 px q80 4:2:0 JPEG → the
caller (the `ai-id-bakeoff` harness or external code) POSTs it to a service, optionally
passing `geo.lat/lon` from the sidecar.

## Error handling

- No GPS → `geo: null` (never fabricated).
- No pyramid / no preview / no master → fall through the chain; throw only if all sources fail.
- Corrupt source → surfaced by the underlying decoder; sidecar still written for what parsed.
- Sub-768 embedded preview → skipped (use master/RAW) so proxies never upscale.

## Testing

- **Sidecar:** snapshot `casava-ai/1` from a known `ExifData` with GPS present and absent;
  pin the schema version string.
- **Manifest:** build from N sidecars; `has_geo`/dims correct; count matches.
- **Proxy:** each chain source yields a 768 px 4:2:0 JPEG at the right dims; mocked
  availability exercises the fallback order and records the chosen `source`; a butteraugli
  sanity check confirms the proxy resembles the source.
- **Integration:** export writes `<name>.ai.json` next to `<name>.jxl`; batch produces a
  valid `manifest.json`; existing export output byte-unchanged (additive).
- **Formats:** proxy + sidecar verified on CR2, DNG, ORF, and JPG inputs.

## Success criteria

1. Every exported image gets a valid `casava-ai/1` sidecar, with `geo` populated when the
   source has GPS.
2. `makeAiProxy` returns a 768 px q80 4:2:0 JPEG from the first available source for all
   four input formats, and records which source it used.
3. A folder export produces a `manifest.json` indexing every sidecar.
4. No standing per-image proxy is ever written.
5. Existing export behaviour is unchanged (purely additive).

## Out of scope (v1)

- The classifier / any bundled model / service API calls in the core (the `ai-id-bakeoff`
  harness demonstrates sending; it stays as reference + test client).
- Embedding EXIF/XMP **inside** the JXL (reserved: same `casava-ai/1` fields, later, via
  the `bridge.cpp` metadata-box path).
- UI beyond a single "prepare ID proxy" hook.
- Local/offline inference.

## Open questions

- Sidecar location: sibling file (`<name>.ai.json`) vs a `.ai/` subfolder. Default: sibling.
- Do we want a CLI (`node ai-id/export.mjs <folder>`) in v1, or only the library + lightbox
  hook? Default: include a thin CLI for batch metadata + manifest.
