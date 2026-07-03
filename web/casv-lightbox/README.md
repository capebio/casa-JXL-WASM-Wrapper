# CASAVA Video Lightbox

A file-picker video lightbox for CASAVA (`.casv`) citizen-science video —
JPEG XL intra frames + JOLT REPLACE bbox/tile P-frames. One UI, two hosts:
**browser** (decode / showcase / export) and **Tauri desktop** (adds native
encode + save-to-disk).

## Files

| File | Role |
|------|------|
| `casv-lightbox.html` | Standalone host page (import map + mounts the lightbox). Open directly or serve `web/`. |
| `casv-lightbox.js` | `CasvLightbox` UI: open, playback (play/pause/step/scrub/speed/loop), per-frame metadata, encode panel, export. |
| `casv-lightbox-core.js` | DOM-free logic (presets, validation, formatting). Unit-tested. |
| `casv-platform.js` | Runtime adapter: browser vs Tauri (decode / pick / encode / save). |
| `casv-lightbox.css` | Styling. |
| `casv-lightbox-core.test.js` | `node --test` unit tests (11). |
| `TAURI_WIRING.md` | How to light up native encode + save in the desktop app. |

## Run (browser)

The page uses ES-module import maps that resolve `@casabio/*` to the built
`packages/*/dist`. Serve the repo `web/` folder over HTTP (module + wasm need a
server, not `file://`), e.g. from the repo root:

```bash
npx http-server . -p 8080    # or: python -m http.server 8080
# open http://localhost:8080/web/casv-lightbox/casv-lightbox.html
```

Then **Open .casv…** and pick a file (e.g. the fixtures in
`packages/casv-web/test/fixtures/*.casv`). Or auto-load one for a demo:
`casv-lightbox.html?src=../../packages/casv-web/test/fixtures/intra.casv`.

Prerequisite: the `@casabio/jxl-wasm` and `@casabio/casv-web` packages must be
built (`dist/` present). They are, on this branch.

## What works where

- **Browser**: open, decode (intra + JOLT REPLACE bbox/tile), play, inspect,
  **export** the loaded `.casv` (download). Encoding is disabled (native codec).
  FableBraid (lossless) `.casv` shows metadata only — its braided-rANS codec is
  native-only, so `playCasv` throws and the lightbox surfaces a clear message.
- **Tauri desktop**: all of the above, plus **pick images → encode `.casv`**
  (presets Realtime / Balanced / Quality / Lossless-archive, with
  distance / effort / GOP / skip / tile / threshold / fps controls) and native
  save-to-disk. See `TAURI_WIRING.md`.

## Keyboard

`Space` play/pause · `←`/`→` step · `Home`/`End` first/last (focus the lightbox).

## Tests

```bash
node --test web/casv-lightbox/          # core logic (11)
cd packages/casv-web && bun test        # decode path (8, real wasm)
```
