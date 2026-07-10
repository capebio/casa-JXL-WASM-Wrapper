# web/ai-id — AI identification foundation

Facilitates external plant/animal ID (no classifier). Emits a lean `casava-ai/1` metadata
sidecar per image + a folder `manifest.json`, and generates a 768px q80 4:2:0 JPEG proxy
**on demand** — never stored. See `docs/superpowers/specs/2026-07-10-ai-id-foundation-design.md`.

## Batch metadata

    node web/ai-id/export.mjs <folder> [outDir]

Writes `<name>.ai.json` (source, output dims, sRGB colour, ISO datetime, decimal geo) beside
each RAW, plus `manifest.json`. Photographic EXIF stays in the master RAW (not duplicated here).

## On-demand proxy

`resolveProxy(sources, opts)` walks a source-priority chain and encodes the first available:
live buffer → pyramid 1024 level → embedded preview (≥768) → master decode → RAW re-decode.
Node callers inject `nodeEncodeJpeg` + `raw.downscale_rgba`; browser callers inject a canvas
encoder and OPFS/pyramid byte getters. See `sources.mjs` for the constructors.

## Empirical basis

Proxy parameters (768px / q80 / 4:2:0 / direct downscale) were chosen from the bake-offs in
`ai-id-bakeoff/` (iNaturalist + Gemini across resolution, quality, and chroma sweeps).

## Tests

    node --test web/ai-id/*.test.mjs

(This Node treats a bare directory arg as a module to run, so pass the glob. In PowerShell:
`node --test (Get-ChildItem web/ai-id/*.test.mjs)`.)
