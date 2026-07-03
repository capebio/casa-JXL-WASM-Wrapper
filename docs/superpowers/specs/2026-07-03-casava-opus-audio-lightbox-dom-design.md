# CASAVA Opus Audio (CSAU) + Lightbox DOM Render — Design

**Date:** 2026-07-03  
**Status:** Approved — ready for implementation  
**Branch base:** `feat/casv-lightbox-jul03` (worktree `C:\Foo\rcw-casv-lightbox`)  

---

## 1. Goal, Constraints, Success Criteria

**Goal:** Wire Opus audio end-to-end into the CASAVA format and lightbox.
Source video → FFmpeg extract (frames + audio) → Ogg/Opus muxed into `.casv` via a new
`CSAU` box → browser decodes natively via WebAudio → A/V sync in the lightbox.
Also: verify live browser DOM render of the lightbox.

**Constraints:**
- No existing `.casv` reader must break (backward-compatible format extension).
- No new WASM needed for audio decode (browser ships native Ogg/Opus).
- Audio is footer-format only — `--video` mode always produces streaming (footer-format) output.
- FFmpeg must be on PATH (this machine has it; treat as hard dependency for the encode path).
- `casv-web` stays zero-dependency (no audio crate; expose raw bytes only).
- A/V sync accuracy: within ±1 video frame (coarse, for citizen-science video).

**Success criteria:**
1. `casv_encode --video seahorse.mp4 out.casv …` → `.casv` file contains CSAU box.
2. `bun test packages/casv-web` → `reader.audio` returns correct Ogg/Opus bytes.
3. Browser lightbox: load `out.casv`, play → audio plays in sync with video frames.
4. Load an old no-audio `.casv` → plays silently, no error.
5. Browser DOM render: lightbox renders correctly (canvas, controls, metadata) with a real `.casv`.

---

## 2. Format Extension: CSAU Box

### Magic

```rust
pub const CASV_AUDIO_BOX_MAGIC: u32 = 0x5541_5343; // 'CSAU' on disk (LE)
```

JS mirror: `export const CASV_AUDIO_BOX_MAGIC = 0x5541_5343;`

### Box layout (8-byte header + payload)

```
[u32 LE magic 0x5541_5343][u32 LE len][u8 × len: Ogg/Opus stream]
```

`len` is the byte count of the Ogg/Opus payload that immediately follows.

### Position in footer-format files

```
[video payloads …] [frame index: N×8 B] [CASR 8 B?] [CSAU 8+N B?] [CASV footer 32 B]
```

- Both CASR and CSAU are optional trailing boxes between the index and footer.
- CSAU always follows CASR when both are present.
- Reader finds end-of-index at `indexOffset + frameCount * 8`, then scans boxes in order until it
  hits a non-matching magic or the footer.

### Header-format files

No CSAU support. The `--video` encode path always produces footer-format; static image-sequence
paths remain header-format (no change).

---

## 3. Rust Layer — `casa_video.rs`

### New public constants

```rust
pub const CASV_AUDIO_BOX_MAGIC: u32 = 0x5541_5343;
pub const CASV_AUDIO_BOX_HDR: usize = 8; // magic + len
```

### Writer

```rust
/// Append a CSAU box to a buffer. Called by the streaming encoder after the CASR box.
pub fn write_csau_box(out: &mut Vec<u8>, ogg_opus: &[u8]) {
    out.extend_from_slice(&CASV_AUDIO_BOX_MAGIC.to_le_bytes());
    out.extend_from_slice(&(ogg_opus.len() as u32).to_le_bytes());
    out.extend_from_slice(ogg_opus);
}
```

### Reader

```rust
/// Slice the Ogg/Opus payload from a footer-format .casv, if a CSAU box is present.
pub fn parse_casv_audio_box(data: &[u8]) -> Option<&[u8]> {
    let footer = parse_casv_footer(data)?;
    let idx_end = footer.index_offset as usize + footer.frame_count as usize * CASV_INDEX_ENTRY_BYTES;
    // skip optional CASR
    let mut pos = idx_end;
    if pos + 8 <= data.len().saturating_sub(CASV_FOOTER_BYTES) {
        let magic = u32::from_le_bytes(data[pos..pos+4].try_into().ok()?);
        if magic == CASV_RATE_BOX_MAGIC { pos += 8; }
    }
    if pos + CASV_AUDIO_BOX_HDR > data.len().saturating_sub(CASV_FOOTER_BYTES) {
        return None;
    }
    let magic = u32::from_le_bytes(data[pos..pos+4].try_into().ok()?);
    if magic != CASV_AUDIO_BOX_MAGIC { return None; }
    let len = u32::from_le_bytes(data[pos+4..pos+8].try_into().ok()?) as usize;
    let start = pos + CASV_AUDIO_BOX_HDR;
    if start + len > data.len().saturating_sub(CASV_FOOTER_BYTES) { return None; }
    Some(&data[start..start+len])
}
```

### Streaming encoder integration

`encode_casv_video_streaming` (or the new video-mode encode function) writes the CSAU box
between CASR and footer when an Ogg/Opus buffer is provided:

