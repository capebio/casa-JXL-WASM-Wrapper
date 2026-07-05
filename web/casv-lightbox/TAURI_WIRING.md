# Native CASAVA encode + save in the desktop (Tauri) app — AS BUILT

Status: **wired and compiling** (2026-07-03). This documents what was actually
built, and why.

| Capability            | Browser            | Tauri desktop            |
|-----------------------|--------------------|--------------------------|
| Open / decode / play  | ✅ (casv-web + wasm) | ✅                        |
| Export loaded `.casv` | ✅ (download)        | ✅ (`save_casv_bytes`)    |
| Pick images to encode | ⛔ (native-only)    | ✅ (`casv_pick_images`)   |
| **Encode `.casv`**    | ⛔ (native-only)    | ✅ (`encode_casv_video`)  |

## Why a sidecar (not an in-process call)

The desktop app (`C:\Foo\raw-converter-tauri`) and the codec repo
(`C:\Foo\raw-converter-wasm`) **both contain a crate literally named
`raw-pipeline`**, and they have massively diverged — the desktop copy is a lean
RAW decoder (no `casa_video`, no `jxl-ffi`, a different JXL stack: jxl-oxide +
jxl-lowlevel). Two path crates with the same package name cannot coexist in one
cargo graph, so the CASAVA encoder cannot be linked into the app directly.

Solution: a **native sidecar binary** built from the codec repo, spawned by the
app. No crate merge, no clash, and it reuses the proven `encode_casv_video`.

## Part 1 — the sidecar (codec repo)

`crates/raw-pipeline/src/bin/casv_encode.rs` + a `[[bin]]` entry
(`required-features = ["jxl-codec"]`). Build it native (MSVC):

```powershell
cd C:\Foo\raw-converter-wasm\crates\raw-pipeline
..\..\build-msvc.ps1 build --release --features jxl-codec --bin casv_encode
# → C:\Tmp\raw-converter-wasm-msvc-target\release\casv_encode.exe
```

CLI: `casv_encode <out.casv> <fps_num> <fps_den> <rate> <distance> <effort>
<gop> <skip> <tile> <thresh|auto> <img...>` — decodes each image (PNG/JPEG/
TIFF/WEBP/EXR via the `image` crate) to RGB8 and calls
`casa_video::encode_casv_video`. Prints `OK <bytes> <out>`.

Verified end-to-end: encoded 8 seahorse frames (1280×720, JOLT tile) → parsed
and decoded by `@casabio/casv-web` through the same wasm path the lightbox uses
(8/8 frames, real pixels).

## Part 2 — the app commands (`src-tauri/src/casv.rs`, registered in `lib.rs`)

Three Tauri commands (compiled — `cargo check` clean under MSVC):

- `casv_pick_images(app) -> Vec<String>` — native image open dialog.
- `encode_casv_video(app, request) -> String` — spawns the sidecar; if
  `request.outputPath` is absent, opens a native save dialog; returns the path.
  **Seed the save dialog's default filename with `request.outputName`** (JS sets
  it via `suggestEncodeName`: the full source name + `.casv`, e.g.
  `holiday.mp4` → `holiday.mp4.casv`). Rust: `dialog.set_file_name(&request.output_name)`
  (field is `outputName` over the wire; `#[serde(rename_all = "camelCase")]`).
  Fall back to `output.casv` only if `output_name` is empty.
- `save_casv_bytes(app, bytes, suggestedName) -> String` — native save of the
  currently-loaded `.casv` bytes.

Sidecar resolution: `CASV_ENCODE_BIN` env → dev path
`…\raw-converter-wasm-msvc-target\release\casv_encode.exe` → `casv_encode` on
PATH. **For production, bundle `casv_encode` as a Tauri sidecar** and set
`CASV_ENCODE_BIN`.

## Part 3 — frontend (already wired)

`casv-platform.js` invokes `encode_casv_video` with `{ request }` (the object
from `buildEncodeRequest`), `save_casv_bytes` with `{ bytes, suggestedName }`,
and prefers the `tauri-plugin-dialog` `open` else falls back to
`casv_pick_images`. JS `camelCase` fields map to the Rust struct via
`#[serde(rename_all = "camelCase")]`.

## Encode progress (x / y)

The sidecar prints progress to **stderr** as it runs, one line per event:

```
CASVENC <stage> <done> <total>
```

- `stage` ∈ `extract | decode | encode`
- `total == 0` → indeterminate (e.g. the ffmpeg extract is one opaque call)
- `stdout` still carries only the final `OK <bytes> <out>` result line

**Cross-repo glue (app repo — one change):** `encode_casv_video` currently
captures the sidecar with `.output()` (buffers to completion). To relay
progress, spawn with piped stderr and read it line-by-line, re-emitting each
`CASVENC` line as a `casv-encode-progress` event:

```rust
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

let mut child = Command::new(bin)
    .args(&sidecar_args)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()?;

let stderr = child.stderr.take().unwrap();
let app2 = app.clone();
std::thread::spawn(move || {
    for line in BufReader::new(stderr).lines().flatten() {
        if let Some(rest) = line.strip_prefix("CASVENC ") {
            let f: Vec<&str> = rest.split_whitespace().collect();
            if f.len() == 3 {
                let _ = app2.emit("casv-encode-progress", serde_json::json!({
                    "stage": f[0],
                    "done":  f[1].parse::<u64>().unwrap_or(0),
                    "total": f[2].parse::<u64>().unwrap_or(0),
                }));
            }
        }
    }
});

let status = child.wait()?;              // read stdout for the OK line as before
```

The frontend already listens: `casv-platform.js` `onEncodeProgress()` subscribes
to `casv-encode-progress`, and the lightbox renders a determinate bar for the
`decode` phase (real `x / y`) and an indeterminate bar for `extract` / `encode`.
No frontend change is needed once the app emits the event.

## Remaining for a shipped desktop build

1. Point the app's frontend at `web/` (or copy `web/casv-lightbox/` into the web
   root). The lightbox detects the Tauri global at runtime — no build flag.
2. Bundle `casv_encode.exe` as a Tauri sidecar (or ship `CASV_ENCODE_BIN`) so it
   is present without the dev build path.
3. Keep the sidecar in lockstep with `casa_video` (rebuild on codec changes).
