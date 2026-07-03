# Wiring native CASAVA encode + save into the desktop (Tauri) app

The lightbox (`casv-lightbox.js` + `casv-platform.js`) is host-agnostic:

| Capability            | Browser            | Tauri desktop            |
|-----------------------|--------------------|--------------------------|
| Open / decode / play  | ✅ (casv-web + wasm) | ✅                        |
| Export loaded `.casv` | ✅ (download)        | ✅ (native save)          |
| Pick images to encode | ⛔ (native-only)    | ✅ (native dialog)        |
| **Encode `.casv`**    | ⛔ (native-only)    | ✅ (`encode_casv_video`)  |

The browser build degrades gracefully: the "Encode & Save" button is disabled
and the reason is shown. To light up encode in the desktop app, add the two
Tauri commands below and register them.

## Prerequisite (one-time): `casa_video` in the Tauri workspace

The desktop app is a **separate** workspace: `C:\Foo\raw-converter-tauri`. Its
`raw-pipeline` copy currently **does not contain** `casa_video.rs` (the CASAVA
encoder), which lives in `raw-converter-wasm/crates/raw-pipeline`. Do **one** of:

- **A. Point the Tauri workspace at this crate.** In
  `raw-converter-tauri/src-tauri/Cargo.toml`, depend on this repo's crate:
  ```toml
  raw-pipeline = { path = "../../raw-converter-wasm/crates/raw-pipeline",
                   default-features = false, features = ["jxl-codec", "image-formats"] }
  ```
- **B. Sync the file.** Copy `casa_video.rs` (and its `mod casa_video;` line +
  the `jxl-codec`/`image-formats` feature gates) into
  `raw-converter-tauri/raw-pipeline`. Keep the two copies in lockstep.

`casa_video` is `#[cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]`
— native desktop is exactly its target. Confirm with:
`cargo test -p raw-pipeline --features jxl-codec casa_video`.

## The commands (drop into e.g. `src-tauri/src/casv.rs`)

```rust
use std::path::PathBuf;
use raw_pipeline::casa_video::{
    encode_casv_video, CasaVideoOptions, SkipMode, VideoRate, default_thresh_for_distance,
};
use raw_pipeline::image_formats; // for decoding picked images → RGB8
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeCasvRequest {
    pub input_paths: Vec<String>,
    pub rate: String,        // "lossy" | "lossless"
    pub distance: f32,
    pub effort: u8,
    pub gop: u32,
    pub skip: String,        // "none" | "bbox" | "tile"
    pub tile: u32,
    pub thresh: Option<u8>,
    pub fps_num: u32,
    pub fps_den: u32,
    pub output_path: Option<String>,
}

#[tauri::command]
pub fn encode_casv_video(request: EncodeCasvRequest) -> Result<String, String> {
    // 1. Decode every picked image to tightly-packed RGB8, all same dims.
    let mut frames: Vec<Vec<u8>> = Vec::with_capacity(request.input_paths.len());
    let (mut w, mut h) = (0u32, 0u32);
    for p in &request.input_paths {
        // image_formats::decode_rgb8 is illustrative — use whatever RGB8 decode
        // the workspace exposes (the `image` crate works too).
        let img = image_formats::decode_rgb8(std::path::Path::new(p))
            .map_err(|e| format!("{p}: {e}"))?;
        if w == 0 { w = img.width; h = img.height; }
        if img.width != w || img.height != h {
            return Err(format!("{p}: {}x{} != {w}x{h} (all frames must match)", img.width, img.height));
        }
        frames.push(img.rgb8);
    }
    if frames.is_empty() { return Err("no input images".into()); }

    // 2. Build options from the request (mirrors casv-lightbox-core.buildEncodeRequest).
    let rate = if request.rate == "lossless" {
        VideoRate::Lossless
    } else {
        VideoRate::Lossy(request.distance)
    };
    let skip = match request.skip.as_str() {
        "bbox" => SkipMode::Bbox,
        "tile" => SkipMode::Tile,
        _ => SkipMode::None,
    };
    let opts = CasaVideoOptions {
        rate,
        gop_len: request.gop.max(1),
        skip,
        tile: request.tile.max(8),
        effort: request.effort.clamp(1, 10),
        thresh: Some(request.thresh.unwrap_or_else(|| default_thresh_for_distance(request.distance))),
        rate_control: None,
    };

    // 3. Encode.
    let refs: Vec<&[u8]> = frames.iter().map(|f| f.as_slice()).collect();
    let bytes = encode_casv_video(&refs, w, h, request.fps_num.max(1), request.fps_den.max(1), &opts)
        .map_err(|e| format!("encode failed: {e:?}"))?;

    // 4. Write. output_path is chosen by the JS side (Tauri save dialog); if the
    //    app prefers, open the dialog here with the `tauri-plugin-dialog` blocking API.
    let out = request.output_path.ok_or("no output path")?;
    std::fs::write(&out, &bytes).map_err(|e| format!("write {out}: {e}"))?;
    Ok(out)
}

#[tauri::command]
pub fn save_casv_bytes(bytes: Vec<u8>, suggested_name: String) -> Result<String, String> {
    // Minimal variant: write next to the app data dir, or open a native save
    // dialog (tauri-plugin-dialog) and write the chosen path. Returns the path.
    let dir = std::env::temp_dir();
    let path: PathBuf = dir.join(&suggested_name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
```

## Register them

In `src-tauri/src/lib.rs`, add to the existing `tauri::generate_handler![…]`:

```rust
.invoke_handler(tauri::generate_handler![
    /* …existing commands… */
    crate::casv::encode_casv_video,
    crate::casv::save_casv_bytes,
])
```

and `mod casv;` at the crate root.

## Frontend already calls them

`casv-platform.js` invokes:
- `encode_casv_video` with `{ request }` (the object from `buildEncodeRequest`);
- `save_casv_bytes` with `{ bytes, suggestedName }`;
- and prefers the `tauri-plugin-dialog` `open`/`save` if present for native
  file selection. If you use the dialog plugin in JS to obtain the output path
  before invoking `encode_casv_video`, pass it as `request.outputPath`.

Naming note: the JS `camelCase` fields (`inputPaths`, `fpsNum`, `outputPath`)
map to the Rust struct via `#[serde(rename_all = "camelCase")]` above.

## Frontend origin

Point the Tauri app's frontend at this repo's `web/` (or copy the
`web/casv-lightbox/` folder into the app's web root). The lightbox detects the
Tauri global at runtime — no build flag needed.