```rust
pub fn append_csau(out: &mut Vec<u8>, footer_start: usize, ogg_opus: &[u8]) {
    // Insert before the footer bytes already written at the end.
    let footer_bytes = out.split_off(footer_start);
    write_csau_box(out, ogg_opus);
    out.extend_from_slice(&footer_bytes);
}
```

---

## 4. Encoder Sidecar — `casv_encode.rs`

### New invocation mode

```
casv_encode --video <in.mp4> <out.casv> <fps_num> <fps_den> <rate> <distance> <effort> \
            <gop> <skip> <tile> <thresh|auto>
```

Detection: `args[0] == "--video"`.

### Frame extraction

```rust
// PNG frame stream via pipe
let mut child = Command::new("ffmpeg")
    .args(["-i", &video_path, "-f", "image2pipe", "-vcodec", "png", "pipe:1"])
    .stdout(Stdio::piped()).stderr(Stdio::null())
    .spawn()?;
// Read stdout, split on PNG magic \x89PNG, decode each frame with the `image` crate.
```

PNG frames split by magic `\x89PNG\r\n\x1A\n` (8 bytes). Each chunk fed to `image::load_from_memory`.

### Audio extraction

```rust
let audio_tmp = std::env::temp_dir().join("casv_audio_tmp.ogg");
let status = Command::new("ffmpeg")
    .args(["-i", &video_path, "-vn", "-acodec", "libopus", "-f", "ogg",
           "-ar", "48000", "-ac", "2", "-y", audio_tmp.to_str().unwrap()])
    .status()?;
// If ffmpeg exits non-zero (e.g. no audio track), proceed without audio (no CSAU box).
let ogg_bytes = if status.success() { fs::read(&audio_tmp).ok() } else { None };
let _ = fs::remove_file(&audio_tmp);
```

### Assembly

Add a new `encode_casv_video_with_audio(frames, w, h, fps_num, fps_den, opts, ogg_opus: Option<&[u8]>) -> Result<Vec<u8>, VideoError>` to `casa_video.rs`. It:
1. Encodes all frames (same logic as `encode_casv_video`) into a footer-format body.
2. Writes CASR box (rate flags).
3. If `ogg_opus.is_some()`, writes CSAU box.
4. Writes CASV footer.

Footer format is chosen unconditionally for this path — the streaming encoder (`encode_casv_video_streaming`) is not used here (it requires a `VideoFrameSource` trait object; buffering all frames first is simpler for the sidecar).

If the source video has no audio stream (ffmpeg audio extraction exits non-zero or produces a
0-byte file), the .casv is produced silently without a CSAU box — not an error. Print a warning
to stderr: `casv_encode: no audio track found, producing silent .casv`.

### FPS detection

If `fps_num == 0`: probe with `ffprobe -v quiet -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 <in>` and parse `num/den`. Caller (Tauri) may still pass explicit fps to override.

---

## 5. `casv-web` Parser Update (`packages/casv-web/src/index.ts`)

### New exports

```typescript
export const CASV_AUDIO_BOX_MAGIC = 0x5541_5343;

export interface CasvAudio {
  /** Ogg/Opus stream, ready for AudioContext.decodeAudioData(). */
  bytes: Uint8Array;
}
```

### `CasvReader` extension

```typescript
class CasvReader {
  readonly audio: CasvAudio | null;

  private constructor(header, rate, entries, audio: CasvAudio | null) { … }
}
```

### Box scan (footer-format only)

After `readIndex()` in the footer branch of `CasvReader.parse()`:

```typescript
private static readBoxesAfterIndex(
  dv: DataView, bytes: Uint8Array, idxEnd: number, fileLen: number
): CasvAudio | null {
  const footerStart = fileLen - CASV_FOOTER_BYTES;
  let pos = idxEnd;
  // skip optional CASR
  if (pos + 8 <= footerStart && u32(dv, pos) === CASV_RATE_BOX_MAGIC) pos += 8;
  // check for CSAU
  if (pos + 8 > footerStart) return null;
  if (u32(dv, pos) !== CASV_AUDIO_BOX_MAGIC) return null;
  const len = u32(dv, pos + 4);
  const start = pos + 8;
  if (start + len > footerStart) return null;
  return { bytes: bytes.slice(start, start + len) };
}
```

Header-format `CasvReader` branch sets `audio = null` (no CSAU in header files).

### `parseCasvAudioBox` (standalone helper)

```typescript
export function parseCasvAudioBox(bytes: Uint8Array): Uint8Array | null {
  const reader = CasvReader.parse(bytes); // may throw
  return reader.audio?.bytes ?? null;
}
```

---

## 6. Lightbox A/V Sync (`casv-lightbox.js`)

### State additions

```js
this.audioCtx = null;       // AudioContext (created on first load)
this.audioBuf = null;       // AudioBuffer from decodeAudioData
this.audioSrc = null;       // current AudioBufferSourceNode (null when paused)
this.gainNode = null;       // GainNode for volume
```

### `loadBytes` addition

