# yt-dlp Testbed + CSAU Audio — Design

**Date:** 2026-07-03  
**Status:** Approved — ready for implementation  
**Branch base:** `feat/casv-lightbox-jul03` (worktree `C:\Foo\rcw-casv-lightbox`)  
**Depends on:** `2026-07-03-casava-opus-audio-lightbox-dom-design.md` (CSAU box format, casv-web parser, lightbox A/V sync — all in scope here)

---

## 1. Goal, Constraints, Success Criteria

**Goal:** Build a sweep harness that downloads a YouTube video via yt-dlp, encodes it in CASAVA format at every combination of quality × effort × dimension, and produces an HTML comparison report. Audio (Ogg/Opus via CSAU box) is included in every encode.

**Constraints:**
- `yt-dlp`, `ffmpeg`, and `casv_encode` must be on PATH.
- No browser or WASM required to run the testbed — pure CLI.
- HTML report must be self-contained (no external server needed to view it).
- Testbed is a developer tool, not user-facing — rough edges OK, no installer.
- CSAU implementation is part of this spec (not a prior dependency).
- Backward compat: existing `.casv` files without CSAU still play silently.

**Success criteria:**
1. `bun tools/yt-testbed.mjs <url>` → downloads, encodes 27 `.casv` files, writes `report.html`.
2. Each `.casv` contains a CSAU box (verified by `casv-web` unit test).
3. `report.html` opens in browser, shows frame grabs + file sizes + encode times in a grid.
4. Existing `casv-web` tests still pass (backward compat).
5. `casv_encode --video` with no audio track produces silent `.casv` (no crash).

---

## 2. Sweep Definition

**Axes:**

| Axis | Values |
|---|---|
| Distance | `d=2` (Realtime), `d=1` (Balanced), `d=0.5` (Quality) |
| Effort | `e=1`, `e=3`, `e=4` |
| Dimension (long-side) | `256`, `512`, `1080` |

**Total cells:** 3 × 3 × 3 = **27 `.casv` files per video**.

**Cell naming:** `<id>_d<distance>_e<effort>_dim<dim>.casv`  
Example: `abc123_d2_e1_dim256.casv`

**Default GOP:** 8 (same as `jolt_bench` benchmarks). Configurable via `--gop`.

---

## 3. CLI

```
bun tools/yt-testbed.mjs <youtube-url> [options]

Options:
  --out <dir>     Output directory (default: ./testbed-out)
  --gop <n>       GOP size (default: 8)
  --keep-src      Keep downloaded source.mp4 after encode (default: delete)
```

Dimension and quality/effort axes are not exposed as CLI flags — run the full sweep always. This keeps the report grid consistent across runs.

---

## 4. `casv_encode --video` Extension: Dimension Scaling

### Updated signature

```
casv_encode --video <in.mp4> <out.casv> <fps_num> <fps_den> <rate> <distance> <effort>
            <gop> <skip> <tile> <thresh> <dim>
```

`<dim>` is a new **final positional argument**:
- `0` — audio only: extract one keyframe at `duration/3`, store as single-frame CASV, include CSAU audio.
- `exact` — no scaling, use source resolution.
- `N` (integer) — scale so long side = N, preserve aspect ratio. Short side rounded to nearest even.

### FFmpeg scale filter

```
-vf scale='if(gt(iw,ih),N,trunc(oh*a/2)*2):if(gt(iw,ih),trunc(ow/a/2)*2,N)'
```

Applied to the `-f image2pipe` frame extraction command.

### Backward compat

Existing image-sequence form (`casv_encode <out> <fps_num> <fps_den> ...`) unchanged — detected by `args[0] != "--video"`.

---

## 5. Pipeline (tools/yt-testbed.mjs)

All output files live in `$out/<video-id>/`.

```
1. Parse args; workDir = $out/<video-id>/; mkdir -p workDir
2. yt-dlp <url> -o source.%(ext)s -P workDir → workDir/source.mp4
3. ffprobe: get fps (r_frame_rate), duration, width, height
4. For each (dim, d, e) in sweep:
   a. stem    = <id>_d<d>_e<e>_dim<dim>
   b. outFile = workDir/<stem>.casv
   c. t0 = Date.now()
   d. spawn: casv_encode --video workDir/source.mp4 outFile 0 1 auto <d> <e> <gop> 0 0 auto <dim>
   e. encMs = Date.now() - t0
   f. fileBytes = statSync(outFile).size
   g. record {dim, d, e, stem, encMs, fileBytes}
5. For each cell: ffmpeg extract frame PNG at t=duration/3 from source (scaled to dim)
   → workDir/<stem>.png
6. Generate workDir/report.html (image src = "./<stem>.png")
7. If !--keep-src: delete workDir/source.mp4
```

**Parallelism:** Run all 27 encodes sequentially (simpler, avoids CPU contention, preserves accurate encode times). Print progress: `[3/27] dim=512 d=1 e=3 ...`.

**Error handling:** If a cell fails, mark as `ERROR` in HTML, continue sweep.

---

## 6. CSAU Implementation (extends CSAU spec)