```js
if (this.reader.audio) {
  if (!this.audioCtx) this.audioCtx = new AudioContext();
  this.gainNode = this.audioCtx.createGain();
  this.gainNode.connect(this.audioCtx.destination);
  this.audioBuf = await this.audioCtx.decodeAudioData(
    this.reader.audio.bytes.buffer.slice(
      this.reader.audio.bytes.byteOffset,
      this.reader.audio.bytes.byteOffset + this.reader.audio.bytes.byteLength
    )
  );
} else {
  this.audioBuf = null;
}
```

### `_play()` addition

```js
if (this.audioBuf && this.audioCtx) {
  this.audioSrc = this.audioCtx.createBufferSource();
  this.audioSrc.buffer = this.audioBuf;
  this.audioSrc.connect(this.gainNode);
  const offset = this.index / (fpsOf(this.header) || 24);
  this.audioSrc.start(0, Math.max(0, offset));
}
```

### `_pause()` addition

```js
if (this.audioSrc) { try { this.audioSrc.stop(); } catch (_) {} this.audioSrc = null; }
```

### `_seek(i)` addition

```js
// stop current audio source; if playing, _play() will restart from new position
if (this.audioSrc) { try { this.audioSrc.stop(); } catch (_) {} this.audioSrc = null; }
```

### Volume control

New `<input type="range" min="0" max="1" step="0.05" value="1">` in transport bar.
Wired to `this.gainNode.gain.value`.

---

## 7. Platform Adapter (`casv-platform.js`)

### New: `pickVideoToEncode()`

```js
export async function pickVideoToEncode() {
  if (!isTauri()) return { native: false, path: null };
  const dialog = window.__TAURI__?.dialog;
  let path = null;
  if (dialog?.open) {
    path = await dialog.open({
      multiple: false,
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v'] }],
    });
  } else {
    path = await tauriInvoke('casv_pick_video', {});
  }
  return { native: true, path: typeof path === 'string' ? path : null };
}
```

### `encodeAndSave` update

Request object gains optional `videoPath: string | null`. When set, Tauri command routes to
`--video` sidecar mode. `buildEncodeRequest` in `casv-lightbox-core.js` passes `videoPath`
through untouched (already handled by the Tauri command).

---

## 8. Lightbox UI (`casv-lightbox.js`)

### Encode panel: video mode toggle

Add "Source: Images / Video" toggle (radio or select) to encode panel.
- Images mode: current "Pick images…" flow (unchanged).
- Video mode: shows "Pick video…" button (calls `pickVideoToEncode()`), hides multi-image picker.
  Video path stored in `this.encodeVideoPath`.

Volume slider added to transport bar (hidden when `audioBuf == null`).

---

## 9. Tauri Wiring (`src-tauri/src/casv.rs`)

`encode_casv_video` Tauri command updated to accept `videoPath: Option<String>` in the
`EncodeRequest` struct. When set, invokes sidecar as:
```
casv_encode --video <videoPath> <out> <fps_num> <fps_den> <rate> <distance> …
```
Instead of the image-list form.

Optional: `casv_pick_video` command (fallback for older Tauri builds without `dialog.open`).

---

## 10. DOM Render Verification

### Dev server

Create `web/casv-lightbox/serve-dev.mjs`:

```js
import { serve } from 'bun';
import { join } from 'path';
// Serves casv-lightbox/ files + maps @casabio/casv-web → packages/casv-web/src/index.ts (compiled)
// and @casabio/jxl-wasm → web/pkg/
```

Or use a simple `bun --hot` serve with an importmap rewrite middleware.

### Launch script

```powershell
# From worktree root:
bun web/casv-lightbox/serve-dev.mjs &
Start-Process "chrome" "--new-window http://localhost:3210/casv-lightbox.html"
```

### Test checklist

- [ ] Page loads without console errors
- [ ] "Open .casv…" file picker works
- [ ] Frames decode and display on canvas
- [ ] Play / pause / step / scrub controls work
- [ ] Timecode and frame counter update
- [ ] Frame kind badge (I / P·tile·replace) shows correctly
- [ ] Metadata panel populates (dims, fps, rate)
- [ ] Export .casv (download) works
- [ ] Encode panel toggle shows/hides
- [ ] (If audio .casv loaded) audio plays in sync; volume slider functional
- [ ] No-audio .casv: silent, no error

---

## 11. Testing Plan

| Test | How |
|---|---|
| `casv_encode --video` produces CSAU | `parse_casv_audio_box(&casv).is_some()` in Rust test |
| No-audio video → no CSAU | `status.success() == false` path |
| `casv-web` audio detection | `bun test packages/casv-web` — new test `csau_roundtrip` |
| Browser A/V sync | Manual: open audio `.casv`, play, verify audio matches visual |
| Backward compat | Existing `casv-web` tests still pass (11/11) |
| DOM render | Checklist above |

---

## 12. Out of Scope

- Multiple audio tracks
- Sub-frame A/V sync accuracy (WebAudio offset is approximate)
- CSAU in header-format (batch) files
- Audio scrubbing while paused (only position-set on resume)
- Lossless audio (Opus only)
- Audio in the Fable / lossless-residual tiers