This spec adopts the CSAU box format, writer, reader, and casv-web parser from `2026-07-03-casava-opus-audio-lightbox-dom-design.md` verbatim. Key points:

- `CASV_AUDIO_BOX_MAGIC = 0x5541_5343` (`CSAU` LE)
- Box layout: `[u32 magic][u32 len][u8 × len: Ogg/Opus]`
- Position: after CASR, before CASV footer
- If ffmpeg audio extraction fails (no audio track), CSAU box omitted — not an error

**casv_encode audio extraction:**
```rust
let audio_tmp = std::env::temp_dir().join("casv_audio_tmp.ogg");
let status = Command::new("ffmpeg")
    .args(["-i", &video_path, "-vn", "-acodec", "libopus", "-f", "ogg",
           "-ar", "48000", "-ac", "2", "-y", audio_tmp.to_str().unwrap()])
    .status()?;
let ogg_bytes = if status.success() { fs::read(&audio_tmp).ok() } else {
    eprintln!("casv_encode: no audio track, producing silent .casv");
    None
};
let _ = fs::remove_file(&audio_tmp);
```

---

## 7. HTML Report Format

Self-contained: all frame grabs embedded as base64 `<img src="data:image/png;base64,...">` OR referenced as relative paths (relative paths preferred — smaller HTML, easier to inspect files).

### Structure

```html
<h1>CASAVA Testbed — <video-id></h1>
<p>Source: <url> | <W>×<H> | <fps> fps | <duration>s</p>

<table>
  <thead>
    <tr>
      <th>dim</th>
      <!-- one <th> per (d, e) combo, 9 columns -->
      <th>d=2 e=1</th> <th>d=2 e=3</th> ...
    </tr>
  </thead>
  <tbody>
    <!-- one <tr> per dimension -->
    <tr>
      <td>256</td>
      <!-- one <td> per cell -->
      <td>
        <img src="./abc123_d2_e1_dim256.png" width="128">
        <br>42.3 KB | 1.2s enc
        <br>🔊 audio
      </td>
      ...
    </tr>
  </tbody>
</table>
```

`🔊 audio` / `🔇 no audio` per cell based on whether CSAU box present.

### Styling

Inline `<style>` block. Dark background, monospace stats, 1px border cells. No external CSS.

---

## 8. casv-web Parser Update

See `2026-07-03-casava-opus-audio-lightbox-dom-design.md` §5 for full implementation. New field:

```typescript
class CasvReader {
  readonly audio: CasvAudio | null;   // non-null when CSAU box present
}
export interface CasvAudio { bytes: Uint8Array; }
export const CASV_AUDIO_BOX_MAGIC = 0x5541_5343;
```

---

## 9. Lightbox A/V Sync

See `2026-07-03-casava-opus-audio-lightbox-dom-design.md` §6 for full implementation. Audio playback via `AudioContext.decodeAudioData()` — no new WASM. Volume slider added to transport bar.

---

## 10. Testing Plan

| Test | How |
|---|---|
| CSAU roundtrip | `packages/casv-web/test/*.test.ts` — write CSAU box, parse back, compare bytes |
| casv_encode --video (with audio) | Rust integration test: encode test MP4, `parse_casv_audio_box().is_some()` |
| casv_encode --video (no audio) | Encode silent video, verify no crash, no CSAU box |
| casv_encode --video --dim 256 | Verify output frame resolution is ≤256 long-side |
| HTML report structure | bun test: parse report.html, verify 27 cells all present |
| Backward compat | Existing casv-web 8/8 tests still pass |
| Testbed end-to-end | Manual: run against a short public YT video, open report.html |

---

## 11. File Map

| File | Change |
|---|---|
| `crates/raw-pipeline/src/casa_video.rs` | Add `CASV_AUDIO_BOX_MAGIC`, `write_csau_box()`, `parse_casv_audio_box()`, `encode_casv_video_with_audio()` |
| `crates/raw-pipeline/src/bin/casv_encode.rs` | Add `--video` dispatch, dim arg, FFmpeg frame+audio extraction |
| `packages/casv-web/src/index.ts` | Add `CasvAudio`, `CASV_AUDIO_BOX_MAGIC`, `readBoxesAfterIndex()`, `CasvReader.audio` |
| `packages/casv-web/test/csau.test.ts` | New: CSAU roundtrip + backward-compat tests |
| `web/casv-lightbox/casv-lightbox.js` | Add `audioCtx`, `audioBuf`, `gainNode`, `_play`/`_pause`/`_seek` audio hooks, volume slider |
| `tools/yt-testbed.mjs` | New: sweep harness + HTML report generator |

---

## 12. Out of Scope

- Multiple audio tracks
- Audio scrubbing while paused
- CSAU in header-format (image-sequence batch) files
- Lossless audio
- Parallel encode cells (sequential intentional for timing accuracy)
- yt-dlp playlist support (single URL only)
- Report comparison across multiple videos
- GPS per-frame coordinates (separate spec)
- Tauri video picker (separate from testbed; lightbox UI update is out of scope here)
